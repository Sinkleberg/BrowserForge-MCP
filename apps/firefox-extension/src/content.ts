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
      el = document.querySelector(sel) ?? deepAll(sel)[0] ?? null;
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
  const own = (el.getAttribute('placeholder') ?? el.getAttribute('title') ?? '').trim();
  if (own) return own.slice(0, 120);
  // Inside a shadow root the label often lives on the wrapper (<spl-form-field label="Nome">), not in a <label>.
  const host = (el.getRootNode() as ShadowRoot).host;
  return (host?.getAttribute('label') ?? host?.getAttribute('aria-label') ?? '').trim().slice(0, 120);
}

/** labelFor() of a <select> includes the text of every option; keep just the label. */
function cleanLabelFor(el: Element): string {
  let label = labelFor(el);
  if (el instanceof HTMLSelectElement) for (const o of el.options) if (o.text.trim()) label = label.replace(o.text.trim(), '');
  return label.replace(/\s+/g, ' ').trim();
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

/**
 * querySelectorAll that also looks inside open shadow roots, in document order. Web-component pages (SmartRecruiters' `spl-*` forms,
 * some Workday widgets) keep their inputs in shadow roots, which plain querySelectorAll never reaches. Closed roots stay unreachable.
 */
function deepAll(selector: string, root: ParentNode = document): Element[] {
  const out: Element[] = [];
  const visit = (node: ParentNode): void => {
    for (const el of node.querySelectorAll('*')) {
      if (el.matches(selector)) out.push(el);
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  visit(root);
  return out;
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

// ---------- flow capture: describe the element an action used, so it can be replayed or exported later ----------
/** Ids made by frameworks change between visits and make bad locators. Kept identical to looksGeneratedId in packages/flows/src/params.ts (tested there). */
function looksGenerated(id: string): boolean {
  if (/^(:r[0-9a-z]+:|_r_\w+_|[0-9a-f]{8,})$/i.test(id) || /\d{4,}/.test(id)) return true;
  if (/^(mui|rc|react|radix|headlessui)[-_:]/i.test(id) || /^(ember\d|yui_|gwt-uid|__bvid__|j_idt\d|ctl\d)/i.test(id)) return true;
  if (/(^|[-_])\d{2,}([-_]|$)/.test(id)) return true;
  return /^[a-z0-9]{5,12}$/i.test(id) && (id.match(/[a-z]\d|\d[a-z]/gi) ?? []).length >= 2;
}
const GENERATED_ID = { test: looksGenerated };

function implicitRole(el: Element): string | undefined {
  const tag = el.tagName.toLowerCase();
  const type = ((el as HTMLInputElement).type ?? '').toLowerCase();
  if (tag === 'button') return 'button';
  if (tag === 'a' && el.hasAttribute('href')) return 'link';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'range') return 'slider';
    if (type === 'search') return 'searchbox';
    return 'textbox';
  }
  if (/^h[1-6]$/.test(tag)) return 'heading';
  return undefined;
}

function cssPath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  for (let depth = 0; cur && cur.nodeType === 1 && depth < 9; depth++) {
    if (cur.id && !GENERATED_ID.test(cur.id)) {
      parts.unshift(`#${CSS.escape(cur.id)}`);
      break;
    }
    const tag = cur.tagName.toLowerCase();
    if (tag === 'html') { parts.unshift('html'); break; }
    const same = cur.parentElement ? [...cur.parentElement.children].filter((c) => c.tagName === cur!.tagName) : [];
    parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(cur) + 1})` : tag);
    cur = cur.parentElement;
  }
  return parts.join(' > ');
}

function xpathOf(el: Element): string {
  if (el.id && !GENERATED_ID.test(el.id) && document.querySelectorAll(`[id="${CSS.escape(el.id)}"]`).length === 1) return `//*[@id="${el.id}"]`;
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.nodeType === 1) {
    const tag = cur.tagName.toLowerCase();
    const same = cur.parentElement ? [...cur.parentElement.children].filter((c) => c.tagName === cur!.tagName) : [];
    parts.unshift(same.length > 1 ? `${tag}[${same.indexOf(cur) + 1}]` : tag);
    cur = cur.parentElement;
  }
  return '/' + parts.join('/');
}

/** Every strategy that finds this element, best first (see packages/flows). Pure data: no secrets, no field values. */
function computeLocator(el: Element): Json {
  const he = el as HTMLInputElement;
  const tag = el.tagName.toLowerCase();
  const loc: Json = { tag };
  const testId = el.getAttribute('data-testid') ?? el.getAttribute('data-test') ?? el.getAttribute('data-qa') ?? el.getAttribute('data-cy');
  if (testId) loc.testId = testId;
  const role = el.getAttribute('role') ?? implicitRole(el);
  const text = textOf(el, 60);
  const label = cleanLabelFor(el);
  const name = label || (['button', 'a', 'summary'].includes(tag) || role === 'button' || role === 'link' || role === 'option' ? text : '');
  if (role && name) { loc.role = role; loc.name = name.slice(0, 80); }
  if (label && (['input', 'select', 'textarea'].includes(tag) || isEditable(el))) loc.label = label.slice(0, 80);
  if (he.placeholder) loc.placeholder = he.placeholder.slice(0, 80);
  if (el.id && !GENERATED_ID.test(el.id)) loc.id = el.id;
  if (he.name && ['input', 'select', 'textarea', 'button'].includes(tag)) loc.nameAttr = he.name;
  if (text && ['button', 'a', 'summary', 'span', 'div', 'li'].includes(tag) && text.length <= 40) loc.text = text;
  const shadow = shadowChain(el);
  loc.css = cssPath(el);
  if (shadow.length) loc.shadow = shadow; // css is relative to the innermost shadow root, and an xpath cannot cross one
  else loc.xpath = xpathOf(el);
  if (isDisabled(el)) loc.disabled = true;
  // When the best strategy matches several elements, say which one this is.
  for (const [, find] of locatorTries(loc)) {
    const hits = find();
    if (!hits.length) continue;
    const at = hits.indexOf(el);
    if (hits.length > 1 && at >= 0) loc.nth = at;
    if (at >= 0) break;
  }
  return loc;
}

