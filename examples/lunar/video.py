# Side-by-side demo: stock heuristic vs champion on the same held-out storm seeds.
# stdin: {"champion": {...}, "seeds": [...], "wind": 20, "episodes": 3} ; argv[1]: output .mp4
# Picks the first seeds where stock crashes (return < 0) and the champion lands (>= 200),
# so the clip is selected by construction; the audit table is the unbiased number.
import json, sys
import gymnasium as gym
import imageio.v2 as imageio
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from lander import act

STOCK = dict(kx=0.5, kvx=1, amax=0.4, hx=0.55, ka=0.5, kw=1, kh=0.5, kvy=0.5, gm=20, ga=20)


def episode(config, seed, wind, render):
    env = gym.make("LunarLander-v3", continuous=True, enable_wind=True, wind_power=wind,
                   turbulence_power=1.5, render_mode="rgb_array" if render else None)
    obs, _ = env.reset(seed=seed)
    score, done, frames = 0.0, False, []
    while not done:
        if render:
            frames.append(env.render())
        obs, reward, terminated, truncated, _ = env.step(act(config, obs))
        score += reward
        done = terminated or truncated
    if render:
        frames.append(env.render())
    env.close()
    return score, frames


def label(frame, text, color):
    image = Image.fromarray(frame)
    ImageDraw.Draw(image).text((12, 10), text, fill=color, font=ImageFont.load_default(size=22))
    return np.asarray(image)


def main():
    job = json.load(sys.stdin)
    champion, wind = job["champion"], job["wind"]
    picked = []
    for seed in job["seeds"]:
        if episode(STOCK, seed, wind, False)[0] < 0 and episode(champion, seed, wind, False)[0] >= 200:
            picked.append(seed)
        if len(picked) == job["episodes"]:
            break
    writer = imageio.get_writer(sys.argv[1], fps=50, codec="libx264", quality=7, macro_block_size=8)
    for seed in picked:
        (a, left), (b, right) = episode(STOCK, seed, wind, True), episode(champion, seed, wind, True)
        # Freeze each side on its last frame until the longer episode ends, plus a 1 s hold.
        for i in range(max(len(left), len(right)) + 50):
            l = label(left[min(i, len(left) - 1)], f"Stock heuristic  {a:+.0f}" if i >= len(left) - 1 else "Stock heuristic", (255, 90, 90))
            r = label(right[min(i, len(right) - 1)], f"Mutara champion  {b:+.0f}" if i >= len(right) - 1 else "Mutara champion", (90, 255, 120))
            writer.append_data(np.hstack([l, np.full((l.shape[0], 8, 3), 255, np.uint8), r]))
    writer.close()
    json.dump({"seeds": picked, "output": sys.argv[1]}, sys.stdout)


if __name__ == "__main__":
    main()
