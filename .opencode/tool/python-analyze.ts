import { fileURLToPath } from "url"

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
const OCI_EXEC_CALLS = new Set([
  "oci.identity.IdentityClient",
  "oci.core.ComputeClient",
  "oci.core.VirtualNetworkClient",
  "oci.object_storage.ObjectStorageClient",
  "oci.database.DatabaseClient",
  "oci.secrets.SecretsClient",
  "oci.key_management.KmsManagementClient",
  "oci.pagination.list_call_get_all_results",
  "oci.pagination.list_call_get_all_results_generator",
])
const OCI_CLIENT_METHOD_PREFIXES = [
  "oci.identity.IdentityClient.",
  "oci.core.ComputeClient.",
  "oci.core.VirtualNetworkClient.",
  "oci.object_storage.ObjectStorageClient.",
  "oci.database.DatabaseClient.",
  "oci.secrets.SecretsClient.",
  "oci.key_management.KmsManagementClient.",
]
const GHAPI_EXEC_CALLS = new Set([
  "ghapi.all.GhApi",
  "ghapi.core.GhApi",
  "ghapi.graphql.gh_query",
  "ghapi.page.paged",
  "ghapi.page.pages",
  "ghapi.auth.GhDeviceAuth",
  "ghapi.auth.github_auth_device",
  "GhApi.create_gist",
  "GhApi.create_release",
  "GhApi.delete_release",
  "GhApi.upload_file",
  "GhApi.enable_pages",
])
const GHAPI_WRITE_CALLS = new Set([
  "ghapi.actions.create_workflow_files",
  "ghapi.actions.create_workflow",
  "ghapi.actions.gh_create_workflow",
])
const GHAPI_INSTANCE_CONSTRUCTORS = new Set(["GhApi", "ghapi.all.GhApi", "ghapi.core.GhApi"])

type AtlassianClientFamily = "jira" | "confluence" | "bitbucket" | "servicedesk"

const ATLASSIAN_CONSTRUCTOR_COVERAGE: Array<{ family?: AtlassianClientFamily; variants: string[] }> = [
  { family: "jira", variants: ["Jira", "atlassian.Jira", "atlassian.jira.Jira"] },
  {
    family: "confluence",
    variants: [
      "Confluence",
      "atlassian.Confluence",
      "atlassian.confluence.Confluence",
      "ConfluenceCloud",
      "atlassian.ConfluenceCloud",
      "atlassian.confluence.ConfluenceCloud",
      "ConfluenceServer",
      "atlassian.ConfluenceServer",
      "atlassian.confluence.ConfluenceServer",
    ],
  },
  {
    family: "bitbucket",
    variants: [
      "Bitbucket",
      "atlassian.Bitbucket",
      "atlassian.bitbucket.Bitbucket",
      "Cloud",
      "atlassian.Cloud",
      "atlassian.bitbucket.Cloud",
    ],
  },
  {
    family: "servicedesk",
    variants: ["ServiceDesk", "atlassian.ServiceDesk", "atlassian.servicedesk.ServiceDesk", "atlassian.service_desk.ServiceDesk"],
  },
  { variants: ["Crowd", "atlassian.Crowd"] },
  { variants: ["Xray", "atlassian.Xray"] },
  { variants: ["CloudAdminOrgs", "atlassian.CloudAdminOrgs"] },
  { variants: ["CloudAdminUsers", "atlassian.CloudAdminUsers"] },
]

const ATLASSIAN_CONSTRUCTOR_METADATA = new Map<
  string,
  {
    family?: AtlassianClientFamily
    bare: boolean
  }
>()

for (const constructor of ATLASSIAN_CONSTRUCTOR_COVERAGE) {
  for (const variant of constructor.variants) {
    ATLASSIAN_CONSTRUCTOR_METADATA.set(variant, {
      family: constructor.family,
      bare: !variant.includes("."),
    })
  }
}

