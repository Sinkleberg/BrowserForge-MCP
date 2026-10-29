import fs from 'node:fs';
import path from 'node:path';
import { BrowserForgeError } from '@browserforge/shared';

export type ProfileData = Record<string, string>;
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const NAME_RE = /^[A-Za-z0-9 _.-]{1,40}$/;
const MAX_PROFILES = 20;
const MAX_VALUE = 5000;

/** Canonical keys the form mapper understands. Any other key is stored but only used when a form label matches it exactly. */
export const KNOWN_KEYS = ['fullName', 'firstName', 'lastName', 'email', 'phone', 'city', 'country', 'address', 'postalCode', 'linkedin', 'website', 'github', 'headline', 'summary', 'coverLetter', 'yearsExperience', 'currentCompany', 'currentTitle', 'cvPath', 'coverLetterTemplate'] as const;

/**
 * Local profiles, stored only on this machine (0600) and only after the user explicitly consents.
 * The server never fabricates values: a key is either provided by the user or absent.
 */
export class ProfileStore {
  constructor(private file?: string) {}

  configure(file: string): void {
    this.file = file;
  }

  private load(): Record<string, ProfileData> {
    if (!this.file) return {};
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, ProfileData>;
    } catch {
      return {};
    }
  }

  private persist(all: Record<string, ProfileData>): void {
    if (!this.file) throw new BrowserForgeError('INTERNAL', 'Profile storage is not configured');
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    fs.chmodSync(this.file, 0o600);
  }

  list(): { name: string; keys: string[] }[] {
    return Object.entries(this.load()).map(([name, d]) => ({ name, keys: Object.keys(d) }));
  }

  get(name: string): ProfileData {
    const p = this.load()[name];
    if (!p) throw new BrowserForgeError('NOT_FOUND', `No profile named '${name}'`);
    return p;
  }

  save(name: string, data: ProfileData, mode: 'replace' | 'merge'): { name: string; keys: string[] } {
    if (!NAME_RE.test(name)) throw new BrowserForgeError('INVALID_ARGUMENTS', 'Profile names may use letters, digits, space, . _ - (max 40)');
    for (const [k, v] of Object.entries(data)) {
      if (!KEY_RE.test(k)) throw new BrowserForgeError('INVALID_ARGUMENTS', `Invalid profile key '${k}'`);
      if (typeof v !== 'string' || v.length > MAX_VALUE) throw new BrowserForgeError('INVALID_ARGUMENTS', `Value for '${k}' must be a string up to ${MAX_VALUE} characters`);
    }
    const all = this.load();
    if (!all[name] && Object.keys(all).length >= MAX_PROFILES) throw new BrowserForgeError('LIMIT_EXCEEDED', `At most ${MAX_PROFILES} profiles`);
    all[name] = mode === 'merge' ? { ...(all[name] ?? {}), ...data } : { ...data };
    this.persist(all);
    return { name, keys: Object.keys(all[name]!) };
  }

  delete(name: string): boolean {
    const all = this.load();
    if (!(name in all)) return false;
    delete all[name];
    this.persist(all);
    return true;
  }
}
