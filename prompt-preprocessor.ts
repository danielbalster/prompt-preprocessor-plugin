import type { Plugin } from "@kilocode/plugin"
import { existsSync } from "fs"
import { resolve, isAbsolute } from "path"
import { spawnSync } from "child_process"

let workspaceDir = ""

function resolvePath(p: string): string {
  return isAbsolute(p) ? p : resolve(workspaceDir, p)
}

function expandEnvVars(text: string): string {
  return text.replace(/\$\{(\w+)(?::([^}]*))?\}/g, (match, name, defaultValue) => {
    const value = process.env[name]
    if (value !== undefined) return value
    if (defaultValue !== undefined) return defaultValue
    return match
  })
}

function processErrors(text: string): string {
  const re = /^\s*!error\s+(.*)\s*$/
  const lines = text.split("\n")
  const out: string[] = []
  for (const line of lines) {
    const m = line.match(re)
    if (m) throw new Error(`prompt-preprocessor: ${m[1]}`)
    out.push(line)
  }
  return out.join("\n")
}

function processDefines(text: string): string {
  const re = /^\s*!define\s+(\w+)\s+(.+)$/
  const lines = text.split("\n")
  const out: string[] = []
  for (const line of lines) {
    const m = line.match(re)
    if (m) {
      let value = m[2]!.trim()
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
      process.env[m[1]!] = value
      continue
    }
    out.push(line)
  }
  return out.join("\n")
}

async function processShellDirectives(text: string): Promise<string> {
  const re = /^\s*!shell\s*(>1|>2|>)?\s+(.+)$/
  const lines = text.split("\n")
  const out: string[] = []
  for (const line of lines) {
    const m = line.match(re)
    if (!m) { out.push(line); continue }
    const redirect = m[1] ?? ""
    const command = m[2]!
    const result = spawnSync("sh", ["-c", command], { encoding: "utf-8" })
    const stdout = (result.stdout ?? "").replace(/\n+$/, "")
    const stderr = (result.stderr ?? "").replace(/\n+$/, "")
    if (redirect === ">1") out.push(stdout)
    else if (redirect === ">2") out.push(stderr)
    else if (redirect === ">") {
      const combined = [stdout, stderr].filter(Boolean).join("\n")
      if (combined) out.push(combined)
    }
  }
  return out.join("\n")
}

interface CondFrame { branchTaken: boolean; skipChildren: boolean }

function resolveVar(name: string): string { return process.env[name] ?? "" }
function isVarDefined(name: string): boolean { return Object.hasOwn(process.env, name) }
function isVarTruthy(name: string): boolean {
  const v = process.env[name]
  return v !== undefined && v !== ""
}

const RE_INCLUDE = /^\s*!include\s+"([^"\n]+)"\s*$/
const MAX_INCLUDE_DEPTH = 10

function isURL(p: string): boolean { return p.startsWith("http://") || p.startsWith("https://") }

async function readPath(path: string): Promise<string> {
  if (isURL(path)) {
    const res = await fetch(path)
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    return await res.text()
  }
  const file = Bun.file(resolvePath(path))
  if (!(await file.exists())) throw new Error(`file not found: ${path}`)
  return await file.text()
}

