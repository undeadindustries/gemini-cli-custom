/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * --- LOCAL FORK ADDITION (Phase 2.0) ---
 */

import { describe, it, expect } from 'vitest';
import {
  getLocalMaskingDefaults,
  DEFAULT_LOCAL_MASKING_PROTECTION_FRACTION,
  DEFAULT_LOCAL_MASKING_PRUNABLE_FRACTION,
  type LocalMaskingConfigLike,
} from './localMaskingDefaults.js';
import {
  DEFAULT_TOOL_PROTECTION_THRESHOLD,
  DEFAULT_MIN_PRUNABLE_TOKENS_THRESHOLD,
} from './toolOutputMaskingService.js';

function makeConfig(
  overrides: Partial<{
    isLocalMode: boolean;
    contextLimit: number;
    enabled: boolean;
    protection: number;
    prunable: number;
    protectLatest: boolean;
  }> = {},
): LocalMaskingConfigLike {
  const v = {
    isLocalMode: overrides.isLocalMode ?? true,
    contextLimit: overrides.contextLimit ?? 32_768,
    enabled: overrides.enabled ?? true,
    protection:
      overrides.protection ?? DEFAULT_LOCAL_MASKING_PROTECTION_FRACTION,
    prunable: overrides.prunable ?? DEFAULT_LOCAL_MASKING_PRUNABLE_FRACTION,
    protectLatest: overrides.protectLatest ?? true,
  };
  return {
    isLocalMode: () => v.isLocalMode,
    getLocalContextLimit: () => v.contextLimit,
    getLocalToolOutputMaskingEnabled: () => v.enabled,
    getLocalToolOutputMaskingProtectionFraction: () => v.protection,
    getLocalToolOutputMaskingPrunableFraction: () => v.prunable,
    getLocalToolOutputMaskingProtectLatestTurn: () => v.protectLatest,
  };
}

describe('localMaskingDefaults', () => {
  it('scales thresholds proportionally to localContextLimit', () => {
    const result = getLocalMaskingDefaults(
      makeConfig({ contextLimit: 32_768 }),
    );
    expect(result.protectionThresholdTokens).toBe(
      Math.floor(32_768 * DEFAULT_LOCAL_MASKING_PROTECTION_FRACTION),
    );
    expect(result.minPrunableThresholdTokens).toBe(
      Math.floor(32_768 * DEFAULT_LOCAL_MASKING_PRUNABLE_FRACTION),
    );
    expect(result.protectLatestTurn).toBe(true);
  });

  it('enforces minimum floors so tiny contextLimits are not collapsed', () => {
    const result = getLocalMaskingDefaults(makeConfig({ contextLimit: 1_024 }));
    expect(result.protectionThresholdTokens).toBeGreaterThanOrEqual(2_000);
    expect(result.minPrunableThresholdTokens).toBeGreaterThanOrEqual(1_000);
  });

  it('clamps protection fraction outside [0.05, 0.5]', () => {
    const high = getLocalMaskingDefaults(
      makeConfig({ contextLimit: 100_000, protection: 5 }),
    );
    expect(high.protectionThresholdTokens).toBe(50_000);

    const low = getLocalMaskingDefaults(
      makeConfig({ contextLimit: 100_000, protection: -1 }),
    );
    expect(low.protectionThresholdTokens).toBe(5_000);
  });

  it('falls back to upstream defaults when contextLimit is non-positive', () => {
    const result = getLocalMaskingDefaults(makeConfig({ contextLimit: 0 }));
    expect(result.protectionThresholdTokens).toBe(
      DEFAULT_TOOL_PROTECTION_THRESHOLD,
    );
    expect(result.minPrunableThresholdTokens).toBe(
      DEFAULT_MIN_PRUNABLE_TOKENS_THRESHOLD,
    );
  });

  it('honors protectLatestTurn pass-through', () => {
    expect(
      getLocalMaskingDefaults(makeConfig({ protectLatest: false }))
        .protectLatestTurn,
    ).toBe(false);
  });
});
