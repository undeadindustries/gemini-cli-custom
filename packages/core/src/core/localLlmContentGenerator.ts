/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GenerateContentResponse,
  CountTokensResponse,
  type GenerateContentParameters,
  type CountTokensParameters,
  type EmbedContentParameters,
  type EmbedContentResponse,
  type Content,
  type Part,
} from '@google/genai';
import type { ContentGenerator } from './contentGenerator.js';
import type { Config } from '../config/config.js';
import type { LlmRole } from '../telemetry/llmRole.js';
import { debugLogger } from '../utils/debugLogger.js';
// --- LOCAL FORK ADDITION (Phase 2.0.7-diag) ---
import { appendFileSync } from 'node:fs';
// --- END LOCAL FORK ADDITION ---
import { estimateTokenCountSync } from '../utils/tokenCalculation.js';

/**
 * OpenAI-compatible chat message shape.
 *
 * Exported so unit tests in localLlmContentGenerator.test.ts can construct
 * fixtures for the pure-function transforms (e.g.
 * patchToolUserTransitionForMistral) without having to reach into private
 * implementation details.
 */
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface OpenAIStreamDeltaToolCall {
  index: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAIStreamChoice {
  index: number;
  delta: {
    role?: string;
    content?: string | null;
    /** Thinking tokens — vLLM uses "reasoning", OpenAI-compat uses "reasoning_content". */
    reasoning_content?: string | null;
    reasoning?: string | null;
    tool_calls?: OpenAIStreamDeltaToolCall[];
  };
  finish_reason: string | null;
}

interface OpenAIStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OpenAIStreamChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAINonStreamChoice {
  index: number;
  message: {
    role: string;
    content?: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: string;
}

interface OpenAINonStreamResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OpenAINonStreamChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface FunctionDeclaration {
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

interface ToolWithFunctionDeclarations {
  functionDeclarations?: FunctionDeclaration[];
}

interface TextPart {
  text: string;
}

interface ContentLike {
  parts: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && value !== undefined && value instanceof Object;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

// --- LOCAL FORK ADDITION (Phase 2.0.10) ---
/**
 * Structural type guard for any object that exposes a `close(): Promise<void>`
 * method (matches undici's `Agent`, `Pool`, `Client`, etc.). Used by the
 * stale-socket retry path so the type assertion is centralized and ESLint-safe.
 */
function isClosable(v: unknown): v is { close: () => Promise<void> } {
  if (!isRecord(v)) return false;
  const close = v['close'];
  return typeof close === 'function';
}
// --- END LOCAL FORK ADDITION ---

// --- LOCAL FORK ADDITION (Phase 2.0.12) ---
/**
 * Tool-call parser hardening modes.
 *
 * Different local models emit "fake" tool calls in different formats. Some
 * formats are unambiguous (Qwen / Gemma / Devstral 24B always emit a clean
 * `<tool_call>...</tool_call>` wrapper). Some are mangled (Nemotron 3 / Mistral
 * 4 119B emit `<function=...>...</function>` followed by an orphaned
 * `</tool_call>` — the closer is there but the opener is missing). Some
 * inputs are not tool calls at all (a model writing documentation or a
 * tutorial about agentic CLIs may legitimately include the literal
 * `<function=...>` text inside a code block).
 *
 * The parser supports three modes so callers can choose how aggressively to
 * recover from broken model output vs. how strictly to refuse to execute
 * anything that wasn't an unambiguous tool call:
 *
 *   - `strict`  : Only match `<tool_call>...</tool_call>` wrapped blocks.
 *                 Identical to pre-Phase-2.0.11 behavior. Zero false-positive
 *                 risk. Use this for security-sensitive contexts where the
 *                 model output is treated as untrusted input.
 *
 *   - `lenient` : All strict matches PLUS bare `<function=...>...</function>`
 *                 blocks, but the bare-block recovery is gated by a strong
 *                 intent signal: an orphaned `</tool_call>` somewhere in the
 *                 content (closer count exceeds opener count). This is the
 *                 default. It recovers the Nemotron 3 / Mistral 4 quirk
 *                 without enabling fully arbitrary matching, because
 *                 documentation and tutorials almost never contain orphaned
 *                 tool-call closers.
 *
 *   - `loose`   : Match any `<function=...>...</function>` block, anywhere in
 *                 the content, regardless of context. Highest recovery rate.
 *                 Has documentation-injection risk. Power-user opt-in only.
 *
 * Backward-compat: the three modes form a strict superset chain
 *   strict ⊆ lenient ⊆ loose
 * so any input that parsed in strict still parses in lenient and loose. The
 * previously-shipped Phase 2.0.11 behavior corresponds exactly to `loose`.
 *
 * Pure / side-effect free so it can be unit tested without instantiating
 * LocalLlmContentGenerator. The class method now delegates here, passing the
 * mode read from the live config (so `/local toolcall <mode>` takes effect on
 * the next response).
 */
export type ToolCallParseMode = 'strict' | 'lenient' | 'loose';

export const DEFAULT_TOOL_CALL_PARSE_MODE: ToolCallParseMode = 'lenient';

export const VALID_TOOL_CALL_PARSE_MODES: readonly ToolCallParseMode[] = [
  'strict',
  'lenient',
  'loose',
];

export function isToolCallParseMode(v: unknown): v is ToolCallParseMode {
  return (
    typeof v === 'string' &&
    (VALID_TOOL_CALL_PARSE_MODES as readonly string[]).includes(v)
  );
}

/**
 * Build an OpenAIToolCall from a raw `<function=NAME>BODY</function>` match.
 * `idIndex` is used to make ids stable per-content (`call_xml_0`, `_1`, ...).
 */
function functionMatchToToolCall(
  funcName: string,
  paramsBody: string,
  idIndex: number,
): OpenAIToolCall {
  const paramRegex = /<parameter=(\w+)>([\s\S]*?)<\/parameter>/g;
  const args: Record<string, string> = {};
  let paramMatch: RegExpExecArray | null;
  while ((paramMatch = paramRegex.exec(paramsBody)) !== null) {
    args[paramMatch[1]] = paramMatch[2].trim();
  }
  return {
    id: `call_xml_${idIndex}`,
    type: 'function',
    function: {
      name: funcName,
      arguments: JSON.stringify(args),
    },
  };
}

/**
 * Strict matcher: only `<function=...>` blocks that live INSIDE a
 * `<tool_call>...</tool_call>` wrapper. This is the pre-Phase-2.0.11 contract.
 */
function matchWrappedToolCalls(content: string): OpenAIToolCall[] {
  const calls: OpenAIToolCall[] = [];
  const wrapperRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  const innerFnRegex = /<function=(\w+)>([\s\S]*?)<\/function>/g;
  let wrapperMatch: RegExpExecArray | null;
  while ((wrapperMatch = wrapperRegex.exec(content)) !== null) {
    const body = wrapperMatch[1];
    innerFnRegex.lastIndex = 0;
    let fnMatch: RegExpExecArray | null;
    while ((fnMatch = innerFnRegex.exec(body)) !== null) {
      calls.push(functionMatchToToolCall(fnMatch[1], fnMatch[2], calls.length));
    }
  }
  return calls;
}

/**
 * Loose matcher: every `<function=...>...</function>` block anywhere in the
 * content, regardless of wrapping. Equivalent to the Phase 2.0.11 behavior.
 */
function matchAllFunctionBlocks(content: string): OpenAIToolCall[] {
  const calls: OpenAIToolCall[] = [];
  const fnRegex = /<function=(\w+)>([\s\S]*?)<\/function>/g;
  let fnMatch: RegExpExecArray | null;
  while ((fnMatch = fnRegex.exec(content)) !== null) {
    calls.push(functionMatchToToolCall(fnMatch[1], fnMatch[2], calls.length));
  }
  return calls;
}

/**
 * Lenient helper: find bare `<function=...>` blocks that are NOT already
 * inside a `<tool_call>...</tool_call>` wrapper. Used together with
 * matchWrappedToolCalls so wrapped blocks are not double-counted.
 */
function matchBareFunctionBlocksOutsideWrappers(
  content: string,
): OpenAIToolCall[] {
  // Strip every wrapped region first. Replace with whitespace of the same
  // length so byte offsets in subsequent regex matches remain meaningful for
  // any future debugging/logging additions.
  const stripped = content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, (m) =>
    ' '.repeat(m.length),
  );
  return matchAllFunctionBlocks(stripped);
}

/**
 * Detect the "intent signal" that gates lenient mode: at least one orphaned
 * `</tool_call>` (closer with no matching opener) in the content. We compare
 * raw counts of `<tool_call>` vs `</tool_call>` rather than parsing because
 * the bug we're recovering from IS that the model emitted unbalanced tags.
 */
function hasOrphanedToolCallCloser(content: string): boolean {
  const openers = (content.match(/<tool_call>/g) ?? []).length;
  const closers = (content.match(/<\/tool_call>/g) ?? []).length;
  return closers > openers;
}

/**
 * Mode-aware content-side tool-call recovery.
 *
 * @param content   Assistant message content as returned by the local server.
 * @param mode      Parse mode. Defaults to `lenient`. Unknown values are
 *                  defensively treated as `lenient` rather than throwing, so
 *                  a typo in user settings can never crash the response path.
 * @returns         Zero or more OpenAI-shaped tool calls. The class wrapper
 *                  attaches these to the assistant turn for downstream
 *                  execution by the CLI's tool runner.
 */
export function parseXmlToolCalls(
  content: string,
  mode: ToolCallParseMode = DEFAULT_TOOL_CALL_PARSE_MODE,
): OpenAIToolCall[] {
  const effectiveMode: ToolCallParseMode = isToolCallParseMode(mode)
    ? mode
    : DEFAULT_TOOL_CALL_PARSE_MODE;

  let calls: OpenAIToolCall[];
  if (effectiveMode === 'loose') {
    calls = matchAllFunctionBlocks(content);
  } else {
    const wrapped = matchWrappedToolCalls(content);
    if (effectiveMode === 'strict' || !hasOrphanedToolCallCloser(content)) {
      calls = wrapped;
    } else {
      // lenient + orphan-closer present → recover bare blocks too
      const bare = matchBareFunctionBlocksOutsideWrappers(content);
      // Re-id so bare-block ids continue from the wrapped ids.
      const renumberedBare = bare.map((c, i) => ({
        ...c,
        id: `call_xml_${wrapped.length + i}`,
      }));
      calls = [...wrapped, ...renumberedBare];
    }
  }

  if (calls.length > 0) {
    debugLogger.log(
      `[LocalLLM Phase 2.0.12] Extracted ${calls.length} tool call(s) from content fallback (mode=${effectiveMode})`,
    );
  }

  return calls;
}
// --- END LOCAL FORK ADDITION ---

function isTextPart(value: unknown): value is TextPart {
  if (!isRecord(value)) return false;
  return 'text' in value && isString(value['text']);
}

function isContentLike(value: unknown): value is ContentLike {
  if (!isRecord(value)) return false;
  return 'parts' in value && Array.isArray(value['parts']);
}

const FINISH_REASON_MAP: Record<string, string> = {
  stop: 'STOP',
  length: 'MAX_TOKENS',
  tool_calls: 'STOP',
  content_filter: 'SAFETY',
};

// --- LOCAL FORK ADDITION (Phase 2.0.4) ---
/**
 * Sanitize a tool call id so strict OpenAI-spec parsers accept it.
 *
 * Background: vLLM with `--tool-call-parser mistral` (used for Mistral-family
 * models like Devstral) enforces `^[a-zA-Z0-9]{9}$` on every tool call id and
 * `tool_call_id`. Our previous format `call_<name>_<counter>` violated both
 * rules (underscores + length > 9) and produced HTTP 400 errors such as:
 *   "Tool call id was ad_file_0 but must be a-z, A-Z, 0-9, with a length of 9."
 *
 * Algorithm:
 *   1. Strip every non-alphanumeric character.
 *   2. If ≥ 9 chars, return the trailing 9 (preserves the counter suffix
 *      that disambiguates sibling calls — e.g. `readfile0` vs `readfile1`).
 *   3. Otherwise left-pad with `0` to exactly 9 chars.
 *
 * Critical properties:
 *   - Pure and deterministic: same input always yields same output. This is
 *     required because we generate `assistant.tool_calls[].id` and the
 *     matching `tool.tool_call_id` from independent `toolCallIdCounter`
 *     instances in two separate `contentToMessages` calls — they MUST
 *     collide on identical (name, counter) inputs or vLLM rejects the pair.
 *   - Backward compatible with non-strict servers (Qwen, Gemma, OpenAI),
 *     which accept any string as a tool call id; a 9-char alphanumeric
 *     string is still a valid identifier for them.
 *
 * Exported for unit testing.
 */
export function mistralSafeToolCallId(rawId: string): string {
  const cleaned = rawId.replace(/[^a-zA-Z0-9]/g, '');
  if (cleaned.length >= 9) {
    return cleaned.slice(-9);
  }
  return cleaned.padStart(9, '0');
}
// --- END LOCAL FORK ADDITION ---

// --- LOCAL FORK ADDITION (Phase 2.0.5) ---
/**
 * Detect whether a model id belongs to the Mistral family (Mistral, Devstral,
 * Mixtral, Codestral, Magistral, Ministral).
 *
 * Why this exists: vLLM's `--tool-call-parser mistral` (auto-selected for
 * Mistral-family models) enforces stricter OpenAI-compat conversation rules
 * than Qwen / Gemma / Llama / OpenAI itself. The two we care about today are:
 *   - Tool call ids must match `/^[a-zA-Z0-9]{9}$/`
 *     (handled by `mistralSafeToolCallId`).
 *   - The `tool` → `user` role transition is rejected with HTTP 400
 *     "Unexpected role 'user' after role 'tool'"
 *     (handled by `patchToolUserTransitionForMistral` below).
 *
 * Detection is a case-insensitive substring match on the model id. The
 * Mistral AI catalog all share the `*stral` suffix or the `mistral` prefix,
 * so the regex stays small and conservative — easier to widen later than to
 * debug a model we accidentally classified as Mistral and started rewriting
 * conversations for.
 *
 * Non-matching examples (verified in tests): qwen, gemma, llama, gpt, claude,
 * deepseek, phi, yi, command-r.
 *
 * Exported for unit testing.
 */
export function isMistralFamilyModel(modelId: string): boolean {
  return /(mistral|devstral|mixtral|codestral|magistral|ministral)/i.test(
    modelId,
  );
}

/**
 * Synthetic assistant message inserted between Mistral-rejected `tool` →
 * `user` transitions. Single dot for minimum token cost; non-empty so
 * servers that also reject empty assistant `content` accept it; semantically
 * neutral so the model can ignore it without bias.
 *
 * Exported as a constant so tests can reference the exact value without
 * brittle string literals.
 */
export const MISTRAL_TOOL_USER_BRIDGE_CONTENT = '.';

/**
 * vLLM `--tool-call-parser mistral` rejects any `user` message that
 * immediately follows a `tool` message with HTTP 400:
 *   "Unexpected role 'user' after role 'tool'"
 *
 * The strict spec expects the assistant to react to the tool result before
 * the user speaks again. In gemini-cli's agentic flow this happens in two
 * common situations:
 *   1. The user types a follow-up prompt right after a turn that ended on a
 *      tool response (history stitching during a new prompt).
 *   2. A single Gemini Content carries both a `functionResponse` part AND a
 *      `text` part — `contentToMessages` serializes this as a `tool` message
 *      followed by a `user` message back-to-back inside the same turn.
 *
 * This function inserts a synthetic minimal assistant message between every
 * such transition. Pure: does not mutate the input array. No-op for any
 * model that `isMistralFamilyModel` does not classify as Mistral, so
 * Qwen/Gemma/Llama/OpenAI conversations pass through unchanged.
 *
 * Exported for unit testing.
 *
 * TODO(local-fork): If a user runs a Mistral-family model behind a
 * non-Mistral parser (rare — most setups use vLLM's auto-selected parser),
 * they currently pay one synthetic assistant token per tool→user pair for
 * no reason. If this becomes a problem, add an explicit
 * `local.strictToolFlow: 'auto' | 'always' | 'never'` settings override
 * that bypasses the detection regex.
 */
export function patchToolUserTransitionForMistral(
  messages: OpenAIMessage[],
  modelId: string,
): OpenAIMessage[] {
  if (!isMistralFamilyModel(modelId)) return messages;

  const result: OpenAIMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const current = messages[i];
    result.push(current);
    const next = messages[i + 1];
    if (current.role === 'tool' && next?.role === 'user') {
      result.push({
        role: 'assistant',
        content: MISTRAL_TOOL_USER_BRIDGE_CONTENT,
      });
    }
  }
  return result;
}
// --- END LOCAL FORK ADDITION ---

// --- LOCAL FORK ADDITION (Phase 2.0.6) ---
/**
 * Synthesised tool-response content used when a tool call was interrupted
 * (e.g. by a request timeout) before the real response was stored in history.
 *
 * Exported as a constant so tests can assert the exact value.
 */
export const ORPHANED_TOOL_RESPONSE_CONTENT =
  '{"error":"Tool call interrupted — no response recorded."}';

/**
 * vLLM `--tool-call-parser mistral` rejects any request where the number of
 * `tool_calls` ids in an `assistant` message does not exactly match the number
 * of `tool` role messages that follow it (HTTP 400:
 * "Not the same number of function calls and responses").
 *
 * This situation arises when a request **times out** mid-turn. At that point
 * the CLI has already stored some tool results in history but not others —
 * the assistant message advertises N tool calls while only M < N have tool
 * responses immediately after it in the array.
 *
 * This function inserts a synthetic `tool` message (containing an error
 * sentinel JSON body so the model knows the result was lost) for every
 * `tool_call_id` that is missing a corresponding `tool` response.
 *
 * Algorithm:
 *   1. Walk the messages array looking for `assistant` messages that have
 *      `tool_calls`.
 *   2. Collect the `tool_call_id`s of all `tool` messages that immediately
 *      follow (contiguous block).
 *   3. Any id that is in `tool_calls` but NOT in the contiguous `tool` block
 *      is "orphaned" — insert a synthetic `tool` message for it at the end
 *      of that contiguous block.
 *
 * Pure and non-mutating. No-op for models that `isMistralFamilyModel` does
 * not classify as Mistral, so Qwen / Gemma / Llama / OpenAI pass through
 * unchanged.
 *
 * Exported for unit testing.
 */
export function patchOrphanedToolCallsForMistral(
  messages: OpenAIMessage[],
  modelId: string,
): OpenAIMessage[] {
  if (!isMistralFamilyModel(modelId)) return messages;

  const result: OpenAIMessage[] = [];
  let i = 0;

  while (i < messages.length) {
    const current = messages[i];

    // Only act on assistant messages that carry tool_calls.
    if (
      current.role !== 'assistant' ||
      !current.tool_calls ||
      current.tool_calls.length === 0
    ) {
      result.push(current);
      i++;
      continue;
    }

    // Collect every tool_call_id declared by this assistant message.
    // (Used below to guard the synthesis loop — respondedIds is the live set.)

    // Consume the contiguous block of tool messages that follow.
    result.push(current);
    i++;
    const respondedIds = new Set<string>();
    while (i < messages.length && messages[i].role === 'tool') {
      const toolMsg = messages[i];
      if (toolMsg.tool_call_id) respondedIds.add(toolMsg.tool_call_id);
      result.push(toolMsg);
      i++;
    }

    // Synthesise a response for every orphaned id (preserving the original
    // declaration order so the model can correlate them deterministically).
    for (const tc of current.tool_calls) {
      if (!respondedIds.has(tc.id)) {
        result.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: ORPHANED_TOOL_RESPONSE_CONTENT,
        });
      }
    }
  }

  return result;
}
// --- END LOCAL FORK ADDITION ---

