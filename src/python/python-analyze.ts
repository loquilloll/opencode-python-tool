import { readFile } from "fs/promises"
import path from "path"
import { analyzerMetadata, type PythonAnalyzeResult, type PythonEventEvidence, type ReceiverKind, type ResolvedEffect, type ResolvedEffectAtom } from "./python-ir"
import { evaluateGuardsDetailed } from "./python-guard-eval"
import { getPythonAstFrontend } from "./frontend/tree-sitter"
import type { PythonAstNode as Node, PythonAstTree as Tree } from "./frontend/interface"
import {
  applyAssignmentProvenance,
  clearReceiverDeps,
  clearTrackedProvenanceForName,
  lookupTrackedReceiverContainerKind,
  trackableInvalidationDeps,
  trackableReceiverInfo,
  trackableSelfAttributePath,
  type ContainerKind,
  type ReceiverContainer,
} from "./python-provenance"
import { parseGuardedRules, type GuardedCallRule, type GuardedMethodRule } from "./python-rule-schema"
import type { PythonArgs as Args, PythonValue as Value } from "./python-values"

export type PythonEventKind = "read" | "write" | "emit" | "exec" | "pure" | "unknown"

export type PythonEvent = {
  kind: PythonEventKind
  call: string
  sourceCall?: string
  path?: string
  dynamicPath?: boolean
  evidence?: PythonEventEvidence
}

type PathSpec = {
  index: number
  names: string[]
}

type AtlassianClientFamily = "jira" | "confluence" | "bitbucket" | "servicedesk"

type AtlassianCtor = {
  family?: AtlassianClientFamily
  variants: string[]
}

type Scope = {
  parent?: Scope
  bindings: Map<string, string>
  callableFactories: Map<string, Node>
  containerInstances: Map<string, ContainerKind>
  iteratedElementInstances: Map<string, ContainerKind>
  iteratedPathInstances: Map<string, Value>
  receiverContainers: Map<string, ReceiverContainer>
  pathInstances: Map<string, Value>
  httpClientInstances: Map<string, string>
  httpResponseInstances: Set<string>
  ghapiInstances: Set<string>
  atlassianInstances: Map<string, AtlassianClientFamily>
}

type TimelineEntry = {
  kind: "assignment" | "call" | "definition" | "import" | "raise" | "rebind"
  node: Node
  scope: Scope
  startIndex: number
  endIndex: number
}

