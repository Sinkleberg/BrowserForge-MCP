import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { FlowBuilder, getExporter, playwrightCandidates, type Locator } from '@browserforge/flows';
import { SHADOW_ENGINE, SHADOW_QUERY } from '../../packages/flows/src/exporters/common.js';
import { HumanActionEventSchema } from '@browserforge/browser-protocol';
import { recordedShadow } from '../../apps/firefox-extension/src/recorded-shadow.js';

type Node = { shadowRoot?: Root | null };
type Root = { querySelectorAll(selector: string): Node[] };
const root = (entries: Record<string, Node[]>): Root => ({ querySelectorAll: (selector) => entries[selector] ?? [] });
// Only the fixed first-party exporter body is evaluated; all recorded selectors remain data.
const query = runInNewContext(`(${SHADOW_QUERY})`, {}, { timeout: 1000 }) as (scope: Root, hosts: string[], css: string) => Node[];

describe('recorded open-shadow locators', () => {
  it.each([
    { hosts: Array(7).fill('#host'), css: '#go', accepted: true },
    { hosts: Array(8).fill('#host'), css: '#go', accepted: false },
    { hosts: Array(9).fill('#host'), css: '#go', accepted: false },
    ...[599, 600, 601].flatMap((length) => [
      { hosts: ['#' + 'h'.repeat(length - 1)], css: '#go', accepted: length < 600 },
      { hosts: ['#host'], css: '#' + 'g'.repeat(length - 1), accepted: length < 600 },
    ]),
  ].map((entry) => ({ ...entry, boundary: `${entry.hosts.length} hosts/${Math.max(...entry.hosts.map((host) => host.length))} host units/${entry.css.length} target units` })))('keeps recording boundaries lossless or explicitly unresolvable: $boundary', ({ hosts, css, accepted }) => {
    const carried = recordedShadow(hosts, css)!;
    expect(carried).toEqual(accepted ? hosts : ['']);
    const wire = HumanActionEventSchema.parse({ v: 1, type: 'event', event: 'human', data: { at: 0, kind: 'click', url: 'https://example.test/', shadow: carried, locator: { css: css.slice(0, 600) } } });
    // A second relay check and the existing builder must preserve the refusal marker, never turn it into a global locator.
    const relayed = recordedShadow(wire.data.shadow, wire.data.locator?.css)!;
    const builder = new FlowBuilder({ id: 'boundary', site: 'example.test' });
    builder.add({ action: 'click', locator: { css: wire.data.locator!.css, shadow: relayed } });
    expect(builder.flow.steps[0]!.locator!.shadow).toEqual(carried);
    for (const format of ['playwright-ts', 'playwright-py', 'selenium-py', 'selenium-java']) {
      if (accepted) expect(() => getExporter(format)!.generate(builder.flow)).not.toThrow();
      else expect(() => getExporter(format)!.generate(builder.flow)).toThrow(/shadow locator/);
      // Legacy at-limit data lacks proof that the old relay did not truncate it, even if its prefix is valid CSS.
      const legacy = { ...builder.flow, steps: [{ action: 'click' as const, ts: 0, locator: { css, shadow: hosts } }] };
      if (!accepted) expect(() => getExporter(format)!.generate(legacy)).toThrow(/recording limits/);
    }
  });

  it('follows the explicit nested host chain instead of an identical page or sibling selector', () => {
    const target = {};
    const scope = root({ '#outer': [{ shadowRoot: root({ '#inner': [{ shadowRoot: root({ '#field': [target] }) }] }) }], '#field': [{}], '#sibling': [{ shadowRoot: root({ '#field': [{}] }) }] });
    expect(query(scope, ['#outer', '#inner'], '#field')).toEqual([target]);
    expect(query(scope, ['#missing', '#inner'], '#field')).toEqual([]);
    expect(query(scope, ['#outer', '#missing'], '#field')).toEqual([]);
  });

  it('refuses ambiguous hosts, ambiguous targets and closed roots without a global fallback', () => {
    expect(query(root({ '#host': [{ shadowRoot: root({ '#field': [{}] }) }, { shadowRoot: root({ '#field': [{}] }) }] }), ['#host'], '#field')).toEqual([]);
    expect(query(root({ '#host': [{ shadowRoot: root({ '#field': [{}, {}] }) }] }), ['#host'], '#field')).toEqual([]);
    expect(query(root({ '#host': [{ shadowRoot: null }], '#field': [{}] }), ['#host'], '#field')).toEqual([]);
    expect(query({ querySelectorAll: () => { throw new SyntaxError('bad selector'); } }, ['['], '#field')).toEqual([]);
  });

  it('keeps quotes, backslashes, Unicode and selector separators as data in the registered engine', () => {
    const host = `[data-host=${JSON.stringify('雪"\\ >> quote')}]`;
    const css = `[data-value=${JSON.stringify("'\\雪")}]`;
    const target = {};
    const scope = root({ [host]: [{ shadowRoot: root({ [css]: [target] }) }] });
    const engine = runInNewContext(SHADOW_ENGINE, {}, { timeout: 1000 }) as { queryAll(scope: Root, selector: string): Node[] };
    expect(engine.queryAll(scope, JSON.stringify({ hosts: [host], css }))).toEqual([target]);
    const loc: Locator = { css, shadow: [host], label: 'same everywhere', nth: 12 };
    const expected = `page.locator(${JSON.stringify('bfshadow=' + JSON.stringify({ hosts: [host], css }))})`;
    expect(playwrightCandidates(loc, 'page', 'ts')).toEqual([expected]);
    expect(playwrightCandidates(loc, 'page', 'py')).toEqual([expected]);
    expect(expected).not.toContain('.nth('); // old nth counted global semantic matches, not this CSS scope
  });

  it('exports four runtimes with the fixed helper and preserves consequential guards', () => {
    const b = new FlowBuilder({ id: 'shadow', site: 'example.test' });
    const step = b.add({ action: 'fill', value: 'demo', fieldLabel: 'Field', locator: { css: '#field', shadow: ['#outer', '#inner'], nth: 19 }, url: 'https://example.test/' });
    step.consequential = true;
    for (const format of ['playwright-ts', 'playwright-py', 'selenium-py', 'selenium-java']) {
      const code = getExporter(format)!.generate(b.flow);
      expect(code, format).toContain('FLOW_CONFIRM');
      expect(code, format).toContain('shadowRoot');
      expect(code, format).not.toMatch(/\.nth\(19\)/);
      const guard = code.indexOf(format.endsWith('py') ? 'if not CONFIRMED:' : format.endsWith('java') ? 'if (!CONFIRMED)' : 'if (!confirmed)');
      const action = code.indexOf(format === 'playwright-ts' ? 'await (await pick(' : format === 'playwright-py' ? '    pick([page.locator(' : format === 'selenium-py' ? '    el = find_shadow(' : '= findShadow(');
      expect(guard, format).toBeGreaterThan(0);
      expect(action, format).toBeGreaterThan(guard);
      if (format.startsWith('playwright')) {
        expect(code, format).toContain('bfshadow');
        expect(code.indexOf('register('), format).toBeLessThan(code.indexOf(format.endsWith('ts') ? 'browser.newPage()' : 'BROWSER.new_page()'));
      } else {
        expect(code, format).toContain(format.endsWith('py') ? 'driver.execute_script(' : ').executeScript(');
      }
    }
    expect(() => getExporter('puppeteer-replay')!.generate(b.flow)).toThrow(/open shadow root/);
  });

  it('rejects shadow recordings without exact CSS instead of using an unrelated label', () => {
    const b = new FlowBuilder({ id: 'incomplete', site: 'example.test' });
    b.add({ action: 'click', locator: { label: 'same everywhere', shadow: ['#host'] }, url: 'https://example.test/' });
    for (const format of ['playwright-ts', 'playwright-py', 'selenium-py', 'selenium-java']) expect(() => getExporter(format)!.generate(b.flow), format).toThrow(/recorded relative CSS/);
  });
});
