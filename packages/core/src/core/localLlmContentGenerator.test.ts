/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * --- LOCAL FORK ADDITION (Phase 1 + Phase 2.0.4) ---
 * Unit tests for translateToolsToOpenAI and mistralSafeToolCallId.
 */

import { describe, it, expect } from 'vitest';
import {
  translateToolsToOpenAI,
  mistralSafeToolCallId,
  isMistralFamilyModel,
  patchToolUserTransitionForMistral,
  patchOrphanedToolCallsForMistral,
  buildNonStreamRetryBody,
  parseXmlToolCalls,
  MISTRAL_TOOL_USER_BRIDGE_CONTENT,
  ORPHANED_TOOL_RESPONSE_CONTENT,
  type OpenAIMessage,
} from './localLlmContentGenerator.js';

describe('translateToolsToOpenAI', () => {
  it('returns an empty array for null/undefined input', () => {
    expect(translateToolsToOpenAI(null)).toEqual([]);
    expect(translateToolsToOpenAI(undefined)).toEqual([]);
  });

  it('returns an empty array for a non-array input', () => {
    expect(translateToolsToOpenAI('not-an-array')).toEqual([]);
    expect(translateToolsToOpenAI(42)).toEqual([]);
  });

  it('returns an empty array for an empty tools array', () => {
    expect(translateToolsToOpenAI([])).toEqual([]);
  });

  it('translates a tool with a full parameters schema', () => {
    const schema = {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    };
    const tools = [
      {
        functionDeclarations: [
          {
            name: 'read_file',
            description: 'Reads a file',
            parameters: schema,
          },
        ],
      },
    ];
    const result = translateToolsToOpenAI(tools);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Reads a file',
        parameters: schema,
      },
    });
  });

  it('defaults parameters to { type: "object", properties: {} } when null (Devstral / strict-spec fix)', () => {
    const tools = [
      {
        functionDeclarations: [
          {
            name: 'no_args_tool',
            description: 'A tool with no args',
            parameters: null,
          },
        ],
      },
    ];
    const result = translateToolsToOpenAI(tools);
    expect(result).toHaveLength(1);
    expect(result[0].function.parameters).toEqual({
      type: 'object',
      properties: {},
    });
  });

  it('defaults parameters to { type: "object", properties: {} } when undefined', () => {
    const tools = [
      {
        functionDeclarations: [
          { name: 'no_args_tool', description: 'A zero-arg tool' },
        ],
      },
    ];
    const result = translateToolsToOpenAI(tools);
    expect(result).toHaveLength(1);
    expect(result[0].function.parameters).toEqual({
      type: 'object',
      properties: {},
    });
  });

  it('handles mixed tools — some with parameters, some without', () => {
    const schema = { type: 'object', properties: { q: { type: 'string' } } };
    const tools = [
      {
        functionDeclarations: [
          { name: 'has_params', parameters: schema },
          { name: 'no_params' },
        ],
      },
    ];
    const result = translateToolsToOpenAI(tools);
    expect(result).toHaveLength(2);
    expect(result[0].function.parameters).toEqual(schema);
    expect(result[1].function.parameters).toEqual({
      type: 'object',
      properties: {},
    });
  });

  it('skips entries that are not functionDeclarations tools', () => {
    const tools = [
      { someOtherKey: 'ignored' },
      { functionDeclarations: [{ name: 'valid_tool' }] },
    ];
    const result = translateToolsToOpenAI(tools);
    expect(result).toHaveLength(1);
    expect(result[0].function.name).toBe('valid_tool');
  });

  it('uses an empty string for name when declaration name is missing', () => {
    const tools = [
      { functionDeclarations: [{ description: 'nameless tool' }] },
    ];
    const result = translateToolsToOpenAI(tools);
    expect(result[0].function.name).toBe('');
  });
});

