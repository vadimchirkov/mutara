// pnpm run bench:learning [repeats=3] [rounds=12] [attempts=158] [testGames=100]
// pnpm run bench:components [repeats=3] [rounds=24] [attempts=158] [testGames=500]
// pnpm run bench:learning --replay       verifies every decision and trajectory
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { EntityId } from "@lambda-house/teob-ts/core";
import { loadTable, syntheticWorld } from "../game/table.js";
import { policies } from "../game/policies.js";
import { harness } from "../harness.js";
import { emptyMemory, projectMemory, readJournal } from "../memory.js";
import type { AlchemyDeps } from "../aggregate.js";
import { INITIAL_WEIGHTS, implementationId, snapshotMemory, strategyVersion, type SearchMethod } from "./strategy.js";
import { createExperimentAggregate, decideCandidate, experimentHarness, mean,
  type ExperimentEvent, type ExperimentPlan, type ExperimentState, type EpisodeResult } from "./experiment.js";
import { alchemyEvaluator } from "./alchemy.js";
import { bootstrap95 } from "./statistics.js";
import { coreId } from "teob-mutara";

const flags = process.argv.slice(2);
const components = flags.includes("--components");
const outputOverride = flags.find((a) => a.startsWith("--output="))?.slice("--output=".length);
const output = outputOverride ?? new URL(`../../results-${components ? "components" : "learning"}.json`, import.meta.url);
const args = flags.filter((a) => !a.startsWith("--"));
if (args.length > 4 || flags.some((a) => a.startsWith("--") && !["--components", "--replay"].includes(a) && !a.startsWith("--output="))) {
  throw new Error("Usage: [repeats] [rounds] [attempts] [testGames] [--components] [--replay] [--output=path]");
}
const replay = flags.includes("--replay");
const saved = replay ? JSON.parse(readFileSync(output, "utf8")) : undefined;
const repeats = saved?.protocol.repeats ?? Number(args[0] ?? 3);
const rounds = saved?.protocol.rounds ?? Number(args[1] ?? (components ? 24 : 12));
const attempts = saved?.protocol.attempts ?? Number(args[2] ?? 158);
const testGames = saved?.protocol.testGames ?? Number(args[3] ?? (components ? 500 : 100));
for (const [name, n, max] of [["repeats", repeats, 20], ["rounds", rounds, 100], ["attempts", attempts, 1000], ["testGames", testGames, 5000]] as const) {
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`${name} must be 1..${max}`);
}
const methods: SearchMethod[] = components ? ["adaptive", "random", "components", "componentsRandom"] : ["adaptive", "random"];
const protocol = { repeats, rounds, attempts, warmupGames: 3, trainingGames: 4, validationGames: 4,
  testGames, minimumGain: 1, methods, seedBase: components ? 1_000_000 : 0, implementationId, coreId };
const dataDir = saved?.dataDir ?? new URL(`../../data/${components ? "components" : "learning"}-${Date.now()}`, import.meta.url).pathname;
if (!replay) mkdirSync(dataDir, { recursive: true });
if (saved && JSON.stringify(saved.protocol) !== JSON.stringify(protocol)) throw new Error("Restore the recorded implementation/protocol before replay");
const table = loadTable();
const evaluate = alchemyEvaluator(table);
const initial = strategyVersion(INITIAL_WEIGHTS);
const sequence = (start: number, count: number) => Array.from({ length: count }, (_, i) => start + i);

async function recoverAndVerify(path: string, method: SearchMethod) {
  const aggregate = createExperimentAggregate(evaluate);
  let state = aggregate.initial(EntityId(method));
  for (const row of readJournal(path, method)) {
    const event = JSON.parse(row.payload) as ExperimentEvent;
    if (event.tag === "candidate_decided") {
      const trial = event.trial;
      if (state.pending?.candidate.id !== trial.candidate.id || state.champion?.id !== trial.baselineId ||
          trial.round !== state.trials.length) throw new Error("Broken experiment lineage");
      const p = state.plan!;
      const actual = {
        baselineTraining: await evaluate(state.champion, p.trainingSeeds, p),
        candidateTraining: await evaluate(trial.candidate, p.trainingSeeds, p),
        baselineValidation: await evaluate(state.champion, p.validationSeeds, p),
        candidateValidation: await evaluate(trial.candidate, p.validationSeeds, p),
      };
      const runs = state.pending!.runs;
      if (runs.length !== 4 || runs.some((r) => !r.requested || !r.receipt || !r.observation || r.receipt.cost !== 0 ||
          JSON.stringify(r.receipt.output) !== JSON.stringify(r.observation.data)) ||
          JSON.stringify(Object.fromEntries(runs.map((r) => [r.job.key, r.receipt!.output]))) !== JSON.stringify(actual)) {
        throw new Error("Recorded job receipts differ from replay");
      }
      if (JSON.stringify(actual) !== JSON.stringify(trial.evaluation) ||
          JSON.stringify(decideCandidate(actual, p)) !== JSON.stringify({ accepted: trial.accepted, reason: trial.reason })) {
        throw new Error("Recorded trial differs from replay");
      }
    }
    state = aggregate.apply(state, event);
  }
  if (state.status !== "finished" || state.trials.length !== rounds) throw new Error("Incomplete experiment journal");
  return state;
}

