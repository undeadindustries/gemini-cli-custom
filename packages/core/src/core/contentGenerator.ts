/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GoogleGenAI,
  type CountTokensResponse,
  type GenerateContentResponse,
  type GenerateContentParameters,
  type CountTokensParameters,
  type EmbedContentResponse,
  type EmbedContentParameters,
} from '@google/genai';
import * as os from 'node:os';
import { createCodeAssistContentGenerator } from '../code_assist/codeAssist.js';
import { isCloudShell } from '../ide/detect-ide.js';
import type { Config } from '../config/config.js';
import { loadApiKey } from './apiKeyCredentialStorage.js';

import type { UserTierId, GeminiUserTier } from '../code_assist/types.js';
import { LoggingContentGenerator } from './loggingContentGenerator.js';
import { InstallationManager } from '../utils/installationManager.js';
import { FakeContentGenerator } from './fakeContentGenerator.js';
import { LocalLlmContentGenerator } from './localLlmContentGenerator.js';
// --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
import { OpenAIResponsesContentGenerator } from './openaiResponsesContentGenerator.js';
// --- END LOCAL FORK ADDITION ---
import { parseCustomHeaders } from '../utils/customHeaderUtils.js';
import { determineSurface } from '../utils/surface.js';
import { RecordingContentGenerator } from './recordingContentGenerator.js';
import { getVersion, resolveModel } from '../../index.js';
import type { LlmRole } from '../telemetry/llmRole.js';

/**
 * Interface abstracting the core functionalities for generating content and counting tokens.
 */
export interface ContentGenerator {
  generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
    role: LlmRole,
  ): Promise<GenerateContentResponse>;

  generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
    role: LlmRole,
  ): Promise<AsyncGenerator<GenerateContentResponse>>;

  countTokens(request: CountTokensParameters): Promise<CountTokensResponse>;

  embedContent(request: EmbedContentParameters): Promise<EmbedContentResponse>;

  userTier?: UserTierId;

  userTierName?: string;

  paidTier?: GeminiUserTier;
}

// --- LOCAL FORK ADDITION (Phase 2.2) ---
// AuthType moved to a leaf module (`./authType.ts`) to break a runtime
// circular-init cycle between providerRegistry.ts → contentGenerator.ts
// → ../../index.js → config.ts → providerRegistry.ts. Re-exported here
// so existing `import { AuthType } from './contentGenerator.js'` paths
// keep compiling unchanged.
// --- END LOCAL FORK ADDITION ---
export { AuthType } from './authType.js';
import { AuthType } from './authType.js';

/**
 * Detects the best authentication type based on environment variables.
 *
 * Checks in order:
 * 1. GOOGLE_GENAI_USE_GCA=true -> LOGIN_WITH_GOOGLE
 * 2. GOOGLE_GENAI_USE_VERTEXAI=true -> USE_VERTEX_AI
 * 3. GEMINI_API_KEY -> USE_GEMINI
 */
export function getAuthTypeFromEnv(): AuthType | undefined {
  // --- LOCAL FORK ADDITION (Phase 2.1.1) ---
  // GEMINI_PROVIDER and GEMINI_LOCAL_URL both map to AuthType.LOCAL since
  // they share the OpenAI-compat wire format. The per-provider config
  // (URL, key, model) lives in Config, not the enum.
  if (
    process.env['GEMINI_PROVIDER']?.trim() ||
    process.env['GEMINI_LOCAL_URL']
  ) {
    return AuthType.LOCAL;
  }
  // --- END LOCAL FORK ADDITION ---
  if (process.env['GOOGLE_GENAI_USE_GCA'] === 'true') {
    return AuthType.LOGIN_WITH_GOOGLE;
  }
  if (process.env['GOOGLE_GENAI_USE_VERTEXAI'] === 'true') {
    return AuthType.USE_VERTEX_AI;
  }
  if (process.env['GEMINI_API_KEY']) {
    return AuthType.USE_GEMINI;
  }
  if (
    process.env['CLOUD_SHELL'] === 'true' ||
    process.env['GEMINI_CLI_USE_COMPUTE_ADC'] === 'true'
  ) {
    return AuthType.COMPUTE_ADC;
  }
  return undefined;
}

export type ContentGeneratorConfig = {
  apiKey?: string;
  vertexai?: boolean;
  authType?: AuthType;
  proxy?: string;
  baseUrl?: string;
  customHeaders?: Record<string, string>;
  vertexAiRouting?: VertexAiRoutingConfig;
};

export type VertexAiRequestType = 'dedicated' | 'shared';
export type VertexAiSharedRequestType = 'priority' | 'flex';

export interface VertexAiRoutingConfig {
  requestType?: VertexAiRequestType;
  sharedRequestType?: VertexAiSharedRequestType;
}

