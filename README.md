# gemini-cli-local

> **This is a private fork of
> [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli).** It
> extends the official CLI with a "Local LLM Bypass" that routes requests to any
> local OpenAI-compatible server (vLLM, Ollama, llama.cpp, etc.) while keeping
> all upstream Gemini / Vertex AI paths fully intact.
>
> The binary is named `gemini-local-cli` so it coexists with a standard
> `gemini-cli` install on the same machine.

---

## What is different from upstream

| Area                           | Upstream gemini-cli                | gemini-cli-local                                                                  |
| ------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------- |
| **Backend**                    | Google Gemini / Vertex AI only     | Local OpenAI-compatible endpoint + Gemini (switchable)                            |
| **Binary name**                | `gemini`                           | `gemini-local-cli` (avoids PATH collision)                                        |
| **Auth**                       | Google OAuth / API key / Vertex    | All of the above **plus** `AuthType.LOCAL` (no key required)                      |
| **Context management**         | 1 M-token Gemini window            | 4-layer proactive defense for small local windows (32 K–100 K)                    |
| **Mistral / Devstral support** | N/A                                | Tool-call ID sanitization, orphan-tool-call patching, role-transition bridging    |
| **Local model discovery**      | N/A                                | Auto-queries `GET /v1/models`, hybrid picker in `/model` dialog                   |
| **Settings hot-reload**        | Restart required for most settings | `local.url`, `local.model`, `local.promptMode`, `local.timeout` reload live       |
| **`/local` command**           | N/A                                | Dialog + sub-commands (`show`, `url`, `model`, `prompt`, `timeout`)               |
| **System prompt**              | Full Gemini prompt                 | Selectable: `lite` (optimized for small local models) or `full`                   |
| **Tool call format**           | Gemini SDK native                  | Translated to OpenAI `tool_calls` / `tool` messages with Mistral-specific patches |

---

## Setup and running (local mode)

### Dependencies

- Node.js 20+
- npm 10+
- A running OpenAI-compatible inference server (vLLM, Ollama, llama.cpp)

### Build from source

```bash
git clone <this-repo>
cd gemini-cli
npm install
npm run build
```

### Run

```bash
# Point at your local vLLM / Ollama server
# local.url can be the full chat endpoint or just the server root — both work.
# The CLI auto-normalises the path before appending /v1/models for discovery.
export GEMINI_LOCAL_URL=http://127.0.0.1:8000/v1/chat/completions
export GEMINI_LOCAL_MODEL=mistralai/Devstral-Small-2-24B-Instruct-2512

node packages/cli/dist/index.js
# or after global npm install:
gemini-local-cli
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

| Setting                 | Env var                          | Default               | Notes                                                                   |
| ----------------------- | -------------------------------- | --------------------- | ----------------------------------------------------------------------- |
| `local.url`             | `GEMINI_LOCAL_URL`               | —                     | Required to activate local mode                                         |
| `local.model`           | `GEMINI_LOCAL_MODEL`             | `local-model`         | Sent in every request                                                   |
| `local.timeout`         | `GEMINI_LOCAL_TIMEOUT`           | `120000` ms           | Hot-reloadable via `/local timeout`                                     |
| `local.contextLimit`    | `GEMINI_LOCAL_CONTEXT_LIMIT`     | auto / 32768          | Hot-reloadable                                                          |
| `local.promptMode`      | `GEMINI_LOCAL_PROMPT_MODE`       | `lite`                | `lite` or `full`                                                        |
| `local.temperature`     | `GEMINI_LOCAL_TEMPERATURE`       | unset (model default) | Sampling temperature 0.0–2.0. Recommend `0.6` for Qwen3 coding/tool-use |
| `local.toolCallParsing` | `GEMINI_LOCAL_TOOL_CALL_PARSING` | `lenient`             | `strict` \| `lenient` \| `loose`. Hot-reloadable via `/local toolcall`  |
| `local.enableTools`     | `GEMINI_LOCAL_TOOLS`             | `false`               | Set `true` for vLLM with `--enable-auto-tool-choice`                    |

All local settings can be changed live without restarting via the `/local`
command.

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

Change the mode at any time without restarting:

```text
/local toolcall strict
/local toolcall lenient
/local toolcall loose
```

### Tested models (DGX Spark)

The following combinations were exercised with **gemini-cli-local** on an
**NVIDIA DGX Spark** (local vLLM). Use them as a reference for flags and context
limits; your hardware may need different `--max-model-len` or memory settings.

| Model                                         | vLLM flags (add to your `vllm serve` line)                                                                                                                 | Context / memory notes                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Qwen 3 Coder Next FP8 (~72B)**              | `--enable-auto-tool-choice`<br>`--tool-call-parser hermes`<br>`--reasoning-parser deepseek_r1`                                                             | Tool calling and `<think>` / redacted-thinking style tags worked with this stack. Needs a **large** context budget: `--max-model-len` **45056** or higher so the CLI system prompt fits.                                                                                                                                                                                                |
| **Qwen 3.5 27B Dense (BF16)**                 | `--enable-auto-tool-choice`<br>`--tool-call-parser hermes`<br>`--reasoning-parser deepseek_r1`                                                             | Comfortable at **65536** tokens (`--max-model-len 65536`).                                                                                                                                                                                                                                                                                                                              |
| **Google Gemma 4 31B Dense (BF16)**           | `--enable-auto-tool-choice`<br>`--tool-call-parser gemma4`                                                                                                 | No separate reasoning parser. Comfortable at **65536** tokens.                                                                                                                                                                                                                                                                                                                          |
| **Mistral Devstral Small 2 24B Instruct**     | `--enable-auto-tool-choice`<br>`--tool-call-parser mistral`                                                                                                | Comfortable at **100000** tokens. With the Mistral tool parser, the server enforces OpenAI-style rules; this fork aligns tool-call IDs and message roles accordingly.                                                                                                                                                                                                                   |
| **NVIDIA Nemotron 3 Super 120B A12B (NVFP4)** | `--enable-auto-tool-choice`<br>`--tool-call-parser hermes`<br>`--reasoning-parser deepseek_r1`<br>and env:<br>`VLLM_NVFP4_GEMM_BACKEND=flashinfer-cutlass` | The `deepseek_r1` reasoning parser is required — without it, Nemotron's chain-of-thought leaks into `content` because the model emits an orphaned `</think>` closer. On the tested ARM64 stack, the `VLLM_NVFP4_GEMM_BACKEND` env avoided Marlin-related crashes. Run with **`--max-model-len 32768`** and **`--gpu-memory-utilization 0.92`** to fit within **128 GB** unified memory. |

---

## Architecture overview

```
User prompt
     │
     ▼
GeminiClient (packages/core/src/core/client.ts)
     │  isLocalMode()?
     ├──YES──► LocalLlmContentGenerator  ──► fetch() ──► vLLM / Ollama
     │           packages/core/src/core/localLlmContentGenerator.ts
     │           • Gemini SDK types → OpenAI messages
     │           • Mistral patches (tool-call ID, role transitions, orphan fill)
     │           • SSE streaming + non-streaming retry
     │
     └──NO───► Upstream Gemini / Vertex AI path (unchanged)
```

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

See [AGENT.md](AGENT.md) for full architectural decisions, phase history, known
constraints, and pending TODOs.

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
