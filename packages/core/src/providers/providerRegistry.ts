/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Provider registry (Phase 2.1 → 2.3).
//
// Brand-new file — no upstream-shared content here, so no fork fences are
// needed. This is "Category C" per the rebase-safety policy.
//
// Phase 2.3 split this registry into two layers:
//
//   1. BUILT_IN_PROVIDERS — frozen, ships with the binary, contains exactly
//      four entries: gemini-oauth, gemini-apikey, gemini-vertex, openai.
//      These are the wire formats / auth flows the CLI knows how to drive
//      natively. They cannot be edited or removed by users.
//
//   2. settings.providers.custom.* — user-defined OpenAI-compatible
//      providers (e.g. local vLLM, Groq, Fireworks, Anyscale, an internal
//      Azure deployment). Stored in settings.json under
//      `providers.custom[id]`, persisted across runs, editable via
//      `/provider add` / `/provider remove`.
//
//   3. effectiveRegistry(custom) — merges (1) and (2) into the runtime view
//      consumed by the resolver, dispatcher, slash commands, and dialog.
//      Custom entries are forced to wireFormat='openai-chat' /
//      authType=AuthType.LOCAL (the only thing we can wire up without a new
//      adapter); built-ins always win on id collision.
//
// Each entry carries:
//
//   - `wireFormat`  — `'openai-chat'` (we own the wire) or `'gemini'`
//                     (upstream Google GenAI SDK handles the wire).
//   - `authType`    — the AuthType enum value this entry maps to. Used by
//                     refreshAuth() so `/provider use <id>` triggers the
//                     correct auth flow (OAuth, API-key check, etc.).
//   - `requiresApiKey` — drives whether the credential resolver runs and
//                        whether the dialog shows an API-key row.
//   - `validSettingKeys` — the per-provider settings keys that actually
//                          apply to this entry. OpenAI / custom entries
//                          accept the full OpenAI-compat sheet; Gemini
//                          entries accept NONE (Phase 2.3: Gemini uses
//                          upstream gemini-cli defaults end-to-end).
//
// Security model (mirrored in providerCredentialStorage.ts):
//   - API keys are NEVER stored in this registry or in settings.json.
//   - Per-provider env var name lives here so the credential resolver can
//     look up the right OPENAI_API_KEY / GEMINI_API_KEY / ... at request
//     time. Env-var presence always wins over the keychain.
//   - For `wireFormat: 'gemini'`, key resolution / OAuth state lives in
//     the upstream Google GenAI SDK code paths. The registry just records
//     which AuthType to trigger.

// --- LOCAL FORK ADDITION (Phase 2.2) ---
// Import AuthType from the leaf authType module (NOT contentGenerator)
// to avoid the circular init cycle:
//   config.ts → providerRegistry.ts → contentGenerator.ts → ../../index.js
//   → config.ts (still mid-eval)
// authType.ts has zero internal imports so this edge is always safe.
// --- END LOCAL FORK ADDITION ---
import { AuthType } from '../core/authType.js';

/**
 * Wire format spoken by this provider's endpoint. Drives which
 * ContentGenerator implementation `createContentGenerator()` instantiates:
 *
 *   - `openai-chat`        → our OpenAICompatContentGenerator (we own
 *                            the wire). Used for openai + custom.
 *   - `openai-responses`   → our OpenAIResponsesContentGenerator (we own
 *                            the wire). Used for gpt-5 / gpt-5-codex /
 *                            o-series and the locally-runnable gpt-oss-*
 *                            family. Endpoint shape is
 *                            POST /v1/responses with structured `input`
 *                            and SSE `response.*` events.
 *   - `gemini`             → upstream googleGenAI.models. Used for
 *                            gemini-oauth / gemini-apikey / gemini-vertex.
 *   - `anthropic-messages` → reserved for a future Anthropic adapter.
 */
export type ProviderWireFormat =
  | 'openai-chat'
  // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
  | 'openai-responses'
  // --- END LOCAL FORK ADDITION ---
  | 'gemini'
  | 'anthropic-messages';

/**
 * Static description of one LLM provider entry.
 *
 * Every value here is a SAFE DEFAULT — the user can override `model` and
 * `baseUrl` per-instance via settings.json (`providers.<id>.model`,
 * `providers.<id>.baseUrl`) and the resolver merges those overrides on
 * top of the registry entry at request time.
 *
 * Phase 2.3 (custom providers): user-defined OpenAI-compat entries live
 * under `settings.providers.custom[id]` and are merged into the effective
 * registry at runtime. Built-ins always win on id collision.
 */
