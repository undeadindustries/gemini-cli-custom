/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CommandKind,
  type CommandContext,
  type OpenDialogActionReturn,
  type SlashCommand,
  type SlashCommandActionReturn,
} from './types.js';
import { MessageType } from '../types.js';

// --- LOCAL FORK ADDITION ---
// Top-level `/local` opens the dedicated dialog for configuring the local
// LLM server URL/model and the local-mode context-management knobs (context
// limit, compression threshold, Phase 2.0 smart-context layers).
//
// Sub-commands provide quick non-dialog shortcuts for the most common
// hot-reloadable settings, all of which exercise Config.refreshLocalConfig()
// added in Phase 2.0.2:
//   - /local show              -> print current local settings inline
//   - /local url <url>         -> hot-reload local.url
//   - /local model <model>     -> hot-reload local.model
//   - /local prompt <lite|full>-> hot-reload local.promptMode
//
// Designed to evolve toward multi-server support (a la Gemini flash/pro
// auto-routing) without breaking changes: see LocalServerCard / LocalServerView
// in components/LocalDialog.tsx.

/**
 * The set of valid `local.promptMode` values understood by the core
 * config. Kept in sync with packages/cli/src/config/settingsSchema.ts.
 */
const VALID_PROMPT_MODES = new Set(['lite', 'full']);

// --- LOCAL FORK ADDITION (Phase 2.0.12) ---
/**
 * The set of valid `local.toolCallParsing` modes understood by the core
 * parser. Kept in sync with parseXmlToolCalls in
 * packages/core/src/core/localLlmContentGenerator.ts and the schema entry
 * in packages/cli/src/config/settingsSchema.ts.
 */
const VALID_TOOL_CALL_PARSE_MODES = ['strict', 'lenient', 'loose'] as const;
type ToolCallParseMode = (typeof VALID_TOOL_CALL_PARSE_MODES)[number];
function isValidToolCallParseMode(v: string): v is ToolCallParseMode {
  return (VALID_TOOL_CALL_PARSE_MODES as readonly string[]).includes(v);
}
// --- END LOCAL FORK ADDITION ---

/**
 * Resolve the live `Config` instance from the command context, or return a
 * structured error suitable for surfacing to the user. We keep this in one
 * place so every sub-command behaves identically when Config is missing
 * (e.g. early startup / non-interactive mode).
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
          'Local commands are unavailable: the runtime Config is not loaded yet.',
      },
    };
  }
  return { ok: true as const, config };
}

/**
 * `/local show` — print the current local-mode settings without opening the
 * dialog. Useful for quick verification, scripting, and confirming a hot
 * reload took effect. Works in any auth mode; in non-local mode it surfaces
 * the configured values plus a hint that local mode is currently inactive.
 */
const showSubCommand: SlashCommand = {
  name: 'show',
  description:
    'Print current local LLM URL, model, prompt mode, and context limit',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (context) => {
    const resolved = resolveConfig(context);
    if (!resolved.ok) return resolved.error;
    const { config } = resolved;

    const url = config.getLocalUrl?.() ?? '(not set)';
    const model = config.getLocalModel?.() ?? '(not set)';
    const promptMode = config.getLocalPromptMode?.() ?? '(not set)';
    const contextLimit = config.getLocalContextLimit?.() ?? 0;
    const timeoutMs = config.getLocalTimeout?.() ?? 0;
    const inLocalMode = config.isLocalMode?.() ?? false;
    // --- LOCAL FORK ADDITION (Phase 2.0.12) ---
    const parserMode = config.getLocalToolCallParseMode?.() ?? '(not set)';
    // --- END LOCAL FORK ADDITION ---
    // --- LOCAL FORK ADDITION (Phase 2.0.13) ---
    const temperature = config.getLocalTemperature?.() ?? null;
    // --- END LOCAL FORK ADDITION ---

    const lines = [
      `Local LLM settings (${inLocalMode ? 'active' : 'configured but inactive — not in local mode'}):`,
      `  URL:          ${url || '(not set)'}`,
      `  Model:        ${model}`,
      `  Prompt mode:  ${promptMode}`,
      `  Context:      ${contextLimit.toLocaleString()} tokens`,
      `  Timeout:      ${timeoutMs.toLocaleString()} ms`,
      // --- LOCAL FORK ADDITION (Phase 2.0.13) ---
      `  Temperature:  ${temperature !== null ? String(temperature) : '(server default)'}`,
      // --- END LOCAL FORK ADDITION ---
      // --- LOCAL FORK ADDITION (Phase 2.0.12) ---
      `  Parser:       ${parserMode}`,
      // --- END LOCAL FORK ADDITION ---
      '',
      'Use /local to open the full settings dialog,',
      'or /local url|model|prompt|timeout|temperature|toolcall <value> for hot-reload shortcuts.',
    ];

    context.ui.addItem(
      { type: MessageType.INFO, text: lines.join('\n') },
      Date.now(),
    );
    return undefined;
  },
};

