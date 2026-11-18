// Intent contract: pure-code checks (zero model calls).
// TypeScript port of release/src/{basis_checker,contract,scope_gate}.py, with the
// egress extraction generalised beyond the paper's sandbox host names.

import fs from "node:fs"
import path from "node:path"

export const MIN_BASIS_CHARS = 24
// The paper used 60. 100 leaves room to name exact files and text when the executor cannot look first.
export const DEFAULT_GOAL_WORD_LIMIT = 100
export const ERROR_HANDLING = ["return_error", "retry_once", "abort"] as const
export type ErrorHandling = (typeof ERROR_HANDLING)[number]

export type Contract = {
  goal: string
  basis: string
  allowed_egress: string[]
  allowed_write_prefixes: string[]
  error_handling: string
}

export type Baseline = {
  /** External hosts the project may ever need. The contract may only narrow this. */
  allowedEgress: string[]
  /** Absolute directories the executor may ever write to. */
  writePrefixes: string[]
  goalWordLimit: number
}

// ---- basis: verbatim quotation of the user ---------------------------------

export function normalize(text: string): string {
  return text.normalize("NFKC").split(/\s+/).filter(Boolean).join(" ")
}

export function checkBasis(basis: string, userMessages: string[]) {
  const nb = normalize(basis)
  if (nb.length < MIN_BASIS_CHARS) return { pass: false, reason: "below_min_chars", matched: -1 }
  for (let i = 0; i < userMessages.length; i++) {
    if (normalize(userMessages[i]).includes(nb)) return { pass: true, reason: "verbatim_substring", matched: i }
  }
  return { pass: false, reason: "not_a_substring", matched: -1 }
}

// ---- paths -----------------------------------------------------------------

/** Resolve symlinks on the nearest existing ancestor so a link cannot step outside a prefix. */
export function realish(p: string): string {
  let cur = path.resolve(p)
  const tail: string[] = []
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail)
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return path.resolve(p)
      tail.unshift(path.basename(cur))
      cur = parent
    }
  }
}

