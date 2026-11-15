import webApiDefault from '@slack/web-api';
import * as webApiNamespace from '@slack/web-api';
import type { ErrorCode as SlackErrorCode, WebAPICallResult, WebClient } from '@slack/web-api';
import type { ReadableStreamDefaultReader } from 'node:stream/web';
import type { Config } from '@/config.ts';

// Destructure through the default export, falling back to the namespace:
// @slack/web-api is CommonJS, so named ESM imports of its getter-based
// re-exports (e.g. `ErrorCode`) break on Node 20's export detection,
// while CJS-bundled interop honors `__esModule` and leaves the default unset.
const { WebClient: SlackWebClient, ErrorCode } =
  (webApiDefault as typeof webApiDefault | undefined) ?? webApiNamespace;

/**
 * Token-selection policy for a tool.
 *
 * - `bot-preferred`  → bot client, falling back to the user client.
 * - `user-preferred` → user client, falling back to the bot client.
 * - `user-required`  → user client only; errors if no user token is configured.
 *
 * The fallback is not only for a missing token: a configured token that exists
 * but cannot perform the call (missing scope, not in the channel, revoked) also
 * falls through to the other identity. See `isIdentityError`.
 */
export type TokenPolicy = 'bot-preferred' | 'user-preferred' | 'user-required';

/** Which configured token a client was built from. */
export type TokenKind = 'bot' | 'user';

/** Error raised when a tool cannot obtain a client for its token policy. */
export class SlackAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlackAuthError';
  }
}

/** Normalized Slack API error with an agent-readable message. */
export class SlackApiError extends Error {
  readonly slackError: string | undefined;
  readonly retryAfter: number | undefined;

  constructor(message: string, slackError?: string, retryAfter?: number) {
    super(message);
    this.name = 'SlackApiError';
    this.slackError = slackError;
    this.retryAfter = retryAfter;
  }
}

interface SlackErrorLike {
  code?: SlackErrorCode;
  data?: {
    error?: string;
    needed?: string;
    provided?: string;
    response_metadata?: { messages?: string[] };
  };
  retryAfter?: number;
  message?: string;
}

/**
 * Slack errors that mean "this identity may not do this", as opposed to "this
 * request is wrong". They are a property of the token, not of the arguments, so
 * the same call may well succeed as the other identity - a bot missing
 * `channels:history` and a user token that has it is the common case, and a
 * private channel the bot never joined reports `channel_not_found` rather than
 * a membership error. Retrying these is safe: Slack rejects them before the
 * call does any work, so no side effect can be duplicated.
 */
const IDENTITY_ERRORS: ReadonlySet<string> = new Set([
  'missing_scope',
  'not_allowed_token_type',
  'no_permission',
  'not_in_channel',
  'channel_not_found',
  'restricted_action',
  'access_denied',
  'invalid_auth',
  'account_inactive',
  'token_revoked',
  'token_expired',
  'ekm_access_denied',
  // Slack rejected the mutation because this identity does not own the message.
  'cant_update_message',
  'cant_delete_message',
]);

function isIdentityError(error: SlackApiError): boolean {
  return error.slackError !== undefined && IDENTITY_ERRORS.has(error.slackError);
}

interface TokenClient {
  readonly kind: TokenKind;
  readonly client: WebClient;
}

/** A list that is known to hold at least one element. */
type NonEmpty<T> = readonly [T, ...T[]];

/**
 * Thin wrapper around `@slack/web-api` holding up to two `WebClient`s (one per
 * token) and encapsulating token-selection policy. Returns raw Slack response
 * data — formatting/TOON concerns live in `src/format`.
 */
export class SlackClient {
  private readonly bot: WebClient | undefined;
  private readonly user: WebClient | undefined;

  readonly teamId: string | undefined;
  readonly channelIds: readonly string[];

  constructor(config: Config) {
    const options = {
      timeout: 30_000,
      rejectRateLimitedCalls: true,
      // A transport failure may occur after Slack committed a write. Do not
      // replay it; only explicit identity refusals in call() permit fallback.
      retryConfig: { retries: 0 },
    };
    this.bot =
      config.botToken !== undefined ? new SlackWebClient(config.botToken, options) : undefined;
    this.user =
      config.userToken !== undefined ? new SlackWebClient(config.userToken, options) : undefined;
    this.teamId = config.teamId;
    this.channelIds = config.channelIds;
  }

