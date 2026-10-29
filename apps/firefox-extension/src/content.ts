/**
 * Content script: runs in the extension's isolated world (never in the page's JS context), so page scripts
 * cannot call into it or read its variables. It only answers messages from the background script.
 */
import { api } from './browser-api.js';
import type { ContentCall, ContentReply } from './messages.js';

type Json = Record<string, unknown>;
const EPOCH = Math.random().toString(36).slice(2, 8);
let counter = 0;
const refs = new Map<string, WeakRef<Element>>();
const refOf = new WeakMap<Element, string>();
const consoleErrors: { at: number; type: string; message: string }[] = [];
const MAX_ERRORS = 100;

class CallError extends Error {
  constructor(public code: string, message: string, public details?: Json) {
    super(message);
  }
}

// ---------- console error collection (uncaught errors, unhandled rejections) ----------
function pushError(type: string, message: string): void {
  consoleErrors.push({ at: Date.now(), type, message: String(message).slice(0, 500) });
  if (consoleErrors.length > MAX_ERRORS) consoleErrors.shift();
}
// Errors are reported by src/page-hook.ts (main world) because isolated worlds do not see page error events in Chrome.
document.addEventListener('__bf_page_error', (ev) => {
  try {
    const d = JSON.parse(String((ev as CustomEvent).detail)) as { type?: string; message?: string };
    pushError(String(d.type ?? 'uncaught').slice(0, 30), String(d.message ?? ''));
  } catch {
    /* malformed event (pages may forge these; they are untrusted data anyway) */
  }
});

// ---------- helpers ----------
function refFor(el: Element): string {
  let r = refOf.get(el);
  if (!r) {
    r = `${EPOCH}:${++counter}`;
    refOf.set(el, r);
    refs.set(r, new WeakRef(el));
  }
  return r;
}

function resolveTarget(args: Json): Element {
  const ref = args.ref as string | undefined;
  if (ref) {
    if (!ref.startsWith(EPOCH + ':')) throw new CallError('STALE_REF', 'Element ref is from a previous page load; call browser_get_interactive_elements again');
    const el = refs.get(ref)?.deref();
    if (!el || !el.isConnected) throw new CallError('STALE_REF', 'Element no longer exists in the page; refresh refs');
    return el;
  }
  const sel = args.selector as string | undefined;
  if (sel) {
    let el: Element | null;
    try {
      el = document.querySelector(sel);
    } catch {
      throw new CallError('INVALID_ARGUMENTS', 'Invalid CSS selector');
    }
    if (!el) throw new CallError('ELEMENT_NOT_FOUND', `No element matches selector`);
    return el;
  }
  throw new CallError('INVALID_ARGUMENTS', 'Provide ref or selector');
}

