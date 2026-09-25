# Gymnasium LunarLander (continuous): a parametric copy of the stock heuristic, or the MPC in planner.py.
# stdin: {"config": {...}, "seeds": [...], "wind": 0..20, "controller"?: "heuristic" | "mpc"}
#   -> stdout: {"runtime", "rows": [{"seed", "score", "seconds"}], "fit"?: {"xtx", "xty", "n"}}
# For "mpc" every airborne transition (obs, action, next_obs) feeds least-squares statistics for the model
# gains ("fit") and, with config.wind_k > 0, a per-episode drift estimate the planner uses.
import json, platform, sys, time
from collections import deque
from importlib.metadata import version
import gymnasium as gym
import numpy as np


def act(p, s):
    # Same shape as gymnasium.envs.box2d.lunar_lander.heuristic; its constants are the defaults.
    # s: (8,) or (..., 8); the planner calls it on a batch.
    s = np.moveaxis(np.asarray(s), -1, 0)
    angle_targ = np.clip(s[0] * p["kx"] + s[2] * p["kvx"], -p["amax"], p["amax"])
    angle = (angle_targ - s[4]) * p["ka"] - s[5] * p["kw"]
    hover = (p["hx"] * abs(s[0]) - s[1]) * p["kh"] - s[3] * p["kvy"]
    legs = (s[6] != 0) | (s[7] != 0)
    angle, hover = np.where(legs, 0, angle), np.where(legs, -s[3] * p["kvy"], hover)
    return np.clip(np.stack([hover * p["gm"] - 1, -angle * p["ga"]], -1), -1, 1)


def main():
    job = json.load(sys.stdin)
    wind, config, seeds = job["wind"], job["config"], job["seeds"]
    mpc = job.get("controller", "heuristic") == "mpc"
    if mpc:
        from planner import features, model, plan_batch
        k = int(config.get("wind_k", 0))
        drift = [deque(maxlen=max(k, 1)) for _ in seeds]  # last k unexplained Δvx per episode
        xtx, xty, n = np.zeros((4, 4)), np.zeros(4), 0
    envs = [gym.make("LunarLander-v3", continuous=True, enable_wind=wind > 0,
                     wind_power=wind or 15.0, turbulence_power=1.5 if wind else 0.0) for _ in seeds]
    # seeds terrain, spawn push and wind phase; float32 as the env returns it, so the heuristic is unchanged.
    obs = np.array([env.reset(seed=seed)[0] for env, seed in zip(envs, seeds)])
    rngs = [np.random.default_rng(seed) for seed in seeds]  # planner noise, per episode → bit-identical reruns
    score, live = np.zeros(len(seeds)), list(range(len(seeds)))
    start = time.perf_counter()
    # Episodes advance in lockstep so the planner handles all live ones in one batched call.
    while live:
        before = obs[live].astype(float)
        if mpc:
            wind_est = [np.mean(drift[i]) if k and drift[i] else 0.0 for i in live]
            actions = plan_batch(config, before, [rngs[i] for i in live], wind_est)
        else:
            actions = act(config, obs[live])
        still = []
        for i, action in zip(live, actions):
            obs[i], reward, terminated, truncated, _ = envs[i].step(action)
            score[i] += reward
            if not (terminated or truncated):
                still.append(i)
        if mpc:
            after = obs[live].astype(float)
            # Airborne on both ends (no leg contact), and not the step that ended the episode.
            air = (before[:, 6:8] == 0).all(1) & (after[:, 6:8] == 0).all(1) & np.isin(live, still)
            if air.any():
                a, b, u = before[air], after[air], np.asarray(actions)[air]
                X = features(a, u)
                y = np.concatenate([b[:, 2] - a[:, 2], b[:, 3] - a[:, 3], b[:, 5] - a[:, 5]])
                xtx += X.T @ X; xty += X.T @ y; n += len(a)
                # Drift = observed Δvx minus what the (windless) model predicts with this config's gains.
                resid = b[:, 2] - model(config, a[:, :6], u)[:, 2]
                for i, r in zip(np.asarray(live)[air], resid):
                    drift[i].append(r)
        live = still
    seconds = (time.perf_counter() - start) / len(seeds)  # wall clock per episode, averaged over the batch
    rows = [{"seed": seed, "score": float(r), "seconds": seconds} for seed, r in zip(seeds, score)]
    # Float results depend on the build; the adapter refuses to compare across runtimes.
    runtime = {"python": platform.python_version(), "machine": platform.machine(),
               **{pkg: version(pkg) for pkg in ("gymnasium", "numpy", "box2d")}}
    out = {"runtime": runtime, "rows": rows}
    if mpc:
        out["fit"] = {"xtx": xtx.tolist(), "xty": xty.tolist(), "n": n}
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
