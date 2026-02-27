import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import pythonTool from "../tool/python"
import { createMockContext } from "./fixtures/context"

const INVALID_PYTHON_BIN = "/__opencode__/missing/python3"
const HAS_PYTHON3 = Boolean(Bun.which("python3"))

function toSlash(input: string) {
  return input.replace(/\\/g, "/")
}

async function withWorkspace<T>(run: (workspace: { root: string; worktree: string }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-python-tool-"))
  const worktree = path.join(root, "worktree")
  await mkdir(worktree, { recursive: true })

  try {
    return await run({ root, worktree })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function getAsk(context: ReturnType<typeof createMockContext>, permission: string) {
  return context.asks.find((item) => item.permission === permission)
}

function getAskMetadata(context: ReturnType<typeof createMockContext>, permission: string) {
  return getAsk(context, permission)?.metadata as
    | {
        source?: string
        mode?: string
        scriptPath?: string
      codePreview?: string
      codePreviewTruncated?: boolean
      codePreviewTruncationMarker?: string | null
      codePreviewBytes?: { total?: number; preview?: number }
      codePreviewLines?: { total?: number; preview?: number }
      codeExpanded?: string
      codeExpandedAvailable?: boolean
      }
    | undefined
}

async function executeExpectingEnoent(
  args: Parameters<typeof pythonTool.execute>[0],
  context: Parameters<typeof pythonTool.execute>[1],
  pythonBin = INVALID_PYTHON_BIN,
) {
  const previous = process.env.OPENCODE_PYTHON_BIN
  process.env.OPENCODE_PYTHON_BIN = pythonBin

  try {
    await expect(pythonTool.execute(args, context)).rejects.toThrow(/Unable to execute Python binary/)
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_PYTHON_BIN
    else process.env.OPENCODE_PYTHON_BIN = previous
  }
}

describe("python tool runtime", () => {
  describe("arg validation", () => {
    it("errors when neither code nor scriptPath is provided", async () => {
      const context = createMockContext()
      await expect(
        pythonTool.execute(
          {
            args: [],
            description: "missing code",
          },
          context,
        ),
      ).rejects.toThrow("Provide exactly one of `code` or `scriptPath`.")
    })

    it("errors when both code and scriptPath are provided", async () => {
      await withWorkspace(async ({ worktree }) => {
        const scriptPath = path.join(worktree, "script.py")
        await writeFile(scriptPath, "print('ok')\n", "utf8")
        const context = createMockContext({ worktree, directory: worktree })

        await expect(
          pythonTool.execute(
            {
              code: "print('inline')",
              scriptPath,
              args: [],
              description: "xor",
            },
            context,
          ),
        ).rejects.toThrow("Provide exactly one of `code` or `scriptPath`.")
      })
    })

    it("errors for negative and zero timeout", async () => {
      const context = createMockContext()
      await expect(
        pythonTool.execute(
          {
            code: "print('x')",
            timeout: -1,
            args: [],
            description: "negative timeout",
          },
          context,
        ),
      ).rejects.toThrow("Invalid timeout value: -1. Timeout must be a positive number.")

      await expect(
        pythonTool.execute(
          {
            code: "print('x')",
            timeout: 0,
            args: [],
            description: "zero timeout",
          },
          context,
        ),
      ).rejects.toThrow("Invalid timeout value: 0. Timeout must be a positive number.")
    })

    it("errors for empty inline code", async () => {
      const context = createMockContext()
      await expect(
        pythonTool.execute(
          {
            code: "   \n\t",
            args: [],
            description: "empty code",
          },
          context,
        ),
      ).rejects.toThrow("Python source is empty. Provide non-empty `code` or a non-empty script file.")
    })

    it("errors for empty script file", async () => {
      await withWorkspace(async ({ worktree }) => {
        const scriptPath = path.join(worktree, "empty.py")
        await writeFile(scriptPath, "   \n", "utf8")
        const context = createMockContext({ worktree, directory: worktree })

        await expect(
          pythonTool.execute(
            {
              scriptPath,
              args: [],
              description: "empty script",
            },
            context,
          ),
        ).rejects.toThrow("Python source is empty. Provide non-empty `code` or a non-empty script file.")
      })
    })
  })

  describe("subprocess hard-fail", () => {
    it("fails immediately for inline subprocess usage without permission asks", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await expect(
          pythonTool.execute(
            {
              code: "import subprocess\nsubprocess.run(['echo', 'blocked'])",
              args: [],
              description: "inline subprocess blocked",
            },
            context,
          ),
        ).rejects.toThrow("Direct subprocess invocation is blocked in the `python` tool. Use the `bash` tool for terminal/process orchestration.")

        expect(context.asks).toHaveLength(0)
      })
    })

    it("fails immediately for script subprocess usage without permission asks", async () => {
      await withWorkspace(async ({ worktree }) => {
        const scriptPath = path.join(worktree, "blocked-subprocess.py")
        await writeFile(scriptPath, "import subprocess\nsubprocess.Popen(['echo', 'blocked'])\n", "utf8")

        const context = createMockContext({ worktree, directory: worktree })

        await expect(
          pythonTool.execute(
            {
              scriptPath,
              args: [],
              description: "script subprocess blocked",
            },
            context,
          ),
        ).rejects.toThrow("Direct subprocess invocation is blocked in the `python` tool. Use the `bash` tool for terminal/process orchestration.")

        expect(context.asks).toHaveLength(0)
      })
    })
  })

  describe("permission patterns (inline code)", () => {
    it("includes inline code preview metadata in python ask", async () => {
      await withWorkspace(async ({ worktree }) => {
        const source = "print('phase15-inline')\n"
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: source,
            args: [],
            description: "inline preview metadata",
          },
          context,
        )

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.mode).toBe("inline")
        expect(metadata?.source).toBe("<inline>")
        expect(metadata?.scriptPath).toBeUndefined()
        expect(metadata?.codePreview).toBe(source)
        expect(metadata?.codePreviewTruncated).toBeFalse()
        expect(metadata?.codePreviewTruncationMarker).toBeNull()
        expect(metadata?.codePreviewBytes?.total).toBe(metadata?.codePreviewBytes?.preview)
        expect(metadata?.codePreviewLines?.total).toBe(metadata?.codePreviewLines?.preview)
        expect(metadata?.codeExpanded).toBeUndefined()
        expect(metadata?.codeExpandedAvailable).toBeUndefined()
      })
    })

    it("truncates large inline source preview deterministically", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })
        const largeSource = Array.from({ length: 200 }, (_, idx) => `print(${idx})`).join("\n")

        await executeExpectingEnoent(
          {
            code: largeSource,
            args: [],
            description: "inline preview truncation",
          },
          context,
        )

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.codePreviewTruncated).toBeTrue()
        expect(metadata?.codePreviewTruncationMarker).toBe("\n...<python_permission_preview_truncated>")
        expect(metadata?.codePreview?.endsWith("\n...<python_permission_preview_truncated>")).toBeTrue()
        expect((metadata?.codePreviewLines?.total ?? 0) > (metadata?.codePreviewLines?.preview ?? 0)).toBeTrue()
        expect(metadata?.codeExpanded).toBe(largeSource)
        expect(metadata?.codeExpandedAvailable).toBeTrue()
      })
    })

    it("omits expanded source metadata when source exceeds 50KB", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })
        const veryLargeSource = `print('${"x".repeat(70_000)}')`

        await executeExpectingEnoent(
          {
            code: veryLargeSource,
            args: [],
            description: "inline expanded metadata cap",
          },
          context,
        )

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.codePreviewTruncated).toBeTrue()
        expect(metadata?.codeExpanded).toBeUndefined()
        expect(metadata?.codeExpandedAvailable).toBeFalse()
      })
    })

    it("asks for read path", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "open('notes.txt', 'r')",
            args: [],
            description: "read path",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toContain(`read:${toSlash(path.join(worktree, "notes.txt"))}`)
      })
    })

    it("asks for exec call", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "import os\nos.execv('/bin/echo', ['echo', 'hi'])",
            args: [],
            description: "exec ask",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toContain("exec:os.execv")
      })
    })

    it("includes multiple write patterns", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "open('a.txt', 'w')\nimport os\nos.remove('b.txt')",
            args: [],
            description: "multiple writes",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(
          expect.arrayContaining([
            `write:${toSlash(path.join(worktree, "a.txt"))}`,
            `write:${toSlash(path.join(worktree, "b.txt"))}`,
          ]),
        )
      })
    })

    it("uses no-calls fallback ask", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "value = 1 + 1",
            args: [],
            description: "no calls",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toContain("unknown:no-calls-detected")
      })
    })

    it("uses callable unknown ask pattern", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "mypkg.do_thing()",
            args: [],
            description: "callable unknown",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toContain("unknown:callable:mypkg.do_thing")
      })
    })
  })

  describe("script-file permission behavior", () => {
    it("includes script code preview metadata in python ask", async () => {
      await withWorkspace(async ({ worktree }) => {
        const scriptPath = path.join(worktree, "preview.py")
        const scriptSource = "print('phase15-script')\n"
        await writeFile(scriptPath, scriptSource, "utf8")

        const context = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            scriptPath,
            args: [],
            description: "script preview metadata",
          },
          context,
        )

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.mode).toBe("script")
        expect(metadata?.source).toBe(scriptPath)
        expect(metadata?.scriptPath).toBe(scriptPath)
        expect(metadata?.codePreview).toBe(scriptSource)
        expect(metadata?.codePreviewTruncated).toBeFalse()
      })
    })

    it("does not ask external_directory when script is inside worktree", async () => {
      await withWorkspace(async ({ worktree }) => {
        const scriptPath = path.join(worktree, "inside.py")
        await writeFile(scriptPath, "print('ok')\n", "utf8")

        const context = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            scriptPath,
            args: [],
            description: "inside script",
          },
          context,
        )

        expect(getAsk(context, "external_directory")).toBeUndefined()
      })
    })

    it("asks external_directory when script path is outside worktree", async () => {
      await withWorkspace(async ({ root, worktree }) => {
        const scriptPath = path.join(root, "outside.py")
        await writeFile(scriptPath, "print('outside')\n", "utf8")

        const context = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            scriptPath,
            args: [],
            description: "outside script",
          },
          context,
        )

        const ask = getAsk(context, "external_directory")
        expect(ask?.patterns).toContain(`${toSlash(path.dirname(scriptPath))}/*`)
      })
    })

    it("asks external_directory for literal outside paths in script", async () => {
      await withWorkspace(async ({ worktree }) => {
        const scriptPath = path.join(worktree, "reads-outside.py")
        await writeFile(scriptPath, "open('/tmp/outside.txt', 'r')\n", "utf8")

        const context = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            scriptPath,
            args: [],
            description: "outside literal in script",
          },
          context,
        )

        const ask = getAsk(context, "external_directory")
        expect(ask?.patterns).toContain("/tmp/*")
      })
    })
  })

  describe("external directory detection", () => {
    it("reuses permission code preview metadata in external_directory ask", async () => {
      await withWorkspace(async ({ worktree }) => {
        const source = "open('/tmp/outside.txt', 'r')\n"
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: source,
            args: [],
            description: "external preview metadata",
          },
          context,
        )

        const pythonMetadata = getAskMetadata(context, "python")
        const externalMetadata = getAskMetadata(context, "external_directory")

        expect(externalMetadata?.mode).toBe("inline")
        expect(externalMetadata?.source).toBe("<inline>")
        expect(externalMetadata?.codePreview).toBe(source)
        expect(externalMetadata?.codePreviewTruncated).toBeFalse()
        expect(externalMetadata?.codePreview).toBe(pythonMetadata?.codePreview)
        expect(externalMetadata?.codePreviewBytes).toEqual(pythonMetadata?.codePreviewBytes)
        expect(externalMetadata?.codePreviewLines).toEqual(pythonMetadata?.codePreviewLines)
        expect(externalMetadata?.codeExpanded).toEqual(pythonMetadata?.codeExpanded)
        expect(externalMetadata?.codeExpandedAvailable).toEqual(pythonMetadata?.codeExpandedAvailable)
      })
    })

    it("asks when workdir is outside worktree", async () => {
      await withWorkspace(async ({ root, worktree }) => {
        const outside = path.join(root, "outside")
        await mkdir(outside, { recursive: true })

        const context = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "open('data.txt', 'r')",
            workdir: outside,
            args: [],
            description: "outside workdir",
          },
          context,
        )

        const ask = getAsk(context, "external_directory")
        expect(ask?.patterns).toContain(`${toSlash(outside)}/*`)
      })
    })

    it("does not ask external_directory when workdir is inside worktree", async () => {
      await withWorkspace(async ({ worktree }) => {
        const inside = path.join(worktree, "inside")
        await mkdir(inside, { recursive: true })

        const context = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "open('data.txt', 'r')",
            workdir: inside,
            args: [],
            description: "inside workdir",
          },
          context,
        )

        expect(getAsk(context, "external_directory")).toBeUndefined()
      })
    })

    it("asks external_directory for inline literal outside path", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "open('/tmp/outside.txt', 'r')",
            args: [],
            description: "inline outside path",
          },
          context,
        )

        const ask = getAsk(context, "external_directory")
        expect(ask?.patterns).toContain("/tmp/*")
      })
    })
  })

  describe("always pattern checks", () => {
    it("includes read parent-dir glob", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "open('f.txt', 'r')",
            args: [],
            description: "always read",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.always).toContain(`read:${toSlash(worktree)}/*`)
      })
    })

    it("includes exec module wildcard", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "import os\nos.execvp('echo', ['echo', 'ok'])",
            args: [],
            description: "always exec",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.always).toContain("exec:os.*")
      })
    })

    it("includes callable unknown specific always pattern", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "mypkg.do_thing()",
            args: [],
            description: "always callable unknown",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.always).toContain("unknown:callable:mypkg.do_thing")
      })
    })

    it("uses unknown:* for parser/meta unknown events", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "def broken(:\n    pass",
            args: [],
            description: "always parser unknown",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toContain("unknown:parse-error")
        expect(ask?.always).toContain("unknown:*")
      })
    })
  })

  describe("ENOENT handling", () => {
    it("returns friendly invalid OPENCODE_PYTHON_BIN error", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })
        const badBin = "/totally/missing/python3"

        const previous = process.env.OPENCODE_PYTHON_BIN
        process.env.OPENCODE_PYTHON_BIN = badBin

        try {
          await expect(
            pythonTool.execute(
              {
                code: "print('hello')",
                args: [],
                description: "enoent",
              },
              context,
            ),
          ).rejects.toThrow(`Unable to execute Python binary \`${badBin}\`. Set OPENCODE_PYTHON_BIN to a valid interpreter path.`)
        } finally {
          if (previous === undefined) delete process.env.OPENCODE_PYTHON_BIN
          else process.env.OPENCODE_PYTHON_BIN = previous
        }
      })
    })
  })

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

          const finalOutput = cappedContext.metadatas.at(-1)?.metadata?.output
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
