import path from "path"
import type { PythonAstNode as Node } from "./frontend/interface"
import { effect } from "./python-events"
import {
  ASSIGNMENT_CONTAINER_TYPES,
  BYTEARRAY_PURE_METHODS,
  BYTES_PURE_METHODS,
  CALLABLE_UNKNOWN_PREFIX,
  COMPLEX_PURE_METHODS,
  DICT_PURE_METHODS,
  EXACT_PURE_CALLS,
  FLOAT_PURE_METHODS,
  INSPECT_BOUND_ARGUMENTS_CALLS,
  INSPECT_BOUND_ARGUMENTS_PURE_METHODS,
  INSPECT_PARAMETER_CALLS,
  INSPECT_PARAMETER_PURE_METHODS,
  INSPECT_SIGNATURE_CALLS,
  INSPECT_SIGNATURE_PURE_METHODS,
  INT_PURE_METHODS,
  JSON_CONTAINER_CALLS,
  JSON_CONTAINER_CUSTOMIZER_KEYWORDS,
  JSON_PURE_METHODS,
  KEY_CALLBACK_PURE_BUILTINS,
  LIST_PURE_METHODS,
  MATCH_RESULT_CALLS,
  MEMORYVIEW_PURE_METHODS,
  PATH_DYNAMIC_RETURNING_METHODS,
  RANGE_PURE_METHODS,
  SET_PURE_METHODS,
  SHADOW_GUARDED_PURE_BUILTINS,
  STANDARD_EXCEPTION_BUILTINS,
  STRING_ITERABLE_METHODS,
  STRING_PURE_METHODS,
  STRING_RETURNING_METHODS,
  TUPLE_PURE_METHODS,
} from "./python-known-methods"
import type { Rules, Scope } from "./python-analyze-types"
import {
  containerInstance,
  hasBoundName,
  hasHttpResponseInstance,
  httpClientInstance,
  iteratedElementInstance,
  iteratedPathInstance,
  pathInstanceValue,
  resolvedName,
} from "./python-scope"
import { lookupTrackedReceiverContainerKind, type ContainerKind } from "./python-provenance"
import { assignedNames } from "./python-timeline"
import type { ResolvedEffect } from "./python-ir"
import type { PythonArgs as Args, PythonValue as Value } from "./python-values"

function tail(input: string) {
  const parts = input.split(".")
  return parts[parts.length - 1] ?? ""
}

