// Frozen harness for the perf task. The agent never sees or edits this file.
//   node bench.mjs validate FILE            -> {"score": -ms} on the fixed validation text, after the guard
//   node bench.mjs audit START CHAMPION ID  -> {id: {baseline, candidate}}: each side's share of the pair's time
import { topWords as reference } from "./wordfreq.mjs";

const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
// Zipf-distributed synthetic words, random capitals and punctuation.
function text(seed, words = 100_000) {
  const r = rng(seed);
  const vocab = Array.from({ length: 5000 }, () => Array.from({ length: 2 + Math.floor(r() * 8) }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(r() * 26)]).join(""));
  const cdf = []; let total = 0;
  for (let i = 0; i < vocab.length; i++) cdf.push((total += 1 / (i + 1)));
  const pick = () => { const u = r() * total; let lo = 0, hi = cdf.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < u) lo = m + 1; else hi = m; } return vocab[lo]; };
  const out = [];
  for (let i = 0; i < words; i++) {
    let w = pick();
    if (r() < 0.1) w = w[0].toUpperCase() + w.slice(1);
    if (r() < 0.02) w = "o'" + w;
    out.push(w, r() < 0.1 ? ". " : r() < 0.1 ? ",\n" : " ");
  }
  return out.join("");
}
const K = 20;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function guard(fn) {
  const inputs = [["", 3], ["a", 3], ["B b a A, c!", 2], ["x y z", 10], ["don't Don't dont", 5], [text(7, 2000), 50], [text(8, 20_000), K]];
  for (const [t, k] of inputs) if (!same(fn(t, k), reference(t, k))) throw new Error(`wrong output for k=${k}, text length ${t.length}`);
}
const ms = (fn, t) => { const s = process.hrtime.bigint(); fn(t, K); return Number(process.hrtime.bigint() - s) / 1e6; };
const median = (xs) => xs.sort((a, b) => a - b)[xs.length >> 1];

const [mode, ...rest] = process.argv.slice(2);
if (mode === "validate") {
  const { topWords } = await import(rest[0]);
  guard(topWords);
  const t = text(1);
  for (let i = 0; i < 3; i++) topWords(t, K);
  console.log(JSON.stringify({ score: -median(Array.from({ length: 5 }, () => ms(topWords, t))) }));
} else if (mode === "audit") {
  // One process per case (task.mjs): JIT and CPU state are shared within a process, so cases
  // timed in one process are not independent. Import order alternates with the case id.
  const [startFile, championFile, id] = rest, odd = Number(id) % 2;
  const fns = {};
  for (const f of odd ? [startFile, championFile] : [championFile, startFile]) fns[f] = (await import(f)).topWords;
  const [startFn, champion] = [fns[startFile], fns[championFile]];
  const t = text(Number(id));
  let share;
  if (!same(champion(t, K), reference(t, K))) share = 0; // wrong output loses the case
  else {
    for (let i = 0; i < 2; i++) { startFn(t, K); champion(t, K); }
    const a = [], b = [];
    for (let i = 0; i < 6; i++) {
      if ((i + odd) % 2) { a.push(ms(startFn, t)); b.push(ms(champion, t)); }
      else { b.push(ms(champion, t)); a.push(ms(startFn, t)); }
    }
    share = median(a) / (median(a) + median(b)); // champion's share: larger when it is faster
  }
  console.log(JSON.stringify({ [id]: { baseline: 1 - share, candidate: share } }));
} else throw new Error("Usage: bench.mjs validate FILE | audit START CHAMPION ID");
