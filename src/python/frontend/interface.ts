export type PythonAstNode = {
  type: string
  text: string
  hasError: boolean
  startIndex: number
  endIndex: number
  namedChildren: PythonAstNode[]
  childForFieldName(name: string): PythonAstNode | null
  descendantsOfType(type: string): PythonAstNode[]
}

export type PythonAstTree = {
  rootNode: PythonAstNode
}

export type PythonAstFrontend = {
  parse(input: string): PythonAstTree | null
}
