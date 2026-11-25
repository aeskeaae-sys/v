import {
  Check,
  CheckCircle2,
  Copy,
  Edit3,
  Inbox as InboxIcon,
  RefreshCw,
  Shuffle,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { Inbox, InboxStatus, TtlPreset } from '../../shared/types';
import { formatRelativeTime, formatTtlRemaining } from '../utils/format';

interface AddressesViewProps {
  inboxes: Inbox[];
  selectedInboxId: string | null;
  creatingRandom: boolean;
  onSelectInbox: (inbox: Inbox) => void;
  onCopyAddress: (address: string) => void;
  onDeleteInbox: (inbox: Inbox) => void;
  onUpdateInbox: (
    inbox: Inbox,
    patch: { label?: string; status?: InboxStatus; webhookUrl?: string | null; ttl?: TtlPreset },
  ) => Promise<void>;
  onSyncInbox: (inbox: Inbox) => Promise<void>;
  onQuickRandom: () => Promise<void>;
  onGoCreate: () => void;
}

const STATUS_BADGE: Record<InboxStatus, { label: string; cls: string }> = {
  active: { label: 'ใช้งานอยู่', cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30' },
  paused: { label: 'หยุดชั่วคราว', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  error: { label: 'ซิงก์ผิดพลาด', cls: 'text-red-300 bg-red-500/10 border-red-500/30' },
  expired: { label: 'หมดอายุ', cls: 'text-slate-400 bg-slate-500/10 border-slate-500/30' },
};

export function AddressesView({
  inboxes,
  selectedInboxId,
  creatingRandom,
  onSelectInbox,
  onCopyAddress,
  onDeleteInbox,
  onUpdateInbox,
  onSyncInbox,
  onQuickRandom,
  onGoCreate,
}: AddressesViewProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [editingInbox, setEditingInbox] = useState<Inbox | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editStatus, setEditStatus] = useState<InboxStatus>('active');
  const [editWebhook, setEditWebhook] = useState('');
  const [editTtl, setEditTtl] = useState<TtlPreset | ''>('');
  const [savingEdit, setSavingEdit] = useState(false);

  const handleCopy = (inbox: Inbox) => {
    onCopyAddress(inbox.address);
    setCopiedId(inbox.id);
    setTimeout(() => setCopiedId((c) => (c === inbox.id ? null : c)), 1500);
  };

  const openEditModal = (inbox: Inbox) => {
    setEditingInbox(inbox);
    setEditLabel(inbox.label || '');
    setEditStatus(inbox.status === 'paused' ? 'paused' : 'active');
    setEditWebhook(inbox.webhookUrl || '');
    setEditTtl('');
  };

  const handleSaveEdit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingInbox) return;
    setSavingEdit(true);
    try {
      await onUpdateInbox(editingInbox, {
        label: editLabel.trim(),
        status: editStatus,
        webhookUrl: editWebhook.trim() || null,
        ttl: editTtl || undefined,
      });
      setEditingInbox(null);
    } finally {
      setSavingEdit(false);
    }
  };

  const handleSyncOne = async (inbox: Inbox) => {
    setSyncingId(inbox.id);
    try {
      await onSyncInbox(inbox);
    } finally {
      setSyncingId(null);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-bold text-slate-50">บัญชีของฉัน</h1>
            <p className="mt-1 text-sm text-slate-400">
              จัดการที่อยู่อีเมลชั่วคราวทั้งหมดที่บันทึกไว้ในระบบ ({inboxes.length} กล่อง)
            </p>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => void onQuickRandom()}
              disabled={creatingRandom}
              className="inline-flex items-center gap-2 px-3.5 py-2 text-xs sm:text-sm font-semibold text-slate-200 bg-[#161f33] hover:bg-[#1c2842] border border-[#2c3a57] hover:border-[#4b618f] rounded-xl cursor-pointer disabled:opacity-50"
            >
              <Shuffle className="w-4 h-4 text-[#7b93ff]" aria-hidden="true" />
              <span>{creatingRandom ? 'กำลังสุ่ม…' : 'สุ่มอีเมลใหม่'}</span>
            </button>

            <button
              type="button"
              onClick={onGoCreate}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs sm:text-sm font-semibold text-white bg-[#637bff] hover:bg-[#526bf5] rounded-xl shadow-lg shadow-[#637bff]/20 cursor-pointer"
            >
              <Wand2 className="w-4 h-4" aria-hidden="true" />
              <span>สร้างแบบกำหนดเอง</span>
            </button>
          </div>
        </div>

        {inboxes.length === 0 ? (
          <div className="bg-[#121929] border border-[#26334d] rounded-2xl p-10 text-center">
            <p className="text-sm font-semibold text-slate-100">ยังไม่มีกล่องจดหมายที่บันทึกไว้</p>
            <p className="text-xs text-slate-400 mt-1">
              กดสุ่มอีเมลใหม่หรือสร้างแบบกำหนดเองเพื่อเริ่มต้นรับข้อความ
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {inboxes.map((inbox) => {
              const isSelected = inbox.id === selectedInboxId;
              const statusInfo = STATUS_BADGE[inbox.status] ?? STATUS_BADGE.active;
              return (
                <div
                  key={inbox.id}
                  className={`bg-[#121929] border rounded-2xl p-5 flex flex-col justify-between gap-4 transition-colors ${
                    isSelected
                      ? 'border-[#637bff] bg-[#151e34]'
                      : 'border-[#26334d] hover:border-[#394b73]'
                  }`}
                >
                  <div className="space-y-2 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs font-medium text-slate-300 truncate">
                          {inbox.label || 'Temp Inbox'}
                        </span>
                        <span
                          className={`text-[11px] font-semibold px-2 py-0.5 rounded border shrink-0 ${statusInfo.cls}`}
                        >
                          {statusInfo.label}
                        </span>
                      </div>
                      <span
                        className={`text-xs font-semibold shrink-0 ${
                          inbox.mode === 'live-mx' || inbox.provider === 'gmail-alias'
                            ? 'text-emerald-400'
                            : inbox.provider === 'outlook-alias'
                              ? 'text-sky-400'
                              : 'text-[#7b93ff]'
                        }`}
                      >
                        {inbox.provider === 'mail.tm'
                          ? 'Live MX (mail.tm)'
                          : inbox.provider === 'gmail-alias'
                            ? 'Gmail Alias (รับเมลจริง)'
                            : inbox.provider === 'outlook-alias'
                              ? 'Outlook Alias (รับเมลจริง)'
                              : inbox.provider === 'smtp'
                                ? 'SMTP Bridge'
                                : 'Webhook'}
                      </span>
                    </div>

                    <div className="font-mono text-sm sm:text-base font-semibold text-slate-100 truncate">
                      {inbox.address}
                    </div>

                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400 tabular-nums">
                      <span>{formatTtlRemaining(inbox.expiresAt)}</span>
                      <span aria-hidden="true">·</span>
                      <span>{inbox.messageCount} ข้อความ</span>
                      {inbox.unreadCount > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-[#8da2ff] font-semibold">
                            ยังไม่อ่าน {inbox.unreadCount}
                          </span>
                        </>
                      )}
                      {inbox.mxVerified && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="inline-flex items-center gap-1 text-emerald-400">
                            <CheckCircle2 className="w-3 h-3" aria-hidden="true" />
                            <span>MX OK</span>
                          </span>
                        </>
                      )}
                      {inbox.lastSyncedAt && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>ซิงก์ {formatRelativeTime(inbox.lastSyncedAt)}</span>
                        </>
                      )}
                    </div>

                    {inbox.syncError && (
                      <div className="text-[11px] text-amber-300 bg-amber-950/30 border border-amber-500/30 rounded-lg px-2.5 py-1 truncate">
                        {inbox.syncError}
                      </div>
                    )}
                  </div>

                  <div className="pt-3 border-t border-[#222e46] flex flex-wrap items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => onSelectInbox(inbox)}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg cursor-pointer ${
                        isSelected
                          ? 'bg-[#637bff] text-white'
                          : 'bg-[#161f33] text-slate-200 border border-[#2c3a57] hover:border-[#4b618f]'
                      }`}
                    >
                      <InboxIcon className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>เปิดกล่องนี้</span>
                    </button>

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => void handleSyncOne(inbox)}
                        disabled={syncingId === inbox.id}
                        aria-label={`Sync inbox ${inbox.address}`}
                        title="ซิงก์ข้อความ"
                        className="p-1.5 text-slate-300 bg-[#161f33] border border-[#2c3a57] hover:border-[#4b618f] rounded-lg cursor-pointer disabled:opacity-50"
                      >
                        <RefreshCw
                          className={`w-3.5 h-3.5 ${syncingId === inbox.id ? 'animate-spin' : ''}`}
                          aria-hidden="true"
                        />
                      </button>

                      <button
                        type="button"
                        onClick={() => openEditModal(inbox)}
                        aria-label={`Edit inbox ${inbox.address}`}
                        title="แก้ไขการตั้งค่า"
                        className="p-1.5 text-slate-300 bg-[#161f33] border border-[#2c3a57] hover:border-[#637bff] rounded-lg cursor-pointer"
                      >
                        <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>

                      <button
                        type="button"
                        onClick={() => handleCopy(inbox)}
                        aria-label={`Copy address ${inbox.address}`}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-slate-300 bg-[#161f33] border border-[#2c3a57] hover:border-[#4b618f] rounded-lg cursor-pointer"
                      >
                        {copiedId === inbox.id ? (
                          <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                        )}
                        <span>คัดลอก</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => onDeleteInbox(inbox)}
                        aria-label={`Delete inbox ${inbox.address}`}
                        className="p-1.5 text-slate-400 hover:text-red-400 bg-[#161f33] border border-[#2c3a57] hover:border-red-500/60 rounded-lg cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Edit Address Modal */}
      {editingInbox && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="แก้ไขข้อมูลกล่องจดหมาย"
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
        >
          <form
            onSubmit={handleSaveEdit}
            className="w-full max-w-md bg-[#121929] border border-[#2e3e60] rounded-2xl p-6 space-y-4 shadow-2xl"
          >
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="font-display text-base font-bold text-slate-50">
                  แก้ไขการตั้งค่ากล่องอีเมล
                </h2>
                <p className="font-mono text-xs text-[#8da2ff] mt-0.5 truncate">
                  {editingInbox.address}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditingInbox(null)}
                aria-label="Close modal"
                className="p-1.5 text-slate-400 hover:text-white rounded-lg cursor-pointer"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            <div>
              <label htmlFor="edit-inbox-label" className="block text-xs font-semibold text-slate-300 mb-1">
                ป้ายกำกับกล่อง
              </label>
              <input
                id="edit-inbox-label"
                type="text"
                value={editLabel}
                onChange={(e) => setEditLabel(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-[#0b101b] text-slate-100 border border-[#2c3b59] rounded-xl focus:outline-none focus:border-[#637bff]"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="edit-inbox-status" className="block text-xs font-semibold text-slate-300 mb-1">
                  สถานะ
                </label>
                <select
                  id="edit-inbox-status"
                  value={editStatus}
                  onChange={(e) => setEditStatus(e.target.value as InboxStatus)}
                  className="w-full px-3 py-2 text-sm bg-[#0b101b] text-slate-100 border border-[#2c3b59] rounded-xl focus:outline-none focus:border-[#637bff]"
                >
                  <option value="active">ใช้งานอยู่ (Active)</option>
                  <option value="paused">หยุดชั่วคราว (Paused)</option>
                </select>
              </div>

              <div>
                <label htmlFor="edit-inbox-ttl" className="block text-xs font-semibold text-slate-300 mb-1">
                  ต่ออายุ TTL
                </label>
                <select
                  id="edit-inbox-ttl"
                  value={editTtl}
                  onChange={(e) => setEditTtl(e.target.value as TtlPreset | '')}
                  className="w-full px-3 py-2 text-sm bg-[#0b101b] text-slate-100 border border-[#2c3b59] rounded-xl focus:outline-none focus:border-[#637bff]"
                >
                  <option value="">ไม่เปลี่ยนแปลง</option>
                  <option value="15m">15 นาที</option>
                  <option value="1h">1 ชั่วโมง</option>
                  <option value="24h">24 ชั่วโมง</option>
                  <option value="7d">7 วัน</option>
                  <option value="never">ถาวร</option>
                </select>
              </div>
            </div>

            <div>
              <label htmlFor="edit-inbox-webhook" className="block text-xs font-semibold text-slate-300 mb-1">
                Webhook URL (ส่งต่ออัตโนมัติ)
              </label>
              <input
                id="edit-inbox-webhook"
                type="url"
                value={editWebhook}
                onChange={(e) => setEditWebhook(e.target.value)}
                placeholder="https://hooks.example.com/email"
                className="w-full px-3 py-2 font-mono text-xs bg-[#0b101b] text-slate-100 border border-[#2c3b59] rounded-xl focus:outline-none focus:border-[#637bff]"
              />
            </div>

            <div className="pt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditingInbox(null)}
                className="px-4 py-2 text-xs font-semibold text-slate-300 bg-[#161f33] border border-[#2c3a57] rounded-xl cursor-pointer"
              >
                ยกเลิก
              </button>
              <button
                type="submit"
                disabled={savingEdit}
                className="px-4 py-2 text-xs font-semibold text-white bg-[#637bff] hover:bg-[#526bf5] rounded-xl cursor-pointer disabled:opacity-50"
              >
                {savingEdit ? 'กำลังบันทึก…' : 'บันทึกการเปลี่ยนแปลง'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
