/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * --- LOCAL FORK ADDITION (Phase 2.0) ---
 */

import { describe, it, expect } from 'vitest';
import { assessTurnBudget } from './preTurnBudget.js';

describe('assessTurnBudget', () => {
  it('returns shouldCompressFirst=false when projection is well below trigger', () => {
    const r = assessTurnBudget({
      currentHistoryTokens: 5_000,
      estimatedRequestTokens: 500,
      contextLimit: 32_768,
      reservedResponseTokens: 4_096,
      proactiveCompressAt: 0.8,
    });
    expect(r.shouldCompressFirst).toBe(false);
    expect(r.projectedFraction).toBeGreaterThan(0);
    expect(r.projectedTokens).toBe(9_596);
  });

  it('returns shouldCompressFirst=true once projection meets the trigger', () => {
    // 32768 * 0.8 = 26214.4 → need projected >= 26215
    const r = assessTurnBudget({
      currentHistoryTokens: 22_300,
      estimatedRequestTokens: 100,
      contextLimit: 32_768,
      reservedResponseTokens: 4_096,
      proactiveCompressAt: 0.8,
    });
    expect(r.projectedTokens).toBe(26_496);
    expect(r.shouldCompressFirst).toBe(true);
  });

  it('returns false when contextLimit is non-positive', () => {
    const r = assessTurnBudget({
      currentHistoryTokens: 100_000,
      estimatedRequestTokens: 100_000,
      contextLimit: 0,
      reservedResponseTokens: 4_096,
      proactiveCompressAt: 0.8,
    });
    expect(r.shouldCompressFirst).toBe(false);
    expect(r.projectedFraction).toBe(0);
    expect(r.projectedTokens).toBe(0);
  });

  it('clamps proactiveCompressAt above 1 to 1 (effectively disabled)', () => {
    const r = assessTurnBudget({
      currentHistoryTokens: 100_000,
      estimatedRequestTokens: 100_000,
      contextLimit: 32_768,
      reservedResponseTokens: 4_096,
      proactiveCompressAt: 5,
    });
    // Even at 619% projection, clamped trigger 1.0 means projection must be >= 1.0.
    // 200K + 4K reserved >> 32K, so still triggers.
    expect(r.shouldCompressFirst).toBe(true);
  });

  it('treats negative inputs as zero', () => {
    const r = assessTurnBudget({
      currentHistoryTokens: -50,
      estimatedRequestTokens: -10,
      contextLimit: 32_768,
      reservedResponseTokens: -5,
      proactiveCompressAt: 0.8,
    });
    expect(r.projectedTokens).toBe(0);
    expect(r.shouldCompressFirst).toBe(false);
  });

  it('clamps proactiveCompressAt below 0 to 0 (always triggers)', () => {
    const r = assessTurnBudget({
      currentHistoryTokens: 0,
      estimatedRequestTokens: 0,
      contextLimit: 32_768,
      reservedResponseTokens: 0,
      proactiveCompressAt: -1,
    });
    // 0 >= 0, always triggers
    expect(r.shouldCompressFirst).toBe(true);
  });
});
