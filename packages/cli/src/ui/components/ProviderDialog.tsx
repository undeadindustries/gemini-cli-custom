/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Phase 2.1 → 2.3 — /provider dialog. Brand-new file (Category C) — no fences.
//
// Phase 2.3 reworks this from a single settings sheet into a state machine
// of screens reachable from a top-level menu. The Phase 2.1/2.2 settings
// sheet is preserved as the `'edit'` screen and re-used unchanged for
// OpenAI-compat providers; Gemini providers cannot reach it because their
// validSettingKeys are empty (upstream gemini-cli owns those defaults).
//
// Screens:
//   - 'menu'   : top-level action picker (Switch / Edit / Add / Remove /
//                Browse models / Close).
//   - 'switch' : radio list of every provider in the effective registry
//                (built-ins + custom). On Enter switches active and
//                persists.
//   - 'edit'   : per-provider settings sheet (Phase 2.2 flow). Hidden when
//                the active provider is a Gemini wireFormat entry.
//   - 'add'    : multi-field form for a new custom OpenAI-compat provider.
//                Validates id, baseUrl, env-var name on submit.
//   - 'remove' : radio list of *custom-only* providers + confirm prompt.
//                Built-ins are not removable (the entry just isn't shown).
//   - 'models' : OpenAI-compat /v1/models picker (also reachable from
//                Enter on the model field in the edit screen). Disabled
//                with a redirect message for Gemini providers.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { Box, Text } from 'ink';
import {
  loadProviderApiKey,
  saveProviderApiKey,
  resolveProvider,
  resolveProviderApiKey,
  fetchProviderModels,
  validateCustomProviderId,
  type ProviderInstanceConfig,
  type ProviderModelInfo,
  type ProviderDefinition,
  type CustomProviderDefinition,
} from '@google/gemini-cli-core';
import { theme } from '../semantic-colors.js';
import { relaunchApp } from '../../utils/processUtils.js';
import {
  SettingScope,
  type LoadableSettingScope,
  type Settings,
} from '../../config/settings.js';
import { getScopeMessageForSetting } from '../../utils/dialogScopeUtils.js';
import {
  getDisplayValue,
  getSettingDefinition,
  getDialogRestartRequiredSettings,
  getEffectiveValue,
  isInSettingsScope,
  getEditValue,
  parseEditedValue,
  getFlattenedSchema,
  registerCustomProviderSchemaAliases,
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
import {
  BaseSettingsDialog,
  type SettingsDialogItem,
} from './shared/BaseSettingsDialog.js';
import { DescriptiveRadioButtonSelect } from './shared/DescriptiveRadioButtonSelect.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { TextInput } from './shared/TextInput.js';
import { useTextBuffer } from './shared/text-buffer.js';
import { useKeypress, type Key } from '../hooks/useKeypress.js';
import { useConfig } from '../contexts/ConfigContext.js';

const MAX_ITEMS_TO_SHOW = 8;

// All ProviderInstanceConfig keys that hot-reload via
// Config.refreshProviderConfig() are handled explicitly in the
// applyHotReload switch statement below. The switch default: return
// short-circuits any unknown field, so no separate allowlist is needed.

type Screen =
  | 'menu'
  | 'switch'
  | 'edit'
  | 'add'
  | 'remove'
  | 'models'
  | 'set-key';

interface ProviderDialogProps {
  onClose: () => void;
}

/**
 * Top-level dialog. Owns the screen state machine and routes between
 * sub-components. The screens themselves are pure presentation +
 * effect — they call back into Config / settings via mutators passed in
 * as props, never via global state.
 */
export function ProviderDialog({
  onClose,
}: ProviderDialogProps): React.JSX.Element {
  const config = useConfig();
  const { setSetting } = useSettingsStore();

  // The effective registry can change inside the dialog (add/remove). We
  // track its identity so child screens re-derive their lists. The
  // simplest signal is a tick that bumps after every mutation.
  const [registryTick, setRegistryTick] = useState(0);
  const bumpRegistry = useCallback(() => setRegistryTick((t) => t + 1), []);

  const registry = useMemo<Record<string, ProviderDefinition>>(
    () => config.getProviderRegistry(),
    // bumpRegistry causes a fresh getProviderRegistry() read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config, registryTick],
  );

  const activeId = config.getActiveProviderId() ?? 'gemini-oauth';
  const activeDef: ProviderDefinition | undefined = registry[activeId];

  const [screen, setScreen] = useState<Screen>('menu');
  const [statusMessage, setStatusMessage] = useState<string | undefined>();
  // --- LOCAL FORK ADDITION (Phase 2.4.4: in-edit API key shortcut) ---
  // Tracks where to return after the SetKeyScreen finishes (or is
  // cancelled). When the set-key screen is opened from the menu the
  // return target is 'menu' (existing behavior); when opened from the
  // edit screen via the 'k' shortcut, returning to the edit screen keeps
  // the user in the same flow they were already in.
  const [setKeyReturnScreen, setSetKeyReturnScreen] = useState<'menu' | 'edit'>(
    'menu',
  );
  // --- END LOCAL FORK ADDITION ---

  const goMenu = useCallback(() => {
    setScreen('menu');
  }, []);

  const handleSwitchActive = useCallback(
    async (newId: string) => {
      try {
        await config.refreshProviderConfig({ active: newId });
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'unknown error';
        setStatusMessage(`Failed to switch provider: ${reason}`);
        setScreen('menu');
        return;
      }
      try {
        setSetting(SettingScope.User, 'providers.active', newId);
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'unknown error';
        setStatusMessage(
          `Switched to ${newId} for this session, but persisting failed: ${reason}.`,
        );
        setScreen('menu');
        return;
      }
      setStatusMessage(`Active provider \u2192 ${newId}.`);
      setScreen('menu');
    },
    [config, setSetting],
  );

  const handleAddCustom = useCallback(
    async (id: string, def: CustomProviderDefinition): Promise<boolean> => {
      try {
        config.addCustomProvider(id, def);
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'unknown error';
        setStatusMessage(`Failed to add custom provider: ${reason}`);
        return false;
      }
      try {
        setSetting(
          SettingScope.User,
          'providers.custom',
          config.getCustomProviders(),
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'unknown error';
        setStatusMessage(
          `Custom provider '${id}' added in-memory but persisting failed: ${reason}.`,
        );
        bumpRegistry();
        return true;
      }
      // --- LOCAL FORK ADDITION (Phase 2.3.2: stamp contextLimit at creation) ---
      // Stamp contextLimit: 32768 immediately so the dialog and footer
      // show the correct conservative baseline instead of the schema
      // placeholder (128000, which is only right for hosted OpenAI).
      // Then probe the server: vLLM returns max_model_len in /v1/models,
      // which lets us auto-correct to the real value.
      const FALLBACK_CONTEXT = 32_768;
      try {
        setSetting(
          SettingScope.User,
          `providers.${id}.contextLimit`,
          FALLBACK_CONTEXT,
        );
      } catch {
        /* non-fatal; 32768 will be returned from customToProviderDefinition anyway */
      }
      // Probe asynchronously so the dialog doesn't block on the network.
      void (async () => {
        try {
          const models = await fetchProviderModels(def.baseUrl, '', 5_000);
          const detected = models.find((m) => m.contextLimit)?.contextLimit;
          if (detected && detected !== FALLBACK_CONTEXT) {
            setSetting(
              SettingScope.User,
              `providers.${id}.contextLimit`,
              detected,
            );
            try {
              await config.refreshProviderConfig({
                setConfig: { id, patch: { contextLimit: detected } },
              });
            } catch {
              /* refresh error is non-fatal here */
            }
            setStatusMessage(
              `Custom provider '${id}' added — context limit auto-detected: ` +
                `${detected.toLocaleString()} tokens.`,
            );
          } else {
            setStatusMessage(
              `Custom provider '${id}' added. Use 'Switch active provider' to enable it.`,
            );
          }
          bumpRegistry();
        } catch {
          // Probe failed (server offline, auth error, etc.) — not fatal.
          setStatusMessage(
            `Custom provider '${id}' added. Use 'Switch active provider' to enable it.`,
          );
          bumpRegistry();
        }
      })();
      // --- END LOCAL FORK ADDITION (async IIFE)
      return true;
    },
    [config, setSetting, bumpRegistry],
  );

  const handleRemoveCustom = useCallback(
    // Phase 2.3.2: returns `true` iff the removed entry was the active
    // provider, signalling that the parent should route to the switch
    // screen so the user can pick a replacement (instead of silently
    // dropping into Gemini OAuth, which is wrong for users who never
    // intend to authenticate to Gemini).
    async (id: string): Promise<boolean> => {
      const wasActive = config.getActiveProviderId() === id;
      try {
        config.removeCustomProvider(id);
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'unknown error';
        setStatusMessage(`Failed to remove '${id}': ${reason}`);
        return false;
      }
      // Best-effort keychain clean-up via the existing path.
      try {
        await config.refreshProviderConfig({ removeProvider: id });
      } catch {
        /* refresh handles missing entries; ignore */
      }
      try {
        setSetting(
          SettingScope.User,
          'providers.custom',
          config.getCustomProviders(),
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'unknown error';
        setStatusMessage(
          `'${id}' removed in-memory but persisting failed: ${reason}.`,
        );
        bumpRegistry();
        return false;
      }
      // --- LOCAL FORK ADDITION (Phase 2.3.2: clear flat overrides) ---
      // Without this, settings.json keeps the flat `providers.<id>.*`
      // block (model, baseUrl, contextLimit, etc.). On the next launch
      // migrateLegacyLocalPresets sees those keys + missing
      // `providers.custom.<id>` and helpfully re-creates the custom
      // provider — silently undoing the removal. Setting the key to
      // undefined causes setNestedProperty to drop it on the next
      // saveSettings (JSON.stringify omits undefined properties).
      try {
        setSetting(SettingScope.User, `providers.${id}`, undefined);
      } catch {
        /* non-fatal: stale flat block will get re-migrated next boot
         * but the user can manually delete it from settings.json. */
      }
      // --- END LOCAL FORK ADDITION ---
      // --- LOCAL FORK ADDITION (Phase 2.3.2: no auto-fallback) ---
      // Removing the active provider used to silently switch to
      // gemini-oauth, kicking off a Google OAuth flow for users who
      // never wanted Gemini. Instead, clear `providers.active` and
      // signal to the parent that a switch screen is needed so the
      // user can pick from gemini-*, openai, any remaining custom
      // providers, or Add a fresh one.
      let suffix = '';
      if (wasActive) {
        try {
          await config.refreshProviderConfig({ active: null });
          setSetting(SettingScope.User, 'providers.active', '');
          suffix = ' No active provider — please pick one.';
        } catch (err) {
          const reason = err instanceof Error ? err.message : 'unknown error';
          suffix =
            ` (Could not clear active provider: ${reason}.` +
            ` Pick one with Switch active provider.)`;
        }
      }
      // --- END LOCAL FORK ADDITION ---
      setStatusMessage(`Custom provider '${id}' removed.${suffix}`);
      bumpRegistry();
      return wasActive;
    },
    [config, setSetting, bumpRegistry],
  );

  // Esc on a non-menu screen returns to the menu; Esc on the menu closes
  // the dialog. The edit screen owns its own Esc handler (BaseSettingsDialog)
  // so we don't intercept while editing.
  useKeypress(
    (key: Key) => {
      if (key.name !== 'escape') return false;
      if (screen === 'menu') {
        onClose();
        return true;
      }
      // 'edit' has its own internal Esc handling (model picker → settings
      // → onClose). Letting our handler fire would skip the picker exit,
      // so we no-op here and let BaseSettingsDialog process Esc.
      if (screen === 'edit') return false;
      setScreen('menu');
      return true;
    },
    { isActive: true, priority: false },
  );

  // ---- Render switch -----------------------------------------------------
  if (screen === 'menu') {
    return (
      <MenuScreen
        registry={registry}
        activeId={activeId}
        activeDef={activeDef}
        customCount={Object.keys(config.getCustomProviders()).length}
        statusMessage={statusMessage}
        onSwitch={() => {
          setStatusMessage(undefined);
          setScreen('switch');
        }}
        onEdit={() => {
          setStatusMessage(undefined);
          setScreen('edit');
        }}
        onSetKey={() => {
          setStatusMessage(undefined);
          // --- LOCAL FORK ADDITION (Phase 2.4.4: in-edit API key shortcut) ---
          setSetKeyReturnScreen('menu');
          // --- END LOCAL FORK ADDITION ---
          setScreen('set-key');
        }}
        onAdd={() => {
          setStatusMessage(undefined);
          setScreen('add');
        }}
        onRemove={() => {
          setStatusMessage(undefined);
          setScreen('remove');
        }}
        onModels={() => {
          setStatusMessage(undefined);
          setScreen('models');
        }}
        onClose={onClose}
      />
    );
  }

  if (screen === 'switch') {
    return (
      <SwitchScreen
        registry={registry}
        activeId={activeId}
        onSelect={handleSwitchActive}
        onCancel={goMenu}
      />
    );
  }

  if (screen === 'add') {
    return (
      <AddScreen
        registry={registry}
        onSubmit={async (id, def, apiKey) => {
          const ok = await handleAddCustom(id, def);
          if (!ok) return;
          // --- LOCAL FORK ADDITION (Phase 2.4.2: inline API key entry) ---
          if (apiKey) {
            try {
              await saveProviderApiKey(id, apiKey);
            } catch {
              // Non-fatal: provider is added, key save failed. The user
              // can retry with /provider set <id> key <key>.
              setStatusMessage(
                `Provider '${id}' added but keychain save failed. ` +
                  `Run /provider set ${id} key <your-key> to retry.`,
              );
              goMenu();
              return;
            }
          }
          // --- END LOCAL FORK ADDITION ---
          goMenu();
        }}
        onCancel={goMenu}
      />
    );
  }

  if (screen === 'remove') {
    return (
      <RemoveScreen
        customProviders={config.getCustomProviders()}
        registry={registry}
        // Phase 2.3.2: when the removal cleared the active provider,
        // jump to the switch screen so the user can pick a replacement
        // (gemini-*, openai, remaining custom providers). Otherwise
        // return to the menu as before.
        onConfirm={async (id) => {
          const wasActive = await handleRemoveCustom(id);
          if (wasActive) {
            setScreen('switch');
          } else {
            goMenu();
          }
        }}
        onCancel={goMenu}
      />
    );
  }

  if (screen === 'models') {
    return (
      <ModelsScreen
        activeId={activeId}
        activeDef={activeDef}
        onCancel={goMenu}
      />
    );
  }

  // --- LOCAL FORK ADDITION (Phase 2.3.1: Set API key screen,
  //     extended Phase 2.4.4 to honor setKeyReturnScreen) ---
  if (screen === 'set-key') {
    const returnTo = () => setScreen(setKeyReturnScreen);
    return (
      <SetKeyScreen
        providerId={activeId}
        providerDef={activeDef}
        onDone={(msg) => {
          if (msg) setStatusMessage(msg);
          returnTo();
        }}
        onCancel={returnTo}
      />
    );
  }
  // --- END LOCAL FORK ADDITION ---

  // 'edit'
  return (
    <EditScreen
      onClose={goMenu}
      // --- LOCAL FORK ADDITION (Phase 2.4.4: in-edit API key shortcut) ---
      onRequestSetKey={() => {
        setStatusMessage(undefined);
        setSetKeyReturnScreen('edit');
        setScreen('set-key');
      }}
      // --- END LOCAL FORK ADDITION ---
    />
  );
}

// ---- MenuScreen ----------------------------------------------------------

interface MenuScreenProps {
  registry: Record<string, ProviderDefinition>;
  activeId: string;
  activeDef: ProviderDefinition | undefined;
  customCount: number;
  statusMessage: string | undefined;
  onSwitch: () => void;
  onEdit: () => void;
  onSetKey: () => void;
  onAdd: () => void;
  onRemove: () => void;
  onModels: () => void;
  onClose: () => void;
}

type MenuAction =
  | 'switch'
  | 'edit'
  | 'set-key'
  | 'add'
  | 'remove'
  | 'models'
  | 'close';

function MenuScreen({
  registry,
  activeId,
  activeDef,
  customCount,
  statusMessage,
  onSwitch,
  onEdit,
  onSetKey,
  onAdd,
  onRemove,
  onModels,
  onClose,
}: MenuScreenProps): React.JSX.Element {
  const isGemini = activeDef?.wireFormat === 'gemini';
  const customTag = activeDef?.isCustom ? ' [custom]' : '';

  const items = useMemo(() => {
    const list: Array<{ key: MenuAction; label: string; sublabel?: string }> = [
      {
        key: 'switch',
        label: 'Switch active provider',
        sublabel: `${Object.keys(registry).length} available`,
      },
    ];
    // Phase 2.3: hide Edit when active is a Gemini wireFormat — those
    // providers expose zero editable settings on purpose.
    if (!isGemini) {
      list.push({
        key: 'edit',
        label: `Edit active provider (${activeId})`,
        sublabel: activeDef?.isCustom
          ? 'Custom OpenAI-compat provider'
          : 'OpenAI-compat provider',
      });
    }
    // --- LOCAL FORK ADDITION (Phase 2.3.1: Set API key menu item,
    //     widened in Phase 2.4.5) ---
    // Show "Set API key" for any OpenAI-compat provider (chat or
    // responses), regardless of `requiresApiKey`. Phase 2.4.5
    // discovery: hosts like OpenRouter, Together, Groq, Fireworks,
    // etc. all need a key, but custom providers added via
    // `/provider add` without a `--env` flag end up with an empty
    // `apiKeyEnvVar`, which used to compute `requiresApiKey: false`
    // and HID this menu item. Now we let users save a key on any
    // OpenAI-compat provider; the request-side header logic only
    // attaches Authorization when a key is actually present, so
    // genuinely-no-auth local servers (bare vLLM) keep working.
    // Gemini wireFormat is still routed through /auth and shows
    // "Set API key" only when its built-in declares requiresApiKey.
    const showSetKey =
      activeDef?.wireFormat === 'openai-chat' ||
      activeDef?.wireFormat === 'openai-responses' ||
      !!activeDef?.requiresApiKey;
    if (showSetKey && activeDef) {
      // For built-in providers with a known env var, show its status;
      // for custom providers without an env var, just describe the
      // keychain destination.
      const envVar = activeDef.apiKeyEnvVar?.trim();
      const envSet = envVar ? !!process.env[envVar]?.trim() : false;
      let sublabel: string;
      if (envSet && envVar) {
        sublabel = `currently using $${envVar} — saves to keychain instead`;
      } else if (envVar) {
        sublabel = `save to OS keychain (or set env var ${envVar})`;
      } else {
        sublabel = 'save to OS keychain (no env var configured)';
      }
      list.push({
        key: 'set-key',
        label: `Set API key (${activeId})`,
        sublabel,
      });
    }
    // --- END LOCAL FORK ADDITION ---
    list.push({
      key: 'add',
      label: 'Add provider',
      sublabel: 'New custom OpenAI-compat endpoint',
    });
    list.push({
      key: 'remove',
      label: 'Remove provider',
      sublabel:
        customCount === 0
          ? 'no custom providers to remove'
          : `${customCount} custom provider${customCount === 1 ? '' : 's'}`,
    });
    list.push({
      key: 'models',
      label: 'Browse models',
      sublabel: isGemini
        ? 'unavailable for Gemini — handled upstream'
        : 'fetch /v1/models from active provider',
    });
    list.push({ key: 'close', label: 'Close', sublabel: 'or press Esc' });
    return list;
  }, [registry, isGemini, activeId, activeDef, customCount]);

  const radioItems = items.map((it) => ({
    value: it.key,
    key: it.key,
    title: it.label,
    description: it.sublabel,
  }));

  const onSelect = useCallback(
    (action: MenuAction) => {
      switch (action) {
        case 'switch':
          onSwitch();
          break;
        case 'edit':
          if (isGemini) return; // Defensive: should not appear in items.
          onEdit();
          break;
        // --- LOCAL FORK ADDITION (Phase 2.3.1: Set API key routing) ---
        case 'set-key':
          onSetKey();
          break;
        // --- END LOCAL FORK ADDITION ---
        case 'add':
          onAdd();
          break;
        case 'remove':
          if (customCount === 0) {
            return;
          }
          onRemove();
          break;
        case 'models':
          if (isGemini) return;
          onModels();
          break;
        case 'close':
          onClose();
          break;
        default:
          break;
      }
    },
    [
      isGemini,
      customCount,
      onSwitch,
      onEdit,
      onSetKey,
      onAdd,
      onRemove,
      onModels,
      onClose,
    ],
  );

  return (
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.border.default}
        paddingX={1}
        marginBottom={1}
      >
        <Text bold>{'/provider \u2014 manage LLM backends'}</Text>
        <Text>
          {'  Active: '}
          <Text color={theme.text.accent}>
            {(activeDef?.displayName ?? activeId) + ' (' + activeId + ')'}
          </Text>
          <Text color={theme.text.secondary}>{customTag}</Text>
        </Text>
        {isGemini ? (
          <Text color={theme.text.secondary}>
            {'  Gemini uses gemini-cli defaults \u2014 nothing to edit. ' +
              'Run /auth to switch credentials.'}
          </Text>
        ) : null}
        {statusMessage ? (
          <Text color={theme.status.success}>{'  ' + statusMessage}</Text>
        ) : null}
      </Box>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.border.default}
        paddingX={1}
      >
        <Text bold>{'Pick an action'}</Text>
        <Box marginTop={1}>
          <DescriptiveRadioButtonSelect<MenuAction>
            items={radioItems}
            initialIndex={0}
            onSelect={onSelect}
            showNumbers={true}
            maxItemsToShow={MAX_ITEMS_TO_SHOW}
          />
        </Box>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            {'Tip: \u2191/\u2193 to navigate, Enter to confirm, Esc to close.'}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

// ---- SwitchScreen --------------------------------------------------------

interface SwitchScreenProps {
  registry: Record<string, ProviderDefinition>;
  activeId: string;
  onSelect: (id: string) => void;
  onCancel: () => void;
}

function SwitchScreen({
  registry,
  activeId,
  onSelect,
}: SwitchScreenProps): React.JSX.Element {
  const ids = useMemo(() => Object.keys(registry), [registry]);
  const items = useMemo(
    () =>
      ids.map((id) => {
        const def = registry[id];
        const customTag = def.isCustom ? ' [custom]' : '';
        const activeMark = id === activeId ? ' \u25b8' : '';
        return {
          value: id,
          key: id,
          title: `${def.displayName} (${id})${customTag}${activeMark}`,
          description:
            def.wireFormat === 'gemini'
              ? 'Gemini wire \u2014 upstream defaults'
              : def.requiresApiKey
                ? `OpenAI-compat \u2014 needs $${def.apiKeyEnvVar}`
                : 'OpenAI-compat \u2014 no auth required',
        };
      }),
    [ids, registry, activeId],
  );

  const initialIndex = Math.max(
    ids.findIndex((id) => id === activeId),
    0,
  );

  return (
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.border.default}
        paddingX={1}
        marginBottom={1}
      >
        <Text bold>{'Switch active provider'}</Text>
        <Text color={theme.text.secondary}>
          {`Currently active: ${activeId}. Esc to cancel.`}
        </Text>
      </Box>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.border.default}
        paddingX={1}
      >
        <DescriptiveRadioButtonSelect<string>
          items={items}
          initialIndex={initialIndex}
          onSelect={onSelect}
          showNumbers={true}
          maxItemsToShow={MAX_ITEMS_TO_SHOW}
        />
      </Box>
    </Box>
  );
}

// ---- ModelsScreen --------------------------------------------------------

interface ModelsScreenProps {
  activeId: string;
  activeDef: ProviderDefinition | undefined;
  onCancel: () => void;
}

function ModelsScreen({
  activeId,
  activeDef,
  onCancel,
}: ModelsScreenProps): React.JSX.Element {
  const config = useConfig();
  const { setSetting } = useSettingsStore();

  type FetchState =
    | { mode: 'loading' }
    | { mode: 'error'; message: string }
    | { mode: 'redirect'; message: string }
    | { mode: 'ready'; models: ProviderModelInfo[]; currentModel: string };
  const [state, setState] = useState<FetchState>({ mode: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!activeDef) {
        if (!cancelled) {
          setState({
            mode: 'error',
            message: `Unknown provider '${activeId}'. Use Switch active provider first.`,
          });
        }
        return;
      }
      if (activeDef.wireFormat === 'gemini') {
        if (!cancelled) {
          setState({
            mode: 'redirect',
            message:
              'Gemini model selection is handled upstream \u2014 set GEMINI_MODEL ' +
              'in env, pick from /model, or type the model name directly. ' +
              'The model browser only applies to OpenAI-compat providers.',
          });
        }
        return;
      }
      let apiKey = '';
      if (activeDef.requiresApiKey) {
        const k = await resolveProviderApiKey(activeId);
        if (!k) {
          if (!cancelled) {
            setState({
              mode: 'error',
              message:
                `No API key for '${activeId}'. ` +
                `Set $${activeDef.apiKeyEnvVar} or run /provider set ${activeId} key <api-key>.`,
            });
          }
          return;
        }
        apiKey = k;
      }
      const override = config.getProviderConfig(activeId);
      let baseUrl = activeDef.defaultBaseUrl;
      try {
        const r = resolveProvider(
          activeId,
          override,
          config.getCustomProviders(),
        );
        baseUrl = r.baseUrl;
      } catch {
        /* fall back to registry default */
      }
      try {
        const models = await fetchProviderModels(baseUrl, apiKey);
        if (cancelled) return;
        if (models.length === 0) {
          setState({
            mode: 'error',
            message:
              `Could not retrieve model list from ${activeDef.displayName}. ` +
              `Check API key and network.`,
          });
          return;
        }
        const currentModel = override?.model?.trim() || activeDef.defaultModel;
        setState({ mode: 'ready', models, currentModel });
      } catch (err) {
        if (cancelled) return;
        setState({
          mode: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Unknown error fetching models',
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId, activeDef, config]);

  const radioItems = useMemo(() => {
    if (state.mode !== 'ready') return [];
    return state.models.map((m) => ({
      value: m.id,
      key: m.id,
      title: m.id,
      description: m.ownedBy ? `owned by ${m.ownedBy}` : undefined,
    }));
  }, [state]);

  const initialIndex = useMemo(() => {
    if (state.mode !== 'ready') return 0;
    const idx = state.models.findIndex((m) => m.id === state.currentModel);
    return idx !== -1 ? idx : 0;
  }, [state]);

  const onPick = useCallback(
    async (modelId: string) => {
      const key = `providers.${activeId}.model`;
      try {
        setSetting(SettingScope.User, key, modelId);
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'unknown error';
        setState({
          mode: 'error',
          message: `Failed to save model selection: ${reason}`,
        });
        return;
      }
      try {
        await config.refreshProviderConfig({
          setConfig: { id: activeId, patch: { model: modelId } },
        });
      } catch {
        /* live-refresh failure is non-fatal; the next request picks up
         * the persisted setting. */
      }
      onCancel();
    },
    [activeId, setSetting, config, onCancel],
  );

  const title = `Models \u2014 ${activeDef?.displayName ?? activeId}`;

  if (state.mode === 'loading') {
    return (
      <StatusFrame
        title={title}
        subtitle="Fetching models..."
        color="default"
      />
    );
  }
  if (state.mode === 'error') {
    return <StatusFrame title={title} subtitle={state.message} color="error" />;
  }
  if (state.mode === 'redirect') {
    return <StatusFrame title={title} subtitle={state.message} color="info" />;
  }
  return (
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.border.default}
        paddingX={1}
        marginBottom={1}
      >
        <Text bold>{title}</Text>
        <Text color={theme.text.secondary}>
          {`${state.models.length} chat-capable models. Esc to cancel.`}
        </Text>
      </Box>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.border.default}
        paddingX={1}
      >
        <DescriptiveRadioButtonSelect<string>
          items={radioItems}
          initialIndex={initialIndex}
          onSelect={onPick}
          showNumbers={true}
          maxItemsToShow={MAX_ITEMS_TO_SHOW}
        />
      </Box>
    </Box>
  );
}

interface StatusFrameProps {
  title: string;
  subtitle: string;
  color: 'default' | 'error' | 'info';
}

function StatusFrame({
  title,
  subtitle,
  color,
}: StatusFrameProps): React.JSX.Element {
  const borderColor =
    color === 'error' ? theme.status.error : theme.border.default;
  const subtitleColor =
    color === 'error'
      ? theme.status.error
      : color === 'info'
        ? theme.text.secondary
        : theme.text.secondary;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
    >
      <Text bold>{title}</Text>
      <Text color={subtitleColor}>{subtitle}</Text>
      <Text color={theme.text.secondary}>{'Press Esc to go back.'}</Text>
    </Box>
  );
}

