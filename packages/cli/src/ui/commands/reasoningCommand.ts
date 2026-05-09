/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Reasoning-effort slash command (Phase 2.4).
//
// Brand-new file (Category C — no fences).
//
// Sub-commands:
//   /reasoning                        -> alias for `show`
//   /reasoning show                   -> print the resolved effort + source
//   /reasoning <minimal|low|medium|high>
//                                      -> set a session-only override
//   /reasoning clear                  -> drop the session override
//   /reasoning save <level>           -> persist <level> to the active
//                                       provider's settings.json entry
//                                       (`providers.<id>.reasoningEffort`)
//
// Only meaningful when the active provider's wireFormat is
// `'openai-responses'`. For any other wire format every action returns
// an actionable "not applicable" message — silent no-ops would be
// hostile when the user thought they had just changed something.
//
// Rule 11 compliance: every sub-command has a description, none hidden,
// all <= 100 chars, no interactive sub-flows, ACP-safe.

import {
  CommandKind,
  type CommandContext,
  type SlashCommand,
  type SlashCommandActionReturn,
} from './types.js';
import { SettingScope } from '../../config/settings.js';

type ReasoningLevel = 'minimal' | 'low' | 'medium' | 'high';
const VALID_LEVELS: readonly ReasoningLevel[] = [
  'minimal',
  'low',
  'medium',
  'high',
];

function isReasoningLevel(value: string): value is ReasoningLevel {
  return (VALID_LEVELS as readonly string[]).includes(value);
}

/**
 * Resolves the live `Config` instance from the command context, or
 * returns a structured error suitable for surfacing to the user.
 * Mirrors the shape used by providerCommand / localCommand.
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
          'Reasoning commands are unavailable: the runtime Config is not loaded yet.',
      },
    };
  }
  return { ok: true as const, config };
}

/**
 * Returns a "not applicable" error for the active provider, with a
 * concrete pointer to the OpenAI Responses API providers that DO honour
 * the setting. Never silently no-ops — keeps Rule 14 (truthfulness) and
 * the "no quiet fail" UX guarantee in this fork.
 */
function notApplicableError(activeWireFormat: string | undefined): {
  type: 'message';
  messageType: 'error';
  content: string;
} {
  const detected = activeWireFormat
    ? `wire format '${activeWireFormat}'`
    : 'no active provider';
  return {
    type: 'message',
    messageType: 'error',
    content:
      `Reasoning effort only applies to OpenAI Responses API providers ` +
      `(wireFormat: openai-responses); active provider has ${detected}. ` +
      `Switch with /provider use <id> first, or run /provider list.`,
  };
}

const showSubCommand: SlashCommand = {
  name: 'show',
  description: 'Show the resolved reasoning effort and where it comes from',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (context): Promise<SlashCommandActionReturn> => {
    const resolved = resolveConfig(context);
    if (!resolved.ok) return resolved.error;
    const { config } = resolved;
    const eff = config.getEffectiveProviderConfig();
    if (!eff) {
      return {
        type: 'message',
        messageType: 'error',
        content:
          'No active provider. Run /provider use <id> first ' +
          '(e.g. /provider use openai-responses).',
      };
    }
    if (eff.wireFormat !== 'openai-responses') {
      return notApplicableError(eff.wireFormat);
    }
    const session = config.getSessionReasoningOverride();
    const persisted = eff.reasoningEffort;
    const resolvedLevel = session ?? persisted;
    const lines: string[] = [];
    lines.push(`Active provider: ${eff.providerId} (${eff.displayName})`);
    if (resolvedLevel) {
      const source = session
        ? 'session override (set via /reasoning <level>)'
        : `provider default (providers.${eff.providerId}.reasoningEffort)`;
      lines.push(`Resolved reasoning effort: ${resolvedLevel} — ${source}`);
    } else {
      lines.push(
        `Resolved reasoning effort: (server default) — ` +
          `no session override or provider setting`,
      );
    }
    if (session && persisted && session !== persisted) {
      lines.push(
        `  Persistent value: ${persisted} (clear session override with /reasoning clear)`,
      );
    }
    return {
      type: 'message',
      messageType: 'info',
      content: lines.join('\n'),
    };
  },
};

