import type { PythonAstNode as Node } from "./frontend/interface"
import { DIRECT_IMPORT_BINDINGS, HTTP_REQUEST_CALL_BASES, TRACKED_HTTP_CLIENT_CONSTRUCTORS, TRUSTED_CALL_POLICIES, TRUSTED_MODULE_BINDINGS } from "./python-known-methods"
import type { AtlassianClientFamily, Rules, Scope } from "./python-analyze-types"
import { clearTrackedProvenanceForName, type ContainerKind, type ReceiverContainer, type ReceiverPath } from "./python-provenance"
import type { PythonArgs as Args, PythonValue as Value } from "./python-values"

const DATETIME_CANONICAL_MEMBERS = new Set(["UTC", "MAXYEAR", "MINYEAR", "date", "datetime", "time", "timedelta", "timezone", "tzinfo"])

type ImportBinding = {
  name: string
  target?: string
  direct?: boolean
  moduleRoot?: boolean
}

export function name(node: Node | null): string | undefined {
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
    directImportTargets: new Map<string, string>(),
    trustedDirectBindings: new Set<string>(),
    trustedBindings: new Set<string>(),
    trustedModuleBindings: new Set<string>(),
    trustedModuleRoots: new Set<string>(),
    localDefinitions: new Set<string>(),
    callableFactories: new Map<string, Node>(),
    callableFactoryContainers: new Map<string, ContainerKind>(),
    callableFactoryTupleContainers: new Map<string, ContainerKind[]>(),
    containerInstances: new Map<string, ContainerKind>(),
    valueInstances: new Map<string, Value>(),
    exactStringSets: new Map<string, string[]>(),
    exactIteratedStringSets: new Map<string, string[]>(),
    iteratedExactStringTupleInstances: new Map<string, string[][]>(),
    iteratedElementInstances: new Map<string, ContainerKind>(),
    iteratedContainerTupleInstances: new Map<string, ContainerKind[]>(),
    iteratedPathInstances: new Map<string, Value>(),
    iteratedPathTupleInstances: new Map<string, Value[]>(),
    seedablePathLists: new Set<string>(),
    tupleContainerSlotInstances: new Map<string, ContainerKind[]>(),
    seedableTupleLists: new Map<string, string[]>(),
    receiverContainers: new Map<string, ReceiverContainer>(),
    receiverElementKinds: new Map<string, ReceiverContainer>(),
    receiverSeedableStringLists: new Map<string, string[]>(),
    receiverPaths: new Map<string, ReceiverPath>(),
    pathInstances: new Map<string, Value>(),
    boundSetitemReceivers: new Map<string, { path?: string; canonicalPath?: string; equivalentPaths?: string[] }>(),
    sqliteConnectionInstances: new Map<string, string>(),
    sqliteCursorInstances: new Map<string, string>(),
    sqliteExecutedCursorInstances: new Set<string>(),
    sqliteClosedCursorInstances: new Set<string>(),
    trustedModelDumpInstances: new Set<string>(),
    ociPolicyIterableInstances: new Set<string>(),
    ociIdentityClientInstances: new Set<string>(),
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

export function hasTrustedModuleRoot(input: Scope, key: string) {
  for (let current: Scope | undefined = input; current; current = current.parent) {
    if (current.trustedModuleRoots.has(key)) return true
    if (current.bindings.has(key)) return false
  }
  return false
}

export function hasTrustedBinding(input: Scope, key: string) {
  for (let current: Scope | undefined = input; current; current = current.parent) {
    if (current.trustedBindings.has(key)) return true
    if (current.bindings.has(key)) return false
  }
  return false
}

export function hasTrustedDirectBinding(input: Scope, key: string) {
  for (let current: Scope | undefined = input; current; current = current.parent) {
    if (current.trustedDirectBindings.has(key)) return true
    if (current.bindings.has(key)) return false
  }
  return false
}

export function directImportTarget(input: Scope, key: string) {
  for (let current: Scope | undefined = input; current; current = current.parent) {
    const target = current.directImportTargets.get(key)
    if (target) return target
    if (current.bindings.has(key)) return
  }
}

export function hasTrustedModuleBinding(input: Scope, key: string) {
  for (let current: Scope | undefined = input; current; current = current.parent) {
    if (current.trustedModuleBindings.has(key)) return true
    if (current.bindings.has(key)) return false
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

export function trustedResolvedModuleCall(node: Node | null, resolvedCall: string, current: Scope) {
  const raw = name(node)
  if (!raw) return false
  const rawRoot = raw.split(".")[0]
  const resolvedRoot = resolvedCall.split(".")[0]
  if (!rawRoot || !resolvedRoot) return false
  if (rawRoot !== resolvedRoot) return hasTrustedBinding(current, rawRoot)
  return hasTrustedModuleRoot(current, rawRoot)
}

export function trustedExactDirectImportCall(node: Node | null, resolvedCall: string, current: Scope) {
  const raw = name(node)
  if (!raw) return false
  if (raw === resolvedCall) return trustedResolvedModuleCall(node, resolvedCall, current)
  const parts = resolvedCall.split(".")
  const leaf = parts[parts.length - 1]
  return Boolean(leaf && raw === leaf && hasTrustedDirectBinding(current, raw))
}

export function trustedCallWithPolicy(node: Node | null, resolvedCall: string, current: Scope) {
  if (resolvedCall.startsWith("datetime.")) {
    const raw = name(node)
    const rawRoot = raw?.split(".")[0]
    if (rawRoot === "datetime") {
      return !hasBoundName(current, rawRoot) || hasTrustedModuleRoot(current, rawRoot) || hasTrustedBinding(current, rawRoot) || hasTrustedDirectBinding(current, rawRoot)
    }
  }

  const policy = TRUSTED_CALL_POLICIES.get(resolvedCall)
  if (!policy) return true
  if (policy === "resolved-module") return trustedResolvedModuleCall(node, resolvedCall, current)
  if (policy === "module-qualified-or-exact-direct-import") return trustedExactDirectImportCall(node, resolvedCall, current)
  if (policy === "exact-direct-import") {
    const raw = name(node)
    if (!raw) return false
    const parts = resolvedCall.split(".")
    const leaf = parts[parts.length - 1]
    return Boolean(leaf && raw === leaf && hasTrustedDirectBinding(current, raw))
  }

  if (trustedExactDirectImportCall(node, resolvedCall, current)) return true
  const raw = name(node)
  if (!raw) return false
  const parts = raw.split(".")
  const resolvedParts = resolvedCall.split(".")
  const leaf = resolvedParts[resolvedParts.length - 1]
  return Boolean(parts.length === 2 && leaf && parts[1] === leaf && hasTrustedModuleBinding(current, parts[0] ?? ""))
}

export function trustedAliasSource(node: Node | null, current: Scope) {
  const raw = name(node)
  if (!raw) return false
  const resolved = resolvedName(node, current)
  if (!resolved) return false
  const rawRoot = raw.split(".")[0]
  const resolvedRoot = resolved.split(".")[0]
  if (!rawRoot || !resolvedRoot) return false
  if (rawRoot !== resolvedRoot) return hasTrustedBinding(current, rawRoot)
  return hasTrustedModuleRoot(current, rawRoot)
}

export function clearTrackedName(current: Scope, name: string) {
  current.bindings.delete(name)
  current.directImportTargets.delete(name)
  current.trustedDirectBindings.delete(name)
  current.trustedBindings.delete(name)
  current.trustedModuleBindings.delete(name)
  current.trustedModuleRoots.delete(name)
  current.localDefinitions.delete(name)
  current.callableFactories.delete(name)
  current.callableFactoryContainers.delete(name)
  current.callableFactoryTupleContainers.delete(name)
  current.containerInstances.delete(name)
  current.valueInstances.delete(name)
  current.exactStringSets.delete(name)
  current.exactIteratedStringSets.delete(name)
  current.iteratedExactStringTupleInstances.delete(name)
  current.iteratedElementInstances.delete(name)
  current.iteratedContainerTupleInstances.delete(name)
  current.iteratedPathInstances.delete(name)
  current.iteratedPathTupleInstances.delete(name)
  current.seedablePathLists.delete(name)
  current.tupleContainerSlotInstances.delete(name)
  current.seedableTupleLists.delete(name)
  current.pathInstances.delete(name)
  current.boundSetitemReceivers.delete(name)
  current.sqliteConnectionInstances.delete(name)
  current.sqliteCursorInstances.delete(name)
  current.trustedModelDumpInstances.delete(name)
  current.ociPolicyIterableInstances.delete(name)
  current.ociIdentityClientInstances.delete(name)
  clearTrackedProvenanceForName(current, name)
  current.httpClientInstances.delete(name)
  current.httpResponseInstances.delete(name)
  current.ghapiInstances.delete(name)
  current.atlassianInstances.delete(name)
}

export function clearIteratedElementProvenance(current: Scope, name: string) {
  const target = resolveQualified(name, current)
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    scope.iteratedElementInstances.delete(name)
    if (!target) continue
    const toDelete = new Set<string>([target])
    for (const key of scope.iteratedElementInstances.keys()) {
      if (resolveQualified(key, current) === target) toDelete.add(key)
    }
    for (const key of toDelete) scope.iteratedElementInstances.delete(key)
  }
}

export function clearExactStringSetProvenance(current: Scope, name: string) {
  const target = resolveQualified(name, current)
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    scope.exactStringSets.delete(name)
    if (!target) continue
    const toDelete = new Set<string>([target])
    for (const key of scope.exactStringSets.keys()) {
      if (resolveQualified(key, current) === target) toDelete.add(key)
    }
    for (const key of toDelete) scope.exactStringSets.delete(key)
  }
}

export function clearExactIteratedStringSetProvenance(current: Scope, name: string) {
  const target = resolveQualified(name, current)
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    scope.exactIteratedStringSets.delete(name)
    if (!target) continue
    const toDelete = new Set<string>([target])
    for (const key of scope.exactIteratedStringSets.keys()) {
      if (resolveQualified(key, current) === target) toDelete.add(key)
    }
    for (const key of toDelete) scope.exactIteratedStringSets.delete(key)
  }
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

export function hasTrustedModelDumpInstance(current: Scope, name: string) {
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    if (scope.trustedModelDumpInstances.has(name)) return true
    if (scope.bindings.has(name)) return false
  }
  return false
}

