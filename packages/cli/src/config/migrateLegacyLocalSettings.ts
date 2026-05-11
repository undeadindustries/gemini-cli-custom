/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// --- LOCAL FORK ADDITION (Phase 2.2) ---
// One-time migration helper: rewrites a settings.json `local.*` block
// into `providers.local-vllm.*` and sets `providers.active = "local-vllm"`
// so the unified provider resolver picks it up. Runs at startup inside
// loadSettings() and persists the result so subsequent launches see only
// the new shape.
//
// Why "local-vllm" specifically:
//   The legacy `local.*` block was the gemini-cli-custom fork's vLLM /
//   llama.cpp entry point. The `local-vllm` registry preset has the
//   matching defaults (port 8000, OpenAI-chat wire format, no API key).
//
// Sampler-specific legacy keys other than `temperature`
// (`local.topP`, `local.topK`, `local.minP`, `local.repetitionPenalty`,
// `local.toolCallParsing`) still don't map onto `ProviderInstanceConfig`
// today, so they are dropped from the providers block but remain readable
// via the `--LOCAL FORK ADDITION (Phase 2.0.13/2.0.14)--` getters on
// Config (which fall back to env vars). The user can re-set those via
// `GEMINI_LOCAL_TOP_P`, etc.
//
// Phase 2.3.1: `local.temperature` IS now migrated into
// `providers.local-vllm.temperature` because the unified provider
// registry exposes `temperature` as a per-provider field. This prevents
// the data loss reported on first 2.2 migrations where the temperature
// was silently dropped.
// --- END LOCAL FORK ADDITION ---

/**
 * One legacy `local.*` key plus the destination it maps to inside the
 * `providers.local-vllm.*` block. Field rename (`url` → `baseUrl`) is
 * captured here.
 */
interface LegacyKeyMapping {
  readonly legacyKey: string;
  readonly providerKey: string;
}

/**
 * Keys that flow 1:1 (with the `url`→`baseUrl` rename) from `local.*`
 * into `providers.local-vllm.*`. The provider registry's
 * `validSettingKeys` list is the source of truth for what the resolver
 * actually consumes; this list must stay in sync with the OpenAI-compat
 * shape declared in providerRegistry.ts.
 */
const MIGRATED_KEY_MAPPINGS: readonly LegacyKeyMapping[] = Object.freeze([
  { legacyKey: 'url', providerKey: 'baseUrl' },
  { legacyKey: 'model', providerKey: 'model' },
  { legacyKey: 'contextLimit', providerKey: 'contextLimit' },
  { legacyKey: 'timeout', providerKey: 'timeout' },
  { legacyKey: 'enableTools', providerKey: 'enableTools' },
  { legacyKey: 'promptMode', providerKey: 'promptMode' },
  { legacyKey: 'compressionThreshold', providerKey: 'compressionThreshold' },
  { legacyKey: 'preserveFraction', providerKey: 'preserveFraction' },
  // Phase 2.3.1: `temperature` is now a per-provider field on
  // ProviderInstanceConfig — promoted out of "drop with warning" into
  // the migrated set so users don't lose their tuned value.
  { legacyKey: 'temperature', providerKey: 'temperature' },
]);

/**
 * Result of running {@link migrateLegacyLocalSettings} on a raw settings
 * blob. `migrated === false` means no changes — caller can short-circuit
 * the persist + backup steps.
 */
export interface LegacyLocalMigrationResult {
  /** True iff the input contained a non-empty `local.*` block. */
  readonly migrated: boolean;
  /** Keys successfully copied from `local.*` into `providers.local-vllm.*`. */
  readonly migratedKeys: ReadonlyArray<{ from: string; to: string }>;
  /**
   * Legacy keys that were present but not mapped to a provider key
   * (sampler knobs, unknown / typo keys). These are dropped from the
   * settings file; callers should surface them in a one-line notice so
   * the user can re-set them via env vars or `/provider set` if needed.
   */
  readonly droppedKeys: readonly string[];
  /**
   * The mutated settings blob, ready to write back to disk. Returned as
   * a fresh object so callers can compare against the input by reference
   * if they want to short-circuit the disk write.
   */
  readonly newSettings: Record<string, unknown>;
}