async function runRepetition(repetition: number) {
  const offset = protocol.seedBase + repetition * 10000;
  const warmSeeds = sequence(offset + 1, protocol.warmupGames);
  const trainingSeeds = sequence(offset + 101, protocol.trainingGames);
  const validationSeeds = sequence(offset + 501, protocol.validationGames);
  // These seeds never enter ExperimentPlan or the proposal/acceptance loop.
  const testSeeds = sequence(offset + 1001, protocol.testGames);
  const warmDb = `${dataDir}/warm-${repetition}.db`;
  const experimentDb = `${dataDir}/search-${repetition}.db`;
  if (!replay) {
    const deps: AlchemyDeps = { table, policies, memory: emptyMemory() };
    const h = harness(warmDb, deps);
    try {
      for (let i = 0; i < warmSeeds.length; i++) {
        deps.memory = projectMemory(readJournal(warmDb));
        await h.play(`warm-${i}`, warmSeeds[i], "empowerment", attempts);
      }
    } finally { await h.close(); }
  }
  const memory = snapshotMemory(projectMemory(readJournal(warmDb)));
  const common = { seed: offset + 701, rounds, attempts, trainingSeeds, validationSeeds,
    minimumGain: protocol.minimumGain, tableHash: table.hash, memory, initial };
  const states = {} as Record<SearchMethod, ExperimentState>;
  let measuredGames = 0, measuredAttempts = 0;
  if (!replay) {
    const h = experimentHarness(experimentDb, async (v, seeds, p) => {
      const episodes = await evaluate(v, seeds, p);
      measuredGames += episodes.length;
      measuredAttempts += episodes.reduce((n, e) => n + e.attempts, 0);
      // Yield between batches so runtime messages and progress remain responsive.
      await new Promise<void>((resolve) => setImmediate(resolve));
      return episodes;
    });
    try {
      for (const method of methods) {
        await h.start(method, { ...common, method });
        states[method] = await h.wait(method);
        const accepted = states[method].trials.filter((t) => t.accepted).length;
        console.log(`repeat ${repetition + 1}/${repeats}, ${method}: ${accepted}/${rounds} accepted; ` +
          JSON.stringify({ weights: states[method].champion!.weights, components: states[method].champion!.components }));
      }
    } finally { await h.close(); }
  } else {
    for (const method of methods) {
      states[method] = await recoverAndVerify(experimentDb, method);
      if (JSON.stringify(states[method].plan) !== JSON.stringify({ ...common, method })) throw new Error("Recorded plan differs from protocol");
      for (const trial of states[method].trials) for (const batch of [trial.evaluation.baselineTraining,
        trial.evaluation.candidateTraining, trial.evaluation.baselineValidation, trial.evaluation.candidateValidation]) {
        measuredGames += batch.length;
        measuredAttempts += batch.reduce((n, e) => n + e.attempts, 0);
      }
    }
  }

  const plan: ExperimentPlan = { ...common, method: "adaptive" };
  const tests: Record<string, EpisodeResult[]> = {
    fixed: await evaluate(initial, testSeeds, { ...plan, memory: snapshotMemory(emptyMemory()) }),
    memory: await evaluate(initial, testSeeds, plan),
  };
  for (const method of methods) {
    const name = method === "random" ? "randomSearch" : method;
    tests[name] = await evaluate(states[method].champion!, testSeeds, plan);
    console.log(`repeat ${repetition + 1}, held-out ${name}: ${mean(tests[name].map((e) => e.score)).toFixed(3)}`);
  }
  const means = Object.fromEntries(Object.entries(tests).map(([name, episodes]) => [name, mean(episodes.map((e) => e.score))]));

  // Structural transfer: do learned weights generalize to a world with different
  // graph topology (depth, width, hub distribution)? Memory can't transfer (it
  // contains element names from the training world), so both same-world and
  // cross-world tests use empty memory to isolate the weight contribution.
  let transfer: { sameWorldNoMem: Record<string, number>; crossWorld: Record<string, number>;
    lift: Record<string, { sameWorld: number; crossWorld: number; efficiency: number | null }> } | undefined;
  if (components) {
    const synthetic = syntheticWorld(719 + repetition);
    const crossEval = alchemyEvaluator(synthetic);
    const noMemPlan: ExperimentPlan = { ...plan, memory: snapshotMemory(emptyMemory()) };
    const crossPlan: ExperimentPlan = { ...noMemPlan, tableHash: synthetic.hash };
    const sameWorldNoMem: Record<string, number> = { fixed: means.fixed };
    const crossWorld: Record<string, number> = {
      fixed: mean((await crossEval(initial, testSeeds, crossPlan)).map((e) => e.score)),
    };
    for (const method of methods) {
      const name = method === "random" ? "randomSearch" : method;
      sameWorldNoMem[name] = mean((await evaluate(states[method].champion!, testSeeds, noMemPlan)).map((e) => e.score));
      crossWorld[name] = mean((await crossEval(states[method].champion!, testSeeds, crossPlan)).map((e) => e.score));
    }
    const lift: Record<string, { sameWorld: number; crossWorld: number; efficiency: number | null }> = {};
    for (const name of Object.keys(sameWorldNoMem).filter((n) => n !== "fixed")) {
      const sw = sameWorldNoMem[name] - sameWorldNoMem.fixed;
      const cw = crossWorld[name] - crossWorld.fixed;
      lift[name] = { sameWorld: sw, crossWorld: cw, efficiency: sw > 0 ? cw / sw : null };
    }
    transfer = { sameWorldNoMem, crossWorld, lift };
    for (const [name, l] of Object.entries(lift)) {
      console.log(`repeat ${repetition + 1}, transfer ${name}: same-world lift=${l.sameWorld.toFixed(2)}, ` +
        `cross-world lift=${l.crossWorld.toFixed(2)}, efficiency=${l.efficiency?.toFixed(3) ?? "n/a"}`);
    }
  }

  const paired = (name: string, baseline: string) => tests[name].map((e, i) => e.score - tests[baseline][i].score);
  const result = { repetition, warmSeeds, trainingSeeds, validationSeeds, testSeeds, means, tests,
    deltaVsMemory: paired("adaptive", "memory"), deltaVsRandomSearch: paired("adaptive", "randomSearch"),
    componentComparisons: components ? Object.fromEntries(["memory", "adaptive", "componentsRandom"].map((baseline) => {
      const differences = paired("components", baseline);
      return [baseline, { differences, mean: mean(differences), ...bootstrap95(differences, repetition + 1) }];
    })) : undefined,
    champions: Object.fromEntries(methods.map((method) => [method, states[method].champion])),
    learningCurves: Object.fromEntries(Object.entries(states).map(([name, state]) => [name, state.trials.map((t) => ({
      round: t.round, candidateId: t.candidate.id, parentId: t.candidate.parentId, baselineId: t.baselineId,
      weights: t.candidate.weights, components: t.candidate.components, accepted: t.accepted, reason: t.reason,
    }))])),
    cost: { warmupGames: warmSeeds.length, searchGames: measuredGames, searchAttempts: measuredAttempts,
      testGames: testSeeds.length * (Object.keys(tests).length + (transfer ? 2 * methods.length + 1 : 0)), apiCalls: 0 },
    transfer,
  };
  console.log(`repeat ${repetition + 1}: ${Object.entries(means).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(" ")}`);
  return result;
}
const results: Awaited<ReturnType<typeof runRepetition>>[] = [];
for (let repetition = 0; repetition < repeats; repetition++) {
  results.push(await runRepetition(repetition));
  if (!replay) writeFileSync(output, JSON.stringify({ protocol, dataDir, results }, null, 2));
}
const summary = {
  means: Object.fromEntries(Object.keys(results[0].means).map((name) => [name, mean(results.map((r) => r.means[name]))])),
  improvementVsMemoryByRepeat: results.map((r) => mean(r.deltaVsMemory)),
  improvementVsRandomSearchByRepeat: results.map((r) => mean(r.deltaVsRandomSearch)),
  improvementBootstrap95ByRepeat: results.map((r) => ({ mean: mean(r.deltaVsMemory), ...bootstrap95(r.deltaVsMemory, r.repetition + 1) })),
  searchGames: results.reduce((n, r) => n + r.cost.searchGames, 0),
  testGames: results.reduce((n, r) => n + r.cost.testGames, 0),
  componentComparisonsByRepeat: components ? results.map((r) => Object.fromEntries(
    Object.entries(r.componentComparisons!).map(([baseline, { differences: _, ...interval }]) => [baseline, interval]))) : undefined,
  transfer: components ? {
    meanEfficiency: Object.fromEntries(Object.keys(results[0].transfer!.lift).map((name) => {
      const values = results.map((r) => r.transfer!.lift[name].efficiency).filter((v) => v !== null);
      return [name, values.length ? mean(values) : null];
    })),
    byRepeat: results.map((r) => r.transfer!.lift),
  } : undefined,
  apiCalls: 0,
};
if (replay) {
  if (JSON.stringify(results) !== JSON.stringify(saved.results) || JSON.stringify(summary) !== JSON.stringify(saved.summary)) {
    throw new Error("Report differs from journal and simulation replay");
  }
  console.log("All decisions, trajectories and held-out scores reproduced; zero API calls.");
} else writeFileSync(output, JSON.stringify({ protocol, dataDir, results, summary }, null, 2));
console.log(JSON.stringify(summary, null, 2));
