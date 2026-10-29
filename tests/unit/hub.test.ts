import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@browserforge/browser-protocol';
import { NEVER, connectFake, startHub } from '../helpers/fake-extension.js';
import { waitFor } from '../helpers/stack.js';

let h: Awaited<ReturnType<typeof startHub>>;
afterEach(async () => { await h?.close(); });

describe('BrowserHub request handling', () => {
  it('correlates concurrent requests by id', async () => {
    h = await startHub();
    const f = await connectFake(h.port);
    f.onRequest = (r) => ({ echo: r.args.amount });
    await waitFor(() => h.hub.listPeers()[0]?.connected);
    const out = await Promise.all([1, 2, 3, 4, 5].map((n) => h.hub.call('scroll', { amount: n })));
    expect(out).toEqual([1, 2, 3, 4, 5].map((n) => ({ echo: n })));
  });

  it('validates arguments before anything reaches the browser', async () => {
    h = await startHub();
    const f = await connectFake(h.port);
    await waitFor(() => h.hub.listPeers()[0]?.connected);
    await expect(h.hub.call('click', {})).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    await expect(h.hub.call('eval_js', { code: 'alert(1)' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    await expect(h.hub.call('navigate', { url: 5 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    expect(f.received.filter((m) => m.type === 'request')).toHaveLength(0);
  });

  it('times out silent browsers and tells the browser to cancel', async () => {
    h = await startHub();
    const f = await connectFake(h.port);
    f.onRequest = () => NEVER;
    await waitFor(() => h.hub.listPeers()[0]?.connected);
    await expect(h.hub.call('tabs_list', {}, { timeoutMs: 200 })).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
    await waitFor(() => f.received.some((m) => m.type === 'cancel'));
    expect(h.hub.listPeers()[0]!.inFlight).toBe(0);
  });

  it('cancels on abort', async () => {
    h = await startHub();
    const f = await connectFake(h.port);
    f.onRequest = () => NEVER;
    await waitFor(() => h.hub.listPeers()[0]?.connected);
    const ac = new AbortController();
    const p = h.hub.call('tabs_list', {}, { signal: ac.signal, timeoutMs: 5000 });
    await waitFor(() => f.received.some((m) => m.type === 'request'));
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
    await waitFor(() => f.received.some((m) => m.type === 'cancel'));
  });

  it('maps extension errors to structured errors', async () => {
    h = await startHub();
    const f = await connectFake(h.port);
    f.onRequest = () => { throw { code: 'ELEMENT_NOT_FOUND', message: 'nope' }; };
    await waitFor(() => h.hub.listPeers()[0]?.connected);
    await expect(h.hub.call('tabs_list', {})).rejects.toMatchObject({ code: 'ELEMENT_NOT_FOUND', message: 'nope' });
  });

  it('ignores duplicate and unsolicited responses', async () => {
    h = await startHub();
    const f = await connectFake(h.port);
    f.onRequest = (r) => { setTimeout(() => f.ws.send(JSON.stringify({ v: 1, type: 'response', id: r.id, ok: true, result: 'second' })), 20); return 'first'; };
    await waitFor(() => h.hub.listPeers()[0]?.connected);
    expect(await h.hub.call('tabs_list', {})).toBe('first');
    f.ws.send(JSON.stringify({ v: 1, type: 'response', id: 'never-asked', ok: true, result: 1 }));
    await new Promise((r) => setTimeout(r, 100));
    expect(h.hub.listPeers()[0]!.connected).toBe(true);
  });

  it('fails in-flight requests with NOT_CONNECTED when the browser does not come back', async () => {
    h = await startHub({ graceMs: 150 });
    const f = await connectFake(h.port);
    f.onRequest = () => NEVER;
    await waitFor(() => h.hub.listPeers()[0]?.connected);
    const p = h.hub.call('tabs_list', {}, { timeoutMs: 5000 });
    await waitFor(() => f.received.some((m) => m.type === 'request'));
    f.ws.terminate();
    await expect(p).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await expect(h.hub.call('tabs_list', {})).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  it('resends in-flight requests after a quick reconnect (same browser id)', async () => {
    h = await startHub({ graceMs: 3000 });
    const f1 = await connectFake(h.port, { id: 'browser-reconn1' });
    f1.onRequest = () => NEVER;
    await waitFor(() => h.hub.listPeers()[0]?.connected);
    const p = h.hub.call('tabs_list', {}, { timeoutMs: 8000 });
    await waitFor(() => f1.received.some((m) => m.type === 'request'));
    f1.ws.terminate();
    const f2 = await connectFake(h.port, { id: 'browser-reconn1' });
    f2.onRequest = (r) => ({ resumed: r.action });
    expect(await p).toEqual({ resumed: 'tabs_list' });
    expect(h.hub.listPeers()).toHaveLength(1);
    expect(h.hub.listPeers()[0]!.reconnects).toBe(1);
  });

  it('requires browserId when several browsers are connected, and routes by it', async () => {
    h = await startHub();
    const a = await connectFake(h.port, { id: 'browser-aaaa0001', kind: 'firefox' });
    const b = await connectFake(h.port, { id: 'browser-bbbb0002', kind: 'chrome' });
    a.onRequest = () => 'from-a';
    b.onRequest = () => 'from-b';
    await waitFor(() => h.hub.listPeers().length === 2 && h.hub.listPeers().every((p) => p.connected));
    await expect(h.hub.call('tabs_list', {})).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    expect(await h.hub.call('tabs_list', {}, { browserId: 'browser-bbbb0002' })).toBe('from-b');
    expect(await h.hub.call('tabs_list', {}, { browserId: 'browser-aaaa0001' })).toBe('from-a');
  });

  it('emergencyStop cancels everything in flight', async () => {
    h = await startHub();
    const f = await connectFake(h.port);
    f.onRequest = (r) => (r.action === 'stop' ? { stopped: true } : NEVER);
    await waitFor(() => h.hub.listPeers()[0]?.connected);
    const pending = [h.hub.call('tabs_list', {}, { timeoutMs: 5000 }), h.hub.call('tabs_active', {}, { timeoutMs: 5000 })].map((p) => p.catch((e) => e.code));
    await waitFor(() => f.received.filter((m) => m.type === 'request').length === 2);
    expect(await h.hub.emergencyStop()).toEqual({ cancelled: 2 });
    expect(await Promise.all(pending)).toEqual(['STOPPED', 'STOPPED']);
    expect(f.received.some((m) => m.type === 'request' && m.action === 'stop')).toBe(true);
  });

  it('records network events and activity pushed by the extension', async () => {
    h = await startHub();
    const f = await connectFake(h.port);
    await waitFor(() => h.hub.listPeers()[0]?.connected);
    const seen: any[] = [];
    h.hub.on('network', (_id, d) => seen.push(d));
    f.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'event', event: 'network', data: { requestId: '1', tabId: 1, url: 'https://a.b/c', method: 'GET', startedAt: 1 } }));
    f.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'event', event: 'activity', data: { at: 1, action: 'click', summary: 's', outcome: 'ok' } }));
    await waitFor(() => seen.length === 1);
    expect(h.hub.getActivity()).toHaveLength(1);
  });
});
