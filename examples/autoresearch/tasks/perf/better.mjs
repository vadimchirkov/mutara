// Positive control: Map counts instead of an object, same sort. Same output, a little faster.
export function topWords(text, k) {
  const counts = new Map();
  for (const w of text.toLowerCase().split(/[^a-z']+/)) if (w) counts.set(w, (counts.get(w) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, k).map(([word, count]) => ({ word, count }));
}
