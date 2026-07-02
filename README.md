# @dbalster/prompt-preprocessor

> **100% AI-generated.** This project was requested as: build a TypeScript plugin
> that preprocesses skills and system prompts before they reach the AI model.
> Every line of code was written by an AI language model.

A [Kilo](https://kilo.ai) / OpenCode TypeScript plugin that preprocesses prompt text through three stages: **include resolution → variable expansion → conditional stripping**.

## Features

- **Include resolution**: Load external files or URLs via `.include "path/to/file.md"` directives with recursive resolution up to 10 levels deep
- **Environment variable expansion**: Expand `${VARIABLE}` patterns to `process.env` values
- **Conditional preprocessing**: `.if`/`.elif`/`.else`/`.endif` blocks with full expression language including comparison operators, logical combinators, and shorthand forms
- **Nested conditionals**: Arbitrarily nested conditional blocks
- **URL includes**: Fetch remote prompt content via `http://` and `https://` URLs

## Installation

```bash
npm install -g @dbalster/prompt-preprocessor
```

## Usage in Kilo/OpenCode

Copy or symlink `prompt-preprocessor.ts` into your `.kilo/plugins/` directory:

```bash
mkdir -p ~/project/.kilo/plugins
cp node_modules/@dbalster/prompt-preprocessor/dist/prompt-preprocessor.js ~/project/.kilo/plugins/prompt-preprocessor.js
```

Then reference it in `.kilo/kilo.json`:

```json
{
  "plugin": ["./plugins/prompt-preprocessor.js"]
}
```

## Processing Pipeline

```
raw prompt text
  → resolveIncludes     .include directives
  → expandEnvVars       ${VARIABLE} → value
  → preprocessConditionals   .if / .elif / .else / .endif
final prompt text
```

## Include Directives

| Directive | Example |
|---|---|
| Local file | `.include "path/to/file.md"` |
| Absolute file | `.include "/absolute/path/to/file.md"` |
| URL | `.include "https://example.com/prompt.md"` |

Include failures are **fatal** — the plugin throws an error and Kilo halts execution.

## Conditional Directives

| Directive | Meaning |
|---|---|
| `.if EXPR` | Open block; include body if EXPR is true |
| `.if $VAR` | True if $VAR is defined and non-empty |
| `.ifdef $VAR` | True if $VAR exists in the environment |
| `.ifndef $VAR` | True if $VAR is not defined |
| `.elif EXPR` | Else-if branch |
| `.elifdef $VAR` | Else-if defined check |
| `.elifndef $VAR` | Else-if not-defined check |
| `.else` | Fallback branch |
| `.endif` | Close the conditional block |

### Example

```
.if $MODE == "debug"
verbose debug output here
.else
production mode
.endif
```

## Processing Limits

| Limit | Value |
|---|---|
| Maximum include depth (nesting) | 10 |
| Circular include behaviour | fatal error |
| Missing file / HTTP error | fatal error |

## License

MIT
