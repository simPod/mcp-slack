import { test } from 'bun:test';
import { strict as assert } from 'node:assert';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode } from '@slack/web-api';
import { loadConfig } from '@/config.ts';
import { SlackClient } from '@/slack/client.ts';
import { createServer } from '@/server.ts';

async function connect(mimetype: string, bytes: Uint8Array, size = bytes.byteLength) {
  const config = loadConfig({
    SLACK_BOT_TOKEN: 'test-bot',
    SLACK_USER_TOKEN: 'test-user',
    SLACK_CHANNEL_IDS: 'CALLOWED',
  });
  const slack = new SlackClient(config);
  const api = slack.clientFor('bot-preferred');
  api.files.info = () =>
    Promise.resolve({
      ok: true,
      file: { id: 'F1', mimetype, size, channels: ['CALLOWED'], url_private: 'https://slack/file' },
    });
  let downloads = 0;
  let downloadLimit: number | undefined;
  slack.fetchFileBytes = (_policy, _url, maxBytes) => {
    downloads++;
    downloadLimit = maxBytes;
    return Promise.resolve({ bytes, contentType: mimetype });
  };
  const client = new Client({ name: 'file-content-test', version: '1' });
  const server = createServer(config, slack);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, slack, downloads: () => downloads, downloadLimit: () => downloadLimit };
}

test('non-image downloads return file contents, not just an authenticated URL', async () => {
  for (const example of [
    {
      mime: 'text/plain',
      bytes: new TextEncoder().encode('Requirement: preserve this text.'),
      text: true,
    },
    { mime: 'application/pdf', bytes: new Uint8Array([37, 80, 68, 70, 0, 255]), text: false },
    { mime: 'text/plain', bytes: new Uint8Array([255, 254, 65, 0]), text: false },
  ]) {
    const ctx = await connect(example.mime, example.bytes);
    try {
      const result = await ctx.client.callTool({
        name: 'get_file',
        arguments: { file_id: 'F1', max_bytes: 123 },
      });
      assert.notEqual(result.isError, true);
      assert(Array.isArray(result.content));
      const block: unknown = result.content[1];
      assert(typeof block === 'object' && block !== null && 'type' in block);
      assert.equal(block.type, 'resource');
      assert('resource' in block && typeof block.resource === 'object' && block.resource !== null);
      const resource = block.resource;
      assert('mimeType' in resource);
      assert.equal(resource.mimeType, example.mime);
      assert('uri' in resource);
      assert.equal(resource.uri, 'slack://files/F1');
      if (example.text) {
        assert('text' in resource);
        assert.equal(resource.text, 'Requirement: preserve this text.');
      } else {
        assert('blob' in resource && typeof resource.blob === 'string');
        assert.deepEqual(new Uint8Array(Buffer.from(resource.blob, 'base64')), example.bytes);
      }
      assert.equal(ctx.downloads(), 1);
      assert.equal(ctx.downloadLimit(), 123);
    } finally {
      await ctx.client.close();
    }
  }
});

test('uploads return the file IDs nested in SDK completion responses without restarting failed flows', async () => {
  const ctx = await connect('text/plain', new Uint8Array());
  const bot = ctx.slack.clientFor('bot-preferred');
  const user = ctx.slack.clientFor('user-required');
  let botCalls = 0;
  let userCalls = 0;
  bot.filesUploadV2 = () => {
    botCalls++;
    return Promise.resolve({
      ok: true,
      files: [{ ok: true, files: [{ id: 'FUPLOADED', title: 'Note' }] }],
    });
  };
  user.filesUploadV2 = () => {
    userCalls++;
    return Promise.resolve({ ok: true, files: [] });
  };
  const request = {
    name: 'upload_file',
    arguments: { filename: 'note.txt', content: 'Note', channel_id: 'CALLOWED', format: 'json' },
  };
  try {
    const uploaded = await ctx.client.callTool(request);
    assert.notEqual(uploaded.isError, true);
    assert(Array.isArray(uploaded.content));
    const text: unknown = uploaded.content[0];
    assert(
      typeof text === 'object' && text !== null && 'text' in text && typeof text.text === 'string',
    );
    const parsed: unknown = JSON.parse(text.text);
    assert.deepEqual(parsed, { ok: true, files: [{ id: 'FUPLOADED', title: 'Note' }] });
    bot.filesUploadV2 = () => {
      botCalls++;
      return Promise.reject({ code: ErrorCode.PlatformError, data: { error: 'not_in_channel' } });
    };
    const failed = await ctx.client.callTool(request);
    assert.equal(failed.isError, true);
    assert.equal(botCalls, 2);
    assert.equal(userCalls, 0);
  } finally {
    await ctx.client.close();
  }
});

test('oversized non-image files return metadata without downloading', async () => {
  const ctx = await connect('application/pdf', new Uint8Array([1]), 10);
  try {
    const result = await ctx.client.callTool({
      name: 'get_file',
      arguments: { file_id: 'F1', max_bytes: 5 },
    });
    assert.notEqual(result.isError, true);
    assert.equal(ctx.downloads(), 0);
    assert(!JSON.stringify(result).includes('"type":"resource"'));
    assert(JSON.stringify(result).includes('metadata only'));
  } finally {
    await ctx.client.close();
  }
});