export function hasOciPolicyIterableInstance(current: Scope, name: string) {
  const target = resolveQualified(name, current) ?? name
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    if (scope.ociPolicyIterableInstances.has(name) || scope.ociPolicyIterableInstances.has(target)) return true
    if (scope.bindings.has(name) && target === name) return false
  }
  return false
}

export function clearOciPolicyIterableInstance(current: Scope, name: string) {
  const target = resolveQualified(name, current) ?? name
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    scope.ociPolicyIterableInstances.delete(name)
    scope.ociPolicyIterableInstances.delete(target)
    if (scope.bindings.has(name) && target === name) return
  }
}

export function hasOciIdentityClientInstance(current: Scope, name: string) {
  const target = resolveQualified(name, current) ?? name
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    if (scope.ociIdentityClientInstances.has(name) || scope.ociIdentityClientInstances.has(target)) return true
    if (scope.bindings.has(name) && target === name) return false
  }
  return false
}

export function clearOciIdentityClientInstance(current: Scope, name: string) {
  const target = resolveQualified(name, current) ?? name
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    scope.ociIdentityClientInstances.delete(name)
    scope.ociIdentityClientInstances.delete(target)
    if (scope.bindings.has(name) && target === name) return
  }
}

export function clearTrustedModelDumpInstance(current: Scope, name: string) {
  const target = resolveQualified(name, current) ?? name
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    scope.trustedModelDumpInstances.delete(name)
    scope.trustedModelDumpInstances.delete(target)
    if (scope.bindings.has(name) && target === name) return
  }
}

