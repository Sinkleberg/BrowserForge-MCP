import type { ProfileData } from './profiles.js';

export interface FormField {
  ref: string;
  tag?: string;
  type?: string;
  name?: string;
  id?: string;
  label?: string;
  required?: boolean;
  visible?: boolean;
  disabled?: boolean;
  value?: string;
  checked?: boolean;
  options?: { value: string; label: string }[];
  accept?: string;
}

export interface Mapping {
  field: FormField;
  key?: string;
  confidence: 'high' | 'medium';
  reason: string;
}

/** Fields an agent must never fill on its own: credentials, legal declarations, protected characteristics, money. */
const HUMAN_ONLY = /(password|passcode|\bssn\b|social security|national id|passport|tax id|date of birth|\bdob\b|birth|gender|sex\b|ethnic|race\b|religio|disabilit|veteran|marital|criminal|convict|visa|sponsor|work authori[sz]ation|right to work|salary|compensation|expected pay|bank|iban|card number|cvv|security code|declaration|i (certify|declare|confirm|agree|accept)|terms|conditions|privacy|consent|gdpr|signature|captcha)/i;

const RULES: { key: string; test: RegExp; strong?: RegExp }[] = [
  { key: 'firstName', test: /(first|given|fore).?name/i },
  { key: 'lastName', test: /(last|family|sur).?name/i },
  { key: 'fullName', test: /^(full.?name|your name|name|applicant name|candidate name)\*?$/i, strong: /\bfull.?name\b/i },
  { key: 'email', test: /e-?mail/i },
  { key: 'phone', test: /(phone|mobile|telephone|\btel\b|cell)/i },
  { key: 'postalCode', test: /(post(al)?.?code|zip)/i },
  { key: 'city', test: /\b(city|town)\b/i },
  { key: 'country', test: /\bcountry\b/i },
  { key: 'address', test: /(street|address)/i },
  { key: 'linkedin', test: /linked.?in/i },
  { key: 'github', test: /git.?hub/i },
  { key: 'website', test: /(website|portfolio|personal (site|url)|homepage)/i },
  { key: 'currentCompany', test: /(current|present) (company|employer)/i },
  { key: 'currentTitle', test: /(current|present) (job )?(title|position|role)/i },
  { key: 'yearsExperience', test: /years? of (work )?experience/i },
  { key: 'headline', test: /headline/i },
  { key: 'coverLetter', test: /(cover.?letter|motivation)/i },
  { key: 'summary', test: /(summary|about you|about yourself|bio\b)/i },
];

const text = (f: FormField) => [f.label, f.name, f.id].filter(Boolean).join(' ');

export function isHumanOnly(f: FormField): boolean {
  return f.type === 'password' || HUMAN_ONLY.test(text(f));
}

/** Map form fields to profile keys using label/name/id only. Never maps human-only fields. */
export function mapFields(fields: FormField[], profile: ProfileData): { mappings: Mapping[]; humanOnly: FormField[]; unmapped: FormField[] } {
  const mappings: Mapping[] = [];
  const humanOnly: FormField[] = [];
  const unmapped: FormField[] = [];
  for (const f of fields) {
    if (f.visible === false || f.disabled || ['hidden', 'submit', 'button', 'reset', 'image'].includes(f.type ?? '')) continue;
    if (f.type === 'file') continue; // handled separately via cvPath
    if (isHumanOnly(f)) { humanOnly.push(f); continue; }
    const hay = text(f);
    const exact = Object.keys(profile).find((k) => k.toLowerCase() === (f.label ?? '').toLowerCase().replace(/[^a-z0-9]/g, ''));
    let key: string | undefined;
    let reason = '';
    let confidence: 'high' | 'medium' = 'medium';
    if (f.type === 'email') { key = 'email'; reason = 'input type=email'; confidence = 'high'; }
    else if (f.type === 'tel') { key = 'phone'; reason = 'input type=tel'; confidence = 'high'; }
    else {
      for (const r of RULES) {
        if (r.test.test((f.label ?? '').trim()) || r.test.test(f.name ?? '') || r.test.test(f.id ?? '')) {
          key = r.key; reason = `matches ${r.key} in label/name/id`; confidence = (f.label && r.test.test(f.label)) ? 'high' : 'medium';
          break;
        }
      }
    }
    // "Name" alone on a form that also has first/last would be ambiguous; fullName only when no first/last were mapped later.
    if (!key && exact) { key = exact; reason = 'label equals a profile key'; confidence = 'high'; }
    void hay;
    if (key && profile[key] !== undefined && profile[key] !== '') mappings.push({ field: f, key, confidence, reason });
    else unmapped.push(f);
  }
  // Prefer first/last over fullName when the form asks for both.
  const hasSplit = mappings.some((m) => m.key === 'firstName') && mappings.some((m) => m.key === 'lastName');
  const final = hasSplit ? mappings.filter((m) => m.key !== 'fullName') : mappings;
  return { mappings: final, humanOnly, unmapped: [...unmapped, ...mappings.filter((m) => !final.includes(m)).map((m) => m.field)] };
}

/** Select options: choose by exact label/value match only; never guess. */
export function resolveOption(field: FormField, wanted: string): string | undefined {
  const w = wanted.trim().toLowerCase();
  const o = field.options?.find((x) => x.value.toLowerCase() === w || x.label.trim().toLowerCase() === w);
  return o?.label || o?.value;
}

export function renderTemplate(template: string, vars: Record<string, string | undefined>): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const text = template.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (m, k: string) => {
    const v = vars[k];
    if (v === undefined || v === '') { missing.add(k); return m; }
    return v;
  });
  return { text, missing: [...missing] };
}
