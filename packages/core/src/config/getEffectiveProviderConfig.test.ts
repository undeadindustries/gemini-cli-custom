/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// --- LOCAL FORK ADDITION (Phase 2.2) ---
// Tests for Config.getEffectiveProviderConfig(). This method is the single
// materialization point that decides "given current config state, what URL,
// model, contextLimit, wireFormat, authType, etc. should the active
// ContentGenerator actually use?". The cases below pin down the contract:
//
//   1. unconfigured            — returns undefined
//   2. provider path           — providers.active is set with a known id
//   3. provider override merge — per-instance overrides win over registry defaults
//   4. local presets           — local-vllm/llamacpp/generic preserve their
//                                no-key, openai-chat wireFormat shape
//   5. gemini entries          — gemini-oauth/apikey/vertex carry the
//                                'gemini' wireFormat plus their respective
//                                upstream AuthType
//   6. legacy-local fallback   — only local.url is set, no providers.active;
//                                synthesizes a local-vllm openai-chat shape
//                                so the rest of the stack stays uniform
//   7. malformed override      — soft fail, fall back to legacy-local rather
//                                than locking the user out
// --- END LOCAL FORK ADDITION ---

import { describe, it, expect, vi } from 'vitest';
import { Config, type ConfigParameters } from './config.js';
import { AuthType } from '../core/contentGenerator.js';

// Match the mocks in config.test.ts so we can `new Config()` synchronously
// without exercising real filesystem / tool discovery code paths.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    statSync: vi.fn().mockReturnValue({
      isDirectory: vi.fn().mockReturnValue(true),
    }),
    realpathSync: vi.fn((p: string) => p),
  };
});

vi.mock('../tools/tool-registry', () => {
  const ToolRegistryMock = vi.fn();
  ToolRegistryMock.prototype.registerTool = vi.fn();
  ToolRegistryMock.prototype.discoverAllTools = vi.fn();
  ToolRegistryMock.prototype.getAllTools = vi.fn(() => []);
  ToolRegistryMock.prototype.getAllToolNames = vi.fn(() => []);
  ToolRegistryMock.prototype.getFunctionDeclarations = vi.fn(() => []);
  return { ToolRegistry: ToolRegistryMock };
});

vi.mock('../tools/mcp-client-manager.js', () => ({
  McpClientManager: vi.fn().mockImplementation(() => ({
    startConfiguredMcpServers: vi.fn(),
    getMcpInstructions: vi.fn().mockReturnValue(''),
    setMainRegistries: vi.fn(),
  })),
}));

vi.mock('../tools/ls');
vi.mock('../tools/read-file');
vi.mock('../tools/grep.js');
vi.mock('../tools/ripGrep.js', () => ({
  canUseRipgrep: vi.fn(),
  RipGrepTool: class MockRipGrepTool {},
}));
vi.mock('../tools/glob');
vi.mock('../tools/edit');
vi.mock('../tools/shell');
vi.mock('../tools/write-file');
vi.mock('../tools/web-fetch');
vi.mock('../tools/read-many-files');
vi.mock('../tools/memoryTool', () => ({
  MemoryTool: vi.fn(),
  setGeminiMdFilename: vi.fn(),
  getCurrentGeminiMdFilename: vi.fn(() => 'GEMINI.md'),
  DEFAULT_CONTEXT_FILENAME: 'GEMINI.md',
  GEMINI_DIR: '.gemini',
}));
vi.mock('../core/contentGenerator.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../core/contentGenerator.js')>();
  // Keep the AuthType enum real (used by registry assertions); only stub
  // out the heavy createContentGenerator factory.
  return {
    ...actual,
    createContentGenerator: vi.fn(),
    createContentGeneratorConfig: vi.fn(),
  };
});
vi.mock('../core/client.js', () => ({
  GeminiClient: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    isInitialized: vi.fn().mockReturnValue(false),
  })),
}));
vi.mock('../services/gitService.js', () => {
  const GitServiceMock = vi.fn();
  GitServiceMock.prototype.initialize = vi.fn();
  return { GitService: GitServiceMock };
});
vi.mock('../services/fileDiscoveryService.js');

