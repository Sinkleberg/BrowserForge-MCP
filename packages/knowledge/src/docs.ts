import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import zlib from 'node:zlib';
import { Bm25Index, type Hit } from './bm25.js';

export interface DocMeta {
  id: string;
  name: string;
  addedAt: number;
  chars: number;
  chunks: number;
}
interface StoredDoc extends DocMeta {
  chunkText: string[];
}
export interface ChunkRef {
  docId: string;
  name: string;
  n: number;
  text: string;
}

export const MAX_DOC_BYTES = 2 * 1024 * 1024;
export const MAX_DOCS = 200;
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.csv', '.json', '.html', '.htm', '.log']);

/** ~500-token chunks (about 2000 chars), split on blank lines first so sections stay together. */
export function chunkText(text: string, target = 2000): string[] {
  const out: string[] = [];
  let cur = '';
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (cur && cur.length + p.length > target) {
      out.push(cur);
      cur = '';
    }
    if (p.length > target) {
      for (let i = 0; i < p.length; i += target) out.push(p.slice(i, i + target));
    } else cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out;
}

/** Minimal zip reader (stored + deflate) so .docx works without a dependency. Only reads the one entry asked for. */
function readZipEntry(buf: Buffer, wanted: string): Buffer | null {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    if (buf.toString('utf8', p + 46, p + 46 + nlen) === wanted) {
      const dataStart = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
      const raw = buf.subarray(dataStart, dataStart + csize);
      if (method === 0) return raw;
      if (method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: 20 * 1024 * 1024 });
      return null;
    }
    p += 46 + nlen + elen + clen;
  }
  return null;
}

const decodeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function extractText(file: string, data: Buffer): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.docx') {
    const xml = readZipEntry(data, 'word/document.xml');
    if (!xml) throw new Error('Could not read this .docx (no word/document.xml)');
    return decodeXml(xml.toString('utf8').replace(/<\/w:p>/g, '\n\n').replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<[^>]+>/g, ''));
  }
  if (ext === '.pdf') throw new Error('PDF text extraction is not supported without a PDF parser; export it as .txt or .docx first');
  if (!TEXT_EXT.has(ext)) throw new Error(`Unsupported file type '${ext || '(none)'}'. Supported: ${[...TEXT_EXT, '.docx'].join(' ')}`);
  const text = data.toString('utf8');
  return ext === '.html' || ext === '.htm' ? decodeXml(text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')) : text;
}

export class DocStore {
  private readonly file: string;
  private docs: StoredDoc[] = [];
  private readonly index = new Bm25Index<ChunkRef>();

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, 'documents.json');
    try {
      this.docs = (JSON.parse(fs.readFileSync(this.file, 'utf8')) as { docs: StoredDoc[] }).docs;
    } catch {
      this.docs = [];
    }
    for (const d of this.docs) this.indexDoc(d);
  }

  private indexDoc(d: StoredDoc): void {
    d.chunkText.forEach((text, n) => this.index.add(`${d.id}:${n}`, text, { docId: d.id, name: d.name, n, text }));
  }
  private persist(): void {
    fs.writeFileSync(this.file, JSON.stringify({ docs: this.docs }), { mode: 0o600 });
  }

  /** `absPath` must already have passed the caller's path-safety check. */
  add(absPath: string): DocMeta {
    if (this.docs.length >= MAX_DOCS) throw new Error(`Document limit reached (${MAX_DOCS})`);
    const st = fs.statSync(absPath);
    if (!st.isFile()) throw new Error('Not a regular file');
    if (st.size > MAX_DOC_BYTES) throw new Error(`File too large (max ${MAX_DOC_BYTES / 1024 / 1024} MB)`);
    const text = extractText(absPath, fs.readFileSync(absPath));
    const chunkTextArr = chunkText(text);
    if (!chunkTextArr.length) throw new Error('No text found in the file');
    const name = path.basename(absPath);
    this.docs.filter((d) => d.name === name).forEach((d) => this.remove(d.id)); // re-adding replaces
    const doc: StoredDoc = { id: randomUUID().slice(0, 8), name, addedAt: Date.now(), chars: text.length, chunks: chunkTextArr.length, chunkText: chunkTextArr };
    this.docs.push(doc);
    this.indexDoc(doc);
    this.persist();
    return this.meta(doc);
  }

  remove(id: string): boolean {
    const d = this.docs.find((x) => x.id === id);
    if (!d) return false;
    d.chunkText.forEach((_, n) => this.index.remove(`${d.id}:${n}`));
    this.docs = this.docs.filter((x) => x.id !== id);
    this.persist();
    return true;
  }

  list(): DocMeta[] {
    return this.docs.map((d) => this.meta(d));
  }
  search(query: string, k = 3): Hit<ChunkRef>[] {
    return this.index.search(query, k);
  }
  private meta(d: StoredDoc): DocMeta {
    return { id: d.id, name: d.name, addedAt: d.addedAt, chars: d.chars, chunks: d.chunks };
  }
}
