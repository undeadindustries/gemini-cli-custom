/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * --- LOCAL FORK ADDITION (Phase 1.9) ---
 * Layered context-overflow recovery for local LLMs.
 *
 * When the CLI predicts a context window overflow and we are in local mode,
 * this module attempts a multi-layer recovery BEFORE the existing upstream
 * hard-stop fires. All risky operations (compression LLM calls, history
 * mutation) are wrapped in try/catch so a failure at one layer falls through
 * to the next, and the upstream hard-stop remains the safety net.
 *
 * Layers:
 *   1. Force compression (force=true tryCompressChat).
 *   2. Hard truncation of oldest history pairs (truncateHistoryToFit).
 *   3. Return 'failed' so the caller can yield the upstream overflow event.
 *
 * Lives in its own file so upstream rebases never collide with it.
 */

import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import type { GeminiChat } from '../core/geminiChat.js';
import { type ChatCompressionInfo, CompressionStatus } from '../core/turn.js';
import { debugLogger } from '../utils/debugLogger.js';
import { estimateTokenCountSync } from '../utils/tokenCalculation.js';
import { truncateHistoryToFit } from './historyTruncation.js';

/**
 * Safety margin (in tokens) reserved below the local context limit so we do
 * not push the server right up to its hard cap.
 */
const SAFETY_MARGIN_TOKENS = 1024;

/**
 * Function signature for the bound tryCompressChat method on GeminiClient.
 * Passed in via dependency injection so this module does not need to import
 * GeminiClient (avoiding a circular dep).
 */
export type TryCompressChatFn = (
  promptId: string,
  force: boolean,
  signal: AbortSignal,
) => Promise<ChatCompressionInfo>;

/**
 * Inputs to the recovery orchestrator.
 */
export interface RecoveryDeps {
  config: Config;
  chat: GeminiChat;
  promptId: string;
  signal: AbortSignal;
  tryCompressChat: TryCompressChatFn;
  estimatedRequestTokenCount: number;
  effectiveTokenLimit: number;
}

/**
 * Outcome of a recovery attempt. The caller uses `status` to decide whether
 * to yield a ChatCompressed event and proceed, or to fall through to the
 * existing upstream overflow hard-stop.
 */
export interface RecoveryResult {
  status: 'compressed' | 'truncated' | 'failed';
  /** Compression / truncation info to forward to the UI via ChatCompressed. */
  info?: ChatCompressionInfo;
  /** Updated remaining token count after recovery. */
  remainingTokenCount: number;
}

/**
 * Compute remaining tokens given the chat's reported lastPromptTokenCount and
 * the configured effective limit. Applies SAFETY_MARGIN to leave headroom.
 */
function computeRemaining(
  effectiveTokenLimit: number,
  lastPromptTokenCount: number,
): number {
  return effectiveTokenLimit - SAFETY_MARGIN_TOKENS - lastPromptTokenCount;
}

/**
 * Attempt to recover from a predicted context window overflow in local mode.
 *
 * Returns a RecoveryResult with status:
 *   - 'compressed': force-compression succeeded and freed enough room.
 *   - 'truncated':  hard truncation succeeded and freed enough room.
 *   - 'failed':     all recovery layers failed; caller should hard-stop.
 *
 * Side effects:
 *   - On 'compressed', the chat history was already mutated by tryCompressChat.
 *   - On 'truncated', this function calls chat.setHistory() to apply the new
 *     truncated history.
 *
 * Never throws — all errors are caught and logged via debugLogger.
 */
export async function attemptLocalContextRecovery(
  deps: RecoveryDeps,
): Promise<RecoveryResult> {
  const {
    config,
    chat,
    promptId,
    signal,
    tryCompressChat,
    estimatedRequestTokenCount,
    effectiveTokenLimit,
  } = deps;

  // --- Layer 2: Force-compress ---
  try {
    debugLogger.debug(
      '[LocalRecovery] Layer 2: attempting force-compress ' +
        `(estimated=${estimatedRequestTokenCount}, ` +
        `limit=${effectiveTokenLimit})`,
    );
    const forced = await tryCompressChat(promptId, true, signal);

    if (forced.compressionStatus === CompressionStatus.COMPRESSED) {
      const remaining = computeRemaining(
        effectiveTokenLimit,
        chat.getLastPromptTokenCount(),
      );
      if (estimatedRequestTokenCount <= remaining) {
        debugLogger.debug(
          `[LocalRecovery] Layer 2 succeeded: ` +
            `${forced.originalTokenCount} -> ${forced.newTokenCount} tokens`,
        );
        return {
          status: 'compressed',
          info: forced,
          remainingTokenCount: remaining,
        };
      }
      debugLogger.debug(
        '[LocalRecovery] Layer 2 compressed but still overflowing, ' +
          'falling through to layer 3',
      );
    } else {
      debugLogger.debug(
        `[LocalRecovery] Layer 2 returned status=${forced.compressionStatus}, ` +
          'falling through to layer 3',
      );
    }
  } catch (err) {
    debugLogger.debug(
      '[LocalRecovery] Layer 2 force-compress threw, falling through:',
      err,
    );
    // Intentionally fall through to layer 3.
  }

  // --- Layer 3: Hard-truncate oldest history ---
  if (!config.getLocalAutoTruncateOnOverflow()) {
    debugLogger.debug(
      '[LocalRecovery] Layer 3 disabled by local.autoTruncateOnOverflow=false',
    );
    return {
      status: 'failed',
      remainingTokenCount: computeRemaining(
        effectiveTokenLimit,
        chat.getLastPromptTokenCount(),
      ),
    };
  }

  try {
    const target =
      effectiveTokenLimit -
      SAFETY_MARGIN_TOKENS -
      Math.max(0, estimatedRequestTokenCount);

    debugLogger.debug(
      `[LocalRecovery] Layer 3: hard-truncating to fit ${target} tokens`,
    );

    const currentHistory: readonly Content[] = chat.getHistory(true);
    const result = truncateHistoryToFit(
      currentHistory,
      target,
      estimateTokenCountSync,
    );

    if (result.droppedCount > 0) {
      chat.setHistory(result.newHistory);
      const remaining =
        effectiveTokenLimit - SAFETY_MARGIN_TOKENS - result.newTokenCount;
      debugLogger.debug(
        `[LocalRecovery] Layer 3 succeeded: dropped ${result.droppedCount} ` +
          `entries, new estimate ${result.newTokenCount} tokens`,
      );
      return {
        status: 'truncated',
        info: {
          originalTokenCount: chat.getLastPromptTokenCount(),
          newTokenCount: result.newTokenCount,
          compressionStatus: CompressionStatus.HISTORY_TRUNCATED,
        },
        remainingTokenCount: remaining,
      };
    }
    debugLogger.debug(
      '[LocalRecovery] Layer 3 dropped zero entries (history already minimal)',
    );
  } catch (err) {
    debugLogger.debug('[LocalRecovery] Layer 3 truncation threw:', err);
    // Fall through to failed.
  }

  return {
    status: 'failed',
    remainingTokenCount: computeRemaining(
      effectiveTokenLimit,
      chat.getLastPromptTokenCount(),
    ),
  };
}
