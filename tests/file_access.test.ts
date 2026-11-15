import { test } from 'bun:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { WebAPICallResult, WebClient } from '@slack/web-api';
import { loadConfig } from '@/config.ts';
import { SlackClient } from '@/slack/client.ts';
import type { TokenPolicy } from '@/slack/client.ts';
import { createServer } from '@/server.ts';

async function connect(env: NodeJS.ProcessEnv, file: Record<string, unknown> = {}) {
  const config = loadConfig({ SLACK_BOT_TOKEN: 'test-bot', ...env });
  const slack = new SlackClient(config);
  const uploads: unknown[] = [];
  let downloads = 0;
  const api = {
    files: { info: () => Promise.resolve({ ok: true, file: { id: 'F1', ...file } }) },
    filesUploadV2: (args: unknown) => {
      uploads.push(args);
      return Promise.resolve({ ok: true, files: [{ id: 'F2' }] });
    },
  } as unknown as WebClient;
  slack.call = <T>(
    _policy: TokenPolicy,
    fn: (client: WebClient) => Promise<WebAPICallResult>,
  ): Promise<T> => fn(api) as Promise<T>;
  slack.fetchFileBytes = () => {
    downloads++;
    return Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' });
  };
  const server = createServer(config, slack);
  const client = new Client({ name: 'file-access-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, uploads, downloads: () => downloads };
}

test('file reads require a known allowed share before returning metadata or bytes', async () => {
  for (const sharing of [
    { channels: ['CSECRET'] },
    { shares: { private: { CSECRET: [{ ts: '1' }] } } },
    {},
  ]) {
    const ctx = await connect(
      { SLACK_CHANNEL_IDS: 'CALLOWED' },
      { mimetype: 'image/png', url_private: 'https://files.slack.com/test', ...sharing },
    );
    try {
      const result = await ctx.client.callTool({
        name: 'get_file',
        arguments: { file_id: 'F1' },
      });
      assert.equal(result.isError, true);
      assert.equal(ctx.downloads(), 0);
      assert(!JSON.stringify(result).includes('files.slack.com'));
    } finally {
      await ctx.client.close();
    }
  }
  const ctx = await connect(
    { SLACK_CHANNEL_IDS: 'CALLOWED' },
    {
      mimetype: 'image/png',
      url_private: 'https://files.slack.com/test',
      shares: { private: { CALLOWED: [{ ts: '1' }], CSECRET: [{ ts: '2' }] } },
    },
  );
  try {
    const result = await ctx.client.callTool({ name: 'get_file', arguments: { file_id: 'F1' } });
    assert.notEqual(result.isError, true);
    assert.equal(ctx.downloads(), 1);
  } finally {
    await ctx.client.close();
  }
});

test('restricted uploads require an allowed channel, including inline uploads', async () => {
  const ctx = await connect({ SLACK_CHANNEL_IDS: 'CALLOWED' });
  try {
    for (const channel of [undefined, 'CSECRET']) {
      const result = await ctx.client.callTool({
        name: 'upload_file',
        arguments: {
          filename: 'note.txt',
          content: 'safe',
          ...(channel === undefined ? {} : { channel_id: channel }),
        },
      });
      assert.equal(result.isError, true);
    }
    assert.equal(ctx.uploads.length, 0);
    const result = await ctx.client.callTool({
      name: 'upload_file',
      arguments: { filename: 'note.txt', content: 'safe', channel_id: 'CALLOWED' },
    });
    assert.notEqual(result.isError, true);
    assert.equal(ctx.uploads.length, 1);
  } finally {
    await ctx.client.close();
  }
});

test('local uploads are opt-in and reject traversal and symlinks outside the upload root', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'mcp-slack-upload-'));
  const root = join(temp, 'uploads');
  await mkdir(root);
  await writeFile(join(root, 'allowed.txt'), 'allowed');
  await writeFile(join(temp, 'secret.txt'), 'secret');
  await symlink(join(temp, 'secret.txt'), join(root, 'escape.txt'));
  const disabled = await connect({});
  const enabled = await connect({ SLACK_MCP_UPLOAD_ROOT: root });
  try {
    const denied = await disabled.client.callTool({
      name: 'upload_file',
      arguments: { filename: 'allowed.txt', file_path: join(root, 'allowed.txt') },
    });
    assert.equal(denied.isError, true);
    assert.equal(disabled.uploads.length, 0);
    for (const filePath of ['../secret.txt', 'escape.txt']) {
      const result = await enabled.client.callTool({
        name: 'upload_file',
        arguments: { filename: 'file.txt', file_path: filePath },
      });
      assert.equal(result.isError, true);
    }
    assert.equal(enabled.uploads.length, 0);
    const allowed = await enabled.client.callTool({
      name: 'upload_file',
      arguments: { filename: 'allowed.txt', file_path: 'allowed.txt' },
    });
    assert.notEqual(allowed.isError, true);
    assert.equal(enabled.uploads.length, 1);
  } finally {
    await Promise.all([disabled.client.close(), enabled.client.close()]);
    await rm(temp, { recursive: true });
  }
});
