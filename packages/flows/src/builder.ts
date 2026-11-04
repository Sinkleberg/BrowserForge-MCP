import { describeLocator, looksPersonal, looksSensitive, paramName, scrubText, scrubUrl } from './params.js';
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
  state?: 'checked' | 'unchecked';
  /** The person chose to store their values ("Record me" with "Store my values"): keep this value even if it is personal. */
  keepValue?: boolean;
  frameUrl?: string;
  /** The page the action happened on. */
  url?: string;
}

/** A locator whose page-supplied strings no longer carry e-mail addresses, long numbers or token parameters. */
function scrubLocator(l: Locator): Locator {
  const out: Locator = { ...l };
  for (const k of ['name', 'label', 'text', 'placeholder'] as const) {
    const v = out[k];
    if (typeof v === 'string') out[k] = scrubText(v);
  }
  return out;
}

/** Labels that say nothing about the field ("autocompile", "field"): the id or name attribute is a better source for the parameter's name. */
const GENERIC_LABEL = /^(autocompile|autocomplete|field|input|text|textbox|type|value|label|search|combobox)(_?\d+)?$/i;

/** A name for the parameter of a field: its label, unless that is generic, then the placeholder or name/id attribute (`inPhone` -> `phone`). */
function bestName(a: RawAction): string {
  const clean = (s: string | undefined) => {
    if (!s) return undefined;
    const n = paramName(s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^(in|txt|input|ctl\d+|tb|fld)[_\s-]+/i, ''), '');
    return n && !GENERIC_LABEL.test(n) ? n : undefined;
  };
  return clean(a.fieldLabel) ?? clean(a.locator?.label) ?? clean(a.locator?.placeholder) ?? clean(a.locator?.nameAttr) ?? clean(a.locator?.id) ?? (a.action === 'upload' ? 'file' : 'field');
}

/** Turns the stream of actions an agent performed on one site into a parameterized flow. */
export class FlowBuilder {
  readonly flow: Flow;
  private readonly used = new Set<string>();
  private readonly storeValues: boolean;
  /** A task's own parameters (name -> value): a typed value that equals one is named after it and its value is not kept. Memory only. */
  private readonly hints: [string, string][];

  constructor(init: { id: string; site: string; name?: string; now?: Date; storeValues?: boolean; hints?: Record<string, string> }) {
    this.flow = { version: FLOW_VERSION, id: init.id, site: init.site, name: init.name ?? init.site, createdAt: (init.now ?? new Date()).toISOString(), params: [], steps: [] };
    this.storeValues = init.storeValues === true;
    this.hints = Object.entries(init.hints ?? {}).filter(([, v]) => v.trim() !== '');
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
    const clean = scrubUrl(url);
    if (last?.action === 'navigate' && last.url === clean) return;
    this.flow.steps.push({ action: 'navigate', url: clean, ts, label: `open ${clean}` });
  }

  add(a: RawAction, ts = Date.now()): FlowStep {
    // A recording that starts mid-page still needs to know where it started.
    if (this.empty && a.url) this.navigate(a.url, ts);
    const step: FlowStep = { action: a.action, ts };
    if (a.url) step.url = scrubUrl(a.url);
    if (a.locator) step.locator = scrubLocator(a.locator);
    if (a.frameUrl) step.frame = { url: scrubUrl(a.frameUrl) };
    if (a.consequential) step.consequential = true;
    if (a.custom) step.custom = true;
    if (a.state && a.action === 'click') step.state = a.state;
    const target = scrubText(describeLocator(a.locator));
    if (a.action === 'press') {
      step.key = a.key ?? 'Enter';
      step.label = `press ${step.key} on "${target}"`;
    } else if (a.action === 'fill' || a.action === 'select' || a.action === 'upload') {
      const sensitive = a.sensitive === true || looksSensitive(a.fieldLabel) || looksSensitive(a.locator?.nameAttr) || looksSensitive(a.locator?.label);
      const hint = a.value !== undefined ? this.hints.find(([, v]) => v === a.value?.trim()) : undefined;
      const base = hint?.[0] ?? bestName(a);
      const label = scrubText(a.fieldLabel ?? target);
      // A value is kept only when it is harmless, or the person chose to keep values; a task parameter's value is never kept (the caller has it).
      const keep = !sensitive && !hint && a.value !== undefined && (this.storeValues || a.keepValue === true || !looksPersonal(`${a.fieldLabel ?? ''} ${a.locator?.label ?? ''} ${a.locator?.nameAttr ?? ''} ${a.locator?.id ?? ''}`, a.value));
      step.param = this.newParam(base, sensitive, keep ? a.value : undefined, label);
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