function isVisible(el: Element): boolean {
  const he = el as HTMLElement;
  if (!he.getBoundingClientRect) return false;
  const style = getComputedStyle(he);
  if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
  const r = he.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function textOf(el: Element, max = 120): string {
  return ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function labelFor(el: Element): string {
  const he = el as HTMLInputElement;
  const aria = el.getAttribute('aria-label');
  if (aria) return aria.trim().slice(0, 120);
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const t = labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
    if (t) return t.slice(0, 120);
  }
  const ph = el.getAttribute('aria-placeholder') ?? el.getAttribute('data-placeholder');
  if (ph && !textOf(el, 5)) return ph.trim().slice(0, 120);
  if (he.labels && he.labels.length) return textOf(he.labels[0]!, 120);
  const wrap = el.closest('label');
  if (wrap) return textOf(wrap, 120);
  return (el.getAttribute('placeholder') ?? el.getAttribute('title') ?? '').trim().slice(0, 120);
}

function describe(el: Element) {
  const he = el as HTMLInputElement;
  const tag = el.tagName.toLowerCase();
  const out: Json = {
    ref: refFor(el),
    tag,
    type: he.type || undefined,
    role: el.getAttribute('role') || undefined,
    name: he.name || undefined,
    id: el.id || undefined,
    label: labelFor(el) || undefined,
    text: ['input', 'textarea', 'select'].includes(tag) ? undefined : textOf(el) || undefined,
    href: tag === 'a' ? (el as HTMLAnchorElement).href : undefined,
    disabled: he.disabled || undefined,
    required: he.required || undefined,
    visible: isVisible(el),
  };
  if (isEditable(el)) out.editable = true;
  if (['input', 'textarea'].includes(tag) && he.type !== 'password' && he.type !== 'file') out.value = String(he.value ?? '').slice(0, 200);
  if (tag === 'input' && ['checkbox', 'radio'].includes(he.type)) out.checked = he.checked;
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=menuitem],[role=tab],[role=textbox],[role=option],[role=combobox],[role=listbox],[role=radio],[role=switch],[role=searchbox],[role=menuitemcheckbox],[role=menuitemradio],[role=treeitem],[onclick],[contenteditable=""],[contenteditable=true],[contenteditable=plaintext-only]';

// ---------- consequential-action classification ----------
const RISKY_WORDS = /\b(submit|apply|send|buy|purchase|pay|order|confirm|accept|agree|sign|delete|remove|checkout|place order|donate|subscribe|book|reserve|transfer|post|publish)\b/i;

const CLICKABLE_ANCESTOR = 'button,a[href],[role=button],[role=menuitem],[role=link],[role=menuitemcheckbox],input[type=submit],input[type=image]';

/** Everything a human would read as the name of a control: own text/value/aria-label/title/labelledby plus labelled descendants (svg icons). */
function riskLabel(el: Element): string {
  const parts = [textOf(el, 80), (el as HTMLInputElement).value ?? '', el.getAttribute('aria-label') ?? '', el.getAttribute('title') ?? ''];
  const by = el.getAttribute('aria-labelledby');
  if (by) parts.push(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '));
  for (const d of [...el.querySelectorAll('[aria-label],svg title,img[alt]')].slice(0, 4)) parts.push(d.getAttribute('aria-label') ?? d.getAttribute('alt') ?? d.textContent ?? '');
  return parts.join(' ');
}

function riskOfClick(target: Element): string | null {
  // Refs often point at an inner span/svg; judge the control that would actually receive the click.
  const el = target.closest(CLICKABLE_ANCESTOR) ?? target;
  const he = el as HTMLButtonElement;
  const tag = el.tagName.toLowerCase();
  const type = (he.type || '').toLowerCase();
  const label = riskLabel(el);
  // A <button> defaults to type=submit, but only submits when it belongs to a form.
  if ((tag === 'button' || tag === 'input') && (type === 'submit' || type === 'image') && he.form) return `Submit form via “${label.trim() || type || 'button'}”`;
  const role = el.getAttribute('role');
  if (RISKY_WORDS.test(label) && (tag === 'button' || tag === 'input' || role === 'button' || role === 'menuitem' || role === 'link' || tag === 'a')) return `Click “${label.trim().slice(0, 60)}”`;
  if (tag === 'input' && type === 'checkbox' && /\b(terms|agree|accept|consent|contract)\b/i.test(labelFor(el))) return `Tick “${labelFor(el).slice(0, 60)}”`;
  return null;
}

// ---------- input helpers ----------
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}
function fire(el: Element, ...types: string[]): void {
  for (const t of types) el.dispatchEvent(new Event(t, { bubbles: true, cancelable: true }));
}

function assertFillable(el: Element): asserts el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) throw new CallError('INVALID_ARGUMENTS', 'Target is not a form field');
  if (el.disabled) throw new CallError('INVALID_ARGUMENTS', 'Field is disabled');
}


// ---------- rich-text (contenteditable) editors ----------
const EDITABLE_HOST = '[contenteditable]:not([contenteditable="false"])';

/** The editing host for rich-text editors (Lexical, Draft.js, ProseMirror, Slate, plain contenteditable), or null. */
function editableHost(el: Element): HTMLElement | null {
  if (!(el instanceof HTMLElement) || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return null;
  if (!el.isContentEditable && el.getAttribute('role') !== 'textbox') return null;
  return el.closest<HTMLElement>(EDITABLE_HOST);
}
function isEditable(el: Element): boolean {
  return editableHost(el) !== null;
}

/** The focused element, looking through open shadow roots. */
function deepActiveElement(): Element | null {
  let a: Element | null = document.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  return a && a !== document.body && a !== document.documentElement ? a : null;
}

/** If the target is a wrapper around exactly one editable control, return that control. */
function singleEditableInside(el: Element): Element | null {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || editableHost(el)) return null;
  const found = el.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]),textarea,[contenteditable]:not([contenteditable="false"])');
  return found.length === 1 ? found[0]! : null;
}

