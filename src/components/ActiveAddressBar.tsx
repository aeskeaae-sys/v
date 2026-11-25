import { useState } from 'react';
import {
  Check,
  Columns2,
  Copy,
  Eraser,
  LayoutList,
  RefreshCw,
} from 'lucide-react';
import type { Inbox } from '../../shared/types';
import { formatTtlRemaining } from '../utils/format';

export type MailboxLayout = 'list' | 'split';

interface ActiveAddressBarProps {
  inbox: Inbox | null;
  inboxes: Inbox[];
  messageCount: number;
  sseConnected: boolean;
  syncing: boolean;
  layout: MailboxLayout;
  onSelectInbox: (inbox: Inbox) => void;
  onChangeLayout: (layout: MailboxLayout) => void;
  onCopyAddress: (address: string) => void;
  onCheckMail: () => void;
  onClearInbox: () => void;
}

export function ActiveAddressBar({
  inbox,
  inboxes,
  messageCount,
  sseConnected,
  syncing,
  layout,
  onSelectInbox,
  onChangeLayout,
  onCopyAddress,
  onCheckMail,
  onClearInbox,
}: ActiveAddressBarProps) {
  const [copied, setCopied] = useState(false);

  if (!inbox) return null;

  const handleCopy = () => {
    onCopyAddress(inbox.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="shrink-0 bg-[#121929] border-b border-[#26334d] px-4 sm:px-6 py-3.5 flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2.5 min-w-0">
          {inboxes.length > 1 ? (
            <div className="min-w-0 max-w-full">
              <label htmlFor="active-mailbox-switcher" className="sr-only">
                เลือกกล่องจดหมาย
              </label>
              <select
                id="active-mailbox-switcher"
                value={inbox.id}
                onChange={(e) => {
                  const found = inboxes.find((i) => i.id === e.target.value);
                  if (found) onSelectInbox(found);
                }}
                className="max-w-full px-3 py-1.5 font-mono text-sm font-semibold text-slate-100 bg-[#0b101b] border border-[#2d3d5e] hover:border-[#4b618f] rounded-lg focus:outline-none focus:border-[#637bff] cursor-pointer"
              >
                {inboxes.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.address} ({item.messageCount})
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <span className="font-mono text-sm sm:text-base font-semibold text-slate-100 truncate max-w-full">
              {inbox.address}
            </span>
          )}

          <button
            type="button"
            onClick={handleCopy}
            aria-label={`Copy active address ${inbox.address}`}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-[#9fb2ff] bg-[#192440] hover:bg-[#223056] border border-[#324675] hover:border-[#637bff] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                <span>คัดลอกแล้ว</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                <span className="sm:hidden">คัดลอก</span>
                <span className="hidden sm:inline">คัดลอกอีเมล</span>
              </>
            )}
          </button>
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-400">
          <span
            className={
              inbox.mode === 'live-mx' || inbox.provider === 'gmail-alias'
                ? 'text-emerald-400 font-semibold'
                : inbox.provider === 'outlook-alias'
                  ? 'text-sky-400 font-semibold'
                  : 'text-[#8da2ff] font-semibold'
            }
          >
            {inbox.mode === 'live-mx'
              ? 'Live MX (รับเมลจริงจากภายนอก)'
              : inbox.provider === 'gmail-alias'
                ? 'Gmail Alias (รับเมลจริงผ่าน Gmail API)'
                : inbox.provider === 'outlook-alias'
                  ? 'Outlook Alias (รับเมลจริงเข้ากล่อง Outlook)'
                  : 'Webhook / Local SMTP (ไม่รับเมลภายนอก)'}
          </span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">{formatTtlRemaining(inbox.expiresAt)}</span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">{messageCount} ข้อความ</span>
          <span aria-hidden="true">·</span>
          <span className={sseConnected ? 'text-slate-400' : 'text-amber-400 font-medium'}>
            {sseConnected ? 'ซิงก์อัตโนมัติ' : 'กำลังเชื่อมต่อใหม่'}
          </span>
        </div>
        {inbox.syncError && (
          <p className="mt-1 text-[11px] font-medium text-amber-300 truncate">
            {inbox.syncError}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={onCheckMail}
          disabled={syncing}
          aria-label="Check for new mail"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-200 bg-[#161f33] border border-[#2c3a57] hover:border-[#4b618f] hover:bg-[#1c2842] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
          <span>{syncing ? 'กำลังเช็ค…' : 'เช็คเมล'}</span>
        </button>

        {messageCount > 0 && (
          <button
            type="button"
            onClick={onClearInbox}
            aria-label={`Clear all messages in ${inbox.address}`}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:text-red-300 bg-[#161f33] border border-[#2c3a57] hover:border-red-500/60 hover:bg-red-950/40 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Eraser className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">ล้างกล่อง</span>
          </button>
        )}

        {/* Layout mode toggle (desktop lg+) */}
        <div
          role="group"
          aria-label="Mailbox display layout"
          className="hidden lg:flex items-center p-0.5 bg-[#0b101b] border border-[#2c3a57] rounded-lg"
        >
          <button
            type="button"
            onClick={() => onChangeLayout('list')}
            aria-pressed={layout === 'list'}
            title="Full-width message list"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              layout === 'list'
                ? 'bg-[#637bff] text-white'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            <LayoutList className="w-3.5 h-3.5" aria-hidden="true" />
            <span>List</span>
          </button>
          <button
            type="button"
            onClick={() => onChangeLayout('split')}
            aria-pressed={layout === 'split'}
            title="Split list and reader"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              layout === 'split'
                ? 'bg-[#637bff] text-white'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            <Columns2 className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Split</span>
          </button>
        </div>
      </div>
    </div>
  );
}
