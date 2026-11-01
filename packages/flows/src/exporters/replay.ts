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
 * Import it in DevTools > Recorder, or run it with @puppeteer/replay. Recorded values are embedded only with includeDefaults (like the
 * other exporters); without it, and for sensitive parameters, the values are left empty for you to type.
 * The format cannot attach files or find an iframe by its address, so flows with uploads or iframe steps are refused: use Playwright or Selenium.
 */
export const puppeteerReplay: Exporter = {
  format: 'puppeteer-replay',
  description: 'Chrome DevTools Recorder / Puppeteer Replay JSON (import into DevTools or run with @puppeteer/replay)',
  extension: 'json',
  generate(flow: Flow, opts) {
    const d = defaultsOf(flow, opts);
    const value = (param?: string) => (param ? d[param] ?? '' : '');
    const steps: Record<string, unknown>[] = [{ type: 'setViewport', width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false, isLandscape: true }];
    const other = 'Export this flow as playwright-ts, playwright-py, selenium-py or selenium-java instead.';
    for (const [i, s] of (flow.steps as FlowStep[]).entries()) {
      if (s.frame) throw new Error(`Step ${i + 1} is inside an iframe, which the Chrome Recorder format can only address by position, not by its address. ${other}`);
      const base = { target: 'main' as const, selectors: replaySelectors(s.locator) };
      switch (s.action) {
        case 'navigate': steps.push({ type: 'navigate', url: s.url, assertedEvents: [{ type: 'navigation', url: s.url, title: '' }] }); break;
        case 'click': steps.push({ type: 'click', ...base, offsetX: 1, offsetY: 1 }); break;
        case 'fill': steps.push({ type: 'change', ...base, value: value(s.param) }); break;
        case 'select':
          if (!s.custom) steps.push({ type: 'change', ...base, value: value(s.param) });
          else {
            // A custom dropdown is two clicks: the opener, then the option. The option's text is the value, so it has to be known now.
            const v = value(s.param);
            if (!v) throw new Error(`Step ${i + 1} picks an option in a custom dropdown; the Chrome Recorder format needs its text in the file. Export with includeDefaults, or ${other.charAt(0).toLowerCase()}${other.slice(1)}`);
            steps.push({ type: 'click', ...base, offsetX: 1, offsetY: 1 }, { type: 'click', target: 'main', selectors: [[`aria/${v}[role="option"]`], [`text/${v}`]], offsetX: 1, offsetY: 1 });
          }
          break;
        case 'upload': throw new Error(`Step ${i + 1} uploads a file, which the Chrome Recorder format cannot do. ${other}`);
        case 'press': steps.push({ type: 'keyDown', target: 'main', key: s.key ?? 'Enter' }, { type: 'keyUp', key: s.key ?? 'Enter', target: 'main' }); break;
      }
    }
    const consequential = flow.steps.filter((s) => s.consequential).length;
    return JSON.stringify({ title: `${flow.name} (${flow.site})${consequential ? ` - ${consequential} consequential step(s): review before replaying` : ''}`, steps }, null, 2) + '\n';
  },
};
