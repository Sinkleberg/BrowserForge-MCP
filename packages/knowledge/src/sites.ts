import fs from 'node:fs';
import path from 'node:path';
import { scrubLabel } from './traces.js';

/** What can go wrong (or is worth knowing) on a site. Free text goes in `detail`, never page content. */
export const PITFALL_KINDS = ['needs_account', 'captcha', 'login_wall', 'file_in_popup', 'custom_dropdown', 'iframe_form', 'listing_gone', 'blocked_by_site', 'note'] as const;
export type PitfallKind = (typeof PITFALL_KINDS)[number];

export interface Pitfall {
  kind: PitfallKind;
  detail: string;
  count: number;
  lastSeen: number;
}

export interface SiteKnowledge {
  host: string;
  visits: number;
  firstSeen: number;
  lastSeen: number;
  /** Ids of the latest recorded flows on this site. */
  flows: string[];
  outcomes: { success: number; failure: number };
  pitfalls: Pitfall[];
}

const MAX_PITFALLS = 20;
const MAX_FLOWS = 8;
const DETAIL_MAX = 200;
export const CARD_MAX = 600;

/** One JSON file per host under <dir>/sites. Small, private, and safe to delete: it only ever speeds agents up. */
export class SiteStore {
  private readonly dir: string;
  private readonly cache = new Map<string, SiteKnowledge>();

  constructor(dir: string, private readonly now: () => number = Date.now, private readonly enabled = true) {
    this.dir = path.join(dir, 'sites');
    if (enabled) fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private static key(host: string): string | undefined {
    const h = host.toLowerCase().trim();
    return /^[a-z0-9]([a-z0-9.-]{0,120})$/.test(h) ? h : undefined;
  }

  static hostOf(urlOrHost: string): string | undefined {
    try {
      return SiteStore.key(new URL(/^[a-z]+:\/\//i.test(urlOrHost) ? urlOrHost : `https://${urlOrHost}`).host);
    } catch {
      return undefined;
    }
  }

  private file(host: string): string {
    return path.join(this.dir, `${host}.json`);
  }

  get(host: string): SiteKnowledge | undefined {
    const key = SiteStore.key(host);
    if (!key) return undefined;
    const hit = this.cache.get(key);
    if (hit) return hit;
    try {
      const k = JSON.parse(fs.readFileSync(this.file(key), 'utf8')) as SiteKnowledge;
      if (k.host === key && Array.isArray(k.pitfalls)) {
        this.cache.set(key, k);
        return k;
      }
    } catch {
      /* unknown or damaged: start fresh */
    }
    return undefined;
  }

  private update(host: string, fn: (k: SiteKnowledge) => void): void {
    const key = SiteStore.key(host);
    if (!this.enabled || !key) return;
    const k = this.get(key) ?? { host: key, visits: 0, firstSeen: this.now(), lastSeen: this.now(), flows: [], outcomes: { success: 0, failure: 0 }, pitfalls: [] };
    fn(k);
    k.lastSeen = this.now();
    this.cache.set(key, k);
    try {
      fs.writeFileSync(this.file(key), JSON.stringify(k, null, 1), { mode: 0o600 });
    } catch {
      /* knowledge is best effort */
    }
  }

  visit(host: string): void {
    this.update(host, (k) => void k.visits++);
  }

  outcome(host: string, verdict: 'success' | 'failure'): void {
    this.update(host, (k) => void k.outcomes[verdict]++);
  }

  addFlow(host: string, id: string): void {
    this.update(host, (k) => {
      if (k.flows.includes(id)) return;
      k.flows.push(id);
      if (k.flows.length > MAX_FLOWS) k.flows.splice(0, k.flows.length - MAX_FLOWS);
    });
  }

  /** Remember something about the site. The same kind+detail again only counts up. */
  note(host: string, kind: PitfallKind, detail = ''): void {
    const text = scrubLabel(detail).slice(0, DETAIL_MAX);
    this.update(host, (k) => {
      const hit = k.pitfalls.find((p) => p.kind === kind && p.detail === text);
      if (hit) {
        hit.count++;
        hit.lastSeen = this.now();
        return;
      }
      k.pitfalls.push({ kind, detail: text, count: 1, lastSeen: this.now() });
      if (k.pitfalls.length > MAX_PITFALLS) {
        k.pitfalls.sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen);
        k.pitfalls.length = MAX_PITFALLS;
      }
    });
  }

  list(): { host: string; visits: number; lastSeen: number; pitfalls: number; flows: number }[] {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => this.get(f.slice(0, -5)))
        .filter((k): k is SiteKnowledge => k !== undefined)
        .map((k) => ({ host: k.host, visits: k.visits, lastSeen: k.lastSeen, pitfalls: k.pitfalls.length, flows: k.flows.length }))
        .sort((a, b) => b.lastSeen - a.lastSeen);
    } catch {
      return [];
    }
  }

  /**
   * A few lines an agent reads when it lands on the site: past results, known obstacles, flows it can replay.
   * Returns undefined for a host with nothing worth saying, so ordinary navigation results stay unchanged.
   */
  card(host: string): string | undefined {
    const k = this.get(host);
    if (!k) return undefined;
    const parts: string[] = [];
    if (k.outcomes.success || k.outcomes.failure) parts.push(`past results: ${k.outcomes.success} ok, ${k.outcomes.failure} failed`);
    const worst = [...k.pitfalls].sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen).slice(0, 4);
    for (const p of worst) parts.push(`${p.kind.replace(/_/g, ' ')}${p.detail ? `: ${p.detail}` : ''}${p.count > 1 ? ` (x${p.count})` : ''}`);
    if (k.flows.length) parts.push(`${k.flows.length} recorded flow${k.flows.length > 1 ? 's' : ''} (flow_list site=${k.host})`);
    if (!parts.length) return undefined;
    const text = `${k.host}, seen ${k.visits}x: ${parts.join('; ')}`;
    return text.length <= CARD_MAX ? text : `${text.slice(0, CARD_MAX - 1)}…`;
  }
}
