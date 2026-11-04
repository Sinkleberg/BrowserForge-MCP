import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILTIN_EXPORTERS, FlowBuilder, getExporter, looksGeneratedId, looksSensitive, paramName, parseFlow, isBrowseOnly, playwrightCandidates, registrable, scrubFlow, replaySelectors, seleniumCandidates, type Flow } from '@browserforge/flows';
import { fillWorkflow } from '../../apps/mcp-server/src/plugins/skills.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
let tmp: string;
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-flows-')); });
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function sample(): Flow {
  const b = new FlowBuilder({ id: 'f1', site: 'example.test', name: 'Signup', now: new Date('2026-10-30T10:00:00Z'), storeValues: true });
  b.navigate('https://example.test/signup');
  b.add({ action: 'fill', value: 'Ada', fieldLabel: 'First name', locator: { tag: 'input', label: 'First name', id: 'first', css: '#first', xpath: '//*[@id="first"]' } });
  b.add({ action: 'fill', value: 'S3cret!', fieldLabel: 'Password', sensitive: true, locator: { tag: 'input', label: 'Password', nameAttr: 'pw', css: 'input[name=pw]' } });
  b.add({ action: 'select', value: 'July', fieldLabel: 'Birth month', locator: { tag: 'select', label: 'Birth month', css: '#mon' } });
  b.add({ action: 'select', value: 'Italy', fieldLabel: 'Country', custom: true, locator: { tag: 'div', role: 'combobox', name: 'Country', css: '#country' } });
  b.add({ action: 'fill', value: 'in frame', fieldLabel: 'Frame email', frameUrl: 'https://cdn.example.test/widgets/form', locator: { tag: 'input', label: 'Frame email', css: '#fe' } });
  b.add({ action: 'upload', value: '/tmp/cv.pdf', fieldLabel: 'CV', locator: { tag: 'input', css: 'input[type=file]' } });
  b.add({ action: 'click', consequential: true, locator: { tag: 'button', role: 'button', name: 'Submit', text: 'Submit', testId: 'submit-btn', css: 'button.go', xpath: '/html/body/button' } });
  b.add({ action: 'press', key: 'Enter', locator: { tag: 'input', css: '#first' } });
  return b.flow;
}

