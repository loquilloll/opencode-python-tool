import type { PythonAstNode as Node } from "./frontend/interface"
import {
  ASSIGNMENT_CONTAINER_TYPES,
  CALENDAR_INT_CALLS,
  CALENDAR_LIST_CALLS,
  CALENDAR_STRING_CALLS,
  CALENDAR_TUPLE_CALLS,
  COUNTER_CALLS,
  DATETIME_DATE_CALLS,
  DATETIME_DATE_CONSTANTS,
  DATETIME_DATETIME_CALLS,
  DATETIME_DATETIME_CONSTANTS,
  DATETIME_TIME_CALLS,
  DATETIME_TIME_CONSTANTS,
  DATETIME_TIMEDELTA_CALLS,
  DATETIME_TIMEDELTA_CONSTANTS,
  DATETIME_TIMEZONE_CALLS,
  DATETIME_TIMEZONE_CONSTANTS,
  HASHLIB_HASH_CALLS,
  INSPECT_BOUND_ARGUMENTS_CALLS,
  INSPECT_PARAMETER_CALLS,
  INSPECT_SIGNATURE_CALLS,
  JSON_CONTAINER_CALLS,
  JSON_CONTAINER_CUSTOMIZER_KEYWORDS,
  MATCH_RESULT_CALLS,
  OSPATH_FLOAT_CALLS,
  OSPATH_INT_CALLS,
  OSPATH_STRING_CALLS,
  OSPATH_TUPLE_CALLS,
  STRING_ITERABLE_METHODS,
  STRING_RETURNING_METHODS,
  TIME_FLOAT_CALLS,
  TIME_INT_CALLS,
  TIME_STRING_CALLS,
  TIME_TUPLE_CALLS,
  ZLIB_BYTES_CALLS,
  ZONEINFO_SET_CALLS,
  ZONEINFO_ZONE_CALLS,
} from "./python-known-methods"
import type { Scope, TimelineGuard } from "./python-analyze-types"
import { exactIteratedStringSet, exactStringSet } from "./python-key-equivalence"
import {
  containerInstance,
  directImportTarget,
  hasBoundName,
  hasTrustedBinding,
  lookupCallableFactoryContainer,
  lookupCallableFactoryTupleContainer,
  hasTrustedDirectBinding,
  hasHttpResponseInstance,
  hasTrustedModuleRoot,
  iteratedContainerTupleInstance,
  iteratedElementInstance,
  name,
  resolvedName,
  trustedCallWithPolicy,
  tupleContainerSlotInstance,
} from "./python-scope"
import {
  lookupTrackedReceiverContainerKind,
  lookupTrackedReceiverElementKind,
  type ContainerKind,
} from "./python-provenance"
import { assignedNames } from "./python-timeline"
import { classifyBuiltinPureCall, classifyResponseJson, hasDictionarySplat } from "./python-inference-effects"
import { trackedPathValue } from "./python-inference-paths"
import { args, tail, unwrapParenthesized } from "./python-inference-values"

function subscriptRootName(node: Node | null): string | undefined {
  if (!node) return
  if (node.type === "identifier") return node.text
  if (node.type === "subscript") return subscriptRootName(node.childForFieldName("value"))
}

function hasJsonCustomizers(node: Node, input: ReturnType<typeof args>) {
  if (hasDictionarySplat(node)) return true
  return Array.from(JSON_CONTAINER_CUSTOMIZER_KEYWORDS).some((keyword) => keyword in input.keyword)
}

const DIRECT_HELPER_RETURN_CONTAINER_KINDS = new Set<ContainerKind>([
  "datetime-date",
  "datetime-datetime",
  "datetime-time",
  "datetime-timedelta",
  "datetime-timezone",
])

function helperReturnContainerKind(node: Node | null, current: Scope): ContainerKind | undefined {
  if (!node || node.type !== "call") return
  const fn = node.childForFieldName("function")
  if (fn?.type !== "identifier") return
  const kind = lookupCallableFactoryContainer(current, fn.text)
  if (kind && DIRECT_HELPER_RETURN_CONTAINER_KINDS.has(kind)) return kind
}

function exactInteger(node: Node | null) {
  node = unwrapParenthesized(node)
  if (!node || node.type !== "integer") return
  const value = Number(node.text.replace(/_/g, ""))
  if (!Number.isInteger(value) || value < 0) return
  return value
}

