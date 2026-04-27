SYSTEM PROMPT: GEMINI CLI LOCAL LLM FORK

PERSONA You are a Senior-Level TypeScript/Node.js Engineer and Open Source
Contributor with decades of experience. You are an expert in CLI tool
development, REST API architecture, and LLM orchestration (specifically the
OpenAI API standard and the Google @google/genai SDK).

THE MISSION The user has forked the official google-gemini/gemini-cli
repository. Your singular objective is to architect and implement a clean,
native "Local LLM Bypass" directly into the core networking layer of the CLI.

Currently, the CLI hardcodes requests to Google's backend. You must intercept
these requests and route them to a local OpenAI-compatible server (e.g., vLLM or
Ollama running on localhost:8000) whenever a specific configuration flag is
present.

CORE REQUIREMENTS

1.  The Bypass Trigger: Implement a configuration flag (e.g., in
    ~/.gemini/config.json or via an environment variable like GEMINI_LOCAL_URL)
    that, when detected, cleanly intercepts the request before it reaches the
    @google/genai SDK.
2.  The Translator: You must write a translation layer that takes the CLI's
    internal representation of the conversation history and formats it into a
    standard OpenAI JSON payload: {"model": "local-model", "messages": [{"role":
    "user", "content": "..."}]}.
3.  The Streaming Interface: The local request must be sent as a streamed POST
    request (using fetch or Node's native http/https modules). You must parse
    the Server-Sent Events (SSE) data: {...} chunks coming from the local server
    and pipe the text deltas directly back into the existing Gemini CLI terminal
    UI renderers.
4.  Zero UI Disruption: Do not break or rewrite the terminal rendering logic,
    the spinner animations, or the markdown formatting. Only intercept the
    network boundary.

RULES OF ENGAGEMENT

1.  Research First: Before making any edits, deeply investigate the gemini-cli
    source code (specifically the files handling API requests, configuration
    loading, and streaming execution). Understand the existing data structures
    before injecting the bypass.
2.  Surgical Edits: Use precise diffs. Do not rewrite entire files if you only
    need to inject a conditional if (localUrl) { ... } else { ... } block.
3.  No External Dependencies: Do not add massive new dependencies (like the
    openai npm package) to package.json if you can natively fetch the
    OpenAI-compatible endpoint. Keep the fork lightweight.
4.  Hardware Context: Assume the local LLM is a massive 72B+ parameter model
    running on a DGX Spark via vLLM on
    http://127.0.0.1:8000/v1/chat/completions.
5.  You don't only take the happy path.
6.  You use latest stable versions.
7.  CRITICAL: you never suppress errors or warnings. You fix them. This includes
    deprecation warnings.
8.  CRITICAL: this app needs to live with regular gemini-cli installed. When
    compiling or running this, you will name it gemini-local-cli 9: CRITICAL:
    you keep an updated AGENT.md with your persona, these rules, project status,
    TODOs and anything else that will help new AI agents.
9.  CRITICAL: Do NOT delete, gut, or disable any existing Gemini-specific code.
    All Google SDK paths, auth flows, CodeAssist logic, model resolution, and
    Vertex AI wiring must remain intact. Phase 2 reuses them.
10. CRITICAL: Use **git rebase-safe patterns** on every change so this fork can
    track upstream google-gemini/gemini-cli with minimal conflict pain:
    - Prefer **additive** changes: new modules/files for fork-only behavior;
      extend upstream types/APIs instead of replacing them.
    - **Never** reformat, rename, or “clean up” unrelated upstream code in the
      same commit as a feature fix.
    - When you must touch an upstream-owned file, keep edits **minimal** and
      fence them with `// --- LOCAL FORK ADDITION (...)` (or equivalent) so
      merges and rebases surface conflicts in obvious blocks.
    - Gate fork behavior with explicit switches (e.g. `isLocalMode()`,
      `AuthType.LOCAL`) so upstream paths stay byte-for-byte equivalent when
      those switches are off.
    - Use **collision-proof naming** for new Config/settings/API surface (e.g.
      `getLocal*`, `local.*` settings keys) so upstream additions cannot
      accidentally shadow fork symbols.
    - Document new fork-only files in AGENT.md so rebasers know what is “ours”
      versus upstream.
11. CRITICAL: Every new slash command (and every sub-command) MUST be
    discoverable from `/help` and from any other documented help surface.
    Concretely, when adding or renaming a command:
    - The top-level `SlashCommand` MUST have a non-empty `description` and MUST
      NOT set `hidden: true` (those two fields are exactly what
      `packages/cli/src/ui/components/Help.tsx` filters on, so anything else
      will silently disappear from `/help`).
    - Each `subCommand` MUST also have its own `description` and MUST NOT set
      `hidden: true` for the same reason.
    - If the command has user-facing behavior beyond a single dialog (setters,
      shortcuts, modes), expose those as named sub-commands so they appear under
      the parent in `/help`. Do NOT hide functionality behind argument parsing
      only — `/help` cannot introspect args.
    - Update **every** secondary help/documentation surface that lists commands.
      As of Phase 2.0.2 these are:
      - `docs/reference/commands.md` — the canonical user-facing reference.
        ALWAYS update this when adding/renaming a command.
      - `packages/cli/src/acp/commandHandler.ts` — the ACP (headless /
        programmatic) command registry, surfaced to clients via `HelpCommand`.
        Only register a command here if it can run **without** opening an
        interactive dialog (e.g. `/local show`, but NOT `/local` itself, which
        opens an Ink dialog). When in doubt, leave it out and note the reason in
        the command's source comment.
      - any command-specific README the parent owns If you add a new help
        surface, add it to this list in this rule.
    - Add at least one test that asserts the new command (and each sub-command)
      appears in the rendered `/help` output. The pattern is already established
      in `packages/cli/src/ui/commands/helpCommand.test.ts` (assert
      `lastFrame()` contains `'/<name>'` and the description text).
    - Keep descriptions ≤ 100 characters (the `sanitizeForDisplay` call in
      `Help.tsx` truncates beyond that).

PROJECT STATUS: Phase 1 Complete The Local LLM Bypass is implemented and
compiles/lints cleanly.

ARCHITECTURE Intercept point: the ContentGenerator interface in
packages/core/src/core/contentGenerator.ts. A new LocalLlmContentGenerator
(packages/core/src/core/localLlmContentGenerator.ts) implements this interface
and is selected by the createContentGenerator() factory when a local URL is
detected.

Config trigger (priority: env > settings): - GEMINI_LOCAL_URL → URL of the
OpenAI-compatible chat completions endpoint - GEMINI_LOCAL_MODEL → model name
sent in requests (default: "local-model") - GEMINI_LOCAL_TIMEOUT → request
timeout in ms (default: 120000) - Or: settings.json → local.url / local.model /
local.timeout

Auth bypass: AuthType.LOCAL added. getAuthTypeFromEnv() returns LOCAL when
GEMINI_LOCAL_URL is set. refreshAuth() in Config short-circuits for local mode.
Both interactive and non-interactive auth paths handle LOCAL without requiring
API keys.

Translation layer: Gemini ContentListUnion/Parts → OpenAI messages array
systemInstruction → system message functionCall parts → tool_calls
functionResponse parts → tool messages Tool declarations → OpenAI function tools

Streaming: Native fetch() with SSE parsing (line-by-line, data: prefix
extraction). Each OpenAI chunk mapped to GenerateContentResponse via
Object.setPrototypeOf (same pattern as FakeContentGenerator) so SDK getters
(functionCalls, text) work.

Binary: gemini-local-cli bin entry added to both packages/cli/package.json and
root package.json.

FILES CREATED packages/core/src/core/localLlmContentGenerator.ts

FILES MODIFIED (additive only — no Gemini code removed)
packages/core/src/core/contentGenerator.ts — AuthType.LOCAL, local URL branch in
factory, env detection packages/core/src/config/config.ts —
localUrl/localModel/localTimeout in ConfigParameters + getters + refreshAuth
bypass packages/cli/src/config/config.ts — env var + settings wiring into
ConfigParameters packages/cli/src/config/settingsSchema.ts — local.url /
local.model / local.timeout schema packages/cli/src/config/auth.ts —
AuthType.LOCAL passthrough packages/cli/src/ui/auth/useAuth.ts — interactive
auth auto-detect for local mode packages/cli/src/utils/sandbox.ts — forward
GEMINI*LOCAL*\* env vars into sandbox packages/cli/package.json —
gemini-local-cli bin entry package.json — gemini-local-cli bin entry

PHASE 1.5 COMPLETE: Branding, update check, lightweight prompt

- CLI banner shows "gemini-cli-local v1.0.0 (Gemini CLI v...)" in local mode
- GitHub releases update check replaces npm check in local mode
- Lightweight system prompt (~3-4K chars) for local LLMs (local.promptMode:
  lite|full)
- Identity override removed; lite prompt handles it natively
- SSE parser reads both delta.reasoning and delta.reasoning_content fields
- XML tool call fallback parser for Qwen-style <tool_call> content
- Non-streaming retry when streaming returns empty tool_calls

PHASE 1.7 COMPLETE: Local Model Discovery + Hybrid Model Picker Architecture
(rebase-safe — all logic in new standalone files):

Files created:

- packages/core/src/core/localModelDiscovery.ts — fetchLocalModels() queries GET
  /v1/models, LocalModelInfo type, isLocalModelId(),
  mergeLocalModelsIntoOptions()
- packages/core/src/core/localModelBridge.ts — discoverAndStoreLocalModels(),
  switchModelAcrossBoundary() (fire-and-forget with rollback),
  awaitGeneratorReady()
- packages/cli/src/ui/components/LocalModelSection.tsx — standalone Ink
  component for local model picker section

Files modified (minimal additive only):

- packages/core/src/config/config.ts — discoveredLocalModels field +
  getters/setters, generatorSwapPromise field + getters/setters,
  localModelOverride + setter, one call to discoverAndStoreLocalModels(this) in
  refreshAuth LOCAL branch
- packages/cli/src/ui/components/ModelDialog.tsx — import + conditional render
  of LocalModelSection (2 lines)
- packages/core/src/index.ts — exports for discovery and bridge modules

Design decisions:

- Model ID prefix scheme: local models use "local:" prefix (e.g.
  "local:google/gemma-4-31b-it")
- Cross-boundary swap (local↔Gemini): fire-and-forget with
  generatorSwapPromise, rollback on failure, awaitGeneratorReady() guards
  requests during swap
- Discovery is best-effort: /v1/models failure → empty array → fallback entry
- Hybrid picker: Gemini models show if credentials exist, local models show if
  local URL is set
- Conversation history carries over across model swaps (already in common
  format)
- setModel() is NOT modified — bridge has its own switchModelAcrossBoundary()

PHASE 1.8 COMPLETE: Local Context Limits + Token Counting

- Configurable context limit: local.contextLimit in settings.json or
  GEMINI_LOCAL_CONTEXT_LIMIT env var (default: 32768)
- Auto-detect from server: /v1/models max_model_len field stored in
  LocalModelInfo, used as fallback when no explicit limit is set
- Priority chain: env var > settings > auto-detected max_model_len > 32768
  default
- Fixed tokenLimit() usage in client.ts processTurn(): uses
  getLocalContextLimit() for local models instead of the 1M Gemini default
- Fixed compression threshold in chatCompressionService.ts: uses local limit
- Fixed tool output truncation threshold in config.ts
  getTruncateToolOutputThreshold()
- Real token usage tracking: reads
  usage.prompt_tokens/completion_tokens/total_tokens from both streaming (final
  chunk) and non-streaming OpenAI responses, maps to Gemini SDK usageMetadata
  (promptTokenCount/candidatesTokenCount/totalTokenCount)
- countTokens() now uses estimateTokenCountSync() heuristic instead of returning
  0
- GEMINI_LOCAL_CONTEXT_LIMIT forwarded to sandbox
- Result: tryCompressChat() and ContextWindowWillOverflow now trigger correctly
  for local models, preventing vLLM OOM/500 errors

PHASE 1.9 COMPLETE: Smart low-context recovery (3-layer defense) Problem: vLLM
with 45K context cap was rejecting requests with HTTP 400 even after Phase 1.8,
because (a) compression triggered too late at 50% threshold, (b) when soft
compression failed silently the CLI hard-stopped instead of retrying, and (c)
there was no fallback if force-compression also failed.

Architecture (rebase-safe — recovery logic in new standalone files):

Files created:

- packages/core/src/context/historyTruncation.ts — pure helper
  truncateHistoryToFit(history, targetTokens, estimateFn). Drops oldest user/
  model pairs, preserves first 2 entries (system + initial user task), respects
  functionCall/functionResponse pairing.
- packages/core/src/context/localContextRecovery.ts — orchestration module
  attemptLocalContextRecovery() runs Layer 2 (force-compress) then Layer 3
  (hard-truncate) with try/catch around every risky call. Never throws.

Files modified (minimal additive only):

- packages/cli/src/config/settingsSchema.ts — local.compressionThreshold (0.4),
  local.preserveFraction (0.2), local.autoTruncateOnOverflow (true)
- packages/cli/src/config/config.ts — wire 3 env vars + settings into params
- packages/core/src/config/config.ts — fields, getters, getCompressionThreshold
  early-return for local mode, DEFAULT_LOCAL_COMPRESSION_THRESHOLD constants
- packages/core/src/core/turn.ts — added HISTORY_TRUNCATED to existing
  CompressionStatus enum (1 additive enum entry, no new event type)
- packages/core/src/context/chatCompressionService.ts — replaced one direct
  COMPRESSION_PRESERVE_THRESHOLD reference with getPreserveThreshold(config)
  helper (added at bottom of file, defers to local override when in local mode)
- packages/core/src/core/client.ts — inserted ~25 additive lines BEFORE the
  existing overflow guard; existing guard line stays semantically identical
  (only `const remainingTokenCount` changed to `let` to allow reassignment)
- packages/cli/src/ui/hooks/useGeminiStream.ts — branch on HISTORY_TRUNCATED in
  chat-compression handler; append local-mode hint in overflow handler
- packages/cli/src/utils/sandbox.ts — forward 3 new env vars

3-layer defense flow (only active in local mode): Layer 1: Soft compress at
lower threshold (0.4 vs cloud 0.5), preserve less (0.2 vs cloud 0.3). Runs on
every turn via existing tryCompressChat. Layer 2: When overflow predicted,
force-compress (force=true). Wrapped in try/catch so a stressed server's failure
doesn't crash the turn. Layer 3: If force-compress fails or doesn't free enough,
drop oldest history pairs via truncateHistoryToFit. Disabled by setting
local.autoTruncateOnOverflow=false. Final: If all 3 fail, fall through to
upstream's existing overflow event with an improved hint message pointing at the
tunables.

Tunables (settings.json local.\*, env var equivalents in parens):

- compressionThreshold (GEMINI_LOCAL_COMPRESSION_THRESHOLD) — default 0.4
- preserveFraction (GEMINI_LOCAL_PRESERVE_FRACTION) — default 0.2
- autoTruncateOnOverflow (GEMINI_LOCAL_AUTO_TRUNCATE) — default true
- SAFETY_MARGIN_TOKENS — hardcoded 1024 inside localContextRecovery.ts

PHASE 2.0 COMPLETE: Smart Local Context Management (4-layer proactive defense)
Problem: even with Phase 1.9, small (32K) local windows still showed
compress-then-immediately-overflow loops. Diagnosis: ToolOutputMaskingService
required ~80K of accumulated tool output before firing (twice the entire context
window), so large read_file outputs and write_file content payloads sat in
history and kept the model permanently near capacity.

Architecture (rebase-safe — all logic in new standalone files; upstream files
get minimal additive changes only, gated on isLocalMode()):

Files created:

- packages/core/src/context/localMaskingDefaults.ts — pure helper that scales
  ToolOutputMaskingService thresholds (protectionThresholdTokens,
  minPrunableThresholdTokens) to localContextLimit. Defaults: 0.15 protection
  fraction (~4.8K of 32K), 0.10 prunable fraction (~3.2K). Floors at 2K/1K to
  prevent collapse on tiny windows.
- packages/core/src/context/preTurnBudget.ts — pure assessTurnBudget() helper
  that projects (history + request + reservedResponseTokens) before each turn.
  If projection >= proactiveCompressAt of contextLimit, returns
  shouldCompressFirst=true. Defaults: 4096 reserved, 0.80 trigger.
- packages/core/src/context/writeFileEjection.ts — pure
  ejectStaleWriteFileContent() that replaces stale write_file
  functionCall.args.content with a compact <file_written path="..." cached=true>
  marker. Preserves args.file_path so the model can re-read on demand. Respects
  PRESERVE_LEADING_ENTRIES=2, EXEMPT_TOOLS, and protectLatestTurn. Idempotent.
  Defaults: minAgeTurns=1, minTokensPerCall=200.
- packages/core/src/context/adaptiveThreshold.ts — per-session ring buffer
  (size 5) of compression ratios. When >85% of the original tokens survive a
  compression, tightens the threshold by 0.05 per weak sample (max 3 steps per
  cooldown window). Floor 0.35; cooldown 5 turns; auto-disabled when
  local.compressionThreshold is set explicitly.

Files modified (minimal additive, ALL gated on isLocalMode()):

- packages/cli/src/config/settingsSchema.ts — local.toolOutputMasking,
  local.preTurnBudget, local.writeFileEjection, local.adaptiveCompression blocks
  (all additive at end of local.\* section)
- packages/cli/src/config/config.ts — wire 12 new env vars + settings
- packages/cli/src/utils/sandbox.ts — forward 12 new env vars
- packages/core/src/config/config.ts — fields + getters for all four layers,
  ONE-line override at top of getToolOutputMaskingConfig() (returns
  getLocalMaskingDefaults(this) when local mode + enabled),
  getEffectiveCompressionThreshold(turnIndex) wrapper around
  getCompressionThreshold() that defers to adaptiveThreshold module,
  recordCompressionResult() proxy
- packages/core/src/context/chatCompressionService.ts — swapped one line:
  getCompressionThreshold() → getEffectiveCompressionThreshold(turnIndex).
  Outside local mode the returned value is identical (passthrough).
- packages/core/src/core/client.ts — three additive blocks all gated on
  isLocalMode(): pre-turn budget check before tryCompressChat, write-file
  ejection after tryMaskToolOutputs, recordCompressionResult after every
  compress. All wrapped in try/catch so a layer failure can never abort a turn —
  the existing Phase 1.9 reactive recovery still runs.

Tunables (settings.json local.\*, env var equivalents in parens):

- toolOutputMasking.enabled (GEMINI_LOCAL_TOOL_MASK_ENABLED) — default true
- toolOutputMasking.protectionFraction
  (GEMINI_LOCAL_TOOL_MASK_PROTECTION_FRACTION) — default 0.15
- toolOutputMasking.prunableFraction (GEMINI_LOCAL_TOOL_MASK_PRUNABLE_FRACTION)
  — default 0.10
- toolOutputMasking.protectLatestTurn (GEMINI_LOCAL_TOOL_MASK_PROTECT_LATEST) —
  default true
- preTurnBudget.enabled (GEMINI_LOCAL_PRE_TURN_BUDGET_ENABLED) — default true
- preTurnBudget.reservedResponseTokens (GEMINI_LOCAL_PRE_TURN_RESERVED_RESPONSE)
  — default 4096
- preTurnBudget.proactiveCompressAt (GEMINI_LOCAL_PRE_TURN_COMPRESS_AT) —
  default 0.80
- writeFileEjection.enabled (GEMINI_LOCAL_WRITE_FILE_EJECT_ENABLED) — default
  true
- writeFileEjection.minAgeTurns (GEMINI_LOCAL_WRITE_FILE_EJECT_MIN_AGE) —
  default 1
- writeFileEjection.minTokensPerCall (GEMINI_LOCAL_WRITE_FILE_EJECT_MIN_TOKENS)
  — default 200
- adaptiveCompression.enabled (GEMINI_LOCAL_ADAPTIVE_COMPRESSION_ENABLED) —
  default true
- adaptiveCompression.cooldownTurns (GEMINI_LOCAL_ADAPTIVE_COMPRESSION_COOLDOWN)
  — default 5
- adaptiveCompression.floor (GEMINI_LOCAL_ADAPTIVE_COMPRESSION_FLOOR) — default
  0.35

Persona / system-prompt safety:

- The system prompt + persona are sent via systemInstruction (separate from chat
  history). NONE of the new layers ever touch systemInstruction.
- The first 2 history entries (env context + initial user task) are preserved by
  all four layers (writeFileEjection enforces PRESERVE_LEADING_ENTRIES=2; the
  others operate on tool output / turn metadata only).
- writeFileEjection NEVER removes the file_path from args; the model can always
  recover by calling read_file. The marker advertises the file with cached=true
  so the model knows the content lives on disk.
- Adaptive threshold has a hard floor (0.35) AND a cooldown to bound the
  compounding-summarization-loss risk over many turns.

Rebase safety:

- All four layer modules are NEW files in packages/core/src/context/, never
  edited by upstream.
- Every modification to upstream files is fenced with a "// --- LOCAL FORK
  ADDITION (Phase 2.0) ---" comment so conflicts are obvious during rebase.
- Every additive Config getter has a clear name prefix (getLocal\*) that cannot
  collide with upstream additions.
- The single chatCompressionService.ts swap is a 1-line change with a
  passthrough fallback (outside local mode, behavior is identical).

Test coverage (all new pure modules have dedicated unit suites):

- packages/core/src/context/localMaskingDefaults.test.ts (5 tests)
- packages/core/src/context/preTurnBudget.test.ts (6 tests)
- packages/core/src/context/writeFileEjection.test.ts (7 tests)
- packages/core/src/context/adaptiveThreshold.test.ts (9 tests)

PHASE 2.0 FOLLOW-UPS — writeFileEjection marker leakback (ordered by importance)

CONTEXT: A real session with Qwen3-Coder produced corrupted files on disk. Root
cause: the model pattern-matched the `<file_written ...>` ejection marker it saw
in its OWN modified chat history (after Layer 3 had replaced older write_file
payloads with the marker), then reproduced the marker text as the `content`
argument of NEW write_file tool calls. Layer 3 itself never touches the
filesystem; the failure was purely a model-misinterpretation feedback loop.

DONE — Phase 2.0.1 defense-in-depth (shipped):

- packages/core/src/tools/write-file.ts now refuses writes whose `content`
  starts with `<file_written ` when isLocalMode() is true. Returns a
  recovery-oriented error message so the model can retry with real content.
- 4 new unit tests in write-file.test.ts cover the sentinel, leading whitespace,
  upstream pass-through, and embedded-substring false positives.

DONE — Phase 2.0.2 local-mode UX improvements (shipped):

1. Header surfaces live local settings. UserIdentity.tsx now renders an indented
   sub-block under "Authenticated with local /auth" showing URL / Model /
   Context / Prompt mode, so users can confirm at a glance which endpoint and
   model their session is talking to. Reads through the existing Config getters
   so the values stay in sync with hot-reloaded settings. 2 new tests in
   UserIdentity.test.tsx cover the local-mode render and the negative case (no
   sub-block for non-local auth).
2. Hot-reload of local.url / local.model / local.promptMode. Dropped `readonly`
   on those three Config fields and added Config.refreshLocalConfig({ url?,
   model?, promptMode? }) which mutates the cached fields and calls
   refreshAuth(LOCAL) to rebuild the ContentGenerator. Settings schema now marks
   these three keys `requiresRestart: false` (parent `local` block too, since
   every child is now hot). LocalDialog.tsx wires applyHotReload() into the
   toggle / edit-commit / clear handlers, and surfaces refreshAuth failures
   inline in a red footer. localPromptMode is safe to hot-reload because
   getLocalSystemPrompt() is read fresh on every turn.
3. Punycode DEP0040 investigation. See KNOWN CONSTRAINTS section below. Bundled
   prod CLI is DEP0040-clean (all bare `require('punycode')` sites resolve to
   the bundled userland punycode), but Node 22+ users may still see the warning
   once at startup from a transitive load path that we cannot reproduce locally
   on Node 20.18.2. Documented under KNOWN CONSTRAINTS rather than suppressed,
   per Rule 13.

Files touched in 2.0.2:

- packages/cli/src/ui/components/UserIdentity.tsx (header sub-block)
- packages/cli/src/ui/components/UserIdentity.test.tsx (2 new tests)
- packages/cli/src/ui/components/LocalDialog.tsx (hot-reload wiring)
- packages/cli/src/config/settingsSchema.ts (requiresRestart flips)
- packages/core/src/config/config.ts (refreshLocalConfig + mutable fields)
- AGENT.md (this entry + KNOWN CONSTRAINTS DEP0040 entry)

DONE — Phase 2.0.3 /local sub-commands + /help discoverability rule (shipped):

1. New Rule 11 in RULES OF ENGAGEMENT mandating that every new slash command
   (and every sub-command) MUST be discoverable from /help and from every other
   canonical help surface. Lists exactly which surfaces qualify today
   (docs/reference/commands.md always; ACP commandHandler.ts only for
   non-interactive commands) and the structural requirements (description, not
   hidden, ≤100 chars, test coverage).
2. /local now exposes hot-reload sub-commands so users (and /help) get
   actionable shortcuts in addition to the dialog:
   - /local show -> print URL/model/prompt/context inline
   - /local url <url> -> hot-reload local.url via refreshLocalConfig
   - /local model <model> -> hot-reload local.model
   - /local prompt <lite|full> -> hot-reload local.promptMode (validated) All
     setters trim input, reject empty values with a clear "Usage:" line, surface
     refreshLocalConfig errors inline (so unreachable URLs etc. don't crash the
     turn), and preserve the field on failure so the user can fix it via /local.
     /local with no args still opens the dialog (unchanged).
3. docs/reference/commands.md updated with a /local section (alphabetical,
   between /init and /mcp) documenting the dialog + every sub-command and noting
   it's a fork-only command.
4. localCommand.test.ts grew to 13 tests covering: parent dialog return,
   sub-command structure (every sub has a description, none hidden — this is
   what makes /help list them), /local show output (active + inactive modes +
   missing-Config error), each setter dispatching the correct refreshLocalConfig
   call, prompt-mode validation, usage errors on empty args, and
   refreshLocalConfig rejection surfacing without crashing.

Files touched in 2.0.3:

- AGENT.md (Rule 11 + this status entry)
- docs/reference/commands.md (new /local section)
- packages/cli/src/ui/commands/localCommand.ts (sub-commands implementation)
- packages/cli/src/ui/commands/localCommand.test.ts (10 new tests)

DONE — Phase 2.0.4 Mistral / Devstral tool-call-id sanitization (shipped):

Symptom: Devstral 2 (Mistral-family, run on vLLM with
`--tool-call-parser mistral`) failed on the very first tool-response turn with
HTTP 400: "Tool call id was ad_file_0 but must be a-z, A-Z, 0-9, with a length
of 9."

Root cause: contentToMessages() generated tool ids as `call_${name}_${counter}`
(e.g. `call_read_file_0`, 16 chars with underscores). vLLM's mistral tool-call
parser strictly enforces /^[a-zA-Z0-9]{9}$/ on every assistant `tool_calls[].id`
AND every tool message `tool_call_id`. The pair must also match exactly so the
model can correlate. Qwen / Gemma / OpenAI accept arbitrary strings, so they
never hit this — but anything routed through Mistral's parser bounced.

Fix: new pure helper `mistralSafeToolCallId(rawId)` in
packages/core/src/core/localLlmContentGenerator.ts. Strips every
non-alphanumeric char; if the result is ≥9 chars, returns the trailing 9 (this
preserves the counter suffix that disambiguates sibling calls, e.g. `readfile0`
vs `readfile1`); otherwise left-pads with `0` to exactly 9 chars. Pure +
deterministic so the assistant tool_call id and the tool message tool_call_id —
generated from independent counters in two separate contentToMessages calls —
collide on identical (name, counter) input, which is the property vLLM requires.

Backward compatibility: Qwen / Gemma / Ollama / OpenAI all accept any string as
a tool_call_id, so a 9-char alphanumeric id is still a valid identifier for
them. No behavior change for those models.

Both ID-generation sites in contentToMessages are wrapped with
`// --- LOCAL FORK ADDITION (Phase 2.0.4) ---` fences for rebase safety.

Tests: 8 new unit tests in localLlmContentGenerator.test.ts cover the 9-char
invariant, the alphanumeric-only invariant, determinism, sibling uniqueness (the
foot-gun case), the assistant↔tool pair-match property, short-name padding,
long-name truncation, and idempotency on already-valid ids. All 18 tests in that
file pass; chatCompressionService, write-file, preTurnBudget, writeFileEjection,
and client tests (88+101 tests) all green — confirming the Qwen/Gemma path is
untouched.

Files touched in 2.0.4:

- packages/core/src/core/localLlmContentGenerator.ts (helper + 2 sites)
- packages/core/src/core/localLlmContentGenerator.test.ts (8 new tests)
- AGENT.md (this entry)

DONE — Phase 2.0.5 Mistral / Devstral tool→user role transition fix (shipped):

Symptom: Devstral 2 (Mistral-family, run on vLLM with
`--tool-call-parser mistral`) failed with HTTP 400 on the turn AFTER a tool
response: "Unexpected role 'user' after role 'tool'."

Root cause: Mistral's strict OpenAI-compat parser forbids a `user` message that
immediately follows a `tool` message — after a tool result, the assistant MUST
speak before the user does (or, when stitching history, the next message must be
`assistant`). Two natural gemini-cli flows trip this:

1. The user types a follow-up prompt right after a turn that ended on a tool
   response (history stitching during the next prompt assembles [..., tool,
   user] back-to-back).
2. A single Gemini Content carries BOTH a `functionResponse` part and a `text`
   part. contentToMessages serializes the functionResponse first (push as
   `tool`) and then the text (push as `user`) — `tool` then `user` inside the
   same turn.

Qwen / Gemma / Llama / OpenAI all accept this transition silently, so the bug
was Mistral-specific.

Fix: two new pure helpers in packages/core/src/core/localLlmContentGenerator.ts,
both exported for testability:

- `isMistralFamilyModel(modelId)` — case-insensitive substring match on the
  published model id. Conservative regex covers the entire Mistral AI catalog
  (mistral, devstral, mixtral, codestral, magistral, ministral) without matching
  anything else (qwen, gemma, llama, gpt, claude, deepseek, phi, yi, command-r
  all verified negative).

- `patchToolUserTransitionForMistral(messages, modelId)` — pure, non-mutating
  post-pass that walks the assembled OpenAIMessage[] and inserts a single
  synthetic assistant message (`MISTRAL_TOOL_USER_BRIDGE_CONTENT = "."`) between
  every `tool` → `user` transition. Returns the input unchanged when
  isMistralFamilyModel(modelId) is false. Bridge content is a single dot so it
  costs ~1 token and stays semantically neutral; non-empty so servers that ALSO
  reject empty assistant content accept it.

Wired into translateRequest as the FINAL step before returning, so it sees the
complete assembled message order (handles both root causes above with a single
pass). Marked with `// --- LOCAL FORK ADDITION (Phase 2.0.5) ---` fences for
rebase safety.

Backward compatibility: For non-Mistral models the helper is a literal identity
function — Qwen / Gemma / Llama / OpenAI conversations are returned without
traversal, allocation, or modification.

Tests: 19 new unit tests in localLlmContentGenerator.test.ts cover model
detection (positive list of 9 Mistral-family ids, negative list of 10
non-Mistral ids), bridge insertion on tool→user, no-op on tool→assistant and
tool-at-end and user→tool, multiple transitions in one history, multi-tool turn
(consecutive tools followed by one user → exactly one bridge after the last
tool), empty arrays, non-mutation, and bridge-content non-emptiness. All 47
tests in that file pass; client (83), write-file (47), chatCompressionService
(28), preTurnBudget (6) all still green.

Files touched in 2.0.5:

- packages/core/src/core/localLlmContentGenerator.ts (2 helpers + wiring)
- packages/core/src/core/localLlmContentGenerator.test.ts (19 new tests)
- AGENT.md (this entry)

DONE — Phase 2.0.10 stale-socket "fetch failed" hardening (shipped):

Symptom: After long-running generations on large local models (Mistral 119B /
Nemotron 120B, multi-minute thinking), the next request from the same CLI
session would fail immediately with `Cannot reach local LLM ... fetch failed`
even though `curl` to the same URL responded HTTP 200 in ~3ms. vLLM's own logs
showed no incoming request — the failure was entirely client-side, inside Node's
`fetch` before the bytes ever left the process.

Root cause: Node 20's bundled `undici` keeps a process-wide HTTP/1.1 keep-alive
pool. Sockets to the local vLLM endpoint can be silently dropped by the kernel
TCP keep-alive timer, by Docker's userland proxy, or by vLLM's own keep-alive
timeout firing before ours. The pool doesn't notice the dead socket until the
next write attempt, surfacing as the unhelpful `TypeError: fetch failed`. This
is a well-documented Node localhost long-lived-client failure mode.

Fix: dedicated per-instance undici Agent in
`packages/core/src/core/localLlmContentGenerator.ts` with aggressive idle
reaping plus a single retry-on-stale-socket attempt. Loaded via dynamic
`import('undici')` so the upstream Gemini path never pulls undici directly.

Settings (hardcoded — not user-tunable; if they need to be, expose later under
`local.http.*`):

- keepAliveTimeout: 1500 ms — close idle sockets quickly so the half-life of a
  stale connection stays well under realistic server-side keep-alive timeouts.
- keepAliveMaxTimeout: 5000 ms — hard cap regardless of negotiated timeout.
- connectTimeout: 30000 ms — bounded TCP connect.
- connections: 4 — small pool; we never need more than a handful in this CLI.
- pipelining: 0 — disable pipelining; LLM responses are large and serial.

Retry: on `fetch failed` / `UND_ERR_SOCKET` / `other side closed` /
`ECONNRESET`, the helper closes the dispatcher, rebuilds it, and retries exactly
once. Real timeouts (AbortError) are NOT retried — they propagate immediately as
before.

Defense-in-depth: a new `isClosable(v): v is { close(): Promise<void> }`
structural type guard centralizes the dispatcher-close cast so ESLint's
`no-unsafe-type-assertion` rule stays clean.

Verified end-to-end against the live vLLM container (Nemotron 120B, port 8000):
4 scenarios all returned HTTP 200, including a request issued AFTER an idle
period longer than `keepAliveMaxTimeout` (proving fresh-socket reacquisition
works) and a request issued AFTER an explicit dispatcher `.close()` (proving the
recovery path works).

All 66 existing unit tests in localLlmContentGenerator.test.ts still pass. No
new unit tests added — the new logic is pure network-layer behavior that's
better validated by the live integration test above than by mocking fetch.

Files touched in 2.0.10:

- packages/core/src/core/localLlmContentGenerator.ts (dispatcher + retry +
  isClosable helper)
- AGENT.md (this entry)

All changes are fenced with `// --- LOCAL FORK ADDITION (Phase 2.0.10) ---`
markers for rebase safety.

DONE — Phase 2.0.11 broader content-side tool-call recovery (shipped):

Symptom: Mistral 4 119B (running on vLLM with `--tool-call-parser mistral`)
emitted a tool call as raw assistant content instead of as a structured
`tool_calls` array. The model wrote:

<function=write_file> <parameter=file_path>...</parameter>
<parameter=content>...</parameter> </function> </tool_call>

Note the orphaned closing `</tool_call>` with NO matching opener — a model quirk
where the chat template lays down the closer but the model forgot the opener.
vLLM's mistral parser didn't recognize this format, so the entire block came
through as `content` text. The user saw the "tool call" rendered as a code block
in chat instead of actually being executed.

Root cause: the existing client-side fallback parser in
`packages/core/src/core/localLlmContentGenerator.ts` matched
/<tool_call>\s*([\s\S]*?)\s\*<\/tool_call>/g which REQUIRES both the opening and
closing tags. Missing-opener and bare-function variants fell through silently.

Fix: replaced the wrapper-required regex with a wrapper-agnostic one that walks
every `<function=NAME>...</function>` block in the content directly. Inside each
block it still pulls every `<parameter=KEY>VALUE</parameter>` pair the same way
as before. Strict superset of the old behavior — every input that parsed before
still parses; the missing-opener and bare-function variants are now also
recovered.

Refactor: extracted the parser out of the LocalLlmContentGenerator class into a
top-level pure exported function `parseXmlToolCalls(content)`. The class method
is now a one-line delegate. Pure / no I/O / no instance state, so it can be unit
tested without instantiating the generator.

Tests: 8 new unit tests in localLlmContentGenerator.test.ts cover the empty
case, the original wrapped Hermes format (regression), the Mistral 4 119B
orphaned-closer variant, the bare function block, multiple consecutive blocks
(no merging), multi-line parameter content (verbatim preservation), prose-noise
around blocks, and a zero-parameter call. All 74 tests pass.

Files touched in 2.0.11:

- packages/core/src/core/localLlmContentGenerator.ts (extracted helper + broader
  regex)
- packages/core/src/core/localLlmContentGenerator.test.ts (8 new tests)
- AGENT.md (this entry)

All changes are fenced with `// --- LOCAL FORK ADDITION (Phase 2.0.11) ---`
markers for rebase safety.

DONE — Phase 2.0.12 three-mode tool-call parser hardening (shipped):

Symptom + concern: Phase 2.0.11 broadened the content-side parser to recover the
Mistral 4 / Nemotron 3 orphaned-closer pattern. The fix worked but was binary —
bare `<function=...>` blocks were matched anywhere, regardless of context. That
created a real (if rare) false-positive risk: a model writing a tutorial or
documentation that quotes the literal `<function=...>` syntax inside prose could
trigger an unintended tool execution.

Decision (senior-dev call): keep recovery for the broken models but gate it with
a strong "intent signal" so doc-injection doesn't fire under the default, and
expose an opt-in escape hatch in BOTH directions (stricter and looser) for users
who hit edge cases.

Modes (parseXmlToolCalls in localLlmContentGenerator.ts):

- `strict` — only `<tool_call>...</tool_call>` wrapped blocks. Identical to
  pre-Phase-2.0.11 behavior. Zero false-positive risk.
- `lenient` (default) — wrapped blocks PLUS bare `<function=...>` blocks ONLY
  when an orphaned `</tool_call>` is present in the content (closer count >
  opener count). The orphan closer is the "intent signal" — Mistral 4 / Nemotron
  3 emit it as part of their broken output; documentation almost never does.
  Recovers the broken models without enabling fully arbitrary matching.
- `loose` — any `<function=...>` block anywhere. Equivalent to the Phase 2.0.11
  behavior. Power-user opt-in only.

Backward compat: every currently-working model (Qwen / Gemma / Devstral 24B)
emits cleanly wrapped `<tool_call>` blocks. Those flow through the strict path
inside lenient. Their behavior is byte-identical to pre-2.0.12. The modes form a
strict superset chain: any input that matched in strict still matches in lenient
and loose.

Hot-reloadable: parser reads `config.getLocalToolCallParseMode()` on every
response, and `config.refreshLocalConfig({ toolCallParseMode })` updates the
field in-place — no ContentGenerator rebuild, no restart. Surfaced via:

- `/local toolcall <strict|lenient|loose>` — instant switch
- `/local show` — prints the active parser mode
- Header block under "Authenticated with local /auth" — shows `Parser: <mode>`

Config plumbing (matches Phase 2.0.6 timeout pattern):

- settings.json: `local.toolCallParsing` (enum, default `lenient`,
  `requiresRestart: false`)
- env var: `GEMINI_LOCAL_TOOL_CALL_PARSING`
- Config field: `localToolCallParseMode` (mutable; constructor validates and
  silently falls back to `lenient` on invalid input so a typo cannot crash the
  local-mode boot path)

Tests:

- ~22 mode-parameterized parser tests in localLlmContentGenerator.test.ts
  covering: empty / non-tool content (all 3 modes), wrapped input (all 3 modes),
  bare-no-closer (doc-injection safety: strict [] / lenient [] / loose matches),
  bare-with-orphan-closer (Nemotron 3 / Mistral 4: strict [] / lenient recovers
  / loose matches), mixed wrapped + bare-with-closer (no double counting,
  sequential ids), multiple wrapped blocks, multi-line param content
  preservation, zero-parameter calls, default-mode-omitted, defensive
  invalid-mode fallback, prose-without-closer doc safety, balanced closers as
  no-signal. All 90 tests pass.
- 9 new subcommand tests in localCommand.test.ts covering each valid mode, case
  insensitivity, invalid mode rejection, empty arg rejection, refresh failure
  surfacing, and the `Parser:` line in `/local show`.
- Pre-existing subcommand-list test corrected to include `timeout` and
  `toolcall` (was missed in Phase 2.0.6).

Files touched in 2.0.12 (all changes fenced with
`// --- LOCAL FORK ADDITION (Phase 2.0.12) ---`):

- packages/core/src/core/localLlmContentGenerator.ts — three-mode parser +
  helpers (matchWrappedToolCalls, matchAllFunctionBlocks,
  matchBareFunctionBlocksOutsideWrappers, hasOrphanedToolCallCloser)
- packages/core/src/config/config.ts — field, getter, refreshLocalConfig({
  toolCallParseMode })
- packages/cli/src/config/config.ts — wire settings + env var into Config params
- packages/cli/src/config/settingsSchema.ts — `local.toolCallParsing` entry
- packages/cli/src/ui/commands/localCommand.ts — `toolcallSubCommand`,
  `showSubCommand` parser-mode line
- packages/cli/src/ui/components/UserIdentity.tsx — `Parser:` row
- packages/core/src/core/localLlmContentGenerator.test.ts — replaced 8-test
  block with mode-parameterized suite (22 tests)
- packages/cli/src/ui/commands/localCommand.test.ts — toolcall + show tests
- README.md — config table row, "Tool-call parser hardening" subsection
- docs/reference/commands.md — `/local toolcall` entry
- AGENT.md — this entry

Out-of-scope follow-ups (intentional):

- LocalDialog.tsx integration. The `/local toolcall` subcommand and header
  display are sufficient for now; dialog can be added later without touching the
  core parser.
- Per-model auto-detection (e.g. force `lenient` for Mistral / Nemotron).
  Explicit setting is safer for now; revisit once we have telemetry on how often
  users override the default.

---

DONE — Phase 2.0.13 Qwen3/local-LLM quality-of-life fixes (shipped):

Problem set discovered while switching from Nemotron 3 to Qwen3.6-35B-A3B:

1. `/v1/models` discovery URL bug (404 spam in docker logs):
   `localModelDiscovery.ts` naively appended `/v1/models` to whatever the user
   put in `local.url`. When `local.url` is the full chat-completions endpoint
   (`http://127.0.0.1:8000/v1/chat/completions`) — the only form the settings
   dialog and docs ever showed — the result was `/v1/chat/completions/v1/models`
   (404 on every startup). Fallback path handled it gracefully but littered the
   docker logs.

   Fix: `extractServerRoot()` helper that strips trailing OpenAI API path
   suffixes (`/v1/chat/completions`, `/v1/completions`, `/v1`) before appending
   `/v1/models`. `local.url` as either a base URL or a full chat endpoint now
   works correctly.

2. Temperature not forwarded (Qwen3 defaults to temp=1.0 for coding): The CLI
   never sent `temperature` in request bodies. vLLM fell back to the model's
   `generation_config.json`, which for Qwen3.6 is
   `temp=1.0, top_p=0.95, top_k=20` — too stochastic for coding/tool-use.
   Qwen3's official recommendation is 0.6 for non-thinking mode.

   Fix: new `local.temperature` setting (+ `GEMINI_LOCAL_TEMPERATURE` env var).
   When set, forwarded to vLLM in both streaming and non-streaming request
   bodies. `null` / unset = let the server decide (preserves old behaviour).
   Recommended value for Qwen3 coding: 0.6.

3. `toolCallParsing` recommendation updated: Qwen3.6 emits clean structured
   `tool_calls` (verified via direct probe). The `lenient` default is only
   needed for Nemotron/Mistral XML fallback. Updated `~/.gemini/settings.json`
   to `strict` for Qwen3.6.

Files touched (fenced with `// --- LOCAL FORK ADDITION (Phase 2.0.13) ---`):

- packages/core/src/core/localModelDiscovery.ts — `extractServerRoot()`
- packages/core/src/config/config.ts — `localTemperature` field, constructor
  init, `getLocalTemperature()` getter, `localTemperature?: number` in params
- packages/cli/src/config/config.ts — `localTemperature` param wiring
- packages/cli/src/config/settingsSchema.ts — `local.temperature` entry
- packages/core/src/core/localLlmContentGenerator.ts — forward `temperature` in
  generateContent and generateContentStream request bodies
- README.md — `local.temperature` table row, URL normalization note
- AGENT.md — this entry

DONE — Phase 2.0.14 Extended sampling forwarding for local LLMs (shipped):

Motivation: GLM-4.7-Flash exhibits a documented latent looping behavior on long
autonomous tool-calling sessions (e.g. the "WebOS architect" prompt: 30+
sequential tool calls). Initial diagnosis suspected reasoning-leakage into the
content stream; this was ruled out after `--reasoning-parser glm45` /
`deepseek_r1` were verified active and direct vLLM probes confirmed the model
was emitting clean `delta.reasoning` and well-formed `tool_calls` on early
turns. Z.ai's official mitigation per
[Unsloth's GLM-4.7-Flash docs](https://unsloth.ai/docs/models/glm-4.7-flash) is
a specific sampler shape:
`temperature=0.7, top_p=1.0, top_k=-1, min_p=0.01, repetition_penalty=1.0`. vLLM
has no server-side flag to set defaults for `top_p` / `min_p` /
`repetition_penalty` — they must come from the client.

Phase 2.0.13 forwarded only `temperature`. Phase 2.0.14 extends that to four
additional sampler controls, all independently optional:

- `local.topP` (`GEMINI_LOCAL_TOP_P`) — nucleus cutoff (0, 1]
- `local.topK` (`GEMINI_LOCAL_TOP_K`) — integer; `-1` disables
- `local.minP` (`GEMINI_LOCAL_MIN_P`) — floor [0, 1]
- `local.repetitionPenalty` (`GEMINI_LOCAL_REPETITION_PENALTY`) — (0, 2]; `1.0`
  disables

Each is hot-reloadable via `/local topp|topk|minp|reppen <value|off>`. Each is
forwarded as a top-level field in the OpenAI-compatible request body (vLLM
accepts `top_p` natively; `top_k`, `min_p`, `repetition_penalty` are vLLM
extensions also accepted at the top level — no `extra_body` indirection needed
since we write the body directly via `fetch()`).

Design properties:

- **Additive only.** All four fields default to `undefined` / `null`. When
  unset, request bodies omit the field, so other models (Qwen, Gemma, Devstral,
  Nemotron) see byte-identical payloads to Phase 2.0.13.
- **Mirrors Phase 2.0.13 plumbing exactly.** Same fence comments, same env-var
  pattern, same `/local` sub-command pattern, same `refreshLocalConfig`
  hot-reload path. Rebase-safe.
- **Out-of-range values silently coerce to null** (matching the temperature
  validator). The CLI never sends an invalid sampler value to the server.

Files touched (fenced with `// --- LOCAL FORK ADDITION (Phase 2.0.14) ---`):

- packages/core/src/config/config.ts — four new optional params (`localTopP`,
  `localTopK`, `localMinP`, `localRepetitionPenalty`), private fields,
  constructor parsing with range validation, four getters, `refreshLocalConfig`
  update bag entries
- packages/cli/src/config/config.ts — four new param wirings + env-var fallbacks
- packages/cli/src/config/settingsSchema.ts — four `local.*` schema entries
- packages/core/src/core/localLlmContentGenerator.ts — forward the four fields
  in both `generateContent` and `generateContentStream` request bodies
- packages/cli/src/ui/commands/localCommand.ts — `makeSamplerSubCommand()`
  factory + four `/local topp|topk|minp|reppen` sub-commands, updated
  `/local show` output and help string
- packages/core/src/config/localSamplerConfig.test.ts — new fork-only test file
  covering all four getters (defaults, valid values, edge cases, out-of-range
  rejection, env-var fallback) and `refreshLocalConfig` hot-reload semantics (32
  tests, all passing)
- README.md — extended Key configuration table with four new rows; updated the
  GLM-4.7-Flash settings snippet to include the full Z.ai sampler shape with
  citation
- AGENT.md — this entry

Honest caveat: this does not "cure" GLM-4.7-Flash. The Z.ai sampler shape is the
documented best mitigation, but GLM still has latent looping tendencies on very
long autonomous sessions. For 30+ sequential-tool-call agentic builds (e.g.
WebOS architect prompt), Qwen 3.6 35B A3B remains the better choice per the
README's recommended-models section.

EMPIRICAL FINDING (post-Phase 2.0.14, GLM-4.7-Flash on DGX Spark):

Even with all Phase 2.0.14 mitigations applied — Z.ai's full recommended sampler
shape (`temperature 0.7, top_p 1.0, min_p 0.01, repetition_penalty 1.0`),
`--reasoning-parser glm45` (and tested also with `deepseek_r1`),
`local.toolCallParsing: strict`, and the community workaround of bumping
`temperature` to 1.0 — GLM-4.7-Flash still loops uncontrollably on multi-turn
tool-calling sessions. The looping pattern is distinct from the _content_ loops
the sampler shape is designed to prevent: it loops on the _tool-call_ shape
itself, repeatedly emitting the same tool invocation (often with empty/invalid
arguments) until the CLI's loop detector halts it. Direct vLLM probes on turns
1–2 in isolation show the model behaving correctly with clean `delta.reasoning`
and well-formed `tool_calls`, but any prompt requiring 5+ sequential tool calls
(e.g. the WebOS architect prompt) reliably triggers the loop.

Conclusion: GLM-4.7-Flash is **not recommended for autonomous agentic workloads
on this fork.** The README's GLM-4.7-Flash entry has been demoted from
"Verified" to a not-recommended warning. The Phase 2.0.14 sampler plumbing
remains valuable for other models that may benefit from the same controls (e.g.
future GLM iterations, custom sampler tuning per model), so the implementation
is kept; only the GLM-specific recommendation is revoked. Use Qwen 3.6 35B A3B
for autonomous builds; use Gemma 4 26B A4B for short single-shot tasks; use
GLM-4.7-Flash only for short interactive single-turn use.

TODO #1 (highest priority) — Eject from a different SHAPE, not just different
content. Today Layer 3 rewrites `args.content` of the existing `functionCall`
part. Replace the entire `functionCall` part with a `text` part instead, e.g.:
"[ejected write_file to /abs/path/foo.js — 164 lines, recoverable via
read_file]" This removes the `write_file` template from history entirely, so the
model cannot pattern-match a "fill-in-the-content" structure. Touches:

- packages/core/src/context/writeFileEjection.ts (eject-as-text mode)
- packages/core/src/context/writeFileEjection.test.ts (new test suite) Risk:
  some prompt templates may rely on functionCall/functionResponse pairing being
  intact. Add a `local.writeFileEjection.shape: 'inline' | 'text-replace'`
  toggle defaulting to `'text-replace'`; keep `'inline'` available as fallback.

TODO #2 — Make the marker syntactically un-mistakable for content. Replace the
`<file_written ...>` XML-ish tag with a sentinel a model is highly unlikely to
mimic verbatim. Two candidates, pick one: (a) Verbose prose: "[REDACTED-BY-CLI:
original write_file payload to /abs/path/foo.js (164 lines / 1440 tokens) was
ejected to save context; call read_file to recover the live file content]" (b)
Hard sentinel:
"[[GEMINI_LOCAL_CLI_INTERNAL::ejected_write_file::       sha=<8hex>::path=/abs/path/foo.js]]"
Update WRITE_FILE_EJECTION_TAG accordingly and migrate the validator guard
(write-file.ts) and detection logic (`startsWith(...)` re-eject check) in
lockstep. Update documentation and the AGENT.md note above. Lower priority than
#1 because TODO #1 already removes the template surface; this is belt and
suspenders.