describe('FlowBuilder', () => {
  it('names parameters from labels, de-duplicates, and never keeps a value for sensitive fields', () => {
    const f = sample();
    expect(f.params.map((p) => p.name)).toEqual(['first_name', 'password', 'birth_month', 'country', 'frame_email', 'cv']);
    expect(f.params.find((p) => p.name === 'first_name')).toMatchObject({ sensitive: false, default: 'Ada' });
    const pw = f.params.find((p) => p.name === 'password')!;
    expect(pw.sensitive).toBe(true);
    expect(pw.default).toBeUndefined();
    expect(JSON.stringify(f)).not.toContain('S3cret');
    const b = new FlowBuilder({ id: 'x', site: 's' });
    b.add({ action: 'fill', value: 'a', fieldLabel: 'Email' });
    b.add({ action: 'fill', value: 'b', fieldLabel: 'Email' });
    expect(b.flow.params.map((p) => p.name)).toEqual(['email', 'email_2']);
  });

  it('flags sensitive-looking names, uploads and password fields as consequential and starts with the page it began on', () => {
    expect(looksSensitive('Card number')).toBe(true);
    expect(looksSensitive('IBAN')).toBe(true);
    expect(looksSensitive('First name')).toBe(false);
    expect(paramName('  E-mail address *', 'x')).toBe('e_mail_address');
    expect(looksGeneratedId(':r1:')).toBe(true);
    expect(looksGeneratedId('a1b2c3d4e5f6')).toBe(true);
    expect(looksGeneratedId('first-name')).toBe(false);
    // Generated ids are not worth anchoring a locator on; hand-written ones are.
    for (const id of ['f363sx', 'spl-form-element_54', 'modal-92-description', 'ctl00_ContentPlaceHolder1_btn', 'j_idt12', 'ember45', 'mui-3', 'k2j4h5g7', '_r_6_', '0123456789ab']) expect(looksGeneratedId(id), id).toBe(true);
    for (const id of ['step2', 'firstname', 'email', 'inPhone', 'address-line-1', 'first_name', 'login-form', 'cv', 'privacy', 'Conferma']) expect(looksGeneratedId(id), id).toBe(false);
    expect(registrable('joblink.allibo.com')).toBe('allibo.com');
    expect(registrable('am.allibo.com')).toBe('allibo.com');
    expect(registrable('www.example.co.uk')).toBe('example.co.uk');
    expect(registrable('a.test')).toBe('a.test');
    expect(registrable('lutech.intervieweb.it')).not.toBe(registrable('carel.intervieweb.it')); // companies' own job boards stay apart
    expect(registrable('acme.myworkdayjobs.com')).toBe('acme.myworkdayjobs.com');
    const f = sample();
    expect(f.steps.find((s) => s.param === 'password')!.consequential).toBe(true);
    expect(f.steps.find((s) => s.action === 'upload')!.consequential).toBe(true);
    const b = new FlowBuilder({ id: 'y', site: 's' });
    b.add({ action: 'click', url: 'https://s.test/start', locator: { text: 'Go' } });
    expect(b.flow.steps.map((s) => s.action)).toEqual(['navigate', 'click']);
  });

  it('names parameters after the field when its label is generic, keeps task parameters out of the defaults, and scrubs tokens and e-mail addresses', () => {
    const b = new FlowBuilder({ id: 'p', site: 's', hints: { first_name: 'Ada', city: 'Messina' } });
    const fillOf = (value: string, locator: Record<string, string>, fieldLabel?: string) => b.add({ action: 'fill', value, fieldLabel, locator: { tag: 'input', ...locator }, url: 'https://s.test/f?ID=9&t=SECRET&token=abc' });
    expect(fillOf('0712345678', { label: 'autocompile', nameAttr: 'inPhone' }, 'autocompile').param).toBe('phone');
    expect(fillOf('Ada', { label: 'autocompile', id: 'x' }, 'autocompile').param).toBe('first_name'); // matches a task parameter
    expect(fillOf('Messina', { label: 'City' }, 'City').param).toBe('city');
    expect(fillOf('1999', { label: 'Giorno', nameAttr: 'ctl00_birthYear' }, 'Giorno').param).toBe('giorno');
    const byName = (n: string) => b.flow.params.find((p) => p.name === n)!;
    expect(byName('first_name').default).toBeUndefined();
    expect(byName('city').default).toBeUndefined();
    expect(byName('phone').default).toBeUndefined(); // looks like a phone number
    const click = b.add({ action: 'click', locator: { text: 'Mail ada@example.com about 123456789012', css: 'a' }, url: 'https://s.test/x?aid=1&ID=2' });
    expect(JSON.stringify(b.flow)).not.toMatch(/SECRET|token=abc|ada@example.com|123456789012|aid=1/);
    expect(click.url).toContain('ID=2');
  });

  it('records the state a checkbox was left in', () => {
    const b = new FlowBuilder({ id: 'c', site: 's' });
    const step = b.add({ action: 'click', state: 'checked', locator: { tag: 'input', label: 'I agree', css: '#agree' }, url: 'https://s.test/f' });
    expect(step.state).toBe('checked');
    const code = getExporter('playwright-ts')!.generate(b.flow);
    expect(code).toContain('.setChecked(true)');
    expect(getExporter('playwright-py')!.generate(b.flow)).toContain('.set_checked(True)');
    b.add({ action: 'click', locator: { tag: 'button', role: 'button', name: 'Next' }, url: 'https://s.test/f' });
    expect(getExporter('playwright-ts')!.generate(b.flow)).toContain('.click()');
  });

  it('finds recordings that only browsed, and scrubs personal defaults and tokens out of old ones', () => {
    const b = new FlowBuilder({ id: 'o', site: 's' });
    b.navigate('https://s.test/a');
    expect(isBrowseOnly(b.flow)).toBe(true);
    b.add({ action: 'click', locator: { text: 'Next' }, url: 'https://s.test/a' });
    expect(isBrowseOnly(b.flow)).toBe(true); // clicking around is still browsing
    b.add({ action: 'fill', value: 'x', fieldLabel: 'Comment', locator: { label: 'Comment' }, url: 'https://s.test/a' });
    expect(isBrowseOnly(b.flow)).toBe(false);
    const old: Flow = { ...b.flow, params: [{ name: 'phone', sensitive: false, label: 'Phone', default: '0712345678' }, { name: 'preferred_language', sensitive: false, default: 'Italian' }, { name: 'pw', sensitive: true, default: 'hunter2' }], steps: [{ action: 'navigate', url: 'https://s.test/a?aid=1&ID=2', ts: 0, label: 'open https://s.test/a?aid=1&ID=2' }] };
    expect(scrubFlow(old)).toBeGreaterThanOrEqual(4);
    expect(old.params.map((p) => [p.name, p.default])).toEqual([['phone', undefined], ['preferred_language', 'Italian'], ['pw', undefined]]);
    expect(JSON.stringify(old)).not.toMatch(/aid=1|hunter2/);
    expect(scrubFlow(old)).toBe(0); // nothing more to do
  });

  it('Playwright picks the nth of equal matches, and the formats that cannot reach into a shadow root refuse instead of writing a script that cannot find it', () => {
    const b = new FlowBuilder({ id: 'n', site: 's', now: new Date('2026-10-30T10:00:00Z') });
    b.add({ action: 'click', locator: { tag: 'button', role: 'button', name: 'Add', nth: 1, css: 'button.add' }, url: 'https://s.test/f' });
    expect(getExporter('playwright-ts')!.generate(b.flow)).toContain(`getByRole("button" as any, { name: "Add" }).nth(1)`);
    expect(getExporter('playwright-py')!.generate(b.flow)).toContain('.get_by_role("button", name="Add").nth(1)');
    const sh = new FlowBuilder({ id: 'sh', site: 's' });
    sh.add({ action: 'fill', value: 'x', fieldLabel: 'Email', locator: { tag: 'input', label: 'Email', css: '#e', shadow: ['html > body > my-form'] }, url: 'https://s.test/f' });
    expect(() => getExporter('playwright-ts')!.generate(sh.flow)).not.toThrow(); // Playwright's CSS pierces open shadow roots
    for (const f of ['selenium-py', 'selenium-java', 'puppeteer-replay']) expect(() => getExporter(f)!.generate(sh.flow), f).toThrow(/open shadow root.*playwright-ts/);
  });

  it('validates flow JSON', () => {
    expect(parseFlow(JSON.parse(JSON.stringify(sample()))).site).toBe('example.test');
    expect(() => parseFlow({ version: 2 })).toThrow(/version 1/);
    expect(() => parseFlow({ ...sample(), steps: [{ action: 'explode' }] })).toThrow(/Unknown step action/);
    // Listing sorts by createdAt and shows the name, so a flow without them is refused instead of breaking flow_list later.
    expect(() => parseFlow({ ...sample(), createdAt: undefined })).toThrow(/createdAt/);
    expect(() => parseFlow({ ...sample(), createdAt: 42 })).toThrow(/createdAt/);
    expect(() => parseFlow({ ...sample(), createdAt: 'yesterday-ish' })).toThrow(/createdAt/);
    expect(() => parseFlow({ ...sample(), name: undefined })).toThrow(/name/);
  });
});

