import type { AskAgentEvent } from '@browserforge/browser-protocol';

export interface Ask {
  /** Rising number; the watcher passes the last one it saw. */
  id: number;
  at: number;
  browserId: string;
  tabId: number;
  /** Page data: untrusted. */
  url: string;
  title?: string;
  /** What the person typed, if anything. */
  note?: string;
  status: 'pending' | 'claimed';
}

const MAX_KEPT = 30;

/**
 * "Ask the agent" presses from the extension popup. An MCP server cannot wake the client by itself, so requests wait here until an
 * agent asks for them (browser_pending_requests) or a watcher (`browserforge watch`) long-polls GET /asks.
 */
export class AskQueue {
  private items: Ask[] = [];
  private nextId = 1;
  private waiters = new Set<() => void>();

  add(browserId: string, d: AskAgentEvent['data']): Ask {
    const ask: Ask = { id: this.nextId++, at: d.at, browserId, tabId: d.tabId, url: d.url, title: d.title, note: d.note, status: 'pending' };
    this.items.push(ask);
    if (this.items.length > MAX_KEPT) this.items.shift();
    for (const wake of [...this.waiters]) wake();
    return ask;
  }

  list(opts: { after?: number; pendingOnly?: boolean } = {}): Ask[] {
    return this.items.filter((a) => a.id > (opts.after ?? 0) && (!opts.pendingOnly || a.status === 'pending'));
  }

  /** Mark requests as picked up so they are not offered twice. */
  claim(ids: number[]): void {
    for (const a of this.items) if (ids.includes(a.id)) a.status = 'claimed';
  }

  /** Resolves with the requests newer than `after`, as soon as there are any, or with none once `ms` has passed. */
  async waitFor(after: number, ms: number, signal?: AbortSignal): Promise<Ask[]> {
    const now = this.list({ after });
    if (now.length || ms <= 0) return now;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); signal?.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
    return this.list({ after });
  }
}
