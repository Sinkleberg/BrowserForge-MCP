import { looksPersonal, scrubText, scrubUrl } from './params.js';
import type { Flow, Locator } from './schema.js';

/**
 * A flow where nothing was filled, chosen, uploaded, pressed or submitted: someone only looked at pages. Not worth keeping as a flow.
 * (Human recordings are kept whatever they hold: the person asked for them.)
 */
export function isBrowseOnly(flow: Flow): boolean {
  if (flow.source === 'human') return false;
  return !flow.steps.some((s) => s.consequential || s.action === 'fill' || s.action === 'select' || s.action === 'upload' || s.action === 'press');
}

/**
 * Remove what should never have been stored from an already-recorded flow, in place: personal values kept as parameter defaults (unless the
 * person chose to keep values), and session tokens, e-mail addresses and long numbers in addresses, labels and locator names.
 * Returns how many things were changed.
 */
export function scrubFlow(flow: Flow, opts: { keepValues?: boolean } = {}): number {
  let changed = 0;
  const text = (v: string): string => {
    const out = scrubText(v);
    if (out !== v) changed++;
    return out;
  };
  const url = (v: string): string => {
    const out = scrubUrl(v);
    if (out !== v) changed++;
    return out;
  };
  for (const s of flow.steps) {
    if (s.url) s.url = url(s.url);
    if (s.frame?.url) s.frame.url = url(s.frame.url);
    if (s.label) s.label = text(s.label);
    if (s.locator) {
      const loc = s.locator as Locator;
      for (const k of ['name', 'label', 'text', 'placeholder'] as const) {
        const v = loc[k];
        if (typeof v === 'string') loc[k] = text(v);
      }
    }
  }
  for (const p of flow.params) {
    if (p.label) p.label = text(p.label);
    if (p.default !== undefined && (p.sensitive || (!opts.keepValues && looksPersonal(`${p.label ?? ''} ${p.name}`, p.default)))) {
      delete p.default;
      changed++;
    }
  }
  return changed;
}
