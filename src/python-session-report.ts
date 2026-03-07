import { Database } from "bun:sqlite"
import { createHash } from "crypto"
import { spawn } from "child_process"
import { mkdir } from "fs/promises"
import os from "os"
import path from "path"
import * as rl from "readline"
import { fileURLToPath } from "url"
import { analyze } from "./python/python-analyze"

type ReviewDecision = "read" | "write" | "emit" | "exec" | "ignore" | "needs-code"

type Opts = {
  db: string
  since?: number
  json: boolean
  samples: number
  rules: string
  scoreCache: string
  update: boolean
  promoteReviewed: boolean
  ledger: string
  reviewJson: boolean
  reviewNext: boolean
  reviewTui: boolean
  includePure: boolean
  decide?: string
  recordDecision?: string
  help: boolean
}

type Row = {
  part_id: string
  message_id: string
  session_id: string
  time_created: number
  time_updated: number
  data: string
  title: string
}

type Tool = {
  type?: string
  tool?: string
  state?: {
    input?: Record<string, unknown>
  }
}

type Sample = {
  sessionID: string
  messageID: string
  partID: string
  title: string
  time: string
  preview: string
}

type Occurrence = Sample & {
  kind: "unknown" | "emit" | "pure"
  call: string
  fingerprint: string
  snippetFingerprint: string
  code: string
  readConfidence: number
  writeConfidence: number
  reasons: string[]
  scoreSource: string
}

type Seen = {
  id: string
  title: string
  time: string
}

type Hit = {
  call: string
  count: number
  last: number
  seen: Map<string, Seen>
  samples: Sample[]
}

export type Report = {
  generatedAt: string
  db: string
  filters: {
    since?: string
    samples: number
  }
  totals: {
    sessions: number
    toolParts: number
    inlineSnippets: number
    unknownEvents: number
    uniqueUnknownCalls: number
    skippedRows: number
  }
  unknown: Array<{
    call: string
    count: number
    lastSeen: string
    sessions: Seen[]
    samples: Sample[]
  }>
  occurrences: Occurrence[]
}

type Candidate = {
  call: string
  count: number
  lastSeen: string
  examples: string[]
}

type ReviewDecisionRecord = {
  fingerprint: string
  call?: string
  decision: ReviewDecision
  decidedAt: string
}

type ReviewLedger = {
  version: number
  decisions: ReviewDecisionRecord[]
}

export type ReviewQueue = {
  generatedAt: string
  db: string
  ledger: string
  filters: {
    since?: string
    samples: number
  }
  totals: {
    snippets: number
    pendingCandidates: number
    decidedCandidates: number
  }
  snippets: Array<{
    snippetFingerprint: string
    code: string
    preview: string
    lastSeen: string
    occurrences: Sample[]
    candidates: Array<{
      kind: Occurrence["kind"]
      call: string
      fingerprint: string
      readConfidence: number
      writeConfidence: number
      reasons: string[]
      scoreSource: string
      decision?: ReviewDecision
    }>
  }>
}

export type ReviewSnippet = ReviewQueue["snippets"][number]

type ReviewItem = {
  snippet: ReviewSnippet
  candidate: ReviewSnippet["candidates"][number]
  snippetIndex: number
  snippetCount: number
  candidateIndex: number
  candidateCount: number
  pendingCount: number
}

type ReviewKey = "y" | "n" | "r" | "w" | "e" | "x" | "i" | "c" | "s" | "v" | "?" | "q"

type ReviewAction =
  | { type: "decide"; decision: ReviewDecision }
  | { type: "skip" }
  | { type: "toggle" }
  | { type: "help" }
  | { type: "quit" }

type PromotionBucket = "read" | "write" | "emit" | "exec"

export type PromotionPlan = {
  generatedAt: string
  db: string
  ledger: string
  rules: string
  promotable: Record<PromotionBucket, string[]>
  blocked: Array<{
    call: string
    reason: string
    decisions: ReviewDecision[]
    pendingContexts: number
  }>
}

type RulesDoc = {
  calls?: {
    read?: string[]
    write?: string[]
    emit?: string[]
    exec?: string[]
    [key: string]: unknown
  }
  candidates?: {
    unknown?: Candidate[]
    [key: string]: unknown
  }
  [key: string]: unknown
}

type ScoreRow = {
  fingerprint: string
  call: string
  readConfidence: number
  writeConfidence: number
  reasons: string[]
  scoreSource: string
}

type ScoreEntry = {
  key: string
  createdAt: string
  scores: ScoreRow[]
}

type ScoreDoc = {
  version: number
  entries: ScoreEntry[]
}

const REVIEW_LEDGER_VERSION = 1
const REVIEW_DECISIONS = ["read", "write", "emit", "exec", "ignore", "needs-code"] as const
const SCORE_CACHE_VERSION = 1
const SCORE_PROMPT_VERSION = 1
const SCORE_TIMEOUT = 30000

function usage() {
  return [
    "Usage: bun src/python-session-report.ts [options]",
    "",
    "Options:",
    "  --db <path>      Override OpenCode session database path",
    "  --ledger <path>  Override review-ledger JSON path",
    "  --rules <path>   Override python rules JSON path",
    "  --score-cache <path>  Override review score-cache JSON path",
    "  --since <iso>    Only scan rows updated at or after this ISO timestamp",
    "  --samples <n>    Sample sessions/previews per unknown callable (default: 3)",
    "  --include-pure  Include pure analyzer events in review queues",
    "  --update-candidates  Write findings into candidates.unknown",
    "  --promote-reviewed  Promote consistently reviewed callables into calls.read/write/emit/exec",
    "  --review-json    Emit snippet-centric review queue JSON",
    "  --review-next    Show the next pending snippet review item",
    "  --review-tui     Launch one-key interactive review UI",
    "  --decide <spec>  Apply decisions like 1=read,2=write or fp=ignore",
    "  --record-decision <fp=decision>  Upsert a ledger decision",
    "  --json           Emit JSON instead of text",
    "  --help           Show this message",
  ].join("\n")
}

function fail(msg: string): never {
  throw new Error(msg)
}

function defdb() {
  const root = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share")
  return path.join(root, "opencode", "opencode.db")
}

function defrules() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "python", "python-rules.json")
}

function defledger() {
  const root = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state")
  return path.join(root, "opencode", "python-session-review.json")
}

function defscorecache() {
  const root = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state")
  return path.join(root, "opencode", "python-session-score-cache.json")
}

