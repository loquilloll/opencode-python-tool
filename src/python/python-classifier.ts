import type { PythonAstNode as Node } from "./frontend/interface"
import { effect, pathEffect } from "./python-events"
import { evaluateGuardsDetailed } from "./python-guard-eval"
import {
  args,
  classifyBuiltinPureCall,
  classifyBuiltinPureFallbackCall,
  classifyResponseJson,
  directTemporaryContainerKind,
  hasDictionarySplat,
  pick,
  pureContainerMethod,
  trackedPathValue,
  trackedReceiverContainerKind,
} from "./python-inference"
import {
  CALLABLE_UNKNOWN_PREFIX,
  GENERIC_HTTP_REQUEST_SUFFIXES,
  HTTP_REQUEST_CALL_BASES,
  HTTP_REQUEST_METHOD_SUFFIXES,
  PATH_PURE_METHODS,
  SHADOW_GUARDED_EMIT_BUILTINS,
  SHADOW_GUARDED_EXEC_BUILTINS,
  SHADOW_GUARDED_READ_BUILTINS,
  STANDARD_EXCEPTION_BUILTINS,
  TRACKED_HTTP_REQUEST_SUFFIXES,
} from "./python-known-methods"
import type { AtlassianClientFamily, Rules, Scope } from "./python-analyze-types"
import type { PythonEventEvidence, ReceiverKind, ResolvedEffect } from "./python-ir"
import { type ContainerKind, trackableReceiverInfo, trackableSelfAttributePath } from "./python-provenance"
import { atlassianInstance, containerInstance, hasBoundName, hasGhapiInstance, hasHttpResponseInstance, httpClientInstance, resolvedName, trustedCallWithPolicy } from "./python-scope"
import { canonicalPathMethodCall, pathFromPathMethod } from "./python-timeline"
import type { GuardedCallRule, GuardedMethodRule } from "./python-rule-schema"
import type { PythonArgs as Args, PythonValue as Value } from "./python-values"

function tail(input: string) {
  const parts = input.split(".")
  return parts[parts.length - 1] ?? ""
}

function builtinEffectTarget(call: string) {
  if (SHADOW_GUARDED_READ_BUILTINS.has(call)) return call
  if (SHADOW_GUARDED_EMIT_BUILTINS.has(call)) return call
  if (SHADOW_GUARDED_EXEC_BUILTINS.has(call)) return call
  if (call === "open") return call
  if (call === "compile" || call === "eval" || call === "exec" || call === "__import__") return call
  if (call === "print") return call
  if (call === "type") return call
}

function classifyBuiltinEffectCall(call: string, node: Node, input: Args, current: Scope): ResolvedEffect | undefined {
  const target = builtinEffectTarget(call)
  if (!target) return
  if (hasBoundName(current, target)) {
    return effect("unknown", { resolvedCall: call, outwardCall: `${CALLABLE_UNKNOWN_PREFIX}${call}` })
  }

  if (call === "open") return classifyOpen(input)
  if (call === "input") return effect("fs.read", { resolvedCall: call })
  if (call === "help" || call === "print") return effect("emit.signal", { resolvedCall: call })
  if (call === "breakpoint" || call === "compile" || call === "eval" || call === "exec" || call === "__import__") {
    return effect("dynamic.exec", { resolvedCall: call })
  }
  if (call === "type") {
    if (input.positional.length === 1 && Object.keys(input.keyword).length === 0 && !hasDictionarySplat(node)) {
      return effect("pure.compute", { resolvedCall: call })
    }
    return effect("unknown", { resolvedCall: call, outwardCall: `${CALLABLE_UNKNOWN_PREFIX}${call}` })
  }
}

function raiseValue(node: Node) {
  return node.childForFieldName("value") ?? node.childForFieldName("exception") ?? node.namedChildren[0] ?? null
}

export function classifyRaise(node: Node, current: Scope): ResolvedEffect | undefined {
  const value = raiseValue(node)
  if (!value) return

  if (value.type === "call") {
    const call = resolvedName(value.childForFieldName("function"), current)
    if (!call || !STANDARD_EXCEPTION_BUILTINS.has(call)) return
    return classifyBuiltinPureCall(call, value, args(value), current)
  }

  const call = resolvedName(value, current)
  if (!call || !STANDARD_EXCEPTION_BUILTINS.has(call)) return
  if (hasBoundName(current, call)) {
    return effect("unknown", { resolvedCall: call, outwardCall: `${CALLABLE_UNKNOWN_PREFIX}${call}` })
  }
  return effect("pure.compute", { resolvedCall: call })
}