// ---- AddScreen -----------------------------------------------------------

interface AddScreenProps {
  registry: Record<string, ProviderDefinition>;
  // --- LOCAL FORK ADDITION (Phase 2.4.2: inline API key entry) ---
  onSubmit: (
    id: string,
    def: CustomProviderDefinition,
    apiKey?: string,
  ) => void;
  // --- END LOCAL FORK ADDITION ---
  onCancel: () => void;
}

// --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
// `wireFormat` is rendered as a left/right toggle (no text buffer) so
// the user can flip between 'openai-chat' and 'openai-responses'
// without typing the literal string. Defaults to 'openai-chat' so the
// pre-2.4 add flow is byte-identical when the user just hits Enter
// through every field.
// --- END LOCAL FORK ADDITION ---
type AddField =
  | 'id'
  | 'displayName'
  | 'baseUrl'
  | 'defaultModel'
  | 'envVar'
  // --- LOCAL FORK ADDITION (Phase 2.4.2: inline API key entry) ---
  | 'apiKey'
  // --- END LOCAL FORK ADDITION ---
  // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
  | 'wireFormat';
// --- END LOCAL FORK ADDITION ---
const ADD_FIELDS: readonly AddField[] = [
  'id',
  'displayName',
  'baseUrl',
  'defaultModel',
  'envVar',
  // --- LOCAL FORK ADDITION (Phase 2.4.2: inline API key entry) ---
  'apiKey',
  // --- END LOCAL FORK ADDITION ---
  // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
  'wireFormat',
  // --- END LOCAL FORK ADDITION ---
];

