/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { checkForUpdates } from './updateCheck.js';
import type { LoadedSettings } from '../../config/settings.js';

const debugLogger = vi.hoisted(() => ({
  warn: vi.fn(),
  log: vi.fn(),
}));
vi.mock('@google/gemini-cli-core', () => ({
  debugLogger,
  ReleaseChannel: {
    NIGHTLY: 'nightly',
    PREVIEW: 'preview',
    STABLE: 'stable',
  },
  getChannelFromVersion: (version: string) => {
    if (!version || version.includes('nightly')) {
      return 'nightly';
    }
    if (version.includes('preview')) {
      return 'preview';
    }
    return 'stable';
  },
  RELEASE_CHANNEL_STABILITY: {
    nightly: 0,
    preview: 1,
    stable: 2,
  },
  LOCAL_CLI_NAME: 'gemini-cli-local',
  LOCAL_CLI_VERSION: '1.0.0',
  LOCAL_CLI_REPO: 'undeadindustries/gemini-cli',
}));

/**
 * Helper that builds a `Response`-like value matching what the implementation
 * uses (`resp.ok` and `resp.json()`).
 */
function makeResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

describe('checkForUpdates (GitHub-only fork path)', () => {
  let mockSettings: LoadedSettings;
  const fetchMock = vi.fn();

  beforeEach(() => {
    delete process.env['DEV'];
    mockSettings = {
      merged: {
        general: {
          enableAutoUpdateNotification: true,
        },
      },
    } as LoadedSettings;
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns null when enableAutoUpdateNotification is false (and never hits the network)', async () => {
    mockSettings.merged.general.enableAutoUpdateNotification = false;
    const result = await checkForUpdates(mockSettings);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when running from source (DEV=true)', async () => {
    process.env['DEV'] = 'true';
    const result = await checkForUpdates(mockSettings);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('always calls the fork GitHub releases endpoint, regardless of legacy settings', async () => {
    fetchMock.mockResolvedValue(makeResponse({ tag_name: 'v1.0.0' }));
    await checkForUpdates(mockSettings);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe(
      'https://api.github.com/repos/undeadindustries/gemini-cli/releases/latest',
    );
  });

  it('returns an UpdateObject when GitHub reports a newer tag', async () => {
    fetchMock.mockResolvedValue(makeResponse({ tag_name: 'v1.1.0' }));
    const result = await checkForUpdates(mockSettings);
    expect(result).not.toBeNull();
    expect(result?.update.current).toBe('1.0.0');
    expect(result?.update.latest).toBe('1.1.0');
    expect(result?.update.name).toBe('gemini-cli-local');
    expect(result?.message).toContain('1.0.0 → 1.1.0');
    expect(result?.message).toContain('git pull');
  });

  it('returns null when the GitHub tag is the same version', async () => {
    fetchMock.mockResolvedValue(makeResponse({ tag_name: 'v1.0.0' }));
    const result = await checkForUpdates(mockSettings);
    expect(result).toBeNull();
  });

  it('returns null when the GitHub tag is older than the fork version', async () => {
    fetchMock.mockResolvedValue(makeResponse({ tag_name: 'v0.9.0' }));
    const result = await checkForUpdates(mockSettings);
    expect(result).toBeNull();
  });

  it('returns null when the GitHub response is not ok (e.g. 404, no releases yet)', async () => {
    fetchMock.mockResolvedValue(makeResponse({}, /* ok */ false));
    const result = await checkForUpdates(mockSettings);
    expect(result).toBeNull();
  });

  it('returns null when the GitHub response has no tag_name', async () => {
    fetchMock.mockResolvedValue(makeResponse({}));
    const result = await checkForUpdates(mockSettings);
    expect(result).toBeNull();
  });

  it('returns null when the tag_name is not a clean semver', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({ tag_name: 'release-candidate' }),
    );
    const result = await checkForUpdates(mockSettings);
    expect(result).toBeNull();
  });

  it('returns null when the network call rejects', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await checkForUpdates(mockSettings);
    expect(result).toBeNull();
  });
});
