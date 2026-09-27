"""GEPA baseline on IFBench: dspy.GEPA with GEPA's own program, splits and metric.

    MUTARA_LLM_BASE_URL=... MUTARA_LLM_API_KEY=... MUTARA_LLM_MODEL=... \
      uv run -q --python 3.12 --with dspy==3.4.0 <checker pins from program.mjs> \
      python examples/ifbench/gepa_baseline.py NEW_RUN_DIRECTORY [--seed N] [--budget 3593] [--threads 8] [--dry]

all.mjs builds this command. Same endpoint variables, models, temperatures and token
caps as run.mjs; max_metric_calls is the shared budget. The program is the artifact's
IFBenchCoT2StageProgram; feedback per predictor follows its feedback_fn_map. Writes
report.json in run.mjs's format. `log_dir` lets GEPA resume its search; the test
evaluation afterwards is not checkpointed. The API key is read from the environment and
never written.
"""
import argparse
import json
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from metric import metric  # noqa: E402  (also redirects checker chatter to stderr)

import dspy  # noqa: E402

# NLTK's lazy corpus loaders race under dspy's threaded evaluation
# ('WordListCorpusReader' has no attribute '_LazyCorpusLoader__args').
# All checker calls go through one lock; warmed up once before threads start.
_metric_lock = threading.Lock()


def checked(case_dict, response):
    with _metric_lock:
        return metric(case_dict, response)


try:
    from nltk.corpus import stopwords
    with _metric_lock:
        stopwords.words("english")
except Exception:
    pass

parser = argparse.ArgumentParser()
parser.add_argument("directory")
parser.add_argument("--seed", type=int, default=7919)
parser.add_argument("--budget", type=int, default=3593)
parser.add_argument("--threads", type=int, default=8)
parser.add_argument("--dry", action="store_true")
args = parser.parse_args()

env = os.environ
task_model = env["MUTARA_LLM_MODEL"]
reflect_model = env.get("MUTARA_REFLECT_MODEL") or task_model
temperature = float(env.get("MUTARA_LLM_TEMPERATURE", "0.6"))


def lm(model, temperature, max_tokens):
    # cache=False: every rollout is a paid call, as on the Mutara side.
    return dspy.LM(f"openai/{model}", api_base=env["MUTARA_LLM_BASE_URL"], api_key=env.get("MUTARA_LLM_API_KEY") or "none",
                   temperature=temperature, max_tokens=max_tokens, cache=False, num_retries=6)


dspy.configure(lm=lm(task_model, temperature, 4000))


class GenerateResponse(dspy.Signature):
    """Respond to the query"""

    query = dspy.InputField()
    response = dspy.OutputField()


class EnsureCorrectResponse(dspy.Signature):
    """Ensure the response is correct and adheres to the given constraints. Your response will be used as the final response."""

    query = dspy.InputField()
    response = dspy.InputField()
    final_response = dspy.OutputField()


class IFBenchCoT2StageProgram(dspy.Module):
    def __init__(self):
        super().__init__()
        self.generate_response_module = dspy.ChainOfThought(GenerateResponse)
        self.ensure_correct_response_module = dspy.ChainOfThought(EnsureCorrectResponse)

    def forward(self, prompt):
        response = self.generate_response_module(query=prompt).response
        final = self.ensure_correct_response_module(query=prompt, response=response)
        return dspy.Prediction(response=final.final_response)


def load(name):
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", f"{name}.jsonl")) as f:
        return [dspy.Example(**json.loads(line)).with_inputs("prompt") for line in f if line.strip()]


def case(example):
    return {"prompt": example.prompt, "instruction_id_list": example.instruction_id_list, "kwargs": example.kwargs}


def _predictor_text(outputs):
    # pred_trace[0][2] is a dspy Prediction in practice, a plain dict by type.
    # Support both: .get works on either (Prediction defines .get).
    try:
        text = outputs.get("final_response", None) or outputs.get("response", None)
    except Exception:
        text = getattr(outputs, "final_response", None) or getattr(outputs, "response", None)
    return text or ""


def gepa_metric(gold, pred, trace=None, pred_name=None, pred_trace=None):
    """Score of the whole program; feedback on the named predictor's own output (artifact feedback_fn_map)."""
    c = case(gold)
    score = checked(c, pred.response or "")["score"]
    text = pred.response or ""
    if pred_name and pred_trace:
        text = _predictor_text(pred_trace[0][2])
    return dspy.Prediction(score=score, feedback=checked(c, text)["feedback"])


def evaluate(program, examples):
    evaluator = dspy.Evaluate(devset=examples, metric=lambda gold, pred, trace=None: checked(case(gold), pred.response or "")["score"],
                              num_threads=args.threads, failure_score=0.0, display_progress=False)
    out = {}
    for example, _prediction, score in evaluator(program).results:
        out[example.id] = float(score.score if hasattr(score, "score") else score)
    return out


train, val, test = load("train"), load("val"), load("test")
os.makedirs(args.directory, exist_ok=True)
started = time.perf_counter()
initial = IFBenchCoT2StageProgram()
optimizer = dspy.GEPA(metric=gepa_metric, max_metric_calls=args.budget, reflection_minibatch_size=3,
                      candidate_selection_strategy="pareto", reflection_lm=lm(reflect_model, 1.0, 8000),
                      use_merge=True, max_merge_invocations=5, num_threads=args.threads, track_stats=True,
                      log_dir=os.path.join(args.directory, "gepa_logs"), seed=args.seed)
champion = optimizer.compile(initial, trainset=train, valset=val)
optimize_seconds = time.perf_counter() - started
scores = {"initial": evaluate(IFBenchCoT2StageProgram(), test), "champion": evaluate(champion, test)}
details = champion.detailed_results


def prompts(program):
    return {"generate": program.generate_response_module.predict.signature.instructions,
            "ensure": program.ensure_correct_response_module.predict.signature.instructions}


report = {
    "system": "gepa",
    "note": "Dry run with a stub model: wiring only, not a measurement." if args.dry else "Measured; see README for method and caveats.",
    "id": f"ifbench-gepa-{task_model}-s{args.seed}-b{args.budget}-v1",
    "taskModel": task_model, "reflectModel": reflect_model, "temperature": temperature, "seed": args.seed,
    "budget": {"metricCalls": args.budget}, "concurrency": args.threads,
    "initial": prompts(IFBenchCoT2StageProgram()),
    "champion": prompts(champion),
    "metricCalls": details.total_metric_calls,
    "candidates": len(details.candidates),
    "test": {side: {"mean": sum(s.values()) / len(s), "cases": len(s), "scores": s} for side, s in scores.items()},
    "wallSeconds": {"optimize": round(optimize_seconds), "total": round(time.perf_counter() - started)},
}
with open(os.path.join(args.directory, "report.json"), "w") as f:
    json.dump(report, f, indent=2)
    f.write("\n")
print(json.dumps({k: v for k, v in report.items() if k != "test"} | {"test": {s: report["test"][s]["mean"] for s in scores}}, indent=2),
      file=sys.stderr)