TODO #3 — Gate Layer 3 by model class / context size. Smaller / older models are
more vulnerable to the marker-mimicry failure mode. Add:

- local.writeFileEjection.minSafeContextRatio (default 0.5): only enable Layer 3
  when (currentTokens / contextLimit) > minSafeContextRatio. Below that, history
  isn't tight enough to justify ejection AND the model is more likely to misuse
  the marker.
- local.writeFileEjection.modelDenylist: string[] — explicit opt-out list.
  Touches: packages/core/src/core/client.ts (gating before
  ejectStaleWriteFileContent) and packages/cli/src/ui/components/LocalDialog.tsx
  (expose the new knobs).

TODO #4 — Make the marker style configurable. Add
local.writeFileEjection.markerStyle: 'compact' | 'verbose-prose' | 'sentinel' so
users can match the marker to their model's failure modes without code changes.
Defaults to whatever TODO #2 lands on. Lowest priority — purely flexibility on
top of TODOs #1 and #2; most users will be fine with defaults.

PHASE 2 TODOs (not started) - Multiple named local LLM providers in settings,
selectable at runtime - Multiple local server URLs at once - Auth for local
endpoints that require a Bearer token

PHASE 2.1 TODOs — Local Utility Routing (compression + loop detection)

CONTEXT: Even in local mode, two internal utility services always call the
Gemini API via getBaseLlmClient(). Observed in a real 17h session:

