/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { migrateLegacyLocalSettings } from './migrateLegacyLocalSettings.js';

describe('migrateLegacyLocalSettings', () => {
  it('returns migrated=false when there is no local block', () => {
    const result = migrateLegacyLocalSettings({ ui: { theme: 'dark' } });
    expect(result.migrated).toBe(false);
    expect(result.migratedKeys).toEqual([]);
    expect(result.droppedKeys).toEqual([]);
    expect(result.newSettings).toEqual({ ui: { theme: 'dark' } });
  });

  it('returns migrated=false when the local block is empty', () => {
    const result = migrateLegacyLocalSettings({ local: {} });
    expect(result.migrated).toBe(false);
    expect(result.newSettings).toEqual({ local: {} });
  });

  it('returns migrated=false when local block has only empty-string values', () => {
    const result = migrateLegacyLocalSettings({
      local: { url: '', model: '' },
    });
    expect(result.migrated).toBe(false);
  });

  it('migrates a fully populated local block into providers.local-vllm', () => {
    const result = migrateLegacyLocalSettings({
      local: {
        url: 'http://127.0.0.1:8000/v1/chat/completions',
        model: 'Qwen/Qwen3-Coder-Next-FP8',
        contextLimit: 65536,
        timeout: 600000,
        enableTools: true,
        promptMode: 'lite',
        compressionThreshold: 0.85,
        preserveFraction: 0.3,
      },
    });

    expect(result.migrated).toBe(true);
    expect(result.droppedKeys).toEqual([]);
    expect(result.newSettings['local']).toBeUndefined();
    const providers = result.newSettings['providers'] as Record<
      string,
      unknown
    >;
    expect(providers['active']).toBe('local-vllm');
    const localVllm = providers['local-vllm'] as Record<string, unknown>;
    expect(localVllm['baseUrl']).toBe(
      'http://127.0.0.1:8000/v1/chat/completions',
    );
    expect(localVllm['model']).toBe('Qwen/Qwen3-Coder-Next-FP8');
    expect(localVllm['contextLimit']).toBe(65536);
    expect(localVllm['timeout']).toBe(600000);
    expect(localVllm['enableTools']).toBe(true);
    expect(localVllm['promptMode']).toBe('lite');
    expect(localVllm['compressionThreshold']).toBe(0.85);
    expect(localVllm['preserveFraction']).toBe(0.3);
  });

  it('drops sampler keys that have no provider mapping (excluding temperature, which migrates in 2.3.1)', () => {
    const result = migrateLegacyLocalSettings({
      local: {
        url: 'http://127.0.0.1:8000/v1/chat/completions',
        temperature: 0.7,
        topP: 0.95,
        topK: 20,
        minP: 0.01,
        repetitionPenalty: 1.0,
      },
    });

    expect(result.migrated).toBe(true);
    // Phase 2.3.1: temperature is now a per-provider field, so it
    // migrates into providers.local-vllm.temperature instead of being
    // dropped. The remaining sampler knobs still drop because they
    // don't yet have a per-provider home.
    expect([...result.droppedKeys].sort()).toEqual(
      ['topP', 'topK', 'minP', 'repetitionPenalty'].sort(),
    );
    const providers = result.newSettings['providers'] as Record<
      string,
      unknown
    >;
    const localVllm = providers['local-vllm'] as Record<string, unknown>;
    expect(localVllm['baseUrl']).toBe(
      'http://127.0.0.1:8000/v1/chat/completions',
    );
    expect(localVllm['temperature']).toBe(0.7);
  });

  // Phase 2.3.1 — explicit assertion that the temperature mapping
  // appears in the migratedKeys manifest, so the startup notice the
  // user sees lists it correctly.
  it('lists temperature in the migrated-keys manifest (Phase 2.3.1)', () => {
    const result = migrateLegacyLocalSettings({
      local: {
        url: 'http://127.0.0.1:8000/v1/chat/completions',
        temperature: 0.6,
      },
    });
    expect(result.migrated).toBe(true);
    expect(result.migratedKeys).toContainEqual({
      from: 'temperature',
      to: 'temperature',
    });
    expect(result.droppedKeys).not.toContain('temperature');
  });

  it('does not overwrite an existing provider override', () => {
    const result = migrateLegacyLocalSettings({
      local: {
        url: 'http://127.0.0.1:8000/v1/chat/completions',
        model: 'legacy-model',
      },
      providers: {
        'local-vllm': {
          model: 'user-set-model',
        },
      },
    });

    expect(result.migrated).toBe(true);
    const providers = result.newSettings['providers'] as Record<
      string,
      unknown
    >;
    const localVllm = providers['local-vllm'] as Record<string, unknown>;
    // User's existing override wins.
    expect(localVllm['model']).toBe('user-set-model');
    // But baseUrl is migrated since the user hadn't set one.
    expect(localVllm['baseUrl']).toBe(
      'http://127.0.0.1:8000/v1/chat/completions',
    );
  });

  it('preserves an existing providers.active selection rather than forcing local-vllm', () => {
    const result = migrateLegacyLocalSettings({
      local: { url: 'http://127.0.0.1:8000/v1/chat/completions' },
      providers: { active: 'openai' },
    });

    expect(result.migrated).toBe(true);
    const providers = result.newSettings['providers'] as Record<
      string,
      unknown
    >;
    expect(providers['active']).toBe('openai');
    // local-vllm bucket still gets populated so the user can switch back.
    const localVllm = providers['local-vllm'] as Record<string, unknown>;
    expect(localVllm['baseUrl']).toBe(
      'http://127.0.0.1:8000/v1/chat/completions',
    );
  });

  it('renames url → baseUrl in the migrated keys manifest', () => {
    const result = migrateLegacyLocalSettings({
      local: { url: 'http://127.0.0.1:8000/v1/chat/completions' },
    });
    expect(result.migratedKeys).toEqual([{ from: 'url', to: 'baseUrl' }]);
  });

  it('is idempotent on already-migrated settings', () => {
    const input = {
      providers: {
        active: 'local-vllm',
        'local-vllm': {
          baseUrl: 'http://127.0.0.1:8000/v1/chat/completions',
          model: 'Qwen/Qwen3-Coder-Next-FP8',
        },
      },
    };
    const result = migrateLegacyLocalSettings(input);
    expect(result.migrated).toBe(false);
    expect(result.newSettings).toEqual(input);
  });
});
