/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ModelSlashCommandEvent,
  logModelSlashCommand,
  // --- LOCAL FORK ADDITION (Phase 2.4.6: route /model set through provider config) ---
  getProvider,
  // --- END LOCAL FORK ADDITION ---
} from '@google/gemini-cli-core';
import {
  type CommandContext,
  CommandKind,
  type SlashCommand,
} from './types.js';
import { MessageType } from '../types.js';
// --- LOCAL FORK ADDITION (Phase 2.4.6: route /model set through provider config) ---
import { SettingScope } from '../../config/settings.js';
// --- END LOCAL FORK ADDITION ---

const setModelCommand: SlashCommand = {
  name: 'set',
  description:
    'Set the model to use. Usage: /model set <model-name> [--persist]',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: async (context: CommandContext, args: string) => {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      context.ui.addItem({
        type: MessageType.ERROR,
        text: 'Usage: /model set <model-name> [--persist]',
      });
      return;
    }

    const modelName = parts[0];
    const persist = parts.includes('--persist');

    const cfg = context.services.agentContext?.config;
    if (!cfg) return;

    // --- LOCAL FORK ADDITION (Phase 2.4.6: route /model set through
    //     provider config for OpenAI-compat backends) ---
    //
    // Bug fixed: pre-2.4.6, `/model set <name>` only updated config.model
    // (the cosmetic value the footer reads). The OpenAI-compat generators
    // bake the model into their constructor from `effective.model` (=
    // providers.<id>.model || defaultModel), so the next request body
    // still shipped the OLD model. Symptom: footer flipped, wire body
    // didn't, and hosted endpoints like OpenRouter rejected with HTTP 400
    // when the underlying provider had no model set ('local-model'
    // placeholder leaking through).
    //
    // Fix: for openai-chat / openai-responses providers, persist to
    // providers.<id>.model AND call refreshProviderConfig() so the
    // generator is rebuilt with the new model. The setModel(eff.model,
    // true) call inside refreshAuth keeps the footer in sync. Gemini
    // providers keep the legacy direct config.setModel() path because
    // upstream Gemini wires use `model.name` settings directly.
    const activeId = cfg.getActiveProviderId?.();
    const customMap = cfg.getCustomProviders?.() ?? {};
    const def = activeId ? getProvider(activeId, customMap) : undefined;
    const wireFormat = def?.wireFormat;
    const isOpenAICompat =
      wireFormat === 'openai-chat' || wireFormat === 'openai-responses';

    if (activeId && isOpenAICompat) {
      if (persist) {
        try {
          context.services.settings.setValue(
            SettingScope.User,
            `providers.${activeId}.model`,
            modelName,
          );
        } catch (err: unknown) {
          const reason = err instanceof Error ? err.message : 'unknown error';
          context.ui.addItem({
            type: MessageType.ERROR,
            text: `Failed to persist model for '${activeId}': ${reason}`,
          });
          return;
        }
      }
      try {
        await cfg.refreshProviderConfig({
          setConfig: { id: activeId, patch: { model: modelName } },
        });
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : 'unknown error';
        context.ui.addItem({
          type: MessageType.ERROR,
          text: `Failed to apply model change: ${reason}`,
        });
        return;
      }
      const event = new ModelSlashCommandEvent(modelName);
      logModelSlashCommand(cfg, event);
      context.ui.addItem({
        type: MessageType.INFO,
        text:
          `Model for '${activeId}' set to ${modelName}` +
          (persist
            ? ' (persisted to settings.json)'
            : ' (session only — pass --persist to save)'),
      });
      return;
    }
    // --- END LOCAL FORK ADDITION ---

    // Gemini providers (or no active provider): existing behavior preserved.
    cfg.setModel(modelName, !persist);
    const event = new ModelSlashCommandEvent(modelName);
    logModelSlashCommand(cfg, event);

    context.ui.addItem({
      type: MessageType.INFO,
      text: `Model set to ${modelName}${persist ? ' (persisted)' : ''}`,
    });
  },
};

const manageModelCommand: SlashCommand = {
  name: 'manage',
  description: 'Opens a dialog to configure the model',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (context: CommandContext) => {
    if (context.services.agentContext?.config) {
      await context.services.agentContext.config.refreshUserQuota();
    }
    return {
      type: 'dialog',
      dialog: 'model',
    };
  },
};

export const modelCommand: SlashCommand = {
  name: 'model',
  description: 'Manage model configuration',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  subCommands: [manageModelCommand, setModelCommand],
  action: async (context: CommandContext, args: string) =>
    manageModelCommand.action!(context, args),
};
