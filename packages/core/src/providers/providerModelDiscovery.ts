/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Hosted-provider model discovery (Phase 2.1).
 *
 * Brand-new file (Category C — no fences). Reuses the same OpenAI-format
 * `/v1/models` wire protocol as `localModelDiscovery.ts`, but adds an
 * `Authorization: Bearer <apiKey>` header so it works against hosted APIs.
 *
 * The function intentionally matches the error-swallowing contract of
 * `fetchLocalModels`: all errors are caught and an empty array is returned so
 * callers can degrade gracefully without special error handling.
 */

import { debugLogger } from '../utils/debugLogger.js';
import { extractServerRoot } from '../core/localModelDiscovery.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderModelInfo {
  /** Raw model ID as returned by the API, e.g. "gpt-4o". */
  id: string;
  /** Short human-readable label derived from the id, e.g. "gpt-4o". */
  displayName: string;
  /** `owned_by` field from the API response, if present. */
  ownedBy?: string;
  /**
   * Maximum context window reported by the server.
   * vLLM populates this from the loaded model's `max_model_len` config.
   * OpenAI's hosted API does not include this field (undefined).
   */
  contextLimit?: number;
  /**
   * Per-token pricing returned by the provider (e.g. OpenRouter).
   * Both values are USD per token as decimal strings (e.g. "0.000001").
   * Absent for providers that don't expose pricing (vLLM, OpenAI hosted).
   */
  pricing?: {
    /** Cost per prompt token in USD. "0" means free. */
    promptPerToken: number;
    /** Cost per completion token in USD. "0" means free. */
    completionPerToken: number;
  };
}

// ---------------------------------------------------------------------------
// Chat-model filter heuristic
// ---------------------------------------------------------------------------

/**
 * Patterns in a model id that indicate it is NOT a chat-completions model.
 * OpenAI's /v1/models returns images, audio, embeddings, moderation, and
 * legacy completion-only models alongside GPT / o-series chat models.
 *
 * We filter these out so the picker shows only models that make sense for
 * a chat-completions workflow. The list is intentionally conservative: when
 * in doubt we KEEP a model and let the user decide.
 */
const NON_CHAT_PATTERNS = [
  /dall-e/i,
  /whisper/i,
  /^tts/i,
  /-tts/i,
  /text-embedding/i,
  /embedding/i,
  /text-moderation/i,
  /text-search/i,
  /text-similarity/i,
  /text-davinci-edit/i,
  /code-search/i,
  /code-cushman/i,
  /babbage-002/i,
  /davinci-002/i,
];

/**
 * Returns true when a model id looks like a chat-completions model.
 * Logic: accept by default, reject only on a known non-chat pattern.
 */
function isChatModel(id: string): boolean {
  return !NON_CHAT_PATTERNS.some((p) => p.test(id));
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Queries `GET {baseUrl}/v1/models` on an OpenAI-compatible provider.
 *
 * - When `apiKey` is non-empty, attaches it as a Bearer token. Local
 *   presets (vLLM, llama.cpp, generic) pass an empty string and the
 *   Authorization header is omitted entirely so localhost endpoints
 *   that 401 on stray auth headers keep working.
 * - Returns only models that appear to support chat completions.
 * - Results are sorted alphabetically by id.
 * - All errors are caught; the caller always gets an array (possibly empty).
 *
 * @param baseUrl  The provider's base URL (same value stored in the registry
 *                 or user override), e.g. "https://api.openai.com/v1/chat/completions".
 *                 Trailing `/chat/completions` (and `/v1`) are stripped
 *                 automatically so the correct models endpoint is derived.
 * @param apiKey   Bearer token. Pass an empty string for local presets.
 * @param timeoutMs  Request timeout in milliseconds (default 10 s).
 * @param maxPricePerMToken  When set, only models whose prompt price
 *                 (USD per million tokens) is ≤ this value are returned.
 *                 Pass `0` to return only free models. Models with no
 *                 pricing data are always included (non-OpenRouter endpoints
 *                 never return pricing fields).
 */
export async function fetchProviderModels(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 10_000,
  maxPricePerMToken?: number,
): Promise<ProviderModelInfo[]> {
  const url = extractServerRoot(baseUrl) + '/v1/models';

  try {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '<unreadable>');
      debugLogger.log(
        `[ProviderModelDiscovery] ${url} returned HTTP ${response.status}: ${body.slice(0, 200)}`,
      );
      return [];
    }

    const json: unknown = await response.json();

    if (!isRecord(json) || !Array.isArray(json['data'])) {
      debugLogger.log(
        '[ProviderModelDiscovery] /v1/models response missing expected "data" array',
      );
      return [];
    }

    const data: unknown[] = json['data'];
    const models: ProviderModelInfo[] = [];
    for (const entry of data) {
      if (!isRecord(entry)) continue;
      const rawId = entry['id'];
      if (typeof rawId !== 'string') continue;
      const id = rawId;
      if (!isChatModel(id)) continue;
      const rawOwnedBy = entry['owned_by'];
      const ownedBy = typeof rawOwnedBy === 'string' ? rawOwnedBy : undefined;
      // vLLM includes `max_model_len` in each model object; hosted OpenAI
      // does not. Capture it when present so callers can use it to stamp
      // a sensible contextLimit on newly-created custom providers.
      const rawLen = entry['max_model_len'];
      const contextLimit =
        typeof rawLen === 'number' && rawLen > 0 ? rawLen : undefined;

      // --- LOCAL FORK ADDITION (Phase 2.4.1: OpenRouter pricing) ---
      // OpenRouter returns pricing as a nested object with string-decimal
      // values (USD per token). Other providers omit this field entirely.
      let pricing: ProviderModelInfo['pricing'];
      const rawPricing = entry['pricing'];
      if (isRecord(rawPricing)) {
        const prompt = parseFloat(String(rawPricing['prompt'] ?? ''));
        const completion = parseFloat(String(rawPricing['completion'] ?? ''));
        if (!isNaN(prompt) && !isNaN(completion)) {
          pricing = { promptPerToken: prompt, completionPerToken: completion };
        }
      }

      // Apply max-price filter when requested. Models with no pricing data
      // (vLLM, OpenAI hosted, etc.) are always kept so the filter only affects
      // providers that actually return pricing (e.g. OpenRouter).
      if (maxPricePerMToken !== undefined && pricing !== undefined) {
        const promptPerMToken = pricing.promptPerToken * 1_000_000;
        if (promptPerMToken > maxPricePerMToken) continue;
      }
      // --- END LOCAL FORK ADDITION ---

      models.push({ id, displayName: id, ownedBy, contextLimit, pricing });
    }

    models.sort((a, b) => a.id.localeCompare(b.id));

    debugLogger.log(
      `[ProviderModelDiscovery] Discovered ${models.length} chat model(s) from ${url}`,
    );
    return models;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('AbortError') || msg.includes('timeout')) {
      debugLogger.log(
        `[ProviderModelDiscovery] ${url} timed out after ${timeoutMs}ms`,
      );
    } else if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      debugLogger.log(`[ProviderModelDiscovery] Cannot reach ${url}: ${msg}`);
    } else {
      debugLogger.log(
        `[ProviderModelDiscovery] Failed to fetch models: ${msg}`,
      );
    }
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
