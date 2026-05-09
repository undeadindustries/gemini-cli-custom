/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// --- LOCAL FORK ADDITION (Phase 2.2) ---
// AuthType lives in a tiny leaf module so it can be imported by the
// provider registry without dragging in the full contentGenerator.ts
// load chain (which transitively imports the package barrel and
// therefore Config). Keeping this file dependency-free is what avoids
// the "AuthType is undefined" circular-init failure observed during
// `npm run test --workspace=@google/gemini-cli-core`.
//
// contentGenerator.ts re-exports `AuthType` for backward compatibility
// so existing imports keep working unchanged.
// --- END LOCAL FORK ADDITION ---

export enum AuthType {
  LOGIN_WITH_GOOGLE = 'oauth-personal',
  USE_GEMINI = 'gemini-api-key',
  USE_VERTEX_AI = 'vertex-ai',
  LEGACY_CLOUD_SHELL = 'cloud-shell',
  COMPUTE_ADC = 'compute-default-credentials',
  GATEWAY = 'gateway',
  LOCAL = 'local',
  // --- LOCAL FORK ADDITION (Phase 2.1.1) ---
  // Note: hosted providers (OpenAI etc.) ALSO route through AuthType.LOCAL
  // because the wire format is identical (OpenAI chat-completions). The
  // distinction between "localhost vLLM" and "api.openai.com" is carried
  // by Config.getEffectiveProviderConfig().providerId. Keeping the enum
  // surface minimal avoids two parallel auth paths trying to be live at
  // once.
  // --- END LOCAL FORK ADDITION ---
}
