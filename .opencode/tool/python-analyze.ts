import { fileURLToPath } from "url"

type Node = {
  type: string
  text: string
  hasError: boolean
  namedChildren: Node[]
  childForFieldName(name: string): Node | null
  descendantsOfType(type: string): Node[]
}

type Tree = {
  rootNode: Node
}

type Parser = {
  parse(input: string): Tree | null
  setLanguage(language: unknown): void
}

type ParserCtor = {
  new (): Parser
  init(input: { locateFile(): string }): Promise<void>
}

type LanguageCtor = {
  load(input: string): Promise<unknown>
}

type Value = {
  literal?: string
  dynamic: boolean
}

type Args = {
  positional: Value[]
  keyword: Record<string, Value>
}

export type PythonEventKind = "read" | "write" | "exec" | "unknown"

export type PythonEvent = {
  kind: PythonEventKind
  call: string
  path?: string
  dynamicPath?: boolean
}

const CALLABLE_UNKNOWN_PREFIX = "callable:"

const READ_METHODS = new Set(["read_text", "read_bytes"])
const WRITE_METHODS = new Set([
  "append_text",
  "mkdir",
  "rename",
  "replace",
  "rmdir",
  "touch",
  "unlink",
  "write_bytes",
  "write_text",
])

const WRITE_PATH_CALLS: Record<string, { index: number; names: string[] }> = {
  "os.makedirs": { index: 0, names: ["name", "path"] },
  "os.remove": { index: 0, names: ["path"] },
  "os.rename": { index: 1, names: ["dst", "dst_dir_fd"] },
  "os.replace": { index: 1, names: ["dst", "dst_dir_fd"] },
  "os.unlink": { index: 0, names: ["path"] },
  "shutil.copy": { index: 1, names: ["dst"] },
  "shutil.copy2": { index: 1, names: ["dst"] },
  "shutil.copytree": { index: 1, names: ["dst"] },
  "shutil.move": { index: 1, names: ["dst"] },
  "shutil.rmtree": { index: 0, names: ["path"] },
}

const READ_CALLS = new Set(["json.load", "yaml.load", "yaml.safe_load"])
const WRITE_CALLS = new Set(["json.dump", "yaml.dump", "yaml.safe_dump"])
const EXEC_CALLS = new Set(["__import__", "compile", "eval", "exec", "os.popen", "os.system"])
const NETWORK_EXEC_CALLS = new Set([
  "requests.get",
  "requests.post",
  "requests.put",
  "requests.delete",
  "requests.patch",
  "requests.head",
  "requests.options",
  "urllib.request.urlopen",
  "urllib.request.urlretrieve",
  "http.client.HTTPConnection",
  "http.client.HTTPSConnection",
  "aiohttp.ClientSession",
  "httpx.get",
  "httpx.post",
  "httpx.put",
  "httpx.delete",
  "httpx.patch",
  "httpx.Client",
  "httpx.AsyncClient",
  "socket.socket",
  "socket.create_connection",
])
const DB_EXEC_CALLS = new Set([
  "sqlite3.connect",
  "psycopg2.connect",
  "pymysql.connect",
  "sqlalchemy.create_engine",
])
const TEMPFILE_WRITE_CALLS = new Set([
  "tempfile.NamedTemporaryFile",
  "tempfile.mkdtemp",
  "tempfile.mkstemp",
  "tempfile.TemporaryDirectory",
])
const DANGEROUS_DESERIALIZE_EXEC_CALLS = new Set([
  "pickle.load",
  "pickle.loads",
  "marshal.load",
  "marshal.loads",
])

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

let parser: Promise<Parser> | undefined

async function initParser() {
  const tree = (await import("web-tree-sitter")) as unknown as {
    Parser: ParserCtor
    Language: LanguageCtor
  }
  const treeWasm = (await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })) as { default: string }
  await tree.Parser.init({
    locateFile() {
      return resolveWasm(treeWasm.default)
    },
  })
  const pythonWasm = (await import("tree-sitter-python/tree-sitter-python.wasm" as string, {
    with: { type: "wasm" },
  })) as { default: string }
  const language = await tree.Language.load(resolveWasm(pythonWasm.default))
  const result = new tree.Parser()
  result.setLanguage(language)
  return result
}

