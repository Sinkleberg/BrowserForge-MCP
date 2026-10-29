import type { ServerConfig } from './context.js';

type Cfg = ServerConfig['decider'];

/** One constrained decision from a local Ollama model. `format` is a JSON schema, so the reply can only be a valid choice. */
export function ollamaDecider(cfg: Cfg) {
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
      throw new Error(`Cannot reach the local model server at ${cfg.url} (is Ollama running?): ${e instanceof Error ? e.message : String(e)}`);
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

export async function deciderStatus(cfg: Cfg): Promise<{ url: string; model: string; reachable: boolean; modelPulled: boolean }> {
  try {
    const res = await fetch(`${cfg.url}/api/tags`, { signal: AbortSignal.timeout(1500) });
    const tags = (await res.json()) as { models?: { name: string }[] };
    const want = cfg.model.includes(':') ? cfg.model : `${cfg.model}:latest`;
    return { url: cfg.url, model: cfg.model, reachable: res.ok, modelPulled: (tags.models ?? []).some((m) => m.name === want) };
  } catch {
    return { url: cfg.url, model: cfg.model, reachable: false, modelPulled: false };
  }
}