/** Full pointer sequence: React-style menus react to pointer/mouse events, not only to click(). */
function pointerClick(el: Element): void {
  const r = (el as HTMLElement).getBoundingClientRect();
  const pt = { bubbles: true, cancelable: true, composed: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, pt) : new MouseEvent(t, pt));
  (el as HTMLElement).click();
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const editorText = (el: HTMLElement) => el.innerText ?? el.textContent ?? '';

function placeCaretAtEnd(el: HTMLElement): void {
  el.focus();
  const sel = getSelection();
  if (!sel) return;
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  sel.removeAllRanges();
  sel.addRange(r);
}

/**
 * Offer an input to the page first as a cancelable `beforeinput`: editors such as Lexical, Draft.js and Slate cancel it and update
 * their own model, which is the only way they accept programmatic input. If the page did not cancel it (plain contenteditable,
 * ProseMirror), let the browser perform the edit itself with execCommand. Returns true when the page handled it.
 */
async function applyInput(el: HTMLElement, inputType: string, data: string | null, command?: [string, string?]): Promise<boolean> {
  const handled = !el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType, data }));
  if (!handled && command) document.execCommand(command[0], false, command[1]);
  await tick();
  return handled;
}

async function clearEditable(el: HTMLElement): Promise<void> {
  if (!editorText(el).trim()) return;
  el.focus();
  const sel = getSelection();
  if (sel) {
    const r = document.createRange();
    r.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  await applyInput(el, 'deleteContentBackward', null, ['delete']);
}

/**
 * Insert one line of text, verified by watching the editor's text change:
 *  1. applyInput (page-handled beforeinput, else native execCommand insertText);
 *  2. a synthetic paste with clipboard data;
 *  3. plain DOM mutation + input event (simple contenteditable divs).
 */
async function insertLine(el: HTMLElement, text: string): Promise<void> {
  if (!text) return;
  const before = editorText(el);
  const changed = () => editorText(el) !== before;
  placeCaretAtEnd(el);
  if ((await applyInput(el, 'insertText', text, ['insertText', text])) || changed()) return;
  try {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    await tick();
    if (changed()) return;
  } catch {
    /* ClipboardEvent construction not supported */
  }
  el.append(document.createTextNode(text));
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  await tick();
  if (!changed()) throw new CallError('UNSUPPORTED', 'This editor did not accept synthetic input (it may require trusted keyboard events)');
}

async function insertLineBreak(el: HTMLElement): Promise<void> {
  placeCaretAtEnd(el);
  // Shift+Enter semantics: a soft line break, never a bare Enter (which usually means "send").
  await applyInput(el, 'insertLineBreak', null, ['insertLineBreak']);
}

async function typeIntoEditable(el: HTMLElement, text: string, clear: boolean): Promise<void> {
  if (clear) await clearEditable(el);
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) await insertLineBreak(el);
    await insertLine(el, lines[i]!);
  }
  fire(el, 'change');
}

/** Press Enter in an editor the way a keyboard would: the page's keydown handler (send) runs; otherwise insert a paragraph. */
async function enterInEditable(el: HTMLElement, shift: boolean): Promise<void> {
  const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, shiftKey: shift, bubbles: true, cancelable: true, composed: true } as KeyboardEventInit;
  const go = el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keypress', init));
  if (go) {
    placeCaretAtEnd(el);
    await applyInput(el, shift ? 'insertLineBreak' : 'insertParagraph', null, [shift ? 'insertLineBreak' : 'insertParagraph']);
  }
  el.dispatchEvent(new KeyboardEvent('keyup', init));
  await tick(10);
}

function isPassword(el: Element): boolean {
  return el instanceof HTMLInputElement && el.type === 'password';
}

function fillElement(el: Element, value: string): void {
  assertFillable(el);
  if (el instanceof HTMLSelectElement) {
    const opt = [...el.options].find((o) => o.value === value || o.text.trim().toLowerCase() === value.toLowerCase());
    if (!opt) throw new CallError('INVALID_ARGUMENTS', 'No matching option');
    el.value = opt.value;
    fire(el, 'input', 'change');
    return;
  }
  if (el instanceof HTMLInputElement && el.type === 'file') throw new CallError('INVALID_ARGUMENTS', 'Use files for file inputs');
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    const want = /^(true|yes|1|on|checked)$/i.test(value);
    if (el.checked !== want) el.click();
    return;
  }
  el.focus();
  setNativeValue(el, value);
  fire(el, 'input', 'change');
}

