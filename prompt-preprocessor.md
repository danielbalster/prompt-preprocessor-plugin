# Plugin: prompt-preprocessor

Preprocesses skills and system prompts before they reach the AI model.
Three processing stages run in order: **include resolution → variable expansion → conditional stripping**.

## Processing pipeline

```
raw prompt text
  → resolveIncludes     .include directives
  → expandEnvVars       ${VARIABLE} → value
  → preprocessConditionals   .if / .elif / .else / .endif
final prompt text
```

Included content (§1.1) flows through all three stages, so included files
can use variables and conditionals.

---

## 1. Include directives

Loads external files or URLs at prompt-build time. Must appear at the
beginning of a line; resolved before any other processing.

| Directive | Example |
|---|---|
| Local file | `.include "path/to/file.md"` |
| Absolute file | `.include "/absolute/path/to/file.md"` |
| URL | `.include "https://example.com/prompt.md"` |

### 1.1 Behaviour

- File paths are resolved relative to the project root.
- URLs must use `http://` or `https://`.
- Nested includes are resolved recursively up to **10 levels** deep.
- Any include failure is **fatal** — see §1.2.

### 1.2 Error handling

Include failures are **fatal** — the plugin throws an error, which causes Kilo
to halt execution and display an error dialog to the user. The AI harness will
not proceed with a malformed or incomplete prompt.

Failure conditions that trigger a fatal error:
- File not found
- HTTP error (non-2xx response)
- Circular include (A → B → A)
- Maximum include depth exceeded (10 levels)

---

## 2. Environment variable expansion

Expands `${NAME}` patterns to the value of `process.env.NAME`. Undefined
variables are left as-is.

| Syntax | Behaviour |
|---|---|
| `${FOO}` | Replaced with value of `FOO` |
| `${UNDEFINED}` | Left unchanged |
| `$FOO` | NOT expanded — only `${NAME}` is |

Expansion runs **after** includes and **before** conditionals, so condition
values can use `${…}`:

```
.if $VERSION >= ${MIN_VERSION}
```

`${MIN_VERSION}` expands first (e.g. to `5`), then `$VERSION >= 5` is
evaluated.

---

## 3. Conditional directives

Each directive must appear at the beginning of a line (leading whitespace is
ignored). Directive lines themselves are stripped from output — only the
matching branch content remains.

| Directive | Meaning |
|---|---|
| `.if EXPR` | Open block; include body if EXPR is true |
| `.if $VAR` | Shorthand — true if `$VAR` is defined **and** non-empty |
| `.ifdef $VAR` | True if `$VAR` exists in the environment (may be empty) |
| `.ifndef $VAR` | True if `$VAR` is **not** defined |
| `.elif EXPR` | Else-if branch; evaluated only when no prior branch matched |
| `.elif $VAR` | Else-if truthy shorthand |
| `.elifdef $VAR` | Else-if defined check |
| `.elifndef $VAR` | Else-if not-defined check |
| `.else` | Fallback branch when no condition matched |
| `.endif` | Close the conditional block |

Blocks can be **nested** arbitrarily.

---

## 4. Expression syntax

Expressions are used with `.if` and `.elif`. The grammar supports comparison
operators, logical combinators, and parenthesized grouping.

### 4.1 Comparison operators

| Operator | Meaning | Example |
|---|---|---|
| `==` | Equal (string or numeric) | `.if $FOO == "bar"` |
| `!=` | Not equal (string or numeric) | `.if $FOO != "baz"` |
| `>` | Greater than (numeric) | `.if $NUM > 3` |
| `<` | Less than (numeric) | `.if $NUM < 10` |
| `>=` | Greater or equal (numeric) | `.if $NUM >= 3` |
| `<=` | Less or equal (numeric) | `.if $NUM <= 10` |
| `~` | Substring / contains (string) | `.if $FOO ~ "ar"` |

- **Quoted values** (`"bar"`) are compared as **strings**.
- **Bare values** (`3`, `42`) are compared as **numbers**. If either side is
  not parseable as a float the comparison falls back to string equality.
- `>` `<` `>=` `<=` always compare numerically. Use `.if $VAR` for
  zero/non-empty checks.
- `~` performs a **case-sensitive substring** check: `$FOO ~ "ar"` is true
  when the value of `FOO` contains `ar`.

### 4.2 Logical operators (precedence high → low)

| Operator | Precedence | Example |
|---|---|---|
| `!` (not) | highest | `.if !$FOO`, `.if ! $FOO == "bar"` |
| `&&` (and) | medium | `.if $A && $B` |
| `\|\|` (or) | lowest | `.if $A \|\| $B` |
| `(…)` (grouping) | overriding | `.if ($A \|\| $B) && $C` |

- `!` binds to the immediately following expression.
  `.if ! $FOO == "bar"` means `!($FOO == "bar")`.
- `&&` and `\|\|` are **non-short-circuit** — all operands are always
  evaluated.  This ensures the right-hand side of `.if true \|\| expr`
  is still parsed for correctness; trailing tokens are rejected.

### 4.3 Shorthand forms

| Form | Equivalent condition |
|---|---|
| `.if $FOO` | True if `FOO` is defined and non-empty |
| `.if !$FOO` | True if `FOO` is undefined or empty |
| `.if $A && $B` | Both `A` and `B` are truthy |
| `.if $A \|\| $B` | `A` or `B` is truthy |

---

## 5. Examples

### 5.1 Basic conditional

```
.if $MODE == "debug"
verbose debug output here
.else
production mode
.endif
```

### 5.2 Multi-way branch

```
.ifdef $WINDOWS
Windows-specific instructions
.elifdef $MACOS
macOS-specific instructions
.elif $LINUX == "1"
Linux-specific instructions
.else
Unsupported platform
.endif
```

### 5.3 Include with conditional

```
.ifdef $INCLUDE_EXTRAS
.include "extras/supplement.md"
.endif
```

Note: `.include` is resolved **before** conditionals, so the include always
happens.  To conditionally include, wrap the `.include` in a conditional
block as shown above — the preprocessor filters the block **after** resolving
the include, so the include only takes effect when the condition is true.

### 5.4 Compound expression

```
.if !($MODE == "release") && ($VERBOSITY >= 2 || $DEBUG == 1)
extra diagnostics
.endif
```

---

## 6. Processing limits

| Limit | Value |
|---|---|
| Maximum include depth (nesting) | 10 |
| Circular include behaviour | fatal error — halts Kilo |
| Missing file / HTTP error | fatal error — halts Kilo |

---

## 7. Configuration

Registered in `.kilo/kilo.json`:

```json
{
  "plugin": ["./plugins/prompt-preprocessor.ts"]
}
```

Source: `.kilo/plugins/prompt-preprocessor.ts`
