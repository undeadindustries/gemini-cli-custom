/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SandboxPolicyManager } from '../policy/sandboxPolicyManager.js';
import { inspect } from 'node:util';
import process from 'node:process';
import { z } from 'zod';
import type { ConversationRecord } from '../services/chatRecordingService.js';
import type {
  AgentHistoryProviderConfig,
  ContextManagementConfig,
  ToolOutputMaskingConfig,
} from '../context/types.js';
export type { ConversationRecord };
import {
  AuthType,
  createContentGenerator,
  createContentGeneratorConfig,
  type ContentGenerator,
  type ContentGeneratorConfig,
  type VertexAiRoutingConfig,
} from '../core/contentGenerator.js';
import type { OverageStrategy } from '../billing/billing.js';
import type { LocalModelInfo } from '../core/localModelDiscovery.js';
// --- LOCAL FORK ADDITION (Phase 2.1) ---
import {
  resolveProvider,
  effectiveRegistry,
  validateCustomProviderId,
  type ProviderInstanceConfig,
  type ResolvedProvider,
  type CustomProviderDefinition,
  type ProviderDefinition,
} from '../providers/providerRegistry.js';
// --- END LOCAL FORK ADDITION ---
import { discoverAndStoreLocalModels } from '../core/localModelBridge.js';
import { PromptRegistry } from '../prompts/prompt-registry.js';
import { ResourceRegistry } from '../resources/resource-registry.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { LSTool } from '../tools/ls.js';
import { ReadFileTool } from '../tools/read-file.js';
import { ReadMcpResourceTool } from '../tools/read-mcp-resource.js';
import { ListMcpResourcesTool } from '../tools/list-mcp-resources.js';
import { GrepTool } from '../tools/grep.js';
import { canUseRipgrep, RipGrepTool } from '../tools/ripGrep.js';
import { GlobTool } from '../tools/glob.js';
import { ActivateSkillTool } from '../tools/activate-skill.js';
import { EditTool } from '../tools/edit.js';
import { ShellTool } from '../tools/shell.js';
import { WriteFileTool } from '../tools/write-file.js';
import { WebFetchTool } from '../tools/web-fetch.js';
import {
  MemoryTool,
  setGeminiMdFilename,
  getCurrentGeminiMdFilename,
} from '../tools/memoryTool.js';
import { WebSearchTool } from '../tools/web-search.js';
import { AskUserTool } from '../tools/ask-user.js';
import { UpdateTopicTool } from '../tools/topicTool.js';
import { TopicState } from './topicState.js';
import { AgentTool } from '../agents/agent-tool.js';
import { ExitPlanModeTool } from '../tools/exit-plan-mode.js';
import { EnterPlanModeTool } from '../tools/enter-plan-mode.js';
import {
  ListBackgroundProcessesTool,
  ReadBackgroundOutputTool,
} from '../tools/shellBackgroundTools.js';
import { GeminiClient } from '../core/client.js';
import { BaseLlmClient } from '../core/baseLlmClient.js';
import { LocalLiteRtLmClient } from '../core/localLiteRtLmClient.js';
import type { HookDefinition, HookEventName } from '../hooks/types.js';
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import { GitService } from '../services/gitService.js';
import {
  type SandboxManager,
  NoopSandboxManager,
} from '../services/sandboxManager.js';
import { createSandboxManager } from '../services/sandboxManagerFactory.js';
import { SandboxedFileSystemService } from '../services/sandboxedFileSystemService.js';
import {
  initializeTelemetry,
  DEFAULT_TELEMETRY_TARGET,
  DEFAULT_OTLP_ENDPOINT,
  uiTelemetryService,
  type TelemetryTarget,
} from '../telemetry/index.js';
import { coreEvents, CoreEvent } from '../utils/events.js';
import { tokenLimit } from '../core/tokenLimits.js';
import {
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  DEFAULT_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_MODEL_AUTO,
  isAutoModel,
  isPreviewModel,
  isGemini2Model,
  PREVIEW_GEMINI_FLASH_MODEL,
  PREVIEW_GEMINI_MODEL,
  PREVIEW_GEMINI_MODEL_AUTO,
  resolveModel,
} from './models.js';
import { shouldAttemptBrowserLaunch } from '../utils/browser.js';
import type { MCPOAuthConfig } from '../mcp/oauth-provider.js';
import { ideContextStore } from '../ide/ideContext.js';
import { WriteTodosTool } from '../tools/write-todos.js';
import {
  StandardFileSystemService,
  type FileSystemService,
} from '../services/fileSystemService.js';
import {
  TrackerCreateTaskTool,
  TrackerUpdateTaskTool,
  TrackerGetTaskTool,
  TrackerListTasksTool,
  TrackerAddDependencyTool,
  TrackerVisualizeTool,
} from '../tools/trackerTools.js';
import {
  logRipgrepFallback,
  logFlashFallback,
  logApprovalModeSwitch,
  logApprovalModeDuration,
} from '../telemetry/loggers.js';
import {
  RipgrepFallbackEvent,
  FlashFallbackEvent,
  ApprovalModeSwitchEvent,
  ApprovalModeDurationEvent,
} from '../telemetry/types.js';
import type {
  FallbackModelHandler,
  ValidationHandler,
} from '../fallback/types.js';
import { ModelAvailabilityService } from '../availability/modelAvailabilityService.js';
import { ModelRouterService } from '../routing/modelRouterService.js';
import { OutputFormat } from '../output/types.js';
import {
  ModelConfigService,
  type ModelConfig,
  type ModelConfigServiceConfig,
} from '../services/modelConfigService.js';
import { DEFAULT_MODEL_CONFIGS } from './defaultModelConfigs.js';
import { MemoryContextManager } from '../context/memoryContextManager.js';
import { TrackerService } from '../services/trackerService.js';
import type { GenerateContentParameters } from '@google/genai';

// Re-export OAuth config type
export type { MCPOAuthConfig, AnyToolInvocation, AnyDeclarativeTool };
import type { AnyToolInvocation, AnyDeclarativeTool } from '../tools/tools.js';
import { WorkspaceContext } from '../utils/workspaceContext.js';
import {
  getWorkspaceContextOverride,
  hasScopedAutoMemoryExtractionWriteAccess,
  hasScopedMemoryInboxAccess,
} from './scoped-config.js';
import { Storage } from './storage.js';
import type { ShellExecutionConfig } from '../services/shellExecutionService.js';
import { FileExclusions } from '../utils/ignorePatterns.js';
import { MessageBus } from '../confirmation-bus/message-bus.js';
import type { EventEmitter } from 'node:events';
import { PolicyEngine } from '../policy/policy-engine.js';
import {
  ApprovalMode,
  type PolicyEngineConfig,
  type PolicyRule,
  type SafetyCheckerRule,
} from '../policy/types.js';
import { HookSystem } from '../hooks/index.js';
import type {
  UserTierId,
  GeminiUserTier,
  RetrieveUserQuotaResponse,
  AdminControlsSettings,
} from '../code_assist/types.js';
import type { HierarchicalMemory } from './memory.js';
import { getCodeAssistServer } from '../code_assist/codeAssist.js';
import {
  getExperiments,
  type Experiments,
} from '../code_assist/experiments/experiments.js';
import { AgentRegistry } from '../agents/registry.js';
import { AcknowledgedAgentsService } from '../agents/acknowledgedAgents.js';
import { setGlobalProxy, updateGlobalFetchTimeouts } from '../utils/fetch.js';
import { ExperimentFlags } from '../code_assist/experiments/flagNames.js';
import { debugLogger } from '../utils/debugLogger.js';
import { SkillManager, type SkillDefinition } from '../skills/skillManager.js';
import { startupProfiler } from '../telemetry/startupProfiler.js';
import type { AgentDefinition } from '../agents/types.js';
import { fetchAdminControls } from '../code_assist/admin/admin_controls.js';
import { isSubpath, resolveToRealPath } from '../utils/paths.js';
import { InjectionService } from './injectionService.js';
import { ExecutionLifecycleService } from '../services/executionLifecycleService.js';
import { WORKSPACE_POLICY_TIER } from '../policy/config.js';
import { loadPoliciesFromToml } from '../policy/toml-loader.js';

import { CheckerRunner } from '../safety/checker-runner.js';
import { ContextBuilder } from '../safety/context-builder.js';
import { CheckerRegistry } from '../safety/registry.js';
import { ConsecaSafetyChecker } from '../safety/conseca/conseca.js';
import type { AgentLoopContext } from './agent-loop-context.js';

export interface AccessibilitySettings {
  /** @deprecated Use ui.statusHints instead. */
  enableLoadingPhrases?: boolean;
  screenReader?: boolean;
}

export interface BugCommandSettings {
  urlTemplate: string;
}

export interface SummarizeToolOutputSettings {
  tokenBudget?: number;
}

export interface PlanSettings {
  enabled?: boolean;
  directory?: string;
  modelRouting?: boolean;
}

export interface TelemetrySettings {
  enabled?: boolean;
  traces?: boolean;
  target?: TelemetryTarget;
  otlpEndpoint?: string;
  otlpProtocol?: 'grpc' | 'http';
  logPrompts?: boolean;
  outfile?: string;
  useCollector?: boolean;
  useCliAuth?: boolean;
}

export interface OutputSettings {
  format?: OutputFormat;
}

export interface GemmaModelRouterSettings {
  enabled?: boolean;
  autoStartServer?: boolean;
  binaryPath?: string;
  classifier?: {
    host?: string;
    model?: string;
  };
}

export interface ADKSettings {
  agentSessionNoninteractiveEnabled?: boolean;
  agentSessionInteractiveEnabled?: boolean;
}

export interface ExtensionSetting {
  name: string;
  description: string;
  envVar: string;
  sensitive?: boolean;
}

export interface ResolvedExtensionSetting {
  name: string;
  envVar: string;
  value?: string;
  sensitive: boolean;
  scope?: 'user' | 'workspace';
  source?: string;
}

export interface TrajectoryProvider {
  /** Prefix used to identify sessions from this provider (e.g., 'ext:') */
  prefix: string;
  /** Optional display name for UI Tabs */
  displayName?: string;
  /** Return an array of conversational tags/ids */
  listSessions(workspaceUri?: string): Promise<
    Array<{
      id: string;
      mtime: string;
      name?: string;
      displayName?: string;
      messageCount?: number;
    }>
  >;
  /** Load a single conversation payload */
  loadSession(id: string): Promise<ConversationRecord | null>;
}

export interface AgentRunConfig {
  maxTimeMinutes?: number;
  maxTurns?: number;
}

/**
 * Override configuration for a specific agent.
 * Generic fields (modelConfig, runConfig, enabled) are standard across all agents.
 */
export interface AgentOverride {
  modelConfig?: ModelConfig;
  runConfig?: AgentRunConfig;
  enabled?: boolean;
  tools?: string[];
  mcpServers?: Record<string, MCPServerConfig>;
}

export interface AgentSettings {
  overrides?: Record<string, AgentOverride>;
  browser?: BrowserAgentCustomConfig;
}

export interface CustomTheme {
  type: 'custom';
  name: string;

  text?: {
    primary?: string;
    secondary?: string;
    link?: string;
    accent?: string;
    response?: string;
  };
  background?: {
    primary?: string;
    diff?: {
      added?: string;
      removed?: string;
    };
  };
  border?: {
    default?: string;
  };
  ui?: {
    comment?: string;
    symbol?: string;
    active?: string;
    focus?: string;
    gradient?: string[];
  };
  status?: {
    error?: string;
    success?: string;
    warning?: string;
  };

  // Legacy properties (all optional)
  Background?: string;
  Foreground?: string;
  LightBlue?: string;
  AccentBlue?: string;
  AccentPurple?: string;
  AccentCyan?: string;
  AccentGreen?: string;
  AccentYellow?: string;
  AccentRed?: string;
  DiffAdded?: string;
  DiffRemoved?: string;
  Comment?: string;
  Gray?: string;
  DarkGray?: string;
  GradientColors?: string[];
}

/**
 * Browser agent custom configuration.
 * Used in agents.browser
 *
 * IMPORTANT: Keep in sync with the browser settings schema in
 * packages/cli/src/config/settingsSchema.ts (agents.browser.properties).
 */
export interface BrowserAgentCustomConfig {
  /**
   * Session mode:
   * - 'persistent': Launch Chrome with a persistent profile at ~/.cache/chrome-devtools-mcp/ (default)
   * - 'isolated': Launch Chrome with a temporary profile, cleaned up after session
   * - 'existing': Attach to an already-running Chrome instance (requires remote debugging
   *   enabled at chrome://inspect/#remote-debugging)
   */
  sessionMode?: 'isolated' | 'persistent' | 'existing';
  /** Run browser in headless mode. Default: false */
  headless?: boolean;
  /** Path to Chrome profile directory for session persistence. */
  profilePath?: string;
  /** Model for the visual agent's analyze_screenshot tool. When set, enables the tool. */
  visualModel?: string;
  /** List of allowed domains for the browser agent (e.g., ["github.com", "*.google.com"]). */
  allowedDomains?: string[];
  /** Disable user input on the browser window during automation. Default: true in non-headless mode */
  disableUserInput?: boolean;
  /** Maximum number of actions (tool calls) allowed per task. Default: 100 */
  maxActionsPerTask?: number;
  /** Whether to confirm sensitive actions (e.g., fill_form, evaluate_script). */
  confirmSensitiveActions?: boolean;
  /** Whether to block file uploads. */
  blockFileUploads?: boolean;
}

/**
 * All information required in CLI to handle an extension. Defined in Core so
 * that the collection of loaded, active, and inactive extensions can be passed
 * around on the config object though Core does not use this information
 * directly.
 */
export interface GeminiCLIExtension {
  name: string;
  version: string;
  isActive: boolean;
  path: string;
  installMetadata?: ExtensionInstallMetadata;
  mcpServers?: Record<string, MCPServerConfig>;
  contextFiles: string[];
  excludeTools?: string[];
  id: string;
  hooks?: { [K in HookEventName]?: HookDefinition[] };
  settings?: ExtensionSetting[];
  resolvedSettings?: ResolvedExtensionSetting[];
  skills?: SkillDefinition[];
  agents?: AgentDefinition[];
  /**
   * Custom themes contributed by this extension.
   * These themes will be registered when the extension is activated.
   */
  themes?: CustomTheme[];
  /**
   * Policy rules contributed by this extension.
   */
  rules?: PolicyRule[];
  /**
   * Safety checkers contributed by this extension.
   */
  checkers?: SafetyCheckerRule[];
  /**
   * Planning features configuration contributed by this extension.
   */
  plan?: {
    /**
     * The directory where planning artifacts are stored.
     */
    directory?: string;
  };
  /**
   * Used to migrate an extension to a new repository source.
   */
  migratedTo?: string;
  /** Loaded JS module for trajectory decoding */
  trajectoryProviderModule?: TrajectoryProvider;
}

export interface ExtensionInstallMetadata {
  source: string;
  type: 'git' | 'local' | 'link' | 'github-release';
  releaseTag?: string; // Only present for github-release installs.
  ref?: string;
  autoUpdate?: boolean;
  allowPreRelease?: boolean;
}

import { DEFAULT_MAX_ATTEMPTS } from '../utils/retry.js';
import {
  DEFAULT_FILE_FILTERING_OPTIONS,
  DEFAULT_MEMORY_FILE_FILTERING_OPTIONS,
  type FileFilteringOptions,
} from './constants.js';
import {
  DEFAULT_TOOL_PROTECTION_THRESHOLD,
  DEFAULT_MIN_PRUNABLE_TOKENS_THRESHOLD,
  DEFAULT_PROTECT_LATEST_TURN,
} from '../context/toolOutputMaskingService.js';
// --- LOCAL FORK ADDITION (Phase 2.0) ---
import {
  getLocalMaskingDefaults,
  DEFAULT_LOCAL_MASKING_PROTECTION_FRACTION,
  DEFAULT_LOCAL_MASKING_PRUNABLE_FRACTION,
} from '../context/localMaskingDefaults.js';
// --- LOCAL FORK ADDITION (Phase 2.0) ---
import {
  getEffectiveCompressionThreshold as adaptiveGetEffectiveCompressionThreshold,
  recordCompressionResult as adaptiveRecordCompressionResult,
  DEFAULT_ADAPTIVE_COOLDOWN_TURNS,
  ADAPTIVE_THRESHOLD_FLOOR,
} from '../context/adaptiveThreshold.js';

import {
  type ExtensionLoader,
  SimpleExtensionLoader,
} from '../utils/extensionLoader.js';
import { McpClientManager } from '../tools/mcp-client-manager.js';
import { A2AClientManager } from '../agents/a2a-client-manager.js';
import { type McpContext } from '../tools/mcp-client.js';
import type { EnvironmentSanitizationConfig } from '../services/environmentSanitization.js';

export type { FileFilteringOptions };
export {
  DEFAULT_FILE_FILTERING_OPTIONS,
  DEFAULT_MEMORY_FILE_FILTERING_OPTIONS,
};

export const DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD = 40_000;

/**
 * Default compression trigger threshold (fraction of context limit) for local
 * mode. Lower than the cloud default (0.5) because local context windows are
 * typically much smaller and benefit from earlier compression.
 */
export const DEFAULT_LOCAL_COMPRESSION_THRESHOLD = 0.4;

/**
 * Default fraction of recent history to preserve raw (uncompressed) after a
 * compression pass in local mode. Lower than the cloud default (0.3) so more
 * of the history is summarized.
 */
export const DEFAULT_LOCAL_PRESERVE_FRACTION = 0.2;

// --- LOCAL FORK ADDITION (Phase 2.0) ---
/**
 * Default reservation of tokens for the model's response when computing the
 * pre-turn budget. Conservative enough that medium replies fit comfortably.
 */
export const DEFAULT_LOCAL_PRE_TURN_RESERVED_RESPONSE_TOKENS = 4_096;

/**
 * Default fraction of localContextLimit at which the pre-turn budget check
 * triggers a proactive compression. 0.80 leaves 20% headroom for tool calls
 * and unexpected response growth on top of the reserved response budget.
 */
export const DEFAULT_LOCAL_PRE_TURN_PROACTIVE_COMPRESS_AT = 0.8;

/**
 * Default minimum age (turns) before a write_file call becomes eligible for
 * content ejection. 1 = "anything older than the latest turn".
 */
export const DEFAULT_LOCAL_WRITE_FILE_EJECTION_MIN_AGE_TURNS = 1;

/**
 * Default minimum estimated token count for a single write_file content
 * payload before ejection bothers acting. Avoids touching tiny writes where
 * the savings would be negligible.
 */
export const DEFAULT_LOCAL_WRITE_FILE_EJECTION_MIN_TOKENS_PER_CALL = 200;

export class MCPServerConfig {
  constructor(
    // For stdio transport
    readonly command?: string,
    readonly args?: string[],
    readonly env?: Record<string, string>,
    readonly cwd?: string,
    // For sse transport
    readonly url?: string,
    // For streamable http transport
    readonly httpUrl?: string,
    readonly headers?: Record<string, string>,
    // For websocket transport
    readonly tcp?: string,
    // Transport type (optional, for use with 'url' field)
    // When set to 'http', uses StreamableHTTPClientTransport
    // When set to 'sse', uses SSEClientTransport
    // When omitted, auto-detects transport type
    // Note: 'httpUrl' is deprecated in favor of 'url' + 'type'
    readonly type?: 'sse' | 'http',
    // Common
    readonly timeout?: number,
    readonly trust?: boolean,
    // Metadata
    readonly description?: string,
    readonly includeTools?: string[],
    readonly excludeTools?: string[],
    readonly extension?: GeminiCLIExtension,
    // OAuth configuration
    readonly oauth?: MCPOAuthConfig,
    readonly authProviderType?: AuthProviderType,
    // Service Account Configuration
    /* targetAudience format: CLIENT_ID.apps.googleusercontent.com */
    readonly targetAudience?: string,
    /* targetServiceAccount format: <service-account-name>@<project-num>.iam.gserviceaccount.com */
    readonly targetServiceAccount?: string,
  ) {}
}

export enum AuthProviderType {
  DYNAMIC_DISCOVERY = 'dynamic_discovery',
  GOOGLE_CREDENTIALS = 'google_credentials',
  SERVICE_ACCOUNT_IMPERSONATION = 'service_account_impersonation',
}

export interface SandboxConfig {
  enabled: boolean;
  allowedPaths?: string[];
  includeDirectories?: string[];
  networkAccess?: boolean;
  command?:
    | 'docker'
    | 'podman'
    | 'sandbox-exec'
    | 'runsc'
    | 'lxc'
    | 'windows-native';
  image?: string;
}

export const ConfigSchema = z.object({
  sandbox: z
    .object({
      enabled: z.boolean().default(false),
      allowedPaths: z.array(z.string()).default([]),
      includeDirectories: z.array(z.string()).default([]),
      networkAccess: z.boolean().default(false),
      command: z
        .enum([
          'docker',
          'podman',
          'sandbox-exec',
          'runsc',
          'lxc',
          'windows-native',
        ])
        .optional(),
      image: z.string().optional(),
    })
    .superRefine((data, ctx) => {
      if (data.enabled && !data.command) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Sandbox command is required when sandbox is enabled',
          path: ['command'],
        });
      }
    })
    .optional(),
});

/**
 * Callbacks for checking MCP server enablement status.
 * These callbacks are provided by the CLI package to bridge
 * the enablement state to the core package.
 */
export interface McpEnablementCallbacks {
  /** Check if a server is disabled for the current session only */
  isSessionDisabled: (serverId: string) => boolean;
  /** Check if a server is enabled in the file-based configuration */
  isFileEnabled: (serverId: string) => Promise<boolean>;
}

export interface PolicyUpdateConfirmationRequest {
  scope: string;
  identifier: string;
  policyDir: string;
  newHash: string;
}

export interface WorktreeSettings {
  name: string;
  path: string;
  baseSha: string;
}

export interface ConfigParameters {
  sessionId: string;
  clientName?: string;
  clientVersion?: string;
  embeddingModel?: string;
  sandbox?: SandboxConfig;
  toolSandboxing?: boolean;
  targetDir: string;
  debugMode: boolean;
  question?: string;