  /**
   * Enforce the configured channel allowlist as a real access boundary.
   *
   * When `SLACK_CHANNEL_IDS` is set, any channel-scoped tool call must target a
   * channel in the list; otherwise it is rejected before reaching Slack. A
   * missing channel argument (e.g. workspace-wide listing) is always allowed.
   * The allowlist holds channel IDs, so callers must pass IDs (not names) for
   * the check to succeed.
   */
  assertChannelAllowed(channel: string | undefined): void {
    if (channel === undefined || this.channelIds.length === 0) {
      return;
    }
    if (!this.channelIds.includes(channel)) {
      throw new SlackAuthError(
        `Channel ${channel} is not in the configured SLACK_CHANNEL_IDS allowlist.`,
      );
    }
  }

  /**
   * Ordered candidate identities for a policy: the preferred one first, then
   * the other as a fallback. Throws when the policy cannot be satisfied at all.
   */
  private candidatesFor(policy: TokenPolicy): NonEmpty<TokenClient> {
    const bot: TokenClient[] = this.bot !== undefined ? [{ kind: 'bot', client: this.bot }] : [];
    const user: TokenClient[] =
      this.user !== undefined ? [{ kind: 'user', client: this.user }] : [];

    if (policy === 'user-required') {
      const [only] = user;
      if (only === undefined) {
        throw new SlackAuthError(
          'This tool requires a user token. Set SLACK_USER_TOKEN (xoxp-...) to use it.',
        );
      }
      return [only];
    }

    const [preferred, ...rest] = policy === 'bot-preferred' ? [...bot, ...user] : [...user, ...bot];
    if (preferred === undefined) {
      throw new SlackAuthError('No Slack token is configured.');
    }
    return [preferred, ...rest];
  }

  /**
   * Resolve the preferred `WebClient` for the given policy, or throw. Prefer
   * `call`, which additionally falls back to the other identity on refusal.
   */
  clientFor(policy: TokenPolicy): WebClient {
    return this.candidatesFor(policy)[0].client;
  }

  /**
   * Download an authenticated Slack file URL (e.g. `url_private`) as bytes.
   *
   * Slack's private file URLs are not public — they require the token as a
   * Bearer credential — so this reuses the policy-selected client's token
   * instead of going through the Web API surface (which does not stream files).
   * An identity that may not read the file gets an HTTP 401/403/404, so the
   * other configured token is tried before giving up. Each attempt has a
   * 30-second deadline including body reads; oversized bodies are cancelled.
   */
  async fetchFileBytes(
    policy: TokenPolicy,
    url: string,
    maxBytes = 5 * 1024 * 1024,
  ): Promise<{ bytes: Uint8Array; contentType: string | undefined }> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new SlackApiError('File download maxBytes must be a positive safe integer.');
    }
    const candidates = this.candidatesFor(policy);
    let firstFailure: SlackApiError | undefined;

    for (const [index, candidate] of candidates.entries()) {
      const isLast = index === candidates.length - 1;
      const token = candidate.client.token;
      if (token === undefined || token === '') {
        throw new SlackAuthError('No token available to download the file.');
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, 30_000);
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!res.ok) {
          void res.body?.cancel().catch(() => undefined);
          const failure = new SlackApiError(
            `Failed to download file with the ${candidate.kind} token (HTTP ${res.status}).`,
          );
          const retryable = res.status === 401 || res.status === 403 || res.status === 404;
          if (!retryable || isLast) {
            throw firstFailure ?? failure;
          }
          firstFailure ??= failure;
          continue;
        }

        const tooLarge = () =>
          new SlackApiError(`File download exceeds the max_bytes limit of ${maxBytes} bytes.`);
        const length = res.headers.get('content-length');
        if (length !== null && Number(length) > maxBytes) {
          void res.body?.cancel().catch(() => undefined);
          throw tooLarge();
        }

        const chunks: Uint8Array[] = [];
        let total = 0;
        const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = res.body?.getReader();
        if (reader !== undefined) {
          let done = false;
          try {
            let chunk = await reader.read();
            while (!chunk.done) {
              total += chunk.value.byteLength;
              if (total > maxBytes) throw tooLarge();
              chunks.push(chunk.value);
              chunk = await reader.read();
            }
            done = true;
          } finally {
            if (!done) void reader.cancel().catch(() => undefined);
            reader.releaseLock();
          }
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return {
          bytes,
          contentType: res.headers.get('content-type') ?? undefined,
        };
      } catch (error) {
        if (error instanceof SlackApiError) throw error;
        // Fetch errors can contain the private URL or credentials. Do not echo
        // them into a tool result.
        throw new SlackApiError(
          controller.signal.aborted
            ? 'File download timed out after 30 seconds.'
            : 'Failed to download file.',
        );
      } finally {
        clearTimeout(timeout);
        controller.abort();
      }
    }

    // Unreachable: the loop either returns or throws on its last candidate.
    throw new SlackApiError('Failed to download file.');
  }

  /**
   * Invoke a Slack API call with a policy-selected client, normalizing any
   * error into a `SlackApiError` / `SlackAuthError`.
   *
   * When the preferred identity is refused for a reason the other identity may
   * not share (see `IDENTITY_ERRORS`), the call is transparently retried with
   * the other configured token. That makes a dual-token setup behave the way
   * operators expect: a bot without `channels:history` no longer fails a read
   * that the configured user token is perfectly able to perform.
   */
  async call<T = WebAPICallResult>(
    policy: TokenPolicy,
    fn: (client: WebClient) => Promise<WebAPICallResult>,
  ): Promise<T> {
    const candidates = this.candidatesFor(policy);
    let firstFailure: { kind: TokenKind; error: SlackApiError } | undefined;

    for (const [index, candidate] of candidates.entries()) {
      const isLast = index === candidates.length - 1;
      try {
        return (await fn(candidate.client)) as T;
      } catch (error) {
        const normalized = normalizeSlackError(error);
        if (normalized instanceof SlackAuthError) {
          throw normalized;
        }
        if (!isIdentityError(normalized)) {
          // Not an identity problem: the other token would fail the same way.
          throw firstFailure !== undefined
            ? combine(firstFailure, candidate.kind, normalized)
            : normalized;
        }
        if (isLast) {
          throw firstFailure !== undefined
            ? combine(firstFailure, candidate.kind, normalized)
            : normalized;
        }
        firstFailure ??= { kind: candidate.kind, error: normalized };
      }
    }

    // Unreachable: the loop either returns or throws on its last candidate.
    throw new SlackApiError('Unknown Slack API error.');
  }
}

