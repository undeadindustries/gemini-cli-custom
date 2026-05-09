/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// --- LOCAL FORK ADDITION (Phase 2.3) ---
// One-time migration helper: rewrites a settings.json that still treats
// `local-vllm` / `local-llamacpp` / `local-generic` as built-in registry
// ids into the new Phase 2.3 model where those three live in
// `providers.custom.*` as user-defined OpenAI-compat providers.
//
// Why we have to migrate rather than leave the data alone:
//   Phase 2.3 shrunk BUILT_IN_PROVIDERS to gemini-* + openai. The
//   resolver no longer recognises `local-vllm` etc. as built-ins. A
//   user upgrading from Phase 2.2 with `providers.active='local-vllm'`
//   would therefore hit "Unknown provider" on the first launch unless
//   we transparently re-register their preset as a custom entry.
//
// What we copy:
//   - `displayName`, `defaultBaseUrl`, `defaultModel`, `defaultContextLimit`,
//     `apiKeyEnvVar` go into `providers.custom.<id>` from the hard-coded
//     defaults that used to live in the registry, OVERLAID with whatever
//     the user already overrode in `providers.<id>.*`.
//   - `providers.<id>.*` runtime overrides (model, baseUrl, contextLimit,
//     promptMode, enableTools, timeout, ...) are LEFT IN PLACE so they
//     continue to apply on top of the custom registration. The
//     ProviderInstanceConfig path doesn't care whether the underlying
//     provider is built-in or custom.
//
// Idempotency:
//   - If `providers.custom.<id>` already exists, skip that id entirely.
//   - If neither `providers.<id>.*` overrides exist nor
//     `providers.active === <id>`, skip — the user never used this
//     preset and re-creating it would be churn.
// --- END LOCAL FORK ADDITION ---

/**
 * Phase 2.3 hard-coded defaults for the three legacy local presets,
 * mirroring what BUILT_IN_PROVIDERS looked like in Phase 2.2 so the
 * migrated entries behave identically to the old built-ins.
 *
 * Keep this map small and frozen — once 2.3 ships, the only path to
 * change a preset's defaults is for the user to edit
 * `providers.custom.<id>` directly (or `/provider remove` + re-add).
 */
interface LegacyPresetDefaults {
  readonly displayName: string;
  readonly baseUrl: string;
  readonly defaultModel: string;
  readonly defaultContextLimit: number;
  readonly apiKeyEnvVar: string;
}

const LEGACY_PRESET_DEFAULTS: Readonly<Record<string, LegacyPresetDefaults>> =
  Object.freeze({
    'local-vllm': {
      displayName: 'Local vLLM',
      baseUrl: 'http://127.0.0.1:8000/v1/chat/completions',
      defaultModel: '',
      defaultContextLimit: 65_536,
      apiKeyEnvVar: '',
    },
    'local-llamacpp': {
      displayName: 'Local llama.cpp',
      baseUrl: 'http://127.0.0.1:8080/v1/chat/completions',
      defaultModel: '',
      defaultContextLimit: 8192,
      apiKeyEnvVar: '',
    },
    'local-generic': {
      displayName: 'Local OpenAI-compatible',
      baseUrl: 'http://127.0.0.1:8000/v1/chat/completions',
      defaultModel: '',
      defaultContextLimit: 32_768,
      apiKeyEnvVar: '',
    },
  });

/**
 * Result of running {@link migrateLegacyLocalPresets} on a raw settings
 * blob. `migrated === false` means no changes — caller can skip the
 * persist + backup steps.
 */
export interface LegacyPresetsMigrationResult {
  /** True iff at least one preset was promoted into providers.custom. */
  readonly migrated: boolean;
  /**
   * Ids that were successfully promoted into `providers.custom.*` this
   * run. Used for the one-line startup notice.
   */
  readonly migratedIds: readonly string[];
  /**
   * Ids that already had a `providers.custom.<id>` entry from a prior
   * run. Reported separately so the notice can distinguish "added now"
   * from "already migrated, no-op".
   */
  readonly skippedIds: readonly string[];
  /**
   * The mutated settings blob, ready to write back to disk. Returned as
   * a fresh object so callers can compare against the input by
   * reference if they want to short-circuit the disk write.
   */
  readonly newSettings: Record<string, unknown>;
}

