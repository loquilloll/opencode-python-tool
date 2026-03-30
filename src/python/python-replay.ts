import type { PythonAstNode as Node } from "./frontend/interface"
import { atlassianFamilyForConstructor, isHttpResponseCall } from "./python-classifier"
import {
  args,
  hasDictionarySplat,
  iteratedContainerKind,
  iteratedContainerTupleValues,
  iteratedPathTupleValues,
  iteratedPathValue,
  rebindContainerKinds,
  rebindReceiverContainerKinds,
  rebindTupleContainerSlotKinds,
  rebindPathValues,
  rebindSource,
  returnedTrackedContainerKind,
  trackedContainerKind,
  trackedReceiverContainerKind,
  trackedPathValue,
  tupleContainerSlotKinds,
} from "./python-inference"
import { ensureGuardSnapshots, equivalentSubscriptValuePath, equivalentSubscriptValuePaths, exactIteratedStringSet, exactNodeValue, exactStringSet, invalidateGuardReceiverSnapshots } from "./python-key-equivalence"
import { TRACKED_HTTP_CLIENT_CONSTRUCTORS, TRUSTED_MODULE_BINDINGS } from "./python-known-methods"
import type { Rules, Scope, TimelineEntry } from "./python-analyze-types"
import {
  applyAssignmentProvenance,
  clearReceiverDeps,
  type ContainerKind,
  type ReceiverContainer,
  trackableInvalidationDeps,
  trackableReceiverInfo,
} from "./python-provenance"
import {
  aliasTarget,
  boundSetitemReceiver,
  callableFactory,
  callableFactoryTarget,
  clearTrustedModelDumpInstance,
  clearExactIteratedStringSetProvenance,
  clearExactStringSetProvenance,
  clearIteratedElementProvenance,
  closeSqliteCursorInstance,
  containerInstance,
  directImportTarget,
  hasSeedablePathList,
  hasSeedableTupleList,
  hasExecutedSqliteCursorInstance,
  hasSqliteConnectionInstance,
  hasSqliteCursorInstance,
  hasTrustedDirectBinding,
  importBindings,
  invalidateTrackedName,
  iteratedElementInstance,
  iteratedExactStringTupleInstance,
  markExecutedSqliteCursorInstance,
  resolveQualified,
  resolvedName,
  shouldBindDirectImport,
  trustedAliasSource,
} from "./python-scope"
import { unwrapParenthesized } from "./python-inference-values"
import {
  assignedNames,
  assignmentLeft,
  assignmentRight,
  definitionNode,
  definitionName,
  parameterNames,
  rebindTarget,
} from "./python-timeline"
import type { PythonValue as Value } from "./python-values"

export type HelperParamSeed = {
  containerKind?: ContainerKind
  iteratedElementKind?: ContainerKind
  exactStrings?: string[]
  pathValue?: Value
}

export type HelperSeeds = Map<number, Map<string, HelperParamSeed>>
export type HelperReturnKinds = Map<number, ContainerKind>

type HelperReceiverElementKinds = Map<Scope, Map<string, ReceiverContainer>>

type HelperReturnCandidate = {
  definitionStart: number
  name: string
  bodyScope: Scope
  returnValues: Array<Node | null>
  requiresSeeds: boolean
  blocked: boolean
}

type ActiveHelper = {
  definitionStart: number
  params: string[]
  bodyScope: Scope
  seeds: Array<HelperParamSeed | undefined>
  blocked: boolean
  observedCalls: number
}

const ITERATED_ELEMENT_INVALIDATING_METHODS = new Set(["append", "extend", "insert"])
const TRACKED_MAPPING_VALUE_KINDS = new Set<ContainerKind>(["dict-list-values", "dict-set-values", "dict-counter-values"])
const TRACKED_MAPPING_VALUE_INVALIDATING_METHODS = new Set(["setdefault", "update"])
const OCI_MODEL_METADATA_ATTRIBUTES = new Set(["attribute_map", "swagger_types"])
const OCI_CREATE_CLUSTER_DETAILS_TARGETS = new Set([
  "oci.container_engine.models.CreateClusterDetails",
])
const TABULATE_FORMATS_TARGET = "tabulate.tabulate_formats"
const DIFFLIB_MUTABLE_TRUSTED_ATTRIBUTES = new Set(["unified_diff"])
const FNMATCH_MUTABLE_TRUSTED_ATTRIBUTES = new Set(["fnmatch"])
const HASHLIB_MUTABLE_TRUSTED_ATTRIBUTES = new Set(["sha1", "sha256"])
const OS_MUTABLE_TRUSTED_ATTRIBUTES = new Set(["walk"])
const STRUCT_MUTABLE_TRUSTED_ATTRIBUTES = new Set(["unpack"])
const TRUSTED_MODELDUMP_TARGET = "pytfe.models.organization_membership.OrganizationMembershipListOptions"
const SQLITE_CURSOR_READ_METHODS = new Set(["fetchone", "fetchall"])
const MAX_EXACT_TUPLE_STRINGS = 8
const HELPER_PARAM_CONTAINER_KINDS = new Set<ContainerKind>([
  "string",
  "datetime-date",
  "datetime-datetime",
  "datetime-time",
  "datetime-timedelta",
  "datetime-timezone",
])
const HELPER_RETURN_CONTAINER_KINDS = new Set<ContainerKind>([
  "datetime-date",
  "datetime-datetime",
  "datetime-time",
  "datetime-timedelta",
  "datetime-timezone",
])

function shouldTrustModuleBinding(target: string | undefined) {
  return Boolean(target && TRUSTED_MODULE_BINDINGS.has(target))
}

function seedTrustedOciModelMetadataMaps(current: Scope, name: string, target: string | undefined) {
  if (name !== "CreateClusterDetails" || !target || !OCI_CREATE_CLUSTER_DETAILS_TARGETS.has(target)) return
  for (const attribute of OCI_MODEL_METADATA_ATTRIBUTES) {
    current.receiverContainers.set(`${name}.${attribute}`, { kind: "dict", deps: [name] })
  }
}

function seedTrustedTabulateFormatsElements(current: Scope, name: string, target: string | undefined) {
  if (name !== "tabulate_formats" || target !== TABULATE_FORMATS_TARGET) return
  current.iteratedElementInstances.set(name, "string")
}

function seedTrustedModelDumpInstance(current: Scope, name: string, node: Node) {
  const fn = node.childForFieldName("function")
  if (fn?.type !== "attribute") return
  if (fn.childForFieldName("attribute")?.text !== "model_validate") return
  const receiver = fn.childForFieldName("object")
  if (receiver?.type !== "identifier" || receiver.text !== "OrganizationMembershipListOptions") return
  if (!hasTrustedDirectBinding(current, receiver.text)) return
  if (directImportTarget(current, receiver.text) !== TRUSTED_MODELDUMP_TARGET) return
  current.trustedModelDumpInstances.add(name)
}

function trustedModelDumpFactoryRoot(current: Scope, receiver: Node | null) {
  if (receiver?.type !== "identifier") return
  if (directImportTarget(current, receiver.text) === TRUSTED_MODELDUMP_TARGET) return receiver.text
  const resolved = resolvedName(receiver, current)
  if (resolved && directImportTarget(current, resolved) === TRUSTED_MODELDUMP_TARGET) return resolved
}

function clearAllTrustedModelDumpInstances(current: Scope) {
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    scope.trustedModelDumpInstances.clear()
  }
}

function clearTrustedModelDumpFactory(current: Scope, receiver: Node | null) {
  const rootName = trustedModelDumpFactoryRoot(current, receiver)
  if (!rootName) return
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const names = new Set<string>([rootName, TRUSTED_MODELDUMP_TARGET])
    if (receiver?.type === "identifier") names.add(receiver.text)
    for (const key of scope.bindings.keys()) {
      if (resolveQualified(key, current) === rootName || resolveQualified(key, current) === TRUSTED_MODELDUMP_TARGET) names.add(key)
    }
    for (const name of names) invalidateTrackedName(scope, name)
  }
}

function seedSqliteCursorInstance(current: Scope, name: string, node: Node) {
  const fn = node.childForFieldName("function")
  if (fn?.type !== "attribute") return
  if (fn.childForFieldName("attribute")?.text !== "cursor") return
  const receiver = fn.childForFieldName("object")
  if (receiver?.type !== "identifier" || !hasSqliteConnectionInstance(current, receiver.text)) return
  const input = args(node)
  if (input.positional.length !== 0 || Object.keys(input.keyword).length !== 0 || hasDictionarySplat(node)) return
  current.sqliteCursorInstances.set(name, `sqlite-cursor:${node.startIndex}`)
}

function clearSqliteCursorInstance(current: Scope, name: string) {
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    scope.sqliteCursorInstances.delete(name)
    if (scope.bindings.has(name)) return
  }
}

function clearExactStringIterableProvenance(current: Scope, name: string) {
  clearExactStringSetProvenance(current, name)
  clearExactIteratedStringSetProvenance(current, name)
  const resolved = resolveQualified(name, current)
  if (resolved && resolved !== name) {
    clearExactStringSetProvenance(current, resolved)
    clearExactIteratedStringSetProvenance(current, resolved)
  }
}

function clearIteratedExactStringTupleProvenance(current: Scope, name: string) {
  const resolved = resolveQualified(name, current)
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const toDelete = new Set<string>([name])
    if (resolved && resolved !== name) toDelete.add(resolved)
    for (const key of scope.iteratedExactStringTupleInstances.keys()) {
      if (resolveQualified(key, current) === resolved) toDelete.add(key)
    }
    for (const key of toDelete) scope.iteratedExactStringTupleInstances.delete(key)
  }
}

function clearIteratedPathTupleProvenance(current: Scope, name: string) {
  const resolved = resolveQualified(name, current)
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const toDelete = new Set<string>([name])
    if (resolved && resolved !== name) toDelete.add(resolved)
    for (const key of scope.iteratedPathTupleInstances.keys()) {
      if (resolveQualified(key, current) === resolved) toDelete.add(key)
    }
    for (const key of toDelete) scope.iteratedPathTupleInstances.delete(key)
  }
}

function clearIteratedPathProvenance(current: Scope, name: string) {
  const resolved = resolveQualified(name, current)
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const toDelete = new Set<string>([name])
    if (resolved && resolved !== name) toDelete.add(resolved)
    for (const key of scope.iteratedPathInstances.keys()) {
      if (resolveQualified(key, current) === resolved) toDelete.add(key)
    }
    for (const key of toDelete) scope.iteratedPathInstances.delete(key)
  }
}

function clearIteratedContainerTupleProvenance(current: Scope, name: string) {
  const resolved = resolveQualified(name, current)
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const toDelete = new Set<string>([name])
    if (resolved && resolved !== name) toDelete.add(resolved)
    for (const key of scope.iteratedContainerTupleInstances.keys()) {
      if (resolveQualified(key, current) === resolved) toDelete.add(key)
    }
    for (const key of toDelete) scope.iteratedContainerTupleInstances.delete(key)
  }
}

function clearTupleContainerSlotProvenance(current: Scope, name: string) {
  const resolved = resolveQualified(name, current)
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const toDelete = new Set<string>([name])
    if (resolved && resolved !== name) toDelete.add(resolved)
    for (const key of scope.tupleContainerSlotInstances.keys()) {
      if (resolveQualified(key, current) === resolved) toDelete.add(key)
    }
    for (const key of toDelete) scope.tupleContainerSlotInstances.delete(key)
  }
}

function clearSeedableTupleListProvenance(current: Scope, name: string) {
  const resolved = resolveQualified(name, current)
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const toDelete = new Set<string>([name])
    if (resolved && resolved !== name) toDelete.add(resolved)
    for (const key of scope.seedableTupleLists.keys()) {
      if (resolveQualified(key, current) === resolved) toDelete.add(key)
    }
    for (const key of toDelete) scope.seedableTupleLists.delete(key)
  }
}

function clearSeedablePathListProvenance(current: Scope, name: string) {
  const resolved = resolveQualified(name, current)
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const toDelete = new Set<string>([name])
    if (resolved && resolved !== name) toDelete.add(resolved)
    for (const key of scope.seedablePathLists) {
      if (resolveQualified(key, current) === resolved) toDelete.add(key)
    }
    for (const key of toDelete) scope.seedablePathLists.delete(key)
  }
}

function setIteratedContainerTupleProvenance(current: Scope, name: string, kinds: ContainerKind[]) {
  current.iteratedContainerTupleInstances.set(name, kinds)
  const resolved = resolveQualified(name, current)
  if (resolved && resolved !== name) current.iteratedContainerTupleInstances.set(resolved, kinds)
}

