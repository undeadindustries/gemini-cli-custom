/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
// Unit tests for OpenAIResponsesContentGenerator.
//
// These tests deliberately exercise the pure helpers (translation,
// SSE event mapping, usage mapping, chaining-input trimming) without
// spinning up an HTTP server. The class itself is wrapped around
// fetch() so a full round-trip test would need either a real socket
// or a fetch mock; those live in the integration suite.

import { describe, expect, it } from 'vitest';
import type { GenerateContentParameters } from '@google/genai';
import {
  createSseMapperState,
  mapSseEvent,
  responsesUsageToGemini,
  translateRequestToResponses,
  translateToolsToResponses,
  trimInputForChaining,
} from './openaiResponsesContentGenerator.js';

describe('translateToolsToResponses', () => {
  it('returns empty array for null / undefined / non-array input', () => {
    expect(translateToolsToResponses(null)).toEqual([]);
    expect(translateToolsToResponses(undefined)).toEqual([]);
    expect(translateToolsToResponses({})).toEqual([]);
    expect(translateToolsToResponses(42)).toEqual([]);
  });

  it('flattens functionDeclarations to the flat Responses shape', () => {
    const tools = [
      {
        functionDeclarations: [
          {
            name: 'read_file',
            description: 'Reads a file',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
            },
          },
          { name: 'write_file' },
        ],
      },
    ];
    const out = translateToolsToResponses(tools);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      type: 'function',
      name: 'read_file',
      description: 'Reads a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    });
    expect(out[1]).toMatchObject({
      type: 'function',
      name: 'write_file',
    });
    // Defaults parameters to a permissive object schema when missing.
    expect(out[1].parameters).toEqual({ type: 'object', properties: {} });
  });

  it('defaults missing parameters to an empty object schema', () => {
    const tools = [{ functionDeclarations: [{ name: 'noop' }] }];
    const out = translateToolsToResponses(tools);
    expect(out).toHaveLength(1);
    expect(out[0].parameters).toEqual({ type: 'object', properties: {} });
  });
});

describe('translateRequestToResponses', () => {
  it('lifts systemInstruction string into top-level instructions', () => {
    const req: GenerateContentParameters = {
      model: 'gpt-5',
      contents: [],
      config: { systemInstruction: 'be concise' },
    };
    const plan = translateRequestToResponses(req, { toolsEnabled: false });
    expect(plan.instructions).toBe('be concise');
  });

  it('maps user/model text to input_text / output_text correctly', () => {
    const req: GenerateContentParameters = {
      model: 'gpt-5',
      contents: [
        { role: 'user', parts: [{ text: 'hi' }] },
        { role: 'model', parts: [{ text: 'hello!' }] },
        { role: 'user', parts: [{ text: 'bye' }] },
      ],
    };
    const plan = translateRequestToResponses(req, { toolsEnabled: false });
    expect(plan.input).toHaveLength(3);
    expect(plan.input[0]).toMatchObject({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hi' }],
    });
    expect(plan.input[1]).toMatchObject({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'hello!' }],
    });
    expect(plan.input[2]).toMatchObject({ role: 'user' });
  });

  it('maps functionCall and functionResponse to dedicated items', () => {
    const req: GenerateContentParameters = {
      model: 'gpt-5',
      contents: [
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call_1',
                name: 'shell',
                args: { cmd: 'ls' },
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call_1',
                name: 'shell',
                response: { output: 'foo\nbar' },
              },
            },
          ],
        },
      ],
    };
    const plan = translateRequestToResponses(req, { toolsEnabled: false });
    expect(plan.input).toHaveLength(2);
    expect(plan.input[0]).toMatchObject({
      type: 'function_call',
      call_id: 'call_1',
      name: 'shell',
    });
    expect(plan.input[1]).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_1',
    });
  });

  it('omits tools when toolsEnabled=false even if request supplies them', () => {
    const req: GenerateContentParameters = {
      model: 'gpt-5',
      contents: [],
      config: {
        tools: [{ functionDeclarations: [{ name: 'noop' }] }],
      },
    };
    const plan = translateRequestToResponses(req, { toolsEnabled: false });
    expect(plan.tools).toEqual([]);
  });

  it('emits tools when toolsEnabled=true', () => {
    const req: GenerateContentParameters = {
      model: 'gpt-5',
      contents: [],
      config: {
        tools: [{ functionDeclarations: [{ name: 'noop' }] }],
      },
    };
    const plan = translateRequestToResponses(req, { toolsEnabled: true });
    expect(plan.tools).toHaveLength(1);
    expect(plan.tools[0]).toMatchObject({ type: 'function', name: 'noop' });
  });

  it('handles a string `contents` shortcut (treated as a single user turn)', () => {
    const req: GenerateContentParameters = {
      model: 'gpt-5',
      contents: 'hello' as unknown as GenerateContentParameters['contents'],
    };
    const plan = translateRequestToResponses(req, { toolsEnabled: false });
    expect(plan.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      },
    ]);
  });
});

