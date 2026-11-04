import type { Locator } from './schema.js';

/** "First name *" -> "first_name" */
export function paramName(label: string | undefined, fallback: string): string {
  const s = (label ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
  return s || fallback;
}

const SENSITIVE = /pass(word|wd)?|pwd|card|cvv|cvc|iban|ssn|otp|token|secret|pin(code)?$|security.?code/i;
export const looksSensitive = (name: string | undefined): boolean => SENSITIVE.test(name ?? '');

/** Ids produced by frameworks (":r1:", "_r_6_", "mui-123", long hex) change between visits and make bad locators. */
export function looksGeneratedId(id: string): boolean {
  // Kept identical to GENERATED_ID in apps/firefox-extension/src/content.ts (the content script cannot import this package).
  if (/^(:r[0-9a-z]+:|_r_\w+_|[0-9a-f]{8,})$/i.test(id) || /\d{4,}/.test(id)) return true;
  if (/^(mui|rc|react|radix|headlessui)[-_:]/i.test(id) || /^(ember\d|yui_|gwt-uid|__bvid__|j_idt\d|ctl\d)/i.test(id)) return true;
  if (/(^|[-_])\d{2,}([-_]|$)/.test(id)) return true; // "spl-form-element_54", "modal-92-description"
  // Short hashes such as "f363sx": letters and digits mixed with no separator (two or more switches), nothing a person would write.
  return /^[a-z0-9]{5,12}$/i.test(id) && (id.match(/[a-z]\d|\d[a-z]/gi) ?? []).length >= 2;
}

/** Hosts where every subdomain is a different site (a company's own job board), so they are never merged by registrable(). */
const OWN_SITE_SUFFIXES = ['myworkdayjobs.com', 'github.io', 'herokuapp.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'azurewebsites.net', 'blogspot.com', 'wordpress.com', 'intervieweb.it', 'teamtailor.com', 'smartrecruiters.com'];

/**
 * The part of a host that identifies the organisation: "joblink.allibo.com" and "am.allibo.com" -> "allibo.com", "x.co.uk" -> "x.co.uk".
 * Used to keep one task together when it moves between sibling hosts. Small on purpose: no public-suffix list.
 */
export function registrable(host: string): string {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  if (OWN_SITE_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`))) return h;
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const last = parts[parts.length - 1]!;
  const second = parts[parts.length - 2]!;
  const twoLevel = last.length === 2 && /^(co|com|org|net|gov|ac|edu)$/.test(second);
  return parts.slice(twoLevel ? -3 : -2).join('.');
}

const PERSONAL_LABEL = /e-?mail|phone|telefon|cellul|mobile|birth|nascita|\bdob\b|address|indirizzo|street|\bvia\b|post(al)?code|\bcap\b|\bzip\b|\bcity\b|citt[aà]|comune|town|national|country|paese|codice fiscale|fiscal|tax|linkedin|github|portfolio|website|\bname\b|\bnome\b|cognome|surname|salary|retribuzione|\bral\b|iban|cover|lettera|motivation|message|messaggio|about you|presentazione|summary|why /i;
const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;

/**
 * Typed values that identify the person (name, contact details, birth date, address, links, free text): stored with a flow only when the user
 * opted in to keeping values. Short answers to ordinary questions ("Yes", "Italian", "LinkedIn") are harmless and stay as defaults.
 */
export function looksPersonal(label: string | undefined, value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  if (PERSONAL_LABEL.test(label ?? '')) return true;
  const v = value.trim();
  return EMAIL.test(v) || /\d{7,}/.test(v.replace(/[\s().+-]/g, '')) || /^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}$/.test(v) || /^https?:\/\//i.test(v) || v.length > 60;
}

const TOKEN_PARAMS = /^(t|aid|rid|tid|sid|token|access_?token|session|sessionid|jsessionid|auth|key|code|state|nonce|sig|signature|dsh|tl|ticket|csrf)$/i;

/** An address without the query parameters that carry a session, login or one-time token. */
export function scrubUrl(url: string): string {
  try {
    const u = new URL(url);
    let changed = false;
    for (const k of [...u.searchParams.keys()]) {
      if (TOKEN_PARAMS.test(k)) {
        u.searchParams.delete(k);
        changed = true;
      }
    }
    return changed ? u.toString() : url;
  } catch {
    return url;
  }
}

/** Text taken from a page (a label, a button name) with e-mail addresses, long numbers and token parameters blanked out. */
export function scrubText(s: string): string {
  return s
    .replace(/https?:\/\/\S+/g, (m) => scrubUrl(m))
    .replace(/[^\s@]+@[^\s@]+\.[a-z]{2,}/gi, '<email>')
    .replace(/\b\d{9,}\b/g, '<number>');
}

export function describeLocator(l: Locator | undefined): string {
  if (!l) return 'page';
  return l.name ?? l.label ?? l.placeholder ?? l.text ?? l.testId ?? l.id ?? l.nameAttr ?? l.css ?? l.tag ?? 'element';
}

export function pyName(param: string): string {
  return param.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}
