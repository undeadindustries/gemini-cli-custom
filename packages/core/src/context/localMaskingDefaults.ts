/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * --- LOCAL FORK ADDITION (Phase 2.0) ---
 * Standalone helper that computes ToolOutputMaskingService thresholds scaled
 * to the local LLM context window. The upstream defaults
 * (protectionThresholdTokens=50000, minPrunableThresholdTokens=30000) require
 * ~80K of accumulated tool output before masking fires, which is more than
 * twice the entire context window of a typical 32K local model. This module
 * lets the masking service actually engage on small windows.
 *
 * Pure function: no I/O, no side effects. Safe to unit-test in isolation.
 * Lives outside config.ts so upstream rebases of getToolOutputMaskingConfig()
 * never collide with this fork-only logic.
 */

import {
  DEFAULT_PROTECT_LATEST_TURN,
  DEFAULT_TOOL_PROTECTION_THRESHOLD,
  DEFAULT_MIN_PRUNABLE_TOKENS_THRESHOLD,
} from './toolOutputMaskingService.js';
import type { ToolOutputMaskingConfig } from './types.js';

/**
 * Default fraction of localContextLimit reserved as the "protection window" —
 * the most recent N tool tokens never masked. 0.15 of 32K = 4800 tokens of
 * recent tool output kept fully readable.
 */
export const DEFAULT_LOCAL_MASKING_PROTECTION_FRACTION = 0.15;

/**
 * Default fraction of localContextLimit accumulated as the "prunable buffer"
 * before masking actually triggers. 0.10 of 32K = 3200 prunable tokens. Total
 * threshold to fire masking ≈ (protection + prunable) ≈ 25% of context.
 */
export const DEFAULT_LOCAL_MASKING_PRUNABLE_FRACTION = 0.1;

/**
 * Absolute floors so a tiny / misconfigured contextLimit cannot collapse the
 * thresholds to zero (which would mask every tool output, including critical
 * recent ones).
 */
const MIN_PROTECTION_TOKENS = 2_000;
const MIN_PRUNABLE_TOKENS = 1_000;

/**
 * Subset of Config the helper needs. Defined as a structural type so it can be
 * unit-tested without instantiating a full Config.
 */
export interface LocalMaskingConfigLike {
  isLocalMode(): boolean;
  getLocalContextLimit(): number;
  getLocalToolOutputMaskingEnabled(): boolean;
  getLocalToolOutputMaskingProtectionFraction(): number;
  getLocalToolOutputMaskingPrunableFraction(): number;
  getLocalToolOutputMaskingProtectLatestTurn(): boolean;
}

/**
 * Compute ToolOutputMaskingConfig values appropriate for the local context
 * window. Caller (Config.getToolOutputMaskingConfig) should invoke this only
 * when isLocalMode() is true AND getLocalToolOutputMaskingEnabled() is true.
 *
 * @param config Config-like object exposing the local-mode getters.
 * @returns A ToolOutputMaskingConfig with thresholds scaled to context size.
 */
export function getLocalMaskingDefaults(
  config: LocalMaskingConfigLike,
): ToolOutputMaskingConfig {
  const limit = config.getLocalContextLimit();

  if (!Number.isFinite(limit) || limit <= 0) {
    // Fall back to upstream defaults if context limit is unusable.
    return {
      protectionThresholdTokens: DEFAULT_TOOL_PROTECTION_THRESHOLD,
      minPrunableThresholdTokens: DEFAULT_MIN_PRUNABLE_TOKENS_THRESHOLD,
      protectLatestTurn: DEFAULT_PROTECT_LATEST_TURN,
    };
  }

  const protectionFraction = clampFraction(
    config.getLocalToolOutputMaskingProtectionFraction(),
    0.05,
    0.5,
  );
  const prunableFraction = clampFraction(
    config.getLocalToolOutputMaskingPrunableFraction(),
    0.05,
    0.5,
  );

  const protectionThresholdTokens = Math.max(
    MIN_PROTECTION_TOKENS,
    Math.floor(limit * protectionFraction),
  );
  const minPrunableThresholdTokens = Math.max(
    MIN_PRUNABLE_TOKENS,
    Math.floor(limit * prunableFraction),
  );

  return {
    protectionThresholdTokens,
    minPrunableThresholdTokens,
    protectLatestTurn: config.getLocalToolOutputMaskingProtectLatestTurn(),
  };
}

function clampFraction(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
