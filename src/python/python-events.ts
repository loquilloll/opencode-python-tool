import { EFFECT_KIND } from "./python-known-methods"
import type { PythonEvent } from "./python-analyze-types"
import type { PythonAnalyzerMetadata, PythonAnalyzeResult, ResolvedEffect, ResolvedEffectAtom } from "./python-ir"
import type { PythonValue as Value } from "./python-values"

export function unique(input: PythonEvent[]) {
  const result = new Map<string, PythonEvent>()
  for (const item of input) {
    const key = [
      item.kind,
      item.call,
      item.sourceCall ?? "",
      item.path ?? "<dynamic>",
      item.dynamicPath ? "1" : "0",
      JSON.stringify(item.evidence ?? null),
    ].join("|")
    if (result.has(key)) continue
    result.set(key, item)
  }
  return Array.from(result.values())
}

export function effect(atom: ResolvedEffectAtom, input: Omit<ResolvedEffect, "atom"> = {}): ResolvedEffect {
  return { atom, ...input }
}

export function pathEffect(
  atom: "fs.read" | "fs.write",
  resolvedCall: string,
  path?: Value,
  input: Omit<ResolvedEffect, "atom" | "resolvedCall" | "path"> = {},
): ResolvedEffect {
  return effect(atom, { resolvedCall, path, ...input })
}

export function foldResolvedEffect(input: ResolvedEffect): PythonEvent {
  const kind = EFFECT_KIND[input.atom]
  const call = input.outwardCall ?? input.canonicalCall ?? input.resolvedCall ?? "dynamic-call"
  const sourceCall = input.canonicalCall && input.canonicalCall !== call ? input.canonicalCall : undefined
  const evidence = input.evidence
  const withEvidence = <T extends PythonEvent>(event: T): T => (evidence ? { ...event, evidence } : event)
  if ((kind === "read" || kind === "write") && input.path) {
    if (input.path.dynamic || input.path.literal === undefined) {
      return sourceCall ? withEvidence({ kind, call, sourceCall, dynamicPath: true }) : withEvidence({ kind, call, dynamicPath: true })
    }
    return sourceCall ? withEvidence({ kind, call, sourceCall, path: input.path.literal }) : withEvidence({ kind, call, path: input.path.literal })
  }
  return sourceCall ? withEvidence({ kind, call, sourceCall }) : withEvidence({ kind, call })
}

export function analysisResult(metadata: PythonAnalyzerMetadata, events: PythonEvent[]): PythonAnalyzeResult {
  return {
    events,
    analyzerVersion: metadata.analyzerVersion,
    engineVersion: metadata.engineVersion,
  }
}