export function within(target: string, prefix: string): boolean {
  const rel = path.relative(realish(prefix), realish(target))
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

export function resolvePrefixes(prefixes: string[], directory: string): string[] {
  return prefixes.map((p) => path.resolve(directory, p))
}

// ---- contract validation ---------------------------------------------------

export const IN_BOUNDARY = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"])

const normHost = (h: string) => h.trim().toLowerCase().replace(/\.$/, "")

export function validateContract(c: Contract, userMessages: string[], base: Baseline, directory: string): string[] {
  const v: string[] = []
  const words = c.goal.split(/\s+/).filter(Boolean).length
  if (words === 0) v.push("goal is empty")
  if (words > base.goalWordLimit) v.push(`goal exceeds ${base.goalWordLimit} words (has ${words})`)

  const b = checkBasis(c.basis, userMessages)
  if (!b.pass)
    v.push(
      b.reason === "below_min_chars"
        ? `basis shorter than ${MIN_BASIS_CHARS} characters`
        : "basis is not a verbatim quote of any user message",
    )

  if (!(ERROR_HANDLING as readonly string[]).includes(c.error_handling))
    v.push(`error_handling not in enum ${JSON.stringify(ERROR_HANDLING)}`)

  const baseHosts = new Set(base.allowedEgress.map(normHost))
  const widened = c.allowed_egress.map(normHost).filter((h) => !IN_BOUNDARY.has(h) && !baseHosts.has(h))
  if (widened.length) v.push(`declared egress widens the baseline (hosts not in baseline: ${widened.join(", ")})`)

  for (const p of c.allowed_write_prefixes) {
    const abs = path.resolve(directory, p)
    if (!base.writePrefixes.some((bp) => within(abs, bp))) v.push(`write prefix ${JSON.stringify(p)} is outside the baseline`)
  }
  return v
}

// ---- per-action gate (executor side) ---------------------------------------

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@'"]*@)?(\[[0-9a-fA-F:]+\]|[A-Za-z0-9._-]+)/gi
const USER_AT_RE = /[A-Za-z0-9._-]+@([A-Za-z0-9][A-Za-z0-9._-]*)(?=[:\s]|$)/g
const HOSTPORT_RE = /(?<![\w./-])([A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*):(\d{2,5})\b/g
const IPV4_RE = /(?<![\w.])(\d{1,3}(?:\.\d{1,3}){3})(?![\w.])/g
const NET_CLIENT_RE = /(?:^|[\s;&|(`])(curl|wget|nc|ncat|netcat|ssh|scp|sftp|ftp|telnet|rsync|ping|dig|nslookup|socat|http|https)(?=\s)/
const BARE_HOST_RE = /^([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.([A-Za-z]{2,}))(?:[:/].*)?$/
const FILE_EXT = new Set(
  "txt json md sh py js ts tsx jsx log html htm css tar gz tgz zip yaml yml toml csv tsv xml pem key crt conf cfg ini out tmp bak lock sql db bin pdf png jpg svg rs go java c h cpp".split(" "),
)

/** Every host a shell command text mentions. A heuristic over text, not network isolation. */
export function extractHosts(command: string): string[] {
  const hosts = new Set<string>()
  for (const m of command.matchAll(URL_RE)) hosts.add(normHost(m[1]))
  for (const m of command.matchAll(USER_AT_RE)) hosts.add(normHost(m[1]))
  for (const m of command.matchAll(HOSTPORT_RE)) hosts.add(normHost(m[1]))
  for (const m of command.matchAll(IPV4_RE)) hosts.add(m[1])
  if (NET_CLIENT_RE.test(command)) {
    for (const tok of command.split(/[\s;&|()<>`'"=]+/)) {
      const m = BARE_HOST_RE.exec(tok)
      if (m && !FILE_EXT.has(m[2].toLowerCase())) hosts.add(normHost(m[1]))
    }
  }
  return [...hosts]
}

export type Gate = { allow: true } | { allow: false; reason: string }

export function checkEgress(text: string, allowedEgress: string[]): Gate {
  const allowed = new Set(allowedEgress.map(normHost))
  const external = extractHosts(text).filter((h) => !IN_BOUNDARY.has(h) && !allowed.has(h))
  return external.length
    ? { allow: false, reason: `egress to host(s) outside the contract: ${external.join(", ")}` }
    : { allow: true }
}

export function checkWrite(filePath: string, c: Contract, directory: string): Gate {
  const abs = path.resolve(directory, filePath)
  // The plugin's own baseline and audit log live here; never writable through the file tools.
  if (within(abs, path.join(directory, ".opencode")))
    return { allow: false, reason: `write to ${filePath} denied: .opencode/ is reserved` }
  const ok = resolvePrefixes(c.allowed_write_prefixes, directory).some((p) => within(abs, p))
  return ok ? { allow: true } : { allow: false, reason: `write to ${filePath} is outside the contract's write prefixes` }
}

const PATCH_FILE_RE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm
const READ_ONLY = new Set(["read", "grep", "glob", "list", "todowrite", "todoread"])
const WRITE_TOOLS = new Set(["write", "edit", "multiedit"])

/** Gate one executor tool call. Unknown tools are denied (fail closed). */
export function gateToolCall(tool: string, args: any, c: Contract, directory: string, extraTools: string[] = []): Gate {
  if (READ_ONLY.has(tool) || extraTools.includes(tool)) return { allow: true }
  if (tool === "bash") return checkEgress(String(args?.command ?? ""), c.allowed_egress)
  if (tool === "webfetch") return checkEgress(String(args?.url ?? ""), c.allowed_egress)
  if (WRITE_TOOLS.has(tool)) {
    const fp = args?.filePath ?? args?.file_path
    if (typeof fp !== "string" || !fp) return { allow: false, reason: `${tool}: no file path` }
    return checkWrite(fp, c, directory)
  }
  if (tool === "patch" || tool === "apply_patch") {
    const text = String(args?.patchText ?? args?.patch ?? "")
    const files = [...text.matchAll(PATCH_FILE_RE)].map((m) => m[1].trim())
    if (!files.length) return { allow: false, reason: `${tool}: no file paths found in patch` }
    for (const f of files) {
      const g = checkWrite(f, c, directory)
      if (!g.allow) return g
    }
    return { allow: true }
  }
  return { allow: false, reason: `tool ${tool} is not available to the executor` }
}

// ---- blind executor: withhold tool output from the executor ----------------

export type ToolRecord = { tool: string; args: unknown; output: string; exit?: number }

/** What the executor sees instead of a tool result. Built by code from size and exit status only. */
export function receipt(output: string, exit?: number): string {
  const bytes = Buffer.byteLength(output, "utf8")
  return `[output withheld from the executor: ${bytes} bytes${typeof exit === "number" ? `, exit code ${exit}` : ""}]`
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}\n[... ${s.length - n} more characters truncated]`)

/** Raw tool outputs handed back to the planner. The planner is the only model that reads them. */
export function outputsForPlanner(calls: ToolRecord[], perCall: number, total: number): string {
  if (!calls.length) return "(the executor made no tool calls)"
  let left = total
  const out: string[] = []
  calls.forEach((c, i) => {
    const args = clip(JSON.stringify(c.args ?? {}), 400)
    const head = `### call ${i + 1}: ${c.tool} ${args}${typeof c.exit === "number" ? ` (exit ${c.exit})` : ""}`
    if (left <= 0) return out.push(`${head}\n[output omitted: total budget used]`)
    const body = clip(c.output, Math.min(perCall, left))
    left -= body.length
    out.push(`${head}\n${body}`)
  })
  return out.join("\n\n")
}

// ---- goal text: does it dictate a literal command? --------------------------

const SHELL_WORDS = "bash|sh|zsh|python3?|node|perl|ruby|cat|sed|awk|grep|rg|find|xargs|curl|wget|git|rm|mv|cp|chmod|chown|tee|echo|printf|tar|ssh|scp|nc|pip3?|npm|npx|make|docker|kubectl|dd|ln|touch|mkdir|head|tail|wc|sort|base64|openssl|aws|gcloud|az|helm|terraform|psql|mysql|systemctl|service|kill|squeue|scancel|scontrol|sbatch"
const SHELL_SYNTAX_RE = /\$\(|&&|\|\||(?:^|\s)\|(?:\s|$)|\s>>?\s|<<\s*['"]?[A-Z_]+|\s2>&1/
// a backtick span that starts with a path to an executable (./bin/x, /usr/bin/x) and has arguments
const PATH_CMD_RE = /`\s*(?:sudo\s+)?\.{0,2}\/[\w./-]+\s+[^`]+`/

/**
 * Heuristic: true when the goal spells out a shell command instead of describing an outcome.
 * A lone tool name in backticks (`scancel`) or a quoted file name is fine; a command with arguments is not.
 * Easy to evade; meant to keep an honest planner at the level of intent, not as a boundary.
 */
export function goalDictatesCommand(goal: string, extraWords: string[] = []): boolean {
  const words = [SHELL_WORDS, ...extraWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))].join("|")
  const backtick = new RegExp("`\\s*(?:sudo\\s+)?(?:" + words + ")\\s+[^`]+`")
  return backtick.test(goal) || PATH_CMD_RE.test(goal) || SHELL_SYNTAX_RE.test(goal)
}
