import fs from 'node:fs';
import path from 'node:path';
import { Bm25Index } from './bm25.js';

export type StepOp = 'CLICK' | 'TYPE' | 'SELECT' | 'SCROLL_UP' | 'SCROLL_DOWN' | 'WAIT' | 'DONE' | 'BLOCKED';
export type Label = 'good' | 'bad';
/** Who judged a run: the page itself (checked automatically), the calling agent, or the human. An automatic label never replaces the other two. */
export type LabelBy = 'auto' | 'agent' | 'human';
/** Who chose a step: replayed from memory, the small decision model (Laya), the local LLM (Qwen), or the person themselves ('human', from "Record me"). 'model' is the pre-cascade name for Qwen. */
export type StepSource = 'memory' | 'laya' | 'qwen' | 'model' | 'human';

/**
 * One decision of the local decider. Deliberately contains NO input values and no page text beyond short control labels:
 * traces are both retrieval memory and a future fine-tuning dataset, and must be safe to keep and to share.
 */
export interface TraceStep {
  runId: string;
  at: number;
  promptVersion: string;
  host: string;
  pathPattern: string;
  goal: string;
  inputKeys: string[];
  /** Visible controls as "n | kind | label" rows (no refs, labels scrubbed). */
  table: string[];
  /** The short step history the decider was shown. */
  recent: string[];
  /** Short hash of the page's headings/status text (the text itself is never stored). Tells "before submit" from "after submit". */
  notesKey: string;
  decision: { op: StepOp; target: number | null; targetLabel: string | null; inputKey: string | null; confidence: number };
  result: { ok: boolean; pageChanged: boolean; approvalDenied: boolean; error?: string };
  source: StepSource;
}

interface LabelLine {
  label: { runId: string; value: Label; note?: string; at: number; by?: LabelBy };
}

/** Collapse ids so /messages/t/12345 and /messages/t/98765 are the same page. */
export function pathPattern(pathname: string): string {
  return pathname
    .split('/')
    .map((s) => (/^\d{2,}$/.test(s) || /^[0-9a-f]{8,}$/i.test(s) || /^[\w-]{20,}$/.test(s) ? '{id}' : s))
    .join('/')
    .slice(0, 120);
}

/** Labels can contain personal text (names, emails); keep the shape, drop the specifics. */
export function scrubLabel(s: string): string {
  return s
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '{email}')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '{number}')
    .slice(0, 60);
}

