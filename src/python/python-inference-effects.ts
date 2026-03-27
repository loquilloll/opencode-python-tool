import type { PythonAstNode as Node } from "./frontend/interface"
import { effect } from "./python-events"
import {
  ASYNC_MOCK_PURE_METHODS,
  BYTEARRAY_PURE_METHODS,
  BYTES_PURE_METHODS,
  CALLABLE_UNKNOWN_PREFIX,
  COMPLEX_PURE_METHODS,
  COUNTER_PURE_METHODS,
  DATETIME_DATE_PURE_METHODS,
  DATETIME_DATETIME_PURE_METHODS,
  DATETIME_TIME_PURE_METHODS,
  DATETIME_TIMEDELTA_PURE_METHODS,
  DATETIME_TIMEZONE_PURE_METHODS,
  DICT_PURE_METHODS,
  EXACT_PURE_CALLS,
  FLOAT_PURE_METHODS,
  HASHLIB_HASH_PURE_METHODS,
  INSPECT_BOUND_ARGUMENTS_PURE_METHODS,
  INSPECT_PARAMETER_PURE_METHODS,
  INSPECT_SIGNATURE_PURE_METHODS,
  INT_PURE_METHODS,
  JSON_CONTAINER_CUSTOMIZER_KEYWORDS,
  JSON_PURE_METHODS,
  KEY_CALLBACK_PURE_BUILTINS,
  LIST_PURE_METHODS,
  MEMORYVIEW_PURE_METHODS,
  MOCK_PURE_METHODS,
  RANGE_PURE_METHODS,
  REGEX_PATTERN_PURE_METHODS,
  SET_PURE_METHODS,
  SHADOW_GUARDED_PURE_BUILTINS,
  STANDARD_EXCEPTION_BUILTINS,
  STRING_ITERABLE_METHODS,
  STRING_PURE_METHODS,
  TUPLE_PURE_METHODS,
} from "./python-known-methods"
import type { Rules, Scope } from "./python-analyze-types"
import type { ContainerKind } from "./python-provenance"
import type { ResolvedEffect } from "./python-ir"
import { hasBoundName, hasHttpResponseInstance } from "./python-scope"
import type { PythonArgs as Args } from "./python-values"
import { tail } from "./python-inference-values"

export function pureContainerMethod(kind: ContainerKind, method: string) {
  if (kind === "list") return LIST_PURE_METHODS.has(method)
  if (kind === "tuple") return TUPLE_PURE_METHODS.has(method)
  if (kind === "range") return RANGE_PURE_METHODS.has(method)
  if (kind === "dict") return DICT_PURE_METHODS.has(method)
  if (kind === "dict-list-values" || kind === "dict-set-values" || kind === "dict-counter-values") return DICT_PURE_METHODS.has(method)
  if (kind === "counter") return COUNTER_PURE_METHODS.has(method)
  if (kind === "json") return JSON_PURE_METHODS.has(method)
  if (kind === "datetime-date") return DATETIME_DATE_PURE_METHODS.has(method)
  if (kind === "datetime-datetime") return DATETIME_DATETIME_PURE_METHODS.has(method)
  if (kind === "datetime-time") return DATETIME_TIME_PURE_METHODS.has(method)
  if (kind === "datetime-timedelta") return DATETIME_TIMEDELTA_PURE_METHODS.has(method)
  if (kind === "datetime-timezone") return DATETIME_TIMEZONE_PURE_METHODS.has(method)
  if (kind === "hashlib-hash") return HASHLIB_HASH_PURE_METHODS.has(method)
  if (kind === "regex-pattern") return REGEX_PATTERN_PURE_METHODS.has(method)
  if (kind === "string") return STRING_PURE_METHODS.has(method) || STRING_ITERABLE_METHODS.has(method)
  if (kind === "bytes") return BYTES_PURE_METHODS.has(method)
  if (kind === "bytearray") return BYTEARRAY_PURE_METHODS.has(method)
  if (kind === "memoryview") return MEMORYVIEW_PURE_METHODS.has(method)
  if (kind === "int") return INT_PURE_METHODS.has(method)
  if (kind === "float") return FLOAT_PURE_METHODS.has(method)
  if (kind === "complex") return COMPLEX_PURE_METHODS.has(method)
  if (kind === "match") return false
  if (kind === "inspect-signature") return INSPECT_SIGNATURE_PURE_METHODS.has(method)
  if (kind === "inspect-parameter") return INSPECT_PARAMETER_PURE_METHODS.has(method)
  if (kind === "inspect-bound-arguments") return INSPECT_BOUND_ARGUMENTS_PURE_METHODS.has(method)
  if (kind === "mock") return MOCK_PURE_METHODS.has(method)
  if (kind === "async-mock") return ASYNC_MOCK_PURE_METHODS.has(method)
  return SET_PURE_METHODS.has(method)
}

export function hasDictionarySplat(node: Node) {
  const input = node.childForFieldName("arguments")
  if (!input) return false
  return input.namedChildren.some((child) => child.type === "dictionary_splat")
}

function hasJsonCustomizers(node: Node, input: Args) {
  if (hasDictionarySplat(node)) return true
  return Array.from(JSON_CONTAINER_CUSTOMIZER_KEYWORDS).some((keyword) => keyword in input.keyword)
}

export function classifyResponseJson(call: string, node: Node, input: Args, current: Scope): ResolvedEffect | undefined {
  if (tail(call) !== "json") return
  const parts = call.split(".")
  const instance = parts[0]
  if (!instance || parts.length !== 2 || !hasHttpResponseInstance(current, instance)) return
  if (input.positional.length === 0 && Object.keys(input.keyword).length === 0 && !hasDictionarySplat(node)) {
    return effect("pure.compute", { resolvedCall: call })
  }
  return effect("unknown", { resolvedCall: call, outwardCall: `${CALLABLE_UNKNOWN_PREFIX}${call}` })
}

function builtinPurityTarget(call: string) {
  if (EXACT_PURE_CALLS.has(call)) return call
  if (call === "dict.fromkeys") return "dict"
  if (SHADOW_GUARDED_PURE_BUILTINS.has(call)) return call
  if (STANDARD_EXCEPTION_BUILTINS.has(call)) return call
}

function hasBuiltinPurityCustomizers(call: string, node: Node, input: Args) {
  if (hasDictionarySplat(node)) return KEY_CALLBACK_PURE_BUILTINS.has(call)
  return KEY_CALLBACK_PURE_BUILTINS.has(call) && "key" in input.keyword
}

export function classifyBuiltinPureCall(call: string, node: Node, input: Args, current: Scope): ResolvedEffect | undefined {
  const target = builtinPurityTarget(call)
  if (!target) return
  if (hasBoundName(current, target)) {
    return effect("unknown", { resolvedCall: call, outwardCall: `${CALLABLE_UNKNOWN_PREFIX}${call}` })
  }
  if (hasBuiltinPurityCustomizers(call, node, input)) {
    return effect("unknown", { resolvedCall: call, outwardCall: `${CALLABLE_UNKNOWN_PREFIX}${call}` })
  }
  return effect("pure.compute", { resolvedCall: call })
}

export function classifyBuiltinPureFallbackCall(call: string, node: Node, input: Args, current: Scope, rules: Rules): ResolvedEffect | undefined {
  if (rules.guarded.calls.some((rule) => rule.call === call && rule.effect === "pure.compute")) return
  return classifyBuiltinPureCall(call, node, input, current)
}
