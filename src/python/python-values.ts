export type PythonValue = {
  literal?: string
  dynamic: boolean
}

export type PythonArgs = {
  positional: PythonValue[]
  keyword: Record<string, PythonValue>
}