export interface ProviderDefinition {
  /** Stable string id, used as the settings key and keychain entry name. */
  readonly id: string;
  /** Human-readable name shown in the UI ("OpenAI", "Local vLLM", ...). */
  readonly displayName: string;
  /**
   * Chat-completions endpoint URL. May be overridden per-instance for
   * Azure OpenAI, OpenAI-compatible proxies, or self-hosted gateways.
   */
  readonly defaultBaseUrl: string;
  /**
   * Environment variable that supplies the API key when the user has not
   * stored one in the OS keychain. Env value always wins. Empty string
   * for entries that don't need a key (e.g. localhost custom servers).
   */
  readonly apiKeyEnvVar: string;
  /** Wire format spoken by this endpoint. See {@link ProviderWireFormat}. */
  readonly wireFormat: ProviderWireFormat;
  /**
   * AuthType this provider entry maps to. `createContentGenerator()` uses
   * this (alongside `wireFormat`) to dispatch into the correct upstream
   * branch; `Config.refreshAuth()` consults it so `/provider use <id>`
   * triggers the same flow as `/auth` selecting that backend.
   *
   * Gemini-* entries set their respective Gemini AuthType values
   * (LOGIN_WITH_GOOGLE / USE_GEMINI / USE_VERTEX_AI). Every OpenAI-compat
   * entry — hosted built-in or user-defined custom — sets
   * {@link AuthType.LOCAL}.
   */
  readonly authType: AuthType;
  /**
   * The set of `providers.<id>.<key>` keys this entry actually honours.
   * Drives the visible field set in ProviderDialog and the keys accepted
   * by `/provider set <id> <key>`. Order is preserved for display.
   *
   * - OpenAI-compat entries (openai + custom) declare the full sheet
   *   (model, baseUrl, contextLimit, promptMode, enableTools, timeout, ...).
   * - Gemini entries declare an EMPTY array (Phase 2.3): everything
   *   (auth, project, location, tools, timeouts, model selection) lives
   *   inside the upstream gemini-cli SDK and isn't ours to override.
   */
  readonly validSettingKeys: readonly string[];
  /** Default model id. User may override via `providers.<id>.model`. */
  readonly defaultModel: string;
  /**
   * Default context window in tokens. Used to drive smart-context
   * compression in the same way `local.contextLimit` does today.
   */
  readonly defaultContextLimit: number;
  /**
   * Whether this provider requires an API key. Hosted providers (OpenAI,
   * Anthropic, ...) set this to `true`; localhost custom servers and the
   * Gemini OAuth/Vertex entries set it to `false`.
   *
   * When `false`:
   *   - The credential resolver is skipped entirely.
   *   - The model picker / `/provider models` does not send Authorization.
   *   - The dialog hides the API-key status row.
   */
  readonly requiresApiKey: boolean;
  /**
   * Builds the auth headers for one request. Default implementations are
   * provided per registry entry; this is a function (not a constant) so a
   * provider that needs e.g. `x-api-key` instead of `Authorization` can
   * supply its own builder without touching the generator.
   *
   * For entries with {@link requiresApiKey} = false this is never
   * invoked, but a no-op implementation is still required so the field
   * stays non-optional.
   */
  buildAuthHeaders(apiKey: string): Record<string, string>;
  /**
   * Optional static extra headers (e.g. OpenRouter requires `HTTP-Referer`
   * and `X-Title` to be present on every request). Phase 1 OpenAI does
   * not need this; the field is here so future entries can declare it.
   */
  buildExtraHeaders?(): Record<string, string>;
  /**
   * True when this entry was created from `settings.providers.custom.*`
   * (Phase 2.3). Used by `/provider list`, `/provider remove`, and the
   * ProviderDialog to flag user-defined entries with `[custom]` and
   * permit removal. Built-ins always have this `false`.
   */
  readonly isCustom: boolean;
}

/**
 * Default Authorization header builder for OpenAI Chat Completions–style
 * providers. Re-used by every entry in this registry except Anthropic
 * (which uses `x-api-key` and `anthropic-version`).
 */
