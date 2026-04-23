/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure data-fetching module for discovering models available on a local
 * OpenAI-compatible server.  No side effects, no config dependency.
 */

import { debugLogger } from '../utils/debugLogger.js';

// ---------------------------------------------------------------------------
// Constants & types
// ---------------------------------------------------------------------------

export const LOCAL_MODEL_PREFIX = 'local:';

export interface LocalModelInfo {
  /** Raw model ID from the server, e.g. "Qwen/Qwen3.5-27B". */
  id: string;
  /** Prefixed ID used in the CLI's model registry, e.g. "local:Qwen/Qwen3.5-27B". */
  localId: string;
  /** Human-friendly label for the picker UI, e.g. "Qwen3.5-27B". */
  displayName: string;
  /** Maximum context length reported by the server (vLLM's `max_model_len`). */
  maxModelLen?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isLocalModelId(modelId: string): boolean {
  return modelId.startsWith(LOCAL_MODEL_PREFIX);
}

export function stripLocalPrefix(localId: string): string {
  return localId.startsWith(LOCAL_MODEL_PREFIX)
    ? localId.slice(LOCAL_MODEL_PREFIX.length)
    : localId;
}

/**
 * Derives a short display name from a raw model ID.
 *
 * "Qwen/Qwen3.5-27B"  → "Qwen3.5-27B"
 * "mistral-7b-instruct" → "mistral-7b-instruct"
 */
function deriveDisplayName(rawId: string): string {
  const lastSlash = rawId.lastIndexOf('/');
  return lastSlash === -1 ? rawId : rawId.slice(lastSlash + 1);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

// --- LOCAL FORK ADDITION (Phase 2.0.13) ---
/**
 * Normalises a local LLM URL into a server root so that `/v1/models` can be
 * appended correctly.
 *
 * Users commonly paste the full chat-completions URL from their settings into
 * this function (e.g. "http://127.0.0.1:8000/v1/chat/completions").
 * Naively appending "/v1/models" to that produces the broken path
 * "/v1/chat/completions/v1/models".  We strip any trailing OpenAI API path
 * suffixes so the result is always the bare server root.
 */
function extractServerRoot(rawUrl: string): string {
  // Strip known OpenAI API path suffixes, then any trailing slashes.
  return rawUrl
    .replace(/\/v1\/chat\/completions\/?$/, '')
    .replace(/\/v1\/completions\/?$/, '')
    .replace(/\/v1\/?$/, '')
    .replace(/\/+$/, '');
}
// --- END LOCAL FORK ADDITION ---

/**
 * Queries `GET {baseUrl}/v1/models` (standard OpenAI format) and returns the
 * available models.  All errors are caught — the caller always gets an array
 * (possibly empty).
 */
export async function fetchLocalModels(
  baseUrl: string,
  timeoutMs = 5000,
): Promise<LocalModelInfo[]> {
  // --- LOCAL FORK ADDITION (Phase 2.0.13) ---
  const url = extractServerRoot(baseUrl) + '/v1/models';
  // --- END LOCAL FORK ADDITION ---

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '<unreadable>');
      debugLogger.log(
        `[LocalModelDiscovery] /v1/models returned HTTP ${response.status}: ${body.slice(0, 200)}`,
      );
      return [];
    }

    const json: unknown = await response.json();

    if (!isRecord(json) || !Array.isArray(json['data'])) {
      debugLogger.log(
        '[LocalModelDiscovery] /v1/models response missing expected "data" array',
      );
      return [];
    }

    const data: unknown[] = json['data'];

    const models: LocalModelInfo[] = [];
    for (const entry of data) {
      if (!isRecord(entry) || !isString(entry['id'])) continue;
      const rawId = entry['id'];
      const rawLen = entry['max_model_len'];
      const maxModelLen =
        typeof rawLen === 'number' && rawLen > 0 ? rawLen : undefined;
      models.push({
        id: rawId,
        localId: LOCAL_MODEL_PREFIX + rawId,
        displayName: deriveDisplayName(rawId),
        maxModelLen,
      });
    }

    debugLogger.log(
      `[LocalModelDiscovery] Discovered ${models.length} model(s): ${models.map((m) => m.id).join(', ')}`,
    );
    return models;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);

    if (msg.includes('AbortError') || msg.includes('timeout')) {
      debugLogger.log(
        `[LocalModelDiscovery] /v1/models timed out after ${timeoutMs}ms`,
      );
    } else if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      debugLogger.log(`[LocalModelDiscovery] Cannot reach ${url}: ${msg}`);
    } else {
      debugLogger.log(`[LocalModelDiscovery] Failed to fetch models: ${msg}`);
    }
    return [];
  }
}

// ---------------------------------------------------------------------------
// UI option merging
// ---------------------------------------------------------------------------

/** Type guard for plain record objects. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Type guard for string values. */
function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Maps discovered local models into the same option shape that
 * `getAvailableModelOptions()` returns, so the picker UI can render them
 * without touching `modelConfigService.ts`.
 */
export function mergeLocalModelsIntoOptions(
  localModels: LocalModelInfo[],
): Array<{
  modelId: string;
  name: string;
  description: string;
  tier: 'local';
}> {
  return localModels.map((m) => ({
    modelId: m.localId,
    name: `${m.displayName} (local)`,
    description: `Local model: ${m.id}`,
    tier: 'local' as const,
  }));
}
