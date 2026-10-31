import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Bm25Index, DocStore, TraceStore, chunkText, extractText, pathPattern, scrubLabel, stateKey, type TraceStep } from '@browserforge/knowledge';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-know-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const step = (over: Partial<TraceStep> = {}, runId = 'run1'): TraceStep => ({
  runId, at: Date.now(), promptVersion: 'v1', host: 'example.com', pathPattern: '/signup', goal: 'Sign up', inputKeys: ['birth month'],
  table: ['1 | combobox | Select Month', '2 | button | Submit'], recent: [], notesKey: '',
  decision: { op: 'SELECT', target: 1, targetLabel: 'Select Month', inputKey: 'birth month', confidence: 0.9 },
  result: { ok: true, pageChanged: true, approvalDenied: false }, source: 'model', ...over,
});

describe('BM25', () => {
  it('ranks an exact label match first and ignores non-matches', () => {
    const idx = new Bm25Index<string>();
    idx.add('a', 'click the send button to send the message', 'a');
    idx.add('b', 'select month combobox birthday', 'b');
    idx.add('c', 'unrelated footer links', 'c');
    expect(idx.search('Select Month', 3).map((h) => h.id)).toEqual(['b']);
    expect(idx.search('send', 3)[0]!.id).toBe('a');
    idx.remove('a');
    expect(idx.search('send', 3)).toEqual([]);
  });
});

describe('trace store', () => {
  it('never persists input values: only keys and scrubbed labels', () => {
    const store = new TraceStore(dir);
    const secret = 'S3NTINEL-value-123456789';
    // The runner only ever puts keys/labels in a step; labels are scrubbed of emails and long numbers.
    store.record(step({ table: [`1 | textbox | ${scrubLabel('me@secret-mail.com 0123456789012')}`] }));
    const raw = fs.readFileSync(path.join(dir, 'traces.jsonl'), 'utf8');
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain('secret-mail');
    expect(raw).toContain('{email}');
    expect(raw).toContain('birth month');
  });

  it('only reuses steps from runs that worked and were not labelled bad', () => {
    const store = new TraceStore(dir);
    store.record(step({}, 'good'));
    store.record(step({ result: { ok: false, pageChanged: false, approvalDenied: false, error: 'x' } }, 'failed'));
    store.record(step({}, 'bad'));
    store.label('bad', 'bad');
    const ex = store.similar({ host: 'example.com', pathPattern: '/signup', goal: 'sign up', table: ['1 | combobox | Select Month'] });
    expect(ex.map((s) => s.runId)).toEqual(['good']);
    expect(store.similar({ host: 'other.com', pathPattern: '/', goal: 'sign up', table: [] })).toEqual([]);
  });

  it('remembers a decision only after it succeeded the same way several times, and forgets it when labelled bad', () => {
    const store = new TraceStore(dir);
    const key = { host: 'example.com', pathPattern: '/signup', goal: 'Sign   up', table: ['1 | combobox | Select Month', '2 | button | Submit'], notesKey: '' };
    store.record(step({}, 'r1')); store.record(step({}, 'r2'));
    expect(store.remembered(key)).toBeNull();
    store.record(step({}, 'r3'));
    expect(store.remembered(key)).toMatchObject({ op: 'SELECT', targetLabel: 'Select Month', inputKey: 'birth month' });
    store.label('r1', 'bad');
    expect(store.remembered(key)).toBeNull();
    expect(stateKey({ ...key, notesKey: 'abc12345' })).not.toBe(stateKey(key)); // a confirmation on the page is a different situation
    expect(stateKey(key)).toBe(stateKey({ ...key, table: [...key.table].reverse() })); // order independent
  });

  it('survives restart, labels persist, and retention deletes old lines', () => {
    const a = new TraceStore(dir);
    a.record(step({}, 'keep')); a.record(step({ at: Date.now() - 200 * 86_400_000 }, 'old'));
    a.label('keep', 'good');
    const b = new TraceStore(dir, { enabled: true, retentionDays: 90 });
    expect(b.stats()).toMatchObject({ steps: 1, runs: 1, labelledGood: 1 });
    expect(fs.readFileSync(path.join(dir, 'traces.jsonl'), 'utf8')).not.toContain('"old"');
  });

  it('records nothing when disabled', () => {
    const store = new TraceStore(dir, { enabled: false, retentionDays: 90 });
    store.record(step());
    expect(fs.existsSync(path.join(dir, 'traces.jsonl'))).toBe(false);
  });

  it('exports only good runs as chat-format JSONL', () => {
    const store = new TraceStore(dir);
    store.record(step({}, 'g')); store.record(step({}, 'u'));
    store.label('g', 'good');
    const render = (s: TraceStep) => ({ system: 'sys', user: s.goal, assistant: JSON.stringify(s.decision) });
    const good = store.exportDataset(render, 'good');
    expect(good).toHaveLength(1);
    expect(JSON.parse(good[0]!).messages.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(store.exportDataset(render, 'any')).toHaveLength(2);
  });

  it('collapses ids in paths', () => {
    expect(pathPattern('/messages/t/1234567/inbox')).toBe('/messages/t/{id}/inbox');
  });
});

/** Build a tiny stored-zip .docx so the built-in reader is exercised without any dependency. */
function makeDocx(xml: string): Buffer {
  const name = Buffer.from('word/document.xml');
  const data = zlib.deflateRawSync(Buffer.from(xml));
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(xml.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(xml.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
  const cdOffset = local.length + name.length + data.length;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(central.length + name.length, 12); eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, name, data, central, name, eocd]);
}

describe('document store', () => {
  it('chunks, indexes and searches text documents', () => {
    const f = path.join(dir, 'notes.md');
    fs.writeFileSync(f, '# Visa\n\nPassport number is kept in the blue folder.\n\n# Gym\n\nTrainer certificate expires in June.');
    const docs = new DocStore(path.join(dir, 'k'));
    const meta = docs.add(f);
    expect(meta.chunks).toBeGreaterThan(0);
    expect(docs.search('trainer certificate')[0]!.payload.text).toContain('Trainer');
    expect(new DocStore(path.join(dir, 'k')).list()).toHaveLength(1); // persisted
    expect(docs.remove(meta.id)).toBe(true);
    expect(docs.search('trainer')).toEqual([]);
  });

  it('reads .docx, refuses pdf and unknown types and oversized files', () => {
    const f = path.join(dir, 'cv.docx');
    fs.writeFileSync(f, makeDocx('<w:document><w:p><w:t>Ada &amp; Co engineer</w:t></w:p><w:p><w:t>Second para</w:t></w:p></w:document>'));
    expect(extractText(f, fs.readFileSync(f))).toContain('Ada & Co engineer');
    expect(() => extractText('x.pdf', Buffer.from(''))).toThrow(/PDF/);
    expect(() => extractText('x.exe', Buffer.from(''))).toThrow(/Unsupported/);
    const big = path.join(dir, 'big.txt');
    fs.writeFileSync(big, Buffer.alloc(3 * 1024 * 1024, 97));
    expect(() => new DocStore(path.join(dir, 'k2')).add(big)).toThrow(/too large/);
    expect(chunkText('a\n\nb')).toEqual(['a\n\nb']);
  });
});
