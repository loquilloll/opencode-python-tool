import { describe, expect, it } from "bun:test"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import pythonTool from "../tool/python"
import { createMockContext } from "./fixtures/context"
import { HAS_PYTHON3, executeExpectingEnoent, withWorkspace } from "./fixtures/python-runtime"

describe("python tool runtime", () => {
  describe("workdir semantics", () => {
    it("resolves relative workdir from context.directory", async () => {
      await withWorkspace(async ({ worktree }) => {
        const directory = path.join(worktree, "project")
        await mkdir(path.join(directory, "child"), { recursive: true })

        const context = createMockContext({ worktree, directory })
        await executeExpectingEnoent(
          {
            code: "print('cwd')",
            workdir: "child",
            args: [],
            description: "relative workdir",
          },
          context,
        )

        const firstMetadata = context.metadatas[0]
        expect(firstMetadata?.metadata?.cwd).toBe(path.join(directory, "child"))
      })
    })

    it("honors absolute workdir as-is", async () => {
      await withWorkspace(async ({ worktree }) => {
        const absolute = path.join(worktree, "absolute")
        await mkdir(absolute, { recursive: true })

        const context = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "print('cwd')",
            workdir: absolute,
            args: [],
            description: "absolute workdir",
          },
          context,
        )

        const firstMetadata = context.metadatas[0]
        expect(firstMetadata?.metadata?.cwd).toBe(absolute)
      })
    })
  })

  ;(HAS_PYTHON3 ? describe : describe.skip)("process execution, timeout, abort, and streaming", () => {
    it("returns hello output", async () => {
      await withWorkspace(async ({ worktree }) => {
        const previous = process.env.OPENCODE_PYTHON_BIN
        if (previous !== undefined) delete process.env.OPENCODE_PYTHON_BIN

        try {
          const context = createMockContext({ worktree, directory: worktree })
          const result = await pythonTool.execute(
            {
              code: "print('hello')",
              args: [],
              description: "hello output",
            },
            context,
          )

          expect(result).toContain("hello")
        } finally {
          if (previous !== undefined) process.env.OPENCODE_PYTHON_BIN = previous
        }
      })
    })

    it("includes Exit code metadata for non-zero exits", async () => {
      await withWorkspace(async ({ worktree }) => {
        const previous = process.env.OPENCODE_PYTHON_BIN
        if (previous !== undefined) delete process.env.OPENCODE_PYTHON_BIN

        try {
          const context = createMockContext({ worktree, directory: worktree })
          const result = await pythonTool.execute(
            {
              code: "import sys\nsys.exit(3)",
              args: [],
              description: "non-zero",
            },
            context,
          )

          expect(result).toContain("<python_metadata>")
          expect(result).toContain("Exit code: 3")
        } finally {
          if (previous !== undefined) process.env.OPENCODE_PYTHON_BIN = previous
        }
      })
    })

    it("passes args to inline code", async () => {
      await withWorkspace(async ({ worktree }) => {
        const previous = process.env.OPENCODE_PYTHON_BIN
        if (previous !== undefined) delete process.env.OPENCODE_PYTHON_BIN

        try {
          const context = createMockContext({ worktree, directory: worktree })
          const result = await pythonTool.execute(
            {
              code: "import sys\nprint(sys.argv[1])",
              args: ["world"],
              description: "args",
            },
            context,
          )

          expect(result).toContain("world")
        } finally {
          if (previous !== undefined) process.env.OPENCODE_PYTHON_BIN = previous
        }
      })
    })

    it("executes scriptPath correctly", async () => {
      await withWorkspace(async ({ worktree }) => {
        const scriptPath = path.join(worktree, "hello.py")
        await writeFile(scriptPath, "print('from-script')\n", "utf8")

        const previous = process.env.OPENCODE_PYTHON_BIN
        if (previous !== undefined) delete process.env.OPENCODE_PYTHON_BIN

        try {
          const context = createMockContext({ worktree, directory: worktree })
          const result = await pythonTool.execute(
            {
              scriptPath,
              args: [],
              description: "script execution",
            },
            context,
          )

          expect(result).toContain("from-script")
        } finally {
          if (previous !== undefined) process.env.OPENCODE_PYTHON_BIN = previous
        }
      })
    })

    it("reports timeout metadata", async () => {
      await withWorkspace(async ({ worktree }) => {
        const previous = process.env.OPENCODE_PYTHON_BIN
        if (previous !== undefined) delete process.env.OPENCODE_PYTHON_BIN

        try {
          const context = createMockContext({ worktree, directory: worktree })
          const result = await pythonTool.execute(
            {
              code: "import time\ntime.sleep(5)",
              timeout: 100,
              args: [],
              description: "timeout",
            },
            context,
          )

          expect(result).toContain("<python_metadata>")
          expect(result).toContain("python tool terminated command after exceeding timeout 100 ms")
        } finally {
          if (previous !== undefined) process.env.OPENCODE_PYTHON_BIN = previous
        }
      })
    })

    it("handles pre-aborted and in-flight aborts", async () => {
      await withWorkspace(async ({ worktree }) => {
        const previous = process.env.OPENCODE_PYTHON_BIN
        if (previous !== undefined) delete process.env.OPENCODE_PYTHON_BIN

        try {
          const preAbort = new AbortController()
          preAbort.abort()
          const preContext = createMockContext({
            worktree,
            directory: worktree,
            abort: preAbort.signal,
          })

          const preResult = await pythonTool.execute(
            {
              code: "import time\ntime.sleep(5)",
              args: [],
              description: "pre-abort",
            },
            preContext,
          )

          expect(preResult).toContain("<python_metadata>")
          expect(preResult).toContain("User aborted the command")

          const inFlightAbort = new AbortController()
          const inFlightContext = createMockContext({
            worktree,
            directory: worktree,
            abort: inFlightAbort.signal,
          })

          const resultPromise = pythonTool.execute(
            {
              code: "import time\ntime.sleep(5)",
              args: [],
              description: "in-flight abort",
            },
            inFlightContext,
          )

          setTimeout(() => inFlightAbort.abort(), 100)
          const inFlightResult = await resultPromise

          expect(inFlightResult).toContain("<python_metadata>")
          expect(inFlightResult).toContain("User aborted the command")
        } finally {
          if (previous !== undefined) process.env.OPENCODE_PYTHON_BIN = previous
        }
      })
    })

    it("streams metadata incrementally and caps metadata output", async () => {
      await withWorkspace(async ({ worktree }) => {
        const previous = process.env.OPENCODE_PYTHON_BIN
        if (previous !== undefined) delete process.env.OPENCODE_PYTHON_BIN

        try {
          const streamingContext = createMockContext({ worktree, directory: worktree })
          const streamingResult = await pythonTool.execute(
            {
              code: [
                "import sys, time",
                "sys.stdout.write('A')",
                "sys.stdout.flush()",
                "time.sleep(0.05)",
                "sys.stderr.write('B')",
                "sys.stderr.flush()",
              ].join("\n"),
              args: [],
              description: "streaming",
            },
            streamingContext,
          )

          expect(streamingResult).toContain("A")
          expect(streamingResult).toContain("B")

          const outputs = streamingContext.metadatas
            .map((entry) => entry.metadata?.output)
            .filter((value): value is string => typeof value === "string")

          expect(outputs.length).toBeGreaterThanOrEqual(3)
          expect(outputs.slice(0, -1).some((value) => value.length > 0)).toBeTrue()

          const cappedContext = createMockContext({ worktree, directory: worktree })
          const cappedResult = await pythonTool.execute(
            {
              code: "print('x' * 35000, end='')",
              args: [],
              description: "metadata cap",
            },
            cappedContext,
          )

          const finalMetadata = cappedContext.metadatas[cappedContext.metadatas.length - 1]
          const finalOutput = finalMetadata?.metadata?.output
          expect(typeof finalOutput).toBe("string")
          expect((finalOutput as string).endsWith("\n\n...")).toBeTrue()
          expect((finalOutput as string).length).toBeLessThanOrEqual(30_005)
          expect(cappedResult.length).toBeGreaterThan((finalOutput as string).length)
        } finally {
          if (previous !== undefined) process.env.OPENCODE_PYTHON_BIN = previous
        }
      })
    })
  })
})
