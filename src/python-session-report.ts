import { Database } from "bun:sqlite"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { analyze } from "./python/python-analyze"

type Opts = {
  db: string
  since?: number
  json: boolean
  samples: number
  rules: string
  update: boolean
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
}

type Candidate = {
  call: string
  count: number
  lastSeen: string
  examples: string[]
}

type RulesDoc = {
  candidates?: {
    unknown?: Candidate[]
  }
  [key: string]: unknown
}

function usage() {
  return [
    "Usage: bun src/python-session-report.ts [options]",
    "",
    "Options:",
    "  --db <path>      Override OpenCode session database path",
    "  --rules <path>   Override python rules JSON path",
    "  --since <iso>    Only scan rows updated at or after this ISO timestamp",
    "  --samples <n>    Sample sessions/previews per unknown callable (default: 3)",
    "  --update-candidates  Write findings into candidates.unknown",
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
    rules: defrules(),
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
    if (arg === "--db") {
      const val = args[++i]
      if (!val) fail("Missing value for --db")
      opts.db = path.resolve(val)
      continue
    }
    if (arg === "--rules") {
      const val = args[++i]
      if (!val) fail("Missing value for --rules")
      opts.rules = path.resolve(val)
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

  const report = await scan({
    db: opts.db,
    since: opts.since,
    samples: opts.samples,
  })
  if (opts.update) await update(report, { rules: opts.rules, samples: opts.samples })
  console.log(opts.json ? JSON.stringify(report, null, 2) : render(report))
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
