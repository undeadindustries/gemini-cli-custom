# gemini-cli-local

> **This is a fork of
> [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli).** It
> began as a local LLM bypass — routing requests to any OpenAI-compatible server
> (vLLM, Ollama, llama.cpp, etc.) — and has since grown into a unified provider
> system supporting local models, OpenAI, OpenRouter, and any other
> OpenAI-compatible hosted endpoint, while keeping all upstream Gemini / Vertex
> AI paths fully intact.
>
> The binary is named `gemini-local-cli` so it coexists with a standard
> `gemini-cli` install on the same machine.

---

## What is different from upstream

| Area                           | Upstream gemini-cli                | gemini-cli-local                                                                                                                                                                                                                            |
| ------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Backend**                    | Google Gemini / Vertex AI only     | Single unified provider registry: Gemini (OAuth / API key / Vertex), OpenAI, **plus user-defined custom OpenAI-compat providers** (vLLM, Ollama, llama.cpp, Azure, Groq, Together, …) added via `/provider add`                             |
| **Binary name**                | `gemini`                           | `gemini-local-cli` (avoids PATH collision)                                                                                                                                                                                                  |
| **Auth**                       | Google OAuth / API key / Vertex    | All upstream auth types **plus** `AuthType.LOCAL` (one mode for local + hosted OpenAI-compat); each provider declares its own `authType` in the registry                                                                                    |
| **Provider switching**         | N/A                                | `/provider` interactive menu (switch / edit / add / remove / browse models) plus `/provider use <id>`. Switches mid-session (Gemini OAuth ↔ custom vLLM ↔ OpenAI) without restart; per-provider token usage tracked and shown in `/stats` |
| **Custom providers**           | N/A                                | `/provider add my-vllm --url … [--model …] [--env VAR]` registers any new OpenAI-compat endpoint. Built-ins (`gemini-*`, `openai`) are non-removable                                                                                        |
| **Context management**         | 1 M-token Gemini window            | 4-layer proactive defense for small local windows (32 K–100 K)                                                                                                                                                                              |
| **Mistral / Devstral support** | N/A                                | Tool-call ID sanitization, orphan-tool-call patching, role-transition bridging                                                                                                                                                              |
| **Local model discovery**      | N/A                                | Auto-queries `GET /v1/models`, hybrid picker in `/model` dialog                                                                                                                                                                             |
| **Settings hot-reload**        | Restart required for most settings | `providers.<id>.{url,model,promptMode,timeout,…}` reload live                                                                                                                                                                               |
| **`/provider` command**        | N/A                                | Canonical: built-in Gemini (×3) + OpenAI; everything else is a custom provider you `add`. Gemini entries expose **zero** editable settings — upstream defaults apply (Phase 2.3)                                                            |
| **`/local` command**           | N/A                                | **Removed in Phase 2.2** — use `/provider use <id>` (or `/provider add` + `/provider use` for custom local servers). Existing `local.*` settings auto-migrate on first run                                                                  |
| **System prompt**              | Full Gemini prompt                 | Selectable: `lite` (optimized for small local models) or `full`                                                                                                                                                                             |
| **Tool call format**           | Gemini SDK native                  | Translated to OpenAI `tool_calls` / `tool` messages with Mistral-specific patches                                                                                                                                                           |
| **API key storage**            | N/A                                | Secure OS keychain via `keytar`, env-var fallback, never logged or sent upstream                                                                                                                                                            |

---

## Setup and running (OpenAI-compatible mode — local or hosted)

`/provider` is the single canonical command for selecting **any**
OpenAI-compatible endpoint, whether it lives on `localhost` (vLLM, llama.cpp,
Ollama) or in the cloud (OpenAI, Azure OpenAI, Groq, Together AI, Anyscale,
etc.). Both paths run through the same code (`AuthType.LOCAL` +
`OpenAICompatContentGenerator`); the only difference is whether an API key is
attached to the request.