function httpRequestMethod(input: Args) {
  const method = pick(input, 0, ["method"])
  if (!method || method.dynamic || method.literal === undefined) return
  return HTTP_REQUEST_METHOD_SUFFIXES.get(method.literal.trim().toUpperCase())
}

function trackedHttpRequestBase(call: string, current: Scope) {
  const parts = call.split(".")
  const instance = parts[0]
  if (!instance || parts[parts.length - 1] !== "request") return
  const trackedHttpClient = httpClientInstance(current, instance)
  if (!trackedHttpClient || !HTTP_REQUEST_CALL_BASES.has(`${trackedHttpClient}.request`)) return
  const suffix = parts.slice(1).join(".")
  if (!TRACKED_HTTP_REQUEST_SUFFIXES.has(suffix)) return
  return trackedHttpClient
}

function hasGenericHttpRequestSuffix(call: string) {
  const parts = call.split(".")
  if (!parts[0]) return false
  return GENERIC_HTTP_REQUEST_SUFFIXES.has(parts.slice(1).join("."))
}

export function isHttpResponseCall(call: string, node: Node, current: Scope, rules: Rules) {
  const input = args(node)
  const guardedRequest = classifyGuardedHttpRequest(call, node, input, current, rules)
  const requestEffect = guardedRequest.effect ?? classifyHttpRequestFallback(call, input)
  if (requestEffect && (requestEffect.atom === "network.read" || requestEffect.atom === "network.write")) {
    return true
  }

  const parts = call.split(".")
  const instance = parts[0]
  const method = tail(call)
  const trackedHttpClient = instance ? httpClientInstance(current, instance) : undefined
  if (trackedHttpClient && parts.length === 2) {
    const canonicalCall = `${trackedHttpClient}.${method}`
    if (rules.calls.networkRead.has(canonicalCall) || rules.calls.networkWrite.has(canonicalCall)) return true
  }

  return rules.calls.networkRead.has(call) || rules.calls.networkWrite.has(call)
}

function classifyHttpRequestFallback(call: string, input: Args): ResolvedEffect | undefined {
  if (!hasGenericHttpRequestSuffix(call)) return
  const method = httpRequestMethod(input)
  if (!method) return
  if (method === "get" || method === "head" || method === "options") {
    return effect("network.read", { resolvedCall: call })
  }
  if (method === "post" || method === "put" || method === "patch" || method === "delete") {
    return effect("network.write", { resolvedCall: call })
  }
}

function classifyGuardedHttpRequest(
  call: string,
  node: Node,
  input: Args,
  current: Scope,
  rules: Rules,
): { effect?: ResolvedEffect; guardFailure?: PythonEventEvidence } {
  const method = httpRequestMethod(input)
  if (!method) return {}
  let firstFailure: PythonEventEvidence | undefined

  const directBase = HTTP_REQUEST_CALL_BASES.get(call) ?? trackedHttpRequestBase(call, current)
  if (directBase) {
    const requestCall = `${directBase}.request`
    for (const rule of rules.guarded.calls) {
      if (rule.call !== requestCall) continue
      const guarded = guardedCallEffect(rule, input, node, current, call, `${directBase}.${method}`)
      if (guarded.effect) return guarded
      firstFailure ??= guarded.guardFailure
    }
  }
  return { guardFailure: firstFailure }
}

function hasLocalDefinition(current: Scope, call: string) {
  const root = call.split(".")[0]
  if (!root) return false

  for (let scope: Scope | undefined = current; scope; scope = scope.parent) {
    if (scope.localDefinitions.has(root)) return true
    if (scope.bindings.has(root)) return false
  }

  return false
}

function localDefinitionEvidence(evidence?: PythonEventEvidence): PythonEventEvidence {
  return evidence ? { ...evidence, localDefinition: true } : { localDefinition: true }
}

function classifyOpen(input: Args): ResolvedEffect {
  const file = pick(input, 0, ["file", "path"])
  return classifyOpenAtPath("open", input, file, undefined, 1)
}

function classifyOpenAtPath(
  resolvedCall: string,
  input: Args,
  file?: Value,
  canonicalCall?: string,
  modeIndex = 1,
): ResolvedEffect {
  const mode = pick(input, modeIndex, ["mode"])
  const context = canonicalCall ? { outwardCall: resolvedCall, canonicalCall } : undefined
  if (!mode) return pathEffect("fs.read", resolvedCall, file, context)
  if (mode.dynamic || mode.literal === undefined) return effect("unknown", { resolvedCall: "open", outwardCall: "open-mode-dynamic" })
  if (/[wax+]/.test(mode.literal)) return pathEffect("fs.write", resolvedCall, file, context)
  return pathEffect("fs.read", resolvedCall, file, context)
}