describe('mistralSafeToolCallId (Phase 2.0.4 Devstral / Mistral fix)', () => {
  /**
   * The contract Mistral's vLLM tool-call parser enforces:
   * exactly 9 characters, every character matches /[a-zA-Z0-9]/.
   * Every test below should round-trip through this assertion.
   */
  const MISTRAL_RE = /^[a-zA-Z0-9]{9}$/;

  it('always returns exactly 9 characters', () => {
    const samples = [
      'call_read_file_0',
      'call_x_0',
      'a',
      '',
      'call_run_shell_command_999',
      'AbC',
      'call_!@#$%^&*()_+_0',
    ];
    for (const s of samples) {
      const out = mistralSafeToolCallId(s);
      expect(out, `input "${s}"`).toHaveLength(9);
    }
  });

  it('always returns alphanumeric-only output (Mistral contract)', () => {
    const samples = [
      'call_read_file_0',
      'tool_call::id-with-dashes',
      'snake_case_id_42',
      'kebab-case-id-7',
      'mixed_!@#0',
      '____',
      '',
    ];
    for (const s of samples) {
      const out = mistralSafeToolCallId(s);
      expect(out, `input "${s}" produced "${out}"`).toMatch(MISTRAL_RE);
    }
  });

  it('is deterministic — same input always produces same output (so paired ids collide)', () => {
    const inputs = ['call_read_file_0', 'call_write_file_1', 'foo', ''];
    for (const input of inputs) {
      expect(mistralSafeToolCallId(input)).toBe(mistralSafeToolCallId(input));
    }
  });

  it('preserves sibling uniqueness — counter suffix lives in the trailing chars', () => {
    // The bug-prone case: long names share a prefix; we must NOT collapse
    // them to the same 9-char id, otherwise Mistral correlates the wrong
    // tool response to the wrong call.
    const a = mistralSafeToolCallId('call_read_file_0');
    const b = mistralSafeToolCallId('call_read_file_1');
    const c = mistralSafeToolCallId('call_read_file_2');
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);

    // And for very different counter widths (base-10 boundary) — still unique.
    const d10 = mistralSafeToolCallId('call_read_file_9');
    const d11 = mistralSafeToolCallId('call_read_file_10');
    expect(d10).not.toBe(d11);
  });

  it('keeps long-name calls disambiguated from each other by their counter', () => {
    const a = mistralSafeToolCallId('call_run_shell_command_0');
    const b = mistralSafeToolCallId('call_run_shell_command_1');
    expect(a).not.toBe(b);
    expect(a).toMatch(MISTRAL_RE);
    expect(b).toMatch(MISTRAL_RE);
  });

  it('left-pads with "0" when the cleaned input is shorter than 9 chars', () => {
    expect(mistralSafeToolCallId('a')).toBe('00000000a');
    expect(mistralSafeToolCallId('ab')).toBe('0000000ab');
    expect(mistralSafeToolCallId('a_0')).toBe('0000000a0');
    expect(mistralSafeToolCallId('')).toBe('000000000');
  });

  it('returns the trailing 9 chars when the cleaned input is longer than 9', () => {
    // The trailing chars carry the counter suffix from contentToMessages,
    // which is exactly what we need to keep siblings unique.
    expect(mistralSafeToolCallId('call_read_file_0')).toBe('readfile0');
    expect(mistralSafeToolCallId('call_read_file_1')).toBe('readfile1');
    expect(mistralSafeToolCallId('call_write_file_0')).toBe('ritefile0');
  });

  it('is idempotent on already-valid 9-char alphanumeric ids (Mistral round-trip)', () => {
    const validIds = ['readfile0', 'abcXYZ123', '000000000', '9aZbY8cX7'];
    for (const id of validIds) {
      expect(mistralSafeToolCallId(id)).toBe(id);
    }
  });

  it('matches the assistant tool_call id with the paired tool_call_id (the regression Mistral hit)', () => {
    // Mirrors the production code path in contentToMessages: the assistant
    // turn generates the id from `call_${name}_${counter}` and the tool
    // turn generates tool_call_id from the SAME template with the SAME
    // (name, counter). Both must produce identical sanitized ids or vLLM
    // rejects the pair with HTTP 400.
    const name = 'read_file';
    const counter = 0;
    const raw = `call_${name}_${counter}`;
    const assistantId = mistralSafeToolCallId(raw);
    const toolCallId = mistralSafeToolCallId(raw);
    expect(assistantId).toBe(toolCallId);
    expect(assistantId).toMatch(MISTRAL_RE);
  });
});

// --- LOCAL FORK ADDITION (Phase 2.0.5) ---
describe('isMistralFamilyModel', () => {
  it.each([
    'mistralai/Mistral-7B-Instruct-v0.3',
    'mistralai/Mistral-Large-Instruct-2411',
    'mistralai/Devstral-Small-2-24B-Instruct-2512',
    'mistralai/Mixtral-8x7B-Instruct-v0.1',
    'mistralai/Codestral-22B-v0.1',
    'mistralai/Magistral-Small-2506',
    'mistralai/Ministral-8B-Instruct-2410',
    'DEVSTRAL-uppercase-test',
    'some-org/devstral-finetune',
  ])('classifies %s as Mistral family', (modelId) => {
    expect(isMistralFamilyModel(modelId)).toBe(true);
  });

  it.each([
    'Qwen/Qwen3-Coder-Next-FP8',
    'google/gemma-2-27b-it',
    'meta-llama/Llama-3.1-70B-Instruct',
    'openai/gpt-4o',
    'anthropic/claude-3-5-sonnet',
    'deepseek-ai/DeepSeek-V3',
    'microsoft/phi-4',
    '01-ai/Yi-34B-Chat',
    'cohere/command-r-plus',
    '',
  ])('does NOT classify %s as Mistral family', (modelId) => {
    expect(isMistralFamilyModel(modelId)).toBe(false);
  });
});