/**
 * Shared implementation for the three setter sub-commands. Trims user input,
 * rejects empty values, calls `Config.refreshLocalConfig()` so the change
 * takes effect on the next turn without a CLI restart, and surfaces any
 * refresh error inline so the user can correct course.
 *
 * @param context  The command context carrying services + UI handles.
 * @param args     The raw argument string after the sub-command name.
 * @param field    Which `refreshLocalConfig` field to update.
 * @param label    Human-readable name used in success / error messages.
 * @param validate Optional validator. Return a string error to abort, or
 *                 undefined to accept the value.
 */
async function applySetter(
  context: CommandContext,
  args: string,
  field: 'url' | 'model' | 'promptMode',
  label: string,
  validate?: (value: string) => string | undefined,
): Promise<SlashCommandActionReturn | void> {
  const value = args.trim();
  if (!value) {
    return {
      type: 'message',
      messageType: 'error',
      content: `Usage: /local ${field === 'promptMode' ? 'prompt' : field} <${label.toLowerCase()}>`,
    };
  }

  if (validate) {
    const validationError = validate(value);
    if (validationError) {
      return {
        type: 'message',
        messageType: 'error',
        content: validationError,
      };
    }
  }

  const resolved = resolveConfig(context);
  if (!resolved.ok) return resolved.error;
  const { config } = resolved;

  try {
    await config.refreshLocalConfig({ [field]: value });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown refresh error';
    return {
      type: 'message',
      messageType: 'error',
      content: `Failed to hot-reload local ${label}: ${reason}. The value is still set; fix the underlying issue (e.g. unreachable URL) and retry, or open /local to inspect.`,
    };
  }

  return {
    type: 'message',
    messageType: 'info',
    content: `Local ${label} updated to "${value}". Change is live on the next turn.`,
  };
}

const urlSubCommand: SlashCommand = {
  name: 'url',
  description:
    'Set the local LLM endpoint URL (e.g. http://127.0.0.1:8000/v1/chat/completions)',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: (context, args) => applySetter(context, args, 'url', 'URL'),
};

const modelSubCommand: SlashCommand = {
  name: 'model',
  description: 'Set the local LLM model name sent to the server',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: (context, args) => applySetter(context, args, 'model', 'model'),
};

const promptSubCommand: SlashCommand = {
  name: 'prompt',
  description: 'Set the local system prompt mode (lite or full)',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: (context, args) =>
    applySetter(context, args, 'promptMode', 'prompt mode', (value) =>
      VALID_PROMPT_MODES.has(value)
        ? undefined
        : `Invalid prompt mode "${value}". Expected one of: ${[...VALID_PROMPT_MODES].join(', ')}.`,
    ),
};

/**
 * `/local timeout <ms>` — hot-reload the request timeout without restarting.
 *
 * Accepts milliseconds as a positive integer. Common values:
 *   120000  — 2 min  (default)
 *   300000  — 5 min  (recommended for large codegen tasks)
 *   600000  — 10 min (long multi-file tasks with large models)
 */
