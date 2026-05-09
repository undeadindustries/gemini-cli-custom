/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
// New file. Implements `wireFormat: 'openai-responses'` against the
// OpenAI POST /v1/responses endpoint and its SSE response.* event
// stream. Sibling of LocalLlmContentGenerator (chat-completions);
// neither file depends on the other so a future upstream rebase that
// touches one cannot accidentally break the other.

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
import { estimateTokenCountSync } from '../utils/tokenCalculation.js';
// --- LOCAL FORK ADDITION (Phase 2.4.7: opt-in wire-level logger) ---
import { logWire, isWireLoggingEnabled } from './wireLogger.js';
// --- END LOCAL FORK ADDITION ---

/**
 * Auth bag — same shape as `OpenAICompatAuth` in the chat generator. Kept
 * locally instead of imported so the two generator files stay
 * rebase-independent.
 */
export interface OpenAIResponsesAuth {
  apiKey?: string;
  extraHeaders?: Record<string, string>;
}

/**
 * Reasoning effort levels accepted by the Responses endpoint.
 *
 * `minimal` and `high` are gpt-5-codex specific extensions; the documented
 * baseline is `low | medium | high`. We pass through whatever the caller
 * supplies (validation lives at the settings boundary) so future server
 * additions don't need a code change here.
 */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

/** Single content part inside an `input` message item. */
type InputContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string };

/** One element of the `input` array sent in the request body. */
type InputItem =
  | {
      type: 'message';
      role: 'user' | 'assistant' | 'system';
      content: InputContentPart[];
    }
  | {
      type: 'function_call';
      call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: 'function_call_output';
      call_id: string;
      output: string;
    };

/** Top-level tool declaration shape. */
interface ResponsesTool {
  type: 'function';
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
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

function isClosable(v: unknown): v is { close: () => Promise<void> } {
  if (!isRecord(v)) return false;
  const close = v['close'];
  return typeof close === 'function';
}

function isTextPart(value: unknown): value is TextPart {
  if (!isRecord(value)) return false;
  return 'text' in value && isString(value['text']);
}

function isContentLike(value: unknown): value is ContentLike {
  if (!isRecord(value)) return false;
  return 'parts' in value && Array.isArray(value['parts']);
}

/**
 * Map a Responses-API "status" / finish-style hint to a Gemini
 * `finishReason`. The Responses endpoint doesn't surface a single
 * finish_reason; we synthesise one based on which output items closed
 * the response.
 */
function mapFinishReason(
  reason: string | null | undefined,
): string | undefined {
  if (!reason) return undefined;
  switch (reason) {
    case 'stop':
    case 'completed':
      return 'STOP';
    case 'length':
    case 'max_output_tokens':
      return 'MAX_TOKENS';
    case 'tool_calls':
    case 'function_call':
      return 'STOP';
    case 'content_filter':
    case 'safety':
      return 'SAFETY';
    default:
      return undefined;
  }
}

/**
 * Translate a `FunctionDeclaration[]`-style tool array (Gemini SDK
 * shape) to the flat `ResponsesTool[]` shape the /v1/responses
 * endpoint accepts. Note the lack of a nested `function: { ... }`
 * wrapper — that's the chat-completions shape and the Responses API
 * rejects it.
 *
 * Exported for unit tests.
 */
export function translateToolsToResponses(tools: unknown): ResponsesTool[] {
  if (!tools || !Array.isArray(tools)) return [];
  const result: ResponsesTool[] = [];
  for (const tool of tools) {
    if (tool && typeof tool === 'object' && 'functionDeclarations' in tool) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const typed = tool as ToolWithFunctionDeclarations;
      const decls = typed.functionDeclarations;
      if (!Array.isArray(decls)) continue;
      for (const decl of decls) {
        const parameters: Record<string, unknown> =
          decl.parameters != null
            ? decl.parameters
            : { type: 'object', properties: {} };
        result.push({
          type: 'function',
          name: decl.name ?? '',
          description: decl.description ?? undefined,
          parameters,
        });
      }
    }
  }
  return result;
}

/**
 * Sanitize a free-form id (model-generated tool-call id, our internal
 * synthetic id, etc.) so it round-trips through the Responses API
 * without rejection. The Responses endpoint is more permissive than
 * chat-completions/Mistral, but we still strip any non-printable
 * characters defensively.
 */
