/** Small in-process BM25 keyword index. Exact labels ("Select Month", "Send") matter more than semantics here, so no embeddings. */
export interface Hit<T> {
  id: string;
  score: number;
  payload: T;
}

/** Anything that can answer "which stored items look like this query?". An embedding retriever can implement this later. */
export interface Retriever<T> {
  add(id: string, text: string, payload: T): void;
  remove(id: string): void;
  search(query: string, k: number, filter?: (payload: T) => boolean): Hit<T>[];
  readonly size: number;
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).slice(0, 2000);
}

interface Entry<T> {
  tf: Map<string, number>;
  len: number;
  payload: T;
}

export class Bm25Index<T> implements Retriever<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly df = new Map<string, number>();
  private totalLen = 0;
  constructor(private readonly k1 = 1.2, private readonly b = 0.75) {}

  get size(): number {
    return this.entries.size;
  }

  add(id: string, text: string, payload: T): void {
    this.remove(id);
    const tokens = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.entries.set(id, { tf, len: tokens.length, payload });
    this.totalLen += tokens.length;
  }

  remove(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    for (const t of e.tf.keys()) {
      const n = (this.df.get(t) ?? 1) - 1;
      if (n <= 0) this.df.delete(t);
      else this.df.set(t, n);
    }
    this.totalLen -= e.len;
    this.entries.delete(id);
  }

  search(query: string, k: number, filter?: (payload: T) => boolean): Hit<T>[] {
    const q = [...new Set(tokenize(query))];
    const n = this.entries.size;
    if (!q.length || !n) return [];
    const avg = this.totalLen / n || 1;
    const hits: Hit<T>[] = [];
    for (const [id, e] of this.entries) {
      if (filter && !filter(e.payload)) continue;
      let score = 0;
      for (const t of q) {
        const f = e.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * e.len) / avg));
      }
      if (score > 0) hits.push({ id, score, payload: e.payload });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, k);
  }
}
