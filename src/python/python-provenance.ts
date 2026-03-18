import type { PythonValue as Value } from "./python-values"

type NodeLike = {
  type: string
  text: string
  startIndex: number
  endIndex: number
  namedChildren: NodeLike[]
  childForFieldName(name: string): NodeLike | null
}

export type ContainerKind =
  | "list"
  | "dict"
  | "set"
  | "json"
  | "datetime-date"
  | "datetime-datetime"
  | "datetime-time"
  | "datetime-timedelta"
  | "datetime-timezone"
  | "string"
  | "tuple"
  | "range"
  | "bytes"
  | "bytearray"
  | "memoryview"
  | "int"
  | "float"
  | "complex"
  | "match"
  | "inspect-signature"
  | "inspect-parameter"
  | "inspect-bound-arguments"
  | "mock"
  | "async-mock"

export type ReceiverContainer = {
  kind: ContainerKind
  deps: string[]
}

export type ReceiverPath = {
  path: Value
  deps: string[]
}

export type AttributePath = {
  path: string
  root: string
}

export type ReceiverInfo = {
  path: string
  deps: string[]
}

export type ProvenanceScope = {
  parent?: ProvenanceScope
  bindings: Map<string, string>
  containerInstances: Map<string, ContainerKind>
  receiverContainers: Map<string, ReceiverContainer>
  receiverPaths: Map<string, ReceiverPath>
}

export function uniqueDependencyKeys(values: string[]) {
  return Array.from(new Set(values))
}

export function trackableSelfAttributePath(node: NodeLike | null) {
  if (!node || node.type !== "attribute") return
  const object = node.childForFieldName("object")
  const attribute = node.childForFieldName("attribute")?.text
  if (!object || object.type !== "identifier" || object.text !== "self" || !attribute) return
  return `self.${attribute}`
}

export function oneHopAttributePath(node: NodeLike | null): AttributePath | undefined {
  if (!node || node.type !== "attribute") return
  const object = node.childForFieldName("object")
  const attribute = node.childForFieldName("attribute")?.text
  if (!object || object.type !== "identifier" || !attribute) return
  return { path: `${object.text}.${attribute}`, root: object.text }
}

export function trackableReceiverDeps(node: NodeLike | null): string[] | undefined {
  if (!node) return []
  if (node.type === "identifier") return [node.text]
  if (node.type === "string" || node.type === "integer" || node.type === "float" || node.type === "true" || node.type === "false" || node.type === "none") {
    return []
  }

  const attribute = oneHopAttributePath(node)
  if (attribute) return uniqueDependencyKeys([attribute.root, attribute.path])

  if (node.type === "tuple" || node.type === "list") {
    const deps: string[] = []
    for (const child of node.namedChildren) {
      const childDeps = trackableReceiverDeps(child)
      if (!childDeps) return
      deps.push(...childDeps)
    }
    return uniqueDependencyKeys(deps)
  }
}

export function trackableReceiverInfo(node: NodeLike | null): ReceiverInfo | undefined {
  if (!node) return

  const oneHop = oneHopAttributePath(node)
  if (oneHop) {
    if (oneHop.root === "self") return
    return { path: oneHop.path, deps: [oneHop.root] }
  }

  if (node.type === "attribute") {
    const object = oneHopAttributePath(node.childForFieldName("object"))
    const attribute = node.childForFieldName("attribute")?.text
    if (!object || !attribute) return
    return { path: `${object.path}.${attribute}`, deps: uniqueDependencyKeys([object.root, object.path]) }
  }

  if (node.type !== "subscript") return
  const value = node.childForFieldName("value")
  if (!value || value.type !== "identifier") return
  const subscript = node.namedChildren.find((child) => child.startIndex > value.endIndex)
  if (!subscript) return
  const deps = trackableReceiverDeps(subscript)
  if (!deps) return
  return { path: node.text, deps: uniqueDependencyKeys([value.text, ...deps]) }
}

export function trackableInvalidationDeps(node: NodeLike | null, assignedNames: (node: any) => string[]) {
  const deps = assignedNames(node)
  const attribute = oneHopAttributePath(node)
  if (attribute) deps.push(attribute.path)
  return uniqueDependencyKeys(deps)
}

