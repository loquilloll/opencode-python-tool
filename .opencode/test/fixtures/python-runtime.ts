import { mkdir, mkdtemp, rm } from "fs/promises"
import os from "os"
import path from "path"
import pythonTool from "../../tool/python"
import { createMockContext } from "./context"

declare const Bun: {
  which(binary: string): string | null
}

export const INVALID_PYTHON_BIN = "/__opencode__/missing/python3"
export const HAS_PYTHON3 = Boolean(Bun.which("python3"))

type MockContext = ReturnType<typeof createMockContext>
type PythonAskMetadata =
  | {
      source?: string
      mode?: string
      scriptPath?: string
      codePreview?: string
      codePreviewTruncated?: boolean
      codePreviewTruncationMarker?: string | null
      codePreviewBytes?: { total?: number; preview?: number }
      codePreviewLines?: { total?: number; preview?: number }
      codeExpanded?: string
      codeExpandedAvailable?: boolean
      analyzerVersion?: string
      engineVersion?: string
      operations?: Array<{
        kind?: string
        call?: string
        pattern?: string
        always?: string
        canonicalSource?: string
        receiverKind?: string
        dependencySignature?: string[]
        ruleHit?: string
        guardFailure?: { type?: string; detail?: string }
      }>
      permissionPatterns?: string[]
      permissionAlways?: string[]
    }
  | undefined

export function toSlash(input: string) {
  return input.replace(/\\/g, "/")
}

export async function withWorkspace<T>(run: (workspace: { root: string; worktree: string }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-python-tool-"))
  const worktree = path.join(root, "worktree")
  await mkdir(worktree, { recursive: true })

  try {
    return await run({ root, worktree })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export function getAsk(context: MockContext, permission: string) {
  return context.asks.find((item) => item.permission === permission)
}

export function getAskMetadata(context: MockContext, permission: string) {
  return getAsk(context, permission)?.metadata as PythonAskMetadata
}

export async function executeExpectingEnoent(
  args: Parameters<typeof pythonTool.execute>[0],
  context: Parameters<typeof pythonTool.execute>[1],
  pythonBin = INVALID_PYTHON_BIN,
) {
  const previous = process.env.OPENCODE_PYTHON_BIN
  process.env.OPENCODE_PYTHON_BIN = pythonBin

  try {
    await pythonTool.execute(args, context)
    throw new Error("Expected pythonTool.execute() to reject with an ENOENT-style interpreter error")
  } catch (error) {
    if (!(error instanceof Error) || !/Unable to execute Python binary/.test(error.message)) {
      throw error
    }
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_PYTHON_BIN
    else process.env.OPENCODE_PYTHON_BIN = previous
  }
}
