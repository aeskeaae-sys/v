import type { User } from 'firebase/auth';
import {
  deleteDoc,
  doc,
  getDoc,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';
import type { Inbox, InboxMode, InboxProvider, InboxStatus, OtpEntry } from '../../shared/types';
import firebaseBlueprint from '../../firebase-blueprint.json';
import { db, handleFirestoreError, OperationType } from './firebase';

const entities = firebaseBlueprint.entities;

const ID_PATTERN = new RegExp(entities.SavedInbox.properties.id.pattern);
const MAX_ID_LEN = entities.SavedInbox.properties.id.maxLength;
const MAX_DISPLAY_NAME_LEN = entities.UserProfile.properties.displayName.maxLength;
const MAX_PHOTO_URL_LEN = entities.UserProfile.properties.photoUrl.maxLength;
const MAX_EMAIL_LEN = entities.UserPrivateInfo.properties.email.maxLength;
const MAX_LABEL_LEN = entities.SavedInbox.properties.label.maxLength;
const MAX_OTP_CODE_LEN = entities.SavedOtp.properties.code.maxLength;
const MAX_SUBJECT_LEN = entities.SavedOtp.properties.subject.maxLength;
const MAX_SENDER_LEN = entities.SavedOtp.properties.sender.maxLength;
const MAX_ACTION_URL_LEN = entities.SavedOtp.properties.actionUrl.maxLength;

const ALLOWED_MODES = new Set<string>(entities.SavedInbox.properties.mode.enum);
const ALLOWED_PROVIDERS = new Set<string>(entities.SavedInbox.properties.provider.enum);
const ALLOWED_STATUSES = new Set<string>(entities.SavedInbox.properties.status.enum);

export interface CloudSavedInbox {
  id: string;
  ownerUid: string;
  address: string;
  mode: InboxMode;
  provider: InboxProvider;
  label: string;
  status: InboxStatus;
  messageCount: number;
}

export interface CloudSavedOtp {
  id: string;
  ownerUid: string;
  inboxId: string;
  inboxAddress: string;
  code: string;
  subject: string;
  sender: string;
  actionUrl?: string;
}

function sanitizeSafeId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, MAX_ID_LEN);
  return ID_PATTERN.test(cleaned) ? cleaned : `id_${Date.now()}`;
}

export async function syncUserProfileToFirestore(user: User): Promise<void> {
  if (!user.uid || !user.emailVerified || !user.email) return;

  const uid = sanitizeSafeId(user.uid);
  if (uid !== user.uid) return;

  const userPath = `users/${uid}`;
  const privatePath = `users/${uid}/private/info`;
  const userRef = doc(db, 'users', uid);
  const privateRef = doc(db, 'users', uid, 'private', 'info');

  const displayName =
    (user.displayName || user.email.split('@')[0] || 'RelayBox User')
      .trim()
      .slice(0, MAX_DISPLAY_NAME_LEN) || 'RelayBox User';
  const photoUrl =
    typeof user.photoURL === 'string' && user.photoURL.trim().length > 0
      ? user.photoURL.trim().slice(0, MAX_PHOTO_URL_LEN)
      : undefined;
  const email = user.email.trim().slice(0, MAX_EMAIL_LEN);

  let userSnap;
  try {
    userSnap = await getDoc(userRef);
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, userPath);
  }

  let privateSnap;
  try {
    privateSnap = await getDoc(privateRef);
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, privatePath);
  }

  try {
    const batch = writeBatch(db);
    if (!userSnap.exists()) {
      batch.set(userRef, {
        uid,
        displayName,
        ...(photoUrl ? { photoUrl } : {}),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      batch.update(userRef, {
        displayName,
        ...(photoUrl ? { photoUrl } : {}),
        updatedAt: serverTimestamp(),
      });
    }

    if (!privateSnap.exists()) {
      batch.set(privateRef, {
        uid,
        email,
        updatedAt: serverTimestamp(),
      });
    } else {
      batch.update(privateRef, {
        email,
        updatedAt: serverTimestamp(),
      });
    }

    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, userPath);
  }
}

