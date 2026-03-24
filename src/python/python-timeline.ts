import type { PythonAstNode as Node } from "./frontend/interface"
import { ASSIGNMENT_CONTAINER_TYPES, BODY_SCOPE_TYPES, COMPREHENSION_SCOPE_TYPES } from "./python-known-methods"
import type { Scope, TimelineEntry } from "./python-analyze-types"
import type { PythonValue as Value } from "./python-values"

type TimelineDeps = {
  scope(parent?: Scope): Scope
  invalidateTrackedName(current: Scope, name: string): void
}

export function parameterNames(node: Node | null): string[] {
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
  guards: Node[] = [],
  startIndex = node.startIndex,
  endIndex = node.endIndex,
) {
  entries.push({ kind, node, scope, guards: guards.length > 0 ? [...guards] : undefined, startIndex, endIndex })
}

function collectTimeline(node: Node, current: Scope, entries: TimelineEntry[], deps: TimelineDeps, decorated = false, guards: Node[] = []) {
  if (node.type === "assignment" || node.type === "augmented_assignment" || node.type === "named_expression") {
    const right = assignmentRight(node)
    const assignmentStart = right?.type === "lambda" ? right.startIndex : right?.endIndex ?? node.startIndex
    pushEntry(entries, "assignment", node, current, guards, assignmentStart, node.endIndex)
  } else if (node.type === "call") {
    pushEntry(entries, "call", node, current, guards)
  } else if (node.type === "raise_statement") {
    pushEntry(entries, "raise", node, current, guards)
  } else if ((node.type === "function_definition" || node.type === "class_definition") && !decorated) {
    pushEntry(entries, "definition", node, current, guards)
  } else if (node.type === "import_statement" || node.type === "import_from_statement") {
    pushEntry(entries, "import", node, current, guards)
  } else if (node.type === "for_statement" || node.type === "async_for_statement") {
    const right = node.childForFieldName("right")
    const body = node.childForFieldName("body")
    pushEntry(entries, "rebind", node, current, guards, right?.endIndex ?? node.startIndex, body?.startIndex ?? node.endIndex)
  } else if (node.type === "for_in_clause") {
    const right = node.childForFieldName("right")
    pushEntry(entries, "rebind", node, current, guards, right?.endIndex ?? node.startIndex, node.endIndex)
  } else if (node.type === "with_item") {
    pushEntry(entries, "rebind", node, current, guards, node.endIndex, node.endIndex)
  } else if (node.type === "except_clause") {
    const value = node.childForFieldName("value")
    const body = node.namedChildren[node.namedChildren.length - 1]
    pushEntry(entries, "rebind", node, current, guards, value?.endIndex ?? node.endIndex, body?.startIndex ?? node.endIndex)
  }

  if (node.type === "decorated_definition") {
    const inner = definitionNode(node)
    if (inner) pushEntry(entries, "definition", node, current, guards, inner.startIndex, inner.endIndex)
    for (const child of node.namedChildren) collectTimeline(child, current, entries, deps, true, guards)
    return
  }

  if (node.type === "if_statement" || node.type === "elif_clause") {
    const condition = node.childForFieldName("condition")
    const consequence = node.childForFieldName("consequence")
    const alternative = node.childForFieldName("alternative")
    for (const child of node.namedChildren) {
      if (condition && child.startIndex === condition.startIndex && child.endIndex === condition.endIndex) {
        collectTimeline(child, current, entries, deps, decorated, guards)
        continue
      }
      if (consequence && child.startIndex === consequence.startIndex && child.endIndex === consequence.endIndex) {
        collectTimeline(child, current, entries, deps, decorated, condition ? [...guards, condition] : guards)
        continue
      }
      if (alternative && child.startIndex === alternative.startIndex && child.endIndex === alternative.endIndex) {
        collectTimeline(child, current, entries, deps, decorated, guards)
        continue
      }
      collectTimeline(child, current, entries, deps, decorated, guards)
    }
    return
  }

  if (node.type === "else_clause") {
    const body = node.childForFieldName("body")
    for (const child of node.namedChildren) {
      collectTimeline(child, current, entries, deps, decorated, guards)
      if (body && child.startIndex === body.startIndex && child.endIndex === body.endIndex) continue
    }
    return
  }

  if (BODY_SCOPE_TYPES.has(node.type)) {
    const body = node.childForFieldName("body")
    const inner = deps.scope(current)
    if ((node.type === "function_definition" || node.type === "class_definition") && !decorated) {
      const last = entries[entries.length - 1]
      if (last?.kind === "definition" && last.node === node) last.bodyScope = inner
    }
    if (node.type === "lambda") {
      const last = entries[entries.length - 1]
      const assigned = last?.kind === "assignment" ? assignmentRight(last.node) : undefined
      if (last?.kind === "assignment" && assigned?.startIndex === node.startIndex && assigned?.endIndex === node.endIndex) {
        last.bodyScope = inner
      }
    }
    if (node.type === "function_definition" || node.type === "lambda") {
      for (const name of parameterNames(node.childForFieldName("parameters"))) deps.invalidateTrackedName(inner, name)
    }
    for (const child of node.namedChildren) {
      const inBody =
        !!body && child.type === body.type && child.startIndex === body.startIndex && child.endIndex === body.endIndex
      collectTimeline(child, inBody ? inner : current, entries, deps, decorated, guards)
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
        if (right) collectTimeline(right, inner, entries, deps, decorated, guards)
        const rebindIndex = body?.startIndex ?? right?.endIndex ?? child.startIndex
        pushEntry(entries, "rebind", child, inner, guards, rebindIndex, rebindIndex)
        for (const name of assignedNames(child.childForFieldName("left"))) deps.invalidateTrackedName(inner, name)
        continue
      }
      collectTimeline(child, inner, entries, deps, decorated, guards)
    }

    if (body) collectTimeline(body, inner, entries, deps, decorated, guards)
    return
  }

  for (const child of node.namedChildren) collectTimeline(child, current, entries, deps, decorated, guards)
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
