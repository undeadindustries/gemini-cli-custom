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

  // --- LOCAL FORK ADDITION (Phase 2.2: unified provider block) ---
  // ONE block surfaces the active provider entry (local, hosted, or
  // Gemini). getEffectiveProviderConfig() returns a unified shape; the
  // wireFormat field drives whether this renders URL/parser fields
  // (OpenAI-compat) or just model + auth-method (Gemini).
  const effective = useMemo(() => {
    // authType is read here (not just listed in deps) because /auth
    // switches mutate the underlying Config in place without changing
    // its reference; the dep keeps this memo in sync with the active
    // provider whenever the user re-authenticates.
    void authType;
    return config.getEffectiveProviderConfig?.();
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

      {/* --- LOCAL FORK ADDITION (Phase 2.2: wireFormat-aware identity block) --- */}
      {/*
        OpenAI-compat (local-vllm, openai, ...) → URL + parser + prompt
                                                  mode + API-key row.
        Gemini (gemini-oauth / gemini-apikey / gemini-vertex) → just
                                                  model + auth-method row,
                                                  since the upstream SDK
                                                  owns the wire and our
                                                  parserMode / promptMode
                                                  knobs don't apply.
      */}
      {effective && (
        <Box flexDirection="column" marginLeft={2}>
          {/* --- LOCAL FORK ADDITION (Phase 2.3.1: env-override notice) ---
            When the user has GEMINI_PROVIDER set in their shell, every
            app launch ignores settings.json's providers.active and uses
            the env var instead. Without this notice they see the "wrong"
            provider and have no idea why /provider switches don't stick
            across restarts.
          */}
          <Text color={theme.text.secondary} wrap="truncate-end">
            {'Active: ' +
              effective.displayName +
              (effective.providerId ? ' (' + effective.providerId + ')' : '') +
              (process.env['GEMINI_PROVIDER']?.trim()
                ? ' [\u26a0 overridden by $GEMINI_PROVIDER]'
                : '')}
          </Text>
          {/* --- END LOCAL FORK ADDITION --- */}
          <Text color={theme.text.secondary} wrap="truncate-end">
            {/* --- LOCAL FORK ADDITION (Phase 2.4.3: friendlier placeholder) --- */}
            {/* 'local-model' is the internal placeholder used when a provider
                has no defaultModel set and the user hasn't configured one.
                Render it as '(server picks)' so the user understands that
                the server side will choose, rather than thinking the literal
                string 'local-model' is the model name. */}
            {'Model: ' +
              (!effective.model || effective.model === 'local-model'
                ? '(server picks)'
                : effective.model)}
            {/* --- END LOCAL FORK ADDITION --- */}
          </Text>
          <Text color={theme.text.secondary} wrap="truncate-end">
            {'Context: ' + effective.contextLimit.toLocaleString() + ' tokens'}
          </Text>
          {effective.wireFormat === 'openai-chat' ? (
            <>
              <Text color={theme.text.secondary} wrap="truncate-end">
                {'URL: ' + (effective.url || '(not set)')}
              </Text>
              <Text color={theme.text.secondary} wrap="truncate-end">
                {'Prompt: ' +
                  effective.promptMode +
                  '   Parser: ' +
                  effective.parserMode}
              </Text>
              {effective.requiresApiKey && (
                <Text color={theme.text.secondary} wrap="truncate-end">
                  {'API key: from ' +
                    (effective.apiKeyEnvVar
                      ? '$' + effective.apiKeyEnvVar + ' or keychain'
                      : 'keychain')}
                </Text>
              )}
            </>
          ) : effective.wireFormat === 'openai-responses' ? (
            // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
            // Mirrors the openai-chat block but swaps Parser/Prompt for
            // the Responses-only knobs (reasoningEffort + chaining).
            <>
              <Text color={theme.text.secondary} wrap="truncate-end">
                {'URL: ' + (effective.url || '(not set)')}
              </Text>
              {(() => {
                const session = config.getSessionReasoningOverride?.();
                const persisted = effective.reasoningEffort;
                const resolved = session ?? persisted;
                const source = resolved
                  ? session
                    ? ' (session override)'
                    : ' (provider default)'
                  : '';
                return (
                  <Text color={theme.text.secondary} wrap="truncate-end">
                    {'Reasoning: ' + (resolved ?? '(server default)') + source}
                  </Text>
                );
              })()}
              {(() => {
                const lastId = config.getLastResponseId?.();
                const onOff = effective.useResponseChaining ? 'on' : 'off';
                const idTag =
                  effective.useResponseChaining && lastId
                    ? ' (response_' + lastId.slice(0, 8) + '\u2026)'
                    : '';
                return (
                  <Text color={theme.text.secondary} wrap="truncate-end">
                    {'Chaining: ' + onOff + idTag}
                  </Text>
                );
              })()}
              {effective.requiresApiKey && (
                <Text color={theme.text.secondary} wrap="truncate-end">
                  {'API key: from ' +
                    (effective.apiKeyEnvVar
                      ? '$' + effective.apiKeyEnvVar + ' or keychain'
                      : 'keychain')}
                </Text>
              )}
            </>
          ) : (
            // --- END LOCAL FORK ADDITION ---
            // wireFormat === 'gemini' — render the auth method instead
            // of URL / parser fields. The upstream SDK owns the wire.
            <Text color={theme.text.secondary} wrap="truncate-end">
              {'Auth: ' +
                (effective.authType === AuthType.LOGIN_WITH_GOOGLE
                  ? 'OAuth (run /auth to switch account)'
                  : effective.authType === AuthType.USE_GEMINI
                    ? '$' +
                      (effective.apiKeyEnvVar || 'GEMINI_API_KEY') +
                      (effective.apiKeyEnvVar &&
                      process.env[effective.apiKeyEnvVar]
                        ? ' (set)'
                        : ' (not set — run /auth)')
                    : effective.authType === AuthType.USE_VERTEX_AI
                      ? 'Vertex AI / ADC (run /auth to configure)'
                      : String(effective.authType))}
            </Text>
          )}
          <Text color={theme.text.secondary}> /provider</Text>
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
