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

    it("tracks bounded iterated Path tuple destructuring from explicit path pairs", async () => {
      const events = await analyze(
        [
          "from pathlib import Path",
          "repo = Path('.').resolve()",
          "renames = [(repo / 'a.py', repo / 'b.py'), (repo / 'c.py', repo / 'd.py')]",
          "for old_path, new_path in renames:",
          "    if old_path.exists():",
          "        old_path.rename(new_path)",
        ].join("\n"),
      )

      const mutatedEvents = await analyze(
        [
          "from pathlib import Path",
          "repo = Path('.').resolve()",
          "renames = [(repo / 'a.py', repo / 'b.py')]",
          "renames[0] = ('x', 'y')",
          "for old_path, new_path in renames:",
          "    if old_path.exists():",
          "        old_path.rename(new_path)",
        ].join("\n"),
      )

      const aliasMutatedEvents = await analyze(
        [
          "from pathlib import Path",
          "repo = Path('.').resolve()",
          "renames = [(repo / 'a.py', repo / 'b.py')]",
          "alias = renames",
          "other = alias",
          "other[0] = ('x', 'y')",
          "for old_path, new_path in alias:",
          "    if old_path.exists():",
          "        old_path.rename(new_path)",
        ].join("\n"),
      )

      const nonFlatEvents = await analyze(
        [
          "from pathlib import Path",
          "repo = Path('.').resolve()",
          "renames = [(repo / 'a.py', repo / 'b.py', repo / 'c.py')]",
          "for old_path, *rest in renames:",
          "    old_path.exists()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "old_path.exists", dynamicPath: true, sourceCall: "pathlib.Path.exists" },
          { kind: "write", call: "old_path.rename", dynamicPath: true, sourceCall: "pathlib.Path.rename" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:old_path.exists" }, { kind: "unknown", call: "callable:old_path.rename" }]))

      for (const variant of [mutatedEvents, aliasMutatedEvents]) {
        expect(variant).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:old_path.exists" }, { kind: "unknown", call: "callable:old_path.rename" }]))
        expect(variant).not.toEqual(expect.arrayContaining([{ kind: "read", call: "old_path.exists" }, { kind: "write", call: "old_path.rename" }]))
      }
      expect(nonFlatEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:old_path.exists" }]))
      expect(nonFlatEvents).not.toEqual(expect.arrayContaining([{ kind: "read", call: "old_path.exists" }]))
    })

    it("tracks Path provenance through dynamic joins and receiver assignments", async () => {
      const events = await analyze(
        [
          "from pathlib import Path",
          "base = Path('docs')",
          "joined = base / name",
          "joined.read_bytes()",
          "paths = {}",
          "paths['cfg'] = joined",
          "paths['cfg'].exists()",
          "state.path = Path('notes.txt')",
          "state.path.read_text()",
          "self.path = base / name",
          "self.path.write_text('x')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "joined.read_bytes", dynamicPath: true, sourceCall: "pathlib.Path.read_bytes" },
          { kind: "read", call: "paths.exists", dynamicPath: true, sourceCall: "pathlib.Path.exists" },
          { kind: "read", call: "state.path.read_text", path: "notes.txt", sourceCall: "pathlib.Path.read_text" },
          { kind: "write", call: "self.path.write_text", dynamicPath: true, sourceCall: "pathlib.Path.write_text" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:joined.read_bytes" },
          { kind: "unknown", call: "callable:paths.exists" },
          { kind: "unknown", call: "callable:state.path.read_text" },
          { kind: "unknown", call: "callable:self.path.write_text" },
        ]),
      )
    })

    it("tracks parenthesized Path read_bytes receivers into bytes decode chains", async () => {
      const events = await analyze(
        [
          "from pathlib import Path",
          "root = Path('docs')",
          "blob = (root / name).read_bytes()",
          "blob.decode('utf8').replace('a', 'b')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "read", call: "read_bytes", dynamicPath: true, sourceCall: "pathlib.Path.read_bytes" }),
          { kind: "pure", call: "blob.decode" },
          { kind: "pure", call: "blob.decode.replace" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:read_bytes" },
          { kind: "unknown", call: "callable:blob.decode" },
          { kind: "unknown", call: "callable:blob.decode.replace" },
        ]),
      )
    })

    it("keeps arbitrary Path-like receivers conservative", async () => {
      const events = await analyze(
        "obj.exists()\nobj.read_text()\nobj.write_text('x')\nobj.joinpath('a')\nobj.resolve()\nobj.stat()\nobj.open()",
      )
      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:obj.exists" },
          { kind: "unknown", call: "callable:obj.read_text" },
          { kind: "unknown", call: "callable:obj.write_text" },
          { kind: "unknown", call: "callable:obj.joinpath" },
          { kind: "unknown", call: "callable:obj.resolve" },
          { kind: "unknown", call: "callable:obj.stat" },
          { kind: "unknown", call: "callable:obj.open" },
        ]),
      )
    })

    it("classifies the remaining public Path pure helpers", async () => {
      const cases = [
        ["Path('f').absolute()", { kind: "pure", call: "Path.absolute" }],
        ["Path('f').as_posix()", { kind: "pure", call: "Path.as_posix" }],
        ["Path('/tmp/f').as_uri()", { kind: "pure", call: "Path.as_uri" }],
        ["Path('~/f').expanduser()", { kind: "pure", call: "Path.expanduser" }],
        ["Path.from_uri('file:///tmp/f')", { kind: "pure", call: "Path.from_uri" }],
        ["Path('f').full_match('*.txt')", { kind: "pure", call: "Path.full_match" }],
        ["Path.home()", { kind: "pure", call: "Path.home" }],
        ["Path('f').is_absolute()", { kind: "pure", call: "Path.is_absolute" }],
        ["Path('f').is_relative_to('base')", { kind: "pure", call: "Path.is_relative_to" }],
        ["Path('f').is_reserved()", { kind: "pure", call: "Path.is_reserved" }],
        ["Path('f').match('*.txt')", { kind: "pure", call: "Path.match" }],
        ["Path('f').relative_to('.')", { kind: "pure", call: "Path.relative_to" }],
        ["Path('f').with_name('g')", { kind: "pure", call: "Path.with_name" }],
        ["Path('f').with_segments('a', 'b')", { kind: "pure", call: "Path.with_segments" }],
        ["Path('f.txt').with_stem('g')", { kind: "pure", call: "Path.with_stem" }],
        ["Path('f.txt').with_suffix('.md')", { kind: "pure", call: "Path.with_suffix" }],
      ] as const

      const events = await analyze(cases.map(([source]) => source).join("\n"))
      expect(events).toEqual(expect.arrayContaining(cases.map(([, event]) => event)))
    })

    it("classifies the remaining public Path read and write methods", async () => {
      const cases = [
        ["Path('f').glob('*.py')", { kind: "read", call: "Path.glob", path: "f" }],
        ["Path('f').group()", { kind: "read", call: "Path.group", path: "f" }],
        ["Path('f').is_block_device()", { kind: "read", call: "Path.is_block_device", path: "f" }],
        ["Path('f').is_char_device()", { kind: "read", call: "Path.is_char_device", path: "f" }],
        ["Path('f').is_dir()", { kind: "read", call: "Path.is_dir", path: "f" }],
        ["Path('f').is_fifo()", { kind: "read", call: "Path.is_fifo", path: "f" }],
        ["Path('f').is_file()", { kind: "read", call: "Path.is_file", path: "f" }],
        ["Path('f').is_junction()", { kind: "read", call: "Path.is_junction", path: "f" }],
        ["Path('f').is_mount()", { kind: "read", call: "Path.is_mount", path: "f" }],
        ["Path('f').is_socket()", { kind: "read", call: "Path.is_socket", path: "f" }],
        ["Path('f').is_symlink()", { kind: "read", call: "Path.is_symlink", path: "f" }],
        ["Path('f').iterdir()", { kind: "read", call: "Path.iterdir", path: "f" }],
        ["Path('f').lstat()", { kind: "read", call: "Path.lstat", path: "f" }],
        ["Path('f').owner()", { kind: "read", call: "Path.owner", path: "f" }],
        ["Path('f').readlink()", { kind: "read", call: "Path.readlink", path: "f" }],
        ["Path('f').resolve()", { kind: "read", call: "Path.resolve", path: "f" }],
        ["Path('f').rglob('*.py')", { kind: "read", call: "Path.rglob", path: "f" }],
        ["Path('f').samefile('g')", { kind: "read", call: "Path.samefile", path: "f" }],
        ["Path('f').stat()", { kind: "read", call: "Path.stat", path: "f" }],
        ["Path('f').walk()", { kind: "read", call: "Path.walk", path: "f" }],
        ["Path('f').chmod(0o644)", { kind: "write", call: "Path.chmod", path: "f" }],
        ["Path('f').copy('g')", { kind: "write", call: "Path.copy", path: "f" }],
        ["Path('f').copy_into('dir')", { kind: "write", call: "Path.copy_into", path: "f" }],
        ["Path('f').hardlink_to('target')", { kind: "write", call: "Path.hardlink_to", path: "f" }],
        ["Path('f').lchmod(0o644)", { kind: "write", call: "Path.lchmod", path: "f" }],
        ["Path('f').move('g')", { kind: "write", call: "Path.move", path: "f" }],
        ["Path('f').move_into('dir')", { kind: "write", call: "Path.move_into", path: "f" }],
        ["Path('f').symlink_to('target')", { kind: "write", call: "Path.symlink_to", path: "f" }],
      ] as const

      const events = await analyze(cases.map(([source]) => source).join("\n"))
      expect(events).toEqual(expect.arrayContaining(cases.map(([, event]) => event)))
    })

    it("classifies Path.open modes and tracks returned Path helpers through assignments", async () => {
      const events = await analyze(
        [
          "reader = Path('f')",
          "reader.open()",
          "writer = Path('g')",
          "writer.open('w')",
          "home = Path.home()",
          "home.read_text()",
          "resolved = Path('h').resolve()",
          "resolved.read_text()",
          "linked = Path('i').readlink()",
          "linked.write_text('x')",
          "renamed = Path('j').rename('k')",
          "renamed.read_text()",
          "derived = Path('l').with_name('m')",
          "derived.write_text('y')",
          "from_uri = Path.from_uri('file:///tmp/n')",
          "from_uri.read_text()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "reader.open", path: "f", sourceCall: "pathlib.Path.open" },
          { kind: "write", call: "writer.open", path: "g", sourceCall: "pathlib.Path.open" },
          { kind: "pure", call: "Path.home" },
          { kind: "read", call: "home.read_text", dynamicPath: true, sourceCall: "pathlib.Path.read_text" },
          { kind: "read", call: "Path.resolve", path: "h" },
          { kind: "read", call: "resolved.read_text", dynamicPath: true, sourceCall: "pathlib.Path.read_text" },
          { kind: "read", call: "Path.readlink", path: "i" },
          { kind: "write", call: "linked.write_text", dynamicPath: true, sourceCall: "pathlib.Path.write_text" },
          { kind: "write", call: "Path.rename", path: "j" },
          { kind: "read", call: "renamed.read_text", dynamicPath: true, sourceCall: "pathlib.Path.read_text" },
          { kind: "pure", call: "Path.with_name" },
          { kind: "write", call: "derived.write_text", dynamicPath: true, sourceCall: "pathlib.Path.write_text" },
          { kind: "pure", call: "Path.from_uri" },
          { kind: "read", call: "from_uri.read_text", dynamicPath: true, sourceCall: "pathlib.Path.read_text" },
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

    it("tracks text.count and text.endswith through sorted identity path generators", async () => {
      const events = await analyze(
        [
          "from pathlib import Path",
          "root = Path('src/python')",
          "files = sorted(p for p in root.glob('*.ts') if p.is_file())",
          "for path in files:",
          "    text = path.read_text()",
          "    text.count('\\n')",
          "    text.endswith('\\n')",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "pure", call: "text.count" }, { kind: "pure", call: "text.endswith" }, { kind: "read", call: "path.read_text", dynamicPath: true, sourceCall: "pathlib.Path.read_text" }]))
    })

    it("keeps text.count and text.endswith conservative when sorted is shadowed or the generator is non-identity", async () => {
      const shadowedEvents = await analyze(
        [
          "from pathlib import Path",
          "root = Path('src/python')",
          "sorted = custom_sorted",
          "files = sorted(p for p in root.glob('*.ts') if p.is_file())",
          "for path in files:",
          "    text = path.read_text()",
          "    text.count('\\n')",
          "    text.endswith('\\n')",
        ].join("\n"),
      )

      const nonIdentityEvents = await analyze(
        [
          "from pathlib import Path",
          "root = Path('src/python')",
          "files = sorted(str(p) for p in root.glob('*.ts') if p.is_file())",
          "for path in files:",
          "    text = path.read_text()",
          "    text.count('\\n')",
          "    text.endswith('\\n')",
        ].join("\n"),
      )

      expect(shadowedEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:text.count" }, { kind: "unknown", call: "callable:text.endswith" }]))
      expect(nonIdentityEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:text.count" }, { kind: "unknown", call: "callable:text.endswith" }]))
    })

    it("tracks target.relative_to and target.with_suffix through parent-derived path joins", async () => {
      const events = await analyze(
        [
          "from pathlib import Path",
          "root = Path('src/python')",
          "files = sorted(root.glob('*.ts'))",
          "for file in files:",
          "    rel = './python-scope.ts'",
          "    target = (file.parent / rel).resolve()",
          "    if target.suffix != '.ts':",
          "        target = target.with_suffix('.ts')",
          "    target.relative_to(root).as_posix()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "pure", call: "target.with_suffix" }),
          expect.objectContaining({ kind: "pure", call: "target.relative_to" }),
          expect.objectContaining({ kind: "pure", call: "target.relative_to.as_posix" }),
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

    it("keeps unsupported built-in type method receivers conservative while allowing tracked decode chains", async () => {
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
          { kind: "pure", call: "data.decode.split" },
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

    it("tracks conditional json fallback locals as pure and keeps incompatible ternaries conservative", async () => {
      const positiveEvents = await analyze([
        "import json",
        "store = json.loads(text)",
        "cur = json.loads(store.get('settings.v3', '{}')) if store.get('settings.v3') else {}",
        "cur.get('keybinds')",
        "cur.pop('keybinds', None)",
      ].join("\n"))

      const customizerEvents = await analyze([
        "import json",
        "cur = json.loads(text, object_hook=hook) if enabled else {}",
        "cur.get('keybinds')",
        "cur.pop('keybinds', None)",
      ].join("\n"))

      const incompatibleEvents = await analyze([
        "import json",
        "cur = json.loads(text) if enabled else object()",
        "cur.get('keybinds')",
        "cur.pop('keybinds', None)",
      ].join("\n"))

      expect(positiveEvents).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "json.loads" },
          { kind: "pure", call: "store.get" },
          { kind: "pure", call: "cur.get" },
          { kind: "pure", call: "cur.pop" },
        ]),
      )
      expect(positiveEvents).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:cur.get" },
          { kind: "unknown", call: "callable:cur.pop" },
        ]),
      )

      for (const events of [customizerEvents, incompatibleEvents]) {
        expect(events).toEqual(
          expect.arrayContaining([
            { kind: "unknown", call: "callable:cur.get" },
            { kind: "unknown", call: "callable:cur.pop" },
          ]),
        )
        expect(events).not.toEqual(
          expect.arrayContaining([
            { kind: "pure", call: "cur.get" },
            { kind: "pure", call: "cur.pop" },
          ]),
        )
      }
    })

    it("tracks json-subscripted comprehension items and nested generator items as pure", async () => {
      const events = await analyze([
        "data = json.loads(text)",
        "guards = data['guarded']['methods']",
        "non_path = [item for item in guards if not any(g.get('type') == 'receiverKindIn' and g.get('kinds') == ['path'] for g in item.get('guards', []))]",
      ].join("\n"))

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "json.loads" },
          { kind: "pure", call: "item.get" },
          { kind: "pure", call: "g.get" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:item.get" },
          { kind: "unknown", call: "callable:g.get" },
        ]),
      )
    })

    it("tracks standard-container elements through literals, comprehensions, and next()", async () => {
      const events = await analyze([
        "rows = [{'x': 1}]",
        "[item.get('x') for item in rows]",
        "buckets = [[1]]",
        "[bucket.append(2) for bucket in buckets]",
        "bag = next((entry for entry in [set()]), None)",
        "bag.add('x')",
        "pair = next((entry for entry in [(1, 2, 1)]), None)",
        "pair.count(1)",
      ].join("\n"))

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "item.get" },
          { kind: "pure", call: "bucket.append" },
          { kind: "pure", call: "bag.add" },
          { kind: "pure", call: "pair.count" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:item.get" },
          { kind: "unknown", call: "callable:bucket.append" },
          { kind: "unknown", call: "callable:bag.add" },
          { kind: "unknown", call: "callable:pair.count" },
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
})