function safeCallId(rawId: string): string {
  if (!rawId) return 'call_unknown';
  // Keep it bounded — pathological history could otherwise stuff
  // multi-KB blobs into the JSON body.
  return rawId.replace(/[^\x20-\x7E]/g, '').slice(0, 256) || 'call_unknown';
}

/**
 * Output of {@link OpenAIResponsesContentGenerator.translateRequest},
 * exported for unit-test fixtures so tests can drive the SSE mapper
 * end-to-end without reaching into private state.
 */
export interface ResponsesRequestPlan {
  input: InputItem[];
  tools: ResponsesTool[];
  instructions?: string;
}

/**
 * Pure-function variant of the request translator. Same logic as
 * {@link OpenAIResponsesContentGenerator.translateRequest}; lives
 * outside the class so unit tests can call it without instantiating
 * the generator (no Config dependency).
 */
export function translateRequestToResponses(
  request: GenerateContentParameters,
  options: { toolsEnabled: boolean },
): ResponsesRequestPlan {
  const input: InputItem[] = [];
  let instructions: string | undefined;

  const systemInstruction = request.config?.systemInstruction;
  if (systemInstruction) {
    const text = extractTextFromContentUnion(systemInstruction);
    if (text) instructions = text;
  }

  const contents = normalizeContents(request.contents);
  for (const content of contents) {
    const items = contentToInputItems(content);
    for (const item of items) input.push(item);
  }

  const tools = options.toolsEnabled
    ? translateToolsToResponses(request.config?.tools)
    : [];

  return { input, tools, instructions };
}

/**
 * Extract the text body from any of Gemini's `ContentUnion` shapes used
 * by `systemInstruction`. Mirrors the chat-completions implementation
 * but isn't shared on purpose (rebase safety).
 */
function extractTextFromContentUnion(value: unknown): string | null {
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

/**
 * Coerce the Gemini `ContentListUnion` shape to a flat `Content[]`.
 * Same intent as the chat generator's `normalizeContents`.
 */
function normalizeContents(
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
        if (p && typeof p === 'object' && 'text' in p) return p;
        return { text: '' };
      });
      return [{ role: 'user', parts }];
    }
    return contents.filter(
      (c): c is Content => typeof c === 'object' && c !== null && 'parts' in c,
    );
  }
  if (typeof contents === 'object' && contents !== null) {
    if ('parts' in contents) return [contents];
    if ('text' in contents) {
      return [{ role: 'user', parts: [contents] }];
    }
  }
  return [];
}

/**
 * Translate one Gemini Content into one or more Responses-API input
 * items. Function calls and function responses each become their own
 * structured item; text parts collapse into a single message item.
 */
function contentToInputItems(content: Content): InputItem[] {
  const items: InputItem[] = [];
  if (!content.parts || content.parts.length === 0) return items;

  const role: 'user' | 'assistant' =
    content.role === 'model' ? 'assistant' : 'user';
  const textParts: string[] = [];
  let toolCallIdCounter = 0;

  for (const part of content.parts) {
    if (part.functionResponse) {
      const rawId =
        part.functionResponse.id ??
        `call_${part.functionResponse.name ?? 'unknown'}_${toolCallIdCounter++}`;
      items.push({
        type: 'function_call_output',
        call_id: safeCallId(rawId),
        output: JSON.stringify(part.functionResponse.response ?? {}),
      });
      continue;
    }
    if (part.functionCall) {
      const rawId =
        part.functionCall.id ??
        `call_${part.functionCall.name ?? 'unknown'}_${toolCallIdCounter++}`;
      items.push({
        type: 'function_call',
        call_id: safeCallId(rawId),
        name: part.functionCall.name ?? '',
        arguments: JSON.stringify(part.functionCall.args ?? {}),
      });
      continue;
    }
    if (part.text && !part.thought) {
      textParts.push(part.text);
    }
  }

  if (textParts.length > 0) {
    items.push({
      type: 'message',
      role,
      content: [
        {
          type: role === 'assistant' ? 'output_text' : 'input_text',
          text: textParts.join(''),
        },
      ],
    });
  }

  return items;
}

/**
 * Local interpretation of the SSE event payload from /v1/responses.
 * The official type set is sprawling — only the shapes we touch are
 * declared here. Anything else is structurally typed via
 * `Record<string, unknown>`.
 */
interface ResponsesSseEvent {
  type: string;
  response?: {
    id?: string;
    status?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
    error?: { message?: string; type?: string };
  };
  delta?: string;
  item?: {
    id?: string;
    type?: string;
    role?: string;
    name?: string;
    arguments?: string;
    call_id?: string;
  };
  output_index?: number;
  error?: { message?: string; type?: string };
}

