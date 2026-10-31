import { describe, expect, it } from 'vitest';
import { FlowBuilder, consolidate, locatorKey, stepKey, type Flow } from '@browserforge/flows';

const URL_ = 'https://shop.test/signup';
function flow(id: string, build: (b: FlowBuilder) => void, extra: Partial<Flow> = {}): Flow {
  const b = new FlowBuilder({ id, site: 'shop.test', now: new Date('2026-10-30T10:00:00Z') });
  b.navigate(URL_);
  build(b);
  return { ...b.flow, ...extra };
}
const email = (b: FlowBuilder, loc = {}) => b.add({ action: 'fill', locator: { label: 'Email', id: 'email', ...loc }, fieldLabel: 'Email', value: 'ada@example.com', url: URL_ });
const name = (b: FlowBuilder) => b.add({ action: 'fill', locator: { label: 'First name', id: 'fname' }, fieldLabel: 'First name', value: 'Ada', url: URL_ });
const submit = (b: FlowBuilder) => b.add({ action: 'click', locator: { role: 'button', name: 'Sign up' }, consequential: true, url: URL_ });

describe('consolidate', () => {
  it('drops one-off detours, keeps the submit, and borrows locators from other recordings', () => {
    const popup = (b: FlowBuilder) => b.add({ action: 'click', locator: { text: 'No thanks', css: '.promo .close' }, url: URL_ });
    const a = flow('shop.test/20261030T100001', (b) => { popup(b); email(b); name(b); submit(b); });
    const b2 = flow('shop.test/20261030T100002', (b) => { email(b, { testId: 'signup-email' }); name(b); submit(b); });
    const c = flow('shop.test/20261030T100003', (b) => { email(b); name(b); submit(b); });
    const r = consolidate([a, b2, c], { id: 'shop.test/20261030T110000', name: 'Sign up' });
    expect(r.flow.steps.map((s) => s.label)).toEqual(['open ' + URL_, 'fill "Email"', 'fill "First name"', 'click "Sign up"']);
    expect(r.dropped).toBe(1);
    expect(r.flow.saved).toBe(true);
    expect(r.flow.derivedFrom).toEqual([a.id, b2.id, c.id]);
    // The email step took the test id that only one recording found, and kept its own fields.
    expect(r.flow.steps[1]!.locator).toMatchObject({ label: 'Email', id: 'email', testId: 'signup-email' });
    expect(r.flow.steps.at(-1)!.consequential).toBe(true);
  });

  it('ignores failed recordings, and prefers a successful one as the backbone', () => {
    const bad = flow('shop.test/20261030T100001', (b) => { email(b); name(b); b.add({ action: 'click', locator: { text: 'Wrong turn' }, url: URL_ }); submit(b); }, { outcome: 'failure' });
    const good1 = flow('shop.test/20261030T100002', (b) => { email(b); submit(b); }, { outcome: 'success' });
    const good2 = flow('shop.test/20261030T100003', (b) => { email(b); submit(b); });
    const r = consolidate([bad, good1, good2], { id: 'shop.test/x', name: 'n' });
    expect(r.flow.derivedFrom).toEqual([good1.id, good2.id]);
    expect(r.flow.outcome).toBe('success');
    expect(r.flow.steps.some((s) => s.label?.includes('Wrong turn'))).toBe(false);
  });

  it('collapses a step repeated in a row (the last typed value stands) and keeps only parameters still in use', () => {
    const a = flow('shop.test/20261030T100001', (b) => { email(b); email(b); name(b); submit(b); });
    const c = flow('shop.test/20261030T100002', (b) => { email(b); name(b); submit(b); });
    const r = consolidate([a, c], { id: 'shop.test/x', name: 'n' });
    expect(r.flow.steps.filter((s) => s.action === 'fill')).toHaveLength(2);
    const used = new Set(r.flow.steps.map((s) => s.param).filter(Boolean));
    expect(r.flow.params.every((p) => used.has(p.name))).toBe(true);
  });

  it('keeps a parameter sensitive if any recording saw it as sensitive, and never gives it a default', () => {
    const pw = (b: FlowBuilder, sensitive: boolean) => b.add({ action: 'fill', locator: { label: 'Password' }, fieldLabel: 'Password', sensitive, value: 'hunter2', url: URL_ });
    const a = flow('shop.test/20261030T100001', (b) => { pw(b, true); submit(b); });
    const c = flow('shop.test/20261030T100002', (b) => { pw(b, false); submit(b); });
    const r = consolidate([c, a], { id: 'shop.test/x', name: 'n' });
    const p = r.flow.params.find((x) => x.name === 'password')!;
    expect(p.sensitive).toBe(true);
    expect(p.default).toBeUndefined();
    expect(JSON.stringify(r.flow)).not.toContain('hunter2');
  });

  it('refuses nothing, mixed sites, and says why', () => {
    expect(() => consolidate([], { id: 'a/b', name: 'n' })).toThrow(/Nothing/);
    const other = { ...flow('shop.test/20261030T100001', () => undefined), site: 'other.test' };
    expect(() => consolidate([flow('shop.test/20261030T100002', () => undefined), other], { id: 'a/b', name: 'n' })).toThrow(/same site/);
  });

  it('keys steps by their strongest locator', () => {
    expect(locatorKey({ testId: 't', label: 'l' })).toBe('testId:t');
    expect(locatorKey({ role: 'button', name: 'Go', label: 'l' })).toBe('role:button:Go');
    expect(locatorKey(undefined)).toBe('page');
    expect(stepKey({ action: 'navigate', url: 'https://x.test/jobs/12345/apply?x=1', ts: 0 })).toBe(stepKey({ action: 'navigate', url: 'https://x.test/jobs/98765/apply', ts: 1 }));
  });
});
