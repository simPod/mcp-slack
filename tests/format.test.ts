import { describe, expect, test } from 'bun:test';
import { strict as assert } from 'node:assert';
import { decode } from '@toon-format/toon';
import {
  defaultLimit,
  formatResponse,
  resolveFormat,
  resolveLimit,
  shapeChannel,
  shapeMessage,
  shapeUser,
} from '@/format/index.ts';

describe('resolveFormat', () => {
  test('prefers the per-call param', () => {
    expect(resolveFormat('json', 'toon')).toBe('json');
  });
  test('falls back to the configured default', () => {
    expect(resolveFormat(undefined, 'json')).toBe('json');
  });
});

describe('formatResponse', () => {
  const data = { rows: [{ id: 1 }, { id: 2 }] };

  test('encodes JSON', () => {
    expect(JSON.parse(formatResponse(data, 'json'))).toEqual(data);
  });

  test('encodes TOON losslessly', () => {
    expect(decode(formatResponse(data, 'toon'))).toEqual(data);
  });
});

describe('limits', () => {
  test('default is higher for TOON than JSON', () => {
    expect(defaultLimit('toon')).toBeGreaterThan(defaultLimit('json'));
  });

  test('uses the format default when unspecified', () => {
    expect(resolveLimit(undefined, 'toon', 1000)).toBe(defaultLimit('toon'));
  });

  test('honors the agent-provided value', () => {
    expect(resolveLimit(50, 'toon', 1000)).toBe(50);
  });

  test('clamps to the Slack maximum', () => {
    expect(resolveLimit(5000, 'toon', 1000)).toBe(1000);
  });

  test('never returns below 1', () => {
    expect(resolveLimit(0, 'json', 1000)).toBe(1);
  });
});

describe('shapers', () => {
  test('shapeChannel flattens topic/purpose', () => {
    const shaped = shapeChannel({ id: 'C1', name: 'general', topic: { value: 'hi' } });
    expect(shaped.topic).toBe('hi');
    expect(shaped.name).toBe('general');
  });

  test('rich message content survives JSON and TOON without losing compact metadata', () => {
    const message = {
      ts: '1.2',
      text: '',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*Only in blocks*' } }],
      attachments: [
        { fallback: 'attachment fallback', fields: [{ title: 'Status', value: 'OK' }] },
      ],
      reactions: [{ name: 'wave', count: 2 }],
      files: [{ id: 'F1', mimetype: 'image/png' }],
      edited: { user: 'U1', ts: '1.3' },
    };
    for (const format of ['json', 'toon'] as const) {
      const encoded = formatResponse({ messages: [shapeMessage(message)] }, format);
      const decoded: unknown = format === 'json' ? JSON.parse(encoded) : decode(encoded);
      assert(typeof decoded === 'object' && decoded !== null && 'messages' in decoded);
      assert(Array.isArray(decoded.messages));
      const actual: unknown = decoded.messages[0];
      assert(typeof actual === 'object' && actual !== null);
      assert('blocks' in actual && 'attachments' in actual);
      assert.deepEqual(actual.blocks, message.blocks);
      assert.deepEqual(actual.attachments, message.attachments);
      assert('reactions' in actual && 'files' in actual && 'text' in actual && 'edited' in actual);
      assert.equal(actual.reactions, 'wave:2');
      assert.equal(actual.files, 'F1:image/png');
      assert.equal(actual.text, '');
      assert.equal(actual.edited, true);
    }
  });

  test('shapeUser prefers profile fields', () => {
    const shaped = shapeUser({ id: 'U1', profile: { display_name: 'ace', email: 'a@b.c' } });
    expect(shaped.display_name).toBe('ace');
    expect(shaped.email).toBe('a@b.c');
  });

  test('a uniform shaped array round-trips through TOON as a table', () => {
    const channels = [
      { id: 'C1', name: 'a' },
      { id: 'C2', name: 'b' },
    ].map(shapeChannel);
    const encoded = formatResponse({ channels }, 'toon');
    expect(encoded).toContain('channels[2]{');
    // TOON keeps uniform columns, decoding absent (undefined) cells back as null.
    const decoded = decode(encoded) as { channels: { id: string; name: string }[] };
    expect(decoded.channels.map((c) => c.id)).toEqual(['C1', 'C2']);
    expect(decoded.channels[0]?.name).toBe('a');
  });
});