- utility_compressor → 68 calls to gemini-3-pro-preview (chatCompressionService)
- utility_loop_detector → 1 call to gemini-3-flash-preview
  (LoopDetectionService) This burns Gemini API quota and prevents fully-local
  operation.

TODO 2.1-A — Local compression routing (HIGH PRIORITY) Route
chatCompressionService through the local LLM (or a configurable "utility model")
instead of getBaseLlmClient() when in local mode.

Design:

- Add settings: local.compressionModel (URL + model for a separate compression
  endpoint, optional) and local.compressionModelFallback: 'gemini' |
  'local-main' | 'truncate-only' (default: 'local-main').
- In chatCompressionService.ts, check config.isLocalMode(). If true:
  - If local.compressionModel is set → call that endpoint directly.
  - Else if fallback='local-main' → call the same local URL/model as main.
  - Else if fallback='truncate-only' → skip LLM summarization entirely; just
    drop oldest turns (safe fallback, zero API cost).
  - Else fallback='gemini' → current behavior (explicit opt-in).
- Expose knob in LocalDialog.tsx under the "Smart Context" section.
- Wrap in isLocalMode() guard so upstream behavior is unchanged. Touches:
  packages/core/src/context/chatCompressionService.ts,
  packages/core/src/config/config.ts (new getters),
  packages/cli/src/config/settingsSchema.ts,
  packages/cli/src/ui/components/LocalDialog.tsx

