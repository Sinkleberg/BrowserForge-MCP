import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HumanActionEventSchema, ExtensionMessageSchema } from '@browserforge/browser-protocol';
import { FlowRecorder } from '../../apps/mcp-server/src/flows/recorder.js';
import { HumanTraces, humanRunId, type HumanData } from '../../apps/mcp-server/src/flows/human.js';

const URL_ = 'https://jobs.example.com/apply/123456';
const TABLE = ['1 | input:text (editable) [empty] | First name', '2 | input:email (editable) [empty] | Email', '3 | button | Submit application'];
const act = (over: Partial<HumanData> = {}): HumanData => ({ at: 1, tabId: 3, kind: 'fill', url: URL_, locator: { label: 'First name', id: 'fname', css: 'form > input' }, fieldLabel: 'First name', row: 1, table: TABLE, ...over });

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bf-human-'));
const rm = (d: string) => { if (path.basename(d).startsWith('bf-human-')) fs.rmSync(d, { recursive: true, force: true }); };

describe('human action event', () => {
  const msg = (data: unknown) => ({ v: 1, type: 'event', event: 'human', data });
  it('is accepted from the extension, with sizes bounded', () => {
    expect(ExtensionMessageSchema.safeParse(msg(act())).success).toBe(true);
    expect(HumanActionEventSchema.safeParse(msg(act({ table: Array(500).fill('1 | button | x') }))).success).toBe(false);
    expect(HumanActionEventSchema.safeParse(msg(act({ kind: 'drag' as never }))).success).toBe(false);
    expect(HumanActionEventSchema.safeParse(msg(act({ value: 'x'.repeat(6000) }))).success).toBe(false);
  });
});

describe('FlowRecorder.handleHuman', () => {
  it('records the person in their own flow, marked human, with no value unless one was sent', () => {
    const dir = tmp();
    try {
      const rec = new FlowRecorder(dir, { enabled: true });
      const a = rec.handleHuman('br1', act())!;
      expect(a.isNew).toBe(true);
      expect(a.param).toBe('first_name');
      const b = rec.handleHuman('br1', act({ kind: 'fill', locator: { label: 'Email', id: 'email' }, fieldLabel: 'Email', row: 2, value: 'ada@example.com' }))!;
      expect(b.isNew).toBe(false);
      expect(b.flowId).toBe(a.flowId);
      const flow = rec.get(a.flowId)!;
      expect(flow.source).toBe('human');
      expect(flow.steps.map((s) => s.action)).toEqual(['navigate', 'fill', 'fill']);
      expect(flow.params.find((p) => p.name === 'first_name')!.default).toBeUndefined();
      expect(flow.params.find((p) => p.name === 'email')!.default).toBe('ada@example.com');
    } finally { rm(dir); }
  });

  it('never stores a value for a sensitive field, even if one is sent', () => {
    const dir = tmp();
    try {
      const rec = new FlowRecorder(dir, { enabled: true });
      const r = rec.handleHuman('br1', act({ locator: { label: 'Password' }, fieldLabel: 'Password', sensitive: true, value: 'hunter2' }))!;
      const flow = rec.get(r.flowId)!;
      expect(JSON.stringify(flow)).not.toContain('hunter2');
      expect(flow.params.find((p) => p.name === 'password')).toMatchObject({ sensitive: true });
      expect(flow.steps.at(-1)!.consequential).toBe(true);
    } finally { rm(dir); }
  });

  it('keeps people and agents apart, and starts a new task after a submit and a pause', () => {
    const dir = tmp();
    try {
      let t = Date.parse('2026-10-31T10:00:00Z');
      const rec = new FlowRecorder(dir, { enabled: true }, () => t);
      rec.handle('br1', 'navigate', {}, { url: URL_ }, undefined);
      const first = rec.handleHuman('br1', act())!;
      expect(rec.list().filter((f) => f.site === 'jobs.example.com')).toHaveLength(2); // the agent's flow and the person's
      rec.handleHuman('br1', act({ kind: 'click', locator: { role: 'button', name: 'Submit application' }, row: 3, consequential: true }));
      t += 5_000; // clicking around the confirmation page does not start a new task
      expect(rec.handleHuman('br1', act({ kind: 'click', locator: { text: 'Back' }, row: 3 }))!.flowId).toBe(first.flowId);
      t += 60_000; // a pause after a submit: the next thing is a new task
      const next = rec.handleHuman('br1', act())!;
      expect(next.flowId).not.toBe(first.flowId);
      expect(next.isNew).toBe(true);
    } finally { rm(dir); }
  });

  it('does nothing when flow recording is off', () => {
    const dir = tmp();
    try { expect(new FlowRecorder(dir, { enabled: false }).handleHuman('br1', act())).toBeUndefined(); } finally { rm(dir); }
  });
});

describe('HumanTraces', () => {
  it('turns an action into the same page-to-step example the models learn from, without any typed value', () => {
    const h = new HumanTraces();
    const s = h.step(act({ value: 'Ada-secret-name', task: 'Apply for the job' }), 'jobs.example.com/20261031T100000', 'first_name')!;
    expect(s.source).toBe('human');
    expect(s.decision).toMatchObject({ op: 'TYPE', target: 1, targetLabel: 'First name', inputKey: 'first_name' });
    expect(s.inputKeys).toEqual(['first_name']);
    expect(s.goal).toBe('Apply for the job');
    expect(s.table).toEqual(TABLE);
    expect(s.pathPattern).toBe('/apply/{id}');
    expect(JSON.stringify(s)).not.toContain('Ada-secret-name');
    expect(s.runId).toBe(humanRunId('jobs.example.com/20261031T100000'));
    expect(s.runId.length).toBeLessThanOrEqual(40);
  });

  it('scrubs emails and numbers out of labels, and keeps a short history', () => {
    const h = new HumanTraces();
    const table = ['1 | button | Send to ada@example.com', '2 | input:tel | Call +39 333 000 0000'];
    const a = h.step(act({ kind: 'click', row: 1, table }), 'f/1', undefined)!;
    expect(JSON.stringify(a.table)).not.toMatch(/ada@example|333 000/);
    const b = h.step(act({ kind: 'click', row: 1, table }), 'f/1', undefined)!;
    expect(b.recent).toHaveLength(1);
    expect(b.decision.op).toBe('CLICK');
    expect(b.decision.inputKey).toBeNull();
  });

  it('makes no example without a table, a row inside it, or a supported action', () => {
    const h = new HumanTraces();
    expect(h.step(act({ table: undefined }), 'f', 'p')).toBeUndefined();
    expect(h.step(act({ row: 9 }), 'f', 'p')).toBeUndefined();
    expect(h.step(act({ kind: 'press', key: 'Enter' }), 'f', undefined)).toBeUndefined();
    expect(h.step(act({ kind: 'upload' }), 'f', 'file')).toBeUndefined();
  });
});
