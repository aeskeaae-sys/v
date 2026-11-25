import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import {
  FileEdit,
  Inbox as InboxIcon,
  Mail,
  MailOpen,
  PenSquare,
  RotateCcw,
  Search,
  Send,
  ShieldAlert,
  Star,
  StarOff,
  Trash2,
  X,
} from 'lucide-react';
import type { EmailMessage, Inbox, MessageFolder } from '../../shared/types';
import type { BulkMessageAction } from '../api/client';
import { formatRelativeTime } from '../utils/format';
import type { MailboxLayout } from './ActiveAddressBar';

export type QuickMessageFilter = 'all' | 'unread' | 'starred' | 'codes';

interface MessageListProps {
  inbox: Inbox | null;
  messages: EmailMessage[];
  selectedMessageId: string | null;
  activeFolder: MessageFolder;
  layout: MailboxLayout;
  loading: boolean;
  gmailConnected?: boolean;
  onSelectFolder: (folder: MessageFolder) => void;
  onSelectMessage: (msg: EmailMessage) => void;
  onToggleStar: (msg: EmailMessage) => void;
  onToggleRead: (msg: EmailMessage) => void;
  onDeleteMessage: (msg: EmailMessage, permanent?: boolean) => void;
  onRestoreMessage?: (msg: EmailMessage) => void;
  onBulkAction?: (
    messageIds: string[],
    action: BulkMessageAction,
    permanent?: boolean,
  ) => Promise<void> | void;
  onCompose?: () => void;
  onCopyAddress: (address: string) => void;
  onNavigateToCreate?: () => void;
  onConnectGmail?: () => void;
  onCheckMail?: () => void;
}

function senderInitial(msg: EmailMessage): string {
  const source = (msg.fromName || msg.from || '?').trim();
  return (source[0] || '?').toUpperCase();
}

const FOLDERS: Array<{ id: MessageFolder; label: string; icon: typeof InboxIcon }> = [
  { id: 'inbox', label: 'กล่องเข้า', icon: InboxIcon },
  { id: 'sent', label: 'ส่งแล้ว', icon: Send },
  { id: 'drafts', label: 'ร่าง', icon: FileEdit },
  { id: 'spam', label: 'สแปม', icon: ShieldAlert },
  { id: 'trash', label: 'ถังขยะ', icon: Trash2 },
];

