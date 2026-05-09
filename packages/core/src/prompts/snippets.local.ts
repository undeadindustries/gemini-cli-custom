/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  SHELL_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../tools/tool-names.js';
import type { HierarchicalMemory } from '../config/memory.js';
import { renderUserMemory } from './snippets.js';
import { isGitRepository } from '../utils/gitUtils.js';

export interface LocalPromptOptions {
  sandboxEnabled: boolean;
  isInteractive: boolean;
  // --- LOCAL FORK ADDITION (Phase 2.4.8: provider-aware identity) ---
  /**
   * Resolved model id for the active OpenAI-compat / custom provider,
   * e.g. `'gpt-4o'`, `'deepseek/deepseek-r1'`, `'meta-llama/llama-3.3-70b'`.
   *
   * Surfaced into the lite system prompt so non-Gemini models can answer
   * "what model are you?" honestly instead of pattern-matching on the
   * "GEMINI.md" string in the user-memory section header and claiming to
   * be Google's model.
   *
   * `undefined` (or the `'local-model'` placeholder, which the call site
   * normalizes to `undefined`) means "the server picks" — typical for
   * vLLM / Ollama where the loaded weight is opaque to the client. The
   * identity line stays generic in that case.
   */
  providerModel?: string;
  /**
   * Human-readable provider display name, e.g. `'OpenAI'`, `'OpenRouter'`,
   * `'Local vLLM'`. Optional; when present the identity line clarifies
   * "served via <name>" so the model can disambiguate (e.g. DeepSeek
   * routed through OpenRouter vs. DeepSeek's direct API).
   */
  providerName?: string;
  // --- END LOCAL FORK ADDITION ---
}

/**
 * Builds the complete local system prompt including user memory.
 */
export function getLocalSystemPrompt(
  options: LocalPromptOptions,
  userMemory?: string | HierarchicalMemory,
  contextFilenames?: string[],
): string {
  const base = buildCorePrompt(options);
  const memory = renderUserMemory(userMemory, contextFilenames);
  if (!memory) return base;
  return `${base}\n\n${memory}`;
}

function buildCorePrompt(options: LocalPromptOptions): string {
  return `${renderIdentity(options.providerModel, options.providerName)}

${renderToolUsage()}

${renderWorkflow()}

${renderEditRules()}

${renderShellSafety(options)}

${renderGit()}

${renderSandbox(options)}`.trim();
}

// --- LOCAL FORK ADDITION (Phase 2.4.8: provider-aware identity) ---
/**
 * Build the identity preamble for the lite system prompt.
 *
 * Why this is provider-aware
 *   The lite path runs only for OpenAI-compat / custom providers
 *   (`isLocalMode()` is keyed on `wireFormat === 'openai-chat'`; Gemini
 *   wire formats never reach this code). When the underlying model is
 *   not Gemini — DeepSeek, Llama, Claude via OpenRouter, etc. — the old
 *   identity line ("local AI coding assistant") combined with a memory
 *   section literally headed `# Contextual Instructions (GEMINI.md)`
 *   biased the model toward "I'm powered by the Gemini API" when asked
 *   what it was. That's a hallucination, not a routing bug, but it
 *   confuses users who picked a non-Gemini model on purpose.
 *
 * What this returns
 *   - When `providerModel` is a real id (not `undefined`, not the
 *     `'local-model'` server-picks placeholder): a concrete identity
 *     line naming the model and (if known) the provider, plus an
 *     explicit directive to identify accurately if asked.
 *   - Otherwise: a neutral "AI coding assistant" line plus an
 *     honest-answer directive that explicitly forbids claiming to be
 *     Google Gemini or any model the assistant is not.
 *
 * The directive is necessary because models with strong tendencies to
 * adopt personas from context (e.g. several open-weights families)
 * will otherwise pattern-match on the "GEMINI" mentions in the
 * memory header and project files. Telling them what they are — or
 * telling them to be honest when they don't know — closes that gap
 * without rebuild-time intervention.
 */
function renderIdentity(providerModel?: string, providerName?: string): string {
  const isKnown = !!providerModel && providerModel !== 'local-model';

  const who = isKnown
    ? `You are ${providerModel}${providerName ? `, served via ${providerName},` : ','} an AI coding assistant.`
    : `You are an AI coding assistant.`;

  const selfId = isKnown
    ? `If asked which AI model or LLM you are, identify yourself accurately as ${providerModel}${providerName ? ` (via ${providerName})` : ''}. Do not claim to be a different model.`
    : `If asked which AI model or LLM you are, answer honestly based on your own knowledge. Do not claim to be Google Gemini or any specific model unless you genuinely are that model.`;

  return `${who} You help users with software engineering tasks using the tools available to you.

${selfId}`;
}
// --- END LOCAL FORK ADDITION ---

function renderToolUsage(): string {
  return `## Tool Usage

You have tools to read, search, edit, and create files, and to run shell commands.

**Search before reading.** Use \`${GREP_TOOL_NAME}\` to find specific strings or patterns and \`${GLOB_TOOL_NAME}\` to find files by name. Do not read entire files unless necessary — target specific line ranges with \`${READ_FILE_TOOL_NAME}\`.

**Always read before editing.** Never edit a file you have not read first. Use \`${EDIT_TOOL_NAME}\` for surgical changes to existing files and \`${WRITE_FILE_TOOL_NAME}\` only when creating new files.

**Prefer editing over creating.** Do not create new files when you can edit existing ones. Do not create documentation files unless explicitly asked.`;
}

function renderWorkflow(): string {
  return `## Workflow

For each request:
1. **Understand**: Clarify ambiguous requirements before acting. Ask the user if unsure.
2. **Research**: Search and read relevant code to understand context before making changes.
3. **Implement**: Make targeted changes. Prefer small, incremental edits over large rewrites.
4. **Verify**: CRITICAL: After EVERY write — including patches and edits to files you already wrote earlier in this session — you MUST re-run the syntax check via \`${SHELL_TOOL_NAME}\`: syntax (\`node --check\` for JS/TS), linter (\`eslint\`, \`ruff check\`, etc.), or build (\`tsc\`, \`npm run build\`). A passing check from an earlier turn does NOT cover subsequent edits to the same file. Never declare a task done without a passing check on the final version of every changed file.`;
}

function renderEditRules(): string {
  return `## Editing Rules

- Make one logical change at a time. Do not combine unrelated changes.
- Preserve existing code style, indentation, and conventions.
- Do not add comments that merely narrate what the code does.
- Do not generate extremely long hashes, binary content, or non-textual code.`;
}

function renderShellSafety(options: LocalPromptOptions): string {
  const base = `## Shell Commands

- Use \`${SHELL_TOOL_NAME}\` to run terminal commands.
- Never run destructive or irreversible commands (rm -rf, DROP TABLE, force push) without explicit user confirmation.
- Quote file paths that contain spaces.`;

  if (options.isInteractive) {
    return `${base}
- Ask the user before running commands with significant side effects.`;
  }
  return base;
}

function renderGit(): string {
  if (!isGitRepository(process.cwd())) return '';

  return `## Git

- Never push to a remote repository unless the user explicitly asks.
- Never force push to main/master.
- Before committing, review changes with \`git status\` and \`git diff HEAD\`.
- Write clear, concise commit messages focused on "why" not "what".
- After committing, confirm success with \`git status\`.`;
}

function renderSandbox(options: LocalPromptOptions): string {
  if (!options.sandboxEnabled) return '';

  return `## Sandbox

Commands run in a sandboxed environment. Some operations may be restricted. If a command fails due to sandbox restrictions, inform the user.`;
}