describe('patchToolUserTransitionForMistral', () => {
  const MISTRAL_MODEL = 'mistralai/Devstral-Small-2-24B-Instruct-2512';
  const QWEN_MODEL = 'Qwen/Qwen3-Coder-Next-FP8';

  const userMsg = (content: string): OpenAIMessage => ({
    role: 'user',
    content,
  });
  const assistantMsg = (content: string): OpenAIMessage => ({
    role: 'assistant',
    content,
  });
  const toolMsg = (id: string, content: string): OpenAIMessage => ({
    role: 'tool',
    tool_call_id: id,
    content,
  });

  it('returns the input unchanged for non-Mistral models even when a tool→user transition exists', () => {
    const messages: OpenAIMessage[] = [
      userMsg('do the thing'),
      assistantMsg('working on it'),
      toolMsg('readfile0', 'file contents'),
      userMsg('now do the next thing'),
    ];
    const result = patchToolUserTransitionForMistral(messages, QWEN_MODEL);
    expect(result).toEqual(messages);
    // Same reference is acceptable: the contract is "no mutation, identical content".
    expect(result).toHaveLength(messages.length);
  });

  it('inserts a synthetic assistant message between a tool and a following user message for Mistral', () => {
    const messages: OpenAIMessage[] = [
      userMsg('do the thing'),
      assistantMsg('working'),
      toolMsg('readfile0', 'contents'),
      userMsg('now do the next thing'),
    ];
    const result = patchToolUserTransitionForMistral(messages, MISTRAL_MODEL);
    expect(result).toHaveLength(messages.length + 1);
    expect(result[2]).toEqual(messages[2]); // tool unchanged
    expect(result[3]).toEqual({
      role: 'assistant',
      content: MISTRAL_TOOL_USER_BRIDGE_CONTENT,
    });
    expect(result[4]).toEqual(messages[3]); // user preserved verbatim
  });

  it('does NOT insert when a tool message is followed by an assistant message', () => {
    const messages: OpenAIMessage[] = [
      userMsg('q'),
      assistantMsg('thinking'),
      toolMsg('readfile0', 'contents'),
      assistantMsg('here is the answer'),
    ];
    const result = patchToolUserTransitionForMistral(messages, MISTRAL_MODEL);
    expect(result).toEqual(messages);
  });

  it('does NOT insert when a tool message is the last message in the array', () => {
    const messages: OpenAIMessage[] = [
      userMsg('q'),
      assistantMsg('thinking'),
      toolMsg('readfile0', 'contents'),
    ];
    const result = patchToolUserTransitionForMistral(messages, MISTRAL_MODEL);
    expect(result).toEqual(messages);
  });

  it('does NOT touch user→tool transitions (those are normal)', () => {
    const messages: OpenAIMessage[] = [
      userMsg('q'),
      assistantMsg('thinking'),
      toolMsg('readfile0', 'contents'),
    ];
    const result = patchToolUserTransitionForMistral(messages, MISTRAL_MODEL);
    expect(result).toEqual(messages);
  });

  it('inserts a bridge for every tool→user transition when there are multiple', () => {
    const messages: OpenAIMessage[] = [
      userMsg('q1'),
      toolMsg('aaaaaaaaa', 'r1'),
      userMsg('q2'),
      toolMsg('bbbbbbbbb', 'r2'),
      userMsg('q3'),
    ];
    const result = patchToolUserTransitionForMistral(messages, MISTRAL_MODEL);
    // Two tool→user pairs → two synthetic bridges.
    const bridges = result.filter(
      (m) =>
        m.role === 'assistant' &&
        m.content === MISTRAL_TOOL_USER_BRIDGE_CONTENT,
    );
    expect(bridges).toHaveLength(2);
    expect(result).toHaveLength(messages.length + 2);
    // Order is preserved with bridges interleaved correctly.
    expect(result.map((m) => m.role)).toEqual([
      'user',
      'tool',
      'assistant',
      'user',
      'tool',
      'assistant',
      'user',
    ]);
  });

  it('handles consecutive tool messages (multi-tool turn) followed by a user message — bridge inserted only once after the LAST tool', () => {
    const messages: OpenAIMessage[] = [
      userMsg('q'),
      assistantMsg('calling two tools'),
      toolMsg('aaaaaaaaa', 'result_a'),
      toolMsg('bbbbbbbbb', 'result_b'),
      userMsg('follow up'),
    ];
    const result = patchToolUserTransitionForMistral(messages, MISTRAL_MODEL);
    const bridges = result.filter(
      (m) =>
        m.role === 'assistant' &&
        m.content === MISTRAL_TOOL_USER_BRIDGE_CONTENT,
    );
    expect(bridges).toHaveLength(1);
    expect(result.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant', // bridge inserted between tool→user only
      'user',
    ]);
  });

  it('handles an empty messages array', () => {
    expect(patchToolUserTransitionForMistral([], MISTRAL_MODEL)).toEqual([]);
    expect(patchToolUserTransitionForMistral([], QWEN_MODEL)).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const messages: OpenAIMessage[] = [
      toolMsg('aaaaaaaaa', 'r1'),
      userMsg('q'),
    ];
    const snapshot = JSON.parse(JSON.stringify(messages));
    patchToolUserTransitionForMistral(messages, MISTRAL_MODEL);
    expect(messages).toEqual(snapshot);
  });

  it('uses a non-empty bridge content (some servers also reject empty assistant content)', () => {
    expect(MISTRAL_TOOL_USER_BRIDGE_CONTENT.length).toBeGreaterThan(0);
  });
});
// --- END LOCAL FORK ADDITION ---

