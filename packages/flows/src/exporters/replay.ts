import type { Exporter, Flow, FlowStep, Locator } from '../schema.js';
import { defaultsOf } from './common.js';

/** Chrome DevTools Recorder selectors: each entry is one alternative way to find the element. */
export function replaySelectors(loc: Locator | undefined): string[][] {
  if (!loc) return [];
  const out: string[][] = [];
  if (loc.testId) out.push([`[data-testid=${JSON.stringify(loc.testId)}]`]);
  if (loc.role && loc.name) out.push([`aria/${loc.name}[role="${loc.role}"]`]);
  else if (loc.name) out.push([`aria/${loc.name}`]);
  if (loc.id) out.push([`#${loc.id.replace(/([^a-zA-Z0-9_-])/g, '\\$1')}`]);
  if (loc.css) out.push([loc.css]);
  if (loc.xpath) out.push([`xpath/${loc.xpath}`]);
  if (loc.text) out.push([`text/${loc.text}`]);
  return out;
}

/**
 * The Chrome DevTools Recorder / Puppeteer Replay format (https://github.com/puppeteer/replay).
 * Import it in DevTools > Recorder, or run it with @puppeteer/replay. Parameters are filled with the recorded defaults:
 * pass includeDefaults for a runnable file; sensitive values are left empty so you must type them.
 */
export const puppeteerReplay: Exporter = {
  format: 'puppeteer-replay',
  description: 'Chrome DevTools Recorder / Puppeteer Replay JSON (import into DevTools or run with @puppeteer/replay)',
  extension: 'json',
  generate(flow: Flow, opts) {
    const d = defaultsOf(flow, { includeDefaults: opts?.includeDefaults !== false });
    const value = (param?: string) => (param ? d[param] ?? '' : '');
    const steps: Record<string, unknown>[] = [{ type: 'setViewport', width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false, isLandscape: true }];
    for (const s of flow.steps as FlowStep[]) {
      const base = { target: 'main' as const, selectors: replaySelectors(s.locator) };
      switch (s.action) {
        case 'navigate': steps.push({ type: 'navigate', url: s.url, assertedEvents: [{ type: 'navigation', url: s.url, title: '' }] }); break;
        case 'click': steps.push({ type: 'click', ...base, offsetX: 1, offsetY: 1 }); break;
        case 'fill': steps.push({ type: 'change', ...base, value: value(s.param) }); break;
        case 'select': steps.push(s.custom ? { type: 'click', ...base, offsetX: 1, offsetY: 1 } : { type: 'change', ...base, value: value(s.param) }); break;
        case 'upload': steps.push({ type: 'change', ...base, value: value(s.param) }); break;
        case 'press': steps.push({ type: 'keyDown', target: 'main', key: s.key ?? 'Enter' }, { type: 'keyUp', key: s.key ?? 'Enter', target: 'main' }); break;
      }
    }
    const consequential = flow.steps.filter((s) => s.consequential).length;
    return JSON.stringify({ title: `${flow.name} (${flow.site})${consequential ? ` - ${consequential} consequential step(s): review before replaying` : ''}`, steps }, null, 2) + '\n';
  },
};
