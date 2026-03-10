import type { PythonValue } from "./python-values"

export type DependencyKey = string

export type ReceiverKind = "path" | "match" | "container" | "http-client" | "http-response" | "unknown"

export type ValueRef = string

export type GuardFailureEvidence = {
  type: string
  detail?: string
}

export type PythonEventEvidence = {
  receiverKind?: ReceiverKind
  dependencySignature?: string[]
  guardFailure?: GuardFailureEvidence
  explain?: string[]
}

export type ResolvedEffectAtom =
  | "fs.read"
  | "fs.write"
  | "network.read"
  | "network.write"
  | "network.exec"
  | "db.exec"
  | "process.exec"
  | "dynamic.exec"
  | "emit.signal"
  | "pure.compute"
  | "unknown"

export type ResolvedCall = {
  displayCall: string
  canonicalCall?: string
  effectAtom: ResolvedEffectAtom
  receiverKind?: ReceiverKind
  valueRef?: ValueRef
  deps: DependencyKey[]
  sourceCall?: string
  explain: string[]
}

export type ResolvedEffect = {
  atom: ResolvedEffectAtom
  resolvedCall?: string
  canonicalCall?: string
  outwardCall?: string
  path?: PythonValue
  evidence?: PythonEventEvidence
}

export type PythonAnalyzerMetadata = {
  analyzerVersion: string
  engineVersion: string
}
export function analyzerMetadata(): PythonAnalyzerMetadata {
  return {
    analyzerVersion: "python-analyzer/v2",
    engineVersion: "python-ir-v2",
  }
}

export type PythonAnalyzeResult = {
  events: Array<{
    kind: "read" | "write" | "emit" | "exec" | "pure" | "unknown"
    call: string
    sourceCall?: string
    path?: string
    dynamicPath?: boolean
    evidence?: PythonEventEvidence
  }>
  analyzerVersion: string
  engineVersion: string
}
