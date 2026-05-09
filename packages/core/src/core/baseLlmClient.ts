/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Content,
  Part,
  EmbedContentParameters,
  GenerateContentResponse,
  GenerateContentParameters,
  GenerateContentConfig,
} from '@google/genai';
import type { Config } from '../config/config.js';
import type { ContentGenerator, AuthType } from './contentGenerator.js';
import { handleFallback } from '../fallback/handler.js';
import { getResponseText } from '../utils/partUtils.js';
import { reportError } from '../utils/errorReporting.js';
import { getErrorMessage } from '../utils/errors.js';
import {
  logMalformedJsonResponse,
  logNetworkRetryAttempt,
} from '../telemetry/loggers.js';
import {
  MalformedJsonResponseEvent,
  LlmRole,
  NetworkRetryAttemptEvent,
} from '../telemetry/types.js';
import { retryWithBackoff, getRetryErrorType } from '../utils/retry.js';
import { coreEvents } from '../utils/events.js';
import { getDisplayString } from '../config/models.js';
import type { ModelConfigKey } from '../services/modelConfigService.js';
import {
  applyModelSelection,
  createAvailabilityContextProvider,
} from '../availability/policyHelpers.js';

const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Options for the generateJson utility function.
 */
export interface GenerateJsonOptions {
  /** The desired model config. */
  modelConfigKey: ModelConfigKey;
  /** The input prompt or history. */
  contents: Content[];
  /** The required JSON schema for the output. */
  schema: Record<string, unknown>;
  /**
   * Task-specific system instructions.
   * If omitted, no system instruction is sent.
   */
  systemInstruction?: string | Part | Part[] | Content;
  /** Signal for cancellation. */
  abortSignal: AbortSignal;
  /**
   * A unique ID for the prompt, used for logging/telemetry correlation.
   */
  promptId: string;
  /**
   * The role of the LLM call.
   */
  role: LlmRole;
  /**
   * The maximum number of attempts for the request.
   */
  maxAttempts?: number;
}

/**
 * Options for the generateContent utility function.
 */
export interface GenerateContentOptions {
  /** The desired model config. */
  modelConfigKey: ModelConfigKey;
  /** The input prompt or history. */
  contents: Content[];
  /**
   * Task-specific system instructions.
   * If omitted, no system instruction is sent.
   */
  systemInstruction?: string | Part | Part[] | Content;
  /** Signal for cancellation. */
  abortSignal: AbortSignal;
  /**
   * A unique ID for the prompt, used for logging/telemetry correlation.
   */
  promptId: string;
  /**
   * The role of the LLM call.
   */
  role: LlmRole;
  /**
   * The maximum number of attempts for the request.
   */
  maxAttempts?: number;
}

interface _CommonGenerateOptions {
  modelConfigKey: ModelConfigKey;
  contents: Content[];
  systemInstruction?: string | Part | Part[] | Content;
  abortSignal: AbortSignal;
  promptId: string;
  maxAttempts?: number;
  additionalProperties?: {
    responseJsonSchema: Record<string, unknown>;
    responseMimeType: string;
  };
}

export interface CountTokenOptions {
  modelConfigKey?: ModelConfigKey;
  contents: Content[];
}

/**
 * A client dedicated to stateless, utility-focused LLM calls.
 */
export class BaseLlmClient {
  constructor(
    private readonly contentGenerator: ContentGenerator,
    private readonly config: Config,
    private readonly authType?: AuthType,
  ) {}

  async generateJson(
    options: GenerateJsonOptions,
  ): Promise<Record<string, unknown>> {
    const {
      schema,
      modelConfigKey,
      contents,
      systemInstruction,
      abortSignal,
      promptId,
      role,
      maxAttempts,
    } = options;

    const { model } =
      this.config.modelConfigService.getResolvedConfig(modelConfigKey);

    const shouldRetryOnContent = (response: GenerateContentResponse) => {
      const text = getResponseText(response)?.trim();
      if (!text) {
        return true; // Retry on empty response
      }
      try {
        // We don't use the result, just check if it's valid JSON
        JSON.parse(this.cleanJsonResponse(text, model));
        return false; // It's valid, don't retry
      } catch {
        return true; // It's not valid, retry
      }
    };

    const result = await this._generateWithRetry(
      {
        modelConfigKey,
        contents,
        abortSignal,
        promptId,
        maxAttempts,
        systemInstruction,
        additionalProperties: {
          responseJsonSchema: schema,
          responseMimeType: 'application/json',
        },
      },
      shouldRetryOnContent,
      'generateJson',
      role,
    );

    // If we are here, the content is valid (not empty and parsable).
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return JSON.parse(
      this.cleanJsonResponse(getResponseText(result)!.trim(), model),
    );
  }

