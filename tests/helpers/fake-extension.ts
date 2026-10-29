import http from 'node:http';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@browserforge/browser-protocol';
import { BrowserHub } from '../../apps/mcp-server/src/hub.js';
import { createLogger } from '@browserforge/shared';

export const TOKEN = 'T'.repeat(43);

export async function startHub(opts: { graceMs?: number } = {}) {
  const hub = new BrowserHub({ extensionToken: TOKEN, serverVersion: 'test', logger: createLogger('error'), reconnectGraceMs: opts.graceMs ?? 300, helloTimeoutMs: 400 });
  const server = http.createServer((_q, s) => { s.writeHead(404); s.end(); });
  server.on('upgrade', (req, sock, head) => hub.handleUpgrade(req, sock, head));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return { hub, port, server, close: async () => { hub.close(); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); } };
}

export const hello = (id = 'browser-aaaa1111', token = TOKEN, kind: 'firefox' | 'chrome' = 'firefox') => ({
  v: PROTOCOL_VERSION, type: 'hello', token,
  browser: { kind, version: '1', id }, extension: { id: 'x', version: '1' },
  capabilities: { networkCapture: true, responseBodies: false, webSocketFrames: false, screenshots: true, fullPageScreenshots: false, downloads: true },
});

export interface Fake {
  ws: WebSocket;
  received: any[];
  /** Handler returns a result (ok) or throws {code,message} (error) or returns NEVER to stay silent. */
  onRequest?: (req: any) => unknown;
  close(): void;
}
export const NEVER = Symbol('never');

export async function connectFake(port: number, opts: { id?: string; token?: string; origin?: string; host?: string; kind?: 'firefox' | 'chrome' } = {}): Promise<Fake> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`, { origin: opts.origin ?? 'moz-extension://test-ext', headers: opts.host ? { Host: opts.host } : undefined });
  const fake: Fake = { ws, received: [], close: () => ws.close() };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    fake.received.push(m);
    if (m.type === 'request' && fake.onRequest) {
      try {
        const out = fake.onRequest(m);
        if (out === NEVER) return;
        ws.send(JSON.stringify({ v: 1, type: 'response', id: m.id, ok: true, result: out }));
      } catch (e: any) {
        ws.send(JSON.stringify({ v: 1, type: 'response', id: m.id, ok: false, error: { code: e.code ?? 'INTERNAL', message: e.message ?? 'x', retryable: false } }));
      }
    }
  });
  await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); ws.once('unexpected-response', (_q, r) => rej(Object.assign(new Error(`HTTP ${r.statusCode}`), { status: r.statusCode }))); });
  ws.send(JSON.stringify(hello(opts.id, opts.token, opts.kind)));
  return fake;
}

export const closed = (ws: WebSocket) => new Promise<number>((r) => ws.once('close', (code) => r(code)));