TODO 2.1-B — Local loop detection routing (LOW PRIORITY, simple) Route
LoopDetectionService through the local LLM when in local mode. Same pattern as
2.1-A: check isLocalMode(), use local endpoint or skip. The loop detector fires
rarely (1 call per session is typical) so this is low urgency but completes the
"fully local" goal. Touches: packages/core/src/core/client.ts
(LoopDetectionService init), packages/core/src/config/config.ts

DONE — Phase 2.1.1 Unify Provider/Local Auth Mode (shipped):

Symptom + concern: Phase 2.1 introduced `AuthType.PROVIDER` as a sibling of
`AuthType.LOCAL`. Both did the same thing wire-protocol-wise (OpenAI Chat
Completions), and both could be "live" at the same time — which produced a real
bug in the wild: a user successfully calling GPT-5 saw the footer report
"Authenticated with local /auth" and `nvidia/...` as the model, because
`useAuth` short-circuited on legacy `local.url` and `Config.refreshAuth` didn't
re-pin `config.model` for the provider path.

Architecture (one sentence): collapse the two parallel auth-types into one
(`AuthType.LOCAL`) and route every OpenAI-compatible endpoint — localhost OR
hosted — through a single materialization point,
`Config.getEffectiveLocalConfig()`.

Key design choices (preserve everything that worked, remove the duplication):

