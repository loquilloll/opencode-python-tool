import { describe, expect, it } from "bun:test"
import path from "path"
import { createMockContext } from "./fixtures/context"
import {
  executeExpectingEnoent,
  getAsk,
  getAskMetadata,
  toSlash,
  withWorkspace,
} from "./fixtures/python-runtime"

async function collectInlinePermissionParity(source: string) {
  return withWorkspace(async ({ worktree }) => {
    const context = createMockContext({ worktree, directory: worktree })

    await executeExpectingEnoent(
      {
        code: source,
        args: [],
        description: "phase 1 parity",
      },
      context,
    )

    return {
      ask: getAsk(context, "python"),
      metadata: context.metadatas[0]?.metadata,
    }
  })
}

describe("python tool runtime", () => {
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

    it("auto-allows literal read paths inside the worktree and keeps read metadata", async () => {
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

        expect(getAsk(context, "python")).toBeUndefined()

        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.permissionPatterns).toEqual([])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "read",
              call: "open",
              path: toSlash(path.join(worktree, "notes.txt")),
              pattern: `read:${toSlash(path.join(worktree, "notes.txt"))}`,
            }),
          ]),
        )
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

    it("asks for pytest.main exec calls, including direct imports", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "import pytest\npytest.main(['-q'])\nfrom pytest import main\nmain(['-q'])",
            args: [],
            description: "pytest main exec ask",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toContain("exec:pytest.main")
      })
    })

    it("keeps conservative pytest helpers on the unknown ask path", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "import pytest\npytest.approx(1.0)\nfrom pytest import approx\napprox(1.0)",
            args: [],
            description: "conservative pytest helpers",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:pytest.approx", "unknown:callable:approx"]))
      })
    })

    it("keeps shadowed pytest.main forms on the unknown ask path", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from pytest import main",
              "def main(args):",
              "    return args",
              "main(['-q'])",
              "import pytest",
              "pytest = object()",
              "pytest.main(['-q'])",
            ].join("\n"),
            args: [],
            description: "shadowed pytest main",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:main", "unknown:callable:pytest.main"]))
      })
    })

    it("keeps aliased pytest.main module calls conservative after root rebinding", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "import pytest\npytest = object()\nrunner = pytest\nrunner.main(['-q'])",
            args: [],
            description: "aliased shadowed pytest main",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:pytest.main"]))
      })
    })

    it("asks for importlib.import_module exec calls and importlib.metadata.version reads", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from importlib import import_module",
              "import_module('json')",
              "from importlib.metadata import version",
              "version('PyGithub')",
              "from importlib import metadata",
              "metadata.version('PyGithub')",
              "import importlib.metadata as md",
              "md.version('PyGithub')",
            ].join("\n"),
            args: [],
            description: "importlib family asks",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["exec:importlib.import_module", "read:importlib.metadata.version"]))
      })
    })

    it("keeps reassigned importlib leaf names on the unknown ask path", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import importlib",
              "import_module = importlib.import_module",
              "import_module('json')",
              "import importlib.metadata",
              "version = importlib.metadata.version",
              "version('PyGithub')",
            ].join("\n"),
            args: [],
            description: "reassigned importlib leaf names",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:importlib.import_module", "unknown:callable:importlib.metadata.version"]))
      })
    })

    it("keeps aliased importlib forms on the unknown ask path", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from importlib import import_module as imod",
              "imod('json')",
              "from importlib.metadata import version as pkg_version",
              "pkg_version('PyGithub')",
            ].join("\n"),
            args: [],
            description: "aliased importlib forms",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(
          expect.arrayContaining([
            "unknown:callable:importlib.import_module",
            "unknown:callable:importlib.metadata.version",
          ]),
        )
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

    it("skips python ask for tracked compiled-regex helpers and keeps pure metadata", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import re",
              "pat = re.compile('a+')",
              "pat.search(text)",
              "pat.search(text).group(0)",
              "pat.findall(text).count('a')",
              "pat.split(text).count('')",
            ].join("\n"),
            args: [],
            description: "tracked compiled regex helpers",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.permissionPatterns).toEqual([])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "re.compile", pattern: "pure:re.compile" }),
            expect.objectContaining({ kind: "pure", call: "pat.search", pattern: "pure:pat.search" }),
            expect.objectContaining({ kind: "pure", call: "pat.search.group", pattern: "pure:pat.search.group" }),
            expect.objectContaining({ kind: "pure", call: "pat.findall.count", pattern: "pure:pat.findall.count" }),
            expect.objectContaining({ kind: "pure", call: "pat.split.count", pattern: "pure:pat.split.count" }),
          ]),
        )
      })
    })

    it("skips python ask for tracked string split locals and keeps pure metadata", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from pathlib import Path",
              "text = Path('f').read_text()",
              "line = text.splitlines()[0]",
              "line.split(' ', 1)[0].strip()",
              "parts = line.split(':')",
              "parts[0].strip()",
              "name = parts[0]",
              "name.lower()",
            ].join("\n"),
            args: [],
            description: "tracked string split locals",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.permissionPatterns).toEqual([])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "read", call: "pathlib.Path.read_text" }),
            expect.objectContaining({ kind: "pure", call: "text.splitlines", pattern: "pure:text.splitlines" }),
            expect.objectContaining({ kind: "pure", call: "line.split", pattern: "pure:line.split" }),
            expect.objectContaining({ kind: "pure", call: "line.split.strip", pattern: "pure:line.split.strip" }),
            expect.objectContaining({ kind: "pure", call: "parts.strip", pattern: "pure:parts.strip" }),
            expect.objectContaining({ kind: "pure", call: "name.lower", pattern: "pure:name.lower" }),
          ]),
        )
      })
    })

    it("keeps tracked string split locals conservative after reassignment", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from pathlib import Path",
              "text = Path('f').read_text()",
              "line = text.splitlines()[0]",
              "line = other",
              "line.split(' ', 1)",
              "line.strip()",
            ].join("\n"),
            args: [],
            description: "reassigned string split locals",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:other.split", "unknown:callable:other.strip"]))
      })
    })

    it("skips python ask for same-scope helper params seeded from trusted string iterables", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "entries = ['x:1', 'x:2']",
              "def leaf(entries):",
              "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
              "leaf(entries)",
            ].join("\n"),
            args: [],
            description: "helper param string provenance",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(["unknown:callable:leaf"])
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.permissionPatterns).toEqual(["unknown:callable:leaf"])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "e.split", pattern: "pure:e.split" }),
            expect.objectContaining({ kind: "pure", call: "e.startswith", pattern: "pure:e.startswith" }),
          ]),
        )
      })
    })

    it("seeds same-scope helper params even when the helper is defined before the trusted producer", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "def leaf(entries):",
              "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
              "from pathlib import Path",
              "entries = Path('f').read_text().splitlines()",
              "leaf(entries)",
            ].join("\n"),
            args: [],
            description: "helper before producer string provenance",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(["unknown:callable:leaf"])
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "e.split", pattern: "pure:e.split" }),
            expect.objectContaining({ kind: "pure", call: "e.startswith", pattern: "pure:e.startswith" }),
          ]),
        )
      })
    })

    it("keeps same-scope helper params conservative when callsites disagree", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "entries = ['x:1']",
              "other = values",
              "def leaf(entries):",
              "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
              "leaf(entries)",
              "leaf(other)",
            ].join("\n"),
            args: [],
            description: "mixed helper param provenance",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith"]))
      })
    })

    it("keeps helper-param string iterable seeds conservative after indexed mutation", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from pathlib import Path",
              "entries = Path('f').read_text().splitlines()",
              "entries[0] = other",
              "def leaf(entries):",
              "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
              "leaf(entries)",
            ].join("\n"),
            args: [],
            description: "mutated helper param provenance",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith"]))
      })
    })

    it("keeps helper-param string iterable seeds conservative after alias-based indexed mutation", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from pathlib import Path",
              "entries = Path('f').read_text().splitlines()",
              "alias = entries",
              "alias[0] = other",
              "def leaf(entries):",
              "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
              "leaf(entries)",
            ].join("\n"),
            args: [],
            description: "aliased helper indexed mutation",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith"]))
      })
    })

    it("keeps mutation-built receiver-path string lists conservative", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "current = 'runtime'",
              "inv[current] = []",
              "inv[current].append('x:1')",
              "def leaf(entries):",
              "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
              "leaf(inv[current])",
            ].join("\n"),
            args: [],
            description: "receiver path helper string provenance",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith", "unknown:callable:leaf"]))
      })
    })

    it("keeps mutation-built receiver-path string lists conservative when appended values are unknown", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "current = 'runtime'",
              "inv[current] = []",
              "inv[current].append(other)",
              "def leaf(entries):",
              "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
              "leaf(inv[current])",
            ].join("\n"),
            args: [],
            description: "unknown receiver path helper string provenance",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith", "unknown:callable:leaf"]))
      })
    })

    it("keeps mutation-built receiver-path string lists conservative when aliased subscript receivers mutate", async () => {
      await withWorkspace(async ({ worktree }) => {
        const aliasAppendContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "current = 'runtime'",
              "inv[current] = []",
              "inv[current].append('x:1')",
              "bucket = inv[current]",
              "bucket.append(other)",
              "def leaf(entries):",
              "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
              "leaf(inv[current])",
            ].join("\n"),
            args: [],
            description: "aliased receiver path append mutation",
          },
          aliasAppendContext,
        )
        expect(getAsk(aliasAppendContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith", "unknown:callable:leaf"]))

        const aliasIndexContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "current = 'runtime'",
              "inv[current] = []",
              "inv[current].append('x:1')",
              "bucket = inv[current]",
              "bucket[0] = other",
              "def leaf(entries):",
              "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
              "leaf(inv[current])",
            ].join("\n"),
            args: [],
            description: "aliased receiver path indexed mutation",
          },
          aliasIndexContext,
        )
        expect(getAsk(aliasIndexContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith", "unknown:callable:leaf"]))
      })
    })

    it("keeps helper-param string iterable seeds conservative after mutating list methods", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from pathlib import Path",
              "entries = Path('f').read_text().splitlines()",
              "entries.append(other)",
              "def leaf(entries):",
              "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
              "leaf(entries)",
            ].join("\n"),
            args: [],
            description: "mutated helper param provenance by append",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith"]))
      })
    })

    it("keeps helper-param string iterable seeds conservative through aliases and comprehension mutations", async () => {
      await withWorkspace(async ({ worktree }) => {
        const aliasContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: [
              "from pathlib import Path",
              "entries = Path('f').read_text().splitlines()",
              "alias = entries",
              "entries.append(other)",
              "def leaf(entries):",
              "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
              "leaf(alias)",
            ].join("\n"),
            args: [],
            description: "aliased helper param mutation",
          },
          aliasContext,
        )
        expect(getAsk(aliasContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith"]))

        const compContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: [
              "from pathlib import Path",
              "entries = Path('f').read_text().splitlines()",
              "[entries.append(other) for _ in xs]",
              "def leaf(entries):",
              "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
              "leaf(entries)",
            ].join("\n"),
            args: [],
            description: "comprehension helper param mutation",
          },
          compContext,
        )
        expect(getAsk(compContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith"]))
      })
    })

    it("skips python ask for dir and sorted(dir()) string origins when builtins are trusted", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "name = dir(obj)[0]",
              "name.lower()",
              "for attr in sorted(dir(obj)):",
              "    attr.startswith('_')",
            ].join("\n"),
            args: [],
            description: "dir string origins",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.permissionPatterns).toEqual([])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "dir", pattern: "pure:dir" }),
            expect.objectContaining({ kind: "pure", call: "name.lower", pattern: "pure:name.lower" }),
            expect.objectContaining({ kind: "pure", call: "sorted", pattern: "pure:sorted" }),
            expect.objectContaining({ kind: "pure", call: "attr.startswith", pattern: "pure:attr.startswith" }),
          ]),
        )
      })
    })

    it("keeps dir and sorted(dir()) string origins conservative when builtins are shadowed", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "dir = fake",
              "name = dir(obj)[0]",
              "name.lower()",
              "sorted = fake_sorted",
              "for attr in sorted(dir(obj)):",
              "    attr.startswith('_')",
            ].join("\n"),
            args: [],
            description: "shadowed dir string origins",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:name.lower", "unknown:callable:attr.startswith"]))
      })
    })

    it("keeps dir-derived string origins conservative after indexed mutation", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "names = dir(obj)\nnames[0] = other\nname = names[0]\nname.lower()",
            args: [],
            description: "mutated dir string origins",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:name.lower"]))
      })
    })

    it("keeps dir-derived string origins conservative after alias-based indexed mutation", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "names = dir(obj)\nalias = names\nalias[0] = other\nname = names[0]\nname.lower()",
            args: [],
            description: "aliased dir indexed mutation",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:name.lower"]))
      })
    })

    it("skips python ask for exact __dict__.items introspection", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import calendar",
              "calendar.__dict__.items()",
            ].join("\n"),
            args: [],
            description: "__dict__ items introspection",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.permissionPatterns).toEqual([])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "calendar.__dict__.items", pattern: "pure:calendar.__dict__.items" }),
          ]),
        )
      })
    })

    it("keeps dir-derived string origins conservative after mutating list methods", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "names = dir(obj)\nnames.extend(other)\nname = names[0]\nname.lower()",
            args: [],
            description: "mutated dir string origins by extend",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:name.lower"]))
      })
    })

    it("keeps dir-derived string origins conservative through aliases and comprehension mutations", async () => {
      await withWorkspace(async ({ worktree }) => {
        const aliasContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "names = dir(obj)\nalias = names\nalias.extend(other)\nname = names[0]\nname.lower()",
            args: [],
            description: "aliased dir mutation",
          },
          aliasContext,
        )
        expect(getAsk(aliasContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:name.lower"]))

        const compContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "names = dir(obj)\n[names.append(other) for _ in xs]\nname = names[0]\nname.lower()",
            args: [],
            description: "comprehension dir mutation",
          },
          compContext,
        )
        expect(getAsk(compContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:name.lower"]))
      })
    })

    it("skips python ask for defaultdict and homogeneous dict-value container locals", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from collections import defaultdict",
              "family_aliases = defaultdict(set)",
              "family_aliases[fam].add(call)",
              "inv = {'runtime': [], 'inline': []}",
              "inv[current].append(item)",
              "inv[current].pop()",
            ].join("\n"),
            args: [],
            description: "tracked container locals",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.permissionPatterns).toEqual([])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "collections.defaultdict", pattern: "pure:collections.defaultdict" }),
            expect.objectContaining({ kind: "pure", call: "family_aliases.add", pattern: "pure:family_aliases.add" }),
            expect.objectContaining({ kind: "pure", call: "inv.append", pattern: "pure:inv.append" }),
            expect.objectContaining({ kind: "pure", call: "inv.pop", pattern: "pure:inv.pop" }),
          ]),
        )
      })
    })

    it("keeps homogeneous dict-value container locals conservative when dict literals use splats", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "values = {'runtime': [], **other}\nvalues[current].append(item)",
            args: [],
            description: "dict value splat container locals",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:values.append"]))
      })
    })

    it("keeps shadowed re.compile helpers on the unknown ask path", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "import re\nre = object()\nre.compile('a+').search(text)",
            args: [],
            description: "shadowed re compile",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:re.compile", "unknown:callable:re.compile.search"]))
      })
    })

    it("skips python ask for pure-only ast helpers and keeps canonical pure metadata", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from ast import parse, dump, literal_eval",
              "tree = parse('x = 1')",
              "dump(tree)",
              "literal_eval('[1, 2, 3]')",
            ].join("\n"),
            args: [],
            description: "pure ast helpers",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.permissionPatterns).toEqual([])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "ast.parse", pattern: "pure:ast.parse" }),
            expect.objectContaining({ kind: "pure", call: "ast.dump", pattern: "pure:ast.dump" }),
            expect.objectContaining({ kind: "pure", call: "ast.literal_eval", pattern: "pure:ast.literal_eval" }),
          ]),
        )
      })
    })

    it("skips python ask for pure-only unittest.mock helpers and keeps pure metadata", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from unittest.mock import Mock, patch",
              "VALUE = 0",
              "mock = Mock(return_value='service')",
              "mock.assert_not_called()",
              "with patch('__main__.VALUE', 1):",
              "    pass",
            ].join("\n"),
            args: [],
            description: "pure mock helpers",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.permissionPatterns).toEqual([])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "unittest.mock.Mock", pattern: "pure:unittest.mock.Mock" }),
            expect.objectContaining({ kind: "pure", call: "mock.assert_not_called", pattern: "pure:mock.assert_not_called" }),
            expect.objectContaining({ kind: "pure", call: "unittest.mock.patch", pattern: "pure:unittest.mock.patch" }),
          ]),
        )
      })
    })

    it("skips python ask for pure-only datetime helpers and keeps tracked pure metadata", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from datetime import UTC, datetime, timedelta, timezone",
              "when = datetime.fromisoformat('2024-01-02T03:04:05+00:00')",
              "when.astimezone(UTC)",
              "delay = timedelta(seconds=30)",
              "seconds = delay.total_seconds()",
              "seconds.is_integer()",
              "label = timezone(timedelta(hours=2)).tzname(None)",
              "label.lower()",
              "UTC.tzname(None)",
            ].join("\n"),
            args: [],
            description: "pure datetime helpers",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.permissionPatterns).toEqual([])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "datetime.datetime.fromisoformat", pattern: "pure:datetime.datetime.fromisoformat" }),
            expect.objectContaining({ kind: "pure", call: "when.astimezone", pattern: "pure:when.astimezone" }),
            expect.objectContaining({ kind: "pure", call: "datetime.timedelta", pattern: "pure:datetime.timedelta" }),
            expect.objectContaining({ kind: "pure", call: "delay.total_seconds", pattern: "pure:delay.total_seconds" }),
            expect.objectContaining({ kind: "pure", call: "seconds.is_integer", pattern: "pure:seconds.is_integer" }),
            expect.objectContaining({ kind: "pure", call: "datetime.timezone", pattern: "pure:datetime.timezone" }),
            expect.objectContaining({ kind: "pure", call: "datetime.timezone.tzname", pattern: "pure:datetime.timezone.tzname" }),
            expect.objectContaining({ kind: "pure", call: "label.lower", pattern: "pure:label.lower" }),
            expect.objectContaining({ kind: "pure", call: "datetime.UTC.tzname", pattern: "pure:datetime.UTC.tzname" }),
          ]),
        )
      })
    })

    it("skips python ask for pure-only hashlib helpers and keeps tracked pure metadata", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import hashlib",
              "hashlib.sha256(b'x')",
              "digest = hashlib.sha256(b'y')",
              "digest.hexdigest()",
              "from hashlib import sha256",
              "sha256(b'z').digest()",
            ].join("\n"),
            args: [],
            description: "pure hashlib helpers",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.permissionPatterns).toEqual([])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "hashlib.sha256", pattern: "pure:hashlib.sha256" }),
            expect.objectContaining({ kind: "pure", call: "digest.hexdigest", pattern: "pure:digest.hexdigest" }),
            expect.objectContaining({ kind: "pure", call: "hashlib.sha256.digest", pattern: "pure:hashlib.sha256.digest" }),
          ]),
        )
      })
    })

    it("keeps shadowed module-root hashlib helpers on the unknown ask path", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "import hashlib\nhashlib = object()\nhashlib.sha256(b'x').hexdigest()",
            args: [],
            description: "shadowed hashlib root",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:hashlib.sha256", "unknown:callable:hashlib.sha256.hexdigest"]))
      })
    })

    it("keeps aliased shadowed hashlib helpers on the unknown ask path", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "import hashlib\nhashlib = object()\nalias = hashlib\nalias.sha256(b'x').hexdigest()",
            args: [],
            description: "shadowed hashlib alias",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:hashlib.sha256", "unknown:callable:hashlib.sha256.hexdigest"]))
      })
    })

    it("skips python ask for pure-only Counter helpers and keeps tracked pure metadata", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import collections",
              "counts = collections.Counter('aba')",
              "counts.most_common()",
              "counts.total()",
              "from collections import Counter",
              "Counter('abb').copy().most_common()",
            ].join("\n"),
            args: [],
            description: "pure counter helpers",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.permissionPatterns).toEqual([])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "collections.Counter", pattern: "pure:collections.Counter" }),
            expect.objectContaining({ kind: "pure", call: "counts.most_common", pattern: "pure:counts.most_common" }),
            expect.objectContaining({ kind: "pure", call: "counts.total", pattern: "pure:counts.total" }),
            expect.objectContaining({ kind: "pure", call: "collections.Counter.copy", pattern: "pure:collections.Counter.copy" }),
            expect.objectContaining({ kind: "pure", call: "collections.Counter.copy.most_common", pattern: "pure:collections.Counter.copy.most_common" }),
          ]),
        )
      })
    })

    it("keeps shadowed Counter module helpers on the unknown ask path", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "import collections\ncollections = object()\ncollections.Counter('aba').most_common()",
            args: [],
            description: "shadowed counter root",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:collections.Counter", "unknown:callable:collections.Counter.most_common"]))
      })
    })

    it("keeps captured Counter constructor names conservative after root rebinding", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "import collections\ncollections = object()\nctor = collections.Counter\nctor('aba').most_common()",
            args: [],
            description: "captured counter constructor",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:collections.Counter", "unknown:callable:collections.Counter.most_common"]))
      })
    })

    it("projects time and zoneinfo operations without unknown noise", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from time import strptime, time as now",
              "from zoneinfo import ZoneInfo",
              "stamp = now()",
              "stamp.is_integer()",
              "parts = strptime('30 Nov 00', '%d %b %y')",
              "parts.count(0)",
              "zone = ZoneInfo('UTC')",
              "zone.tzname(None)",
              "offset = zone.utcoffset(None)",
              "offset.total_seconds()",
            ].join("\n"),
            args: [],
            description: "time and zoneinfo projection",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["read:time.time", "read:zoneinfo.ZoneInfo"]))
        expect(ask?.patterns).not.toEqual(
          expect.arrayContaining([
            "unknown:callable:stamp.is_integer",
            "unknown:callable:parts.count",
            "unknown:callable:zone.tzname",
            "unknown:callable:offset.total_seconds",
          ]),
        )

        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "read", call: "time.time", pattern: "read:time.time" }),
            expect.objectContaining({ kind: "pure", call: "stamp.is_integer", pattern: "pure:stamp.is_integer" }),
            expect.objectContaining({ kind: "pure", call: "time.strptime", pattern: "pure:time.strptime" }),
            expect.objectContaining({ kind: "pure", call: "parts.count", pattern: "pure:parts.count" }),
            expect.objectContaining({ kind: "read", call: "zoneinfo.ZoneInfo", pattern: "read:zoneinfo.ZoneInfo" }),
            expect.objectContaining({ kind: "pure", call: "zone.tzname", pattern: "pure:zone.tzname" }),
            expect.objectContaining({ kind: "pure", call: "zone.utcoffset", pattern: "pure:zone.utcoffset" }),
            expect.objectContaining({ kind: "pure", call: "offset.total_seconds", pattern: "pure:offset.total_seconds" }),
          ]),
        )
      })
    })

    it("projects calendar and os.path operations without unknown noise", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from calendar import SUNDAY, firstweekday, month, monthcalendar, setfirstweekday",
              "from os.path import basename, exists, splitext",
              "exists('notes.txt')",
              "firstweekday()",
              "setfirstweekday(SUNDAY)",
              "text = month(2024, 1)",
              "text.splitlines()",
              "weeks = monthcalendar(2024, 1)",
              "weeks.count([])",
              "name = basename('docs/readme.md')",
              "name.lower()",
              "parts = splitext('docs/readme.md')",
              "parts.count('')",
            ].join("\n"),
            args: [],
            description: "calendar and os.path projection",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["write:calendar.setfirstweekday"]))
        expect(ask?.patterns).not.toEqual(
          expect.arrayContaining([
            "unknown:callable:text.splitlines",
            "unknown:callable:weeks.count",
            "unknown:callable:name.lower",
            "unknown:callable:parts.count",
          ]),
        )

        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "read", call: "os.path.exists", path: toSlash(path.join(worktree, "notes.txt")) }),
            expect.objectContaining({ kind: "read", call: "calendar.firstweekday", pattern: "read:calendar.firstweekday" }),
            expect.objectContaining({ kind: "write", call: "calendar.setfirstweekday", pattern: "write:calendar.setfirstweekday" }),
            expect.objectContaining({ kind: "pure", call: "calendar.month", pattern: "pure:calendar.month" }),
            expect.objectContaining({ kind: "pure", call: "text.splitlines", pattern: "pure:text.splitlines" }),
            expect.objectContaining({ kind: "pure", call: "calendar.monthcalendar", pattern: "pure:calendar.monthcalendar" }),
            expect.objectContaining({ kind: "pure", call: "weeks.count", pattern: "pure:weeks.count" }),
            expect.objectContaining({ kind: "pure", call: "os.path.basename", pattern: "pure:os.path.basename" }),
            expect.objectContaining({ kind: "pure", call: "name.lower", pattern: "pure:name.lower" }),
            expect.objectContaining({ kind: "pure", call: "os.path.splitext", pattern: "pure:os.path.splitext" }),
            expect.objectContaining({ kind: "pure", call: "parts.count", pattern: "pure:parts.count" }),
          ]),
        )
      })
    })

    describe("phase 1 runtime parity smoke fixtures", () => {
      it("preserves tracked path and guarded metadata projection", async () => {
        const result = await collectInlinePermissionParity(
          ["from pathlib import Path", "home = Path.home()", "home.read_text()", "obj.group(1)"].join("\n"),
        )

        expect(result.ask?.patterns).toEqual(["read:<dynamic>", "unknown:callable:obj.group"])
        expect(result.ask?.always).toEqual(["read:*", "unknown:callable:obj.group"])
        expect(result.metadata?.permissionPatterns).toEqual(["read:<dynamic>", "unknown:callable:obj.group"])
        expect(result.metadata?.permissionAlways).toEqual(["read:*", "unknown:callable:obj.group"])
        expect(result.metadata?.operations).toEqual([
          {
            kind: "pure",
            call: "pathlib.Path.home",
            pattern: "pure:pathlib.Path.home",
            always: "pure:pathlib.*",
            canonicalSource: "pathlib.Path.home",
          },
          {
            kind: "read",
            call: "home.read_text",
            pattern: "read:<dynamic>",
            always: "read:*",
            canonicalSource: "pathlib.Path.read_text",
            receiverKind: "path",
            ruleHit: "guarded-method:read_text",
          },
          {
            kind: "unknown",
            call: "callable:obj.group",
            pattern: "unknown:callable:obj.group",
            always: "unknown:callable:obj.group",
            canonicalSource: "callable:obj.group",
            ruleHit: "guarded-method:group",
            guardFailure: {
              type: "receiverKindIn",
              detail: "expected=path actual=none",
            },
          },
        ])
      })

      it("preserves direct-import HTTP projection", async () => {
        const result = await collectInlinePermissionParity(
          [
            "from requests import request",
            "from httpx import request as http_request",
            "request('GET', 'https://example.com/a')",
            "http_request('HEAD', 'https://example.com/b')",
          ].join("\n"),
        )

        expect(result.ask?.patterns).toEqual(["read:requests.get", "read:httpx.head"])
        expect(result.ask?.always).toEqual(["read:requests.*", "read:httpx.*"])
        expect(result.metadata?.permissionPatterns).toEqual(["read:requests.get", "read:httpx.head"])
        expect(result.metadata?.permissionAlways).toEqual(["read:requests.*", "read:httpx.*"])
        expect(result.metadata?.operations).toEqual([
          {
            kind: "read",
            call: "requests.get",
            pattern: "read:requests.get",
            always: "read:requests.*",
            canonicalSource: "requests.get",
            ruleHit: "guarded-call:requests.request",
          },
          {
            kind: "read",
            call: "httpx.head",
            pattern: "read:httpx.head",
            always: "read:httpx.*",
            canonicalSource: "httpx.head",
            ruleHit: "guarded-call:httpx.request",
          },
        ])
      })

      it("preserves assignment invalidation projection", async () => {
        const result = await collectInlinePermissionParity(
          [
            "import requests",
            "client = requests.Session()",
            "client.get('https://example.com/a')",
            "client = obj",
            "client.get('https://example.com/b')",
          ].join("\n"),
        )

        expect(result.ask?.patterns).toEqual(["exec:requests.Session", "read:requests.Session.get", "unknown:callable:obj.get"])
        expect(result.ask?.always).toEqual(["exec:requests.*", "read:requests.*", "unknown:callable:obj.get"])
        expect(result.metadata?.permissionPatterns).toEqual([
          "exec:requests.Session",
          "read:requests.Session.get",
          "unknown:callable:obj.get",
        ])
        expect(result.metadata?.permissionAlways).toEqual(["exec:requests.*", "read:requests.*", "unknown:callable:obj.get"])
        expect(result.metadata?.operations).toEqual([
          {
            kind: "exec",
            call: "requests.Session",
            pattern: "exec:requests.Session",
            always: "exec:requests.*",
            canonicalSource: "requests.Session",
          },
          {
            kind: "read",
            call: "requests.Session.get",
            pattern: "read:requests.Session.get",
            always: "read:requests.*",
            canonicalSource: "requests.Session.get",
          },
          {
            kind: "unknown",
            call: "callable:obj.get",
            pattern: "unknown:callable:obj.get",
            always: "unknown:callable:obj.get",
            canonicalSource: "callable:obj.get",
          },
        ])
      })

      it("preserves parse-error projection", async () => {
        const result = await collectInlinePermissionParity("def broken(")

        expect(result.ask?.patterns).toEqual(["unknown:parse-error"])
        expect(result.ask?.always).toEqual(["unknown:*"])
        expect(result.metadata?.permissionPatterns).toEqual(["unknown:parse-error"])
        expect(result.metadata?.permissionAlways).toEqual(["unknown:*"])
        expect(result.metadata?.operations).toEqual([
          {
            kind: "unknown",
            call: "parse-error",
            pattern: "unknown:parse-error",
            always: "unknown:*",
            canonicalSource: "parse-error",
          },
        ])
      })

      it("preserves no-calls-detected projection", async () => {
        const result = await collectInlinePermissionParity("value = 1 + 1")

        expect(result.ask?.patterns).toEqual(["unknown:no-calls-detected"])
        expect(result.ask?.always).toEqual(["unknown:*"])
        expect(result.metadata?.permissionPatterns).toEqual(["unknown:no-calls-detected"])
        expect(result.metadata?.permissionAlways).toEqual(["unknown:*"])
        expect(result.metadata?.operations).toEqual([
          {
            kind: "unknown",
            call: "no-calls-detected",
            pattern: "unknown:no-calls-detected",
            always: "unknown:*",
            canonicalSource: "no-calls-detected",
          },
        ])
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

  })
})