  coreTools?: string[];
  mainAgentTools?: string[];
  /** @deprecated Use Policy Engine instead */
  allowedTools?: string[];
  /** @deprecated Use Policy Engine instead */
  excludeTools?: string[];
  toolDiscoveryCommand?: string;
  toolCallCommand?: string;
  mcpServerCommand?: string;
  mcpServers?: Record<string, MCPServerConfig>;
  mcpEnablementCallbacks?: McpEnablementCallbacks;
  userMemory?: string | HierarchicalMemory;
  geminiMdFileCount?: number;
  geminiMdFilePaths?: string[];
  approvalMode?: ApprovalMode;
  showMemoryUsage?: boolean;
  contextFileName?: string | string[];
  accessibility?: AccessibilitySettings;
  telemetry?: TelemetrySettings;
  usageStatisticsEnabled?: boolean;
  fileFiltering?: {
    respectGitIgnore?: boolean;
    respectGeminiIgnore?: boolean;
    enableFileWatcher?: boolean;
    enableRecursiveFileSearch?: boolean;
    enableFuzzySearch?: boolean;
    maxFileCount?: number;
    searchTimeout?: number;
    customIgnoreFilePaths?: string[];
  };
  checkpointing?: boolean;
  proxy?: string;
  cwd: string;
  fileDiscoveryService?: FileDiscoveryService;
  includeDirectories?: string[];
  bugCommand?: BugCommandSettings;
  model: string;
  disableLoopDetection?: boolean;
  maxSessionTurns?: number;
  acpMode?: boolean;
  listSessions?: boolean;
  deleteSession?: string;
  listExtensions?: boolean;
  extensionLoader?: ExtensionLoader;
  enabledExtensions?: string[];
  enableExtensionReloading?: boolean;
  allowedMcpServers?: string[];
  blockedMcpServers?: string[];
  allowedEnvironmentVariables?: string[];
  blockedEnvironmentVariables?: string[];
  enableEnvironmentVariableRedaction?: boolean;
  noBrowser?: boolean;
  summarizeToolOutput?: Record<string, SummarizeToolOutputSettings>;
  folderTrust?: boolean;
  ideMode?: boolean;
  loadMemoryFromIncludeDirectories?: boolean;
  includeDirectoryTree?: boolean;
  importFormat?: 'tree' | 'flat';
  discoveryMaxDirs?: number;
  compressionThreshold?: number;
  interactive?: boolean;
  trustedFolder?: boolean;
  useBackgroundColor?: boolean;
  useAlternateBuffer?: boolean;
  useTerminalBuffer?: boolean;
  useRenderProcess?: boolean;
  useRipgrep?: boolean;
  enableInteractiveShell?: boolean;
  shellBackgroundCompletionBehavior?: string;
  skipNextSpeakerCheck?: boolean;
  shellExecutionConfig?: ShellExecutionConfig;
  extensionManagement?: boolean;
  extensionRegistryURI?: string;
  truncateToolOutputThreshold?: number;
  eventEmitter?: EventEmitter;
  useWriteTodos?: boolean;
  workspacePoliciesDir?: string;
  policyEngineConfig?: PolicyEngineConfig;
  directWebFetch?: boolean;
  policyUpdateConfirmationRequest?: PolicyUpdateConfirmationRequest;
  output?: OutputSettings;
  gemmaModelRouter?: GemmaModelRouterSettings;
  adk?: ADKSettings;
  disableModelRouterForAuth?: AuthType[];
  retryFetchErrors?: boolean;
  maxAttempts?: number;
  enableShellOutputEfficiency?: boolean;
  shellToolInactivityTimeout?: number;
  fakeResponses?: string;
  recordResponses?: string;
  ptyInfo?: string;
  disableYoloMode?: boolean;
  disableAlwaysAllow?: boolean;
  voiceMode?: boolean;
  rawOutput?: boolean;
  acceptRawOutputRisk?: boolean;
  dynamicModelConfiguration?: boolean;
  modelConfigServiceConfig?: ModelConfigServiceConfig;
  enableHooks?: boolean;
  enableHooksUI?: boolean;
  experiments?: Experiments;
  contextManagement?: Partial<ContextManagementConfig>;
  hooks?: { [K in HookEventName]?: HookDefinition[] };
  disabledHooks?: string[];
  projectHooks?: { [K in HookEventName]?: HookDefinition[] };
  enableAgents?: boolean;
  enableEventDrivenScheduler?: boolean;
  skillsSupport?: boolean;
  disabledSkills?: string[];
  adminSkillsEnabled?: boolean;
  experimentalJitContext?: boolean;
  autoDistillation?: boolean;
  experimentalMemoryV2?: boolean;
  experimentalAutoMemory?: boolean;
  experimentalGemma?: boolean;
  experimentalContextManagementConfig?: string;
  experimentalAgentHistoryTruncation?: boolean;
  experimentalAgentHistoryTruncationThreshold?: number;
  experimentalAgentHistoryRetainedMessages?: number;
  experimentalAgentHistorySummarization?: boolean;
  memoryBoundaryMarkers?: string[];
  topicUpdateNarration?: boolean;

  disableLLMCorrection?: boolean;
  plan?: boolean;
  tracker?: boolean;
  planSettings?: PlanSettings;
  worktreeSettings?: WorktreeSettings;
  modelSteering?: boolean;
  onModelChange?: (model: string) => void;
  mcpEnabled?: boolean;
  extensionsEnabled?: boolean;
  agents?: AgentSettings;
  onReload?: () => Promise<{
    disabledSkills?: string[];
    adminSkillsEnabled?: boolean;
    agents?: AgentSettings;
  }>;
  enableConseca?: boolean;
  localUrl?: string;
  localModel?: string;
  localTimeout?: number;
  localEnableTools?: boolean;
  localPromptMode?: string;
  // --- LOCAL FORK ADDITION (Phase 2.0.12) ---
  localToolCallParseMode?: string;
  // --- END LOCAL FORK ADDITION ---
  // --- LOCAL FORK ADDITION (Phase 2.0.13) ---
  localTemperature?: number;
  // --- END LOCAL FORK ADDITION ---
  // --- LOCAL FORK ADDITION (Phase 2.0.14) ---
  localTopP?: number;
  localTopK?: number;
  localMinP?: number;
  localRepetitionPenalty?: number;
  // --- END LOCAL FORK ADDITION ---
  // --- LOCAL FORK ADDITION (Phase 2.1) ---
  // Hosted-provider configuration. `providersActive` is the id of the
  // currently selected provider (e.g. 'openai'); `providersConfig` is the
  // user-supplied per-provider overrides keyed by id. Both are optional —
  // when omitted, provider mode falls back to registry defaults.
  // API keys are NEVER passed through here; they live only in the keychain
  // (or the per-provider env var). See providerCredentialStorage.ts.
  providersActive?: string;
  providersConfig?: Record<string, ProviderInstanceConfig>;
  // Phase 2.3: user-defined custom OpenAI-compat providers, keyed by id.
  // Loaded from `settings.providers.custom.*`. Merged with the four
  // built-ins by `effectiveRegistry()` at request time. Built-ins always
  // win on id collision so a user cannot shadow `openai` or `gemini-*`.
  providersCustom?: Record<string, CustomProviderDefinition>;
  // --- END LOCAL FORK ADDITION ---
  localContextLimit?: number;
  localCompressionThreshold?: number;
  localPreserveFraction?: number;
  localAutoTruncateOnOverflow?: boolean;
  // --- LOCAL FORK ADDITION (Phase 2.0) ---
  localAdaptiveCompressionEnabled?: boolean;
  localAdaptiveCompressionCooldownTurns?: number;
  localAdaptiveCompressionFloor?: number;
  localWriteFileEjectionEnabled?: boolean;
  localWriteFileEjectionMinAgeTurns?: number;
  localWriteFileEjectionMinTokensPerCall?: number;
  localPreTurnBudgetEnabled?: boolean;
  localPreTurnBudgetReservedResponseTokens?: number;
  localPreTurnBudgetProactiveCompressAt?: number;
  localToolOutputMaskingEnabled?: boolean;
  localToolOutputMaskingProtectionFraction?: number;
  localToolOutputMaskingPrunableFraction?: number;
  localToolOutputMaskingProtectLatestTurn?: boolean;
  billing?: {
    overageStrategy?: OverageStrategy;
  };
  vertexAiRouting?: VertexAiRoutingConfig;
}

export class Config implements McpContext, AgentLoopContext {
  private _toolRegistry!: ToolRegistry;
  private mcpClientManager?: McpClientManager;
  private readonly a2aClientManager?: A2AClientManager;
  private allowedMcpServers: string[];
  private blockedMcpServers: string[];
  private allowedEnvironmentVariables: string[];
  private blockedEnvironmentVariables: string[];
  private readonly enableEnvironmentVariableRedaction: boolean;
  private _promptRegistry!: PromptRegistry;
  private _resourceRegistry!: ResourceRegistry;
  private agentRegistry!: AgentRegistry;
  private readonly acknowledgedAgentsService: AcknowledgedAgentsService;
  private skillManager!: SkillManager;
  private _sessionId: string;
  private readonly clientName: string | undefined;
  private clientVersion: string;
  private fileSystemService: FileSystemService;
  private trackerService?: TrackerService;
  readonly topicState = new TopicState();
  private contentGeneratorConfig!: ContentGeneratorConfig;
  private contentGenerator!: ContentGenerator;
  readonly modelConfigService: ModelConfigService;
  private readonly embeddingModel: string;
  private readonly sandbox: SandboxConfig | undefined;
  private _sandboxForbiddenPaths: string[] | undefined;
  private readonly targetDir: string;
  private workspaceContext: WorkspaceContext;
  private readonly debugMode: boolean;
  private readonly question: string | undefined;
  private readonly worktreeSettings: WorktreeSettings | undefined;
  readonly enableConseca: boolean;

  private readonly coreTools: string[] | undefined;
  private readonly mainAgentTools: string[] | undefined;
  /** @deprecated Use Policy Engine instead */
  private readonly allowedTools: string[] | undefined;
  /** @deprecated Use Policy Engine instead */
  private readonly excludeTools: string[] | undefined;
  private readonly toolDiscoveryCommand: string | undefined;
  private readonly toolCallCommand: string | undefined;
  private readonly mcpServerCommand: string | undefined;
  private readonly mcpEnabled: boolean;
  private readonly extensionsEnabled: boolean;
  private mcpServers: Record<string, MCPServerConfig> | undefined;
  private readonly mcpEnablementCallbacks?: McpEnablementCallbacks;
  private userMemory: string | HierarchicalMemory;
  private geminiMdFileCount: number;
  private geminiMdFilePaths: string[];
  private readonly showMemoryUsage: boolean;
  private readonly accessibility: AccessibilitySettings;
  private readonly telemetrySettings: TelemetrySettings;
  private readonly usageStatisticsEnabled: boolean;
  private _geminiClient!: GeminiClient;
  private _sandboxManager: SandboxManager;
  private readonly _sandboxPolicyManager: SandboxPolicyManager;
  private baseLlmClient!: BaseLlmClient;
  private localLiteRtLmClient?: LocalLiteRtLmClient;
  private modelRouterService: ModelRouterService;
  private readonly modelAvailabilityService: ModelAvailabilityService;
  private readonly fileFiltering: {
    respectGitIgnore: boolean;
    respectGeminiIgnore: boolean;
    enableFileWatcher: boolean;
    enableRecursiveFileSearch: boolean;
    enableFuzzySearch: boolean;
    maxFileCount: number;
    searchTimeout: number;
    customIgnoreFilePaths: string[];
  };
  private fileDiscoveryService: FileDiscoveryService | null = null;
  private gitService: GitService | undefined = undefined;
  private readonly checkpointing: boolean;
  private readonly proxy: string | undefined;
  private readonly cwd: string;
  private readonly bugCommand: BugCommandSettings | undefined;
  private model: string;
  // --- LOCAL FORK ADDITION (Phase 2.0.2) ---
  // These fields are intentionally NOT readonly so refreshLocalConfig() can
  // hot-reload them without requiring a CLI restart. The other local.*
  // fields below stay readonly because they're either rarely changed or
  // would require resetting more than the ContentGenerator (e.g. the
  // chat-compression service caches localContextLimit).
  private localUrl: string | undefined;
  private localModel: string | undefined;
  private localTimeout: number;
  private readonly localEnableTools: boolean;
  private localPromptMode: string;
  // --- END LOCAL FORK ADDITION ---
  // --- LOCAL FORK ADDITION (Phase 2.0.12) ---
  // Tool-call parser hardening mode. Mutable so refreshLocalConfig() can
  // hot-swap it via /local toolcall <mode>. The parser reads it on every
  // response so updates are live on the next turn — no restart needed.
  private localToolCallParseMode: 'strict' | 'lenient' | 'loose';
  // --- END LOCAL FORK ADDITION ---
  // --- LOCAL FORK ADDITION (Phase 2.0.13) ---
  // Sampling temperature forwarded to the local LLM on every request.
  // null means "let the server decide" (vLLM defers to the model's
  // generation_config.json, which is typically temp=1.0 for Qwen3 — too high
  // for coding/tool-use).  Configured via local.temperature in settings.json
  // or GEMINI_LOCAL_TEMPERATURE env var.
  private localTemperature: number | null;
  // --- END LOCAL FORK ADDITION ---
  // --- LOCAL FORK ADDITION (Phase 2.0.14) ---
  // Additional sampler controls forwarded to the local LLM on every request.
  // null means "let the server decide" (vLLM defaults). All four are mutable so
  // refreshLocalConfig() can hot-swap them via /local topp|topk|minp|reppen.
  // Required for GLM-4.7-Flash, whose looping behavior is suppressed by Z.ai's
  // recommended sampler shape (top_p=1.0, min_p=0.01, repetition_penalty=1.0).
  // See https://unsloth.ai/docs/models/glm-4.7-flash for details.
  private localTopP: number | null;
  private localTopK: number | null;
  private localMinP: number | null;
  private localRepetitionPenalty: number | null;
  // --- END LOCAL FORK ADDITION ---
  // --- LOCAL FORK ADDITION (Phase 2.1) ---
  // Hosted-provider state. Mutable so refreshProviderConfig() can hot-swap
  // active provider, model, baseUrl, etc. without restarting the CLI.
  // `providersActive` selects which entry in `providersConfig` is live;
  // after Phase 2.1.1 it also covers local presets (local-vllm, etc.) so
  // there's no separate AuthType.PROVIDER — everything routes through
  // AuthType.LOCAL via Config.getEffectiveProviderConfig() for OpenAI-compat
  // wire formats; Gemini wire-format providers map to their respective
  // upstream AuthType (LOGIN_WITH_GOOGLE / USE_GEMINI / USE_VERTEX_AI).
  private providersActive: string | undefined;
  private providersConfig: Record<string, ProviderInstanceConfig>;
  // Phase 2.3: in-memory copy of `settings.providers.custom.*`.
  // Mutators (`addCustomProvider` / `removeCustomProvider`) update this
  // map AND request a settings.json write through the slash command /
  // dialog (Config itself never writes user-scope settings; that's the
  // settings layer's job). `getEffectiveProviderConfig()` and
  // `getProviderRegistry()` consult this map on every call.
  private providersCustom: Record<string, CustomProviderDefinition>;
  // --- END LOCAL FORK ADDITION ---
  private readonly localContextLimit: number | undefined;
  private readonly localCompressionThreshold: number | undefined;
  private readonly localPreserveFraction: number | undefined;
  private readonly localAutoTruncateOnOverflow: boolean;
  // --- LOCAL FORK ADDITION (Phase 2.0) ---
  private readonly localAdaptiveCompressionEnabled: boolean;
  private readonly localAdaptiveCompressionCooldownTurns: number;
  private readonly localAdaptiveCompressionFloor: number;
  private readonly localWriteFileEjectionEnabled: boolean;
  private readonly localWriteFileEjectionMinAgeTurns: number;
  private readonly localWriteFileEjectionMinTokensPerCall: number;
  private readonly localPreTurnBudgetEnabled: boolean;
  private readonly localPreTurnBudgetReservedResponseTokens: number;
  private readonly localPreTurnBudgetProactiveCompressAt: number;
  private readonly localToolOutputMaskingEnabled: boolean;
  private readonly localToolOutputMaskingProtectionFraction: number;
  private readonly localToolOutputMaskingPrunableFraction: number;
  private readonly localToolOutputMaskingProtectLatestTurn: boolean;
  private discoveredLocalModels: LocalModelInfo[] = [];
  private generatorSwapPromise: Promise<void> | null = null;
  private localModelOverride: string | undefined;
  private readonly disableLoopDetection: boolean;
  // null = unknown (quota not fetched); true = has access; false = definitively no access
  private hasAccessToPreviewModel: boolean | null = null;
  private readonly noBrowser: boolean;
  private readonly folderTrust: boolean;
  private ideMode: boolean;

  private _activeModel: string;
  private readonly maxSessionTurns: number;
  private readonly listSessions: boolean;
  private readonly deleteSession: string | undefined;
  private readonly listExtensions: boolean;
  private readonly _extensionLoader: ExtensionLoader;
  private readonly _enabledExtensions: string[];
  private readonly enableExtensionReloading: boolean;
  fallbackModelHandler?: FallbackModelHandler;
  validationHandler?: ValidationHandler;
  private quotaErrorOccurred: boolean = false;
  private creditsNotificationShown: boolean = false;
  private modelQuotas: Map<
    string,
    { remaining: number; limit: number; resetTime?: string }
  > = new Map();
  private lastRetrievedQuota?: RetrieveUserQuotaResponse;
  private lastQuotaFetchTime = 0;
  private lastEmittedQuotaRemaining: number | undefined;
  private lastEmittedQuotaLimit: number | undefined;

  private emitQuotaChangedEvent(): void {
    const remaining = this.getQuotaRemaining();
    const limit = this.getQuotaLimit();
    const resetTime = this.getQuotaResetTime();
    if (
      this.lastEmittedQuotaRemaining !== remaining ||
      this.lastEmittedQuotaLimit !== limit
    ) {
      this.lastEmittedQuotaRemaining = remaining;
      this.lastEmittedQuotaLimit = limit;
      coreEvents.emitQuotaChanged(remaining, limit, resetTime);
    }
  }

  private readonly summarizeToolOutput:
    | Record<string, SummarizeToolOutputSettings>
    | undefined;
  private readonly acpMode: boolean = false;
  private readonly loadMemoryFromIncludeDirectories: boolean = false;
  private readonly includeDirectoryTree: boolean = true;
  private readonly importFormat: 'tree' | 'flat';
  private readonly discoveryMaxDirs: number;
  private readonly compressionThreshold: number | undefined;
  /** Public for testing only */
  readonly interactive: boolean;
  private readonly ptyInfo: string;
  private readonly trustedFolder: boolean | undefined;
  private readonly directWebFetch: boolean;
  private readonly useRipgrep: boolean;
  private readonly enableInteractiveShell: boolean;
  private readonly shellBackgroundCompletionBehavior:
    | 'inject'
    | 'notify'
    | 'silent';
  private readonly skipNextSpeakerCheck: boolean;
  private readonly useBackgroundColor: boolean;
  private readonly useAlternateBuffer: boolean;
  private readonly useTerminalBuffer: boolean;
  private readonly useRenderProcess: boolean;
  private shellExecutionConfig: ShellExecutionConfig;
  private readonly extensionManagement: boolean = true;
  private readonly extensionRegistryURI: string | undefined;
  private readonly truncateToolOutputThreshold: number;
  private compressionTruncationCounter = 0;
  private initialized = false;
  private initPromise: Promise<void> | undefined;
  private mcpInitializationPromise: Promise<void> | null = null;
  readonly storage: Storage;
  private readonly fileExclusions: FileExclusions;
  private readonly eventEmitter?: EventEmitter;
  private readonly useWriteTodos: boolean;
  private readonly workspacePoliciesDir: string | undefined;
  private readonly _messageBus: MessageBus;
  private readonly policyEngine: PolicyEngine;
  private policyUpdateConfirmationRequest:
    | PolicyUpdateConfirmationRequest
    | undefined;
  private readonly outputSettings: OutputSettings;

  private readonly gemmaModelRouter: GemmaModelRouterSettings;
  private readonly agentSessionNoninteractiveEnabled: boolean;
  private readonly agentSessionInteractiveEnabled: boolean;

  private readonly retryFetchErrors: boolean;
  private readonly maxAttempts: number;
  private readonly enableShellOutputEfficiency: boolean;
  private readonly shellToolInactivityTimeout: number;
  readonly fakeResponses?: string;
  readonly recordResponses?: string;
  private readonly disableYoloMode: boolean;
  private readonly disableAlwaysAllow: boolean;
  private readonly rawOutput: boolean;
  private readonly acceptRawOutputRisk: boolean;
  private readonly dynamicModelConfiguration: boolean;
  private pendingIncludeDirectories: string[];
  private readonly enableHooksUI: boolean;
  private readonly enableHooks: boolean;

  private hooks: { [K in HookEventName]?: HookDefinition[] } | undefined;
  private projectHooks:
    | ({ [K in HookEventName]?: HookDefinition[] } & { disabled?: string[] })
    | undefined;
  private disabledHooks: string[];
  private experiments: Experiments | undefined;
  private experimentsPromise: Promise<Experiments | undefined> | undefined;
  private hookSystem?: HookSystem;
  private readonly onModelChange: ((model: string) => void) | undefined;
  private readonly onReload:
    | (() => Promise<{
        disabledSkills?: string[];
        adminSkillsEnabled?: boolean;
        agents?: AgentSettings;
      }>)
    | undefined;

  private readonly billing: {
    overageStrategy: OverageStrategy;
  };
  private readonly vertexAiRouting: VertexAiRoutingConfig | undefined;

  private readonly enableAgents: boolean;
  private agents: AgentSettings;
  private readonly enableEventDrivenScheduler: boolean;
  private readonly skillsSupport: boolean;
  private disabledSkills: string[];
  private readonly adminSkillsEnabled: boolean;
  private readonly experimentalJitContext: boolean;
  private readonly experimentalMemoryV2: boolean;
  private readonly experimentalAutoMemory: boolean;
  private readonly experimentalGemma: boolean;
  private readonly experimentalContextManagementConfig?: string;
  private readonly memoryBoundaryMarkers: readonly string[];
  private readonly topicUpdateNarration: boolean;
  private readonly disableLLMCorrection: boolean;
  private readonly planEnabled: boolean;
  private readonly voiceMode: boolean;
  private readonly trackerEnabled: boolean;
  private readonly planModeRoutingEnabled: boolean;
  private readonly modelSteering: boolean;
  private memoryContextManager?: MemoryContextManager;
  private readonly contextManagement: ContextManagementConfig;
  private terminalBackground: string | undefined = undefined;
  private remoteAdminSettings: AdminControlsSettings | undefined;
  private latestApiRequest: GenerateContentParameters | undefined;
  private lastModeSwitchTime: number = performance.now();
  readonly injectionService: InjectionService;
  private approvedPlanPath: string | undefined;