function receiverEvidence(receiverKind?: ReceiverKind, dependencySignature?: string[], explain: string[] = []): PythonEventEvidence | undefined {
  if (!receiverKind && (!dependencySignature || dependencySignature.length === 0) && explain.length === 0) return
  return {
    receiverKind,
    dependencySignature: dependencySignature && dependencySignature.length ? dependencySignature : undefined,
    explain: explain.length ? explain : undefined,
  }
}

function guardedCallEffect(
  rule: GuardedCallRule,
  input: Args,
  node: Node,
  current: Scope,
  resolvedCall = rule.call,
  canonicalCall?: string,
): { effect?: ResolvedEffect; guardFailure?: PythonEventEvidence } {
  const evaluation = evaluateGuardsDetailed(rule.guards, {
    positionalCount: input.positional.length,
    keywordNames: new Set(Object.keys(input.keyword)),
    hasKwargSplat: hasDictionarySplat(node),
    hasBoundName: (name) => hasBoundName(current, name),
    pickLiteral: (index, names) => pick(input, index, names)?.literal,
    pickKeywordLiteral: (names) => {
      for (const name of names) {
        const literal = input.keyword[name]?.literal
        if (literal !== undefined) return literal
      }
    },
  })
  if (!evaluation.matched) {
    return {
      guardFailure: {
        guardFailure: evaluation.failure,
        explain: [`guarded-call:${rule.call}`],
      },
    }
  }
  return {
    effect: effect(rule.effect, {
      resolvedCall,
      canonicalCall,
      evidence: {
        explain: [`guarded-call:${rule.call}`],
      },
    }),
  }
}

function guardedMethodEffect(
  rule: GuardedMethodRule,
  input: Args,
  node: Node,
  call: string,
  method: string,
  pathMethod: Value | undefined,
  pathSourceCall: string | undefined,
  trackedReceiverKind: ContainerKind | undefined,
  dependencySignature?: string[],
): { effect?: ResolvedEffect; guardFailure?: PythonEventEvidence } {
  const receiverKind = pathMethod ? "path" : trackedReceiverKind === "match" ? "match" : undefined
  const evaluation = evaluateGuardsDetailed(rule.guards, {
    receiverKind,
    positionalCount: input.positional.length,
    keywordNames: new Set(Object.keys(input.keyword)),
    hasKwargSplat: hasDictionarySplat(node),
    pickKeywordLiteral: (names) => {
      for (const name of names) {
        const literal = input.keyword[name]?.literal
        if (literal !== undefined) return literal
      }
    },
  })
  if (!evaluation.matched) {
    return {
      guardFailure: {
        ...receiverEvidence(receiverKind, dependencySignature, [`guarded-method:${rule.method}`]),
        guardFailure: evaluation.failure,
      },
    }
  }

  const evidence = receiverEvidence(receiverKind, dependencySignature, [`guarded-method:${rule.method}`])

  if ((rule.effect === "fs.read" || rule.effect === "fs.write") && pathMethod) {
    return { effect: pathEffect(rule.effect, call, pathMethod, { outwardCall: call, canonicalCall: pathSourceCall, evidence }) }
  }

  return {
    effect: effect(rule.effect, {
      resolvedCall: call,
      outwardCall: pathMethod && pathSourceCall ? call : undefined,
      canonicalCall: pathMethod ? pathSourceCall : undefined,
      evidence,
    }),
  }
}