function bearerAuth(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

/**
 * Auth-headers builder for entries that don't authenticate (local servers,
 * Gemini OAuth/Vertex). Returns an empty object so the generator never
 * attaches an Authorization header. The leading underscore satisfies
 * eslint's no-unused-vars without breaking the
 * {@link ProviderDefinition.buildAuthHeaders} contract.
 */
function noAuth(_apiKey: string): Record<string, string> {
  return {};
}

/**
 * Standard set of settings keys honoured by an OpenAI-compatible entry
 * (OpenAI built-in or any user-defined custom provider). Mirrors the
 * legacy `local.*` knob surface; the dialog and `/provider set` use this
 * list verbatim.
 */
const OPENAI_COMPAT_SETTING_KEYS: readonly string[] = Object.freeze([
  'model',
  'baseUrl',
  'contextLimit',
  'promptMode',
  'enableTools',
  'timeout',
  'compressionThreshold',
  'preserveFraction',
  // --- LOCAL FORK ADDITION (Phase 2.3.1: per-provider sampler) ---
  // `temperature` is a sampler knob, not an endpoint/transport setting.
  // It belongs to the OpenAI-compat allowlist because both the built-in
  // openai entry and every user-defined custom provider speak the same
  // wire format and care about the same `temperature` request field.
  // Gemini wire-format providers do NOT include this key — upstream
  // gemini-cli owns Gemini sampler defaults via its own request shape.
  'temperature',
  // --- END LOCAL FORK ADDITION ---
  // --- LOCAL FORK ADDITION (Phase 2.3.2: per-provider tool-call parser) ---
  // Lets each custom provider declare its own parser mode without
  // affecting the global legacy `local.toolCallParsing` setting.
  'toolCallParsing',
  // --- END LOCAL FORK ADDITION ---
  // --- LOCAL FORK ADDITION (Phase 2.4.7: system-prompt override) ---
  // Lets each provider replace the upstream Gemini-identity system
  // prompt with a clean string. Empty / unset preserves upstream
  // behavior. Useful for non-Gemini hosted providers (DeepSeek via
  // OpenRouter, etc.) that pattern-match on "Gemini CLI" mentions
  // and self-identify as Google's model.
  'systemPromptOverride',
  // --- END LOCAL FORK ADDITION ---
]);

// --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
/**
 * Settings keys honoured by an OpenAI-Responses-format entry (built-in
 * `openai-responses` or any user-defined custom provider that opts into
 * `wireFormat: 'openai-responses'`).
 *
 * This is the OpenAI-compat sheet MINUS `toolCallParsing` (Responses
 * returns structured `function_call` items so the XML salvage parser
 * never runs) PLUS:
 *
 *   - `reasoningEffort`     — top-level `reasoning.effort` knob
 *                             (minimal/low/medium/high). Particularly
 *                             important for gpt-5-codex and o-series.
 *   - `useResponseChaining` — opt-in `previous_response_id` chaining.
 *                             Stateful: trades client-owned context for
 *                             cheaper turns. Default OFF so the existing
 *                             4-layer context defense story keeps
 *                             working unchanged when users haven't
 *                             flipped the flag.
 */
const OPENAI_RESPONSES_SETTING_KEYS: readonly string[] = Object.freeze([
  'model',
  'baseUrl',
  'contextLimit',
  'promptMode',
  'enableTools',
  'timeout',
  'compressionThreshold',
  'preserveFraction',
  'temperature',
  'reasoningEffort',
  'useResponseChaining',
  // --- LOCAL FORK ADDITION (Phase 2.4.7: system-prompt override) ---
  // Symmetric with the openai-chat allowlist; the override applies to
  // both wire formats (the system prompt is the same shape regardless
  // of /v1/chat/completions vs /v1/responses).
  'systemPromptOverride',
  // --- END LOCAL FORK ADDITION ---
]);
// --- END LOCAL FORK ADDITION ---

/**
 * Phase 2.3: Gemini providers expose ZERO editable settings via
 * `providers.<id>.*`. Everything (model selection, project, location,
 * timeouts, tools) is owned by the upstream gemini-cli SDK and follows
 * its defaults. `/provider set gemini-* …` is rejected at the command
 * boundary; the dialog's "Edit active provider" entry is hidden when a
 * Gemini entry is active.
 */
const GEMINI_SETTING_KEYS: readonly string[] = Object.freeze([]);

/**
 * Built-in providers — the wire formats / auth flows we know how to drive
 * natively. Frozen at module load. Users cannot edit or remove these.
 *
 * Conventions:
 *   - `gemini-<auth>` : Gemini wire format with the matching upstream
 *                       auth flow (oauth / apikey / vertex).
 *   - `openai`        : Hosted OpenAI Chat Completions endpoint (also
 *                       acts as the template for user custom entries).
 *
 * Phase 2.3 dropped `local-vllm`, `local-llamacpp`, and `local-generic`
 * from the built-ins. They live in `providers.custom.*` after the
 * Phase 2.3 migration runs once on first launch; new users add them with
 * `/provider add`.
 */
export const BUILT_IN_PROVIDERS: Readonly<Record<string, ProviderDefinition>> =
  Object.freeze({
    'gemini-oauth': {
      id: 'gemini-oauth',
      displayName: 'Gemini (OAuth login)',
      // Wire is handled by the upstream SDK; URL/env-var/auth-headers are
      // not consulted for `wireFormat: 'gemini'` entries.
      defaultBaseUrl: '',
      apiKeyEnvVar: '',
      wireFormat: 'gemini',
      authType: AuthType.LOGIN_WITH_GOOGLE,
      validSettingKeys: GEMINI_SETTING_KEYS,
      defaultModel: 'gemini-2.5-pro',
      defaultContextLimit: 1_048_576,
      requiresApiKey: false,
      buildAuthHeaders: noAuth,
      isCustom: false,
    },
    'gemini-apikey': {
      id: 'gemini-apikey',
      displayName: 'Gemini (API key)',
      defaultBaseUrl: '',
      apiKeyEnvVar: 'GEMINI_API_KEY',
      wireFormat: 'gemini',
      authType: AuthType.USE_GEMINI,
      validSettingKeys: GEMINI_SETTING_KEYS,
      defaultModel: 'gemini-2.5-pro',
      defaultContextLimit: 1_048_576,
      // API-key presence is enforced by the upstream USE_GEMINI auth
      // path; we still mark `requiresApiKey: true` so the dialog shows
      // the row and `/provider list` reports key/no-key correctly.
      requiresApiKey: true,
      buildAuthHeaders: noAuth,
      isCustom: false,
    },
    'gemini-vertex': {
      id: 'gemini-vertex',
      displayName: 'Gemini (Vertex AI)',
      defaultBaseUrl: '',
      // Vertex auth uses GCP application default credentials / a service
      // account file, not an env-var API key. We still expose
      // GOOGLE_API_KEY here because the upstream Vertex path will accept
      // it as a fallback when ADC is not configured.
      apiKeyEnvVar: 'GOOGLE_API_KEY',
      wireFormat: 'gemini',
      authType: AuthType.USE_VERTEX_AI,
      validSettingKeys: GEMINI_SETTING_KEYS,
      defaultModel: 'gemini-2.5-pro',
      defaultContextLimit: 1_048_576,
      requiresApiKey: false,
      buildAuthHeaders: noAuth,
      isCustom: false,
    },
    openai: {
      id: 'openai',
      displayName: 'OpenAI',
      defaultBaseUrl: 'https://api.openai.com/v1/chat/completions',
      apiKeyEnvVar: 'OPENAI_API_KEY',
      wireFormat: 'openai-chat',
      authType: AuthType.LOCAL,
      validSettingKeys: OPENAI_COMPAT_SETTING_KEYS,
      defaultModel: 'gpt-4o-mini',
      defaultContextLimit: 128_000,
      requiresApiKey: true,
      buildAuthHeaders: bearerAuth,
      isCustom: false,
    },
    // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
    // Hosted OpenAI Responses endpoint. Carries the gpt-5 / gpt-5-codex /
    // o-series / gpt-oss-* models that ONLY work via /v1/responses and
    // its structured output items (text, reasoning, function_call). The
    // chat-completions `openai` entry stays untouched alongside this so
    // users can pick chat-style gpt-4o or responses-style gpt-5 without
    // re-auth.
    'openai-responses': {
      id: 'openai-responses',
      displayName: 'OpenAI Responses',
      defaultBaseUrl: 'https://api.openai.com/v1/responses',
      apiKeyEnvVar: 'OPENAI_API_KEY',
      wireFormat: 'openai-responses',
      authType: AuthType.LOCAL,
      validSettingKeys: OPENAI_RESPONSES_SETTING_KEYS,
      defaultModel: 'gpt-5',
      // 400K is the context-window OpenAI advertises for the gpt-5
      // family; gpt-5-codex shares that ceiling. The user can override
      // per instance for o-series (200K) or gpt-oss-120b (128K).
      defaultContextLimit: 400_000,
      requiresApiKey: true,
      buildAuthHeaders: bearerAuth,
      isCustom: false,
    },
    // --- END LOCAL FORK ADDITION ---
  });

/**
 * Phase 2.3: shape of one user-defined OpenAI-compatible provider entry,
 * stored under `settings.providers.custom[id]`.
 *
 * Only OpenAI-compat is supported here on purpose — letting users add a
 * Gemini- or Anthropic-shaped entry would require new auth flows /
 * adapters that ship with the binary, not user data. Keep this shape
 * intentionally narrow; everything we can't pre-validate is forced to a
 * safe constant in {@link customToProviderDefinition}.
 */
export interface CustomProviderDefinition {
  /** Display label shown in /provider list and the dialog. */
  displayName: string;
  /** Required base URL (full path to `/v1/chat/completions` is fine). */
  baseUrl: string;
  /**
   * Default model id for this provider. Empty string is allowed when the
   * server doesn't care or the model is a server-side runtime choice
   * (e.g. local vLLM serves whatever was loaded at boot).
   */
  defaultModel?: string;
  /**
   * Default context window in tokens. Defaults to 32_768 if omitted.
   */
  defaultContextLimit?: number;
  /**
   * Environment variable name to read for the API key. Empty string (or
   * omitted) means the endpoint accepts unauthenticated requests
   * (typical for localhost servers).
   */
  apiKeyEnvVar?: string;
  // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
  /**
   * Wire format spoken by this custom endpoint. Only the two
   * OpenAI-shaped formats are accepted here on purpose — Gemini /
   * Anthropic flows require shipped-with-the-binary auth glue and
   * cannot be safely added as user data.
   *
   * Defaults to `'openai-chat'` for backward compatibility with every
   * custom provider added before Phase 2.4. Set to `'openai-responses'`
   * to point at vLLM / LM Studio / Azure deployments that expose
   * `POST /v1/responses` (e.g. local gpt-oss-120b on a DGX Spark).
   *
   * Validated at write time: any other value is rejected at the slash
   * command boundary AND silently coerced to `'openai-chat'` at runtime
   * via {@link customToProviderDefinition} so a hand-edited
   * settings.json with a typo cannot crash the boot path.
   */
  wireFormat?: 'openai-chat' | 'openai-responses';
  // --- END LOCAL FORK ADDITION ---
}

/**
 * Convert a {@link CustomProviderDefinition} into the runtime
 * {@link ProviderDefinition} shape consumed everywhere else. Everything
 * we don't accept from user data (`wireFormat`, `authType`,
 * `validSettingKeys`, `buildAuthHeaders`) is forced to safe constants.
 *
 * `requiresApiKey` is derived: any non-empty `apiKeyEnvVar` => true.
 * That's also the toggle that controls whether the dialog shows the
 * API-key row and whether the credential resolver runs.
 */
export function customToProviderDefinition(
  id: string,
  custom: CustomProviderDefinition,
): ProviderDefinition {
  const apiKeyEnvVar = (custom.apiKeyEnvVar ?? '').trim();
  const requiresApiKey = apiKeyEnvVar.length > 0;
  // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
  // Coerce wireFormat to a known value. Anything other than the two
  // accepted strings (including a hand-edited typo or a future format
  // we haven't shipped a generator for) silently falls back to
  // 'openai-chat' so the boot path stays robust. The validateion
  // boundary in /provider add catches typos for the user before they
  // ever reach this function.
  const wireFormat: 'openai-chat' | 'openai-responses' =
    custom.wireFormat === 'openai-responses'
      ? 'openai-responses'
      : 'openai-chat';
  const validSettingKeys =
    wireFormat === 'openai-responses'
      ? OPENAI_RESPONSES_SETTING_KEYS
      : OPENAI_COMPAT_SETTING_KEYS;
  // --- END LOCAL FORK ADDITION ---
  return {
    id,
    displayName: (custom.displayName ?? id).trim() || id,
    defaultBaseUrl: custom.baseUrl,
    apiKeyEnvVar,
    // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
    wireFormat,
    // --- END LOCAL FORK ADDITION ---
    authType: AuthType.LOCAL,
    // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
    validSettingKeys,
    // --- END LOCAL FORK ADDITION ---
    defaultModel: custom.defaultModel ?? '',
    defaultContextLimit: custom.defaultContextLimit ?? 32_768,
    requiresApiKey,
    buildAuthHeaders: requiresApiKey ? bearerAuth : noAuth,
    isCustom: true,
  };
}

/**
 * Returns the merged effective registry — built-ins plus user custom
 * providers. Built-ins always win on id collision (a user can never
 * shadow `gemini-oauth` or `openai` with a custom entry of the same id).
 *
 * Pure function: feeds straight into the resolver, the dispatcher, the
 * slash command, and the dialog without touching any global state. This
 * makes Phase 2.3 trivially testable and keeps the door open for the
 * future per-utility-role routing TODO (which will need to call this
 * with the same `custom` map but a different "active" provider id).
 */
export function effectiveRegistry(
  custom?: Record<string, CustomProviderDefinition>,
): Record<string, ProviderDefinition> {
  const merged: Record<string, ProviderDefinition> = { ...BUILT_IN_PROVIDERS };
  if (custom) {
    for (const [id, c] of Object.entries(custom)) {
      if (!c) continue;
      // Built-ins win — never let a user's custom entry shadow one.
      if (id in BUILT_IN_PROVIDERS) continue;
      merged[id] = customToProviderDefinition(id, c);
    }
  }
  return merged;
}

/**
 * Back-compat alias for callers that previously imported the frozen
 * registry directly. Resolves to BUILT_IN_PROVIDERS only — callers that
 * need user custom entries should use {@link effectiveRegistry} instead.
 *
 * @deprecated Phase 2.3 — prefer `Config.getProviderRegistry()` from
 * runtime code, or `effectiveRegistry(custom)` from pure code.
 */
export const PROVIDER_REGISTRY = BUILT_IN_PROVIDERS;

/**
 * Returns the registry entry for `id`, or undefined if the id is unknown.
 * Callers that need to throw on unknown ids should use
 * {@link mustGetProvider} instead.
 *
 * Phase 2.3: optional `custom` map merges user-defined providers into
 * the lookup. Defaulted to `{}` for backward compatibility.
 */
export function getProvider(
  id: string,
  custom?: Record<string, CustomProviderDefinition>,
): ProviderDefinition | undefined {
  return effectiveRegistry(custom)[id];
}

/**
 * Like {@link getProvider} but throws an {@link UnknownProviderError} when
 * the id is not in the registry. Use at request time (e.g. from
 * `createContentGenerator`'s provider branch) so the error surface is
 * consistent and actionable.
 */
export function mustGetProvider(
  id: string,
  custom?: Record<string, CustomProviderDefinition>,
): ProviderDefinition {
  const def = effectiveRegistry(custom)[id];
  if (!def) {
    throw new UnknownProviderError(id);
  }
  return def;
}

/**
 * Returns the list of registered provider ids in insertion order
 * (built-ins first, then user custom entries). Used by `/provider list`
 * and the dialog to enumerate what's available.
 */
export function listProviderIds(
  custom?: Record<string, CustomProviderDefinition>,
): string[] {
  return Object.keys(effectiveRegistry(custom));
}

/**
 * Thrown when a settings file or CLI flag references a provider id that is
 * not in the registry. The provider branch in `createContentGenerator`
 * catches this and surfaces "Unknown provider 'X'. Run /provider list ..."
 * rather than a stack trace.
 */
export class UnknownProviderError extends Error {
  readonly providerId: string;
  constructor(providerId: string) {
    super(
      `Unknown provider '${providerId}'. Run /provider list to see ` +
        `available providers, or /provider use <id> to switch.`,
    );
    this.name = 'UnknownProviderError';
    this.providerId = providerId;
  }
}

/**
 * Per-instance overrides the user may set in settings.json under
 * `providers.<id>`. All fields are optional; missing fields fall back to
 * the registry default.
 */
export interface ProviderInstanceConfig {
  model?: string;
  baseUrl?: string;
  contextLimit?: number;
  /** Same semantics as `local.compressionThreshold`. */
  compressionThreshold?: number;
  /** Same semantics as `local.preserveFraction`. */
  preserveFraction?: number;
  /** Same semantics as `local.promptMode`. 'lite' | 'full'. */
  promptMode?: string;
  /** Same semantics as `local.enableTools`. */
  enableTools?: boolean;
  /** Same semantics as `local.timeout` in milliseconds. */
  timeout?: number;
  // --- LOCAL FORK ADDITION (Phase 2.3.1: per-provider sampler) ---
  /**
   * Sampling temperature forwarded as `temperature` on every
   * OpenAI-compat request body. Valid range: 0 ≤ x ≤ 2.
   *
   * `undefined` means "let the server decide" (vLLM and most hosted
   * providers default to the model card's `generation_config.json`,
   * which is typically too high for tool-using coding agents). Set
   * explicitly per provider — different models/backends want different
   * defaults. Gemini wire-format providers ignore this field; upstream
   * gemini-cli owns those sampler defaults.
   */
  temperature?: number;
  // --- END LOCAL FORK ADDITION ---
  // --- LOCAL FORK ADDITION (Phase 2.3.2: per-provider tool-call parser) ---
  /**
   * Tool-call parser aggressiveness for this provider. Same semantics
   * as the legacy `local.toolCallParsing` setting.
   *
   * 'strict'  — only <tool_call>…</tool_call> wrappers (safest).
   * 'lenient' — also recovers gated bare-function blocks.
   * 'loose'   — matches any <function=…> block.
   *
   * `undefined` falls back to the global `local.toolCallParsing`
   * setting or the built-in 'strict' default.
   */
  toolCallParsing?: 'strict' | 'lenient' | 'loose';
  // --- END LOCAL FORK ADDITION ---
  // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
  /**
   * Reasoning depth for OpenAI Responses-format providers. Forwarded as
   * top-level `reasoning: { effort: <level> }` on every request.
   *
   * Ignored on non-Responses wire formats (chat / gemini), the same
   * way `temperature` is ignored on Gemini today.
   *
   * `undefined` means "let the server decide" (OpenAI defaults to
   * `medium` for gpt-5 / o-series and `low` for gpt-5-codex).
   */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  /**
   * Opt into stateful response chaining for OpenAI Responses-format
   * providers. When `true`, after the first turn we send only the new
   * user input plus `previous_response_id: <id>`, letting the server
   * keep the conversation state.
   *
   * Tradeoff: cheaper / faster turns but bypasses the client-owned
   * 4-layer context defense (compression / ejection / truncation
   * assume we hold the history). The CLI invalidates the stored
   * response id on `/clear`, `/compress`, history truncation, and any
   * error response so a misuse blast radius stays at one wasted turn.
   *
   * Default: `false` (stateless — full input is re-sent every turn,
   * matching chat-completions behavior).
   */
  useResponseChaining?: boolean;
  // --- END LOCAL FORK ADDITION ---
  // --- LOCAL FORK ADDITION (Phase 2.4.7: system-prompt override) ---
  /**
   * When set to a non-empty string, replaces the entire upstream
   * Gemini-CLI system instruction with this value. Useful when the
   * underlying provider is not Gemini and self-identifies as Gemini
   * because of how often the upstream prompt mentions "Gemini CLI"
   * and "GEMINI.md".
   *
   * Caveats: this replaces the *entire* base preamble — including
   * tool-use guidance, file-handling rules, and sandbox reminders.
   * GEMINI.md / project memory is appended separately by upstream
   * and is *not* replaced by this knob. Empty string or `undefined`
   * preserves upstream behavior exactly.
   *
   * Ignored on Gemini wire-format providers (the Gemini SDK builds
   * its own system prompt outside our translators).
   */
  systemPromptOverride?: string;
  // --- END LOCAL FORK ADDITION ---
}

/**
 * Result of merging a registry entry with the user's per-instance overrides
 * for that provider. Returned by `resolveActiveProvider()` and consumed by
 * `createContentGenerator()` to build the OpenAI-compat request.
 *
 * Note: `apiKey` is NOT included here. It is resolved separately from the
 * env var or keychain to keep secret material on a different code path
 * from configuration data.
 */
export interface ResolvedProvider {
  readonly definition: ProviderDefinition;
  readonly model: string;
  readonly baseUrl: string;
  readonly contextLimit: number;
  readonly promptMode: string;
  readonly enableTools: boolean;
  readonly timeout: number;
  readonly compressionThreshold?: number;
  readonly preserveFraction?: number;
  // --- LOCAL FORK ADDITION (Phase 2.3.1: per-provider sampler) ---
  /**
   * Resolved per-provider sampling temperature. `undefined` means the
   * user has not set one — request bodies should omit `temperature` so
   * the server's own default applies.
   */
  readonly temperature?: number;
  // --- END LOCAL FORK ADDITION ---
  // --- LOCAL FORK ADDITION (Phase 2.3.2: per-provider tool-call parser) ---
  /** Resolved tool-call parser mode. `undefined` → fall back to global default. */
  readonly toolCallParsing?: 'strict' | 'lenient' | 'loose';
  // --- END LOCAL FORK ADDITION ---
  // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
  /**
   * Resolved reasoning effort. `undefined` means "server decides"; the
   * request builder will omit `reasoning` from the JSON body.
   */
  readonly reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  /**
   * Resolved chaining opt-in. Always defined as a concrete boolean so
   * the request builder doesn't have to deal with `undefined` semantics.
   */
  readonly useResponseChaining: boolean;
  // --- END LOCAL FORK ADDITION ---
  // --- LOCAL FORK ADDITION (Phase 2.4.7: system-prompt override) ---
  /**
   * Resolved system-prompt override. Empty string means "no override —
   * use upstream Gemini CLI prompt as-is." Any non-empty value
   * replaces the upstream `systemInstruction` text wholesale at
   * translate time.
   */
  readonly systemPromptOverride: string;
  // --- END LOCAL FORK ADDITION ---
}

/**
 * Thrown when `providers.<id>` in settings.json contains a malformed value
 * (non-string baseUrl, negative context limit, etc.). Carries the field
 * name and the offending value so the CLI can surface "providers.openai.
 * contextLimit must be a positive number, got -1" without dumping a stack
 * trace.
 */
export class InvalidProviderConfigError extends Error {
  readonly providerId: string;
  readonly field: string;
  readonly badValue: unknown;
  constructor(providerId: string, field: string, badValue: unknown) {
    super(
      `Invalid provider config: providers.${providerId}.${field} = ` +
        `${JSON.stringify(badValue)} is not a valid value.`,
    );
    this.name = 'InvalidProviderConfigError';
    this.providerId = providerId;
    this.field = field;
    this.badValue = badValue;
  }
}

/**
 * Validates one ProviderInstanceConfig. Accumulates ALL errors so the
 * user sees every problem at once (per the plan's "Settings parse / shape
 * validation" boundary).
 *
 * Returns the config as-is if valid; throws an InvalidProviderConfigError
 * for the FIRST bad field (callers may catch and rerun for additional
 * errors, or pass `collect: true` to receive an array via the second arg).
 */
export function validateProviderInstanceConfig(
  providerId: string,
  cfg: ProviderInstanceConfig,
): InvalidProviderConfigError[] {
  const errors: InvalidProviderConfigError[] = [];

  if (
    cfg.model !== undefined &&
    cfg.model !== '' &&
    (typeof cfg.model !== 'string' || !cfg.model.trim())
  ) {
    errors.push(new InvalidProviderConfigError(providerId, 'model', cfg.model));
  }
  if (cfg.baseUrl !== undefined && cfg.baseUrl !== '') {
    if (typeof cfg.baseUrl !== 'string' || !cfg.baseUrl.trim()) {
      errors.push(
        new InvalidProviderConfigError(providerId, 'baseUrl', cfg.baseUrl),
      );
    } else {
      try {
        // Validate the URL parses and is HTTP(S). HTTPS is recommended for
        // hosted providers; HTTP is permitted for local OpenAI-compatible
        // proxies (e.g. dev gateways) without warning here.
        const parsed = new URL(cfg.baseUrl);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          errors.push(
            new InvalidProviderConfigError(providerId, 'baseUrl', cfg.baseUrl),
          );
        }
      } catch {
        errors.push(
          new InvalidProviderConfigError(providerId, 'baseUrl', cfg.baseUrl),
        );
      }
    }
  }
  if (
    cfg.contextLimit !== undefined &&
    (typeof cfg.contextLimit !== 'number' ||
      !Number.isFinite(cfg.contextLimit) ||
      cfg.contextLimit <= 0)
  ) {
    errors.push(
      new InvalidProviderConfigError(
        providerId,
        'contextLimit',
        cfg.contextLimit,
      ),
    );
  }
  if (
    cfg.timeout !== undefined &&
    (typeof cfg.timeout !== 'number' ||
      !Number.isFinite(cfg.timeout) ||
      cfg.timeout <= 0)
  ) {
    errors.push(
      new InvalidProviderConfigError(providerId, 'timeout', cfg.timeout),
    );
  }
  if (
    cfg.compressionThreshold !== undefined &&
    (typeof cfg.compressionThreshold !== 'number' ||
      !Number.isFinite(cfg.compressionThreshold) ||
      cfg.compressionThreshold <= 0 ||
      cfg.compressionThreshold > 1)
  ) {
    errors.push(
      new InvalidProviderConfigError(
        providerId,
        'compressionThreshold',
        cfg.compressionThreshold,
      ),
    );
  }
  if (
    cfg.preserveFraction !== undefined &&
    (typeof cfg.preserveFraction !== 'number' ||
      !Number.isFinite(cfg.preserveFraction) ||
      cfg.preserveFraction < 0 ||
      cfg.preserveFraction > 1)
  ) {
    errors.push(
      new InvalidProviderConfigError(
        providerId,
        'preserveFraction',
        cfg.preserveFraction,
      ),
    );
  }
  if (
    cfg.promptMode !== undefined &&
    cfg.promptMode !== 'lite' &&
    cfg.promptMode !== 'full'
  ) {
    errors.push(
      new InvalidProviderConfigError(providerId, 'promptMode', cfg.promptMode),
    );
  }
  if (cfg.enableTools !== undefined && typeof cfg.enableTools !== 'boolean') {
    errors.push(
      new InvalidProviderConfigError(
        providerId,
        'enableTools',
        cfg.enableTools,
      ),
    );
  }
  // --- LOCAL FORK ADDITION (Phase 2.3.1: per-provider sampler) ---
  // Temperature must be a finite non-negative number ≤ 2. The OpenAI
  // chat API accepts 0–2; we mirror that range so vLLM, Ollama, Groq,
  // Fireworks etc. all behave consistently. Reject NaN / Infinity /
  // negatives / >2 explicitly so a user typo in the dialog surfaces as
  // a clear "fix providers.<id>.temperature" error rather than a
  // confusing 400 from the server.
  if (
    cfg.temperature !== undefined &&
    (typeof cfg.temperature !== 'number' ||
      !Number.isFinite(cfg.temperature) ||
      cfg.temperature < 0 ||
      cfg.temperature > 2)
  ) {
    errors.push(
      new InvalidProviderConfigError(
        providerId,
        'temperature',
        cfg.temperature,
      ),
    );
  }
  // --- END LOCAL FORK ADDITION ---
  // --- LOCAL FORK ADDITION (Phase 2.3.2: per-provider tool-call parser) ---
  if (
    cfg.toolCallParsing !== undefined &&
    cfg.toolCallParsing !== 'strict' &&
    cfg.toolCallParsing !== 'lenient' &&
    cfg.toolCallParsing !== 'loose'
  ) {
    errors.push(
      new InvalidProviderConfigError(
        providerId,
        'toolCallParsing',
        cfg.toolCallParsing,
      ),
    );
  }
  // --- END LOCAL FORK ADDITION ---

  // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
  if (
    cfg.reasoningEffort !== undefined &&
    cfg.reasoningEffort !== 'minimal' &&
    cfg.reasoningEffort !== 'low' &&
    cfg.reasoningEffort !== 'medium' &&
    cfg.reasoningEffort !== 'high'
  ) {
    errors.push(
      new InvalidProviderConfigError(
        providerId,
        'reasoningEffort',
        cfg.reasoningEffort,
      ),
    );
  }
  if (
    cfg.useResponseChaining !== undefined &&
    typeof cfg.useResponseChaining !== 'boolean'
  ) {
    errors.push(
      new InvalidProviderConfigError(
        providerId,
        'useResponseChaining',
        cfg.useResponseChaining,
      ),
    );
  }
  // --- END LOCAL FORK ADDITION ---

  // --- LOCAL FORK ADDITION (Phase 2.4.7: system-prompt override) ---
  if (
    cfg.systemPromptOverride !== undefined &&
    typeof cfg.systemPromptOverride !== 'string'
  ) {
    errors.push(
      new InvalidProviderConfigError(
        providerId,
        'systemPromptOverride',
        cfg.systemPromptOverride,
      ),
    );
  }
  // --- END LOCAL FORK ADDITION ---

  return errors;
}