// ---------- form discovery ----------
function describeForm(form: HTMLFormElement | null, scope: Element, idx: number): Json {
  const fields = [...scope.querySelectorAll('input,select,textarea')]
    .filter((e) => !(e instanceof HTMLInputElement && ['hidden', 'submit', 'button', 'reset', 'image'].includes(e.type)))
    .map((e) => {
      const d = describe(e);
      if (e instanceof HTMLSelectElement) d.options = [...e.options].slice(0, 100).map((o) => ({ value: o.value, label: o.text.trim().slice(0, 100), selected: o.selected || undefined }));
      if (e instanceof HTMLInputElement && e.type === 'file') {
        d.accept = e.accept || undefined;
        d.multiple = e.multiple || undefined;
      }
      if (e instanceof HTMLInputElement && e.pattern) d.pattern = e.pattern;
      if ((e as HTMLInputElement).maxLength > 0) d.maxLength = (e as HTMLInputElement).maxLength;
      return d;
    });
  const buttons = [...scope.querySelectorAll('button,input[type=submit]')].map(describe);
  return {
    ref: refFor(form ?? scope),
    index: idx,
    id: form?.id || undefined,
    name: form?.getAttribute('name') || undefined,
    action: form ? form.action : undefined,
    method: form ? form.method : undefined,
    fields,
    submitButtons: buttons,
    requiredMissing: fields.filter((f) => f.required && f.visible && !f.value && !f.checked).map((f) => f.label ?? f.name ?? f.id),
  };
}

function findField(scope: Element, key: string): Element | null {
  const k = key.trim().toLowerCase();
  const all = [...scope.querySelectorAll('input,select,textarea')].filter((e) => !(e instanceof HTMLInputElement && ['hidden', 'submit', 'button'].includes(e.type)));
  const score = (e: Element): number => {
    const he = e as HTMLInputElement;
    const label = labelFor(e).toLowerCase();
    if (he.name?.toLowerCase() === k || e.id?.toLowerCase() === k) return 100;
    if (label === k) return 90;
    if (he.placeholder?.toLowerCase() === k) return 80;
    if (label.startsWith(k) || label.includes(k)) return 60;
    if (he.name?.toLowerCase().includes(k) || e.id?.toLowerCase().includes(k)) return 50;
    return 0;
  };
  let best: Element | null = null;
  let bestScore = 0;
  for (const e of all) {
    const s = score(e);
    if (s > bestScore) {
      best = e;
      bestScore = s;
    }
  }
  return best;
}

// ---------- DOM snapshot ----------
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'link', 'meta']);
function snapshot(root: Element, maxNodes: number): Json {
  let count = 0;
  let truncated = false;
  const walk = (el: Element, depth: number): Json | null => {
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return null;
    if (count >= maxNodes) {
      truncated = true;
      return null;
    }
    count++;
    const node: Json = { tag };
    if (el.id) node.id = el.id;
    const cls = el.getAttribute('class');
    if (cls) node.class = cls.slice(0, 80);
    for (const a of ['name', 'type', 'href', 'role', 'aria-label', 'placeholder', 'for', 'alt']) {
      const v = el.getAttribute(a);
      if (v) node[a] = v.slice(0, 200);
    }
    if (el.matches(INTERACTIVE)) node.ref = refFor(el);
    const own = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim();
    if (own) node.text = own.slice(0, 200);
    if (depth < 40) {
      const kids = [...el.children].map((c) => walk(c, depth + 1)).filter(Boolean);
      if (kids.length) node.children = kids;
    }
    return node;
  };
  const tree = walk(root, 0);
  return { tree, nodeCount: count, truncated };
}