function setTupleContainerSlotProvenance(current: Scope, name: string, kinds: ContainerKind[]) {
  current.tupleContainerSlotInstances.set(name, kinds)
  current.containerInstances.set(name, "tuple")
  const resolved = resolveQualified(name, current)
  if (resolved && resolved !== name) {
    current.tupleContainerSlotInstances.set(resolved, kinds)
    current.containerInstances.set(resolved, "tuple")
  }
}

function markSeedableTupleList(current: Scope, name: string) {
  current.seedableTupleLists.set(name, [name])
  const resolved = resolveQualified(name, current)
  if (resolved && resolved !== name) current.seedableTupleLists.set(resolved, [resolved])
}

function markSeedablePathList(current: Scope, name: string) {
  current.seedablePathLists.add(name)
  const resolved = resolveQualified(name, current)
  if (resolved && resolved !== name) current.seedablePathLists.add(resolved)
}

function setIteratedExactStringTupleProvenance(current: Scope, name: string, values: string[][]) {
  current.iteratedExactStringTupleInstances.set(name, values)
  const resolved = resolveQualified(name, current)
  if (resolved && resolved !== name) current.iteratedExactStringTupleInstances.set(resolved, values)
}

export function clearIndirectMappingMutations(entry: TimelineEntry) {
  if (entry.kind !== "call") return
  const rawFn = entry.node.childForFieldName("function")
  const fn = unwrapParenthesized(rawFn)
  const resolved = resolvedName(fn ?? rawFn, entry.scope)
  if (!resolved) return

  let receiverName: string | undefined
  if (resolved === "dict.update" || resolved === "dict.setdefault") {
    const receiver = unwrapParenthesized(entry.node.childForFieldName("arguments")?.namedChildren[0] ?? null)
    if (receiver?.type === "identifier") receiverName = receiver.text
  } else if (fn?.type === "attribute") {
    const receiver = unwrapParenthesized(fn.childForFieldName("object"))
    const method = fn.childForFieldName("attribute")?.text
    if (receiver?.type === "identifier" && (method === "update" || method === "setdefault")) receiverName = receiver.text
  } else {
    if (fn?.type !== "identifier") return
    const parts = resolved.split(".")
    const method = parts[parts.length - 1]
    if (!method || !TRACKED_MAPPING_VALUE_INVALIDATING_METHODS.has(method)) return
    receiverName = parts.slice(0, -1).join(".") || undefined
  }

  if (!receiverName) return
  clearTrackedMappingValueContainerKind(entry.scope, receiverName)
  clearExactStringIterableProvenance(entry.scope, receiverName)
  clearTrackedReceiverContainers(entry.scope, receiverName)
}

export function clearIndirectSetitemMutations(entry: TimelineEntry, helperReceiverElementKinds?: HelperReceiverElementKinds) {
  if (entry.kind !== "call") return
  const rawFn = entry.node.childForFieldName("function")
  const fn = unwrapParenthesized(rawFn)
  const resolved = resolvedName(fn ?? rawFn, entry.scope)
  if (!resolved) return

  let receiverName: string | undefined
  let receiverNode: Node | null = null
  const aliasedReceiver = fn?.type === "identifier" ? boundSetitemReceiver(entry.scope, fn.text) : undefined
  if (resolved === "dict.__setitem__" || resolved === "list.__setitem__") {
    const receiver = unwrapParenthesized(entry.node.childForFieldName("arguments")?.namedChildren[0] ?? null)
    receiverNode = receiver
    if (receiver?.type === "identifier") receiverName = receiver.text
  } else if (fn?.type === "attribute" && fn.childForFieldName("attribute")?.text === "__setitem__") {
    const receiver = unwrapParenthesized(fn.childForFieldName("object"))
    receiverNode = receiver
    if (receiver?.type === "identifier") receiverName = receiver.text
  } else if (fn?.type === "identifier" && resolved.endsWith(".__setitem__")) {
    receiverName = resolved.slice(0, -".__setitem__".length) || undefined
  }

  const receiverInfoPath = receiverNode ? trackableReceiverInfo(receiverNode)?.path : aliasedReceiver?.path
  const receiverCanonicalPath = receiverNode ? canonicalReceiverPath(receiverNode, entry.scope) : aliasedReceiver?.canonicalPath
  const equivalentPath = receiverNode ? receiverEquivalentPath(entry.scope, receiverNode) : aliasedReceiver?.equivalentPaths?.[0]
  const equivalentPaths = receiverNode ? receiverEquivalentPaths(entry.scope, receiverNode) : aliasedReceiver?.equivalentPaths
  if (!receiverName) {
    clearReceiverContainerPath(entry.scope, receiverInfoPath, receiverCanonicalPath)
    clearReceiverElementKindPath(entry.scope, receiverInfoPath, receiverCanonicalPath)
    clearReceiverSeedableStringListPath(entry.scope, receiverInfoPath, receiverCanonicalPath)
    clearSiblingSubscriptReceiverPaths(entry.scope, receiverInfoPath, receiverCanonicalPath, equivalentPath)
    clearSiblingSubscriptReceiverContainers(entry.scope, receiverInfoPath, receiverCanonicalPath, equivalentPaths)
    clearHelperReceiverElementKindPath(helperReceiverElementKinds, receiverInfoPath, receiverCanonicalPath)
    clearHelperSiblingSubscriptReceiverPaths(entry.scope, helperReceiverElementKinds, receiverInfoPath, receiverCanonicalPath, equivalentPath)
    return
  }
  const receiverKind = containerInstance(entry.scope, receiverName)
  if (receiverKind === "list") {
    clearIteratedElementProvenance(entry.scope, receiverName)
    clearIteratedPathProvenance(entry.scope, receiverName)
    clearIteratedContainerTupleProvenance(entry.scope, receiverName)
    clearIteratedPathTupleProvenance(entry.scope, receiverName)
    clearExactStringSetProvenance(entry.scope, receiverName)
    clearIteratedExactStringTupleProvenance(entry.scope, receiverName)
    clearExactIteratedStringSetProvenance(entry.scope, receiverName)
    clearSeedablePathListProvenance(entry.scope, receiverName)
    clearSeedableTupleListProvenance(entry.scope, receiverName)
    clearReceiverContainerPath(entry.scope, receiverInfoPath, receiverCanonicalPath)
    clearReceiverElementKindPath(entry.scope, receiverInfoPath, receiverCanonicalPath)
    clearReceiverSeedableStringListPath(entry.scope, receiverInfoPath, receiverCanonicalPath)
    clearSiblingSubscriptReceiverPaths(entry.scope, receiverInfoPath, receiverCanonicalPath, equivalentPath)
    clearSiblingSubscriptReceiverContainers(entry.scope, receiverInfoPath, receiverCanonicalPath, equivalentPaths)
    clearHelperReceiverElementKindPath(helperReceiverElementKinds, receiverInfoPath, receiverCanonicalPath)
    clearHelperSiblingSubscriptReceiverPaths(entry.scope, helperReceiverElementKinds, receiverInfoPath, receiverCanonicalPath, equivalentPath)
    return
  }

  clearReceiverContainerPath(entry.scope, receiverInfoPath, receiverCanonicalPath)
  clearReceiverElementKindPath(entry.scope, receiverInfoPath, receiverCanonicalPath)
  clearReceiverSeedableStringListPath(entry.scope, receiverInfoPath, receiverCanonicalPath)
  clearSiblingSubscriptReceiverPaths(entry.scope, receiverInfoPath, receiverCanonicalPath, equivalentPath)
  clearSiblingSubscriptReceiverContainers(entry.scope, receiverInfoPath, receiverCanonicalPath, equivalentPaths)
  clearHelperReceiverElementKindPath(helperReceiverElementKinds, receiverInfoPath, receiverCanonicalPath)
  clearHelperSiblingSubscriptReceiverPaths(entry.scope, helperReceiverElementKinds, receiverInfoPath, receiverCanonicalPath, equivalentPath)
  clearTrackedMappingValueContainerKind(entry.scope, receiverName)
  clearExactStringIterableProvenance(entry.scope, receiverName)
  clearTrackedReceiverContainers(entry.scope, receiverName)
}

function clearTrustedModuleRoot(current: Scope, receiver: Node | null, target: string) {
  if (receiver?.type !== "identifier") return
  const resolvedTarget = resolvedName(receiver, current)
  if (resolvedTarget !== target) return
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const names = new Set<string>([receiver.text, target])
    for (const key of scope.bindings.keys()) {
      if (resolveQualified(key, current) === target) names.add(key)
    }
    for (const key of scope.trustedModuleRoots) {
      if (key === target || resolveQualified(key, current) === target) names.add(key)
    }
    for (const name of names) invalidateTrackedName(scope, name)
  }
}

function clearTrustedDifflibRoot(current: Scope, receiver: Node | null) {
  clearTrustedModuleRoot(current, receiver, "difflib")
}

function clearTrustedFnmatchRoot(current: Scope, receiver: Node | null) {
  clearTrustedModuleRoot(current, receiver, "fnmatch")
}

function clearTrustedHashlibRoot(current: Scope, receiver: Node | null) {
  clearTrustedModuleRoot(current, receiver, "hashlib")
}

function clearTrustedOsRoot(current: Scope, receiver: Node | null) {
  clearTrustedModuleRoot(current, receiver, "os")
}

function clearTrustedStructRoot(current: Scope, receiver: Node | null) {
  clearTrustedModuleRoot(current, receiver, "struct")
}

function clearTrustedOciModelMetadataMaps(current: Scope, receiver: Node | null) {
  if (receiver?.type !== "identifier") return
  const rawRoot = receiver.text
  const resolvedRoot = resolvedName(receiver, current) ?? rawRoot
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    for (const key of [...scope.receiverContainers.keys()]) {
      const root = key.split(".")[0]
      const attribute = key.split(".").pop()
      if (!root || !attribute || !OCI_MODEL_METADATA_ATTRIBUTES.has(attribute)) continue
      const resolvedKeyRoot = resolveQualified(root, current) ?? root
      if (root === rawRoot || resolvedKeyRoot === resolvedRoot) scope.receiverContainers.delete(key)
    }
  }
}

function clearTrackedMappingValueContainerKind(current: Scope, name: string) {
  const target = resolveQualified(name, current)
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const keys = new Set<string>([name])
    if (target) {
      keys.add(target)
      for (const key of scope.containerInstances.keys()) {
        if (resolveQualified(key, current) === target) keys.add(key)
      }
    }
    for (const key of keys) {
      const kind = scope.containerInstances.get(key)
      if (kind && TRACKED_MAPPING_VALUE_KINDS.has(kind)) scope.containerInstances.delete(key)
    }
  }
}

function clearTrackedReceiverContainers(current: Scope, name: string) {
  const target = resolveQualified(name, current)
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    for (const key of Array.from(scope.receiverContainers.keys())) {
      const root = subscriptRootPrefix(key) ?? key.split(".")[0]
      const resolvedRoot = root ? (resolveQualified(root, current) ?? root) : undefined
      if (root === name || root === target || resolvedRoot === target) scope.receiverContainers.delete(key)
    }
  }
}

function canonicalReceiverPath(node: Node | null, current: Scope) {
  if (!node) return
  if (node.type === "identifier") {
    const resolved = resolvedName(node, current)
    if (resolved && resolved !== node.text) return resolved
  }
  const info = trackableReceiverInfo(node)
  if (!info) return
  const base = node.childForFieldName("value") ?? node.childForFieldName("object")
  const rawBase = base?.text
  const resolvedBase = resolvedName(base, current)
  if (rawBase && resolvedBase && resolvedBase !== rawBase && info.path.startsWith(rawBase)) {
    return `${resolvedBase}${info.path.slice(rawBase.length)}`
  }
  return info.path
}

function subscriptRootName(node: Node | null): string | undefined {
  if (!node) return
  if (node.type === "identifier") return node.text
  if (node.type === "subscript") return subscriptRootName(node.childForFieldName("value"))
}

function subscriptRootPrefix(path: string | undefined) {
  if (!path) return
  const index = path.indexOf("[")
  if (index <= 0) return
  return path.slice(0, index)
}

function subscriptRootPrefixes(path: string | undefined, canonicalPath?: string) {
  return Array.from(new Set([subscriptRootPrefix(path), subscriptRootPrefix(canonicalPath)].filter(Boolean) as string[]))
}

function isEquivalentSubscriptPath(path: string) {
  return path.includes("[=")
}

function equivalentSubscriptIdentity(path: string, current: Scope) {
  if (!isEquivalentSubscriptPath(path)) return
  const root = subscriptRootPrefix(path)
  const start = path.indexOf("[")
  if (!root || start < 0) return
  const resolvedRoot = resolveQualified(root, current) ?? root
  return `${resolvedRoot}${path.slice(start)}`
}

