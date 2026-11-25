import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRelativeTime,
  formatTtlRemaining,
  prepareSandboxedEmailHtml,
} from './format.ts';

test('formatRelativeTime formats seconds, minutes, hours, and days', () => {
  const now = Date.UTC(2026, 10, 22, 12, 0, 0);
  assert.equal(formatRelativeTime(new Date(now - 4000).toISOString(), now), 'just now');
  assert.equal(formatRelativeTime(new Date(now - 45000).toISOString(), now), '45s ago');
  assert.equal(formatRelativeTime(new Date(now - 5 * 60000).toISOString(), now), '5m ago');
  assert.equal(formatRelativeTime(new Date(now - 3 * 3600000).toISOString(), now), '3h ago');
});

test('formatTtlRemaining formats persistent, active, and expired states', () => {
  const now = Date.UTC(2026, 10, 22, 12, 0, 0);
  assert.equal(formatTtlRemaining(null, now), 'Persistent');
  assert.equal(formatTtlRemaining(new Date(now - 1000).toISOString(), now), 'Expired');
  assert.equal(formatTtlRemaining(new Date(now + 15 * 60000).toISOString(), now), '15m TTL');
  assert.equal(formatTtlRemaining(new Date(now + 24 * 3600000).toISOString(), now), '24h TTL');
});

test('prepareSandboxedEmailHtml blocks scripts and toggles image CSP', () => {
  const blocked = prepareSandboxedEmailHtml('<script>alert(1)</script><p>Hi</p>', false);
  assert.equal(blocked.includes('<script>'), false);
  assert.equal(blocked.includes('img-src data:;'), true);

  const allowed = prepareSandboxedEmailHtml('<p>Hi</p>', true);
  assert.equal(allowed.includes('img-src https: http: data:;'), true);

  const fullDoc = prepareSandboxedEmailHtml(
    '<html><head><title>Mail</title></head><body><a href="https://example.com/verify" target="_self">Verify Email</a></body></html>',
    false,
  );
  assert.equal(fullDoc.includes('<base target="_blank">'), true);
  assert.equal(fullDoc.includes('target="_self"'), false);
  assert.equal(fullDoc.includes('Content-Security-Policy'), true);

  const noHeadDoc = prepareSandboxedEmailHtml(
    '<html><body><a href="https://example.com/confirm">Confirm</a></body></html>',
    false,
  );
  assert.equal(noHeadDoc.includes('<head><meta charset="utf-8">'), true);
  assert.equal(noHeadDoc.includes('<base target="_blank">'), true);
});
