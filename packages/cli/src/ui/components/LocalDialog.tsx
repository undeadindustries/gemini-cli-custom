/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// --- LOCAL FORK ADDITION ---
// /local dialog for editing the local LLM server config and Phase 2.0
// smart-context knobs.
//
// Architectural notes for future maintainers:
//   - This dialog reuses BaseSettingsDialog (the same primitive /settings uses)
//     and filters its items to keys under `local.*`.  Adding new local.* keys
//     in settingsSchema.ts will make them appear here automatically.
//   - The "server card" is rendered above the field list as a read-only
//     summary plus a live reachability check.  When we later support multiple
//     local servers (e.g. fast/big tiers a la Gemini flash/pro), we replace
//     the single LocalServerView with an array; LocalServerCard is already
//     designed to repeat without changes.
//   - Persistence flows through useSettingsStore -> LoadedSettings.setValue,
//     same as every other dialog. Defaults come from settingsSchema.ts; this
//     component never hardcodes them.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { Box, Text } from 'ink';
import { fetchLocalModels, type LocalModelInfo } from '@google/gemini-cli-core';
import { theme } from '../semantic-colors.js';
import { relaunchApp } from '../../utils/processUtils.js';
import {
  SettingScope,
  type LoadableSettingScope,
  type Settings,
} from '../../config/settings.js';
import { getScopeMessageForSetting } from '../../utils/dialogScopeUtils.js';
import {
  getDialogSettingKeys,
  getDisplayValue,
  getSettingDefinition,
  getDialogRestartRequiredSettings,
  getEffectiveValue,
  isInSettingsScope,
  getEditValue,
  parseEditedValue,
} from '../../utils/settingsUtils.js';
import {
  useSettingsStore,
  type SettingsState,
} from '../contexts/SettingsContext.js';
import { getCachedStringWidth } from '../utils/textUtils.js';
import {
  type SettingsType,
  type SettingsValue,
  TOGGLE_TYPES,
} from '../../config/settingsSchema.js';
import { debugLogger } from '@google/gemini-cli-core';
import {
  BaseSettingsDialog,
  type SettingsDialogItem,
} from './shared/BaseSettingsDialog.js';
import {
  LocalServerCard,
  type LocalServerView,
  type ReachabilityState,
} from './LocalServerCard.js';
import { useConfig } from '../contexts/ConfigContext.js';

const MAX_ITEMS_TO_SHOW = 8;
const REACHABILITY_TIMEOUT_MS = 5000;
const URL_DEBOUNCE_MS = 600;

// --- LOCAL FORK ADDITION (Phase 2.0.2) ---
// Keys that are safe to hot-reload through Config.refreshLocalConfig() without
// requiring a CLI restart. Must stay in sync with the `requiresRestart: false`
// flips in settingsSchema.ts.
const HOT_RELOAD_KEYS = new Set([
  'local.url',
  'local.model',
  'local.promptMode',
]);

function hotReloadKeyToField(
  key: string,
): 'url' | 'model' | 'promptMode' | undefined {
  if (key === 'local.url') return 'url';
  if (key === 'local.model') return 'model';
  if (key === 'local.promptMode') return 'promptMode';
  return undefined;
}
// --- END LOCAL FORK ADDITION ---

// Snapshot per-scope values for restart-required local.* keys at mount time
// so we can detect pending restart-required changes.
function snapshotLocalRestartRequired(
  settings: SettingsState,
): Map<string, Map<string, string>> {
  const snapshot = new Map<string, Map<string, string>>();
  const scopes: Array<[string, Settings]> = [
    ['User', settings.user.settings],
    ['Workspace', settings.workspace.settings],
    ['System', settings.system.settings],
  ];
  for (const key of getDialogRestartRequiredSettings()) {
    if (!isLocalKey(key)) continue;
    const scopeMap = new Map<string, string>();
    for (const [scopeName, scopeSettings] of scopes) {
      const value = isInSettingsScope(key, scopeSettings)
        ? getEffectiveValue(key, scopeSettings)
        : undefined;
      scopeMap.set(scopeName, JSON.stringify(value));
    }
    snapshot.set(key, scopeMap);
  }
  return snapshot;
}

