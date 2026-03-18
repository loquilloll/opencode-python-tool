---
title: Python Classification Reference
tags:
  - type/reference
  - status/draft
  - project/opencode-python-tool
  - topic/python-analyzer
  - topic/permissions
---

# Python Classification Reference

This document contains the detailed rule-oriented classifier reference that used to live in `README.md`.

For the high-level architecture and provenance model, see `docs/python-classification-system-design.md`.

## Analyzer Classification Reference

The static analyzer (`python-analyze.ts`) uses Tree-sitter to parse Python
source and classify every function call into one of six event kinds.

Before rule matching, the analyzer now normalizes explicit import aliases and
simple same-scope local rebindings to a canonical callable name. This remains a
bounded lexical pass: assignment-family rebinding is handled, and common
non-assignment rebinding forms such as `for` / `async for`, `with` / `async with`,
and `except` targets now invalidate prior alias tracking before later calls are
classified.

### Event kinds

| Kind | Meaning | Permission prefix |
|------|---------|-------------------|
| `read` | External data read operation | `read:` |
| `write` | External state mutation | `write:` |
| `emit` | Outward reporting/signaling (stdout/logging/metrics) without durable state mutation | `emit:` |
| `exec` | Process spawn, dynamic execution, ambiguous network/database control, or dangerous API call | `exec:` |
| `pure` | In-memory-only computation with no external interaction | `pure:` |
| `unknown` | Unrecognized, dynamic, or parse-error call | `unknown:` |

Runtime ask policy:

- `read`, `write`, `exec`, and `unknown` participate in `python` permission asks.
- `emit` is analyzer/report visible and included in runtime operation metadata, but non-blocking by default.
- `pure` is analyzer-visible and review-optional, but excluded from permission asks by default.

### Classification tables

#### File I/O

| Call pattern | Kind | Path extraction |
|-------------|------|-----------------|
| `open(path, 'r')` | read | Literal or dynamic path from 1st arg |
| `open(path, 'w'/'a'/'x'/'r+')` | write | Literal or dynamic path from 1st arg |
| `open(path, <dynamic_mode>)` | unknown | `open-mode-dynamic` |
| `Path(p).exists()`, `.glob()`, `.group()`, `.is_*()`, `.iterdir()`, `.lstat()`, `.owner()`, `.read_*()`, `.readlink()`, `.resolve()`, `.rglob()`, `.samefile()`, `.stat()`, `.walk()` | read | From the receiver Path |
| `Path(p).open()` / `.open('r'/'rb')` | read | From the receiver Path |
| `Path(p).open('w'/'a'/'x'/'r+')` | write | From the receiver Path |
| `Path(p).open(<dynamic_mode>)` | unknown | `open-mode-dynamic` |
| `Path(p).chmod()`, `.copy*()`, `.hardlink_to()`, `.lchmod()`, `.mkdir()`, `.move*()`, `.rename()`, `.replace()`, `.rmdir()`, `.symlink_to()`, `.touch()`, `.unlink()`, `.write_*()` | write | From the receiver Path |
| `os.path.exists(path)`, `lexists(path)`, `isdir(path)`, `isfile(path)`, `islink(path)`, `isjunction(path)`, `ismount(path)`, `isdevdrive(path)`, `getsize(path)`, `getatime(path)`, `getctime(path)`, `getmtime(path)`, `realpath(path)`, `samefile(path1, path2)` | read | 1st positional or `path`/`path1` keyword |

#### OS / shutil writes

| Call | Kind | Path source |
|------|------|-------------|
| `os.remove(path)`, `os.unlink(path)` | write | 1st positional or `path` keyword |
| `os.makedirs(name)` | write | 1st positional or `name`/`path` keyword |
| `os.rename(src, dst)`, `os.replace(src, dst)` | write | 2nd positional or `dst` keyword |
| `shutil.copy(src, dst)`, `.copy2()`, `.copytree()`, `.move()` | write | 2nd positional or `dst` keyword |
| `shutil.rmtree(path)` | write | 1st positional or `path` keyword |

#### Serialization I/O

| Call | Kind |
|------|------|
| `json.load`, `yaml.load`, `yaml.safe_load` | read |
| `json.loads` | pure |
| `json.loads(..., cls/hooks/**kwargs)` | unknown |
| `<tracked-http-response>.json()` | pure when called with no args/kwargs |
| `<tracked-http-response>.json(..., args/kwargs)` | unknown |
| `json.dump`, `yaml.dump`, `yaml.safe_dump` | write |

#### Emit and pure defaults

