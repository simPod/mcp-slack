import { describe, expect, test } from 'bun:test';
import { strict as assert } from 'node:assert';
import { ErrorCode } from '@slack/web-api';
import { loadConfig } from '@/config.ts';
import { SlackApiError, SlackAuthError, SlackClient } from '@/slack/client.ts';

function botOnly(): SlackClient {
  return new SlackClient(loadConfig({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_TEAM_ID: 'T1' }));
}

function withUser(): SlackClient {
  return new SlackClient(
    loadConfig({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_USER_TOKEN: 'xoxp-1', SLACK_TEAM_ID: 'T1' }),
  );
}

describe('token policies', () => {
  test('bot-preferred resolves a client with only a bot token', () => {
    expect(botOnly().clientFor('bot-preferred')).toBeDefined();
  });

  test('user-preferred falls back to the bot client when no user token', () => {
    expect(botOnly().clientFor('user-preferred')).toBeDefined();
  });

  test('user-required throws without a user token', () => {
    expect(() => botOnly().clientFor('user-required')).toThrow(SlackAuthError);
    expect(() => botOnly().clientFor('user-required')).toThrow(/SLACK_USER_TOKEN/);
  });

  test('user-required resolves with a user token', () => {
    expect(withUser().clientFor('user-required')).toBeDefined();
  });

  test('exposes team id and channel allowlist', () => {
    const client = new SlackClient(
      loadConfig({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_TEAM_ID: 'T9', SLACK_CHANNEL_IDS: 'C1,C2' }),
    );
    expect(client.teamId).toBe('T9');
    expect(client.channelIds).toEqual(['C1', 'C2']);
  });
});

describe('error normalization', () => {
  test('maps an ok:false platform error to its slack error code', async () => {
    const client = botOnly();
    const promise = client.call('bot-preferred', () =>
      Promise.reject({ data: { error: 'channel_not_found' } }),
    );
    await expect(promise).rejects.toBeInstanceOf(SlackApiError);
    await expect(promise).rejects.toThrow(/channel_not_found/);
  });

  test('captures retry-after on a rate-limit error', async () => {
    const client = botOnly();
    try {
      await client.call('bot-preferred', () =>
        Promise.reject({ code: ErrorCode.RateLimitedError, retryAfter: 7 }),
      );
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(SlackApiError);
      expect((error as SlackApiError).retryAfter).toBe(7);
    }
  });

  test('re-throws auth errors untouched', async () => {
    const client = botOnly();
    const promise = client.call('user-required', () => Promise.resolve({ ok: true }));
    await expect(promise).rejects.toBeInstanceOf(SlackAuthError);
  });
});

describe('identity fallback', () => {
  function missingScope(needed: string, provided: string): unknown {
    return { data: { error: 'missing_scope', needed, provided } };
  }

  test('falls back to the user token when the bot token lacks the scope', async () => {
    const client = withUser();
    const seen: string[] = [];
    const result = await client.call<{ ok: boolean }>('bot-preferred', (c) => {
      const token = (c as unknown as { token: string }).token;
      seen.push(token);
      if (token.startsWith('xoxb-')) {
        return Promise.reject(missingScope('channels:history', 'chat:write'));
      }
      return Promise.resolve({ ok: true });
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual(['xoxb-1', 'xoxp-1']);
  });

  test('does not retry an error that is not about the identity', async () => {
    const client = withUser();
    let calls = 0;
    const promise = client.call('bot-preferred', () => {
      calls++;
      return Promise.reject({ data: { error: 'invalid_ts_latest' } });
    });
    await expect(promise).rejects.toThrow(/invalid_ts_latest/);
    expect(calls).toBe(1);
  });

  test('does not retry a rate limit against the other token', async () => {
    const client = withUser();
    let calls = 0;
    const promise = client.call('bot-preferred', () => {
      calls++;
      return Promise.reject({ code: ErrorCode.RateLimitedError, retryAfter: 3 });
    });
    await expect(promise).rejects.toThrow(/rate limit/);
    expect(calls).toBe(1);
  });

  test('reports both identities when the fallback fails too', async () => {
    const client = withUser();
    const promise = client.call('bot-preferred', (c) =>
      Promise.reject(
        (c as unknown as { token: string }).token.startsWith('xoxb-')
          ? missingScope('channels:history', 'chat:write')
          : { data: { error: 'not_in_channel' } },
      ),
    );
    await expect(promise).rejects.toThrow(/missing_scope/);
    await expect(promise).rejects.toThrow(/\[bot token\]/);
    await expect(promise).rejects.toThrow(/user token, which also failed: .*not_in_channel/);
  });

  test('user-required never falls back to the bot token', async () => {
    const client = withUser();
    let calls = 0;
    const promise = client.call('user-required', () => {
      calls++;
      return Promise.reject(missingScope('search:read', ''));
    });
    await expect(promise).rejects.toThrow(/missing_scope/);
    expect(calls).toBe(1);
  });

  test('surfaces the needed and provided scopes with a fix hint', async () => {
    const client = botOnly();
    const promise = client.call('bot-preferred', () =>
      Promise.reject(missingScope('channels:history', 'chat:write,channels:read')),
    );
    await expect(promise).rejects.toThrow(/needed: channels:history/);
    await expect(promise).rejects.toThrow(/provided: chat:write,channels:read/);
    await expect(promise).rejects.toThrow(/reinstall/);
  });
});

describe('request safety', () => {
  for (const status of [429, 503]) {
    test(`does not replay a write after HTTP ${status}`, async () => {
      let requests = 0;
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch() {
          requests++;
          return new Response('failed', { status, headers: { 'retry-after': '1' } });
        },
      });
      try {
        const client = withUser();
        await assert.rejects(
          client.call('user-preferred', (c) =>
            c.apiCall(new URL('chat.postMessage', server.url).href, {
              channel: 'C1',
              text: 'only once',
            }),
          ),
          (error: unknown) => {
            assert(error instanceof SlackApiError);
            if (status === 429) {
              assert.equal(error.slackError, 'ratelimited');
              assert.equal(error.retryAfter, 1);
            }
            return true;
          },
        );
        assert.equal(requests, 1);
      } finally {
        await server.stop(true);
      }
    });
  }

  test('bounds stalled Web API writes to 30 seconds without fallback', async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch() {
        requests++;
        return new Promise<Response>(() => {});
      },
    });
    try {
      await assert.rejects(
        withUser().call('user-preferred', (c) =>
          c.apiCall(new URL('chat.postMessage', server.url).href, {
            channel: 'C1',
            text: 'only once',
          }),
        ),
        /timeout.*30000|30000.*timeout/i,
      );
      assert.equal(requests, 1);
    } finally {
      await server.stop(true);
    }
  }, 35_000);
});
