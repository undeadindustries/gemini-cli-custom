/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import latestVersion from 'latest-version';
import semver from 'semver';
import {
  getPackageJson,
  debugLogger,
  getChannelFromVersion,
  RELEASE_CHANNEL_STABILITY,
  LOCAL_CLI_NAME,
  LOCAL_CLI_VERSION,
  LOCAL_CLI_REPO,
} from '@google/gemini-cli-core';
import type { LoadedSettings } from '../../config/settings.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

/**
 * From a nightly and stable version, determines which is the "best" one to offer.
 * The rule is to always prefer nightly if the base versions are the same.
 */
function getBestAvailableUpdate(
  nightly?: string,
  stable?: string,
): string | null {
  if (!nightly) return stable || null;
  if (!stable) return nightly || null;

  if (semver.coerce(stable)?.version === semver.coerce(nightly)?.version) {
    return nightly;
  }

  return semver.gt(stable, nightly) ? stable : nightly;
}

/**
 * Checks the fork's GitHub releases for a newer version of gemini-cli-local.
 * Returns null when up-to-date, on error, or when the API is unreachable.
 */
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

    // In local LLM mode, check the fork's GitHub releases instead of the
    // npm registry. This suppresses the upstream "new version available" nag.
    const localUrl =
      process.env['GEMINI_LOCAL_URL'] || settings.merged.local?.url;
    if (localUrl) {
      return await checkLocalForkUpdate();
    }

    const packageJson = await getPackageJson(__dirname);
    if (!packageJson || !packageJson.name || !packageJson.version) {
      return null;
    }

    const { name, version: currentVersion } = packageJson;
    const currentChannel = getChannelFromVersion(currentVersion);
    const isNightly = currentVersion.includes('nightly');

    if (isNightly) {
      const [nightlyUpdate, latestUpdate] = await Promise.all([
        latestVersion(name, { version: 'nightly' }),
        latestVersion(name),
      ]);

      const bestUpdate = getBestAvailableUpdate(nightlyUpdate, latestUpdate);

      if (bestUpdate && semver.gt(bestUpdate, currentVersion)) {
        const message = `A new version of Gemini CLI is available! ${currentVersion} → ${bestUpdate}`;
        const type = semver.diff(bestUpdate, currentVersion) || undefined;
        return {
          message,
          update: {
            latest: bestUpdate,
            current: currentVersion,
            name,
            type,
          },
        };
      }
    } else {
      const latestUpdate = await latestVersion(name);
      if (!latestUpdate) {
        return null;
      }

      const targetChannel = getChannelFromVersion(latestUpdate);

      // Only offer updates that are as stable or more stable than the current version
      if (
        RELEASE_CHANNEL_STABILITY[targetChannel] <
        RELEASE_CHANNEL_STABILITY[currentChannel]
      ) {
        return null;
      }

      if (semver.gt(latestUpdate, currentVersion)) {
        const message = `Gemini CLI update available! ${currentVersion} → ${latestUpdate}`;
        const type = semver.diff(latestUpdate, currentVersion) || undefined;
        return {
          message,
          update: {
            latest: latestUpdate,
            current: currentVersion,
            name,
            type,
          },
        };
      }
    }

    return null;
  } catch (e) {
    debugLogger.warn('Failed to check for updates: ' + e);
    return null;
  }
}
