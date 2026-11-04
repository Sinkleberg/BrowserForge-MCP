import fs from 'node:fs';
import path from 'node:path';
import { FlowBuilder, isBrowseOnly, parseFlow, registrable, scrubFlow, scrubText, scrubUrl, type Flow, type FlowOutcome, type OutcomeBy, type RawAction } from '@browserforge/flows';
import type { HumanData } from './human.js';
import { valueFree } from './skill.js';

const IDLE_MS = 30 * 60_000;
const MAX_STEPS = 300;
const UNSAVED_DAYS = 30;
/** Cleanup runs this often while the server is up (and once at start). */
const CLEAN_EVERY_MS = 6 * 3_600_000;
/** A recording left unfinished with almost nothing in it is dropped after this many days. */
const INCOMPLETE_DAYS = 3;
const MAX_UNSAVED_PER_SITE = 50;
/** After the person submits, a pause this long means the next thing they do is a new task. */
const HUMAN_TASK_GAP_MS = 20_000;
/** A host change this soon after a click or key press is the site redirecting, not a new task. */
const REDIRECT_MS = 5_000;
const ID_RE = /^[a-z0-9][a-z0-9.-]{0,100}\/\d{8}T\d{6}(-\d+)?$/;
/** Pages that are only ever browsed (mail, feeds, search listings): never worth a flow. `host` or `host/pathPrefix`. */
export const DEFAULT_IGNORE = ['mail.google.com', 'accounts.google.com', 'www.linkedin.com/feed', 'www.careerjet.it', 'jobviewtrack.com'];

type Part = Record<string, unknown>;
interface Current {
  builder: FlowBuilder;
  site: string;
  lastAt: number;
  /** The last recorded step was a consequential one (a submit, a send): that task is finished. */
  finished: boolean;
  /** The flow file exists on disk. Flows stay in memory until they hold a step that changes something. */
  written: boolean;
  /** When the last click or key press happened (a host change right after it is a redirect). */
  lastActionAt?: number;
  /** Identifies the job or page this task is about (an id in the address); another one means another task. */
  jobKey?: string;
  /** Bracketed by flow_task_begin / flow_task_end: it is not split by hosts, submits or page changes, only by idle time. */
  task?: { id: string; ended: boolean };
  /** A task begun without a start address: the host of its first action becomes the flow's site. */
  siteUnset?: boolean;
}

export interface TaskSpec {
  name: string;
  startUrl?: string;
  /** The task's parameters (name -> value). A typed value equal to one of them is named after it and not stored. Kept in memory only. */
  params?: Record<string, string>;
  dryRun?: boolean;
  tags?: string[];
}

const tabOf = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const taskKey = (browserId: string, tabId?: number): string => (tabId === undefined ? browserId : `${browserId}#${tabId}`);

/** The id inside a job or page address (`?ID=105614`, `/j/1E5B7EE864`, `/jobs/junior-dev-39329/it`), if there is one. */
export function jobKeyOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const ids = [...u.searchParams].filter(([k]) => /^(id|job_?id|jid|jk|gh_jid|currentjobid|requisition_?id|req_?id|offer_?id|dm)$/i.test(k)).map(([k, v]) => `${k.toLowerCase()}=${v}`).sort();
    const seg = u.pathname.split('/').find((s) => /\d{3,}/.test(s));
    const key = [...ids, ...(seg ? [seg.toLowerCase()] : [])].join('|');
    return key || undefined;
  } catch {
    return undefined;
  }
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
  outcome?: Flow['outcome'];
  taskName?: string;
  hosts?: string[];
  runs?: { count: number; ok: number };
  source?: 'agent' | 'human';
}

/** What flow_prune found (and, with apply, did) for one recorded flow. */
export interface PruneItem {
  id: string;
  action: 'delete' | 'scrub' | 'flag';
  reason: string;
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
  private readonly ignore: string[];
  private readonly storeValues: boolean;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Open tasks by id, and tasks begun without a known tab (they attach to the first tab that acts for the browser). */
  private readonly tasks = new Map<string, Current>();
  private readonly pending = new Map<string, Current>();

