/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// --- LOCAL FORK ADDITION (Phase 2.4.6) ---
// Phase 2.4.6 — verifies the pre-flight model check added to
// LocalLlmContentGenerator. The check converts the silent foot-gun of
// shipping the 'local-model' placeholder to a hosted endpoint into a
// clear client-side error before any HTTP traffic.
//
// Allowlisted hostnames (placeholder permitted): localhost, 127.0.0.1,
// ::1, RFC1918 ranges (10.*, 192.168.*, 172.16-31.*), and the mDNS
// `.local` suffix. Anything else throws.
// --- END LOCAL FORK ADDITION ---

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LocalLlmContentGenerator } from './localLlmContentGenerator.js';
import type { Config } from '../config/config.js';
import { LlmRole } from '../telemetry/llmRole.js';

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

function makeOkResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-test',
      choices: [
        {
          finish_reason: 'stop',
          message: { content: 'hello', role: 'assistant' },
        },
      ],
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

describe('LocalLlmContentGenerator — pre-flight model check', () => {
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

  describe('throws on hosted endpoints', () => {
    const hostedUrls = [
      'https://api.openai.com/v1/chat/completions',
      'https://openrouter.ai/api/v1/chat/completions',
      'https://api.together.xyz/v1/chat/completions',
      'https://api.groq.com/openai/v1/chat/completions',
      'https://example.com/v1/chat/completions',
    ];
    for (const url of hostedUrls) {
      it(`throws and skips fetch for ${url}`, async () => {
        const gen = new LocalLlmContentGenerator(
          url,
          'local-model',
          makeStubConfig(),
        );
        await expect(
          gen.generateContent(sampleRequest, 'p-1', LlmRole.MAIN),
        ).rejects.toThrow(/No model configured/);
        expect(fetchSpy).not.toHaveBeenCalled();
      });

      it(`throws and skips fetch (stream) for ${url}`, async () => {
        const gen = new LocalLlmContentGenerator(
          url,
          'local-model',
          makeStubConfig(),
        );
        await expect(
          gen.generateContentStream(sampleRequest, 'p-1', LlmRole.MAIN),
        ).rejects.toThrow(/No model configured/);
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    }

    it('error message references /provider models for discoverability', async () => {
      const gen = new LocalLlmContentGenerator(
        'https://openrouter.ai/api/v1/chat/completions',
        'local-model',
        makeStubConfig(),
      );
      await expect(
        gen.generateContent(sampleRequest, 'p-1', LlmRole.MAIN),
      ).rejects.toThrow(/\/provider models/);
    });
  });

  describe('passes through for localhost / private-network endpoints', () => {
    const localUrls = [
      'http://localhost:8000/v1/chat/completions',
      'http://127.0.0.1:8000/v1/chat/completions',
      'http://[::1]:8000/v1/chat/completions',
      'http://10.0.0.5:8000/v1/chat/completions',
      'http://192.168.1.10:8000/v1/chat/completions',
      'http://172.16.0.1:8000/v1/chat/completions',
      'http://172.31.255.254:8000/v1/chat/completions',
      'http://my-rig.local:8000/v1/chat/completions',
    ];
    for (const url of localUrls) {
      it(`allows local-model placeholder for ${url}`, async () => {
        const gen = new LocalLlmContentGenerator(
          url,
          'local-model',
          makeStubConfig(),
        );
        await gen.generateContent(sampleRequest, 'p-1', LlmRole.MAIN);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      });
    }

    it('does NOT treat 172.15.* / 172.32.* as RFC1918 (those are public)', async () => {
      const gen = new LocalLlmContentGenerator(
        'http://172.15.0.1:8000/v1/chat/completions',
        'local-model',
        makeStubConfig(),
      );
      await expect(
        gen.generateContent(sampleRequest, 'p-1', LlmRole.MAIN),
      ).rejects.toThrow(/No model configured/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('does not interfere when a real model id is set', () => {
    it('fetches normally with a real model id even on hosted URL', async () => {
      const gen = new LocalLlmContentGenerator(
        'https://api.openai.com/v1/chat/completions',
        'gpt-4o-mini',
        makeStubConfig(),
      );
      await gen.generateContent(
        { ...sampleRequest, model: 'gpt-4o-mini' },
        'p-1',
        LlmRole.MAIN,
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });
});

// --- LOCAL FORK ADDITION (Phase 2.4.7: content-type guard tests) ---
describe('LocalLlmContentGenerator — content-type guard', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  function makeResponse(
    body: string,
    contentType: string | null,
    status = 200,
  ): Response {
    const headers: Record<string, string> = {};
    if (contentType !== null) headers['Content-Type'] = contentType;
    return new Response(body, { status, headers });
  }

  it('throws actionable error when 200 OK returns text/html (the OpenRouter root-URL case)', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        makeResponse(
          '<!DOCTYPE html><html>welcome to openrouter</html>',
          'text/html; charset=utf-8',
        ),
      );
    const gen = new LocalLlmContentGenerator(
      'https://openrouter.ai/api/v1',
      'deepseek/deepseek-v4-flash',
      makeStubConfig(),
    );
    await expect(
      gen.generateContent(
        {
          model: 'deepseek/deepseek-v4-flash',
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        },
        'p-1',
        LlmRole.MAIN,
      ),
    ).rejects.toThrow(/unexpected Content-Type "text\/html/);
  });

  it('error message contains URL and body preview so the user can diagnose', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        makeResponse('<!DOCTYPE html><html>welcome</html>', 'text/html'),
      );
    const gen = new LocalLlmContentGenerator(
      'https://openrouter.ai/api/v1',
      'deepseek/deepseek-v4-flash',
      makeStubConfig(),
    );
    await expect(
      gen.generateContent(
        {
          model: 'deepseek/deepseek-v4-flash',
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        },
        'p-1',
        LlmRole.MAIN,
      ),
    ).rejects.toThrow(/openrouter\.ai\/api\/v1.*welcome/s);
  });

  it('throws on stream path when 200 OK returns text/html (silent-failure case)', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeResponse('<html></html>', 'text/html'));
    const gen = new LocalLlmContentGenerator(
      'https://openrouter.ai/api/v1',
      'deepseek/deepseek-v4-flash',
      makeStubConfig(),
    );
    await expect(
      gen.generateContentStream(
        {
          model: 'deepseek/deepseek-v4-flash',
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        },
        'p-1',
        LlmRole.MAIN,
      ),
    ).rejects.toThrow(/unexpected Content-Type/);
  });

  it('accepts application/json with charset on non-stream path', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeResponse(
        JSON.stringify({
          id: 'x',
          choices: [
            {
              finish_reason: 'stop',
              message: { content: 'ok', role: 'assistant' },
            },
          ],
        }),
        'application/json; charset=utf-8',
      ),
    );
    const gen = new LocalLlmContentGenerator(
      'https://api.openai.com/v1/chat/completions',
      'gpt-4o-mini',
      makeStubConfig(),
    );
    await expect(
      gen.generateContent(
        {
          model: 'gpt-4o-mini',
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        },
        'p-1',
        LlmRole.MAIN,
      ),
    ).resolves.toBeDefined();
  });

  it('accepts text/event-stream on stream path', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeResponse('', 'text/event-stream'));
    const gen = new LocalLlmContentGenerator(
      'https://api.openai.com/v1/chat/completions',
      'gpt-4o-mini',
      makeStubConfig(),
    );
    await expect(
      gen.generateContentStream(
        {
          model: 'gpt-4o-mini',
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        },
        'p-1',
        LlmRole.MAIN,
      ),
    ).resolves.toBeDefined();
  });

  it('rejects text/plain on stream path (covers misconfigured upstream proxy)', async () => {
    // Note: the Fetch spec auto-sets `text/plain;charset=utf-8` when you
    // construct a Response from a string without an explicit Content-Type,
    // so passing `null` here is equivalent to no header being set in the
    // wild. Either way, text/plain on the stream path is always a routing
    // problem worth surfacing.
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeResponse('garbage', null));
    const gen = new LocalLlmContentGenerator(
      'https://example.com/v1/chat/completions',
      'gpt-4o-mini',
      makeStubConfig(),
    );
    await expect(
      gen.generateContentStream(
        {
          model: 'gpt-4o-mini',
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        },
        'p-1',
        LlmRole.MAIN,
      ),
    ).rejects.toThrow(/unexpected Content-Type "text\/plain/);
  });

  it('rejects text/xml or other non-JSON, non-SSE types', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        makeResponse('<error>oops</error>', 'application/xml'),
      );
    const gen = new LocalLlmContentGenerator(
      'https://example.com/v1/chat/completions',
      'gpt-4o-mini',
      makeStubConfig(),
    );
    await expect(
      gen.generateContent(
        {
          model: 'gpt-4o-mini',
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        },
        'p-1',
        LlmRole.MAIN,
      ),
    ).rejects.toThrow(/unexpected Content-Type "application\/xml"/);
  });
});
// --- END LOCAL FORK ADDITION ---

