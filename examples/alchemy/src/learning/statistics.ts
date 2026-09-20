import { rng } from "../game/table.js";

export function bootstrap95(values: number[], seed: number) {
  if (!values.length || values.some((v) => !Number.isFinite(v))) throw new Error("Expected finite paired differences");
  const random = rng(seed);
  const samples = Array.from({ length: 2000 }, () => {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(random() * values.length)];
    return sum / values.length;
  }).sort((a, b) => a - b);
  return { low: samples[49], high: samples[1949] }; // nearest-rank 2.5% and 97.5%
}