async function resolveIncludes(text: string, stack: string[], depth: number): Promise<string> {
  if (depth > MAX_INCLUDE_DEPTH)
    throw new Error(`max include depth (${MAX_INCLUDE_DEPTH}) exceeded while resolving !include "${stack[stack.length - 1] ?? "(root)"}"`)
  const lines = text.split("\n")
  const out: string[] = []
  for (const line of lines) {
    const m = line.match(RE_INCLUDE)
    if (!m) { out.push(line); continue }
    const path = m[1]!
    if (stack.includes(path)) throw new Error(`circular include detected: ${[...stack, path].join(" → ")}`)
    try {
      const content = await readPath(path)
      const resolved = await resolveIncludes(content, [...stack, path], depth + 1)
      out.push(resolved.replace(/\n+$/, ""))
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("prompt-preprocessor:")) throw err
      throw new Error(`prompt-preprocessor: !include "${path}" failed — ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return out.join("\n")
}

type TokenType = "VAR" | "OP" | "STR" | "NUM" | "NOT" | "AND" | "OR" | "LP" | "RP" | "DEFINED" | "EXISTS" | "EOF"
interface Token { type: TokenType; value: string }

const TOKEN_RE = /(defined\()|(exists\()|(>=|<=|!=|==|>|<|~)|(&&)|(\|\|)|([!()])|(\w+)|("(?:[^"\\]|\\.)*")|(\S+)/g

function tokenize(expr: string): Token[] {
  const tokens: Token[] = []
  const re = new RegExp(TOKEN_RE.source, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(expr)) !== null) {
    if (m[1]) tokens.push({ type: "DEFINED", value: m[1] })
    else if (m[2]) tokens.push({ type: "EXISTS", value: m[2] })
    else if (m[3]) tokens.push({ type: "OP", value: m[3] })
    else if (m[4]) tokens.push({ type: "AND", value: m[4] })
    else if (m[5]) tokens.push({ type: "OR", value: m[5] })
    else if (m[6] === "!") tokens.push({ type: "NOT", value: m[6] })
    else if (m[6] === "(") tokens.push({ type: "LP", value: m[6] })
    else if (m[6] === ")") tokens.push({ type: "RP", value: m[6] })
    else if (m[7]) tokens.push({ type: "VAR", value: m[7] })
    else if (m[8]) tokens.push({ type: "STR", value: m[8] })
    else if (m[9]) tokens.push({ type: "NUM", value: m[9] })
  }
  tokens.push({ type: "EOF", value: "" })
  return tokens
}

class ExprParser {
  private tokens: Token[]; private pos: number
  constructor(t: Token[]) { this.tokens = t; this.pos = 0 }
  private peek(): Token { return this.tokens[this.pos]! }
  private advance(): Token { return this.tokens[this.pos++]! }
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
      case "DEFINED": return '"defined("'
      case "EXISTS": return '"exists("'
      default: return `"${t.value}"`
    }
  }

  parse(): boolean {
    const result = this.parseOr()
    if (this.peek().type !== "EOF") throw new Error(`prompt-preprocessor: unexpected ${this.describeToken(this.peek())} after expression`)
    return result
  }

  private parseOr(): boolean {
    let left = this.parseAnd()
    while (this.peek().type === "OR") { this.advance(); const r = this.parseAnd(); left = left || r }
    return left
  }

  private parseAnd(): boolean {
    let left = this.parseUnary()
    while (this.peek().type === "AND") { this.advance(); const r = this.parseUnary(); left = left && r }
    return left
  }

  private parseUnary(): boolean {
    if (this.peek().type === "NOT") { this.advance(); return !this.parseUnary() }
    return this.parsePrimary()
  }

  private parsePrimary(): boolean {
    if (this.peek().type === "LP") {
      this.advance()
      const result = this.parseOr()
      if (this.peek().type !== "RP") throw new Error(`prompt-preprocessor: expected ')' but got ${this.describeToken(this.peek())}`)
      this.advance()
      return result
    }
    if (this.peek().type === "DEFINED") {
      this.advance()
      const vt = this.peek()
      if (vt.type !== "VAR") throw new Error(`prompt-preprocessor: expected variable name after defined( but got ${this.describeToken(vt)}`)
      const varName = this.advance().value
      if (this.peek().type !== "RP") throw new Error(`prompt-preprocessor: expected ')' after defined(${varName} but got ${this.describeToken(this.peek())}`)
      this.advance()
      return isVarDefined(varName)
    }
    if (this.peek().type === "EXISTS") {
      this.advance()
      const vt = this.peek()
      if (vt.type !== "STR") {
        if (vt.type === "NUM" && vt.value.startsWith('"')) throw new Error(`prompt-preprocessor: unclosed string literal: ${vt.value}`)
        throw new Error(`prompt-preprocessor: expected path string after exists( but got ${this.describeToken(vt)}`)
      }
      const path = this.advance().value.slice(1, -1)
      if (this.peek().type !== "RP") throw new Error(`prompt-preprocessor: expected ')' after exists("${path}" but got ${this.describeToken(this.peek())}`)
      this.advance()
      return existsSync(resolvePath(path))
    }
    if (this.peek().type === "VAR") {
      const varName = this.advance().value
      if (this.peek().type === "OP") {
        const op = this.advance().value
        const vt = this.peek()
        if (vt.type !== "STR" && vt.type !== "NUM" && vt.type !== "VAR") throw new Error(`prompt-preprocessor: expected value after "${op}" but got ${this.describeToken(vt)}`)
        this.advance()
        return this.evalComparison(varName, op, vt)
      }
      return isVarTruthy(varName)
    }
    throw new Error(`prompt-preprocessor: unexpected ${this.describeToken(this.peek())} in expression, expected VAR, defined(, exists(, or '('`)
  }

  private evalComparison(varName: string, op: string, valueToken: Token): boolean {
    const envVal = resolveVar(varName)
    const isQuoted = valueToken.type === "STR"
    const value = isQuoted ? valueToken.value.slice(1, -1) : valueToken.value
    switch (op) {
      case "==": case "!=": {
        const eq = op === "=="
        if (isQuoted) return eq ? envVal === value : envVal !== value
        const n1 = parseFloat(envVal), n2 = parseFloat(value)
        return (isNaN(n1) || isNaN(n2)) ? (eq ? envVal === value : envVal !== value) : (eq ? n1 === n2 : n1 !== n2)
      }
      case ">": return parseFloat(envVal) > parseFloat(value)
      case "<": return parseFloat(envVal) < parseFloat(value)
      case ">=": return parseFloat(envVal) >= parseFloat(value)
      case "<=": return parseFloat(envVal) <= parseFloat(value)
      case "~": return envVal.includes(value)
      default: return false
    }
  }
}

function evaluateExpression(expr: string): boolean {
  const trimmed = expr.trim()
  if (!trimmed) return false
  const tokens = tokenize(trimmed)
  return new ExprParser(tokens).parse()
}

const RE_DIRECTIVE = /^\s*!(ifndef|elifndef|ifdef|elifdef|if|elif|else|endif)(?:\s+(.*))?\s*$/
const RE_VAR_ONLY = /^(\w+)$/

function preprocessConditionals(text: string): string {
  const lines = text.split("\n")
  const out: string[] = []
  const stack: CondFrame[] = []
  const isSkipping = () => stack.some((f) => f.skipChildren)

  for (const rawLine of lines) {
    const m = rawLine.match(RE_DIRECTIVE)
    if (!m) { if (!isSkipping()) out.push(rawLine); continue }
    const directive = m[1]!
    const rest = m[2] ?? ""

    switch (directive) {
      case "if": case "ifdef": case "ifndef": {
        let cond: boolean
        if (directive === "ifdef") { const vo = rest.match(RE_VAR_ONLY); cond = vo ? isVarDefined(vo[1]!) : false }
        else if (directive === "ifndef") { const vo = rest.match(RE_VAR_ONLY); cond = vo ? !isVarDefined(vo[1]!) : false }
        else { cond = evaluateExpression(rest) }
        if (isSkipping()) stack.push({ branchTaken: false, skipChildren: true })
        else if (cond) stack.push({ branchTaken: true, skipChildren: false })
        else stack.push({ branchTaken: false, skipChildren: true })
        break
      }
      case "elif": case "elifdef": case "elifndef": {
        if (stack.length === 0) throw new Error(`prompt-preprocessor: !${directive} without matching !if: ${rawLine.trim()}`)
        const prev = stack.pop()!
        if (prev.branchTaken) { stack.push({ branchTaken: true, skipChildren: true }) }
        else if (isSkipping()) { stack.push({ branchTaken: false, skipChildren: true }) }
        else {
          let cond: boolean
          if (directive === "elifdef") { const vo = rest.match(RE_VAR_ONLY); cond = vo ? isVarDefined(vo[1]!) : false }
          else if (directive === "elifndef") { const vo = rest.match(RE_VAR_ONLY); cond = vo ? !isVarDefined(vo[1]!) : false }
          else { cond = evaluateExpression(rest) }
          stack.push({ branchTaken: cond, skipChildren: !cond })
        }
        break
      }
      case "else": {
        if (stack.length === 0) throw new Error(`prompt-preprocessor: !else without matching !if: ${rawLine.trim()}`)
        const prev = stack.pop()!
        if (prev.branchTaken) stack.push({ branchTaken: true, skipChildren: true })
        else if (isSkipping()) stack.push({ branchTaken: true, skipChildren: true })
        else stack.push({ branchTaken: true, skipChildren: false })
        break
      }
      case "endif": {
        if (stack.length === 0) throw new Error(`prompt-preprocessor: !endif without matching !if: ${rawLine.trim()}`)
        stack.pop()
        break
      }
    }
  }
  if (stack.length > 0) throw new Error(`prompt-preprocessor: ${stack.length} unclosed !if block(s) at end of input`)
  return out.join("\n")
}

const PromptPreprocessor: Plugin = async () => {
  workspaceDir = process.cwd()
  return {
    "experimental.chat.system.transform": async (_input, output) => {
      for (let i = 0; i < output.system.length; i++) {
        const defined = processDefines(output.system[i])
        const included = await resolveIncludes(defined, [], 0)
        const shelled = await processShellDirectives(included)
        const expanded = expandEnvVars(shelled)
        const conditioned = preprocessConditionals(expanded)
        output.system[i] = processErrors(conditioned)
      }
    },
  }
}

export default PromptPreprocessor