function isDisabled(el: Element): boolean {
  return (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true' || el.closest('fieldset[disabled]') !== null;
}

/** The CSS of each open shadow host between the document and this element, outermost first (each one relative to the root it sits in). */
function shadowChain(el: Element): string[] {
  const chain: string[] = [];
  let root = el.getRootNode();
  while (root instanceof ShadowRoot) {
    chain.unshift(cssPath(root.host));
    root = root.host.getRootNode();
  }
  return chain;
}

/** The ways a recorded locator can find its element, best first. Used both to record `nth` and to look the element up again. */
function locatorTries(loc: Json): [string, () => Element[]][] {
  const byText = (sel: string, text: string) => deepAll(sel).filter((e) => textOf(e, 200) === text);
  const tries: [string, () => Element[]][] = [];
  if (loc.testId) tries.push(['testId', () => deepAll(`[data-testid=${JSON.stringify(loc.testId)}],[data-test=${JSON.stringify(loc.testId)}],[data-qa=${JSON.stringify(loc.testId)}]`)]);
  if (loc.role && loc.name) tries.push(['role', () => deepAll(INTERACTIVE).filter((e) => (e.getAttribute('role') ?? implicitRole(e)) === loc.role && (labelFor(e) === loc.name || textOf(e, 80) === loc.name))]);
  if (loc.label) tries.push(['label', () => deepAll('input,select,textarea,[contenteditable],[role=textbox],[role=combobox]').filter((e) => cleanLabelFor(e) === loc.label)]);
  if (loc.placeholder) tries.push(['placeholder', () => deepAll(`[placeholder=${JSON.stringify(loc.placeholder)}]`)]);
  if (loc.id) tries.push(['id', () => deepAll(`[id=${JSON.stringify(loc.id)}]`)]);
  if (loc.nameAttr) tries.push(['name', () => deepAll(`[name=${JSON.stringify(loc.nameAttr)}]`)]);
  if (loc.text) tries.push(['text', () => byText('button,a,summary,span,div,li', String(loc.text))]);
  if (loc.css) {
    tries.push(['css', () => {
      try {
        let scope: ParentNode = document;
        for (const host of (loc.shadow as string[] | undefined) ?? []) {
          const h = scope.querySelector(host);
          if (!h?.shadowRoot) return [];
          scope = h.shadowRoot;
        }
        return [...scope.querySelectorAll(String(loc.css))];
      } catch {
        return [];
      }
    }]);
  }
  if (loc.xpath) tries.push(['xpath', () => { try { const r = document.evaluate(String(loc.xpath), document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); return Array.from({ length: r.snapshotLength }, (_, i) => r.snapshotItem(i) as Element); } catch { return []; } }]);
  return tries;
}

let flowParts: Json[] = [];
/** Record what an action touched; the message handler attaches it to the reply as `_flow` (the server strips it before the agent sees it). */
function capture(el: Element, extra: Json = {}): void {
  try {
    flowParts.push({ url: location.href, ...(window !== window.top ? { frameUrl: location.href } : {}), locator: computeLocator(el), fieldLabel: cleanLabelFor(el) || undefined, ...extra });
  } catch {
    /* recording must never break an action */
  }
}

// ---------- input helpers ----------
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}
function fire(el: Element, ...types: string[]): void {
  for (const t of types) el.dispatchEvent(new Event(t, { bubbles: true, cancelable: true, composed: true }));
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

/** CAPTCHA widgets (reCAPTCHA, Turnstile) judge the mouse sequence: hover, move, down, up, then a click that carries coordinates. A bare click() leaves them spinning. */
const CAPTCHA_FRAME = /\/recaptcha\/|challenges\.cloudflare\.com|hcaptcha\.com/;
function humanClick(el: Element): void {
  const r = (el as HTMLElement).getBoundingClientRect();
  const x = r.left + r.width * (0.35 + Math.random() * 0.3);
  const y = r.top + r.height * (0.35 + Math.random() * 0.3);
  const pt = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x + (window.screenX || 0), screenY: y + (window.screenY || 0) };
  const pointer = { ...pt, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  for (const t of ['pointerover', 'pointerenter', 'pointermove']) el.dispatchEvent(new PointerEvent(t, pointer));
  for (const t of ['mouseover', 'mouseenter', 'mousemove']) el.dispatchEvent(new MouseEvent(t, pt));
  (el as HTMLElement).focus?.({ preventScroll: true });
  el.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, button: 0, buttons: 1 }));
  el.dispatchEvent(new MouseEvent('mousedown', { ...pt, button: 0, buttons: 1, detail: 1 }));
  el.dispatchEvent(new PointerEvent('pointerup', { ...pointer, button: 0, buttons: 0 }));
  el.dispatchEvent(new MouseEvent('mouseup', { ...pt, button: 0, buttons: 0, detail: 1 }));
  el.dispatchEvent(new MouseEvent('click', { ...pt, button: 0, detail: 1 }));
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
  const fields = deepAll('input,select,textarea', scope)
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
  const buttons = deepAll('button,input[type=submit]', scope).map(describe);
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

