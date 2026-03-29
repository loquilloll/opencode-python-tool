import { describe, expect, it } from "bun:test"
import { analyze, analyzeDetailed } from "../tool/python-analyze"

function stripEvidence(events: readonly Record<string, unknown>[]) {
  return events.map((event) => {
    const { evidence: _evidence, ...rest } = event
    return rest
  })
}

describe("python analyzer", () => {
  it("returns stable analyzer metadata without changing event output", async () => {
    const detailed = await analyzeDetailed("print('hello')")

    expect(detailed.analyzerVersion).toBe("python-analyzer/v2")
    expect(detailed.engineVersion).toBe("python-ir-v2")
    expect(detailed.events).toEqual(await analyze("print('hello')"))
  })

  it("includes guarded receiver evidence for matched path methods", async () => {
    const detailed = await analyzeDetailed(["from pathlib import Path", "p = Path('f')", "p.read_text()"].join("\n"))

    expect(detailed.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "read",
          call: "p.read_text",
          sourceCall: "pathlib.Path.read_text",
          evidence: expect.objectContaining({ receiverKind: "path", explain: expect.arrayContaining(["guarded-method:read_text"]) }),
        }),
      ]),
    )
  })

  it("includes guard-failure evidence for guarded method misses", async () => {
    const detailed = await analyzeDetailed("obj.group(1)")

    expect(detailed.events).toEqual([
      expect.objectContaining({
        kind: "unknown",
        call: "callable:obj.group",
        evidence: expect.objectContaining({
          guardFailure: expect.objectContaining({ type: "receiverKindIn" }),
          explain: expect.arrayContaining(["guarded-method:group"]),
        }),
      }),
    ])
  })

  it("includes match receiver evidence for guarded match-result methods", async () => {
    const detailed = await analyzeDetailed("import re\nitem = re.search('a+', text)\nitem.group(1)")

    expect(detailed.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "pure",
          call: "item.group",
          evidence: expect.objectContaining({ receiverKind: "match", explain: expect.arrayContaining(["guarded-method:group"]) }),
        }),
      ]),
    )
  })

    it("marks calls to inline definitions so review tooling can skip them", async () => {
      const detailed = await analyzeDetailed(["def helper():", "    writer.save('x')", "helper()"].join("\n"))

    expect(detailed.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "unknown",
          call: "callable:helper",
          evidence: expect.objectContaining({ localDefinition: true }),
        }),
        expect.objectContaining({
          kind: "unknown",
          call: "callable:writer.save",
        }),
      ]),
      )
    })

    it("marks calls to inline lambda helpers so review tooling can skip them", async () => {
      const detailed = await analyzeDetailed(["helper = lambda text: writer.save(text)", "helper('x')"].join("\n"))

      expect(detailed.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "unknown",
            call: "callable:helper",
            evidence: expect.objectContaining({ localDefinition: true }),
          }),
          expect.objectContaining({
            kind: "unknown",
            call: "callable:writer.save",
          }),
        ]),
      )
    })

  describe("parity fixture regressions", () => {
    const fixtures = [
      {
        name: "builtin and guarded evidence",
        source: ["print('hello')", "obj.group(1)"].join("\n"),
        expectedDetailed: [
          { kind: "emit", call: "print" },
          {
            kind: "unknown",
            call: "callable:obj.group",
            evidence: {
              explain: ["guarded-method:group"],
              guardFailure: {
                type: "receiverKindIn",
                detail: "expected=path actual=none",
              },
            },
          },
        ],
      },
      {
        name: "tracked path dynamic-path metadata",
        source: ["from pathlib import Path", "home = Path.home()", "home.read_text()"].join("\n"),
        expectedDetailed: [
          { kind: "pure", call: "pathlib.Path.home" },
          {
            kind: "read",
            call: "home.read_text",
            sourceCall: "pathlib.Path.read_text",
            dynamicPath: true,
            evidence: {
              receiverKind: "path",
              explain: ["guarded-method:read_text"],
            },
          },
        ],
      },
      {
        name: "direct-import http canonicalization",
        source: [
          "from requests import request",
          "from httpx import request as http_request",
          "request('GET', 'https://example.com/a')",
          "http_request('HEAD', 'https://example.com/b')",
        ].join("\n"),
        expectedDetailed: [
          {
            kind: "read",
            call: "requests.get",
            evidence: {
              explain: ["guarded-call:requests.request"],
            },
          },
          {
            kind: "read",
            call: "httpx.head",
            evidence: {
              explain: ["guarded-call:httpx.request"],
            },
          },
        ],
      },
      {
        name: "assignment invalidation",
        source: [
          "import requests",
          "client = requests.Session()",
          "client.get('https://example.com/a')",
          "client = obj",
          "client.get('https://example.com/b')",
        ].join("\n"),
        expectedDetailed: [
          { kind: "exec", call: "requests.Session" },
          { kind: "read", call: "requests.Session.get" },
          { kind: "unknown", call: "callable:obj.get" },
        ],
      },
      {
        name: "ghapi grouped instance normalization",
        source: ["api = GhApi()", "api.git.get_ref(owner='o', repo='r', ref='heads/main')"].join("\n"),
        expectedDetailed: [
          { kind: "unknown", call: "callable:GhApi" },
          { kind: "exec", call: "ghapi.git.get_ref" },
        ],
      },
      {
        name: "atlassian instance normalization",
        source: [
          "from atlassian import ConfluenceServer",
          "cf = ConfluenceServer(url='https://example.atlassian.net/wiki')",
          "cf.create_page(space='ENG', title='t', body='b')",
        ].join("\n"),
        expectedDetailed: [
          { kind: "exec", call: "ConfluenceServer" },
          { kind: "exec", call: "atlassian.confluence.create_page" },
        ],
      },
      {
        name: "subprocess execution classification",
        source: ["import os", "import subprocess", "os.system('ls')", "subprocess.run(['ls'])"].join("\n"),
        expectedDetailed: [
          { kind: "exec", call: "os.system" },
          { kind: "exec", call: "subprocess.run" },
        ],
      },
      {
        name: "comprehension rebinding",
        source: ["rows = [{'x': 1}]", "[item.get('x') for item in rows]"].join("\n"),
        expectedDetailed: [{ kind: "pure", call: "item.get" }],
      },
      {
        name: "unknown callable fallback",
        source: "mypkg.do_thing()",
        expectedDetailed: [{ kind: "unknown", call: "callable:mypkg.do_thing" }],
      },
      {
        name: "empty source sentinel",
        source: "",
        expectedDetailed: [{ kind: "unknown", call: "empty-source" }],
      },
      {
        name: "parse error sentinel",
        source: "def broken(",
        expectedDetailed: [{ kind: "unknown", call: "parse-error" }],
      },
      {
        name: "no calls detected sentinel",
        source: "value = 1 + 1",
        expectedDetailed: [{ kind: "unknown", call: "no-calls-detected" }],
      },
    ] as const

    for (const fixture of fixtures) {
      it(`preserves ${fixture.name}`, async () => {
        const detailed = await analyzeDetailed(fixture.source)

        expect(detailed.events).toEqual(fixture.expectedDetailed)
        expect(await analyze(fixture.source)).toEqual(stripEvidence(fixture.expectedDetailed as readonly Record<string, unknown>[]))
      })
    }
  })
})
