import { spyOn, test } from 'bun:test';
import { strict as assert } from 'node:assert';
import { loadConfig } from '@/config.ts';
import { SlackClient } from '@/slack/client.ts';

function client() {
  return new SlackClient(
    loadConfig({ SLACK_BOT_TOKEN: 'xoxb-test', SLACK_USER_TOKEN: 'xoxp-test' }),
  );
}

test('file download accepts a streamed file exactly at the caller limit', async () => {
  const fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3, 4]));
          controller.close();
        },
      }),
      { headers: { 'content-type': 'image/png' } },
    ),
  );
  try {
    const result = await client().fetchFileBytes(
      'bot-preferred',
      'https://files.slack.com/test',
      4,
    );
    assert.deepEqual(result.bytes, new Uint8Array([1, 2, 3, 4]));
    assert.equal(result.contentType, 'image/png');
  } finally {
    fetchMock.mockRestore();
  }
});

test('file download rejects Content-Length above the default 5 MiB without reading the body', async () => {
  let cancelled = false;
  const fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      new ReadableStream<Uint8Array>(
        {
          pull() {
            assert.fail('oversized response must not be read');
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { 'content-length': String(5 * 1024 * 1024 + 1) } },
    ),
  );
  try {
    await assert.rejects(
      client().fetchFileBytes('bot-preferred', 'https://files.slack.com/test'),
      /max_bytes.*5242880/,
    );
    assert(cancelled);
    assert.equal(fetchMock.mock.calls.length, 1);
  } finally {
    fetchMock.mockRestore();
  }
});

for (const contentLength of [undefined, '1']) {
  test(`file download cancels an oversized stream with Content-Length ${contentLength ?? 'absent'}`, async () => {
    let reads = 0;
    let cancelled = false;
    const fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              reads++;
              controller.enqueue(new Uint8Array([1, 2, 3]));
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: contentLength === undefined ? {} : { 'content-length': contentLength } },
      ),
    );
    try {
      await assert.rejects(
        client().fetchFileBytes('bot-preferred', 'https://files.slack.com/test', 4),
        /max_bytes.*4 bytes/,
      );
      assert.equal(reads, 2);
      assert(cancelled);
      assert.equal(fetchMock.mock.calls.length, 1);
    } finally {
      fetchMock.mockRestore();
    }
  });
}

test('file download falls back only on an identity refusal and cancels the refused body', async () => {
  let cancelled = false;
  const seen: (string | null)[] = [];
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        seen.push(new Headers(init?.headers).get('authorization'));
        if (seen.length === 1) {
          return Promise.resolve(
            new Response(
              new ReadableStream({
                cancel() {
                  cancelled = true;
                },
              }),
              { status: 403 },
            ),
          );
        }
        return Promise.resolve(new Response(new Uint8Array([7])));
      },
      { preconnect: fetch.preconnect },
    ),
  );
  try {
    const result = await client().fetchFileBytes('bot-preferred', 'https://files.slack.com/test');
    assert.deepEqual(result.bytes, new Uint8Array([7]));
    assert.deepEqual(seen, ['Bearer xoxb-test', 'Bearer xoxp-test']);
    assert(cancelled);
  } finally {
    fetchMock.mockRestore();
  }
});

test('file download hides transport error credentials and does not try the other identity', async () => {
  const fetchMock = spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('https://private-url/secret?token=xoxb-test Authorization: Bearer xoxp-test'),
  );
  try {
    await assert.rejects(client().fetchFileBytes('bot-preferred', 'https://files.slack.com/test'), {
      message: 'Failed to download file.',
    });
    assert.equal(fetchMock.mock.calls.length, 1);
  } finally {
    fetchMock.mockRestore();
  }
});

test('file download timeout covers stalled response bodies without fallback', async () => {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    fetch() {
      requests++;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
        }),
      );
    },
  });
  try {
    await assert.rejects(client().fetchFileBytes('bot-preferred', server.url.href), {
      message: 'File download timed out after 30 seconds.',
    });
    assert.equal(requests, 1);
  } finally {
    await server.stop(true);
  }
}, 35_000);