function clamp(value: number) {
  return Math.max(0, Math.min(0.99, Math.round(value * 100) / 100))
}

function normalized(code: string) {
  return code.replace(/\r\n/g, "\n").trim()
}

function fingerprint(text: string) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

function tail(call: string) {
  const parts = call.split(".")
  return parts[parts.length - 1] ?? call
}

function isDecision(input: string): input is ReviewDecision {
  return REVIEW_DECISIONS.includes(input as ReviewDecision)
}

function score(call: string, code: string) {
  const lowCall = call.toLowerCase()
  const lowTail = tail(call).toLowerCase()
  const lowCode = code.toLowerCase()
  let read = 0.1
  let write = 0.1
  const reasons: string[] = []

  const add = (kind: "read" | "write", amount: number, reason: string) => {
    if (kind === "read") read += amount
    else write += amount
    if (!reasons.includes(reason) && reasons.length < 3) reasons.push(reason)
  }

  for (const hint of ["read", "load", "fetch", "get", "list", "query", "scan", "download"]) {
    if (lowTail.includes(hint)) add("read", hint === "get" ? 0.2 : 0.45, `call name suggests ${hint}`)
  }
  for (const hint of ["write", "save", "dump", "append", "create", "update", "delete", "remove", "unlink", "touch", "mkdir", "rename", "replace", "move", "copy", "upload", "put", "post", "patch"]) {
    if (lowTail.includes(hint)) add("write", ["put", "post", "patch"].includes(hint) ? 0.2 : 0.45, `call name suggests ${hint}`)
  }
  if (/open\s*\([^\n]*['"]r[a-z+]*['"]/.test(lowCode)) add("read", 0.2, "snippet opens a file in read mode")
  if (/open\s*\([^\n]*['"][wax+][a-z+]*['"]/.test(lowCode)) add("write", 0.2, "snippet opens a file in write mode")
  if (/\b(path|file|src|input)\b/.test(lowCode)) add("read", 0.1, "snippet references input-like names")
  if (/\b(dst|output|target)\b/.test(lowCode) || /\b(write|save|dump|append)\b/.test(lowCode)) {
    add("write", 0.1, "snippet references output-like names")
  }

  return {
    readConfidence: clamp(read),
    writeConfidence: clamp(write),
    reasons,
  }
}

type Runner = (prompt: string) => Promise<string>

function root() {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)))
}

function scorekey(item: ReviewSnippet) {
  return fingerprint(
    JSON.stringify({
      v: SCORE_PROMPT_VERSION,
      s: item.snippetFingerprint,
      c: item.candidates.map((item) => item.fingerprint).sort(),
    }),
  )
}

function scoreprompt(item: ReviewSnippet) {
  const body = item.candidates
    .map((item) => [`- fingerprint: ${item.fingerprint}`, `  call: ${item.call}`].join("\n"))
    .join("\n")
  return [
    "Return JSON only. Do not use tools. Do not ask questions.",
    "You are scoring Python callables for a review tool.",
    "For each candidate, estimate how likely it is to be a read or write operation based only on the snippet.",
    "Use this exact JSON shape:",
    '{"scores":[{"fingerprint":"...","call":"...","readConfidence":0.0,"writeConfidence":0.0,"reasons":["..."]}]}',
    "Rules:",
    "- include every candidate exactly once",
    "- keep confidences between 0 and 0.99",
    "- keep at most 3 short reasons per candidate",
    "- reasons should explain the score, not make the final decision",
    "",
    "Python snippet:",
    "```python",
    item.code,
    "```",
    "",
    "Candidates:",
    body,
  ].join("\n")
}

function unwrap(text: string) {
  const raw = text.trim()
  if (!raw) fail("Empty scorer output")
  if (raw.startsWith("```")) {
    const lines = raw.split(/\r?\n/)
    const inner = lines.slice(1, lines[lines.length - 1] === "```" ? -1 : lines.length).join("\n").trim()
    if (inner) return inner
  }
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start >= 0 && end > start) return raw.slice(start, end + 1)
  return raw
}

function scorerow(input: unknown, label: string): ScoreRow {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail(`${label} must be an object`)
  const row = input as Record<string, unknown>
  if (typeof row.fingerprint !== "string" || !row.fingerprint) fail(`${label}.fingerprint must be a string`)
  if (typeof row.call !== "string" || !row.call) fail(`${label}.call must be a string`)
  if (typeof row.readConfidence !== "number" || !Number.isFinite(row.readConfidence) || row.readConfidence < 0 || row.readConfidence > 0.99) {
    fail(`${label}.readConfidence must be a number between 0 and 0.99`)
  }
  if (typeof row.writeConfidence !== "number" || !Number.isFinite(row.writeConfidence) || row.writeConfidence < 0 || row.writeConfidence > 0.99) {
    fail(`${label}.writeConfidence must be a number between 0 and 0.99`)
  }
  return {
    fingerprint: row.fingerprint,
    call: row.call,
    readConfidence: clamp(row.readConfidence),
    writeConfidence: clamp(row.writeConfidence),
    reasons: Array.isArray(row.reasons) ? row.reasons.filter((item): item is string => typeof item === "string").slice(0, 3) : [],
    scoreSource: "opencode-run",
  }
}

function parseoutput(text: string, item: ReviewSnippet) {
  const raw = JSON.parse(unwrap(text)) as { scores?: unknown }
  if (!Array.isArray(raw.scores)) fail("Scorer JSON must include scores[]")
  const rows = raw.scores.map((item, i) => scorerow(item, `scores[${i}]`))
  const want = new Map(item.candidates.map((item) => [item.fingerprint, item]))
  const out = new Map<string, ScoreRow>()
  for (const row of rows) {
    const hit = want.get(row.fingerprint)
    if (!hit) fail(`Unexpected scorer fingerprint: ${row.fingerprint}`)
    if (hit.call !== row.call) fail(`Scorer call mismatch for ${row.fingerprint}`)
    if (out.has(row.fingerprint)) fail(`Duplicate scorer fingerprint: ${row.fingerprint}`)
    out.set(row.fingerprint, row)
  }
  if (out.size !== item.candidates.length) fail("Scorer output is missing candidates")
  return item.candidates.map((item) => out.get(item.fingerprint)!)
}

async function exec(cmd: string, args: string[]) {
  return await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const sub = spawn(cmd, args, {
      cwd: root(),
      env: { ...process.env, CI: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    const timer = setTimeout(() => {
      sub.kill("SIGKILL")
      reject(new Error("opencode run timed out"))
    }, SCORE_TIMEOUT)
    sub.stdout.on("data", (item) => {
      out += String(item)
    })
    sub.stderr.on("data", (item) => {
      err += String(item)
    })
    sub.on("error", reject)
    sub.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout: out, stderr: err })
    })
  })
}

