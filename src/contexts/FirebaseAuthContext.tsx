import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import type { Inbox, OtpEntry } from '../../shared/types';
import {
  auth,
  db,
  googleAuthProvider,
  handleFirestoreError,
  hasFirestoreDb,
  OperationType,
} from '../lib/firebase';
import {
  deleteSavedInboxFromFirestore,
  syncInboxesAndOtpsToFirestore,
  syncUserProfileToFirestore,
  type CloudSavedInbox,
  type CloudSavedOtp,
} from '../lib/firestoreSync';

// Per Workspace Integration security requirement: cache OAuth access token strictly in memory.
let inMemoryGmailAccessToken: string | null = null;

interface FirebaseAuthContextValue {
  user: User | null;
  authReady: boolean;
  signingIn: boolean;
  syncingCloud: boolean;
  cloudInboxes: CloudSavedInbox[];
  cloudOtps: CloudSavedOtp[];
  gmailAccessToken: string | null;
  gmailConnected: boolean;
  signInWithGoogle: () => Promise<void>;
  connectGmailAccount: () => Promise<string | null>;
  clearGmailToken: () => void;
  signOutUser: () => Promise<void>;
  syncWorkspaceToCloud: (inboxes: Inbox[], otps: OtpEntry[]) => Promise<number>;
  removeCloudInbox: (inboxId: string) => Promise<void>;
}

const FirebaseAuthContext = createContext<FirebaseAuthContextValue | null>(null);