async function getParser() {
  if (parser) return parser
  parser = initParser()
  return parser
}

function unique(input: PythonEvent[]) {
  const result = new Map<string, PythonEvent>()
  for (const item of input) {
    const key = [item.kind, item.call, item.path ?? "<dynamic>", item.dynamicPath ? "1" : "0"].join("|")
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
  const keyword: Record<string, Value> = {}
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

function pathFromPathMethod(node: Node | null): Value | undefined {
  if (!node || node.type !== "attribute") return
  const object = node.childForFieldName("object")
  if (!object || object.type !== "call") return { dynamic: true }
  const objectName = name(object.childForFieldName("function"))
  if (!objectName || !objectName.endsWith("Path")) return { dynamic: true }
  return pick(args(object), 0, ["path"]) ?? { dynamic: true }
}

function pathEvent(kind: "read" | "write", call: string, input?: Value): PythonEvent {
  if (!input) return { kind, call }
  if (input.dynamic || input.literal === undefined) return { kind, call, dynamicPath: true }
  return { kind, call, path: input.literal }
}

function classifyOpen(input: Args): PythonEvent {
  const file = pick(input, 0, ["file", "path"])
  const mode = pick(input, 1, ["mode"])
  if (!mode) return pathEvent("read", "open", file)
  if (mode.dynamic || mode.literal === undefined) return { kind: "unknown", call: "open-mode-dynamic" }
  if (/[wax+]/.test(mode.literal)) return pathEvent("write", "open", file)
  return pathEvent("read", "open", file)
}

function classify(node: Node): PythonEvent | undefined {
  const fn = node.childForFieldName("function")
  const call = name(fn)
  if (!call) return { kind: "unknown", call: "dynamic-call" }

  const input = args(node)
  if (call === "open") return classifyOpen(input)

  const method = tail(call)
  if (READ_METHODS.has(method)) return pathEvent("read", call, pathFromPathMethod(fn))
  if (WRITE_METHODS.has(method)) return pathEvent("write", call, pathFromPathMethod(fn))

  const writeSpec = WRITE_PATH_CALLS[call]
  if (writeSpec) return pathEvent("write", call, pick(input, writeSpec.index, writeSpec.names))

  if (READ_CALLS.has(call)) return { kind: "read", call }
  if (WRITE_CALLS.has(call)) return { kind: "write", call }
  if (TEMPFILE_WRITE_CALLS.has(call)) return { kind: "write", call }

  if (EXEC_CALLS.has(call)) return { kind: "exec", call }
  if (NETWORK_EXEC_CALLS.has(call)) return { kind: "exec", call }
  if (DB_EXEC_CALLS.has(call)) return { kind: "exec", call }
  if (DANGEROUS_DESERIALIZE_EXEC_CALLS.has(call)) return { kind: "exec", call }
  if (call.startsWith("subprocess.")) return { kind: "exec", call }
  if (call.startsWith("os.exec")) return { kind: "exec", call }

  return { kind: "unknown", call: `${CALLABLE_UNKNOWN_PREFIX}${call}` }
}

export async function analyze(source: string) {
  if (!source.trim()) return [{ kind: "unknown", call: "empty-source" }] satisfies PythonEvent[]

  let tree: Tree | null = null

  try {
    const p = await getParser()
    tree = p.parse(source)
  } catch {
    return [{ kind: "unknown", call: "parse-error" }] satisfies PythonEvent[]
  }

  if (!tree) return [{ kind: "unknown", call: "parse-error" }] satisfies PythonEvent[]
  if (tree.rootNode.hasError) return [{ kind: "unknown", call: "parse-error" }] satisfies PythonEvent[]

  const calls = tree.rootNode.descendantsOfType("call")
  const events = calls.map((call) => classify(call)).filter((item): item is PythonEvent => item !== undefined)

  if (events.length) return unique(events)
  if (calls.length) return [{ kind: "unknown", call: "no-classified-call" }] satisfies PythonEvent[]
  return [{ kind: "unknown", call: "no-calls-detected" }] satisfies PythonEvent[]
}