export async function syncInboxesAndOtpsToFirestore(
  user: User,
  inboxes: Inbox[],
  otps: OtpEntry[],
  existingInboxes: Map<string, CloudSavedInbox>,
  existingOtpIds: Set<string>,
): Promise<number> {
  if (!user.uid || !user.emailVerified || !ID_PATTERN.test(user.uid)) return 0;

  const uid = user.uid;
  const batch = writeBatch(db);
  const availableInboxIds = new Set<string>(existingInboxes.keys());
  let writeCount = 0;

  for (const inbox of inboxes.slice(0, 50)) {
    const inboxId = sanitizeSafeId(inbox.id);
    if (!ID_PATTERN.test(inboxId)) continue;

    const address = inbox.address.trim().slice(0, MAX_EMAIL_LEN);
    if (address.length < 3) continue;

    const mode: InboxMode = ALLOWED_MODES.has(inbox.mode) ? inbox.mode : 'webhook';
    const provider: InboxProvider = ALLOWED_PROVIDERS.has(inbox.provider)
      ? inbox.provider
      : 'webhook';
    const status: InboxStatus = ALLOWED_STATUSES.has(inbox.status) ? inbox.status : 'active';
    const label = (inbox.label || '').trim().slice(0, MAX_LABEL_LEN);
    const messageCount = Math.min(Math.max(Math.trunc(inbox.messageCount || 0), 0), 1000000);

    const existing = existingInboxes.get(inboxId);
    const ref = doc(db, 'users', uid, 'savedInboxes', inboxId);

    if (!existing) {
      batch.set(ref, {
        id: inboxId,
        ownerUid: uid,
        address,
        mode,
        provider,
        label,
        status,
        messageCount,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      availableInboxIds.add(inboxId);
      writeCount += 1;
    } else if (
      existing.label !== label ||
      existing.status !== status ||
      existing.messageCount !== messageCount
    ) {
      batch.update(ref, {
        label,
        status,
        messageCount,
        updatedAt: serverTimestamp(),
      });
      writeCount += 1;
    }
  }

  for (const otp of otps.slice(0, 30)) {
    const inboxId = sanitizeSafeId(otp.inboxId);
    if (!availableInboxIds.has(inboxId)) continue;

    const rawCode = otp.otpCodes[0] || (otp.links.length > 0 ? 'VERIFY-LINK' : '');
    const code = rawCode.trim().slice(0, MAX_OTP_CODE_LEN);
    if (!code) continue;

    const otpId = sanitizeSafeId(`otp_${otp.messageId}_${code}`);
    if (existingOtpIds.has(otpId)) continue;

    const inboxAddress = otp.inboxAddress.trim().slice(0, MAX_EMAIL_LEN);
    if (inboxAddress.length < 3) continue;

    const subject = (otp.subject || '').trim().slice(0, MAX_SUBJECT_LEN);
    const sender = (otp.from || 'unknown@sender.local').trim().slice(0, MAX_SENDER_LEN) || 'unknown@sender.local';
    const rawUrl = otp.links[0]?.url?.trim();
    const actionUrl =
      rawUrl && (rawUrl.startsWith('https://') || rawUrl.startsWith('http://'))
        ? rawUrl.slice(0, MAX_ACTION_URL_LEN)
        : undefined;

    const ref = doc(db, 'users', uid, 'savedOtps', otpId);
    batch.set(ref, {
      id: otpId,
      ownerUid: uid,
      inboxId,
      inboxAddress,
      code,
      subject,
      sender,
      ...(actionUrl ? { actionUrl } : {}),
      createdAt: serverTimestamp(),
    });
    existingOtpIds.add(otpId);
    writeCount += 1;
  }

  if (writeCount === 0) return 0;

  const targetPath = `users/${uid}/savedInboxes`;
  try {
    await batch.commit();
    return writeCount;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, targetPath);
  }
}

export async function deleteSavedInboxFromFirestore(
  user: User,
  inboxId: string,
): Promise<void> {
  if (!user.uid || !user.emailVerified || !ID_PATTERN.test(user.uid)) return;
  const safeId = sanitizeSafeId(inboxId);
  const path = `users/${user.uid}/savedInboxes/${safeId}`;
  try {
    await deleteDoc(doc(db, 'users', user.uid, 'savedInboxes', safeId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}
