import { randomUUID } from 'node:crypto';
import { BrowserForgeError } from '@browserforge/shared';

/** In-memory registry of analysis reports so later tools can reference them by id. */
export class AnalysisStore<T = unknown> {
  private items = new Map<string, { id: string; createdAt: number; report: T }>();
  constructor(private max = 50) {}
  put(report: T): string {
    const id = `an_${randomUUID().slice(0, 8)}`;
    this.items.set(id, { id, createdAt: Date.now(), report });
    if (this.items.size > this.max) this.items.delete(this.items.keys().next().value as string);
    return id;
  }
  get(id: string): T {
    const it = this.items.get(id);
    if (!it) throw new BrowserForgeError('NOT_FOUND', `Unknown analysis '${id}'. Run api_analyze_traffic first.`);
    return it.report;
  }
  list(): { id: string; createdAt: string }[] {
    return [...this.items.values()].map((i) => ({ id: i.id, createdAt: new Date(i.createdAt).toISOString() }));
  }
}
