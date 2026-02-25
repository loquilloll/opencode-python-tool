import { describe, expect, it } from "bun:test"
import { analyze } from "../tool/python-analyze"

describe("python analyzer phase 5 hardening", () => {
  it("classifies network calls as exec", async () => {
    const events = await analyze(
      [
        "requests.get('https://example.com')",
        "urllib.request.urlopen('https://example.com')",
        "http.client.HTTPConnection('example.com')",
        "aiohttp.ClientSession()",
        "httpx.Client()",
        "socket.create_connection(('example.com', 443))",
      ].join("\n"),
    )

    expect(events).toEqual(
      expect.arrayContaining([
        { kind: "exec", call: "requests.get" },
        { kind: "exec", call: "urllib.request.urlopen" },
        { kind: "exec", call: "http.client.HTTPConnection" },
        { kind: "exec", call: "aiohttp.ClientSession" },
        { kind: "exec", call: "httpx.Client" },
        { kind: "exec", call: "socket.create_connection" },
      ]),
    )
  })

  it("classifies database calls as exec", async () => {
    const events = await analyze(
      [
        "sqlite3.connect('app.db')",
        "psycopg2.connect('postgresql://localhost/db')",
        "pymysql.connect(host='localhost')",
        "sqlalchemy.create_engine('sqlite:///app.db')",
      ].join("\n"),
    )

    expect(events).toEqual(
      expect.arrayContaining([
        { kind: "exec", call: "sqlite3.connect" },
        { kind: "exec", call: "psycopg2.connect" },
        { kind: "exec", call: "pymysql.connect" },
        { kind: "exec", call: "sqlalchemy.create_engine" },
      ]),
    )
  })

  it("classifies tempfile writers as write", async () => {
    const events = await analyze(
      [
        "tempfile.NamedTemporaryFile()",
        "tempfile.mkdtemp()",
        "tempfile.mkstemp()",
        "tempfile.TemporaryDirectory()",
      ].join("\n"),
    )

    expect(events).toEqual(
      expect.arrayContaining([
        { kind: "write", call: "tempfile.NamedTemporaryFile" },
        { kind: "write", call: "tempfile.mkdtemp" },
        { kind: "write", call: "tempfile.mkstemp" },
        { kind: "write", call: "tempfile.TemporaryDirectory" },
      ]),
    )
  })

  it("classifies dangerous deserialization as exec", async () => {
    const events = await analyze(["pickle.loads(data)", "marshal.load(handle)"].join("\n"))

    expect(events).toEqual(
      expect.arrayContaining([
        { kind: "exec", call: "pickle.loads" },
        { kind: "exec", call: "marshal.load" },
      ]),
    )
  })

  it("detects calls in with statements", async () => {
    const events = await analyze("with open('data.txt') as handle:\n    handle.read()")

    expect(events).toEqual(expect.arrayContaining([{ kind: "read", call: "open", path: "data.txt" }]))
  })

  it("detects decorator and class-level calls", async () => {
    const events = await analyze(
      [
        "@requests.get('https://example.com')",
        "class Task:",
        "    client = httpx.Client()",
        "    pass",
      ].join("\n"),
    )

    expect(events).toEqual(
      expect.arrayContaining([
        { kind: "exec", call: "requests.get" },
        { kind: "exec", call: "httpx.Client" },
      ]),
    )
  })

  it("does not resolve import aliases yet", async () => {
    const events = await analyze("import requests as rq\nrq.get('https://example.com')")

    expect(events).toEqual([{ kind: "unknown", call: "callable:rq.get" }])
  })

  it("emits callable-specific unknown events for unrecognized calls", async () => {
    const events = await analyze(["mypkg.do_thing()", "service.run_task('x')"].join("\n"))

    expect(events).toEqual(
      expect.arrayContaining([
        { kind: "unknown", call: "callable:mypkg.do_thing" },
        { kind: "unknown", call: "callable:service.run_task" },
      ]),
    )
  })

  it("keeps no-calls-detected behavior for call-free source", async () => {
    const events = await analyze("value = 1\nname = 'alice'")

    expect(events).toEqual([{ kind: "unknown", call: "no-calls-detected" }])
  })
})
