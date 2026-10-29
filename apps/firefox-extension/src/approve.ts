/* eslint-disable @typescript-eslint/no-explicit-any */
import { api } from './browser-api.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const send = (op: string, extra: Record<string, unknown> = {}) => api.runtime.sendMessage({ kind: 'bf-popup', op, ...extra }) as Promise<any>;

let known = new Set<string>();
let soundOn = true;
let first: string | null = null;

/** Two short rising tones; WebAudio so no asset is needed. Failure (autoplay policy) is silent: the window itself is the signal. */
function chime(): void {
  if (!soundOn) return;
  try {
    const ctx = new AudioContext();
    void ctx.resume();
    [660, 880].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      const t = ctx.currentTime + i * 0.16;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.16);
    });
    setTimeout(() => void ctx.close(), 600);
  } catch {
    /* no audio available */
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props as any;
  if (cls) e.className = cls;
  Object.assign(e, rest);
  e.append(...kids);
  return e;
}

const decide = (id: string, approved: boolean) => void send('approve', { id, approved }).then(render);

async function render(): Promise<void> {
  const r = await send('getState');
  if (!r?.ok) return;
  soundOn = r.state.approvalSound !== false;
  const list: any[] = r.state.pendingApprovals;
  const ids = new Set<string>(list.map((p) => p.id));
  if (list.some((p) => !known.has(p.id))) chime();
  known = ids;
  first = list[0]?.id ?? null;
  $('empty').hidden = list.length > 0;
  $('approvals').hidden = list.length === 0;
  $('approvalList').replaceChildren(
    ...list.map((p) =>
      el('li', {},
        el('div', { class: 'host' }, p.host || 'BrowserForge workflow'),
        el('div', { class: 'detail' }, el('strong', {}, p.title), ' — ', p.detail),
        el('div', { class: 'row' },
          el('button', { class: 'primary', type: 'button', textContent: 'Approve', onclick: () => decide(p.id, true) }),
          el('button', { type: 'button', textContent: 'Deny', onclick: () => decide(p.id, false) }))),
    ),
  );
}

document.addEventListener('keydown', (e) => {
  if (!first) return;
  if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); decide(first, true); }
  if (e.key === 'Escape') { e.preventDefault(); decide(first, false); }
});

void render();
setInterval(() => void render(), 700);
