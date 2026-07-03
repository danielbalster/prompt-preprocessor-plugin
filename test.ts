import PromptPreprocessor from "./prompt-preprocessor.ts"

const plugin = await PromptPreprocessor()
const transform = plugin["experimental.chat.system.transform"]!

let passed = 0
let failed = 0

function assertEq(got: string, expected: string, label: string) {
  if (got === expected) {
    passed++
  } else {
    failed++
    console.error(`FAIL [${label}]`)
    console.error(`  expected: ${JSON.stringify(expected)}`)
    console.error(`  got:      ${JSON.stringify(got)}`)
  }
}

function assertThrows(fn: () => Promise<void>, label: string) {
  return fn().then(
    () => { failed++; console.error(`FAIL [${label}]: expected throw but succeeded`) },
    () => { passed++ },
  )
}

async function run(input: string, envOverrides?: Record<string, string | undefined>): Promise<string> {
  const saved: Record<string, string | undefined> = {}
  if (envOverrides) {
    for (const [k, v] of Object.entries(envOverrides)) {
      saved[k] = process.env[k]
      if (v === undefined) {
        delete process.env[k]
      } else {
        process.env[k] = v
      }
    }
  }
  try {
    const output = { system: [input] }
    await transform({}, output as any)
    return output.system[0]!
  } finally {
    if (envOverrides) {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }
}

// ── Test 1: !define sets env var (string) ──────────────────────────
console.log("Test 1: !define string")
{
  const result = await run("!define FOO hello world\nresult: ${FOO}")
  assertEq(result, "result: hello world", "define string")
}

// ── Test 2: !define sets env var (number) ──────────────────────────
console.log("Test 2: !define number")
{
  const result = await run("!define BAR 42\nresult: ${BAR}")
  assertEq(result, "result: 42", "define number")
}

// ── Test 3: !define with quoted string ─────────────────────────────
console.log("Test 3: !define quoted string with spaces")
{
  const result = await run('!define GREETING "hello beautiful world"\nresult: ${GREETING}')
  assertEq(result, "result: hello beautiful world", "define quoted string")
}

// ── Test 4: !define line is removed from output ────────────────────
console.log("Test 4: !define line removed")
{
  const result = await run("!define X 1\nnot removed")
  assertEq(result, "not removed", "define line removed")
}

// ── Test 5: ${VAR:default} when var is undefined ───────────────────
console.log("Test 5: ${VAR:default} undefined")
{
  delete process.env.UNSETVAR
  const result = await run("Hello ${UNSETVAR:world}")
  assertEq(result, "Hello world", "default fallback")
}

// ── Test 6: ${VAR:default} when var is defined ─────────────────────
console.log("Test 6: ${VAR:default} defined")
{
  const result = await run("Hello ${TESTVAR:fallback}", { TESTVAR: "real" })
  assertEq(result, "Hello real", "defined overrides default")
}

// ── Test 7: ${VAR} without default (undefined -> unchanged) ────────
console.log("Test 7: ${VAR} without default undefined")
{
  delete process.env.NOEXIST
  const result = await run("Hello ${NOEXIST}")
  assertEq(result, "Hello ${NOEXIST}", "undefined unchanged")
}

// ── Test 8: defined(VAR) in expression ─────────────────────────────
console.log("Test 8: defined(VAR) true")
{
  const result = await run("!if defined(TEST8)\nVAR present\n!else\nVAR absent\n!endif", { TEST8: "1" })
  assertEq(result, "VAR present", "defined true")
}

// ── Test 9: defined(VAR) false ─────────────────────────────────────
console.log("Test 9: defined(VAR) false")
{
  delete process.env.TEST8B
  const result = await run("!if defined(TEST8B)\nVAR present\n!else\nVAR absent\n!endif")
  assertEq(result, "VAR absent", "defined false")
}

// ── Test 10: !defined(VAR) ─────────────────────────────────────────
console.log("Test 10: !defined(VAR)")
{
  delete process.env.TEST10
  const result = await run("!if !defined(TEST10)\nnot defined\n!else\ndefined\n!endif")
  assertEq(result, "not defined", "not defined")
}

// ── Test 11: defined(VAR) && defined(OTHER) ───────────────────────
console.log("Test 11: defined() && defined()")
{
  const result = await run("!if defined(TEST11A) && defined(TEST11B)\nboth\n!else\nnot both\n!endif", { TEST11A: "1", TEST11B: "1" })
  assertEq(result, "both", "both defined")
}

// ── Test 12: defined(VAR) || defined(OTHER) ────────────────────────
console.log("Test 12: defined() || defined()")
{
  delete process.env.TEST12B
  const result = await run("!if defined(TEST12A) || defined(TEST12B)\nat least one\n!else\nnone\n!endif", { TEST12A: "1" })
  assertEq(result, "at least one", "one defined via or")
}

// ── Test 13: exists("path") true ────────────────────────────────────
console.log("Test 13: exists() true")
{
  const result = await run('!if exists("prompt-preprocessor.ts")\nfile exists\n!else\nfile missing\n!endif')
  assertEq(result, "file exists", "exists true")
}

// ── Test 14: exists("path") false ───────────────────────────────────
console.log("Test 14: exists() false")
{
  const result = await run('!if exists("nonexistent.file.xyz")\nfile exists\n!else\nfile missing\n!endif')
  assertEq(result, "file missing", "exists false")
}

// ── Test 15: !exists("path") ────────────────────────────────────────
console.log("Test 15: !exists()")
{
  const result = await run('!if !exists("nonexistent.file.xyz")\nfile missing\n!else\nfile exists\n!endif')
  assertEq(result, "file missing", "not exists")
}

// ── Test 16: exists() with folder ───────────────────────────────────
console.log("Test 16: exists() folder")
{
  const result = await run('!if exists("node_modules")\nfolder exists\n!else\nfolder missing\n!endif')
  assertEq(result, "folder exists", "exists folder")
}

// ── Test 17: !ifdef VAR (bare word) ──────────────────────────────────
console.log("Test 17: !ifdef VAR")
{
  const result = await run("!ifdef TEST17\nVAR present\n!else\nVAR absent\n!endif", { TEST17: "" })
  assertEq(result, "VAR present", "ifdef bare word")
}

// ── Test 18: !ifndef VAR (bare word) ─────────────────────────────────
console.log("Test 18: !ifndef VAR")
{
  delete process.env.TEST18
  const result = await run("!ifndef TEST18\nVAR absent\n!else\nVAR present\n!endif")
  assertEq(result, "VAR absent", "ifndef bare word")
}

// ── Test 19: !error directive ────────────────────────────────────────
console.log("Test 19: !error directive")
{
  await assertThrows(
    () => run("some text\n!error stop right here\nmore text"),
    "error directive throws"
  )
}

// ── Test 20: !shell silent (no output) ───────────────────────────────
console.log("Test 20: !shell silent")
{
  const result = await run("before\n!shell echo hello\nmiddle\n!shell echo world\nafter")
  assertEq(result, "before\nmiddle\nafter", "shell silent")
}

// ── Test 21: !shell>1 stdout only ────────────────────────────────────
console.log("Test 21: !shell>1 stdout")
{
  const result = await run("!shell>1 echo stdout only")
  assertEq(result, "stdout only", "shell stdout")
}

// ── Test 22: !shell>2 stderr only ────────────────────────────────────
console.log("Test 22: !shell>2 stderr")
{
  const result = await run("!shell>2 sh -c 'echo stderr only >&2'")
  assertEq(result, "stderr only", "shell stderr")
}

// ── Test 23: !shell> stdout and stderr ───────────────────────────────
console.log("Test 23: !shell> both")
{
  const result = await run("!shell> sh -c 'echo stdout; echo stderr >&2'")
  assertEq(result, "stdout\nstderr", "shell both")
}

// ── Test 24: !shell>1 with no output ─────────────────────────────────
console.log("Test 24: !shell>1 no output")
{
  const result = await run("!shell>1 true")
  assertEq(result, "", "shell no output")
}

// ── Test 25: Combined !define + !ifdef ───────────────────────────────
console.log("Test 25: !define + !ifdef")
{
  const result = await run("!define MODE debug\n!ifdef MODE\nenabled\n!else\ndisabled\n!endif")
  assertEq(result, "enabled", "define then ifdef")
}

// ── Test 26: !if expression with string comparison ───────────────────
console.log("Test 26: !if VAR == string")
{
  const result = await run('!if MODE == "debug"\nDEBUG\n!else\nRELEASE\n!endif', { MODE: "debug" })
  assertEq(result, "DEBUG", "var equals string")
}

// ── Test 27: !if expression with numeric comparison ──────────────────
console.log("Test 27: !if VAR >= number")
{
  const result = await run("!if VER >= 3\nok\n!else\nnok\n!endif", { VER: "5" })
  assertEq(result, "ok", "var >= number")
}

// ── Test 28: !if VAR truthy shorthand ────────────────────────────────
console.log("Test 28: !if VAR truthy")
{
  const result = await run("!if DEBUG\nenabled\n!else\ndisabled\n!endif", { DEBUG: "1" })
  assertEq(result, "enabled", "truthy var")
}

// ── Test 29: !if !VAR shorthand (empty -> false) ─────────────────────
console.log("Test 29: !if !VAR falsey")
{
  delete process.env.DEBUG
  const result = await run("!if !DEBUG\ndisabled\n!else\nenabled\n!endif")
  assertEq(result, "disabled", "not falsey var")
}

// ── Test 30: !if VAR contains substring ~ ────────────────────────────
console.log("Test 30: !if VAR ~ substring")
{
  const result = await run('!if TEXT ~ "hello"\nmatch\n!else\nno match\n!endif', { TEXT: "hello world" })
  assertEq(result, "match", "substring match")
}

// ── Test 31: defined() with !elif ────────────────────────────────────
console.log("Test 31: defined() in !elif")
{
  delete process.env.TEST31
  const result = await run("!if defined(TEST31)\nfirst\n!elif defined(PATH)\nsecond\n!else\nthird\n!endif")
  assertEq(result, "second", "defined in elif")
}

// ── Test 32: exists() with !elif ─────────────────────────────────────
console.log("Test 32: exists() in !elif")
{
  const result = await run('!if exists("no-such-file.txt")\nfirst\n!elif exists("prompt-preprocessor.ts")\nsecond\n!else\nthird\n!endif')
  assertEq(result, "second", "exists in elif")
}

// ── Test 33: Multiple !define directives ─────────────────────────────
console.log("Test 33: multiple !define")
{
  const result = await run("!define A 1\n!define B 2\n${A} + ${B}")
  assertEq(result, "1 + 2", "multiple defines")
}

// ── Test 34: Compound expression with functions ──────────────────────
console.log("Test 34: compound expression")
{
  const result = await run("!if defined(A) || defined(B)\nfound\n!else\nnot found\n!endif", { A: "1" })
  assertEq(result, "found", "compound or")
}

// ── Test 35: !if VAR != string ───────────────────────────────────────
console.log("Test 35: !if VAR != string")
{
  const result = await run('!if MODE != "debug"\nRELEASE\n!else\nDEBUG\n!endif', { MODE: "release" })
  assertEq(result, "RELEASE", "var not equal")
}

// ── Test 36: !error inside false branch must NOT fire ─────────────────
console.log("Test 36: !error inside false branch silent")
{
  const result = await run('!if !exists("prompt-preprocessor.ts")\n!error should not fire\n!else\nall good\n!endif')
  assertEq(result, "all good", "error in false branch")
}

// ── Test 37: !error inside true branch DOES fire ──────────────────────
console.log("Test 37: !error inside true branch fires")
{
  await assertThrows(
    () => run('!if exists("prompt-preprocessor.ts")\n!error yes fire\n!else\nno\n!endif'),
    "error in true branch fires"
  )
}

// ── Summary ──────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
