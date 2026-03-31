import { describe, expect, it } from "bun:test"
import { analyze } from "../tool/python-analyze"

describe("python analyzer", () => {
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

    it("classifies direct-imported re helpers as pure", async () => {
      const events = await analyze(
        [
          "from re import search, compile, split, escape",
          "search('a+', text)",
          "compile('a+')",
          "split('a+', text)",
          "escape('a+')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "re.search" },
          { kind: "pure", call: "re.compile" },
          { kind: "pure", call: "re.split" },
          { kind: "pure", call: "re.escape" },
        ]),
      )
    })

    it("tracks compiled regex patterns and downstream match/list helpers", async () => {
      const events = await analyze(
        [
          "import re",
          "pat = re.compile('a+')",
          "pat.search(text)",
          "pat.search(text).group(0)",
          "pat.match(text)",
          "pat.fullmatch(text)",
          "pat.findall(text)",
          "pat.findall(text).count('a')",
          "pat.split(text)",
          "pat.split(text).count('')",
          "pat.finditer(text)",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "re.compile" },
          { kind: "pure", call: "pat.search" },
          { kind: "pure", call: "pat.search.group" },
          { kind: "pure", call: "pat.match" },
          { kind: "pure", call: "pat.fullmatch" },
          { kind: "pure", call: "pat.findall" },
          { kind: "pure", call: "pat.findall.count" },
          { kind: "pure", call: "pat.split" },
          { kind: "pure", call: "pat.split.count" },
          { kind: "pure", call: "pat.finditer" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:pat.search" },
          { kind: "unknown", call: "callable:pat.match" },
          { kind: "unknown", call: "callable:pat.findall" },
        ]),
      )
    })

    it("tracks direct regex list returns through assigned locals and keeps shadowed roots conservative", async () => {
      const events = await analyze(
        [
          "import re",
          "names = re.findall('describe', text)",
          "names.count('describe')",
          "parts = re.split(':', text)",
          "parts.count('')",
        ].join("\n"),
      )

      const directImportEvents = await analyze(
        [
          "from re import findall, split",
          "names = findall('describe', text)",
          "names.count('describe')",
          "parts = split(':', text)",
          "parts.count('')",
        ].join("\n"),
      )

      const shadowedEvents = await analyze(
        [
          "import re",
          "re = fake",
          "names = re.findall('describe', text)",
          "names.count('describe')",
        ].join("\n"),
      )

      for (const variant of [events, directImportEvents]) {
        expect(variant).toEqual(
          expect.arrayContaining([
            { kind: "pure", call: "re.findall" },
            { kind: "pure", call: "names.count" },
            { kind: "pure", call: "re.split" },
            { kind: "pure", call: "parts.count" },
          ]),
        )
        expect(variant).not.toEqual(
          expect.arrayContaining([
            { kind: "unknown", call: "callable:names.count" },
            { kind: "unknown", call: "callable:parts.count" },
          ]),
        )
      }

      expect(shadowedEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:names.count" }]))
      expect(shadowedEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "names.count" }]))
    })

    it("tracks direct regex split iterated string locals without widening shadowed roots", async () => {
      const events = await analyze(
        [
          "import re",
          "sections = re.split('TITLE', text)",
          "for sec in sections[1:]:",
          "    sec.split(')').count('')",
        ].join("\n"),
      )

      const shadowedEvents = await analyze(
        [
          "import re",
          "re = fake",
          "sections = re.split('TITLE', text)",
          "for sec in sections[1:]:",
          "    sec.split(')').count('')",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "pure", call: "re.split" }, { kind: "pure", call: "sec.split" }, { kind: "pure", call: "sec.split.count" }]))
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:sec.split" }, { kind: "unknown", call: "callable:sec.split.count" }]))
      expect(shadowedEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:sec.split" }]))
      expect(shadowedEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "sec.split" }]))
    })

    it("tracks string split results through subscripted receivers and assigned locals", async () => {
      const events = await analyze(
        [
          "from pathlib import Path",
          "text = Path('f').read_text()",
          "line = text.splitlines()[0]",
          "line.split(' ', 1)",
          "line.split(' ', 1)[0].strip()",
          "parts = line.split(':')",
          "parts[0].strip()",
          "name = parts[0]",
          "name.lower()",
        ].join("\n"),
      )

      expect(events).toContainEqual({ kind: "read", call: "pathlib.Path.read_text", path: "f" })
      expect(events).toContainEqual({ kind: "pure", call: "text.splitlines" })
      expect(events).toContainEqual({ kind: "pure", call: "line.split" })
      expect(events).toContainEqual({ kind: "pure", call: "line.split.strip" })
      expect(events).toContainEqual({ kind: "pure", call: "parts.strip" })
      expect(events).toContainEqual({ kind: "pure", call: "name.lower" })
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:line.split" },
          { kind: "unknown", call: "callable:line.split.strip" },
          { kind: "unknown", call: "callable:parts.strip" },
          { kind: "unknown", call: "callable:name.lower" },
        ]),
      )
    })

    it("seeds same-scope helper params from trusted string iterables", async () => {
      const events = await analyze(
        [
          "from pathlib import Path",
          "entries = Path('f').read_text().splitlines()",
          "def leaf(entries):",
          "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
          "leaf(entries)",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "e.split" },
          { kind: "pure", call: "e.startswith" },
          { kind: "unknown", call: "callable:leaf" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:e.split" },
          { kind: "unknown", call: "callable:e.startswith" },
        ]),
      )
    })

    it("seeds same-scope helper params even when the helper is defined before the trusted producer", async () => {
      const events = await analyze(
        [
          "def leaf(entries):",
          "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
          "from pathlib import Path",
          "entries = Path('f').read_text().splitlines()",
          "leaf(entries)",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "pure", call: "e.split" }, { kind: "pure", call: "e.startswith" }]))
    })

    it("keeps same-scope helper params conservative when callsites disagree", async () => {
      const events = await analyze(
        [
          "from pathlib import Path",
          "entries = Path('f').read_text().splitlines()",
          "other = values",
          "def leaf(entries):",
          "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
          "leaf(entries)",
          "leaf(other)",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:e.split" },
          { kind: "unknown", call: "callable:e.startswith" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "e.split" },
          { kind: "pure", call: "e.startswith" },
        ]),
      )
    })

    it("seeds same-scope lambda helper params from trusted string iterables", async () => {
      const events = await analyze(
        [
          "from pathlib import Path",
          "entries = Path('f').read_text().splitlines()",
          "leaf = lambda entries: [e.split(':')[-1] for e in entries if e.startswith('x')]",
          "leaf(entries)",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "pure", call: "e.split" }, { kind: "pure", call: "e.startswith" }, { kind: "unknown", call: "callable:leaf" }]))
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
    })

    it("keeps same-scope lambda helper params conservative when callsites disagree", async () => {
      const events = await analyze(
        [
          "from pathlib import Path",
          "entries = Path('f').read_text().splitlines()",
          "other = values",
          "leaf = lambda entries: [e.split(':')[-1] for e in entries if e.startswith('x')]",
          "leaf(entries)",
          "leaf(other)",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
    })

    it("clears helper-param string iterable seeds after indexed mutation", async () => {
      const events = await analyze(
        [
          "from pathlib import Path",
          "entries = Path('f').read_text().splitlines()",
          "entries[0] = other",
          "def leaf(entries):",
          "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
          "leaf(entries)",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:e.split" },
          { kind: "unknown", call: "callable:e.startswith" },
        ]),
      )
    })

    it("clears helper-param string iterable seeds after alias-based indexed mutation", async () => {
      const events = await analyze(
        [
          "from pathlib import Path",
          "entries = Path('f').read_text().splitlines()",
          "alias = entries",
          "alias[0] = other",
          "def leaf(entries):",
          "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
          "leaf(entries)",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
    })

    it("seeds helper params from mutation-built exact receiver-path string lists when the builder stays homogeneous", async () => {
      const events = await analyze(
        [
          "inv = {}",
          "current = 'runtime'",
          "inv[current] = []",
          "inv[current].append('x:1')",
          "def leaf(entries):",
          "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
          "leaf(inv[current])",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "pure", call: "e.split" }, { kind: "pure", call: "e.startswith" }, { kind: "unknown", call: "callable:leaf" }]))
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
    })

    it("seeds helper params from mutation-built exact receiver-path string lists when extend carries trusted strings", async () => {
      const events = await analyze(
        [
          "from pathlib import Path",
          "inv = {}",
          "current = 'runtime'",
          "inv[current] = []",
          "inv[current].extend(Path('f').read_text().splitlines())",
          "def leaf(entries):",
          "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
          "leaf(inv[current])",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "pure", call: "e.split" }, { kind: "pure", call: "e.startswith" }]))
    })

    it("tracks direct iteration over value-equivalent dynamic-to-literal dict subscript builders", async () => {
      const events = await analyze(
        [
          "inv = {}",
          "current = 'python.test.ts'",
          "inv[current] = []",
          "inv[current].append('x -> title')",
          "result = [e.split(' -> ')[-1] for e in inv['python.test.ts'] if e.startswith('x')]",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "pure", call: "e.split" }, { kind: "pure", call: "e.startswith" }]))
    })

    it("tracks direct iteration over exact dynamic dict subscript builders", async () => {
      const events = await analyze(
        [
          "inv = {}",
          "current = 'python.test.ts'",
          "inv[current] = []",
          "inv[current].append('x -> title')",
          "inv[current].append('x -> body')",
          "result = [e.split(' -> ')[-1] for e in inv[current] if e.startswith('x')]",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "pure", call: "e.split" }, { kind: "pure", call: "e.startswith" }]))
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
    })

    it("tracks direct iteration over exact literal dict subscript builders", async () => {
      const events = await analyze(
        [
          "inv = {}",
          "inv['python.test.ts'] = []",
          "inv['python.test.ts'].append('x -> title')",
          "result = [e.split(' -> ')[-1] for e in inv['python.test.ts'] if e.startswith('x')]",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "pure", call: "e.split" }, { kind: "pure", call: "e.startswith" }]))
    })

    it("tracks direct iteration over keys derived from exact split/strip string values", async () => {
      const events = await analyze(
        [
          "line = 'FILE python.test.ts'",
          "current = line.split('FILE ', 1)[1].strip()",
          "inv = {}",
          "inv['python.test.ts'] = []",
          "inv['python.test.ts'].append('x -> title')",
          "result = [e.split(' -> ')[-1] for e in inv[current] if e.startswith('x')]",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "pure", call: "e.split" }, { kind: "pure", call: "e.startswith" }, { kind: "pure", call: "line.split" }, { kind: "pure", call: "line.split.strip" }]))
    })

    it("tracks direct iteration over keys derived from iterated exact literal lines", async () => {
      const events = await analyze(
        [
          "inv = {}",
          "for line in ['FILE python.test.ts']:",
          "    current = line.split('FILE ', 1)[1].strip()",
          "    inv[current] = []",
          "    inv[current].append('x -> title')",
          "result = [e.split(' -> ')[-1] for e in inv['python.test.ts'] if e.startswith('x')]",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "pure", call: "e.split" }, { kind: "pure", call: "e.startswith" }, { kind: "pure", call: "line.split" }, { kind: "pure", call: "line.split.strip" }]))
    })

    it("tracks keys derived from exact literal lines under startswith branch narrowing", async () => {
      const events = await analyze(
        [
          "inv = {}",
          "for line in ['FILE python.test.ts', '- x -> title']:",
          "    if line.startswith('FILE '):",
          "        current = line.split('FILE ', 1)[1].strip()",
          "        inv[current] = []",
          "    elif current and line.startswith('- '):",
          "        inv[current].append(line[2:])",
          "result = [e.split(' -> ')[-1] for e in inv['python.test.ts'] if e.startswith('x')]",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "pure", call: "e.split" }, { kind: "pure", call: "e.startswith" }, { kind: "pure", call: "line.startswith" }]))
    })

    it("tracks keys derived from exact variable prefixes under startswith branch narrowing", async () => {
      const events = await analyze(
        [
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
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "pure", call: "line.startswith" }, { kind: "pure", call: "line.split" }, { kind: "pure", call: "line.split.strip" }]))
    })

    it("keeps keys derived from dynamic-origin mixed lines conservative without value narrowing", async () => {
      const events = await analyze(
        [
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
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
    })

    it("tracks direct iteration over value-equivalent literal-to-dynamic dict subscript builders and exact insert builders", async () => {
      const dynamicEquivalentEvents = await analyze(
        [
          "inv = {}",
          "inv['python.test.ts'] = []",
          "current = 'python.test.ts'",
          "inv['python.test.ts'].append('x -> title')",
          "result = [e.split(' -> ')[-1] for e in inv[current] if e.startswith('x')]",
        ].join("\n"),
      )

      const literalMismatchEvents = await analyze(
        [
          "inv = {}",
          "current = 'python.test.ts'",
          "inv[current] = []",
          "inv[current].append('x -> title')",
          "result = [e.split(' -> ')[-1] for e in inv['python-runtime-execution.test.ts'] if e.startswith('x')]",
        ].join("\n"),
      )

      const insertEvents = await analyze(
        [
          "inv = {}",
          "current = 'python.test.ts'",
          "inv[current] = []",
          "inv[current].insert(0, 'x -> title')",
          "result = [e.split(' -> ')[-1] for e in inv[current] if e.startswith('x')]",
        ].join("\n"),
      )

      expect(dynamicEquivalentEvents).toEqual(expect.arrayContaining([{ kind: "pure", call: "e.split" }, { kind: "pure", call: "e.startswith" }]))
      expect(literalMismatchEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
      expect(insertEvents).toEqual(expect.arrayContaining([{ kind: "pure", call: "e.split" }, { kind: "pure", call: "e.startswith" }]))
    })

    it("tracks direct iteration over value-equivalent literal dict list values", async () => {
      const events = await analyze(
        [
          "inv = {'python-runtime-execution.test.ts': [], 'python.test.ts': []}",
          "current = 'python.test.ts'",
          "inv[current].append('x -> title')",
          "result = [e.split(' -> ')[-1] for e in inv['python.test.ts'] if e.startswith('x')]",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "pure", call: "e.split" }, { kind: "pure", call: "e.startswith" }]))
    })

    it("preserves value-equivalent dict list proofs across different known sibling keys", async () => {
      const events = await analyze(
        [
          "inv = {'a': [], 'b': []}",
          "inv['a'].append('x -> title')",
          "inv['b'].append(other)",
          "result = [e.split(' -> ')[-1] for e in inv['a'] if e.startswith('x')]",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "pure", call: "e.split" }, { kind: "pure", call: "e.startswith" }]))
    })

    it("keeps exact direct dict subscript builders conservative after key rebinding and non-helper escapes", async () => {
      const reboundEvents = await analyze(
        [
          "inv = {}",
          "current = 'python.test.ts'",
          "inv[current] = []",
          "inv[current].append('x -> title')",
          "current = other_key",
          "result = [e.split(' -> ')[-1] for e in inv[current] if e.startswith('x')]",
        ].join("\n"),
      )

      const escapedEvents = await analyze(
        [
          "inv = {}",
          "current = 'python.test.ts'",
          "inv[current] = []",
          "inv[current].append('x -> title')",
          "other(inv[current])",
          "result = [e.split(' -> ')[-1] for e in inv[current] if e.startswith('x')]",
        ].join("\n"),
      )

      expect(reboundEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
      expect(escapedEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
    })

    it("keeps direct exact-path dict reads conservative under dep shadowing and alias-root rebinding", async () => {
      const shadowedEvents = await analyze(
        [
          "inv = {}",
          "current = 'python.test.ts'",
          "inv[current] = []",
          "inv[current].append('x -> title')",
          "def outer(current):",
          "    return [e.split(' -> ')[-1] for e in inv[current] if e.startswith('x')]",
          "outer(other_key)",
        ].join("\n"),
      )

      const aliasRootEvents = await analyze(
        [
          "inv = {}",
          "bucket = inv",
          "current = 'python.test.ts'",
          "bucket[current] = []",
          "bucket[current].append('x -> title')",
          "inv = other_map",
          "result = [e.split(' -> ')[-1] for e in inv[current] if e.startswith('x')]",
        ].join("\n"),
      )

      expect(shadowedEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
      expect(aliasRootEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
    })

    it("keeps value-equivalent dict reads conservative when inner scopes shadow alias roots during same-root mutation", async () => {
      const events = await analyze(
        [
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
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
    })

    it("keeps raw alias-root exact-path reads conservative after subscript-to-identifier escapes mutate", async () => {
      const appendEvents = await analyze(
        [
          "inv = {}",
          "bucket = inv",
          "current = 'python.test.ts'",
          "bucket[current] = []",
          "bucket[current].append('x -> title')",
          "alias = bucket[current]",
          "alias.append(other_value)",
          "result = [e.split(' -> ')[-1] for e in bucket[current] if e.startswith('x')]",
        ].join("\n"),
      )

      const indexEvents = await analyze(
        [
          "inv = {}",
          "bucket = inv",
          "current = 'python.test.ts'",
          "bucket[current] = []",
          "bucket[current].append('x -> title')",
          "alias = bucket[current]",
          "alias[0] = other_value",
          "result = [e.split(' -> ')[-1] for e in bucket[current] if e.startswith('x')]",
        ].join("\n"),
      )

      expect(appendEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
      expect(indexEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
    })

    it("keeps direct exact-path dict reads conservative after same-root alternate-key mutations", async () => {
      const variableAliasEvents = await analyze(
        [
          "inv = {}",
          "current = 'python.test.ts'",
          "other = current",
          "inv[current] = []",
          "inv[current].append('x -> title')",
          "inv[other].append(other_value)",
          "result = [e.split(' -> ')[-1] for e in inv[current] if e.startswith('x')]",
        ].join("\n"),
      )

      const literalAliasEvents = await analyze(
        [
          "inv = {}",
          "alias = 'python.test.ts'",
          "inv['python.test.ts'] = []",
          "inv['python.test.ts'].append('x -> title')",
          "inv[alias].insert(0, other_value)",
          "result = [e.split(' -> ')[-1] for e in inv['python.test.ts'] if e.startswith('x')]",
        ].join("\n"),
      )

      const reassignedEvents = await analyze(
        [
          "inv = {}",
          "current = 'python.test.ts'",
          "other = current",
          "inv[current] = []",
          "inv[current].append('x -> title')",
          "inv[other] = [other_value]",
          "result = [e.split(' -> ')[-1] for e in inv[current] if e.startswith('x')]",
        ].join("\n"),
      )

      const mixedRootEvents = await analyze(
        [
          "inv = {}",
          "bucket = inv",
          "current = 'python.test.ts'",
          "other = current",
          "bucket[current] = []",
          "bucket[current].append('x -> title')",
          "inv[other].append(other_value)",
          "result = [e.split(' -> ')[-1] for e in bucket[current] if e.startswith('x')]",
        ].join("\n"),
      )

      expect(variableAliasEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
      expect(literalAliasEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
      expect(reassignedEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
      expect(mixedRootEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
    })

    it("keeps mutation-built receiver-path string lists conservative when appended values are unknown", async () => {
      const events = await analyze(
        [
          "inv = {}",
          "current = 'runtime'",
          "inv[current] = []",
          "inv[current].append(other)",
          "def leaf(entries):",
          "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
          "leaf(inv[current])",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
    })

    it("keeps mutation-built receiver-path string lists conservative when aliased subscript receivers mutate", async () => {
      const appendEvents = await analyze(
        [
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
      )

      const indexEvents = await analyze(
        [
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
      )

      expect(appendEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
      expect(indexEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
    })

    it("keeps mutation-built receiver-path string lists conservative after non-helper escape calls", async () => {
      const events = await analyze(
        [
          "inv = {}",
          "current = 'runtime'",
          "inv[current] = []",
          "inv[current].append('x:1')",
          "other(inv[current])",
          "def leaf(entries):",
          "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
          "leaf(inv[current])",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
    })

    it("keeps mutation-built receiver-path aliases conservative after the base path mutates", async () => {
      const appendEvents = await analyze(
        [
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
      )

      const indexEvents = await analyze(
        [
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
      )

      expect(appendEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
      expect(indexEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
    })

    it("keeps exact receiver-path helper seeds conservative after key rebinding and never-called inner builders", async () => {
      const reboundEvents = await analyze(
        [
          "inv = {}",
          "current = 'runtime'",
          "inv[current] = []",
          "inv[current].append('x:1')",
          "current = other_key",
          "def leaf(entries):",
          "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
          "leaf(inv[current])",
        ].join("\n"),
      )

      const nestedEvents = await analyze(
        [
          "inv = {}",
          "current = 'runtime'",
          "def build():",
          "    inv[current] = []",
          "    inv[current].append('x:1')",
          "def leaf(entries):",
          "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
          "leaf(inv[current])",
        ].join("\n"),
      )

      expect(reboundEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
      expect(nestedEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
    })

    it("keeps exact receiver-path helper seeds conservative when key deps are shadowed by params", async () => {
      const defEvents = await analyze(
        [
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
      )

      const lambdaEvents = await analyze(
        [
          "inv = {}",
          "current = 'runtime'",
          "inv[current] = []",
          "inv[current].append('x:1')",
          "def outer(current):",
          "    leaf = lambda entries: [e.split(':')[-1] for e in entries if e.startswith('x')]",
          "    return leaf(inv[current])",
          "outer(other_key)",
        ].join("\n"),
      )

      expect(defEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
      expect(lambdaEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
    })

    it("clears helper-param string iterable seeds after mutating list methods", async () => {
      const events = await analyze(
        [
          "from pathlib import Path",
          "entries = Path('f').read_text().splitlines()",
          "entries.append(other)",
          "def leaf(entries):",
          "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
          "leaf(entries)",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:e.split" },
          { kind: "unknown", call: "callable:e.startswith" },
        ]),
      )
    })

    it("clears helper-param string iterable seeds through aliases and comprehension mutations", async () => {
      const aliasEvents = await analyze(
        [
          "from pathlib import Path",
          "entries = Path('f').read_text().splitlines()",
          "alias = entries",
          "entries.append(other)",
          "def leaf(entries):",
          "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
          "leaf(alias)",
        ].join("\n"),
      )

      const comprehensionEvents = await analyze(
        [
          "from pathlib import Path",
          "entries = Path('f').read_text().splitlines()",
          "[entries.append(other) for _ in xs]",
          "def leaf(entries):",
          "    return [e.split(':')[-1] for e in entries if e.startswith('x')]",
          "leaf(entries)",
        ].join("\n"),
      )

      expect(aliasEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
      expect(comprehensionEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:e.split" }, { kind: "unknown", call: "callable:e.startswith" }]))
    })

    it("tracks dir and sorted(dir()) names as string origins when builtins are trusted", async () => {
      const events = await analyze(
        [
          "name = dir(obj)[0]",
          "name.lower()",
          "for attr in sorted(dir(obj)):",
          "    attr.startswith('_')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "dir" },
          { kind: "pure", call: "name.lower" },
          { kind: "pure", call: "sorted" },
          { kind: "pure", call: "attr.startswith" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:name.lower" },
          { kind: "unknown", call: "callable:attr.startswith" },
        ]),
      )
    })

    it("keeps dir and sorted(dir()) string origins conservative when builtins are shadowed", async () => {
      const events = await analyze(
        [
          "dir = fake",
          "name = dir(obj)[0]",
          "name.lower()",
          "sorted = fake_sorted",
          "for attr in sorted(dir(obj)):",
          "    attr.startswith('_')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:name.lower" },
          { kind: "unknown", call: "callable:attr.startswith" },
        ]),
      )
    })

    it("clears dir-derived string origins after indexed mutation", async () => {
      const events = await analyze(
        [
          "names = dir(obj)",
          "names[0] = other",
          "name = names[0]",
          "name.lower()",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:name.lower" }]))
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "name.lower" }]))
    })

    it("clears dir-derived string origins after alias-based indexed mutation", async () => {
      const events = await analyze(
        [
          "names = dir(obj)",
          "alias = names",
          "alias[0] = other",
          "name = names[0]",
          "name.lower()",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:name.lower" }]))
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "name.lower" }]))
    })

    it("classifies exact __dict__.items introspection as pure without broadening generic items methods", async () => {
      const events = await analyze(
        [
          "import calendar",
          "for name, value in calendar.__dict__.items():",
          "    name.lower()",
          "class Bucket:",
          "    def items(self):",
          "        return []",
          "bucket = Bucket()",
          "bucket.items()",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "pure", call: "calendar.__dict__.items" }]))
      expect(events).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:name.lower" }]))
      expect(events).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:bucket.items" }]))
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "bucket.items" }]))
    })

    it("classifies exact string-key dict items destructuring as string-backed without widening generic items keys", async () => {
      const positiveEvents = await analyze(
        [
          "import datetime as dt",
          "samples = {",
          "    ' date': dt.date(2024, 1, 2),",
          "    ' datetime': dt.datetime(2024, 1, 2, 3, 4, 5, tzinfo=dt.timezone.utc),",
          "}",
          "for label, obj in samples.items():",
          "    label.strip()",
        ].join("\n"),
      )

      const mixedKeyEvents = await analyze(
        [
          "samples = {' date': 1, 2: 3}",
          "for label, obj in samples.items():",
          "    label.strip()",
        ].join("\n"),
      )

      const mutatedEvents = await analyze(
        [
          "samples = {' date': 1, ' datetime': 2}",
          "samples[1] = 3",
          "for label, obj in samples.items():",
          "    label.strip()",
        ].join("\n"),
      )

      const updatedEvents = await analyze(
        [
          "samples = {' date': 1, ' datetime': 2}",
          "samples.update({1: 3})",
          "for label, obj in samples.items():",
          "    label.strip()",
        ].join("\n"),
      )

      const setdefaultEvents = await analyze(
        [
          "samples = {' date': 1, ' datetime': 2}",
          "samples.setdefault(1, 3)",
          "for label, obj in samples.items():",
          "    label.strip()",
        ].join("\n"),
      )

      const splatEvents = await analyze(
        [
          "samples = {**other, ' date': 1}",
          "for label, obj in samples.items():",
          "    label.strip()",
        ].join("\n"),
      )

      const dictUpdateEvents = await analyze(
        [
          "samples = {' date': 1, ' datetime': 2}",
          "dict.update(samples, {1: 3})",
          "for label, obj in samples.items():",
          "    label.strip()",
        ].join("\n"),
      )

      const boundUpdateEvents = await analyze(
        [
          "samples = {' date': 1, ' datetime': 2}",
          "upd = samples.update",
          "upd({1: 3})",
          "for label, obj in samples.items():",
          "    label.strip()",
        ].join("\n"),
      )

      expect(positiveEvents).toEqual(expect.arrayContaining([{ kind: "pure", call: "label.strip" }]))
      expect(positiveEvents).not.toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:label.strip" }]))

      for (const events of [mixedKeyEvents, mutatedEvents, updatedEvents, setdefaultEvents, splatEvents, dictUpdateEvents, boundUpdateEvents]) {
        expect(events).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:label.strip" }]))
        expect(events).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "label.strip" }]))
      }
    })

    it("classifies trusted direct-imported client __mro__ module metadata as pure without widening generic __module__ access", async () => {
      const positiveEvents = await analyze(
        [
          "from msgraph import GraphServiceClient",
          "for cls in GraphServiceClient.__mro__:",
          "    cls.__module__.startswith('msgraph')",
        ].join("\n"),
      )

      const genericEvents = await analyze(
        [
          "for cls in values:",
          "    cls.__module__.startswith('calendar')",
        ].join("\n"),
      )

      const shadowedEvents = await analyze(
        [
          "from msgraph import GraphServiceClient",
          "GraphServiceClient = object()",
          "for cls in GraphServiceClient.__mro__:",
          "    cls.__module__.startswith('msgraph')",
        ].join("\n"),
      )

      const reboundLoopEvents = await analyze(
        [
          "from msgraph import GraphServiceClient",
          "for cls in GraphServiceClient.__mro__:",
          "    cls = object()",
          "    cls.__module__.startswith('msgraph')",
        ].join("\n"),
      )

      const nonClassAliasEvents = await analyze(
        [
          "from typing import TypeGuard as GraphServiceClient",
          "for cls in GraphServiceClient.__mro__:",
          "    cls.__module__.startswith('msgraph')",
        ].join("\n"),
      )

      const uppercaseConstantEvents = await analyze(
        [
          "from unittest.mock import ANY as GraphServiceClient",
          "for cls in GraphServiceClient.__mro__:",
          "    cls.__module__.startswith('msgraph')",
        ].join("\n"),
      )

      const wrongModuleEvents = await analyze(
        [
          "from fake_sdk import GraphServiceClient",
          "for cls in GraphServiceClient.__mro__:",
          "    cls.__module__.startswith('msgraph')",
        ].join("\n"),
      )

      const directAssignmentEvents = await analyze(
        [
          "from msgraph import GraphServiceClient",
          "for cls in GraphServiceClient.__mro__:",
          "    cls.__module__ = 0",
          "    cls.__module__.startswith('msgraph')",
        ].join("\n"),
      )

      const setattrEvents = await analyze(
        [
          "from msgraph import GraphServiceClient",
          "for cls in GraphServiceClient.__mro__:",
          "    setattr(cls, '__module__', 0)",
          "    cls.__module__.startswith('msgraph')",
        ].join("\n"),
      )

      const aliasAssignmentEvents = await analyze(
        [
          "from msgraph import GraphServiceClient",
          "for cls in GraphServiceClient.__mro__:",
          "    alias = cls",
          "    alias.__module__ = 0",
          "    cls.__module__.startswith('msgraph')",
        ].join("\n"),
      )

      const aliasSetattrEvents = await analyze(
        [
          "from msgraph import GraphServiceClient",
          "for cls in GraphServiceClient.__mro__:",
          "    alias = cls",
          "    setattr(alias, '__module__', 0)",
          "    cls.__module__.startswith('msgraph')",
        ].join("\n"),
      )

      expect(positiveEvents).toEqual(expect.arrayContaining([{ kind: "pure", call: "cls.__module__.startswith" }]))
      expect(positiveEvents).not.toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:cls.__module__.startswith" }]))
      expect(genericEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:cls.__module__.startswith" }]))
      expect(genericEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "cls.__module__.startswith" }]))
      expect(shadowedEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:cls.__module__.startswith" }]))
      expect(shadowedEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "cls.__module__.startswith" }]))
      expect(reboundLoopEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:cls.__module__.startswith" }]))
      expect(reboundLoopEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "cls.__module__.startswith" }]))
      expect(nonClassAliasEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:cls.__module__.startswith" }]))
      expect(nonClassAliasEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "cls.__module__.startswith" }]))
      expect(uppercaseConstantEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:cls.__module__.startswith" }]))
      expect(uppercaseConstantEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "cls.__module__.startswith" }]))
      expect(wrongModuleEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:cls.__module__.startswith" }]))
      expect(wrongModuleEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "cls.__module__.startswith" }]))
      expect(directAssignmentEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:cls.__module__.startswith" }]))
      expect(directAssignmentEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "cls.__module__.startswith" }]))
      expect(setattrEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:cls.__module__.startswith" }]))
      expect(setattrEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "cls.__module__.startswith" }]))
      expect(aliasAssignmentEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:cls.__module__.startswith" }]))
      expect(aliasAssignmentEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "cls.__module__.startswith" }]))
      expect(aliasSetattrEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:cls.__module__.startswith" }]))
      expect(aliasSetattrEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "cls.__module__.startswith" }]))
    })

    it("classifies exact imported CreateClusterDetails metadata lookups as pure without widening generic metadata maps", async () => {
      const positiveEvents = await analyze(
        [
          "from oci.container_engine.models import CreateClusterDetails",
          "CreateClusterDetails.swagger_types.get('cluster_pod_network_options')",
          "CreateClusterDetails.attribute_map.get('cluster_pod_network_options')",
        ].join("\n"),
      )

      const moduleQualifiedEvents = await analyze(
        [
          "import oci",
          "oci.container_engine.models.CreateClusterDetails.swagger_types.get('cluster_pod_network_options')",
          "oci.container_engine.models.CreateClusterDetails.attribute_map.get('cluster_pod_network_options')",
        ].join("\n"),
      )

      const aliasedImportEvents = await analyze(
        [
          "from oci.container_engine.models import CreateClusterDetails as ClusterDetails",
          "ClusterDetails.swagger_types.get('cluster_pod_network_options')",
          "ClusterDetails.attribute_map.get('cluster_pod_network_options')",
        ].join("\n"),
      )

      const wrongModuleEvents = await analyze(
        [
          "from fake_sdk import CreateClusterDetails",
          "CreateClusterDetails.swagger_types.get('cluster_pod_network_options')",
          "CreateClusterDetails.attribute_map.get('cluster_pod_network_options')",
        ].join("\n"),
      )

      const shadowedEvents = await analyze(
        [
          "from oci.container_engine.models import CreateClusterDetails",
          "CreateClusterDetails = object()",
          "CreateClusterDetails.swagger_types.get('cluster_pod_network_options')",
          "CreateClusterDetails.attribute_map.get('cluster_pod_network_options')",
        ].join("\n"),
      )

      const assignmentEvents = await analyze(
        [
          "from oci.container_engine.models import CreateClusterDetails",
          "CreateClusterDetails.attribute_map = 0",
          "CreateClusterDetails.swagger_types = 0",
          "CreateClusterDetails.swagger_types.get('cluster_pod_network_options')",
          "CreateClusterDetails.attribute_map.get('cluster_pod_network_options')",
        ].join("\n"),
      )

      const aliasAssignmentEvents = await analyze(
        [
          "from oci.container_engine.models import CreateClusterDetails",
          "alias = CreateClusterDetails",
          "alias.attribute_map = 0",
          "alias.swagger_types = 0",
          "CreateClusterDetails.swagger_types.get('cluster_pod_network_options')",
          "CreateClusterDetails.attribute_map.get('cluster_pod_network_options')",
        ].join("\n"),
      )

      const setattrEvents = await analyze(
        [
          "from oci.container_engine.models import CreateClusterDetails",
          "setattr(CreateClusterDetails, 'attribute_map', 0)",
          "setattr(CreateClusterDetails, 'swagger_types', 0)",
          "CreateClusterDetails.swagger_types.get('cluster_pod_network_options')",
          "CreateClusterDetails.attribute_map.get('cluster_pod_network_options')",
        ].join("\n"),
      )

      const aliasSetattrEvents = await analyze(
        [
          "from oci.container_engine.models import CreateClusterDetails",
          "alias = CreateClusterDetails",
          "setattr(alias, 'attribute_map', 0)",
          "setattr(alias, 'swagger_types', 0)",
          "CreateClusterDetails.swagger_types.get('cluster_pod_network_options')",
          "CreateClusterDetails.attribute_map.get('cluster_pod_network_options')",
        ].join("\n"),
      )

      expect(positiveEvents).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "CreateClusterDetails.swagger_types.get" },
          { kind: "pure", call: "CreateClusterDetails.attribute_map.get" },
        ]),
      )
      expect(positiveEvents).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:CreateClusterDetails.swagger_types.get" },
          { kind: "unknown", call: "callable:CreateClusterDetails.attribute_map.get" },
        ]),
      )

      for (const events of [moduleQualifiedEvents, aliasedImportEvents, wrongModuleEvents, shadowedEvents, assignmentEvents, aliasAssignmentEvents, setattrEvents, aliasSetattrEvents]) {
        expect(events.some((event) => event.kind === "unknown" && event.call.endsWith("CreateClusterDetails.swagger_types.get"))).toBe(true)
        expect(events.some((event) => event.kind === "unknown" && event.call.endsWith("CreateClusterDetails.attribute_map.get"))).toBe(true)
        expect(events.some((event) => event.kind === "pure" && event.call.endsWith("CreateClusterDetails.swagger_types.get"))).toBe(false)
        expect(events.some((event) => event.kind === "pure" && event.call.endsWith("CreateClusterDetails.attribute_map.get"))).toBe(false)
      }
    })

    it("classifies bounded OCI list_policies statement strings without widening generic response fields", async () => {
      const positiveEvents = await analyze(
        [
          "import oci",
          "identity = oci.identity.IdentityClient(config)",
          "policies = oci.pagination.list_call_get_all_results(identity.list_policies, tenancy).data",
          "for policy in policies:",
          "    for statement in policy.statements:",
          "        statement.lower()",
          "    for stmt in policy.statements:",
          "        stmt.lower().strip()",
        ].join("\n"),
      )

      const assignmentEvents = await analyze(
        [
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
      )

      const aliasMutationEvents = await analyze(
        [
          "import oci",
          "identity = oci.identity.IdentityClient(config)",
          "policies = oci.pagination.list_call_get_all_results(identity.list_policies, tenancy).data",
          "for policy in policies:",
          "    alias = policy",
          "    alias.name = other",
          "    policy.name.lower()",
          "    alias.statements = [obj]",
          "    for stmt in policy.statements:",
          "        stmt.lower().strip()",
        ].join("\n"),
      )

      const setattrEvents = await analyze(
        [
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
      )

      const shadowedOciEvents = await analyze(
        [
          "oci = other",
          "policies = oci.pagination.list_call_get_all_results(identity.list_policies, tenancy).data",
          "for policy in policies:",
          "    for statement in policy.statements:",
          "        statement.lower()",
        ].join("\n"),
      )

      const iterableMutationEvents = await analyze(
        [
          "import oci",
          "identity = oci.identity.IdentityClient(config)",
          "policies = oci.pagination.list_call_get_all_results(identity.list_policies, tenancy).data",
          "policies.append(obj)",
          "for policy in policies:",
          "    for statement in policy.statements:",
          "        statement.lower()",
        ].join("\n"),
      )

      const iterableAliasMutationEvents = await analyze(
        [
          "import oci",
          "identity = oci.identity.IdentityClient(config)",
          "policies = oci.pagination.list_call_get_all_results(identity.list_policies, tenancy).data",
          "alias = policies",
          "alias.append(obj)",
          "for policy in policies:",
          "    for stmt in policy.statements:",
          "        stmt.lower().strip()",
        ].join("\n"),
      )

      const statementsAliasEvents = await analyze(
        [
          "import oci",
          "identity = oci.identity.IdentityClient(config)",
          "policies = oci.pagination.list_call_get_all_results(identity.list_policies, tenancy).data",
          "for policy in policies:",
          "    stmts = policy.statements",
          "    policy.statements.append(obj)",
          "    for statement in stmts:",
          "        statement.lower()",
        ].join("\n"),
      )

      const subscriptMutationEvents = await analyze(
        [
          "import oci",
          "identity = oci.identity.IdentityClient(config)",
          "policies = oci.pagination.list_call_get_all_results(identity.list_policies, tenancy).data",
          "policies[0] = obj",
          "for policy in policies:",
          "    for statement in policy.statements:",
          "        statement.lower()",
        ].join("\n"),
      )

      const fakeMethodEvents = await analyze(
        [
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
      )

      const paginationMonkeypatchEvents = await analyze(
        [
          "import oci",
          "identity = oci.identity.IdentityClient(config)",
          "oci.pagination.list_call_get_all_results = fake",
          "policies = oci.pagination.list_call_get_all_results(identity.list_policies, tenancy).data",
          "for policy in policies:",
          "    for statement in policy.statements:",
          "        statement.lower()",
        ].join("\n"),
      )

      const identityCtorMonkeypatchEvents = await analyze(
        [
          "import oci",
          "oci.identity.IdentityClient = fake",
          "identity = oci.identity.IdentityClient(config)",
          "policies = oci.pagination.list_call_get_all_results(identity.list_policies, tenancy).data",
          "for policy in policies:",
          "    for statement in policy.statements:",
          "        statement.lower()",
        ].join("\n"),
      )

      expect(positiveEvents).toEqual(
        expect.arrayContaining([
          { kind: "exec", call: "oci.identity.IdentityClient" },
          { kind: "exec", call: "oci.pagination.list_call_get_all_results" },
          { kind: "pure", call: "statement.lower" },
          { kind: "pure", call: "stmt.lower" },
          { kind: "pure", call: "stmt.lower.strip" },
        ]),
      )
      expect(positiveEvents).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:statement.lower" },
          { kind: "unknown", call: "callable:stmt.lower" },
          { kind: "unknown", call: "callable:stmt.lower.strip" },
        ]),
      )

      expect(assignmentEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:policy.name.lower" }, { kind: "unknown", call: "callable:statement.lower" }]))
      expect(assignmentEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "policy.name.lower" }, { kind: "pure", call: "statement.lower" }]))

      expect(aliasMutationEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:policy.name.lower" }, { kind: "unknown", call: "callable:stmt.lower" }, { kind: "unknown", call: "callable:stmt.lower.strip" }]))
      expect(aliasMutationEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "policy.name.lower" }, { kind: "pure", call: "stmt.lower" }, { kind: "pure", call: "stmt.lower.strip" }]))

      expect(setattrEvents).toEqual(expect.arrayContaining([{ kind: "pure", call: "setattr" }, { kind: "unknown", call: "callable:policy.name.lower" }, { kind: "unknown", call: "callable:stmt.lower" }, { kind: "unknown", call: "callable:stmt.lower.strip" }]))
      expect(setattrEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "policy.name.lower" }, { kind: "pure", call: "stmt.lower" }, { kind: "pure", call: "stmt.lower.strip" }]))

      expect(shadowedOciEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:statement.lower" }]))
      expect(shadowedOciEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "statement.lower" }]))

      expect(iterableMutationEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:policies.append" }, { kind: "unknown", call: "callable:statement.lower" }]))
      expect(iterableMutationEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "statement.lower" }]))

      expect(iterableAliasMutationEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:policies.append" }, { kind: "unknown", call: "callable:stmt.lower" }, { kind: "unknown", call: "callable:stmt.lower.strip" }]))
      expect(iterableAliasMutationEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "stmt.lower" }, { kind: "pure", call: "stmt.lower.strip" }]))

      expect(statementsAliasEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:statement.lower" }]))
      expect(statementsAliasEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "statement.lower" }]))

      expect(subscriptMutationEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:statement.lower" }]))
      expect(subscriptMutationEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "statement.lower" }]))

      expect(fakeMethodEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:statement.lower" }]))
      expect(fakeMethodEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "statement.lower" }]))

      expect(paginationMonkeypatchEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:statement.lower" }]))
      expect(paginationMonkeypatchEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "statement.lower" }]))

      expect(identityCtorMonkeypatchEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:statement.lower" }]))
      expect(identityCtorMonkeypatchEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "statement.lower" }]))
    })

    it("clears dir-derived string origins after mutating list methods", async () => {
      const events = await analyze(
        [
          "names = dir(obj)",
          "names.extend(other)",
          "name = names[0]",
          "name.lower()",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:name.lower" }]))
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "name.lower" }]))
    })

    it("clears dir-derived string origins through aliases and comprehension mutations", async () => {
      const aliasEvents = await analyze(
        [
          "names = dir(obj)",
          "alias = names",
          "alias.extend(other)",
          "name = names[0]",
          "name.lower()",
        ].join("\n"),
      )

      const comprehensionEvents = await analyze(
        [
          "names = dir(obj)",
          "[names.append(other) for _ in xs]",
          "name = names[0]",
          "name.lower()",
        ].join("\n"),
      )

      expect(aliasEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:name.lower" }]))
      expect(comprehensionEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:name.lower" }]))
    })

    it("keeps tracked string locals conservative after reassignment", async () => {
      const events = await analyze(
        [
          "from pathlib import Path",
          "text = Path('f').read_text()",
          "line = text.splitlines()[0]",
          "line = other",
          "line.split(' ', 1)",
          "line.strip()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:other.split" },
          { kind: "unknown", call: "callable:other.strip" },
        ]),
      )
    })

    it("tracks homogeneous dict values and defaultdict factories for subscript container methods", async () => {
      const events = await analyze(
        [
          "from collections import defaultdict",
          "family_aliases = defaultdict(set)",
          "family_aliases[fam].add(cand.get('call'))",
          "inv = {'runtime': [], 'inline': []}",
          "inv[current].append(item)",
          "inv[current].pop()",
          "family_aliases[fam] = other",
          "family_aliases[fam].add(value)",
          "inv[current] = other",
          "inv[current].append(item)",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "collections.defaultdict" },
          { kind: "pure", call: "family_aliases.add" },
          { kind: "pure", call: "inv.append" },
          { kind: "pure", call: "inv.pop" },
          { kind: "unknown", call: "callable:family_aliases.add" },
          { kind: "unknown", call: "callable:inv.append" },
        ]),
      )
    })

    it("tracks defaultdict Counter values through items destructuring", async () => {
      const events = await analyze(
        [
          "from collections import Counter, defaultdict",
          "buckets = defaultdict(Counter)",
          "buckets['pytest']['pytest.main'] += 1",
          "for bucket, counts in buckets.items():",
          "    counts.most_common()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "collections.defaultdict" },
          { kind: "pure", call: "buckets.items" },
          { kind: "pure", call: "counts.most_common" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:buckets.items" },
          { kind: "unknown", call: "callable:counts.most_common" },
        ]),
      )
    })

    it("supports trusted aliased Counter factories for defaultdict items destructuring", async () => {
      const events = await analyze(
        [
          "from collections import Counter as Tally, defaultdict",
          "buckets = defaultdict(Tally)",
          "for bucket, counts in buckets.items():",
          "    counts.most_common()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "collections.defaultdict" },
          { kind: "pure", call: "buckets.items" },
          { kind: "pure", call: "counts.most_common" },
        ]),
      )
    })

    it("keeps defaultdict items destructuring conservative when the Counter factory is shadowed", async () => {
      const events = await analyze(
        [
          "from collections import defaultdict",
          "def Counter(*args, **kwargs):",
          "    return {}",
          "buckets = defaultdict(Counter)",
          "for bucket, counts in buckets.items():",
          "    counts.most_common()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:buckets.items" },
          { kind: "unknown", call: "callable:counts.most_common" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "counts.most_common" }]))
    })

    it("clears defaultdict Counter item provenance after widening dict mutations", async () => {
      const updateEvents = await analyze(
        [
          "from collections import Counter, defaultdict",
          "buckets = defaultdict(Counter)",
          "alias = buckets",
          "alias.update({'other': value})",
          "for bucket, counts in buckets.items():",
          "    counts.most_common()",
        ].join("\n"),
      )

      const setdefaultEvents = await analyze(
        [
          "from collections import Counter, defaultdict",
          "buckets = defaultdict(Counter)",
          "buckets.setdefault('other', value)",
          "for bucket, counts in buckets.items():",
          "    counts.most_common()",
        ].join("\n"),
      )

      expect(updateEvents).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:buckets.items" },
          { kind: "unknown", call: "callable:counts.most_common" },
        ]),
      )
      expect(setdefaultEvents).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:buckets.items" },
          { kind: "unknown", call: "callable:counts.most_common" },
        ]),
      )
    })

    it("clears defaultdict Counter item provenance after default_factory rebinding", async () => {
      const assignmentEvents = await analyze(
        [
          "from collections import Counter, defaultdict",
          "buckets = defaultdict(Counter)",
          "buckets.default_factory = dict",
          "buckets['other']",
          "for bucket, counts in buckets.items():",
          "    counts.most_common()",
        ].join("\n"),
      )

      const setattrEvents = await analyze(
        [
          "from collections import Counter, defaultdict",
          "buckets = defaultdict(Counter)",
          "setattr(buckets, 'default_factory', dict)",
          "buckets['other']",
          "for bucket, counts in buckets.items():",
          "    counts.most_common()",
        ].join("\n"),
      )

      const aliasSetattrEvents = await analyze(
        [
          "from collections import Counter, defaultdict",
          "buckets = defaultdict(Counter)",
          "alias = buckets",
          "setattr(alias, 'default_factory', dict)",
          "buckets['other']",
          "for bucket, counts in buckets.items():",
          "    counts.most_common()",
        ].join("\n"),
      )

      expect(assignmentEvents).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:buckets.items" },
          { kind: "unknown", call: "callable:counts.most_common" },
        ]),
      )
      expect(setattrEvents).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:buckets.items" },
          { kind: "unknown", call: "callable:counts.most_common" },
        ]),
      )
      expect(aliasSetattrEvents).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:buckets.items" },
          { kind: "unknown", call: "callable:counts.most_common" },
        ]),
      )
    })

    it("keeps defaultdict Counter items destructuring conservative for nested value patterns", async () => {
      const events = await analyze(
        [
          "from collections import Counter, defaultdict",
          "buckets = defaultdict(Counter)",
          "for bucket, (left, right) in buckets.items():",
          "    left.most_common()",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:left.most_common" }]))
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "left.most_common" }]))
    })

    it("keeps dict-value container provenance conservative when dictionary literals use splats", async () => {
      const events = await analyze(
        [
          "values = {'runtime': [], **other}",
          "values[current].append(item)",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:values.append" }]))
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "values.append" }]))
    })

    it("keeps compiled-regex methods conservative on unrelated receivers and shadowed compile names", async () => {
      const shadowedCompileEvents = await analyze(
        [
          "from re import compile",
          "def compile(pattern):",
          "    return pattern",
          "compile('a+').search(text)",
        ].join("\n"),
      )

      const unrelatedReceiverEvents = await analyze(
        [
          "class Bucket:",
          "    def search(self, text):",
          "        return text",
          "bucket = Bucket()",
          "bucket.search(text)",
        ].join("\n"),
      )

      const trackedPatternEvents = await analyze(
        [
          "import re",
          "pat = re.compile('a+')",
          "re = object()",
          "pat.search(text)",
        ].join("\n"),
      )

      const shadowedModuleEvents = await analyze(
        [
          "import re",
          "re = object()",
          "re.compile('a+').search(text)",
        ].join("\n"),
      )

      expect(shadowedCompileEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:compile.search" }]))
      expect(unrelatedReceiverEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:bucket.search" }]))
      expect(trackedPatternEvents).toEqual(expect.arrayContaining([{ kind: "pure", call: "pat.search" }]))
      expect(shadowedModuleEvents).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:re.compile" },
          { kind: "unknown", call: "callable:re.compile.search" },
        ]),
      )
    })

    it("classifies explicit ast helpers as pure", async () => {
      const events = await analyze(
        [
          "import ast",
          "tree = ast.parse('x = 1')",
          "ast.dump(tree)",
          "ast.walk(tree)",
          "ast.iter_fields(tree)",
          "ast.iter_child_nodes(tree)",
          "ast.literal_eval('[1, 2, 3]')",
          "ast.get_source_segment('x = 1', tree)",
          "ast.fix_missing_locations(tree)",
          "ast.increment_lineno(tree)",
          "ast.copy_location(tree, tree)",
          "ast.unparse(tree)",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "ast.parse" },
          { kind: "pure", call: "ast.dump" },
          { kind: "pure", call: "ast.walk" },
          { kind: "pure", call: "ast.iter_fields" },
          { kind: "pure", call: "ast.iter_child_nodes" },
          { kind: "pure", call: "ast.literal_eval" },
          { kind: "pure", call: "ast.get_source_segment" },
          { kind: "pure", call: "ast.fix_missing_locations" },
          { kind: "pure", call: "ast.increment_lineno" },
          { kind: "pure", call: "ast.copy_location" },
          { kind: "pure", call: "ast.unparse" },
        ]),
      )
    })

    it("classifies direct-imported ast helpers as pure and keeps shadowed names conservative", async () => {
      const events = await analyze(
        [
          "from ast import parse, dump, literal_eval",
          "tree = parse('x = 1')",
          "dump(tree)",
          "literal_eval('[1, 2, 3]')",
          "parse = other",
          "parse(source)",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "ast.parse" },
          { kind: "pure", call: "ast.dump" },
          { kind: "pure", call: "ast.literal_eval" },
          { kind: "unknown", call: "callable:other" },
        ]),
      )
    })

    it("narrows guarded item.lower receivers from exact membership without widening unguarded literal_eval loops", async () => {
      const guardedEvents = await analyze(
        [
          "import ast",
          "raw = '[\"Health Benefit Analytic Sol\", \"Other\"]'",
          "items = ast.literal_eval(raw)",
          "li_depts = ['Health Benefit Analytic Sol', 'D&DS Product', 'ITPMA', 'Core Services', 'Enterprise Data Mgmt', 'DHP IT', 'Transformation & Integrations', 'Claims', 'HST IT']",
          "for item in items:",
          "    normalized = item.lower() if item in li_depts else item",
        ].join("\n"),
      )

      const unguardedEvents = await analyze(
        [
          "import ast",
          "raw = '[\"Health Benefit Analytic Sol\", \"Other\"]'",
          "items = ast.literal_eval(raw)",
          "for item in items:",
          "    item.lower()",
        ].join("\n"),
      )

      const negativeGuardEvents = await analyze(
        [
          "import ast",
          "raw = '[\"Health Benefit Analytic Sol\", \"Other\"]'",
          "items = ast.literal_eval(raw)",
          "li_depts = ['Health Benefit Analytic Sol', 'D&DS Product', 'ITPMA', 'Core Services', 'Enterprise Data Mgmt', 'DHP IT', 'Transformation & Integrations', 'Claims', 'HST IT']",
          "flag = False",
          "for item in items:",
          "    lowered = item.lower() if item not in li_depts else item",
          "    maybe = item.lower() if flag or item in li_depts else item",
        ].join("\n"),
      )

      expect(guardedEvents).toEqual(expect.arrayContaining([{ kind: "pure", call: "item.lower" }]))
      expect(guardedEvents).not.toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:item.lower" }]))

      expect(unguardedEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:item.lower" }]))
      expect(unguardedEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "item.lower" }]))

      expect(negativeGuardEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:item.lower" }]))
      expect(negativeGuardEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "item.lower" }]))

      const outerGuardShadowEvents = await analyze(
        [
          "import ast",
          "raw = '[\"Health Benefit Analytic Sol\", \"Other\"]'",
          "items = ast.literal_eval(raw)",
          "li_depts = ['Health Benefit Analytic Sol', 'D&DS Product', 'ITPMA', 'Core Services', 'Enterprise Data Mgmt', 'DHP IT', 'Transformation & Integrations', 'Claims', 'HST IT']",
          "item = 'Health Benefit Analytic Sol'",
          "if item in li_depts:",
          "    lowered = [item.lower() for item in items]",
        ].join("\n"),
      )

      const booleanGuardRebindEvents = await analyze(
        [
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
      )

      const scalarMembershipEvents = await analyze(
        [
          "import ast",
          "raw = '[\"Health Benefit Analytic Sol\", \"Other\"]'",
          "items = ast.literal_eval(raw)",
          "allowed = 'Health Benefit Analytic Sol'",
          "for item in items:",
          "    normalized = item.lower() if item in allowed else item",
        ].join("\n"),
      )

      expect(outerGuardShadowEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:item.lower" }]))
      expect(outerGuardShadowEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "item.lower" }]))

      expect(booleanGuardRebindEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:item.lower" }]))
      expect(booleanGuardRebindEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "item.lower" }]))

      expect(scalarMembershipEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:item.lower" }]))
      expect(scalarMembershipEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "item.lower" }]))
    })

    it("classifies builtin str() results as string receivers and keeps shadowed str conservative", async () => {
      const events = await analyze(
        [
          "from pathlib import Path",
          "root = Path('src')",
          "cand = root / 'python.ts'",
          "str(cand).startswith(str(root))",
          "text = str(cand)",
          "text.lower()",
        ].join("\n"),
      )

      const shadowedEvents = await analyze(
        [
          "from pathlib import Path",
          "root = Path('src')",
          "str = builder",
          "text = str(root)",
          "text.startswith('src')",
          "text.lower()",
        ].join("\n"),
      )

      const parameterShadowedEvents = await analyze(
        [
          "from pathlib import Path",
          "root = Path('src')",
          "def render(str):",
          "    text = str(root)",
          "    text.lower()",
          "render(builder)",
        ].join("\n"),
      )

      const reboundEvents = await analyze(
        [
          "from pathlib import Path",
          "root = Path('src')",
          "text = str(root)",
          "text = other",
          "text.lower()",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "pure", call: "str" }, { kind: "pure", call: "str.startswith" }, { kind: "pure", call: "text.lower" }]))
      expect(events.filter((event) => event.kind === "pure" && event.call === "str")).toHaveLength(1)
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:str.startswith" }, { kind: "unknown", call: "callable:text.lower" }]))

      expect(shadowedEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:builder" }, { kind: "unknown", call: "callable:text.startswith" }, { kind: "unknown", call: "callable:text.lower" }]))
      expect(parameterShadowedEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:str" }, { kind: "unknown", call: "callable:text.lower" }]))
      expect(reboundEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:other.lower" }]))
      expect(shadowedEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "str.startswith" }, { kind: "pure", call: "text.lower" }]))
    })

    it("classifies unittest.mock constructors, patch helpers, and tracked mock methods as pure", async () => {
      const events = await analyze(
        [
          "from unittest.mock import AsyncMock, Mock, patch",
          "mock = Mock(return_value='service')",
          "mock.assert_not_called()",
          "mock.reset_mock()",
          "async_mock = AsyncMock()",
          "async_mock.assert_not_awaited()",
          "patch('__main__.VALUE', 1)",
          "patch.object(mock, 'name', 'svc')",
          "patch.dict(env, {'X': '1'})",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "unittest.mock.Mock" },
          { kind: "pure", call: "mock.assert_not_called" },
          { kind: "pure", call: "mock.reset_mock" },
          { kind: "pure", call: "unittest.mock.AsyncMock" },
          { kind: "pure", call: "async_mock.assert_not_awaited" },
          { kind: "pure", call: "unittest.mock.patch" },
          { kind: "pure", call: "unittest.mock.patch.object" },
          { kind: "pure", call: "unittest.mock.patch.dict" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:mock.assert_not_called" },
          { kind: "unknown", call: "callable:async_mock.assert_not_awaited" },
          { kind: "unknown", call: "callable:patch" },
        ]),
      )
    })

    it("keeps shadowed mock constructors and arbitrary assert-like receivers conservative", async () => {
      const events = await analyze(
        [
          "from unittest.mock import Mock",
          "Mock = factory",
          "Mock()",
          "obj.assert_not_called()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:factory" },
          { kind: "unknown", call: "callable:obj.assert_not_called" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "unittest.mock.Mock" }]))
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

    it("tracks iterated regex match results for downstream start/end methods without widening iterator receivers", async () => {
      const events = await analyze(
        [
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
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "re.finditer" },
          { kind: "pure", call: "m.start" },
          { kind: "pure", call: "m.end" },
          { kind: "pure", call: "re.compile" },
          { kind: "pure", call: "pat.finditer" },
        ]),
      )
      expect(events).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:matches.start" }]))
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "matches.start" }]))
    })

    it("tracks regex match group string returns for downstream string methods without widening arbitrary group-like receivers", async () => {
      const events = await analyze(
        [
          "import re",
          "m = re.match(r'(foo)', text)",
          "m.group(1).endswith('oo')",
          "m.group(1).replace('f', 'b')",
        ].join("\n"),
      )

      const broadEvents = await analyze(
        [
          "import re",
          "m = re.match(r'(foo)(bar)', text)",
          "m.group(1, 2).endswith('oo')",
          "obj.group(1).replace('f', 'b')",
        ].join("\n"),
      )

      const shadowedEvents = await analyze(
        [
          "import re",
          "re = object()",
          "m = re.match(r'(foo)', text)",
          "m.group(1).endswith('oo')",
          "m.group(1).replace('f', 'b')",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "pure", call: "m.group.endswith" }, { kind: "pure", call: "m.group.replace" }]))
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:m.group.endswith" }, { kind: "unknown", call: "callable:m.group.replace" }]))

      expect(broadEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:m.group.endswith" }, { kind: "unknown", call: "callable:obj.group.replace" }]))
      expect(broadEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "m.group.endswith" }, { kind: "pure", call: "obj.group.replace" }]))
      expect(shadowedEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:m.group.endswith" }, { kind: "unknown", call: "callable:m.group.replace" }]))
      expect(shadowedEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "m.group.endswith" }, { kind: "pure", call: "m.group.replace" }]))
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

    it("keeps re.sub outside pure classification by default but tracks non-callable replacement string results", async () => {
      const events = await analyze(
        [
          "import re",
          "text = 'aaTITLEbb'",
          "re.sub('a+', '-', text)",
          "sec = re.sub('a+', '-', text)",
          "sec.split('TITLE').count('')",
          "re.sub('a+', '-', text).split('TITLE').count('')",
        ].join("\n"),
      )

      const callableEvents = await analyze(
        [
          "import re",
          "text = 'aaTITLEbb'",
          "def repl(m):",
          "    return '-'",
          "sec = re.sub('a+', repl, text)",
          "sec.split('TITLE').count('')",
        ].join("\n"),
      )

      const shadowedEvents = await analyze(
        [
          "import re",
          "re = fake",
          "text = 'aaTITLEbb'",
          "sec = re.sub('a+', '-', text)",
          "sec.split('TITLE').count('')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:re.sub" },
          { kind: "pure", call: "sec.split" },
          { kind: "pure", call: "sec.split.count" },
          { kind: "pure", call: "re.sub.split" },
          { kind: "pure", call: "re.sub.split.count" },
        ]),
      )
      expect(callableEvents).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:re.sub" },
          { kind: "unknown", call: "callable:sec.split" },
        ]),
      )
      expect(shadowedEvents).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:fake.sub" },
          { kind: "unknown", call: "callable:sec.split" },
        ]),
      )
    })
  })

})
