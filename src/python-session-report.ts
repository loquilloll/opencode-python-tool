import { Database } from "bun:sqlite"
import { createHash } from "crypto"
import { spawn } from "child_process"
import { mkdir } from "fs/promises"
import os from "os"
import path from "path"
import * as rl from "readline"
import { fileURLToPath } from "url"
import { analyzeDetailed } from "./python/python-analyze"
import { analyzerMetadata, type PythonEventEvidence } from "./python/python-ir"

type ReviewDecision = "read" | "write" | "emit" | "exec" | "pure" | "ignore" | "needs-code"
type ScoreCategory = "read" | "write" | "emit" | "exec" | "pure" | "unknown"
type ConfidenceStore = Record<ScoreCategory, number>

type Opts = {
  db: string
  since?: number
  json: boolean
  samples: number
  analyzerRules: string
  analyzerRulesExplicit: boolean
  rules: string
  scoreCache: string
  update: boolean
  promoteReviewed: boolean
  ledger: string
  reviewJson: boolean
  reviewNext: boolean
  reviewTui: boolean
  reviewFamilies: boolean
  reviewFamiliesJson: boolean
  family?: string
  module?: string
  suggestRules: boolean
  compareRules?: string
  includeEmit: boolean
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
  sourceCall?: string
  canonicalSource: string
  evidence?: PythonEventEvidence
  fingerprint: string
  snippetFingerprint: string
  code: string
  confidence: ConfidenceStore
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
  analyzerVersion: string
  engineVersion: string
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

function isOccurrenceKind(value: unknown): value is Occurrence["kind"] {
  return value === "unknown" || value === "emit" || value === "pure"
}

type ReviewIdentity = {
  kind: Occurrence["kind"]
  call: string
  sourceCall?: string
}

function reviewKeyOf(value: ReviewIdentity) {
  return `${value.kind}\n${value.sourceCall ?? value.call}`
}

type ReviewDecisionRecord = {
  fingerprint: string
  kind?: Occurrence["kind"]
  call?: string
  sourceCall?: string
  decision: ReviewDecision
  decidedAt: string
}

type ReviewLedger = {
  version: number
  decisions: ReviewDecisionRecord[]
}

type DecisionLookup = {
  byFingerprint: Map<string, ReviewDecision>
  byReviewKey: Map<string, ReviewDecision>
}

export type ReviewQueue = {
  generatedAt: string
  db: string
  ledger: string
  analyzerVersion: string
  engineVersion: string
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
        sourceCall?: string
        canonicalSource: string
        evidence?: PythonEventEvidence
        fingerprint: string
      confidence: ConfidenceStore
      readConfidence: number
      writeConfidence: number
      reasons: string[]
      scoreSource: string
      decision?: ReviewDecision
    }>
  }>
}

export type ReviewFamilyRecommendation = "rule" | "provenance" | "manual-split" | "blocked"

export type ReviewFamilyCluster = {
  familyKey: string
  kind: Occurrence["kind"]
  canonicalSource: string
  aliases: string[]
  evidenceBits: string[]
  evidenceKeys: string[]
  occurrenceCount: number
  snippetCount: number
  trustedCanonicalSource: boolean
  variantCount: number
  representativeCoverageIncomplete: boolean
  moduleRootHint?: string
  recommendation: ReviewFamilyRecommendation
  reasons: string[]
  representatives: Array<{
    snippetFingerprint: string
    candidateFingerprint: string
    call: string
    sourceCall?: string
    preview: string
  }>
}

export type ReviewFamilyModule = {
  moduleRoot: string
  occurrenceCount: number
  familyCount: number
  recommendationCounts: Record<ReviewFamilyRecommendation, number>
  families: Array<{ kind: Occurrence["kind"]; canonicalSource: string }>
}

export type ReviewFamilySummaryReport = {
  generatedAt: string
  db: string
  ledger: string
  analyzerVersion: string
  engineVersion: string
  filters: ReviewQueue["filters"]
  selectors: ReviewSelectors
  totals: ReviewQueue["totals"] & {
    families: number
    modules: number
  }
  modules: ReviewFamilyModule[]
  families: ReviewFamilyCluster[]
}

type ReviewSelectors = {
  family?: string
  module?: string
}

type SuggestionDecision = "read" | "write" | "emit" | "exec" | "pure"

export type RuleSuggestionReport = {
  generatedAt: string
  db: string
  ledger: string
  rules: string
  totals: {
    suggested: number
    blocked: number
  }
  suggestions: Array<{
    call: string
    aliases: string[]
    decision: SuggestionDecision
    canonicalSource?: string
    occurrences: number
    snippetCount: number
    examples: string[]
    fragment: Record<string, unknown>
    reason: string
  }>
  blocked: Array<{
    call: string
    occurrences: number
    reasons: string[]
  }>
}

export type RulesCompareReport = {
  generatedAt: string
  db: string
  currentRules: string
  alternateRules: string
  baseline: {
    unknownEvents: number
    uniqueUnknownCalls: number
    pendingCandidates: number
    suggestedRules: number
  }
  alternate: {
    unknownEvents: number
    uniqueUnknownCalls: number
    pendingCandidates: number
    suggestedRules: number
  }
  resolvedUnknownCalls: string[]
  newUnknownCalls: string[]
  addedSuggestions: string[]
  removedSuggestions: string[]
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
  confidence: ConfidenceStore
  readConfidence: number
  writeConfidence: number
  reasons: string[]
  scoreSource: string
  legacy?: boolean
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
const REVIEW_DECISIONS = ["read", "write", "emit", "exec", "pure", "ignore", "needs-code"] as const
const SCORE_CACHE_VERSION = 1
const SCORE_PROMPT_VERSION = 2
const SCORE_TIMEOUT = 30000
const SCORE_CATEGORIES = ["read", "write", "emit", "exec", "pure", "unknown"] as const
const SUGGEST_GAP = 0.3
const PY_KEYWORDS = /\b(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield)\b/g
const PY_STRINGS = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  keyword: "\x1b[38;5;75m",
  string: "\x1b[38;5;114m",
  comment: "\x1b[38;5;244m",
  call: "\x1b[1;30;103m",
  focus: "\x1b[1;33m",
}

