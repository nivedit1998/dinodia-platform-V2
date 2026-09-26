import test from 'node:test';
import assert from 'node:assert/strict';
import { decideOperatorRateLimit } from '../src/lib/operatorRateLimitPolicy.mjs';

const HOUR = 60 * 60 * 1000;

test('operator mutation limit denies attempt six inside the one-hour window', () => {
  const now = new Date('2026-09-25T12:00:00.000Z');
  const result = decideOperatorRateLimit({ windowStart: new Date(now.getTime() - 10_000), attempts: 5, blockedUntil: null }, now);
  assert.equal(result.allowed, false);
  assert.equal(result.action, 'blocked');
  assert.ok(result.retryAfterMs > 0);
});

test('operator mutation limit resets exactly at the one-hour boundary', () => {
  const start = new Date('2026-09-25T12:00:00.000Z');
  const now = new Date(start.getTime() + HOUR);
  const result = decideOperatorRateLimit({ windowStart: start, attempts: 5, blockedUntil: null }, now);
  assert.equal(result.allowed, true);
  assert.equal(result.action, 'update');
  assert.equal(result.attempts, 1);
  assert.equal(result.attemptTimestamps.length, 1);
});

test('operator mutation limit still denies one millisecond before the one-hour boundary', () => {
  const start = new Date('2026-09-25T12:00:00.000Z');
  const now = new Date(start.getTime() + HOUR - 1);
  const result = decideOperatorRateLimit({ windowStart: start, attempts: 5, blockedUntil: null }, now);
  assert.equal(result.allowed, false);
  assert.equal(result.action, 'blocked');
  assert.equal(result.retryAfterMs, 1);
});

test('operator mutation limit remains reset immediately after the boundary', () => {
  const start = new Date('2026-09-25T12:00:00.000Z');
  const now = new Date(start.getTime() + HOUR + 1);
  const result = decideOperatorRateLimit({ windowStart: start, attempts: 5, blockedUntil: null }, now);
  assert.equal(result.allowed, true);
  assert.equal(result.action, 'update');
  assert.equal(result.attempts, 1);
  assert.equal(result.attemptTimestamps.length, 1);
});

test('active block is not bypassed before its persisted deadline', () => {
  const now = new Date('2026-09-25T12:00:00.000Z');
  const oldest = now.getTime() - HOUR + 30_000;
  const attemptTimestamps = Array.from({ length: 5 }, (_, index) => new Date(oldest + index).toISOString());
  const result = decideOperatorRateLimit({ windowStart: new Date(oldest), attempts: 5, attemptTimestamps, blockedUntil: null }, now);
  assert.equal(result.allowed, false);
  assert.equal(result.retryAfterMs, 30_000);
});

test('rolling hour retains four newer attempts as the oldest expires', () => {
  const start = new Date('2026-09-25T12:00:00.000Z');
  const attemptTimestamps = [0, 10, 20, 30, 40].map((minutes) => new Date(start.getTime() + minutes * 60_000).toISOString());
  const beforeOldestExpires = decideOperatorRateLimit({ windowStart: start, attempts: 5, attemptTimestamps, blockedUntil: null }, new Date(start.getTime() + HOUR - 1));
  assert.equal(beforeOldestExpires.allowed, false);
  assert.equal(beforeOldestExpires.retryAfterMs, 1);
  const atOldestExpiry = decideOperatorRateLimit({ windowStart: start, attempts: 5, attemptTimestamps, blockedUntil: null }, new Date(start.getTime() + HOUR));
  assert.equal(atOldestExpiry.allowed, true);
  assert.equal(atOldestExpiry.attempts, 5);
  assert.equal(atOldestExpiry.attemptTimestamps.length, 5);
});
