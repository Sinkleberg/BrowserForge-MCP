/* eslint-disable @typescript-eslint/no-explicit-any */
import { api } from './browser-api.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const send = (op: string, extra: Record<string, unknown> = {}) => api.runtime.sendMessage({ kind: 'bf-popup', op, ...extra }) as Promise<any>;

let editing = false;
let lastState: any = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props as any;
  if (cls) e.className = cls;
  Object.assign(e, rest);
  e.append(...kids);
  return e;
}

async function render(): Promise<void> {
  const r = await send('getState');
  if (!r?.ok) return;
  const s = (lastState = r.state);
  const dot = $('dot');
  dot.className = 'dot' + (s.connected ? ' on' : s.connecting ? ' wait' : '');
  dot.setAttribute('aria-label', s.connected ? 'connected' : 'disconnected');
  $('status').textContent = s.paused ? (s.humanLocked ? 'Stopped' : 'Paused') : s.connected ? 'Connected' : s.connecting ? 'Connecting…' : 'Disconnected';
  $('pause').textContent = s.paused ? '▶ Resume' : '❚❚ Pause';
  $<HTMLParagraphElement>('locked').hidden = !s.humanLocked;
  $<HTMLParagraphElement>('yoloBanner').hidden = !s.yolo;
  $<HTMLInputElement>('yoloOn').checked = s.yolo;
  $<HTMLInputElement>('soundOn').checked = s.approvalSound;
  $<HTMLInputElement>('agentWindowOn').checked = s.agentWindow;
  $('agentWindowState').textContent = s.agentWindow ? (s.agentWindowOpen ? 'The agent window is open.' : 'The agent window opens when the agent first navigates.') : 'Off: the agent works in whichever tab is active.';
  $<HTMLButtonElement>('closeAgentWindow').disabled = !s.agentWindowOpen;
  $<HTMLParagraphElement>('recBanner').hidden = !s.recordHuman;
  $<HTMLInputElement>('recOn').checked = s.recordHuman;
  $<HTMLInputElement>('recValues').checked = s.recordValues;
  if (document.activeElement !== $('recTask')) $<HTMLInputElement>('recTask').value = s.recordTask;
  $('error').textContent = s.connected ? '' : s.lastError;
  if (!editing) {
    $<HTMLInputElement>('serverUrl').value = s.serverUrl;
    $<HTMLInputElement>('token').placeholder = s.tokenSet ? '•••••••• (saved — paste to replace)' : 'paste extension token';
  }
  $<HTMLInputElement>('capEnabled').checked = s.capture.enabled;
  $<HTMLInputElement>('capBodies').checked = s.capture.captureBodies;
  $<HTMLInputElement>('capBodies').disabled = !s.bodyCaptureAvailable;
  $('bodiesNote').textContent = s.bodyCaptureAvailable ? '' : s.bodyCapturePossible ? '(needs permission)' : '(not in this build: load the chrome-bodies folder, see docs/INSTALL.md)';
  $<HTMLButtonElement>('grantBodies').hidden = s.bodyCaptureAvailable || !s.bodyCapturePossible;

  const approvals = $<HTMLElement>('approvals');
  approvals.hidden = s.pendingApprovals.length === 0;
  const list = $('approvalList');
  list.replaceChildren(
    ...s.pendingApprovals.map((p: any) =>
      el('li', {},
        el('div', { class: 'host' }, p.host || 'BrowserForge workflow'),
        el('div', { class: 'detail' }, el('strong', {}, p.title), ' — ', p.detail),
        el('div', { class: 'row' },
          el('button', { class: 'primary', type: 'button', textContent: 'Approve', onclick: () => void send('approve', { id: p.id, approved: true }).then(render) }),
          el('button', { type: 'button', textContent: 'Deny', onclick: () => void send('approve', { id: p.id, approved: false }).then(render) })),
      ),
    ),
  );

  const hist = await send('getHistory');
  if (hist?.ok) {
    $('history').replaceChildren(
      ...[...hist.history].reverse().slice(0, 100).map((h: any) =>
        el('li', { class: h.by === 'yolo' ? 'yolo' : h.outcome }, `${new Date(h.decidedAt).toLocaleString()} `, el('b', {}, h.by === 'yolo' ? 'auto (YOLO)' : h.outcome), ` ${h.host || 'workflow'} — ${h.title}`)),
    );
  }

  const act = $('activity');
  act.replaceChildren(
    ...[...s.activity].reverse().map((a: any) =>
      el('li', { class: a.outcome }, `${new Date(a.at).toLocaleTimeString()} `, el('b', {}, a.action), ` ${a.summary}`),
    ),
  );

  const tabs = await api.tabs.query({});
  $('tabs').replaceChildren(
    ...tabs.slice(0, 40).map((t) => {
      const li = el('li', { tabIndex: 0, class: t.id === s.selectedTabId ? 'selected' : '' },
        el('span', { class: 't', title: t.title ?? '' }, (t.active ? '● ' : '') + (t.title || t.url || 'tab')),
        el('span', { class: 'u' }, (() => { try { return new URL(t.url ?? '').host; } catch { return ''; } })()));
      const pick = () => void send('selectTab', { tabId: t.id }).then(render);
      li.onclick = pick;
      li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
      return li;
    }),
  );
}

