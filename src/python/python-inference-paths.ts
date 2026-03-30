import path from "path"
import type { PythonAstNode as Node } from "./frontend/interface"
import { ASSIGNMENT_CONTAINER_TYPES, PATH_DYNAMIC_RETURNING_METHODS } from "./python-known-methods"
import type { Scope } from "./python-analyze-types"
import { lookupTrackedReceiverPathValue } from "./python-provenance"
import { assignedNames } from "./python-timeline"
import { callableFactoryReturn, iteratedPathInstance, iteratedPathTupleInstance, pathInstanceValue, resolvedName } from "./python-scope"
import type { PythonValue as Value } from "./python-values"
import { classifyBuiltinPureCall } from "./python-inference-effects"
import { args, parseString, pick, tail } from "./python-inference-values"

function firstArgumentNode(node: Node) {
  const input = node.childForFieldName("arguments")
  if (!input) return null
  if (
    input.type === "generator_expression" ||
    input.type === "list_comprehension" ||
    input.type === "set_comprehension" ||
    input.type === "dictionary_comprehension"
  ) {
    return input
  }
  return input.namedChildren[0] ?? null
}

function callableFactoryPathValue(node: Node, current: Scope, seenFactories: Set<string>): Value | undefined {
  const input = args(node)
  const call = resolvedName(node.childForFieldName("function"), current)
  if (!call || seenFactories.has(call)) return

  const returned = callableFactoryReturn(node, current, input)
  if (!returned) return
  if (
    returned.type !== "identifier" &&
    returned.type !== "attribute" &&
    returned.type !== "call" &&
    returned.type !== "binary_operator"
  ) {
    return
  }

  const nextSeen = new Set(seenFactories)
  nextSeen.add(call)
  return trackedPathValue(returned, current, nextSeen)
}

export function trackedPathValue(node: Node | null, current: Scope, seenFactories = new Set<string>()): Value | undefined {
  if (!node) return
  if (node.type === "parenthesized_expression") {
    return trackedPathValue(node.namedChildren[0] ?? null, current, seenFactories)
  }
  if (node.type === "identifier") return pathInstanceValue(current, node.text)
  if (node.type === "attribute") {
    const object = node.childForFieldName("object")
    const attribute = node.childForFieldName("attribute")?.text
    if (attribute === "parent" && trackedPathValue(object, current)) return { dynamic: true }
  }
  const receiverPath = lookupTrackedReceiverPathValue(current, node)
  if (receiverPath) return receiverPath

  if (node.type === "binary_operator") {
    const left = node.childForFieldName("left")
    const right = node.childForFieldName("right")
    const base = trackedPathValue(left, current)
    const segment = right?.type === "string" ? parseString(right.text) : undefined
    const between = left && right ? node.text.slice(left.text.length, node.text.length - right.text.length) : ""
    if (base && between.includes("/")) {
      if (segment === undefined || base.dynamic || base.literal === undefined) return { dynamic: true }
      return { dynamic: false, literal: path.join(base.literal, segment) }
    }
  }

  if (node.type !== "call") return

  const factoryValue = callableFactoryPathValue(node, current, seenFactories)
  if (factoryValue) return factoryValue

  const call = resolvedName(node.childForFieldName("function"), current)
  if (!call) return
  if (call === "Path" || call === "pathlib.Path") return pick(args(node), 0, ["path"]) ?? { dynamic: true }
  if (call === "Path.cwd" || call === "pathlib.Path.cwd") return { dynamic: true }
  if (call === "Path.home" || call === "pathlib.Path.home") return { dynamic: true }
  if (call === "Path.from_uri" || call === "pathlib.Path.from_uri") return { dynamic: true }

  const method = tail(call)
  const fn = node.childForFieldName("function")
  const receiver = fn?.type === "attribute" ? fn.childForFieldName("object") : null
  if (method === "pop" && receiver?.type === "identifier") {
    const input = args(node)
    if (input.positional.length <= 1 && Object.keys(input.keyword).length === 0) {
      const direct = iteratedPathInstance(current, receiver.text)
      if (direct) return direct
      const resolved = resolvedName(receiver, current)
      if (resolved && resolved !== receiver.text) return iteratedPathInstance(current, resolved)
    }
  }
  const base = trackedPathValue(receiver, current)
  if (!base) return

  if (method && PATH_DYNAMIC_RETURNING_METHODS.has(method)) return { dynamic: true }
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

  if (node.type === "binary_operator") {
    const left = node.childForFieldName("left")
    const right = node.childForFieldName("right")
    if (iteratedPathValue(left, current) && iteratedPathValue(right, current) && node.text.includes("|")) {
      return { dynamic: true }
    }
  }

  if (node.type === "list" || node.type === "tuple" || node.type === "set") {
    const items = node.namedChildren
    if (items.length > 0 && items.every((child) => trackedPathValue(child, current))) return { dynamic: true }
  }

  if (node.type === "generator_expression" || node.type === "list_comprehension" || node.type === "set_comprehension") {
    const direct = seededComprehensionPathValue(node, current)
    if (direct) return direct
  }

  if (node.type !== "call") return
  const call = resolvedName(node.childForFieldName("function"), current)
  const fn = node.childForFieldName("function")
  const method = call ? tail(call) : undefined
  const receiver = fn?.type === "attribute" ? fn.childForFieldName("object") : null
  if (call === "sorted") {
    const effect = classifyBuiltinPureCall(call, node, args(node), current)
    if (effect?.atom === "pure.compute") {
      const source = firstArgumentNode(node)
      return iteratedPathValue(source, current)
    }
  }
  if (call === "list" || call === "tuple" || call === "set") {
    const effect = classifyBuiltinPureCall(call, node, args(node), current)
    if (effect?.atom === "pure.compute") {
      const source = firstArgumentNode(node)
      return iteratedPathValue(source, current)
    }
  }
  if (method && (method === "glob" || method === "iterdir" || method === "rglob") && trackedPathValue(receiver, current)) {
    return { dynamic: true }
  }
}

