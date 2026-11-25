import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  AtSign,
  CheckCircle2,
  Globe,
  Mail,
  SearchCheck,
  Server,
  Shuffle,
  Wand2,
  Webhook,
} from 'lucide-react';
import {
  GMAIL_ALIAS_DOMAINS,
  OUTLOOK_ALIAS_DOMAINS,
  WEBHOOK_DOMAINS,
  type InboxMode,
  type InboxProvider,
  type TtlPreset,
} from '../../shared/types';
import { validateDomainMx } from '../api/client';

interface CreateAddressViewProps {
  liveMxDomains: string[];
  webhookDomains: string[];
  creatingRandom: boolean;
  firebaseUserEmail?: string;
  gmailConnected?: boolean;
  connectingGmail?: boolean;
  onConnectGmail?: () => Promise<void>;
  onQuickRandom: () => Promise<void>;
  onCreate: (input: {
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
  }) => Promise<void>;
}

function buildPreviewAddress(
  provider: InboxProvider,
  baseEmail: string,
  strategy: 'plus' | 'dot',
  tag: string,
): string | null {
  const cleaned = baseEmail.trim().toLowerCase();
  const cleanTag = tag
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 24);

  if (!cleaned) {
    const defaultDomain = provider === 'outlook-alias' ? 'outlook.com' : 'gmail.com';
    if (provider === 'gmail-alias' && strategy === 'dot') {
      return `r.bxxxx@${defaultDomain}`;
    }
    return cleanTag ? `rbxxxx+${cleanTag}@${defaultDomain}` : `rbxxxx@${defaultDomain}`;
  }

  const atIdx = cleaned.indexOf('@');
  if (atIdx <= 0 || atIdx >= cleaned.length - 1) return null;
  const rawLocal = cleaned.slice(0, atIdx).split('+')[0];
  const domain = cleaned.slice(atIdx + 1);
  if (!rawLocal || !domain) return null;

  if (provider === 'gmail-alias' && strategy === 'dot') {
    const undotted = rawLocal.replace(/\./g, '');
    if (undotted.length < 2) return null;
    return `${undotted[0]}.${undotted.slice(1)}@${domain}`;
  }

  return `${rawLocal}+${cleanTag || 'rb4a9f'}@${domain}`;
}

