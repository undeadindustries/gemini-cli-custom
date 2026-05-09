/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { providerCommand } from './providerCommand.js';
import { type CommandContext, type SlashCommand } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

// Mock the credential storage so tests never touch the real OS keychain.
const saveProviderApiKeyMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
const loadProviderApiKeyMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(null),
);

vi.mock('@google/gemini-cli-core', async () => {
  const actual: object = await vi.importActual('@google/gemini-cli-core');
  return {
    ...actual,
    saveProviderApiKey: saveProviderApiKeyMock,
    loadProviderApiKey: loadProviderApiKeyMock,
  };
});

interface FakeConfigOverrides {
  getActiveProviderId?: () => string | undefined;
  getProviderConfig?: (id: string) => unknown;
  getCustomProviders?: () => Record<string, unknown>;
  refreshProviderConfig?: (...args: unknown[]) => Promise<void>;
  addCustomProvider?: (...args: unknown[]) => void;
  removeCustomProvider?: (...args: unknown[]) => void;
}

function makeContext(overrides: FakeConfigOverrides = {}): CommandContext {
  const getCustomProviders = overrides.getCustomProviders ?? vi.fn(() => ({}));
  // Track in-memory custom map for add/remove flows.
  const customMap: Record<string, unknown> = {
    ...((getCustomProviders as () => Record<string, unknown>)?.() ?? {}),
  };

  const config = {
    getActiveProviderId: overrides.getActiveProviderId ?? vi.fn(() => 'openai'),
    getProviderConfig: overrides.getProviderConfig ?? vi.fn(() => undefined),
    getCustomProviders:
      overrides.getCustomProviders ??
      vi.fn(() => ({ ...customMap }) as Readonly<Record<string, unknown>>),
    refreshProviderConfig:
      overrides.refreshProviderConfig ?? vi.fn().mockResolvedValue(undefined),
    addCustomProvider:
      overrides.addCustomProvider ??
      vi.fn((id: string, def: unknown) => {
        customMap[id] = def;
      }),
    removeCustomProvider:
      overrides.removeCustomProvider ??
      vi.fn((id: string) => {
        delete customMap[id];
      }),
  };

  return createMockCommandContext({
    services: {
      agentContext: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        config: config as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      settings: { setValue: vi.fn() } as any,
    },
  });
}

function getSub(name: string): SlashCommand {
  const sub = providerCommand.subCommands?.find((c) => c.name === name);
  if (!sub) throw new Error(`Sub-command /provider ${name} not found`);
  return sub;
}