function AddScreen({
  registry,
  onSubmit,
  onCancel,
}: AddScreenProps): React.JSX.Element {
  const idBuf = useTextBuffer({
    initialText: '',
    viewport: { width: 60, height: 1 },
    singleLine: true,
  });
  const nameBuf = useTextBuffer({
    initialText: '',
    viewport: { width: 60, height: 1 },
    singleLine: true,
  });
  const urlBuf = useTextBuffer({
    initialText: '',
    viewport: { width: 60, height: 1 },
    singleLine: true,
  });
  const modelBuf = useTextBuffer({
    initialText: '',
    viewport: { width: 60, height: 1 },
    singleLine: true,
  });
  const envBuf = useTextBuffer({
    initialText: '',
    viewport: { width: 60, height: 1 },
    singleLine: true,
  });
  // --- LOCAL FORK ADDITION (Phase 2.4.2: inline API key entry) ---
  const apiKeyBuf = useTextBuffer({
    initialText: '',
    viewport: { width: 60, height: 1 },
    singleLine: true,
  });
  // --- END LOCAL FORK ADDITION ---

  const [focusIndex, setFocusIndex] = useState(0);
  const [error, setError] = useState<string | undefined>();
  // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
  const [wireFormat, setWireFormat] = useState<
    'openai-chat' | 'openai-responses'
  >('openai-chat');
  // --- END LOCAL FORK ADDITION ---

  const fieldName = ADD_FIELDS[focusIndex];

  const advance = useCallback(() => {
    setFocusIndex((i) => (i < ADD_FIELDS.length - 1 ? i + 1 : i));
  }, []);

  const retreat = useCallback(() => {
    setFocusIndex((i) => (i > 0 ? i - 1 : 0));
  }, []);

  const handleSubmit = useCallback(() => {
    const id = idBuf.text.trim();
    const displayName = nameBuf.text.trim();
    const baseUrl = urlBuf.text.trim();
    const defaultModel = modelBuf.text.trim();
    const apiKeyEnvVar = envBuf.text.trim();

    const idErr = validateCustomProviderId(id);
    if (idErr) {
      setError(idErr);
      setFocusIndex(0);
      return;
    }
    if (id in registry) {
      setError(`Provider id '${id}' already exists. Pick a different id.`);
      setFocusIndex(0);
      return;
    }
    if (!baseUrl) {
      setError(
        'Base URL is required (e.g. http://127.0.0.1:8000/v1/chat/completions).',
      );
      setFocusIndex(2);
      return;
    }
    try {
      void new URL(baseUrl);
    } catch {
      setError(`Base URL '${baseUrl}' is not a valid URL.`);
      setFocusIndex(2);
      return;
    }
    if (apiKeyEnvVar && !/^[A-Z][A-Z0-9_]*$/.test(apiKeyEnvVar)) {
      setError(
        `Env-var name '${apiKeyEnvVar}' must be UPPER_SNAKE_CASE (e.g. OPENAI_API_KEY).`,
      );
      setFocusIndex(4);
      return;
    }

    const def: CustomProviderDefinition = {
      displayName: displayName || id,
      baseUrl,
      // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
      wireFormat,
      // --- END LOCAL FORK ADDITION ---
    };
    if (defaultModel) def.defaultModel = defaultModel;
    if (apiKeyEnvVar) def.apiKeyEnvVar = apiKeyEnvVar;
    setError(undefined);
    // --- LOCAL FORK ADDITION (Phase 2.4.2: inline API key entry) ---
    const inlineApiKey = apiKeyBuf.text.trim() || undefined;
    onSubmit(id, def, inlineApiKey);
    // --- END LOCAL FORK ADDITION ---
  }, [
    idBuf,
    nameBuf,
    urlBuf,
    modelBuf,
    envBuf,
    // --- LOCAL FORK ADDITION (Phase 2.4.2: inline API key entry) ---
    apiKeyBuf,
    // --- END LOCAL FORK ADDITION ---
    registry,
    onSubmit,
    // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
    wireFormat,
    // --- END LOCAL FORK ADDITION ---
  ]);

  // Per-field submit on Enter advances to the next field, or commits if
  // already on the last one.
  const onFieldSubmit = useCallback(() => {
    if (focusIndex >= ADD_FIELDS.length - 1) {
      handleSubmit();
    } else {
      advance();
    }
  }, [focusIndex, handleSubmit, advance]);

  // Tab / Shift+Tab cycle between fields. Enter on the last field commits.
  useKeypress(
    (key: Key) => {
      if (key.name === 'tab' && key.shift) {
        retreat();
        return true;
      }
      if (key.name === 'tab') {
        advance();
        return true;
      }
      // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
      // Left / Right toggles the wireFormat radio when it's focused.
      // Space also toggles for keyboards without arrow keys. Enter
      // commits the form (no text buffer here, so the regular
      // FieldRow onSubmit wiring doesn't fire). Esc cancels via the
      // outer dialog handler.
      if (fieldName === 'wireFormat') {
        if (
          key.name === 'left' ||
          key.name === 'right' ||
          key.name === 'space'
        ) {
          setWireFormat((wf) =>
            wf === 'openai-chat' ? 'openai-responses' : 'openai-chat',
          );
          return true;
        }
        if (key.name === 'return') {
          handleSubmit();
          return true;
        }
      }
      // --- END LOCAL FORK ADDITION ---
      return false;
    },
    { isActive: true, priority: true },
  );

  const fieldLabel = (f: AddField): string => {
    switch (f) {
      case 'id':
        return 'Provider id (kebab-case, e.g. my-vllm)';
      case 'displayName':
        return 'Display name (defaults to id)';
      case 'baseUrl':
        return 'Base URL (full /v1/chat/completions URL)';
      case 'defaultModel':
        return 'Default model (optional)';
      case 'envVar':
        return 'Env var name for API key (optional, e.g. OPENROUTER_API_KEY)';
      // --- LOCAL FORK ADDITION (Phase 2.4.2: inline API key entry) ---
      case 'apiKey':
        return 'API key — paste here to save to keychain now (optional)';
      // --- END LOCAL FORK ADDITION ---
      // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
      case 'wireFormat':
        return 'Wire format (\u2190/\u2192 to toggle)';
      // --- END LOCAL FORK ADDITION ---
      default:
        return f;
    }
  };

  return (
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.border.default}
        paddingX={1}
        marginBottom={1}
      >
        <Text bold>{'Add custom OpenAI-compat provider'}</Text>
        <Text color={theme.text.secondary}>
          {
            'Tab / Shift+Tab to move between fields, Enter to advance/submit, Esc to cancel.'
          }
        </Text>
      </Box>
      <Box flexDirection="column" paddingX={1}>
        <FieldRow
          label={fieldLabel('id')}
          isFocused={fieldName === 'id'}
          buffer={idBuf}
          placeholder="my-vllm"
          onSubmit={onFieldSubmit}
          onCancel={onCancel}
        />
        <FieldRow
          label={fieldLabel('displayName')}
          isFocused={fieldName === 'displayName'}
          buffer={nameBuf}
          placeholder="My vLLM"
          onSubmit={onFieldSubmit}
          onCancel={onCancel}
        />
        <FieldRow
          label={fieldLabel('baseUrl')}
          isFocused={fieldName === 'baseUrl'}
          buffer={urlBuf}
          placeholder="http://127.0.0.1:8000/v1/chat/completions"
          onSubmit={onFieldSubmit}
          onCancel={onCancel}
        />
        <FieldRow
          label={fieldLabel('defaultModel')}
          isFocused={fieldName === 'defaultModel'}
          buffer={modelBuf}
          placeholder="(server picks if blank)"
          onSubmit={onFieldSubmit}
          onCancel={onCancel}
        />
        <FieldRow
          label={fieldLabel('envVar')}
          isFocused={fieldName === 'envVar'}
          buffer={envBuf}
          placeholder="e.g. OPENROUTER_API_KEY  (blank if unused)"
          onSubmit={onFieldSubmit}
          onCancel={onCancel}
        />
        {/* --- LOCAL FORK ADDITION (Phase 2.4.2: inline API key entry) --- */}
        <FieldRow
          label={fieldLabel('apiKey')}
          isFocused={fieldName === 'apiKey'}
          buffer={apiKeyBuf}
          placeholder="sk-or-...  (blank to skip)"
          onSubmit={onFieldSubmit}
          onCancel={onCancel}
        />
        {/* --- END LOCAL FORK ADDITION --- */}
        {/* --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) --- */}
        <Box flexDirection="column" marginBottom={1}>
          <Text
            color={
              fieldName === 'wireFormat'
                ? theme.text.accent
                : theme.text.secondary
            }
          >
            {(fieldName === 'wireFormat' ? '\u25b8 ' : '  ') +
              fieldLabel('wireFormat')}
          </Text>
          <Box paddingLeft={2}>
            <Text
              color={
                wireFormat === 'openai-chat'
                  ? theme.text.accent
                  : theme.text.secondary
              }
            >
              {wireFormat === 'openai-chat' ? '(\u2022) ' : '( ) '}
              {'openai-chat (Chat Completions)'}
            </Text>
          </Box>
          <Box paddingLeft={2}>
            <Text
              color={
                wireFormat === 'openai-responses'
                  ? theme.text.accent
                  : theme.text.secondary
              }
            >
              {wireFormat === 'openai-responses' ? '(\u2022) ' : '( ) '}
              {'openai-responses (Responses API)'}
            </Text>
          </Box>
        </Box>
        {/* --- END LOCAL FORK ADDITION --- */}
      </Box>
      {error ? (
        <Box paddingX={1} marginTop={1}>
          <Text color={theme.status.error}>{error}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

interface FieldRowProps {
  label: string;
  isFocused: boolean;
  buffer: ReturnType<typeof useTextBuffer>;
  placeholder: string;
  onSubmit: () => void;
  onCancel: () => void;
}

function FieldRow({
  label,
  isFocused,
  buffer,
  placeholder,
  onSubmit,
  onCancel,
}: FieldRowProps): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={isFocused ? theme.text.accent : theme.text.secondary}>
        {(isFocused ? '\u25b8 ' : '  ') + label}
      </Text>
      <Box paddingLeft={2}>
        <TextInput
          buffer={buffer}
          placeholder={placeholder}
          focus={isFocused}
          onSubmit={onSubmit}
          onCancel={onCancel}
        />
      </Box>
    </Box>
  );
}

// ---- RemoveScreen --------------------------------------------------------

interface RemoveScreenProps {
  customProviders: Readonly<Record<string, CustomProviderDefinition>>;
  registry: Record<string, ProviderDefinition>;
  onConfirm: (id: string) => void;
  onCancel: () => void;
}

function RemoveScreen({
  customProviders,
  registry,
  onConfirm,
  onCancel: _onCancel,
}: RemoveScreenProps): React.JSX.Element {
  const ids = useMemo(() => Object.keys(customProviders), [customProviders]);
  const [selected, setSelected] = useState<string | undefined>();

  if (ids.length === 0) {
    return (
      <StatusFrame
        title="Remove custom provider"
        subtitle="No custom providers to remove. Use 'Add provider' first."
        color="info"
      />
    );
  }

  if (selected) {
    return (
      <ConfirmRemove
        id={selected}
        def={registry[selected]}
        onConfirm={() => onConfirm(selected)}
        onCancel={() => setSelected(undefined)}
      />
    );
  }

  const radioItems = ids.map((id) => {
    const def = registry[id];
    return {
      value: id,
      key: id,
      title: `${def?.displayName ?? id} (${id})`,
      description: def?.defaultBaseUrl,
    };
  });

  return (
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.border.default}
        paddingX={1}
        marginBottom={1}
      >
        <Text bold>{'Remove custom provider'}</Text>
        <Text color={theme.text.secondary}>
          {'Built-in providers (gemini-*, openai) are not removable. ' +
            'Esc to go back without removing.'}
        </Text>
      </Box>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.border.default}
        paddingX={1}
      >
        <DescriptiveRadioButtonSelect<string>
          items={radioItems}
          initialIndex={0}
          onSelect={(id) => setSelected(id)}
          showNumbers={true}
          maxItemsToShow={MAX_ITEMS_TO_SHOW}
        />
      </Box>
      <Box paddingX={1} marginTop={1}>
        <Text color={theme.text.secondary}>
          {`Discard with: just press Esc. Cancel from the next screen too if needed.`}
        </Text>
      </Box>
    </Box>
  );
}

