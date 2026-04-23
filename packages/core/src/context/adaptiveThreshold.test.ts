/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * --- LOCAL FORK ADDITION (Phase 2.0) ---
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordCompressionResult,
  getEffectiveCompressionThreshold,
  resetAdaptiveState,
  ADAPTIVE_THRESHOLD_FLOOR,
  __sessionState,
} from './adaptiveThreshold.js';

const SESSION = 'test-session';

beforeEach(() => {
  resetAdaptiveState(SESSION);
  __sessionState.clear();
});

describe('adaptiveThreshold', () => {
  it('returns base threshold when no samples have been recorded', () => {
    const t = getEffectiveCompressionThreshold(0.5, {
      sessionId: SESSION,
      currentTurnIndex: 10,
      userOverridePresent: false,
    });
    expect(t).toBe(0.5);
  });

  it('tightens when recent compressions are weak (newTokenCount > 85% of original)', () => {
    recordCompressionResult(SESSION, 10_000, 9_500, 1);
    recordCompressionResult(SESSION, 10_000, 9_000, 2);
    const t = getEffectiveCompressionThreshold(0.5, {
      sessionId: SESSION,
      currentTurnIndex: 100,
      userOverridePresent: false,
    });
    expect(t).toBeLessThan(0.5);
    expect(t).toBeGreaterThanOrEqual(ADAPTIVE_THRESHOLD_FLOOR);
  });

  it('does NOT tighten when compressions are effective', () => {
    recordCompressionResult(SESSION, 10_000, 3_000, 1);
    recordCompressionResult(SESSION, 10_000, 2_000, 2);
    const t = getEffectiveCompressionThreshold(0.5, {
      sessionId: SESSION,
      currentTurnIndex: 100,
      userOverridePresent: false,
    });
    expect(t).toBe(0.5);
  });

  it('respects the floor — never returns below ADAPTIVE_THRESHOLD_FLOOR', () => {
    for (let i = 0; i < 10; i++) {
      recordCompressionResult(SESSION, 10_000, 9_900, i);
    }
    const t = getEffectiveCompressionThreshold(0.4, {
      sessionId: SESSION,
      currentTurnIndex: 1_000,
      userOverridePresent: false,
      floor: 0.35,
    });
    expect(t).toBe(0.35);
  });

  it('respects the cooldown — second tighten requires N turns', () => {
    recordCompressionResult(SESSION, 10_000, 9_500, 1);
    recordCompressionResult(SESSION, 10_000, 9_500, 2);
    const first = getEffectiveCompressionThreshold(0.5, {
      sessionId: SESSION,
      currentTurnIndex: 5,
      userOverridePresent: false,
      cooldownTurns: 5,
    });
    expect(first).toBeLessThan(0.5);

    // Immediately after — within cooldown — same base threshold returns.
    const second = getEffectiveCompressionThreshold(0.5, {
      sessionId: SESSION,
      currentTurnIndex: 6,
      userOverridePresent: false,
      cooldownTurns: 5,
    });
    expect(second).toBe(0.5);

    // After cooldown elapses, can tighten again.
    const third = getEffectiveCompressionThreshold(0.5, {
      sessionId: SESSION,
      currentTurnIndex: 12,
      userOverridePresent: false,
      cooldownTurns: 5,
    });
    expect(third).toBeLessThan(0.5);
  });

  it('returns base when user has overridden the threshold explicitly', () => {
    recordCompressionResult(SESSION, 10_000, 9_500, 1);
    recordCompressionResult(SESSION, 10_000, 9_500, 2);
    const t = getEffectiveCompressionThreshold(0.5, {
      sessionId: SESSION,
      currentTurnIndex: 100,
      userOverridePresent: true,
    });
    expect(t).toBe(0.5);
  });

  it('returns base when sessionId is missing', () => {
    recordCompressionResult(SESSION, 10_000, 9_500, 1);
    const t = getEffectiveCompressionThreshold(0.5, {
      sessionId: '',
      currentTurnIndex: 100,
      userOverridePresent: false,
    });
    expect(t).toBe(0.5);
  });

  it('ring buffer caps at 5 samples', () => {
    for (let i = 0; i < 20; i++) {
      recordCompressionResult(SESSION, 10_000, 9_500, i);
    }
    const state = __sessionState.get(SESSION);
    expect(state?.ring.length).toBe(5);
  });

  it('ignores invalid sample inputs', () => {
    recordCompressionResult(SESSION, 0, 100, 1);
    recordCompressionResult(SESSION, 100, -1, 1);
    recordCompressionResult(SESSION, NaN, 100, 1);
    recordCompressionResult('', 100, 100, 1);
    const state = __sessionState.get(SESSION);
    expect(state?.ring.length ?? 0).toBe(0);
  });
});