// --- LOCAL FORK ADDITION (Phase 2.0.9) ---
/**
 * Build the JSON body for a non-streaming retry of a request that originally
 * went out as a stream.
 *
 * vLLM (and the OpenAI spec it enforces) rejects any request where
 * `stream_options` is present unless `stream === true`. The streaming path
 * deliberately attaches `stream_options: { include_usage: true }` so we can
 * surface real token usage from the final SSE chunk; if we naively reuse that
 * body for a non-streaming retry vLLM returns:
 *
 *   HTTP 400: "Stream options can only be defined when `stream=True`."
 *
 * This helper produces a clean retry body by:
 *   1. Copying the original body so the caller's object is never mutated.
 *   2. Stripping `stream_options` (the OpenAI key, snake_case).
 *   3. Forcing `stream: false`.
 *
 * Pure / side-effect free so it can be unit-tested without mocking fetch.
 *
 * @param originalBody The body that was sent for the streaming request.
 * @returns A new object safe to POST as a non-streaming request.
 */
export function buildNonStreamRetryBody(
  originalBody: Record<string, unknown>,
): Record<string, unknown> {
  const { stream_options: _omitStreamOptions, ...rest } = originalBody;
  void _omitStreamOptions;
  return { ...rest, stream: false };
}
// --- END LOCAL FORK ADDITION ---

