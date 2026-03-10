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
        operations?: Array<{
          kind?: string
          call?: string
          pattern?: string
          always?: string
          canonicalSource?: string
          receiverKind?: string
          dependencySignature?: string[]
          ruleHit?: string
          guardFailure?: { type?: string; detail?: string }
        }>
        permissionPatterns?: string[]
        permissionAlways?: string[]
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
        const source = "mypkg.do_thing()\n"
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
        const largeSource = Array.from({ length: 200 }, () => "mypkg.do_thing()").join("\n")

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
        const veryLargeSource = `mypkg.do_thing('${"x".repeat(70_000)}')`

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

    it("skips python ask for emit-only code and keeps emit operations in runtime metadata", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "print('hello')",
            args: [],
            description: "emit only",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.analyzerVersion).toBe("python-analyzer/v2")
        expect(metadata?.engineVersion).toBe("python-ir-v2")
        expect(metadata?.permissionPatterns).toEqual([])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([expect.objectContaining({ kind: "emit", call: "print", pattern: "emit:print" })]),
        )
      })
    })

    it("keeps analyzer metadata consistent for large-script fallback", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "print('x')\n".repeat(10_500),
            args: [],
            description: "large script metadata",
          },
          context,
        )

        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.analyzerVersion).toBe("python-analyzer/v2")
        expect(metadata?.engineVersion).toBe("python-ir-v2")
      })
    })

    it("skips python ask for pure-only code and keeps pure operations in runtime metadata", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "import re\nre.search('a+', text)",
            args: [],
            description: "pure only",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.permissionPatterns).toEqual([])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([expect.objectContaining({ kind: "pure", call: "re.search", pattern: "pure:re.search" })]),
        )
      })
    })

    it("skips python ask for tracked Path aliases, match methods, and exact path joins", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from pathlib import Path",
              "p = Path('f')",
              "p.exists()",
              "p.read_text()",
              "out = Path('o')",
              "out.write_text('x')",
              "src = Path.cwd()",
              "src.read_text()",
              "src.read_text().splitlines()",
              "child = src.joinpath('a.txt')",
              "child.read_text()",
              "import os.path as osp",
              "osp.join('a', 'b')",
              "from os.path import join",
              "join('c', 'd')",
              "match = re.search('a+', text)",
              "match.group(1)",
              "match.span()",
              "re.match('a+', text).group(0)",
            ].join("\n"),
            args: [],
            description: "path alias and match cleanup",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(
          expect.arrayContaining([
            `read:${path.join(worktree, "f")}`,
            `read:${path.join(worktree, "f")}`,
            `write:${path.join(worktree, "o")}`,
          ]),
        )
        expect(ask?.patterns).not.toEqual(
          expect.arrayContaining([
            "unknown:callable:Path",
            "unknown:callable:pathlib.Path",
            "unknown:callable:p.exists",
            "unknown:callable:p.read_text",
            "unknown:callable:out.write_text",
            "unknown:callable:src.read_text",
            "unknown:callable:os.path.join",
            "unknown:callable:match.group",
            "unknown:callable:match.span",
          ]),
        )

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "pathlib.Path", pattern: "pure:pathlib.Path" }),
            expect.objectContaining({ kind: "read", call: "p.exists", path: path.join(worktree, "f") }),
            expect.objectContaining({ kind: "read", call: "p.read_text", path: path.join(worktree, "f") }),
            expect.objectContaining({ kind: "write", call: "out.write_text", path: path.join(worktree, "o") }),
            expect.objectContaining({ kind: "pure", call: "pathlib.Path.cwd", pattern: "pure:pathlib.Path.cwd" }),
            expect.objectContaining({ kind: "read", call: "src.read_text", pattern: "read:<dynamic>" }),
            expect.objectContaining({ kind: "pure", call: "src.read_text.splitlines", pattern: "pure:src.read_text.splitlines" }),
            expect.objectContaining({ kind: "pure", call: "src.joinpath", pattern: "pure:src.joinpath" }),
            expect.objectContaining({ kind: "read", call: "child.read_text", pattern: "read:<dynamic>" }),
            expect.objectContaining({ kind: "pure", call: "os.path.join", pattern: "pure:os.path.join" }),
            expect.objectContaining({ kind: "pure", call: "re.search", pattern: "pure:re.search" }),
            expect.objectContaining({ kind: "pure", call: "match.group", pattern: "pure:match.group" }),
            expect.objectContaining({ kind: "pure", call: "match.span", pattern: "pure:match.span" }),
            expect.objectContaining({ kind: "pure", call: "re.match.group", pattern: "pure:re.match.group" }),
          ]),
        )
      })
    })

    it("adds canonical source and guard metadata to runtime operations without changing permission patterns", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: ["from pathlib import Path", "p = Path('f')", "p.read_text()", "item.group(1)"].join("\n"),
            args: [],
            description: "runtime metadata enrichment",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(
          expect.arrayContaining([`read:${toSlash(path.join(worktree, "f"))}`, "unknown:callable:item.group"]),
        )

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "read",
              call: "p.read_text",
              canonicalSource: "pathlib.Path.read_text",
              receiverKind: "path",
              ruleHit: "guarded-method:read_text",
            }),
            expect.objectContaining({
              kind: "unknown",
              call: "callable:item.group",
              canonicalSource: "callable:item.group",
              ruleHit: "guarded-method:group",
              guardFailure: expect.objectContaining({ type: "receiverKindIn" }),
            }),
          ]),
        )
      })
    })

    it("keeps arbitrary group and path-like receivers on unknown permission patterns", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "obj.exists()",
              "obj.read_text()",
              "obj.write_text('x')",
              "obj.joinpath('a')",
              "obj.group(1)",
              "obj.span()",
            ].join("\n"),
            args: [],
            description: "path and group guardrails",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(
          expect.arrayContaining([
            "unknown:callable:obj.exists",
            "unknown:callable:obj.read_text",
            "unknown:callable:obj.write_text",
            "unknown:callable:obj.joinpath",
            "unknown:callable:obj.group",
            "unknown:callable:obj.span",
          ]),
        )
      })
    })

    it("skips python review noise for bounded iterated Path receivers", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from pathlib import Path",
              "root = Path('docs')",
              "expected = [root / 'README.md', root / 'CONTINUITY.md']",
              "missing = [str(p) for p in expected if not p.exists()]",
              "for p in expected:",
              "    p.exists()",
            ].join("\n"),
            args: [],
            description: "iterated path exists",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).not.toEqual(expect.arrayContaining(["unknown:callable:p.exists"]))
        expect(ask?.patterns).toEqual(expect.arrayContaining(["read:<dynamic>"]))

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "read", call: "p.exists", pattern: "read:<dynamic>" }),
          ]),
        )
      })
    })

    it("keeps unbound join calls on unknown permission patterns", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "join('a', 'b')",
            args: [],
            description: "unbound join guardrail",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:join"]))
      })
    })

    it("skips python ask for tracked in-memory container mutation", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "changed = []\nchanged.append('hello')",
            args: [],
            description: "local container mutation",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.permissionPatterns).toEqual([])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([expect.objectContaining({ kind: "pure", call: "changed.append", pattern: "pure:changed.append" })]),
        )
      })
    })

    it("skips python ask for comprehension-backed containers and pure dict factories", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "counts = {name: name for name in names}",
              "counts.values()",
              "ordered = [item for item in rows]",
              "ordered.append('x')",
              "seen = {item for item in rows}",
              "seen.add('x')",
              "dict.fromkeys(seq)",
            ].join("\n"),
            args: [],
            description: "comprehension container mutation",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.permissionPatterns).toEqual([])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "counts.values", pattern: "pure:counts.values" }),
            expect.objectContaining({ kind: "pure", call: "ordered.append", pattern: "pure:ordered.append" }),
            expect.objectContaining({ kind: "pure", call: "seen.add", pattern: "pure:seen.add" }),
            expect.objectContaining({ kind: "pure", call: "dict.fromkeys", pattern: "pure:dict.fromkeys" }),
          ]),
        )
      })
    })

    it("skips python ask for all standard string methods on tracked text values", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "'\\n'.join(parts)",
              "'x'.replace('x', 'y')",
              "from pathlib import Path as P",
              "text = P('README.md').read_text()",
              "text.capitalize()",
              "text.casefold()",
              "text.center(10)",
              "text.find('needle')",
              "text.count('x')",
              "text.encode('utf8')",
              "text.endswith('x')",
              "text.expandtabs(2)",
              "text.format(name='x')",
              "text.format_map(mapping)",
              "text.index('x')",
              "text.isalnum()",
              "text.isalpha()",
              "text.isascii()",
              "text.isdecimal()",
              "text.isdigit()",
              "text.isidentifier()",
              "text.islower()",
              "text.isnumeric()",
              "text.isprintable()",
              "text.isspace()",
              "text.istitle()",
              "text.isupper()",
              "text.join(parts)",
              "text.ljust(10)",
              "text.lower()",
              "text.lstrip()",
              "text.replace('a', 'b')",
              "text.rfind('x')",
              "text.rindex('x')",
              "text.rjust(10)",
              "text.rpartition('x')",
              "text.rsplit('x')",
              "text.rstrip()",
              "text.split('x')",
              "text.splitlines()",
              "text.startswith('x')",
              "text.strip()",
              "text.swapcase()",
              "text.title()",
              "text.translate(table)",
              "text.upper()",
              "text.zfill(3)",
              "data = P('other.txt').read_text()",
              "data.partition('x')",
              "data.removeprefix('x')",
              "data.removesuffix('x')",
              "literal = 'a' 'b'",
              "literal.split('b')",
              "P('notes.txt').read_text().lower()",
            ].join("\n"),
            args: [],
            description: "tracked string methods",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(
          expect.arrayContaining([
            `read:${path.join(worktree, "README.md")}`,
            `read:${path.join(worktree, "notes.txt")}`,
          ]),
        )
        expect(ask?.patterns).not.toEqual(
          expect.arrayContaining([
            "unknown:callable:join",
            "unknown:callable:replace",
            "unknown:callable:text.join",
            "unknown:callable:text.find",
            "unknown:callable:text.replace",
            "unknown:callable:text.strip",
            "unknown:callable:data.partition",
            "unknown:callable:literal.split",
            "unknown:callable:pathlib.Path.read_text.lower",
          ]),
        )

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "join", pattern: "pure:join" }),
            expect.objectContaining({ kind: "pure", call: "replace", pattern: "pure:replace" }),
            expect.objectContaining({ kind: "read", call: "pathlib.Path.read_text" }),
            expect.objectContaining({ kind: "pure", call: "text.capitalize", pattern: "pure:text.capitalize" }),
            expect.objectContaining({ kind: "pure", call: "text.casefold", pattern: "pure:text.casefold" }),
            expect.objectContaining({ kind: "pure", call: "text.center", pattern: "pure:text.center" }),
            expect.objectContaining({ kind: "pure", call: "text.find", pattern: "pure:text.find" }),
            expect.objectContaining({ kind: "pure", call: "text.count", pattern: "pure:text.count" }),
            expect.objectContaining({ kind: "pure", call: "text.encode", pattern: "pure:text.encode" }),
            expect.objectContaining({ kind: "pure", call: "text.endswith", pattern: "pure:text.endswith" }),
            expect.objectContaining({ kind: "pure", call: "text.expandtabs", pattern: "pure:text.expandtabs" }),
            expect.objectContaining({ kind: "pure", call: "text.format", pattern: "pure:text.format" }),
            expect.objectContaining({ kind: "pure", call: "text.format_map", pattern: "pure:text.format_map" }),
            expect.objectContaining({ kind: "pure", call: "text.index", pattern: "pure:text.index" }),
            expect.objectContaining({ kind: "pure", call: "text.isalnum", pattern: "pure:text.isalnum" }),
            expect.objectContaining({ kind: "pure", call: "text.isalpha", pattern: "pure:text.isalpha" }),
            expect.objectContaining({ kind: "pure", call: "text.isascii", pattern: "pure:text.isascii" }),
            expect.objectContaining({ kind: "pure", call: "text.isdecimal", pattern: "pure:text.isdecimal" }),
            expect.objectContaining({ kind: "pure", call: "text.isdigit", pattern: "pure:text.isdigit" }),
            expect.objectContaining({ kind: "pure", call: "text.isidentifier", pattern: "pure:text.isidentifier" }),
            expect.objectContaining({ kind: "pure", call: "text.islower", pattern: "pure:text.islower" }),
            expect.objectContaining({ kind: "pure", call: "text.isnumeric", pattern: "pure:text.isnumeric" }),
            expect.objectContaining({ kind: "pure", call: "text.isprintable", pattern: "pure:text.isprintable" }),
            expect.objectContaining({ kind: "pure", call: "text.isspace", pattern: "pure:text.isspace" }),
            expect.objectContaining({ kind: "pure", call: "text.istitle", pattern: "pure:text.istitle" }),
            expect.objectContaining({ kind: "pure", call: "text.isupper", pattern: "pure:text.isupper" }),
            expect.objectContaining({ kind: "pure", call: "text.join", pattern: "pure:text.join" }),
            expect.objectContaining({ kind: "pure", call: "text.ljust", pattern: "pure:text.ljust" }),
            expect.objectContaining({ kind: "pure", call: "text.lower", pattern: "pure:text.lower" }),
            expect.objectContaining({ kind: "pure", call: "text.lstrip", pattern: "pure:text.lstrip" }),
            expect.objectContaining({ kind: "pure", call: "text.replace", pattern: "pure:text.replace" }),
            expect.objectContaining({ kind: "pure", call: "text.rfind", pattern: "pure:text.rfind" }),
            expect.objectContaining({ kind: "pure", call: "text.rindex", pattern: "pure:text.rindex" }),
            expect.objectContaining({ kind: "pure", call: "text.rjust", pattern: "pure:text.rjust" }),
            expect.objectContaining({ kind: "pure", call: "text.rpartition", pattern: "pure:text.rpartition" }),
            expect.objectContaining({ kind: "pure", call: "text.rsplit", pattern: "pure:text.rsplit" }),
            expect.objectContaining({ kind: "pure", call: "text.rstrip", pattern: "pure:text.rstrip" }),
            expect.objectContaining({ kind: "pure", call: "text.split", pattern: "pure:text.split" }),
            expect.objectContaining({ kind: "pure", call: "text.splitlines", pattern: "pure:text.splitlines" }),
            expect.objectContaining({ kind: "pure", call: "text.startswith", pattern: "pure:text.startswith" }),
            expect.objectContaining({ kind: "pure", call: "text.strip", pattern: "pure:text.strip" }),
            expect.objectContaining({ kind: "pure", call: "text.swapcase", pattern: "pure:text.swapcase" }),
            expect.objectContaining({ kind: "pure", call: "text.title", pattern: "pure:text.title" }),
            expect.objectContaining({ kind: "pure", call: "text.translate", pattern: "pure:text.translate" }),
            expect.objectContaining({ kind: "pure", call: "text.upper", pattern: "pure:text.upper" }),
            expect.objectContaining({ kind: "pure", call: "text.zfill", pattern: "pure:text.zfill" }),
            expect.objectContaining({ kind: "pure", call: "data.partition", pattern: "pure:data.partition" }),
            expect.objectContaining({ kind: "pure", call: "data.removeprefix", pattern: "pure:data.removeprefix" }),
            expect.objectContaining({ kind: "pure", call: "data.removesuffix", pattern: "pure:data.removesuffix" }),
            expect.objectContaining({ kind: "pure", call: "literal.split", pattern: "pure:literal.split" }),
            expect.objectContaining({ kind: "pure", call: "pathlib.Path.read_text.lower", pattern: "pure:pathlib.Path.read_text.lower" }),
          ]),
        )
      })
    })

    it("skips python ask for tracked string self-reassignment", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from pathlib import Path as P",
              "readme = P('README.md')",
              "text = readme.read_text()",
              "old = 'alpha'",
              "new = 'beta'",
              "text = text.replace(old, new, 1)",
              "text = text.replace(new, old, 1)",
            ].join("\n"),
            args: [],
            description: "tracked string self reassignment",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining([`read:${path.join(worktree, "README.md")}`]))
        expect(ask?.patterns).not.toEqual(expect.arrayContaining(["unknown:callable:text.replace"]))

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "read", call: "readme.read_text", path: path.join(worktree, "README.md") }),
            expect.objectContaining({ kind: "pure", call: "text.replace", pattern: "pure:text.replace" }),
          ]),
        )
      })
    })

    it("keeps arbitrary and unsupported string-like receivers on unknown permission patterns", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "obj.find(needle)",
              "obj.replace('a', 'b')",
              "open('f').read().find('x')",
              "open('f').read().replace('a', 'b')",
              "text = open('g').read()",
              "text = text.replace('a', 'b')",
              "str(value).find('x')",
              "str(value).replace('a', 'b')",
            ].join("\n"),
            args: [],
            description: "string guardrails",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(
          expect.arrayContaining([
            "unknown:callable:obj.find",
            "unknown:callable:obj.replace",
            "unknown:callable:open.read.find",
            "unknown:callable:open.read.replace",
            "unknown:callable:text.replace",
            "unknown:callable:str.find",
            "unknown:callable:str.replace",
          ]),
        )
        expect(ask?.patterns).not.toEqual(
          expect.arrayContaining([
            "pure:obj.find",
            "pure:obj.replace",
            "pure:open.read.find",
            "pure:open.read.replace",
            "pure:str.find",
            "pure:str.replace",
            "write:obj.replace",
            "write:open.read.replace",
            "write:str.replace",
          ]),
        )
      })
    })

    it("skips python ask for bounded loop variables from string split helpers", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from pathlib import Path as P",
              "lines = P('README.md').read_text().splitlines()",
              "for line in lines:",
              "    line.strip()",
              "for _, item in enumerate(lines):",
              "    item.strip()",
              "for _, later in enumerate(lines[1:]):",
              "    later.strip()",
            ].join("\n"),
            args: [],
            description: "loop string provenance",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining([`read:${path.join(worktree, "README.md")}`]))
        expect(ask?.patterns).not.toEqual(
          expect.arrayContaining(["unknown:callable:line.strip", "unknown:callable:item.strip", "unknown:callable:later.strip"]),
        )

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "read", call: "pathlib.Path.read_text" }),
            expect.objectContaining({ kind: "pure", call: "pathlib.Path.read_text.splitlines", pattern: "pure:pathlib.Path.read_text.splitlines" }),
            expect.objectContaining({ kind: "pure", call: "line.strip", pattern: "pure:line.strip" }),
            expect.objectContaining({ kind: "pure", call: "enumerate", pattern: "pure:enumerate" }),
            expect.objectContaining({ kind: "pure", call: "item.strip", pattern: "pure:item.strip" }),
            expect.objectContaining({ kind: "pure", call: "later.strip", pattern: "pure:later.strip" }),
          ]),
        )
      })
    })

    it("keeps unsupported loop string provenance on unknown permission patterns", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from pathlib import Path as P",
              "lines = open('README.md').read().splitlines()",
              "for line in lines:",
              "    line.strip()",
              "enumerate = custom",
              "safe_lines = P('other.txt').read_text().splitlines()",
              "for _, item in enumerate(safe_lines):",
              "    item.strip()",
            ].join("\n"),
            args: [],
            description: "loop string guardrails",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(
          expect.arrayContaining([
            `read:${path.join(worktree, "README.md")}`,
            `read:${path.join(worktree, "other.txt")}`,
            "unknown:callable:open.read",
            "unknown:callable:open.read.splitlines",
            "unknown:callable:line.strip",
            "unknown:callable:custom",
            "unknown:callable:item.strip",
          ]),
        )
        expect(ask?.patterns).not.toEqual(expect.arrayContaining(["pure:line.strip", "pure:item.strip"]))

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "read", call: "open" }),
            expect.objectContaining({ kind: "unknown", call: "callable:open.read" }),
            expect.objectContaining({ kind: "unknown", call: "callable:open.read.splitlines" }),
            expect.objectContaining({ kind: "unknown", call: "callable:line.strip" }),
            expect.objectContaining({ kind: "read", call: "pathlib.Path.read_text" }),
            expect.objectContaining({ kind: "pure", call: "pathlib.Path.read_text.splitlines", pattern: "pure:pathlib.Path.read_text.splitlines" }),
            expect.objectContaining({ kind: "unknown", call: "callable:custom" }),
            expect.objectContaining({ kind: "unknown", call: "callable:item.strip" }),
          ]),
        )
      })
    })

    it("skips python ask for tracked built-in type methods beyond strings", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from pathlib import Path as P",
              "tup = (1, 2, 1)",
              "tup.count(1)",
              "tup.index(2)",
              "rng = range(4)",
              "rng.count(1)",
              "rng.index(2)",
              "blob = P('data.bin').read_bytes()",
              "blob.decode('utf8')",
              "blob.hex()",
              "blob.join(parts)",
              "blob.translate(table)",
              "raw = bytes(seq)",
              "raw.startswith(prefix)",
              "raw.zfill(3)",
              "buf = bytearray(seq)",
              "buf.append(1)",
              "buf.pop()",
              "buf.decode('utf8')",
              "buf.replace(b'a', b'b')",
              "view = memoryview(buf)",
              "view.tobytes()",
              "view.hex()",
              "view.release()",
              "num = 7",
              "num.bit_length()",
              "num.to_bytes(1, 'big')",
              "flt = 1.5",
              "flt.hex()",
              "flt.is_integer()",
              "comp = complex(1, 2)",
              "comp.conjugate()",
              "b'x'.hex()",
            ].join("\n"),
            args: [],
            description: "built-in type methods",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining([`read:${path.join(worktree, "data.bin")}`]))
        expect(ask?.patterns).not.toEqual(
          expect.arrayContaining([
            "unknown:callable:tup.count",
            "unknown:callable:rng.index",
            "unknown:callable:blob.decode",
            "unknown:callable:blob.join",
            "unknown:callable:buf.append",
            "unknown:callable:view.tobytes",
            "unknown:callable:num.bit_length",
            "unknown:callable:flt.hex",
            "unknown:callable:comp.conjugate",
          ]),
        )

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "tup.count", pattern: "pure:tup.count" }),
            expect.objectContaining({ kind: "pure", call: "tup.index", pattern: "pure:tup.index" }),
            expect.objectContaining({ kind: "pure", call: "rng.count", pattern: "pure:rng.count" }),
            expect.objectContaining({ kind: "pure", call: "rng.index", pattern: "pure:rng.index" }),
            expect.objectContaining({ kind: "read", call: "pathlib.Path.read_bytes", path: path.join(worktree, "data.bin") }),
            expect.objectContaining({ kind: "pure", call: "blob.decode", pattern: "pure:blob.decode" }),
            expect.objectContaining({ kind: "pure", call: "blob.hex", pattern: "pure:blob.hex" }),
            expect.objectContaining({ kind: "pure", call: "blob.join", pattern: "pure:blob.join" }),
            expect.objectContaining({ kind: "pure", call: "blob.translate", pattern: "pure:blob.translate" }),
            expect.objectContaining({ kind: "pure", call: "raw.startswith", pattern: "pure:raw.startswith" }),
            expect.objectContaining({ kind: "pure", call: "raw.zfill", pattern: "pure:raw.zfill" }),
            expect.objectContaining({ kind: "pure", call: "buf.append", pattern: "pure:buf.append" }),
            expect.objectContaining({ kind: "pure", call: "buf.pop", pattern: "pure:buf.pop" }),
            expect.objectContaining({ kind: "pure", call: "buf.decode", pattern: "pure:buf.decode" }),
            expect.objectContaining({ kind: "pure", call: "buf.replace", pattern: "pure:buf.replace" }),
            expect.objectContaining({ kind: "pure", call: "view.tobytes", pattern: "pure:view.tobytes" }),
            expect.objectContaining({ kind: "pure", call: "view.hex", pattern: "pure:view.hex" }),
            expect.objectContaining({ kind: "pure", call: "view.release", pattern: "pure:view.release" }),
            expect.objectContaining({ kind: "pure", call: "num.bit_length", pattern: "pure:num.bit_length" }),
            expect.objectContaining({ kind: "pure", call: "num.to_bytes", pattern: "pure:num.to_bytes" }),
            expect.objectContaining({ kind: "pure", call: "flt.hex", pattern: "pure:flt.hex" }),
            expect.objectContaining({ kind: "pure", call: "flt.is_integer", pattern: "pure:flt.is_integer" }),
            expect.objectContaining({ kind: "pure", call: "comp.conjugate", pattern: "pure:comp.conjugate" }),
            expect.objectContaining({ kind: "pure", call: "hex", pattern: "pure:hex" }),
          ]),
        )
      })
    })

    it("keeps unsupported built-in type method receivers and return-chain cases on unknown permission patterns", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "obj.decode('utf8')",
              "obj.join(parts)",
              "obj.bit_length()",
              "obj.tobytes()",
              "open('f', 'rb').read().decode('utf8')",
              "data = Path('f').read_bytes()",
              "data.decode('utf8').split(',')",
              "str(value).encode('utf8')",
            ].join("\n"),
            args: [],
            description: "built-in type guardrails",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(
          expect.arrayContaining([
            "unknown:callable:obj.decode",
            "unknown:callable:obj.join",
            "unknown:callable:obj.bit_length",
            "unknown:callable:obj.tobytes",
            "unknown:callable:open.read.decode",
            `read:${path.join(worktree, "f")}`,
            "unknown:callable:data.decode.split",
            "unknown:callable:str.encode",
          ]),
        )
        expect(ask?.patterns).not.toEqual(
          expect.arrayContaining([
            "pure:obj.decode",
            "pure:obj.join",
            "pure:obj.bit_length",
            "pure:obj.tobytes",
            "pure:open.read.decode",
            "pure:data.decode.split",
            "pure:str.encode",
          ]),
        )
      })
    })

    it("keeps shadowed built-in type constructors from seeding tracked methods on unknown permission patterns", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "bytes = factory",
              "blob = bytes(seq)",
              "blob.hex()",
              "range = maker",
              "rng = range(3)",
              "rng.count(1)",
            ].join("\n"),
            args: [],
            description: "shadowed built-in type constructors",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(
          expect.arrayContaining([
            "unknown:callable:factory",
            "unknown:callable:blob.hex",
            "unknown:callable:maker",
            "unknown:callable:rng.count",
          ]),
        )
        expect(ask?.patterns).not.toEqual(
          expect.arrayContaining([
            "pure:blob.hex",
            "pure:rng.count",
          ]),
        )
      })
    })

    it("keeps Path replace on write permission patterns", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "from pathlib import Path\nPath('f').replace('g')",
            args: [],
            description: "path replace write",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining([`write:${path.join(worktree, "f")}`]))

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "write", call: "pathlib.Path.replace", path: path.join(worktree, "f") }),
          ]),
        )
      })
    })

    it("classifies builtin-page calls with bounded permission categories", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "abs(x)",
              "aiter(xs)",
              "anext(xs, None)",
              "bytearray(b'x')",
              "classmethod(fn)",
              "delattr(obj, 'field')",
              "enumerate(xs)",
              "filter(None, xs)",
              "format(x)",
              "getattr(obj, 'field', None)",
              "input('> ')",
              "help(obj)",
              "print('x')",
              "breakpoint()",
              "compile('x=1', '<s>', 'exec')",
              "eval('1+1')",
              "exec('x=1')",
              "open('f')",
              "type(x)",
              "__import__('os')",
            ].join("\n"),
            args: [],
            description: "builtin page coverage",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(
          expect.arrayContaining([
            "read:input",
            `read:${path.join(worktree, "f")}`,
            "exec:breakpoint",
            "exec:compile",
            "exec:eval",
            "exec:exec",
            "exec:__import__",
          ]),
        )
        expect(ask?.patterns).not.toEqual(
          expect.arrayContaining([
            "unknown:callable:abs",
            "unknown:callable:aiter",
            "unknown:callable:anext",
            "unknown:callable:bytearray",
            "unknown:callable:classmethod",
            "unknown:callable:delattr",
            "unknown:callable:enumerate",
            "unknown:callable:filter",
            "unknown:callable:format",
            "unknown:callable:getattr",
            "unknown:callable:type",
          ]),
        )

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "abs", pattern: "pure:abs" }),
            expect.objectContaining({ kind: "pure", call: "aiter", pattern: "pure:aiter" }),
            expect.objectContaining({ kind: "pure", call: "anext", pattern: "pure:anext" }),
            expect.objectContaining({ kind: "pure", call: "bytearray", pattern: "pure:bytearray" }),
            expect.objectContaining({ kind: "pure", call: "classmethod", pattern: "pure:classmethod" }),
            expect.objectContaining({ kind: "pure", call: "delattr", pattern: "pure:delattr" }),
            expect.objectContaining({ kind: "pure", call: "enumerate", pattern: "pure:enumerate" }),
            expect.objectContaining({ kind: "pure", call: "filter", pattern: "pure:filter" }),
            expect.objectContaining({ kind: "pure", call: "format", pattern: "pure:format" }),
            expect.objectContaining({ kind: "pure", call: "getattr", pattern: "pure:getattr" }),
            expect.objectContaining({ kind: "read", call: "input", pattern: "read:input" }),
            expect.objectContaining({ kind: "emit", call: "help", pattern: "emit:help" }),
            expect.objectContaining({ kind: "emit", call: "print", pattern: "emit:print" }),
            expect.objectContaining({ kind: "exec", call: "breakpoint", pattern: "exec:breakpoint" }),
            expect.objectContaining({ kind: "exec", call: "compile", pattern: "exec:compile" }),
            expect.objectContaining({ kind: "exec", call: "eval", pattern: "exec:eval" }),
            expect.objectContaining({ kind: "exec", call: "exec", pattern: "exec:exec" }),
            expect.objectContaining({ kind: "read", call: "open", path: path.join(worktree, "f") }),
            expect.objectContaining({ kind: "pure", call: "type", pattern: "pure:type" }),
            expect.objectContaining({ kind: "exec", call: "__import__", pattern: "exec:__import__" }),
          ]),
        )
      })
    })

    it("keeps shadowed and special-case builtins on unknown permission patterns", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "input = reader",
              "input()",
              "print = logger",
              "print('x')",
              "help = helper",
              "help(obj)",
              "breakpoint = trap",
              "breakpoint()",
              "open = opener",
              "open('f')",
              "type = builder",
              "type(x)",
              "type('Name', (), {})",
            ].join("\n"),
            args: [],
            description: "builtin shadow guards",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(
          expect.arrayContaining([
            "unknown:callable:reader",
            "unknown:callable:logger",
            "unknown:callable:helper",
            "unknown:callable:trap",
            "unknown:callable:opener",
            "unknown:callable:builder",
          ]),
        )
        expect(ask?.patterns).not.toEqual(
          expect.arrayContaining([
            "read:input",
            "emit:print",
            "emit:help",
            "exec:breakpoint",
            `read:${path.join(worktree, "f")}`,
            "pure:type",
          ]),
        )
      })
    })

    it("skips python ask for common unshadowed builtin helpers", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "list(values)",
              "dict(pairs)",
              "set(values)",
              "tuple(values)",
              "frozenset(values)",
              "len(values)",
              "max(values)",
              "min(values)",
              "sum(values)",
              "sorted(values)",
              "reversed(values)",
              "all(flags)",
              "any(flags)",
              "next(iterator, None)",
              "items = list(values)",
              "items.sort()",
            ].join("\n"),
            args: [],
            description: "builtin pure helpers",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.permissionPatterns).toEqual([])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "list", pattern: "pure:list" }),
            expect.objectContaining({ kind: "pure", call: "dict", pattern: "pure:dict" }),
            expect.objectContaining({ kind: "pure", call: "set", pattern: "pure:set" }),
            expect.objectContaining({ kind: "pure", call: "tuple", pattern: "pure:tuple" }),
            expect.objectContaining({ kind: "pure", call: "frozenset", pattern: "pure:frozenset" }),
            expect.objectContaining({ kind: "pure", call: "len", pattern: "pure:len" }),
            expect.objectContaining({ kind: "pure", call: "max", pattern: "pure:max" }),
            expect.objectContaining({ kind: "pure", call: "min", pattern: "pure:min" }),
            expect.objectContaining({ kind: "pure", call: "sum", pattern: "pure:sum" }),
            expect.objectContaining({ kind: "pure", call: "sorted", pattern: "pure:sorted" }),
            expect.objectContaining({ kind: "pure", call: "reversed", pattern: "pure:reversed" }),
            expect.objectContaining({ kind: "pure", call: "all", pattern: "pure:all" }),
            expect.objectContaining({ kind: "pure", call: "any", pattern: "pure:any" }),
            expect.objectContaining({ kind: "pure", call: "next", pattern: "pure:next" }),
            expect.objectContaining({ kind: "pure", call: "items.sort", pattern: "pure:items.sort" }),
          ]),
        )
      })
    })

    it("skips python ask for direct temporary builtin and json container receiver methods", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import json",
              "list(values).sort()",
              "dict(pairs).get('x')",
              "set(values).add(item)",
              "json.loads(text).get('x')",
            ].join("\n"),
            args: [],
            description: "temporary container chains",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.permissionPatterns).toEqual([])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "list.sort", pattern: "pure:list.sort" }),
            expect.objectContaining({ kind: "pure", call: "dict.get", pattern: "pure:dict.get" }),
            expect.objectContaining({ kind: "pure", call: "set.add", pattern: "pure:set.add" }),
            expect.objectContaining({ kind: "pure", call: "json.loads", pattern: "pure:json.loads" }),
            expect.objectContaining({ kind: "pure", call: "json.loads.get", pattern: "pure:json.loads.get" }),
          ]),
        )
      })
    })

    it("keeps unseeded subscript and attribute receiver container methods on unknown permission patterns", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "entries = []",
              "entries[current].append(item)",
              "self.stack.pop()",
              "state.stack.pop()",
            ].join("\n"),
            args: [],
            description: "subscript attribute receiver guardrails",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(
          expect.arrayContaining([
            "unknown:callable:entries.append",
            "unknown:callable:self.stack.pop",
            "unknown:callable:state.stack.pop",
          ]),
        )
        expect(ask?.patterns).not.toEqual(
          expect.arrayContaining([
            "pure:entries.append",
            "pure:self.stack.pop",
            "pure:state.stack.pop",
          ]),
        )

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "unknown", call: "callable:entries.append" }),
            expect.objectContaining({ kind: "unknown", call: "callable:self.stack.pop" }),
            expect.objectContaining({ kind: "unknown", call: "callable:state.stack.pop" }),
          ]),
        )
      })
    })

    it("skips python ask for exact same-scope subscript and attribute receiver containers", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import json",
              "entries[current] = []",
              "entries[current].append(item)",
              "entries[current].pop()",
              "entries[current] = json.loads(text)",
              "entries[current].get('x')",
              "state.stack = []",
              "state.stack.pop()",
              "state.payload = json.loads(text)",
              "state.payload.get('x')",
            ].join("\n"),
            args: [],
            description: "receiver identity containers",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.permissionPatterns).toEqual([])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "entries.append", pattern: "pure:entries.append" }),
            expect.objectContaining({ kind: "pure", call: "entries.pop", pattern: "pure:entries.pop" }),
            expect.objectContaining({ kind: "pure", call: "json.loads", pattern: "pure:json.loads" }),
            expect.objectContaining({ kind: "pure", call: "entries.get", pattern: "pure:entries.get" }),
            expect.objectContaining({ kind: "pure", call: "state.stack.pop", pattern: "pure:state.stack.pop" }),
            expect.objectContaining({ kind: "pure", call: "state.payload.get", pattern: "pure:state.payload.get" }),
          ]),
        )
      })
    })

    it("skips python ask for common receiver paths with one-hop attribute deps and shallow nested attributes", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "entries[current.user] = []",
              "entries[current.user].append(item)",
              "entries[current.user].pop()",
              "state.inner.stack = []",
              "state.inner.stack.pop()",
            ].join("\n"),
            args: [],
            description: "common receiver paths",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.permissionPatterns).toEqual([])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "entries.append", pattern: "pure:entries.append" }),
            expect.objectContaining({ kind: "pure", call: "entries.pop", pattern: "pure:entries.pop" }),
            expect.objectContaining({ kind: "pure", call: "state.inner.stack.pop", pattern: "pure:state.inner.stack.pop" }),
          ]),
        )
      })
    })

    it("keeps deeper attribute index dependencies on unknown permission patterns", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "entries[current.user.id] = []",
              "entries[current.user.id].append(item)",
            ].join("\n"),
            args: [],
            description: "deep attribute index receiver guardrail",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:entries.append"]))
        expect(ask?.patterns).not.toEqual(expect.arrayContaining(["pure:entries.append"]))
      })
    })

    it("skips python ask for tracked same-scope self attribute container methods", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import json",
              "self.stack = []",
              "self.stack.append(item)",
              "self.stack.pop()",
              "self.inner.stack = []",
              "self.inner.stack.pop()",
              "self.payload = json.loads(text)",
              "self.payload.get('x')",
            ].join("\n"),
            args: [],
            description: "self attribute containers",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.permissionPatterns).toEqual([])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "self.stack.append", pattern: "pure:self.stack.append" }),
            expect.objectContaining({ kind: "pure", call: "self.stack.pop", pattern: "pure:self.stack.pop" }),
            expect.objectContaining({ kind: "pure", call: "self.inner.stack.pop", pattern: "pure:self.inner.stack.pop" }),
            expect.objectContaining({ kind: "pure", call: "json.loads", pattern: "pure:json.loads" }),
            expect.objectContaining({ kind: "pure", call: "self.payload.get", pattern: "pure:self.payload.get" }),
          ]),
        )
      })
    })

    it("keeps reassigned or shadowed self attribute container methods on unknown permission patterns", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "self.stack = []",
              "self.stack.append(item)",
              "self.stack = other",
              "self.stack.pop()",
              "self.inner.stack = []",
              "self.inner.stack.pop()",
              "self.inner = other_inner",
              "self.inner.stack.pop()",
              "list = factory",
              "self.shadowed = list(values)",
              "self.shadowed.pop()",
              "self.outer = []",
              "def helper():",
              "    self.outer.pop()",
              "helper()",
              "def inner(self):",
              "    self.stack.append(item)",
              "inner(worker)",
              "self.inner.stack.pop()",
              "obj.stack.pop()",
            ].join("\n"),
            args: [],
            description: "self attribute guardrails",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(
          expect.arrayContaining([
            "unknown:callable:self.stack.pop",
            "unknown:callable:self.inner.stack.pop",
            "unknown:callable:factory",
            "unknown:callable:self.shadowed.pop",
            "unknown:callable:self.outer.pop",
            "unknown:callable:helper",
            "unknown:callable:self.stack.append",
            "unknown:callable:inner",
            "unknown:callable:self.inner.stack.pop",
            "unknown:callable:obj.stack.pop",
          ]),
        )
        expect(ask?.patterns).not.toEqual(
          expect.arrayContaining([
            "pure:self.shadowed.pop",
            "pure:self.outer.pop",
            "pure:obj.stack.pop",
          ]),
        )

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "self.stack.append", pattern: "pure:self.stack.append" }),
            expect.objectContaining({ kind: "unknown", call: "callable:self.stack.pop" }),
            expect.objectContaining({ kind: "pure", call: "self.inner.stack.pop", pattern: "pure:self.inner.stack.pop" }),
            expect.objectContaining({ kind: "unknown", call: "callable:self.inner.stack.pop" }),
            expect.objectContaining({ kind: "unknown", call: "callable:factory" }),
            expect.objectContaining({ kind: "unknown", call: "callable:self.shadowed.pop" }),
            expect.objectContaining({ kind: "unknown", call: "callable:self.outer.pop" }),
            expect.objectContaining({ kind: "unknown", call: "callable:helper" }),
            expect.objectContaining({ kind: "unknown", call: "callable:self.stack.append" }),
            expect.objectContaining({ kind: "unknown", call: "callable:inner" }),
            expect.objectContaining({ kind: "unknown", call: "callable:self.inner.stack.pop" }),
            expect.objectContaining({ kind: "unknown", call: "callable:obj.stack.pop" }),
          ]),
        )
      })
    })

    it("keeps common receiver-path containers on unknown permission patterns after dependency rebinding or excluded shapes", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "entries[current] = []",
              "entries[current].append(item)",
              "current = other",
              "entries[current].append(item)",
              "entries[current.user] = []",
              "entries[current.user].append(item)",
              "current.user = other_user",
              "entries[current.user].append(item)",
              "list = factory",
              "entries[current] = list(values)",
              "entries[current].pop()",
              "state.stack = []",
              "state.stack.pop()",
              "state = other_state",
              "state.stack.pop()",
              "state.inner.stack = []",
              "state.inner.stack.pop()",
              "state.inner = other_inner",
              "state.inner.stack.pop()",
              "state.shadow = list(values)",
              "state.shadow.pop()",
              "def helper():",
              "    state.stack.pop()",
              "helper()",
              "entries[current.user.id] = []",
              "entries[current.user.id].append(item)",
              "state.inner.deep.stack.pop()",
              "obj.stack.pop()",
            ].join("\n"),
            args: [],
            description: "receiver identity guardrails",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(
          expect.arrayContaining([
            "unknown:callable:entries.append",
            "unknown:callable:entries.append",
            "unknown:callable:factory",
            "unknown:callable:entries.pop",
            "unknown:callable:other_state.stack.pop",
            "unknown:callable:other_state.inner.stack.pop",
            "unknown:callable:other_state.shadow.pop",
            "unknown:callable:helper",
            "unknown:callable:entries.append",
            "unknown:callable:other_state.inner.deep.stack.pop",
            "unknown:callable:obj.stack.pop",
          ]),
        )
        expect(ask?.patterns).not.toEqual(
          expect.arrayContaining([
            "pure:other_state.shadow.pop",
            "pure:other_state.inner.deep.stack.pop",
            "pure:obj.stack.pop",
          ]),
        )

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "entries.append", pattern: "pure:entries.append" }),
            expect.objectContaining({ kind: "unknown", call: "callable:entries.append" }),
            expect.objectContaining({ kind: "pure", call: "entries.append", pattern: "pure:entries.append" }),
            expect.objectContaining({ kind: "unknown", call: "callable:entries.append" }),
            expect.objectContaining({ kind: "unknown", call: "callable:factory" }),
            expect.objectContaining({ kind: "unknown", call: "callable:entries.pop" }),
            expect.objectContaining({ kind: "pure", call: "state.stack.pop", pattern: "pure:state.stack.pop" }),
            expect.objectContaining({ kind: "unknown", call: "callable:other_state.stack.pop" }),
            expect.objectContaining({ kind: "pure", call: "other_state.inner.stack.pop", pattern: "pure:other_state.inner.stack.pop" }),
            expect.objectContaining({ kind: "unknown", call: "callable:other_state.inner.stack.pop" }),
            expect.objectContaining({ kind: "unknown", call: "callable:other_state.shadow.pop" }),
            expect.objectContaining({ kind: "unknown", call: "callable:helper" }),
            expect.objectContaining({ kind: "unknown", call: "callable:entries.append" }),
            expect.objectContaining({ kind: "unknown", call: "callable:other_state.inner.deep.stack.pop" }),
            expect.objectContaining({ kind: "unknown", call: "callable:obj.stack.pop" }),
          ]),
        )
      })
    })

    it("keeps shadowed, callback-customized, and unresolved builtin helpers on unknown permission patterns", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "def use_max(max):",
              "    return max(values)",
              "use_max(func)",
              "from builtins import list",
              "list(values)",
              "list(values).sort()",
              "def use_dict(dict):",
              "    return dict(pairs).get('x')",
              "use_dict(factory)",
              "import json",
              "json.loads(text, object_hook=hook).get('x')",
              "max(values, key=rank)",
              "min(values, key=rank)",
              "max(values, **opts)",
              "min(values, **opts)",
              "sorted(values, key=rank)",
              "sorted(values, **opts)",
              "obj.sort()",
              "[list(values).sort() for list in rows]",
            ].join("\n"),
            args: [],
            description: "builtin guardrails",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(
          expect.arrayContaining([
            "unknown:callable:max",
            "unknown:callable:min",
            "unknown:callable:list",
            "unknown:callable:list.sort",
            "unknown:callable:dict.get",
            "unknown:callable:sorted",
            "unknown:callable:json.loads",
            "unknown:callable:json.loads.get",
            "unknown:callable:obj.sort",
          ]),
        )
        expect(ask?.patterns).not.toEqual(
          expect.arrayContaining([
            "pure:max",
            "pure:min",
            "pure:sorted",
            "pure:obj.sort",
            "pure:list.sort",
          ]),
        )

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "unknown", call: "callable:max" }),
            expect.objectContaining({ kind: "unknown", call: "callable:min" }),
            expect.objectContaining({ kind: "unknown", call: "callable:list" }),
            expect.objectContaining({ kind: "unknown", call: "callable:list.sort" }),
            expect.objectContaining({ kind: "unknown", call: "callable:dict.get" }),
            expect.objectContaining({ kind: "unknown", call: "callable:sorted" }),
            expect.objectContaining({ kind: "unknown", call: "callable:json.loads" }),
            expect.objectContaining({ kind: "unknown", call: "callable:json.loads.get" }),
            expect.objectContaining({ kind: "unknown", call: "callable:obj.sort" }),
          ]),
        )
      })
    })

    it("skips python ask for standard builtin exception raises", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "raise ValueError",
              "raise RuntimeError('bad input')",
              "err = TypeError()",
              "raise AssertionError from cause",
            ].join("\n"),
            args: [],
            description: "standard exception raises",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.permissionPatterns).toEqual([])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "ValueError", pattern: "pure:ValueError" }),
            expect.objectContaining({ kind: "pure", call: "RuntimeError", pattern: "pure:RuntimeError" }),
            expect.objectContaining({ kind: "pure", call: "TypeError", pattern: "pure:TypeError" }),
            expect.objectContaining({ kind: "pure", call: "AssertionError", pattern: "pure:AssertionError" }),
          ]),
        )
      })
    })

    it("keeps shadowed and custom raise targets on unknown permission patterns", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "ValueError = make_error",
              "raise ValueError()",
              "class CustomError(Exception):",
              "    pass",
              "raise CustomError()",
              "raise err",
              "raise make_error()",
            ].join("\n"),
            args: [],
            description: "raise guardrails",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(
          expect.arrayContaining([
            "unknown:callable:CustomError",
            "unknown:callable:make_error",
          ]),
        )
        expect(ask?.patterns).not.toEqual(
          expect.arrayContaining([
            "pure:ValueError",
            "pure:CustomError",
          ]),
        )

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "unknown", call: "callable:CustomError" }),
            expect.objectContaining({ kind: "unknown", call: "callable:make_error" }),
          ]),
        )
      })
    })

    it("keeps rebound standard exception names on unknown permission patterns", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "for ValueError in errors:",
              "    raise ValueError",
              "with manager() as ValueError:",
              "    raise ValueError",
              "try:",
              "    raise RuntimeError()",
              "except Exception as ValueError:",
              "    raise ValueError",
              "[ValueError(item) for ValueError in errors]",
              "from builtins import ValueError",
              "raise ValueError",
            ].join("\n"),
            args: [],
            description: "rebound exception names",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(
          expect.arrayContaining([
            "unknown:callable:manager",
            "unknown:callable:ValueError",
          ]),
        )
        expect(ask?.patterns).not.toEqual(expect.arrayContaining(["pure:ValueError"]))

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "unknown", call: "callable:manager" }),
            expect.objectContaining({ kind: "unknown", call: "callable:ValueError" }),
            expect.objectContaining({ kind: "pure", call: "RuntimeError", pattern: "pure:RuntimeError" }),
          ]),
        )
      })
    })

    it("keeps shadowed dict.fromkeys on unknown permission patterns", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "class dict:",
              "    @staticmethod",
              "    def fromkeys(seq):",
              "        return seq",
              "dict.fromkeys(seq)",
            ].join("\n"),
            args: [],
            description: "shadowed dict fromkeys",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:dict.fromkeys"]))
        expect(ask?.patterns).not.toEqual(expect.arrayContaining(["pure:dict.fromkeys"]))

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "unknown", call: "callable:dict.fromkeys" }),
          ]),
        )
      })
    })

    it("keeps parameter-shadowed dict.fromkeys on unknown permission patterns", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "def f(dict):",
              "    return dict.fromkeys(seq)",
              "f(mapping)",
            ].join("\n"),
            args: [],
            description: "parameter shadowed dict fromkeys",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:dict.fromkeys"]))
        expect(ask?.patterns).not.toEqual(expect.arrayContaining(["pure:dict.fromkeys"]))

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "unknown", call: "callable:dict.fromkeys" }),
          ]),
        )
      })
    })

    it("keeps imported dict.fromkeys on unknown permission patterns", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from builtins import dict",
              "dict.fromkeys(seq)",
            ].join("\n"),
            args: [],
            description: "imported dict fromkeys",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:dict.fromkeys"]))
        expect(ask?.patterns).not.toEqual(expect.arrayContaining(["pure:dict.fromkeys"]))

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "unknown", call: "callable:dict.fromkeys" }),
          ]),
        )
      })
    })

    it("skips python ask for json-derived in-memory container mutation", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "import json\nbase = json.loads(text)\nbase.setdefault('calls', {})",
            args: [],
            description: "json container mutation",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.permissionPatterns).toEqual([])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "json.loads", pattern: "pure:json.loads" }),
            expect.objectContaining({ kind: "pure", call: "base.setdefault", pattern: "pure:base.setdefault" }),
          ]),
        )
      })
    })

    it("skips python ask for json-derived iteration item access", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import json",
              "plan = json.loads(text)",
              "for item in plan.get('ok', []):",
              "    item.get('frontmatter', {})",
              "plan_04 = next((item for item in plan.get('ok', [])), None)",
              "plan_04.get('content', '')",
            ].join("\n"),
            args: [],
            description: "json iteration access",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.permissionPatterns).toEqual([])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "json.loads", pattern: "pure:json.loads" }),
            expect.objectContaining({ kind: "pure", call: "plan.get", pattern: "pure:plan.get" }),
            expect.objectContaining({ kind: "pure", call: "item.get", pattern: "pure:item.get" }),
            expect.objectContaining({ kind: "pure", call: "plan_04.get", pattern: "pure:plan_04.get" }),
          ]),
        )
      })
    })

    it("skips python ask for tracked-response json fallback and derived iteration", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import requests",
              "response = requests.get('https://example.com')",
              "payload = response.json() or {}",
              "payload.get('ok', [])",
              "for item in payload.get('ok', []):",
              "    item.get('frontmatter', {})",
            ].join("\n"),
            args: [],
            description: "response json fallback",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["read:requests.get"]))
        expect(ask?.patterns).not.toEqual(
          expect.arrayContaining([
            "unknown:callable:response.json",
            "unknown:callable:payload.get",
            "unknown:callable:item.get",
          ]),
        )

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "read", call: "requests.get" }),
            expect.objectContaining({ kind: "pure", call: "response.json", pattern: "pure:response.json" }),
            expect.objectContaining({ kind: "pure", call: "payload.get", pattern: "pure:payload.get" }),
            expect.objectContaining({ kind: "pure", call: "item.get", pattern: "pure:item.get" }),
          ]),
        )
      })
    })

    it("keeps arbitrary and customized response json access on unknown permission patterns", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "payload = obj.json() or {}",
              "payload.get('ok', [])",
              "import requests",
              "response = requests.get('https://example.com')",
              "custom = response.json(parse_float=hook)",
              "custom.get('ok', [])",
            ].join("\n"),
            args: [],
            description: "conservative json access",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(
          expect.arrayContaining([
            "unknown:callable:obj.json",
            "unknown:callable:payload.get",
            "read:requests.get",
            "unknown:callable:response.json",
            "unknown:callable:custom.get",
          ]),
        )
        expect(ask?.patterns).not.toEqual(
          expect.arrayContaining([
            "pure:obj.json",
            "pure:payload.get",
            "pure:response.json",
            "pure:custom.get",
          ]),
        )

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "unknown", call: "callable:obj.json" }),
            expect.objectContaining({ kind: "unknown", call: "callable:payload.get" }),
            expect.objectContaining({ kind: "read", call: "requests.get" }),
            expect.objectContaining({ kind: "unknown", call: "callable:response.json" }),
            expect.objectContaining({ kind: "unknown", call: "callable:custom.get" }),
          ]),
        )
      })
    })

    it("keeps shadowed tracked response names on unknown permission patterns", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import requests",
              "response = requests.get('https://example.com')",
              "response.json()",
              "def use_param(response):",
              "    response.json()",
              "def use_local():",
              "    response = obj",
              "    response.json()",
            ].join("\n"),
            args: [],
            description: "shadowed response json",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["read:requests.get", "unknown:callable:response.json"]))
        expect(ask?.patterns).not.toEqual(expect.arrayContaining(["pure:response.json"]))

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "read", call: "requests.get" }),
            expect.objectContaining({ kind: "pure", call: "response.json", pattern: "pure:response.json" }),
            expect.objectContaining({ kind: "unknown", call: "callable:response.json" }),
          ]),
        )
      })
    })

    it("keeps customized json decoder container methods on unknown permission patterns", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import json",
              "base = json.loads(text, object_hook=hook)",
              "base.setdefault('calls', {})",
              "numbers = json.loads(text, parse_float=hook)",
              "numbers.setdefault('calls', {})",
              "pairs = json.loads(text, object_pairs_hook=hook)",
              "pairs.update({'x': 1})",
              "decoded = json.loads(text, cls=Decoder)",
              "decoded.update({'x': 1})",
              "ints = json.loads(text, parse_int=hook)",
              "ints.setdefault('calls', {})",
              "constants = json.loads(text, parse_constant=hook)",
              "constants.setdefault('calls', {})",
              "spread = json.loads(text, **opts)",
              "spread.setdefault('calls', {})",
              "decoder = json.load(f, cls=Decoder)",
              "decoder.update({'x': 1})",
            ].join("\n"),
            args: [],
            description: "custom json decoder",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(
          expect.arrayContaining([
            "unknown:callable:json.loads",
            "unknown:callable:base.setdefault",
            "unknown:callable:numbers.setdefault",
            "unknown:callable:pairs.update",
            "unknown:callable:decoded.update",
            "unknown:callable:ints.setdefault",
            "unknown:callable:constants.setdefault",
            "unknown:callable:spread.setdefault",
            "unknown:callable:decoder.update",
          ]),
        )
        expect(ask?.patterns).not.toEqual(expect.arrayContaining(["write:base.setdefault", "pure:base.setdefault"]))

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "unknown", call: "callable:json.loads" }),
            expect.objectContaining({ kind: "unknown", call: "callable:base.setdefault" }),
            expect.objectContaining({ kind: "unknown", call: "callable:numbers.setdefault" }),
            expect.objectContaining({ kind: "unknown", call: "callable:pairs.update" }),
            expect.objectContaining({ kind: "unknown", call: "callable:decoded.update" }),
            expect.objectContaining({ kind: "unknown", call: "callable:ints.setdefault" }),
            expect.objectContaining({ kind: "unknown", call: "callable:constants.setdefault" }),
            expect.objectContaining({ kind: "unknown", call: "callable:spread.setdefault" }),
            expect.objectContaining({ kind: "unknown", call: "callable:decoder.update" }),
          ]),
        )
      })
    })

    it("keeps emit non-blocking when mixed with write patterns", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "print('hello')\nopen('a.txt', 'w')",
            args: [],
            description: "emit and write",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toContain(`write:${toSlash(path.join(worktree, "a.txt"))}`)
        expect(ask?.patterns).not.toContain("emit:print")
        expect(ask?.always).not.toEqual(expect.arrayContaining([expect.stringMatching(/^emit:/)]))

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "emit", call: "print" }),
            expect.objectContaining({ kind: "write", call: "open" }),
          ]),
        )
      })
    })

    it("keeps pure non-blocking when mixed with unknown patterns", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "import re\nre.search('a+', text)\nmypkg.do_thing()",
            args: [],
            description: "pure and unknown",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toContain("unknown:callable:mypkg.do_thing")
        expect(ask?.patterns).not.toContain("pure:re.search")
        expect(ask?.always).not.toEqual(expect.arrayContaining([expect.stringMatching(/^pure:/)]))

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "re.search" }),
            expect.objectContaining({ kind: "unknown", call: "callable:mypkg.do_thing" }),
          ]),
        )
      })
    })

    it("asks read permissions for direct HTTP reads", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "import requests\nrequests.get('https://example.com')",
            args: [],
            description: "http read",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toContain("read:requests.get")
        expect(ask?.patterns).not.toContain("exec:requests.get")

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "read", call: "requests.get" })]))
      })
    })

    it("asks write permissions for direct HTTP writes", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "import requests\nrequests.post('https://example.com')",
            args: [],
            description: "http write",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toContain("write:requests.post")
        expect(ask?.patterns).not.toContain("exec:requests.post")

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "write", call: "requests.post" })]))
      })
    })

    it("asks read/write permissions for bounded from-import HTTP helpers", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "from requests import get, post\nget('https://example.com/a')\npost('https://example.com/b')",
            args: [],
            description: "http from import",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["read:requests.get", "write:requests.post"]))
        expect(ask?.patterns).not.toEqual(expect.arrayContaining(["unknown:callable:get", "unknown:callable:post"]))

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "read", call: "requests.get" }),
            expect.objectContaining({ kind: "write", call: "requests.post" }),
          ]),
        )
      })
    })

    it("asks read/write permissions for tracked HTTP client instance methods", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "import requests\nclient = requests.Session()\nclient.get('https://example.com/a')\nclient.post('https://example.com/b')",
            args: [],
            description: "http client methods",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(
          expect.arrayContaining(["exec:requests.Session", "read:requests.Session.get", "write:requests.Session.post"]),
        )

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "exec", call: "requests.Session" }),
            expect.objectContaining({ kind: "read", call: "requests.Session.get" }),
            expect.objectContaining({ kind: "write", call: "requests.Session.post" }),
          ]),
        )
      })
    })

    it("asks read/write permissions for bounded HTTP request(method) calls", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import requests",
              "requests.request('get', 'https://example.com/a')",
              "requests.request(method='POST', url='https://example.com/b')",
              "from httpx import request as http_request",
              "http_request('Head', 'https://example.com/c')",
            ].join("\n"),
            args: [],
            description: "http request method inference",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["read:requests.get", "write:requests.post", "read:httpx.head"]))

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "read", call: "requests.get" }),
            expect.objectContaining({ kind: "write", call: "requests.post" }),
            expect.objectContaining({ kind: "read", call: "httpx.head" }),
          ]),
        )
      })
    })

    it("asks read/write permissions for tracked private HTTP transport request calls", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import requests",
              "client = requests.Session()",
              "client.request('get', 'https://example.com/a')",
              "client._client._transport.request('POST', 'https://example.com/b')",
            ].join("\n"),
            args: [],
            description: "http private transport request",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(
          expect.arrayContaining(["exec:requests.Session", "read:requests.Session.get", "write:requests.Session.post"]),
        )

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "exec", call: "requests.Session" }),
            expect.objectContaining({ kind: "read", call: "requests.Session.get" }),
            expect.objectContaining({ kind: "write", call: "requests.Session.post" }),
          ]),
        )
      })
    })

    it("keeps dynamic or unrelated request calls on unknown permission patterns", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import requests",
              "client = requests.Session()",
              "verb = 'GET'",
              "client.request(verb, 'https://example.com/a')",
              "client._cache.request('GET', 'https://example.com/d')",
              "client._client.request('GET', 'https://example.com/c')",
              "client.api.request('GET', 'https://example.com/b')",
            ].join("\n"),
            args: [],
            description: "dynamic request method",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(
          expect.arrayContaining([
            "exec:requests.Session",
            "unknown:callable:client.request",
            "unknown:callable:client._cache.request",
            "unknown:callable:client._client.request",
            "unknown:callable:client.api.request",
          ]),
        )
        expect(ask?.patterns).not.toEqual(expect.arrayContaining(["read:requests.Session.get", "write:requests.Session.post"]))

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "exec", call: "requests.Session" }),
            expect.objectContaining({ kind: "unknown", call: "callable:client.request" }),
            expect.objectContaining({ kind: "unknown", call: "callable:client._cache.request" }),
            expect.objectContaining({ kind: "unknown", call: "callable:client._client.request" }),
            expect.objectContaining({ kind: "unknown", call: "callable:client.api.request" }),
          ]),
        )
      })
    })

    it("keeps unsupported literal request methods on unknown permission patterns", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "import requests\nrequests.request('TRACE', 'https://example.com/a')",
            args: [],
            description: "unsupported request method",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:requests.request"]))
        expect(ask?.patterns).not.toEqual(expect.arrayContaining(["read:requests.get", "write:requests.post"]))

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "unknown", call: "callable:requests.request" }),
          ]),
        )
      })
    })
  })

  describe("script-file permission behavior", () => {
    it("includes script code preview metadata in python ask", async () => {
      await withWorkspace(async ({ worktree }) => {
        const scriptPath = path.join(worktree, "preview.py")
        const scriptSource = "open('preview.txt', 'r')\n"
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

    it("asks external_directory without python ask for emit-only outside workdir", async () => {
      await withWorkspace(async ({ root, worktree }) => {
        const outside = path.join(root, "outside")
        await mkdir(outside, { recursive: true })

        const context = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "print('outside')",
            workdir: outside,
            args: [],
            description: "emit outside workdir",
          },
          context,
        )

        const externalAsk = getAsk(context, "external_directory")
        expect(externalAsk?.patterns).toContain(`${toSlash(outside)}/*`)
        expect(getAsk(context, "python")).toBeUndefined()

        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([expect.objectContaining({ kind: "emit", call: "print" })]),
        )
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
