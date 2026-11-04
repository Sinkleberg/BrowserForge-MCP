import type { Exporter, Flow, FlowStep, Locator } from '../schema.js';
import { cssEscapeId, defaultsOf, frameMatch, header, q, stepLabel } from './common.js';

type Lang = 'ts' | 'py';

/** Playwright locator expressions for one element, best first. The script tries them in order. */
export function playwrightCandidates(loc: Locator | undefined, root: string, lang: Lang): string[] {
  if (!loc) return [];
  const out: string[] = [];
  const py = lang === 'py';
  if (loc.testId) out.push(py ? `${root}.get_by_test_id(${q(loc.testId)})` : `${root}.getByTestId(${q(loc.testId)})`);
  if (loc.role && loc.name) out.push(py ? `${root}.get_by_role(${q(loc.role)}, name=${q(loc.name)})` : `${root}.getByRole(${q(loc.role)} as any, { name: ${q(loc.name)} })`);
  if (loc.label) out.push(py ? `${root}.get_by_label(${q(loc.label)})` : `${root}.getByLabel(${q(loc.label)})`);
  if (loc.placeholder) out.push(py ? `${root}.get_by_placeholder(${q(loc.placeholder)})` : `${root}.getByPlaceholder(${q(loc.placeholder)})`);
  if (loc.id) out.push(`${root}.locator(${q('#' + cssEscapeId(loc.id))})`);
  if (loc.nameAttr) out.push(`${root}.locator(${q(`[name=${JSON.stringify(loc.nameAttr)}]`)})`);
  if (loc.text && !loc.role) out.push(py ? `${root}.get_by_text(${q(loc.text)}, exact=True)` : `${root}.getByText(${q(loc.text)}, { exact: true })`);
  if (loc.css) out.push(`${root}.locator(${q(loc.css)})`);
  if (loc.xpath) out.push(`${root}.locator(${q('xpath=' + loc.xpath)})`);
  // The recorded `nth` counts matches of the first strategy (the page's own order); Playwright's .nth(n) is that same 0-based position.
  if (loc.nth !== undefined && out.length) out[0] = `${out[0]}.nth(${loc.nth})`;
  return out;
}

const rootOf = (s: FlowStep, lang: Lang): string =>
  s.frame ? (lang === 'py' ? `page.frame_locator(${q(`iframe[src*=${JSON.stringify(frameMatch(s.frame.url))}]`)})` : `page.frameLocator(${q(`iframe[src*=${JSON.stringify(frameMatch(s.frame.url))}]`)})`) : 'page';

function tsStep(s: FlowStep, i: number): string[] {
  const lines: string[] = [`  // ${stepLabel(s, i)}`];
  const guard = s.consequential ? [`  if (!confirmed) await stop(3, ${q(`Step ${i + 1} is consequential (${s.label ?? s.action}). Review the flow, then re-run with FLOW_CONFIRM=1 to perform it.`)});`] : [];
  const cands = (loc: Locator | undefined) => `[${playwrightCandidates(loc, rootOf(s, 'ts'), 'ts').join(', ')}]`;
  const what = q(s.label ?? s.action);
  switch (s.action) {
    case 'navigate': return [...lines, `  await page.goto(${q(s.url ?? '')});`];
    case 'click': return [...lines, ...guard, s.state ? `  await (await pick(${cands(s.locator)}, ${what})).setChecked(${s.state === 'checked'});` : `  await (await pick(${cands(s.locator)}, ${what})).click();`];
    case 'fill': return [...lines, ...guard, `  await (await pick(${cands(s.locator)}, ${what})).fill(p(${q(s.param ?? '')}));`];
    case 'upload': return [...lines, ...guard, `  await (await pick(${cands(s.locator)}, ${what})).setInputFiles(p(${q(s.param ?? '')}));`];
    case 'press': return [...lines, ...guard, s.locator ? `  await (await pick(${cands(s.locator)}, ${what})).press(${q(s.key ?? 'Enter')});` : `  await page.keyboard.press(${q(s.key ?? 'Enter')});`];
    case 'select':
      if (s.custom) return [...lines, `  await (await pick(${cands(s.locator)}, ${what})).click();`, `  await page.getByRole('option', { name: p(${q(s.param ?? '')}), exact: true }).first().click();`];
      return [...lines, ...guard, `  await (await pick(${cands(s.locator)}, ${what})).selectOption({ label: p(${q(s.param ?? '')}) });`];
  }
}