// --- LOCAL FORK ADDITION (Phase 2.0.6) ---
describe('patchOrphanedToolCallsForMistral', () => {
  const MISTRAL_MODEL = 'mistralai/Devstral-Small-2-24B-Instruct-2512';
  const QWEN_MODEL = 'Qwen/Qwen3-Coder-Next-FP8';

  const makeToolCall = (id: string, name = 'fn') => ({
    id,
    type: 'function' as const,
    function: { name, arguments: '{}' },
  });

  const assistantWithCalls = (ids: string[]): OpenAIMessage => ({
    role: 'assistant',
    content: null,
    tool_calls: ids.map((id) => makeToolCall(id)),
  });

  const toolResponse = (id: string, content = 'ok'): OpenAIMessage => ({
    role: 'tool',
    tool_call_id: id,
    content,
  });

  it('returns the input unchanged for non-Mistral models even when orphans exist', () => {
    const messages: OpenAIMessage[] = [
      assistantWithCalls(['aaaaaaaaa', 'bbbbbbbbb']),
      toolResponse('aaaaaaaaa'), // only one response — bbbbbbbbb is orphaned
    ];
    const result = patchOrphanedToolCallsForMistral(messages, QWEN_MODEL);
    expect(result).toEqual(messages);
  });

  it('is a no-op when all tool calls have responses', () => {
    const messages: OpenAIMessage[] = [
      assistantWithCalls(['aaaaaaaaa', 'bbbbbbbbb']),
      toolResponse('aaaaaaaaa'),
      toolResponse('bbbbbbbbb'),
    ];
    const result = patchOrphanedToolCallsForMistral(messages, MISTRAL_MODEL);
    expect(result).toEqual(messages);
  });

  it('inserts a synthetic tool response for a single orphaned call', () => {
    const messages: OpenAIMessage[] = [
      assistantWithCalls(['aaaaaaaaa', 'bbbbbbbbb']),
      toolResponse('aaaaaaaaa'),
      // bbbbbbbbb has no response — timeout scenario
    ];
    const result = patchOrphanedToolCallsForMistral(messages, MISTRAL_MODEL);
    expect(result).toHaveLength(3);
    expect(result[2]).toEqual({
      role: 'tool',
      tool_call_id: 'bbbbbbbbb',
      content: ORPHANED_TOOL_RESPONSE_CONTENT,
    });
  });

  it('fills all orphans when no responses were stored at all', () => {
    const messages: OpenAIMessage[] = [
      assistantWithCalls(['aaaaaaaaa', 'bbbbbbbbb', 'ccccccccc']),
      // all three calls are orphaned — extreme timeout at turn start
    ];
    const result = patchOrphanedToolCallsForMistral(messages, MISTRAL_MODEL);
    expect(result).toHaveLength(4); // 1 assistant + 3 synthetic tools
    const toolMsgs = result.filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual([
      'aaaaaaaaa',
      'bbbbbbbbb',
      'ccccccccc',
    ]);
    expect(
      toolMsgs.every((m) => m.content === ORPHANED_TOOL_RESPONSE_CONTENT),
    ).toBe(true);
  });

  it('handles multiple assistant-tool-call blocks in one history correctly', () => {
    const messages: OpenAIMessage[] = [
      assistantWithCalls(['aaaaaaaaa', 'bbbbbbbbb']),
      toolResponse('aaaaaaaaa'),
      toolResponse('bbbbbbbbb'),
      { role: 'user', content: 'follow up' },
      assistantWithCalls(['ccccccccc', 'ddddddddd']),
      toolResponse('ccccccccc'),
      // ddddddddd orphaned in the second block
    ];
    const result = patchOrphanedToolCallsForMistral(messages, MISTRAL_MODEL);
    // One synthetic tool added after second block; first block unchanged.
    // Input: 6 messages + 1 synthetic = 7 total.
    expect(result).toHaveLength(7);
    expect(result[6]).toEqual({
      role: 'tool',
      tool_call_id: 'ddddddddd',
      content: ORPHANED_TOOL_RESPONSE_CONTENT,
    });
  });

  it('preserves original order of real tool responses then appends orphan synthetics', () => {
    const messages: OpenAIMessage[] = [
      assistantWithCalls(['aaaaaaaaa', 'bbbbbbbbb', 'ccccccccc']),
      toolResponse('ccccccccc', 'last-answered'),
      // aaaaaaaaa and bbbbbbbbb orphaned (responses arrived out of order)
    ];
    const result = patchOrphanedToolCallsForMistral(messages, MISTRAL_MODEL);
    expect(result[1]).toEqual(toolResponse('ccccccccc', 'last-answered'));
    const orphans = result.slice(2);
    expect(new Set(orphans.map((m) => m.tool_call_id))).toEqual(
      new Set(['aaaaaaaaa', 'bbbbbbbbb']),
    );
  });

  it('does not touch messages with no tool_calls', () => {
    const messages: OpenAIMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    const result = patchOrphanedToolCallsForMistral(messages, MISTRAL_MODEL);
    expect(result).toEqual(messages);
  });

  it('does not mutate the input array', () => {
    const messages: OpenAIMessage[] = [
      assistantWithCalls(['aaaaaaaaa']),
      // no response — orphan
    ];
    const snapshot = JSON.parse(JSON.stringify(messages));
    patchOrphanedToolCallsForMistral(messages, MISTRAL_MODEL);
    expect(messages).toEqual(snapshot);
  });

  it('handles an empty messages array', () => {
    expect(patchOrphanedToolCallsForMistral([], MISTRAL_MODEL)).toEqual([]);
    expect(patchOrphanedToolCallsForMistral([], QWEN_MODEL)).toEqual([]);
  });

  it('orphaned_tool_response content is valid JSON', () => {
    expect(() => JSON.parse(ORPHANED_TOOL_RESPONSE_CONTENT)).not.toThrow();
  });
});

