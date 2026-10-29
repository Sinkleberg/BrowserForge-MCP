import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { TOKEN, closed, connectFake, hello, startHub } from '../helpers/fake-extension.js';
import { startStack, waitFor, type Stack } from '../helpers/stack.js';

let stack: Stack;
beforeAll(async () => { stack = await startStack(); });
afterAll(async () => { await stack.close(); });

const raw = (opts: { path: string; method?: string; headers?: Record<string, string>; body?: string }) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: stack.app.port, path: opts.path, method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode!, body: b }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });

describe('HTTP endpoint (MCP + status)', () => {
  const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  const good = () => ({ authorization: `Bearer ${stack.app.ctx.config.mcpToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' });

  it('binds to loopback only', () => {
    expect((stack.app.httpServer.address() as { address: string }).address).toBe('127.0.0.1');
  });
  it('health is public but reveals nothing sensitive', async () => {
    const r = await raw({ path: '/health' });
    expect(r.status).toBe(200);
    expect(r.body).not.toMatch(/token|tabs|cookie|connected/i);
  });
  it('rejects missing, malformed and wrong bearer tokens', async () => {
    for (const authorization of [undefined, 'Bearer', 'Bearer wrong', 'Basic abc', `Bearer ${stack.app.ctx.config.extensionToken}`]) {
      const r = await raw({ path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: init });
      expect(r.status, String(authorization)).toBe(401);
    }
    expect((await raw({ path: '/status' })).status).toBe(401);
  });
  it('accepts the right token', async () => {
    const r = await raw({ path: '/mcp', method: 'POST', headers: good(), body: init });
    expect(r.status).toBe(200);
  });
  it('blocks DNS-rebinding style Host headers, even with a valid token', async () => {
    for (const host of ['evil.example.com', 'evil.example.com:80', '127.0.0.1.evil.com', 'localhost.evil.com:7345']) {
      const r = await raw({ path: '/mcp', method: 'POST', headers: { ...good(), host }, body: init });
      expect(r.status, host).toBe(403);
    }
    expect((await raw({ path: '/health', headers: { host: 'evil.com' } })).status).toBe(403);
  });
  it('blocks any browser-originated (CSRF/CORS) request even with a valid token, and answers no preflight', async () => {
    for (const origin of ['https://evil.example', 'http://localhost:3000', 'http://127.0.0.1:1234', 'null']) {
      const r = await raw({ path: '/mcp', method: 'POST', headers: { ...good(), origin }, body: init });
      expect(r.status, origin).toBe(403);
    }
    const pre = await raw({ path: '/mcp', method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(pre.status).toBe(403);
    expect(pre.body).not.toContain('access-control');
  });
  it('rejects oversized and malformed bodies, unknown sessions and bad methods', async () => {
    expect((await raw({ path: '/mcp', method: 'POST', headers: good(), body: 'x'.repeat(5 * 1024 * 1024) }).catch(() => ({ status: 413 }))).status).toBe(413);
    expect((await raw({ path: '/mcp', method: 'POST', headers: good(), body: '{not json' })).status).toBe(400);
    expect((await raw({ path: '/mcp', method: 'POST', headers: { ...good(), 'mcp-session-id': 'bogus' }, body: init })).status).toBe(400);
    expect((await raw({ path: '/mcp', method: 'PUT', headers: good() })).status).toBe(405);
    expect((await raw({ path: '/nope', headers: good() })).status).toBe(404);
  });
});

describe('extension WebSocket', () => {
  const url = () => `ws://127.0.0.1:${stack.app.port}/ext`;
  const open = (opts: { origin?: string; headers?: Record<string, string> }) => new WebSocket(url(), { origin: opts.origin, headers: opts.headers });
  const rejectedStatus = (ws: WebSocket) => new Promise<number | 'opened'>((res) => { ws.once('unexpected-response', (_q, r) => res(r.statusCode!)); ws.once('open', () => res('opened')); ws.once('error', () => res(0)); });

  it('refuses web-page origins and a missing origin', async () => {
    for (const origin of ['https://evil.example', 'http://127.0.0.1:8099', undefined, 'null']) {
      const s = await rejectedStatus(open({ origin }));
      expect(s, String(origin)).not.toBe('opened');
    }
  });
  it('refuses foreign Host headers', async () => {
    expect(await rejectedStatus(open({ origin: 'moz-extension://x', headers: { Host: 'evil.com' } }))).toBe(403);
  });
  it('closes with 4401 on a wrong token and never registers a browser', async () => {
    const ws = open({ origin: 'moz-extension://x' });
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify(hello('browser-wrong001', 'W'.repeat(43))));
    expect(await closed(ws)).toBe(4401);
    expect(stack.app.ctx.hub.listPeers().find((p) => p.browserId === 'browser-wrong001')).toBeUndefined();
    expect(stack.app.ctx.hub.recentErrors.some((e) => e.code === 'UNAUTHORIZED')).toBe(true);
  });
  it('closes when the first message is not a valid hello', async () => {
    for (const first of ['not json', JSON.stringify({ v: 1, type: 'request', id: '1', action: 'tabs_list' }), JSON.stringify({ v: 1, type: 'hello' }), JSON.stringify({ v: 99, type: 'hello', token: TOKEN })]) {
      const ws = open({ origin: 'moz-extension://x' });
      await new Promise((r) => ws.once('open', r));
      ws.send(first);
      expect(await closed(ws), first).toBe(4400);
    }
  });
  it('closes idle unauthenticated sockets', async () => {
    const ws = open({ origin: 'chrome-extension://abc' });
    await new Promise((r) => ws.once('open', r));
    expect(await closed(ws)).toBe(4408);
  });
  it('enforces message size limits and rejects binary frames', async () => {
    const h = await startHub();
    try {
      const f = await connectFake(h.port, { id: 'browser-big00001' });
      await waitFor(() => h.hub.listPeers()[0]?.connected);
      f.ws.send(Buffer.alloc(20 * 1024 * 1024, 1));
      expect(await closed(f.ws)).toBe(1009);
      const g = await connectFake(h.port, { id: 'browser-bin00001' });
      await waitFor(() => h.hub.listPeers().some((p) => p.browserId === 'browser-bin00001' && p.connected));
      g.ws.send(Buffer.from([1, 2, 3]));
      expect(await closed(g.ws)).toBe(4400);
    } finally { await h.close(); }
  });
  it('drops sockets that keep sending invalid messages', async () => {
    const h = await startHub();
    try {
      const f = await connectFake(h.port);
      await waitFor(() => h.hub.listPeers()[0]?.connected);
      for (let i = 0; i < 7; i++) f.ws.send(JSON.stringify({ v: 1, type: 'event', event: 'evil', data: i }));
      expect(await closed(f.ws)).toBe(4400);
    } finally { await h.close(); }
  });
  it('does not let a page-controlled extension message forge tool results for other ids', async () => {
    const h = await startHub();
    try {
      const f = await connectFake(h.port);
      f.onRequest = () => ({ ok: 1 });
      await waitFor(() => h.hub.listPeers()[0]?.connected);
      f.ws.send(JSON.stringify({ v: 1, type: 'response', id: 'guess-1', ok: true, result: 'forged' }));
      expect(await h.hub.call('tabs_list', {})).toEqual({ ok: 1 });
    } finally { await h.close(); }
  });
  it('limits concurrent unauthenticated connections', async () => {
    const h = await startHub();
    try {
      const sockets = Array.from({ length: 12 }, () => new WebSocket(`ws://127.0.0.1:${h.port}/ext`, { origin: 'moz-extension://x' }));
      const outcomes = await Promise.all(sockets.map((ws) => rejectedStatus2(ws)));
      expect(outcomes.filter((o) => o === 429).length).toBeGreaterThanOrEqual(1);
      sockets.forEach((s) => s.terminate());
    } finally { await h.close(); }
  });
  it('only serves the extension socket on /ext', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${stack.app.port}/other`, { origin: 'moz-extension://x' });
    const out = await new Promise((res) => { ws.once('error', () => res('error')); ws.once('open', () => res('open')); });
    expect(out).toBe('error');
  });
});

const rejectedStatus2 = (ws: WebSocket) => new Promise<number | 'opened'>((res) => { ws.once('unexpected-response', (_q, r) => res(r.statusCode!)); ws.once('open', () => res('opened')); ws.once('error', () => res(0)); });