const BODY_SCOPE_TYPES = new Set(["function_definition", "class_definition", "lambda"])
const COMPREHENSION_SCOPE_TYPES = new Set(["generator_expression", "list_comprehension", "dictionary_comprehension", "set_comprehension"])
const ASSIGNMENT_CONTAINER_TYPES = new Set(["tuple", "list", "pattern_list", "tuple_pattern", "list_pattern"])
const LIST_PURE_METHODS = new Set(["append", "clear", "copy", "count", "extend", "index", "insert", "pop", "remove", "reverse", "sort"])
const DICT_PURE_METHODS = new Set(["clear", "copy", "get", "items", "keys", "pop", "popitem", "setdefault", "update", "values"])
const SET_PURE_METHODS = new Set([
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
const JSON_PURE_METHODS = new Set([...LIST_PURE_METHODS, ...DICT_PURE_METHODS])
const TUPLE_PURE_METHODS = new Set(["count", "index"])
const RANGE_PURE_METHODS = new Set(["count", "index"])
const STRING_ITERABLE_METHODS = new Set(["split", "rsplit", "splitlines"])
const STRING_RETURNING_METHODS = new Set([
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
const STRING_PURE_METHODS = new Set([
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
const BYTES_PURE_METHODS = new Set([
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
const BYTEARRAY_PURE_METHODS = new Set([
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
const MEMORYVIEW_PURE_METHODS = new Set(["cast", "hex", "release", "tobytes", "tolist", "toreadonly"])
const INT_PURE_METHODS = new Set(["as_integer_ratio", "bit_count", "bit_length", "conjugate", "is_integer", "to_bytes"])
const FLOAT_PURE_METHODS = new Set(["as_integer_ratio", "conjugate", "hex", "is_integer"])
const COMPLEX_PURE_METHODS = new Set(["conjugate"])
const EXACT_PURE_CALLS = new Set(["Path", "Path.cwd", "pathlib.Path", "pathlib.Path.cwd", "os.path.join"])
const PATH_PURE_METHODS = new Set(["cwd", "joinpath"])
const MATCH_RESULT_CALLS = new Set(["re.fullmatch", "re.match", "re.search"])
const DIRECT_IMPORT_BINDINGS = new Set(["os.path.join", "pathlib.Path"])
const JSON_CONTAINER_CALLS = new Set(["json.load", "json.loads"])
const JSON_CONTAINER_CUSTOMIZER_KEYWORDS = new Set([
  "cls",
  "object_hook",
  "object_pairs_hook",
  "parse_float",
  "parse_int",
  "parse_constant",
])
const TRACKED_HTTP_CLIENT_CONSTRUCTORS = new Set(["requests.Session", "httpx.Client", "httpx.AsyncClient", "aiohttp.ClientSession"])
const GENERIC_HTTP_REQUEST_SUFFIXES = new Set(["_transport.request", "_client._transport.request"])
const SHADOW_GUARDED_PURE_BUILTINS = new Set([
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
const KEY_CALLBACK_PURE_BUILTINS = new Set(["max", "min", "sorted"])
const SHADOW_GUARDED_READ_BUILTINS = new Set(["input"])
const SHADOW_GUARDED_EMIT_BUILTINS = new Set(["help"])
const SHADOW_GUARDED_EXEC_BUILTINS = new Set(["breakpoint"])
const STANDARD_EXCEPTION_BUILTINS = new Set([
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
const HTTP_REQUEST_CALL_BASES = new Map([
  ["requests.request", "requests"],
  ["requests.Session.request", "requests.Session"],
  ["httpx.request", "httpx"],
  ["httpx.Client.request", "httpx.Client"],
  ["httpx.AsyncClient.request", "httpx.AsyncClient"],
  ["aiohttp.ClientSession.request", "aiohttp.ClientSession"],
])
const TRACKED_HTTP_REQUEST_SUFFIXES = new Set(["request", "_transport.request", "_client._transport.request"])
const HTTP_REQUEST_METHOD_SUFFIXES = new Map([
  ["GET", "get"],
  ["HEAD", "head"],
  ["OPTIONS", "options"],
  ["POST", "post"],
  ["PUT", "put"],
  ["PATCH", "patch"],
  ["DELETE", "delete"],
])
const EFFECT_KIND = {
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

type Rules = {
  methods: {
    read: Set<string>
    write: Set<string>
    emit: Set<string>
    pure: Set<string>
  }
  calls: {
    read: Set<string>
    write: Set<string>
    emit: Set<string>
    exec: Set<string>
    pure: Set<string>
    networkRead: Set<string>
    networkWrite: Set<string>
    networkExec: Set<string>
    dbExec: Set<string>
    tempfileWrite: Set<string>
    dangerousDeserializeExec: Set<string>
  }
  pathCalls: {
    read: Record<string, PathSpec>
    write: Record<string, PathSpec>
  }
  sdk: {
    oci: {
      execCalls: Set<string>
      clientMethodPrefixes: string[]
    }
    ghapi: {
      execCalls: Set<string>
      writeCalls: Set<string>
      instanceConstructors: Set<string>
    }
    atlassian: {
      constructorMetadata: Map<string, { family?: AtlassianClientFamily; bare: boolean }>
      clientMethods: Record<AtlassianClientFamily, Set<string>>
    }
  }
  guarded: {
    methods: GuardedMethodRule[]
    calls: GuardedCallRule[]
  }
}

const CALLABLE_UNKNOWN_PREFIX = "callable:"
const RULES_VERSION = 1
const RULES_URL = new URL("./python-rules.json", import.meta.url)
const FAMILIES = ["jira", "confluence", "bitbucket", "servicedesk"] as const

let parserFrontend: Promise<Awaited<ReturnType<typeof getPythonAstFrontend>>> | undefined
let rules: Promise<Rules> | undefined
let rulesKey: string | undefined

function fail(label: string, msg: string): never {
  throw new Error(`Invalid python-rules.json: ${label} ${msg}`)
}

function record(input: unknown, label: string) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail(label, "must be an object")
  return input as Record<string, unknown>
}

function list(input: unknown, label: string) {
  if (!Array.isArray(input)) fail(label, "must be a string[]")
  const out: string[] = []
  for (const [i, item] of input.entries()) {
    if (typeof item !== "string") fail(`${label}[${i}]`, "must be a string")
    out.push(item)
  }
  return out
}

function listOrEmpty(input: unknown, label: string) {
  if (input === undefined) return []
  return list(input, label)
}

function num(input: unknown, label: string) {
  if (typeof input !== "number" || !Number.isInteger(input)) fail(label, "must be an integer")
  if (input < 0) fail(label, "must be >= 0")
  return input
}

function spec(input: unknown, label: string): PathSpec {
  const obj = record(input, label)
  return {
    index: num(obj.index, `${label}.index`),
    names: list(obj.names, `${label}.names`),
  }
}

function specs(input: unknown, label: string) {
  const obj = record(input, label)
  const out = Object.create(null) as Record<string, PathSpec>
  for (const [key, value] of Object.entries(obj)) out[key] = spec(value, `${label}.${key}`)
  return out
}

function family(input: unknown, label: string) {
  if (input === undefined) return
  if (typeof input !== "string") fail(label, "must be a supported family")
  if (!FAMILIES.includes(input as AtlassianClientFamily)) fail(label, "must be a supported family")
  return input as AtlassianClientFamily
}

function ctors(input: unknown, label: string) {
  if (!Array.isArray(input)) fail(label, "must be an array")
  return input.map((item, i) => {
    const obj = record(item, `${label}[${i}]`)
    return {
      family: family(obj.family, `${label}[${i}].family`),
      variants: list(obj.variants, `${label}[${i}].variants`),
    } satisfies AtlassianCtor
  })
}

async function loadRules() {
  const source = process.env.OPENCODE_PYTHON_RULES ? path.resolve(process.env.OPENCODE_PYTHON_RULES) : RULES_URL
  const key = typeof source === "string" ? source : source.href
  if (rules && rulesKey === key) return rules
  rulesKey = key
  rules = readRules(source).catch((err) => {
    if (rulesKey === key) {
      rules = undefined
      rulesKey = undefined
    }
    throw err
  })
  return rules
}

async function readRules(source: string | URL): Promise<Rules> {
  let text = ""
  try {
    text = await readFile(source, "utf8")
  } catch (err) {
    const msg = err instanceof Error ? err.message : "could not be read"
    fail("file", msg)
  }

  let data: unknown
  try {
    data = JSON.parse(text) as unknown
  } catch (err) {
    const msg = err instanceof Error ? err.message : "contains invalid JSON"
    fail("file", `contains invalid JSON (${msg})`)
  }

  const raw = record(data, "root")
  if (num(raw.version, "version") !== RULES_VERSION) fail("version", `must be ${RULES_VERSION}`)

  const methods = record(raw.methods, "methods")
  const calls = record(raw.calls, "calls")
  const pathCalls = record(raw.pathCalls, "pathCalls")
  const sdk = record(raw.sdk, "sdk")
  const oci = record(sdk.oci, "sdk.oci")
  const ghapi = record(sdk.ghapi, "sdk.ghapi")
  const atlassian = record(sdk.atlassian, "sdk.atlassian")

  const constructors = ctors(atlassian.constructors, "sdk.atlassian.constructors")
  const constructorMetadata = new Map<string, { family?: AtlassianClientFamily; bare: boolean }>()
  for (const item of constructors) {
    for (const variant of item.variants) {
      constructorMetadata.set(variant, {
        family: item.family,
        bare: !variant.includes("."),
      })
    }
  }

  const clientMethods = record(atlassian.clientMethods, "sdk.atlassian.clientMethods")

  return {
    methods: {
      read: new Set(list(methods.read, "methods.read")),
      write: new Set(list(methods.write, "methods.write")),
      emit: new Set(listOrEmpty(methods.emit, "methods.emit")),
      pure: new Set(listOrEmpty(methods.pure, "methods.pure")),
    },
    calls: {
      read: new Set(list(calls.read, "calls.read")),
      write: new Set(list(calls.write, "calls.write")),
      emit: new Set(listOrEmpty(calls.emit, "calls.emit")),
      exec: new Set(list(calls.exec, "calls.exec")),
      pure: new Set(listOrEmpty(calls.pure, "calls.pure")),
      networkRead: new Set(listOrEmpty(calls.networkRead, "calls.networkRead")),
      networkWrite: new Set(listOrEmpty(calls.networkWrite, "calls.networkWrite")),
      networkExec: new Set(list(calls.networkExec, "calls.networkExec")),
      dbExec: new Set(list(calls.dbExec, "calls.dbExec")),
      tempfileWrite: new Set(list(calls.tempfileWrite, "calls.tempfileWrite")),
      dangerousDeserializeExec: new Set(list(calls.dangerousDeserializeExec, "calls.dangerousDeserializeExec")),
    },
    pathCalls: {
      read: specs(pathCalls.read, "pathCalls.read"),
      write: specs(pathCalls.write, "pathCalls.write"),
    },
    sdk: {
      oci: {
        execCalls: new Set(list(oci.execCalls, "sdk.oci.execCalls")),
        clientMethodPrefixes: list(oci.clientMethodPrefixes, "sdk.oci.clientMethodPrefixes"),
      },
      ghapi: {
        execCalls: new Set(list(ghapi.execCalls, "sdk.ghapi.execCalls")),
        writeCalls: new Set(list(ghapi.writeCalls, "sdk.ghapi.writeCalls")),
        instanceConstructors: new Set(list(ghapi.instanceConstructors, "sdk.ghapi.instanceConstructors")),
      },
      atlassian: {
        constructorMetadata,
        clientMethods: {
          jira: new Set(list(clientMethods.jira, "sdk.atlassian.clientMethods.jira")),
          confluence: new Set(list(clientMethods.confluence, "sdk.atlassian.clientMethods.confluence")),
          bitbucket: new Set(list(clientMethods.bitbucket, "sdk.atlassian.clientMethods.bitbucket")),
          servicedesk: new Set(list(clientMethods.servicedesk, "sdk.atlassian.clientMethods.servicedesk")),
        },
      },
    },
    guarded: parseGuardedRules(raw.guarded, "guarded", { fail, record, list, listOrEmpty, num }),
  }
}

async function getFrontend() {
  if (parserFrontend) return parserFrontend
  parserFrontend = getPythonAstFrontend().catch((error) => {
    parserFrontend = undefined
    throw error
  })
  return parserFrontend
}

function unique(input: PythonEvent[]) {
  const result = new Map<string, PythonEvent>()
  for (const item of input) {
    const key = [
      item.kind,
      item.call,
      item.sourceCall ?? "",
      item.path ?? "<dynamic>",
      item.dynamicPath ? "1" : "0",
      JSON.stringify(item.evidence ?? null),
    ].join("|")
    if (result.has(key)) continue
    result.set(key, item)
  }
  return Array.from(result.values())
}

function tail(input: string) {
  const parts = input.split(".")
  return parts[parts.length - 1] ?? ""
}

function parseString(input: string) {
  const value = input.trim()
  if (!value) return
  const match = value.match(/^([rRuUbBfF]{0,3})([\s\S]*)$/)
  const prefix = (match?.[1] ?? "").toLowerCase()
  const body = match?.[2] ?? value
  if (prefix.includes("f")) return

  const quotes = ["\"\"\"", "'''", "\"", "'"]
  for (const quote of quotes) {
    if (!body.startsWith(quote) || !body.endsWith(quote)) continue
    if (body.length < quote.length * 2) continue
    return body
      .slice(quote.length, -quote.length)
      .replace(/\\\\/g, "\\")
      .replace(/\\\"/g, "\"")
      .replace(/\\'/g, "'")
  }
}

function value(node: Node | null): Value {
  if (!node) return { dynamic: true }

  if (node.type === "string") {
    const parsed = parseString(node.text)
    if (parsed !== undefined) return { dynamic: false, literal: parsed }
    return { dynamic: true }
  }

  if (node.type === "concatenated_string") {
    const parts = node.namedChildren.map((child) => parseString(child.text))
    if (parts.some((part) => part === undefined)) return { dynamic: true }
    return { dynamic: false, literal: parts.join("") }
  }

  return { dynamic: true }
}

function args(node: Node): Args {
  const positional: Value[] = []
  const keyword = Object.create(null) as Record<string, Value>
  const input = node.childForFieldName("arguments")
  if (!input) return { positional, keyword }

  for (const child of input.namedChildren) {
    if (child.type === "keyword_argument") {
      const name = child.childForFieldName("name")?.text
      if (!name) continue
      keyword[name] = value(child.childForFieldName("value"))
      continue
    }
    positional.push(value(child))
  }

  return { positional, keyword }
}

function pick(input: Args, index: number, names: string[]) {
  if (input.positional[index]) return input.positional[index]
  for (const name of names) {
    if (!input.keyword[name]) continue
    return input.keyword[name]
  }
}

function name(node: Node | null): string | undefined {
  if (!node) return
  if (node.type === "identifier") return node.text

  if (node.type === "attribute") {
    const left = name(node.childForFieldName("object"))
    const right = node.childForFieldName("attribute")?.text
    if (!right) return left
    if (!left) return right
    return `${left}.${right}`
  }

  if (node.type === "call") return name(node.childForFieldName("function"))
  if (node.type === "subscript") return name(node.childForFieldName("value"))
}

function scope(parent?: Scope): Scope {
  return {
    parent,
    bindings: new Map<string, string>(),
    callableFactories: new Map<string, Node>(),
    containerInstances: new Map<string, ContainerKind>(),
    iteratedElementInstances: new Map<string, ContainerKind>(),
    iteratedPathInstances: new Map<string, Value>(),
    receiverContainers: new Map<string, ReceiverContainer>(),
    pathInstances: new Map<string, Value>(),
    httpClientInstances: new Map<string, string>(),
    httpResponseInstances: new Set<string>(),
    ghapiInstances: new Set<string>(),
    atlassianInstances: new Map<string, AtlassianClientFamily>(),
  }
}

function lookupBinding(input: Scope, key: string) {
  for (let current: Scope | undefined = input; current; current = current.parent) {
    const value = current.bindings.get(key)
    if (value) return value
  }
}

function hasBoundName(input: Scope, key: string) {
  for (let current: Scope | undefined = input; current; current = current.parent) {
    if (current.bindings.has(key)) return true
  }
  return false
}

function resolveQualified(input: string, current: Scope) {
  let parts = input.split(".")
  const seen = new Set<string>()
  while (parts[0]) {
    const head = parts[0]
    if (!head || seen.has(head)) break
    const target = lookupBinding(current, head)
    if (!target || target === head) break
    seen.add(head)
    parts = [...target.split("."), ...parts.slice(1)]
  }
  return parts.join(".")
}

function resolvedName(node: Node | null, current: Scope) {
  const raw = name(node)
  if (!raw) return
  return resolveQualified(raw, current)
}

function clearTrackedName(current: Scope, name: string) {
  current.bindings.delete(name)
  current.callableFactories.delete(name)
  current.containerInstances.delete(name)
  current.iteratedElementInstances.delete(name)
  current.iteratedPathInstances.delete(name)
  current.pathInstances.delete(name)
  clearTrackedProvenanceForName(current, name)
  current.httpClientInstances.delete(name)
  current.httpResponseInstances.delete(name)
  current.ghapiInstances.delete(name)
  current.atlassianInstances.delete(name)
}

function invalidateTrackedName(current: Scope, name: string) {
  clearTrackedName(current, name)
  current.bindings.set(name, name)
}

function hasGhapiInstance(current: Scope, name: string) {
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    if (scope.ghapiInstances.has(name)) return true
  }
  return false
}

function atlassianInstance(current: Scope, name: string) {
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const family = scope.atlassianInstances.get(name)
    if (family) return family
  }
}

function httpClientInstance(current: Scope, name: string) {
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const client = scope.httpClientInstances.get(name)
    if (client) return client
  }
}

function hasHttpResponseInstance(current: Scope, name: string) {
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    if (scope.httpResponseInstances.has(name)) return true
    if (scope.bindings.has(name)) return false
  }
  return false
}

function containerInstance(current: Scope, name: string) {
  if (name.startsWith("self.")) {
    return current.containerInstances.get(name)
  }
  const root = name.split(".")[0]
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const kind = scope.containerInstances.get(name)
    if (kind) return kind
    if (root && scope.bindings.has(root)) return
  }
}

function iteratedElementInstance(current: Scope, name: string) {
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const kind = scope.iteratedElementInstances.get(name)
    if (kind) return kind
    if (scope.bindings.has(name)) return
  }
}

function iteratedPathInstance(current: Scope, name: string) {
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const value = scope.iteratedPathInstances.get(name)
    if (value) return value
    if (scope.bindings.has(name)) return
  }
}

function pathInstanceValue(current: Scope, name: string) {
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const value = scope.pathInstances.get(name)
    if (value) return value
    if (scope.bindings.has(name)) return
  }
}

function containerKind(node: Node | null, current: Scope): ContainerKind | undefined {
  if (!node) return
  if (node.type === "list") return "list"
  if (node.type === "tuple") return "tuple"
  if (node.type === "dictionary") return "dict"
  if (node.type === "set") return "set"
  if (node.type === "list_comprehension") return "list"
  if (node.type === "dictionary_comprehension") return "dict"
  if (node.type === "set_comprehension") return "set"
  if (node.type === "boolean_operator") {
    const left = containerKind(node.childForFieldName("left"), current)
    const right = containerKind(node.childForFieldName("right"), current)
    if (left && right && left === right) return left
    if (left === "json" && (right === "dict" || right === "list")) return "json"
    if (right === "json" && (left === "dict" || left === "list")) return "json"
    return
  }
  if (node.type !== "call") return
  const call = resolvedName(node.childForFieldName("function"), current)
  if (call === "list") return "list"
  if (call === "dict") return "dict"
  if (call === "set") return "set"
  if (call === "next") {
    const input = node.childForFieldName("arguments")
    const first = input?.namedChildren[0] ?? null
    return generatorElementKind(first, current)
  }
  if (!call) return
  const method = tail(call)
  const parts = call.split(".")
  const instance = parts[0]
  if (instance && method === "json" && parts.length === 2 && hasHttpResponseInstance(current, instance)) {
    const input = args(node)
    if (input.positional.length === 0 && Object.keys(input.keyword).length === 0 && !hasDictionarySplat(node)) return "json"
    return
  }
  if (instance && method === "get") {
    const localContainer = containerInstance(current, instance)
    if (localContainer === "json") return "json"
  }
  if (!call || !JSON_CONTAINER_CALLS.has(call)) return
  const input = args(node)
  if (hasJsonCustomizers(node, input)) return
  return "json"
}

function isBytesLiteralText(text: string) {
  return /^(?:[rR]?[bB]|[bB][rR]?)['"]/.test(text.trim())
}

function bytesKind(node: Node | null, current: Scope): "bytes" | "bytearray" | "memoryview" | undefined {
  if (!node) return
  if ((node.type === "string" || node.type === "concatenated_string") && isBytesLiteralText(node.text)) return "bytes"
  if (node.type !== "call") return
  const call = resolvedName(node.childForFieldName("function"), current)
  if (call?.endsWith("Path.read_bytes")) return "bytes"
  const fn = node.childForFieldName("function")
  const method = call ? tail(call) : undefined
  const receiver = fn?.type === "attribute" ? fn.childForFieldName("object") : null
  if (method === "read_bytes" && trackedPathValue(receiver, current)) return "bytes"
}

function matchKind(node: Node | null, current: Scope): "match" | undefined {
  if (!node || node.type !== "call") return
  const call = resolvedName(node.childForFieldName("function"), current)
  if (call && MATCH_RESULT_CALLS.has(call)) return "match"
}

function numericKind(node: Node | null, current: Scope): "int" | "float" | "complex" | undefined {
  if (!node) return
  if (node.type === "integer") return "int"
  if (node.type === "float") return "float"
}

function stringKind(node: Node | null, current: Scope): "string" | undefined {
  if (!node) return
  if ((node.type === "string" || node.type === "concatenated_string") && !isBytesLiteralText(node.text)) return "string"
  if (node.type !== "call") return
  const call = resolvedName(node.childForFieldName("function"), current)
  if (call?.endsWith("Path.read_text")) return "string"
  const fn = node.childForFieldName("function")
  const method = call ? tail(call) : undefined
  const receiver = fn?.type === "attribute" ? fn.childForFieldName("object") : null
  if (method === "read_text" && trackedPathValue(receiver, current)) return "string"
}

function trackedPathValue(node: Node | null, current: Scope): Value | undefined {
  if (!node) return
  if (node.type === "identifier") return pathInstanceValue(current, node.text)

  if (node.type === "binary_operator") {
    const left = node.childForFieldName("left")
    const right = node.childForFieldName("right")
    const base = trackedPathValue(left, current)
    const segment = right?.type === "string" ? parseString(right.text) : undefined
    const between = left && right ? node.text.slice(left.text.length, node.text.length - right.text.length) : ""
    if (base && segment !== undefined && between.includes("/")) {
      if (base.dynamic || base.literal === undefined) return { dynamic: true }
      return { dynamic: false, literal: path.join(base.literal, segment) }
    }
  }

  if (node.type !== "call") return

  const call = resolvedName(node.childForFieldName("function"), current)
  if (!call) return
  if (call === "Path" || call === "pathlib.Path") return pick(args(node), 0, ["path"]) ?? { dynamic: true }
  if (call === "Path.cwd" || call === "pathlib.Path.cwd") return { dynamic: true }
  if (tail(call) !== "joinpath") return

  const fn = node.childForFieldName("function")
  const receiver = fn?.type === "attribute" ? fn.childForFieldName("object") : null
  const base = trackedPathValue(receiver, current)
  if (!base) return
  const input = args(node)
  if (base.dynamic || input.positional.length !== 1 || input.positional[0]?.dynamic || input.positional[0]?.literal === undefined || base.literal === undefined) {
    return { dynamic: true }
  }
  return { dynamic: false, literal: path.join(base.literal, input.positional[0].literal) }
}

function pureContainerMethod(kind: ContainerKind, method: string) {
  if (kind === "list") return LIST_PURE_METHODS.has(method)
  if (kind === "tuple") return TUPLE_PURE_METHODS.has(method)
  if (kind === "range") return RANGE_PURE_METHODS.has(method)
  if (kind === "dict") return DICT_PURE_METHODS.has(method)
  if (kind === "json") return JSON_PURE_METHODS.has(method)
  if (kind === "string") return STRING_PURE_METHODS.has(method)
  if (kind === "bytes") return BYTES_PURE_METHODS.has(method)
  if (kind === "bytearray") return BYTEARRAY_PURE_METHODS.has(method)
  if (kind === "memoryview") return MEMORYVIEW_PURE_METHODS.has(method)
  if (kind === "int") return INT_PURE_METHODS.has(method)
  if (kind === "float") return FLOAT_PURE_METHODS.has(method)
  if (kind === "complex") return COMPLEX_PURE_METHODS.has(method)
  if (kind === "match") return false
  return SET_PURE_METHODS.has(method)
}

function hasDictionarySplat(node: Node) {
  const input = node.childForFieldName("arguments")
  if (!input) return false
  return input.namedChildren.some((child) => child.type === "dictionary_splat")
}

function hasJsonCustomizers(node: Node, input: Args) {
  if (hasDictionarySplat(node)) return true
  return Array.from(JSON_CONTAINER_CUSTOMIZER_KEYWORDS).some((keyword) => keyword in input.keyword)
}

function classifyResponseJson(call: string, node: Node, input: Args, current: Scope): ResolvedEffect | undefined {
  if (tail(call) !== "json") return
  const parts = call.split(".")
  const instance = parts[0]
  if (!instance || parts.length !== 2 || !hasHttpResponseInstance(current, instance)) return
  if (input.positional.length === 0 && Object.keys(input.keyword).length === 0 && !hasDictionarySplat(node)) {
    return effect("pure.compute", { resolvedCall: call })
  }
  return effect("unknown", { resolvedCall: call, outwardCall: `${CALLABLE_UNKNOWN_PREFIX}${call}` })
}

function builtinPurityTarget(call: string) {
  if (EXACT_PURE_CALLS.has(call)) return call
  if (call === "dict.fromkeys") return "dict"
  if (SHADOW_GUARDED_PURE_BUILTINS.has(call)) return call
  if (STANDARD_EXCEPTION_BUILTINS.has(call)) return call
}

function builtinEffectTarget(call: string) {
  if (SHADOW_GUARDED_READ_BUILTINS.has(call)) return call
  if (SHADOW_GUARDED_EMIT_BUILTINS.has(call)) return call
  if (SHADOW_GUARDED_EXEC_BUILTINS.has(call)) return call
  if (call === "open") return call
  if (call === "compile" || call === "eval" || call === "exec" || call === "__import__") return call
  if (call === "print") return call
  if (call === "type") return call
}

function hasBuiltinPurityCustomizers(call: string, node: Node, input: Args) {
  if (hasDictionarySplat(node)) return KEY_CALLBACK_PURE_BUILTINS.has(call)
  return KEY_CALLBACK_PURE_BUILTINS.has(call) && "key" in input.keyword
}

function classifyBuiltinPureCall(call: string, node: Node, input: Args, current: Scope): ResolvedEffect | undefined {
  const target = builtinPurityTarget(call)
  if (!target) return
  if (hasBoundName(current, target)) {
    return effect("unknown", { resolvedCall: call, outwardCall: `${CALLABLE_UNKNOWN_PREFIX}${call}` })
  }
  if (hasBuiltinPurityCustomizers(call, node, input)) {
    return effect("unknown", { resolvedCall: call, outwardCall: `${CALLABLE_UNKNOWN_PREFIX}${call}` })
  }
  return effect("pure.compute", { resolvedCall: call })
}

function classifyBuiltinPureFallbackCall(call: string, node: Node, input: Args, current: Scope, rules: Rules): ResolvedEffect | undefined {
  if (rules.guarded.calls.some((rule) => rule.call === call && rule.effect === "pure.compute")) return
  return classifyBuiltinPureCall(call, node, input, current)
}

function classifyBuiltinEffectCall(call: string, node: Node, input: Args, current: Scope): ResolvedEffect | undefined {
  const target = builtinEffectTarget(call)
  if (!target) return
  if (hasBoundName(current, target)) {
    return effect("unknown", { resolvedCall: call, outwardCall: `${CALLABLE_UNKNOWN_PREFIX}${call}` })
  }

  if (call === "open") return classifyOpen(input)
  if (call === "input") return effect("fs.read", { resolvedCall: call })
  if (call === "help" || call === "print") return effect("emit.signal", { resolvedCall: call })
  if (call === "breakpoint" || call === "compile" || call === "eval" || call === "exec" || call === "__import__") {
    return effect("dynamic.exec", { resolvedCall: call })
  }
  if (call === "type") {
    if (input.positional.length === 1 && Object.keys(input.keyword).length === 0 && !hasDictionarySplat(node)) {
      return effect("pure.compute", { resolvedCall: call })
    }
    return effect("unknown", { resolvedCall: call, outwardCall: `${CALLABLE_UNKNOWN_PREFIX}${call}` })
  }
}

function raiseValue(node: Node) {
  return node.childForFieldName("value") ?? node.childForFieldName("exception") ?? node.namedChildren[0] ?? null
}

function classifyRaise(node: Node, current: Scope): ResolvedEffect | undefined {
  const value = raiseValue(node)
  if (!value) return

  if (value.type === "call") {
    const call = resolvedName(value.childForFieldName("function"), current)
    if (!call || !STANDARD_EXCEPTION_BUILTINS.has(call)) return
    return classifyBuiltinPureCall(call, value, args(value), current)
  }

  const call = resolvedName(value, current)
  if (!call || !STANDARD_EXCEPTION_BUILTINS.has(call)) return
  if (hasBoundName(current, call)) {
    return effect("unknown", { resolvedCall: call, outwardCall: `${CALLABLE_UNKNOWN_PREFIX}${call}` })
  }
  return effect("pure.compute", { resolvedCall: call })
}

function directTemporaryContainerKind(node: Node | null, current: Scope): ContainerKind | undefined {
  if (!node) return

  const directMatch = matchKind(node, current)
  if (directMatch) return directMatch
  const directBytes = bytesKind(node, current)
  if (directBytes) return directBytes
  const directString = stringKind(node, current)
  if (directString) return directString
  const directNumeric = numericKind(node, current)
  if (directNumeric) return directNumeric
  if (node.type !== "call") return
  const call = resolvedName(node.childForFieldName("function"), current)
  if (!call) return
  const input = args(node)

  if (call.endsWith("Path.read_text")) return "string"
  if (call.endsWith("Path.read_bytes")) return "bytes"

  if (call === "tuple" || call === "range" || call === "bytes" || call === "bytearray" || call === "memoryview" || call === "int" || call === "float" || call === "complex") {
    const effect = classifyBuiltinPureCall(call, node, input, current)
    if (effect?.atom === "pure.compute") return call
    return
  }

  if (call === "list" || call === "dict" || call === "set") {
    const effect = classifyBuiltinPureCall(call, node, input, current)
    if (effect?.atom === "pure.compute") return call
    return
  }

  if (call === "json.load") {
    if (hasJsonCustomizers(node, input)) return
    return "json"
  }

  if (call === "json.loads") {
    if (hasJsonCustomizers(node, input)) return
    return "json"
  }

  if (call === "next") {
    const effect = classifyBuiltinPureCall(call, node, input, current)
    if (effect?.atom !== "pure.compute") return
    const kind = containerKind(node, current)
    if (kind === "json") return "json"
    return
  }

  const effect = classifyResponseJson(call, node, input, current)
  if (effect?.atom === "pure.compute") return "json"
}

function trackedContainerKind(node: Node | null, current: Scope): ContainerKind | undefined {
  if (!node) return

  const directMatch = matchKind(node, current)
  if (directMatch) return directMatch
  const directBytes = bytesKind(node, current)
  if (directBytes) return directBytes
  const directString = stringKind(node, current)
  if (directString) return directString
  const directNumeric = numericKind(node, current)
  if (directNumeric) return directNumeric

  if (node.type === "boolean_operator") {
    const left = trackedContainerKind(node.childForFieldName("left"), current)
    const right = trackedContainerKind(node.childForFieldName("right"), current)
    if (left && right && left === right) return left
    if (left === "json" && (right === "dict" || right === "list")) return "json"
    if (right === "json" && (left === "dict" || left === "list")) return "json"
    if (left === "string" && right === "string") return "string"
    return
  }

  if (node.type === "call") {
    const guarded = directTemporaryContainerKind(node, current)
    if (guarded) return guarded

    const call = resolvedName(node.childForFieldName("function"), current)
    if (call) {
      const method = tail(call)
      if (call === "list" || call === "dict" || call === "set" || call === "json.load" || call === "json.loads" || call === "next" || method === "json") {
        return
      }
    }
  }

  return containerKind(node, current)
}

function trackedReceiverContainerKind(node: Node | null, current: Scope): ContainerKind | undefined {
  if (!node) return

  const temporary = directTemporaryContainerKind(node, current)
  if (temporary) return temporary
  return lookupTrackedReceiverContainerKind(current, node)
}

function returnedTrackedContainerKind(node: Node | null, current: Scope): ContainerKind | undefined {
  if (!node || node.type !== "call") return
  const fn = node.childForFieldName("function")
  if (fn?.type !== "attribute") return
  const call = resolvedName(fn, current)
  if (!call) return
  const method = tail(call)
  const receiver = fn.childForFieldName("object")
  const receiverKind = trackedReceiverContainerKind(receiver, current)
  if (receiverKind === "string" && STRING_RETURNING_METHODS.has(method)) return "string"
}

function generatorElementKind(node: Node | null, current: Scope): ContainerKind | undefined {
  if (!node || node.type !== "generator_expression") return
  const body = node.childForFieldName("body")
  const clause = node.namedChildren.find((child) => child.type === "for_in_clause")
  const target = clause?.childForFieldName("left")
  const source = clause?.childForFieldName("right")
  if (!body || body.type !== "identifier" || !target || target.type !== "identifier" || body.text !== target.text) return
  return iteratedContainerKind(source ?? null, current)
}

function rebindSource(node: Node) {
  if (node.type === "for_statement" || node.type === "async_for_statement" || node.type === "for_in_clause") {
    return node.childForFieldName("right")
  }
}

function iteratedPathValue(node: Node | null, current: Scope): Value | undefined {
  if (!node) return

  if (node.type === "identifier") {
    return iteratedPathInstance(current, node.text)
  }

  if (node.type === "subscript") {
    const value = node.childForFieldName("value")
    const base = iteratedPathValue(value, current)
    const subscript = value ? node.namedChildren.find((child) => child.startIndex > value.endIndex) : undefined
    if (base && (subscript?.type === "slice" || subscript?.text.includes(":"))) return { dynamic: true }
  }

  if (node.type === "list" || node.type === "tuple") {
    const items = node.namedChildren
    if (items.length > 0 && items.every((child) => trackedPathValue(child, current))) return { dynamic: true }
  }

  if (node.type !== "call") return
  const call = resolvedName(node.childForFieldName("function"), current)
  const fn = node.childForFieldName("function")
  const method = call ? tail(call) : undefined
  const receiver = fn?.type === "attribute" ? fn.childForFieldName("object") : null
  if (method && (method === "glob" || method === "iterdir" || method === "rglob") && trackedPathValue(receiver, current)) {
    return { dynamic: true }
  }
}

function iteratedContainerKind(node: Node | null, current: Scope): ContainerKind | undefined {
  if (node?.type === "identifier") {
    const iterated = iteratedElementInstance(current, node.text)
    if (iterated) return iterated
  }

  if (node?.type === "subscript") {
    const value = node.childForFieldName("value")
    const base = iteratedContainerKind(value, current)
    const subscript = value ? node.namedChildren.find((child) => child.startIndex > value.endIndex) : undefined
    if (base === "string" && (subscript?.type === "slice" || subscript?.text.includes(":"))) {
      return "string"
    }
  }

  if (node?.type === "call") {
    const call = resolvedName(node.childForFieldName("function"), current)
    const fn = node.childForFieldName("function")
    const method = call ? tail(call) : undefined
    const receiver = fn?.type === "attribute" ? fn.childForFieldName("object") : null
    if (method && STRING_ITERABLE_METHODS.has(method) && trackedContainerKind(receiver, current) === "string") {
      return "string"
    }
  }

  const kind = containerKind(node, current)
  if (kind === "json") return "json"
}

function enumeratedElementKind(node: Node | null, current: Scope): ContainerKind | undefined {
  if (!node || node.type !== "call") return
  const call = resolvedName(node.childForFieldName("function"), current)
  if (call !== "enumerate") return
  const effect = classifyBuiltinPureCall(call, node, args(node), current)
  if (effect?.atom !== "pure.compute") return
  const source = node.childForFieldName("arguments")?.namedChildren[0] ?? null
  return iteratedContainerKind(source, current)
}

function enumeratedPathValue(node: Node | null, current: Scope): Value | undefined {
  if (!node || node.type !== "call") return
  const call = resolvedName(node.childForFieldName("function"), current)
  if (call !== "enumerate") return
  const effect = classifyBuiltinPureCall(call, node, args(node), current)
  if (effect?.atom !== "pure.compute") return
  const source = node.childForFieldName("arguments")?.namedChildren[0] ?? null
  return iteratedPathValue(source, current)
}

function rebindContainerKinds(target: Node | null, source: Node | null, current: Scope) {
  if (!target) return [] as Array<{ name: string; kind: ContainerKind }>

  if (target.type === "identifier") {
    const kind = iteratedContainerKind(source, current)
    return kind ? [{ name: target.text, kind }] : []
  }

  if (!(ASSIGNMENT_CONTAINER_TYPES.has(target.type) || target.type.endsWith("_pattern"))) {
    return [] as Array<{ name: string; kind: ContainerKind }>
  }

  const kind = enumeratedElementKind(source, current)
  if (!kind) return [] as Array<{ name: string; kind: ContainerKind }>

  const second = target.namedChildren[1]
  if (!second) return [] as Array<{ name: string; kind: ContainerKind }>
  return assignedNames(second)
    .filter((name) => name !== "_")
    .map((name) => ({ name, kind }))
}

function rebindPathValues(target: Node | null, source: Node | null, current: Scope) {
  if (!target) return [] as Array<{ name: string; value: Value }>

  if (target.type === "identifier") {
    const value = iteratedPathValue(source, current)
    return value ? [{ name: target.text, value }] : []
  }

  if (!(ASSIGNMENT_CONTAINER_TYPES.has(target.type) || target.type.endsWith("_pattern"))) {
    return [] as Array<{ name: string; value: Value }>
  }

  const value = enumeratedPathValue(source, current)
  if (!value) return [] as Array<{ name: string; value: Value }>

  const second = target.namedChildren[1]
  if (!second) return [] as Array<{ name: string; value: Value }>
  return assignedNames(second)
    .filter((name) => name !== "_")
    .map((name) => ({ name, value }))
}

function aliasTarget(node: Node | null, current: Scope) {
  if (!node) return
  if (node.type !== "identifier" && node.type !== "attribute" && node.type !== "subscript") return
  return resolvedName(node, current)
}

function importBindings(node: Node) {
  if (node.type === "import_statement") {
    const match = node.text.match(/^\s*import\s+([\s\S]+)$/)
    if (!match) return [] as Array<{ name: string; target?: string; direct?: boolean }>
    return match[1]
      .replace(/[()]/g, "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [moduleName, alias] = part.split(/\s+as\s+/i).map((item) => item.trim())
        const name = alias || moduleName.split(".")[0] || moduleName
        return { name, target: alias ? moduleName : undefined, direct: false }
      })
  }

  if (node.type === "import_from_statement") {
    const match = node.text.match(/^\s*from\s+([^\s]+)\s+import\s+([\s\S]+)$/)
    if (!match) return [] as Array<{ name: string; target?: string; direct?: boolean }>
    const [, moduleName, names] = match
    return names
      .replace(/[()]/g, "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part) => part !== "*")
      .map((part) => {
        const [importedName, alias] = part.split(/\s+as\s+/i).map((item) => item.trim())
        const name = alias || importedName
        return { name, target: `${moduleName}.${importedName}`, direct: !alias }
      })
  }

  return [] as Array<{ name: string; target?: string; direct?: boolean }>
}

function shouldBindDirectImport(target: string, rules: Rules) {
  return (
    DIRECT_IMPORT_BINDINGS.has(target) ||
    HTTP_REQUEST_CALL_BASES.has(target) ||
    rules.calls.networkRead.has(target) ||
    rules.calls.networkWrite.has(target) ||
    rules.calls.networkExec.has(target) ||
    TRACKED_HTTP_CLIENT_CONSTRUCTORS.has(target)
  )
}

function httpRequestMethod(input: Args) {
  const method = pick(input, 0, ["method"])
  if (!method || method.dynamic || method.literal === undefined) return
  return HTTP_REQUEST_METHOD_SUFFIXES.get(method.literal.trim().toUpperCase())
}

function trackedHttpRequestBase(call: string, current: Scope) {
  const parts = call.split(".")
  const instance = parts[0]
  if (!instance || parts[parts.length - 1] !== "request") return
  const trackedHttpClient = httpClientInstance(current, instance)
  if (!trackedHttpClient || !HTTP_REQUEST_CALL_BASES.has(`${trackedHttpClient}.request`)) return
  const suffix = parts.slice(1).join(".")
  if (!TRACKED_HTTP_REQUEST_SUFFIXES.has(suffix)) return
  return trackedHttpClient
}

function hasGenericHttpRequestSuffix(call: string) {
  const parts = call.split(".")
  if (!parts[0]) return false
  return GENERIC_HTTP_REQUEST_SUFFIXES.has(parts.slice(1).join("."))
}

function isHttpResponseCall(call: string, node: Node, current: Scope, rules: Rules) {
  const input = args(node)
  const guardedRequest = classifyGuardedHttpRequest(call, node, input, current, rules)
  const requestEffect = guardedRequest.effect ?? classifyHttpRequestFallback(call, input)
  if (requestEffect && (requestEffect.atom === "network.read" || requestEffect.atom === "network.write")) {
    return true
  }

  const parts = call.split(".")
  const instance = parts[0]
  const method = tail(call)
  const trackedHttpClient = instance ? httpClientInstance(current, instance) : undefined
  if (trackedHttpClient && parts.length === 2) {
    const canonicalCall = `${trackedHttpClient}.${method}`
    if (rules.calls.networkRead.has(canonicalCall) || rules.calls.networkWrite.has(canonicalCall)) return true
  }

  return rules.calls.networkRead.has(call) || rules.calls.networkWrite.has(call)
}

function classifyHttpRequestFallback(call: string, input: Args): ResolvedEffect | undefined {
  if (!hasGenericHttpRequestSuffix(call)) return
  const method = httpRequestMethod(input)
  if (!method) return
  if (method === "get" || method === "head" || method === "options") {
    return effect("network.read", { resolvedCall: call })
  }
  if (method === "post" || method === "put" || method === "patch" || method === "delete") {
    return effect("network.write", { resolvedCall: call })
  }
}

function classifyGuardedHttpRequest(
  call: string,
  node: Node,
  input: Args,
  current: Scope,
  rules: Rules,
): { effect?: ResolvedEffect; guardFailure?: PythonEventEvidence } {
  const method = httpRequestMethod(input)
  if (!method) return {}
  let firstFailure: PythonEventEvidence | undefined

  const directBase = HTTP_REQUEST_CALL_BASES.get(call) ?? trackedHttpRequestBase(call, current)
  if (directBase) {
    const requestCall = `${directBase}.request`
    for (const rule of rules.guarded.calls) {
      if (rule.call !== requestCall) continue
      const guarded = guardedCallEffect(rule, input, node, current, call, `${directBase}.${method}`)
      if (guarded.effect) return guarded
      firstFailure ??= guarded.guardFailure
    }
  }
  return { guardFailure: firstFailure }
}

function lookupCallableFactory(current: Scope, key: string) {
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const value = scope.callableFactories.get(key)
    if (value) return value
  }
}

function callableFactory(node: Node) {
  if (node.type !== "function_definition") return
  const name = node.childForFieldName("name")?.text
  if (!name) return

  const parameters = node.childForFieldName("parameters")
  if (parameters && parameters.namedChildren.length > 0) return

  const body = node.childForFieldName("body")
  if (!body || body.namedChildren.length !== 1) return

  const statement = body.namedChildren[0]
  if (!statement || statement.type !== "return_statement") return

  const returned = statement.childForFieldName("value") ?? statement.namedChildren[0]
  if (!returned) return
  if (returned.type !== "identifier" && returned.type !== "attribute") return
  return { name, returned }
}

function callableFactoryTarget(node: Node | null, current: Scope) {
  if (!node || node.type !== "call") return
  const input = args(node)
  if (input.positional.length > 0) return
  if (Object.keys(input.keyword).length > 0) return

  const call = resolvedName(node.childForFieldName("function"), current)
  if (!call) return

  const returned = lookupCallableFactory(current, call)
  if (!returned) return
  return aliasTarget(returned, current)
}

function assignmentLeft(node: Node) {
  return node.childForFieldName("left") ?? node.childForFieldName("name")
}

function assignmentRight(node: Node) {
  return node.childForFieldName("right") ?? node.childForFieldName("value")
}

function assignedNames(node: Node | null): string[] {
  if (!node) return []
  if (node.type === "identifier") return [node.text]
  if (node.type === "as_pattern_target") return node.namedChildren.flatMap((child) => assignedNames(child))
  if (ASSIGNMENT_CONTAINER_TYPES.has(node.type) || node.type.endsWith("_pattern")) {
    return node.namedChildren.flatMap((child) => assignedNames(child))
  }
  return []
}

function parameterNames(node: Node | null): string[] {
  if (!node) return []
  const name = node.childForFieldName("name")
  if (name?.type === "identifier") return [name.text]
  if (node.type === "identifier") return [node.text]
  return node.namedChildren.flatMap((child) => parameterNames(child))
}

function rebindTarget(node: Node) {
  if (node.type === "for_statement" || node.type === "async_for_statement" || node.type === "for_in_clause") {
    return node.childForFieldName("left")
  }

  if (node.type === "with_item" || node.type === "except_clause") {
    const value = node.childForFieldName("value")
    if (!value || value.type !== "as_pattern") return
    return value.childForFieldName("alias")
  }
}

function definitionNode(node: Node) {
  if (node.type === "function_definition" || node.type === "class_definition") return node
  if (node.type !== "decorated_definition") return
  return node.namedChildren.find((child) => child.type === "function_definition" || child.type === "class_definition")
}

function definitionName(node: Node) {
  return definitionNode(node)?.childForFieldName("name")?.text
}

function pushEntry(
  entries: TimelineEntry[],
  kind: TimelineEntry["kind"],
  node: Node,
  scope: Scope,
  startIndex = node.startIndex,
  endIndex = node.endIndex,
) {
  entries.push({ kind, node, scope, startIndex, endIndex })
}

function collectTimeline(node: Node, current: Scope, entries: TimelineEntry[], decorated = false) {
  if (node.type === "assignment" || node.type === "augmented_assignment" || node.type === "named_expression") {
    const right = assignmentRight(node)
    pushEntry(entries, "assignment", node, current, right?.endIndex ?? node.startIndex, node.endIndex)
  } else if (node.type === "call") {
    pushEntry(entries, "call", node, current)
  } else if (node.type === "raise_statement") {
    pushEntry(entries, "raise", node, current)
  } else if ((node.type === "function_definition" || node.type === "class_definition") && !decorated) {
    pushEntry(entries, "definition", node, current)
  } else if (node.type === "import_statement" || node.type === "import_from_statement") {
    pushEntry(entries, "import", node, current)
  } else if (node.type === "for_statement" || node.type === "async_for_statement") {
    const right = node.childForFieldName("right")
    const body = node.childForFieldName("body")
    pushEntry(entries, "rebind", node, current, right?.endIndex ?? node.startIndex, body?.startIndex ?? node.endIndex)
  } else if (node.type === "for_in_clause") {
    const right = node.childForFieldName("right")
    pushEntry(entries, "rebind", node, current, right?.endIndex ?? node.startIndex, node.endIndex)
  } else if (node.type === "with_item") {
    pushEntry(entries, "rebind", node, current, node.endIndex, node.endIndex)
  } else if (node.type === "except_clause") {
    const value = node.childForFieldName("value")
    const body = node.namedChildren[node.namedChildren.length - 1]
    pushEntry(entries, "rebind", node, current, value?.endIndex ?? node.endIndex, body?.startIndex ?? node.endIndex)
  }

  if (node.type === "decorated_definition") {
    const inner = definitionNode(node)
    if (inner) pushEntry(entries, "definition", node, current, inner.startIndex, inner.endIndex)
    for (const child of node.namedChildren) collectTimeline(child, current, entries, true)
    return
  }

  if (BODY_SCOPE_TYPES.has(node.type)) {
    const body = node.childForFieldName("body")
    const inner = scope(current)
    if (node.type === "function_definition" || node.type === "lambda") {
      for (const name of parameterNames(node.childForFieldName("parameters"))) invalidateTrackedName(inner, name)
    }
    for (const child of node.namedChildren) {
      const inBody =
        !!body && child.type === body.type && child.startIndex === body.startIndex && child.endIndex === body.endIndex
      collectTimeline(child, inBody ? inner : current, entries, decorated)
    }
    return
  }

  if (COMPREHENSION_SCOPE_TYPES.has(node.type)) {
    const inner = scope(current)
    const body = node.childForFieldName("body")
    const isBody = (child: Node) =>
      !!body && child.type === body.type && child.startIndex === body.startIndex && child.endIndex === body.endIndex

    for (const child of node.namedChildren) {
      if (isBody(child)) continue
      if (child.type === "for_in_clause") {
        const right = child.childForFieldName("right")
        if (right) collectTimeline(right, inner, entries, decorated)
        pushEntry(entries, "rebind", child, inner, right?.endIndex ?? child.startIndex, child.endIndex)
        for (const name of assignedNames(child.childForFieldName("left"))) invalidateTrackedName(inner, name)
        continue
      }
      collectTimeline(child, inner, entries, decorated)
    }

    if (body) collectTimeline(body, inner, entries, decorated)
    return
  }

  for (const child of node.namedChildren) collectTimeline(child, current, entries, decorated)
}

function pathFromPathMethod(node: Node | null, current: Scope): Value | undefined {
  if (!node || node.type !== "attribute") return
  const object = node.childForFieldName("object")
  return trackedPathValue(object, current)
}

function canonicalPathMethodCall(method: string) {
  return `pathlib.Path.${method}`
}

function effect(atom: ResolvedEffectAtom, input: Omit<ResolvedEffect, "atom"> = {}): ResolvedEffect {
  return { atom, ...input }
}

function pathEffect(
  atom: "fs.read" | "fs.write",
  resolvedCall: string,
  path?: Value,
  input: Omit<ResolvedEffect, "atom" | "resolvedCall" | "path"> = {},
): ResolvedEffect {
  return effect(atom, { resolvedCall, path, ...input })
}

function foldResolvedEffect(input: ResolvedEffect): PythonEvent {
  const kind = EFFECT_KIND[input.atom]
  const call = input.outwardCall ?? input.canonicalCall ?? input.resolvedCall ?? "dynamic-call"
  const sourceCall = input.canonicalCall && input.canonicalCall !== call ? input.canonicalCall : undefined
  const evidence = input.evidence
  const withEvidence = <T extends PythonEvent>(event: T): T => (evidence ? { ...event, evidence } : event)
  if ((kind === "read" || kind === "write") && input.path) {
    if (input.path.dynamic || input.path.literal === undefined) {
      return sourceCall ? withEvidence({ kind, call, sourceCall, dynamicPath: true }) : withEvidence({ kind, call, dynamicPath: true })
    }
    return sourceCall ? withEvidence({ kind, call, sourceCall, path: input.path.literal }) : withEvidence({ kind, call, path: input.path.literal })
  }
  return sourceCall ? withEvidence({ kind, call, sourceCall }) : withEvidence({ kind, call })
}

function classifyOpen(input: Args): ResolvedEffect {
  const file = pick(input, 0, ["file", "path"])
  const mode = pick(input, 1, ["mode"])
  if (!mode) return pathEffect("fs.read", "open", file)
  if (mode.dynamic || mode.literal === undefined) return effect("unknown", { resolvedCall: "open", outwardCall: "open-mode-dynamic" })
  if (/[wax+]/.test(mode.literal)) return pathEffect("fs.write", "open", file)
  return pathEffect("fs.read", "open", file)
}

function receiverEvidence(receiverKind?: ReceiverKind, dependencySignature?: string[], explain: string[] = []): PythonEventEvidence | undefined {
  if (!receiverKind && (!dependencySignature || dependencySignature.length === 0) && explain.length === 0) return
  return {
    receiverKind,
    dependencySignature: dependencySignature && dependencySignature.length ? dependencySignature : undefined,
    explain: explain.length ? explain : undefined,
  }
}

function guardedCallEffect(
  rule: GuardedCallRule,
  input: Args,
  node: Node,
  current: Scope,
  resolvedCall = rule.call,
  canonicalCall?: string,
): { effect?: ResolvedEffect; guardFailure?: PythonEventEvidence } {
  const evaluation = evaluateGuardsDetailed(rule.guards, {
    keywordNames: new Set(Object.keys(input.keyword)),
    hasKwargSplat: hasDictionarySplat(node),
    hasBoundName: (name) => hasBoundName(current, name),
    pickLiteral: (index, names) => pick(input, index, names)?.literal,
  })
  if (!evaluation.matched) {
    return {
      guardFailure: {
        guardFailure: evaluation.failure,
        explain: [`guarded-call:${rule.call}`],
      },
    }
  }
  return {
    effect: effect(rule.effect, {
      resolvedCall,
      canonicalCall,
      evidence: {
        explain: [`guarded-call:${rule.call}`],
      },
    }),
  }
}

function guardedMethodEffect(
  rule: GuardedMethodRule,
  input: Args,
  node: Node,
  call: string,
  method: string,
  pathMethod: Value | undefined,
  pathSourceCall: string | undefined,
  trackedReceiverKind: ContainerKind | undefined,
  dependencySignature?: string[],
): { effect?: ResolvedEffect; guardFailure?: PythonEventEvidence } {
  const receiverKind = pathMethod ? "path" : trackedReceiverKind === "match" ? "match" : undefined
  const evaluation = evaluateGuardsDetailed(rule.guards, {
    receiverKind,
    keywordNames: new Set(Object.keys(input.keyword)),
    hasKwargSplat: hasDictionarySplat(node),
  })
  if (!evaluation.matched) {
    return {
      guardFailure: {
        ...receiverEvidence(receiverKind, dependencySignature, [`guarded-method:${rule.method}`]),
        guardFailure: evaluation.failure,
      },
    }
  }

  const evidence = receiverEvidence(receiverKind, dependencySignature, [`guarded-method:${rule.method}`])

  if ((rule.effect === "fs.read" || rule.effect === "fs.write") && pathMethod) {
    return { effect: pathEffect(rule.effect, call, pathMethod, { outwardCall: call, canonicalCall: pathSourceCall, evidence }) }
  }

  return {
    effect: effect(rule.effect, {
      resolvedCall: call,
      outwardCall: pathMethod && pathSourceCall ? call : undefined,
      canonicalCall: pathMethod ? pathSourceCall : undefined,
      evidence,
    }),
  }
}

function classify(
  node: Node,
  rules: Rules,
  hasAtlassianImportProvenance: boolean,
  current: Scope,
): ResolvedEffect | undefined {
  const fn = node.childForFieldName("function")
  const call = resolvedName(fn, current)
  if (!call) return effect("unknown", { outwardCall: "dynamic-call" })

  const input = args(node)
  let guardFailureEvidence: PythonEventEvidence | undefined
  const builtinEffect = classifyBuiltinEffectCall(call, node, input, current)
  if (builtinEffect) return builtinEffect
  for (const guardedCall of rules.guarded.calls) {
    if (guardedCall.call !== call || guardedCall.call.endsWith(".request")) continue
    const guarded = guardedCallEffect(guardedCall, input, node, current)
    if (guarded.effect) return guarded.effect
    guardFailureEvidence ??= guarded.guardFailure
  }
  const responseJsonEffect = classifyResponseJson(call, node, input, current)
  if (responseJsonEffect) return responseJsonEffect
  const guardedRequest = classifyGuardedHttpRequest(call, node, input, current, rules)
  if (guardedRequest.effect) return guardedRequest.effect
  guardFailureEvidence ??= guardedRequest.guardFailure
  const requestEffect = classifyHttpRequestFallback(call, input)
  if (requestEffect) return requestEffect
  const builtinPureEffect = classifyBuiltinPureFallbackCall(call, node, input, current, rules)
  if (builtinPureEffect) return builtinPureEffect

  const method = tail(call)
  const temporaryReceiver = fn?.type === "attribute" ? fn.childForFieldName("object") : null
  const pathMethod = pathFromPathMethod(fn, current)
  const pathSourceCall = call.startsWith("Path.") || call.startsWith("pathlib.Path.") ? undefined : canonicalPathMethodCall(method)
  if (pathMethod && PATH_PURE_METHODS.has(method)) {
    return effect("pure.compute", { resolvedCall: call, outwardCall: call, canonicalCall: pathSourceCall })
  }
  const temporaryContainer = directTemporaryContainerKind(temporaryReceiver, current)
  if (temporaryContainer && pureContainerMethod(temporaryContainer, method)) {
    return effect("pure.compute", { resolvedCall: call })
  }

  const trackedReceiverContainer = trackedReceiverContainerKind(temporaryReceiver, current)
  const trackedReceiverInfo = trackableReceiverInfo(temporaryReceiver)
  const dependencySignature = trackedReceiverInfo ? current.receiverContainers.get(trackedReceiverInfo.path)?.deps : undefined
  if (trackedReceiverContainer && pureContainerMethod(trackedReceiverContainer, method)) {
    return effect("pure.compute", { resolvedCall: call })
  }
  for (const guardedMethod of rules.guarded.methods) {
    if (guardedMethod.method !== method) continue
    const guarded = guardedMethodEffect(
      guardedMethod,
      input,
      node,
      call,
      method,
      pathMethod,
      pathSourceCall,
      trackedReceiverContainer,
      dependencySignature,
    )
    if (guarded.effect) return guarded.effect
    guardFailureEvidence ??= guarded.guardFailure
  }

  const parts = call.split(".")
  const instance = parts[0]
  const localContainerName =
    trackableSelfAttributePath(temporaryReceiver) ??
    (temporaryReceiver?.type === "identifier" ? temporaryReceiver.text : instance && parts.length === 1 ? instance : undefined)
  const localContainer =
    localContainerName && trackedReceiverContainer
      ? trackedReceiverContainer
      : localContainerName
        ? containerInstance(current, localContainerName)
        : undefined
  if (localContainer && pureContainerMethod(localContainer, method)) {
    return effect("pure.compute", { resolvedCall: call })
  }
  if (rules.methods.emit.has(method)) return effect("emit.signal", { resolvedCall: call })
  if (rules.methods.pure.has(method)) return effect("pure.compute", { resolvedCall: call })
  const trackedHttpClient = instance ? httpClientInstance(current, instance) : undefined
  if (trackedHttpClient && parts.length === 2) {
    const canonicalCall = `${trackedHttpClient}.${method}`
    if (rules.calls.networkRead.has(canonicalCall)) {
      return effect("network.read", { resolvedCall: call, canonicalCall })
    }
    if (rules.calls.networkWrite.has(canonicalCall)) {
      return effect("network.write", { resolvedCall: call, canonicalCall })
    }
  }

  const readSpec = rules.pathCalls.read[call]
  if (readSpec) return pathEffect("fs.read", call, pick(input, readSpec.index, readSpec.names))

  const writeSpec = rules.pathCalls.write[call]
  if (writeSpec) return pathEffect("fs.write", call, pick(input, writeSpec.index, writeSpec.names))

  if (rules.calls.read.has(call)) return effect("fs.read", { resolvedCall: call })
  if (rules.calls.write.has(call)) return effect("fs.write", { resolvedCall: call })
  if (rules.sdk.ghapi.writeCalls.has(call)) return effect("fs.write", { resolvedCall: call })
  if (rules.calls.tempfileWrite.has(call)) return effect("fs.write", { resolvedCall: call })

  if (call === "os.popen" || call === "os.system") return effect("process.exec", { resolvedCall: call })
  if (rules.calls.exec.has(call)) return effect("dynamic.exec", { resolvedCall: call })
  if (rules.calls.networkRead.has(call)) return effect("network.read", { resolvedCall: call })
  if (rules.calls.networkWrite.has(call)) return effect("network.write", { resolvedCall: call })
  if (rules.calls.networkExec.has(call)) return effect("network.exec", { resolvedCall: call })
  if (rules.calls.dbExec.has(call)) return effect("db.exec", { resolvedCall: call })
  if (rules.calls.dangerousDeserializeExec.has(call)) return effect("dynamic.exec", { resolvedCall: call })
  if (rules.sdk.oci.execCalls.has(call)) return effect("network.exec", { resolvedCall: call })
  if (rules.sdk.ghapi.execCalls.has(call)) return effect("network.exec", { resolvedCall: call })
  if (isAtlassianConstructorCall(call, rules, hasAtlassianImportProvenance)) return effect("network.exec", { resolvedCall: call })
  if (rules.sdk.oci.clientMethodPrefixes.some((prefix) => call.startsWith(prefix))) {
    return effect("network.exec", { resolvedCall: call })
  }

  if (instance && hasGhapiInstance(current, instance) && parts.length >= 3) {
    return effect("network.exec", {
      resolvedCall: call,
      canonicalCall: `ghapi.${parts[1]}.${parts[2]}`,
    })
  }

  const atlassianClient = instance ? atlassianInstance(current, instance) : undefined
  if (atlassianClient && parts.length >= 2) {
    const method = parts[1]
    if (rules.sdk.atlassian.clientMethods[atlassianClient].has(method)) {
      return effect("network.exec", {
        resolvedCall: call,
        canonicalCall: `atlassian.${atlassianClient}.${method}`,
      })
    }
  }

  if (call.startsWith("subprocess.")) return effect("process.exec", { resolvedCall: call })
  if (call.startsWith("os.exec")) return effect("process.exec", { resolvedCall: call })

  if (rules.calls.emit.has(call)) return effect("emit.signal", { resolvedCall: call })
  if (rules.calls.pure.has(call)) return effect("pure.compute", { resolvedCall: call })

  return effect("unknown", { resolvedCall: call, outwardCall: `${CALLABLE_UNKNOWN_PREFIX}${call}`, evidence: guardFailureEvidence })
}

function isAtlassianImportStatement(node: Node) {
  if (node.type === "import_from_statement") {
    return /^\s*from\s+atlassian(?:\.|\s)/.test(node.text)
  }

  if (node.type === "import_statement") {
    const match = node.text.match(/^\s*import\s+([\s\S]+)$/)
    if (!match) return false
    const modules = match[1].split(",")
    return modules.some((part) => {
      const moduleName = part.trim().split(/\s+as\s+/i)[0]?.trim()
      if (!moduleName) return false
      return moduleName === "atlassian" || moduleName.startsWith("atlassian.")
    })
  }

  return false
}

function isAtlassianConstructorCall(call: string, rules: Rules, hasAtlassianImportProvenance: boolean) {
  const metadata = rules.sdk.atlassian.constructorMetadata.get(call)
  if (!metadata) return false
  if (!metadata.bare) return true
  return hasAtlassianImportProvenance
}

function atlassianFamilyForConstructor(call: string, rules: Rules, hasAtlassianImportProvenance: boolean) {
  const metadata = rules.sdk.atlassian.constructorMetadata.get(call)
  if (!metadata) return
  if (metadata.bare && !hasAtlassianImportProvenance) return
  return metadata.family
}

function analysisResult(metadata: ReturnType<typeof analyzerMetadata>, events: PythonEvent[]): PythonAnalyzeResult {
  return {
    events,
    analyzerVersion: metadata.analyzerVersion,
    engineVersion: metadata.engineVersion,
  }
}

export async function analyzeDetailed(source: string): Promise<PythonAnalyzeResult> {
  const metadata = analyzerMetadata()
  if (!source.trim()) return analysisResult(metadata, [{ kind: "unknown", call: "empty-source" }] satisfies PythonEvent[])

  let tree: Tree | null = null
  const rules = await loadRules()

  try {
    const frontend = await getFrontend()
    tree = frontend.parse(source)
  } catch {
    return analysisResult(metadata, [{ kind: "unknown", call: "parse-error" }] satisfies PythonEvent[])
  }

  if (!tree) return analysisResult(metadata, [{ kind: "unknown", call: "parse-error" }] satisfies PythonEvent[])
  if (tree.rootNode.hasError) return analysisResult(metadata, [{ kind: "unknown", call: "parse-error" }] satisfies PythonEvent[])

  const hasAtlassianImportProvenance =
    tree.rootNode.descendantsOfType("import_statement").some(isAtlassianImportStatement) ||
    tree.rootNode.descendantsOfType("import_from_statement").some(isAtlassianImportStatement)

  const calls = tree.rootNode.descendantsOfType("call")

  const timeline: TimelineEntry[] = []
  const rootScope = scope()
  collectTimeline(tree.rootNode, rootScope, timeline)
  timeline.sort((a, b) => {
    if (a.startIndex === b.startIndex) return a.endIndex - b.endIndex
    return a.startIndex - b.startIndex
  })

  const events: PythonEvent[] = []
  for (const entry of timeline) {
    if (entry.kind === "import") {
      for (const binding of importBindings(entry.node)) {
        invalidateTrackedName(entry.scope, binding.name)
        if (binding.target && (!binding.direct || shouldBindDirectImport(binding.target, rules))) {
          entry.scope.bindings.set(binding.name, binding.target)
        }
      }
      continue
    }

    if (entry.kind === "definition") {
      const name = definitionName(entry.node)
      if (name) invalidateTrackedName(entry.scope, name)
      const summary = callableFactory(entry.node)
      if (summary) entry.scope.callableFactories.set(summary.name, summary.returned)
      continue
    }

    if (entry.kind === "rebind") {
      const target = rebindTarget(entry.node)
      const names = assignedNames(target ?? null)
      for (const targetName of names) invalidateTrackedName(entry.scope, targetName)
      for (const seeded of rebindPathValues(target ?? null, rebindSource(entry.node) ?? null, entry.scope)) {
        entry.scope.pathInstances.set(seeded.name, seeded.value)
      }
      for (const seeded of rebindContainerKinds(target ?? null, rebindSource(entry.node) ?? null, entry.scope)) {
        entry.scope.containerInstances.set(seeded.name, seeded.kind)
      }
      continue
    }

    if (entry.kind === "assignment") {
      const left = assignmentLeft(entry.node)
      const right = assignmentRight(entry.node)
      const factoryTarget = callableFactoryTarget(right, entry.scope)
      const localPath = trackedPathValue(right, entry.scope)
      const iteratedPath = iteratedPathValue(right, entry.scope)
      const localContainer = trackedContainerKind(right, entry.scope) ?? returnedTrackedContainerKind(right, entry.scope)
      const iteratedElement = iteratedContainerKind(right, entry.scope)
      const target = aliasTarget(right, entry.scope)
      const assignedCall = right?.type === "call" ? resolvedName(right.childForFieldName("function"), entry.scope) : undefined
      const invalidations = trackableInvalidationDeps(left, assignedNames)
      for (const targetName of assignedNames(left)) invalidateTrackedName(entry.scope, targetName)
      clearReceiverDeps(entry.scope, invalidations)
      if (applyAssignmentProvenance(entry.scope, left, localContainer)) {
        continue
      }
      if (!left || left.type !== "identifier") continue

      if (entry.node.type !== "assignment") continue

      if (factoryTarget) {
        entry.scope.bindings.set(left.text, factoryTarget)
        continue
      }

      if (localPath) {
        entry.scope.pathInstances.set(left.text, localPath)
      }

      if (iteratedPath) {
        entry.scope.iteratedPathInstances.set(left.text, iteratedPath)
      }

      if (localContainer) {
        entry.scope.containerInstances.set(left.text, localContainer)
        continue
      }

      if (iteratedElement) {
        entry.scope.iteratedElementInstances.set(left.text, iteratedElement)
      }

      if (target) {
        entry.scope.bindings.set(left.text, target)
        continue
      }

      if (!right || right.type !== "call" || !assignedCall) {
        continue
      }

      if (isHttpResponseCall(assignedCall, right, entry.scope, rules)) {
        entry.scope.httpResponseInstances.add(left.text)
      }

      if (rules.sdk.ghapi.instanceConstructors.has(assignedCall)) {
        entry.scope.ghapiInstances.add(left.text)
      }

      if (TRACKED_HTTP_CLIENT_CONSTRUCTORS.has(assignedCall)) {
        entry.scope.httpClientInstances.set(left.text, assignedCall)
      }

      const atlassianClient = atlassianFamilyForConstructor(assignedCall, rules, hasAtlassianImportProvenance)
      if (atlassianClient) {
        entry.scope.atlassianInstances.set(left.text, atlassianClient)
      }

      continue
    }

    if (entry.kind === "raise") {
      const resolved = classifyRaise(entry.node, entry.scope)
      if (resolved) events.push(foldResolvedEffect(resolved))
      continue
    }

    const resolved = classify(entry.node, rules, hasAtlassianImportProvenance, entry.scope)
    if (resolved) events.push(foldResolvedEffect(resolved))
  }

  if (events.length) return analysisResult(metadata, unique(events))
  if (calls.length) return analysisResult(metadata, [{ kind: "unknown", call: "no-classified-call" }] satisfies PythonEvent[])
  return analysisResult(metadata, [{ kind: "unknown", call: "no-calls-detected" }] satisfies PythonEvent[])
}

export async function analyze(source: string) {
  return (await analyzeDetailed(source)).events.map(({ evidence: _evidence, ...event }) => event)
}
