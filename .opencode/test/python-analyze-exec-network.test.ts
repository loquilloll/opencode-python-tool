import { describe, expect, it } from "bun:test"
import { analyze } from "../tool/python-analyze"

describe("python analyzer", () => {
  describe("exec classification", () => {
    it("classifies trusted mypy.api.run calls as exec", async () => {
      const moduleBindingEvents = await analyze(
        [
          "from mypy import api",
          "api.run(args)",
        ].join("\n"),
      )

      const directImportEvents = await analyze(
        [
          "from mypy.api import run",
          "run(args)",
        ].join("\n"),
      )

      const aliasModuleBindingEvents = await analyze(
        [
          "from mypy import api as mapi",
          "mapi.run(args)",
        ].join("\n"),
      )

      expect(moduleBindingEvents).toEqual(expect.arrayContaining([{ kind: "exec", call: "mypy.api.run" }]))
      expect(directImportEvents).toEqual(expect.arrayContaining([{ kind: "exec", call: "mypy.api.run" }]))
      expect(aliasModuleBindingEvents).toEqual(expect.arrayContaining([{ kind: "exec", call: "mypy.api.run" }]))
    })

    it("keeps mypy.api.run conservative when rebound or laundered through extracted callables", async () => {
      const reboundEvents = await analyze(
        [
          "from mypy import api",
          "api = object()",
          "api.run(args)",
        ].join("\n"),
      )

      const launderedEvents = await analyze(
        [
          "from mypy import api",
          "runner = api.run",
          "runner(args)",
        ].join("\n"),
      )

      expect(reboundEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:api.run" }]))
      expect(launderedEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:mypy.api.run" }]))
      expect(launderedEvents).not.toEqual(expect.arrayContaining([{ kind: "exec", call: "mypy.api.run" }]))
    })

    it("classifies importlib.import_module as exec and importlib.metadata.version as read", async () => {
      const moduleExecEvents = await analyze(["import importlib", "importlib.import_module('json')"].join("\n"))
      const directImportExecEvents = await analyze(["from importlib import import_module", "import_module('json')"].join("\n"))

      const moduleReadEvents = await analyze(["import importlib.metadata", "importlib.metadata.version('PyGithub')"].join("\n"))
      const directImportReadEvents = await analyze(["from importlib.metadata import version", "version('PyGithub')"].join("\n"))
      const namespaceReadEvents = await analyze(["from importlib import metadata", "metadata.version('PyGithub')"].join("\n"))
      const aliasModuleReadEvents = await analyze(["import importlib.metadata as md", "md.version('PyGithub')"].join("\n"))

      expect(moduleExecEvents).toEqual(expect.arrayContaining([{ kind: "exec", call: "importlib.import_module" }]))
      expect(directImportExecEvents).toEqual(expect.arrayContaining([{ kind: "exec", call: "importlib.import_module" }]))
      expect(moduleReadEvents).toEqual(expect.arrayContaining([{ kind: "read", call: "importlib.metadata.version" }]))
      expect(directImportReadEvents).toEqual(expect.arrayContaining([{ kind: "read", call: "importlib.metadata.version" }]))
      expect(namespaceReadEvents).toEqual(expect.arrayContaining([{ kind: "read", call: "importlib.metadata.version" }]))
      expect(aliasModuleReadEvents).toEqual(expect.arrayContaining([{ kind: "read", call: "importlib.metadata.version" }]))
    })

    it("keeps importlib family conservative under shadowing and unsupported namespace imports", async () => {
      const shadowedImportModuleEvents = await analyze(
        [
          "from importlib import import_module",
          "def import_module(name):",
          "    return name",
          "import_module('json')",
        ].join("\n"),
      )

      const reboundImportlibEvents = await analyze(
        [
          "import importlib",
          "importlib = object()",
          "importlib.import_module('json')",
        ].join("\n"),
      )

      const aliasedImportModuleEvents = await analyze(
        [
          "from importlib import import_module as imod",
          "imod('json')",
        ].join("\n"),
      )

      const aliasedVersionEvents = await analyze(
        [
          "from importlib.metadata import version as pkg_version",
          "pkg_version('PyGithub')",
        ].join("\n"),
      )

      const launderedImportModuleEvents = await analyze(
        [
          "from importlib import import_module",
          "fn = import_module",
          "fn('json')",
        ].join("\n"),
      )

      const reassignedLeafImportModuleEvents = await analyze(
        [
          "import importlib",
          "import_module = importlib.import_module",
          "import_module('json')",
        ].join("\n"),
      )

      const reassignedLeafVersionEvents = await analyze(
        [
          "import importlib.metadata",
          "version = importlib.metadata.version",
          "version('PyGithub')",
        ].join("\n"),
      )

      expect(shadowedImportModuleEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:import_module" }]))
      expect(reboundImportlibEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:importlib.import_module" }]))
      expect(aliasedImportModuleEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:importlib.import_module" }]))
      expect(aliasedVersionEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:importlib.metadata.version" }]))
      expect(launderedImportModuleEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:importlib.import_module" }]))
      expect(reassignedLeafImportModuleEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:importlib.import_module" }]))
      expect(reassignedLeafVersionEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:importlib.metadata.version" }]))
    })

    it("classifies pytest.main as exec and keeps other pytest helpers conservative", async () => {
      const moduleEvents = await analyze(["import pytest", "pytest.main(['-q'])", "pytest.approx(1.0)"].join("\n"))
      const directImportEvents = await analyze(["from pytest import main", "main(['-q'])"].join("\n"))
      const aliasedImportEvents = await analyze(["from pytest import main as run_tests", "run_tests(['-q'])"].join("\n"))

      expect(moduleEvents).toEqual(expect.arrayContaining([{ kind: "exec", call: "pytest.main" }]))
      expect(moduleEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:pytest.approx" }]))
      expect(directImportEvents).toEqual(expect.arrayContaining([{ kind: "exec", call: "pytest.main" }]))
      expect(aliasedImportEvents).toEqual(expect.arrayContaining([{ kind: "exec", call: "pytest.main" }]))
    })

    it("keeps direct-imported pytest.main conservative when shadowed locally", async () => {
      const events = await analyze(
        [
          "from pytest import main",
          "def main(args):",
          "    return args",
          "main(['-q'])",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:main" }]))
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "exec", call: "pytest.main" }]))
    })

    it("keeps module-root pytest.main conservative when pytest is rebound", async () => {
      const events = await analyze(
        [
          "import pytest",
          "pytest = object()",
          "pytest.main(['-q'])",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:pytest.main" }]))
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "exec", call: "pytest.main" }]))
    })

    it("keeps aliased pytest module calls conservative after root rebinding", async () => {
      const events = await analyze(
        [
          "import pytest",
          "pytest = object()",
          "runner = pytest",
          "runner.main(['-q'])",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:pytest.main" }]))
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "exec", call: "pytest.main" }]))
    })

    it("classifies subprocess, os, and dynamic execution builtins", async () => {
      const events = await analyze(
        [
          "subprocess.run(['ls'])",
          "subprocess.call(['ls'])",
          "subprocess.Popen(['ls'])",
          "subprocess.check_output(['ls'])",
          "os.system('ls')",
          "os.popen('ls')",
          "os.execvp('ls', ['ls'])",
          "eval('1+1')",
          "exec('print(1)')",
          "compile('x', 'f', 'exec')",
          "__import__('os')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "subprocess.run" },
          { kind: "exec", call: "subprocess.call" },
          { kind: "exec", call: "subprocess.Popen" },
          { kind: "exec", call: "subprocess.check_output" },
          { kind: "exec", call: "os.system" },
          { kind: "exec", call: "os.popen" },
          { kind: "exec", call: "os.execvp" },
          { kind: "exec", call: "eval" },
          { kind: "exec", call: "exec" },
          { kind: "exec", call: "compile" },
          { kind: "exec", call: "__import__" },
        ]),
      )
    })
  })

  describe("network db tempfile deserialization and supporting regressions", () => {
    it("keeps outward behavior stable across internal effect groups", async () => {
      const events = await analyze(
        [
          "os.system('ls')",
          "eval('1+1')",
          "requests.get('https://example.com')",
          "requests.post('https://example.com')",
          "sqlite3.connect('app.db')",
          "pickle.loads(data)",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "os.system" },
          { kind: "exec", call: "eval" },
          { kind: "read", call: "requests.get" },
          { kind: "write", call: "requests.post" },
          { kind: "exec", call: "sqlite3.connect" },
          { kind: "exec", call: "pickle.loads" },
        ]),
      )
    })

    it("classifies direct HTTP helpers as read/write and network clients as exec", async () => {
      const events = await analyze(
        [
          "requests.get('https://example.com')",
          "requests.head('https://example.com')",
          "requests.post('https://example.com')",
          "requests.patch('https://example.com')",
          "urllib.request.urlopen('https://example.com')",
          "http.client.HTTPConnection('example.com')",
          "aiohttp.ClientSession()",
          "httpx.get('https://example.com')",
          "httpx.post('https://example.com')",
          "httpx.Client()",
          "socket.create_connection(('example.com', 443))",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "requests.get" },
          { kind: "read", call: "requests.head" },
          { kind: "write", call: "requests.post" },
          { kind: "write", call: "requests.patch" },
          { kind: "exec", call: "urllib.request.urlopen" },
          { kind: "exec", call: "http.client.HTTPConnection" },
          { kind: "exec", call: "aiohttp.ClientSession" },
          { kind: "read", call: "httpx.get" },
          { kind: "write", call: "httpx.post" },
          { kind: "exec", call: "httpx.Client" },
          { kind: "exec", call: "socket.create_connection" },
        ]),
      )
    })

    it("classifies tracked HTTP client instance methods with canonical call IDs", async () => {
      const events = await analyze(
        [
          "import requests",
          "session = requests.Session()",
          "session.get('https://example.com')",
          "session.post('https://example.com')",
          "import httpx",
          "client = httpx.Client()",
          "client.get('https://example.com')",
          "client.post('https://example.com')",
          "async_client = httpx.AsyncClient()",
          "async_client.get('https://example.com')",
          "async_client.post('https://example.com')",
          "import aiohttp",
          "aio = aiohttp.ClientSession()",
          "aio.get('https://example.com')",
          "aio.post('https://example.com')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "requests.Session" },
          { kind: "read", call: "requests.Session.get" },
          { kind: "write", call: "requests.Session.post" },
          { kind: "exec", call: "httpx.Client" },
          { kind: "read", call: "httpx.Client.get" },
          { kind: "write", call: "httpx.Client.post" },
          { kind: "exec", call: "httpx.AsyncClient" },
          { kind: "read", call: "httpx.AsyncClient.get" },
          { kind: "write", call: "httpx.AsyncClient.post" },
          { kind: "exec", call: "aiohttp.ClientSession" },
          { kind: "read", call: "aiohttp.ClientSession.get" },
          { kind: "write", call: "aiohttp.ClientSession.post" },
        ]),
      )
    })

    it("classifies bounded HTTP request(method) calls on direct surfaces and direct imports", async () => {
      const events = await analyze(
        [
          "import requests",
          "requests.request('GET', 'https://example.com/a')",
          "requests.request('get', 'https://example.com/a2')",
          "requests.request(method='POST', url='https://example.com/b')",
          "from requests import request",
          "request('DELETE', 'https://example.com/c')",
          "from httpx import request as http_request",
          "http_request('Head', 'https://example.com/d')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "requests.get" },
          { kind: "write", call: "requests.post" },
          { kind: "write", call: "requests.delete" },
          { kind: "read", call: "httpx.head" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:request" },
          { kind: "unknown", call: "callable:http_request" },
          { kind: "unknown", call: "callable:requests.request" },
        ]),
      )
    })

    it("classifies tracked HTTP client request(method) calls and private transport chains", async () => {
      const events = await analyze(
        [
          "import requests",
          "client = requests.Session()",
          "client.request('get', 'https://example.com/a')",
          "client._client._transport.request('POST', 'https://example.com/b')",
          "import httpx",
          "http_client = httpx.Client()",
          "http_client._transport.request(method='Head', url='https://example.com/c')",
          "import aiohttp",
          "aio = aiohttp.ClientSession()",
          "aio.request('patch', 'https://example.com/d')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "requests.Session" },
          { kind: "read", call: "requests.Session.get" },
          { kind: "write", call: "requests.Session.post" },
          { kind: "exec", call: "httpx.Client" },
          { kind: "read", call: "httpx.Client.head" },
          { kind: "exec", call: "aiohttp.ClientSession" },
          { kind: "write", call: "aiohttp.ClientSession.patch" },
        ]),
      )
    })

    it("keeps nested tracked-client receiver chains conservative", async () => {
      const events = await analyze(
        [
          "import requests",
          "client = requests.Session()",
          "client.api.get('https://example.com')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "requests.Session" },
          { kind: "unknown", call: "callable:client.api.get" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "read", call: "requests.Session.get" }]))
    })

    it("keeps dynamic, unsupported, and unrelated nested request calls conservative", async () => {
      const events = await analyze(
        [
          "import requests",
          "client = requests.Session()",
          "verb = 'GET'",
          "client.request(verb, 'https://example.com/a')",
          "requests.request('TRACE', 'https://example.com/b')",
          "client.api.request('GET', 'https://example.com/c')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "requests.Session" },
          { kind: "unknown", call: "callable:client.request" },
          { kind: "unknown", call: "callable:requests.request" },
          { kind: "unknown", call: "callable:client.api.request" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "read", call: "requests.Session.get" },
          { kind: "write", call: "requests.post" },
        ]),
      )
    })

    it("keeps unrelated private request chains conservative", async () => {
      const events = await analyze(
        [
          "import requests",
          "client = requests.Session()",
          "client._client.request('GET', 'https://example.com/a')",
          "client._cache.request('GET', 'https://example.com/a')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "requests.Session" },
          { kind: "unknown", call: "callable:client._client.request" },
          { kind: "unknown", call: "callable:client._cache.request" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "read", call: "requests.Session.get" }]))
    })

    it("invalidates tracked HTTP client instances on reassignment", async () => {
      const events = await analyze(
        [
          "import requests",
          "client = requests.Session()",
          "client.get('https://example.com/a')",
          "client = make_client()",
          "client.get('https://example.com/b')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "requests.Session" },
          { kind: "read", call: "requests.Session.get" },
          { kind: "unknown", call: "callable:make_client" },
          { kind: "unknown", call: "callable:client.get" },
        ]),
      )
    })

    it("classifies tracked local container methods as pure and keeps unresolved mutators conservative", async () => {
      const events = await analyze(
        [
          "changed = []",
          "changed.append(str(p))",
          "mapping = {}",
          "mapping.update({'a': 1})",
          "items = {}",
          "items.get('key')",
          "seen = set()",
          "seen.add(item)",
          "client.update(payload)",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "changed.append" },
          { kind: "pure", call: "mapping.update" },
          { kind: "pure", call: "items.get" },
          { kind: "pure", call: "seen.add" },
          { kind: "unknown", call: "callable:client.update" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "write", call: "changed.append" }),
          expect.objectContaining({ kind: "write", call: "mapping.update" }),
          expect.objectContaining({ kind: "write", call: "seen.add" }),
          expect.objectContaining({ kind: "read", call: "items.get" }),
        ]),
      )
    })

    it("tracks comprehension-backed local containers and pure dict factories", async () => {
      const events = await analyze(
        [
          "counts = {name: name for name in names}",
          "counts.values()",
          "ordered = [item for item in rows]",
          "ordered.append('x')",
          "seen = {item for item in rows}",
          "seen.add('x')",
          "dict.fromkeys(seq)",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "counts.values" },
          { kind: "pure", call: "ordered.append" },
          { kind: "pure", call: "seen.add" },
          { kind: "pure", call: "dict.fromkeys" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:counts.values" },
          { kind: "unknown", call: "callable:ordered.append" },
          { kind: "unknown", call: "callable:seen.add" },
          { kind: "unknown", call: "callable:dict.fromkeys" },
        ]),
      )
    })

    it("classifies common unshadowed builtin helpers as pure", async () => {
      const events = await analyze(
        [
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
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "list" },
          { kind: "pure", call: "dict" },
          { kind: "pure", call: "set" },
          { kind: "pure", call: "tuple" },
          { kind: "pure", call: "frozenset" },
          { kind: "pure", call: "len" },
          { kind: "pure", call: "max" },
          { kind: "pure", call: "min" },
          { kind: "pure", call: "sum" },
          { kind: "pure", call: "sorted" },
          { kind: "pure", call: "reversed" },
          { kind: "pure", call: "all" },
          { kind: "pure", call: "any" },
          { kind: "pure", call: "next" },
          { kind: "pure", call: "items.sort" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:list" },
          { kind: "unknown", call: "callable:max" },
          { kind: "unknown", call: "callable:sorted" },
          { kind: "unknown", call: "callable:items.sort" },
        ]),
      )
    })

    it("classifies direct temporary builtin and json container receiver methods as pure", async () => {
      const events = await analyze(
        [
          "import json",
          "list(values).sort()",
          "dict(pairs).get('x')",
          "set(values).add(item)",
          "json.loads(text).get('x')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "list.sort" },
          { kind: "pure", call: "dict.get" },
          { kind: "pure", call: "set.add" },
          { kind: "pure", call: "json.loads" },
          { kind: "pure", call: "json.loads.get" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:list.sort" },
          { kind: "unknown", call: "callable:dict.get" },
          { kind: "unknown", call: "callable:set.add" },
          { kind: "unknown", call: "callable:json.loads.get" },
        ]),
      )
    })

    it("keeps unseeded subscript and attribute receiver container methods conservative", async () => {
      const events = await analyze(
        [
          "entries = []",
          "entries[current].append(item)",
          "self.stack.pop()",
          "state.stack.pop()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:entries.append" },
          { kind: "unknown", call: "callable:self.stack.pop" },
          { kind: "unknown", call: "callable:state.stack.pop" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "entries.append" },
          { kind: "pure", call: "self.stack.pop" },
          { kind: "pure", call: "state.stack.pop" },
        ]),
      )
    })

    it("classifies exact same-scope subscript and attribute receiver container methods as pure", async () => {
      const events = await analyze(
        [
          "entries[current] = []",
          "entries[current].append(item)",
          "entries[current].pop()",
          "import json",
          "entries[current] = json.loads(text)",
          "entries[current].get('x')",
          "state.stack = []",
          "state.stack.pop()",
          "state.payload = json.loads(text)",
          "state.payload.get('x')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "entries.append" },
          { kind: "pure", call: "entries.pop" },
          { kind: "pure", call: "json.loads" },
          { kind: "pure", call: "entries.get" },
          { kind: "pure", call: "state.stack.pop" },
          { kind: "pure", call: "state.payload.get" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:entries.append" },
          { kind: "unknown", call: "callable:entries.pop" },
          { kind: "unknown", call: "callable:entries.get" },
          { kind: "unknown", call: "callable:state.stack.pop" },
          { kind: "unknown", call: "callable:state.payload.get" },
        ]),
      )
    })

    it("classifies common receiver paths with one-hop attribute deps and shallow nested attributes as pure", async () => {
      const events = await analyze(
        [
          "entries[current.user] = []",
          "entries[current.user].append(item)",
          "entries[current.user].pop()",
          "state.inner.stack = []",
          "state.inner.stack.pop()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "entries.append" },
          { kind: "pure", call: "entries.pop" },
          { kind: "pure", call: "state.inner.stack.pop" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:entries.append" },
          { kind: "unknown", call: "callable:entries.pop" },
          { kind: "unknown", call: "callable:state.inner.stack.pop" },
        ]),
      )
    })

    it("classifies tracked same-scope self attribute container methods as pure", async () => {
      const events = await analyze(
        [
          "self.stack = []",
          "self.stack.append(item)",
          "self.stack.pop()",
          "self.inner.stack = []",
          "self.inner.stack.pop()",
          "import json",
          "self.payload = json.loads(text)",
          "self.payload.get('x')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "self.stack.append" },
          { kind: "pure", call: "self.stack.pop" },
          { kind: "pure", call: "self.inner.stack.pop" },
          { kind: "pure", call: "json.loads" },
          { kind: "pure", call: "self.payload.get" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:self.stack.append" },
          { kind: "unknown", call: "callable:self.stack.pop" },
          { kind: "unknown", call: "callable:self.inner.stack.pop" },
          { kind: "unknown", call: "callable:self.payload.get" },
        ]),
      )
    })

    it("clears self attribute container provenance on reassignment and self shadowing", async () => {
      const events = await analyze(
        [
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
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "self.stack.append" },
          { kind: "unknown", call: "callable:self.stack.pop" },
          { kind: "pure", call: "self.inner.stack.pop" },
          { kind: "unknown", call: "callable:self.inner.stack.pop" },
          { kind: "unknown", call: "callable:factory" },
          { kind: "unknown", call: "callable:self.shadowed.pop" },
          { kind: "unknown", call: "callable:self.outer.pop" },
          { kind: "unknown", call: "callable:helper" },
          { kind: "unknown", call: "callable:self.stack.append" },
          { kind: "unknown", call: "callable:inner" },
          { kind: "unknown", call: "callable:self.inner.stack.pop" },
          { kind: "unknown", call: "callable:obj.stack.pop" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "self.shadowed.pop" },
          { kind: "pure", call: "self.outer.pop" },
          { kind: "pure", call: "obj.stack.pop" },
        ]),
      )
    })

    it("clears common receiver-path provenance on dependency rebinding and keeps deeper shapes conservative", async () => {
      const events = await analyze(
        [
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
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "entries.append" },
          { kind: "unknown", call: "callable:entries.append" },
          { kind: "pure", call: "entries.append" },
          { kind: "unknown", call: "callable:entries.append" },
          { kind: "unknown", call: "callable:factory" },
          { kind: "unknown", call: "callable:entries.pop" },
          { kind: "pure", call: "state.stack.pop" },
          { kind: "unknown", call: "callable:other_state.stack.pop" },
          { kind: "pure", call: "other_state.inner.stack.pop" },
          { kind: "unknown", call: "callable:other_state.inner.stack.pop" },
          { kind: "unknown", call: "callable:other_state.shadow.pop" },
          { kind: "unknown", call: "callable:helper" },
          { kind: "unknown", call: "callable:entries.append" },
          { kind: "unknown", call: "callable:other_state.inner.deep.stack.pop" },
          { kind: "unknown", call: "callable:obj.stack.pop" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "other_state.shadow.pop" },
          { kind: "pure", call: "other_state.inner.deep.stack.pop" },
          { kind: "pure", call: "obj.stack.pop" },
        ]),
      )
    })

    it("keeps shadowed, callback-customized, and unresolved builtin helpers conservative", async () => {
      const events = await analyze(
        [
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
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:max" },
          { kind: "unknown", call: "callable:min" },
          { kind: "unknown", call: "callable:list" },
          { kind: "unknown", call: "callable:list.sort" },
          { kind: "unknown", call: "callable:dict.get" },
          { kind: "unknown", call: "callable:sorted" },
          { kind: "unknown", call: "callable:json.loads" },
          { kind: "unknown", call: "callable:json.loads.get" },
          { kind: "unknown", call: "callable:obj.sort" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "max" },
          { kind: "pure", call: "min" },
          { kind: "pure", call: "sorted" },
          { kind: "pure", call: "obj.sort" },
          { kind: "pure", call: "list.sort" },
        ]),
      )
    })

    it("classifies standard builtin exception constructors and bare raises as pure", async () => {
      const events = await analyze(
        [
          "raise ValueError",
          "raise RuntimeError('bad input')",
          "err = TypeError()",
          "raise AssertionError from cause",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "ValueError" },
          { kind: "pure", call: "RuntimeError" },
          { kind: "pure", call: "TypeError" },
          { kind: "pure", call: "AssertionError" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:ValueError" },
          { kind: "unknown", call: "callable:RuntimeError" },
          { kind: "unknown", call: "callable:TypeError" },
          { kind: "unknown", call: "callable:AssertionError" },
        ]),
      )
    })

    it("keeps shadowed and custom raise targets conservative", async () => {
      const events = await analyze(
        [
          "ValueError = make_error",
          "raise ValueError()",
          "class CustomError(Exception):",
          "    pass",
          "raise CustomError()",
          "raise err",
          "raise make_error()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:CustomError" },
          { kind: "unknown", call: "callable:make_error" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "ValueError" },
          { kind: "pure", call: "CustomError" },
        ]),
      )
    })

    it("keeps rebound standard exception names conservative across scope forms", async () => {
      const events = await analyze(
        [
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
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:manager" },
          { kind: "unknown", call: "callable:ValueError" },
          { kind: "pure", call: "RuntimeError" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "ValueError" }]))
    })

    it("keeps dict.fromkeys conservative when dict is shadowed locally", async () => {
      const events = await analyze(
        [
          "class dict:",
          "    @staticmethod",
          "    def fromkeys(seq):",
          "        return seq",
          "dict.fromkeys(seq)",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:dict.fromkeys" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "dict.fromkeys" }]))
    })

    it("keeps dict.fromkeys conservative when dict is shadowed by a parameter", async () => {
      const events = await analyze(
        [
          "def f(dict):",
          "    return dict.fromkeys(seq)",
          "f(mapping)",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:dict.fromkeys" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "dict.fromkeys" }]))
    })

    it("keeps dict.fromkeys conservative when dict is imported locally", async () => {
      const events = await analyze(
        [
          "from builtins import dict",
          "dict.fromkeys(seq)",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:dict.fromkeys" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "dict.fromkeys" }]))
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

    it("classifies counter arithmetic temporaries before elements as pure", async () => {
      const events = await analyze(
        [
          "import collections",
          "sorted((collections.Counter(expected_inline) - collections.Counter(cur_inline)).elements())",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "collections.Counter" },
          { kind: "pure", call: "elements" },
          { kind: "pure", call: "sorted" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:elements" }]))
    })

    it("classifies exact sqlite cursor execute and fetchone chains with provenance-backed source calls", async () => {
      const events = await analyze(
        [
          "import sqlite3",
          "conn = sqlite3.connect('app.db')",
          "cur = conn.cursor()",
          "cur.execute('select id from session where id = ?', (session_id,))",
          "cur.fetchone()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "sqlite3.connect" },
          { kind: "exec", call: "sqlite3.Connection.cursor" },
          { kind: "exec", call: "sqlite3.Cursor.execute" },
          { kind: "read", call: "sqlite3.Cursor.fetchone" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:cur.execute" },
          { kind: "unknown", call: "callable:cur.fetchone" },
          { kind: "unknown", call: "callable:conn.cursor" },
        ]),
      )
    })

    it("classifies sqlite execute.fetchall chains as read only after execute", async () => {
      const chainEvents = await analyze(
        [
          "import sqlite3",
          "conn = sqlite3.connect('app.db')",
          "cur = conn.cursor()",
          "cur.execute('select id from session').fetchall()",
        ].join("\n"),
      )

      const noExecuteEvents = await analyze(
        [
          "import sqlite3",
          "conn = sqlite3.connect('app.db')",
          "cur = conn.cursor()",
          "cur.fetchall()",
        ].join("\n"),
      )

      expect(chainEvents).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "sqlite3.Connection.cursor" },
          { kind: "exec", call: "sqlite3.Cursor.execute" },
          { kind: "read", call: "sqlite3.Cursor.fetchall" },
        ]),
      )
      expect(noExecuteEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:cur.fetchall" }]))
      expect(noExecuteEvents).not.toEqual(expect.arrayContaining([{ kind: "read", call: "sqlite3.Cursor.fetchall" }]))
    })

    it("keeps sqlite fetchone conservative without a tracked execute proof", async () => {
      const noExecuteEvents = await analyze(
        [
          "import sqlite3",
          "conn = sqlite3.connect('app.db')",
          "cur = conn.cursor()",
          "cur.fetchone()",
        ].join("\n"),
      )

      const aliasExecuteEvents = await analyze(
        [
          "import sqlite3",
          "conn = sqlite3.connect('app.db')",
          "cur = conn.cursor()",
          "alias = cur",
          "alias.execute('select 1')",
          "cur.fetchone()",
        ].join("\n"),
      )

      expect(noExecuteEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:cur.fetchone" }]))
      expect(noExecuteEvents).not.toEqual(expect.arrayContaining([{ kind: "read", call: "cur.fetchone" }]))
      expect(aliasExecuteEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:cur.fetchone" }]))
      expect(aliasExecuteEvents).not.toEqual(expect.arrayContaining([{ kind: "read", call: "sqlite3.Cursor.fetchone" }]))
    })

    it("keeps sqlite fetchone bound to the same cursor object and clears after close", async () => {
      const reboundOldAliasEvents = await analyze(
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

      const reboundNewCursorEvents = await analyze(
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

      const closedCursorEvents = await analyze(
        [
          "import sqlite3",
          "conn = sqlite3.connect('app.db')",
          "cur = conn.cursor()",
          "cur.execute('select 1')",
          "cur.close()",
          "cur.fetchone()",
        ].join("\n"),
      )

      for (const events of [reboundOldAliasEvents, closedCursorEvents]) {
        expect(events).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:cur.fetchone" }]))
        expect(events).not.toEqual(expect.arrayContaining([{ kind: "read", call: "sqlite3.Cursor.fetchone" }]))
      }
      expect(reboundNewCursorEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:cur.fetchone" }]))
      expect(reboundNewCursorEvents).not.toEqual(expect.arrayContaining([{ kind: "read", call: "sqlite3.Cursor.fetchone" }]))
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
      const events = await analyze(
        ["pickle.load(handle)", "pickle.loads(data)", "marshal.load(handle)", "marshal.loads(data)"].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "pickle.load" },
          { kind: "exec", call: "pickle.loads" },
          { kind: "exec", call: "marshal.load" },
          { kind: "exec", call: "marshal.loads" },
        ]),
      )
    })
  })

})
