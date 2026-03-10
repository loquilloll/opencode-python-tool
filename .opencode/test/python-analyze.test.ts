import { describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { analyze, analyzeDetailed } from "../tool/python-analyze"

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
          "Path('f').exists()",
          "Path('f').read_text()",
          "Path('f').read_bytes()",
          "Path('f').write_text('x')",
          "Path('f').write_bytes(b'x')",
          "Path('f').mkdir()",
          "Path('f').unlink()",
          "Path('f').touch()",
          "Path('f').rename('g')",
          "Path('f').replace('g')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "Path.exists", path: "f" },
          { kind: "read", call: "Path.read_text", path: "f" },
          { kind: "read", call: "Path.read_bytes", path: "f" },
          { kind: "write", call: "Path.write_text", path: "f" },
          { kind: "write", call: "Path.write_bytes", path: "f" },
          { kind: "write", call: "Path.mkdir", path: "f" },
          { kind: "write", call: "Path.unlink", path: "f" },
          { kind: "write", call: "Path.touch", path: "f" },
          { kind: "write", call: "Path.rename", path: "f" },
          { kind: "write", call: "Path.replace", path: "f" },
        ]),
      )
    })

    it("marks dynamic Path constructor arguments as dynamicPath", async () => {
      const events = await analyze("Path(path_var).read_text()")
      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "Path.read_text", dynamicPath: true },
          { kind: "pure", call: "Path" },
        ]),
      )
    })

    it("resolves explicit Path aliases before method classification", async () => {
      const events = await analyze("from pathlib import Path as P\nP('f').read_text()")
      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "pathlib.Path.read_text", path: "f" },
          { kind: "pure", call: "pathlib.Path" },
        ]),
      )
    })

    it("tracks Path aliases and join helpers without constructor noise", async () => {
      const events = await analyze(
        [
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
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "pathlib.Path" },
          { kind: "read", call: "p.exists", path: "f", sourceCall: "pathlib.Path.exists" },
          { kind: "read", call: "p.read_text", path: "f", sourceCall: "pathlib.Path.read_text" },
          { kind: "write", call: "out.write_text", path: "o", sourceCall: "pathlib.Path.write_text" },
          { kind: "pure", call: "pathlib.Path.cwd" },
          { kind: "read", call: "src.read_text", dynamicPath: true, sourceCall: "pathlib.Path.read_text" },
          { kind: "pure", call: "src.read_text.splitlines" },
          { kind: "pure", call: "src.joinpath", sourceCall: "pathlib.Path.joinpath" },
          { kind: "read", call: "child.read_text", dynamicPath: true, sourceCall: "pathlib.Path.read_text" },
          { kind: "pure", call: "os.path.join" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:Path" },
          { kind: "unknown", call: "callable:pathlib.Path" },
          { kind: "unknown", call: "callable:p.exists" },
          { kind: "unknown", call: "callable:p.read_text" },
          { kind: "unknown", call: "callable:out.write_text" },
          { kind: "unknown", call: "callable:src.read_text" },
          { kind: "unknown", call: "callable:os.path.join" },
        ]),
      )
    })

    it("tracks bounded iterated Path receivers in loops and comprehensions", async () => {
      const events = await analyze(
        [
          "from pathlib import Path",
          "root = Path('/docs')",
          "expected = [root / 'README.md', root / 'CONTINUITY.md']",
          "missing = [str(p) for p in expected if not p.exists()]",
          "for p in expected:",
          "    p.exists()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "p.exists", dynamicPath: true, sourceCall: "pathlib.Path.exists" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:p.exists" }]))
    })

    it("keeps arbitrary Path-like receivers conservative", async () => {
      const events = await analyze("obj.exists()\nobj.read_text()\nobj.write_text('x')\nobj.joinpath('a')")
      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:obj.exists" },
          { kind: "unknown", call: "callable:obj.read_text" },
          { kind: "unknown", call: "callable:obj.write_text" },
          { kind: "unknown", call: "callable:obj.joinpath" },
        ]),
      )
    })

    it("classifies all standard string methods on tracked text values as pure", async () => {
      const events = await analyze(
        [
          "'\\n'.join(parts)",
          "'x'.replace('x', 'y')",
          "text = Path('f').read_text()",
          "text.capitalize()",
          "text.casefold()",
          "text.center(10)",
          "text.find(needle)",
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
          "from pathlib import Path as P",
          "data = P('g').read_text()",
          "data.partition('x')",
          "data.removeprefix('x')",
          "data.removesuffix('x')",
          "literal = 'a' 'b'",
          "literal.split('b')",
          "Path('h').read_text().lower()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "join" },
          { kind: "pure", call: "replace" },
          { kind: "read", call: "Path.read_text", path: "f" },
          { kind: "pure", call: "text.capitalize" },
          { kind: "pure", call: "text.casefold" },
          { kind: "pure", call: "text.center" },
          { kind: "pure", call: "text.find" },
          { kind: "pure", call: "text.count" },
          { kind: "pure", call: "text.encode" },
          { kind: "pure", call: "text.endswith" },
          { kind: "pure", call: "text.expandtabs" },
          { kind: "pure", call: "text.format" },
          { kind: "pure", call: "text.format_map" },
          { kind: "pure", call: "text.index" },
          { kind: "pure", call: "text.isalnum" },
          { kind: "pure", call: "text.isalpha" },
          { kind: "pure", call: "text.isascii" },
          { kind: "pure", call: "text.isdecimal" },
          { kind: "pure", call: "text.isdigit" },
          { kind: "pure", call: "text.isidentifier" },
          { kind: "pure", call: "text.islower" },
          { kind: "pure", call: "text.isnumeric" },
          { kind: "pure", call: "text.isprintable" },
          { kind: "pure", call: "text.isspace" },
          { kind: "pure", call: "text.istitle" },
          { kind: "pure", call: "text.isupper" },
          { kind: "pure", call: "text.join" },
          { kind: "pure", call: "text.ljust" },
          { kind: "pure", call: "text.lower" },
          { kind: "pure", call: "text.lstrip" },
          { kind: "pure", call: "text.replace" },
          { kind: "pure", call: "text.rfind" },
          { kind: "pure", call: "text.rindex" },
          { kind: "pure", call: "text.rjust" },
          { kind: "pure", call: "text.rpartition" },
          { kind: "pure", call: "text.rsplit" },
          { kind: "pure", call: "text.rstrip" },
          { kind: "pure", call: "text.split" },
          { kind: "pure", call: "text.splitlines" },
          { kind: "pure", call: "text.startswith" },
          { kind: "pure", call: "text.strip" },
          { kind: "pure", call: "text.swapcase" },
          { kind: "pure", call: "text.title" },
          { kind: "pure", call: "text.translate" },
          { kind: "pure", call: "text.upper" },
          { kind: "pure", call: "text.zfill" },
          { kind: "read", call: "pathlib.Path.read_text", path: "g" },
          { kind: "pure", call: "data.partition" },
          { kind: "pure", call: "data.removeprefix" },
          { kind: "pure", call: "data.removesuffix" },
          { kind: "pure", call: "literal.split" },
          { kind: "pure", call: "Path.read_text.lower" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:join" },
          { kind: "unknown", call: "callable:replace" },
          { kind: "unknown", call: "callable:text.join" },
          { kind: "unknown", call: "callable:text.find" },
          { kind: "unknown", call: "callable:text.replace" },
          { kind: "unknown", call: "callable:data.partition" },
          { kind: "unknown", call: "callable:literal.split" },
          { kind: "unknown", call: "callable:Path.read_text.lower" },
        ]),
      )
    })

    it("keeps tracked string provenance across self-reassignment", async () => {
      const events = await analyze(
        [
          "from pathlib import Path",
          "readme = Path('README.md')",
          "text = readme.read_text()",
          "old = 'alpha'",
          "new = 'beta'",
          "text = text.replace(old, new, 1)",
          "text = text.replace(new, old, 1)",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "pathlib.Path" },
          { kind: "read", call: "readme.read_text", path: "README.md", sourceCall: "pathlib.Path.read_text" },
          { kind: "pure", call: "text.replace" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:text.replace" }]))
    })

    it("keeps arbitrary and unsupported string-like receivers conservative", async () => {
      const events = await analyze(
        [
          "obj.find(needle)",
          "obj.replace('a', 'b')",
          "open('f').read().find('x')",
          "open('f').read().replace('a', 'b')",
          "text = open('g').read()",
          "text = text.replace('a', 'b')",
          "str(value).find('x')",
          "str(value).replace('a', 'b')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:obj.find" },
          { kind: "unknown", call: "callable:obj.replace" },
          { kind: "unknown", call: "callable:open.read.find" },
          { kind: "unknown", call: "callable:open.read.replace" },
          { kind: "unknown", call: "callable:text.replace" },
          { kind: "unknown", call: "callable:str.find" },
          { kind: "unknown", call: "callable:str.replace" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "obj.find" },
          { kind: "pure", call: "obj.replace" },
          { kind: "pure", call: "open.read.find" },
          { kind: "pure", call: "open.read.replace" },
          { kind: "pure", call: "str.find" },
          { kind: "pure", call: "str.replace" },
          { kind: "write", call: "obj.replace" },
          { kind: "write", call: "open.read.replace" },
          { kind: "write", call: "str.replace" },
        ]),
      )
    })

    it("tracks bounded loop variables from string split helpers", async () => {
      const events = await analyze(
        [
          "lines = Path('f').read_text().splitlines()",
          "for line in lines:",
          "    line.strip()",
          "for _, item in enumerate(lines):",
          "    item.strip()",
          "for _, later in enumerate(lines[1:]):",
          "    later.strip()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "Path.read_text", path: "f" },
          { kind: "pure", call: "Path.read_text.splitlines" },
          { kind: "pure", call: "line.strip" },
          { kind: "pure", call: "enumerate" },
          { kind: "pure", call: "item.strip" },
          { kind: "pure", call: "later.strip" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:line.strip" },
          { kind: "unknown", call: "callable:item.strip" },
          { kind: "unknown", call: "callable:later.strip" },
        ]),
      )
    })

    it("keeps unsupported loop string provenance conservative", async () => {
      const events = await analyze(
        [
          "lines = open('f').read().splitlines()",
          "for line in lines:",
          "    line.strip()",
          "enumerate = custom",
          "safe_lines = Path('g').read_text().splitlines()",
          "for _, item in enumerate(safe_lines):",
          "    item.strip()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "open", path: "f" },
          { kind: "unknown", call: "callable:open.read" },
          { kind: "unknown", call: "callable:open.read.splitlines" },
          { kind: "unknown", call: "callable:line.strip" },
          { kind: "read", call: "Path.read_text", path: "g" },
          { kind: "pure", call: "Path.read_text.splitlines" },
          { kind: "unknown", call: "callable:custom" },
          { kind: "unknown", call: "callable:item.strip" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "line.strip" },
          { kind: "pure", call: "item.strip" },
        ]),
      )
    })

    it("classifies builtin functions from the docs page with bounded categories", async () => {
      const events = await analyze(
        [
          "abs(x)",
          "aiter(xs)",
          "all(xs)",
          "anext(xs, None)",
          "any(xs)",
          "ascii(x)",
          "bin(n)",
          "bool(x)",
          "breakpoint()",
          "bytearray(b'x')",
          "bytes(b'x')",
          "callable(fn)",
          "chr(code)",
          "classmethod(fn)",
          "compile('x=1', '<s>', 'exec')",
          "complex('1+2j')",
          "delattr(obj, 'field')",
          "dict(pairs)",
          "dir(obj)",
          "divmod(a, b)",
          "enumerate(xs)",
          "eval('1+1')",
          "exec('x=1')",
          "filter(None, xs)",
          "float('1.2')",
          "format(x)",
          "frozenset(xs)",
          "getattr(obj, 'field', None)",
          "globals()",
          "hasattr(obj, 'field')",
          "hash(x)",
          "help(obj)",
          "hex(n)",
          "id(x)",
          "input('> ')",
          "int('10')",
          "isinstance(x, typ)",
          "issubclass(typ, base)",
          "iter(xs)",
          "len(xs)",
          "list(xs)",
          "locals()",
          "map(fn, xs)",
          "max(xs)",
          "memoryview(buf)",
          "min(xs)",
          "next(xs, None)",
          "object()",
          "oct(n)",
          "open('f')",
          "ord('a')",
          "pow(a, b)",
          "print('x')",
          "property(fn)",
          "range(3)",
          "repr(x)",
          "reversed(xs)",
          "round(n)",
          "set(xs)",
          "setattr(obj, 'field', value)",
          "slice(1, 2)",
          "sorted(xs)",
          "staticmethod(fn)",
          "str(x)",
          "sum(xs)",
          "super()",
          "tuple(xs)",
          "type(x)",
          "vars(obj)",
          "zip(a, b)",
          "__import__('os')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "abs" },
          { kind: "pure", call: "aiter" },
          { kind: "pure", call: "anext" },
          { kind: "pure", call: "bytearray" },
          { kind: "pure", call: "classmethod" },
          { kind: "pure", call: "delattr" },
          { kind: "pure", call: "enumerate" },
          { kind: "pure", call: "filter" },
          { kind: "pure", call: "format" },
          { kind: "pure", call: "getattr" },
        ]),
      )
      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "input" },
          { kind: "read", call: "open", path: "f" },
          { kind: "emit", call: "help" },
          { kind: "emit", call: "print" },
          { kind: "exec", call: "breakpoint" },
          { kind: "exec", call: "compile" },
          { kind: "exec", call: "eval" },
          { kind: "exec", call: "exec" },
          { kind: "exec", call: "__import__" },
          { kind: "pure", call: "type" },
        ]),
      )
    })

    it("keeps shadowed and special-case builtins conservative", async () => {
      const events = await analyze(
        [
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
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:reader" },
          { kind: "unknown", call: "callable:logger" },
          { kind: "unknown", call: "callable:helper" },
          { kind: "unknown", call: "callable:trap" },
          { kind: "unknown", call: "callable:opener" },
          { kind: "unknown", call: "callable:builder" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "read", call: "input" },
          { kind: "emit", call: "print" },
          { kind: "emit", call: "help" },
          { kind: "exec", call: "breakpoint" },
          { kind: "read", call: "open" },
          { kind: "pure", call: "type" },
        ]),
      )
    })

    it("classifies tracked built-in type methods beyond strings as pure", async () => {
      const events = await analyze(
        [
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
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "tup.count" },
          { kind: "pure", call: "tup.index" },
          { kind: "pure", call: "rng.count" },
          { kind: "pure", call: "rng.index" },
          { kind: "read", call: "pathlib.Path.read_bytes", path: "data.bin" },
          { kind: "pure", call: "blob.decode" },
          { kind: "pure", call: "blob.hex" },
          { kind: "pure", call: "blob.join" },
          { kind: "pure", call: "blob.translate" },
          { kind: "pure", call: "raw.startswith" },
          { kind: "pure", call: "raw.zfill" },
          { kind: "pure", call: "buf.append" },
          { kind: "pure", call: "buf.pop" },
          { kind: "pure", call: "buf.decode" },
          { kind: "pure", call: "buf.replace" },
          { kind: "pure", call: "view.tobytes" },
          { kind: "pure", call: "view.hex" },
          { kind: "pure", call: "view.release" },
          { kind: "pure", call: "num.bit_length" },
          { kind: "pure", call: "num.to_bytes" },
          { kind: "pure", call: "flt.hex" },
          { kind: "pure", call: "flt.is_integer" },
          { kind: "pure", call: "comp.conjugate" },
          { kind: "pure", call: "hex" },
        ]),
      )
    })

    it("keeps unsupported built-in type method receivers and return-chain cases conservative", async () => {
      const events = await analyze(
        [
          "obj.decode('utf8')",
          "obj.join(parts)",
          "obj.bit_length()",
          "obj.tobytes()",
          "open('f', 'rb').read().decode('utf8')",
          "data = Path('f').read_bytes()",
          "data.decode('utf8').split(',')",
          "str(value).encode('utf8')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:obj.decode" },
          { kind: "unknown", call: "callable:obj.join" },
          { kind: "unknown", call: "callable:obj.bit_length" },
          { kind: "unknown", call: "callable:obj.tobytes" },
          { kind: "unknown", call: "callable:open.read.decode" },
          { kind: "read", call: "Path.read_bytes", path: "f" },
          { kind: "pure", call: "data.decode" },
          { kind: "unknown", call: "callable:data.decode.split" },
          { kind: "unknown", call: "callable:str.encode" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "obj.decode" },
          { kind: "pure", call: "obj.join" },
          { kind: "pure", call: "obj.bit_length" },
          { kind: "pure", call: "obj.tobytes" },
          { kind: "pure", call: "open.read.decode" },
          { kind: "pure", call: "data.decode.split" },
          { kind: "pure", call: "str.encode" },
        ]),
      )
    })

    it("keeps shadowed built-in type constructors from seeding tracked methods", async () => {
      const events = await analyze(
        [
          "bytes = factory",
          "blob = bytes(seq)",
          "blob.hex()",
          "range = maker",
          "rng = range(3)",
          "rng.count(1)",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:factory" },
          { kind: "unknown", call: "callable:blob.hex" },
          { kind: "unknown", call: "callable:maker" },
          { kind: "unknown", call: "callable:rng.count" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "blob.hex" },
          { kind: "pure", call: "rng.count" },
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
          { kind: "write", call: "os.unlink", path: "f" },
          { kind: "write", call: "os.makedirs", path: "d" },
          { kind: "write", call: "os.rename", path: "b" },
          { kind: "write", call: "os.replace", path: "b" },
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
    it("classifies json and yaml read/write calls and keeps json.loads pure", async () => {
      const events = await analyze([
        "json.load(f)",
        "json.loads(text)",
        "json.dump(data, f)",
        "yaml.safe_load(f)",
        "yaml.dump(data, f)",
      ].join("\n"))

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "json.load" },
          { kind: "pure", call: "json.loads" },
          { kind: "write", call: "json.dump" },
          { kind: "read", call: "yaml.safe_load" },
          { kind: "write", call: "yaml.dump" },
        ]),
      )
    })

    it("tracks json-derived container methods as pure while keeping customized decoders conservative", async () => {
      const events = await analyze([
        "base = json.loads(text)",
        "base.setdefault('calls', {})",
        "values = json.load(f)",
        "values.update({'x': 1})",
        "custom = json.loads(text, object_hook=hook)",
        "custom.setdefault('calls', {})",
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
      ].join("\n"))

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "json.loads" },
          { kind: "pure", call: "base.setdefault" },
          { kind: "read", call: "json.load" },
          { kind: "pure", call: "values.update" },
          { kind: "unknown", call: "callable:json.loads" },
          { kind: "unknown", call: "callable:custom.setdefault" },
          { kind: "unknown", call: "callable:numbers.setdefault" },
          { kind: "unknown", call: "callable:pairs.update" },
          { kind: "unknown", call: "callable:decoded.update" },
          { kind: "unknown", call: "callable:ints.setdefault" },
          { kind: "unknown", call: "callable:constants.setdefault" },
          { kind: "unknown", call: "callable:spread.setdefault" },
          { kind: "unknown", call: "callable:decoder.update" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "write", call: "base.setdefault" }]))
    })

    it("tracks json-derived iteration items and next() results as pure", async () => {
      const events = await analyze([
        "plan = json.loads(text)",
        "for item in plan.get('ok', []):",
        "    item.get('frontmatter', {})",
        "plan_04 = next((item for item in plan.get('ok', [])), None)",
        "plan_04.get('content', '')",
      ].join("\n"))

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "json.loads" },
          { kind: "pure", call: "plan.get" },
          { kind: "pure", call: "item.get" },
          { kind: "pure", call: "plan_04.get" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:item.get" },
          { kind: "unknown", call: "callable:plan_04.get" },
        ]),
      )
    })

    it("tracks plain tracked-response json fallback and derived iteration as pure", async () => {
      const events = await analyze([
        "import requests",
        "response = requests.get('https://example.com')",
        "payload = response.json() or {}",
        "payload.get('ok', [])",
        "for item in payload.get('ok', []):",
        "    item.get('frontmatter', {})",
      ].join("\n"))

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "requests.get" },
          { kind: "pure", call: "response.json" },
          { kind: "pure", call: "payload.get" },
          { kind: "pure", call: "item.get" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:response.json" },
          { kind: "unknown", call: "callable:payload.get" },
          { kind: "unknown", call: "callable:item.get" },
        ]),
      )
    })

    it("keeps arbitrary and customized response json calls conservative", async () => {
      const events = await analyze([
        "payload = obj.json() or {}",
        "payload.get('ok', [])",
        "import requests",
        "response = requests.get('https://example.com')",
        "custom = response.json(parse_float=hook)",
        "custom.get('ok', [])",
      ].join("\n"))

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:obj.json" },
          { kind: "unknown", call: "callable:payload.get" },
          { kind: "read", call: "requests.get" },
          { kind: "unknown", call: "callable:response.json" },
          { kind: "unknown", call: "callable:custom.get" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "obj.json" },
          { kind: "pure", call: "payload.get" },
          { kind: "pure", call: "response.json" },
          { kind: "pure", call: "custom.get" },
        ]),
      )
    })

    it("keeps shadowed tracked response names conservative", async () => {
      const events = await analyze([
        "import requests",
        "response = requests.get('https://example.com')",
        "response.json()",
        "def use_param(response):",
        "    response.json()",
        "def use_local():",
        "    response = obj",
        "    response.json()",
      ].join("\n"))

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "requests.get" },
          { kind: "pure", call: "response.json" },
          { kind: "unknown", call: "callable:response.json" },
        ]),
      )
    })
  })

  describe("emit and pure classification", () => {
    it("classifies print/logging/warnings calls as emit", async () => {
      const events = await analyze([
        "print('hello')",
        "logging.info('ok')",
        "logging.warning('careful')",
        "warnings.warn('deprecated')",
      ].join("\n"))

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "emit", call: "print" },
          { kind: "emit", call: "logging.info" },
          { kind: "emit", call: "logging.warning" },
          { kind: "emit", call: "warnings.warn" },
        ]),
      )
    })

    it("classifies obvious regex calls as pure", async () => {
      const events = await analyze([
        "re.search('a+', text)",
        "re.findall('a+', text)",
        "re.match('a+', text)",
      ].join("\n"))

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "re.search" },
          { kind: "pure", call: "re.findall" },
          { kind: "pure", call: "re.match" },
        ]),
      )
    })

    it("classifies regex match-result methods as pure", async () => {
      const events = await analyze(
        [
          "match = re.search('a+', text)",
          "match.group(1)",
          "match.groups()",
          "match.groupdict()",
          "match.start()",
          "match.end()",
          "match.span()",
          "re.match('a+', text).span()",
          "re.fullmatch('a+', text).group(0)",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "re.search" },
          { kind: "pure", call: "match.group" },
          { kind: "pure", call: "match.groups" },
          { kind: "pure", call: "match.groupdict" },
          { kind: "pure", call: "match.start" },
          { kind: "pure", call: "match.end" },
          { kind: "pure", call: "match.span" },
          { kind: "pure", call: "re.match.span" },
          { kind: "pure", call: "re.fullmatch.group" },
        ]),
      )
    })

    it("keeps arbitrary group-like receivers conservative", async () => {
      const events = await analyze("obj.group(1)\nobj.span()")
      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:obj.group" },
          { kind: "unknown", call: "callable:obj.span" },
        ]),
      )
    })

    it("keeps unbound join calls conservative", async () => {
      const events = await analyze("join('a', 'b')")
      expect(events).toEqual([{ kind: "unknown", call: "callable:join" }])
    })

    it("keeps unknown method-tail calls as unknown", async () => {
      const events = await analyze("service.info('ok')\nservice.search('a+')")
      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:service.info" },
          { kind: "unknown", call: "callable:service.search" },
        ]),
      )
    })

    it("keeps re.sub outside pure classification", async () => {
      const events = await analyze("re.sub('a+', '-', text)")
      expect(events).toEqual([{ kind: "unknown", call: "callable:re.sub" }])
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

  describe("phase 11 oci coverage", () => {
    it("classifies known OCI constructors and pagination helpers as exec", async () => {
      const events = await analyze(
        [
          "oci.identity.IdentityClient(config)",
          "oci.core.ComputeClient(config)",
          "oci.core.VirtualNetworkClient(config)",
          "oci.object_storage.ObjectStorageClient(config)",
          "oci.database.DatabaseClient(config)",
          "oci.secrets.SecretsClient(config)",
          "oci.key_management.KmsManagementClient(config)",
          "oci.pagination.list_call_get_all_results(fetch_fn)",
          "oci.pagination.list_call_get_all_results_generator(fetch_fn)",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "oci.identity.IdentityClient" },
          { kind: "exec", call: "oci.core.ComputeClient" },
          { kind: "exec", call: "oci.core.VirtualNetworkClient" },
          { kind: "exec", call: "oci.object_storage.ObjectStorageClient" },
          { kind: "exec", call: "oci.database.DatabaseClient" },
          { kind: "exec", call: "oci.secrets.SecretsClient" },
          { kind: "exec", call: "oci.key_management.KmsManagementClient" },
          { kind: "exec", call: "oci.pagination.list_call_get_all_results" },
          { kind: "exec", call: "oci.pagination.list_call_get_all_results_generator" },
        ]),
      )
    })

    it("classifies oci.config.from_file as read with literal and dynamic paths", async () => {
      expect(await analyze("oci.config.from_file('~/.oci/config')")).toEqual([
        { kind: "read", call: "oci.config.from_file", path: "~/.oci/config" },
      ])

      expect(await analyze("oci.config.from_file(file_location=config_path)")).toEqual([
        { kind: "read", call: "oci.config.from_file", dynamicPath: true },
      ])
    })

    it("classifies chained OCI client method calls as exec", async () => {
      const events = await analyze(
        "oci.object_storage.ObjectStorageClient(config).put_object('ns', 'bucket', 'name', body)",
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "oci.object_storage.ObjectStorageClient" },
          { kind: "exec", call: "oci.object_storage.ObjectStorageClient.put_object" },
        ]),
      )
    })

    it("resolves OCI import aliases before classification", async () => {
      const events = await analyze("import oci as cloud\ncloud.object_storage.ObjectStorageClient(config)")
      expect(events).toEqual([{ kind: "exec", call: "oci.object_storage.ObjectStorageClient" }])
    })
  })

  describe("phase 12 ghapi coverage", () => {
    it("classifies direct ghapi module calls as exec", async () => {
      const events = await analyze(
        [
          "ghapi.all.GhApi(owner='o', repo='r')",
          "ghapi.core.GhApi(owner='o', repo='r')",
          "ghapi.graphql.gh_query('query { viewer { login } }')",
          "ghapi.page.paged(fetcher)",
          "ghapi.page.pages(fetcher)",
          "ghapi.auth.GhDeviceAuth()",
          "ghapi.auth.github_auth_device()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "ghapi.all.GhApi" },
          { kind: "exec", call: "ghapi.core.GhApi" },
          { kind: "exec", call: "ghapi.graphql.gh_query" },
          { kind: "exec", call: "ghapi.page.paged" },
          { kind: "exec", call: "ghapi.page.pages" },
          { kind: "exec", call: "ghapi.auth.GhDeviceAuth" },
          { kind: "exec", call: "ghapi.auth.github_auth_device" },
        ]),
      )
    })

    it("classifies GhApi convenience methods as exec", async () => {
      const events = await analyze(
        [
          "GhApi().create_gist(files={}, description='d')",
          "GhApi().create_release(tag_name='v1.0.0')",
          "GhApi.delete_release(release_id=1)",
          "GhApi.upload_file(path='dist.tgz')",
          "GhApi.enable_pages()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "GhApi.create_gist" },
          { kind: "exec", call: "GhApi.create_release" },
          { kind: "exec", call: "GhApi.delete_release" },
          { kind: "exec", call: "GhApi.upload_file" },
          { kind: "exec", call: "GhApi.enable_pages" },
        ]),
      )
    })

    it("classifies ghapi workflow helper calls as write", async () => {
      const events = await analyze(
        [
          "ghapi.actions.create_workflow_files(workflow='ci')",
          "ghapi.actions.create_workflow(name='ci')",
          "ghapi.actions.gh_create_workflow(name='ci')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "write", call: "ghapi.actions.create_workflow_files" },
          { kind: "write", call: "ghapi.actions.create_workflow" },
          { kind: "write", call: "ghapi.actions.gh_create_workflow" },
        ]),
      )
    })

    it("classifies GhApi instance variable group methods as normalized exec calls", async () => {
      const events = await analyze(
        [
          "api = GhApi()",
          "api.git.get_ref(owner='o', repo='r', ref='heads/main')",
          "client = ghapi.all.GhApi(owner='o', repo='r')",
          "client.issues.create(title='bug')",
          "core = ghapi.core.GhApi(owner='o', repo='r')",
          "core.repos.get(owner='o', repo='r')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "ghapi.git.get_ref" },
          { kind: "exec", call: "ghapi.issues.create" },
          { kind: "exec", call: "ghapi.repos.get" },
        ]),
      )
    })

    it("resolves ghapi import aliases before classification", async () => {
      const events = await analyze("import ghapi.all as ga\nga.GhApi(owner='o', repo='r')")
      expect(events).toEqual([{ kind: "exec", call: "ghapi.all.GhApi" }])
    })
  })

  describe("phase 13 atlassian-python-api coverage", () => {
    it("classifies Atlassian constructors and dotted call surfaces as exec", async () => {
      const events = await analyze(
        [
          "from atlassian import Jira, Confluence, Bitbucket, ServiceDesk, Crowd, Xray, CloudAdminOrgs, CloudAdminUsers",
          "Jira(url='https://example.atlassian.net')",
          "atlassian.Jira(url='https://example.atlassian.net')",
          "Confluence(url='https://example.atlassian.net/wiki')",
          "atlassian.confluence.ConfluenceCloud(url='https://example.atlassian.net/wiki')",
          "Bitbucket(url='https://bitbucket.org')",
          "atlassian.bitbucket.Cloud(username='u', password='p')",
          "ServiceDesk(url='https://example.atlassian.net')",
          "Crowd(url='https://crowd.example.com')",
          "Xray(url='https://example.atlassian.net')",
          "CloudAdminOrgs(token='x')",
          "CloudAdminUsers(token='x')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "Jira" },
          { kind: "exec", call: "atlassian.Jira" },
          { kind: "exec", call: "Confluence" },
          { kind: "exec", call: "atlassian.confluence.ConfluenceCloud" },
          { kind: "exec", call: "Bitbucket" },
          { kind: "exec", call: "atlassian.bitbucket.Cloud" },
          { kind: "exec", call: "ServiceDesk" },
          { kind: "exec", call: "Crowd" },
          { kind: "exec", call: "Xray" },
          { kind: "exec", call: "CloudAdminOrgs" },
          { kind: "exec", call: "CloudAdminUsers" },
        ]),
      )
    })

    it("classifies tracked instance methods with normalized Atlassian call IDs", async () => {
      const events = await analyze(
        [
          "from atlassian import Jira, ConfluenceServer, ServiceDesk",
          "jira = Jira(url='https://example.atlassian.net')",
          "jira.jql('project = DEMO')",
          "jira.issue_add_comment('DEMO-1', 'done')",
          "cf = ConfluenceServer(url='https://example.atlassian.net/wiki')",
          "cf.create_page(space='ENG', title='t', body='b')",
          "bb = atlassian.bitbucket.Cloud(username='u', password='p')",
          "bb.trigger_pipeline('workspace', 'repo')",
          "sd = ServiceDesk(url='https://example.atlassian.net')",
          "sd.get_queues(service_desk_id=1)",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "atlassian.jira.jql" },
          { kind: "exec", call: "atlassian.jira.issue_add_comment" },
          { kind: "exec", call: "atlassian.confluence.create_page" },
          { kind: "exec", call: "atlassian.bitbucket.trigger_pipeline" },
          { kind: "exec", call: "atlassian.servicedesk.get_queues" },
        ]),
      )
    })

    it("falls back to callable unknown for unknown methods on tracked instances", async () => {
      const events = await analyze(
        "from atlassian import Jira\njira = Jira(url='https://example.atlassian.net')\njira.unknown_method()",
      )
      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "Jira" },
          { kind: "unknown", call: "callable:jira.unknown_method" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "exec", call: "atlassian.jira.unknown_method" }]))
    })

    it("resolves Atlassian import aliases before constructor and instance tracking", async () => {
      const events = await analyze("import atlassian as atl\nclient = atl.Jira(url='https://example.atlassian.net')\nclient.jql('project = DEMO')")
      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "atlassian.Jira" },
          { kind: "exec", call: "atlassian.jira.jql" },
        ]),
      )
    })

    it("does not normalize tracked calls before assignment", async () => {
      const events = await analyze(
        [
          "from atlassian import Jira",
          "jira.jql('project = DEMO')",
          "jira = Jira(url='https://example.atlassian.net')",
          "jira.jql('project = APP')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:jira.jql" },
          { kind: "exec", call: "Jira" },
          { kind: "exec", call: "atlassian.jira.jql" },
        ]),
      )
    })

    it("invalidates tracked Atlassian instance on reassignment", async () => {
      const events = await analyze(
        [
          "from atlassian import Jira",
          "jira = Jira(url='https://example.atlassian.net')",
          "jira.jql('project = DEMO')",
          "jira = build_client()",
          "jira.jql('project = APP')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "atlassian.jira.jql" },
          { kind: "unknown", call: "callable:build_client" },
          { kind: "unknown", call: "callable:jira.jql" },
        ]),
      )
    })

    it("keeps bare constructor names as unknown without Atlassian import provenance", async () => {
      const events = await analyze(
        [
          "class Jira:",
          "    def __init__(self):",
          "        pass",
          "",
          "    def jql(self, query):",
          "        return []",
          "",
          "client = Jira()",
          "client.jql('project = DEMO')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:Jira" },
          { kind: "unknown", call: "callable:client.jql" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "exec", call: "Jira" }]))
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "exec", call: "atlassian.jira.jql" }]))
    })

    it("supports consistent module-qualified constructor variants across client families", async () => {
      const events = await analyze(
        [
          "atlassian.jira.Jira(url='https://example.atlassian.net')",
          "atlassian.confluence.Confluence(url='https://example.atlassian.net/wiki')",
          "atlassian.confluence.ConfluenceCloud(url='https://example.atlassian.net/wiki')",
          "atlassian.confluence.ConfluenceServer(url='https://example.atlassian.net/wiki')",
          "atlassian.bitbucket.Bitbucket(url='https://bitbucket.org')",
          "atlassian.bitbucket.Cloud(username='u', password='p')",
          "atlassian.servicedesk.ServiceDesk(url='https://example.atlassian.net')",
          "atlassian.service_desk.ServiceDesk(url='https://example.atlassian.net')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "atlassian.jira.Jira" },
          { kind: "exec", call: "atlassian.confluence.Confluence" },
          { kind: "exec", call: "atlassian.confluence.ConfluenceCloud" },
          { kind: "exec", call: "atlassian.confluence.ConfluenceServer" },
          { kind: "exec", call: "atlassian.bitbucket.Bitbucket" },
          { kind: "exec", call: "atlassian.bitbucket.Cloud" },
          { kind: "exec", call: "atlassian.servicedesk.ServiceDesk" },
          { kind: "exec", call: "atlassian.service_desk.ServiceDesk" },
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

  describe("rules file loading", () => {
    it("normalizes invalid json errors and retries after file fix", async () => {
      const prev = process.env.OPENCODE_PYTHON_RULES
      const dir = await mkdtemp(path.join(os.tmpdir(), "python-rules-"))
      const file = path.join(dir, "rules.json")

      try {
        process.env.OPENCODE_PYTHON_RULES = file
        await writeFile(file, '{"version":1')
        await expect(analyze("open('f')")).rejects.toThrow(/^Invalid python-rules\.json: file contains invalid JSON/)

        const src = new URL("../../src/python/python-rules.json", import.meta.url)
        await writeFile(file, await readFile(src, "utf8"))
        await expect(analyze("open('f')")).resolves.toEqual([{ kind: "read", call: "open", path: "f" }])
      } finally {
        if (prev === undefined) delete process.env.OPENCODE_PYTHON_RULES
        else process.env.OPENCODE_PYTHON_RULES = prev
        await rm(dir, { recursive: true, force: true })
      }
    })

    it("rejects unsupported rules versions", async () => {
      const prev = process.env.OPENCODE_PYTHON_RULES
      const dir = await mkdtemp(path.join(os.tmpdir(), "python-rules-"))
      const file = path.join(dir, "rules.json")

      try {
        const src = new URL("../../src/python/python-rules.json", import.meta.url)
        const data = JSON.parse(await readFile(src, "utf8")) as Record<string, unknown>
        data.version = 2
        process.env.OPENCODE_PYTHON_RULES = file
        await writeFile(file, JSON.stringify(data))
        await expect(analyze("open('f')")).rejects.toThrow("Invalid python-rules.json: version must be 1")
      } finally {
        if (prev === undefined) delete process.env.OPENCODE_PYTHON_RULES
        else process.env.OPENCODE_PYTHON_RULES = prev
        await rm(dir, { recursive: true, force: true })
      }
    })

    it("rejects malformed rules shapes", async () => {
      const prev = process.env.OPENCODE_PYTHON_RULES
      const dir = await mkdtemp(path.join(os.tmpdir(), "python-rules-"))
      const file = path.join(dir, "rules.json")

      try {
        const src = new URL("../../src/python/python-rules.json", import.meta.url)
        const data = JSON.parse(await readFile(src, "utf8")) as Record<string, any>
        data.methods.read = {}
        process.env.OPENCODE_PYTHON_RULES = file
        await writeFile(file, JSON.stringify(data))
        await expect(analyze("open('f')")).rejects.toThrow("Invalid python-rules.json: methods.read must be a string[]")
      } finally {
        if (prev === undefined) delete process.env.OPENCODE_PYTHON_RULES
        else process.env.OPENCODE_PYTHON_RULES = prev
        await rm(dir, { recursive: true, force: true })
      }
    })

    it("accepts legacy rules files that omit emit/pure buckets", async () => {
      const prev = process.env.OPENCODE_PYTHON_RULES
      const dir = await mkdtemp(path.join(os.tmpdir(), "python-rules-"))
      const file = path.join(dir, "rules.json")

      try {
        const src = new URL("../../src/python/python-rules.json", import.meta.url)
        const data = JSON.parse(await readFile(src, "utf8")) as Record<string, any>
        delete data.methods.emit
        delete data.methods.pure
        delete data.calls.emit
        delete data.calls.pure
        process.env.OPENCODE_PYTHON_RULES = file
        await writeFile(file, JSON.stringify(data))
        await expect(analyze("open('f')")).resolves.toEqual([{ kind: "read", call: "open", path: "f" }])
      } finally {
        if (prev === undefined) delete process.env.OPENCODE_PYTHON_RULES
        else process.env.OPENCODE_PYTHON_RULES = prev
        await rm(dir, { recursive: true, force: true })
      }
    })

    it("rejects malformed guarded rules shapes", async () => {
      const prev = process.env.OPENCODE_PYTHON_RULES
      const dir = await mkdtemp(path.join(os.tmpdir(), "python-rules-"))
      const file = path.join(dir, "rules.json")

      try {
        const src = new URL("../../src/python/python-rules.json", import.meta.url)
        const data = JSON.parse(await readFile(src, "utf8")) as Record<string, any>
        data.guarded.methods = {}
        process.env.OPENCODE_PYTHON_RULES = file
        await writeFile(file, JSON.stringify(data))
        await expect(analyze("open('f')")).rejects.toThrow("Invalid python-rules.json: guarded.methods must be an array")
      } finally {
        if (prev === undefined) delete process.env.OPENCODE_PYTHON_RULES
        else process.env.OPENCODE_PYTHON_RULES = prev
        await rm(dir, { recursive: true, force: true })
      }
    })

    it("rejects malformed guarded argLiteralIn rules", async () => {
      const prev = process.env.OPENCODE_PYTHON_RULES
      const dir = await mkdtemp(path.join(os.tmpdir(), "python-rules-"))
      const file = path.join(dir, "rules.json")

      try {
        const src = new URL("../../src/python/python-rules.json", import.meta.url)
        const data = JSON.parse(await readFile(src, "utf8")) as Record<string, any>
        data.guarded.calls[4].guards[0].values = {}
        process.env.OPENCODE_PYTHON_RULES = file
        await writeFile(file, JSON.stringify(data))
        await expect(analyze("open('f')")).rejects.toThrow("Invalid python-rules.json: guarded.calls[4].guards[0].values must be a string[]")
      } finally {
        if (prev === undefined) delete process.env.OPENCODE_PYTHON_RULES
        else process.env.OPENCODE_PYTHON_RULES = prev
        await rm(dir, { recursive: true, force: true })
      }
    })

    it("accepts legacy rules files that omit guarded rules", async () => {
      const prev = process.env.OPENCODE_PYTHON_RULES
      const dir = await mkdtemp(path.join(os.tmpdir(), "python-rules-"))
      const file = path.join(dir, "rules.json")

      try {
        const src = new URL("../../src/python/python-rules.json", import.meta.url)
        const data = JSON.parse(await readFile(src, "utf8")) as Record<string, any>
        delete data.guarded
        process.env.OPENCODE_PYTHON_RULES = file
        await writeFile(file, JSON.stringify(data))
        await expect(analyze("open('f')")).resolves.toEqual([{ kind: "read", call: "open", path: "f" }])
      } finally {
        if (prev === undefined) delete process.env.OPENCODE_PYTHON_RULES
        else process.env.OPENCODE_PYTHON_RULES = prev
        await rm(dir, { recursive: true, force: true })
      }
    })
  })
})
