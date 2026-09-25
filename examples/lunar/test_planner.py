# Run: cd examples/lunar && uv run -q --python 3.12 --with "gymnasium[box2d]==1.3.0" --with numpy==2.5.3 python test_planner.py
import json, subprocess
import numpy as np
from planner import plan

config = json.loads(subprocess.run(
    ["node", "--input-type=module", "-e",
     "import { MPC_INITIAL } from './experiment.mjs'; console.log(JSON.stringify(MPC_INITIAL))"],
    capture_output=True, text=True, check=True).stdout)
obs = np.array([0.3, 1.2, -0.4, -0.5, 0.1, -0.05, 0, 0], np.float32)
a, b = plan(config, obs, np.random.default_rng(7)), plan(config, obs, np.random.default_rng(7))
assert np.array_equal(a, b), (a, b)
assert a.shape == (2,) and np.all(np.abs(a) <= 1), a
print("ok", a)