function clearReceiverElementKindPath(current: Scope, path: string | undefined, canonicalPath?: string) {
  if (!path && !canonicalPath) return
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    if (path) scope.receiverElementKinds.delete(path)
    if (canonicalPath) scope.receiverElementKinds.delete(canonicalPath)
  }
}

function clearReceiverSeedableStringListPath(current: Scope, path: string | undefined, canonicalPath?: string) {
  if (!path && !canonicalPath) return
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    if (path) scope.receiverSeedableStringLists.delete(path)
    if (canonicalPath) scope.receiverSeedableStringLists.delete(canonicalPath)
  }
}

function clearReceiverContainerPath(current: Scope, path: string | undefined, canonicalPath?: string) {
  if (!path && !canonicalPath) return
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    if (path) scope.receiverContainers.delete(path)
    if (canonicalPath) scope.receiverContainers.delete(canonicalPath)
  }
}

function clearReceiverContainerPaths(current: Scope, paths: string[] | undefined) {
  if (!paths || paths.length === 0) return
  for (const path of paths) clearReceiverContainerPath(current, path)
}

function clearClassModuleReceiverContainer(current: Scope, receiver: Node | null) {
  if (receiver?.type !== "identifier") return
  clearReceiverContainerPath(current, `${receiver.text}.__module__`)
  const resolved = resolvedName(receiver, current)
  if (resolved && resolved !== receiver.text) clearReceiverContainerPath(current, `${resolved}.__module__`)
}

function clearSiblingSubscriptReceiverPaths(current: Scope, path: string | undefined, canonicalPath?: string, equivalentPath?: string) {
  const rootPrefixes = subscriptRootPrefixes(path, canonicalPath)
  if (rootPrefixes.length === 0) return
  const targetRoots = new Set(rootPrefixes.map((prefix) => resolveQualified(prefix, current) ?? prefix))
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    for (const key of Array.from(scope.receiverElementKinds.keys())) {
      const keyRoot = subscriptRootPrefix(key)
      const resolvedKeyRoot = keyRoot ? (resolveQualified(keyRoot, scope) ?? keyRoot) : undefined
      if (key === path || key === canonicalPath) continue
      if (
        resolvedKeyRoot &&
        targetRoots.has(resolvedKeyRoot) &&
        !(
          equivalentPath &&
          isEquivalentSubscriptPath(key) &&
          equivalentSubscriptIdentity(key, scope) !== equivalentSubscriptIdentity(equivalentPath, current)
        )
      ) {
        scope.receiverElementKinds.delete(key)
      }
    }
    for (const key of Array.from(scope.receiverSeedableStringLists.keys())) {
      const keyRoot = subscriptRootPrefix(key)
      const resolvedKeyRoot = keyRoot ? (resolveQualified(keyRoot, scope) ?? keyRoot) : undefined
      if (key === path || key === canonicalPath) continue
      if (
        resolvedKeyRoot &&
        targetRoots.has(resolvedKeyRoot) &&
        !(
          equivalentPath &&
          isEquivalentSubscriptPath(key) &&
          equivalentSubscriptIdentity(key, scope) !== equivalentSubscriptIdentity(equivalentPath, current)
        )
      ) {
        scope.receiverSeedableStringLists.delete(key)
      }
    }
  }
}

function clearSiblingSubscriptReceiverContainers(current: Scope, path: string | undefined, canonicalPath?: string, equivalentPaths?: string[]) {
  const rootPrefixes = subscriptRootPrefixes(path, canonicalPath)
  if (rootPrefixes.length === 0) return
  const targetRoots = new Set(rootPrefixes.map((prefix) => resolveQualified(prefix, current) ?? prefix))
  const preserved = new Set((equivalentPaths ?? []).map((item) => equivalentSubscriptIdentity(item, current)).filter(Boolean) as string[])
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    for (const key of Array.from(scope.receiverContainers.keys())) {
      const keyRoot = subscriptRootPrefix(key)
      const resolvedKeyRoot = keyRoot ? (resolveQualified(keyRoot, scope) ?? keyRoot) : undefined
      if (key === path || key === canonicalPath) continue
      if (
        resolvedKeyRoot &&
        targetRoots.has(resolvedKeyRoot) &&
        !(preserved.size > 0 && isEquivalentSubscriptPath(key) && preserved.has(equivalentSubscriptIdentity(key, scope) ?? ""))
      ) {
        scope.receiverContainers.delete(key)
      }
    }
  }
}

function clearHelperReceiverElementKindPath(helperReceiverElementKinds: HelperReceiverElementKinds | undefined, path: string | undefined, canonicalPath?: string) {
  if (!helperReceiverElementKinds || (!path && !canonicalPath)) return
  for (const scoped of helperReceiverElementKinds.values()) {
    if (path) scoped.delete(path)
    if (canonicalPath) scoped.delete(canonicalPath)
  }
}

function clearHelperSiblingSubscriptReceiverPaths(
  current: Scope,
  helperReceiverElementKinds: HelperReceiverElementKinds | undefined,
  path: string | undefined,
  canonicalPath?: string,
  equivalentPath?: string,
) {
  if (!helperReceiverElementKinds) return
  const rootPrefixes = subscriptRootPrefixes(path, canonicalPath)
  if (rootPrefixes.length === 0) return
  const targetRoots = new Set(rootPrefixes.map((prefix) => resolveQualified(prefix, current) ?? prefix))
  for (const [ownerScope, scoped] of helperReceiverElementKinds) {
    for (const key of Array.from(scoped.keys())) {
      const keyRoot = subscriptRootPrefix(key)
      const resolvedKeyRoot = keyRoot ? (resolveQualified(keyRoot, ownerScope) ?? keyRoot) : undefined
      if (key === path || key === canonicalPath) continue
      if (
        resolvedKeyRoot &&
        targetRoots.has(resolvedKeyRoot) &&
        !(
          equivalentPath &&
          isEquivalentSubscriptPath(key) &&
          equivalentSubscriptIdentity(key, ownerScope) !== equivalentSubscriptIdentity(equivalentPath, current)
        )
      ) {
        scoped.delete(key)
      }
    }
  }
}

function clearHelperReceiverDeps(helperReceiverElementKinds: HelperReceiverElementKinds | undefined, deps: string[]) {
  if (!helperReceiverElementKinds || deps.length === 0) return
  const target = new Set(deps)
  for (const scoped of helperReceiverElementKinds.values()) {
    for (const [key, tracked] of scoped) {
      if (tracked.deps.some((dep) => target.has(dep))) scoped.delete(key)
    }
  }
}

function scopedHelperReceiverElementKinds(helperReceiverElementKinds: HelperReceiverElementKinds | undefined, current: Scope) {
  if (!helperReceiverElementKinds) return
  let scoped = helperReceiverElementKinds.get(current)
  if (!scoped) {
    scoped = new Map<string, ReceiverContainer>()
    helperReceiverElementKinds.set(current, scoped)
  }
  return scoped
}

function shouldPersistCanonicalReceiverPath(receiver: Node | null, rawPath: string, canonicalPath: string | undefined) {
  if (!canonicalPath || canonicalPath === rawPath) return false
  return receiver?.type !== "subscript"
}

function receiverEquivalentPath(current: Scope, receiver: Node | null) {
  return equivalentSubscriptValuePath(current, receiver)
}

function receiverEquivalentPaths(current: Scope, receiver: Node | null) {
  return equivalentSubscriptValuePaths(current, receiver)
}

function receiverEquivalentDeps(receiver: Node | null, fallbackDeps: string[]) {
  if (receiver?.type !== "subscript") return fallbackDeps
  const base = receiver.childForFieldName("value")
  if (base?.type !== "identifier") return fallbackDeps
  return [base.text]
}

function markReceiverSeedableStringList(current: Scope, receiver: Node | null) {
  const info = trackableReceiverInfo(receiver)
  if (!info) return
  const canonicalPath = canonicalReceiverPath(receiver, current)
  const equivalentPath = receiverEquivalentPath(current, receiver)
  const equivalentDeps = receiverEquivalentDeps(receiver, info.deps)
  current.receiverSeedableStringLists.set(info.path, info.deps)
  if (shouldPersistCanonicalReceiverPath(receiver, info.path, canonicalPath)) current.receiverSeedableStringLists.set(canonicalPath!, info.deps)
  if (equivalentPath && equivalentPath !== info.path && equivalentPath !== canonicalPath) current.receiverSeedableStringLists.set(equivalentPath, equivalentDeps)
}

function hasReceiverSeedableStringList(
  current: Scope,
  path: string | undefined,
  canonicalPath?: string,
  deps: string[] = [],
  equivalentPath?: string,
) {
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    if (
      (path && scope.receiverSeedableStringLists.has(path)) ||
      (canonicalPath && scope.receiverSeedableStringLists.has(canonicalPath)) ||
      (equivalentPath && scope.receiverSeedableStringLists.has(equivalentPath))
    ) {
      return true
    }
    if (deps.some((dep) => scope.bindings.has(dep))) return false
  }
  return false
}

function seedReceiverStringElementKind(current: Scope, receiver: Node | null) {
  const info = trackableReceiverInfo(receiver)
  if (!info) return
  const canonicalPath = canonicalReceiverPath(receiver, current)
  const equivalentPath = receiverEquivalentPath(current, receiver)
  const equivalentDeps = receiverEquivalentDeps(receiver, info.deps)
  current.receiverElementKinds.set(info.path, { kind: "string", deps: info.deps })
  if (shouldPersistCanonicalReceiverPath(receiver, info.path, canonicalPath)) {
    current.receiverElementKinds.set(canonicalPath!, { kind: "string", deps: info.deps })
  }
  if (equivalentPath && equivalentPath !== info.path && equivalentPath !== canonicalPath) {
    current.receiverElementKinds.set(equivalentPath, { kind: "string", deps: equivalentDeps })
  }
  clearReceiverSeedableStringListPath(current, info.path, canonicalPath)
  if (equivalentPath) clearReceiverSeedableStringListPath(current, equivalentPath)
  if (receiver?.type === "identifier") current.iteratedElementInstances.set(receiver.text, "string")
}

function helperReceiverElementKind(helperReceiverElementKinds: HelperReceiverElementKinds | undefined, receiver: Node | null, current: Scope) {
  if (!helperReceiverElementKinds) return
  const info = trackableReceiverInfo(receiver)
  if (!info) return
  const canonicalPath = canonicalReceiverPath(receiver, current)
  const equivalentPath = receiverEquivalentPath(current, receiver)
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    const scoped = helperReceiverElementKinds.get(scope)
    if (!scoped) continue
    const tracked = scoped.get(info.path) ?? (canonicalPath ? scoped.get(canonicalPath) : undefined) ?? (equivalentPath ? scoped.get(equivalentPath) : undefined)
    if (!tracked) continue
    for (let cursor: Scope | undefined = current; cursor && cursor !== scope; cursor = cursor.parent) {
      if (tracked.deps.some((dep) => cursor.bindings.has(dep))) return
    }
    return tracked.kind
  }
}

function seedHelperReceiverStringElementKind(helperReceiverElementKinds: HelperReceiverElementKinds | undefined, current: Scope, receiver: Node | null) {
  if (!helperReceiverElementKinds) return
  const info = trackableReceiverInfo(receiver)
  if (!info) return
  const tracked: ReceiverContainer = { kind: "string", deps: info.deps }
  const canonicalPath = canonicalReceiverPath(receiver, current)
  const equivalentPath = receiverEquivalentPath(current, receiver)
  const equivalentTracked: ReceiverContainer = { kind: "string", deps: receiverEquivalentDeps(receiver, info.deps) }
  const scoped = scopedHelperReceiverElementKinds(helperReceiverElementKinds, current)
  if (!scoped) return
  scoped.set(info.path, tracked)
  if (shouldPersistCanonicalReceiverPath(receiver, info.path, canonicalPath)) scoped.set(canonicalPath!, tracked)
  if (equivalentPath && equivalentPath !== info.path && equivalentPath !== canonicalPath) scoped.set(equivalentPath, equivalentTracked)
}

function hasPersistedReceiverStringElementKind(current: Scope, path: string | undefined, canonicalPath?: string, equivalentPath?: string) {
  return Boolean(
    (path && current.receiverElementKinds.has(path)) ||
      (canonicalPath && current.receiverElementKinds.has(canonicalPath)) ||
      (equivalentPath && current.receiverElementKinds.has(equivalentPath)),
  )
}