export const playwrightTs: Exporter = {
  format: 'playwright-ts',
  description: 'Playwright script in TypeScript (run with: npx tsx flow.ts)',
  extension: 'ts',
  generate(flow: Flow, opts) {
    const d = defaultsOf(flow, opts);
    return `${header(flow, '//')}
import { chromium, type Locator } from 'playwright';
import fs from 'node:fs';

const defaults: Record<string, string> = ${JSON.stringify(d, null, 2)};
// Values come from flow-params.json or FLOW_PARAM_<NAME> environment variables (they override the defaults above).
const file: Record<string, string> = fs.existsSync('flow-params.json') ? JSON.parse(fs.readFileSync('flow-params.json', 'utf8')) : {};
function p(name: string): string {
  const v = process.env['FLOW_PARAM_' + name.toUpperCase()] ?? file[name] ?? defaults[name];
  if (v === undefined) throw new Error(\`Missing parameter "\${name}": set FLOW_PARAM_\${name.toUpperCase()} or add it to flow-params.json\`);
  return v;
}
const confirmed = process.env.FLOW_CONFIRM === '1';

/** Try each candidate locator in order: the one matching exactly one element wins, then the first with any match. */
async function pick(candidates: Locator[], what: string, timeoutMs = 15000): Promise<Locator> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const c of candidates) if ((await c.count()) === 1) return c;
    for (const c of candidates) if ((await c.count()) > 0) return c.first();
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('No element found for ' + what);
}

// BROWSER_PATH: use an installed Chrome/Chromium instead of Playwright's own build.
const browser = await chromium.launch({ headless: process.env.HEADLESS !== '0', executablePath: process.env.BROWSER_PATH || undefined });
async function stop(code: number, message?: string): Promise<never> {
  if (message) console.error(message);
  await browser.close();
  process.exit(code);
}
const page = await browser.newPage();
try {
${flow.steps.flatMap((s, i) => tsStep(s, i)).join('\n')}
  console.log('Flow finished.');
  await browser.close();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  await stop(1);
}
`;
  },
};

function pyStep(s: FlowStep, i: number): string[] {
  const lines: string[] = [`    # ${stepLabel(s, i)}`];
  const guard = s.consequential ? [`    if not CONFIRMED:\n        stop(3, ${q(`Step ${i + 1} is consequential (${s.label ?? s.action}). Review the flow, then re-run with FLOW_CONFIRM=1 to perform it.`)})`] : [];
  const cands = (loc: Locator | undefined) => `[${playwrightCandidates(loc, rootOf(s, 'py'), 'py').join(', ')}]`;
  const what = q(s.label ?? s.action);
  switch (s.action) {
    case 'navigate': return [...lines, `    page.goto(${q(s.url ?? '')})`];
    case 'click': return [...lines, ...guard, s.state ? `    pick(${cands(s.locator)}, ${what}).set_checked(${s.state === 'checked' ? 'True' : 'False'})` : `    pick(${cands(s.locator)}, ${what}).click()`];
    case 'fill': return [...lines, ...guard, `    pick(${cands(s.locator)}, ${what}).fill(p(${q(s.param ?? '')}))`];
    case 'upload': return [...lines, ...guard, `    pick(${cands(s.locator)}, ${what}).set_input_files(p(${q(s.param ?? '')}))`];
    case 'press': return [...lines, ...guard, s.locator ? `    pick(${cands(s.locator)}, ${what}).press(${q(s.key ?? 'Enter')})` : `    page.keyboard.press(${q(s.key ?? 'Enter')})`];
    case 'select':
      if (s.custom) return [...lines, `    pick(${cands(s.locator)}, ${what}).click()`, `    page.get_by_role("option", name=p(${q(s.param ?? '')}), exact=True).first.click()`];
      return [...lines, ...guard, `    pick(${cands(s.locator)}, ${what}).select_option(label=p(${q(s.param ?? '')}))`];
  }
}

export const playwrightPy: Exporter = {
  format: 'playwright-py',
  description: 'Playwright script in Python (run with: python flow.py)',
  extension: 'py',
  generate(flow: Flow, opts) {
    const d = defaultsOf(flow, opts);
    return `${header(flow, '#')}
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

DEFAULTS = ${JSON.stringify(d, null, 4)}
# Values come from flow-params.json or FLOW_PARAM_<NAME> environment variables (they override the defaults above).
FILE = json.load(open("flow-params.json")) if os.path.exists("flow-params.json") else {}
CONFIRMED = os.environ.get("FLOW_CONFIRM") == "1"


def p(name):
    value = os.environ.get("FLOW_PARAM_" + name.upper(), FILE.get(name, DEFAULTS.get(name)))
    if value is None:
        raise RuntimeError(f'Missing parameter "{name}": set FLOW_PARAM_{name.upper()} or add it to flow-params.json')
    return value


def pick(candidates, what, timeout=15):
    """Try each candidate locator in order: the one matching exactly one element wins, then the first with any match."""
    end = time.time() + timeout
    while time.time() < end:
        for c in candidates:
            if c.count() == 1:
                return c
        for c in candidates:
            if c.count() > 0:
                return c.first
        time.sleep(0.25)
    raise RuntimeError("No element found for " + what)


def stop(code, message=None):
    if message:
        print(message, file=sys.stderr)
    BROWSER.close()
    PLAYWRIGHT.stop()
    sys.exit(code)


PLAYWRIGHT = sync_playwright().start()
# BROWSER_PATH: use an installed Chrome/Chromium instead of Playwright's own build.
BROWSER = PLAYWRIGHT.chromium.launch(headless=os.environ.get("HEADLESS") != "0", executable_path=os.environ.get("BROWSER_PATH") or None)
page = BROWSER.new_page()
try:
    pass
${flow.steps.flatMap((s, i) => pyStep(s, i)).join('\n')}
    print("Flow finished.")
    BROWSER.close()
    PLAYWRIGHT.stop()
except SystemExit:
    raise
except Exception as e:
    stop(1, str(e))
`;
  },
};