describe('locator candidates', () => {
  const loc = { testId: 't', role: 'button', name: 'Go', label: 'Go label', placeholder: 'ph', id: 'x.y', nameAttr: 'n', text: 'Go', css: 'div > b', xpath: '/html/b' };
  it('are ordered best first for Playwright', () => {
    const c = playwrightCandidates(loc, 'page', 'ts');
    expect(c[0]).toContain('getByTestId');
    expect(c[1]).toContain('getByRole');
    expect(c[2]).toContain('getByLabel');
    expect(c.at(-1)).toContain('xpath=');
    expect(c.some((x) => x.includes('#x\\\\.y'))).toBe(true); // ids are CSS-escaped (and the backslash is doubled inside the string literal)
    expect(playwrightCandidates(loc, 'page', 'py')[0]).toContain('get_by_test_id');
  });
  it('become IDs, names, XPath and CSS for Selenium and aria/xpath/css selectors for Chrome Recorder', () => {
    const s = seleniumCandidates(loc).map(([k]) => k);
    expect(s).toEqual(expect.arrayContaining(['CSS', 'ID', 'NAME', 'XPATH']));
    expect(replaySelectors(loc).map((x) => x[0])).toEqual(expect.arrayContaining(['aria/Go[role="button"]', 'xpath//html/b', 'div > b']));
  });
});

