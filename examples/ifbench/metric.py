"""IFBench constraint scoring, shared by the Mutara scorer and the GEPA baseline.

`metric` is GEPA's `metric_with_feedback` (gepa-ai/gepa-artifact,
gepa_artifact/benchmarks/IFBench/ifbench_metric.py) without the dspy wrapper: the
fraction of constraints followed, loose IFEval matching (strip first/last line and
asterisks), and feedback text listing followed and violated constraints. The
checkers are allenai's official ones, fetched into data/utils_ifbench by fetch.mjs.

`python metric.py --serve` answers JSON lines on stdin: {"case": row, "response": text}
-> {"score", "feedback", "followed"}. Checker downloads print to stdout, so the
protocol writes to the original stdout and everything else goes to stderr.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))

_protocol = sys.stdout
sys.stdout = sys.stderr

import nltk  # noqa: E402
import spacy.cli  # noqa: E402

# instructions.py calls spacy.cli.download("en_core_web_sm") on import, which shells out to
# pip; the model is installed as a pinned wheel instead. nltk data is fetched once here,
# then the per-check nltk.download calls become no-ops (they would hit the network each time).
spacy.cli.download = lambda *args, **kwargs: None
for package in ("punkt", "punkt_tab", "averaged_perceptron_tagger_eng", "stopwords"):
    nltk.download(package, quiet=True)
nltk.download = lambda *args, **kwargs: True

from utils_ifbench import instructions_registry  # noqa: E402


def metric(case, response):
    r = response.split("\n")
    response_remove_first = "\n".join(r[1:]).strip()
    response_remove_last = "\n".join(r[:-1]).strip()
    response_remove_both = "\n".join(r[1:-1]).strip()
    all_responses = [
        response,
        response.replace("*", ""),
        response_remove_first,
        response_remove_last,
        response_remove_both,
        response_remove_first.replace("*", ""),
        response_remove_last.replace("*", ""),
        response_remove_both.replace("*", ""),
    ]
    followed, correct, incorrect = [], [], []
    for index, instruction_id in enumerate(case["instruction_id_list"]):
        instruction = instructions_registry.INSTRUCTION_DICT[instruction_id](instruction_id)
        kwargs = {k: v for k, v in (case["kwargs"][index] or {}).items() if v is not None}
        text = instruction.build_description(**kwargs)
        args = instruction.get_instruction_args()
        if args and "prompt" in args:
            text = instruction.build_description(prompt=case["prompt"])
        ok = any(candidate.strip() and instruction.check_following(candidate) for candidate in all_responses)
        (correct if ok else incorrect).append(text)
        followed.append(ok)
    feedback = ""
    if correct:
        feedback = "Your response correctly followed the following instructions:\n" + "\n".join(correct)
    if incorrect:
        head = "However, your response did not follow" if correct else "Your response did not follow"
        feedback += "\n" + head + " the following instructions properly:\n" + "\n".join(incorrect)
    return {"score": sum(followed) / len(followed), "feedback": feedback.strip(), "followed": followed}


if __name__ == "__main__" and "--serve" in sys.argv:
    for line in sys.stdin:
        request = json.loads(line)
        try:
            reply = metric(request["case"], request["response"])
        except Exception as error:  # a checker crash is a scorer bug, not a zero score
            reply = {"error": f"{type(error).__name__}: {error}"}
        _protocol.write(json.dumps(reply) + "\n")
        _protocol.flush()
