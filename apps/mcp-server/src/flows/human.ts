import { createHash } from 'node:crypto';
import type { HumanActionEvent } from '@browserforge/browser-protocol';
import { pathPattern, scrubLabel, type StepOp, type TraceStep } from '@browserforge/knowledge';

export type HumanData = HumanActionEvent['data'];

const OPS: Partial<Record<HumanData['kind'], StepOp>> = { click: 'CLICK', fill: 'TYPE', select: 'SELECT' };

/** A short id for a recorded session of the person's own actions; stable for one flow, within the 40 characters the label tool allows. */
export const humanRunId = (flowId: string): string => `h-${createHash('sha1').update(flowId).digest('hex').slice(0, 12)}`;

/**
 * Turns what the person did into the same "page -> next step" example the local models are trained on: the control rows as the page
 * showed them just before the action (labels scrubbed of emails and numbers), and the step chosen. No typed value is ever part of it:
 * a typed step only names the parameter the value belongs to.
 */
export class HumanTraces {
  private readonly recent = new Map<string, string[]>();

  step(d: HumanData, flowId: string, param: string | undefined, now = Date.now()): TraceStep | undefined {
    const op = OPS[d.kind];
    if (!op || !d.table?.length || !d.row) return undefined;
    const rows = d.table.map((line) => {
      const parts = line.split(' | ');
      return parts.length >= 3 ? { n: parts[0]!, kind: parts[1]!, label: scrubLabel(parts.slice(2).join(' | ')) } : undefined;
    });
    const row = rows[d.row - 1];
    if (!row || rows.some((r) => r === undefined)) return undefined;
    let host: string;
    let path: string;
    try {
      const u = new URL(d.url);
      host = u.host;
      path = pathPattern(u.pathname);
    } catch {
      return undefined; // not a web page we can describe
    }
    const runId = humanRunId(flowId);
    const history = this.recent.get(runId) ?? [];
    const step: TraceStep = {
      runId, at: now, promptVersion: 'v1', host, pathPattern: path,
      goal: (d.task?.trim() || `demonstration on ${host}`).slice(0, 300),
      inputKeys: op === 'CLICK' || !param ? [] : [param],
      table: rows.map((r) => `${r!.n} | ${r!.kind} | ${r!.label}`),
      recent: history.slice(-5),
      notesKey: '',
      decision: { op, target: d.row, targetLabel: row.label || null, inputKey: op === 'CLICK' ? null : (param ?? null), confidence: 1 },
      result: { ok: true, pageChanged: d.consequential === true, approvalDenied: false },
      source: 'human',
    };
    history.push(`${op} ${row.kind}${row.label ? ` "${row.label.slice(0, 30)}"` : ''}${step.decision.inputKey ? ` using ${step.decision.inputKey}` : ''} -> done`);
    this.recent.set(runId, history.slice(-8));
    if (this.recent.size > 50) this.recent.delete(this.recent.keys().next().value as string);
    return step;
  }
}