function isLocalKey(key: string): boolean {
  return key === 'local' || key.startsWith('local.');
}

function getLocalDialogSettingKeys(): string[] {
  return getDialogSettingKeys().filter(
    (k) => k.startsWith('local.') && k !== 'local',
  );
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

interface LocalDialogProps {
  onClose: () => void;
}

export function LocalDialog({ onClose }: LocalDialogProps): React.JSX.Element {
  const { settings, setSetting } = useSettingsStore();
  const config = useConfig();

  const [selectedScope, setSelectedScope] = useState<LoadableSettingScope>(
    SettingScope.User,
  );

  const [activeRestartRequiredSettings] = useState(() =>
    snapshotLocalRestartRequired(settings),
  );

  // --- LOCAL FORK ADDITION (Phase 2.0.2) ---
  // Surface refreshAuth errors inline so a bad URL doesn't fail silently.
  const [hotReloadError, setHotReloadError] = useState<string | undefined>();

  const applyHotReload = useCallback(
    (key: string, newValue: SettingsValue) => {
      const field = hotReloadKeyToField(key);
      if (!field) return;
      const updates: { url?: string; model?: string; promptMode?: string } = {};
      if (field === 'promptMode') {
        updates.promptMode = typeof newValue === 'string' ? newValue : '';
      } else {
        updates[field] = typeof newValue === 'string' ? newValue : '';
      }
      setHotReloadError(undefined);
      // refreshLocalConfig is async; surface failures (e.g. bad URL) inline.

      config.refreshLocalConfig(updates).catch((err: unknown) => {
        setHotReloadError(
          err instanceof Error ? err.message : 'unknown refresh error',
        );
      });
    },
    [config],
  );
  // --- END LOCAL FORK ADDITION ---

  // Read merged local.* values for the status panel.
  const mergedLocal = useMemo(() => {
    const merged = settings.merged;
    const localBlock =
      typeof merged === 'object' && merged !== null && 'local' in merged
        ? (merged as { local?: Record<string, unknown> }).local
        : undefined;
    return localBlock ?? {};
  }, [settings.merged]);

  const url = asString(mergedLocal['url']);
  const model = asString(mergedLocal['model']);
  const timeoutMs = asNumber(mergedLocal['timeout'], 120000);

  // Build the current LocalServerView from settings. Today: a single 'default'
  // entry. Future multi-server support: derive an array from local.servers[].
  const serverViews: LocalServerView[] = useMemo(
    () => [
      {
        id: 'default',
        label: 'Local LLM Server',
        url,
        model,
        timeoutMs,
      },
    ],
    [url, model, timeoutMs],
  );

  // Reachability check, debounced after URL changes.
  const [reachability, setReachability] = useState<ReachabilityState>({
    status: 'idle',
  });
  useEffect(() => {
    if (!url) {
      setReachability({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setReachability({ status: 'checking' });
    const timer = setTimeout(() => {
      // Use base URL (strip the chat/completions path if present) for the
      // /v1/models discovery call.
      const baseUrl = deriveBaseUrl(url);
      fetchLocalModels(baseUrl, REACHABILITY_TIMEOUT_MS)
        .then((models: LocalModelInfo[]) => {
          if (cancelled) return;
          if (models.length === 0) {
            setReachability({
              status: 'unreachable',
              error: 'No /v1/models response',
            });
          } else {
            setReachability({
              status: 'reachable',
              modelCount: models.length,
            });
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setReachability({
            status: 'unreachable',
            error: err instanceof Error ? err.message : 'unknown error',
          });
        });
    }, URL_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [url]);

  // Build the list of local.* setting items.
  const items: SettingsDialogItem[] = useMemo(() => {
    const scopeSettings = settings.forScope(selectedScope).settings;
    const mergedSettings = settings.merged;
    const keys = getLocalDialogSettingKeys();
    return keys.map((key) => {
      const definition = getSettingDefinition(key);
      const type: SettingsType = definition?.type ?? 'string';
      const displayValue = getDisplayValue(key, scopeSettings, mergedSettings);
      const scopeMessage = getScopeMessageForSetting(
        key,
        selectedScope,
        settings,
      );
      const isGreyedOut = !isInSettingsScope(key, scopeSettings);
      const rawValue = getEffectiveValue(key, scopeSettings);
      const editValue = getEditValue(type, rawValue);
      return {
        key,
        label: definition?.label || key,
        description: definition?.description,
        type,
        displayValue,
        isGreyedOut,
        scopeMessage,
        rawValue,
        editValue,
      };
    });
  }, [selectedScope, settings]);

  // Restart-required tracking, scoped to local.* keys.
  const pendingRestartRequiredSettings = useMemo(() => {
    const changed = new Set<string>();
    const scopes: Array<[string, Settings]> = [
      ['User', settings.user.settings],
      ['Workspace', settings.workspace.settings],
      ['System', settings.system.settings],
    ];
    for (const [key, initialScopeMap] of activeRestartRequiredSettings) {
      for (const [scopeName, scopeSettings] of scopes) {
        const currentValue = isInSettingsScope(key, scopeSettings)
          ? getEffectiveValue(key, scopeSettings)
          : undefined;
        const initialJson = initialScopeMap.get(scopeName);
        if (JSON.stringify(currentValue) !== initialJson) {
          changed.add(key);
          break;
        }
      }
    }
    return changed;
  }, [settings, activeRestartRequiredSettings]);

  const showRestartPrompt = pendingRestartRequiredSettings.size > 0;

  const maxLabelOrDescriptionWidth = useMemo(() => {
    const allKeys = getLocalDialogSettingKeys();
    let max = 0;
    for (const key of allKeys) {
      const def = getSettingDefinition(key);
      if (!def) continue;
      const scopeMessage = getScopeMessageForSetting(
        key,
        selectedScope,
        settings,
      );
      const label = def.label || key;
      const labelFull = label + (scopeMessage ? ` ${scopeMessage}` : '');
      const lWidth = getCachedStringWidth(labelFull);
      const dWidth = def.description
        ? getCachedStringWidth(def.description)
        : 0;
      max = Math.max(max, lWidth, dWidth);
    }
    return max;
  }, [selectedScope, settings]);

  const handleScopeChange = useCallback((scope: LoadableSettingScope) => {
    setSelectedScope(scope);
  }, []);

  const handleItemToggle = useCallback(
    (key: string, _item: SettingsDialogItem) => {
      const definition = getSettingDefinition(key);
      if (!TOGGLE_TYPES.has(definition?.type)) {
        return;
      }
      const scopeSettings = settings.forScope(selectedScope).settings;
      const currentValue = getEffectiveValue(key, scopeSettings);
      let newValue: SettingsValue;
      if (definition?.type === 'boolean') {
        if (typeof currentValue !== 'boolean') {
          return;
        }
        newValue = !currentValue;
      } else if (definition?.type === 'enum' && definition.options) {
        const options = definition.options;
        if (options.length === 0) {
          return;
        }
        const currentIndex = options.findIndex(
          (opt) => opt.value === currentValue,
        );
        if (currentIndex !== -1 && currentIndex < options.length - 1) {
          newValue = options[currentIndex + 1].value;
        } else {
          newValue = options[0].value;
        }
      } else {
        return;
      }
      debugLogger.log(
        `[LocalDialog] Saving ${key} immediately with value:`,
        newValue,
      );
      setSetting(selectedScope, key, newValue);
      // --- LOCAL FORK ADDITION (Phase 2.0.2) ---
      if (HOT_RELOAD_KEYS.has(key)) {
        applyHotReload(key, newValue);
      }
      // --- END LOCAL FORK ADDITION ---
    },
    [settings, selectedScope, setSetting, applyHotReload],
  );

  const handleEditCommit = useCallback(
    (key: string, newValue: string, _item: SettingsDialogItem) => {
      const definition = getSettingDefinition(key);
      const type: SettingsType = definition?.type ?? 'string';
      const parsed = parseEditedValue(type, newValue);
      if (parsed === null) {
        return;
      }
      setSetting(selectedScope, key, parsed);
      // --- LOCAL FORK ADDITION (Phase 2.0.2) ---
      if (HOT_RELOAD_KEYS.has(key)) {
        applyHotReload(key, parsed);
      }
      // --- END LOCAL FORK ADDITION ---
    },
    [selectedScope, setSetting, applyHotReload],
  );

  const handleItemClear = useCallback(
    (key: string, _item: SettingsDialogItem) => {
      setSetting(selectedScope, key, undefined);
      // --- LOCAL FORK ADDITION (Phase 2.0.2) ---
      // Clearing falls back to the default ('' for url/model, 'lite' for
      // promptMode). Reading the merged value after setSetting in this same
      // tick still returns the OLD value, so derive the new effective value
      // from the schema default.
      if (HOT_RELOAD_KEYS.has(key)) {
        const definition = getSettingDefinition(key);
        const fallback = definition?.default ?? '';
        applyHotReload(key, fallback);
      }
      // --- END LOCAL FORK ADDITION ---
    },
    [selectedScope, setSetting, applyHotReload],
  );

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleKeyPress = useCallback(
    (
      key: { sequence?: string },
      _currentItem: SettingsDialogItem | undefined,
    ): boolean => {
      if (showRestartPrompt && key.sequence === 'r') {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        relaunchApp();
        return true;
      }
      return false;
    },
    [showRestartPrompt],
  );

  const hasWorkspace = settings.workspace.path !== undefined;

  return (
    <Box flexDirection="column">
      {serverViews.map((view) => (
        <LocalServerCard
          key={view.id}
          view={view}
          reachability={reachability}
        />
      ))}
      <BaseSettingsDialog
        title="Local LLM"
        borderColor={showRestartPrompt ? theme.status.warning : undefined}
        searchEnabled={false}
        items={items}
        showScopeSelector={hasWorkspace}
        selectedScope={selectedScope}
        onScopeChange={handleScopeChange}
        maxItemsToShow={MAX_ITEMS_TO_SHOW}
        maxLabelWidth={maxLabelOrDescriptionWidth}
        onItemToggle={handleItemToggle}
        onEditCommit={handleEditCommit}
        onItemClear={handleItemClear}
        onClose={handleClose}
        onKeyPress={handleKeyPress}
        footer={
          hotReloadError
            ? {
                content: (
                  <Text color={theme.status.error}>
                    Hot-reload failed: {hotReloadError}
                  </Text>
                ),
                height: 1,
              }
            : showRestartPrompt
              ? {
                  content: (
                    <Text color={theme.status.warning}>
                      Changes that require a restart have been modified. Press r
                      to exit and apply changes now.
                    </Text>
                  ),
                  height: 1,
                }
              : undefined
        }
      />
    </Box>
  );
}

/**
 * Strip the trailing chat/completions path so we can call
 * `GET <base>/v1/models` for discovery. Accepts URLs with or without
 * `/v1/...` suffixes.
 */
function deriveBaseUrl(url: string): string {
  if (!url) return url;
  // Common shape: http://host:port/v1/chat/completions
  // Less common: http://host:port/v1
  // Bare base:    http://host:port
  return url
    .replace(/\/v1\/chat\/completions\/?$/, '')
    .replace(/\/v1\/?$/, '')
    .replace(/\/+$/, '');
}
