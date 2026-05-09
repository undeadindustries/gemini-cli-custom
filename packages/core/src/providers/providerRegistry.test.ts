/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_PROVIDERS,
  PROVIDER_REGISTRY,
  effectiveRegistry,
  customToProviderDefinition,
  validateCustomProviderId,
  getProvider,
  mustGetProvider,
  listProviderIds,
  resolveProvider,
  validateProviderInstanceConfig,
  UnknownProviderError,
  InvalidProviderConfigError,
  type CustomProviderDefinition,
} from './providerRegistry.js';
import { AuthType } from '../core/contentGenerator.js';

describe('providerRegistry', () => {
  describe('BUILT_IN_PROVIDERS (Phase 2.3)', () => {
    it('contains exactly the 5 built-in entries (incl. openai-responses, Phase 2.4)', () => {
      const ids = Object.keys(BUILT_IN_PROVIDERS).sort();
      expect(ids).toEqual(
        [
          'gemini-apikey',
          'gemini-oauth',
          'gemini-vertex',
          'openai',
          'openai-responses',
        ].sort(),
      );
    });

    it('does NOT contain the legacy local-* presets', () => {
      // Phase 2.3: these were promoted to user-defined custom providers.
      expect('local-vllm' in BUILT_IN_PROVIDERS).toBe(false);
      expect('local-llamacpp' in BUILT_IN_PROVIDERS).toBe(false);
      expect('local-generic' in BUILT_IN_PROVIDERS).toBe(false);
    });

    it('every entry has all required fields', () => {
      for (const id of Object.keys(BUILT_IN_PROVIDERS)) {
        const def = BUILT_IN_PROVIDERS[id];
        expect(def.id).toBe(id);
        expect(def.displayName).toBeTruthy();
        expect(def.authType).toBeTruthy();
        expect(Array.isArray(def.validSettingKeys)).toBe(true);
        expect(def.defaultContextLimit).toBeGreaterThan(0);
        expect(def.isCustom).toBe(false);
        if (def.wireFormat === 'gemini') {
          // Phase 2.3: Gemini providers expose zero editable settings.
          expect(def.validSettingKeys.length).toBe(0);
          expect(def.defaultModel).toBeTruthy();
        } else if (def.wireFormat === 'openai-chat') {
          expect(def.validSettingKeys).toContain('model');
          expect(def.authType).toBe(AuthType.LOCAL);
          if (def.requiresApiKey) {
            expect(def.defaultBaseUrl).toMatch(/^https:\/\//);
            expect(def.apiKeyEnvVar).toMatch(/^[A-Z][A-Z0-9_]+$/);
            expect(def.defaultModel).toBeTruthy();
          }
          const headers = def.buildAuthHeaders('test-key');
          if (def.requiresApiKey) {
            expect(headers['Authorization']).toBe('Bearer test-key');
          }
        }
      }
    });

    it('PROVIDER_REGISTRY is a deprecated alias of BUILT_IN_PROVIDERS', () => {
      // The CLI's compiled bundles import the old name; keep the alias
      // in lockstep.
      expect(PROVIDER_REGISTRY).toBe(BUILT_IN_PROVIDERS);
    });

    it('apiKeyEnvVar names are unique among hosted OpenAI-compat built-ins', () => {
      const seen = new Set<string>();
      for (const id of Object.keys(BUILT_IN_PROVIDERS)) {
        const def = BUILT_IN_PROVIDERS[id];
        if (def.wireFormat !== 'openai-chat') continue;
        if (!def.requiresApiKey) continue;
        expect(seen.has(def.apiKeyEnvVar)).toBe(false);
        seen.add(def.apiKeyEnvVar);
      }
    });

    it('gemini entries declare gemini wire format and matching AuthType', () => {
      expect(BUILT_IN_PROVIDERS['gemini-oauth'].wireFormat).toBe('gemini');
      expect(BUILT_IN_PROVIDERS['gemini-oauth'].authType).toBe(
        AuthType.LOGIN_WITH_GOOGLE,
      );
      expect(BUILT_IN_PROVIDERS['gemini-apikey'].wireFormat).toBe('gemini');
      expect(BUILT_IN_PROVIDERS['gemini-apikey'].authType).toBe(
        AuthType.USE_GEMINI,
      );
      expect(BUILT_IN_PROVIDERS['gemini-vertex'].wireFormat).toBe('gemini');
      expect(BUILT_IN_PROVIDERS['gemini-vertex'].authType).toBe(
        AuthType.USE_VERTEX_AI,
      );
    });

    it('gemini entries expose zero editable settings (Phase 2.3)', () => {
      for (const id of ['gemini-oauth', 'gemini-apikey', 'gemini-vertex']) {
        expect(BUILT_IN_PROVIDERS[id].validSettingKeys.length).toBe(0);
      }
    });

    it('openai built-in exposes the full settings sheet', () => {
      const def = BUILT_IN_PROVIDERS['openai'];
      for (const key of [
        'model',
        'baseUrl',
        'contextLimit',
        'promptMode',
        'enableTools',
        'timeout',
        // Phase 2.3.1: temperature is per-provider on OpenAI-compat.
        'temperature',
      ]) {
        expect(def.validSettingKeys).toContain(key);
      }
    });
  });

  describe('effectiveRegistry()', () => {
    it('returns built-ins only when no custom map is supplied', () => {
      const reg = effectiveRegistry();
      expect(Object.keys(reg).sort()).toEqual(
        Object.keys(BUILT_IN_PROVIDERS).sort(),
      );
    });

    it('merges custom entries on top of built-ins', () => {
      const custom: Record<string, CustomProviderDefinition> = {
        'my-vllm': {
          displayName: 'My vLLM',
          baseUrl: 'http://127.0.0.1:8000/v1/chat/completions',
        },
      };
      const reg = effectiveRegistry(custom);
      expect(reg['my-vllm']).toBeDefined();
      expect(reg['my-vllm'].isCustom).toBe(true);
      expect(reg['my-vllm'].defaultBaseUrl).toBe(
        'http://127.0.0.1:8000/v1/chat/completions',
      );
      // Built-ins still present.
      expect(reg['openai']).toBe(BUILT_IN_PROVIDERS['openai']);
    });

    it('built-ins win on id collision (custom entry is dropped)', () => {
      const custom: Record<string, CustomProviderDefinition> = {
        openai: {
          displayName: 'Hijacked',
          baseUrl: 'http://attacker.example/v1/chat/completions',
        },
      };
      const reg = effectiveRegistry(custom);
      expect(reg['openai']).toBe(BUILT_IN_PROVIDERS['openai']);
      expect(reg['openai'].displayName).toBe('OpenAI');
    });

    it('skips falsy / null custom entries', () => {
      const custom = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        'bad-entry': null as any,
      } as Record<string, CustomProviderDefinition>;
      const reg = effectiveRegistry(custom);
      expect('bad-entry' in reg).toBe(false);
    });
  });

  describe('customToProviderDefinition()', () => {
    it('coerces minimal custom entries to OpenAI-compat / LOCAL', () => {
      const def = customToProviderDefinition('my-llm', {
        displayName: 'My LLM',
        baseUrl: 'http://127.0.0.1:8000/v1/chat/completions',
      });
      expect(def.id).toBe('my-llm');
      expect(def.displayName).toBe('My LLM');
      expect(def.wireFormat).toBe('openai-chat');
      expect(def.authType).toBe(AuthType.LOCAL);
      expect(def.requiresApiKey).toBe(false);
      expect(def.apiKeyEnvVar).toBe('');
      expect(def.defaultModel).toBe('');
      expect(def.defaultContextLimit).toBe(32_768);
      expect(def.isCustom).toBe(true);
      // No-auth header builder must return an empty record.
      expect(def.buildAuthHeaders('test-key')).toEqual({});
    });

    it('flips requiresApiKey when apiKeyEnvVar is non-empty', () => {
      const def = customToProviderDefinition('groq', {
        displayName: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
        apiKeyEnvVar: 'GROQ_API_KEY',
      });
      expect(def.requiresApiKey).toBe(true);
      expect(def.buildAuthHeaders('xyz')).toEqual({
        Authorization: 'Bearer xyz',
      });
    });

    it('falls back to id when displayName is empty', () => {
      const def = customToProviderDefinition('lonely', {
        displayName: '   ',
        baseUrl: 'http://127.0.0.1:8000/v1/chat/completions',
      });
      expect(def.displayName).toBe('lonely');
    });
  });

  describe('validateCustomProviderId()', () => {
    it('accepts valid kebab-case ids', () => {
      expect(validateCustomProviderId('my-vllm')).toBeNull();
      expect(validateCustomProviderId('groq-prod')).toBeNull();
      expect(validateCustomProviderId('a1-b2-c3')).toBeNull();
    });

    it('rejects empty / non-string', () => {
      expect(validateCustomProviderId('')).not.toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(validateCustomProviderId(undefined as any)).not.toBeNull();
    });

    it('rejects upper-case, underscores, leading/trailing hyphens', () => {
      expect(validateCustomProviderId('My-VLLM')).not.toBeNull();
      expect(validateCustomProviderId('my_vllm')).not.toBeNull();
      expect(validateCustomProviderId('-leading')).not.toBeNull();
      expect(validateCustomProviderId('trailing-')).not.toBeNull();
    });

    it('rejects ids that collide with built-ins', () => {
      expect(validateCustomProviderId('openai')).not.toBeNull();
      expect(validateCustomProviderId('gemini-oauth')).not.toBeNull();
    });

    it('rejects too-short and too-long ids', () => {
      expect(validateCustomProviderId('a')).not.toBeNull();
      expect(validateCustomProviderId('a'.repeat(49))).not.toBeNull();
    });
  });

  describe('lookup helpers honor the custom map', () => {
    const custom: Record<string, CustomProviderDefinition> = {
      'my-vllm': {
        displayName: 'My vLLM',
        baseUrl: 'http://127.0.0.1:8000/v1/chat/completions',
      },
    };

    it('listProviderIds includes custom ids in insertion order', () => {
      const ids = listProviderIds(custom);
      expect(ids).toContain('openai');
      expect(ids).toContain('my-vllm');
    });

    it('getProvider finds custom entries when supplied', () => {
      expect(getProvider('my-vllm', custom)?.isCustom).toBe(true);
      expect(getProvider('my-vllm')).toBeUndefined(); // Without custom: not found.
    });

    it('mustGetProvider throws for unknown ids without custom map', () => {
      expect(() => mustGetProvider('my-vllm')).toThrow(UnknownProviderError);
      expect(mustGetProvider('my-vllm', custom).id).toBe('my-vllm');
    });

    it('resolveProvider works on a custom entry with overrides', () => {
      const r = resolveProvider(
        'my-vllm',
        { model: 'Qwen/Qwen3-Coder-Next-FP8' },
        custom,
      );
      expect(r.model).toBe('Qwen/Qwen3-Coder-Next-FP8');
      expect(r.baseUrl).toBe('http://127.0.0.1:8000/v1/chat/completions');
    });
  });

  describe('classic resolveProvider behavior', () => {
    it('returns undefined-via-getProvider for unknown ids', () => {
      expect(getProvider('does-not-exist')).toBeUndefined();
    });

    it('mustGetProvider throws UnknownProviderError for unknown ids', () => {
      expect(() => mustGetProvider('does-not-exist')).toThrow(
        UnknownProviderError,
      );
    });

    it('resolveProvider merges defaults with overrides', () => {
      const r = resolveProvider('openai', {
        model: 'gpt-4o',
        baseUrl: 'https://example.com/v1/chat/completions',
      });
      expect(r.model).toBe('gpt-4o');
      expect(r.baseUrl).toBe('https://example.com/v1/chat/completions');
      expect(r.contextLimit).toBe(
        BUILT_IN_PROVIDERS['openai'].defaultContextLimit,
      );
    });

    it('resolveProvider returns registry defaults when no override given', () => {
      const r = resolveProvider('openai', undefined);
      const def = BUILT_IN_PROVIDERS['openai'];
      expect(r.model).toBe(def.defaultModel);
      expect(r.baseUrl).toBe(def.defaultBaseUrl);
      expect(r.contextLimit).toBe(def.defaultContextLimit);
    });

    it('resolveProvider throws InvalidProviderConfigError for malformed baseUrl', () => {
      expect(() => resolveProvider('openai', { baseUrl: 'not-a-url' })).toThrow(
        InvalidProviderConfigError,
      );
    });

    it('resolveProvider throws InvalidProviderConfigError for negative contextLimit', () => {
      expect(() => resolveProvider('openai', { contextLimit: -1 })).toThrow(
        InvalidProviderConfigError,
      );
    });

    it('resolveProvider throws UnknownProviderError for unknown provider id', () => {
      expect(() => resolveProvider('nope', {})).toThrow(UnknownProviderError);
    });

    // --- LOCAL FORK ADDITION (Phase 2.3.1: per-provider sampler) ---
    describe('temperature (Phase 2.3.1)', () => {
      it('resolveProvider passes through a valid temperature override', () => {
        const r = resolveProvider('openai', { temperature: 0.6 });
        expect(r.temperature).toBe(0.6);
      });

      it('resolveProvider leaves temperature undefined when not set', () => {
        const r = resolveProvider('openai', {});
        expect(r.temperature).toBeUndefined();
      });

      it('accepts the boundary values 0 and 2', () => {
        expect(
          validateProviderInstanceConfig('openai', { temperature: 0 }),
        ).toHaveLength(0);
        expect(
          validateProviderInstanceConfig('openai', { temperature: 2 }),
        ).toHaveLength(0);
      });

      it('rejects negative, >2, NaN, Infinity, and non-numeric values', () => {
        for (const bad of [-0.01, 2.01, Number.NaN, Number.POSITIVE_INFINITY]) {
          const errs = validateProviderInstanceConfig('openai', {
            temperature: bad,
          });
          expect(errs.map((e) => e.field)).toContain('temperature');
        }
        const errs = validateProviderInstanceConfig('openai', {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          temperature: 'hot' as any,
        });
        expect(errs.map((e) => e.field)).toContain('temperature');
      });

      it('resolveProvider throws InvalidProviderConfigError on bad temperature', () => {
        expect(() => resolveProvider('openai', { temperature: 5 })).toThrow(
          InvalidProviderConfigError,
        );
      });
    });
    // --- END LOCAL FORK ADDITION ---

    // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
    describe('openai-responses built-in (Phase 2.4)', () => {
      it('is registered with the openai-responses wire format', () => {
        const def = BUILT_IN_PROVIDERS['openai-responses'];
        expect(def).toBeDefined();
        expect(def.wireFormat).toBe('openai-responses');
        expect(def.requiresApiKey).toBe(true);
        expect(def.apiKeyEnvVar).toBe('OPENAI_API_KEY');
        expect(def.defaultBaseUrl).toMatch(/\/v1\/responses$/);
      });

      it('exposes reasoningEffort and useResponseChaining setting keys', () => {
        const def = BUILT_IN_PROVIDERS['openai-responses'];
        expect(def.validSettingKeys).toContain('reasoningEffort');
        expect(def.validSettingKeys).toContain('useResponseChaining');
      });

      it('resolveProvider passes reasoningEffort through', () => {
        const r = resolveProvider('openai-responses', {
          reasoningEffort: 'high',
        });
        expect(r.reasoningEffort).toBe('high');
      });

      it('resolveProvider passes useResponseChaining through', () => {
        const r = resolveProvider('openai-responses', {
          useResponseChaining: true,
        });
        expect(r.useResponseChaining).toBe(true);
      });

      it('rejects unknown reasoningEffort values', () => {
        const errs = validateProviderInstanceConfig('openai-responses', {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          reasoningEffort: 'extreme' as any,
        });
        expect(errs.map((e) => e.field)).toContain('reasoningEffort');
      });

      it('accepts every documented reasoningEffort level', () => {
        for (const level of ['minimal', 'low', 'medium', 'high'] as const) {
          const errs = validateProviderInstanceConfig('openai-responses', {
            reasoningEffort: level,
          });
          expect(
            errs.filter((e) => e.field === 'reasoningEffort'),
          ).toHaveLength(0);
        }
      });

      it('rejects non-boolean useResponseChaining', () => {
        const errs = validateProviderInstanceConfig('openai-responses', {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          useResponseChaining: 'yes' as any,
        });
        expect(errs.map((e) => e.field)).toContain('useResponseChaining');
      });

      it('customToProviderDefinition honors wireFormat: openai-responses', () => {
        const def = customToProviderDefinition('my-vllm-resp', {
          displayName: 'My vLLM (Responses)',
          baseUrl: 'http://127.0.0.1:8000/v1/responses',
          wireFormat: 'openai-responses',
        });
        expect(def.wireFormat).toBe('openai-responses');
        expect(def.validSettingKeys).toContain('reasoningEffort');
        expect(def.validSettingKeys).toContain('useResponseChaining');
      });

      it('customToProviderDefinition defaults to openai-chat when wireFormat is omitted', () => {
        const def = customToProviderDefinition('my-vllm', {
          displayName: 'My vLLM',
          baseUrl: 'http://127.0.0.1:8000/v1/chat/completions',
        });
        expect(def.wireFormat).toBe('openai-chat');
      });
    });
    // --- END LOCAL FORK ADDITION ---

    it('validateProviderInstanceConfig accumulates multiple errors', () => {
      const errs = validateProviderInstanceConfig('openai', {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        model: 123 as any,
        baseUrl: '',
        contextLimit: -10,
      });
      expect(errs.length).toBeGreaterThanOrEqual(2);
      const fields = errs.map((e) => e.field);
      expect(fields).toContain('model');
      expect(fields).toContain('contextLimit');
    });
  });
});