export function MessageList({
  inbox,
  messages,
  selectedMessageId,
  activeFolder,
  layout,
  loading,
  gmailConnected = false,
  onSelectFolder,
  onSelectMessage,
  onToggleStar,
  onToggleRead,
  onDeleteMessage,
  onRestoreMessage,
  onBulkAction,
  onCompose,
  onCopyAddress,
  onNavigateToCreate,
  onConnectGmail,
  onCheckMail,
}: MessageListProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [quickFilter, setQuickFilter] = useState<QuickMessageFilter>('all');
  const [copiedAddr, setCopiedAddr] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const lastClickedIdRef = useRef<string | null>(null);

  useEffect(() => {
    setSelectedIds(new Set());
    lastClickedIdRef.current = null;
  }, [inbox?.id, activeFolder]);

  const folderCounts = useMemo(() => {
    const counts: Record<MessageFolder, number> = {
      inbox: 0,
      sent: 0,
      drafts: 0,
      spam: 0,
      trash: 0,
    };
    for (const msg of messages) {
      const f = msg.folder || 'inbox';
      counts[f] = (counts[f] || 0) + 1;
    }
    return counts;
  }, [messages]);

  const filteredMessages = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return messages.filter((msg) => {
      const msgFolder = msg.folder || 'inbox';
      if (msgFolder !== activeFolder) return false;
      if (quickFilter === 'unread' && msg.read) return false;
      if (quickFilter === 'starred' && !msg.starred) return false;
      if (
        quickFilter === 'codes' &&
        msg.extracted.otpCodes.length === 0 &&
        msg.extracted.links.length === 0
      ) {
        return false;
      }
      if (!q) return true;
      const hay = `${msg.subject} ${msg.from} ${msg.to} ${msg.fromName || ''} ${msg.snippet}`.toLowerCase();
      return hay.includes(q);
    });
  }, [messages, searchQuery, activeFolder, quickFilter]);

  const selectedVisibleMessages = useMemo(
    () => filteredMessages.filter((m) => selectedIds.has(m.id)),
    [filteredMessages, selectedIds],
  );
  const selectedVisibleCount = selectedVisibleMessages.length;
  const allVisibleSelected =
    filteredMessages.length > 0 && selectedVisibleCount === filteredMessages.length;
  const someVisibleSelected =
    selectedVisibleCount > 0 && selectedVisibleCount < filteredMessages.length;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someVisibleSelected;
    }
  }, [someVisibleSelected]);

  const hasUnreadSelected = selectedVisibleMessages.some((m) => !m.read);
  const hasReadSelected = selectedVisibleMessages.some((m) => m.read);
  const hasUnstarredSelected = selectedVisibleMessages.some((m) => !m.starred);
  const hasStarredSelected = selectedVisibleMessages.some((m) => m.starred);

  const handleToggleSelectAll = () => {
    if (allVisibleSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const m of filteredMessages) next.delete(m.id);
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const m of filteredMessages) next.add(m.id);
        return next;
      });
    }
  };

  const handleRowCheckboxClick = (
    e: MouseEvent<HTMLInputElement>,
    msg: EmailMessage,
  ) => {
    e.stopPropagation();
    const isCheckedNow = !selectedIds.has(msg.id);

    if (e.shiftKey && lastClickedIdRef.current) {
      const ids = filteredMessages.map((m) => m.id);
      const start = ids.indexOf(lastClickedIdRef.current);
      const end = ids.indexOf(msg.id);
      if (start !== -1 && end !== -1) {
        const [lo, hi] = start < end ? [start, end] : [end, start];
        setSelectedIds((prev) => {
          const next = new Set(prev);
          for (let i = lo; i <= hi; i += 1) {
            if (isCheckedNow) next.add(ids[i]);
            else next.delete(ids[i]);
          }
          return next;
        });
        lastClickedIdRef.current = msg.id;
        return;
      }
    }

    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(msg.id)) next.delete(msg.id);
      else next.add(msg.id);
      return next;
    });
    lastClickedIdRef.current = msg.id;
  };

  const handleClearSelection = () => {
    setSelectedIds(new Set());
    lastClickedIdRef.current = null;
  };

  const triggerBulkAction = async (action: BulkMessageAction, permanent = false) => {
    if (selectedVisibleCount === 0 || bulkBusy) return;
    const targetMessages = selectedVisibleMessages;
    const targetIds = targetMessages.map((m) => m.id);
    setBulkBusy(true);
    try {
      if (onBulkAction) {
        await onBulkAction(targetIds, action, permanent);
      } else {
        for (const m of targetMessages) {
          if (action === 'markRead' && !m.read) onToggleRead(m);
          else if (action === 'markUnread' && m.read) onToggleRead(m);
          else if (action === 'star' && !m.starred) onToggleStar(m);
          else if (action === 'unstar' && m.starred) onToggleStar(m);
          else if (action === 'restore') onRestoreMessage?.(m);
          else if (action === 'delete') onDeleteMessage(m, permanent);
        }
      }
      setSelectedIds(new Set());
      lastClickedIdRef.current = null;
    } finally {
      setBulkBusy(false);
    }
  };

  const handleCopy = () => {
    if (!inbox) return;
    onCopyAddress(inbox.address);
    setCopiedAddr(true);
    setTimeout(() => setCopiedAddr(false), 1600);
  };

  if (!inbox) {
    return (
      <section className="flex-1 bg-[#0f1625] flex items-center justify-center p-8 text-center">
        <div>
          <Mail className="w-8 h-8 text-slate-500 mx-auto mb-3" aria-hidden="true" />
          <p className="text-sm font-semibold text-slate-200">ยังไม่ได้เลือกกล่องจดหมาย</p>
          <p className="text-xs text-slate-400 mt-1">
            สร้างที่อยู่อีเมลชั่วคราว Live MX หรือ Webhook เพื่อเริ่มรับข้อความ
          </p>
        </div>
      </section>
    );
  }

  const isSplit = layout === 'split';

  return (
    <section
      aria-label="Inbox messages"
      className={`${
        isSplit
          ? 'w-full lg:w-[400px] xl:w-[430px] shrink-0 lg:border-r lg:border-[#26334d]'
          : 'flex-1 w-full'
      } bg-[#0f1625] flex flex-col min-h-0`}
    >
      {/* Folder Tabs + Compose Row */}
      <div className="px-4 sm:px-5 py-2.5 border-b border-[#243049] flex flex-wrap items-center justify-between gap-2.5 bg-[#121929]">
        <div
          role="tablist"
          aria-label="Mailbox folders"
          className="flex items-center gap-1 p-0.5 bg-[#0b101b] border border-[#283552] rounded-lg overflow-x-auto max-w-full"
        >
          {FOLDERS.map((folder) => {
            const Icon = folder.icon;
            const count = folderCounts[folder.id];
            const active = activeFolder === folder.id;
            return (
              <button
                key={folder.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onSelectFolder(folder.id)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  active
                    ? 'bg-[#637bff] text-white'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>{folder.label}</span>
                {count > 0 && (
                  <span
                    className={`font-mono text-[10px] tabular-nums ${
                      active ? 'text-white/90' : 'text-slate-500'
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 flex-1 sm:flex-initial justify-end">
          {onCompose && (
            <button
              type="button"
              onClick={onCompose}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-[#637bff] hover:bg-[#526bf5] rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
            >
              <PenSquare className="w-3.5 h-3.5" aria-hidden="true" />
              <span>เขียนอีเมล</span>
            </button>
          )}
        </div>
      </div>

      {/* Quick Filter & Search Row */}
      <div className="px-4 sm:px-5 py-2 border-b border-[#202b42] flex flex-wrap items-center justify-between gap-2 bg-[#101727]">
        <div className="flex items-center gap-1">
          {(
            [
              { id: 'all', label: 'ทั้งหมด' },
              { id: 'unread', label: 'ยังไม่อ่าน' },
              { id: 'starred', label: 'ติดดาว' },
              { id: 'codes', label: 'รหัส OTP' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setQuickFilter(tab.id)}
              className={`px-2 py-1 text-[11px] font-semibold rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                quickFilter === tab.id
                  ? 'bg-[#1f2c4d] text-[#8da2ff] border border-[#324675]'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search
            className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            aria-hidden="true"
          />
          <label htmlFor="message-search-input" className="sr-only">
            ค้นหาข้อความ
          </label>
          <input
            id="message-search-input"
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="ค้นหาผู้ส่ง หัวข้อ หรือเนื้อหา…"
            className="w-full pl-8.5 pr-3 py-1.5 text-xs bg-[#0b101b] border border-[#2c3b59] rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-[#637bff]"
          />
        </div>
      </div>

      {/* Bulk Selection & Action Toolbar */}
      {filteredMessages.length > 0 && (
        <div
          role={selectedVisibleCount > 0 ? 'toolbar' : undefined}
          aria-label={selectedVisibleCount > 0 ? 'Bulk message actions' : undefined}
          className={`px-4 sm:px-5 py-2 border-b flex flex-wrap items-center justify-between gap-2 transition-colors ${
            selectedVisibleCount > 0
              ? 'bg-[#15203b] border-[#2f4270]'
              : 'bg-[#0d1423] border-[#202b42]'
          }`}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <label className="inline-flex items-center gap-2 cursor-pointer select-none">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allVisibleSelected}
                onChange={handleToggleSelectAll}
                aria-label="เลือกข้อความทั้งหมดที่แสดง"
                className="w-4 h-4 rounded border border-[#3a4b70] bg-[#0b101b] accent-[#637bff] cursor-pointer"
              />
              <span
                className={`text-xs font-semibold ${
                  selectedVisibleCount > 0 ? 'text-slate-100' : 'text-slate-400'
                }`}
              >
                {selectedVisibleCount > 0
                  ? `เลือกแล้ว ${selectedVisibleCount} ข้อความ`
                  : `เลือกทั้งหมด (${filteredMessages.length})`}
              </span>
            </label>

            {selectedVisibleCount > 0 && (
              <button
                type="button"
                onClick={handleClearSelection}
                disabled={bulkBusy}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-slate-300 hover:text-white bg-[#1e2c4f] hover:bg-[#283966] rounded-md transition-colors cursor-pointer disabled:opacity-50"
              >
                <X className="w-3 h-3" aria-hidden="true" />
                <span>ล้าง</span>
              </button>
            )}
          </div>

          {selectedVisibleCount > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {hasUnreadSelected && (
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={() => void triggerBulkAction('markRead')}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-slate-100 bg-[#1f2e52] hover:bg-[#2a3d6b] border border-[#364d85] rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                >
                  <MailOpen className="w-3.5 h-3.5 text-[#8da2ff]" aria-hidden="true" />
                  <span>อ่านแล้ว</span>
                </button>
              )}

              {hasReadSelected && (
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={() => void triggerBulkAction('markUnread')}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-slate-200 bg-[#18233e] hover:bg-[#223154] border border-[#2f4270] rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                >
                  <Mail className="w-3.5 h-3.5 text-slate-300" aria-hidden="true" />
                  <span>ยังไม่อ่าน</span>
                </button>
              )}

              {hasUnstarredSelected && (
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={() => void triggerBulkAction('star')}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-amber-200 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/35 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                >
                  <Star className="w-3.5 h-3.5 text-amber-400" fill="currentColor" aria-hidden="true" />
                  <span>ติดดาว</span>
                </button>
              )}

              {hasStarredSelected && (
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={() => void triggerBulkAction('unstar')}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-slate-200 bg-[#18233e] hover:bg-[#223154] border border-[#2f4270] rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                >
                  <StarOff className="w-3.5 h-3.5 text-slate-300" aria-hidden="true" />
                  <span>เอาดาวออก</span>
                </button>
              )}

              {(activeFolder === 'trash' || activeFolder === 'spam') && (
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={() => void triggerBulkAction('restore')}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-emerald-200 bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/35 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                >
                  <RotateCcw className="w-3.5 h-3.5 text-emerald-300" aria-hidden="true" />
                  <span>กู้คืน</span>
                </button>
              )}

              <button
                type="button"
                disabled={bulkBusy}
                onClick={() => void triggerBulkAction('delete', activeFolder === 'trash')}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-red-200 bg-red-500/15 hover:bg-red-500/25 border border-red-500/40 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5 text-red-300" aria-hidden="true" />
                <span>{activeFolder === 'trash' ? 'ลบถาวร' : 'ลบ'}</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Email Rows */}
      <div className="flex-1 overflow-y-auto divide-y divide-[#202b42]">
        {loading && messages.length === 0 ? (
          <div className="p-5 space-y-4" aria-busy="true">
            {[1, 2, 3, 4].map((n) => (
              <div key={n} className="flex items-center gap-3 py-1.5 animate-pulse">
                <div className="w-8 h-8 rounded-full bg-[#1a243d] shrink-0" />
                <div className="flex-1 grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="h-3.5 bg-[#1a243d] rounded w-3/4" />
                  <div className="h-3.5 bg-[#1a243d] rounded w-full sm:col-span-2" />
                </div>
              </div>
            ))}
          </div>
        ) : filteredMessages.length === 0 ? (
          <div className="h-full min-h-[280px] flex items-center justify-center p-8 text-center">
            <div className="max-w-md">
              <div className="w-11 h-11 rounded-xl bg-[#161f33] border border-[#2a3858] flex items-center justify-center mx-auto mb-3">
                <Mail className="w-5 h-5 text-[#7b93ff]" aria-hidden="true" />
              </div>
              <p className="text-sm font-semibold text-slate-100">
                {folderCounts[activeFolder] === 0
                  ? `ยังไม่มีข้อความในโฟลเดอร์ ${FOLDERS.find((f) => f.id === activeFolder)?.label}`
                  : 'ไม่พบข้อความที่ตรงกับการค้นหา'}
              </p>
              <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                {activeFolder === 'inbox' && folderCounts.inbox === 0
                  ? inbox.mode === 'live-mx'
                    ? `ส่งอีเมลจริงจาก Gmail, Outlook หรือเว็บสมัครสมาชิกมายัง ${inbox.address} ข้อความจะเข้าที่นี่อัตโนมัติ`
                    : inbox.provider === 'gmail-alias'
                      ? `ส่งอีเมลจริงจากเว็บหรือแอปใดก็ได้มายัง ${inbox.address} จากนั้นกด "เช็คเมล" เพื่อดึงข้อความจริงจากบัญชี Gmail ของคุณเข้ามาอ่านที่นี่`
                      : inbox.provider === 'outlook-alias'
                        ? `อีเมลจริงที่ส่งมายัง ${inbox.address} จะส่งตรงเข้ากล่องจดหมาย Outlook / Hotmail หลักของคุณทันที (Microsoft ไม่อนุญาตให้แอปภายนอกดึงเมล Outlook โดยตรง)`
                        : `ที่อยู่ ${inbox.address} เป็นโดเมนจำลองสำหรับ Webhook (POST /api/v1/inbound) หรือ SMTP พอร์ต 2525 เท่านั้น — เว็บภายนอกหรือ Gmail ไม่สามารถส่งเมลมาที่โดเมนนี้ได้`
                  : 'ลองเลือกโฟลเดอร์อื่นหรือล้างคำค้นหา'}
              </p>
              {activeFolder === 'inbox' && folderCounts.inbox === 0 && inbox.syncError && (
                <div className="mt-3 px-3.5 py-2.5 text-xs text-amber-200 bg-amber-950/40 border border-amber-500/40 rounded-xl leading-relaxed">
                  {inbox.syncError}
                </div>
              )}
              {activeFolder === 'inbox' && folderCounts.inbox === 0 && (
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
                  <div className="inline-flex items-center gap-2.5 px-3.5 py-2 bg-[#161f33] border border-[#2c3b59] rounded-xl">
                    <span className="font-mono text-xs text-slate-200">{inbox.address}</span>
                    <button
                      type="button"
                      onClick={handleCopy}
                      className="text-xs font-semibold text-[#7b93ff] hover:text-[#9fb2ff] cursor-pointer"
                    >
                      {copiedAddr ? 'คัดลอกแล้ว' : 'คัดลอก'}
                    </button>
                  </div>
                  {inbox.provider === 'gmail-alias' && !gmailConnected && onConnectGmail && (
                    <button
                      type="button"
                      onClick={onConnectGmail}
                      className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-slate-900 bg-white hover:bg-slate-100 rounded-xl cursor-pointer"
                    >
                      <span>เชื่อมต่อ Gmail เพื่อดึงเมล</span>
                    </button>
                  )}
                  {inbox.provider === 'gmail-alias' && gmailConnected && onCheckMail && (
                    <button
                      type="button"
                      onClick={onCheckMail}
                      className="px-3.5 py-2 text-xs font-semibold text-white bg-[#637bff] hover:bg-[#526bf5] rounded-xl cursor-pointer"
                    >
                      ดึงเมลจาก Gmail ตอนนี้
                    </button>
                  )}
                  {inbox.provider === 'outlook-alias' && (
                    <a
                      href="https://outlook.live.com/mail/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-3.5 py-2 text-xs font-semibold text-white bg-[#0284c7] hover:bg-[#0369a1] rounded-xl"
                    >
                      เปิด Outlook Mail
                    </a>
                  )}
                  {inbox.mode === 'webhook' && onNavigateToCreate && (
                    <button
                      type="button"
                      onClick={onNavigateToCreate}
                      className="px-3.5 py-2 text-xs font-semibold text-white bg-[#637bff] hover:bg-[#526bf5] rounded-xl cursor-pointer"
                    >
                      สร้างอีเมลรับเมลจริง (Live MX / Gmail)
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : (
          filteredMessages.map((msg) => {
            const isSelected = isSplit && msg.id === selectedMessageId;
            const isChecked = selectedIds.has(msg.id);
            return (
              <div
                key={msg.id}
                className={`group flex items-center gap-3 px-4 sm:px-5 py-3 transition-colors ${
                  isChecked
                    ? 'bg-[#1b2747]'
                    : isSelected
                      ? 'bg-[#1a2542]'
                      : !msg.read
                        ? 'bg-[#11192a] hover:bg-[#172138]'
                        : 'bg-[#0e1524] hover:bg-[#151e34]'
                }`}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onClick={(e) => handleRowCheckboxClick(e, msg)}
                  onChange={() => {}}
                  aria-label={`เลือกข้อความ ${msg.subject}`}
                  className="w-4 h-4 rounded border border-[#3a4b70] bg-[#0b101b] accent-[#637bff] shrink-0 cursor-pointer"
                />

                <button
                  type="button"
                  onClick={() => onToggleStar(msg)}
                  aria-label={msg.starred ? `Unstar ${msg.subject}` : `Star ${msg.subject}`}
                  className={`p-1 rounded transition-colors shrink-0 cursor-pointer ${
                    msg.starred
                      ? 'text-amber-400 hover:bg-amber-500/10'
                      : 'text-slate-500 hover:text-slate-300 hover:bg-[#1c2842]'
                  }`}
                >
                  <Star
                    className="w-4 h-4"
                    fill={msg.starred ? 'currentColor' : 'none'}
                    aria-hidden="true"
                  />
                </button>

                <button
                  type="button"
                  onClick={() => onSelectMessage(msg)}
                  className={`flex-1 min-w-0 text-left cursor-pointer focus-visible:outline-2 focus-visible:outline-[#637bff] rounded ${
                    isSplit
                      ? 'flex items-start gap-3'
                      : 'grid grid-cols-1 md:grid-cols-[220px_minmax(0,1fr)_auto] items-center gap-2 md:gap-4'
                  }`}
                >
                  {isSplit ? (
                    <>
                      <div
                        aria-hidden="true"
                        className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 mt-0.5 ${
                          !msg.read
                            ? 'bg-[#637bff] text-white'
                            : 'bg-[#1b2640] text-slate-300 border border-[#2c3b59]'
                        }`}
                      >
                        {senderInitial(msg)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={`text-xs truncate ${
                              !msg.read ? 'font-semibold text-slate-100' : 'font-medium text-slate-400'
                            }`}
                          >
                            {activeFolder === 'sent' || activeFolder === 'drafts'
                              ? `ถึง: ${msg.to || '(ยังไม่ระบุ)'}`
                              : msg.fromName || msg.from}
                          </span>
                          <span className="text-[11px] font-mono text-slate-500 tabular-nums shrink-0">
                            {formatRelativeTime(msg.receivedAt)}
                          </span>
                        </div>
                        <div className="mt-0.5 flex items-center justify-between gap-2">
                          <span
                            className={`text-sm truncate ${
                              !msg.read ? 'font-semibold text-slate-50' : 'font-normal text-slate-300'
                            }`}
                          >
                            {msg.subject}
                          </span>
                          {!msg.read && (
                            <span className="text-[11px] font-semibold text-[#7b93ff] shrink-0">
                              ใหม่
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-xs text-slate-400 line-clamp-1">
                          {msg.snippet || '(ไม่มีข้อความตัวอย่าง)'}
                        </p>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div
                          aria-hidden="true"
                          className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${
                            !msg.read
                              ? 'bg-[#637bff] text-white'
                              : 'bg-[#1b2640] text-slate-300 border border-[#2c3b59]'
                          }`}
                        >
                          {senderInitial(msg)}
                        </div>
                        <span
                          className={`text-xs sm:text-sm truncate ${
                            !msg.read ? 'font-semibold text-slate-100' : 'font-medium text-slate-300'
                          }`}
                        >
                          {activeFolder === 'sent' || activeFolder === 'drafts'
                            ? `ถึง: ${msg.to || '(ยังไม่ระบุ)'}`
                            : msg.fromName || msg.from}
                        </span>
                      </div>

                      <div className="min-w-0 flex items-baseline gap-2">
                        <span
                          className={`text-sm truncate sm:shrink-0 sm:max-w-[55%] ${
                            !msg.read ? 'font-semibold text-slate-50' : 'font-normal text-slate-300'
                          }`}
                        >
                          {msg.subject}
                        </span>
                        <span className="text-xs text-slate-500 truncate hidden sm:inline">
                          — {msg.snippet || '(ไม่มีข้อความตัวอย่าง)'}
                        </span>
                      </div>

                      <div className="flex items-center gap-3 justify-end shrink-0">
                        {msg.extracted.primaryOtp && (
                          <span className="font-mono text-xs font-semibold text-[#8da2ff] tabular-nums">
                            Code {msg.extracted.primaryOtp}
                          </span>
                        )}
                        {!msg.read && (
                          <span className="text-[11px] font-semibold text-[#7b93ff]">
                            ใหม่
                          </span>
                        )}
                        <span className="text-xs font-mono text-slate-400 tabular-nums w-16 text-right">
                          {formatRelativeTime(msg.receivedAt)}
                        </span>
                      </div>
                    </>
                  )}
                </button>

                {!isSplit && (
                  <div className="hidden sm:flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    {(activeFolder === 'trash' || activeFolder === 'spam') && onRestoreMessage && (
                      <button
                        type="button"
                        onClick={() => onRestoreMessage(msg)}
                        aria-label={`Restore message ${msg.subject}`}
                        title="กู้คืนไปกล่องเข้า"
                        className="p-1.5 text-emerald-400 hover:bg-emerald-950/50 rounded transition-colors cursor-pointer"
                      >
                        <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onToggleRead(msg)}
                      aria-label={msg.read ? `Mark ${msg.subject} unread` : `Mark ${msg.subject} read`}
                      title={msg.read ? 'ทำเครื่องหมายยังไม่อ่าน' : 'ทำเครื่องหมายอ่านแล้ว'}
                      className="p-1.5 text-slate-400 hover:text-slate-100 hover:bg-[#222f4d] rounded transition-colors cursor-pointer"
                    >
                      {msg.read ? (
                        <Mail className="w-3.5 h-3.5" aria-hidden="true" />
                      ) : (
                        <MailOpen className="w-3.5 h-3.5" aria-hidden="true" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteMessage(msg, activeFolder === 'trash')}
                      aria-label={`Delete message ${msg.subject}`}
                      title={activeFolder === 'trash' ? 'ลบถาวร' : 'ย้ายไปถังขยะ'}
                      className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-red-950/50 rounded transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
