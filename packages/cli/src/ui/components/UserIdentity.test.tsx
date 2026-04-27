/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders } from '../../test-utils/render.js';
import { UserIdentity } from './UserIdentity.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  makeFakeConfig,
  AuthType,
  UserAccountManager,
  type ContentGeneratorConfig,
} from '@google/gemini-cli-core';

// Mock UserAccountManager to control cached account
vi.mock('@google/gemini-cli-core', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@google/gemini-cli-core')>();
  return {
    ...original,
    UserAccountManager: vi.fn().mockImplementation(() => ({
      getCachedGoogleAccount: () => 'test@example.com',
    })),
  };
});

describe('<UserIdentity />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render login message and auth indicator', async () => {
    const mockConfig = makeFakeConfig();
    vi.spyOn(mockConfig, 'getContentGeneratorConfig').mockReturnValue({
      authType: AuthType.LOGIN_WITH_GOOGLE,
      model: 'gemini-pro',
    } as unknown as ContentGeneratorConfig);
    vi.spyOn(mockConfig, 'getUserTierName').mockReturnValue(undefined);

    const { lastFrame, unmount } = await renderWithProviders(
      <UserIdentity config={mockConfig} />,
    );

    const output = lastFrame();
    expect(output).toContain('Signed in with Google: test@example.com');
    expect(output).toContain('/auth');
    expect(output).not.toContain('/upgrade');
    unmount();
  });

  it('should render the user email on the very first frame (regression test)', async () => {
    const mockConfig = makeFakeConfig();
    vi.spyOn(mockConfig, 'getContentGeneratorConfig').mockReturnValue({
      authType: AuthType.LOGIN_WITH_GOOGLE,
      model: 'gemini-pro',
    } as unknown as ContentGeneratorConfig);
    vi.spyOn(mockConfig, 'getUserTierName').mockReturnValue(undefined);

    const { lastFrameRaw, unmount } = await renderWithProviders(
      <UserIdentity config={mockConfig} />,
    );

    // Assert immediately on the first available frame before any async ticks happen
    const output = lastFrameRaw();
    expect(output).toContain('test@example.com');
    unmount();
  });

  it('should render login message if email is missing', async () => {
    // Modify the mock for this specific test
    vi.mocked(UserAccountManager).mockImplementationOnce(
      () =>
        ({
          getCachedGoogleAccount: () => undefined,
        }) as unknown as UserAccountManager,
    );

    const mockConfig = makeFakeConfig();
    vi.spyOn(mockConfig, 'getContentGeneratorConfig').mockReturnValue({
      authType: AuthType.LOGIN_WITH_GOOGLE,
      model: 'gemini-pro',
    } as unknown as ContentGeneratorConfig);
    vi.spyOn(mockConfig, 'getUserTierName').mockReturnValue(undefined);

    const { lastFrame, unmount } = await renderWithProviders(
      <UserIdentity config={mockConfig} />,
    );

    const output = lastFrame();
    expect(output).toContain('Signed in with Google');
    expect(output).not.toContain('Signed in with Google:');
    expect(output).toContain('/auth');
    expect(output).not.toContain('/upgrade');
    unmount();
  });

  it('should render plan name and upgrade indicator', async () => {
    const mockConfig = makeFakeConfig();
    vi.spyOn(mockConfig, 'getContentGeneratorConfig').mockReturnValue({
      authType: AuthType.LOGIN_WITH_GOOGLE,
      model: 'gemini-pro',
    } as unknown as ContentGeneratorConfig);
    vi.spyOn(mockConfig, 'getUserTierName').mockReturnValue('Premium Plan');

    const { lastFrame, unmount } = await renderWithProviders(
      <UserIdentity config={mockConfig} />,
    );

    const output = lastFrame();
    expect(output).toContain('Signed in with Google: test@example.com');
    expect(output).toContain('/auth');
    expect(output).toContain('Plan: Premium Plan');
    expect(output).toContain('/upgrade');

    // Check for two lines (or more if wrapped, but here it should be separate)
    const lines = output?.split('\n').filter((line) => line.trim().length > 0);
    expect(lines?.some((line) => line.includes('Signed in with Google'))).toBe(
      true,
    );
    expect(lines?.some((line) => line.includes('Plan: Premium Plan'))).toBe(
      true,
    );

    unmount();
  });

  it('should not render if authType is missing', async () => {
    const mockConfig = makeFakeConfig();
    vi.spyOn(mockConfig, 'getContentGeneratorConfig').mockReturnValue(
      {} as unknown as ContentGeneratorConfig,
    );

    const { lastFrame, unmount } = await renderWithProviders(
      <UserIdentity config={mockConfig} />,
    );

    expect(lastFrame({ allowEmpty: true })).toBe('');
    unmount();
  });

  it('should render non-Google auth message', async () => {
    const mockConfig = makeFakeConfig();
    vi.spyOn(mockConfig, 'getContentGeneratorConfig').mockReturnValue({
      authType: AuthType.USE_GEMINI,
      model: 'gemini-pro',
    } as unknown as ContentGeneratorConfig);
    vi.spyOn(mockConfig, 'getUserTierName').mockReturnValue(undefined);

    const { lastFrame, unmount } = await renderWithProviders(
      <UserIdentity config={mockConfig} />,
    );

    const output = lastFrame();
    expect(output).toContain(`Authenticated with ${AuthType.USE_GEMINI}`);
    expect(output).toContain('/auth');
    expect(output).not.toContain('/upgrade');
    unmount();
  });

  it('should render specific tier name when provided', async () => {
    const mockConfig = makeFakeConfig();
    vi.spyOn(mockConfig, 'getContentGeneratorConfig').mockReturnValue({
      authType: AuthType.LOGIN_WITH_GOOGLE,
      model: 'gemini-pro',
    } as unknown as ContentGeneratorConfig);
    vi.spyOn(mockConfig, 'getUserTierName').mockReturnValue('Enterprise Tier');

    const { lastFrame, unmount } = await renderWithProviders(
      <UserIdentity config={mockConfig} />,
    );

    const output = lastFrame();
    expect(output).toContain('Plan: Enterprise Tier');
    expect(output).toContain('/upgrade');
    unmount();
  });

  it('should not render /upgrade indicator for ultra tiers', async () => {
    const mockConfig = makeFakeConfig();
    vi.spyOn(mockConfig, 'getContentGeneratorConfig').mockReturnValue({
      authType: AuthType.LOGIN_WITH_GOOGLE,
      model: 'gemini-pro',
    } as unknown as ContentGeneratorConfig);
    vi.spyOn(mockConfig, 'getUserTierName').mockReturnValue('Advanced Ultra');

    const { lastFrame, unmount } = await renderWithProviders(
      <UserIdentity config={mockConfig} />,
    );

    const output = lastFrame();
    expect(output).toContain('Plan: Advanced Ultra');
    expect(output).not.toContain('/upgrade');
    unmount();
  });

  // --- LOCAL FORK ADDITION (Phase 2.1.1: unify local + provider) ---
  it('should render the active OpenAI-compat config under the auth row (legacy-local source)', async () => {
    const mockConfig = makeFakeConfig();
    vi.spyOn(mockConfig, 'getContentGeneratorConfig').mockReturnValue({
      authType: AuthType.LOCAL,
    } as unknown as ContentGeneratorConfig);
    vi.spyOn(mockConfig, 'getUserTierName').mockReturnValue(undefined);
    vi.spyOn(mockConfig, 'getEffectiveProviderConfig').mockReturnValue({
      url: 'http://127.0.0.1:8000/v1/chat/completions',
      model: 'Qwen/Qwen3-Coder-Next-FP8',
      contextLimit: 32768,
      promptMode: 'lite',
      parserMode: 'strict',
      timeout: 600000,
      enableTools: true,
      displayName: 'Local vLLM',
      providerId: 'local-vllm',
      requiresApiKey: false,
      apiKeyEnvVar: '',
      wireFormat: 'openai-chat',
      authType: AuthType.LOCAL,
    });

    const { lastFrame, unmount } = await renderWithProviders(
      <UserIdentity config={mockConfig} />,
    );

    const output = lastFrame();
    expect(output).toContain(`Authenticated with ${AuthType.LOCAL}`);
    expect(output).toContain('Active: Local vLLM');
    expect(output).toContain('http://127.0.0.1:8000/v1/chat/completions');
    expect(output).toContain('Qwen/Qwen3-Coder-Next-FP8');
    expect(output).toContain('32,768 tokens');
    expect(output).toContain('Prompt: lite');
    expect(output).toContain('Parser: strict');
    expect(output).toContain('/provider');
    // Local presets have no API key — the row must be suppressed.
    expect(output).not.toContain('API key:');
    unmount();
  });

  it('should render hosted-provider config with the API-key source', async () => {
    const mockConfig = makeFakeConfig();
    vi.spyOn(mockConfig, 'getContentGeneratorConfig').mockReturnValue({
      authType: AuthType.LOCAL,
    } as unknown as ContentGeneratorConfig);
    vi.spyOn(mockConfig, 'getUserTierName').mockReturnValue(undefined);
    vi.spyOn(mockConfig, 'getEffectiveProviderConfig').mockReturnValue({
      url: 'https://api.openai.com/v1/chat/completions',
      model: 'gpt-4o',
      contextLimit: 128000,
      promptMode: 'lite',
      parserMode: 'strict',
      timeout: 600000,
      enableTools: true,
      displayName: 'OpenAI',
      providerId: 'openai',
      requiresApiKey: true,
      apiKeyEnvVar: 'OPENAI_API_KEY',
      wireFormat: 'openai-chat',
      authType: AuthType.LOCAL,
    });

    const { lastFrame, unmount } = await renderWithProviders(
      <UserIdentity config={mockConfig} />,
    );

    const output = lastFrame();
    expect(output).toContain('Active: OpenAI (openai)');
    expect(output).toContain('https://api.openai.com/v1/chat/completions');
    expect(output).toContain('gpt-4o');
    expect(output).toContain('128,000 tokens');
    expect(output).toContain('API key: from $OPENAI_API_KEY or keychain');
    expect(output).toContain('/provider');
    unmount();
  });

  it('should not render the provider sub-block when no provider is resolved', async () => {
    const mockConfig = makeFakeConfig();
    vi.spyOn(mockConfig, 'getContentGeneratorConfig').mockReturnValue({
      authType: AuthType.USE_GEMINI,
      model: 'gemini-pro',
    } as unknown as ContentGeneratorConfig);
    vi.spyOn(mockConfig, 'getUserTierName').mockReturnValue(undefined);
    vi.spyOn(mockConfig, 'getEffectiveProviderConfig').mockReturnValue(
      undefined,
    );

    const { lastFrame, unmount } = await renderWithProviders(
      <UserIdentity config={mockConfig} />,
    );

    const output = lastFrame();
    expect(output).not.toContain('/provider');
    expect(output).not.toContain('Active:');
    expect(output).not.toContain('URL:');
    unmount();
  });

  // --- LOCAL FORK ADDITION (Phase 2.2: gemini wireFormat block) ---
  it('should render gemini-oauth as a model + OAuth auth row, with no URL/parser fields', async () => {
    const mockConfig = makeFakeConfig();
    vi.spyOn(mockConfig, 'getContentGeneratorConfig').mockReturnValue({
      authType: AuthType.LOGIN_WITH_GOOGLE,
    } as unknown as ContentGeneratorConfig);
    vi.spyOn(mockConfig, 'getUserTierName').mockReturnValue(undefined);
    vi.spyOn(mockConfig, 'getEffectiveProviderConfig').mockReturnValue({
      url: '',
      model: 'gemini-2.5-pro',
      contextLimit: 1_048_576,
      promptMode: 'full',
      parserMode: 'strict',
      timeout: 600000,
      enableTools: true,
      displayName: 'Gemini (OAuth login)',
      providerId: 'gemini-oauth',
      requiresApiKey: false,
      apiKeyEnvVar: '',
      wireFormat: 'gemini',
      authType: AuthType.LOGIN_WITH_GOOGLE,
    });

    const { lastFrame, unmount } = await renderWithProviders(
      <UserIdentity config={mockConfig} />,
    );

    const output = lastFrame();
    expect(output).toContain('Active: Gemini (OAuth login) (gemini-oauth)');
    expect(output).toContain('gemini-2.5-pro');
    expect(output).toContain('1,048,576 tokens');
    // Gemini wireFormat must NOT render URL / Parser / Prompt rows.
    expect(output).not.toContain('URL:');
    expect(output).not.toContain('Parser:');
    expect(output).not.toContain('Prompt:');
    expect(output).toContain('Auth: OAuth');
    expect(output).toContain('/provider');
    unmount();
  });

  it('should render gemini-apikey with the GEMINI_API_KEY status', async () => {
    const mockConfig = makeFakeConfig();
    vi.spyOn(mockConfig, 'getContentGeneratorConfig').mockReturnValue({
      authType: AuthType.USE_GEMINI,
    } as unknown as ContentGeneratorConfig);
    vi.spyOn(mockConfig, 'getUserTierName').mockReturnValue(undefined);
    vi.spyOn(mockConfig, 'getEffectiveProviderConfig').mockReturnValue({
      url: '',
      model: 'gemini-2.5-flash',
      contextLimit: 1_048_576,
      promptMode: 'full',
      parserMode: 'strict',
      timeout: 600000,
      enableTools: true,
      displayName: 'Gemini (API key)',
      providerId: 'gemini-apikey',
      requiresApiKey: true,
      apiKeyEnvVar: 'GEMINI_API_KEY',
      wireFormat: 'gemini',
      authType: AuthType.USE_GEMINI,
    });

    const { lastFrame, unmount } = await renderWithProviders(
      <UserIdentity config={mockConfig} />,
    );

    const output = lastFrame();
    expect(output).toContain('Active: Gemini (API key) (gemini-apikey)');
    expect(output).toContain('gemini-2.5-flash');
    expect(output).toContain('Auth: $GEMINI_API_KEY');
    // No URL row for the gemini wire format.
    expect(output).not.toContain('URL:');
    expect(output).not.toContain('Parser:');
    unmount();
  });

  it('should render gemini-vertex with Vertex / ADC auth wording', async () => {
    const mockConfig = makeFakeConfig();
    vi.spyOn(mockConfig, 'getContentGeneratorConfig').mockReturnValue({
      authType: AuthType.USE_VERTEX_AI,
    } as unknown as ContentGeneratorConfig);
    vi.spyOn(mockConfig, 'getUserTierName').mockReturnValue(undefined);
    vi.spyOn(mockConfig, 'getEffectiveProviderConfig').mockReturnValue({
      url: '',
      model: 'gemini-2.5-pro',
      contextLimit: 1_048_576,
      promptMode: 'full',
      parserMode: 'strict',
      timeout: 600000,
      enableTools: true,
      displayName: 'Gemini (Vertex AI)',
      providerId: 'gemini-vertex',
      requiresApiKey: false,
      apiKeyEnvVar: '',
      wireFormat: 'gemini',
      authType: AuthType.USE_VERTEX_AI,
    });

    const { lastFrame, unmount } = await renderWithProviders(
      <UserIdentity config={mockConfig} />,
    );

    const output = lastFrame();
    expect(output).toContain('Active: Gemini (Vertex AI) (gemini-vertex)');
    expect(output).toContain('Auth: Vertex AI / ADC');
    expect(output).not.toContain('URL:');
    unmount();
  });
  // --- END LOCAL FORK ADDITION ---
});