  constructor(params: ConfigParameters) {
    this._sessionId = params.sessionId;
    this.clientName = params.clientName;
    this.clientVersion = params.clientVersion ?? 'unknown';
    this.approvedPlanPath = undefined;
    this.embeddingModel =
      params.embeddingModel ?? DEFAULT_GEMINI_EMBEDDING_MODEL;
    this.sandbox = params.sandbox
      ? {
          enabled: params.sandbox.enabled || params.toolSandboxing || false,
          allowedPaths: params.sandbox.allowedPaths ?? [],
          includeDirectories: [
            ...(params.sandbox.includeDirectories ?? []),
            ...(params.sandbox.allowedPaths ?? []),
            Storage.getGlobalTempDir(),
          ],
          networkAccess: params.sandbox.networkAccess ?? false,
          command: params.sandbox.command,
          image: params.sandbox.image,
        }
      : {
          enabled: params.toolSandboxing || false,
          allowedPaths: [],
          includeDirectories: [Storage.getGlobalTempDir()],
          networkAccess: false,
        };

    this.targetDir = path.resolve(params.targetDir);
    this.folderTrust = params.folderTrust ?? false;
    this.workspaceContext = new WorkspaceContext(this.targetDir, []);
    this.pendingIncludeDirectories = params.includeDirectories ?? [];
    this.debugMode = params.debugMode;
    this.question = params.question;
    this.worktreeSettings = params.worktreeSettings;

    this._sandboxPolicyManager = new SandboxPolicyManager();
    const initialApprovalMode =
      params.approvalMode ??
      params.policyEngineConfig?.approvalMode ??
      'default';

    this._sandboxManager = createSandboxManager(
      this.sandbox,
      {
        workspace: this.targetDir,
        forbiddenPaths: this.getSandboxForbiddenPaths.bind(this),
        includeDirectories: [
          ...this.pendingIncludeDirectories,
          Storage.getGlobalTempDir(),
        ],
        policyManager: this._sandboxPolicyManager,
      },
      initialApprovalMode,
    );

    if (
      !(this._sandboxManager instanceof NoopSandboxManager) &&
      this.sandbox?.enabled
    ) {
      this.fileSystemService = new SandboxedFileSystemService(
        this._sandboxManager,
        params.targetDir,
      );
    } else {
      this.fileSystemService = new StandardFileSystemService();
    }

    this.debugMode = params.debugMode;
    this.question = params.question;
    this.worktreeSettings = params.worktreeSettings;

    this.coreTools = params.coreTools;
    this.mainAgentTools = params.mainAgentTools;
    this.allowedTools = params.allowedTools;
    this.excludeTools = params.excludeTools;
    this.toolDiscoveryCommand = params.toolDiscoveryCommand;
    this.toolCallCommand = params.toolCallCommand;
    this.mcpServerCommand = params.mcpServerCommand;
    this.mcpServers = params.mcpServers;
    this.mcpEnablementCallbacks = params.mcpEnablementCallbacks;
    this.mcpEnabled = params.mcpEnabled ?? true;
    this.extensionsEnabled = params.extensionsEnabled ?? true;
    this.allowedMcpServers = params.allowedMcpServers ?? [];
    this.blockedMcpServers = params.blockedMcpServers ?? [];
    this.allowedEnvironmentVariables = params.allowedEnvironmentVariables ?? [];
    this.blockedEnvironmentVariables = params.blockedEnvironmentVariables ?? [];
    this.enableEnvironmentVariableRedaction =
      params.enableEnvironmentVariableRedaction ?? false;
    this.userMemory = params.userMemory ?? '';
    this.geminiMdFileCount = params.geminiMdFileCount ?? 0;
    this.geminiMdFilePaths = params.geminiMdFilePaths ?? [];
    this.showMemoryUsage = params.showMemoryUsage ?? false;
    this.accessibility = params.accessibility ?? {};
    this.telemetrySettings = {
      enabled: params.telemetry?.enabled ?? false,
      traces: params.telemetry?.traces ?? false,
      target: params.telemetry?.target ?? DEFAULT_TELEMETRY_TARGET,
      otlpEndpoint: params.telemetry?.otlpEndpoint ?? DEFAULT_OTLP_ENDPOINT,
      otlpProtocol: params.telemetry?.otlpProtocol,
      logPrompts: params.telemetry?.logPrompts ?? true,
      outfile: params.telemetry?.outfile,
      useCollector: params.telemetry?.useCollector,
      useCliAuth: params.telemetry?.useCliAuth,
    };
    this.usageStatisticsEnabled = params.usageStatisticsEnabled ?? true;

    this.fileFiltering = {
      respectGitIgnore:
        params.fileFiltering?.respectGitIgnore ??
        DEFAULT_FILE_FILTERING_OPTIONS.respectGitIgnore,
      respectGeminiIgnore:
        params.fileFiltering?.respectGeminiIgnore ??
        DEFAULT_FILE_FILTERING_OPTIONS.respectGeminiIgnore,
      enableFileWatcher:
        params.fileFiltering?.enableFileWatcher ??
        DEFAULT_FILE_FILTERING_OPTIONS.enableFileWatcher ??
        true,
      enableRecursiveFileSearch:
        params.fileFiltering?.enableRecursiveFileSearch ?? true,
      enableFuzzySearch: params.fileFiltering?.enableFuzzySearch ?? true,
      maxFileCount:
        params.fileFiltering?.maxFileCount ??
        DEFAULT_FILE_FILTERING_OPTIONS.maxFileCount ??
        20000,
      searchTimeout:
        params.fileFiltering?.searchTimeout ??
        DEFAULT_FILE_FILTERING_OPTIONS.searchTimeout ??
        5000,
      customIgnoreFilePaths: params.fileFiltering?.customIgnoreFilePaths ?? [],
    };
    this.checkpointing = params.checkpointing ?? false;
    this.proxy = params.proxy;
    this.cwd = params.cwd ?? process.cwd();
    this.fileDiscoveryService = params.fileDiscoveryService ?? null;
    this.bugCommand = params.bugCommand;
    this.model = params.model;
    this.disableLoopDetection = params.disableLoopDetection ?? false;
    this._activeModel = params.model;
    this.enableAgents = params.enableAgents ?? true;
    this.agents = params.agents ?? {};
    this.disableLLMCorrection = params.disableLLMCorrection ?? true;
    this.planEnabled = params.plan ?? true;
    this.voiceMode = params.voiceMode ?? false;
    this.trackerEnabled = params.tracker ?? false;
    this.planModeRoutingEnabled = params.planSettings?.modelRouting ?? true;
    this.enableEventDrivenScheduler = params.enableEventDrivenScheduler ?? true;
    this.skillsSupport = params.skillsSupport ?? true;
    this.disabledSkills = params.disabledSkills ?? [];
    this.adminSkillsEnabled = params.adminSkillsEnabled ?? true;
    this.modelAvailabilityService = new ModelAvailabilityService();
    this.dynamicModelConfiguration = params.dynamicModelConfiguration ?? false;

    // HACK: The settings loading logic doesn't currently merge the default
    // generation config with the user's settings. This means if a user provides
    // any `generation` settings (e.g., just `overrides`), the default `aliases`
    // are lost. This hack manually merges the default aliases back in if they
    // are missing from the user's config.
    // TODO(12593): Fix the settings loading logic to properly merge defaults and
    // remove this hack.
    let modelConfigServiceConfig = params.modelConfigServiceConfig;
    if (modelConfigServiceConfig) {
      // Ensure user-defined model definitions augment, not replace, the defaults.
      const mergedModelDefinitions = {
        ...DEFAULT_MODEL_CONFIGS.modelDefinitions,
        ...modelConfigServiceConfig.modelDefinitions,
      };
      const mergedModelIdResolutions = {
        ...DEFAULT_MODEL_CONFIGS.modelIdResolutions,
        ...modelConfigServiceConfig.modelIdResolutions,
      };
      const mergedClassifierIdResolutions = {
        ...DEFAULT_MODEL_CONFIGS.classifierIdResolutions,
        ...modelConfigServiceConfig.classifierIdResolutions,
      };
      const mergedModelChains = {
        ...DEFAULT_MODEL_CONFIGS.modelChains,
        ...modelConfigServiceConfig.modelChains,
      };

      modelConfigServiceConfig = {
        // Preserve other user settings like customAliases
        ...modelConfigServiceConfig,
        // Apply defaults for aliases and overrides if they are not provided
        aliases:
          modelConfigServiceConfig.aliases ?? DEFAULT_MODEL_CONFIGS.aliases,
        overrides:
          modelConfigServiceConfig.overrides ?? DEFAULT_MODEL_CONFIGS.overrides,
        // Use the merged model definitions
        modelDefinitions: mergedModelDefinitions,
        modelIdResolutions: mergedModelIdResolutions,
        classifierIdResolutions: mergedClassifierIdResolutions,
        modelChains: mergedModelChains,
      };
    }

    this.modelConfigService = new ModelConfigService(
      modelConfigServiceConfig ?? DEFAULT_MODEL_CONFIGS,
    );

    this.experimentalJitContext = params.experimentalJitContext ?? true;
    this.experimentalMemoryV2 = params.experimentalMemoryV2 ?? true;
    this.experimentalAutoMemory = params.experimentalAutoMemory ?? false;
    this.experimentalGemma = params.experimentalGemma ?? true;
    this.experimentalContextManagementConfig =
      params.experimentalContextManagementConfig;
    this.memoryBoundaryMarkers = params.memoryBoundaryMarkers ?? ['.git'];
    this.contextManagement = {
      enabled: params.contextManagement?.enabled ?? false,
      historyWindow: {
        maxTokens: params.contextManagement?.historyWindow?.maxTokens ?? 150000,
        retainedTokens:
          params.contextManagement?.historyWindow?.retainedTokens ?? 40000,
      },
      messageLimits: {
        normalMaxTokens:
          params.contextManagement?.messageLimits?.normalMaxTokens ?? 2500,
        retainedMaxTokens:
          params.contextManagement?.messageLimits?.retainedMaxTokens ?? 12000,
        normalizationHeadRatio:
          params.contextManagement?.messageLimits?.normalizationHeadRatio ??
          0.25,
      },
      tools: {
        distillation: {
          maxOutputTokens:
            params.contextManagement?.tools?.distillation?.maxOutputTokens ??
            10000,
          summarizationThresholdTokens:
            params.contextManagement?.tools?.distillation
              ?.summarizationThresholdTokens ?? 20000,
        },
        outputMasking: {
          protectionThresholdTokens:
            params.contextManagement?.tools?.outputMasking
              ?.protectionThresholdTokens ?? DEFAULT_TOOL_PROTECTION_THRESHOLD,
          minPrunableThresholdTokens:
            params.contextManagement?.tools?.outputMasking
              ?.minPrunableThresholdTokens ??
            DEFAULT_MIN_PRUNABLE_TOKENS_THRESHOLD,
          protectLatestTurn:
            params.contextManagement?.tools?.outputMasking?.protectLatestTurn ??
            DEFAULT_PROTECT_LATEST_TURN,
        },
      },
    };
    this.topicUpdateNarration = params.topicUpdateNarration ?? true;
    this.modelSteering = params.modelSteering ?? false;
    this.injectionService = new InjectionService(() =>
      this.isModelSteeringEnabled(),
    );
    ExecutionLifecycleService.setInjectionService(this.injectionService);
    this.maxSessionTurns = params.maxSessionTurns ?? -1;
    this.acpMode = params.acpMode ?? false;
    this.listSessions = params.listSessions ?? false;
    this.deleteSession = params.deleteSession;
    this.listExtensions = params.listExtensions ?? false;
    this._extensionLoader =
      params.extensionLoader ?? new SimpleExtensionLoader([]);
    this._enabledExtensions = params.enabledExtensions ?? [];
    this.noBrowser = params.noBrowser ?? false;
    this.summarizeToolOutput = params.summarizeToolOutput;
    this.folderTrust = params.folderTrust ?? false;
    this.ideMode = params.ideMode ?? false;
    this.includeDirectoryTree = params.includeDirectoryTree ?? true;
    this.loadMemoryFromIncludeDirectories =
      params.loadMemoryFromIncludeDirectories ?? false;
    this.importFormat = params.importFormat ?? 'tree';
    this.discoveryMaxDirs = params.discoveryMaxDirs ?? 200;
    this.compressionThreshold = params.compressionThreshold;
    this.interactive = params.interactive ?? false;
    this.ptyInfo = params.ptyInfo ?? 'child_process';
    this.trustedFolder = params.trustedFolder;
    this.directWebFetch = params.directWebFetch ?? false;
    this.useRipgrep = params.useRipgrep ?? true;
    this.useBackgroundColor = params.useBackgroundColor ?? true;
    this.useAlternateBuffer = params.useAlternateBuffer ?? false;
    this.useTerminalBuffer = params.useTerminalBuffer ?? false;
    this.useRenderProcess = params.useRenderProcess ?? true;
    this.enableInteractiveShell = params.enableInteractiveShell ?? false;

    const requestedBehavior = params.shellBackgroundCompletionBehavior;
    if (requestedBehavior === 'inject' || requestedBehavior === 'notify') {
      this.shellBackgroundCompletionBehavior = requestedBehavior;
    } else {
      this.shellBackgroundCompletionBehavior = 'silent';
    }

    this.skipNextSpeakerCheck = params.skipNextSpeakerCheck ?? true;
    this.shellExecutionConfig = {
      terminalWidth: params.shellExecutionConfig?.terminalWidth ?? 80,
      terminalHeight: params.shellExecutionConfig?.terminalHeight ?? 24,
      showColor: params.shellExecutionConfig?.showColor ?? false,
      pager: params.shellExecutionConfig?.pager ?? 'cat',
      sanitizationConfig: this.sanitizationConfig,
      sandboxManager: this._sandboxManager,
      sandboxConfig: this.sandbox,
      backgroundCompletionBehavior: this.shellBackgroundCompletionBehavior,
    };
    this.truncateToolOutputThreshold =
      params.truncateToolOutputThreshold ??
      DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD;
    const isGemini2 = isGemini2Model(this.model);
    this.useWriteTodos =
      isGemini2 && !isPreviewModel(this.model, this) && !this.trackerEnabled
        ? (params.useWriteTodos ?? true)
        : false;
    this.workspacePoliciesDir = params.workspacePoliciesDir;
    this.enableHooksUI = params.enableHooksUI ?? true;
    this.enableHooks = params.enableHooks ?? true;
    this.disabledHooks = params.disabledHooks ?? [];

    this.enableShellOutputEfficiency =
      params.enableShellOutputEfficiency ?? true;
    this.shellToolInactivityTimeout =
      (params.shellToolInactivityTimeout ?? 300) * 1000; // 5 minutes
    this.extensionManagement = params.extensionManagement ?? true;
    this.extensionRegistryURI = params.extensionRegistryURI;
    this.enableExtensionReloading = params.enableExtensionReloading ?? false;
    this.storage = new Storage(this.targetDir, this._sessionId);
    this.storage.setCustomPlansDir(params.planSettings?.directory);

    this.fakeResponses = params.fakeResponses;
    this.recordResponses = params.recordResponses;
    this.fileExclusions = new FileExclusions(this);
    this.eventEmitter = params.eventEmitter;
    this.enableConseca = params.enableConseca ?? false;

    // Initialize Safety Infrastructure
    const contextBuilder = new ContextBuilder(this);
    const checkersPath = this.targetDir;
    // The checkersPath  is used to resolve external checkers. Since we do not have any external checkers currently, it is set to the targetDir.
    const checkerRegistry = new CheckerRegistry(checkersPath);
    const checkerRunner = new CheckerRunner(contextBuilder, checkerRegistry, {
      checkersPath,
      timeout: 30000, // 30 seconds to allow for LLM-based checkers
    });
    this.policyUpdateConfirmationRequest =
      params.policyUpdateConfirmationRequest;

    this.disableAlwaysAllow = params.disableAlwaysAllow ?? false;
    const engineApprovalMode =
      params.approvalMode ??
      params.policyEngineConfig?.approvalMode ??
      ApprovalMode.DEFAULT;
    this.policyEngine = new PolicyEngine(
      {
        ...params.policyEngineConfig,
        approvalMode: engineApprovalMode,
        disableAlwaysAllow: this.disableAlwaysAllow,
        sandboxManager: this._sandboxManager,
      },
      checkerRunner,
    );

    // Register Conseca if enabled
    if (this.enableConseca) {
      debugLogger.log('[SAFETY] Registering Conseca Safety Checker');
      ConsecaSafetyChecker.getInstance().setContext(this);
    }

    this._messageBus = new MessageBus(this.policyEngine, this.debugMode);
    this.acknowledgedAgentsService = new AcknowledgedAgentsService();
    this.skillManager = new SkillManager();
    this.outputSettings = {
      format: params.output?.format ?? OutputFormat.TEXT,
    };
    this.gemmaModelRouter = {
      enabled: params.gemmaModelRouter?.enabled ?? false,
      autoStartServer: params.gemmaModelRouter?.autoStartServer ?? true,
      binaryPath: params.gemmaModelRouter?.binaryPath ?? '',
      classifier: {
        host:
          params.gemmaModelRouter?.classifier?.host ?? 'http://localhost:9379',
        model:
          params.gemmaModelRouter?.classifier?.model ?? 'gemma3-1b-gpu-custom',
      },
    };

    this.agentSessionNoninteractiveEnabled =
      params.adk?.agentSessionNoninteractiveEnabled ?? false;
    this.agentSessionInteractiveEnabled =
      params.adk?.agentSessionInteractiveEnabled ?? false;
    this.localUrl = params.localUrl;
    this.localModel = params.localModel ?? 'local-model';
    this.localTimeout = params.localTimeout ?? 120_000;
    this.localEnableTools = params.localEnableTools ?? false;
    this.localPromptMode = params.localPromptMode ?? 'lite';
    // --- LOCAL FORK ADDITION (Phase 2.0.12) ---
    // Resolve tool-call parser mode in priority order:
    //   1. explicit constructor param (settings.json: local.toolCallParsing)
    //   2. env var GEMINI_LOCAL_TOOL_CALL_PARSING (matches GEMINI_LOCAL_*
    //      naming for the rest of local.* config)
    //   3. default 'lenient' — preserves all currently-working models and
    //      recovers Nemotron 3 / Mistral 4 without enabling the high-risk
    //      'loose' path. See Phase 2.0.12 in AGENT.md.
    // Invalid values fall back to 'lenient' silently rather than throwing,
    // so a typo in user settings can never crash the local mode boot path.
    const VALID_PARSE_MODES = ['strict', 'lenient', 'loose'] as const;
    type ParseMode = (typeof VALID_PARSE_MODES)[number];
    const isValidParseMode = (v: unknown): v is ParseMode =>
      typeof v === 'string' &&
      (VALID_PARSE_MODES as readonly string[]).includes(v);
    const rawParseMode =
      params.localToolCallParseMode ??
      process.env['GEMINI_LOCAL_TOOL_CALL_PARSING'] ??
      'lenient';
    this.localToolCallParseMode = isValidParseMode(rawParseMode)
      ? rawParseMode
      : 'lenient';
    // --- END LOCAL FORK ADDITION ---
    // --- LOCAL FORK ADDITION (Phase 2.0.13) ---
    {
      const rawTemp =
        params.localTemperature ??
        (process.env['GEMINI_LOCAL_TEMPERATURE']
          ? parseFloat(process.env['GEMINI_LOCAL_TEMPERATURE'])
          : undefined);
      this.localTemperature =
        rawTemp !== undefined &&
        isFinite(rawTemp) &&
        rawTemp >= 0 &&
        rawTemp <= 2
          ? rawTemp
          : null;
    }
    // --- END LOCAL FORK ADDITION ---
    // --- LOCAL FORK ADDITION (Phase 2.0.14) ---
    // Each sampler value is independently optional. Out-of-range or unparseable
    // values are silently coerced to null so the field is omitted from request
    // bodies and the server falls back to its own default.
    {
      const rawTopP =
        params.localTopP ??
        (process.env['GEMINI_LOCAL_TOP_P']
          ? parseFloat(process.env['GEMINI_LOCAL_TOP_P'])
          : undefined);
      this.localTopP =
        rawTopP !== undefined &&
        isFinite(rawTopP) &&
        rawTopP > 0 &&
        rawTopP <= 1
          ? rawTopP
          : null;

      const rawTopK =
        params.localTopK ??
        (process.env['GEMINI_LOCAL_TOP_K']
          ? parseInt(process.env['GEMINI_LOCAL_TOP_K'], 10)
          : undefined);
      // top_k accepts -1 (vLLM convention for "disabled") and any positive int.
      this.localTopK =
        rawTopK !== undefined &&
        Number.isInteger(rawTopK) &&
        (rawTopK === -1 || rawTopK >= 1)
          ? rawTopK
          : null;

      const rawMinP =
        params.localMinP ??
        (process.env['GEMINI_LOCAL_MIN_P']
          ? parseFloat(process.env['GEMINI_LOCAL_MIN_P'])
          : undefined);
      this.localMinP =
        rawMinP !== undefined &&
        isFinite(rawMinP) &&
        rawMinP >= 0 &&
        rawMinP <= 1
          ? rawMinP
          : null;

      const rawRepPen =
        params.localRepetitionPenalty ??
        (process.env['GEMINI_LOCAL_REPETITION_PENALTY']
          ? parseFloat(process.env['GEMINI_LOCAL_REPETITION_PENALTY'])
          : undefined);
      // 1.0 = disabled. vLLM accepts (0, 2]; values <= 0 break sampling.
      this.localRepetitionPenalty =
        rawRepPen !== undefined &&
        isFinite(rawRepPen) &&
        rawRepPen > 0 &&
        rawRepPen <= 2
          ? rawRepPen
          : null;
    }
    // --- END LOCAL FORK ADDITION ---
    // --- LOCAL FORK ADDITION (Phase 2.1) ---
    // Hosted-provider state. The GEMINI_PROVIDER env var overrides the
    // settings.json `providers.active` field so an end user can flip the
    // active provider per-shell without editing files. providersConfig is
    // taken as-is; per-instance shape validation runs at read time
    // (`getActiveProviderResolved`) so a bad override surfaces with a
    // clear error rather than crashing the constructor.
    this.providersActive =
      process.env['GEMINI_PROVIDER']?.trim() ||
      params.providersActive ||
      undefined;
    this.providersConfig = params.providersConfig ?? {};
    // Phase 2.3: custom providers are taken as-is. Per-entry shape
    // validation runs at read time inside customToProviderDefinition()
    // and at write time inside addCustomProvider(); the constructor
    // does not throw on a malformed entry — a bad entry simply fails
    // when the user tries to switch to it, which is consistent with
    // the rest of the provider plumbing.
    this.providersCustom = { ...(params.providersCustom ?? {}) };
    // --- END LOCAL FORK ADDITION ---
    this.localContextLimit = params.localContextLimit;
    this.localCompressionThreshold = params.localCompressionThreshold;
    this.localPreserveFraction = params.localPreserveFraction;
    this.localAutoTruncateOnOverflow =
      params.localAutoTruncateOnOverflow ?? true;
    // --- LOCAL FORK ADDITION (Phase 2.0) ---
    this.localAdaptiveCompressionEnabled =
      params.localAdaptiveCompressionEnabled ?? true;
    this.localAdaptiveCompressionCooldownTurns =
      params.localAdaptiveCompressionCooldownTurns ??
      DEFAULT_ADAPTIVE_COOLDOWN_TURNS;
    this.localAdaptiveCompressionFloor =
      params.localAdaptiveCompressionFloor ?? ADAPTIVE_THRESHOLD_FLOOR;
    this.localWriteFileEjectionEnabled =
      params.localWriteFileEjectionEnabled ?? true;
    this.localWriteFileEjectionMinAgeTurns =
      params.localWriteFileEjectionMinAgeTurns ??
      DEFAULT_LOCAL_WRITE_FILE_EJECTION_MIN_AGE_TURNS;
    this.localWriteFileEjectionMinTokensPerCall =
      params.localWriteFileEjectionMinTokensPerCall ??
      DEFAULT_LOCAL_WRITE_FILE_EJECTION_MIN_TOKENS_PER_CALL;
    this.localPreTurnBudgetEnabled = params.localPreTurnBudgetEnabled ?? true;
    this.localPreTurnBudgetReservedResponseTokens =
      params.localPreTurnBudgetReservedResponseTokens ??
      DEFAULT_LOCAL_PRE_TURN_RESERVED_RESPONSE_TOKENS;
    this.localPreTurnBudgetProactiveCompressAt =
      params.localPreTurnBudgetProactiveCompressAt ??
      DEFAULT_LOCAL_PRE_TURN_PROACTIVE_COMPRESS_AT;
    this.localToolOutputMaskingEnabled =
      params.localToolOutputMaskingEnabled ?? true;
    this.localToolOutputMaskingProtectionFraction =
      params.localToolOutputMaskingProtectionFraction ??
      DEFAULT_LOCAL_MASKING_PROTECTION_FRACTION;
    this.localToolOutputMaskingPrunableFraction =
      params.localToolOutputMaskingPrunableFraction ??
      DEFAULT_LOCAL_MASKING_PRUNABLE_FRACTION;
    this.localToolOutputMaskingProtectLatestTurn =
      params.localToolOutputMaskingProtectLatestTurn ?? true;

    this.retryFetchErrors = params.retryFetchErrors ?? true;
    this.maxAttempts = Math.min(
      params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      DEFAULT_MAX_ATTEMPTS,
    );
    this.disableYoloMode = params.disableYoloMode ?? false;
    this.rawOutput = params.rawOutput ?? false;
    this.acceptRawOutputRisk = params.acceptRawOutputRisk ?? false;

    if (params.hooks) {
      this.hooks = params.hooks;
    }
    if (params.projectHooks) {
      this.projectHooks = params.projectHooks;
    }

    this.experiments = params.experiments;
    this.onModelChange = params.onModelChange;
    this.onReload = params.onReload;

    this.billing = {
      overageStrategy: params.billing?.overageStrategy ?? 'ask',
    };
    this.vertexAiRouting = params.vertexAiRouting;

    if (params.contextFileName) {
      setGeminiMdFilename(params.contextFileName);
    }

    if (this.telemetrySettings.enabled) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      initializeTelemetry(this);
    }

