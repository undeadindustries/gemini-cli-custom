/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// --- LOCAL FORK ADDITION (Phase 2.4.6) ---
// Symmetric pre-flight check tests for OpenAIResponsesContentGenerator.
// In practice the Responses API default model is `'gpt-5'` (a real id),
// so this branch is far less likely to trigger than its Chat-Completions
// sibling. We still test it so a custom Responses-API provider added
// without a model gets the same actionable error rather than an opaque
// HTTP 400 from the upstream endpoint.
// --- END LOCAL FORK ADDITION ---

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIResponsesContentGenerator } from './openaiResponsesContentGenerator.js';
import type { Config } from '../config/config.js';
import { LlmRole } from '../telemetry/llmRole.js';

function makeStubConfig(): Config {
  const stub = {
    getLocalTimeout: () => 5_000,
    getLocalTemperature: () => null,
    isLocalToolsEnabled: () => false,
    getEffectiveProviderConfig: () => undefined,
    getLastResponseId: () => undefined,
    setLastResponseId: vi.fn(),
    clearLastResponseId: vi.fn(),
    getReasoningEffort: () => undefined,
    getSessionReasoningEffortOverride: () => undefined,
  };
  return stub as unknown as Config;
}

function makeOkResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'resp_test',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'hello' }],
        },
      ],
      usage: {},
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

const sampleRequest = {
  model: 'local-model',
  contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
};

describe('OpenAIResponsesContentGenerator — pre-flight model check', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeOkResponse());
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('throws on hosted endpoint with local-model placeholder', async () => {
    const gen = new OpenAIResponsesContentGenerator(
      'https://api.openai.com/v1/responses',
      'local-model',
      makeStubConfig(),
    );
    await expect(
      gen.generateContent(sampleRequest, 'p-1', LlmRole.MAIN),
    ).rejects.toThrow(/No model configured for Responses API provider/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws on hosted endpoint (stream) with local-model placeholder', async () => {
    const gen = new OpenAIResponsesContentGenerator(
      'https://api.openai.com/v1/responses',
      'local-model',
      makeStubConfig(),
    );
    await expect(
      gen.generateContentStream(sampleRequest, 'p-1', LlmRole.MAIN),
    ).rejects.toThrow(/No model configured for Responses API provider/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('passes through for localhost with local-model placeholder', async () => {
    const gen = new OpenAIResponsesContentGenerator(
      'http://localhost:8000/v1/responses',
      'local-model',
      makeStubConfig(),
    );
    await gen.generateContent(sampleRequest, 'p-1', LlmRole.MAIN);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('passes through for RFC1918 hostnames with local-model placeholder', async () => {
    const gen = new OpenAIResponsesContentGenerator(
      'http://192.168.1.50:8000/v1/responses',
      'local-model',
      makeStubConfig(),
    );
    await gen.generateContent(sampleRequest, 'p-1', LlmRole.MAIN);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('passes through with a real model id even on hosted URL', async () => {
    const gen = new OpenAIResponsesContentGenerator(
      'https://api.openai.com/v1/responses',
      'gpt-5-codex',
      makeStubConfig(),
    );
    await gen.generateContent(
      { ...sampleRequest, model: 'gpt-5-codex' },
      'p-1',
      LlmRole.MAIN,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// --- LOCAL FORK ADDITION (Phase 2.4.7: content-type guard tests) ---
describe('OpenAIResponsesContentGenerator — content-type guard', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  function makeResponse(
    body: string,
    contentType: string,
    status = 200,
  ): Response {
    return new Response(body, {
      status,
      headers: { 'Content-Type': contentType },
    });
  }

  it('throws when 200 OK returns text/html (root-URL misconfiguration)', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeResponse('<html>welcome</html>', 'text/html'));
    const gen = new OpenAIResponsesContentGenerator(
      'https://api.openai.com/v1',
      'gpt-5-codex',
      makeStubConfig(),
    );
    await expect(
      gen.generateContent(
        {
          model: 'gpt-5-codex',
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        },
        'p-1',
        LlmRole.MAIN,
      ),
    ).rejects.toThrow(/unexpected Content-Type "text\/html/);
  });

  it('throws on stream path when 200 OK returns text/html', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeResponse('<html></html>', 'text/html'));
    const gen = new OpenAIResponsesContentGenerator(
      'https://api.openai.com/v1',
      'gpt-5-codex',
      makeStubConfig(),
    );
    await expect(
      gen.generateContentStream(
        {
          model: 'gpt-5-codex',
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        },
        'p-1',
        LlmRole.MAIN,
      ),
    ).rejects.toThrow(/unexpected Content-Type "text\/html/);
  });

  it('mentions /v1/responses in the diagnostic hint', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeResponse('<html></html>', 'text/html'));
    const gen = new OpenAIResponsesContentGenerator(
      'https://api.openai.com/v1',
      'gpt-5-codex',
      makeStubConfig(),
    );
    await expect(
      gen.generateContent(
        {
          model: 'gpt-5-codex',
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        },
        'p-1',
        LlmRole.MAIN,
      ),
    ).rejects.toThrow(/\/v1\/responses/);
  });

  it('accepts text/event-stream on stream path', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeResponse('', 'text/event-stream'));
    const gen = new OpenAIResponsesContentGenerator(
      'https://api.openai.com/v1/responses',
      'gpt-5-codex',
      makeStubConfig(),
    );
    await expect(
      gen.generateContentStream(
        {
          model: 'gpt-5-codex',
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        },
        'p-1',
        LlmRole.MAIN,
      ),
    ).resolves.toBeDefined();
  });
});
// --- END LOCAL FORK ADDITION ---