const VERTEX_AI_REQUEST_TYPE_HEADER = 'X-Vertex-AI-LLM-Request-Type';
const VERTEX_AI_SHARED_REQUEST_TYPE_HEADER =
  'X-Vertex-AI-LLM-Shared-Request-Type';

function validateBaseUrl(baseUrl: string): void {
  try {
    new URL(baseUrl);
  } catch {
    throw new Error(`Invalid custom base URL: ${baseUrl}`);
  }
}

export async function createContentGeneratorConfig(
  config: Config,
  authType: AuthType | undefined,
  apiKey?: string,
  baseUrl?: string,
  customHeaders?: Record<string, string>,
  vertexAiRouting?: VertexAiRoutingConfig,
): Promise<ContentGeneratorConfig> {
  const contentGeneratorConfig: ContentGeneratorConfig = {
    authType,
    proxy: config?.getProxy(),
    baseUrl,
    customHeaders,
    vertexAiRouting,
  };

  // If we are using Google auth or we are in Cloud Shell, there is nothing else to validate for now.
  // Return before touching the API-key keychain: on Linux without a Secret Service
  // (WSL/SSH/Docker/CI) keytar can block indefinitely on its functional probe.
  if (
    authType === AuthType.LOGIN_WITH_GOOGLE ||
    authType === AuthType.COMPUTE_ADC
  ) {
    return contentGeneratorConfig;
  }

  const geminiApiKey =
    apiKey ||
    process.env['GEMINI_API_KEY'] ||
    (await loadApiKey()) ||
    undefined;
  const googleApiKey = process.env['GOOGLE_API_KEY'] || undefined;
  const googleCloudProject =
    process.env['GOOGLE_CLOUD_PROJECT'] ||
    process.env['GOOGLE_CLOUD_PROJECT_ID'] ||
    undefined;
  const googleCloudLocation = process.env['GOOGLE_CLOUD_LOCATION'] || undefined;

  if (authType === AuthType.USE_GEMINI && geminiApiKey) {
    contentGeneratorConfig.apiKey = geminiApiKey;
    contentGeneratorConfig.vertexai = false;

    return contentGeneratorConfig;
  }

  if (
    authType === AuthType.USE_VERTEX_AI &&
    (googleApiKey || (googleCloudProject && googleCloudLocation))
  ) {
    contentGeneratorConfig.apiKey = googleApiKey;
    contentGeneratorConfig.vertexai = true;

    return contentGeneratorConfig;
  }

  if (authType === AuthType.GATEWAY) {
    contentGeneratorConfig.apiKey = apiKey || 'gateway-placeholder-key';
    contentGeneratorConfig.vertexai = false;

    return contentGeneratorConfig;
  }

  return contentGeneratorConfig;
}