function text(out: string) {
  let buf = ""
  for (const line of out.split(/\r?\n/).filter(Boolean)) {
    const row = JSON.parse(line) as { type?: string; part?: { text?: string } }
    if (row.type === "tool_use") fail("Scorer used tools")
    if (row.type === "error") fail("Scorer emitted an error event")
    if (row.type === "text" && typeof row.part?.text === "string") buf += row.part.text
  }
  if (!buf.trim()) fail("Scorer returned no text")
  return buf
}

async function run(prompt: string) {
  const args = ["run", "--format", "json", "--dir", root(), prompt]
  try {
    const out = await exec(process.env.OPENCODE_SCORE_BIN ?? "opencode", args)
    if (out.code !== 0) fail(out.stderr.trim() || `opencode run exited with ${out.code}`)
    return text(out.stdout)
  } catch (err) {
    if (!(err instanceof Error) || !/ENOENT/.test(err.message)) throw err
  }

  const out = await exec("bun", [
    "run",
    "--cwd",
    path.join(root(), "opencode", "packages", "opencode"),
    "src/index.ts",
    "run",
    "--format",
    "json",
    "--dir",
    root(),
    prompt,
  ])
  if (out.code !== 0) fail(out.stderr.trim() || `opencode run exited with ${out.code}`)
  return text(out.stdout)
}

async function scoredoc(filePath: string) {
  const file = Bun.file(filePath)
  if (!(await file.exists())) return { version: SCORE_CACHE_VERSION, entries: [] } satisfies ScoreDoc
  try {
    const raw = JSON.parse(await file.text()) as { version?: number; entries?: unknown }
    if (raw.version !== SCORE_CACHE_VERSION || !Array.isArray(raw.entries)) throw new Error("invalid score cache")
    return {
      version: SCORE_CACHE_VERSION,
      entries: raw.entries
        .filter((item) => typeof item === "object" && item !== null && !Array.isArray(item))
        .map((item) => {
          const row = item as { key?: unknown; createdAt?: unknown; scores?: unknown }
          return {
            key: typeof row.key === "string" ? row.key : "",
            createdAt: typeof row.createdAt === "string" ? row.createdAt : new Date(0).toISOString(),
            scores: Array.isArray(row.scores) ? row.scores.map((item, i) => scorerow(item, `cache.scores[${i}]`)) : [],
          }
        })
        .filter((item) => item.key && item.scores.length),
    }
  } catch {
    return { version: SCORE_CACHE_VERSION, entries: [] }
  }
}

async function savescoredoc(filePath: string, doc: ScoreDoc) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await Bun.write(filePath, `${JSON.stringify(doc, null, 2)}\n`)
}

function merge(item: ReviewSnippet, rows: ScoreRow[]) {
  const by = new Map(rows.map((item) => [item.fingerprint, item]))
  return {
    ...item,
    candidates: item.candidates.map((item) => {
      const hit = by.get(item.fingerprint)
      if (!hit) return item
      return {
        ...item,
        readConfidence: hit.readConfidence,
        writeConfidence: hit.writeConfidence,
        reasons: hit.reasons,
        scoreSource: hit.scoreSource,
      }
    }),
  }
}

function fallback(item: ReviewSnippet) {
  return {
    ...item,
    candidates: item.candidates.map((item) => ({
      ...item,
      scoreSource: "heuristic-fallback",
    })),
  }
}

export async function rescore(item: ReviewSnippet, opts: { cache: string; run?: Runner }) {
  const key = scorekey(item)
  const doc = await scoredoc(opts.cache)
  const hit = doc.entries.find((item) => item.key === key)
  if (hit) {
    return {
      item: merge(item, hit.scores.map((item) => ({ ...item, scoreSource: "opencode-cache" }))),
      warning: undefined,
    }
  }

  try {
    const rows = parseoutput(await (opts.run ?? run)(scoreprompt(item)), item)
    const next = doc.entries.filter((item) => item.key !== key)
    next.push({ key, createdAt: new Date().toISOString(), scores: rows })
    next.sort((a, b) => a.key.localeCompare(b.key))
    await savescoredoc(opts.cache, { version: SCORE_CACHE_VERSION, entries: next })
    return { item: merge(item, rows), warning: undefined }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { item: fallback(item), warning: `opencode run scoring unavailable; using heuristic fallback (${msg})` }
  }
}

function when(time: number) {
  return new Date(time).toISOString()
}

function clip(code: string) {
  const text = code.trim().replace(/\s+/g, " ")
  if (text.length <= 160) return text
  return `${text.slice(0, 157)}...`
}

function part(row: Row) {
  try {
    return JSON.parse(row.data) as Tool
  } catch {
    fail(`Invalid part.data JSON for part ${row.part_id}`)
  }
}

function code(row: Row) {
  const data = part(row)
  if (data.type !== "tool") return
  if (data.tool !== "python") return
  const input = data.state?.input
  if (!input) return { python: true }
  if (typeof input.code !== "string") return { python: true }
  if (input.scriptPath !== undefined) return { python: true }
  return { python: true, code: input.code }
}