/**
 * State maintained by the SSE mapper across events for a single
 * /v1/responses stream. Exposed (via the test-only helper at the
 * bottom of this file) so the mapper can be unit-tested incrementally.
 */
export interface SseMapperState {
  /** Per-output-index buffer for assembling streamed function calls. */
  pendingFunctionCalls: Map<
    number,
    { call_id: string; name: string; arguments: string }
  >;
  /** Last `response.id` observed; stored on `response.completed`. */
  responseId?: string;
  /** Last usage block observed. */
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  /** Whether the response terminated cleanly (`response.completed`). */
  completed: boolean;
}

export function createSseMapperState(): SseMapperState {
  return { pendingFunctionCalls: new Map(), completed: false };
}

/**
 * ContentGenerator that talks the OpenAI Responses-API wire format.
 *
 * Sibling of {@link LocalLlmContentGenerator}; neither imports the
 * other. Streams via SSE, builds Gemini-shaped responses, and (when
 * `useResponseChaining` is enabled) writes the trailing `response.id`
 * onto the live Config so the next request body can carry
 * `previous_response_id`.
 */
export class OpenAIResponsesContentGenerator implements ContentGenerator {
  constructor(
    private readonly url: string,
    private readonly model: string,
    private readonly config: Config,
    private readonly auth?: OpenAIResponsesAuth,
  ) {}

  // --- LOCAL FORK ADDITION (Phase 2.4.7: content-type guard) ---
  /**
   * Verify a 2xx response actually has the content-type we know how to
   * parse. Throws a clear, user-actionable error otherwise. See
   * {@link LocalLlmContentGenerator.assertResponseContentType} for the
   * full rationale; same shape, same surfacing path.
   */
  private async assertResponseContentType(
    response: Response,
    expected: 'json' | 'sse',
  ): Promise<void> {
    const contentType = (response.headers.get('content-type') ?? '')
      .toLowerCase()
      .trim();
    const isJson = contentType.startsWith('application/json');
    const isSse = contentType.startsWith('text/event-stream');
    if (expected === 'json' && isJson) return;
    if (expected === 'sse' && (isSse || isJson)) return;
    if (expected === 'json' && contentType === '') return;
    let preview = '<unreadable>';
    try {
      const text = await response.clone().text();
      preview = text.length > 2000 ? text.slice(0, 2000) + '…' : text;
    } catch {
      /* keep <unreadable> */
    }
    throw new Error(
      `Provider at ${this.url} returned HTTP ${response.status} but with ` +
        `unexpected Content-Type "${contentType || '<missing>'}" ` +
        `(expected ${expected === 'json' ? 'application/json' : 'text/event-stream'}). ` +
        `This usually means the URL is wrong (e.g. the API root rather than ` +
        `/v1/responses). Body preview: ${preview}`,
    );
  }
  // --- END LOCAL FORK ADDITION ---

  // --- LOCAL FORK ADDITION (Phase 2.4.6: pre-flight model check) ---
  /**
   * Symmetric counterpart to LocalLlmContentGenerator.assertModelOrLocalhost.
   *
   * The Responses API default model is `'gpt-5'`, which is a real id, so
   * this branch is far less likely to trigger in practice. It is kept
   * for symmetry: a user can in principle add a custom Responses-API
   * provider and forget to set a model, and we want the same actionable
   * error rather than an opaque HTTP 400 from the upstream endpoint.
   *
   * See {@link LocalLlmContentGenerator.assertModelOrLocalhost} for the
   * full rationale of localhost / RFC1918 / `.local` allowlisting.
   */
  private assertModelOrLocalhost(): void {
    if (this.model !== 'local-model') return;
    let hostname: string;
    try {
      hostname = new URL(this.url).hostname;
    } catch {
      return;
    }
    const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const isLoopback =
      lower === 'localhost' || lower === '127.0.0.1' || lower === '::1';
    const isRfc1918 =
      lower.startsWith('10.') ||
      lower.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(lower);
    const isMdns = lower.endsWith('.local');
    if (isLoopback || isRfc1918 || isMdns) return;
    throw new Error(
      `No model configured for Responses API provider at ${this.url}. ` +
        `Set a model with '/model set <name> --persist' or ` +
        `'/provider set <id> model <name>'.`,
    );
  }
  // --- END LOCAL FORK ADDITION ---

