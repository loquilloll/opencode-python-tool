import { readFile } from "fs/promises"
import path from "path"
import { getPythonAstFrontend } from "./frontend/tree-sitter"
import type { AtlassianClientFamily, AtlassianCtor, PathSpec, Rules } from "./python-analyze-types"
import { FAMILIES, RULES_URL, RULES_VERSION } from "./python-known-methods"
import { parseGuardedRules } from "./python-rule-schema"

let parserFrontend: Promise<Awaited<ReturnType<typeof getPythonAstFrontend>>> | undefined
let rules: Promise<Rules> | undefined
let rulesKey: string | undefined

function fail(label: string, msg: string): never {
  throw new Error(`Invalid python-rules.json: ${label} ${msg}`)
}

function record(input: unknown, label: string) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail(label, "must be an object")
  return input as Record<string, unknown>
}

function list(input: unknown, label: string) {
  if (!Array.isArray(input)) fail(label, "must be a string[]")
  const out: string[] = []
  for (const [i, item] of input.entries()) {
    if (typeof item !== "string") fail(`${label}[${i}]`, "must be a string")
    out.push(item)
  }
  return out
}

function listOrEmpty(input: unknown, label: string) {
  if (input === undefined) return []
  return list(input, label)
}

function num(input: unknown, label: string) {
  if (typeof input !== "number" || !Number.isInteger(input)) fail(label, "must be an integer")
  if (input < 0) fail(label, "must be >= 0")
  return input
}

function spec(input: unknown, label: string): PathSpec {
  const obj = record(input, label)
  return {
    index: num(obj.index, `${label}.index`),
    names: list(obj.names, `${label}.names`),
  }
}

function specs(input: unknown, label: string) {
  const obj = record(input, label)
  const out = Object.create(null) as Record<string, PathSpec>
  for (const [key, value] of Object.entries(obj)) out[key] = spec(value, `${label}.${key}`)
  return out
}

function family(input: unknown, label: string) {
  if (input === undefined) return
  if (typeof input !== "string") fail(label, "must be a supported family")
  if (!FAMILIES.includes(input as AtlassianClientFamily)) fail(label, "must be a supported family")
  return input as AtlassianClientFamily
}

function ctors(input: unknown, label: string) {
  if (!Array.isArray(input)) fail(label, "must be an array")
  return input.map((item, i) => {
    const obj = record(item, `${label}[${i}]`)
    return {
      family: family(obj.family, `${label}[${i}].family`),
      variants: list(obj.variants, `${label}[${i}].variants`),
    } satisfies AtlassianCtor
  })
}

export async function loadRules() {
  const source = process.env.OPENCODE_PYTHON_RULES ? path.resolve(process.env.OPENCODE_PYTHON_RULES) : RULES_URL
  const key = typeof source === "string" ? source : source.href
  if (rules && rulesKey === key) return rules
  rulesKey = key
  rules = readRules(source).catch((err) => {
    if (rulesKey === key) {
      rules = undefined
      rulesKey = undefined
    }
    throw err
  })
  return rules
}

async function readRules(source: string | URL): Promise<Rules> {
  let text = ""
  try {
    text = await readFile(source, "utf8")
  } catch (err) {
    const msg = err instanceof Error ? err.message : "could not be read"
    fail("file", msg)
  }

  let data: unknown
  try {
    data = JSON.parse(text) as unknown
  } catch (err) {
    const msg = err instanceof Error ? err.message : "contains invalid JSON"
    fail("file", `contains invalid JSON (${msg})`)
  }

  const raw = record(data, "root")
  if (num(raw.version, "version") !== RULES_VERSION) fail("version", `must be ${RULES_VERSION}`)

  const methods = record(raw.methods, "methods")
  const calls = record(raw.calls, "calls")
  const pathCalls = record(raw.pathCalls, "pathCalls")
  const sdk = record(raw.sdk, "sdk")
  const oci = record(sdk.oci, "sdk.oci")
  const ghapi = record(sdk.ghapi, "sdk.ghapi")
  const atlassian = record(sdk.atlassian, "sdk.atlassian")

  const constructors = ctors(atlassian.constructors, "sdk.atlassian.constructors")
  const constructorMetadata = new Map<string, { family?: AtlassianClientFamily; bare: boolean }>()
  for (const item of constructors) {
    for (const variant of item.variants) {
      constructorMetadata.set(variant, {
        family: item.family,
        bare: !variant.includes("."),
      })
    }
  }

  const clientMethods = record(atlassian.clientMethods, "sdk.atlassian.clientMethods")

  return {
    methods: {
      read: new Set(list(methods.read, "methods.read")),
      write: new Set(list(methods.write, "methods.write")),
      emit: new Set(listOrEmpty(methods.emit, "methods.emit")),
      pure: new Set(listOrEmpty(methods.pure, "methods.pure")),
    },
    calls: {
      read: new Set(list(calls.read, "calls.read")),
      write: new Set(list(calls.write, "calls.write")),
      emit: new Set(listOrEmpty(calls.emit, "calls.emit")),
      exec: new Set(list(calls.exec, "calls.exec")),
      pure: new Set(listOrEmpty(calls.pure, "calls.pure")),
      networkRead: new Set(listOrEmpty(calls.networkRead, "calls.networkRead")),
      networkWrite: new Set(listOrEmpty(calls.networkWrite, "calls.networkWrite")),
      networkExec: new Set(list(calls.networkExec, "calls.networkExec")),
      dbExec: new Set(list(calls.dbExec, "calls.dbExec")),
      tempfileWrite: new Set(list(calls.tempfileWrite, "calls.tempfileWrite")),
      dangerousDeserializeExec: new Set(list(calls.dangerousDeserializeExec, "calls.dangerousDeserializeExec")),
    },
    pathCalls: {
      read: specs(pathCalls.read, "pathCalls.read"),
      write: specs(pathCalls.write, "pathCalls.write"),
    },
    sdk: {
      oci: {
        execCalls: new Set(list(oci.execCalls, "sdk.oci.execCalls")),
        clientMethodPrefixes: list(oci.clientMethodPrefixes, "sdk.oci.clientMethodPrefixes"),
      },
      ghapi: {
        execCalls: new Set(list(ghapi.execCalls, "sdk.ghapi.execCalls")),
        writeCalls: new Set(list(ghapi.writeCalls, "sdk.ghapi.writeCalls")),
        instanceConstructors: new Set(list(ghapi.instanceConstructors, "sdk.ghapi.instanceConstructors")),
      },
      atlassian: {
        constructorMetadata,
        clientMethods: {
          jira: new Set(list(clientMethods.jira, "sdk.atlassian.clientMethods.jira")),
          confluence: new Set(list(clientMethods.confluence, "sdk.atlassian.clientMethods.confluence")),
          bitbucket: new Set(list(clientMethods.bitbucket, "sdk.atlassian.clientMethods.bitbucket")),
          servicedesk: new Set(list(clientMethods.servicedesk, "sdk.atlassian.clientMethods.servicedesk")),
        },
      },
    },
    guarded: parseGuardedRules(raw.guarded, "guarded", { fail, record, list, listOrEmpty, num }),
  }
}

export async function getFrontend() {
  if (parserFrontend) return parserFrontend
  parserFrontend = getPythonAstFrontend().catch((error) => {
    parserFrontend = undefined
    throw error
  })
  return parserFrontend
}
