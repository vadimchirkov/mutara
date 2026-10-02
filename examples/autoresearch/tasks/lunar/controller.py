# Lunar Lander controller: Gymnasium's stock heuristic. act(s) gets one observation
# [x, y, vx, vy, angle, angular velocity, left leg contact, right leg contact] and returns
# [main engine, side engine], each in [-1, 1].
import numpy as np


def act(s):
    angle_targ = np.clip(s[0] * 0.5 + s[2] * 1.0, -0.4, 0.4)
    angle_todo = (angle_targ - s[4]) * 0.5 - s[5] * 1.0
    hover_todo = (0.55 * abs(s[0]) - s[1]) * 0.5 - s[3] * 0.5
    if s[6] or s[7]:
        angle_todo = 0
        hover_todo = -s[3] * 0.5
    return np.clip([hover_todo * 20 - 1, -angle_todo * 20], -1, 1)
