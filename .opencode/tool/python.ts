/// <reference path="../env.d.ts" />
import { tool } from "@opencode-ai/plugin"
import { spawn } from "child_process"
import { access, readFile } from "fs/promises"
import os from "os"
import path from "path"
import DESCRIPTION from "./python.txt"
import { analyze, type PythonEvent } from "./python-analyze"

const DEFAULT_TIMEOUT = 2 * 60 * 1000
const MAX_METADATA_LENGTH = 30_000
const MAX_ANALYZE_BYTES = 100 * 1024

type Proc = ReturnType<typeof spawn>

type PermissionItem = {
  kind: PythonEvent["kind"]
  call: string
  pattern: string
  always: string
  path?: string
}

type PermissionPlan = {
  patterns: string[]
  always: string[]
  external: string[]
  operations: PermissionItem[]
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

function callAlways(kind: "read" | "write", call: string) {
  const parts = call.split(".")
  if (!parts[0]) return `${kind}:*`
  if (parts.length <= 1) return `${kind}:${parts[0]}`
  return `${kind}:${parts[0]}.*`
}

function unknownAlways(call: string) {
  if (!call.startsWith("callable:")) return "unknown:*"
  return `unknown:${call}`
}

function buildPermissionPlan(events: PythonEvent[], cwd: string, worktree: string, script?: string): PermissionPlan {
  const patterns = new Set<string>()
  const always = new Set<string>()
  const external = new Set<string>()
  const operations: PermissionItem[] = []

  if (!isInside(worktree, cwd)) external.add(asGlob(cwd, "directory"))
  if (script && !isInside(worktree, script)) external.add(asGlob(script, "file"))

  for (const event of events) {
    if (event.kind === "exec") {
      const pattern = `exec:${event.call}`
      const allow = `exec:${execAlways(event.call)}`
      patterns.add(pattern)
      always.add(allow)
      operations.push({ kind: event.kind, call: event.call, pattern, always: allow })
      continue
    }

    if (event.kind === "unknown") {
      const pattern = `unknown:${event.call}`
      const allow = unknownAlways(event.call)
      patterns.add(pattern)
      always.add(allow)
      operations.push({ kind: event.kind, call: event.call, pattern, always: allow })
      continue
    }

    if (event.path) {
      const resolved = resolvePath(event.path, cwd)
      const pattern = `${event.kind}:${toSlash(resolved)}`
      const allow = `${event.kind}:${asGlob(resolved, "file")}`
      if (!isInside(worktree, resolved)) external.add(asGlob(resolved, "file"))
      patterns.add(pattern)
      always.add(allow)
      operations.push({
        kind: event.kind,
        call: event.call,
        path: resolved,
        pattern,
        always: allow,
      })
      continue
    }

    if (event.dynamicPath) {
      const pattern = `${event.kind}:<dynamic>`
      const allow = `${event.kind}:*`
      patterns.add(pattern)
      always.add(allow)
      operations.push({ kind: event.kind, call: event.call, pattern, always: allow })
      continue
    }

    const pattern = `${event.kind}:${event.call}`
    const allow = callAlways(event.kind, event.call)
    patterns.add(pattern)
    always.add(allow)
    operations.push({ kind: event.kind, call: event.call, pattern, always: allow })
  }

  if (patterns.size === 0) {
    patterns.add("unknown:empty-analysis")
    always.add("unknown:*")
    operations.push({
      kind: "unknown",
      call: "empty-analysis",
      pattern: "unknown:empty-analysis",
      always: "unknown:*",
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
        ? path.normalize(args.workdir)
        : path.resolve(context.directory, args.workdir)
      : context.directory

    const python = await resolvePython(context.worktree)

    let source = ""
    let script: string | undefined

    if (hasCode) source = args.code ?? ""

    if (hasScriptPath) {
      script = path.isAbsolute(args.scriptPath!) ? path.normalize(args.scriptPath!) : path.resolve(cwd, args.scriptPath!)
      try {
        source = await readFile(script, "utf8")
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? ((error as { code?: string }).code ?? "")
            : ""
        if (code === "ENOENT") {
          throw new Error(`Python script file not found: ${script}`)
        }
        throw error
      }
    }

    if (!source.trim()) {
      throw new Error("Python source is empty. Provide non-empty `code` or a non-empty script file.")
    }

    const events =
      Buffer.byteLength(source, "utf8") > MAX_ANALYZE_BYTES
        ? ([{ kind: "unknown", call: "large-script" }] satisfies PythonEvent[])
        : await analyze(source)

    const plan = buildPermissionPlan(events, cwd, context.worktree, script)

    if (plan.external.length > 0) {
      await context.ask({
        permission: "external_directory",
        patterns: plan.external,
        always: plan.external,
        metadata: {
          source: script ?? "<inline>",
          description: args.description,
        },
      })
    }

    await context.ask({
      permission: "python",
      patterns: plan.patterns,
      always: plan.always,
      metadata: {
        source: script ?? "<inline>",
        description: args.description,
        operations: plan.operations,
      },
    })

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
      },
    })

    return output
  },
})
