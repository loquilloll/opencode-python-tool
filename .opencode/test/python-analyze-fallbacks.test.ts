import { describe, expect, it } from "bun:test"
import { analyze } from "../tool/python-analyze"

describe("python analyzer", () => {
  describe("edge cases and fallbacks", () => {
    it("classifies empty, whitespace, parse-error, and no-calls paths", async () => {
      expect(await analyze("")).toEqual([{ kind: "unknown", call: "empty-source" }])
      expect(await analyze("   \n\t")).toEqual([{ kind: "unknown", call: "empty-source" }])
      expect(await analyze("def broken(:\n    pass")).toEqual([{ kind: "unknown", call: "parse-error" }])
      expect(await analyze("value = 1\nname = 'alice'")) .toEqual([{ kind: "unknown", call: "no-calls-detected" }])
    })

    it("emits callable-specific unknown events for unrecognized calls", async () => {
      const events = await analyze(["mypkg.do_thing()", "service.run_task('x')"].join("\n"))
      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:mypkg.do_thing" },
          { kind: "unknown", call: "callable:service.run_task" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "unknown", call: "no-classified-call" }]))
    })

    it("resolves explicit import aliases before rule matching", async () => {
      const events = await analyze("import requests as rq\nrq.get('https://example.com')")
      expect(events).toEqual([{ kind: "read", call: "requests.get" }])
    })

    it("resolves bounded direct from-import HTTP helpers", async () => {
      const events = await analyze(
        [
          "from requests import get, post",
          "get('https://example.com/a')",
          "post('https://example.com/b')",
          "from httpx import get as fetch_get, post as fetch_post",
          "fetch_get('https://example.com/c')",
          "fetch_post('https://example.com/d')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "requests.get" },
          { kind: "write", call: "requests.post" },
          { kind: "read", call: "httpx.get" },
          { kind: "write", call: "httpx.post" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:get" },
          { kind: "unknown", call: "callable:post" },
          { kind: "unknown", call: "callable:fetch_get" },
          { kind: "unknown", call: "callable:fetch_post" },
        ]),
      )
    })

    it("invalidates direct imported HTTP helpers when a local definition shadows them", async () => {
      const events = await analyze(
        [
          "from requests import get",
          "def get(url):",
          "    return url",
          "get('https://example.com/a')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:get" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "read", call: "requests.get" }]))
    })

    it("invalidates direct imported HTTP helpers when a local class shadows them", async () => {
      const events = await analyze(
        [
          "from requests import get",
          "class get:",
          "    pass",
          "get('https://example.com/a')",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:get" }]))
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "read", call: "requests.get" }]))
    })

    it("invalidates direct imported HTTP helpers after a decorated definition while preserving decorator call resolution", async () => {
      const events = await analyze(
        [
          "from requests import get",
          "@get('https://example.com/decorator')",
          "def get(url):",
          "    return url",
          "get('https://example.com/after')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "requests.get" },
          { kind: "unknown", call: "callable:get" },
        ]),
      )
    })

    it("invalidates direct imported HTTP request helpers when a local definition shadows them", async () => {
      const events = await analyze(
        [
          "from requests import request",
          "def request(method, url):",
          "    return method, url",
          "request('GET', 'https://example.com/a')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:request" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "read", call: "requests.get" }]))
    })

    it("invalidates direct imported HTTP helpers after a decorated class while preserving decorator call resolution", async () => {
      const events = await analyze(
        [
          "from requests import get",
          "@get('https://example.com/decorator')",
          "class get:",
          "    pass",
          "get('https://example.com/after')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "requests.get" },
          { kind: "unknown", call: "callable:get" },
        ]),
      )
    })

    it("resolves local callable and module rebindings", async () => {
      const events = await analyze(
        [
          "import requests",
          "client = requests",
          "fetch = requests.get",
          "client.get('https://example.com/a')",
          "fetch('https://example.com/b')",
        ].join("\n"),
      )

      expect(events).toEqual([{ kind: "read", call: "requests.get" }])
    })

    it("resolves local HTTP write rebindings", async () => {
      const events = await analyze(
        [
          "import requests",
          "submit = requests.post",
          "submit('https://example.com/api')",
        ].join("\n"),
      )

      expect(events).toEqual([{ kind: "write", call: "requests.post" }])
    })

    it("resolves zero-arg local factory returns into callable aliases", async () => {
      const events = await analyze(
        [
          "import requests",
          "def get_fetch():",
          "    return requests.get",
          "fetch = get_fetch()",
          "fetch('https://example.com')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "requests.get" },
          { kind: "unknown", call: "callable:get_fetch" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:fetch" }]))
    })

    it("resolves zero-arg local factory returns into constructor aliases", async () => {
      const events = await analyze(
        [
          "from atlassian import Jira",
          "def get_ctor():",
          "    return Jira",
          "Ctor = get_ctor()",
          "client = Ctor(url='https://example.atlassian.net')",
          "client.jql('project = DEMO')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "Jira" },
          { kind: "exec", call: "atlassian.jira.jql" },
          { kind: "unknown", call: "callable:get_ctor" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:Ctor" }]))
    })

    it("tracks zero-arg local factories that return Path values", async () => {
      const events = await analyze(
        [
          "from pathlib import Path",
          "def get_note():",
          "    return Path('notes.txt')",
          "note = get_note()",
          "note.read_text()",
          "def get_child():",
          "    return Path('docs') / name",
          "get_child().exists()",
          "state.path = get_note()",
          "state.path.read_text()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "note.read_text", path: "notes.txt", sourceCall: "pathlib.Path.read_text" },
          { kind: "read", call: "get_child.exists", dynamicPath: true, sourceCall: "pathlib.Path.exists" },
          { kind: "read", call: "state.path.read_text", path: "notes.txt", sourceCall: "pathlib.Path.read_text" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:note.read_text" },
          { kind: "unknown", call: "callable:get_child.exists" },
          { kind: "unknown", call: "callable:state.path.read_text" },
        ]),
      )
    })

    it("keeps function-local aliases from leaking into module scope", async () => {
      const events = await analyze(
        [
          "import requests",
          "def outer():",
          "    inner_fetch = requests.get",
          "    inner_fetch('https://example.com/c')",
          "inner_fetch('https://example.com/d')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "requests.get" },
          { kind: "unknown", call: "callable:inner_fetch" },
        ]),
      )
    })

    it("invalidates alias-based resolution after non-alias reassignment", async () => {
      const events = await analyze(
        [
          "import requests",
          "client = requests",
          "client.get('https://example.com/a')",
          "client = make_client()",
          "client.get('https://example.com/b')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "requests.get" },
          { kind: "unknown", call: "callable:make_client" },
          { kind: "unknown", call: "callable:client.get" },
        ]),
      )
    })

    it("invalidates factory-derived aliases after reassignment", async () => {
      const events = await analyze(
        [
          "import requests",
          "def get_fetch():",
          "    return requests.get",
          "fetch = get_fetch()",
          "fetch('https://example.com/a')",
          "fetch = other()",
          "fetch('https://example.com/b')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "requests.get" },
          { kind: "unknown", call: "callable:other" },
          { kind: "unknown", call: "callable:fetch" },
        ]),
      )
    })

    it("invalidates alias-based resolution for for-loop rebinding", async () => {
      const events = await analyze(
        [
          "import requests",
          "client = requests",
          "client.get('https://example.com/a')",
          "for client in make_clients():",
          "    pass",
          "client.get('https://example.com/b')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "requests.get" },
          { kind: "unknown", call: "callable:make_clients" },
          { kind: "unknown", call: "callable:client.get" },
        ]),
      )
    })

    it("invalidates alias-based resolution for destructuring for-loop rebinding", async () => {
      const events = await analyze(
        [
          "import requests",
          "fetch = requests.get",
          "fetch('https://example.com/a')",
          "for fetch, other in pairs:",
          "    pass",
          "fetch('https://example.com/b')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "requests.get" },
          { kind: "unknown", call: "callable:fetch" },
        ]),
      )
    })

    it("invalidates alias-based resolution for with-as rebinding", async () => {
      const events = await analyze(
        [
          "import requests",
          "client = requests",
          "client.get('https://example.com/a')",
          "with manager() as client:",
          "    pass",
          "client.get('https://example.com/b')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "requests.get" },
          { kind: "unknown", call: "callable:manager" },
          { kind: "unknown", call: "callable:client.get" },
        ]),
      )
    })

    it("invalidates alias-based resolution inside a for-loop body", async () => {
      const events = await analyze(
        [
          "import requests",
          "client = requests",
          "for client in make_clients():",
          "    client.get('https://example.com/in-loop')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:make_clients" },
          { kind: "unknown", call: "callable:client.get" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "read", call: "requests.get" }]))
    })

    it("invalidates alias-based resolution for async for-loop rebinding", async () => {
      const events = await analyze(
        [
          "import requests",
          "client = requests",
          "async def outer():",
          "    client.get('https://example.com/a')",
          "    async for client in make_clients():",
          "        pass",
          "    client.get('https://example.com/b')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "requests.get" },
          { kind: "unknown", call: "callable:make_clients" },
          { kind: "unknown", call: "callable:client.get" },
        ]),
      )
    })

    it("invalidates alias-based resolution for destructuring async for-loop rebinding", async () => {
      const events = await analyze(
        [
          "import requests",
          "fetch = requests.get",
          "async def outer():",
          "    fetch('https://example.com/a')",
          "    async for fetch, other in pairs:",
          "        pass",
          "    fetch('https://example.com/b')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "requests.get" },
          { kind: "unknown", call: "callable:fetch" },
        ]),
      )
    })

    it("invalidates alias-based resolution inside an async for-loop body", async () => {
      const events = await analyze(
        [
          "import requests",
          "client = requests",
          "async def outer():",
          "    async for client in make_clients():",
          "        client.get('https://example.com/in-loop')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:make_clients" },
          { kind: "unknown", call: "callable:client.get" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "read", call: "requests.get" }]))
    })

    it("invalidates alias-based resolution inside a with-as body", async () => {
      const events = await analyze(
        [
          "import requests",
          "client = requests",
          "with manager() as client:",
          "    client.get('https://example.com/in-with')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:manager" },
          { kind: "unknown", call: "callable:client.get" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "read", call: "requests.get" }]))
    })

    it("invalidates alias-based resolution for async with-as rebinding", async () => {
      const events = await analyze(
        [
          "import requests",
          "client = requests",
          "async def outer():",
          "    client.get('https://example.com/a')",
          "    async with manager() as client:",
          "        pass",
          "    client.get('https://example.com/b')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "requests.get" },
          { kind: "unknown", call: "callable:manager" },
          { kind: "unknown", call: "callable:client.get" },
        ]),
      )
    })

    it("invalidates alias-based resolution inside an async with-as body", async () => {
      const events = await analyze(
        [
          "import requests",
          "client = requests",
          "async def outer():",
          "    async with manager() as client:",
          "        client.get('https://example.com/in-with')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:manager" },
          { kind: "unknown", call: "callable:client.get" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "read", call: "requests.get" }]))
    })

    it("invalidates aliases between multi-item with headers in source order", async () => {
      const events = await analyze(
        [
          "import requests",
          "client = requests",
          "with manager() as client, other(client.get('https://example.com/in-item')) as token:",
          "    pass",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:manager" },
          { kind: "unknown", call: "callable:other" },
          { kind: "unknown", call: "callable:client.get" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "read", call: "requests.get" }]))
    })

    it("invalidates aliases between multi-item async with headers in source order", async () => {
      const events = await analyze(
        [
          "import requests",
          "client = requests",
          "async def outer():",
          "    async with manager() as client, other(client.get('https://example.com/in-item')) as token:",
          "        pass",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:manager" },
          { kind: "unknown", call: "callable:other" },
          { kind: "unknown", call: "callable:client.get" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "read", call: "requests.get" }]))
    })

    it("invalidates alias-based resolution for except-as rebinding", async () => {
      const events = await analyze(
        [
          "import requests",
          "client = requests",
          "client.get('https://example.com/a')",
          "try:",
          "    raise RuntimeError()",
          "except RuntimeError as client:",
          "    pass",
          "client.get('https://example.com/b')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "requests.get" },
          { kind: "pure", call: "RuntimeError" },
          { kind: "unknown", call: "callable:client.get" },
        ]),
      )
    })

    it("invalidates alias-based resolution inside an except-as body", async () => {
      const events = await analyze(
        [
          "import requests",
          "client = requests",
          "try:",
          "    raise RuntimeError()",
          "except RuntimeError as client:",
          "    client.get('https://example.com/in-except')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "RuntimeError" },
          { kind: "unknown", call: "callable:client.get" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "read", call: "requests.get" }]))
    })

    it("keeps nested-scope rebinding from clearing outer aliases", async () => {
      const events = await analyze(
        [
          "import requests",
          "def outer():",
          "    client = requests",
          "    def inner():",
          "        for client in make_clients():",
          "            pass",
          "        with manager() as client:",
          "            pass",
          "        try:",
          "            raise RuntimeError()",
          "        except RuntimeError as client:",
          "            pass",
          "    inner()",
          "    client.get('https://example.com/outside')",
          "outer()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:make_clients" },
          { kind: "unknown", call: "callable:manager" },
          { kind: "pure", call: "RuntimeError" },
          { kind: "unknown", call: "callable:inner" },
          { kind: "unknown", call: "callable:outer" },
          { kind: "read", call: "requests.get" },
        ]),
      )
    })

    it("keeps parameterized callable factories unresolved", async () => {
      const events = await analyze(
        [
          "import requests",
          "def choose_fetch(flag):",
          "    return requests.get",
          "fetch = choose_fetch(cond)",
          "fetch('https://example.com')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:choose_fetch" },
          { kind: "unknown", call: "callable:fetch" },
        ]),
      )
    })

    it("keeps direct wrapper call passthrough deferred", async () => {
      const events = await analyze(
        [
          "import requests",
          "def fetch(url):",
          "    return requests.get(url)",
          "fetch('https://example.com')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "requests.get" },
          { kind: "unknown", call: "callable:fetch" },
        ]),
      )
    })

    it("does not summarize decorated zero-arg callable factories", async () => {
      const events = await analyze(
        [
          "import requests",
          "@decorate",
          "def get_fetch():",
          "    return requests.get",
          "fetch = get_fetch()",
          "fetch('https://example.com')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:get_fetch" },
          { kind: "unknown", call: "callable:fetch" },
        ]),
      )
    })

    it("keeps subscript-return callable factories unresolved", async () => {
      const events = await analyze(
        [
          "registry = handlers",
          "def get_fetch():",
          "    return registry['fetch']",
          "fetch = get_fetch()",
          "fetch('https://example.com')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:get_fetch" },
          { kind: "unknown", call: "callable:fetch" },
        ]),
      )
    })

    it("invalidates alias-based resolution for destructuring reassignments", async () => {
      const events = await analyze(
        [
          "import requests",
          "client = requests",
          "client.get('https://example.com/a')",
          "client, other = make_pair()",
          "client.get('https://example.com/b')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "requests.get" },
          { kind: "unknown", call: "callable:make_pair" },
          { kind: "unknown", call: "callable:client.get" },
        ]),
      )
    })

    it("invalidates alias-based resolution for augmented assignments", async () => {
      const events = await analyze(
        [
          "import requests",
          "client = requests",
          "client.get('https://example.com/a')",
          "client += suffix",
          "client.get('https://example.com/b')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "requests.get" },
          { kind: "unknown", call: "callable:client.get" },
        ]),
      )
    })

    it("invalidates alias-based resolution for named expressions", async () => {
      const events = await analyze(
        [
          "import requests",
          "client = requests",
          "client.get('https://example.com/a')",
          "if (client := make_client()):",
          "    pass",
          "client.get('https://example.com/b')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "requests.get" },
          { kind: "unknown", call: "callable:make_client" },
          { kind: "unknown", call: "callable:client.get" },
        ]),
      )
    })

    it("uses dynamic-call fallback when callable identity cannot be resolved", async () => {
      const events = await analyze("(lambda x: x)(1)")
      expect(events).toEqual([{ kind: "unknown", call: "dynamic-call" }])
    })

    it("deduplicates identical events and supports mixed calls", async () => {
      const duplicate = await analyze("open('f', 'r')\nopen('f', 'r')")
      expect(duplicate).toEqual([{ kind: "read", call: "open", path: "f" }])

      const mixed = await analyze("open('f', 'r')\nos.remove('g')\nsubprocess.run(['ls'])\nmy_func()")
      expect(mixed).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "open", path: "f" },
          { kind: "write", call: "os.remove", path: "g" },
          { kind: "exec", call: "subprocess.run" },
          { kind: "unknown", call: "callable:my_func" },
        ]),
      )
    })
  })

  describe("decorator and nested contexts", () => {
    it("detects calls in decorator, class body, nested function, and list comprehension", async () => {
      const events = await analyze(
        [
          "@requests.get('https://example.com')",
          "class Task:",
          "    resource = Path('class.txt').write_text('ok')",
          "",
          "def outer():",
          "    def inner():",
          "        return os.remove('nested.txt')",
          "    return [open(item) for item in files]",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "requests.get" },
          { kind: "write", call: "Path.write_text", path: "class.txt" },
          { kind: "write", call: "os.remove", path: "nested.txt" },
          { kind: "read", call: "open", dynamicPath: true },
        ]),
      )
    })
  })

})
