import { access, readFile } from "fs/promises"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"

type Node = {
  type: string
  text: string
  hasError: boolean
  startIndex: number
  endIndex: number
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

export type PythonEventKind = "read" | "write" | "emit" | "exec" | "pure" | "unknown"

export type PythonEvent = {
  kind: PythonEventKind
  call: string
  path?: string
  dynamicPath?: boolean
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
}

const CALLABLE_UNKNOWN_PREFIX = "callable:"
const RULES_VERSION = 1
const RULES_URL = new URL("./python-rules.json", import.meta.url)
const FAMILIES = ["jira", "confluence", "bitbucket", "servicedesk"] as const

let parser: Promise<Parser> | undefined
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
  }
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

const resolveNodeModules = async () => {
  const dir = fileURLToPath(new URL(".", import.meta.url))
  const candidates = [
    path.resolve(dir, "..", "..", ".opencode", "node_modules"),
    path.resolve(dir, "..", "..", "node_modules"),
  ]
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true, () => false)) return candidate
  }
  return candidates[0]
}

async function initParser() {
  const modules = await resolveNodeModules()
  const tree = (await import(pathToFileURL(path.join(modules, "web-tree-sitter/tree-sitter.js")).href)) as unknown as {
    Parser: ParserCtor
    Language: LanguageCtor
  }
  const treeWasm = (await import(pathToFileURL(path.join(modules, "web-tree-sitter/tree-sitter.wasm")).href, {
    with: { type: "wasm" },
  })) as { default: string }
  await tree.Parser.init({
    locateFile() {
      return resolveWasm(treeWasm.default)
    },
  })
  const pythonWasm = (await import(pathToFileURL(path.join(modules, "tree-sitter-python/tree-sitter-python.wasm")).href, {
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

function classify(
  node: Node,
  rules: Rules,
  hasAtlassianImportProvenance: boolean,
  ghapiInstances: Set<string>,
  atlassianInstances: Map<string, AtlassianClientFamily>,
): PythonEvent | undefined {
  const fn = node.childForFieldName("function")
  const call = name(fn)
  if (!call) return { kind: "unknown", call: "dynamic-call" }

  const input = args(node)
  if (call === "open") return classifyOpen(input)

  const method = tail(call)
  if (rules.methods.read.has(method)) return pathEvent("read", call, pathFromPathMethod(fn))
  if (rules.methods.write.has(method)) return pathEvent("write", call, pathFromPathMethod(fn))
  if (rules.methods.emit.has(method)) return { kind: "emit", call }
  if (rules.methods.pure.has(method)) return { kind: "pure", call }

  const readSpec = rules.pathCalls.read[call]
  if (readSpec) return pathEvent("read", call, pick(input, readSpec.index, readSpec.names))

  const writeSpec = rules.pathCalls.write[call]
  if (writeSpec) return pathEvent("write", call, pick(input, writeSpec.index, writeSpec.names))

  if (rules.calls.read.has(call)) return { kind: "read", call }
  if (rules.calls.write.has(call)) return { kind: "write", call }
  if (rules.sdk.ghapi.writeCalls.has(call)) return { kind: "write", call }
  if (rules.calls.tempfileWrite.has(call)) return { kind: "write", call }

  if (rules.calls.exec.has(call)) return { kind: "exec", call }
  if (rules.calls.networkExec.has(call)) return { kind: "exec", call }
  if (rules.calls.dbExec.has(call)) return { kind: "exec", call }
  if (rules.calls.dangerousDeserializeExec.has(call)) return { kind: "exec", call }
  if (rules.sdk.oci.execCalls.has(call)) return { kind: "exec", call }
  if (rules.sdk.ghapi.execCalls.has(call)) return { kind: "exec", call }
  if (isAtlassianConstructorCall(call, rules, hasAtlassianImportProvenance)) return { kind: "exec", call }
  if (rules.sdk.oci.clientMethodPrefixes.some((prefix) => call.startsWith(prefix))) return { kind: "exec", call }

  const parts = call.split(".")
  const instance = parts[0]
  if (instance && ghapiInstances.has(instance) && parts.length >= 3) {
    return { kind: "exec", call: `ghapi.${parts[1]}.${parts[2]}` }
  }

  const atlassianClient = instance ? atlassianInstances.get(instance) : undefined
  if (atlassianClient && parts.length >= 2) {
    const method = parts[1]
    if (rules.sdk.atlassian.clientMethods[atlassianClient].has(method)) {
      return { kind: "exec", call: `atlassian.${atlassianClient}.${method}` }
    }
  }

  if (call.startsWith("subprocess.")) return { kind: "exec", call }
  if (call.startsWith("os.exec")) return { kind: "exec", call }

  if (rules.calls.emit.has(call)) return { kind: "emit", call }
  if (rules.calls.pure.has(call)) return { kind: "pure", call }

  return { kind: "unknown", call: `${CALLABLE_UNKNOWN_PREFIX}${call}` }
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

export async function analyze(source: string) {
  if (!source.trim()) return [{ kind: "unknown", call: "empty-source" }] satisfies PythonEvent[]

  let tree: Tree | null = null
  const rules = await loadRules()

  try {
    const p = await getParser()
    tree = p.parse(source)
  } catch {
    return [{ kind: "unknown", call: "parse-error" }] satisfies PythonEvent[]
  }

  if (!tree) return [{ kind: "unknown", call: "parse-error" }] satisfies PythonEvent[]
  if (tree.rootNode.hasError) return [{ kind: "unknown", call: "parse-error" }] satisfies PythonEvent[]

  const hasAtlassianImportProvenance =
    tree.rootNode.descendantsOfType("import_statement").some(isAtlassianImportStatement) ||
    tree.rootNode.descendantsOfType("import_from_statement").some(isAtlassianImportStatement)

  const ghapiInstances = new Set<string>()
  const atlassianInstances = new Map<string, AtlassianClientFamily>()
  const calls = tree.rootNode.descendantsOfType("call")

  const assignments = tree.rootNode.descendantsOfType("assignment")
  const timeline = [
    ...assignments.map((assignment) => ({ kind: "assignment" as const, node: assignment })),
    ...calls.map((call) => ({ kind: "call" as const, node: call })),
  ].sort((a, b) => {
    if (a.node.startIndex === b.node.startIndex) return a.node.endIndex - b.node.endIndex
    return a.node.startIndex - b.node.startIndex
  })

  const events: PythonEvent[] = []
  for (const entry of timeline) {
    if (entry.kind === "assignment") {
      const left = entry.node.childForFieldName("left")
      const right = entry.node.childForFieldName("right")
      if (!left || left.type !== "identifier") continue

      if (!right || right.type !== "call") {
        ghapiInstances.delete(left.text)
        atlassianInstances.delete(left.text)
        continue
      }

      const assignedCall = name(right.childForFieldName("function"))
      if (!assignedCall) {
        ghapiInstances.delete(left.text)
        atlassianInstances.delete(left.text)
        continue
      }

      if (rules.sdk.ghapi.instanceConstructors.has(assignedCall)) {
        ghapiInstances.add(left.text)
      } else {
        ghapiInstances.delete(left.text)
      }

      const atlassianClient = atlassianFamilyForConstructor(assignedCall, rules, hasAtlassianImportProvenance)
      if (atlassianClient) {
        atlassianInstances.set(left.text, atlassianClient)
      } else {
        atlassianInstances.delete(left.text)
      }

      continue
    }

    const event = classify(entry.node, rules, hasAtlassianImportProvenance, ghapiInstances, atlassianInstances)
    if (event) events.push(event)
  }

  if (events.length) return unique(events)
  if (calls.length) return [{ kind: "unknown", call: "no-classified-call" }] satisfies PythonEvent[]
  return [{ kind: "unknown", call: "no-calls-detected" }] satisfies PythonEvent[]
}
