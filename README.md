# @dbalster/prompt-preprocessor

> **100% AI-generated.** This project was requested as: build a TypeScript plugin
> that preprocesses skills and system prompts before they reach the AI model.

A [Kilo](https://kilo.ai) / OpenCode TypeScript plugin that preprocesses prompt text through six stages: **define → include resolution → shell → variable expansion → conditional stripping → error check**.

## Installation

Add `@dbalster/prompt-preprocessor` to your `.kilo/kilo.json` plugin list, then run `npm install` in the `.kilo/` directory:

```json
{
  "plugin": ["@dbalster/prompt-preprocessor"]
}
```

```bash
cd .kilo && npm install
```

## Processing Pipeline

```
raw prompt text
  → processDefines          !define directives (sets env vars)
  → resolveIncludes         !include directives (async)
  → processShellDirectives  !shell directives (async)
  → expandEnvVars           ${VARIABLE}, ${VAR:default} → value
  → preprocessConditionals  !if / !elif / !else / !endif
  → processErrors           !error directives (after conditionals)
final prompt text
```

Included content flows through all stages, so included files can use variables and conditionals.

---

## Include Directives

Loads external files or URLs at prompt-build time. Must appear at the beginning of a line; resolved before any other processing.

| Directive | Example |
|---|---|
| Local file | `!include "path/to/file.md"` |
| Absolute file | `!include "/absolute/path/to/file.md"` |
| URL | `!include "https://example.com/prompt.md"` |

- File paths are resolved relative to the project root.
- URLs must use `http://` or `https://`.
- Nested includes are resolved recursively up to **10 levels** deep.
- Any include failure is **fatal** — the plugin throws an error and Kilo halts execution.

Failure conditions that trigger a fatal error:
- File not found
- HTTP error (non-2xx response)
- Circular include (A → B → A)
- Maximum include depth exceeded (10 levels)

---

## Environment Variable Expansion

Expands `${NAME}` and `${NAME:default}` patterns to the value of `process.env.NAME`. Undefined variables without defaults are left as-is.

| Syntax | Behaviour |
|---|---|
| `${FOO}` | Replaced with value of `FOO` |
| `${FOO:fallback}` | Value of `FOO`, or `"fallback"` if undefined |
| `${UNDEFINED}` | Left unchanged |
| `FOO` | NOT expanded by this stage — used in expressions |

Expansion runs **after** includes and **before** conditionals, so condition values can use `${…}`:

```
!if VERSION >= ${MIN_VERSION}
```

`${MIN_VERSION}` expands first (e.g. to `5`), then `VERSION >= 5` is evaluated.

---

## Conditional Directives

Each directive must appear at the beginning of a line (leading whitespace is ignored). Directive lines themselves are stripped from output — only the matching branch content remains.

| Directive | Meaning |
|---|---|
| `!if EXPR` | Open block; include body if EXPR is true |
| `!if VAR` | Shorthand — true if `VAR` is defined **and** non-empty |
| `!ifdef VAR` | True if `VAR` exists in the environment (may be empty) |
| `!ifndef VAR` | True if `VAR` is **not** defined |
| `!elif EXPR` | Else-if branch; evaluated only when no prior branch matched |
| `!elif VAR` | Else-if truthy shorthand |
| `!elifdef VAR` | Else-if defined check |
| `!elifndef VAR` | Else-if not-defined check |
| `!else` | Fallback branch when no condition matched |
| `!endif` | Close the conditional block |

Variable names in `!ifdef` / `!ifndef` / `!elifdef` / `!elifndef` are written
without a `$` prefix: `!ifdef FOO` matches if `FOO` is defined in the environment.

Blocks can be **nested** arbitrarily.

---

## Expression Syntax

Expressions are used with `!if` and `!elif`. The grammar supports comparison operators, logical combinators, parenthesized grouping, and built-in functions.

### Comparison Operators

| Operator | Meaning | Example |
|---|---|---|
| `==` | Equal (string or numeric) | `!if FOO == "bar"` |
| `!=` | Not equal (string or numeric) | `!if FOO != "baz"` |
| `>` | Greater than (numeric) | `!if NUM > 3` |
| `<` | Less than (numeric) | `!if NUM < 10` |
| `>=` | Greater or equal (numeric) | `!if NUM >= 3` |
| `<=` | Less or equal (numeric) | `!if NUM <= 10` |
| `~` | Substring / contains (string) | `!if FOO ~ "ar"` |

- **Quoted values** (`"bar"`) are compared as **strings**.
- **Bare values** (`3`, `42`) are compared as **numbers**. If either side is not parseable as a float the comparison falls back to string equality.
- `>` `<` `>=` `<=` always compare numerically. Use `!if VAR` for zero/non-empty checks.
- `~` performs a **case-sensitive substring** check.

### Logical Operators (precedence high → low)

| Operator | Precedence | Example |
|---|---|---|
| `!` (not) | highest | `!if !FOO` |
| `&&` (and) | medium | `!if A && B` |
| `\|\|` (or) | lowest | `!if A \|\| B` |
| `(…)` (grouping) | overriding | `!if (A \|\| B) && C` |

- `!` binds to the immediately following expression. `!if ! FOO == "bar"` means `!(FOO == "bar")`.
- `&&` and `\|\|` are **non-short-circuit** — all operands are always evaluated. This ensures trailing tokens are rejected.

### Built-in Functions

| Function | Meaning | Example |
|---|---|---|
| `defined(VAR)` | True if `VAR` exists in environment | `!if defined(FOO)` |
| `exists("path")` | True if file or folder exists | `!if exists("config.yaml")` |

Both functions support negation with `!`:
```
!if !defined(BAR) && exists("setup.sh")
```

### Shorthand Forms

| Form | Equivalent condition |
|---|---|
| `!if FOO` | True if `FOO` is defined and non-empty |
| `!if !FOO` | True if `FOO` is undefined or empty |
| `!if A && B` | Both `A` and `B` are truthy |
| `!if A \|\| B` | `A` or `B` is truthy |

---

## Shell Directives

Execute shell commands at preprocessor time. Output may be captured and injected into the prompt text.

| Directive | Behaviour |
|---|---|
| `!shell cmd` | Execute `cmd`, discard output |
| `!shell>1 cmd` | Execute `cmd`, insert stdout |
| `!shell>2 cmd` | Execute `cmd`, insert stderr |
| `!shell> cmd` | Execute `cmd`, insert stdout + stderr |

```
The current branch is: !shell>1 git branch --show-current
```

---

## Define Directive

Sets environment variables for use in later `${VAR}` expansions and `!if` expressions. The directive line is removed from output.

| Syntax | Example |
|---|---|
| String value | `!define FOO "hello world"` |
| Numeric value | `!define BAR 42` |

```
!define PROJECT "my-app"
!define VERSION 3
!if VERSION >= 2
Using ${PROJECT} v${VERSION}
!endif
```

---

## Error Directive

Halts preprocessing with a fatal error message. The plugin throws, causing Kilo to halt execution and display the error.

```
!error This configuration is not supported
```

---

## Examples

### Basic Conditional

```
!if MODE == "debug"
verbose debug output here
!else
production mode
!endif
```

### Multi-way Branch

```
!ifdef WINDOWS
Windows-specific instructions
!elifdef MACOS
macOS-specific instructions
!elif LINUX == "1"
Linux-specific instructions
!else
Unsupported platform
!endif
```

### Include with Conditional

```
!ifdef INCLUDE_EXTRAS
!include "extras/supplement.md"
!endif
```

Note: `!include` is resolved **before** conditionals, so the include always happens. To conditionally include, wrap the `!include` in a conditional block — the preprocessor filters the block **after** resolving the include.

### Compound Expression

```
!if !(MODE == "release") && (VERBOSITY >= 2 || !defined(QUIET))
extra diagnostics
!endif
```

### Define, Shell, and Conditionals Combined

```
!define BUILD_TYPE "debug"
!if exists("debug-config.json")
!include "debug-config.json"
!else
Configuration: !shell>1 cat default-config.json
!endif
```

---

## Processing Limits

| Limit | Value |
|---|---|
| Maximum include depth (nesting) | 10 |
| Circular include behaviour | fatal error — halts Kilo |
| Missing file / HTTP error | fatal error — halts Kilo |

## License

MIT
