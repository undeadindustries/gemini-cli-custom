/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Phase 2.3 — ProviderDialog screen tests. Brand-new file (Category C).
//
// We focus on per-screen rendering invariants rather than wiring up the
// full state-machine. Each screen is exercised via the real ProviderDialog
// component with a fake Config seeded so the dialog is forced into the
// state we want (e.g. an active Gemini provider hides Edit; a custom
// provider unlocks Remove). End-to-end navigation is covered by a single
// "menu → switch screen" interaction test.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { ProviderDialog } from './ProviderDialog.js';
import { renderWithProviders } from '../../test-utils/render.js';
import { createMockSettings } from '../../test-utils/settings.js';
import { makeFakeConfig } from '@google/gemini-cli-core';
import type { Config } from '@google/gemini-cli-core';

function setActive(config: Config, id: string): void {
  // Shape-cast: setting a private field for test-only state. Avoids
  // wiring a synchronous 'set active id' API on Config purely for tests.
  (
    config as unknown as { providersActive: string | undefined }
  ).providersActive = id;
}

function setCustom(config: Config, custom: Record<string, unknown>): void {
  (
    config as unknown as { providersCustom: Record<string, unknown> }
  ).providersCustom = custom;
}

describe('<ProviderDialog /> screens', () => {
  const onClose = vi.fn();

  beforeEach(() => {
    onClose.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('menu screen shows Switch / Add / Remove / Browse models / Close when active is Gemini', async () => {
    const settings = createMockSettings();
    const config = makeFakeConfig();
    setActive(config, 'gemini-oauth');

    const { lastFrame, unmount } = await renderWithProviders(
      <ProviderDialog onClose={onClose} />,
      { settings, config },
    );

    const frame = lastFrame();
    expect(frame).toContain('Switch active provider');
    // Edit row hidden for Gemini providers (Phase 2.3 rule).
    expect(frame).not.toContain('Edit active provider');
    expect(frame).toContain('Add provider');
    expect(frame).toContain('Remove provider');
    expect(frame).toContain('Browse models');
    expect(frame).toContain('Close');
    expect(frame).toContain('Gemini uses gemini-cli defaults');
    unmount();
  });

  it('menu screen shows Edit when active is OpenAI (non-Gemini)', async () => {
    const settings = createMockSettings();
    const config = makeFakeConfig();
    setActive(config, 'openai');

    const { lastFrame, unmount } = await renderWithProviders(
      <ProviderDialog onClose={onClose} />,
      { settings, config },
    );

    const frame = lastFrame();
    expect(frame).toContain('Edit active provider (openai)');
    expect(frame).toContain('Switch active provider');
    expect(frame).toContain('Browse models');
    // Active-provider banner shows the OpenAI display name.
    expect(frame).toContain('OpenAI');
    unmount();
  });

  it('menu screen shows custom-count hint when remove is available', async () => {
    const settings = createMockSettings();
    const config = makeFakeConfig();
    setActive(config, 'openai');
    setCustom(config, {
      'my-vllm': {
        displayName: 'My vLLM',
        baseUrl: 'http://127.0.0.1:8000/v1/chat/completions',
      },
    });

    const { lastFrame, unmount } = await renderWithProviders(
      <ProviderDialog onClose={onClose} />,
      { settings, config },
    );

    const frame = lastFrame();
    expect(frame).toContain('1 custom provider');
    unmount();
  });

  it('menu screen reports zero custom providers when none defined', async () => {
    const settings = createMockSettings();
    const config = makeFakeConfig();
    setActive(config, 'openai');

    const { lastFrame, unmount } = await renderWithProviders(
      <ProviderDialog onClose={onClose} />,
      { settings, config },
    );

    expect(lastFrame()).toContain('no custom providers to remove');
    unmount();
  });

  it('switch screen lists every provider in the effective registry', async () => {
    const settings = createMockSettings();
    const config = makeFakeConfig();
    setActive(config, 'openai');
    setCustom(config, {
      'my-vllm': {
        displayName: 'My vLLM',
        baseUrl: 'http://127.0.0.1:8000/v1/chat/completions',
      },
    });

    const { lastFrame, stdin, waitUntilReady, unmount } =
      await renderWithProviders(<ProviderDialog onClose={onClose} />, {
        settings,
        config,
      });

    // Press Enter on the menu's first row ("Switch active provider").
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();

    const frame = lastFrame();
    expect(frame).toContain('Switch active provider');
    expect(frame).toContain('Currently active: openai');
    // Built-ins
    expect(frame).toContain('OpenAI');
    expect(frame).toContain('Gemini');
    // Custom entry shown with [custom] tag
    expect(frame).toContain('My vLLM');
    expect(frame).toContain('[custom]');
    unmount();
  });

  it('Esc on the menu closes the dialog', async () => {
    const settings = createMockSettings();
    const config = makeFakeConfig();
    setActive(config, 'openai');

    const { stdin, waitUntilReady, unmount } = await renderWithProviders(
      <ProviderDialog onClose={onClose} />,
      { settings, config },
    );

    await act(async () => {
      stdin.write('\x1b');
    });
    await act(async () => {
      await waitUntilReady();
    });

    expect(onClose).toHaveBeenCalled();
    unmount();
  });

  it('add screen renders all five fields and the help text', async () => {
    const settings = createMockSettings();
    const config = makeFakeConfig();
    setActive(config, 'openai');

    const { lastFrame, stdin, waitUntilReady, unmount } =
      await renderWithProviders(<ProviderDialog onClose={onClose} />, {
        settings,
        config,
      });

    // Phase 2.3.1: openai has requiresApiKey=true, so the menu now
    // includes "Set API key" between Edit and Add.
    // Switch=0, Edit=1, SetKey=2, Add=3 — three downs from the top.
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        stdin.write('\x1b[B'); // down
      });
    }
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();

    const frame = lastFrame();
    expect(frame).toContain('Add custom OpenAI-compat provider');
    expect(frame).toContain('Provider id');
    expect(frame).toContain('Display name');
    expect(frame).toContain('Base URL');
    expect(frame).toContain('Default model');
    expect(frame).toContain('API key env var');
    unmount();
  });

  it('remove screen lists only custom entries when present', async () => {
    const settings = createMockSettings();
    const config = makeFakeConfig();
    setActive(config, 'openai');
    setCustom(config, {
      'my-vllm': {
        displayName: 'My vLLM',
        baseUrl: 'http://127.0.0.1:8000/v1/chat/completions',
      },
      'my-llamacpp': {
        displayName: 'My llama.cpp',
        baseUrl: 'http://127.0.0.1:8080/v1/chat/completions',
      },
    });

    const { lastFrame, stdin, waitUntilReady, unmount } =
      await renderWithProviders(<ProviderDialog onClose={onClose} />, {
        settings,
        config,
      });

    // Phase 2.3.1: openai exposes "Set API key" between Edit and Add,
    // so Remove is now at index 4 (Switch=0, Edit=1, SetKey=2, Add=3,
    // Remove=4) — four downs from the top.
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        stdin.write('\x1b[B');
      });
    }
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();

    const frame = lastFrame();
    expect(frame).toContain('Remove custom provider');
    expect(frame).toContain('My vLLM');
    expect(frame).toContain('My llama.cpp');
    // Built-ins must never appear in the remove list.
    expect(frame).not.toContain('OpenAI');
    expect(frame).not.toContain('Gemini');
    unmount();
  });

  it('edit screen renders settings rows for an active custom provider', async () => {
    // Regression: prior to the schema-alias fix, the dialog rendered
    // "No matches found" because `getFlattenedSchema()` only declares
    // `providers.openai.*` entries. Custom providers (always
    // OpenAI-compat) must inherit the openai schema metadata at runtime
    // so the edit sheet can show Model / Base URL / Context Limit /
    // etc. for them.
    const settings = createMockSettings();
    const config = makeFakeConfig();
    setCustom(config, {
      'edit-test-vllm': {
        displayName: 'Edit-Test vLLM',
        baseUrl: 'http://127.0.0.1:9999/v1/chat/completions',
      },
    });
    setActive(config, 'edit-test-vllm');

    const { lastFrame, stdin, waitUntilReady, unmount } =
      await renderWithProviders(<ProviderDialog onClose={onClose} />, {
        settings,
        config,
      });

    // Menu for a custom (non-Gemini) provider: Switch=0, Edit=1.
    await act(async () => {
      stdin.write('\x1b[B'); // down to Edit
    });
    await act(async () => {
      stdin.write('\r'); // Enter
    });
    await waitUntilReady();

    const frame = lastFrame();
    expect(frame).not.toContain('No matches found');
    // The header still names the provider.
    expect(frame).toContain('Edit-Test vLLM');
    // Sample of fields inherited from the openai schema.
    expect(frame).toMatch(/Model/);
    expect(frame).toMatch(/Base URL/);
    expect(frame).toMatch(/Context Window Limit/);
    unmount();
  });

  it('remove screen shows the empty state when there are no custom providers', async () => {
    const settings = createMockSettings();
    const config = makeFakeConfig();
    setActive(config, 'openai');

    const { lastFrame, waitUntilReady, unmount } = await renderWithProviders(
      <ProviderDialog onClose={onClose} />,
      { settings, config },
    );

    // The menu refuses to enter the Remove screen when customCount === 0
    // (defensive guard inside MenuScreen.onSelect). Verify the
    // 'no custom providers to remove' hint is present in the sublabel
    // so users know why the action is a no-op.
    await waitUntilReady();
    expect(lastFrame()).toContain('no custom providers to remove');
    unmount();
  });
});