export function replayImportEntry(entry: TimelineEntry, rules: Rules) {
  for (const binding of importBindings(entry.node)) {
    invalidateTrackedName(entry.scope, binding.name)
    entry.scope.trustedBindings.add(binding.name)
    if (binding.direct) entry.scope.trustedDirectBindings.add(binding.name)
    if (binding.direct && binding.target) entry.scope.directImportTargets.set(binding.name, binding.target)
    if (binding.direct) seedTrustedOciModelMetadataMaps(entry.scope, binding.name, binding.target)
    if (binding.direct) seedTrustedTabulateFormatsElements(entry.scope, binding.name, binding.target)
    if (shouldTrustModuleBinding(binding.target)) entry.scope.trustedModuleBindings.add(binding.name)
    if (binding.moduleRoot) entry.scope.trustedModuleRoots.add(binding.name)
    if (binding.target && (!binding.direct || shouldBindDirectImport(binding.target, rules))) {
      entry.scope.bindings.set(binding.name, binding.target)
    }
  }
}

function applyHelperSeeds(entry: TimelineEntry, helperSeeds: HelperSeeds) {
  const targetScope = entry.bodyScope
  if (!targetScope) return
  const seeds = helperSeeds.get(entry.startIndex)
  if (!seeds) return
  for (const [name, seed] of seeds) {
    if (seed.containerKind) targetScope.containerInstances.set(name, seed.containerKind)
    if (seed.iteratedElementKind) targetScope.iteratedElementInstances.set(name, seed.iteratedElementKind)
    if (seed.exactStrings) targetScope.exactStringSets.set(name, seed.exactStrings)
    if (seed.pathValue) targetScope.pathInstances.set(name, seed.pathValue)
  }
}

function registerActiveHelper(
  activeByScope: Map<Scope, Map<string, ActiveHelper>>,
  allHelpers: ActiveHelper[],
  current: Scope,
  name: string | undefined,
  params: string[],
  bodyScope: Scope | undefined,
  startIndex: number,
) {
  if (!name || !bodyScope || params.length === 0) return
  const helper: ActiveHelper = {
    definitionStart: startIndex,
    params,
    bodyScope,
    seeds: params.map(() => undefined),
    blocked: false,
    observedCalls: 0,
  }
  let bucket = activeByScope.get(current)
  if (!bucket) {
    bucket = new Map<string, ActiveHelper>()
    activeByScope.set(current, bucket)
  }
  bucket.set(name, helper)
  allHelpers.push(helper)
}

function directBoundSetitemReceiver(node: Node | null, current: Scope) {
  node = unwrapParenthesized(node)
  if (!node || node.type !== "attribute" || node.childForFieldName("attribute")?.text !== "__setitem__") return
  const receiver = unwrapParenthesized(node.childForFieldName("object"))
  if (!receiver) return
  return {
    path: trackableReceiverInfo(receiver)?.path,
    canonicalPath: canonicalReceiverPath(receiver, current),
    equivalentPaths: receiverEquivalentPaths(current, receiver),
  }
}

function lookupActiveHelper(activeByScope: Map<Scope, Map<string, ActiveHelper>>, current: Scope, name: string, allowParent: boolean) {
  for (let scope: Scope | undefined = current; scope; scope = allowParent ? scope.parent : undefined) {
    const helper = activeByScope.get(scope)?.get(name)
    if (helper) return helper
    if (!allowParent) return
    if (scope !== current && (scope.bindings.has(name) || scope.localDefinitions.has(name))) return
  }
}

export function replayDefinitionEntry(entry: TimelineEntry, helperSeeds?: HelperSeeds, helperReturnKinds?: HelperReturnKinds) {
  const name = definitionName(entry.node)
  if (name) {
    invalidateTrackedName(entry.scope, name)
    entry.scope.localDefinitions.add(name)
  }
  if (helperSeeds) applyHelperSeeds(entry, helperSeeds)
  if (name) {
    const helperReturnKind = helperReturnKinds?.get(entry.startIndex)
    if (helperReturnKind) entry.scope.callableFactoryContainers.set(name, helperReturnKind)
  }
  const summary = callableFactory(entry.node)
  if (summary) entry.scope.callableFactories.set(summary.name, summary.returned)
}

export function replayRebindEntry(entry: TimelineEntry) {
  const target = rebindTarget(entry.node)
  const names = assignedNames(target ?? null)
  for (const targetName of names) invalidateTrackedName(entry.scope, targetName)
  for (const seeded of rebindPathValues(target ?? null, rebindSource(entry.node) ?? null, entry.scope)) {
    entry.scope.pathInstances.set(seeded.name, seeded.value)
  }
  for (const seeded of rebindContainerKinds(target ?? null, rebindSource(entry.node) ?? null, entry.scope)) {
    entry.scope.containerInstances.set(seeded.name, seeded.kind)
  }
  for (const seeded of rebindTupleContainerSlotKinds(target ?? null, rebindSource(entry.node) ?? null, entry.scope)) {
    setTupleContainerSlotProvenance(entry.scope, seeded.name, seeded.kinds)
  }
  for (const seeded of rebindExactStringTupleSlots(target ?? null, rebindSource(entry.node) ?? null, entry.scope)) {
    entry.scope.exactStringSets.set(seeded.name, seeded.values)
  }
  for (const seeded of rebindItemsKeyExactStrings(target ?? null, rebindSource(entry.node) ?? null, entry.scope)) {
    entry.scope.exactStringSets.set(seeded.name, seeded.values)
  }
  for (const seeded of rebindReceiverContainerKinds(target ?? null, rebindSource(entry.node) ?? null, entry.scope)) {
    entry.scope.receiverContainers.set(seeded.path, { kind: seeded.kind, deps: seeded.deps })
  }
  const exactStrings = exactIteratedStringSet(entry.scope, rebindSource(entry.node) ?? null)
  if (exactStrings) {
    if (target?.type === "identifier") {
      entry.scope.exactStringSets.set(target.text, exactStrings)
    } else if (target && (target.type.endsWith("_pattern") || target.type === "list" || target.type === "tuple")) {
      const second = target.namedChildren[1]
      if (second) {
        for (const name of assignedNames(second).filter((name) => name !== "_")) {
          entry.scope.exactStringSets.set(name, exactStrings)
        }
      }
    }
  }
  invalidateGuardReceiverSnapshots(entry.guards, names)
}