export function parse(args: string[]) {
  const opts: Opts = {
    db: defdb(),
    json: false,
    samples: 3,
    ledger: defledger(),
    rules: defrules(),
    scoreCache: defscorecache(),
    reviewJson: false,
    reviewNext: false,
    reviewTui: false,
    includePure: false,
    update: false,
    promoteReviewed: false,
    help: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--help") {
      opts.help = true
      continue
    }
    if (arg === "--json") {
      opts.json = true
      continue
    }
    if (arg === "--update-candidates") {
      opts.update = true
      continue
    }
    if (arg === "--include-pure") {
      opts.includePure = true
      continue
    }
    if (arg === "--promote-reviewed") {
      opts.promoteReviewed = true
      continue
    }
    if (arg === "--review-json") {
      opts.reviewJson = true
      continue
    }
    if (arg === "--review-next") {
      opts.reviewNext = true
      continue
    }
    if (arg === "--review-tui") {
      opts.reviewTui = true
      continue
    }
    if (arg === "--db") {
      const val = args[++i]
      if (!val) fail("Missing value for --db")
      opts.db = path.resolve(val)
      continue
    }
    if (arg === "--ledger") {
      const val = args[++i]
      if (!val) fail("Missing value for --ledger")
      opts.ledger = path.resolve(val)
      continue
    }
    if (arg === "--rules") {
      const val = args[++i]
      if (!val) fail("Missing value for --rules")
      opts.rules = path.resolve(val)
      continue
    }
    if (arg === "--score-cache") {
      const val = args[++i]
      if (!val) fail("Missing value for --score-cache")
      opts.scoreCache = path.resolve(val)
      continue
    }
    if (arg === "--record-decision") {
      const val = args[++i]
      if (!val) fail("Missing value for --record-decision")
      opts.recordDecision = val
      continue
    }
    if (arg === "--decide") {
      const val = args[++i]
      if (!val) fail("Missing value for --decide")
      opts.decide = val
      continue
    }
    if (arg === "--samples") {
      const val = args[++i]
      if (!val) fail("Missing value for --samples")
      const num = Number.parseInt(val, 10)
      if (!Number.isInteger(num) || num < 1) fail("--samples must be a positive integer")
      opts.samples = num
      continue
    }
    if (arg === "--since") {
      const val = args[++i]
      if (!val) fail("Missing value for --since")
      const time = Date.parse(val)
      if (Number.isNaN(time)) fail("--since must be a valid ISO timestamp")
      opts.since = time
      continue
    }
    fail(`Unknown argument: ${arg}`)
  }

  if (opts.json && (opts.reviewJson || opts.reviewNext || opts.reviewTui || opts.promoteReviewed)) fail("Use --json only with the report output")
  if ([opts.reviewJson, opts.reviewNext, opts.reviewTui].filter(Boolean).length > 1) {
    fail("Use only one of --review-json, --review-next, or --review-tui")
  }
  if (opts.decide && !opts.reviewNext) fail("--decide requires --review-next")
  if (opts.recordDecision && opts.reviewTui) fail("--record-decision cannot be combined with --review-tui")
  if (opts.update && (opts.reviewJson || opts.reviewNext || opts.reviewTui || opts.promoteReviewed)) {
    fail("--update-candidates cannot be combined with review or promotion modes")
  }
  if (opts.promoteReviewed && (opts.reviewJson || opts.reviewNext || opts.reviewTui)) {
    fail("--promote-reviewed cannot be combined with review modes")
  }
  if (opts.promoteReviewed && opts.since !== undefined) {
    fail("--promote-reviewed requires a full scan; omit --since")
  }

  return opts
}

function rows(db: Database, since?: number) {
  const sql = [
    "select",
    "  p.id as part_id,",
    "  p.message_id,",
    "  p.session_id,",
    "  p.time_created,",
    "  p.time_updated,",
    "  p.data,",
    "  s.title",
    "from part p",
    "join session s on s.id = p.session_id",
    since !== undefined ? "where p.time_updated >= ?" : "",
    "order by p.time_updated desc, p.id desc",
  ]
    .filter(Boolean)
    .join(" ")
  const q = db.query(sql)
  return (since !== undefined ? q.all(since) : q.all()) as Row[]
}

export async function scan(opts: { db: string; since?: number; samples?: number; includePure?: boolean }): Promise<Report> {
  if (!(await Bun.file(opts.db).exists())) fail(`OpenCode session database not found: ${opts.db}`)

  const db = new Database(opts.db, { readonly: true })
  const sample = opts.samples ?? 3
  const includePure = opts.includePure ?? false

  try {
    const all = rows(db, opts.since)
    const seen = new Set<string>()
    const hits = new Map<string, Hit>()
    const occurrences: Occurrence[] = []
    let toolParts = 0
    let inlineSnippets = 0
    let unknownEvents = 0
    let skippedRows = 0

    for (const row of all) {
      let item: ReturnType<typeof code>
      try {
        item = code(row)
      } catch {
        skippedRows++
        continue
      }

      if (!item?.python) continue
      toolParts++
      seen.add(row.session_id)
      if (!item.code) continue
      inlineSnippets++

      const events = await analyze(item.code)
      for (const event of events) {
        let kind: Occurrence["kind"] | undefined
        let call: string | undefined

        if (event.kind === "unknown") {
          if (!event.call.startsWith("callable:")) continue
          kind = "unknown"
          call = event.call.slice("callable:".length)
          unknownEvents++
        } else if (event.kind === "emit") {
          kind = "emit"
          call = event.call
        } else if (event.kind === "pure" && includePure) {
          kind = "pure"
          call = event.call
        } else {
          continue
        }

        const time = row.time_updated || row.time_created
        const scored = score(call, item.code)
        const normalizedCode = normalized(item.code)
        const seed = kind === "unknown" ? `${call}\n${normalizedCode}` : `${kind}\n${call}\n${normalizedCode}`
        occurrences.push({
          kind,
          call,
          fingerprint: fingerprint(seed),
          snippetFingerprint: fingerprint(normalizedCode),
          sessionID: row.session_id,
          messageID: row.message_id,
          partID: row.part_id,
          title: row.title || "<untitled session>",
          time: when(time),
          preview: clip(item.code),
          code: item.code,
          readConfidence: scored.readConfidence,
          writeConfidence: scored.writeConfidence,
          reasons: scored.reasons,
          scoreSource: "heuristic",
        })

        if (kind !== "unknown") continue

        const hit =
          hits.get(call) ??
          {
            call,
            count: 0,
            last: time,
            seen: new Map<string, Seen>(),
            samples: [],
          }

        hit.count++
        if (time > hit.last) hit.last = time
        if (!hit.seen.has(row.session_id) && hit.seen.size < sample) {
          hit.seen.set(row.session_id, {
            id: row.session_id,
            title: row.title || "<untitled session>",
            time: when(time),
          })
        }
        if (hit.samples.length < sample) {
          hit.samples.push({
            sessionID: row.session_id,
            messageID: row.message_id,
            partID: row.part_id,
            title: row.title || "<untitled session>",
            time: when(time),
            preview: clip(item.code),
          })
        }
        hits.set(call, hit)
      }
    }

    const unknown = [...hits.values()]
      .sort((a, b) => b.count - a.count || b.last - a.last || a.call.localeCompare(b.call))
      .map((item) => ({
        call: item.call,
        count: item.count,
        lastSeen: when(item.last),
        sessions: [...item.seen.values()].sort((a, b) => b.time.localeCompare(a.time)),
        samples: item.samples,
      }))

    return {
      generatedAt: new Date().toISOString(),
      db: opts.db,
      filters: {
        since: opts.since !== undefined ? when(opts.since) : undefined,
        samples: sample,
      },
      totals: {
        sessions: seen.size,
        toolParts,
        inlineSnippets,
        unknownEvents,
        uniqueUnknownCalls: unknown.length,
        skippedRows,
      },
      unknown,
      occurrences,
    }
  } finally {
    db.close()
  }
}