| Call | Kind |
|------|------|
| `Path`, `Path.cwd()`, `Path.home()`, `Path.from_uri()` | pure |
| Tracked-Path helpers such as `.absolute()`, `.as_posix()`, `.as_uri()`, `.expanduser()`, `.full_match()`, `.is_absolute()`, `.is_relative_to()`, `.is_reserved()`, `.joinpath()`, `.match()`, `.relative_to()`, `.with_name()`, `.with_segments()`, `.with_stem()`, `.with_suffix()` | pure |
| `dict.fromkeys` | pure (when `dict` is not shadowed locally) |
| most builtin constructors/helpers from the Python builtins page such as `abs`, `aiter`, `all`, `anext`, `any`, `ascii`, `bin`, `bool`, `bytearray`, `bytes`, `callable`, `chr`, `classmethod`, `complex`, `delattr`, `dict`, `dir`, `divmod`, `enumerate`, `filter`, `float`, `format`, `frozenset`, `getattr`, `globals`, `hasattr`, `hash`, `hex`, `id`, `int`, `isinstance`, `issubclass`, `iter`, `len`, `list`, `locals`, `map`, `memoryview`, `next`, `object`, `oct`, `ord`, `pow`, `property`, `range`, `repr`, `reversed`, `round`, `set`, `setattr`, `slice`, `staticmethod`, `str`, `sum`, `super`, `tuple`, `vars`, `zip` | pure when the builtin name is not shadowed locally |
| `max`, `min`, `sorted` | pure when the builtin name is not shadowed locally and no `key=` / `**kwargs` is passed |
| `type(obj)` | pure when unshadowed and called with exactly one positional argument |
| standard builtin exception constructors such as `ValueError`, `TypeError`, `RuntimeError`, and `AssertionError` | pure when the exception name is not shadowed locally; bare `raise <builtin-exception>` uses the same bounded rule |
| `input` | read when unshadowed |
| `help` | emit when unshadowed |
| `breakpoint`, `compile`, `eval`, `exec`, `__import__` | exec when unshadowed |
| `print`, `logging.debug/info/warning/error/critical/exception/log`, `warnings.warn` | emit when the callable name is not shadowed locally |
| `re.compile`, `re.search`, `re.match`, `re.fullmatch`, `re.findall`, `re.finditer`, `re.split`, `re.escape` | pure |
| `ast.parse`, `ast.dump`, `ast.unparse`, `ast.literal_eval`, `ast.walk`, `ast.iter_fields`, `ast.iter_child_nodes`, `ast.get_docstring`, `ast.get_source_segment`, `ast.copy_location`, `ast.fix_missing_locations`, `ast.increment_lineno` | pure |
| `unittest.mock.Mock`, `MagicMock`, `AsyncMock`, `PropertyMock`, `NonCallableMock`, `NonCallableMagicMock`, `create_autospec`, `patch`, `patch.object`, `patch.dict`, `patch.multiple` | pure |
| `inspect.is*`, `inspect.unwrap`, `inspect.getfullargspec`, `inspect.getcallargs`, `inspect.getclosurevars`, `inspect.getmro`, `inspect.getdoc`, `inspect.Signature`, `inspect.Parameter`, `inspect.BoundArguments`, and similar metadata-only helpers | pure |
| `inspect.signature(...)`, `inspect.get_annotations(...)`, `inspect.Signature.from_callable(...)` | pure when `globals=`, `locals=`, `eval_str=`, and `**kwargs` are absent |
| `inspect.getsource`, `inspect.getsourcelines`, `inspect.getcomments`, `inspect.getfile`, `inspect.getsourcefile`, `inspect.currentframe`, `inspect.stack`, and similar source/frame walkers | read |
| tracked inspect receiver methods such as `sig.bind()`, `sig.bind_partial()`, `sig.replace()`, `sig.format()`, `param.replace()`, and `bound.apply_defaults()` | pure |
| tracked `Mock` / `AsyncMock` assertion and reset/configuration helpers such as `.assert_called_once_with()`, `.assert_not_called()`, `.reset_mock()`, `.configure_mock()`, `.mock_add_spec()`, and async assert helpers like `.assert_not_awaited()` | pure |
| `datetime.date()`, `datetime.datetime()`, `datetime.time()`, `datetime.timedelta()`, `datetime.timezone()`, `datetime.tzinfo()`, and parser/conversion helpers such as `.fromtimestamp()`, `.fromordinal()`, `.fromisoformat()`, `.fromisocalendar()`, `.combine()`, and `.strptime()` | pure |
| `datetime.date.today()`, `datetime.datetime.now()`, `datetime.datetime.today()`, `datetime.datetime.utcnow()` | read |
| tracked datetime receiver methods such as `date.isoformat()`, `date.replace()`, `datetime.astimezone()`, `datetime.date()`, `datetime.time()`, `time.isoformat()`, `timedelta.total_seconds()`, and `timezone.tzname()` | pure |
| `calendar.isleap()`, `calendar.leapdays()`, `calendar.weekday()`, `calendar.monthrange()`, `calendar.monthcalendar()`, `calendar.month()`, `calendar.calendar()`, `calendar.weekheader()`, `calendar.timegm()`, and simple calendar constructors like `calendar.Calendar()` / `TextCalendar()` / `HTMLCalendar()` | pure |
| `calendar.firstweekday()` | read |
| `calendar.setfirstweekday()` | write |
| `calendar.prmonth()`, `calendar.prcal()`, `calendar.prweek()` | emit |
| `os.path.abspath()`, `basename()`, `commonpath()`, `commonprefix()`, `dirname()`, `expanduser()`, `expandvars()`, `isabs()`, `join()`, `normcase()`, `normpath()`, `relpath()`, `sameopenfile()`, `samestat()`, `split()`, `splitdrive()`, `splitext()`, `splitroot()` | pure |
| `time.strptime()`, `time.struct_time()`, `time.sleep()` | pure |
| `time.time()`, `time.time_ns()`, `time.monotonic*()`, `time.perf_counter*()`, `time.process_time*()`, `time.thread_time*()`, `time.clock_get*()`, `time.get_clock_info()`, `time.gmtime()`, `time.localtime()`, `time.asctime()`, `time.ctime()`, `time.strftime()`, and `time.pthread_getcpuclockid()` | read |
| `time.clock_settime*()`, `time.tzset()` | write |
| `zoneinfo.ZoneInfo()`, `ZoneInfo.no_cache()`, `ZoneInfo.from_file()`, `zoneinfo.available_timezones()` | read |
| `zoneinfo.reset_tzpath()`, `ZoneInfo.clear_cache()` | write |
| tracked `ZoneInfo` receiver methods such as `.tzname()`, `.utcoffset()`, `.dst()`, and `.fromutc()` | pure |

