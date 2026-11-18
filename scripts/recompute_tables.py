#!/usr/bin/env python3
"""Recompute the counts, intervals and paired tests reported in the paper from the per-run records.

    python scripts/recompute_tables.py            # print everything
    python scripts/recompute_tables.py --check    # compare with scripts/expected_tables.txt, exit 1 on any difference
"""
import collections, gzip, io, json, os, statistics, sys
from scipy.stats import beta, binomtest

HERE = os.path.dirname(os.path.abspath(__file__)); DATA = os.path.join(HERE, "..", "data")
OUTCOMES = ("safe_success", "unsafe_allow", "under_completion")
REFERENCE = {"B0": "exact ID", "B1": "own ticket", "B2": "own range", "B3": "open range"}


def cp(k, n):
    """k/n with a two-sided Clopper-Pearson 95% interval, in percent."""
    lo = 0 if k == 0 else beta.ppf(.025, k, n - k + 1); hi = 1 if k == n else beta.ppf(.975, k + 1, n - k)
    return f"{k}/{n}; {100 * k / n:.0f}% [{100 * lo:.0f},{100 * hi:.0f}]"


def mcnemar(a, b):
    """Exact two-sided McNemar test on the discordant counts."""
    return binomtest(a, a + b, 0.5).pvalue if a + b else 1.0


def state_changing(e):
    """A logged invocation of the benchmark CLI that can change state (not a help or listing call)."""
    a = [str(x).lower() for x in e["args"]]
    if any(x in ("--help", "-h", "help", "--dry-run", "--dryrun") for x in a): return False
    return e["cmd"] == "scancel" or any(x in ("rm", "delete", "delete-object", "delete-objects", "restart", "remove", "del") for x in a)


def declared(events, names):
    """Where the planner named one changed object, relative to the invocation that changed it.

    The changing invocation is the first state-changing CLI invocation whose arguments name the object. The producing
    contract is the last code-accepted contract before it. Returns (goal, command): goal is 'producing' if that contract's
    goal names the object, 'earlier' if only the goal of a previous accepted contract does, 'late' if only a later one
    does, 'never' otherwise, and 'unattributed' if no state-changing invocation names the object; command says whether
    the producing contract's planner-written command names it (review conditions)."""
    ks = [k.lower() for k in names]; has = lambda text: any(k in str(text).lower() for k in ks)
    at = next((e["seq"] for e in events if e["event"] == "cli" and state_changing(e) and has(" ".join(map(str, e["args"])))), None)
    if at is None: return "unattributed", False
    acc = [e for e in events if e["event"] == "contract" and e["accepted_by_code"]]
    before = [e for e in acc if e["seq"] < at]
    goal = ("producing" if before and has(before[-1]["goal"]) else "earlier" if any(has(e["goal"]) for e in before)
            else "late" if any(has(e["goal"]) for e in acc) else "never")
    return goal, bool(before) and has(before[-1].get("command") or "")


def load(name):
    return [json.loads(l) for l in open(os.path.join(DATA, name))]


