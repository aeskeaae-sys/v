import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const blueprint = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'firebase-blueprint.json'), 'utf8'),
) as {
  entities: Record<
    string,
    {
      properties: Record<string, { maxLength?: number; minLength?: number; pattern?: string; enum?: string[] }>;
      required: string[];
    }
  >;
};

const rulesSource = fs.readFileSync(path.resolve(process.cwd(), 'firestore.rules'), 'utf8');

test('firestore.rules enforces Eight Pillars and matches firebase-blueprint.json constraints', () => {
  // 1. Default deny catch-all
  assert.match(rulesSource, /match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;\s*\}/);

  // 2. Verified email & strict owner isolation
  assert.match(rulesSource, /request\.auth\.token\.email_verified == true/);
  assert.match(rulesSource, /allow list: if false;/);
  assert.match(rulesSource, /match \/private\/\{docId\}/);

  // 3. Strict ID pattern and key allowlisting matching blueprint
  const idPattern = blueprint.entities.SavedInbox.properties.id.pattern;
  assert.equal(idPattern, '^[a-zA-Z0-9_\\-]+$');
  assert.ok(rulesSource.includes("id.matches('^[a-zA-Z0-9_\\\\-]+$')"));
  assert.ok(rulesSource.includes('affectedKeys().hasOnly('));
  assert.ok(rulesSource.includes('existsAfter('));
  assert.ok(rulesSource.includes('request.time'));
});

test('Dirty Dozen payload invariant checks enforce blueprint limits', () => {
  const inboxProps = blueprint.entities.SavedInbox.properties;
  const idRegex = new RegExp(inboxProps.id.pattern || '^[a-zA-Z0-9_\\-]+$');

  // Dirty payload #7: Path traversal / oversized ID
  assert.equal(idRegex.test('../../../etc/passwd'), false);
  assert.equal('x'.repeat(129).length <= (inboxProps.id.maxLength ?? 128), false);

  // Dirty payload #11: Oversized label poisoning
  const oversizedLabel = 'a'.repeat(500);
  assert.equal(oversizedLabel.length <= (inboxProps.label.maxLength ?? 120), false);

  // Dirty payload #5: Shadow key detection against required + allowed keys
  const allowedKeys = new Set(Object.keys(inboxProps));
  const shadowPayloadKeys = [...blueprint.entities.SavedInbox.required, 'isAdmin'];
  assert.equal(
    shadowPayloadKeys.every((k) => allowedKeys.has(k)),
    false,
  );
});
