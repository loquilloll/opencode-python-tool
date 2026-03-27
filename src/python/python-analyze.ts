import type { PythonAstTree as Tree } from "./frontend/interface"
import { getFrontend, loadRules } from "./python-bootstrap"
import { analysisResult, foldResolvedEffect, unique } from "./python-events"
import { classify, classifyRaise, isAtlassianImportStatement } from "./python-classifier"
import type { PythonEvent } from "./python-analyze-types"
import {
  analyzerMetadata,
  type PythonAnalyzeResult,
} from "./python-ir"
import {
  invalidateTrackedName,
  scope,
} from "./python-scope"
import {
  clearMutatedClassModuleReceiverContainer,
  clearIndirectMappingMutations,
  clearMutatedTrustedHashlibCalls,
  clearMutatedTrustedModelDumpPaths,
  clearMutatedTrustedDifflibCalls,
  clearMutatedMappingValueContainerKind,
  clearMutatedTrustedOciModelMetadataMaps,
  clearEscapedReceiverPaths,
  clearMutatedIteratedElementInstance,
  discoverHelperReturnKinds,
  discoverHelperParamSeeds,
  replayAssignmentEntry,
  replayDefinitionEntry,
  replayImportEntry,
  replayRebindEntry,
  updateSqliteCursorExecution,
  updateMutatedReceiverElementKind,
} from "./python-replay"
import { buildTimeline } from "./python-timeline"

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

  const seedScope = scope()
  const seedTimeline = buildTimeline(tree.rootNode, seedScope, { scope, invalidateTrackedName })
  const initialHelperSeeds = discoverHelperParamSeeds(seedTimeline, rules, hasAtlassianImportProvenance)
  const helperScope = scope()
  const helperTimeline = buildTimeline(tree.rootNode, helperScope, { scope, invalidateTrackedName })
  const initialHelperReturnKinds = discoverHelperReturnKinds(helperTimeline, initialHelperSeeds, rules, hasAtlassianImportProvenance)
  const enrichedSeedScope = scope()
  const enrichedSeedTimeline = buildTimeline(tree.rootNode, enrichedSeedScope, { scope, invalidateTrackedName })
  const helperSeeds = discoverHelperParamSeeds(enrichedSeedTimeline, rules, hasAtlassianImportProvenance, initialHelperReturnKinds)
  const enrichedHelperScope = scope()
  const enrichedHelperTimeline = buildTimeline(tree.rootNode, enrichedHelperScope, { scope, invalidateTrackedName })
  const helperReturnKinds = discoverHelperReturnKinds(enrichedHelperTimeline, helperSeeds, rules, hasAtlassianImportProvenance)

  const rootScope = scope()
  const timeline = buildTimeline(tree.rootNode, rootScope, { scope, invalidateTrackedName })

  const events: PythonEvent[] = []
  for (const entry of timeline) {
    if (entry.kind === "import") {
      replayImportEntry(entry, rules)
      continue
    }

    if (entry.kind === "definition") {
      replayDefinitionEntry(entry, helperSeeds, helperReturnKinds)
      continue
    }

    if (entry.kind === "rebind") {
      replayRebindEntry(entry)
      continue
    }

    if (entry.kind === "assignment") {
      replayAssignmentEntry(entry, rules, hasAtlassianImportProvenance, helperSeeds, undefined, helperReturnKinds)
      continue
    }

    if (entry.kind === "raise") {
      const resolved = classifyRaise(entry.node, entry.scope)
      if (resolved) events.push(foldResolvedEffect(resolved))
      continue
    }

    const resolved = classify(entry.node, rules, hasAtlassianImportProvenance, entry.scope)
    if (resolved) events.push(foldResolvedEffect(resolved))
    clearEscapedReceiverPaths(entry)
    clearMutatedIteratedElementInstance(entry)
    clearMutatedMappingValueContainerKind(entry)
    clearMutatedClassModuleReceiverContainer(entry)
    clearMutatedTrustedHashlibCalls(entry)
    clearMutatedTrustedModelDumpPaths(entry)
    clearMutatedTrustedDifflibCalls(entry)
    clearMutatedTrustedOciModelMetadataMaps(entry)
    clearIndirectMappingMutations(entry)
    updateSqliteCursorExecution(entry)
    updateMutatedReceiverElementKind(entry)
  }

  if (events.length) return analysisResult(metadata, unique(events))
  if (calls.length) return analysisResult(metadata, [{ kind: "unknown", call: "no-classified-call" }] satisfies PythonEvent[])
  return analysisResult(metadata, [{ kind: "unknown", call: "no-calls-detected" }] satisfies PythonEvent[])
}

export async function analyze(source: string) {
  return (await analyzeDetailed(source)).events.map(({ evidence: _evidence, ...event }) => event)
}