// --- LOCAL FORK ADDITION (Phase 2.0.8) ---
/**
 * Combined-patch order tests.  Reproduces the resumed-session bug where
 * patchOrphanedToolCallsForMistral synthesises a tool response immediately
 * before an existing user message and creates a fresh tool→user violation.
 * The fix is to run the transition patch LAST so it cleans up any
 * tool→user introduced by the orphan patch.
 */
describe('Mistral patch order (Phase 2.0.8)', () => {
  const MISTRAL_MODEL = 'mistralai/Devstral-Small-2-24B-Instruct-2512';

  const makeToolCall = (id: string, name = 'fn') => ({
    id,
    type: 'function' as const,
    function: { name, arguments: '{}' },
  });

  const assistantWithCalls = (ids: string[]): OpenAIMessage => ({
    role: 'assistant',
    content: null,
    tool_calls: ids.map((id) => makeToolCall(id)),
  });

  const findToolUserViolation = (arr: OpenAIMessage[]): number => {
    for (let i = 0; i < arr.length - 1; i++) {
      if (arr[i].role === 'tool' && arr[i + 1].role === 'user') return i;
    }
    return -1;
  };

  it('resume scenario: orphan-then-transition produces zero tool→user violations', () => {
    // Resumed session: previous turn's tool call was interrupted (no
    // matching tool response was recorded), then the user typed a new
    // follow-up message.
    const messages: OpenAIMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first prompt' },
      assistantWithCalls(['lreplace0']),
      // <-- no tool response here (orphaned by timeout/interrupt) -->
      { role: 'user', content: 'follow up after resume' },
    ];

    const afterOrphan = patchOrphanedToolCallsForMistral(
      messages,
      MISTRAL_MODEL,
    );
    const final = patchToolUserTransitionForMistral(afterOrphan, MISTRAL_MODEL);

    expect(findToolUserViolation(final)).toBe(-1);
    expect(final.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant', // original assistant with tool_calls
      'tool', // synthesised orphan response
      'assistant', // bridge inserted by transition patch
      'user', // resumed follow-up
    ]);

    // Bridge content must match the documented constant.
    expect(final[4]).toEqual({
      role: 'assistant',
      content: MISTRAL_TOOL_USER_BRIDGE_CONTENT,
    });

    // Synthesised tool response must reference the orphaned id.
    expect(final[3]).toEqual({
      role: 'tool',
      tool_call_id: 'lreplace0',
      content: ORPHANED_TOOL_RESPONSE_CONTENT,
    });
  });

  it('reverse order (transition-then-orphan) leaves a violation — proves the bug', () => {
    // Sanity: this is the OLD broken order. We assert it does NOT clean
    // the orphan-introduced violation, locking in why the fix matters.
    const messages: OpenAIMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first prompt' },
      assistantWithCalls(['lreplace0']),
      { role: 'user', content: 'follow up after resume' },
    ];

    const afterTransition = patchToolUserTransitionForMistral(
      messages,
      MISTRAL_MODEL,
    );
    const final = patchOrphanedToolCallsForMistral(
      afterTransition,
      MISTRAL_MODEL,
    );

    // The old order leaves a tool→user violation.
    expect(findToolUserViolation(final)).toBeGreaterThanOrEqual(0);
  });

  it('balanced (non-resume) history is unchanged by either pass order', () => {
    const messages: OpenAIMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      assistantWithCalls(['aaaaaaaaa']),
      { role: 'tool', tool_call_id: 'aaaaaaaaa', content: 'ok' },
      { role: 'assistant', content: 'final' },
    ];

    const afterOrphan = patchOrphanedToolCallsForMistral(
      messages,
      MISTRAL_MODEL,
    );
    const final = patchToolUserTransitionForMistral(afterOrphan, MISTRAL_MODEL);

    expect(final).toEqual(messages);
    expect(findToolUserViolation(final)).toBe(-1);
  });

  it('multiple orphaned blocks each followed by user are all bridged', () => {
    const messages: OpenAIMessage[] = [
      { role: 'user', content: 'q1' },
      assistantWithCalls(['aaaaaaaaa']),
      { role: 'user', content: 'q2' },
      assistantWithCalls(['bbbbbbbbb']),
      { role: 'user', content: 'q3' },
    ];

    const afterOrphan = patchOrphanedToolCallsForMistral(
      messages,
      MISTRAL_MODEL,
    );
    const final = patchToolUserTransitionForMistral(afterOrphan, MISTRAL_MODEL);

    expect(findToolUserViolation(final)).toBe(-1);
    // Each orphaned assistant gets a synthetic tool, and each tool→user
    // gap then gets a bridge assistant.
    const roles = final.map((m) => m.role);
    expect(roles).toEqual([
      'user',
      'assistant', // tc aaaaaaaaa
      'tool', // synthetic
      'assistant', // bridge
      'user',
      'assistant', // tc bbbbbbbbb
      'tool', // synthetic
      'assistant', // bridge
      'user',
    ]);
  });
});
// --- END LOCAL FORK ADDITION ---