function usage() {
  return [
    "Usage: bun src/python-session-report.ts [options]",
    "",
    "Options:",
    "  --db <path>      Override OpenCode session database path",
    "  --ledger <path>  Override review-ledger JSON path",
    "  --analyzer-rules <path>  Override scan-time analyzer rules JSON path",
    "  --rules <path>   Override writable rules JSON path",
    "  --score-cache <path>  Override review score-cache JSON path",
    "  --since <iso>    Only scan rows updated at or after this ISO timestamp",
    "  --samples <n>    Sample sessions/previews per unknown callable (default: 3)",
    "  --include-emit  Include emit analyzer events in review queues",
    "  --include-pure  Include pure analyzer events in review queues",
    "  --update-candidates  Write findings into candidates.unknown",
    "  --promote-reviewed  Promote consistently reviewed callables into calls.read/write/emit/exec",
    "  --review-json    Emit snippet-centric review queue JSON",
    "  --review-next    Show the next pending snippet review item",
    "  --review-tui     Launch one-key interactive review UI",
    "  --review-families  Emit read-only family summary text",
    "  --review-families-json  Emit read-only family summary JSON",
    "  --family <canonical-source>  Filter family summary or review-next by exact canonical source",
    "  --module <module-root>  Filter family summary or review-next by exact trusted module root",
    "  --suggest-rules  Emit preview-only rule suggestions from reviewed evidence",
    "  --compare-rules <file>  Diff report/review/suggestion output against an alternate rules file",
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

function defAnalyzerRules() {
  return process.env.OPENCODE_PYTHON_RULES ? path.resolve(process.env.OPENCODE_PYTHON_RULES) : defrules()
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

function paint(text: string, color: string) {
  return `${color}${text}${ANSI.reset}`
}

function escaped(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function callPattern(call: string) {
  return new RegExp(`(^|[^A-Za-z0-9_])(${escaped(call)})(?=$|[^A-Za-z0-9_])`, "g")
}

function hasCall(text: string, call: string) {
  if (!call) return false
  const pattern = new RegExp(`(^|[^A-Za-z0-9_])${escaped(call)}(?=$|[^A-Za-z0-9_])`)
  return pattern.test(text)
}

function pythonLine(text: string) {
  const strings: string[] = []
  const masked = text.replace(PY_STRINGS, (value) => {
    const token = `\u0000${strings.length}\u0000`
    strings.push(paint(value, ANSI.string))
    return token
  })
  const pivot = masked.indexOf("#")
  const body = pivot >= 0 ? masked.slice(0, pivot) : masked
  const comment = pivot >= 0 ? masked.slice(pivot) : ""
  const themed = body.replace(PY_KEYWORDS, (value) => paint(value, ANSI.keyword)) + (comment ? paint(comment, ANSI.comment) : "")
  return themed.replace(/\u0000(\d+)\u0000/g, (_value, index) => strings[Number(index)] ?? "")
}

function defaults(kind: Occurrence["kind"] = "unknown"): ConfidenceStore {
  if (kind === "emit") {
    return {
      read: 0.08,
      write: 0.08,
      emit: 0.82,
      exec: 0.04,
      pure: 0.03,
      unknown: 0.2,
    }
  }
  if (kind === "pure") {
    return {
      read: 0.08,
      write: 0.05,
      emit: 0.05,
      exec: 0.03,
      pure: 0.82,
      unknown: 0.2,
    }
  }
  return {
    read: 0.1,
    write: 0.1,
    emit: 0.05,
    exec: 0.08,
    pure: 0.05,
    unknown: 0.55,
  }
}

function clipped(store: ConfidenceStore): ConfidenceStore {
  return {
    read: clamp(store.read),
    write: clamp(store.write),
    emit: clamp(store.emit),
    exec: clamp(store.exec),
    pure: clamp(store.pure),
    unknown: clamp(store.unknown),
  }
}

function fromLegacy(kind: Occurrence["kind"], read: number, write: number): ConfidenceStore {
  const confidence = defaults(kind)
  confidence.read = clamp(read)
  confidence.write = clamp(write)
  if (kind === "emit") confidence.emit = Math.max(confidence.emit, 0.85)
  if (kind === "pure") confidence.pure = Math.max(confidence.pure, 0.85)
  if (kind === "unknown") confidence.unknown = Math.max(confidence.unknown, 0.55)
  return clipped(confidence)
}

function parseConfidence(input: unknown, label: string): ConfidenceStore {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail(`${label} must be an object`)
  const data = input as Record<string, unknown>
  const confidence = {} as ConfidenceStore
  for (const key of SCORE_CATEGORIES) {
    const value = data[key]
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 0.99) {
      fail(`${label}.${key} must be a number between 0 and 0.99`)
    }
    confidence[key] = clamp(value)
  }
  return confidence
}

function viewConfidence(item: ConfidenceStore) {
  return SCORE_CATEGORIES.map((kind) => `${kind}=${item[kind]}`).join(" ")
}

function strongest(store: ConfidenceStore, kinds: readonly ScoreCategory[]) {
  return kinds.reduce((best, next) => (store[next] > store[best] ? next : best), kinds[0])
}

function decideFrom(kind: ScoreCategory): ReviewDecision {
  if (kind === "read") return "read"
  if (kind === "write") return "write"
  if (kind === "emit") return "emit"
  if (kind === "pure") return "pure"
  return "ignore"
}

function isDecision(input: string): input is ReviewDecision {
  return REVIEW_DECISIONS.includes(input as ReviewDecision)
}

function score(call: string, code: string, kind: Occurrence["kind"]) {
  const lowCall = call.toLowerCase()
  const lowTail = tail(call).toLowerCase()
  const lowCode = code.toLowerCase()
  const confidence = defaults(kind)
  const reasons: string[] = []
  const httpLike =
    /https?:\/\//.test(lowCode) ||
    /\brequests\b/.test(lowCode) ||
    /\bhttpx\b/.test(lowCode) ||
    /\burllib\.request\b/.test(lowCode) ||
    /\baiohttp\b/.test(lowCode) ||
    /\b(url|uri|endpoint|api)\b/.test(lowCode)

  const add = (bucket: ScoreCategory, amount: number, reason: string) => {
    confidence[bucket] += amount
    if (!reasons.includes(reason) && reasons.length < 3) reasons.push(reason)
  }

  if (["requests.get", "requests.head", "requests.options", "httpx.get", "httpx.head", "httpx.options"].includes(lowCall)) {
    add("read", 0.7, "call matches explicit HTTP read helper")
  }
  if (["requests.post", "requests.put", "requests.patch", "requests.delete", "httpx.post", "httpx.put", "httpx.patch", "httpx.delete"].includes(lowCall)) {
    add("write", 0.7, "call matches explicit HTTP write helper")
  }
  for (const hint of ["read", "load", "fetch", "download"]) {
    if (lowTail.includes(hint)) add("read", 0.45, `call name suggests ${hint}`)
  }
  if (httpLike && ["get", "head", "options"].includes(lowTail)) {
    add("read", lowTail === "get" ? 0.35 : 0.25, `HTTP-like snippet uses ${lowTail}`)
  }
  for (const hint of ["write", "save", "dump", "unlink", "touch", "mkdir", "rename", "replace", "move", "copy", "upload"]) {
    if (lowTail.includes(hint)) add("write", 0.45, `call name suggests ${hint}`)
  }
  if (httpLike && ["post", "put", "patch", "delete"].includes(lowTail)) {
    add("write", ["post", "put", "patch"].includes(lowTail) ? 0.35 : 0.25, `HTTP-like snippet uses ${lowTail}`)
  }
  for (const hint of ["print", "log", "logger", "metric", "trace", "warn", "info", "error", "debug"]) {
    if (lowTail.includes(hint)) add("emit", hint === "print" ? 0.5 : 0.35, `call name suggests ${hint}`)
  }
  for (const hint of ["exec", "system", "popen", "spawn", "fork", "compile", "eval", "run", "trigger"]) {
    if (lowTail.includes(hint)) add("exec", ["run", "trigger"].includes(hint) ? 0.2 : 0.45, `call name suggests ${hint}`)
  }
  for (const hint of ["match", "search", "findall", "parse", "format", "normalize", "strip", "split"]) {
    if (lowTail.includes(hint)) add("pure", ["parse", "format"].includes(hint) ? 0.2 : 0.35, `call name suggests ${hint}`)
  }
  if (/open\s*\([^\n]*['"]r[a-z+]*['"]/.test(lowCode)) add("read", 0.2, "snippet opens a file in read mode")
  if (/open\s*\([^\n]*['"][wax+][a-z+]*['"]/.test(lowCode)) add("write", 0.2, "snippet opens a file in write mode")
  if (/\bprint\s*\(/.test(lowCode) || /\blog(?:ger)?\./.test(lowCode)) add("emit", 0.35, "snippet shows output or logging")
  if (/\bsubprocess\.|\bos\.system\s*\(|\beval\s*\(|\bexec\s*\(|\bcompile\s*\(/.test(lowCode)) {
    add("exec", 0.35, "snippet includes dynamic or subprocess execution")
  }
  if (/\bre\.(search|match|findall|finditer)\s*\(/.test(lowCode)) add("pure", 0.35, "snippet uses regex extraction patterns")
  if (/\b(path|file|src|input)\b/.test(lowCode)) add("read", 0.1, "snippet references input-like names")
  if (/\b(dst|output|target)\b/.test(lowCode) || /\b(write|save|dump)\b/.test(lowCode)) {
    add("write", 0.1, "snippet references output-like names")
  }

  const out = clipped(confidence)
  return {
    confidence: out,
    readConfidence: out.read,
    writeConfidence: out.write,
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
    .map((item) => [`- fingerprint: ${item.fingerprint}`, `  call: ${item.call}`, `  kind: ${item.kind}`].join("\n"))
    .join("\n")
  return [
    "Return JSON only. Do not use tools. Do not ask questions.",
    "You are scoring Python callables for a review tool.",
    "For each candidate, estimate confidence scores for read, write, emit, exec, pure, and unknown based only on the snippet.",
    "Use this exact JSON shape:",
    '{"scores":[{"fingerprint":"...","call":"...","confidence":{"read":0.0,"write":0.0,"emit":0.0,"exec":0.0,"pure":0.0,"unknown":0.0},"reasons":["..."]}]}',
    "Rules:",
    "- include every candidate exactly once",
    "- include all six confidence keys for every candidate",
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

function scoremeta(input: unknown, label: string) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail(`${label} must be an object`)
  const row = input as Record<string, unknown>
  if (typeof row.fingerprint !== "string" || !row.fingerprint) fail(`${label}.fingerprint must be a string`)
  if (typeof row.call !== "string" || !row.call) fail(`${label}.call must be a string`)
  return { row, fingerprint: row.fingerprint, call: row.call }
}

function scorerow(row: Record<string, unknown>, label: string, kind: Occurrence["kind"] = "unknown"): ScoreRow {
  const legacy = row.confidence === undefined
  let confidence: ConfidenceStore
  if (!legacy) {
    confidence = parseConfidence(row.confidence, `${label}.confidence`)
  } else {
    if (typeof row.readConfidence !== "number" || !Number.isFinite(row.readConfidence) || row.readConfidence < 0 || row.readConfidence > 0.99) {
      fail(`${label}.readConfidence must be a number between 0 and 0.99`)
    }
    if (typeof row.writeConfidence !== "number" || !Number.isFinite(row.writeConfidence) || row.writeConfidence < 0 || row.writeConfidence > 0.99) {
      fail(`${label}.writeConfidence must be a number between 0 and 0.99`)
    }
    confidence = fromLegacy(kind, row.readConfidence, row.writeConfidence)
  }
  return {
    fingerprint: row.fingerprint as string,
    call: row.call as string,
    confidence,
    readConfidence: confidence.read,
    writeConfidence: confidence.write,
    reasons: Array.isArray(row.reasons) ? row.reasons.filter((item): item is string => typeof item === "string").slice(0, 3) : [],
    scoreSource: "opencode-run",
    legacy,
  }
}

function parseoutput(text: string, item: ReviewSnippet) {
  const raw = JSON.parse(unwrap(text)) as { scores?: unknown }
  if (!Array.isArray(raw.scores)) fail("Scorer JSON must include scores[]")
  const want = new Map(item.candidates.map((item) => [item.fingerprint, item]))
  const out = new Map<string, ScoreRow>()
  for (let i = 0; i < raw.scores.length; i++) {
    const label = `scores[${i}]`
    const meta = scoremeta(raw.scores[i], label)
    const hit = want.get(meta.fingerprint)
    if (!hit) fail(`Unexpected scorer fingerprint: ${meta.fingerprint}`)
    if (hit.call !== meta.call) fail(`Scorer call mismatch for ${meta.fingerprint}`)
    if (out.has(meta.fingerprint)) fail(`Duplicate scorer fingerprint: ${meta.fingerprint}`)
    out.set(meta.fingerprint, scorerow(meta.row, label, hit.kind))
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
            scores: Array.isArray(row.scores)
              ? row.scores.map((item, i) => {
                  const label = `cache.scores[${i}]`
                  const meta = scoremeta(item, label)
                  return scorerow(meta.row, label)
                })
              : [],
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
      const confidence = hit.legacy ? fromLegacy(item.kind, hit.readConfidence, hit.writeConfidence) : hit.confidence
      return {
        ...item,
        confidence,
        readConfidence: confidence.read,
        writeConfidence: confidence.write,
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
    analyzerRules: defAnalyzerRules(),
    analyzerRulesExplicit: false,
    rules: defrules(),
    scoreCache: defscorecache(),
    reviewJson: false,
    reviewNext: false,
    reviewTui: false,
    reviewFamilies: false,
    reviewFamiliesJson: false,
    suggestRules: false,
    includeEmit: false,
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
    if (arg === "--include-emit") {
      opts.includeEmit = true
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
    if (arg === "--review-families") {
      opts.reviewFamilies = true
      continue
    }
    if (arg === "--review-families-json") {
      opts.reviewFamiliesJson = true
      continue
    }
    if (arg === "--family") {
      const val = args[++i]
      if (!val) fail("Missing value for --family")
      opts.family = val
      continue
    }
    if (arg === "--module") {
      const val = args[++i]
      if (!val) fail("Missing value for --module")
      opts.module = val
      continue
    }
    if (arg === "--suggest-rules") {
      opts.suggestRules = true
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
    if (arg === "--analyzer-rules") {
      const val = args[++i]
      if (!val) fail("Missing value for --analyzer-rules")
      opts.analyzerRules = path.resolve(val)
      opts.analyzerRulesExplicit = true
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
    if (arg === "--compare-rules") {
      const val = args[++i]
      if (!val) fail("Missing value for --compare-rules")
      opts.compareRules = path.resolve(val)
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

  if (opts.json && (opts.reviewJson || opts.reviewNext || opts.reviewTui || opts.reviewFamilies || opts.reviewFamiliesJson || opts.promoteReviewed)) fail("Use --json only with scan, suggest, or compare output")
  if ([opts.reviewJson, opts.reviewNext, opts.reviewTui, opts.reviewFamilies, opts.reviewFamiliesJson].filter(Boolean).length > 1) {
    fail("Use only one of --review-json, --review-next, --review-tui, --review-families, or --review-families-json")
  }
  if (opts.suggestRules && (opts.reviewJson || opts.reviewNext || opts.reviewTui || opts.reviewFamilies || opts.reviewFamiliesJson || opts.update || opts.promoteReviewed)) {
    fail("--suggest-rules cannot be combined with review, update, or promotion modes")
  }
  if (opts.compareRules && (opts.reviewJson || opts.reviewNext || opts.reviewTui || opts.reviewFamilies || opts.reviewFamiliesJson || opts.update || opts.promoteReviewed || opts.suggestRules)) {
    fail("--compare-rules cannot be combined with review, update, promotion, or suggest modes")
  }
  if (opts.analyzerRulesExplicit && opts.compareRules) fail("--analyzer-rules cannot be combined with --compare-rules; compare mode already uses --rules and --compare-rules")
  if (opts.recordDecision && (opts.suggestRules || opts.compareRules || opts.reviewFamilies || opts.reviewFamiliesJson)) {
    fail("--record-decision cannot be combined with suggest, compare, or family summary modes")
  }
  if (opts.decide && !opts.reviewNext) fail("--decide requires --review-next")
  if (opts.recordDecision && opts.reviewTui) fail("--record-decision cannot be combined with --review-tui")
  if (opts.update && (opts.reviewJson || opts.reviewNext || opts.reviewTui || opts.reviewFamilies || opts.reviewFamiliesJson || opts.promoteReviewed)) {
    fail("--update-candidates cannot be combined with review or promotion modes")
  }
  if (opts.promoteReviewed && (opts.reviewJson || opts.reviewNext || opts.reviewTui || opts.reviewFamilies || opts.reviewFamiliesJson)) {
    fail("--promote-reviewed cannot be combined with review modes")
  }
  if (opts.promoteReviewed && opts.since !== undefined) {
    fail("--promote-reviewed requires a full scan; omit --since")
  }
  if (opts.family && opts.module) fail("Use only one of --family or --module")
  if ((opts.family || opts.module) && !(opts.reviewFamilies || opts.reviewFamiliesJson || opts.reviewNext)) {
    fail("--family/--module require --review-families, --review-families-json, or --review-next")
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

export async function scan(opts: {
  db: string
  since?: number
  samples?: number
  includeEmit?: boolean
  includePure?: boolean
}): Promise<Report> {
  if (!(await Bun.file(opts.db).exists())) fail(`OpenCode session database not found: ${opts.db}`)

  const db = new Database(opts.db, { readonly: true })
  const sample = opts.samples ?? 3
  const includeEmit = opts.includeEmit ?? false
  const includePure = opts.includePure ?? false
  const analyzedMetadata = analyzerMetadata()

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

      const events = (await analyzeDetailed(item.code)).events
      for (const event of events) {
        let kind: Occurrence["kind"] | undefined
        let call: string | undefined

        if (event.kind === "unknown") {
          if (!event.call.startsWith("callable:")) continue
          if (event.evidence?.localDefinition) continue
          kind = "unknown"
          call = event.call.slice("callable:".length)
          unknownEvents++
        } else if (event.kind === "emit" && includeEmit) {
          kind = "emit"
          call = event.call
        } else if (event.kind === "pure" && includePure) {
          kind = "pure"
          call = event.call
        } else {
          continue
        }

        const time = row.time_updated || row.time_created
        const scored = score(call, item.code, kind)
        const normalizedCode = normalized(item.code)
        const seed = kind === "unknown" ? `${call}\n${normalizedCode}` : `${kind}\n${call}\n${normalizedCode}`
        occurrences.push({
          kind,
          call,
          sourceCall: event.sourceCall,
          canonicalSource: event.sourceCall ?? call,
          evidence: event.evidence,
          fingerprint: fingerprint(seed),
          snippetFingerprint: fingerprint(normalizedCode),
          sessionID: row.session_id,
          messageID: row.message_id,
          partID: row.part_id,
          title: row.title || "<untitled session>",
          time: when(time),
          preview: clip(item.code),
          code: item.code,
          confidence: scored.confidence,
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
      analyzerVersion: analyzedMetadata.analyzerVersion,
      engineVersion: analyzedMetadata.engineVersion,
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
  const kind = isOccurrenceKind(row.kind) ? row.kind : row.kind === undefined ? undefined : fail(`Invalid review ledger: ${file}`)
  const call = typeof row.call === "string" ? row.call : undefined
  if (kind && !call) fail(`Invalid review ledger: ${file}`)
  return {
    fingerprint: row.fingerprint,
    kind,
    call,
    sourceCall: typeof row.sourceCall === "string" ? row.sourceCall : undefined,
    decision: row.decision,
    decidedAt: typeof row.decidedAt === "string" ? row.decidedAt : new Date(0).toISOString(),
  }
}

function decisionIdentity(
  item: Pick<ReviewDecisionRecord, "kind" | "call" | "sourceCall">,
  fallback?: Pick<Occurrence, "kind" | "call" | "sourceCall">,
): ReviewIdentity | undefined {
  if (item.kind && item.call) return { kind: item.kind, call: item.call, sourceCall: item.sourceCall }
  if (!fallback) return
  if (item.call && item.call !== fallback.call) return
  return {
    kind: fallback.kind,
    call: fallback.call,
    sourceCall: fallback.sourceCall,
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
  decisions: Array<{
    fingerprint: string
    decision: ReviewDecision
    kind?: Occurrence["kind"]
    call?: string
    sourceCall?: string
  }>
}) {
  const data = await ledger(opts.ledger)
  const next = data.decisions.filter((item) => !opts.decisions.some((decision) => decision.fingerprint === item.fingerprint))
  for (const item of opts.decisions) {
    next.push({
      fingerprint: item.fingerprint,
      kind: item.kind,
      call: item.call,
      sourceCall: item.sourceCall,
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
  if (!isDecision(outcome)) fail("--record-decision must use read, write, emit, exec, pure, ignore, or needs-code")
  return { fingerprint, decision: outcome }
}

export async function recordDecision(opts: {
  ledger: string
  fingerprint: string
  decision: ReviewDecision
  kind?: Occurrence["kind"]
  call?: string
  sourceCall?: string
}) {
  return writeDecisions({ ledger: opts.ledger, decisions: [opts] })
}

export async function review(report: Report, opts: { ledger: string }): Promise<ReviewQueue> {
  const data = await ledger(opts.ledger)
  const decided = decisionLookup(data, report)
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
          sourceCall?: string
          canonicalSource: string
          evidence?: PythonEventEvidence
          fingerprint: string
          confidence: ConfidenceStore
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
    const candidateKey = reviewCandidateKey(item)
    if (!snippet.candidates.has(candidateKey)) {
        const candidateFingerprint = fingerprint(candidateKey)
        snippet.candidates.set(candidateKey, {
          kind: item.kind,
          call: item.call,
          sourceCall: item.sourceCall,
          canonicalSource: item.canonicalSource,
          evidence: item.evidence,
          fingerprint: candidateFingerprint,
          confidence: item.confidence,
          readConfidence: item.readConfidence,
          writeConfidence: item.writeConfidence,
          reasons: item.reasons,
          scoreSource: item.scoreSource,
          decision: resolvedDecision(decided, item),
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
    analyzerVersion: report.analyzerVersion,
    engineVersion: report.engineVersion,
    filters: report.filters,
    totals: {
      snippets: out.length,
      pendingCandidates,
      decidedCandidates,
    },
    snippets: out,
  }
}

function familyModuleRootHint(canonicalSource: string, trustedCanonicalSource: boolean) {
  if (!trustedCanonicalSource) return
  const parts = canonicalSource.split(".")
  if (parts.length < 2) return
  const prefix = parts.slice(0, -1)
  if (!prefix.length || prefix.some((item) => !/^[a-z_][a-z0-9_]*$/.test(item))) return
  return prefix.join(".")
}

function familyRecommendation(opts: {
  aliases: string[]
  canonicalSources: string[]
  evidenceBits: string[]
  evidenceKeys: string[]
  canonicalSource: string
  trustedCanonicalSource: boolean
}) {
  const reasons: string[] = []
  if (opts.canonicalSources.length > 1) reasons.push("multiple canonical sources")
  if (opts.aliases.length > 1) reasons.push("multiple outward aliases")
  if (opts.evidenceKeys.length > 1) reasons.push("multiple evidence signatures")

  if (opts.canonicalSources.length > 1) return { recommendation: "blocked" as const, reasons }
  if (opts.aliases.length > 1 || opts.evidenceKeys.length > 1) return { recommendation: "manual-split" as const, reasons }
  if (!opts.trustedCanonicalSource) {
    reasons.push("canonical source is not provenance-backed")
    return { recommendation: "blocked" as const, reasons }
  }
  if (opts.canonicalSource !== opts.aliases[0] || opts.evidenceBits.length) {
    if (opts.canonicalSource !== opts.aliases[0]) reasons.push("canonical source differs from outward alias")
    if (opts.evidenceBits.length) reasons.push("receiver or guard evidence present")
    return { recommendation: "provenance" as const, reasons }
  }
  reasons.push("direct canonical family is stable")
  return { recommendation: "rule" as const, reasons }
}

export function reviewFamilies(queue: ReviewQueue): ReviewFamilyCluster[] {
  const byFamily = new Map<
    string,
    {
      kind: Occurrence["kind"]
      aliases: Set<string>
      canonicalSources: Set<string>
      trustedCanonicalSource: boolean
      evidenceBits: Set<string>
      evidenceKeys: Set<string>
      occurrenceCount: number
      snippets: Set<string>
      representatives: Array<ReviewFamilyCluster["representatives"][number] & { evidenceKey: string }>
    }
  >()

  for (const snippet of queue.snippets) {
    for (const candidate of snippet.candidates) {
      if (candidate.decision) continue
      const familyKey = reviewKeyOf(candidate)
      const row = byFamily.get(familyKey) ?? {
        kind: candidate.kind,
        aliases: new Set<string>(),
        canonicalSources: new Set<string>(),
        trustedCanonicalSource: true,
        evidenceBits: new Set<string>(),
        evidenceKeys: new Set<string>(),
        occurrenceCount: 0,
        snippets: new Set<string>(),
        representatives: [],
      }
      row.aliases.add(candidate.call)
      row.canonicalSources.add(candidate.canonicalSource)
      const currentEvidenceKey = evidenceKey(candidate.evidence)
      row.evidenceKeys.add(currentEvidenceKey)
      for (const bit of evidenceBits(candidate.evidence)) row.evidenceBits.add(bit)
      row.occurrenceCount += snippet.occurrences.length
      row.snippets.add(snippet.snippetFingerprint)
      row.trustedCanonicalSource &&= Boolean(candidate.sourceCall)
      row.representatives.push({
        snippetFingerprint: snippet.snippetFingerprint,
        candidateFingerprint: candidate.fingerprint,
        call: candidate.call,
        sourceCall: candidate.sourceCall,
        preview: snippet.preview,
        evidenceKey: currentEvidenceKey,
      })
      byFamily.set(familyKey, row)
    }
  }

  return [...byFamily.entries()]
    .map(([familyKey, row]) => {
      const aliases = [...row.aliases].sort((a, b) => a.localeCompare(b))
      const canonicalSources = [...row.canonicalSources].sort((a, b) => a.localeCompare(b))
      const currentEvidenceKeys = [...row.evidenceKeys].sort((a, b) => a.localeCompare(b))
      const currentEvidenceBits = [...row.evidenceBits].sort((a, b) => a.localeCompare(b))
      const canonicalSource = canonicalSources[0] ?? aliases[0] ?? ""
      const trustedCanonicalSource = row.trustedCanonicalSource
      const recommendation = familyRecommendation({
        aliases,
        canonicalSources,
        evidenceBits: currentEvidenceBits,
        evidenceKeys: currentEvidenceKeys,
        canonicalSource,
        trustedCanonicalSource,
      })
      const representatives = new Map<string, (typeof row.representatives)[number]>()
      for (const item of [...row.representatives].sort((a, b) => a.call.localeCompare(b.call) || a.evidenceKey.localeCompare(b.evidenceKey) || a.snippetFingerprint.localeCompare(b.snippetFingerprint) || a.candidateFingerprint.localeCompare(b.candidateFingerprint))) {
        const key = `${item.call}\n${item.evidenceKey}`
        if (!representatives.has(key)) representatives.set(key, item)
      }
      const variantCount = representatives.size
      return {
        familyKey,
        kind: row.kind,
        canonicalSource,
        aliases,
        evidenceBits: currentEvidenceBits,
        evidenceKeys: currentEvidenceKeys,
        occurrenceCount: row.occurrenceCount,
        snippetCount: row.snippets.size,
        trustedCanonicalSource,
        variantCount,
        representativeCoverageIncomplete: variantCount > 3,
        moduleRootHint: familyModuleRootHint(canonicalSource, trustedCanonicalSource),
        recommendation: recommendation.recommendation,
        reasons: recommendation.reasons,
        representatives: [...representatives.values()]
          .map(({ snippetFingerprint, candidateFingerprint, call, sourceCall, preview }) => ({
            snippetFingerprint,
            candidateFingerprint,
            call,
            sourceCall,
            preview,
          }))
          .slice(0, 3),
      } satisfies ReviewFamilyCluster
    })
    .sort(
      (a, b) =>
        b.occurrenceCount - a.occurrenceCount ||
        b.snippetCount - a.snippetCount ||
        a.canonicalSource.localeCompare(b.canonicalSource) ||
        a.familyKey.localeCompare(b.familyKey),
    )
}

export function selectReviewFamilies(queue: ReviewQueue, selectors: ReviewSelectors = {}): ReviewFamilyCluster[] {
  const families = reviewFamilies(queue)
  if (selectors.family) return families.filter((item) => item.canonicalSource === selectors.family)
  if (selectors.module) return families.filter((item) => item.moduleRootHint === selectors.module)
  return families
}

export function filterReviewQueue(queue: ReviewQueue, selectors: ReviewSelectors = {}): ReviewQueue {
  if (!selectors.family && !selectors.module) return queue
  const selectedFamilies = selectReviewFamilies(queue, selectors)
  const allowed = new Set(selectedFamilies.map((item) => item.familyKey))
  const preferred = new Map<string, number>()
  let rank = 0
  for (const family of selectedFamilies) {
    for (const rep of family.representatives) {
      if (!preferred.has(rep.snippetFingerprint)) preferred.set(rep.snippetFingerprint, rank++)
    }
  }
  const snippets = queue.snippets
    .map((snippet, index) => ({
      ...snippet,
      _index: index,
      candidates: snippet.candidates.filter((candidate) => allowed.has(reviewKeyOf(candidate))),
    }))
    .filter((snippet) => snippet.candidates.length > 0)
    .sort((a, b) => {
      const left = preferred.get(a.snippetFingerprint)
      const right = preferred.get(b.snippetFingerprint)
      if (left !== undefined && right !== undefined) return left - right || a._index - b._index
      if (left !== undefined) return -1
      if (right !== undefined) return 1
      return a._index - b._index
    })
    .map(({ _index, ...snippet }) => snippet)

  let pendingCandidates = 0
  let decidedCandidates = 0
  for (const snippet of snippets) {
    for (const candidate of snippet.candidates) {
      if (candidate.decision) decidedCandidates++
      else pendingCandidates++
    }
  }

  return {
    ...queue,
    totals: {
      snippets: snippets.length,
      pendingCandidates,
      decidedCandidates,
    },
    snippets,
  }
}

export function reviewFamilySummary(queue: ReviewQueue, selectors: ReviewSelectors = {}): ReviewFamilySummaryReport {
  const filteredQueue = filterReviewQueue(queue, selectors)
  const families = selectReviewFamilies(filteredQueue)
  const byModule = new Map<string, ReviewFamilyModule>()
  for (const family of families) {
    if (!family.moduleRootHint) continue
    const current: ReviewFamilyModule = byModule.get(family.moduleRootHint) ?? {
      moduleRoot: family.moduleRootHint,
      occurrenceCount: 0,
      familyCount: 0,
      recommendationCounts: { rule: 0, provenance: 0, "manual-split": 0, blocked: 0 },
      families: [],
    }
    current.occurrenceCount += family.occurrenceCount
    current.familyCount += 1
    current.recommendationCounts[family.recommendation] += 1
    current.families.push({ kind: family.kind, canonicalSource: family.canonicalSource })
    byModule.set(family.moduleRootHint, current)
  }

  const modules = [...byModule.values()]
    .map((item) => ({
      ...item,
      families: item.families.sort((a, b) => a.canonicalSource.localeCompare(b.canonicalSource) || a.kind.localeCompare(b.kind)),
    }))
    .sort((a, b) => b.occurrenceCount - a.occurrenceCount || b.familyCount - a.familyCount || a.moduleRoot.localeCompare(b.moduleRoot))

  return {
    generatedAt: new Date().toISOString(),
    db: filteredQueue.db,
    ledger: filteredQueue.ledger,
    analyzerVersion: filteredQueue.analyzerVersion,
    engineVersion: filteredQueue.engineVersion,
    filters: filteredQueue.filters,
    selectors,
    totals: {
      ...filteredQueue.totals,
      families: families.length,
      modules: modules.length,
    },
    modules,
    families,
  }
}

export function renderReviewFamilies(report: ReviewFamilySummaryReport) {
  const out = [
    `Database: ${report.db}`,
    `Ledger: ${report.ledger}`,
    report.filters.since ? `Since: ${report.filters.since}` : "Since: all time",
    report.selectors.family ? `Family filter: ${report.selectors.family}` : report.selectors.module ? `Module filter: ${report.selectors.module}` : "Filter: none",
    `Pending review candidates: ${report.totals.pendingCandidates}`,
    `Family clusters: ${report.totals.families}`,
    `Module rollups: ${report.totals.modules}`,
  ]

  if (report.modules.length) {
    out.push("", "Modules:")
    for (const item of report.modules) {
      const counts = Object.entries(item.recommendationCounts)
        .filter(([, value]) => value > 0)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ")
      out.push(`- ${item.moduleRoot} (${item.occurrenceCount} occurrences across ${item.familyCount} families${counts ? `; ${counts}` : ""})`)
      out.push(`  families: ${item.families.map((family) => `${family.canonicalSource} (${family.kind})`).join(", ")}`)
    }
  }

  if (!report.families.length) return `${out.join("\n")}\n\nNo pending family clusters.`

  out.push("", "Families:")
  for (const item of report.families) {
    out.push(`- ${item.canonicalSource} kind=${item.kind} [${item.recommendation}] (${item.occurrenceCount} occurrences, ${item.snippetCount} snippets, ${item.variantCount} variants)`)
    out.push(`  aliases: ${item.aliases.join(", ")}`)
    if (item.moduleRootHint) out.push(`  module: ${item.moduleRootHint}`)
    if (item.reasons.length) out.push(`  reasons: ${item.reasons.join("; ")}`)
    if (item.evidenceBits.length) out.push(`  evidence: ${item.evidenceBits.join(" | ")}`)
    for (const rep of item.representatives) out.push(`  - ${rep.snippetFingerprint} | ${rep.call} | ${rep.preview}`)
    if (item.representativeCoverageIncomplete) out.push(`  - ... ${item.variantCount - item.representatives.length} more variants not shown`)
  }

  return out.join("\n")
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
  if (!isDecision(right)) fail("--decide must use read, write, emit, exec, pure, ignore, or needs-code")
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
  const resolved: Array<{
    fingerprint: string
    decision: ReviewDecision
    kind?: Occurrence["kind"]
    call?: string
    sourceCall?: string
  }> = []
  for (const action of actions) {
    const target =
      action.kind === "index"
        ? opts.item.candidates[action.index - 1]
        : opts.item.candidates.find((item) => item.fingerprint === action.fingerprint)
    if (!target) fail(`Decision target not found: ${action.kind === "index" ? action.index : action.fingerprint}`)
    if (seen.has(target.fingerprint)) fail(`Duplicate decision target: ${target.fingerprint}`)
    seen.add(target.fingerprint)
    resolved.push({
      fingerprint: target.fingerprint,
      decision: action.decision,
      kind: target.kind,
      call: target.call,
      sourceCall: target.sourceCall,
    })
  }
  await writeDecisions({ ledger: opts.ledger, decisions: resolved })
}

export function renderReview(item: ReviewSnippet, family?: ReviewFamilyCluster) {
  const out = [
    `Snippet: ${item.snippetFingerprint}`,
    `Last seen: ${item.lastSeen}`,
    `Occurrences: ${item.occurrences.length}`,
  ]

  if (family) {
    out.push(`Family: ${family.canonicalSource} kind=${family.kind} [${family.recommendation}]`)
    if (family.moduleRootHint) out.push(`Module: ${family.moduleRootHint}`)
    if (family.reasons.length) out.push(`Family reasons: ${family.reasons.join("; ")}`)
  }

  out.push("", "Code:", item.code, "", "Candidates:")

  item.candidates.forEach((candidate, i) => {
    const decision = candidate.decision ? ` decided=${candidate.decision}` : ""
    out.push(
      `${i + 1}. ${candidate.call} [${candidate.fingerprint}] kind=${candidate.kind} ${viewConfidence(candidate.confidence)} source=${candidate.scoreSource}${decision}`,
    )
    if (candidate.sourceCall && candidate.sourceCall !== candidate.call) out.push(`   from: ${candidate.sourceCall}`)
    const evidence = evidenceBits(candidate.evidence)
    if (evidence.length) out.push(`   evidence: ${evidence.join(" | ")}`)
    if (candidate.reasons.length) out.push(`   reasons: ${candidate.reasons.join("; ")}`)
  })

  out.push("")
  out.push("Apply decisions with --review-next --decide 1=read,2=write,3=emit")
  return out.join("\n")
}

export function renderReviewModule(item: ReviewSnippet, moduleRoot: string, families: ReviewFamilyCluster[]) {
  const out = [
    `Snippet: ${item.snippetFingerprint}`,
    `Last seen: ${item.lastSeen}`,
    `Occurrences: ${item.occurrences.length}`,
    `Module: ${moduleRoot}`,
    `Families in snippet: ${families.map((family) => `${family.canonicalSource} (${family.kind}, ${family.recommendation})`).join(", ")}`,
    "",
    "Code:",
    item.code,
    "",
    "Candidates:",
  ]

  item.candidates.forEach((candidate, i) => {
    const decision = candidate.decision ? ` decided=${candidate.decision}` : ""
    out.push(
      `${i + 1}. ${candidate.call} [${candidate.fingerprint}] kind=${candidate.kind} ${viewConfidence(candidate.confidence)} source=${candidate.scoreSource}${decision}`,
    )
    if (candidate.sourceCall && candidate.sourceCall !== candidate.call) out.push(`   from: ${candidate.sourceCall}`)
    const evidence = evidenceBits(candidate.evidence)
    if (evidence.length) out.push(`   evidence: ${evidence.join(" | ")}`)
    if (candidate.reasons.length) out.push(`   reasons: ${candidate.reasons.join("; ")}`)
  })

  out.push("")
  out.push("Apply decisions with --review-next --decide 1=read,2=write,3=emit")
  return out.join("\n")
}

function suggest(item: ReviewSnippet["candidates"][number]) {
  if (item.kind === "emit") return "emit"
  if (item.kind === "pure") return "pure"

  const actionKind = strongest(item.confidence, ["read", "write", "emit"] as const)
  const fallbackKind = strongest(item.confidence, ["unknown", "pure", "exec"] as const)
  if (item.confidence[fallbackKind] >= item.confidence[actionKind] + SUGGEST_GAP) {
    return decideFrom(fallbackKind)
  }
  return decideFrom(actionKind)
}

function other(decision: ReviewDecision, item: ReviewSnippet["candidates"][number]) {
  if (decision === "read") return "write"
  if (decision === "write") return "read"
  if (decision === "emit") return "ignore"
  if (decision === "pure") return "ignore"
  if (decision === "ignore") {
    const next = strongest(item.confidence, ["read", "write", "emit", "pure"] as const)
    return decideFrom(next)
  }
  return "ignore"
}

function key(input: string): ReviewKey | undefined {
  if (["y", "n", "r", "w", "e", "x", "i", "c", "s", "v", "?", "q"].includes(input)) return input as ReviewKey
}

export function action(input: string, item: ReviewSnippet["candidates"][number]): ReviewAction | undefined {
  const hit = key(input)
  if (!hit) return
  const pick = suggest(item)
  if (hit === "y") return { type: "decide", decision: pick }
  if (hit === "n") return { type: "decide", decision: other(pick, item) }
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
  return text.replace(callPattern(call), (_text, lead, value) => `${lead}${paint(`[[${value}]]`, ANSI.call)}`)
}

function evidenceBits(evidence?: PythonEventEvidence) {
  const bits: string[] = []
  if (evidence?.explain?.length) bits.push(`rule=${evidence.explain[0]}`)
  if (evidence?.receiverKind) bits.push(`receiver=${evidence.receiverKind}`)
  if (evidence?.dependencySignature?.length) bits.push(`deps=${evidence.dependencySignature.join(",")}`)
  if (evidence?.guardFailure) bits.push(`guard=${evidence.guardFailure.type}${evidence.guardFailure.detail ? `(${evidence.guardFailure.detail})` : ""}`)
  return bits
}

function evidenceKey(evidence?: PythonEventEvidence) {
  return JSON.stringify({
    receiverKind: evidence?.receiverKind,
    dependencySignature: evidence?.dependencySignature ?? [],
    guardFailure: evidence?.guardFailure ?? null,
  })
}

function reviewCandidateKey(item: Pick<Occurrence, "fingerprint" | "kind" | "call" | "sourceCall" | "evidence">) {
  return `${item.fingerprint}\n${reviewKeyOf(item)}\n${evidenceKey(item.evidence)}`
}

function block(code: string, call: string, full: boolean) {
  const lines = normalized(code).split("\n")
  const hits = lines.flatMap((text, i) => (hasCall(text, call) ? [i] : []))
  const start = full || !hits.length ? 0 : Math.max(0, hits[0] - 4)
  const end = full || !hits.length ? lines.length : Math.min(lines.length, hits[0] + 8)
  const body = lines.slice(start, end).map((text, i) => {
    const line = start + i + 1
    const focus = hasCall(text, call)
    const gutter = `${focus ? ">" : " "} ${String(line).padStart(3, " ")}`
    const shown = focus ? paint(gutter, ANSI.focus) : paint(gutter, ANSI.dim)
    return `${shown} | ${marker(pythonLine(text), call)}`
  })
  if (start > 0) body.unshift(paint(`... ${start} earlier lines hidden ...`, ANSI.dim))
  if (end < lines.length) body.push(paint(`... ${lines.length - end} later lines hidden ...`, ANSI.dim))
  return body.join("\n")
}

function clear(output: NodeJS.WriteStream) {
  output.write("\x1b[2J\x1b[H")
}

function status(output: NodeJS.WriteStream, text: string) {
  clear(output)
  output.write(`${paint(text, ANSI.dim)}\n`)
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
  ]
  if (item.candidate.sourceCall && item.candidate.sourceCall !== item.candidate.call) out.push(`From: ${item.candidate.sourceCall}`)
  const evidence = evidenceBits(item.candidate.evidence)
  if (evidence.length) out.push(`Evidence: ${evidence.join(" | ")}`)
  out.push(`Suggested: ${pick} | ${viewConfidence(item.candidate.confidence)} | source=${item.candidate.scoreSource}`)
  if (item.candidate.reasons.length) out.push(`Why: ${item.candidate.reasons.join("; ")}`)
  out.push("", "Code:", block(item.snippet.code, item.candidate.call, full), "")
  if (help) {
    out.push(
      "Keys: y accept, n opposite (read<->write, emit->ignore, pure->ignore, ignore->best read/write/emit/pure), r read, w write, e emit, x exec, i ignore, c needs-code, s skip, v toggle full/focused code, q quit",
    )
    return out.join("\n")
  }
  out.push("Keys: y/n r/w e x i c s v ? q")
  return out.join("\n")
}

export function settled(queue: ReviewQueue, fingerprint: string, decision: ReviewDecision, identity?: ReviewIdentity) {
  const key = identity ? reviewKeyOf(identity) : undefined
  return {
    ...queue,
    snippets: queue.snippets.map((snippet) => ({
      ...snippet,
      candidates: snippet.candidates.map((candidate) =>
        candidate.fingerprint === fingerprint || (key && !candidate.decision && reviewKeyOf(candidate) === key)
          ? { ...candidate, decision }
          : candidate,
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
  let full = true

  try {
    while (true) {
      const head = item(queue, skip)
      if (!head) {
        output.write("No pending review items.\n")
        return
      }
      status(output, `Processing next item (${head.candidate.call})...`)
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
        status(output, `Skipping ${current.candidate.call}; loading next item...`)
        skip.add(current.candidate.fingerprint)
        continue
      }
      status(output, `Saving ${hit.decision} for ${current.candidate.call}...`)
      await recordDecision({
        ledger: opts.ledger,
        fingerprint: current.candidate.fingerprint,
        decision: hit.decision,
        kind: current.candidate.kind,
        call: current.candidate.call,
        sourceCall: current.candidate.sourceCall,
      })
      queue = settled(queue, current.candidate.fingerprint, hit.decision, {
        kind: current.candidate.kind,
        call: current.candidate.call,
        sourceCall: current.candidate.sourceCall,
      })
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

function decisionLookup(data: ReviewLedger, report?: Report): DecisionLookup {
  const byFingerprint = new Map<string, ReviewDecision>()
  for (const item of data.decisions) byFingerprint.set(item.fingerprint, item.decision)

  const identityByFingerprint = new Map<string, ReviewIdentity>()
  if (report) {
    for (const item of report.occurrences) {
      if (!identityByFingerprint.has(item.fingerprint)) {
        identityByFingerprint.set(item.fingerprint, {
          kind: item.kind,
          call: item.call,
          sourceCall: item.sourceCall,
        })
      }
    }
  }

  const byReviewKeyChoices = new Map<string, Set<ReviewDecision>>()
  for (const item of [...data.decisions].sort((a, b) => a.decidedAt.localeCompare(b.decidedAt) || a.fingerprint.localeCompare(b.fingerprint))) {
    const identity = decisionIdentity(item, identityByFingerprint.get(item.fingerprint))
    if (!identity) continue
    const key = reviewKeyOf(identity)
    const choices = byReviewKeyChoices.get(key) ?? new Set<ReviewDecision>()
    choices.add(item.decision)
    byReviewKeyChoices.set(key, choices)
  }

  const byReviewKey = new Map<string, ReviewDecision>()
  for (const [key, choices] of byReviewKeyChoices) {
    if (choices.size !== 1) continue
    byReviewKey.set(key, [...choices][0])
  }

  return { byFingerprint, byReviewKey }
}

function resolvedDecision(data: DecisionLookup, item: Pick<Occurrence, "fingerprint" | "kind" | "call" | "sourceCall">) {
  return data.byFingerprint.get(item.fingerprint) ?? data.byReviewKey.get(reviewKeyOf(item))
}

function suggestionDecision(decision: ReviewDecision): SuggestionDecision | undefined {
  if (decision === "read" || decision === "write" || decision === "emit" || decision === "exec" || decision === "pure") return decision
}

function effectForSuggestion(decision: SuggestionDecision) {
  if (decision === "read") return "fs.read"
  if (decision === "write") return "fs.write"
  if (decision === "emit") return "emit.signal"
  if (decision === "exec") return "dynamic.exec"
  return "pure.compute"
}

function suggestionFragment(decision: SuggestionDecision, call: string, canonicalSource: string | undefined, evidence?: PythonEventEvidence) {
  const guardedMethod = evidence?.explain?.find((item) => item.startsWith("guarded-method:"))
  const receiverKind = evidence?.receiverKind
  if (guardedMethod && (receiverKind === "path" || receiverKind === "match")) {
    return {
      guarded: {
        methods: [
          {
            method: guardedMethod.slice("guarded-method:".length),
            effect: effectForSuggestion(decision),
            guards: [{ type: "receiverKindIn", kinds: [receiverKind] }],
          },
        ],
      },
    }
  }

  if (canonicalSource && canonicalSource !== call) return

  return {
    calls: {
      [decision]: [call],
    },
  }
}

export async function suggestRules(report: Report, opts: { ledger: string; rules: string }): Promise<RuleSuggestionReport> {
  const data = await ledger(opts.ledger)
  const decided = decisionLookup(data, report)
  const byCall = new Map<
    string,
    {
      occurrences: number
      pending: number
      decisions: Set<ReviewDecision>
      canonicalSources: Set<string>
      evidenceKeys: Set<string>
      evidenceBits: Set<string>
      snippets: Set<string>
      examples: Set<string>
      representativeEvidence?: PythonEventEvidence
      representativeEvidenceKey?: string
    }
  >()

  for (const item of report.occurrences) {
    const row = byCall.get(item.call) ?? {
      occurrences: 0,
      pending: 0,
      decisions: new Set<ReviewDecision>(),
      canonicalSources: new Set<string>(),
      evidenceKeys: new Set<string>(),
      evidenceBits: new Set<string>(),
      snippets: new Set<string>(),
      examples: new Set<string>(),
      representativeEvidence: undefined,
      representativeEvidenceKey: undefined,
    }
    row.occurrences++
    row.snippets.add(item.snippetFingerprint)
    row.examples.add(`${item.sessionID} | ${item.title} | ${item.preview}`)
    row.canonicalSources.add(item.sourceCall ?? item.call)
    const currentEvidenceKey = evidenceKey(item.evidence)
    row.evidenceKeys.add(currentEvidenceKey)
    for (const bit of evidenceBits(item.evidence)) row.evidenceBits.add(bit)
    if (!row.representativeEvidenceKey || currentEvidenceKey < row.representativeEvidenceKey) {
      row.representativeEvidenceKey = currentEvidenceKey
      row.representativeEvidence = item.evidence
    }
    const decision = resolvedDecision(decided, item)
    if (decision) row.decisions.add(decision)
    else row.pending++
    byCall.set(item.call, row)
  }

  const suggestions: Array<RuleSuggestionReport["suggestions"][number] & { snippetKeys: string[] }> = []
  const blocked: RuleSuggestionReport["blocked"] = []

  for (const [call, row] of [...byCall.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!row.decisions.size) continue
    const reasons: string[] = []
    if (row.pending) reasons.push("unresolved contexts remain")
    const decisions = [...row.decisions]
    const suggestable = decisions.map(suggestionDecision).filter((item): item is SuggestionDecision => Boolean(item))
    if (suggestable.length !== decisions.length) reasons.push("contains non-suggestable decisions")
    const uniqueDecisions = [...new Set(suggestable)]
    if (uniqueDecisions.length > 1) reasons.push("conflicting reviewed decisions")
    const canonicalSources = [...row.canonicalSources]
    if (canonicalSources.length !== 1) reasons.push("multiple canonical sources")
    if (row.evidenceKeys.size > 1) reasons.push("multiple evidence signatures")
    const canonicalSource = canonicalSources[0]
    const decision = uniqueDecisions[0]
    const fragment = decision ? suggestionFragment(decision, call, canonicalSource, row.representativeEvidence) : undefined
    if (!fragment) reasons.push("no safe structured fragment")

    if (reasons.length) {
      blocked.push({ call, occurrences: row.occurrences, reasons })
      continue
    }

    if (!decision) continue
    suggestions.push({
      call,
      aliases: [call],
      decision,
      canonicalSource,
      occurrences: row.occurrences,
      snippetCount: row.snippets.size,
      snippetKeys: [...row.snippets],
      examples: [...row.examples].sort().slice(0, 3),
      fragment: fragment as Record<string, unknown>,
      reason: row.evidenceBits.size ? `unanimous reviewed contexts with one canonical source and ${[...row.evidenceBits].join(", ")}` : "unanimous reviewed contexts with one canonical source",
    })
  }

  const merged = new Map<string, (RuleSuggestionReport["suggestions"][number] & { exampleSet?: Set<string>; aliasSet?: Set<string>; snippetSet?: Set<string> })>()
  for (const item of suggestions) {
    const key = JSON.stringify(item.fragment)
    const current = merged.get(key)
    if (!current) {
      merged.set(key, {
        ...item,
        exampleSet: new Set(item.examples),
        aliasSet: new Set(item.aliases),
        snippetSet: new Set(item.snippetKeys),
      })
      continue
    }
    current.occurrences += item.occurrences
    current.exampleSet ??= new Set(current.examples)
    for (const example of item.examples) current.exampleSet.add(example)
    current.aliasSet ??= new Set(current.aliases)
    for (const alias of item.aliases) current.aliasSet.add(alias)
    current.aliases = [...current.aliasSet].sort()
    current.examples = [...current.exampleSet].sort().slice(0, 3)
    current.snippetSet ??= new Set()
    for (const snippetKey of item.snippetKeys) current.snippetSet.add(snippetKey)
    current.snippetCount = current.snippetSet.size
  }

  const mergedSuggestions = [...merged.values()].map((item) => ({
    call: item.call,
    aliases: item.aliases,
    decision: item.decision,
    canonicalSource: item.canonicalSource,
    occurrences: item.occurrences,
    snippetCount: item.snippetCount,
    examples: item.examples,
    fragment: item.fragment,
    reason: item.reason,
  }))

  return {
    generatedAt: new Date().toISOString(),
    db: report.db,
    ledger: opts.ledger,
    rules: opts.rules,
    totals: {
      suggested: mergedSuggestions.length,
      blocked: blocked.length,
    },
    suggestions: mergedSuggestions,
    blocked,
  }
}

export function renderSuggestions(report: RuleSuggestionReport) {
  const out = [`Rules: ${report.rules}`, `Ledger: ${report.ledger}`, `suggested: ${report.totals.suggested}`, `blocked: ${report.totals.blocked}`]
  for (const item of report.suggestions) {
    out.push("")
    out.push(`${item.call} -> ${item.decision} (${item.occurrences})`)
    if (item.aliases.length > 1) out.push(`  aliases: ${item.aliases.join(", ")}`)
    if (item.canonicalSource && item.canonicalSource !== item.call) out.push(`  source: ${item.canonicalSource}`)
    out.push(`  reason: ${item.reason}`)
    out.push(`  fragment: ${JSON.stringify(item.fragment)}`)
    for (const example of item.examples) out.push(`  - ${example}`)
  }
  if (report.blocked.length) {
    out.push("", `blocked: ${report.blocked.length}`)
    for (const item of report.blocked) out.push(`  - ${item.call}: ${item.reasons.join('; ')}`)
  }
  return out.join("\n")
}

async function withRulesFile<T>(rulesPath: string, run: () => Promise<T>) {
  const previous = process.env.OPENCODE_PYTHON_RULES
  process.env.OPENCODE_PYTHON_RULES = rulesPath
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_PYTHON_RULES
    else process.env.OPENCODE_PYTHON_RULES = previous
  }
}

async function scenario(opts: {
  db: string
  since?: number
  samples: number
  includeEmit: boolean
  includePure: boolean
  ledger: string
  rules: string
}) {
  return await withRulesFile(opts.rules, async () => {
    const report = await scan({ db: opts.db, since: opts.since, samples: opts.samples, includeEmit: opts.includeEmit, includePure: opts.includePure })
    const queue = await review(report, { ledger: opts.ledger })
    const suggestions = await suggestRules(report, { ledger: opts.ledger, rules: opts.rules })
    return { report, queue, suggestions }
  })
}

export async function compareRules(opts: {
  db: string
  since?: number
  samples: number
  includeEmit: boolean
  includePure: boolean
  ledger: string
  rules: string
  compareRules: string
}): Promise<RulesCompareReport> {
  const baseline = await scenario({ ...opts, rules: opts.rules })
  const alternate = await scenario({ ...opts, rules: opts.compareRules })
  const baselineUnknown = new Set(baseline.report.unknown.map((item) => item.call))
  const alternateUnknown = new Set(alternate.report.unknown.map((item) => item.call))
  const baselineSuggestions = new Set(baseline.suggestions.suggestions.map((item) => JSON.stringify(item.fragment)))
  const alternateSuggestions = new Set(alternate.suggestions.suggestions.map((item) => JSON.stringify(item.fragment)))

  return {
    generatedAt: new Date().toISOString(),
    db: opts.db,
    currentRules: opts.rules,
    alternateRules: opts.compareRules,
    baseline: {
      unknownEvents: baseline.report.totals.unknownEvents,
      uniqueUnknownCalls: baseline.report.totals.uniqueUnknownCalls,
      pendingCandidates: baseline.queue.totals.pendingCandidates,
      suggestedRules: baseline.suggestions.totals.suggested,
    },
    alternate: {
      unknownEvents: alternate.report.totals.unknownEvents,
      uniqueUnknownCalls: alternate.report.totals.uniqueUnknownCalls,
      pendingCandidates: alternate.queue.totals.pendingCandidates,
      suggestedRules: alternate.suggestions.totals.suggested,
    },
    resolvedUnknownCalls: [...baselineUnknown].filter((call) => !alternateUnknown.has(call)).sort(),
    newUnknownCalls: [...alternateUnknown].filter((call) => !baselineUnknown.has(call)).sort(),
    addedSuggestions: [...alternateSuggestions].filter((item) => !baselineSuggestions.has(item)).sort(),
    removedSuggestions: [...baselineSuggestions].filter((item) => !alternateSuggestions.has(item)).sort(),
  }
}

export function renderRulesCompare(report: RulesCompareReport) {
  return [
    `Current rules: ${report.currentRules}`,
    `Alternate rules: ${report.alternateRules}`,
    `Unknown events: ${report.baseline.unknownEvents} -> ${report.alternate.unknownEvents}`,
    `Unique unknown calls: ${report.baseline.uniqueUnknownCalls} -> ${report.alternate.uniqueUnknownCalls}`,
    `Pending review candidates: ${report.baseline.pendingCandidates} -> ${report.alternate.pendingCandidates}`,
    `Suggested rules: ${report.baseline.suggestedRules} -> ${report.alternate.suggestedRules}`,
    report.resolvedUnknownCalls.length ? `Resolved unknown calls: ${report.resolvedUnknownCalls.join(', ')}` : "Resolved unknown calls: none",
    report.newUnknownCalls.length ? `New unknown calls: ${report.newUnknownCalls.join(', ')}` : "New unknown calls: none",
    report.addedSuggestions.length ? `Added suggestions: ${report.addedSuggestions.join(', ')}` : "Added suggestions: none",
    report.removedSuggestions.length ? `Removed suggestions: ${report.removedSuggestions.join(', ')}` : "Removed suggestions: none",
  ].join("\n")
}

export async function promotions(report: Report, opts: { ledger: string; rules: string }): Promise<PromotionPlan> {
  const data = await ledger(opts.ledger)
  const decided = decisionLookup(data, report)
  const byIdentity = new Map<
    string,
    {
      calls: Set<string>
      decisions: Map<string, ReviewDecision>
      pending: Set<string>
    }
  >()

  for (const item of report.occurrences) {
    const key = reviewKeyOf(item)
    const row = byIdentity.get(key) ?? { calls: new Set<string>(), decisions: new Map<string, ReviewDecision>(), pending: new Set<string>() }
    row.calls.add(item.call)
    const outcome = resolvedDecision(decided, item)
    if (outcome) row.decisions.set(item.fingerprint, outcome)
    else row.pending.add(item.fingerprint)
    byIdentity.set(key, row)
  }

  const byCall = new Map<
    string,
    Array<{
      calls: Set<string>
      decisions: Map<string, ReviewDecision>
      pending: Set<string>
    }>
  >()
  for (const row of byIdentity.values()) {
    for (const call of row.calls) {
      const rows = byCall.get(call) ?? []
      rows.push(row)
      byCall.set(call, rows)
    }
  }

  const promotable: Record<PromotionBucket, string[]> = { read: [], write: [], emit: [], exec: [] }
  const blocked: PromotionPlan["blocked"] = []

  for (const [call, identities] of [...byCall.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const outcomes = [...new Set(identities.flatMap((row) => [...row.decisions.values()]))]
    const pendingContexts = identities.reduce((count, row) => count + row.pending.size, 0)
    if (identities.some((row) => row.calls.size > 1)) {
      blocked.push({ call, reason: "review identity maps to multiple outward call aliases", decisions: outcomes, pendingContexts })
      continue
    }
    if (identities.length !== 1) {
      blocked.push({ call, reason: "multiple review identities share this call", decisions: outcomes, pendingContexts })
      continue
    }
    const [row] = identities
    if (!outcomes.length) {
      blocked.push({ call, reason: "no reviewed contexts", decisions: [], pendingContexts })
      continue
    }
    if (pendingContexts) {
      blocked.push({ call, reason: "unresolved contexts remain", decisions: outcomes, pendingContexts })
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

  if (opts.compareRules) {
    const compared = await compareRules({
      db: opts.db,
      since: opts.since,
      samples: opts.samples,
      includeEmit: opts.includeEmit,
      includePure: opts.includePure,
      ledger: opts.ledger,
      rules: opts.rules,
      compareRules: opts.compareRules,
    })
    console.log(opts.json ? JSON.stringify(compared, null, 2) : renderRulesCompare(compared))
    return
  }
  await withRulesFile(opts.analyzerRules, async () => {
    const report = await scan({
      db: opts.db,
      since: opts.since,
      samples: opts.samples,
      includeEmit: opts.includeEmit,
      includePure: opts.includePure,
    })
    if (opts.suggestRules) {
      const suggestions = await suggestRules(report, { ledger: opts.ledger, rules: opts.rules })
      console.log(opts.json ? JSON.stringify(suggestions, null, 2) : renderSuggestions(suggestions))
      return
    }
    if (opts.reviewJson) {
      console.log(JSON.stringify(await review(report, { ledger: opts.ledger }), null, 2))
      return
    }
    if (opts.reviewFamiliesJson) {
      console.log(JSON.stringify(reviewFamilySummary(await review(report, { ledger: opts.ledger }), { family: opts.family, module: opts.module }), null, 2))
      return
    }
    if (opts.reviewFamilies) {
      console.log(renderReviewFamilies(reviewFamilySummary(await review(report, { ledger: opts.ledger }), { family: opts.family, module: opts.module })))
      return
    }
    if (opts.reviewTui) {
      await tui(await review(report, { ledger: opts.ledger }), { ledger: opts.ledger, cache: opts.scoreCache })
      return
    }
    if (opts.reviewNext) {
      const familySelectors = { family: opts.family, module: opts.module }
      let queue = filterReviewQueue(await review(report, { ledger: opts.ledger }), familySelectors)
      let item = nextReview(queue)
      if (opts.decide) {
        if (!item) fail("No pending review items")
        await applyDecisions({ ledger: opts.ledger, item, decide: opts.decide })
        queue = filterReviewQueue(await review(report, { ledger: opts.ledger }), familySelectors)
        item = nextReview(queue)
      }
      if (!item) {
        console.log("No pending review items.")
        return
      }
      const next = await rescore(item, { cache: opts.scoreCache })
      if (next.warning) console.error(next.warning)
      const families = reviewFamilies(queue).filter((cluster) => next.item.candidates.some((candidate) => cluster.familyKey === reviewKeyOf(candidate)))
      if (opts.module) console.log(renderReviewModule(next.item, opts.module, families))
      else console.log(renderReview(next.item, families[0]))
      return
    }
    if (opts.promoteReviewed) {
      console.log(renderPromotions(await promote(report, { ledger: opts.ledger, rules: opts.rules })))
      return
    }
    if (opts.update) await update(report, { rules: opts.rules, samples: opts.samples })
    console.log(opts.json ? JSON.stringify(report, null, 2) : render(report))
  })
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
