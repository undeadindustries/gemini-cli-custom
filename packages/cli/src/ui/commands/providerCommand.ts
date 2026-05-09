/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Hosted-provider slash command (Phase 2.1 → 2.3).
//
// Brand-new file (Category C — no fences).
//
// Sub-commands:
//   /provider                  -> opens the dialog (or prints list when headless)
//   /provider list             -> text list of registered providers + state
//   /provider use <id>         -> switch active provider (refreshProviderConfig)
//   /provider set <id> ...     -> hot-reload field (rejected for Gemini ids)
//   /provider add <id> ...     -> register a new custom OpenAI-compat provider
//   /provider remove <id>      -> remove a CUSTOM provider (built-ins protected)
//   /provider models [<id>]    -> list chat-capable models
//
// Phase 2.3 changes (vs 2.2):
//   - `set` rejects Gemini ids — they own no editable settings.
//   - `add`/`remove` only manage user-defined custom providers; built-ins
//     are read-only.
//   - `list` flags custom entries with `[custom]`.

import {
  CommandKind,
  type CommandContext,
  type SlashCommand,
  type SlashCommandActionReturn,
} from './types.js';
import {
  listProviderIds,
  getProvider,
  resolveProvider,
  validateCustomProviderId,
  UnknownProviderError,
  InvalidProviderConfigError,
  type ProviderInstanceConfig,
  type ProviderDefinition,
  type CustomProviderDefinition,
  fetchProviderModels,
  AuthType,
} from '@google/gemini-cli-core';
import {
  saveProviderApiKey,
  loadProviderApiKey,
  resolveProviderApiKey,
} from '@google/gemini-cli-core';
import { SettingScope } from '../../config/settings.js';

/**
 * Resolve the live `Config` instance from the command context, or return a
 * structured error suitable for surfacing to the user (mirrors localCommand).
 */
function resolveConfig(context: CommandContext) {
  const config = context.services.agentContext?.config;
  if (!config) {
    return {
      ok: false as const,
      error: {
        type: 'message' as const,
        messageType: 'error' as const,
        content:
          'Provider commands are unavailable: the runtime Config is not loaded yet.',
      },
    };
  }
  return { ok: true as const, config };
}

// --- LOCAL FORK ADDITION (Phase 2.2: provider list grouping) ---
/**
 * Groups providers by wireFormat + auth shape so the list reads
 * naturally:
 *   1. Hosted (Gemini)         — wireFormat='gemini'  (OAuth / API key /
 *                                Vertex; upstream owns the wire)
 *   2. Hosted (OpenAI-compat)  — wireFormat='openai-chat' + requiresApiKey
 *   3. Custom OpenAI-compat    — wireFormat='openai-chat' + isCustom
 *                                (Phase 2.3: includes the migrated local
 *                                presets and any user-added entry)
 */
// Phase 2.4 expands the bucket set: hosted OpenAI Responses providers
// land in their own group so the user can tell at a glance which
// backend speaks which wire format. Custom entries always sit in
// `custom` regardless of wireFormat — that's where the user expects to
// find their own entries.
type ProviderBucket =
  | 'gemini'
  | 'openai-hosted'
  | 'openai-responses-hosted'
  | 'custom';

function pickBucket(def: ProviderDefinition): ProviderBucket {
  if (def.wireFormat === 'gemini') return 'gemini';
  if (def.isCustom) return 'custom';
  // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
  if (def.wireFormat === 'openai-responses') return 'openai-responses-hosted';
  // --- END LOCAL FORK ADDITION ---
  return 'openai-hosted';
}

/**
 * Returns the human-readable auth/key status line for a provider, or
 * `null` if the provider needs no auth row at all (Vertex, where the
 * "auth" is GCP credentials picked up by the SDK).
 *
 * Wire-format aware: gemini-oauth talks about login state, openai-chat
 * talks about API keys, etc.
 */
