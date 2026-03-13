import type { PythonAstTree as Tree } from "./frontend/interface"
import { getFrontend, loadRules } from "./python-bootstrap"
import { analysisResult, foldResolvedEffect, unique } from "./python-events"
import { atlassianFamilyForConstructor, classify, classifyRaise, isAtlassianImportStatement, isHttpResponseCall } from "./python-classifier"
import {
  args,
  iteratedContainerKind,
  iteratedPathValue,
  rebindContainerKinds,
  rebindPathValues,
  rebindSource,
  returnedTrackedContainerKind,
  trackedContainerKind,
  trackedPathValue,
} from "./python-inference"
import { TRACKED_HTTP_CLIENT_CONSTRUCTORS } from "./python-known-methods"
import type { PythonEvent } from "./python-analyze-types"
import {
  analyzerMetadata,
  type PythonAnalyzeResult,
} from "./python-ir"
import {
  applyAssignmentProvenance,
  clearReceiverDeps,
  trackableInvalidationDeps,
} from "./python-provenance"
import {
  aliasTarget,
  callableFactory,
  callableFactoryTarget,
  importBindings,
  invalidateTrackedName,
  resolvedName,
  scope,
  shouldBindDirectImport,
} from "./python-scope"
import {
  assignedNames,
  assignmentLeft,
  assignmentRight,
  buildTimeline,
  definitionName,
  rebindTarget,
} from "./python-timeline"

export type { PythonEvent, PythonEventKind } from "./python-analyze-types"

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

  const rootScope = scope()
  const timeline = buildTimeline(tree.rootNode, rootScope, { scope, invalidateTrackedName })

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
      if (name) {
        invalidateTrackedName(entry.scope, name)
        entry.scope.localDefinitions.add(name)
      }
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
      const factoryTarget = callableFactoryTarget(right, entry.scope, right?.type === "call" ? args(right) : undefined)
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
        if (iteratedElement) {
          entry.scope.iteratedElementInstances.set(left.text, iteratedElement)
        }
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