export function replayAssignmentEntry(
  entry: TimelineEntry,
  rules: Rules,
  hasAtlassianImportProvenance: boolean,
  helperSeeds?: HelperSeeds,
  helperReceiverElementKinds?: HelperReceiverElementKinds,
  helperReturnKinds?: HelperReturnKinds,
) {
  ensureGuardSnapshots(entry.scope, entry.guards)
  const left = assignmentLeft(entry.node)
  const invalidatedGuardNames = assignedNames(left)
  const finish = () => invalidateGuardReceiverSnapshots(entry.guards, invalidatedGuardNames)
  const right = assignmentRight(entry.node)
  if (helperSeeds && right?.type === "lambda") applyHelperSeeds(entry, helperSeeds)
  const factoryTarget = callableFactoryTarget(right, entry.scope, right?.type === "call" ? args(right) : undefined)
  const localPath = trackedPathValue(right, entry.scope)
  const localValue = exactNodeValue(entry.scope, right, entry.guards)
  const localExactStrings = exactStringSet(entry.scope, right, entry.guards)
  const localExactIteratedStrings = exactIteratedStringSet(entry.scope, right, entry.guards)
  const iteratedExactStringTuple = iteratedExactStringTupleValues(right, entry.scope)
  const iteratedContainerTuple = iteratedContainerTupleValues(right, entry.scope)
  const iteratedPath = iteratedPathValue(right, entry.scope)
  const iteratedPathTuple = iteratedPathTupleValues(right, entry.scope)
  const localContainer = trackedContainerKind(right, entry.scope) ?? returnedTrackedContainerKind(right, entry.scope)
  const tupleContainerSlots = tupleContainerSlotKinds(right, entry.scope)
  const iteratedElement = iteratedContainerKind(right, entry.scope)
  const target = aliasTarget(right, entry.scope)
  const leftResolved = left?.type === "identifier" ? resolvedName(left, entry.scope) : undefined
  const escapedReceiverInfoPath = left?.type === "identifier" && right?.type === "subscript" ? trackableReceiverInfo(right)?.path : undefined
  const escapedReceiverPath = left?.type === "identifier" && right?.type === "subscript" ? canonicalReceiverPath(right, entry.scope) : undefined
  const escapedEquivalentPaths = left?.type === "identifier" && right?.type === "subscript" ? receiverEquivalentPaths(entry.scope, right) : undefined
  const escapedEquivalentPath = left?.type === "identifier" && right?.type === "subscript" ? receiverEquivalentPath(entry.scope, right) : undefined
  const assignedCall = right?.type === "call" ? resolvedName(right.childForFieldName("function"), entry.scope) : undefined
  const invalidations = trackableInvalidationDeps(left, assignedNames)
  for (const targetName of assignedNames(left)) invalidateTrackedName(entry.scope, targetName)
  if (left?.type === "subscript") {
    const base = left.childForFieldName("value")
    const leftCanonicalPath = canonicalReceiverPath(left, entry.scope)
    const leftInfo = trackableReceiverInfo(left)
    const leftEquivalentPaths = receiverEquivalentPaths(entry.scope, left)
    const leftEquivalentPath = receiverEquivalentPath(entry.scope, left)
    clearSiblingSubscriptReceiverContainers(entry.scope, leftInfo?.path, leftCanonicalPath, leftEquivalentPaths)
    clearSiblingSubscriptReceiverPaths(entry.scope, leftInfo?.path, leftCanonicalPath, leftEquivalentPath)
    clearHelperSiblingSubscriptReceiverPaths(entry.scope, helperReceiverElementKinds, leftInfo?.path, leftCanonicalPath, leftEquivalentPath)
    if (leftCanonicalPath) clearIteratedElementProvenance(entry.scope, leftCanonicalPath)
    if (base?.type === "identifier") {
      clearIteratedElementProvenance(entry.scope, base.text)
      clearIteratedExactStringTupleProvenance(entry.scope, base.text)
      clearIteratedContainerTupleProvenance(entry.scope, base.text)
      clearIteratedPathTupleProvenance(entry.scope, base.text)
      clearExactIteratedStringSetProvenance(entry.scope, base.text)
      clearTupleContainerSlotProvenance(entry.scope, base.text)
      clearSeedableTupleListProvenance(entry.scope, base.text)
      clearTrackedMappingValueContainerKind(entry.scope, base.text)
    }
    clearReceiverContainerPath(entry.scope, leftInfo?.path, leftCanonicalPath)
    clearReceiverElementKindPath(entry.scope, leftInfo?.path, leftCanonicalPath)
    clearReceiverSeedableStringListPath(entry.scope, leftInfo?.path, leftCanonicalPath)
    clearHelperReceiverElementKindPath(helperReceiverElementKinds, leftInfo?.path, leftCanonicalPath)
    if (leftEquivalentPaths?.length) {
      clearReceiverContainerPaths(entry.scope, leftEquivalentPaths)
    }
    if (leftEquivalentPath) {
      clearReceiverElementKindPath(entry.scope, leftEquivalentPath)
      clearReceiverSeedableStringListPath(entry.scope, leftEquivalentPath)
      clearHelperReceiverElementKindPath(helperReceiverElementKinds, leftEquivalentPath)
    }
    const baseInfo = trackableReceiverInfo(base)
    const baseCanonicalPath = canonicalReceiverPath(base, entry.scope)
    if (baseCanonicalPath) clearIteratedElementProvenance(entry.scope, baseCanonicalPath)
    clearReceiverElementKindPath(entry.scope, baseInfo?.path, canonicalReceiverPath(base, entry.scope))
    clearReceiverSeedableStringListPath(entry.scope, baseInfo?.path, canonicalReceiverPath(base, entry.scope))
    clearHelperReceiverElementKindPath(helperReceiverElementKinds, baseInfo?.path, canonicalReceiverPath(base, entry.scope))
  }
  clearReceiverDeps(entry.scope, invalidations)
  clearHelperReceiverDeps(helperReceiverElementKinds, invalidations)
  if (escapedReceiverInfoPath || escapedReceiverPath) {
    clearReceiverContainerPath(entry.scope, escapedReceiverInfoPath, escapedReceiverPath)
    clearReceiverElementKindPath(entry.scope, escapedReceiverInfoPath, escapedReceiverPath)
    clearReceiverSeedableStringListPath(entry.scope, escapedReceiverInfoPath, escapedReceiverPath)
    clearHelperReceiverElementKindPath(helperReceiverElementKinds, escapedReceiverInfoPath, escapedReceiverPath)
  }
  if (escapedEquivalentPaths?.length) {
    clearReceiverContainerPaths(entry.scope, escapedEquivalentPaths)
  }
  if (escapedEquivalentPath) {
    clearReceiverElementKindPath(entry.scope, escapedEquivalentPath)
    clearReceiverSeedableStringListPath(entry.scope, escapedEquivalentPath)
    clearHelperReceiverElementKindPath(helperReceiverElementKinds, escapedEquivalentPath)
  }
  if (left?.type === "attribute" && left.childForFieldName("attribute")?.text === "default_factory") {
    const receiver = left.childForFieldName("object")
    if (receiver?.type === "identifier") clearTrackedMappingValueContainerKind(entry.scope, receiver.text)
  }
  if (left?.type === "attribute") {
    const attribute = left.childForFieldName("attribute")?.text
    if (attribute && OCI_MODEL_METADATA_ATTRIBUTES.has(attribute)) {
      clearTrustedOciModelMetadataMaps(entry.scope, left.childForFieldName("object"))
    }
    if (attribute && DIFFLIB_MUTABLE_TRUSTED_ATTRIBUTES.has(attribute)) {
      clearTrustedDifflibRoot(entry.scope, left.childForFieldName("object"))
    }
    if (attribute && FNMATCH_MUTABLE_TRUSTED_ATTRIBUTES.has(attribute)) {
      clearTrustedFnmatchRoot(entry.scope, left.childForFieldName("object"))
    }
    if (attribute && HASHLIB_MUTABLE_TRUSTED_ATTRIBUTES.has(attribute)) {
      clearTrustedHashlibRoot(entry.scope, left.childForFieldName("object"))
    }
    if (attribute && OS_MUTABLE_TRUSTED_ATTRIBUTES.has(attribute)) {
      clearTrustedOsRoot(entry.scope, left.childForFieldName("object"))
    }
    if (attribute && STRUCT_MUTABLE_TRUSTED_ATTRIBUTES.has(attribute)) {
      clearTrustedStructRoot(entry.scope, left.childForFieldName("object"))
    }
    if (attribute === "model_validate") {
      clearTrustedModelDumpFactory(entry.scope, left.childForFieldName("object"))
    }
    if (attribute === "model_dump") {
      const receiver = left.childForFieldName("object")
      if (trustedModelDumpFactoryRoot(entry.scope, receiver)) {
        clearTrustedModelDumpFactory(entry.scope, receiver)
        clearAllTrustedModelDumpInstances(entry.scope)
      }
      if (receiver?.type === "identifier") clearTrustedModelDumpInstance(entry.scope, receiver.text)
    }
  }
  if (left?.type === "attribute" && left.childForFieldName("attribute")?.text === "__module__") {
    clearClassModuleReceiverContainer(entry.scope, left.childForFieldName("object"))
  }
  if (applyAssignmentProvenance(entry.scope, left, localContainer, localPath)) {
    if (left?.type === "subscript" && localContainer) {
      const leftInfo = trackableReceiverInfo(left)
      const equivalentPaths = receiverEquivalentPaths(entry.scope, left)
      if (equivalentPaths?.length && leftInfo) {
        for (const equivalentPath of equivalentPaths) {
          if (equivalentPath === leftInfo.path) continue
          entry.scope.receiverContainers.set(equivalentPath, { kind: localContainer, deps: receiverEquivalentDeps(left, leftInfo.deps) })
        }
      }
    }
    if (left?.type === "subscript" && right?.type === "list" && right.namedChildren.length === 0) {
      markReceiverSeedableStringList(entry.scope, left)
    }
    finish()
    return
  }
  if (!left || left.type !== "identifier") {
    if (left) {
      for (const seeded of rebindContainerKinds(left, right, entry.scope)) {
        entry.scope.containerInstances.set(seeded.name, seeded.kind)
      }
      for (const seeded of rebindTupleContainerSlotKinds(left, right, entry.scope)) {
        setTupleContainerSlotProvenance(entry.scope, seeded.name, seeded.kinds)
      }
      for (const seeded of rebindExactStringTupleSlots(left, right, entry.scope)) {
        entry.scope.exactStringSets.set(seeded.name, seeded.values)
      }
      for (const seeded of rebindItemsKeyExactStrings(left, right, entry.scope)) {
        entry.scope.exactStringSets.set(seeded.name, seeded.values)
      }
    }
    finish()
    return
  }

  if (right?.type === "lambda") {
    entry.scope.localDefinitions.add(left.text)
    const helperReturnKind = helperReturnKinds?.get(entry.startIndex)
    if (helperReturnKind) entry.scope.callableFactoryContainers.set(left.text, helperReturnKind)
  }

  if (entry.node.type !== "assignment") {
    clearIteratedElementProvenance(entry.scope, left.text)
    clearIteratedExactStringTupleProvenance(entry.scope, left.text)
    clearIteratedContainerTupleProvenance(entry.scope, left.text)
    clearExactIteratedStringSetProvenance(entry.scope, left.text)
    clearIteratedPathProvenance(entry.scope, left.text)
    clearTupleContainerSlotProvenance(entry.scope, left.text)
    clearSeedablePathListProvenance(entry.scope, left.text)
    clearSeedableTupleListProvenance(entry.scope, left.text)
    if (leftResolved && leftResolved !== left.text) {
      clearIteratedElementProvenance(entry.scope, leftResolved)
      clearIteratedExactStringTupleProvenance(entry.scope, leftResolved)
      clearIteratedContainerTupleProvenance(entry.scope, leftResolved)
      clearExactIteratedStringSetProvenance(entry.scope, leftResolved)
      clearIteratedPathProvenance(entry.scope, leftResolved)
      clearTupleContainerSlotProvenance(entry.scope, leftResolved)
      clearSeedablePathListProvenance(entry.scope, leftResolved)
      clearSeedableTupleListProvenance(entry.scope, leftResolved)
    }
    finish()
    return
  }

  if (localValue) entry.scope.valueInstances.set(left.text, localValue)
  if (localExactStrings) entry.scope.exactStringSets.set(left.text, localExactStrings)
  if (localExactIteratedStrings) entry.scope.exactIteratedStringSets.set(left.text, localExactIteratedStrings)
  if (iteratedExactStringTuple) setIteratedExactStringTupleProvenance(entry.scope, left.text, iteratedExactStringTuple)
  if (iteratedContainerTuple) setIteratedContainerTupleProvenance(entry.scope, left.text, iteratedContainerTuple)
  if (iteratedPathTuple) entry.scope.iteratedPathTupleInstances.set(left.text, iteratedPathTuple)
  if (tupleContainerSlots) {
    setTupleContainerSlotProvenance(entry.scope, left.text, tupleContainerSlots)
  }
  if (right?.type === "list" && right.namedChildren.length === 0) {
    markSeedablePathList(entry.scope, left.text)
    markSeedableTupleList(entry.scope, left.text)
  } else if (right?.type === "identifier" && hasSeedablePathList(entry.scope, right.text)) {
    markSeedablePathList(entry.scope, left.text)
  } else if (right?.type === "identifier" && hasSeedableTupleList(entry.scope, right.text)) {
    markSeedableTupleList(entry.scope, left.text)
  }

  if (factoryTarget) {
    entry.scope.bindings.set(left.text, factoryTarget)
    finish()
    return
  }

  if (localPath) {
    entry.scope.pathInstances.set(left.text, localPath)
  }

  if (iteratedPath) {
    entry.scope.iteratedPathInstances.set(left.text, iteratedPath)
  }

  if (localContainer) {
    entry.scope.containerInstances.set(left.text, localContainer)
    if (iteratedElement) {
      entry.scope.iteratedElementInstances.set(left.text, iteratedElement)
    }
    const containerAlias = target ?? (right?.type === "subscript" && (localContainer === "list" || localContainer === "set") ? (trackableReceiverInfo(right)?.path ?? canonicalReceiverPath(right, entry.scope)) : undefined)
    if (containerAlias) {
      entry.scope.bindings.set(left.text, containerAlias)
      clearReceiverSeedableStringListPath(entry.scope, containerAlias)
      clearHelperReceiverElementKindPath(helperReceiverElementKinds, containerAlias)
    }
    finish()
    return
  }

  if (iteratedElement) {
    entry.scope.iteratedElementInstances.set(left.text, iteratedElement)
    const iteratedAlias = right?.type === "subscript" ? (trackableReceiverInfo(right)?.path ?? canonicalReceiverPath(right, entry.scope)) : undefined
    if (iteratedAlias) entry.scope.bindings.set(left.text, iteratedAlias)
  }

  if (target) {
    const boundReceiver = directBoundSetitemReceiver(right, entry.scope) ?? (right?.type === "identifier" ? boundSetitemReceiver(entry.scope, right.text) : undefined)
    if (boundReceiver) entry.scope.boundSetitemReceivers.set(left.text, boundReceiver)
    entry.scope.bindings.set(left.text, target)
    if (trustedAliasSource(right, entry.scope)) entry.scope.trustedBindings.add(left.text)
    finish()
    return
  }

  if (!right || right.type !== "call" || !assignedCall) {
    finish()
    return
  }

  if (assignedCall === "sqlite3.connect") {
    entry.scope.sqliteConnectionInstances.set(left.text, `sqlite-connection:${right.startIndex}`)
  }

  seedSqliteCursorInstance(entry.scope, left.text, right)
  seedTrustedModelDumpInstance(entry.scope, left.text, right)

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
  finish()
}

function helperSeedFromArgument(node: Node | null, current: Scope, helperReceiverElementKinds?: HelperReceiverElementKinds): HelperParamSeed | undefined {
  const directContainerKind = node?.type === "identifier" ? containerInstance(current, node.text) : undefined
  const directIteratedElementKind = node?.type === "identifier" ? iteratedElementInstance(current, node.text) : undefined
  const containerKind = trackedReceiverContainerKind(node, current) ?? trackedContainerKind(node, current) ?? returnedTrackedContainerKind(node, current) ?? directContainerKind
  const iteratedElementKind = iteratedContainerKind(node, current) ?? helperReceiverElementKind(helperReceiverElementKinds, node, current) ?? directIteratedElementKind
  const exactStrings = exactStringSet(current, node)
  const pathValue = trackedPathValue(node, current)
  const seed: HelperParamSeed = {}
  if (containerKind && HELPER_PARAM_CONTAINER_KINDS.has(containerKind)) seed.containerKind = containerKind
  if (iteratedElementKind === "string") seed.iteratedElementKind = "string"
  if (exactStrings) seed.exactStrings = exactStrings
  if (pathValue) seed.pathValue = pathValue
  return seed.containerKind || seed.iteratedElementKind || seed.exactStrings || seed.pathValue ? seed : undefined
}

function samePathValue(left: Value | undefined, right: Value | undefined) {
  if (!left && !right) return true
  if (!left || !right) return false
  return left.dynamic === right.dynamic && left.literal === right.literal
}

function sameExactStrings(left: string[] | undefined, right: string[] | undefined) {
  return left?.length === right?.length && (left ?? []).every((value, index) => right?.[index] === value)
}

function sameHelperSeed(left: HelperParamSeed | undefined, right: HelperParamSeed | undefined) {
  return left?.containerKind === right?.containerKind && left?.iteratedElementKind === right?.iteratedElementKind && samePathValue(left?.pathValue, right?.pathValue)
}

function mergePathValues(current: Value | undefined, next: Value): Value {
  if (!current) return next
  if (current.dynamic || next.dynamic) return { dynamic: true }
  if (current.literal === next.literal) return current
  return { dynamic: true }
}

function directHelperCallName(entry: TimelineEntry) {
  if (entry.kind !== "call") return
  const fn = entry.node.childForFieldName("function")
  if (fn?.type !== "identifier") return
  return fn.text
}

function collectHelperReturnValues(node: Node | null, returnValues: Array<Node | null>) {
  if (!node) return
  if (node.type === "function_definition" || node.type === "lambda" || node.type === "class_definition" || node.type === "decorated_definition") {
    return
  }
  if (node.type === "return_statement") {
    returnValues.push(node.childForFieldName("value") ?? node.namedChildren[0] ?? null)
    return
  }
  for (const child of node.namedChildren) collectHelperReturnValues(child, returnValues)
}

function helperReturnValues(node: Node) {
  if (node.type === "lambda") return [node.childForFieldName("body")]
  const def = definitionNode(node)
  if (def?.type !== "function_definition") return [] as Array<Node | null>
  const body = def.childForFieldName("body")
  const returnValues: Array<Node | null> = []
  collectHelperReturnValues(body, returnValues)
  const tail = body?.namedChildren[body.namedChildren.length - 1]
  if (tail?.type !== "return_statement") returnValues.push(null)
  return returnValues
}