  async generateEmbedding(texts: string[]): Promise<number[][]> {
    if (!texts || texts.length === 0) {
      return [];
    }
    const embedModelParams: EmbedContentParameters = {
      model: this.config.getEmbeddingModel(),
      contents: texts,
    };

    const embedContentResponse =
      await this.contentGenerator.embedContent(embedModelParams);
    if (
      !embedContentResponse.embeddings ||
      embedContentResponse.embeddings.length === 0
    ) {
      throw new Error('No embeddings found in API response.');
    }

    if (embedContentResponse.embeddings.length !== texts.length) {
      throw new Error(
        `API returned a mismatched number of embeddings. Expected ${texts.length}, got ${embedContentResponse.embeddings.length}.`,
      );
    }

    return embedContentResponse.embeddings.map((embedding, index) => {
      const values = embedding.values;
      if (!values || values.length === 0) {
        throw new Error(
          `API returned an empty embedding for input text at index ${index}: "${texts[index]}"`,
        );
      }
      return values;
    });
  }

  private cleanJsonResponse(text: string, model: string): string {
    const prefix = '```json';
    const suffix = '```';
    if (text.startsWith(prefix) && text.endsWith(suffix)) {
      logMalformedJsonResponse(
        this.config,
        new MalformedJsonResponseEvent(model),
      );
      return text.substring(prefix.length, text.length - suffix.length).trim();
    }
    return text;
  }

  async countTokens(
    options: CountTokenOptions,
  ): Promise<{ totalTokens: number }> {
    const model = options.modelConfigKey
      ? this.config.modelConfigService.getResolvedConfig(options.modelConfigKey)
          .model
      : this.config.getActiveModel();
    const result = await this.contentGenerator.countTokens({
      model,
      contents: options.contents,
    });
    return { totalTokens: result.totalTokens || 0 };
  }

  async generateContent(
    options: GenerateContentOptions,
  ): Promise<GenerateContentResponse> {
    const {
      modelConfigKey,
      contents,
      systemInstruction,
      abortSignal,
      promptId,
      role,
      maxAttempts,
    } = options;

    const shouldRetryOnContent = (response: GenerateContentResponse) => {
      const text = getResponseText(response)?.trim();
      return !text; // Retry on empty response
    };

    return this._generateWithRetry(
      {
        modelConfigKey,
        contents,
        systemInstruction,
        abortSignal,
        promptId,
        maxAttempts,
      },
      shouldRetryOnContent,
      'generateContent',
      role,
    );
  }

