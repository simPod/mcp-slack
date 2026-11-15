import { strict as assert } from 'node:assert';
import { test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WebClient } from '@slack/web-api';
import type { ConversationsHistoryArguments } from '@slack/web-api';
import { loadConfig } from '@/config.ts';
import { SlackClient } from '@/slack/client.ts';
import { createServer } from '@/server.ts';

interface Message {
  ts: string;
  user: string;
}

async function connect(messages: Message[]) {
  const config = loadConfig({ SLACK_BOT_TOKEN: 'xoxb-test', SLACK_CHANNEL_IDS: 'C1' });
  const slack = new SlackClient(config);
  const web = new WebClient();
  const calls: ConversationsHistoryArguments[] = [];
  web.conversations.history = (args) => {
    calls.push(args);
    assert.equal(args.channel, 'C1');
    const inWindow = messages.filter(
      (message) =>
        (args.oldest === undefined || Number(message.ts) > Number(args.oldest)) &&
        (args.latest === undefined || Number(message.ts) < Number(args.latest)),
    );
    const offset = Number(args.cursor ?? 0);
    const page = inWindow.slice(offset, offset + (args.limit ?? 100));
    const nextOffset = offset + page.length;
    const hasMore = nextOffset < inWindow.length;
    return Promise.resolve({
      ok: true,
      messages: page,
      has_more: hasMore,
      response_metadata: { next_cursor: hasMore ? String(nextOffset) : '' },
    });
  };
  slack.call = ((_policy, fn) => fn(web)) as SlackClient['call'];
  const server = createServer(config, slack);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'history-test', version: '0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, calls };
}

async function history(client: Client, args: Record<string, unknown>) {
  const result = await client.callTool({
    name: 'get_channel_history',
    arguments: { channel: 'C1', user: 'U1', format: 'json', ...args },
  });
  assert(!result.isError);
  assert(Array.isArray(result.content));
  const block: unknown = result.content[0];
  assert(typeof block === 'object' && block !== null && 'text' in block);
  assert(typeof block.text === 'string');
  const data: unknown = JSON.parse(block.text);
  assert(typeof data === 'object' && data !== null);
  assert('messages' in data && Array.isArray(data.messages));
  const messages = data.messages.map((message: unknown) => {
    assert(typeof message === 'object' && message !== null);
    assert('ts' in message && typeof message.ts === 'string');
    assert('user' in message && typeof message.user === 'string');
    return { ts: message.ts, user: message.user };
  });
  assert('has_more' in data && typeof data.has_more === 'boolean');
  assert('truncated' in data && typeof data.truncated === 'boolean');
  const nextCursor = 'nextCursor' in data ? data.nextCursor : undefined;
  assert(nextCursor === undefined || typeof nextCursor === 'string');
  return { messages, nextCursor, has_more: data.has_more, truncated: data.truncated };
}

for (const limit of [1, 2]) {
  test(`filtered history caps each response at ${limit} and resumes without losing matches`, async () => {
    const messages = [
      { ts: '40', user: 'U1' },
      { ts: '30', user: 'U2' },
      { ts: '29', user: 'U1' },
      { ts: '28', user: 'U1' },
      { ts: '27', user: 'U1' },
      { ts: '10', user: 'U1' },
    ];
    const received: Message[] = [];
    let cursor: string | undefined;
    do {
      // A fresh server for every continuation also rules out server-local buffering.
      const { client } = await connect(messages);
      try {
        const page = await history(client, { limit, cursor, oldest: '20', latest: '35' });
        assert(page.messages.length > 0 && page.messages.length <= limit);
        assert.equal(page.truncated, false);
        assert.equal(page.has_more, page.nextCursor !== undefined);
        received.push(...page.messages);
        cursor = page.nextCursor;
      } finally {
        await client.close();
      }
    } while (cursor !== undefined);
    assert.deepEqual(received, [
      { ts: '29', user: 'U1' },
      { ts: '28', user: 'U1' },
      { ts: '27', user: 'U1' },
    ]);
  });
}

test('sparse filtered history stops at the scan cap and can resume after an empty response', async () => {
  const messages = [
    ...Array.from({ length: 10 }, (_, index) => ({ ts: String(20 - index), user: 'U2' })),
    { ts: '1', user: 'U1' },
  ];
  const { client, calls } = await connect(messages);
  try {
    const first = await history(client, { limit: 1 });
    assert.deepEqual(first.messages, []);
    assert.equal(calls.length, 10);
    assert.equal(first.truncated, true);
    assert.equal(first.has_more, true);
    assert.equal(first.nextCursor, '10');

    const last = await history(client, { limit: 1, cursor: first.nextCursor });
    assert.deepEqual(last.messages, [{ ts: '1', user: 'U1' }]);
    assert.equal(last.truncated, false);
    assert.equal(last.has_more, false);
    assert.equal(last.nextCursor, undefined);
  } finally {
    await client.close();
  }
});