function helperReturnContainerKind(returnValues: Array<Node | null>, current: Scope) {
  if (returnValues.length === 0) return
  let merged: ContainerKind | undefined
  for (const value of returnValues) {
    const kind = trackedContainerKind(value, current) ?? returnedTrackedContainerKind(value, current)
    if (!kind || !HELPER_RETURN_CONTAINER_KINDS.has(kind)) return
    if (!merged) {
      merged = kind
      continue
    }
    if (merged !== kind) return
  }
  return merged
}

function helperRequiresSeeds(node: Node) {
  return parameterNames(node.childForFieldName("parameters")).length > 0
}

function registerHelperReturnCandidate(candidates: HelperReturnCandidate[], entry: TimelineEntry, name: string | undefined, node: Node | null) {
  if (!name || !node || !entry.bodyScope) return
  const returnValues = helperReturnValues(node)
  if (returnValues.length === 0) return
  candidates.push({ definitionStart: entry.startIndex, name, bodyScope: entry.bodyScope, returnValues, requiresSeeds: helperRequiresSeeds(node), blocked: false })
}

function escapeHelperByAlias(activeByScope: Map<Scope, Map<string, ActiveHelper>>, current: Scope, left: Node | null, right: Node | null) {
  const source = unwrapParenthesized(right)
  if (left?.type !== "identifier" || source?.type !== "identifier" || left.text === source.text) return
  const helper = activeByScope.get(current)?.get(source.text)
  if (helper) helper.blocked = true
}

function escapeHelperReturnByAlias(candidates: HelperReturnCandidate[], entry: TimelineEntry, left: Node | null, right: Node | null) {
  const source = unwrapParenthesized(right)
  if (left?.type !== "identifier" || source?.type !== "identifier" || left.text === source.text) return
  for (const candidate of candidates) {
    if (candidate.bodyScope.parent === entry.scope && candidate.name === source.text) candidate.blocked = true
  }
}

function sameTupleContainerKinds(left: ContainerKind[] | undefined, right: ContainerKind[] | undefined) {
  return Boolean(left && right && left.length === right.length && left.every((kind, index) => right[index] === kind))
}

function uniqueTupleStrings(values: string[]) {
  const unique = Array.from(new Set(values))
  if (unique.length === 0 || unique.length > MAX_EXACT_TUPLE_STRINGS) return
  return unique
}

function iteratedExactStringTupleValues(node: Node | null, current: Scope): string[][] | undefined {
  node = unwrapParenthesized(node)
  if (!node) return

  if (node.type === "identifier") {
    return iteratedExactStringTupleInstance(current, node.text)
  }

  if (node.type !== "list" && node.type !== "tuple") return
  const tuples = node.namedChildren
  if (tuples.length === 0) return
  if (!tuples.every((child) => child.type === "list" || child.type === "tuple")) return
  const width = tuples[0]?.namedChildren.length ?? 0
  if (width === 0 || !tuples.every((child) => child.namedChildren.length === width)) return

  const slots: string[][] = []
  for (let index = 0; index < width; index += 1) {
    const values: string[] = []
    for (const tuple of tuples) {
      const exact = exactStringSet(current, tuple.namedChildren[index] ?? null)
      if (!exact) return
      values.push(...exact)
    }
    const unique = uniqueTupleStrings(values)
    if (!unique) return
    slots.push(unique)
  }
  return slots
}

function exactStringTupleAssignments(target: Node | null, slotValues: string[][]) {
  if (!target) return [] as Array<{ name: string; values: string[] }>
  if (!(target.type === "tuple" || target.type === "list" || target.type === "pattern_list" || target.type === "tuple_pattern" || target.type === "list_pattern")) {
    return [] as Array<{ name: string; values: string[] }>
  }
  if (target.namedChildren.length !== slotValues.length || !target.namedChildren.every((child) => child.type === "identifier")) {
    return [] as Array<{ name: string; values: string[] }>
  }
  return target.namedChildren
    .map((child, index) => ({ child, values: slotValues[index] }))
    .filter((item): item is { child: Node; values: string[] } => Boolean(item.child && item.values))
    .flatMap(({ child, values }) => assignedNames(child).filter((name) => name !== "_").map((name) => ({ name, values })))
}

function rebindExactStringTupleSlots(target: Node | null, source: Node | null, current: Scope) {
  const slotValues = iteratedExactStringTupleValues(source, current)
  if (!slotValues) return [] as Array<{ name: string; values: string[] }>
  return exactStringTupleAssignments(target, slotValues)
}

function itemsKeyExactStrings(node: Node | null, current: Scope) {
  if (!node || node.type !== "call") return
  const fn = node.childForFieldName("function")
  if (fn?.type !== "attribute") return
  const call = resolvedName(fn, current)
  const parts = call?.split(".") ?? []
  const method = parts[parts.length - 1]
  if (method !== "items") return
  const input = args(node)
  if (input.positional.length !== 0 || Object.keys(input.keyword).length !== 0 || hasDictionarySplat(node)) return
  return exactIteratedStringSet(current, fn.childForFieldName("object"))
}

function rebindItemsKeyExactStrings(target: Node | null, source: Node | null, current: Scope) {
  const keys = itemsKeyExactStrings(source, current)
  if (!keys || !target) return [] as Array<{ name: string; values: string[] }>
  if (!(target.type === "tuple" || target.type === "list" || target.type === "pattern_list" || target.type === "tuple_pattern" || target.type === "list_pattern")) {
    return [] as Array<{ name: string; values: string[] }>
  }
  const first = target.namedChildren[0]
  if (!first) return [] as Array<{ name: string; values: string[] }>
  return assignedNames(first).filter((name) => name !== "_").map((name) => ({ name, values: keys }))
}

export function updateMutatedTupleListSlotKinds(entry: TimelineEntry) {
  if (entry.kind !== "call") return
  const rawFn = entry.node.childForFieldName("function")
  const fn = unwrapParenthesized(rawFn)
  const resolved = resolvedName(fn, entry.scope)
  let receiverName: string | undefined
  let method: string | undefined
  if (resolved === "list.append" || resolved === "list.insert" || resolved === "list.extend") {
    const receiver = unwrapParenthesized(entry.node.childForFieldName("arguments")?.namedChildren[0] ?? null)
    if (receiver?.type !== "identifier") return
    receiverName = receiver.text
    const parts = resolved.split(".")
    method = parts[parts.length - 1]
  } else if (fn?.type === "attribute") {
    const receiver = unwrapParenthesized(fn.childForFieldName("object"))
    if (receiver?.type !== "identifier") return
    receiverName = receiver.text
    method = fn.childForFieldName("attribute")?.text
  } else if (fn?.type === "identifier" && resolved) {
    const parts = resolved.split(".")
    method = parts[parts.length - 1]
    receiverName = parts.slice(0, -1).join(".") || undefined
    if (!receiverName) return
  } else {
    return
  }
  if (!method || (method !== "append" && method !== "insert" && method !== "extend")) return
  const receiverKind = containerInstance(entry.scope, receiverName)
  if (receiverKind !== "list") return

  if (resolved === "list.append" || resolved === "list.insert" || resolved === "list.extend") {
    clearIteratedContainerTupleProvenance(entry.scope, receiverName)
    clearIteratedExactStringTupleProvenance(entry.scope, receiverName)
    clearSeedableTupleListProvenance(entry.scope, receiverName)
    return
  }

  if (fn?.type === "identifier") {
    clearIteratedContainerTupleProvenance(entry.scope, receiverName)
    clearIteratedExactStringTupleProvenance(entry.scope, receiverName)
    clearSeedableTupleListProvenance(entry.scope, receiverName)
    return
  }

  const argNodes = entry.node.childForFieldName("arguments")?.namedChildren ?? []
  const valueNode = method === "append" ? (argNodes[0] ?? null) : method === "insert" ? (argNodes[1] ?? null) : (argNodes[0] ?? null)
  const nextKinds = method === "extend" ? iteratedContainerTupleValues(valueNode, entry.scope) : tupleContainerSlotKinds(valueNode, entry.scope)
  const currentKinds = entry.scope.iteratedContainerTupleInstances.get(receiverName)
  clearIteratedExactStringTupleProvenance(entry.scope, receiverName)
  if (nextKinds && ((currentKinds && sameTupleContainerKinds(currentKinds, nextKinds)) || (!currentKinds && hasSeedableTupleList(entry.scope, receiverName)))) {
    setIteratedContainerTupleProvenance(entry.scope, receiverName, nextKinds)
    clearSeedableTupleListProvenance(entry.scope, receiverName)
    return
  }

  clearIteratedContainerTupleProvenance(entry.scope, receiverName)
  clearSeedableTupleListProvenance(entry.scope, receiverName)
}

export function updateMutatedIteratedPathInstance(entry: TimelineEntry) {
  if (entry.kind !== "call") return
  const rawFn = entry.node.childForFieldName("function")
  const fn = unwrapParenthesized(rawFn)
  const resolved = resolvedName(fn, entry.scope)
  let receiverName: string | undefined
  let method: string | undefined
  if (resolved === "list.append" || resolved === "list.insert" || resolved === "list.extend") {
    const receiver = unwrapParenthesized(entry.node.childForFieldName("arguments")?.namedChildren[0] ?? null)
    if (receiver?.type !== "identifier") return
    receiverName = receiver.text
    const parts = resolved.split(".")
    method = parts[parts.length - 1]
  } else if (fn?.type === "attribute") {
    const receiver = unwrapParenthesized(fn.childForFieldName("object"))
    if (receiver?.type !== "identifier") return
    receiverName = receiver.text
    method = fn.childForFieldName("attribute")?.text
  } else if (fn?.type === "identifier" && resolved) {
    const parts = resolved.split(".")
    method = parts[parts.length - 1]
    receiverName = parts.slice(0, -1).join(".") || undefined
    if (!receiverName) return
  } else {
    return
  }
  if (!method || (method !== "append" && method !== "insert" && method !== "extend")) return
  const receiverKind = containerInstance(entry.scope, receiverName)
  if (receiverKind !== "list") return

  if (resolved === "list.append" || resolved === "list.insert" || resolved === "list.extend" || fn?.type === "identifier") {
    clearIteratedPathProvenance(entry.scope, receiverName)
    clearSeedablePathListProvenance(entry.scope, receiverName)
    return
  }

  const argNodes = entry.node.childForFieldName("arguments")?.namedChildren ?? []
  const valueNode = method === "append" ? (argNodes[0] ?? null) : method === "insert" ? (argNodes[1] ?? null) : (argNodes[0] ?? null)
  const nextValue = method === "extend" ? iteratedPathValue(valueNode, entry.scope) : trackedPathValue(valueNode, entry.scope)
  const currentValue = entry.scope.iteratedPathInstances.get(receiverName)
  if (nextValue && (currentValue || hasSeedablePathList(entry.scope, receiverName))) {
    entry.scope.iteratedPathInstances.set(receiverName, mergePathValues(currentValue, nextValue))
    clearSeedablePathListProvenance(entry.scope, receiverName)
    return
  }

  clearIteratedPathProvenance(entry.scope, receiverName)
  clearSeedablePathListProvenance(entry.scope, receiverName)
}

export function clearMutatedIteratedElementInstance(entry: TimelineEntry) {
  if (entry.kind !== "call") return
  const rawFn = entry.node.childForFieldName("function")
  const fn = unwrapParenthesized(rawFn)
  const resolved = resolvedName(fn ?? rawFn, entry.scope)
  let receiverName: string | undefined
  let method: string | undefined
  if (resolved === "list.append" || resolved === "list.extend" || resolved === "list.insert") {
    const receiver = unwrapParenthesized(entry.node.childForFieldName("arguments")?.namedChildren[0] ?? null)
    if (receiver?.type !== "identifier") return
    receiverName = receiver.text
    const parts = resolved.split(".")
    method = parts[parts.length - 1]
  } else if (fn?.type === "attribute") {
    const receiver = unwrapParenthesized(fn.childForFieldName("object"))
    const parts = resolved?.split(".")
    method = parts && parts.length > 0 ? parts[parts.length - 1] : undefined
    if (receiver?.type === "identifier") receiverName = receiver.text
  } else if (fn?.type === "identifier" && resolved) {
    const parts = resolved.split(".")
    method = parts[parts.length - 1]
    receiverName = parts.slice(0, -1).join(".") || undefined
  }
  if (!receiverName || !method || !ITERATED_ELEMENT_INVALIDATING_METHODS.has(method)) return
  clearIteratedElementProvenance(entry.scope, receiverName)
  clearIteratedPathTupleProvenance(entry.scope, receiverName)
  clearExactStringSetProvenance(entry.scope, receiverName)
  clearExactIteratedStringSetProvenance(entry.scope, receiverName)
}