// --- LOCAL FORK ADDITION (Phase 2.0.9 — vLLM stream_options retry fix) ---
describe('buildNonStreamRetryBody (Phase 2.0.9)', () => {
  it('strips stream_options when flipping to non-streaming', () => {
    const original = {
      model: 'mistralai/Devstral-Small-2-24B-Instruct-2512',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hi' }],
    };
    const out = buildNonStreamRetryBody(original);
    expect(out['stream']).toBe(false);
    expect('stream_options' in out).toBe(false);
    expect(out['model']).toBe(original.model);
    expect(out['messages']).toEqual(original.messages);
  });

  it('does not mutate the caller-supplied body', () => {
    const original = {
      stream: true,
      stream_options: { include_usage: true },
      foo: 'bar',
    };
    const snapshot = JSON.parse(JSON.stringify(original));
    buildNonStreamRetryBody(original);
    expect(original).toEqual(snapshot);
  });

  it('forces stream:false even when input has no stream key', () => {
    const out = buildNonStreamRetryBody({ messages: [] });
    expect(out['stream']).toBe(false);
  });

  it('is a no-op for stream_options when absent (still flips stream)', () => {
    const out = buildNonStreamRetryBody({ stream: true, model: 'm' });
    expect(out['stream']).toBe(false);
    expect('stream_options' in out).toBe(false);
    expect(out['model']).toBe('m');
  });

  it('preserves unrelated keys (tools, temperature, etc.)', () => {
    const out = buildNonStreamRetryBody({
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
      tools: [{ type: 'function', function: { name: 'x' } }],
      tool_choice: 'auto',
    });
    expect(out['temperature']).toBe(0.2);
    expect(out['tools']).toEqual([
      { type: 'function', function: { name: 'x' } },
    ]);
    expect(out['tool_choice']).toBe('auto');
    expect('stream_options' in out).toBe(false);
    expect(out['stream']).toBe(false);
  });
});
// --- END LOCAL FORK ADDITION ---

