import { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, KeyRound, MailOpen, RefreshCw, Search } from 'lucide-react';
import type { Inbox, OtpEntry } from '../../shared/types';
import { listOtpEntries } from '../api/client';
import { formatRelativeTime } from '../utils/format';

interface OtpCenterViewProps {
  inboxes: Inbox[];
  activeInbox: Inbox | null;
  syncing: boolean;
  onSync: () => void;
  onOpenMessageById: (inboxId: string, messageId: string) => void;
  onCopyValue: (val: string, label: string) => void;
  refreshSignal?: number;
}

export function OtpCenterView({
  inboxes,
  activeInbox,
  syncing,
  onSync,
  onOpenMessageById,
  onCopyValue,
  refreshSignal = 0,
}: OtpCenterViewProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedInboxFilter, setSelectedInboxFilter] = useState<string>(activeInbox?.id ?? 'all');
  const [kindFilter, setKindFilter] = useState<'all' | 'otp' | 'links'>('all');
  const [entries, setEntries] = useState<OtpEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void listOtpEntries({
      inboxId: selectedInboxFilter !== 'all' ? selectedInboxFilter : undefined,
      q: searchQuery.trim() || undefined,
      kind: kindFilter,
      limit: 100,
    })
      .then((res) => {
        if (!cancelled) setEntries(res.items);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedInboxFilter, searchQuery, kindFilter, refreshSignal]);

  const handleCopy = (val: string, id: string, label: string) => {
    onCopyValue(val, label);
    setCopiedId(id);
    setTimeout(() => setCopiedId((curr) => (curr === id ? null : curr)), 1600);
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-bold text-slate-50">ศูนย์ OTP</h1>
            <p className="mt-1 text-sm text-slate-400">
              รหัสยืนยันและลิงก์ที่ตรวจพบอัตโนมัติ ค้นหาและคัดลอกได้จากทุกกล่องจดหมาย
            </p>
          </div>

          {activeInbox && (
            <button
              type="button"
              onClick={onSync}
              disabled={syncing}
              className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-slate-200 bg-[#161f33] hover:bg-[#1c2842] border border-[#2c3a57] hover:border-[#4b618f] rounded-xl cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>{syncing ? 'กำลังตรวจสอบ…' : 'สแกนข้อความใหม่'}</span>
            </button>
          )}
        </div>

        {/* Search & Filter Toolbar */}
        <div className="bg-[#121929] border border-[#26334d] rounded-2xl p-3.5 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search
              className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <label htmlFor="otp-search-input" className="sr-only">
              ค้นหารหัส OTP หรือผู้ส่ง
            </label>
            <input
              id="otp-search-input"
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="ค้นหารหัส OTP, หัวข้ออีเมล หรือผู้ส่ง…"
              className="w-full pl-8.5 pr-3 py-2 text-xs bg-[#0b101b] border border-[#2c3b59] rounded-xl text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-[#637bff]"
            />
          </div>

          <div>
            <label htmlFor="otp-account-filter" className="sr-only">
              กรองตามบัญชีอีเมล
            </label>
            <select
              id="otp-account-filter"
              value={selectedInboxFilter}
              onChange={(e) => setSelectedInboxFilter(e.target.value)}
              className="px-3 py-2 text-xs font-mono bg-[#0b101b] border border-[#2c3b59] rounded-xl text-slate-100 focus:outline-none focus:border-[#637bff]"
            >
              <option value="all">ทุกบัญชี ({inboxes.length})</option>
              {inboxes.map((inb) => (
                <option key={inb.id} value={inb.id}>
                  {inb.address}
                </option>
              ))}
            </select>
          </div>

          <div
            role="tablist"
            aria-label="Filter OTP kind"
            className="flex items-center gap-1 p-0.5 bg-[#0b101b] border border-[#283552] rounded-xl"
          >
            {(
              [
                { id: 'all', label: 'ทั้งหมด' },
                { id: 'otp', label: 'รหัส OTP' },
                { id: 'links', label: 'ลิงก์ยืนยัน' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={kindFilter === tab.id}
                onClick={() => setKindFilter(tab.id)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                  kindFilter === tab.id
                    ? 'bg-[#637bff] text-white'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {loading && entries.length === 0 ? (
          <div className="bg-[#121929] border border-[#26334d] rounded-2xl p-8 text-center text-xs text-slate-400">
            กำลังสแกนรหัส OTP จากฐานข้อมูล…
          </div>
        ) : entries.length === 0 ? (
          <div className="bg-[#121929] border border-[#26334d] rounded-2xl p-10 text-center">
            <div className="w-12 h-12 rounded-xl bg-[#192440] border border-[#2c3b60] flex items-center justify-center mx-auto mb-3">
              <KeyRound className="w-5 h-5 text-[#7b93ff]" aria-hidden="true" />
            </div>
            <p className="text-sm font-semibold text-slate-100">ยังไม่พบรหัส OTP หรือลิงก์ยืนยันที่ตรงกัน</p>
            <p className="text-xs text-slate-400 mt-1.5 max-w-md mx-auto">
              เมื่อมีอีเมลยืนยันตัวตน รหัส 4–8 หลัก หรือ Magic Link ส่งเข้ามาในกล่อง ระบบจะดึงมาแสดงที่นี่ให้คัดลอกได้ในคลิกเดียว
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {entries.map((entry) => (
              <article
                key={entry.messageId}
                className="bg-[#121929] border border-[#26334d] rounded-2xl p-5 space-y-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs text-slate-400 flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-200">{entry.fromName || entry.from}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono text-[#8da2ff]">{entry.inboxAddress}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">{formatRelativeTime(entry.receivedAt)}</span>
                    </div>
                    <h2 className="font-display text-base font-semibold text-slate-50 mt-1">
                      {entry.subject}
                    </h2>
                  </div>

                  <button
                    type="button"
                    onClick={() => onOpenMessageById(entry.inboxId, entry.messageId)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-200 bg-[#161f33] hover:bg-[#1c2842] border border-[#2c3a57] hover:border-[#4b618f] rounded-lg cursor-pointer shrink-0"
                  >
                    <MailOpen className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>เปิดอ่านอีเมล</span>
                  </button>
                </div>

                {entry.otpCodes.length > 0 && (
                  <div className="flex flex-wrap items-center gap-3">
                    {entry.otpCodes.map((code) => (
                      <div
                        key={code}
                        className="inline-flex items-center gap-3 px-4 py-2.5 bg-[#0f1625] border border-[#2c3b5e] rounded-xl"
                      >
                        <span className="text-xs font-medium text-slate-400">รหัส OTP</span>
                        <span className="font-mono text-xl font-bold text-[#8da2ff] tracking-widest tabular-nums">
                          {code}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleCopy(code, `${entry.messageId}-${code}`, `Code ${code}`)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-white bg-[#637bff] hover:bg-[#526bf5] rounded-lg cursor-pointer"
                        >
                          {copiedId === `${entry.messageId}-${code}` ? (
                            <>
                              <Check className="w-3.5 h-3.5" aria-hidden="true" />
                              <span>คัดลอกแล้ว</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                              <span>คัดลอก</span>
                            </>
                          )}
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {entry.links.length > 0 && (
                  <div className="space-y-2">
                    {entry.links.slice(0, 3).map((link, idx) => (
                      <div
                        key={link.url}
                        className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 bg-[#0f1625] border border-[#24314b] rounded-xl"
                      >
                        <div className="min-w-0 flex-1">
                          <span className="text-[11px] font-semibold uppercase tracking-wide text-[#7b93ff]">
                            {link.kind.replace('-', ' ')}
                          </span>
                          <div className="font-mono text-xs text-slate-300 truncate">{link.url}</div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() =>
                              handleCopy(link.url, `${entry.messageId}-link-${idx}`, 'Link URL')
                            }
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-slate-200 bg-[#161f33] border border-[#2c3a57] hover:border-[#4b618f] rounded-lg cursor-pointer"
                          >
                            {copiedId === `${entry.messageId}-link-${idx}` ? (
                              <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                            )}
                            <span>คัดลอก</span>
                          </button>
                          <a
                            href={link.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-white bg-[#637bff] hover:bg-[#526bf5] rounded-lg"
                          >
                            <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>เปิดลิงก์</span>
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