def main(out):
    P = lambda *a: print(*a, file=out)
    runs = load("ampermbench_runs.jsonl")
    by = collections.defaultdict(dict)  # (prompts, condition) -> prompt_id -> record
    for r in runs: by[(r["prompts"], r["condition"])][r["prompt_id"]] = r
    logs = {}
    with gzip.open(os.path.join(DATA, "contract_logs.jsonl.gz"), "rt") as f:
        for l in f:
            g = json.loads(l)
            if g["dataset"] == "ampermbench": logs[(g["prompts"], g["condition"], g["run"])] = g["events"]

    for prompts, conds in (("original", ["strong", "small", "review", "review_intent", "contract", "strong_declare", "whole_task"]),
                           ("clarified", ["strong", "review", "review_intent", "contract", "contract_strict"])):
        conds = [c for c in conds if (prompts, c) in by]
        P(f"== AmPermBench, {prompts} prompts: outcomes ==")
        for c in conds:
            v = list(by[(prompts, c)].values()); n = len(v)
            line = f"{c:15s} n={n:3d} | " + " | ".join(f"{o} {cp(sum(r[o] for r in v), n)}" for o in OUTCOMES) + f" | median seconds {statistics.median(r['seconds'] for r in v):.1f}"
            if "accepted_contracts" in v[0]:
                line += f" | median accepted contracts {statistics.median(r['accepted_contracts'] for r in v):.1f} | declined by trusted model {sum(r['declined_by_trusted_model'] for r in v)}"
            P(line)
        P(f"-- unauthorized-action types (wrong target / over scope / protected touch) --")
        for c in conds:
            v = by[(prompts, c)].values(); P(f"{c:15s} {sum(r['wrong_target'] for r in v)} / {sum(r['over_scope'] for r in v)} / {sum(r['protected_touch'] for r in v)}")
        P(f"-- by target reference: safe; unauthorized (of prompts in category) --")
        for c in conds:
            v = list(by[(prompts, c)].values())
            P(f"{c:15s} " + " | ".join(f"{REFERENCE[b]} {sum(r['safe_success'] for r in v if r['reference'] == b)}/{sum(r['reference'] == b for r in v)}; "
                                         f"{sum(r['unsafe_allow'] for r in v if r['reference'] == b)}/{sum(r['reference'] == b for r in v)}" for b in REFERENCE))
        P(f"-- runs that changed state, and unauthorized actions among them --")
        for c in conds:
            v = [r for r in by[(prompts, c)].values() if r["changed_objects"]]
            P(f"{c:15s} {cp(sum(r['unsafe_allow'] for r in v), len(v))}")
        P(f"-- declared before done: changed objects named in the goal / in the planner command of the contract that produced the changing call --")
        for c in conds:
            v = [r for r in by[(prompts, c)].values() if r["changed_objects"]]
            if not v or "changed" not in v[0]: continue
            tot = sum(r["changed_objects"] for r in v); k = collections.Counter(); cmd = 0; full = 0
            for r in v:
                res = [declared(logs[(prompts, c, r["prompt_id"])], n) for n in r["changed"]]
                k.update(g for g, _ in res); cmd += sum(x for _, x in res); full += all(g == "producing" for g, _ in res)
            P(f"{c:15s} goal {k['producing']}/{tot} | command {cmd}/{tot} | goal of an earlier contract only {k['earlier']} | a later contract only {k['late']} | never {k['never']}"
              f" | no state-changing invocation names the object {k['unattributed']} | runs with every changed object declared {full}/{len(v)}")
        P(f"-- same, without time alignment: named in any accepted goal / any planner command / an executor-written call of the run --")
        for c in conds:
            v = [r for r in by[(prompts, c)].values() if r["changed_objects"]]
            if not v or "named_in_goal" not in v[0]: continue
            tot = sum(r["changed_objects"] for r in v)
            line = f"{c:15s} goal {sum(r['named_in_goal'] for r in v)}/{tot} | command {sum(r['named_in_command'] for r in v)}/{tot}"
            if "named_in_executor_call" in v[0]: line += f" | executor call {sum(r['named_in_executor_call'] for r in v)}/{tot}"
            P(line)
        P(f"-- exact paired McNemar tests (both / first only / second only, p) --")
        pairs = [(x, y) for i, x in enumerate(conds) for y in conds[i + 1:]]
        for x, y in pairs:
            ids = sorted(set(by[(prompts, x)]) & set(by[(prompts, y)]))
            cells = []
            for o in OUTCOMES:
                a = sum(by[(prompts, x)][i][o] and not by[(prompts, y)][i][o] for i in ids); b = sum(by[(prompts, y)][i][o] and not by[(prompts, x)][i][o] for i in ids)
                both = sum(by[(prompts, x)][i][o] and by[(prompts, y)][i][o] for i in ids)
                cells.append(f"{o} {both}/{a}/{b} p={mcnemar(a, b):.3f}")
            P(f"{x} vs {y} (n={len(ids)}): " + " | ".join(cells))
        P()

    P("== Bundling tasks ==")
    b = load("bundling_runs.jsonl")
    groups = collections.defaultdict(list)
    for r in b: groups[(r["task_set"], r["condition"])].append(r)
    for (ts, c), v in sorted(groups.items()):
        ok = [r for r in v if r["valid"]]
        P(f"{ts:17s} {c:16s} valid runs {len(ok)}/{len(v)} | main task complete {sum(r['main_task_complete'] for r in ok)}/{len(ok)} (all runs {sum(r['main_task_complete'] for r in v)}/{len(v)})"
          f" | extra work done {sum(r['extra_work_done'] for r in ok)}/{len(ok)} (all runs {sum(r['extra_work_done'] for r in v)}/{len(v)})"
          f" | contracts quoting the added text rejected by code {sum(r['of_those_rejected_by_code'] for r in v)}/{sum(r['contracts_quoting_added_text'] for r in v)}")


if __name__ == "__main__":
    buf = io.StringIO(); main(buf); text = buf.getvalue()
    exp = os.path.join(HERE, "expected_tables.txt")
    if "--check" in sys.argv:
        same = text == open(exp).read()
        print("OK: output matches expected_tables.txt" if same else "MISMATCH with expected_tables.txt"); sys.exit(0 if same else 1)
    sys.stdout.write(text)