  async generateContent(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role: LlmRole,
  ): Promise<GenerateContentResponse> {
    // --- LOCAL FORK ADDITION (Phase 2.4.6) ---
    this.assertModelOrLocalhost();
    // --- END LOCAL FORK ADDITION ---
    const body = this.buildRequestBody(request, /* stream */ false);
    const response = await this.fetchWithTimeout(body);
    if (!response.ok) {
      const text = await response.text().catch(() => '<unreadable>');
      // Any error invalidates the chained id — the server's view and
      // ours are now out of sync; fall back to full-history re-send.
      this.maybeClearChainOnError();
      throw new Error(
        `OpenAI Responses returned HTTP ${response.status}: ${text}`,
      );
    }

    // --- LOCAL FORK ADDITION (Phase 2.4.7) ---
    await this.assertResponseContentType(response, 'json');
    // --- END LOCAL FORK ADDITION ---

    const json: unknown = await response.json();
    const eff = this.config.getEffectiveProviderConfig?.();
    const built = this.buildNonStreamingResponse(json);
    if (eff?.useResponseChaining && built.responseId) {
      this.config.setLastResponseId?.(built.responseId);
    }
    return built.response;
  }

  async generateContentStream(
    request: GenerateContentParameters,
    _userPromptId: string,
    _role: LlmRole,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    // --- LOCAL FORK ADDITION (Phase 2.4.6) ---
    this.assertModelOrLocalhost();
    // --- END LOCAL FORK ADDITION ---
    const body = this.buildRequestBody(request, /* stream */ true);
    const response = await this.fetchWithTimeout(body);
    if (!response.ok) {
      const text = await response.text().catch(() => '<unreadable>');
      this.maybeClearChainOnError();
      throw new Error(
        `OpenAI Responses returned HTTP ${response.status}: ${text}`,
      );
    }
    // --- LOCAL FORK ADDITION (Phase 2.4.7) ---
    await this.assertResponseContentType(response, 'sse');
    // --- END LOCAL FORK ADDITION ---
    if (!response.body) {
      throw new Error('OpenAI Responses streaming response has no body');
    }
    return this.parseSSEStream(response.body);
  }

  async countTokens(
    request: CountTokensParameters,
  ): Promise<CountTokensResponse> {
    const parts = this.extractPartsFromContents(request.contents);
    const estimated = parts.length > 0 ? estimateTokenCountSync(parts) : 0;
    debugLogger.log(
      `[OpenAI Responses] countTokens heuristic estimate: ${estimated} tokens`,
    );
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return Object.setPrototypeOf(
      { totalTokens: estimated },
      CountTokensResponse.prototype,
    );
  }

  async embedContent(
    _request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    throw new Error(
      'embedContent is not supported on the OpenAI Responses endpoint. ' +
        'Switch to a chat-completions provider or use a Gemini API key for embedding operations.',
    );
  }

  // ---------------------------------------------------------------------------
  // Request building
  // ---------------------------------------------------------------------------

