import type { PythonAstNode as Node } from "./frontend/interface"
import { DIRECT_IMPORT_BINDINGS, HTTP_REQUEST_CALL_BASES, TRACKED_HTTP_CLIENT_CONSTRUCTORS } from "./python-known-methods"
import type { AtlassianClientFamily, Rules, Scope } from "./python-analyze-types"
import { clearTrackedProvenanceForName, type ContainerKind, type ReceiverContainer, type ReceiverPath } from "./python-provenance"
import type { PythonArgs as Args, PythonValue as Value } from "./python-values"

const DATETIME_CANONICAL_MEMBERS = new Set(["UTC", "MAXYEAR", "MINYEAR", "date", "datetime", "time", "timedelta", "timezone", "tzinfo"])

type ImportBinding = {
  name: string
  target?: string
  direct?: boolean
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

export function scope(parent?: Scope): Scope {
  return {
    parent,
    bindings: new Map<string, string>(),
    localDefinitions: new Set<string>(),
    callableFactories: new Map<string, Node>(),
    containerInstances: new Map<string, ContainerKind>(),
    iteratedElementInstances: new Map<string, ContainerKind>(),
    iteratedPathInstances: new Map<string, Value>(),
    receiverContainers: new Map<string, ReceiverContainer>(),
    receiverPaths: new Map<string, ReceiverPath>(),
    pathInstances: new Map<string, Value>(),
    httpClientInstances: new Map<string, string>(),
    httpResponseInstances: new Set<string>(),
    ghapiInstances: new Set<string>(),
    atlassianInstances: new Map<string, AtlassianClientFamily>(),
  }
}

export function lookupBinding(input: Scope, key: string) {
  for (let current: Scope | undefined = input; current; current = current.parent) {
    const value = current.bindings.get(key)
    if (value) return value
  }
}

export function hasBoundName(input: Scope, key: string) {
  for (let current: Scope | undefined = input; current; current = current.parent) {
    if (current.bindings.has(key)) return true
  }
  return false
}

export function resolveQualified(input: string, current: Scope) {
  let parts = input.split(".")
  const seen = new Set<string>()
  while (parts[0]) {
    const head = parts[0]
    if (head === "datetime" && parts[1] && DATETIME_CANONICAL_MEMBERS.has(parts[1])) break
    if (!head || seen.has(head)) break
    const target = lookupBinding(current, head)
    if (!target || target === head) break
    seen.add(head)
    parts = [...target.split("."), ...parts.slice(1)]
  }
  return parts.join(".")
}

export function resolvedName(node: Node | null, current: Scope) {
  const raw = name(node)
  if (!raw) return
  return resolveQualified(raw, current)
}

export function clearTrackedName(current: Scope, name: string) {
  current.bindings.delete(name)
  current.localDefinitions.delete(name)
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

export function invalidateTrackedName(current: Scope, name: string) {
  clearTrackedName(current, name)
  current.bindings.set(name, name)
}

export function hasGhapiInstance(current: Scope, name: string) {
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    if (scope.ghapiInstances.has(name)) return true
  }
  return false
}

export function atlassianInstance(current: Scope, name: string) {
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const family = scope.atlassianInstances.get(name)
    if (family) return family
  }
}

export function httpClientInstance(current: Scope, name: string) {
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const client = scope.httpClientInstances.get(name)
    if (client) return client
  }
}

export function hasHttpResponseInstance(current: Scope, name: string) {
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    if (scope.httpResponseInstances.has(name)) return true
    if (scope.bindings.has(name)) return false
  }
  return false
}

export function containerInstance(current: Scope, name: string) {
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

export function iteratedElementInstance(current: Scope, name: string) {
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const kind = scope.iteratedElementInstances.get(name)
    if (kind) return kind
    if (scope.bindings.has(name)) return
  }
}

export function iteratedPathInstance(current: Scope, name: string) {
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const value = scope.iteratedPathInstances.get(name)
    if (value) return value
    if (scope.bindings.has(name)) return
  }
}

export function pathInstanceValue(current: Scope, name: string) {
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const value = scope.pathInstances.get(name)
    if (value) return value
    if (scope.bindings.has(name)) return
  }
}

export function aliasTarget(node: Node | null, current: Scope) {
  if (!node) return
  if (node.type !== "identifier" && node.type !== "attribute" && node.type !== "subscript") return
  return resolvedName(node, current)
}

export function importBindings(node: Node) {
  if (node.type === "import_statement") {
    const match = node.text.match(/^\s*import\s+([\s\S]+)$/)
    if (!match) return [] as ImportBinding[]
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
    if (!match) return [] as ImportBinding[]
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

  return [] as ImportBinding[]
}

export function shouldBindDirectImport(target: string, rules: Rules) {
  return (
    DIRECT_IMPORT_BINDINGS.has(target) ||
    target.startsWith("calendar.") ||
    target.startsWith("datetime.") ||
    target.startsWith("os.path.") ||
    target.startsWith("time.") ||
    target.startsWith("zoneinfo.") ||
    (target.startsWith("ast.") && rules.calls.pure.has(target)) ||
    (target.startsWith("re.") && rules.calls.pure.has(target)) ||
    (target.startsWith("unittest.mock.") && rules.calls.pure.has(target)) ||
    (target.startsWith("inspect.") &&
      (rules.calls.pure.has(target) ||
        rules.calls.read.has(target) ||
        rules.guarded.calls.some((rule) => rule.call === target))) ||
    HTTP_REQUEST_CALL_BASES.has(target) ||
    rules.calls.networkRead.has(target) ||
    rules.calls.networkWrite.has(target) ||
    rules.calls.networkExec.has(target) ||
    TRACKED_HTTP_CLIENT_CONSTRUCTORS.has(target)
  )
}

export function lookupCallableFactory(current: Scope, key: string) {
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const value = scope.callableFactories.get(key)
    if (value) return value
  }
}

export function callableFactory(node: Node) {
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
  return { name, returned }
}

export function callableFactoryReturn(node: Node | null, current: Scope, input?: Args) {
  if (!node || node.type !== "call" || !input) return
  if (input.positional.length > 0) return
  if (Object.keys(input.keyword).length > 0) return

  const call = resolvedName(node.childForFieldName("function"), current)
  if (!call) return

  return lookupCallableFactory(current, call)
}

export function callableFactoryTarget(node: Node | null, current: Scope, input?: Args) {
  const returned = callableFactoryReturn(node, current, input)
  if (!returned || (returned.type !== "identifier" && returned.type !== "attribute")) return
  return aliasTarget(returned, current)
}
