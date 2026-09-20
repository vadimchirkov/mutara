// Live: pnpm run bench:semantic [games=3] [attempts=158] [shortlist=12]
// Offline verification: pnpm run bench:semantic --replay
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { EntityId } from "@lambda-house/teob-ts/core";
import { loadTable, shuffleNames, pairKey, type Table } from "./game/table.js";
import { policies, oracle } from "./game/policies.js";
import { playOffline, type GameState } from "./game/engine.js";
import { freshDb, harness } from "./harness.js";
import { readJournal, projectMemory, emptyMemory, journalBytes } from "./memory.js";
import { createAlchemyAggregate, type AlchemyDeps, type AlchemyEvent } from "./aggregate.js";
import { JUDGE_MODEL, SHORTLIST_SIZE, selectedPair, typeSafeJudge, type JudgeRequest } from "./judge.js";
import { correlation } from "./q4.js";

const output = new URL("../results-semantic.json", import.meta.url);
const args = process.argv.slice(2);
const replay = args.includes("--replay");
const previous = replay ? JSON.parse(readFileSync(output, "utf8")) : undefined;
const games = previous?.protocol.games ?? Number(args[0] ?? 3);
const attempts = previous?.protocol.attempts ?? Number(args[1] ?? 158);
const shortlistSize = previous?.protocol.shortlist ?? Number(args[2] ?? SHORTLIST_SIZE);
for (const [name, value, max] of [["games", games, 100], ["attempts", attempts, 10000], ["shortlist", shortlistSize, 64]] as const) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} must be 1..${max}`);
}
if (!replay && existsSync(new URL("../.env", import.meta.url))) loadEnvFile(new URL("../.env", import.meta.url));
const judge = replay ? undefined : typeSafeJudge(process.env.TYPESAFE_API_KEY ?? process.env.ALCHEMY_API_KEY ?? "");
const table = loadTable();
const shuffleSeed = 719;
const shuffled = shuffleNames(table, shuffleSeed);
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

function analyse(db: string, world: Table) {
  const rows = readJournal(db);
  const probabilities: number[] = [];
  const truth: number[] = [];
  const selected: number[] = [];
  const heuristic: number[] = [];
  const ceilings: number[] = [];
  const latencies: number[] = [];
  const models = new Set<string>();
  const discoveries: number[] = [];
  const snapshots = new Map<string, GameState>();
  const fold = createAlchemyAggregate({ table: world, policies });
  const pending = new Map<string, JudgeRequest>();
  const choices = new Map<string, [string, string]>();
  let inputTokens = 0, outputTokens = 0, httpAttempts = 0, completed = 0;
  for (const row of rows) {
    const event = JSON.parse(row.payload) as AlchemyEvent;
    const id = row.persistence_id;
    const before = snapshots.get(id) ?? fold.initial(EntityId(id));
    const after = fold.apply(before, event);
    snapshots.set(id, after);
    for (const invariant of fold.invariants ?? []) {
      if (!invariant.check(after)) throw new Error(`Replay invariant failed: ${invariant.name}`);
    }
    if (event.tag === "game_started" && event.tableHash !== world.hash) throw new Error("Recipe table changed");
    if (event.tag === "judgment_requested") {
      if (event.t !== before.t || JSON.stringify(event.request.state.known) !== JSON.stringify(before.known) ||
          event.request.state.pairs.some(([a, b]) => !before.known.includes(a) || !before.known.includes(b) ||
            before.tried.includes(pairKey(a, b)))) throw new Error("Request differs from recorded game state");
      pending.set(id, event.request);
    }
    if (event.tag === "judgment_received") {
      const request = pending.get(id);
      if (!request) throw new Error("Judgment has no recorded request");
      const { response, elapsedMs, httpAttempts: calls } = event.judgment;
      const pair = selectedPair(request, response);
      choices.set(id, pair);
      const labels = request.state.pairs.map(([a, b]) =>
        Number(world.combine(a, b).some((r) => !request.state.known.includes(r))));
      request.state.pairs.forEach((_, i) => {
        probabilities.push(response.answers[`p${i}`].noul);
        truth.push(labels[i]);
      });
      selected.push(labels[request.state.pairs.findIndex((p) => pairKey(...p) === pairKey(...pair))]);
      heuristic.push(labels[0]);
      ceilings.push(Math.max(...labels));
      latencies.push(elapsedMs);
      models.add(response.model);
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
      httpAttempts += calls;
      // The following pair_tried must match the choice reconstructed from the response.
    }
    if (event.tag === "pair_tried" && before.judgeConfig) {
      const request = pending.get(id);
      const choice = choices.get(id);
      if (!request || !choice || pairKey(event.a, event.b) !== pairKey(...choice)) {
        throw new Error("Recorded action differs from model selection");
      }
      const results = world.combine(event.a, event.b);
      const fresh = results.filter((r) => !before.known.includes(r));
      if (event.t !== before.t || JSON.stringify(results) !== JSON.stringify(event.results) ||
          JSON.stringify(fresh) !== JSON.stringify(event.fresh)) throw new Error("Recorded outcome differs from table");
      pending.delete(id);
      choices.delete(id);
    }
    if (event.tag === "game_failed") throw new Error(`Recorded game failed: ${event.message}`);
    if (event.tag === "game_finished") {
      if (event.discovered !== after.known.length || after.t !== attempts) throw new Error("Incomplete game");
      discoveries.push(after.known.length);
      completed++;
    }
  }
  if (completed !== games || pending.size) throw new Error("Incomplete journal");
  latencies.sort((a, b) => a - b);
  return {
    discoveries, mean: mean(discoveries),
    calibration: {
      pairsScored: truth.length, positiveRate: mean(truth),
      correlation: correlation(probabilities, truth),
      brier: mean(probabilities.map((p, i) => (p - truth[i]) ** 2)),
      constantPrevalenceBrier: mean(truth) * (1 - mean(truth)),
      selectedHitRate: mean(selected), heuristicHitRateOnSameShortlists: mean(heuristic),
      shortlistCeilingHitRate: mean(ceilings),
    },
    usage: { requests: latencies.length, httpAttempts, inputTokens, outputTokens,
      estimatedUsd: inputTokens * 0.042 / 1_000_000,
      requestP50Ms: latencies[Math.floor(latencies.length / 2)] ?? 0,
      models: [...models] },
    journal: { events: rows.length, bytes: [...journalBytes(rows).values()].reduce((a, b) => a + b, 0) },
  };
}

const arms: Record<string, ReturnType<typeof analyse>> = {};
const protocol = { games, attempts, shortlist: shortlistSize, model: JUDGE_MODEL, shuffleSeed, tableHash: table.hash };
// Timestamped directories preserve earlier runs and interrupted journals.
const dataDir = replay ? previous.dataDir : new URL(`../data/semantic-${Date.now()}/`, import.meta.url).pathname;
if (!replay) mkdirSync(dataDir, { recursive: true });
const baselines = Object.fromEntries(Object.entries({ ...policies, oracle: oracle(table) }).map(([name, policy]) => {
  const scores = Array.from({ length: games }, (_, i) => playOffline(table, policy, i + 1, attempts).known.length);
  return [name, { discoveries: scores, mean: mean(scores) }];
}));
for (const [name, world, memory] of [
  ["semantic", table, false], ["semanticMemory", table, true], ["shuffled", shuffled, false],
] as const) {
  const db = `${dataDir}/${name}.db`;
  if (!replay) {
    const deps: AlchemyDeps = { table: world, policies, judge, memory: emptyMemory(),
      judgeConfig: { model: JUDGE_MODEL, shortlist: shortlistSize } };
    const h = harness(freshDb(db), deps, attempts * 95_000);
    try {
      for (let g = 0; g < games; g++) {
        deps.memory = memory ? projectMemory(readJournal(db)) : emptyMemory();
        const state = await h.play(`g${g}`, g + 1, "semantic", attempts);
        console.log(`${name} game ${g + 1}/${games}: ${state?.known.length} elements (${state?.t} attempts)`);
      }
    } finally { await h.close(); }
  }
  arms[name] = analyse(db, world);
  console.log(`${name}: mean ${arms[name].mean.toFixed(1)}, r=${arms[name].calibration.correlation.toFixed(3)}, ` +
    `Brier=${arms[name].calibration.brier.toFixed(3)}, ${arms[name].usage.requests} requests`);
  if (!replay) writeFileSync(output, JSON.stringify({ generatedAt: new Date().toISOString(), protocol, dataDir, baselines, arms }, null, 2));
}
if (replay) {
  if (JSON.stringify(arms) !== JSON.stringify(previous.arms)) throw new Error("Offline replay differs from saved report");
  console.log("All three journals reproduce the saved report; zero API calls.");
} else {
  console.log(`Empowerment: ${baselines.empowerment.mean.toFixed(1)}; semantic lift: ${(arms.semantic.mean - baselines.empowerment.mean).toFixed(1)}`);
  console.log(`Estimated inference cost: $${Object.values(arms).reduce((sum, a) => sum + a.usage.estimatedUsd, 0).toFixed(4)}`);
}
