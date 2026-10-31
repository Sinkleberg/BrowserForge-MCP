import fs from 'node:fs';
import path from 'node:path';
import { FlowBuilder, parseFlow, type Flow, type RawAction } from '@browserforge/flows';
import type { HumanData } from './human.js';

const IDLE_MS = 30 * 60_000;
const MAX_STEPS = 300;
const UNSAVED_DAYS = 30;
/** After the person submits, a pause this long means the next thing they do is a new task. */
const HUMAN_TASK_GAP_MS = 20_000;
const ID_RE = /^[a-z0-9][a-z0-9.-]{0,100}\/\d{8}T\d{6}(-\d+)?$/;

type Part = Record<string, unknown>;
interface Current {
  builder: FlowBuilder;
  site: string;
  lastAt: number;
  /** The last recorded step was a consequential one (a submit, a send): that task is finished. */
  finished: boolean;
}

export interface FlowSummary {
  id: string;
  site: string;
  name: string;
  createdAt: string;
  saved: boolean;
  steps: number;
  params: number;
  consequential: number;
}

const hostOf = (url: unknown): string | undefined => {
  try {
    return new URL(String(url)).host.toLowerCase().replace(/[^a-z0-9.-]/g, '-') || undefined;
  } catch {
    return undefined;
  }
};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * Turns the actions agents perform (through any tool, workflow or browser_run_goal) into one flow per site.
 * It only sees what the page reported about the elements it touched; typed values become parameters, and values of
 * password-like fields never reach the flow at all.
 */
export class FlowRecorder {
  private readonly current = new Map<string, Current>();
  /** While > 0 (a flow is being replayed) nothing is recorded, so replays do not create new flows. */
  private suspended = 0;
  enabled: boolean;

  constructor(private readonly dir: string, opts: { enabled: boolean }, private readonly now: () => number = Date.now, private readonly onWorthKeeping?: (site: string, id: string) => void) {
    this.enabled = opts.enabled;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.cleanup();
  }

  suspend<T>(fn: () => Promise<T>): Promise<T> {
    this.suspended++;
    return fn().finally(() => this.suspended--);
  }

  /** Called for every successful state-changing browser action. */
  handle(browserId: string, action: string, args: Record<string, unknown>, result: unknown, parts: Part[] | undefined): void {
    if (!this.enabled || this.suspended > 0) return;
    const res = (result ?? {}) as Record<string, unknown>;
    let url: string | undefined;
    const steps: RawAction[] = [];
    // The page the tab shows (frames only know their own address); older extensions may not send it.
    const partUrl = (p: Part) => str(p.pageUrl) ?? str(p.url);

    if (action === 'navigate') {
      url = str(res.url);
    } else if (parts?.length) {
      for (const p of parts) {
        const base = { locator: p.locator as RawAction['locator'], fieldLabel: str(p.fieldLabel), sensitive: p.sensitive === true, consequential: p.consequential === true, frameUrl: str(p.frameUrl), url: partUrl(p) };
        url = url ?? partUrl(p);
        if (action === 'click') steps.push({ ...base, action: 'click' });
        else if (action === 'type') {
          steps.push({ ...base, action: 'fill', value: str(args.text) });
          if (args.submit === true) steps.push({ ...base, action: 'press', key: 'Enter', consequential: true });
        } else if (action === 'fill_field') steps.push({ ...base, action: 'fill', value: str(args.value) });
        else if (action === 'select_option') steps.push({ ...base, action: 'select', value: str(res.label) ?? str(res.selected) ?? str(args.label) ?? str(args.value), custom: p.custom === true });
        else if (action === 'press_key') steps.push({ ...base, action: 'press', key: str(args.key) ?? 'Enter' });
        else if (action === 'fill_form') {
          const kind = str(p.kind) ?? 'fill';
          steps.push({ ...base, action: kind === 'upload' ? 'upload' : kind === 'click' ? 'click' : 'fill', value: str(p.value) });
        }
      }
    }
    if (action !== 'navigate' && !steps.length) return;

    const site = hostOf(url);
    if (!site) return;
    const cur = this.currentFor(browserId, site, (c) => action === 'navigate' && c.finished);
    if (action === 'navigate') cur.builder.navigate(url!, this.now());
    else {
      for (const s of steps) cur.builder.add(s, this.now());
      if (steps.some((x) => x.consequential && (x.action === 'click' || x.action === 'press'))) cur.finished = true; // stays set: clicking around the confirmation page does not reopen the task
    }
    cur.lastAt = this.now();
    this.write(cur);
  }

  /**
   * Something the person did themselves (only while "Record me" is on). Kept in its own flow per browser, marked source "human", so it never
   * mixes with an agent's steps. The value is only present when the person chose to store values; sensitive fields never have one.
   */
  handleHuman(browserId: string, d: HumanData): { flowId: string; site: string; param?: string; isNew: boolean } | undefined {
    if (!this.enabled) return undefined;
    const site = hostOf(d.url);
    if (!site) return undefined;
    const key = `human:${browserId}`;
    const before = this.current.get(key);
    const cur = this.currentFor(key, site, (c) => c.finished && this.now() - c.lastAt > HUMAN_TASK_GAP_MS, 'human');
    const sensitive = d.sensitive === true;
    const raw: RawAction = {
      action: d.kind,
      locator: d.locator as RawAction['locator'],
      fieldLabel: d.fieldLabel,
      sensitive,
      consequential: d.consequential === true,
      custom: d.custom === true,
      frameUrl: d.frameUrl,
      url: d.url,
      ...(d.kind === 'press' ? { key: d.key ?? 'Enter' } : {}),
      ...(!sensitive && (d.kind === 'fill' || d.kind === 'select') && d.value !== undefined ? { value: d.value } : {}),
    };
    const step = cur.builder.add(raw, this.now());
    if (step.consequential && (d.kind === 'click' || d.kind === 'press')) cur.finished = true;
    cur.lastAt = this.now();
    this.write(cur);
    return { flowId: cur.builder.flow.id, site, param: step.param, isNew: !before || before.builder.flow.id !== cur.builder.flow.id };
  }

