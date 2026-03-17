import { describe, expect, it } from "bun:test"
import { mkdir, rm, symlink, writeFile } from "fs/promises"
import path from "path"
import pythonTool from "../tool/python"
import { createMockContext } from "./fixtures/context"
import {
  INVALID_PYTHON_BIN,
  executeExpectingEnoent,
  getAsk,
  getAskMetadata,
  toSlash,
  withWorkspace,
} from "./fixtures/python-runtime"

describe("python tool runtime", () => {
  describe("script-file permission behavior", () => {
    it("includes script code preview metadata when a script still needs a python ask", async () => {
      await withWorkspace(async ({ worktree }) => {
        const scriptPath = path.join(worktree, "preview.py")
        const scriptSource = "mypkg.do_thing()\n"
        await writeFile(scriptPath, scriptSource, "utf8")

        const context = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            scriptPath,
            args: [],
            description: "script preview metadata",
          },
          context,
        )

        const metadata = getAskMetadata(context, "python")
        expect(metadata?.mode).toBe("script")
        expect(metadata?.source).toBe(scriptPath)
        expect(metadata?.scriptPath).toBe(scriptPath)
        expect(metadata?.codePreview).toBe(scriptSource)
        expect(metadata?.codePreviewTruncated).toBeFalse()
      })
    })

    it("does not ask external_directory when script is inside worktree", async () => {
      await withWorkspace(async ({ worktree }) => {
        const scriptPath = path.join(worktree, "inside.py")
        await writeFile(scriptPath, "print('ok')\n", "utf8")

        const context = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            scriptPath,
            args: [],
            description: "inside script",
          },
          context,
        )

        expect(getAsk(context, "external_directory")).toBeUndefined()
      })
    })

    it("does not ask external_directory when a symlinked script still resolves inside the worktree", async () => {
      await withWorkspace(async ({ worktree }) => {
        const realScript = path.join(worktree, "real.py")
        await writeFile(realScript, "print('ok')\n", "utf8")
        const scriptPath = path.join(worktree, "inside-link.py")
        await symlink(realScript, scriptPath)

        const context = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            scriptPath,
            args: [],
            description: "inside symlink script",
          },
          context,
        )

        expect(getAsk(context, "external_directory")).toBeUndefined()
      })
    })

    it("asks external_directory when script path is outside worktree", async () => {
      await withWorkspace(async ({ root, worktree }) => {
        const scriptPath = path.join(root, "outside.py")
        await writeFile(scriptPath, "print('outside')\n", "utf8")

        const context = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            scriptPath,
            args: [],
            description: "outside script",
          },
          context,
        )

        const ask = getAsk(context, "external_directory")
        expect(ask?.patterns).toContain(`${toSlash(path.dirname(scriptPath))}/*`)
        const metadata = getAskMetadata(context, "external_directory")
        expect(metadata?.mode).toBe("script")
        expect(metadata?.source).toBe(scriptPath)
        expect(metadata?.scriptPath).toBe(scriptPath)
        expect(metadata?.codePreview).toBeUndefined()
      })
    })

    it("asks external_directory before reading a symlinked outside script path", async () => {
      await withWorkspace(async ({ root, worktree }) => {
        const outsideDir = path.join(root, "outside")
        await mkdir(outsideDir, { recursive: true })
        const realScript = path.join(outsideDir, "outside.py")
        await writeFile(realScript, "print('outside')\n", "utf8")

        const scriptPath = path.join(worktree, "outside-link.py")
        await symlink(realScript, scriptPath)

        const context = createMockContext({ worktree, directory: worktree })
        const previous = process.env.OPENCODE_PYTHON_BIN
        process.env.OPENCODE_PYTHON_BIN = INVALID_PYTHON_BIN
        context.ask = async (input) => {
          context.asks.push(input)
          if (input.permission === "external_directory") {
            expect((input.metadata as { codePreview?: string } | undefined)?.codePreview).toBeUndefined()
            await rm(realScript, { force: true })
          }
        }

        try {
          await expect(
            pythonTool.execute(
              {
                scriptPath,
                args: [],
                description: "symlink outside script",
              },
              context,
            ),
          ).rejects.toThrow(`Python script file not found: ${scriptPath}`)
        } finally {
          if (previous === undefined) delete process.env.OPENCODE_PYTHON_BIN
          else process.env.OPENCODE_PYTHON_BIN = previous
        }

        const ask = getAsk(context, "external_directory")
        expect(ask?.patterns).toContain(`${toSlash(outsideDir)}/*`)
        expect(getAsk(context, "python")).toBeUndefined()
        expect(context.metadatas).toHaveLength(0)
      })
    })

    it("asks external_directory for script paths that escape through symlink plus dotdot", async () => {
      await withWorkspace(async ({ root, worktree }) => {
        const outside = path.join(root, "outside")
        const nested = path.join(outside, "nested")
        await mkdir(nested, { recursive: true })
        await writeFile(path.join(outside, "outside.py"), "print('outside')\n", "utf8")
        await symlink(nested, path.join(worktree, "outside-link"))

        const context = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            scriptPath: "outside-link/../outside.py",
            args: [],
            description: "symlink dotdot outside script",
          },
          context,
        )

        const ask = getAsk(context, "external_directory")
        expect(ask?.patterns).toContain(`${toSlash(outside)}/*`)
        expect(getAsk(context, "python")).toBeUndefined()
      })
    })

    it("falls back conservatively to external_directory when script boundary resolution fails", async () => {
      await withWorkspace(async ({ worktree }) => {
        const scriptPath = path.join(worktree, "loop.py")
        await symlink("loop.py", scriptPath)

        const context = createMockContext({ worktree, directory: worktree })
        context.ask = async (input) => {
          context.asks.push(input)
          if (input.permission === "external_directory") throw new Error("script fallback ask")
        }

        await expect(
          pythonTool.execute(
            {
              scriptPath,
              args: [],
              description: "script fallback ask",
            },
            context,
          ),
        ).rejects.toThrow("script fallback ask")

        const ask = getAsk(context, "external_directory")
        expect(ask?.patterns).toContain(`${toSlash(worktree)}/*`)
        expect(getAsk(context, "python")).toBeUndefined()
      })
    })

    it("falls back conservatively to external_directory when script boundary resolution hits ENOTDIR", async () => {
      await withWorkspace(async ({ worktree }) => {
        const notDir = path.join(worktree, "not-dir")
        await writeFile(notDir, "x\n", "utf8")

        const context = createMockContext({ worktree, directory: worktree })
        context.ask = async (input) => {
          context.asks.push(input)
          if (input.permission === "external_directory") throw new Error("script enotdir ask")
        }

        await expect(
          pythonTool.execute(
            {
              scriptPath: "not-dir/child.py",
              args: [],
              description: "script enotdir ask",
            },
            context,
          ),
        ).rejects.toThrow("script enotdir ask")

        const ask = getAsk(context, "external_directory")
        expect(ask?.patterns).toContain(`${toSlash(notDir)}/*`)
        expect(getAsk(context, "python")).toBeUndefined()
      })
    })

    it("asks external_directory for literal outside paths in script", async () => {
      await withWorkspace(async ({ worktree }) => {
        const scriptPath = path.join(worktree, "reads-outside.py")
        await writeFile(scriptPath, "open('/tmp/outside.txt', 'r')\n", "utf8")

        const context = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            scriptPath,
            args: [],
            description: "outside literal in script",
          },
          context,
        )

        const ask = getAsk(context, "external_directory")
        expect(ask?.patterns).toContain("/tmp/*")
      })
    })
  })

  describe("external directory detection", () => {
    it("reuses permission code preview metadata in external_directory ask", async () => {
      await withWorkspace(async ({ worktree }) => {
        const source = "open('/tmp/outside.txt', 'r')\n"
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: source,
            args: [],
            description: "external preview metadata",
          },
          context,
        )

        const externalMetadata = getAskMetadata(context, "external_directory")

        expect(getAsk(context, "python")).toBeUndefined()
        expect(externalMetadata?.mode).toBe("inline")
        expect(externalMetadata?.source).toBe("<inline>")
        expect(externalMetadata?.codePreview).toBe(source)
        expect(externalMetadata?.codePreviewTruncated).toBeFalse()
        expect(externalMetadata?.codePreviewBytes).toEqual({ total: source.length, preview: source.length })
        expect(externalMetadata?.codePreviewLines).toEqual({ total: 2, preview: 2 })
        expect(externalMetadata?.codeExpanded).toBeUndefined()
        expect(externalMetadata?.codeExpandedAvailable).toBeUndefined()
      })
    })

    it("asks when workdir is outside worktree", async () => {
      await withWorkspace(async ({ root, worktree }) => {
        const outside = path.join(root, "outside")
        await mkdir(outside, { recursive: true })

        const context = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "open('data.txt', 'r')",
            workdir: outside,
            args: [],
            description: "outside workdir",
          },
          context,
        )

        const ask = getAsk(context, "external_directory")
        expect(ask?.patterns).toContain(`${toSlash(outside)}/*`)
        expect(getAsk(context, "python")).toBeUndefined()
      })
    })

    it("asks external_directory when workdir is a symlink into an outside directory", async () => {
      await withWorkspace(async ({ root, worktree }) => {
        const outside = path.join(root, "outside")
        await mkdir(outside, { recursive: true })
        const symlinked = path.join(worktree, "linked-outside")
        await symlink(outside, symlinked)

        const context = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "open('data.txt', 'r')",
            workdir: "linked-outside",
            args: [],
            description: "symlinked outside workdir",
          },
          context,
        )

        const ask = getAsk(context, "external_directory")
        expect(ask?.patterns).toContain(`${toSlash(outside)}/*`)
        expect(getAsk(context, "python")).toBeUndefined()
      })
    })

    it("asks external_directory when workdir escapes through symlink plus dotdot", async () => {
      await withWorkspace(async ({ root, worktree }) => {
        const outside = path.join(root, "outside")
        const nested = path.join(outside, "nested")
        await mkdir(nested, { recursive: true })
        await symlink(nested, path.join(worktree, "outside-link"))

        const context = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "open('secret.txt', 'r')",
            workdir: "outside-link/..",
            args: [],
            description: "symlink dotdot outside workdir",
          },
          context,
        )

        const ask = getAsk(context, "external_directory")
        expect(ask?.patterns).toContain(`${toSlash(outside)}/*`)
        expect(getAsk(context, "python")).toBeUndefined()
      })
    })

    it("falls back conservatively to external_directory when workdir boundary resolution fails", async () => {
      await withWorkspace(async ({ worktree }) => {
        const loop = path.join(worktree, "loop")
        await symlink("loop", loop)

        const context = createMockContext({ worktree, directory: worktree })
        context.ask = async (input) => {
          context.asks.push(input)
          if (input.permission === "external_directory") throw new Error("workdir fallback ask")
        }

        await expect(
          pythonTool.execute(
            {
              code: "open('data.txt', 'r')",
              workdir: "loop",
              args: [],
              description: "workdir fallback ask",
            },
            context,
          ),
        ).rejects.toThrow("workdir fallback ask")

        const ask = getAsk(context, "external_directory")
        expect(ask?.patterns).toContain(`${toSlash(path.join(worktree, "loop"))}/*`)
        expect(getAsk(context, "python")).toBeUndefined()
      })
    })

    it("falls back conservatively to external_directory when workdir boundary resolution hits ENOTDIR", async () => {
      await withWorkspace(async ({ worktree }) => {
        const notDir = path.join(worktree, "not-dir")
        await writeFile(notDir, "x\n", "utf8")

        const context = createMockContext({ worktree, directory: worktree })
        context.ask = async (input) => {
          context.asks.push(input)
          if (input.permission === "external_directory") throw new Error("workdir enotdir ask")
        }

        await expect(
          pythonTool.execute(
            {
              code: "open('data.txt', 'r')",
              workdir: "not-dir/child",
              args: [],
              description: "workdir enotdir ask",
            },
            context,
          ),
        ).rejects.toThrow("workdir enotdir ask")

        const ask = getAsk(context, "external_directory")
        expect(ask?.patterns).toContain(`${toSlash(path.join(worktree, "not-dir", "child"))}/*`)
        expect(getAsk(context, "python")).toBeUndefined()
      })
    })

    it("asks external_directory without python ask for emit-only outside workdir", async () => {
      await withWorkspace(async ({ root, worktree }) => {
        const outside = path.join(root, "outside")
        await mkdir(outside, { recursive: true })

        const context = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "print('outside')",
            workdir: outside,
            args: [],
            description: "emit outside workdir",
          },
          context,
        )

        const externalAsk = getAsk(context, "external_directory")
        expect(externalAsk?.patterns).toContain(`${toSlash(outside)}/*`)
        expect(getAsk(context, "python")).toBeUndefined()

        const metadata = context.metadatas[0]?.metadata
        expect(metadata?.operations).toEqual(
          expect.arrayContaining([expect.objectContaining({ kind: "emit", call: "print" })]),
        )
      })
    })

    it("does not ask external_directory when workdir is inside worktree", async () => {
      await withWorkspace(async ({ worktree }) => {
        const inside = path.join(worktree, "inside")
        await mkdir(inside, { recursive: true })

        const context = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "open('data.txt', 'r')",
            workdir: inside,
            args: [],
            description: "inside workdir",
          },
          context,
        )

        expect(getAsk(context, "external_directory")).toBeUndefined()
      })
    })

    it("does not ask external_directory when a symlinked workdir still resolves inside the worktree", async () => {
      await withWorkspace(async ({ worktree }) => {
        const inside = path.join(worktree, "inside-target")
        await mkdir(inside, { recursive: true })
        const symlinked = path.join(worktree, "inside-link")
        await symlink(inside, symlinked)

        const context = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "open('data.txt', 'r')",
            workdir: "inside-link",
            args: [],
            description: "symlinked inside workdir",
          },
          context,
        )

        expect(getAsk(context, "external_directory")).toBeUndefined()
        expect(getAsk(context, "python")).toBeUndefined()
      })
    })

    it("asks external_directory for inline literal outside path", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "open('/tmp/outside.txt', 'r')",
            args: [],
            description: "inline outside path",
          },
          context,
        )

        const ask = getAsk(context, "external_directory")
        expect(ask?.patterns).toContain("/tmp/*")
        expect(getAsk(context, "python")).toBeUndefined()
      })
    })

    it("does not ask external_directory for literal reads through an in-worktree symlink that stays inside", async () => {
      await withWorkspace(async ({ worktree }) => {
        const inside = path.join(worktree, "nested")
        await mkdir(inside, { recursive: true })
        await writeFile(path.join(inside, "secret.txt"), "ok\n", "utf8")
        const link = path.join(worktree, "inside-link")
        await symlink(inside, link)

        const context = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "open('inside-link/secret.txt', 'r')",
            args: [],
            description: "symlinked inside read",
          },
          context,
        )

        expect(getAsk(context, "external_directory")).toBeUndefined()
        expect(getAsk(context, "python")).toBeUndefined()
      })
    })

    it("asks external_directory for literal reads through an in-worktree symlink to outside", async () => {
      await withWorkspace(async ({ root, worktree }) => {
        const outside = path.join(root, "outside")
        await mkdir(outside, { recursive: true })
        await writeFile(path.join(outside, "secret.txt"), "shh\n", "utf8")
        const link = path.join(worktree, "outside-link")
        await symlink(outside, link)

        const context = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "open('outside-link/secret.txt', 'r')",
            args: [],
            description: "symlinked outside read",
          },
          context,
        )

        const ask = getAsk(context, "external_directory")
        expect(ask?.patterns).toContain(`${toSlash(outside)}/*`)
        expect(getAsk(context, "python")).toBeUndefined()
      })
    })

    it("asks external_directory for symlink plus dotdot literal reads that resolve outside the worktree", async () => {
      await withWorkspace(async ({ root, worktree }) => {
        const outside = path.join(root, "outside")
        const nested = path.join(outside, "nested")
        await mkdir(nested, { recursive: true })
        await writeFile(path.join(outside, "secret.txt"), "shh\n", "utf8")
        const link = path.join(worktree, "outside-link")
        await symlink(nested, link)

        const context = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "open('outside-link/../secret.txt', 'r')",
            args: [],
            description: "symlink dotdot outside read",
          },
          context,
        )

        const ask = getAsk(context, "external_directory")
        expect(ask?.patterns).toContain(`${toSlash(outside)}/*`)
        expect(getAsk(context, "python")).toBeUndefined()
      })
    })

    it("falls back conservatively to external_directory on boundary-resolution errors", async () => {
      await withWorkspace(async ({ worktree }) => {
        await symlink("loop", path.join(worktree, "loop"))

        const context = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "open('loop/file.txt', 'r')",
            args: [],
            description: "boundary fallback read",
          },
          context,
        )

        const ask = getAsk(context, "external_directory")
        expect(ask?.patterns).toContain(`${toSlash(path.join(worktree, "loop"))}/*`)
        expect(getAsk(context, "python")).toBeUndefined()
      })
    })

    it("falls back conservatively to external_directory for literal reads when boundary resolution hits ENOTDIR", async () => {
      await withWorkspace(async ({ worktree }) => {
        const notDir = path.join(worktree, "not-dir")
        await writeFile(notDir, "x\n", "utf8")

        const context = createMockContext({ worktree, directory: worktree })
        await executeExpectingEnoent(
          {
            code: "open('not-dir/child.txt', 'r')",
            args: [],
            description: "literal enotdir fallback",
          },
          context,
        )

        const ask = getAsk(context, "external_directory")
        expect(ask?.patterns).toContain(`${toSlash(notDir)}/*`)
        expect(getAsk(context, "python")).toBeUndefined()
      })
    })
  })

  describe("always pattern checks", () => {
    it("includes read wildcard for dynamic read paths", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "target = 'f.txt'\nopen(target, 'r')",
            args: [],
            description: "always read",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.always).toContain("read:*")
      })
    })

    it("includes exec module wildcard", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "import os\nos.execvp('echo', ['echo', 'ok'])",
            args: [],
            description: "always exec",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.always).toContain("exec:os.*")
      })
    })

    it("includes callable unknown specific always pattern", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "mypkg.do_thing()",
            args: [],
            description: "always callable unknown",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.always).toContain("unknown:callable:mypkg.do_thing")
      })
    })

    it("uses unknown:* for parser/meta unknown events", async () => {
      await withWorkspace(async ({ worktree }) => {
        const context = createMockContext({ worktree, directory: worktree })

        await executeExpectingEnoent(
          {
            code: "def broken(:\n    pass",
            args: [],
            description: "always parser unknown",
          },
          context,
        )

        const ask = getAsk(context, "python")
        expect(ask?.patterns).toContain("unknown:parse-error")
        expect(ask?.always).toContain("unknown:*")
      })
    })
  })

})
