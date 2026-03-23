import type { PythonAstTree as Tree } from "./frontend/interface"
import { getFrontend, loadRules } from "./python-bootstrap"
import { analysisResult, foldResolvedEffect, unique } from "./python-events"
import { atlassianFamilyForConstructor, classify, classifyRaise, isAtlassianImportStatement, isHttpResponseCall } from "./python-classifier"
import {
  args,
  hasDictionarySplat,
  iteratedContainerKind,
  iteratedPathValue,
  rebindContainerKinds,
  rebindPathValues,
  rebindSource,
  returnedTrackedContainerKind,
  trackedReceiverContainerKind,
  trackedContainerKind,
  trackedPathValue,
} from "./python-inference"
import { TRACKED_HTTP_CLIENT_CONSTRUCTORS } from "./python-known-methods"
import type { PythonEvent, Scope, TimelineEntry } from "./python-analyze-types"
import {
  analyzerMetadata,
  type PythonAnalyzeResult,
} from "./python-ir"
import {
  applyAssignmentProvenance,
  clearReceiverDeps,
  type ContainerKind,
  trackableReceiverInfo,
  trackableInvalidationDeps,
} from "./python-provenance"
import {
  aliasTarget,
  callableFactory,
  callableFactoryTarget,
  clearIteratedElementProvenance,
  importBindings,
  invalidateTrackedName,
  resolveQualified,
  resolvedName,
  scope,
  shouldBindDirectImport,
  trustedAliasSource,
} from "./python-scope"
import {
  assignedNames,
  assignmentLeft,
  assignmentRight,
  buildTimeline,
  definitionNode,
  definitionName,
  parameterNames,
  rebindTarget,
} from "./python-timeline"

export type { PythonEvent, PythonEventKind } from "./python-analyze-types"

