/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Phase 2.1 — verifies the Bearer-auth + extra-headers code path added to
// LocalLlmContentGenerator (aliased OpenAICompatContentGenerator) for hosted
// providers. Brand-new file (Category C); existing local-mode tests remain
// untouched and continue to assert the no-Authorization-header default.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  LocalLlmContentGenerator,
  OpenAICompatContentGenerator,
} from './localLlmContentGenerator.js';
import type { Config } from '../config/config.js';
import { LlmRole } from '../telemetry/llmRole.js';

// Minimal Config stub: only the getters fetchWithTimeout / generateContent
// touch in the synchronous request-build path. Anything we don't override
// returns null/false/0 so the request is the smallest possible OpenAI body.
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
    getLocalUrl: () => 'https://example.test/v1/chat/completions',
    getLocalModel: () => 'test-model',
    getLocalPromptMode: () => 'lite' as const,
  };
  return stub as unknown as Config;
}

function makeOkResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('OpenAICompatContentGenerator (Bearer auth path)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  beforeEach(() => {
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

  it('exports OpenAICompatContentGenerator as an alias for LocalLlmContentGenerator', () => {
    expect(OpenAICompatContentGenerator).toBe(LocalLlmContentGenerator);
  });

  it('local mode (no auth) does NOT send an Authorization header', async () => {
    const gen = new LocalLlmContentGenerator(
      'https://example.test/v1/chat/completions',
      'test-model',
      makeStubConfig(),
    );
    await gen.generateContent(
      {
        model: 'test-model',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      },
      'p-1',
      LlmRole.MAIN,
    );
    expect(fetchSpy).toHaveBeenCalled();
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('hosted-provider mode sends Authorization: Bearer <key>', async () => {
    const gen = new LocalLlmContentGenerator(
      'https://api.openai.com/v1/chat/completions',
      'gpt-4o-mini',
      makeStubConfig(),
      { apiKey: 'sk-PLAINTEXT-MARKER-12345' },
    );
    await gen.generateContent(
      {
        model: 'test-model',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      },
      'p-1',
      LlmRole.MAIN,
    );
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-PLAINTEXT-MARKER-12345');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('extraHeaders are merged AFTER the Bearer header so they can override', async () => {
    const gen = new LocalLlmContentGenerator(
      'https://openrouter.ai/api/v1/chat/completions',
      'meta/llama',
      makeStubConfig(),
      {
        apiKey: 'sk-test',
        extraHeaders: {
          'HTTP-Referer': 'https://example.com',
          'X-Title': 'gemini-cli',
        },
      },
    );
    await gen.generateContent(
      {
        model: 'test-model',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      },
      'p-1',
      LlmRole.MAIN,
    );
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-test');
    expect(headers['HTTP-Referer']).toBe('https://example.com');
    expect(headers['X-Title']).toBe('gemini-cli');
  });

  it('redaction: error message from non-2xx never contains the API key', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('upstream said no', { status: 401 }),
    );
    const gen = new LocalLlmContentGenerator(
      'https://api.openai.com/v1/chat/completions',
      'gpt-4o-mini',
      makeStubConfig(),
      { apiKey: 'sk-PLAINTEXT-MARKER-12345' },
    );
    let caught: unknown;
    try {
      await gen.generateContent(
        {
          model: 'test-model',
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        },
        'p-1',
        LlmRole.MAIN,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = caught instanceof Error ? caught.message : String(caught);
    expect(msg).toContain('HTTP 401');
    expect(msg).not.toContain('sk-PLAINTEXT-MARKER-12345');
  });
});