  /** Save a flow built elsewhere (a consolidation) under a fresh id on its site. */
  store(flow: Flow): Flow {
    const stamp = new Date(this.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
    let id = `${flow.site}/${stamp}`;
    for (let i = 2; fs.existsSync(this.fileOf(id)); i++) id = `${flow.site}/${stamp}-${i}`;
    const out = { ...flow, id };
    const file = this.fileOf(id);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(out, null, 1), { mode: 0o600 });
    this.worthKeeping(out.site, id);
    return out;
  }

  /** Note how the task of the flow being recorded turned out (found by looking at the page after its last submit). */
  setOutcome(browserId: string, outcome: 'success' | 'failure'): void {
    const cur = this.current.get(browserId);
    if (!cur) return;
    cur.builder.flow.outcome = outcome;
    this.write(cur);
    if (outcome === 'success') this.worthKeeping(cur.site, cur.builder.flow.id);
  }

  /** Tell the site's knowledge about a flow that is worth replaying: named, merged, or one that ended well. */
  private worthKeeping(site: string, id: string): void {
    try {
      this.onWorthKeeping?.(site, id);
    } catch {
      /* a listener must never break recording */
    }
  }

  private currentFor(browserId: string, site: string, startNew: (cur: Current) => boolean, source?: 'human'): Current {
    const cur = this.current.get(browserId);
    // One flow per task: a submit ends it, and the next thing that starts a task opens a new one.
    if (cur && cur.site === site && !startNew(cur) && this.now() - cur.lastAt < IDLE_MS && cur.builder.flow.steps.length < MAX_STEPS) return cur;
    const stamp = new Date(this.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
    let id = `${site}/${stamp}`;
    for (let i = 2; fs.existsSync(this.fileOf(id)); i++) id = `${site}/${stamp}-${i}`;
    const next: Current = { builder: new FlowBuilder({ id, site, name: site, now: new Date(this.now()) }), site, lastAt: this.now(), finished: false };
    if (source) next.builder.flow.source = source;
    this.current.set(browserId, next);
    return next;
  }

  private fileOf(id: string): string {
    if (!ID_RE.test(id)) throw new Error('Invalid flow id');
    return path.join(this.dir, `${id}.json`);
  }

  private write(cur: Current): void {
    const file = this.fileOf(cur.builder.flow.id);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(cur.builder.flow, null, 1), { mode: 0o600 });
  }

  // ---------- reading and managing ----------
  private all(): Flow[] {
    const out: Flow[] = [];
    for (const site of fs.existsSync(this.dir) ? fs.readdirSync(this.dir) : []) {
      const d = path.join(this.dir, site);
      if (!fs.statSync(d).isDirectory()) continue;
      for (const f of fs.readdirSync(d)) {
        if (!f.endsWith('.json')) continue;
        try {
          out.push(parseFlow(JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))));
        } catch {
          /* skip a damaged file */
        }
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  list(site?: string): FlowSummary[] {
    return this.all()
      .filter((f) => !site || f.site === site.toLowerCase())
      .map((f) => ({ id: f.id, site: f.site, name: f.name, createdAt: f.createdAt, saved: f.saved === true, steps: f.steps.length, params: f.params.length, consequential: f.steps.filter((s) => s.consequential).length }));
  }

  get(id: string): Flow | undefined {
    try {
      return parseFlow(JSON.parse(fs.readFileSync(this.fileOf(id), 'utf8')));
    } catch {
      return undefined;
    }
  }

  save(id: string, name: string): Flow | undefined {
    const f = this.get(id);
    if (!f) return undefined;
    f.name = name.slice(0, 80);
    f.saved = true;
    fs.writeFileSync(this.fileOf(id), JSON.stringify(f, null, 1), { mode: 0o600 });
    // If this was the live recording, keep appending to the renamed flow.
    for (const cur of this.current.values()) if (cur.builder.flow.id === id) Object.assign(cur.builder.flow, { name: f.name, saved: true });
    this.worthKeeping(f.site, id);
    return f;
  }

  delete(id: string): boolean {
    const file = this.fileOf(id);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    for (const [k, cur] of this.current) if (cur.builder.flow.id === id) this.current.delete(k);
    return true;
  }

  /** Unnamed recordings are scratch work: drop them after a while. */
  private cleanup(): void {
    const cutoff = this.now() - UNSAVED_DAYS * 86_400_000;
    for (const f of this.all()) {
      if (!f.saved && Date.parse(f.createdAt) < cutoff) {
        try {
          fs.unlinkSync(this.fileOf(f.id));
        } catch {
          /* already gone */
        }
      }
    }
  }
}