/**
 * Translates a Gemini-style tools array to the OpenAI tool format.
 *
 * Strict OpenAI-spec servers (vLLM, Devstral, etc.) require every tool's
 * `function.parameters` to be a valid JSON-schema object — never null or
 * undefined. Gemini function declarations may omit `parameters` entirely for
 * zero-argument tools, so we default to `{ type: 'object', properties: {} }`
 * in that case. Existing parameter schemas are forwarded unchanged.
 *
 * Exported as a pure function so it can be unit-tested without instantiating
 * the full LocalLlmContentGenerator class.
 */
export function translateToolsToOpenAI(tools: unknown): OpenAITool[] {
  if (!tools || !Array.isArray(tools)) return [];

  const result: OpenAITool[] = [];
  for (const tool of tools) {
    if (tool && typeof tool === 'object' && 'functionDeclarations' in tool) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const typedTool = tool as ToolWithFunctionDeclarations;
      const decls = typedTool.functionDeclarations;
      if (Array.isArray(decls)) {
        for (const decl of decls) {
          // vLLM and other strict servers reject parameters: null/undefined.
          // Default to the minimal valid JSON-schema object for zero-arg tools.
          const parameters: Record<string, unknown> =
            decl.parameters != null
              ? decl.parameters
              : { type: 'object', properties: {} };
          result.push({
            type: 'function',
            function: {
              name: decl.name ?? '',
              description: decl.description ?? undefined,
              parameters,
            },
          });
        }
      }
    }
  }
  return result;
}
// --- END LOCAL FORK ADDITION ---