describe('responsesUsageToGemini', () => {
  it('maps input/output/total tokens', () => {
    expect(
      responsesUsageToGemini({
        input_tokens: 12,
        output_tokens: 34,
        total_tokens: 46,
      }),
    ).toEqual({
      promptTokenCount: 12,
      candidatesTokenCount: 34,
      totalTokenCount: 46,
    });
  });

  it('falls back to input + output when total is missing', () => {
    expect(
      responsesUsageToGemini({ input_tokens: 7, output_tokens: 3 }),
    ).toEqual({
      promptTokenCount: 7,
      candidatesTokenCount: 3,
      totalTokenCount: 10,
    });
  });

  it('treats missing fields as zero', () => {
    expect(responsesUsageToGemini({})).toEqual({
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
    });
  });
});

describe('mapSseEvent', () => {
  it('emits a text chunk on output_text.delta', () => {
    const state = createSseMapperState();
    const out = [
      ...mapSseEvent(
        { type: 'response.output_text.delta', delta: 'hi' },
        state,
      ),
    ];
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('hi');
  });

  it('emits a thought chunk on reasoning_summary_text.delta', () => {
    const state = createSseMapperState();
    const out = [
      ...mapSseEvent(
        {
          type: 'response.reasoning_summary_text.delta',
          delta: 'thinking…',
        },
        state,
      ),
    ];
    expect(out).toHaveLength(1);
    const part = out[0].candidates?.[0]?.content?.parts?.[0] as
      | { thought?: boolean; text?: string }
      | undefined;
    expect(part?.thought).toBe(true);
    expect(part?.text).toContain('thinking');
  });

  it('accumulates function-call arguments across delta events', () => {
    const state = createSseMapperState();
    void [
      ...mapSseEvent(
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'function_call', call_id: 'c1', name: 'shell' },
        },
        state,
      ),
    ];
    void [
      ...mapSseEvent(
        {
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          delta: '{"cm',
        },
        state,
      ),
    ];
    void [
      ...mapSseEvent(
        {
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          delta: 'd":"ls"}',
        },
        state,
      ),
    ];
    const done = [
      ...mapSseEvent(
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'function_call',
            call_id: 'c1',
            name: 'shell',
            arguments: '{"cmd":"ls"}',
          },
        },
        state,
      ),
    ];
    expect(done).toHaveLength(1);
    const fc = done[0].candidates?.[0]?.content?.parts?.[0] as
      | { functionCall?: { name?: string; args?: Record<string, unknown> } }
      | undefined;
    expect(fc?.functionCall?.name).toBe('shell');
    expect(fc?.functionCall?.args).toEqual({ cmd: 'ls' });
  });

  it('records response.id and emits usage on response.completed', () => {
    const state = createSseMapperState();
    const out = [
      ...mapSseEvent(
        {
          type: 'response.completed',
          response: {
            id: 'resp_123',
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          },
        },
        state,
      ),
    ];
    expect(state.responseId).toBe('resp_123');
    expect(state.completed).toBe(true);
    expect(out).toHaveLength(1);
    expect(out[0].usageMetadata?.promptTokenCount).toBe(10);
    expect(out[0].usageMetadata?.candidatesTokenCount).toBe(5);
  });

  it('throws on response.failed / error events', () => {
    const state = createSseMapperState();
    expect(() => [
      ...mapSseEvent(
        {
          type: 'response.failed',
          response: { error: { message: 'boom' } },
        },
        state,
      ),
    ]).toThrow(/boom/);
  });

  it('ignores unknown event types without crashing', () => {
    const state = createSseMapperState();
    const out = [...mapSseEvent({ type: 'response.future_event_42' }, state)];
    expect(out).toHaveLength(0);
    expect(state.completed).toBe(false);
  });

  it('flushes pending tool calls if completion arrives before output_item.done', () => {
    const state = createSseMapperState();
    void [
      ...mapSseEvent(
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'function_call', call_id: 'c2', name: 'noop' },
        },
        state,
      ),
    ];
    void [
      ...mapSseEvent(
        {
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          delta: '{}',
        },
        state,
      ),
    ];
    const out = [
      ...mapSseEvent(
        {
          type: 'response.completed',
          response: { id: 'r', usage: { input_tokens: 1, output_tokens: 1 } },
        },
        state,
      ),
    ];
    // Expect the usage chunk + a flushed tool-call chunk.
    expect(out.length).toBeGreaterThanOrEqual(2);
  });
});

describe('trimInputForChaining', () => {
  it('returns the slice from the last user message to the end', () => {
    const input: Parameters<typeof trimInputForChaining>[0] = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'old' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'older' }],
      },
      { type: 'function_call', call_id: 'a', name: 'noop', arguments: '{}' },
      { type: 'function_call_output', call_id: 'a', output: '{}' },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'new turn' }],
      },
    ];
    const out = trimInputForChaining(input);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ role: 'user' });
  });

  it('falls back to function_call_output items if no user message', () => {
    const input: Parameters<typeof trimInputForChaining>[0] = [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'previous' }],
      },
      { type: 'function_call', call_id: 'a', name: 'shell', arguments: '{}' },
      { type: 'function_call_output', call_id: 'a', output: 'result' },
    ];
    const out = trimInputForChaining(input);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'function_call_output' });
  });

  it('returns empty array unchanged', () => {
    expect(trimInputForChaining([])).toEqual([]);
  });
});
// --- END LOCAL FORK ADDITION ---
