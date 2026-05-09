/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * --- LOCAL FORK ADDITION (Phase 2.0.14) ---
 * Unit tests for the four extended sampler getters added to Config:
 *   getLocalTopP, getLocalTopK, getLocalMinP, getLocalRepetitionPenalty
 *
 * These knobs forward Z.ai's recommended sampler shape for GLM-4.7-Flash
 * tool-calling (top_p=1.0, min_p=0.01, repetition_penalty=1.0) to the local
 * inference server, suppressing the model's documented loop behavior.
 *
 * Tests are deliberately isolated from the main config.test.ts so they do not
 * collide with upstream test changes during rebases.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Config, type ConfigParameters } from './config.js';

const ENV_VARS = [
  'GEMINI_LOCAL_TOP_P',
  'GEMINI_LOCAL_TOP_K',
  'GEMINI_LOCAL_MIN_P',
  'GEMINI_LOCAL_REPETITION_PENALTY',
  'GEMINI_LOCAL_TEMPERATURE',
] as const;

function makeBaseParams(
  extra: Partial<ConfigParameters> = {},
): ConfigParameters {
  return {
    cwd: '/tmp',
    embeddingModel: 'gemini-embedding',
    sandbox: undefined,
    targetDir: '/tmp',
    debugMode: false,
    sessionId: 'phase-2-0-14-test',
    model: 'test-model',
    usageStatisticsEnabled: false,
    ...extra,
  };
}

