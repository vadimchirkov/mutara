// Scripted outputs exercise the protocol. They are NOT recorded/model-generated predictions.
import { readFileSync } from "node:fs";

export function loadFixture(path, proposals) {
  const rows = JSON.parse(readFileSync(path, "utf8"));
  const prompts = [proposals.initial, ...proposals.candidates];
  const predictions = Object.fromEntries(Object.values(rows).flat().flatMap(([, text, , outputs]) =>
    prompts.map((prompt, i) => [JSON.stringify([prompt, text]), outputs[i]])));
  return {
    datasets: Object.fromEntries(Object.entries(rows).map(([split, cases]) =>
      [split, cases.map(([id, text, label]) => ({ id, text, label }))])),
    executor: {
      implementation: { kind: "synthetic fixture, no LLM calls", predictions,
        source: readFileSync(new URL(import.meta.url), "utf8") },
      recovery: "repeatable", costLimit: 0, budget: 0,
      async execute({ prompt, text }) {
        const output = predictions[JSON.stringify([prompt, text])];
        if (!output) throw new Error("Missing synthetic prediction");
        return { output, cost: 0 };
      },
    },
  };
}
