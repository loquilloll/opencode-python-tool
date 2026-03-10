import { access } from "fs/promises"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import type { PythonAstFrontend } from "./interface"

type Parser = {
  parse(input: string): ReturnType<PythonAstFrontend["parse"]>
  setLanguage(language: unknown): void
}

type ParserCtor = {
  new (): Parser
  init(input: { locateFile(): string }): Promise<void>
}

type LanguageCtor = {
  load(input: string): Promise<unknown>
}

let frontend: Promise<PythonAstFrontend> | undefined

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

const resolveNodeModules = async () => {
  const dir = fileURLToPath(new URL(".", import.meta.url))
  const candidates = [
    path.resolve(dir, "..", "..", "..", ".opencode", "node_modules"),
    path.resolve(dir, "..", "..", "..", "node_modules"),
  ]
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true, () => false)) return candidate
  }
  return candidates[0]
}

async function createFrontend(): Promise<PythonAstFrontend> {
  const modules = await resolveNodeModules()
  const tree = (await import(pathToFileURL(path.join(modules, "web-tree-sitter/tree-sitter.js")).href)) as unknown as {
    Parser: ParserCtor
    Language: LanguageCtor
  }
  const treeWasm = (await import(pathToFileURL(path.join(modules, "web-tree-sitter/tree-sitter.wasm")).href, {
    with: { type: "wasm" },
  })) as { default: string }
  await tree.Parser.init({
    locateFile() {
      return resolveWasm(treeWasm.default)
    },
  })
  const pythonWasm = (await import(pathToFileURL(path.join(modules, "tree-sitter-python/tree-sitter-python.wasm")).href, {
    with: { type: "wasm" },
  })) as { default: string }
  const language = await tree.Language.load(resolveWasm(pythonWasm.default))
  const parser = new tree.Parser()
  parser.setLanguage(language)
  return parser
}

export async function getPythonAstFrontend() {
  if (frontend) return frontend
  frontend = createFrontend().catch((error) => {
    frontend = undefined
    throw error
  })
  return frontend
}