export function FirebaseAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [syncingCloud, setSyncingCloud] = useState(false);
  const [cloudInboxes, setCloudInboxes] = useState<CloudSavedInbox[]>([]);
  const [cloudOtps, setCloudOtps] = useState<CloudSavedOtp[]>([]);
  const [gmailAccessToken, setGmailAccessToken] = useState<string | null>(
    () => inMemoryGmailAccessToken,
  );

  const existingInboxesRef = useRef<Map<string, CloudSavedInbox>>(new Map());
  const existingOtpIdsRef = useRef<Set<string>>(new Set());

  const clearGmailToken = useCallback(() => {
    inMemoryGmailAccessToken = null;
    setGmailAccessToken(null);
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
      if (!nextUser) {
        inMemoryGmailAccessToken = null;
        setGmailAccessToken(null);
        setCloudInboxes([]);
        setCloudOtps([]);
        existingInboxesRef.current = new Map();
        existingOtpIdsRef.current = new Set();
        return;
      }
      if (hasFirestoreDb && nextUser.emailVerified) {
        void syncUserProfileToFirestore(nextUser).catch(() => {
          // Handled and logged via handleFirestoreError
        });
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!hasFirestoreDb || !authReady || !user || !user.emailVerified) {
      return;
    }

    const inboxesPath = `users/${user.uid}/savedInboxes`;
    const inboxesQuery = query(
      collection(db, 'users', user.uid, 'savedInboxes'),
      where('ownerUid', '==', user.uid),
    );
    const unsubInboxes = onSnapshot(
      inboxesQuery,
      (snapshot) => {
        const items: CloudSavedInbox[] = [];
        const map = new Map<string, CloudSavedInbox>();
        snapshot.forEach((docSnap) => {
          const data = docSnap.data() as CloudSavedInbox;
          items.push(data);
          map.set(data.id, data);
        });
        existingInboxesRef.current = map;
        setCloudInboxes(items);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, inboxesPath);
      },
    );

    const otpsPath = `users/${user.uid}/savedOtps`;
    const otpsQuery = query(
      collection(db, 'users', user.uid, 'savedOtps'),
      where('ownerUid', '==', user.uid),
    );
    const unsubOtps = onSnapshot(
      otpsQuery,
      (snapshot) => {
        const items: CloudSavedOtp[] = [];
        const ids = new Set<string>();
        snapshot.forEach((docSnap) => {
          const data = docSnap.data() as CloudSavedOtp;
          items.push(data);
          ids.add(data.id);
        });
        existingOtpIdsRef.current = ids;
        setCloudOtps(items);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, otpsPath);
      },
    );

    return () => {
      unsubInboxes();
      unsubOtps();
    };
  }, [authReady, user]);

  async function verifyHasGmailReadScope(token: string): Promise<boolean> {
    try {
      const res = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`,
      );
      if (!res.ok) return true;
      const data = (await res.json()) as { scope?: string };
      if (!data.scope) return true;
      const granted = new Set(data.scope.split(/\s+/));
      return (
        granted.has('https://www.googleapis.com/auth/gmail.readonly') ||
        granted.has('https://www.googleapis.com/auth/gmail.modify') ||
        granted.has('https://mail.google.com/')
      );
    } catch {
      return true;
    }
  }

  const runGoogleOAuthPopup = useCallback(
    async (requireGmailScope: boolean): Promise<string | null> => {
      setSigningIn(true);
      try {
        const cred = await signInWithPopup(auth, googleAuthProvider);
        const oauthCred = GoogleAuthProvider.credentialFromResult(cred);
        const token = oauthCred?.accessToken ?? null;
        if (hasFirestoreDb && cred.user.emailVerified) {
          await syncUserProfileToFirestore(cred.user);
        }

        if (!token) {
          inMemoryGmailAccessToken = null;
          setGmailAccessToken(null);
          if (requireGmailScope) {
            throw new Error(
              'ไม่ได้รับ OAuth Access Token จาก Google — กรุณาลองเชื่อมต่อบัญชี Gmail ใหม่อีกครั้ง',
            );
          }
          return null;
        }

        const hasScope = await verifyHasGmailReadScope(token);
        if (!hasScope) {
          inMemoryGmailAccessToken = null;
          setGmailAccessToken(null);
          if (requireGmailScope) {
            throw new Error(
              'บัญชี Google ยังไม่ได้อนุญาตสิทธิ์อ่านอีเมล (gmail.readonly) — กรุณากด "เชื่อมต่อบัญชี Gmail" และติ๊กถูกอนุญาตเข้าถึง Gmail ในหน้าต่างของ Google',
            );
          }
          return null;
        }

        inMemoryGmailAccessToken = token;
        setGmailAccessToken(token);
        return token;
      } finally {
        setSigningIn(false);
      }
    },
    [],
  );

  const connectGmailAccount = useCallback(async (): Promise<string | null> => {
    return runGoogleOAuthPopup(true);
  }, [runGoogleOAuthPopup]);

  const signInWithGoogle = useCallback(async () => {
    await runGoogleOAuthPopup(false);
  }, [runGoogleOAuthPopup]);

  const signOutUser = useCallback(async () => {
    inMemoryGmailAccessToken = null;
    setGmailAccessToken(null);
    await signOut(auth);
  }, []);

  const syncWorkspaceToCloud = useCallback(
    async (inboxes: Inbox[], otps: OtpEntry[]): Promise<number> => {
      if (!hasFirestoreDb || !user || !user.emailVerified) return 0;
      setSyncingCloud(true);
      try {
        return await syncInboxesAndOtpsToFirestore(
          user,
          inboxes,
          otps,
          existingInboxesRef.current,
          existingOtpIdsRef.current,
        );
      } finally {
        setSyncingCloud(false);
      }
    },
    [user],
  );

  const removeCloudInbox = useCallback(
    async (inboxId: string): Promise<void> => {
      if (!hasFirestoreDb || !user || !user.emailVerified) return;
      if (!existingInboxesRef.current.has(inboxId)) return;
      await deleteSavedInboxFromFirestore(user, inboxId);
    },
    [user],
  );

  const value = useMemo<FirebaseAuthContextValue>(
    () => ({
      user,
      authReady,
      signingIn,
      syncingCloud,
      cloudInboxes,
      cloudOtps,
      gmailAccessToken,
      gmailConnected: Boolean(gmailAccessToken),
      signInWithGoogle,
      connectGmailAccount,
      clearGmailToken,
      signOutUser,
      syncWorkspaceToCloud,
      removeCloudInbox,
    }),
    [
      user,
      authReady,
      signingIn,
      syncingCloud,
      cloudInboxes,
      cloudOtps,
      gmailAccessToken,
      signInWithGoogle,
      connectGmailAccount,
      clearGmailToken,
      signOutUser,
      syncWorkspaceToCloud,
      removeCloudInbox,
    ],
  );

  return <FirebaseAuthContext.Provider value={value}>{children}</FirebaseAuthContext.Provider>;
}

export function useFirebaseAuth(): FirebaseAuthContextValue {
  const ctx = useContext(FirebaseAuthContext);
  if (!ctx) {
    throw new Error('useFirebaseAuth must be used within FirebaseAuthProvider.');
  }
  return ctx;
}
