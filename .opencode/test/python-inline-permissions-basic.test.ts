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