- **One auth type, one code path.** `AuthType.PROVIDER` is removed from the
  enum, from `getAuthTypeFromEnv()`, from `Config.refreshAuth()`'s fast-path,
  from `validateAuthMethod()`, and from the precedence branch in `useAuth`.
  `GEMINI_PROVIDER` still works — it now maps to `AuthType.LOCAL` like
  `GEMINI_LOCAL_URL` does. Net: ~5 fewer rebase fences in upstream-shared files.
- **`/provider` is the canonical command.** Local presets (`local-vllm`,
  `local-llamacpp`, `local-generic`) now live in the same registry as the hosted
  entries with `requiresApiKey: false`. `/provider use local-vllm` works;
  `/provider list` groups output into "Hosted providers" and "Local presets";
  `/provider models <local-id>` skips the auth header;
  `/provider set <local-id> key …` is rejected with an actionable error.
- **`/local` is a deprecated alias.** Still fully functional — same dialog, same
  hot-reload, same `local.*` settings shape. The description nudges toward
  `/provider` and the dialog title reads "Local LLM (deprecated — prefer
  /provider)". This protects every existing vLLM setup (Qwen3-Coder- Next-FP8,
  GLM-4.7-Flash, Gemma 4 31B, Nemotron-3-Nano-30B) — they keep working with no
  settings migration.