function entry(item: Report["unknown"][number], sample: number): Candidate {
  return {
    call: item.call,
    count: item.count,
    lastSeen: item.lastSeen,
    examples: [...new Set(item.samples.map((sample) => sample.sessionID))].sort().slice(0, sample),
  }
}

function decision(input: unknown, file: string): ReviewDecisionRecord {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail(`Invalid review ledger: ${file}`)
  const row = input as Record<string, unknown>
  if (typeof row.fingerprint !== "string" || !row.fingerprint) fail(`Invalid review ledger: ${file}`)
  if (typeof row.decision !== "string" || !isDecision(row.decision)) fail(`Invalid review ledger: ${file}`)
  return {
    fingerprint: row.fingerprint,
    call: typeof row.call === "string" ? row.call : undefined,
    decision: row.decision,
    decidedAt: typeof row.decidedAt === "string" ? row.decidedAt : new Date(0).toISOString(),
  }
}

async function ledger(filePath: string): Promise<ReviewLedger> {
  const file = Bun.file(filePath)
  if (!(await file.exists())) return { version: REVIEW_LEDGER_VERSION, decisions: [] }

  let raw: unknown
  try {
    raw = JSON.parse(await file.text())
  } catch {
    fail(`Invalid review ledger: ${filePath}`)
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(`Invalid review ledger: ${filePath}`)
  const root = raw as Record<string, unknown>
  if (root.version !== REVIEW_LEDGER_VERSION) fail(`Invalid review ledger: ${filePath}`)
  if (!Array.isArray(root.decisions)) fail(`Invalid review ledger: ${filePath}`)
  return {
    version: REVIEW_LEDGER_VERSION,
    decisions: root.decisions.map((item) => decision(item, filePath)),
  }
}

async function saveLedger(filePath: string, data: ReviewLedger) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await Bun.write(filePath, `${JSON.stringify(data, null, 2)}\n`)
}

async function writeDecisions(opts: {
  ledger: string
  decisions: Array<{ fingerprint: string; decision: ReviewDecision; call?: string }>
}) {
  const data = await ledger(opts.ledger)
  const next = data.decisions.filter((item) => !opts.decisions.some((decision) => decision.fingerprint === item.fingerprint))
  for (const item of opts.decisions) {
    next.push({
      fingerprint: item.fingerprint,
      call: item.call,
      decision: item.decision,
      decidedAt: new Date().toISOString(),
    })
  }
  next.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint))
  const out = { version: REVIEW_LEDGER_VERSION, decisions: next }
  await saveLedger(opts.ledger, out)
  return out
}

function recordSpec(input: string) {
  const pivot = input.lastIndexOf("=")
  if (pivot <= 0 || pivot === input.length - 1) fail("--record-decision must be fingerprint=decision")
  const fingerprint = input.slice(0, pivot)
  const outcome = input.slice(pivot + 1)
  if (!isDecision(outcome)) fail("--record-decision must use read, write, emit, exec, ignore, or needs-code")
  return { fingerprint, decision: outcome }
}

export async function recordDecision(opts: { ledger: string; fingerprint: string; decision: ReviewDecision; call?: string }) {
  return writeDecisions({ ledger: opts.ledger, decisions: [opts] })
}

export async function review(report: Report, opts: { ledger: string }): Promise<ReviewQueue> {
  const data = await ledger(opts.ledger)
  const byFingerprint = new Map(data.decisions.map((item) => [item.fingerprint, item]))
  const snippets = new Map<
    string,
    {
      fingerprint: string
      code: string
      preview: string
      lastSeen: string
      occurrences: Map<string, Sample>
      candidates: Map<
        string,
        {
          kind: Occurrence["kind"]
          call: string
          fingerprint: string
          readConfidence: number
          writeConfidence: number
          reasons: string[]
          scoreSource: string
          decision?: ReviewDecision
        }
      >
    }
  >()

  for (const item of report.occurrences) {
    const snippet =
      snippets.get(item.snippetFingerprint) ??
      {
        fingerprint: item.snippetFingerprint,
        code: item.code,
        preview: item.preview,
        lastSeen: item.time,
        occurrences: new Map<string, Sample>(),
        candidates: new Map(),
      }
    if (item.time > snippet.lastSeen) snippet.lastSeen = item.time
    snippet.occurrences.set(item.partID, {
      sessionID: item.sessionID,
      messageID: item.messageID,
      partID: item.partID,
      title: item.title,
      time: item.time,
      preview: item.preview,
    })
    if (!snippet.candidates.has(item.fingerprint)) {
        snippet.candidates.set(item.fingerprint, {
          kind: item.kind,
          call: item.call,
          fingerprint: item.fingerprint,
          readConfidence: item.readConfidence,
          writeConfidence: item.writeConfidence,
          reasons: item.reasons,
          scoreSource: item.scoreSource,
          decision: byFingerprint.get(item.fingerprint)?.decision,
        })
      }
    snippets.set(item.snippetFingerprint, snippet)
  }

  const out = [...snippets.values()]
    .map((snippet) => ({
      snippetFingerprint: snippet.fingerprint,
      code: snippet.code,
      preview: snippet.preview,
      lastSeen: snippet.lastSeen,
      occurrences: [...snippet.occurrences.values()].sort((a, b) => b.time.localeCompare(a.time)),
      candidates: [...snippet.candidates.values()].sort(
        (a, b) => Number(Boolean(a.decision)) - Number(Boolean(b.decision)) || a.call.localeCompare(b.call),
      ),
    }))
    .filter((snippet) => snippet.candidates.some((candidate) => !candidate.decision))
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))

  let pendingCandidates = 0
  let decidedCandidates = 0
  for (const snippet of out) {
    for (const candidate of snippet.candidates) {
      if (candidate.decision) decidedCandidates++
      else pendingCandidates++
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    db: report.db,
    ledger: opts.ledger,
    filters: report.filters,
    totals: {
      snippets: out.length,
      pendingCandidates,
      decidedCandidates,
    },
    snippets: out,
  }
}

export function nextReview(queue: ReviewQueue): ReviewSnippet | undefined {
  return queue.snippets[0]
}

