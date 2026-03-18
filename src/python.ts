/// <reference path="./python/env.d.ts" />
import { spawn } from "child_process"
import { access, lstat, readFile, readlink } from "fs/promises"
import os from "os"
import path from "path"
import DESCRIPTION from "./python/python.txt"
import { analyzeDetailed, type PythonEvent } from "./python/python-analyze"
import { analyzerMetadata } from "./python/python-ir"

function isMissingPluginImport(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: string }).code : undefined
  const message = error instanceof Error ? error.message : String(error)
  return code === "ERR_MODULE_NOT_FOUND" && /@opencode-ai\/plugin/.test(message)
}

async function loadPlugin() {
  try {
    return await import("@opencode-ai/plugin")
  } catch (error) {
    if (!isMissingPluginImport(error)) throw error
    return await import("../.opencode/node_modules/@opencode-ai/plugin/dist/index.js")
  }
}

const { tool } = await loadPlugin()

const DEFAULT_TIMEOUT = 2 * 60 * 1000
const MAX_METADATA_LENGTH = 30_000
const MAX_ANALYZE_BYTES = 100 * 1024
const MAX_PERMISSION_PREVIEW_BYTES = 4_000
const MAX_PERMISSION_PREVIEW_LINES = 120
const MAX_PERMISSION_EXPANDED_BYTES = 50_000
const PERMISSION_PREVIEW_TRUNCATION_MARKER = "\n...<python_permission_preview_truncated>"

type Proc = ReturnType<typeof spawn>

type PermissionItem = {
  kind: PythonEvent["kind"]
  call: string
  pattern: string
  always: string
  path?: string
  canonicalSource?: string
  receiverKind?: string
  dependencySignature?: string[]
  ruleHit?: string
  guardFailure?: { type?: string; detail?: string }
}

type PermissionPlan = {
  patterns: string[]
  always: string[]
  external: string[]
  operations: PermissionItem[]
}

type PermissionCodePreview = {
  text: string
  truncated: boolean
  truncationMarker: string | null
  totalBytes: number
  previewBytes: number
  totalLines: number
  previewLines: number
}

function trimOutput(input: string) {
  if (input.length <= MAX_METADATA_LENGTH) return input
  return input.slice(0, MAX_METADATA_LENGTH) + "\n\n..."
}

function toSlash(input: string) {
  return input.replace(/\\/g, "/")
}

function expandHome(input: string) {
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2))
  if (input === "~") return os.homedir()
  if (input.startsWith("$HOME/")) return path.join(os.homedir(), input.slice(6))
  if (input.startsWith("$HOME")) return path.join(os.homedir(), input.slice(5))
  return input
}

function resolvePath(input: string, cwd: string) {
  const expanded = expandHome(input)
  if (path.isAbsolute(expanded)) return path.normalize(expanded)
  return path.normalize(path.resolve(cwd, expanded))
}

function resolveBoundaryInput(input: string, cwd: string) {
  const expanded = expandHome(input)
  if (path.isAbsolute(expanded)) return expanded
  const prefix = cwd.endsWith(path.sep) ? cwd : cwd + path.sep
  return prefix + expanded
}

async function fileExists(target: string) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function resolvePython(worktree: string) {
  if (process.env.OPENCODE_PYTHON_BIN) return process.env.OPENCODE_PYTHON_BIN

  if (process.env.VIRTUAL_ENV) {
    const venvPython = path.join(process.env.VIRTUAL_ENV, "bin", "python3")
    if (await fileExists(venvPython)) return venvPython
  }

  for (const dirname of [".venv", "venv"]) {
    const candidate = path.join(worktree, dirname, "bin", "python3")
    if (await fileExists(candidate)) return candidate
  }

  return "python3"
}

function isInside(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (!relative || relative === ".") return true
  if (relative === "..") return false
  if (relative.startsWith(".." + path.sep)) return false
  return !path.isAbsolute(relative)
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? ((error as { code?: string }).code ?? "") : ""
}

