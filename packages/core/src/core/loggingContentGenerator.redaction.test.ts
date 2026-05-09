/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Phase 2.1 — redaction regression test.
//
// Audit conclusion: LoggingContentGenerator only forwards the request
// `contents` and the response payload to the telemetry layer. It never has
// access to fetch-level headers (those are constructed inside the inner
// ContentGenerator's private fetchWithTimeout). To prevent regressions if
// someone later "helpfully" adds a request-header dump, this test:
//
//   1. Wires a real OpenAICompatContentGenerator with a known API key into
//      LoggingContentGenerator.
//   2. Spies on every telemetry sink (logApiRequest / logApiResponse /
//      logApiError) AND on the global fetch so we can confirm the key
//      reached the wire.
//   3. Asserts the literal API-key string never appears in any captured
//      logger event payload, regardless of success or failure.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LoggingContentGenerator } from './loggingContentGenerator.js';
import {
  LocalLlmContentGenerator,
  OpenAICompatContentGenerator,
} from './localLlmContentGenerator.js';
import type { Config } from '../config/config.js';
import { LlmRole } from '../telemetry/llmRole.js';

const logApiRequestMock = vi.hoisted(() => vi.fn());
const logApiResponseMock = vi.hoisted(() => vi.fn());
const logApiErrorMock = vi.hoisted(() => vi.fn());

vi.mock('../telemetry/loggers.js', async () => {
  const actual: object = await vi.importActual('../telemetry/loggers.js');
  return {
    ...actual,
    logApiRequest: logApiRequestMock,
    logApiResponse: logApiResponseMock,
    logApiError: logApiErrorMock,
  };
});

const SECRET_KEY = 'sk-REDACTION-CANARY-9zX1A2b3C4d5';

function makeStubConfig(): Config {
  const stub = {
    getLocalTimeout: () => 5_000,
    getLocalTemperature: () => null,
    getLocalTopP: () => null,
    getLocalTopK: () => null,
    getLocalMinP: () => null,
    getLocalRepetitionPenalty: () => null,
    getLocalToolCallParseMode: () => 'lenient' as const,
    getLocalEnableTools: () => false,
    isLocalToolsEnabled: () => false,
    getLocalContextLimit: () => 128_000,
    getLocalCompressionThreshold: () => 0.7,
    getLocalPreserveFraction: () => 0.3,
    getLocalUrl: () => 'https://api.openai.com/v1/chat/completions',
    getLocalModel: () => 'gpt-4o-mini',
    getLocalPromptMode: () => 'lite' as const,
    getContentGeneratorConfig: () => undefined,
    getCliVersion: () => '0.0.0-test',
    getDebugMode: () => false,
    getEphemeralSetting: () => undefined,
    getModel: () => 'gpt-4o-mini',
    getProviderConfig: () => undefined,
    getActiveProviderId: () => 'openai',
    getTelemetryLogPromptsEnabled: () => false,
    getTelemetryTracesEnabled: () => false,
    getSessionId: () => 'test-session',
    getProjectTempDir: () => '/tmp',
    getUsageStatisticsEnabled: () => false,
    refreshUserQuotaIfStale: () => Promise.resolve(),
  };
  return stub as unknown as Config;
}

function makeOkResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Stringify any captured argument so we can scan it for the secret. */
function stringifyArg(arg: unknown): string {
  if (arg === null || arg === undefined) return '';
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg, (_k, v) => v, 0);
  } catch {
    return String(arg);
  }
}

function allLoggedText(): string {
  const all: string[] = [];
  for (const mock of [logApiRequestMock, logApiResponseMock, logApiErrorMock]) {
    for (const call of mock.mock.calls) {
      for (const arg of call) {
        all.push(stringifyArg(arg));
      }
    }
  }
  return all.join('\n');
}

describe('LoggingContentGenerator redaction (Phase 2.1)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeOkResponse({
        id: 'chatcmpl-test',
        choices: [
          {
            finish_reason: 'stop',
            message: { content: 'hello', role: 'assistant' },
          },
        ],
      }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('confirms OpenAICompatContentGenerator alias resolves to the same class', () => {
    expect(OpenAICompatContentGenerator).toBe(LocalLlmContentGenerator);
  });

  it('successful request: API key NEVER appears in any telemetry payload', async () => {
    const config = makeStubConfig();
    const inner = new LocalLlmContentGenerator(
      'https://api.openai.com/v1/chat/completions',
      'gpt-4o-mini',
      config,
      { apiKey: SECRET_KEY },
    );
    const wrapped = new LoggingContentGenerator(inner, config);

    await wrapped.generateContent(
      {
        model: 'gpt-4o-mini',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      },
      'p-1',
      LlmRole.MAIN,
    );

    // Sanity: the key really did reach fetch (so we know we're testing
    // a meaningful path, not an unconfigured one).
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${SECRET_KEY}`);

    // No telemetry call argument may contain the literal key.
    const blob = allLoggedText();
    expect(blob).not.toContain(SECRET_KEY);
    // Defense in depth: also reject the bearer prefix + key.
    expect(blob).not.toContain(`Bearer ${SECRET_KEY}`);
  });

  it('error path: API key NEVER appears in error telemetry either', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('upstream said no', { status: 401 }),
    );
    const config = makeStubConfig();
    const inner = new LocalLlmContentGenerator(
      'https://api.openai.com/v1/chat/completions',
      'gpt-4o-mini',
      config,
      { apiKey: SECRET_KEY },
    );
    const wrapped = new LoggingContentGenerator(inner, config);
    await expect(
      wrapped.generateContent(
        {
          model: 'gpt-4o-mini',
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        },
        'p-2',
        LlmRole.MAIN,
      ),
    ).rejects.toThrow();

    const blob = allLoggedText();
    expect(blob).not.toContain(SECRET_KEY);
  });
});