async function renderAuthStatus(
  def: ProviderDefinition,
  id: string,
): Promise<string> {
  if (def.wireFormat === 'gemini') {
    if (def.authType === AuthType.LOGIN_WITH_GOOGLE) {
      return '(auth: OAuth — run /auth to sign in or switch account)';
    }
    if (def.requiresApiKey) {
      const envKey = process.env[def.apiKeyEnvVar]?.trim();
      if (envKey) return `(key from $${def.apiKeyEnvVar})`;
      return `(no key — set $${def.apiKeyEnvVar} or run /auth)`;
    }
    return '(auth: Vertex AI / ADC — run /auth to configure)';
  }
  if (def.requiresApiKey) {
    const envKey = process.env[def.apiKeyEnvVar]?.trim();
    if (envKey) return `(key from $${def.apiKeyEnvVar})`;
    const stored = await loadProviderApiKey(id);
    return stored
      ? '(key in keychain)'
      : `(no key — run /provider set ${id} key)`;
  }
  return '(no key required — local server)';
}

async function renderProviderList(
  context: CommandContext,
): Promise<SlashCommandActionReturn> {
  const resolved = resolveConfig(context);
  if (!resolved.ok) return resolved.error;
  const { config } = resolved;
  const activeId = config.getActiveProviderId();
  const customMap = config.getCustomProviders();

  const buckets: Record<ProviderBucket, string[]> = {
    gemini: [],
    'openai-hosted': [],
    // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
    'openai-responses-hosted': [],
    // --- END LOCAL FORK ADDITION ---
    custom: [],
  };

  for (const id of listProviderIds(customMap)) {
    const def = getProvider(id, customMap);
    if (!def) continue;
    const bucket = pickBucket(def);
    const override = config.getProviderConfig(id);

    let model: string;
    let baseUrl: string;
    try {
      const r = resolveProvider(id, override, customMap);
      model = r.model;
      baseUrl = r.baseUrl;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      buckets[bucket].push(`  ${id}  [config error: ${reason}]`);
      continue;
    }

    const marker = id === activeId ? '\u25b8 ' : '  ';
    // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
    // For custom entries, expose the wire format alongside the
    // [custom] tag so the user can tell at a glance whether they're
    // looking at a chat-completions or Responses-format custom backend
    // (vLLM with `--enable-response-api` lands in the latter).
    const customTag = def.isCustom ? ` [custom \u2022 ${def.wireFormat}]` : '';
    // --- END LOCAL FORK ADDITION ---
    buckets[bucket].push(`${marker}${id} (${def.displayName})${customTag}`);
    buckets[bucket].push(
      `    model: ${
        model || `(server picks — use /provider set ${id} model <name>)`
      }`,
    );
    if (def.wireFormat !== 'gemini' && baseUrl) {
      buckets[bucket].push(`    baseUrl: ${baseUrl}`);
    }
    // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
    // Surface the Responses-only knobs so the user can tell which
    // reasoning effort + chaining mode each Responses provider is on
    // without round-tripping through /reasoning show or settings.json.
    if (def.wireFormat === 'openai-responses') {
      try {
        const r = resolveProvider(id, override, customMap);
        const effort = r.reasoningEffort ?? '(server default)';
        buckets[bucket].push(`    reasoningEffort: ${effort}`);
        buckets[bucket].push(
          `    useResponseChaining: ${r.useResponseChaining ? 'on' : 'off'}`,
        );
      } catch {
        // resolveProvider already threw above for the same id, so the
        // user already saw the [config error] line. Skip silently here
        // to avoid duplicate noise.
      }
    }
    // --- END LOCAL FORK ADDITION ---
    buckets[bucket].push(`    ${await renderAuthStatus(def, id)}`);
  }

  const lines: string[] = [];
  const sections: Array<[ProviderBucket, string]> = [
    ['gemini', 'Hosted (Gemini):'],
    ['openai-hosted', 'Hosted (OpenAI Chat Completions):'],
    // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
    ['openai-responses-hosted', 'Hosted (OpenAI Responses API):'],
    // --- END LOCAL FORK ADDITION ---
    ['custom', 'Custom (user-defined):'],
  ];
  for (const [bucket, header] of sections) {
    if (buckets[bucket].length === 0) continue;
    if (lines.length) lines.push('');
    lines.push(header);
    lines.push(...buckets[bucket]);
  }
  if (Object.keys(customMap).length === 0) {
    if (lines.length) lines.push('');
    lines.push(
      'No custom providers defined. Add one with ' +
        '/provider add <id> <baseUrl> [<displayName>] [<envVar>]',
    );
  }
  if (!activeId) {
    lines.push('');
    lines.push(
      'No active provider. Run /provider use <id> to select one ' +
        '(e.g. /provider use gemini-oauth, /provider use openai).',
    );
  }
  return {
    type: 'message',
    messageType: 'info',
    content: lines.join('\n'),
  };
}
// --- END LOCAL FORK ADDITION ---