  constructor(private readonly dir: string, opts: { enabled: boolean; ignore?: string[]; storeValues?: boolean }, private readonly now: () => number = Date.now, private readonly onWorthKeeping?: (site: string, id: string) => void) {
    this.enabled = opts.enabled;
    this.storeValues = opts.storeValues === true;
    this.ignore = (opts.ignore ?? DEFAULT_IGNORE).map((p) => p.toLowerCase());
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.cleanup();
    this.timer = setInterval(() => this.cleanup(), CLEAN_EVERY_MS);
    this.timer.unref?.(); // a long-running server tidies up; a script or test is never kept alive by it
  }

  /** True for addresses that are never recorded (see DEFAULT_IGNORE): `host` matches that host, `host/prefix` also needs the path to start with the prefix. */
  isIgnored(url: string | undefined): boolean {
    if (!url) return false;
    try {
      const u = new URL(url);
      const host = u.host.toLowerCase();
      return this.ignore.some((p) => {
        const slash = p.indexOf('/');
        return slash < 0 ? host === p : host === p.slice(0, slash) && u.pathname.toLowerCase().startsWith(p.slice(slash));
      });
    } catch {
      return false;
    }
  }

  suspend<T>(fn: () => Promise<T>): Promise<T> {
    this.suspended++;
    return fn().finally(() => this.suspended--);
  }