export function tupleContainerSlotKinds(node: Node | null, current: Scope): ContainerKind[] | undefined {
  node = unwrapParenthesized(node)
  if (!node) return

  if (node.type === "identifier") {
    return tupleContainerSlotInstance(current, node.text)
  }

  if (node.type === "subscript") {
    const value = node.childForFieldName("value")
    const subscript = value ? node.namedChildren.find((child) => child.startIndex > value.endIndex) : undefined
    if (subscript && (subscript.type === "slice" || subscript.text.includes(":"))) return
    const iteratedTuple = iteratedContainerTupleValues(value, current)
    if (iteratedTuple) return iteratedTuple
  }

  if (node.type === "tuple" || node.type === "list") {
    if (node.namedChildren.length === 0) return
    const kinds = node.namedChildren.map((child) => trackedContainerKind(child, current) ?? returnedTrackedContainerKind(child, current))
    if (kinds.some((kind) => !kind)) return
    return kinds as ContainerKind[]
  }

  if (node.type === "call") {
    const fn = node.childForFieldName("function")
    if (fn?.type !== "identifier") return
    return lookupCallableFactoryTupleContainer(current, fn.text)
  }
}

export function iteratedContainerTupleValues(node: Node | null, current: Scope): ContainerKind[] | undefined {
  node = unwrapParenthesized(node)
  if (!node) return

  if (node.type === "identifier") {
    return iteratedContainerTupleInstance(current, node.text)
  }

  if (node.type === "list_comprehension" || node.type === "set_comprehension" || node.type === "generator_expression") {
    return comprehensionTupleSlotKinds(node, current)
  }

  if (node.type !== "list" && node.type !== "tuple") return
  const tuples = node.namedChildren
  if (tuples.length === 0) return
  const slotKinds = tuples.map((child) => tupleContainerSlotKinds(child, current))
  if (slotKinds.some((item) => !item)) return
  const width = slotKinds[0]?.length ?? 0
  if (width === 0) return
  if (!slotKinds.every((item) => item && item.length === width)) return

  const merged: ContainerKind[] = []
  for (let index = 0; index < width; index += 1) {
    const first = slotKinds[0]?.[index]
    if (!first) return
    if (!slotKinds.every((item) => item?.[index] === first)) return
    merged.push(first)
  }
  return merged
}

function tupleSubscriptContainerKind(node: Node | null, current: Scope): ContainerKind | undefined {
  node = unwrapParenthesized(node)
  if (!node || node.type !== "subscript") return
  const value = unwrapParenthesized(node.childForFieldName("value"))
  const slots = tupleContainerSlotKinds(value, current)
  if (!slots) return
  const subscript = value ? node.namedChildren.find((child) => child.startIndex > value.endIndex) : undefined
  const index = exactInteger(subscript ?? null)
  if (index === undefined || index >= slots.length) return
  return slots[index]
}

function trustedDatetimeRoot(node: Node | null, resolvedCall: string | undefined, current: Scope) {
  if (!resolvedCall?.startsWith("datetime.")) return true
  const rawRoot = name(node)?.split(".")[0]
  if (rawRoot !== "datetime") return true
  return !hasBoundName(current, rawRoot) || hasTrustedModuleRoot(current, rawRoot) || hasTrustedBinding(current, rawRoot) || hasTrustedDirectBinding(current, rawRoot)
}

function mergeConditionalContainerKinds(left: ContainerKind | undefined, right: ContainerKind | undefined) {
  if (left && right && left === right) return left
  if (left === "json" && (right === "dict" || right === "list")) return "json"
  if (right === "json" && (left === "dict" || left === "list")) return "json"
  return
}

function mergeTrackedConditionalContainerKinds(left: ContainerKind | undefined, right: ContainerKind | undefined) {
  const merged = mergeConditionalContainerKinds(left, right)
  if (merged) return merged
  if (left === "string" && right === "string") return "string"
  return
}

function binaryOperatorSymbol(node: Node) {
  const left = node.childForFieldName("left")
  const right = node.childForFieldName("right")
  if (!left || !right) return
  return node.text.slice(left.endIndex - node.startIndex, right.startIndex - node.startIndex).trim()
}

function binaryOperatorContainerKind(node: Node | null, current: Scope, tracked: boolean): ContainerKind | undefined {
  node = unwrapParenthesized(node)
  if (!node || node.type !== "binary_operator") return
  const left = node.childForFieldName("left")
  const right = node.childForFieldName("right")
  const leftKind = tracked
    ? trackedContainerKind(left, current) ?? returnedTrackedContainerKind(left, current)
    : containerKind(left, current)
  const rightKind = tracked
    ? trackedContainerKind(right, current) ?? returnedTrackedContainerKind(right, current)
    : containerKind(right, current)
  const operator = binaryOperatorSymbol(node)
  if (!operator) return
  if (operator === "+" && leftKind === "string" && rightKind === "string") return "string"
  if (leftKind === "counter" && rightKind === "counter" && (operator === "+" || operator === "-" || operator === "&" || operator === "|")) return "counter"
  if (operator === "-" && ((leftKind === "datetime-datetime" && rightKind === "datetime-datetime") || (leftKind === "datetime-date" && rightKind === "datetime-date"))) {
    return "datetime-timedelta"
  }
}

