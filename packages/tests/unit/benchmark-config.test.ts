/**
 * unit/benchmark-config.test.ts
 *
 * Tests for BenchmarkConfig validation logic.
 */

import { describe, it, expect } from 'vitest';
import { validateBenchmarkConfig } from '../../packages/server/src/benchmark/BenchmarkEngine';

describe('validateBenchmarkConfig', () => {
  const VALID: Parameters<typeof validateBenchmarkConfig>[0] = {
    userCount: 5,
    durationSeconds: 60,
    targetUrl: 'ws://localhost:3001/ws',
  };

  it('accepts a valid minimal config', () => {
    expect(validateBenchmarkConfig(VALID)).toHaveLength(0);
  });

  it('accepts a ws:// URL', () => {
    const errs = validateBenchmarkConfig({ ...VALID, targetUrl: 'ws://example.com/ws' });
    expect(errs).toHaveLength(0);
  });

  it('accepts a wss:// URL', () => {
    const errs = validateBenchmarkConfig({ ...VALID, targetUrl: 'wss://example.com/ws' });
    expect(errs).toHaveLength(0);
  });

  it('rejects http:// URL', () => {
    const errs = validateBenchmarkConfig({ ...VALID, targetUrl: 'http://example.com' });
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
    expect(errs.length).toBeGreaterThanOrEqual(3);
  });
});