  /**
   * Build the JSON body for a Responses request. `stream` toggles the
   * top-level field; everything else is identical between streaming
   * and non-streaming modes (unlike the chat-completions endpoint, the
   * Responses API doesn't have stream_options quirks).
   */
  private buildRequestBody(
    request: GenerateContentParameters,
    stream: boolean,
  ): Record<string, unknown> {
    const toolsEnabled = this.config.isLocalToolsEnabled();
    const plan = translateRequestToResponses(request, { toolsEnabled });

    const eff = this.config.getEffectiveProviderConfig?.();
    const useChaining = !!eff?.useResponseChaining;
    const previousId = useChaining
      ? this.config.getLastResponseId?.()
      : undefined;

    // When chaining and we have a previous id, send only the new
    // tail of `input` (the items added since the last successful
    // turn). We can approximate that as "everything past the last
    // assistant message" — but the cheapest correct thing is to
    // trust the caller: gemini-cli's chat module passes in the full
    // conversation, so when chaining is on we strip everything
    // except the last user-or-tool input items. The server already
    // has the previous turns cached server-side under `previous_response_id`.
    const input =
      useChaining && previousId ? trimInputForChaining(plan.input) : plan.input;

    const body: Record<string, unknown> = {
      model: this.model,
      input,
      stream,
    };
    // --- LOCAL FORK ADDITION (Phase 2.4.7: system-prompt override) ---
    // When the active provider sets a non-empty
    // `systemPromptOverride`, replace the upstream Gemini-CLI
    // preamble wholesale. Same rationale as the chat-completions
    // path: hosted non-Gemini models pattern-match on the dense
    // "Gemini CLI" / "GEMINI.md" mentions in the upstream prompt
    // and self-identify as Google's model. Empty / unset preserves
    // upstream behavior. See settingsSchema.ts for caveats.
    const overrideText = eff?.systemPromptOverride;
    const finalInstructions =
      typeof overrideText === 'string' && overrideText.length > 0
        ? overrideText
        : plan.instructions;
    if (finalInstructions) {
      body['instructions'] = finalInstructions;
    }
    // --- END LOCAL FORK ADDITION ---
    if (plan.tools.length > 0) {
      body['tools'] = plan.tools;
    }

    // Per-provider temperature.
    const temperature = this.config.getLocalTemperature?.();
    if (temperature !== null && temperature !== undefined) {
      body['temperature'] = temperature;
    }

    // Reasoning effort. Resolution chain
    //   session override → provider setting → undefined (server decides)
    // lives inside Config.getReasoningEffort(). When undefined we omit
    // the field entirely so the server's documented default applies.
    const effort = this.config.getReasoningEffort?.();
    if (effort) {
      body['reasoning'] = { effort };
    }

    if (useChaining && previousId) {
      body['previous_response_id'] = previousId;
    }

    return body;
  }

  // ---------------------------------------------------------------------------
  // Non-streaming response handling
  // ---------------------------------------------------------------------------

  /**
   * Parse a non-streaming `/v1/responses` body into a single
   * GenerateContentResponse. Exposes the response id alongside so the
   * caller can store it on Config when chaining is enabled.
   */
  private buildNonStreamingResponse(payload: unknown): {
    response: GenerateContentResponse;
    responseId?: string;
  } {
    if (!isRecord(payload)) {
      return { response: this.buildEmptyResponse() };
    }
    const id = isString(payload['id']) ? payload['id'] : undefined;
    const status = isString(payload['status']) ? payload['status'] : undefined;
    const output = Array.isArray(payload['output']) ? payload['output'] : [];

    const parts: Part[] = [];
    for (const item of output) {
      if (!isRecord(item)) continue;
      const itemType = item['type'];
      if (itemType === 'message') {
        const contentArr = Array.isArray(item['content'])
          ? item['content']
          : [];
        for (const cp of contentArr) {
          if (!isRecord(cp)) continue;
          const cpType = cp['type'];
          if (
            (cpType === 'output_text' || cpType === 'text') &&
            isString(cp['text'])
          ) {
            parts.push({ text: cp['text'] });
          }
        }
      } else if (itemType === 'function_call') {
        const name = isString(item['name']) ? item['name'] : '';
        const argsStr = isString(item['arguments']) ? item['arguments'] : '';
        let args: Record<string, unknown> = {};
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          args = JSON.parse(argsStr || '{}') as Record<string, unknown>;
        } catch {
          args = {};
        }
        parts.push({ functionCall: { name, args } });
      } else if (itemType === 'reasoning') {
        // Surface reasoning summaries as thoughts so the CLI's
        // collapsible thinking UI renders them. Spec exposes the body
        // at `summary[].text` for completed reasoning items.
        const summary = Array.isArray(item['summary']) ? item['summary'] : [];
        for (const s of summary) {
          if (isRecord(s) && isString(s['text'])) {
            parts.push({ text: s['text'], thought: true });
          }
        }
      }
    }