`re.sub` is intentionally not classified as `pure` by default because callable replacements can hide side effects. Local container provenance also includes direct list/dict/set constructors and comprehensions, so methods like `.append()`, `.add()`, `.values()`, and `.sort()` on tracked locals stay non-blocking as `pure`. The same bounded rule now applies to direct temporary builtin or JSON container receivers such as `list(...).sort()`, `dict(...).get(...)`, `set(...).add(...)`, and plain `json.loads(...).get(...)`, but only when the producing call itself is already safe under the current builtin/JSON guardrails. Direct `json.load(...)` / `json.loads(...)` assignments also seed bounded local JSON-container provenance, and plain zero-arg `.json()` calls only seed the same JSON provenance when the receiver is a tracked HTTP response variable assigned from a known HTTP call, including fallback shapes like `payload = response.json() or {}`. That lets later dict/list-style in-memory methods such as `.setdefault()`, `.update()`, and JSON-derived iteration access stay `pure` unless decoder or parse-hook keywords are present (`cls`, `object_hook`, `object_pairs_hook`, `parse_float`, `parse_int`, `parse_constant`) or the call forwards `**kwargs`, in which case the analyzer stays conservative. The analyzer also now tracks same-scope `self.<attr>` assignments plus exact same-scope receiver paths like `entries[current]`, `entries[current.user]`, `state.stack`, and shallow nested attributes such as `state.inner.stack` or `self.inner.stack` when they are directly seeded from those same bounded container-producing expressions. Rebinding any identifier or supported one-hop attribute dependency used by one of those exact receiver paths clears the stale provenance before later calls are classified. Standard `str` instance methods now classify as `pure` when the receiver is a tracked text value seeded from literals, concatenated literals, or `Path(...).read_text()`, including direct literal calls like `'\n'.join(parts)` plus methods like `join`, `format`, `encode`, `index`, `translate`, `zfill`, and the `is*` predicate family. Bounded loop-variable provenance now also treats `for line in text.splitlines(): line.strip()` and `for _, line in enumerate(lines): line.strip()` as `pure` only when the iterated values come from tracked string `split`, `rsplit`, or `splitlines` results. Tracked string self-reassignment through string-returning methods such as `text = text.replace(...)` also stays `pure`, so later uses of the same local continue to carry bounded string provenance. The same tracked-receiver model now covers other common built-in types as well: tuple/range sequence helpers, bytes/bytearray string-like and in-memory mutator methods, memoryview helpers like `tobytes()` and `hex()`, and numeric methods such as `bit_length()`, `to_bytes()`, `is_integer()`, and `conjugate()`. It also covers common review-noise cases from Path and regex flows: tracked `Path(...)` / `Path.cwd()` aliases can carry read/write methods and `joinpath(...)`, exact `os.path.join(...)` imports stay `pure`, and `re.search` / `re.match` / `re.fullmatch` results expose narrow pure match methods. Bounded iterated Path provenance also keeps loop and comprehension receivers such as `p.exists()` classified as `read` when they come from explicit tracked Path lists or tracked Path iterators like `glob()` / `rglob()` / `iterdir()` methods like `group()`, `groups()`, `groupdict()`, `start()`, `end()`, and `span()`. Builtin-page coverage now applies bounded lexical shadow guards across pure/read/emit/exec builtins, so rebinding names like `open`, `print`, `input`, `help`, `breakpoint`, or `type` keeps them conservative instead of inheriting builtin semantics. Bare `raise`, custom exception classes, and arbitrary expression raises such as `raise err` or `raise make_error()` do not gain blanket purity. Arbitrary receiver methods such as `obj.sort()`, arbitrary `.group()` / `.join()` receivers, nested helper leakage, unseeded receiver paths, deeper attribute-index receivers like `entries[current.user.id]`, deeper nested attributes like `state.inner.deep.stack.pop()`, unsupported string-like sources such as `open(...).read()` or `str(...)`, and dynamic multi-argument `type(...)` remain conservative.