- **`getEffectiveLocalConfig()` is the single materialization point.** It
  returns the resolved
  `{url, model, contextLimit, promptMode, parserMode, timeout, enableTools, source, displayName, providerId, requiresApiKey, apiKeyEnvVar}`
  for the active config. Provider path wins when `providers.active` is set;
  legacy-local path is the fallback when only `local.url` is configured. A
  malformed provider config catches and falls back to legacy-local rather than
  locking the user out (the actionable error surfaces later in
  `createContentGenerator`). Existing
  `getLocalUrl/getLocalModel/isLocalMode/getLocalContextLimit/etc.` delegate to
  it, so callers see the right value regardless of which path is live.
- **`UserIdentity` is one block, not two.** The footer reads
  `Active: <displayName>` (e.g. `Active: OpenAI` or `Active: Local vLLM`),
  followed by URL/Model/Context/Prompt/Parser. The `API key:` row is only
  rendered when `requiresApiKey === true`. This removes the entire class of
  "wrong block displayed" bugs.

Files touched (Phase 2.1.1 fences =
`// --- LOCAL FORK ADDITION (Phase 2.1.1) ---`):

- packages/core/src/providers/providerRegistry.ts — extended
  `ProviderDefinition` with `requiresApiKey: boolean`; added `local-vllm`,
  `local-llamacpp`, `local-generic` entries with `requiresApiKey: false`, empty
  `apiKeyEnvVar`, and a `noAuth` header builder.
- packages/core/src/config/config.ts — NEW `getEffectiveLocalConfig()` + private
  `getLegacyLocalContextLimit()`. `refreshAuth(LOCAL)` now calls
  `setModel(eff.model, true)` when source is `provider` so the UI never goes
  stale. `refreshProviderConfig` re-pins to `AuthType.LOCAL`. Existing getters
  (`getLocalUrl`, `getLocalModel`, `isLocalMode`, `isLocalToolsEnabled`,
  `getLocalPromptMode`, `getLocalContextLimit`) delegate to the new method.
- packages/core/src/core/contentGenerator.ts — removed `AuthType.PROVIDER` enum
  value. `getAuthTypeFromEnv()` now maps both `GEMINI_PROVIDER` and
  `GEMINI_LOCAL_URL` to `AuthType.LOCAL`. The LOCAL branch in
  `createContentGenerator` reads `getEffectiveLocalConfig()` and conditionally
  resolves `apiKey` via `resolveProviderApiKey` only when
  `effective.requiresApiKey` is true.
- packages/cli/src/ui/auth/useAuth.ts — removed the `GEMINI_PROVIDER` precedence
  branch; the unified branch now fires when either provider OR legacy-local is
  configured.
- packages/cli/src/config/auth.ts — removed the `AuthType.PROVIDER` arm of
  `validateAuthMethod`.
- packages/cli/src/ui/components/UserIdentity.tsx — collapsed dual local-info /
  provider-info blocks into one block driven by `getEffectiveLocalConfig()`.
  API-key row is conditional.
- packages/cli/src/ui/commands/providerCommand.ts — `/provider list` groups
  hosted providers vs local presets; `/provider models` skips auth header for
  local presets; `/provider set <local-id> key` is rejected.
- packages/cli/src/ui/components/ProviderDialog.tsx — model picker passes empty
  key for local presets; `keyState` reads "not required (local server)"; "API
  key" row is hidden for local-preset providers.
- packages/cli/src/ui/commands/localCommand.ts — kept as deprecated alias.
  Description nudges toward `/provider`; dialog title flagged.
- packages/cli/src/ui/components/LocalDialog.tsx — title reads
  `Local LLM (deprecated — prefer /provider)`.
- packages/core/src/providers/providerModelDiscovery.ts — `apiKey` is now
  optional; `Authorization` header only attached when non-empty.
- packages/core/src/config/getEffectiveLocalConfig.test.ts — NEW. 9 tests
  covering: undefined when nothing is set, provider path with registry defaults,
  override merge, local-preset model placeholder, user override on a local
  preset, legacy-local fallback, malformed-provider soft failure, getter
  delegation, and `isLocalMode` precedence.
- packages/core/src/providers/providerRegistry.test.ts — extended for local
  presets (registry shape, conditional field requirements, apiKeyEnvVar
  uniqueness skipping local presets, model-override preservation).
- packages/cli/src/ui/components/UserIdentity.test.tsx — replaced the single
  local-mode test with two: legacy-local source render and hosted-provider
  source render (with API-key row).
- packages/cli/src/ui/commands/localCommand.test.ts — updated description
  assertion to expect "deprecated" + "/provider"; refreshed the documented
  sub-command list (was already stale before this phase).

Migration safety: existing `~/.gemini/settings.json` with `local.url`,
`local.model`, etc. continues to work without modification. The "Phase 2.1.1
hot-fix" of the footer-vs-traffic mismatch is now structural — there's only one
active mode, so there's only one source of truth for what to display.

DONE — Phase 2.1 Hosted Provider Support, OpenAI first (shipped):

Symptom + concern: the fork until now only supported (a) Google / Code-Assist
auth and (b) the `/local` OpenAI-compat path. Users who wanted to point the same
CLI at hosted endpoints (OpenAI, OpenRouter, Together, Fireworks, etc.) had to
spin up a local proxy. That's strictly worse than just letting the CLI call
those endpoints directly, since they all speak the same OpenAI Chat Completions
wire format the local generator already emits. Phase 2.1 delivers that without
forking the generator.

Architecture (one sentence): generalize `LocalLlmContentGenerator` (re- exported
as `OpenAICompatContentGenerator`) by adding an optional
`{ apiKey, extraHeaders }` constructor arg, then wire it from a new provider
registry + credential store + `/provider` command + UI dialog. Local mode is
byte-identical to pre-Phase-2.1 — when `auth === undefined`, no Authorization
header is sent and the request shape is unchanged.

Key design choices:

- **Reuse, don't fork.** One generator class serves both `/local` (no auth) and
  hosted providers (Bearer + extra headers). All Mistral / Qwen / Devstral /
  Nemotron quirk patches added in Phases 2.0.4–2.0.12 apply unchanged to hosted
  providers; OpenRouter routing to a Mistral model inherits the entire
  orphan-tool-call recovery story for free.
- **Registry is pure data.** `providerRegistry.ts` is a frozen map; the Phase 1
  entry is `openai`. Adding Qwen / Kimi / DeepSeek / Groq / OpenRouter /
  Together / Fireworks / Mistral / xAI is a one-entry append. Anthropic is
  explicitly OUT of scope — it speaks `anthropic-messages` not `openai-chat`, so
  it requires a separate adapter and lands in a follow-up phase.
- **Security model.** API keys live in the OS keychain (one entry per provider,
  namespaced `gemini-cli-provider-<id>`) or in the documented env var
  (`OPENAI_API_KEY`, etc.). Keys are NEVER stored in `settings.json`, NEVER
  logged, and NEVER surfaced through telemetry. `LoggingContentGenerator` only
  forwards request `contents` and response payloads to the telemetry layer — it
  has no access to fetch-level headers, so the Bearer token can't leak through
  that surface even accidentally. There is a regression test
  (`loggingContentGenerator.redaction.test.ts`) that wires a known canary key
  end-to-end and asserts the literal string never appears in any logged event.
- **Hot reload, not restart.**
  `Config.refreshProviderConfig({ active, setConfig, removeProvider })` rebuilds
  the active generator on the next request, mirroring the `refreshLocalConfig`
  shape. No CLI restart is required for `/provider use|set|remove`.
- **Headless and interactive.** Bare `/provider` opens a dialog;
  `/provider list|use|set|remove` work in ACP / non-interactive mode. This
  matches the `/local` command shape and the `/help` discoverability rule (Rule
  11).

Files touched (every block in upstream-shared files is fenced with
`// --- LOCAL FORK ADDITION (Phase 2.1) ---` …
`// --- END LOCAL FORK ADDITION ---` for rebase safety; brand-new files have no
fences per Category C):

- packages/core/src/providers/providerRegistry.ts — NEW. ProviderDefinition
  interface, frozen PROVIDER_REGISTRY map (openai entry), resolveProvider,
  validateProviderInstanceConfig, UnknownProviderError,
  InvalidProviderConfigError.
- packages/core/src/providers/providerCredentialStorage.ts — NEW. Per- provider
  HybridTokenStorage with read-through cache; loadProviderApiKey,
  saveProviderApiKey (throws on keychain failure with actionable message),
  clearProviderApiKey, resolveProviderApiKey (env-wins-over- keychain).
- packages/core/src/index.ts — fenced exports of the two new modules.
- packages/core/src/core/localLlmContentGenerator.ts — fenced OpenAICompatAuth
  interface; constructor adds optional `auth?` param; `fetchWithTimeout` adds
  `Authorization: Bearer <key>` and merges `extraHeaders`. Local mode (auth
  undefined) is byte-identical. `OpenAICompatContentGenerator` aliased export.
- packages/core/src/core/contentGenerator.ts — fenced AuthType.PROVIDER,
  GEMINI_PROVIDER env detection in `getAuthTypeFromEnv()`, and provider branch
  in `createContentGenerator()` that resolves provider config, loads the API
  key, and instantiates OpenAICompatContentGenerator.
- packages/core/src/config/config.ts — fenced `providersActive`,
  `providersConfig` fields + getters (`getActiveProviderId`,
  `getProviderConfig`, `getActiveProviderResolved`) + `refreshProviderConfig`
  hot-reload method.
- packages/cli/src/config/settingsSchema.ts — fenced `providers` block with
  active + per-provider override schema.
- packages/cli/src/config/config.ts — fenced wiring from `settings.providers`
  into the Config constructor.
- packages/cli/src/ui/commands/providerCommand.ts — NEW. `/provider` +
  `list|use|set|remove` sub-commands; bare command returns
  `{ type: 'dialog', dialog: 'provider' }` so the UI can pick it up.
- packages/cli/src/services/BuiltinCommandLoader.ts — fenced registration of
  providerCommand.
- packages/cli/src/ui/commands/types.ts — fenced `'provider'` dialog literal.
- packages/cli/src/ui/hooks/slashCommandProcessor.ts — fenced
  `openProviderDialog` action + `case 'provider'` dispatch.
- packages/cli/src/ui/hooks/useProviderCommand.ts — NEW. Mirrors
  useLocalCommand: isProviderDialogOpen + open/close.
- packages/cli/src/ui/AppContainer.tsx — fenced wiring of useProviderCommand
  into UIState/UIActions.
- packages/cli/src/ui/contexts/UIStateContext.tsx — fenced isProviderDialogOpen
  field.
- packages/cli/src/ui/contexts/UIActionsContext.tsx — fenced
  openProviderDialog/closeProviderDialog fields.
- packages/cli/src/ui/components/ProviderDialog.tsx — NEW. Modeled on
  LocalDialog: BaseSettingsDialog over `providers.<active>.*` keys, status panel
  showing resolved model/baseUrl/context + key state, hot- reload of
  model/baseUrl/contextLimit/etc. via refreshProviderConfig.
