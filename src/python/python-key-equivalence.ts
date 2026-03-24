import type { PythonAstNode as Node } from "./frontend/interface"
import { unwrapParenthesized, value } from "./python-inference-values"
import type { PythonValue as Value } from "./python-values"

const MAX_EXACT_STRINGS = 8

type Guards = readonly Node[]

type ValueScope = {
  parent?: ValueScope
  bindings: Map<string, string>
  valueInstances: Map<string, Value>
  exactStringSets: Map<string, string[]>
  exactIteratedStringSets: Map<string, string[]>
}

function uniqueStrings(values: string[]) {
  const unique = Array.from(new Set(values))
  if (unique.length === 0 || unique.length > MAX_EXACT_STRINGS) return
  return unique
}

function exactValueInstance(current: ValueScope, name: string): Value | undefined {
  const seen = new Set<string>()
  let target: string | undefined = name
  while (target && !seen.has(target)) {
    seen.add(target)
    let rebound = false
    for (let scope: ValueScope | undefined = current; scope; scope = scope.parent) {
      const localValue = scope.valueInstances.get(target)
      if (localValue) return localValue
      const bound = scope.bindings.get(target)
      if (!bound) continue
      if (bound !== target) {
        target = bound
        rebound = true
      }
      break
    }
    if (!rebound) return
  }
}

function exactStringSetInstance(current: ValueScope, name: string): string[] | undefined {
  const seen = new Set<string>()
  let target: string | undefined = name
  while (target && !seen.has(target)) {
    seen.add(target)
    let rebound = false
    for (let scope: ValueScope | undefined = current; scope; scope = scope.parent) {
      const exact = scope.exactStringSets.get(target)
      if (exact) return exact
      const localValue = scope.valueInstances.get(target)
      if (localValue && !localValue.dynamic && localValue.literal !== undefined) return [localValue.literal]
      const bound = scope.bindings.get(target)
      if (!bound) continue
      if (bound !== target) {
        target = bound
        rebound = true
      }
      break
    }
    if (!rebound) return
  }
}

function exactIteratedStringSetInstance(current: ValueScope, name: string): string[] | undefined {
  const seen = new Set<string>()
  let target: string | undefined = name
  while (target && !seen.has(target)) {
    seen.add(target)
    let rebound = false
    for (let scope: ValueScope | undefined = current; scope; scope = scope.parent) {
      const exact = scope.exactIteratedStringSets.get(target)
      if (exact) return exact
      const bound = scope.bindings.get(target)
      if (!bound) continue
      if (bound !== target) {
        target = bound
        rebound = true
      }
      break
    }
    if (!rebound) return
  }
}

function integerIndex(node: Node | null): number | undefined {
  node = unwrapParenthesized(node)
  if (!node) return
  if (node.type === "integer") return Number(node.text)
  if (node.type !== "unary_operator") return
  if (node.text.startsWith("-") && /^-\d+$/.test(node.text)) return Number(node.text)
}

function applyGuardCondition(current: ValueScope, values: string[], guard: Node): string[] | undefined {
  guard = unwrapParenthesized(guard) ?? guard
  if (guard.type === "boolean_operator") {
    if (!guard.text.includes(" and ")) return values
    let narrowed = values
    for (const child of guard.namedChildren) {
      const next = applyGuardCondition(current, narrowed, child)
      if (next) narrowed = next
    }
    return narrowed
  }

  if (guard.type !== "call") return values
  const fn = guard.childForFieldName("function")
  if (fn?.type !== "attribute") return values
  const method = fn.childForFieldName("attribute")?.text
  const receiver = unwrapParenthesized(fn.childForFieldName("object"))
  const argNodes = guard.childForFieldName("arguments")?.namedChildren ?? []
  if (receiver?.type !== "identifier" || method !== "startswith" || argNodes.length !== 1) return values
  const prefixes = exactStringSet(current, argNodes[0])
  if (!prefixes || prefixes.length !== 1) return values
  return uniqueStrings(values.filter((item) => item.startsWith(prefixes[0]!)))
}

function applyGuards(current: ValueScope, name: string, values: string[], guards: Guards): string[] | undefined {
  let narrowed = values
  for (const guard of guards) {
    if (!guard.text.includes(name)) continue
    const next = applyGuardCondition(current, narrowed, guard)
    if (next === undefined) continue
    narrowed = next
    if (narrowed.length === 0) return
  }
  return uniqueStrings(narrowed)
}

function stringSetFromNode(current: ValueScope, node: Node | null, guards: Guards = []): string[] | undefined {
  node = unwrapParenthesized(node)
  if (!node) return

  const direct = value(node)
  if (!direct.dynamic && direct.literal !== undefined) return [direct.literal]

  if (node.type === "identifier") {
    const exact = exactStringSetInstance(current, node.text)
    return exact ? applyGuards(current, node.text, exact, guards) : undefined
  }

  if (node.type === "call") {
    const fn = node.childForFieldName("function")
    if (fn?.type !== "attribute") return
    const method = fn.childForFieldName("attribute")?.text
    const receiver = fn.childForFieldName("object")
    const receiverValues = stringSetFromNode(current, receiver, guards)
    if (!receiverValues) return
    const argsNode = node.childForFieldName("arguments")
    const argValues = argsNode?.namedChildren ?? []
    if ((method === "strip" || method === "lstrip" || method === "rstrip") && argValues.length === 0) {
      const mapped = receiverValues.map((item) => (method === "strip" ? item.trim() : method === "lstrip" ? item.trimStart() : item.trimEnd()))
      return uniqueStrings(mapped)
    }
  }

  if (node.type === "subscript") {
    const items = sequenceItemsFromNode(current, node.childForFieldName("value"), guards)
    const base = node.childForFieldName("value")
    const subscript = base ? node.namedChildren.find((child) => child.startIndex > base.endIndex) : undefined
    const index = integerIndex(subscript ?? null)
    if (!items || index === undefined) return
    const picked = items.map((sequence) => {
      const normalizedIndex = index < 0 ? sequence.length + index : index
      return sequence[normalizedIndex]
    })
    if (picked.some((item) => item === undefined)) return
    return uniqueStrings(picked as string[])
  }
}