Tracked `bytes` and `bytearray` receivers now also seed bounded `decode(...)` string chaining when the receiver provenance is already known, so patterns like `blob.decode("utf8").replace(...)` or `data.decode("utf8").split(",")` stay `pure` without broadening unknown binary receivers.

#### Tempfile

| Call | Kind |
|------|------|
| `tempfile.NamedTemporaryFile`, `tempfile.mkdtemp`, `tempfile.mkstemp`, `tempfile.TemporaryDirectory` | write |

#### Dangerous builtins and process execution

| Call | Kind |
|------|------|
| `eval`, `exec`, `compile`, `__import__` | exec |
| `os.system`, `os.popen`, `os.exec*` | exec |
| `subprocess.*` (any method) | exec |

#### Dangerous deserialization

| Call | Kind |
|------|------|
| `pickle.load`, `pickle.loads` | exec |
| `marshal.load`, `marshal.loads` | exec |

#### Network / HTTP

| Call | Kind |
|------|------|
| `requests.get`, `requests.head`, `requests.options` | read |
| `requests.post`, `requests.put`, `requests.patch`, `requests.delete` | write |
| `requests.request("GET"/"HEAD"/"OPTIONS", ...)` | read |
| `requests.request("POST"/"PUT"/"PATCH"/"DELETE", ...)` | write |
| `requests.Session` | exec |
| `requests.Session.get`, `.head`, `.options` | read |
| `requests.Session.post`, `.put`, `.patch`, `.delete` | write |
| `requests.Session.request(<literal method>, ...)` | read/write by method |
| `urllib.request.urlopen`, `urllib.request.urlretrieve` | exec |
| `http.client.HTTPConnection`, `http.client.HTTPSConnection` | exec |
| `aiohttp.ClientSession` | exec |
| `aiohttp.ClientSession.get`, `.head`, `.options` | read |
| `aiohttp.ClientSession.post`, `.put`, `.patch`, `.delete` | write |
| `aiohttp.ClientSession.request(<literal method>, ...)` | read/write by method |
| `httpx.get`, `httpx.head`, `httpx.options` | read |
| `httpx.post`, `httpx.put`, `httpx.patch`, `httpx.delete` | write |
| `httpx.request("GET"/"HEAD"/"OPTIONS", ...)` | read |
| `httpx.request("POST"/"PUT"/"PATCH"/"DELETE", ...)` | write |
| `httpx.Client`, `httpx.AsyncClient` | exec |
| `httpx.Client.get`, `.head`, `.options` | read |
| `httpx.Client.post`, `.put`, `.patch`, `.delete` | write |
| `httpx.Client.request(<literal method>, ...)` | read/write by method |
| `httpx.AsyncClient.get`, `.head`, `.options` | read |
| `httpx.AsyncClient.post`, `.put`, `.patch`, `.delete` | write |
| `httpx.AsyncClient.request(<literal method>, ...)` | read/write by method |
| `socket.socket`, `socket.create_connection` | exec |