const ATLASSIAN_CLIENT_METHODS = {
  jira: new Set(["jql", "issue", "create_issue", "issue_create", "issue_transition", "issue_add_comment"]),
  confluence: new Set(["get_page_by_id", "get_page_by_title", "create_page", "update_page", "cql", "attach_file"]),
  bitbucket: new Set([
    "get_repo",
    "create_repo",
    "open_pull_request",
    "get_pull_requests",
    "get_pipelines",
    "trigger_pipeline",
  ]),
  servicedesk: new Set(["get_service_desks", "create_customer_request", "get_queues", "create_request_comment"]),
} satisfies Record<AtlassianClientFamily, Set<string>>

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

function classify(
  node: Node,
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
  if (READ_METHODS.has(method)) return pathEvent("read", call, pathFromPathMethod(fn))
  if (WRITE_METHODS.has(method)) return pathEvent("write", call, pathFromPathMethod(fn))

  const writeSpec = WRITE_PATH_CALLS[call]
  if (writeSpec) return pathEvent("write", call, pick(input, writeSpec.index, writeSpec.names))

  if (READ_CALLS.has(call)) return { kind: "read", call }
  if (WRITE_CALLS.has(call)) return { kind: "write", call }
  if (GHAPI_WRITE_CALLS.has(call)) return { kind: "write", call }
  if (TEMPFILE_WRITE_CALLS.has(call)) return { kind: "write", call }
  if (call === "oci.config.from_file") return pathEvent("read", call, pick(input, 0, ["file_location"]))

  if (EXEC_CALLS.has(call)) return { kind: "exec", call }
  if (NETWORK_EXEC_CALLS.has(call)) return { kind: "exec", call }
  if (DB_EXEC_CALLS.has(call)) return { kind: "exec", call }
  if (DANGEROUS_DESERIALIZE_EXEC_CALLS.has(call)) return { kind: "exec", call }
  if (OCI_EXEC_CALLS.has(call)) return { kind: "exec", call }
  if (GHAPI_EXEC_CALLS.has(call)) return { kind: "exec", call }
  if (isAtlassianConstructorCall(call, hasAtlassianImportProvenance)) return { kind: "exec", call }
  if (OCI_CLIENT_METHOD_PREFIXES.some((prefix) => call.startsWith(prefix))) return { kind: "exec", call }

  const parts = call.split(".")
  const instance = parts[0]
  if (instance && ghapiInstances.has(instance) && parts.length >= 3) {
    return { kind: "exec", call: `ghapi.${parts[1]}.${parts[2]}` }
  }

  const atlassianClient = instance ? atlassianInstances.get(instance) : undefined
  if (atlassianClient && parts.length >= 2) {
    const method = parts[1]
    if (ATLASSIAN_CLIENT_METHODS[atlassianClient].has(method)) {
      return { kind: "exec", call: `atlassian.${atlassianClient}.${method}` }
    }
  }

  if (call.startsWith("subprocess.")) return { kind: "exec", call }
  if (call.startsWith("os.exec")) return { kind: "exec", call }

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

function isAtlassianConstructorCall(call: string, hasAtlassianImportProvenance: boolean) {
  const metadata = ATLASSIAN_CONSTRUCTOR_METADATA.get(call)
  if (!metadata) return false
  if (!metadata.bare) return true
  return hasAtlassianImportProvenance
}

function atlassianFamilyForConstructor(call: string, hasAtlassianImportProvenance: boolean) {
  const metadata = ATLASSIAN_CONSTRUCTOR_METADATA.get(call)
  if (!metadata) return
  if (metadata.bare && !hasAtlassianImportProvenance) return
  return metadata.family
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

      if (GHAPI_INSTANCE_CONSTRUCTORS.has(assignedCall)) {
        ghapiInstances.add(left.text)
      } else {
        ghapiInstances.delete(left.text)
      }

      const atlassianClient = atlassianFamilyForConstructor(assignedCall, hasAtlassianImportProvenance)
      if (atlassianClient) {
        atlassianInstances.set(left.text, atlassianClient)
      } else {
        atlassianInstances.delete(left.text)
      }

      continue
    }

    const event = classify(entry.node, hasAtlassianImportProvenance, ghapiInstances, atlassianInstances)
    if (event) events.push(event)
  }

  if (events.length) return unique(events)
  if (calls.length) return [{ kind: "unknown", call: "no-classified-call" }] satisfies PythonEvent[]
  return [{ kind: "unknown", call: "no-calls-detected" }] satisfies PythonEvent[]
}
