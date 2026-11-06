import type { Hunk } from "./diff.js";
import type { PastComment } from "./types.js";

/**
 * Finds past comments whose code context looks like the new change.
 * TF-IDF over code-aware tokens (splits camelCase / snake_case) with cosine similarity:
 * no external service, deterministic, and fast for thousands of comments.
 * The `Retriever` interface lets you swap in embeddings + a vector DB later.
 */
export interface Retriever {
  topK(hunk: Hunk, k: number): { comment: PastComment; score: number }[];
}

const STOP = new Set(
  "the a an and or to of in is it this that for on be with as are was if not we you i can should would could use".split(" "),
);

export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-./]/g, " ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

type Vec = Map<string, number>;

function tf(tokens: string[]): Vec {
  const v: Vec = new Map();
  for (const t of tokens) v.set(t, (v.get(t) ?? 0) + 1);
  return v;
}

function cosine(a: Vec, b: Vec): number {
  let dot = 0, na = 0, nb = 0;
  for (const [, x] of a) na += x * x;
  for (const [, y] of b) nb += y * y;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const [t, x] of small) {
    const y = big.get(t);
    if (y) dot += x * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export class TfIdfRetriever implements Retriever {
  private idf = new Map<string, number>();
  private docs: { comment: PastComment; vec: Vec }[] = [];

  constructor(comments: PastComment[]) {
    // Code context matters most; the comment text adds what the reviewer cared about.
    const tokenized = comments.map((c) => [...tokenize(c.diffHunk), ...tokenize(c.body)]);
    const df = new Map<string, number>();
    for (const toks of tokenized) for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
    const n = comments.length || 1;
    for (const [t, d] of df) this.idf.set(t, Math.log(1 + n / d));
    this.docs = comments.map((comment, i) => ({ comment, vec: this.weight(tf(tokenized[i])) }));
  }

  private weight(v: Vec): Vec {
    const out: Vec = new Map();
    for (const [t, x] of v) out.set(t, x * (this.idf.get(t) ?? Math.log(1 + this.docs.length)));
    return out;
  }

  topK(hunk: Hunk, k: number) {
    const q = this.weight(tf(tokenize(hunk.text)));
    return this.docs
      .map((d) => ({ comment: d.comment, score: cosine(q, d.vec) }))
      .filter((x) => x.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}