/**
 * File boxes are often hidden (display:none behind a styled drop zone) and unlabeled, so the label/name/id lookup that works
 * for text fields misses them. Try, in order: an element ref, the usual field match, a CSS selector, the text around each file box
 * ("Carica il tuo CV", the accept types), and finally the only file box on the page. Searches the whole document, since upload
 * popups usually live outside the <form>.
 */
function findFileInput(scope: Element, key: string): HTMLInputElement | null {
  const isFile = (e: unknown): e is HTMLInputElement => e instanceof HTMLInputElement && e.type === 'file' && !e.disabled;
  if (key.startsWith(EPOCH + ':')) {
    const el = refs.get(key)?.deref();
    if (isFile(el)) return el;
  }
  const byField = findField(scope, key);
  if (isFile(byField)) return byField;
  try {
    const bySel = document.querySelector(key);
    if (isFile(bySel)) return bySel;
  } catch {
    /* not a selector */
  }
  const all = deepAll('input[type=file]').filter(isFile);
  const words = key.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
  const context = (e: HTMLInputElement) =>
    `${labelFor(e)} ${e.name} ${e.id} ${e.accept} ${e.getAttribute('aria-label') ?? ''} ${textOf(e.closest('label,[role=dialog],[class*=drop],[class*=upload],section,form,div') ?? e, 200)}`.toLowerCase();
  const scored = all.map((e) => ({ e, s: words.filter((w) => context(e).includes(w)).length })).sort((a, b) => b.s - a.s);
  if (scored[0] && scored[0].s > 0 && scored[0].s > (scored[1]?.s ?? 0)) return scored[0].e;
  return all.length === 1 ? all[0]! : null;
}

function findField(scope: Element, key: string): Element | null {
  const k = key.trim().toLowerCase();
  const all = deepAll('input,select,textarea', scope).filter((e) => !(e instanceof HTMLInputElement && ['hidden', 'submit', 'button'].includes(e.type)));
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
      if (el.shadowRoot) node.shadow = true;
      const kids = [...(el.shadowRoot?.children ?? []), ...el.children].map((c) => walk(c, depth + 1)).filter(Boolean);
      if (kids.length) node.children = kids;
    }
    return node;
  };
  const tree = walk(root, 0);
  return { tree, nodeCount: count, truncated };
}

// ---------- operations ----------
/** One "n | kind | label | ref" line of the interactive_elements table (state says whether a field holds something, never what). */
function tableRow(e: Element, i: number, withRef = true): string {
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
  return `${i + 1} | ${kind}${he.disabled ? ' (disabled)' : ''}${isEditable(e) ? ' (editable)' : ''}${state} | ${label}${withRef ? ` | ${refFor(e)}` : ''}`;
}