function conditionalExpressionBranches(node: Node) {
  const [consequence, _condition, alternative] = node.namedChildren
  return { consequence: consequence ?? null, alternative: alternative ?? null }
}

function containerKind(node: Node | null, current: Scope): ContainerKind | undefined {
  node = unwrapParenthesized(node)
  if (!node) return
  if (node.type === "list") return "list"
  if (node.type === "tuple") return "tuple"
  if (node.type === "dictionary") {
    const valueKind = homogeneousMappingValueKind(node.namedChildren, current)
    if (valueKind === "list") return "dict-list-values"
    if (valueKind === "set") return "dict-set-values"
    if (valueKind === "counter") return "dict-counter-values"
    return "dict"
  }
  if (node.type === "set") return "set"
  if (node.type === "list_comprehension") return "list"
  if (node.type === "dictionary_comprehension") return "dict"
  if (node.type === "set_comprehension") return "set"
  if (node.type === "subscript") {
    const tupleSlotKind = tupleSubscriptContainerKind(node, current)
    if (tupleSlotKind) return tupleSlotKind
    const value = node.childForFieldName("value")
    const base = trackedContainerKind(value, current) ?? returnedTrackedContainerKind(value, current) ?? lookupTrackedReceiverContainerKind(current, value) ?? containerKind(value, current)
    const subscript = value ? node.namedChildren.find((child) => child.startIndex > value.endIndex) : undefined
    if (base === "json") return "json"
    if (base === "dict-list-values") return "list"
    if (base === "dict-set-values") return "set"
    if (base === "dict-counter-values") return "counter"
    if (base === "string" && (subscript?.type === "slice" || subscript?.text.includes(":"))) return "string"
    if (base === "bytes" && (subscript?.type === "slice" || subscript?.text.includes(":"))) return "bytes"
    if (base === "bytearray" && (subscript?.type === "slice" || subscript?.text.includes(":"))) return "bytearray"
    if (base === "memoryview" && (subscript?.type === "slice" || subscript?.text.includes(":"))) return "memoryview"
    if (!subscript || (!subscript.text.includes(":") && subscript.type !== "slice")) {
      return value ? iteratedContainerKind(value, current) : undefined
    }
    return
  }
  if (node.type === "boolean_operator") {
    const left = containerKind(node.childForFieldName("left"), current)
    const right = containerKind(node.childForFieldName("right"), current)
    return mergeConditionalContainerKinds(left, right)
  }
  if (node.type === "conditional_expression") {
    const { consequence, alternative } = conditionalExpressionBranches(node)
    const consequenceKind = containerKind(consequence, current)
    const alternativeKind = containerKind(alternative, current)
    return mergeConditionalContainerKinds(consequenceKind, alternativeKind)
  }
  const binaryKind = binaryOperatorContainerKind(node, current, false)
  if (binaryKind) return binaryKind
  if (node.type !== "call") return
  const call = resolvedName(node.childForFieldName("function"), current)
  if (call === "list") return "list"
  if (call === "dict") return "dict"
  if (call === "set") return "set"
  if (call === "dir" || call === "sorted") {
    const effect = classifyBuiltinPureCall(call, node, args(node), current)
    if (effect?.atom === "pure.compute") return "list"
    return
  }
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
  if (!JSON_CONTAINER_CALLS.has(call)) return
  const input = args(node)
  if (hasJsonCustomizers(node, input)) return
  return "json"
}

function homogeneousMappingValueKind(nodes: readonly Node[], current: Scope): ContainerKind | undefined {
  if (nodes.some((node) => node.type !== "pair")) return
  const values = nodes
    .filter((node) => node.type === "pair")
    .map((node) => node.childForFieldName("value"))
    .filter((node): node is Node => Boolean(node))
  if (values.length === 0) return
  const first = trackedContainerKind(values[0] ?? null, current) ?? returnedTrackedContainerKind(values[0] ?? null, current)
  if (first !== "list" && first !== "set" && first !== "counter") return
  if (values.slice(1).every((node) => (trackedContainerKind(node, current) ?? returnedTrackedContainerKind(node, current)) === first)) {
    return first
  }
}

