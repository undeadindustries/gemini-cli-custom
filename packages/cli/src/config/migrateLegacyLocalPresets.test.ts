/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  migrateLegacyLocalPresets,
  LEGACY_PRESET_IDS,
} from './migrateLegacyLocalPresets.js';

describe('migrateLegacyLocalPresets (Phase 2.3)', () => {
  it('returns migrated=false when no providers block exists', () => {
    const result = migrateLegacyLocalPresets({ ui: { theme: 'dark' } });
    expect(result.migrated).toBe(false);
    expect(result.migratedIds).toEqual([]);
    expect(result.newSettings).toEqual({ ui: { theme: 'dark' } });
  });

  it('returns migrated=false when providers block has no relevant ids', () => {
    const result = migrateLegacyLocalPresets({
      providers: { active: 'openai', openai: { model: 'gpt-4o' } },
    });
    expect(result.migrated).toBe(false);
    expect(result.migratedIds).toEqual([]);
  });

  it('promotes providers.active=local-vllm with no overrides into providers.custom.local-vllm', () => {
    const result = migrateLegacyLocalPresets({
      providers: { active: 'local-vllm' },
    });
    expect(result.migrated).toBe(true);
    expect(result.migratedIds).toEqual(['local-vllm']);
    const providers = result.newSettings['providers'] as Record<
      string,
      unknown
    >;
    const custom = providers['custom'] as Record<string, unknown>;
    expect(custom['local-vllm']).toMatchObject({
      displayName: 'Local vLLM',
      baseUrl: 'http://127.0.0.1:8000/v1/chat/completions',
      defaultContextLimit: 65_536,
    });
    // Active id is left in place — runtime resolves it via the merged
    // effective registry which now includes the custom entry.
    expect(providers['active']).toBe('local-vllm');
  });

  it('promotes a preset that has overrides even when not active', () => {
    const result = migrateLegacyLocalPresets({
      providers: {
        active: 'openai',
        'local-llamacpp': {
          model: 'gemma-3-27b',
          contextLimit: 32_768,
        },
      },
    });
    expect(result.migrated).toBe(true);
    expect(result.migratedIds).toContain('local-llamacpp');
    const custom = (
      (result.newSettings['providers'] as Record<string, unknown>)[
        'custom'
      ] as Record<string, unknown>
    )['local-llamacpp'] as Record<string, unknown>;
    expect(custom['defaultModel']).toBe('gemma-3-27b');
    expect(custom['defaultContextLimit']).toBe(32_768);
    expect(custom['baseUrl']).toBe('http://127.0.0.1:8080/v1/chat/completions');
  });

  it('preserves user-overridden baseUrl when promoting', () => {
    const result = migrateLegacyLocalPresets({
      providers: {
        active: 'local-generic',
        'local-generic': {
          baseUrl: 'http://192.168.1.10:9000/v1/chat/completions',
        },
      },
    });
    expect(result.migrated).toBe(true);
    const custom = (
      (result.newSettings['providers'] as Record<string, unknown>)[
        'custom'
      ] as Record<string, unknown>
    )['local-generic'] as Record<string, unknown>;
    expect(custom['baseUrl']).toBe(
      'http://192.168.1.10:9000/v1/chat/completions',
    );
  });

  it('leaves runtime overrides in providers.<id>.* in place', () => {
    const result = migrateLegacyLocalPresets({
      providers: {
        active: 'local-vllm',
        'local-vllm': {
          enableTools: true,
          promptMode: 'lite',
        },
      },
    });
    expect(result.migrated).toBe(true);
    const providers = result.newSettings['providers'] as Record<
      string,
      unknown
    >;
    expect(providers['local-vllm']).toMatchObject({
      enableTools: true,
      promptMode: 'lite',
    });
  });

  it('is idempotent: re-running on already-migrated settings is a no-op', () => {
    const initial = migrateLegacyLocalPresets({
      providers: { active: 'local-vllm' },
    });
    const second = migrateLegacyLocalPresets(initial.newSettings);
    expect(second.migrated).toBe(false);
    expect(second.skippedIds).toContain('local-vllm');
  });

  it('does not overwrite an existing providers.custom.<id> entry', () => {
    const userCustom = {
      displayName: 'My custom local-vllm',
      baseUrl: 'http://10.0.0.1:8000/v1/chat/completions',
    };
    const result = migrateLegacyLocalPresets({
      providers: {
        active: 'local-vllm',
        custom: { 'local-vllm': userCustom },
      },
    });
    expect(result.migrated).toBe(false);
    expect(result.skippedIds).toEqual(['local-vllm']);
    const custom = (
      (result.newSettings['providers'] as Record<string, unknown>)[
        'custom'
      ] as Record<string, unknown>
    )['local-vllm'];
    expect(custom).toEqual(userCustom);
  });

  it('handles all three legacy preset ids in one pass', () => {
    const result = migrateLegacyLocalPresets({
      providers: {
        active: 'local-vllm',
        'local-vllm': { model: 'qwen' },
        'local-llamacpp': { model: 'llama' },
        'local-generic': { model: 'phi' },
      },
    });
    expect(result.migrated).toBe(true);
    expect([...result.migratedIds].sort()).toEqual(
      ['local-generic', 'local-llamacpp', 'local-vllm'].sort(),
    );
  });

  it('LEGACY_PRESET_IDS exposes exactly the three migrated preset ids', () => {
    expect([...LEGACY_PRESET_IDS].sort()).toEqual(
      ['local-generic', 'local-llamacpp', 'local-vllm'].sort(),
    );
  });

  it('does not corrupt unrelated keys', () => {
    const before = {
      providers: { active: 'local-vllm', openai: { model: 'gpt-4o' } },
      ui: { theme: 'dark' },
      tools: { enabled: ['shell'] },
    };
    const result = migrateLegacyLocalPresets(before);
    expect(result.migrated).toBe(true);
    expect(result.newSettings['ui']).toEqual({ theme: 'dark' });
    expect(result.newSettings['tools']).toEqual({ enabled: ['shell'] });
    expect(
      (result.newSettings['providers'] as Record<string, unknown>)['openai'],
    ).toEqual({ model: 'gpt-4o' });
  });
});
