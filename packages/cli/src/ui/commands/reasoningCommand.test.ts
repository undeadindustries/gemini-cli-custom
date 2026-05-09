/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reasoningCommand } from './reasoningCommand.js';
import { type CommandContext, type SlashCommand } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

interface FakeProviderConfig {
  providerId?: string;
  displayName?: string;
  wireFormat?: string;
  reasoningEffort?: string;
  useResponseChaining?: boolean;
}

interface FakeConfigOverrides {
  effective?: FakeProviderConfig | undefined;
  sessionOverride?: string | undefined;
}

function makeContext(overrides: FakeConfigOverrides = {}): {
  ctx: CommandContext;
  setSession: ReturnType<typeof vi.fn>;
  clearSession: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  setSettingValue: ReturnType<typeof vi.fn>;
} {
  let session: string | undefined = overrides.sessionOverride;

  const setSession = vi.fn((level: string) => {
    session = level;
  });
  const clearSession = vi.fn(() => {
    session = undefined;
  });
  const refresh = vi.fn().mockResolvedValue(undefined);
  const setSettingValue = vi.fn();

  const config = {
    getEffectiveProviderConfig: vi.fn(() =>
      overrides.effective === undefined
        ? {
            providerId: 'openai-responses',
            displayName: 'OpenAI Responses',
            wireFormat: 'openai-responses',
            reasoningEffort: 'medium',
            useResponseChaining: false,
          }
        : overrides.effective,
    ),
    getSessionReasoningOverride: vi.fn(() => session),
    setSessionReasoningOverride: setSession,
    clearSessionReasoningOverride: clearSession,
    refreshProviderConfig: refresh,
  };

  const ctx = createMockCommandContext({
    services: {
      agentContext: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        config: config as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      settings: { setValue: setSettingValue } as any,
    },
  });
  return { ctx, setSession, clearSession, refresh, setSettingValue };
}

function getSub(name: string): SlashCommand {
  const sub = reasoningCommand.subCommands?.find((c) => c.name === name);
  if (!sub) throw new Error(`Sub-command /reasoning ${name} not found`);
  return sub;
}

describe('reasoningCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes the documented top-level shape', () => {
    expect(reasoningCommand.name).toBe('reasoning');
    expect(reasoningCommand.kind).toBe('built-in');
    expect(reasoningCommand.description).toBeTruthy();
    const names = reasoningCommand.subCommands?.map((c) => c.name).sort();
    expect(names).toEqual(
      ['clear', 'high', 'low', 'medium', 'minimal', 'save', 'show'].sort(),
    );
  });

  it('every sub-command has a description and name <=100 chars', () => {
    for (const sub of reasoningCommand.subCommands ?? []) {
      expect(sub.description).toBeTruthy();
      expect((sub.description ?? '').length).toBeLessThanOrEqual(100);
    }
  });

  it('show: surfaces resolved level + provider source when no session override', async () => {
    const { ctx } = makeContext();
    const result = await getSub('show').action!(ctx, '');
    expect(result).toMatchObject({ type: 'message', messageType: 'info' });
    const msg = (result as { content: string }).content;
    expect(msg).toContain('Active provider: openai-responses');
    expect(msg).toContain('Resolved reasoning effort: medium');
    expect(msg).toContain('provider default');
  });

  it('show: marks the source as session override when one is set', async () => {
    const { ctx } = makeContext({ sessionOverride: 'high' });
    const result = await getSub('show').action!(ctx, '');
    const msg = (result as { content: string }).content;
    expect(msg).toContain('Resolved reasoning effort: high');
    expect(msg).toContain('session override');
  });

  it('show: errors with actionable message on non-Responses providers', async () => {
    const { ctx } = makeContext({
      effective: {
        providerId: 'openai',
        displayName: 'OpenAI',
        wireFormat: 'openai-chat',
      },
    });
    const result = await getSub('show').action!(ctx, '');
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
    const msg = (result as { content: string }).content;
    expect(msg).toContain('openai-responses');
    expect(msg).toContain("'openai-chat'");
  });

  it('<level>: sets a session override and confirms back', async () => {
    const { ctx, setSession } = makeContext();
    const result = await getSub('low').action!(ctx, '');
    expect(setSession).toHaveBeenCalledWith('low');
    expect((result as { content: string }).content).toContain("'low'");
  });

  it('<level>: refuses on non-Responses provider without mutating session', async () => {
    const { ctx, setSession } = makeContext({
      effective: {
        providerId: 'gemini-2.5-pro',
        displayName: 'Gemini',
        wireFormat: 'gemini',
      },
    });
    const result = await getSub('high').action!(ctx, '');
    expect(setSession).not.toHaveBeenCalled();
    expect(result).toMatchObject({ messageType: 'error' });
  });

  it('clear: clears an existing session override', async () => {
    const { ctx, clearSession } = makeContext({ sessionOverride: 'high' });
    const result = await getSub('clear').action!(ctx, '');
    expect(clearSession).toHaveBeenCalled();
    expect((result as { content: string }).content).toContain('cleared');
  });

  it('clear: reports no-op when no session override is set', async () => {
    const { ctx, clearSession } = makeContext();
    const result = await getSub('clear').action!(ctx, '');
    expect(clearSession).toHaveBeenCalled();
    expect((result as { content: string }).content).toContain(
      'nothing to clear',
    );
  });

  it('save: rejects when level is missing', async () => {
    const { ctx, setSettingValue } = makeContext();
    const result = await getSub('save').action!(ctx, '');
    expect(setSettingValue).not.toHaveBeenCalled();
    expect(result).toMatchObject({ messageType: 'error' });
    expect((result as { content: string }).content).toContain('Usage');
  });

  it('save: rejects unknown levels', async () => {
    const { ctx, setSettingValue } = makeContext();
    const result = await getSub('save').action!(ctx, 'bogus');
    expect(setSettingValue).not.toHaveBeenCalled();
    expect((result as { content: string }).content).toContain('Unknown');
  });

  it('save: persists to settings, refreshes config, and drops session override', async () => {
    const { ctx, setSettingValue, refresh, clearSession } = makeContext({
      sessionOverride: 'high',
    });
    const result = await getSub('save').action!(ctx, 'low');
    expect(refresh).toHaveBeenCalledWith({
      setConfig: {
        id: 'openai-responses',
        patch: { reasoningEffort: 'low' },
      },
    });
    expect(setSettingValue).toHaveBeenCalledWith(
      expect.anything(),
      'providers.openai-responses.reasoningEffort',
      'low',
    );
    expect(clearSession).toHaveBeenCalled();
    expect((result as { content: string }).content).toContain('Saved');
  });

  it('top-level /reasoning <level> shortcut sets the session override', async () => {
    const { ctx, setSession } = makeContext();
    const result = await reasoningCommand.action!(ctx, 'medium');
    expect(setSession).toHaveBeenCalledWith('medium');
    expect((result as { content: string }).content).toContain("'medium'");
  });

  it('top-level /reasoning with unknown sub-command surfaces an error', async () => {
    const { ctx } = makeContext();
    const result = await reasoningCommand.action!(ctx, 'frobnicate');
    expect(result).toMatchObject({ messageType: 'error' });
    expect((result as { content: string }).content).toContain('Unknown');
  });

  it('bare /reasoning aliases to show', async () => {
    const { ctx } = makeContext();
    const result = await reasoningCommand.action!(ctx, '');
    expect((result as { content: string }).content).toContain(
      'Resolved reasoning effort',
    );
  });
});