// ---------- data tables ----------
const TABLE_LIKE = 'table,[role=table],[role=grid],[role=treegrid]';
const cellText = (c: Element): string => ((c as HTMLElement).innerText ?? c.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
const spanOf = (c: Element, html: string, aria: string): number => Math.max(1, Math.min(100, Number(c.getAttribute(html) ?? c.getAttribute(aria) ?? 1) || 1));

/**
 * One table as a grid of text. Merged cells are expanded (the merged value is repeated in every cell it covers) and reported in `merges`,
 * so a column never shifts. The first header row, if there is one, gives the column names.
 */
function extractTable(el: Element, index: number, maxRows: number, withLinks: boolean): Json {
  const html = el instanceof HTMLTableElement;
  const rowEls = html ? [...(el as HTMLTableElement).rows] : [...el.querySelectorAll('[role=row]')];
  const cellsOf = (r: Element): Element[] => (html ? [...(r as HTMLTableRowElement).cells] : [...r.querySelectorAll('[role=cell],[role=gridcell],[role=columnheader],[role=rowheader]')]);
  const isHeaderRow = (r: Element, cells: Element[]): boolean =>
    cells.length > 0 && (cells.every((c) => c.tagName === 'TH' || c.getAttribute('role') === 'columnheader') || (html && r.parentElement?.tagName === 'THEAD'));

  type Cell = { text: string; href: string | null };
  const placed = new Map<string, Cell>();
  const merges: { row: number; col: number; rowSpan: number; colSpan: number }[] = [];
  const limit = Math.min(rowEls.length, maxRows + 3);
  let width = 0;
  let headerAt = -1;
  for (let r = 0; r < limit; r++) {
    const cells = cellsOf(rowEls[r]!);
    if (headerAt < 0 && r < 3 && isHeaderRow(rowEls[r]!, cells)) headerAt = r;
    let c = 0;
    for (const cell of cells) {
      while (placed.has(`${r},${c}`)) c++;
      const cs = spanOf(cell, 'colspan', 'aria-colspan');
      const rs = spanOf(cell, 'rowspan', 'aria-rowspan');
      const a = cell.querySelector('a[href]') as HTMLAnchorElement | null;
      const value: Cell = { text: cellText(cell), href: withLinks && a ? a.href.slice(0, 1000) : null };
      for (let dr = 0; dr < rs; dr++) for (let dc = 0; dc < cs; dc++) placed.set(`${r + dr},${c + dc}`, value);
      if (cs > 1 || rs > 1) merges.push({ row: r, col: c, rowSpan: rs, colSpan: cs });
      c += cs;
      width = Math.max(width, c);
    }
  }
  width = Math.min(width, 60);
  const grid = (r: number): Cell[] => Array.from({ length: width }, (_v, c) => placed.get(`${r},${c}`) ?? { text: '', href: null });
  const used = new Set<string>();
  const headers: string[] | null = headerAt >= 0
    ? grid(headerAt).map((cell, i) => {
        let name = cell.text || `column_${i + 1}`;
        for (let n = 2; used.has(name); n++) name = `${cell.text || `column_${i + 1}`} (${n})`;
        used.add(name);
        return name;
      })
    : null;
  const bodyIdx: number[] = [];
  for (let r = 0; r < limit; r++) if (r !== headerAt) bodyIdx.push(r);
  const body = bodyIdx.slice(0, maxRows);
  const totalRows = Math.max(0, rowEls.length - (headerAt >= 0 ? 1 : 0));
  const caption = (el instanceof HTMLTableElement && el.caption ? cellText(el.caption) : '') || el.getAttribute('aria-label') || '';
  return {
    index, kind: html ? 'table' : 'grid', caption: caption.slice(0, 200), headers, columns: width,
    rows: body.map((r) => grid(r).map((x) => x.text)),
    ...(withLinks ? { links: body.map((r) => grid(r).map((x) => x.href)) } : {}),
    merges: merges.filter((m) => m.row !== headerAt).slice(0, 200),
    totalRows, truncated: totalRows > body.length,
  };
}


const ops: Record<string, (args: Json, approved: boolean) => Promise<unknown> | unknown> = {
  ping: () => ({ epoch: EPOCH, url: location.href }),

  page_text: (args) => {
    const max = Math.min(Number(args.maxChars ?? 50_000), 200_000);
    const text = (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n');
    return { url: location.href, title: document.title, text: text.slice(0, max), truncated: text.length > max, totalChars: text.length };
  },

  tables: (args) => {
    const max = Math.min(Number(args.maxRows ?? 500), 5000);
    const sel = typeof args.selector === 'string' && args.selector ? args.selector : null;
    let els: Element[];
    try {
      els = sel ? [...document.querySelectorAll(sel)].flatMap((e) => (e.matches(TABLE_LIKE) ? [e] : [...e.querySelectorAll(TABLE_LIKE)])) : [...document.querySelectorAll(TABLE_LIKE)];
    } catch {
      throw new CallError('INVALID_ARGUMENTS', 'Invalid selector');
    }
    // Skip hidden ones and layout tables (a single row or a single column of cells carries no data).
    const tables = els.filter(isVisible).map((e, i) => extractTable(e, i, max, args.includeLinks === true)).filter((t) => sel || ((t.totalRows as number) >= 1 && (t.columns as number) >= 2));
    return { url: location.href, title: document.title, epoch: EPOCH, tables: tables.map((t, i) => ({ ...t, index: i })) };
  },

  dom_snapshot: (args) => {
    const rootSel = args.root as string | undefined;
    const root = rootSel ? document.querySelector(rootSel) : document.body;
    if (!root) throw new CallError('ELEMENT_NOT_FOUND', 'Root element not found');
    return { url: location.href, title: document.title, ...snapshot(root, Math.min(Number(args.maxNodes ?? 2000), 5000)) };
  },

  // Read-only: reports which CAPTCHA widgets the page carries and their public site keys. Nothing is clicked or solved here.
  captcha_scan: () => {
    const widgets: Json[] = [];
    const add = (w: Json) => { if (!widgets.some((x) => x.kind === w.kind && x.siteKey === w.siteKey)) widgets.push(w); };
    const key = (el: Element) => el.getAttribute('data-sitekey') || '';
    for (const el of document.querySelectorAll('.g-recaptcha[data-sitekey]')) {
      add({ kind: 'recaptcha_v2', siteKey: key(el), invisible: el.getAttribute('data-size') === 'invisible' || undefined });
    }
    for (const el of document.querySelectorAll('.cf-turnstile[data-sitekey]')) add({ kind: 'turnstile', siteKey: key(el), action: el.getAttribute('data-action') || undefined });
    for (const el of document.querySelectorAll('.h-captcha[data-sitekey]')) add({ kind: 'hcaptcha', siteKey: key(el) });
    for (const f of document.querySelectorAll('iframe[src]')) {
      let u: URL;
      try { u = new URL(f.getAttribute('src') || '', location.href); } catch { continue; }
      if (/(^|\.)(google\.com|recaptcha\.net)$/.test(u.hostname) && u.pathname.includes('/recaptcha/') && u.searchParams.get('k')) {
        if (!widgets.some((x) => x.siteKey === u.searchParams.get('k'))) add({ kind: 'recaptcha_v2', siteKey: u.searchParams.get('k') as string, enterprise: u.pathname.includes('/enterprise/') || undefined });
      }
    }
    // reCAPTCHA v3 / Enterprise load as <script src=".../api.js?render=SITEKEY"> and are driven by grecaptcha.execute(SITEKEY, {action}).
    for (const s of document.querySelectorAll('script[src]')) {
      let u: URL;
      try { u = new URL(s.getAttribute('src') || '', location.href); } catch { continue; }
      const render = u.searchParams.get('render');
      if (/(^|\.)(google\.com|recaptcha\.net)$/.test(u.hostname) && u.pathname.includes('/recaptcha/') && render && render !== 'explicit') {
        const inline = [...document.querySelectorAll('script:not([src])')].map((x) => x.textContent ?? '').join('\n');
        const action = new RegExp(`grecaptcha(?:\\.enterprise)?\\.execute\\(\\s*['"]${render.replace(/[^\w-]/g, '')}['"]\\s*,\\s*\\{[^}]*action\\s*:\\s*['"]([^'"]+)['"]`).exec(inline)?.[1];
        add({ kind: 'recaptcha_v3', siteKey: render, action, enterprise: u.pathname.includes('/enterprise') || undefined });
      }
    }
    return { url: location.href, epoch: EPOCH, widgets: widgets.filter((w) => w.siteKey) };
  },

  interactive_elements: (args) => {
    const table = args.format === 'table';
    const limit = Math.min(Number(args.limit ?? (table ? 100 : 300)), 1000);
    const inView = (e: Element) => { const r = (e as HTMLElement).getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; };
    let els = deepAll(INTERACTIVE).filter((e) => !(e instanceof HTMLInputElement && e.type === 'hidden'));
    // Hidden file inputs stay listed: they are how uploads work behind styled drop zones.
    if (args.visibleOnly !== false) els = els.filter((e) => isVisible(e) || (e instanceof HTMLInputElement && e.type === 'file'));
    if (args.inViewport === true) els = els.filter(inView);
    else if (table) els = [...els.filter(inView), ...els.filter((e) => !inView(e))]; // on-screen controls first
    const base = { url: location.href, title: document.title, epoch: EPOCH, total: els.length, truncated: els.length > limit };
    if (!table) return { ...base, elements: els.slice(0, limit).map(describe) };
    const rows = els.slice(0, limit).map((e, i) => tableRow(e, i));
    // Confirmation / error cues that are not controls ("Thanks, your account was created"), so the agent can tell when it is done.
    const notes = [...document.querySelectorAll('h1,h2,h3,[role=alert],[role=status],[aria-live],[class*=success],[class*=error],[class*=alert]')]
      .filter(isVisible).map((e) => textOf(e, 90)).filter(Boolean).filter((t, i, a) => a.indexOf(t) === i).slice(0, 6);
    return { ...base, rows, notes };
  },

  forms: () => {
    const forms = [...document.forms];
    const out = forms.map((f, i) => describeForm(f, f, i));
    // Fields outside any <form> (SPA style) are grouped as one pseudo-form.
    const loose = deepAll('input,select,textarea').filter((e) => !(e as HTMLInputElement).form && !(e instanceof HTMLInputElement && e.type === 'hidden'));
    if (loose.length) out.push(describeForm(null, document.body, out.length));
    return { url: location.href, epoch: EPOCH, forms: out };
  },

  click: (args, approved) => {
    const el = resolveTarget(args);
    // Before any approval is asked for: a disabled control cannot be clicked, and recording the click would teach a replay to press it.
    if (isDisabled(el)) throw new CallError('ELEMENT_DISABLED', 'The element is disabled (a submit button often enables only after a required field is filled or a file is uploaded); nothing was clicked');
    const risk = riskOfClick(el);
    if (risk && !approved) throw Object.assign(new CallError('APPROVAL_REQUIRED', risk), { risk });
    // Check first, scroll only if needed: scrolling closes popup menus (e.g. custom dropdown listboxes) before we can click them.
    if (!isVisible(el) && !(el instanceof HTMLInputElement)) throw new CallError('INVALID_ARGUMENTS', 'Element is not visible');
    const box = (el as HTMLElement).getBoundingClientRect();
    if (box.bottom < 0 || box.top > innerHeight || box.right < 0 || box.left > innerWidth) (el as HTMLElement).scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (el instanceof HTMLElement && (isEditable(el) || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) (editableHost(el) ?? el).focus();
    const role = el.getAttribute('role') ?? '';
    if (['option', 'combobox', 'menuitem'].includes(role)) pointerClick(el);
    else if (role === 'checkbox' || CAPTCHA_FRAME.test(location.href)) humanClick(el);
    else (el as HTMLElement).click();
    const stateful = el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio');
    capture(el, { consequential: Boolean(risk), ...(stateful ? { state: (el as HTMLInputElement).checked ? 'checked' : 'unchecked' } : {}) });
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
      capture(host, { consequential: args.submit === true });
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
      el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, composed: true }));
      cur += ch;
      setNativeValue(el, cur);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true, composed: true }));
    }
    fire(el, 'change');
    if (args.submit) await pressEnter(el);
    capture(el, { sensitive: isPassword(el), consequential: isPassword(el) || args.submit === true });
    return { typed: text.length };
  },

  fill_field: async (args, approved) => {
    const el = resolveTarget(args);
    const host = editableHost(el);
    if (host) {
      await typeIntoEditable(host, String(args.value ?? ''), true);
      capture(host);
      return { filled: true, element: describe(host) };
    }
    assertFillable(el);
    if (isPassword(el) && !approved) throw Object.assign(new CallError('APPROVAL_REQUIRED', 'Fill a password field'), { risk: 'Fill a password field' });
    fillElement(el, String(args.value ?? ''));
    capture(el, { sensitive: isPassword(el), consequential: isPassword(el) });
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
      capture(el, { custom: true });
      return { selected: textOf(hit, 60), custom: true };
    }
    if (!(el instanceof HTMLSelectElement)) throw new CallError('INVALID_ARGUMENTS', 'Target is not a <select> or combobox');
    const opt = [...el.options].find((o) => (value !== undefined && o.value === value) || (label !== undefined && o.text.trim().toLowerCase() === label.toLowerCase()));
    if (!opt) throw new CallError('ELEMENT_NOT_FOUND', 'Option not found', { available: [...el.options].slice(0, 50).map((o) => o.text.trim()) });
    el.value = opt.value;
    fire(el, 'input', 'change');
    capture(el);
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
      capture(edHost, { consequential: key === 'Enter' && !mods.includes('Shift') });
      return { pressed: key };
    }
    const init = { key, bubbles: true, composed: true, cancelable: true, ctrlKey: mods.includes('Control'), shiftKey: mods.includes('Shift'), altKey: mods.includes('Alt'), metaKey: mods.includes('Meta') };
    (el as HTMLElement).focus?.();
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    if (key === 'Enter') await pressEnterDefault(el);
    else if (key === 'Tab') focusNext(el, mods.includes('Shift'));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    if (el !== document.body) capture(el, { consequential: key === 'Enter' && Boolean(el.closest('form')) });
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
    // Don't ask the human to approve an upload that cannot happen: check every file box exists first.
    const missingBoxes = files.filter((f) => !findFileInput(document.body, f.key));
    if (missingBoxes.length && !approved) {
      const count = document.querySelectorAll('input[type=file]').length;
      return {
        filled: [], submitted: false, requiredMissing: [],
        notFound: missingBoxes.map((f) => `${f.key} (no file input${count ? `: ${count} on the page, none matched; pass the ref from browser_get_interactive_elements` : ' on the page yet; open the upload dialog first, without clicking the button that opens the system file picker'})`),
      };
    }
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
        capture(el, { kind: 'fill', sensitive: isPassword(el), consequential: isPassword(el), value: isPassword(el) ? undefined : f.value });
        filled.push({ key: f.key, matched: labelFor(el) || (el as HTMLInputElement).name || el.id });
      } catch (e) {
        notFound.push(`${f.key} (${(e as Error).message})`);
      }
    }
    for (const file of files) {
      const el = findFileInput(scope, file.key);
      if (!el) {
        const count = document.querySelectorAll('input[type=file]').length;
        notFound.push(`${file.key} (no file input${count ? `: ${count} on the page, none matched; pass the ref from browser_get_interactive_elements` : ' on the page yet; open the upload dialog first, without clicking the button that opens the system file picker'})`);
        continue;
      }
      const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], file.fileName, { type: file.mimeType }));
      el.files = dt.files;
      fire(el, 'input', 'change');
      capture(el, { kind: 'upload', consequential: true, value: file.fileName });
      filled.push({ key: file.key, matched: labelFor(el) || el.name || el.id || 'file input', file: file.fileName, accepted: el.files?.length === 1 });
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
        if (btn) capture(btn, { kind: 'click', consequential: true });
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
  /** Find an element from a recorded flow: try each strategy in order, accept the first that matches exactly one visible element, else the first match. */
  // Finds the element again from a recorded locator. waitMs: keep looking for that long (a form that is still loading); requireEnabled: ignore disabled
  // controls and wait for one to be enabled (a submit that unlocks after a file is attached). A recorded `nth` picks one of several equal matches.
  resolve_locator: async (args) => {
    const loc = (args.locator ?? {}) as Json;
    const deadline = Date.now() + Math.min(Math.max(Number(args.waitMs ?? 0), 0), 15_000);
    const needEnabled = args.requireEnabled === true;
    for (;;) {
      let fallback: { how: string; el: Element; n: number } | null = null;
      let sawDisabled = false;
      for (const [how, find] of locatorTries(loc)) {
        const raw = find();
        const hits = needEnabled ? raw.filter((h) => !isDisabled(h)) : raw;
        if (needEnabled && raw.length > hits.length) sawDisabled = true;
        if (hits.length === 1 && (raw.length === 1 || typeof loc.nth !== 'number')) return { ref: refFor(hits[0]!), how, element: describe(hits[0]!), ambiguous: raw.length };
        if (raw.length > 1) {
          const chosen = typeof loc.nth === 'number' ? raw[loc.nth] : undefined;
          if (chosen && (!needEnabled || !isDisabled(chosen))) return { ref: refFor(chosen), how: `${how} #${loc.nth}`, element: describe(chosen), ambiguous: raw.length };
          if (hits.length && !fallback) fallback = { how, el: hits.find(isVisible) ?? hits[0]!, n: raw.length };
        }
      }
      if (fallback) return { ref: refFor(fallback.el), how: `${fallback.how} (first of several)`, element: describe(fallback.el), ambiguous: fallback.n };
      if (Date.now() >= deadline) {
        if (sawDisabled) throw new CallError('ELEMENT_DISABLED', 'The recorded element is on the page but disabled (a submit often enables only after a required field is filled or a file is uploaded)');
        throw new CallError('ELEMENT_NOT_FOUND', 'No strategy in the recorded locator matches an element on this page');
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  },

  scroll_to: (args) => { window.scrollTo(0, Number(args.y ?? 0)); return { scrollY: window.scrollY }; },
};

async function pressEnter(el: Element): Promise<void> {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true, cancelable: true }));
  await pressEnterDefault(el);
  el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, composed: true }));
}
async function pressEnterDefault(el: Element): Promise<void> {
  if (el instanceof HTMLInputElement && el.form && !['checkbox', 'radio', 'file'].includes(el.type)) el.form.requestSubmit();
  else if (el instanceof HTMLButtonElement || (el instanceof HTMLInputElement && ['submit', 'button'].includes(el.type))) el.click();
}
function focusNext(el: Element, back: boolean): void {
  const items = (deepAll(INTERACTIVE) as HTMLElement[]).filter(isVisible);
  const i = items.indexOf(el as HTMLElement);
  const next = items[(i + (back ? -1 : 1) + items.length) % items.length];
  next?.focus();
}