function isBytesLiteralText(text: string) {
  return /^(?:[rR]?[bB]|[bB][rR]?)['"]/.test(text.trim())
}

function bytesKind(node: Node | null, current: Scope): "bytes" | "bytearray" | "memoryview" | undefined {
  node = unwrapParenthesized(node)
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
  const fn = node.childForFieldName("function")
  const call = resolvedName(fn, current)
  if (!call || !MATCH_RESULT_CALLS.has(call)) return
  if (!call.startsWith("re.")) return "match"
  if (hasTrustedModuleRoot(current, "re") || !hasBoundName(current, "re")) return "match"
}

function directRegexListKind(node: Node | null, current: Scope): "list" | undefined {
  if (!node || node.type !== "call") return
  const call = resolvedName(node.childForFieldName("function"), current)
  if (call !== "re.findall" && call !== "re.split") return
  if (hasTrustedModuleRoot(current, "re") || !hasBoundName(current, "re")) return "list"
}

function trustedRegexRoot(node: Node | null, resolvedCall: string | undefined, current: Scope) {
  if (!resolvedCall?.startsWith("re.")) return true
  const rawRoot = name(node)?.split(".")[0]
  if (rawRoot !== "re") return true
  return !hasBoundName(current, rawRoot) || hasTrustedModuleRoot(current, rawRoot) || hasTrustedBinding(current, rawRoot) || hasTrustedDirectBinding(current, rawRoot)
}

function numericKind(node: Node | null): "int" | "float" | "complex" | undefined {
  if (!node) return
  if (node.type === "integer") return "int"
  if (node.type === "float") return "float"
}

function stringKind(node: Node | null, current: Scope, guards: TimelineGuard[] = []): "string" | undefined {
  node = unwrapParenthesized(node)
  if (!node) return
  if ((node.type === "string" || node.type === "concatenated_string") && !isBytesLiteralText(node.text)) return "string"
  if (node.type === "identifier" && exactStringSet(current, node, guards)) return "string"
  if (node.type !== "call") return
  const call = resolvedName(node.childForFieldName("function"), current)
  if (call?.endsWith("Path.read_text")) return "string"
  const fn = node.childForFieldName("function")
  const method = call ? tail(call) : undefined
  const receiver = fn?.type === "attribute" ? fn.childForFieldName("object") : null
  const receiverKind = trackedReceiverContainerKind(receiver, current)
  if ((receiverKind === "bytes" || receiverKind === "bytearray") && method === "decode") return "string"
  if (method === "read_text" && trackedPathValue(receiver, current)) return "string"
  if (call === "re.sub" && trustedRegexRoot(fn, call, current)) {
    const argNodes = node.childForFieldName("arguments")?.namedChildren ?? []
    if (argNodes.length < 3) return
    const replacement = exactStringSet(current, argNodes[1] ?? null, guards)
    const sourceNode = argNodes[2] ?? null
    const sourceKind = trackedReceiverContainerKind(sourceNode, current, guards) ?? trackedContainerKind(sourceNode, current, guards) ?? stringKind(sourceNode, current, guards)
    if (replacement && sourceKind === "string") return "string"
  }
}

function datetimeConstantKind(call: string): ContainerKind | undefined {
  if (DATETIME_DATE_CONSTANTS.has(call)) return "datetime-date"
  if (DATETIME_DATETIME_CONSTANTS.has(call)) return "datetime-datetime"
  if (DATETIME_TIME_CONSTANTS.has(call)) return "datetime-time"
  if (DATETIME_TIMEDELTA_CONSTANTS.has(call)) return "datetime-timedelta"
  if (DATETIME_TIMEZONE_CONSTANTS.has(call)) return "datetime-timezone"
}

function datetimeCallKind(call: string): ContainerKind | undefined {
  if (DATETIME_DATE_CALLS.has(call)) return "datetime-date"
  if (DATETIME_DATETIME_CALLS.has(call)) return "datetime-datetime"
  if (DATETIME_TIME_CALLS.has(call)) return "datetime-time"
  if (DATETIME_TIMEDELTA_CALLS.has(call)) return "datetime-timedelta"
  if (DATETIME_TIMEZONE_CALLS.has(call)) return "datetime-timezone"
}

function timeCallKind(call: string): ContainerKind | undefined {
  if (TIME_FLOAT_CALLS.has(call)) return "float"
  if (TIME_INT_CALLS.has(call)) return "int"
  if (TIME_STRING_CALLS.has(call)) return "string"
  if (TIME_TUPLE_CALLS.has(call)) return "tuple"
}

function calendarCallKind(call: string): ContainerKind | undefined {
  if (CALENDAR_INT_CALLS.has(call)) return "int"
  if (CALENDAR_STRING_CALLS.has(call)) return "string"
  if (CALENDAR_TUPLE_CALLS.has(call)) return "tuple"
  if (CALENDAR_LIST_CALLS.has(call)) return "list"
}

function osPathCallKind(call: string): ContainerKind | undefined {
  if (OSPATH_FLOAT_CALLS.has(call)) return "float"
  if (OSPATH_INT_CALLS.has(call)) return "int"
  if (OSPATH_STRING_CALLS.has(call)) return "string"
  if (OSPATH_TUPLE_CALLS.has(call)) return "tuple"
}

function counterCallKind(call: string): ContainerKind | undefined {
  if (COUNTER_CALLS.has(call)) return "counter"
}

function defaultdictCallKind(node: Node, call: string, current: Scope): ContainerKind | undefined {
  if (call !== "collections.defaultdict") return
  const first = node.childForFieldName("arguments")?.namedChildren[0] ?? null
  const target = resolvedName(first, current)
  if (target === "set" && !hasBoundName(current, "set")) return "dict-set-values"
  if (target === "list" && !hasBoundName(current, "list")) return "dict-list-values"
  if (target === "collections.Counter" && trustedCallWithPolicy(first, target, current)) return "dict-counter-values"
}

function itemsValueKind(node: Node | null, current: Scope): ContainerKind | undefined {
  if (!node || node.type !== "call") return
  const fn = node.childForFieldName("function")
  if (fn?.type !== "attribute") return
  const call = resolvedName(fn, current)
  const method = call ? tail(call) : undefined
  if (method !== "items") return
  const input = args(node)
  if (input.positional.length !== 0 || Object.keys(input.keyword).length !== 0 || hasDictionarySplat(node)) return
  const receiver = fn.childForFieldName("object")
  if (receiver?.type !== "identifier") return
  const receiverKind = trackedReceiverContainerKind(receiver, current)
  if (receiverKind === "dict-list-values") return "list"
  if (receiverKind === "dict-set-values") return "set"
  if (receiverKind === "dict-counter-values") return "counter"
}

function itemsKeyKind(node: Node | null, current: Scope): ContainerKind | undefined {
  if (!node || node.type !== "call") return
  const fn = node.childForFieldName("function")
  if (fn?.type !== "attribute") return
  const call = resolvedName(fn, current)
  const method = call ? tail(call) : undefined
  if (method !== "items") return
  const input = args(node)
  if (input.positional.length !== 0 || Object.keys(input.keyword).length !== 0 || hasDictionarySplat(node)) return
  const receiver = fn.childForFieldName("object")
  const keys = exactIteratedStringSet(current, receiver)
  return keys ? "string" : undefined
}

function zoneinfoCallKind(call: string): ContainerKind | undefined {
  if (ZONEINFO_ZONE_CALLS.has(call)) return "datetime-timezone"
  if (ZONEINFO_SET_CALLS.has(call)) return "set"
}

function hashlibCallKind(call: string): ContainerKind | undefined {
  if (HASHLIB_HASH_CALLS.has(call)) return "hashlib-hash"
}

function zlibCallKind(call: string): ContainerKind | undefined {
  if (ZLIB_BYTES_CALLS.has(call)) return "bytes"
}

function trustedImportedClassMroSource(node: Node | null, current: Scope) {
  node = unwrapParenthesized(node)
  if (!node || node.type !== "attribute") return false
  if (node.childForFieldName("attribute")?.text !== "__mro__") return false
  const object = unwrapParenthesized(node.childForFieldName("object"))
  if (!object || object.type !== "identifier") return false
  if (object.text !== "GraphServiceClient" || !hasTrustedDirectBinding(current, object.text)) return false
  const target = directImportTarget(current, object.text)
  return target === "msgraph.GraphServiceClient" || target === "msgraph.graph_service_client.GraphServiceClient"
}

export function directTemporaryContainerKind(node: Node | null, current: Scope, guards: TimelineGuard[] = []): ContainerKind | undefined {
  node = unwrapParenthesized(node)
  if (!node) return

  const directCall = resolvedName(node, current)
  if (directCall) {
    const directDatetime = datetimeConstantKind(directCall)
    if (directDatetime && trustedDatetimeRoot(node, directCall, current)) return directDatetime
  }

  const directMatch = matchKind(node, current)
  if (directMatch) return directMatch
  const directRegexList = directRegexListKind(node, current)
  if (directRegexList) return directRegexList
  const directBytes = bytesKind(node, current)
  if (directBytes) return directBytes
  const directString = stringKind(node, current, guards)
  if (directString) return directString
  const directNumeric = numericKind(node)
  if (directNumeric) return directNumeric
  if (node.type !== "call") return
  const helperReturn = helperReturnContainerKind(node, current)
  if (helperReturn) return helperReturn
  const call = resolvedName(node.childForFieldName("function"), current)
  if (!call) return
  const input = args(node)
  if (!trustedCallWithPolicy(node.childForFieldName("function"), call, current)) return
  if (call === "re.compile") return "regex-pattern"
  if (call === "int.from_bytes") {
    const effect = classifyBuiltinPureCall(call, node, input, current)
    if (effect?.atom === "pure.compute") return "int"
    return
  }
  if (call === "struct.unpack") return "tuple"
  if (call === "dir" || call === "sorted") {
    const effect = classifyBuiltinPureCall(call, node, input, current)
    if (effect?.atom === "pure.compute") return "list"
    return
  }

  const datetimeKind = datetimeCallKind(call)
  if (datetimeKind) {
    if (!trustedDatetimeRoot(node.childForFieldName("function"), call, current)) return
    return datetimeKind
  }
  const timeKind = timeCallKind(call)
  if (timeKind) return timeKind
  const calendarKind = calendarCallKind(call)
  if (calendarKind) return calendarKind
  const counterKind = counterCallKind(call)
  if (counterKind) return counterKind
  const defaultdictKind = defaultdictCallKind(node, call, current)
  if (defaultdictKind) return defaultdictKind
  const osPathKind = osPathCallKind(call)
  if (osPathKind) return osPathKind
  const hashlibKind = hashlibCallKind(call)
  if (hashlibKind) return hashlibKind
  const zlibKind = zlibCallKind(call)
  if (zlibKind) return zlibKind
  const zoneinfoKind = zoneinfoCallKind(call)
  if (zoneinfoKind) return zoneinfoKind

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
  if (
    call === "unittest.mock.Mock" ||
    call === "unittest.mock.MagicMock" ||
    call === "unittest.mock.PropertyMock" ||
    call === "unittest.mock.NonCallableMock" ||
    call === "unittest.mock.NonCallableMagicMock"
  ) {
    return "mock"
  }
  if (call === "unittest.mock.AsyncMock") return "async-mock"

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
    return containerKind(node, current)
  }

  const effect = classifyResponseJson(call, node, input, current)
  if (effect?.atom === "pure.compute") return "json"
}

