/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// --- LOCAL FORK ADDITION (Phase 2.4.7: opt-in wire-level logger) ---
// Redaction & no-op-when-unset regression tests for wireLogger. The
// logger writes to a real file when GEMINI_WIRE_LOG is set, so we
// drive that env var to a tmpdir and assert the on-disk content
// after each event.
// --- END LOCAL FORK ADDITION ---

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isWireLoggingEnabled } from './wireLogger.js';

const ENV_VAR = 'GEMINI_WIRE_LOG';

async function flushAndRead(file: string): Promise<string> {
  // The write stream is async; give it a tick to flush before reading.
  await new Promise((r) => setTimeout(r, 25));
  return fs.readFileSync(file, 'utf8');
}

describe('wireLogger', () => {
  let tmpFile: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env[ENV_VAR];
    tmpFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'wirelogger-')),
      'wire.log',
    );
    process.env[ENV_VAR] = tmpFile;
    // Reset the module-internal lazy stream cache so each test gets a
    // fresh file handle pointed at its own tmp file.
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = originalEnv;
    try {
      fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('isWireLoggingEnabled reflects the env var', async () => {
    expect(isWireLoggingEnabled()).toBe(true);
    delete process.env[ENV_VAR];
    expect(isWireLoggingEnabled()).toBe(false);
  });

  it('is a no-op when the env var is unset', async () => {
    delete process.env[ENV_VAR];
    const fresh = await import('./wireLogger.js');
    fresh.logWire({
      kind: 'request',
      generator: 'openai-chat',
      url: 'https://example.com/v1/chat/completions',
      method: 'POST',
    });
    expect(fs.existsSync(tmpFile)).toBe(false);
  });

  it('redacts Bearer header values to a length hint', async () => {
    const fresh = await import('./wireLogger.js');
    fresh.logWire({
      kind: 'request',
      generator: 'openai-chat',
      url: 'https://api.openai.com/v1/chat/completions',
      method: 'POST',
      headers: {
        Authorization: 'Bearer sk-PLAINTEXT-CANARY-9zX1A2b3C4d5e6F7g8H9i0',
        'Content-Type': 'application/json',
      },
    });
    const log = await flushAndRead(tmpFile);
    expect(log).not.toContain('sk-PLAINTEXT-CANARY');
    expect(log).toContain('Bearer <REDACTED:len=');
    expect(log).toContain('"Content-Type":"application/json"');
  });

  it('redacts X-Api-Key, Cookie, and Set-Cookie entirely', async () => {
    const fresh = await import('./wireLogger.js');
    fresh.logWire({
      kind: 'response',
      generator: 'openai-chat',
      url: 'https://example.com/v1/chat/completions',
      status: 200,
      ok: true,
      headers: {
        'X-Api-Key': 'sk-X-API-KEY-CANARY',
        Cookie: 'session=COOKIE-CANARY',
        'Set-Cookie': 'session=SET-COOKIE-CANARY',
      },
    });
    const log = await flushAndRead(tmpFile);
    expect(log).not.toContain('CANARY');
    expect(log).toMatch(/<REDACTED>/);
  });

  it('masks sk-... and Bearer tokens that leak into the body', async () => {
    const fresh = await import('./wireLogger.js');
    const leakyBody = JSON.stringify({
      messages: [
        {
          role: 'user',
          content: 'my key is sk-LEAK-CANARY-9zX1A2b3C4d5e6F7g8H9i0',
        },
      ],
      note: 'Authorization: Bearer LEAK-BEARER-CANARY-9zX1A2b3C4d5',
    });
    fresh.logWire({
      kind: 'request',
      generator: 'openai-chat',
      url: 'https://api.openai.com/v1/chat/completions',
      method: 'POST',
      body: leakyBody,
    });
    const log = await flushAndRead(tmpFile);
    expect(log).not.toContain('LEAK-CANARY');
    expect(log).not.toContain('LEAK-BEARER-CANARY');
    expect(log).toContain('sk-<REDACTED>');
    expect(log).toContain('Bearer <REDACTED>');
  });

  it('writes one NDJSON line per event', async () => {
    const fresh = await import('./wireLogger.js');
    fresh.logWire({
      kind: 'request',
      generator: 'openai-chat',
      url: 'https://example.com/v1/chat/completions',
      method: 'POST',
    });
    fresh.logWire({
      kind: 'response',
      generator: 'openai-chat',
      url: 'https://example.com/v1/chat/completions',
      status: 200,
      ok: true,
    });
    const log = await flushAndRead(tmpFile);
    const lines = log.trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(() => JSON.parse(l)).not.toThrow();
    }
    const r0 = JSON.parse(lines[0]);
    const r1 = JSON.parse(lines[1]);
    expect(r0.kind).toBe('request');
    expect(r1.kind).toBe('response');
    expect(r0.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('truncates oversize bodies and reports the original size', async () => {
    const fresh = await import('./wireLogger.js');
    const big = 'A'.repeat(50_000);
    fresh.logWire({
      kind: 'response',
      generator: 'openai-chat',
      url: 'https://example.com/v1/chat/completions',
      status: 500,
      ok: false,
      body: big,
    });
    const log = await flushAndRead(tmpFile);
    const entry = JSON.parse(log.trim());
    expect(entry.bodyTruncated).toBe(true);
    expect(entry.bodyTotalBytes).toBe(50_000);
    expect((entry.body as string).length).toBeLessThan(big.length);
  });
});
