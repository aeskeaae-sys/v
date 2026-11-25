# Firestore Security Specification (`security_spec.md`)

## 1. Data Invariants
1. **Identity Ownership & Verified Email**: Every document under `/users/{userId}` and its subcollections (`/private/info`, `/savedInboxes/{inboxId}`, `/savedOtps/{otpId}`) is strictly readable and writable only by the authenticated owner whose `request.auth.uid == userId` and `request.auth.token.email_verified == true`.
2. **PII Isolation**: User email addresses are stored exclusively in `/users/{userId}/private/info`, never in public or listable collections.
3. **Master Gate & Parent Integrity**:
   - A `savedInboxes/{inboxId}` document cannot exist without its parent `/users/{userId}` profile.
   - A `savedOtps/{otpId}` document cannot exist without both its parent `/users/{userId}` profile and the referenced `/users/{userId}/savedInboxes/{inboxId}` mailbox.
4. **Immutable Ownership & Timestamps**: `uid`, `ownerUid`, `id`, `address`, `mode`, `provider`, and `createdAt` cannot be modified after creation. `createdAt` and `updatedAt` must equal `request.time`.
5. **Bounded Payloads & Strict Keys**: Every string field enforces explicit `.size()` bounds matching `firebase-blueprint.json`, every document ID enforces `^[a-zA-Z0-9_\-]+$` (max 128 chars), and `keys().hasOnly(...)` / `affectedKeys().hasOnly(...)` block shadow or privilege fields.

## 2. The "Dirty Dozen" Adversarial Payloads (Must All Return PERMISSION_DENIED)
1. **Unauthenticated Read/Write**: Read or write `/users/alice/savedInboxes/inb_1` with `request.auth == null`.
2. **Unverified Email Write**: Create `/users/alice/savedInboxes/inb_1` with `email_verified: false`.
3. **Cross-User Read (PII Leak)**: User `bob` attempts `get` on `/users/alice/private/info`.
4. **UID Spoofing on Create**: User `bob` creates `/users/bob/savedInboxes/inb_1` with `ownerUid: "alice"`.
5. **Shadow Field Injection**: User `alice` creates `/users/alice` with `{ uid: "alice", displayName: "Alice", isAdmin: true, createdAt: serverTimestamp, updatedAt: serverTimestamp }`.
6. **Privilege Role Escalation on Update**: User `alice` updates `/users/alice` adding `role: "admin"` (`affectedKeys` fails).
7. **ID Poisoning**: Create `/users/alice/savedInboxes/../../../etc/passwd` or 200-char ID (`isValidId` rejects).
8. **Orphaned OTP Creation**: Create `/users/alice/savedOtps/otp_1` referencing nonexistent `inboxId: "inb_missing"` (`exists` / `existsAfter` rejects).
9. **Timestamp Forgery**: Create `/users/alice/savedInboxes/inb_1` with client-supplied past timestamp `createdAt` (`!= request.time`).
10. **Immutable Field Mutation**: Update `/users/alice/savedInboxes/inb_1` changing `address` or `ownerUid`.
11. **Value Poisoning / Oversized String**: Update `/users/alice/savedInboxes/inb_1` with a 500-char `label` (exceeds `maxLength: 120`).
12. **Blanket List Query Scraping**: User `bob` runs a collection query against `/users/alice/savedInboxes` or attempts `list` on `/users`.
