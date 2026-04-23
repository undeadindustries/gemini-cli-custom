/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { localCommand } from './localCommand.js';
import { type CommandContext, type SlashCommand } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { MessageType } from '../types.js';

/**
 * Build a mock CommandContext that pretends an agentContext + Config exist.
 * `configOverrides` lets each test inject just the Config getters/methods it
 * needs without having to hand-roll the entire Config surface.
 */
function makeContextWithConfig(
  configOverrides: Partial<Record<string, unknown>> = {},
): CommandContext {
  const config = {
    getLocalUrl: vi.fn(() => 'http://127.0.0.1:8000/v1/chat/completions'),
    getLocalModel: vi.fn(() => 'qwen3-coder'),
    getLocalPromptMode: vi.fn(() => 'lite'),
    getLocalContextLimit: vi.fn(() => 32_768),
    getLocalTimeout: vi.fn(() => 120_000),
    // --- LOCAL FORK ADDITION (Phase 2.0.12) ---
    getLocalToolCallParseMode: vi.fn(() => 'lenient' as const),
    // --- END LOCAL FORK ADDITION ---
    isLocalMode: vi.fn(() => true),
    refreshLocalConfig: vi.fn().mockResolvedValue(undefined),
    ...configOverrides,
  };

  return createMockCommandContext({
    services: {
      agentContext: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        config: config as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    },
  });
}

/** Locate a sub-command by name; throws (loudly) if it disappeared. */
function getSub(name: string): SlashCommand {
  const sub = localCommand.subCommands?.find((c) => c.name === name);
  if (!sub) throw new Error(`Sub-command /local ${name} not found`);
  return sub;
}

describe('localCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    mockContext = createMockCommandContext();
  });

  it('should return a dialog action to open the local dialog', () => {
    if (!localCommand.action) {
      throw new Error('The local command must have an action.');
    }
    const result = localCommand.action(mockContext, '');
    expect(result).toEqual({
      type: 'dialog',
      dialog: 'local',
    });
  });

  it('should have the correct name and description', () => {
    expect(localCommand.name).toBe('local');
    expect(localCommand.description).toBe(
      'Configure the local LLM server and context settings',
    );
  });

  it('should be a built-in command that auto-executes', () => {
    expect(localCommand.kind).toBe('built-in');
    expect(localCommand.autoExecute).toBe(true);
  });

  it('should expose every documented sub-command with a description (so /help can list them)', () => {
    const expected = ['show', 'url', 'model', 'prompt', 'timeout', 'toolcall'];
    expect(localCommand.subCommands?.map((c) => c.name).sort()).toEqual(
      expected.sort(),
    );
    for (const sub of localCommand.subCommands ?? []) {
      expect(
        sub.description,
        `sub-command "${sub.name}" missing description`,
      ).toBeTruthy();
      expect(
        sub.hidden,
        `sub-command "${sub.name}" must not be hidden`,
      ).not.toBe(true);
    }
  });
});

describe('localCommand sub-commands: /local show', () => {
  it('prints the current local settings via an INFO message', async () => {
    const ctx = makeContextWithConfig();
    const show = getSub('show');
    await show.action!(ctx, '');

    expect(ctx.ui.addItem).toHaveBeenCalledTimes(1);
    const [item] = (ctx.ui.addItem as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(item.type).toBe(MessageType.INFO);
    expect(item.text).toContain('http://127.0.0.1:8000/v1/chat/completions');
    expect(item.text).toContain('qwen3-coder');
    expect(item.text).toContain('lite');
    expect(item.text).toContain('32,768');
    expect(item.text).toContain('active');
  });

  it('marks settings as inactive when not in local mode but still prints them', async () => {
    const ctx = makeContextWithConfig({ isLocalMode: vi.fn(() => false) });
    const show = getSub('show');
    await show.action!(ctx, '');

    const [item] = (ctx.ui.addItem as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(item.text).toContain('not in local mode');
    expect(item.text).toContain('qwen3-coder');
  });

  it('returns a friendly error if Config is unavailable', async () => {
    const show = getSub('show');
    const result = await show.action!(createMockCommandContext(), '');
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'error',
    });
  });
});