function parsePair(input: string) {
  const pivot = input.lastIndexOf("=")
  if (pivot <= 0 || pivot === input.length - 1) fail("--decide must use item=decision pairs")
  const left = input.slice(0, pivot).trim()
  const right = input.slice(pivot + 1).trim()
  if (!left) fail("--decide must use item=decision pairs")
  if (!isDecision(right)) fail("--decide must use read, write, emit, exec, ignore, or needs-code")
  return { left, decision: right }
}

export function parseDecide(input: string) {
  return input
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const pair = parsePair(item)
      const index = Number.parseInt(pair.left, 10)
      if (String(index) === pair.left && Number.isInteger(index) && index >= 1) {
        return { kind: "index" as const, index, decision: pair.decision }
      }
      return { kind: "fingerprint" as const, fingerprint: pair.left, decision: pair.decision }
    })
}

export async function applyDecisions(opts: { ledger: string; item: ReviewSnippet; decide: string }) {
  const actions = parseDecide(opts.decide)
  const seen = new Set<string>()
  const resolved: Array<{ fingerprint: string; decision: ReviewDecision; call?: string }> = []
  for (const action of actions) {
    const target =
      action.kind === "index"
        ? opts.item.candidates[action.index - 1]
        : opts.item.candidates.find((item) => item.fingerprint === action.fingerprint)
    if (!target) fail(`Decision target not found: ${action.kind === "index" ? action.index : action.fingerprint}`)
    if (seen.has(target.fingerprint)) fail(`Duplicate decision target: ${target.fingerprint}`)
    seen.add(target.fingerprint)
    resolved.push({ fingerprint: target.fingerprint, decision: action.decision, call: target.call })
  }
  await writeDecisions({ ledger: opts.ledger, decisions: resolved })
}

export function renderReview(item: ReviewSnippet) {
  const out = [
    `Snippet: ${item.snippetFingerprint}`,
    `Last seen: ${item.lastSeen}`,
    `Occurrences: ${item.occurrences.length}`,
    "",
    "Code:",
    item.code,
    "",
    "Candidates:",
  ]

  item.candidates.forEach((candidate, i) => {
    const decision = candidate.decision ? ` decided=${candidate.decision}` : ""
    out.push(
      `${i + 1}. ${candidate.call} [${candidate.fingerprint}] kind=${candidate.kind} read=${candidate.readConfidence} write=${candidate.writeConfidence} source=${candidate.scoreSource}${decision}`,
    )
    if (candidate.reasons.length) out.push(`   reasons: ${candidate.reasons.join("; ")}`)
  })

  out.push("")
  out.push("Apply decisions with --review-next --decide 1=read,2=write,3=emit")
  return out.join("\n")
}

function suggest(item: ReviewSnippet["candidates"][number]) {
  if (item.kind === "emit") return "emit"
  return item.readConfidence >= item.writeConfidence ? "read" : "write"
}

function other(item: ReviewDecision) {
  if (item === "emit") return "ignore"
  return item === "read" ? "write" : "read"
}

function key(input: string): ReviewKey | undefined {
  if (["y", "n", "r", "w", "e", "x", "i", "c", "s", "v", "?", "q"].includes(input)) return input as ReviewKey
}

export function action(input: string, item: ReviewSnippet["candidates"][number]): ReviewAction | undefined {
  const hit = key(input)
  if (!hit) return
  if (hit === "y") return { type: "decide", decision: suggest(item) }
  if (hit === "n") return { type: "decide", decision: other(suggest(item)) }
  if (hit === "r") return { type: "decide", decision: "read" }
  if (hit === "w") return { type: "decide", decision: "write" }
  if (hit === "e") return { type: "decide", decision: "emit" }
  if (hit === "x") return { type: "decide", decision: "exec" }
  if (hit === "i") return { type: "decide", decision: "ignore" }
  if (hit === "c") return { type: "decide", decision: "needs-code" }
  if (hit === "s") return { type: "skip" }
  if (hit === "v") return { type: "toggle" }
  if (hit === "?") return { type: "help" }
  return { type: "quit" }
}

function marker(text: string, call: string) {
  if (!call) return text
  return text.split(call).join(`[[${call}]]`)
}

function block(code: string, call: string, full: boolean) {
  const lines = normalized(code).split("\n")
  const hits = lines.flatMap((text, i) => (text.includes(call) ? [i] : []))
  const start = full || !hits.length ? 0 : Math.max(0, hits[0] - 4)
  const end = full || !hits.length ? lines.length : Math.min(lines.length, hits[0] + 8)
  const body = lines.slice(start, end).map((text, i) => `${String(start + i + 1).padStart(3, " ")} | ${marker(text, call)}`)
  if (start > 0) body.unshift(`... ${start} earlier lines hidden ...`)
  if (end < lines.length) body.push(`... ${lines.length - end} later lines hidden ...`)
  return body.join("\n")
}

function clear(output: NodeJS.WriteStream) {
  output.write("\x1b[2J\x1b[H")
}

export function item(queue: ReviewQueue, skip = new Set<string>()) {
  const snippets = queue.snippets.flatMap((snippet, snippetIndex) => {
    const pending = snippet.candidates.filter((candidate) => !candidate.decision && !skip.has(candidate.fingerprint))
    if (!pending.length) return []
    return [
      {
        snippet,
        snippetIndex,
        pending,
      },
    ]
  })
  const head = snippets[0]
  if (!head) return
  return {
    snippet: head.snippet,
    candidate: head.pending[0],
    snippetIndex: head.snippetIndex + 1,
    snippetCount: queue.snippets.length,
    candidateIndex: 1,
    candidateCount: head.pending.length,
    pendingCount: snippets.reduce((sum, item) => sum + item.pending.length, 0),
  } satisfies ReviewItem
}

export function renderTui(item: ReviewItem, full: boolean, help = false) {
  const pick = suggest(item.candidate)
  const out = [
    `Python Review ${item.snippetIndex}/${item.snippetCount} | candidate 1/${item.candidateCount} | pending ${item.pendingCount}`,
    `Call: ${item.candidate.call}`,
    `Suggested: ${pick} | read=${item.candidate.readConfidence} write=${item.candidate.writeConfidence} | source=${item.candidate.scoreSource}`,
  ]
  if (item.candidate.reasons.length) out.push(`Why: ${item.candidate.reasons.join("; ")}`)
  out.push("", "Code:", block(item.snippet.code, item.candidate.call, full), "")
  if (help) {
    out.push("Keys: y accept, n opposite, r read, w write, e emit, x exec, i ignore, c needs-code, s skip, v toggle code, q quit")
    return out.join("\n")
  }
  out.push("Keys: y/n r/w e x i c s v ? q")
  return out.join("\n")
}