export function classify(
  node: Node,
  rules: Rules,
  hasAtlassianImportProvenance: boolean,
  current: Scope,
): ResolvedEffect | undefined {
  const fn = node.childForFieldName("function")
  const call = resolvedName(fn, current)
  if (!call) return effect("unknown", { outwardCall: "dynamic-call" })
  if (!trustedCallWithPolicy(fn, call, current)) {
    return effect("unknown", { resolvedCall: call, outwardCall: `${CALLABLE_UNKNOWN_PREFIX}${call}` })
  }

  const input = args(node)
  let guardFailureEvidence: PythonEventEvidence | undefined
  const builtinEffect = classifyBuiltinEffectCall(call, node, input, current)
  if (builtinEffect) return builtinEffect
  for (const guardedCall of rules.guarded.calls) {
    if (guardedCall.call !== call || guardedCall.call.endsWith(".request")) continue
    const guarded = guardedCallEffect(guardedCall, input, node, current)
    if (guarded.effect) return guarded.effect
    guardFailureEvidence ??= guarded.guardFailure
  }
  const responseJsonEffect = classifyResponseJson(call, node, input, current)
  if (responseJsonEffect) return responseJsonEffect
  const guardedRequest = classifyGuardedHttpRequest(call, node, input, current, rules)
  if (guardedRequest.effect) return guardedRequest.effect
  guardFailureEvidence ??= guardedRequest.guardFailure
  const requestEffect = classifyHttpRequestFallback(call, input)
  if (requestEffect) return requestEffect
  const builtinPureEffect = classifyBuiltinPureFallbackCall(call, node, input, current, rules)
  if (builtinPureEffect) return builtinPureEffect

  const method = tail(call)
  const temporaryReceiver = fn?.type === "attribute" ? fn.childForFieldName("object") : null
  const pathMethod = pathFromPathMethod(fn, current, trackedPathValue)
  const pathSourceCall = call.startsWith("Path.") || call.startsWith("pathlib.Path.") ? undefined : canonicalPathMethodCall(method)
  if (pathMethod && method === "open") {
    return classifyOpenAtPath(call, input, pathMethod, pathSourceCall, 0)
  }
  if (pathMethod && PATH_PURE_METHODS.has(method)) {
    return effect("pure.compute", { resolvedCall: call, outwardCall: call, canonicalCall: pathSourceCall })
  }
  if (
    method === "items" &&
    temporaryReceiver?.type === "attribute" &&
    temporaryReceiver.childForFieldName("attribute")?.text === "__dict__" &&
    input.positional.length === 0 &&
    Object.keys(input.keyword).length === 0 &&
    !hasDictionarySplat(node)
  ) {
    return effect("pure.compute", { resolvedCall: call })
  }
  const temporaryContainer = directTemporaryContainerKind(temporaryReceiver, current)
  if (temporaryContainer && pureContainerMethod(temporaryContainer, method)) {
    return effect("pure.compute", { resolvedCall: call })
  }

  const trackedReceiverContainer = trackedReceiverContainerKind(temporaryReceiver, current)
  const trackedReceiverInfo = trackableReceiverInfo(temporaryReceiver)
  const dependencySignature = trackedReceiverInfo
    ? current.receiverContainers.get(trackedReceiverInfo.path)?.deps ?? current.receiverPaths.get(trackedReceiverInfo.path)?.deps
    : undefined
  if (trackedReceiverContainer && pureContainerMethod(trackedReceiverContainer, method)) {
    return effect("pure.compute", { resolvedCall: call })
  }
  for (const guardedMethod of rules.guarded.methods) {
    if (guardedMethod.method !== method) continue
    const guarded = guardedMethodEffect(
      guardedMethod,
      input,
      node,
      call,
      method,
      pathMethod,
      pathSourceCall,
      trackedReceiverContainer,
      dependencySignature,
    )
    if (guarded.effect) return guarded.effect
    guardFailureEvidence ??= guarded.guardFailure
  }

  const parts = call.split(".")
  const instance = parts[0]
  const localContainerName =
    trackableSelfAttributePath(temporaryReceiver) ??
    (temporaryReceiver?.type === "identifier" ? temporaryReceiver.text : instance && parts.length === 1 ? instance : undefined)
  const localContainer =
    localContainerName && trackedReceiverContainer
      ? trackedReceiverContainer
      : localContainerName
        ? containerInstance(current, localContainerName)
        : undefined
  if (localContainer && pureContainerMethod(localContainer, method)) {
    return effect("pure.compute", { resolvedCall: call })
  }
  if (rules.methods.emit.has(method)) return effect("emit.signal", { resolvedCall: call })
  if (rules.methods.pure.has(method)) return effect("pure.compute", { resolvedCall: call })
  const trackedHttpClient = instance ? httpClientInstance(current, instance) : undefined
  if (trackedHttpClient && parts.length === 2) {
    const canonicalCall = `${trackedHttpClient}.${method}`
    if (rules.calls.networkRead.has(canonicalCall)) {
      return effect("network.read", { resolvedCall: call, canonicalCall })
    }
    if (rules.calls.networkWrite.has(canonicalCall)) {
      return effect("network.write", { resolvedCall: call, canonicalCall })
    }
  }

  const readSpec = rules.pathCalls.read[call]
  if (readSpec) return pathEffect("fs.read", call, pick(input, readSpec.index, readSpec.names))

  const writeSpec = rules.pathCalls.write[call]
  if (writeSpec) return pathEffect("fs.write", call, pick(input, writeSpec.index, writeSpec.names))

  if (rules.calls.read.has(call)) return effect("fs.read", { resolvedCall: call })
  if (rules.calls.write.has(call)) return effect("fs.write", { resolvedCall: call })
  if (rules.sdk.ghapi.writeCalls.has(call)) return effect("fs.write", { resolvedCall: call })
  if (rules.calls.tempfileWrite.has(call)) return effect("fs.write", { resolvedCall: call })

  if (call === "os.popen" || call === "os.system") return effect("process.exec", { resolvedCall: call })
  if (rules.calls.exec.has(call)) return effect("dynamic.exec", { resolvedCall: call })
  if (rules.calls.networkRead.has(call)) return effect("network.read", { resolvedCall: call })
  if (rules.calls.networkWrite.has(call)) return effect("network.write", { resolvedCall: call })
  if (rules.calls.networkExec.has(call)) return effect("network.exec", { resolvedCall: call })
  if (rules.calls.dbExec.has(call)) return effect("db.exec", { resolvedCall: call })
  if (rules.calls.dangerousDeserializeExec.has(call)) return effect("dynamic.exec", { resolvedCall: call })
  if (rules.sdk.oci.execCalls.has(call)) return effect("network.exec", { resolvedCall: call })
  if (rules.sdk.ghapi.execCalls.has(call)) return effect("network.exec", { resolvedCall: call })
  if (isAtlassianConstructorCall(call, rules, hasAtlassianImportProvenance)) return effect("network.exec", { resolvedCall: call })
  if (rules.sdk.oci.clientMethodPrefixes.some((prefix) => call.startsWith(prefix))) {
    return effect("network.exec", { resolvedCall: call })
  }

  if (instance && hasGhapiInstance(current, instance) && parts.length >= 3) {
    return effect("network.exec", {
      resolvedCall: call,
      canonicalCall: `ghapi.${parts[1]}.${parts[2]}`,
    })
  }

  const atlassianClient = instance ? atlassianInstance(current, instance) : undefined
  if (atlassianClient && parts.length >= 2) {
    const method = parts[1]
    if (rules.sdk.atlassian.clientMethods[atlassianClient].has(method)) {
      return effect("network.exec", {
        resolvedCall: call,
        canonicalCall: `atlassian.${atlassianClient}.${method}`,
      })
    }
  }

  if (call.startsWith("subprocess.")) return effect("process.exec", { resolvedCall: call })
  if (call.startsWith("os.exec")) return effect("process.exec", { resolvedCall: call })

  if (rules.calls.emit.has(call)) return effect("emit.signal", { resolvedCall: call })
  if (rules.calls.pure.has(call)) return effect("pure.compute", { resolvedCall: call })

  return effect("unknown", {
    resolvedCall: call,
    outwardCall: `${CALLABLE_UNKNOWN_PREFIX}${call}`,
    evidence: hasLocalDefinition(current, call) ? localDefinitionEvidence(guardFailureEvidence) : guardFailureEvidence,
  })
}

export function isAtlassianImportStatement(node: Node) {
  if (node.type === "import_from_statement") {
    return /^\s*from\s+atlassian(?:\.|\s)/.test(node.text)
  }

  if (node.type === "import_statement") {
    const match = node.text.match(/^\s*import\s+([\s\S]+)$/)
    if (!match) return false
    const modules = match[1].split(",")
    return modules.some((part) => {
      const moduleName = part.trim().split(/\s+as\s+/i)[0]?.trim()
      if (!moduleName) return false
      return moduleName === "atlassian" || moduleName.startsWith("atlassian.")
    })
  }

  return false
}

function isAtlassianConstructorCall(call: string, rules: Rules, hasAtlassianImportProvenance: boolean) {
  const metadata = rules.sdk.atlassian.constructorMetadata.get(call)
  if (!metadata) return false
  if (!metadata.bare) return true
  return hasAtlassianImportProvenance
}

export function atlassianFamilyForConstructor(call: string, rules: Rules, hasAtlassianImportProvenance: boolean) {
  const metadata = rules.sdk.atlassian.constructorMetadata.get(call)
  if (!metadata) return
  if (metadata.bare && !hasAtlassianImportProvenance) return
  return metadata.family
}