$('takeOver').onclick = () => void send('takeOver').then(render);
$('handBack').onclick = () => void send('handBack').then(render);
$('closeAgentWindow').onclick = () => void send('closeAgentWindow').then(render);
$('agentWindowOn').onchange = (e) => void send('setAgentWindow', { on: (e.target as HTMLInputElement).checked }).then(render);
$('stop').onclick = () => void send('stop').then(render);
$('pause').onclick = () => void send(lastState?.paused ? 'resume' : 'pause').then(render);
$('connect').onclick = async () => {
  await send('saveSettings', { serverUrl: $<HTMLInputElement>('serverUrl').value, token: $<HTMLInputElement>('token').value });
  $<HTMLInputElement>('token').value = '';
  editing = false;
  await send('connect');
  setTimeout(render, 600);
};
$('disconnect').onclick = () => void send('disconnect').then(render);
$('serverUrl').oninput = $('token').oninput = () => { editing = true; };
$('capEnabled').onchange = (e) => void send('setCapture', { enabled: (e.target as HTMLInputElement).checked });
$('capBodies').onchange = (e) => void send('setCapture', { captureBodies: (e.target as HTMLInputElement).checked });
$('yoloOn').onchange = (e) => {
  const on = (e.target as HTMLInputElement).checked;
  // Turning it on needs a deliberate confirmation; turning it off never does.
  if (on && !confirm('Turn on YOLO mode? Every approval (passwords, submits, messages) will pass automatically for all agents on this browser until you switch it off.')) { (e.target as HTMLInputElement).checked = false; return; }
  void send('setYolo', { on }).then(render);
};
$('yoloOff').onclick = () => void send('setYolo', { on: false }).then(render);
$('recOn').onchange = (e) => void send('setRecord', { on: (e.target as HTMLInputElement).checked }).then(render);
$('recOff').onclick = () => void send('setRecord', { on: false }).then(render);
$('recValues').onchange = (e) => void send('setRecord', { values: (e.target as HTMLInputElement).checked }).then(render);
$('recTask').onchange = (e) => void send('setRecord', { task: (e.target as HTMLInputElement).value }).then(render);
$('soundOn').onchange = (e) => void send('setSound', { on: (e.target as HTMLInputElement).checked });
$('clearHistory').onclick = () => void send('clearHistory').then(render);
$('exportHistory').onclick = async () => {
  const r = await send('getHistory');
  const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(r?.history ?? [], null, 1)], { type: 'application/json' })), download: 'browserforge-approvals.json' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('clearActivity').onclick = () => void send('clearActivity').then(render);

// Optional permissions must be requested from a user gesture inside the popup.
const isFirefoxPopup = typeof (globalThis as any).browser !== 'undefined';
$('grantBodies').onclick = async () => {
  const perms = isFirefoxPopup ? { permissions: ['webRequestBlocking', 'webRequestFilterResponse'] } : { permissions: ['debugger'] };
  try {
    const ok = await (api.permissions as any).request(perms);
    $('error').textContent = ok ? '' : 'Permission was not granted';
    await send('permissionsChanged');
  } catch (e) {
    $('error').textContent = 'Could not request permission: ' + (e as Error).message;
  }
  void render();
};
$('grantDownloads').onclick = async () => {
  try {
    await (api.permissions as any).request({ permissions: ['downloads'] });
  } catch (e) {
    $('error').textContent = 'Could not request permission: ' + (e as Error).message;
  }
};

void render();
setInterval(() => void render(), 1500);