interface ConfirmRemoveProps {
  id: string;
  def: ProviderDefinition | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmRemove({
  id,
  def,
  onConfirm,
  onCancel,
}: ConfirmRemoveProps): React.JSX.Element {
  const items = [
    {
      value: 'cancel' as const,
      key: 'cancel',
      title: 'Cancel',
      description: 'Keep the provider',
    },
    {
      value: 'confirm' as const,
      key: 'confirm',
      title: 'Yes, remove this provider',
      description: `Drops ${id} and any saved API key`,
    },
  ];
  return (
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.status.warning}
        paddingX={1}
        marginBottom={1}
      >
        <Text bold>{`Remove '${id}' \u2014 confirm`}</Text>
        {def ? (
          <Text>
            {'  '}
            {def.displayName}{' '}
            <Text
              color={theme.text.secondary}
            >{`(${def.defaultBaseUrl})`}</Text>
          </Text>
        ) : null}
        <Text color={theme.text.secondary}>
          {
            '  This deletes the provider entry and clears any keychain credential.'
          }
        </Text>
      </Box>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.border.default}
        paddingX={1}
      >
        <DescriptiveRadioButtonSelect
          items={items}
          initialIndex={0}
          onSelect={(v) => (v === 'confirm' ? onConfirm() : onCancel())}
          showNumbers={true}
          maxItemsToShow={MAX_ITEMS_TO_SHOW}
        />
      </Box>
    </Box>
  );
}