// --- LOCAL FORK ADDITION (Phase 2.0.12 — three-mode tool-call parser) ---
//
// Replaces the Phase 2.0.11 single-mode test block. parseXmlToolCalls now
// takes an explicit ToolCallParseMode: 'strict' | 'lenient' | 'loose'. The
// matrix below covers every (input × mode) combination that matters for
// either backward-compat (Qwen / Gemma / Devstral 24B always go through the
// strict path) or recovery (Nemotron 3 / Mistral 4) or doc-injection safety
// (lenient must NOT match bare blocks without an orphan-closer signal).
describe('parseXmlToolCalls (Phase 2.0.12 — mode-aware)', () => {
  const WRAPPED = `<tool_call>
<function=write_file>
<parameter=file_path>/tmp/a.js</parameter>
<parameter=content>console.log(1);</parameter>
</function>
</tool_call>`;

  // Mistral 4 119B / Nemotron 3 in-the-wild pattern: bare function block
  // followed by an orphaned </tool_call> (no matching opener). The orphan
  // closer is the "intent signal" that lenient mode keys off of.
  const BARE_WITH_ORPHAN_CLOSER = `<function=write_file>
<parameter=file_path>/tmp/weather-app.js</parameter>
<parameter=content>function launchWeatherApp() { return null; }</parameter>
</function>
</tool_call>`;

  // Documentation / tutorial pattern: bare function block with NO orphan
  // closer (e.g. the model is explaining tool-call syntax to the user).
  // Lenient must refuse to execute this; loose will (intentionally) match.
  const BARE_NO_ORPHAN_CLOSER =
    '<function=read_file><parameter=path>/etc/hosts</parameter></function>';

  const NON_TOOL = '```js\nconst x = 1;\n```';

  describe('empty / non-tool content', () => {
    for (const mode of ['strict', 'lenient', 'loose'] as const) {
      it(`returns [] in ${mode} mode for empty / prose / code-block content`, () => {
        expect(parseXmlToolCalls('', mode)).toEqual([]);
        expect(parseXmlToolCalls('hello world', mode)).toEqual([]);
        expect(parseXmlToolCalls(NON_TOOL, mode)).toEqual([]);
      });
    }
  });

  describe('wrapped <tool_call>...</tool_call> input', () => {
    for (const mode of ['strict', 'lenient', 'loose'] as const) {
      it(`extracts exactly one call in ${mode} mode`, () => {
        const calls = parseXmlToolCalls(WRAPPED, mode);
        expect(calls).toHaveLength(1);
        expect(calls[0].function.name).toBe('write_file');
        expect(JSON.parse(calls[0].function.arguments)).toEqual({
          file_path: '/tmp/a.js',
          content: 'console.log(1);',
        });
        expect(calls[0].id).toBe('call_xml_0');
        expect(calls[0].type).toBe('function');
      });
    }
  });

  describe('bare <function=...> with NO orphan closer (doc-injection safety)', () => {
    it('strict mode returns [] (no wrapper)', () => {
      expect(parseXmlToolCalls(BARE_NO_ORPHAN_CLOSER, 'strict')).toEqual([]);
    });

    it('lenient mode returns [] (no intent signal — doc-injection safe)', () => {
      expect(parseXmlToolCalls(BARE_NO_ORPHAN_CLOSER, 'lenient')).toEqual([]);
    });

    it('loose mode matches the bare block', () => {
      const calls = parseXmlToolCalls(BARE_NO_ORPHAN_CLOSER, 'loose');
      expect(calls).toHaveLength(1);
      expect(calls[0].function.name).toBe('read_file');
    });
  });

  describe('bare <function=...> WITH orphan </tool_call> closer (Nemotron 3 / Mistral 4 case)', () => {
    it('strict mode returns [] (no opener present)', () => {
      expect(parseXmlToolCalls(BARE_WITH_ORPHAN_CLOSER, 'strict')).toEqual([]);
    });

    it('lenient mode RECOVERS the call (orphan closer = intent signal)', () => {
      const calls = parseXmlToolCalls(BARE_WITH_ORPHAN_CLOSER, 'lenient');
      expect(calls).toHaveLength(1);
      expect(calls[0].function.name).toBe('write_file');
      expect(JSON.parse(calls[0].function.arguments)).toEqual({
        file_path: '/tmp/weather-app.js',
        content: 'function launchWeatherApp() { return null; }',
      });
    });

    it('loose mode also matches', () => {
      const calls = parseXmlToolCalls(BARE_WITH_ORPHAN_CLOSER, 'loose');
      expect(calls).toHaveLength(1);
      expect(calls[0].function.name).toBe('write_file');
    });
  });

  describe('mixed wrapped + bare-with-orphan-closer in one content', () => {
    const MIXED = `${WRAPPED}
And then a follow-up:
<function=read_file><parameter=path>/etc/hosts</parameter></function>
</tool_call>`;

    it('strict mode returns only the wrapped call', () => {
      const calls = parseXmlToolCalls(MIXED, 'strict');
      expect(calls).toHaveLength(1);
      expect(calls[0].function.name).toBe('write_file');
    });

    it('lenient mode returns BOTH calls (no double counting) with sequential ids', () => {
      const calls = parseXmlToolCalls(MIXED, 'lenient');
      expect(calls).toHaveLength(2);
      expect(calls[0].function.name).toBe('write_file');
      expect(calls[1].function.name).toBe('read_file');
      expect(calls[0].id).toBe('call_xml_0');
      expect(calls[1].id).toBe('call_xml_1');
    });

    it('loose mode also returns 2 (matches both function blocks)', () => {
      const calls = parseXmlToolCalls(MIXED, 'loose');
      expect(calls).toHaveLength(2);
    });
  });

  describe('multiple back-to-back wrapped blocks (no merging)', () => {
    const TWO_WRAPPED = `<tool_call>
<function=write_file>
<parameter=file_path>/tmp/a.js</parameter>
<parameter=content>A</parameter>
</function>
</tool_call>
<tool_call>
<function=write_file>
<parameter=file_path>/tmp/b.js</parameter>
<parameter=content>B</parameter>
</function>
</tool_call>`;
    for (const mode of ['strict', 'lenient', 'loose'] as const) {
      it(`extracts both calls in ${mode} mode in order`, () => {
        const calls = parseXmlToolCalls(TWO_WRAPPED, mode);
        expect(calls).toHaveLength(2);
        expect(JSON.parse(calls[0].function.arguments)).toEqual({
          file_path: '/tmp/a.js',
          content: 'A',
        });
        expect(JSON.parse(calls[1].function.arguments)).toEqual({
          file_path: '/tmp/b.js',
          content: 'B',
        });
        expect(calls[0].id).toBe('call_xml_0');
        expect(calls[1].id).toBe('call_xml_1');
      });
    }
  });

  it('preserves multi-line parameter content verbatim (lenient mode, with orphan closer)', () => {
    const content = `<function=write_file>
<parameter=file_path>/tmp/a.js</parameter>
<parameter=content>line one
line two
  line three indented</parameter>
</function>
</tool_call>`;
    const calls = parseXmlToolCalls(content, 'lenient');
    expect(calls).toHaveLength(1);
    const args = JSON.parse(calls[0].function.arguments);
    expect(args.content).toBe('line one\nline two\n  line three indented');
  });

  it('handles a function block with zero parameters in loose mode', () => {
    const content = '<function=list_directory></function>';
    const calls = parseXmlToolCalls(content, 'loose');
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('list_directory');
    expect(JSON.parse(calls[0].function.arguments)).toEqual({});
  });

  it('defaults to lenient when mode is omitted (preserves Nemotron 3 / Mistral 4 recovery)', () => {
    const calls = parseXmlToolCalls(BARE_WITH_ORPHAN_CLOSER);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('write_file');
  });

  it('defensive: invalid mode value falls back to lenient (does not throw)', () => {
    // @ts-expect-error — intentionally passing an invalid mode to verify
    // the parser silently falls back rather than crashing the response path.
    const calls = parseXmlToolCalls(BARE_WITH_ORPHAN_CLOSER, 'banana');
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('write_file');
  });

  it('lenient mode does NOT count a bare block surrounded by prose without an orphan closer', () => {
    // This is the core doc-injection-safety guarantee. A model writing a
    // tutorial about tool-call syntax must not accidentally trigger
    // execution under the default mode (no unbalanced tool_call closers).
    const tutorial = `Here is how a tool call looks:

  <function=write_file><parameter=file_path>foo</parameter></function>

That's the syntax. The CLI will execute it for you.`;
    expect(parseXmlToolCalls(tutorial, 'lenient')).toEqual([]);
    // Loose mode would (intentionally) match — proves the gate works.
    expect(parseXmlToolCalls(tutorial, 'loose')).toHaveLength(1);
  });

  it('lenient mode treats balanced tool_call tags as no orphan signal', () => {
    // Balanced openers/closers (e.g. a model echoing wrapped syntax inside
    // prose) should not unlock bare-block matching.
    const balanced = `Wrapped example: <tool_call><function=read_file><parameter=path>/etc/hosts</parameter></function></tool_call>
And then a separate bare block in prose:
<function=write_file><parameter=file_path>foo</parameter></function>`;
    const calls = parseXmlToolCalls(balanced, 'lenient');
    // Only the wrapped one — the bare block is not unlocked because the
    // closer/opener counts are balanced (1 each).
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('read_file');
  });
});
// --- END LOCAL FORK ADDITION ---
