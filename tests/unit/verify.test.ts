import { describe, expect, it } from 'vitest';
import { pageFromElements, verifyOutcome, type VerifyPage } from '../../apps/mcp-server/src/verify.js';

const page = (over: Partial<VerifyPage> = {}): VerifyPage => ({ url: 'https://jobs.example.com/apply', title: 'Apply', notes: [], rows: [], ...over });
const form = (): VerifyPage['rows'] => [
  { kind: 'input:text', label: 'First name', editable: true },
  { kind: 'input:email', label: 'Email', editable: true },
  { kind: 'button', label: 'Submit' },
];

describe('verifyOutcome', () => {
  it.each([
    ['English', 'Thank you, your application has been received'],
    ['Italian', 'Ti ringraziamo! I tuoi dati sono stati acquisiti correttamente'],
    ['French', 'Merci, votre candidature a bien été reçue'],
    ['Spanish', 'Gracias, tu solicitud ha sido recibida'],
    ['signup page', 'Thanks, your account was created.'],
    ['German', 'Vielen Dank, Ihre Bewerbung ist eingegangen. Bewerbung eingegangen'],
  ])('sees a %s confirmation as success', (_lang, note) => {
    expect(verifyOutcome(page({ notes: [note] })).verdict).toBe('success');
  });

  it.each([
    'This field is required',
    'Campo obbligatorio',
    'Champ requis',
    'Please enter a valid email',
  ])('sees "%s" as failure', (note) => {
    expect(verifyOutcome(page({ notes: [note], rows: form() })).verdict).toBe('failure');
  });

  it('lets an error win over confirmation-like words', () => {
    expect(verifyOutcome(page({ notes: ['Thank you for applying', 'This field is required'] })).verdict).toBe('failure');
  });

  it('counts a move to a confirmation address as success', () => {
    const before = page({ rows: form() });
    const after = page({ url: 'https://jobs.example.com/apply/thank-you', rows: [{ kind: 'a', label: 'Back to jobs' }] });
    const v = verifyOutcome(after, before);
    expect(v.verdict).toBe('success');
    expect(v.signals.join()).toMatch(/confirmation page/);
  });

  it('counts a vanished form plus a new address as success', () => {
    const v = verifyOutcome(page({ url: 'https://jobs.example.com/done-xyz-1', rows: [] }), page({ rows: form() }));
    expect(v.verdict).toBe('success');
  });

  it('calls a submit that changed nothing a failure, but only when it can compare', () => {
    expect(verifyOutcome(page({ rows: form() }), page({ rows: form() })).verdict).toBe('failure');
    expect(verifyOutcome(page({ rows: form() })).verdict).toBe('unknown');
  });

  it('does not call a normal page a success', () => {
    expect(verifyOutcome(page({ notes: ['Open positions', 'Engineering'], rows: [{ kind: 'a', label: 'Junior AI Engineer' }] })).verdict).toBe('unknown');
  });
});

describe('pageFromElements', () => {
  it('reads the extension table format', () => {
    const p = pageFromElements({
      url: 'https://x.test/a', title: 'T', notes: ['Thanks'],
      rows: ['1 | input:text (editable) [empty] | First name | 1:3', '2 | button | Submit | 1:9'],
    });
    expect(p.rows).toEqual([
      { kind: 'input:text', label: 'First name', state: 'empty', editable: true },
      { kind: 'button', label: 'Submit', state: undefined, editable: false },
    ]);
    expect(p.notes).toEqual(['Thanks']);
  });
});
