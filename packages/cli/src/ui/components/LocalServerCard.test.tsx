/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { renderWithProviders } from '../../test-utils/render.js';
import {
  LocalServerCard,
  type LocalServerView,
  type ReachabilityState,
} from './LocalServerCard.js';

const baseView: LocalServerView = {
  id: 'default',
  label: 'Local LLM Server',
  url: 'http://127.0.0.1:8000/v1/chat/completions',
  model: 'Qwen3-Coder',
  timeoutMs: 120000,
};

describe('<LocalServerCard />', () => {
  it('renders URL, model, and timeout fields', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <LocalServerCard view={baseView} reachability={{ status: 'idle' }} />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('Local LLM Server');
    expect(out).toContain('Qwen3-Coder');
    expect(out).toContain('120000ms');
    expect(out).toContain('http://127.0.0.1:8000');
    unmount();
  });

  it('shows "(not configured)" when URL is empty', async () => {
    const view: LocalServerView = { ...baseView, url: '' };
    const { lastFrame, unmount } = await renderWithProviders(
      <LocalServerCard view={view} reachability={{ status: 'idle' }} />,
    );
    expect(lastFrame() ?? '').toContain('(not configured)');
    unmount();
  });

  it('renders the reachable status with model count', async () => {
    const reach: ReachabilityState = {
      status: 'reachable',
      modelCount: 3,
    };
    const { lastFrame, unmount } = await renderWithProviders(
      <LocalServerCard view={baseView} reachability={reach} />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('Reachable');
    expect(out).toContain('3 models discovered');
    unmount();
  });

  it('renders the unreachable status with the error message', async () => {
    const reach: ReachabilityState = {
      status: 'unreachable',
      error: 'connection refused',
    };
    const { lastFrame, unmount } = await renderWithProviders(
      <LocalServerCard view={baseView} reachability={reach} />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('Unreachable');
    expect(out).toContain('connection refused');
    unmount();
  });
});
