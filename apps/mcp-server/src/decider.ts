import { tokenize } from '@browserforge/knowledge';
import type { ServerConfig } from './context.js';
import { SYSTEM_PROMPT, TEXTISH, SELECTABLE, decisionSchema, qwenPrompt, rowKind, type Decide, type DecideRequest, type Row } from './goal-runner.js';

type Cfg = ServerConfig['decider'];

/** One constrained decision from a local Ollama model. `format` is a JSON schema, so the reply can only be a valid choice. */
export function ollamaDecider(cfg: Pick<Cfg, 'url' | 'model' | 'timeoutMs'>) {
  return async (system: string, user: string, schema: object, signal: AbortSignal): Promise<unknown> => {
    let res: Response;
    try {
      res = await fetch(`${cfg.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          stream: false,
          keep_alive: '10m',
          format: schema,
          options: { temperature: 0, num_predict: 120 },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(cfg.timeoutMs)]),
      });
    } catch (e) {
      if (signal.aborted) throw e;
      throw new Error(`Cannot reach the local model server at ${cfg.url} (is Ollama running?): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    if (!res.ok) throw new Error(`Local model server returned ${res.status}${res.status === 404 ? ` (is '${cfg.model}' pulled? try: ollama pull ${cfg.model})` : ''}`);
    const body = (await res.json()) as { message?: { content?: string } };
    try {
      return JSON.parse(body.message?.content ?? '');
    } catch {
      throw new Error('The local model did not return valid JSON');
    }
  };
}

/** Qwen (via Ollama) reads the whole numbered table and answers in JSON. */
export function qwenDecider(cfg: Pick<Cfg, 'url' | 'model' | 'timeoutMs'>): Decide {
  const chat = ollamaDecider(cfg);
  return async (req) => ({ raw: await chat(SYSTEM_PROMPT, qwenPrompt(req), decisionSchema(req.obs.rows.length, req.inputKeys), req.signal), source: 'qwen' });
}

// ---------- Laya (Ollaya decision model, /v1/systemone) ----------

const LAYA_OPS: Record<string, string> = {
  CLICK: 'click a button or link',
  TYPE: 'type one of the available values into an empty text field',
  SELECT: 'choose one of the available values in a dropdown',
  SCROLL_DOWN: 'scroll down to look for more controls',
  DONE: 'the goal is already complete',
  BLOCKED: 'cannot continue: login, captcha, error, or a needed value is missing',
};

/**
 * Laya's context is tiny (about 512 tokens for laya:en), so it gets a shortlist of the controls most likely to matter:
 * words shared with the goal and the input keys, empty fields first, then buttons; links and disabled controls last.
 */
export function rankCandidates(rows: Row[], goal: string, inputKeys: string[], max: number): Row[] {
  const words = new Set(tokenize(`${goal} ${inputKeys.join(' ')}`));
  const score = (r: Row) => {
    const overlap = tokenize(`${r.label} ${r.kind}`).filter((t) => words.has(t)).length;
    const fillable = TEXTISH.test(r.kind) || SELECTABLE.test(r.kind) || r.editable;
    return overlap * 2 + (fillable && r.state === 'empty' ? 2 : 0) + (fillable ? 1 : 0) + (r.kind === 'button' ? 0.5 : 0) - (r.kind === 'a' || r.kind === 'link' ? 0.5 : 0);
  };
  return rows
    .filter((r) => !r.disabled)
    .map((r) => ({ r, s: score(r) }))
    .sort((a, b) => b.s - a.s || a.r.n - b.r.n)
    .slice(0, max)
    .map((x) => x.r)
    .sort((a, b) => a.n - b.n);
}

const withNone = (c: Record<string, string>, none: string) => (Object.keys(c).length >= 2 ? c : { ...c, none });

/** The /v1/systemone request: three typed choice questions answered in one pass. */
export function layaRequest(req: DecideRequest, model: string, maxCandidates: number): { body: object; candidates: Row[] } {
  const candidates = rankCandidates(req.obs.rows, req.goal, req.inputKeys, maxCandidates);
  const state = [
    `Goal: ${req.goal}`,
    `Values available: ${req.inputKeys.length ? req.inputKeys.join(', ') : 'none'}`,
    `Page: ${req.obs.host}${req.obs.pathPattern}`,
    ...(req.obs.notes.length ? [`Page says: ${req.obs.notes.slice(0, 3).map((n) => n.slice(0, 60)).join(' / ')}`] : []),
    ...(req.recent.length ? [`Done so far: ${req.recent.slice(-3).join('; ')}`] : ['Done so far: nothing']),
  ].join('\n');
  const questions: Record<string, object> = {
    op: { type: 'choice', instructions: 'What is the single best next step toward the goal?', criteria: LAYA_OPS },
    target: { type: 'choice', instructions: 'Which control should that step act on?', criteria: withNone(Object.fromEntries(candidates.map((r) => [`c${r.n}`, `${rowKind(r)}: ${r.label.slice(0, 40) || '(no label)'}`])), 'no control') },
  };
  if (req.inputKeys.length) questions.value = { type: 'choice', instructions: 'Which available value does that step use?', criteria: withNone(Object.fromEntries(req.inputKeys.map((k) => [k, `the ${k}`])), 'no value') };
  return { body: { model, state, questions }, candidates };
}

interface LayaAnswer {
  choice?: string;
  confidence?: number;
}

/** Turn Laya's answers into the runner's decision shape; confidence is the weakest of the answers the step depends on. */
export function parseLaya(answers: Record<string, LayaAnswer>): { op: string; target: number | null; inputKey: string | null; confidence: number } {
  const op = answers.op?.choice ?? 'BLOCKED';
  const needsTarget = op === 'CLICK' || op === 'TYPE' || op === 'SELECT';
  const needsValue = op === 'TYPE' || op === 'SELECT';
  const t = answers.target?.choice;
  const v = answers.value?.choice;
  const confs = [answers.op?.confidence ?? 0, ...(needsTarget ? [answers.target?.confidence ?? 0] : []), ...(needsValue ? [answers.value?.confidence ?? 0] : [])];
  return {
    op,
    target: needsTarget && t && t !== 'none' ? Number(t.slice(1)) : null,
    inputKey: needsValue && v && v !== 'none' ? v : null,
    confidence: Math.min(...confs),
  };
}

export function layaDecider(cfg: Cfg['laya'] & { timeoutMs: number }): Decide {
  return async (req) => {
    const ask = async (maxCandidates: number) => {
      const { body } = layaRequest(req, cfg.model, maxCandidates);
      let res: Response;
      try {
        res = await fetch(`${cfg.url}/v1/systemone`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.any([req.signal, AbortSignal.timeout(cfg.timeoutMs)]),
        });
      } catch (e) {
        if (req.signal.aborted) throw e;
        throw new Error(`Cannot reach Ollaya at ${cfg.url} (is "ollaya serve" running?)`, { cause: e });
      }
      const json = (await res.json().catch(() => ({}))) as { answers?: Record<string, LayaAnswer>; code?: string };
      if (!res.ok) throw Object.assign(new Error(`Laya refused the request: ${json.code ?? res.status}${json.code === 'MODEL_NOT_FOUND' ? ` (try: ollaya pull ${cfg.model})` : ''}`), { code: json.code });
      return parseLaya(json.answers ?? {});
    };
    let raw;
    try {
      raw = await ask(30);
    } catch (e) {
      // A page with long labels can overflow Laya's small context: retry once with a shorter shortlist.
      const code = (e as { code?: string }).code;
      if (code !== 'STATE_TRUNCATED' && code !== 'TOO_MANY_OPTIONS' && code !== 'INPUT_TOO_LONG') throw e;
      raw = await ask(10);
    }
    return { raw, source: 'laya', minConfidence: cfg.minConfidence };
  };
}

/**
 * Laya first (milliseconds), Qwen when Laya is unsure, unavailable or its pick was rejected, and the run hands back to the
 * calling agent (Claude) when Qwen is unsure too. A Laya outage is remembered for a minute so steps don't keep paying for it.
 */
export function cascadeDecider(laya: Decide, qwen: Decide, layaMin: number, now: () => number = Date.now): Decide {
  let layaDownUntil = 0;
  return async (req) => {
    let reason: string;
    if (req.correction) reason = 'laya pick was not possible';
    else if (now() < layaDownUntil) reason = 'laya unavailable';
    else {
      try {
        const r = await laya(req);
        const { confidence: conf = 0, op } = r.raw as { confidence?: number; op?: string };
        // DONE/BLOCKED end the run, so a small model's opinion alone is not enough: the stronger model confirms.
        if (op === 'DONE' || op === 'BLOCKED') reason = `laya says ${op} (${conf.toFixed(2)}); confirming with qwen`;
        else if (conf >= layaMin) return r;
        else reason = `laya unsure (${conf.toFixed(2)})`;
      } catch (e) {
        if (req.signal.aborted) throw e;
        const code = (e as { code?: string }).code;
        if (!code) layaDownUntil = now() + 60_000; // connection problem, not a per-page refusal
        reason = `laya error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160);
      }
    }
    const q = await qwen(req);
    return { ...q, escalated: reason };
  };
}

export type DeciderMode = 'cascade' | 'qwen' | 'laya';

export function makeDecider(cfg: Cfg): Decide {
  const qwen = qwenDecider(cfg);
  const laya = layaDecider({ ...cfg.laya, timeoutMs: cfg.timeoutMs });
  if (cfg.mode === 'qwen') return qwen;
  if (cfg.mode === 'laya') return laya;
  return cascadeDecider(laya, qwen, cfg.laya.minConfidence);
}

export async function deciderStatus(cfg: Cfg) {
  const get = async (url: string) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const tags = (await get(`${cfg.url}/api/tags`)) as { models?: { name: string }[] } | null;
  const want = cfg.model.includes(':') ? cfg.model : `${cfg.model}:latest`;
  const lmodels = (await get(`${cfg.laya.url}/v1/models`)) as { models?: { name: string }[] } | null;
  const layaBase = cfg.laya.model.split(':')[0]!;
  return {
    mode: cfg.mode,
    qwen: { url: cfg.url, model: cfg.model, reachable: tags !== null, modelPulled: (tags?.models ?? []).some((m) => m.name === want) },
    laya: { url: cfg.laya.url, model: cfg.laya.model, reachable: lmodels !== null, modelPulled: (lmodels?.models ?? []).some((m) => m.name === cfg.laya.model || m.name.split(':')[0] === layaBase), minConfidence: cfg.laya.minConfidence },
  };
}