export function iteratedPathTupleValues(node: Node | null, current: Scope): Value[] | undefined {
  if (!node) return

  if (node.type === "identifier") {
    return iteratedPathTupleInstance(current, node.text)
  }

  if (node.type !== "list" && node.type !== "tuple") return
  const tuples = node.namedChildren
  if (tuples.length === 0) return
  if (!tuples.every((child) => child.type === "list" || child.type === "tuple")) return
  const width = tuples[0]?.namedChildren.length ?? 0
  if (width === 0) return
  if (!tuples.every((child) => child.namedChildren.length === width)) return

  const slots: Value[] = []
  for (let index = 0; index < width; index += 1) {
    const values = tuples.map((child) => trackedPathValue(child.namedChildren[index] ?? null, current))
    if (values.some((value) => !value)) return
    slots.push({ dynamic: true })
  }
  return slots
}

function enumeratedPathValue(node: Node | null, current: Scope): Value | undefined {
  if (!node || node.type !== "call") return
  const call = resolvedName(node.childForFieldName("function"), current)
  if (call !== "enumerate") return
  const effect = classifyBuiltinPureCall(call, node, args(node), current)
  if (effect?.atom !== "pure.compute") return
  const source = firstArgumentNode(node)
  return iteratedPathValue(source, current)
}

function seededComprehensionPathValue(node: Node, current: Scope): Value | undefined {
  const body = node.childForFieldName("body")
  const clause = node.namedChildren.find((child) => child.type === "for_in_clause")
  const target = clause?.childForFieldName("left")
  const source = clause?.childForFieldName("right")
  const seeded = new Map(rebindPathValues(target ?? null, source ?? null, current).map((item) => [item.name, item.value] as const))
  if (seeded.size === 0 || !body) return

  if (body.type === "identifier") return seeded.get(body.text)

  if (body.type === "attribute") {
    const receiver = body.childForFieldName("object")
    const attribute = body.childForFieldName("attribute")?.text
    if (attribute === "parent" && receiver?.type === "identifier" && seeded.has(receiver.text)) return { dynamic: true }
  }

  if (body.type !== "call") return
  const fn = body.childForFieldName("function")
  if (fn?.type !== "attribute") return
  const receiver = fn.childForFieldName("object")
  const method = fn.childForFieldName("attribute")?.text
  if (receiver?.type !== "identifier" || !method) return
  const base = seeded.get(receiver.text)
  if (!base) return
  if (PATH_DYNAMIC_RETURNING_METHODS.has(method)) return { dynamic: true }
  if (method !== "joinpath") return

  const input = args(body)
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

export function rebindPathValues(target: Node | null, source: Node | null, current: Scope) {
  if (!target) return [] as Array<{ name: string; value: Value }>

  if (target.type === "identifier") {
    const value = iteratedPathValue(source, current)
    return value ? [{ name: target.text, value }] : []
  }

  if (!(ASSIGNMENT_CONTAINER_TYPES.has(target.type) || target.type.endsWith("_pattern"))) {
    return [] as Array<{ name: string; value: Value }>
  }

  const tupleValues = iteratedPathTupleValues(source, current)
  if (tupleValues) {
    if (!target.namedChildren.every((child) => child.type === "identifier")) {
      return [] as Array<{ name: string; value: Value }>
    }
    return target.namedChildren
      .map((child, index) => ({ child, value: tupleValues[index] }))
      .filter((item): item is { child: Node; value: Value } => Boolean(item.child && item.value))
      .flatMap(({ child, value }) =>
        assignedNames(child)
          .filter((name) => name !== "_")
          .map((name) => ({ name, value })),
      )
  }

  const value = enumeratedPathValue(source, current)
  if (!value) return [] as Array<{ name: string; value: Value }>

  const second = target.namedChildren[1]
  if (!second) return [] as Array<{ name: string; value: Value }>
  return assignedNames(second)
    .filter((name) => name !== "_")
    .map((name) => ({ name, value }))
}
