import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { access, mkdtemp, readFile, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { PassThrough, Writable } from "stream"
import { action, applyDecisions, compareRules, item, nextReview, parse, promote, promotions, recordDecision, render, renderPromotions, renderReview, renderRulesCompare, renderSuggestions, renderTui, rescore, review, scan, suggestRules, tui, update } from "../../src/python-session-report"

function plain(text: string) {
  return text.replace(/\x1b\[[0-9;]*m/g, "")
}

async function db() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "python-session-report-"))
  const file = path.join(dir, "opencode.db")
  const db = new Database(file)
  db.exec([
    "create table session (id text primary key, title text not null, time_updated integer not null);",
    "create table part (",
    "  id text primary key,",
    "  message_id text not null,",
    "  session_id text not null,",
    "  time_created integer not null,",
    "  time_updated integer not null,",
    "  data text not null",
    ");",
  ].join(" "))
  return { dir, file, db }
}

function put(db: Database, row: {
  id: string
  messageID: string
  sessionID: string
  created: number
  updated: number
  data: string
}) {
  db
    .prepare("insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)")
    .run(row.id, row.messageID, row.sessionID, row.created, row.updated, row.data)
}

function data(tool: string, input: Record<string, unknown>) {
  return JSON.stringify({
    type: "tool",
    callID: `call-${tool}`,
    tool,
    state: {
      status: "completed",
      input,
      output: "",
      title: tool,
      metadata: {},
      time: { start: 1, end: 2 },
    },
  })
}

async function recordOccurrenceDecision(
  ledger: string,
  occurrence: { fingerprint: string; kind: "unknown" | "emit" | "pure"; call: string; sourceCall?: string },
  decision: "read" | "write" | "emit" | "exec" | "pure" | "ignore" | "needs-code",
) {
  await recordDecision({
    ledger,
    fingerprint: occurrence.fingerprint,
    decision,
    kind: occurrence.kind,
    call: occurrence.call,
    sourceCall: occurrence.sourceCall,
  })
}