function settled(queue: ReviewQueue, fingerprint: string, decision: ReviewDecision) {
  return {
    ...queue,
    snippets: queue.snippets.map((snippet) => ({
      ...snippet,
      candidates: snippet.candidates.map((candidate) =>
        candidate.fingerprint === fingerprint ? { ...candidate, decision } : candidate,
      ),
    })),
  }
}

async function press(input: NodeJS.ReadStream) {
  return await new Promise<string>((resolve) => {
    const done = (value: string, info?: { name?: string; ctrl?: boolean }) => {
      input.off("keypress", done)
      if (info?.ctrl && info.name === "c") resolve("q")
      else resolve(value)
    }
    input.on("keypress", done)
  })
}

export async function tui(queue: ReviewQueue, opts: { ledger: string; cache: string; input?: NodeJS.ReadStream; output?: NodeJS.WriteStream }) {
  const input = opts.input ?? process.stdin
  const output = opts.output ?? process.stdout
  if (!input.isTTY || !output.isTTY) fail("--review-tui requires a TTY; use --review-next for non-interactive review")
  rl.emitKeypressEvents(input)
  input.setRawMode?.(true)
  input.resume()
  const skip = new Set<string>()
  let help = false
  let full = false

  try {
    while (true) {
      const head = item(queue, skip)
      if (!head) {
        output.write("No pending review items.\n")
        return
      }
      const scored = await rescore(head.snippet, { cache: opts.cache })
      const current = item({ ...queue, snippets: [scored.item, ...queue.snippets.filter((row) => row.snippetFingerprint !== head.snippet.snippetFingerprint)] }, skip)
      if (!current) {
        output.write("No pending review items.\n")
        return
      }
      clear(output)
      if (scored.warning) output.write(`${scored.warning}\n\n`)
      output.write(`${renderTui(current, full, help)}\n`)
      const hit = action(await press(input), current.candidate)
      if (!hit) continue
      if (hit.type === "quit") return
      if (hit.type === "help") {
        help = !help
        continue
      }
      if (hit.type === "toggle") {
        full = !full
        continue
      }
      if (hit.type === "skip") {
        skip.add(current.candidate.fingerprint)
        continue
      }
      await recordDecision({
        ledger: opts.ledger,
        fingerprint: current.candidate.fingerprint,
        decision: hit.decision,
        call: current.candidate.call,
      })
      queue = settled(queue, current.candidate.fingerprint, hit.decision)
    }
  } finally {
    input.setRawMode?.(false)
    input.pause()
  }
}

function bucketFor(decision: ReviewDecision): PromotionBucket | undefined {
  if (decision === "read" || decision === "write" || decision === "emit" || decision === "exec") return decision
}

function strings(input: unknown) {
  return Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : []
}

function callBuckets(doc: RulesDoc) {
  const root = typeof doc.calls === "object" && doc.calls !== null && !Array.isArray(doc.calls) ? (doc.calls as Record<string, unknown>) : {}
  return {
    read: strings(root.read),
    write: strings(root.write),
    emit: strings(root.emit),
    exec: strings(root.exec),
  }
}

function ledgerDecisions(data: ReviewLedger) {
  return new Map(data.decisions.map((item) => [item.fingerprint, item.decision]))
}