// ---- EditScreen (Phase 2.1/2.2 settings sheet, lifted out unchanged) -----

function isProviderSubKey(activeId: string, key: string): boolean {
  const prefix = `providers.${activeId}.`;
  return key.startsWith(prefix);
}

function getProviderDialogSettingKeys(
  activeId: string,
  registry: Record<string, ProviderDefinition>,
): string[] {
  const prefix = `providers.${activeId}.`;
  const allKeys = Object.keys(getFlattenedSchema()).filter((k) =>
    k.startsWith(prefix),
  );
  // The provider definition declares which sub-keys are meaningful for
  // this wire format (Gemini exposes none in Phase 2.3, OpenAI-compat
  // exposes the full sheet). Filter the flattened schema by that
  // allowlist so the dialog renders the right size for each provider.
  const def = registry[activeId];
  if (def?.validSettingKeys && def.validSettingKeys.length > 0) {
    const allowed = new Set(def.validSettingKeys);
    return allKeys.filter((fullKey) => {
      const leaf = fullKey.slice(prefix.length).split('.')[0];
      return allowed.has(leaf);
    });
  }
  if (def && def.validSettingKeys && def.validSettingKeys.length === 0) {
    // Phase 2.3: Gemini providers are intentionally empty. Render no
    // editable rows so the user just sees the status panel.
    return [];
  }
  return allKeys;
}

