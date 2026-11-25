import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Database,
  Inbox as InboxIcon,
  KeyRound,
  LayoutDashboard,
  Lock,
  LogOut,
  Mail,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  Server,
  Settings,
  Shield,
  ShieldCheck,
  Terminal,
  Trash2,
  Webhook,
} from 'lucide-react';
import {
  GMAIL_ALIAS_DOMAINS,
  OUTLOOK_ALIAS_DOMAINS,
  type ActivityEvent,
  type AdminOverview,
  type AdminStatus,
  type HealthReport,
  type Inbox,
} from '../../shared/types';
import {
  AdminUnauthorizedError,
  changeAdminPasscode,
  deleteAdminInbox,
  getAdminOverview,
  getAdminStatus,
  getSettings,
  listAdminInboxes,
  loginAdmin,
  logoutAdmin,
  runAdminMaintenancePrune,
  setupAdminPasscode,
  updateAdminInbox,
  updateSettings,
} from '../api/client';
import { formatRelativeTime, formatTtlRemaining } from '../utils/format';
import { ActivityLogView } from './ActivityLogView';
import { ApiDocsView } from './ApiDocsView';

export type AdminTab = 'overview' | 'inboxes' | 'api' | 'activity' | 'settings';

interface AdminConsoleViewProps {
  initialTab?: AdminTab;
  inboxes: Inbox[];
  activeInbox: Inbox | null;
  webhookDomains: string[];
  activities: ActivityEvent[];
  healthReport: HealthReport | null;
  apiRefreshSignal: number;
  onExitToFrontend: () => void;
  onOpenInboxInFrontend: (inbox: Inbox) => void;
  onInboxesMutated: () => Promise<void>;
  onRefreshActivities: () => Promise<void>;
  onCopyValue: (val: string, label: string) => void;
  onNotify: (msg: string, tone?: 'info' | 'error') => void;
}

function formatUptime(sec: number): string {
  if (sec < 60) return `${sec} วินาที`;
  const mins = Math.floor(sec / 60);
  if (mins < 60) return `${mins} นาที`;
  const hrs = Math.floor(mins / 60);
  return `${hrs} ชม. ${mins % 60} นาที`;
}