As of Phase 2.3 only **Gemini** and **OpenAI** are built into the registry.
Every other endpoint — including the legacy `local-vllm`, `local-llamacpp`, and
`local-generic` presets from Phase 2.2 — is now a **user-defined custom
provider** you register with `/provider add`. Existing settings from earlier
phases auto-migrate on first run (see "One-time migration of legacy local-\*
presets" below).

| Built-in id     | Display name       | Default base URL            | Auth                            |
| --------------- | ------------------ | --------------------------- | ------------------------------- |
| `gemini-oauth`  | Gemini (OAuth)     | n/a                         | Personal Google OAuth (`/auth`) |
| `gemini-apikey` | Gemini (API key)   | n/a                         | `$GEMINI_API_KEY`               |
| `gemini-vertex` | Gemini (Vertex AI) | n/a                         | Vertex ADC + project + location |
| `openai`        | OpenAI             | `https://api.openai.com/v1` | `$OPENAI_API_KEY` (or keychain) |

Need a local vLLM, llama.cpp, Ollama, hosted OpenAI, or a unified gateway like
[OpenRouter](https://openrouter.ai)? Add it once and it becomes a first-class
provider:

```text
# Local vLLM (Chat Completions)
/provider add my-vllm \
  --url http://127.0.0.1:8000/v1/chat/completions \
  --name "My vLLM" \
  --model Qwen/Qwen3-Coder-Next-FP8
/provider use my-vllm

# OpenRouter — one endpoint for every model
# IMPORTANT: --url must be the full chat completions path, not just the
# /api/v1 root. The CLI does not auto-append /chat/completions.
/provider add openrouter \
  --url https://openrouter.ai/api/v1/chat/completions \
  --name "OpenRouter" \
  --model openai/gpt-4o
/provider use openrouter
```

To add a Responses-API provider (e.g. local `gpt-oss-20b` on vLLM with the
`/v1/responses` endpoint enabled), pass `--wire-format openai-responses`:

```text
/provider add my-vllm-resp \
  --wire-format openai-responses \
  --url http://127.0.0.1:8000/v1/responses \
  --name "My vLLM (Responses)" \
  --model gpt-oss-20b
/provider use my-vllm-resp
```

`/provider add` accepts the same shape interactively from the dialog (Add
provider → fill the form). Built-in providers (`gemini-*`, `openai`,
`openai-responses`) cannot be removed; custom providers can be removed with
`/provider remove <id>`.

### Quick start — OpenAI (hosted)

```bash
# Option A: environment variable (no keychain required)
export GEMINI_PROVIDER=openai
export OPENAI_API_KEY=sk-...
gemini-local-cli

# Option B: store the key in the OS keychain
gemini-local-cli              # start the CLI first (any auth mode)
/provider set openai key sk-...
/provider use openai
```

### Quick start — local vLLM as a custom provider

```bash
# Once vLLM is running on http://127.0.0.1:8000, register it as a custom
# provider and switch to it. The id can be anything kebab-case.
gemini-local-cli
/provider add my-vllm \
  --url http://127.0.0.1:8000/v1/chat/completions \
  --name "My vLLM" \
  --model Qwen/Qwen3-Coder-Next-FP8
/provider use my-vllm
```

### Quick start — OpenRouter (one API key for every model)

[OpenRouter](https://openrouter.ai) exposes a single OpenAI-compatible endpoint
that routes to hundreds of models (OpenAI, Anthropic, Google, Meta, Mistral,
DeepSeek, Qwen, …). Register it exactly like any other custom provider:

```bash
gemini-local-cli
# --url must be the full chat completions path, not the /api/v1 root.
/provider add openrouter \
  --url https://openrouter.ai/api/v1/chat/completions \
  --name "OpenRouter" \
  --model openai/gpt-4o
/provider set openrouter key sk-or-...   # store in OS keychain
/provider use openrouter
```

Switch models at any time without re-registering:

```bash
/provider set openrouter model anthropic/claude-opus-4-5
/provider set openrouter model meta-llama/llama-3.3-70b-instruct
```

> **Tip:** Use `/provider models openrouter` to browse the full catalogue (300+
> models with prices shown). Filter by price with `--max-price <n>` (USD per
> million prompt tokens):
>
> ```text
> /provider models openrouter --max-price 0     # free models only
> /provider models openrouter --max-price 1     # ≤ $1/M prompt tokens
> /provider models openrouter                   # full list, prices shown
> ```
>
> Visit [openrouter.ai/models](https://openrouter.ai/models) to browse with
> additional filters (context length, modality, provider).

> **Tip:** Non-Gemini models routed through OpenRouter (DeepSeek, Llama, Claude,
> etc.) sometimes self-identify as "Google Gemini" because the upstream Gemini
> CLI system prompt mentions "Gemini CLI" and "GEMINI.md" often enough to bias
> the model. If that bothers you, replace the system preamble:
>
> ```text
> /provider set openrouter systemPromptOverride "You are a helpful coding assistant."
> ```
>
> Pass an empty string to clear the override. Caveat: this drops upstream
> tool-use guidance and sandbox reminders along with the identity bits, so only
> opt in if you know what you're trading away. GEMINI.md / project memory is
> unaffected.

Already had `local-vllm` configured under Phase 2.2? Don't run `/provider add`
manually — the migrator at startup automatically rewrites it as
`providers.custom.local-vllm` (see below) and your `providers.active` keeps
working as-is.

Inside the CLI the footer always reflects the resolved active config:

```
Active: OpenAI                     # or "Active: Local vLLM"
URL: https://api.openai.com/v1
Model: gpt-4o
Context: 128,000 tokens   Prompt: lite   Parser: strict
API key: from $OPENAI_API_KEY or keychain   # only shown if the provider needs one
```

### Quick start — Gemini (upstream OAuth / API key / Vertex)

Gemini providers are registered alongside the OpenAI-compatible ones, so you can
switch backends mid-session with `/provider use`:

| Preset id       | Wire format | Auth                                 |
| --------------- | ----------- | ------------------------------------ |
| `gemini-oauth`  | gemini      | Personal Google OAuth                |
| `gemini-apikey` | gemini      | `$GEMINI_API_KEY`                    |
| `gemini-vertex` | gemini      | Vertex AI (ADC / project + location) |

```bash
gemini-local-cli
/provider use gemini-oauth      # uses upstream OAuth flow (same as /auth)
/provider use gemini-apikey     # uses $GEMINI_API_KEY
/provider use gemini-vertex     # uses Vertex AI ADC + GOOGLE_CLOUD_PROJECT/LOCATION
```

Switching to a `gemini-*` provider triggers the upstream auth flow automatically
— no separate `/auth` step is required. The legacy `/auth` command still works
unchanged for re-authenticating; it just edits the same `Config.refreshAuth()`
path that `/provider use gemini-*` invokes internally.

### OpenAI Responses API support (Phase 2.4)

Phase 2.4 adds first-class support for OpenAI's `/v1/responses` endpoint — the
home of the new reasoning models (`gpt-5`, `gpt-5-codex`, `o1`, `o3`) and the
locally-runnable `gpt-oss-20b` / `gpt-oss-120b` series. The hosted endpoint is
wired up as the built-in `openai-responses` provider; any endpoint speaking the
same protocol (vLLM `--enable-responses`, LM Studio, Azure Responses, etc.) can
be added as a custom provider with `--wire-format openai-responses`.

Quick start (hosted OpenAI):

```bash
gemini-local-cli
/provider set openai-responses key sk-...
/provider use openai-responses
/provider set openai-responses model gpt-5-codex
```

Tested models on this fork:

| Model         | Use                                          | Default reasoning |
| ------------- | -------------------------------------------- | ----------------- |
| `gpt-5`       | Frontier general-purpose reasoning           | `medium`          |
| `gpt-5-codex` | Code-tuned variant; preferred for the agent  | `high`            |
| `o1` / `o3`   | Reasoning-focused; useful for hard refactors | `medium`          |
| `gpt-oss-20b` | Local on a single 24 GB GPU (vLLM)           | `low`             |

Per-provider configuration knobs:

| Setting                                          | Type / values                            | Notes                                                                            |
| ------------------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------------- |
| `providers.openai-responses.model`               | string                                   | E.g. `gpt-5-codex`. Defaults to `gpt-5`.                                         |
| `providers.openai-responses.baseUrl`             | URL                                      | Override for proxies / Azure. Defaults to `https://api.openai.com/v1/responses`. |
| `providers.openai-responses.contextLimit`        | integer                                  | Defaults to `400000` (gpt-5 family).                                             |
| `providers.openai-responses.reasoningEffort`     | `minimal` \| `low` \| `medium` \| `high` | Persisted default. Override per-session with `/reasoning <level>`.               |
| `providers.openai-responses.useResponseChaining` | boolean                                  | Default `false`. When `true`, the client chains via `previous_response_id`.      |

`/reasoning` slash command (Phase 2.4):

```text
/reasoning                # alias for /reasoning show
/reasoning show           # print resolved level + source
/reasoning low            # session-only override
/reasoning save high      # persist to providers.<active>.reasoningEffort
/reasoning clear          # drop the session override
```

The session override and persisted setting are both honored for the active
provider. `/reasoning` is a no-op (with a clear error message) on non-Responses
providers.

Stateful chaining (`useResponseChaining`):

When enabled, the generator stores the last `response.id` and sends only the new
turn's input + `previous_response_id` on subsequent requests instead of the full
history. The chain is **invalidated automatically** on `/clear`, `/compress`,
history truncation, and any streaming error so the client and server can never
drift. Default is OFF — leave it OFF unless you have a specific reason to opt in
(e.g. very long-running coding sessions where re-sending history dominates the
bill).

The 4-layer context defense (soft compression → force-compression →
hard-truncation → write-file ejection) intentionally stays **disabled** for
`openai-responses`: hosted OpenAI handles its own context window, and the
defense was designed for Mistral-family chat-completions models on local
hardware.

Local vLLM example (`gpt-oss-20b` via the Responses API):

```bash
# Start vLLM with the Responses adapter (OpenAI-style /v1/responses):
vllm serve openai/gpt-oss-20b \
  --enable-responses \
  --port 8000

# Register and use it from gemini-local-cli:
/provider add my-vllm-resp \
  --wire-format openai-responses \
  --url http://127.0.0.1:8000/v1/responses \
  --name "Local gpt-oss-20b" \
  --model gpt-oss-20b
/provider use my-vllm-resp
/reasoning low                              # sensible default for a 20B model
```

### One-time migration of legacy `local-*` presets (Phase 2.3)

If your `~/.gemini/settings.json` from Phase 2.2 has `providers.active` set to
`local-vllm`, `local-llamacpp`, or `local-generic` — or has
`providers.local-vllm.*` / `providers.local-llamacpp.*` /
`providers.local-generic.*` overrides — they are migrated **once** on the first
run after upgrading to Phase 2.3:

1. A backup is written to `~/.gemini/settings.json.pre-2.3.bak`.
2. Each used preset is registered as `providers.custom.<id>` with the same
   defaults the old built-in entry had (display name, base URL, context limit),
   overlaid with whatever the user already overrode.
3. `providers.active` is left in place — the resolver now finds the same id in
   the merged effective registry (built-ins + custom).
4. Per-instance runtime overrides (`providers.local-vllm.model`, etc.) are
   **not** moved; they continue to apply on top of the new custom registration.
   This is exactly the same model the `openai` built-in uses.
5. The CLI prints a one-line summary at startup listing migrated and any
   already-migrated ids.

The migration is idempotent — running again with no new presets in use is a
no-op. Adding new local servers after the upgrade goes through `/provider add`.

### One-time migration of legacy `local.*` settings (Phase 2.2)

If your `~/.gemini/settings.json` contained `local.url`, `local.model`, or other
`local.*` keys from the pre-2.2 fork, they are migrated **once** on the first
run after upgrading:

1. A backup is written to `~/.gemini/settings.json.pre-2.2.bak`.
2. Recognized keys (`url`, `model`, `contextLimit`, `timeout`, `promptMode`,
   `enableTools`, `temperature`, `topP`, `topK`, `minP`, `repetitionPenalty`,
   `toolCallParsing`, `apiKeyEnvVar`, `extraHeaders`) move to
   `providers.local-vllm.*`.
3. `providers.active` is set to `local-vllm` if it was unset.
4. The original `local` block is removed from `settings.json`.
5. The CLI prints a one-line summary at startup listing migrated and any dropped
   keys.

After migration, change settings via `/provider` (e.g.
`/provider set local-vllm model Qwen/Qwen3-Coder-Next-FP8`) — `/local` no longer
exists. If a `gemini-cli-local` v2.1 instance ever runs against the new settings
file, the legacy `local.*` block is gone, so be sure to upgrade all instances
together.

### Provider settings (`settings.json` or env vars)

| Setting key                     | Env var           | Default                     | Notes                                           |
| ------------------------------- | ----------------- | --------------------------- | ----------------------------------------------- |
| `providers.active`              | `GEMINI_PROVIDER` | _(unset)_                   | Provider ID to activate; `openai` supported now |
| `providers.openai.model`        | —                 | `gpt-4o`                    | Any model string the endpoint accepts           |
| `providers.openai.baseUrl`      | —                 | `https://api.openai.com/v1` | Override for Azure / proxy endpoints            |
| `providers.openai.contextLimit` | —                 | `128000`                    | Token budget; auto-passed to compression layers |
| `providers.openai.enableTools`  | —                 | `true`                      | Disable if the endpoint does not support tools  |
| `providers.openai.timeout`      | —                 | `120000`                    | Request timeout in milliseconds                 |

All `providers.openai.*` keys are hot-reloadable through `/provider` → dialog
without restarting the CLI.

### `/provider` command reference

| Sub-command                                                                                | What it does                                                                                                                                |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `/provider`                                                                                | Open the interactive provider menu (Switch / Edit / Add / Remove / Browse models / Close)                                                   |
| `/provider list`                                                                           | Show all registered providers (built-in + custom), active provider, and key state. Custom entries are tagged `[custom]`                     |
| `/provider models`                                                                         | Fetch and display chat-capable models from the active provider (OpenAI-compat only)                                                         |
| `/provider models <id>`                                                                    | Fetch models from a specific provider (e.g. `/provider models openai`, `/provider models my-vllm`)                                          |
| `/provider use <id>`                                                                       | Switch active provider and hot-reload (e.g. `/provider use openai`, `/provider use my-vllm`)                                                |
| `/provider add <id> --url <url> [--name <displayName>] [--model <name>] [--env <ENV_VAR>]` | Register a new custom OpenAI-compat provider. Refuses ids that collide with built-ins or existing custom providers                          |
| `/provider set <id> key <value>`                                                           | Save the API key to the OS keychain. Refused for `gemini-*` (use `/auth`) and for providers that don't declare an API-key env var           |
| `/provider set <id> model <value>`                                                         | Override the model string for a provider. Refused for `gemini-*` — set `GEMINI_MODEL` or use `/model` instead                               |
| `/provider set <id> url <value>`                                                           | Override the base URL (useful for Azure / proxy / non-default localhost ports). Refused for `gemini-*`                                      |
| `/provider remove <id>`                                                                    | Custom providers: deletes the entry, clears keychain credential, falls back to `gemini-oauth` if it was active. Built-ins are non-removable |

### Security model

- API keys are stored in the OS keychain via `keytar` and loaded into memory
  only at request time.
- The `Authorization: Bearer` header is injected by
  `OpenAICompatContentGenerator` and is **never** logged, serialized, or
  included in any telemetry event. A regression test
  (`loggingContentGenerator.redaction.test.ts`) enforces this.
- Environment variables are preferred over keychain at runtime; the keychain is
  used as a convenient fallback.

---

## Setup and running (local mode — legacy reference)

> **Phase 2.2 note:** Local models now run through the unified `/provider`
> command (preset id `local-vllm`, `local-llamacpp`, or `local-generic`). The
> `/local` command has been **removed**. The setting keys below remain
> documented because they map 1:1 onto `providers.local-vllm.*` after the
> automatic migration described above; new installs should configure them via
> `/provider` instead of editing `local.*` directly.

### Dependencies

- Node.js 20+
- npm 10+
- A running OpenAI-compatible inference server (vLLM, Ollama, llama.cpp)

### Build from source

```bash
git clone <this-repo>
cd gemini-cli
npm install
npm run build      # tsc-compiles each package into packages/*/dist/
npm run bundle     # produces the single-file bundle at bundle/gemini.js
```

> `npm install` triggers a bundle automatically via the `prepare` hook, so you
> usually only need `npm run bundle` after pulling new code or finishing a
> rebase.

### Install as a direct command (`gemini-local`)

This fork's `package.json` declares both `gemini` and `gemini-local-cli` as
bins. Installing globally with `npm link` or `npm install -g .` would create a
`gemini` symlink that **clobbers any existing upstream `@google/gemini-cli`
install** on the same machine. To keep the standard `gemini` command intact, use
a direct symlink under a name of your choice:

```bash
# Pick a name that doesn't collide with the upstream `gemini` binary.
# `gemini-local` is short and unambiguous; `gemini-local-cli` also works.
chmod +x /path/to/gemini-cli/bundle/gemini.js
ln -sf /path/to/gemini-cli/bundle/gemini.js ~/.local/bin/gemini-local

# Verify both commands resolve to different binaries:
which gemini             # -> upstream install (untouched)
which gemini-local       # -> ~/.local/bin/gemini-local
gemini-local --version   # -> this fork's version
```

The symlink resolves through to the live bundle on every invocation, so
`npm run bundle` after a `git pull` is enough to refresh the binary — no re-link
required. Remove with `rm ~/.local/bin/gemini-local`.

> If `~/.local/bin` is not on your `PATH`, either add
> `export PATH="$HOME/.local/bin:$PATH"` to your shell rc, or substitute any
> directory that is (e.g. `/usr/local/bin` with `sudo`).

### Run

```bash
# Point at your local vLLM / Ollama server
# local.url can be the full chat endpoint or just the server root — both work.
# The CLI auto-normalises the path before appending /v1/models for discovery.
export GEMINI_LOCAL_URL=http://127.0.0.1:8000/v1/chat/completions
export GEMINI_LOCAL_MODEL=mistralai/Devstral-Small-2-24B-Instruct-2512

# From the source tree (no install required):
node packages/cli/dist/index.js

# Or, after the symlink install above:
gemini-local
```

The header will confirm local mode:

```
gemini-cli-local v1.0.0 (Gemini CLI v0.40.0-nightly...)
  Authenticated with local /auth
    URL:     http://127.0.0.1:8000/v1/chat/completions
    Model:   mistralai/Devstral-Small-2-24B-Instruct-2512
    Context: 100,000 tokens   Prompt: lite
```

### Key configuration (settings.json or env vars)

| Setting                   | Env var                           | Default                | Notes                                                                   |
| ------------------------- | --------------------------------- | ---------------------- | ----------------------------------------------------------------------- |
| `local.url`               | `GEMINI_LOCAL_URL`                | —                      | Required to activate local mode                                         |
| `local.model`             | `GEMINI_LOCAL_MODEL`              | `local-model`          | Sent in every request                                                   |
| `local.timeout`           | `GEMINI_LOCAL_TIMEOUT`            | `120000` ms            | Hot-reloadable via `/local timeout`                                     |
| `local.contextLimit`      | `GEMINI_LOCAL_CONTEXT_LIMIT`      | auto / 32768           | Hot-reloadable                                                          |
| `local.promptMode`        | `GEMINI_LOCAL_PROMPT_MODE`        | `lite`                 | `lite` or `full`                                                        |
| `local.temperature`       | `GEMINI_LOCAL_TEMPERATURE`        | unset (model default)  | Sampling temperature 0.0–2.0. Recommend `0.6` for Qwen3 coding/tool-use |
| `local.topP`              | `GEMINI_LOCAL_TOP_P`              | unset (server default) | Nucleus sampling cutoff (0, 1]. Hot-reloadable via `/local topp`        |
| `local.topK`              | `GEMINI_LOCAL_TOP_K`              | unset (server default) | Top-k sampling cutoff. `-1` disables. Hot-reloadable via `/local topk`  |
| `local.minP`              | `GEMINI_LOCAL_MIN_P`              | unset (server default) | Min-p floor [0, 1]. Hot-reloadable via `/local minp`                    |
| `local.repetitionPenalty` | `GEMINI_LOCAL_REPETITION_PENALTY` | unset (server default) | Repetition penalty (0, 2]. `1.0` disables. Via `/local reppen`          |
| `local.toolCallParsing`   | `GEMINI_LOCAL_TOOL_CALL_PARSING`  | `lenient`              | `strict` \| `lenient` \| `loose`. Hot-reloadable via `/local toolcall`  |
| `local.enableTools`       | `GEMINI_LOCAL_TOOLS`              | `false`                | Set `true` for vLLM with `--enable-auto-tool-choice`                    |

All local-preset settings can be changed live without restarting via the
`/provider` command (e.g. `/provider set local-vllm model …`,
`/provider set local-vllm url …`). After migration, the keys above live under
`providers.local-vllm.*` in `settings.json`.

### Mistral / Devstral-specific notes

When running a Mistral-family model (Devstral, Mixtral, Codestral, etc.) with
vLLM's `--tool-call-parser mistral` flag, this fork automatically:

- Sanitizes tool-call IDs to the required 9-character alphanumeric format
- Inserts a synthetic `assistant(".")` bridge message between any `tool` →
  `user` role transition
- Synthesizes dummy tool responses for orphaned tool calls (session resume)

These patches are detected by model name and do not affect Qwen, Gemma, or other
models.

### Tool-call parser hardening (`local.toolCallParsing`)

Some models (notably **Mistral 4 119B** and **NVIDIA Nemotron 3 Super**) emit
tool calls as raw text in the `content` field instead of the structured
`tool_calls` field — and not always in a clean `<tool_call>...</tool_call>`
wrapper. The fork ships a content-side recovery parser with three modes:

| Mode                | Matches                                                                                                                                         | Use when                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `strict`            | Only `<tool_call>...</tool_call>` wrapped blocks                                                                                                | Security-sensitive contexts, or any time you treat model output as untrusted input                                                       |
| `lenient` (default) | Wrapped blocks, **plus** bare `<function=...>` blocks **only when an orphaned `</tool_call>` closer is present** in the content (intent signal) | Default. Keeps Qwen / Gemma / Devstral 24B byte-identical to before, and recovers Nemotron 3 / Mistral 4                                 |
| `loose`             | Any `<function=...>` block anywhere in the content                                                                                              | Power-user opt-in. Has documentation-injection risk (a model writing a tutorial about tool-call syntax could trigger an accidental call) |

Change the mode at any time without restarting via `/provider` (the
`/local toolcall …` form was removed in Phase 2.2):

```text
/provider set local-vllm toolCallParsing strict
/provider set local-vllm toolCallParsing lenient
/provider set local-vllm toolCallParsing loose
```

### Tested models (DGX Spark)

The following combinations were exercised with **gemini-cli-local** on an
**NVIDIA DGX Spark** (local vLLM). Use them as a reference for flags and context
limits; your hardware may need different `--max-model-len` or memory settings.

| Model                                         | vLLM flags (add to your `vllm serve` line)                                                                                                                 | Context / memory notes                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Qwen 3 Coder Next FP8 (~72B)**              | `--enable-auto-tool-choice`<br>`--tool-call-parser qwen3_coder`<br>`--kv-cache-dtype fp8`<br>**No** `--reasoning-parser`                                   | Do NOT add a reasoning parser — it intercepts `<tool_call>` XML and routes it to `delta.reasoning`, silently discarding all tool calls. FP8 KV cache required to fit 72GB weights + 65K context on 128 GB. See detailed entry below.                                                                                                                                                    |
| **Qwen 3.5 27B Dense (BF16)**                 | `--enable-auto-tool-choice`<br>`--tool-call-parser hermes`<br>`--reasoning-parser deepseek_r1`                                                             | Comfortable at **65536** tokens (`--max-model-len 65536`).                                                                                                                                                                                                                                                                                                                              |
| **Google Gemma 4 31B Dense (BF16)**           | `--enable-auto-tool-choice`<br>`--tool-call-parser gemma4`<br>`--kv-cache-dtype fp8`                                                                       | FP8 KV cache is CRITICAL — 58 GB BF16 weights leave little room; fp8 compression enables a full **131072** context window on 128 GB. See detailed entry below.                                                                                                                                                                                                                          |
| **Mistral Devstral Small 2 24B Instruct**     | `--enable-auto-tool-choice`<br>`--tool-call-parser mistral`                                                                                                | Comfortable at **100000** tokens. With the Mistral tool parser, the server enforces OpenAI-style rules; this fork aligns tool-call IDs and message roles accordingly.                                                                                                                                                                                                                   |
| **NVIDIA Nemotron 3 Super 120B A12B (NVFP4)** | `--enable-auto-tool-choice`<br>`--tool-call-parser hermes`<br>`--reasoning-parser deepseek_r1`<br>and env:<br>`VLLM_NVFP4_GEMM_BACKEND=flashinfer-cutlass` | The `deepseek_r1` reasoning parser is required — without it, Nemotron's chain-of-thought leaks into `content` because the model emits an orphaned `</think>` closer. On the tested ARM64 stack, the `VLLM_NVFP4_GEMM_BACKEND` env avoided Marlin-related crashes. Run with **`--max-model-len 32768`** and **`--gpu-memory-utilization 0.92`** to fit within **128 GB** unified memory. |

#### Recommended models (latest verified on DGX Spark, 128 GB unified memory)

These configurations were end-to-end verified with **gemini-cli-local**:
streaming responses, reasoning isolation, and multi-turn tool dispatch all
behave correctly. Pair the vLLM flags with the matching
`~/.gemini/settings.json` values for best results.

##### Qwen 3.6 35B (A3B Quantized)

- **Status:** 🏆 The Ultimate Champion. Flawless architecture, incredible
  reasoning, and fully capable of one-shotting massive multi-file applications
  with a 131K context window.
- **vLLM flags:**
  - `--enable-auto-tool-choice`
  - `--tool-call-parser qwen3_coder`
  - `--reasoning-parser deepseek_r1` — crucial for intercepting Qwen's "Hybrid
    Thinking" tags so the monologue routes to `delta.reasoning` (CLI thought
    bubble) instead of leaking into `delta.content`.
  - `--language-model-only` — crucial for disabling the vision encoder; saves a
    massive amount of VRAM.
- **Gemini CLI settings (`~/.gemini/settings.json`):**

  ```json
  {
    "local": {
      "temperature": 0.6,
      "contextLimit": 131072,
      "toolCallParsing": "strict"
    }
  }
  ```

  `0.6` is the mathematical sweet spot for Qwen reasoning models. A3B is highly
  compressed, so it can comfortably hold 131,000 tokens of "photographic memory"
  on 128 GB unified memory at `--gpu-memory-utilization 0.85`.

##### Qwen 3 Coder Next FP8 (~72B)

- **Status:** Verified, but prone to "context squishing" syntax errors on very
  long sessions as the history compresses. Plan for ~30–40 sequential tool calls
  before context pressure appears; break large tasks into multiple sessions.
- **vLLM flags:**
  - `--enable-auto-tool-choice`
  - `--tool-call-parser qwen3_coder`
  - `--kv-cache-dtype fp8` — **CRITICAL.** The 72 GB FP8 weights consume nearly
    all of 128 GB. This flag halves the KV cache footprint, making a 65K context
    window viable without OOM.
  - `--gpu-memory-utilization 0.88`
  - `--max-model-len 65536`
  - **Do NOT use `--reasoning-parser`.** We verified that adding
    `--reasoning-parser deepseek_r1` causes the parser to intercept
    `<tool_call>` XML and route it to `delta.reasoning`, silently discarding all
    tool calls. The CLI's client-side `splitThinkContent` handles any `<think>`
    tags correctly without a server-side reasoning parser.
- **Gemini CLI settings (`~/.gemini/settings.json`):**

  ```json
  {
    "local": {
      "temperature": 0.6,
      "contextLimit": 65536,
      "timeout": 600000,
      "toolCallParsing": "strict"
    }
  }
  ```

  `timeout: 600000` (10 minutes) is necessary — this is a 72B model that thinks
  deeply before each response. The default 2-minute timeout fires before the
  first tool call on complex prompts. Do not set `topP`, `minP`, or
  `repetitionPenalty`; Qwen3's `generation_config.json` defaults are well-tuned.

##### Google Gemma 4 26B (A4B Quantized)

- **Status:** Highly Recommended. Phenomenally fast, defensive vanilla-JS
  coding. No internal monologue (so it streams faster), but it occasionally
  struggles with complex DOM lifecycle logic compared to Qwen.
- **vLLM flags:**
  - `--enable-auto-tool-choice`
  - `--tool-call-parser gemma4`
  - (No `--reasoning-parser` needed — Gemma 4 does not emit `<think>` tags.)
- **Gemini CLI settings (`~/.gemini/settings.json`):**

  ```json
  {
    "local": {
      "temperature": 0.7,
      "contextLimit": 65536
    }
  }
  ```

  `65536` is the maximum safe context at `--gpu-memory-utilization 0.85` due to
  the size of the 26B A4B weights.

##### Google Gemma 4 31B (Uncompressed BF16)

- **Status:** Verified. Lightning-fast, phenomenal vanilla-JS generation, and
  highly defensive coding logic. The uncompressed BF16 weights preserve full
  precision, giving it an edge on complex DOM lifecycle tasks compared to the
  A4B quantized variant.
- **vLLM flags:**
  - `--enable-auto-tool-choice`
  - `--tool-call-parser gemma4`
  - `--kv-cache-dtype fp8` — **CRITICAL.** The uncompressed BF16 weights consume
    ~58 GB of VRAM. Without FP8 KV cache compression, there is not enough room
    for a useful context window on a 128 GB machine. With it, Gemma can hold a
    colossal 131K context window safely.
- **Gemini CLI settings (`~/.gemini/settings.json`):**

  ```json
  {
    "local": {
      "temperature": 0.7,
      "contextLimit": 131072,
      "toolCallParsing": "strict"
    }
  }
  ```

  `contextLimit: 131072` is the headline advantage of this model: the FP8 KV
  cache compression frees enough VRAM that the full 131K window is achievable on
  128 GB — giving it the same photographic memory as Qwen 3.6 35B A3B, but with
  Gemma's fast streaming speed. No reasoning parser needed; Gemma 4 does not
  emit `<think>` tags.

##### ZhipuAI GLM-4.7-Flash (Dense 30B)

- **Status:** Verified, but requires extreme configuration to prevent infinite
  tool-calling loops. The default `temperature: 0.7` traps GLM in an "I'm sorry"
  hallucination loop when calling tools. Running at `temperature: 1.0` is the
  critical fix. Still has latent looping tendencies on very long autonomous
  sessions (30+ sequential tool calls); for those workloads prefer Qwen 3.6 35B
  A3B.
- **vLLM flags:**
  - `--enable-auto-tool-choice`
  - `--tool-call-parser glm47`
  - `--reasoning-parser deepseek_r1` — **CRITICAL.** GLM natively leaks orphan
    `</think>` closing tags into the content stream. The `deepseek_r1` streaming
    delta parser intercepts these and pipes them to the thought bubble, keeping
    the CLI history clean. `glm45` is the model-native parser but `deepseek_r1`
    is preferred because its streaming logic handles the orphaned closer more
    reliably.
- **Gemini CLI settings (`~/.gemini/settings.json`) — for short interactive use
  only, not long autonomous agents:**

  ```json
  {
    "local": {
      "temperature": 1.0,
      "contextLimit": 65536,
      "toolCallParsing": "strict"
    }
  }
  ```

  `temperature: 1.0` is the critical value — `0.7` (Z.ai's documented
  recommendation) causes GLM to lock into a repetitive "I'm sorry, I cannot do
  that" loop when tool calls are involved. `1.0` forces execution. GLM's KV
  cache is very "wide" and consumes ~48 GB of VRAM. Do not push the context
  higher than 65K on a 128 GB machine or the OS will OOM-kill the container.

---

## Architecture overview

```
User prompt
     │
     ▼
GeminiClient (packages/core/src/core/client.ts)
     │
     ▼
createContentGenerator(eff = config.getEffectiveProviderConfig())
     │  switch (eff.wireFormat)
     │
     ├──'openai-chat'──► OpenAICompatContentGenerator ──► fetch() ──► vLLM / Ollama / OpenAI / Azure / Groq …
     │                     packages/core/src/core/localLlmContentGenerator.ts
     │                     • Gemini SDK types → OpenAI messages
     │                     • Mistral patches (tool-call ID, role transitions, orphan fill)
     │                     • Authorization: Bearer <apiKey> for hosted; none for local
     │                     • SSE streaming + non-streaming retry
     │
     └──'gemini'──────► Upstream Google GenAI client (unchanged)
                          dispatched by eff.authType:
                          • LOGIN_WITH_GOOGLE  → personal OAuth
                          • USE_GEMINI         → $GEMINI_API_KEY
                          • USE_VERTEX_AI      → Vertex AI / ADC
```

The `ProviderDefinition` registry
(`packages/core/src/providers/providerRegistry.ts`) declares `wireFormat`,
`authType`, and `validSettingKeys` for every entry, so the dispatcher above is
data-driven; adding a new Gemini-flavored or OpenAI-compatible preset is a
registry edit, not a code path change.

Context management layers (local mode only, in order of execution):

1. Pre-turn budget check (`preTurnBudget.ts`) — proactive compress at 80% fill
2. Write-file ejection (`writeFileEjection.ts`) — replaces large file payloads
   with compact markers
3. Force compress (`chatCompressionService.ts`) — hard compress when overflow
   predicted
4. History truncation (`historyTruncation.ts`) — drop oldest pairs as last
   resort

---

## Fork maintenance

This fork tracks upstream `google-gemini/gemini-cli`. To rebase:

```bash
git fetch upstream
git rebase upstream/main
```

All fork-only additions are fenced with
`// --- LOCAL FORK ADDITION (Phase X) ---` comments so conflict resolution is
straightforward. No upstream files have been deleted or reformatted; all changes
are additive and gated on `isLocalMode()`.

Architectural decisions, phase history, known constraints, and pending TODOs are
tracked in a local `AGENT.md` file (not version-controlled).

---

## Upstream README

The original upstream README follows below.

---

# Gemini CLI

[![Gemini CLI CI](https://github.com/google-gemini/gemini-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/google-gemini/gemini-cli/actions/workflows/ci.yml)
[![Gemini CLI E2E (Chained)](https://github.com/google-gemini/gemini-cli/actions/workflows/chained_e2e.yml/badge.svg)](https://github.com/google-gemini/gemini-cli/actions/workflows/chained_e2e.yml)
[![Version](https://img.shields.io/npm/v/@google/gemini-cli)](https://www.npmjs.com/package/@google/gemini-cli)
[![License](https://img.shields.io/github/license/google-gemini/gemini-cli)](https://github.com/google-gemini/gemini-cli/blob/main/LICENSE)
[![View Code Wiki](https://assets.codewiki.google/readme-badge/static.svg)](https://codewiki.google/github.com/google-gemini/gemini-cli?utm_source=badge&utm_medium=github&utm_campaign=github.com/google-gemini/gemini-cli)

![Gemini CLI Screenshot](/docs/assets/gemini-screenshot.png)

Gemini CLI is an open-source AI agent that brings the power of Gemini directly
into your terminal. It provides lightweight access to Gemini, giving you the
most direct path from your prompt to our model.

Learn all about Gemini CLI in our [documentation](https://geminicli.com/docs/).

## 🚀 Why Gemini CLI?

- **🎯 Free tier**: 60 requests/min and 1,000 requests/day with personal Google
  account.
- **🧠 Powerful Gemini 3 models**: Access to improved reasoning and 1M token
  context window.
- **🔧 Built-in tools**: Google Search grounding, file operations, shell
  commands, web fetching.
- **🔌 Extensible**: MCP (Model Context Protocol) support for custom
  integrations.
- **💻 Terminal-first**: Designed for developers who live in the command line.
- **🛡️ Open source**: Apache 2.0 licensed.

## 📦 Installation

See
[Gemini CLI installation, execution, and releases](https://www.geminicli.com/docs/get-started/installation)
for recommended system specifications and a detailed installation guide.

### Quick Install

#### Run instantly with npx

```bash
# Using npx (no installation required)
npx @google/gemini-cli
```

#### Install globally with npm

```bash
npm install -g @google/gemini-cli
```

#### Install globally with Homebrew (macOS/Linux)

```bash
brew install gemini-cli
```

#### Install globally with MacPorts (macOS)

```bash
sudo port install gemini-cli
```

#### Install with Anaconda (for restricted environments)

```bash
# Create and activate a new environment
conda create -y -n gemini_env -c conda-forge nodejs
conda activate gemini_env

# Install Gemini CLI globally via npm (inside the environment)
npm install -g @google/gemini-cli
```

## Release Channels

See [Releases](https://www.geminicli.com/docs/changelogs) for more details.

### Preview

New preview releases will be published each week at UTC 23:59 on Tuesdays. These
releases will not have been fully vetted and may contain regressions or other
outstanding issues. Please help us test and install with `preview` tag.

```bash
npm install -g @google/gemini-cli@preview
```

### Stable

- New stable releases will be published each week at UTC 20:00 on Tuesdays, this
  will be the full promotion of last week's `preview` release + any bug fixes
  and validations. Use `latest` tag.

```bash
npm install -g @google/gemini-cli@latest
```

### Nightly

- New releases will be published each day at UTC 00:00. This will be all changes
  from the main branch as represented at time of release. It should be assumed
  there are pending validations and issues. Use `nightly` tag.

```bash
npm install -g @google/gemini-cli@nightly
```

## 📋 Key Features

### Code Understanding & Generation

- Query and edit large codebases
- Generate new apps from PDFs, images, or sketches using multimodal capabilities
- Debug issues and troubleshoot with natural language

### Automation & Integration

- Automate operational tasks like querying pull requests or handling complex
  rebases
- Use MCP servers to connect new capabilities, including
  [media generation with Imagen, Veo or Lyria](https://github.com/GoogleCloudPlatform/vertex-ai-creative-studio/tree/main/experiments/mcp-genmedia)
- Run non-interactively in scripts for workflow automation

### Advanced Capabilities

- Ground your queries with built-in
  [Google Search](https://ai.google.dev/gemini-api/docs/grounding) for real-time
  information
- Conversation checkpointing to save and resume complex sessions
- Custom context files (GEMINI.md) to tailor behavior for your projects

### GitHub Integration

Integrate Gemini CLI directly into your GitHub workflows with
[**Gemini CLI GitHub Action**](https://github.com/google-github-actions/run-gemini-cli):

- **Pull Request Reviews**: Automated code review with contextual feedback and
  suggestions
- **Issue Triage**: Automated labeling and prioritization of GitHub issues based
  on content analysis
- **On-demand Assistance**: Mention `@gemini-cli` in issues and pull requests
  for help with debugging, explanations, or task delegation
- **Custom Workflows**: Build automated, scheduled and on-demand workflows
  tailored to your team's needs

## 🔐 Authentication Options

Choose the authentication method that best fits your needs:

### Option 1: Sign in with Google (OAuth login using your Google Account)

**✨ Best for:** Individual developers as well as anyone who has a Gemini Code
Assist License. (see
[quota limits and terms of service](https://cloud.google.com/gemini/docs/quotas)
for details)

**Benefits:**

- **Free tier**: 60 requests/min and 1,000 requests/day
- **Gemini 3 models** with 1M token context window
- **No API key management** - just sign in with your Google account
- **Automatic updates** to latest models

#### Start Gemini CLI, then choose _Sign in with Google_ and follow the browser authentication flow when prompted

```bash
gemini
```

#### If you are using a paid Code Assist License from your organization, remember to set the Google Cloud Project

```bash
# Set your Google Cloud Project
export GOOGLE_CLOUD_PROJECT="YOUR_PROJECT_ID"
gemini
```

### Option 2: Gemini API Key

**✨ Best for:** Developers who need specific model control or paid tier access

**Benefits:**

- **Free tier**: 1000 requests/day with Gemini 3 (mix of flash and pro)
- **Model selection**: Choose specific Gemini models
- **Usage-based billing**: Upgrade for higher limits when needed

```bash
# Get your key from https://aistudio.google.com/apikey
export GEMINI_API_KEY="YOUR_API_KEY"
gemini
```

### Option 3: Vertex AI

**✨ Best for:** Enterprise teams and production workloads

**Benefits:**

- **Enterprise features**: Advanced security and compliance
- **Scalable**: Higher rate limits with billing account
- **Integration**: Works with existing Google Cloud infrastructure

```bash
# Get your key from Google Cloud Console
export GOOGLE_API_KEY="YOUR_API_KEY"
export GOOGLE_GENAI_USE_VERTEXAI=true
gemini
```

For Google Workspace accounts and other authentication methods, see the
[authentication guide](https://www.geminicli.com/docs/get-started/authentication).

## 🚀 Getting Started

### Basic Usage

#### Start in current directory

```bash
gemini
```

#### Include multiple directories

```bash
gemini --include-directories ../lib,../docs
```

#### Use specific model

```bash
gemini -m gemini-2.5-flash
```

#### Non-interactive mode for scripts

Get a simple text response:

```bash
gemini -p "Explain the architecture of this codebase"
```

For more advanced scripting, including how to parse JSON and handle errors, use
the `--output-format json` flag to get structured output:

```bash
gemini -p "Explain the architecture of this codebase" --output-format json
```

For real-time event streaming (useful for monitoring long-running operations),
use `--output-format stream-json` to get newline-delimited JSON events:

```bash
gemini -p "Run tests and deploy" --output-format stream-json
```

### Quick Examples

#### Start a new project

```bash
cd new-project/
gemini
> Write me a Discord bot that answers questions using a FAQ.md file I will provide
```

#### Analyze existing code

```bash
git clone https://github.com/google-gemini/gemini-cli
cd gemini-cli
gemini
> Give me a summary of all of the changes that went in yesterday
```

## 📚 Documentation

### Getting Started

- [**Quickstart Guide**](https://www.geminicli.com/docs/get-started) - Get up
  and running quickly.
- [**Authentication Setup**](https://www.geminicli.com/docs/get-started/authentication) -
  Detailed auth configuration.
- [**Configuration Guide**](https://www.geminicli.com/docs/reference/configuration) -
  Settings and customization.
- [**Keyboard Shortcuts**](https://www.geminicli.com/docs/reference/keyboard-shortcuts) -
  Productivity tips.

### Core Features

- [**Commands Reference**](https://www.geminicli.com/docs/reference/commands) -
  All slash commands (`/help`, `/chat`, etc).
- [**Custom Commands**](https://www.geminicli.com/docs/cli/custom-commands) -
  Create your own reusable commands.
- [**Context Files (GEMINI.md)**](https://www.geminicli.com/docs/cli/gemini-md) -
  Provide persistent context to Gemini CLI.
- [**Checkpointing**](https://www.geminicli.com/docs/cli/checkpointing) - Save
  and resume conversations.
- [**Token Caching**](https://www.geminicli.com/docs/cli/token-caching) -
  Optimize token usage.

### Tools & Extensions

- [**Built-in Tools Overview**](https://www.geminicli.com/docs/reference/tools)
  - [File System Operations](https://www.geminicli.com/docs/tools/file-system)
  - [Shell Commands](https://www.geminicli.com/docs/tools/shell)
  - [Web Fetch & Search](https://www.geminicli.com/docs/tools/web-fetch)
- [**MCP Server Integration**](https://www.geminicli.com/docs/tools/mcp-server) -
  Extend with custom tools.
- [**Custom Extensions**](https://geminicli.com/docs/extensions/writing-extensions) -
  Build and share your own commands.

### Advanced Topics

- [**Headless Mode (Scripting)**](https://www.geminicli.com/docs/cli/headless) -
  Use Gemini CLI in automated workflows.
- [**IDE Integration**](https://www.geminicli.com/docs/ide-integration) - VS
  Code companion.
- [**Sandboxing & Security**](https://www.geminicli.com/docs/cli/sandbox) - Safe
  execution environments.
- [**Trusted Folders**](https://www.geminicli.com/docs/cli/trusted-folders) -
  Control execution policies by folder.
- [**Enterprise Guide**](https://www.geminicli.com/docs/cli/enterprise) - Deploy
  and manage in a corporate environment.
- [**Telemetry & Monitoring**](https://www.geminicli.com/docs/cli/telemetry) -
  Usage tracking.
- [**Tools reference**](https://www.geminicli.com/docs/reference/tools) -
  Built-in tools overview.
- [**Local development**](https://www.geminicli.com/docs/local-development) -
  Local development tooling.

### Troubleshooting & Support

- [**Troubleshooting Guide**](https://www.geminicli.com/docs/resources/troubleshooting) -
  Common issues and solutions.
- [**FAQ**](https://www.geminicli.com/docs/resources/faq) - Frequently asked
  questions.
- Use `/bug` command to report issues directly from the CLI.

### Using MCP Servers

Configure MCP servers in `~/.gemini/settings.json` to extend Gemini CLI with
custom tools:

```text
> @github List my open pull requests
> @slack Send a summary of today's commits to #dev channel
> @database Run a query to find inactive users
```

See the
[MCP Server Integration guide](https://www.geminicli.com/docs/tools/mcp-server)
for setup instructions.

## 🤝 Contributing

We welcome contributions! Gemini CLI is fully open source (Apache 2.0), and we
encourage the community to:

- Report bugs and suggest features.
- Improve documentation.
- Submit code improvements.
- Share your MCP servers and extensions.

See our [Contributing Guide](./CONTRIBUTING.md) for development setup, coding
standards, and how to submit pull requests.

Check our [Official Roadmap](https://github.com/orgs/google-gemini/projects/11)
for planned features and priorities.

## 📖 Resources

- **[Free Course](https://learn.deeplearning.ai/courses/gemini-cli-code-and-create-with-an-open-source-agent/information)** -
  Learn the basics.
- **[Official Roadmap](./ROADMAP.md)** - See what's coming next.
- **[Changelog](https://www.geminicli.com/docs/changelogs)** - See recent
  notable updates.
- **[NPM Package](https://www.npmjs.com/package/@google/gemini-cli)** - Package
  registry.
- **[GitHub Issues](https://github.com/google-gemini/gemini-cli/issues)** -
  Report bugs or request features.
- **[Security Advisories](https://github.com/google-gemini/gemini-cli/security/advisories)** -
  Security updates.

### Uninstall

See the [Uninstall Guide](https://www.geminicli.com/docs/resources/uninstall)
for removal instructions.

## 📄 Legal

- **License**: [Apache License 2.0](LICENSE)
- **Terms of Service**:
  [Terms & Privacy](https://www.geminicli.com/docs/resources/tos-privacy)
- **Security**: [Security Policy](SECURITY.md)

<p align="left">
 <a href="https://www.star-history.com/google-gemini/gemini-cli">
  <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/badge?repo=google-gemini/gemini-cli&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/badge?repo=google-gemini/gemini-cli" />
   <img alt="Star History Rank" src="https://api.star-history.com/badge?repo=google-gemini/gemini-cli" />
  </picture>
 </a>
</p>

---

<p align="center">
  Built with ❤️ by Google and the open source community
</p>
