// Deterministic payment-extraction task with hidden output conventions. The initial
// prompt names the fields but not their formats; only evaluator feedback on train
// failures reveals them. Generated locally from a seed: no download, no private data.

export const INITIAL_PROMPT =
  'Extract the payment from the message. Reply with JSON: {"amount", "currency", "date", "vendor"}.';
export const OBJECTIVE =
  "Extract amount, currency, date and vendor from payment messages exactly in the conventions the evaluator expects.";

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = Math.imul(x ^ (x >>> 15), x | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VENDORS = [["Acme", "Ltd"], ["Globex", "LLC"], ["Initech", "Inc."], ["Umbrella", "GmbH"], ["Stark Industries", "plc"],
  ["Wayne Enterprises", "Corp."], ["Hooli", "S.A."], ["Vandelay Imports", "Ltd."], ["Soylent", "AG"], ["Tyrell", "Co."]];
const CURRENCIES = [
  { code: "EUR", symbol: "€", words: ["euros", "EUR"] },
  { code: "USD", symbol: "$", words: ["dollars", "USD"] },
  { code: "GBP", symbol: "£", words: ["pounds", "GBP"] },
  { code: "JPY", symbol: "¥", words: ["yen", "JPY"] },
];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ordinal = (d) => d + (d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th");
const pad = (n) => String(n).padStart(2, "0");
const group = (digits, sep) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, sep);

function amountText(pick, cents, currency) {
  const units = currency.code === "JPY" ? String(Math.round(cents / 100) * 100) : String(Math.floor(cents / 100));
  const frac = currency.code === "JPY" ? "" : pad(cents % 100);
  // "345.900" would read as a decimal: no dot-grouping for yen, which has no fractional part.
  const style = currency.code === "JPY" ? [0, 1, 3][pick(3)] : pick(4);
  const number = style === 0 ? group(units, ",") + (frac ? "." + frac : "")
    : style === 1 ? units + (frac ? "." + frac : "")
    : style === 2 ? group(units, ".") + (frac ? "," + frac : "")
    : group(units, " ") + (frac ? "," + frac : "");
  const form = pick(3);
  if (form === 0) return `${currency.symbol}${number}`;
  if (form === 1) return `${number} ${currency.code}`;
  return `${number} ${currency.words[pick(2)]}`;
}

function dateText(pick, y, m, d) {
  switch (pick(5)) {
    case 0: return `${d} ${MONTHS[m - 1]} ${y}`;
    case 1: return `${MONTHS[m - 1]} ${ordinal(d)}, ${y}`;
    case 2: return `${d}.${m}.${y}`;
    case 3: return `${MONTHS[m - 1].slice(0, 3)} ${d} ${y}`;
    default: return `the ${ordinal(d)} of ${MONTHS[m - 1]}, ${y}`;
  }
}

const TEMPLATES = [
  (a, v, d) => `Paid ${a} to ${v} on ${d}.`,
  (a, v, d) => `${d}: ${v} invoice settled, ${a}.`,
  (a, v, d) => `Transfer of ${a} to ${v} went out ${d}.`,
  (a, v, d) => `We were charged ${a} by ${v}, dated ${d}.`,
];
const REFUND = (a, v, d) => `Refund from ${v} of ${a} received ${d}.`;

/** One case: `input.text` for the model, `expected` in the hidden conventions. */
export function makeCase(seed) {
  const r = rng(seed);
  const pick = (n) => Math.floor(r() * n);
  const [name, suffix] = VENDORS[pick(VENDORS.length)];
  const currency = CURRENCIES[pick(CURRENCIES.length)];
  const cents = 100 + pick(500000);
  const y = 2022 + pick(4), m = 1 + pick(12), d = 1 + pick(28);
  const refund = pick(5) === 0;
  const text = (refund ? REFUND : TEMPLATES[pick(TEMPLATES.length)])(amountText(pick, cents, currency), `${name} ${suffix}`, dateText(pick, y, m, d));
  const value = currency.code === "JPY" ? String(Math.round(cents / 100) * 100) : (cents / 100).toFixed(2);
  return {
    input: { text },
    expected: { amount: (refund ? "-" : "") + value, currency: currency.code, date: `${y}-${pad(m)}-${pad(d)}`, vendor: name.toUpperCase() },
  };
}

/** 30 train, 30 validation, 60 final cases by default; disjoint seeds per split. */
export function dataset({ train = 30, validation = 30, final = 60 } = {}) {
  const cases = [
    ...Array.from({ length: train }, (_, i) => ({ id: `train-${i}`, split: "train", ...makeCase(1000 + i) })),
    ...Array.from({ length: validation }, (_, i) => ({ id: `validation-${i}`, split: "validation", ...makeCase(2000 + i) })),
  ];
  const finalCases = Array.from({ length: final }, (_, i) => ({ id: `final-${i}`, ...makeCase(3000 + i) }));
  return { cases, finalCases };
}

/** Parse the first JSON object in a model reply; null if none. */
export function parseReply(text) {
  const body = String(text).replace(/```(?:json)?/g, "");
  const start = body.indexOf("{"), end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(body.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Fraction of fields exactly right; a reply that is not a JSON object is a violation. */
export function grade(output, expected) {
  const reply = parseReply(output);
  if (!reply) return { score: 0, violation: 1, feedback: "Reply was not a JSON object." };
  const wrong = Object.keys(expected).filter((k) => String(reply[k]) !== expected[k]);
  return {
    score: (4 - wrong.length) / 4,
    violation: 0,
    feedback: wrong.length ? wrong.map((k) => `${k}: expected ${JSON.stringify(expected[k])}, got ${JSON.stringify(reply[k] ?? null)}`).join("; ") : null,
  };
}
