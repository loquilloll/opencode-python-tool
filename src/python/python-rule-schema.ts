import type { ResolvedEffectAtom } from "./python-ir"

type PathSpec = {
  index: number
  names: string[]
}

type ParseHelpers = {
  fail(label: string, msg: string): never
  record(input: unknown, label: string): Record<string, unknown>
  list(input: unknown, label: string): string[]
  listOrEmpty(input: unknown, label: string): string[]
  num(input: unknown, label: string): number
}

const GUARDED_RULES_VERSION = 1
const EFFECTS = new Set<ResolvedEffectAtom>([
  "fs.read",
  "fs.write",
  "network.read",
  "network.write",
  "network.exec",
  "db.exec",
  "process.exec",
  "dynamic.exec",
  "emit.signal",
  "pure.compute",
  "unknown",
])

export type GuardReceiverKind = "path" | "match"

export type GuardPrimitive =
  | { type: "receiverKindIn"; kinds: GuardReceiverKind[] }
  | { type: "kwargAbsent"; names: string[] }
  | { type: "bindingAbsent"; names: string[] }
  | { type: "argLiteralIn"; index: number; names: string[]; values: string[] }
  | { type: "kwargSplatAbsent" }

export type GuardedMethodRule = {
  method: string
  effect: ResolvedEffectAtom
  guards: GuardPrimitive[]
}

export type GuardedCallRule = {
  call: string
  effect: ResolvedEffectAtom
  guards: GuardPrimitive[]
}

export type GuardedRules = {
  methods: GuardedMethodRule[]
  calls: GuardedCallRule[]
}

function effect(input: unknown, label: string) {
  if (typeof input !== "string" || !EFFECTS.has(input as ResolvedEffectAtom)) {
    throw new Error(`Invalid python-rules.json: ${label} must be a supported effect atom`)
  }
  return input as ResolvedEffectAtom
}

function receiverKinds(input: unknown, label: string, helpers: ParseHelpers) {
  const out = helpers.list(input, label)
  for (const [index, item] of out.entries()) {
    if (item !== "path" && item !== "match") helpers.fail(`${label}[${index}]`, "must be a supported receiver kind")
  }
  return out as GuardReceiverKind[]
}

function guard(input: unknown, label: string, helpers: ParseHelpers): GuardPrimitive {
  const obj = helpers.record(input, label)
  const type = obj.type
  if (type === "receiverKindIn") return { type, kinds: receiverKinds(obj.kinds, `${label}.kinds`, helpers) }
  if (type === "kwargAbsent") return { type, names: helpers.list(obj.names, `${label}.names`) }
  if (type === "bindingAbsent") return { type, names: helpers.list(obj.names, `${label}.names`) }
  if (type === "argLiteralIn") {
    return {
      type,
      index: helpers.num(obj.index, `${label}.index`),
      names: helpers.list(obj.names, `${label}.names`),
      values: helpers.list(obj.values, `${label}.values`),
    }
  }
  if (type === "kwargSplatAbsent") return { type }
  helpers.fail(`${label}.type`, "must be a supported guard type")
}

function guards(input: unknown, label: string, helpers: ParseHelpers) {
  if (input === undefined) return []
  if (!Array.isArray(input)) helpers.fail(label, "must be an array")
  return input.map((item, index) => guard(item, `${label}[${index}]`, helpers))
}

function methodRule(input: unknown, label: string, helpers: ParseHelpers): GuardedMethodRule {
  const obj = helpers.record(input, label)
  if (typeof obj.method !== "string" || !obj.method) helpers.fail(`${label}.method`, "must be a non-empty string")
  return {
    method: obj.method,
    effect: effect(obj.effect, `${label}.effect`),
    guards: guards(obj.guards, `${label}.guards`, helpers),
  }
}

function callRule(input: unknown, label: string, helpers: ParseHelpers): GuardedCallRule {
  const obj = helpers.record(input, label)
  if (typeof obj.call !== "string" || !obj.call) helpers.fail(`${label}.call`, "must be a non-empty string")
  return {
    call: obj.call,
    effect: effect(obj.effect, `${label}.effect`),
    guards: guards(obj.guards, `${label}.guards`, helpers),
  }
}

export function parseGuardedRules(input: unknown, label: string, helpers: ParseHelpers): GuardedRules {
  if (input === undefined) return { methods: [], calls: [] }
  const obj = helpers.record(input, label)
  if (helpers.num(obj.version, `${label}.version`) !== GUARDED_RULES_VERSION) {
    helpers.fail(`${label}.version`, `must be ${GUARDED_RULES_VERSION}`)
  }

  const methods = obj.methods === undefined ? [] : obj.methods
  const calls = obj.calls === undefined ? [] : obj.calls
  if (!Array.isArray(methods)) helpers.fail(`${label}.methods`, "must be an array")
  if (!Array.isArray(calls)) helpers.fail(`${label}.calls`, "must be an array")

  return {
    methods: methods.map((item, index) => methodRule(item, `${label}.methods[${index}]`, helpers)),
    calls: calls.map((item, index) => callRule(item, `${label}.calls[${index}]`, helpers)),
  }
}

export type { PathSpec }
