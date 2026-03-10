import type { GuardFailureEvidence } from "./python-ir"
import type { GuardPrimitive, GuardReceiverKind } from "./python-rule-schema"

export type GuardContext = {
  receiverKind?: GuardReceiverKind
  keywordNames: Set<string>
  hasKwargSplat: boolean
  hasBoundName?: (name: string) => boolean
  pickLiteral?: (index: number, names: string[]) => string | undefined
}

export type GuardEvaluation = {
  matched: boolean
  failure?: GuardFailureEvidence
}

export function evaluateGuardsDetailed(guards: GuardPrimitive[], context: GuardContext): GuardEvaluation {
  for (const guard of guards) {
    if (guard.type === "receiverKindIn") {
      if (!context.receiverKind || !guard.kinds.includes(context.receiverKind)) {
        return {
          matched: false,
          failure: {
            type: guard.type,
            detail: `expected=${guard.kinds.join('|')} actual=${context.receiverKind ?? 'none'}`,
          },
        }
      }
      continue
    }
    if (guard.type === "kwargAbsent") {
      const hit = guard.names.find((name) => context.keywordNames.has(name))
      if (hit) return { matched: false, failure: { type: guard.type, detail: hit } }
      continue
    }
    if (guard.type === "bindingAbsent") {
      const hit = guard.names.find((name) => context.hasBoundName?.(name))
      if (hit) return { matched: false, failure: { type: guard.type, detail: hit } }
      continue
    }
    if (guard.type === "argLiteralIn") {
      const literal = context.pickLiteral?.(guard.index, guard.names)
      const upper = literal?.toUpperCase()
      if (literal === undefined || !guard.values.some((value) => value === literal || value.toUpperCase() === upper)) {
        return {
          matched: false,
          failure: {
            type: guard.type,
            detail: `expected=${guard.values.join('|')} actual=${literal ?? 'none'}`,
          },
        }
      }
      continue
    }
    if (guard.type === "kwargSplatAbsent") {
      if (context.hasKwargSplat) return { matched: false, failure: { type: guard.type, detail: "dictionary_splat" } }
      continue
    }
  }
  return { matched: true }
}

export function evaluateGuards(guards: GuardPrimitive[], context: GuardContext) {
  return evaluateGuardsDetailed(guards, context).matched
}
