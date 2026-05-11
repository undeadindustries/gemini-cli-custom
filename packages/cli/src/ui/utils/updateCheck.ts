/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import semver from 'semver';
import {
  debugLogger,
  LOCAL_CLI_NAME,
  LOCAL_CLI_VERSION,
  LOCAL_CLI_REPO,
} from '@google/gemini-cli-core';
import type { LoadedSettings } from '../../config/settings.js';

export const FETCH_TIMEOUT_MS = 2000;

// Replicating the bits of UpdateInfo we need from update-notifier
export interface UpdateInfo {
  latest: string;
  current: string;
  name: string;
  type?: semver.ReleaseType;
}

export interface UpdateObject {
  message: string;
  update: UpdateInfo;
  isUpdating?: boolean;
}

// --- LOCAL FORK ADDITION (GitHub-only update check) ---
// This fork ships under its own binary name (`gemini-cli-custom`) and its own
// version axis (`LOCAL_CLI_VERSION`). It is never installed from npm, so the
// upstream `latest-version` / `npm install -g @google/gemini-cli@…` path is
// unreachable in practice and produces a confusing "Automatic update failed"
// error on every start. We always check the fork's GitHub releases instead.
//
// `checkLocalForkUpdate()` deliberately does NOT set an `updateCommand`, so
// `handleAutoUpdate.ts` will only print the upgrade notice (with a "git pull"
// hint) and never spawn a package-manager update process.
async function checkLocalForkUpdate(): Promise<UpdateObject | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const resp = await fetch(
      `https://api.github.com/repos/${LOCAL_CLI_REPO}/releases/latest`,
      {
        headers: { Accept: 'application/vnd.github.v3+json' },
        signal: controller.signal,
      },
    );
    if (!resp.ok) return null;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const data = (await resp.json()) as { tag_name?: string };
    const tagName = data.tag_name;
    if (!tagName) return null;

    const latestRemote = semver.clean(tagName);
    if (!latestRemote) return null;

    if (semver.gt(latestRemote, LOCAL_CLI_VERSION)) {
      const message = `${LOCAL_CLI_NAME} update available! ${LOCAL_CLI_VERSION} → ${latestRemote}\nRunning from a local git clone. Please update with "git pull".`;
      return {
        message,
        update: {
          latest: latestRemote,
          current: LOCAL_CLI_VERSION,
          name: LOCAL_CLI_NAME,
          type: semver.diff(latestRemote, LOCAL_CLI_VERSION) || undefined,
        },
      };
    }
    return null;
  } catch {
    debugLogger.log('[LocalLLM] Failed to check fork updates');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkForUpdates(
  settings: LoadedSettings,
): Promise<UpdateObject | null> {
  try {
    if (!settings.merged.general.enableAutoUpdateNotification) {
      return null;
    }
    // Skip update check when running from source (development mode)
    if (process.env['DEV'] === 'true') {
      return null;
    }

    // This fork publishes to GitHub, not npm. Always check GitHub releases.
    return await checkLocalForkUpdate();
  } catch (e) {
    debugLogger.warn('Failed to check for updates: ' + e);
    return null;
  }
}