export function CreateAddressView({
  liveMxDomains,
  webhookDomains,
  creatingRandom,
  firebaseUserEmail,
  gmailConnected = false,
  connectingGmail = false,
  onConnectGmail,
  onQuickRandom,
  onCreate,
}: CreateAddressViewProps) {
  const hasLiveMx = liveMxDomains.length > 0;
  const [provider, setProvider] = useState<InboxProvider>(hasLiveMx ? 'mail.tm' : 'gmail-alias');
  const [prefix, setPrefix] = useState('');
  const [domain, setDomain] = useState(
    hasLiveMx ? liveMxDomains[0] : (webhookDomains[0] ?? WEBHOOK_DOMAINS[0]),
  );

  // Alias fields (Gmail / Outlook)
  const [baseEmail, setBaseEmail] = useState(() => firebaseUserEmail || '');
  const [aliasStrategy, setAliasStrategy] = useState<'plus' | 'dot'>('plus');
  const [aliasTag, setAliasTag] = useState('');

  const [ttl, setTtl] = useState<TtlPreset>('24h');
  const [label, setLabel] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastPrefilledEmailRef = useRef<string | undefined>(firebaseUserEmail);

  const [checkingMx, setCheckingMx] = useState(false);
  const [mxCheckResult, setMxCheckResult] = useState<{
    domain: string;
    mxVerified: boolean;
    records: Array<{ exchange: string; priority: number }>;
    error?: string;
  } | null>(null);

  const isAliasMode = provider === 'gmail-alias' || provider === 'outlook-alias';
  const mode: InboxMode =
    isAliasMode ? 'alias' : provider === 'mail.tm' ? 'live-mx' : 'webhook';

  const domainOptions =
    provider === 'mail.tm'
      ? liveMxDomains
      : webhookDomains.length > 0
        ? webhookDomains
        : [...WEBHOOK_DOMAINS];

  useEffect(() => {
    setMxCheckResult(null);
    setError(null);
    if (provider === 'mail.tm' && liveMxDomains.length > 0) {
      if (!liveMxDomains.includes(domain)) setDomain(liveMxDomains[0]);
    } else if (provider === 'webhook' || provider === 'smtp') {
      const list = webhookDomains.length > 0 ? webhookDomains : [...WEBHOOK_DOMAINS];
      if (!list.includes(domain)) setDomain(list[0]);
    } else if (provider === 'gmail-alias') {
      if (OUTLOOK_ALIAS_DOMAINS.some((d) => baseEmail.trim().toLowerCase().endsWith(`@${d}`))) {
        setBaseEmail(firebaseUserEmail || '');
      }
      setTtl('never');
    } else if (provider === 'outlook-alias') {
      if (GMAIL_ALIAS_DOMAINS.some((d) => baseEmail.trim().toLowerCase().endsWith(`@${d}`))) {
        setBaseEmail('');
      }
      setAliasStrategy('plus');
      setTtl('never');
    }
  }, [provider, liveMxDomains, webhookDomains, domain, firebaseUserEmail]);

  useEffect(() => {
    if (
      firebaseUserEmail &&
      firebaseUserEmail !== lastPrefilledEmailRef.current &&
      provider === 'gmail-alias' &&
      !baseEmail.trim()
    ) {
      setBaseEmail(firebaseUserEmail);
    }
    lastPrefilledEmailRef.current = firebaseUserEmail;
  }, [firebaseUserEmail, provider, baseEmail]);

  const aliasPreview = useMemo(() => {
    if (!isAliasMode) return null;
    return buildPreviewAddress(provider, baseEmail, aliasStrategy, aliasTag);
  }, [isAliasMode, provider, baseEmail, aliasStrategy, aliasTag]);

  const handleValidateMx = async () => {
    if (!domain) return;
    setCheckingMx(true);
    setMxCheckResult(null);
    try {
      const res = await validateDomainMx(domain, true);
      setMxCheckResult({
        domain: res.domain,
        mxVerified: res.mxVerified,
        records: res.records,
        error: res.error,
      });
    } catch (err) {
      setMxCheckResult({
        domain,
        mxVerified: false,
        records: [],
        error: err instanceof Error ? err.message : 'MX check failed',
      });
    } finally {
      setCheckingMx(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (isAliasMode) {
        const trimmedBase = baseEmail.trim();
        if (trimmedBase && !trimmedBase.includes('@')) {
          throw new Error(
            provider === 'outlook-alias'
              ? 'รูปแบบอีเมล Outlook / Hotmail ไม่ถูกต้อง (หรือเว้นว่างไว้เพื่อสุ่มอัตโนมัติ)'
              : 'รูปแบบอีเมล Gmail ไม่ถูกต้อง (หรือเว้นว่างไว้เพื่อสุ่มอัตโนมัติ)',
          );
        }
        const parsedDomain = trimmedBase
          ? trimmedBase.split('@')[1]?.toLowerCase() || (provider === 'outlook-alias' ? 'outlook.com' : 'gmail.com')
          : provider === 'outlook-alias'
            ? 'outlook.com'
            : 'gmail.com';
        await onCreate({
          mode: 'alias',
          provider,
          baseEmail: trimmedBase || undefined,
          domain: parsedDomain,
          strategy: provider === 'gmail-alias' ? aliasStrategy : 'plus',
          tag: aliasTag.trim() || undefined,
          ttl,
          label: label.trim() || undefined,
          webhookUrl: webhookUrl.trim() || undefined,
        });
        setAliasTag('');
        setLabel('');
        setWebhookUrl('');
      } else {
        await onCreate({
          mode,
          provider,
          prefix: prefix.trim() || undefined,
          domain,
          ttl,
          label: label.trim() || undefined,
          webhookUrl: webhookUrl.trim() || undefined,
        });
        setPrefix('');
        setLabel('');
        setWebhookUrl('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ไม่สามารถสร้างอีเมลได้');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-bold text-slate-50">สร้างอีเมล</h1>
            <p className="mt-1 text-sm text-slate-400">
              สร้างอีเมลรับข้อความจริงจากภายนอก (Live MX, Gmail Alias, Outlook Alias) หรือโหมดทดสอบ Webhook / SMTP
            </p>
          </div>

          <button
            type="button"
            onClick={() => void onQuickRandom()}
            disabled={creatingRandom}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs sm:text-sm font-semibold text-slate-100 bg-[#161f33] hover:bg-[#1c2842] border border-[#2c3a57] hover:border-[#637bff] rounded-xl cursor-pointer disabled:opacity-50"
          >
            <Shuffle className="w-4 h-4 text-[#7b93ff]" aria-hidden="true" />
            <span>{creatingRandom ? 'กำลังสุ่มสร้าง…' : 'สุ่ม Live MX ทันที'}</span>
          </button>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-[#121929] border border-[#26334d] rounded-2xl p-6 space-y-5"
        >
          {error && (
            <div
              role="alert"
              className="px-4 py-2.5 text-xs font-medium text-red-200 bg-red-950/60 border border-red-500/60 rounded-xl"
            >
              {error}
            </div>
          )}

          <div>
            <span className="block text-xs font-semibold text-slate-300 mb-2">
              ผู้ให้บริการและโหมดการรับอีเมล
            </span>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <button
                type="button"
                disabled={!hasLiveMx}
                onClick={() => setProvider('mail.tm')}
                className={`p-3.5 text-left rounded-xl border transition-colors cursor-pointer disabled:opacity-40 ${
                  provider === 'mail.tm'
                    ? 'border-[#637bff] bg-[#1a2442]'
                    : 'border-[#273552] bg-[#0f1625] hover:border-[#3e527d]'
                }`}
              >
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                  <Globe className="w-4 h-4 text-emerald-400" aria-hidden="true" />
                  <span>Live MX</span>
                </div>
                <div className="mt-1 text-xs text-slate-400">
                  สุ่มเมลชั่วคราวรับเมลจริงจากเว็บภายนอกทันที
                </div>
              </button>

              <button
                type="button"
                onClick={() => setProvider('gmail-alias')}
                className={`p-3.5 text-left rounded-xl border transition-colors cursor-pointer ${
                  provider === 'gmail-alias'
                    ? 'border-[#637bff] bg-[#1a2442]'
                    : 'border-[#273552] bg-[#0f1625] hover:border-[#3e527d]'
                }`}
              >
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                  <Mail className="w-4 h-4 text-rose-400" aria-hidden="true" />
                  <span>Gmail (รับเมลจริง)</span>
                </div>
                <div className="mt-1 text-xs text-slate-400">
                  สร้าง Alias (+tag / จุด) จาก Gmail และดึงเมลจริงเข้า RelayBox
                </div>
              </button>

              <button
                type="button"
                onClick={() => setProvider('outlook-alias')}
                className={`p-3.5 text-left rounded-xl border transition-colors cursor-pointer ${
                  provider === 'outlook-alias'
                    ? 'border-[#637bff] bg-[#1a2442]'
                    : 'border-[#273552] bg-[#0f1625] hover:border-[#3e527d]'
                }`}
              >
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                  <AtSign className="w-4 h-4 text-sky-400" aria-hidden="true" />
                  <span>Outlook (Alias รับเมลจริง)</span>
                </div>
                <div className="mt-1 text-xs text-slate-400">
                  สร้าง Alias @outlook.com / @hotmail.com ส่งตรงเข้า Outlook จริง
                </div>
              </button>

              <button
                type="button"
                onClick={() => setProvider('webhook')}
                className={`p-3.5 text-left rounded-xl border transition-colors cursor-pointer ${
                  provider === 'webhook'
                    ? 'border-[#637bff] bg-[#1a2442]'
                    : 'border-[#273552] bg-[#0f1625] hover:border-[#3e527d]'
                }`}
              >
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                  <Webhook className="w-4 h-4 text-[#7b93ff]" aria-hidden="true" />
                  <span>Webhook</span>
                </div>
                <div className="mt-1 text-xs text-slate-400">
                  ยิงเข้า API /api/v1/inbound เท่านั้น (จำลองภายใน)
                </div>
              </button>

              <button
                type="button"
                onClick={() => setProvider('smtp')}
                className={`p-3.5 text-left rounded-xl border transition-colors cursor-pointer ${
                  provider === 'smtp'
                    ? 'border-[#637bff] bg-[#1a2442]'
                    : 'border-[#273552] bg-[#0f1625] hover:border-[#3e527d]'
                }`}
              >
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                  <Server className="w-4 h-4 text-indigo-400" aria-hidden="true" />
                  <span>SMTP Bridge</span>
                </div>
                <div className="mt-1 text-xs text-slate-400">
                  ทดสอบผ่าน SMTP ภายในพอร์ต 2525 (จำลองภายใน)
                </div>
              </button>
            </div>

            {(provider === 'webhook' || provider === 'smtp') && (
              <div className="mt-3 px-3.5 py-2.5 rounded-xl border border-amber-500/40 bg-amber-950/30 text-xs text-amber-200 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
                <span>
                  โหมด Webhook / SMTP ใช้โดเมนจำลองภายใน ({domain}) จึงไม่สามารถรับอีเมลที่ส่งจาก Gmail หรือเว็บไซต์ภายนอกได้ หากต้องการรับเมลจริงจากภายนอกให้เลือก <strong>Live MX</strong>, <strong>Gmail</strong> หรือ <strong>Outlook</strong>
                </span>
              </div>
            )}

            {provider === 'gmail-alias' && (
              <div className="mt-3 px-4 py-3 rounded-xl border border-[#2c3b60] bg-[#0f1625] flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-slate-300 leading-relaxed max-w-xl">
                  <div className="font-semibold text-slate-100">
                    รับอีเมลจริงผ่านบัญชี Gmail ของคุณ
                  </div>
                  <p className="text-slate-400 mt-0.5">
                    สร้างที่อยู่ @gmail.com แบบไม่จำกัด (ผ่าน +tag หรือจุด) เว็บภายนอกจะส่งอีเมลจริงเข้า Gmail ของคุณ และ RelayBox สามารถดึงเข้ามาอ่านในกล่องจดหมายและศูนย์ OTP ได้ทันที
                  </p>
                </div>

                {gmailConnected ? (
                  <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-950/40 border border-emerald-500/40 text-xs font-semibold text-emerald-300 shrink-0">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                    <span>เชื่อมต่อ Gmail API แล้ว</span>
                  </div>
                ) : (
                  onConnectGmail && (
                    <button
                      type="button"
                      onClick={() => void onConnectGmail()}
                      disabled={connectingGmail}
                      className="inline-flex items-center gap-2.5 px-3.5 py-2 rounded-xl bg-white hover:bg-slate-100 text-slate-900 text-xs font-semibold shadow-sm transition-colors cursor-pointer disabled:opacity-50 shrink-0"
                    >
                      <svg
                        viewBox="0 0 48 48"
                        className="w-4 h-4 shrink-0"
                        aria-hidden="true"
                      >
                        <path
                          fill="#EA4335"
                          d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                        />
                        <path
                          fill="#4285F4"
                          d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                        />
                        <path
                          fill="#FBBC05"
                          d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                        />
                        <path
                          fill="#34A853"
                          d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                        />
                      </svg>
                      <span>{connectingGmail ? 'กำลังเชื่อมต่อ…' : 'เชื่อมต่อบัญชี Gmail'}</span>
                    </button>
                  )
                )}
              </div>
            )}

            {provider === 'outlook-alias' && (
              <div className="mt-3 px-4 py-3 rounded-xl border border-sky-500/35 bg-sky-950/25 text-xs text-sky-100 leading-relaxed space-y-1">
                <div className="font-semibold text-sky-200">
                  Outlook / Hotmail Alias (+tag) สำหรับรับอีเมลจริง
                </div>
                <p className="text-sky-200/80">
                  ระบบจะสร้างที่อยู่ Alias เช่น <span className="font-mono">yourname+shop01@outlook.com</span> เพื่อใช้สมัครเว็บภายนอกและรับอีเมลจริงเข้ากล่อง Outlook ของคุณโดยตรง (แอปภายนอกไม่สามารถสมัครบัญชี @outlook.com ใหม่บนเซิร์ฟเวอร์ Microsoft หรือดึงเมล Outlook อัตโนมัติได้)
                </p>
              </div>
            )}
          </div>

          {isAliasMode ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="alias-base-email" className="block text-xs font-semibold text-slate-300 mb-1.5">
                    {provider === 'outlook-alias'
                      ? 'อีเมล Outlook / Hotmail หลักของคุณ (ไม่บังคับ)'
                      : 'อีเมล Gmail หลักของคุณ (ไม่บังคับ)'}
                  </label>
                  <input
                    id="alias-base-email"
                    type="email"
                    value={baseEmail}
                    onChange={(e) => setBaseEmail(e.target.value)}
                    placeholder={
                      provider === 'outlook-alias'
                        ? 'yourname@outlook.com (เว้นว่างเพื่อสุ่ม)'
                        : 'yourname@gmail.com (เว้นว่างเพื่อสุ่ม)'
                    }
                    className="w-full px-3.5 py-2.5 font-mono text-sm bg-[#0b101b] text-slate-100 placeholder:text-slate-500 border border-[#2c3b59] rounded-xl focus:outline-none focus:border-[#637bff]"
                  />
                  <p className="mt-1 text-[11px] text-slate-400">
                    {provider === 'outlook-alias'
                      ? `เว้นว่างเพื่อสุ่มอัตโนมัติ หรือระบุอีเมล ${OUTLOOK_ALIAS_DOMAINS.map((d) => `@${d}`).join(', ')}`
                      : `เว้นว่างเพื่อสุ่มอัตโนมัติ หรือระบุอีเมล ${GMAIL_ALIAS_DOMAINS.map((d) => `@${d}`).join(', ')} / Google Workspace`}
                  </p>
                </div>

                {provider === 'gmail-alias' ? (
                  <div>
                    <label htmlFor="alias-strategy" className="block text-xs font-semibold text-slate-300 mb-1.5">
                      รูปแบบการสร้าง Gmail Alias
                    </label>
                    <select
                      id="alias-strategy"
                      value={aliasStrategy}
                      onChange={(e) => setAliasStrategy(e.target.value as 'plus' | 'dot')}
                      className="w-full px-3.5 py-2.5 text-sm bg-[#0b101b] text-slate-100 border border-[#2c3b59] rounded-xl focus:outline-none focus:border-[#637bff]"
                    >
                      <option value="plus">เพิ่ม +tag (เช่น name+shop@gmail.com)</option>
                      <option value="dot">แทรกจุด Dot Trick (เช่น n.ame@gmail.com)</option>
                    </select>
                  </div>
                ) : (
                  <div>
                    <label htmlFor="alias-tag" className="block text-xs font-semibold text-slate-300 mb-1.5">
                      ชื่อ Tag หลัง + (เว้นว่างเพื่อสุ่ม)
                    </label>
                    <input
                      id="alias-tag"
                      type="text"
                      value={aliasTag}
                      onChange={(e) => setAliasTag(e.target.value)}
                      placeholder="เช่น shopee, netflix01"
                      className="w-full px-3.5 py-2.5 font-mono text-sm bg-[#0b101b] text-slate-100 placeholder:text-slate-500 border border-[#2c3b59] rounded-xl focus:outline-none focus:border-[#637bff]"
                    />
                  </div>
                )}
              </div>

              {provider === 'gmail-alias' && aliasStrategy === 'plus' && (
                <div>
                  <label htmlFor="alias-tag-gmail" className="block text-xs font-semibold text-slate-300 mb-1.5">
                    ชื่อ Tag หลังเครื่องหมาย + (เว้นว่างเพื่อสุ่มอัตโนมัติ)
                  </label>
                  <input
                    id="alias-tag-gmail"
                    type="text"
                    value={aliasTag}
                    onChange={(e) => setAliasTag(e.target.value)}
                    placeholder="เช่น github, otp01"
                    className="w-full px-3.5 py-2.5 font-mono text-sm bg-[#0b101b] text-slate-100 placeholder:text-slate-500 border border-[#2c3b59] rounded-xl focus:outline-none focus:border-[#637bff]"
                  />
                </div>
              )}

              {aliasPreview && (
                <div className="px-3.5 py-2.5 rounded-xl bg-[#0b101b] border border-[#283552] flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-slate-400">ตัวอย่างที่อยู่อีเมลที่จะสร้าง:</span>
                  <span className="font-mono text-sm font-semibold text-[#8da2ff]">
                    {aliasPreview}
                  </span>
                </div>
              )}
            </div>
          ) : (
            <div>
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <label htmlFor="create-prefix" className="block text-xs font-semibold text-slate-300">
                  ชื่อหน้าอีเมล (เว้นว่างเพื่อสุ่มอัตโนมัติ)
                </label>
                <button
                  type="button"
                  onClick={() => void handleValidateMx()}
                  disabled={checkingMx || !domain}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold text-[#8da2ff] bg-[#161f33] hover:bg-[#1c2842] border border-[#2c3b59] hover:border-[#637bff] rounded-lg cursor-pointer disabled:opacity-50"
                >
                  <SearchCheck className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{checkingMx ? 'กำลังตรวจสอบ MX…' : 'ตรวจสอบ DNS MX'}</span>
                </button>
              </div>

              <div className="flex items-center">
                <input
                  id="create-prefix"
                  type="text"
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                  placeholder="เช่น alex.signup"
                  className="flex-1 min-w-0 px-3.5 py-2.5 font-mono text-sm bg-[#0b101b] text-slate-100 placeholder:text-slate-500 border border-r-0 border-[#2c3b59] rounded-l-xl focus:outline-none focus:border-[#637bff]"
                />
                <span className="px-3 py-2.5 text-sm font-mono bg-[#161f33] border border-[#2c3b59] text-slate-400">
                  @
                </span>
                <label htmlFor="create-domain" className="sr-only">
                  โดเมน
                </label>
                <select
                  id="create-domain"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  className="px-3 py-2.5 font-mono text-sm bg-[#0b101b] text-slate-100 border border-l-0 border-[#2c3b59] rounded-r-xl focus:outline-none focus:border-[#637bff]"
                >
                  {domainOptions.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>

              {mxCheckResult && (
                <div
                  className={`mt-2.5 p-3 rounded-xl border text-xs ${
                    mxCheckResult.mxVerified
                      ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-200'
                      : 'bg-amber-950/30 border-amber-500/40 text-amber-200'
                  }`}
                >
                  <div className="flex items-center gap-2 font-semibold">
                    {mxCheckResult.mxVerified ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
                    ) : (
                      <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
                    )}
                    <span>
                      {mxCheckResult.mxVerified
                        ? `โดเมน ${mxCheckResult.domain} มีระเบียน MX จริง (${mxCheckResult.records.length} records)`
                        : `ไม่พบระเบียน MX สาธารณะสำหรับ ${mxCheckResult.domain} (เหมาะสำหรับ Inbound Webhook / Local SMTP)`}
                    </span>
                  </div>
                  {mxCheckResult.records.length > 0 && (
                    <div className="mt-1.5 font-mono text-[11px] text-slate-300 flex flex-wrap gap-2">
                      {mxCheckResult.records.slice(0, 3).map((r) => (
                        <span
                          key={r.exchange}
                          className="px-2 py-0.5 bg-[#0b101b] border border-[#283552] rounded"
                        >
                          [{r.priority}] {r.exchange}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="create-ttl" className="block text-xs font-semibold text-slate-300 mb-1.5">
                อายุการใช้งาน (TTL)
              </label>
              <select
                id="create-ttl"
                value={ttl}
                onChange={(e) => setTtl(e.target.value as TtlPreset)}
                className="w-full px-3.5 py-2.5 text-sm bg-[#0b101b] text-slate-100 border border-[#2c3b59] rounded-xl focus:outline-none focus:border-[#637bff]"
              >
                <option value="15m">15 นาที</option>
                <option value="1h">1 ชั่วโมง</option>
                <option value="24h">24 ชั่วโมง</option>
                <option value="7d">7 วัน</option>
                <option value="never">ถาวร (ไม่หมดอายุ)</option>
              </select>
            </div>

            <div>
              <label htmlFor="create-label" className="block text-xs font-semibold text-slate-300 mb-1.5">
                ป้ายกำกับกล่อง (ไม่บังคับ)
              </label>
              <input
                id="create-label"
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="เช่น สมัครสมาชิก / ทดสอบระบบ"
                className="w-full px-3.5 py-2.5 text-sm bg-[#0b101b] text-slate-100 placeholder:text-slate-500 border border-[#2c3b59] rounded-xl focus:outline-none focus:border-[#637bff]"
              />
            </div>
          </div>

          <div>
            <label htmlFor="create-webhook" className="block text-xs font-semibold text-slate-300 mb-1.5">
              ส่งต่อข้อความไปยัง Webhook URL (ไม่บังคับ)
            </label>
            <input
              id="create-webhook"
              type="url"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://hooks.example.com/relaybox"
              className="w-full px-3.5 py-2.5 font-mono text-xs bg-[#0b101b] text-slate-100 placeholder:text-slate-500 border border-[#2c3b59] rounded-xl focus:outline-none focus:border-[#637bff]"
            />
          </div>

          <div className="pt-2 flex justify-end">
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-[#637bff] hover:bg-[#526bf5] rounded-xl shadow-lg shadow-[#637bff]/25 transition-colors cursor-pointer disabled:opacity-50"
            >
              <Wand2 className="w-4 h-4" aria-hidden="true" />
              <span>
                {submitting
                  ? 'กำลังสร้างอีเมล…'
                  : provider === 'gmail-alias'
                    ? 'สร้าง Gmail Alias'
                    : provider === 'outlook-alias'
                      ? 'สร้าง Outlook Alias'
                      : 'สร้างอีเมลใหม่'}
              </span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
