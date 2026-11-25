import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRelativeTime, formatTtlRemaining, prepareSandboxedEmailHtml } from './format.ts';

test('formatRelativeTime formats seconds, minutes, hours, and days', () => {
  const now = Date.parse('2026-01-15T12:00:00.000Z');
  assert.equal(formatRelativeTime('2026-01-15T11:59:30.000Z', now), '30s ago');
  assert.equal(formatRelativeTime('2026-01-15T11:45:00.000Z', now), '15m ago');
  assert.equal(formatRelativeTime('2026-01-15T09:00:00.000Z', now), '3h ago');
  assert.equal(formatRelativeTime('2026-01-13T12:00:00.000Z', now), '2d ago');
});

test('formatTtlRemaining formats persistent, active, and expired states', () => {
  const now = Date.parse('2026-01-15T12:00:00.000Z');
  assert.equal(formatTtlRemaining(null, now), 'Persistent');
  assert.equal(formatTtlRemaining('2026-01-15T13:00:00.000Z', now), '1h left');
  assert.equal(formatTtlRemaining('2026-01-15T11:00:00.000Z', now), 'Expired');
});

test('prepareSandboxedEmailHtml blocks scripts and toggles image CSP', () => {
  const dirty = '<p>Hi</p><script>alert(1)</script><img src="x" onerror="alert(2)"><a href="javascript:alert(3)">x</a>';
  const clean = prepareSandboxedEmailHtml(dirty, false);
  assert.equal(clean.includes('<script'), false);
  assert.equal(clean.includes('onerror'), false);
  assert.equal(clean.includes('javascript:'), false);
  assert.equal(clean.includes('<img'), false);
  const withImg = prepareSandboxedEmailHtml('<img src="cid:1">', true);
  assert.equal(withImg.includes('<img'), true);
});
