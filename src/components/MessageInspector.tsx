import { useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Image as ImageIcon,
  Inbox as InboxIcon,
  KeyRound,
  Link2,
  Mail,
  MailOpen,
  Paperclip,
  RotateCcw,
  ShieldAlert,
  Star,
  Trash2,
} from 'lucide-react';
import type { EmailMessage } from '../../shared/types';
import { formatExactTimestamp, prepareSandboxedEmailHtml } from '../utils/format';

type InspectorTab = 'html' | 'text' | 'headers' | 'json';

interface MessageInspectorProps {
  message: EmailMessage | null;
  showBackButton?: boolean;
  hasPrev?: boolean;
  hasNext?: boolean;
  onBackToInbox?: () => void;
  onPrevMessage?: () => void;
  onNextMessage?: () => void;
  onDeleteMessage: (message: EmailMessage, permanent?: boolean) => void;
  onRestoreMessage?: (message: EmailMessage) => void;
  onToggleStar: (message: EmailMessage) => void;
  onToggleRead: (message: EmailMessage) => void;
  onCopyValue: (value: string, label: string) => void;
}

export function MessageInspector({
  message,
  showBackButton = false,
  hasPrev = false,
  hasNext = false,
  onBackToInbox,
  onPrevMessage,
  onNextMessage,
  onDeleteMessage,
  onRestoreMessage,
  onToggleStar,
  onToggleRead,
  onCopyValue,
}: MessageInspectorProps) {
  const [activeTab, setActiveTab] = useState<InspectorTab>('html');
  const [allowRemoteImages, setAllowRemoteImages] = useState(false);
  const [copiedItem, setCopiedItem] = useState<string | null>(null);

  const handleCopy = (value: string, id: string, label: string) => {
    onCopyValue(value, label);
    setCopiedItem(id);
    setTimeout(() => setCopiedItem((curr) => (curr === id ? null : curr)), 1600);
  };

  const handleDownloadJson = () => {
    if (!message) return;
    const blob = new Blob([JSON.stringify(message, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${message.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!message) {
    return (
      <section
        aria-label="Email reader"
        className="flex-1 bg-[#0b0f19] flex items-center justify-center p-8 text-center min-h-[280px]"
      >
        <div className="max-w-sm">
          <div className="w-11 h-11 rounded-xl bg-[#121929] border border-[#2a3858] flex items-center justify-center mx-auto mb-3">
            <InboxIcon className="w-5 h-5 text-slate-400" aria-hidden="true" />
          </div>
          <h3 className="font-display text-sm font-semibold text-slate-100">
            ยังไม่ได้เลือกข้อความ
          </h3>
          <p className="text-xs text-slate-400 mt-1 leading-relaxed">
            เลือกอีเมลจากรายการเพื่ออ่านเนื้อหา คัดลอกรหัส OTP หรือเปิดลิงก์ยืนยันตัวตน
          </p>
        </div>
      </section>
    );
  }

  const sandboxHtml = prepareSandboxedEmailHtml(message.html, allowRemoteImages);
  const hasArtifacts =
    message.extracted.otpCodes.length > 0 || message.extracted.links.length > 0;
  const senderChar = ((message.fromName || message.from || '?').trim()[0] || '?').toUpperCase();
  const inTrashOrSpam = message.folder === 'trash' || message.folder === 'spam';

  return (
    <section
      aria-label="Email reader"
      className="flex-1 bg-[#0f1625] flex flex-col min-w-0 min-h-0"
    >
      {/* Top Webmail Action Bar */}
      <div className="px-4 sm:px-5 py-2.5 border-b border-[#243049] flex flex-wrap items-center justify-between gap-2 bg-[#121929]">
        <div className="flex items-center gap-1.5 flex-wrap">
          {showBackButton && onBackToInbox && (
            <button
              type="button"
              onClick={onBackToInbox}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-slate-100 bg-[#161f33] border border-[#2c3b59] hover:border-[#637bff] rounded-lg transition-colors whitespace-nowrap cursor-pointer mr-1"
            >
              <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
              <span>กลับไปกล่องจดหมาย</span>
            </button>
          )}

          {inTrashOrSpam && onRestoreMessage && (
            <button
              type="button"
              onClick={() => onRestoreMessage(message)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-emerald-300 bg-emerald-500/15 border border-emerald-500/40 hover:bg-emerald-500/25 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
              <span>กู้คืนเข้ากล่อง</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => onToggleStar(message)}
            aria-label={message.starred ? 'Unstar message' : 'Star message'}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold border rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
              message.starred
                ? 'bg-amber-500/15 text-amber-300 border-amber-400/50'
                : 'bg-[#161f33] text-slate-300 border-[#2c3b59] hover:border-[#4b618f]'
            }`}
          >
            <Star
              className="w-3.5 h-3.5"
              fill={message.starred ? 'currentColor' : 'none'}
              aria-hidden="true"
            />
            <span>{message.starred ? 'ติดดาวแล้ว' : 'ติดดาว'}</span>
          </button>

          <button
            type="button"
            onClick={() => onToggleRead(message)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-slate-300 bg-[#161f33] border border-[#2c3b59] hover:border-[#4b618f] rounded-lg transition-colors whitespace-nowrap cursor-pointer"
          >
            {message.read ? (
              <>
                <Mail className="w-3.5 h-3.5" aria-hidden="true" />
                <span>ทำเครื่องหมายยังไม่อ่าน</span>
              </>
            ) : (
              <>
                <MailOpen className="w-3.5 h-3.5" aria-hidden="true" />
                <span>ทำเครื่องหมายอ่านแล้ว</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={handleDownloadJson}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-slate-300 bg-[#161f33] border border-[#2c3b59] hover:border-[#4b618f] rounded-lg transition-colors whitespace-nowrap cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Export JSON</span>
          </button>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {(onPrevMessage || onNextMessage) && (
            <div className="flex items-center gap-1 mr-1">
              <button
                type="button"
                disabled={!hasPrev}
                onClick={onPrevMessage}
                aria-label="Newer message"
                title="ฉบับใหม่กว่า"
                className="p-1.5 text-slate-300 bg-[#161f33] border border-[#2c3b59] hover:border-[#4b618f] rounded-lg disabled:opacity-40 cursor-pointer disabled:cursor-default"
              >
                <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                disabled={!hasNext}
                onClick={onNextMessage}
                aria-label="Older message"
                title="ฉบับเก่ากว่า"
                className="p-1.5 text-slate-300 bg-[#161f33] border border-[#2c3b59] hover:border-[#4b618f] rounded-lg disabled:opacity-40 cursor-pointer disabled:cursor-default"
              >
                <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={() => onDeleteMessage(message, message.folder === 'trash')}
            aria-label={`Delete message ${message.subject}`}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-slate-300 hover:text-red-300 bg-[#161f33] hover:bg-red-950/40 border border-[#2c3b59] hover:border-red-500/60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{message.folder === 'trash' ? 'ลบถาวร' : 'ย้ายไปถังขยะ'}</span>
          </button>
        </div>
      </div>

      {/* Spam Score Banner */}
      {(message.folder === 'spam' || message.spamScore >= 60) && (
        <div className="px-4 sm:px-6 py-2.5 bg-amber-950/40 border-b border-amber-500/40 flex flex-wrap items-center justify-between gap-2 text-xs text-amber-200">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
            <span>
              ข้อความนี้ถูกคัดกรองเป็นสแปม (คะแนน {message.spamScore}/100)
              {message.spamReasons.length > 0 ? `: ${message.spamReasons.join(', ')}` : ''}
            </span>
          </div>
          {onRestoreMessage && (
            <button
              type="button"
              onClick={() => onRestoreMessage(message)}
              className="px-2.5 py-1 text-xs font-semibold bg-amber-500/20 border border-amber-400/50 rounded-md hover:bg-amber-500/30 cursor-pointer"
            >
              ไม่ใช่สแปม (ย้ายไปกล่องเข้า)
            </button>
          )}
        </div>
      )}

      {/* Subject & Sender Header */}
      <div className="px-4 sm:px-6 py-4 border-b border-[#243049] bg-[#111827]">
        <h2 className="font-display text-lg sm:text-xl font-semibold text-slate-50 leading-snug">
          {message.subject}
        </h2>

        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div
              aria-hidden="true"
              className="w-9 h-9 rounded-full bg-[#192440] border border-[#324675] text-[#8da2ff] font-semibold text-sm flex items-center justify-center shrink-0"
            >
              {senderChar}
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium text-slate-100 truncate">
                {message.fromName ? (
                  <>
                    <span>{message.fromName}</span>{' '}
                    <span className="font-mono text-xs text-slate-400">&lt;{message.from}&gt;</span>
                  </>
                ) : (
                  <span className="font-mono text-xs">{message.from}</span>
                )}
              </div>
              <div className="text-xs text-slate-400 truncate mt-0.5">
                ถึง: <span className="font-mono text-slate-300">{message.to}</span>
              </div>
            </div>
          </div>

          <div className="text-right shrink-0">
            <div className="font-mono text-xs tabular-nums text-slate-400">
              {formatExactTimestamp(message.receivedAt)}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5 capitalize">
              Via {message.source} · {message.folder}
            </div>
          </div>
        </div>
      </div>

      {/* Extracted Verification Codes & Action Links */}
      {hasArtifacts && (
        <div className="px-4 sm:px-6 py-3 bg-[#131d33] border-b border-[#243049] flex flex-wrap items-center gap-2.5">
          {message.extracted.otpCodes.map((code) => (
            <div
              key={code}
              className="inline-flex items-center gap-2 px-3 py-1.5 bg-[#0b101b] border border-[#33466f] rounded-lg"
            >
              <KeyRound className="w-3.5 h-3.5 text-[#7b93ff] shrink-0" aria-hidden="true" />
              <span className="text-xs text-slate-400">Code</span>
              <span className="font-mono text-sm font-semibold text-slate-50 tracking-wider tabular-nums">
                {code}
              </span>
              <button
                type="button"
                onClick={() => handleCopy(code, `otp-${code}`, `Code ${code}`)}
                aria-label={`Copy verification code ${code}`}
                className="p-1 text-slate-400 hover:text-white rounded transition-colors cursor-pointer"
              >
                {copiedItem === `otp-${code}` ? (
                  <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                ) : (
                  <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                )}
              </button>
            </div>
          ))}

          {message.extracted.links.slice(0, 3).map((link, idx) => (
            <div
              key={link.url}
              className="inline-flex items-center gap-2 px-3 py-1.5 bg-[#0b101b] border border-[#33466f] rounded-lg max-w-full"
            >
              <Link2 className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
              <span className="text-xs font-medium text-[#8da2ff] capitalize shrink-0">
                {link.kind.replace('-', ' ')}
              </span>
              <span className="font-mono text-xs text-slate-300 truncate max-w-[240px]">
                {link.url}
              </span>
              <button
                type="button"
                onClick={() => handleCopy(link.url, `link-${idx}`, 'Link URL')}
                aria-label={`Copy link ${link.url}`}
                className="p-1 text-slate-400 hover:text-white rounded transition-colors cursor-pointer shrink-0"
              >
                {copiedItem === `link-${idx}` ? (
                  <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                ) : (
                  <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                )}
              </button>
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open link ${link.url} in new tab`}
                className="p-1 text-slate-400 hover:text-[#7b93ff] rounded transition-colors shrink-0"
              >
                <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
              </a>
            </div>
          ))}
        </div>
      )}

      {/* Attachments Strip */}
      {message.attachments.length > 0 && (
        <div className="px-4 sm:px-6 py-2.5 bg-[#121929] border-b border-[#243049] flex flex-wrap items-center gap-2">
          {message.attachments.map((att, i) => (
            <div
              key={`${att.filename}-${i}`}
              className="inline-flex items-center gap-2 px-2.5 py-1 bg-[#0b101b] border border-[#2c3b59] rounded-md text-xs text-slate-200"
            >
              <Paperclip className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
              <span className="font-medium">{att.filename}</span>
              <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                {Math.max(1, Math.round(att.size / 1024))} KB
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Reader Tabs */}
      <div className="px-4 sm:px-6 py-2 border-b border-[#243049] flex flex-wrap items-center justify-between gap-2 bg-[#121929]">
        <div role="tablist" aria-label="Message view format" className="flex items-center gap-1 overflow-x-auto">
          {(
            [
              { id: 'html', label: 'ข้อความ' },
              { id: 'text', label: 'ข้อความล้วน' },
              { id: 'headers', label: 'Headers' },
              { id: 'json', label: 'Raw JSON' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === tab.id
                  ? 'bg-[#637bff] text-white'
                  : 'text-slate-400 hover:text-slate-100 hover:bg-[#1a243d]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === 'html' && (
          <button
            type="button"
            onClick={() => setAllowRemoteImages((prev) => !prev)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-slate-300 hover:text-white bg-[#161f33] border border-[#2c3b59] hover:border-[#4b618f] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <ImageIcon className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{allowRemoteImages ? 'อนุญาตรูปภาพภายนอก' : 'บล็อกรูปภาพภายนอก'}</span>
          </button>
        )}
      </div>

      {/* Body Canvas */}
      <div className="flex-1 overflow-auto bg-[#0b0f19]">
        {activeTab === 'html' && (
          <div className="h-full min-h-[360px] p-4 sm:p-5">
            <iframe
              title={`Email preview: ${message.subject}`}
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              srcDoc={sandboxHtml}
              className="w-full h-full min-h-[340px] bg-white border border-[#2e3c59] rounded-xl"
            />
          </div>
        )}

        {activeTab === 'text' && (
          <div className="p-4 sm:p-6">
            <pre className="p-5 bg-[#121929] border border-[#283552] rounded-xl font-mono text-xs text-slate-200 whitespace-pre-wrap leading-relaxed">
              {message.text || '(ไม่มีเนื้อหาข้อความล้วน)'}
            </pre>
          </div>
        )}

        {activeTab === 'headers' && (
          <div className="p-4 sm:p-6">
            <div className="bg-[#121929] border border-[#283552] rounded-xl overflow-hidden">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#283552] bg-[#161f33]">
                    <th className="px-4 py-2.5 text-xs font-semibold text-slate-300 w-44">
                      Header
                    </th>
                    <th className="px-4 py-2.5 text-xs font-semibold text-slate-300">
                      Value
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#202b42]">
                  {Object.entries(message.headers).map(([key, value]) => (
                    <tr key={key} className="hover:bg-[#172136]">
                      <td className="px-4 py-2 font-mono text-xs font-semibold text-[#8da2ff] align-top">
                        {key}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-slate-300 break-all">
                        {value}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'json' && (
          <div className="p-4 sm:p-6">
            <div className="flex justify-end mb-2">
              <button
                type="button"
                onClick={() =>
                  handleCopy(JSON.stringify(message, null, 2), 'json-payload', 'JSON payload')
                }
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-slate-200 bg-[#161f33] border border-[#2c3b59] hover:border-[#4b618f] rounded-md cursor-pointer"
              >
                <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Copy JSON</span>
              </button>
            </div>
            <pre className="p-5 bg-[#080c14] border border-[#283552] text-slate-200 rounded-xl font-mono text-xs overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">
              {JSON.stringify(message, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </section>
  );
}