export function AdminConsoleView({
  initialTab = 'overview',
  inboxes: frontendInboxes,
  activeInbox,
  webhookDomains,
  activities,
  healthReport,
  apiRefreshSignal,
  onExitToFrontend,
  onOpenInboxInFrontend,
  onInboxesMutated,
  onRefreshActivities,
  onCopyValue,
  onNotify,
}: AdminConsoleViewProps) {
  const [adminStatus, setAdminStatus] = useState<AdminStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [activeTab, setActiveTab] = useState<AdminTab>(initialTab);

  // Login / Setup gate form
  const [passcode, setPasscode] = useState('');
  const [confirmPasscode, setConfirmPasscode] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Admin overview & inboxes data
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [liveMxDomains, setLiveMxDomains] = useState<string[]>([]);
  const [adminInboxes, setAdminInboxes] = useState<Inbox[]>([]);
  const [inboxQuery, setInboxQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [loadingData, setLoadingData] = useState(false);
  const [pruning, setPruning] = useState(false);

  // Settings tab state
  const [requireApiKey, setRequireApiKey] = useState(false);
  const [retentionDays, setRetentionDays] = useState(30);
  const [smtpPort, setSmtpPort] = useState<number | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  // Passcode update form
  const [curPass, setCurPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [savingPass, setSavingPass] = useState(false);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  const checkStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const status = await getAdminStatus();
      setAdminStatus(status);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'ไม่สามารถตรวจสอบสถานะหลังบ้านได้');
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  const loadAdminData = useCallback(async () => {
    if (!adminStatus?.authenticated) return;
    setLoadingData(true);
    try {
      const [ovRes, inbRes, settingsRes] = await Promise.all([
        getAdminOverview(),
        listAdminInboxes({
          q: inboxQuery.trim() || undefined,
          provider: providerFilter,
          status: statusFilter,
        }),
        getSettings(),
      ]);
      setOverview(ovRes.overview);
      setLiveMxDomains(ovRes.liveMxDomains);
      setAdminInboxes(inbRes.inboxes);
      setRequireApiKey(settingsRes.requireApiKey);
      setRetentionDays(settingsRes.retentionDays ?? 30);
      setSmtpPort(settingsRes.smtpPort);
    } catch (err) {
      if (err instanceof AdminUnauthorizedError) {
        setAdminStatus((prev) => (prev ? { ...prev, authenticated: false } : null));
      } else {
        onNotify(err instanceof Error ? err.message : 'โหลดข้อมูลหลังบ้านไม่สำเร็จ', 'error');
      }
    } finally {
      setLoadingData(false);
    }
  }, [adminStatus?.authenticated, inboxQuery, providerFilter, statusFilter, onNotify]);

  useEffect(() => {
    if (adminStatus?.authenticated) {
      void loadAdminData();
    }
  }, [adminStatus?.authenticated, loadAdminData]);

  const handleSetupSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    if (passcode.trim().length < 4) {
      setAuthError('รหัสผ่านต้องมีอย่างน้อย 4 ตัวอักษร');
      return;
    }
    if (passcode !== confirmPasscode) {
      setAuthError('รหัสผ่านยืนยันไม่ตรงกัน');
      return;
    }
    setAuthSubmitting(true);
    try {
      const res = await setupAdminPasscode(passcode);
      setAdminStatus(res.status);
      setPasscode('');
      setConfirmPasscode('');
      onNotify('ตั้งรหัสผ่านและเข้าสู่ระบบหลังบ้านสำเร็จ');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'ตั้งรหัสผ่านไม่สำเร็จ');
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleLoginSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthSubmitting(true);
    try {
      const res = await loginAdmin(passcode);
      setAdminStatus(res.status);
      setPasscode('');
      onNotify('เข้าสู่ระบบหลังบ้านเรียบร้อยแล้ว');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'รหัสผ่านไม่ถูกต้อง');
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleLogoutAdmin = async () => {
    await logoutAdmin();
    setAdminStatus((prev) => (prev ? { ...prev, authenticated: false } : null));
    onNotify('ออกจากระบบหลังบ้านแล้ว');
  };

  const handleToggleInboxStatus = async (inbox: Inbox) => {
    const nextStatus = inbox.status === 'paused' ? 'active' : 'paused';
    try {
      await updateAdminInbox(inbox.id, { status: nextStatus });
      await loadAdminData();
      await onInboxesMutated();
      onNotify(
        nextStatus === 'paused'
          ? `หยุดการใช้งาน ${inbox.address} ชั่วคราวแล้ว`
          : `เปิดใช้งาน ${inbox.address} แล้ว`,
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'อัปเดตสถานะไม่สำเร็จ', 'error');
    }
  };

  const handleDeleteAdminInbox = async (inbox: Inbox) => {
    try {
      await deleteAdminInbox(inbox.id);
      await loadAdminData();
      await onInboxesMutated();
      onNotify(`ลบกล่อง ${inbox.address} ออกจากระบบแล้ว`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'ลบกล่องไม่สำเร็จ', 'error');
    }
  };

  const handleMaintenancePrune = async () => {
    setPruning(true);
    try {
      const res = await runAdminMaintenancePrune();
      await loadAdminData();
      await onInboxesMutated();
      onNotify(
        `ล้างข้อมูลสำเร็จ (หมดอายุ ${res.expiredInboxes} กล่อง, ข้อความเก่า ${res.deletedMessages}, Log ${res.deletedLogs})`,
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'ไม่สามารถล้างข้อมูลได้', 'error');
    } finally {
      setPruning(false);
    }
  };

  const handleSaveServerSettings = async (e: FormEvent) => {
    e.preventDefault();
    setSavingSettings(true);
    try {
      const updated = await updateSettings(requireApiKey, retentionDays);
      setRequireApiKey(updated.requireApiKey);
      setRetentionDays(updated.retentionDays ?? retentionDays);
      await loadAdminData();
      onNotify('บันทึกการตั้งค่าเซิร์ฟเวอร์เรียบร้อยแล้ว');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'บันทึกการตั้งค่าไม่สำเร็จ', 'error');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleChangePasscode = async (e: FormEvent) => {
    e.preventDefault();
    if (newPass.trim().length < 4) {
      onNotify('รหัสผ่านใหม่ต้องมีอย่างน้อย 4 ตัวอักษร', 'error');
      return;
    }
    setSavingPass(true);
    try {
      await changeAdminPasscode(curPass, newPass);
      setCurPass('');
      setNewPass('');
      onNotify('เปลี่ยนรหัสผ่านระบบหลังบ้านเรียบร้อยแล้ว');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'เปลี่ยนรหัสผ่านไม่สำเร็จ', 'error');
    } finally {
      setSavingPass(false);
    }
  };

  // Loading status screen
  if (loadingStatus) {
    return (
      <div className="min-h-screen w-full bg-[#090d16] text-slate-100 flex items-center justify-center p-6">
        <div className="text-sm text-slate-400">กำลังตรวจสอบสิทธิ์ระบบหลังบ้าน…</div>
      </div>
    );
  }

  // Admin Login / Initial Claim Gate
  if (!adminStatus?.authenticated) {
    const needsSetup = adminStatus && !adminStatus.configured;
    return (
      <div className="min-h-screen w-full bg-[#090d16] text-slate-100 flex flex-col">
        <header className="h-16 border-b border-[#232f48] px-4 sm:px-8 flex items-center justify-between bg-[#0c1220]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/40 text-amber-300 flex items-center justify-center">
              <Shield className="w-4.5 h-4.5" aria-hidden="true" />
            </div>
            <div>
              <div className="font-display text-sm font-bold text-slate-100">
                RelayBox Backoffice
              </div>
              <div className="text-[11px] text-amber-300/90">ระบบหลังบ้าน · Admin Console</div>
            </div>
          </div>

          <button
            type="button"
            onClick={onExitToFrontend}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-slate-200 bg-[#151e32] hover:bg-[#1b2740] border border-[#2c3b59] rounded-xl cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
            <span>กลับหน้าบ้าน (User Portal)</span>
          </button>
        </header>

        <div className="flex-1 flex items-center justify-center p-4 sm:p-6">
          <div className="w-full max-w-md bg-[#111828] border border-[#283654] rounded-2xl p-6 sm:p-8 shadow-2xl space-y-5">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl bg-amber-500/15 border border-amber-500/35 text-amber-300 flex items-center justify-center shrink-0">
                <Lock className="w-5 h-5" aria-hidden="true" />
              </div>
              <div>
                <h1 className="font-display text-lg font-bold text-slate-50">
                  {needsSetup ? 'ตั้งค่ารหัสผ่านหลังบ้านครั้งแรก' : 'เข้าสู่ระบบหลังบ้าน (Admin)'}
                </h1>
                <p className="text-xs text-slate-400 mt-0.5">
                  {needsSetup
                    ? 'กำหนดรหัสผ่านผู้ดูแลระบบเพื่อแยกการจัดการหลังบ้านจากผู้ใช้งานหน้าบ้าน'
                    : 'กรอกรหัสผ่านผู้ดูแลระบบเพื่อจัดการกล่องอีเมล API Keys และตั้งค่าเซิร์ฟเวอร์'}
                </p>
              </div>
            </div>

            {authError && (
              <div
                role="alert"
                className="px-3.5 py-2.5 text-xs font-medium text-red-200 bg-red-950/60 border border-red-500/50 rounded-xl"
              >
                {authError}
              </div>
            )}

            <form
              onSubmit={needsSetup ? handleSetupSubmit : handleLoginSubmit}
              className="space-y-4"
            >
              <div>
                <label htmlFor="admin-passcode-input" className="block text-xs font-semibold text-slate-300 mb-1.5">
                  {needsSetup ? 'รหัสผ่านผู้ดูแลระบบใหม่ (4+ ตัวอักษร)' : 'รหัสผ่านผู้ดูแลระบบ'}
                </label>
                <input
                  id="admin-passcode-input"
                  type="password"
                  required
                  autoFocus
                  value={passcode}
                  onChange={(e) => setPasscode(e.target.value)}
                  placeholder="••••••••"
                  className="w-full px-3.5 py-2.5 text-sm bg-[#090e19] text-slate-100 border border-[#2c3b59] rounded-xl focus:outline-none focus:border-amber-400"
                />
              </div>

              {needsSetup && (
                <div>
                  <label htmlFor="admin-passcode-confirm" className="block text-xs font-semibold text-slate-300 mb-1.5">
                    ยืนยันรหัสผ่านอีกครั้ง
                  </label>
                  <input
                    id="admin-passcode-confirm"
                    type="password"
                    required
                    value={confirmPasscode}
                    onChange={(e) => setConfirmPasscode(e.target.value)}
                    placeholder="••••••••"
                    className="w-full px-3.5 py-2.5 text-sm bg-[#090e19] text-slate-100 border border-[#2c3b59] rounded-xl focus:outline-none focus:border-amber-400"
                  />
                </div>
              )}

              <button
                type="submit"
                disabled={authSubmitting}
                className="w-full py-2.5 px-4 text-sm font-semibold text-slate-950 bg-amber-400 hover:bg-amber-300 rounded-xl transition-colors cursor-pointer disabled:opacity-50"
              >
                {authSubmitting
                  ? 'กำลังดำเนินการ…'
                  : needsSetup
                    ? 'บันทึกรหัสผ่านและเข้าสู่ระบบหลังบ้าน'
                    : 'เข้าสู่ระบบหลังบ้าน'}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  const navTabs: Array<{ id: AdminTab; label: string; icon: typeof LayoutDashboard }> = [
    { id: 'overview', label: 'ภาพรวมหลังบ้าน', icon: LayoutDashboard },
    { id: 'inboxes', label: 'จัดการกล่องทั้งหมด', icon: InboxIcon },
    { id: 'api', label: 'API & Webhooks', icon: Terminal },
    { id: 'activity', label: 'บันทึกกิจกรรม & Log', icon: Activity },
    { id: 'settings', label: 'ตั้งค่าเซิร์ฟเวอร์', icon: Settings },
  ];

  return (
    <div className="h-screen w-full flex bg-[#090d16] text-slate-100 overflow-hidden">
      {/* Dedicated Backend Admin Sidebar */}
      <aside className="hidden lg:flex w-[250px] shrink-0 flex-col bg-[#0c1220] border-r border-[#232f48]">
        <div className="h-16 px-4 flex items-center gap-3 border-b border-[#1d273c]">
          <span className="w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/40 text-amber-300 flex items-center justify-center shrink-0">
            <Shield className="w-4.5 h-4.5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="font-display text-sm font-bold text-slate-100 truncate">
              RelayBox Admin
            </div>
            <div className="text-[11px] text-amber-300 truncate">ระบบหลังบ้าน · Backoffice</div>
          </div>
        </div>

        <nav aria-label="Admin navigation" className="flex-1 overflow-y-auto p-3 space-y-1">
          {navTabs.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors cursor-pointer ${
                  active
                    ? 'bg-amber-500/15 text-amber-200 border border-amber-500/35'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-[#131b2e] border border-transparent'
                }`}
              >
                <Icon
                  className={`w-4 h-4 shrink-0 ${active ? 'text-amber-300' : 'text-slate-400'}`}
                  aria-hidden="true"
                />
                <span className="truncate">{tab.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-3 border-t border-[#1d273c] space-y-2">
          <button
            type="button"
            onClick={onExitToFrontend}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold text-slate-200 bg-[#151e32] hover:bg-[#1d2944] border border-[#2c3b59] cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
            <span>ไปหน้าบ้าน (User Portal)</span>
          </button>
          <button
            type="button"
            onClick={() => void handleLogoutAdmin()}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold text-red-300 bg-red-950/30 hover:bg-red-950/50 border border-red-500/30 cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
            <span>ออกจากระบบหลังบ้าน</span>
          </button>
        </div>
      </aside>

      {/* Admin Main Workspace */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0 overflow-hidden">
        <header className="h-16 shrink-0 bg-[#0c1220] border-b border-[#232f48] px-4 sm:px-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <span className="lg:hidden w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-500/40 text-amber-300 flex items-center justify-center shrink-0">
              <Shield className="w-4 h-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="font-display text-sm sm:text-base font-bold text-slate-100 truncate">
                {navTabs.find((t) => t.id === activeTab)?.label ?? 'ระบบหลังบ้าน'}
              </div>
              <div className="text-[11px] text-amber-300/90 truncate">
                Backend Management &amp; Server Operations
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void loadAdminData()}
              disabled={loadingData}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-200 bg-[#151e32] border border-[#2c3b59] hover:border-amber-400/60 rounded-xl cursor-pointer disabled:opacity-50"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${loadingData ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              <span className="hidden sm:inline">รีเฟรช</span>
            </button>
            <button
              type="button"
              onClick={onExitToFrontend}
              className="lg:hidden inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-200 bg-[#151e32] border border-[#2c3b59] rounded-xl cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
              <span>หน้าบ้าน</span>
            </button>
          </div>
        </header>

        {/* Mobile Admin Tab Strip */}
        <div className="lg:hidden flex items-center gap-1.5 px-4 py-2 bg-[#0d1424] border-b border-[#202c44] overflow-x-auto shrink-0">
          {navTabs.map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg whitespace-nowrap cursor-pointer ${
                  active
                    ? 'bg-amber-500/20 text-amber-200 border border-amber-500/40'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <main className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {activeTab === 'overview' && (
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
              <div className="max-w-6xl mx-auto space-y-6">
                {/* Summary KPI Cards */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="bg-[#111828] border border-[#263450] rounded-2xl p-5">
                    <div className="text-xs text-slate-400">กล่องอีเมลทั้งหมด</div>
                    <div className="font-display text-2xl font-bold text-slate-50 mt-1 tabular-nums">
                      {overview?.inboxesTotal ?? frontendInboxes.length}
                    </div>
                  </div>
                  <div className="bg-[#111828] border border-[#263450] rounded-2xl p-5">
                    <div className="text-xs text-slate-400">ข้อความในระบบทั้งหมด</div>
                    <div className="font-display text-2xl font-bold text-slate-50 mt-1 tabular-nums">
                      {overview?.messagesTotal ?? 0}
                    </div>
                  </div>
                  <div className="bg-[#111828] border border-[#263450] rounded-2xl p-5">
                    <div className="text-xs text-slate-400">ข้อความที่มี OTP / Link</div>
                    <div className="font-display text-2xl font-bold text-[#8da2ff] mt-1 tabular-nums">
                      {overview?.otpCount ?? 0}
                    </div>
                  </div>
                  <div className="bg-[#111828] border border-[#263450] rounded-2xl p-5">
                    <div className="text-xs text-slate-400">API Keys / Webhooks</div>
                    <div className="font-display text-2xl font-bold text-amber-300 mt-1 tabular-nums">
                      {overview?.apiKeysCount ?? 0} / {overview?.webhooksCount ?? 0}
                    </div>
                  </div>
                </div>

                {/* Provider Breakdown & Maintenance */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <section className="bg-[#111828] border border-[#263450] rounded-2xl p-6 space-y-4">
                    <h2 className="font-display text-base font-bold text-slate-100">
                      แยกตามผู้ให้บริการ (Provider Breakdown)
                    </h2>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                      {[
                        { key: 'mail.tm', label: 'Live MX (mail.tm)' },
                        { key: 'gmail-alias', label: 'Gmail Alias' },
                        { key: 'outlook-alias', label: 'Outlook Alias' },
                        { key: 'webhook', label: 'Webhook' },
                        { key: 'smtp', label: 'SMTP Bridge' },
                      ].map((item) => (
                        <div
                          key={item.key}
                          className="p-3 rounded-xl bg-[#0b101b] border border-[#22304a]"
                        >
                          <div className="text-slate-400">{item.label}</div>
                          <div className="font-mono text-lg font-bold text-slate-100 mt-0.5 tabular-nums">
                            {overview?.byProvider?.[item.key as keyof AdminOverview['byProvider']] ??
                              0}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="bg-[#111828] border border-[#263450] rounded-2xl p-6 space-y-4">
                    <div className="flex items-center justify-between gap-2">
                      <h2 className="font-display text-base font-bold text-slate-100">
                        สถานะเซิร์ฟเวอร์และบำรุงรักษา
                      </h2>
                      <span className="font-mono text-xs text-emerald-400">
                        Uptime: {formatUptime(overview?.uptimeSeconds ?? healthReport?.uptimeSeconds ?? 0)}
                      </span>
                    </div>

                    <div className="space-y-2 text-xs">
                      <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-[#0b101b] border border-[#22304a]">
                        <span className="flex items-center gap-2 text-slate-300">
                          <Database className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                          <span>ฐานข้อมูล SQLite</span>
                        </span>
                        <span className="text-emerald-400 font-semibold">
                          {healthReport?.components.database.detail || 'Operational'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-[#0b101b] border border-[#22304a]">
                        <span className="flex items-center gap-2 text-slate-300">
                          <Server className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
                          <span>Inbound SMTP Bridge</span>
                        </span>
                        <span className="font-mono text-slate-200">
                          {overview?.smtpPort ? `Port ${overview.smtpPort}` : 'Disabled'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-[#0b101b] border border-[#22304a]">
                        <span className="flex items-center gap-2 text-slate-300">
                          <ShieldCheck className="w-3.5 h-3.5 text-amber-300" aria-hidden="true" />
                          <span>External API Auth</span>
                        </span>
                        <span className="font-semibold text-slate-200">
                          {overview?.requireApiKey ? 'Strict API Key' : 'Open / Session'}
                        </span>
                      </div>
                    </div>

                    <div className="pt-1 flex justify-end">
                      <button
                        type="button"
                        onClick={() => void handleMaintenancePrune()}
                        disabled={pruning}
                        className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-950 bg-amber-400 hover:bg-amber-300 rounded-xl cursor-pointer disabled:opacity-50"
                      >
                        <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>{pruning ? 'กำลังล้างข้อมูล…' : 'ล้างกล่องหมดอายุ & Log เก่า'}</span>
                      </button>
                    </div>
                  </section>
                </div>

                {/* Recent Errors */}
                <section className="bg-[#111828] border border-[#263450] rounded-2xl p-6 space-y-3">
                  <h2 className="font-display text-base font-bold text-slate-100">
                    เหตุการณ์แจ้งเตือน / Error ล่าสุด
                  </h2>
                  {!overview?.recentErrors?.length ? (
                    <div className="px-4 py-3 rounded-xl bg-[#0b101b] border border-[#22304a] text-xs text-emerald-300 flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
                      <span>ไม่พบข้อผิดพลาดล่าสุด เซิร์ฟเวอร์ทำงานปกติ</span>
                    </div>
                  ) : (
                    <div className="divide-y divide-[#1f2b42] border border-[#22304a] rounded-xl bg-[#0b101b] overflow-hidden">
                      {overview.recentErrors.map((ev) => (
                        <div key={ev.id} className="px-4 py-2.5 flex items-center justify-between gap-3 text-xs">
                          <div className="min-w-0">
                            <div className="font-semibold text-amber-200 truncate">{ev.summary}</div>
                            {ev.detail && <div className="text-slate-400 truncate">{ev.detail}</div>}
                          </div>
                          <span className="font-mono text-[11px] text-slate-500 shrink-0">
                            {formatRelativeTime(ev.timestamp)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            </div>
          )}

          {activeTab === 'inboxes' && (
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
              <div className="max-w-6xl mx-auto space-y-4">
                <div className="bg-[#111828] border border-[#263450] rounded-2xl p-4 flex flex-wrap items-center gap-3">
                  <input
                    type="search"
                    value={inboxQuery}
                    onChange={(e) => setInboxQuery(e.target.value)}
                    placeholder="ค้นหาอีเมล, ป้ายกำกับ หรือ Inbox ID…"
                    className="flex-1 min-w-[200px] px-3.5 py-2 text-xs bg-[#0b101b] text-slate-100 border border-[#2c3b59] rounded-xl focus:outline-none focus:border-amber-400"
                  />
                  <select
                    aria-label="Filter by provider"
                    value={providerFilter}
                    onChange={(e) => setProviderFilter(e.target.value)}
                    className="px-3 py-2 text-xs bg-[#0b101b] text-slate-100 border border-[#2c3b59] rounded-xl"
                  >
                    <option value="all">ทุกผู้ให้บริการ</option>
                    <option value="mail.tm">Live MX (mail.tm)</option>
                    <option value="gmail-alias">Gmail Alias</option>
                    <option value="outlook-alias">Outlook Alias</option>
                    <option value="webhook">Webhook</option>
                    <option value="smtp">SMTP Bridge</option>
                  </select>
                  <select
                    aria-label="Filter by status"
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="px-3 py-2 text-xs bg-[#0b101b] text-slate-100 border border-[#2c3b59] rounded-xl"
                  >
                    <option value="all">ทุกสถานะ</option>
                    <option value="active">Active</option>
                    <option value="paused">Paused</option>
                    <option value="error">Error</option>
                  </select>
                </div>

                <div className="bg-[#111828] border border-[#263450] rounded-2xl overflow-hidden">
                  {adminInboxes.length === 0 ? (
                    <div className="p-10 text-center text-xs text-slate-400">
                      ไม่พบกล่องอีเมลที่ตรงกับตัวกรอง
                    </div>
                  ) : (
                    <div className="divide-y divide-[#1f2b42]">
                      {adminInboxes.map((inbox) => (
                        <div
                          key={inbox.id}
                          className="p-4 flex flex-wrap items-center justify-between gap-4 hover:bg-[#141d30]"
                        >
                          <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-sm font-semibold text-slate-100">
                                {inbox.address}
                              </span>
                              <span className="text-[11px] px-2 py-0.5 rounded bg-[#18233c] border border-[#2c3e66] text-slate-300">
                                {inbox.provider}
                              </span>
                              <span
                                className={`text-[11px] font-semibold px-2 py-0.5 rounded border ${
                                  inbox.status === 'active'
                                    ? 'text-emerald-300 bg-emerald-950/40 border-emerald-500/40'
                                    : 'text-amber-300 bg-amber-950/40 border-amber-500/40'
                                }`}
                              >
                                {inbox.status}
                              </span>
                            </div>
                            <div className="text-xs text-slate-400 flex flex-wrap items-center gap-2">
                              <span>{inbox.label}</span>
                              <span>·</span>
                              <span>{inbox.messageCount} ข้อความ</span>
                              <span>·</span>
                              <span>{formatTtlRemaining(inbox.expiresAt)}</span>
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              onClick={() => onOpenInboxInFrontend(inbox)}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-200 bg-[#151e32] border border-[#2c3b59] hover:border-[#637bff] rounded-lg cursor-pointer"
                            >
                              <Mail className="w-3.5 h-3.5" aria-hidden="true" />
                              <span>เปิดดูหน้าบ้าน</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleToggleInboxStatus(inbox)}
                              title={inbox.status === 'paused' ? 'เปิดใช้งาน' : 'หยุดชั่วคราว'}
                              className="p-1.5 text-slate-300 bg-[#151e32] border border-[#2c3b59] hover:border-amber-400/60 rounded-lg cursor-pointer"
                            >
                              {inbox.status === 'paused' ? (
                                <PlayCircle className="w-4 h-4 text-emerald-400" aria-hidden="true" />
                              ) : (
                                <PauseCircle className="w-4 h-4 text-amber-300" aria-hidden="true" />
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDeleteAdminInbox(inbox)}
                              aria-label={`Delete ${inbox.address}`}
                              className="p-1.5 text-slate-400 hover:text-red-300 bg-[#151e32] border border-[#2c3b59] hover:border-red-500/60 rounded-lg cursor-pointer"
                            >
                              <Trash2 className="w-4 h-4" aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'api' && (
            <ApiDocsView
              activeInbox={activeInbox}
              inboxes={frontendInboxes}
              webhookDomains={webhookDomains}
              liveSignal={apiRefreshSignal}
              onInboxUpdated={() => void onInboxesMutated()}
              onInboxCreated={() => void onInboxesMutated()}
              onCopyValue={onCopyValue}
              onNotify={onNotify}
            />
          )}

          {activeTab === 'activity' && (
            <ActivityLogView
              activities={activities}
              onRefresh={() => void onRefreshActivities()}
            />
          )}

          {activeTab === 'settings' && (
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
              <div className="max-w-3xl mx-auto space-y-6">
                <form
                  onSubmit={handleSaveServerSettings}
                  className="bg-[#111828] border border-[#263450] rounded-2xl p-6 space-y-5"
                >
                  <div className="flex items-center gap-2.5">
                    <Webhook className="w-4 h-4 text-amber-300" aria-hidden="true" />
                    <h2 className="font-display text-base font-bold text-slate-100">
                      นโยบาย API และการจัดเก็บข้อมูล (Server Policy)
                    </h2>
                  </div>

                  <label className="flex items-start gap-3 p-3.5 rounded-xl bg-[#0b101b] border border-[#22304a] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={requireApiKey}
                      onChange={(e) => setRequireApiKey(e.target.checked)}
                      className="mt-0.5 accent-amber-400"
                    />
                    <div className="text-xs">
                      <div className="font-semibold text-slate-100">
                        บังคับใช้ API Key สำหรับผู้เรียกจากภายนอก (REQUIRE_API_KEY)
                      </div>
                      <div className="text-slate-400 mt-0.5">
                        เมื่อเปิดใช้งาน การเรียก REST API จากภายนอกต้องแนบ Header Authorization: Bearer fm_live_...
                      </div>
                    </div>
                  </label>

                  <div>
                    <label htmlFor="admin-retention-days" className="block text-xs font-semibold text-slate-300 mb-1.5">
                      ระยะเวลาเก็บประวัติข้อความและ Log (วัน)
                    </label>
                    <input
                      id="admin-retention-days"
                      type="number"
                      min={1}
                      max={365}
                      value={retentionDays}
                      onChange={(e) => setRetentionDays(Number(e.target.value) || 30)}
                      className="w-36 px-3.5 py-2 font-mono text-sm bg-[#0b101b] text-slate-100 border border-[#2c3b59] rounded-xl"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <div className="p-3 rounded-xl bg-[#0b101b] border border-[#22304a]">
                      <div className="text-slate-400">Live MX / Alias Domains</div>
                      <div className="font-mono text-slate-200 mt-1 break-all">
                        {[...liveMxDomains, ...GMAIL_ALIAS_DOMAINS, ...OUTLOOK_ALIAS_DOMAINS].join(', ')}
                      </div>
                    </div>
                    <div className="p-3 rounded-xl bg-[#0b101b] border border-[#22304a]">
                      <div className="text-slate-400">Internal Webhook / SMTP Domains</div>
                      <div className="font-mono text-slate-200 mt-1 break-all">
                        {webhookDomains.join(', ')} (SMTP :{smtpPort ?? 'off'})
                      </div>
                    </div>
                  </div>

                  <div className="flex justify-end">
                    <button
                      type="submit"
                      disabled={savingSettings}
                      className="px-4 py-2 text-xs font-semibold text-slate-950 bg-amber-400 hover:bg-amber-300 rounded-xl cursor-pointer disabled:opacity-50"
                    >
                      {savingSettings ? 'กำลังบันทึก…' : 'บันทึกการตั้งค่าเซิร์ฟเวอร์'}
                    </button>
                  </div>
                </form>

                {/* Admin Passcode Management */}
                <form
                  onSubmit={handleChangePasscode}
                  className="bg-[#111828] border border-[#263450] rounded-2xl p-6 space-y-4"
                >
                  <div className="flex items-center gap-2.5">
                    <KeyRound className="w-4 h-4 text-amber-300" aria-hidden="true" />
                    <h2 className="font-display text-base font-bold text-slate-100">
                      เปลี่ยนรหัสผ่านระบบหลังบ้าน
                    </h2>
                  </div>

                  {adminStatus.envManaged ? (
                    <div className="px-3.5 py-2.5 rounded-xl bg-amber-950/30 border border-amber-500/35 text-xs text-amber-200 flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
                      <span>
                        รหัสผ่านถูกควบคุมโดยตัวแปร <span className="font-mono">ADMIN_PASSCODE</span> บนเซิร์ฟเวอร์
                      </span>
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label htmlFor="cur-admin-pass" className="block text-xs font-semibold text-slate-300 mb-1">
                            รหัสผ่านปัจจุบัน
                          </label>
                          <input
                            id="cur-admin-pass"
                            type="password"
                            required
                            value={curPass}
                            onChange={(e) => setCurPass(e.target.value)}
                            className="w-full px-3 py-2 text-sm bg-[#0b101b] text-slate-100 border border-[#2c3b59] rounded-xl"
                          />
                        </div>
                        <div>
                          <label htmlFor="new-admin-pass" className="block text-xs font-semibold text-slate-300 mb-1">
                            รหัสผ่านใหม่ (4+ ตัวอักษร)
                          </label>
                          <input
                            id="new-admin-pass"
                            type="password"
                            required
                            value={newPass}
                            onChange={(e) => setNewPass(e.target.value)}
                            className="w-full px-3 py-2 text-sm bg-[#0b101b] text-slate-100 border border-[#2c3b59] rounded-xl"
                          />
                        </div>
                      </div>
                      <div className="flex justify-end">
                        <button
                          type="submit"
                          disabled={savingPass}
                          className="px-4 py-2 text-xs font-semibold text-slate-200 bg-[#151e32] hover:bg-[#1c2842] border border-[#2c3b59] rounded-xl cursor-pointer disabled:opacity-50"
                        >
                          {savingPass ? 'กำลังอัปเดต…' : 'อัปเดตรหัสผ่าน'}
                        </button>
                      </div>
                    </>
                  )}
                </form>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