export async function promotions(report: Report, opts: { ledger: string; rules: string }): Promise<PromotionPlan> {
  const data = await ledger(opts.ledger)
  const decided = ledgerDecisions(data)
  const byCall = new Map<
    string,
    {
      decisions: Map<string, ReviewDecision>
      pending: Set<string>
    }
  >()

  for (const item of report.occurrences) {
    const row = byCall.get(item.call) ?? { decisions: new Map<string, ReviewDecision>(), pending: new Set<string>() }
    const outcome = decided.get(item.fingerprint)
    if (outcome) row.decisions.set(item.fingerprint, outcome)
    else row.pending.add(item.fingerprint)
    byCall.set(item.call, row)
  }

  const promotable: Record<PromotionBucket, string[]> = { read: [], write: [], emit: [], exec: [] }
  const blocked: PromotionPlan["blocked"] = []

  for (const [call, row] of [...byCall.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const outcomes = [...new Set(row.decisions.values())]
    if (!outcomes.length) {
      blocked.push({ call, reason: "no reviewed contexts", decisions: [], pendingContexts: row.pending.size })
      continue
    }
    if (row.pending.size) {
      blocked.push({ call, reason: "unresolved contexts remain", decisions: outcomes, pendingContexts: row.pending.size })
      continue
    }
    const buckets = outcomes.map(bucketFor).filter((item): item is PromotionBucket => Boolean(item))
    if (buckets.length !== outcomes.length) {
      blocked.push({ call, reason: "contains non-promotable decisions", decisions: outcomes, pendingContexts: 0 })
      continue
    }
    const uniq = [...new Set(buckets)]
    if (uniq.length !== 1) {
      blocked.push({ call, reason: "conflicting reviewed decisions", decisions: outcomes, pendingContexts: 0 })
      continue
    }
    promotable[uniq[0]].push(call)
  }

  for (const bucket of ["read", "write", "emit", "exec"] as const) promotable[bucket].sort((a, b) => a.localeCompare(b))

  return {
    generatedAt: new Date().toISOString(),
    db: report.db,
    ledger: opts.ledger,
    rules: opts.rules,
    promotable,
    blocked,
  }
}

export function renderPromotions(plan: PromotionPlan) {
  const out = [`Rules: ${plan.rules}`, `Ledger: ${plan.ledger}`]
  for (const bucket of ["read", "write", "emit", "exec"] as const) {
    out.push("")
    out.push(`${bucket}: ${plan.promotable[bucket].length}`)
    for (const call of plan.promotable[bucket]) out.push(`  - ${call}`)
  }
  if (plan.blocked.length) {
    out.push("")
    out.push(`blocked: ${plan.blocked.length}`)
    for (const item of plan.blocked) {
      out.push(`  - ${item.call}: ${item.reason}`)
    }
  }
  return out.join("\n")
}

export async function promote(report: Report, opts: { ledger: string; rules: string }) {
  const plan = await promotions(report, opts)
  const file = Bun.file(opts.rules)
  if (!(await file.exists())) fail(`Python rules file not found: ${opts.rules}`)

  let doc: RulesDoc
  try {
    doc = (JSON.parse(await file.text()) as RulesDoc) ?? {}
  } catch {
    fail(`Invalid python rules JSON: ${opts.rules}`)
  }

  const calls = callBuckets(doc)
  const remove = new Set([...plan.promotable.read, ...plan.promotable.write, ...plan.promotable.emit, ...plan.promotable.exec])
  const nextCalls = {
    read: [...new Set([...calls.read.filter((item) => !remove.has(item)), ...plan.promotable.read])].sort((a, b) => a.localeCompare(b)),
    write: [...new Set([...calls.write.filter((item) => !remove.has(item)), ...plan.promotable.write])].sort((a, b) => a.localeCompare(b)),
    emit: [...new Set([...calls.emit.filter((item) => !remove.has(item)), ...plan.promotable.emit])].sort((a, b) => a.localeCompare(b)),
    exec: [...new Set([...calls.exec.filter((item) => !remove.has(item)), ...plan.promotable.exec])].sort((a, b) => a.localeCompare(b)),
  }

  doc.calls = {
    ...(typeof doc.calls === "object" && doc.calls !== null && !Array.isArray(doc.calls) ? (doc.calls as Record<string, unknown>) : {}),
    ...nextCalls,
  }

  if (doc.candidates && typeof doc.candidates === "object" && !Array.isArray(doc.candidates) && Array.isArray(doc.candidates.unknown)) {
    doc.candidates.unknown = doc.candidates.unknown.filter((item) => !remove.has(item.call))
  }

  await Bun.write(opts.rules, `${JSON.stringify(doc, null, 2)}\n`)
  return plan
}

export async function update(report: Report, opts: { rules: string; samples?: number }) {
  const file = Bun.file(opts.rules)
  if (!(await file.exists())) fail(`Python rules file not found: ${opts.rules}`)

  let doc: RulesDoc
  try {
    doc = (JSON.parse(await file.text()) as RulesDoc) ?? {}
  } catch {
    fail(`Invalid python rules JSON: ${opts.rules}`)
  }

  const sample = opts.samples ?? 3
  const known = new Map<string, Candidate>()
  if (doc.candidates !== undefined && (typeof doc.candidates !== "object" || doc.candidates === null || Array.isArray(doc.candidates))) {
    fail(`Invalid python rules candidates: ${opts.rules}`)
  }
  const items = doc.candidates?.unknown
  if (items !== undefined && !Array.isArray(items)) fail(`Invalid python rules candidates: ${opts.rules}`)
  for (const item of items ?? []) {
    if (!item || typeof item.call !== "string") continue
    known.set(item.call, {
      call: item.call,
      count: typeof item.count === "number" ? item.count : 0,
      lastSeen: typeof item.lastSeen === "string" ? item.lastSeen : new Date(0).toISOString(),
      examples: Array.isArray(item.examples) ? item.examples.filter((item) => typeof item === "string") : [],
    })
  }

  for (const item of report.unknown) {
    const prev = known.get(item.call)
    const next = entry(item, sample)
    if (!prev) {
      known.set(item.call, next)
      continue
    }
    known.set(item.call, {
      call: item.call,
      count: prev.count + next.count,
      lastSeen: prev.lastSeen > next.lastSeen ? prev.lastSeen : next.lastSeen,
      examples: [...new Set([...prev.examples, ...next.examples])].sort().slice(0, sample),
    })
  }

  doc.candidates = doc.candidates ?? {}
  doc.candidates.unknown = [...known.values()].sort((a, b) => a.call.localeCompare(b.call))
  await Bun.write(opts.rules, `${JSON.stringify(doc, null, 2)}\n`)
}

export function render(report: Report) {
  const out = [
    `Database: ${report.db}`,
    report.filters.since ? `Since: ${report.filters.since}` : "Since: all time",
    `Scanned ${report.totals.sessions} sessions with python tool parts, ${report.totals.toolParts} python tool parts, ${report.totals.inlineSnippets} inline snippets.`,
    `Found ${report.totals.unknownEvents} unknown callable events across ${report.totals.uniqueUnknownCalls} unique callables.`,
  ]

  if (report.totals.skippedRows) out.push(`Skipped ${report.totals.skippedRows} malformed rows.`)

  if (!report.unknown.length) return `${out.join("\n")}\n\nNo unknown callables found.`

  for (const item of report.unknown) {
    out.push("")
    out.push(`${item.call} (${item.count})`)
    out.push(`  last seen: ${item.lastSeen}`)
    for (const sample of item.samples) {
      out.push(`  - ${sample.sessionID} | ${sample.title} | ${sample.time} | ${sample.preview}`)
    }
  }

  return out.join("\n")
}

export async function main(args = process.argv.slice(2)) {
  const opts = parse(args)
  if (opts.help) {
    console.log(usage())
    return
  }

  if (opts.recordDecision) {
    const next = recordSpec(opts.recordDecision)
    await recordDecision({ ledger: opts.ledger, ...next })
    if (!opts.reviewJson && !opts.reviewNext) {
      console.log(`Recorded ${next.decision} for ${next.fingerprint} in ${opts.ledger}`)
      return
    }
  }

  const report = await scan({
    db: opts.db,
    since: opts.since,
    samples: opts.samples,
    includePure: opts.includePure,
  })
  if (opts.reviewJson) {
    console.log(JSON.stringify(await review(report, { ledger: opts.ledger }), null, 2))
    return
  }
  if (opts.reviewTui) {
    await tui(await review(report, { ledger: opts.ledger }), { ledger: opts.ledger, cache: opts.scoreCache })
    return
  }
  if (opts.reviewNext) {
    const queue = await review(report, { ledger: opts.ledger })
    let item = nextReview(queue)
    if (opts.decide) {
      if (!item) fail("No pending review items")
      await applyDecisions({ ledger: opts.ledger, item, decide: opts.decide })
      item = nextReview(await review(report, { ledger: opts.ledger }))
    }
    if (!item) {
      console.log("No pending review items.")
      return
    }
    const next = await rescore(item, { cache: opts.scoreCache })
    if (next.warning) console.error(next.warning)
    console.log(renderReview(next.item))
    return
  }
  if (opts.promoteReviewed) {
    console.log(renderPromotions(await promote(report, { ledger: opts.ledger, rules: opts.rules })))
    return
  }
  if (opts.update) await update(report, { rules: opts.rules, samples: opts.samples })
  console.log(opts.json ? JSON.stringify(report, null, 2) : render(report))
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