export async function createContentGenerator(
  config: ContentGeneratorConfig,
  gcConfig: Config,
  sessionId?: string,
): Promise<ContentGenerator> {
  const generator = await (async () => {
    if (gcConfig.fakeResponses) {
      const fakeGenerator = await FakeContentGenerator.fromFile(
        gcConfig.fakeResponses,
      );
      return new LoggingContentGenerator(fakeGenerator, gcConfig);
    }

    // --- LOCAL FORK ADDITION (Phase 2.2: unified provider dispatcher) ---
    // ONE branch covers every backend that speaks the OpenAI Chat
    // Completions wire format — local presets (vLLM, llama.cpp), generic
    // OpenAI-compat servers, and hosted providers (OpenAI, ...). The
    // dispatch decision lives in Config.getEffectiveProviderConfig(),
    // which carries `wireFormat` + `authType` from the registry.
    //
    // For `wireFormat === 'gemini'` we fall through to the existing
    // upstream Gemini code path below — `config.authType` was already
    // set by refreshAuth() to the correct LOGIN_WITH_GOOGLE / USE_GEMINI
    // / USE_VERTEX_AI value, so the upstream branches just work without
    // any fork-side fences.
    //
    // Env-var overrides (GEMINI_LOCAL_URL / GEMINI_LOCAL_MODEL) keep
    // working so existing CI / scripts that point at a local server
    // without touching settings.json still resolve into this branch.
    const effective = gcConfig.getEffectiveProviderConfig?.();
    const envUrl = process.env['GEMINI_LOCAL_URL'];
    const envModel = process.env['GEMINI_LOCAL_MODEL'];

    // Shared auth resolver for OpenAI-shaped providers (chat or
    // responses).
    //
    // Phase 2.4.5 update — soft-gate behavior:
    //
    //   - `requiresApiKey: true`  (built-in `openai`, `openai-responses`,
    //     and any custom provider declared with --env): the user MUST
    //     have a key configured; we throw an actionable error if none is
    //     found, since the upstream will 401 anyway and the early throw
    //     gives a much friendlier message than a raw HTTP error.
    //
    //   - `requiresApiKey: false`: optimistically try the credential
    //     resolver; if a key has been saved (keychain or env var) we
    //     send it as a Bearer header — covers users who added a custom
    //     provider with `/provider add` (no --env flag) and later did
    //     `/provider set <id> key ...`. If no key is found we return
    //     `undefined` so genuinely-no-auth local servers (bare vLLM,
    //     llama.cpp, ollama) keep their byte-identical no-Authorization
    //     request shape. NEVER throws on this path — the user opted
    //     into "not required" by virtue of not declaring an env var,
    //     so we trust them.
    //
    //   - No active provider: returns `undefined`.
    const resolveOpenAIAuth = async (): Promise<
      { apiKey?: string; extraHeaders?: Record<string, string> } | undefined
    > => {
      if (!effective) return undefined;
      const providerId = effective.providerId;
      const { resolveProviderApiKey } = await import(
        '../providers/providerCredentialStorage.js'
      );
      let resolved;
      try {
        resolved = gcConfig.getActiveProviderResolved?.();
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        if (effective.requiresApiKey) {
          throw new Error(`Hosted provider configuration error: ${reason}`);
        }
        return undefined;
      }
      if (!resolved) {
        if (effective.requiresApiKey) {
          throw new Error(
            `Hosted provider '${providerId}' could not be resolved. ` +
              `Run /provider list to see configured providers.`,
          );
        }
        return undefined;
      }
      const key = await resolveProviderApiKey(providerId);
      if (!key) {
        if (effective.requiresApiKey) {
          throw new Error(
            `No API key configured for provider '${providerId}'. ` +
              `Set the ${resolved.definition.apiKeyEnvVar} env var, ` +
              `or run /provider set ${providerId} key.`,
          );
        }
        // requiresApiKey: false AND no key found — preserve the
        // no-Authorization request shape that local servers expect.
        return undefined;
      }
      const headers = {
        ...resolved.definition.buildAuthHeaders(key),
        ...(resolved.definition.buildExtraHeaders?.() ?? {}),
      };
      // The Authorization header is set inside fetchWithTimeout from
      // `apiKey`; pass extra headers (e.g. OpenRouter's HTTP-Referer)
      // through so they ride every request.
      delete headers['Authorization'];
      const extraHeaders = Object.keys(headers).length ? headers : undefined;
      return { apiKey: key, extraHeaders };
    };

    // --- LOCAL FORK ADDITION (Phase 2.4: OpenAI Responses API) ---
    // Branch comes BEFORE the openai-chat branch so the env-var
    // fallback path (GEMINI_LOCAL_URL) keeps routing into chat-completions
    // — the legacy local-LLM contract is chat-only, and the env-var
    // fallback exists exclusively for that contract.
    if (effective && effective.wireFormat === 'openai-responses') {
      const url = effective.url || '';
      const model = effective.model || 'gpt-5';
      const auth = await resolveOpenAIAuth();
      return new LoggingContentGenerator(
        new OpenAIResponsesContentGenerator(url, model, gcConfig, auth),
        gcConfig,
      );
    }
    // --- END LOCAL FORK ADDITION ---

    const isOpenAiCompat =
      (effective && effective.wireFormat === 'openai-chat') || !!envUrl;
    if (isOpenAiCompat) {
      const url = envUrl || effective?.url || '';
      const model = envModel || effective?.model || 'local-model';

      // Hosted providers (requiresApiKey: true) resolve a Bearer token
      // from env or keychain. Local presets skip the resolver entirely so
      // localhost traffic never carries an Authorization header.
      const auth = await resolveOpenAIAuth();

      return new LoggingContentGenerator(
        new LocalLlmContentGenerator(url, model, gcConfig, auth),
        gcConfig,
      );
    }
    // For wireFormat === 'gemini' (or no provider configured), fall
    // through to the existing upstream Gemini code path.
    // --- END LOCAL FORK ADDITION ---

    const version = await getVersion();
    const model = resolveModel(
      gcConfig.getModel(),
      config.authType === AuthType.USE_GEMINI ||
        config.authType === AuthType.USE_VERTEX_AI ||
        ((await gcConfig.getGemini31Launched?.()) ?? false),
      config.authType === AuthType.USE_GEMINI ||
        config.authType === AuthType.USE_VERTEX_AI ||
        ((await gcConfig.getGemini31FlashLiteLaunched?.()) ?? false),
      false,
      gcConfig.getHasAccessToPreviewModel?.() ?? true,
      gcConfig,
    );
    const customHeadersEnv =
      process.env['GEMINI_CLI_CUSTOM_HEADERS'] || undefined;
    const clientName = gcConfig.getClientName();
    const surface = determineSurface();

    let userAgent: string;
    // Use unified format for VS Code traffic.
    // Note: We don't automatically assume a2a-server is VS Code,
    // as it could be used by other clients unless the surface explicitly says 'vscode'.
    if (clientName === 'acp-vscode' || surface === 'vscode') {
      const osTypeMap: Record<string, string> = {
        darwin: 'macOS',
        win32: 'Windows',
        linux: 'Linux',
      };
      const osType = osTypeMap[process.platform] || process.platform;
      const osVersion = os.release();
      const arch = process.arch;

      const vscodeVersion = process.env['TERM_PROGRAM_VERSION'] || 'unknown';
      let hostPath = `VSCode/${vscodeVersion}`;
      if (isCloudShell()) {
        const cloudShellVersion =
          process.env['CLOUD_SHELL_VERSION'] || 'unknown';
        hostPath += ` > CloudShell/${cloudShellVersion}`;
      }

      userAgent = `CloudCodeVSCode/${version} (aidev_client; os_type=${osType}; os_version=${osVersion}; arch=${arch}; host_path=${hostPath}; proxy_client=geminicli)`;
    } else {
      const userAgentPrefix = clientName
        ? `GeminiCLI-${clientName}`
        : 'GeminiCLI';
      userAgent = `${userAgentPrefix}/${version}/${model} (${process.platform}; ${process.arch}; ${surface})`;
    }

    const customHeadersMap = parseCustomHeaders(customHeadersEnv);
    const apiKeyAuthMechanism =
      process.env['GEMINI_API_KEY_AUTH_MECHANISM'] || 'x-goog-api-key';
    const apiVersionEnv = process.env['GOOGLE_GENAI_API_VERSION'];

    const baseHeaders: Record<string, string> = {
      'User-Agent': userAgent,
      ...customHeadersMap,
    };

    if (
      apiKeyAuthMechanism === 'bearer' &&
      (config.authType === AuthType.USE_GEMINI ||
        config.authType === AuthType.USE_VERTEX_AI) &&
      config.apiKey
    ) {
      baseHeaders['Authorization'] = `Bearer ${config.apiKey}`;
    }
    if (
      config.authType === AuthType.LOGIN_WITH_GOOGLE ||
      config.authType === AuthType.COMPUTE_ADC
    ) {
      const httpOptions = { headers: baseHeaders };
      return new LoggingContentGenerator(
        await createCodeAssistContentGenerator(
          httpOptions,
          config.authType,
          gcConfig,
          sessionId,
        ),
        gcConfig,
      );
    }

    if (
      config.authType === AuthType.USE_GEMINI ||
      config.authType === AuthType.USE_VERTEX_AI ||
      config.authType === AuthType.GATEWAY
    ) {
      let headers: Record<string, string> = { ...baseHeaders };
      if (config.customHeaders) {
        headers = { ...headers, ...config.customHeaders };
      }
      if (
        config.authType === AuthType.USE_VERTEX_AI &&
        config.vertexAiRouting
      ) {
        const { requestType, sharedRequestType } = config.vertexAiRouting;
        headers = {
          ...headers,
          ...(requestType
            ? { [VERTEX_AI_REQUEST_TYPE_HEADER]: requestType }
            : {}),
          ...(sharedRequestType
            ? { [VERTEX_AI_SHARED_REQUEST_TYPE_HEADER]: sharedRequestType }
            : {}),
        };
      }
      if (gcConfig?.getUsageStatisticsEnabled()) {
        const installationManager = new InstallationManager();
        const installationId = installationManager.getInstallationId();
        headers = {
          ...headers,
          'x-gemini-api-privileged-user-id': `${installationId}`,
        };
      }
      let baseUrl = config.baseUrl;
      if (!baseUrl) {
        const envBaseUrl =
          config.authType === AuthType.USE_VERTEX_AI
            ? process.env['GOOGLE_VERTEX_BASE_URL']
            : process.env['GOOGLE_GEMINI_BASE_URL'];
        if (envBaseUrl) {
          validateBaseUrl(envBaseUrl);
          baseUrl = envBaseUrl;
        }
      } else {
        validateBaseUrl(baseUrl);
      }

      const httpOptions: {
        baseUrl?: string;
        headers: Record<string, string>;
      } = { headers };

      if (baseUrl) {
        httpOptions.baseUrl = baseUrl;
      }

      const googleGenAI = new GoogleGenAI({
        apiKey: config.apiKey === '' ? undefined : config.apiKey,
        vertexai: config.vertexai ?? config.authType === AuthType.USE_VERTEX_AI,
        httpOptions,
        ...(apiVersionEnv && { apiVersion: apiVersionEnv }),
      });
      return new LoggingContentGenerator(googleGenAI.models, gcConfig);
    }
    throw new Error(
      `Error creating contentGenerator: Unsupported authType: ${config.authType}`,
    );
  })();

  if (gcConfig.recordResponses) {
    return new RecordingContentGenerator(generator, gcConfig.recordResponses);
  }

  return generator;
}