/**
 * Merge a registry entry with the user's per-instance overrides into the
 * concrete `ResolvedProvider` shape consumed by `createContentGenerator`.
 *
 * Throws `InvalidProviderConfigError` (the first one found) if any
 * override value is malformed. Validation is deliberate — silently
 * coercing here would let a bad URL produce a confusing 401 from the
 * provider rather than a clear "fix providers.openai.baseUrl" error.
 *
 * Phase 2.3: `custom` argument is optional; when provided, user-defined
 * entries from `settings.providers.custom.*` are folded into the
 * effective registry before lookup. Defaulted to `{}` for tests and
 * other call sites that only need built-ins.
 */
export function resolveProvider(
  id: string,
  override: ProviderInstanceConfig | undefined,
  custom?: Record<string, CustomProviderDefinition>,
): ResolvedProvider {
  const def = mustGetProvider(id, custom);
  const safeOverride = override ?? {};
  const errors = validateProviderInstanceConfig(id, safeOverride);
  if (errors.length > 0) {
    throw errors[0];
  }
  return {
    definition: def,
    model: safeOverride.model?.trim() || def.defaultModel,
    baseUrl: safeOverride.baseUrl?.trim() || def.defaultBaseUrl,
    contextLimit: safeOverride.contextLimit ?? def.defaultContextLimit,
    promptMode: safeOverride.promptMode ?? 'lite',
    enableTools: safeOverride.enableTools ?? true,
    timeout: safeOverride.timeout ?? 120_000,
    compressionThreshold: safeOverride.compressionThreshold,
    preserveFraction: safeOverride.preserveFraction,
    // --- LOCAL FORK ADDITION (Phase 2.3.1: per-provider sampler) ---
    // Pass through `undefined` rather than substituting a default so
    // the request builder can omit `temperature` from the JSON body.
    // That preserves the legacy "server decides" semantics for users
    // who haven't explicitly set a value.
    temperature: safeOverride.temperature,
    // --- END LOCAL FORK ADDITION ---
    // --- LOCAL FORK ADDITION (Phase 2.3.2: per-provider tool-call parser) ---
    // Pass through `undefined` — consumers fall back to the global
    // `local.toolCallParsing` setting or the built-in 'strict' default.
    toolCallParsing: safeOverride.toolCallParsing,
    // --- END LOCAL FORK ADDITION ---
    // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
    // Reasoning effort: pass through `undefined` so the request
    // builder omits `reasoning` from the JSON body. The session
    // override layer (Config.getReasoningEffort()) overlays this at
    // request time.
    reasoningEffort: safeOverride.reasoningEffort,
    // Chaining: default to the safe stateless path. The request
    // builder reads `previous_response_id` from Config only when this
    // flag is true.
    useResponseChaining: safeOverride.useResponseChaining ?? false,
    // --- END LOCAL FORK ADDITION ---
    // --- LOCAL FORK ADDITION (Phase 2.4.7: system-prompt override) ---
    // Default to empty string ("no override"). Translators check
    // `.length > 0` before substituting, so an empty value is
    // semantically identical to "field missing".
    systemPromptOverride: safeOverride.systemPromptOverride ?? '',
    // --- END LOCAL FORK ADDITION ---
  };
}

/**
 * Validation rule for custom provider ids — kept here so both the slash
 * command and the dialog can use the same regex without duplicating.
 *
 * - Lowercase letters, digits, and hyphens only.
 * - 2–48 characters.
 * - May not start or end with a hyphen, and may not contain `--`.
 * - Must not collide with a built-in id.
 */
const CUSTOM_PROVIDER_ID_RE = /^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$/;

/**
 * Validates a candidate custom-provider id, returning a human-readable
 * error message if invalid, or `null` if it's safe to use.
 */
export function validateCustomProviderId(id: string): string | null {
  if (!id || typeof id !== 'string') {
    return 'Provider id is required.';
  }
  if (id.length < 2 || id.length > 48) {
    return 'Provider id must be 2–48 characters long.';
  }
  if (!CUSTOM_PROVIDER_ID_RE.test(id)) {
    return (
      'Provider id must be lowercase letters, digits, and single hyphens ' +
      "only (e.g. 'my-azure', 'fireworks-prod')."
    );
  }
  if (id in BUILT_IN_PROVIDERS) {
    return `'${id}' is a built-in provider and cannot be redefined.`;
  }
  return null;
}
