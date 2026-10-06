/**
 * unit/benchmark-config.test.ts
 *
 * Tests for BenchmarkConfig validation logic.
 *
 * IMPORTANT: validateBenchmarkConfig now checks targetUrl against the
 * BENCHMARK_ALLOWED_TARGETS allowlist. Tests set this env var explicitly
 * so the allowlist is predictable and isolated from machine configuration.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateBenchmarkConfig } from '../../packages/server/src/benchmark/BenchmarkEngine';

// Set a controlled allowlist for all tests in this file
const ALLOWED_LOCAL = 'ws://localhost:3001/ws';
const ALLOWED_DEPLOYED = 'wss://peergriddemo-api.onrender.com/ws';

beforeEach(() => {
  process.env['BENCHMARK_ALLOWED_TARGETS'] = `${ALLOWED_LOCAL},${ALLOWED_DEPLOYED}`;
});

afterEach(() => {
  delete process.env['BENCHMARK_ALLOWED_TARGETS'];
});

describe('validateBenchmarkConfig', () => {
  const VALID: Parameters<typeof validateBenchmarkConfig>[0] = {
    userCount: 5,
    durationSeconds: 60,
    targetUrl: ALLOWED_LOCAL,
  };

  it('accepts a valid minimal config with local target', () => {
    expect(validateBenchmarkConfig(VALID)).toHaveLength(0);
  });

  it('accepts the deployed wss:// target from allowlist', () => {
    const errs = validateBenchmarkConfig({ ...VALID, targetUrl: ALLOWED_DEPLOYED });
    expect(errs).toHaveLength(0);
  });

  it('rejects a URL not in the allowlist (http://)', () => {
    const errs = validateBenchmarkConfig({ ...VALID, targetUrl: 'http://example.com' });
    expect(errs.some(e => e.field === 'targetUrl')).toBe(true);
  });

  it('rejects a URL not in the allowlist (arbitrary ws://)', () => {
    const errs = validateBenchmarkConfig({ ...VALID, targetUrl: 'ws://attacker.com/ws' });
    expect(errs.some(e => e.field === 'targetUrl')).toBe(true);
  });

  it('rejects internal/private address not in allowlist', () => {
    const errs = validateBenchmarkConfig({ ...VALID, targetUrl: 'ws://127.0.0.1:6379' });
    expect(errs.some(e => e.field === 'targetUrl')).toBe(true);
  });

  it('rejects empty targetUrl', () => {
    const errs = validateBenchmarkConfig({ ...VALID, targetUrl: '' });
    expect(errs.some(e => e.field === 'targetUrl')).toBe(true);
  });

  it('rejects userCount = 0', () => {
    const errs = validateBenchmarkConfig({ ...VALID, userCount: 0 });
    expect(errs.some(e => e.field === 'userCount')).toBe(true);
  });

  it('rejects userCount > 200', () => {
    const errs = validateBenchmarkConfig({ ...VALID, userCount: 201 });
    expect(errs.some(e => e.field === 'userCount')).toBe(true);
  });

  it('accepts userCount = 200', () => {
    const errs = validateBenchmarkConfig({ ...VALID, userCount: 200 });
    expect(errs.some(e => e.field === 'userCount')).toBe(false);
  });

  it('rejects durationSeconds < 10', () => {
    const errs = validateBenchmarkConfig({ ...VALID, durationSeconds: 5 });
    expect(errs.some(e => e.field === 'durationSeconds')).toBe(true);
  });

  it('rejects durationSeconds > 600', () => {
    const errs = validateBenchmarkConfig({ ...VALID, durationSeconds: 601 });
    expect(errs.some(e => e.field === 'durationSeconds')).toBe(true);
  });

  it('accepts durationSeconds at boundaries', () => {
    expect(validateBenchmarkConfig({ ...VALID, durationSeconds: 10 })).toHaveLength(0);
    expect(validateBenchmarkConfig({ ...VALID, durationSeconds: 600 })).toHaveLength(0);
  });

  it('rejects typingSpeed = 0', () => {
    const errs = validateBenchmarkConfig({ ...VALID, typingSpeed: 0 });
    expect(errs.some(e => e.field === 'typingSpeed')).toBe(true);
  });

  it('rejects typingSpeed > 50', () => {
    const errs = validateBenchmarkConfig({ ...VALID, typingSpeed: 51 });
    expect(errs.some(e => e.field === 'typingSpeed')).toBe(true);
  });

  it('accepts valid optional fields', () => {
    const errs = validateBenchmarkConfig({
      ...VALID,
      warmupSeconds: 15,
      cooldownSeconds: 10,
      typingSpeed: 2,
    });
    expect(errs).toHaveLength(0);
  });

  it('rejects warmupSeconds > 300', () => {
    const errs = validateBenchmarkConfig({ ...VALID, warmupSeconds: 301 });
    expect(errs.some(e => e.field === 'warmupSeconds')).toBe(true);
  });

  it('accepts warmupSeconds = 0 (no warmup)', () => {
    const errs = validateBenchmarkConfig({ ...VALID, warmupSeconds: 0 });
    expect(errs.some(e => e.field === 'warmupSeconds')).toBe(false);
  });

  it('returns multiple errors when multiple fields are invalid', () => {
    const errs = validateBenchmarkConfig({
      userCount: 0,
      durationSeconds: 1,
      targetUrl: 'not-a-url',
    });
    // userCount invalid + durationSeconds invalid + targetUrl not in allowlist
    expect(errs.length).toBeGreaterThanOrEqual(3);
  });

  it('accepts benchmarkMode latency', () => {
    const errs = validateBenchmarkConfig({ ...VALID, benchmarkMode: 'latency' });
    expect(errs).toHaveLength(0);
  });

  it('accepts benchmarkMode load', () => {
    const errs = validateBenchmarkConfig({ ...VALID, benchmarkMode: 'load' });
    expect(errs).toHaveLength(0);
  });

  it('uses local fallback when BENCHMARK_ALLOWED_TARGETS not set', () => {
    delete process.env['BENCHMARK_ALLOWED_TARGETS'];
    // Without env var, getAllowedBenchmarkTargets() falls back to ws://localhost:<PORT>/ws
    // which won't be ws://localhost:3001/ws unless PORT=3001
    process.env['PORT'] = '3001';
    const errs = validateBenchmarkConfig({ ...VALID, targetUrl: 'ws://localhost:3001/ws' });
    expect(errs.some(e => e.field === 'targetUrl')).toBe(false);
    delete process.env['PORT'];
  });
});