export function clearReceiverDeps(current: Pick<ProvenanceScope, "receiverContainers" | "receiverPaths">, deps: string[]) {
  if (deps.length === 0) return
  const target = new Set(deps)
  for (const [key, tracked] of current.receiverContainers) {
    if (tracked.deps.some((dep) => target.has(dep))) current.receiverContainers.delete(key)
  }
  for (const [key, tracked] of current.receiverPaths) {
    if (tracked.deps.some((dep) => target.has(dep))) current.receiverPaths.delete(key)
  }
}

export function clearTrackedProvenanceForName(
  current: Pick<ProvenanceScope, "containerInstances" | "receiverContainers" | "receiverPaths">,
  name: string,
) {
  current.containerInstances.delete(name)
  for (const key of current.containerInstances.keys()) {
    if (key.startsWith(`${name}.`)) current.containerInstances.delete(key)
  }
  for (const [key, tracked] of current.receiverContainers) {
    if (tracked.deps.includes(name)) current.receiverContainers.delete(key)
  }
  for (const [key, tracked] of current.receiverPaths) {
    if (tracked.deps.includes(name)) current.receiverPaths.delete(key)
  }
}

export function receiverContainerInstance(current: Pick<ProvenanceScope, "receiverContainers">, path: string) {
  return current.receiverContainers.get(path)?.kind
}

export function receiverPathInstance(current: Pick<ProvenanceScope, "receiverPaths">, path: string) {
  return current.receiverPaths.get(path)?.path
}

export function lookupTrackedReceiverContainerKind(current: ProvenanceScope, node: NodeLike | null): ContainerKind | undefined {
  if (!node) return

  const trackedReceiver = trackableReceiverInfo(node)
  const trackedReceiverContainer = trackedReceiver ? receiverContainerInstance(current, trackedReceiver.path) : undefined
  if (trackedReceiverContainer) return trackedReceiverContainer

  const localContainerName = trackableSelfAttributePath(node) ?? (node.type === "identifier" ? node.text : undefined)
  if (!localContainerName) return

  if (localContainerName.startsWith("self.")) {
    return current.containerInstances.get(localContainerName)
  }

  const root = localContainerName.split(".")[0]
  for (let scope: ProvenanceScope | undefined = current; scope; scope = scope.parent) {
    const kind = scope.containerInstances.get(localContainerName)
    if (kind) return kind
    if (root && scope.bindings.has(root)) return
  }
}

export function lookupTrackedReceiverPathValue(current: ProvenanceScope, node: NodeLike | null): Value | undefined {
  if (!node) return

  const selfAttributePath = trackableSelfAttributePath(node)
  if (selfAttributePath) return receiverPathInstance(current, selfAttributePath)

  const trackedReceiver = trackableReceiverInfo(node)
  if (!trackedReceiver) return
  return receiverPathInstance(current, trackedReceiver.path)
}

export function applyAssignmentProvenance(
  current: Pick<ProvenanceScope, "containerInstances" | "receiverContainers" | "receiverPaths">,
  left: NodeLike | null,
  localContainer: ContainerKind | undefined,
  localPath: Value | undefined,
) {
  const selfAttributePath = trackableSelfAttributePath(left)
  if (selfAttributePath) {
    current.containerInstances.delete(selfAttributePath)
    current.receiverPaths.delete(selfAttributePath)
    if (localContainer) current.containerInstances.set(selfAttributePath, localContainer)
    if (localPath) current.receiverPaths.set(selfAttributePath, { path: localPath, deps: ["self"] })
    return true
  }

  const receiverInfo = trackableReceiverInfo(left)
  if (receiverInfo) {
    current.receiverContainers.delete(receiverInfo.path)
    current.receiverPaths.delete(receiverInfo.path)
    if (localContainer) current.receiverContainers.set(receiverInfo.path, { kind: localContainer, deps: receiverInfo.deps })
    if (localPath) current.receiverPaths.set(receiverInfo.path, { path: localPath, deps: receiverInfo.deps })
    return true
  }

  return false
}
