import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    const r = new FlowRecorder(dir, { enabled: true }, now);
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

  it('writes private files', () => {
    const r = new FlowRecorder(dir, { enabled: true }, now);
    fill(r, 'a');
    const file = path.join(dir, `${r.list()[0]!.id}.json`);
    expect(fs.statSync(file).mode & 0o077).toBe(0);
  });
});