describe('exporters', () => {
  const flow = sample();
  const gen = (format: string, includeDefaults = false) => getExporter(format)!.generate(flow, { includeDefaults });

  it('ship the six built-in formats', () => {
    expect(BUILTIN_EXPORTERS.map((e) => e.format)).toEqual(['playwright-ts', 'playwright-py', 'selenium-py', 'selenium-java', 'puppeteer-replay', 'json']);
  });

  it('never embed sensitive values and only embed defaults when asked', () => {
    // (Chrome Recorder refuses this sample's iframe and upload steps; its own test checks the same rules.)
    for (const e of BUILTIN_EXPORTERS.filter((x) => x.format !== 'puppeteer-replay')) {
      expect(e.generate(flow, { includeDefaults: true })).not.toContain('S3cret');
      if (e.format !== 'json' && e.format !== 'puppeteer-replay') {
        expect(e.generate(flow, { includeDefaults: false })).not.toContain('"Ada"');
        expect(e.generate(flow, { includeDefaults: true })).toContain('Ada');
      }
    }
  });

  it('stop before consequential steps unless FLOW_CONFIRM=1', () => {
    for (const f of ['playwright-ts', 'playwright-py', 'selenium-py', 'selenium-java']) {
      const code = gen(f);
      expect(code, f).toContain('FLOW_CONFIRM');
      expect(code, f).toMatch(/consequential \(click \\?"Submit\\?"\)/);
    }
  });

  it('switch into iframes and handle custom dropdowns', () => {
    expect(gen('playwright-ts')).toContain('frameLocator("iframe[src*=\\"/widgets/form\\"]")');
    expect(gen('playwright-py')).toContain('frame_locator(');
    expect(gen('selenium-py')).toContain('enter_frame(');
    expect(gen('selenium-java')).toContain('enterFrame(');
    expect(gen('playwright-ts')).toContain("getByRole('option'");
  });

  it('comments cannot be broken out of by names or labels with line breaks (or Java unicode escapes)', () => {
    const evil = sample();
    evil.name = 'x\nimport os; os.system("boom")\r\u2028y';
    evil.steps[1]!.label = 'a\nboom()\n// \\u000a boom2()';
    for (const e of BUILTIN_EXPORTERS.filter((x) => !['json', 'puppeteer-replay'].includes(x.format))) {
      const code = e.generate(evil, { includeDefaults: false });
      const lines = code.split(/\r\n|\r|\n|\u2028|\u2029/);
      // The text is still there, but only inside comments or string literals: no line starts with the injected code.
      expect(lines.some((l) => /^\s*(\/\/|#).*import os; os\.system/.test(l)), e.format).toBe(true);
      for (const l of lines) expect(l.trim(), e.format).not.toMatch(/^(boom|import os; os\.system)/);
      // In a comment Java would decode \u000a into a line break; inside a string literal it is already escaped ("\\u000a").
      for (const l of lines.filter((x) => /^\s*(\/\/|#)/.test(x))) expect(l, e.format).not.toContain('\\u000a');
    }
  });

  it('Chrome Recorder JSON has the expected step types and selectors, and embeds values only when asked', () => {
    const b = new FlowBuilder({ id: 'f2', site: 'example.test', name: 'Plain', storeValues: true });
    b.navigate('https://example.test/signup');
    b.add({ action: 'fill', value: 'Ada', fieldLabel: 'First name', locator: { tag: 'input', label: 'First name', css: '#first' } });
    b.add({ action: 'fill', value: 'S3cret!', fieldLabel: 'Password', sensitive: true, locator: { tag: 'input', css: 'input[name=pw]' } });
    b.add({ action: 'select', value: 'Italy', fieldLabel: 'Country', custom: true, locator: { tag: 'div', role: 'combobox', name: 'Country', css: '#country' } });
    b.add({ action: 'click', consequential: true, locator: { tag: 'button', role: 'button', name: 'Submit', text: 'Submit', testId: 'submit-btn', css: 'button.go', xpath: '/html/body/button' } });
    b.add({ action: 'press', key: 'Enter', locator: { tag: 'input', css: '#first' } });
    const plain = b.flow;
    const rec = getExporter('puppeteer-replay')!;

    const j = JSON.parse(rec.generate(plain, { includeDefaults: true }));
    expect(j.steps[0].type).toBe('setViewport');
    expect(j.steps.map((s: any) => s.type)).toEqual(expect.arrayContaining(['navigate', 'change', 'click', 'keyDown', 'keyUp']));
    const click = j.steps.find((s: any) => s.type === 'click' && JSON.stringify(s).includes('Submit'));
    expect(click.selectors.length).toBeGreaterThan(2);
    expect(j.title).toMatch(/consequential/);
    expect(JSON.stringify(j)).not.toContain('S3cret');
    // A custom dropdown is the opener click followed by the option click.
    const opt = j.steps.findIndex((s: any) => s.selectors?.[0]?.[0] === 'aria/Italy[role="option"]');
    expect(opt).toBeGreaterThan(0);
    expect(JSON.stringify(j.steps[opt - 1].selectors)).toContain('Country');

    // Defaults are opt-in like every other exporter: with no options nothing recorded is embedded...
    const noCustom = { ...plain, steps: plain.steps.filter((s) => !s.custom) };
    expect(rec.generate(noCustom)).not.toContain('Ada');
    // ...and a custom dropdown, which needs its option text, is refused rather than exported half done.
    expect(() => rec.generate(plain)).toThrow(/custom dropdown.*includeDefaults/);
    // Uploads and iframe steps cannot be represented in this format: refused with a pointer to the ones that can.
    expect(() => gen('puppeteer-replay', true)).toThrow(/iframe.*playwright-ts/);
    const up = new FlowBuilder({ id: 'f3', site: 'example.test', name: 'Up' });
    up.add({ action: 'upload', value: '/tmp/cv.pdf', fieldLabel: 'CV', url: 'https://example.test/a', locator: { tag: 'input', css: 'input[type=file]' } });
    expect(() => rec.generate(up.flow, { includeDefaults: true })).toThrow(/uploads a file.*selenium/);
  });

  it('a flow name cannot become a Python encoding declaration (PEP 263)', () => {
    const evil = sample();
    evil.name = 'x -*- coding: unicode_escape -*- \\x0aboom()';
    const pep263 = /^[ \t\f]*#.*?coding[:=][ \t]*([-\w.]+)/;
    for (const f of ['playwright-py', 'selenium-py']) {
      const [l1, l2] = getExporter(f)!.generate(evil, {}).split('\n');
      expect(pep263.test(l1!), f).toBe(false);
      expect(pep263.test(l2!), f).toBe(false);
    }
  });

  it('skill placeholders accept parameter names that start with a digit', () => {
    expect(paramName('2nd address line', 'x')).toBe('2nd_address_line');
    const steps = fillWorkflow({ name: 'w', inputs: { '2nd_address_line': { description: 'd' } }, steps: [{ tool: 'flow_run', args: { params: { '2nd_address_line': '{{2nd_address_line}}' } } }] }, { '2nd_address_line': 'Flat 4' });
    expect(steps[0]!.args).toEqual({ params: { '2nd_address_line': 'Flat 4' } });
  });

  it('neutral JSON round-trips through parseFlow', () => {
    expect(parseFlow(JSON.parse(gen('json'))).steps.length).toBe(flow.steps.length);
    expect(JSON.parse(gen('json')).params.every((p: any) => p.default === undefined)).toBe(true);
  });

  it('TypeScript output type-checks against the real playwright types', () => {
    const file = path.join(tmp, 'flow.ts');
    fs.writeFileSync(file, gen('playwright-ts', true));
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'));
    execFileSync(path.join(ROOT, 'node_modules/.bin/tsc'), ['--noEmit', '--strict', '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler', '--types', 'node', '--skipLibCheck', file], { stdio: 'pipe', cwd: tmp });
  });

  it('Python outputs compile', () => {
    for (const f of ['playwright-py', 'selenium-py']) {
      const file = path.join(tmp, `${f}.py`);
      fs.writeFileSync(file, gen(f, true));
      execFileSync('python3', ['-I', '-m', 'py_compile', file], { stdio: 'pipe' });
    }
  });

  it.skipIf(!fs.existsSync('/usr/bin/javac'))('Java output compiles against the selenium API shape', () => {
    // Only a syntax-level check: compile with stub classes standing in for the Selenium jars.
    const dir = path.join(tmp, 'java');
    fs.mkdirSync(path.join(dir, 'org/openqa/selenium/chrome'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'org/openqa/selenium/support/ui'), { recursive: true });
    const w = (p: string, s: string) => fs.writeFileSync(path.join(dir, p), s);
    w('org/openqa/selenium/By.java', 'package org.openqa.selenium; public class By { public static By id(String s){return null;} public static By name(String s){return null;} public static By cssSelector(String s){return null;} public static By xpath(String s){return null;} }');
    w('org/openqa/selenium/Keys.java', 'package org.openqa.selenium; public enum Keys implements CharSequence { ENTER, TAB, ESCAPE, ARROW_DOWN, ARROW_UP; public int length(){return 0;} public char charAt(int i){return 0;} public CharSequence subSequence(int a,int b){return "";} }');
    w('org/openqa/selenium/WebElement.java', 'package org.openqa.selenium; public interface WebElement { void click(); void clear(); void sendKeys(CharSequence... k); }');
    w('org/openqa/selenium/WebDriver.java', 'package org.openqa.selenium; import java.util.List; public interface WebDriver { void get(String u); List<WebElement> findElements(By b); void quit(); TargetLocator switchTo(); interface TargetLocator { WebDriver defaultContent(); WebDriver frame(WebElement e); WebElement activeElement(); } }');
    w('org/openqa/selenium/chrome/ChromeOptions.java', 'package org.openqa.selenium.chrome; public class ChromeOptions { public ChromeOptions addArguments(String... a){return this;} }');
    w('org/openqa/selenium/chrome/ChromeDriver.java', 'package org.openqa.selenium.chrome; import java.util.List; import org.openqa.selenium.*; public class ChromeDriver implements WebDriver { public ChromeDriver(ChromeOptions o){} public void get(String u){} public List<WebElement> findElements(By b){return null;} public void quit(){} public TargetLocator switchTo(){return null;} }');
    w('org/openqa/selenium/support/ui/Select.java', 'package org.openqa.selenium.support.ui; public class Select { public Select(org.openqa.selenium.WebElement e){} public void selectByVisibleText(String t){} }');
    w('Flow.java', gen('selenium-java', true));
    execFileSync('javac', ['-d', path.join(dir, 'out'), ...['org/openqa/selenium/By.java', 'org/openqa/selenium/Keys.java', 'org/openqa/selenium/WebElement.java', 'org/openqa/selenium/WebDriver.java', 'org/openqa/selenium/chrome/ChromeOptions.java', 'org/openqa/selenium/chrome/ChromeDriver.java', 'org/openqa/selenium/support/ui/Select.java', 'Flow.java']], { cwd: dir, stdio: 'pipe' });
  });
});