function appendPathSegments(base: string, segments: string[]) {
  let current = base
  for (const segment of segments) {
    if (!segment || segment === ".") continue
    if (segment === "..") current = path.dirname(current)
    else current = path.join(current, segment)
  }
  return current
}

async function canonicalBoundaryPath(target: string, resolving = new Set<string>()): Promise<string> {
  const absolute = path.isAbsolute(target) ? target : path.resolve(target)
  const root = path.parse(absolute).root || path.sep
  const segments = absolute.slice(root.length).split(/[\\/]+/)
  let current = root

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]
    if (!segment || segment === ".") continue
    if (segment === "..") {
      current = path.dirname(current)
      continue
    }

    const candidate = path.join(current, segment)
    try {
      const stat = await lstat(candidate)
      if (stat.isSymbolicLink()) {
        const link = await readlink(candidate)
        const targetPath = path.isAbsolute(link) ? link : path.resolve(path.dirname(candidate), link)
        const loopKey = path.normalize(candidate)
        if (resolving.has(loopKey)) {
          throw Object.assign(new Error(`Too many symbolic links while resolving ${target}`), { code: "ELOOP" })
        }
        resolving.add(loopKey)
        current = await canonicalBoundaryPath(targetPath, resolving)
        resolving.delete(loopKey)
        continue
      }
      current = candidate
    } catch (error) {
      const code = errorCode(error)
      if (code !== "ENOENT") throw error
      return appendPathSegments(current, [segment, ...segments.slice(index + 1)])
    }
  }

  return current
}

async function boundaryPathOrFallback(target: string) {
  try {
    return { path: await canonicalBoundaryPath(target), trusted: true }
  } catch {
    return { path: path.normalize(target), trusted: false }
  }
}

function asGlob(target: string, kind: "file" | "directory") {
  const dir = kind === "directory" ? target : path.dirname(target)
  const normalized = toSlash(path.normalize(dir)).replace(/\/+$/g, "")
  if (!normalized) return "/*"
  return `${normalized}/*`
}

function execAlways(call: string) {
  const parts = call.split(".")
  if (!parts[0]) return "*"
  if (parts.length <= 1) return parts[0]
  return `${parts[0]}.*`
}

function callAlways(kind: "read" | "write" | "emit" | "pure", call: string) {
  const parts = call.split(".")
  if (!parts[0]) return `${kind}:*`
  if (parts.length <= 1) return `${kind}:${parts[0]}`
  return `${kind}:${parts[0]}.*`
}

function isPermissionKind(kind: PythonEvent["kind"]): kind is "read" | "write" | "exec" | "unknown" {
  return kind === "read" || kind === "write" || kind === "exec" || kind === "unknown"
}

function unknownAlways(call: string) {
  if (!call.startsWith("callable:")) return "unknown:*"
  return `unknown:${call}`
}

function operationMetadata(event: PythonEvent) {
  const explain = event.evidence?.explain ?? []
  return {
    canonicalSource: event.sourceCall ?? event.call,
    receiverKind: event.evidence?.receiverKind,
    dependencySignature: event.evidence?.dependencySignature,
    ruleHit: explain[0],
    guardFailure: event.evidence?.guardFailure,
  }
}

