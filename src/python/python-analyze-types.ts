import type { PythonAstNode as Node } from "./frontend/interface"
import type { PythonEventEvidence } from "./python-ir"
import type { ContainerKind, ReceiverContainer, ReceiverPath } from "./python-provenance"
import type { GuardedCallRule, GuardedMethodRule } from "./python-rule-schema"
import type { PythonValue as Value } from "./python-values"

export type PythonEventKind = "read" | "write" | "emit" | "exec" | "pure" | "unknown"

export type PythonEvent = {
  kind: PythonEventKind
  call: string
  sourceCall?: string
  path?: string
  dynamicPath?: boolean
  evidence?: PythonEventEvidence
}

export type PathSpec = {
  index: number
  names: string[]
}

export type AtlassianClientFamily = "jira" | "confluence" | "bitbucket" | "servicedesk"

export type AtlassianCtor = {
  family?: AtlassianClientFamily
  variants: string[]
}

export type Scope = {
  parent?: Scope
  bindings: Map<string, string>
  directImportTargets: Map<string, string>
  trustedDirectBindings: Set<string>
  trustedBindings: Set<string>
  trustedModuleBindings: Set<string>
  trustedModuleRoots: Set<string>
  localDefinitions: Set<string>
  callableFactories: Map<string, Node>
  callableFactoryContainers: Map<string, ContainerKind>
  callableFactoryTupleContainers: Map<string, ContainerKind[]>
  containerInstances: Map<string, ContainerKind>
  valueInstances: Map<string, Value>
  exactStringSets: Map<string, string[]>
  exactIteratedStringSets: Map<string, string[]>
  iteratedExactStringTupleInstances: Map<string, string[][]>
  iteratedElementInstances: Map<string, ContainerKind>
  iteratedContainerTupleInstances: Map<string, ContainerKind[]>
  iteratedPathInstances: Map<string, Value>
  iteratedPathTupleInstances: Map<string, Value[]>
  seedablePathLists: Set<string>
  tupleContainerSlotInstances: Map<string, ContainerKind[]>
  seedableTupleLists: Map<string, string[]>
  receiverContainers: Map<string, ReceiverContainer>
  receiverElementKinds: Map<string, ReceiverContainer>
  receiverSeedableStringLists: Map<string, string[]>
  receiverPaths: Map<string, ReceiverPath>
  pathInstances: Map<string, Value>
  boundSetitemReceivers: Map<string, { path?: string; canonicalPath?: string; equivalentPaths?: string[] }>
  sqliteConnectionInstances: Map<string, string>
  sqliteCursorInstances: Map<string, string>
  sqliteExecutedCursorInstances: Set<string>
  sqliteClosedCursorInstances: Set<string>
  trustedModelDumpInstances: Set<string>
  ociPolicyIterableInstances: Set<string>
  ociIdentityClientInstances: Set<string>
  httpClientInstances: Map<string, string>
  httpResponseInstances: Set<string>
  ghapiInstances: Set<string>
  atlassianInstances: Map<string, AtlassianClientFamily>
}

export type TimelineEntry = {
  kind: "assignment" | "call" | "definition" | "import" | "raise" | "rebind"
  node: Node
  scope: Scope
  bodyScope?: Scope
  guards?: TimelineGuard[]
  startIndex: number
  endIndex: number
}

export type TimelineGuard = {
  node: Node
  startswithSnapshots?: Map<string, { receiverName: string; prefixes: string[]; receiverValues?: string[] }>
}

export type Rules = {
  methods: {
    read: Set<string>
    write: Set<string>
    emit: Set<string>
    pure: Set<string>
  }
  calls: {
    read: Set<string>
    write: Set<string>
    emit: Set<string>
    exec: Set<string>
    pure: Set<string>
    networkRead: Set<string>
    networkWrite: Set<string>
    networkExec: Set<string>
    dbExec: Set<string>
    tempfileWrite: Set<string>
    dangerousDeserializeExec: Set<string>
  }
  pathCalls: {
    read: Record<string, PathSpec>
    write: Record<string, PathSpec>
  }
  sdk: {
    oci: {
      execCalls: Set<string>
      clientMethodPrefixes: string[]
    }
    ghapi: {
      execCalls: Set<string>
      writeCalls: Set<string>
      instanceConstructors: Set<string>
    }
    atlassian: {
      constructorMetadata: Map<string, { family?: AtlassianClientFamily; bare: boolean }>
      clientMethods: Record<AtlassianClientFamily, Set<string>>
    }
  }
  guarded: {
    methods: GuardedMethodRule[]
    calls: GuardedCallRule[]
  }
}
