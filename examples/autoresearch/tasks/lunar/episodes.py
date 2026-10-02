# Frozen harness for the lunar task. The agent never sees or edits this file.
# argv: CONTROLLER.py; stdin: {"seeds": [...]} -> stdout: {"seed": episode return, ...}
# LunarLander-v3, continuous, wind 20, turbulence 1.5 (the storm of examples/lunar).
import importlib.util, json, sys
import gymnasium as gym
import numpy as np

spec = importlib.util.spec_from_file_location("controller", sys.argv[1])
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)
env = gym.make("LunarLander-v3", continuous=True, enable_wind=True, wind_power=20.0, turbulence_power=1.5)
out = {}
for seed in json.load(sys.stdin)["seeds"]:
    obs, _ = env.reset(seed=seed)
    total, done = 0.0, False
    while not done:
        action = np.asarray(controller.act(obs), dtype=np.float32)
        if action.shape != (2,) or not np.all(np.isfinite(action)):
            raise ValueError(f"act() must return 2 finite numbers, got {action!r}")
        obs, reward, terminated, truncated, _ = env.step(np.clip(action, -1, 1))
        total += reward
        done = terminated or truncated
    out[str(seed)] = total
json.dump(out, sys.stdout)
