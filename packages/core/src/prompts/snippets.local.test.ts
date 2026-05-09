/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// --- LOCAL FORK ADDITION (Phase 2.4.8: provider-aware identity) ---
// Verifies that `getLocalSystemPrompt` produces honest, provider-aware
// identity lines for OpenAI-compat / custom providers.
//
// Background: the lite path runs only for `wireFormat === 'openai-chat'`
// providers. Pre-2.4.8 the identity line was a hardcoded "You are a
// local AI coding assistant" with no self-identification directive, so
// non-Gemini models pattern-matched on the "GEMINI.md" string in the
// user-memory section header and answered "I'm powered by the Gemini
// API" when asked what they were. These tests pin the new behavior so
// future refactors don't silently regress it.
// --- END LOCAL FORK ADDITION ---

import { describe, it, expect, vi } from 'vitest';
import { getLocalSystemPrompt } from './snippets.local.js';

// `renderGit()` checks if the cwd is a git repository at module load
// time; our assertions are about identity lines, not the git section,
// so we stub it to keep test output deterministic regardless of where
// the tests happen to run.
vi.mock('../utils/gitUtils.js', () => ({
  isGitRepository: vi.fn().mockReturnValue(false),
}));

const baseOptions = {
  sandboxEnabled: false,
  isInteractive: true,
};

describe('snippets.local.ts — getLocalSystemPrompt identity', () => {
  describe('with a known provider model', () => {
    it('names the model and provider in the identity line', () => {
      const prompt = getLocalSystemPrompt({
        ...baseOptions,
        providerModel: 'deepseek/deepseek-r1',
        providerName: 'OpenRouter',
      });

      expect(prompt).toContain('deepseek/deepseek-r1');
      expect(prompt).toContain('served via OpenRouter');
      expect(prompt).toContain('You are deepseek/deepseek-r1');
    });

    it('includes a directive to identify accurately when asked', () => {
      const prompt = getLocalSystemPrompt({
        ...baseOptions,
        providerModel: 'gpt-4o',
        providerName: 'OpenAI',
      });

      expect(prompt).toContain('If asked which AI model');
      expect(prompt).toContain('identify yourself accurately as gpt-4o');
      expect(prompt).toContain('Do not claim to be a different model');
    });

    it('does not reference Gemini anywhere in the prompt', () => {
      const prompt = getLocalSystemPrompt({
        ...baseOptions,
        providerModel: 'meta-llama/llama-3.3-70b-instruct',
        providerName: 'OpenRouter',
      });

      expect(prompt).not.toMatch(/Gemini/);
    });

    it('omits the "served via" clause when providerName is missing', () => {
      const prompt = getLocalSystemPrompt({
        ...baseOptions,
        providerModel: 'mistralai/mixtral-8x7b-instruct',
        // providerName omitted on purpose
      });

      expect(prompt).toContain(
        'You are mistralai/mixtral-8x7b-instruct, an AI coding assistant.',
      );
      expect(prompt).not.toContain('served via');
      expect(prompt).toContain(
        'identify yourself accurately as mistralai/mixtral-8x7b-instruct',
      );
      // No "(via …)" parenthetical when there's no provider name.
      expect(prompt).not.toMatch(/\(via\s/);
    });
  });

  describe('with a server-picks placeholder ("local-model")', () => {
    it('falls back to a generic identity line', () => {
      const prompt = getLocalSystemPrompt({
        ...baseOptions,
        providerModel: 'local-model',
        providerName: 'Local vLLM',
      });

      // No "You are local-model" — that would be lying about a real
      // model name when the placeholder means "the server picks".
      expect(prompt).not.toContain('You are local-model');
      expect(prompt).toContain('You are an AI coding assistant.');
    });

    it('includes the honest-answer directive forbidding Gemini claims', () => {
      const prompt = getLocalSystemPrompt({
        ...baseOptions,
        providerModel: 'local-model',
      });

      expect(prompt).toContain('answer honestly based on your own knowledge');
      expect(prompt).toContain(
        'Do not claim to be Google Gemini or any specific model unless you genuinely are that model.',
      );
    });
  });

  describe('with no provider info (legacy / call-site fallback)', () => {
    it('emits the generic identity + honest-answer directive', () => {
      const prompt = getLocalSystemPrompt({
        ...baseOptions,
        // providerModel and providerName both undefined
      });

      expect(prompt).toContain('You are an AI coding assistant.');
      expect(prompt).toContain('answer honestly based on your own knowledge');
      // The directive intentionally mentions "Google Gemini" in a
      // negative sense ("Do not claim to be Google Gemini"), so we
      // assert on the surrounding "Do not claim" wording rather than
      // a blanket no-Gemini-anywhere rule.
      expect(prompt).toContain('Do not claim to be Google Gemini');
    });

    it('preserves the rest of the lite prompt (tool usage, workflow, edits)', () => {
      const prompt = getLocalSystemPrompt({
        ...baseOptions,
      });

      // Confirms identity changes did not accidentally drop the
      // surrounding sections — these section headers are stable
      // contracts that other parts of the system rely on.
      expect(prompt).toContain('## Tool Usage');
      expect(prompt).toContain('## Workflow');
      expect(prompt).toContain('## Editing Rules');
      expect(prompt).toContain('## Shell Commands');
    });
  });

  describe('user-memory composition (existing behavior unchanged)', () => {
    it('appends user memory after the identity block when provided', () => {
      const prompt = getLocalSystemPrompt(
        {
          ...baseOptions,
          providerModel: 'gpt-4o',
          providerName: 'OpenAI',
        },
        'Project-specific guidance: prefer TypeScript over JavaScript.',
        ['GEMINI.md'],
      );

      // Identity comes first; memory section follows.
      const identityIdx = prompt.indexOf('You are gpt-4o');
      const memoryIdx = prompt.indexOf(
        'Project-specific guidance: prefer TypeScript over JavaScript.',
      );
      expect(identityIdx).toBeGreaterThanOrEqual(0);
      expect(memoryIdx).toBeGreaterThan(identityIdx);
    });

    it('returns just the base prompt when memory is empty', () => {
      const prompt = getLocalSystemPrompt({
        ...baseOptions,
        providerModel: 'gpt-4o',
        providerName: 'OpenAI',
      });

      expect(prompt).toContain('You are gpt-4o');
      // No "Contextual Instructions" header when memory is empty.
      expect(prompt).not.toContain('# Contextual Instructions');
    });
  });
});
