import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cascadeDecider, layaDecider, layaRequest, parseLaya, rankCandidates } from '../../apps/mcp-server/src/decider.js';
import { parseRows, type DecideRequest, type DecideResult, type Observation } from '../../apps/mcp-server/src/goal-runner.js';

const rows = parseRows([
  '1 | a | Home | r:1', '2 | a | Help | r:2',
  '3 | input:text [empty] | First name | r:3', '4 | input:text [filled] | Last name | r:4',
  '5 | select [empty] | Birth month | r:5', '6 | button | Submit | r:6', '7 | button (disabled) | Delete | r:7',
]);
const obs: Observation = { url: 'https://x.test/signup', rows, traceRows: [], notes: ['Create your account'], notesKey: '', host: 'x.test', pathPattern: '/signup', sig: '' };
const req = (over: Partial<DecideRequest> = {}): DecideRequest => ({ goal: 'Fill the signup form and submit it', inputKeys: ['first name', 'birth month'], obs, recent: [], examples: [], notes: [], signal: new AbortController().signal, ...over });

describe('Laya request', () => {
  it('shortlists relevant, enabled controls in page order', () => {
    const c = rankCandidates(rows, 'fill first name and birth month', ['first name'], 3).map((r) => r.n);
    expect(c).toContain(3); // First name: matches the goal and is empty
    expect(c).toContain(5); // Birth month: matches the goal and is empty
    expect(c).toEqual([...c].sort((a, b) => a - b));
    expect(c).not.toContain(1); // a nav link that matches nothing loses to fields
    expect(rankCandidates(rows, 'x', [], 50).map((r) => r.n)).not.toContain(7); // disabled never offered
  });

  it('asks op, target and value as typed choice questions, with labels only (no input values) and at least two options each', () => {
    const { body, candidates } = layaRequest(req({ inputKeys: ['first name'] }), 'laya', 30) as { body: any; candidates: unknown[] };
    expect(body.model).toBe('laya');
    expect(Object.keys(body.questions)).toEqual(['op', 'target', 'value']);
    expect(Object.keys(body.questions.op.criteria)).toEqual(['CLICK', 'TYPE', 'SELECT', 'SCROLL_DOWN', 'DONE', 'BLOCKED']);
    expect(Object.keys(body.questions.target.criteria).length).toBe(candidates.length);
    expect(body.questions.value.criteria).toEqual({ 'first name': 'the first name', none: 'no value' });
    expect(body.state).toContain('Page says: Create your account');
    expect(body.state.length).toBeLessThan(600); // Laya's context is small
  });

  it('turns answers into a decision whose confidence is the weakest one it depends on', () => {
    expect(parseLaya({ op: { choice: 'TYPE', confidence: 0.9 }, target: { choice: 'c3', confidence: 0.6 }, value: { choice: 'first name', confidence: 0.8 } })).toEqual({ op: 'TYPE', target: 3, inputKey: 'first name', confidence: 0.6 });
    expect(parseLaya({ op: { choice: 'DONE', confidence: 0.7 }, target: { choice: 'c3', confidence: 0.1 } })).toEqual({ op: 'DONE', target: null, inputKey: null, confidence: 0.7 });
    expect(parseLaya({ op: { choice: 'CLICK', confidence: 0.9 }, target: { choice: 'none', confidence: 0.9 } }).target).toBeNull();
  });
});