    const proxy = this.getProxy();
    if (proxy) {
      try {
        setGlobalProxy(proxy);
      } catch (error) {
        coreEvents.emitFeedback(
          'error',
          'Invalid proxy configuration detected. Check debug drawer for more details (F12)',
          error,
        );
      }
    }
    this._geminiClient = new GeminiClient(this);
    this.a2aClientManager = new A2AClientManager(this);
    this.modelRouterService = new ModelRouterService(this);
  }

  get config(): Config {
    return this;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Dedups initialization requests using a shared promise that is only resolved
   * once.
   */
  async initialize(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this._initialize();

    return this.initPromise;
  }

  private async _initialize(): Promise<void> {
    await this.storage.initialize();

    // Add pending directories to workspace context
    for (const dir of this.pendingIncludeDirectories) {
      this.workspaceContext.addDirectory(dir);
    }

    // Add plans directory to workspace context for plan file storage
    if (this.planEnabled) {
      let plansDir: string;
      try {
        plansDir = this.storage.getPlansDir();
      } catch (error) {
        // Fallback to the default plan dir if any error occurs
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        coreEvents.emitFeedback(
          'warning',
          'Invalid custom plans directory: ' +
            errorMessage +
            '. Falling back to default project temp directory.',
          error,
        );
        this.storage.setCustomPlansDir(undefined);
        plansDir = this.storage.getPlansDir();
      }

      try {
        await fs.promises.access(plansDir);
        this.workspaceContext.addDirectory(plansDir);
      } catch {
        // Directory does not exist yet, so we don't add it to the workspace context.
        // It will be created when the first plan is written. Since custom plan
        // directories must be within the project root, they are automatically
        // covered by the project-wide file discovery once created.
      }
    }

    // Initialize centralized FileDiscoveryService
    const discoverToolsHandle = startupProfiler.start('discover_tools');
    this.getFileService();
    if (this.getCheckpointingEnabled()) {
      await this.getGitService();
    }
    this._promptRegistry = new PromptRegistry();
    this._resourceRegistry = new ResourceRegistry();

    this.agentRegistry = new AgentRegistry(this);
    await this.agentRegistry.initialize();

    coreEvents.on(CoreEvent.AgentsRefreshed, this.onAgentsRefreshed);

    this._toolRegistry = await this.createToolRegistry();
    discoverToolsHandle?.end();
    this.mcpClientManager = new McpClientManager(
      this.clientVersion,
      this,
      this.eventEmitter,
    );
    this.mcpClientManager.setMainRegistries({
      toolRegistry: this._toolRegistry,
      promptRegistry: this.promptRegistry,
      resourceRegistry: this.resourceRegistry,
    });
    // We do not await this promise so that the CLI can start up even if
    // MCP servers are slow to connect.
    this.mcpInitializationPromise = Promise.allSettled([
      this.mcpClientManager.startConfiguredMcpServers(),
      this.getExtensionLoader().start(this),
    ]).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') {
          debugLogger.error('Error initializing MCP clients:', result.reason);
        }
      }
    });

    if (!this.interactive || this.acpMode) {
      await this.mcpInitializationPromise;
    }

    if (this.skillsSupport) {
      this.getSkillManager().setAdminSettings(this.adminSkillsEnabled);
      if (this.adminSkillsEnabled) {
        await this.getSkillManager().discoverSkills(
          this.storage,
          this.getExtensions(),
          this.isTrustedFolder(),
        );
        this.getSkillManager().setDisabledSkills(this.disabledSkills);

        // Re-register ActivateSkillTool to update its schema with the discovered enabled skill enums
        if (this.getSkillManager().getSkills().length > 0) {
          this.toolRegistry.unregisterTool(ActivateSkillTool.Name);
          this.toolRegistry.registerTool(
            new ActivateSkillTool(this, this.messageBus),
          );
        }
      }
    }

    // Initialize hook system if enabled
    if (this.getEnableHooks()) {
      this.hookSystem = new HookSystem(this);
      await this.hookSystem.initialize();
    }

    if (this.experimentalJitContext) {
      this.memoryContextManager = new MemoryContextManager(this);
      await this.memoryContextManager.refresh();
    }

    await this._geminiClient.initialize();
    this.initialized = true;
  }

  getContentGenerator(): ContentGenerator {
    return this.contentGenerator;
  }

  async refreshAuth(
    authMethod: AuthType,
    apiKey?: string,
    baseUrl?: string,
    customHeaders?: Record<string, string>,
  ) {
    // --- LOCAL FORK ADDITION (Phase 2.2: provider-driven auth dispatch) ---
    // When a provider is active and its registry-declared authType
    // disagrees with the incoming authMethod, the registry wins. This is
    // the path that lets `/provider use gemini-oauth` redispatch a
    // refreshAuth(LOCAL) call into refreshAuth(LOGIN_WITH_GOOGLE) without
    // every caller having to know about wireFormat.
    if (this.providersActive) {
      const eff = this.getEffectiveProviderConfig();
      if (eff && eff.authType !== authMethod) {
        authMethod = eff.authType;
      }
    }
    // --- END LOCAL FORK ADDITION ---

    // OpenAI-compat bypass: skip the full upstream auth chain when
    // routing to a local endpoint OR a hosted OpenAI-compat provider.
    // Both flow through the same generator; the difference is just
    // whether requiresApiKey adds a Bearer header. isLocalMode() is
    // wireFormat-aware so Gemini providers fall through to upstream.
    if (this.isLocalMode() || authMethod === AuthType.LOCAL) {
      const localConfig: ContentGeneratorConfig = {
        authType: AuthType.LOCAL,
      };
      this.contentGenerator = await createContentGenerator(
        localConfig,
        this,
        this.getSessionId(),
      );
      this.contentGeneratorConfig = localConfig;
      this.baseLlmClient = new BaseLlmClient(this.contentGenerator, this);
      // --- LOCAL FORK ADDITION (Phase 2.1.1) ---
      // Provider-mode: surface the resolved model id (e.g. gpt-4o) into
      // config.model so the footer + /model dialog show the right value.
      // Skip the 'local-model' placeholder used by local presets that have
      // no user-supplied model — that placeholder isn't meaningful in the
      // footer and the existing model-discovery path will populate it.
      const eff = this.getEffectiveProviderConfig();
      if (eff && eff.model && eff.model !== 'local-model') {
        this.setModel(eff.model, true);
      }
      // --- END LOCAL FORK ADDITION ---
      await discoverAndStoreLocalModels(this);
      return;
    }

    // Reset availability service when switching auth
    this.modelAvailabilityService.reset();

    // Vertex and Genai have incompatible encryption and sending history with
    // thoughtSignature from Genai to Vertex will fail, we need to strip them
    if (
      this.contentGeneratorConfig?.authType === AuthType.USE_GEMINI &&
      authMethod !== AuthType.USE_GEMINI
    ) {
      // Restore the conversation history to the new client
      this._geminiClient.stripThoughtsFromHistory();
    }

    // Reset availability status when switching auth (e.g. from limited key to OAuth)
    this.modelAvailabilityService.reset();

    // Clear stale authType to ensure getGemini31LaunchedSync doesn't return stale results
    // during the transition.
    if (this.contentGeneratorConfig) {
      this.contentGeneratorConfig.authType = undefined;
    }

    const newContentGeneratorConfig = await createContentGeneratorConfig(
      this,
      authMethod,
      apiKey,
      baseUrl,
      customHeaders,
      this.vertexAiRouting,
    );
    this.contentGenerator = await createContentGenerator(
      newContentGeneratorConfig,
      this,
      this.getSessionId(),
    );
    // Only assign to instance properties after successful initialization
    this.contentGeneratorConfig = newContentGeneratorConfig;

    const codeAssistServer = getCodeAssistServer(this);
    const quotaPromise = codeAssistServer?.projectId
      ? this.refreshUserQuota()
      : Promise.resolve();

    this.experimentsPromise = getExperiments(codeAssistServer)
      .then((experiments) => {
        this.setExperiments(experiments);
        return experiments;
      })
      .catch((e) => {
        debugLogger.error('Failed to fetch experiments', e);
        return undefined;
      });

    const [experiments] = await Promise.all([
      this.experimentsPromise,
      quotaPromise.catch((e) => {
        debugLogger.error('Failed to fetch user quota', e);
      }),
    ]);

    const requestTimeoutMs = this.getRequestTimeoutMs();
    if (requestTimeoutMs !== undefined) {
      updateGlobalFetchTimeouts(requestTimeoutMs);
    }

    // Initialize BaseLlmClient now that the ContentGenerator and experiments are available
    this.baseLlmClient = new BaseLlmClient(this.contentGenerator, this);

    const authType = this.contentGeneratorConfig.authType;
    if (
      authType === AuthType.USE_GEMINI ||
      authType === AuthType.USE_VERTEX_AI
    ) {
      this.setHasAccessToPreviewModel(true);
    }

    // Only reset when we have explicit "no access" (hasAccessToPreviewModel === false).
    // When null (quota not fetched) or true, we preserve the saved model.
    if (
      isPreviewModel(this.model, this) &&
      this.hasAccessToPreviewModel === false
    ) {
      this.setModel(DEFAULT_GEMINI_MODEL_AUTO);
    }

    const adminControlsEnabled =
      experiments?.flags[ExperimentFlags.ENABLE_ADMIN_CONTROLS]?.boolValue ??
      false;

    try {
      const adminControls = await fetchAdminControls(
        codeAssistServer,
        this.getRemoteAdminSettings(),
        adminControlsEnabled,
        (newSettings: AdminControlsSettings) => {
          this.setRemoteAdminSettings(newSettings);
          coreEvents.emitAdminSettingsChanged();
        },
      );
      this.setRemoteAdminSettings(adminControls);
    } catch (e) {
      debugLogger.error('Failed to fetch admin controls', e);
    }

    if ((await this.getProModelNoAccess()) && isAutoModel(this.model)) {
      this.setModel(PREVIEW_GEMINI_FLASH_MODEL);
    }
  }

  async getExperimentsAsync(): Promise<Experiments | undefined> {
    if (this.experiments) {
      return this.experiments;
    }
    const codeAssistServer = getCodeAssistServer(this);
    return getExperiments(codeAssistServer);
  }

  getUserTier(): UserTierId | undefined {
    return this.contentGenerator?.userTier;
  }

  getUserTierName(): string | undefined {
    return this.contentGenerator?.userTierName;
  }

  getUserPaidTier(): GeminiUserTier | undefined {
    return this.contentGenerator?.paidTier;
  }

  /**
   * Provides access to the BaseLlmClient for stateless LLM operations.
   */
  getBaseLlmClient(): BaseLlmClient {
    if (!this.baseLlmClient) {
      // Handle cases where initialization might be deferred or authentication failed
      if (!this.experiments) {
        throw new Error(
          'BaseLlmClient not initialized. Ensure experiments have been fetched and configuration is ready.',
        );
      }
      if (this.contentGenerator) {
        this.baseLlmClient = new BaseLlmClient(
          this.getContentGenerator(),
          this,
        );
      } else {
        throw new Error(
          'BaseLlmClient not initialized. Ensure authentication has occurred and ContentGenerator is ready.',
        );
      }
    }
    return this.baseLlmClient;
  }

  getLocalLiteRtLmClient(): LocalLiteRtLmClient {
    if (!this.localLiteRtLmClient) {
      this.localLiteRtLmClient = new LocalLiteRtLmClient(this);
    }
    return this.localLiteRtLmClient;
  }

  get promptId(): string {
    return this._sessionId;
  }

  /**
   * @deprecated Do not access directly on Config.
   * Use the injected AgentLoopContext instead.
   */
  get toolRegistry(): ToolRegistry {
    return this._toolRegistry;
  }

  /**
   * @deprecated Do not access directly on Config.
   * Use the injected AgentLoopContext instead.
   */
  get promptRegistry(): PromptRegistry {
    return this._promptRegistry;
  }

  /**
   * @deprecated Do not access directly on Config.
   * Use the injected AgentLoopContext instead.
   */
  get resourceRegistry(): ResourceRegistry {
    return this._resourceRegistry;
  }

  /**
   * @deprecated Do not access directly on Config.
   * Use the injected AgentLoopContext instead.
   */
  get messageBus(): MessageBus {
    return this._messageBus;
  }

  /**
   * @deprecated Do not access directly on Config.
   * Use the injected AgentLoopContext instead.
   */
  get geminiClient(): GeminiClient {
    return this._geminiClient;
  }

  private async getSandboxForbiddenPaths(): Promise<string[]> {
    if (this._sandboxForbiddenPaths) {
      return this._sandboxForbiddenPaths;
    }

    this._sandboxForbiddenPaths = await this.getFileService().getIgnoredPaths({
      respectGitIgnore: false,
      respectGeminiIgnore: true,
    });

    return this._sandboxForbiddenPaths;
  }

  private refreshSandboxManager(): void {
    this._sandboxManager = createSandboxManager(
      this.sandbox,
      {
        workspace: this.targetDir,
        forbiddenPaths: this.getSandboxForbiddenPaths.bind(this),
        includeDirectories: [
          ...this.pendingIncludeDirectories,
          Storage.getGlobalTempDir(),
        ],
        policyManager: this._sandboxPolicyManager,
      },
      this.getApprovalMode(),
    );
    this.shellExecutionConfig.sandboxManager = this._sandboxManager;
  }

  get sandboxPolicyManager() {
    return this._sandboxPolicyManager;
  }

  get sandboxManager(): SandboxManager {
    return this._sandboxManager;
  }

  getSessionId(): string {
    return this.promptId;
  }

  getWorktreeSettings(): WorktreeSettings | undefined {
    return this.worktreeSettings;
  }

  getClientName(): string | undefined {
    return this.clientName;
  }

  setSessionId(sessionId: string): void {
    const previousPlansDir = this.storage.isInitialized()
      ? this.storage.getPlansDir()
      : undefined;

    this._sessionId = sessionId;
    this.storage.setSessionId(sessionId);
    this.trackerService = undefined;
    this.approvedPlanPath = undefined;
    this.topicState.reset();
    this.skillManager.reset();
    this.latestApiRequest = undefined;
    this.lastModeSwitchTime = performance.now();
    this.compressionTruncationCounter = 0;
    this.quotaErrorOccurred = false;
    this.creditsNotificationShown = false;
    this.modelAvailabilityService.reset();
    this.modelQuotas.clear();
    this.lastRetrievedQuota = undefined;
    this.lastQuotaFetchTime = 0;
    this.hasAccessToPreviewModel = null;

    // Force an event emission to clear the UI display
    coreEvents.emitQuotaChanged(undefined, undefined, undefined);
    this.lastEmittedQuotaRemaining = undefined;
    this.lastEmittedQuotaLimit = undefined;

    if (previousPlansDir) {
      this.refreshSessionScopedPlansDirectory(previousPlansDir);
    }
  }

  resetNewSessionState(sessionId: string): void {
    this.setSessionId(sessionId);
  }

  setTerminalBackground(terminalBackground: string | undefined): void {
    this.terminalBackground = terminalBackground;
  }

  getTerminalBackground(): string | undefined {
    return this.terminalBackground;
  }

  getLatestApiRequest(): GenerateContentParameters | undefined {
    return this.latestApiRequest;
  }

  setLatestApiRequest(req: GenerateContentParameters): void {
    this.latestApiRequest = req;
  }

  getRemoteAdminSettings(): AdminControlsSettings | undefined {
    return this.remoteAdminSettings;
  }

  setRemoteAdminSettings(settings: AdminControlsSettings | undefined): void {
    this.remoteAdminSettings = settings;
  }

  shouldLoadMemoryFromIncludeDirectories(): boolean {
    return this.loadMemoryFromIncludeDirectories;
  }

  getIncludeDirectoryTree(): boolean {
    return this.includeDirectoryTree;
  }

  getImportFormat(): 'tree' | 'flat' {
    return this.importFormat;
  }

  getDiscoveryMaxDirs(): number {
    return this.discoveryMaxDirs;
  }

  getContentGeneratorConfig(): ContentGeneratorConfig {
    return this.contentGeneratorConfig;
  }

  getModel(): string {
    return this.model;
  }

  getDisableLoopDetection(): boolean {
    return this.disableLoopDetection ?? false;
  }

  setModel(newModel: string, isTemporary: boolean = true): void {
    if (this.model !== newModel || this._activeModel !== newModel) {
      this.model = newModel;
      // When the user explicitly sets a model, that becomes the active model.
      this._activeModel = newModel;
      coreEvents.emitModelChanged(newModel);
      this.lastEmittedQuotaRemaining = undefined;
      this.lastEmittedQuotaLimit = undefined;
      this.emitQuotaChangedEvent();
    }
    if (this.onModelChange && !isTemporary) {
      this.onModelChange(newModel);
    }
    this.modelAvailabilityService.reset();
  }

  activateFallbackMode(model: string): void {
    this.setModel(model, true);
    const authType = this.getContentGeneratorConfig()?.authType;
    if (authType) {
      logFlashFallback(this, new FlashFallbackEvent(authType));
    }
  }

  getActiveModel(): string {
    return this._activeModel ?? this.model;
  }

  setActiveModel(model: string): void {
    if (this._activeModel !== model) {
      this._activeModel = model;
    }
  }

  setFallbackModelHandler(handler: FallbackModelHandler): void {
    this.fallbackModelHandler = handler;
  }

  getFallbackModelHandler(): FallbackModelHandler | undefined {
    return this.fallbackModelHandler;
  }

  setValidationHandler(handler: ValidationHandler): void {
    this.validationHandler = handler;
  }

  getValidationHandler(): ValidationHandler | undefined {
    return this.validationHandler;
  }

  resetTurn(): void {
    this.modelAvailabilityService.resetTurn();
  }

  /** Resets billing state (overageStrategy, creditsNotificationShown) once per user prompt. */
  resetBillingTurnState(overageStrategy?: OverageStrategy): void {
    this.creditsNotificationShown = false;
    this.billing.overageStrategy = overageStrategy ?? 'ask';
  }

  getMaxSessionTurns(): number {
    return this.maxSessionTurns;
  }

  setQuotaErrorOccurred(value: boolean): void {
    this.quotaErrorOccurred = value;
  }

  getQuotaErrorOccurred(): boolean {
    return this.quotaErrorOccurred;
  }

  setCreditsNotificationShown(value: boolean): void {
    this.creditsNotificationShown = value;
  }

  getCreditsNotificationShown(): boolean {
    return this.creditsNotificationShown;
  }

  setQuota(
    remaining: number | undefined,
    limit: number | undefined,
    modelId?: string,
  ): void {
    const activeModel = modelId ?? this.getActiveModel();
    if (remaining !== undefined && limit !== undefined) {
      const current = this.modelQuotas.get(activeModel);
      if (
        !current ||
        current.remaining !== remaining ||
        current.limit !== limit
      ) {
        this.modelQuotas.set(activeModel, { remaining, limit });
        this.emitQuotaChangedEvent();
      }
    }
  }

  private getPooledQuota(): {
    remaining?: number;
    limit?: number;
    resetTime?: string;
  } {
    const model = this.getModel();
    if (!isAutoModel(model)) {
      return {};
    }

    const isPreview =
      model === PREVIEW_GEMINI_MODEL_AUTO ||
      isPreviewModel(this.getActiveModel(), this);
    const proModel = isPreview ? PREVIEW_GEMINI_MODEL : DEFAULT_GEMINI_MODEL;
    const flashModel = isPreview
      ? PREVIEW_GEMINI_FLASH_MODEL
      : DEFAULT_GEMINI_FLASH_MODEL;

    const proQuota = this.modelQuotas.get(proModel);
    const flashQuota = this.modelQuotas.get(flashModel);

    if (proQuota || flashQuota) {
      // For reset time, take the one that is furthest in the future (most conservative)
      const resetTime = [proQuota?.resetTime, flashQuota?.resetTime]
        .filter((t): t is string => !!t)
        .sort()
        .reverse()[0];

      return {
        remaining: (proQuota?.remaining ?? 0) + (flashQuota?.remaining ?? 0),
        limit: (proQuota?.limit ?? 0) + (flashQuota?.limit ?? 0),
        resetTime,
      };
    }

    return {};
  }

  getQuotaRemaining(): number | undefined {
    const pooled = this.getPooledQuota();
    if (pooled.remaining !== undefined) {
      return pooled.remaining;
    }
    const primaryModel = resolveModel(
      this.getModel(),
      this.getGemini31LaunchedSync(),
      this.getGemini31FlashLiteLaunchedSync(),
      this.getUseCustomToolModelSync(),
      this.getHasAccessToPreviewModel(),
      this,
    );
    return this.modelQuotas.get(primaryModel)?.remaining;
  }

  getQuotaLimit(): number | undefined {
    const pooled = this.getPooledQuota();
    if (pooled.limit !== undefined) {
      return pooled.limit;
    }
    const primaryModel = resolveModel(
      this.getModel(),
      this.getGemini31LaunchedSync(),
      this.getGemini31FlashLiteLaunchedSync(),
      this.getUseCustomToolModelSync(),
      this.getHasAccessToPreviewModel(),
      this,
    );
    return this.modelQuotas.get(primaryModel)?.limit;
  }

  getQuotaResetTime(): string | undefined {
    const pooled = this.getPooledQuota();
    if (pooled.resetTime !== undefined) {
      return pooled.resetTime;
    }
    const primaryModel = resolveModel(
      this.getModel(),
      this.getGemini31LaunchedSync(),
      this.getGemini31FlashLiteLaunchedSync(),
      this.getUseCustomToolModelSync(),
      this.getHasAccessToPreviewModel(),
      this,
    );
    return this.modelQuotas.get(primaryModel)?.resetTime;
  }

  getEmbeddingModel(): string {
    return this.embeddingModel;
  }

  getSandbox(): SandboxConfig | undefined {
    return this.sandbox;
  }

  getSandboxEnabled(): boolean {
    return this.sandbox?.enabled ?? false;
  }

  getSandboxAllowedPaths(): string[] {
    const paths = [...(this.sandbox?.allowedPaths ?? [])];
    const globalTempDir = Storage.getGlobalTempDir();
    if (!paths.includes(globalTempDir)) {
      paths.push(globalTempDir);
    }
    return paths;
  }

  getSandboxNetworkAccess(): boolean {
    return this.sandbox?.networkAccess ?? false;
  }

  isRestrictiveSandbox(): boolean {
    const sandboxConfig = this.getSandbox();
    const seatbeltProfile = process.env['SEATBELT_PROFILE'];
    return (
      !!sandboxConfig &&
      sandboxConfig.command === 'sandbox-exec' &&
      !!seatbeltProfile &&
      (seatbeltProfile.startsWith('restrictive-') ||
        seatbeltProfile.startsWith('strict-'))
    );
  }

  getTargetDir(): string {
    return this.targetDir;
  }

  getProjectRoot(): string {
    return this.targetDir;
  }

  getWorkspaceContext(): WorkspaceContext {
    return getWorkspaceContextOverride() ?? this.workspaceContext;
  }

  private refreshSessionScopedPlansDirectory(previousPlansDir: string): void {
    const nextPlansDir = this.storage.getPlansDir();
    if (previousPlansDir === nextPlansDir) {
      return;
    }

    const pathsToRemove = new Set([previousPlansDir]);
    try {
      pathsToRemove.add(resolveToRealPath(previousPlansDir));
    } catch {
      // The previous session's plans directory may never have been created.
      // In that case there is nothing to resolve or remove beyond the raw path.
    }

    const currentDirectories = this.workspaceContext
      .getDirectories()
      .filter((dir) => !pathsToRemove.has(dir));

    this.workspaceContext.setDirectories(currentDirectories);

    try {
      if (fs.existsSync(nextPlansDir)) {
        this.workspaceContext.addDirectory(nextPlansDir);
      }
    } catch {
      // Ignore invalid or unreadable plans directories here. This mirrors
      // initialization behavior, which only adds the plans directory when it
      // already exists and is readable.
    }
  }

  getAgentRegistry(): AgentRegistry {
    return this.agentRegistry;
  }

  getAcknowledgedAgentsService(): AcknowledgedAgentsService {
    return this.acknowledgedAgentsService;
  }

  /** @deprecated Use toolRegistry getter */
  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  getPromptRegistry(): PromptRegistry {
    return this._promptRegistry;
  }

  getSkillManager(): SkillManager {
    return this.skillManager;
  }

  getResourceRegistry(): ResourceRegistry {
    return this._resourceRegistry;
  }

  getDebugMode(): boolean {
    return this.debugMode;
  }
  getQuestion(): string | undefined {
    return this.question;
  }

  getHasAccessToPreviewModel(): boolean {
    return this.hasAccessToPreviewModel !== false;
  }

  setHasAccessToPreviewModel(hasAccess: boolean | null): void {
    this.hasAccessToPreviewModel = hasAccess;
  }

  async refreshAvailableCredits(): Promise<void> {
    const codeAssistServer = getCodeAssistServer(this);
    if (!codeAssistServer) {
      return;
    }
    try {
      await codeAssistServer.refreshAvailableCredits();
    } catch {
      // Non-fatal: proceed even if refresh fails.
      // The actual credit balance will be verified server-side.
    }
  }

  async refreshUserQuota(): Promise<RetrieveUserQuotaResponse | undefined> {
    const codeAssistServer = getCodeAssistServer(this);
    if (!codeAssistServer || !codeAssistServer.projectId) {
      return undefined;
    }
    try {
      const quota = await codeAssistServer.retrieveUserQuota({
        project: codeAssistServer.projectId,
      });

      if (quota.buckets) {
        this.lastRetrievedQuota = quota;
        this.lastQuotaFetchTime = Date.now();

        for (const bucket of quota.buckets) {
          if (!bucket.modelId || bucket.remainingFraction == null) {
            continue;
          }

          let remaining: number;
          let limit: number;

          if (bucket.remainingAmount) {
            remaining = parseInt(bucket.remainingAmount, 10);
            limit =
              bucket.remainingFraction > 0
                ? Math.round(remaining / bucket.remainingFraction)
                : (this.modelQuotas.get(bucket.modelId)?.limit ?? 0);
          } else {
            // Server only sent remainingFraction — use a normalized scale.
            limit = 100;
            remaining = Math.round(bucket.remainingFraction * limit);
          }

          if (!isNaN(remaining) && Number.isFinite(limit) && limit > 0) {
            this.modelQuotas.set(bucket.modelId, {
              remaining,
              limit,
              resetTime: bucket.resetTime,
            });
          }
        }
        this.emitQuotaChangedEvent();
      }

      const hasAccess =
        quota.buckets?.some(
          (b) => b.modelId && isPreviewModel(b.modelId, this),
        ) ?? false;
      this.setHasAccessToPreviewModel(hasAccess);
      return quota;
    } catch (e) {
      debugLogger.debug('Failed to retrieve user quota', e);
      return undefined;
    }
  }

  async refreshUserQuotaIfStale(
    staleMs = 30_000,
  ): Promise<RetrieveUserQuotaResponse | undefined> {
    const now = Date.now();
    if (now - this.lastQuotaFetchTime > staleMs) {
      return this.refreshUserQuota();
    }
    return this.lastRetrievedQuota;
  }

  getLastRetrievedQuota(): RetrieveUserQuotaResponse | undefined {
    return this.lastRetrievedQuota;
  }

  getRemainingQuotaForModel(modelId: string):
    | {
        remainingAmount?: number;
        remainingFraction?: number;
        resetTime?: string;
      }
    | undefined {
    const bucket = this.lastRetrievedQuota?.buckets?.find(
      (b) => b.modelId === modelId,
    );
    if (!bucket) return undefined;

    return {
      remainingAmount: bucket.remainingAmount
        ? parseInt(bucket.remainingAmount, 10)
        : undefined,
      remainingFraction: bucket.remainingFraction,
      resetTime: bucket.resetTime,
    };
  }

  getCoreTools(): string[] | undefined {
    return this.coreTools;
  }

  getMainAgentTools(): string[] | undefined {
    return this.mainAgentTools;
  }

  getAllowedTools(): string[] | undefined {
    return this.allowedTools;
  }

  /**
   * All the excluded tools from static configuration, loaded extensions, or
   * other sources (like the Policy Engine).
   *
   * May change over time.
   */
  getExcludeTools(
    toolMetadata?: Map<string, Record<string, unknown>>,
    allToolNames?: Set<string>,
  ): Set<string> | undefined {
    // Right now this is present for backward compatibility with settings.json exclude
    const excludeToolsSet = new Set([...(this.excludeTools ?? [])]);
    for (const extension of this.getExtensionLoader().getExtensions()) {
      if (!extension.isActive) {
        continue;
      }
      for (const tool of extension.excludeTools || []) {
        excludeToolsSet.add(tool);
      }
    }

    const policyExclusions = this.policyEngine.getExcludedTools(
      toolMetadata,
      allToolNames,
    );
    for (const tool of policyExclusions) {
      excludeToolsSet.add(tool);
    }

    return excludeToolsSet;
  }

  getToolDiscoveryCommand(): string | undefined {
    return this.toolDiscoveryCommand;
  }

  getToolCallCommand(): string | undefined {
    return this.toolCallCommand;
  }

  getMcpServerCommand(): string | undefined {
    return this.mcpServerCommand;
  }

  /**
   * The user configured MCP servers (via gemini settings files).
   *
   * Does NOT include mcp servers configured by extensions.
   */
  getMcpServers(): Record<string, MCPServerConfig> | undefined {
    return this.mcpServers;
  }

  getMcpEnabled(): boolean {
    return this.mcpEnabled;
  }

  getMcpEnablementCallbacks(): McpEnablementCallbacks | undefined {
    return this.mcpEnablementCallbacks;
  }

  getExtensionsEnabled(): boolean {
    return this.extensionsEnabled;
  }

  getExtensionRegistryURI(): string | undefined {
    return this.extensionRegistryURI;
  }

  getMcpClientManager(): McpClientManager | undefined {
    return this.mcpClientManager;
  }

  getA2AClientManager(): A2AClientManager | undefined {
    return this.a2aClientManager;
  }

  setUserInteractedWithMcp(): void {
    this.mcpClientManager?.setUserInteractedWithMcp();
  }

  /** @deprecated Use getMcpClientManager().getLastError() directly */
  getLastMcpError(serverName: string): string | undefined {
    return this.mcpClientManager?.getLastError(serverName);
  }

  emitMcpDiagnostic(
    severity: 'info' | 'warning' | 'error',
    message: string,
    error?: unknown,
    serverName?: string,
  ): void {
    if (this.mcpClientManager) {
      this.mcpClientManager.emitDiagnostic(
        severity,
        message,
        error,
        serverName,
      );
    } else {
      coreEvents.emitFeedback(severity, message, error);
    }
  }

  getAllowedMcpServers(): string[] | undefined {
    return this.allowedMcpServers;
  }

  getBlockedMcpServers(): string[] | undefined {
    return this.blockedMcpServers;
  }

  get sanitizationConfig(): EnvironmentSanitizationConfig {
    return {
      allowedEnvironmentVariables: this.allowedEnvironmentVariables,
      blockedEnvironmentVariables: this.blockedEnvironmentVariables,
      enableEnvironmentVariableRedaction:
        this.enableEnvironmentVariableRedaction,
    };
  }

  setMcpServers(mcpServers: Record<string, MCPServerConfig>): void {
    this.mcpServers = mcpServers;
  }

  getUserMemory(): string | HierarchicalMemory {
    if (this.experimentalJitContext && this.memoryContextManager) {
      return {
        global: this.memoryContextManager.getGlobalMemory(),
        extension: this.memoryContextManager.getExtensionMemory(),
        project: this.memoryContextManager.getEnvironmentMemory(),
        userProjectMemory: this.memoryContextManager.getUserProjectMemory(),
      };
    }
    return this.userMemory;
  }

  /**
   * Refreshes the MCP context, including memory, tools, and system instructions.
   */
  async refreshMcpContext(): Promise<void> {
    if (this.experimentalJitContext && this.memoryContextManager) {
      await this.memoryContextManager.refresh();
    } else {
      const { refreshServerHierarchicalMemory } = await import(
        '../utils/memoryDiscovery.js'
      );
      await refreshServerHierarchicalMemory(this);
    }
    if (this._geminiClient?.isInitialized()) {
      await this._geminiClient.setTools();
      this._geminiClient.updateSystemInstruction();
    }
  }

  setUserMemory(newUserMemory: string | HierarchicalMemory): void {
    this.userMemory = newUserMemory;
  }

  /**
   * Returns memory for the system instruction.
   * When JIT is enabled, global memory and user project memory (Tier 1) go
   * in the system instruction. Extension and project memory (Tier 2) are
   * placed in the first user message instead, per the tiered context model.
   * User project memory is in Tier 1 so mid-session saves are reflected
   * via system instruction updates.
   */
  getSystemInstructionMemory(): string | HierarchicalMemory {
    if (this.experimentalJitContext && this.memoryContextManager) {
      const global = this.memoryContextManager.getGlobalMemory();
      const userProjectMemory =
        this.memoryContextManager.getUserProjectMemory();
      if (userProjectMemory?.trim()) {
        return { global, userProjectMemory };
      }
      return global;
    }
    return this.userMemory;
  }

  /**
   * Returns Tier 2 memory (extension + project) for injection into the first
   * user message when JIT is enabled. Returns empty string when JIT is
   * disabled (Tier 2 memory is already in the system instruction).
   */
  getSessionMemory(): string {
    if (!this.experimentalJitContext || !this.memoryContextManager) {
      return '';
    }
    const sections: string[] = [];
    const extension = this.memoryContextManager.getExtensionMemory();
    const project = this.memoryContextManager.getEnvironmentMemory();
    if (extension?.trim()) {
      sections.push(
        `<extension_context>\n${extension.trim()}\n</extension_context>`,
      );
    }
    if (project?.trim()) {
      sections.push(`<project_context>\n${project.trim()}\n</project_context>`);
    }
    if (sections.length === 0) return '';
    return `\n<loaded_context>\n${sections.join('\n')}\n</loaded_context>`;
  }

  getGlobalMemory(): string {
    return this.memoryContextManager?.getGlobalMemory() ?? '';
  }

  getEnvironmentMemory(): string {
    return this.memoryContextManager?.getEnvironmentMemory() ?? '';
  }

  getMemoryContextManager(): MemoryContextManager | undefined {
    return this.memoryContextManager;
  }

  isJitContextEnabled(): boolean {
    return this.experimentalJitContext;
  }

  isContextManagementEnabled(): boolean {
    return this.contextManagement.enabled;
  }

  getMemoryBoundaryMarkers(): readonly string[] {
    return this.memoryBoundaryMarkers;
  }

  isMemoryV2Enabled(): boolean {
    return this.experimentalMemoryV2;
  }

  isAutoMemoryEnabled(): boolean {
    return this.experimentalAutoMemory;
  }

  getExperimentalGemma(): boolean {
    return this.experimentalGemma;
  }

  getExperimentalContextManagementConfig(): string | undefined {
    return this.experimentalContextManagementConfig;
  }

  getContextManagementConfig(): ContextManagementConfig {
    return this.contextManagement;
  }

  get agentHistoryProviderConfig(): AgentHistoryProviderConfig {
    return {
      maxTokens: this.contextManagement.historyWindow.maxTokens,
      retainedTokens: this.contextManagement.historyWindow.retainedTokens,
      normalMessageTokens: this.contextManagement.messageLimits.normalMaxTokens,
      maximumMessageTokens:
        this.contextManagement.messageLimits.retainedMaxTokens,
      normalizationHeadRatio:
        this.contextManagement.messageLimits.normalizationHeadRatio,
    };
  }

  isTopicUpdateNarrationEnabled(): boolean {
    return this.topicUpdateNarration;
  }

  isModelSteeringEnabled(): boolean {
    return this.modelSteering;
  }

  async getToolOutputMaskingConfig(): Promise<ToolOutputMaskingConfig> {
    // --- LOCAL FORK ADDITION (Phase 2.0) ---
    // In local mode, scale masking thresholds to the local context window so
    // the existing ToolOutputMaskingService actually engages. Cloud defaults
    // (50K protection + 30K prunable) are larger than most local windows.
    if (this.isLocalMode() && this.localToolOutputMaskingEnabled) {
      return getLocalMaskingDefaults(this);
    }

    await this.ensureExperimentsLoaded();

    const remoteProtection =
      this.experiments?.flags[ExperimentFlags.MASKING_PROTECTION_THRESHOLD]
        ?.intValue;
    const remotePrunable =
      this.experiments?.flags[ExperimentFlags.MASKING_PRUNABLE_THRESHOLD]
        ?.intValue;
    const remoteProtectLatest =
      this.experiments?.flags[ExperimentFlags.MASKING_PROTECT_LATEST_TURN]
        ?.boolValue;

    const parsedProtection = remoteProtection
      ? parseInt(remoteProtection, 10)
      : undefined;
    const parsedPrunable = remotePrunable
      ? parseInt(remotePrunable, 10)
      : undefined;

    return {
      protectionThresholdTokens:
        parsedProtection !== undefined && !isNaN(parsedProtection)
          ? parsedProtection
          : this.contextManagement.tools.outputMasking
              .protectionThresholdTokens,
      minPrunableThresholdTokens:
        parsedPrunable !== undefined && !isNaN(parsedPrunable)
          ? parsedPrunable
          : this.contextManagement.tools.outputMasking
              .minPrunableThresholdTokens,
      protectLatestTurn:
        remoteProtectLatest ??
        this.contextManagement.tools.outputMasking.protectLatestTurn,
    };
  }

  getGeminiMdFileCount(): number {
    if (this.experimentalJitContext && this.memoryContextManager) {
      return this.memoryContextManager.getLoadedPaths().size;
    }
    return this.geminiMdFileCount;
  }

  setGeminiMdFileCount(count: number): void {
    this.geminiMdFileCount = count;
  }

  getGeminiMdFilePaths(): string[] {
    if (this.experimentalJitContext && this.memoryContextManager) {
      return Array.from(this.memoryContextManager.getLoadedPaths());
    }
    return this.geminiMdFilePaths;
  }

  getWorkspacePoliciesDir(): string | undefined {
    return this.workspacePoliciesDir;
  }

  setGeminiMdFilePaths(paths: string[]): void {
    this.geminiMdFilePaths = paths;
  }

  getApprovalMode(): ApprovalMode {
    return this.policyEngine.getApprovalMode();
  }

  isPlanMode(): boolean {
    return this.getApprovalMode() === ApprovalMode.PLAN;
  }

  getPolicyUpdateConfirmationRequest():
    | PolicyUpdateConfirmationRequest
    | undefined {
    return this.policyUpdateConfirmationRequest;
  }

  /**
   * Hot-loads workspace policies from the specified directory into the active policy engine.
   * This allows applying newly accepted policies without requiring an application restart.
   *
   * @param policyDir The directory containing the workspace policy TOML files.
   */
  async loadWorkspacePolicies(policyDir: string): Promise<void> {
    const { rules, checkers } = await loadPoliciesFromToml(
      [policyDir],
      () => WORKSPACE_POLICY_TIER,
    );

    // Clear existing workspace policies to prevent duplicates/stale rules
    this.policyEngine.removeRulesByTier(WORKSPACE_POLICY_TIER);
    this.policyEngine.removeCheckersByTier(WORKSPACE_POLICY_TIER);

    for (const rule of rules) {
      this.policyEngine.addRule(rule);
    }

    for (const checker of checkers) {
      this.policyEngine.addChecker(checker);
    }

    this.policyUpdateConfirmationRequest = undefined;

    debugLogger.debug(`Workspace policies loaded from: ${policyDir}`);
  }

  setApprovalMode(mode: ApprovalMode): void {
    if (
      !this.isTrustedFolder() &&
      mode !== ApprovalMode.DEFAULT &&
      mode !== ApprovalMode.PLAN
    ) {
      throw new Error(
        'Cannot enable privileged approval modes in an untrusted folder.',
      );
    }

    const currentMode = this.getApprovalMode();
    if (currentMode !== mode) {
      this.logCurrentModeDuration(currentMode);
      logApprovalModeSwitch(
        this,
        new ApprovalModeSwitchEvent(currentMode, mode),
      );

      this.policyEngine.setApprovalMode(mode);
      this.refreshSandboxManager();
      coreEvents.emit(CoreEvent.ApprovalModeChanged, {
        sessionId: this.getSessionId(),
        mode,
      });

      const isPlanModeTransition =
        currentMode === ApprovalMode.PLAN || mode === ApprovalMode.PLAN;
      const isYoloModeTransition =
        currentMode === ApprovalMode.YOLO || mode === ApprovalMode.YOLO;

      if (isPlanModeTransition || isYoloModeTransition) {
        if (this._geminiClient?.isInitialized()) {
          this._geminiClient.clearCurrentSequenceModel();
          this._geminiClient.setTools().catch((err) => {
            debugLogger.error('Failed to update tools', err);
          });
        }
        this.updateSystemInstructionIfInitialized();
      }
    }
  }

  /**
   * Logs the duration of the current approval mode.
   */
  logCurrentModeDuration(mode: ApprovalMode): void {
    const now = performance.now();
    const duration = now - this.lastModeSwitchTime;
    if (duration > 0) {
      logApprovalModeDuration(
        this,
        new ApprovalModeDurationEvent(mode, duration),
      );
    }
    this.lastModeSwitchTime = now;
  }

  isYoloModeDisabled(): boolean {
    return this.disableYoloMode || !this.isTrustedFolder();
  }

  getDisableAlwaysAllow(): boolean {
    return this.disableAlwaysAllow;
  }

  getRawOutput(): boolean {
    return this.rawOutput;
  }

  getAcceptRawOutputRisk(): boolean {
    return this.acceptRawOutputRisk;
  }

  getExperimentalDynamicModelConfiguration(): boolean {
    return this.dynamicModelConfiguration;
  }

  getPendingIncludeDirectories(): string[] {
    return this.pendingIncludeDirectories;
  }

  clearPendingIncludeDirectories(): void {
    this.pendingIncludeDirectories = [];
  }

  getShowMemoryUsage(): boolean {
    return this.showMemoryUsage;
  }

  getAccessibility(): AccessibilitySettings {
    return this.accessibility;
  }

  getTelemetryEnabled(): boolean {
    return this.telemetrySettings.enabled ?? false;
  }

  getTelemetryTracesEnabled(): boolean {
    return this.telemetrySettings.traces ?? false;
  }

  getTelemetryLogPromptsEnabled(): boolean {
    return this.telemetrySettings.logPrompts ?? true;
  }

  getTelemetryOtlpEndpoint(): string {
    return this.telemetrySettings.otlpEndpoint ?? DEFAULT_OTLP_ENDPOINT;
  }

  getTelemetryOtlpProtocol(): 'grpc' | 'http' {
    return this.telemetrySettings.otlpProtocol ?? 'grpc';
  }

  getTelemetryTarget(): TelemetryTarget {
    return this.telemetrySettings.target ?? DEFAULT_TELEMETRY_TARGET;
  }

  getTelemetryOutfile(): string | undefined {
    return this.telemetrySettings.outfile;
  }

  getBillingSettings(): { overageStrategy: OverageStrategy } {
    return this.billing;
  }

  /**
   * Updates the overage strategy at runtime.
   * Used to switch from 'ask' to 'always' after the user accepts credits
   * via the overage dialog, so subsequent API calls auto-include credits.
   */
  setOverageStrategy(strategy: OverageStrategy): void {
    this.billing.overageStrategy = strategy;
  }

  getTelemetryUseCollector(): boolean {
    return this.telemetrySettings.useCollector ?? false;
  }

  getTelemetryUseCliAuth(): boolean {
    return this.telemetrySettings.useCliAuth ?? false;
  }

  /** @deprecated Use geminiClient getter */
  getGeminiClient(): GeminiClient {
    return this.geminiClient;
  }

  /**
   * Updates the system instruction with the latest user memory.
   * Whenever the user memory (GEMINI.md files) is updated.
   */
  updateSystemInstructionIfInitialized(): void {
    const geminiClient = this.geminiClient;
    if (geminiClient?.isInitialized()) {
      geminiClient.updateSystemInstruction();
    }
  }

  getModelRouterService(): ModelRouterService {
    return this.modelRouterService;
  }

  getModelConfigService(): ModelConfigService {
    return this.modelConfigService;
  }

  getModelAvailabilityService(): ModelAvailabilityService {
    return this.modelAvailabilityService;
  }

  getEnableRecursiveFileSearch(): boolean {
    return this.fileFiltering.enableRecursiveFileSearch;
  }

  getFileFilteringEnableFuzzySearch(): boolean {
    return this.fileFiltering.enableFuzzySearch;
  }

  getFileFilteringRespectGitIgnore(): boolean {
    return this.fileFiltering.respectGitIgnore;
  }

  getFileFilteringRespectGeminiIgnore(): boolean {
    return this.fileFiltering.respectGeminiIgnore;
  }

  getCustomIgnoreFilePaths(): string[] {
    return this.fileFiltering.customIgnoreFilePaths;
  }

  getFileFilteringOptions(): FileFilteringOptions {
    return {
      respectGitIgnore: this.fileFiltering.respectGitIgnore,
      respectGeminiIgnore: this.fileFiltering.respectGeminiIgnore,
      enableFileWatcher: this.fileFiltering.enableFileWatcher,
      maxFileCount: this.fileFiltering.maxFileCount,
      searchTimeout: this.fileFiltering.searchTimeout,
      customIgnoreFilePaths: this.fileFiltering.customIgnoreFilePaths,
    };
  }

  /**
   * Gets custom file exclusion patterns from configuration.
   * TODO: This is a placeholder implementation. In the future, this could
   * read from settings files, CLI arguments, or environment variables.
   */
  getCustomExcludes(): string[] {
    // Placeholder implementation - returns empty array for now
    // Future implementation could read from:
    // - User settings file
    // - Project-specific configuration
    // - Environment variables
    // - CLI arguments
    return [];
  }

  getCheckpointingEnabled(): boolean {
    return this.checkpointing;
  }

  getProxy(): string | undefined {
    return this.proxy;
  }

  // --- LOCAL FORK ADDITION (Phase 2.2: unified provider resolver) ---
  /**
   * Resolves the active provider entry into a single concrete shape that
   * downstream code can consume without caring whether the user picked
   * `local-vllm`, `openai`, `gemini-oauth`, or any other registry id.
   *
   * Inputs:
   *   - `providers.active`           — the active provider id.
   *   - `providers.<id>.*`           — per-instance overrides (merged on
   *                                    top of registry defaults).
   *   - `local.*`                    — legacy fields, only consulted as a
   *                                    one-shot safety net when migration
   *                                    has not yet been run on disk (the
   *                                    PR ships migration alongside this
   *                                    rename, so this fallback effectively
   *                                    fires only on the very first launch
   *                                    after upgrading).
   *
   * Output fields:
   *   - `wireFormat` — `'openai-chat'` (we own the wire, dispatch through
   *                    OpenAICompatContentGenerator) or `'gemini'`
   *                    (dispatch through upstream googleGenAI).
   *   - `authType`   — the AuthType this entry maps to. `refreshAuth()`
   *                    and `/provider use` consult this directly so
   *                    `/provider use gemini-oauth` triggers the same
   *                    flow as `/auth → LOGIN_WITH_GOOGLE`.
   *   - `displayName` / `providerId` — for UI display.
   *   - `requiresApiKey` / `apiKeyEnvVar` — drive the credential resolver
   *                    and the dialog's API-key row visibility.
   *   - `url` / `model` / `contextLimit` / `promptMode` / `parserMode`
   *     / `timeout` / `enableTools` — used by OpenAI-compat callers.
   *     For `wireFormat: 'gemini'`, only `model` and `contextLimit` are
   *     meaningful; the rest carry sane defaults that are simply unused
   *     by the upstream Gemini SDK path.
   *
   * The apiKey is intentionally NOT resolved here (it's async, and
   * reading the keychain on every getLocalModel() call would be a perf
   * disaster). `createContentGenerator` resolves it once per
   * generator-build via `resolveProviderApiKey()` and threads it in.
   *
   * Returns `undefined` when no provider is configured AND no legacy
   * `local.url` is set — i.e. the user has not configured any backend
   * and should be sent to the auth dialog.
   */
  getEffectiveProviderConfig():
    | {
        url: string;
        model: string;
        contextLimit: number;
        promptMode: string;
        parserMode: 'strict' | 'lenient' | 'loose';
        timeout: number;
        enableTools: boolean;
        displayName: string;
        providerId: string;
        requiresApiKey: boolean;
        apiKeyEnvVar: string;
        wireFormat: 'openai-chat' | 'gemini' | 'anthropic-messages';
        authType: AuthType;
      }
    | undefined {
    if (this.providersActive) {
      try {
        const r = resolveProvider(
          this.providersActive,
          this.providersConfig[this.providersActive],
          this.providersCustom,
        );
        return {
          url: r.baseUrl,
          // Local presets ship with defaultModel='' so the server can pick;
          // surface 'local-model' as the historical placeholder so generator
          // request bodies always have a non-empty `model` field.
          model: r.model || 'local-model',
          contextLimit: r.contextLimit,
          promptMode: r.promptMode,
          parserMode: this.localToolCallParseMode,
          timeout: r.timeout,
          enableTools: r.enableTools,
          displayName: r.definition.displayName,
          providerId: r.definition.id,
          requiresApiKey: r.definition.requiresApiKey,
          apiKeyEnvVar: r.definition.apiKeyEnvVar,
          wireFormat: r.definition.wireFormat,
          authType: r.definition.authType,
        };
      } catch {
        // resolveProvider throws on malformed config or unknown id;
        // swallow and fall through to the legacy-local safety net so the
        // user isn't locked out of their existing setup mid-upgrade.
        // createContentGenerator surfaces the actionable error separately
        // when it tries to build a request against a malformed provider.
      }
    }
    // One-shot legacy-local safety net: only fires before the on-disk
    // migration writes `providers.active = 'local-vllm'`. Post-migration
    // this branch is dead code; it stays for the duration of one upgrade
    // cycle so a user who launches once and panics doesn't hit "no LLM
    // configured" if migration write fails for any reason.
    if (this.localUrl) {
      return {
        url: this.localUrl,
        model: this.localModelOverride ?? this.localModel ?? 'local-model',
        contextLimit: this.getLegacyLocalContextLimit(),
        promptMode: this.localPromptMode,
        parserMode: this.localToolCallParseMode,
        timeout: this.localTimeout,
        enableTools: this.localEnableTools,
        displayName: 'Local vLLM',
        // Treat the legacy fallback as if `local-vllm` was selected so
        // the rest of the stack (UI, dispatcher, credential resolver)
        // sees a uniform shape.
        providerId: 'local-vllm',
        requiresApiKey: false,
        apiKeyEnvVar: '',
        wireFormat: 'openai-chat',
        authType: AuthType.LOCAL,
      };
    }
    return undefined;
  }

  /**
   * Pre-Phase 2.2 logic for `getLocalContextLimit()`, kept on its own so
   * `getEffectiveProviderConfig()` can call it for the legacy-local
   * fallback without recursing through `getLocalContextLimit()`.
   */
  private getLegacyLocalContextLimit(): number {
    if (this.localContextLimit !== undefined) {
      return this.localContextLimit;
    }
    const activeModel =
      this.localModelOverride ?? this.localModel ?? 'local-model';
    const discovered = this.discoveredLocalModels.find(
      (m) => m.localId === activeModel || m.id === activeModel,
    );
    if (discovered?.maxModelLen) {
      return discovered.maxModelLen;
    }
    return 32768;
  }
  // --- END LOCAL FORK ADDITION ---

  getLocalUrl(): string | undefined {
    // Provider-mode URL wins when configured. Falls back to the raw
    // localUrl field for legacy users who haven't migrated to /provider.
    return this.getEffectiveProviderConfig()?.url ?? this.localUrl;
  }

  getLocalModel(): string {
    // Same delegation pattern as getLocalUrl(). The historical fallback
    // chain (localModelOverride → localModel → 'local-model') is preserved
    // inside getEffectiveProviderConfig() for the legacy-local fallback.
    return (
      this.getEffectiveProviderConfig()?.model ??
      this.localModelOverride ??
      this.localModel ??
      'local-model'
    );
  }

  getLocalTimeout(): number {
    return this.localTimeout;
  }

  /**
   * True when the runtime should route requests through our OpenAI-compat
   * generator — i.e. the active provider declares `wireFormat:
   * 'openai-chat'` (local-vllm, openai, ...) OR a legacy `local.url` is
   * still set on disk.
   *
   * Returns false for `wireFormat: 'gemini'` entries even though they
   * also flow through `providers.active` — the upstream Google GenAI
   * SDK owns those wires, not us.
   */
  isLocalMode(): boolean {
    if (this.providersActive) {
      const eff = this.getEffectiveProviderConfig();
      // Unknown / malformed provider id → fall back to "true" so the
      // legacy-local synthetic shape inside getEffectiveProviderConfig()
      // takes over and a misconfigured user isn't locked out.
      if (!eff) return !!this.localUrl;
      return eff.wireFormat === 'openai-chat';
    }
    return !!this.localUrl;
  }

  isLocalToolsEnabled(): boolean {
    return (
      this.getEffectiveProviderConfig()?.enableTools ?? this.localEnableTools
    );
  }

  getLocalPromptMode(): string {
    return (
      this.getEffectiveProviderConfig()?.promptMode ?? this.localPromptMode
    );
  }

  // --- LOCAL FORK ADDITION (Phase 2.0.12) ---
  /**
   * Returns the active tool-call parser mode for content-side fallback
   * recovery. See Phase 2.0.12 notes / parseXmlToolCalls in
   * localLlmContentGenerator.ts for the meaning of each mode.
   */
  getLocalToolCallParseMode(): 'strict' | 'lenient' | 'loose' {
    return this.localToolCallParseMode;
  }
  // --- END LOCAL FORK ADDITION ---

  // --- LOCAL FORK ADDITION (Phase 2.0.13) ---
  /**
   * Returns the temperature to send to the local LLM, or null if unset
   * (meaning vLLM will use the model's generation_config.json default).
   *
   * Configured via `local.temperature` in settings.json or the
   * GEMINI_LOCAL_TEMPERATURE env var.  Valid range: 0 – 2.
   */
  getLocalTemperature(): number | null {
    return this.localTemperature;
  }
  // --- END LOCAL FORK ADDITION ---

  // --- LOCAL FORK ADDITION (Phase 2.0.14) ---
  /**
   * Nucleus sampling cutoff. Returns null when unset (server uses its default).
   * Configured via `local.topP` in settings.json or GEMINI_LOCAL_TOP_P env var.
   * Valid range: (0, 1]. Z.ai recommends 1.0 for GLM-4.7-Flash tool-calling.
   */
  getLocalTopP(): number | null {
    return this.localTopP;
  }

  /**
   * Top-k sampling cutoff. Returns null when unset (server uses its default).
   * Configured via `local.topK` in settings.json or GEMINI_LOCAL_TOP_K env var.
   * vLLM accepts -1 to disable, or any positive integer.
   */
  getLocalTopK(): number | null {
    return this.localTopK;
  }

  /**
   * Min-p sampling floor. Returns null when unset (server uses its default).
   * Configured via `local.minP` in settings.json or GEMINI_LOCAL_MIN_P env var.
   * Valid range: [0, 1]. Z.ai recommends 0.01 for GLM-4.7-Flash.
   */
  getLocalMinP(): number | null {
    return this.localMinP;
  }

  /**
   * Repetition penalty multiplier. Returns null when unset (server default).
   * Configured via `local.repetitionPenalty` or GEMINI_LOCAL_REPETITION_PENALTY.
   * Valid range: (0, 2]. 1.0 disables. Z.ai recommends 1.0 for GLM-4.7-Flash.
   */
  getLocalRepetitionPenalty(): number | null {
    return this.localRepetitionPenalty;
  }
  // --- END LOCAL FORK ADDITION ---

  getLocalContextLimit(): number {
    // --- LOCAL FORK ADDITION (Phase 2.2) ---
    // When a provider is explicitly active, its registry/override
    // contextLimit wins. The legacy `local.contextLimit` + maxModelLen
    // discovery fallback only applies on the one-shot legacy-local path
    // (no providers.active), where we don't have a registry default.
    if (this.providersActive) {
      const eff = this.getEffectiveProviderConfig();
      if (eff) return eff.contextLimit;
    }
    // --- END LOCAL FORK ADDITION ---
    return this.getLegacyLocalContextLimit();
  }

  getDiscoveredLocalModels(): LocalModelInfo[] {
    return this.discoveredLocalModels;
  }

  setDiscoveredLocalModels(models: LocalModelInfo[]): void {
    this.discoveredLocalModels = models;
  }

  getGeneratorSwapPromise(): Promise<void> | null {
    return this.generatorSwapPromise;
  }

  setGeneratorSwapPromise(p: Promise<void> | null): void {
    this.generatorSwapPromise = p;
  }

  setLocalModelOverride(model: string): void {
    this.localModelOverride = model;
  }

  // --- LOCAL FORK ADDITION (Phase 2.0.2) ---
  /**
   * Hot-reloads the live local LLM configuration without requiring a CLI
   * restart. Updates the cached fields and rebuilds the ContentGenerator via
   * refreshAuth(LOCAL) so subsequent turns use the new endpoint/model/prompt.
   *
   * Pass only the fields you want to change; undefined fields are left alone.
   *
   * Throws if refreshAuth fails (e.g. unreachable URL); callers should catch
   * and surface the error to the user. On failure the field updates are
   * preserved so the user can see and correct the bad value in /local.
   */
  async refreshLocalConfig(updates: {
    url?: string;
    model?: string;
    promptMode?: string;
    timeout?: number;
    // --- LOCAL FORK ADDITION (Phase 2.0.12) ---
    toolCallParseMode?: string;
    // --- END LOCAL FORK ADDITION ---
    // --- LOCAL FORK ADDITION (Phase 2.0.13) ---
    temperature?: number | null;
    // --- END LOCAL FORK ADDITION ---
    // --- LOCAL FORK ADDITION (Phase 2.0.14) ---
    topP?: number | null;
    topK?: number | null;
    minP?: number | null;
    repetitionPenalty?: number | null;
    // --- END LOCAL FORK ADDITION ---
  }): Promise<void> {
    if (updates.url !== undefined) this.localUrl = updates.url;
    if (updates.model !== undefined) this.localModel = updates.model;
    if (updates.promptMode !== undefined)
      this.localPromptMode = updates.promptMode;
    // --- LOCAL FORK ADDITION (Phase 2.0.6) ---
    // timeout does not require a ContentGenerator rebuild — fetchWithTimeout
    // reads this.config.getLocalTimeout() on every request, so updating the
    // field is sufficient. We intentionally skip refreshAuth() here.
    if (updates.timeout !== undefined) this.localTimeout = updates.timeout;
    // --- END LOCAL FORK ADDITION ---
    // --- LOCAL FORK ADDITION (Phase 2.0.12) ---
    // toolCallParseMode also does not require a ContentGenerator rebuild —
    // parseXmlToolCalls reads this.config.getLocalToolCallParseMode() on
    // every response. Validate the input; silently keep the existing value
    // on invalid input rather than corrupting the field.
    if (updates.toolCallParseMode !== undefined) {
      const v = updates.toolCallParseMode;
      if (v === 'strict' || v === 'lenient' || v === 'loose') {
        this.localToolCallParseMode = v;
      }
    }
    // --- END LOCAL FORK ADDITION ---
    // --- LOCAL FORK ADDITION (Phase 2.0.13) ---
    // temperature does not require a ContentGenerator rebuild — request bodies
    // read this.config.getLocalTemperature() on every call.
    // null explicitly clears back to "server decides".
    if (updates.temperature !== undefined)
      this.localTemperature = updates.temperature;
    // --- END LOCAL FORK ADDITION ---
    // --- LOCAL FORK ADDITION (Phase 2.0.14) ---
    // Same hot-reload semantics as temperature: no ContentGenerator rebuild,
    // request bodies read these on every call. null clears to server default.
    if (updates.topP !== undefined) this.localTopP = updates.topP;
    if (updates.topK !== undefined) this.localTopK = updates.topK;
    if (updates.minP !== undefined) this.localMinP = updates.minP;
    if (updates.repetitionPenalty !== undefined)
      this.localRepetitionPenalty = updates.repetitionPenalty;
    // --- END LOCAL FORK ADDITION ---
    if (
      this.isLocalMode() &&
      (updates.url !== undefined ||
        updates.model !== undefined ||
        updates.promptMode !== undefined)
    ) {
      await this.refreshAuth(AuthType.LOCAL);
    }
  }
  // --- END LOCAL FORK ADDITION ---

  // --- LOCAL FORK ADDITION (Phase 2.1) ---
  /**
   * Returns the id of the currently active hosted provider, or undefined
   * if none is configured. The id is what `providers.active` resolves to
   * (env var GEMINI_PROVIDER wins over settings.json).
   */
  getActiveProviderId(): string | undefined {
    return this.providersActive;
  }

  /**
   * Returns the user-supplied per-instance overrides for `providerId`,
   * or undefined if no overrides exist. Returns the live object — do not
   * mutate it from outside `refreshProviderConfig`.
   */
  getProviderConfig(providerId: string): ProviderInstanceConfig | undefined {
    return this.providersConfig[providerId];
  }

  /**
   * Returns ALL configured per-provider overrides. Used by `/provider list`
   * to mark which providers have user-customized settings beyond the
   * registry default.
   */
  getAllProviderConfigs(): Readonly<Record<string, ProviderInstanceConfig>> {
    return this.providersConfig;
  }

  /**
   * Resolves the active provider into a `ResolvedProvider` (registry
   * default merged with the user override). Throws
   * `UnknownProviderError` if `providers.active` references an id not in
   * the registry, or `InvalidProviderConfigError` if the override is
   * malformed. Returns undefined when no active provider is configured.
   */
  getActiveProviderResolved(): ResolvedProvider | undefined {
    if (!this.providersActive) return undefined;
    return resolveProvider(
      this.providersActive,
      this.providersConfig[this.providersActive],
      this.providersCustom,
    );
  }

  // --- LOCAL FORK ADDITION (Phase 2.3) ---
  /**
   * Returns the merged effective registry — frozen built-ins plus the
   * user's custom providers from settings — keyed by id. This is the
   * single source of truth for "what providers are visible right now"
   * across `/provider list`, the `ProviderDialog` menu, and the
   * `useAuth` hook. Pure: returns a fresh object on every call.
   */
  getProviderRegistry(): Record<string, ProviderDefinition> {
    return effectiveRegistry(this.providersCustom);
  }

  /**
   * Returns the user's custom provider entries (as stored in
   * `settings.providers.custom.*`), keyed by id. Returns the live object
   * — do not mutate it from outside `addCustomProvider` /
   * `removeCustomProvider`.
   */
  getCustomProviders(): Readonly<Record<string, CustomProviderDefinition>> {
    return this.providersCustom;
  }

  /**
   * Adds a new user-defined OpenAI-compat provider. Throws if the id is
   * malformed, collides with a built-in, or is already defined as a
   * custom entry. Persists to `this.providersCustom` only — the caller
   * (slash command or dialog) is responsible for writing the settings
   * file. Does NOT switch to the new provider; call
   * `refreshProviderConfig({ active: id })` separately if desired.
   */
  addCustomProvider(id: string, def: CustomProviderDefinition): void {
    const idError = validateCustomProviderId(id);
    if (idError) {
      throw new Error(idError);
    }
    if (id in this.providersCustom) {
      throw new Error(
        `Custom provider '${id}' already exists. Use /provider remove ${id} first, or pick a different id.`,
      );
    }
    if (!def.baseUrl || typeof def.baseUrl !== 'string') {
      throw new Error('baseUrl is required and must be a string.');
    }
    try {
      const u = new URL(def.baseUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Error('baseUrl must use http:// or https://');
      }
    } catch {
      throw new Error(`baseUrl '${def.baseUrl}' is not a valid URL.`);
    }
    if (
      def.apiKeyEnvVar !== undefined &&
      def.apiKeyEnvVar !== '' &&
      !/^[A-Z][A-Z0-9_]*$/.test(def.apiKeyEnvVar)
    ) {
      throw new Error(
        `apiKeyEnvVar '${def.apiKeyEnvVar}' must be uppercase letters, digits, and underscores (e.g. 'GROQ_API_KEY').`,
      );
    }
    this.providersCustom = { ...this.providersCustom, [id]: { ...def } };
  }

  /**
   * Removes a user-defined custom provider. Throws if the id refers to a
   * built-in (those cannot be removed) or to an unknown id. Persists to
   * `this.providersCustom` only. The caller is responsible for writing
   * the settings file and (optionally) clearing the keychain entry.
   *
   * If the removed id is the currently active provider, the active id
   * is cleared so the next `refreshProviderConfig` falls back to a safe
   * default (`gemini-oauth`).
   */
  removeCustomProvider(id: string): void {
    if (id in this.providersCustom === false) {
      throw new Error(
        `'${id}' is not a custom provider. Built-in providers cannot be removed; see /provider list for the available set.`,
      );
    }
    const next = { ...this.providersCustom };
    delete next[id];
    this.providersCustom = next;
    // Drop any stale per-instance overrides for the removed entry so
    // re-adding the same id later doesn't pick up zombie config.
    if (this.providersConfig[id]) {
      const nextCfg = { ...this.providersConfig };
      delete nextCfg[id];
      this.providersConfig = nextCfg;
    }
    if (this.providersActive === id) {
      this.providersActive = undefined;
    }
  }
  // --- END LOCAL FORK ADDITION ---

  /**
   * True when the current auth path should use a hosted provider — i.e.
   * `providers.active` is set AND we're not currently in local mode.
   * Note: this does NOT check the live AuthType; callers that need to
   * distinguish "configured" from "currently routing through" should
   * inspect both this and `getContentGeneratorConfig().authType`.
   */
  isProviderMode(): boolean {
    return !!this.providersActive && !this.isLocalMode();
  }

  /**
   * Hot-reloads the hosted-provider configuration without requiring a
   * CLI restart. Mirrors {@link refreshLocalConfig}: pass only the
   * fields you want to change; undefined fields are left alone.
   *
   * Behavior:
   * - `active` switches the live provider id. When provided AND auth
   *   mode is currently PROVIDER, triggers `refreshAuth(PROVIDER)` to
   *   rebuild the ContentGenerator against the new provider.
   * - `setConfig` shallow-merges per-provider overrides onto the
   *   existing entry. To clear an override pass an explicit `undefined`
   *   for the field on a fresh object.
   * - `removeProvider` deletes both the per-instance config and (best
   *   effort) the keychain entry. The keychain side is fire-and-forget
   *   so a missing entry does not block the settings update.
   *
   * Throws on refresh failure (e.g. unknown provider id, missing key);
   * callers must catch and surface the error to the user. Field updates
   * are preserved on failure so the user can correct them in /provider.
   */
  async refreshProviderConfig(updates: {
    active?: string | null;
    setConfig?: { id: string; patch: ProviderInstanceConfig };
    removeProvider?: string;
  }): Promise<void> {
    let activeChanged = false;
    if (updates.active !== undefined) {
      const next = updates.active === null ? undefined : updates.active.trim();
      if (next !== this.providersActive) {
        this.providersActive = next || undefined;
        activeChanged = true;
      }
    }
    if (updates.setConfig) {
      const id = updates.setConfig.id;
      const existing = this.providersConfig[id] ?? {};
      this.providersConfig[id] = { ...existing, ...updates.setConfig.patch };
    }
    if (updates.removeProvider) {
      delete this.providersConfig[updates.removeProvider];
      // The keychain side is best-effort. Imported lazily to keep the
      // Config module free of credential-storage init at construction.
      try {
        const mod = await import('../providers/providerCredentialStorage.js');
        await mod.clearProviderApiKey(updates.removeProvider);
      } catch {
        // Already warn-logged inside clearProviderApiKey.
      }
      if (this.providersActive === updates.removeProvider) {
        this.providersActive = undefined;
        activeChanged = true;
      }
    }
    // --- LOCAL FORK ADDITION (Phase 2.2: rebuild on any provider change) ---
    // Trigger a generator rebuild whenever something user-visible
    // changed. Phase 2.2 unified the auth path: refreshAuth() consults
    // the active provider's registry-declared authType and dispatches to
    // the right backend (LOCAL for openai-chat, LOGIN_WITH_GOOGLE /
    // USE_GEMINI / USE_VERTEX_AI for gemini-*), so we no longer need the
    // pre-2.2 `authType === LOCAL` guard. Passing AuthType.LOCAL is just
    // a default — refreshAuth() will redispatch when needed.
    //
    // We still skip the rebuild when an unrelated provider's setConfig
    // is being saved (e.g. user is editing the openai entry but
    // gemini-oauth is active) — that change doesn't affect the live
    // wire and avoids gratuitous re-auths.
    const setConfigAffectsActive =
      !!updates.setConfig && updates.setConfig.id === this.providersActive;
    if (activeChanged || setConfigAffectsActive) {
      await this.refreshAuth(AuthType.LOCAL);
    }
    // --- END LOCAL FORK ADDITION ---
  }
  // --- END LOCAL FORK ADDITION ---

  getWorkingDir(): string {
    return this.cwd;
  }

  getBugCommand(): BugCommandSettings | undefined {
    return this.bugCommand;
  }

  getTrackerService(): TrackerService {
    if (!this.trackerService) {
      this.trackerService = new TrackerService(
        this.storage.getProjectTempTrackerDir(),
      );
    }
    return this.trackerService;
  }

  getFileService(): FileDiscoveryService {
    if (!this.fileDiscoveryService) {
      this.fileDiscoveryService = new FileDiscoveryService(this.targetDir, {
        respectGitIgnore: this.fileFiltering.respectGitIgnore,
        respectGeminiIgnore: this.fileFiltering.respectGeminiIgnore,
        customIgnoreFilePaths: this.fileFiltering.customIgnoreFilePaths,
      });
    }
    return this.fileDiscoveryService;
  }

  getUsageStatisticsEnabled(): boolean {
    return this.usageStatisticsEnabled;
  }

  getAcpMode(): boolean {
    return this.acpMode;
  }

  async waitForMcpInit(): Promise<void> {
    if (this.mcpInitializationPromise) {
      await this.mcpInitializationPromise;
    }
  }

  getListExtensions(): boolean {
    return this.listExtensions;
  }

  getListSessions(): boolean {
    return this.listSessions;
  }

  getDeleteSession(): string | undefined {
    return this.deleteSession;
  }

  getExtensionManagement(): boolean {
    return this.extensionManagement;
  }

  getExtensions(): GeminiCLIExtension[] {
    return this._extensionLoader.getExtensions();
  }

  getExtensionLoader(): ExtensionLoader {
    return this._extensionLoader;
  }

  // The list of explicitly enabled extensions, if any were given, may contain
  // the string "none".
  getEnabledExtensions(): string[] {
    return this._enabledExtensions;
  }

  getEnableExtensionReloading(): boolean {
    return this.enableExtensionReloading;
  }

  getDisableLLMCorrection(): boolean {
    return this.disableLLMCorrection;
  }

  isPlanEnabled(): boolean {
    return this.planEnabled;
  }

  isVoiceModeEnabled(): boolean {
    return this.voiceMode;
  }

  isTrackerEnabled(): boolean {
    return this.trackerEnabled;
  }

  getApprovedPlanPath(): string | undefined {
    return this.approvedPlanPath;
  }

  getDirectWebFetch(): boolean {
    return this.directWebFetch;
  }

  setApprovedPlanPath(path: string | undefined): void {
    this.approvedPlanPath = path;
  }

  isAgentsEnabled(): boolean {
    return this.enableAgents;
  }

  isEventDrivenSchedulerEnabled(): boolean {
    return this.enableEventDrivenScheduler;
  }

  getNoBrowser(): boolean {
    return this.noBrowser;
  }

  getAgentsSettings(): AgentSettings {
    return this.agents;
  }

  isBrowserLaunchSuppressed(): boolean {
    return this.getNoBrowser() || !shouldAttemptBrowserLaunch();
  }

  getSummarizeToolOutputConfig():
    | Record<string, SummarizeToolOutputSettings>
    | undefined {
    return this.summarizeToolOutput;
  }

  getIdeMode(): boolean {
    return this.ideMode;
  }

  /**
   * Returns 'true' if the folder trust feature is enabled.
   */
  getFolderTrust(): boolean {
    return this.folderTrust;
  }

  /**
   * Returns 'true' if the workspace is considered "trusted".
   * 'false' for untrusted.
   */
  isTrustedFolder(): boolean {
    const context = ideContextStore.get();
    if (context?.workspaceState?.isTrusted !== undefined) {
      return context.workspaceState.isTrusted;
    }

    // Default to untrusted if folder trust is enabled and no explicit value is set.
    return this.folderTrust ? (this.trustedFolder ?? false) : true;
  }

  setIdeMode(value: boolean): void {
    this.ideMode = value;
  }

  private isScopedMemoryInboxPatchPathAllowed(
    absolutePath: string,
    resolvedPath: string,
    inboxRoot: string,
  ): boolean {
    if (!hasScopedMemoryInboxAccess()) {
      return false;
    }

    const normalizedPath = path.resolve(absolutePath);
    const isCanonicalPatchPath = (['private', 'global'] as const).some(
      (kind) =>
        normalizedPath === path.resolve(inboxRoot, kind, 'extraction.patch'),
    );
    if (!isCanonicalPatchPath) {
      return false;
    }

    const resolvedMemoryRoot = resolveToRealPath(
      this.storage.getProjectMemoryTempDir(),
    );
    return isSubpath(resolvedMemoryRoot, resolvedPath);
  }

  private isScopedAutoMemoryExtractionWritePathAllowed(
    absolutePath: string,
    resolvedPath: string,
  ): boolean {
    if (!hasScopedAutoMemoryExtractionWriteAccess()) {
      return false;
    }

    const resolvedSkillsMemoryDir = resolveToRealPath(
      this.storage.getProjectSkillsMemoryDir(),
    );
    if (isSubpath(resolvedSkillsMemoryDir, resolvedPath)) {
      return true;
    }

    return this.isScopedMemoryInboxPatchPathAllowed(
      absolutePath,
      resolvedPath,
      path.join(this.storage.getProjectMemoryTempDir(), '.inbox'),
    );
  }

  /**
   * Get the current FileSystemService
   */
  getFileSystemService(): FileSystemService {
    return this.fileSystemService;
  }

  /**
   * Checks if a given absolute path is allowed for file system operations.
   * A path is allowed if it's within the workspace context, the project's
   * temporary directory, or is exactly the global personal `~/.gemini/GEMINI.md`
   * file (the latter is the only file under `~/.gemini/` that is reachable —
   * settings, credentials, keybindings, etc. remain disallowed).
   *
   * One subtree is *carved back out*: `<projectMemoryDir>/.inbox/` is owned by
   * the auto-memory extraction agent and the `/memory inbox` review flow. The
   * main agent is denied access to it even though it falls inside the project
   * temp dir; the extraction agent receives a narrow execution-scoped exception
   * for `.inbox/{private,global}/extraction.patch`.
   *
   * @param absolutePath The absolute path to check.
   * @returns true if the path is allowed, false otherwise.
   */
  isPathAllowed(absolutePath: string): boolean {
    const resolvedPath = resolveToRealPath(absolutePath);

    // The auto-memory inbox (`<projectMemoryDir>/.inbox/`) is owned by the
    // background extraction agent and the `/memory inbox` review flow. The
    // main agent must NOT drop files into it directly (that would let the
    // model bypass review). Deny first, even if the path also satisfies the
    // workspace or project-temp allowlists below.
    const inboxRoot = path.join(
      this.storage.getProjectMemoryTempDir(),
      '.inbox',
    );
    const resolvedInboxRoot = resolveToRealPath(inboxRoot);
    const normalizedPath = path.resolve(absolutePath);
    const normalizedInboxRoot = path.resolve(inboxRoot);
    if (
      resolvedPath === resolvedInboxRoot ||
      isSubpath(resolvedInboxRoot, resolvedPath) ||
      normalizedPath === normalizedInboxRoot ||
      isSubpath(normalizedInboxRoot, normalizedPath)
    ) {
      if (
        this.isScopedMemoryInboxPatchPathAllowed(
          absolutePath,
          resolvedPath,
          inboxRoot,
        )
      ) {
        return true;
      }
      return false;
    }

    const workspaceContext = this.getWorkspaceContext();
    if (workspaceContext.isPathWithinWorkspace(resolvedPath)) {
      return true;
    }

    const projectTempDir = this.storage.getProjectTempDir();
    const resolvedTempDir = resolveToRealPath(projectTempDir);
    if (isSubpath(resolvedTempDir, resolvedPath)) {
      return true;
    }

    // Surgical allowlist: the global personal GEMINI.md file (and ONLY that
    // file) is reachable so the prompt-driven memory flow can persist
    // cross-project personal preferences. This deliberately does NOT
    // allowlist the rest of `~/.gemini/`.
    const globalMemoryFilePath = path.join(
      Storage.getGlobalGeminiDir(),
      getCurrentGeminiMdFilename(),
    );
    const resolvedGlobalMemoryFilePath =
      resolveToRealPath(globalMemoryFilePath);
    if (resolvedPath === resolvedGlobalMemoryFilePath) {
      return true;
    }

    return false;
  }

  /**
   * Validates if a path is allowed and returns a detailed error message if not.
   *
   * @param absolutePath The absolute path to validate.
   * @param checkType The type of access to check ('read' or 'write'). Defaults to 'write' for safety.
   * @returns An error message string if the path is disallowed, null otherwise.
   */
  validatePathAccess(
    absolutePath: string,
    checkType: 'read' | 'write' = 'write',
  ): string | null {
    if (checkType === 'write' && hasScopedAutoMemoryExtractionWriteAccess()) {
      const resolvedPath = resolveToRealPath(absolutePath);
      if (
        this.isScopedAutoMemoryExtractionWritePathAllowed(
          absolutePath,
          resolvedPath,
        )
      ) {
        return null;
      }
      return `Auto-memory extraction write denied: Attempted path "${absolutePath}" is outside the extraction write allowlist. Extraction may only write extracted skills under ${this.storage.getProjectSkillsMemoryDir()} and canonical inbox patches under ${path.join(this.storage.getProjectMemoryTempDir(), '.inbox', '{private,global}', 'extraction.patch')}.`;
    }

    // For read operations, check read-only paths first
    if (checkType === 'read') {
      if (this.getWorkspaceContext().isPathReadable(absolutePath)) {
        return null;
      }
    }

    // Then check standard allowed paths (Workspace + Temp)
    // This covers 'write' checks and acts as a fallback/temp-dir check for 'read'
    if (this.isPathAllowed(absolutePath)) {
      return null;
    }

    const workspaceDirs = this.getWorkspaceContext().getDirectories();
    const projectTempDir = this.storage.getProjectTempDir();
    return `Path not in workspace: Attempted path "${absolutePath}" resolves outside the allowed workspace directories: ${workspaceDirs.join(', ')} or the project temp directory: ${projectTempDir}`;
  }

  /**
   * Set a custom FileSystemService
   */
  setFileSystemService(fileSystemService: FileSystemService): void {
    this.fileSystemService = fileSystemService;
  }

  async getCompressionThreshold(): Promise<number | undefined> {
    if (this.compressionThreshold) {
      return this.compressionThreshold;
    }

    if (this.isLocalMode() && this.localCompressionThreshold !== undefined) {
      return this.localCompressionThreshold;
    }

    await this.ensureExperimentsLoaded();

    const remoteThreshold =
      this.experiments?.flags[ExperimentFlags.CONTEXT_COMPRESSION_THRESHOLD]
        ?.floatValue;
    if (remoteThreshold === 0) {
      return undefined;
    }
    if (remoteThreshold !== undefined) {
      return remoteThreshold;
    }

    if (this.isLocalMode()) {
      return DEFAULT_LOCAL_COMPRESSION_THRESHOLD;
    }
    return undefined;
  }

  getLocalPreserveFraction(): number {
    if (this.localPreserveFraction !== undefined) {
      return this.localPreserveFraction;
    }
    return DEFAULT_LOCAL_PRESERVE_FRACTION;
  }

  getLocalAutoTruncateOnOverflow(): boolean {
    return this.localAutoTruncateOnOverflow;
  }

  // --- LOCAL FORK ADDITION (Phase 2.0) ---
  getLocalAdaptiveCompressionEnabled(): boolean {
    return this.localAdaptiveCompressionEnabled;
  }

  /**
   * Wrapper around getCompressionThreshold() that applies adaptive tightening
   * when local mode is active and the user hasn't pinned a value explicitly.
   * Falls back to the base threshold in every error / disabled case.
   *
   * @param turnIndex Monotonic counter (e.g. chat history length) for cooldown.
   */
  async getEffectiveCompressionThreshold(
    turnIndex: number,
  ): Promise<number | undefined> {
    const base = await this.getCompressionThreshold();
    if (base === undefined) return base;
    if (!this.isLocalMode()) return base;
    if (!this.localAdaptiveCompressionEnabled) return base;
    try {
      return adaptiveGetEffectiveCompressionThreshold(base, {
        sessionId: this.getSessionId(),
        currentTurnIndex: turnIndex,
        userOverridePresent:
          this.compressionThreshold !== undefined ||
          this.localCompressionThreshold !== undefined,
        cooldownTurns: this.localAdaptiveCompressionCooldownTurns,
        floor: this.localAdaptiveCompressionFloor,
      });
    } catch {
      return base;
    }
  }

  /**
   * Record the outcome of a compression pass into the adaptive tracker. Safe
   * no-op outside local mode or when adaptive compression is disabled.
   */
  recordCompressionResult(
    originalTokenCount: number,
    newTokenCount: number,
    turnIndex: number,
  ): void {
    if (!this.isLocalMode()) return;
    if (!this.localAdaptiveCompressionEnabled) return;
    try {
      adaptiveRecordCompressionResult(
        this.getSessionId(),
        originalTokenCount,
        newTokenCount,
        turnIndex,
      );
    } catch {
      // Telemetry-only path; never throw.
    }
  }

  getLocalWriteFileEjectionEnabled(): boolean {
    return this.localWriteFileEjectionEnabled;
  }

  getLocalWriteFileEjectionMinAgeTurns(): number {
    return this.localWriteFileEjectionMinAgeTurns;
  }

  getLocalWriteFileEjectionMinTokensPerCall(): number {
    return this.localWriteFileEjectionMinTokensPerCall;
  }

  getLocalPreTurnBudgetEnabled(): boolean {
    return this.localPreTurnBudgetEnabled;
  }

  getLocalPreTurnBudgetReservedResponseTokens(): number {
    return this.localPreTurnBudgetReservedResponseTokens;
  }

  getLocalPreTurnBudgetProactiveCompressAt(): number {
    return this.localPreTurnBudgetProactiveCompressAt;
  }

  getLocalToolOutputMaskingEnabled(): boolean {
    return this.localToolOutputMaskingEnabled;
  }

  getLocalToolOutputMaskingProtectionFraction(): number {
    return this.localToolOutputMaskingProtectionFraction;
  }

  getLocalToolOutputMaskingPrunableFraction(): number {
    return this.localToolOutputMaskingPrunableFraction;
  }

  getLocalToolOutputMaskingProtectLatestTurn(): boolean {
    return this.localToolOutputMaskingProtectLatestTurn;
  }

  async getUserCaching(): Promise<boolean | undefined> {
    await this.ensureExperimentsLoaded();

    return this.experiments?.flags[ExperimentFlags.USER_CACHING]?.boolValue;
  }

  async getPlanModeRoutingEnabled(): Promise<boolean> {
    return this.planModeRoutingEnabled;
  }

  async getNumericalRoutingEnabled(): Promise<boolean> {
    await this.ensureExperimentsLoaded();

    const flag =
      this.experiments?.flags[ExperimentFlags.ENABLE_NUMERICAL_ROUTING];
    return flag?.boolValue ?? true;
  }

  /**
   * Returns the resolved complexity threshold for routing.
   * If a remote threshold is provided and within range (0-100), it is returned.
   * Otherwise, the default threshold (90) is returned.
   */
  async getResolvedClassifierThreshold(): Promise<number> {
    const remoteValue = await this.getClassifierThreshold();
    const defaultValue = 90;

    if (
      remoteValue !== undefined &&
      !isNaN(remoteValue) &&
      remoteValue >= 0 &&
      remoteValue <= 100
    ) {
      return remoteValue;
    }

    return defaultValue;
  }

  async getClassifierThreshold(): Promise<number | undefined> {
    await this.ensureExperimentsLoaded();

    const flag = this.experiments?.flags[ExperimentFlags.CLASSIFIER_THRESHOLD];
    if (flag?.intValue !== undefined) {
      return parseInt(flag.intValue, 10);
    }
    return flag?.floatValue;
  }

  async getBannerTextNoCapacityIssues(): Promise<string> {
    await this.ensureExperimentsLoaded();
    return (
      this.experiments?.flags[ExperimentFlags.BANNER_TEXT_NO_CAPACITY_ISSUES]
        ?.stringValue ?? ''
    );
  }

  async getBannerTextCapacityIssues(): Promise<string> {
    await this.ensureExperimentsLoaded();
    return (
      this.experiments?.flags[ExperimentFlags.BANNER_TEXT_CAPACITY_ISSUES]
        ?.stringValue ?? ''
    );
  }

  /**
   * Returns whether the user has access to Pro models.
   * This is determined by the PRO_MODEL_NO_ACCESS experiment flag.
   */
  async getProModelNoAccess(): Promise<boolean> {
    await this.ensureExperimentsLoaded();
    return this.getProModelNoAccessSync();
  }

  /**
   * Returns whether the user has access to Pro models synchronously.
   *
   * Note: This method should only be called after startup, once experiments have been loaded.
   */
  getProModelNoAccessSync(): boolean {
    if (
      this.contentGeneratorConfig?.authType !== AuthType.LOGIN_WITH_GOOGLE &&
      this.contentGeneratorConfig?.authType !== AuthType.COMPUTE_ADC
    ) {
      return false;
    }
    return (
      this.experiments?.flags[ExperimentFlags.PRO_MODEL_NO_ACCESS]?.boolValue ??
      false
    );
  }

  /**
   * Returns whether Gemini 3.1 Pro has been launched.
   * This method is async and ensures that experiments are loaded before returning the result.
   */
  async getGemini31Launched(): Promise<boolean> {
    await this.ensureExperimentsLoaded();
    return this.getGemini31LaunchedSync();
  }

  /**
   * Returns whether Gemini 3.1 Flash Lite has been launched.
   * This method is async and ensures that experiments are loaded before returning the result.
   */
  async getGemini31FlashLiteLaunched(): Promise<boolean> {
    await this.ensureExperimentsLoaded();
    return this.getGemini31FlashLiteLaunchedSync();
  }

  /**
   * Returns whether the custom tool model should be used.
   */
  async getUseCustomToolModel(): Promise<boolean> {
    const useGemini3_1 = await this.getGemini31Launched();
    const authType = this.contentGeneratorConfig?.authType;
    return useGemini3_1 && authType === AuthType.USE_GEMINI;
  }

  /**
   * Returns whether the custom tool model should be used.
   *
   * Note: This method should only be called after startup, once experiments have been loaded.
   */
  getUseCustomToolModelSync(): boolean {
    const useGemini3_1 = this.getGemini31LaunchedSync();
    const authType = this.contentGeneratorConfig?.authType;
    return useGemini3_1 && authType === AuthType.USE_GEMINI;
  }

  private isGemini31LaunchedForAuthType(authType?: AuthType): boolean {
    return (
      authType === AuthType.USE_GEMINI ||
      authType === AuthType.USE_VERTEX_AI ||
      authType === AuthType.GATEWAY
    );
  }

  /**
   * Returns whether Gemini 3.1 has been launched.
   *
   * Note: This method should only be called after startup, once experiments have been loaded.
   * If you need to call this during startup or from an async context, use
   * getGemini31Launched instead.
   */
  getGemini31LaunchedSync(): boolean {
    const authType = this.contentGeneratorConfig?.authType;
    if (this.isGemini31LaunchedForAuthType(authType)) {
      return true;
    }
    return (
      this.experiments?.flags[ExperimentFlags.GEMINI_3_1_PRO_LAUNCHED]
        ?.boolValue ?? false
    );
  }

  /**
   * Returns the configured default request timeout in milliseconds.
   */
  getRequestTimeoutMs(): number | undefined {
    const flag =
      this.experiments?.flags?.[ExperimentFlags.DEFAULT_REQUEST_TIMEOUT];
    if (flag?.intValue !== undefined) {
      const seconds = parseInt(flag.intValue, 10);
      if (Number.isInteger(seconds) && seconds >= 0) {
        return seconds * 1000; // Convert seconds to milliseconds
      }
    }
    return undefined;
  }

  /**
   * Returns whether Gemini 3.1 Flash Lite has been launched.
   *
   * Note: This method should only be called after startup, once experiments have been loaded.
   * If you need to call this during startup or from an async context, use
   * getGemini31FlashLiteLaunched instead.
   */
  getGemini31FlashLiteLaunchedSync(): boolean {
    const authType = this.contentGeneratorConfig?.authType;
    if (this.isGemini31LaunchedForAuthType(authType)) {
      return true;
    }
    return (
      this.experiments?.flags[ExperimentFlags.GEMINI_3_1_FLASH_LITE_LAUNCHED]
        ?.boolValue ?? false
    );
  }

  private async ensureExperimentsLoaded(): Promise<void> {
    if (!this.experimentsPromise) {
      return;
    }
    try {
      await this.experimentsPromise;
    } catch (e) {
      debugLogger.debug('Failed to fetch experiments', e);
    }
  }

  isInteractiveShellEnabled(): boolean {
    return (
      this.interactive &&
      this.ptyInfo !== 'child_process' &&
      this.enableInteractiveShell
    );
  }

  isSkillsSupportEnabled(): boolean {
    return this.skillsSupport;
  }

  /**
   * Reloads skills by re-discovering them from extensions and local directories.
   */
  async reloadSkills(): Promise<void> {
    if (!this.skillsSupport) {
      return;
    }

    if (this.onReload) {
      const refreshed = await this.onReload();
      this.disabledSkills = refreshed.disabledSkills ?? [];
      this.getSkillManager().setAdminSettings(
        refreshed.adminSkillsEnabled ?? this.adminSkillsEnabled,
      );
    }

    if (this.getSkillManager().isAdminEnabled()) {
      await this.getSkillManager().discoverSkills(
        this.storage,
        this.getExtensions(),
        this.isTrustedFolder(),
      );
      this.getSkillManager().setDisabledSkills(this.disabledSkills);

      // Re-register ActivateSkillTool to update its schema with the newly discovered skills
      if (this.getSkillManager().getSkills().length > 0) {
        this.toolRegistry.unregisterTool(ActivateSkillTool.Name);
        this.toolRegistry.registerTool(
          new ActivateSkillTool(this, this.messageBus),
        );
      } else {
        this.toolRegistry.unregisterTool(ActivateSkillTool.Name);
      }
    } else {
      this.getSkillManager().clearSkills();
      this.toolRegistry.unregisterTool(ActivateSkillTool.Name);
    }

    // Notify the client that system instructions might need updating
    this.updateSystemInstructionIfInitialized();
  }

  /**
   * Reloads agent settings.
   */
  async reloadAgents(): Promise<void> {
    if (this.onReload) {
      const refreshed = await this.onReload();
      if (refreshed.agents) {
        this.agents = refreshed.agents;
      }
    }
  }

  isInteractive(): boolean {
    return this.interactive;
  }

  getUseRipgrep(): boolean {
    return this.useRipgrep;
  }

  getUseBackgroundColor(): boolean {
    return this.useBackgroundColor;
  }

  getUseAlternateBuffer(): boolean {
    return this.useAlternateBuffer;
  }

  getUseTerminalBuffer(): boolean {
    return this.useTerminalBuffer;
  }

  getUseRenderProcess(): boolean {
    return this.useRenderProcess;
  }

  getEnableInteractiveShell(): boolean {
    return this.enableInteractiveShell;
  }

  getShellBackgroundCompletionBehavior(): 'inject' | 'notify' | 'silent' {
    return this.shellBackgroundCompletionBehavior;
  }

  getSkipNextSpeakerCheck(): boolean {
    return this.skipNextSpeakerCheck;
  }

  getRetryFetchErrors(): boolean {
    return this.retryFetchErrors;
  }

  getMaxAttempts(): number {
    return this.maxAttempts;
  }

  getEnableShellOutputEfficiency(): boolean {
    return this.enableShellOutputEfficiency;
  }

  getShellToolInactivityTimeout(): number {
    return this.shellToolInactivityTimeout;
  }

  getShellExecutionConfig(): ShellExecutionConfig {
    return this.shellExecutionConfig;
  }

  setShellExecutionConfig(config: Partial<ShellExecutionConfig>): void {
    const definedConfig: Partial<ShellExecutionConfig> = {};
    for (const [k, v] of Object.entries(config)) {
      // Only merge properties explicitly provided with a concrete value.
      // Filtering out `null` and `undefined` ensures existing system defaults
      // are preserved when an extension doesn't want to override them.
      if (v != null) {
        Object.assign(definedConfig, { [k]: v });
      }
    }

    // Note: This performs a shallow merge. If the incoming config provides a nested
    // object (e.g., sandboxConfig), it will completely overwrite the existing
    // nested object rather than merging its individual properties.
    this.shellExecutionConfig = {
      ...this.shellExecutionConfig,
      ...definedConfig,
    };
  }
  getScreenReader(): boolean {
    return this.accessibility.screenReader ?? false;
  }

  getTruncateToolOutputThreshold(): number {
    const limit = this.isLocalMode()
      ? this.getLocalContextLimit()
      : tokenLimit(this.model);
    return Math.min(
      // Estimate remaining context window in characters (1 token ~= 4 chars).
      4 * (limit - uiTelemetryService.getLastPromptTokenCount()),
      this.truncateToolOutputThreshold,
    );
  }

  getToolMaxOutputTokens(): number {
    return this.contextManagement.tools.distillation.maxOutputTokens;
  }

  getToolSummarizationThresholdTokens(): number {
    return this.contextManagement.tools.distillation
      .summarizationThresholdTokens;
  }

  getNextCompressionTruncationId(): number {
    return ++this.compressionTruncationCounter;
  }

  getUseWriteTodos(): boolean {
    return this.useWriteTodos;
  }

  getOutputFormat(): OutputFormat {
    return this.outputSettings?.format
      ? this.outputSettings.format
      : OutputFormat.TEXT;
  }

  async getGitService(): Promise<GitService> {
    if (!this.gitService) {
      this.gitService = new GitService(this.targetDir, this.storage);
      await this.gitService.initialize();
    }
    return this.gitService;
  }

  getFileExclusions(): FileExclusions {
    return this.fileExclusions;
  }

  /** @deprecated Use messageBus getter */
  getMessageBus(): MessageBus {
    return this.messageBus;
  }

  getPolicyEngine(): PolicyEngine {
    return this.policyEngine;
  }

  getEnableHooks(): boolean {
    return this.enableHooks;
  }

  getEnableHooksUI(): boolean {
    return this.enableHooksUI;
  }

  getGemmaModelRouterEnabled(): boolean {
    return this.gemmaModelRouter.enabled ?? false;
  }

  getGemmaModelRouterSettings(): GemmaModelRouterSettings {
    return this.gemmaModelRouter;
  }

  getAgentSessionNoninteractiveEnabled(): boolean {
    return (
      process.env['GEMINI_CLI_EXP_AGENT'] === 'true' ||
      this.agentSessionNoninteractiveEnabled
    );
  }

  getAgentSessionInteractiveEnabled(): boolean {
    return (
      process.env['GEMINI_CLI_EXP_AGENT'] === 'true' ||
      this.agentSessionInteractiveEnabled
    );
  }

  /**
   * Get override settings for a specific agent.
   * Reads from agents.overrides.<agentName>.
   */
  getAgentOverride(agentName: string): AgentOverride | undefined {
    return this.getAgentsSettings()?.overrides?.[agentName];
  }

  /**
   * Get browser agent configuration.
   * Combines generic AgentOverride fields with browser-specific customConfig.
   * This is the canonical way to access browser agent settings.
   */
  getBrowserAgentConfig(): {
    enabled: boolean;
    model?: string;
    customConfig: BrowserAgentCustomConfig;
  } {
    const override = this.getAgentOverride('browser_agent');
    const customConfig = this.getAgentsSettings()?.browser ?? {};
    return {
      enabled: override?.enabled ?? false,
      model: override?.modelConfig?.model,
      customConfig: {
        sessionMode: customConfig.sessionMode ?? 'persistent',
        headless: customConfig.headless ?? false,
        profilePath: customConfig.profilePath,
        visualModel: customConfig.visualModel,
        allowedDomains: customConfig.allowedDomains,
        disableUserInput: customConfig.disableUserInput,
        maxActionsPerTask: customConfig.maxActionsPerTask ?? 100,
        confirmSensitiveActions: customConfig.confirmSensitiveActions,
        blockFileUploads: customConfig.blockFileUploads,
      },
    };
  }

  /**
   * Determines if user input should be disabled during browser automation.
   * Based on the `disableUserInput` setting and `headless` mode.
   */
  shouldDisableBrowserUserInput(): boolean {
    const browserConfig = this.getBrowserAgentConfig();
    return (
      browserConfig.customConfig?.disableUserInput !== false &&
      !browserConfig.customConfig?.headless
    );
  }

  async createToolRegistry(): Promise<ToolRegistry> {
    const registry = new ToolRegistry(
      this,
      this.messageBus,
      /* isMainRegistry= */ true,
    );

    // helper to create & register core tools that are enabled
    const maybeRegister = (
      toolClass: { name: string; Name?: string },
      registerFn: () => void,
    ) => {
      const className = toolClass.name;
      const toolName = toolClass.Name || className;
      const coreTools = this.getCoreTools();
      // On some platforms, the className can be minified to _ClassName.
      const normalizedClassName = className.replace(/^_+/, '');

      let isEnabled = true; // Enabled by default if coreTools is not set.
      if (coreTools) {
        isEnabled = coreTools.some(
          (tool) =>
            tool === toolName ||
            tool === normalizedClassName ||
            tool.startsWith(`${toolName}(`) ||
            tool.startsWith(`${normalizedClassName}(`),
        );
      }

      if (isEnabled) {
        registerFn();
      }
    };

    maybeRegister(UpdateTopicTool, () =>
      registry.registerTool(new UpdateTopicTool(this, this.messageBus)),
    );

    maybeRegister(LSTool, () =>
      registry.registerTool(new LSTool(this, this.messageBus)),
    );
    maybeRegister(ReadFileTool, () =>
      registry.registerTool(new ReadFileTool(this, this.messageBus)),
    );

    if (this.getUseRipgrep()) {
      let useRipgrep = false;
      let errorString: undefined | string = undefined;
      try {
        useRipgrep = await canUseRipgrep();
      } catch (error: unknown) {
        errorString = String(error);
      }
      if (useRipgrep) {
        maybeRegister(RipGrepTool, () =>
          registry.registerTool(new RipGrepTool(this, this.messageBus)),
        );
      } else {
        debugLogger.warn(`Ripgrep is not available. Falling back to GrepTool.`);
        logRipgrepFallback(this, new RipgrepFallbackEvent(errorString));
        maybeRegister(GrepTool, () =>
          registry.registerTool(new GrepTool(this, this.messageBus)),
        );
      }
    } else {
      maybeRegister(GrepTool, () =>
        registry.registerTool(new GrepTool(this, this.messageBus)),
      );
    }

    maybeRegister(GlobTool, () =>
      registry.registerTool(new GlobTool(this, this.messageBus)),
    );
    maybeRegister(ActivateSkillTool, () =>
      registry.registerTool(new ActivateSkillTool(this, this.messageBus)),
    );
    maybeRegister(EditTool, () =>
      registry.registerTool(new EditTool(this, this.messageBus)),
    );
    maybeRegister(WriteFileTool, () =>
      registry.registerTool(new WriteFileTool(this, this.messageBus)),
    );
    maybeRegister(WebFetchTool, () =>
      registry.registerTool(new WebFetchTool(this, this.messageBus)),
    );
    maybeRegister(ReadMcpResourceTool, () =>
      registry.registerTool(new ReadMcpResourceTool(this, this.messageBus)),
    );
    maybeRegister(ListMcpResourcesTool, () =>
      registry.registerTool(new ListMcpResourcesTool(this, this.messageBus)),
    );
    maybeRegister(ShellTool, () =>
      registry.registerTool(new ShellTool(this, this.messageBus)),
    );
    maybeRegister(ListBackgroundProcessesTool, () =>
      registry.registerTool(
        new ListBackgroundProcessesTool(this, this.messageBus),
      ),
    );
    maybeRegister(ReadBackgroundOutputTool, () =>
      registry.registerTool(
        new ReadBackgroundOutputTool(this, this.messageBus),
      ),
    );
    if (!this.isMemoryV2Enabled()) {
      maybeRegister(MemoryTool, () =>
        registry.registerTool(new MemoryTool(this.messageBus, this.storage)),
      );
    }
    maybeRegister(WebSearchTool, () =>
      registry.registerTool(new WebSearchTool(this, this.messageBus)),
    );
    maybeRegister(AskUserTool, () =>
      registry.registerTool(new AskUserTool(this.messageBus)),
    );
    if (this.getUseWriteTodos()) {
      maybeRegister(WriteTodosTool, () =>
        registry.registerTool(new WriteTodosTool(this.messageBus)),
      );
    }
    if (this.isPlanEnabled()) {
      maybeRegister(ExitPlanModeTool, () =>
        registry.registerTool(new ExitPlanModeTool(this, this.messageBus)),
      );
      maybeRegister(EnterPlanModeTool, () =>
        registry.registerTool(new EnterPlanModeTool(this, this.messageBus)),
      );
    }

    if (this.isTrackerEnabled()) {
      maybeRegister(TrackerCreateTaskTool, () =>
        registry.registerTool(new TrackerCreateTaskTool(this, this.messageBus)),
      );
      maybeRegister(TrackerUpdateTaskTool, () =>
        registry.registerTool(new TrackerUpdateTaskTool(this, this.messageBus)),
      );
      maybeRegister(TrackerGetTaskTool, () =>
        registry.registerTool(new TrackerGetTaskTool(this, this.messageBus)),
      );
      maybeRegister(TrackerListTasksTool, () =>
        registry.registerTool(new TrackerListTasksTool(this, this.messageBus)),
      );
      maybeRegister(TrackerAddDependencyTool, () =>
        registry.registerTool(
          new TrackerAddDependencyTool(this, this.messageBus),
        ),
      );
      maybeRegister(TrackerVisualizeTool, () =>
        registry.registerTool(new TrackerVisualizeTool(this, this.messageBus)),
      );
    }

    // Register Subagent Tool
    maybeRegister(AgentTool, () =>
      registry.registerTool(new AgentTool(this, this.messageBus)),
    );

    await registry.discoverAllTools();
    registry.sortTools();
    return registry;
  }

  /**
   * Get the hook system instance
   */
  getHookSystem(): HookSystem | undefined {
    return this.hookSystem;
  }

  /**
   * Get hooks configuration
   */
  getHooks(): { [K in HookEventName]?: HookDefinition[] } | undefined {
    return this.hooks;
  }

  /**
   * Get project-specific hooks configuration
   */
  getProjectHooks(): { [K in HookEventName]?: HookDefinition[] } | undefined {
    return this.projectHooks;
  }

  /**
   * Update the list of disabled hooks dynamically.
   * This is used to keep the running system in sync with settings changes
   * without risk of loading new hook definitions into memory.
   */
  updateDisabledHooks(disabledHooks: string[]): void {
    this.disabledHooks = disabledHooks;
  }

  /**
   * Get disabled hooks list
   */
  getDisabledHooks(): string[] {
    return this.disabledHooks;
  }

  /**
   * Get experiments configuration
   */
  getExperiments(): Experiments | undefined {
    return this.experiments;
  }

  /**
   * Set experiments configuration
   */
  setExperiments(experiments: Experiments): void {
    this.experiments = experiments;
    const flagSummaries = Object.entries(experiments.flags ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([flagId, flag]) => {
        const summary: Record<string, unknown> = { flagId };
        if (flag.boolValue !== undefined) {
          summary['boolValue'] = flag.boolValue;
        }
        if (flag.floatValue !== undefined) {
          summary['floatValue'] = flag.floatValue;
        }
        if (flag.intValue !== undefined) {
          summary['intValue'] = flag.intValue;
        }
        if (flag.stringValue !== undefined) {
          summary['stringValue'] = flag.stringValue;
        }
        const int32Length = flag.int32ListValue?.values?.length ?? 0;
        if (int32Length > 0) {
          summary['int32ListLength'] = int32Length;
        }
        const stringListLength = flag.stringListValue?.values?.length ?? 0;
        if (stringListLength > 0) {
          summary['stringListLength'] = stringListLength;
        }
        return summary;
      });
    const summary = {
      experimentIds: experiments.experimentIds ?? [],
      flags: flagSummaries,
    };
    const summaryString = inspect(summary, {
      depth: null,
      maxArrayLength: null,
      maxStringLength: null,
      breakLength: 80,
      compact: false,
    });
    debugLogger.debug('Experiments loaded', summaryString);
  }

  private onAgentsRefreshed = async () => {
    // Propagate updates to the active chat session
    const client = this.geminiClient;
    if (client?.isInitialized()) {
      await client.setTools();
      client.updateSystemInstruction();
    } else {
      debugLogger.debug(
        '[Config] GeminiClient not initialized; skipping live prompt/tool refresh.',
      );
    }
  };

  /**
   * Disposes of resources and removes event listeners.
   */
  async dispose(): Promise<void> {
    this.logCurrentModeDuration(this.getApprovalMode());
    coreEvents.off(CoreEvent.AgentsRefreshed, this.onAgentsRefreshed);
    this.agentRegistry?.dispose();
    this._geminiClient?.dispose();
    if (this.mcpClientManager) {
      await this.mcpClientManager.stop();
    }
  }
}
// Export model constants for use in CLI
export { DEFAULT_GEMINI_FLASH_MODEL };
