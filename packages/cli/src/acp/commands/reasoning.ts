/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// ACP-side `/reasoning` command (Phase 2.4 — OpenAI Responses API).
//
// Brand-new file (Category C — no fences).
//
// Mirrors the interactive `/reasoning` slash command in the CLI but
// strips out anything that would require a Render context (history
// items, dialog returns, autoExecute hints). Each non-interactive
// sub-command is registered separately so the headless dispatcher can
// surface them through `/help` per Rule 11.

import { SettingScope } from '../../config/settings.js';
import type {
  Command,
  CommandContext,
  CommandExecutionResponse,
} from './types.js';

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

function notApplicableMessage(activeWireFormat: string | undefined): string {
  const detected = activeWireFormat
    ? `wire format '${activeWireFormat}'`
    : 'no active provider';
  return (
    `Reasoning effort only applies to OpenAI Responses API providers ` +
    `(wireFormat: openai-responses); active provider has ${detected}. ` +
    `Switch with /provider use <id> first, or run /provider list.`
  );
}

export class ReasoningCommand implements Command {
  readonly name = 'reasoning';
  readonly description =
    'Show or override the reasoning effort for OpenAI Responses providers';
  readonly subCommands: Command[] = [
    new ReasoningShowCommand(),
    new ReasoningClearCommand(),
    new ReasoningSaveCommand(),
    ...VALID_LEVELS.map((level) => new ReasoningLevelCommand(level)),
  ];

  async execute(
    context: CommandContext,
    args: string[] = [],
  ): Promise<CommandExecutionResponse> {
    if (args.length === 0) {
      return new ReasoningShowCommand().execute(context, []);
    }
    const head = args[0];
    if (isReasoningLevel(head)) {
      return new ReasoningLevelCommand(head).execute(context, args.slice(1));
    }
    return {
      name: this.name,
      data:
        `Unknown sub-command '${head}'. Expected: show, clear, save <level>, ` +
        `or one of ${VALID_LEVELS.join(' | ')}.`,
    };
  }
}

export class ReasoningShowCommand implements Command {
  readonly name = 'reasoning show';
  readonly description =
    'Show the resolved reasoning effort and where it comes from';

  async execute(
    context: CommandContext,
    _args: string[] = [],
  ): Promise<CommandExecutionResponse> {
    const config = context.agentContext.config;
    const eff = config.getEffectiveProviderConfig();
    if (!eff) {
      return {
        name: this.name,
        data:
          'No active provider. Run /provider use <id> first ' +
          '(e.g. /provider use openai-responses).',
      };
    }
    if (eff.wireFormat !== 'openai-responses') {
      return { name: this.name, data: notApplicableMessage(eff.wireFormat) };
    }
    const session = config.getSessionReasoningOverride();
    const persisted = eff.reasoningEffort;
    const resolved = session ?? persisted;
    const lines: string[] = [];
    lines.push(`Active provider: ${eff.providerId} (${eff.displayName})`);
    if (resolved) {
      const source = session
        ? 'session override (set via /reasoning <level>)'
        : `provider default (providers.${eff.providerId}.reasoningEffort)`;
      lines.push(`Resolved reasoning effort: ${resolved} — ${source}`);
    } else {
      lines.push(
        `Resolved reasoning effort: (server default) — ` +
          `no session override or provider setting`,
      );
    }
    if (session && persisted && session !== persisted) {
      lines.push(
        `  Persistent value: ${persisted} ` +
          `(clear session override with /reasoning clear)`,
      );
    }
    return { name: this.name, data: lines.join('\n') };
  }
}

export class ReasoningClearCommand implements Command {
  readonly name = 'reasoning clear';
  readonly description =
    'Clear the session reasoning override (does not touch settings)';

  async execute(
    context: CommandContext,
    _args: string[] = [],
  ): Promise<CommandExecutionResponse> {
    const config = context.agentContext.config;
    const eff = config.getEffectiveProviderConfig();
    if (!eff || eff.wireFormat !== 'openai-responses') {
      return {
        name: this.name,
        data: notApplicableMessage(eff?.wireFormat),
      };
    }
    const had = config.getSessionReasoningOverride();
    config.clearSessionReasoningOverride();
    if (!had) {
      return {
        name: this.name,
        data:
          'No session reasoning override was set; nothing to clear. ' +
          `Provider default (providers.${eff.providerId}.reasoningEffort) ` +
          `remains: ${eff.reasoningEffort ?? '(server default)'}`,
      };
    }
    return {
      name: this.name,
      data:
        `Session reasoning override cleared. ` +
        `Falling back to provider default: ` +
        `${eff.reasoningEffort ?? '(server default)'}.`,
    };
  }
}

export class ReasoningSaveCommand implements Command {
  readonly name = 'reasoning save';
  readonly description =
    'Persist <level> to providers.<active>.reasoningEffort (e.g. /reasoning save low)';

  async execute(
    context: CommandContext,
    args: string[] = [],
  ): Promise<CommandExecutionResponse> {
    const config = context.agentContext.config;
    const eff = config.getEffectiveProviderConfig();
    if (!eff || eff.wireFormat !== 'openai-responses') {
      return {
        name: this.name,
        data: notApplicableMessage(eff?.wireFormat),
      };
    }
    const value = (args[0] ?? '').trim();
    if (!value) {
      return {
        name: this.name,
        data: `Usage: /reasoning save <level>  (level: ${VALID_LEVELS.join(' | ')})`,
      };
    }
    if (!isReasoningLevel(value)) {
      return {
        name: this.name,
        data:
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
        name: this.name,
        data: `Failed to update reasoning effort in memory: ${reason}`,
      };
    }
    try {
      context.settings.setValue(
        SettingScope.User,
        `providers.${eff.providerId}.reasoningEffort`,
        value,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      return {
        name: this.name,
        data: `Updated in-memory but failed to persist reasoningEffort: ${reason}.`,
      };
    }
    config.clearSessionReasoningOverride();
    return {
      name: this.name,
      data:
        `Saved providers.${eff.providerId}.reasoningEffort = ${value}. ` +
        `Live on the next request — no restart needed.`,
    };
  }
}

/**
 * One headless command per supported level so each shows up in `/help`.
 */
export class ReasoningLevelCommand implements Command {
  readonly name: string;
  readonly description: string;

  constructor(private readonly level: ReasoningLevel) {
    this.name = `reasoning ${level}`;
    this.description = `Set the session reasoning effort to '${level}' (not persisted)`;
  }

  async execute(
    context: CommandContext,
    _args: string[] = [],
  ): Promise<CommandExecutionResponse> {
    const config = context.agentContext.config;
    const eff = config.getEffectiveProviderConfig();
    if (!eff || eff.wireFormat !== 'openai-responses') {
      return {
        name: this.name,
        data: notApplicableMessage(eff?.wireFormat),
      };
    }
    config.setSessionReasoningOverride(this.level);
    return {
      name: this.name,
      data:
        `Session reasoning override set to '${this.level}'. ` +
        `Persist it with /reasoning save ${this.level} or drop it with /reasoning clear.`,
    };
  }
}
