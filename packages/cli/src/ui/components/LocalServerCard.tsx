/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';

// --- LOCAL FORK ADDITION ---
// Forward-compatibility view shape so the dialog can grow from
// "one local server" to "many named local servers (with auto-routing)"
// without rewriting the presentation layer.
//
// Today only one card is rendered ('default'). When multi-server lands,
// the parent simply maps over an array of these views.
export interface LocalServerView {
  /** Stable identifier. Today always 'default'. */
  id: string;
  /** Human label for the card header. */
  label: string;
  /** Server URL (currently `local.url`). */
  url: string;
  /** Configured model name (currently `local.model`). */
  model: string;
  /** Request timeout in ms (currently `local.timeout`). */
  timeoutMs: number;
  /**
   * Reserved for future "fast vs big vs auto" tier-routing (Gemini-style
   * flash/pro). Not rendered today.
   */
  role?: 'fast' | 'big' | 'auto';
}

export interface ReachabilityState {
  status: 'idle' | 'checking' | 'reachable' | 'unreachable';
  modelCount?: number;
  error?: string;
}

interface LocalServerCardProps {
  view: LocalServerView;
  reachability: ReachabilityState;
}

/**
 * Read-only summary card for a single local LLM server. Field editing happens
 * in the surrounding `LocalDialog` (which is built on `BaseSettingsDialog`),
 * so this component is intentionally presentation-only.
 */
export function LocalServerCard({
  view,
  reachability,
}: LocalServerCardProps): React.JSX.Element {
  const status = formatReachability(reachability);
  const urlDisplay = view.url || '(not configured)';
  const modelDisplay = view.model || '(default)';
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border.default}
      paddingX={1}
    >
      <Box>
        <Text bold color={theme.text.primary}>
          {view.label}
        </Text>
        <Text color={theme.text.secondary}> ({view.id})</Text>
      </Box>
      <Box>
        <Text color={theme.text.secondary}>URL: </Text>
        <Text>{urlDisplay}</Text>
      </Box>
      <Box>
        <Text color={theme.text.secondary}>Model: </Text>
        <Text>{modelDisplay}</Text>
      </Box>
      <Box>
        <Text color={theme.text.secondary}>Timeout: </Text>
        <Text>{view.timeoutMs}ms</Text>
      </Box>
      <Box>
        <Text color={theme.text.secondary}>Status: </Text>
        <Text color={status.color}>{status.text}</Text>
      </Box>
    </Box>
  );
}

function formatReachability(r: ReachabilityState): {
  text: string;
  color: string;
} {
  switch (r.status) {
    case 'idle':
      return { text: 'Not checked', color: theme.text.secondary };
    case 'checking':
      return { text: 'Checking...', color: theme.text.secondary };
    case 'reachable':
      return {
        text: `Reachable (${r.modelCount ?? 0} model${
          r.modelCount === 1 ? '' : 's'
        } discovered)`,
        color: theme.status.success,
      };
    case 'unreachable':
      return {
        text: `Unreachable${r.error ? ` - ${r.error}` : ''}`,
        color: theme.status.error,
      };
    default:
      return { text: 'Unknown', color: theme.text.secondary };
  }
}