describe("python session report", () => {
  it("scans inline python snippets and groups unknown callables", async () => {
    const tmp = await db()

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000), ('s2', 'Beta', 3000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "reader.fetch('x')", description: "one" }),
      })
      put(tmp.db, {
        id: "p2",
        messageID: "m2",
        sessionID: "s2",
        created: 2000,
        updated: 3000,
        data: data("python", { code: "reader.fetch('y')", description: "two" }),
      })
      put(tmp.db, {
        id: "p3",
        messageID: "m3",
        sessionID: "s2",
        created: 2000,
        updated: 3000,
        data: data("python", { code: "json.load(f)", description: "known" }),
      })
      put(tmp.db, {
        id: "p4",
        messageID: "m4",
        sessionID: "s2",
        created: 2000,
        updated: 3000,
        data: data("python", { scriptPath: "tool.py", description: "skip" }),
      })
      put(tmp.db, {
        id: "p5",
        messageID: "m5",
        sessionID: "s2",
        created: 2000,
        updated: 3000,
        data: data("bash", { command: "ls" }),
      })

      const report = await scan({ db: tmp.file, samples: 2 })
      expect(report.totals.sessions).toBe(2)
      expect(report.totals.toolParts).toBe(4)
      expect(report.totals.inlineSnippets).toBe(3)
      expect(report.totals.unknownEvents).toBe(2)
      expect(report.totals.uniqueUnknownCalls).toBe(1)
      expect(report.totals.skippedRows).toBe(0)
      expect(report.unknown).toEqual([
        {
          call: "reader.fetch",
          count: 2,
          lastSeen: new Date(3000).toISOString(),
          sessions: [
            { id: "s2", title: "Beta", time: new Date(3000).toISOString() },
            { id: "s1", title: "Alpha", time: new Date(2000).toISOString() },
          ],
          samples: [
            {
              sessionID: "s2",
              messageID: "m2",
              partID: "p2",
              title: "Beta",
              time: new Date(3000).toISOString(),
              preview: "reader.fetch('y')",
            },
            {
              sessionID: "s1",
              messageID: "m1",
              partID: "p1",
              title: "Alpha",
              time: new Date(2000).toISOString(),
              preview: "reader.fetch('x')",
            },
          ],
        },
      ])

      const text = render(report)
      expect(text).toContain("Found 2 unknown callable events across 1 unique callables.")
      expect(text).toContain("reader.fetch (2)")
      expect(text).toContain("s2 | Beta")
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("adds analyzer metadata to reports and review queues", async () => {
    const tmp = await db()

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "reader.fetch('x')" }),
      })

      const report = await scan({ db: tmp.file, samples: 2 })
      const queue = await review(report, { ledger: path.join(tmp.dir, "review-ledger.json") })

      expect(report.analyzerVersion).toBe("python-analyzer/v2")
      expect(report.engineVersion).toBe("python-ir-v2")
      expect(queue.analyzerVersion).toBe(report.analyzerVersion)
      expect(queue.engineVersion).toBe(report.engineVersion)
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("supports since filtering", async () => {
    const tmp = await db()

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 1000), ('s2', 'Beta', 5000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 1000,
        data: data("python", { code: "old.call()" }),
      })
      put(tmp.db, {
        id: "p2",
        messageID: "m2",
        sessionID: "s2",
        created: 5000,
        updated: 5000,
        data: data("python", { code: "new.call()" }),
      })

      const report = await scan({ db: tmp.file, since: 2000, samples: 3 })
      expect(report.totals.sessions).toBe(1)
      expect(report.unknown[0]?.call).toBe("new.call")
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("skips malformed rows and keeps valid results", async () => {
    const tmp = await db()

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "bad.call()" }),
      })
      put(tmp.db, {
        id: "p2",
        messageID: "m2",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: "{bad-json",
      })

      const report = await scan({ db: tmp.file, samples: 3 })
      expect(report.totals.skippedRows).toBe(1)
      expect(report.unknown[0]?.call).toBe("bad.call")
      expect(render(report)).toContain("Skipped 1 malformed rows.")
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("renders no-unknown output cleanly", async () => {
    const tmp = await db()

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "json.load(f)" }),
      })

      const report = await scan({ db: tmp.file, samples: 3 })
      expect(report.totals.unknownEvents).toBe(0)
      expect(render(report)).toContain("No unknown callables found.")
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("suppresses emit and pure candidates by default", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "print('x')\nre.search('a+', text)\nunknown.call()" }),
      })

      const report = await scan({ db: tmp.file, samples: 3 })
      const calls = report.occurrences.map((item) => item.call).sort()
      expect(calls).toEqual(["unknown.call"])

      const queue = await review(report, { ledger })
      const queuedCalls = queue.snippets.flatMap((snippet) => snippet.candidates.map((candidate) => candidate.call)).sort()
      expect(queuedCalls).toEqual(["unknown.call"])
      expect(queuedCalls).not.toContain("print")
      expect(queuedCalls).not.toContain("re.search")
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("includes emit candidates when --include-emit mode is enabled", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "print('x')\nre.search('a+', text)\nunknown.call()" }),
      })

      const report = await scan({ db: tmp.file, samples: 3, includeEmit: true })
      const calls = report.occurrences.map((item) => item.call).sort()
      expect(calls).toEqual(["print", "unknown.call"])

      const queue = await review(report, { ledger })
      const queuedCalls = queue.snippets.flatMap((snippet) => snippet.candidates.map((candidate) => candidate.call)).sort()
      expect(queuedCalls).toEqual(["print", "unknown.call"])
      expect(queuedCalls).not.toContain("re.search")
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("includes pure candidates when --include-pure mode is enabled", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "re.search('a+', text)" }),
      })

      const report = await scan({ db: tmp.file, samples: 3, includePure: true })
      expect(report.occurrences.map((item) => item.call)).toEqual(["re.search"])

      const queue = await review(report, { ledger })
      expect(queue.snippets).toHaveLength(1)
      expect(queue.snippets[0]?.candidates[0]?.call).toBe("re.search")
      expect(queue.snippets[0]?.candidates[0]?.kind).toBe("pure")
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("keeps emit and unknown candidates distinct for the same call and snippet", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")

    try {
      const time = new Date(2000).toISOString()
      const report = {
        generatedAt: new Date(0).toISOString(),
        db: tmp.file,
        analyzerVersion: "python-analyzer/v2",
        engineVersion: "python-ir-v2",
        filters: { samples: 3 },
        totals: {
          sessions: 1,
          toolParts: 1,
          inlineSnippets: 1,
          unknownEvents: 1,
          uniqueUnknownCalls: 1,
          skippedRows: 0,
        },
        unknown: [],
        occurrences: [
          {
            kind: "unknown" as const,
            call: "foo.bar",
            canonicalSource: "foo.bar",
            fingerprint: "fp-unknown",
            snippetFingerprint: "same-snippet",
            sessionID: "s1",
            messageID: "m1",
            partID: "p1",
            title: "Alpha",
            time,
            preview: "foo.bar()",
            code: "foo.bar()",
            confidence: { read: 0.1, write: 0.2, emit: 0.05, exec: 0.08, pure: 0.05, unknown: 0.55 },
            readConfidence: 0.1,
            writeConfidence: 0.2,
            reasons: [],
            scoreSource: "heuristic",
          },
          {
            kind: "emit" as const,
            call: "foo.bar",
            canonicalSource: "foo.bar",
            fingerprint: "fp-emit",
            snippetFingerprint: "same-snippet",
            sessionID: "s1",
            messageID: "m1",
            partID: "p1",
            title: "Alpha",
            time,
            preview: "foo.bar()",
            code: "foo.bar()",
            confidence: { read: 0.1, write: 0.2, emit: 0.8, exec: 0.04, pure: 0.03, unknown: 0.2 },
            readConfidence: 0.1,
            writeConfidence: 0.2,
            reasons: [],
            scoreSource: "heuristic",
          },
        ],
      }

      const queue = await review(report, { ledger })
      const candidates = queue.snippets[0]?.candidates.map((candidate) => `${candidate.kind}:${candidate.fingerprint}`) ?? []
      expect(candidates).toEqual(expect.arrayContaining(["unknown:fp-unknown", "emit:fp-emit"]))
      expect(candidates).toHaveLength(2)
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("fails clearly for missing databases", async () => {
    await expect(scan({ db: path.join(os.tmpdir(), `missing-${Date.now()}.db`) })).rejects.toThrow(
      /^OpenCode session database not found:/,
    )
  })

  it("updates candidate rules deterministically", async () => {
    const tmp = await db()
    const rules = path.join(tmp.dir, "python-rules.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000), ('s2', 'Beta', 3000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "zeta.call()" }),
      })
      put(tmp.db, {
        id: "p2",
        messageID: "m2",
        sessionID: "s2",
        created: 2000,
        updated: 3000,
        data: data("python", { code: "alpha.call()" }),
      })

      const src = new URL("../../src/python/python-rules.json", import.meta.url)
      const base = JSON.parse(await readFile(src, "utf8")) as Record<string, any>
      base.candidates = {
        unknown: [{ call: "zeta.call", count: 1, lastSeen: new Date(1000).toISOString(), examples: ["s0"] }],
      }
      await writeFile(rules, JSON.stringify(base))

      const report = await scan({ db: tmp.file, samples: 2 })
      await update(report, { rules, samples: 2 })

      const next = JSON.parse(await readFile(rules, "utf8")) as Record<string, any>
      expect(next.candidates.unknown).toEqual([
        {
          call: "alpha.call",
          count: 1,
          lastSeen: new Date(3000).toISOString(),
          examples: ["s2"],
        },
        {
          call: "zeta.call",
          count: 2,
          lastSeen: new Date(2000).toISOString(),
          examples: ["s0", "s1"],
        },
      ])
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("fails clearly for malformed candidate shapes", async () => {
    const tmp = await db()
    const rules = path.join(tmp.dir, "python-rules.json")

    try {
      const src = new URL("../../src/python/python-rules.json", import.meta.url)
      const base = JSON.parse(await readFile(src, "utf8")) as Record<string, any>
      base.candidates = { unknown: {} }
      await writeFile(rules, JSON.stringify(base))

      await expect(
        update(
          {
            generatedAt: new Date(0).toISOString(),
            db: tmp.file,
            analyzerVersion: "python-analyzer/v2",
            engineVersion: "python-ir-v2",
            filters: { samples: 3 },
            totals: {
              sessions: 0,
              toolParts: 0,
              inlineSnippets: 0,
              unknownEvents: 0,
              uniqueUnknownCalls: 0,
              skippedRows: 0,
            },
            unknown: [],
            occurrences: [],
          },
          { rules, samples: 3 },
        ),
      ).rejects.toThrow(/^Invalid python rules candidates:/)
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("fails clearly for malformed candidate containers", async () => {
    const tmp = await db()
    const rules = path.join(tmp.dir, "python-rules.json")

    try {
      const src = new URL("../../src/python/python-rules.json", import.meta.url)
      const base = JSON.parse(await readFile(src, "utf8")) as Record<string, any>
      base.candidates = 1
      await writeFile(rules, JSON.stringify(base))

      await expect(
        update(
          {
            generatedAt: new Date(0).toISOString(),
            db: tmp.file,
            analyzerVersion: "python-analyzer/v2",
            engineVersion: "python-ir-v2",
            filters: { samples: 3 },
            totals: {
              sessions: 0,
              toolParts: 0,
              inlineSnippets: 0,
              unknownEvents: 0,
              uniqueUnknownCalls: 0,
              skippedRows: 0,
            },
            unknown: [],
            occurrences: [],
          },
          { rules, samples: 3 },
        ),
      ).rejects.toThrow(/^Invalid python rules candidates:/)
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("builds a snippet-centric review queue and reuses prior decisions", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")
    const code = "reader.fetch('x')\nwriter.save('y')"

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000), ('s2', 'Beta', 3000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code }),
      })
      put(tmp.db, {
        id: "p2",
        messageID: "m2",
        sessionID: "s2",
        created: 2000,
        updated: 3000,
        data: data("python", { code }),
      })

      const report = await scan({ db: tmp.file, samples: 3 })
      const initial = await review(report, { ledger })
      expect(initial.totals.snippets).toBe(1)
      expect(initial.totals.pendingCandidates).toBe(2)
      expect(initial.snippets[0]?.code).toBe(code)
      expect(initial.snippets[0]?.occurrences).toHaveLength(2)

      const rq = initial.snippets[0]?.candidates.find((item) => item.call === "reader.fetch")
      const append = initial.snippets[0]?.candidates.find((item) => item.call === "writer.save")
      expect(rq?.readConfidence).toBeGreaterThan(rq?.writeConfidence ?? 1)
      expect(append?.writeConfidence).toBeGreaterThan(append?.readConfidence ?? 1)

      await recordDecision({
        ledger,
        fingerprint: rq!.fingerprint,
        decision: "read",
        kind: rq!.kind,
        call: rq!.call,
        sourceCall: rq!.sourceCall,
      })

      const merged = await review(report, { ledger })
      const decided = merged.snippets[0]?.candidates.find((item) => item.call === "reader.fetch")
      const pending = merged.snippets[0]?.candidates.find((item) => item.call === "writer.save")
      expect(merged.totals.snippets).toBe(1)
      expect(merged.totals.pendingCandidates).toBe(1)
      expect(merged.totals.decidedCandidates).toBe(1)
      expect(decided?.decision).toBe("read")
      expect(pending?.decision).toBeUndefined()

      const ledgerData = JSON.parse(await readFile(ledger, "utf8")) as Record<string, any>
      expect(ledgerData.decisions).toEqual([
        expect.objectContaining({
          fingerprint: rq?.fingerprint,
          kind: "unknown",
          call: "reader.fetch",
          decision: "read",
        }),
      ])
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("loads legacy review ledger rows without review identity fields", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "reader.fetch('x')\nwriter.save('y')" }),
      })

      const report = await scan({ db: tmp.file, samples: 3 })
      const occurrence = report.occurrences.find((item) => item.call === "reader.fetch")!
      await writeFile(
        ledger,
        `${JSON.stringify({
          version: 1,
          decisions: [
            {
              fingerprint: occurrence.fingerprint,
              call: occurrence.call,
              decision: "read",
              decidedAt: new Date(0).toISOString(),
            },
          ],
        })}\n`,
      )

      const queue = await review(report, { ledger })
      const decided = queue.snippets[0]?.candidates.find((item) => item.call === "reader.fetch")
      const pending = queue.snippets[0]?.candidates.find((item) => item.call === "writer.save")
      expect(decided?.decision).toBe("read")
      expect(pending?.decision).toBeUndefined()
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("keeps legacy call-only rows from reusing across different review identities", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")

    try {
      const time = new Date(2000).toISOString()
      const report = {
        generatedAt: new Date(0).toISOString(),
        db: tmp.file,
        analyzerVersion: "python-analyzer/v2",
        engineVersion: "python-ir-v2",
        filters: { samples: 3 },
        totals: {
          sessions: 1,
          toolParts: 1,
          inlineSnippets: 2,
          unknownEvents: 0,
          uniqueUnknownCalls: 0,
          skippedRows: 0,
        },
        unknown: [],
        occurrences: [
          {
            kind: "pure" as const,
            call: "item.group",
            sourceCall: "re.Match.group",
            canonicalSource: "re.Match.group",
            fingerprint: "fp-match",
            snippetFingerprint: "snippet-match",
            sessionID: "s1",
            messageID: "m1",
            partID: "p1",
            title: "Alpha",
            time,
            preview: "item.group(1)",
            code: "item = re.search('a+', text)\nitem.group(1)",
            confidence: { read: 0.05, write: 0.05, emit: 0.02, exec: 0.03, pure: 0.92, unknown: 0.08 },
            readConfidence: 0.05,
            writeConfidence: 0.05,
            reasons: [],
            scoreSource: "heuristic",
          },
          {
            kind: "pure" as const,
            call: "item.group",
            sourceCall: "collections.Group.group",
            canonicalSource: "collections.Group.group",
            fingerprint: "fp-other",
            snippetFingerprint: "snippet-other",
            sessionID: "s2",
            messageID: "m2",
            partID: "p2",
            title: "Beta",
            time,
            preview: "item.group(1)",
            code: "item = custom_group()\nitem.group(1)",
            confidence: { read: 0.05, write: 0.05, emit: 0.02, exec: 0.03, pure: 0.91, unknown: 0.09 },
            readConfidence: 0.05,
            writeConfidence: 0.05,
            reasons: [],
            scoreSource: "heuristic",
          },
        ],
      }

      await writeFile(
        ledger,
        `${JSON.stringify({
          version: 1,
          decisions: [
            {
              fingerprint: report.occurrences[0]!.fingerprint,
              call: report.occurrences[0]!.call,
              decision: "pure",
              decidedAt: new Date(0).toISOString(),
            },
          ],
        })}\n`,
      )

      const queue = await review(report, { ledger })
      const target = queue.snippets.find((item) => item.snippetFingerprint === "snippet-other")
      expect(queue.snippets).toHaveLength(1)
      expect(target?.candidates[0]?.decision).toBeUndefined()
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("keeps legacy exact-fingerprint rows reusable even when review identity cannot be reconstructed", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")

    try {
      const time = new Date(2000).toISOString()
      const report = {
        generatedAt: new Date(0).toISOString(),
        db: tmp.file,
        analyzerVersion: "python-analyzer/v2",
        engineVersion: "python-ir-v2",
        filters: { samples: 3 },
        totals: {
          sessions: 1,
          toolParts: 1,
          inlineSnippets: 2,
          unknownEvents: 1,
          uniqueUnknownCalls: 1,
          skippedRows: 0,
        },
        unknown: [],
        occurrences: [
          {
            kind: "pure" as const,
            call: "item.group",
            sourceCall: "re.Match.group",
            canonicalSource: "re.Match.group",
            fingerprint: "fp-match",
            snippetFingerprint: "snippet-match",
            sessionID: "s1",
            messageID: "m1",
            partID: "p1",
            title: "Alpha",
            time,
            preview: "item.group(1)",
            code: "item = re.search('a+', text)\nitem.group(1)\nwriter.save('y')",
            confidence: { read: 0.05, write: 0.05, emit: 0.02, exec: 0.03, pure: 0.92, unknown: 0.08 },
            readConfidence: 0.05,
            writeConfidence: 0.05,
            reasons: [],
            scoreSource: "heuristic",
          },
          {
            kind: "unknown" as const,
            call: "writer.save",
            canonicalSource: "writer.save",
            fingerprint: "fp-write",
            snippetFingerprint: "snippet-match",
            sessionID: "s1",
            messageID: "m1",
            partID: "p1",
            title: "Alpha",
            time,
            preview: "writer.save('y')",
            code: "item = re.search('a+', text)\nitem.group(1)\nwriter.save('y')",
            confidence: { read: 0.08, write: 0.88, emit: 0.03, exec: 0.05, pure: 0.03, unknown: 0.11 },
            readConfidence: 0.08,
            writeConfidence: 0.88,
            reasons: [],
            scoreSource: "heuristic",
          },
          {
            kind: "pure" as const,
            call: "item.group",
            sourceCall: "collections.Group.group",
            canonicalSource: "collections.Group.group",
            fingerprint: "fp-other",
            snippetFingerprint: "snippet-other",
            sessionID: "s2",
            messageID: "m2",
            partID: "p2",
            title: "Beta",
            time,
            preview: "item.group(1)",
            code: "item = custom_group()\nitem.group(1)",
            confidence: { read: 0.05, write: 0.05, emit: 0.02, exec: 0.03, pure: 0.91, unknown: 0.09 },
            readConfidence: 0.05,
            writeConfidence: 0.05,
            reasons: [],
            scoreSource: "heuristic",
          },
        ],
      }

      await writeFile(
        ledger,
        `${JSON.stringify({
          version: 1,
          decisions: [
            {
              fingerprint: report.occurrences[0]!.fingerprint,
              call: report.occurrences[0]!.call,
              decision: "pure",
              decidedAt: new Date(0).toISOString(),
            },
          ],
        })}\n`,
      )

      const queue = await review(report, { ledger })
      const decided = queue.snippets.find((item) => item.snippetFingerprint === "snippet-match")
      const pending = queue.snippets.find((item) => item.snippetFingerprint === "snippet-other")
      expect(decided?.candidates.find((item) => item.fingerprint === "fp-match")?.decision).toBe("pure")
      expect(decided?.candidates.find((item) => item.fingerprint === "fp-write")?.decision).toBeUndefined()
      expect(pending?.candidates[0]?.decision).toBeUndefined()
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("rejects invalid occurrence kinds in review ledger rows", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "reader.fetch('x')" }),
      })

      const report = await scan({ db: tmp.file, samples: 3 })
      const occurrence = report.occurrences[0]!
      await writeFile(
        ledger,
        `${JSON.stringify({
          version: 1,
          decisions: [
            {
              fingerprint: occurrence.fingerprint,
              kind: "bad",
              call: occurrence.call,
              decision: "read",
              decidedAt: new Date(0).toISOString(),
            },
          ],
        })}\n`,
      )

      await expect(review(report, { ledger })).rejects.toThrow(/^Invalid review ledger:/)
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("rejects review ledger rows that set kind without call", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "reader.fetch('x')" }),
      })

      const report = await scan({ db: tmp.file, samples: 3 })
      const occurrence = report.occurrences[0]!
      await writeFile(
        ledger,
        `${JSON.stringify({
          version: 1,
          decisions: [
            {
              fingerprint: occurrence.fingerprint,
              kind: "unknown",
              decision: "read",
              decidedAt: new Date(0).toISOString(),
            },
          ],
        })}\n`,
      )

      await expect(review(report, { ledger })).rejects.toThrow(/^Invalid review ledger:/)
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("rejects review ledger rows that set kind with an empty call", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "reader.fetch('x')" }),
      })

      const report = await scan({ db: tmp.file, samples: 3 })
      const occurrence = report.occurrences[0]!
      await writeFile(
        ledger,
        `${JSON.stringify({
          version: 1,
          decisions: [
            {
              fingerprint: occurrence.fingerprint,
              kind: "unknown",
              call: "",
              decision: "read",
              decidedAt: new Date(0).toISOString(),
            },
          ],
        })}\n`,
      )

      await expect(review(report, { ledger })).rejects.toThrow(/^Invalid review ledger:/)
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("rejects malformed ledger rows through suggestRules", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")
    const rules = path.join(tmp.dir, "python-rules.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "reader.fetch('x')" }),
      })

      const src = new URL("../../src/python/python-rules.json", import.meta.url)
      await writeFile(rules, await readFile(src, "utf8"))

      const report = await scan({ db: tmp.file, samples: 3 })
      const occurrence = report.occurrences[0]!
      await writeFile(
        ledger,
        `${JSON.stringify({
          version: 1,
          decisions: [
            {
              fingerprint: occurrence.fingerprint,
              kind: "unknown",
              decision: "read",
              decidedAt: new Date(0).toISOString(),
            },
          ],
        })}\n`,
      )

      await expect(suggestRules(report, { ledger, rules })).rejects.toThrow(/^Invalid review ledger:/)
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("rejects malformed ledger rows through promotions", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")
    const rules = path.join(tmp.dir, "python-rules.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "reader.fetch('x')" }),
      })

      const src = new URL("../../src/python/python-rules.json", import.meta.url)
      await writeFile(rules, await readFile(src, "utf8"))

      const report = await scan({ db: tmp.file, samples: 3 })
      const occurrence = report.occurrences[0]!
      await writeFile(
        ledger,
        `${JSON.stringify({
          version: 1,
          decisions: [
            {
              fingerprint: occurrence.fingerprint,
              kind: "unknown",
              call: "",
              decision: "read",
              decidedAt: new Date(0).toISOString(),
            },
          ],
        })}\n`,
      )

      await expect(promotions(report, { ledger, rules })).rejects.toThrow(/^Invalid review ledger:/)
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("scores HTTP-like verbs and in-memory mutators conservatively", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data(
          "python",
          {
            code: [
              "client.get('https://example.com/api')",
              "client.post('https://example.com/api')",
              "changed = []",
              "changed.append(str(path_obj))",
            ].join("\n"),
          },
        ),
      })

      const queue = await review(await scan({ db: tmp.file, samples: 3 }), { ledger })
      const get = queue.snippets[0]?.candidates.find((item) => item.call === "client.get")
      const post = queue.snippets[0]?.candidates.find((item) => item.call === "client.post")
      const append = queue.snippets[0]?.candidates.find((item) => item.call === "changed.append")

      expect(get?.readConfidence).toBeGreaterThan(get?.writeConfidence ?? 1)
      expect(post?.writeConfidence).toBeGreaterThan(post?.readConfidence ?? 1)
      expect(append).toBeUndefined()
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("reuses matching review-identity decisions across different snippet contexts", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000), ('s2', 'Beta', 3000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "reader.fetch(source_path)" }),
      })
      put(tmp.db, {
        id: "p2",
        messageID: "m2",
        sessionID: "s2",
        created: 2000,
        updated: 3000,
        data: data("python", { code: "reader.fetch(target_path)\nwriter.save('y')" }),
      })

      const report = await scan({ db: tmp.file, samples: 3 })
      const initial = await review(report, { ledger })
      const first = initial.snippets.find((item) => item.code === "reader.fetch(source_path)")
      const second = initial.snippets.find((item) => item.code === "reader.fetch(target_path)\nwriter.save('y')")
      await recordOccurrenceDecision(ledger, first!.candidates[0]!, "read")

      const merged = await review(report, { ledger })
      const pending = merged.snippets.find((item) => item.code === second!.code)
      const resolved = pending?.candidates.find((item) => item.call === "reader.fetch")
      expect(resolved?.decision).toBe("read")
      expect(merged.totals.pendingCandidates).toBe(1)
      expect(merged.totals.decidedCandidates).toBe(1)
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("keeps review items unresolved when matching review identities conflict", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000), ('s2', 'Beta', 3000), ('s3', 'Gamma', 4000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "reader.fetch(source_path)" }),
      })
      put(tmp.db, {
        id: "p2",
        messageID: "m2",
        sessionID: "s2",
        created: 2000,
        updated: 3000,
        data: data("python", { code: "reader.fetch(target_path)" }),
      })
      put(tmp.db, {
        id: "p3",
        messageID: "m3",
        sessionID: "s3",
        created: 3000,
        updated: 4000,
        data: data("python", { code: "reader.fetch(extra_path)\nwriter.save('y')" }),
      })

      const report = await scan({ db: tmp.file, samples: 3 })
      const initial = await review(report, { ledger })
      const source = initial.snippets.find((item) => item.code === "reader.fetch(source_path)")!
      const target = initial.snippets.find((item) => item.code === "reader.fetch(target_path)")!

      await recordOccurrenceDecision(ledger, source.candidates[0]!, "read")
      await recordOccurrenceDecision(ledger, target.candidates[0]!, "write")

      const merged = await review(report, { ledger })
      const pending = merged.snippets.find((item) => item.code === "reader.fetch(extra_path)\nwriter.save('y')")
      const unresolved = pending?.candidates.find((item) => item.call === "reader.fetch")
      expect(unresolved?.decision).toBeUndefined()
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("does not reuse decisions when the display call matches but sourceCall differs", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")

    try {
      const time = new Date(2000).toISOString()
      const report = {
        generatedAt: new Date(0).toISOString(),
        db: tmp.file,
        analyzerVersion: "python-analyzer/v2",
        engineVersion: "python-ir-v2",
        filters: { samples: 3 },
        totals: {
          sessions: 1,
          toolParts: 1,
          inlineSnippets: 2,
          unknownEvents: 0,
          uniqueUnknownCalls: 0,
          skippedRows: 0,
        },
        unknown: [],
        occurrences: [
          {
            kind: "pure" as const,
            call: "item.group",
            sourceCall: "re.Match.group",
            canonicalSource: "re.Match.group",
            fingerprint: "fp-match",
            snippetFingerprint: "snippet-match",
            sessionID: "s1",
            messageID: "m1",
            partID: "p1",
            title: "Alpha",
            time,
            preview: "item.group(1)",
            code: "item = re.search('a+', text)\nitem.group(1)",
            confidence: { read: 0.05, write: 0.05, emit: 0.02, exec: 0.03, pure: 0.92, unknown: 0.08 },
            readConfidence: 0.05,
            writeConfidence: 0.05,
            reasons: [],
            scoreSource: "heuristic",
          },
          {
            kind: "pure" as const,
            call: "item.group",
            sourceCall: "collections.Group.group",
            canonicalSource: "collections.Group.group",
            fingerprint: "fp-other",
            snippetFingerprint: "snippet-other",
            sessionID: "s2",
            messageID: "m2",
            partID: "p2",
            title: "Beta",
            time,
            preview: "item.group(1)",
            code: "item = custom_group()\nitem.group(1)",
            confidence: { read: 0.05, write: 0.05, emit: 0.02, exec: 0.03, pure: 0.91, unknown: 0.09 },
            readConfidence: 0.05,
            writeConfidence: 0.05,
            reasons: [],
            scoreSource: "heuristic",
          },
        ],
      }

      await recordOccurrenceDecision(ledger, report.occurrences[0]!, "pure")
      const queue = await review(report, { ledger })
      const pending = queue.snippets.find((item) => item.snippetFingerprint === "snippet-other")
      expect(queue.snippets).toHaveLength(1)
      expect(pending?.candidates[0]?.decision).toBeUndefined()
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("does not reuse decisions when the display call matches but kind differs", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")

    try {
      const time = new Date(2000).toISOString()
      const report = {
        generatedAt: new Date(0).toISOString(),
        db: tmp.file,
        analyzerVersion: "python-analyzer/v2",
        engineVersion: "python-ir-v2",
        filters: { samples: 3 },
        totals: {
          sessions: 1,
          toolParts: 1,
          inlineSnippets: 2,
          unknownEvents: 1,
          uniqueUnknownCalls: 1,
          skippedRows: 0,
        },
        unknown: [],
        occurrences: [
          {
            kind: "unknown" as const,
            call: "foo.bar",
            canonicalSource: "foo.bar",
            fingerprint: "fp-unknown",
            snippetFingerprint: "snippet-unknown",
            sessionID: "s1",
            messageID: "m1",
            partID: "p1",
            title: "Alpha",
            time,
            preview: "foo.bar()",
            code: "foo.bar()",
            confidence: { read: 0.2, write: 0.25, emit: 0.05, exec: 0.06, pure: 0.04, unknown: 0.4 },
            readConfidence: 0.2,
            writeConfidence: 0.25,
            reasons: [],
            scoreSource: "heuristic",
          },
          {
            kind: "emit" as const,
            call: "foo.bar",
            canonicalSource: "foo.bar",
            fingerprint: "fp-emit",
            snippetFingerprint: "snippet-emit",
            sessionID: "s2",
            messageID: "m2",
            partID: "p2",
            title: "Beta",
            time,
            preview: "foo.bar()",
            code: "foo.bar()",
            confidence: { read: 0.08, write: 0.1, emit: 0.9, exec: 0.03, pure: 0.02, unknown: 0.1 },
            readConfidence: 0.08,
            writeConfidence: 0.1,
            reasons: [],
            scoreSource: "heuristic",
          },
        ],
      }

      await recordOccurrenceDecision(ledger, report.occurrences[0]!, "read")
      const queue = await review(report, { ledger })
      const pending = queue.snippets.find((item) => item.snippetFingerprint === "snippet-emit")
      expect(queue.snippets).toHaveLength(1)
      expect(pending?.candidates[0]?.decision).toBeUndefined()
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("renders and advances the next review item after batch decisions", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000), ('s2', 'Beta', 3000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 4000,
        data: data("python", { code: "reader.fetch('x')\nwriter.save('y')" }),
      })
      put(tmp.db, {
        id: "p2",
        messageID: "m2",
        sessionID: "s2",
        created: 2000,
        updated: 3000,
        data: data("python", { code: "other.fetch()" }),
      })

      const report = await scan({ db: tmp.file, samples: 3 })
      expect(report.occurrences[0]?.evidence).toBeUndefined()
      const queue = await review(report, { ledger })
      const first = nextReview(queue)
      expect(renderReview(first!)).toContain("Candidates:")
      expect(renderReview(first!)).toContain("1. reader.fetch")
      expect(renderReview(first!)).toContain("2. writer.save")

      await applyDecisions({ ledger, item: first!, decide: "1=read,2=write" })

      const next = nextReview(await review(report, { ledger }))
      expect(next?.code).toBe("other.fetch()")
      expect(next?.candidates[0]?.call).toBe("other.fetch")
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("uses opencode scores for review-next and caches them", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")
    const cache = path.join(tmp.dir, "score-cache.json")
    let calls = 0

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "reader.fetch('x')\nwriter.save('y')" }),
      })

      const item = nextReview(await review(await scan({ db: tmp.file, samples: 3, includeEmit: true }), { ledger }))
      const out = await rescore(item!, {
        cache,
        run: async () => {
          calls++
          return JSON.stringify({
            scores: item!.candidates.map((item, i) => ({
              fingerprint: item.fingerprint,
              call: item.call,
              confidence: {
                read: i === 0 ? 0.81 : 0.12,
                write: i === 0 ? 0.11 : 0.84,
                emit: 0.08,
                exec: 0.09,
                pure: 0.05,
                unknown: 0.2,
              },
              reasons: [i === 0 ? "looks like a fetch" : "looks like an append"],
            })),
          })
        },
      })

      expect(out.warning).toBeUndefined()
      expect(out.item.candidates[0]?.scoreSource).toBe("opencode-run")
      expect(out.item.candidates[0]?.confidence.read).toBe(0.81)
      expect(out.item.candidates[1]?.confidence.write).toBe(0.84)
      expect(renderReview(out.item)).toContain("source=opencode-run")

      const again = await rescore(item!, {
        cache,
        run: async () => {
          calls++
          throw new Error("cache should have been used")
        },
      })
      expect(calls).toBe(1)
      expect(again.item.candidates[0]?.scoreSource).toBe("opencode-cache")
      expect(again.item.candidates[0]?.confidence.read).toBe(0.81)
      expect(renderReview(again.item)).toContain("source=opencode-cache")
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("falls back to heuristic scores when opencode scoring fails", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")
    const cache = path.join(tmp.dir, "score-cache.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "reader.fetch('x')" }),
      })

      const item = nextReview(await review(await scan({ db: tmp.file, samples: 3 }), { ledger }))
      const out = await rescore(item!, { cache, run: async () => "not-json" })
      expect(out.warning).toContain("heuristic fallback")
      expect(out.item.candidates[0]?.scoreSource).toBe("heuristic-fallback")
      expect(out.item.candidates[0]?.readConfidence).toBe(item?.candidates[0]?.readConfidence)
      expect(renderReview(out.item)).toContain("source=heuristic-fallback")
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("falls back when scorer JSON has invalid confidence fields", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")
    const cache = path.join(tmp.dir, "score-cache.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "reader.fetch('x')" }),
      })

      const item = nextReview(await review(await scan({ db: tmp.file, samples: 3 }), { ledger }))
      const out = await rescore(item!, {
        cache,
        run: async () =>
          JSON.stringify({
            scores: [
              {
                fingerprint: item!.candidates[0]!.fingerprint,
                call: "reader.fetch",
                confidence: {
                  read: 0.8,
                  write: 0.1,
                  emit: 0.1,
                  exec: 0.1,
                  pure: 0.1,
                  unknown: "high",
                },
                reasons: [],
              },
            ],
          }),
      })
      expect(out.warning).toContain("heuristic fallback")
      expect(out.item.candidates[0]?.scoreSource).toBe("heuristic-fallback")
      await expect(access(cache)).rejects.toBeDefined()
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("supports fingerprint-based batch decisions", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "reader.fetch('x')\nwriter.save('y')" }),
      })

      const item = nextReview(await review(await scan({ db: tmp.file, samples: 3 }), { ledger }))
      const decide = item!.candidates.map((candidate, i) => `${candidate.fingerprint}=${i === 0 ? "read" : "write"}`).join(",")
      await applyDecisions({ ledger, item: item!, decide })

      const ledgerData = JSON.parse(await readFile(ledger, "utf8")) as Record<string, any>
      expect(ledgerData.decisions).toHaveLength(2)
      expect(new Set(ledgerData.decisions.map((decision: Record<string, any>) => decision.kind))).toEqual(new Set(["unknown"]))
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("persists source-call identity for batch decisions", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: ["from pathlib import Path", "p = Path('x')", "p.joinpath('a')"].join("\n") }),
      })

      const item = nextReview(await review(await scan({ db: tmp.file, samples: 3, includePure: true }), { ledger }))
      await applyDecisions({ ledger, item: item!, decide: `${item!.candidates[0]!.fingerprint}=pure` })

      const ledgerData = JSON.parse(await readFile(ledger, "utf8")) as Record<string, any>
      expect(ledgerData.decisions).toEqual([
        expect.objectContaining({
          kind: "pure",
          call: "p.joinpath",
          sourceCall: "pathlib.Path.joinpath",
          decision: "pure",
        }),
      ])
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("keeps batch decisions atomic for duplicate targets", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "reader.fetch('x')\nwriter.save('y')" }),
      })

      const item = nextReview(await review(await scan({ db: tmp.file, samples: 3 }), { ledger }))
      await expect(applyDecisions({ ledger, item: item!, decide: "1=read,1=write" })).rejects.toThrow(/Duplicate decision target/)
      await expect(access(ledger)).rejects.toBeDefined()
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("keeps batch decisions atomic for invalid later targets", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "reader.fetch('x')\nwriter.save('y')" }),
      })

      const item = nextReview(await review(await scan({ db: tmp.file, samples: 3 }), { ledger }))
      await expect(applyDecisions({ ledger, item: item!, decide: "1=read,99=write" })).rejects.toThrow(/Decision target not found/)
      await expect(access(ledger)).rejects.toBeDefined()
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("promotes consistently reviewed callables into live rule buckets", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")
    const rules = path.join(tmp.dir, "python-rules.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "reader.fetch('x')\nwriter.save('y')" }),
      })

      const src = new URL("../../src/python/python-rules.json", import.meta.url)
      const base = JSON.parse(await readFile(src, "utf8")) as Record<string, any>
      base.candidates = {
        unknown: [
          { call: "reader.fetch", count: 1, lastSeen: new Date(2000).toISOString(), examples: ["s1"] },
          { call: "writer.save", count: 1, lastSeen: new Date(2000).toISOString(), examples: ["s1"] },
        ],
      }
      await writeFile(rules, JSON.stringify(base))

      const report = await scan({ db: tmp.file, samples: 3 })
      const item = nextReview(await review(report, { ledger }))
      await applyDecisions({ ledger, item: item!, decide: "1=read,2=write" })

      const plan = await promotions(report, { ledger, rules })
      expect(plan.promotable.read).toEqual(["reader.fetch"])
      expect(plan.promotable.write).toEqual(["writer.save"])
      expect(plan.blocked).toEqual([])
      expect(renderPromotions(plan)).toContain("read: 1")

      await promote(report, { ledger, rules })
      const next = JSON.parse(await readFile(rules, "utf8")) as Record<string, any>
      expect(next.calls.read).toContain("reader.fetch")
      expect(next.calls.write).toContain("writer.save")
      expect(next.candidates.unknown).toEqual([])
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("promotes reviewed emit callables into calls.emit", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")
    const freshLedger = path.join(tmp.dir, "fresh-review-ledger.json")
    const rules = path.join(tmp.dir, "python-rules.json")
    const promotedRules = path.join(tmp.dir, "python-rules-promoted.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "notifier('x')" }),
      })

      const src = new URL("../../src/python/python-rules.json", import.meta.url)
      const base = JSON.parse(await readFile(src, "utf8")) as Record<string, any>
      base.calls.emit = (base.calls.emit as string[]).filter((item) => item !== "print")
      await writeFile(rules, `${JSON.stringify(base, null, 2)}\n`)

      const priorRules = process.env.OPENCODE_PYTHON_RULES
      process.env.OPENCODE_PYTHON_RULES = rules

      try {
        const report = await scan({ db: tmp.file, samples: 3 })
        const reviewItem = nextReview(await review(report, { ledger }))
        expect(reviewItem?.candidates[0]?.call).toBe("notifier")
        await applyDecisions({ ledger, item: reviewItem!, decide: "1=emit" })

        const plan = await promotions(report, { ledger, rules })
        expect(plan.promotable.emit).toEqual(["notifier"])

        await promote(report, { ledger, rules })
        const nextText = await readFile(rules, "utf8")
        const next = JSON.parse(nextText) as Record<string, any>
        expect(next.calls.emit).toContain("notifier")
        await writeFile(promotedRules, nextText)
        process.env.OPENCODE_PYTHON_RULES = promotedRules

        const rerun = await review(await scan({ db: tmp.file, samples: 3 }), { ledger: freshLedger })
        expect(rerun.totals.pendingCandidates).toBe(0)
        expect(nextReview(rerun)).toBeUndefined()
      } finally {
        if (priorRules === undefined) delete process.env.OPENCODE_PYTHON_RULES
        else process.env.OPENCODE_PYTHON_RULES = priorRules
      }
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("promotes callables once a matching review-identity decision exists", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")
    const rules = path.join(tmp.dir, "python-rules.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000), ('s2', 'Beta', 3000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "reader.fetch(source_path)" }),
      })
      put(tmp.db, {
        id: "p2",
        messageID: "m2",
        sessionID: "s2",
        created: 2000,
        updated: 3000,
        data: data("python", { code: "reader.fetch(target_path)" }),
      })

      const src = new URL("../../src/python/python-rules.json", import.meta.url)
      await writeFile(rules, await readFile(src, "utf8"))

      const report = await scan({ db: tmp.file, samples: 3 })
      const queue = await review(report, { ledger })
      const second = queue.snippets.find((item) => item.code === "reader.fetch(source_path)")
      await recordOccurrenceDecision(ledger, second!.candidates[0]!, "read")

      const plan = await promotions(report, { ledger, rules })
      expect(plan.promotable.read).toEqual(["reader.fetch"])
      expect(plan.blocked).toEqual([])
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("blocks promotion when multiple review identities share one outward call", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")
    const rules = path.join(tmp.dir, "python-rules.json")
    const time = new Date(2000).toISOString()

    try {
      const report = {
        generatedAt: new Date(0).toISOString(),
        db: tmp.file,
        analyzerVersion: "python-analyzer/v2",
        engineVersion: "python-ir-v2",
        filters: { samples: 3 },
        totals: {
          sessions: 1,
          toolParts: 1,
          inlineSnippets: 2,
          unknownEvents: 2,
          uniqueUnknownCalls: 1,
          skippedRows: 0,
        },
        unknown: [
          {
            call: "item.group",
            count: 2,
            lastSeen: time,
            sessions: [
              { id: "s2", title: "Beta", time },
              { id: "s1", title: "Alpha", time },
            ],
            samples: [
              { sessionID: "s1", messageID: "m1", partID: "p1", title: "Alpha", time, preview: "item.group(1)" },
              { sessionID: "s2", messageID: "m2", partID: "p2", title: "Beta", time, preview: "item.group(1)" },
            ],
          },
        ],
        occurrences: [
          {
            kind: "unknown" as const,
            call: "item.group",
            sourceCall: "re.Match.group",
            canonicalSource: "re.Match.group",
            fingerprint: "fp-match",
            snippetFingerprint: "snippet-match",
            sessionID: "s1",
            messageID: "m1",
            partID: "p1",
            title: "Alpha",
            time,
            preview: "item.group(1)",
            code: "item = re.search('a+', text)\nitem.group(1)",
            confidence: { read: 0.45, write: 0.12, emit: 0.03, exec: 0.05, pure: 0.06, unknown: 0.29 },
            readConfidence: 0.45,
            writeConfidence: 0.12,
            reasons: [],
            scoreSource: "heuristic",
          },
          {
            kind: "unknown" as const,
            call: "item.group",
            sourceCall: "collections.Group.group",
            canonicalSource: "collections.Group.group",
            fingerprint: "fp-other",
            snippetFingerprint: "snippet-other",
            sessionID: "s2",
            messageID: "m2",
            partID: "p2",
            title: "Beta",
            time,
            preview: "item.group(1)",
            code: "item = custom_group()\nitem.group(1)",
            confidence: { read: 0.44, write: 0.13, emit: 0.03, exec: 0.05, pure: 0.07, unknown: 0.28 },
            readConfidence: 0.44,
            writeConfidence: 0.13,
            reasons: [],
            scoreSource: "heuristic",
          },
        ],
      }

      const src = new URL("../../src/python/python-rules.json", import.meta.url)
      const base = JSON.parse(await readFile(src, "utf8")) as Record<string, any>
      base.calls.read = (base.calls.read as string[]).filter((item) => item !== "item.group")
      base.candidates = { unknown: [{ call: "item.group", count: 2, lastSeen: time, examples: ["s1"] }] }
      await writeFile(rules, `${JSON.stringify(base, null, 2)}\n`)

      await recordOccurrenceDecision(ledger, report.occurrences[0]!, "read")
      await recordOccurrenceDecision(ledger, report.occurrences[1]!, "read")

      const plan = await promotions(report, { ledger, rules })
      expect(plan.promotable.read).toEqual([])
      expect(plan.blocked).toEqual([
        {
          call: "item.group",
          reason: "multiple review identities share this call",
          decisions: ["read"],
          pendingContexts: 0,
        },
      ])

      await promote(report, { ledger, rules })
      const next = JSON.parse(await readFile(rules, "utf8")) as Record<string, any>
      expect(next.calls.read).not.toContain("item.group")
      expect(next.candidates.unknown).toEqual([{ call: "item.group", count: 2, lastSeen: time, examples: ["s1"] }])
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("suggests preview-only rules from unanimous reviewed evidence", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")
    const rules = path.join(tmp.dir, "python-rules.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000), ('s2', 'Beta', 3000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "reader.fetch(source_path)" }),
      })
      put(tmp.db, {
        id: "p2",
        messageID: "m2",
        sessionID: "s2",
        created: 2000,
        updated: 3000,
        data: data("python", { code: "reader.fetch(target_path)" }),
      })

      const src = new URL("../../src/python/python-rules.json", import.meta.url)
      await writeFile(rules, await readFile(src, "utf8"))

      const report = await scan({ db: tmp.file, samples: 3 })
      await recordOccurrenceDecision(ledger, report.occurrences[0]!, "read")
      const before = await readFile(rules, "utf8")

      const suggested = await suggestRules(report, { ledger, rules })
      expect(suggested.totals.suggested).toBe(1)
      expect(suggested.suggestions[0]?.call).toBe("reader.fetch")
      expect(suggested.suggestions[0]?.decision).toBe("read")
      expect(suggested.suggestions[0]?.fragment).toEqual({ calls: { read: ["reader.fetch"] } })
      expect(renderSuggestions(suggested)).toContain("reader.fetch -> read")
      expect(await readFile(rules, "utf8")).toBe(before)
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("suggests guarded method fragments from unanimous match evidence and merges aliases", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")
    const rules = path.join(tmp.dir, "python-rules.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000), ('s2', 'Beta', 3000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "import re\nfirst = re.search('a+', text)\nfirst.group(1)" }),
      })
      put(tmp.db, {
        id: "p2",
        messageID: "m2",
        sessionID: "s2",
        created: 2000,
        updated: 3000,
        data: data("python", { code: "import re\nsecond = re.search('a+', text)\nsecond.group(1)" }),
      })

      const src = new URL("../../src/python/python-rules.json", import.meta.url)
      await writeFile(rules, await readFile(src, "utf8"))

      const report = await scan({ db: tmp.file, samples: 3, includePure: true })
      for (const occurrence of report.occurrences.filter((item) => item.kind === "pure" && item.call.endsWith(".group"))) {
        await recordOccurrenceDecision(ledger, occurrence, "pure")
      }

      const suggested = await suggestRules(report, { ledger, rules })
      expect(suggested.totals.suggested).toBe(1)
      expect(suggested.suggestions[0]?.aliases).toEqual(["first.group", "second.group"])
      expect(suggested.suggestions[0]?.snippetCount).toBe(2)
      expect(suggested.suggestions[0]?.fragment).toEqual({
        guarded: {
          methods: [
            {
              method: "group",
              effect: "pure.compute",
              guards: [{ type: "receiverKindIn", kinds: ["match"] }],
            },
          ],
        },
      })
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("keeps guarded suggestion synthesis stable under occurrence reordering", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")
    const rules = path.join(tmp.dir, "python-rules.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000), ('s2', 'Beta', 3000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "import re\nfirst = re.search('a+', text)\nfirst.group(1)" }),
      })
      put(tmp.db, {
        id: "p2",
        messageID: "m2",
        sessionID: "s2",
        created: 2000,
        updated: 3000,
        data: data("python", { code: "import re\nsecond = re.search('a+', text)\nsecond.group(1)" }),
      })

      const src = new URL("../../src/python/python-rules.json", import.meta.url)
      await writeFile(rules, await readFile(src, "utf8"))

      const report = await scan({ db: tmp.file, samples: 3, includePure: true })
      for (const occurrence of report.occurrences.filter((item) => item.kind === "pure" && item.call.endsWith(".group"))) {
        await recordOccurrenceDecision(ledger, occurrence, "pure")
      }

      const forward = await suggestRules(report, { ledger, rules })
      const reversed = await suggestRules({ ...report, occurrences: [...report.occurrences].reverse() }, { ledger, rules })
      expect(reversed.suggestions).toEqual(forward.suggestions)
      expect(reversed.blocked).toEqual(forward.blocked)
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("blocks canonical-source aliases when no safe structured fragment exists", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")
    const rules = path.join(tmp.dir, "python-rules.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "from pathlib import Path\nsrc = Path('f')\nsrc.joinpath('a')" }),
      })

      const src = new URL("../../src/python/python-rules.json", import.meta.url)
      await writeFile(rules, await readFile(src, "utf8"))

      const report = await scan({ db: tmp.file, samples: 3, includePure: true })
      const occurrence = report.occurrences.find((item) => item.call === "src.joinpath")!
      await recordOccurrenceDecision(ledger, occurrence, "pure")

      const suggested = await suggestRules(report, { ledger, rules })
      expect(suggested.totals.suggested).toBe(0)
      expect(suggested.blocked).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ call: "src.joinpath", reasons: expect.arrayContaining(["no safe structured fragment"]) }),
        ]),
      )
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("threads analyzer evidence into review output and blocks mixed-evidence suggestions", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")
    const rules = path.join(tmp.dir, "python-rules.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000), ('s2', 'Beta', 3000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "item = re.search('a+', text)\nitem.group(1)" }),
      })
      put(tmp.db, {
        id: "p2",
        messageID: "m2",
        sessionID: "s2",
        created: 2000,
        updated: 3000,
        data: data("python", { code: "item.group(1)" }),
      })

      const src = new URL("../../src/python/python-rules.json", import.meta.url)
      await writeFile(rules, await readFile(src, "utf8"))

      const report = await scan({ db: tmp.file, samples: 3, includePure: true })
      const pureOccurrence = report.occurrences.find((item) => item.kind === "pure" && item.call === "item.group")
      const unknownOccurrence = report.occurrences.find((item) => item.kind === "unknown" && item.call === "item.group")
      expect(pureOccurrence?.evidence).toEqual(expect.objectContaining({ receiverKind: "match" }))
      expect(unknownOccurrence?.evidence?.guardFailure).toEqual(expect.objectContaining({ type: "receiverKindIn" }))

      const queue = await review(report, { ledger })
      const rendered = renderReview(nextReview(queue)!)
      expect(rendered).toContain("evidence:")
      expect(queue.snippets[0]?.candidates[0]?.canonicalSource).toBeDefined()
      
      for (const occurrence of report.occurrences.filter((item) => item.call === "item.group")) {
        await recordOccurrenceDecision(ledger, occurrence, "pure")
      }

      const suggested = await suggestRules(report, { ledger, rules })
      expect(suggested.totals.suggested).toBe(0)
      expect(suggested.blocked).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ call: "item.group", reasons: expect.arrayContaining(["multiple evidence signatures"]) }),
        ]),
      )
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("compares alternate rules files against the current rules", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")
    const rules = path.join(tmp.dir, "python-rules.json")
    const alternate = path.join(tmp.dir, "python-rules-alt.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "reader.fetch('x')" }),
      })

      const src = new URL("../../src/python/python-rules.json", import.meta.url)
      const base = JSON.parse(await readFile(src, "utf8")) as Record<string, any>
      await writeFile(rules, `${JSON.stringify(base, null, 2)}\n`)
      base.calls.read = [...(base.calls.read as string[]), "reader.fetch"]
      await writeFile(alternate, `${JSON.stringify(base, null, 2)}\n`)
      const beforeCurrent = await readFile(rules, "utf8")
      const beforeAlternate = await readFile(alternate, "utf8")

      const compared = await compareRules({
        db: tmp.file,
        samples: 3,
        includeEmit: false,
        includePure: false,
        ledger,
        rules,
        compareRules: alternate,
      })

      expect(compared.resolvedUnknownCalls).toEqual(["reader.fetch"])
      expect(compared.alternate.uniqueUnknownCalls).toBe(0)
      expect(renderRulesCompare(compared)).toContain("Resolved unknown calls: reader.fetch")
      expect(await readFile(rules, "utf8")).toBe(beforeCurrent)
      expect(await readFile(alternate, "utf8")).toBe(beforeAlternate)
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("rejects partial-window promotion", () => {
    expect(() => parse(["--promote-reviewed", "--since", "2026-03-01T00:00:00Z"])).toThrow(
      "--promote-reviewed requires a full scan; omit --since",
    )
  })

  it("parses --include-pure", () => {
    expect(parse(["--include-pure"]).includePure).toBeTrue()
  })

  it("parses --include-emit", () => {
    expect(parse(["--include-emit"]).includeEmit).toBeTrue()
  })

  it("parses rule suggestion options", () => {
    expect(parse(["--suggest-rules"]).suggestRules).toBeTrue()
    expect(parse(["--compare-rules", "/tmp/rules.json"]).compareRules).toBe("/tmp/rules.json")
  })

  it("rejects invalid suggestion option combinations", () => {
    expect(() => parse(["--suggest-rules", "--review-next"])).toThrow(
      "--suggest-rules cannot be combined with review, update, or promotion modes",
    )
    expect(() => parse(["--compare-rules", "/tmp/rules.json", "--suggest-rules"])).toThrow(
      "--compare-rules cannot be combined with review, update, promotion, or suggest modes",
    )
    expect(() => parse(["--record-decision", "abc=read", "--suggest-rules"])).toThrow(
      "--record-decision cannot be combined with suggest or compare rules modes",
    )
    expect(() => parse(["--record-decision", "abc=read", "--compare-rules", "/tmp/rules.json"])).toThrow(
      "--record-decision cannot be combined with suggest or compare rules modes",
    )
    expect(() => parse(["--compare-rules"])).toThrow("Missing value for --compare-rules")
  })

  it("rejects removed compare-analyzer flags", () => {
    expect(() => parse(["--compare-analyzer"])).toThrow("Unknown argument: --compare-analyzer")
    expect(() => parse(["--enable-provenance-graph"])).toThrow("Unknown argument: --enable-provenance-graph")
    expect(() => parse(["--enable-rules-guards"])).toThrow("Unknown argument: --enable-rules-guards")
  })

  it("backfills taxonomy confidence from legacy read/write scorer rows", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")
    const cache = path.join(tmp.dir, "score-cache.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "reader.fetch('x')" }),
      })

      const item = nextReview(await review(await scan({ db: tmp.file, samples: 3, includeEmit: true }), { ledger }))
      const out = await rescore(item!, {
        cache,
        run: async () =>
          JSON.stringify({
            scores: [{ fingerprint: item!.candidates[0]!.fingerprint, call: "reader.fetch", readConfidence: 0.82, writeConfidence: 0.1, reasons: [] }],
          }),
      })

      expect(out.warning).toBeUndefined()
      expect(out.item.candidates[0]?.readConfidence).toBe(0.82)
      expect(out.item.candidates[0]?.confidence.read).toBe(0.82)
      expect(out.item.candidates[0]?.confidence.write).toBe(0.1)
      expect(out.item.candidates[0]?.confidence.unknown).toBeGreaterThan(0)
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("rehydrates legacy cache rows with candidate-kind taxonomy defaults", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")
    const cache = path.join(tmp.dir, "score-cache.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "print('x')" }),
      })

      const item = nextReview(await review(await scan({ db: tmp.file, samples: 3, includeEmit: true }), { ledger }))
      await rescore(item!, {
        cache,
        run: async () =>
          JSON.stringify({
            scores: [{ fingerprint: item!.candidates[0]!.fingerprint, call: "print", readConfidence: 0.2, writeConfidence: 0.1, reasons: [] }],
          }),
      })

      const doc = JSON.parse(await readFile(cache, "utf8")) as Record<string, any>
      doc.entries[0].scores = doc.entries[0].scores.map((row: Record<string, any>) => ({
        fingerprint: row.fingerprint,
        call: row.call,
        readConfidence: row.readConfidence,
        writeConfidence: row.writeConfidence,
        reasons: row.reasons,
      }))
      await writeFile(cache, JSON.stringify(doc))

      const out = await rescore(item!, {
        cache,
        run: async () => {
          throw new Error("cache should have been used")
        },
      })

      expect(out.item.candidates[0]?.scoreSource).toBe("opencode-cache")
      expect(out.item.candidates[0]?.kind).toBe("emit")
      expect(out.item.candidates[0]?.confidence.emit).toBeGreaterThanOrEqual(0.85)
      expect(out.item.candidates[0]?.confidence.unknown).toBeLessThanOrEqual(0.2)
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("maps one-key review actions around the suggested decision", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "reader.fetch('x')\nwriter.save('y')" }),
      })

      const pick = item(await review(await scan({ db: tmp.file, samples: 3 }), { ledger }))!
      expect(action("y", pick.candidate)).toEqual({ type: "decide", decision: "read" })
      expect(action("n", pick.candidate)).toEqual({ type: "decide", decision: "write" })
      expect(action("r", pick.candidate)).toEqual({ type: "decide", decision: "read" })
      expect(action("w", pick.candidate)).toEqual({ type: "decide", decision: "write" })
      expect(action("e", pick.candidate)).toEqual({ type: "decide", decision: "emit" })
      expect(action("x", pick.candidate)).toEqual({ type: "decide", decision: "exec" })
      expect(action("i", pick.candidate)).toEqual({ type: "decide", decision: "ignore" })
      expect(action("c", pick.candidate)).toEqual({ type: "decide", decision: "needs-code" })
      expect(action("s", pick.candidate)).toEqual({ type: "skip" })
      expect(action("v", pick.candidate)).toEqual({ type: "toggle" })
      expect(action("?", pick.candidate)).toEqual({ type: "help" })
      expect(action("q", pick.candidate)).toEqual({ type: "quit" })
      expect(action("z", pick.candidate)).toBeUndefined()

      const emitCandidate = { ...pick.candidate, kind: "emit" as const }
      expect(action("y", emitCandidate)).toEqual({ type: "decide", decision: "emit" })
      expect(action("n", emitCandidate)).toEqual({ type: "decide", decision: "ignore" })

      const execCandidate = {
        ...pick.candidate,
        kind: "unknown" as const,
        confidence: { read: 0.2, write: 0.1, emit: 0.1, exec: 0.72, pure: 0.08, unknown: 0.2 },
        readConfidence: 0.2,
        writeConfidence: 0.1,
      }
      expect(action("y", execCandidate)).toEqual({ type: "decide", decision: "ignore" })
      expect(action("n", execCandidate)).toEqual({ type: "decide", decision: "read" })

      const unknownCandidate = {
        ...pick.candidate,
        kind: "unknown" as const,
        confidence: { read: 0.2, write: 0.1, emit: 0.08, exec: 0.12, pure: 0.2, unknown: 0.65 },
        readConfidence: 0.2,
        writeConfidence: 0.1,
      }
      expect(action("y", unknownCandidate)).toEqual({ type: "decide", decision: "ignore" })
      expect(action("n", unknownCandidate)).toEqual({ type: "decide", decision: "read" })

      const nearUnknownCandidate = {
        ...pick.candidate,
        kind: "unknown" as const,
        confidence: { read: 0.42, write: 0.1, emit: 0.08, exec: 0.12, pure: 0.1, unknown: 0.69 },
        readConfidence: 0.42,
        writeConfidence: 0.1,
      }
      expect(action("y", nearUnknownCandidate)).toEqual({ type: "decide", decision: "read" })
      expect(action("n", nearUnknownCandidate)).toEqual({ type: "decide", decision: "write" })

      const pureCandidate = {
        ...pick.candidate,
        kind: "pure" as const,
        confidence: { read: 0.2, write: 0.1, emit: 0.08, exec: 0.08, pure: 0.84, unknown: 0.25 },
        readConfidence: 0.2,
        writeConfidence: 0.1,
      }
      expect(action("y", pureCandidate)).toEqual({ type: "decide", decision: "pure" })
      expect(action("n", pureCandidate)).toEqual({ type: "decide", decision: "ignore" })

      const unknownPureCandidate = {
        ...pick.candidate,
        kind: "unknown" as const,
        confidence: { read: 0.3, write: 0.1, emit: 0.08, exec: 0.09, pure: 0.7, unknown: 0.4 },
        readConfidence: 0.3,
        writeConfidence: 0.1,
      }
      expect(action("y", unknownPureCandidate)).toEqual({ type: "decide", decision: "pure" })
      expect(action("n", unknownPureCandidate)).toEqual({ type: "decide", decision: "ignore" })
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("advances to the next candidate when the current one is skipped", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "reader.fetch('x')\nwriter.save('y')" }),
      })

      const queue = await review(await scan({ db: tmp.file, samples: 3, includeEmit: true }), { ledger })
      const first = item(queue)!
      const next = item(queue, new Set([first.candidate.fingerprint]))!
      expect(first.candidate.call).toBe("reader.fetch")
      expect(next.candidate.call).toBe("writer.save")
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("records emit defaults from review tui for emit candidates", async () => {
    const tmp = await db()
    const ledgerAccept = path.join(tmp.dir, "review-ledger-accept.json")
    const ledgerReject = path.join(tmp.dir, "review-ledger-reject.json")
    const cache = path.join(tmp.dir, "score-cache.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "print('x')" }),
      })

      const report = await scan({ db: tmp.file, samples: 3, includeEmit: true })
      const queue = await review(report, { ledger: ledgerAccept })
      const first = item(queue)!
      await rescore(first.snippet, {
        cache,
        run: async () =>
          JSON.stringify({
            scores: [
              {
                fingerprint: first.candidate.fingerprint,
                call: first.candidate.call,
                confidence: { read: 0.1, write: 0.05, emit: 0.9, exec: 0.05, pure: 0.03, unknown: 0.1 },
                reasons: [],
              },
            ],
          }),
      })

      const inputAccept = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(flag: boolean): void }
      inputAccept.isTTY = true
      inputAccept.setRawMode = () => {}
      const outputAccept = new Writable({
        write(_chunk, _enc, done) {
          done()
        },
      }) as Writable & { isTTY: boolean }
      outputAccept.isTTY = true

      const runAccept = tui(await review(report, { ledger: ledgerAccept }), {
        ledger: ledgerAccept,
        cache,
        input: inputAccept as any,
        output: outputAccept as any,
      })
      setTimeout(() => inputAccept.emit("keypress", "y", { name: "y" }), 20)
      setTimeout(() => inputAccept.emit("keypress", "q", { name: "q" }), 80)
      await runAccept

      const accepted = JSON.parse(await readFile(ledgerAccept, "utf8")) as Record<string, any>
      expect(accepted.decisions[0]?.decision).toBe("emit")
      expect(accepted.decisions[0]?.kind).toBe("emit")

      const inputReject = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(flag: boolean): void }
      inputReject.isTTY = true
      inputReject.setRawMode = () => {}
      const outputReject = new Writable({
        write(_chunk, _enc, done) {
          done()
        },
      }) as Writable & { isTTY: boolean }
      outputReject.isTTY = true

      const runReject = tui(await review(report, { ledger: ledgerReject }), {
        ledger: ledgerReject,
        cache,
        input: inputReject as any,
        output: outputReject as any,
      })
      setTimeout(() => inputReject.emit("keypress", "n", { name: "n" }), 20)
      setTimeout(() => inputReject.emit("keypress", "q", { name: "q" }), 80)
      await runReject

      const rejected = JSON.parse(await readFile(ledgerReject, "utf8")) as Record<string, any>
      expect(rejected.decisions[0]?.decision).toBe("ignore")
      expect(rejected.decisions[0]?.kind).toBe("emit")
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("renders the review tui with highlighted code and full/collapsed views", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data(
          "python",
          {
            code: [
              "reader.fetch('x')",
              "line_2 = 2",
              "line_3 = 3",
              "line_4 = 4",
              "line_5 = 5",
              "line_6 = 6",
              "line_7 = 7",
              "line_8 = 8",
              "line_9 = 9",
              "line_10 = 10",
              "line_11 = 11",
              "writer.save('y')",
            ].join("\n"),
          },
        ),
      })

      const current = item(await review(await scan({ db: tmp.file, samples: 3 }), { ledger }))!
      const text = renderTui(current, true, false)
      expect(text).toContain("Call: reader.fetch")
      expect(text).toContain("source=heuristic")
      expect(text).toContain("[[reader.fetch]]")
      expect(text).toContain("\x1b[")
      expect(plain(text)).toContain(">   1 | [[reader.fetch]]('x')")
      expect(plain(text)).toContain("   12 | writer.save('y')")
      expect(text).toContain("Keys: y/n r/w e x i c s v ? q")
      expect(renderTui(current, false, false)).not.toContain("writer.save")
      expect(renderTui(current, false, false)).toContain("later lines hidden")
      expect(renderTui(current, false, true)).toContain("toggle full/focused code")
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("shows source-call context under Call in the review tui", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: ["from pathlib import Path", "p = Path('x')", "p.joinpath('a')"].join("\n") }),
      })

      const current = item(await review(await scan({ db: tmp.file, samples: 3, includePure: true }), { ledger }))!
      const text = renderTui(current, true, false)
      expect(text).toContain("Call: p.joinpath")
      expect(text).toContain("From: pathlib.Path.joinpath")
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("shows the full code page by default when the review tui opens", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")
    const cache = path.join(tmp.dir, "score-cache.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data(
          "python",
          {
            code: [
              "reader.fetch('x')",
              "line_2 = 2",
              "line_3 = 3",
              "line_4 = 4",
              "line_5 = 5",
              "line_6 = 6",
              "line_7 = 7",
              "line_8 = 8",
              "line_9 = 9",
              "line_10 = 10",
              "line_11 = 11",
              "writer.save('y')",
            ].join("\n"),
          },
        ),
      })

      const queue = await review(await scan({ db: tmp.file, samples: 3, includeEmit: true }), { ledger })
      const first = item(queue)!
      await rescore(first.snippet, {
        cache,
        run: async () =>
          JSON.stringify({
            scores: first.snippet.candidates.map((candidate) => ({
              fingerprint: candidate.fingerprint,
              call: candidate.call,
              confidence: {
                read: 0.9,
                write: 0.1,
                emit: 0.08,
                exec: 0.1,
                pure: 0.05,
                unknown: 0.2,
              },
              reasons: [],
            })),
          }),
      })

      const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(flag: boolean): void }
      input.isTTY = true
      input.setRawMode = () => {}

      let text = ""
      const output = new Writable({
        write(chunk, _enc, done) {
          text += String(chunk)
          done()
        },
      }) as Writable & { isTTY: boolean }
      output.isTTY = true

      const run = tui(queue, { ledger, cache, input: input as any, output: output as any })
      setTimeout(() => input.emit("keypress", "q", { name: "q" }), 20)
      await run

      const shown = plain(text)
      expect(shown).toContain(">   1 | [[reader.fetch]]('x')")
      expect(shown).toContain("   12 | writer.save('y')")
      expect(shown).not.toContain("later lines hidden")
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("highlights exact call matches without substring false positives", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "sprint('x')\nprint('y')" }),
      })

      const queue = await review(await scan({ db: tmp.file, samples: 3, includeEmit: true }), { ledger })
      const current = item(queue)!
      expect(current.candidate.call).toBe("print")
      const text = plain(renderTui(current, false, false))
      expect(text).toContain("    1 | sprint('x')")
      expect(text).toContain(">   2 | [[print]]('y')")
      expect(text).not.toContain("s[[print]]")
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("rejects conflicting review modes", () => {
    expect(() => parse(["--review-next", "--review-tui"])).toThrow(
      "Use only one of --review-json, --review-next, or --review-tui",
    )
  })

  it("rejects review tui without a tty", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "reader.fetch('x')" }),
      })

      const queue = await review(await scan({ db: tmp.file, samples: 3 }), { ledger })
      await expect(
        tui(queue, {
          ledger,
          cache: path.join(tmp.dir, "scores.json"),
          input: { isTTY: false } as any,
          output: { isTTY: false, write() {} } as any,
        }),
      ).rejects.toThrow("--review-tui requires a TTY; use --review-next for non-interactive review")
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("advances to the next candidate after accepting with y", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")
    const cache = path.join(tmp.dir, "score-cache.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "reader.fetch('x')\nwriter.save('y')" }),
      })

      const queue = await review(await scan({ db: tmp.file, samples: 3 }), { ledger })
      const first = item(queue)!
      await rescore(first.snippet, {
        cache,
        run: async () =>
          JSON.stringify({
            scores: first.snippet.candidates.map((candidate, i) => ({
              fingerprint: candidate.fingerprint,
              call: candidate.call,
              confidence: {
                read: i === 0 ? 0.9 : 0.2,
                write: i === 0 ? 0.1 : 0.8,
                emit: 0.08,
                exec: 0.1,
                pure: 0.05,
                unknown: 0.2,
              },
              reasons: [],
            })),
          }),
      })

      const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(flag: boolean): void }
      input.isTTY = true
      input.setRawMode = () => {}

      let text = ""
      const output = new Writable({
        write(chunk, _enc, done) {
          text += String(chunk)
          done()
        },
      }) as Writable & { isTTY: boolean }
      output.isTTY = true

      const run = tui(queue, { ledger, cache, input: input as any, output: output as any })
      setTimeout(() => input.emit("keypress", "y", { name: "y" }), 20)
      setTimeout(() => input.emit("keypress", "q", { name: "q" }), 80)
      await run

      const doc = JSON.parse(await readFile(ledger, "utf8")) as Record<string, any>
      expect(doc.decisions[0]?.call).toBe("reader.fetch")
      expect(text).toContain("Call: reader.fetch")
      expect(text).toContain("Call: writer.save")
      expect(plain(text)).toContain("Processing next item (reader.fetch)...")
      expect(plain(text)).toContain("Saving read for reader.fetch...")
      expect(plain(text)).toContain("Processing next item (writer.save)...")
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("skips repeated matching review identities after one tui decision", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")
    const cache = path.join(tmp.dir, "score-cache.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000), ('s2', 'Beta', 3000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 4000,
        data: data("python", { code: "reader.fetch(source_path)" }),
      })
      put(tmp.db, {
        id: "p2",
        messageID: "m2",
        sessionID: "s2",
        created: 2000,
        updated: 3000,
        data: data("python", { code: "reader.fetch(target_path)\nwriter.save('y')" }),
      })

      const queue = await review(await scan({ db: tmp.file, samples: 3 }), { ledger })
      for (const snippet of queue.snippets) {
        await rescore(snippet, {
          cache,
          run: async () =>
            JSON.stringify({
              scores: snippet.candidates.map((candidate) => ({
                fingerprint: candidate.fingerprint,
                call: candidate.call,
                confidence: {
                  read: 0.9,
                  write: 0.1,
                  emit: 0.08,
                  exec: 0.1,
                  pure: 0.05,
                  unknown: 0.2,
                },
                reasons: [],
              })),
            }),
        })
      }

      const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(flag: boolean): void }
      input.isTTY = true
      input.setRawMode = () => {}

      let text = ""
      const output = new Writable({
        write(chunk, _enc, done) {
          text += String(chunk)
          done()
        },
      }) as Writable & { isTTY: boolean }
      output.isTTY = true

      const run = tui(queue, { ledger, cache, input: input as any, output: output as any })
      setTimeout(() => input.emit("keypress", "y", { name: "y" }), 20)
      setTimeout(() => input.emit("keypress", "q", { name: "q" }), 160)
      await run

      expect(text).toContain("Call: reader.fetch")
      expect(text).toContain("Call: writer.save")
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("keeps same-call review items pending in tui when sourceCall differs", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")
    const cache = path.join(tmp.dir, "score-cache.json")
    const time = new Date(2000).toISOString()

    try {
      const report = {
        generatedAt: new Date(0).toISOString(),
        db: tmp.file,
        analyzerVersion: "python-analyzer/v2",
        engineVersion: "python-ir-v2",
        filters: { samples: 3 },
        totals: {
          sessions: 1,
          toolParts: 1,
          inlineSnippets: 2,
          unknownEvents: 0,
          uniqueUnknownCalls: 0,
          skippedRows: 0,
        },
        unknown: [],
        occurrences: [
          {
            kind: "pure" as const,
            call: "item.group",
            sourceCall: "re.Match.group",
            canonicalSource: "re.Match.group",
            fingerprint: "fp-match",
            snippetFingerprint: "snippet-match",
            sessionID: "s1",
            messageID: "m1",
            partID: "p1",
            title: "Alpha",
            time,
            preview: "item.group(1)",
            code: "item = re.search('a+', text)\nitem.group(1)",
            confidence: { read: 0.05, write: 0.05, emit: 0.02, exec: 0.03, pure: 0.92, unknown: 0.08 },
            readConfidence: 0.05,
            writeConfidence: 0.05,
            reasons: [],
            scoreSource: "heuristic",
          },
          {
            kind: "pure" as const,
            call: "item.group",
            sourceCall: "collections.Group.group",
            canonicalSource: "collections.Group.group",
            fingerprint: "fp-other",
            snippetFingerprint: "snippet-other",
            sessionID: "s2",
            messageID: "m2",
            partID: "p2",
            title: "Beta",
            time,
            preview: "item.group(1)",
            code: "item = custom_group()\nitem.group(1)",
            confidence: { read: 0.05, write: 0.05, emit: 0.02, exec: 0.03, pure: 0.91, unknown: 0.09 },
            readConfidence: 0.05,
            writeConfidence: 0.05,
            reasons: [],
            scoreSource: "heuristic",
          },
        ],
      }

      const queue = await review(report, { ledger })
      for (const snippet of queue.snippets) {
        await rescore(snippet, {
          cache,
          run: async () =>
            JSON.stringify({
              scores: snippet.candidates.map((candidate) => ({
                fingerprint: candidate.fingerprint,
                call: candidate.call,
                confidence: {
                  read: 0.05,
                  write: 0.05,
                  emit: 0.02,
                  exec: 0.03,
                  pure: 0.94,
                  unknown: 0.08,
                },
                reasons: [],
              })),
            }),
        })
      }

      const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(flag: boolean): void }
      input.isTTY = true
      input.setRawMode = () => {}

      let text = ""
      const output = new Writable({
        write(chunk, _enc, done) {
          text += String(chunk)
          done()
        },
      }) as Writable & { isTTY: boolean }
      output.isTTY = true

      const run = tui(queue, { ledger, cache, input: input as any, output: output as any })
      setTimeout(() => input.emit("keypress", "y", { name: "y" }), 20)
      setTimeout(() => input.emit("keypress", "q", { name: "q" }), 160)
      await run

      const doc = JSON.parse(await readFile(ledger, "utf8")) as Record<string, any>
      expect(doc.decisions[0]).toEqual(expect.objectContaining({
        kind: "pure",
        call: "item.group",
        sourceCall: "re.Match.group",
        decision: "pure",
      }))
      expect(text.match(/Call: item\.group/g) ?? []).toHaveLength(2)
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("keeps same-call review items pending when their identity differs", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")
    const cache = path.join(tmp.dir, "score-cache.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 4000), ('s2', 'Beta', 3000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 4000,
        data: data("python", { code: "print('a')" }),
      })
      put(tmp.db, {
        id: "p2",
        messageID: "m2",
        sessionID: "s2",
        created: 2000,
        updated: 3000,
        data: data(
          "python",
          {
            code: ["def print(value):", "    return value", "print('b')", "writer.save('y')"].join("\n"),
          },
        ),
      })

      const queue = await review(await scan({ db: tmp.file, samples: 3, includeEmit: true }), { ledger })
      for (const snippet of queue.snippets) {
        await rescore(snippet, {
          cache,
          run: async () =>
            JSON.stringify({
              scores: snippet.candidates.map((candidate) => ({
                fingerprint: candidate.fingerprint,
                call: candidate.call,
                confidence: {
                  read: candidate.kind === "unknown" ? 0.9 : 0.1,
                  write: candidate.call === "writer.save" ? 0.8 : 0.1,
                  emit: candidate.kind === "emit" ? 0.92 : 0.08,
                  exec: 0.08,
                  pure: 0.1,
                  unknown: 0.2,
                },
                reasons: [],
              })),
            }),
        })
      }

      const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(flag: boolean): void }
      input.isTTY = true
      input.setRawMode = () => {}

      let text = ""
      const output = new Writable({
        write(chunk, _enc, done) {
          text += String(chunk)
          done()
        },
      }) as Writable & { isTTY: boolean }
      output.isTTY = true

      const run = tui(queue, { ledger, cache, input: input as any, output: output as any })
      setTimeout(() => input.emit("keypress", "y", { name: "y" }), 20)
      setTimeout(() => input.emit("keypress", "q", { name: "q" }), 160)
      await run

      expect(text.match(/Call: print/g) ?? []).toHaveLength(2)
      expect(text).not.toContain("Call: writer.save")
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("shows skip processing status before advancing", async () => {
    const tmp = await db()
    const ledger = path.join(tmp.dir, "review-ledger.json")
    const cache = path.join(tmp.dir, "score-cache.json")

    try {
      tmp.db.exec("insert into session (id, title, time_updated) values ('s1', 'Alpha', 2000);")
      put(tmp.db, {
        id: "p1",
        messageID: "m1",
        sessionID: "s1",
        created: 1000,
        updated: 2000,
        data: data("python", { code: "reader.fetch('x')\nwriter.save('y')" }),
      })

      const queue = await review(await scan({ db: tmp.file, samples: 3 }), { ledger })
      const first = item(queue)!
      await rescore(first.snippet, {
        cache,
        run: async () =>
          JSON.stringify({
            scores: first.snippet.candidates.map((candidate, i) => ({
              fingerprint: candidate.fingerprint,
              call: candidate.call,
              confidence: {
                read: i === 0 ? 0.9 : 0.2,
                write: i === 0 ? 0.1 : 0.8,
                emit: 0.08,
                exec: 0.1,
                pure: 0.05,
                unknown: 0.2,
              },
              reasons: [],
            })),
          }),
      })

      const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(flag: boolean): void }
      input.isTTY = true
      input.setRawMode = () => {}

      let text = ""
      const output = new Writable({
        write(chunk, _enc, done) {
          text += String(chunk)
          done()
        },
      }) as Writable & { isTTY: boolean }
      output.isTTY = true

      const run = tui(queue, { ledger, cache, input: input as any, output: output as any })
      setTimeout(() => input.emit("keypress", "s", { name: "s" }), 20)
      setTimeout(() => input.emit("keypress", "q", { name: "q" }), 80)
      await run

      expect(plain(text)).toContain("Skipping reader.fetch; loading next item...")
      expect(text).toContain("Call: writer.save")
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })
})