/**
 * Snapshot per-scope values for restart-required `providers.<id>.*` keys
 * at mount time. Today nothing in the providers block requires restart, so
 * this returns an empty map — but we keep the plumbing so a future
 * addition (e.g. a network adapter) can flip its flag and the dialog
 * inherits the "press r to restart" affordance.
 */
function snapshotProviderRestartRequired(
  settings: SettingsState,
  activeId: string,
): Map<string, Map<string, string>> {
  const snapshot = new Map<string, Map<string, string>>();
  const scopes: Array<[string, Settings]> = [
    ['User', settings.user.settings],
    ['Workspace', settings.workspace.settings],
    ['System', settings.system.settings],
  ];
  for (const key of getDialogRestartRequiredSettings()) {
    if (!isProviderSubKey(activeId, key)) continue;
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

// --- LOCAL FORK ADDITION (Phase 2.3.1: Set API key screen) ---
// Single-field screen that saves an API key to the OS keychain via
// saveProviderApiKey(). Displayed when the active provider declares
// `requiresApiKey: true`. The key is treated as a password:
//   - It is NOT logged or stored in settings.json.
//   - The terminal is advised to clear scrollback.
//   - On submit it writes to keychain (same storage used by
//     `/provider set <id> key <api-key>` slash command).

interface SetKeyScreenProps {
  providerId: string;
  providerDef: ProviderDefinition | undefined;
  onDone: (statusMessage?: string) => void;
  onCancel: () => void;
}

function SetKeyScreen({
  providerId,
  providerDef,
  onDone,
  onCancel,
}: SetKeyScreenProps): React.JSX.Element {
  const keyBuf = useTextBuffer({
    initialText: '',
    viewport: { width: 60, height: 1 },
    singleLine: true,
  });
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  const handleSubmit = useCallback(() => {
    const key = keyBuf.text.trim();
    if (!key) {
      setError('API key cannot be empty. Press Esc to cancel.');
      return;
    }
    setSaving(true);
    saveProviderApiKey(providerId, key)
      .then(() => {
        onDone(
          `API key for '${providerId}' saved to keychain. ` +
            'Clear your terminal history (Ctrl+L) if you pasted it.',
        );
      })
      .catch((err: unknown) => {
        setSaving(false);
        setError(
          err instanceof Error
            ? err.message
            : 'Unknown keychain error. Try setting the env var instead.',
        );
      });
  }, [keyBuf, providerId, onDone]);

  useKeypress(
    (key: Key) => {
      if (key.name === 'escape') {
        onCancel();
        return true;
      }
      if (key.name === 'return') {
        handleSubmit();
        return true;
      }
      return false;
    },
    { isActive: !saving, priority: true },
  );

  const displayName = providerDef?.displayName ?? providerId;
  const envVar = providerDef?.apiKeyEnvVar ?? '';
  const envAlreadySet = envVar ? !!process.env[envVar]?.trim() : false;

  return (
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.border.default}
        paddingX={1}
        marginBottom={1}
      >
        <Text bold>{`Set API key \u2014 ${displayName}`}</Text>
        <Text color={theme.text.secondary}>
          {'  Key is saved to the OS keychain, not to settings.json. ' +
            'Clear your terminal (Ctrl+L) after pasting.'}
        </Text>
        {envAlreadySet && (
          <Text color={theme.status.warning}>
            {`  Note: $${envVar} is currently set in your shell and will take priority over the keychain.`}
          </Text>
        )}
        {error && <Text color={theme.status.error}>{`  \u2717 ${error}`}</Text>}
      </Box>
      <FieldRow
        label="API Key"
        isFocused={!saving}
        buffer={keyBuf}
        placeholder="paste your key here, then press Enter"
        onSubmit={handleSubmit}
        onCancel={onCancel}
      />
      <Box marginTop={1} paddingLeft={2}>
        <Text color={theme.text.secondary}>
          {'Enter to save \u2022 Esc to cancel'}
        </Text>
      </Box>
    </Box>
  );
}
// --- END LOCAL FORK ADDITION ---

interface EditScreenProps {
  onClose: () => void;
  // --- LOCAL FORK ADDITION (Phase 2.4.4: in-edit API key shortcut) ---
  // Invoked when the user presses 'k' inside the edit screen for a
  // provider that requires an API key. The parent dialog routes to the
  // SetKeyScreen and returns here when the user is done.
  onRequestSetKey: () => void;
  // --- END LOCAL FORK ADDITION ---
}

function EditScreen({
  onClose,
  // --- LOCAL FORK ADDITION (Phase 2.4.4: in-edit API key shortcut) ---
  onRequestSetKey,
  // --- END LOCAL FORK ADDITION ---
}: EditScreenProps): React.JSX.Element {
  const { settings, setSetting } = useSettingsStore();
  const config = useConfig();

  const registry = useMemo(() => config.getProviderRegistry(), [config]);
  const activeId = config.getActiveProviderId() ?? 'openai';
  const providerDef = registry[activeId];

  // Phase 2.3: ensure `providers.<customId>.*` schema aliases are
  // registered before any key/definition lookup. This is idempotent —
  // built-in ids and already-aliased keys are skipped — so calling it on
  // every render is safe. Without it, the dialog renders "No matches
  // found" for every custom provider (the schema only ships
  // `providers.openai.*` / `providers.openai-responses.*` declarations).
  // Phase 2.4: pass the full custom-provider record so the alias source
  // block is selected per-entry by wireFormat (openai-chat vs.
  // openai-responses).
  registerCustomProviderSchemaAliases(config.getCustomProviders() ?? {});

  const [selectedScope, setSelectedScope] = useState<LoadableSettingScope>(
    SettingScope.User,
  );

  const [activeRestartRequiredSettings] = useState(() =>
    snapshotProviderRestartRequired(settings, activeId),
  );

  const [hotReloadError, setHotReloadError] = useState<string | undefined>();

  type PickerState =
    | { mode: 'hidden' }
    | { mode: 'loading' }
    | { mode: 'error'; message: string }
    | { mode: 'ready'; models: ProviderModelInfo[] };
  const [pickerState, setPickerState] = useState<PickerState>({
    mode: 'hidden',
  });
  const modelKey = `providers.${activeId}.model`;

  const openModelPicker = useCallback(async () => {
    if (providerDef?.wireFormat === 'gemini') {
      setPickerState({
        mode: 'error',
        message:
          'Model picker is only available for OpenAI-compat providers. ' +
          'Type the Gemini model name directly in the Model field.',
      });
      return;
    }
    setPickerState({ mode: 'loading' });
    try {
      let apiKey = '';
      if (providerDef?.requiresApiKey ?? true) {
        const k = await resolveProviderApiKey(activeId);
        if (!k) {
          setPickerState({
            mode: 'error',
            message: `No API key — run /provider set ${activeId} key <api-key>`,
          });
          return;
        }
        apiKey = k;
      }
      const override = config.getProviderConfig(activeId);
      let baseUrl = providerDef?.defaultBaseUrl ?? '';
      try {
        const r = resolveProvider(
          activeId,
          override,
          config.getCustomProviders(),
        );
        baseUrl = r.baseUrl;
      } catch {
        /* use registry default */
      }
      const models = await fetchProviderModels(baseUrl, apiKey);
      if (models.length === 0) {
        setPickerState({
          mode: 'error',
          message: 'Could not retrieve model list. Check API key and network.',
        });
      } else {
        setPickerState({ mode: 'ready', models });
      }
    } catch (err: unknown) {
      setPickerState({
        mode: 'error',
        message:
          err instanceof Error ? err.message : 'Unknown error fetching models',
      });
    }
  }, [activeId, config, providerDef]);

  const applyHotReload = useCallback(
    (key: string, newValue: SettingsValue) => {
      const fieldName = key.split('.').pop();
      if (!fieldName) return;
      const patch: ProviderInstanceConfig = {};
      switch (fieldName) {
        case 'model':
          if (typeof newValue === 'string' || newValue === undefined) {
            patch.model = newValue ?? '';
          }
          break;
        case 'baseUrl':
          if (typeof newValue === 'string' || newValue === undefined) {
            patch.baseUrl = newValue ?? '';
          }
          break;
        case 'promptMode':
          if (typeof newValue === 'string' || newValue === undefined) {
            patch.promptMode = newValue ?? '';
          }
          break;
        case 'enableTools':
          if (typeof newValue === 'boolean' || newValue === undefined) {
            patch.enableTools = newValue ?? true;
          }
          break;
        case 'contextLimit':
          if (typeof newValue === 'number' || newValue === undefined) {
            patch.contextLimit = newValue;
          }
          break;
        case 'compressionThreshold':
          if (typeof newValue === 'number' || newValue === undefined) {
            patch.compressionThreshold = newValue;
          }
          break;
        case 'preserveFraction':
          if (typeof newValue === 'number' || newValue === undefined) {
            patch.preserveFraction = newValue;
          }
          break;
        case 'timeout':
          if (typeof newValue === 'number' || newValue === undefined) {
            patch.timeout = newValue;
          }
          break;
        // --- LOCAL FORK ADDITION (Phase 2.3.1: per-provider sampler) ---
        case 'temperature':
          if (typeof newValue === 'number' || newValue === undefined) {
            patch.temperature = newValue;
          }
          break;
        // --- END LOCAL FORK ADDITION ---
        // --- LOCAL FORK ADDITION (Phase 2.3.2: per-provider tool-call parser) ---
        case 'toolCallParsing':
          if (
            newValue === 'strict' ||
            newValue === 'lenient' ||
            newValue === 'loose' ||
            newValue === undefined
          ) {
            patch.toolCallParsing = newValue;
          }
          break;
        // --- END LOCAL FORK ADDITION ---
        // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
        case 'reasoningEffort':
          if (
            newValue === 'minimal' ||
            newValue === 'low' ||
            newValue === 'medium' ||
            newValue === 'high' ||
            newValue === undefined
          ) {
            patch.reasoningEffort = newValue;
          }
          break;
        case 'useResponseChaining':
          if (typeof newValue === 'boolean' || newValue === undefined) {
            patch.useResponseChaining = newValue ?? false;
          }
          break;
        // --- END LOCAL FORK ADDITION ---
        // --- LOCAL FORK ADDITION (Phase 2.4.7: system-prompt override) ---
        case 'systemPromptOverride':
          if (typeof newValue === 'string' || newValue === undefined) {
            patch.systemPromptOverride = newValue;
          }
          break;
        // --- END LOCAL FORK ADDITION ---
        default:
          return;
      }
      setHotReloadError(undefined);
      config
        .refreshProviderConfig({ setConfig: { id: activeId, patch } })
        .catch((err: unknown) => {
          setHotReloadError(
            err instanceof Error ? err.message : 'unknown refresh error',
          );
        });
    },
    [config, activeId],
  );

  const overrides = config.getProviderConfig(activeId);
  let resolvedModel = '';
  let resolvedBaseUrl = '';
  let resolvedContext = '';
  let resolvedError = '';
  try {
    const r = resolveProvider(activeId, overrides, config.getCustomProviders());
    resolvedModel = r.model;
    resolvedBaseUrl = r.baseUrl;
    resolvedContext = `${r.contextLimit.toLocaleString()} tokens`;
  } catch (err) {
    resolvedError =
      err instanceof Error
        ? `Config error: ${err.message}`
        : 'Config error: unknown';
  }

  const [keyState, setKeyState] = useState<string>('checking…');
  useEffect(() => {
    let cancelled = false;
    if (!providerDef) {
      setKeyState('unknown provider');
      return;
    }
    if (providerDef.wireFormat === 'gemini') {
      if (providerDef.authType === 'oauth-personal') {
        setKeyState('OAuth — run /auth to sign in or switch account');
        return;
      }
      if (providerDef.requiresApiKey) {
        const envVal = process.env[providerDef.apiKeyEnvVar]?.trim();
        setKeyState(
          envVal
            ? `$${providerDef.apiKeyEnvVar} (set)`
            : `$${providerDef.apiKeyEnvVar} (not set — run /auth)`,
        );
        return;
      }
      setKeyState('Vertex AI / ADC — run /auth to configure');
      return;
    }
    // --- LOCAL FORK ADDITION (Phase 2.4.5: widened API key affordance) ---
    // Even when the registry says `requiresApiKey: false`, an OpenAI-compat
    // custom provider might still legitimately need a key (OpenRouter,
    // Together, Groq, ...). Probe the keychain regardless so the header
    // reports the truth instead of a misleading "not required". The
    // request-side header logic already only attaches Authorization when
    // a key is present, so genuinely-no-auth local servers stay quiet.
    if (!providerDef.requiresApiKey) {
      loadProviderApiKey(activeId)
        .then((v) => {
          if (cancelled) return;
          setKeyState(
            v
              ? 'in keychain'
              : 'not set (no auth header sent — set if your endpoint needs one)',
          );
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setKeyState(
            `keychain error: ${err instanceof Error ? err.message : 'unknown'}`,
          );
        });
      return () => {
        cancelled = true;
      };
    }
    // --- END LOCAL FORK ADDITION ---
    const envVal = process.env[providerDef.apiKeyEnvVar]?.trim();
    if (envVal) {
      setKeyState(`from $${providerDef.apiKeyEnvVar}`);
      return;
    }
    loadProviderApiKey(activeId)
      .then((v) => {
        if (cancelled) return;
        setKeyState(
          v ? 'in keychain' : `not set — run /provider set ${activeId} key`,
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setKeyState(
          `keychain error: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, providerDef]);

  const items: SettingsDialogItem[] = useMemo(() => {
    const scopeSettings = settings.forScope(selectedScope).settings;
    const mergedSettings = settings.merged;
    const keys = getProviderDialogSettingKeys(activeId, registry);
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
  }, [selectedScope, settings, activeId, registry]);

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
    const allKeys = getProviderDialogSettingKeys(activeId, registry);
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
  }, [selectedScope, settings, activeId, registry]);

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
        if (typeof currentValue !== 'boolean') return;
        newValue = !currentValue;
      } else if (definition?.type === 'enum' && definition.options) {
        const options = definition.options;
        if (options.length === 0) return;
        const currentIndex = options.findIndex(
          (opt) => opt.value === currentValue,
        );
        newValue =
          currentIndex !== -1 && currentIndex < options.length - 1
            ? options[currentIndex + 1].value
            : options[0].value;
      } else {
        return;
      }
      setSetting(selectedScope, key, newValue);
      applyHotReload(key, newValue);
    },
    [settings, selectedScope, setSetting, applyHotReload],
  );

  const handleEditCommit = useCallback(
    (key: string, newValue: string, _item: SettingsDialogItem) => {
      const definition = getSettingDefinition(key);
      const type: SettingsType = definition?.type ?? 'string';
      const parsed = parseEditedValue(type, newValue);
      if (parsed === null) return;
      setSetting(selectedScope, key, parsed);
      applyHotReload(key, parsed);
    },
    [selectedScope, setSetting, applyHotReload],
  );

  const handleItemClear = useCallback(
    (key: string, _item: SettingsDialogItem) => {
      setSetting(selectedScope, key, undefined);
      const definition = getSettingDefinition(key);
      const fallback = definition?.default ?? '';
      applyHotReload(key, fallback);
    },
    [selectedScope, setSetting, applyHotReload],
  );

  const handleClose = useCallback(() => onClose(), [onClose]);

  const handleKeyPress = useCallback(
    (
      key: { sequence?: string },
      currentItem: SettingsDialogItem | undefined,
    ): boolean => {
      if (pickerState.mode !== 'hidden' && key.sequence === '\x1B') {
        setPickerState({ mode: 'hidden' });
        return true;
      }
      if (
        pickerState.mode === 'hidden' &&
        currentItem?.key === modelKey &&
        (key.sequence === '\r' || key.sequence === '\n')
      ) {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        openModelPicker();
        return true;
      }
      if (showRestartPrompt && key.sequence === 'r') {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        relaunchApp();
        return true;
      }
      // --- LOCAL FORK ADDITION (Phase 2.4.4: in-edit API key shortcut,
      //     widened in Phase 2.4.5) ---
      // 'k' opens the SetKeyScreen for the active provider whenever the
      // wire format is OpenAI-compat (chat or responses), or when an
      // upstream Gemini built-in declares requiresApiKey. The earlier
      // gate keyed only on requiresApiKey === true, which hid the
      // shortcut for custom providers added via `/provider add`
      // without a `--env` flag — even when the user genuinely needs
      // to save a key (OpenRouter, Together, Groq, Fireworks, ...).
      // The model picker is gated by pickerState.mode so 'k' doesn't
      // fire while the picker is open.
      const canSetKey =
        providerDef?.wireFormat === 'openai-chat' ||
        providerDef?.wireFormat === 'openai-responses' ||
        !!providerDef?.requiresApiKey;
      if (pickerState.mode === 'hidden' && canSetKey && key.sequence === 'k') {
        onRequestSetKey();
        return true;
      }
      // --- END LOCAL FORK ADDITION ---
      return false;
    },
    [
      showRestartPrompt,
      pickerState.mode,
      modelKey,
      openModelPicker,
      // --- LOCAL FORK ADDITION (Phase 2.4.4: in-edit API key shortcut) ---
      providerDef,
      onRequestSetKey,
      // --- END LOCAL FORK ADDITION ---
    ],
  );

  const hasWorkspace = settings.workspace.path !== undefined;

  const pickerItems = useMemo(() => {
    if (pickerState.mode !== 'ready') return [];
    return pickerState.models.map((m) => ({
      value: m.id,
      key: m.id,
      title: m.id,
      description: m.ownedBy ? `owned by ${m.ownedBy}` : undefined,
    }));
  }, [pickerState]);

  const pickerInitialIndex = useMemo(() => {
    if (pickerState.mode !== 'ready') return 0;
    const idx = pickerState.models.findIndex((m) => m.id === resolvedModel);
    return idx !== -1 ? idx : 0;
  }, [pickerState, resolvedModel]);

  const handlePickerSelect = useCallback(
    (modelId: string) => {
      setSetting(selectedScope, modelKey, modelId);
      applyHotReload(modelKey, modelId);
      setPickerState({ mode: 'hidden' });
    },
    [selectedScope, modelKey, setSetting, applyHotReload],
  );

  return (
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.border.default}
        paddingX={1}
        marginBottom={1}
      >
        <Text bold>
          {'Provider: ' + (providerDef?.displayName ?? activeId)}
        </Text>
        {resolvedError ? (
          <Text color={theme.status.error}>{'  ' + resolvedError}</Text>
        ) : (
          <>
            <Text>{'  model: ' + resolvedModel}</Text>
            {providerDef?.wireFormat !== 'gemini' && resolvedBaseUrl && (
              <Text>{'  baseUrl: ' + resolvedBaseUrl}</Text>
            )}
            <Text>{'  context: ' + resolvedContext}</Text>
          </>
        )}
        {/* --- LOCAL FORK ADDITION (Phase 2.4.5: widened API key affordance) --- */}
        {(providerDef?.wireFormat === 'openai-chat' ||
          providerDef?.wireFormat === 'openai-responses' ||
          providerDef?.requiresApiKey) &&
          providerDef?.wireFormat !== 'gemini' && (
            <>
              <Text>{'  api key: ' + keyState}</Text>
              <Text color={theme.text.secondary}>
                {'           press [k] to set or replace the API key'}
              </Text>
            </>
          )}
        {/* --- END LOCAL FORK ADDITION --- */}
        {providerDef?.wireFormat === 'gemini' && (
          <Text>{'  auth: ' + keyState}</Text>
        )}
      </Box>

      {pickerState.mode === 'loading' && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.border.default}
          paddingX={1}
        >
          <Text bold>
            {'Select model · ' + (providerDef?.displayName ?? activeId)}
          </Text>
          <Text color={theme.text.secondary}>{'  Fetching models…'}</Text>
        </Box>
      )}
      {pickerState.mode === 'error' && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.status.error}
          paddingX={1}
        >
          <Text bold>
            {'Select model · ' + (providerDef?.displayName ?? activeId)}
          </Text>
          <Text color={theme.status.error}>{'  ' + pickerState.message}</Text>
          <Text color={theme.text.secondary}>{'  Press Esc to go back.'}</Text>
        </Box>
      )}
      {pickerState.mode === 'ready' && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.border.default}
          paddingX={1}
        >
          <Text bold>
            {'Select model · ' + (providerDef?.displayName ?? activeId)}
          </Text>
          <Text color={theme.text.secondary}>
            {'  ' +
              pickerItems.length +
              ' chat-capable models  (Esc to cancel)'}
          </Text>
          <Box marginTop={1}>
            <DescriptiveRadioButtonSelect
              items={pickerItems}
              initialIndex={pickerInitialIndex}
              onSelect={handlePickerSelect}
              showNumbers={true}
              maxItemsToShow={MAX_ITEMS_TO_SHOW}
            />
          </Box>
        </Box>
      )}

      {pickerState.mode === 'hidden' && (
        <BaseSettingsDialog
          title={`Provider · ${providerDef?.displayName ?? activeId}`}
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
                        Changes that require a restart have been modified. Press
                        r to exit and apply changes now.
                      </Text>
                    ),
                    height: 1,
                  }
                : {
                    content: (
                      <Text color={theme.text.secondary}>
                        Tip: Enter on Model browses the API model list
                        {providerDef?.wireFormat === 'openai-chat' ||
                        providerDef?.wireFormat === 'openai-responses' ||
                        providerDef?.requiresApiKey
                          ? ' \u2022 [k] sets API key'
                          : ''}
                        {' \u2022 Esc returns to menu'}
                      </Text>
                    ),
                    height: 1,
                  }
          }
        />
      )}
    </Box>
  );
}

// Avoid the "unused" warning for RadioButtonSelect — it's exported via
// barrel modules elsewhere but referenced here only by the simpler
// DescriptiveRadioButtonSelect; keeping the import documents the
// available primitive for future screens.
void RadioButtonSelect;
