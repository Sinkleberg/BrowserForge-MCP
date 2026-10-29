import { BrowserForgeError, LIMITS, clamp } from '@browserforge/shared';
import { matchesFilter } from './filter.js';
import type { Capture, CapturedRequest, Page, RequestFilter } from './types.js';

export const LIVE_CAPTURE = 'live';

export interface StoreOptions {
  maxRequestsPerCapture?: number;
  maxCaptures?: number;
  /** Drop requests older than this (ms). 0 = keep until evicted by size. */
  retentionMs?: number;
  now?: () => number;
}

/** In-memory only. Nothing here is ever written to disk unless the user explicitly exports. */
export class NetworkStore {
  private captures = new Map<string, Capture>();
  private seq = 0;
  private opts: Required<StoreOptions>;

  constructor(opts: StoreOptions = {}) {
    this.opts = { maxRequestsPerCapture: LIMITS.maxCapturedRequests, maxCaptures: 20, retentionMs: 0, now: Date.now, ...opts };
    this.captures.set(LIVE_CAPTURE, { id: LIVE_CAPTURE, label: 'Live browser traffic', source: 'live', createdAt: this.opts.now(), requests: [] });
  }

  setLimits(limits: { maxRequestsPerCapture?: number; retentionMs?: number }): void {
    if (limits.maxRequestsPerCapture) this.opts.maxRequestsPerCapture = clamp(limits.maxRequestsPerCapture, 10, 50_000);
    if (limits.retentionMs !== undefined) this.opts.retentionMs = Math.max(0, limits.retentionMs);
  }

  getLimits(): { maxRequestsPerCapture: number; retentionMs: number } {
    return { maxRequestsPerCapture: this.opts.maxRequestsPerCapture, retentionMs: this.opts.retentionMs };
  }

  nextId(): string {
    return `r_${String(++this.seq).padStart(6, '0')}`;
  }

  createCapture(label: string, source: Capture['source'], idHint?: string): Capture {
    if (this.captures.size >= this.opts.maxCaptures) {
      // Evict the oldest non-live capture.
      const victim = [...this.captures.values()].filter((c) => c.id !== LIVE_CAPTURE).sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!victim) throw new BrowserForgeError('LIMIT_EXCEEDED', 'Too many captures');
      this.captures.delete(victim.id);
    }
    const id = idHint ?? `${source}_${Math.random().toString(36).slice(2, 8)}`;
    const cap: Capture = { id, label, source, createdAt: this.opts.now(), requests: [] };
    this.captures.set(id, cap);
    return cap;
  }

  getCapture(id: string = LIVE_CAPTURE): Capture {
    const c = this.captures.get(id);
    if (!c) throw new BrowserForgeError('NOT_FOUND', `Unknown capture '${id}'`);
    this.prune(c);
    return c;
  }

  listCaptures(): { id: string; label: string; source: string; createdAt: string; requestCount: number }[] {
    return [...this.captures.values()].map((c) => ({ id: c.id, label: c.label, source: c.source, createdAt: new Date(c.createdAt).toISOString(), requestCount: c.requests.length }));
  }

  /** Add a request (live or imported). Evicts oldest entries beyond the cap. */
  add(captureId: string, r: Omit<CapturedRequest, 'id' | 'captureId'>): CapturedRequest {
    const cap = this.getCapture(captureId);
    const full: CapturedRequest = { ...r, id: this.nextId(), captureId: cap.id };
    cap.requests.push(full);
    if (cap.requests.length > this.opts.maxRequestsPerCapture) cap.requests.splice(0, cap.requests.length - this.opts.maxRequestsPerCapture);
    return full;
  }

  /** Update an in-flight live request by browser request id (events may arrive in several pieces). */
  upsertLive(browserId: string, browserRequestId: string, patch: Omit<CapturedRequest, 'id' | 'captureId'>): CapturedRequest {
    const cap = this.getCapture(LIVE_CAPTURE);
    const key = `${browserId}:${browserRequestId}`;
    const existing = this.liveIndex.get(key);
    if (existing && cap.requests.includes(existing)) {
      Object.assign(existing, patch);
      return existing;
    }
    const added = this.add(LIVE_CAPTURE, patch);
    this.liveIndex.set(key, added);
    if (this.liveIndex.size > this.opts.maxRequestsPerCapture * 2) {
      for (const k of [...this.liveIndex.keys()].slice(0, this.opts.maxRequestsPerCapture)) this.liveIndex.delete(k);
    }
    return added;
  }
  private liveIndex = new Map<string, CapturedRequest>();

  query(captureId: string | undefined, filter: RequestFilter, opts: { cursor?: string; limit?: number; text?: string } = {}): Page<CapturedRequest> {
    const cap = this.getCapture(captureId);
    const limit = clamp(opts.limit ?? LIMITS.defaultPageSize, 1, LIMITS.maxPageSize);
    const offset = opts.cursor ? Number.parseInt(opts.cursor, 10) : 0;
    if (!Number.isFinite(offset) || offset < 0) throw new BrowserForgeError('INVALID_ARGUMENTS', 'Invalid cursor');
    const needle = opts.text?.toLowerCase();
    const matched = cap.requests.filter((r) => matchesFilter(r, filter) && (!needle || searchable(r).includes(needle)));
    const items = matched.slice(offset, offset + limit);
    const next = offset + limit < matched.length ? String(offset + limit) : undefined;
    return { items, total: matched.length, nextCursor: next };
  }

  /** All matching requests, unpaginated (for exports and analysis). */
  queryAll(captureId: string | undefined, filter: RequestFilter): CapturedRequest[] {
    return this.getCapture(captureId).requests.filter((r) => matchesFilter(r, filter));
  }

  get(id: string): CapturedRequest {
    for (const c of this.captures.values()) {
      const r = c.requests.find((x) => x.id === id);
      if (r) return r;
    }
    throw new BrowserForgeError('NOT_FOUND', `Unknown request '${id}'`);
  }

  clear(captureId?: string): number {
    if (!captureId) {
      let n = 0;
      for (const c of this.captures.values()) {
        n += c.requests.length;
        c.requests = [];
      }
      for (const id of [...this.captures.keys()]) if (id !== LIVE_CAPTURE) this.captures.delete(id);
      this.liveIndex.clear();
      return n;
    }
    const cap = this.getCapture(captureId);
    const n = cap.requests.length;
    if (cap.id === LIVE_CAPTURE) {
      cap.requests = [];
      this.liveIndex.clear();
    } else this.captures.delete(cap.id);
    return n;
  }

  private prune(c: Capture): void {
    if (!this.opts.retentionMs || c.source !== 'live') return;
    const cutoff = this.opts.now() - this.opts.retentionMs;
    if (c.requests.length && c.requests[0]!.startedAt < cutoff) c.requests = c.requests.filter((r) => r.startedAt >= cutoff);
  }
}

function searchable(r: CapturedRequest): string {
  return `${r.method} ${r.url} ${r.requestBody ?? ''} ${r.responseBodyBase64 ? '' : (r.responseBody ?? '')}`.toLowerCase();
}
