/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * --- LOCAL FORK ADDITION (Phase 2.0) ---
 * Pure helper for proactive context-budget assessment BEFORE a turn is sent
 * to a local LLM. The existing recovery path (Phase 1.9) only fires AFTER
 * the request token estimate exceeds remaining context — it's reactive.
 *
 * This module asks the inverse question up-front: "If I send the current
 * history + this new request and the model produces a typical-sized response,
 * will the total fit?" If the projected usage exceeds a configurable fraction
 * of the context window, the caller can force-compress proactively, avoiding
 * the compress-then-immediately-overflow loop.
 *
 * Pure function: no I/O, no Config dependency. Unit-testable in isolation.
 */

/**
 * Inputs for a single pre-turn budget assessment.
 */
export interface PreTurnBudgetInput {
  /**
   * Estimated token count of the existing chat history (sum of all parts).
   * Typically `chat.getLastPromptTokenCount()` or a sync re-estimate.
   */
  currentHistoryTokens: number;
  /**
   * Estimated token count of the request being sent THIS turn (user message
   * plus any in-flight function responses). Should be a synchronous estimate
   * to keep the pre-turn check cheap.
   */
  estimatedRequestTokens: number;
  /**
   * Total available context window for the local model, in tokens. Typically
   * `config.getLocalContextLimit()`.
   */
  contextLimit: number;
  /**
   * Reserved budget for the model's response. The check assumes the model
   * will produce up to this many tokens in reply, so the projection includes
   * it as overhead.
   */
  reservedResponseTokens: number;
  /**
   * Fraction of contextLimit at or above which a proactive compression is
   * triggered. e.g. 0.80 means "compress if projected usage >= 80%".
   * Range: 0.0 - 1.0; values outside that range are clamped.
   */
  proactiveCompressAt: number;
}

/**
 * Result of the assessment.
 */
export interface PreTurnBudgetAssessment {
  /**
   * True if the caller should force-compress before sending this turn.
   * False means the budget is fine; proceed normally.
   */
  shouldCompressFirst: boolean;
  /**
   * Projected fraction of the context window that would be used after sending
   * this turn (history + request + reserved response). Useful for telemetry
   * and debug logging. Always >= 0.
   */
  projectedFraction: number;
  /**
   * Absolute projected token count (history + request + reserved response).
   * Useful for error messages and telemetry.
   */
  projectedTokens: number;
}

/**
 * Compute whether to pre-emptively compress before this turn.
 *
 * Edge cases handled:
 * - Non-finite or non-positive contextLimit → returns shouldCompressFirst=false
 *   (we can't make a meaningful decision; let downstream reactive recovery
 *    handle overflow if it actually happens).
 * - Negative inputs are clamped to 0.
 * - proactiveCompressAt outside [0, 1] is clamped.
 *
 * @param input Budget inputs (see field docs).
 * @returns Assessment with decision flag, projected fraction, projected tokens.
 */
export function assessTurnBudget(
  input: PreTurnBudgetInput,
): PreTurnBudgetAssessment {
  const {
    currentHistoryTokens,
    estimatedRequestTokens,
    contextLimit,
    reservedResponseTokens,
    proactiveCompressAt,
  } = input;

  if (!Number.isFinite(contextLimit) || contextLimit <= 0) {
    return {
      shouldCompressFirst: false,
      projectedFraction: 0,
      projectedTokens: 0,
    };
  }

  const safeHistory = Math.max(0, currentHistoryTokens || 0);
  const safeRequest = Math.max(0, estimatedRequestTokens || 0);
  const safeReserved = Math.max(0, reservedResponseTokens || 0);
  const projectedTokens = safeHistory + safeRequest + safeReserved;
  const projectedFraction = projectedTokens / contextLimit;

  const clampedTrigger = clampUnit(proactiveCompressAt);

  return {
    shouldCompressFirst: projectedFraction >= clampedTrigger,
    projectedFraction,
    projectedTokens,
  };
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0.8;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
