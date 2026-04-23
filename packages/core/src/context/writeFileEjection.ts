/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * --- LOCAL FORK ADDITION (Phase 2.0) ---
 * Standalone helper that ejects stale write_file content from chat history.
 *
 * The upstream ToolOutputMaskingService scans `functionResponse` parts (i.e.
 * tool RESULTS like read_file output). The biggest source of history bloat in
 * code-generation sessions is actually the `functionCall` for write_file —
 * its `args.content` field carries the entire generated file body. Once the
 * file is written to disk, that content is dead weight in history: the file
 * itself is the source of truth and the model can re-read it on demand.
 *
 * This module replaces `args.content` of stale write_file calls with a
 * compact marker, preserving `args.file_path` so the model still knows the
 * file exists and can recover it via read_file if needed.
 *
 * Pure function: no I/O, no Config dependency, no upstream-class coupling.
 * Same idiom as historyTruncation.ts (Phase 1.9).
 */

import type { Content, Part } from '@google/genai';
import { estimateTokenCountSync } from '../utils/tokenCalculation.js';

/**
 * Number of leading Content entries to always preserve. Mirrors
 * historyTruncation.ts. These entries typically encode environment context
 * and the original task instruction.
 */
const PRESERVE_LEADING_ENTRIES = 2;

/**
 * Marker tag used to recognize already-ejected write_file content so we never
 * re-eject the same call twice.
 */
export const WRITE_FILE_EJECTION_TAG = 'file_written';

/**
 * Options accepted by ejectStaleWriteFileContent.
 */
export interface WriteFileEjectionOptions {
  /**
   * Tool name that identifies a write_file functionCall. Pass
   * WRITE_FILE_TOOL_NAME (avoids importing tool-names.ts into this pure file
   * to keep it dependency-light).
   */
  writeFileToolName: string;
  /**
   * Set of tool names that must NEVER be ejected, even if they happen to use
   * a `content` arg. Caller should pass the same EXEMPT_TOOLS set the
   * upstream ToolOutputMaskingService respects.
   */
  exemptTools: ReadonlySet<string>;
  /**
   * When true, leave the most recent conversation turn fully intact (no
   * ejection at all in that turn). Mirrors the masking service's
   * `protectLatestTurn`.
   */
  protectLatestTurn: boolean;
  /**
   * Minimum age (in turns from the end of history) before a write_file call
   * becomes eligible for ejection. 1 means "anything older than the latest
   * turn"; 2 means "two or more turns old"; etc. Range: 1 - 10.
   */
  minAgeTurns: number;
  /**
   * Minimum estimated token count for a write_file content payload before we
   * bother ejecting it. Avoids touching small writes where the savings are
   * negligible. Default for callers: 200.
   */
  minTokensPerCall: number;
}

/**
 * Result of an ejection pass.
 */
export interface WriteFileEjectionResult {
  /** New history with stale write_file content replaced by markers. */
  newHistory: Content[];
  /** Number of write_file calls that were ejected this pass. */
  ejectedCount: number;
  /** Estimated tokens reclaimed by ejection (sum across all calls). */
  tokensSaved: number;
}

/**
 * Replace `args.content` of stale write_file functionCall parts with a
 * compact <file_written> marker. Always preserves `args.file_path`.
 *
 * Safety guarantees:
 * - Never touches the leading PRESERVE_LEADING_ENTRIES entries.
 * - Never touches the latest turn when protectLatestTurn is true.
 * - Never touches calls newer than minAgeTurns from the end.
 * - Never touches tools in exemptTools.
 * - Never re-ejects already-marked calls.
 * - Never modifies functionCall.id, .name, or other args fields.
 *
 * Pure function: input arrays are not mutated; new objects are returned.
 *
 * @param history Current chat history (oldest first, newest last).
 * @param opts Ejection configuration.
 * @returns New history, ejection count, tokens saved.
 */
export function ejectStaleWriteFileContent(
  history: readonly Content[],
  opts: WriteFileEjectionOptions,
): WriteFileEjectionResult {
  if (history.length <= PRESERVE_LEADING_ENTRIES) {
    return { newHistory: [...history], ejectedCount: 0, tokensSaved: 0 };
  }

  const minAge = clampInt(opts.minAgeTurns, 1, 10);
  const minTokens = Math.max(0, opts.minTokensPerCall);

  // Highest index eligible for ejection. Indices above this are protected
  // because they're either the latest turn (protectLatestTurn) or within
  // minAgeTurns of the end.
  const lastTurnIdx = history.length - 1;
  const protectedFromIdx = opts.protectLatestTurn
    ? Math.max(0, lastTurnIdx - (minAge - 1))
    : lastTurnIdx + 1; // nothing protected from the end if not protecting latest
  // We'll eject only entries at index < protectedFromIdx, AND >= PRESERVE_LEADING_ENTRIES.

  let ejectedCount = 0;
  let tokensSaved = 0;
  const newHistory: Content[] = history.map((c, idx) => {
    if (idx < PRESERVE_LEADING_ENTRIES) return c;
    if (idx >= protectedFromIdx) return c;
    if (!c.parts || c.parts.length === 0) return c;

    let touched = false;
    const newParts: Part[] = c.parts.map((part) => {
      const fc =
        part && typeof part === 'object' && 'functionCall' in part
          ? part.functionCall
          : undefined;
      if (!fc) return part;
      const toolName = fc.name ?? '';
      if (toolName !== opts.writeFileToolName) return part;
      if (opts.exemptTools.has(toolName)) return part;

      // Args may be undefined or an object; only touch when content is a string.
      const args = isRecord(fc.args) ? fc.args : undefined;
      if (!args) return part;
      const content = args['content'];
      if (!isString(content)) return part;

      // Skip if already ejected (idempotent).
      if (content.startsWith(`<${WRITE_FILE_EJECTION_TAG}`)) return part;

      // Estimate tokens for this single content payload.
      const contentTokens = estimateTokenCountSync([{ text: content }]);
      if (contentTokens < minTokens) return part;

      const rawPath = args['file_path'];
      const filePath = isString(rawPath) ? rawPath : '<unknown>';
      const lines = content.split('\n').length;
      const marker = `<${WRITE_FILE_EJECTION_TAG} path="${escapeAttr(
        filePath,
      )}" lines=${lines} tokens=${contentTokens} cached=true>`;

      const newArgs: Record<string, unknown> = { ...args, content: marker };
      const markerTokens = estimateTokenCountSync([{ text: marker }]);
      const saved = Math.max(0, contentTokens - markerTokens);

      touched = true;
      ejectedCount += 1;
      tokensSaved += saved;

      return {
        ...part,
        functionCall: { ...fc, args: newArgs },
      };
    });

    if (!touched) return c;
    return { ...c, parts: newParts };
  });

  return { newHistory, ejectedCount, tokensSaved };
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const intVal = Math.floor(value);
  if (intVal < min) return min;
  if (intVal > max) return max;
  return intVal;
}

/** Type guard replacing inline `typeof x === 'string'` checks (ESLint no-restricted-syntax). */
function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** Type guard for plain objects (ESLint no-restricted-syntax). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;').replace(/[<>]/g, '');
}
