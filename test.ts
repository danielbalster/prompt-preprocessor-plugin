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

// ── Test 7: ${VAR} without default (undefined ⇒ unchanged) ─────────
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

// ── Test 17: !ifdef VAR (bare word, no $) ──────────────────────────
console.log("Test 17: !ifdef VAR (bare word)")
{
  const result = await run("!ifdef TEST17\nVAR present\n!else\nVAR absent\n!endif", { TEST17: "" })
  assertEq(result, "VAR present", "ifdef bare word")
}

// ── Test 18: !ifdef $VAR (backward compat, with $) ────────────────
console.log("Test 18: !ifdef $VAR (backward compat)")
{
  delete process.env.TEST18
  const result = await run("!ifndef $TEST18\nVAR absent\n!else\nVAR present\n!endif")
  assertEq(result, "VAR absent", "ifndef with dollar")
}

// ── Test 19: !ifndef VAR (bare word) ───────────────────────────────
console.log("Test 19: !ifndef VAR (bare word)")
{
  delete process.env.TEST19
  const result = await run("!ifndef TEST19\nVAR absent\n!else\nVAR present\n!endif")
  assertEq(result, "VAR absent", "ifndef bare word")
}

// ── Test 20: !error directive ──────────────────────────────────────
console.log("Test 20: !error directive")
{
  await assertThrows(
    () => run("some text\n!error stop right here\nmore text"),
    "error directive throws"
  )
}

// ── Test 21: !shell silent (no output) ─────────────────────────────
console.log("Test 21: !shell silent")
{
  const result = await run("before\n!shell echo hello\nmiddle\n!shell echo world\nafter")
  assertEq(result, "before\nmiddle\nafter", "shell silent")
}

// ── Test 22: !shell>1 stdout only ──────────────────────────────────
console.log("Test 22: !shell>1 stdout")
{
  const result = await run("!shell>1 echo stdout only")
  assertEq(result, "stdout only", "shell stdout")
}

// ── Test 23: !shell>2 stderr only ──────────────────────────────────
console.log("Test 23: !shell>2 stderr")
{
  const result = await run("!shell>2 sh -c 'echo stderr only >&2'")
  assertEq(result, "stderr only", "shell stderr")
}

// ── Test 24: !shell> stdout and stderr ─────────────────────────────
console.log("Test 24: !shell> both")
{
  const result = await run("!shell> sh -c 'echo stdout; echo stderr >&2'")
  assertEq(result, "stdout\nstderr", "shell both")
}

// ── Test 25: !shell>1 with no output ───────────────────────────────
console.log("Test 25: !shell>1 no output")
{
  const result = await run("!shell>1 true")
  assertEq(result, "", "shell no output")
}

// ── Test 26: Combined !define + !ifdef ─────────────────────────────
console.log("Test 26: !define + !ifdef")
{
  const result = await run("!define MODE debug\n!ifdef MODE\nenabled\n!else\ndisabled\n!endif")
  assertEq(result, "enabled", "define then ifdef")
}

// ── Test 27: !define + !if expression ──────────────────────────────
console.log("Test 27: !define + !if expression")
{
  const result = await run("!define VER 5\n!if $VER >= 3\nok\n!else\nnok\n!endif")
  assertEq(result, "ok", "define then if compare")
}

// ── Test 28: defined() with !elif ──────────────────────────────────
console.log("Test 28: defined() in !elif")
{
  delete process.env.TEST28
  const result = await run("!if defined(TEST28)\nfirst\n!elif defined(PATH)\nsecond\n!else\nthird\n!endif")
  assertEq(result, "second", "defined in elif")
}

// ── Test 29: exists() with !elif ────────────────────────────────────
console.log("Test 29: exists() in !elif")
{
  const result = await run('!if exists("no-such-file.txt")\nfirst\n!elif exists("prompt-preprocessor.ts")\nsecond\n!else\nthird\n!endif')
  assertEq(result, "second", "exists in elif")
}

// ── Test 30: Multiple !define directives ──────────────────────────
console.log("Test 30: multiple !define")
{
  const result = await run("!define A 1\n!define B 2\n${A} + ${B}")
  assertEq(result, "1 + 2", "multiple defines")
}

// ── Summary ────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