  private async _generateWithRetry(
    options: _CommonGenerateOptions,
    shouldRetryOnContent: (response: GenerateContentResponse) => boolean,
    errorContext: 'generateJson' | 'generateContent',
    role: LlmRole = LlmRole.UTILITY_TOOL,
  ): Promise<GenerateContentResponse> {
    const {
      modelConfigKey,
      contents,
      systemInstruction,
      abortSignal,
      promptId,
      maxAttempts,
      additionalProperties,
    } = options;

    // --- LOCAL FORK ADDITION (Phase 2.4.9: route utility calls through
    //     active custom/OpenAI-compat provider) ---
    //
    // Problem: every utility call (compression, loop detection,
    // next-speaker check) passes a Gemini-alias model string such as
    // 'chat-compression-default', 'loop-detection', or
    // 'next-speaker-checker'. `applyModelSelection` resolves those
    // aliases through `defaultModelConfigs.ts`, which maps them to
    // concrete Gemini model ids (e.g. 'gemini-3-pro-preview',
    // 'gemini-3-flash-preview'). When the active provider is an
    // OpenAI-compat endpoint (OpenRouter, vLLM, direct OpenAI, etc.)
    // `this.contentGenerator` is already a `LocalLlmContentGenerator`
    // pointing at that endpoint — so the Gemini model id leaks into
    // the request body as `"model": "gemini-3-pro-preview"`. The
    // endpoint either rejects it (400) or routes to an unintended
    // model.
    //
    // Fix: when `isLocalMode()`, bypass alias resolution and use the
    // active provider's own model id. The rest of the pipeline
    // (`GenerateContentConfig`, retry handling) is unaffected — only
    // the `model` field in the request body changes.
    //
    // Caveats:
    //   - isLocalMode() is keyed on wireFormat === 'openai-chat'. It
    //     returns false for Gemini and openai-responses providers, so
    //     those are unaffected.
    //   - For openai-responses providers the same alias leakage exists
    //     (compression sends 'chat-compression-default' → Gemini id)
    //     but the compression 4-layer defense is already disabled for
    //     that wire format (isLocalMode() gate), so in practice
    //     compression never fires there. If that changes, this guard
    //     will need widening to `isLocalMode() || wireFormat ===
    //     'openai-responses'`.
    //   - 'local-model' is the server-picks placeholder; forwarding it
    //     is safe for bare vLLM/Ollama where the single loaded weight
    //     is chosen by the server and any model string is ignored.
    let overrideModel: string | undefined;
    if (this.config.isLocalMode()) {
      overrideModel = this.config.getLocalModel();
    }

    const {
      model,
      config: generateContentConfig,
      maxAttempts: availabilityMaxAttempts,
    } = overrideModel
      ? applyModelSelection(this.config, {
          ...modelConfigKey,
          model: overrideModel,
        })
      : applyModelSelection(this.config, modelConfigKey);

    let currentModel = model;
    let currentGenerateContentConfig = generateContentConfig;
    // --- END LOCAL FORK ADDITION ---

    // Define callback to fetch context dynamically since active model may get updated during retry loop
    const getAvailabilityContext = createAvailabilityContextProvider(
      this.config,
      () => currentModel,
    );

    let initialActiveModel = this.config.getActiveModel();

    try {
      const apiCall = () => {
        // Ensure we use the current active model
        // in case a fallback occurred in a previous attempt.
        const activeModel = this.config.getActiveModel();
        if (activeModel !== initialActiveModel) {
          initialActiveModel = activeModel;
          // Re-resolve config if model changed during retry.
          // --- LOCAL FORK ADDITION (Phase 2.4.9) ---
          // Keep the local-model override pinned during retries too.
          const retryModel = overrideModel ?? activeModel;
          // --- END LOCAL FORK ADDITION ---
          const { model: resolvedModel, generateContentConfig } =
            this.config.modelConfigService.getResolvedConfig({
              ...modelConfigKey,
              model: retryModel,
            });
          currentModel = resolvedModel;
          currentGenerateContentConfig = generateContentConfig;
        }
        const finalConfig: GenerateContentConfig = {
          ...currentGenerateContentConfig,
          ...(systemInstruction && { systemInstruction }),
          ...additionalProperties,
          abortSignal,
        };
        const requestParams: GenerateContentParameters = {
          model: currentModel,
          config: finalConfig,
          contents,
        };
        return this.contentGenerator.generateContent(
          requestParams,
          promptId,
          role,
        );
      };

      return await retryWithBackoff(apiCall, {
        shouldRetryOnContent,
        maxAttempts:
          availabilityMaxAttempts ?? maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        getAvailabilityContext,
        onPersistent429: this.config.isInteractive()
          ? (authType, error) =>
              handleFallback(this.config, currentModel, authType, error)
          : undefined,
        authType:
          this.authType ?? this.config.getContentGeneratorConfig()?.authType,
        retryFetchErrors: this.config.getRetryFetchErrors(),
        onRetry: (attempt, error, delayMs) => {
          const actualMaxAttempts =
            getAvailabilityContext()?.policy.maxAttempts ??
            maxAttempts ??
            DEFAULT_MAX_ATTEMPTS;
          const modelName = getDisplayString(currentModel);
          const errorType = getRetryErrorType(error);

          coreEvents.emitRetryAttempt({
            attempt,
            maxAttempts: actualMaxAttempts,
            delayMs,
            error: errorType,
            model: modelName,
          });

          logNetworkRetryAttempt(
            this.config,
            new NetworkRetryAttemptEvent(
              attempt,
              actualMaxAttempts,
              errorType,
              delayMs,
              modelName,
            ),
          );
        },
      });
    } catch (error) {
      if (abortSignal?.aborted) {
        throw error;
      }

      // Check if the error is from exhausting retries, and report accordingly.
      if (
        error instanceof Error &&
        error.message.includes('Retry attempts exhausted')
      ) {
        await reportError(
          error,
          `API returned invalid content after all retries.`,
          contents,
          `${errorContext}-invalid-content`,
        );
      } else {
        await reportError(
          error,
          `Error generating content via API.`,
          contents,
          `${errorContext}-api`,
        );
      }

      throw new Error(`Failed to generate content: ${getErrorMessage(error)}`);
    }
  }
}
