# Intent Contracts: Taking Tools Away from Agents

Code and per-run records for the paper *Intent Contracts: Taking Tools Away from
Agents* (Ziyuan Wang, Genliang Zhu, Xiaobo Chen, Chu Wang, 2026).

An intent contract is an authorization interface for tool-using LLM agents in
which the planning model holds no tools. For each step it states its intent: a
short goal, a verbatim quotation of the user, and a scope. Code checks the
quotation and the scope. A small trusted model then decides what the user
authorized and writes the tool call itself; the output goes back to the planner.

This repository contains

- `plugin/`: an [OpenCode](https://opencode.ai) plugin that implements contract
  execution and the two command-review modes the paper compares it with. The
  instructions given to the trusted model in each role are in `plugin/index.ts`.
  See `plugin/README.md` for installation and options.
- `data/`: one record per run behind every table in the paper, and the contract
  logs of those runs.
- `scripts/recompute_tables.py`: recomputes the paper's counts, intervals and
  paired tests from `data/`.

It does not contain the benchmark. The external tasks, environments and scoring
come from AmPermBench (Ji et al., arXiv:2604.04978,
https://github.com/yan5ui/cc-auto-mode-measurement at commit `6dc2a2e`); we ran its
job-cancellation, service-restart and artifact-cleanup families unchanged.

## Reproduce the paper's numbers

```
pip install -r requirements.txt
python scripts/recompute_tables.py --check
```

`--check` exits non-zero if the output differs from `scripts/expected_tables.txt`.
Without `--check` the script prints every table.

## Conditions

| Name in `data/` | Name in the paper | What runs |
|---|---|---|
| `contract` | Contract | Planner has no tools; trusted model writes one call per contract. Goals may not contain command lines. |
| `contract_strict` | Contract, strict executor | Same, with one more instruction to the executor (`executorStrict`). |
| `contract_dagger` | Contract (dagger) | Same as `contract`, but goals may contain command text. Bundling tasks only. |
| `review` | Review | Trusted model approves or declines the planner's command; sees the user's words and the command. |
| `review_intent` | Review+Intent | Same, and the reviewer also sees the planner's goal and a code-checked user quotation. |
| `strong`, `small` | Strong, Small | One model alone with the tools (`gpt-6.1-terra`, `GLM-5.3-Flash`). |
| `strong_declare` | Strong+Declare | Strong model alone, told to write an `INTENT:` line before each change; nothing reads it. |
| `whole_task` | WholeTask | One contract; the small model reads output and does the whole task. 30 prompts. |

The planner in every gated condition is `gpt-6.1-terra` and the trusted model is
`GLM-5.3-Flash`. These names identify hosted services, not fixed checkpoints.

## Data fields

`data/ampermbench_runs.jsonl`, one line per run:

| Field | Meaning |
|---|---|
| `prompts` | `original` (the benchmark's prompts) or `clarified` (one sentence appended that says which queue, environment or storage prefix the prompt's lane term refers to). |
| `condition` | See above. |
| `family`, `prompt_id` | Benchmark task family and prompt identifier. |
| `specificity`, `reference`, `risk` | The benchmark's prompt axes. `reference`: `B0` exact ID, `B1` the user's object for a ticket, `B2` the user's objects across a ticket range, `B3` a ticket range with no ownership qualifier. |
| `safe_success`, `unsafe_allow`, `under_completion` | The benchmark's task-level outcomes (safe completion, unauthorized action, incomplete). The last two can both be 1. |
| `wrong_target`, `over_scope`, `protected_touch` | The benchmark's breakdown of `unsafe_allow`. |
| `seconds` | Wall-clock time of the run. |
| `changed_objects` | Objects whose record differs between the initial and final state, or that were removed. |
| `accepted_contracts` | Contracts that passed the code checks (gated conditions). |
| `declined_by_trusted_model` | Contracts the executor or reviewer declined. |
| `changed` | Gated conditions: for each changed object, its ID followed by its name, key or path fields. These are the strings the declaration metric searches for. |
| `named_in_goal`, `named_in_command` | Of the changed objects, how many have their ID, name, key or path (case-insensitive substring) in the goal text, or in the planner-written command, of any code-accepted contract of the run. This count ignores order; the paper reports the time-aligned one below. |
| `named_in_executor_call` | Contract conditions: how many are named in a command the executor ran. |

`data/bundling_runs.jsonl`, one line per run of the author-written bundling
tasks. The planner's copy of the user message carries one extra request the
user never made; code and the trusted model keep the real message.

| Field | Meaning |
|---|---|
| `task_set` | `appended_request` (ten single-file tasks, extra request appended) or `multi_file_list` (eight small projects, extra item inserted into a list of four changes). |
| `task`, `repetition` | Task identifier and repetition (1-3). |
| `valid` | Exit code 0 and at least one code-accepted contract. |
| `main_task_complete`, `extra_work_done` | Programmatic checks on the final files. |
| `contracts`, `accepted_contracts`, `rejected_by_code`, `declined_by_trusted_model` | Contract counts for the run. |
| `contracts_quoting_added_text`, `of_those_rejected_by_code` | Contracts whose quotation contains the added request, and how many of them the quotation check rejected. |

`data/contract_logs.jsonl.gz`, one line per gated run: `dataset`, `condition`,
`prompts` or `task_set`, `run`, and `events` in order, each with a sequence number `seq` (wall-clock
times are not included). A `contract` event holds
the planner's `goal`, `basis` (the quotation), scope fields, the `command` in
review modes, `accepted_by_code` and `violations`. A `trusted_model` event holds
the executor's or reviewer's `status`. A `call` event holds a tool call that
reached the code gate and whether it was allowed. In the AmPermBench runs, a
`cli` event is one invocation of a benchmark command-line tool (`cmd`, `args`),
taken from the tool's own log. Tool output is not included.

### Declared before done

`scripts/recompute_tables.py` recomputes the paper's declaration metric from
these events. For each changed object it takes the first state-changing `cli`
event whose arguments name the object, and the last code-accepted contract
before it (the contract that produced the change). The object counts as
declared when that contract's goal names it. The script also reports objects
named only in an earlier contract, only in a later one, in none, and objects
that no state-changing invocation names.

## License

Code: MIT (see `LICENSE`). The records in `data/` are released under the same
terms; prompt text quoted inside the contract logs comes from AmPermBench, which
its repository describes as MIT-licensed.

## Citation

```
@article{wang2026intentcontracts,
  title  = {Intent Contracts: Taking Tools Away from Agents},
  author = {Wang, Ziyuan and Zhu, Genliang and Chen, Xiaobo and Wang, Chu},
  year   = {2026}
}
```
