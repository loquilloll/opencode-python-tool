import type { PythonAstNode as Node } from "./frontend/interface"
import { atlassianFamilyForConstructor, isHttpResponseCall } from "./python-classifier"
import {
  args,
  hasDictionarySplat,
  iteratedContainerKind,
  iteratedPathValue,
  rebindContainerKinds,
  rebindPathValues,
  rebindSource,
  returnedTrackedContainerKind,
  trackedContainerKind,
  trackedReceiverContainerKind,
  trackedPathValue,
} from "./python-inference"
import { equivalentSubscriptValuePath, exactIteratedStringSet, exactNodeValue, exactStringSet } from "./python-key-equivalence"
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
  callableFactory,
  callableFactoryTarget,
  clearExactIteratedStringSetProvenance,
  clearExactStringSetProvenance,
  clearIteratedElementProvenance,
  containerInstance,
  importBindings,
  invalidateTrackedName,
  resolveQualified,
  resolvedName,
  shouldBindDirectImport,
  trustedAliasSource,
} from "./python-scope"
import {
  assignedNames,
  assignmentLeft,
  assignmentRight,
  definitionNode,
  definitionName,
  parameterNames,
  rebindTarget,
} from "./python-timeline"

export type HelperParamSeed = {
  containerKind?: ContainerKind
  iteratedElementKind?: ContainerKind
}

export type HelperSeeds = Map<number, Map<string, HelperParamSeed>>

type HelperReceiverElementKinds = Map<Scope, Map<string, ReceiverContainer>>

type ActiveHelper = {
  definitionStart: number
  params: string[]
  bodyScope: Scope
  seeds: Array<HelperParamSeed | undefined>
  blocked: boolean
  observedCalls: number
}

const ITERATED_ELEMENT_INVALIDATING_METHODS = new Set(["append", "extend", "insert"])