const timeoutSubCommand: SlashCommand = {
  name: 'timeout',
  description:
    'Set the local LLM request timeout in milliseconds (e.g. /local timeout 300000)',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: async (context, args): Promise<SlashCommandActionReturn | void> => {
    const raw = args.trim();
    if (!raw) {
      return {
        type: 'message',
        messageType: 'error',
        content:
          'Usage: /local timeout <milliseconds>  (e.g. /local timeout 300000)',
      };
    }

    const ms = Number(raw);
    if (!Number.isFinite(ms) || ms <= 0 || !Number.isInteger(ms)) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Invalid timeout "${raw}". Must be a positive integer in milliseconds (e.g. 300000 for 5 minutes).`,
      };
    }

    const resolved = resolveConfig(context);
    if (!resolved.ok) return resolved.error;
    const { config } = resolved;

    try {
      await config.refreshLocalConfig({ timeout: ms });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      return {
        type: 'message',
        messageType: 'error',
        content: `Failed to update timeout: ${reason}`,
      };
    }

    const minutes = (ms / 60000).toFixed(1);
    return {
      type: 'message',
      messageType: 'info',
      content: `Local LLM timeout updated to ${ms.toLocaleString()} ms (${minutes} min). Live on the next request — no restart needed.`,
    };
  },
};

// --- LOCAL FORK ADDITION (Phase 2.0.12) ---
/**
 * `/local toolcall <strict|lenient|loose>` — hot-reload the content-side
 * tool-call parser hardening mode without restarting.
 *
 * Modes:
 *   - strict  : only match wrapped <tool_call>...</tool_call> blocks
 *   - lenient : (default) wrapped + bare <function=...> blocks gated by an
 *               orphaned </tool_call> intent signal
 *   - loose   : match any <function=...> block anywhere
 *
 * See parseXmlToolCalls in
 * packages/core/src/core/localLlmContentGenerator.ts for the full semantics
 * and the AGENT.md Phase 2.0.12 entry for backward-compat reasoning.
 */
const toolcallSubCommand: SlashCommand = {
  name: 'toolcall',
  description:
    'Set the local tool-call parser mode: strict | lenient | loose (e.g. /local toolcall lenient)',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: async (context, args): Promise<SlashCommandActionReturn | void> => {
    const raw = args.trim().toLowerCase();
    if (!raw) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Usage: /local toolcall <strict|lenient|loose>',
      };
    }
    if (!isValidToolCallParseMode(raw)) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Invalid tool-call parser mode "${raw}". Expected one of: ${VALID_TOOL_CALL_PARSE_MODES.join(', ')}.`,
      };
    }

    const resolved = resolveConfig(context);
    if (!resolved.ok) return resolved.error;
    const { config } = resolved;

    try {
      await config.refreshLocalConfig({ toolCallParseMode: raw });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      return {
        type: 'message',
        messageType: 'error',
        content: `Failed to update tool-call parser mode: ${reason}`,
      };
    }

    return {
      type: 'message',
      messageType: 'info',
      content: `Local tool-call parser mode → ${raw}. Live on the next response — no restart needed.`,
    };
  },
};
// --- END LOCAL FORK ADDITION ---

// --- LOCAL FORK ADDITION (Phase 2.0.13) ---
/**
 * `/local temperature <value|off>` — hot-reload the sampling temperature
 * without restarting.
 *
 * Pass a float between 0.0 and 2.0, or "off" / "default" to clear back to
 * the server's own generation_config.json default.
 *
 * Recommended values for Qwen3 (non-thinking mode): 0.6
 */
const temperatureSubCommand: SlashCommand = {
  name: 'temperature',
  description:
    'Set the local LLM sampling temperature 0.0–2.0, or "off" to use the model default (e.g. /local temperature 0.6)',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: async (context, args): Promise<SlashCommandActionReturn | void> => {
    const raw = args.trim().toLowerCase();
    if (!raw) {
      return {
        type: 'message',
        messageType: 'error',
        content:
          'Usage: /local temperature <0.0–2.0 | off>  (e.g. /local temperature 0.6)',
      };
    }

    const resolved = resolveConfig(context);
    if (!resolved.ok) return resolved.error;
    const { config } = resolved;

    if (raw === 'off' || raw === 'default' || raw === 'none') {
      try {
        await config.refreshLocalConfig({ temperature: null });
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'unknown error';
        return {
          type: 'message',
          messageType: 'error',
          content: `Failed to update temperature: ${reason}`,
        };
      }
      return {
        type: 'message',
        messageType: 'info',
        content: `Local LLM temperature cleared — server default will be used. Live on the next request.`,
      };
    }

    const temp = parseFloat(raw);
    if (!isFinite(temp) || temp < 0 || temp > 2) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Invalid temperature "${raw}". Must be a float between 0.0 and 2.0, or "off" to clear.`,
      };
    }

    try {
      await config.refreshLocalConfig({ temperature: temp });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      return {
        type: 'message',
        messageType: 'error',
        content: `Failed to update temperature: ${reason}`,
      };
    }

    return {
      type: 'message',
      messageType: 'info',
      content: `Local LLM temperature updated to ${temp}. Live on the next request — no restart needed.`,
    };
  },
};
// --- END LOCAL FORK ADDITION ---

export const localCommand: SlashCommand = {
  name: 'local',
  description: 'Configure the local LLM server and context settings',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: (_context, _args): OpenDialogActionReturn => ({
    type: 'dialog',
    dialog: 'local',
  }),
  subCommands: [
    showSubCommand,
    urlSubCommand,
    modelSubCommand,
    promptSubCommand,
    timeoutSubCommand,
    // --- LOCAL FORK ADDITION (Phase 2.0.12) ---
    toolcallSubCommand,
    // --- END LOCAL FORK ADDITION ---
    // --- LOCAL FORK ADDITION (Phase 2.0.13) ---
    temperatureSubCommand,
    // --- END LOCAL FORK ADDITION ---
  ],
};
// --- END LOCAL FORK ADDITION ---
