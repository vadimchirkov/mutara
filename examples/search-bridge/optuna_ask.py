# One Optuna ask as a pure function of the journaled history.
# stdin: {"space": {name: [lo, hi]}, "history": [{"config": {...}, "value": float}], "seed": int, "initial"?: {...}}
#   -> stdout: {"config": {...}, "optuna": version}
# The study is rebuilt from history on every call (add_trial), and the sampler seed is
# seed + len(history), so the same history always yields the same candidate and a fresh
# history length never reuses the first random-startup draw. Space: log-uniform floats.
# "initial" is enqueued as the first trial when history is empty (warm start, like hill-climbing).
import json, sys
import optuna

def main():
    job = json.load(sys.stdin)
    optuna.logging.set_verbosity(optuna.logging.WARNING)
    space = {k: optuna.distributions.FloatDistribution(lo, hi, log=True) for k, (lo, hi) in job["space"].items()}
    history = job["history"]
    study = optuna.create_study(direction="maximize", sampler=optuna.samplers.TPESampler(seed=job["seed"] + len(history)))
    for h in history:
        study.add_trial(optuna.trial.create_trial(params=h["config"], distributions=space, value=h["value"]))
    if not history and job.get("initial"):
        study.enqueue_trial(job["initial"])
    trial = study.ask(space)
    json.dump({"config": trial.params, "optuna": optuna.__version__}, sys.stdout)

if __name__ == "__main__":
    main()
