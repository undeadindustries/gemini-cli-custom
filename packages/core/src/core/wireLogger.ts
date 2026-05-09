/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// --- LOCAL FORK ADDITION (Phase 2.4.7: opt-in wire-level logger) ---
//
// Diagnostic logger for OpenAI-compat HTTP traffic. Captures every request
// (URL, method, headers, body) and every response (status, headers, body
// preview) to a file specified by the `GEMINI_WIRE_LOG` env var.
//
// USAGE
//   GEMINI_WIRE_LOG=/tmp/gemini-wire.log node packages/cli/dist/index.js
//
// Logs are NDJSON-style (one JSON object per line) so they grep / jq cleanly.
//
// SECURITY
//   - Authorization headers are redacted to `Bearer <REDACTED:length>`.
//   - X-Api-Key / X-Auth-Token / Cookie / Set-Cookie are redacted entirely.
//   - Body strings are scanned for `sk-...` / `sk-or-...` / `Bearer ...`
//     fragments and those substrings are masked. The scan is bounded
//     (we never log more than `MAX_BODY_BYTES` of any payload) so a
//     binary blob can't blow up the log.
//   - When the env var is unset, this module does literally nothing
//     (no file open, no allocation per call beyond an early return).
//
// SCOPE
//   This is a developer-debug aid, not a production audit log. It is
//   deliberately inside the local fork so it never touches the upstream
//   Gemini path.

import * as fs from 'node:fs';

const ENV_VAR = 'GEMINI_WIRE_LOG';
const MAX_BODY_BYTES = 16 * 1024;
const REDACTED_HEADER_NAMES = new Set([
  'authorization',
  'x-api-key',
  'x-auth-token',
  'cookie',
  'set-cookie',
]);

/** Single-line `Bearer <key>` header values; preserves the length hint. */
function redactBearer(value: string): string {
  const m = value.match(/^Bearer\s+(.+)$/i);
  if (!m) return '<REDACTED>';
  return `Bearer <REDACTED:len=${m[1].length}>`;
}

function redactHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (key === 'authorization') {
      out[k] = redactBearer(v);
    } else if (REDACTED_HEADER_NAMES.has(key)) {
      out[k] = '<REDACTED>';
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Mask common API-key shapes inside a body string. Pattern set is
 * intentionally narrow — we only mask things that look like keys, not
 * arbitrary high-entropy strings (which would mangle assistant outputs).
 */
function redactBody(body: string): string {
  if (!body) return body;
  return (
    body
      // OpenAI-style `sk-...` and OpenRouter `sk-or-v1-...` keys. Both use
      // dashes (e.g. `sk-proj-...`, `sk-or-v1-...`) and alphanumerics as
      // the trailing material, so the character class includes `-` / `_`.
      // The `{16,}` minimum prevents masking incidental short matches like
      // `sk-id` mentioned in prose.
      .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-<REDACTED>')
      // Bearer tokens that may have leaked into stringified JSON bodies.
      .replace(/Bearer\s+[A-Za-z0-9._-]{16,}/gi, 'Bearer <REDACTED>')
  );
}

function truncate(body: string): {
  preview: string;
  truncated: boolean;
  totalBytes: number;
} {
  const buf = Buffer.from(body, 'utf8');
  const totalBytes = buf.length;
  if (totalBytes <= MAX_BODY_BYTES) {
    return { preview: body, truncated: false, totalBytes };
  }
  return {
    preview: buf.subarray(0, MAX_BODY_BYTES).toString('utf8'),
    truncated: true,
    totalBytes,
  };
}

/**
 * Lazily-opened append stream. We only touch the filesystem on first
 * write and never throw out of `logWire()` — diagnostic logging must
 * never break the request path.
 */
let stream: fs.WriteStream | undefined | null = null;

function getStream(): fs.WriteStream | undefined {
  if (stream !== null) return stream ?? undefined;
  const path = process.env[ENV_VAR];
  if (!path) {
    stream = undefined;
    return undefined;
  }
  try {
    stream = fs.createWriteStream(path, { flags: 'a' });
    stream.on('error', () => {
      // Best-effort: drop further writes on error rather than crash.
      stream = undefined;
    });
    return stream;
  } catch {
    stream = undefined;
    return undefined;
  }
}

export interface WireRequestEvent {
  kind: 'request';
  generator: 'openai-chat' | 'openai-responses';
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface WireResponseEvent {
  kind: 'response';
  generator: 'openai-chat' | 'openai-responses';
  url: string;
  status: number;
  ok: boolean;
  headers?: Record<string, string>;
  body?: string;
}

export interface WireErrorEvent {
  kind: 'error';
  generator: 'openai-chat' | 'openai-responses';
  url: string;
  phase: 'fetch' | 'preflight' | 'parse' | 'timeout';
  message: string;
}

export type WireEvent = WireRequestEvent | WireResponseEvent | WireErrorEvent;

/**
 * Write a diagnostic event to the wire log. No-op when the env var is
 * unset. Never throws.
 */
export function logWire(ev: WireEvent): void {
  const s = getStream();
  if (!s) return;
  try {
    const ts = new Date().toISOString();
    const sanitized: Record<string, unknown> = {};
    Object.assign(sanitized, { ts }, ev);
    if ('headers' in ev && ev.headers) {
      sanitized['headers'] = redactHeaders(ev.headers);
    }
    if ('body' in ev && typeof ev.body === 'string') {
      const { preview, truncated, totalBytes } = truncate(redactBody(ev.body));
      sanitized['body'] = preview;
      sanitized['bodyTruncated'] = truncated;
      sanitized['bodyTotalBytes'] = totalBytes;
    }
    s.write(JSON.stringify(sanitized) + '\n');
  } catch {
    // Never let logging break the caller.
  }
}

/** True iff GEMINI_WIRE_LOG is set. Cheap; safe to call per request. */
export function isWireLoggingEnabled(): boolean {
  return !!process.env[ENV_VAR];
}
// --- END LOCAL FORK ADDITION ---