// ---------- "Record me": the person's own clicks and fields, relayed to the background (only while the popup switch is on) ----------
// Only trusted events count (a real click or keystroke), so BrowserForge's own synthetic actions are never recorded as the person's.
// Values stay in the page: a typed value is sent only when the person turned on "Store my values", and never for password-like fields.
const SENSITIVE_FIELD = /\b(pass(word|wd)?|pwd|cvv|cvc|iban|ssn|otp|token|secret|pin)\b|cc-|one-time|security.?code|(credit|debit).?card|card.?(number|no)\b/i;
function isSensitiveField(el: Element): boolean {
  if (isPassword(el)) return true;
  const he = el as HTMLInputElement;
  if (/^(cc-|one-time-code|current-password|new-password)/.test(el.getAttribute('autocomplete') ?? '')) return true;
  return SENSITIVE_FIELD.test(`${he.name ?? ''} ${el.id} ${he.placeholder ?? ''} ${labelFor(el)}`);
}

const rec = { on: false, values: false };
let snap: { at: number; els: Element[]; rows: string[] } | null = null;
const baseline = new WeakMap<Element, string>();

/** The controls on screen as the agent would see them (on-screen ones first), with refs left out. */
function takeSnapshot(): void {
  try {
    const inView = (e: Element) => { const r = (e as HTMLElement).getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; };
    const all = deepAll(INTERACTIVE).filter((e) => !(e instanceof HTMLInputElement && e.type === 'hidden') && (isVisible(e) || (e instanceof HTMLInputElement && e.type === 'file')));
    const els = [...all.filter(inView), ...all.filter((e) => !inView(e))].slice(0, 100);
    snap = { at: Date.now(), els, rows: els.map((e, i) => tableRow(e, i, false).slice(0, 190)) };
  } catch {
    snap = null;
  }
}