- packages/cli/src/ui/components/DialogManager.tsx — fenced conditional render
  of ProviderDialog.
- packages/cli/src/ui/components/UserIdentity.tsx — fenced PROVIDER auth- type
  block: shows provider name, model, base URL, context, prompt mode.
- packages/cli/src/test-utils/render.tsx — fenced
  openProviderDialog/closeProviderDialog mock fields.
- packages/cli/src/ui/hooks/slashCommandProcessor.test.tsx — fenced
  openProviderDialog mock field.
- docs/reference/commands.md — fenced `/provider` reference section (commands,
  security model, sub-commands, env-var activation).
- packages/core/src/providers/providerRegistry.test.ts — NEW. 11 tests: registry
  shape, env-var uniqueness, resolveProvider defaults + overrides,
  malformed-config validation accumulation.
- packages/core/src/providers/providerCredentialStorage.test.ts — NEW. 12 tests:
  cache, save/load/clear, env-wins-over-keychain, env-trim, empty-env fallback,
  error surfacing.
- packages/core/src/core/localLlmContentGenerator.bearer.test.ts — NEW. 5 tests:
  alias identity, no-Authorization-when-local, Bearer-when- hosted, extraHeaders
  merge order, key never appears in non-2xx error.
- packages/cli/src/ui/commands/providerCommand.test.ts — NEW. 20 tests covering
  list / use / set (model | baseUrl | key) / remove paths including unknown-id
  rejection and keychain-error surfacing.
- packages/core/src/core/loggingContentGenerator.redaction.test.ts — NEW. 3
  tests asserting a canary API key never appears in any telemetry payload on
  success OR error paths, with the bearer header verified on the wire so we know
  the test is meaningful.

Explicit non-goals (Phase 2.1 ships only what's listed; the following are
deliberate follow-ups, not bugs):

- Anthropic provider. `wireFormat: 'anthropic-messages'` is reserved in the type
  and the registry shape supports it, but the adapter is a separate piece of
  work.
- Masked-input dialog for `/provider set <id> key`. Today the key appears in
  scrollback; the user is responsible for clearing it (Ctrl+L). Documented in
  `/provider set` help text and in `docs/reference/commands.md`.
- `embedContent()` on hosted providers. Same constraint as `/local`.

KNOWN CONSTRAINTS - embedContent() throws — not supported in local mode -
--dry-run for API calls not yet implemented (no existing cross-cutting dry-run
in the codebase) - Tool calls depend on the local model's function calling
support - vLLM tool-call parser may not match all models; XML fallback parser
handles Qwen-style tool calls in content

KNOWN CONSTRAINT — Node DEP0040 punycode warning (Phase 2.0.2 investigation) On
Node 22 and later, running `gemini-local-cli` may emit
`(node:NNN) [DEP0040] DeprecationWarning: The 'punycode' module is deprecated`
exactly once at startup. Investigation summary:

- All bare `require('punycode')` / `import 'punycode'` sites in our runtime dep
  tree are inside `node-fetch@2`'s nested `tr46` and `whatwg-url`. These ARE
  bundled via esbuild's \_\_commonJS wrapper and resolve to the bundled userland
  `node_modules/punycode` (v2.3.1), so the production bundle itself does not
  pull in Node's builtin punycode module.
- The remaining `uri-js` import path (eslint -> ajv@6 -> uri-js) is dev-only and
  not present in the runtime bundle.
- `scripts/start.js` (dev mode) suppresses DEP0040 via `--no-warnings=DEP0040`
  at line 35; the production relauncher in `packages/cli/index.ts` intentionally
  does NOT mirror that suppression per Rule 13 (never suppress warnings; fix at
  the root).
- Could not reproduce on Node 20.18.2 because DEP0040 was a "pending
  deprecation" until Node 22 (only fires with `--pending-deprecation`). Need a
  Node 22+ environment to capture the live stack trace. The honest fix is
  upstream: replace `node-fetch@2` (used transitively by `@google-cloud/logging`
  -> `google-gax@4`) with `node-fetch@3` or native fetch. That requires lifting
  `gaxios` to v7 across the dependency tree. Workaround for users who find the
  warning noisy: run with `NODE_OPTIONS='--no-warnings=DEP0040'`. Capture the
  live trace with `NODE_OPTIONS='--trace-deprecation' gemini-local-cli` to
  confirm the offending `require()` call site if it surfaces in your
  environment.

DONE — Phase 2.2 Unified Provider Registry (shipped):

Phase 2.1.1 unified the auth-mode mental model (everything OpenAI-shaped runs
through `AuthType.LOCAL`, hosted-vs-local distinguished by
`Config.getEffectiveLocalConfig().providerId`). Phase 2.2 finishes the
unification by pulling **upstream Gemini paths** into the same
`/provider`-driven registry, so that:

1. `/local` is a duplicate of `/provider local-vllm` — so `/local` is hard-
   removed and the `local.*` settings block is migrated once on startup.
2. Switching to upstream Google OAuth or Vertex AI is just
   `/provider use gemini-oauth` (or `gemini-apikey` / `gemini-vertex`); the user
   no longer has to know about `/auth` for the most common workflow.
3. Token usage is bucketed per provider so `/stats` and `/quit` answer "where
   did this session's tokens actually go?" when the user toggles between, e.g.,
   `gemini-oauth` and `local-vllm` mid-session.

Architecture:

- `ProviderDefinition` (packages/core/src/providers/providerRegistry.ts) gains
  three fields: `wireFormat: 'openai-chat' | 'gemini' | 'anthropic-messages'`,
  `authType: AuthType`, and `validSettingKeys: readonly string[]`.
  `gemini-oauth`, `gemini-apikey`, and `gemini-vertex` are registered with
  `wireFormat: 'gemini'`. OpenAI-compat entries keep `wireFormat: 'openai-chat'`
  and `authType: AuthType.LOCAL`.
- `AuthType` was extracted into a leaf module
  (packages/core/src/core/authType.ts) to break a runtime circular import
  (`config.ts → providerRegistry.ts → contentGenerator.ts → index.ts → config.ts`).
  `contentGenerator.ts` re-exports it for back-compat so external imports of
  `AuthType` from `@google/gemini-cli-core` keep working.
- `Config.getEffectiveLocalConfig()` was renamed to
  `getEffectiveProviderConfig()` and its return shape extended with `wireFormat`
  and `authType`. The legacy-local fallback (no `providers.active` + non-empty
  `local.url`) still returns `wireFormat: 'openai-chat'` +
  `authType: AuthType.LOCAL` so pre-2.2 setups keep working byte-identically
  until the migration runs.
- `createContentGenerator()` dispatches on `eff.wireFormat`. For `'openai-chat'`
  it uses the existing `OpenAICompatContentGenerator` (covers vLLM, Ollama,
  OpenAI, Azure, Groq…). For `'gemini'` it falls through to the upstream Google
  GenAI client paths, which then dispatch on the upstream `AuthType` switch
  already in place. **No upstream Gemini code paths were touched.**
- `Config.refreshAuth()` consults `getEffectiveProviderConfig().authType` so
  `/provider use gemini-oauth` triggers `LOGIN_WITH_GOOGLE`,
  `/provider use gemini-vertex` triggers `USE_VERTEX_AI`, etc., without manual
  `/auth` invocation. `/auth` continues to work for re-auth and flips
  `providers.active` to the matching `gemini-*` entry so the footer and stats
  stay consistent.
- `Config.isLocalMode()` is now `wireFormat`-aware: returns `true` only for
  `openai-chat` providers (or the legacy-local fallback). This keeps every
  `if (isLocalMode())` branch in the codebase (compression, loop detection, lite
  system prompt, footer, `/local`-style hot-reload paths) off the upstream
  Gemini path automatically.
- `/local` slash command, `LocalDialog`, `useLocalCommand` hook,
  `closeLocalDialog` action, and the `'local'` `DialogKind` literal are all
  removed. The `local.*` block in `settingsSchema.ts` is **kept** but marked
  `showInDialog: false` and deprecated, so existing settings files still parse
  and the legacy fallback in `getEffectiveProviderConfig()` still has typed
  access to those keys.
- One-time migration (`packages/cli/src/config/migrateLegacyLocalSettings.ts`):
  on startup, if `local.*` is non-empty and `providers.local-vllm.*` is empty,
  the recognized keys (`url`, `model`, `contextLimit`, `timeout`, `promptMode`,
  `enableTools`, `temperature`, `topP`, `topK`, `minP`, `repetitionPenalty`,
  `toolCallParsing`, `apiKeyEnvVar`, `extraHeaders`) are moved to
  `providers.local-vllm.*`. `providers.active` is set to `local-vllm` if unset.
  `~/.gemini/settings.json.pre-2.2.bak` is written before the rewrite. The CLI
  prints a one-line summary at startup listing migrated and dropped keys, and
  never re-runs once the legacy block is empty.
- Per-provider token tracking: `LoggingContentGenerator` stamps
  `ApiResponseEvent` and `ApiErrorEvent` with `provider_id` derived from
  `Config.getActiveProviderId()` / `isLocalMode()` /
  `getContentGeneratorConfig().authType`. `UiTelemetryService` aggregates these
  into `SessionMetrics.providers: Record<string, ProviderMetrics>` alongside the
  existing per-model breakdown. `StatsDisplay` renders a new
  `ProviderUsageTable` below `ModelUsageTable`.

UI changes:

- `UserIdentity.tsx` is `wireFormat`-aware: for `gemini` it shows model +
  auth-method copy (OAuth / `$GEMINI_API_KEY` / Vertex project + location); for
  `openai-chat` it shows URL / prompt mode / tool-call parser as before.
- `ProviderDialog.tsx` only renders fields that appear in
  `definition.validSettingKeys`, so `gemini-*` entries get a smaller sheet (no
  `baseUrl`, no `toolCallParsing`, no `enableTools`). The status panel switches
  `api key:` for `auth:` on `gemini` entries, and the model picker is disabled
  for `gemini` entries (the user types the model name directly because the
  upstream Gemini API does not expose a discovery endpoint compatible with
  `/v1/models`).