export function clearMutatedMappingValueContainerKind(entry: TimelineEntry) {
  if (entry.kind !== "call") return
  const fn = entry.node.childForFieldName("function")
  if (fn?.type !== "identifier") return
  const resolved = resolvedName(fn, entry.scope)
  if (resolved !== "setattr") return
  const argNodes = entry.node.childForFieldName("arguments")?.namedChildren ?? []
  const receiver = argNodes[0] ?? null
  const attribute = exactNodeValue(entry.scope, argNodes[1] ?? null, entry.guards)
  if (receiver?.type !== "identifier" || !attribute || attribute.dynamic || attribute.literal !== "default_factory") return
  clearTrackedMappingValueContainerKind(entry.scope, receiver.text)
}

export function clearMutatedClassModuleReceiverContainer(entry: TimelineEntry) {
  if (entry.kind !== "call") return
  const fn = entry.node.childForFieldName("function")
  if (fn?.type !== "identifier") return
  const resolved = resolvedName(fn, entry.scope)
  if (resolved !== "setattr") return
  const argNodes = entry.node.childForFieldName("arguments")?.namedChildren ?? []
  const receiver = argNodes[0] ?? null
  const attribute = exactNodeValue(entry.scope, argNodes[1] ?? null, entry.guards)
  if (receiver?.type !== "identifier" || !attribute || attribute.dynamic || attribute.literal !== "__module__") return
  clearClassModuleReceiverContainer(entry.scope, receiver)
}

export function clearMutatedTrustedOciModelMetadataMaps(entry: TimelineEntry) {
  if (entry.kind !== "call") return
  const fn = entry.node.childForFieldName("function")
  if (fn?.type !== "identifier") return
  const resolved = resolvedName(fn, entry.scope)
  if (resolved !== "setattr") return
  const argNodes = entry.node.childForFieldName("arguments")?.namedChildren ?? []
  const receiver = argNodes[0] ?? null
  const attribute = exactNodeValue(entry.scope, argNodes[1] ?? null, entry.guards)
  if (receiver?.type !== "identifier" || !attribute || attribute.dynamic || attribute.literal === undefined) return
  if (!OCI_MODEL_METADATA_ATTRIBUTES.has(attribute.literal)) return
  clearTrustedOciModelMetadataMaps(entry.scope, receiver)
}

export function clearMutatedTrustedDifflibCalls(entry: TimelineEntry) {
  if (entry.kind !== "call") return
  const fn = entry.node.childForFieldName("function")
  if (fn?.type !== "identifier") return
  const resolved = resolvedName(fn, entry.scope)
  if (resolved !== "setattr") return
  const argNodes = entry.node.childForFieldName("arguments")?.namedChildren ?? []
  const receiver = argNodes[0] ?? null
  const attribute = exactNodeValue(entry.scope, argNodes[1] ?? null, entry.guards)
  if (receiver?.type !== "identifier" || !attribute || attribute.dynamic || attribute.literal === undefined) return
  if (!DIFFLIB_MUTABLE_TRUSTED_ATTRIBUTES.has(attribute.literal)) return
  clearTrustedDifflibRoot(entry.scope, receiver)
}

export function clearMutatedTrustedFnmatchCalls(entry: TimelineEntry) {
  if (entry.kind !== "call") return
  const fn = entry.node.childForFieldName("function")
  if (fn?.type !== "identifier") return
  const resolved = resolvedName(fn, entry.scope)
  if (resolved !== "setattr") return
  const argNodes = entry.node.childForFieldName("arguments")?.namedChildren ?? []
  const receiver = argNodes[0] ?? null
  const attribute = exactNodeValue(entry.scope, argNodes[1] ?? null, entry.guards)
  if (receiver?.type !== "identifier" || !attribute || attribute.dynamic || attribute.literal === undefined) return
  if (!FNMATCH_MUTABLE_TRUSTED_ATTRIBUTES.has(attribute.literal)) return
  clearTrustedFnmatchRoot(entry.scope, receiver)
}

export function clearMutatedTrustedHashlibCalls(entry: TimelineEntry) {
  if (entry.kind !== "call") return
  const fn = entry.node.childForFieldName("function")
  if (fn?.type !== "identifier") return
  const resolved = resolvedName(fn, entry.scope)
  if (resolved !== "setattr") return
  const argNodes = entry.node.childForFieldName("arguments")?.namedChildren ?? []
  const receiver = argNodes[0] ?? null
  const attribute = exactNodeValue(entry.scope, argNodes[1] ?? null, entry.guards)
  if (receiver?.type !== "identifier" || !attribute || attribute.dynamic || attribute.literal === undefined) return
  if (!HASHLIB_MUTABLE_TRUSTED_ATTRIBUTES.has(attribute.literal)) return
  clearTrustedHashlibRoot(entry.scope, receiver)
}

export function clearMutatedTrustedOsCalls(entry: TimelineEntry) {
  if (entry.kind !== "call") return
  const fn = entry.node.childForFieldName("function")
  if (fn?.type !== "identifier") return
  const resolved = resolvedName(fn, entry.scope)
  if (resolved !== "setattr") return
  const argNodes = entry.node.childForFieldName("arguments")?.namedChildren ?? []
  const receiver = argNodes[0] ?? null
  const attribute = exactNodeValue(entry.scope, argNodes[1] ?? null, entry.guards)
  if (receiver?.type !== "identifier" || !attribute || attribute.dynamic || attribute.literal === undefined) return
  if (!OS_MUTABLE_TRUSTED_ATTRIBUTES.has(attribute.literal)) return
  clearTrustedOsRoot(entry.scope, receiver)
}

export function clearMutatedTrustedStructCalls(entry: TimelineEntry) {
  if (entry.kind !== "call") return
  const fn = entry.node.childForFieldName("function")
  if (fn?.type !== "identifier") return
  const resolved = resolvedName(fn, entry.scope)
  if (resolved !== "setattr") return
  const argNodes = entry.node.childForFieldName("arguments")?.namedChildren ?? []
  const receiver = argNodes[0] ?? null
  const attribute = exactNodeValue(entry.scope, argNodes[1] ?? null, entry.guards)
  if (receiver?.type !== "identifier" || !attribute || attribute.dynamic || attribute.literal === undefined) return
  if (!STRUCT_MUTABLE_TRUSTED_ATTRIBUTES.has(attribute.literal)) return
  clearTrustedStructRoot(entry.scope, receiver)
}

export function clearMutatedTrustedModelDumpPaths(entry: TimelineEntry) {
  if (entry.kind !== "call") return
  const fn = entry.node.childForFieldName("function")
  if (fn?.type !== "identifier") return
  const resolved = resolvedName(fn, entry.scope)
  if (resolved !== "setattr") return
  const argNodes = entry.node.childForFieldName("arguments")?.namedChildren ?? []
  const receiver = argNodes[0] ?? null
  const attribute = exactNodeValue(entry.scope, argNodes[1] ?? null, entry.guards)
  if (receiver?.type !== "identifier" || !attribute || attribute.dynamic || attribute.literal === undefined) return
  if (attribute.literal === "model_validate") {
    clearTrustedModelDumpFactory(entry.scope, receiver)
  }
  if (attribute.literal === "model_dump") {
    if (trustedModelDumpFactoryRoot(entry.scope, receiver)) {
      clearTrustedModelDumpFactory(entry.scope, receiver)
      clearAllTrustedModelDumpInstances(entry.scope)
    }
    clearTrustedModelDumpInstance(entry.scope, receiver.text)
  }
}

export function updateSqliteCursorExecution(entry: TimelineEntry) {
  if (entry.kind !== "call") return
  const fn = entry.node.childForFieldName("function")
  if (fn?.type !== "attribute") return
  const method = fn.childForFieldName("attribute")?.text
  const receiver = fn.childForFieldName("object")
  if (receiver?.type !== "identifier" || !method || !hasSqliteCursorInstance(entry.scope, receiver.text)) return
  if (method === "execute") {
    markExecutedSqliteCursorInstance(entry.scope, receiver.text)
    return
  }
  if (method === "close") {
    closeSqliteCursorInstance(entry.scope, receiver.text)
    return
  }
  if (SQLITE_CURSOR_READ_METHODS.has(method) && !hasExecutedSqliteCursorInstance(entry.scope, receiver.text)) {
    clearSqliteCursorInstance(entry.scope, receiver.text)
  }
}

function updateMutatedReceiverElementKindWithHelper(
  entry: TimelineEntry,
  helperReceiverElementKinds: HelperReceiverElementKinds | undefined,
  identifierReceiver: boolean,
  path: string | undefined,
  canonicalPath: string | undefined,
  method: string,
  receiver: Node | null,
) {
  const subscriptReceiver = receiver?.type === "subscript"
  const exactPathReceiver = subscriptReceiver && Boolean(helperReceiverElementKinds)
  const receiverInfo = trackableReceiverInfo(receiver)
  const equivalentPath = receiverEquivalentPath(entry.scope, receiver)
  const receiverBase = receiver?.type === "subscript" ? receiver.childForFieldName("value") : null
  const receiverBaseContainerKind =
    (receiverBase?.type === "identifier" ? containerInstance(entry.scope, receiverBase.text) : undefined) ??
    trackedContainerKind(receiverBase, entry.scope) ??
    returnedTrackedContainerKind(receiverBase, entry.scope)
  if (subscriptReceiver) {
    clearSiblingSubscriptReceiverPaths(entry.scope, path, canonicalPath, equivalentPath)
    clearHelperSiblingSubscriptReceiverPaths(entry.scope, helperReceiverElementKinds, path, canonicalPath, equivalentPath)
  }
  const trustedSubscriptRoot = subscriptReceiver && (
    hasReceiverSeedableStringList(entry.scope, path, canonicalPath, receiverInfo?.deps ?? [], equivalentPath) ||
    hasPersistedReceiverStringElementKind(entry.scope, path, canonicalPath, equivalentPath) ||
    (equivalentPath && receiverBaseContainerKind === "dict-list-values")
  )

  if (method === "append" || method === "insert") {
    if (canonicalPath) clearIteratedElementProvenance(entry.scope, canonicalPath)
    const argNodes = entry.node.childForFieldName("arguments")?.namedChildren ?? []
    const valueNode = method === "append" ? (argNodes[0] ?? null) : (argNodes[1] ?? null)
    if (
      helperSeedFromArgument(valueNode, entry.scope, helperReceiverElementKinds)?.containerKind === "string" &&
      ((identifierReceiver && (hasReceiverSeedableStringList(entry.scope, path, canonicalPath, receiverInfo?.deps ?? [], equivalentPath) || entry.scope.receiverElementKinds.has(path ?? "") || (canonicalPath ? entry.scope.receiverElementKinds.has(canonicalPath) : false) || (equivalentPath ? entry.scope.receiverElementKinds.has(equivalentPath) : false))) ||
        (subscriptReceiver && (trustedSubscriptRoot || (exactPathReceiver && helperReceiverElementKind(helperReceiverElementKinds, receiver, entry.scope) === "string"))))
    ) {
      if (identifierReceiver) seedReceiverStringElementKind(entry.scope, receiver)
      else if (helperReceiverElementKinds) seedHelperReceiverStringElementKind(helperReceiverElementKinds, entry.scope, receiver)
      else seedReceiverStringElementKind(entry.scope, receiver)
      return
    }
    clearReceiverElementKindPath(entry.scope, path, canonicalPath)
    clearReceiverSeedableStringListPath(entry.scope, path, canonicalPath)
    clearHelperReceiverElementKindPath(helperReceiverElementKinds, path, canonicalPath)
    if (equivalentPath) {
      clearReceiverElementKindPath(entry.scope, equivalentPath)
      clearReceiverSeedableStringListPath(entry.scope, equivalentPath)
      clearHelperReceiverElementKindPath(helperReceiverElementKinds, equivalentPath)
    }
    return
  }

  if (method === "extend") {
    if (canonicalPath) clearIteratedElementProvenance(entry.scope, canonicalPath)
    const valueNode = entry.node.childForFieldName("arguments")?.namedChildren[0] ?? null
    if (
      helperSeedFromArgument(valueNode, entry.scope, helperReceiverElementKinds)?.iteratedElementKind === "string" &&
      ((identifierReceiver && (hasReceiverSeedableStringList(entry.scope, path, canonicalPath, receiverInfo?.deps ?? [], equivalentPath) || entry.scope.receiverElementKinds.has(path ?? "") || (canonicalPath ? entry.scope.receiverElementKinds.has(canonicalPath) : false) || (equivalentPath ? entry.scope.receiverElementKinds.has(equivalentPath) : false))) ||
        (subscriptReceiver && (trustedSubscriptRoot || (exactPathReceiver && helperReceiverElementKind(helperReceiverElementKinds, receiver, entry.scope) === "string"))))
    ) {
      if (identifierReceiver) seedReceiverStringElementKind(entry.scope, receiver)
      else if (helperReceiverElementKinds) seedHelperReceiverStringElementKind(helperReceiverElementKinds, entry.scope, receiver)
      else seedReceiverStringElementKind(entry.scope, receiver)
      return
    }
    clearReceiverElementKindPath(entry.scope, path, canonicalPath)
    clearReceiverSeedableStringListPath(entry.scope, path, canonicalPath)
    clearHelperReceiverElementKindPath(helperReceiverElementKinds, path, canonicalPath)
    if (equivalentPath) {
      clearReceiverElementKindPath(entry.scope, equivalentPath)
      clearReceiverSeedableStringListPath(entry.scope, equivalentPath)
      clearHelperReceiverElementKindPath(helperReceiverElementKinds, equivalentPath)
    }
  }
}