export function normalizeGoal(goal: string): string {
  return goal.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** Order-independent fingerprint of what the decider saw, used to recognise an identical situation. */
export function stateKey(step: Pick<TraceStep, 'host' | 'pathPattern' | 'goal' | 'table' | 'notesKey'>): string {
  const labels = step.table.map((r) => r.split(' | ').slice(1, 3).join(':')).sort().join('|');
  return `${step.host}|${step.pathPattern}|${normalizeGoal(step.goal)}|${step.notesKey}|${labels}`;
}

export class TraceStore {
  private readonly stepsFile: string;
  private readonly labelsFile: string;
  private readonly steps: TraceStep[] = [];
  private readonly labels = new Map<string, { value: Label; note?: string; by: LabelBy }>();
  private readonly index = new Bm25Index<TraceStep>();

  constructor(dir: string, private readonly opts: { enabled: boolean; retentionDays: number } = { enabled: true, retentionDays: 90 }) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.stepsFile = path.join(dir, 'traces.jsonl');
    this.labelsFile = path.join(dir, 'labels.jsonl');
    this.load();
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }

  private load(): void {
    const cutoff = Date.now() - this.opts.retentionDays * 86_400_000;
    const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
    for (const line of read(this.stepsFile)) {
      try {
        const s = JSON.parse(line) as TraceStep;
        if (s.at >= cutoff) this.push(s);
      } catch {
        /* skip a torn line */
      }
    }
    for (const line of read(this.labelsFile)) {
      try {
        const { label } = JSON.parse(line) as LabelLine;
        if (label.at >= cutoff) this.setLabel(label.runId, label.value, label.by ?? 'agent', label.note);
      } catch {
        /* skip */
      }
    }
    // Rewrite without expired lines so retention actually deletes data.
    if (this.opts.enabled) fs.writeFileSync(this.stepsFile, this.steps.map((s) => JSON.stringify(s) + '\n').join(''), { mode: 0o600 });
  }

  private push(s: TraceStep): void {
    this.steps.push(s);
    const text = `${s.goal} ${s.table.join(' ')} ${s.decision.targetLabel ?? ''} ${s.decision.op}`;
    this.index.add(`${s.runId}:${this.steps.length}`, text, s);
  }

  record(step: TraceStep): void {
    if (!this.opts.enabled) return;
    this.push(step);
    fs.appendFileSync(this.stepsFile, JSON.stringify(step) + '\n', { mode: 0o600 });
  }

  /** Apply a label unless a stronger judge already set one (auto < agent < human, later wins within the same level). */
  private setLabel(runId: string, value: Label, by: LabelBy, note?: string): boolean {
    const rank = { auto: 0, agent: 1, human: 2 } as const;
    const cur = this.labels.get(runId);
    if (cur && rank[cur.by] > rank[by]) return false;
    this.labels.set(runId, { value, note, by });
    return true;
  }

  label(runId: string, value: Label, note?: string, by: LabelBy = 'agent'): boolean {
    if (!this.steps.some((s) => s.runId === runId)) return false;
    if (!this.setLabel(runId, value, by, note)) return true; // a stronger label stands; nothing to record
    fs.appendFileSync(this.labelsFile, JSON.stringify({ label: { runId, value, note: note?.slice(0, 300), at: Date.now(), by } } satisfies LabelLine) + '\n', { mode: 0o600 });
    return true;
  }

  labelBy(runId: string): LabelBy | undefined {
    return this.labels.get(runId)?.by;
  }

  labelOf(runId: string): Label | undefined {
    return this.labels.get(runId)?.value;
  }

  /** A step counts as a usable example when it worked and its run was not judged bad. */
  private usable(s: TraceStep): boolean {
    return s.result.ok && s.source !== 'memory' && s.decision.op !== 'BLOCKED' && this.labelOf(s.runId) !== 'bad';
  }

  /** Past successful decisions on the same site (and page type) that look like the current situation. */
  similar(q: { host: string; pathPattern: string; goal: string; table: string[] }, k = 3): TraceStep[] {
    const query = `${q.goal} ${q.table.join(' ')}`;
    return this.index
      .search(query, k * 4, (s) => s.host === q.host && this.usable(s))
      .map((h) => h.payload)
      .sort((a, b) => Number(b.pathPattern === q.pathPattern) - Number(a.pathPattern === q.pathPattern))
      .slice(0, k);
  }

  /** The decision to reuse without calling the model, if this exact situation succeeded the same way at least `minRepeats` times. */
  remembered(step: Pick<TraceStep, 'host' | 'pathPattern' | 'goal' | 'table' | 'notesKey'>, minRepeats = 3): TraceStep['decision'] | null {
    const key = stateKey(step);
    const tally = new Map<string, { n: number; d: TraceStep['decision'] }>();
    for (const s of this.steps) {
      if (!this.usable(s) || stateKey(s) !== key) continue;
      const sig = `${s.decision.op}|${s.decision.targetLabel}|${s.decision.inputKey}`;
      const t = tally.get(sig) ?? { n: 0, d: s.decision };
      t.n++;
      tally.set(sig, t);
    }
    const best = [...tally.values()].sort((a, b) => b.n - a.n)[0];
    return best && best.n >= minRepeats ? best.d : null;
  }

  /** Chat-format JSONL for LoRA fine-tuning (Unsloth / axolotl "messages"), from runs labelled good. */
  exportDataset(render: (s: TraceStep) => { system: string; user: string; assistant: string }, minLabel: 'good' | 'any' = 'good'): string[] {
    return this.steps
      .filter((s) => s.result.ok && s.source !== 'memory' && (minLabel === 'any' ? this.labelOf(s.runId) !== 'bad' : this.labelOf(s.runId) === 'good'))
      .map((s) => {
        const { system, user, assistant } = render(s);
        return JSON.stringify({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }, { role: 'assistant', content: assistant }] });
      });
  }

  /** Per-decider scorecard so the supervising agent can see which model is pulling its weight. */
  stats(): { steps: number; runs: number; labelledGood: number; labelledBad: number; byDecider: Record<string, { steps: number; ok: number; inGoodRuns: number; inBadRuns: number }> } {
    const runs = new Set(this.steps.map((s) => s.runId));
    const vals = [...runs].map((r) => this.labelOf(r));
    const byDecider: Record<string, { steps: number; ok: number; inGoodRuns: number; inBadRuns: number }> = {};
    for (const s of this.steps) {
      const k = s.source === 'model' ? 'qwen' : s.source;
      const b = (byDecider[k] ??= { steps: 0, ok: 0, inGoodRuns: 0, inBadRuns: 0 });
      b.steps++;
      if (s.result.ok) b.ok++;
      const l = this.labelOf(s.runId);
      if (l === 'good') b.inGoodRuns++;
      if (l === 'bad') b.inBadRuns++;
    }
    return { steps: this.steps.length, runs: runs.size, labelledGood: vals.filter((v) => v === 'good').length, labelledBad: vals.filter((v) => v === 'bad').length, byDecider };
  }
}