function shouldTrustModuleBinding(target: string | undefined) {
  return Boolean(target && TRUSTED_MODULE_BINDINGS.has(target))
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

export function replayDefinitionEntry(entry: TimelineEntry, helperSeeds?: HelperSeeds) {
  const name = definitionName(entry.node)
  if (name) {
    invalidateTrackedName(entry.scope, name)
    entry.scope.localDefinitions.add(name)
  }
  if (helperSeeds) applyHelperSeeds(entry, helperSeeds)
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
}

export function replayAssignmentEntry(
  entry: TimelineEntry,
  rules: Rules,
  hasAtlassianImportProvenance: boolean,
  helperSeeds?: HelperSeeds,
  helperReceiverElementKinds?: HelperReceiverElementKinds,
) {
  const left = assignmentLeft(entry.node)
  const right = assignmentRight(entry.node)
  if (helperSeeds && right?.type === "lambda") applyHelperSeeds(entry, helperSeeds)
  const factoryTarget = callableFactoryTarget(right, entry.scope, right?.type === "call" ? args(right) : undefined)
  const localPath = trackedPathValue(right, entry.scope)
  const localValue = exactNodeValue(entry.scope, right, entry.guards)
  const localExactStrings = exactStringSet(entry.scope, right, entry.guards)
  const localExactIteratedStrings = exactIteratedStringSet(entry.scope, right, entry.guards)
  const iteratedPath = iteratedPathValue(right, entry.scope)
  const localContainer = trackedContainerKind(right, entry.scope) ?? returnedTrackedContainerKind(right, entry.scope)
  const iteratedElement = iteratedContainerKind(right, entry.scope)
  const target = aliasTarget(right, entry.scope)
  const escapedReceiverInfoPath = left?.type === "identifier" && right?.type === "subscript" ? trackableReceiverInfo(right)?.path : undefined
  const escapedReceiverPath = left?.type === "identifier" && right?.type === "subscript" ? canonicalReceiverPath(right, entry.scope) : undefined
  const escapedEquivalentPath = left?.type === "identifier" && right?.type === "subscript" ? receiverEquivalentPath(entry.scope, right) : undefined
  const assignedCall = right?.type === "call" ? resolvedName(right.childForFieldName("function"), entry.scope) : undefined
  const invalidations = trackableInvalidationDeps(left, assignedNames)
  for (const targetName of assignedNames(left)) invalidateTrackedName(entry.scope, targetName)
  if (left?.type === "subscript") {
    const base = left.childForFieldName("value")
    const leftCanonicalPath = canonicalReceiverPath(left, entry.scope)
    const leftInfo = trackableReceiverInfo(left)
    const leftEquivalentPath = receiverEquivalentPath(entry.scope, left)
    clearSiblingSubscriptReceiverPaths(entry.scope, leftInfo?.path, leftCanonicalPath, leftEquivalentPath)
    clearHelperSiblingSubscriptReceiverPaths(entry.scope, helperReceiverElementKinds, leftInfo?.path, leftCanonicalPath, leftEquivalentPath)
    if (leftCanonicalPath) clearIteratedElementProvenance(entry.scope, leftCanonicalPath)
    if (base?.type === "identifier") {
      clearIteratedElementProvenance(entry.scope, base.text)
      clearExactIteratedStringSetProvenance(entry.scope, base.text)
      const resolvedBase = resolvedName(base, entry.scope)
      for (let scope: Scope | undefined = entry.scope; scope; scope = scope.parent) {
        const keys = new Set<string>([base.text])
        if (resolvedBase) {
          keys.add(resolvedBase)
          for (const key of scope.containerInstances.keys()) {
            if (resolveQualified(key, entry.scope) === resolvedBase) keys.add(key)
          }
        }
        for (const key of keys) {
          const kind = scope.containerInstances.get(key)
          if (kind === "dict-list-values" || kind === "dict-set-values") {
            scope.containerInstances.delete(key)
          }
        }
      }
    }
    clearReceiverElementKindPath(entry.scope, leftInfo?.path, leftCanonicalPath)
    clearReceiverSeedableStringListPath(entry.scope, leftInfo?.path, leftCanonicalPath)
    clearHelperReceiverElementKindPath(helperReceiverElementKinds, leftInfo?.path, leftCanonicalPath)
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
    clearReceiverElementKindPath(entry.scope, escapedReceiverInfoPath, escapedReceiverPath)
    clearReceiverSeedableStringListPath(entry.scope, escapedReceiverInfoPath, escapedReceiverPath)
    clearHelperReceiverElementKindPath(helperReceiverElementKinds, escapedReceiverInfoPath, escapedReceiverPath)
  }
  if (escapedEquivalentPath) {
    clearReceiverElementKindPath(entry.scope, escapedEquivalentPath)
    clearReceiverSeedableStringListPath(entry.scope, escapedEquivalentPath)
    clearHelperReceiverElementKindPath(helperReceiverElementKinds, escapedEquivalentPath)
  }
  if (applyAssignmentProvenance(entry.scope, left, localContainer, localPath)) {
    if (left?.type === "subscript" && right?.type === "list" && right.namedChildren.length === 0) {
      markReceiverSeedableStringList(entry.scope, left)
    }
    return
  }
  if (!left || left.type !== "identifier") return

  if (entry.node.type !== "assignment") return

  if (localValue) entry.scope.valueInstances.set(left.text, localValue)
  if (localExactStrings) entry.scope.exactStringSets.set(left.text, localExactStrings)
  if (localExactIteratedStrings) entry.scope.exactIteratedStringSets.set(left.text, localExactIteratedStrings)

  if (factoryTarget) {
    entry.scope.bindings.set(left.text, factoryTarget)
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
    return
  }

  if (iteratedElement) {
    entry.scope.iteratedElementInstances.set(left.text, iteratedElement)
    const iteratedAlias = right?.type === "subscript" ? (trackableReceiverInfo(right)?.path ?? canonicalReceiverPath(right, entry.scope)) : undefined
    if (iteratedAlias) entry.scope.bindings.set(left.text, iteratedAlias)
  }

  if (target) {
    entry.scope.bindings.set(left.text, target)
    if (trustedAliasSource(right, entry.scope)) entry.scope.trustedBindings.add(left.text)
    return
  }

  if (!right || right.type !== "call" || !assignedCall) {
    return
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
}

function helperSeedFromArgument(node: Node | null, current: Scope, helperReceiverElementKinds?: HelperReceiverElementKinds): HelperParamSeed | undefined {
  const containerKind = trackedContainerKind(node, current) ?? returnedTrackedContainerKind(node, current)
  const iteratedElementKind = iteratedContainerKind(node, current) ?? helperReceiverElementKind(helperReceiverElementKinds, node, current)
  const seed: HelperParamSeed = {}
  if (containerKind === "string") seed.containerKind = "string"
  if (iteratedElementKind === "string") seed.iteratedElementKind = "string"
  return seed.containerKind || seed.iteratedElementKind ? seed : undefined
}

function sameHelperSeed(left: HelperParamSeed | undefined, right: HelperParamSeed | undefined) {
  return left?.containerKind === right?.containerKind && left?.iteratedElementKind === right?.iteratedElementKind
}

function directHelperCallName(entry: TimelineEntry) {
  if (entry.kind !== "call") return
  const fn = entry.node.childForFieldName("function")
  if (fn?.type !== "identifier") return
  return fn.text
}

export function clearMutatedIteratedElementInstance(entry: TimelineEntry) {
  if (entry.kind !== "call") return
  const fn = entry.node.childForFieldName("function")
  if (fn?.type !== "attribute") return
  const receiver = fn.childForFieldName("object")
  const resolved = resolvedName(fn, entry.scope)
  const parts = resolved?.split(".")
  const method = parts && parts.length > 0 ? parts[parts.length - 1] : undefined
  if (receiver?.type !== "identifier" || !method || !ITERATED_ELEMENT_INVALIDATING_METHODS.has(method)) return
  clearIteratedElementProvenance(entry.scope, receiver.text)
  clearExactStringSetProvenance(entry.scope, receiver.text)
  clearExactIteratedStringSetProvenance(entry.scope, receiver.text)
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
) {
  const activeByScope = new Map<Scope, Map<string, ActiveHelper>>()
  const allHelpers: ActiveHelper[] = []
  const helperReceiverElementKinds: HelperReceiverElementKinds = new Map()

  for (const entry of timeline) {
    if (entry.kind === "import") {
      clearHelperReceiverDeps(helperReceiverElementKinds, helperInvalidationNames(entry))
      replayImportEntry(entry, rules)
    } else if (entry.kind === "definition") {
      clearHelperReceiverDeps(helperReceiverElementKinds, helperInvalidationNames(entry))
      replayDefinitionEntry(entry)
      const def = definitionNode(entry.node)
      const params = def?.type === "function_definition" ? parameterNames(def.childForFieldName("parameters")) : []
      registerActiveHelper(activeByScope, allHelpers, entry.scope, definitionName(entry.node), params, entry.bodyScope, entry.startIndex)
    } else if (entry.kind === "rebind") {
      for (const name of helperInvalidationNames(entry)) activeByScope.get(entry.scope)?.delete(name)
      replayRebindEntry(entry)
    } else if (entry.kind === "assignment") {
      for (const name of helperInvalidationNames(entry)) activeByScope.get(entry.scope)?.delete(name)
      replayAssignmentEntry(entry, rules, hasAtlassianImportProvenance, undefined, helperReceiverElementKinds)
      const left = assignmentLeft(entry.node)
      const right = assignmentRight(entry.node)
      const params = right?.type === "lambda" ? parameterNames(right.childForFieldName("parameters")) : []
      registerActiveHelper(activeByScope, allHelpers, entry.scope, left?.type === "identifier" ? left.text : undefined, params, entry.bodyScope, entry.startIndex)
    } else if (entry.kind === "call") {
      const name = directHelperCallName(entry)
      const helper = name ? activeByScope.get(entry.scope)?.get(name) : undefined
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
            helper.seeds[index] = seed
          }
        }
      } else {
        clearEscapedReceiverPaths(entry, helperReceiverElementKinds)
      }
      clearMutatedIteratedElementInstance(entry)
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
