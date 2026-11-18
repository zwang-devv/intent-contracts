# opencode-intent-contract

An [opencode](https://opencode.ai) plugin that implements the interface from
*Intent Contracts: Taking Tools Away from Agents*, together with the two
command-review modes the paper compares it with.

The model you talk to (the planner) has no tools. To get anything done it fills
an intent contract. Code checks the contract against your own messages; a
separate executor model, in its own session, then writes and runs every tool
call, and each of those calls passes a code gate first.

Written for the opencode 1.x plugin API (`@opencode-ai/plugin`), tested on
1.19.5. opencode 2 uses a different plugin API
(`@opencode/plugin`); this plugin has not been ported to it.

## What it adds

| Piece | What it does |
|---|---|
| Agent `contract-planner` (primary) | Every permission denied except the `intent_contract` tool. |
| Tool `intent_contract` | Fields: `goal`, `basis`, `allowed_egress`, `allowed_write_prefixes`, `error_handling`. Validates, starts the executor, returns its report. |
| Agent `contract-executor` (hidden subagent) | Receives your original messages and the contract, nothing else from the planner. Decides for itself whether you authorized the goal. |
| `tool.execute.before` hook | Gates every executor tool call; refuses any other tool call in a planner session. |
| Audit log | One JSON line per contract, gate decision and executor report, in `.opencode/intent-contract-audit.jsonl`. |

Checks done by code, with no model call:

- `basis` must be a verbatim substring of one of your messages (NFKC and
  whitespace folded, case kept, at least 24 characters). Text that opencode
  itself inserted into a user turn (attachments, compaction) does not count.
- `goal` is at most 100 words (configurable) and, by default, may not contain
  a command line (a heuristic check).
- `allowed_egress` must be a subset of the project baseline. The default
  baseline is empty, so a contract that declares any external host is rejected.
- `allowed_write_prefixes` must lie inside the baseline (default: the project
  directory). `[]` makes the contract read-only.
- `error_handling` is one of `return_error`, `retry_once`, `abort`.
- During execution: `bash` and `webfetch` are refused if the command or URL
  names a host outside the contract; `write`, `edit`, `multiedit` and
  `apply_patch` are refused outside the declared prefixes and always under
  `.opencode/`; `task`, `websearch` and any tool not on the allowlist are
  refused.

## Install

```
cd plugin && npm install
```

Then in the project's `opencode.jsonc` (or the global one):

```jsonc
{
  "plugin": [
    ["/absolute/path/to/intent-contracts/plugin", {
      "plannerModel": "openai/gpt-6.1-terra",              // optional
      "executorModel": "openrouter/z-ai/glm-5.3-flash"     // optional
    }]
  ]
}
```

Start a session with the planner: `opencode --agent contract-planner`, or pick
`contract-planner` with Tab in the TUI, or
`opencode run --agent contract-planner "..."`.

The intended split is a stronger planner and a smaller model you trust as the
executor (for example one served locally). Any two models opencode can reach
will work.

## The three modes in the paper

| Paper name | Options | What the trusted model does |
|---|---|---|
| Contract execution | defaults | Sees the user's messages and the contract (goal, quotation, scope). Writes one tool call per contract; sees only a receipt. |
| Intent-visible review | `"mode": "review"` | Sees the user's messages, the goal and quotation, and the planner's exact shell command. Approves or declines the whole command. |
| Blind review | `"mode": "review", "reviewShowsIntent": false` | Sees the user's messages and the command only, as a reasoning-blind permission classifier does. |

The whole-task ablation is `"executorReadsOutput": true`; the command-tolerant
contract variant is `"rejectCommandsInGoal": false`. The benchmark runs in the
paper also set `"egressGate": false` (see Limits).

## Options

Set in the plugin entry above, or in `.opencode/intent-contract.json` in the
project (the file wins). Both are read once at startup.

| Option | Default | Meaning |
|---|---|---|
| `plannerModel`, `executorModel` | session default | `provider/model`. |
| `allowedEgress` | `[]` | Baseline: hosts a contract may declare. |
| `writePrefixes` | `["."]` | Baseline: directories a contract may declare. |
| `goalWordLimit` | `100` | Maximum words in a goal. |
| `executorExtraTools` | `[]` | Extra tool names (e.g. MCP tools) the executor may call ungated. |
| `auditLog` | `.opencode/intent-contract-audit.jsonl` | Path, or `false` to disable. |
| `executorReadsOutput` | `false` | By default the executor is blind: one tool call per contract, each result replaced by a receipt (size, exit code), raw output returned to the planner. `true` makes it a full agent that reads output and takes many steps per contract (the earlier design, kept for comparison). |
| `outputCharsPerCall`, `outputCharsTotal` | `4000`, `16000` | Blind mode: how much raw output the planner gets back per call and per contract. |
| `executorMaxCalls` | `30` (`1` when blind) | Tool calls allowed per contract. |
| `executorSteps` | unlimited (`2` when blind) | Model steps per contract: one for the tool call, one for the report. |
| `egressGate` | `true` | `false` turns off the text-pattern egress check on shell commands and URLs. The check flags anything shaped like a host, including internal names such as `s3://bucket`. |
| `executorHistory` | `none` | What the trusted model may see of earlier contracts in the task (goal, quotation, its decision, calls and exit codes; never tool output): `none`, `tool` (it can look them up with `contract_history`), or `inline`. |
| `mode` | `execute` | `review`: the planner writes the exact shell command, the trusted model has no tools and only approves or declines, code runs an approved command. A classifier-style gate, kept as a comparison arm. |
| `rejectCommandsInGoal` | `true` | A goal must state intent (which objects, what change, why the user's words cover it), not a command line; goals that spell out a command are rejected by code and the planner is told so. Heuristic, easy to evade. `false` allows commands in the goal. `goalCommandWords` adds project-specific command names. |
| `executorStrict` | `false` | Execute mode: adds one instruction to the executor, to decline when the user's messages do not show that the user asked for this change to these objects. |
| `reviewShowsIntent` | `true` | Review mode: `false` hides the planner's goal and quotation from the reviewer, which then sees only the user's messages, the earlier commands and the proposed command (a reasoning-blind classifier). |
| `maxConsecutiveRefusals` | `3` | Contracts rejected or declined in a row before the planner is told to stop and ask the user. Resets on the next user message. |

Contracts are carried out one at a time, in the order they are submitted, even if the planner submits several at once.

## Blind executor

With `executorReadsOutput: false` the model that holds the tools never reads
tool output, so text planted in a file, a web page or a command result cannot
reach it. The planner reads the output instead; it has no tools and can only
submit another contract, which goes through the same code checks and the same
executor. Two things this does not solve: project content now flows to the
planner model, and planted text can still talk the planner into putting a wrong
value (a file name, a recipient) into an otherwise valid contract.

It costs round trips: the planner has to ask for each read and each change
separately, and it has to spell out exact text because the executor cannot look
first.

## Limits

- The egress gate is a pattern match over command text, a
  backstop. It is not network isolation: it
  does not see hosts built at run time, DNS tricks, or package managers that
  contact a registry without naming it. It also blocks some harmless text
  (anything shaped like `user@host` or `name:port`). Use a sandbox or firewall
  if you need a real boundary.
- Write prefixes are enforced on the file tools only. A shell command can
  still write anywhere the process can.
- Other agents (`build`, `plan`) can see the `intent_contract` tool; calling it
  from them returns a refusal.
- The executor's edit, bash and webfetch permissions are set to `allow`, since
  a permission prompt inside the planner's tool call would stall it. The gate
  above is what restricts it.
- The planner sees nothing of the project except what the executor reports, so
  tasks take more round trips than with a normal agent.

## Tests

```
npm test    # pure-code checks, needs Node 22+
```