export function updateMutatedReceiverElementKind(entry: TimelineEntry, helperReceiverElementKinds?: HelperReceiverElementKinds) {
  if (entry.kind !== "call") return
  const fn = entry.node.childForFieldName("function")
  if (fn?.type !== "attribute") return
  const receiver = fn.childForFieldName("object")
  const resolved = resolvedName(fn, entry.scope)
  const parts = resolved?.split(".")
  const method = parts && parts.length > 0 ? parts[parts.length - 1] : undefined
  if (!method) return
  const info = trackableReceiverInfo(receiver)
  const canonicalPath = canonicalReceiverPath(receiver, entry.scope)
  const equivalentPath = receiverEquivalentPath(entry.scope, receiver)
  if (receiver?.type === "subscript" && ITERATED_ELEMENT_INVALIDATING_METHODS.has(method)) {
    clearSiblingSubscriptReceiverPaths(entry.scope, info?.path, canonicalPath, equivalentPath)
    clearHelperSiblingSubscriptReceiverPaths(entry.scope, helperReceiverElementKinds, info?.path, canonicalPath, equivalentPath)
  }
  const receiverKind = trackedReceiverContainerKind(receiver, entry.scope)
  const resolvedReceiverKind = receiver?.type === "identifier" ? containerInstance(entry.scope, resolvedName(receiver, entry.scope) ?? receiver.text) : undefined
  if (
    receiver?.type === "identifier" &&
    (receiverKind && TRACKED_MAPPING_VALUE_KINDS.has(receiverKind) || (resolvedReceiverKind && TRACKED_MAPPING_VALUE_KINDS.has(resolvedReceiverKind))) &&
    TRACKED_MAPPING_VALUE_INVALIDATING_METHODS.has(method)
  ) {
    clearTrackedMappingValueContainerKind(entry.scope, receiver.text)
  }
  if (receiver?.type === "identifier" && TRACKED_MAPPING_VALUE_INVALIDATING_METHODS.has(method)) {
    clearExactStringIterableProvenance(entry.scope, receiver.text)
  }
  if (receiverKind !== "list") return
  updateMutatedReceiverElementKindWithHelper(entry, helperReceiverElementKinds, receiver?.type === "identifier", info?.path, canonicalPath, method, receiver)
}

export function clearEscapedReceiverPaths(entry: TimelineEntry, helperReceiverElementKinds?: HelperReceiverElementKinds) {
  const argsNode = entry.node.childForFieldName("arguments")
  if (!argsNode) return
  for (const child of argsNode.namedChildren) {
    const valueNode = child.type === "keyword_argument" ? child.childForFieldName("value") : child
    const canonicalPath = canonicalReceiverPath(valueNode, entry.scope)
    const equivalentPath = receiverEquivalentPath(entry.scope, valueNode)
    const info = trackableReceiverInfo(valueNode)
    if (!info && !canonicalPath) continue
    clearReceiverSeedableStringListPath(entry.scope, info?.path, canonicalPath)
    clearReceiverElementKindPath(entry.scope, info?.path, canonicalPath)
    clearHelperReceiverElementKindPath(helperReceiverElementKinds, info?.path, canonicalPath)
    if (equivalentPath) {
      clearReceiverSeedableStringListPath(entry.scope, equivalentPath)
      clearReceiverElementKindPath(entry.scope, equivalentPath)
      clearHelperReceiverElementKindPath(helperReceiverElementKinds, equivalentPath)
    }
  }
}

function helperInvalidationNames(entry: TimelineEntry) {
  if (entry.kind === "assignment") return assignedNames(assignmentLeft(entry.node))
  if (entry.kind === "rebind") return assignedNames(rebindTarget(entry.node) ?? null)
  if (entry.kind === "definition") {
    const name = definitionName(entry.node)
    return name ? [name] : []
  }
  if (entry.kind === "import") return importBindings(entry.node).map((binding) => binding.name)
  return [] as string[]
}

export function discoverHelperParamSeeds(
  timeline: TimelineEntry[],
  rules: Rules,
  hasAtlassianImportProvenance: boolean,
  helperReturnKinds?: HelperReturnKinds,
) {
  const activeByScope = new Map<Scope, Map<string, ActiveHelper>>()
  const allHelpers: ActiveHelper[] = []
  const helperReceiverElementKinds: HelperReceiverElementKinds = new Map()
  const comprehensionScopes = new Set<Scope>()

  for (const entry of timeline) {
    if (entry.kind === "import") {
      clearHelperReceiverDeps(helperReceiverElementKinds, helperInvalidationNames(entry))
      replayImportEntry(entry, rules)
    } else if (entry.kind === "definition") {
      clearHelperReceiverDeps(helperReceiverElementKinds, helperInvalidationNames(entry))
      replayDefinitionEntry(entry, undefined, helperReturnKinds)
      const def = definitionNode(entry.node)
      const params = def?.type === "function_definition" ? parameterNames(def.childForFieldName("parameters")) : []
      registerActiveHelper(activeByScope, allHelpers, entry.scope, definitionName(entry.node), params, entry.bodyScope, entry.startIndex)
    } else if (entry.kind === "rebind") {
      if (entry.node.type === "for_in_clause") comprehensionScopes.add(entry.scope)
      ensureGuardSnapshots(entry.scope, entry.guards)
      for (const name of helperInvalidationNames(entry)) activeByScope.get(entry.scope)?.delete(name)
      replayRebindEntry(entry)
    } else if (entry.kind === "assignment") {
      for (const name of helperInvalidationNames(entry)) activeByScope.get(entry.scope)?.delete(name)
      escapeHelperByAlias(activeByScope, entry.scope, assignmentLeft(entry.node), assignmentRight(entry.node))
      replayAssignmentEntry(entry, rules, hasAtlassianImportProvenance, undefined, helperReceiverElementKinds, helperReturnKinds)
      const left = assignmentLeft(entry.node)
      const right = assignmentRight(entry.node)
      const params = right?.type === "lambda" ? parameterNames(right.childForFieldName("parameters")) : []
      registerActiveHelper(activeByScope, allHelpers, entry.scope, left?.type === "identifier" ? left.text : undefined, params, entry.bodyScope, entry.startIndex)
    } else if (entry.kind === "call") {
      const name = directHelperCallName(entry)
      const helper = name ? lookupActiveHelper(activeByScope, entry.scope, name, comprehensionScopes.has(entry.scope)) : undefined
      if (helper) {
        helper.observedCalls += 1
        const input = args(entry.node)
        const argNodes = entry.node.childForFieldName("arguments")?.namedChildren ?? []
        if (hasDictionarySplat(entry.node) || Object.keys(input.keyword).length > 0 || input.positional.length !== helper.params.length || argNodes.length !== helper.params.length) {
          helper.blocked = true
        } else {
          for (const [index, argNode] of argNodes.entries()) {
            const seed = helperSeedFromArgument(argNode, entry.scope, helperReceiverElementKinds)
            const current = helper.seeds[index]
            if (!seed || (current && !sameHelperSeed(current, seed))) {
              helper.blocked = true
              break
            }
            const nextSeed: HelperParamSeed = {
              containerKind: seed.containerKind ?? current?.containerKind,
              iteratedElementKind: seed.iteratedElementKind ?? current?.iteratedElementKind,
              pathValue: seed.pathValue ? mergePathValues(current?.pathValue, seed.pathValue) : current?.pathValue,
            }
            if (!current) {
              if (seed.exactStrings) nextSeed.exactStrings = seed.exactStrings
            } else if (current.exactStrings && seed.exactStrings && sameExactStrings(current.exactStrings, seed.exactStrings)) {
              nextSeed.exactStrings = current.exactStrings
            }
            helper.seeds[index] = nextSeed
          }
        }
      } else {
        clearEscapedReceiverPaths(entry, helperReceiverElementKinds)
      }
      clearMutatedIteratedElementInstance(entry)
      updateMutatedIteratedPathInstance(entry)
      updateMutatedTupleListSlotKinds(entry)
      clearMutatedMappingValueContainerKind(entry)
      clearMutatedClassModuleReceiverContainer(entry)
      clearMutatedTrustedOciModelMetadataMaps(entry)
      clearMutatedTrustedDifflibCalls(entry)
      clearMutatedTrustedFnmatchCalls(entry)
      clearMutatedTrustedHashlibCalls(entry)
      clearMutatedTrustedOsCalls(entry)
      clearMutatedTrustedStructCalls(entry)
      clearMutatedTrustedModelDumpPaths(entry)
      clearIndirectMappingMutations(entry)
      clearIndirectSetitemMutations(entry, helperReceiverElementKinds)
      updateSqliteCursorExecution(entry)
      updateMutatedReceiverElementKind(entry, helperReceiverElementKinds)
    }
  }

  const results: HelperSeeds = new Map()
  for (const helper of allHelpers) {
    if (helper.blocked || helper.observedCalls === 0) continue
    const seeded = new Map<string, HelperParamSeed>()
    helper.params.forEach((name, index) => {
      const seed = helper.seeds[index]
      if (seed) seeded.set(name, seed)
    })
    if (seeded.size > 0) results.set(helper.definitionStart, seeded)
  }
  return results
}

export function discoverHelperReturnKinds(
  timeline: TimelineEntry[],
  helperSeeds: HelperSeeds,
  rules: Rules,
  hasAtlassianImportProvenance: boolean,
) {
  const candidates: HelperReturnCandidate[] = []

  for (const entry of timeline) {
    if (entry.kind === "import") {
      replayImportEntry(entry, rules)
      continue
    }

    if (entry.kind === "definition") {
      replayDefinitionEntry(entry, helperSeeds)
      registerHelperReturnCandidate(candidates, entry, definitionName(entry.node), definitionNode(entry.node) ?? null)
      continue
    }

    if (entry.kind === "rebind") {
      ensureGuardSnapshots(entry.scope, entry.guards)
      replayRebindEntry(entry)
      continue
    }

    if (entry.kind === "assignment") {
      escapeHelperReturnByAlias(candidates, entry, assignmentLeft(entry.node), assignmentRight(entry.node))
      replayAssignmentEntry(entry, rules, hasAtlassianImportProvenance, helperSeeds)
      const left = assignmentLeft(entry.node)
      const right = assignmentRight(entry.node)
      registerHelperReturnCandidate(candidates, entry, left?.type === "identifier" ? left.text : undefined, right?.type === "lambda" ? right : null)
      continue
    }

    clearEscapedReceiverPaths(entry)
    clearMutatedIteratedElementInstance(entry)
    updateMutatedIteratedPathInstance(entry)
    updateMutatedTupleListSlotKinds(entry)
    clearMutatedMappingValueContainerKind(entry)
    clearMutatedClassModuleReceiverContainer(entry)
    clearMutatedTrustedHashlibCalls(entry)
    clearMutatedTrustedModelDumpPaths(entry)
    clearMutatedTrustedDifflibCalls(entry)
    clearMutatedTrustedFnmatchCalls(entry)
    clearMutatedTrustedOsCalls(entry)
    clearMutatedTrustedStructCalls(entry)
    clearMutatedTrustedOciModelMetadataMaps(entry)
    clearIndirectMappingMutations(entry)
    clearIndirectSetitemMutations(entry)
    updateSqliteCursorExecution(entry)
    updateMutatedReceiverElementKind(entry)
  }

  const results: HelperReturnKinds = new Map()
  for (const candidate of candidates) {
    if (candidate.blocked) continue
    if (candidate.requiresSeeds && !helperSeeds.has(candidate.definitionStart)) continue
    const kind = helperReturnContainerKind(candidate.returnValues, candidate.bodyScope)
    if (kind) results.set(candidate.definitionStart, kind)
  }
  return results
}
