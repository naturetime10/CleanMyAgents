// Tiny local vector index for rubbish tool calls.
// ponytail: hashed char-trigram embeddings + cosine over a JSON file. Swap
// embed() for a real embedding model when recall matters; the linear scan is
// fine below a few thousand entries.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const DIM = 256;

/** L2-normalised bag of hashed character trigrams. */
export function embed(text) {
  const v = new Array(DIM).fill(0);
  const s = ` ${String(text).toLowerCase().replace(/\s+/g, " ")} `;
  for (let i = 0; i <= s.length - 3; i++) {
    let h = 2166136261; // FNV-1a
    for (let j = i; j < i + 3; j++) { h ^= s.charCodeAt(j); h = Math.imul(h, 16777619); }
    v[(h >>> 0) % DIM] += 1;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

export const cosine = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);

/** Anything this similar to a marked call gets challenged instead of allowed. */
export const THRESHOLD = 0.85;

export function createRubbishStore(file) {
  const entries = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  return {
    size: () => entries.length,
    texts: () => entries.map((e) => e.text),
    add(text) {
      // exact repeats add nothing but file weight — rule denials fire often
      if (entries.some((e) => e.text === text)) return entries.length;
      entries.push({ text, vec: embed(text), addedAt: new Date().toISOString() });
      writeFileSync(file, JSON.stringify(entries));
      return entries.length;
    },
    /** Best match at or above THRESHOLD, or null. */
    match(text) {
      const q = embed(text);
      let best = null;
      for (const e of entries) {
        const sim = cosine(q, e.vec);
        if (sim >= THRESHOLD && (!best || sim > best.sim)) best = { sim, text: e.text };
      }
      return best;
    },
  };
}
