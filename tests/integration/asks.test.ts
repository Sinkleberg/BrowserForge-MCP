import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, waitFor, type Stack } from '../helpers/stack.js';
import { connectFake, type Fake } from '../helpers/fake-extension.js';

let stack: Stack;
let fake: Fake;

beforeAll(async () => {
  stack = await startStack();
  fake = await connectFake(stack.app.port, { id: 'br-asks-test', token: stack.app.ctx.config.extensionToken });
  await waitFor(() => stack.app.ctx.hub.listPeers().length > 0);
});
afterAll(async () => {
  fake?.close();
  await stack.close();
});

const press = (data: Record<string, unknown>) => fake.ws.send(JSON.stringify({ v: 1, type: 'event', event: 'ask', data: { at: Date.now(), ...data } }));
const get = (query: string, token = stack.app.ctx.config.mcpToken) => fetch(`http://127.0.0.1:${stack.app.port}/asks${query}`, { headers: { authorization: `Bearer ${token}` } });

describe('Ask the agent', () => {
  it('reaches the agent as a request with the tab and the note, once', async () => {
    press({ tabId: 12, url: 'https://jobs.test/apply', title: 'Apply', note: 'fill with my profile' });
    await waitFor(() => stack.app.ctx.asks.list().length > 0);

    const first = (await stack.call('browser_pending_requests')).data;
    expect(first.count).toBe(1);
    expect(first.requests[0]).toMatchObject({ tabId: 12, note: 'fill with my profile', browserId: 'br-asks-test' });
    // The page's address and title are marked as untrusted page data; only the note is the person's own words.
    expect(first.requests[0].page).toMatchObject({ untrustedWebContent: true, data: { url: 'https://jobs.test/apply', title: 'Apply' } });

    expect((await stack.call('browser_pending_requests')).data.count).toBe(0);
    expect((await stack.call('browser_pending_requests', { includeClaimed: true })).data.count).toBe(1);
  });

  it('long-polls for new presses over HTTP and needs the token', async () => {
    const waiting = get('?after=1&wait=5').then((r) => r.json() as Promise<{ asks: { tabId: number }[] }>);
    setTimeout(() => press({ tabId: 13, url: 'https://jobs.test/second' }), 50);
    expect((await waiting).asks.map((a) => a.tabId)).toEqual([13]);

    expect((await get('?after=0', 'wrong-token')).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${stack.app.port}/asks`)).status).toBe(401);
  });

  it('ignores a press with an invalid shape', async () => {
    const before = stack.app.ctx.asks.list().length;
    press({ tabId: 'nope', url: 'https://jobs.test/x' });
    await new Promise((r) => setTimeout(r, 100));
    expect(stack.app.ctx.asks.list().length).toBe(before);
  });
});
