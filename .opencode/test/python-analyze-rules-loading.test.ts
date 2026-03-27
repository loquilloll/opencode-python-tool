import { describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { analyze } from "../tool/python-analyze"

describe("python analyzer", () => {
  describe("rules file loading", () => {
    it("normalizes invalid json errors and retries after file fix", async () => {
      const prev = process.env.OPENCODE_PYTHON_RULES
      const dir = await mkdtemp(path.join(os.tmpdir(), "python-rules-"))
      const file = path.join(dir, "rules.json")

      try {
        process.env.OPENCODE_PYTHON_RULES = file
        await writeFile(file, '{"version":1')
        await expect(analyze("open('f')")).rejects.toThrow(/^Invalid python-rules\.json: file contains invalid JSON/)

        const src = new URL("../../src/python/python-rules.json", import.meta.url)
        await writeFile(file, await readFile(src, "utf8"))
        await expect(analyze("open('f')")).resolves.toEqual([{ kind: "read", call: "open", path: "f" }])
      } finally {
        if (prev === undefined) delete process.env.OPENCODE_PYTHON_RULES
        else process.env.OPENCODE_PYTHON_RULES = prev
        await rm(dir, { recursive: true, force: true })
      }
    })

    it("rejects unsupported rules versions", async () => {
      const prev = process.env.OPENCODE_PYTHON_RULES
      const dir = await mkdtemp(path.join(os.tmpdir(), "python-rules-"))
      const file = path.join(dir, "rules.json")

      try {
        const src = new URL("../../src/python/python-rules.json", import.meta.url)
        const data = JSON.parse(await readFile(src, "utf8")) as Record<string, unknown>
        data.version = 2
        process.env.OPENCODE_PYTHON_RULES = file
        await writeFile(file, JSON.stringify(data))
        await expect(analyze("open('f')")).rejects.toThrow("Invalid python-rules.json: version must be 1")
      } finally {
        if (prev === undefined) delete process.env.OPENCODE_PYTHON_RULES
        else process.env.OPENCODE_PYTHON_RULES = prev
        await rm(dir, { recursive: true, force: true })
      }
    })

    it("rejects malformed rules shapes", async () => {
      const prev = process.env.OPENCODE_PYTHON_RULES
      const dir = await mkdtemp(path.join(os.tmpdir(), "python-rules-"))
      const file = path.join(dir, "rules.json")

      try {
        const src = new URL("../../src/python/python-rules.json", import.meta.url)
        const data = JSON.parse(await readFile(src, "utf8")) as Record<string, any>
        data.methods.read = {}
        process.env.OPENCODE_PYTHON_RULES = file
        await writeFile(file, JSON.stringify(data))
        await expect(analyze("open('f')")).rejects.toThrow("Invalid python-rules.json: methods.read must be a string[]")
      } finally {
        if (prev === undefined) delete process.env.OPENCODE_PYTHON_RULES
        else process.env.OPENCODE_PYTHON_RULES = prev
        await rm(dir, { recursive: true, force: true })
      }
    })

    it("accepts legacy rules files that omit emit/pure buckets", async () => {
      const prev = process.env.OPENCODE_PYTHON_RULES
      const dir = await mkdtemp(path.join(os.tmpdir(), "python-rules-"))
      const file = path.join(dir, "rules.json")

      try {
        const src = new URL("../../src/python/python-rules.json", import.meta.url)
        const data = JSON.parse(await readFile(src, "utf8")) as Record<string, any>
        delete data.methods.emit
        delete data.methods.pure
        delete data.calls.emit
        delete data.calls.pure
        process.env.OPENCODE_PYTHON_RULES = file
        await writeFile(file, JSON.stringify(data))
        await expect(analyze("open('f')")).resolves.toEqual([{ kind: "read", call: "open", path: "f" }])
      } finally {
        if (prev === undefined) delete process.env.OPENCODE_PYTHON_RULES
        else process.env.OPENCODE_PYTHON_RULES = prev
        await rm(dir, { recursive: true, force: true })
      }
    })

    it("rejects malformed guarded rules shapes", async () => {
      const prev = process.env.OPENCODE_PYTHON_RULES
      const dir = await mkdtemp(path.join(os.tmpdir(), "python-rules-"))
      const file = path.join(dir, "rules.json")

      try {
        const src = new URL("../../src/python/python-rules.json", import.meta.url)
        const data = JSON.parse(await readFile(src, "utf8")) as Record<string, any>
        data.guarded.methods = {}
        process.env.OPENCODE_PYTHON_RULES = file
        await writeFile(file, JSON.stringify(data))
        await expect(analyze("open('f')")).rejects.toThrow("Invalid python-rules.json: guarded.methods must be an array")
      } finally {
        if (prev === undefined) delete process.env.OPENCODE_PYTHON_RULES
        else process.env.OPENCODE_PYTHON_RULES = prev
        await rm(dir, { recursive: true, force: true })
      }
    })

    it("rejects malformed guarded argLiteralIn rules", async () => {
      const prev = process.env.OPENCODE_PYTHON_RULES
      const dir = await mkdtemp(path.join(os.tmpdir(), "python-rules-"))
      const file = path.join(dir, "rules.json")

      try {
        const src = new URL("../../src/python/python-rules.json", import.meta.url)
        const data = JSON.parse(await readFile(src, "utf8")) as Record<string, any>
        const callIndex = data.guarded.calls.findIndex((rule: any) => rule.guards?.some((guard: any) => guard.type === "argLiteralIn"))
        expect(callIndex).toBeGreaterThanOrEqual(0)
        const guardIndex = data.guarded.calls[callIndex].guards.findIndex((guard: any) => guard.type === "argLiteralIn")
        data.guarded.calls[callIndex].guards[guardIndex].values = {}
        process.env.OPENCODE_PYTHON_RULES = file
        await writeFile(file, JSON.stringify(data))
        await expect(analyze("open('f')")).rejects.toThrow(`Invalid python-rules.json: guarded.calls[${callIndex}].guards[${guardIndex}].values must be a string[]`)
      } finally {
        if (prev === undefined) delete process.env.OPENCODE_PYTHON_RULES
        else process.env.OPENCODE_PYTHON_RULES = prev
        await rm(dir, { recursive: true, force: true })
      }
    })

    it("accepts legacy rules files that omit guarded rules", async () => {
      const prev = process.env.OPENCODE_PYTHON_RULES
      const dir = await mkdtemp(path.join(os.tmpdir(), "python-rules-"))
      const file = path.join(dir, "rules.json")

      try {
        const src = new URL("../../src/python/python-rules.json", import.meta.url)
        const data = JSON.parse(await readFile(src, "utf8")) as Record<string, any>
        delete data.guarded
        process.env.OPENCODE_PYTHON_RULES = file
        await writeFile(file, JSON.stringify(data))
        await expect(analyze("open('f')")).resolves.toEqual([{ kind: "read", call: "open", path: "f" }])
      } finally {
        if (prev === undefined) delete process.env.OPENCODE_PYTHON_RULES
        else process.env.OPENCODE_PYTHON_RULES = prev
        await rm(dir, { recursive: true, force: true })
      }
    })
  })
})
