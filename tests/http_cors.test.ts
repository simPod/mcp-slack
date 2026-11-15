import { afterAll, beforeAll, describe, test } from 'bun:test';
import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startHttp } from '@/transports/http.ts';

const ORIGIN = 'https://client.example.com';
const AUTH_TOKEN = 'cors-test-token';
const METHODS = ['POST', 'GET', 'DELETE', 'OPTIONS'];
const HEADERS = [
  'Authorization',
  'Content-Type',
  'MCP-Session-Id',
  'MCP-Protocol-Version',
  'Last-Event-ID',
  'Accept',
];
const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'cors-test', version: '0' },
  },
});

for (const host of ['127.0.0.1', '0.0.0.0']) {
  describe(`HTTP browser boundary on ${host}`, () => {
    let server: Server;
    let base: string;

    beforeAll(async () => {
      server = await startHttp(() => new McpServer({ name: 'cors-test', version: '0' }), {
        host,
        port: host === '127.0.0.1' ? 45823 : 45824,
        authToken: AUTH_TOKEN,
        allowedOrigins: [ORIGIN],
      });
      const address = server.address();
      assert(address !== null && typeof address !== 'string');
      base = `http://127.0.0.1:${address.port.toString()}/mcp`;
    });

    afterAll(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    });

    test('allows unauthenticated preflight for MCP methods and headers only', async () => {
      for (const method of METHODS) {
        const response = await fetch(base, {
          method: 'OPTIONS',
          headers: {
            Origin: ORIGIN,
            'Access-Control-Request-Method': method,
            'Access-Control-Request-Headers': HEADERS.join(', ').toLowerCase(),
          },
        });
        assert.equal(response.status, 204);
        assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
        assert.equal(response.headers.get('vary'), 'Origin');
        assert.deepEqual(
          response.headers.get('access-control-allow-methods')?.split(', '),
          METHODS,
        );
        assert.deepEqual(
          response.headers.get('access-control-allow-headers')?.split(', '),
          HEADERS,
        );
      }

      for (const headers of [
        { 'Access-Control-Request-Method': 'PUT' },
        {
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Authorization, X-Unapproved',
        },
      ]) {
        const response = await fetch(base, {
          method: 'OPTIONS',
          headers: { Origin: ORIGIN, ...headers },
        });
        assert.equal(response.status, 403);
        assert.equal(response.headers.get('access-control-allow-methods'), null);
        await response.body?.cancel();
      }
    });

    test('rejects disallowed origins before preflight or actual MCP operations', async () => {
      for (const method of ['OPTIONS', 'POST', 'GET', 'DELETE']) {
        const response = await fetch(base, {
          method,
          headers: {
            Origin: 'https://untrusted.example.com',
            Authorization: `Bearer ${AUTH_TOKEN}`,
            'Access-Control-Request-Method': 'POST',
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          ...(method === 'POST' ? { body: INITIALIZE } : {}),
        });
        assert.equal(response.status, 403);
        assert.equal(response.headers.get('access-control-allow-origin'), null);
        assert.equal(response.headers.get('vary'), 'Origin');
        await response.body?.cancel();
      }
    });

    test('keeps actual MCP operations authenticated and exposes session headers and errors', async () => {
      for (const method of ['POST', 'GET', 'DELETE']) {
        const response = await fetch(base, { method, headers: { Origin: ORIGIN } });
        assert.equal(response.status, 401);
        assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
        await response.body?.cancel();
      }

      const headers = {
        Origin: ORIGIN,
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      };
      const initialized = await fetch(base, { method: 'POST', headers, body: INITIALIZE });
      assert.equal(initialized.status, 200);
      assert.equal(initialized.headers.get('access-control-allow-origin'), ORIGIN);
      assert.equal(initialized.headers.get('vary'), 'Origin');
      assert.deepEqual(initialized.headers.get('access-control-expose-headers')?.split(', '), [
        'MCP-Session-Id',
        'MCP-Protocol-Version',
      ]);
      const sessionId = initialized.headers.get('mcp-session-id');
      assert(sessionId);
      await initialized.body?.cancel();

      const invalid = await fetch(base, { method: 'POST', headers, body: '{invalid' });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.headers.get('access-control-allow-origin'), ORIGIN);
      await invalid.body?.cancel();

      const protocolError = await fetch(base, {
        method: 'GET',
        headers: { ...headers, 'MCP-Session-Id': sessionId, 'MCP-Protocol-Version': 'invalid' },
      });
      assert.equal(protocolError.status, 400);
      assert.equal(protocolError.headers.get('access-control-allow-origin'), ORIGIN);
      await protocolError.body?.cancel();

      const closed = await fetch(base, {
        method: 'DELETE',
        headers: { ...headers, 'MCP-Session-Id': sessionId },
      });
      assert.equal(closed.status, 200);
      assert.equal(closed.headers.get('access-control-allow-origin'), ORIGIN);
      await closed.body?.cancel();
    });
  });
}

for (const allowedOrigins of [undefined, [], ['*']]) {
  test(`does not grant browser access with origin policy ${JSON.stringify(allowedOrigins)}`, async () => {
    const server = await startHttp(() => new McpServer({ name: 'cors-test', version: '0' }), {
      host: '0.0.0.0',
      port: 0,
      authToken: AUTH_TOKEN,
      ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
    });
    try {
      const address = server.address();
      assert(address !== null && typeof address !== 'string');
      const base = `http://127.0.0.1:${address.port.toString()}/mcp`;
      for (const method of ['OPTIONS', 'POST']) {
        const denied = await fetch(base, {
          method,
          headers: {
            Origin: ORIGIN,
            Authorization: `Bearer ${AUTH_TOKEN}`,
            'Access-Control-Request-Method': 'POST',
          },
        });
        assert.equal(denied.status, 403);
        assert.equal(denied.headers.get('access-control-allow-origin'), null);
        await denied.body?.cancel();
      }

      const native = await fetch(base, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${AUTH_TOKEN}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: INITIALIZE,
      });
      assert.equal(native.status, 200);
      assert.equal(native.headers.get('access-control-allow-origin'), null);
      await native.body?.cancel();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });
}
