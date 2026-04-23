/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo, useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import {
  type Config,
  UserAccountManager,
  AuthType,
} from '@google/gemini-cli-core';
import { isUltraTier } from '../../utils/tierUtils.js';

interface UserIdentityProps {
  config: Config;
}

export const UserIdentity: React.FC<UserIdentityProps> = ({ config }) => {
  const authType = config.getContentGeneratorConfig()?.authType;
  const [email, setEmail] = useState<string | undefined>();

  useEffect(() => {
    if (authType) {
      const userAccountManager = new UserAccountManager();
      setEmail(userAccountManager.getCachedGoogleAccount() ?? undefined);
    } else {
      setEmail(undefined);
    }
  }, [authType]);

  const tierName = useMemo(
    () => (authType ? config.getUserTierName() : undefined),
    [config, authType],
  );

  const isUltra = useMemo(() => isUltraTier(tierName), [tierName]);

  // --- LOCAL FORK ADDITION ---
  // When running in local mode, surface the live local-server settings
  // directly under the auth identity row so users can see at a glance which
  // endpoint and model they're talking to. Reads through Config getters so
  // the values stay in sync with hot-reloaded settings (Phase 2.0.2).
  const localInfo = useMemo(() => {
    if (authType !== AuthType.LOCAL) return undefined;
    return {
      url: config.getLocalUrl?.() ?? '',
      model: config.getLocalModel?.() ?? '',
      contextLimit: config.getLocalContextLimit?.() ?? 0,
      promptMode: config.getLocalPromptMode?.() ?? 'lite',
      // --- LOCAL FORK ADDITION (Phase 2.0.12) ---
      parserMode: config.getLocalToolCallParseMode?.() ?? 'lenient',
      // --- END LOCAL FORK ADDITION ---
    };
  }, [config, authType]);
  // --- END LOCAL FORK ADDITION ---

  if (!authType) {
    return null;
  }

  return (
    <Box flexDirection="column">
      {/* User Email /auth */}
      <Box>
        <Text color={theme.text.primary} wrap="truncate-end">
          {authType === AuthType.LOGIN_WITH_GOOGLE ? (
            <Text>
              <Text bold>Signed in with Google{email ? ':' : ''}</Text>
              {email ? ` ${email}` : ''}
            </Text>
          ) : (
            `Authenticated with ${authType}`
          )}
        </Text>
        <Text color={theme.text.secondary}> /auth</Text>
      </Box>

      {/* --- LOCAL FORK ADDITION --- */}
      {localInfo && (
        <Box flexDirection="column" marginLeft={2}>
          <Text color={theme.text.secondary} wrap="truncate-end">
            URL: {localInfo.url || '(not set)'}
          </Text>
          <Text color={theme.text.secondary} wrap="truncate-end">
            Model: {localInfo.model || '(not set)'}
          </Text>
          <Text color={theme.text.secondary} wrap="truncate-end">
            Context: {localInfo.contextLimit.toLocaleString()} tokens Prompt:{' '}
            {localInfo.promptMode}
          </Text>
          {/* --- LOCAL FORK ADDITION (Phase 2.0.12) --- */}
          <Text color={theme.text.secondary} wrap="truncate-end">
            Parser: {localInfo.parserMode}
          </Text>
          {/* --- END LOCAL FORK ADDITION --- */}
          <Text color={theme.text.secondary}> /local</Text>
        </Box>
      )}
      {/* --- END LOCAL FORK ADDITION --- */}

      {/* Tier Name /upgrade */}
      {tierName && (
        <Box>
          <Text color={theme.text.primary} wrap="truncate-end">
            <Text bold>Plan:</Text> {tierName}
          </Text>
          {!isUltra && <Text color={theme.text.secondary}> /upgrade</Text>}
        </Box>
      )}
    </Box>
  );
};