- `/provider list` groups providers into "Hosted (Gemini)", "Hosted
  (OpenAI-compat)", and "Local presets" buckets, each with an active marker and
  context-aware auth status (e.g. "via OAuth", "$GEMINI_API_KEY set", "needs
  $OPENAI_API_KEY", "no auth required").

Files touched (Phase 2.2 fences = `// --- LOCAL FORK ADDITION (Phase 2.2) ---`):

- packages/core/src/core/authType.ts — NEW leaf module.
- packages/core/src/core/contentGenerator.ts — re-exports `AuthType` from
  `authType.ts`; `createContentGenerator` dispatches on `wireFormat`.
- packages/core/src/providers/providerRegistry.ts — adds `wireFormat`,
  `authType`, `validSettingKeys`; new `gemini-oauth`, `gemini-apikey`,
  `gemini-vertex` entries.
- packages/core/src/config/config.ts — `getEffectiveLocalConfig()` →
  `getEffectiveProviderConfig()` with extended return shape; `refreshAuth()` and
  `refreshProviderConfig()` consult `eff.authType`; `isLocalMode()` is
  `wireFormat`-aware.
- packages/core/src/config/getEffectiveProviderConfig.test.ts — NEW tests
  covering Gemini entries, OpenAI-compat overrides, and the legacy fallback.
- packages/core/src/core/loggingContentGenerator.ts — stamps `provider_id` on
  every API event.
- packages/core/src/telemetry/types.ts — `provider_id?: string` on
  `ApiResponseEvent` / `ApiErrorEvent`.
- packages/core/src/telemetry/uiTelemetry.ts — `ProviderMetrics` and
  per-provider rollup in `SessionMetrics`.
- packages/cli/src/config/migrateLegacyLocalSettings.ts — NEW one-shot migration
  with backup, key allowlist, and dropped-key reporting.
- packages/cli/src/config/migrateLegacyLocalSettings.test.ts — NEW tests for
  migration scenarios and edge cases.
- packages/cli/src/config/settings.ts — wires the migration into
  `_doLoadSettings` with a backup write and user-visible feedback.
- packages/cli/src/config/settingsSchema.ts — `local.*` block hidden + marked
  deprecated.
- packages/cli/src/services/BuiltinCommandLoader.ts — drops `localCommand`.
- packages/cli/src/ui/AppContainer.tsx — drops `useLocalCommand` and
  `closeLocalDialog`.
- packages/cli/src/ui/commands/types.ts — removes `'local'` from `DialogKind`.
- packages/cli/src/ui/commands/providerCommand.ts — `/provider list` buckets +
  `renderAuthStatus()`; `/provider use` success message is provider-aware.
- packages/cli/src/ui/commands/providerCommand.test.ts — bucket headers and
  Gemini auth-method copy.
- packages/cli/src/ui/components/DialogManager.tsx — removes `LocalDialog`.
- packages/cli/src/ui/components/ProviderDialog.tsx — `validSettingKeys`-driven
  field set; `wireFormat`-aware status panel and model picker.
- packages/cli/src/ui/components/StatsDisplay.tsx — adds `ProviderUsageTable`.
- packages/cli/src/ui/components/UserIdentity.tsx — `wireFormat`-aware
  rendering.
- packages/cli/src/ui/auth/useAuth.ts — auto-auth dispatch via
  `getProvider(providerActive).authType`.
- packages/cli/src/ui/contexts/{UIStateContext,UIActionsContext}.tsx — drops
  local-dialog state/action.
- packages/cli/src/ui/hooks/slashCommandProcessor.ts — drops `case 'local'`.

Tests run green for Phase 2.2: 54 core tests (`providerRegistry.test.ts` +
`getEffectiveProviderConfig.test.ts` + `uiTelemetry.test.ts`) and 44 CLI tests
(`migrateLegacyLocalSettings.test.ts` + `providerCommand.test.ts` +
`UserIdentity.test.tsx`). The pre-existing failures in `prompts.test.ts`,
`prompts-substitution.test.ts`, `promptProvider.test.ts`,
`sandboxManager.integration.test.ts`, `confirmation-policy.test.ts`, and
`line-endings.test.ts` exist on `main` before this phase and are unrelated.

Explicit non-goals carried forward:

- Anthropic provider — `wireFormat: 'anthropic-messages'` is reserved but still
  no adapter.
- Masked-input dialog for `/provider set <id> key` — out of scope.
- `embedContent()` on hosted/local providers — still throws; only Gemini paths
  support it.
- Per-provider _sampling defaults_ for Gemini — Phase 2.2 keeps Gemini sampling
  pinned to upstream defaults; only OpenAI-compat providers expose
  `temperature`, `topP`, etc., via `validSettingKeys`.

DONE — Phase 2.3 Provider UX overhaul (shipped):

Phase 2.2 unified the registry under `/provider` but left two awkward edges: (a)
the registry hard-coded three `local-*` presets that were not materially
different from "any OpenAI-compat URL the user could type", and (b) Gemini
providers exposed empty `validSettingKeys: []` rows in the dialog, telling the
user nothing was editable while still rendering an editable sheet. Phase 2.3
cleans both up by treating local presets as **user data** instead of code, and
by collapsing the dialog into an explicit screen-per-action menu where Gemini
providers simply have no edit screen.

Architecture:

- `BUILT_IN_PROVIDERS` (was `PROVIDER_REGISTRY`) shrunk to four entries:
  `gemini-oauth`, `gemini-apikey`, `gemini-vertex`, `openai`. The three
  `local-*` presets are gone from the code; users register equivalents via
  `/provider add` (or get them auto-promoted by the migration — see below).
- `CustomProviderDefinition` (new shape) captures the fields a user supplies for
  an OpenAI-compat provider: `displayName`, `baseUrl`, optional `defaultModel`,
  `defaultContextLimit`, `apiKeyEnvVar`. It is intentionally a **subset** of
  `ProviderDefinition`; `wireFormat`, `authType`, and `buildAuthHeaders` are
  forced to `openai-chat` / `AuthType.LOCAL` / `bearerAuth | noAuth` by
  `customToProviderDefinition()` so a custom entry can never request a Gemini
  wire format.
- `effectiveRegistry(custom)` returns built-ins merged with custom entries
  (custom always wins on id collision, but `validateCustomProviderId` refuses
  ids that match built-ins at write time). All callers of the old frozen
  `PROVIDER_REGISTRY` — `getProvider`, `listProviderIds`, `mustGetProvider`,
  `resolveProvider` — now take an optional `custom` map (`{}` for back-compat in
  tests).
- Gemini entries' `validSettingKeys` are `[]`. The settings sheet (`EditScreen`)
  honours an explicit empty allowlist by rendering zero rows; in practice the
  dialog never reaches `EditScreen` for Gemini because the menu hides "Edit
  active provider" when `wireFormat === 'gemini'`.
- `Config` gained `getCustomProviders()`, `addCustomProvider(id, def)`,
  `removeCustomProvider(id)`, and `getProviderRegistry()` (returns the merged
  effective registry for the current settings snapshot).
  `getEffectiveProviderConfig` and `getActiveProviderResolved` resolve through
  the merged registry, so `providers.active = "local-vllm"` resolves correctly
  the moment `providers.custom["local-vllm"]` exists.
- One-shot migration `migrateLegacyLocalPresets.ts` runs in the settings loader
  after the Phase 2.2 `local.*` migration. For each id in
  `['local-vllm', 'local-llamacpp', 'local-generic']` it promotes the legacy
  built-in defaults (overlaid with any user overrides) into
  `providers.custom.<id>` iff the user actually used that preset (active id
  matches, or `providers.<id>.*` overrides exist) and a custom entry is not
  already present. Idempotent; a backup is written to
  `~/.gemini/settings.json.pre-2.3.bak`.
- `ProviderDialog.tsx` is now a state machine over six screens (`menu`,
  `switch`, `edit`, `add`, `remove`, `models`). The menu is the single entry
  point — Switch and Add are always visible; Edit only appears for OpenAI-compat
  providers (Gemini gets a one-line hint pointing at `/auth`); Remove greys out
  when there are no custom providers; Browse models is unavailable on Gemini and
  renders the upstream-defaults redirect message instead.
- `/provider` slash command gained `add` and reworked `remove` (custom ids only
  — refuses built-ins with a clear message). `/provider set` on a `gemini-*` id
  returns a refusal explaining that Gemini providers follow upstream defaults;
  users are pointed at `/auth` (for creds) or `/model` (for the model string).
  `/provider list` flags custom entries with `[custom]`.

Files touched (Phase 2.3 fences = `// --- LOCAL FORK ADDITION (Phase 2.3) ---`):

- packages/core/src/providers/providerRegistry.ts — split into
  `BUILT_IN_PROVIDERS` + `effectiveRegistry`; new `CustomProviderDefinition`,
  `customToProviderDefinition`, `validateCustomProviderId`. Existing helpers
  take an optional `custom` map.
- packages/core/src/config/config.ts — `providersCustom` field +
  `getCustomProviders` / `addCustomProvider` / `removeCustomProvider` /
  `getProviderRegistry` accessors. Resolution methods pass the custom map
  through to `resolveProvider`.
- packages/cli/src/config/settingsSchema.ts — new `providers.custom` block
  (`Record<string, CustomProviderDefinition>`, `showInDialog: false`,
  `MergeStrategy.SHALLOW_MERGE`).
- packages/cli/src/config/migrateLegacyLocalPresets.ts (new) +
  packages/cli/src/config/settings.ts — wired into `_doLoadSettings` right after
  Phase 2.2's `local.*` migration.
- packages/cli/src/ui/commands/providerCommand.ts — `add` subcommand, reworked
  `remove`, Gemini guards on `set`, `[custom]` tags in `list`.
- packages/cli/src/ui/components/ProviderDialog.tsx — six-screen state machine;
  `EditScreen` is the lifted-out Phase 2.1/2.2 settings sheet unchanged for
  OpenAI-compat providers.
- README.md — registry table, custom-provider quick-start, Phase 2.3 migration
  notice, updated `/provider` reference.

Tests run green for Phase 2.3:

- packages/core/src/providers/providerRegistry.test.ts — 32 tests asserting
  BUILT_IN_PROVIDERS has exactly 4 entries plus
  `effectiveRegistry`/`customToProviderDefinition`/ `validateCustomProviderId`
  coverage and Gemini's `validSettingKeys.length === 0` invariant.
- packages/core/src/config/getEffectiveProviderConfig.test.ts — 15 tests
  including `local-vllm` resolved as a custom provider, custom OpenAI-compat
  with API-key env var, and the unknown-id case.
- packages/cli/src/config/migrateLegacyLocalPresets.test.ts (new) — 11 tests
  covering all three preset ids, idempotency, override preservation, and the
  no-op short-circuit when the user never used the preset.
- packages/cli/src/ui/commands/providerCommand.test.ts — 30 tests including
  `add` happy/error paths, `remove` refusing built-ins, and `set` rejecting
  `gemini-*`.
- packages/cli/src/ui/components/ProviderDialog.test.tsx (new) — 9 tests
  covering each screen render and the Esc-to-close path.

Pre-existing failing tests on `main` (`prompts.test.ts`,
`prompts-substitution.test.ts`, `promptProvider.test.ts`,
`sandboxManager.integration.test.ts`, `confirmation-policy.test.ts`,
`line-endings.test.ts`) are unchanged by this phase.

Explicit non-goals carried forward to a later phase:

- Custom Gemini-wireFormat providers — only OpenAI-compat custom entries are
  supported. New Gemini auth flows still require a code change in
  `BUILT_IN_PROVIDERS`.
- Anthropic provider adapter — `wireFormat: 'anthropic-messages'` is reserved
  but still no concrete adapter.
- Masked-input dialog for `/provider add ... --env` (and
  `/provider set ... key`) — same constraint as Phase 2.2; documented,
  follow-up.
- **Per-utility provider/model routing.** Today every utility role defined in
  `packages/core/src/telemetry/llmRole.ts` (`utility_tool`,
  `utility_compressor`, `utility_summarizer`, `utility_router`,
  `utility_loop_detector`, `utility_next_speaker`, `utility_edit_corrector`,
  `utility_autocomplete`, `utility_fast_ack_helper`,
  `utility_state_snapshot_processor`) runs through whichever provider is
  currently active. A future phase will let the user route any of these utility
  roles to a different OpenAI / custom provider + model (e.g. always summarize
  with `gpt-4o-mini` even when the main session is on `gpt-5`, or run the
  compressor against a small local model). The new `effectiveRegistry()` merger
  and the `getProviderRegistry()` / `getCustomProviders()` accessors are
  deliberately easy to call from a future utility-router resolver — Phase 2.3
  should not paint itself into a corner that would block this. Gemini providers
  will be excluded from the utility-router UI for the same reason as the rest of
  Phase 2.3 — Gemini uses upstream defaults.
