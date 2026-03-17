import { describe, expect, it } from "bun:test"
import { writeFile } from "fs/promises"
import path from "path"
import pythonTool from "../tool/python"
import { createMockContext } from "./fixtures/context"
import { INVALID_PYTHON_BIN, withWorkspace } from "./fixtures/python-runtime"

describe("python tool runtime", () => {
  describe("arg validation", () => {
    it("errors when neither code nor scriptPath is provided", async () => {
      const context = createMockContext()
      await expect(
        pythonTool.execute(
          {
            args: [],
            description: "missing code",
          },
          context,
        ),
      ).rejects.toThrow("Provide exactly one of `code` or `scriptPath`.")
    })

    it("errors when both code and scriptPath are provided", async () => {
      await withWorkspace(async ({ worktree }) => {
        const scriptPath = path.join(worktree, "script.py")
        await writeFile(scriptPath, "print('ok')\n", "utf8")
        const context = createMockContext({ worktree, directory: worktree })

        await expect(
          pythonTool.execute(
            {
              code: "print('inline')",
              scriptPath,
              args: [],
              description: "xor",
            },
            context,
          ),
        ).rejects.toThrow("Provide exactly one of `code` or `scriptPath`.")
      })
    })

    it("errors for negative and zero timeout", async () => {
      const context = createMockContext()
      await expect(
        pythonTool.execute(
          {
            code: "print('x')",
            timeout: -1,
            args: [],
            description: "negative timeout",
          },
          context,
        ),
      ).rejects.toThrow("Invalid timeout value: -1. Timeout must be a positive number.")

      await expect(
        pythonTool.execute(
          {
            code: "print('x')",
            timeout: 0,
            args: [],
            description: "zero timeout",
          },
          context,
        ),
      ).rejects.toThrow("Invalid timeout value: 0. Timeout must be a positive number.")
    })

    it("errors for empty inline code", async () => {
      const context = createMockContext()
      await expect(
        pythonTool.execute(
          {
            code: "   \n\t",
            args: [],
            description: "empty code",
          },
          context,
        ),
      ).rejects.toThrow("Python source is empty. Provide non-empty `code` or a non-empty script file.")
    })

    it("errors for empty script file", async () => {
      await withWorkspace(async ({ worktree }) => {
        const scriptPath = path.join(worktree, "empty.py")
        await writeFile(scriptPath, "   \n", "utf8")
        const context = createMockContext({ worktree, directory: worktree })

        await expect(
          pythonTool.execute(
            {
              scriptPath,
              args: [],
              description: "empty script",
            },
            context,
          ),
        ).rejects.toThrow("Python source is empty. Provide non-empty `code` or a non-empty script file.")
      })
    })
  })

  describe("subprocess hard-fail", () => {
    it("fails immediately for inline subprocess usage without permission asks", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await expect(
          pythonTool.execute(
            {
              code: "import subprocess\nsubprocess.run(['echo', 'blocked'])",
              args: [],
              description: "inline subprocess blocked",
            },
            context,
          ),
        ).rejects.toThrow("Direct subprocess invocation is blocked in the `python` tool. Use the `bash` tool for terminal/process orchestration.")

        expect(context.asks).toHaveLength(0)
      })
    })

    it("fails immediately for script subprocess usage without permission asks", async () => {
      await withWorkspace(async ({ worktree }) => {
        const scriptPath = path.join(worktree, "blocked-subprocess.py")
        await writeFile(scriptPath, "import subprocess\nsubprocess.Popen(['echo', 'blocked'])\n", "utf8")

        const context = createMockContext({ worktree, directory: worktree })

        await expect(
          pythonTool.execute(
            {
              scriptPath,
              args: [],
              description: "script subprocess blocked",
            },
            context,
          ),
        ).rejects.toThrow("Direct subprocess invocation is blocked in the `python` tool. Use the `bash` tool for terminal/process orchestration.")

        expect(context.asks).toHaveLength(0)
      })
    })
  })

  describe("ENOENT handling", () => {
    it("returns friendly invalid OPENCODE_PYTHON_BIN error", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })
        const badBin = INVALID_PYTHON_BIN

        const previous = process.env.OPENCODE_PYTHON_BIN
        process.env.OPENCODE_PYTHON_BIN = badBin

        try {
          await expect(
            pythonTool.execute(
              {
                code: "print('hello')",
                args: [],
                description: "enoent",
              },
              context,
            ),
          ).rejects.toThrow(`Unable to execute Python binary \`${badBin}\`. Set OPENCODE_PYTHON_BIN to a valid interpreter path.`)
        } finally {
          if (previous === undefined) delete process.env.OPENCODE_PYTHON_BIN
          else process.env.OPENCODE_PYTHON_BIN = previous
        }
      })
    })
  })
})
