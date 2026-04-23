/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * --- LOCAL FORK ADDITION (Phase 2.0) ---
 */

import { describe, it, expect } from 'vitest';
import type { Content } from '@google/genai';
import {
  ejectStaleWriteFileContent,
  WRITE_FILE_EJECTION_TAG,
} from './writeFileEjection.js';

const WRITE = 'write_file';

function bigContent(): string {
  return 'x'.repeat(8_000);
}

function entry(role: 'user' | 'model', text: string): Content {
  return { role, parts: [{ text }] };
}

function writeFileCall(
  filePath: string,
  content: string,
  role: 'model' | 'user' = 'model',
): Content {
  return {
    role,
    parts: [
      {
        functionCall: {
          id: 'call-1',
          name: WRITE,
          args: { file_path: filePath, content },
        },
      },
    ],
  };
}

describe('ejectStaleWriteFileContent', () => {
  it('preserves the leading 2 entries', () => {
    const history: Content[] = [
      writeFileCall('/leading.txt', bigContent()),
      writeFileCall('/leading2.txt', bigContent()),
      entry('user', 'something'),
      entry('model', 'something else'),
      entry('user', 'and another'),
      entry('model', 'final'),
    ];
    const result = ejectStaleWriteFileContent(history, {
      writeFileToolName: WRITE,
      exemptTools: new Set(),
      protectLatestTurn: true,
      minAgeTurns: 1,
      minTokensPerCall: 100,
    });
    // Leading 2 entries should still have raw content.
    const args0 = (
      result.newHistory[0]?.parts?.[0] as {
        functionCall?: { args?: { content?: string } };
      }
    )?.functionCall?.args?.content;
    const args1 = (
      result.newHistory[1]?.parts?.[0] as {
        functionCall?: { args?: { content?: string } };
      }
    )?.functionCall?.args?.content;
    expect(args0).toBe(bigContent());
    expect(args1).toBe(bigContent());
  });

  it('ejects stale write_file content older than minAgeTurns', () => {
    const big = bigContent();
    const history: Content[] = [
      entry('user', 'lead 1'),
      entry('model', 'lead 2'),
      writeFileCall('/foo.ts', big), // idx 2 — eligible
      entry('model', 'response'),
      entry('user', 'next turn'),
      entry('model', 'latest turn'),
    ];
    const result = ejectStaleWriteFileContent(history, {
      writeFileToolName: WRITE,
      exemptTools: new Set(),
      protectLatestTurn: true,
      minAgeTurns: 1,
      minTokensPerCall: 100,
    });
    expect(result.ejectedCount).toBe(1);
    const part = result.newHistory[2]?.parts?.[0] as {
      functionCall?: { args?: { content?: string; file_path?: string } };
    };
    expect(part.functionCall?.args?.content).toContain(WRITE_FILE_EJECTION_TAG);
    expect(part.functionCall?.args?.file_path).toBe('/foo.ts');
    expect(result.tokensSaved).toBeGreaterThan(0);
  });

  it('does NOT eject calls in the protected latest turn', () => {
    const big = bigContent();
    const history: Content[] = [
      entry('user', 'lead 1'),
      entry('model', 'lead 2'),
      writeFileCall('/late.ts', big), // protected as latest
    ];
    const result = ejectStaleWriteFileContent(history, {
      writeFileToolName: WRITE,
      exemptTools: new Set(),
      protectLatestTurn: true,
      minAgeTurns: 1,
      minTokensPerCall: 100,
    });
    expect(result.ejectedCount).toBe(0);
    const part = result.newHistory[2]?.parts?.[0] as {
      functionCall?: { args?: { content?: string } };
    };
    expect(part.functionCall?.args?.content).toBe(big);
  });

  it('skips small payloads under minTokensPerCall', () => {
    const small = 'short';
    const history: Content[] = [
      entry('user', 'lead 1'),
      entry('model', 'lead 2'),
      writeFileCall('/small.ts', small),
      entry('model', 'response'),
      entry('user', 'next turn'),
    ];
    const result = ejectStaleWriteFileContent(history, {
      writeFileToolName: WRITE,
      exemptTools: new Set(),
      protectLatestTurn: true,
      minAgeTurns: 1,
      minTokensPerCall: 1_000,
    });
    expect(result.ejectedCount).toBe(0);
  });

  it('is idempotent — re-running on already-ejected history is a no-op', () => {
    const big = bigContent();
    const history: Content[] = [
      entry('user', 'lead 1'),
      entry('model', 'lead 2'),
      writeFileCall('/foo.ts', big),
      entry('model', 'response'),
      entry('user', 'next turn'),
      entry('model', 'latest'),
    ];
    const opts = {
      writeFileToolName: WRITE,
      exemptTools: new Set<string>(),
      protectLatestTurn: true,
      minAgeTurns: 1,
      minTokensPerCall: 100,
    };
    const first = ejectStaleWriteFileContent(history, opts);
    expect(first.ejectedCount).toBe(1);
    const second = ejectStaleWriteFileContent(first.newHistory, opts);
    expect(second.ejectedCount).toBe(0);
  });

  it('respects exemptTools — never ejects if tool name is exempt', () => {
    // Pretend write_file itself was added to the exempt set (defensive).
    const big = bigContent();
    const history: Content[] = [
      entry('user', 'lead 1'),
      entry('model', 'lead 2'),
      writeFileCall('/foo.ts', big),
      entry('model', 'response'),
      entry('user', 'next turn'),
    ];
    const result = ejectStaleWriteFileContent(history, {
      writeFileToolName: WRITE,
      exemptTools: new Set([WRITE]),
      protectLatestTurn: true,
      minAgeTurns: 1,
      minTokensPerCall: 100,
    });
    expect(result.ejectedCount).toBe(0);
  });

  it('does not mutate the input history array', () => {
    const big = bigContent();
    const history: Content[] = [
      entry('user', 'lead 1'),
      entry('model', 'lead 2'),
      writeFileCall('/foo.ts', big),
      entry('model', 'response'),
      entry('user', 'next turn'),
    ];
    const snapshot = JSON.stringify(history);
    ejectStaleWriteFileContent(history, {
      writeFileToolName: WRITE,
      exemptTools: new Set(),
      protectLatestTurn: true,
      minAgeTurns: 1,
      minTokensPerCall: 100,
    });
    expect(JSON.stringify(history)).toBe(snapshot);
  });
});
