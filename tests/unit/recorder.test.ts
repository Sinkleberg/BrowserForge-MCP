import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FlowBuilder, type Flow } from '@browserforge/flows';
import { FlowRecorder } from '../../apps/mcp-server/src/flows/recorder.js';

let dir: string;
let t: number;
const now = () => t;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-rec-')); t = Date.parse('2026-10-30T10:00:00Z'); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const part = (extra: Record<string, unknown> = {}) => ({ url: 'https://a.test/form', locator: { tag: 'input', label: 'Email', css: '#e' }, fieldLabel: 'Email', ...extra });
const fill = (r: FlowRecorder, v: string, extra: Record<string, unknown> = {}, browser = 'b1') => r.handle(browser, 'type', { text: v }, { typed: v.length }, [part(extra)]);

describe('FlowRecorder', () => {
  it('records one flow per site with parameters, starting from the page the first action happened on', () => {
    const r = new FlowRecorder(dir, { enabled: true, storeValues: true }, now);
    fill(r, 'ada@example.com');
    r.handle('b1', 'click', { ref: 'x' }, { clicked: true }, [part({ locator: { tag: 'button', role: 'button', name: 'Next' }, fieldLabel: undefined })]);
    const [s] = r.list();
    expect(s).toMatchObject({ site: 'a.test', steps: 3, params: 1, consequential: 0 });
    const f = r.get(s!.id)!;
    expect(f.steps.map((x) => x.action)).toEqual(['navigate', 'fill', 'click']);
    expect(f.steps[0]!.url).toBe('https://a.test/form');
    expect(f.params[0]).toMatchObject({ name: 'email', default: 'ada@example.com', sensitive: false });
  });

  it('never keeps the value of a sensitive field, and treats type+submit as typing then a consequential Enter', () => {
    const r = new FlowRecorder(dir, { enabled: true }, now);
    r.handle('b1', 'type', { text: 'hunter2hunter2', submit: true }, {}, [part({ sensitive: true, fieldLabel: 'Password', consequential: true })]);
    const f = r.get(r.list()[0]!.id)!;
    expect(JSON.stringify(f)).not.toContain('hunter2');
    expect(f.params[0]).toMatchObject({ name: 'password', sensitive: true });
    expect(f.steps.slice(-2).map((s) => [s.action, s.key ?? null, s.consequential])).toEqual([['fill', null, true], ['press', 'Enter', true]]);
    expect(fs.readdirSync(dir, { recursive: true }).join(' ')).not.toContain('hunter2');
  });

  it('starts a new flow after a submit when the agent opens another page, after 30 idle minutes, and for another site', () => {
    const r = new FlowRecorder(dir, { enabled: true }, now);
    fill(r, 'a');
    r.handle('b1', 'click', {}, {}, [part({ consequential: true, locator: { text: 'Send' }, fieldLabel: undefined })]);
    r.handle('b1', 'click', {}, {}, [part({ locator: { text: 'Back to form' }, fieldLabel: undefined })]); // still the same task
    expect(r.list().length).toBe(1);
    t += 1000;
    r.handle('b1', 'navigate', { url: 'https://a.test/other' }, { url: 'https://a.test/other' }, undefined);
    expect(r.list().length).toBe(1); // only looking at a page is not worth a file
    fill(r, 'second', { url: 'https://a.test/other' });
    expect(r.list().length).toBe(2);
    t += 31 * 60_000;
    fill(r, 'late', { url: 'https://a.test/other' });
    expect(r.list().length).toBe(3);
    t += 1000;
    fill(r, 'elsewhere', { url: 'https://b.test/x' });
    expect(new Set(r.list().map((x) => x.site))).toEqual(new Set(['a.test', 'b.test']));
  });

  it('groups iframe actions under the page the tab shows, and keeps browsers apart', () => {
    const r = new FlowRecorder(dir, { enabled: true }, now);
    r.handle('b1', 'type', { text: 'v' }, {}, [part({ url: 'https://widgets.cdn.test/frame', frameUrl: 'https://widgets.cdn.test/frame', pageUrl: 'https://a.test/form' })]);
    expect(r.list()).toMatchObject([{ site: 'a.test' }]);
    const f = r.get(r.list()[0]!.id)!;
    expect(f.steps[1]!.frame?.url).toBe('https://widgets.cdn.test/frame');
    fill(r, 'other browser', {}, 'b2');
    expect(r.list().length).toBe(2);
  });

  it('records nothing when disabled or suspended (replay), and ignores reads and actions without elements', () => {
    const r = new FlowRecorder(dir, { enabled: false }, now);
    fill(r, 'x');
    expect(r.list()).toEqual([]);
    r.enabled = true;
    r.handle('b1', 'scroll', {}, {}, undefined);
    r.handle('b1', 'tabs_select', {}, {}, []);
    expect(r.list()).toEqual([]);
    void r.suspend(async () => { fill(r, 'during replay'); });
    expect(r.list()).toEqual([]);
  });

  it('saves, names and deletes flows, refuses path-like ids, and cleans up old unnamed recordings', () => {
    const r = new FlowRecorder(dir, { enabled: true }, now);
    fill(r, 'a');
    const id = r.list()[0]!.id;
    expect(r.save(id, 'Contact form')).toMatchObject({ name: 'Contact form', saved: true });
    expect(r.list()[0]).toMatchObject({ name: 'Contact form', saved: true });
    expect(() => r.get('../../etc/passwd')).not.toThrow(); // returns undefined, never reads outside
    expect(r.get('../../etc/passwd')).toBeUndefined();
    expect(r.delete(id)).toBe(true);
    expect(r.list()).toEqual([]);
    fill(r, 'old'); // unnamed
    fill(r, 'kept-name', {}, 'b9');
    const keep = r.list().find((x) => x.steps === 2 && x.params === 1)!;
    void keep;
    const later = new FlowRecorder(dir, { enabled: true }, () => t + 40 * 86_400_000);
    expect(later.list().filter((x) => !x.saved)).toEqual([]);
  });

  describe('one task per tab', () => {
    const click = (r: FlowRecorder, extra: Record<string, unknown> = {}, browser = 'b1') => r.handle(browser, 'click', {}, {}, [part({ locator: { text: 'Go' }, fieldLabel: undefined, ...extra })]);

    it('keeps agents working in different tabs of one browser apart', () => {
      const r = new FlowRecorder(dir, { enabled: true }, now);
      fill(r, 'tab one', { tabId: 1 });
      fill(r, 'tab two', { tabId: 2 });
      fill(r, 'tab one again', { tabId: 1, locator: { tag: 'input', label: 'Name', css: '#n' }, fieldLabel: 'Name' });
      const flows = r.list();
      expect(flows.length).toBe(2);
      expect(flows.map((f) => f.params).sort()).toEqual([1, 2]);
    });

    it('takes the tab from the tool arguments or the result when the page did not report it', () => {
      const r = new FlowRecorder(dir, { enabled: true }, now);
      r.handle('b1', 'type', { text: 'a', tabId: 7 }, {}, [part()]);
      r.handle('b1', 'type', { text: 'b' }, { tabId: 8 }, [part()]);
      expect(r.list().length).toBe(2);
    });

    it('keeps one task together across sibling hosts and redirects, and records the hosts', () => {
      const r = new FlowRecorder(dir, { enabled: true }, now);
      fill(r, 'a', { url: 'https://joblink.allibo.com/ats4/job-offer.aspx?ID=5' });
      fill(r, 'b', { url: 'https://am.allibo.com/web/ApplicationV2', locator: { tag: 'input', label: 'Phone', css: '#p' }, fieldLabel: 'Phone' });
      expect(r.list().length).toBe(1);
      expect(r.get(r.list()[0]!.id)!.hosts).toEqual(['joblink.allibo.com', 'am.allibo.com']);
      click(r, { url: 'https://am.allibo.com/web/ApplicationV2' });
      t += 1000; // the site sends the person to an unrelated host right after the click
      fill(r, 'c', { url: 'https://forms.other.test/x', locator: { tag: 'input', label: 'City', css: '#c' }, fieldLabel: 'City' });
      expect(r.list().length).toBe(1);
      t += 60_000; // a host change long after the last click is another task
      fill(r, 'd', { url: 'https://third.test/y', locator: { tag: 'input', label: 'Zip', css: '#z' }, fieldLabel: 'Zip' });
      expect(r.list().length).toBe(2);
    });

    it('starts a new flow when the agent opens a different job page in the same tab', () => {
      const r = new FlowRecorder(dir, { enabled: true }, now);
      const job = (id: number) => `https://joblink.allibo.com/ats4/job-offer.aspx?DM=1405&ID=${id}`;
      r.handle('b1', 'navigate', { url: job(1) }, { url: job(1) }, undefined);
      fill(r, 'a', { url: job(1) });
      r.handle('b1', 'navigate', { url: job(1) + '&LN=IT' }, { url: job(1) + '&LN=IT' }, undefined); // same job, other language: same task
      fill(r, 'a2', { url: job(1), locator: { tag: 'input', label: 'Phone', css: '#p' }, fieldLabel: 'Phone' });
      expect(r.list().length).toBe(1);
      r.handle('b1', 'navigate', { url: job(2) }, { url: job(2) }, undefined);
      fill(r, 'b', { url: job(2) });
      expect(r.list().length).toBe(2);
    });

    it('writes nothing for visits that only looked around', () => {
      const r = new FlowRecorder(dir, { enabled: true }, now);
      r.handle('b1', 'navigate', { url: 'https://a.test/1' }, { url: 'https://a.test/1' }, undefined);
      r.handle('b1', 'navigate', { url: 'https://a.test/2' }, { url: 'https://a.test/2' }, undefined);
      click(r);
      click(r);
      expect(r.list()).toEqual([]);
      expect(fs.readdirSync(dir)).toEqual([]);
      click(r, { consequential: true }); // a submit is worth keeping
      expect(r.list()).toHaveLength(1);
    });

    it('collapses the pages visited before the first action to the last one', () => {
      const r = new FlowRecorder(dir, { enabled: true }, now);
      for (const u of ['https://a.test/1', 'https://a.test/2', 'https://a.test/form']) r.handle('b1', 'navigate', { url: u }, { url: u }, undefined);
      fill(r, 'x', { url: 'https://a.test/form' });
      expect(r.get(r.list()[0]!.id)!.steps.map((s) => [s.action, s.url ?? null])).toEqual([['navigate', 'https://a.test/form'], ['fill', 'https://a.test/form']]);
    });

    it('never records ignored hosts or private windows', () => {
      const r = new FlowRecorder(dir, { enabled: true }, now);
      fill(r, 'mail', { url: 'https://mail.google.com/mail/u/0/' });
      fill(r, 'feed', { url: 'https://www.linkedin.com/feed/' });
      fill(r, 'private', { incognito: true });
      expect(r.list()).toEqual([]);
      fill(r, 'job form', { url: 'https://www.linkedin.com/jobs/view/123' }); // only the feed is ignored on linkedin
      expect(r.list()).toHaveLength(1);
      const custom = new FlowRecorder(fs.mkdtempSync(path.join(dir, 'c-')), { enabled: true, ignore: ['a.test/private'] }, now);
      fill(custom, 'x', { url: 'https://a.test/private/1' });
      fill(custom, 'y', { url: 'https://a.test/public' });
      expect(custom.list()).toHaveLength(1);
    });

    it('marks a flow left without a submit as incomplete, but not one that ended in a submit', () => {
      const r = new FlowRecorder(dir, { enabled: true }, now);
      fill(r, 'abandoned', { url: 'https://a.test/one' });
      t += 31 * 60_000;
      fill(r, 'sent', { url: 'https://a.test/two' });
      click(r, { consequential: true, url: 'https://a.test/two' });
      t += 31 * 60_000;
      fill(r, 'next', { url: 'https://a.test/three' });
      const by = Object.fromEntries(r.list().map((s) => [s.steps, r.get(s.id)!.outcome ?? null]));
      expect(Object.values(by).filter((o) => o === 'incomplete')).toHaveLength(1);
      expect(r.list().map((s) => r.get(s.id)!).filter((f) => f.steps.some((x) => x.consequential)).map((f) => f.outcome ?? null)).toEqual([null]);
    });

    it('puts a verdict on the flow of the tab that submitted', () => {
      const r = new FlowRecorder(dir, { enabled: true }, now);
      fill(r, 'a', { tabId: 1 });
      fill(r, 'b', { tabId: 2 });
      r.setOutcome('b1', 'success', 2);
      const outcomes = r.list().map((s) => r.get(s.id)!.outcome ?? null).sort();
      expect(outcomes).toEqual([null, 'success']);
      r.setOutcome('b1', 'failure'); // no tab known: the most recently touched flow
      expect(r.list().map((s) => r.get(s.id)!.outcome ?? null).sort()).toEqual(['failure', 'success']);
    });

    it('gives two flows started in the same second different ids', () => {
      const r = new FlowRecorder(dir, { enabled: true }, now);
      fill(r, 'a', { tabId: 1 });
      fill(r, 'b', { tabId: 2 });
      expect(new Set(r.list().map((s) => s.id)).size).toBe(2);
    });
  });

  describe('named tasks and outcomes', () => {
    const nav = (r: FlowRecorder, url: string, tabId?: number) => r.handle('b1', 'navigate', { url, ...(tabId === undefined ? {} : { tabId }) }, { url, ...(tabId === undefined ? {} : { tabId }) }, undefined);
    const nameField = { locator: { tag: 'input', label: 'Name', css: '#n' }, fieldLabel: 'Name' };

    it('records a named task as one flow across hosts, submits and other jobs, and the agent outcome is final', () => {
      const r = new FlowRecorder(dir, { enabled: true }, now);
      const id = r.beginTask('b1', 5, { name: 'Apply: Acme dev', startUrl: 'https://jobs.acme.test/j/123456', params: { first_name: 'Ada' } });
      nav(r, 'https://jobs.acme.test/j/123456', 5);
      fill(r, 'Ada', { tabId: 5, url: 'https://jobs.acme.test/j/123456', ...nameField });
      r.handle('b1', 'click', {}, {}, [part({ tabId: 5, url: 'https://jobs.acme.test/j/123456', consequential: true, locator: { text: 'Apply' }, fieldLabel: undefined })]);
      nav(r, 'https://jobs.acme.test/j/999999', 5); // a different job would normally start a new flow
      fill(r, 'x', { tabId: 5, url: 'https://forms.other.test/step2', locator: { tag: 'input', label: 'City', css: '#c' }, fieldLabel: 'City' });
      expect(r.list()).toHaveLength(1);
      const end = r.endTask(id, 'success', { note: 'confirmation page', save: true })!;
      expect(end.written).toBe(true);
      const f = r.get(end.flowId!)!;
      expect(f).toMatchObject({ name: 'Apply: Acme dev', outcome: 'success', outcomeBy: 'agent', saved: true, task: { name: 'Apply: Acme dev', note: 'confirmation page' } });
      expect(f.params.map((p) => p.name)).toContain('first_name'); // named after the task parameter
      expect(f.params.find((p) => p.name === 'first_name')!.default).toBeUndefined();
      expect(JSON.stringify(f)).not.toContain('Ada');
      r.setOutcome('b1', 'failure', 5, 'verify'); // a later automatic guess cannot overrule the agent
      expect(r.get(f.id)!.outcome).toBe('success');
      expect(r.endTask(id, 'failure')).toBeUndefined(); // ended tasks cannot be ended twice
    });

    it('lets a newer automatic check replace an older one (fix the form, submit again)', () => {
      const r = new FlowRecorder(dir, { enabled: true }, now);
      fill(r, 'a');
      r.setOutcome('b1', 'failure', undefined, 'verify');
      r.setOutcome('b1', 'success', undefined, 'auto');
      expect(r.get(r.list()[0]!.id)!.outcome).toBe('success');
    });

    it('attaches a task begun without a tab to the first tab that acts, and gives it the site of that action', () => {
      const r = new FlowRecorder(dir, { enabled: true }, now);
      const id = r.beginTask('b1', undefined, { name: 'Dry run', dryRun: true, tags: ['allibo'] });
      fill(r, 'x', { tabId: 9, url: 'https://joblink.allibo.com/ats4/job-offer.aspx?ID=5' });
      const end = r.endTask(id, 'dry_run')!;
      const f = r.get(end.flowId!)!;
      expect(f).toMatchObject({ site: 'joblink.allibo.com', outcome: 'dry_run', task: { dryRun: true, tags: ['allibo'] } });
      expect(f.id.startsWith('joblink.allibo.com/')).toBe(true);
    });

    it('leaves no file for a task where nothing happened, and a tab opened by the task joins it', () => {
      const r = new FlowRecorder(dir, { enabled: true }, now);
      const a = r.beginTask('b1', 1, { name: 'Looked only' });
      nav(r, 'https://a.test/x', 1);
      expect(r.endTask(a, 'failure', { note: 'closed' })).toMatchObject({ written: false });
      expect(r.list()).toEqual([]);
      const b = r.beginTask('b1', 1, { name: 'Popup' });
      fill(r, 'a', { tabId: 1 });
      t += 2000;
      fill(r, 'b', { tabId: 2, openerTabId: 1, locator: { tag: 'input', label: 'Zip', css: '#z' }, fieldLabel: 'Zip' });
      expect(r.endTask(b, 'success')).toMatchObject({ written: true });
      expect(r.list()).toHaveLength(1);
    });

    it('closes a task nobody ended as incomplete once another task begins long after', () => {
      const r = new FlowRecorder(dir, { enabled: true }, now);
      r.beginTask('b1', 1, { name: 'Forgotten' });
      fill(r, 'a', { tabId: 1 });
      t += 31 * 60_000;
      r.beginTask('b1', 2, { name: 'Next' });
      expect(r.get(r.list()[0]!.id)!.outcome).toBe('incomplete');
    });

    it('counts replays on the flow', () => {
      const r = new FlowRecorder(dir, { enabled: true }, now);
      fill(r, 'a');
      const id = r.list()[0]!.id;
      r.recordRun(id, true);
      r.recordRun(id, false, 3);
      expect(r.get(id)!.runs).toMatchObject({ count: 2, ok: 1, lastFailedStep: 3 });
      r.recordRun('a.test/20000101T000000', true); // unknown id: ignored
    });

    it('keeps no personal value by default, keeps harmless answers, and keeps everything when asked', () => {
      const r = new FlowRecorder(dir, { enabled: true }, now);
      fill(r, 'ada@example.com'); // Email
      fill(r, 'Italian', { locator: { tag: 'select', label: 'Preferred language', css: '#l' }, fieldLabel: 'Preferred language' });
      const f = r.get(r.list()[0]!.id)!;
      expect(f.params.find((p) => p.name === 'email')!.default).toBeUndefined();
      expect(f.params.find((p) => p.name === 'preferred_language')!.default).toBe('Italian');
      expect(JSON.stringify(f)).not.toContain('ada@example.com');
      const keep = new FlowRecorder(fs.mkdtempSync(path.join(dir, 'k-')), { enabled: true, storeValues: true }, now);
      fill(keep, 'ada@example.com');
      expect(keep.get(keep.list()[0]!.id)!.params[0]!.default).toBe('ada@example.com');
    });

    it('removes tokens from addresses and e-mail addresses from labels, and names parameters after the field, not a generic label', () => {
      const r = new FlowRecorder(dir, { enabled: true }, now);
      fill(r, '0712345678', { url: 'https://joblink.allibo.com/ats4/form.aspx?ID=5&t=SECRETTOKEN&aid=777', locator: { tag: 'input', label: 'autocompile', nameAttr: 'inPhone', css: '#p', text: 'Mail ada@example.com' }, fieldLabel: 'autocompile' });
      const text = JSON.stringify(r.get(r.list()[0]!.id));
      expect(text).not.toContain('SECRETTOKEN');
      expect(text).not.toContain('aid=777');
      expect(text).not.toContain('ada@example.com');
      expect(text).toContain('ID=5');
      expect(r.get(r.list()[0]!.id)!.params[0]!.name).toBe('phone');
    });
  });

  describe('retention and pruning', () => {
    const DAY = 86_400_000;
    const later = (days: number) => new FlowRecorder(dir, { enabled: true }, () => t + days * DAY);
    const make = (site: string, build: (b: FlowBuilder) => void, extra: Partial<Flow> = {}): Flow => {
      const b = new FlowBuilder({ id: `${site}/pending`, site, now: new Date(t) });
      b.navigate(`https://${site}/start`, t);
      build(b);
      return { ...b.flow, ...extra };
    };
    const fillName = (b: FlowBuilder, value = 'Ada') => b.add({ action: 'fill', value, fieldLabel: 'First name', locator: { tag: 'input', label: 'First name', css: '#f' }, url: 'https://x.test/f' });
    const submit = (b: FlowBuilder) => b.add({ action: 'click', locator: { role: 'button', name: 'Send' }, consequential: true, url: 'https://x.test/f' });

    it('drops old unnamed recordings and unfinished ones with almost nothing in them, but never saved flows or successes', () => {
      const r = new FlowRecorder(dir, { enabled: true }, now);
      fill(r, 'abandoned', { tabId: 1 });
      t += 31 * 60_000;
      fill(r, 'again', { tabId: 1 }); // the first flow is left unfinished: incomplete
      fill(r, 'sent', { tabId: 2 });
      r.setOutcome('b1', 'success', 2);
      fill(r, 'named', { tabId: 3 });
      r.save(r.list().find((x) => x.params === 1 && !x.outcome && x.id !== r.list().at(-1)!.id)!.id, 'Kept by name');
      const before = r.list();
      expect(before.length).toBe(4);
      expect(later(4).list().length).toBe(3); // 4 days on: only the incomplete, tiny one goes
      expect(later(45).list().map((x) => x.outcome ?? (x.saved ? 'saved' : 'plain')).sort()).toEqual(['saved', 'success']); // 45 days on: unnamed, unfinished recordings are gone
    });

    it('keeps at most 50 unnamed recordings per site, newest first', () => {
      const r = new FlowRecorder(dir, { enabled: true }, now);
      for (let i = 1; i <= 55; i++) { t += 1000; fill(r, `v${i}`, { tabId: i }); }
      expect(r.list().length).toBe(55);
      const trimmed = later(0).list();
      expect(trimmed.length).toBe(50);
      expect(trimmed.every((x) => Date.parse(x.createdAt) > Date.parse('2026-10-30T10:00:05Z'))).toBe(true);
    });

    it('prune reports by default and changes nothing, then deletes browsing, scrubs values and tokens, and flags mixed tasks', () => {
      const r = new FlowRecorder(dir, { enabled: true }, now);
      const browse = r.store(make('careerjet.it', () => undefined));
      const recordedByAnOlderVersion = make('x.test', (b) => { fillName(b, 'Ada'); b.add({ action: 'click', locator: { text: 'x' }, url: 'https://x.test/f' }); });
      recordedByAnOlderVersion.params[0]!.default = 'Ada';
      recordedByAnOlderVersion.steps[2] = { ...recordedByAnOlderVersion.steps[2]!, url: 'https://x.test/f?t=SECRET', locator: { text: 'Mail ada@example.com' } };
      const personal = r.store(recordedByAnOlderVersion);
      const mixed = r.store(make('jobs.test', (b) => { for (const id of [111, 222]) b.add({ action: 'fill', value: 'Yes', fieldLabel: 'Relocate', locator: { tag: 'input', label: 'Relocate', css: `#r${id}` }, url: `https://jobs.test/job?ID=${id}` }); }));
      const saved = r.store(make('careerjet.it', () => undefined, { saved: true }));
      const report = r.prune({ apply: false });
      const by = (id: string) => report.filter((i) => i.id === id).map((i) => i.action);
      expect(by(browse.id)).toEqual(['delete']);
      expect(by(personal.id)).toEqual(['scrub']);
      expect(by(mixed.id)).toContain('flag');
      expect(by(saved.id)).toEqual([]); // saved flows are left alone
      expect(r.list().length).toBe(4);
      expect(JSON.stringify(r.get(personal.id))).toContain('SECRET'); // a report changes nothing

      const done = r.prune({ apply: true });
      expect(done.length).toBe(report.length);
      expect(r.get(browse.id)).toBeUndefined();
      expect(r.get(saved.id)).toBeDefined();
      const text = JSON.stringify(r.get(personal.id));
      expect(text).not.toMatch(/SECRET|ada@example.com/);
      expect(r.get(personal.id)!.params[0]!.default).toBeUndefined();
      expect(r.prune({ apply: true }).filter((i) => i.action !== 'flag')).toEqual([]); // nothing left to do
    });

    it('suggests merging a task that succeeded three times, but not merged flows', () => {
      const r = new FlowRecorder(dir, { enabled: true }, now);
      for (let i = 0; i < 3; i++) r.store(make('apply.test', (b) => { fillName(b, 'Ada'); submit(b); }, { outcome: 'success' }));
      r.store(make('other.test', (b) => { fillName(b); submit(b); }, { outcome: 'success' }));
      r.store(make('apply.test', (b) => { fillName(b); submit(b); }, { outcome: 'success', derivedFrom: ['a/1', 'a/2'] }));
      expect(r.hints()).toMatchObject([{ site: 'apply.test', count: 3, suggest: 'flow_consolidate' }]);
    });
  });

  it('writes private files', () => {
    const r = new FlowRecorder(dir, { enabled: true }, now);
    fill(r, 'a');
    const file = path.join(dir, `${r.list()[0]!.id}.json`);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);
  });
});
