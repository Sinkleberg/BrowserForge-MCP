/**
 * The neutral flow format: what BrowserForge saves for every site, and what every exporter reads.
 * Plain JSON, documented in docs/FLOWS.md. Version 1.
 */
export const FLOW_VERSION = 1;

/** Several ways to find the same element, best first. Exporters try them in this order. */
export interface Locator {
  tag?: string;
  testId?: string;
  /** ARIA role and accessible name (what Playwright's getByRole and Chrome Recorder's aria/ selectors use). */
  role?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  /** Only set when the id looks hand-written, not generated (":r1:", "a1b2c3d4e5"). */
  id?: string;
  nameAttr?: string;
  text?: string;
  css?: string;
  xpath?: string;
  /** Several elements match the best strategy: this one is the nth (0-based, document order, inside open shadow roots too). */
  nth?: number;
  /** The element lives in open shadow roots: the CSS of each shadow host, outermost first. `css` is then relative to the innermost root and there is no xpath. */
  shadow?: string[];
  /** The element was disabled when it was recorded (informational: a replay waits for it to be enabled). */
  disabled?: boolean;
}

export type StepAction = 'navigate' | 'click' | 'fill' | 'select' | 'press' | 'upload';

export interface FlowStep {
  action: StepAction;
  /** navigate: the address. Other steps: the page the step happened on (informational). */
  url?: string;
  locator?: Locator;
  /** fill / select / upload: the name of the parameter that supplies the value. */
  param?: string;
  /** press: the key, e.g. "Enter". */
  key?: string;
  /** select on a custom dropdown (role=combobox): click the opener, then click the option with this text. */
  custom?: boolean;
  /** click on a checkbox or radio: the state it left the control in, so a replay only clicks when the state differs. */
  state?: 'checked' | 'unchecked';
  /** The step needed human approval in BrowserForge (submit, send, password, upload...). Exported scripts stop here unless FLOW_CONFIRM=1. */
  consequential?: boolean;
  /** The element lives in an iframe whose address contains this. */
  frame?: { url: string };
  /** Human-readable description, e.g. 'click "Submit"'. */
  label?: string;
  ts: number;
}

export interface FlowParam {
  name: string;
  /** Passwords, card numbers, tokens...: never stored with a default and never exported with one. */
  sensitive: boolean;
  /** The value that was used while recording. Absent for sensitive parameters. */
  default?: string;
  label?: string;
}

/** What an agent or script said it was doing (flow_task_begin). Values of the task's parameters are never stored here. */
export interface FlowTask {
  name: string;
  dryRun?: boolean;
  tags?: string[];
  note?: string;
  startUrl?: string;
}

/** What happened when this flow was replayed with flow_run. */
export interface FlowRuns {
  count: number;
  ok: number;
  lastAt: string;
  lastFailedStep?: number;
}

export type FlowOutcome = 'success' | 'failure' | 'incomplete' | 'dry_run';
/** Who set the outcome: the page-wording check ("auto"), browser_verify, a flow_run, or the agent that ran the task. Later ones outrank earlier ones. */
export type OutcomeBy = 'auto' | 'run' | 'verify' | 'agent';

export interface Flow {
  version: typeof FLOW_VERSION;
  id: string;
  site: string;
  name: string;
  createdAt: string;
  /** Set by flow_save; unnamed recordings are cleaned up after a while. */
  saved?: boolean;
  /** Who produced the steps: an agent's tool calls, or the person using the browser. */
  source?: 'agent' | 'human';
  /** How the task ended, judged from the page after the last submit. Absent when unknown. "incomplete": left without ever submitting. */
  outcome?: FlowOutcome;
  outcomeBy?: OutcomeBy;
  /** Set when the recording was bracketed by flow_task_begin / flow_task_end. */
  task?: FlowTask;
  runs?: FlowRuns;
  /** Every host the task touched when it crossed from one to another (a job board, then the employer's form). `site` is the first. */
  hosts?: string[];
  /** Set on flows built from several recordings by consolidate(). */
  derivedFrom?: string[];
  params: FlowParam[];
  steps: FlowStep[];
}

export interface ExportOptions {
  /** Embed the recorded values as defaults in the script. Sensitive parameters never get one. */
  includeDefaults?: boolean;
}

export interface Exporter {
  format: string;
  description: string;
  /** File extension without the dot. */
  extension: string;
  generate(flow: Flow, opts?: ExportOptions): string;
}

/** Light structural check for flow JSON read from disk or received from a tool. */
export function parseFlow(raw: unknown): Flow {
  const f = raw as Partial<Flow> | null;
  if (!f || typeof f !== 'object' || f.version !== FLOW_VERSION) throw new Error('Not a BrowserForge flow (version 1)');
  if (typeof f.id !== 'string' || typeof f.site !== 'string' || !Array.isArray(f.steps) || !Array.isArray(f.params)) throw new Error('Flow is missing id, site, params or steps');
  // Flows are listed newest first by createdAt and shown by name, so both must be usable before a flow is accepted.
  if (typeof f.name !== 'string' || typeof f.createdAt !== 'string' || Number.isNaN(Date.parse(f.createdAt))) throw new Error('Flow is missing a name or a valid createdAt');
  const actions = new Set(['navigate', 'click', 'fill', 'select', 'press', 'upload']);
  for (const s of f.steps) if (!s || !actions.has(s.action)) throw new Error(`Unknown step action '${String((s as { action?: unknown })?.action)}'`);
  return f as Flow;
}
