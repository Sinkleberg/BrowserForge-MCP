import { describe, expect, it } from 'vitest';
import { ExtensionMessageSchema } from '@browserforge/browser-protocol';
import { AskQueue } from '../../apps/mcp-server/src/asks.js';

const ask = (over: Record<string, unknown> = {}) => ({ at: 1, tabId: 7, url: 'https://site.test/form', title: 'Form', ...over });

describe('Ask the agent', () => {
  it('accepts the extension event and rejects a malformed one', () => {
    const ok = { v: 1, type: 'event', event: 'ask', data: ask({ note: 'fill it' }) };
    expect(ExtensionMessageSchema.safeParse(ok).success).toBe(true);
    expect(ExtensionMessageSchema.safeParse({ ...ok, data: ask({ tabId: 'x' }) }).success).toBe(false);
    expect(ExtensionMessageSchema.safeParse({ ...ok, data: ask({ note: 'x'.repeat(501) }) }).success).toBe(false);
  });

  it('lists pending requests once and keeps claimed ones out', () => {
    const q = new AskQueue();
    q.add('br1', ask());
    q.add('br1', ask({ tabId: 8 }));
    const first = q.list({ pendingOnly: true });
    expect(first.map((a) => a.tabId)).toEqual([7, 8]);
    q.claim(first.map((a) => a.id));
    expect(q.list({ pendingOnly: true })).toEqual([]);
    expect(q.list()).toHaveLength(2);
  });

  it('keeps only the latest requests', () => {
    const q = new AskQueue();
    for (let i = 0; i < 40; i++) q.add('br1', ask({ tabId: i }));
    expect(q.list()).toHaveLength(30);
    expect(q.list()[0]!.tabId).toBe(10);
  });

  it('wakes a waiting watcher as soon as a request arrives, and gives up after the wait', async () => {
    const q = new AskQueue();
    const waiting = q.waitFor(0, 2000);
    setTimeout(() => q.add('br1', ask({ note: 'go' })), 20);
    expect((await waiting).map((a) => a.note)).toEqual(['go']);
    expect(await q.waitFor(1, 30)).toEqual([]);
  });

  it('stops waiting when the watcher disconnects', async () => {
    const q = new AskQueue();
    const ac = new AbortController();
    const waiting = q.waitFor(0, 5000, ac.signal);
    ac.abort();
    expect(await waiting).toEqual([]);
  });
});
