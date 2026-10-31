import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isHumanOnly, mapFields, renderTemplate, resolveOption, type FormField } from '../../apps/mcp-server/src/form-mapping.js';
import { ProfileStore } from '../../apps/mcp-server/src/profiles.js';

const f = (o: Partial<FormField> & { ref: string }): FormField => ({ visible: true, tag: 'input', type: 'text', ...o });
const profile = { fullName: 'Ada Lovelace', email: 'ada@example.com', phone: '+33 1 02 03 04 05', country: 'France', yearsExperience: '7' };

describe('field mapping', () => {
  const fields = [
    f({ ref: '1', label: 'Full name', name: 'full_name', required: true }),
    f({ ref: '2', label: 'Email address', name: 'email', type: 'email' }),
    f({ ref: '3', label: 'Phone', type: 'tel' }),
    f({ ref: '4', label: 'Country', tag: 'select', type: 'select-one', options: [{ value: 'FR', label: 'France' }, { value: 'DE', label: 'Germany' }] }),
    f({ ref: '5', label: 'Years of experience', type: 'number' }),
    f({ ref: '6', label: 'Cover letter', tag: 'textarea', type: 'textarea' }),
    f({ ref: '7', label: 'Password (account)', type: 'password' }),
    f({ ref: '8', label: 'I accept the terms and conditions', type: 'checkbox' }),
    f({ ref: '9', label: 'Gender', tag: 'select' }),
    f({ ref: '10', label: 'Expected salary' }),
    f({ ref: '11', label: 'Do you require visa sponsorship?' }),
    f({ ref: '12', label: 'Favourite colour' }),
    f({ ref: '13', label: 'CV', type: 'file' }),
  ];
  const r = mapFields(fields, profile);
  it('maps by label/type and leaves out what the profile does not contain', () => {
    expect(Object.fromEntries(r.mappings.map((m) => [m.field.ref, m.key]))).toEqual({ 1: 'fullName', 2: 'email', 3: 'phone', 4: 'country', 5: 'yearsExperience' });
    expect(r.unmapped.map((x) => x.ref)).toContain('6'); // no cover letter in the profile -> never invented
    expect(r.unmapped.map((x) => x.ref)).toContain('12');
  });
  it('never auto-fills credentials, declarations, protected characteristics, salary or work authorization', () => {
    expect(r.humanOnly.map((x) => x.ref).sort()).toEqual(['10', '11', '7', '8', '9']);
    for (const m of r.mappings) expect(isHumanOnly(m.field)).toBe(false);
    // even if the profile has matching keys
    const sneaky = mapFields(fields, { ...profile, password: 'x', salary: '1', gender: 'x', terms: 'yes' });
    expect(sneaky.mappings.map((m) => m.field.ref)).not.toEqual(expect.arrayContaining(['7', '8', '9', '10']));
  });
  it('prefers first/last name over full name when both are asked for', () => {
    const m = mapFields([f({ ref: 'a', label: 'First name' }), f({ ref: 'b', label: 'Last name' }), f({ ref: 'c', label: 'Full name' })], { firstName: 'Ada', lastName: 'L', fullName: 'Ada L' });
    expect(m.mappings.map((x) => x.key)).toEqual(['firstName', 'lastName']);
  });
  it('resolves select options by exact label or value only', () => {
    const sel = fields[3]!;
    expect(resolveOption(sel, 'france')).toBe('France');
    expect(resolveOption(sel, 'FR')).toBe('France');
    expect(resolveOption(sel, 'Fra')).toBeUndefined();
  });
});

describe('cover letter templates', () => {
  it('reports unresolved placeholders instead of inventing values', () => {
    const r = renderTemplate('Dear {{hiringManager}}, I am {{fullName}} applying to {{company}}.', { fullName: 'Ada' });
    expect(r.missing.sort()).toEqual(['company', 'hiringManager']);
    expect(r.text).toContain('{{company}}');
  });
});

describe('profile store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-prof-'));
  const file = path.join(dir, 'p.json');
  it('stores locally with 0600 permissions, merges, lists keys only, deletes', () => {
    const s = new ProfileStore(file);
    s.save('main', { email: 'a@b.c' }, 'replace');
    s.save('main', { phone: '1' }, 'merge');
    expect(s.get('main')).toEqual({ email: 'a@b.c', phone: '1' });
    expect(JSON.stringify(s.list())).not.toContain('a@b.c');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(s.delete('main')).toBe(true);
    expect(() => s.get('main')).toThrow();
  });
  it('rejects odd names, keys and oversized values', () => {
    const s = new ProfileStore(file);
    expect(() => s.save('../x', {}, 'replace')).toThrow();
    expect(() => s.save('ok', { 'bad key!': 'x' }, 'replace')).toThrow();
    expect(() => s.save('ok', { a: 'x'.repeat(6000) }, 'replace')).toThrow();
  });
});