function sqliteTrackedToken(input: Scope, name: string, getter: (scope: Scope, key: string) => string | undefined) {
  for (let scope: Scope | undefined = input; scope; scope = scope.parent) {
    const token = getter(scope, name)
    if (token) return token
    if (scope.bindings.has(name)) return
  }
}

export function sqliteConnectionToken(current: Scope, name: string) {
  return sqliteTrackedToken(current, name, (scope, key) => scope.sqliteConnectionInstances.get(key))
}

export function sqliteCursorToken(current: Scope, name: string) {
  const token = sqliteTrackedToken(current, name, (scope, key) => scope.sqliteCursorInstances.get(key))
  if (!token) return
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    if (scope.sqliteClosedCursorInstances.has(token)) return
  }
  return token
}

export function hasSqliteConnectionInstance(current: Scope, name: string) {
  return Boolean(sqliteConnectionToken(current, name))
}

export function hasSqliteCursorInstance(current: Scope, name: string) {
  return Boolean(sqliteCursorToken(current, name))
}

export function hasExecutedSqliteCursorInstance(current: Scope, name: string) {
  const token = sqliteCursorToken(current, name)
  if (!token) return false
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    if (scope.sqliteExecutedCursorInstances.has(token)) return true
  }
  return false
}

export function markExecutedSqliteCursorInstance(current: Scope, name: string) {
  const token = sqliteCursorToken(current, name)
  if (token) current.sqliteExecutedCursorInstances.add(token)
}

