/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '../../test-utils/render.js';
import { createMockSettings } from '../../test-utils/settings.js';
import { LocalDialog } from './LocalDialog.js';

// Stub the discovery call so the dialog doesn't try to hit the network.
vi.mock('@google/gemini-cli-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@google/gemini-cli-core')>();
  return {
    ...actual,
    fetchLocalModels: vi.fn(async () => []),
  };
});

describe('<LocalDialog />', () => {
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the server card header and the dialog title', async () => {
    const settings = createMockSettings({
      local: {
        url: 'http://127.0.0.1:8000/v1/chat/completions',
        model: 'Qwen3-Coder',
        timeout: 90000,
      },
    });

    const { lastFrame, unmount } = await renderWithProviders(
      <LocalDialog onClose={mockOnClose} />,
      { settings },
    );

    const out = lastFrame() ?? '';
    expect(out).toContain('Local LLM Server');
    expect(out).toContain('Local LLM');
    expect(out).toContain('Qwen3-Coder');
    unmount();
  });

  it('renders unconfigured state when local.url is empty', async () => {
    const settings = createMockSettings({
      local: {
        url: '',
        model: '',
      },
    });

    const { lastFrame, unmount } = await renderWithProviders(
      <LocalDialog onClose={mockOnClose} />,
      { settings },
    );

    expect(lastFrame() ?? '').toContain('(not configured)');
    unmount();
  });

  it('exposes local.* setting fields in the dialog', async () => {
    const settings = createMockSettings({
      local: {
        url: 'http://127.0.0.1:8000/v1/chat/completions',
        model: 'Qwen3-Coder',
        contextLimit: 32768,
      },
    });

    const { lastFrame, unmount } = await renderWithProviders(
      <LocalDialog onClose={mockOnClose} />,
      { settings },
    );

    const out = lastFrame() ?? '';
    // At least one of the local.* settings labels should appear.
    expect(
      out.includes('Local LLM URL') ||
        out.includes('Local Model Name') ||
        out.includes('Context Window Limit') ||
        out.includes('Compression Threshold'),
    ).toBe(true);
    unmount();
  });
});