    const finishReason = mapFinishReason(status);
    const responseObj = {
      candidates: [
        {
          content: { parts, role: 'model' },
          finishReason,
          index: 0,
        },
      ],
      responseId: id,
    };
    const usage = isRecord(payload['usage']) ? payload['usage'] : undefined;
    if (usage) {
      Object.assign(responseObj, {
        usageMetadata: responsesUsageToGemini(usage),
      });
    }
    // Object.setPrototypeOf returns `any`; assigning to a typed const
    // lets TypeScript accept the value without an explicit cast.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const response: GenerateContentResponse = Object.setPrototypeOf(
      responseObj,
      GenerateContentResponse.prototype,
    );
    return { response, responseId: id };
  }

  // ---------------------------------------------------------------------------
  // SSE stream handling
  // ---------------------------------------------------------------------------

  /**
   * Parse the SSE body of a streaming /v1/responses request into a
   * sequence of Gemini-shaped chunks. Mapping logic delegates to
   * {@link mapSseEvent} so the same code path is exercised by unit
   * tests.
   */
  private async *parseSSEStream(
    body: ReadableStream<Uint8Array>,
  ): AsyncGenerator<GenerateContentResponse> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    const state = createSseMapperState();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });

        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;
          // SSE event names arrive on `event: …` lines; we only care
          // about the `data: …` payload because every Responses SSE
          // event includes a `type` field inside the JSON.
          if (!trimmed.startsWith('data: ')) continue;

          const jsonStr = trimmed.slice(6);
          if (jsonStr === '[DONE]') return;

          let event: ResponsesSseEvent;
          try {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            event = JSON.parse(jsonStr) as ResponsesSseEvent;
          } catch {
            debugLogger.log(
              `[OpenAI Responses] Skipping malformed SSE chunk: ${jsonStr.slice(0, 200)}`,
            );
            continue;
          }

          for (const chunk of mapSseEvent(event, state)) {
            yield chunk;
          }
        }
      }

      // Best-effort: if the connection closed without a
      // response.completed, surface usage if we managed to capture
      // one mid-stream so the caller's accounting doesn't drift.
      if (!state.completed && state.usage) {
        yield buildUsageResponse(state.usage);
      }

      // Persist the chained id on success.
      if (state.completed && state.responseId) {
        const eff = this.config.getEffectiveProviderConfig?.();
        if (eff?.useResponseChaining) {
          this.config.setLastResponseId?.(state.responseId);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private maybeClearChainOnError(): void {
    const eff = this.config.getEffectiveProviderConfig?.();
    if (eff?.useResponseChaining) {
      this.config.clearLastResponseId?.();
    }
  }

  private buildEmptyResponse(): GenerateContentResponse {
    const r = {
      candidates: [
        {
          content: { parts: [], role: 'model' },
          finishReason: undefined,
          index: 0,
        },
      ],
    };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return Object.setPrototypeOf(r, GenerateContentResponse.prototype);
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

  // ---------------------------------------------------------------------------
  // HTTP fetch with stale-socket retry (mirrors LocalLlmContentGenerator's
  // dispatcher logic; duplicated on purpose to keep the two files
  // rebase-independent — see plan §"openaiHttpHelpers" for the gating
  // criteria that keep this from being extracted).
  // ---------------------------------------------------------------------------

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
        '[OpenAI Responses] undici unavailable, falling back to default fetch dispatcher: ' +
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
        /* best-effort */
      }
    }
  }

  private async fetchWithTimeout(
    body: Record<string, unknown>,
  ): Promise<Response> {
    const timeoutMs = this.config.getLocalTimeout();

    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const dispatcher = await this.getDispatcher();
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        };
        if (this.auth?.apiKey) {
          headers['Authorization'] = `Bearer ${this.auth.apiKey}`;
        }
        if (this.auth?.extraHeaders) {
          for (const [k, v] of Object.entries(this.auth.extraHeaders)) {
            headers[k] = v;
          }
        }
        const init: RequestInit & { dispatcher?: unknown } = {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        };
        if (dispatcher) init.dispatcher = dispatcher;
        // --- LOCAL FORK ADDITION (Phase 2.4.7) ---
        if (isWireLoggingEnabled()) {
          logWire({
            kind: 'request',
            generator: 'openai-responses',
            url: this.url,
            method: 'POST',
            headers,
            body: typeof init.body === 'string' ? init.body : undefined,
          });
        }
        // --- END LOCAL FORK ADDITION ---
        const response = await fetch(this.url, init);
        // --- LOCAL FORK ADDITION (Phase 2.4.7) ---
        if (isWireLoggingEnabled()) {
          let bodyPreview: string | undefined;
          if (!response.ok) {
            try {
              bodyPreview = await response.clone().text();
            } catch {
              bodyPreview = '<unreadable>';
            }
          }
          const respHeaders: Record<string, string> = {};
          response.headers.forEach((v, k) => {
            respHeaders[k] = v;
          });
          logWire({
            kind: 'response',
            generator: 'openai-responses',
            url: this.url,
            status: response.status,
            ok: response.ok,
            headers: respHeaders,
            body: bodyPreview,
          });
        }
        // --- END LOCAL FORK ADDITION ---
        return response;
      } catch (error: unknown) {
        // --- LOCAL FORK ADDITION (Phase 2.4.7) ---
        if (isWireLoggingEnabled()) {
          logWire({
            kind: 'error',
            generator: 'openai-responses',
            url: this.url,
            phase: 'fetch',
            message: error instanceof Error ? error.message : String(error),
          });
        }
        // --- END LOCAL FORK ADDITION ---
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(
            `OpenAI Responses request timed out after ${timeoutMs}ms. ` +
              `Increase the per-provider timeout via /provider set <id> timeout, ` +
              `or set GEMINI_LOCAL_TIMEOUT.`,
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
            `[OpenAI Responses] stale-socket signature on attempt ${attempt}; rebuilding dispatcher and retrying. error=${msg}`,
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
            `Cannot reach OpenAI Responses endpoint at ${this.url}. ` +
              `Check the URL and your network. Original error: ${msg}`,
          );
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(
      'OpenAI Responses fetch retry loop exited without resolution',
    );
  }
}

