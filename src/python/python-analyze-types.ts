import type { PythonAstNode as Node } from "./frontend/interface"
import type { PythonEventEvidence } from "./python-ir"
import type { ContainerKind, ReceiverContainer } from "./python-provenance"
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
  localDefinitions: Set<string>
  callableFactories: Map<string, Node>
  containerInstances: Map<string, ContainerKind>
  iteratedElementInstances: Map<string, ContainerKind>
  iteratedPathInstances: Map<string, Value>
  receiverContainers: Map<string, ReceiverContainer>
  pathInstances: Map<string, Value>
  httpClientInstances: Map<string, string>
  httpResponseInstances: Set<string>
  ghapiInstances: Set<string>
  atlassianInstances: Map<string, AtlassianClientFamily>
}

export type TimelineEntry = {
  kind: "assignment" | "call" | "definition" | "import" | "raise" | "rebind"
  node: Node
  scope: Scope
  startIndex: number
  endIndex: number
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
