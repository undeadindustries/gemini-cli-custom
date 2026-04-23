/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * --- LOCAL FORK ADDITION (Phase 1.9) ---
 * Standalone helper for last-resort hard truncation of chat history when the
 * local LLM context window is about to overflow even after force-compression.
 *
 * This module is intentionally a pure function with no dependencies on the
 * broader Config / chat machinery so it can be unit-tested in isolation and so
 * upstream rebases never collide with it.
 */

import type { Content, Part } from '@google/genai';

/**
 * Result of a truncation pass.
 */
export interface TruncationResult {
  /** New history with oldest entries dropped. */
  newHistory: Content[];
  /** Number of Content entries that were dropped from the original history. */
  droppedCount: number;
  /** Estimated token count of the new history. */
  newTokenCount: number;
}

/**
 * Function signature for a synchronous token estimator. Compatible with
 * estimateTokenCountSync from utils/tokenCalculation.ts.
 */
export type EstimateFn = (parts: Part[]) => number;

/**
 * Number of leading Content entries to always preserve. These typically
 * encode the initial system context (environment, workspace info) and the
 * very first user instruction that defines the task. Dropping these would
 * destroy the agent's understanding of what it is supposed to do.
 */
const PRESERVE_LEADING_ENTRIES = 2;

/**
 * Returns true if a Content entry contains an unfulfilled functionCall.
 * Used to avoid splitting tool-call/response pairs across the truncation
 * boundary, which would leave the model in an invalid state.
 */
function containsFunctionCall(content: Content): boolean {
  return !!content.parts?.some((p) => 'functionCall' in p && !!p.functionCall);
}

/**
 * Returns true if a Content entry contains a functionResponse.
 */
function containsFunctionResponse(content: Content): boolean {
  return !!content.parts?.some(
    (p) => 'functionResponse' in p && !!p.functionResponse,
  );
}

/**
 * Estimate the token count of an entire history array using the provided
 * estimator. Falls back to a conservative high value on estimator failure
 * so that callers do not under-truncate.
 */
function estimateHistoryTokens(
  history: readonly Content[],
  estimateFn: EstimateFn,
): number {
  try {
    const allParts = history.flatMap((c) => c.parts ?? []);
    return estimateFn(allParts);
  } catch {
    // Conservative fallback: treat as very large so truncation continues.
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Drop oldest history entries until the estimated token count fits within
 * targetTokens. Always preserves the leading PRESERVE_LEADING_ENTRIES entries
 * (system context + first user message). Will not split a functionCall from
 * its matching functionResponse — if the next entry to drop is a model
 * functionCall whose response is in the next-next entry, both are dropped
 * together. Symmetrically, will not leave a dangling functionResponse at the
 * head of the kept window.
 *
 * Pure function: no side effects, no I/O. Safe to unit-test in isolation.
 *
 * @param history Current chat history (newest last).
 * @param targetTokens Maximum allowed estimated token count.
 * @param estimateFn Synchronous token estimator (e.g. estimateTokenCountSync).
 * @returns TruncationResult with new history, drop count, and new estimate.
 */
export function truncateHistoryToFit(
  history: readonly Content[],
  targetTokens: number,
  estimateFn: EstimateFn,
): TruncationResult {
  // Guard: nothing to do for empty / tiny histories.
  if (history.length <= PRESERVE_LEADING_ENTRIES) {
    return {
      newHistory: [...history],
      droppedCount: 0,
      newTokenCount: estimateHistoryTokens(history, estimateFn),
    };
  }

  // Guard: invalid target.
  if (!Number.isFinite(targetTokens) || targetTokens <= 0) {
    return {
      newHistory: [...history],
      droppedCount: 0,
      newTokenCount: estimateHistoryTokens(history, estimateFn),
    };
  }

  const leading = history.slice(0, PRESERVE_LEADING_ENTRIES);
  let tail = history.slice(PRESERVE_LEADING_ENTRIES);
  let droppedCount = 0;
  let currentTokens = estimateHistoryTokens([...leading, ...tail], estimateFn);

  // Drop oldest tail entries one at a time until under budget or tail is empty.
  // Respect tool-call pairing: if the entry to drop has a functionCall whose
  // matching functionResponse is the next entry, drop both atomically.
  while (currentTokens > targetTokens && tail.length > 0) {
    const head = tail[0];
    let dropCount = 1;

    // If head is a model message with a functionCall and the next entry is the
    // matching functionResponse, drop them together to keep history valid.
    if (
      head.role === 'model' &&
      containsFunctionCall(head) &&
      tail.length > 1 &&
      containsFunctionResponse(tail[1])
    ) {
      dropCount = 2;
    }

    tail = tail.slice(dropCount);
    droppedCount += dropCount;

    // After dropping, ensure the new head is not a dangling functionResponse
    // (which would have no preceding functionCall in the kept window).
    while (tail.length > 0 && containsFunctionResponse(tail[0])) {
      tail = tail.slice(1);
      droppedCount += 1;
    }

    currentTokens = estimateHistoryTokens([...leading, ...tail], estimateFn);
  }

  return {
    newHistory: [...leading, ...tail],
    droppedCount,
    newTokenCount: currentTokens,
  };
}