async function buildPermissionPlan(events: PythonEvent[], cwd: string, worktree: string): Promise<PermissionPlan> {
  const patterns = new Set<string>()
  const always = new Set<string>()
  const external = new Set<string>()
  const operations: PermissionItem[] = []
  const canonicalWorktree = await boundaryPathOrFallback(worktree)
  const canonicalCwd = await boundaryPathOrFallback(cwd)

  if (!canonicalWorktree.trusted || !canonicalCwd.trusted || !isInside(canonicalWorktree.path, canonicalCwd.path)) {
    external.add(asGlob(canonicalCwd.path, "directory"))
  }

  for (const event of events) {
    if (event.kind === "exec") {
      const pattern = `exec:${event.call}`
      const allow = `exec:${execAlways(event.call)}`
      patterns.add(pattern)
      always.add(allow)
      operations.push({ kind: event.kind, call: event.call, pattern, always: allow, ...operationMetadata(event) })
      continue
    }

    if (event.kind === "unknown") {
      const pattern = `unknown:${event.call}`
      const allow = unknownAlways(event.call)
      patterns.add(pattern)
      always.add(allow)
      operations.push({ kind: event.kind, call: event.call, pattern, always: allow, ...operationMetadata(event) })
      continue
    }

    if (event.path) {
      const resolved = resolvePath(event.path, cwd)
      const canonicalResolved = await boundaryPathOrFallback(resolveBoundaryInput(event.path, cwd))
      const pattern = `${event.kind}:${toSlash(resolved)}`
      const allow = `${event.kind}:${asGlob(resolved, "file")}`
      if (!canonicalWorktree.trusted || !canonicalResolved.trusted || !isInside(canonicalWorktree.path, canonicalResolved.path)) {
        external.add(asGlob(canonicalResolved.path, "file"))
      }
      operations.push({
        kind: event.kind,
        call: event.call,
        path: resolved,
        pattern,
        always: allow,
        ...operationMetadata(event),
      })
      if (isPermissionKind(event.kind) && event.kind !== "read") {
        patterns.add(pattern)
        always.add(allow)
      }
      continue
    }

    if (event.dynamicPath) {
      const pattern = `${event.kind}:<dynamic>`
      const allow = `${event.kind}:*`
      operations.push({ kind: event.kind, call: event.call, pattern, always: allow, ...operationMetadata(event) })
      if (isPermissionKind(event.kind)) {
        patterns.add(pattern)
        always.add(allow)
      }
      continue
    }

    const pattern = `${event.kind}:${event.call}`
    const allow = callAlways(event.kind, event.call)
    operations.push({ kind: event.kind, call: event.call, pattern, always: allow, ...operationMetadata(event) })
    if (isPermissionKind(event.kind)) {
      patterns.add(pattern)
      always.add(allow)
    }
  }

  if (patterns.size === 0 && operations.length === 0) {
    patterns.add("unknown:empty-analysis")
    always.add("unknown:*")
    operations.push({
      kind: "unknown",
      call: "empty-analysis",
      pattern: "unknown:empty-analysis",
      always: "unknown:*",
      canonicalSource: "empty-analysis",
    })
  }

  return {
    patterns: Array.from(patterns),
    always: Array.from(always),
    external: Array.from(external),
    operations,
  }
}

function kill(proc: Proc, exited: () => boolean) {
  if (exited()) return

  if (process.platform === "win32") {
    proc.kill("SIGTERM")
    return
  }

  if (!proc.pid) {
    proc.kill("SIGTERM")
    return
  }

  try {
    process.kill(-proc.pid, "SIGTERM")
  } catch {
    proc.kill("SIGTERM")
  }

  setTimeout(() => {
    if (exited()) return
    if (!proc.pid) {
      proc.kill("SIGKILL")
      return
    }
    try {
      process.kill(-proc.pid, "SIGKILL")
    } catch {
      proc.kill("SIGKILL")
    }
  }, 1_000)
}

function commandPreview(python: string, script: string | undefined, args: string[]) {
  if (script) return `${python} ${script}${args.length ? " " + args.join(" ") : ""}`
  return `${python} -c <inline-code>${args.length ? " " + args.join(" ") : ""}`
}

function lineCount(input: string) {
  if (!input) return 0
  return input.split(/\r\n|\r|\n/).length
}

function buildPermissionCodePreview(source: string): PermissionCodePreview {
  const totalBytes = Buffer.byteLength(source, "utf8")
  const totalLines = lineCount(source)

  let preview = source
  let truncated = false

  if (Buffer.byteLength(preview, "utf8") > MAX_PERMISSION_PREVIEW_BYTES) {
    preview = Buffer.from(preview, "utf8").subarray(0, MAX_PERMISSION_PREVIEW_BYTES).toString("utf8")
    truncated = true
  }

  const previewLineList = preview.split(/\r\n|\r|\n/)
  if (previewLineList.length > MAX_PERMISSION_PREVIEW_LINES) {
    preview = previewLineList.slice(0, MAX_PERMISSION_PREVIEW_LINES).join("\n")
    truncated = true
  }

  if (truncated) preview += PERMISSION_PREVIEW_TRUNCATION_MARKER

  return {
    text: preview,
    truncated,
    truncationMarker: truncated ? PERMISSION_PREVIEW_TRUNCATION_MARKER : null,
    totalBytes,
    previewBytes: Buffer.byteLength(preview, "utf8"),
    totalLines,
    previewLines: lineCount(preview),
  }
}

