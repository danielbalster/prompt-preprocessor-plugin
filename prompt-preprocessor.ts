import type { Plugin } from "@kilocode/plugin"

function expandEnvVars(text: string): string {
  return text.replace(/\$\{(\w+)\}/g, (match, name) => {
    const value = process.env[name]
    return value !== undefined ? value : match
  })
}

// ── conditional preprocessor: helpers ─────────────────────────────────

interface CondFrame {
  branchTaken: boolean
  skipChildren: boolean
}

function resolveVar(name: string): string {
  return process.env[name] ?? ""
}

function isVarDefined(name: string): boolean {
  return Object.hasOwn(process.env, name)
}

function isVarTruthy(name: string): boolean {
  const v = process.env[name]
  return v !== undefined && v !== ""
}

// ── include resolution ──────────────────────────────────────────────

const RE_INCLUDE = /^\s*\.include\s+"([^"\n]+)"\s*$/
const MAX_INCLUDE_DEPTH = 10

function isURL(path: string): boolean {
  return path.startsWith("http://") || path.startsWith("https://")
}

async function readPath(path: string): Promise<string> {
  if (isURL(path)) {
    const res = await fetch(path)
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`)
    }
    return await res.text()
  }
  const file = Bun.file(path)
  if (!(await file.exists())) {
    throw new Error(`file not found: ${path}`)
  }
  return await file.text()
}

async function resolveIncludes(
  text: string,
  stack: string[],
  depth: number,
): Promise<string> {
  if (depth > MAX_INCLUDE_DEPTH) {
    throw new Error(
      `max include depth (${MAX_INCLUDE_DEPTH}) exceeded while resolving ` +
      `.include "${stack[stack.length - 1] ?? "(root)"}"`,
    )
  }

  const lines = text.split("\n")
  const out: string[] = []

  for (const line of lines) {
    const m = line.match(RE_INCLUDE)
    if (!m) {
      out.push(line)
      continue
    }

    const path = m[1]!

    if (stack.includes(path)) {
      const chain = [...stack, path].join(" → ")
      throw new Error(`circular include detected: ${chain}`)
    }

    try {
      const content = await readPath(path)
      const resolved = await resolveIncludes(content, [...stack, path], depth + 1)
      out.push(resolved.replace(/\n+$/, ""))
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("prompt-preprocessor:")) {
        throw err
      }
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`prompt-preprocessor: .include "${path}" failed — ${msg}`)
    }
  }

  return out.join("\n")
}

// ── conditional preprocessor: expression parser ───────────────────────

// Grammar:
//   expr       := or_expr
//   or_expr    := and_expr ("||" and_expr)*
//   and_expr   := unary ("&&" unary)*
//   unary      := "!" unary | primary
//   primary    := "(" expr ")" | "$" ID (OP value)?   (*)
//
// (*) when OP is absent, the expression evaluates to isVarTruthy(ID).

type TokenType =
  | "VAR"    // $identifier
  | "OP"     // == != >= <= > < ~
  | "STR"    // "…"
  | "NUM"    // unquoted token (number or bare word)
  | "NOT"    // !
  | "AND"    // &&
  | "OR"     // ||
  | "LP"     // (
  | "RP"     // )
  | "EOF"

interface Token {
  type: TokenType
  value: string
}

const TOKEN_RE =
  /(\$\w+)|(>=|<=|!=|==|>|<|~)|(&&)|(\|\|)|([!()])|("(?:[^"\\]|\\.)*")|(\S+)/g

function tokenize(expr: string): Token[] {
  const tokens: Token[] = []
  // defensive copy — a /g regex shared across calls would cache lastIndex
  const re = new RegExp(TOKEN_RE.source, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(expr)) !== null) {
    if (m[1]) tokens.push({ type: "VAR", value: m[1] })
    else if (m[2]) tokens.push({ type: "OP", value: m[2] })
    else if (m[3]) tokens.push({ type: "AND", value: m[3] })
    else if (m[4]) tokens.push({ type: "OR", value: m[4] })
    else if (m[5] === "!") tokens.push({ type: "NOT", value: m[5] })
    else if (m[5] === "(") tokens.push({ type: "LP", value: m[5] })
    else if (m[5] === ")") tokens.push({ type: "RP", value: m[5] })
    else if (m[6]) tokens.push({ type: "STR", value: m[6] })
    else if (m[7]) tokens.push({ type: "NUM", value: m[7] })
  }
  tokens.push({ type: "EOF", value: "" })
  return tokens
}

class ExprParser {
  private tokens: Token[]
  private pos: number

  constructor(tokens: Token[]) {
    this.tokens = tokens
    this.pos = 0
  }

  private peek(): Token {
    return this.tokens[this.pos]!
  }

  private advance(): Token {
    return this.tokens[this.pos++]!
  }

  private describeToken(t: Token): string {
    switch (t.type) {
      case "EOF": return "end of expression"
      case "VAR": return `"${t.value}"`
      case "OP": return `"${t.value}"`
      case "STR": return t.value
      case "NUM": return `"${t.value}"`
      case "NOT": return '"!"'
      case "AND": return '"&&"'
      case "OR": return '"||"'
      case "LP": return '"("'
      case "RP": return '")"'
      default: return `"${t.value}"`
    }
  }

  parse(): boolean {
    const result = this.parseOr()
    if (this.peek().type !== "EOF") {
      throw new Error(
        `prompt-preprocessor: unexpected ${this.describeToken(this.peek())} after expression`,
      )
    }
    return result
  }

  private parseOr(): boolean {
    let left = this.parseAnd()
    while (this.peek().type === "OR") {
      this.advance()
      // pre-evaluate to avoid JS || short-circuit skipping token consumption
      const r = this.parseAnd()
      left = left || r
    }
    return left
  }

  private parseAnd(): boolean {
    let left = this.parseUnary()
    while (this.peek().type === "AND") {
      this.advance()
      // pre-evaluate to avoid JS && short-circuit skipping token consumption
      const r = this.parseUnary()
      left = left && r
    }
    return left
  }

  private parseUnary(): boolean {
    if (this.peek().type === "NOT") {
      this.advance()
      return !this.parseUnary()
    }
    return this.parsePrimary()
  }

  private parsePrimary(): boolean {
    if (this.peek().type === "LP") {
      this.advance() // (
      const result = this.parseOr()
      if (this.peek().type !== "RP") {
        throw new Error(
          `prompt-preprocessor: expected ')' but got ${this.describeToken(this.peek())}`,
        )
      }
      this.advance() // )
      return result
    }

    if (this.peek().type === "VAR") {
      const varName = this.advance().value.slice(1) // strip $

      if (this.peek().type === "OP") {
        const op = this.advance().value
        const vt = this.peek()
        if (vt.type !== "STR" && vt.type !== "NUM") {
          throw new Error(
            `prompt-preprocessor: expected value after "${op}" but got ${this.describeToken(vt)}`,
          )
        }
        this.advance()
        return this.evalComparison(varName, op, vt)
      }

      return isVarTruthy(varName)
    }

    throw new Error(
      `prompt-preprocessor: unexpected ${this.describeToken(this.peek())} in expression, expected $VAR or '('`,
    )
  }

  private evalComparison(
    varName: string,
    op: string,
    valueToken: Token,
  ): boolean {
    const envVal = resolveVar(varName)
    const isQuoted = valueToken.type === "STR"
    const value = isQuoted
      ? valueToken.value.slice(1, -1)
      : valueToken.value

    switch (op) {
      case "==":
      case "!=": {
        const eq = op === "=="
        if (isQuoted) return eq ? envVal === value : envVal !== value
        const n1 = parseFloat(envVal)
        const n2 = parseFloat(value)
        if (isNaN(n1) || isNaN(n2))
          return eq ? envVal === value : envVal !== value
        return eq ? n1 === n2 : n1 !== n2
      }
      case ">":
        return parseFloat(envVal) > parseFloat(value)
      case "<":
        return parseFloat(envVal) < parseFloat(value)
      case ">=":
        return parseFloat(envVal) >= parseFloat(value)
      case "<=":
        return parseFloat(envVal) <= parseFloat(value)
      case "~":
        return envVal.includes(value)
      default:
        return false
    }
  }
}

function evaluateExpression(expr: string): boolean {
  const trimmed = expr.trim()
  if (!trimmed) return false
  const tokens = tokenize(trimmed)
  return new ExprParser(tokens).parse()
}

// ── conditional preprocessor: line-by-line engine ─────────────────────

const RE_DIRECTIVE =
  /^\s*\.(ifndef|elifndef|ifdef|elifdef|if|elif|else|endif)(?:\s+(.*))?\s*$/
const RE_VAR_ONLY = /^\$(\w+)$/

function preprocessConditionals(text: string): string {
  const lines = text.split("\n")
  const out: string[] = []
  const stack: CondFrame[] = []

  const isSkipping = () => stack.some((f) => f.skipChildren)

  for (const rawLine of lines) {
    const m = rawLine.match(RE_DIRECTIVE)
    if (!m) {
      if (!isSkipping()) out.push(rawLine)
      continue
    }

    const directive = m[1]!
    const rest = m[2] ?? ""

    switch (directive) {
      case "if":
      case "ifdef":
      case "ifndef": {
        let cond: boolean
        if (directive === "ifdef") {
          const vo = rest.match(RE_VAR_ONLY)
          cond = vo ? isVarDefined(vo[1]!) : false
        } else if (directive === "ifndef") {
          const vo = rest.match(RE_VAR_ONLY)
          cond = vo ? !isVarDefined(vo[1]!) : false
        } else {
          cond = evaluateExpression(rest)
        }
        if (isSkipping()) {
          stack.push({ branchTaken: false, skipChildren: true })
        } else if (cond) {
          stack.push({ branchTaken: true, skipChildren: false })
        } else {
          stack.push({ branchTaken: false, skipChildren: true })
        }
        break
      }

      case "elif":
      case "elifdef":
      case "elifndef": {
        if (stack.length === 0) {
          throw new Error(
            `prompt-preprocessor: .${directive} without matching .if: ${rawLine.trim()}`,
          )
        }
        const prev = stack.pop()!

        if (prev.branchTaken) {
          stack.push({ branchTaken: true, skipChildren: true })
        } else if (isSkipping()) {
          stack.push({ branchTaken: false, skipChildren: true })
        } else {
          let cond: boolean
          if (directive === "elifdef") {
            const vo = rest.match(RE_VAR_ONLY)
            cond = vo ? isVarDefined(vo[1]!) : false
          } else if (directive === "elifndef") {
            const vo = rest.match(RE_VAR_ONLY)
            cond = vo ? !isVarDefined(vo[1]!) : false
          } else {
            cond = evaluateExpression(rest)
          }
          stack.push({ branchTaken: cond, skipChildren: !cond })
        }
        break
      }

      case "else": {
        if (stack.length === 0) {
          throw new Error(
            `prompt-preprocessor: .else without matching .if: ${rawLine.trim()}`,
          )
        }
        const prev = stack.pop()!

        if (prev.branchTaken) {
          stack.push({ branchTaken: true, skipChildren: true })
        } else if (isSkipping()) {
          stack.push({ branchTaken: true, skipChildren: true })
        } else {
          stack.push({ branchTaken: true, skipChildren: false })
        }
        break
      }

      case "endif": {
        if (stack.length === 0) {
          throw new Error(
            `prompt-preprocessor: .endif without matching .if: ${rawLine.trim()}`,
          )
        }
        stack.pop()
        break
      }
    }
  }

  if (stack.length > 0) {
    throw new Error(
      `prompt-preprocessor: ${stack.length} unclosed .if block(s) at end of input`,
    )
  }

  return out.join("\n")
}

// ── plugin ────────────────────────────────────────────────────────────

const PromptPreprocessor: Plugin = async () => ({
  "experimental.chat.system.transform": async (_input, output) => {
    for (let i = 0; i < output.system.length; i++) {
      const included = await resolveIncludes(output.system[i], [], 0)
      const expanded = expandEnvVars(included)
      output.system[i] = preprocessConditionals(expanded)
    }
  },
})

export default PromptPreprocessor
