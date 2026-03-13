import type { PythonAstNode as Node } from "./frontend/interface"
import { ASSIGNMENT_CONTAINER_TYPES, BODY_SCOPE_TYPES, COMPREHENSION_SCOPE_TYPES } from "./python-known-methods"
import type { Scope, TimelineEntry } from "./python-analyze-types"
import type { PythonValue as Value } from "./python-values"

type TimelineDeps = {
  scope(parent?: Scope): Scope
  invalidateTrackedName(current: Scope, name: string): void
}

function parameterNames(node: Node | null): string[] {
  if (!node) return []
  const name = node.childForFieldName("name")
  if (name?.type === "identifier") return [name.text]
  if (node.type === "identifier") return [node.text]
  return node.namedChildren.flatMap((child) => parameterNames(child))
}

export function assignmentLeft(node: Node) {
  return node.childForFieldName("left") ?? node.childForFieldName("name")
}

export function assignmentRight(node: Node) {
  return node.childForFieldName("right") ?? node.childForFieldName("value")
}

export function assignedNames(node: Node | null): string[] {
  if (!node) return []
  if (node.type === "identifier") return [node.text]
  if (node.type === "as_pattern_target") return node.namedChildren.flatMap((child) => assignedNames(child))
  if (ASSIGNMENT_CONTAINER_TYPES.has(node.type) || node.type.endsWith("_pattern")) {
    return node.namedChildren.flatMap((child) => assignedNames(child))
  }
  return []
}

export function rebindTarget(node: Node) {
  if (node.type === "for_statement" || node.type === "async_for_statement" || node.type === "for_in_clause") {
    return node.childForFieldName("left")
  }

  if (node.type === "with_item" || node.type === "except_clause") {
    const value = node.childForFieldName("value")
    if (!value || value.type !== "as_pattern") return
    return value.childForFieldName("alias")
  }
}

export function definitionNode(node: Node) {
  if (node.type === "function_definition" || node.type === "class_definition") return node
  if (node.type !== "decorated_definition") return
  return node.namedChildren.find((child) => child.type === "function_definition" || child.type === "class_definition")
}

export function definitionName(node: Node) {
  return definitionNode(node)?.childForFieldName("name")?.text
}

function pushEntry(
  entries: TimelineEntry[],
  kind: TimelineEntry["kind"],
  node: Node,
  scope: Scope,
  startIndex = node.startIndex,
  endIndex = node.endIndex,
) {
  entries.push({ kind, node, scope, startIndex, endIndex })
}

function collectTimeline(node: Node, current: Scope, entries: TimelineEntry[], deps: TimelineDeps, decorated = false) {
  if (node.type === "assignment" || node.type === "augmented_assignment" || node.type === "named_expression") {
    const right = assignmentRight(node)
    pushEntry(entries, "assignment", node, current, right?.endIndex ?? node.startIndex, node.endIndex)
  } else if (node.type === "call") {
    pushEntry(entries, "call", node, current)
  } else if (node.type === "raise_statement") {
    pushEntry(entries, "raise", node, current)
  } else if ((node.type === "function_definition" || node.type === "class_definition") && !decorated) {
    pushEntry(entries, "definition", node, current)
  } else if (node.type === "import_statement" || node.type === "import_from_statement") {
    pushEntry(entries, "import", node, current)
  } else if (node.type === "for_statement" || node.type === "async_for_statement") {
    const right = node.childForFieldName("right")
    const body = node.childForFieldName("body")
    pushEntry(entries, "rebind", node, current, right?.endIndex ?? node.startIndex, body?.startIndex ?? node.endIndex)
  } else if (node.type === "for_in_clause") {
    const right = node.childForFieldName("right")
    pushEntry(entries, "rebind", node, current, right?.endIndex ?? node.startIndex, node.endIndex)
  } else if (node.type === "with_item") {
    pushEntry(entries, "rebind", node, current, node.endIndex, node.endIndex)
  } else if (node.type === "except_clause") {
    const value = node.childForFieldName("value")
    const body = node.namedChildren[node.namedChildren.length - 1]
    pushEntry(entries, "rebind", node, current, value?.endIndex ?? node.endIndex, body?.startIndex ?? node.endIndex)
  }

  if (node.type === "decorated_definition") {
    const inner = definitionNode(node)
    if (inner) pushEntry(entries, "definition", node, current, inner.startIndex, inner.endIndex)
    for (const child of node.namedChildren) collectTimeline(child, current, entries, deps, true)
    return
  }

  if (BODY_SCOPE_TYPES.has(node.type)) {
    const body = node.childForFieldName("body")
    const inner = deps.scope(current)
    if (node.type === "function_definition" || node.type === "lambda") {
      for (const name of parameterNames(node.childForFieldName("parameters"))) deps.invalidateTrackedName(inner, name)
    }
    for (const child of node.namedChildren) {
      const inBody =
        !!body && child.type === body.type && child.startIndex === body.startIndex && child.endIndex === body.endIndex
      collectTimeline(child, inBody ? inner : current, entries, deps, decorated)
    }
    return
  }

  if (COMPREHENSION_SCOPE_TYPES.has(node.type)) {
    const inner = deps.scope(current)
    const body = node.childForFieldName("body")
    const isBody = (child: Node) =>
      !!body && child.type === body.type && child.startIndex === body.startIndex && child.endIndex === body.endIndex

    for (const child of node.namedChildren) {
      if (isBody(child)) continue
      if (child.type === "for_in_clause") {
        const right = child.childForFieldName("right")
        if (right) collectTimeline(right, inner, entries, deps, decorated)
        const rebindIndex = body?.startIndex ?? right?.endIndex ?? child.startIndex
        pushEntry(entries, "rebind", child, inner, rebindIndex, rebindIndex)
        for (const name of assignedNames(child.childForFieldName("left"))) deps.invalidateTrackedName(inner, name)
        continue
      }
      collectTimeline(child, inner, entries, deps, decorated)
    }

    if (body) collectTimeline(body, inner, entries, deps, decorated)
    return
  }

  for (const child of node.namedChildren) collectTimeline(child, current, entries, deps, decorated)
}

export function buildTimeline(root: Node, rootScope: Scope, deps: TimelineDeps) {
  const entries: TimelineEntry[] = []
  collectTimeline(root, rootScope, entries, deps)
  entries.sort((a, b) => {
    if (a.startIndex === b.startIndex) return a.endIndex - b.endIndex
    return a.startIndex - b.startIndex
  })
  return entries
}

export function pathFromPathMethod(
  node: Node | null,
  current: Scope,
  trackPathValue: (node: Node | null, current: Scope) => Value | undefined,
): Value | undefined {
  if (!node || node.type !== "attribute") return
  const object = node.childForFieldName("object")
  return trackPathValue(object, current)
}

export function canonicalPathMethodCall(method: string) {
  return `pathlib.Path.${method}`
}
