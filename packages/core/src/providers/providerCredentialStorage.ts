/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Hosted-provider credential storage (Phase 2.1).
//
// Brand-new file — Category C (no fences needed). Mirrors the structure of
// apiKeyCredentialStorage.ts but parameterizes the keychain entry name by
// provider id, so OpenAI's key never collides with DeepSeek's, OpenRouter's,
// etc.
//
// Resolution order at request time (also implemented here as
// `resolveProviderApiKey`):
//   1. The provider's env var (e.g. OPENAI_API_KEY) — env always wins.
//   2. The OS keychain entry `gemini-cli-provider-<id>`.
//   3. null (caller surfaces "run /provider set <id> key").
//
// HybridTokenStorage transparently falls back to encrypted file storage on
// systems without a keychain (set GEMINI_FORCE_FILE_STORAGE=true to force).

import { HybridTokenStorage } from '../mcp/token-storage/hybrid-token-storage.js';
import type { OAuthCredentials } from '../mcp/token-storage/types.js';
import { debugLogger } from '../utils/debugLogger.js';
import { createCache } from '../utils/cache.js';
import { getProvider } from './providerRegistry.js';

/**
 * Service-name prefix in the OS keychain. One entry per provider id, e.g.
 * `gemini-cli-provider-openai`. Distinct prefix from the legacy
 * `gemini-cli-api-key` storage so the two never collide.
 */
const KEYCHAIN_SERVICE_PREFIX = 'gemini-cli-provider-';

/**
 * Per-provider lazy-initialized HybridTokenStorage instance, cached so we
 * don't spawn a new keychain client on every request.
 */
const storageByProvider = new Map<string, HybridTokenStorage>();

function getStorage(providerId: string): HybridTokenStorage {
  let storage = storageByProvider.get(providerId);
  if (!storage) {
    storage = new HybridTokenStorage(`${KEYCHAIN_SERVICE_PREFIX}${providerId}`);
    storageByProvider.set(providerId, storage);
  }
  return storage;
}

/**
 * Per-provider read-through cache so we don't hit the keychain on every
 * single chat turn. Same TTL as apiKeyCredentialStorage.ts.
 */
const apiKeyCache = createCache<string, Promise<string | null>>({
  storage: 'map',
  defaultTtl: 30_000,
});

/**
 * Resets the cache. Used exclusively for test isolation (so a test that
 * mutates the keychain fake can read the new value back without waiting
 * 30 seconds).
 * @internal
 */
export function resetProviderApiKeyCacheForTesting(): void {
  apiKeyCache.clear();
  storageByProvider.clear();
}

/**
 * Returns the API key stored in the OS keychain for `providerId`, or
 * null if none is set or the keychain read failed. Never throws — a
 * missing key is a normal state (the user hasn't run
 * `/provider set <id> key` yet) and the caller should surface that.
 */
export async function loadProviderApiKey(
  providerId: string,
): Promise<string | null> {
  if (!providerId) return null;
  return apiKeyCache.getOrCreate(providerId, async () => {
    try {
      const storage = getStorage(providerId);
      const credentials = await storage.getCredentials(providerId);
      if (credentials?.token?.accessToken) {
        return credentials.token.accessToken;
      }
      return null;
    } catch (error: unknown) {
      // Mirror apiKeyCredentialStorage.ts: log and return null. Missing
      // libsecret on Linux, locked keychain on macOS, etc. all hit here.
      debugLogger.error(
        `Failed to load API key for provider '${providerId}' from storage:`,
        error,
      );
      return null;
    }
  });
}

/**
 * Persists `apiKey` to the keychain entry for `providerId`. Pass null or
 * an empty string to clear the entry (delegates to
 * {@link clearProviderApiKey}).
 *
 * Throws on keychain failure with an actionable message. Per the plan's
 * error-handling boundary: save MUST surface failure (otherwise the user
 * thinks the key is saved but every subsequent request hits a 401).
 */
export async function saveProviderApiKey(
  providerId: string,
  apiKey: string | null | undefined,
): Promise<void> {
  if (!providerId) {
    throw new Error('saveProviderApiKey: providerId is required.');
  }
  apiKeyCache.delete(providerId);
  if (!apiKey || apiKey.trim() === '') {
    await clearProviderApiKey(providerId);
    return;
  }
  const credentials: OAuthCredentials = {
    serverName: providerId,
    token: {
      accessToken: apiKey,
      tokenType: 'ApiKey',
    },
    updatedAt: Date.now(),
  };
  try {
    await getStorage(providerId).setCredentials(credentials);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not save API key to keychain for provider '${providerId}': ` +
        `${reason}. ` +
        `On Linux, ensure libsecret is installed; ` +
        `or set GEMINI_FORCE_FILE_STORAGE=true to use encrypted file storage.`,
    );
  }
}

/**
 * Removes the keychain entry for `providerId`. Warn-only on failure since
 * the entry might not exist (e.g. user ran `/provider remove openai`
 * without ever having saved a key).
 */
export async function clearProviderApiKey(providerId: string): Promise<void> {
  if (!providerId) return;
  apiKeyCache.delete(providerId);
  try {
    await getStorage(providerId).deleteCredentials(providerId);
  } catch (error: unknown) {
    debugLogger.warn(
      `Failed to delete API key for provider '${providerId}' from storage:`,
      error,
    );
  }
}

/**
 * Reads the API key for `providerId` using the documented resolution
 * order: env var (always wins) -> keychain -> null.
 *
 * Env-var values are trimmed; whitespace-only values are treated as
 * missing rather than passed through (a literal " " key produces a
 * confusing 401 from the provider). Env keys shorter than 8 chars trip a
 * debug warning but are still passed through (some providers — local
 * dev gateways, internal proxies — legitimately use short tokens).
 */
export async function resolveProviderApiKey(
  providerId: string,
): Promise<string | null> {
  const def = getProvider(providerId);
  if (def) {
    const raw = process.env[def.apiKeyEnvVar];
    if (raw !== undefined) {
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        debugLogger.debug?.(
          `[Provider 2.1] Env var ${def.apiKeyEnvVar} is set but empty; ` +
            `falling back to keychain for provider '${providerId}'.`,
        );
      } else {
        if (trimmed.length < 8) {
          debugLogger.warn?.(
            `[Provider 2.1] Env var ${def.apiKeyEnvVar} value looks short ` +
              `(${trimmed.length} chars). Passing through anyway.`,
          );
        }
        return trimmed;
      }
    }
  }
  return loadProviderApiKey(providerId);
}
