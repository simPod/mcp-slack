import { test } from 'bun:test';
import { strict as assert } from 'node:assert';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode } from '@slack/web-api';
import { decode } from '@toon-format/toon';
import { loadConfig } from '@/config.ts';
import { SlackClient } from '@/slack/client.ts';
import { createServer } from '@/server.ts';

async function connect() {
  const config = loadConfig({ SLACK_BOT_TOKEN: 'xoxb-test', SLACK_USER_TOKEN: 'xoxp-test' });
  const slack = new SlackClient(config);
  const server = createServer(config, slack);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'message-fidelity-test', version: '0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { slack, client, close: () => client.close() };
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content;
  assert(Array.isArray(content));
  const first: unknown = content[0];
  assert(typeof first === 'object' && first !== null && 'text' in first);
  assert(typeof first.text === 'string');
  return first.text;
}

for (const tool of [
  'post_message',
  'reply_to_thread',
  'update_message',
  'post_ephemeral',
  'schedule_message',
] as const) {
  test(`${tool} rejects oversized text before Slack and reports actual text and warnings`, async () => {
    const ctx = await connect();
    let calls = 0;
    const returned = {
      ok: true,
      channel: 'C1',
      ts: '1.2',
      ...(tool === 'post_ephemeral' ? { message_ts: '2.3' } : {}),
      ...(tool === 'schedule_message'
        ? { scheduled_message_id: 'Q1', post_at: 2_000_000_000 }
        : {}),
      // Slack update responses can put text at the top level.
      ...(tool === 'update_message'
        ? { text: 'actual Slack text' }
        : { message: { text: 'actual Slack text' } }),
      warning: 'message_truncated',
      response_metadata: {
        warnings: ['message_truncated'],
        messages: ['[WARN] Slack changed the submitted message'],
      },
    };
    for (const policy of ['bot-preferred', 'user-preferred'] as const) {
      const c = ctx.slack.clientFor(policy);
      c.chat.postMessage = () => {
        calls++;
        return Promise.resolve(returned);
      };
      c.chat.update = () => {
        calls++;
        return Promise.resolve(returned);
      };
      c.chat.postEphemeral = () => {
        calls++;
        return Promise.resolve(returned);
      };
      c.chat.scheduleMessage = () => {
        calls++;
        return Promise.resolve(returned);
      };
    }
    const args = { channel: 'C1', ts: '1.2', thread_ts: '1.0', user: 'U1', post_at: 2_000_000_000 };
    try {
      const oversized = await ctx.client.callTool({
        name: tool,
        arguments: { ...args, text: 'x'.repeat(40_001) },
      });
      assert.equal(oversized.isError, true);
      assert.match(textOf(oversized), /40000/);
      assert.equal(calls, 0);

      for (const format of ['json', 'toon'] as const) {
        const result = await ctx.client.callTool({
          name: tool,
          arguments: { ...args, text: 'x'.repeat(40_000), format },
        });
        assert(!result.isError);
        const text = textOf(result);
        const parsed: unknown = format === 'json' ? JSON.parse(text) : decode(text);
        assert.deepEqual(parsed, {
          ok: true,
          channel: 'C1',
          ts: '1.2',
          ...(tool === 'post_ephemeral' ? { message_ts: '2.3' } : {}),
          ...(tool === 'schedule_message'
            ? { scheduled_message_id: 'Q1', post_at: 2_000_000_000 }
            : {}),
          text: 'actual Slack text',
          warning: 'message_truncated',
          response_metadata: returned.response_metadata,
        });
      }
      assert.equal(calls, 2);
    } finally {
      await ctx.close();
    }
  });
}

for (const operation of ['update', 'delete'] as const) {
  test(`${operation}_message falls back to the bot owner only after a clear refusal`, async () => {
    const ctx = await connect();
    const attempts: string[] = [];
    const user = ctx.slack.clientFor('user-required');
    const bot = ctx.slack.clientFor('bot-preferred');
    user.chat[operation] = () => {
      attempts.push('user');
      return Promise.reject({
        code: ErrorCode.PlatformError,
        data: { ok: false, error: `cant_${operation}_message` },
      });
    };
    bot.chat[operation] = () => {
      attempts.push('bot');
      return Promise.resolve({ ok: true, channel: 'C1', ts: '1.2' });
    };
    try {
      const result = await ctx.client.callTool({
        name: `${operation}_message`,
        arguments: { channel: 'C1', ts: '1.2', text: 'edit', format: 'json' },
      });
      assert(!result.isError);
      assert.deepEqual(attempts, ['user', 'bot']);
      assert.deepEqual(JSON.parse(textOf(result)), { ok: true, channel: 'C1', ts: '1.2' });

      attempts.length = 0;
      user.chat[operation] = () => {
        attempts.push('user');
        return Promise.reject({ code: ErrorCode.RequestError, message: 'Request timed out' });
      };
      const ambiguous = await ctx.client.callTool({
        name: `${operation}_message`,
        arguments: { channel: 'C1', ts: '1.2', text: 'edit' },
      });
      assert.equal(ambiguous.isError, true);
      assert.match(textOf(ambiguous), /timed out/);
      assert.deepEqual(attempts, ['user']);
    } finally {
      await ctx.close();
    }
  });
}