/**
 * Pure, side-effect-free migration. Returns the rewritten settings plus
 * a manifest of what was promoted. Callers handle persistence and the
 * `.pre-2.3.bak` backup separately.
 *
 * Idempotent: running this on already-migrated settings (every relevant
 * id has a `providers.custom.<id>` entry) returns `{ migrated: false }`
 * with the input passed through unchanged.
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
 * Read a finite-number-typed field from an untyped record. Returns the
 * value iff it is a finite number, otherwise undefined.
 */
function readNumberField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
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

export function migrateLegacyLocalPresets(
  rawSettings: Record<string, unknown>,
): LegacyPresetsMigrationResult {
  const providersBlock = rawSettings['providers'];
  if (!isPlainRecord(providersBlock)) {
    return {
      migrated: false,
      migratedIds: [],
      skippedIds: [],
      newSettings: rawSettings,
    };
  }

  const providers = providersBlock;
  const activeId = readStringField(providers, 'active')?.trim() ?? '';

  // Identify candidate ids — those that the user is actively using
  // (either the active provider or has overrides for).
  const candidateIds: string[] = [];
  for (const id of Object.keys(LEGACY_PRESET_DEFAULTS)) {
    const overrides = readRecordField(providers, id);
    const hasOverrides =
      overrides !== undefined && Object.keys(overrides).length > 0;
    if (hasOverrides || activeId === id) {
      candidateIds.push(id);
    }
  }

  if (candidateIds.length === 0) {
    return {
      migrated: false,
      migratedIds: [],
      skippedIds: [],
      newSettings: rawSettings,
    };
  }

  // Read the existing custom block (or an empty one) WITHOUT mutating
  // the input until we know we have something to write.
  const existingCustomRecord = readRecordField(providers, 'custom');
  const existingCustom: Record<string, unknown> = existingCustomRecord
    ? { ...existingCustomRecord }
    : {};

  const migratedIds: string[] = [];
  const skippedIds: string[] = [];
  const nextCustom: Record<string, unknown> = { ...existingCustom };

  for (const id of candidateIds) {
    if (id in existingCustom) {
      // Already migrated by an earlier run — leave it alone so user
      // edits to providers.custom.<id> are not clobbered.
      skippedIds.push(id);
      continue;
    }
    const presetDefaults = LEGACY_PRESET_DEFAULTS[id];
    const userOverrides = readRecordField(providers, id) ?? {};

    // Preset defaults are the floor; user overrides win on the static
    // fields the new shape captures. We don't pull non-static keys
    // (promptMode/enableTools/timeout/...) into the custom entry —
    // those stay in providers.<id>.* as runtime overrides, which is
    // exactly the same model the openai built-in uses.
    const overrideBaseUrl = readStringField(userOverrides, 'baseUrl');
    const overrideModel = readStringField(userOverrides, 'model');
    const overrideContextLimit = readNumberField(userOverrides, 'contextLimit');
    const customEntry: Record<string, unknown> = {
      displayName: presetDefaults.displayName,
      baseUrl:
        overrideBaseUrl !== undefined && overrideBaseUrl.trim() !== ''
          ? overrideBaseUrl
          : presetDefaults.baseUrl,
      defaultModel:
        overrideModel !== undefined && overrideModel.trim() !== ''
          ? overrideModel
          : presetDefaults.defaultModel,
      defaultContextLimit:
        overrideContextLimit !== undefined && overrideContextLimit > 0
          ? overrideContextLimit
          : presetDefaults.defaultContextLimit,
      apiKeyEnvVar: presetDefaults.apiKeyEnvVar,
    };
    nextCustom[id] = customEntry;
    migratedIds.push(id);
  }

  if (migratedIds.length === 0) {
    return {
      migrated: false,
      migratedIds: [],
      skippedIds,
      newSettings: rawSettings,
    };
  }

  const newSettings: Record<string, unknown> = { ...rawSettings };
  const newProviders: Record<string, unknown> = { ...providers };
  newProviders['custom'] = nextCustom;
  newSettings['providers'] = newProviders;

  return {
    migrated: true,
    migratedIds,
    skippedIds,
    newSettings,
  };
}

/**
 * Set of preset ids the migration considers — exported for tests and
 * for the (rare) caller that wants to know whether a given id was once
 * a built-in. Ordered so display-time iteration is stable.
 */
export const LEGACY_PRESET_IDS: readonly string[] = Object.freeze(
  Object.keys(LEGACY_PRESET_DEFAULTS),
);
