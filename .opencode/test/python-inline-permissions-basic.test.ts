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

    it("skips python ask for iterated regex match result methods and keeps iterator receivers conservative", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import re",
              "for m in re.finditer('a+', text):",
              "    m.start()",
              "    m.end()",
              "pat = re.compile('a+')",
              "matches = pat.finditer(text)",
              "for m in matches:",
              "    m.start()",
              "    m.end()",
              "matches.start()",
            ].join("\n"),
            args: [],
            description: "iterated regex match results",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:matches.start"]))
        expect(ask?.patterns).not.toEqual(expect.arrayContaining(["unknown:callable:m.start", "unknown:callable:m.end"]))
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "re.finditer", pattern: "pure:re.finditer" }),
            expect.objectContaining({ kind: "pure", call: "m.start", pattern: "pure:m.start" }),
            expect.objectContaining({ kind: "pure", call: "m.end", pattern: "pure:m.end" }),
            expect.objectContaining({ kind: "unknown", call: "callable:matches.start", pattern: "unknown:callable:matches.start" }),
          ]),
        )
      })
    })

    it("skips python ask for direct regex list locals and keeps shadowed roots conservative", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import re",
              "names = re.findall('describe', text)",
              "names.count('describe')",
              "parts = re.split(':', text)",
              "parts.count('')",
            ].join("\n"),
            args: [],
            description: "direct regex list locals",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.permissionPatterns).toEqual([])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "re.findall", pattern: "pure:re.findall" }),
            expect.objectContaining({ kind: "pure", call: "names.count", pattern: "pure:names.count" }),
            expect.objectContaining({ kind: "pure", call: "re.split", pattern: "pure:re.split" }),
            expect.objectContaining({ kind: "pure", call: "parts.count", pattern: "pure:parts.count" }),
          ]),
        )

        const shadowedContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: [
              "import re",
              "re = fake",
              "names = re.findall('describe', text)",
              "names.count('describe')",
            ].join("\n"),
            args: [],
            description: "shadowed direct regex list locals",
          },
          shadowedContext,
        )

        expect(getAsk(shadowedContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:names.count"]))
      })
    })

    it("keeps re.sub itself unknown by default but tracks non-callable replacement string results", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import re",
              "text = 'aaTITLEbb'",
              "re.sub('a+', '-', text)",
              "sec = re.sub('a+', '-', text)",
              "sec.split('TITLE').count('')",
              "re.sub('a+', '-', text).split('TITLE').count('')",
            ].join("\n"),
            args: [],
            description: "re.sub string producer",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:re.sub"]))
        expect(ask?.patterns).not.toEqual(expect.arrayContaining(["unknown:callable:sec.split", "unknown:callable:re.sub.split"]))

        const callableContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: [
              "import re",
              "text = 'aaTITLEbb'",
              "def repl(m):",
              "    return '-'",
              "sec = re.sub('a+', repl, text)",
              "sec.split('TITLE').count('')",
            ].join("\n"),
            args: [],
            description: "re.sub callable replacement",
          },
          callableContext,
        )

        expect(getAsk(callableContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:sec.split"]))
      })
    })

    it("skips python ask for direct regex split iterated string locals and keeps shadowed roots conservative", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import re",
              "sections = re.split('TITLE', text)",
              "for sec in sections[1:]:",
              "    sec.split(')').count('')",
            ].join("\n"),
            args: [],
            description: "direct regex split iterated strings",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()

        const shadowedContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: [
              "import re",
              "re = fake",
              "sections = re.split('TITLE', text)",
              "for sec in sections[1:]:",
              "    sec.split(')').count('')",
            ].join("\n"),
            args: [],
            description: "shadowed direct regex split iterated strings",
          },
          shadowedContext,
        )

        expect(getAsk(shadowedContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:sec.split"]))
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

    it("skips python ask for same-scope lambda helper params seeded from trusted string iterables", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "entries = ['x:1', 'x:2']",
              "leaf = lambda entries: [e.split(':')[-1] for e in entries if e.startswith('x')]",
              "leaf(entries)",
            ].join("\n"),
            args: [],
            description: "lambda helper param string provenance",
          },
          context,
        )

        expect(getAsk(context, "python")?.patterns).toEqual(["unknown:callable:leaf"])
      })
    })

    it("keeps same-scope lambda helper params conservative when callsites disagree", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "entries = ['x:1']",
              "other = values",
              "leaf = lambda entries: [e.split(':')[-1] for e in entries if e.startswith('x')]",
              "leaf(entries)",
              "leaf(other)",
            ].join("\n"),
            args: [],
            description: "mixed lambda helper param provenance",
          },
          context,
        )

        expect(getAsk(context, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith"]))
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

    it("skips python ask for mutation-built receiver-path string lists when the builder stays homogeneous", async () => {
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
        expect(ask?.patterns).toEqual(["unknown:callable:leaf"])
        expect(context.metadatas[0]?.metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "e.split", pattern: "pure:e.split" }),
            expect.objectContaining({ kind: "pure", call: "e.startswith", pattern: "pure:e.startswith" }),
          ]),
        )
      })
    })

    it("skips python ask for mutation-built receiver-path string lists when extend carries trusted strings", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from pathlib import Path",
              "inv = {}",
              "current = 'runtime'",
              "inv[current] = []",
              "inv[current].extend(Path('f').read_text().splitlines())",
              "def leaf(entries):",
              "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
              "leaf(inv[current])",
            ].join("\n"),
            args: [],
            description: "receiver path helper string provenance by extend",
          },
          context,
        )

        expect(getAsk(context, "python")?.patterns).toEqual(["unknown:callable:leaf"])
      })
    })

    it("skips python ask for value-equivalent dynamic-to-literal dict subscript builders", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "current = 'python.test.ts'",
              "inv[current] = []",
              "inv[current].append('x -> title')",
              "result = [e.split(' -> ')[-1] for e in inv['python.test.ts'] if e.startswith('x')]",
            ].join("\n"),
            args: [],
            description: "dict value string provenance by trusted append",
          },
          context,
        )

        expect(getAsk(context, "python")?.patterns).toBeUndefined()
      })
    })

    it("skips python ask for direct iteration over exact dynamic dict subscript builders", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "current = 'python.test.ts'",
              "inv[current] = []",
              "inv[current].append('x -> title')",
              "inv[current].append('x -> body')",
              "result = [e.split(' -> ')[-1] for e in inv[current] if e.startswith('x')]",
            ].join("\n"),
            args: [],
            description: "exact dynamic dict subscript string provenance",
          },
          context,
        )

        expect(getAsk(context, "python")?.patterns).toBeUndefined()
      })
    })

    it("skips python ask for direct iteration over exact literal dict subscript builders", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "inv['python.test.ts'] = []",
              "inv['python.test.ts'].append('x -> title')",
              "result = [e.split(' -> ')[-1] for e in inv['python.test.ts'] if e.startswith('x')]",
            ].join("\n"),
            args: [],
            description: "exact literal dict subscript string provenance",
          },
          context,
        )

        expect(getAsk(context, "python")?.patterns).toBeUndefined()
      })
    })

    it("skips python ask for keys derived from exact split/strip string values", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "line = 'FILE python.test.ts'",
              "current = line.split('FILE ', 1)[1].strip()",
              "inv = {}",
              "inv['python.test.ts'] = []",
              "inv['python.test.ts'].append('x -> title')",
              "result = [e.split(' -> ')[-1] for e in inv[current] if e.startswith('x')]",
            ].join("\n"),
            args: [],
            description: "exact split strip key derivation",
          },
          context,
        )

        expect(getAsk(context, "python")?.patterns).toBeUndefined()
      })
    })

    it("skips python ask for keys derived from iterated exact literal lines", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "for line in ['FILE python.test.ts']:",
              "    current = line.split('FILE ', 1)[1].strip()",
              "    inv[current] = []",
              "    inv[current].append('x -> title')",
              "result = [e.split(' -> ')[-1] for e in inv['python.test.ts'] if e.startswith('x')]",
            ].join("\n"),
            args: [],
            description: "iterated exact literal line key derivation",
          },
          context,
        )

        expect(getAsk(context, "python")?.patterns).toBeUndefined()
      })
    })

    it("skips python ask for keys derived from exact literal lines under startswith branch narrowing", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "for line in ['FILE python.test.ts', '- x -> title']:",
              "    if line.startswith('FILE '):",
              "        current = line.split('FILE ', 1)[1].strip()",
              "        inv[current] = []",
              "    elif current and line.startswith('- '):",
              "        inv[current].append(line[2:])",
              "result = [e.split(' -> ')[-1] for e in inv['python.test.ts'] if e.startswith('x')]",
            ].join("\n"),
            args: [],
            description: "mixed iterated literal line key derivation",
          },
          context,
        )

        expect(getAsk(context, "python")?.patterns).toBeUndefined()
      })
    })

    it("skips python ask for keys derived from exact variable prefixes under startswith branch narrowing", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "prefix = 'FILE '",
              "for line in ['FILE python.test.ts', '- x -> title']:",
              "    if line.startswith(prefix):",
              "        current = line.split(prefix, 1)[1].strip()",
              "        inv[current] = []",
              "    elif current and line.startswith('- '):",
              "        inv[current].append(line[2:])",
              "result = [e.split(' -> ')[-1] for e in inv['python.test.ts'] if e.startswith('x')]",
            ].join("\n"),
            args: [],
            description: "startswith variable prefix narrowing",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
      })
    })

    it("keeps keys derived from dynamic-origin mixed lines conservative without value narrowing", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from pathlib import Path",
              "inv = {}",
              "current = None",
              "for line in Path('snapshot.txt').read_text().splitlines():",
              "    if line.startswith('FILE '):",
              "        current = line.split('FILE ', 1)[1].strip()",
              "        inv[current] = []",
              "    elif current and line.startswith('- '):",
              "        inv[current].append(line[2:])",
              "result = [e.split(' -> ')[-1] for e in inv['python.test.ts'] if e.startswith('x')]",
            ].join("\n"),
            args: [],
            description: "dynamic mixed line key derivation",
          },
          context,
        )

        expect(getAsk(context, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith"]))
      })
    })

    it("skips python ask for value-equivalent literal-to-dynamic dict subscript builders and exact insert builders", async () => {
      await withWorkspace(async ({ worktree }) => {
        const equivalentContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "inv['python.test.ts'] = []",
              "current = 'python.test.ts'",
              "inv['python.test.ts'].append('x -> title')",
              "result = [e.split(' -> ')[-1] for e in inv[current] if e.startswith('x')]",
            ].join("\n"),
            args: [],
            description: "literal builder dynamic read equivalence",
          },
          equivalentContext,
        )

        expect(getAsk(equivalentContext, "python")?.patterns).toBeUndefined()

        const mismatchContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "current = 'python.test.ts'",
              "inv[current] = []",
              "inv[current].append('x -> title')",
              "result = [e.split(' -> ')[-1] for e in inv['python-runtime-execution.test.ts'] if e.startswith('x')]",
            ].join("\n"),
            args: [],
            description: "dynamic builder literal read mismatch",
          },
          mismatchContext,
        )

        expect(getAsk(mismatchContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith"]))

        const insertContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "current = 'python.test.ts'",
              "inv[current] = []",
              "inv[current].insert(0, 'x -> title')",
              "result = [e.split(' -> ')[-1] for e in inv[current] if e.startswith('x')]",
            ].join("\n"),
            args: [],
            description: "exact dynamic dict insert provenance",
          },
          insertContext,
        )

        expect(getAsk(insertContext, "python")?.patterns).toBeUndefined()
      })
    })

    it("skips python ask for value-equivalent literal dict list values", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {'python-runtime-execution.test.ts': [], 'python.test.ts': []}",
              "current = 'python.test.ts'",
              "inv[current].append('x -> title')",
              "result = [e.split(' -> ')[-1] for e in inv['python.test.ts'] if e.startswith('x')]",
            ].join("\n"),
            args: [],
            description: "literal dict string provenance by trusted append",
          },
          context,
        )

        expect(getAsk(context, "python")?.patterns).toBeUndefined()
      })
    })

    it("preserves value-equivalent dict list proofs across different known sibling keys", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {'a': [], 'b': []}",
              "inv['a'].append('x -> title')",
              "inv['b'].append(other)",
              "result = [e.split(' -> ')[-1] for e in inv['a'] if e.startswith('x')]",
            ].join("\n"),
            args: [],
            description: "literal dict sibling mutation string provenance",
          },
          context,
        )

        expect(getAsk(context, "python")?.patterns).toBeUndefined()
      })
    })

    it("keeps exact direct dict subscript builders conservative after key rebinding and non-helper escapes", async () => {
      await withWorkspace(async ({ worktree }) => {
        const reboundContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "current = 'python.test.ts'",
              "inv[current] = []",
              "inv[current].append('x -> title')",
              "current = other_key",
              "result = [e.split(' -> ')[-1] for e in inv[current] if e.startswith('x')]",
            ].join("\n"),
            args: [],
            description: "exact dynamic dict rebinding",
          },
          reboundContext,
        )

        expect(getAsk(reboundContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith"]))

        const escapedContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "current = 'python.test.ts'",
              "inv[current] = []",
              "inv[current].append('x -> title')",
              "other(inv[current])",
              "result = [e.split(' -> ')[-1] for e in inv[current] if e.startswith('x')]",
            ].join("\n"),
            args: [],
            description: "exact dynamic dict escape",
          },
          escapedContext,
        )

        expect(getAsk(escapedContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith"]))
      })
    })

    it("keeps direct exact-path dict reads conservative under dep shadowing and alias-root rebinding", async () => {
      await withWorkspace(async ({ worktree }) => {
        const shadowedContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "current = 'python.test.ts'",
              "inv[current] = []",
              "inv[current].append('x -> title')",
              "def outer(current):",
              "    return [e.split(' -> ')[-1] for e in inv[current] if e.startswith('x')]",
              "outer(other_key)",
            ].join("\n"),
            args: [],
            description: "exact dynamic dict param shadowing",
          },
          shadowedContext,
        )

        expect(getAsk(shadowedContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith", "unknown:callable:outer"]))

        const aliasRootContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "bucket = inv",
              "current = 'python.test.ts'",
              "bucket[current] = []",
              "bucket[current].append('x -> title')",
              "inv = other_map",
              "result = [e.split(' -> ')[-1] for e in inv[current] if e.startswith('x')]",
            ].join("\n"),
            args: [],
            description: "exact dynamic dict alias root rebinding",
          },
          aliasRootContext,
        )

        expect(getAsk(aliasRootContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith"]))
      })
    })

    it("keeps value-equivalent dict reads conservative when inner scopes shadow alias roots during same-root mutation", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "bucket = inv",
              "current = 'python.test.ts'",
              "bucket[current] = []",
              "bucket[current].append('x -> title')",
              "def clobber(bucket):",
              "    inv['python.test.ts'].append(other_value)",
              "clobber(other_map)",
              "result = [e.split(' -> ')[-1] for e in bucket['python.test.ts'] if e.startswith('x')]",
            ].join("\n"),
            args: [],
            description: "inner alias shadow same-root mutation",
          },
          context,
        )

        expect(getAsk(context, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith", "unknown:callable:clobber"]))
      })
    })

    it("keeps raw alias-root exact-path reads conservative after subscript-to-identifier escapes mutate", async () => {
      await withWorkspace(async ({ worktree }) => {
        const appendContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "bucket = inv",
              "current = 'python.test.ts'",
              "bucket[current] = []",
              "bucket[current].append('x -> title')",
              "alias = bucket[current]",
              "alias.append(other_value)",
              "result = [e.split(' -> ')[-1] for e in bucket[current] if e.startswith('x')]",
            ].join("\n"),
            args: [],
            description: "raw alias root append escape",
          },
          appendContext,
        )

        expect(getAsk(appendContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith"]))

        const indexContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "bucket = inv",
              "current = 'python.test.ts'",
              "bucket[current] = []",
              "bucket[current].append('x -> title')",
              "alias = bucket[current]",
              "alias[0] = other_value",
              "result = [e.split(' -> ')[-1] for e in bucket[current] if e.startswith('x')]",
            ].join("\n"),
            args: [],
            description: "raw alias root indexed escape",
          },
          indexContext,
        )

        expect(getAsk(indexContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith"]))
      })
    })

    it("keeps direct exact-path dict reads conservative after same-root alternate-key mutations", async () => {
      await withWorkspace(async ({ worktree }) => {
        const variableAliasContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "current = 'python.test.ts'",
              "other = current",
              "inv[current] = []",
              "inv[current].append('x -> title')",
              "inv[other].append(other_value)",
              "result = [e.split(' -> ')[-1] for e in inv[current] if e.startswith('x')]",
            ].join("\n"),
            args: [],
            description: "alternate key mutation via variable alias",
          },
          variableAliasContext,
        )

        expect(getAsk(variableAliasContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith"]))

        const literalAliasContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "alias = 'python.test.ts'",
              "inv['python.test.ts'] = []",
              "inv['python.test.ts'].append('x -> title')",
              "inv[alias].insert(0, other_value)",
              "result = [e.split(' -> ')[-1] for e in inv['python.test.ts'] if e.startswith('x')]",
            ].join("\n"),
            args: [],
            description: "alternate key mutation via literal alias",
          },
          literalAliasContext,
        )

        expect(getAsk(literalAliasContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith"]))

        const reassignedContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "current = 'python.test.ts'",
              "other = current",
              "inv[current] = []",
              "inv[current].append('x -> title')",
              "inv[other] = [other_value]",
              "result = [e.split(' -> ')[-1] for e in inv[current] if e.startswith('x')]",
            ].join("\n"),
            args: [],
            description: "alternate key reassignment invalidation",
          },
          reassignedContext,
        )

        expect(getAsk(reassignedContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith"]))

        const mixedRootContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "bucket = inv",
              "current = 'python.test.ts'",
              "other = current",
              "bucket[current] = []",
              "bucket[current].append('x -> title')",
              "inv[other].append(other_value)",
              "result = [e.split(' -> ')[-1] for e in bucket[current] if e.startswith('x')]",
            ].join("\n"),
            args: [],
            description: "mixed root alternate key invalidation",
          },
          mixedRootContext,
        )

        expect(getAsk(mixedRootContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith"]))
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

    it("keeps mutation-built receiver-path string lists conservative after non-helper escape calls", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "current = 'runtime'",
              "inv[current] = []",
              "inv[current].append('x:1')",
              "other(inv[current])",
              "def leaf(entries):",
              "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
              "leaf(inv[current])",
            ].join("\n"),
            args: [],
            description: "receiver path helper non-helper escape",
          },
          context,
        )

        expect(getAsk(context, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith", "unknown:callable:leaf"]))
      })
    })

    it("keeps mutation-built receiver-path aliases conservative after the base path mutates", async () => {
      await withWorkspace(async ({ worktree }) => {
        const appendContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "current = 'runtime'",
              "inv[current] = []",
              "inv[current].append('x:1')",
              "bucket = inv[current]",
              "inv[current].append(other)",
              "def leaf(entries):",
              "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
              "leaf(bucket)",
            ].join("\n"),
            args: [],
            description: "receiver path alias base append mutation",
          },
          appendContext,
        )

        expect(getAsk(appendContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith", "unknown:callable:leaf"]))

        const indexContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "current = 'runtime'",
              "inv[current] = []",
              "inv[current].append('x:1')",
              "bucket = inv[current]",
              "inv[current][0] = other",
              "def leaf(entries):",
              "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
              "leaf(bucket)",
            ].join("\n"),
            args: [],
            description: "receiver path alias base indexed mutation",
          },
          indexContext,
        )

        expect(getAsk(indexContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith", "unknown:callable:leaf"]))
      })
    })

    it("keeps exact receiver-path helper seeds conservative after key rebinding and never-called inner builders", async () => {
      await withWorkspace(async ({ worktree }) => {
        const reboundContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "current = 'runtime'",
              "inv[current] = []",
              "inv[current].append('x:1')",
              "current = other_key",
              "def leaf(entries):",
              "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
              "leaf(inv[current])",
            ].join("\n"),
            args: [],
            description: "receiver path key rebinding",
          },
          reboundContext,
        )

        expect(getAsk(reboundContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith", "unknown:callable:leaf"]))

        const nestedContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "current = 'runtime'",
              "def build():",
              "    inv[current] = []",
              "    inv[current].append('x:1')",
              "def leaf(entries):",
              "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
              "leaf(inv[current])",
            ].join("\n"),
            args: [],
            description: "receiver path nested builder",
          },
          nestedContext,
        )

        expect(getAsk(nestedContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith", "unknown:callable:leaf"]))
      })
    })

    it("keeps exact receiver-path helper seeds conservative when key deps are shadowed by params", async () => {
      await withWorkspace(async ({ worktree }) => {
        const defContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "current = 'runtime'",
              "inv[current] = []",
              "inv[current].append('x:1')",
              "def outer(current):",
              "    def leaf(entries):",
              "        return [e.split(':')[-1] for e in entries if e.startswith('x')]",
              "    return leaf(inv[current])",
              "outer(other_key)",
            ].join("\n"),
            args: [],
            description: "receiver path param shadow def helper",
          },
          defContext,
        )

        expect(getAsk(defContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith", "unknown:callable:leaf", "unknown:callable:outer"]))

        const lambdaContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "inv = {}",
              "current = 'runtime'",
              "inv[current] = []",
              "inv[current].append('x:1')",
              "def outer(current):",
              "    leaf = lambda entries: [e.split(':')[-1] for e in entries if e.startswith('x')]",
              "    return leaf(inv[current])",
              "outer(other_key)",
            ].join("\n"),
            args: [],
            description: "receiver path param shadow lambda helper",
          },
          lambdaContext,
        )

        expect(getAsk(lambdaContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:e.split", "unknown:callable:e.startswith", "unknown:callable:leaf", "unknown:callable:outer"]))
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

    it("skips python ask for exact string-key dict items destructuring and keeps mixed keys conservative", async () => {
      await withWorkspace(async ({ worktree }) => {
        const positiveContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import datetime as dt",
              "samples = {",
              "    ' date': dt.date(2024, 1, 2),",
              "    ' datetime': dt.datetime(2024, 1, 2, 3, 4, 5, tzinfo=dt.timezone.utc),",
              "}",
              "for label, obj in samples.items():",
              "    print(label.strip())",
            ].join("\n"),
            args: [],
            description: "string-key dict items label strip",
          },
          positiveContext,
        )

        expect(getAsk(positiveContext, "python")).toBeUndefined()
        const positiveMetadata = positiveContext.metadatas[0]?.metadata
        expect(positiveMetadata?.permissionPatterns).toEqual([])
        expect(positiveMetadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "label.strip", pattern: "pure:label.strip" }),
            expect.objectContaining({ kind: "emit", call: "print", pattern: "emit:print" }),
          ]),
        )

        const mixedKeyContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "samples = {' date': 1, 2: 3}\nfor label, obj in samples.items():\n    label.strip()",
            args: [],
            description: "mixed-key dict items label strip",
          },
          mixedKeyContext,
        )
        expect(getAsk(mixedKeyContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:label.strip"]))

        const mutatedContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "samples = {' date': 1, ' datetime': 2}\nsamples[1] = 3\nfor label, obj in samples.items():\n    label.strip()",
            args: [],
            description: "mutated dict items label strip",
          },
          mutatedContext,
        )
        expect(getAsk(mutatedContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:label.strip"]))

        const updatedContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "samples = {' date': 1, ' datetime': 2}\nsamples.update({1: 3})\nfor label, obj in samples.items():\n    label.strip()",
            args: [],
            description: "updated dict items label strip",
          },
          updatedContext,
        )
        expect(getAsk(updatedContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:label.strip"]))

        const setdefaultContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "samples = {' date': 1, ' datetime': 2}\nsamples.setdefault(1, 3)\nfor label, obj in samples.items():\n    label.strip()",
            args: [],
            description: "setdefault dict items label strip",
          },
          setdefaultContext,
        )
        expect(getAsk(setdefaultContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:label.strip"]))

        const splatContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "samples = {**other, ' date': 1}\nfor label, obj in samples.items():\n    label.strip()",
            args: [],
            description: "splat dict items label strip",
          },
          splatContext,
        )
        expect(getAsk(splatContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:label.strip"]))

        const dictUpdateContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "samples = {' date': 1, ' datetime': 2}\ndict.update(samples, {1: 3})\nfor label, obj in samples.items():\n    label.strip()",
            args: [],
            description: "dict.update label strip",
          },
          dictUpdateContext,
        )
        expect(getAsk(dictUpdateContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:label.strip"]))

        const boundUpdateContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "samples = {' date': 1, ' datetime': 2}\nupd = samples.update\nupd({1: 3})\nfor label, obj in samples.items():\n    label.strip()",
            args: [],
            description: "bound update label strip",
          },
          boundUpdateContext,
        )
        expect(getAsk(boundUpdateContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:label.strip"]))
      })
    })

    it("skips python ask for trusted direct-imported client __mro__ module metadata and keeps negatives conservative", async () => {
      await withWorkspace(async ({ worktree }) => {
        const positiveContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from msgraph import GraphServiceClient",
              "for cls in GraphServiceClient.__mro__:",
              "    cls.__module__.startswith('msgraph')",
            ].join("\n"),
            args: [],
            description: "class mro module metadata",
          },
          positiveContext,
        )

        expect(getAsk(positiveContext, "python")).toBeUndefined()
        const positiveMetadata = positiveContext.metadatas[0]?.metadata
        expect(positiveMetadata?.permissionPatterns).toEqual([])
        expect(positiveMetadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "cls.__module__.startswith", pattern: "pure:cls.__module__.startswith" }),
          ]),
        )

        const negativeContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from msgraph import GraphServiceClient",
              "GraphServiceClient = object()",
              "for cls in GraphServiceClient.__mro__:",
              "    cls.__module__.startswith('msgraph')",
            ].join("\n"),
            args: [],
            description: "shadowed class mro module metadata",
          },
          negativeContext,
        )

        const ask = getAsk(negativeContext, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:cls.__module__.startswith"]))

        const reboundLoopContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from msgraph import GraphServiceClient",
              "for cls in GraphServiceClient.__mro__:",
              "    cls = object()",
              "    cls.__module__.startswith('msgraph')",
            ].join("\n"),
            args: [],
            description: "rebound loop class metadata",
          },
          reboundLoopContext,
        )

        expect(getAsk(reboundLoopContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:cls.__module__.startswith"]))

        const nonClassContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from typing import TypeGuard as GraphServiceClient",
              "for cls in GraphServiceClient.__mro__:",
              "    cls.__module__.startswith('msgraph')",
            ].join("\n"),
            args: [],
            description: "non-class class-like alias mro metadata",
          },
          nonClassContext,
        )

        expect(getAsk(nonClassContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:cls.__module__.startswith"]))

        const uppercaseConstantContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from unittest.mock import ANY as GraphServiceClient",
              "for cls in GraphServiceClient.__mro__:",
              "    cls.__module__.startswith('msgraph')",
            ].join("\n"),
            args: [],
            description: "uppercase non-class alias mro metadata",
          },
          uppercaseConstantContext,
        )

        expect(getAsk(uppercaseConstantContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:cls.__module__.startswith"]))

        const wrongModuleContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from fake_sdk import GraphServiceClient",
              "for cls in GraphServiceClient.__mro__:",
              "    cls.__module__.startswith('msgraph')",
            ].join("\n"),
            args: [],
            description: "wrong-module client mro metadata",
          },
          wrongModuleContext,
        )

        expect(getAsk(wrongModuleContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:cls.__module__.startswith"]))

        const directAssignmentContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from msgraph import GraphServiceClient",
              "for cls in GraphServiceClient.__mro__:",
              "    cls.__module__ = 0",
              "    cls.__module__.startswith('msgraph')",
            ].join("\n"),
            args: [],
            description: "assigned class module metadata",
          },
          directAssignmentContext,
        )

        expect(getAsk(directAssignmentContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:cls.__module__.startswith"]))

        const setattrContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from msgraph import GraphServiceClient",
              "for cls in GraphServiceClient.__mro__:",
              "    setattr(cls, '__module__', 0)",
              "    cls.__module__.startswith('msgraph')",
            ].join("\n"),
            args: [],
            description: "rebound class module metadata",
          },
          setattrContext,
        )

        expect(getAsk(setattrContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:cls.__module__.startswith"]))

        const aliasAssignmentContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from msgraph import GraphServiceClient",
              "for cls in GraphServiceClient.__mro__:",
              "    alias = cls",
              "    alias.__module__ = 0",
              "    cls.__module__.startswith('msgraph')",
            ].join("\n"),
            args: [],
            description: "aliased assigned class module metadata",
          },
          aliasAssignmentContext,
        )

        expect(getAsk(aliasAssignmentContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:cls.__module__.startswith"]))

        const aliasSetattrContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from msgraph import GraphServiceClient",
              "for cls in GraphServiceClient.__mro__:",
              "    alias = cls",
              "    setattr(alias, '__module__', 0)",
              "    cls.__module__.startswith('msgraph')",
            ].join("\n"),
            args: [],
            description: "aliased rebound class module metadata",
          },
          aliasSetattrContext,
        )

        expect(getAsk(aliasSetattrContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:cls.__module__.startswith"]))
      })
    })

    it("skips python ask for exact imported CreateClusterDetails metadata lookups and keeps negatives conservative", async () => {
      await withWorkspace(async ({ worktree }) => {
        const positiveContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from oci.container_engine.models import CreateClusterDetails",
              "print(CreateClusterDetails.swagger_types.get('cluster_pod_network_options'))",
              "print(CreateClusterDetails.attribute_map.get('cluster_pod_network_options'))",
            ].join("\n"),
            args: [],
            description: "oci metadata lookup",
          },
          positiveContext,
        )

        expect(getAsk(positiveContext, "python")).toBeUndefined()
        const positiveMetadata = positiveContext.metadatas[0]?.metadata
        expect(positiveMetadata?.permissionPatterns).toEqual([])
        expect(positiveMetadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "CreateClusterDetails.swagger_types.get", pattern: "pure:CreateClusterDetails.swagger_types.get" }),
            expect.objectContaining({ kind: "pure", call: "CreateClusterDetails.attribute_map.get", pattern: "pure:CreateClusterDetails.attribute_map.get" }),
            expect.objectContaining({ kind: "emit", call: "print", pattern: "emit:print" }),
          ]),
        )

        const negativePrograms = [
          {
            description: "module-qualified oci metadata lookup",
            code: [
              "import oci",
              "oci.container_engine.models.CreateClusterDetails.swagger_types.get('cluster_pod_network_options')",
              "oci.container_engine.models.CreateClusterDetails.attribute_map.get('cluster_pod_network_options')",
            ].join("\n"),
          },
          {
            description: "aliased oci metadata lookup",
            code: [
              "from oci.container_engine.models import CreateClusterDetails as ClusterDetails",
              "ClusterDetails.swagger_types.get('cluster_pod_network_options')",
              "ClusterDetails.attribute_map.get('cluster_pod_network_options')",
            ].join("\n"),
          },
          {
            description: "wrong-module oci metadata lookup",
            code: [
              "from fake_sdk import CreateClusterDetails",
              "CreateClusterDetails.swagger_types.get('cluster_pod_network_options')",
              "CreateClusterDetails.attribute_map.get('cluster_pod_network_options')",
            ].join("\n"),
          },
          {
            description: "shadowed oci metadata lookup",
            code: [
              "from oci.container_engine.models import CreateClusterDetails",
              "CreateClusterDetails = object()",
              "CreateClusterDetails.swagger_types.get('cluster_pod_network_options')",
              "CreateClusterDetails.attribute_map.get('cluster_pod_network_options')",
            ].join("\n"),
          },
          {
            description: "assigned oci metadata lookup",
            code: [
              "from oci.container_engine.models import CreateClusterDetails",
              "CreateClusterDetails.attribute_map = 0",
              "CreateClusterDetails.swagger_types = 0",
              "CreateClusterDetails.swagger_types.get('cluster_pod_network_options')",
              "CreateClusterDetails.attribute_map.get('cluster_pod_network_options')",
            ].join("\n"),
          },
          {
            description: "aliased assigned oci metadata lookup",
            code: [
              "from oci.container_engine.models import CreateClusterDetails",
              "alias = CreateClusterDetails",
              "alias.attribute_map = 0",
              "alias.swagger_types = 0",
              "CreateClusterDetails.swagger_types.get('cluster_pod_network_options')",
              "CreateClusterDetails.attribute_map.get('cluster_pod_network_options')",
            ].join("\n"),
          },
          {
            description: "setattr oci metadata lookup",
            code: [
              "from oci.container_engine.models import CreateClusterDetails",
              "setattr(CreateClusterDetails, 'attribute_map', 0)",
              "setattr(CreateClusterDetails, 'swagger_types', 0)",
              "CreateClusterDetails.swagger_types.get('cluster_pod_network_options')",
              "CreateClusterDetails.attribute_map.get('cluster_pod_network_options')",
            ].join("\n"),
          },
          {
            description: "aliased setattr oci metadata lookup",
            code: [
              "from oci.container_engine.models import CreateClusterDetails",
              "alias = CreateClusterDetails",
              "setattr(alias, 'attribute_map', 0)",
              "setattr(alias, 'swagger_types', 0)",
              "CreateClusterDetails.swagger_types.get('cluster_pod_network_options')",
              "CreateClusterDetails.attribute_map.get('cluster_pod_network_options')",
            ].join("\n"),
          },
        ]

        for (const program of negativePrograms) {
          const context = createMockContext({ worktree, directory: worktree })
          await executeExpectingEnoent(
            {
              code: program.code,
              args: [],
              description: program.description,
            },
            context,
          )
          const patterns = getAsk(context, "python")?.patterns ?? []
          expect(patterns.some((pattern) => pattern.endsWith("CreateClusterDetails.swagger_types.get"))).toBe(true)
          expect(patterns.some((pattern) => pattern.endsWith("CreateClusterDetails.attribute_map.get"))).toBe(true)
        }
      })
    })

    it("keeps OCI list_policies statement strings off unknown ask patterns while preserving mutation negatives", async () => {
      await withWorkspace(async ({ worktree }) => {
        const positiveContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import oci",
              "identity = oci.identity.IdentityClient(config)",
              "policies = oci.pagination.list_call_get_all_results(identity.list_policies, tenancy).data",
              "for policy in policies:",
              "    for statement in policy.statements:",
              "        statement.lower()",
              "    for stmt in policy.statements:",
              "        stmt.lower().strip()",
            ].join("\n"),
            args: [],
            description: "oci policy statement strings",
          },
          positiveContext,
        )

        expect(getAsk(positiveContext, "python")?.patterns).toEqual(expect.arrayContaining(["exec:oci.identity.IdentityClient", "exec:oci.pagination.list_call_get_all_results"]))
        expect(getAsk(positiveContext, "python")?.patterns).not.toEqual(expect.arrayContaining(["unknown:callable:statement.lower", "unknown:callable:stmt.lower", "unknown:callable:stmt.lower.strip"]))
        expect(positiveContext.metadatas[0]?.metadata?.operations).toEqual(
            expect.arrayContaining([
            expect.objectContaining({ kind: "exec", call: "oci.identity.IdentityClient", pattern: "exec:oci.identity.IdentityClient" }),
            expect.objectContaining({ kind: "exec", call: "oci.pagination.list_call_get_all_results", pattern: "exec:oci.pagination.list_call_get_all_results" }),
            expect.objectContaining({ kind: "pure", call: "statement.lower", pattern: "pure:statement.lower" }),
            expect.objectContaining({ kind: "pure", call: "stmt.lower", pattern: "pure:stmt.lower" }),
            expect.objectContaining({ kind: "pure", call: "stmt.lower.strip", pattern: "pure:stmt.lower.strip" }),
          ]),
        )

        const assignmentContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import oci",
              "identity = oci.identity.IdentityClient(config)",
              "policies = oci.pagination.list_call_get_all_results(identity.list_policies, tenancy).data",
              "for policy in policies:",
              "    policy.name = other",
              "    policy.name.lower()",
              "    policy.statements = [obj]",
              "    for statement in policy.statements:",
              "        statement.lower()",
            ].join("\n"),
            args: [],
            description: "mutated oci policy statement strings",
          },
          assignmentContext,
        )

        expect(getAsk(assignmentContext, "python")?.patterns).toEqual(expect.arrayContaining(["exec:oci.identity.IdentityClient", "exec:oci.pagination.list_call_get_all_results", "unknown:callable:policy.name.lower", "unknown:callable:statement.lower"]))

        const setattrContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import oci",
              "identity = oci.identity.IdentityClient(config)",
              "policies = oci.pagination.list_call_get_all_results(identity.list_policies, tenancy).data",
              "for policy in policies:",
              "    setattr(policy, 'name', other)",
              "    policy.name.lower()",
              "    setattr(policy, 'statements', [obj])",
              "    for stmt in policy.statements:",
              "        stmt.lower().strip()",
            ].join("\n"),
            args: [],
            description: "setattr oci policy statement strings",
          },
          setattrContext,
        )

        expect(getAsk(setattrContext, "python")?.patterns).toEqual(expect.arrayContaining(["exec:oci.identity.IdentityClient", "exec:oci.pagination.list_call_get_all_results", "unknown:callable:policy.name.lower", "unknown:callable:stmt.lower", "unknown:callable:stmt.lower.strip"]))

        const shadowedOciContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "oci = other",
              "policies = oci.pagination.list_call_get_all_results(identity.list_policies, tenancy).data",
              "for policy in policies:",
              "    for statement in policy.statements:",
              "        statement.lower()",
            ].join("\n"),
            args: [],
            description: "shadowed oci policy statements",
          },
          shadowedOciContext,
        )

        expect(getAsk(shadowedOciContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:statement.lower"]))

        const iterableMutationContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import oci",
              "identity = oci.identity.IdentityClient(config)",
              "policies = oci.pagination.list_call_get_all_results(identity.list_policies, tenancy).data",
              "policies.append(obj)",
              "for policy in policies:",
              "    for statement in policy.statements:",
              "        statement.lower()",
            ].join("\n"),
            args: [],
            description: "mutated oci policy iterable",
          },
          iterableMutationContext,
        )

        expect(getAsk(iterableMutationContext, "python")?.patterns).toEqual(expect.arrayContaining(["exec:oci.identity.IdentityClient", "exec:oci.pagination.list_call_get_all_results", "unknown:callable:policies.append", "unknown:callable:statement.lower"]))

        const iterableAliasMutationContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import oci",
              "identity = oci.identity.IdentityClient(config)",
              "policies = oci.pagination.list_call_get_all_results(identity.list_policies, tenancy).data",
              "alias = policies",
              "alias.append(obj)",
              "for policy in policies:",
              "    for stmt in policy.statements:",
              "        stmt.lower().strip()",
            ].join("\n"),
            args: [],
            description: "aliased mutated oci policy iterable",
          },
          iterableAliasMutationContext,
        )

        expect(getAsk(iterableAliasMutationContext, "python")?.patterns).toEqual(expect.arrayContaining(["exec:oci.identity.IdentityClient", "exec:oci.pagination.list_call_get_all_results", "unknown:callable:policies.append", "unknown:callable:stmt.lower", "unknown:callable:stmt.lower.strip"]))

        const statementsAliasContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import oci",
              "identity = oci.identity.IdentityClient(config)",
              "policies = oci.pagination.list_call_get_all_results(identity.list_policies, tenancy).data",
              "for policy in policies:",
              "    stmts = policy.statements",
              "    policy.statements.append(obj)",
              "    for statement in stmts:",
              "        statement.lower()",
            ].join("\n"),
            args: [],
            description: "aliased oci policy statements field",
          },
          statementsAliasContext,
        )

        expect(getAsk(statementsAliasContext, "python")?.patterns).toEqual(expect.arrayContaining(["exec:oci.identity.IdentityClient", "exec:oci.pagination.list_call_get_all_results", "unknown:callable:statement.lower"]))

        const subscriptMutationContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import oci",
              "identity = oci.identity.IdentityClient(config)",
              "policies = oci.pagination.list_call_get_all_results(identity.list_policies, tenancy).data",
              "policies[0] = obj",
              "for policy in policies:",
              "    for statement in policy.statements:",
              "        statement.lower()",
            ].join("\n"),
            args: [],
            description: "subscript-mutated oci policy iterable",
          },
          subscriptMutationContext,
        )

        expect(getAsk(subscriptMutationContext, "python")?.patterns).toEqual(expect.arrayContaining(["exec:oci.identity.IdentityClient", "exec:oci.pagination.list_call_get_all_results", "unknown:callable:statement.lower"]))

        const fakeMethodContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "class FakePagination:",
              "    def list_call_get_all_results(self, fn, tenancy):",
              "        return self",
              "    data = []",
              "class FakeIdentity:",
              "    def list_policies(self):",
              "        return []",
              "class FakeOci:",
              "    pagination = FakePagination()",
              "oci = FakeOci()",
              "identity = FakeIdentity()",
              "policies = oci.pagination.list_call_get_all_results(identity.list_policies, tenancy).data",
              "for policy in policies:",
              "    for statement in policy.statements:",
              "        statement.lower()",
            ].join("\n"),
            args: [],
            description: "fake list_policies producer",
          },
          fakeMethodContext,
        )

        expect(getAsk(fakeMethodContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:statement.lower"]))

        const paginationMonkeypatchContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import oci",
              "identity = oci.identity.IdentityClient(config)",
              "oci.pagination.list_call_get_all_results = fake",
              "policies = oci.pagination.list_call_get_all_results(identity.list_policies, tenancy).data",
              "for policy in policies:",
              "    for statement in policy.statements:",
              "        statement.lower()",
            ].join("\n"),
            args: [],
            description: "oci pagination monkeypatch",
          },
          paginationMonkeypatchContext,
        )

        expect(getAsk(paginationMonkeypatchContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:statement.lower"]))

        const identityCtorMonkeypatchContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import oci",
              "oci.identity.IdentityClient = fake",
              "identity = oci.identity.IdentityClient(config)",
              "policies = oci.pagination.list_call_get_all_results(identity.list_policies, tenancy).data",
              "for policy in policies:",
              "    for statement in policy.statements:",
              "        statement.lower()",
            ].join("\n"),
            args: [],
            description: "oci identity constructor monkeypatch",
          },
          identityCtorMonkeypatchContext,
        )

        expect(getAsk(identityCtorMonkeypatchContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:statement.lower"]))
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

    it("skips python ask for defaultdict Counter items destructuring", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from collections import Counter, defaultdict",
              "buckets = defaultdict(Counter)",
              "buckets['pytest']['pytest.main'] += 1",
              "for bucket, counts in buckets.items():",
              "    print(bucket, counts.most_common())",
            ].join("\n"),
            args: [],
            description: "defaultdict counter items",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.permissionPatterns).toEqual([])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "collections.defaultdict", pattern: "pure:collections.defaultdict" }),
            expect.objectContaining({ kind: "pure", call: "buckets.items", pattern: "pure:buckets.items" }),
            expect.objectContaining({ kind: "pure", call: "counts.most_common", pattern: "pure:counts.most_common" }),
            expect.objectContaining({ kind: "emit", call: "print", pattern: "emit:print" }),
          ]),
        )
      })
    })

    it("skips python ask for aliased Counter defaultdict items destructuring", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from collections import Counter as Tally, defaultdict",
              "buckets = defaultdict(Tally)",
              "for bucket, counts in buckets.items():",
              "    counts.most_common()",
            ].join("\n"),
            args: [],
            description: "defaultdict aliased counter items",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.permissionPatterns).toEqual([])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "collections.defaultdict", pattern: "pure:collections.defaultdict" }),
            expect.objectContaining({ kind: "pure", call: "buckets.items", pattern: "pure:buckets.items" }),
            expect.objectContaining({ kind: "pure", call: "counts.most_common", pattern: "pure:counts.most_common" }),
          ]),
        )
      })
    })

    it("keeps defaultdict Counter items destructuring on the ask path after widening update", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from collections import Counter, defaultdict",
              "buckets = defaultdict(Counter)",
              "buckets.update({'other': value})",
              "for bucket, counts in buckets.items():",
              "    counts.most_common()",
            ].join("\n"),
            args: [],
            description: "defaultdict counter items widened",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:buckets.items", "unknown:callable:counts.most_common"]))
      })
    })

    it("keeps defaultdict Counter items destructuring on the ask path after default_factory rebinding", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from collections import Counter, defaultdict",
              "buckets = defaultdict(Counter)",
              "setattr(buckets, 'default_factory', dict)",
              "buckets['other']",
              "for bucket, counts in buckets.items():",
              "    counts.most_common()",
            ].join("\n"),
            args: [],
            description: "defaultdict counter factory rebound",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:buckets.items", "unknown:callable:counts.most_common"]))
      })
    })

    it("keeps aliased defaultdict Counter factory rebinding on the ask path", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from collections import Counter, defaultdict",
              "buckets = defaultdict(Counter)",
              "alias = buckets",
              "setattr(alias, 'default_factory', dict)",
              "buckets['other']",
              "for bucket, counts in buckets.items():",
              "    counts.most_common()",
            ].join("\n"),
            args: [],
            description: "defaultdict aliased factory rebound",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:buckets.items", "unknown:callable:counts.most_common"]))
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

    it("projects guarded item.lower receivers from exact membership and keeps unguarded literal_eval loops conservative", async () => {
      await withWorkspace(async ({ worktree }) => {
        const guardedContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import ast",
              "raw = '[\"Health Benefit Analytic Sol\", \"Other\"]'",
              "items = ast.literal_eval(raw)",
              "li_depts = ['Health Benefit Analytic Sol', 'D&DS Product', 'ITPMA', 'Core Services', 'Enterprise Data Mgmt', 'DHP IT', 'Transformation & Integrations', 'Claims', 'HST IT']",
              "for item in items:",
              "    normalized = item.lower() if item in li_depts else item",
            ].join("\n"),
            args: [],
            description: "guarded item.lower membership narrowing",
          },
          guardedContext,
        )

        expect(getAsk(guardedContext, "python")).toBeUndefined()
        const guardedMetadata = guardedContext.metadatas[0]?.metadata
        expect(guardedMetadata?.permissionPatterns).toEqual([])
        expect(guardedMetadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "ast.literal_eval", pattern: "pure:ast.literal_eval" }),
            expect.objectContaining({ kind: "pure", call: "item.lower", pattern: "pure:item.lower" }),
          ]),
        )

        const unguardedContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: [
              "import ast",
              "raw = '[\"Health Benefit Analytic Sol\", \"Other\"]'",
              "items = ast.literal_eval(raw)",
              "for item in items:",
              "    item.lower()",
            ].join("\n"),
            args: [],
            description: "unguarded item.lower literal_eval",
          },
          unguardedContext,
        )

        expect(getAsk(unguardedContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:item.lower"]))

        const negativeGuardContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: [
              "import ast",
              "raw = '[\"Health Benefit Analytic Sol\", \"Other\"]'",
              "items = ast.literal_eval(raw)",
              "li_depts = ['Health Benefit Analytic Sol', 'D&DS Product', 'ITPMA', 'Core Services', 'Enterprise Data Mgmt', 'DHP IT', 'Transformation & Integrations', 'Claims', 'HST IT']",
              "flag = False",
              "for item in items:",
              "    lowered = item.lower() if item not in li_depts else item",
              "    maybe = item.lower() if flag or item in li_depts else item",
            ].join("\n"),
            args: [],
            description: "negative guarded item.lower membership narrowing",
          },
          negativeGuardContext,
        )

        expect(getAsk(negativeGuardContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:item.lower"]))

        const outerGuardShadowContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: [
              "import ast",
              "raw = '[\"Health Benefit Analytic Sol\", \"Other\"]'",
              "items = ast.literal_eval(raw)",
              "li_depts = ['Health Benefit Analytic Sol', 'D&DS Product', 'ITPMA', 'Core Services', 'Enterprise Data Mgmt', 'DHP IT', 'Transformation & Integrations', 'Claims', 'HST IT']",
              "item = 'Health Benefit Analytic Sol'",
              "if item in li_depts:",
              "    lowered = [item.lower() for item in items]",
            ].join("\n"),
            args: [],
            description: "outer guard shadowed item.lower",
          },
          outerGuardShadowContext,
        )

        expect(getAsk(outerGuardShadowContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:item.lower"]))

        const booleanGuardRebindContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: [
              "import ast",
              "raw = '[\"Health Benefit Analytic Sol\", \"Other\"]'",
              "items = ast.literal_eval(raw)",
              "li_depts = ['Health Benefit Analytic Sol', 'D&DS Product', 'ITPMA', 'Core Services', 'Enterprise Data Mgmt', 'DHP IT', 'Transformation & Integrations', 'Claims', 'HST IT']",
              "ok = True",
              "for item in items:",
              "    if ok and item in li_depts:",
              "        li_depts = ['Other']",
              "        item.lower()",
            ].join("\n"),
            args: [],
            description: "boolean guard item.lower rebinding",
          },
          booleanGuardRebindContext,
        )

        expect(getAsk(booleanGuardRebindContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:item.lower"]))

        const scalarMembershipContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: [
              "import ast",
              "raw = '[\"Health Benefit Analytic Sol\", \"Other\"]'",
              "items = ast.literal_eval(raw)",
              "allowed = 'Health Benefit Analytic Sol'",
              "for item in items:",
              "    normalized = item.lower() if item in allowed else item",
            ].join("\n"),
            args: [],
            description: "scalar membership item.lower narrowing",
          },
          scalarMembershipContext,
        )

        expect(getAsk(scalarMembershipContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:item.lower"]))
      })
    })

    it("skips python ask for builtin str() string receivers and keeps shadowed str conservative", async () => {
      await withWorkspace(async ({ worktree }) => {
        const exactContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from pathlib import Path",
              "root = Path('src')",
              "cand = root / 'python.ts'",
              "str(cand).startswith(str(root))",
              "text = str(cand)",
              "text.lower()",
            ].join("\n"),
            args: [],
            description: "builtin str string receivers",
          },
          exactContext,
        )

        expect(getAsk(exactContext, "python")).toBeUndefined()
        expect(exactContext.metadatas[0]?.metadata?.permissionPatterns).toEqual([])
        expect(exactContext.metadatas[0]?.metadata?.operations?.filter((operation) => operation.kind === "pure" && operation.call === "str")).toHaveLength(1)
        expect(exactContext.metadatas[0]?.metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "str", pattern: "pure:str" }),
            expect.objectContaining({ kind: "pure", call: "str.startswith", pattern: "pure:str.startswith" }),
            expect.objectContaining({ kind: "pure", call: "text.lower", pattern: "pure:text.lower" }),
          ]),
        )

        const shadowedContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from pathlib import Path",
              "root = Path('src')",
              "str = builder",
              "text = str(root)",
              "text.startswith('src')",
              "text.lower()",
            ].join("\n"),
            args: [],
            description: "shadowed str string receivers",
          },
          shadowedContext,
        )

        expect(getAsk(shadowedContext, "python")?.patterns).toEqual(
          expect.arrayContaining(["unknown:callable:builder", "unknown:callable:text.startswith", "unknown:callable:text.lower"]),
        )

        const parameterShadowedContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from pathlib import Path",
              "root = Path('src')",
              "def render(str):",
              "    text = str(root)",
              "    text.lower()",
              "render(builder)",
            ].join("\n"),
            args: [],
            description: "parameter shadowed str receiver",
          },
          parameterShadowedContext,
        )

        expect(getAsk(parameterShadowedContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:str", "unknown:callable:text.lower"]))

        const reboundContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from pathlib import Path",
              "root = Path('src')",
              "text = str(root)",
              "text = other",
              "text.lower()",
            ].join("\n"),
            args: [],
            description: "rebound str receiver",
          },
          reboundContext,
        )

        expect(getAsk(reboundContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:other.lower"]))
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

    it("projects helper-tracked datetime chains without extra downstream unknown noise", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from datetime import datetime",
              "def parse(raw):",
              "    return datetime.fromisoformat(raw.replace('Z', '+00:00'))",
              "def secs(a, b):",
              "    gap = b - a",
              "    return gap.total_seconds()",
              "start = parse('2024-01-02T03:04:05Z')",
              "end = parse('2024-01-02T03:04:35Z')",
              "start.isoformat()",
              "secs(start, end)",
            ].join("\n"),
            args: [],
            description: "helper datetime provenance",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:parse", "unknown:callable:secs"]))
        expect(ask?.patterns).not.toEqual(
          expect.arrayContaining(["unknown:callable:raw.replace", "unknown:callable:start.isoformat", "unknown:callable:gap.total_seconds"]),
        )
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "raw.replace", pattern: "pure:raw.replace" }),
            expect.objectContaining({ kind: "pure", call: "datetime.datetime.fromisoformat", pattern: "pure:datetime.datetime.fromisoformat" }),
            expect.objectContaining({ kind: "pure", call: "start.isoformat", pattern: "pure:start.isoformat" }),
            expect.objectContaining({ kind: "pure", call: "gap.total_seconds", pattern: "pure:gap.total_seconds" }),
            expect.objectContaining({ kind: "unknown", call: "callable:parse", pattern: "unknown:callable:parse" }),
            expect.objectContaining({ kind: "unknown", call: "callable:secs", pattern: "unknown:callable:secs" }),
          ]),
        )
      })
    })

    it("keeps shadowed datetime roots as unknown runtime operations", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import datetime",
              "datetime = object()",
              "datetime.UTC.tzname(None)",
              "datetime.datetime.fromisoformat('2024-01-02T03:04:05+00:00')",
            ].join("\n"),
            args: [],
            description: "shadowed datetime roots",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(
          expect.arrayContaining(["unknown:callable:datetime.UTC.tzname", "unknown:callable:datetime.datetime.fromisoformat"]),
        )

        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "unknown", call: "callable:datetime.UTC.tzname", pattern: "unknown:callable:datetime.UTC.tzname" }),
            expect.objectContaining({ kind: "unknown", call: "callable:datetime.datetime.fromisoformat", pattern: "unknown:callable:datetime.datetime.fromisoformat" }),
          ]),
        )
      })
    })

    it("skips python ask for direct datetime tuple-slot and exact-key receiver operations", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from datetime import datetime",
              "attempts = []",
              "for idx, raw in enumerate(['2024-01-02T03:04:05+00:00'], start=1):",
              "    ts = datetime.fromisoformat(raw)",
              "    attempts.append((idx, ts, 2))",
              "for idx, ts, count in attempts:",
              "    ts.isoformat()",
              "for i, attempt in enumerate(attempts):",
              "    attempt[1].isoformat()",
              "for i, (slot, ts, count) in enumerate(attempts):",
              "    ts.isoformat()",
              "patterns = {'start': '2024-01-02T03:04:05+00:00', 'end': '2024-01-02T03:05:05+00:00'}",
              "found = {}",
              "for key, raw in patterns.items():",
              "    found[key] = datetime.fromisoformat(raw)",
              "found['start'].isoformat()",
              "for k in patterns:",
              "    found[k].isoformat()",
              "pairs = [('start', 'end')]",
              "for left, right in pairs:",
              "    (found[right] - found[left]).total_seconds()",
              "(found['end'] - found['start']).total_seconds()",
            ].join("\n"),
            args: [],
            description: "tuple-slot and exact-key datetime receivers",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.permissionPatterns).toEqual([])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "ts.isoformat", pattern: "pure:ts.isoformat" }),
            expect.objectContaining({ kind: "pure", call: "attempt.isoformat", pattern: "pure:attempt.isoformat" }),
            expect.objectContaining({ kind: "pure", call: "found.isoformat", pattern: "pure:found.isoformat" }),
            expect.objectContaining({ kind: "pure", call: "total_seconds", pattern: "pure:total_seconds" }),
          ]),
        )
      })
    })

    it("projects exact-key datetime helper args without extra downstream unknown noise", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from datetime import datetime",
              "patterns = {'start': '2024-01-02T03:04:05+00:00', 'end': '2024-01-02T03:05:05+00:00'}",
              "found = {}",
              "for key, raw in patterns.items():",
              "    found[key] = datetime.fromisoformat(raw)",
              "def show(ts):",
              "    return ts.isoformat()",
              "def secs(a, b):",
              "    gap = b - a",
              "    return gap.total_seconds()",
              "def measure(left, right):",
              "    return round((found[right] - found[left]).total_seconds(), 3)",
              "show(found['start'])",
              "secs(found['start'], found['end'])",
              "measure('start', 'end')",
            ].join("\n"),
            args: [],
            description: "exact-key datetime helper args",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:show", "unknown:callable:secs"]))
        expect(ask?.patterns).not.toEqual(
          expect.arrayContaining(["unknown:callable:ts.isoformat", "unknown:callable:gap.total_seconds"]),
        )

        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "ts.isoformat", pattern: "pure:ts.isoformat" }),
            expect.objectContaining({ kind: "pure", call: "gap.total_seconds", pattern: "pure:gap.total_seconds" }),
            expect.objectContaining({ kind: "pure", call: "round", pattern: "pure:round" }),
            expect.objectContaining({ kind: "unknown", call: "callable:show", pattern: "unknown:callable:show" }),
            expect.objectContaining({ kind: "unknown", call: "callable:secs", pattern: "unknown:callable:secs" }),
          ]),
        )
      })
    })

    it("projects typed helper-backed exact-key datetime reads and helper-key total_seconds from matched timestamps", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from datetime import datetime, timezone",
              "import re",
              "def parse_ts(raw: str) -> datetime:",
              "    body = raw[:-1]",
              "    if '.' in body:",
              "        prefix, frac = body.split('.', 1)",
              "        frac = (frac + '000000')[:6]",
              "        body = prefix + '.' + frac",
              "        return datetime.strptime(body, '%Y-%m-%dT%H:%M:%S.%f').replace(tzinfo=timezone.utc)",
              "    return datetime.strptime(body, '%Y-%m-%dT%H:%M:%S').replace(tzinfo=timezone.utc)",
              "patterns = {'start': r'start', 'end': r'end'}",
              "found = {}",
              "for line in ['2024-01-02T03:04:05.000Z start', '2024-01-02T03:05:05.000Z end']:",
              "    m = re.match(r'^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d+Z)', line)",
              "    if not m:",
              "        continue",
              "    ts = parse_ts(m.group(1))",
              "    for key, pat in patterns.items():",
              "        if key in found:",
              "            continue",
              "        if re.search(pat, line):",
              "            found[key] = ts",
              "for k in patterns:",
              "    found[k].isoformat()",
              "def measure(left, right):",
              "    return round((found[right] - found[left]).total_seconds(), 3)",
              "measure('start', 'end')",
            ].join("\n"),
            args: [],
            description: "typed helper exact-key datetime reads",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:parse_ts", "unknown:callable:measure"]))
        expect(ask?.patterns).not.toEqual(expect.arrayContaining(["unknown:callable:body.split", "unknown:callable:found.isoformat", "unknown:callable:total_seconds"]))
      })
    })

    it("skips python ask for helper-backed datetime tuple slots from list comprehensions", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from datetime import datetime",
              "def parse_ts(line):",
              "    raw = line.split('Z', 1)[0].lstrip('\\ufeff') + 'Z'",
              "    return datetime.fromisoformat(raw.replace('Z', '+00:00'))",
              "lines = ['2024-01-02T03:04:05.000Z alpha']",
              "attempts = [(i, parse_ts(line), 2, line) for i, line in enumerate(lines, 1)]",
              "for idx, (i, ts, count, line) in enumerate(attempts):",
              "    ts.isoformat()",
              "for i, a in enumerate(attempts):",
              "    a[1].isoformat()",
            ].join("\n"),
            args: [],
            description: "helper-backed datetime tuple comprehension",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:parse_ts"]))
        expect(ask?.patterns).not.toEqual(expect.arrayContaining(["unknown:callable:ts.isoformat", "unknown:callable:a.isoformat"]))

        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "ts.isoformat", pattern: "pure:ts.isoformat" }),
            expect.objectContaining({ kind: "pure", call: "a.isoformat", pattern: "pure:a.isoformat" }),
            expect.objectContaining({ kind: "unknown", call: "callable:parse_ts", pattern: "unknown:callable:parse_ts" }),
          ]),
        )
      })
    })

    it("skips python ask for nested tuple subscript datetime differences in homogeneous tuple lists", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from datetime import datetime, timezone",
              "pts = []",
              "for line in ['2024-01-02T03:04:05.000Z alpha', '2024-01-02T03:05:05.000Z beta']:",
              "    raw = line.split('Z', 1)[0]",
              "    prefix, frac = raw.split('.', 1)",
              "    frac = (frac + '000000')[:6]",
              "    ts = datetime.strptime(prefix + '.' + frac, '%Y-%m-%dT%H:%M:%S.%f').replace(tzinfo=timezone.utc)",
              "    pts.append((ts, line.split(' ', 1)[1]))",
              "for i in range(1, len(pts)):",
              "    delta = round((pts[i][0] - pts[i-1][0]).total_seconds(), 3)",
            ].join("\n"),
            args: [],
            description: "nested tuple subscript total_seconds",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
      })
    })

    it("keeps exact-key datetime guards conservative when the guard does not reference the key variable", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from datetime import datetime",
              "patterns = {'start': 1, 'skip': 2}",
              "found = {'start': datetime.fromisoformat('2024-01-02T03:04:05+00:00'), 'skip': other}",
              "task = 'start'",
              "for k in patterns:",
              "    found[k].isoformat() if task.startswith('s') else ''",
            ].join("\n"),
            args: [],
            description: "unrelated guard exact-key datetime",
          },
          context,
        )

        expect(getAsk(context, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:found.isoformat"]))
      })
    })

    it("keeps exact-key datetime startswith guards conservative after guard-source rebinding", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from datetime import datetime",
              "found = {'start': datetime.fromisoformat('2024-01-02T03:04:05+00:00'), 'skip': other}",
              "prefix = ''",
              "for key in found:",
              "    if key.startswith(prefix):",
              "        prefix = 's'",
              "        found[key].isoformat()",
            ].join("\n"),
            args: [],
            description: "startswith guard source rebinding",
          },
          context,
        )

        expect(getAsk(context, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:found.isoformat"]))
      })
    })

    it("keeps exact-key datetime startswith guards conservative after guarded-name rebinding", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from datetime import datetime",
              "found = {'start': datetime.fromisoformat('2024-01-02T03:04:05+00:00'), 'skip': other}",
              "for key in found:",
              "    if key.startswith('s'):",
              "        key = 'skip'",
              "        found[key].isoformat()",
            ].join("\n"),
            args: [],
            description: "startswith guard guarded-name rebinding",
          },
          context,
        )

        expect(getAsk(context, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:found.isoformat"]))
      })
    })

    it("keeps exact-key datetime startswith guards conservative after guarded rebind entries", async () => {
      await withWorkspace(async ({ worktree }) => {
        const sourceContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from datetime import datetime",
              "found = {'start': datetime.fromisoformat('2024-01-02T03:04:05+00:00'), 'skip': other}",
              "prefix = ''",
              "for key in found:",
              "    if key.startswith(prefix):",
              "        for prefix in ['s']:",
              "            found[key].isoformat()",
            ].join("\n"),
            args: [],
            description: "startswith guard source rebind entry",
          },
          sourceContext,
        )

        expect(getAsk(sourceContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:found.isoformat"]))

        const receiverContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: [
              "from datetime import datetime",
              "found = {'start': datetime.fromisoformat('2024-01-02T03:04:05+00:00'), 'skip': other}",
              "for key in found:",
              "    if key.startswith('s'):",
              "        for key in ['skip']:",
              "            found[key].isoformat()",
            ].join("\n"),
            args: [],
            description: "startswith guard receiver rebind entry",
          },
          receiverContext,
        )

        expect(getAsk(receiverContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:found.isoformat"]))
      })
    })

    it("does not materialize startswith snapshots late from dynamic branch-entry values", async () => {
      await withWorkspace(async ({ worktree }) => {
        const dynamicPrefixContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from datetime import datetime",
              "found = {'start': datetime.fromisoformat('2024-01-02T03:04:05+00:00'), 'skip': other}",
              "prefix = dynamic",
              "for key in found:",
              "    if key.startswith(prefix):",
              "        for prefix in ['st']:",
              "            found[key].isoformat()",
            ].join("\n"),
            args: [],
            description: "late startswith prefix snapshot",
          },
          dynamicPrefixContext,
        )

        expect(getAsk(dynamicPrefixContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:found.isoformat"]))

        const dynamicReceiverContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: [
              "from datetime import datetime",
              "found = {'skip': datetime.fromisoformat('2024-01-02T03:04:05+00:00'), 'stop': other}",
              "key = dynamic",
              "if key.startswith('sk'):",
              "    for key in ['skip', 'stop']:",
              "        found[key].isoformat()",
            ].join("\n"),
            args: [],
            description: "late startswith receiver snapshot",
          },
          dynamicReceiverContext,
        )

        expect(getAsk(dynamicReceiverContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:found.isoformat"]))
      })
    })

    it("skips python ask for pure-only hashlib helpers and keeps tracked pure metadata", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import hashlib",
              "hashlib.sha1(b'w').hexdigest()",
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
            expect.objectContaining({ kind: "pure", call: "hashlib.sha1.hexdigest", pattern: "pure:hashlib.sha1.hexdigest" }),
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

    it("keeps hashlib.sha1 member mutation on the unknown ask path", async () => {
      await withWorkspace(async ({ worktree }) => {
        const assignedContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "import hashlib\nhashlib.sha1 = custom\nhashlib.sha1(b'x').hexdigest()",
            args: [],
            description: "assigned hashlib sha1 member",
          },
          assignedContext,
        )

        expect(getAsk(assignedContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:hashlib.sha1", "unknown:callable:hashlib.sha1.hexdigest"]))

        const setattrContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "import hashlib\nsetattr(hashlib, 'sha1', custom)\nhashlib.sha1(b'x').hexdigest()",
            args: [],
            description: "setattr hashlib sha1 member",
          },
          setattrContext,
        )

        expect(getAsk(setattrContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:hashlib.sha1", "unknown:callable:hashlib.sha1.hexdigest"]))
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

    it("skips python ask for pure-only zlib.decompress helpers and keeps tracked metadata", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import zlib",
              "raw = zlib.decompress(blob)",
              "raw.split(b'\\x00', 1)",
              "raw.decode('utf8').splitlines()",
              "from zlib import decompress",
              "payload = decompress(blob)",
              "payload.count(b'x')",
            ].join("\n"),
            args: [],
            description: "pure zlib decompress helpers",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.permissionPatterns).toEqual([])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "zlib.decompress", pattern: "pure:zlib.decompress" }),
            expect.objectContaining({ kind: "pure", call: "raw.decode", pattern: "pure:raw.decode" }),
            expect.objectContaining({ kind: "pure", call: "raw.decode.splitlines", pattern: "pure:raw.decode.splitlines" }),
            expect.objectContaining({ kind: "pure", call: "payload.count", pattern: "pure:payload.count" }),
          ]),
        )
      })
    })

    it("keeps shadowed zlib.decompress forms on the unknown ask path", async () => {
      await withWorkspace(async ({ worktree }) => {
        const reboundContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "import zlib\nzlib = object()\nzlib.decompress(blob)",
            args: [],
            description: "shadowed zlib root",
          },
          reboundContext,
        )

        expect(getAsk(reboundContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:zlib.decompress"]))

        const directImportContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "from zlib import decompress\ndef decompress(value):\n    return value\ndecompress(blob)",
            args: [],
            description: "shadowed zlib direct import",
          },
          directImportContext,
        )

        expect(getAsk(directImportContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:decompress"]))
      })
    })

    it("skips python ask for trusted difflib.unified_diff calls and keeps aliased forms conservative", async () => {
      await withWorkspace(async ({ worktree }) => {
        const moduleContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import difflib",
              "for line in difflib.unified_diff(before, after):",
              "    print(line)",
            ].join("\n"),
            args: [],
            description: "module difflib unified diff",
          },
          moduleContext,
        )

        expect(getAsk(moduleContext, "python")).toBeUndefined()
        expect(moduleContext.metadatas[0]?.metadata?.permissionPatterns).toEqual([])
        expect(moduleContext.metadatas[0]?.metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "difflib.unified_diff", pattern: "pure:difflib.unified_diff" }),
            expect.objectContaining({ kind: "emit", call: "print", pattern: "emit:print" }),
          ]),
        )

        const directImportContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from difflib import unified_diff",
              "for line in unified_diff(before, after):",
              "    print(line)",
            ].join("\n"),
            args: [],
            description: "direct-import difflib unified diff",
          },
          directImportContext,
        )

        expect(getAsk(directImportContext, "python")).toBeUndefined()
        expect(directImportContext.metadatas[0]?.metadata?.permissionPatterns).toEqual([])

        const reboundContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "import difflib\ndifflib = object()\ndifflib.unified_diff(before, after)",
            args: [],
            description: "rebound difflib unified diff",
          },
          reboundContext,
        )

        expect(getAsk(reboundContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:difflib.unified_diff"]))

        const aliasedModuleContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "import difflib as df\ndf.unified_diff(before, after)",
            args: [],
            description: "aliased difflib unified diff",
          },
          aliasedModuleContext,
        )

        expect(getAsk(aliasedModuleContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:difflib.unified_diff"]))

        const aliasedLeafContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "from difflib import unified_diff as diff_lines\ndiff_lines(before, after)",
            args: [],
            description: "aliased leaf difflib unified diff",
          },
          aliasedLeafContext,
        )

        expect(getAsk(aliasedLeafContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:difflib.unified_diff"]))

        const capturedContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "import difflib\nfn = difflib.unified_diff\nfn(before, after)",
            args: [],
            description: "captured difflib unified diff",
          },
          capturedContext,
        )

        expect(getAsk(capturedContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:difflib.unified_diff"]))

        const assignedMemberContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "import difflib\ndifflib.unified_diff = custom\ndifflib.unified_diff(before, after)",
            args: [],
            description: "assigned difflib unified diff member",
          },
          assignedMemberContext,
        )

        expect(getAsk(assignedMemberContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:difflib.unified_diff"]))

        const setattrMemberContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "import difflib\nsetattr(difflib, 'unified_diff', custom)\ndifflib.unified_diff(before, after)",
            args: [],
            description: "setattr difflib unified diff member",
          },
          setattrMemberContext,
        )

        expect(getAsk(setattrMemberContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:difflib.unified_diff"]))

        const aliasAssignedMemberContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "import difflib\nalias = difflib\nalias.unified_diff = custom\ndifflib.unified_diff(before, after)",
            args: [],
            description: "assigned alias difflib unified diff member",
          },
          aliasAssignedMemberContext,
        )

        expect(getAsk(aliasAssignedMemberContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:difflib.unified_diff"]))

        const aliasSetattrMemberContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "import difflib\nalias = difflib\nsetattr(alias, 'unified_diff', custom)\ndifflib.unified_diff(before, after)",
            args: [],
            description: "setattr alias difflib unified diff member",
          },
          aliasSetattrMemberContext,
        )

        expect(getAsk(aliasSetattrMemberContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:difflib.unified_diff"]))
      })
    })

    it("classifies exact stdlib walk, fnmatch, struct, and int.from_bytes without widening non-exact forms", async () => {
      await withWorkspace(async ({ worktree }) => {
        const exactContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import os",
              "os.walk('docs')",
              "from os import walk",
              "walk('src')",
              "import fnmatch",
              "fnmatch.fnmatch('notes.txt', '*.txt')",
              "from fnmatch import fnmatch",
              "fnmatch('notes.txt', '*.txt')",
              "import struct",
              "values = struct.unpack('>H2s', blob)",
              "values.count(7)",
              "from struct import unpack",
              "more_values = unpack('>H2s', blob)",
              "more_values.count(7)",
              "value = int.from_bytes(b'\\x00\\x07', 'big')",
              "value.bit_length()",
            ].join("\n"),
            args: [],
            description: "exact stdlib trust-gated calls",
          },
          exactContext,
        )

        expect(getAsk(exactContext, "python")).toBeUndefined()
        expect(exactContext.metadatas[0]?.metadata?.permissionPatterns).toEqual([])
        expect(exactContext.metadatas[0]?.metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "read", call: "os.walk", path: path.join(worktree, "docs") }),
            expect.objectContaining({ kind: "read", call: "os.walk", path: path.join(worktree, "src") }),
            expect.objectContaining({ kind: "pure", call: "fnmatch.fnmatch", pattern: "pure:fnmatch.fnmatch" }),
            expect.objectContaining({ kind: "pure", call: "struct.unpack", pattern: "pure:struct.unpack" }),
            expect.objectContaining({ kind: "pure", call: "values.count", pattern: "pure:values.count" }),
            expect.objectContaining({ kind: "pure", call: "more_values.count", pattern: "pure:more_values.count" }),
            expect.objectContaining({ kind: "pure", call: "int.from_bytes", pattern: "pure:int.from_bytes" }),
            expect.objectContaining({ kind: "pure", call: "value.bit_length", pattern: "pure:value.bit_length" }),
          ]),
        )

        const conservativeContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import os as operating_system",
              "operating_system.walk('docs')",
              "import os",
              "os.walk = custom",
              "os.walk('docs')",
              "from fnmatch import fnmatch as matches",
              "matches('notes.txt', '*.txt')",
              "import fnmatch",
              "fnmatch.fnmatch = custom",
              "fnmatch.fnmatch('notes.txt', '*.txt')",
              "import struct as st",
              "st.unpack('>H2s', blob)",
              "import struct",
              "alias = struct",
              "alias.unpack = custom",
              "values = struct.unpack('>H2s', blob)",
              "values.count(7)",
              "class FakeInt:",
              "    @staticmethod",
              "    def from_bytes(data, order):",
              "        return data",
              "int = FakeInt",
              "int.from_bytes(b'\\x00\\x07', 'big')",
            ].join("\n"),
            args: [],
            description: "non exact stdlib guardrails",
          },
          conservativeContext,
        )

        expect(getAsk(conservativeContext, "python")?.patterns).toEqual(
          expect.arrayContaining([
            "unknown:callable:os.walk",
            "unknown:callable:fnmatch.fnmatch",
            "unknown:callable:struct.unpack",
            "unknown:callable:values.count",
            "unknown:callable:FakeInt.from_bytes",
          ]),
        )
      })
    })

    it("skips python ask for exact direct-imported Github constructors and keeps other forms conservative", async () => {
      await withWorkspace(async ({ worktree }) => {
        const directContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "from github import Github\nGithub(login_or_token='x')",
            args: [],
            description: "direct github constructor",
          },
          directContext,
        )

        expect(getAsk(directContext, "python")?.patterns).toEqual(expect.arrayContaining(["exec:github.Github"]))
        expect(directContext.metadatas[0]?.metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "exec", call: "github.Github", pattern: "exec:github.Github" }),
          ]),
        )

        const moduleContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "import github\ngithub.Github(login_or_token='x')",
            args: [],
            description: "module github constructor",
          },
          moduleContext,
        )
        expect(getAsk(moduleContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:github.Github"]))

        const aliasContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "from github import Github as GH\nGH(login_or_token='x')",
            args: [],
            description: "aliased github constructor",
          },
          aliasContext,
        )
        expect(getAsk(aliasContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:github.Github"]))

        const capturedContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "from github import Github\nCtor = Github\nCtor(login_or_token='x')",
            args: [],
            description: "captured github constructor",
          },
          capturedContext,
        )
        expect(getAsk(capturedContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:github.Github"]))

        const shadowedContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: [
              "from github import Github",
              "def Github(*args, **kwargs):",
              "    return object()",
              "Github(login_or_token='x')",
            ].join("\n"),
            args: [],
            description: "shadowed github constructor",
          },
          shadowedContext,
        )
        expect(getAsk(shadowedContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:Github"]))
      })
    })

    it("keeps model_validate on the ask path while classifying exact OrganizationMembershipListOptions model_dump as pure", async () => {
      await withWorkspace(async ({ worktree }) => {
        const directContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from pytfe.models.organization_membership import OrganizationMembershipListOptions",
              "obj = OrganizationMembershipListOptions.model_validate({'page[size]': 100})",
              "print(obj.model_dump(by_alias=True, exclude_none=True))",
            ].join("\n"),
            args: [],
            description: "direct model_dump",
          },
          directContext,
        )

        expect(getAsk(directContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:OrganizationMembershipListOptions.model_validate"]))
        expect(getAsk(directContext, "python")?.patterns).not.toEqual(expect.arrayContaining(["unknown:callable:obj.model_dump"]))
        expect(directContext.metadatas[0]?.metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "pytfe.models.organization_membership.OrganizationMembershipListOptions.model_dump", pattern: "pure:pytfe.models.organization_membership.OrganizationMembershipListOptions.model_dump" }),
            expect.objectContaining({ kind: "emit", call: "print", pattern: "emit:print" }),
          ]),
        )

        const moduleContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "import pytfe.models.organization_membership as om\nobj = om.OrganizationMembershipListOptions.model_validate({'page[size]': 100})\nobj.model_dump(by_alias=True, exclude_none=True)",
            args: [],
            description: "module-qualified model_dump",
          },
          moduleContext,
        )
        expect(getAsk(moduleContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:obj.model_dump"]))

        const aliasContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "from pytfe.models.organization_membership import OrganizationMembershipListOptions as Options\nobj = Options.model_validate({'page[size]': 100})\nobj.model_dump(by_alias=True, exclude_none=True)",
            args: [],
            description: "aliased model_dump",
          },
          aliasContext,
        )
        expect(getAsk(aliasContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:obj.model_dump"]))

        const capturedContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "from pytfe.models.organization_membership import OrganizationMembershipListOptions\nobj = OrganizationMembershipListOptions.model_validate({'page[size]': 100})\nalias = obj\nalias.model_dump(by_alias=True, exclude_none=True)",
            args: [],
            description: "captured model_dump",
          },
          capturedContext,
        )
        expect(getAsk(capturedContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:obj.model_dump"]))

        const shadowedContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: [
              "from pytfe.models.organization_membership import OrganizationMembershipListOptions",
              "OrganizationMembershipListOptions = object()",
              "obj = OrganizationMembershipListOptions.model_validate({'page[size]': 100})",
              "obj.model_dump(by_alias=True, exclude_none=True)",
            ].join("\n"),
            args: [],
            description: "shadowed model_dump",
          },
          shadowedContext,
        )
        expect(getAsk(shadowedContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:obj.model_dump"]))

        const assignedFactoryContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: [
              "from pytfe.models.organization_membership import OrganizationMembershipListOptions",
              "OrganizationMembershipListOptions.model_validate = evil",
              "obj = OrganizationMembershipListOptions.model_validate({'page[size]': 100})",
              "obj.model_dump(by_alias=True, exclude_none=True)",
            ].join("\n"),
            args: [],
            description: "assigned model_validate model_dump",
          },
          assignedFactoryContext,
        )
        expect(getAsk(assignedFactoryContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:obj.model_dump"]))

        const setattrFactoryContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: [
              "from pytfe.models.organization_membership import OrganizationMembershipListOptions",
              "setattr(OrganizationMembershipListOptions, 'model_validate', evil)",
              "obj = OrganizationMembershipListOptions.model_validate({'page[size]': 100})",
              "obj.model_dump(by_alias=True, exclude_none=True)",
            ].join("\n"),
            args: [],
            description: "setattr model_validate model_dump",
          },
          setattrFactoryContext,
        )
        expect(getAsk(setattrFactoryContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:obj.model_dump"]))

        const assignedMethodContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: [
              "from pytfe.models.organization_membership import OrganizationMembershipListOptions",
              "obj = OrganizationMembershipListOptions.model_validate({'page[size]': 100})",
              "obj.model_dump = evil",
              "obj.model_dump(by_alias=True, exclude_none=True)",
            ].join("\n"),
            args: [],
            description: "assigned model_dump method",
          },
          assignedMethodContext,
        )
        expect(getAsk(assignedMethodContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:obj.model_dump"]))

        const setattrMethodContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: [
              "from pytfe.models.organization_membership import OrganizationMembershipListOptions",
              "obj = OrganizationMembershipListOptions.model_validate({'page[size]': 100})",
              "setattr(obj, 'model_dump', evil)",
              "obj.model_dump(by_alias=True, exclude_none=True)",
            ].join("\n"),
            args: [],
            description: "setattr model_dump method",
          },
          setattrMethodContext,
        )
        expect(getAsk(setattrMethodContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:obj.model_dump"]))

        const assignedClassMethodContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: [
              "from pytfe.models.organization_membership import OrganizationMembershipListOptions",
              "OrganizationMembershipListOptions.model_dump = evil",
              "obj = OrganizationMembershipListOptions.model_validate({'page[size]': 100})",
              "obj.model_dump(by_alias=True, exclude_none=True)",
            ].join("\n"),
            args: [],
            description: "assigned class model_dump",
          },
          assignedClassMethodContext,
        )
        expect(getAsk(assignedClassMethodContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:obj.model_dump"]))

        const setattrClassMethodContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: [
              "from pytfe.models.organization_membership import OrganizationMembershipListOptions",
              "setattr(OrganizationMembershipListOptions, 'model_dump', evil)",
              "obj = OrganizationMembershipListOptions.model_validate({'page[size]': 100})",
              "obj.model_dump(by_alias=True, exclude_none=True)",
            ].join("\n"),
            args: [],
            description: "setattr class model_dump",
          },
          setattrClassMethodContext,
        )
        expect(getAsk(setattrClassMethodContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:obj.model_dump"]))

        const aliasFactoryContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: [
              "from pytfe.models.organization_membership import OrganizationMembershipListOptions",
              "alias = OrganizationMembershipListOptions",
              "alias.model_validate = evil",
              "obj = OrganizationMembershipListOptions.model_validate({'page[size]': 100})",
              "obj.model_dump(by_alias=True, exclude_none=True)",
            ].join("\n"),
            args: [],
            description: "aliased model_validate model_dump",
          },
          aliasFactoryContext,
        )
        expect(getAsk(aliasFactoryContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:obj.model_dump"]))
      })
    })

    it("skips python ask for exact direct-imported tabulate_formats iteration and keeps other forms conservative", async () => {
      await withWorkspace(async ({ worktree }) => {
        const directContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from tabulate import tabulate_formats",
              "for f in tabulate_formats:",
              "    print(f.lower())",
            ].join("\n"),
            args: [],
            description: "tabulate formats iteration",
          },
          directContext,
        )

        expect(getAsk(directContext, "python")).toBeUndefined()
        expect(directContext.metadatas[0]?.metadata?.permissionPatterns).toEqual([])
        expect(directContext.metadatas[0]?.metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "f.lower", pattern: "pure:f.lower" }),
            expect.objectContaining({ kind: "emit", call: "print", pattern: "emit:print" }),
          ]),
        )

        const aliasedImportContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "from tabulate import tabulate_formats as formats\nfor f in formats:\n    f.lower()",
            args: [],
            description: "aliased tabulate formats",
          },
          aliasedImportContext,
        )
        expect(getAsk(aliasedImportContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:f.lower"]))

        const reboundContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "from tabulate import tabulate_formats\ntabulate_formats = []\nfor f in tabulate_formats:\n    f.lower()",
            args: [],
            description: "rebound tabulate formats",
          },
          reboundContext,
        )
        expect(getAsk(reboundContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:f.lower"]))

        const moduleQualifiedContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "import tabulate\nfor f in tabulate.tabulate_formats:\n    f.lower()",
            args: [],
            description: "module-qualified tabulate formats",
          },
          moduleQualifiedContext,
        )
        expect(getAsk(moduleQualifiedContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:f.lower"]))

        const appendedContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "from tabulate import tabulate_formats\ntabulate_formats.append(obj)\nfor f in tabulate_formats:\n    f.lower()",
            args: [],
            description: "mutated tabulate formats append",
          },
          appendedContext,
        )
        expect(getAsk(appendedContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:f.lower"]))

        const subscriptContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "from tabulate import tabulate_formats\ntabulate_formats[0] = obj\nfor f in tabulate_formats:\n    f.lower()",
            args: [],
            description: "mutated tabulate formats subscript",
          },
          subscriptContext,
        )
        expect(getAsk(subscriptContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:f.lower"]))

        const aliasSubscriptContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "from tabulate import tabulate_formats\nalias = tabulate_formats\nalias[0] = obj\nfor f in tabulate_formats:\n    f.lower()",
            args: [],
            description: "aliased mutated tabulate formats",
          },
          aliasSubscriptContext,
        )
        expect(getAsk(aliasSubscriptContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:f.lower"]))

        const augmentedContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "from tabulate import tabulate_formats\ntabulate_formats += [obj]\nfor f in tabulate_formats:\n    f.lower()",
            args: [],
            description: "augmented tabulate formats",
          },
          augmentedContext,
        )
        expect(getAsk(augmentedContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:f.lower"]))

        const aliasAugmentedContext = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "from tabulate import tabulate_formats\nalias = tabulate_formats\nalias += other\nfor f in tabulate_formats:\n    f.lower()",
            args: [],
            description: "aliased augmented tabulate formats",
          },
          aliasAugmentedContext,
        )
        expect(getAsk(aliasAugmentedContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:f.lower"]))
      })
    })

    it("skips python ask for zero-arg direct-imported RequestInformation constructors", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from kiota_abstractions.request_information import RequestInformation",
              "dir(RequestInformation())",
            ].join("\n"),
            args: [],
            description: "RequestInformation constructor introspection",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        expect(context.metadatas[0]?.metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "kiota_abstractions.request_information.RequestInformation", pattern: "pure:kiota_abstractions.request_information.RequestInformation" }),
          ]),
        )
      })
    })

    it("keeps RequestInformation unknown when module-qualified, aliased, shadowed, or called with args", async () => {
      await withWorkspace(async ({ worktree }) => {
        const moduleContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import kiota_abstractions.request_information",
              "kiota_abstractions.request_information.RequestInformation()",
            ].join("\n"),
            args: [],
            description: "module qualified RequestInformation",
          },
          moduleContext,
        )

        expect(getAsk(moduleContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:kiota_abstractions.request_information.RequestInformation"]))

        const aliasContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from kiota_abstractions.request_information import RequestInformation as RI",
              "RI()",
            ].join("\n"),
            args: [],
            description: "aliased RequestInformation",
          },
          aliasContext,
        )

        expect(getAsk(aliasContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:kiota_abstractions.request_information.RequestInformation"]))

        const shadowedContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from kiota_abstractions.request_information import RequestInformation",
              "def RequestInformation(value=None):",
              "    return value",
              "RequestInformation()",
            ].join("\n"),
            args: [],
            description: "shadowed RequestInformation",
          },
          shadowedContext,
        )

        expect(getAsk(shadowedContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:RequestInformation"]))

        const argContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from kiota_abstractions.request_information import RequestInformation",
              "RequestInformation('x')",
              "RequestInformation(url='x')",
            ].join("\n"),
            args: [],
            description: "RequestInformation with args",
          },
          argContext,
        )

        expect(getAsk(argContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:kiota_abstractions.request_information.RequestInformation"]))
      })
    })

    it("skips python ask for exact direct-import tabulate calls when tablefmt is absent or literal", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from tabulate import tabulate",
              "tabulate([[1]], headers=['a'])",
              "tabulate([[1]], headers=['a'], tablefmt='git_hub')",
            ].join("\n"),
            args: [],
            description: "pure tabulate formatting",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        expect(context.metadatas[0]?.metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "tabulate.tabulate", pattern: "pure:tabulate.tabulate" }),
          ]),
        )
      })
    })

    it("keeps tabulate unknown when module-qualified, aliased, shadowed, or given dynamic tablefmt", async () => {
      await withWorkspace(async ({ worktree }) => {
        const moduleContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import tabulate",
              "tabulate.tabulate([[1]], headers=['a'])",
            ].join("\n"),
            args: [],
            description: "module qualified tabulate",
          },
          moduleContext,
        )

        expect(getAsk(moduleContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:tabulate.tabulate"]))

        const aliasContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from tabulate import tabulate as t",
              "t([[1]], headers=['a'])",
            ].join("\n"),
            args: [],
            description: "aliased tabulate",
          },
          aliasContext,
        )

        expect(getAsk(aliasContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:tabulate.tabulate"]))

        const shadowedContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from tabulate import tabulate",
              "def tabulate(rows, **kwargs):",
              "    return rows",
              "tabulate([[1]], headers=['a'])",
            ].join("\n"),
            args: [],
            description: "shadowed tabulate",
          },
          shadowedContext,
        )

        expect(getAsk(shadowedContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:tabulate"]))

        const dynamicFmtContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from tabulate import tabulate",
              "fmt = table_format",
              "tabulate([[1]], headers=['a'], tablefmt=fmt)",
            ].join("\n"),
            args: [],
            description: "dynamic tablefmt",
          },
          dynamicFmtContext,
        )

        expect(getAsk(dynamicFmtContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:tabulate.tabulate"]))
      })
    })

    it("asks for trusted mypy.api.run exec calls", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from mypy import api",
              "api.run(args)",
              "from mypy.api import run",
              "run(args)",
            ].join("\n"),
            args: [],
            description: "mypy api run",
          },
          context,
        )

        expect(getAsk(context, "python")?.patterns).toEqual(expect.arrayContaining(["exec:mypy.api.run"]))
      })
    })

    it("keeps mypy.api.run unknown when rebound or laundered", async () => {
      await withWorkspace(async ({ worktree }) => {
        const reboundContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from mypy import api",
              "api = object()",
              "api.run(args)",
            ].join("\n"),
            args: [],
            description: "rebound mypy api run",
          },
          reboundContext,
        )

        expect(getAsk(reboundContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:api.run"]))

        const launderedContext = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "from mypy import api",
              "runner = api.run",
              "runner(args)",
            ].join("\n"),
            args: [],
            description: "laundered mypy api run",
          },
          launderedContext,
        )

        expect(getAsk(launderedContext, "python")?.patterns).toEqual(expect.arrayContaining(["unknown:callable:mypy.api.run"]))
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

    it("skips python ask for counter arithmetic temporaries before elements", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: [
              "import collections",
              "print(sorted((collections.Counter(expected_inline) - collections.Counter(cur_inline)).elements()))",
            ].join("\n"),
            args: [],
            description: "counter arithmetic elements",
          },
          context,
        )

        expect(getAsk(context, "python")).toBeUndefined()
        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.permissionPatterns).toEqual([])
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "pure", call: "collections.Counter", pattern: "pure:collections.Counter" }),
            expect.objectContaining({ kind: "pure", call: "elements", pattern: "pure:elements" }),
            expect.objectContaining({ kind: "pure", call: "sorted", pattern: "pure:sorted" }),
            expect.objectContaining({ kind: "emit", call: "print", pattern: "emit:print" }),
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

      it("preserves exact sqlite cursor projection", async () => {
        const result = await collectInlinePermissionParity(
          [
            "import sqlite3",
            "conn = sqlite3.connect('app.db')",
            "cur = conn.cursor()",
            "cur.execute('select 1')",
            "cur.fetchone()",
          ].join("\n"),
        )

        expect(result.ask?.patterns).toEqual(expect.arrayContaining(["exec:sqlite3.connect", "exec:sqlite3.Connection.cursor", "exec:sqlite3.Cursor.execute", "read:sqlite3.Cursor.fetchone"]))
        expect(result.ask?.patterns).not.toEqual(expect.arrayContaining(["unknown:callable:cur.execute", "unknown:callable:cur.fetchone"]))
        expect(result.metadata?.permissionPatterns).toEqual(expect.arrayContaining(["exec:sqlite3.connect", "exec:sqlite3.Connection.cursor", "exec:sqlite3.Cursor.execute", "read:sqlite3.Cursor.fetchone"]))
        expect(result.metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "exec", call: "sqlite3.connect", canonicalSource: "sqlite3.connect" }),
            expect.objectContaining({ kind: "exec", call: "sqlite3.Connection.cursor", pattern: "exec:sqlite3.Connection.cursor", canonicalSource: "sqlite3.Connection.cursor" }),
            expect.objectContaining({ kind: "exec", call: "sqlite3.Cursor.execute", pattern: "exec:sqlite3.Cursor.execute", canonicalSource: "sqlite3.Cursor.execute" }),
            expect.objectContaining({ kind: "read", call: "sqlite3.Cursor.fetchone", pattern: "read:sqlite3.Cursor.fetchone", canonicalSource: "sqlite3.Cursor.fetchone" }),
          ]),
        )
      })

      it("preserves sqlite execute.fetchall projection and keeps fetchall without execute unknown", async () => {
        const chainResult = await collectInlinePermissionParity(
          [
            "import sqlite3",
            "conn = sqlite3.connect('app.db')",
            "cur = conn.cursor()",
            "cur.execute('select 1').fetchall()",
          ].join("\n"),
        )

        expect(chainResult.ask?.patterns).toEqual(expect.arrayContaining(["exec:sqlite3.connect", "exec:sqlite3.Connection.cursor", "exec:sqlite3.Cursor.execute", "read:sqlite3.Cursor.fetchall"]))
        expect(chainResult.ask?.patterns).not.toEqual(expect.arrayContaining(["unknown:callable:cur.fetchall"]))
        expect(chainResult.metadata?.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "read", call: "sqlite3.Cursor.fetchall", pattern: "read:sqlite3.Cursor.fetchall", canonicalSource: "sqlite3.Cursor.fetchall" }),
          ]),
        )

        const noExecuteResult = await collectInlinePermissionParity(
          [
            "import sqlite3",
            "conn = sqlite3.connect('app.db')",
            "cur = conn.cursor()",
            "cur.fetchall()",
          ].join("\n"),
        )

        expect(noExecuteResult.ask?.patterns).toEqual(expect.arrayContaining(["unknown:callable:cur.fetchall"]))
        expect(noExecuteResult.ask?.patterns).not.toEqual(expect.arrayContaining(["read:sqlite3.Cursor.fetchall"]))
      })

      it("preserves sqlite cursor object identity and close invalidation", async () => {
        const reboundResult = await collectInlinePermissionParity(
          [
            "import sqlite3",
            "conn = sqlite3.connect('app.db')",
            "cur = conn.cursor()",
            "saved = cur",
            "cur = conn.cursor()",
            "saved.execute('select 1')",
            "cur.fetchone()",
          ].join("\n"),
        )

        expect(reboundResult.ask?.patterns).toEqual(expect.arrayContaining(["exec:sqlite3.connect", "exec:sqlite3.Connection.cursor", "unknown:callable:cur.execute", "unknown:callable:cur.fetchone"]))
        expect(reboundResult.ask?.patterns).not.toEqual(expect.arrayContaining(["read:sqlite3.Cursor.fetchone"]))

        const mirroredReboundResult = await collectInlinePermissionParity(
          [
            "import sqlite3",
            "conn = sqlite3.connect('app.db')",
            "cur = conn.cursor()",
            "saved = cur",
            "cur = conn.cursor()",
            "cur.execute('select 1')",
            "saved.fetchone()",
          ].join("\n"),
        )

        expect(mirroredReboundResult.ask?.patterns).toEqual(expect.arrayContaining(["exec:sqlite3.connect", "exec:sqlite3.Connection.cursor", "exec:sqlite3.Cursor.execute", "unknown:callable:cur.fetchone"]))
        expect(mirroredReboundResult.ask?.patterns).not.toEqual(expect.arrayContaining(["read:sqlite3.Cursor.fetchone"]))

        const closeResult = await collectInlinePermissionParity(
          [
            "import sqlite3",
            "conn = sqlite3.connect('app.db')",
            "cur = conn.cursor()",
            "cur.execute('select 1')",
            "cur.close()",
            "cur.fetchone()",
          ].join("\n"),
        )

        expect(closeResult.ask?.patterns).toEqual(expect.arrayContaining(["exec:sqlite3.connect", "exec:sqlite3.Connection.cursor", "exec:sqlite3.Cursor.execute", "unknown:callable:cur.fetchone"]))
        expect(closeResult.ask?.patterns).not.toEqual(expect.arrayContaining(["read:sqlite3.Cursor.fetchone"]))
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