// --- LOCAL FORK ADDITION (Phase 2.4.7: system-prompt override tests) ---
describe('LocalLlmContentGenerator — system-prompt override', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  function makeStubConfigWithOverride(override: string | undefined): Config {
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
      getLocalUrl: () => 'http://localhost:8000/v1/chat/completions',
      getLocalModel: () => 'gpt-oss',
      getLocalPromptMode: () => 'lite' as const,
      getEffectiveProviderConfig: () =>
        override === undefined ? undefined : { systemPromptOverride: override },
    };
    return stub as unknown as Config;
  }

  it('replaces upstream system prompt when override is set', async () => {
    let capturedBody: { messages: Array<{ role: string; content: string }> } = {
      messages: [],
    };
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_url, init) => {
        capturedBody = JSON.parse(
          (init as RequestInit).body as string,
        ) as typeof capturedBody;
        return makeOkResponse();
      });
    const gen = new LocalLlmContentGenerator(
      'http://localhost:8000/v1/chat/completions',
      'gpt-oss',
      makeStubConfigWithOverride('You are a helpful coding assistant.'),
    );
    await gen.generateContent(
      {
        model: 'gpt-oss',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        config: {
          systemInstruction: {
            role: 'system',
            parts: [
              {
                text: 'You are an interactive CLI agent. (long Gemini CLI preamble omitted)',
              },
            ],
          },
        },
      },
      'p-1',
      LlmRole.MAIN,
    );
    const sysMsg = capturedBody.messages.find((m) => m.role === 'system');
    expect(sysMsg).toBeDefined();
    expect(sysMsg?.content).toBe('You are a helpful coding assistant.');
    expect(sysMsg?.content).not.toContain('Gemini');
  });

  it('preserves upstream system prompt when override is empty string', async () => {
    let capturedBody: { messages: Array<{ role: string; content: string }> } = {
      messages: [],
    };
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_url, init) => {
        capturedBody = JSON.parse(
          (init as RequestInit).body as string,
        ) as typeof capturedBody;
        return makeOkResponse();
      });
    const gen = new LocalLlmContentGenerator(
      'http://localhost:8000/v1/chat/completions',
      'gpt-oss',
      makeStubConfigWithOverride(''),
    );
    await gen.generateContent(
      {
        model: 'gpt-oss',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        config: {
          systemInstruction: {
            role: 'system',
            parts: [{ text: 'Original Gemini prompt.' }],
          },
        },
      },
      'p-1',
      LlmRole.MAIN,
    );
    const sysMsg = capturedBody.messages.find((m) => m.role === 'system');
    expect(sysMsg?.content).toBe('Original Gemini prompt.');
  });

  it('preserves upstream system prompt when getEffectiveProviderConfig is undefined', async () => {
    let capturedBody: { messages: Array<{ role: string; content: string }> } = {
      messages: [],
    };
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_url, init) => {
        capturedBody = JSON.parse(
          (init as RequestInit).body as string,
        ) as typeof capturedBody;
        return makeOkResponse();
      });
    const gen = new LocalLlmContentGenerator(
      'http://localhost:8000/v1/chat/completions',
      'gpt-oss',
      makeStubConfigWithOverride(undefined),
    );
    await gen.generateContent(
      {
        model: 'gpt-oss',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        config: {
          systemInstruction: {
            role: 'system',
            parts: [{ text: 'Original Gemini prompt.' }],
          },
        },
      },
      'p-1',
      LlmRole.MAIN,
    );
    const sysMsg = capturedBody.messages.find((m) => m.role === 'system');
    expect(sysMsg?.content).toBe('Original Gemini prompt.');
  });
});
// --- END LOCAL FORK ADDITION ---