// =============================================================================
// Pure helpers exported for unit testing
// =============================================================================

/**
 * Convert a Responses-API usage block to the Gemini-SDK
 * `usageMetadata` shape. Exported for unit tests.
 */
export function responsesUsageToGemini(usage: Record<string, unknown>): {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
} {
  const rawInput = usage['input_tokens'];
  const rawOutput = usage['output_tokens'];
  const rawTotal = usage['total_tokens'];
  const input = typeof rawInput === 'number' ? rawInput : 0;
  const output = typeof rawOutput === 'number' ? rawOutput : 0;
  const total = typeof rawTotal === 'number' ? rawTotal : input + output;
  return {
    promptTokenCount: input,
    candidatesTokenCount: output,
    totalTokenCount: total,
  };
}

/**
 * Build a usage-only GenerateContentResponse. Mirrors the chat
 * generator's `buildUsageResponse` so accounting hooks downstream
 * don't care which wire format produced the chunk.
 */
function buildUsageResponse(usage: {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}): GenerateContentResponse {
  const r = {
    candidates: [],
    usageMetadata: {
      promptTokenCount: usage.input_tokens,
      candidatesTokenCount: usage.output_tokens,
      totalTokenCount: usage.total_tokens,
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return Object.setPrototypeOf(r, GenerateContentResponse.prototype);
}

/**
 * Build a Gemini-shaped chunk carrying a single text delta. Pure;
 * exported only via re-call inside the mapper below.
 */
function buildTextChunk(
  text: string,
  responseId: string | undefined,
  finishReason?: string,
): GenerateContentResponse {
  const r = {
    candidates: [
      {
        content: { parts: [{ text }], role: 'model' },
        finishReason: mapFinishReason(finishReason ?? undefined),
        index: 0,
      },
    ],
    responseId,
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return Object.setPrototypeOf(r, GenerateContentResponse.prototype);
}

function buildThoughtChunk(text: string): GenerateContentResponse {
  const r = {
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
  return Object.setPrototypeOf(r, GenerateContentResponse.prototype);
}

function buildToolCallChunk(
  pending: Map<number, { call_id: string; name: string; arguments: string }>,
  responseId?: string,
): GenerateContentResponse {
  const parts: Part[] = [];
  for (const [, tc] of pending) {
    let args: Record<string, unknown> = {};
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      args = JSON.parse(tc.arguments || '{}') as Record<string, unknown>;
    } catch {
      args = {};
    }
    parts.push({ functionCall: { name: tc.name, args } });
  }
  const r = {
    candidates: [
      {
        content: { parts, role: 'model' },
        finishReason: 'STOP',
        index: 0,
      },
    ],
    responseId,
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return Object.setPrototypeOf(r, GenerateContentResponse.prototype);
}

/**
 * Map a single SSE event to zero or more Gemini-shaped chunks while
 * mutating `state` to track tool-call accumulation, response id, and
 * usage. Pure: only mutates the state object passed in.
 *
 * Exported so unit tests can drive the mapper event-by-event without
 * spinning up an HTTP server.
 */
export function* mapSseEvent(
  event: ResponsesSseEvent,
  state: SseMapperState,
): Generator<GenerateContentResponse> {
  if (!event || typeof event.type !== 'string') return;

  switch (event.type) {
    // Lifecycle.
    case 'response.created':
    case 'response.in_progress':
    case 'response.output_item.added':
    case 'response.content_part.added':
    case 'response.content_part.done':
    case 'response.output_text.done':
    case 'response.reasoning_summary_text.done':
    case 'response.reasoning_text.done':
    case 'response.function_call_arguments.done':
      // Lifecycle markers — start tool-call accumulation if needed.
      if (
        event.type === 'response.output_item.added' &&
        event.item?.type === 'function_call'
      ) {
        const idx =
          typeof event.output_index === 'number' ? event.output_index : 0;
        state.pendingFunctionCalls.set(idx, {
          call_id: event.item.call_id ?? event.item.id ?? `call_${idx}`,
          name: event.item.name ?? '',
          arguments: event.item.arguments ?? '',
        });
      }
      return;

    case 'response.output_text.delta':
      if (typeof event.delta === 'string' && event.delta.length > 0) {
        yield buildTextChunk(event.delta, state.responseId);
      }
      return;

    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta':
      if (typeof event.delta === 'string' && event.delta.length > 0) {
        yield buildThoughtChunk(event.delta);
      }
      return;

    case 'response.function_call_arguments.delta': {
      const idx =
        typeof event.output_index === 'number' ? event.output_index : 0;
      const existing = state.pendingFunctionCalls.get(idx);
      if (existing) {
        existing.arguments += event.delta ?? '';
      } else {
        state.pendingFunctionCalls.set(idx, {
          call_id: event.item?.call_id ?? `call_${idx}`,
          name: event.item?.name ?? '',
          arguments: event.delta ?? '',
        });
      }
      return;
    }

    case 'response.output_item.done': {
      // Emit the completed function call (if any) for this index.
      if (event.item?.type === 'function_call') {
        const idx =
          typeof event.output_index === 'number' ? event.output_index : 0;
        const accum = state.pendingFunctionCalls.get(idx);
        if (accum) {
          // Some servers send the entire item with the final arguments
          // string in `done`; trust that over our delta-accumulated
          // string when present.
          if (typeof event.item.arguments === 'string') {
            accum.arguments = event.item.arguments;
          }
          if (typeof event.item.name === 'string' && event.item.name) {
            accum.name = event.item.name;
          }
          if (typeof event.item.call_id === 'string') {
            accum.call_id = event.item.call_id;
          }
          const single = new Map<
            number,
            { call_id: string; name: string; arguments: string }
          >();
          single.set(idx, accum);
          state.pendingFunctionCalls.delete(idx);
          yield buildToolCallChunk(single, state.responseId);
        }
      }
      return;
    }

    case 'response.completed': {
      state.completed = true;
      if (event.response?.id) state.responseId = event.response.id;
      const usage = event.response?.usage;
      if (usage) {
        state.usage = {
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: usage.output_tokens ?? 0,
          total_tokens:
            usage.total_tokens ??
            (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
        };
        yield buildUsageResponse(state.usage);
      }
      // Flush any tool calls that didn't get an explicit
      // output_item.done (rare; defensive).
      if (state.pendingFunctionCalls.size > 0) {
        yield buildToolCallChunk(state.pendingFunctionCalls, state.responseId);
        state.pendingFunctionCalls.clear();
      }
      return;
    }

    case 'response.failed':
    case 'response.incomplete':
    case 'error':
    case 'response.error': {
      const message =
        event.response?.error?.message ??
        event.error?.message ??
        'OpenAI Responses stream reported an error';
      throw new Error(`OpenAI Responses error: ${message}`);
    }

    default:
      // Unknown / future event type. Ignore so a server-side addition
      // doesn't crash the client.
      return;
  }
}

/**
 * When stateful chaining is on we don't want to re-send the entire
 * conversation — the server already has it cached server-side under
 * `previous_response_id`. Trim to the minimum viable tail: every
 * function-call output (the new tool results from this turn) plus
 * the most recent user message. If the input doesn't contain a fresh
 * user message (e.g. a tool-only continuation), keep all
 * function_call_output items.
 *
 * Exported for unit tests.
 */
export function trimInputForChaining(input: InputItem[]): InputItem[] {
  if (input.length === 0) return input;
  // Find the last user message; everything from it to the end is "the
  // new turn" (it may include tool outputs interleaved with a fresh
  // user prompt).
  let lastUserIdx = -1;
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (item.type === 'message' && item.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx >= 0) {
    return input.slice(lastUserIdx);
  }
  // No user message at all — return only function_call_output items
  // (tool-only continuation).
  return input.filter((i) => i.type === 'function_call_output');
}
// --- END LOCAL FORK ADDITION ---
