import { randomUUID } from 'node:crypto';
import { BrowserForgeError, type Logger } from '@browserforge/shared';

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export type RunStatus = 'created' | 'running' | 'paused' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';

export interface WorkflowStepSpec {
  tool: string;
  args: Record<string, unknown>;
  label?: string;
  /** Ask the human (via the browser extension) before running this step. */
  approval?: string;
  continueOnError?: boolean;
}

interface StepState extends WorkflowStepSpec {
  index: number;
  status: StepStatus;
  result?: string;
  error?: { code: string; message: string };
  startedAt?: string;
  finishedAt?: string;
}

export interface WorkflowState {
  id: string;
  name: string;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  currentStep?: number;
  steps: StepState[];
}

export interface WorkflowDeps {
  /** Validates a step before the workflow is stored. Throws BrowserForgeError. */
  validateStep: (spec: WorkflowStepSpec) => void;
  invoke: (tool: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
  /** Resolves true when the human approves. Must go through a channel the agent cannot answer. */
  requestApproval: (title: string, detail: string | undefined, signal: AbortSignal) => Promise<boolean>;
  logger: Logger;
}

interface Internal {
  state: WorkflowState;
  abort: AbortController;
  pauseRequested: boolean;
  resumeWaiters: (() => void)[];
}

const MAX_STEPS = 100;
const MAX_WORKFLOWS = 50;
const MAX_RESULT_CHARS = 4000;

function summarizeResult(v: unknown): string {
  // Never keep image payloads; keep a short JSON preview of everything else.
  const text = JSON.stringify(v, (k, val) => (k === 'data' && typeof val === 'string' && val.length > 2000 ? `[${val.length} chars]` : val)) ?? '';
  return text.length > MAX_RESULT_CHARS ? text.slice(0, MAX_RESULT_CHARS) + '…' : text;
}

export class WorkflowEngine {
  private flows = new Map<string, Internal>();
  constructor(private deps: WorkflowDeps) {}

  create(name: string, steps: WorkflowStepSpec[]): WorkflowState {
    if (steps.length === 0 || steps.length > MAX_STEPS) throw new BrowserForgeError('INVALID_ARGUMENTS', `A workflow needs 1-${MAX_STEPS} steps`);
    steps.forEach((s) => this.deps.validateStep(s));
    if (this.flows.size >= MAX_WORKFLOWS) this.flows.delete(this.flows.keys().next().value as string);
    const state: WorkflowState = {
      id: `wf_${randomUUID().slice(0, 8)}`,
      name,
      status: 'created',
      createdAt: new Date().toISOString(),
      steps: steps.map((s, index) => ({ ...s, index, status: 'pending' as StepStatus })),
    };
    this.flows.set(state.id, { state, abort: new AbortController(), pauseRequested: false, resumeWaiters: [] });
    return state;
  }

  list(): { id: string; name: string; status: RunStatus }[] {
    return [...this.flows.values()].map((f) => ({ id: f.state.id, name: f.state.name, status: f.state.status }));
  }

  get(id: string): WorkflowState {
    const f = this.flows.get(id);
    if (!f) throw new BrowserForgeError('NOT_FOUND', `Unknown workflow '${id}'`);
    return f.state;
  }

  /** Starts execution in the background and returns immediately. */
  run(id: string): WorkflowState {
    const f = this.internal(id);
    if (f.state.status !== 'created') throw new BrowserForgeError('INVALID_ARGUMENTS', `Workflow is ${f.state.status}; create a new one to run again`);
    f.state.status = 'running';
    f.state.startedAt = new Date().toISOString();
    void this.loop(f).catch((err) => {
      this.deps.logger.error('workflow crashed', { error: err instanceof Error ? err : String(err) });
      f.state.status = 'failed';
    });
    return f.state;
  }

  pause(id: string): WorkflowState {
    const f = this.internal(id);
    if (f.state.status === 'running' || f.state.status === 'awaiting_approval') f.pauseRequested = true;
    else throw new BrowserForgeError('INVALID_ARGUMENTS', `Workflow is ${f.state.status}, cannot pause`);
    return f.state;
  }

  resume(id: string): WorkflowState {
    const f = this.internal(id);
    f.pauseRequested = false;
    const waiters = f.resumeWaiters.splice(0);
    waiters.forEach((w) => w());
    if (f.state.status === 'paused') f.state.status = 'running';
    return f.state;
  }

  cancel(id: string): WorkflowState {
    const f = this.internal(id);
    f.abort.abort();
    f.resumeWaiters.splice(0).forEach((w) => w());
    if (['created', 'running', 'paused', 'awaiting_approval'].includes(f.state.status)) f.state.status = 'cancelled';
    return f.state;
  }

  cancelAll(): void {
    for (const f of this.flows.values()) if (['running', 'paused', 'awaiting_approval'].includes(f.state.status)) this.cancel(f.state.id);
  }

  private internal(id: string): Internal {
    const f = this.flows.get(id);
    if (!f) throw new BrowserForgeError('NOT_FOUND', `Unknown workflow '${id}'`);
    return f;
  }

  private async loop(f: Internal): Promise<void> {
    const { state } = f;
    for (const step of state.steps) {
      if (f.abort.signal.aborted) return this.finish(f, 'cancelled');
      if (f.pauseRequested) {
        state.status = 'paused';
        await new Promise<void>((resolve) => f.resumeWaiters.push(resolve));
        if (f.abort.signal.aborted) return this.finish(f, 'cancelled');
        state.status = 'running';
      }
      state.currentStep = step.index;
      step.status = 'running';
      step.startedAt = new Date().toISOString();
      try {
        if (step.approval) {
          state.status = 'awaiting_approval';
          const ok = await this.deps.requestApproval(step.label ?? step.tool, step.approval, f.abort.signal);
          state.status = 'running';
          if (!ok) throw new BrowserForgeError('APPROVAL_DENIED', 'The human denied this step');
        }
        const out = await this.deps.invoke(step.tool, step.args, f.abort.signal);
        step.result = summarizeResult(out);
        step.status = 'done';
      } catch (err) {
        const code = err instanceof BrowserForgeError ? err.code : 'INTERNAL';
        step.status = 'failed';
        step.error = { code, message: err instanceof BrowserForgeError ? err.message : 'Step failed' };
        state.status = 'running';
        if (f.abort.signal.aborted) {
          step.finishedAt = new Date().toISOString();
          return this.finish(f, 'cancelled');
        }
        if (!step.continueOnError) {
          step.finishedAt = new Date().toISOString();
          for (const rest of state.steps.slice(step.index + 1)) rest.status = 'skipped';
          return this.finish(f, 'failed');
        }
      }
      step.finishedAt = new Date().toISOString();
    }
    this.finish(f, 'completed');
  }

  private finish(f: Internal, status: RunStatus): void {
    f.state.status = status;
    f.state.finishedAt = new Date().toISOString();
    f.state.currentStep = undefined;
  }
}
