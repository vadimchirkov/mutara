// Positive control: BM25 (k1 1.2, b 0.75), title counted twice.
export function createIndex(docs) {
  const tokens = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const tf = docs.map((d) => { const m = new Map(); for (const w of tokens(`${d.title} ${d.title} ${d.text}`)) m.set(w, (m.get(w) ?? 0) + 1); return m; });
  const len = tf.map((m) => [...m.values()].reduce((a, b) => a + b, 0)), avg = len.reduce((a, b) => a + b, 0) / len.length;
  const df = new Map(); for (const m of tf) for (const w of m.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  const idf = (w) => Math.log(1 + (docs.length - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5));
  return { search(query, k) {
    const q = [...new Set(tokens(query))];
    return tf.map((m, i) => ({ id: docs[i].id, s: q.reduce((a, w) => { const f = m.get(w) ?? 0; return a + (f ? idf(w) * f * 2.2 / (f + 1.2 * (0.25 + 0.75 * len[i] / avg)) : 0); }, 0) }))
      .sort((a, b) => b.s - a.s).slice(0, k).map((d) => d.id);
  } };
}