export function clearExecutedSqliteCursorInstance(current: Scope, name: string) {
  const token = sqliteCursorToken(current, name)
  if (!token) return
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    scope.sqliteExecutedCursorInstances.delete(token)
  }
}

export function closeSqliteCursorInstance(current: Scope, name: string) {
  const token = sqliteCursorToken(current, name)
  if (!token) return
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    scope.sqliteExecutedCursorInstances.delete(token)
    scope.sqliteClosedCursorInstances.add(token)
  }
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

export function iteratedExactStringTupleInstance(current: Scope, name: string) {
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const value = scope.iteratedExactStringTupleInstances.get(name)
    if (value) return value
    if (scope.bindings.has(name)) return
  }
}

export function iteratedContainerTupleInstance(current: Scope, name: string) {
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const value = scope.iteratedContainerTupleInstances.get(name)
    if (value) return value
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

export function iteratedPathTupleInstance(current: Scope, name: string) {
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const value = scope.iteratedPathTupleInstances.get(name)
    if (value) return value
    if (scope.bindings.has(name)) return
  }
}

export function tupleContainerSlotInstance(current: Scope, name: string) {
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const value = scope.tupleContainerSlotInstances.get(name)
    if (value) return value
    if (scope.bindings.has(name)) return
  }
}

export function hasSeedableTupleList(current: Scope, name: string) {
  const target = resolveQualified(name, current)
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    if (scope.seedableTupleLists.has(name)) return true
    if (target && scope.seedableTupleLists.has(target)) return true
    if (target) {
      for (const key of scope.seedableTupleLists.keys()) {
        if (resolveQualified(key, current) === target) return true
      }
    }
    if (scope.bindings.has(name)) return false
  }
  return false
}

export function hasSeedablePathList(current: Scope, name: string) {
  const target = resolveQualified(name, current)
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    if (scope.seedablePathLists.has(name)) return true
    if (target && scope.seedablePathLists.has(target)) return true
    if (target) {
      for (const key of scope.seedablePathLists) {
        if (resolveQualified(key, current) === target) return true
      }
    }
    if (scope.bindings.has(name)) return false
  }
  return false
}

export function pathInstanceValue(current: Scope, name: string) {
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const value = scope.pathInstances.get(name)
    if (value) return value
    if (scope.bindings.has(name)) return
  }
}

export function boundSetitemReceiver(current: Scope, name: string) {
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const value = scope.boundSetitemReceivers.get(name)
    if (value) return value
    if (scope.bindings.has(name)) return
  }
}

export function aliasTarget(node: Node | null, current: Scope) {
  if (!node) return
  if (node.type !== "identifier" && node.type !== "attribute") return
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
        return { name, target: alias ? moduleName : undefined, direct: false, moduleRoot: !alias }
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
        return { name, target: `${moduleName}.${importedName}`, direct: !alias, moduleRoot: false }
      })
  }

  return [] as ImportBinding[]
}

export function shouldBindDirectImport(target: string, rules: Rules) {
  return (
    DIRECT_IMPORT_BINDINGS.has(target) ||
    TRUSTED_CALL_POLICIES.has(target) ||
    TRUSTED_MODULE_BINDINGS.has(target) ||
    target.startsWith("calendar.") ||
    target.startsWith("datetime.") ||
    target === "importlib.metadata" ||
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

export function lookupCallableFactoryContainer(current: Scope, key: string) {
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const value = scope.callableFactoryContainers.get(key)
    if (value) return value
    if (scope.bindings.has(key)) return
  }
}

export function lookupCallableFactoryTupleContainer(current: Scope, key: string) {
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const value = scope.callableFactoryTupleContainers.get(key)
    if (value) return value
    if (scope.bindings.has(key)) return
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