export function trackedContainerKind(node: Node | null, current: Scope, guards: TimelineGuard[] = []): ContainerKind | undefined {
  node = unwrapParenthesized(node)
  if (!node) return
  if (node.type === "identifier") {
    if (tupleContainerSlotInstance(current, node.text)) return "tuple"
    const local = containerInstance(current, node.text)
    if (local) return local
  }

  const trackedReceiver = lookupTrackedReceiverContainerKind(current, node)
  if (trackedReceiver) return trackedReceiver

  const directMatch = matchKind(node, current)
  if (directMatch) return directMatch
  const directBytes = bytesKind(node, current)
  if (directBytes) return directBytes
  const directString = stringKind(node, current, guards)
  if (directString) return directString
  const directNumeric = numericKind(node)
  if (directNumeric) return directNumeric

  if (node.type === "boolean_operator") {
    const left = trackedContainerKind(node.childForFieldName("left"), current)
    const right = trackedContainerKind(node.childForFieldName("right"), current)
    return mergeTrackedConditionalContainerKinds(left, right)
  }

  if (node.type === "conditional_expression") {
    const { consequence, alternative } = conditionalExpressionBranches(node)
    const consequenceKind = trackedContainerKind(consequence, current)
    const alternativeKind = trackedContainerKind(alternative, current)
    return mergeTrackedConditionalContainerKinds(consequenceKind, alternativeKind)
  }

  const binaryKind = binaryOperatorContainerKind(node, current, true)
  if (binaryKind) return binaryKind

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

export function trackedReceiverContainerKind(node: Node | null, current: Scope, guards: TimelineGuard[] = []): ContainerKind | undefined {
  node = unwrapParenthesized(node)
  if (!node) return

  const temporary = directTemporaryContainerKind(node, current, guards) ?? trackedContainerKind(node, current, guards) ?? returnedTrackedContainerKind(node, current)
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
  if (receiverKind === "datetime-date") {
    if (method === "ctime" || method === "isoformat" || method === "strftime") return "string"
    if (method === "replace") return "datetime-date"
  }
  if (receiverKind === "datetime-datetime") {
    if (method === "astimezone" || method === "replace") return "datetime-datetime"
    if (method === "ctime" || method === "isoformat" || method === "strftime") return "string"
    if (method === "date") return "datetime-date"
    if (method === "dst" || method === "utcoffset") return "datetime-timedelta"
    if (method === "time" || method === "timetz") return "datetime-time"
    if (method === "tzname") return "string"
    if (method === "timestamp") return "float"
  }
  if (receiverKind === "datetime-time") {
    if (method === "dst" || method === "utcoffset") return "datetime-timedelta"
    if (method === "isoformat" || method === "strftime") return "string"
    if (method === "replace") return "datetime-time"
    if (method === "tzname") return "string"
  }
  if (receiverKind === "match" && method === "groups") return "tuple"
  if (receiverKind === "datetime-timedelta" && method === "total_seconds") return "float"
  if (receiverKind === "datetime-timezone") {
    if (method === "dst" || method === "utcoffset") return "datetime-timedelta"
    if (method === "fromutc") return "datetime-datetime"
    if (method === "tzname") return "string"
  }
  if (receiverKind === "counter") {
    if (method === "copy") return "counter"
    if (method === "most_common") return "list"
    if (method === "total") return "int"
  }
  if (receiverKind === "string" && STRING_ITERABLE_METHODS.has(method)) return "list"
  if ((receiverKind === "bytes" || receiverKind === "bytearray") && (method === "split" || method === "rsplit" || method === "splitlines")) return "list"
  if (receiverKind === "hashlib-hash") {
    if (method === "copy") return "hashlib-hash"
    if (method === "digest") return "bytes"
    if (method === "hexdigest") return "string"
  }
  if (receiverKind === "regex-pattern") {
    if (method === "search" || method === "match" || method === "fullmatch") return "match"
    if (method === "findall" || method === "split") return "list"
  }
  if (receiverKind === "match") {
    const input = args(node)
    if ((method === "group" || method === "__getitem__") && input.positional.length <= 1 && Object.keys(input.keyword).length === 0 && !hasDictionarySplat(node)) {
      return "string"
    }
  }
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

function comprehensionTupleSlotKinds(node: Node, current: Scope): ContainerKind[] | undefined {
  const body = node.childForFieldName("body")
  if (!body || (body.type !== "tuple" && body.type !== "list")) return
  const clause = node.namedChildren.find((child) => child.type === "for_in_clause")
  const target = clause?.childForFieldName("left")
  const source = clause?.childForFieldName("right")
  const seeded = new Map(rebindContainerKinds(target ?? null, source ?? null, current).map((item) => [item.name, item.kind] as const))
  const kinds = body.namedChildren.map((child) => {
    const direct = trackedContainerKind(child, current) ?? returnedTrackedContainerKind(child, current)
    if (direct) return direct
    if (child.type === "identifier") return seeded.get(child.text)
  })
  if (kinds.some((kind) => !kind)) return
  return kinds as ContainerKind[]
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

export function iteratedContainerKind(node: Node | null, current: Scope): ContainerKind | undefined {
  const trackedReceiverElement = lookupTrackedReceiverElementKind(current, node)
  if (trackedReceiverElement) return trackedReceiverElement

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
    if (call === "dir") {
      const effect = classifyBuiltinPureCall(call, node, args(node), current)
      if (effect?.atom === "pure.compute") return "string"
    }
    if (call === "sorted") {
      const effect = classifyBuiltinPureCall(call, node, args(node), current)
      if (effect?.atom === "pure.compute") {
        const source = node.childForFieldName("arguments")?.namedChildren[0] ?? null
        return iteratedContainerKind(source, current)
      }
    }
    if (call === "re.split") {
      if (trustedRegexRoot(fn, call, current)) return "string"
    }
    if (call === "re.finditer") {
      if (hasTrustedModuleRoot(current, "re") || !hasBoundName(current, "re")) return "match"
    }
    if (method === "split" && trackedReceiverContainerKind(receiver, current) === "regex-pattern") return "string"
    if (method === "finditer" && trackedReceiverContainerKind(receiver, current) === "regex-pattern") return "match"
    if (method && STRING_ITERABLE_METHODS.has(method) && trackedReceiverContainerKind(receiver, current) === "string") {
      return "string"
    }
    if (method && (method === "split" || method === "rsplit" || method === "splitlines")) {
      const receiverKind = trackedReceiverContainerKind(receiver, current)
      if (receiverKind === "bytes") return "bytes"
      if (receiverKind === "bytearray") return "bytearray"
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

function enumeratedContainerTupleValues(node: Node | null, current: Scope) {
  if (!node || node.type !== "call") return
  const call = resolvedName(node.childForFieldName("function"), current)
  if (call !== "enumerate") return
  const effect = classifyBuiltinPureCall(call, node, args(node), current)
  if (effect?.atom !== "pure.compute") return
  const source = node.childForFieldName("arguments")?.namedChildren[0] ?? null
  return iteratedContainerTupleValues(source, current)
}

function tupleContainerKindAssignments(target: Node | null, kinds: ContainerKind[]) {
  if (!target) return [] as Array<{ name: string; kind: ContainerKind }>
  if (!(ASSIGNMENT_CONTAINER_TYPES.has(target.type) || target.type.endsWith("_pattern"))) {
    return [] as Array<{ name: string; kind: ContainerKind }>
  }
  if (target.namedChildren.length !== kinds.length) {
    return [] as Array<{ name: string; kind: ContainerKind }>
  }
  return target.namedChildren
    .map((child, index) => ({ child, kind: kinds[index] }))
    .filter((item): item is { child: Node; kind: ContainerKind } => Boolean(item.child && item.kind && item.child.type === "identifier"))
    .flatMap(({ child, kind }) => assignedNames(child).filter((name) => name !== "_").map((name) => ({ name, kind })))
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

  const tupleKinds = iteratedContainerTupleValues(source, current)
  if (tupleKinds) {
    if (target.namedChildren.length !== tupleKinds.length || !target.namedChildren.every((child) => child.type === "identifier")) {
      return [] as Array<{ name: string; kind: ContainerKind }>
    }
    return target.namedChildren
      .map((child, index) => ({ child, kind: tupleKinds[index] }))
      .filter((item): item is { child: Node; kind: ContainerKind } => Boolean(item.child && item.kind))
      .flatMap(({ child, kind }) => assignedNames(child).filter((name) => name !== "_").map((name) => ({ name, kind })))
  }

  const itemValueKind = itemsValueKind(source, current)
  const itemKeyKind = itemsKeyKind(source, current)
  if (itemValueKind || itemKeyKind) {
    const assignments: Array<{ name: string; kind: ContainerKind }> = []
    const first = target.namedChildren[0]
    const second = target.namedChildren[1]
    if (itemKeyKind && first?.type === "identifier" && first.text !== "_") assignments.push({ name: first.text, kind: itemKeyKind })
    if (itemValueKind && second?.type === "identifier" && second.text !== "_") assignments.push({ name: second.text, kind: itemValueKind })
    return assignments
  }

  const kind = enumeratedElementKind(source, current)
  const enumeratedTupleKinds = enumeratedContainerTupleValues(source, current)
  if (enumeratedTupleKinds) {
    const second = target.namedChildren[1]
    return tupleContainerKindAssignments(second ?? null, enumeratedTupleKinds)
  }
  if (!kind) return [] as Array<{ name: string; kind: ContainerKind }>

  const enumerateCall = source?.type === "call" ? resolvedName(source.childForFieldName("function"), current) : undefined
  if (enumerateCall === "enumerate") {
    const first = target.namedChildren[0]
    const second = target.namedChildren[1]
    const assignments: Array<{ name: string; kind: ContainerKind }> = []
    if (first?.type === "identifier" && first.text !== "_") assignments.push({ name: first.text, kind: "int" })
    if (second?.type === "identifier" && second.text !== "_") assignments.push({ name: second.text, kind })
    return assignments
  }

  const second = target.namedChildren[1]
  if (!second) return [] as Array<{ name: string; kind: ContainerKind }>
  return assignedNames(second)
    .filter((name) => name !== "_")
    .map((name) => ({ name, kind }))
}

export function rebindTupleContainerSlotKinds(target: Node | null, source: Node | null, current: Scope) {
  if (!target || !(ASSIGNMENT_CONTAINER_TYPES.has(target.type) || target.type.endsWith("_pattern"))) {
    return [] as Array<{ name: string; kinds: ContainerKind[] }>
  }

  const tupleKinds = enumeratedContainerTupleValues(source, current)
  if (!tupleKinds) return [] as Array<{ name: string; kinds: ContainerKind[] }>

  const second = target.namedChildren[1]
  if (second?.type !== "identifier" || second.text === "_") return [] as Array<{ name: string; kinds: ContainerKind[] }>
  return [{ name: second.text, kinds: tupleKinds }]
}

export function rebindReceiverContainerKinds(target: Node | null, source: Node | null, current: Scope) {
  if (!target || target.type !== "identifier" || target.text === "_") {
    return [] as Array<{ path: string; kind: ContainerKind; deps: string[] }>
  }
  if (!trustedImportedClassMroSource(source, current)) {
    return [] as Array<{ path: string; kind: ContainerKind; deps: string[] }>
  }
  return [{ path: `${target.text}.__module__`, kind: "string" as ContainerKind, deps: [target.text] }]
}