const isTextField = (el: Element): boolean =>
  el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'hidden', 'range', 'color'].includes(el.type));
const fieldValue = (el: Element): string => (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ? el.value : textOf(el, 2000));

function stringsOnly(loc: Json): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(loc)) if (typeof v === 'string' && v) out[k] = v.slice(0, 600);
  return out;
}

function relay(kind: 'click' | 'fill' | 'select' | 'press' | 'upload', el: Element, extra: Json = {}): void {
  try {
    const sensitive = isSensitiveField(el);
    const idx = snap && Date.now() - snap.at < 15_000 ? snap.els.indexOf(el) : -1;
    const loc = computeLocator(el);
    const data: Json = {
      kind, url: location.href, ...(window !== window.top ? { frameUrl: location.href } : {}),
      locator: stringsOnly(loc),
      ...(typeof loc.nth === 'number' ? { nth: loc.nth } : {}), ...(Array.isArray(loc.shadow) ? { shadow: (loc.shadow as string[]).slice(0, 8).map((x) => String(x).slice(0, 600)) } : {}),
      fieldLabel: cleanLabelFor(el).slice(0, 120) || undefined,
      ...(sensitive ? { sensitive: true } : {}),
      ...(idx >= 0 && snap ? { row: idx + 1, table: snap.rows } : {}),
      ...extra,
    };
    if (sensitive || !rec.values || kind === 'upload') delete data.value;
    void Promise.resolve(api.runtime.sendMessage({ kind: 'bf-human', data })).catch(() => undefined); // the extension may have been reloaded
  } catch {
    /* recording must never break the page */
  }
}