export function parseString(input: string) {
  const value = input.trim()
  if (!value) return
  const match = value.match(/^([rRuUbBfF]{0,3})([\s\S]*)$/)
  const prefix = (match?.[1] ?? "").toLowerCase()
  const body = match?.[2] ?? value
  if (prefix.includes("f")) return

  const quotes = ["\"\"\"", "'''", "\"", "'"]
  for (const quote of quotes) {
    if (!body.startsWith(quote) || !body.endsWith(quote)) continue
    if (body.length < quote.length * 2) continue
    return body
      .slice(quote.length, -quote.length)
      .replace(/\\\\/g, "\\")
      .replace(/\\\"/g, "\"")
      .replace(/\\'/g, "'")
  }
}

export function value(node: Node | null): Value {
  if (!node) return { dynamic: true }

  if (node.type === "string") {
    const parsed = parseString(node.text)
    if (parsed !== undefined) return { dynamic: false, literal: parsed }
    return { dynamic: true }
  }

  if (node.type === "concatenated_string") {
    const parts = node.namedChildren.map((child) => parseString(child.text))
    if (parts.some((part) => part === undefined)) return { dynamic: true }
    return { dynamic: false, literal: parts.join("") }
  }

  return { dynamic: true }
}

export function args(node: Node): Args {
  const positional: Value[] = []
  const keyword = Object.create(null) as Record<string, Value>
  const input = node.childForFieldName("arguments")
  if (!input) return { positional, keyword }

  for (const child of input.namedChildren) {
    if (child.type === "keyword_argument") {
      const name = child.childForFieldName("name")?.text
      if (!name) continue
      keyword[name] = value(child.childForFieldName("value"))
      continue
    }
    positional.push(value(child))
  }

  return { positional, keyword }
}

export function pick(input: Args, index: number, names: string[]) {
  if (input.positional[index]) return input.positional[index]
  for (const name of names) {
    if (!input.keyword[name]) continue
    return input.keyword[name]
  }
}

function containerKind(node: Node | null, current: Scope): ContainerKind | undefined {
  if (!node) return
  if (node.type === "list") return "list"
  if (node.type === "tuple") return "tuple"
  if (node.type === "dictionary") return "dict"
  if (node.type === "set") return "set"
  if (node.type === "list_comprehension") return "list"
  if (node.type === "dictionary_comprehension") return "dict"
  if (node.type === "set_comprehension") return "set"
  if (node.type === "subscript") {
    const value = node.childForFieldName("value")
    const base = trackedContainerKind(value, current) ?? containerKind(value, current)
    const subscript = value ? node.namedChildren.find((child) => child.startIndex > value.endIndex) : undefined
    if (base === "json") return "json"
    if (base === "string" && (subscript?.type === "slice" || subscript?.text.includes(":"))) return "string"
    if (!subscript || (!subscript.text.includes(":") && subscript.type !== "slice")) {
      return value ? iteratedContainerKind(value, current) : undefined
    }
    return
  }
  if (node.type === "boolean_operator") {
    const left = containerKind(node.childForFieldName("left"), current)
    const right = containerKind(node.childForFieldName("right"), current)
    if (left && right && left === right) return left
    if (left === "json" && (right === "dict" || right === "list")) return "json"
    if (right === "json" && (left === "dict" || left === "list")) return "json"
    return
  }
  if (node.type !== "call") return
  const call = resolvedName(node.childForFieldName("function"), current)
  if (call === "list") return "list"
  if (call === "dict") return "dict"
  if (call === "set") return "set"
  if (call === "next") {
    const input = node.childForFieldName("arguments")
    const first = input?.namedChildren[0] ?? null
    return generatorElementKind(first, current)
  }
  if (!call) return
  const method = tail(call)
  const parts = call.split(".")
  const instance = parts[0]
  if (instance && method === "json" && parts.length === 2 && hasHttpResponseInstance(current, instance)) {
    const input = args(node)
    if (input.positional.length === 0 && Object.keys(input.keyword).length === 0 && !hasDictionarySplat(node)) return "json"
    return
  }
  if (instance && method === "get") {
    const localContainer = containerInstance(current, instance)
    if (localContainer === "json") return "json"
  }
  if (!call || !JSON_CONTAINER_CALLS.has(call)) return
  const input = args(node)
  if (hasJsonCustomizers(node, input)) return
  return "json"
}

function isBytesLiteralText(text: string) {
  return /^(?:[rR]?[bB]|[bB][rR]?)['"]/.test(text.trim())
}

function bytesKind(node: Node | null, current: Scope): "bytes" | "bytearray" | "memoryview" | undefined {
  if (!node) return
  if ((node.type === "string" || node.type === "concatenated_string") && isBytesLiteralText(node.text)) return "bytes"
  if (node.type !== "call") return
  const call = resolvedName(node.childForFieldName("function"), current)
  if (call?.endsWith("Path.read_bytes")) return "bytes"
  const fn = node.childForFieldName("function")
  const method = call ? tail(call) : undefined
  const receiver = fn?.type === "attribute" ? fn.childForFieldName("object") : null
  if (method === "read_bytes" && trackedPathValue(receiver, current)) return "bytes"
}

function matchKind(node: Node | null, current: Scope): "match" | undefined {
  if (!node || node.type !== "call") return
  const call = resolvedName(node.childForFieldName("function"), current)
  if (call && MATCH_RESULT_CALLS.has(call)) return "match"
}

function numericKind(node: Node | null, current: Scope): "int" | "float" | "complex" | undefined {
  if (!node) return
  if (node.type === "integer") return "int"
  if (node.type === "float") return "float"
}

function stringKind(node: Node | null, current: Scope): "string" | undefined {
  if (!node) return
  if ((node.type === "string" || node.type === "concatenated_string") && !isBytesLiteralText(node.text)) return "string"
  if (node.type !== "call") return
  const call = resolvedName(node.childForFieldName("function"), current)
  if (call?.endsWith("Path.read_text")) return "string"
  const fn = node.childForFieldName("function")
  const method = call ? tail(call) : undefined
  const receiver = fn?.type === "attribute" ? fn.childForFieldName("object") : null
  if (method === "read_text" && trackedPathValue(receiver, current)) return "string"
}

export function trackedPathValue(node: Node | null, current: Scope): Value | undefined {
  if (!node) return
  if (node.type === "identifier") return pathInstanceValue(current, node.text)

  if (node.type === "binary_operator") {
    const left = node.childForFieldName("left")
    const right = node.childForFieldName("right")
    const base = trackedPathValue(left, current)
    const segment = right?.type === "string" ? parseString(right.text) : undefined
    const between = left && right ? node.text.slice(left.text.length, node.text.length - right.text.length) : ""
    if (base && segment !== undefined && between.includes("/")) {
      if (base.dynamic || base.literal === undefined) return { dynamic: true }
      return { dynamic: false, literal: path.join(base.literal, segment) }
    }
  }

  if (node.type !== "call") return

  const call = resolvedName(node.childForFieldName("function"), current)
  if (!call) return
  if (call === "Path" || call === "pathlib.Path") return pick(args(node), 0, ["path"]) ?? { dynamic: true }
  if (call === "Path.cwd" || call === "pathlib.Path.cwd") return { dynamic: true }
  if (call === "Path.home" || call === "pathlib.Path.home") return { dynamic: true }
  if (call === "Path.from_uri" || call === "pathlib.Path.from_uri") return { dynamic: true }

  const method = tail(call)
  const fn = node.childForFieldName("function")
  const receiver = fn?.type === "attribute" ? fn.childForFieldName("object") : null
  const base = trackedPathValue(receiver, current)
  if (!base) return

  if (PATH_DYNAMIC_RETURNING_METHODS.has(method)) return { dynamic: true }
  if (method !== "joinpath") return

  const input = args(node)
  if (
    base.dynamic ||
    input.positional.length === 0 ||
    input.positional.some((item) => item?.dynamic || item?.literal === undefined) ||
    base.literal === undefined
  ) {
    return { dynamic: true }
  }
  return { dynamic: false, literal: path.join(base.literal, ...input.positional.map((item) => item!.literal!)) }
}

export function pureContainerMethod(kind: ContainerKind, method: string) {
  if (kind === "list") return LIST_PURE_METHODS.has(method)
  if (kind === "tuple") return TUPLE_PURE_METHODS.has(method)
  if (kind === "range") return RANGE_PURE_METHODS.has(method)
  if (kind === "dict") return DICT_PURE_METHODS.has(method)
  if (kind === "json") return JSON_PURE_METHODS.has(method)
  if (kind === "string") return STRING_PURE_METHODS.has(method)
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

export function directTemporaryContainerKind(node: Node | null, current: Scope): ContainerKind | undefined {
  if (!node) return

  const directMatch = matchKind(node, current)
  if (directMatch) return directMatch
  const directBytes = bytesKind(node, current)
  if (directBytes) return directBytes
  const directString = stringKind(node, current)
  if (directString) return directString
  const directNumeric = numericKind(node, current)
  if (directNumeric) return directNumeric
  if (node.type !== "call") return
  const call = resolvedName(node.childForFieldName("function"), current)
  if (!call) return
  const input = args(node)

  if (call.endsWith("Path.read_text")) return "string"
  if (call.endsWith("Path.read_bytes")) return "bytes"

  if (call === "tuple" || call === "range" || call === "bytes" || call === "bytearray" || call === "memoryview" || call === "int" || call === "float" || call === "complex") {
    const effect = classifyBuiltinPureCall(call, node, input, current)
    if (effect?.atom === "pure.compute") return call
    return
  }

  if (INSPECT_SIGNATURE_CALLS.has(call)) return "inspect-signature"
  if (INSPECT_PARAMETER_CALLS.has(call)) return "inspect-parameter"
  if (INSPECT_BOUND_ARGUMENTS_CALLS.has(call)) return "inspect-bound-arguments"

  if (call === "list" || call === "dict" || call === "set") {
    const effect = classifyBuiltinPureCall(call, node, input, current)
    if (effect?.atom === "pure.compute") return call
    return
  }

  if (call === "json.load") {
    if (hasJsonCustomizers(node, input)) return
    return "json"
  }

  if (call === "json.loads") {
    if (hasJsonCustomizers(node, input)) return
    return "json"
  }

  if (call === "next") {
    const effect = classifyBuiltinPureCall(call, node, input, current)
    if (effect?.atom !== "pure.compute") return
    const kind = containerKind(node, current)
    return kind
  }

  const effect = classifyResponseJson(call, node, input, current)
  if (effect?.atom === "pure.compute") return "json"
}

export function trackedContainerKind(node: Node | null, current: Scope): ContainerKind | undefined {
  if (!node) return

  const directMatch = matchKind(node, current)
  if (directMatch) return directMatch
  const directBytes = bytesKind(node, current)
  if (directBytes) return directBytes
  const directString = stringKind(node, current)
  if (directString) return directString
  const directNumeric = numericKind(node, current)
  if (directNumeric) return directNumeric

  if (node.type === "boolean_operator") {
    const left = trackedContainerKind(node.childForFieldName("left"), current)
    const right = trackedContainerKind(node.childForFieldName("right"), current)
    if (left && right && left === right) return left
    if (left === "json" && (right === "dict" || right === "list")) return "json"
    if (right === "json" && (left === "dict" || left === "list")) return "json"
    if (left === "string" && right === "string") return "string"
    return
  }

  if (node.type === "call") {
    const guarded = directTemporaryContainerKind(node, current)
    if (guarded) return guarded

    const call = resolvedName(node.childForFieldName("function"), current)
    if (call) {
      const method = tail(call)
      if (call === "list" || call === "dict" || call === "set" || call === "json.load" || call === "json.loads" || call === "next" || method === "json") {
        return
      }
    }
  }

  return containerKind(node, current)
}

export function trackedReceiverContainerKind(node: Node | null, current: Scope): ContainerKind | undefined {
  if (!node) return

  const temporary = directTemporaryContainerKind(node, current)
  if (temporary) return temporary
  return lookupTrackedReceiverContainerKind(current, node)
}

export function returnedTrackedContainerKind(node: Node | null, current: Scope): ContainerKind | undefined {
  if (!node || node.type !== "call") return
  const fn = node.childForFieldName("function")
  if (fn?.type !== "attribute") return
  const call = resolvedName(fn, current)
  if (!call) return
  const method = tail(call)
  const receiver = fn.childForFieldName("object")
  const receiverKind = trackedReceiverContainerKind(receiver, current)
  if (receiverKind === "string" && STRING_RETURNING_METHODS.has(method)) return "string"
  if (receiverKind === "inspect-signature") {
    if (method === "bind" || method === "bind_partial") return "inspect-bound-arguments"
    if (method === "format") return "string"
    if (method === "replace") return "inspect-signature"
  }
  if (receiverKind === "inspect-parameter" && method === "replace") return "inspect-parameter"
}

function generatorElementKind(node: Node | null, current: Scope): ContainerKind | undefined {
  if (!node || node.type !== "generator_expression") return
  const body = node.childForFieldName("body")
  const clause = node.namedChildren.find((child) => child.type === "for_in_clause")
  const target = clause?.childForFieldName("left")
  const source = clause?.childForFieldName("right")
  if (!body || body.type !== "identifier" || !target || target.type !== "identifier" || body.text !== target.text) return
  return iteratedContainerKind(source ?? null, current)
}

function homogeneousContainerKind(nodes: readonly Node[], current: Scope): ContainerKind | undefined {
  if (nodes.length === 0) return
  const first = trackedContainerKind(nodes[0] ?? null, current) ?? returnedTrackedContainerKind(nodes[0] ?? null, current)
  if (!first) return
  if (nodes.slice(1).every((node) => (trackedContainerKind(node, current) ?? returnedTrackedContainerKind(node, current)) === first)) {
    return first
  }
}

function comprehensionElementKind(node: Node, current: Scope): ContainerKind | undefined {
  const body = node.childForFieldName("body")
  if (!body) return
  const direct = trackedContainerKind(body, current) ?? returnedTrackedContainerKind(body, current)
  if (direct) return direct

  const clause = node.namedChildren.find((child) => child.type === "for_in_clause")
  const target = clause?.childForFieldName("left")
  const source = clause?.childForFieldName("right")
  if (body.type !== "identifier" || !target || target.type !== "identifier" || body.text !== target.text) return
  return iteratedContainerKind(source ?? null, current)
}

function iterableElementKind(node: Node | null, current: Scope): ContainerKind | undefined {
  if (!node) return

  if (node.type === "list" || node.type === "tuple" || node.type === "set") {
    return homogeneousContainerKind(node.namedChildren, current)
  }

  if (node.type === "list_comprehension" || node.type === "set_comprehension" || node.type === "generator_expression") {
    return comprehensionElementKind(node, current)
  }

  if (node.type !== "call") return
  const call = resolvedName(node.childForFieldName("function"), current)
  if (!call || (call !== "list" && call !== "tuple" && call !== "set")) return
  const effect = classifyBuiltinPureCall(call, node, args(node), current)
  if (effect?.atom !== "pure.compute") return
  const source = node.childForFieldName("arguments")?.namedChildren[0] ?? null
  return iteratedContainerKind(source, current)
}

export function rebindSource(node: Node) {
  if (node.type === "for_statement" || node.type === "async_for_statement" || node.type === "for_in_clause") {
    return node.childForFieldName("right")
  }
}

export function iteratedPathValue(node: Node | null, current: Scope): Value | undefined {
  if (!node) return

  if (node.type === "identifier") {
    return iteratedPathInstance(current, node.text)
  }

  if (node.type === "subscript") {
    const value = node.childForFieldName("value")
    const base = iteratedPathValue(value, current)
    const subscript = value ? node.namedChildren.find((child) => child.startIndex > value.endIndex) : undefined
    if (base && (subscript?.type === "slice" || subscript?.text.includes(":"))) return { dynamic: true }
  }

  if (node.type === "list" || node.type === "tuple") {
    const items = node.namedChildren
    if (items.length > 0 && items.every((child) => trackedPathValue(child, current))) return { dynamic: true }
  }

  if (node.type !== "call") return
  const call = resolvedName(node.childForFieldName("function"), current)
  const fn = node.childForFieldName("function")
  const method = call ? tail(call) : undefined
  const receiver = fn?.type === "attribute" ? fn.childForFieldName("object") : null
  if (method && (method === "glob" || method === "iterdir" || method === "rglob") && trackedPathValue(receiver, current)) {
    return { dynamic: true }
  }
}

export function iteratedContainerKind(node: Node | null, current: Scope): ContainerKind | undefined {
  if (node?.type === "identifier") {
    const iterated = iteratedElementInstance(current, node.text)
    if (iterated) return iterated
  }

  if (node?.type === "subscript") {
    const value = node.childForFieldName("value")
    const base = iteratedContainerKind(value, current)
    const subscript = value ? node.namedChildren.find((child) => child.startIndex > value.endIndex) : undefined
    if (base === "string" && (subscript?.type === "slice" || subscript?.text.includes(":"))) {
      return "string"
    }
  }

  if (node?.type === "call") {
    const call = resolvedName(node.childForFieldName("function"), current)
    const fn = node.childForFieldName("function")
    const method = call ? tail(call) : undefined
    const receiver = fn?.type === "attribute" ? fn.childForFieldName("object") : null
    if (method && STRING_ITERABLE_METHODS.has(method) && trackedContainerKind(receiver, current) === "string") {
      return "string"
    }
  }

  const elementKind = iterableElementKind(node, current)
  if (elementKind) return elementKind

  const kind = containerKind(node, current)
  if (kind === "json") return "json"
}

function enumeratedElementKind(node: Node | null, current: Scope): ContainerKind | undefined {
  if (!node || node.type !== "call") return
  const call = resolvedName(node.childForFieldName("function"), current)
  if (call !== "enumerate") return
  const effect = classifyBuiltinPureCall(call, node, args(node), current)
  if (effect?.atom !== "pure.compute") return
  const source = node.childForFieldName("arguments")?.namedChildren[0] ?? null
  return iteratedContainerKind(source, current)
}

function enumeratedPathValue(node: Node | null, current: Scope): Value | undefined {
  if (!node || node.type !== "call") return
  const call = resolvedName(node.childForFieldName("function"), current)
  if (call !== "enumerate") return
  const effect = classifyBuiltinPureCall(call, node, args(node), current)
  if (effect?.atom !== "pure.compute") return
  const source = node.childForFieldName("arguments")?.namedChildren[0] ?? null
  return iteratedPathValue(source, current)
}

export function rebindContainerKinds(target: Node | null, source: Node | null, current: Scope) {
  if (!target) return [] as Array<{ name: string; kind: ContainerKind }>

  if (target.type === "identifier") {
    const kind = iteratedContainerKind(source, current)
    return kind ? [{ name: target.text, kind }] : []
  }

  if (!(ASSIGNMENT_CONTAINER_TYPES.has(target.type) || target.type.endsWith("_pattern"))) {
    return [] as Array<{ name: string; kind: ContainerKind }>
  }

  const kind = enumeratedElementKind(source, current)
  if (!kind) return [] as Array<{ name: string; kind: ContainerKind }>

  const second = target.namedChildren[1]
  if (!second) return [] as Array<{ name: string; kind: ContainerKind }>
  return assignedNames(second)
    .filter((name) => name !== "_")
    .map((name) => ({ name, kind }))
}

export function rebindPathValues(target: Node | null, source: Node | null, current: Scope) {
  if (!target) return [] as Array<{ name: string; value: Value }>

  if (target.type === "identifier") {
    const value = iteratedPathValue(source, current)
    return value ? [{ name: target.text, value }] : []
  }

  if (!(ASSIGNMENT_CONTAINER_TYPES.has(target.type) || target.type.endsWith("_pattern"))) {
    return [] as Array<{ name: string; value: Value }>
  }

  const value = enumeratedPathValue(source, current)
  if (!value) return [] as Array<{ name: string; value: Value }>

  const second = target.namedChildren[1]
  if (!second) return [] as Array<{ name: string; value: Value }>
  return assignedNames(second)
    .filter((name) => name !== "_")
    .map((name) => ({ name, value }))
}
