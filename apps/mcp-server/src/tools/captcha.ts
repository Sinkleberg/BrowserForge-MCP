import type { Logger } from '@browserforge/shared';

export interface CaptchaConfig {
  enabled: boolean;
  /** Base URL of the CapSkip desktop app. Must be loopback: page URLs and site keys are sent to it. */
  url?: string;
  /** CapSkip API key; any string works when CapSkip has key validation off. */
  apiKey?: string;
  timeoutSeconds?: number;
  pollIntervalSeconds?: number;
}

export type CaptchaKind = 'recaptcha_v2' | 'recaptcha_v3' | 'turnstile' | 'hcaptcha';

/** One CAPTCHA widget found on the page by the extension's captcha_scan. */
export interface CaptchaWidget {
  kind: CaptchaKind;
  siteKey: string;
  action?: string;
  invisible?: boolean;
  enterprise?: boolean;
}

export interface CaptchaResult {
  solved: boolean;
  kind?: CaptchaKind;
  token?: string;
  error?: string;
  /** Where the token goes on the page. */
  responseField?: string;
  /** Turnstile: Cloudflare rejects a token replayed under a different User-Agent. */
  userAgent?: string;
  solveSeconds?: number;
}

const RESPONSE_FIELD: Record<Exclude<CaptchaKind, 'hcaptcha'>, string> = {
  recaptcha_v2: '#g-recaptcha-response',
  recaptcha_v3: '#g-recaptcha-response',
  turnstile: '[name=cf-turnstile-response]',
};

export function assertLoopbackCapskipUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid CapSkip URL '${raw}'`);
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || !/^https?:$/.test(u.protocol)) {
    throw new Error('CapSkip must run on this machine (127.0.0.1, localhost or ::1): page URLs and site keys are sent to it');
  }
  return u.origin;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

export class CaptchaSolver {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(private readonly config: CaptchaConfig, private readonly logger: Logger) {
    this.baseUrl = assertLoopbackCapskipUrl(config.url || 'http://127.0.0.1:8080');
    this.apiKey = config.apiKey || 'capskip';
  }

  /** The first widget CapSkip can solve; hCaptcha is reported but never attempted (CapSkip does not support it). */
  static pick(widgets: CaptchaWidget[]): CaptchaWidget | undefined {
    return widgets.find((w) => w.kind !== 'hcaptcha');
  }

  async solve(widget: CaptchaWidget, pageUrl: string, signal?: AbortSignal): Promise<CaptchaResult> {
    if (widget.kind === 'hcaptcha') return { solved: false, kind: widget.kind, error: 'hCaptcha is not supported by CapSkip' };
    const kind = widget.kind;

    const form = new URLSearchParams({ key: this.apiKey, json: '1', pageurl: pageUrl });
    if (kind === 'turnstile') {
      form.set('method', 'turnstile');
      form.set('sitekey', widget.siteKey);
      if (widget.action) form.set('action', widget.action);
    } else {
      form.set('method', 'userrecaptcha');
      form.set('googlekey', widget.siteKey);
      form.set('enterprise', widget.enterprise ? '1' : '0');
      if (kind === 'recaptcha_v3') {
        form.set('version', 'v3');
        if (widget.action) form.set('action', widget.action);
      } else if (widget.invisible) {
        form.set('invisible', '1');
      }
    }

    let jobId: string;
    try {
      const r = await fetch(new URL('/in.php', this.baseUrl), { method: 'POST', body: form, signal });
      const text = (await r.text()).trim();
      const parsed = parseSubmit(text);
      if (!parsed.id) return { solved: false, kind, error: `CapSkip refused the job: ${parsed.error ?? (text.slice(0, 200) || 'empty reply')}` };
      jobId = parsed.id;
    } catch (e) {
      return { solved: false, kind, error: `CapSkip unreachable at ${this.baseUrl} (is the desktop app running? Otherwise solve it by looking: click the checkbox in the CAPTCHA iframe, screenshot once if an image challenge appears, click the matching tiles, press Verify): ${e instanceof Error ? e.message : String(e)}` };
    }
    this.logger.debug?.('capskip job submitted', { kind });

    const timeoutMs = (this.config.timeoutSeconds ?? 300) * 1000;
    const pollMs = (this.config.pollIntervalSeconds ?? 5) * 1000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(pollMs, signal);
      if (signal?.aborted) return { solved: false, kind, error: 'cancelled' };
      const q = new URLSearchParams({ key: this.apiKey, action: 'get', id: jobId, json: '1' });
      let text: string;
      try {
        text = (await (await fetch(new URL(`/res.php?${q}`, this.baseUrl), { signal })).text()).trim();
      } catch (e) {
        return { solved: false, kind, error: `CapSkip poll failed: ${e instanceof Error ? e.message : String(e)}` };
      }
      // An empty body also means "not ready yet" (right after submit, or once a token has already been read).
      if (!text) continue;
      let j: { status?: number; request?: string; useragent?: string; userAgent?: string };
      try {
        j = JSON.parse(text) as typeof j;
      } catch {
        return { solved: false, kind, error: `CapSkip sent an unreadable reply: ${text.slice(0, 120)}` };
      }
      if (j.status === 1 && j.request) {
        return {
          solved: true,
          kind,
          token: j.request,
          responseField: RESPONSE_FIELD[kind],
          ...(kind === 'turnstile' && (j.useragent || j.userAgent) ? { userAgent: j.useragent || j.userAgent } : {}),
          solveSeconds: Math.round((Date.now() - start) / 100) / 10,
        };
      }
      if (j.request === 'CAPCHA_NOT_READY') continue;
      return { solved: false, kind, error: `CapSkip could not solve it: ${j.request ?? 'unknown error'}` };
    }
    return { solved: false, kind, error: `CapSkip did not finish within ${timeoutMs / 1000}s` };
  }
}

function parseSubmit(text: string): { id?: string; error?: string } {
  if (text.startsWith('OK|')) return { id: text.slice(3) };
  try {
    const j = JSON.parse(text) as { status?: number; request?: string };
    if (j.status === 1 && j.request) return { id: String(j.request) };
    return { error: j.request };
  } catch {
    return { error: text.slice(0, 200) };
  }
}

export function createCaptchaSolver(config: CaptchaConfig, logger: Logger): CaptchaSolver | undefined {
  return config.enabled ? new CaptchaSolver(config, logger) : undefined;
}