/**
 * ContentGenerator implementation that routes requests to a local
 * OpenAI-compatible endpoint (vLLM, Ollama, llama.cpp, etc.).
 *
 * Translates Gemini SDK types to/from OpenAI chat completions format.
 */
export class LocalLlmContentGenerator implements ContentGenerator {
  constructor(
    private readonly url: string,
    private readonly model: string,
    private readonly config: Config,
  ) {}

  async generateContent(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role: LlmRole,
  ): Promise<GenerateContentResponse> {
    const { messages, tools } = this.translateRequest(request);

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
    };
    if (tools.length > 0) {
      body['tools'] = tools;
    }
    // --- LOCAL FORK ADDITION (Phase 2.0.13) ---
    const temperature = this.config.getLocalTemperature();
    if (temperature !== null) {
      body['temperature'] = temperature;
    }
    // --- END LOCAL FORK ADDITION ---

    const response = await this.fetchWithTimeout(body);

    if (!response.ok) {
      const text = await response.text().catch(() => '<unreadable>');
      // --- LOCAL FORK ADDITION (Phase 2.0.6-diag) ---
      if (response.status === 400) {
        const roleSeq = messages.map((m, idx) => {
          let label = `[${idx}] ${m.role}`;
          if (m.role === 'assistant' && m.tool_calls) {
            label += ` (tool_calls: ${m.tool_calls.map((tc: { id: string }) => tc.id).join(', ')})`;
          }
          if (m.role === 'tool' && m.tool_call_id) {
            label += ` (tool_call_id: ${m.tool_call_id})`;
          }
          return label;
        });
        const diagOutput = `[${new Date().toISOString()}] 400 error (non-stream) — model="${this.model}", isMistral=${isMistralFamilyModel(this.model)}\nRole sequence:\n${roleSeq.join('\n')}\nvLLM error: ${text}\n\n`;
        try {
          const fs = await import('node:fs');
          fs.appendFileSync('/tmp/gemini-local-diag.log', diagOutput);
        } catch {
          /* ignore write failure */
        }
      }
      // --- END LOCAL FORK ADDITION ---
      throw new Error(`Local LLM returned HTTP ${response.status}: ${text}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const json = (await response.json()) as OpenAINonStreamResponse;
    const choice = json.choices?.[0];

    const result = this.buildGeminiResponse(
      choice?.message?.content ?? null,
      choice?.finish_reason ?? 'stop',
      choice?.message?.tool_calls,
      json.id,
    );

    if (json.usage) {
      this.attachUsageMetadata(result, json.usage);
    }

    return result;
  }

  async generateContentStream(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role: LlmRole,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const { messages, tools } = this.translateRequest(request);

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools.length > 0) {
      body['tools'] = tools;
    }
    // --- LOCAL FORK ADDITION (Phase 2.0.13) ---
    const temperature = this.config.getLocalTemperature();
    if (temperature !== null) {
      body['temperature'] = temperature;
    }
    // --- END LOCAL FORK ADDITION ---

    const response = await this.fetchWithTimeout(body);

    if (!response.ok) {
      const text = await response.text().catch(() => '<unreadable>');
      // --- LOCAL FORK ADDITION (Phase 2.0.6-diag) ---
      if (response.status === 400) {
        const roleSeq = messages.map((m, idx) => {
          let label = `[${idx}] ${m.role}`;
          if (m.role === 'assistant' && m.tool_calls) {
            label += ` (tool_calls: ${m.tool_calls.map((tc: { id: string }) => tc.id).join(', ')})`;
          }
          if (m.role === 'tool' && m.tool_call_id) {
            label += ` (tool_call_id: ${m.tool_call_id})`;
          }
          return label;
        });
        const diagOutput = `[${new Date().toISOString()}] 400 error (stream) — model="${this.model}", isMistral=${isMistralFamilyModel(this.model)}\nRole sequence:\n${roleSeq.join('\n')}\nvLLM error: ${text}\n\n`;
        try {
          const fs = await import('node:fs');
          fs.appendFileSync('/tmp/gemini-local-diag.log', diagOutput);
        } catch {
          /* ignore write failure */
        }
      }
      // --- END LOCAL FORK ADDITION ---
      throw new Error(`Local LLM returned HTTP ${response.status}: ${text}`);
    }

    if (!response.body) {
      throw new Error('Local LLM response has no body for streaming');
    }

    return this.parseSSEStream(response.body, body);
  }

  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    const parts = this.extractPartsFromContents(request.contents);
    const estimated = parts.length > 0 ? estimateTokenCountSync(parts) : 0;
    debugLogger.log(
      `[LocalLLM] countTokens heuristic estimate: ${estimated} tokens`,
    );
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return Object.setPrototypeOf(
      { totalTokens: estimated },
      CountTokensResponse.prototype,
    );
  }

  private extractPartsFromContents(
    contents: CountTokensParameters['contents'],
  ): Part[] {
    if (!contents) return [];
    if (typeof contents === 'string') return [{ text: contents }];
    if (Array.isArray(contents)) {
      const parts: Part[] = [];
      for (const item of contents) {
        if (typeof item === 'string') {
          parts.push({ text: item });
        } else if (item && typeof item === 'object') {
          if ('parts' in item && Array.isArray(item.parts)) {
            for (const p of item.parts) {
              if (p) parts.push(p);
            }
          } else if ('text' in item) {
            parts.push(item);
          }
        }
      }
      return parts;
    }
    if (typeof contents === 'object' && contents !== null) {
      if ('parts' in contents && Array.isArray(contents.parts)) {
        return contents.parts.filter(Boolean);
      }
      if ('text' in contents) {
        return [contents];
      }
    }
    return [];
  }

  async embedContent(
    _request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    throw new Error(
      'embedContent is not supported when using a local LLM endpoint. ' +
        'Disable local mode or use a Gemini API key for embedding operations.',
    );
  }

  // ---------------------------------------------------------------------------
  // Translation: Gemini → OpenAI
  // ---------------------------------------------------------------------------

  private translateRequest(request: GenerateContentParameters): {
    messages: OpenAIMessage[];
    tools: OpenAITool[];
  } {
    const messages: OpenAIMessage[] = [];

    // --- LOCAL FORK ADDITION (Phase 2.0.6-diag) ---
    // Temporary diagnostic: log model id and whether Mistral patches will fire.
    debugLogger.log(
      `[LocalLLM] translateRequest: model="${this.model}", isMistral=${isMistralFamilyModel(this.model)}`,
    );
    // --- END LOCAL FORK ADDITION ---

    const systemInstruction = request.config?.systemInstruction;
    if (systemInstruction) {
      const text = this.extractTextFromContentUnion(systemInstruction);
      if (text) {
        messages.push({ role: 'system', content: text });
      }
    }

    // --- LOCAL FORK ADDITION (Phase 2.0.7) ---
    // Inline bridge insertion: prevent tool→user violations during message
    // construction itself, not just as a post-processing pass.  This is the
    // primary defense; the post-processing patches below are kept as
    // defense-in-depth.
    const isMistral = isMistralFamilyModel(this.model);
    const contents = this.normalizeContents(request.contents);
    for (const content of contents) {
      const mapped = this.contentToMessages(content);
      for (const msg of mapped) {
        if (
          isMistral &&
          msg.role === 'user' &&
          messages.length > 0 &&
          messages[messages.length - 1].role === 'tool'
        ) {
          messages.push({
            role: 'assistant',
            content: MISTRAL_TOOL_USER_BRIDGE_CONTENT,
          });
        }
        messages.push(msg);
      }
    }
    // --- END LOCAL FORK ADDITION ---

    const tools = this.config.isLocalToolsEnabled()
      ? this.translateTools(request.config?.tools)
      : [];

    // --- LOCAL FORK ADDITION (Phase 2.0.8) ---
    // Order matters: orphan-patch can introduce a fresh tool→user transition
    // when it synthesises a dummy tool response immediately before an
    // existing user message (common on session resume where the previous
    // turn was interrupted mid-tool-call).  We therefore run the orphan
    // pass first and the transition pass last so the latter is the
    // definitive cleanup for ALL tool→user violations.
    // --- END LOCAL FORK ADDITION ---

    // --- LOCAL FORK ADDITION (Phase 2.0.6) ---
    const afterOrphanPatch = patchOrphanedToolCallsForMistral(
      messages,
      this.model,
    );
    // --- END LOCAL FORK ADDITION ---

    // --- LOCAL FORK ADDITION (Phase 2.0.5) ---
    const finalMessages = patchToolUserTransitionForMistral(
      afterOrphanPatch,
      this.model,
    );
    // --- END LOCAL FORK ADDITION ---

    // --- LOCAL FORK ADDITION (Phase 2.0.7-diag) ---
    // Step-by-step diagnostic: write to /tmp so we can trace exactly which
    // stage (if any) still contains a violation.
    if (isMistral) {
      const preRoles = messages.map((m) => m.role).join(' → ');
      const midRoles = afterOrphanPatch.map((m) => m.role).join(' → ');
      const postRoles = finalMessages.map((m) => m.role).join(' → ');
      const hasViolation = (arr: OpenAIMessage[]): number => {
        for (let vi = 0; vi < arr.length - 1; vi++) {
          if (arr[vi].role === 'tool' && arr[vi + 1].role === 'user') return vi;
        }
        return -1;
      };
      const v1 = hasViolation(messages);
      const v2 = hasViolation(afterOrphanPatch);
      const v3 = hasViolation(finalMessages);
      if (v1 >= 0 || v2 >= 0 || v3 >= 0) {
        const diag = [
          `[${new Date().toISOString()}] translateRequest violation detected`,
          `  model="${this.model}", isMistral=${isMistral}`,
          `  INLINE roles (${messages.length}): violation@${v1}`,
          `    ${preRoles}`,
          `  POST-orphan (${afterOrphanPatch.length}): violation@${v2}`,
          `    ${midRoles}`,
          `  POST-transition (${finalMessages.length}): violation@${v3}`,
          `    ${postRoles}`,
          '',
        ].join('\n');
        try {
          appendFileSync('/tmp/gemini-local-diag.log', diag + '\n');
        } catch {
          /* ignore */
        }
      }
    }
    // --- END LOCAL FORK ADDITION ---

    return { messages: finalMessages, tools };
  }

  /**
   * Normalize the various ContentListUnion shapes into a Content[].
   */
  private normalizeContents(
    contents: GenerateContentParameters['contents'],
  ): Content[] {
    if (!contents) return [];

    if (typeof contents === 'string') {
      return [{ role: 'user', parts: [{ text: contents }] }];
    }

    if (Array.isArray(contents)) {
      if (contents.length === 0) return [];

      const first = contents[0];
      if (typeof first === 'string') {
        const parts: Part[] = contents.map((p) =>
          typeof p === 'string' ? { text: p } : { text: '' },
        );
        return [{ role: 'user', parts }];
      }

      if (first && typeof first === 'object' && 'text' in first) {
        const parts: Part[] = contents.map((p) => {
          if (typeof p === 'string') return { text: p };
          if (p && typeof p === 'object' && 'text' in p) {
            return p;
          }
          return { text: '' };
        });
        return [{ role: 'user', parts }];
      }

      // Array of Content objects
      return contents.filter(
        (c): c is Content =>
          typeof c === 'object' && c !== null && 'parts' in c,
      );
    }

    if (typeof contents === 'object' && contents !== null) {
      if ('parts' in contents) {
        return [contents];
      }
      if ('text' in contents) {
        return [{ role: 'user', parts: [contents] }];
      }
    }

    return [];
  }

  private contentToMessages(content: Content): OpenAIMessage[] {
    const messages: OpenAIMessage[] = [];
    const role = content.role === 'model' ? 'assistant' : 'user';

    if (!content.parts || content.parts.length === 0) {
      return messages;
    }

    const textParts: string[] = [];
    const toolCalls: OpenAIToolCall[] = [];
    let toolCallIdCounter = 0;

    for (const part of content.parts) {
      if (part.functionResponse) {
        // --- LOCAL FORK ADDITION (Phase 2.0.4) ---
        // Sanitize for Mistral's strict 9-char alphanumeric tool_call_id
        // contract. Safe for Qwen/Gemma/OpenAI (they accept any string).
        // Must use IDENTICAL logic to the assistant tool_calls branch below
        // so paired ids collide on the same (name, counter) input.
        const rawId = `call_${part.functionResponse.name}_${toolCallIdCounter++}`;
        messages.push({
          role: 'tool',
          tool_call_id: mistralSafeToolCallId(rawId),
          content: JSON.stringify(part.functionResponse.response ?? {}),
        });
        // --- END LOCAL FORK ADDITION ---
        continue;
      }

      if (part.functionCall) {
        // --- LOCAL FORK ADDITION (Phase 2.0.4) ---
        // See sanitization rationale above; this branch must mirror it
        // exactly so the assistant id matches the tool message tool_call_id.
        const rawId = `call_${part.functionCall.name}_${toolCallIdCounter++}`;
        toolCalls.push({
          id: mistralSafeToolCallId(rawId),
          type: 'function',
          function: {
            name: part.functionCall.name ?? '',
            arguments: JSON.stringify(part.functionCall.args ?? {}),
          },
        });
        // --- END LOCAL FORK ADDITION ---
        continue;
      }

      if (part.text && !part.thought) {
        textParts.push(part.text);
      }
    }

    if (toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: textParts.length > 0 ? textParts.join('') : null,
        tool_calls: toolCalls,
      });
    } else if (textParts.length > 0) {
      messages.push({
        role,
        content: textParts.join(''),
      });
    }

    return messages;
  }

  private extractTextFromContentUnion(value: unknown): string | null {
    if (!value) return null;
    if (typeof value === 'string') return value;

    if (Array.isArray(value)) {
      return value
        .map((item: unknown) => {
          if (typeof item === 'string') return item;
          if (isTextPart(item)) return item.text;
          return '';
        })
        .join('');
    }

    if (isTextPart(value)) return value.text;

    if (isContentLike(value)) {
      return (
        value.parts
          .filter(isTextPart)
          .map((p) => p.text)
          .join('') || null
      );
    }

    return null;
  }

  private translateTools(tools: unknown): OpenAITool[] {
    return translateToolsToOpenAI(tools);
  }

  // ---------------------------------------------------------------------------
  // SSE stream parsing: OpenAI → Gemini
  // ---------------------------------------------------------------------------

  private async *parseSSEStream(
    body: ReadableStream<Uint8Array>,
    requestBody: Record<string, unknown>,
  ): AsyncGenerator<GenerateContentResponse> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';

    // State machine for <think>...</think> tag handling.
    // Reasoning models (Qwen3, DeepSeek-R1, etc.) emit thinking tokens inside
    // these tags. We route them as thought parts so the CLI renders them in its
    // collapsible thinking UI rather than inline with the response text.
    let inThinkBlock = false;
    let thinkBuffer = '';

    const pendingToolCalls = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    // Buffer all content text — some models (Qwen3) emit tool calls as XML
    // inside content rather than structured tool_calls when vLLM's parser
    // doesn't match. We detect and extract them at stream end.
    let contentBuffer = '';
    let lastFinishReason: string | null = null;
    let lastResponseId = '';
    let lastUsage: OpenAIStreamChunk['usage'] | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });

        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();

          if (trimmed === '' || trimmed.startsWith(':')) continue;

          if (trimmed === 'data: [DONE]') {
            // Flush any unclosed think block as a thought
            if (inThinkBlock && thinkBuffer) {
              yield this.buildThoughtResponse(thinkBuffer);
              thinkBuffer = '';
              inThinkBlock = false;
            }
            if (pendingToolCalls.size > 0) {
              yield this.buildToolCallResponse(pendingToolCalls);
              pendingToolCalls.clear();
            } else if (lastFinishReason === 'tool_calls') {
              // vLLM detected a tool call but didn't populate structured data.
              // Try XML extraction from streamed content first.
              const xmlCalls = this.parseXmlToolCalls(contentBuffer);
              if (xmlCalls.length > 0) {
                yield this.buildGeminiResponse(
                  null,
                  'tool_calls',
                  xmlCalls,
                  lastResponseId,
                );
              } else {
                // Streaming gave us finish_reason=tool_calls but no actual
                // data. Re-issue as non-streaming to recover the tool calls.
                debugLogger.log(
                  '[LocalLLM] Streaming returned empty tool_calls; retrying non-streaming',
                );
                yield* this.retryNonStreaming(requestBody);
              }
            }
            if (lastUsage) {
              yield this.buildUsageResponse(lastUsage);
            }
            return;
          }

          if (!trimmed.startsWith('data: ')) continue;

          const jsonStr = trimmed.slice(6);
          let chunk: OpenAIStreamChunk;
          try {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            chunk = JSON.parse(jsonStr) as OpenAIStreamChunk;
          } catch {
            debugLogger.log(
              `[LocalLLM] Skipping malformed SSE chunk: ${jsonStr.slice(0, 200)}`,
            );
            continue;
          }

          if (chunk.usage) {
            lastUsage = chunk.usage;
          }

          const choice = chunk.choices?.[0];
          if (!choice) continue;

          if (choice.delta.tool_calls && choice.delta.tool_calls.length > 0) {
            for (const tc of choice.delta.tool_calls) {
              const existing = pendingToolCalls.get(tc.index);
              if (existing) {
                existing.arguments += tc.function?.arguments ?? '';
              } else {
                pendingToolCalls.set(tc.index, {
                  id: tc.id ?? `call_${tc.index}`,
                  name: tc.function?.name ?? '',
                  arguments: tc.function?.arguments ?? '',
                });
              }
            }
            continue;
          }

          const deltaText = choice.delta.content;
          const reasoningContent =
            choice.delta.reasoning_content ?? choice.delta.reasoning;

          // Thinking tokens: vLLM uses "reasoning", OpenAI-compat servers
          // use "reasoning_content". Check both fields.
          if (reasoningContent) {
            yield this.buildThoughtResponse(reasoningContent);
          }

          if (deltaText) {
            contentBuffer += deltaText;
            const thinkState = { inThinkBlock, thinkBuffer };
            yield* this.splitThinkContent(
              deltaText,
              thinkState,
              (s) => {
                inThinkBlock = s.inThinkBlock;
                thinkBuffer = s.thinkBuffer;
              },
              choice.finish_reason,
              chunk.id,
            );
          }

          if (choice.finish_reason) {
            lastFinishReason = choice.finish_reason;
            lastResponseId = chunk.id;
          }

          if (
            choice.finish_reason &&
            choice.finish_reason !== 'tool_calls' &&
            !deltaText
          ) {
            yield this.buildGeminiResponse(
              null,
              choice.finish_reason,
              undefined,
              chunk.id,
            );
          }
        }
      }

      if (sseBuffer.trim()) {
        const trimmed = sseBuffer.trim();
        if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
          try {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            const chunk = JSON.parse(trimmed.slice(6)) as OpenAIStreamChunk;
            const choice = chunk.choices?.[0];
            if (choice?.delta.content) {
              const thinkState = { inThinkBlock, thinkBuffer };
              yield* this.splitThinkContent(
                choice.delta.content,
                thinkState,
                (s) => {
                  inThinkBlock = s.inThinkBlock;
                  thinkBuffer = s.thinkBuffer;
                },
                choice.finish_reason,
                chunk.id,
              );
            }
          } catch {
            debugLogger.log(
              `[LocalLLM] Skipping trailing malformed SSE data: ${trimmed.slice(0, 200)}`,
            );
          }
        }
      }

      // Flush any remaining unclosed think block
      if (inThinkBlock && thinkBuffer) {
        yield this.buildThoughtResponse(thinkBuffer);
      }

      if (pendingToolCalls.size > 0) {
        yield this.buildToolCallResponse(pendingToolCalls);
      } else if (lastFinishReason === 'tool_calls') {
        const xmlCalls = this.parseXmlToolCalls(contentBuffer);
        if (xmlCalls.length > 0) {
          yield this.buildGeminiResponse(
            null,
            'tool_calls',
            xmlCalls,
            lastResponseId,
          );
        } else {
          debugLogger.log(
            '[LocalLLM] Stream ended with tool_calls but no data; retrying non-streaming',
          );
          yield* this.retryNonStreaming(requestBody);
        }
      }

      if (lastUsage) {
        yield this.buildUsageResponse(lastUsage);
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Splits a raw text delta that may contain <think>...</think> tags into
   * separate thought and regular-text GenerateContentResponse chunks.
   *
   * Mutates parse state via the setState callback so the caller's inThinkBlock
   * and thinkBuffer variables stay in sync across SSE chunk boundaries.
   */
  private *splitThinkContent(
    delta: string,
    state: { inThinkBlock: boolean; thinkBuffer: string },
    setState: (s: { inThinkBlock: boolean; thinkBuffer: string }) => void,
    finishReason: string | null,
    responseId: string,
  ): Generator<GenerateContentResponse> {
    let { inThinkBlock, thinkBuffer } = state;
    let remaining = delta;

    while (remaining.length > 0) {
      if (inThinkBlock) {
        const closeIdx = remaining.indexOf('</think>');
        if (closeIdx === -1) {
          // Entire remaining delta is still inside the think block
          thinkBuffer += remaining;
          remaining = '';
        } else {
          // Found the closing tag — emit thought, switch back to normal mode
          thinkBuffer += remaining.slice(0, closeIdx);
          yield this.buildThoughtResponse(thinkBuffer);
          thinkBuffer = '';
          inThinkBlock = false;
          remaining = remaining.slice(closeIdx + '</think>'.length);
        }
      } else {
        const openIdx = remaining.indexOf('<think>');
        if (openIdx === -1) {
          // No think tag — but strip any orphaned </think> that bled into content
          // (can happen when the server uses reasoning_content + inline closing tag).
          const orphanClose = remaining.indexOf('</think>');
          const cleaned =
            orphanClose !== -1
              ? remaining.slice(0, orphanClose) +
                remaining.slice(orphanClose + '</think>'.length)
              : remaining;
          if (cleaned) {
            yield this.buildGeminiResponse(
              cleaned,
              finishReason,
              undefined,
              responseId,
            );
          }
          remaining = '';
        } else {
          // Emit text before the think tag, then enter think mode
          if (openIdx > 0) {
            yield this.buildGeminiResponse(
              remaining.slice(0, openIdx),
              finishReason,
              undefined,
              responseId,
            );
          }
          inThinkBlock = true;
          remaining = remaining.slice(openIdx + '<think>'.length);
        }
      }
    }

    setState({ inThinkBlock, thinkBuffer });
  }

  /**
   * Re-issues the same request as non-streaming when streaming returned
   * finish_reason=tool_calls but no actual tool call data. Some vLLM
   * tool-call parsers fail to populate the streaming tool_calls array but
   * the non-streaming response includes the XML tool call text in content.
   */
  private async *retryNonStreaming(
    originalBody: Record<string, unknown>,
  ): AsyncGenerator<GenerateContentResponse> {
    const nonStreamBody = buildNonStreamRetryBody(originalBody);
    const response = await this.fetchWithTimeout(nonStreamBody);

    if (!response.ok) {
      const text = await response.text().catch(() => '<unreadable>');
      // --- LOCAL FORK ADDITION (Phase 2.0.6-diag) ---
      if (response.status === 400) {
        const rawMsgs = nonStreamBody['messages'];
        const bodyMsgs: OpenAIMessage[] = Array.isArray(rawMsgs)
          ? rawMsgs.filter(
              (m): m is OpenAIMessage => isRecord(m) && isString(m['role']),
            )
          : [];
        const roleSeq = bodyMsgs.map((m: OpenAIMessage, idx: number) => {
          let label = `[${idx}] ${m.role}`;
          if (m.role === 'assistant' && m.tool_calls) {
            label += ` (tool_calls: ${m.tool_calls.map((tc) => tc.id).join(', ')})`;
          }
          if (m.role === 'tool' && m.tool_call_id) {
            label += ` (tool_call_id: ${m.tool_call_id})`;
          }
          return label;
        });
        const diagOutput = `[${new Date().toISOString()}] 400 error (retryNonStreaming) — model="${this.model}", isMistral=${isMistralFamilyModel(this.model)}\nRole sequence:\n${roleSeq.join('\n')}\nvLLM error: ${text}\n\n`;
        try {
          const fs = await import('node:fs');
          fs.appendFileSync('/tmp/gemini-local-diag.log', diagOutput);
        } catch {
          /* ignore write failure */
        }
      }
      // --- END LOCAL FORK ADDITION ---
      throw new Error(
        `Local LLM non-streaming retry returned HTTP ${response.status}: ${text}`,
      );
    }

    const json: unknown = await response.json();
    if (!isRecord(json)) return;

    const choices = json['choices'];
    if (!Array.isArray(choices) || choices.length === 0) return;

    const firstChoice: unknown = choices[0];
    if (!isRecord(firstChoice)) return;
    const message: unknown = firstChoice['message'];
    if (!isRecord(message)) return;

    const msg = message;
    const content = isString(msg['content']) ? msg['content'] : '';
    const reasoning = isString(msg['reasoning'])
      ? msg['reasoning']
      : isString(msg['reasoning_content'])
        ? msg['reasoning_content']
        : '';

    if (reasoning) {
      yield this.buildThoughtResponse(reasoning);
    }

    // Try structured tool_calls first
    const toolCalls = msg['tool_calls'];
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      const calls: OpenAIToolCall[] = [];
      for (const tc of toolCalls) {
        if (!isRecord(tc)) continue;
        const fn = tc['function'];
        if (!isRecord(fn)) continue;
        calls.push({
          id: isString(tc['id']) ? tc['id'] : `call_retry_${calls.length}`,
          type: 'function',
          function: {
            name: isString(fn['name']) ? fn['name'] : '',
            arguments: isString(fn['arguments']) ? fn['arguments'] : '',
          },
        });
      }
      if (calls.length > 0) {
        yield this.buildGeminiResponse(null, 'tool_calls', calls);
        return;
      }
    }

    // Fall back to XML parsing from content
    const xmlCalls = this.parseXmlToolCalls(content);
    if (xmlCalls.length > 0) {
      yield this.buildGeminiResponse(null, 'tool_calls', xmlCalls);
      return;
    }

    // Nothing found — emit whatever content we have
    if (content.trim()) {
      yield this.buildGeminiResponse(content, 'stop');
    }
  }

  /**
   * Extracts tool calls from Qwen-style XML in content text.
   *
   * Qwen3 emits tool calls like:
   *   <tool_call>
   *   <function=write_file>
   *   <parameter=file_path>test.txt</parameter>
   *   <parameter=content>hello</parameter>
   *   </function>
   *   </tool_call>
   *
   * Returns OpenAI-shaped tool call objects so they can be passed directly to
   * buildGeminiResponse().
   */
  private parseXmlToolCalls(content: string): OpenAIToolCall[] {
    // --- LOCAL FORK ADDITION (Phase 2.0.12) ---
    // Read mode from config on every response so /local toolcall <mode>
    // takes effect live without restart.
    const mode = this.config.getLocalToolCallParseMode();
    return parseXmlToolCalls(content, mode);
    // --- END LOCAL FORK ADDITION ---
  }

  /**
   * Builds a GenerateContentResponse that carries a thought part.
   * The CLI's turn.ts routes parts with thought:true to the thinking UI.
   */
  private buildThoughtResponse(text: string): GenerateContentResponse {
    const response = {
      candidates: [
        {
          content: {
            parts: [{ text: text.trim(), thought: true }],
            role: 'model',
          },
          finishReason: undefined,
          index: 0,
        },
      ],
    };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return Object.setPrototypeOf(response, GenerateContentResponse.prototype);
  }

  // ---------------------------------------------------------------------------
  // Token usage helpers
  // ---------------------------------------------------------------------------

  private attachUsageMetadata(
    response: GenerateContentResponse,
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    },
  ): void {
    const meta = {
      promptTokenCount: usage.prompt_tokens,
      candidatesTokenCount: usage.completion_tokens,
      totalTokenCount: usage.total_tokens,
    };
    Object.assign(response, { usageMetadata: meta });
  }

  private buildUsageResponse(usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  }): GenerateContentResponse {
    const response = {
      candidates: [],
      usageMetadata: {
        promptTokenCount: usage.prompt_tokens,
        candidatesTokenCount: usage.completion_tokens,
        totalTokenCount: usage.total_tokens,
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return Object.setPrototypeOf(response, GenerateContentResponse.prototype);
  }

  // ---------------------------------------------------------------------------
  // Response construction: OpenAI → Gemini SDK shape
  // ---------------------------------------------------------------------------

  private buildGeminiResponse(
    text: string | null,
    finishReason: string | null,
    toolCalls?: OpenAIToolCall[],
    responseId?: string,
  ): GenerateContentResponse {
    const parts: Part[] = [];

    if (text) {
      parts.push({ text });
    }

    if (toolCalls && toolCalls.length > 0) {
      for (const tc of toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          args = {};
        }
        parts.push({
          functionCall: {
            name: tc.function.name,
            args,
          },
        });
      }
    }

    const mappedFinishReason = finishReason
      ? (FINISH_REASON_MAP[finishReason] ?? undefined)
      : undefined;

    const response = {
      candidates: [
        {
          content: {
            parts,
            role: 'model',
          },
          finishReason: mappedFinishReason,
          index: 0,
        },
      ],
      responseId,
    };

    // Use the same prototype trick as FakeContentGenerator so SDK getters
    // (e.g. functionCalls, text) work on our plain objects.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return Object.setPrototypeOf(response, GenerateContentResponse.prototype);
  }

  private buildToolCallResponse(
    pendingToolCalls: Map<
      number,
      { id: string; name: string; arguments: string }
    >,
  ): GenerateContentResponse {
    const parts: Part[] = [];

    for (const [, tc] of pendingToolCalls) {
      let args: Record<string, unknown> = {};
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        args = JSON.parse(tc.arguments) as Record<string, unknown>;
      } catch {
        args = {};
      }
      parts.push({
        functionCall: {
          name: tc.name,
          args,
        },
      });
    }

    const response = {
      candidates: [
        {
          content: {
            parts,
            role: 'model',
          },
          finishReason: 'STOP',
          index: 0,
        },
      ],
    };

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return Object.setPrototypeOf(response, GenerateContentResponse.prototype);
  }

  // ---------------------------------------------------------------------------
  // HTTP fetch helper
  // ---------------------------------------------------------------------------

  // --- LOCAL FORK ADDITION (Phase 2.0.10) ---
  /**
   * Lazily-loaded undici Agent dedicated to the local LLM endpoint.
   *
   * Why this exists:
   *   Node's global `fetch` uses undici's process-wide pool with a default
   *   keep-alive timeout of ~4s. When a generation takes minutes (Mistral
   *   119B "long thinking"), the response socket stays open and works fine,
   *   but the pool can also hold OTHER idle sockets to the same origin from
   *   earlier turns. When those idle sockets get silently dropped (TCP
   *   keepalive expiry, kernel reaping, or vLLM's keep-alive timeout firing
   *   first), the next request reuses the dead socket and Node surfaces it
   *   as the unhelpful `TypeError: fetch failed` — *before the request ever
   *   leaves the process*. The user then sees "Cannot reach local LLM" while
   *   curl to the same URL works instantly.
   *
   * Mitigation:
   *   - Keep the pool tiny so we never hoard idle sockets.
   *   - Expire idle sockets fast (1.5s) so the half-life of any stale
   *     connection is shorter than realistic LLM-side timeouts.
   *   - On `fetch failed` (the undici "socket closed" signature), retry
   *     ONCE with a fresh dispatcher — the new connection is guaranteed not
   *     to be a reused stale one.
   *
   * Loaded via dynamic import to avoid pulling undici into the upstream
   * Gemini code path (rebase-safety: only local mode pays the cost).
   */
  private dispatcher: unknown | null = null;

  private async getDispatcher(): Promise<unknown> {
    if (this.dispatcher) return this.dispatcher;
    try {
      const undici = await import('undici');
      this.dispatcher = new undici.Agent({
        keepAliveTimeout: 1500,
        keepAliveMaxTimeout: 5000,
        connectTimeout: 30_000,
        connections: 4,
        pipelining: 0,
      });
    } catch (e) {
      debugLogger.debug?.(
        '[LocalLLM Phase 2.0.10] undici unavailable, falling back to default fetch dispatcher: ' +
          (e instanceof Error ? e.message : String(e)),
      );
      this.dispatcher = null;
    }
    return this.dispatcher;
  }

  private async resetDispatcher(): Promise<void> {
    const old = this.dispatcher;
    this.dispatcher = null;
    if (isClosable(old)) {
      try {
        await old.close();
      } catch {
        // best-effort
      }
    }
  }
  // --- END LOCAL FORK ADDITION ---

  private async fetchWithTimeout(
    body: Record<string, unknown>,
  ): Promise<Response> {
    const timeoutMs = this.config.getLocalTimeout();

    // --- LOCAL FORK ADDITION (Phase 2.0.10) ---
    // Single retry for stale-socket ("fetch failed") errors. A fresh
    // dispatcher on retry guarantees a new TCP connection.
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const dispatcher = await this.getDispatcher();
        const init: RequestInit & { dispatcher?: unknown } = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        };
        if (dispatcher) init.dispatcher = dispatcher;
        const response = await fetch(this.url, init);
        return response;
      } catch (error: unknown) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(
            `Local LLM request timed out after ${timeoutMs}ms. ` +
              `Increase timeout via GEMINI_LOCAL_TIMEOUT or local.timeout in settings.`,
          );
        }

        const msg = error instanceof Error ? error.message : String(error);
        const isStaleSocket =
          msg.includes('fetch failed') ||
          msg.includes('UND_ERR_SOCKET') ||
          msg.includes('other side closed') ||
          msg.includes('ECONNRESET');

        if (isStaleSocket && attempt < maxAttempts) {
          debugLogger.debug?.(
            `[LocalLLM Phase 2.0.10] stale-socket signature on attempt ${attempt}; rebuilding dispatcher and retrying. error=${msg}`,
          );
          await this.resetDispatcher();
          continue;
        }

        if (
          msg.includes('ECONNREFUSED') ||
          msg.includes('fetch failed') ||
          msg.includes('ENOTFOUND')
        ) {
          throw new Error(
            `Cannot reach local LLM at ${this.url}. Is vLLM/Ollama running?\n` +
              `Original error: ${msg}`,
          );
        }

        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    // Unreachable: loop either returns or throws.
    throw new Error('Local LLM fetch retry loop exited without resolution');
    // --- END LOCAL FORK ADDITION ---
  }
}