/**
 * Pure, side-effect-free migration. Returns the rewritten settings plus
 * a manifest of what moved / was dropped. Callers handle persistence and
 * the .pre-2.2.bak backup separately.
 *
 * Idempotent: running this on already-migrated settings (no `local.*`
 * block, or all-empty `local.*`) returns `{ migrated: false }` with the
 * input passed through unchanged.
 */
/**
 * Type guard for plain JSON objects (rejects null, arrays, primitives).
 * Uses a single `typeof value === 'object'` on a local variable so the
 * `no-restricted-syntax` rule (which forbids `typeof obj['key']`) is
 * satisfied while still narrowing TypeScript's view to a typed record.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a string-typed field from an untyped record. Returns the value
 * iff it is a string, otherwise undefined. Encapsulates the
 * `typeof record['key']` check that the `no-restricted-syntax` rule
 * forbids inline.
 */
function readStringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Read a record-typed field from an untyped record. Same rationale as
 * {@link readStringField} — keeps the dynamic-key typeof check inside
 * a typed accessor instead of inline at the call site.
 */
function readRecordField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isPlainRecord(value) ? value : undefined;
}

export function migrateLegacyLocalSettings(
  rawSettings: Record<string, unknown>,
): LegacyLocalMigrationResult {
  const localBlock = rawSettings['local'];
  if (!isPlainRecord(localBlock)) {
    return {
      migrated: false,
      migratedKeys: [],
      droppedKeys: [],
      newSettings: rawSettings,
    };
  }

  const localKeys = Object.keys(localBlock);

  // Treat an empty / all-undefined local block as "nothing to migrate"
  // so we don't churn settings.json on every boot for a user who has
  // never had local mode configured.
  const nonEmptyLocalKeys = localKeys.filter((k) => {
    const value = localBlock[k];
    if (value === undefined || value === null) return false;
    if (typeof value === 'string' && value === '') return false;
    return true;
  });
  if (nonEmptyLocalKeys.length === 0) {
    return {
      migrated: false,
      migratedKeys: [],
      droppedKeys: [],
      newSettings: rawSettings,
    };
  }

  const newSettings: Record<string, unknown> = { ...rawSettings };
  const existingProviders = readRecordField(newSettings, 'providers');
  const providers: Record<string, unknown> = existingProviders
    ? { ...existingProviders }
    : {};
  newSettings['providers'] = providers;

  const existingLocalVllm = readRecordField(providers, 'local-vllm');
  const localVllm: Record<string, unknown> = existingLocalVllm
    ? { ...existingLocalVllm }
    : {};
  providers['local-vllm'] = localVllm;

  const migratedKeys: Array<{ from: string; to: string }> = [];
  const droppedKeys: string[] = [];

  for (const legacyKey of nonEmptyLocalKeys) {
    const mapping = MIGRATED_KEY_MAPPINGS.find(
      (m) => m.legacyKey === legacyKey,
    );
    if (!mapping) {
      droppedKeys.push(legacyKey);
      continue;
    }
    // Don't clobber an existing provider override. The user (or a
    // previous partial migration) wins over the legacy block.
    if (localVllm[mapping.providerKey] === undefined) {
      localVllm[mapping.providerKey] = localBlock[legacyKey];
    }
    migratedKeys.push({ from: legacyKey, to: mapping.providerKey });
  }

  // Set providers.active only when not already set, so a user who has
  // already picked a different provider (e.g. via the dialog) keeps it.
  const activeStr = readStringField(providers, 'active');
  if (activeStr === undefined || activeStr.trim() === '') {
    providers['active'] = 'local-vllm';
  }

  // Drop the now-migrated local block so subsequent loads stop seeing
  // it. The legacy-local fallback inside getEffectiveProviderConfig()
  // will short-circuit out (no `local.url`).
  delete newSettings['local'];

  return {
    migrated: true,
    migratedKeys,
    droppedKeys,
    newSettings,
  };
}
