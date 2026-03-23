import type { PythonEventKind } from "./python-analyze-types"
import type { ResolvedEffectAtom } from "./python-ir"

export const BODY_SCOPE_TYPES = new Set(["function_definition", "class_definition", "lambda"])
export const COMPREHENSION_SCOPE_TYPES = new Set(["generator_expression", "list_comprehension", "dictionary_comprehension", "set_comprehension"])
export const ASSIGNMENT_CONTAINER_TYPES = new Set(["tuple", "list", "pattern_list", "tuple_pattern", "list_pattern"])
export const LIST_PURE_METHODS = new Set(["append", "clear", "copy", "count", "extend", "index", "insert", "pop", "remove", "reverse", "sort"])
export const DICT_PURE_METHODS = new Set(["clear", "copy", "get", "items", "keys", "pop", "popitem", "setdefault", "update", "values"])
export const SET_PURE_METHODS = new Set([
  "add",
  "clear",
  "copy",
  "difference",
  "difference_update",
  "discard",
  "intersection",
  "intersection_update",
  "isdisjoint",
  "issubset",
  "issuperset",
  "pop",
  "remove",
  "symmetric_difference",
  "symmetric_difference_update",
  "union",
  "update",
])
export const JSON_PURE_METHODS = new Set([...LIST_PURE_METHODS, ...DICT_PURE_METHODS])
export const TUPLE_PURE_METHODS = new Set(["count", "index"])
export const RANGE_PURE_METHODS = new Set(["count", "index"])
export const INSPECT_SIGNATURE_PURE_METHODS = new Set(["bind", "bind_partial", "format", "replace"])
export const INSPECT_PARAMETER_PURE_METHODS = new Set(["replace"])
export const INSPECT_BOUND_ARGUMENTS_PURE_METHODS = new Set(["apply_defaults"])
export const DATETIME_DATE_PURE_METHODS = new Set([
  "ctime",
  "isocalendar",
  "isoformat",
  "isoweekday",
  "replace",
  "strftime",
  "timetuple",
  "toordinal",
  "weekday",
])
export const DATETIME_DATETIME_PURE_METHODS = new Set([
  "astimezone",
  "ctime",
  "date",
  "dst",
  "isocalendar",
  "isoformat",
  "isoweekday",
  "replace",
  "strftime",
  "time",
  "timestamp",
  "timetuple",
  "timetz",
  "tzname",
  "utcoffset",
  "utctimetuple",
  "weekday",
])
export const DATETIME_TIME_PURE_METHODS = new Set(["dst", "isoformat", "replace", "strftime", "tzname", "utcoffset"])
export const DATETIME_TIMEDELTA_PURE_METHODS = new Set(["total_seconds"])
export const DATETIME_TIMEZONE_PURE_METHODS = new Set(["dst", "fromutc", "tzname", "utcoffset"])
export const TIME_FLOAT_CALLS = new Set([
  "time.clock_getres",
  "time.clock_gettime",
  "time.mktime",
  "time.monotonic",
  "time.perf_counter",
  "time.process_time",
  "time.thread_time",
  "time.time",
])
export const TIME_INT_CALLS = new Set([
  "time.clock_gettime_ns",
  "time.monotonic_ns",
  "time.perf_counter_ns",
  "time.pthread_getcpuclockid",
  "time.process_time_ns",
  "time.thread_time_ns",
  "time.time_ns",
])
export const TIME_STRING_CALLS = new Set(["time.asctime", "time.ctime", "time.strftime"])
export const TIME_TUPLE_CALLS = new Set(["time.gmtime", "time.localtime", "time.strptime", "time.struct_time"])
export const CALENDAR_INT_CALLS = new Set(["calendar.firstweekday", "calendar.leapdays", "calendar.timegm", "calendar.weekday"])
export const CALENDAR_STRING_CALLS = new Set(["calendar.calendar", "calendar.month", "calendar.weekheader"])
export const CALENDAR_TUPLE_CALLS = new Set(["calendar.monthrange"])
export const CALENDAR_LIST_CALLS = new Set(["calendar.monthcalendar"])
export const COUNTER_CALLS = new Set(["collections.Counter"])
export const COUNTER_PURE_METHODS = new Set([...DICT_PURE_METHODS, "elements", "most_common", "subtract", "total"])
export const OSPATH_STRING_CALLS = new Set([
  "os.path.abspath",
  "os.path.basename",
  "os.path.commonpath",
  "os.path.commonprefix",
  "os.path.dirname",
  "os.path.expanduser",
  "os.path.expandvars",
  "os.path.join",
  "os.path.normcase",
  "os.path.normpath",
  "os.path.realpath",
  "os.path.relpath",
])
export const OSPATH_TUPLE_CALLS = new Set(["os.path.split", "os.path.splitdrive", "os.path.splitext", "os.path.splitroot"])
export const OSPATH_INT_CALLS = new Set(["os.path.getsize"])
export const OSPATH_FLOAT_CALLS = new Set(["os.path.getatime", "os.path.getctime", "os.path.getmtime"])
export const HASHLIB_HASH_CALLS = new Set(["hashlib.sha256"])
export const HASHLIB_HASH_PURE_METHODS = new Set(["copy", "digest", "hexdigest"])
export const ZONEINFO_ZONE_CALLS = new Set(["zoneinfo.ZoneInfo", "zoneinfo.ZoneInfo.from_file", "zoneinfo.ZoneInfo.no_cache"])
export const ZONEINFO_SET_CALLS = new Set(["zoneinfo.available_timezones"])
export const MOCK_PURE_METHODS = new Set([
  "assert_any_call",
  "assert_called",
  "assert_called_once",
  "assert_called_once_with",
  "assert_called_with",
  "assert_has_calls",
  "assert_not_called",
  "attach_mock",
  "configure_mock",
  "mock_add_spec",
  "reset_mock",
])
export const ASYNC_MOCK_PURE_METHODS = new Set([
  ...MOCK_PURE_METHODS,
  "assert_any_await",
  "assert_awaited",
  "assert_awaited_once",
  "assert_awaited_once_with",
  "assert_awaited_with",
  "assert_has_awaits",
  "assert_not_awaited",
])
export const STRING_ITERABLE_METHODS = new Set(["split", "rsplit", "splitlines"])
export const STRING_RETURNING_METHODS = new Set([
  "capitalize",
  "casefold",
  "center",
  "expandtabs",
  "format",
  "format_map",
  "join",
  "ljust",
  "lower",
  "lstrip",
  "removeprefix",
  "removesuffix",
  "replace",
  "rjust",
  "rstrip",
  "strip",
  "swapcase",
  "title",
  "translate",
  "upper",
  "zfill",
])
export const STRING_PURE_METHODS = new Set([
  "capitalize",
  "casefold",
  "center",
  "count",
  "encode",
  "endswith",
  "expandtabs",
  "find",
  "format",
  "format_map",
  "index",
  "isalnum",
  "isalpha",
  "isascii",
  "isdecimal",
  "isdigit",
  "isidentifier",
  "islower",
  "isnumeric",
  "isprintable",
  "isspace",
  "istitle",
  "isupper",
  "join",
  "ljust",
  "lower",
  "lstrip",
  "partition",
  "removeprefix",
  "removesuffix",
  "replace",
  "rfind",
  "rindex",
  "rjust",
  "rpartition",
  "rsplit",
  "rstrip",
  "split",
  "splitlines",
  "startswith",
  "strip",
  "swapcase",
  "title",
  "translate",
  "upper",
  "zfill",
])
export const BYTES_PURE_METHODS = new Set([
  "capitalize",
  "center",
  "count",
  "decode",
  "endswith",
  "expandtabs",
  "find",
  "hex",
  "index",
  "isalnum",
  "isalpha",
  "isascii",
  "isdigit",
  "islower",
  "isspace",
  "istitle",
  "isupper",
  "join",
  "ljust",
  "lower",
  "lstrip",
  "partition",
  "removeprefix",
  "removesuffix",
  "replace",
  "rfind",
  "rindex",
  "rjust",
  "rpartition",
  "rsplit",
  "rstrip",
  "split",
  "splitlines",
  "startswith",
  "strip",
  "swapcase",
  "title",
  "translate",
  "upper",
  "zfill",
])
export const BYTEARRAY_PURE_METHODS = new Set([
  ...BYTES_PURE_METHODS,
  "append",
  "clear",
  "copy",
  "extend",
  "insert",
  "pop",
  "remove",
  "reverse",
])
export const MEMORYVIEW_PURE_METHODS = new Set(["cast", "hex", "release", "tobytes", "tolist", "toreadonly"])
export const INT_PURE_METHODS = new Set(["as_integer_ratio", "bit_count", "bit_length", "conjugate", "is_integer", "to_bytes"])
export const FLOAT_PURE_METHODS = new Set(["as_integer_ratio", "conjugate", "hex", "is_integer"])
export const COMPLEX_PURE_METHODS = new Set(["conjugate"])
export const EXACT_PURE_CALLS = new Set([
  "Path",
  "Path.cwd",
  "Path.home",
  "Path.from_uri",
  "pathlib.Path",
  "pathlib.Path.cwd",
  "pathlib.Path.home",
  "pathlib.Path.from_uri",
  "os.path.join",
])
export const DATETIME_DATE_CALLS = new Set([
  "datetime.date",
  "datetime.date.fromisocalendar",
  "datetime.date.fromisoformat",
  "datetime.date.fromordinal",
  "datetime.date.fromtimestamp",
  "datetime.date.strptime",
  "datetime.date.today",
])
export const DATETIME_DATETIME_CALLS = new Set([
  "datetime.datetime",
  "datetime.datetime.combine",
  "datetime.datetime.fromisocalendar",
  "datetime.datetime.fromisoformat",
  "datetime.datetime.fromordinal",
  "datetime.datetime.fromtimestamp",
  "datetime.datetime.now",
  "datetime.datetime.strptime",
  "datetime.datetime.today",
  "datetime.datetime.utcnow",
  "datetime.datetime.utcfromtimestamp",
])
export const DATETIME_TIME_CALLS = new Set(["datetime.time", "datetime.time.fromisoformat", "datetime.time.strptime"])
export const DATETIME_TIMEDELTA_CALLS = new Set(["datetime.timedelta"])
export const DATETIME_TIMEZONE_CALLS = new Set(["datetime.timezone"])
export const DATETIME_DATE_CONSTANTS = new Set(["datetime.date.max", "datetime.date.min"])
export const DATETIME_DATETIME_CONSTANTS = new Set(["datetime.datetime.max", "datetime.datetime.min"])
export const DATETIME_TIME_CONSTANTS = new Set(["datetime.time.max", "datetime.time.min"])
export const DATETIME_TIMEDELTA_CONSTANTS = new Set([
  "datetime.date.resolution",
  "datetime.datetime.resolution",
  "datetime.time.resolution",
  "datetime.timedelta.max",
  "datetime.timedelta.min",
  "datetime.timedelta.resolution",
])
export const DATETIME_TIMEZONE_CONSTANTS = new Set([
  "datetime.UTC",
  "datetime.timezone.max",
  "datetime.timezone.min",
  "datetime.timezone.utc",
])
export const PATH_PURE_METHODS = new Set([
  "absolute",
  "as_posix",
  "as_uri",
  "cwd",
  "expanduser",
  "full_match",
  "is_absolute",
  "is_relative_to",
  "is_reserved",
  "joinpath",
  "match",
  "relative_to",
  "with_name",
  "with_segments",
  "with_stem",
  "with_suffix",
])
export const PATH_DYNAMIC_RETURNING_METHODS = new Set([
  "absolute",
  "copy",
  "copy_into",
  "expanduser",
  "move",
  "move_into",
  "readlink",
  "relative_to",
  "rename",
  "replace",
  "resolve",
  "with_name",
  "with_segments",
  "with_stem",
  "with_suffix",
])
export const INSPECT_SIGNATURE_CALLS = new Set(["inspect.signature", "inspect.Signature", "inspect.Signature.from_callable"])
export const INSPECT_PARAMETER_CALLS = new Set(["inspect.Parameter"])
export const INSPECT_BOUND_ARGUMENTS_CALLS = new Set(["inspect.BoundArguments"])
export const MATCH_RESULT_CALLS = new Set(["re.fullmatch", "re.match", "re.search"])
export const REGEX_PATTERN_PURE_METHODS = new Set(["findall", "finditer", "fullmatch", "match", "search", "split"])
export const DIRECT_IMPORT_BINDINGS = new Set(["os.path.join", "pathlib.Path"])
export const JSON_CONTAINER_CALLS = new Set(["json.load", "json.loads"])
export const JSON_CONTAINER_CUSTOMIZER_KEYWORDS = new Set([
  "cls",
  "object_hook",
  "object_pairs_hook",
  "parse_float",
  "parse_int",
  "parse_constant",
])
export const TRACKED_HTTP_CLIENT_CONSTRUCTORS = new Set(["requests.Session", "httpx.Client", "httpx.AsyncClient", "aiohttp.ClientSession"])
export const GENERIC_HTTP_REQUEST_SUFFIXES = new Set(["_transport.request", "_client._transport.request"])
export const SHADOW_GUARDED_PURE_BUILTINS = new Set([
  "abs",
  "aiter",
  "all",
  "anext",
  "any",
  "ascii",
  "bin",
  "bool",
  "bytearray",
  "bytes",
  "callable",
  "chr",
  "classmethod",
  "complex",
  "delattr",
  "dict",
  "dir",
  "divmod",
  "enumerate",
  "filter",
  "float",
  "format",
  "frozenset",
  "getattr",
  "globals",
  "hasattr",
  "hash",
  "hex",
  "id",
  "int",
  "isinstance",
  "issubclass",
  "iter",
  "len",
  "list",
  "locals",
  "map",
  "max",
  "memoryview",
  "min",
  "next",
  "object",
  "oct",
  "ord",
  "pow",
  "property",
  "range",
  "repr",
  "reversed",
  "round",
  "set",
  "setattr",
  "slice",
  "sorted",
  "staticmethod",
  "str",
  "sum",
  "super",
  "tuple",
  "vars",
  "zip",
])
export const KEY_CALLBACK_PURE_BUILTINS = new Set(["max", "min", "sorted"])
export const SHADOW_GUARDED_READ_BUILTINS = new Set(["input"])
export const SHADOW_GUARDED_EMIT_BUILTINS = new Set(["help"])
export const SHADOW_GUARDED_EXEC_BUILTINS = new Set(["breakpoint"])
export const STANDARD_EXCEPTION_BUILTINS = new Set([
  "ArithmeticError",
  "AssertionError",
  "AttributeError",
  "BaseException",
  "BaseExceptionGroup",
  "BlockingIOError",
  "BrokenPipeError",
  "BufferError",
  "BytesWarning",
  "ChildProcessError",
  "ConnectionAbortedError",
  "ConnectionError",
  "ConnectionRefusedError",
  "ConnectionResetError",
  "DeprecationWarning",
  "EOFError",
  "EncodingWarning",
  "EnvironmentError",
  "Exception",
  "ExceptionGroup",
  "FileExistsError",
  "FileNotFoundError",
  "FloatingPointError",
  "FutureWarning",
  "GeneratorExit",
  "IOError",
  "ImportError",
  "ImportWarning",
  "IndentationError",
  "IndexError",
  "InterruptedError",
  "IsADirectoryError",
  "KeyError",
  "KeyboardInterrupt",
  "LookupError",
  "MemoryError",
  "ModuleNotFoundError",
  "NameError",
  "NotADirectoryError",
  "NotImplementedError",
  "OSError",
  "OverflowError",
  "PendingDeprecationWarning",
  "PermissionError",
  "ProcessLookupError",
  "RecursionError",
  "ReferenceError",
  "ResourceWarning",
  "RuntimeError",
  "RuntimeWarning",
  "StopAsyncIteration",
  "StopIteration",
  "SyntaxError",
  "SyntaxWarning",
  "SystemError",
  "SystemExit",
  "TabError",
  "TimeoutError",
  "TypeError",
  "UnboundLocalError",
  "UnicodeDecodeError",
  "UnicodeEncodeError",
  "UnicodeError",
  "UnicodeTranslateError",
  "UnicodeWarning",
  "UserWarning",
  "ValueError",
  "Warning",
  "WindowsError",
  "ZeroDivisionError",
])
export const HTTP_REQUEST_CALL_BASES = new Map([
  ["requests.request", "requests"],
  ["requests.Session.request", "requests.Session"],
  ["httpx.request", "httpx"],
  ["httpx.Client.request", "httpx.Client"],
  ["httpx.AsyncClient.request", "httpx.AsyncClient"],
  ["aiohttp.ClientSession.request", "aiohttp.ClientSession"],
])
export const TRACKED_HTTP_REQUEST_SUFFIXES = new Set(["request", "_transport.request", "_client._transport.request"])
export const HTTP_REQUEST_METHOD_SUFFIXES = new Map([
  ["GET", "get"],
  ["HEAD", "head"],
  ["OPTIONS", "options"],
  ["POST", "post"],
  ["PUT", "put"],
  ["PATCH", "patch"],
  ["DELETE", "delete"],
])
export const EFFECT_KIND = {
  "fs.read": "read",
  "fs.write": "write",
  "network.read": "read",
  "network.write": "write",
  "network.exec": "exec",
  "db.exec": "exec",
  "process.exec": "exec",
  "dynamic.exec": "exec",
  "emit.signal": "emit",
  "pure.compute": "pure",
  unknown: "unknown",
} satisfies Record<ResolvedEffectAtom, PythonEventKind>

export const CALLABLE_UNKNOWN_PREFIX = "callable:"
export const RULES_VERSION = 1
export const RULES_URL = new URL("./python-rules.json", import.meta.url)
export const FAMILIES = ["jira", "confluence", "bitbucket", "servicedesk"] as const
