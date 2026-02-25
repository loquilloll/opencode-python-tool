import { describe, expect, it } from "bun:test"
import { analyze } from "../tool/python-analyze"

describe("python analyzer", () => {
  describe("open() mode and path handling", () => {
    it("classifies positional and keyword read/write modes", async () => {
      expect(await analyze("open('f')")).toEqual([{ kind: "read", call: "open", path: "f" }])
      expect(await analyze("open('f', 'r')")).toEqual([{ kind: "read", call: "open", path: "f" }])
      expect(await analyze("open('f', 'rb')")).toEqual([{ kind: "read", call: "open", path: "f" }])
      expect(await analyze("open('f', 'w')")).toEqual([{ kind: "write", call: "open", path: "f" }])
      expect(await analyze("open('f', 'a')")).toEqual([{ kind: "write", call: "open", path: "f" }])
      expect(await analyze("open('f', 'x')")).toEqual([{ kind: "write", call: "open", path: "f" }])
      expect(await analyze("open('f', 'r+')")).toEqual([{ kind: "write", call: "open", path: "f" }])
      expect(await analyze("open(file='f', mode='w')")).toEqual([{ kind: "write", call: "open", path: "f" }])
    })

    it("classifies dynamic mode and dynamic path", async () => {
      expect(await analyze("open('f', mode_var)")).toEqual([{ kind: "unknown", call: "open-mode-dynamic" }])
      expect(await analyze("open(file_var)")).toEqual([{ kind: "read", call: "open", dynamicPath: true }])
      expect(await analyze("open(f'/tmp/{name}')")).toEqual([{ kind: "read", call: "open", dynamicPath: true }])
    })

    it("parses concatenated, triple, and raw string paths", async () => {
      expect(await analyze("open('a' 'b')")).toEqual([{ kind: "read", call: "open", path: "ab" }])
      expect(await analyze('open("""f""")')).toEqual([{ kind: "read", call: "open", path: "f" }])
      expect(await analyze("open(r'/tmp/f')")).toEqual([{ kind: "read", call: "open", path: "/tmp/f" }])
    })

    it("detects open in with statements", async () => {
      const events = await analyze("with open('data.txt') as handle:\n    pass")
      expect(events).toEqual([{ kind: "read", call: "open", path: "data.txt" }])
    })
  })

  describe("Path method classification", () => {
    it("classifies Path read/write methods with path extraction", async () => {
      const events = await analyze(
        [
          "Path('f').read_text()",
          "Path('f').read_bytes()",
          "Path('f').write_text('x')",
          "Path('f').write_bytes(b'x')",
          "Path('f').mkdir()",
          "Path('f').unlink()",
          "Path('f').touch()",
          "Path('f').rename('g')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "Path.read_text", path: "f" },
          { kind: "read", call: "Path.read_bytes", path: "f" },
          { kind: "write", call: "Path.write_text", path: "f" },
          { kind: "write", call: "Path.write_bytes", path: "f" },
          { kind: "write", call: "Path.mkdir", path: "f" },
          { kind: "write", call: "Path.unlink", path: "f" },
          { kind: "write", call: "Path.touch", path: "f" },
          { kind: "write", call: "Path.rename", path: "f" },
        ]),
      )
    })

    it("marks dynamic Path constructor arguments as dynamicPath", async () => {
      const events = await analyze("Path(path_var).read_text()")
      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "Path.read_text", dynamicPath: true },
          { kind: "unknown", call: "callable:Path" },
        ]),
      )
    })
  })

  describe("os/shutil write classification", () => {
    it("classifies path writes and destination path behavior", async () => {
      const events = await analyze(
        [
          "os.remove('f')",
          "os.unlink('f')",
          "os.makedirs('d')",
          "os.rename('a', 'b')",
          "os.replace('a', 'b')",
          "shutil.copy('a', 'b')",
          "shutil.copytree('a', 'b')",
          "shutil.move('a', 'b')",
          "shutil.rmtree('d')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "write", call: "os.remove", path: "f" },
          { kind: "write", call: "os.unlink", dynamicPath: true },
          { kind: "write", call: "os.makedirs", path: "d" },
          { kind: "write", call: "os.rename", dynamicPath: true },
          { kind: "write", call: "os.replace", dynamicPath: true },
          { kind: "write", call: "shutil.copy", path: "b" },
          { kind: "write", call: "shutil.copytree", path: "b" },
          { kind: "write", call: "shutil.move", path: "b" },
          { kind: "write", call: "shutil.rmtree", path: "d" },
        ]),
      )
    })

    it("supports keyword dynamic path arguments", async () => {
      const events = await analyze("os.remove(path=target_path)")
      expect(events).toEqual([{ kind: "write", call: "os.remove", dynamicPath: true }])
    })
  })

  describe("json/yaml classification", () => {
    it("classifies json and yaml read/write calls", async () => {
      const events = await analyze([
        "json.load(f)",
        "json.dump(data, f)",
        "yaml.safe_load(f)",
        "yaml.dump(data, f)",
      ].join("\n"))

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "json.load" },
          { kind: "write", call: "json.dump" },
          { kind: "read", call: "yaml.safe_load" },
          { kind: "write", call: "yaml.dump" },
        ]),
      )
    })
  })

  describe("exec classification", () => {
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

  describe("phase 5 network/db/tempfile/deserialization", () => {
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

    it("keeps alias calls as callable unknowns", async () => {
      const events = await analyze("import requests as rq\nrq.get('https://example.com')")
      expect(events).toEqual([{ kind: "unknown", call: "callable:rq.get" }])
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
          { kind: "exec", call: "requests.get" },
          { kind: "write", call: "Path.write_text", path: "class.txt" },
          { kind: "write", call: "os.remove", path: "nested.txt" },
          { kind: "read", call: "open", dynamicPath: true },
        ]),
      )
    })
  })
})
