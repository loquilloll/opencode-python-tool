import { Database } from "bun:sqlite"
import { createHash } from "crypto"
import { mkdir } from "fs/promises"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { analyze } from "./python/python-analyze"

type ReviewDecision = "read" | "write" | "exec" | "ignore" | "needs-code"

type Opts = {
  db: string
  since?: number
  json: boolean
  samples: number
  rules: string
  update: boolean
  ledger: string
  reviewJson: boolean
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
  call: string
  fingerprint: string
  snippetFingerprint: string
  code: string
  readConfidence: number
  writeConfidence: number
  reasons: string[]
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
      call: string
      fingerprint: string
      readConfidence: number
      writeConfidence: number
      reasons: string[]
      decision?: ReviewDecision
    }>
  }>
}

type RulesDoc = {
  candidates?: {
    unknown?: Candidate[]
  }
  [key: string]: unknown
}

const REVIEW_LEDGER_VERSION = 1
const REVIEW_DECISIONS = ["read", "write", "exec", "ignore", "needs-code"] as const

function usage() {
  return [
    "Usage: bun src/python-session-report.ts [options]",
    "",
    "Options:",
    "  --db <path>      Override OpenCode session database path",
    "  --ledger <path>  Override review-ledger JSON path",
    "  --rules <path>   Override python rules JSON path",
    "  --since <iso>    Only scan rows updated at or after this ISO timestamp",
    "  --samples <n>    Sample sessions/previews per unknown callable (default: 3)",
    "  --update-candidates  Write findings into candidates.unknown",
    "  --review-json    Emit snippet-centric review queue JSON",
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
    reviewJson: false,
    update: false,
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
    if (arg === "--review-json") {
      opts.reviewJson = true
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
    if (arg === "--record-decision") {
      const val = args[++i]
      if (!val) fail("Missing value for --record-decision")
      opts.recordDecision = val
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

  if (opts.json && opts.reviewJson) fail("Use either --json or --review-json, not both")

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

export async function scan(opts: { db: string; since?: number; samples?: number }): Promise<Report> {
  if (!(await Bun.file(opts.db).exists())) fail(`OpenCode session database not found: ${opts.db}`)

  const db = new Database(opts.db, { readonly: true })
  const sample = opts.samples ?? 3

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
        if (event.kind !== "unknown") continue
        if (!event.call.startsWith("callable:")) continue
        unknownEvents++

        const call = event.call.slice("callable:".length)
        const time = row.time_updated || row.time_created
        const scored = score(call, item.code)
        occurrences.push({
          call,
          fingerprint: fingerprint(`${call}\n${normalized(item.code)}`),
          snippetFingerprint: fingerprint(normalized(item.code)),
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
        })

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

function recordSpec(input: string) {
  const pivot = input.lastIndexOf("=")
  if (pivot <= 0 || pivot === input.length - 1) fail("--record-decision must be fingerprint=decision")
  const fingerprint = input.slice(0, pivot)
  const outcome = input.slice(pivot + 1)
  if (!isDecision(outcome)) fail("--record-decision must use read, write, exec, ignore, or needs-code")
  return { fingerprint, decision: outcome }
}

export async function recordDecision(opts: { ledger: string; fingerprint: string; decision: ReviewDecision; call?: string }) {
  const data = await ledger(opts.ledger)
  const next = data.decisions.filter((item) => item.fingerprint !== opts.fingerprint)
  next.push({
    fingerprint: opts.fingerprint,
    call: opts.call,
    decision: opts.decision,
    decidedAt: new Date().toISOString(),
  })
  next.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint))
  const out = { version: REVIEW_LEDGER_VERSION, decisions: next }
  await saveLedger(opts.ledger, out)
  return out
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
          call: string
          fingerprint: string
          readConfidence: number
          writeConfidence: number
          reasons: string[]
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
        call: item.call,
        fingerprint: item.fingerprint,
        readConfidence: item.readConfidence,
        writeConfidence: item.writeConfidence,
        reasons: item.reasons,
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
    if (!opts.reviewJson) {
      console.log(`Recorded ${next.decision} for ${next.fingerprint} in ${opts.ledger}`)
      return
    }
  }

  const report = await scan({
    db: opts.db,
    since: opts.since,
    samples: opts.samples,
  })
  if (opts.reviewJson) {
    console.log(JSON.stringify(await review(report, { ledger: opts.ledger }), null, 2))
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