function splitSequence(input: string, separator: string | undefined, maxsplit: number | undefined, fromRight: boolean) {
  if (separator === undefined) {
    const trimmed = input.trim()
    if (!trimmed) return [] as string[]
    const pieces = trimmed.split(/\s+/)
    if (maxsplit === undefined) return pieces
    if (fromRight) {
      if (maxsplit <= 0 || pieces.length <= maxsplit + 1) return pieces
      return [pieces.slice(0, pieces.length - maxsplit).join(" "), ...pieces.slice(pieces.length - maxsplit)]
    }
    if (maxsplit <= 0 || pieces.length <= maxsplit + 1) return pieces
    return [...pieces.slice(0, maxsplit), pieces.slice(maxsplit).join(" ")]
  }

  if (separator === "") return
  if (maxsplit === undefined || maxsplit < 0) return fromRight ? input.split(separator).reverse().reverse() : input.split(separator)
  if (!fromRight) {
    return input.split(separator, maxsplit + 1)
  }
  const pieces = input.split(separator)
  if (pieces.length <= maxsplit + 1) return pieces
  return [pieces.slice(0, pieces.length - maxsplit).join(separator), ...pieces.slice(pieces.length - maxsplit)]
}

function sequenceItemsFromCall(current: ValueScope, node: Node, guards: Guards = []): string[][] | undefined {
  const fn = node.childForFieldName("function")
  if (fn?.type !== "attribute") return
  const method = fn.childForFieldName("attribute")?.text
  const receiver = fn.childForFieldName("object")
  const receiverValues = stringSetFromNode(current, receiver, guards)
  if (!receiverValues) return
  const argsNode = node.childForFieldName("arguments")
  const argValues = argsNode?.namedChildren ?? []

  if (method === "splitlines") {
    if (argValues.length !== 0) return
    const sequences = receiverValues.map((item) => item.split(/\r?\n/))
    if (sequences.some((items) => items.length > MAX_EXACT_STRINGS)) return
    if (sequences.length > MAX_EXACT_STRINGS) return
    return sequences
  }

  if (method !== "split" && method !== "rsplit") return
    const separator = argValues.length >= 1 ? stringSetFromNode(current, argValues[0], guards) : [undefined as unknown as string]
    if (!separator || separator.length > 1) return
  const maxsplit = argValues.length >= 2 ? integerIndex(argValues[1]) : undefined
  if (argValues.length > 2 || (argValues.length >= 2 && maxsplit === undefined)) return
  const sequences = receiverValues
    .map((item) => splitSequence(item, separator[0], maxsplit, method === "rsplit"))
    .filter((items): items is string[] => Boolean(items))
  if (sequences.length !== receiverValues.length) return
  if (sequences.some((items) => items.length > MAX_EXACT_STRINGS) || sequences.length > MAX_EXACT_STRINGS) return
  return sequences
}

function sequenceItemsFromNode(current: ValueScope, node: Node | null, guards: Guards = []): string[][] | undefined {
  node = unwrapParenthesized(node)
  if (!node) return

  if (node.type === "list" || node.type === "tuple") {
    const items = node.namedChildren.map((child) => stringSetFromNode(current, child, guards))
    if (items.some((item) => !item || item.length !== 1)) return
    return [items.map((item) => item![0])]
  }

  if (node.type === "identifier") {
    const exact = exactIteratedStringSetInstance(current, node.text)
    if (!exact) return
    const narrowed = applyGuards(current, node.text, exact, guards)
    return narrowed ? [narrowed] : undefined
  }

  if (node.type === "call") return sequenceItemsFromCall(current, node, guards)
}

export function exactIteratedStringSet(current: ValueScope, node: Node | null, guards: Guards = []): string[] | undefined {
  const sequences = sequenceItemsFromNode(current, node, guards)
  if (!sequences) return
  return uniqueStrings(sequences.flat())
}

export function exactStringSet(current: ValueScope, node: Node | null, guards: Guards = []): string[] | undefined {
  return stringSetFromNode(current, node, guards)
}

export function exactNodeValue(current: ValueScope, node: Node | null, guards: Guards = []): Value | undefined {
  const exact = exactStringSet(current, node, guards)
  if (!exact || exact.length !== 1) return
  return { dynamic: false, literal: exact[0] }
}

export function equivalentSubscriptValuePaths(current: ValueScope, node: Node | null, guards: Guards = []): string[] | undefined {
  node = unwrapParenthesized(node)
  if (!node || node.type !== "subscript") return
  const base = unwrapParenthesized(node.childForFieldName("value"))
  if (!base || base.type !== "identifier") return
  const subscript = node.namedChildren.find((child) => child.startIndex > base.endIndex)
  if (!subscript || subscript.type === "slice" || subscript.text.includes(":")) return
  const exact = exactStringSet(current, subscript, guards)
  if (!exact) return
  return exact.map((item) => `${base.text}[=${JSON.stringify(item)}]`)
}

export function equivalentSubscriptValuePath(current: ValueScope, node: Node | null, guards: Guards = []): string | undefined {
  const paths = equivalentSubscriptValuePaths(current, node, guards)
  if (!paths || paths.length !== 1) return
  return paths[0]
}