describe('providerCommand', () => {
  let originalOpenAiKey: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalOpenAiKey = process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
  });

  afterEach(() => {
    if (originalOpenAiKey !== undefined) {
      process.env['OPENAI_API_KEY'] = originalOpenAiKey;
    } else {
      delete process.env['OPENAI_API_KEY'];
    }
  });

  it('exposes the documented top-level shape', () => {
    expect(providerCommand.name).toBe('provider');
    expect(providerCommand.kind).toBe('built-in');
    expect(providerCommand.autoExecute).toBe(true);
    const names = providerCommand.subCommands?.map((c) => c.name).sort();
    // Phase 2.3 adds 'add' alongside the existing sub-commands.
    expect(names).toEqual(['add', 'list', 'models', 'remove', 'set', 'use']);
  });

  it('every sub-command has a description (so /help can list them)', () => {
    for (const sub of providerCommand.subCommands ?? []) {
      expect(sub.description).toBeTruthy();
    }
  });

  it('bare /provider returns a dialog action', () => {
    const ctx = createMockCommandContext();
    if (!providerCommand.action) throw new Error('no action');
    const result = providerCommand.action(ctx, '');
    expect(result).toEqual({ type: 'dialog', dialog: 'provider' });
  });

  describe('/provider list', () => {
    it('renders providers without leaking API keys, marks active with ▸', async () => {
      const ctx = makeContext();
      const sub = getSub('list');
      const result = await sub.action!(ctx, '');
      expect(result).toMatchObject({
        type: 'message',
        messageType: 'info',
      });
      const content = (result as { content: string }).content;
      // Phase 2.3: Hosted (Gemini), Hosted (OpenAI-compat), and (when
      // custom providers exist) Custom (user-defined) buckets.
      expect(content).toContain('Hosted (Gemini):');
      // Phase 2.4 split the OpenAI bucket into Chat Completions vs Responses.
      expect(content).toContain('Hosted (OpenAI Chat Completions):');
      // Active marker on the openai entry.
      expect(content).toMatch(/▸\s+openai/);
      expect(content).toContain('no key');
    });

    it('flags custom providers with [custom] (Phase 2.3)', async () => {
      const ctx = makeContext({
        getCustomProviders: vi.fn(() => ({
          'my-vllm': {
            displayName: 'My vLLM',
            baseUrl: 'http://127.0.0.1:8000/v1/chat/completions',
          },
        })),
      });
      const result = await getSub('list').action!(ctx, '');
      const content = (result as { content: string }).content;
      expect(content).toContain('Custom (user-defined):');
      expect(content).toContain('my-vllm');
      // Phase 2.4 includes the wire format alongside [custom].
      expect(content).toContain('[custom');
    });

    it('lists gemini-* entries under the Hosted (Gemini) bucket with auth-method copy', async () => {
      const ctx = makeContext();
      const result = await getSub('list').action!(ctx, '');
      const content = (result as { content: string }).content;
      expect(content).toContain('gemini-oauth');
      expect(content).toContain('gemini-apikey');
      expect(content).toContain('gemini-vertex');
      expect(content).toMatch(/gemini-oauth[\s\S]*?auth: OAuth[\s\S]*?\/auth/);
      expect(content).toMatch(/Vertex AI|ADC/);
    });

    it('reports env-var-backed key without printing the key value', async () => {
      process.env['OPENAI_API_KEY'] = 'sk-VERY-SECRET-KEY-XYZ';
      const ctx = makeContext();
      const result = await getSub('list').action!(ctx, '');
      const content = (result as { content: string }).content;
      expect(content).toContain('OPENAI_API_KEY');
      expect(content).not.toContain('sk-VERY-SECRET-KEY-XYZ');
    });

    it('reports keychain-backed key without calling out to it twice', async () => {
      loadProviderApiKeyMock.mockResolvedValueOnce('sk-IN-KEYCHAIN');
      const ctx = makeContext();
      const result = await getSub('list').action!(ctx, '');
      const content = (result as { content: string }).content;
      expect(content).toContain('key in keychain');
      expect(content).not.toContain('sk-IN-KEYCHAIN');
    });

    it('errors gracefully when Config is missing', async () => {
      const ctx = createMockCommandContext();
      const result = await getSub('list').action!(ctx, '');
      expect(result).toMatchObject({
        type: 'message',
        messageType: 'error',
      });
    });
  });

  describe('/provider use', () => {
    it('rejects unknown ids without touching Config', async () => {
      const refreshMock = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({ refreshProviderConfig: refreshMock });
      const result = await getSub('use').action!(ctx, 'no-such-provider');
      expect(result).toMatchObject({ messageType: 'error' });
      expect(refreshMock).not.toHaveBeenCalled();
    });

    it('refreshes Config when the id is valid', async () => {
      const refreshMock = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({ refreshProviderConfig: refreshMock });
      const result = await getSub('use').action!(ctx, 'openai');
      expect(refreshMock).toHaveBeenCalledWith({ active: 'openai' });
      expect(result).toMatchObject({ messageType: 'info' });
    });

    it('surfaces refresh errors as a structured error message', async () => {
      const refreshMock = vi
        .fn()
        .mockRejectedValue(new Error('hot-reload exploded'));
      const ctx = makeContext({ refreshProviderConfig: refreshMock });
      const result = await getSub('use').action!(ctx, 'openai');
      expect(result).toMatchObject({
        messageType: 'error',
      });
      expect((result as { content: string }).content).toContain(
        'hot-reload exploded',
      );
    });

    it('rejects empty argument with a usage message', async () => {
      const ctx = makeContext();
      const result = await getSub('use').action!(ctx, '   ');
      expect(result).toMatchObject({ messageType: 'error' });
      expect((result as { content: string }).content).toContain('Usage:');
    });
  });

  describe('/provider set', () => {
    it('saves an API key to the keychain (key field) and refreshes if active', async () => {
      const refreshMock = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({ refreshProviderConfig: refreshMock });
      const result = await getSub('set').action!(
        ctx,
        'openai key sk-test-12345',
      );
      expect(saveProviderApiKeyMock).toHaveBeenCalledWith(
        'openai',
        'sk-test-12345',
      );
      expect(refreshMock).toHaveBeenCalled();
      expect(result).toMatchObject({ messageType: 'info' });
      expect((result as { content: string }).content).not.toContain(
        'sk-test-12345',
      );
    });

    it('does NOT refresh when setting a key on a non-active provider', async () => {
      const refreshMock = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({
        getActiveProviderId: vi.fn(() => undefined),
        refreshProviderConfig: refreshMock,
      });
      await getSub('set').action!(ctx, 'openai key sk-test');
      expect(saveProviderApiKeyMock).toHaveBeenCalled();
      expect(refreshMock).not.toHaveBeenCalled();
    });

    it('hot-reloads model field via refreshProviderConfig.setConfig', async () => {
      const refreshMock = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({ refreshProviderConfig: refreshMock });
      const result = await getSub('set').action!(ctx, 'openai model gpt-4o');
      expect(refreshMock).toHaveBeenCalledWith({
        setConfig: { id: 'openai', patch: { model: 'gpt-4o' } },
      });
      expect(result).toMatchObject({ messageType: 'info' });
    });

    it('hot-reloads baseUrl field via refreshProviderConfig.setConfig', async () => {
      const refreshMock = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({ refreshProviderConfig: refreshMock });
      const url = 'https://example.com/v1/chat/completions';
      const result = await getSub('set').action!(ctx, `openai baseUrl ${url}`);
      expect(refreshMock).toHaveBeenCalledWith({
        setConfig: { id: 'openai', patch: { baseUrl: url } },
      });
      expect(result).toMatchObject({ messageType: 'info' });
    });

    it('rejects unknown field names', async () => {
      const ctx = makeContext();
      const result = await getSub('set').action!(ctx, 'openai bogus value');
      expect(result).toMatchObject({ messageType: 'error' });
      expect((result as { content: string }).content).toContain(
        'Unknown field',
      );
    });

    it('rejects unknown provider id', async () => {
      const ctx = makeContext();
      const result = await getSub('set').action!(ctx, 'no-such model gpt-4o');
      expect(result).toMatchObject({ messageType: 'error' });
      expect(saveProviderApiKeyMock).not.toHaveBeenCalled();
    });

    it('surfaces keychain save errors instead of silently swallowing them', async () => {
      saveProviderApiKeyMock.mockRejectedValueOnce(
        new Error('keychain locked'),
      );
      const ctx = makeContext();
      const result = await getSub('set').action!(ctx, 'openai key sk-test');
      expect(result).toMatchObject({ messageType: 'error' });
      expect((result as { content: string }).content).toContain(
        'keychain locked',
      );
    });

    it('rejects /provider set on Gemini ids (Phase 2.3)', async () => {
      const refreshMock = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({ refreshProviderConfig: refreshMock });
      for (const id of ['gemini-oauth', 'gemini-apikey', 'gemini-vertex']) {
        const result = await getSub('set').action!(
          ctx,
          `${id} model gemini-2.5-flash`,
        );
        expect(result).toMatchObject({ messageType: 'error' });
        expect((result as { content: string }).content).toMatch(
          /upstream defaults|nothing to configure/i,
        );
      }
      expect(refreshMock).not.toHaveBeenCalled();
      expect(saveProviderApiKeyMock).not.toHaveBeenCalled();
    });

    it('rejects key field for Gemini ids without saving anything', async () => {
      const ctx = makeContext();
      const result = await getSub('set').action!(
        ctx,
        'gemini-apikey key sk-fake',
      );
      expect(result).toMatchObject({ messageType: 'error' });
      expect(saveProviderApiKeyMock).not.toHaveBeenCalled();
    });
  });

  describe('/provider add (Phase 2.3)', () => {
    it('rejects empty / under-specified args', async () => {
      const ctx = makeContext();
      const result = await getSub('add').action!(ctx, '   ');
      expect(result).toMatchObject({ messageType: 'error' });
      expect((result as { content: string }).content).toContain('Usage');
    });

    it('rejects ids that collide with built-ins', async () => {
      const ctx = makeContext();
      const result = await getSub('add').action!(
        ctx,
        'openai https://example.com/v1/chat/completions',
      );
      expect(result).toMatchObject({ messageType: 'error' });
      expect((result as { content: string }).content).toMatch(/built-in/i);
    });

    it('rejects ids that fail validateCustomProviderId (UPPERCASE)', async () => {
      const ctx = makeContext();
      const result = await getSub('add').action!(
        ctx,
        'My-Custom https://example.com/v1/chat/completions',
      );
      expect(result).toMatchObject({ messageType: 'error' });
    });

    it('persists a minimal custom provider via Config.addCustomProvider', async () => {
      const addMock = vi.fn();
      const ctx = makeContext({ addCustomProvider: addMock });
      const result = await getSub('add').action!(
        ctx,
        'my-vllm http://127.0.0.1:8000/v1/chat/completions',
      );
      expect(result).toMatchObject({ messageType: 'info' });
      expect(addMock).toHaveBeenCalledTimes(1);
      const [id, def] = addMock.mock.calls[0];
      expect(id).toBe('my-vllm');
      expect(def).toMatchObject({
        baseUrl: 'http://127.0.0.1:8000/v1/chat/completions',
      });
    });

    it('parses trailing UPPER_SNAKE token as the env-var name', async () => {
      const addMock = vi.fn();
      const ctx = makeContext({ addCustomProvider: addMock });
      await getSub('add').action!(
        ctx,
        'groq-prod https://api.groq.com/openai/v1/chat/completions Groq GROQ_API_KEY',
      );
      expect(addMock).toHaveBeenCalledTimes(1);
      const [, def] = addMock.mock.calls[0];
      expect(def).toMatchObject({
        displayName: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
        apiKeyEnvVar: 'GROQ_API_KEY',
      });
    });
  });

  describe('/provider remove', () => {
    it('removes a custom provider via Config.removeCustomProvider', async () => {
      const removeMock = vi.fn();
      const refreshMock = vi.fn().mockResolvedValue(undefined);
      const customMap = {
        'my-vllm': {
          displayName: 'My vLLM',
          baseUrl: 'http://127.0.0.1:8000/v1/chat/completions',
        },
      };
      const ctx = makeContext({
        // Return the same map even after removal so subsequent reads in
        // the command body pass without hitting an empty record.
        getCustomProviders: vi.fn(() => customMap),
        removeCustomProvider: removeMock,
        refreshProviderConfig: refreshMock,
      });
      const result = await getSub('remove').action!(ctx, 'my-vllm');
      expect(result).toMatchObject({ messageType: 'info' });
      expect(removeMock).toHaveBeenCalledWith('my-vllm');
      expect(refreshMock).toHaveBeenCalledWith({ removeProvider: 'my-vllm' });
    });

    it('refuses to remove built-in providers (Phase 2.3)', async () => {
      const removeMock = vi.fn();
      const refreshMock = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({
        removeCustomProvider: removeMock,
        refreshProviderConfig: refreshMock,
      });
      const result = await getSub('remove').action!(ctx, 'openai');
      expect(result).toMatchObject({ messageType: 'error' });
      expect((result as { content: string }).content).toMatch(/built-in/i);
      expect(removeMock).not.toHaveBeenCalled();
      expect(refreshMock).not.toHaveBeenCalled();
    });

    it('rejects unknown ids without touching Config', async () => {
      const removeMock = vi.fn();
      const refreshMock = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({
        removeCustomProvider: removeMock,
        refreshProviderConfig: refreshMock,
      });
      const result = await getSub('remove').action!(ctx, 'no-such');
      expect(result).toMatchObject({ messageType: 'error' });
      expect(removeMock).not.toHaveBeenCalled();
      expect(refreshMock).not.toHaveBeenCalled();
    });
  });

  // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
  describe('/provider list (Phase 2.4 — Responses API bucket)', () => {
    it('renders openai-responses under the Responses API bucket', async () => {
      const ctx = makeContext();
      const result = await getSub('list').action!(ctx, '');
      const content = (result as { content: string }).content;
      expect(content).toContain('Hosted (OpenAI Responses API):');
      expect(content).toContain('openai-responses');
    });

    it('flags custom Responses providers with [custom • openai-responses]', async () => {
      const ctx = makeContext({
        getCustomProviders: vi.fn(() => ({
          'my-vllm-resp': {
            displayName: 'My vLLM Resp',
            baseUrl: 'http://127.0.0.1:8000/v1/responses',
            wireFormat: 'openai-responses',
          },
        })),
      });
      const result = await getSub('list').action!(ctx, '');
      const content = (result as { content: string }).content;
      expect(content).toContain('[custom • openai-responses]');
    });
  });

  describe('/provider add --wire-format (Phase 2.4)', () => {
    it('persists a custom provider with wireFormat: openai-responses', async () => {
      const addMock = vi.fn();
      const ctx = makeContext({ addCustomProvider: addMock });
      const result = await getSub('add').action!(
        ctx,
        '--wire-format openai-responses my-vllm-resp http://127.0.0.1:8000/v1/responses',
      );
      expect(result).toMatchObject({ messageType: 'info' });
      expect(addMock).toHaveBeenCalledTimes(1);
      const [id, def] = addMock.mock.calls[0];
      expect(id).toBe('my-vllm-resp');
      expect(def.wireFormat).toBe('openai-responses');
    });

    it('rejects unknown wire formats', async () => {
      const addMock = vi.fn();
      const ctx = makeContext({ addCustomProvider: addMock });
      const result = await getSub('add').action!(
        ctx,
        '--wire-format anthropic-messages my-prov http://example.com/v1',
      );
      expect(result).toMatchObject({ messageType: 'error' });
      expect(addMock).not.toHaveBeenCalled();
    });

    it('defaults to openai-chat when --wire-format is omitted', async () => {
      const addMock = vi.fn();
      const ctx = makeContext({ addCustomProvider: addMock });
      await getSub('add').action!(
        ctx,
        'my-vllm http://127.0.0.1:8000/v1/chat/completions',
      );
      const [, def] = addMock.mock.calls[0];
      // Default explicitly set to openai-chat so the persisted shape is unambiguous.
      expect(def.wireFormat).toBe('openai-chat');
    });
  });

  describe('/provider set reasoningEffort + useResponseChaining (Phase 2.4)', () => {
    it('hot-reloads reasoningEffort on a Responses-format custom provider', async () => {
      const refreshMock = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({
        getCustomProviders: vi.fn(() => ({
          'my-resp': {
            displayName: 'My Resp',
            baseUrl: 'http://example.com/v1/responses',
            wireFormat: 'openai-responses',
          },
        })),
        refreshProviderConfig: refreshMock,
      });
      const result = await getSub('set').action!(
        ctx,
        'my-resp reasoningEffort high',
      );
      expect(refreshMock).toHaveBeenCalledWith({
        setConfig: { id: 'my-resp', patch: { reasoningEffort: 'high' } },
      });
      expect(result).toMatchObject({ messageType: 'info' });
    });

    it('refuses reasoningEffort on a Chat-format provider', async () => {
      const refreshMock = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({ refreshProviderConfig: refreshMock });
      const result = await getSub('set').action!(
        ctx,
        'openai reasoningEffort high',
      );
      expect(result).toMatchObject({ messageType: 'error' });
      expect(refreshMock).not.toHaveBeenCalled();
    });

    it('hot-reloads useResponseChaining on a Responses-format provider', async () => {
      const refreshMock = vi.fn().mockResolvedValue(undefined);
      const ctx = makeContext({
        getCustomProviders: vi.fn(() => ({
          'my-resp': {
            displayName: 'My Resp',
            baseUrl: 'http://example.com/v1/responses',
            wireFormat: 'openai-responses',
          },
        })),
        refreshProviderConfig: refreshMock,
      });
      const result = await getSub('set').action!(
        ctx,
        'my-resp useResponseChaining true',
      );
      expect(refreshMock).toHaveBeenCalledWith({
        setConfig: { id: 'my-resp', patch: { useResponseChaining: true } },
      });
      expect(result).toMatchObject({ messageType: 'info' });
    });
  });
  // --- END LOCAL FORK ADDITION ---
});
