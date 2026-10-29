import { describe, expect, it } from 'vitest';
import { ACTIONS, ExtensionMessageSchema, HelloSchema, PROTOCOL_VERSION, RequestSchema, ResponseSchema, isNavigableUrl, okResponse, errorResponse } from '@browserforge/browser-protocol';

describe('envelopes', () => {
  it('accepts a valid request and applies defaults', () => {
    const r = RequestSchema.parse({ v: 1, type: 'request', id: 'a1', action: 'tabs_list' });
    expect(r.args).toEqual({});
  });
  it('rejects wrong version, missing id, oversized action', () => {
    expect(RequestSchema.safeParse({ v: 2, type: 'request', id: 'a', action: 'x' }).success).toBe(false);
    expect(RequestSchema.safeParse({ v: 1, type: 'request', action: 'x' }).success).toBe(false);
    expect(RequestSchema.safeParse({ v: 1, type: 'request', id: 'a', action: 'x'.repeat(100) }).success).toBe(false);
  });
  it('round-trips ok and error responses', () => {
    expect(ResponseSchema.parse(okResponse('1', { a: 1 })).ok).toBe(true);
    const e = ResponseSchema.parse(errorResponse('1', { code: 'TIMEOUT', message: 'slow' }));
    expect(e.ok).toBe(false);
  });
  it('requires a token-bearing hello', () => {
    const base = { v: PROTOCOL_VERSION, type: 'hello', browser: { kind: 'firefox', version: '158', id: 'profile-123456' }, extension: { id: 'x', version: '1' },
      capabilities: { networkCapture: true, responseBodies: false, webSocketFrames: false, screenshots: true, fullPageScreenshots: false, downloads: true } };
    expect(HelloSchema.safeParse({ ...base, token: 'short' }).success).toBe(false);
    expect(HelloSchema.safeParse({ ...base, token: 'a'.repeat(32) }).success).toBe(true);
  });
  it('rejects unknown extension message shapes', () => {
    expect(ExtensionMessageSchema.safeParse({ v: 1, type: 'event', event: 'evil', data: {} }).success).toBe(false);
  });
});

describe('action args', () => {
  it('click requires ref or selector', () => {
    expect(ACTIONS.click.args.safeParse({}).success).toBe(false);
    expect(ACTIONS.click.args.safeParse({ ref: 'abc:1' }).success).toBe(true);
  });
  it('navigate requires url or history; agents cannot inject an approved flag', () => {
    expect(ACTIONS.navigate.args.safeParse({}).success).toBe(false);
    const parsed = ACTIONS.click.args.parse({ ref: 'a:1', approved: true }) as Record<string, unknown>;
    expect('approved' in parsed).toBe(false);
  });
  it('type can target the focused element, other actions still need a target', () => {
    expect(ACTIONS.type.args.safeParse({ text: 'hi' }).success).toBe(true);
    expect(ACTIONS.type.args.safeParse({ ref: 'a:1', text: 'hi', submit: true }).success).toBe(true);
    expect(ACTIONS.type.args.safeParse({}).success).toBe(false); // text is mandatory
    expect(ACTIONS.fill_field.args.safeParse({ value: 'x' }).success).toBe(false);
    expect(ACTIONS.click.args.safeParse({}).success).toBe(false);
  });
  it('only http(s) urls are navigable', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'about:config', 'data:text/html,x', 'moz-extension://x/y', 'chrome://settings', 'view-source:https://a.b'])
      expect(isNavigableUrl(bad)).toBe(false);
    expect(isNavigableUrl('https://example.com/a')).toBe(true);
    expect(isNavigableUrl('http://127.0.0.1:3000')).toBe(true);
  });
});