  /** Called for every successful state-changing browser action. */
  handle(browserId: string, action: string, args: Record<string, unknown>, result: unknown, parts: Part[] | undefined): void {
    if (!this.enabled || this.suspended > 0) return;
    if (parts?.some((p) => p.incognito === true)) return; // private windows are never recorded
    const res = (result ?? {}) as Record<string, unknown>;
    // One current flow per tab: agents working in several tabs of one browser must not interleave their steps.
    const tabId = tabOf(args.tabId) ?? tabOf(res.tabId) ?? parts?.map((p) => tabOf(p.tabId)).find((x) => x !== undefined);
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
        const state = p.state === 'checked' || p.state === 'unchecked' ? p.state : undefined;
        if (action === 'click') steps.push({ ...base, action: 'click', ...(state ? { state } : {}) });
        else if (action === 'type') {
          steps.push({ ...base, action: 'fill', value: str(args.text) });
          if (args.submit === true) steps.push({ ...base, action: 'press', key: 'Enter', consequential: true });
        } else if (action === 'fill_field') steps.push({ ...base, action: 'fill', value: str(args.value) });
        else if (action === 'select_option') steps.push({ ...base, action: 'select', value: str(res.label) ?? str(res.selected) ?? str(args.label) ?? str(args.value), custom: p.custom === true });
        else if (action === 'press_key') steps.push({ ...base, action: 'press', key: str(args.key) ?? 'Enter' });
        else if (action === 'fill_form') {
          const kind = str(p.kind) ?? 'fill';
          steps.push({ ...base, action: kind === 'upload' ? 'upload' : kind === 'click' ? 'click' : 'fill', value: str(p.value), ...(kind === 'click' && state ? { state } : {}) });
        }
      }
    }
    if (action !== 'navigate' && !steps.length) return;

    const site = hostOf(url);
    if (!site || this.isIgnored(url)) return;
    const jobKey = jobKeyOf(url);
    // An agent that opens another job's page is starting another task, even on the same site.
    const startNew = (c: Current) => action === 'navigate' && (c.finished || (!!jobKey && !!c.jobKey && jobKey !== c.jobKey));
    const key = taskKey(browserId, tabId);
    this.attachTask(browserId, key, parts);
    const cur = this.currentFor(key, site, startNew);
    if (cur.siteUnset) {
      // A task begun without an address belongs to the site of its first action.
      cur.siteUnset = false;
      cur.site = site;
      cur.builder.flow.site = site;
      cur.builder.flow.id = `${site}/${cur.builder.flow.id.split('/')[1] ?? ''}`;
    }
    if (action === 'navigate') {
      // Before anything has happened, only the last address matters (redirect chains, a page opened twice).
      if (cur.builder.flow.steps.every((s) => s.action === 'navigate')) cur.builder.flow.steps.length = 0;
      cur.builder.navigate(url!, this.now());
    } else {
      for (const s of steps) cur.builder.add(s, this.now());
      if (steps.some((x) => x.action === 'click' || x.action === 'press')) cur.lastActionAt = this.now();
      if (steps.some((x) => x.consequential && (x.action === 'click' || x.action === 'press'))) cur.finished = true; // stays set: clicking around the confirmation page does not reopen the task
    }
    if (jobKey && !cur.jobKey) cur.jobKey = jobKey;
    if (site !== cur.site) {
      const hosts = (cur.builder.flow.hosts ??= [cur.site]);
      if (!hosts.includes(site)) hosts.push(site);
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
    if (!site || this.isIgnored(d.url)) return undefined;
    const key = taskKey(`human:${browserId}`, tabOf(d.tabId));
    const before = this.current.get(key);
    const cur = this.currentFor(key, site, (c) => c.finished && this.now() - c.lastAt > HUMAN_TASK_GAP_MS, 'human');
    const sensitive = d.sensitive === true;
    const raw: RawAction = {
      action: d.kind,
      locator: { ...d.locator, ...(d.nth !== undefined ? { nth: d.nth } : {}), ...(d.shadow?.length ? { shadow: d.shadow } : {}) } as RawAction['locator'],
      fieldLabel: d.fieldLabel,
      ...(d.state ? { state: d.state } : {}),
      sensitive,
      consequential: d.consequential === true,
      custom: d.custom === true,
      frameUrl: d.frameUrl,
      url: d.url,
      ...(d.kind === 'press' ? { key: d.key ?? 'Enter' } : {}),
      ...(!sensitive && (d.kind === 'fill' || d.kind === 'select') && d.value !== undefined ? { value: d.value, keepValue: true } : {}), // a value only arrives when the person switched on "Store my values"
    };
    const step = cur.builder.add(raw, this.now());
    if (step.consequential && (d.kind === 'click' || d.kind === 'press')) cur.finished = true;
    cur.lastAt = this.now();
    this.write(cur);
    return { flowId: cur.builder.flow.id, site, param: step.param, isNew: before !== cur };
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

  /** Add a flow that came with a shared skill, under its own id (the caller checks it is not taken). Never keeps values. */
  adopt(flow: Flow): Flow {
    const out = { ...valueFree(flow), saved: true };
    const file = this.fileOf(out.id);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(out, null, 1), { mode: 0o600 });
    return out;
  }

  /** Note how the task of the flow being recorded turned out (found by looking at the page after its last submit). */
  setOutcome(browserId: string, outcome: 'success' | 'failure', tabId?: number, by: OutcomeBy = 'auto'): void {
    const cur = this.currentOf(browserId, tabId);
    if (!cur) return;
    const f = cur.builder.flow;
    // The latest check wins (an agent fixes a form and submits again), except that what the agent itself said when it ended the task is final.
    if (f.outcomeBy === 'agent' && by !== 'agent') return;
    f.outcome = outcome;
    f.outcomeBy = by;
    this.write(cur);
    if (outcome === 'success' && cur.written) this.worthKeeping(cur.site, f.id);
  }

  /**
   * Start a named task in a tab (or in whichever tab acts next, if none is given). Until it ends, the task is one flow: it is not split when
   * the site moves between hosts, after a submit, or when another page opens. Returns the id to pass to endTask.
   */
  beginTask(browserId: string, tabId: number | undefined, spec: TaskSpec): string {
    for (const [tid, c] of this.tasks) {
      // A task nobody ended is closed when it has been idle for good: it did not finish.
      if (this.now() - c.lastAt > IDLE_MS) {
        this.finalize(c);
        this.tasks.delete(tid);
      }
    }
    const key = taskKey(browserId, tabId);
    const startUrl = spec.startUrl ? scrubUrl(spec.startUrl) : undefined;
    const site = hostOf(startUrl) ?? 'task';
    const old = this.current.get(key);
    if (old) this.finalize(old);
    const cur = this.newCurrent(site, undefined, spec.params);
    const id = `t${this.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    cur.task = { id, ended: false };
    cur.siteUnset = !startUrl;
    cur.builder.flow.name = spec.name.slice(0, 80);
    cur.builder.flow.task = { name: spec.name.slice(0, 80), ...(spec.dryRun ? { dryRun: true } : {}), ...(spec.tags?.length ? { tags: spec.tags.slice(0, 10) } : {}), ...(startUrl ? { startUrl } : {}) };
    if (tabId === undefined) this.pending.set(browserId, cur);
    else this.current.set(key, cur);
    this.tasks.set(id, cur);
    return id;
  }

  /** Finish a task and say how it went. The agent's word outranks every automatic guess. A task that never did anything worth keeping leaves no file. */
  endTask(taskId: string, outcome: FlowOutcome, opts: { note?: string; save?: boolean } = {}): { flowId?: string; written: boolean; steps: number } | undefined {
    const cur = this.tasks.get(taskId);
    if (!cur) return undefined;
    const f = cur.builder.flow;
    cur.task!.ended = true;
    f.outcome = outcome;
    f.outcomeBy = 'agent';
    if (opts.note && f.task) f.task.note = scrubText(opts.note).slice(0, 200);
    if (opts.save) f.saved = true;
    this.write(cur);
    if (outcome === 'success' && cur.written) this.worthKeeping(cur.site, f.id);
    this.tasks.delete(taskId);
    for (const [b, c] of this.pending) if (c === cur) this.pending.delete(b);
    return { ...(cur.written ? { flowId: f.id } : {}), written: cur.written, steps: f.steps.length };
  }

  /** Note one replay of a flow (flow_run): how many times it ran, how often it worked, and where it last broke. */
  recordRun(id: string, ok: boolean, failedStep?: number): void {
    const f = this.get(id);
    if (!f) return;
    f.runs = { count: (f.runs?.count ?? 0) + 1, ok: (f.runs?.ok ?? 0) + (ok ? 1 : 0), lastAt: new Date(this.now()).toISOString(), ...(!ok && failedStep !== undefined ? { lastFailedStep: failedStep } : f.runs?.lastFailedStep !== undefined ? { lastFailedStep: f.runs.lastFailedStep } : {}) };
    for (const cur of this.current.values()) if (cur.builder.flow.id === id) cur.builder.flow.runs = f.runs;
    fs.writeFileSync(this.fileOf(id), JSON.stringify(f, null, 1), { mode: 0o600 });
  }

  /** A task begun without a tab attaches to the first tab that acts; a tab opened by a task's tab within 10 s joins that task. */
  private attachTask(browserId: string, key: string, parts: Part[] | undefined): void {
    const waiting = this.pending.get(browserId);
    if (waiting) {
      const old = this.current.get(key);
      if (old && old !== waiting) this.finalize(old);
      this.current.set(key, waiting);
      this.pending.delete(browserId);
      return;
    }
    if (this.current.has(key)) return;
    const opener = parts?.map((p) => tabOf(p.openerTabId)).find((x) => x !== undefined);
    const parent = opener === undefined ? undefined : this.current.get(taskKey(browserId, opener));
    if (parent?.task && !parent.task.ended && this.now() - parent.lastAt < 10_000) this.current.set(key, parent);
  }

  /** The flow being recorded for this tab; without a known tab, the most recently touched one of the browser. */
  private currentOf(browserId: string, tabId?: number): Current | undefined {
    const exact = this.current.get(taskKey(browserId, tabId));
    if (exact || tabId !== undefined) return exact ?? this.current.get(browserId);
    let best: Current | undefined;
    for (const [k, c] of this.current) if ((k === browserId || k.startsWith(`${browserId}#`)) && (!best || c.lastAt > best.lastAt)) best = c;
    return best;
  }

  /** Tell the site's knowledge about a flow that is worth replaying: named, merged, or one that ended well. */
  private worthKeeping(site: string, id: string): void {
    try {
      this.onWorthKeeping?.(site, id);
    } catch {
      /* a listener must never break recording */
    }
  }

  /** Same task? The same site, a sibling host of it (joblink.allibo.com -> am.allibo.com), or a redirect right after a click. */
  private sameTask(cur: Current, site: string): boolean {
    if (cur.site === site || registrable(cur.site) === registrable(site)) return true;
    return !cur.finished && cur.lastActionAt !== undefined && this.now() - cur.lastActionAt < REDIRECT_MS;
  }

  private currentFor(key: string, site: string, startNew: (cur: Current) => boolean, source?: 'human'): Current {
    const cur = this.current.get(key);
    const alive = !!cur && this.now() - cur.lastAt < IDLE_MS && cur.builder.flow.steps.length < MAX_STEPS;
    // A named task stays one flow until it ends (or goes idle); otherwise a submit ends a task and the next thing that starts one opens a new flow.
    if (cur?.task && !cur.task.ended && alive) return cur;
    if (cur && !cur.task?.ended && alive && this.sameTask(cur, site) && !startNew(cur)) return cur;
    if (cur) this.finalize(cur);
    const next = this.newCurrent(site, source);
    this.current.set(key, next);
    return next;
  }

  /** A new in-memory flow. Its id is a placeholder until it is first written (then made unique on disk). */
  private newCurrent(site: string, source?: 'human', hints?: Record<string, string>): Current {
    const stamp = new Date(this.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
    const next: Current = { builder: new FlowBuilder({ id: `${site}/${stamp}`, site, name: site, now: new Date(this.now()), storeValues: this.storeValues, ...(hints ? { hints } : {}) }), site, lastAt: this.now(), finished: false, written: false };
    if (source) next.builder.flow.source = source;
    return next;
  }

  /** A flow that is replaced or left idle without ending in a submit did not finish its task. */
  private finalize(cur: Current): void {
    const f = cur.builder.flow;
    if (!cur.written || f.outcome !== undefined || f.steps.some((s) => s.consequential)) return;
    f.outcome = 'incomplete';
    this.write(cur);
  }

  private fileOf(id: string): string {
    if (!ID_RE.test(id)) throw new Error('Invalid flow id');
    return path.join(this.dir, `${id}.json`);
  }

  /** Only flows where something was filled, chosen, uploaded, pressed or submitted are kept; a visit that just looked around is not a flow. */
  private worthWriting(cur: Current): boolean {
    return !isBrowseOnly(cur.builder.flow);
  }

  private write(cur: Current): void {
    if (!cur.written) {
      if (!this.worthWriting(cur)) return;
      const f = cur.builder.flow;
      const base = f.id;
      for (let i = 2; fs.existsSync(this.fileOf(f.id)); i++) f.id = `${base}-${i}`;
      cur.written = true;
    }
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
      .map((f) => ({
        id: f.id, site: f.site, name: f.name, createdAt: f.createdAt, saved: f.saved === true, steps: f.steps.length, params: f.params.length, consequential: f.steps.filter((s) => s.consequential).length,
        ...(f.outcome ? { outcome: f.outcome } : {}), ...(f.task ? { taskName: f.task.name } : {}), ...(f.hosts ? { hosts: f.hosts } : {}),
        ...(f.runs ? { runs: { count: f.runs.count, ok: f.runs.ok } } : {}), ...(f.source ? { source: f.source } : {}),
      }));
  }

  /** Tasks recorded successfully at least `min` times: worth merging into one clean flow with flow_consolidate. */
  hints(min = 3): { site: string; taskName?: string; count: number; ids: string[]; suggest: string }[] {
    const groups = new Map<string, Flow[]>();
    for (const f of this.all()) {
      if (f.outcome !== 'success' || f.derivedFrom) continue; // merged flows are already the clean version
      const k = `${f.site}\u0000${f.task?.name ?? ''}`;
      groups.set(k, [...(groups.get(k) ?? []), f]);
    }
    return [...groups.values()].filter((g) => g.length >= min).map((g) => ({ site: g[0]!.site, ...(g[0]!.task ? { taskName: g[0]!.task.name } : {}), count: g.length, ids: g.slice(0, 10).map((f) => f.id), suggest: 'flow_consolidate' }));
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

  /**
   * Unnamed recordings are scratch work. Never touched: saved flows, flows that ended in success, and flows being recorded right now.
   * Dropped: unnamed ones after 30 days, unfinished ones with almost nothing in them after 3 days, and the oldest beyond 50 per site.
   */
  private cleanup(): void {
    const DAY = 86_400_000;
    const live = new Set([...this.current.values()].map((c) => c.builder.flow.id));
    const kept = new Map<string, Flow[]>();
    const drop = (f: Flow) => {
      try {
        fs.unlinkSync(this.fileOf(f.id));
      } catch {
        /* already gone */
      }
    };
    for (const f of this.all()) {
      if (f.saved || f.outcome === 'success' || live.has(f.id)) continue;
      const age = this.now() - Date.parse(f.createdAt);
      const actions = f.steps.filter((s) => s.action !== 'navigate').length;
      if (age > UNSAVED_DAYS * DAY || (f.outcome === 'incomplete' && actions < 3 && age > INCOMPLETE_DAYS * DAY)) drop(f);
      else kept.set(f.site, [...(kept.get(f.site) ?? []), f]);
    }
    for (const flows of kept.values()) for (const f of flows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(MAX_UNSAVED_PER_SITE)) drop(f);
  }

  /**
   * Tidy the flows already on disk: delete recordings that only browsed (or were on an ignored site), scrub personal values and tokens out of the rest,
   * and flag flows that mix several jobs. Saved flows, successes and flows with replays are never deleted. Without `apply` nothing changes: it is a report.
   */
  prune(opts: { site?: string; apply: boolean; keepValues?: boolean }): PruneItem[] {
    const items: PruneItem[] = [];
    const live = new Set([...this.current.values()].map((c) => c.builder.flow.id));
    for (const f of this.all()) {
      if (opts.site && f.site !== opts.site.toLowerCase()) continue;
      if (live.has(f.id)) continue;
      const precious = f.saved === true || f.outcome === 'success' || (f.runs?.count ?? 0) > 0;
      const first = f.steps.find((s) => s.url)?.url;
      if (!precious && (isBrowseOnly(f) || this.isIgnored(first))) {
        items.push({ id: f.id, action: 'delete', reason: this.isIgnored(first) ? 'site is on the ignore list' : 'only browsing: nothing filled, chosen, uploaded or submitted' });
        if (opts.apply) {
          try {
            fs.unlinkSync(this.fileOf(f.id));
          } catch {
            /* already gone */
          }
        }
        continue;
      }
      const jobs = new Set(f.steps.map((s) => jobKeyOf(s.url)).filter(Boolean));
      if (jobs.size > 1) items.push({ id: f.id, action: 'flag', reason: `mixes ${jobs.size} different jobs or pages: record each task on its own (flow_task_begin)` });
      const copy = JSON.parse(JSON.stringify(f)) as Flow;
      const changes = scrubFlow(copy, { keepValues: opts.keepValues });
      if (changes > 0) {
        items.push({ id: f.id, action: 'scrub', reason: `${changes} personal value${changes === 1 ? '' : 's'} or token${changes === 1 ? '' : 's'} removed` });
        if (opts.apply) fs.writeFileSync(this.fileOf(f.id), JSON.stringify(copy, null, 1), { mode: 0o600 });
      }
    }
    return items;
  }

  /** Stop the periodic cleanup (tests, shutdown). */
  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