const clearSubCommand: SlashCommand = {
  name: 'clear',
  description: 'Clear the session reasoning override (does not touch settings)',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (context): Promise<SlashCommandActionReturn> => {
    const resolved = resolveConfig(context);
    if (!resolved.ok) return resolved.error;
    const { config } = resolved;
    const eff = config.getEffectiveProviderConfig();
    if (!eff || eff.wireFormat !== 'openai-responses') {
      return notApplicableError(eff?.wireFormat);
    }
    const had = config.getSessionReasoningOverride();
    config.clearSessionReasoningOverride();
    if (!had) {
      return {
        type: 'message',
        messageType: 'info',
        content:
          'No session reasoning override was set; nothing to clear. ' +
          `Provider default (providers.${eff.providerId}.reasoningEffort) ` +
          `remains: ${eff.reasoningEffort ?? '(server default)'}`,
      };
    }
    return {
      type: 'message',
      messageType: 'info',
      content:
        `Session reasoning override cleared. ` +
        `Falling back to provider default: ` +
        `${eff.reasoningEffort ?? '(server default)'}.`,
    };
  },
};

const saveSubCommand: SlashCommand = {
  name: 'save',
  description:
    'Persist <level> to providers.<active>.reasoningEffort (e.g. /reasoning save low)',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: async (context, args): Promise<SlashCommandActionReturn> => {
    const resolved = resolveConfig(context);
    if (!resolved.ok) return resolved.error;
    const { config } = resolved;
    const eff = config.getEffectiveProviderConfig();
    if (!eff || eff.wireFormat !== 'openai-responses') {
      return notApplicableError(eff?.wireFormat);
    }
    const value = args.trim();
    if (!value) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Usage: /reasoning save <level>  (level: ${VALID_LEVELS.join(' | ')})`,
      };
    }
    if (!isReasoningLevel(value)) {
      return {
        type: 'message',
        messageType: 'error',
        content:
          `Unknown reasoning level '${value}'. Expected one of: ` +
          `${VALID_LEVELS.join(', ')}.`,
      };
    }
    try {
      await config.refreshProviderConfig({
        setConfig: { id: eff.providerId, patch: { reasoningEffort: value } },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      return {
        type: 'message',
        messageType: 'error',
        content: `Failed to update reasoning effort in memory: ${reason}`,
      };
    }
    try {
      context.services.settings.setValue(
        SettingScope.User,
        `providers.${eff.providerId}.reasoningEffort`,
        value,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      return {
        type: 'message',
        messageType: 'error',
        content: `Updated in-memory but failed to persist reasoningEffort: ${reason}.`,
      };
    }
    // Once persisted, the session override is redundant — drop it so
    // the next /reasoning show reads cleanly from the provider field.
    config.clearSessionReasoningOverride();
    return {
      type: 'message',
      messageType: 'info',
      content:
        `Saved providers.${eff.providerId}.reasoningEffort = ${value}. ` +
        `Live on the next request — no restart needed.`,
    };
  },
};

/**
 * Direct level sub-commands (one per VALID_LEVELS entry). Each sets the
 * session override; nothing is persisted. Implemented as concrete
 * SlashCommand entries so they appear in the /help and slash-completion
 * listings — Rule 11 wants every sub-command discoverable.
 */
function buildLevelSubCommand(level: ReasoningLevel): SlashCommand {
  return {
    name: level,
    description: `Set the session reasoning effort to '${level}' (not persisted)`,
    kind: CommandKind.BUILT_IN,
    autoExecute: true,
    action: async (context): Promise<SlashCommandActionReturn> => {
      const resolved = resolveConfig(context);
      if (!resolved.ok) return resolved.error;
      const { config } = resolved;
      const eff = config.getEffectiveProviderConfig();
      if (!eff || eff.wireFormat !== 'openai-responses') {
        return notApplicableError(eff?.wireFormat);
      }
      config.setSessionReasoningOverride(level);
      return {
        type: 'message',
        messageType: 'info',
        content:
          `Session reasoning override set to '${level}'. ` +
          `Persist it with /reasoning save ${level} or drop it with /reasoning clear.`,
      };
    },
  };
}

export const reasoningCommand: SlashCommand = {
  name: 'reasoning',
  description:
    'Show or override the reasoning effort for OpenAI Responses providers',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  subCommands: [
    showSubCommand,
    clearSubCommand,
    saveSubCommand,
    ...VALID_LEVELS.map(buildLevelSubCommand),
  ],
  action: async (context, args) => {
    const trimmed = args.trim();
    if (!trimmed) {
      return showSubCommand.action!(context, '');
    }
    const parts = trimmed.split(/\s+/);
    const head = parts[0];
    const rest = parts.slice(1).join(' ');
    // Allow `/reasoning <level>` as a shortcut for the level sub-command.
    if (isReasoningLevel(head)) {
      return buildLevelSubCommand(head).action!(context, rest);
    }
    return {
      type: 'message',
      messageType: 'error',
      content:
        `Unknown sub-command '${head}'. Expected: show, clear, save <level>, ` +
        `or one of ${VALID_LEVELS.join(' | ')}.`,
    };
  },
};