Literal `.request(method, ...)` calls normalize to the corresponding canonical verb call IDs, so `requests.request("GET", ...)` emits `requests.get`. Tracked private transport chains rooted at known HTTP clients, such as `client._client._transport.request("POST", ...)`, are also classified by literal method; unrelated nested chains still stay conservative as `unknown`.

#### Database

| Call | Kind |
|------|------|
| `sqlite3.connect` | exec |
| `psycopg2.connect` | exec |
| `pymysql.connect` | exec |
| `sqlalchemy.create_engine` | exec |

### SDK-specific classification

#### OCI (Oracle Cloud Infrastructure)

| Call | Kind | Notes |
|------|------|-------|
| `oci.identity.IdentityClient`, `oci.core.ComputeClient`, `oci.core.VirtualNetworkClient`, `oci.object_storage.ObjectStorageClient`, `oci.database.DatabaseClient`, `oci.secrets.SecretsClient`, `oci.key_management.KmsManagementClient` | exec | Constructor calls |
| `oci.pagination.list_call_get_all_results`, `oci.pagination.list_call_get_all_results_generator` | exec | Pagination helpers |
| `oci.<client>.<method>()` | exec | Chained client method calls via prefix matching |
| `oci.config.from_file(path)` | read | Config file read with path extraction |

#### GitHub API (ghapi)

| Call | Kind | Notes |
|------|------|-------|
| `ghapi.all.GhApi`, `ghapi.core.GhApi` | exec | Constructors; also tracked as instance sources |
| `ghapi.graphql.gh_query`, `ghapi.page.paged`, `ghapi.page.pages` | exec | Query/pagination helpers |
| `ghapi.auth.GhDeviceAuth`, `ghapi.auth.github_auth_device` | exec | Auth helpers |
| `GhApi.create_gist`, `GhApi.create_release`, `GhApi.delete_release`, `GhApi.upload_file`, `GhApi.enable_pages` | exec | Convenience methods |
| `ghapi.actions.create_workflow_files`, `ghapi.actions.create_workflow`, `ghapi.actions.gh_create_workflow` | write | Workflow file helpers |
| `<instance>.<group>.<method>()` | exec | Instance variable tracking: `api = GhApi(); api.git.get_ref()` -> `ghapi.git.get_ref` |

#### Atlassian (atlassian-python-api)

| Call | Kind | Notes |
|------|------|-------|
| `Jira()`, `Confluence()`, `Bitbucket()`, `ServiceDesk()`, `Crowd()`, `Xray()`, `CloudAdminOrgs()`, `CloudAdminUsers()` | exec | Bare constructors (require `from atlassian import ...` provenance) |
| `atlassian.Jira()`, `atlassian.confluence.Confluence()`, etc. | exec | Module-qualified constructors (always classified) |
| `<instance>.jql()`, `<instance>.create_page()`, etc. | exec | Tracked instance methods normalized to `atlassian.<family>.<method>` |

Atlassian instance tracking supports four client families (`jira`, `confluence`,
`bitbucket`, `servicedesk`) with known method sets per family. Unrecognized
methods on tracked instances fall back to `unknown:callable:<instance>.<method>`.

### Fallback behavior

| Scenario | Event |
|----------|-------|
| Empty source | `unknown:empty-source` |
| Parse error | `unknown:parse-error` |
| Source > 100 KB | `unknown:large-script` (skips analysis) |
| Calls present but none classified | `unknown:no-classified-call` |
| No calls detected in source | `unknown:no-calls-detected` |
| Unrecognized call with resolvable name | `unknown:callable:<name>` |
| Dynamic/lambda call (no resolvable name) | `unknown:dynamic-call` |
| `open()` with dynamic mode variable | `unknown:open-mode-dynamic` |

### Name resolution scope

Supported today:

- explicit import aliases such as `import requests as rq`
- imported symbol aliases such as `from requests import get as fetch`
- bounded direct imported symbols when the fully qualified target is explicitly known, such as `from requests import get, post, request`
- simple same-scope local rebindings such as `call = requests.get`
- tracked HTTP client instances created from known constructors such as `requests.Session()` and `httpx.Client()`
- bounded literal `.request(method, ...)` handling for direct known HTTP surfaces, tracked client instances, and private transport chains rooted at tracked clients
- assignment-family invalidation, including destructuring, augmented
  assignment, and walrus rebinding
- non-assignment invalidation for `for` / `async for`, `with ... as` /
  `async with ... as`, and `except ... as`

Still deferred:

- local wrapper summaries and other interprocedural propagation
- dynamic/reflection-heavy Python patterns