/**
 * Report both attempts when a fallback was tried, so the operator can see which
 * identity is missing what instead of only the last failure.
 */
function combine(
  first: { kind: TokenKind; error: SlackApiError },
  secondKind: TokenKind,
  second: SlackApiError,
): SlackApiError {
  return new SlackApiError(
    `${first.error.message} [${first.kind} token] ` +
      `Retried with the ${secondKind} token, which also failed: ${second.message}`,
    first.error.slackError,
    first.error.retryAfter,
  );
}

function normalizeSlackError(error: unknown): SlackApiError | SlackAuthError {
  if (error instanceof SlackAuthError) {
    return error;
  }

  const err = error as SlackErrorLike;

  if (err.code === ErrorCode.RateLimitedError) {
    const retryAfter = err.retryAfter;
    return new SlackApiError(
      `Slack rate limit hit${retryAfter !== undefined ? `; retry after ${retryAfter}s` : ''}.`,
      'ratelimited',
      retryAfter,
    );
  }

  const slackError = err.data?.error;
  if (
    slackError !== undefined &&
    (err.code === undefined || err.code === ErrorCode.PlatformError)
  ) {
    const details: string[] = [];
    // `missing_scope` carries the exact scopes Slack wanted and the ones the
    // token has. Surfacing them turns an opaque failure into a fix.
    if (err.data?.needed !== undefined && err.data.needed !== '') {
      details.push(`needed: ${err.data.needed}`);
    }
    if (err.data?.provided !== undefined && err.data.provided !== '') {
      details.push(`provided: ${err.data.provided}`);
    }
    details.push(...(err.data?.response_metadata?.messages ?? []));
    const suffix = details.length > 0 ? ` (${details.join('; ')})` : '';
    const hint =
      slackError === 'missing_scope'
        ? ' Add the missing scope to the Slack app and reinstall it, or configure a token that has it.'
        : '';
    return new SlackApiError(`Slack API error: ${slackError}${suffix}${hint}`, slackError);
  }

  const message = err.message ?? 'Unknown Slack API error.';
  return new SlackApiError(message);
}