type HelperParamSeed = {
  containerKind?: ContainerKind
  iteratedElementKind?: ContainerKind
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

function shouldTrustModuleBinding(target: string | undefined) {
  return target === "importlib.metadata"
}

function canonicalReceiverPath(node: Tree["rootNode"] | null, current: Scope) {
  if (!node) return
  const info = trackableReceiverInfo(node)
  if (!info) return
  if (node.type === "identifier") return resolvedName(node, current) ?? info.path
  const base = node.childForFieldName("value") ?? node.childForFieldName("object")
  const rawBase = base?.text
  const resolvedBase = resolvedName(base, current)
  if (rawBase && resolvedBase && resolvedBase !== rawBase && info.path.startsWith(rawBase)) {
    return `${resolvedBase}${info.path.slice(rawBase.length)}`
  }
  return info.path
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

function markReceiverSeedableStringList(current: Scope, receiver: Tree["rootNode"] | null) {
  const info = trackableReceiverInfo(receiver)
  if (!info) return
  const canonicalPath = canonicalReceiverPath(receiver, current)
  current.receiverSeedableStringLists.set(info.path, info.deps)
  if (canonicalPath && canonicalPath !== info.path) current.receiverSeedableStringLists.set(canonicalPath, info.deps)
}

function hasReceiverSeedableStringList(current: Scope, path: string | undefined, canonicalPath?: string) {
  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    if ((path && scope.receiverSeedableStringLists.has(path)) || (canonicalPath && scope.receiverSeedableStringLists.has(canonicalPath))) return true
  }
  return false
}

function seedReceiverStringElementKind(current: Scope, receiver: Tree["rootNode"] | null) {
  const info = trackableReceiverInfo(receiver)
  if (!info) return
  const canonicalPath = canonicalReceiverPath(receiver, current)
  current.receiverElementKinds.set(info.path, { kind: "string", deps: info.deps })
  if (canonicalPath && canonicalPath !== info.path) {
    current.receiverElementKinds.set(canonicalPath, { kind: "string", deps: info.deps })
  }
  clearReceiverSeedableStringListPath(current, info.path, canonicalPath)
  if (receiver?.type === "identifier") current.iteratedElementInstances.set(receiver.text, "string")
}

function replayImportEntry(entry: TimelineEntry, rules: Awaited<ReturnType<typeof loadRules>>) {
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

function applyHelperSeeds(entry: TimelineEntry, helperSeeds: Map<number, Map<string, HelperParamSeed>>) {
  const targetScope = entry.bodyScope
  if (!targetScope) return
  const seeds = helperSeeds.get(entry.startIndex)
  if (!seeds) return
  for (const [name, seed] of seeds) {
    if (seed.containerKind) targetScope.containerInstances.set(name, seed.containerKind)
    if (seed.iteratedElementKind) targetScope.iteratedElementInstances.set(name, seed.iteratedElementKind)
  }
}

function replayDefinitionEntry(entry: TimelineEntry, helperSeeds?: Map<number, Map<string, HelperParamSeed>>) {
  const name = definitionName(entry.node)
  if (name) {
    invalidateTrackedName(entry.scope, name)
    entry.scope.localDefinitions.add(name)
  }
  if (helperSeeds) applyHelperSeeds(entry, helperSeeds)
  const summary = callableFactory(entry.node)
  if (summary) entry.scope.callableFactories.set(summary.name, summary.returned)
}

function replayRebindEntry(entry: TimelineEntry) {
  const target = rebindTarget(entry.node)
  const names = assignedNames(target ?? null)
  for (const targetName of names) invalidateTrackedName(entry.scope, targetName)
  for (const seeded of rebindPathValues(target ?? null, rebindSource(entry.node) ?? null, entry.scope)) {
    entry.scope.pathInstances.set(seeded.name, seeded.value)
  }
  for (const seeded of rebindContainerKinds(target ?? null, rebindSource(entry.node) ?? null, entry.scope)) {
    entry.scope.containerInstances.set(seeded.name, seeded.kind)
  }
}

function replayAssignmentEntry(
  entry: TimelineEntry,
  rules: Awaited<ReturnType<typeof loadRules>>,
  hasAtlassianImportProvenance: boolean,
) {
  const left = assignmentLeft(entry.node)
  const right = assignmentRight(entry.node)
  const factoryTarget = callableFactoryTarget(right, entry.scope, right?.type === "call" ? args(right) : undefined)
  const localPath = trackedPathValue(right, entry.scope)
  const iteratedPath = iteratedPathValue(right, entry.scope)
  const localContainer = trackedContainerKind(right, entry.scope) ?? returnedTrackedContainerKind(right, entry.scope)
  const iteratedElement = iteratedContainerKind(right, entry.scope)
  const target = aliasTarget(right, entry.scope)
  const assignedCall = right?.type === "call" ? resolvedName(right.childForFieldName("function"), entry.scope) : undefined
  const invalidations = trackableInvalidationDeps(left, assignedNames)
  for (const targetName of assignedNames(left)) invalidateTrackedName(entry.scope, targetName)
  if (left?.type === "subscript") {
    const base = left.childForFieldName("value")
    if (base?.type === "identifier") {
      clearIteratedElementProvenance(entry.scope, base.text)
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
    const info = trackableReceiverInfo(left)
    clearReceiverElementKindPath(entry.scope, info?.path, canonicalReceiverPath(left, entry.scope))
    clearReceiverSeedableStringListPath(entry.scope, info?.path, canonicalReceiverPath(left, entry.scope))
    const baseInfo = trackableReceiverInfo(base)
    clearReceiverElementKindPath(entry.scope, baseInfo?.path, canonicalReceiverPath(base, entry.scope))
    clearReceiverSeedableStringListPath(entry.scope, baseInfo?.path, canonicalReceiverPath(base, entry.scope))
  }
  clearReceiverDeps(entry.scope, invalidations)
  if (applyAssignmentProvenance(entry.scope, left, localContainer, localPath)) {
    if (left?.type === "subscript" && right?.type === "list" && right.namedChildren.length === 0) {
      markReceiverSeedableStringList(entry.scope, left)
    }
    return
  }
  if (!left || left.type !== "identifier") return

  if (entry.node.type !== "assignment") return

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
    const containerAlias = target ?? (right?.type === "subscript" && (localContainer === "list" || localContainer === "set") ? canonicalReceiverPath(right, entry.scope) : undefined)
    if (containerAlias) entry.scope.bindings.set(left.text, containerAlias)
    return
  }

  if (iteratedElement) {
    entry.scope.iteratedElementInstances.set(left.text, iteratedElement)
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

function helperSeedFromArgument(node: Tree["rootNode"] | null, current: Scope): HelperParamSeed | undefined {
  const containerKind = trackedContainerKind(node, current) ?? returnedTrackedContainerKind(node, current)
  const iteratedElementKind = iteratedContainerKind(node, current)
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

function clearMutatedIteratedElementInstance(entry: TimelineEntry) {
  if (entry.kind !== "call") return
  const fn = entry.node.childForFieldName("function")
  if (fn?.type !== "attribute") return
  const receiver = fn.childForFieldName("object")
  const resolved = resolvedName(fn, entry.scope)
  const parts = resolved?.split(".")
  const method = parts && parts.length > 0 ? parts[parts.length - 1] : undefined
  if (receiver?.type !== "identifier" || !method || !ITERATED_ELEMENT_INVALIDATING_METHODS.has(method)) return
  clearIteratedElementProvenance(entry.scope, receiver.text)
}

function updateMutatedReceiverElementKind(entry: TimelineEntry) {
  if (entry.kind !== "call") return
  const fn = entry.node.childForFieldName("function")
  if (fn?.type !== "attribute") return
  const receiver = fn.childForFieldName("object")
  if (receiver?.type !== "identifier") return
  const receiverKind = trackedReceiverContainerKind(receiver, entry.scope)
  if (receiverKind !== "list") return
  const resolved = resolvedName(fn, entry.scope)
  const parts = resolved?.split(".")
  const method = parts && parts.length > 0 ? parts[parts.length - 1] : undefined
  if (!method) return
  const info = trackableReceiverInfo(receiver)
  const canonicalPath = canonicalReceiverPath(receiver, entry.scope)

  if (method === "append" || method === "insert") {
    const argNodes = entry.node.childForFieldName("arguments")?.namedChildren ?? []
    const valueNode = method === "append" ? (argNodes[0] ?? null) : (argNodes[1] ?? null)
    if (
      helperSeedFromArgument(valueNode, entry.scope)?.containerKind === "string" &&
      (hasReceiverSeedableStringList(entry.scope, info?.path, canonicalPath) || entry.scope.receiverElementKinds.has(info?.path ?? "") || (canonicalPath ? entry.scope.receiverElementKinds.has(canonicalPath) : false))
    ) {
      seedReceiverStringElementKind(entry.scope, receiver)
      return
    }
    clearReceiverElementKindPath(entry.scope, info?.path, canonicalPath)
    clearReceiverSeedableStringListPath(entry.scope, info?.path, canonicalPath)
    return
  }

  if (method === "extend") {
    const valueNode = entry.node.childForFieldName("arguments")?.namedChildren[0] ?? null
    if (
      helperSeedFromArgument(valueNode, entry.scope)?.iteratedElementKind === "string" &&
      (hasReceiverSeedableStringList(entry.scope, info?.path, canonicalPath) || entry.scope.receiverElementKinds.has(info?.path ?? "") || (canonicalPath ? entry.scope.receiverElementKinds.has(canonicalPath) : false))
    ) {
      seedReceiverStringElementKind(entry.scope, receiver)
      return
    }
    clearReceiverElementKindPath(entry.scope, info?.path, canonicalPath)
    clearReceiverSeedableStringListPath(entry.scope, info?.path, canonicalPath)
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

function discoverHelperParamSeeds(
  timeline: TimelineEntry[],
  rules: Awaited<ReturnType<typeof loadRules>>,
  hasAtlassianImportProvenance: boolean,
) {
  const activeByScope = new Map<Scope, Map<string, ActiveHelper>>()
  const allHelpers: ActiveHelper[] = []

  for (const entry of timeline) {
    if (entry.kind === "import") {
      replayImportEntry(entry, rules)
    } else if (entry.kind === "definition") {
      replayDefinitionEntry(entry)
      const def = definitionNode(entry.node)
      const name = definitionName(entry.node)
      const params = def?.type === "function_definition" ? parameterNames(def.childForFieldName("parameters")) : []
      if (name && entry.bodyScope && params.length > 0) {
        const helper: ActiveHelper = {
          definitionStart: entry.startIndex,
          params,
          bodyScope: entry.bodyScope,
          seeds: params.map(() => undefined),
          blocked: false,
          observedCalls: 0,
        }
        let bucket = activeByScope.get(entry.scope)
        if (!bucket) {
          bucket = new Map<string, ActiveHelper>()
          activeByScope.set(entry.scope, bucket)
        }
        bucket.set(name, helper)
        allHelpers.push(helper)
      }
    } else if (entry.kind === "rebind") {
      for (const name of helperInvalidationNames(entry)) activeByScope.get(entry.scope)?.delete(name)
      replayRebindEntry(entry)
    } else if (entry.kind === "assignment") {
      for (const name of helperInvalidationNames(entry)) activeByScope.get(entry.scope)?.delete(name)
      replayAssignmentEntry(entry, rules, hasAtlassianImportProvenance)
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
            const seed = helperSeedFromArgument(argNode, entry.scope)
            const current = helper.seeds[index]
            if (!seed || (current && !sameHelperSeed(current, seed))) {
              helper.blocked = true
              break
            }
            helper.seeds[index] = seed
          }
        }
      }
      clearMutatedIteratedElementInstance(entry)
      updateMutatedReceiverElementKind(entry)
    }
  }

  const results = new Map<number, Map<string, HelperParamSeed>>()
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

  const seedScope = scope()
  const seedTimeline = buildTimeline(tree.rootNode, seedScope, { scope, invalidateTrackedName })
  const helperSeeds = discoverHelperParamSeeds(seedTimeline, rules, hasAtlassianImportProvenance)

  const rootScope = scope()
  const timeline = buildTimeline(tree.rootNode, rootScope, { scope, invalidateTrackedName })

  const events: PythonEvent[] = []
  for (const entry of timeline) {
    if (entry.kind === "import") {
      replayImportEntry(entry, rules)
      continue
    }

    if (entry.kind === "definition") {
      replayDefinitionEntry(entry, helperSeeds)
      continue
    }

    if (entry.kind === "rebind") {
      replayRebindEntry(entry)
      continue
    }

    if (entry.kind === "assignment") {
      replayAssignmentEntry(entry, rules, hasAtlassianImportProvenance)
      continue
    }

    if (entry.kind === "raise") {
      const resolved = classifyRaise(entry.node, entry.scope)
      if (resolved) events.push(foldResolvedEffect(resolved))
      continue
    }

    const resolved = classify(entry.node, rules, hasAtlassianImportProvenance, entry.scope)
    if (resolved) events.push(foldResolvedEffect(resolved))
    clearMutatedIteratedElementInstance(entry)
    updateMutatedReceiverElementKind(entry)
  }

  if (events.length) return analysisResult(metadata, unique(events))
  if (calls.length) return analysisResult(metadata, [{ kind: "unknown", call: "no-classified-call" }] satisfies PythonEvent[])
  return analysisResult(metadata, [{ kind: "unknown", call: "no-calls-detected" }] satisfies PythonEvent[])
}

export async function analyze(source: string) {
  return (await analyzeDetailed(source)).events.map(({ evidence: _evidence, ...event }) => event)
}
