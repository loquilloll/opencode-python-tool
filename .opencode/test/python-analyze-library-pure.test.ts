import { describe, expect, it } from "bun:test"
import { analyze } from "../tool/python-analyze"

describe("python analyzer", () => {
  describe("inspect classification", () => {
    it("classifies inspect module helpers as pure or read", async () => {
      const events = await analyze(
        [
          "import inspect",
          "inspect.isfunction(fn)",
          "inspect.unwrap(fn)",
          "inspect.signature(fn)",
          "inspect.get_annotations(obj)",
          "inspect.getsource(fn)",
          "inspect.stack()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "inspect.isfunction" },
          { kind: "pure", call: "inspect.unwrap" },
          { kind: "pure", call: "inspect.signature" },
          { kind: "pure", call: "inspect.get_annotations" },
          { kind: "read", call: "inspect.getsource" },
          { kind: "read", call: "inspect.stack" },
        ]),
      )
    })

    it("classifies direct-imported inspect helpers and tracked inspect methods", async () => {
      const events = await analyze(
        [
          "from inspect import Signature, Parameter, getsource, isfunction, signature",
          "sig = signature(fn)",
          "sig.bind(1)",
          "bound = sig.bind_partial(2)",
          "bound.apply_defaults()",
          "sig2 = Signature.from_callable(fn)",
          "sig2.replace(return_annotation=int)",
          "rendered = sig2.format()",
          "rendered.startswith('(')",
          "param = Parameter('x', Parameter.POSITIONAL_ONLY)",
          "param.replace(default=1)",
          "getsource(fn)",
          "isfunction(fn)",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "inspect.signature" },
          { kind: "pure", call: "sig.bind" },
          { kind: "pure", call: "sig.bind_partial" },
          { kind: "pure", call: "bound.apply_defaults" },
          { kind: "pure", call: "inspect.Signature.from_callable" },
          { kind: "pure", call: "sig2.replace" },
          { kind: "pure", call: "sig2.format" },
          { kind: "pure", call: "rendered.startswith" },
          { kind: "pure", call: "inspect.Parameter" },
          { kind: "pure", call: "param.replace" },
          { kind: "read", call: "inspect.getsource" },
          { kind: "pure", call: "inspect.isfunction" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:sig.bind" },
          { kind: "unknown", call: "callable:bound.apply_defaults" },
          { kind: "unknown", call: "callable:sig2.replace" },
          { kind: "unknown", call: "callable:param.replace" },
        ]),
      )
    })

    it("keeps risky inspect annotation evaluation paths conservative", async () => {
      const events = await analyze(
        [
          "import inspect",
          "inspect.signature(fn, eval_str=True)",
          "inspect.get_annotations(obj, eval_str=True)",
          "inspect.Signature.from_callable(fn, eval_str=True)",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:inspect.signature" },
          { kind: "unknown", call: "callable:inspect.get_annotations" },
          { kind: "unknown", call: "callable:inspect.Signature.from_callable" },
        ]),
      )
    })
  })

  describe("datetime classification", () => {
    it("classifies datetime constructors, parsers, and clock helpers", async () => {
      const events = await analyze(
        [
          "import datetime as dt",
          "dt.date(2024, 1, 2)",
          "dt.date.today()",
          "dt.date.fromtimestamp(123)",
          "dt.date.fromisoformat('2024-01-02')",
          "dt.datetime(2024, 1, 2, 3, 4, 5)",
          "dt.datetime.now(dt.UTC)",
          "dt.datetime.today()",
          "dt.datetime.utcnow()",
          "dt.datetime.fromtimestamp(123, dt.UTC)",
          "dt.datetime.utcfromtimestamp(123)",
          "dt.datetime.fromisoformat('2024-01-02T03:04:05+00:00')",
          "dt.datetime.combine(dt.date(2024, 1, 2), dt.time(3, 4, 5))",
          "dt.time(3, 4, 5)",
          "dt.time.fromisoformat('03:04:05')",
          "dt.timedelta(days=1)",
          "dt.timezone(dt.timedelta(hours=1))",
          "dt.tzinfo()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "datetime.date" },
          { kind: "read", call: "datetime.date.today" },
          { kind: "pure", call: "datetime.date.fromtimestamp" },
          { kind: "pure", call: "datetime.date.fromisoformat" },
          { kind: "pure", call: "datetime.datetime" },
          { kind: "read", call: "datetime.datetime.now" },
          { kind: "read", call: "datetime.datetime.today" },
          { kind: "read", call: "datetime.datetime.utcnow" },
          { kind: "pure", call: "datetime.datetime.fromtimestamp" },
          { kind: "pure", call: "datetime.datetime.utcfromtimestamp" },
          { kind: "pure", call: "datetime.datetime.fromisoformat" },
          { kind: "pure", call: "datetime.datetime.combine" },
          { kind: "pure", call: "datetime.time" },
          { kind: "pure", call: "datetime.time.fromisoformat" },
          { kind: "pure", call: "datetime.timedelta" },
          { kind: "pure", call: "datetime.timezone" },
          { kind: "pure", call: "datetime.tzinfo" },
        ]),
      )
    })

    it("classifies direct-imported datetime methods and tracked return chains", async () => {
      const events = await analyze(
        [
          "from datetime import UTC, date, datetime, timedelta, timezone",
          "today = date.today()",
          "today.isoformat()",
          "shifted = today.replace(day=3)",
          "shifted.isoformat()",
          "when = datetime.fromisoformat('2024-01-02T03:04:05+00:00')",
          "when.astimezone(UTC)",
          "day = when.date()",
          "day.isoformat()",
          "clock = when.time()",
          "clock.replace(hour=4)",
          "delay = timedelta(seconds=30)",
          "seconds = delay.total_seconds()",
          "seconds.is_integer()",
          "label = timezone(timedelta(hours=2)).tzname(None)",
          "label.lower()",
          "UTC.tzname(None)",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "datetime.date.today" },
          { kind: "pure", call: "today.isoformat" },
          { kind: "pure", call: "today.replace" },
          { kind: "pure", call: "shifted.isoformat" },
          { kind: "pure", call: "datetime.datetime.fromisoformat" },
          { kind: "pure", call: "when.astimezone" },
          { kind: "pure", call: "when.date" },
          { kind: "pure", call: "day.isoformat" },
          { kind: "pure", call: "when.time" },
          { kind: "pure", call: "clock.replace" },
          { kind: "pure", call: "datetime.timedelta" },
          { kind: "pure", call: "delay.total_seconds" },
          { kind: "pure", call: "seconds.is_integer" },
          { kind: "pure", call: "datetime.timezone" },
          { kind: "pure", call: "datetime.timezone.tzname" },
          { kind: "pure", call: "label.lower" },
          { kind: "pure", call: "datetime.UTC.tzname" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:today.isoformat" },
          { kind: "unknown", call: "callable:when.astimezone" },
          { kind: "unknown", call: "callable:day.isoformat" },
          { kind: "unknown", call: "callable:clock.replace" },
          { kind: "unknown", call: "callable:delay.total_seconds" },
          { kind: "unknown", call: "callable:label.lower" },
          { kind: "unknown", call: "callable:datetime.UTC.tzname" },
        ]),
      )
    })

    it("classifies bounded helper-return datetime chains and helper-local timedeltas", async () => {
      const events = await analyze(
        [
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
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "raw.replace" },
          { kind: "pure", call: "datetime.datetime.fromisoformat" },
          { kind: "pure", call: "start.isoformat" },
          { kind: "pure", call: "gap.total_seconds" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:raw.replace" },
          { kind: "unknown", call: "callable:start.isoformat" },
          { kind: "unknown", call: "callable:gap.total_seconds" },
        ]),
      )
    })

    it("keeps helper-based datetime inference conservative for optional returns, aliases, and mixed seeds", async () => {
      const events = await analyze(
        [
          "from datetime import datetime",
          "def maybe(raw):",
          "    if raw == 'skip':",
          "        return None",
          "    return datetime.fromisoformat(raw.replace('Z', '+00:00'))",
          "start = maybe('2024-01-02T03:04:05Z')",
          "start.isoformat()",
          "def parse(raw):",
          "    return datetime.fromisoformat(raw.replace('Z', '+00:00'))",
          "direct = parse('2024-01-02T03:04:35Z')",
          "parse(42)",
          "other = (parse)",
          "other(42)",
          "direct.isoformat()",
          "def secs(a, b):",
          "    gap = b - a",
          "    return gap.total_seconds()",
          "end = datetime.fromisoformat('2024-01-02T03:05:05+00:00')",
          "secs(datetime.fromisoformat('2024-01-02T03:04:05+00:00'), end)",
          "secs('oops', end)",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:start.isoformat" },
          { kind: "unknown", call: "callable:raw.replace" },
          { kind: "unknown", call: "callable:direct.isoformat" },
          { kind: "unknown", call: "callable:gap.total_seconds" },
        ]),
      )
    })

    it("keeps shadowed datetime roots conservative", async () => {
      const events = await analyze(
        [
          "import datetime",
          "datetime = object()",
          "datetime.UTC.tzname(None)",
          "datetime.datetime.fromisoformat('2024-01-02T03:04:05+00:00')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:datetime.UTC.tzname" },
          { kind: "unknown", call: "callable:datetime.datetime.fromisoformat" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "datetime.UTC.tzname" },
          { kind: "pure", call: "datetime.datetime.fromisoformat" },
          { kind: "read", call: "datetime.UTC.tzname" },
        ]),
      )
    })

    it("tracks bounded datetime tuple slots through tuple destructuring and indexed tuple reads", async () => {
      const events = await analyze(
        [
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
        ].join("\n"),
      )

      const mutatedEvents = await analyze(
        [
          "from datetime import datetime",
          "attempts = []",
          "for raw in ['2024-01-02T03:04:05+00:00']:",
          "    ts = datetime.fromisoformat(raw)",
          "    attempts.append((1, ts, 2))",
          "attempts[0] = (1, 'oops', 2)",
          "for idx, ts, count in attempts:",
          "    ts.isoformat()",
        ].join("\n"),
      )

      const aliasMutatedEvents = await analyze(
        [
          "from datetime import datetime",
          "attempts = []",
          "for raw in ['2024-01-02T03:04:05+00:00']:",
          "    ts = datetime.fromisoformat(raw)",
          "    attempts.append((1, ts, 2))",
          "alias = attempts",
          "alias[0] = (1, 'oops', 2)",
          "for idx, ts, count in attempts:",
          "    ts.isoformat()",
        ].join("\n"),
      )

      const boundMutatedEvents = await analyze(
        [
          "from datetime import datetime",
          "attempts = []",
          "for raw in ['2024-01-02T03:04:05+00:00']:",
          "    ts = datetime.fromisoformat(raw)",
          "    attempts.append((1, ts, 2))",
          "app = attempts.append",
          "app((1, 'oops', 2))",
          "for idx, ts, count in attempts:",
          "    ts.isoformat()",
        ].join("\n"),
      )

      const setitemMutatedEvents = await analyze(
        [
          "from datetime import datetime",
          "attempts = []",
          "for raw in ['2024-01-02T03:04:05+00:00']:",
          "    ts = datetime.fromisoformat(raw)",
          "    attempts.append((1, ts, 2))",
          "attempts.__setitem__(0, (1, 'oops', 2))",
          "for idx, ts, count in attempts:",
          "    ts.isoformat()",
        ].join("\n"),
      )

      const wrappedSetitemMutatedEvents = await analyze(
        [
          "from datetime import datetime",
          "attempts = []",
          "for raw in ['2024-01-02T03:04:05+00:00']:",
          "    ts = datetime.fromisoformat(raw)",
          "    attempts.append((1, ts, 2))",
          "list.__setitem__((attempts), 0, (1, 'oops', 2))",
          "for idx, ts, count in attempts:",
          "    ts.isoformat()",
        ].join("\n"),
      )

      const wrappedAppendMutatedEvents = await analyze(
        [
          "from datetime import datetime",
          "attempts = []",
          "for raw in ['2024-01-02T03:04:05+00:00']:",
          "    ts = datetime.fromisoformat(raw)",
          "    attempts.append((1, ts, 2))",
          "(attempts).append((1, 'oops', 2))",
          "app = attempts.append",
          "(app)((1, 'oops', 2))",
          "for idx, ts, count in attempts:",
          "    ts.isoformat()",
        ].join("\n"),
      )

      const classMethodMutatedEvents = await analyze(
        [
          "from datetime import datetime",
          "attempts = []",
          "for raw in ['2024-01-02T03:04:05+00:00']:",
          "    ts = datetime.fromisoformat(raw)",
          "    attempts.append((1, ts, 2))",
          "list.append(attempts, (1, 'oops', 2))",
          "push = list.append",
          "push(attempts, (1, 'oops', 2))",
          "for idx, ts, count in attempts:",
          "    ts.isoformat()",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "pure", call: "ts.isoformat" }, { kind: "pure", call: "attempt.isoformat" }, { kind: "pure", call: "enumerate" }]))
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:ts.isoformat" }, { kind: "unknown", call: "callable:attempt.isoformat" }]))

      for (const variant of [mutatedEvents, aliasMutatedEvents, boundMutatedEvents, setitemMutatedEvents, wrappedSetitemMutatedEvents, wrappedAppendMutatedEvents, classMethodMutatedEvents]) {
        expect(variant).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:ts.isoformat" }]))
        expect(variant).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "ts.isoformat" }]))
      }
    })

    it("tracks exact-key datetime receivers and helper args without widening mutated keys", async () => {
      const events = await analyze(
        [
          "from datetime import datetime",
          "patterns = {'start': '2024-01-02T03:04:05+00:00', 'end': '2024-01-02T03:05:05+00:00'}",
          "found = {}",
          "for key, raw in patterns.items():",
          "    found[key] = datetime.fromisoformat(raw)",
          "found['start'].isoformat()",
          "for k in patterns:",
          "    found[k].isoformat()",
          "pairs = [('start', 'end')]",
          "for a, b in pairs:",
          "    (found[b] - found[a]).total_seconds()",
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
          "(found['end'] - found['start']).total_seconds()",
        ].join("\n"),
      )

      const mutatedEvents = await analyze(
        [
          "from datetime import datetime",
          "patterns = {'start': '2024-01-02T03:04:05+00:00', 'end': '2024-01-02T03:05:05+00:00'}",
          "found = {}",
          "for key, raw in patterns.items():",
          "    found[key] = datetime.fromisoformat(raw)",
          "found['end'] = other",
          "found['start'].isoformat()",
          "for k in patterns:",
          "    found[k].isoformat()",
          "def secs(a, b):",
          "    gap = b - a",
          "    return gap.total_seconds()",
          "def measure(left, right):",
          "    return round((found[right] - found[left]).total_seconds(), 3)",
          "pairs = [('start', 'end')]",
          "pairs[0] = ('start', other)",
          "secs(found['start'], found['end'])",
          "measure('start', 'end')",
          "(found['end'] - found['start']).total_seconds()",
        ].join("\n"),
      )

      const boundUpdateEvents = await analyze(
        [
          "from datetime import datetime",
          "patterns = {'start': '2024-01-02T03:04:05+00:00', 'end': '2024-01-02T03:05:05+00:00'}",
          "found = {}",
          "for key, raw in patterns.items():",
          "    found[key] = datetime.fromisoformat(raw)",
          "upd = found.update",
          "upd({'end': other})",
          "for k in patterns:",
          "    found[k].isoformat()",
          "pairs = [('start', 'end')]",
          "for a, b in pairs:",
          "    (found[b] - found[a]).total_seconds()",
        ].join("\n"),
      )

      const setitemUpdateEvents = await analyze(
        [
          "from datetime import datetime",
          "patterns = {'start': '2024-01-02T03:04:05+00:00', 'end': '2024-01-02T03:05:05+00:00'}",
          "found = {}",
          "for key, raw in patterns.items():",
          "    found[key] = datetime.fromisoformat(raw)",
          "set_item = found.__setitem__",
          "set_item('end', other)",
          "for k in patterns:",
          "    found[k].isoformat()",
          "pairs = [('start', 'end')]",
          "for a, b in pairs:",
          "    (found[b] - found[a]).total_seconds()",
        ].join("\n"),
      )

      const wrappedSetitemUpdateEvents = await analyze(
        [
          "from datetime import datetime",
          "patterns = {'start': '2024-01-02T03:04:05+00:00', 'end': '2024-01-02T03:05:05+00:00'}",
          "found = {}",
          "for key, raw in patterns.items():",
          "    found[key] = datetime.fromisoformat(raw)",
          "dict.__setitem__((found), 'end', other)",
          "for k in patterns:",
          "    found[k].isoformat()",
          "pairs = [('start', 'end')]",
          "for a, b in pairs:",
          "    (found[b] - found[a]).total_seconds()",
        ].join("\n"),
      )

      const wrappedUpdateEvents = await analyze(
        [
          "from datetime import datetime",
          "patterns = {'start': '2024-01-02T03:04:05+00:00', 'end': '2024-01-02T03:05:05+00:00'}",
          "found = {}",
          "for key, raw in patterns.items():",
          "    found[key] = datetime.fromisoformat(raw)",
          "(found).update({'end': other})",
          "upd = found.update",
          "(upd)({'end': other})",
          "for k in patterns:",
          "    found[k].isoformat()",
          "pairs = [('start', 'end')]",
          "for a, b in pairs:",
          "    (found[b] - found[a]).total_seconds()",
        ].join("\n"),
      )

      const classMethodUpdateEvents = await analyze(
        [
          "from datetime import datetime",
          "patterns = {'start': '2024-01-02T03:04:05+00:00', 'end': '2024-01-02T03:05:05+00:00'}",
          "found = {}",
          "for key, raw in patterns.items():",
          "    found[key] = datetime.fromisoformat(raw)",
          "dict.update((found), {'end': other})",
          "dict_set = dict.__setitem__",
          "dict_set((found), 'end', other)",
          "for k in patterns:",
          "    found[k].isoformat()",
          "pairs = [('start', 'end')]",
          "for a, b in pairs:",
          "    (found[b] - found[a]).total_seconds()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "found.isoformat" },
          { kind: "pure", call: "ts.isoformat" },
          { kind: "pure", call: "gap.total_seconds" },
          { kind: "pure", call: "round" },
          { kind: "pure", call: "total_seconds" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:found.isoformat" },
          { kind: "unknown", call: "callable:ts.isoformat" },
          { kind: "unknown", call: "callable:gap.total_seconds" },
          { kind: "unknown", call: "callable:total_seconds" },
        ]),
      )

      expect(mutatedEvents).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:found.isoformat" },
          { kind: "unknown", call: "callable:gap.total_seconds" },
          { kind: "unknown", call: "callable:total_seconds" },
        ]),
      )
      expect(mutatedEvents).not.toEqual(
        expect.arrayContaining([{ kind: "pure", call: "found.isoformat" }, { kind: "pure", call: "gap.total_seconds" }, { kind: "pure", call: "total_seconds" }]),
      )

      expect(boundUpdateEvents).toEqual(
        expect.arrayContaining([{ kind: "unknown", call: "callable:found.isoformat" }, { kind: "unknown", call: "callable:total_seconds" }]),
      )
      expect(boundUpdateEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "found.isoformat" }, { kind: "pure", call: "total_seconds" }]))

      expect(setitemUpdateEvents).toEqual(
        expect.arrayContaining([{ kind: "unknown", call: "callable:found.isoformat" }, { kind: "unknown", call: "callable:total_seconds" }]),
      )
      expect(setitemUpdateEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "found.isoformat" }, { kind: "pure", call: "total_seconds" }]))

      expect(wrappedSetitemUpdateEvents).toEqual(
        expect.arrayContaining([{ kind: "unknown", call: "callable:found.isoformat" }, { kind: "unknown", call: "callable:total_seconds" }]),
      )
      expect(wrappedSetitemUpdateEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "found.isoformat" }, { kind: "pure", call: "total_seconds" }]))

      expect(wrappedUpdateEvents).toEqual(
        expect.arrayContaining([{ kind: "unknown", call: "callable:found.isoformat" }, { kind: "unknown", call: "callable:total_seconds" }]),
      )
      expect(wrappedUpdateEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "found.isoformat" }, { kind: "pure", call: "total_seconds" }]))

      expect(classMethodUpdateEvents).toEqual(
        expect.arrayContaining([{ kind: "unknown", call: "callable:found.isoformat" }, { kind: "unknown", call: "callable:total_seconds" }]),
      )
      expect(classMethodUpdateEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "found.isoformat" }, { kind: "pure", call: "total_seconds" }]))
    })

    it("tracks helper-backed datetime tuple slots through list comprehensions with enumerate indexes", async () => {
      const events = await analyze(
        [
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
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "pure", call: "ts.isoformat" }, { kind: "pure", call: "a.isoformat" }]))
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:ts.isoformat" }, { kind: "unknown", call: "callable:a.isoformat" }]))
    })

    it("tracks nested tuple subscript datetime differences in homogeneous tuple lists", async () => {
      const events = await analyze(
        [
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
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "pure", call: "total_seconds" }, { kind: "pure", call: "round" }]))
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:total_seconds" }]))
    })

    it("classifies typed helper-backed exact-key datetime reads and helper-key total_seconds from matched timestamps", async () => {
      const events = await analyze(
        [
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
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "pure", call: "body.split" }, { kind: "pure", call: "found.isoformat" }, { kind: "pure", call: "total_seconds" }]))
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:body.split" }, { kind: "unknown", call: "callable:found.isoformat" }, { kind: "unknown", call: "callable:total_seconds" }]))
    })

    it("keeps exact-key datetime guards conservative when the guard does not reference the key variable", async () => {
      const events = await analyze(
        [
          "from datetime import datetime",
          "patterns = {'start': 1, 'skip': 2}",
          "found = {'start': datetime.fromisoformat('2024-01-02T03:04:05+00:00'), 'skip': other}",
          "task = 'start'",
          "for k in patterns:",
          "    found[k].isoformat() if task.startswith('s') else ''",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:found.isoformat" }]))
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "found.isoformat" }]))
    })

    it("keeps exact-key datetime startswith guards conservative after guard-source rebinding", async () => {
      const events = await analyze(
        [
          "from datetime import datetime",
          "found = {'start': datetime.fromisoformat('2024-01-02T03:04:05+00:00'), 'skip': other}",
          "prefix = ''",
          "for key in found:",
          "    if key.startswith(prefix):",
          "        prefix = 's'",
          "        found[key].isoformat()",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:found.isoformat" }]))
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "found.isoformat" }]))
    })

    it("keeps exact-key datetime startswith guards conservative after guarded-name rebinding", async () => {
      const events = await analyze(
        [
          "from datetime import datetime",
          "found = {'start': datetime.fromisoformat('2024-01-02T03:04:05+00:00'), 'skip': other}",
          "for key in found:",
          "    if key.startswith('s'):",
          "        key = 'skip'",
          "        found[key].isoformat()",
        ].join("\n"),
      )

      expect(events).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:found.isoformat" }]))
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "found.isoformat" }]))
    })

    it("keeps exact-key datetime startswith guards conservative after guarded rebind entries", async () => {
      const sourceRebindEvents = await analyze(
        [
          "from datetime import datetime",
          "found = {'start': datetime.fromisoformat('2024-01-02T03:04:05+00:00'), 'skip': other}",
          "prefix = ''",
          "for key in found:",
          "    if key.startswith(prefix):",
          "        for prefix in ['s']:",
          "            found[key].isoformat()",
        ].join("\n"),
      )

      const receiverRebindEvents = await analyze(
        [
          "from datetime import datetime",
          "found = {'start': datetime.fromisoformat('2024-01-02T03:04:05+00:00'), 'skip': other}",
          "for key in found:",
          "    if key.startswith('s'):",
          "        for key in ['skip']:",
          "            found[key].isoformat()",
        ].join("\n"),
      )

      for (const events of [sourceRebindEvents, receiverRebindEvents]) {
        expect(events).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:found.isoformat" }]))
        expect(events).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "found.isoformat" }]))
      }
    })

    it("does not materialize startswith snapshots late from dynamic branch-entry values", async () => {
      const dynamicPrefixEvents = await analyze(
        [
          "from datetime import datetime",
          "found = {'start': datetime.fromisoformat('2024-01-02T03:04:05+00:00'), 'skip': other}",
          "prefix = dynamic",
          "for key in found:",
          "    if key.startswith(prefix):",
          "        for prefix in ['st']:",
          "            found[key].isoformat()",
        ].join("\n"),
      )

      const dynamicReceiverEvents = await analyze(
        [
          "from datetime import datetime",
          "found = {'skip': datetime.fromisoformat('2024-01-02T03:04:05+00:00'), 'stop': other}",
          "key = dynamic",
          "if key.startswith('sk'):",
          "    for key in ['skip', 'stop']:",
          "        found[key].isoformat()",
        ].join("\n"),
      )

      for (const events of [dynamicPrefixEvents, dynamicReceiverEvents]) {
        expect(events).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:found.isoformat" }]))
        expect(events).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "found.isoformat" }]))
      }
    })

  })

  describe("time and zoneinfo classification", () => {
    it("classifies time and zoneinfo module calls", async () => {
      const events = await analyze(
        [
          "import time",
          "import zoneinfo",
          "time.time()",
          "time.clock_gettime(time.CLOCK_REALTIME)",
          "time.gmtime(0)",
          "time.strftime('%Y', time.gmtime(0))",
          "time.strptime('30 Nov 00', '%d %b %y')",
          "time.sleep(0)",
          "time.clock_settime(time.CLOCK_REALTIME, 0.0)",
          "time.tzset()",
          "zoneinfo.available_timezones()",
          "zoneinfo.ZoneInfo('UTC')",
          "zoneinfo.ZoneInfo.no_cache('UTC')",
          "zoneinfo.reset_tzpath(['/usr/share/zoneinfo'])",
          "zoneinfo.ZoneInfo.clear_cache()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "time.time" },
          { kind: "read", call: "time.clock_gettime" },
          { kind: "read", call: "time.gmtime" },
          { kind: "read", call: "time.strftime" },
          { kind: "pure", call: "time.strptime" },
          { kind: "pure", call: "time.sleep" },
          { kind: "write", call: "time.clock_settime" },
          { kind: "write", call: "time.tzset" },
          { kind: "read", call: "zoneinfo.available_timezones" },
          { kind: "read", call: "zoneinfo.ZoneInfo" },
          { kind: "read", call: "zoneinfo.ZoneInfo.no_cache" },
          { kind: "write", call: "zoneinfo.reset_tzpath" },
          { kind: "write", call: "zoneinfo.ZoneInfo.clear_cache" },
        ]),
      )
    })

    it("classifies direct-imported time and ZoneInfo chains", async () => {
      const events = await analyze(
        [
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
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "read", call: "time.time" },
          { kind: "pure", call: "stamp.is_integer" },
          { kind: "pure", call: "time.strptime" },
          { kind: "pure", call: "parts.count" },
          { kind: "read", call: "zoneinfo.ZoneInfo" },
          { kind: "pure", call: "zone.tzname" },
          { kind: "pure", call: "zone.utcoffset" },
          { kind: "pure", call: "offset.total_seconds" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:stamp.is_integer" },
          { kind: "unknown", call: "callable:parts.count" },
          { kind: "unknown", call: "callable:zone.tzname" },
          { kind: "unknown", call: "callable:zone.utcoffset" },
          { kind: "unknown", call: "callable:offset.total_seconds" },
        ]),
      )
    })
  })

  describe("calendar and os.path classification", () => {
    it("classifies calendar module helpers and broader os.path calls", async () => {
      const events = await analyze(
        [
          "import calendar",
          "import os.path as osp",
          "calendar.isleap(2024)",
          "calendar.monthrange(2024, 1)",
          "calendar.month(2024, 1)",
          "calendar.prmonth(2024, 1)",
          "calendar.firstweekday()",
          "calendar.setfirstweekday(calendar.SUNDAY)",
          "osp.exists('notes.txt')",
          "osp.getsize('notes.txt')",
          "osp.realpath('notes.txt')",
          "osp.basename('docs/readme.md')",
          "osp.splitext('docs/readme.md')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "calendar.isleap" },
          { kind: "pure", call: "calendar.monthrange" },
          { kind: "pure", call: "calendar.month" },
          { kind: "emit", call: "calendar.prmonth" },
          { kind: "read", call: "calendar.firstweekday" },
          { kind: "write", call: "calendar.setfirstweekday" },
          { kind: "read", call: "os.path.exists", path: "notes.txt" },
          { kind: "read", call: "os.path.getsize", path: "notes.txt" },
          { kind: "read", call: "os.path.realpath", path: "notes.txt" },
          { kind: "pure", call: "os.path.basename" },
          { kind: "pure", call: "os.path.splitext" },
        ]),
      )
    })

    it("classifies direct-imported calendar and os.path chains", async () => {
      const events = await analyze(
        [
          "from calendar import month, monthcalendar, timegm",
          "from os.path import basename, splitext",
          "text = month(2024, 1)",
          "text.splitlines()",
          "weeks = monthcalendar(2024, 1)",
          "weeks.count([])",
          "stamp = timegm((2024, 1, 2, 0, 0, 0, 0, 0, 0))",
          "stamp.bit_length()",
          "name = basename('docs/readme.md')",
          "name.lower()",
          "parts = splitext('docs/readme.md')",
          "parts.count('')",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "calendar.month" },
          { kind: "pure", call: "text.splitlines" },
          { kind: "pure", call: "calendar.monthcalendar" },
          { kind: "pure", call: "weeks.count" },
          { kind: "pure", call: "calendar.timegm" },
          { kind: "pure", call: "stamp.bit_length" },
          { kind: "pure", call: "os.path.basename" },
          { kind: "pure", call: "name.lower" },
          { kind: "pure", call: "os.path.splitext" },
          { kind: "pure", call: "parts.count" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:text.splitlines" },
          { kind: "unknown", call: "callable:weeks.count" },
          { kind: "unknown", call: "callable:stamp.bit_length" },
          { kind: "unknown", call: "callable:name.lower" },
          { kind: "unknown", call: "callable:parts.count" },
        ]),
      )
    })
  })

  describe("collections.Counter classification", () => {
    it("classifies Counter constructors and tracked Counter methods as pure", async () => {
      const events = await analyze(
        [
          "import collections",
          "counts = collections.Counter('abracadabra')",
          "counts.most_common(3)",
          "counts.most_common().count(('a', 5))",
          "counts.total()",
          "counts.total().bit_length()",
          "counts.update('bbb')",
          "counts.subtract('a')",
          "counts.keys()",
          "counts.copy().most_common()",
          "counts.elements()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "collections.Counter" },
          { kind: "pure", call: "counts.most_common" },
          { kind: "pure", call: "counts.most_common.count" },
          { kind: "pure", call: "counts.total" },
          { kind: "pure", call: "counts.total.bit_length" },
          { kind: "pure", call: "counts.update" },
          { kind: "pure", call: "counts.subtract" },
          { kind: "pure", call: "counts.keys" },
          { kind: "pure", call: "counts.copy" },
          { kind: "pure", call: "counts.copy.most_common" },
          { kind: "pure", call: "counts.elements" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:counts.most_common" },
          { kind: "unknown", call: "callable:counts.total" },
          { kind: "unknown", call: "callable:counts.copy.most_common" },
        ]),
      )
    })

    it("classifies direct-imported Counter and keeps shadowed names conservative", async () => {
      const directImportEvents = await analyze(
        [
          "from collections import Counter",
          "Counter('aba').most_common()",
          "from collections import Counter as Tally",
          "Tally('aba').total()",
        ].join("\n"),
      )

      const shadowedEvents = await analyze(
        [
          "from collections import Counter",
          "def Counter(value):",
          "    return value",
          "Counter('aba')",
        ].join("\n"),
      )

      const unrelatedReceiverEvents = await analyze(
        [
          "class Bucket:",
          "    def most_common(self):",
          "        return []",
          "bucket = Bucket()",
          "bucket.most_common()",
        ].join("\n"),
      )

      expect(directImportEvents).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "collections.Counter" },
          { kind: "pure", call: "collections.Counter.most_common" },
          { kind: "pure", call: "collections.Counter.total" },
        ]),
      )
      expect(shadowedEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:Counter" }]))
      expect(shadowedEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "collections.Counter" }]))
      expect(unrelatedReceiverEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:bucket.most_common" }]))
    })

    it("keeps module-root and aliased Counter calls conservative after rebinding", async () => {
      const reboundEvents = await analyze(
        [
          "import collections",
          "collections = object()",
          "collections.Counter('aba')",
          "collections.Counter('aba').most_common()",
        ].join("\n"),
      )

      const aliasEvents = await analyze(
        [
          "import collections",
          "collections = object()",
          "alias = collections",
          "alias.Counter('aba').most_common()",
        ].join("\n"),
      )

      const trackedCounterEvents = await analyze(
        [
          "import collections",
          "counts = collections.Counter('aba')",
          "collections = object()",
          "counts.most_common()",
        ].join("\n"),
      )

      expect(reboundEvents).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:collections.Counter" },
          { kind: "unknown", call: "callable:collections.Counter.most_common" },
        ]),
      )
      expect(aliasEvents).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:collections.Counter" },
          { kind: "unknown", call: "callable:collections.Counter.most_common" },
        ]),
      )
      expect(trackedCounterEvents).toEqual(expect.arrayContaining([{ kind: "pure", call: "counts.most_common" }]))
    })
  })

  describe("hashlib classification", () => {
    it("classifies hashlib.sha1/sha256 constructors and tracked digest helpers as pure", async () => {
      const events = await analyze(
        [
          "import hashlib",
          "hashlib.sha1(b'w')",
          "hashlib.sha1(b'w').hexdigest()",
          "hashlib.sha256(b'x')",
          "hashlib.sha256(b'x').hexdigest()",
          "digest = hashlib.sha256(b'y')",
          "digest.digest()",
          "digest.digest().hex()",
          "digest.copy().hexdigest()",
          "digest.hexdigest().lower()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "hashlib.sha1" },
          { kind: "pure", call: "hashlib.sha1.hexdigest" },
          { kind: "pure", call: "hashlib.sha256" },
          { kind: "pure", call: "hashlib.sha256.hexdigest" },
          { kind: "pure", call: "digest.digest" },
          { kind: "pure", call: "digest.digest.hex" },
          { kind: "pure", call: "digest.copy" },
          { kind: "pure", call: "digest.copy.hexdigest" },
          { kind: "pure", call: "digest.hexdigest.lower" },
        ]),
      )
      expect(events).not.toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:digest.digest" },
          { kind: "unknown", call: "callable:digest.copy" },
          { kind: "unknown", call: "callable:digest.copy.hexdigest" },
        ]),
      )
    })

    it("classifies direct-imported hashlib.sha1/sha256 and keeps shadowed names conservative", async () => {
      const directImportEvents = await analyze(
        [
          "from hashlib import sha1",
          "sha1(b'w').hexdigest()",
          "from hashlib import sha256",
          "sha256(b'x')",
          "sha256(b'x').hexdigest()",
          "from hashlib import sha256 as make_digest",
          "make_digest(b'y').digest()",
        ].join("\n"),
      )

      const shadowedEvents = await analyze(
        [
          "from hashlib import sha256",
          "def sha256(value):",
          "    return value",
          "sha256(b'x')",
        ].join("\n"),
      )

      const unrelatedReceiverEvents = await analyze(
        [
          "class Token:",
          "    def hexdigest(self):",
          "        return 'x'",
          "token = Token()",
          "token.hexdigest()",
        ].join("\n"),
      )

      expect(directImportEvents).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "hashlib.sha1.hexdigest" },
          { kind: "pure", call: "hashlib.sha256" },
          { kind: "pure", call: "hashlib.sha256.hexdigest" },
          { kind: "pure", call: "hashlib.sha256.digest" },
        ]),
      )
      expect(shadowedEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:sha256" }]))
      expect(shadowedEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "hashlib.sha256" }]))
      expect(unrelatedReceiverEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:token.hexdigest" }]))

      const otherHashEvents = await analyze(["from hashlib import md5", "md5(b'x')"].join("\n"))
      expect(otherHashEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:md5" }]))
    })

    it("keeps module-root hashlib calls conservative when hashlib is rebound but preserves existing tracked digests", async () => {
      const reboundEvents = await analyze(
        [
          "import hashlib",
          "hashlib = object()",
          "hashlib.sha256(b'x')",
          "hashlib.sha256(b'x').hexdigest()",
        ].join("\n"),
      )

      const trackedDigestEvents = await analyze(
        [
          "import hashlib",
          "digest = hashlib.sha256(b'x')",
          "hashlib = object()",
          "digest.hexdigest()",
        ].join("\n"),
      )

      expect(reboundEvents).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:hashlib.sha256" },
          { kind: "unknown", call: "callable:hashlib.sha256.hexdigest" },
        ]),
      )
      expect(reboundEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "hashlib.sha256" }]))
      expect(trackedDigestEvents).toEqual(expect.arrayContaining([{ kind: "pure", call: "digest.hexdigest" }]))
    })

    it("keeps hashlib.sha1 conservative after member mutation", async () => {
      const assignedEvents = await analyze(
        [
          "import hashlib",
          "hashlib.sha1 = custom",
          "hashlib.sha1(b'x').hexdigest()",
        ].join("\n"),
      )

      const setattrEvents = await analyze(
        [
          "import hashlib",
          "setattr(hashlib, 'sha1', custom)",
          "hashlib.sha1(b'x').hexdigest()",
        ].join("\n"),
      )

      for (const events of [assignedEvents, setattrEvents]) {
        expect(events).toEqual(
          expect.arrayContaining([
            { kind: "unknown", call: "callable:hashlib.sha1" },
            { kind: "unknown", call: "callable:hashlib.sha1.hexdigest" },
          ]),
        )
        expect(events).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "hashlib.sha1" }, { kind: "pure", call: "hashlib.sha1.hexdigest" }]))
      }
    })

    it("keeps aliased hashlib module calls conservative after root rebinding", async () => {
      const events = await analyze(
        [
          "import hashlib",
          "hashlib = object()",
          "alias = hashlib",
          "alias.sha256(b'x').hexdigest()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "unknown", call: "callable:hashlib.sha256" },
          { kind: "unknown", call: "callable:hashlib.sha256.hexdigest" },
        ]),
      )
      expect(events).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "hashlib.sha256" }]))
    })
  })

  describe("zlib decompression and decode-chain classification", () => {
    it("classifies zlib.decompress and tracked bytes/string helpers as pure", async () => {
      const events = await analyze(
        [
          "import zlib",
          "raw = zlib.decompress(blob)",
          "raw.split(b'\\x00', 1)",
          "raw.count(b'x')",
          "raw.decode('utf8')",
          "raw.decode('utf8').splitlines()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "zlib.decompress" },
          { kind: "pure", call: "raw.split" },
          { kind: "pure", call: "raw.count" },
          { kind: "pure", call: "raw.decode" },
          { kind: "pure", call: "raw.decode.splitlines" },
        ]),
      )
    })

    it("classifies direct-imported zlib.decompress and keeps shadowed names conservative", async () => {
      const directImportEvents = await analyze(
        [
          "from zlib import decompress",
          "decompress(blob)",
          "payload = decompress(blob)",
          "payload.decode('utf8').endswith('x')",
        ].join("\n"),
      )

      const shadowedEvents = await analyze(
        [
          "from zlib import decompress",
          "def decompress(value):",
          "    return value",
          "decompress(blob)",
        ].join("\n"),
      )

      expect(directImportEvents).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "zlib.decompress" },
          { kind: "pure", call: "payload.decode" },
          { kind: "pure", call: "payload.decode.endswith" },
        ]),
      )
      expect(shadowedEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:decompress" }]))
      expect(shadowedEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "zlib.decompress" }]))
    })

    it("keeps module-root zlib.decompress conservative when zlib is rebound but preserves tracked bytes", async () => {
      const reboundEvents = await analyze(
        [
          "import zlib",
          "zlib = object()",
          "zlib.decompress(blob)",
        ].join("\n"),
      )

      const trackedBytesEvents = await analyze(
        [
          "import zlib",
          "raw = zlib.decompress(blob)",
          "zlib = object()",
          "raw.decode('utf8').splitlines()",
        ].join("\n"),
      )

      expect(reboundEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:zlib.decompress" }]))
      expect(reboundEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "zlib.decompress" }]))
      expect(trackedBytesEvents).toEqual(expect.arrayContaining([{ kind: "pure", call: "raw.decode" }, { kind: "pure", call: "raw.decode.splitlines" }]))
    })

    it("tracks bytes slices and split elements from zlib.decompress outputs into decode chains", async () => {
      const events = await analyze(
        [
          "import zlib",
          "data = zlib.decompress(blob)",
          "nul = data.index(b'\\x00')",
          "header = data[:nul].decode()",
          "header.split(' ')",
          "body = data.split(b'\\x00', 1)[1]",
          "body.decode().splitlines()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "data.index" },
          { kind: "pure", call: "data.decode" },
          { kind: "pure", call: "header.split" },
          { kind: "pure", call: "data.split" },
          { kind: "pure", call: "body.decode" },
          { kind: "pure", call: "body.decode.splitlines" },
        ]),
      )
    })

  })

  describe("zlib decompression import and rebinding regressions", () => {
    it("classifies zlib.decompress and tracked bytes helpers as pure", async () => {
      const events = await analyze(
        [
          "import zlib",
          "raw = zlib.decompress(blob)",
          "raw.split(b'\\x00', 1)",
          "raw.count(b'x')",
          "raw.decode('utf8')",
          "raw.decode('utf8').splitlines()",
        ].join("\n"),
      )

      expect(events).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "zlib.decompress" },
          { kind: "pure", call: "raw.split" },
          { kind: "pure", call: "raw.count" },
          { kind: "pure", call: "raw.decode" },
          { kind: "pure", call: "raw.decode.splitlines" },
        ]),
      )
    })

    it("classifies direct-imported zlib.decompress and keeps shadowed names conservative", async () => {
      const directImportEvents = await analyze(
        [
          "from zlib import decompress",
          "decompress(blob)",
          "payload = decompress(blob)",
          "payload.decode('utf8').endswith('x')",
        ].join("\n"),
      )

      const shadowedEvents = await analyze(
        [
          "from zlib import decompress",
          "def decompress(value):",
          "    return value",
          "decompress(blob)",
        ].join("\n"),
      )

      expect(directImportEvents).toEqual(
        expect.arrayContaining([
          { kind: "pure", call: "zlib.decompress" },
          { kind: "pure", call: "payload.decode" },
          { kind: "pure", call: "payload.decode.endswith" },
        ]),
      )
      expect(shadowedEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:decompress" }]))
      expect(shadowedEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "zlib.decompress" }]))
    })

    it("keeps module-root zlib.decompress conservative when zlib is rebound but preserves tracked bytes", async () => {
      const reboundEvents = await analyze(
        [
          "import zlib",
          "zlib = object()",
          "zlib.decompress(blob)",
        ].join("\n"),
      )

      const trackedBytesEvents = await analyze(
        [
          "import zlib",
          "raw = zlib.decompress(blob)",
          "zlib = object()",
          "raw.decode('utf8').splitlines()",
        ].join("\n"),
      )

      expect(reboundEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:zlib.decompress" }]))
      expect(reboundEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "zlib.decompress" }]))
      expect(trackedBytesEvents).toEqual(expect.arrayContaining([{ kind: "pure", call: "raw.decode" }, { kind: "pure", call: "raw.decode.splitlines" }]))
    })
  })

  describe("difflib classification", () => {
    it("classifies module-qualified and direct-imported difflib.unified_diff as pure", async () => {
      const moduleEvents = await analyze(
        [
          "import difflib",
          "for line in difflib.unified_diff(before, after, fromfile='HEAD', tofile='WORKTREE', n=3):",
          "    print(line)",
        ].join("\n"),
      )

      const directImportEvents = await analyze(
        [
          "from difflib import unified_diff",
          "for line in unified_diff(before, after):",
          "    print(line)",
        ].join("\n"),
      )

      expect(moduleEvents).toEqual(expect.arrayContaining([{ kind: "pure", call: "difflib.unified_diff" }, { kind: "emit", call: "print" }]))
      expect(moduleEvents).not.toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:difflib.unified_diff" }]))
      expect(directImportEvents).toEqual(expect.arrayContaining([{ kind: "pure", call: "difflib.unified_diff" }, { kind: "emit", call: "print" }]))
      expect(directImportEvents).not.toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:unified_diff" }]))
    })

    it("keeps aliased and rebound difflib.unified_diff forms conservative", async () => {
      const reboundEvents = await analyze(
        [
          "import difflib",
          "difflib = object()",
          "difflib.unified_diff(before, after)",
        ].join("\n"),
      )

      const aliasedImportEvents = await analyze(
        [
          "import difflib as df",
          "df.unified_diff(before, after)",
        ].join("\n"),
      )

      const aliasedLeafEvents = await analyze(
        [
          "from difflib import unified_diff as diff_lines",
          "diff_lines(before, after)",
        ].join("\n"),
      )

      const capturedCallableEvents = await analyze(
        [
          "import difflib",
          "fn = difflib.unified_diff",
          "fn(before, after)",
        ].join("\n"),
      )

      const assignedMemberEvents = await analyze(
        [
          "import difflib",
          "difflib.unified_diff = custom",
          "difflib.unified_diff(before, after)",
        ].join("\n"),
      )

      const setattrMemberEvents = await analyze(
        [
          "import difflib",
          "setattr(difflib, 'unified_diff', custom)",
          "difflib.unified_diff(before, after)",
        ].join("\n"),
      )

      const aliasAssignedMemberEvents = await analyze(
        [
          "import difflib",
          "alias = difflib",
          "alias.unified_diff = custom",
          "difflib.unified_diff(before, after)",
        ].join("\n"),
      )

      const aliasSetattrMemberEvents = await analyze(
        [
          "import difflib",
          "alias = difflib",
          "setattr(alias, 'unified_diff', custom)",
          "difflib.unified_diff(before, after)",
        ].join("\n"),
      )

      expect(reboundEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:difflib.unified_diff" }]))
      expect(reboundEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "difflib.unified_diff" }]))
      expect(aliasedImportEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:difflib.unified_diff" }]))
      expect(aliasedImportEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "difflib.unified_diff" }]))
      expect(aliasedLeafEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:difflib.unified_diff" }]))
      expect(aliasedLeafEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "difflib.unified_diff" }]))
      expect(capturedCallableEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:difflib.unified_diff" }]))
      expect(capturedCallableEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "difflib.unified_diff" }]))
      expect(assignedMemberEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:difflib.unified_diff" }]))
      expect(assignedMemberEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "difflib.unified_diff" }]))
      expect(setattrMemberEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:difflib.unified_diff" }]))
      expect(setattrMemberEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "difflib.unified_diff" }]))
      expect(aliasAssignedMemberEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:difflib.unified_diff" }]))
      expect(aliasAssignedMemberEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "difflib.unified_diff" }]))
      expect(aliasSetattrMemberEvents).toEqual(expect.arrayContaining([{ kind: "unknown", call: "callable:difflib.unified_diff" }]))
      expect(aliasSetattrMemberEvents).not.toEqual(expect.arrayContaining([{ kind: "pure", call: "difflib.unified_diff" }]))
    })
  })

})
