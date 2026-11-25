import {
  ArrowRight,
  Check,
  Copy,
  Database,
  Inbox as InboxIcon,
  KeyRound,
  RefreshCw,
  Send,
  ShieldCheck,
  Wand2,
  Webhook,
} from 'lucide-react';
import { useState } from 'react';
import type { EmailMessage, HealthReport, Inbox, OtpEntry } from '../../shared/types';
import { formatRelativeTime } from '../utils/format';
import type { NavSection } from './AppSidebar';

interface DashboardViewProps {
  inboxes: Inbox[];
  activeInbox: Inbox | null;
  messages: EmailMessage[];
  recentOtps?: OtpEntry[];
  healthReport?: HealthReport | null;
  onNavigate: (section: NavSection) => void;
  onSelectMessage: (msg: EmailMessage) => void;
  onSelectInboxAndMessage?: (inboxId: string, messageId: string) => void;
  onCopyAddress: (address: string) => void;
  onCopyValue: (val: string, label: string) => void;
  onQuickRandom?: () => void;
  onRefresh?: () => void;
  onOpenAdmin?: () => void;
}

export function DashboardView({
  inboxes,
  activeInbox,
  messages,
  recentOtps = [],
  healthReport,
  onNavigate,
  onSelectMessage,
  onSelectInboxAndMessage,
  onCopyAddress,
  onCopyValue,
  onQuickRandom,
  onRefresh,
  onOpenAdmin,
}: DashboardViewProps) {
  const [copiedAddr, setCopiedAddr] = useState(false);

  const totalMessages = inboxes.reduce((sum, i) => sum + i.messageCount, 0);
  const totalUnread = inboxes.reduce((sum, i) => sum + i.unreadCount, 0);
  const recentMessages = messages.filter((m) => m.folder !== 'trash').slice(0, 5);

  const derivedOtps =
    recentOtps.length > 0
      ? recentOtps.filter((o) => o.otpCodes.length > 0).slice(0, 4)
      : messages
          .filter((m) => m.folder !== 'trash' && m.extracted.otpCodes.length > 0)
          .slice(0, 4)
          .map((m) => ({
            messageId: m.id,
            inboxId: m.inboxId,
            inboxAddress: m.to,
            from: m.from,
            fromName: m.fromName,
            subject: m.subject,
            otpCodes: m.extracted.otpCodes,
            links: m.extracted.links,
            receivedAt: m.receivedAt,
          }));

  const handleCopyActive = () => {
    if (!activeInbox) return;
    onCopyAddress(activeInbox.address);
    setCopiedAddr(true);
    setTimeout(() => setCopiedAddr(false), 1600);
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1280px] mx-auto space-y-6">
        {/* Hero Card + 2x2 Live Stat Grid */}
        <section className="bg-[#121929] border border-[#26334d] rounded-2xl p-6 sm:p-8">
          <div className="grid grid-cols-1 xl:grid-cols-[1.35fr_1fr] gap-6 lg:gap-8 items-center">
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-xs font-semibold text-[#7b93ff]">
                <span className="inline-block w-4 h-0.5 bg-[#637bff]" aria-hidden="true" />
                <span>แดชบอร์ด</span>
              </div>

              <h1 className="font-display text-2xl sm:text-3xl font-bold text-slate-50 leading-tight max-w-xl">
                อีเมลชั่วคราวพร้อมใช้ในไม่กี่วินาที
              </h1>

              <p className="text-sm text-slate-400 leading-relaxed max-w-xl">
                สร้างกล่องจดหมายชั่วคราวเพื่อรับข้อความยืนยันและรหัส OTP โดยไม่ต้องเปิดเผยอีเมลส่วนตัวของคุณ
                ทุกอย่างรวมอยู่ที่เดียว — รับข้อความ อ่าน และคัดลอกรหัสได้ทันที
              </p>

              <div className="pt-2 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => onNavigate('create')}
                  className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-[#637bff] hover:bg-[#526bf5] rounded-xl shadow-lg shadow-[#637bff]/25 transition-colors whitespace-nowrap cursor-pointer"
                >
                  <Wand2 className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>สร้างอีเมลใหม่</span>
                </button>

                <button
                  type="button"
                  onClick={() => onNavigate('mailbox')}
                  className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-slate-200 bg-[#161f33] hover:bg-[#1c2842] border border-[#2c3a57] hover:border-[#4b618f] rounded-xl transition-colors whitespace-nowrap cursor-pointer"
                >
                  <InboxIcon className="w-4 h-4 shrink-0 text-slate-300" aria-hidden="true" />
                  <span>เปิดกล่องจดหมาย</span>
                </button>

                <button
                  type="button"
                  onClick={() => onNavigate('otp')}
                  className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-slate-200 bg-[#161f33] hover:bg-[#1c2842] border border-[#2c3a57] hover:border-[#4b618f] rounded-xl transition-colors whitespace-nowrap cursor-pointer"
                >
                  <KeyRound className="w-4 h-4 shrink-0 text-slate-300" aria-hidden="true" />
                  <span>ดูรหัส OTP</span>
                </button>
              </div>
            </div>

            {/* 2x2 Real Stats Grid */}
            <div className="grid grid-cols-2 gap-3.5">
              <div className="bg-[#161f33] border border-[#26334d] rounded-xl p-4 sm:p-5">
                <div className="font-display text-2xl font-bold text-slate-50 tabular-nums">
                  {inboxes.length}
                </div>
                <div className="mt-1 text-xs text-slate-400">กล่องที่บันทึก</div>
              </div>

              <div className="bg-[#161f33] border border-[#26334d] rounded-xl p-4 sm:p-5">
                <div className="font-display text-2xl font-bold text-slate-50 tabular-nums">
                  {totalMessages}
                </div>
                <div className="mt-1 text-xs text-slate-400">ข้อความทั้งหมด</div>
              </div>

              <div className="bg-[#161f33] border border-[#26334d] rounded-xl p-4 sm:p-5">
                <div className="font-display text-2xl font-bold text-slate-50 tabular-nums">
                  {totalUnread}
                </div>
                <div className="mt-1 text-xs text-slate-400">ข้อความยังไม่อ่าน</div>
              </div>

              <div className="bg-[#161f33] border border-[#26334d] rounded-xl p-4 sm:p-5 flex flex-col justify-between min-w-0">
                {activeInbox ? (
                  <>
                    <div className="font-display text-base sm:text-xl font-bold text-emerald-400 truncate">
                      {activeInbox.status === 'paused'
                        ? 'หยุดชั่วคราว'
                        : activeInbox.mode === 'live-mx'
                          ? 'Live MX'
                          : activeInbox.provider === 'gmail-alias'
                            ? 'Gmail Alias'
                            : activeInbox.provider === 'outlook-alias'
                              ? 'Outlook Alias'
                              : 'Webhook / SMTP'}
                    </div>
                    <button
                      type="button"
                      onClick={handleCopyActive}
                      title={activeInbox.address}
                      className="mt-1 text-left font-mono text-xs text-slate-400 hover:text-slate-200 truncate cursor-pointer flex items-center gap-1.5"
                    >
                      <span className="truncate">{activeInbox.address}</span>
                      {copiedAddr ? (
                        <Check className="w-3 h-3 text-emerald-400 shrink-0" aria-hidden="true" />
                      ) : (
                        <Copy className="w-3 h-3 shrink-0" aria-hidden="true" />
                      )}
                    </button>
                  </>
                ) : (
                  <>
                    <div className="font-display text-xl font-bold text-slate-100">ไม่มีกล่อง</div>
                    <div className="mt-1 text-xs text-slate-400">สถานะกล่อง</div>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Quick Actions & System Health Bar */}
          <div className="mt-6 pt-5 border-t border-[#222e46] flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {onQuickRandom && (
                <button
                  type="button"
                  onClick={onQuickRandom}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-200 bg-[#161f33] hover:bg-[#1c2842] border border-[#2c3a57] hover:border-[#637bff] rounded-lg cursor-pointer"
                >
                  <Wand2 className="w-3.5 h-3.5 text-[#7b93ff]" aria-hidden="true" />
                  <span>สุ่มอีเมลทันที</span>
                </button>
              )}
              {onRefresh && (
                <button
                  type="button"
                  onClick={onRefresh}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-200 bg-[#161f33] hover:bg-[#1c2842] border border-[#2c3a57] hover:border-[#637bff] rounded-lg cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                  <span>ซิงก์ข้อความล่าสุด</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => onNavigate('addresses')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-300 bg-[#161f33] hover:bg-[#1c2842] border border-[#2c3a57] hover:border-[#4b618f] rounded-lg cursor-pointer"
              >
                <span>จัดการบัญชีของฉัน ({inboxes.length})</span>
              </button>
            </div>

            {healthReport && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#0f1625] border border-[#24314b] text-slate-300">
                  <Database className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                  <span>
                    SQLite:{' '}
                    <strong className="text-emerald-400">
                      {healthReport.components.database.status === 'ok' ? 'พร้อมใช้' : 'ผิดปกติ'}
                    </strong>
                  </span>
                </span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#0f1625] border border-[#24314b] text-slate-300">
                  <ShieldCheck
                    className={`w-3.5 h-3.5 ${
                      healthReport.components.emailProvider.status === 'ok'
                        ? 'text-emerald-400'
                        : 'text-amber-400'
                    }`}
                    aria-hidden="true"
                  />
                  <span>
                    Mail Provider:{' '}
                    <strong
                      className={
                        healthReport.components.emailProvider.status === 'ok'
                          ? 'text-emerald-400'
                          : 'text-amber-400'
                      }
                    >
                      {healthReport.components.emailProvider.status === 'ok'
                        ? 'Live MX'
                        : 'Degraded'}
                    </strong>
                  </span>
                </span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#0f1625] border border-[#24314b] text-slate-300">
                  <Webhook className="w-3.5 h-3.5 text-[#7b93ff]" aria-hidden="true" />
                  <span>
                    Webhook / SMTP:{' '}
                    <strong className="text-[#8da2ff]">
                      {healthReport.components.webhookProcessing.status === 'ok'
                        ? 'พร้อมรับ'
                        : 'ตรวจสอบ'}
                    </strong>
                  </span>
                </span>
              </div>
            )}
          </div>
        </section>

        {/* Recent OTP Quick-Copy Strip (when OTPs exist) */}
        {derivedOtps.length > 0 && (
          <section className="bg-[#121929] border border-[#26334d] rounded-2xl p-5">
            <div className="flex items-center justify-between gap-4 mb-3.5">
              <div className="flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-[#7b93ff]" aria-hidden="true" />
                <h2 className="font-display text-sm font-bold text-slate-100">
                  รหัส OTP ล่าสุด (คัดลอกด่วน)
                </h2>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('otp')}
                className="text-xs font-semibold text-slate-400 hover:text-[#7b93ff] cursor-pointer"
              >
                เปิดศูนย์ OTP
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {derivedOtps.map((entry) => {
                const code = entry.otpCodes[0];
                return (
                  <div
                    key={`${entry.messageId}-${code}`}
                    className="bg-[#0f1625] border border-[#26334d] rounded-xl p-3.5 flex items-center justify-between gap-2"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (onSelectInboxAndMessage) {
                          onSelectInboxAndMessage(entry.inboxId, entry.messageId);
                        }
                      }}
                      className="min-w-0 text-left cursor-pointer"
                    >
                      <div className="font-mono text-lg font-bold text-[#8da2ff] tracking-wider tabular-nums">
                        {code}
                      </div>
                      <div className="text-[11px] text-slate-400 truncate mt-0.5">
                        {entry.fromName || entry.from} · {entry.inboxAddress}
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => onCopyValue(code, `OTP ${code}`)}
                      aria-label={`Copy OTP ${code}`}
                      className="p-2 text-slate-200 bg-[#192440] border border-[#324675] hover:border-[#637bff] rounded-lg cursor-pointer shrink-0"
                    >
                      <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Bottom Two-Column Section */}
        <div className="grid grid-cols-1 lg:grid-cols-[1.45fr_1fr] gap-6">
          {/* Recent Messages Card */}
          <section className="bg-[#121929] border border-[#26334d] rounded-2xl p-5 sm:p-6 flex flex-col">
            <div className="flex items-center justify-between gap-4 mb-4">
              <h2 className="font-display text-base font-bold text-slate-100">
                ข้อความล่าสุด
              </h2>
              <button
                type="button"
                onClick={() => onNavigate('mailbox')}
                className="text-xs font-semibold text-slate-400 hover:text-[#7b93ff] transition-colors whitespace-nowrap cursor-pointer"
              >
                ดูทั้งหมด
              </button>
            </div>

            {recentMessages.length === 0 ? (
              <div className="flex-1 min-h-[168px] border border-dashed border-[#2b3957] bg-[#0f1625] rounded-xl flex flex-col items-center justify-center p-6 text-center gap-3">
                <p className="text-xs sm:text-sm text-slate-400">
                  {activeInbox
                    ? `ยังไม่มีข้อความใน ${activeInbox.address} — ส่งอีเมลเข้ามาเพื่อดูผลแบบเรียลไทม์`
                    : 'ยังไม่มีกล่องจดหมาย — เริ่มจากสร้างอีเมลชั่วคราวใหม่ได้เลย'}
                </p>
                {activeInbox && (
                  <button
                    type="button"
                    onClick={handleCopyActive}
                    className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-mono text-[#8da2ff] bg-[#162038] border border-[#2c3d63] hover:border-[#637bff] rounded-lg cursor-pointer"
                  >
                    <span>{activeInbox.address}</span>
                    {copiedAddr ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                  </button>
                )}
              </div>
            ) : (
              <div className="divide-y divide-[#222e46] border border-[#24314b] bg-[#0f1625] rounded-xl overflow-hidden">
                {recentMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className="px-4 py-3 flex items-center justify-between gap-3 hover:bg-[#172136] transition-colors"
                  >
                    <button
                      type="button"
                      onClick={() => onSelectMessage(msg)}
                      className="flex-1 min-w-0 text-left cursor-pointer"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`text-xs truncate ${
                            !msg.read ? 'font-semibold text-slate-100' : 'text-slate-400'
                          }`}
                        >
                          {msg.fromName || msg.from}
                        </span>
                        {!msg.read && (
                          <span className="text-[11px] font-medium text-[#7b93ff] shrink-0">
                            ใหม่
                          </span>
                        )}
                      </div>
                      <div className="text-sm font-medium text-slate-200 truncate mt-0.5">
                        {msg.subject}
                      </div>
                    </button>

                    <div className="flex items-center gap-2.5 shrink-0">
                      {msg.extracted.primaryOtp && (
                        <button
                          type="button"
                          onClick={() =>
                            onCopyValue(msg.extracted.primaryOtp!, `OTP ${msg.extracted.primaryOtp}`)
                          }
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono font-semibold text-[#8da2ff] bg-[#192440] border border-[#2f416b] hover:border-[#637bff] rounded-md cursor-pointer tabular-nums"
                        >
                          <span>{msg.extracted.primaryOtp}</span>
                          <Copy className="w-3 h-3" aria-hidden="true" />
                        </button>
                      )}
                      <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                        {formatRelativeTime(msg.receivedAt)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Quick Start Guide Card */}
          <section className="bg-[#121929] border border-[#26334d] rounded-2xl p-5 sm:p-6 flex flex-col justify-between">
            <div>
              <h2 className="font-display text-base font-bold text-slate-100 mb-5">
                เริ่มต้นใช้งาน
              </h2>

              <div className="space-y-4">
                <div className="flex items-start gap-3.5">
                  <div className="w-9 h-9 rounded-xl bg-[#192440] border border-[#2c3b60] text-[#7b93ff] flex items-center justify-center shrink-0">
                    <Wand2 className="w-4 h-4" aria-hidden="true" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100">สร้างกล่องจดหมาย</h3>
                    <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">
                      เลือกโดเมน Live MX, Gmail Alias, Outlook Alias หรือ Webhook / SMTP แล้วกดสร้างได้ทันที
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3.5">
                  <div className="w-9 h-9 rounded-xl bg-[#192440] border border-[#2c3b60] text-[#7b93ff] flex items-center justify-center shrink-0">
                    <Send className="w-4 h-4" aria-hidden="true" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100">นำอีเมลไปใช้</h3>
                    <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">
                      คัดลอกที่อยู่อีเมลไปกรอกในเว็บหรือแอปที่ต้องการยืนยันตัวตน
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3.5">
                  <div className="w-9 h-9 rounded-xl bg-[#192440] border border-[#2c3b60] text-[#7b93ff] flex items-center justify-center shrink-0">
                    <KeyRound className="w-4 h-4" aria-hidden="true" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100">รับรหัส OTP</h3>
                    <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">
                      กลับมาที่ศูนย์ OTP หรือกล่องจดหมาย ระบบจะสแกนข้อความใหม่และแสดงรหัสให้คัดลอกทันที
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="pt-5 mt-5 border-t border-[#222e46]">
              <button
                type="button"
                onClick={() => (onOpenAdmin ? onOpenAdmin() : onNavigate('create'))}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-300 hover:text-amber-300 transition-colors cursor-pointer"
              >
                <span>ระบบหลังบ้าน: API, Webhooks &amp; จัดการเซิร์ฟเวอร์</span>
                <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
