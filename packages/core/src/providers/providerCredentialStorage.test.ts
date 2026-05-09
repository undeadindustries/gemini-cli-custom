/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  loadProviderApiKey,
  saveProviderApiKey,
  clearProviderApiKey,
  resolveProviderApiKey,
  resetProviderApiKeyCacheForTesting,
} from './providerCredentialStorage.js';

const getCredentialsMock = vi.hoisted(() => vi.fn());
const setCredentialsMock = vi.hoisted(() => vi.fn());
const deleteCredentialsMock = vi.hoisted(() => vi.fn());

vi.mock('../mcp/token-storage/hybrid-token-storage.js', () => ({
  HybridTokenStorage: vi.fn().mockImplementation(() => ({
    getCredentials: getCredentialsMock,
    setCredentials: setCredentialsMock,
    deleteCredentials: deleteCredentialsMock,
  })),
}));

describe('providerCredentialStorage', () => {
  let originalOpenAiKey: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    resetProviderApiKeyCacheForTesting();
    originalOpenAiKey = process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
  });

  afterEach(() => {
    if (originalOpenAiKey !== undefined) {
      process.env['OPENAI_API_KEY'] = originalOpenAiKey;
    } else {
      delete process.env['OPENAI_API_KEY'];
    }
  });

  it('loads a key from the keychain and caches it', async () => {
    getCredentialsMock.mockResolvedValue({
      serverName: 'openai',
      token: { accessToken: 'sk-stored', tokenType: 'ApiKey' },
      updatedAt: Date.now(),
    });
    const key1 = await loadProviderApiKey('openai');
    const key2 = await loadProviderApiKey('openai');
    expect(key1).toBe('sk-stored');
    expect(key2).toBe('sk-stored');
    expect(getCredentialsMock).toHaveBeenCalledTimes(1);
  });

  it('returns null when the keychain has no entry', async () => {
    getCredentialsMock.mockResolvedValue(null);
    expect(await loadProviderApiKey('openai')).toBeNull();
  });

  it('returns null and does not throw when keychain read fails', async () => {
    getCredentialsMock.mockRejectedValue(new Error('libsecret missing'));
    await expect(loadProviderApiKey('openai')).resolves.toBeNull();
  });

  it('saveProviderApiKey writes to the keychain and invalidates cache', async () => {
    getCredentialsMock.mockResolvedValue({
      serverName: 'openai',
      token: { accessToken: 'old-key', tokenType: 'ApiKey' },
      updatedAt: Date.now(),
    });
    await loadProviderApiKey('openai');
    await saveProviderApiKey('openai', 'new-key');
    expect(setCredentialsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: 'openai',
        token: expect.objectContaining({ accessToken: 'new-key' }),
      }),
    );
    getCredentialsMock.mockResolvedValue({
      serverName: 'openai',
      token: { accessToken: 'new-key', tokenType: 'ApiKey' },
      updatedAt: Date.now(),
    });
    expect(await loadProviderApiKey('openai')).toBe('new-key');
  });

  it('saveProviderApiKey deletes when given empty string', async () => {
    await saveProviderApiKey('openai', '');
    expect(deleteCredentialsMock).toHaveBeenCalledWith('openai');
    expect(setCredentialsMock).not.toHaveBeenCalled();
  });

  it('saveProviderApiKey throws actionable error on keychain failure', async () => {
    setCredentialsMock.mockRejectedValueOnce(new Error('locked'));
    await expect(saveProviderApiKey('openai', 'sk-test')).rejects.toThrow(
      /Could not save API key to keychain.*libsecret/,
    );
  });

  it('clearProviderApiKey deletes and does not throw on missing entry', async () => {
    deleteCredentialsMock.mockRejectedValueOnce(new Error('not found'));
    await expect(clearProviderApiKey('openai')).resolves.toBeUndefined();
    expect(deleteCredentialsMock).toHaveBeenCalledWith('openai');
  });

  it('separate provider ids do not collide', async () => {
    getCredentialsMock.mockImplementation(async (entry: string) => ({
      serverName: entry,
      token: { accessToken: `key-for-${entry}`, tokenType: 'ApiKey' },
      updatedAt: Date.now(),
    }));
    const a = await loadProviderApiKey('openai');
    const b = await loadProviderApiKey('deepseek');
    expect(a).toBe('key-for-openai');
    expect(b).toBe('key-for-deepseek');
  });

  describe('resolveProviderApiKey', () => {
    it('prefers env var over keychain', async () => {
      process.env['OPENAI_API_KEY'] = 'sk-env-key';
      getCredentialsMock.mockResolvedValue({
        serverName: 'openai',
        token: { accessToken: 'sk-keychain', tokenType: 'ApiKey' },
        updatedAt: Date.now(),
      });
      expect(await resolveProviderApiKey('openai')).toBe('sk-env-key');
      expect(getCredentialsMock).not.toHaveBeenCalled();
    });

    it('falls back to keychain when env var is empty/whitespace', async () => {
      process.env['OPENAI_API_KEY'] = '   ';
      getCredentialsMock.mockResolvedValue({
        serverName: 'openai',
        token: { accessToken: 'sk-keychain', tokenType: 'ApiKey' },
        updatedAt: Date.now(),
      });
      expect(await resolveProviderApiKey('openai')).toBe('sk-keychain');
    });

    it('trims env var values', async () => {
      process.env['OPENAI_API_KEY'] = '  sk-trimmed  ';
      expect(await resolveProviderApiKey('openai')).toBe('sk-trimmed');
    });

    it('returns null when no env var and no keychain entry', async () => {
      getCredentialsMock.mockResolvedValue(null);
      expect(await resolveProviderApiKey('openai')).toBeNull();
    });
  });
});