describe('Laya over HTTP (fake Ollaya)', () => {
  let server: http.Server;
  let url: string;
  const seen: any[] = [];
  let mode: 'ok' | 'truncate-once' | 'not-found' = 'ok';
  beforeAll(async () => {
    server = http.createServer((rq, rs) => {
      let b = '';
      rq.on('data', (d) => (b += d));
      rq.on('end', () => {
        const body = JSON.parse(b);
        seen.push(body);
        if (mode === 'not-found') { rs.writeHead(404, { 'content-type': 'application/json' }); return rs.end(JSON.stringify({ error: 'x', code: 'MODEL_NOT_FOUND' })); }
        if (mode === 'truncate-once' && Object.keys(body.questions.target.criteria).length > 10) { rs.writeHead(422, { 'content-type': 'application/json' }); return rs.end(JSON.stringify({ error: 'x', code: 'STATE_TRUNCATED' })); }
        rs.writeHead(200, { 'content-type': 'application/json' });
        rs.end(JSON.stringify({ model: 'laya:en', answers: { op: { type: 'choice', choice: 'CLICK', confidence: 0.8, probabilities: {} }, target: { type: 'choice', choice: 'c6', confidence: 0.7, probabilities: {} } }, usage: { input_tokens: 1, output_tokens: 0 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const many = { ...obs, rows: parseRows(Array.from({ length: 40 }, (_, i) => `${i + 1} | button | Option ${i + 1} | r:${i + 1}`)) };

  it('posts to /v1/systemone and returns a Laya decision with its own threshold', async () => {
    mode = 'ok';
    const r = await layaDecider({ url, model: 'laya', minConfidence: 0.5, timeoutMs: 5000 })(req());
    expect(r).toMatchObject({ source: 'laya', minConfidence: 0.5, raw: { op: 'CLICK', target: 6, confidence: 0.7 } });
  });

  it('retries once with a shorter shortlist when the page does not fit Laya’s context', async () => {
    mode = 'truncate-once';
    seen.length = 0;
    await layaDecider({ url, model: 'laya', minConfidence: 0.5, timeoutMs: 5000 })(req({ obs: many }));
    expect(seen.map((b) => Object.keys(b.questions.target.criteria).length)).toEqual([30, 10]);
  });

  it('reports a missing model with the pull command', async () => {
    mode = 'not-found';
    await expect(layaDecider({ url, model: 'laya', minConfidence: 0.5, timeoutMs: 5000 })(req())).rejects.toThrow(/ollaya pull laya/);
  });
});

describe('cascade', () => {
  const laya = (conf: number | Error) => async (): Promise<DecideResult> => { if (conf instanceof Error) throw conf; return { raw: { op: 'CLICK', target: 6, inputKey: null, confidence: conf }, source: 'laya', minConfidence: 0.5 }; };
  const qwen = async (): Promise<DecideResult> => ({ raw: { op: 'DONE', target: null, inputKey: null, confidence: 0.9 }, source: 'qwen' });

  it('keeps a confident Laya pick', async () => {
    expect((await cascadeDecider(laya(0.8), qwen, 0.5)(req())).source).toBe('laya');
  });
  it('escalates to Qwen when Laya is unsure, saying why', async () => {
    const r = await cascadeDecider(laya(0.2), qwen, 0.5)(req());
    expect(r).toMatchObject({ source: 'qwen', escalated: 'laya unsure (0.20)' });
  });
  it('never lets Laya end a run on its own: DONE/BLOCKED are confirmed by Qwen', async () => {
    for (const op of ['DONE', 'BLOCKED']) {
      const r = await cascadeDecider(async () => ({ raw: { op, target: null, inputKey: null, confidence: 0.99 }, source: 'laya', minConfidence: 0.5 }), qwen, 0.5)(req());
      expect(r.source).toBe('qwen');
      expect(r.escalated).toMatch(new RegExp(`laya says ${op}`));
    }
  });

  it('sends a correction retry straight to Qwen', async () => {
    let called = 0;
    const r = await cascadeDecider(async () => { called++; return laya(0.9)(); }, qwen, 0.5)(req({ correction: 'bad pick' }));
    expect(r.source).toBe('qwen');
    expect(called).toBe(0);
  });
  it('skips Laya for a minute after a connection failure, but not after a per-page refusal', async () => {
    let t = 0;
    let calls = 0;
    const down = cascadeDecider(async () => { calls++; throw new Error('Cannot reach Ollaya'); }, qwen, 0.5, () => t);
    expect((await down(req())).escalated).toMatch(/laya error/);
    expect((await down(req())).escalated).toBe('laya unavailable');
    t = 61_000;
    await down(req());
    expect(calls).toBe(2);
    let refusals = 0;
    const refuse = cascadeDecider(async () => { refusals++; throw Object.assign(new Error('Laya refused'), { code: 'TOO_MANY_OPTIONS' }); }, qwen, 0.5);
    await refuse(req()); await refuse(req());
    expect(refusals).toBe(2);
  });
});
