/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * --- LOCAL FORK ADDITION (Phase 2.0) ---
 * Adaptive compression threshold tracker for local mode.
 *
 * Observation: on small (32K) local windows the upstream compression
 * sometimes only frees 5-15% of context because the summarizer's
 * <state_snapshot> is nearly as large as the raw history it replaced. When
 * that happens repeatedly, the static `compressionThreshold` is wrong for
 * the workload — we should compress earlier next time.
 *
 * This module maintains a per-session ring buffer of recent compression
 * ratios and returns a tightened threshold when "weak" compressions are
 * observed. Guard rails:
 *   - Floor at 0.35 (never compress earlier than at 35% context usage).
 *   - Cooldown of N turns between adaptive tightenings (prevents spiral).
 *   - Auto-disabled when the user has set `local.compressionThreshold`
 *     explicitly (we trust the operator's choice).
 *
 * Pure module (state held in module scope as a per-process Map keyed by
 * sessionId). No I/O. Unit-testable in isolation by passing a custom Map.
 */

const RING_BUFFER_SIZE = 5;

/**
 * A "weak" compression: newTokenCount > originalTokenCount * WEAK_RATIO.
 * 0.85 means anything that freed less than 15% counts as weak.
 */
const WEAK_RATIO = 0.85;

/**
 * Floor for the adaptive threshold. Never tighten below this. Raised from
 * 0.30 to 0.35 to bound compounding summarization loss across many passes.
 */
export const ADAPTIVE_THRESHOLD_FLOOR = 0.35;

/**
 * Step by which the threshold is tightened per "weak" sample observed.
 * Conservative — we'd rather tighten over multiple turns than overshoot.
 */
const TIGHTENING_STEP = 0.05;

/**
 * Default cooldown (turns) between adaptive tightenings. Prevents the
 * compress-tighten-compress-tighten spiral.
 */
export const DEFAULT_ADAPTIVE_COOLDOWN_TURNS = 5;

interface CompressionSample {
  originalTokenCount: number;
  newTokenCount: number;
  turnIndex: number;
}

interface SessionState {
  ring: CompressionSample[];
  lastAdaptiveTurn: number;
}

/**
 * Per-process session state map. Exported for tests; do not mutate from
 * production code paths.
 */
export const __sessionState: Map<string, SessionState> = new Map();

function getOrInit(sessionId: string): SessionState {
  let s = __sessionState.get(sessionId);
  if (!s) {
    s = { ring: [], lastAdaptiveTurn: -Infinity };
    __sessionState.set(sessionId, s);
  }
  return s;
}

/**
 * Record the result of a compression pass. Caller invokes this after every
 * `tryCompressChat`, regardless of status (failed compressions still tell us
 * the threshold may be wrong).
 */
export function recordCompressionResult(
  sessionId: string,
  originalTokenCount: number,
  newTokenCount: number,
  turnIndex: number,
): void {
  if (!sessionId) return;
  if (!Number.isFinite(originalTokenCount) || originalTokenCount <= 0) return;
  if (!Number.isFinite(newTokenCount) || newTokenCount < 0) return;
  if (!Number.isFinite(turnIndex)) return;

  const state = getOrInit(sessionId);
  state.ring.push({ originalTokenCount, newTokenCount, turnIndex });
  if (state.ring.length > RING_BUFFER_SIZE) {
    state.ring.shift();
  }
}

/**
 * Compute the effective threshold for the next compression decision.
 *
 * @param baseThreshold The threshold the system would use absent adaptation.
 * @param opts.sessionId Per-session key (typically Config.getSessionId()).
 * @param opts.currentTurnIndex The current turn counter (typically
 *   Config.getSessionTurnCount() or equivalent monotonic counter).
 * @param opts.userOverridePresent True if the user has set a threshold
 *   explicitly. When true, returns baseThreshold unchanged (operator wins).
 * @param opts.cooldownTurns Minimum turns between tightenings. Defaults to
 *   DEFAULT_ADAPTIVE_COOLDOWN_TURNS.
 * @param opts.floor Lower bound for the returned threshold. Defaults to
 *   ADAPTIVE_THRESHOLD_FLOOR.
 * @returns The (possibly tightened) threshold value.
 */
export function getEffectiveCompressionThreshold(
  baseThreshold: number,
  opts: {
    sessionId: string;
    currentTurnIndex: number;
    userOverridePresent: boolean;
    cooldownTurns?: number;
    floor?: number;
  },
): number {
  if (!Number.isFinite(baseThreshold)) return baseThreshold;
  if (opts.userOverridePresent) return baseThreshold;
  if (!opts.sessionId) return baseThreshold;

  const state = __sessionState.get(opts.sessionId);
  if (!state || state.ring.length === 0) return baseThreshold;

  const cooldown = opts.cooldownTurns ?? DEFAULT_ADAPTIVE_COOLDOWN_TURNS;
  const floor = opts.floor ?? ADAPTIVE_THRESHOLD_FLOOR;

  // Cooldown: if we tightened recently, return base.
  if (opts.currentTurnIndex - state.lastAdaptiveTurn < cooldown) {
    return baseThreshold;
  }

  // Count weak compressions in the ring.
  const weakCount = state.ring.filter(
    (s) => s.newTokenCount > s.originalTokenCount * WEAK_RATIO,
  ).length;

  if (weakCount === 0) return baseThreshold;

  const tightened = Math.max(
    floor,
    baseThreshold - TIGHTENING_STEP * Math.min(weakCount, 3),
  );

  if (tightened < baseThreshold) {
    state.lastAdaptiveTurn = opts.currentTurnIndex;
  }
  return tightened;
}

/**
 * Reset state for a session. Call when the user starts a new chat or the
 * session ends. Exported primarily for tests.
 */
export function resetAdaptiveState(sessionId: string): void {
  __sessionState.delete(sessionId);
}
