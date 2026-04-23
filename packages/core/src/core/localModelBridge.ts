/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Orchestration module for local model discovery and cross-boundary model
 * switching.  Designed as standalone functions that accept a Config instance
 * so that config.ts itself requires only minimal additive edits.
 */

import { AuthType } from './contentGenerator.js';
import {
  fetchLocalModels,
  isLocalModelId,
  stripLocalPrefix,
  LOCAL_MODEL_PREFIX,
  type LocalModelInfo,
} from './localModelDiscovery.js';
import { debugLogger } from '../utils/debugLogger.js';

/**
 * Minimal interface for the Config methods the bridge needs.
 * Using an interface keeps this module loosely coupled — it doesn't
 * import the full 2800-line Config class at the type level.
 */
export interface LocalModelBridgeConfig {
  getLocalUrl(): string | undefined;
  getModel(): string;
  setModel(newModel: string, isTemporary?: boolean): void;
  getDiscoveredLocalModels(): LocalModelInfo[];
  setDiscoveredLocalModels(models: LocalModelInfo[]): void;
  getGeneratorSwapPromise(): Promise<void> | null;
  setGeneratorSwapPromise(p: Promise<void> | null): void;
  setLocalModelOverride(model: string): void;
  refreshAuth(
    authMethod: AuthType,
    apiKey?: string,
    baseUrl?: string,
    customHeaders?: Record<string, string>,
  ): Promise<void>;
  getContentGeneratorConfig(): { authType?: AuthType | string };
  isLocalMode(): boolean;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Fetches available models from the local server and stores them on config.
 * Called from Config.refreshAuth() after the LOCAL generator is created.
 *
 * Best-effort: all errors are caught and logged.  On failure the discovered
 * list is set to an empty array (the UI will show a single fallback entry).
 */
export async function discoverAndStoreLocalModels(
  config: LocalModelBridgeConfig,
): Promise<void> {
  const localUrl = config.getLocalUrl();
  if (!localUrl) return;

  try {
    const models = await fetchLocalModels(localUrl, 5000);

    // If discovery returned nothing but we have a localUrl, create a single
    // fallback entry from the configured model so the picker isn't empty.
    if (models.length === 0) {
      const currentModel = config.getModel();
      const rawId = isLocalModelId(currentModel)
        ? stripLocalPrefix(currentModel)
        : currentModel;
      const fallback: LocalModelInfo = {
        id: rawId,
        localId: LOCAL_MODEL_PREFIX + rawId,
        displayName: rawId,
      };
      config.setDiscoveredLocalModels([fallback]);
      debugLogger.log(
        `[LocalModelBridge] Discovery returned 0 models; using fallback: ${rawId}`,
      );
      return;
    }

    config.setDiscoveredLocalModels(models);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    debugLogger.log(
      `[LocalModelBridge] discoverAndStoreLocalModels failed: ${msg}`,
    );
    config.setDiscoveredLocalModels([]);
  }
}

// ---------------------------------------------------------------------------
// Cross-boundary model switching
// ---------------------------------------------------------------------------

/**
 * Switches the active model, handling the case where the switch crosses
 * the local / Gemini boundary (which requires a generator swap).
 *
 * - Same-boundary switches (local→local or gemini→gemini) are synchronous
 *   and just call `config.setModel()`.
 * - Cross-boundary switches kick off an async `refreshAuth()` fire-and-forget,
 *   storing the promise so `awaitGeneratorReady()` can block before the next
 *   request.  On failure the previous model is restored.
 */
export function switchModelAcrossBoundary(
  config: LocalModelBridgeConfig,
  newModelId: string,
  persistMode: boolean = true,
): void {
  const currentModel = config.getModel();
  const currentIsLocal = isLocalModelId(currentModel) || config.isLocalMode();
  const newIsLocal = isLocalModelId(newModelId);
  const isCrossBoundary = currentIsLocal !== newIsLocal;

  if (!isCrossBoundary) {
    // Same boundary — just swap the model string.
    if (newIsLocal) {
      config.setLocalModelOverride(stripLocalPrefix(newModelId));
    }
    config.setModel(newModelId, persistMode);
    return;
  }

  // Cross-boundary: save state for rollback, then fire-and-forget.
  const previousModel = currentModel;

  if (newIsLocal) {
    config.setLocalModelOverride(stripLocalPrefix(newModelId));
  }
  config.setModel(newModelId, persistMode);

  const targetAuthType = newIsLocal ? AuthType.LOCAL : AuthType.USE_GEMINI;

  const swapPromise = (async () => {
    try {
      await config.refreshAuth(targetAuthType);
      debugLogger.log(
        `[LocalModelBridge] Generator swap complete: ${previousModel} → ${newModelId}`,
      );
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      debugLogger.log(
        `[LocalModelBridge] Generator swap failed (${previousModel} → ${newModelId}): ${msg}. Reverting.`,
      );

      // Rollback: restore previous model and re-create previous generator.
      if (isLocalModelId(previousModel) || config.isLocalMode()) {
        config.setLocalModelOverride(
          isLocalModelId(previousModel)
            ? stripLocalPrefix(previousModel)
            : previousModel,
        );
      }
      config.setModel(previousModel, persistMode);

      try {
        const rollbackAuth =
          isLocalModelId(previousModel) || config.isLocalMode()
            ? AuthType.LOCAL
            : AuthType.USE_GEMINI;
        await config.refreshAuth(rollbackAuth);
      } catch (rollbackErr: unknown) {
        const rbMsg =
          rollbackErr instanceof Error
            ? rollbackErr.message
            : String(rollbackErr);
        debugLogger.log(`[LocalModelBridge] Rollback also failed: ${rbMsg}`);
      }

      throw new Error(
        `Failed to switch to ${newModelId}: ${msg}. Reverted to ${previousModel}.`,
      );
    }
  })();

  config.setGeneratorSwapPromise(
    swapPromise
      .catch(() => {
        // Error already logged and rolled back inside the async block.
        // Swallow here so the fire-and-forget doesn't cause unhandled rejection.
      })
      .finally(() => {
        config.setGeneratorSwapPromise(null);
      }),
  );
}

// ---------------------------------------------------------------------------
// Request guard
// ---------------------------------------------------------------------------

/**
 * Awaits any pending generator swap.  Call this before sending a request
 * to ensure the content generator is ready.
 */
export async function awaitGeneratorReady(
  config: LocalModelBridgeConfig,
): Promise<void> {
  const pending = config.getGeneratorSwapPromise();
  if (pending) {
    await pending;
  }
}