/** Send the field's text if it changed since the person started (or last sent it). */
function flushField(el: Element): void {
  const now = fieldValue(el);
  if (now === (baseline.get(el) ?? '')) return;
  baseline.set(el, now);
  if (el instanceof HTMLSelectElement) relay('select', el, { value: el.selectedOptions[0]?.text.trim() ?? now });
  else relay('fill', el, { value: now });
}

function applyRecord(v: unknown): void {
  const r = (v ?? {}) as { on?: boolean; values?: boolean };
  rec.on = r.on === true && !api.extension?.inIncognitoContext;
  rec.values = r.values === true;
  if (!rec.on) snap = null;
}

function startRecorder(): void {
  const trusted = (e: Event) => rec.on && e.isTrusted;
  // Events inside an open shadow root reach `document` retargeted to the host: the first entry of the composed path is the real element.
  const realTarget = (e: Event): EventTarget | null => e.composedPath()[0] ?? e.target;
  const controlOf = (t: EventTarget | null): Element | null => (t instanceof Element ? t.closest(INTERACTIVE) : null);
  const onChange = (e: Event): void => {
    const el = realTarget(e);
    if (!trusted(e) || !(el instanceof Element)) return;
    if (el instanceof HTMLInputElement && el.type === 'file') relay('upload', el, { consequential: true });
    else if (isTextField(el) || el instanceof HTMLSelectElement) flushField(el);
  };
  // `change` does not cross a shadow boundary, so every shadow root an interaction passes through gets its own listener (the first focus or click inside it comes before any change).
  const watched = new WeakSet<Node>();
  const watchRoots = (e: Event): void => {
    for (const n of e.composedPath()) {
      if (n instanceof ShadowRoot && !watched.has(n)) {
        watched.add(n);
        n.addEventListener('change', onChange, true);
      }
    }
  };
  document.addEventListener('pointerdown', (e) => { watchRoots(e); if (trusted(e)) takeSnapshot(); }, true);
  document.addEventListener('focusin', (e) => {
    watchRoots(e);
    const t = realTarget(e);
    if (!trusted(e) || !(t instanceof Element)) return;
    takeSnapshot();
    if (isTextField(t) || t instanceof HTMLSelectElement || isEditable(t)) baseline.set(t, fieldValue(t));
  }, true);
  document.addEventListener('click', (e) => {
    watchRoots(e);
    if (!trusted(e)) return;
    const el = controlOf(realTarget(e));
    if (!el || isTextField(el) || el instanceof HTMLSelectElement || isEditable(el) || el.tagName === 'OPTION' || (el instanceof HTMLInputElement && el.type === 'file')) return; // fields are recorded by what they end up holding
    if (!snap || Date.now() - snap.at > 15_000) takeSnapshot(); // a click made with the keyboard has no pointerdown
    relay('click', el, { consequential: riskOfClick(el) !== null, ...(el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') ? { state: el.checked ? 'checked' : 'unchecked' } : {}) });
  }, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener('focusout', (e) => {
    const t = realTarget(e);
    if (trusted(e) && t instanceof Element && isEditable(t) && !isTextField(t)) flushField(t); // rich-text boxes have no change event
  }, true);
  document.addEventListener('keydown', (e) => {
    watchRoots(e);
    const t = realTarget(e);
    if (!trusted(e) || e.key !== 'Enter' || e.isComposing || !(t instanceof HTMLInputElement) || !isTextField(t)) return;
    flushField(t); // the text first, then the Enter that sends it
    const f = t.form;
    relay('press', t, { key: 'Enter', consequential: Boolean(f && f.querySelector('button:not([type=button]):not([type=reset]),input[type=submit],input[type=image]')) });
  }, true);
  try {
    void Promise.resolve(api.storage.local.get('record')).then((r: { record?: unknown }) => applyRecord(r?.record)).catch(() => undefined);
    api.storage.onChanged.addListener((ch: Record<string, { newValue?: unknown }>, area: string) => { if (area === 'local' && ch.record) applyRecord(ch.record.newValue); });
  } catch {
    /* storage unavailable: recording stays off */
  }
}

// The background injects this script on demand into frames; a second injection into the same frame must not add a second listener.
const g = globalThis as unknown as { __bfContentLoaded?: boolean };
if (!g.__bfContentLoaded) {
g.__bfContentLoaded = true;
startRecorder();
api.runtime.onMessage.addListener(((msg: ContentCall, _sender: unknown, sendResponse: (r: ContentReply) => void) => {
  if (!msg || msg.kind !== 'bf-call') return false;
  const op = ops[msg.op];
  if (!op) {
    sendResponse({ ok: false, error: { code: 'UNSUPPORTED', message: `Unknown operation ${msg.op}` } });
    return false;
  }
  flowParts = [];
  Promise.resolve()
    .then(() => op(msg.args ?? {}, msg.approved === true))
    .then((result) => {
      if (flowParts.length && result && typeof result === 'object') (result as Json)._flow = flowParts;
      sendResponse({ ok: true, result });
    })
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
}