const baseParams: ConfigParameters = {
  cwd: '/tmp',
  embeddingModel: 'gemini-embedding',
  sandbox: { command: 'docker', image: 'test' } as ConfigParameters['sandbox'],
  targetDir: '/tmp/target',
  debugMode: false,
  sessionId: 'test-session',
  model: 'gemini-2.0-flash',
  usageStatisticsEnabled: false,
};

describe('Config.getEffectiveProviderConfig', () => {
  it('returns undefined when neither providers.active nor local.url is set', () => {
    const config = new Config(baseParams);
    expect(config.getEffectiveProviderConfig()).toBeUndefined();
  });

  it('resolves the provider path from registry defaults when providers.active is set with no overrides', () => {
    const config = new Config({
      ...baseParams,
      providersActive: 'openai',
    });

    const eff = config.getEffectiveProviderConfig();
    expect(eff).toBeDefined();
    expect(eff!.providerId).toBe('openai');
    expect(eff!.displayName).toBe('OpenAI');
    expect(eff!.requiresApiKey).toBe(true);
    expect(eff!.apiKeyEnvVar).toBe('OPENAI_API_KEY');
    expect(eff!.url).toMatch(/^https:\/\/api\.openai\.com/);
    expect(eff!.model).toBeTruthy();
    expect(eff!.wireFormat).toBe('openai-chat');
    expect(eff!.authType).toBe(AuthType.LOCAL);
  });

  it('merges per-instance overrides on top of registry defaults', () => {
    const config = new Config({
      ...baseParams,
      providersActive: 'openai',
      providersConfig: {
        openai: {
          model: 'gpt-4o-mini',
          baseUrl: 'https://proxy.example.com/v1',
          contextLimit: 64_000,
          promptMode: 'full',
          enableTools: false,
          timeout: 90_000,
        },
      },
    });

    const eff = config.getEffectiveProviderConfig();
    expect(eff).toBeDefined();
    expect(eff!.providerId).toBe('openai');
    expect(eff!.model).toBe('gpt-4o-mini');
    expect(eff!.url).toBe('https://proxy.example.com/v1');
    expect(eff!.contextLimit).toBe(64_000);
    expect(eff!.promptMode).toBe('full');
    expect(eff!.enableTools).toBe(false);
    expect(eff!.timeout).toBe(90_000);
  });

  it('substitutes the historical "local-model" placeholder when a custom local preset has no model configured (Phase 2.3)', () => {
    // Phase 2.3: local-vllm is a user-defined custom provider now, not a
    // built-in. Construct it via providersCustom and assert that the
    // historical "local-model" placeholder substitution still kicks in
    // when the user has not set a model.
    const config = new Config({
      ...baseParams,
      providersActive: 'local-vllm',
      providersCustom: {
        'local-vllm': {
          displayName: 'Local vLLM',
          baseUrl: 'http://127.0.0.1:8000/v1/chat/completions',
        },
      },
    });

    const eff = config.getEffectiveProviderConfig();
    expect(eff).toBeDefined();
    expect(eff!.providerId).toBe('local-vllm');
    expect(eff!.requiresApiKey).toBe(false);
    expect(eff!.apiKeyEnvVar).toBe('');
    expect(eff!.model).toBe('local-model');
    expect(eff!.url).toMatch(/^http:\/\/(127\.0\.0\.1|localhost)/);
    expect(eff!.wireFormat).toBe('openai-chat');
    expect(eff!.authType).toBe(AuthType.LOCAL);
  });

  it('preserves a user-supplied model on a custom local preset (Phase 2.3)', () => {
    const config = new Config({
      ...baseParams,
      providersActive: 'local-vllm',
      providersCustom: {
        'local-vllm': {
          displayName: 'Local vLLM',
          baseUrl: 'http://127.0.0.1:8000/v1/chat/completions',
        },
      },
      providersConfig: {
        'local-vllm': {
          model: 'Qwen/Qwen3-Coder-Next-FP8',
          contextLimit: 65_536,
        },
      },
    });

    const eff = config.getEffectiveProviderConfig();
    expect(eff).toBeDefined();
    expect(eff!.model).toBe('Qwen/Qwen3-Coder-Next-FP8');
    expect(eff!.contextLimit).toBe(65_536);
  });

  it('resolves a custom OpenAI-compat provider with API-key env var (Phase 2.3)', () => {
    const config = new Config({
      ...baseParams,
      providersActive: 'groq-prod',
      providersCustom: {
        'groq-prod': {
          displayName: 'Groq',
          baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
          defaultModel: 'llama-3.1-70b-versatile',
          apiKeyEnvVar: 'GROQ_API_KEY',
        },
      },
    });

    const eff = config.getEffectiveProviderConfig();
    expect(eff).toBeDefined();
    expect(eff!.providerId).toBe('groq-prod');
    expect(eff!.displayName).toBe('Groq');
    expect(eff!.wireFormat).toBe('openai-chat');
    expect(eff!.authType).toBe(AuthType.LOCAL);
    expect(eff!.requiresApiKey).toBe(true);
    expect(eff!.apiKeyEnvVar).toBe('GROQ_API_KEY');
    expect(eff!.model).toBe('llama-3.1-70b-versatile');
    expect(eff!.url).toBe('https://api.groq.com/openai/v1/chat/completions');
  });

  // --- LOCAL FORK ADDITION (Phase 2.3.1: per-provider sampler) ---
  it('surfaces a per-provider temperature override on the effective config', () => {
    const config = new Config({
      ...baseParams,
      providersActive: 'openai',
      providersConfig: {
        openai: {
          temperature: 0.6,
        },
      },
    });

    const eff = config.getEffectiveProviderConfig();
    expect(eff).toBeDefined();
    expect(eff!.temperature).toBe(0.6);
    // getLocalTemperature() must prefer the per-provider value over
    // the legacy global so LocalLlmContentGenerator picks it up.
    expect(config.getLocalTemperature()).toBe(0.6);
  });

  it('leaves temperature undefined when no override is set', () => {
    const config = new Config({
      ...baseParams,
      providersActive: 'openai',
    });

    const eff = config.getEffectiveProviderConfig();
    expect(eff).toBeDefined();
    expect(eff!.temperature).toBeUndefined();
    // No per-provider value AND no legacy global → null (server decides).
    expect(config.getLocalTemperature()).toBeNull();
  });

  it('surfaces temperature on a custom OpenAI-compat provider', () => {
    const config = new Config({
      ...baseParams,
      providersActive: 'my-vllm',
      providersCustom: {
        'my-vllm': {
          displayName: 'My vLLM',
          baseUrl: 'http://127.0.0.1:8000/v1/chat/completions',
        },
      },
      providersConfig: {
        'my-vllm': {
          temperature: 0.8,
        },
      },
    });

    const eff = config.getEffectiveProviderConfig();
    expect(eff).toBeDefined();
    expect(eff!.temperature).toBe(0.8);
    expect(config.getLocalTemperature()).toBe(0.8);
  });
  // --- END LOCAL FORK ADDITION ---

  it('returns undefined when active references an unknown id (no custom entry)', () => {
    // Phase 2.3 guard: with the legacy local-* presets gone, a stale
    // settings file pointing providers.active at one of them with no
    // matching custom entry must not crash; getEffectiveProviderConfig
    // soft-fails to undefined so the runtime can fall back.
    const config = new Config({
      ...baseParams,
      providersActive: 'local-vllm',
    });
    expect(config.getEffectiveProviderConfig()).toBeUndefined();
  });

  it('resolves gemini-oauth as the gemini wireFormat with LOGIN_WITH_GOOGLE auth', () => {
    const config = new Config({
      ...baseParams,
      providersActive: 'gemini-oauth',
    });

    const eff = config.getEffectiveProviderConfig();
    expect(eff).toBeDefined();
    expect(eff!.providerId).toBe('gemini-oauth');
    expect(eff!.wireFormat).toBe('gemini');
    expect(eff!.authType).toBe(AuthType.LOGIN_WITH_GOOGLE);
    expect(eff!.requiresApiKey).toBe(false);
    // Gemini entries don't have a fork-side URL — the upstream SDK owns
    // the wire — so the field is empty by registry design.
    expect(eff!.url).toBe('');
    expect(eff!.model).toBeTruthy();
  });

  it('resolves gemini-apikey as the gemini wireFormat with USE_GEMINI auth', () => {
    const config = new Config({
      ...baseParams,
      providersActive: 'gemini-apikey',
    });

    const eff = config.getEffectiveProviderConfig();
    expect(eff).toBeDefined();
    expect(eff!.providerId).toBe('gemini-apikey');
    expect(eff!.wireFormat).toBe('gemini');
    expect(eff!.authType).toBe(AuthType.USE_GEMINI);
    expect(eff!.requiresApiKey).toBe(true);
    expect(eff!.apiKeyEnvVar).toBe('GEMINI_API_KEY');
  });

  it('resolves gemini-vertex as the gemini wireFormat with USE_VERTEX_AI auth', () => {
    const config = new Config({
      ...baseParams,
      providersActive: 'gemini-vertex',
    });

    const eff = config.getEffectiveProviderConfig();
    expect(eff).toBeDefined();
    expect(eff!.providerId).toBe('gemini-vertex');
    expect(eff!.wireFormat).toBe('gemini');
    expect(eff!.authType).toBe(AuthType.USE_VERTEX_AI);
  });

  it('honours model + contextLimit overrides on a gemini entry', () => {
    const config = new Config({
      ...baseParams,
      providersActive: 'gemini-apikey',
      providersConfig: {
        'gemini-apikey': {
          model: 'gemini-2.5-flash',
          contextLimit: 524_288,
        },
      },
    });

    const eff = config.getEffectiveProviderConfig();
    expect(eff).toBeDefined();
    expect(eff!.model).toBe('gemini-2.5-flash');
    expect(eff!.contextLimit).toBe(524_288);
  });

  it('falls back to a synthetic local-vllm shape when only local.url is set (no providers.active)', () => {
    // The on-disk migration runs at Config construction time and writes
    // providers.active='local-vllm', so this fallback fires only on the
    // first launch after upgrade or if migration write fails. The
    // returned shape uses the local-vllm provider id so downstream code
    // doesn't have to special-case the fallback.
    const config = new Config({
      ...baseParams,
      localUrl: 'http://127.0.0.1:8000/v1/chat/completions',
      localModel: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-Base-BF16',
      localContextLimit: 65_536,
      localPromptMode: 'lite',
    });

    const eff = config.getEffectiveProviderConfig();
    expect(eff).toBeDefined();
    expect(eff!.providerId).toBe('local-vllm');
    expect(eff!.displayName).toBe('Local vLLM');
    expect(eff!.requiresApiKey).toBe(false);
    expect(eff!.apiKeyEnvVar).toBe('');
    expect(eff!.url).toBe('http://127.0.0.1:8000/v1/chat/completions');
    expect(eff!.model).toBe('nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-Base-BF16');
    expect(eff!.contextLimit).toBe(65_536);
    expect(eff!.wireFormat).toBe('openai-chat');
    expect(eff!.authType).toBe(AuthType.LOCAL);
  });

  it('treats a malformed provider config as a soft failure and falls back to the legacy-local synthetic shape', () => {
    // resolveProvider() throws InvalidProviderConfigError on a bad override;
    // getEffectiveProviderConfig() catches that to avoid locking the user
    // out of their existing local.url setup.
    const config = new Config({
      ...baseParams,
      providersActive: 'openai',
      providersConfig: {
        // Empty/whitespace baseUrl is invalid per validateProviderInstanceConfig.
        // The cast lets us deliberately exercise the catch-and-fall-back branch
        // without TypeScript blocking the test.
        openai: { baseUrl: '   ' as unknown as string },
      },
      localUrl: 'http://127.0.0.1:8000/v1/chat/completions',
      localModel: 'fallback-model',
    });

    const eff = config.getEffectiveProviderConfig();
    expect(eff).toBeDefined();
    expect(eff!.providerId).toBe('local-vllm');
    expect(eff!.url).toBe('http://127.0.0.1:8000/v1/chat/completions');
    expect(eff!.model).toBe('fallback-model');
  });

  it('makes getLocalUrl/getLocalModel/isLocalMode delegate to the resolved config', () => {
    const config = new Config({
      ...baseParams,
      providersActive: 'openai',
      providersConfig: {
        openai: {
          baseUrl: 'https://api.example.com/v1',
          model: 'gpt-test-model',
        },
      },
    });

    expect(config.getLocalUrl()).toBe('https://api.example.com/v1');
    expect(config.getLocalModel()).toBe('gpt-test-model');
    expect(config.isLocalMode()).toBe(true);
  });

  it('isLocalMode() returns false when neither path is configured', () => {
    const config = new Config(baseParams);
    expect(config.isLocalMode()).toBe(false);
  });

  // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
  describe('openai-responses (Phase 2.4)', () => {
    it('resolves the openai-responses built-in with default reasoningEffort + chaining', () => {
      const config = new Config({
        ...baseParams,
        providersActive: 'openai-responses',
      });
      const eff = config.getEffectiveProviderConfig();
      expect(eff).toBeDefined();
      expect(eff!.wireFormat).toBe('openai-responses');
      expect(eff!.url).toMatch(/\/v1\/responses$/);
      // Defaults: no reasoning override, chaining off.
      expect(eff!.reasoningEffort).toBeUndefined();
      expect(eff!.useResponseChaining).toBe(false);
    });

    it('isLocalMode() is FALSE for openai-responses (4-layer defense stays disabled)', () => {
      const config = new Config({
        ...baseParams,
        providersActive: 'openai-responses',
      });
      // The 4-layer context defense is keyed strictly on openai-chat; the
      // hosted Responses endpoint does not need (or want) it.
      expect(config.isLocalMode()).toBe(false);
    });

    it('surfaces reasoningEffort + useResponseChaining overrides', () => {
      const config = new Config({
        ...baseParams,
        providersActive: 'openai-responses',
        providersConfig: {
          'openai-responses': {
            reasoningEffort: 'high',
            useResponseChaining: true,
          },
        },
      });
      const eff = config.getEffectiveProviderConfig();
      expect(eff!.reasoningEffort).toBe('high');
      expect(eff!.useResponseChaining).toBe(true);
    });

    it('session reasoning override takes precedence over the persisted value', () => {
      const config = new Config({
        ...baseParams,
        providersActive: 'openai-responses',
        providersConfig: {
          'openai-responses': { reasoningEffort: 'low' },
        },
      });
      // No session override yet → resolver returns the provider value.
      expect(config.getReasoningEffort()).toBe('low');
      config.setSessionReasoningOverride('high');
      expect(config.getReasoningEffort()).toBe('high');
      config.clearSessionReasoningOverride();
      expect(config.getReasoningEffort()).toBe('low');
    });

    it('lastResponseId getter/setter/clearer round-trip a value', () => {
      const config = new Config({
        ...baseParams,
        providersActive: 'openai-responses',
      });
      expect(config.getLastResponseId?.()).toBeUndefined();
      config.setLastResponseId?.('resp_abc123');
      expect(config.getLastResponseId?.()).toBe('resp_abc123');
      config.clearLastResponseId?.();
      expect(config.getLastResponseId?.()).toBeUndefined();
    });
  });
  // --- END LOCAL FORK ADDITION ---
});