// ---------- operations ----------
const ops: Record<string, (args: Json, approved: boolean) => Promise<unknown> | unknown> = {
  ping: () => ({ epoch: EPOCH, url: location.href }),

  page_text: (args) => {
    const max = Math.min(Number(args.maxChars ?? 50_000), 200_000);
    const text = (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n');
    return { url: location.href, title: document.title, text: text.slice(0, max), truncated: text.length > max, totalChars: text.length };
  },

  dom_snapshot: (args) => {
    const rootSel = args.root as string | undefined;
    const root = rootSel ? document.querySelector(rootSel) : document.body;
    if (!root) throw new CallError('ELEMENT_NOT_FOUND', 'Root element not found');
    return { url: location.href, title: document.title, ...snapshot(root, Math.min(Number(args.maxNodes ?? 2000), 5000)) };
  },

  interactive_elements: (args) => {
    const table = args.format === 'table';
    const limit = Math.min(Number(args.limit ?? (table ? 100 : 300)), 1000);
    const inView = (e: Element) => { const r = (e as HTMLElement).getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; };
    let els = [...document.querySelectorAll(INTERACTIVE)].filter((e) => !(e instanceof HTMLInputElement && e.type === 'hidden'));
    if (args.visibleOnly !== false) els = els.filter(isVisible);
    if (args.inViewport === true) els = els.filter(inView);
    else if (table) els = [...els.filter(inView), ...els.filter((e) => !inView(e))]; // on-screen controls first
    const base = { url: location.href, title: document.title, epoch: EPOCH, total: els.length, truncated: els.length > limit };
    if (!table) return { ...base, elements: els.slice(0, limit).map(describe) };
    const rows = els.slice(0, limit).map((e, i) => {
      const he = e as HTMLInputElement;
      const kind = e.getAttribute('role') || (e.tagName === 'INPUT' ? `input:${he.type || 'text'}` : e.tagName.toLowerCase());
      let label = labelFor(e) || textOf(e, 60) || (he.value && he.type !== 'password' ? String(he.value).slice(0, 40) : '') || (e instanceof HTMLAnchorElement ? new URL(e.href, location.href).pathname.slice(0, 40) : '');
      // A <select>'s label text includes every option; drop them so the row stays short.
      if (e instanceof HTMLSelectElement) for (const o of e.options) if (o.text.trim()) label = label.replace(o.text.trim(), '');
      label = label.replace(/\s+/g, ' ').replace(/\|/g, '/').trim().slice(0, 60);
      // Whether a field already holds something, never what it holds: lets the agent see progress without exposing values.
      let state = '';
      if (e instanceof HTMLInputElement && ['checkbox', 'radio'].includes(e.type)) state = e.checked ? ' [checked]' : ' [unchecked]';
      else if (e instanceof HTMLSelectElement) state = e.value ? ' [filled]' : ' [empty]';
      else if ((e instanceof HTMLInputElement && !['button', 'submit', 'reset', 'image', 'file', 'hidden'].includes(e.type)) || e instanceof HTMLTextAreaElement) state = he.value ? ' [filled]' : ' [empty]';
      else if (isEditable(e)) state = textOf(e, 1) ? ' [filled]' : ' [empty]';
      return `${i + 1} | ${kind}${he.disabled ? ' (disabled)' : ''}${isEditable(e) ? ' (editable)' : ''}${state} | ${label} | ${refFor(e)}`;
    });
    return { ...base, rows };
  },

  forms: () => {
    const forms = [...document.forms];
    const out = forms.map((f, i) => describeForm(f, f, i));
    // Fields outside any <form> (SPA style) are grouped as one pseudo-form.
    const loose = [...document.querySelectorAll('input,select,textarea')].filter((e) => !(e as HTMLInputElement).form && !(e instanceof HTMLInputElement && e.type === 'hidden'));
    if (loose.length) out.push(describeForm(null, document.body, out.length));
    return { url: location.href, epoch: EPOCH, forms: out };
  },

  click: (args, approved) => {
    const el = resolveTarget(args);
    const risk = riskOfClick(el);
    if (risk && !approved) throw Object.assign(new CallError('APPROVAL_REQUIRED', risk), { risk });
    // Check first, scroll only if needed: scrolling closes popup menus (e.g. custom dropdown listboxes) before we can click them.
    if (!isVisible(el) && !(el instanceof HTMLInputElement)) throw new CallError('INVALID_ARGUMENTS', 'Element is not visible');
    const box = (el as HTMLElement).getBoundingClientRect();
    if (box.bottom < 0 || box.top > innerHeight || box.right < 0 || box.left > innerWidth) (el as HTMLElement).scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (el instanceof HTMLElement && (isEditable(el) || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) (editableHost(el) ?? el).focus();
    if (['option', 'combobox', 'menuitem'].includes(el.getAttribute('role') ?? '')) pointerClick(el);
    else (el as HTMLElement).click();
    return { clicked: true, element: describe(el) };
  },

  type: async (args, approved) => {
    let el = args.ref || args.selector ? resolveTarget(args) : deepActiveElement();
    if (!el) throw new CallError('ELEMENT_NOT_FOUND', 'No element is focused; click the field first or pass ref/selector');
    el = singleEditableInside(el) ?? el;
    const host = editableHost(el);
    if (host) {
      if (args.submit && !approved) throw Object.assign(new CallError('APPROVAL_REQUIRED', 'Type text and press Enter'), { risk: 'Type text and press Enter in an editor (this may send a message)' });
      const t = String(args.text ?? '');
      await typeIntoEditable(host, t, args.clear === true);
      if (args.submit) await enterInEditable(host, false);
      return { typed: t.length, editable: true, text: editorText(host).slice(0, 200) };
    }
    assertFillable(el);
    if (isPassword(el) && !approved) throw Object.assign(new CallError('APPROVAL_REQUIRED', 'Type into a password field'), { risk: 'Type into a password field' });
    if (args.submit && !approved) throw Object.assign(new CallError('APPROVAL_REQUIRED', 'Type text and press Enter'), { risk: 'Type text and submit with Enter' });
    const text = String(args.text ?? '');
    el.focus();
    const base = args.clear ? '' : String((el as HTMLInputElement).value ?? '');
    if (el instanceof HTMLSelectElement) throw new CallError('INVALID_ARGUMENTS', 'Use browser_select_option for <select>');
    let cur = base;
    setNativeValue(el, cur);
    for (const ch of text) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
      cur += ch;
      setNativeValue(el, cur);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
    }
    fire(el, 'change');
    if (args.submit) await pressEnter(el);
    return { typed: text.length };
  },

  fill_field: async (args, approved) => {
    const el = resolveTarget(args);
    const host = editableHost(el);
    if (host) {
      await typeIntoEditable(host, String(args.value ?? ''), true);
      return { filled: true, element: describe(host) };
    }
    assertFillable(el);
    if (isPassword(el) && !approved) throw Object.assign(new CallError('APPROVAL_REQUIRED', 'Fill a password field'), { risk: 'Fill a password field' });
    fillElement(el, String(args.value ?? ''));
    return { filled: true, element: describe(el) };
  },

  select_option: async (args) => {
    const el = resolveTarget(args);
    const { value, label } = args as { value?: string; label?: string };
    if (el.getAttribute('role') === 'combobox' || (!(el instanceof HTMLSelectElement) && el.getAttribute('aria-haspopup'))) {
      // Custom dropdown: open it, then click the matching option while it is still open.
      const want = (label ?? value ?? '').trim().toLowerCase();
      if (!want) throw new CallError('INVALID_ARGUMENTS', 'Provide label or value');
      pointerClick(el);
      const optionSel = '[role=option],[role=menuitemradio],[role=menuitem]';
      let opts: Element[] = [];
      for (let i = 0; i < 12; i++) {
        await tick(100);
        opts = [...document.querySelectorAll(optionSel)].filter(isVisible);
        if (opts.length) break;
      }
      const hit = opts.find((o) => textOf(o, 80).toLowerCase() === want || o.getAttribute('data-value')?.toLowerCase() === want || o.getAttribute('aria-label')?.toLowerCase() === want);
      if (!hit) throw new CallError('ELEMENT_NOT_FOUND', 'Option not found in the opened dropdown', { available: opts.slice(0, 50).map((o) => textOf(o, 60)) });
      pointerClick(hit);
      return { selected: textOf(hit, 60), custom: true };
    }
    if (!(el instanceof HTMLSelectElement)) throw new CallError('INVALID_ARGUMENTS', 'Target is not a <select> or combobox');
    const opt = [...el.options].find((o) => (value !== undefined && o.value === value) || (label !== undefined && o.text.trim().toLowerCase() === label.toLowerCase()));
    if (!opt) throw new CallError('ELEMENT_NOT_FOUND', 'Option not found', { available: [...el.options].slice(0, 50).map((o) => o.text.trim()) });
    el.value = opt.value;
    fire(el, 'input', 'change');
    return { selected: opt.value, label: opt.text.trim() };
  },

  scroll: (args) => {
    if (args.ref || args.selector) {
      resolveTarget(args).scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
      return { scrolled: 'element' };
    }
    const amount = Number(args.amount ?? Math.round(window.innerHeight * 0.8));
    switch (args.direction ?? 'down') {
      case 'up': window.scrollBy(0, -amount); break;
      case 'top': window.scrollTo(0, 0); break;
      case 'bottom': window.scrollTo(0, document.documentElement.scrollHeight); break;
      default: window.scrollBy(0, amount);
    }
    return { scrollY: Math.round(window.scrollY), maxScrollY: document.documentElement.scrollHeight - window.innerHeight };
  },

  press_key: async (args, approved) => {
    const el = (args.ref || args.selector ? resolveTarget(args) : deepActiveElement()) ?? document.body;
    const key = String(args.key);
    const mods = (args.modifiers as string[] | undefined) ?? [];
    const edHost = editableHost(el);
    // Enter in a chat box usually SENDS the message; in a form it submits it. Both need the human.
    if (key === 'Enter' && !approved && !mods.includes('Shift') && (edHost || (el instanceof HTMLInputElement && el.form) || (el instanceof HTMLButtonElement && el.type !== 'button'))) {
      throw Object.assign(new CallError('APPROVAL_REQUIRED', edHost ? 'Press Enter in a text editor' : 'Press Enter in a form'), { risk: edHost ? 'Press Enter in a text editor (this may send a message)' : 'Press Enter inside a form (may submit it)' });
    }
    // Enter/Space on a div[role=button] activates it exactly like a click, so it gets the same gate.
    if ((key === 'Enter' || key === ' ' || key === 'Space') && !approved) {
      const risk = el.closest(CLICKABLE_ANCESTOR) ? riskOfClick(el) : null;
      if (risk) throw Object.assign(new CallError('APPROVAL_REQUIRED', risk), { risk });
    }
    if (key === 'Enter' && edHost) {
      await enterInEditable(edHost, mods.includes('Shift'));
      return { pressed: key };
    }
    const init = { key, bubbles: true, cancelable: true, ctrlKey: mods.includes('Control'), shiftKey: mods.includes('Shift'), altKey: mods.includes('Alt'), metaKey: mods.includes('Meta') };
    (el as HTMLElement).focus?.();
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    if (key === 'Enter') await pressEnterDefault(el);
    else if (key === 'Tab') focusNext(el, mods.includes('Shift'));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    return { pressed: key };
  },

  wait_for_element: async (args) => {
    const timeout = Math.min(Number(args.timeoutMs ?? 10_000), 120_000);
    const state = (args.state as string | undefined) ?? 'visible';
    const text = args.text as string | undefined;
    const test = (): Element | null => {
      let el: Element | null = null;
      if (args.ref) {
        try { el = resolveTarget(args); } catch { el = null; }
      } else if (args.selector) {
        try { el = document.querySelector(String(args.selector)); } catch { throw new CallError('INVALID_ARGUMENTS', 'Invalid CSS selector'); }
      } else if (text) {
        const lower = text.toLowerCase();
        if ((document.body?.innerText ?? '').toLowerCase().includes(lower)) el = document.body;
      }
      return el;
    };
    const ok = (el: Element | null): boolean => {
      switch (state) {
        case 'present': return !!el;
        case 'absent': return !el;
        case 'hidden': return !el || !isVisible(el);
        default: return !!el && (el === document.body || isVisible(el));
      }
    };
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = test();
      if (ok(el)) return { satisfied: true, waitedMs: Date.now() - start, element: el && el !== document.body ? describe(el) : undefined };
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new CallError('TIMEOUT', `Condition '${state}' not met within ${timeout}ms`);
  },

  fill_form: async (args, approved) => {
    const files = (args.files as { key: string; fileName: string; mimeType: string; base64: string }[] | undefined) ?? [];
    const submit = args.submit === true;
    if ((files.length || submit) && !approved) {
      const parts: string[] = [];
      if (files.length) parts.push(`attach ${files.map((f) => f.fileName).join(', ')}`);
      if (submit) parts.push('submit the form');
      throw Object.assign(new CallError('APPROVAL_REQUIRED', parts.join(' and ')), { risk: `Fill form, ${parts.join(' and ')} on ${location.host}` });
    }
    const formRef = args.formRef as string | undefined;
    let scope: Element = document.body;
    let form: HTMLFormElement | null = null;
    if (formRef) {
      scope = resolveTarget({ ref: formRef });
      form = scope instanceof HTMLFormElement ? scope : null;
    } else if (document.forms.length === 1) {
      form = document.forms[0]!;
      scope = form;
    }
    const filled: Json[] = [];
    const notFound: string[] = [];
    for (const f of (args.fields as { key: string; value: string }[]) ?? []) {
      const el = findField(scope, f.key);
      if (!el) { notFound.push(f.key); continue; }
      if (isPassword(el) && !approved) { notFound.push(`${f.key} (password fields need approval)`); continue; }
      try {
        fillElement(el, f.value);
        filled.push({ key: f.key, matched: labelFor(el) || (el as HTMLInputElement).name || el.id });
      } catch (e) {
        notFound.push(`${f.key} (${(e as Error).message})`);
      }
    }
    for (const file of files) {
      const el = findField(scope, file.key);
      if (!(el instanceof HTMLInputElement) || el.type !== 'file') { notFound.push(`${file.key} (no file input)`); continue; }
      const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], file.fileName, { type: file.mimeType }));
      el.files = dt.files;
      fire(el, 'input', 'change');
      filled.push({ key: file.key, matched: labelFor(el) || el.name, file: file.fileName });
    }
    const report = form ? (describeForm(form, form, 0) as { requiredMissing: unknown[] }) : null;
    let submitted = false;
    if (submit) {
      if (form) {
        if (!form.checkValidity()) {
          form.reportValidity();
          return { filled, notFound, submitted: false, requiredMissing: report?.requiredMissing, reason: 'Form validation failed; fix the invalid fields' };
        }
        const btn = form.querySelector<HTMLElement>('button[type=submit],input[type=submit],button:not([type])');
        if (btn) btn.click();
        else form.requestSubmit();
        submitted = true;
      } else notFound.push('(no form to submit)');
    }
    return { filled, notFound, submitted, requiredMissing: report?.requiredMissing ?? [] };
  },

  console_errors: (args) => {
    const limit = Math.min(Number(args.limit ?? 50), 200);
    const out = consoleErrors.slice(-limit);
    if (args.clear) consoleErrors.length = 0;
    return { url: location.href, errors: out, note: 'Only uncaught exceptions and unhandled promise rejections are captured (page console.* output is not accessible to extensions without devtools).' };
  },

  page_metrics: () => ({ width: window.innerWidth, height: window.innerHeight, scrollHeight: document.documentElement.scrollHeight, scrollY: window.scrollY, dpr: window.devicePixelRatio }),
  scroll_to: (args) => { window.scrollTo(0, Number(args.y ?? 0)); return { scrollY: window.scrollY }; },
};

