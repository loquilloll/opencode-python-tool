import type { ToolContext } from "@opencode-ai/plugin"

export type AskInput = Parameters<ToolContext["ask"]>[0]
export type MetadataInput = Parameters<ToolContext["metadata"]>[0]

export function createMockContext(
  overrides: Partial<ToolContext> = {},
): ToolContext & { asks: AskInput[]; metadatas: MetadataInput[] } {
  const asks: AskInput[] = []
  const metadatas: MetadataInput[] = []

  const context: ToolContext = {
    sessionID: "test-session",
    messageID: "test-message",
    agent: "test-agent",
    directory: "/tmp/test-project",
    worktree: "/tmp/test-project",
    abort: new AbortController().signal,
    async ask(input) {
      asks.push(input)
    },
    metadata(input) {
      metadatas.push(input)
    },
    ...overrides,
  }

  return Object.assign(context, { asks, metadatas })
}
