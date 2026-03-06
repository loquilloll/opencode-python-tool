import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { access, mkdtemp, readFile, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { applyDecisions, nextReview, parse, promote, promotions, recordDecision, render, renderPromotions, renderReview, review, scan, update } from "../../src/python-session-report"

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
        data: data("python", { code: "rq.get('x')", description: "one" }),
      })
      put(tmp.db, {
        id: "p2",
        messageID: "m2",
        sessionID: "s2",
        created: 2000,
        updated: 3000,
        data: data("python", { code: "rq.get('y')", description: "two" }),
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
          call: "rq.get",
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
              preview: "rq.get('y')",
            },
            {
              sessionID: "s1",
              messageID: "m1",
              partID: "p1",
              title: "Alpha",
              time: new Date(2000).toISOString(),
              preview: "rq.get('x')",
            },
          ],
        },
      ])

      const text = render(report)
      expect(text).toContain("Found 2 unknown callable events across 1 unique callables.")
      expect(text).toContain("rq.get (2)")
      expect(text).toContain("s2 | Beta")
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
    const code = "rq.get('x')\nwriter.append('y')"

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

      const rq = initial.snippets[0]?.candidates.find((item) => item.call === "rq.get")
      const append = initial.snippets[0]?.candidates.find((item) => item.call === "writer.append")
      expect(rq?.readConfidence).toBeGreaterThan(rq?.writeConfidence ?? 1)
      expect(append?.writeConfidence).toBeGreaterThan(append?.readConfidence ?? 1)

      await recordDecision({ ledger, fingerprint: rq!.fingerprint, decision: "read", call: rq!.call })

      const merged = await review(report, { ledger })
      const decided = merged.snippets[0]?.candidates.find((item) => item.call === "rq.get")
      const pending = merged.snippets[0]?.candidates.find((item) => item.call === "writer.append")
      expect(merged.totals.snippets).toBe(1)
      expect(merged.totals.pendingCandidates).toBe(1)
      expect(merged.totals.decidedCandidates).toBe(1)
      expect(decided?.decision).toBe("read")
      expect(pending?.decision).toBeUndefined()

      const ledgerData = JSON.parse(await readFile(ledger, "utf8")) as Record<string, any>
      expect(ledgerData.decisions).toEqual([
        expect.objectContaining({
          fingerprint: rq?.fingerprint,
          call: "rq.get",
          decision: "read",
        }),
      ])
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("keeps the same callable reviewable across different snippet contexts", async () => {
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
        data: data("python", { code: "rq.get(source_path)" }),
      })
      put(tmp.db, {
        id: "p2",
        messageID: "m2",
        sessionID: "s2",
        created: 2000,
        updated: 3000,
        data: data("python", { code: "rq.get(target_path)\nwriter.append('y')" }),
      })

      const report = await scan({ db: tmp.file, samples: 3 })
      const initial = await review(report, { ledger })
      const first = initial.snippets.find((item) => item.code === "rq.get(source_path)")
      const second = initial.snippets.find((item) => item.code === "rq.get(target_path)\nwriter.append('y')")
      await recordDecision({ ledger, fingerprint: first!.candidates[0]!.fingerprint, decision: "read", call: "rq.get" })

      const merged = await review(report, { ledger })
      const pending = merged.snippets.find((item) => item.code === second!.code)
      const unresolved = pending?.candidates.find((item) => item.call === "rq.get")
      expect(unresolved?.decision).toBeUndefined()
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
        data: data("python", { code: "rq.get('x')\nwriter.append('y')" }),
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
      const queue = await review(report, { ledger })
      const first = nextReview(queue)
      expect(renderReview(first!)).toContain("Candidates:")
      expect(renderReview(first!)).toContain("1. rq.get")
      expect(renderReview(first!)).toContain("2. writer.append")

      await applyDecisions({ ledger, item: first!, decide: "1=read,2=write" })

      const next = nextReview(await review(report, { ledger }))
      expect(next?.code).toBe("other.fetch()")
      expect(next?.candidates[0]?.call).toBe("other.fetch")
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
        data: data("python", { code: "rq.get('x')\nwriter.append('y')" }),
      })

      const item = nextReview(await review(await scan({ db: tmp.file, samples: 3 }), { ledger }))
      const decide = item!.candidates.map((candidate, i) => `${candidate.fingerprint}=${i === 0 ? "read" : "write"}`).join(",")
      await applyDecisions({ ledger, item: item!, decide })

      const ledgerData = JSON.parse(await readFile(ledger, "utf8")) as Record<string, any>
      expect(ledgerData.decisions).toHaveLength(2)
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
        data: data("python", { code: "rq.get('x')\nwriter.append('y')" }),
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
        data: data("python", { code: "rq.get('x')\nwriter.append('y')" }),
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
        data: data("python", { code: "rq.get('x')\nwriter.append('y')" }),
      })

      const src = new URL("../../src/python/python-rules.json", import.meta.url)
      const base = JSON.parse(await readFile(src, "utf8")) as Record<string, any>
      base.candidates = {
        unknown: [
          { call: "rq.get", count: 1, lastSeen: new Date(2000).toISOString(), examples: ["s1"] },
          { call: "writer.append", count: 1, lastSeen: new Date(2000).toISOString(), examples: ["s1"] },
        ],
      }
      await writeFile(rules, JSON.stringify(base))

      const report = await scan({ db: tmp.file, samples: 3 })
      const item = nextReview(await review(report, { ledger }))
      await applyDecisions({ ledger, item: item!, decide: "1=read,2=write" })

      const plan = await promotions(report, { ledger, rules })
      expect(plan.promotable.read).toEqual(["rq.get"])
      expect(plan.promotable.write).toEqual(["writer.append"])
      expect(plan.blocked).toEqual([])
      expect(renderPromotions(plan)).toContain("read: 1")

      await promote(report, { ledger, rules })
      const next = JSON.parse(await readFile(rules, "utf8")) as Record<string, any>
      expect(next.calls.read).toContain("rq.get")
      expect(next.calls.write).toContain("writer.append")
      expect(next.candidates.unknown).toEqual([])
    } finally {
      tmp.db.close()
      await rm(tmp.dir, { recursive: true, force: true })
    }
  })

  it("blocks promotion when unresolved contexts remain", async () => {
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
        data: data("python", { code: "rq.get(source_path)" }),
      })
      put(tmp.db, {
        id: "p2",
        messageID: "m2",
        sessionID: "s2",
        created: 2000,
        updated: 3000,
        data: data("python", { code: "rq.get(target_path)" }),
      })

      const src = new URL("../../src/python/python-rules.json", import.meta.url)
      await writeFile(rules, await readFile(src, "utf8"))

      const report = await scan({ db: tmp.file, samples: 3 })
      const queue = await review(report, { ledger })
      const second = queue.snippets.find((item) => item.code === "rq.get(source_path)")
      await recordDecision({ ledger, fingerprint: second!.candidates[0]!.fingerprint, decision: "read", call: "rq.get" })

      const plan = await promotions(report, { ledger, rules })
      expect(plan.promotable.read).toEqual([])
      expect(plan.blocked).toEqual([
        {
          call: "rq.get",
          reason: "unresolved contexts remain",
          decisions: ["read"],
          pendingContexts: 1,
        },
      ])
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
})
