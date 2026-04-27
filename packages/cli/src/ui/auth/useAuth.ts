/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useCallback } from 'react';
import type { LoadedSettings } from '../../config/settings.js';
import {
  AuthType,
  type Config,
  loadApiKey,
  debugLogger,
  isAccountSuspendedError,
  ProjectIdRequiredError,
  getProvider,
} from '@google/gemini-cli-core';
import { getErrorMessage } from '@google/gemini-cli-core';
import { AuthState } from '../types.js';
import { validateAuthMethod } from '../../config/auth.js';

export function validateAuthMethodWithSettings(
  authType: AuthType,
  settings: LoadedSettings,
): string | null {
  const enforcedType = settings.merged.security.auth.enforcedType;
  if (enforcedType && enforcedType !== authType) {
    return `Authentication is enforced to be ${enforcedType}, but you are currently using ${authType}.`;
  }
  if (settings.merged.security.auth.useExternal) {
    return null;
  }
  // If using Gemini API key, we don't validate it here as we might need to prompt for it.
  if (authType === AuthType.USE_GEMINI) {
    return null;
  }
  return validateAuthMethod(authType);
}

import type { AccountSuspensionInfo } from '../contexts/UIStateContext.js';

export const useAuthCommand = (
  settings: LoadedSettings,
  config: Config,
  initialAuthError: string | null = null,
  initialAccountSuspensionInfo: AccountSuspensionInfo | null = null,
) => {
  const [authState, setAuthState] = useState<AuthState>(
    initialAuthError ? AuthState.Updating : AuthState.Unauthenticated,
  );

  const [authError, setAuthError] = useState<string | null>(initialAuthError);
  const [accountSuspensionInfo, setAccountSuspensionInfo] =
    useState<AccountSuspensionInfo | null>(initialAccountSuspensionInfo);
  const [apiKeyDefaultValue, setApiKeyDefaultValue] = useState<
    string | undefined
  >(undefined);

  const onAuthError = useCallback(
    (error: string | null) => {
      setAuthError(error);
      if (error) {
        setAuthState(AuthState.Updating);
      }
    },
    [setAuthError, setAuthState],
  );

  const reloadApiKey = useCallback(async () => {
    const envKey = process.env['GEMINI_API_KEY'];
    if (envKey !== undefined) {
      setApiKeyDefaultValue(envKey);
      return envKey;
    }

    const storedKey = (await loadApiKey()) ?? '';
    setApiKeyDefaultValue(storedKey);
    return storedKey;
  }, []);

  useEffect(() => {
    if (authState === AuthState.AwaitingApiKeyInput) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      reloadApiKey();
    }
  }, [authState, reloadApiKey]);

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    (async () => {
      if (authState !== AuthState.Unauthenticated) {
        return;
      }

      // --- LOCAL FORK ADDITION (Phase 2.2: unified provider auto-auth) ---
      // ONE auto-auth path covers every backend the registry knows about:
      // localhost OpenAI-compat servers, hosted OpenAI-compat providers,
      // AND Gemini OAuth/API-key/Vertex via the registry's `authType`
      // discriminator. The Config layer materializes the right URL /
      // model / key via getEffectiveProviderConfig(); useAuth just needs
      // to (a) know which registry entry is active and (b) call
      // refreshAuth() with that entry's AuthType.
      //
      // Precedence:
      //   1. GEMINI_PROVIDER env var (matches core/getAuthTypeFromEnv).
      //   2. providers.active in settings.json.
      //   3. GEMINI_LOCAL_URL env var (legacy openai-compat shortcut).
      //   4. local.url in settings.json (legacy openai-compat shortcut).
      const providerActive =
        process.env['GEMINI_PROVIDER']?.trim() ||
        settings.merged.providers?.active?.trim();
      const legacyLocalUrl =
        process.env['GEMINI_LOCAL_URL'] || settings.merged.local?.url;
      if (providerActive || legacyLocalUrl) {
        try {
          // Dispatch by the registry entry's AuthType so /provider use
          // gemini-oauth exercises the same OAuth path as /auth's
          // LOGIN_WITH_GOOGLE selection. Unknown / legacy entries fall
          // through to AuthType.LOCAL (today's openai-compat path).
          let dispatchAuthType: AuthType = AuthType.LOCAL;
          let dispatchLabel = 'OpenAI-compat';
          if (providerActive) {
            const def = getProvider(providerActive);
            if (def) {
              dispatchAuthType = def.authType;
              dispatchLabel = def.displayName;
            }
          }
          await config.refreshAuth(dispatchAuthType);
          if (providerActive) {
            debugLogger.log(
              `Authenticated via provider "${providerActive}" (${dispatchLabel}).`,
            );
          } else {
            debugLogger.log(
              `Authenticated via legacy local LLM bypass (${legacyLocalUrl}).`,
            );
          }
          setAuthError(null);
          setAuthState(AuthState.Authenticated);
        } catch (e) {
          onAuthError(
            providerActive
              ? `Failed to initialize provider "${providerActive}": ${getErrorMessage(e)}`
              : `Failed to initialize local LLM: ${getErrorMessage(e)}`,
          );
        }
        return;
      }
      // --- END LOCAL FORK ADDITION ---

      const authType = settings.merged.security.auth.selectedType;
      if (!authType) {
        if (process.env['GEMINI_API_KEY']) {
          onAuthError(
            'Existing API key detected (GEMINI_API_KEY). Select "Gemini API Key" option to use it.',
          );
        } else {
          onAuthError('No authentication method selected.');
        }
        return;
      }

      if (authType === AuthType.USE_GEMINI) {
        const key = await reloadApiKey(); // Use the unified function
        if (!key) {
          setAuthState(AuthState.AwaitingApiKeyInput);
          return;
        }
      }

      const error = validateAuthMethodWithSettings(authType, settings);
      if (error) {
        onAuthError(error);
        return;
      }

      const defaultAuthType = process.env['GEMINI_DEFAULT_AUTH_TYPE'];
      if (
        defaultAuthType &&
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        !Object.values(AuthType).includes(defaultAuthType as AuthType)
      ) {
        onAuthError(
          `Invalid value for GEMINI_DEFAULT_AUTH_TYPE: "${defaultAuthType}". ` +
            `Valid values are: ${Object.values(AuthType).join(', ')}.`,
        );
        return;
      }

      try {
        await config.refreshAuth(authType);

        debugLogger.log(`Authenticated via "${authType}".`);
        setAuthError(null);
        setAuthState(AuthState.Authenticated);
      } catch (e) {
        const suspendedError = isAccountSuspendedError(e);
        if (suspendedError) {
          setAccountSuspensionInfo({
            message: suspendedError.message,
            appealUrl: suspendedError.appealUrl,
            appealLinkText: suspendedError.appealLinkText,
          });
        } else if (e instanceof ProjectIdRequiredError) {
          // OAuth succeeded but account setup requires project ID
          // Show the error message directly without "Failed to login" prefix
          onAuthError(getErrorMessage(e));
        } else {
          onAuthError(`Failed to sign in. Message: ${getErrorMessage(e)}`);
        }
      }
    })();
  }, [
    settings,
    config,
    authState,
    setAuthState,
    setAuthError,
    onAuthError,
    reloadApiKey,
  ]);

  return {
    authState,
    setAuthState,
    authError,
    onAuthError,
    apiKeyDefaultValue,
    reloadApiKey,
    accountSuspensionInfo,
    setAccountSuspensionInfo,
  };
};
