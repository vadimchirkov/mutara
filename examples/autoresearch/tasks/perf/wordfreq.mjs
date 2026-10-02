// The k most frequent words of a text, as [{ word, count }]. Words are runs of a-z and
// apostrophes after lower-casing. Ties: the word that sorts first by plain string order.
export function topWords(text, k) {
  const words = text.toLowerCase().split(/[^a-z']+/).filter((w) => w.length > 0);
  const counts = {};
  for (const w of words) counts[w] = (counts[w] || 0) + 1;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, k)
    .map(([word, count]) => ({ word, count }));
}
