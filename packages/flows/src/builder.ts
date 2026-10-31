import { describeLocator, looksSensitive, paramName } from './params.js';
import { FLOW_VERSION, type Flow, type FlowParam, type FlowStep, type Locator } from './schema.js';

export interface RawAction {
  action: 'click' | 'fill' | 'select' | 'press' | 'upload';
  locator?: Locator;
  /** The text typed / option chosen / file path. Becomes a parameter default (never for sensitive fields). */
  value?: string;
  key?: string;
  /** A name for the field, e.g. its label. Used to name the parameter. */
  fieldLabel?: string;
  sensitive?: boolean;
  consequential?: boolean;
  custom?: boolean;
  frameUrl?: string;
  /** The page the action happened on. */
  url?: string;
}

/** Turns the stream of actions an agent performed on one site into a parameterized flow. */
export class FlowBuilder {
  readonly flow: Flow;
  private readonly used = new Set<string>();

  constructor(init: { id: string; site: string; name?: string; now?: Date }) {
    this.flow = { version: FLOW_VERSION, id: init.id, site: init.site, name: init.name ?? init.site, createdAt: (init.now ?? new Date()).toISOString(), params: [], steps: [] };
  }

  get empty(): boolean {
    return this.flow.steps.length === 0;
  }
  get lastUrl(): string | undefined {
    for (let i = this.flow.steps.length - 1; i >= 0; i--) if (this.flow.steps[i]!.url) return this.flow.steps[i]!.url;
    return undefined;
  }

  navigate(url: string, ts = Date.now()): void {
    const last = this.flow.steps[this.flow.steps.length - 1];
    if (last?.action === 'navigate' && last.url === url) return;
    this.flow.steps.push({ action: 'navigate', url, ts, label: `open ${url}` });
  }

  add(a: RawAction, ts = Date.now()): FlowStep {
    // A recording that starts mid-page still needs to know where it started.
    if (this.empty && a.url) this.navigate(a.url, ts);
    const step: FlowStep = { action: a.action, ts };
    if (a.url) step.url = a.url;
    if (a.locator) step.locator = a.locator;
    if (a.frameUrl) step.frame = { url: a.frameUrl };
    if (a.consequential) step.consequential = true;
    if (a.custom) step.custom = true;
    const target = describeLocator(a.locator);
    if (a.action === 'press') {
      step.key = a.key ?? 'Enter';
      step.label = `press ${step.key} on "${target}"`;
    } else if (a.action === 'fill' || a.action === 'select' || a.action === 'upload') {
      const sensitive = a.sensitive === true || looksSensitive(a.fieldLabel) || looksSensitive(a.locator?.nameAttr) || looksSensitive(a.locator?.label);
      const base = paramName(a.fieldLabel ?? a.locator?.label ?? a.locator?.placeholder ?? a.locator?.nameAttr ?? a.locator?.id, a.action === 'upload' ? 'file' : 'field');
      step.param = this.newParam(base, sensitive, a.value, a.fieldLabel ?? target);
      step.label = `${a.action} "${target}"`;
      if (sensitive || a.action === 'upload') step.consequential = true;
    } else {
      step.label = `click "${target}"`;
    }
    this.flow.steps.push(step);
    return step;
  }

  private newParam(base: string, sensitive: boolean, value: string | undefined, label: string): string {
    let name = base;
    for (let i = 2; this.used.has(name); i++) name = `${base}_${i}`;
    this.used.add(name);
    const p: FlowParam = { name, sensitive, label };
    if (!sensitive && value !== undefined) p.default = value;
    this.flow.params.push(p);
    return name;
  }
}