describe('Phase 2.0.14 — local sampler getters', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_VARS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_VARS) {
      if (savedEnv[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = savedEnv[k];
      }
    }
  });

  describe('getLocalTopP', () => {
    it('returns null when unset', () => {
      const config = new Config(makeBaseParams());
      expect(config.getLocalTopP()).toBeNull();
    });

    it('returns the value when within (0, 1]', () => {
      const config = new Config(makeBaseParams({ localTopP: 0.95 }));
      expect(config.getLocalTopP()).toBe(0.95);
    });

    it('accepts 1.0 (Z.ai recommendation for GLM-4.7-Flash)', () => {
      const config = new Config(makeBaseParams({ localTopP: 1.0 }));
      expect(config.getLocalTopP()).toBe(1.0);
    });

    it('rejects 0 (would zero out the distribution)', () => {
      const config = new Config(makeBaseParams({ localTopP: 0 }));
      expect(config.getLocalTopP()).toBeNull();
    });

    it('rejects values > 1', () => {
      const config = new Config(makeBaseParams({ localTopP: 1.5 }));
      expect(config.getLocalTopP()).toBeNull();
    });

    it('rejects negative values', () => {
      const config = new Config(makeBaseParams({ localTopP: -0.1 }));
      expect(config.getLocalTopP()).toBeNull();
    });

    it('reads from GEMINI_LOCAL_TOP_P when params absent', () => {
      process.env['GEMINI_LOCAL_TOP_P'] = '0.92';
      const config = new Config(makeBaseParams());
      expect(config.getLocalTopP()).toBe(0.92);
    });
  });

  describe('getLocalTopK', () => {
    it('returns null when unset', () => {
      const config = new Config(makeBaseParams());
      expect(config.getLocalTopK()).toBeNull();
    });

    it('accepts -1 (vLLM convention for disabled)', () => {
      const config = new Config(makeBaseParams({ localTopK: -1 }));
      expect(config.getLocalTopK()).toBe(-1);
    });

    it('accepts a positive integer', () => {
      const config = new Config(makeBaseParams({ localTopK: 50 }));
      expect(config.getLocalTopK()).toBe(50);
    });

    it('rejects 0', () => {
      const config = new Config(makeBaseParams({ localTopK: 0 }));
      expect(config.getLocalTopK()).toBeNull();
    });

    it('rejects non-integers', () => {
      const config = new Config(makeBaseParams({ localTopK: 1.5 }));
      expect(config.getLocalTopK()).toBeNull();
    });

    it('rejects negatives other than -1', () => {
      const config = new Config(makeBaseParams({ localTopK: -2 }));
      expect(config.getLocalTopK()).toBeNull();
    });

    it('reads from GEMINI_LOCAL_TOP_K when params absent', () => {
      process.env['GEMINI_LOCAL_TOP_K'] = '40';
      const config = new Config(makeBaseParams());
      expect(config.getLocalTopK()).toBe(40);
    });
  });

  describe('getLocalMinP', () => {
    it('returns null when unset', () => {
      const config = new Config(makeBaseParams());
      expect(config.getLocalMinP()).toBeNull();
    });

    it('accepts 0.01 (Z.ai recommendation for GLM-4.7-Flash)', () => {
      const config = new Config(makeBaseParams({ localMinP: 0.01 }));
      expect(config.getLocalMinP()).toBe(0.01);
    });

    it('accepts 0 (disabled)', () => {
      const config = new Config(makeBaseParams({ localMinP: 0 }));
      expect(config.getLocalMinP()).toBe(0);
    });

    it('accepts 1.0 (max)', () => {
      const config = new Config(makeBaseParams({ localMinP: 1.0 }));
      expect(config.getLocalMinP()).toBe(1.0);
    });

    it('rejects values > 1', () => {
      const config = new Config(makeBaseParams({ localMinP: 1.1 }));
      expect(config.getLocalMinP()).toBeNull();
    });

    it('rejects negative values', () => {
      const config = new Config(makeBaseParams({ localMinP: -0.01 }));
      expect(config.getLocalMinP()).toBeNull();
    });

    it('reads from GEMINI_LOCAL_MIN_P when params absent', () => {
      process.env['GEMINI_LOCAL_MIN_P'] = '0.05';
      const config = new Config(makeBaseParams());
      expect(config.getLocalMinP()).toBe(0.05);
    });
  });

  describe('getLocalRepetitionPenalty', () => {
    it('returns null when unset', () => {
      const config = new Config(makeBaseParams());
      expect(config.getLocalRepetitionPenalty()).toBeNull();
    });

    it('accepts 1.0 (Z.ai recommendation: disabled)', () => {
      const config = new Config(
        makeBaseParams({ localRepetitionPenalty: 1.0 }),
      );
      expect(config.getLocalRepetitionPenalty()).toBe(1.0);
    });

    it('accepts 1.5', () => {
      const config = new Config(
        makeBaseParams({ localRepetitionPenalty: 1.5 }),
      );
      expect(config.getLocalRepetitionPenalty()).toBe(1.5);
    });

    it('accepts 2.0 (max)', () => {
      const config = new Config(
        makeBaseParams({ localRepetitionPenalty: 2.0 }),
      );
      expect(config.getLocalRepetitionPenalty()).toBe(2.0);
    });

    it('rejects 0 (would break sampling)', () => {
      const config = new Config(makeBaseParams({ localRepetitionPenalty: 0 }));
      expect(config.getLocalRepetitionPenalty()).toBeNull();
    });

    it('rejects values > 2', () => {
      const config = new Config(
        makeBaseParams({ localRepetitionPenalty: 2.5 }),
      );
      expect(config.getLocalRepetitionPenalty()).toBeNull();
    });

    it('rejects negative values', () => {
      const config = new Config(makeBaseParams({ localRepetitionPenalty: -1 }));
      expect(config.getLocalRepetitionPenalty()).toBeNull();
    });

    it('reads from GEMINI_LOCAL_REPETITION_PENALTY when params absent', () => {
      process.env['GEMINI_LOCAL_REPETITION_PENALTY'] = '1.1';
      const config = new Config(makeBaseParams());
      expect(config.getLocalRepetitionPenalty()).toBe(1.1);
    });
  });

  describe('refreshLocalConfig hot-reload', () => {
    it('updates topP, topK, minP, and repetitionPenalty without rebuilding', async () => {
      const config = new Config(
        makeBaseParams({
          localTopP: 0.5,
          localTopK: 10,
          localMinP: 0.02,
          localRepetitionPenalty: 1.05,
        }),
      );

      await config.refreshLocalConfig({
        topP: 1.0,
        topK: -1,
        minP: 0.01,
        repetitionPenalty: 1.0,
      });

      expect(config.getLocalTopP()).toBe(1.0);
      expect(config.getLocalTopK()).toBe(-1);
      expect(config.getLocalMinP()).toBe(0.01);
      expect(config.getLocalRepetitionPenalty()).toBe(1.0);
    });

    it('null clears the value back to "server default"', async () => {
      const config = new Config(
        makeBaseParams({
          localTopP: 0.95,
          localMinP: 0.05,
        }),
      );
      expect(config.getLocalTopP()).toBe(0.95);
      expect(config.getLocalMinP()).toBe(0.05);

      await config.refreshLocalConfig({ topP: null, minP: null });

      expect(config.getLocalTopP()).toBeNull();
      expect(config.getLocalMinP()).toBeNull();
    });

    it('leaves untouched fields alone', async () => {
      const config = new Config(
        makeBaseParams({
          localTopP: 0.95,
          localMinP: 0.05,
          localRepetitionPenalty: 1.1,
        }),
      );

      await config.refreshLocalConfig({ topP: 1.0 });

      expect(config.getLocalTopP()).toBe(1.0);
      expect(config.getLocalMinP()).toBe(0.05);
      expect(config.getLocalRepetitionPenalty()).toBe(1.1);
    });
  });
});