const listSubCommand: SlashCommand = {
  name: 'list',
  description: 'List configured providers (built-in + custom) and active state',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: (context) => renderProviderList(context),
};

const useSubCommand: SlashCommand = {
  name: 'use',
  description:
    'Switch the active provider — built-in (gemini-*, openai) or custom',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: async (context, args): Promise<SlashCommandActionReturn> => {
    const id = args.trim();
    if (!id) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Usage: /provider use <id>  (run /provider list to see ids)',
      };
    }
    const resolved = resolveConfig(context);
    if (!resolved.ok) return resolved.error;
    const customMap = resolved.config.getCustomProviders();
    const def = getProvider(id, customMap);
    if (!def) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Unknown provider '${id}'. Run /provider list to see available providers.`,
      };
    }
    try {
      await resolved.config.refreshProviderConfig({ active: id });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      return {
        type: 'message',
        messageType: 'error',
        content: `Failed to switch provider: ${reason}`,
      };
    }
    // --- LOCAL FORK ADDITION (Phase 2.3.2: persist /provider use) ---
    // refreshProviderConfig only mutates in-memory state; without an
    // explicit setValue here the user's choice is lost on the next
    // launch (settings.json keeps the previous providers.active).
    try {
      context.services.settings.setValue(
        SettingScope.User,
        'providers.active',
        id,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      return {
        type: 'message',
        messageType: 'error',
        content:
          `Switched in-memory but failed to persist active provider: ${reason}.` +
          ` Re-run after fixing settings.json.`,
      };
    }
    // --- END LOCAL FORK ADDITION ---
    let extra = '';
    if (def.wireFormat === 'gemini') {
      if (def.authType === AuthType.LOGIN_WITH_GOOGLE) {
        extra = ' (auth via OAuth — run /auth if you need to log in)';
      } else if (def.requiresApiKey) {
        extra = ` (auth via $${def.apiKeyEnvVar} — run /auth if needed)`;
      } else {
        extra = ' (auth via Vertex AI / ADC — run /auth if needed)';
      }
    }
    return {
      type: 'message',
      messageType: 'info',
      content:
        `Active provider \u2192 ${id}.${extra} ` +
        `Live on the next request \u2014 no restart needed.`,
    };
  },
};

/**
 * Parses `<id> <field> <value...>` from the args string for /provider set.
 * Returns null on a usage error and emits a structured error message.
 */
function parseSetArgs(
  args: string,
):
  | { ok: true; id: string; field: string; value: string }
  | { ok: false; error: SlashCommandActionReturn } {
  const trimmed = args.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: {
        type: 'message',
        messageType: 'error',
        content:
          'Usage: /provider set <id> <field> <value>  ' +
          '(field: model | baseUrl | key | reasoningEffort | useResponseChaining | systemPromptOverride)',
      },
    };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) {
    return {
      ok: false,
      error: {
        type: 'message',
        messageType: 'error',
        content:
          `Usage: /provider set <id> <field> <value>  ` +
          `(field: model | baseUrl | key | reasoningEffort | useResponseChaining | systemPromptOverride)`,
      },
    };
  }
  const [id, field, ...rest] = parts;
  const value = rest.join(' ');
  return { ok: true, id, field, value };
}

const setSubCommand: SlashCommand = {
  name: 'set',
  description:
    'Set a provider field: /provider set <id> model|baseUrl|key|reasoningEffort|useResponseChaining|systemPromptOverride <value>',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: async (context, args): Promise<SlashCommandActionReturn> => {
    const parsed = parseSetArgs(args);
    if (!parsed.ok) return parsed.error;
    const { id, field, value } = parsed;
    const resolved = resolveConfig(context);
    if (!resolved.ok) return resolved.error;
    const { config } = resolved;
    const customMap = config.getCustomProviders();
    const def = getProvider(id, customMap);
    if (!def) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Unknown provider '${id}'. Run /provider list to see available providers.`,
      };
    }

    // Phase 2.3: Gemini providers expose zero editable settings — the
    // upstream gemini-cli SDK owns model selection, project, location,
    // timeouts, and tool plumbing. Reject early with an actionable
    // message instead of letting the patch flow through.
    if (def.wireFormat === 'gemini') {
      return {
        type: 'message',
        messageType: 'error',
        content:
          `Gemini providers use upstream defaults; nothing to configure here. ` +
          `Use /auth for credentials, or /provider use <id> to switch backend.`,
      };
    }

    if (field === 'key') {
      if (!def.requiresApiKey) {
        return {
          type: 'message',
          messageType: 'error',
          content:
            `'${id}' does not use an API key. ` +
            `Just /provider use ${id} and (optionally) /provider set ${id} model <name>.`,
        };
      }
      if (!value) {
        return {
          type: 'message',
          messageType: 'error',
          content:
            `Usage: /provider set ${id} key <api-key>. ` +
            `(Heads-up: the key will appear in your terminal scrollback. ` +
            `Clear it with Ctrl+L when done.)`,
        };
      }
      try {
        await saveProviderApiKey(id, value);
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'unknown error';
        return {
          type: 'message',
          messageType: 'error',
          content: `Failed to save key for ${id}: ${reason}`,
        };
      }
      if (config.getActiveProviderId() === id) {
        try {
          await config.refreshProviderConfig({
            setConfig: { id, patch: {} },
          });
        } catch (err) {
          const reason = err instanceof Error ? err.message : 'unknown error';
          return {
            type: 'message',
            messageType: 'error',
            content: `Key saved, but failed to refresh active session: ${reason}`,
          };
        }
      }
      return {
        type: 'message',
        messageType: 'info',
        content:
          `API key for ${id} saved to keychain. ` +
          `Clear your terminal history if you pasted the key.`,
      };
    }

    let patch: ProviderInstanceConfig;
    if (field === 'model') {
      if (!value) {
        return {
          type: 'message',
          messageType: 'error',
          content: `Usage: /provider set ${id} model <model-name>`,
        };
      }
      patch = { model: value };
    } else if (field === 'baseUrl') {
      if (!value) {
        return {
          type: 'message',
          messageType: 'error',
          content: `Usage: /provider set ${id} baseUrl <https-url>`,
        };
      }
      patch = { baseUrl: value };
      // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
    } else if (field === 'reasoningEffort') {
      if (def.wireFormat !== 'openai-responses') {
        return {
          type: 'message',
          messageType: 'error',
          content:
            `'${id}' uses wireFormat '${def.wireFormat}'; reasoningEffort ` +
            `only applies to openai-responses providers. ` +
            `Switch to a Responses-format provider or run /provider list.`,
        };
      }
      if (
        value !== 'minimal' &&
        value !== 'low' &&
        value !== 'medium' &&
        value !== 'high'
      ) {
        return {
          type: 'message',
          messageType: 'error',
          content: `Usage: /provider set ${id} reasoningEffort <minimal|low|medium|high>`,
        };
      }
      patch = { reasoningEffort: value };
    } else if (field === 'useResponseChaining') {
      if (def.wireFormat !== 'openai-responses') {
        return {
          type: 'message',
          messageType: 'error',
          content:
            `'${id}' uses wireFormat '${def.wireFormat}'; useResponseChaining ` +
            `only applies to openai-responses providers. ` +
            `Switch to a Responses-format provider or run /provider list.`,
        };
      }
      const lowered = value?.toLowerCase();
      if (lowered !== 'true' && lowered !== 'false') {
        return {
          type: 'message',
          messageType: 'error',
          content: `Usage: /provider set ${id} useResponseChaining <true|false>`,
        };
      }
      patch = { useResponseChaining: lowered === 'true' };
      // --- END LOCAL FORK ADDITION ---
    } else if (field === 'systemPromptOverride') {
      // --- LOCAL FORK ADDITION (Phase 2.4.7: system-prompt override) ---
      // Available on every OpenAI-compat wire format (chat + responses)
      // because the upstream Gemini CLI preamble is the same for both.
      // Gemini providers reject this knob — they don't route through
      // our translators. Pass an empty string to clear the override.
      if (
        def.wireFormat !== 'openai-chat' &&
        def.wireFormat !== 'openai-responses'
      ) {
        return {
          type: 'message',
          messageType: 'error',
          content:
            `'${id}' uses wireFormat '${def.wireFormat}'; systemPromptOverride ` +
            `only applies to openai-chat / openai-responses providers.`,
        };
      }
      // `value` is the raw `args` tail after the field name; preserve
      // surrounding whitespace inside the prompt but trim leading/trailing
      // shell-style quoting if the user wrapped it.
      const stripped = value.replace(/^["'](.*)["']$/s, '$1');
      patch = { systemPromptOverride: stripped };
      // --- END LOCAL FORK ADDITION ---
    } else {
      return {
        type: 'message',
        messageType: 'error',
        content:
          `Unknown field '${field}'. Expected one of: model, baseUrl, key, ` +
          `reasoningEffort (Responses-only), useResponseChaining (Responses-only), ` +
          `systemPromptOverride.`,
      };
    }

    try {
      await config.refreshProviderConfig({ setConfig: { id, patch } });
    } catch (err) {
      const reason =
        err instanceof InvalidProviderConfigError
          ? err.message
          : err instanceof UnknownProviderError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'unknown error';
      return {
        type: 'message',
        messageType: 'error',
        content: `Failed to update ${field} for ${id}: ${reason}`,
      };
    }
    // --- LOCAL FORK ADDITION (Phase 2.3.2: persist /provider set) ---
    // refreshProviderConfig only mutates the in-memory ProviderInstanceConfig;
    // without writing the patch fields to settings.json the user's edit is
    // lost on the next launch. Iterate over the patch so future fields
    // (e.g. timeout, contextLimit) automatically persist when added above.
    try {
      for (const [patchField, patchValue] of Object.entries(patch)) {
        if (patchValue === undefined) continue;
        context.services.settings.setValue(
          SettingScope.User,
          `providers.${id}.${patchField}`,
          patchValue,
        );
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      return {
        type: 'message',
        messageType: 'error',
        content: `Updated in-memory but failed to persist ${field} for ${id}: ${reason}.`,
      };
    }
    // --- END LOCAL FORK ADDITION ---
    return {
      type: 'message',
      messageType: 'info',
      content:
        `Provider ${id} ${field} updated. ` +
        `Live on the next request \u2014 no restart needed.`,
    };
  },
};

/**
 * `/provider models [id]`
 *
 * Queries the provider's `/v1/models` endpoint (with auth) and prints a
 * numbered list of chat-capable models. The user can then pick one with
 * `/provider set <id> model <model-id>`.
 *
 * Phase 2.3: For Gemini ids, returns a redirect message — model selection
 * lives in the upstream SDK (e.g. just type the model name in the
 * provider dialog or set it via gemini-cli's own /model command).
 */
const modelsSubCommand: SlashCommand = {
  name: 'models',
  description:
    'List chat-capable models from the provider API (e.g. /provider models  or  /provider models openai  or  /provider models openrouter --max-price 0)',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (context, args): Promise<SlashCommandActionReturn> => {
    const resolved = resolveConfig(context);
    if (!resolved.ok) return resolved.error;
    const { config } = resolved;
    const customMap = config.getCustomProviders();

    // --- LOCAL FORK ADDITION (Phase 2.4.1: --max-price flag) ---
    // Parse optional --max-price <n> from the args string before extracting
    // the provider id. The flag is position-independent so both orderings
    // work:  /provider models openrouter --max-price 0
    //        /provider models --max-price 1 openrouter
    let maxPricePerMToken: number | undefined;
    let cleanArgs = args;
    const maxPriceMatch = args.match(/--max-price\s+(\S+)/);
    if (maxPriceMatch) {
      const parsed = parseFloat(maxPriceMatch[1]);
      if (isNaN(parsed) || parsed < 0) {
        return {
          type: 'message',
          messageType: 'error',
          content:
            `Invalid --max-price value '${maxPriceMatch[1]}'. ` +
            `Provide a non-negative number (USD per million tokens). ` +
            `Use 0 for free-only models.`,
        };
      }
      maxPricePerMToken = parsed;
      cleanArgs = args.replace(/--max-price\s+\S+/, '').trim();
    }
    // --- END LOCAL FORK ADDITION ---

    const requestedId = cleanArgs.trim() || config.getActiveProviderId();
    if (!requestedId) {
      return {
        type: 'message',
        messageType: 'error',
        content:
          'No active provider. Run /provider use <id> first, or specify: /provider models openai',
      };
    }
    const def = getProvider(requestedId, customMap);
    if (!def) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Unknown provider '${requestedId}'. Run /provider list to see available providers.`,
      };
    }

    // Phase 2.3: Gemini doesn't expose a /v1/models we own. Direct the
    // user to the upstream model picker (or just type the model name).
    if (def.wireFormat === 'gemini') {
      return {
        type: 'message',
        messageType: 'info',
        content:
          `Gemini model selection is handled upstream — set GEMINI_MODEL in env, ` +
          `pick from the /model command, or type the model name directly. ` +
          `The /provider models browser only applies to OpenAI-compat providers.`,
      };
    }

    const override = config.getProviderConfig(requestedId);
    let baseUrl: string;
    try {
      const r = resolveProvider(requestedId, override, customMap);
      baseUrl = r.baseUrl;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        type: 'message',
        messageType: 'error',
        content: `Provider config error: ${reason}`,
      };
    }

    let apiKey: string | undefined;
    if (def.requiresApiKey) {
      const k = await resolveProviderApiKey(requestedId);
      if (!k) {
        return {
          type: 'message',
          messageType: 'error',
          content:
            `No API key for '${requestedId}'. ` +
            `Set ${def.apiKeyEnvVar} or run /provider set ${requestedId} key <api-key>`,
        };
      }
      apiKey = k;
    }

    const currentModel = override?.model?.trim() || def.defaultModel;

    const models = await fetchProviderModels(
      baseUrl,
      apiKey ?? '',
      10_000,
      maxPricePerMToken,
    );
    if (models.length === 0) {
      // --- LOCAL FORK ADDITION (Phase 2.4.1) ---
      const filterHint =
        maxPricePerMToken !== undefined
          ? ` (with --max-price ${maxPricePerMToken})`
          : '';
      return {
        type: 'message',
        messageType: 'error',
        content:
          `No models found from ${def.displayName}${filterHint}. ` +
          (maxPricePerMToken !== undefined
            ? `Try raising --max-price or removing the flag. `
            : '') +
          `Check your API key and network connection.`,
      };
      // --- END LOCAL FORK ADDITION ---
    }

    // --- LOCAL FORK ADDITION (Phase 2.4.1: pricing column) ---
    const hasPricing = models.some((m) => m.pricing !== undefined);

    /**
     * Format USD-per-token as a readable "$/M tok" string.
     * "0" → "free", small values → up to 4 sig-figs, larger → 2 decimal places.
     */
    function formatPrice(perToken: number): string {
      const perM = perToken * 1_000_000;
      if (perM === 0) return 'free';
      if (perM < 0.01) return `$${perM.toPrecision(2)}/M`;
      return `$${perM.toFixed(2)}/M`;
    }
    // --- END LOCAL FORK ADDITION ---

    const filterLabel =
      maxPricePerMToken !== undefined
        ? ` — max $${maxPricePerMToken}/M tok prompt`
        : '';
    const lines: string[] = [
      `Models available from ${def.displayName} (${models.length} chat-capable${filterLabel}):`,
      '',
    ];
    for (let i = 0; i < models.length; i++) {
      const m = models[i];
      const marker = m.id === currentModel ? ' \u2713 (current)' : '';
      // --- LOCAL FORK ADDITION (Phase 2.4.1) ---
      let priceCol = '';
      if (hasPricing) {
        priceCol = m.pricing
          ? `  [in: ${formatPrice(m.pricing.promptPerToken)}  out: ${formatPrice(m.pricing.completionPerToken)}]`
          : '  [pricing n/a]';
      }
      // --- END LOCAL FORK ADDITION ---
      lines.push(
        `  ${String(i + 1).padStart(3, ' ')}. ${m.id}${marker}${priceCol}`,
      );
    }
    lines.push('');
    lines.push(
      `Run /provider set ${requestedId} model <model-id> to select one.`,
    );
    if (maxPricePerMToken === undefined && hasPricing) {
      lines.push(
        `Tip: use --max-price 0 to show only free models, or --max-price <n> for models ≤ $n/M prompt tokens.`,
      );
    }
    return {
      type: 'message',
      messageType: 'info',
      content: lines.join('\n'),
    };
  },
};

// --- LOCAL FORK ADDITION (Phase 2.3) ---
/**
 * `/provider add <id> <baseUrl> [<displayName>] [<apiKeyEnvVar>]`
 *
 * Registers a new user-defined OpenAI-compatible provider in
 * `settings.providers.custom.<id>`. Subsequent `/provider use <id>` and
 * dialog interactions see the entry as a first-class provider. Built-in
 * ids (gemini-* and openai) cannot be redefined.
 *
 * Positional args are deliberately spartan; the dialog's `add` screen
 * is the better UX for casual use. The CLI form exists for headless /
 * scripted setups.
 */
const addSubCommand: SlashCommand = {
  name: 'add',
  description:
    'Register a custom provider: /provider add [--wire-format <openai-chat|openai-responses>] <id> <baseUrl> [<displayName>] [<API_KEY_ENV>]',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: async (context, args): Promise<SlashCommandActionReturn> => {
    const resolved = resolveConfig(context);
    if (!resolved.ok) return resolved.error;
    const { config } = resolved;

    const rawParts = args.trim().split(/\s+/).filter(Boolean);
    // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
    // Strip an optional `--wire-format <value>` flag from anywhere in
    // the positional sequence. Defaults to 'openai-chat' to keep the
    // pre-2.4 form `/provider add <id> <url> ...` byte-identical.
    let wireFormat: 'openai-chat' | 'openai-responses' = 'openai-chat';
    const parts: string[] = [];
    for (let i = 0; i < rawParts.length; i++) {
      const tok = rawParts[i];
      if (tok === '--wire-format' || tok === '--wireFormat') {
        const next = rawParts[i + 1];
        if (!next) {
          return {
            type: 'message',
            messageType: 'error',
            content:
              `Missing value after --wire-format. ` +
              `Expected one of: openai-chat, openai-responses.`,
          };
        }
        if (next !== 'openai-chat' && next !== 'openai-responses') {
          return {
            type: 'message',
            messageType: 'error',
            content:
              `Unknown wire format '${next}'. ` +
              `Expected one of: openai-chat, openai-responses.`,
          };
        }
        wireFormat = next;
        i++; // consume the value
        continue;
      }
      const eqMatch = tok.match(/^--wire-?format=(.+)$/);
      if (eqMatch) {
        const next = eqMatch[1];
        if (next !== 'openai-chat' && next !== 'openai-responses') {
          return {
            type: 'message',
            messageType: 'error',
            content:
              `Unknown wire format '${next}'. ` +
              `Expected one of: openai-chat, openai-responses.`,
          };
        }
        wireFormat = next;
        continue;
      }
      parts.push(tok);
    }
    // --- END LOCAL FORK ADDITION ---
    if (parts.length < 2) {
      return {
        type: 'message',
        messageType: 'error',
        content:
          'Usage: /provider add [--wire-format <openai-chat|openai-responses>] ' +
          '<id> <baseUrl> [<displayName>] [<API_KEY_ENV>]\n' +
          '  e.g. /provider add my-vllm http://127.0.0.1:8000/v1/chat/completions ' +
          '"My vLLM"\n' +
          '  e.g. /provider add --wire-format openai-responses my-resp ' +
          'http://127.0.0.1:8000/v1/responses "Local Responses"',
      };
    }
    const [id, baseUrl, ...rest] = parts;

    // The display-name slot may legitimately contain spaces (e.g.
    // `"My vLLM"` quoted). Re-join the middle portion if there's a
    // trailing env-var token at the end.
    let displayName = id;
    let apiKeyEnvVar = '';
    if (rest.length > 0) {
      const last = rest[rest.length - 1];
      if (/^[A-Z][A-Z0-9_]*$/.test(last)) {
        apiKeyEnvVar = last;
        const middle = rest.slice(0, -1).join(' ').trim();
        if (middle) displayName = middle;
      } else {
        displayName = rest.join(' ').trim() || id;
      }
    }

    const idError = validateCustomProviderId(id);
    if (idError) {
      return {
        type: 'message',
        messageType: 'error',
        content: idError,
      };
    }

    const newDef: CustomProviderDefinition = {
      displayName,
      baseUrl,
      apiKeyEnvVar,
      // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
      // Defaults to 'openai-chat' for back-compat; explicit opt-in for
      // local Responses API endpoints (vLLM, LM Studio, Azure).
      wireFormat,
      // --- END LOCAL FORK ADDITION ---
    };

    try {
      config.addCustomProvider(id, newDef);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      return {
        type: 'message',
        messageType: 'error',
        content: `Failed to add custom provider '${id}': ${reason}`,
      };
    }

    // Persist to user-scope settings so the entry survives restart. We
    // write the whole `providers.custom` map (not the single entry) so
    // the schema's shallow-merge strategy treats it as a Record.
    try {
      const merged = config.getCustomProviders();
      context.services.settings.setValue(
        SettingScope.User,
        'providers.custom',
        merged,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      // In-memory state is fine; advise the user that disk persistence
      // failed so they can manually re-add on next launch.
      return {
        type: 'message',
        messageType: 'error',
        content:
          `Custom provider '${id}' registered for this session, but ` +
          `failed to persist to settings.json: ${reason}. ` +
          `It will not survive a restart.`,
      };
    }

    return {
      type: 'message',
      messageType: 'info',
      content:
        `Custom provider '${id}' added (wireFormat: ${wireFormat}). ` +
        `Run /provider use ${id} to switch to it, or /provider set ${id} model <name> ` +
        `to pick a default model.`,
    };
  },
};
// --- END LOCAL FORK ADDITION ---

const removeSubCommand: SlashCommand = {
  name: 'remove',
  description:
    'Remove a CUSTOM provider and its stored API key (built-ins protected). e.g. /provider remove my-vllm',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: async (context, args): Promise<SlashCommandActionReturn> => {
    const id = args.trim();
    if (!id) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Usage: /provider remove <id>',
      };
    }
    const resolved = resolveConfig(context);
    if (!resolved.ok) return resolved.error;
    const { config } = resolved;
    const customMap = config.getCustomProviders();
    if (!(id in customMap)) {
      const def = getProvider(id, customMap);
      if (def && !def.isCustom) {
        return {
          type: 'message',
          messageType: 'error',
          content:
            `'${id}' is a built-in provider and cannot be removed. ` +
            `Built-ins (gemini-*, openai) are read-only. ` +
            `To clear an API key for a built-in, unset its env var (e.g. unset $${def.apiKeyEnvVar}) ` +
            `or remove the keychain entry directly.`,
        };
      }
      return {
        type: 'message',
        messageType: 'error',
        content: `Unknown custom provider '${id}'. Run /provider list to see ids.`,
      };
    }

    const wasActive = config.getActiveProviderId() === id;

    // Drop the in-memory custom entry first (so refreshProviderConfig
    // doesn't try to resolve through a half-removed entry on rebuild).
    try {
      config.removeCustomProvider(id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      return {
        type: 'message',
        messageType: 'error',
        content: `Failed to remove custom provider '${id}': ${reason}`,
      };
    }

    // Drop runtime overrides + keychain entry via the existing path.
    try {
      await config.refreshProviderConfig({ removeProvider: id });
    } catch {
      // refreshProviderConfig handles missing entries; the only way
      // this can throw is if refreshAuth fails to rebuild after a
      // wasActive switch. We continue and surface that below.
    }

    // Persist the new custom map to user-scope settings.
    try {
      context.services.settings.setValue(
        SettingScope.User,
        'providers.custom',
        config.getCustomProviders(),
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      return {
        type: 'message',
        messageType: 'error',
        content:
          `Custom provider '${id}' removed in-memory but persisting failed: ${reason}. ` +
          `It may reappear after restart.`,
      };
    }

    // If we just nuked the active provider, fall back to gemini-oauth
    // (the safest default — no API key, no local server required).
    let nextActiveNote = '';
    if (wasActive) {
      try {
        await config.refreshProviderConfig({ active: 'gemini-oauth' });
        context.services.settings.setValue(
          SettingScope.User,
          'providers.active',
          'gemini-oauth',
        );
        nextActiveNote =
          ' Active provider fell back to gemini-oauth — run /auth to sign in if needed.';
      } catch {
        nextActiveNote =
          ' (Could not auto-switch to gemini-oauth; pick a provider with /provider use.)';
      }
    }

    return {
      type: 'message',
      messageType: 'info',
      content: `Custom provider '${id}' removed.${nextActiveNote}`,
    };
  },
};

/**
 * Top-level `/provider`: opens the ProviderDialog interactively. In ACP /
 * non-interactive mode the dialog UI isn't usable, so callers should run
 * `/provider list` to get a text dump instead.
 */
export const providerCommand: SlashCommand = {
  name: 'provider',
  description:
    'Manage LLM providers — switch active, edit settings, add or remove custom providers, browse models. Opens an interactive menu; use sub-commands for headless operation.',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: (_context): SlashCommandActionReturn => ({
    type: 'dialog',
    dialog: 'provider',
  }),
  subCommands: [
    listSubCommand,
    useSubCommand,
    modelsSubCommand,
    setSubCommand,
    addSubCommand,
    removeSubCommand,
  ],
};
