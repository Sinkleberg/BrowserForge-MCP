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
  return /^(:r[0-9a-z]+:|_r_\w+_|[0-9a-f]{8,}|.*\d{4,}.*|(mui|rc|react|radix|headlessui)[-_:].*)$/i.test(id);
}

export function describeLocator(l: Locator | undefined): string {
  if (!l) return 'page';
  return l.name ?? l.label ?? l.placeholder ?? l.text ?? l.testId ?? l.id ?? l.nameAttr ?? l.css ?? l.tag ?? 'element';
}

export function pyName(param: string): string {
  return param.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}