async function pressEnter(el: Element): Promise<void> {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await pressEnterDefault(el);
  el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
}
async function pressEnterDefault(el: Element): Promise<void> {
  if (el instanceof HTMLInputElement && el.form && !['checkbox', 'radio', 'file'].includes(el.type)) el.form.requestSubmit();
  else if (el instanceof HTMLButtonElement || (el instanceof HTMLInputElement && ['submit', 'button'].includes(el.type))) el.click();
}
function focusNext(el: Element, back: boolean): void {
  const items = [...document.querySelectorAll<HTMLElement>(INTERACTIVE)].filter(isVisible);
  const i = items.indexOf(el as HTMLElement);
  const next = items[(i + (back ? -1 : 1) + items.length) % items.length];
  next?.focus();
}

api.runtime.onMessage.addListener(((msg: ContentCall, _sender: unknown, sendResponse: (r: ContentReply) => void) => {
  if (!msg || msg.kind !== 'bf-call') return false;
  const op = ops[msg.op];
  if (!op) {
    sendResponse({ ok: false, error: { code: 'UNSUPPORTED', message: `Unknown operation ${msg.op}` } });
    return false;
  }
  Promise.resolve()
    .then(() => op(msg.args ?? {}, msg.approved === true))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((e: unknown) => {
      if (e instanceof CallError && e.code === 'APPROVAL_REQUIRED') {
        sendResponse({ ok: false, needsApproval: { title: e.message, detail: String((e as unknown as { risk?: string }).risk ?? e.message) } });
        return;
      }
      if (e instanceof CallError) sendResponse({ ok: false, error: { code: e.code, message: e.message, details: e.details } });
      else sendResponse({ ok: false, error: { code: 'INTERNAL', message: e instanceof Error ? e.message.slice(0, 300) : 'content script error' } });
    });
  return true; // async response
}) as never);
