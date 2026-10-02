// Retrieval over scientific abstracts. createIndex(docs) gets every document once as
// { id, title, text } and returns a searcher; search(query, k) returns up to k document ids,
// best first. The baseline counts how many distinct query words appear in each document.
export function createIndex(docs) {
  const tokens = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const indexed = docs.map((d) => ({ id: d.id, words: new Set(tokens(`${d.title} ${d.text}`)) }));
  return {
    search(query, k) {
      const q = [...new Set(tokens(query))];
      return indexed
        .map((d) => ({ id: d.id, score: q.filter((w) => d.words.has(w)).length }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map((d) => d.id);
    },
  };
}
