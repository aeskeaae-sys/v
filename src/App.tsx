import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  FileEdit,
  Inbox as InboxIcon,
  Menu,
  Plus,
  RefreshCw,
  Send,
  Shield,
  Shuffle,
  Wand2,
  X,
} from 'lucide-react';
import {
  WEBHOOK_DOMAINS,
  type ActivityEvent,
  type EmailMessage,
  type HealthReport,
  type Inbox,
  type InboxMode,
  type InboxProvider,
  type InboxStatus,
  type MessageFolder,
  type OtpEntry,
  type TtlPreset,
} from '../shared/types';
import {
  bulkMessageAction,
  clearInbox,
  createInbox,
  deleteInbox,
  deleteMessage,
  getHealthReport,
  importInboxMessages,
  listActivities,
  listInboxes,
  listMessages,
  listOtpEntries,
  restoreMessage,
  sendOrSaveDraft,
  subscribeToEvents,
  switchAddress,
  syncInbox,
  updateAddress,
  updateMessage,
  type BulkMessageAction,
} from './api/client';
import { ActiveAddressBar, type MailboxLayout } from './components/ActiveAddressBar';
import { AdminConsoleView, type AdminTab } from './components/AdminConsoleView';
import { AddressesView } from './components/AddressesView';
import { AppSidebar, type NavSection } from './components/AppSidebar';
import { CreateAddressView } from './components/CreateAddressView';
import { DashboardView } from './components/DashboardView';
import { MessageInspector } from './components/MessageInspector';
import { MessageList } from './components/MessageList';
import { OtpCenterView } from './components/OtpCenterView';
import { useFirebaseAuth } from './contexts/FirebaseAuthContext';
import { fetchGmailMessagesForAlias, GmailAuthExpiredError } from './lib/gmailApi';

type MobilePane = 'messages' | 'reader';
type PortalZone = 'frontend' | 'admin';

const SECTION_META: Record<NavSection, { title: string; subtitle: string; hash: string }> = {
  dashboard: {
    title: 'แดชบอร์ด',
    subtitle: 'หน้าบ้าน · อีเมลชั่วคราวและ Alias รับข้อความจริง / รหัส OTP',
    hash: '#/dashboard',
  },
  create: {
    title: 'สร้างอีเมล',
    subtitle: 'สร้างกล่อง Live MX, Gmail Alias, Outlook Alias หรือ Webhook / SMTP',
    hash: '#/create',
  },
  mailbox: {
    title: 'กล่องจดหมาย',
    subtitle: 'อ่านข้อความ ตรวจจับรหัส OTP และสลับมุมมอง List / Split',
    hash: '#/mailbox',
  },
  otp: {
    title: 'ศูนย์ OTP',
    subtitle: 'รหัสยืนยันตัวตนและลิงก์ที่สแกนพบอัตโนมัติ',
    hash: '#/otp',
  },
  addresses: {
    title: 'บัญชีของฉัน',
    subtitle: 'จัดการที่อยู่อีเมลทั้งหมดที่บันทึกไว้',
    hash: '#/addresses',
  },
};

function parseRouteFromHash(): {
  zone: PortalZone;
  section: NavSection;
  adminTab: AdminTab;
} {
  if (typeof window === 'undefined') {
    return { zone: 'frontend', section: 'dashboard', adminTab: 'overview' };
  }
  const h = window.location.hash;
  if (h === '#/admin/inboxes') return { zone: 'admin', section: 'dashboard', adminTab: 'inboxes' };
  if (h === '#/admin/api' || h === '#/page/api' || h === '#api') {
    return { zone: 'admin', section: 'dashboard', adminTab: 'api' };
  }
  if (h === '#/admin/activity' || h === '#/page/activity' || h === '#activity') {
    return { zone: 'admin', section: 'dashboard', adminTab: 'activity' };
  }
  if (h === '#/admin/settings') return { zone: 'admin', section: 'dashboard', adminTab: 'settings' };
  if (h.startsWith('#/admin')) return { zone: 'admin', section: 'dashboard', adminTab: 'overview' };

  if (h === '#/create') return { zone: 'frontend', section: 'create', adminTab: 'overview' };
  if (h === '#/mailbox') return { zone: 'frontend', section: 'mailbox', adminTab: 'overview' };
  if (h === '#/otp') return { zone: 'frontend', section: 'otp', adminTab: 'overview' };
  if (h === '#/addresses') return { zone: 'frontend', section: 'addresses', adminTab: 'overview' };
  return { zone: 'frontend', section: 'dashboard', adminTab: 'overview' };
}

