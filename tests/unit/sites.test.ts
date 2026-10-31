import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CARD_MAX, SiteStore, TraceStore, type TraceStep } from '@browserforge/knowledge';

const roots: string[] = [];
const tmp = () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-sites-'));
  roots.push(r);
  return r;
};
afterEach(() => {
  for (const r of roots.splice(0)) if (path.basename(r).startsWith('bf-sites-')) fs.rmSync(r, { recursive: true, force: true });
});

describe('SiteStore', () => {
  it('says nothing about an unknown site and something once it has learned', () => {
    const s = new SiteStore(tmp());
    expect(s.card('example.com')).toBeUndefined();
    s.visit('example.com');
    expect(s.card('example.com')).toBeUndefined(); // a visit alone is not worth an agent's tokens
    s.note('example.com', 'needs_account', 'sign in with Google');
    expect(s.card('example.com')).toMatch(/needs account: sign in with Google/);
  });

  it('counts repeats instead of duplicating, and keeps results', () => {
    const s = new SiteStore(tmp());
    s.note('a.test', 'captcha', 'on submit');
    s.note('a.test', 'captcha', 'on submit');
    s.outcome('a.test', 'success');
    s.outcome('a.test', 'failure');
    const k = s.get('a.test')!;
    expect(k.pitfalls).toHaveLength(1);
    expect(k.pitfalls[0]!.count).toBe(2);
    expect(s.card('a.test')).toMatch(/1 ok, 1 failed/);
    expect(s.card('a.test')).toMatch(/captcha: on submit \(x2\)/);
  });

  it('survives a restart, keeps the file private, and scrubs personal details', () => {
    const dir = tmp();
    new SiteStore(dir).note('b.test', 'note', 'ask for ada@example.com or +39 333 000 0000');
    const again = new SiteStore(dir);
    const detail = again.get('b.test')!.pitfalls[0]!.detail;
    expect(detail).not.toContain('ada@example.com');
    expect(detail).not.toMatch(/333/);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, 'sites', 'b.test.json')).mode & 0o777).toBe(0o600);
  });

  it('keeps the card short and the store bounded', () => {
    const s = new SiteStore(tmp());
    for (let i = 0; i < 60; i++) s.note('c.test', 'note', `tip number ${i} ${'x'.repeat(150)}`);
    for (let i = 0; i < 30; i++) s.addFlow('c.test', `c.test/2026010${i % 10}T000000-${i}`);
    expect(s.get('c.test')!.pitfalls.length).toBeLessThanOrEqual(20);
    expect(s.get('c.test')!.flows.length).toBeLessThanOrEqual(8);
    expect(s.card('c.test')!.length).toBeLessThanOrEqual(CARD_MAX);
  });

  it('refuses hosts that could escape the folder, and does nothing when switched off', () => {
    const dir = tmp();
    const s = new SiteStore(dir);
    s.note('../evil', 'note', 'x');
    s.note('a/b', 'note', 'x');
    expect(fs.readdirSync(path.join(dir, 'sites'))).toEqual([]);
    const off = new SiteStore(tmp(), Date.now, false);
    off.note('d.test', 'note', 'x');
    expect(off.get('d.test')).toBeUndefined();
  });

  it('turns addresses into hosts', () => {
    expect(SiteStore.hostOf('https://Jobs.Example.com/a?b=1')).toBe('jobs.example.com');
    expect(SiteStore.hostOf('jobs.example.com')).toBe('jobs.example.com');
    expect(SiteStore.hostOf('')).toBeUndefined();
  });
});

describe('label judges', () => {
  const step = (runId: string): TraceStep => ({
    runId, at: Date.now(), promptVersion: 'v1', host: 'x.test', pathPattern: '/', goal: 'g', inputKeys: [], table: ['1 | button | Go'], recent: [], notesKey: '',
    decision: { op: 'CLICK', target: 1, targetLabel: 'Go', inputKey: null, confidence: 0.9 }, result: { ok: true, pageChanged: true, approvalDenied: false }, source: 'qwen',
  });

  it('never lets an automatic label replace the agent or the human, and survives a reload', () => {
    const dir = tmp();
    const t = new TraceStore(dir);
    t.record(step('r1'));
    t.label('r1', 'good', 'auto', 'auto');
    expect(t.labelOf('r1')).toBe('good');
    t.label('r1', 'bad', 'agent says no', 'agent');
    expect(t.labelOf('r1')).toBe('bad'); // the agent overrides the machine
    t.label('r1', 'good', 'auto again', 'auto');
    expect(t.labelOf('r1')).toBe('bad'); // ...and the machine cannot take it back
    t.label('r1', 'good', 'human', 'human');
    t.label('r1', 'bad', 'agent again', 'agent');
    expect(t.labelOf('r1')).toBe('good'); // the human outranks the agent
    expect(t.labelBy('r1')).toBe('human');
    const reloaded = new TraceStore(dir);
    expect(reloaded.labelOf('r1')).toBe('good');
    expect(reloaded.labelBy('r1')).toBe('human');
  });

  it('treats old label lines without a judge as the agent', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'traces.jsonl'), JSON.stringify(step('old')) + '\n');
    fs.writeFileSync(path.join(dir, 'labels.jsonl'), JSON.stringify({ label: { runId: 'old', value: 'good', at: Date.now() } }) + '\n');
    const t = new TraceStore(dir);
    expect(t.labelBy('old')).toBe('agent');
  });
});
