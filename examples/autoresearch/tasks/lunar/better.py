# Positive control: the stock heuristic with the constants examples/lunar found (seed 2718, wind 20).
import numpy as np


def act(s):
    angle_targ = np.clip(s[0] * 0.29399410280693333 + s[2] * 1.0599088834027808, -1.5529286722524989, 1.5529286722524989)
    angle_todo = (angle_targ - s[4]) * 0.7587647429059573 - s[5] * 0.7788412798352427
    hover_todo = (0.3913368855161395 * abs(s[0]) - s[1]) * 0.43693937253836374 - s[3] * 0.9237160538024283
    if s[6] or s[7]:
        angle_todo = 0
        hover_todo = -s[3] * 0.9237160538024283
    return np.clip([hover_todo * 25.709846886632526 - 1, -angle_todo * 11.494126295452356], -1, 1)
