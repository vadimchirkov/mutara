# Online planner (MPC, random shooting) over an approximate rigid-body model. The model never touches the
# real env: its gains are hand-calibrated or fitted from logged flight, and wind enters only as a drift
# estimate from what the lander has already felt. Mutara tunes the rest and gates every change.
import numpy as np
from lander import act

# Observation geometry (fixed by LunarLander's normalization, FPS 50, SCALE 30), per env step:
# dx = vx/100, dy = 0.0225*vy, dangle = angvel/20; a force moves vx 1.5x as much as vy (units 5 vs 7.5).
DX, DY, DA, XY = 0.01, 0.0225, 0.05, 1.5
# Contact thresholds for the crash penalty: vertical speed and tilt at y <= 0.
CRASH_VY, CRASH_ANGLE = 0.5, 0.4


def engines(a):
    # LunarLander's continuous action mapping: main fires at a0 > 0 with power 0.5..1; side at |a1| > 0.5.
    main = np.where(a[..., 0] > 0, (np.clip(a[..., 0], 0, 1) + 1) / 2, 0.0)
    side = np.where(np.abs(a[..., 1]) > 0.5, np.sign(a[..., 1]) * np.clip(np.abs(a[..., 1]), 0.5, 1), 0.0)
    return main, side


def model(p, s, a, wind=0.0):
    # s: (..., 6) = x, y, vx, vy, angle, angvel in observation units; a: (..., 2).
    # wind: estimated lateral drift per step (Δvx the physics does not explain), broadcast over s.
    x, y, vx, vy, th, w = np.moveaxis(s, -1, 0)
    main, side = engines(a)
    sin, cos = np.sin(th), np.cos(th)
    vx = vx + XY * (-sin * p["main_gain"] * main + cos * p["side_gain"] * side) + wind
    vy = vy + cos * p["main_gain"] * main + sin * p["side_gain"] * side - p["gravity"]
    w = w - p["torque_gain"] * side  # calibrated: right-side push spins negative
    return np.stack([x + DX * vx, y + DY * vy, vx, vy, th + DA * w, w], -1)


def features(obs, action):
    # Least-squares rows for theta = (main_gain, side_gain, gravity, torque_gain): Δ(vx, vy, angvel) = X @ theta.
    # obs: (N, 8) before the step; action: (N, 2). Returns X (3N, 4). Wind shows up as residual noise on Δvx.
    main, side = engines(action)
    sin, cos, zero = np.sin(obs[:, 4]), np.cos(obs[:, 4]), np.zeros(len(obs))
    return np.concatenate([np.stack([-XY * sin * main, XY * cos * side, zero, zero], 1),
                           np.stack([cos * main, sin * side, -np.ones(len(obs)), zero], 1),
                           np.stack([zero, zero, zero, -side], 1)])


def warm_start(p, obs, horizon, wind):
    # The heuristic rolled out through the model: (E, H, 2).
    s, seq = obs[:, :6].copy(), []
    for _ in range(horizon):
        a = act(p, np.concatenate([s, np.zeros((len(s), 2))], 1))
        seq.append(a)
        s = model(p, s, a, wind)
    return np.stack(seq, 1)


def plan_batch(p, obs, rngs, wind=None):
    # obs: (E, 8) one row per episode; rngs: one Generator per episode; wind: (E,) drift estimates or None.
    # Returns (E, 2). The planner assumes the estimated drift persists over its horizon.
    H, S = int(p["horizon"]), int(p["samples"])
    obs = np.asarray(obs, float)
    wind = np.zeros(len(obs)) if wind is None else np.asarray(wind, float)
    base = warm_start(p, obs, H, wind)
    noise = np.stack([r.normal(0, p["noise"], (S - 1, H, 2)) for r in rngs])
    seqs = np.concatenate([base[:, None], np.clip(base[:, None] + noise, -1, 1)], 1)  # (E, S, H, 2)
    s = np.broadcast_to(obs[:, None, :6], (len(obs), S, 6))
    cost = np.zeros((len(obs), S))
    alive = np.ones((len(obs), S), bool)
    for t in range(H):
        a = seqs[:, :, t]
        s = model(p, s, a, wind[:, None])
        x, y, vx, vy, th, w = np.moveaxis(s, -1, 0)
        main, side = engines(a)
        step = (p["w_pos"] * (np.abs(x) + np.abs(y)) + p["w_vel"] * (vx ** 2 + vy ** 2) + p["w_angle"] * np.abs(th)
                + p["w_spin"] * np.abs(w) + p["w_fuel"] * (main + 0.1 * np.abs(side)))
        touch = alive & (y <= 0)
        cost += np.where(alive, step, 0) + p["w_crash"] * (touch & ((np.abs(vy) > CRASH_VY) | (np.abs(th) > CRASH_ANGLE)))
        alive &= ~touch  # the model ends a rollout at first contact
    best = seqs[np.arange(len(obs)), cost.argmin(1), 0]
    # On the legs the model has no contact physics; the warm-start heuristic settles the lander.
    legs = (obs[:, 6] > 0) | (obs[:, 7] > 0)
    return np.where(legs[:, None], base[:, 0], best)


def plan(p, obs, rng):
    return plan_batch(p, np.asarray(obs, float)[None], [rng])[0]


def calibrate(seeds=range(8), steps=12):
    # Step the windless env with fixed actions from spawn and fit the model gains by least squares.
    import gymnasium as gym
    env = gym.make("LunarLander-v3", continuous=True)
    fits = {}
    for name, action in {"gravity": [0, 0], "main": [1, 0], "side": [0, 1]}.items():
        dvx, dvy, dw, th = [], [], [], []
        for seed in seeds:
            s, _ = env.reset(seed=seed)
            for _ in range(steps):
                n, *_ = env.step(np.array(action, np.float32))
                dvx.append(n[2] - s[2]); dvy.append(n[3] - s[3]); dw.append(n[5] - s[5]); th.append(s[4])
                s = n
        fits[name] = np.mean(dvx), np.mean(dvy), np.mean(dw), np.mean(np.abs(th))
    gravity = -fits["gravity"][1]
    return {"gravity": gravity, "main_gain": fits["main"][1] + gravity,
            "side_gain": fits["side"][0] / XY, "torque_gain": -fits["side"][2], "raw": fits}


if __name__ == "__main__":
    print(calibrate())