function buildPermissionCodeExpanded(source: string, preview: PermissionCodePreview) {
  if (!preview.truncated) return {}
  if (preview.totalBytes <= MAX_PERMISSION_EXPANDED_BYTES) {
    return {
      codeExpanded: source,
      codeExpandedAvailable: true,
    }
  }
  return {
    codeExpandedAvailable: false,
  }
}

function hasDirectSubprocessInvocation(events: PythonEvent[]) {
  return events.some((event) => event.call.startsWith("subprocess."))
}

export default tool({
  description: DESCRIPTION,
  args: {
    code: tool.schema.string().describe("Inline Python source code to execute").optional(),
    scriptPath: tool.schema.string().describe("Path to a Python script file to execute").optional(),
    args: tool.schema.array(tool.schema.string()).describe("Arguments passed to the Python program").default([]),
    workdir: tool.schema
      .string()
      .describe("Working directory for execution. Defaults to the current project directory.")
      .optional(),
    timeout: tool.schema.number().describe("Timeout in milliseconds. Defaults to 120000.").optional(),
    description: tool.schema.string().describe("Clear, concise description of what this Python command does"),
  },
  async execute(args, context) {
    const hasCode = args.code !== undefined
    const hasScriptPath = args.scriptPath !== undefined

    if (hasCode === hasScriptPath) {
      throw new Error("Provide exactly one of `code` or `scriptPath`.")
    }

    if (args.timeout !== undefined && args.timeout <= 0) {
      throw new Error(`Invalid timeout value: ${args.timeout}. Timeout must be a positive number.`)
    }

    const timeout = args.timeout ?? DEFAULT_TIMEOUT
    const cwd = args.workdir
      ? path.isAbsolute(args.workdir)
        ? args.workdir
        : resolveBoundaryInput(args.workdir, context.directory)
      : context.directory

    const python = await resolvePython(context.worktree)

    let source = ""
    let script: string | undefined

    if (hasCode) source = args.code ?? ""

    if (hasScriptPath) {
      script = path.isAbsolute(args.scriptPath!) ? args.scriptPath! : resolveBoundaryInput(args.scriptPath!, cwd)
      const canonicalWorktree = await boundaryPathOrFallback(context.worktree)
      const canonicalScript = await boundaryPathOrFallback(script)
      if (!canonicalWorktree.trusted || !canonicalScript.trusted || !isInside(canonicalWorktree.path, canonicalScript.path)) {
        await context.ask({
          permission: "external_directory",
          patterns: [asGlob(canonicalScript.path, "file")],
          always: [asGlob(canonicalScript.path, "file")],
          metadata: {
            source: script,
            description: args.description,
            mode: "script",
            scriptPath: script,
          },
        })
      }
      try {
        source = await readFile(script, "utf8")
      } catch (error) {
        const code = errorCode(error)
        if (code === "ENOENT") {
          throw new Error(`Python script file not found: ${script}`)
        }
        throw error
      }
    }

    if (!source.trim()) {
      throw new Error("Python source is empty. Provide non-empty `code` or a non-empty script file.")
    }

    const metadata = analyzerMetadata()
    const analyzed =
      Buffer.byteLength(source, "utf8") > MAX_ANALYZE_BYTES
        ? {
            events: [{ kind: "unknown", call: "large-script" }] satisfies PythonEvent[],
            analyzerVersion: metadata.analyzerVersion,
            engineVersion: metadata.engineVersion,
          }
        : await analyzeDetailed(source)

    const events = analyzed.events

    if (hasDirectSubprocessInvocation(events)) {
      throw new Error(
        "Direct subprocess invocation is blocked in the `python` tool. Use the `bash` tool for terminal/process orchestration.",
      )
    }

    const plan = await buildPermissionPlan(events, cwd, context.worktree)
    const mode = script ? "script" : "inline"
    const codePreview = buildPermissionCodePreview(source)
    const codeExpanded = buildPermissionCodeExpanded(source, codePreview)
    const askMetadata = {
      source: script ?? "<inline>",
      description: args.description,
      mode,
      scriptPath: script,
      codePreview: codePreview.text,
      codePreviewTruncated: codePreview.truncated,
      codePreviewTruncationMarker: codePreview.truncationMarker,
      codePreviewBytes: {
        total: codePreview.totalBytes,
        preview: codePreview.previewBytes,
      },
      codePreviewLines: {
        total: codePreview.totalLines,
        preview: codePreview.previewLines,
      },
      ...codeExpanded,
    }

    const permissionMetadata = {
      analyzerVersion: analyzed.analyzerVersion,
      engineVersion: analyzed.engineVersion,
      operations: plan.operations,
      permissionPatterns: plan.patterns,
      permissionAlways: plan.always,
    }

    if (plan.external.length > 0) {
      await context.ask({
        permission: "external_directory",
        patterns: plan.external,
        always: plan.external,
        metadata: {
          ...askMetadata,
          ...permissionMetadata,
        },
      })
    }

    if (plan.patterns.length > 0) {
      await context.ask({
        permission: "python",
        patterns: plan.patterns,
        always: plan.always,
        metadata: {
          ...askMetadata,
          ...permissionMetadata,
        },
      })
    }

    const runArgs = hasCode ? ["-c", source, ...args.args] : [script!, ...args.args]
    const command = commandPreview(python, script, args.args)
    const proc = spawn(python, runArgs, {
      cwd,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONUNBUFFERED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })

    let output = ""
    let timedOut = false
    let aborted = false
    let exited = false
    let exitCode: number | null = null

    context.metadata({
      title: args.description,
      metadata: {
        output: "",
        description: args.description,
        command,
        cwd,
        ...permissionMetadata,
      },
    })

    const append = (chunk: Buffer) => {
      output += chunk.toString()
      context.metadata({
        metadata: {
          output: trimOutput(output),
          description: args.description,
          command,
          cwd,
          ...permissionMetadata,
        },
      })
    }

    proc.stdout?.on("data", append)
    proc.stderr?.on("data", append)

    if (context.abort.aborted) {
      aborted = true
      kill(proc, () => exited)
    }

    const onAbort = () => {
      aborted = true
      kill(proc, () => exited)
    }

    context.abort.addEventListener("abort", onAbort, { once: true })

    const timer = setTimeout(() => {
      timedOut = true
      kill(proc, () => exited)
    }, timeout + 100)

    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer)
          context.abort.removeEventListener("abort", onAbort)
        }

        proc.once("exit", (code) => {
          exitCode = code
          exited = true
          cleanup()
          resolve()
        })

        proc.once("error", (error) => {
          exited = true
          cleanup()
          reject(error)
        })
      })
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? ((error as { code?: string }).code ?? "")
          : ""
      if (code === "ENOENT") {
        throw new Error(
          `Unable to execute Python binary \`${python}\`. Set OPENCODE_PYTHON_BIN to a valid interpreter path.`,
        )
      }
      throw error
    }

    const meta: string[] = []
    if (timedOut) meta.push(`python tool terminated command after exceeding timeout ${timeout} ms`)
    if (aborted) meta.push("User aborted the command")
    if (typeof exitCode === "number" && exitCode !== 0) meta.push(`Exit code: ${exitCode}`)
    if (meta.length > 0) output += "\n\n<python_metadata>\n" + meta.join("\n") + "\n</python_metadata>"

    context.metadata({
      metadata: {
        output: trimOutput(output),
        description: args.description,
        command,
        cwd,
        exit: proc.exitCode,
        ...permissionMetadata,
      },
    })

    return output
  },
})