export default function App() {
  const {
    user: firebaseUser,
    signingIn,
    cloudInboxes,
    gmailAccessToken,
    gmailConnected,
    signInWithGoogle,
    connectGmailAccount,
    clearGmailToken,
    signOutUser,
    syncWorkspaceToCloud,
    removeCloudInbox,
  } = useFirebaseAuth();

  const initialRoute = useMemo(() => parseRouteFromHash(), []);
  const [portalZone, setPortalZone] = useState<PortalZone>(initialRoute.zone);
  const [adminTab, setAdminTab] = useState<AdminTab>(initialRoute.adminTab);
  const [activeSection, setActiveSection] = useState<NavSection>(initialRoute.section);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [mailboxLayout, setMailboxLayout] = useState<MailboxLayout>('list');
  const [mobilePane, setMobilePane] = useState<MobilePane>('messages');
  const [activeFolder, setActiveFolder] = useState<MessageFolder>('inbox');

  const [liveMxDomains, setLiveMxDomains] = useState<string[]>([]);
  const [webhookDomains, setWebhookDomains] = useState<string[]>([...WEBHOOK_DOMAINS]);
  const [inboxes, setInboxes] = useState<Inbox[]>([]);
  const [selectedInboxId, setSelectedInboxId] = useState<string | null>(null);

  const [messages, setMessages] = useState<EmailMessage[]>([]);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [syncingInbox, setSyncingInbox] = useState(false);

  const [activities, setActivities] = useState<ActivityEvent[]>([]);
  const [recentOtps, setRecentOtps] = useState<OtpEntry[]>([]);
  const [otpRefreshSignal, setOtpRefreshSignal] = useState(0);
  const [apiRefreshSignal, setApiRefreshSignal] = useState(0);
  const [healthReport, setHealthReport] = useState<HealthReport | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [creatingRandom, setCreatingRandom] = useState(false);

  // Compose / Draft Modal state
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeTo, setComposeTo] = useState('');
  const [composeSubject, setComposeSubject] = useState('');
  const [composeBody, setComposeBody] = useState('');
  const [composeSending, setComposeSending] = useState(false);

  const [toast, setToast] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedInboxRef = useRef<string | null>(null);
  selectedInboxRef.current = selectedInboxId;
  const layoutRef = useRef<MailboxLayout>(mailboxLayout);
  layoutRef.current = mailboxLayout;

  const showToast = useCallback((text: string, tone: 'info' | 'error' = 'info') => {
    setToast({ text, tone });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), tone === 'error' || text.length > 55 ? 4800 : 2800);
  }, []);

  const copyToClipboard = useCallback(
    async (value: string, label = 'Value') => {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(value);
        }
        showToast(`คัดลอก ${label} แล้ว`);
      } catch {
        showToast(`${label}: ${value}`);
      }
    },
    [showToast],
  );

  const fetchHealthAndOtps = useCallback(async () => {
    void getHealthReport().then(setHealthReport).catch(() => {});
    void listOtpEntries({ limit: 8 })
      .then((res) => setRecentOtps(res.items))
      .catch(() => {});
  }, []);

  const fetchInboxes = useCallback(
    async (preferInboxId?: string) => {
      try {
        const res = await listInboxes();
        setLiveMxDomains(res.liveMxDomains);
        setWebhookDomains(res.webhookDomains);
        setInboxes(res.inboxes);
        setSelectedInboxId((curr) => {
          if (preferInboxId && res.inboxes.some((i) => i.id === preferInboxId)) {
            return preferInboxId;
          }
          if (curr && res.inboxes.some((i) => i.id === curr)) {
            return curr;
          }
          return res.inboxes[0]?.id ?? null;
        });
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'ไม่สามารถโหลดกล่องจดหมายได้', 'error');
      }
    },
    [showToast],
  );

  const fetchMessagesForInbox = useCallback(
    async (inboxId: string | null, preferredMessageId?: string | null) => {
      if (!inboxId) {
        setMessages([]);
        setSelectedMessageId(null);
        return;
      }
      setLoadingMessages(true);
      try {
        const res = await listMessages(inboxId, true, { folder: 'all', limit: 200 });
        setMessages(res.messages);
        setInboxes((prev) => prev.map((i) => (i.id === res.inbox.id ? res.inbox : i)));
        setSelectedMessageId((curr) => {
          if (preferredMessageId && res.messages.some((m) => m.id === preferredMessageId)) {
            return preferredMessageId;
          }
          if (curr && res.messages.some((m) => m.id === curr)) return curr;
          return layoutRef.current === 'split'
            ? (res.messages.find((m) => (m.folder || 'inbox') === 'inbox')?.id ?? null)
            : null;
        });
      } catch {
        setMessages([]);
      } finally {
        setLoadingMessages(false);
      }
    },
    [],
  );

  const fetchActivities = useCallback(async () => {
    try {
      const res = await listActivities({ limit: 50 });
      setActivities(res.activities);
    } catch {
      // Ignore activity fetch error
    }
  }, []);

  useEffect(() => {
    void fetchInboxes();
    void fetchActivities();
    void fetchHealthAndOtps();

    let cancelled = false;
    let cleanup: (() => void) | undefined;
    void subscribeToEvents(
      (ev) => {
        if (ev.type === 'inbox:created' && ev.inbox) {
          setInboxes((prev) => {
            if (prev.some((i) => i.id === ev.inbox!.id)) return prev;
            return [ev.inbox!, ...prev];
          });
        } else if (ev.type === 'inbox:updated' && ev.inbox) {
          setInboxes((prev) => prev.map((i) => (i.id === ev.inbox!.id ? ev.inbox! : i)));
        } else if (ev.type === 'inbox:deleted' && ev.inboxId) {
          setInboxes((prev) => prev.filter((i) => i.id !== ev.inboxId));
          if (selectedInboxRef.current === ev.inboxId) {
            setMessages([]);
            setSelectedMessageId(null);
          }
        } else if (ev.type === 'inbox:cleared' && ev.inbox) {
          setInboxes((prev) => prev.map((i) => (i.id === ev.inbox!.id ? ev.inbox! : i)));
          if (selectedInboxRef.current === ev.inbox.id) {
            setMessages([]);
            setSelectedMessageId(null);
          }
        } else if (ev.type === 'inbox:synced' && ev.inbox) {
          setInboxes((prev) => prev.map((i) => (i.id === ev.inbox!.id ? ev.inbox! : i)));
        } else if (ev.type === 'email:received' && ev.message) {
          if (ev.inbox) {
            setInboxes((prev) => {
              const exists = prev.some((i) => i.id === ev.inbox!.id);
              return exists
                ? prev.map((i) => (i.id === ev.inbox!.id ? ev.inbox! : i))
                : [ev.inbox!, ...prev];
            });
          }
          if (selectedInboxRef.current === ev.message.inboxId) {
            setMessages((prev) => {
              if (prev.some((m) => m.id === ev.message!.id)) return prev;
              return [ev.message!, ...prev];
            });
          }
          setOtpRefreshSignal((s) => s + 1);
          setApiRefreshSignal((s) => s + 1);
          void listOtpEntries({ limit: 8 }).then((res) => setRecentOtps(res.items)).catch(() => {});
        } else if (ev.type === 'webhook:delivery') {
          setApiRefreshSignal((s) => s + 1);
        } else if (ev.type === 'message:updated' && ev.message) {
          if (ev.inbox) {
            setInboxes((prev) => prev.map((i) => (i.id === ev.inbox!.id ? ev.inbox! : i)));
          }
          setMessages((prev) =>
            prev.map((m) => (m.id === ev.message!.id ? ev.message! : m)),
          );
        } else if (ev.type === 'message:deleted' && ev.messageId) {
          if (ev.inbox) {
            setInboxes((prev) => prev.map((i) => (i.id === ev.inbox!.id ? ev.inbox! : i)));
          }
          setMessages((prev) => prev.filter((m) => m.id !== ev.messageId));
        } else if (ev.type === 'activity' && ev.activity) {
          setActivities((prev) => [ev.activity!, ...prev].slice(0, 200));
        }
      },
      (connected) => setSseConnected(connected),
    ).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        cleanup = fn;
      }
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [fetchActivities, fetchHealthAndOtps, fetchInboxes]);

  useEffect(() => {
    setActiveFolder('inbox');
    setSelectedMessageId(null);
    void fetchMessagesForInbox(selectedInboxId);
  }, [selectedInboxId, fetchMessagesForInbox]);

  useEffect(() => {
    if (!firebaseUser?.emailVerified) return;
    if (inboxes.length === 0 && recentOtps.length === 0) return;
    const timer = setTimeout(() => {
      void syncWorkspaceToCloud(inboxes, recentOtps).catch(() => {
        // Structured Firestore error already logged in Firebase helper
      });
    }, 800);
    return () => clearTimeout(timer);
  }, [firebaseUser, inboxes, recentOtps, syncWorkspaceToCloud]);

  const navigateToSection = useCallback((section: NavSection) => {
    setPortalZone('frontend');
    setActiveSection(section);
    setToast(null);
    if (typeof window !== 'undefined') {
      const nextHash = SECTION_META[section].hash;
      if (window.location.hash !== nextHash) {
        window.location.hash = nextHash;
      }
    }
  }, []);

  const navigateToAdmin = useCallback((tab: AdminTab = 'overview') => {
    setPortalZone('admin');
    setAdminTab(tab);
    setToast(null);
    if (typeof window !== 'undefined') {
      const nextHash = tab === 'overview' ? '#/admin' : `#/admin/${tab}`;
      if (window.location.hash !== nextHash) {
        window.location.hash = nextHash;
      }
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onHashChange = () => {
      const parsed = parseRouteFromHash();
      setPortalZone(parsed.zone);
      setActiveSection(parsed.section);
      setAdminTab(parsed.adminTab);
      setToast(null);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const activeInbox = useMemo(
    () => inboxes.find((i) => i.id === selectedInboxId) ?? null,
    [inboxes, selectedInboxId],
  );

  const visibleFolderMessages = useMemo(
    () => messages.filter((m) => (m.folder || 'inbox') === activeFolder),
    [messages, activeFolder],
  );

  const selectedMessageIndex = useMemo(
    () => visibleFolderMessages.findIndex((m) => m.id === selectedMessageId),
    [visibleFolderMessages, selectedMessageId],
  );

  const selectedMessage = useMemo(() => {
    if (selectedMessageIndex >= 0) return visibleFolderMessages[selectedMessageIndex];
    return messages.find((m) => m.id === selectedMessageId) ?? null;
  }, [visibleFolderMessages, selectedMessageIndex, messages, selectedMessageId]);

  const totalUnread = useMemo(
    () => inboxes.reduce((sum, i) => sum + i.unreadCount, 0),
    [inboxes],
  );

  const otpCount = useMemo(
    () =>
      recentOtps.length > 0
        ? recentOtps.length
        : messages.filter(
            (m) =>
              m.folder !== 'trash' &&
              (m.extracted.otpCodes.length > 0 || m.extracted.links.length > 0),
          ).length,
    [recentOtps, messages],
  );

  const handleChangeLayout = (next: MailboxLayout) => {
    setMailboxLayout(next);
    if (next === 'split') {
      if (!selectedMessageId && visibleFolderMessages.length > 0) {
        setSelectedMessageId(visibleFolderMessages[0].id);
      }
    } else {
      setSelectedMessageId(null);
      setMobilePane('messages');
    }
  };

  const handleSwitchInbox = async (inb: Inbox, goToMailbox = false) => {
    setSelectedInboxId(inb.id);
    setSelectedMessageId(null);
    setMobilePane('messages');
    if (goToMailbox) navigateToSection('mailbox');
    void switchAddress(inb.id).catch(() => {});
  };

  const handleCreateInbox = async (input: {
    mode: InboxMode;
    provider?: InboxProvider;
    prefix?: string;
    domain: string;
    baseEmail?: string;
    tag?: string;
    strategy?: 'plus' | 'dot';
    ttl: TtlPreset;
    label?: string;
    webhookUrl?: string;
  }) => {
    const res = await createInbox(input);
    setInboxes((prev) => {
      if (prev.some((i) => i.id === res.inbox.id)) return prev;
      return [res.inbox, ...prev];
    });
    setSelectedInboxId(res.inbox.id);
    setSelectedMessageId(null);
    setMobilePane('messages');
    navigateToSection('mailbox');
    showToast(`สร้างอีเมล ${res.inbox.address} สำเร็จ`);
  };

  const handleQuickRandomInbox = async () => {
    setCreatingRandom(true);
    try {
      const mode: InboxMode = liveMxDomains.length > 0 ? 'live-mx' : 'webhook';
      const domain = liveMxDomains[0] || webhookDomains[0] || WEBHOOK_DOMAINS[0];
      const res = await createInbox({ mode, domain, ttl: '24h' });
      setInboxes((prev) => {
        if (prev.some((i) => i.id === res.inbox.id)) return prev;
        return [res.inbox, ...prev];
      });
      setSelectedInboxId(res.inbox.id);
      setSelectedMessageId(null);
      setMobilePane('messages');
      navigateToSection('mailbox');
      showToast(`สร้าง ${res.inbox.address} แล้ว`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'ไม่สามารถสร้างอีเมลได้', 'error');
    } finally {
      setCreatingRandom(false);
    }
  };

  const handleUpdateInbox = async (
    inbox: Inbox,
    patch: { label?: string; status?: InboxStatus; webhookUrl?: string | null; ttl?: TtlPreset },
  ) => {
    try {
      const res = await updateAddress(inbox.id, patch);
      setInboxes((prev) => prev.map((i) => (i.id === res.inbox.id ? res.inbox : i)));
      showToast(`อัปเดต ${res.inbox.address} แล้ว`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'ไม่สามารถอัปเดตกล่องอีเมลได้', 'error');
    }
  };

  const syncGmailAliasInbox = async (inbox: Inbox) => {
    let token = gmailAccessToken;
    if (!token) {
      token = await connectGmailAccount();
    }
    if (!token) {
      throw new Error('กรุณาเชื่อมต่อบัญชี Google เพื่ออนุญาตให้ดึงเมลจาก Gmail');
    }

    let fetched;
    try {
      fetched = await fetchGmailMessagesForAlias(token, inbox.address);
    } catch (err) {
      if (err instanceof GmailAuthExpiredError) {
        clearGmailToken();
        let refreshed: string | null = null;
        try {
          refreshed = await connectGmailAccount();
        } catch (reauthErr) {
          throw new Error(
            reauthErr instanceof Error && !reauthErr.message.includes('popup-blocked')
              ? reauthErr.message
              : err.message,
          );
        }
        if (!refreshed) throw err;
        fetched = await fetchGmailMessagesForAlias(refreshed, inbox.address);
      } else {
        throw err;
      }
    }

    const res = await importInboxMessages(inbox.id, fetched);
    setInboxes((prev) => prev.map((i) => (i.id === res.inbox.id ? res.inbox : i)));
    if (selectedInboxId === inbox.id) {
      setMessages(res.messages);
    }
    setOtpRefreshSignal((s) => s + 1);
    void fetchHealthAndOtps();
    if (res.newMessages > 0) {
      showToast(`ดึงข้อความจริงจาก Gmail สำเร็จ (+${res.newMessages} ใหม่)`);
    } else {
      showToast(`เช็ค Gmail แล้ว — ยังไม่มีข้อความใหม่ถึง ${inbox.address}`);
    }
  };

  const handleSyncSingleInbox = async (inbox: Inbox) => {
    try {
      if (inbox.provider === 'gmail-alias') {
        await syncGmailAliasInbox(inbox);
        return;
      }
      if (inbox.provider === 'outlook-alias') {
        showToast(
          `อีเมลจริงที่ส่งไป ${inbox.address} จะเข้าสู่กล่อง Outlook หลักของคุณโดยตรง (เปิดดูได้ที่ outlook.live.com)`,
        );
        return;
      }
      const res = await syncInbox(inbox.id);
      setInboxes((prev) => prev.map((i) => (i.id === res.inbox.id ? res.inbox : i)));
      if (selectedInboxId === inbox.id) {
        setMessages(res.messages);
      }
      setOtpRefreshSignal((s) => s + 1);
      showToast(
        res.newMessages > 0 ? `ได้รับ ${res.newMessages} ข้อความใหม่` : `${inbox.address} เป็นปัจจุบันแล้ว`,
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'ไม่สามารถซิงก์กล่องอีเมลได้', 'error');
    }
  };

  const handleDeleteInbox = async (inbox: Inbox) => {
    try {
      await deleteInbox(inbox.id);
      void removeCloudInbox(inbox.id).catch(() => {});
      const remaining = inboxes.filter((i) => i.id !== inbox.id);
      setInboxes(remaining);
      if (selectedInboxId === inbox.id) {
        setSelectedInboxId(remaining[0]?.id ?? null);
        setSelectedMessageId(null);
      }
      showToast(`ลบกล่อง ${inbox.address} แล้ว`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'ไม่สามารถลบกล่องได้', 'error');
    }
  };

  const handleCheckMail = async () => {
    if (!activeInbox) {
      await fetchInboxes();
      await fetchHealthAndOtps();
      showToast('อัปเดตรายการกล่องจดหมายแล้ว');
      return;
    }
    setSyncingInbox(true);
    try {
      if (activeInbox.provider === 'gmail-alias') {
        await syncGmailAliasInbox(activeInbox);
        return;
      }
      if (activeInbox.provider === 'outlook-alias') {
        showToast(
          `อีเมลจริงที่ส่งไป ${activeInbox.address} จะส่งตรงเข้ากล่อง Outlook หลักของคุณ (เปิด outlook.live.com)`,
        );
        return;
      }
      const res = await syncInbox(activeInbox.id);
      setMessages(res.messages);
      setInboxes((prev) => prev.map((i) => (i.id === res.inbox.id ? res.inbox : i)));
      setOtpRefreshSignal((s) => s + 1);
      void fetchHealthAndOtps();
      if (res.newMessages > 0) {
        showToast(`ได้รับ ${res.newMessages} ข้อความใหม่`);
      } else if (res.inbox.mode === 'webhook') {
        showToast(
          'กล่องนี้เป็นโหมด Webhook/SMTP (รับเฉพาะ API / SMTP :2525) — หากต้องการรับอีเมลจากเว็บภายนอก ให้ใช้กล่อง Live MX หรือ Gmail Alias',
        );
      } else if (res.inbox.syncError) {
        showToast(res.inbox.syncError, 'error');
      } else {
        showToast('เช็คเมล Live MX แล้ว — ยังไม่มีข้อความใหม่');
      }
    } catch (err) {
      void fetchInboxes(activeInbox.id);
      showToast(err instanceof Error ? err.message : 'ไม่สามารถตรวจสอบข้อความใหม่ได้', 'error');
    } finally {
      setSyncingInbox(false);
    }
  };

  const handleClearInbox = async () => {
    if (!activeInbox) return;
    try {
      await clearInbox(activeInbox.id);
      setMessages([]);
      setSelectedMessageId(null);
      setInboxes((prev) =>
        prev.map((i) =>
          i.id === activeInbox.id ? { ...i, messageCount: 0, unreadCount: 0 } : i,
        ),
      );
      showToast(`ล้างข้อความใน ${activeInbox.address} แล้ว`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'ไม่สามารถล้างข้อความได้', 'error');
    }
  };

  const handleSelectMessage = async (msg: EmailMessage, openMailbox = false) => {
    setSelectedMessageId(msg.id);
    setMobilePane('reader');
    if (msg.folder && msg.folder !== activeFolder) {
      setActiveFolder(msg.folder);
    }
    if (openMailbox) {
      navigateToSection('mailbox');
    }
    if (!msg.read) {
      try {
        const res = await updateMessage(msg.id, { read: true });
        setMessages((prev) => prev.map((m) => (m.id === msg.id ? res.message : m)));
        setInboxes((prev) =>
          prev.map((i) =>
            i.id === msg.inboxId
              ? { ...i, unreadCount: Math.max(0, i.unreadCount - 1) }
              : i,
          ),
        );
      } catch {
        // Non-fatal
      }
    }
  };

  const handleOpenMessageById = async (inboxId: string, messageId: string) => {
    if (selectedInboxId !== inboxId) {
      setSelectedInboxId(inboxId);
      await fetchMessagesForInbox(inboxId, messageId);
    } else {
      setSelectedMessageId(messageId);
    }
    setMobilePane('reader');
    navigateToSection('mailbox');
  };

  const handleToggleStar = async (msg: EmailMessage) => {
    try {
      const res = await updateMessage(msg.id, { starred: !msg.starred });
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? res.message : m)));
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'อัปเดตติดดาวไม่สำเร็จ', 'error');
    }
  };

  const handleToggleRead = async (msg: EmailMessage) => {
    try {
      const res = await updateMessage(msg.id, { read: !msg.read });
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? res.message : m)));
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'อัปเดตสถานะการอ่านไม่สำเร็จ', 'error');
    }
  };

  const handleDeleteMessage = async (msg: EmailMessage, permanent = false) => {
    try {
      await deleteMessage(msg.id, permanent);
      if (permanent || msg.folder === 'trash') {
        const remaining = messages.filter((m) => m.id !== msg.id);
        setMessages(remaining);
        if (selectedMessageId === msg.id) {
          setSelectedMessageId(
            mailboxLayout === 'split' ? (remaining[0]?.id ?? null) : null,
          );
          setMobilePane('messages');
        }
        showToast('ลบข้อความถาวรแล้ว');
      } else {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msg.id ? { ...m, folder: 'trash', deletedAt: new Date().toISOString() } : m,
          ),
        );
        if (selectedMessageId === msg.id && mailboxLayout === 'list') {
          setSelectedMessageId(null);
          setMobilePane('messages');
        }
        showToast('ย้ายข้อความไปถังขยะแล้ว');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'ไม่สามารถลบข้อความได้', 'error');
    }
  };

  const handleRestoreMessage = async (msg: EmailMessage) => {
    try {
      const res = await restoreMessage(msg.id);
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? res.message : m)));
      showToast('กู้คืนข้อความกลับไปยังกล่องเข้าแล้ว');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'ไม่สามารถกู้คืนข้อความได้', 'error');
    }
  };

  const handleBulkMessageAction = async (
    messageIds: string[],
    action: BulkMessageAction,
    permanent = false,
  ) => {
    try {
      const res = await bulkMessageAction(messageIds, action, permanent);
      const updatedMap = new Map(res.updated.map((m) => [m.id, m]));
      const deletedSet = new Set(res.deletedIds);

      setMessages((prev) => {
        const next = prev
          .filter((m) => !deletedSet.has(m.id))
          .map((m) => updatedMap.get(m.id) ?? m);

        if (selectedMessageId) {
          const stillVisible = next.some(
            (m) => m.id === selectedMessageId && (m.folder || 'inbox') === activeFolder,
          );
          if (!stillVisible) {
            if (mailboxLayout === 'split') {
              const fallback = next.find((m) => (m.folder || 'inbox') === activeFolder);
              setSelectedMessageId(fallback?.id ?? null);
            } else {
              setSelectedMessageId(null);
              setMobilePane('messages');
            }
          }
        }
        return next;
      });

      if (activeInbox) {
        void fetchInboxes(activeInbox.id);
      }

      const count = res.affected;
      if (action === 'markRead') showToast(`ทำเครื่องหมายอ่านแล้ว ${count} ข้อความ`);
      else if (action === 'markUnread') showToast(`ทำเครื่องหมายยังไม่อ่าน ${count} ข้อความ`);
      else if (action === 'star') showToast(`ติดดาว ${count} ข้อความแล้ว`);
      else if (action === 'unstar') showToast(`เอาดาวออก ${count} ข้อความแล้ว`);
      else if (action === 'restore') showToast(`กู้คืน ${count} ข้อความกลับไปยังกล่องเข้าแล้ว`);
      else if (action === 'delete') {
        showToast(
          deletedSet.size > 0
            ? `ลบถาวร ${count} ข้อความแล้ว`
            : `ย้าย ${count} ข้อความไปถังขยะแล้ว`,
        );
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'ไม่สามารถดำเนินการแบบกลุ่มได้', 'error');
    }
  };

  const handleComposeSubmit = async (e: FormEvent, mode: 'sent' | 'drafts') => {
    e.preventDefault();
    if (!activeInbox) return;
    setComposeSending(true);
    try {
      const res = await sendOrSaveDraft({
        inboxId: activeInbox.id,
        to: composeTo.trim(),
        subject: composeSubject.trim(),
        text: composeBody,
        mode,
      });
      setMessages((prev) =>
        prev.some((m) => m.id === res.message.id)
          ? prev.map((m) => (m.id === res.message.id ? res.message : m))
          : [res.message, ...prev],
      );
      setActiveFolder(mode);
      setComposeOpen(false);
      setComposeTo('');
      setComposeSubject('');
      setComposeBody('');
      showToast(mode === 'drafts' ? 'บันทึกร่างอีเมลแล้ว' : 'บันทึกและส่งข้อความเรียบร้อยแล้ว');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'ไม่สามารถดำเนินการได้', 'error');
    } finally {
      setComposeSending(false);
    }
  };

  const handleConnectGmail = useCallback(async () => {
    try {
      await connectGmailAccount();
      showToast('เชื่อมต่อบัญชี Gmail เรียบร้อยแล้ว');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'ไม่สามารถเชื่อมต่อบัญชี Gmail ได้',
        'error',
      );
    }
  }, [connectGmailAccount, showToast]);

  const meta = SECTION_META[activeSection];

  if (portalZone === 'admin') {
    return (
      <>
        <AdminConsoleView
          initialTab={adminTab}
          inboxes={inboxes}
          activeInbox={activeInbox}
          webhookDomains={webhookDomains}
          activities={activities}
          healthReport={healthReport}
          apiRefreshSignal={apiRefreshSignal}
          onExitToFrontend={() => navigateToSection('dashboard')}
          onOpenInboxInFrontend={(inb) => {
            setSelectedInboxId(inb.id);
            setSelectedMessageId(null);
            navigateToSection('mailbox');
          }}
          onInboxesMutated={async () => {
            await fetchInboxes();
            await fetchHealthAndOtps();
          }}
          onRefreshActivities={fetchActivities}
          onCopyValue={(val, label) => void copyToClipboard(val, label)}
          onNotify={showToast}
        />
        {toast && (
          <div
            role="status"
            aria-live="polite"
            className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 text-xs font-medium rounded-xl shadow-lg border ${
              toast.tone === 'error'
                ? 'bg-red-950 text-red-100 border-red-500/60'
                : 'bg-[#161f33] text-slate-100 border-[#324675]'
            }`}
          >
            {toast.text}
          </div>
        )}
      </>
    );
  }

  return (
    <div className="h-screen w-full flex bg-[#0b0f19] text-slate-100 overflow-hidden">
      <AppSidebar
        activeSection={activeSection}
        unreadCount={totalUnread}
        otpCount={otpCount}
        inboxCount={inboxes.length}
        collapsed={sidebarCollapsed}
        mobileOpen={mobileMenuOpen}
        firebaseUser={firebaseUser}
        signingIn={signingIn}
        cloudInboxCount={cloudInboxes.length}
        onSignInGoogle={() => {
          void signInWithGoogle()
            .then(() => showToast('เข้าสู่ระบบและเชื่อมต่อบัญชีเรียบร้อยแล้ว'))
            .catch((err) => {
              showToast(
                err instanceof Error ? err.message : 'ไม่สามารถเข้าสู่ระบบด้วย Google ได้',
                'error',
              );
            });
        }}
        onSignOutGoogle={() => {
          void signOutUser()
            .then(() => showToast('ออกจากระบบแล้ว'))
            .catch(() => {});
        }}
        onSelectSection={navigateToSection}
        onOpenAdmin={() => navigateToAdmin('overview')}
        onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
        onCloseMobile={() => setMobileMenuOpen(false)}
      />

      <div className="flex-1 min-w-0 flex flex-col min-h-0 overflow-hidden">
        {/* Top Bar for User Frontend */}
        <header className="h-16 shrink-0 bg-[#0b0f19] border-b border-[#243049] px-4 sm:px-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation menu"
              className="inline-flex lg:hidden items-center justify-center w-9 h-9 rounded-xl bg-[#131b2e] border border-[#2c3a57] hover:border-[#4b618f] text-slate-300 hover:text-white shrink-0 cursor-pointer"
            >
              <Menu className="w-4 h-4" aria-hidden="true" />
            </button>

            <div className="min-w-0">
              <div className="font-display text-sm sm:text-base font-bold text-slate-100 truncate">
                {meta.title}
              </div>
              <div className="text-[11px] sm:text-xs text-slate-400 truncate">
                {meta.subtitle}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void handleQuickRandomInbox()}
              disabled={creatingRandom}
              title="สุ่มสร้างอีเมลใหม่ทันที"
              aria-label="Quick create random email"
              className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-[#131b2e] border border-[#2c3a57] hover:border-[#637bff] text-slate-300 hover:text-white transition-colors cursor-pointer disabled:opacity-50"
            >
              <Plus className="w-4 h-4" aria-hidden="true" />
            </button>

            <button
              type="button"
              onClick={() => void handleCheckMail()}
              disabled={syncingInbox}
              title="ซิงก์ข้อความใหม่"
              aria-label="Refresh active view"
              className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-[#131b2e] border border-[#2c3a57] hover:border-[#637bff] text-slate-300 hover:text-white transition-colors cursor-pointer disabled:opacity-50"
            >
              <RefreshCw
                className={`w-4 h-4 ${syncingInbox ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
            </button>

            <button
              type="button"
              onClick={() => navigateToAdmin('overview')}
              title="เปิดระบบหลังบ้าน (Admin Console)"
              aria-label="Open Backend Admin Console"
              className="inline-flex items-center gap-1.5 px-3 h-9 rounded-xl bg-amber-500/10 border border-amber-500/35 hover:bg-amber-500/20 text-amber-200 text-xs font-semibold transition-colors cursor-pointer"
            >
              <Shield className="w-3.5 h-3.5 text-amber-300" aria-hidden="true" />
              <span className="hidden sm:inline">หลังบ้าน</span>
            </button>
          </div>
        </header>

        {/* Active Page Canvas */}
        <main className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {activeSection === 'dashboard' && (
            <DashboardView
              inboxes={inboxes}
              activeInbox={activeInbox}
              messages={messages}
              recentOtps={recentOtps}
              healthReport={healthReport}
              onNavigate={navigateToSection}
              onSelectMessage={(msg) => void handleSelectMessage(msg, true)}
              onSelectInboxAndMessage={(inbId, msgId) => void handleOpenMessageById(inbId, msgId)}
              onCopyAddress={(addr) => void copyToClipboard(addr, 'ที่อยู่อีเมล')}
              onCopyValue={(val, label) => void copyToClipboard(val, label)}
              onQuickRandom={() => void handleQuickRandomInbox()}
              onRefresh={() => void handleCheckMail()}
              onOpenAdmin={() => navigateToAdmin('api')}
            />
          )}

          {activeSection === 'create' && (
            <CreateAddressView
              liveMxDomains={liveMxDomains}
              webhookDomains={webhookDomains}
              creatingRandom={creatingRandom}
              firebaseUserEmail={firebaseUser?.email ?? undefined}
              gmailConnected={gmailConnected}
              connectingGmail={signingIn}
              onConnectGmail={handleConnectGmail}
              onQuickRandom={handleQuickRandomInbox}
              onCreate={handleCreateInbox}
            />
          )}

          {activeSection === 'mailbox' && (
            activeInbox ? (
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                <ActiveAddressBar
                  inbox={activeInbox}
                  inboxes={inboxes}
                  messageCount={visibleFolderMessages.length}
                  sseConnected={sseConnected}
                  syncing={syncingInbox}
                  layout={mailboxLayout}
                  onSelectInbox={(inb) => void handleSwitchInbox(inb)}
                  onChangeLayout={handleChangeLayout}
                  onCopyAddress={(addr) => void copyToClipboard(addr, 'ที่อยู่อีเมล')}
                  onCheckMail={() => void handleCheckMail()}
                  onClearInbox={() => void handleClearInbox()}
                />

                <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden">
                  {mailboxLayout === 'list' ? (
                    selectedMessage ? (
                      <MessageInspector
                        message={selectedMessage}
                        showBackButton
                        hasPrev={selectedMessageIndex > 0}
                        hasNext={
                          selectedMessageIndex >= 0 &&
                          selectedMessageIndex < visibleFolderMessages.length - 1
                        }
                        onBackToInbox={() => {
                          setSelectedMessageId(null);
                          setMobilePane('messages');
                        }}
                        onPrevMessage={() => {
                          if (selectedMessageIndex > 0) {
                            void handleSelectMessage(
                              visibleFolderMessages[selectedMessageIndex - 1],
                            );
                          }
                        }}
                        onNextMessage={() => {
                          if (selectedMessageIndex < visibleFolderMessages.length - 1) {
                            void handleSelectMessage(
                              visibleFolderMessages[selectedMessageIndex + 1],
                            );
                          }
                        }}
                        onDeleteMessage={(m, perm) => void handleDeleteMessage(m, perm)}
                        onRestoreMessage={(m) => void handleRestoreMessage(m)}
                        onToggleStar={(m) => void handleToggleStar(m)}
                        onToggleRead={(m) => void handleToggleRead(m)}
                        onCopyValue={(val, label) => void copyToClipboard(val, label)}
                      />
                    ) : (
                      <MessageList
                        inbox={activeInbox}
                        messages={messages}
                        selectedMessageId={selectedMessageId}
                        activeFolder={activeFolder}
                        layout="list"
                        loading={loadingMessages}
                        gmailConnected={gmailConnected}
                        onSelectFolder={(f) => {
                          setActiveFolder(f);
                          setSelectedMessageId(null);
                        }}
                        onSelectMessage={(m) => void handleSelectMessage(m)}
                        onToggleStar={(m) => void handleToggleStar(m)}
                        onToggleRead={(m) => void handleToggleRead(m)}
                        onDeleteMessage={(m, perm) => void handleDeleteMessage(m, perm)}
                        onRestoreMessage={(m) => void handleRestoreMessage(m)}
                        onBulkAction={handleBulkMessageAction}
                        onCompose={() => setComposeOpen(true)}
                        onCopyAddress={(addr) => void copyToClipboard(addr, 'ที่อยู่อีเมล')}
                        onNavigateToCreate={() => navigateToSection('create')}
                        onConnectGmail={() => void handleConnectGmail()}
                        onCheckMail={() => void handleCheckMail()}
                      />
                    )
                  ) : (
                    <>
                      <div
                        className={`${
                          mobilePane === 'messages' ? 'flex' : 'hidden'
                        } lg:flex flex-col min-h-0 flex-1 lg:flex-initial`}
                      >
                        <MessageList
                          inbox={activeInbox}
                          messages={messages}
                          selectedMessageId={selectedMessageId}
                          activeFolder={activeFolder}
                          layout="split"
                          loading={loadingMessages}
                          gmailConnected={gmailConnected}
                          onSelectFolder={(f) => {
                            setActiveFolder(f);
                            setSelectedMessageId(null);
                          }}
                          onSelectMessage={(m) => void handleSelectMessage(m)}
                          onToggleStar={(m) => void handleToggleStar(m)}
                          onToggleRead={(m) => void handleToggleRead(m)}
                          onDeleteMessage={(m, perm) => void handleDeleteMessage(m, perm)}
                          onRestoreMessage={(m) => void handleRestoreMessage(m)}
                          onBulkAction={handleBulkMessageAction}
                          onCompose={() => setComposeOpen(true)}
                          onCopyAddress={(addr) => void copyToClipboard(addr, 'ที่อยู่อีเมล')}
                          onNavigateToCreate={() => navigateToSection('create')}
                          onConnectGmail={() => void handleConnectGmail()}
                          onCheckMail={() => void handleCheckMail()}
                        />
                      </div>
                      <div
                        className={`${
                          mobilePane === 'reader' ? 'flex' : 'hidden'
                        } lg:flex flex-1 min-w-0 min-h-0 flex-col`}
                      >
                        <MessageInspector
                          message={selectedMessage}
                          showBackButton={false}
                          onBackToInbox={() => setMobilePane('messages')}
                          onDeleteMessage={(m, perm) => void handleDeleteMessage(m, perm)}
                          onRestoreMessage={(m) => void handleRestoreMessage(m)}
                          onToggleStar={(m) => void handleToggleStar(m)}
                          onToggleRead={(m) => void handleToggleRead(m)}
                          onCopyValue={(val, label) => void copyToClipboard(val, label)}
                        />
                      </div>
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto p-6 flex items-center justify-center">
                <div className="max-w-md w-full bg-[#121929] border border-[#26334d] rounded-2xl p-8 text-center space-y-4">
                  <div className="w-12 h-12 rounded-xl bg-[#192440] border border-[#2c3b60] flex items-center justify-center mx-auto">
                    <InboxIcon className="w-5 h-5 text-[#7b93ff]" aria-hidden="true" />
                  </div>
                  <div>
                    <h2 className="font-display text-lg font-bold text-slate-100">
                      ยังไม่มีกล่องจดหมายที่ใช้งาน
                    </h2>
                    <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                      สุ่มสร้างที่อยู่อีเมลชั่วคราวทันที หรือตั้งชื่ออีเมลและโดเมนที่ต้องการเพื่อเริ่มรับข้อความ
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
                    <button
                      type="button"
                      onClick={() => void handleQuickRandomInbox()}
                      disabled={creatingRandom}
                      className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-[#637bff] hover:bg-[#526bf5] rounded-xl cursor-pointer disabled:opacity-50"
                    >
                      <Shuffle className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>{creatingRandom ? 'กำลังสุ่ม…' : 'สุ่มสร้างทันที'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => navigateToSection('create')}
                      className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-200 bg-[#161f33] border border-[#2c3a57] hover:border-[#4b618f] rounded-xl cursor-pointer"
                    >
                      <Wand2 className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>สร้างแบบกำหนดเอง</span>
                    </button>
                  </div>
                </div>
              </div>
            )
          )}

          {activeSection === 'otp' && (
            <OtpCenterView
              inboxes={inboxes}
              activeInbox={activeInbox}
              syncing={syncingInbox}
              refreshSignal={otpRefreshSignal}
              onSync={() => void handleCheckMail()}
              onOpenMessageById={(inbId, msgId) => void handleOpenMessageById(inbId, msgId)}
              onCopyValue={(val, label) => void copyToClipboard(val, label)}
            />
          )}

          {activeSection === 'addresses' && (
            <AddressesView
              inboxes={inboxes}
              selectedInboxId={selectedInboxId}
              creatingRandom={creatingRandom}
              onSelectInbox={(inb) => void handleSwitchInbox(inb, true)}
              onCopyAddress={(addr) => void copyToClipboard(addr, 'ที่อยู่อีเมล')}
              onDeleteInbox={(inb) => void handleDeleteInbox(inb)}
              onUpdateInbox={handleUpdateInbox}
              onSyncInbox={handleSyncSingleInbox}
              onQuickRandom={handleQuickRandomInbox}
              onGoCreate={() => navigateToSection('create')}
            />
          )}
        </main>
      </div>

      {/* Compose / Draft Email Modal */}
      {composeOpen && activeInbox && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="เขียนอีเมลใหม่"
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
        >
          <form
            onSubmit={(e) => void handleComposeSubmit(e, 'sent')}
            className="w-full max-w-lg bg-[#121929] border border-[#2e3e60] rounded-2xl p-6 space-y-4 shadow-2xl"
          >
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="font-display text-base font-bold text-slate-50">
                  เขียนอีเมล / บันทึกร่าง
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  จาก: <span className="font-mono text-[#8da2ff]">{activeInbox.address}</span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setComposeOpen(false)}
                aria-label="Close compose dialog"
                className="p-1.5 text-slate-400 hover:text-white rounded-lg cursor-pointer"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            <div>
              <label htmlFor="compose-to" className="block text-xs font-semibold text-slate-300 mb-1">
                ถึง (อีเมลปลายทาง)
              </label>
              <input
                id="compose-to"
                type="email"
                required
                value={composeTo}
                onChange={(e) => setComposeTo(e.target.value)}
                placeholder="recipient@relaybox.dev"
                className="w-full px-3 py-2 font-mono text-xs bg-[#0b101b] text-slate-100 border border-[#2c3b59] rounded-xl focus:outline-none focus:border-[#637bff]"
              />
            </div>

            <div>
              <label htmlFor="compose-subject" className="block text-xs font-semibold text-slate-300 mb-1">
                หัวข้อ
              </label>
              <input
                id="compose-subject"
                type="text"
                required
                value={composeSubject}
                onChange={(e) => setComposeSubject(e.target.value)}
                placeholder="Subject..."
                className="w-full px-3 py-2 text-sm bg-[#0b101b] text-slate-100 border border-[#2c3b59] rounded-xl focus:outline-none focus:border-[#637bff]"
              />
            </div>

            <div>
              <label htmlFor="compose-body" className="block text-xs font-semibold text-slate-300 mb-1">
                เนื้อหาข้อความ
              </label>
              <textarea
                id="compose-body"
                rows={5}
                value={composeBody}
                onChange={(e) => setComposeBody(e.target.value)}
                placeholder="พิมพ์เนื้อหาอีเมล..."
                className="w-full px-3 py-2 text-sm bg-[#0b101b] text-slate-100 border border-[#2c3b59] rounded-xl focus:outline-none focus:border-[#637bff]"
              />
            </div>

            <div className="pt-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] text-slate-400">
                ส่งถึงกล่องภายในทันที หรือบันทึกลงโฟลเดอร์ร่าง
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={composeSending}
                  onClick={(e) => void handleComposeSubmit(e, 'drafts')}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-200 bg-[#161f33] border border-[#2c3a57] hover:border-[#4b618f] rounded-xl cursor-pointer disabled:opacity-50"
                >
                  <FileEdit className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>บันทึกร่าง</span>
                </button>
                <button
                  type="submit"
                  disabled={composeSending}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#637bff] hover:bg-[#526bf5] rounded-xl cursor-pointer disabled:opacity-50"
                >
                  <Send className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{composeSending ? 'กำลังส่ง…' : 'ส่งอีเมล'}</span>
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 text-xs font-medium rounded-xl shadow-lg border ${
            toast.tone === 'error'
              ? 'bg-red-950 text-red-100 border-red-500/60'
              : 'bg-[#161f33] text-slate-100 border-[#324675]'
          }`}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}