describe('localCommand sub-commands: setters', () => {
  it('/local url <value> calls refreshLocalConfig with the new URL', async () => {
    const ctx = makeContextWithConfig();
    const url = getSub('url');
    const result = await url.action!(
      ctx,
      '  http://10.0.0.5:8000/v1/chat/completions  ',
    );

    const config = ctx.services.agentContext!.config as unknown as {
      refreshLocalConfig: ReturnType<typeof vi.fn>;
    };
    expect(config.refreshLocalConfig).toHaveBeenCalledWith({
      url: 'http://10.0.0.5:8000/v1/chat/completions',
    });
    expect(result).toMatchObject({ type: 'message', messageType: 'info' });
  });

  it('/local model <value> calls refreshLocalConfig with the new model', async () => {
    const ctx = makeContextWithConfig();
    const model = getSub('model');
    await model.action!(ctx, 'devstral-2-medium');

    const config = ctx.services.agentContext!.config as unknown as {
      refreshLocalConfig: ReturnType<typeof vi.fn>;
    };
    expect(config.refreshLocalConfig).toHaveBeenCalledWith({
      model: 'devstral-2-medium',
    });
  });

  it('/local prompt accepts "lite" and "full"', async () => {
    const ctx = makeContextWithConfig();
    const prompt = getSub('prompt');
    await prompt.action!(ctx, 'full');

    const config = ctx.services.agentContext!.config as unknown as {
      refreshLocalConfig: ReturnType<typeof vi.fn>;
    };
    expect(config.refreshLocalConfig).toHaveBeenCalledWith({
      promptMode: 'full',
    });
  });

  it('/local prompt rejects an invalid mode and never calls refreshLocalConfig', async () => {
    const ctx = makeContextWithConfig();
    const prompt = getSub('prompt');
    const result = await prompt.action!(ctx, 'verbose');

    const config = ctx.services.agentContext!.config as unknown as {
      refreshLocalConfig: ReturnType<typeof vi.fn>;
    };
    expect(config.refreshLocalConfig).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'error',
    });

    expect((result as { content: string }).content).toContain(
      'Invalid prompt mode',
    );
  });

  it('setters with no argument return a usage error and skip refresh', async () => {
    const ctx = makeContextWithConfig();
    for (const name of ['url', 'model', 'prompt'] as const) {
      const sub = getSub(name);
      const result = await sub.action!(ctx, '   ');
      expect(result).toMatchObject({
        type: 'message',
        messageType: 'error',
      });

      expect((result as { content: string }).content).toContain('Usage:');
    }
    const config = ctx.services.agentContext!.config as unknown as {
      refreshLocalConfig: ReturnType<typeof vi.fn>;
    };
    expect(config.refreshLocalConfig).not.toHaveBeenCalled();
  });

  it('surfaces refreshLocalConfig errors back to the user without crashing', async () => {
    const ctx = makeContextWithConfig({
      refreshLocalConfig: vi
        .fn()
        .mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8000')),
    });
    const url = getSub('url');
    const result = await url.action!(
      ctx,
      'http://127.0.0.1:8000/v1/chat/completions',
    );

    expect(result).toMatchObject({ type: 'message', messageType: 'error' });

    expect((result as { content: string }).content).toContain('ECONNREFUSED');
  });
});

// --- LOCAL FORK ADDITION (Phase 2.0.12) ---
describe('localCommand sub-commands: /local toolcall', () => {
  for (const mode of ['strict', 'lenient', 'loose'] as const) {
    it(`accepts "${mode}" and hot-reloads via refreshLocalConfig`, async () => {
      const ctx = makeContextWithConfig();
      const toolcall = getSub('toolcall');
      const result = await toolcall.action!(ctx, mode);

      const config = ctx.services.agentContext!.config as unknown as {
        refreshLocalConfig: ReturnType<typeof vi.fn>;
      };
      expect(config.refreshLocalConfig).toHaveBeenCalledWith({
        toolCallParseMode: mode,
      });
      expect(result).toMatchObject({ type: 'message', messageType: 'info' });
      expect((result as { content: string }).content).toContain(mode);
    });
  }

  it('lowercases input before validating (e.g. "STRICT" → "strict")', async () => {
    const ctx = makeContextWithConfig();
    const toolcall = getSub('toolcall');
    await toolcall.action!(ctx, '  LENIENT  ');

    const config = ctx.services.agentContext!.config as unknown as {
      refreshLocalConfig: ReturnType<typeof vi.fn>;
    };
    expect(config.refreshLocalConfig).toHaveBeenCalledWith({
      toolCallParseMode: 'lenient',
    });
  });

  it('rejects an invalid mode and never calls refreshLocalConfig', async () => {
    const ctx = makeContextWithConfig();
    const toolcall = getSub('toolcall');
    const result = await toolcall.action!(ctx, 'banana');

    const config = ctx.services.agentContext!.config as unknown as {
      refreshLocalConfig: ReturnType<typeof vi.fn>;
    };
    expect(config.refreshLocalConfig).not.toHaveBeenCalled();
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect((result as { content: string }).content).toContain('Invalid');
  });

  it('rejects an empty argument with a usage error', async () => {
    const ctx = makeContextWithConfig();
    const toolcall = getSub('toolcall');
    const result = await toolcall.action!(ctx, '   ');

    const config = ctx.services.agentContext!.config as unknown as {
      refreshLocalConfig: ReturnType<typeof vi.fn>;
    };
    expect(config.refreshLocalConfig).not.toHaveBeenCalled();
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect((result as { content: string }).content).toContain('Usage:');
  });

  it('surfaces refreshLocalConfig errors without crashing', async () => {
    const ctx = makeContextWithConfig({
      refreshLocalConfig: vi
        .fn()
        .mockRejectedValue(new Error('refresh blew up')),
    });
    const toolcall = getSub('toolcall');
    const result = await toolcall.action!(ctx, 'strict');
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    expect((result as { content: string }).content).toContain(
      'refresh blew up',
    );
  });
});

describe('localCommand sub-commands: /local show (Phase 2.0.12 parser line)', () => {
  it('includes the active parser mode in the printed settings block', async () => {
    const ctx = makeContextWithConfig({
      getLocalToolCallParseMode: vi.fn(() => 'strict' as const),
    });
    const show = getSub('show');
    await show.action!(ctx, '');

    const [item] = (ctx.ui.addItem as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(item.text).toContain('Parser:');
    expect(item.text).toContain('strict');
  });
});
// --- END LOCAL FORK ADDITION ---
