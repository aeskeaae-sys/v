import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Activity,
  Check,
  CheckCircle2,
  Copy,
  Key,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Send,
  Server,
  ShieldCheck,
  Trash2,
  Webhook,
  XCircle,
  Zap,
} from 'lucide-react';
import type {
  ApiKeyScope,
  ApiKeySummary,
  ApiUsageLog,
  Inbox,
  WebhookConfig,
  WebhookDeliveryLog,
} from '../../shared/types';
import {
  createApiKey,
  createInbox,
  createWebhook,
  deleteWebhook,
  getSettings,
  getSmtpStatus,
  ingestInboundEmail,
  listApiKeys,
  listApiUsage,
  listWebhookDeliveries,
  listWebhooks,
  revokeApiKey,
  testInboxWebhook,
  testSmtp,
  testWebhook,
  updateInboxWebhook,
  updateSettings,
  updateWebhook,
} from '../api/client';
import { formatRelativeTime } from '../utils/format';

type SnippetLang = 'playwright' | 'cypress' | 'node' | 'python' | 'curl' | 'webhook-verify';

interface ApiDocsViewProps {
  activeInbox: Inbox | null;
  inboxes?: Inbox[];
  webhookDomains?: string[];
  liveSignal?: number;
  onInboxUpdated: (inbox: Inbox) => void;
  onInboxCreated?: (inbox: Inbox) => void;
  onCopyValue: (val: string, label: string) => void;
  onNotify?: (text: string, tone?: 'info' | 'error') => void;
}

const ALL_SCOPES: ApiKeyScope[] = ['read', 'write', 'webhooks', 'admin'];
const WEBHOOK_EVENTS = ['email.received', 'otp.detected', 'inbox.created'] as const;

const ENDPOINTS = [
  { method: 'GET', path: '/api/health', desc: 'System, SQLite DB, Live MX provider & webhook health check' },
  { method: 'GET', path: '/api/v1/domains/validate?domain=', desc: 'Verify real DNS MX records for a domain' },
  { method: 'POST', path: '/api/v1/addresses', desc: 'Provision Live MX, Webhook, or SMTP temporary address' },
  { method: 'PATCH', path: '/api/v1/addresses/:id', desc: 'Edit label, status (active/paused), TTL, or webhook URL' },
  { method: 'GET', path: '/api/v1/messages?folder=inbox', desc: 'List messages across folders with pagination & search' },
  { method: 'POST', path: '/api/v1/messages/send', desc: 'Save draft or send internal/outbound message' },
  { method: 'GET', path: '/api/v1/inboxes/:addr/wait', desc: 'Long-poll wait (?timeout=20000&subject=) until matching email arrives' },
  { method: 'GET', path: '/api/v1/otp', desc: 'Query extracted OTP codes & verification links' },
  { method: 'POST', path: '/api/v1/inbound', desc: 'Receive inbound webhooks (HMAC signed + X-Event-Id dedup)' },
  { method: 'GET/POST', path: '/api/v1/webhooks', desc: 'Register outbound HMAC webhook endpoints & event filters' },
  { method: 'PATCH/POST', path: '/api/v1/webhooks/:id/test', desc: 'Toggle active state or send signed test webhook delivery' },
  { method: 'POST', path: '/api/v1/smtp/test', desc: 'Verify TCP/TLS EHLO connectivity to inbound or outbound SMTP' },
  { method: 'GET', path: '/api/v1/activity/export?format=csv', desc: 'Export filtered audit logs as JSON or CSV' },
];

export function ApiDocsView({
  activeInbox,
  inboxes = [],
  webhookDomains = ['relaybox.dev'],
  liveSignal = 0,
  onInboxUpdated,
  onInboxCreated,
  onCopyValue,
  onNotify,
}: ApiDocsViewProps) {
  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [keyName, setKeyName] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<ApiKeyScope[]>([
    'read',
    'write',
    'webhooks',
    'admin',
  ]);
  const [rateLimitPerMin, setRateLimitPerMin] = useState(120);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [creatingKey, setCreatingKey] = useState(false);

  const [requireApiKey, setRequireApiKey] = useState(false);
  const [smtpPort, setSmtpPort] = useState<number | null>(null);
  const [liveMxDomains, setLiveMxDomains] = useState<string[]>([]);
  const [snippetLang, setSnippetLang] = useState<SnippetLang>('playwright');
  const [copiedSnippet, setCopiedSnippet] = useState(false);

  // Quick Automation Setup & Live Self-Test state
  const [settingUpAuto, setSettingUpAuto] = useState(false);
  const [autoEnvSnippet, setAutoEnvSnippet] = useState<string | null>(null);
  const [testingInbound, setTestingInbound] = useState(false);
  const [inboundTestResult, setInboundTestResult] = useState<{
    ok: boolean;
    address: string;
    otp: string | null;
    messageId?: string;
    error?: string;
  } | null>(null);

  // Inbox webhook state
  const [webhookInput, setWebhookInput] = useState(activeInbox?.webhookUrl ?? '');
  const [webhookStatus, setWebhookStatus] = useState<{ type: 'ok' | 'err'; text: string } | null>(
    null,
  );
  const [savingWebhook, setSavingWebhook] = useState(false);
  const [testingInboxHook, setTestingInboxHook] = useState(false);

  // Global / Scoped Signed Webhooks state
  const [webhooks, setWebhooks] = useState<WebhookConfig[]>([]);
  const [newHookUrl, setNewHookUrl] = useState('');
  const [hookScopeTarget, setHookScopeTarget] = useState<'global' | 'inbox'>('global');
  const [hookEvents, setHookEvents] = useState<string[]>(['email.received', 'otp.detected']);
  const [registerHookError, setRegisterHookError] = useState<string | null>(null);
  const [addingHook, setAddingHook] = useState(false);
  const [revealedHookSecret, setRevealedHookSecret] = useState<string | null>(null);
  const [testingHookId, setTestingHookId] = useState<string | null>(null);
  const [hookTestFeedback, setHookTestFeedback] = useState<
    Record<string, { ok: boolean; text: string }>
  >({});

  const [deliveries, setDeliveries] = useState<WebhookDeliveryLog[]>([]);
  const [usageLogs, setUsageLogs] = useState<ApiUsageLog[]>([]);
  const [refreshingLogs, setRefreshingLogs] = useState(false);

  // SMTP Bridge state
  const [smtpInbound, setSmtpInbound] = useState<{
    host: string;
    port: number | null;
    authRequired: boolean;
  } | null>(null);
  const [smtpOutbound, setSmtpOutbound] = useState<{
    configured: boolean;
    host: string | null;
    port: number;
    secure: boolean;
  } | null>(null);
  const [testSmtpHost, setTestSmtpHost] = useState('127.0.0.1');
  const [testSmtpPort, setTestSmtpPort] = useState('2525');
  const [testingSmtp, setTestingSmtp] = useState(false);
  const [smtpTestResult, setSmtpTestResult] = useState<{
    ok: boolean;
    latencyMs: number;
    banner?: string;
    error?: string;
  } | null>(null);

  useEffect(() => {
    setWebhookInput(activeInbox?.webhookUrl ?? '');
    setWebhookStatus(null);
  }, [activeInbox?.id, activeInbox?.webhookUrl]);

  const refreshLogsOnly = useCallback(async () => {
    setRefreshingLogs(true);
    try {
      const [delRes, useRes] = await Promise.all([
        listWebhookDeliveries(25),
        listApiUsage(25),
      ]);
      setDeliveries(delRes.deliveries);
      setUsageLogs(useRes.usage);
    } catch {
      // Ignore transient refresh failure
    } finally {
      setRefreshingLogs(false);
    }
  }, []);

  const loadEnterpriseData = useCallback(() => {
    void listApiKeys().then((res) => setKeys(res.keys)).catch(() => {});
    void listWebhooks().then((res) => setWebhooks(res.webhooks)).catch(() => {});
    void refreshLogsOnly();
    void getSmtpStatus()
      .then((res) => {
        setSmtpInbound(res.inbound);
        setSmtpOutbound(res.outbound);
        if (res.inbound.port) setTestSmtpPort(String(res.inbound.port));
      })
      .catch(() => {});
    void getSettings()
      .then((res) => {
        setRequireApiKey(res.requireApiKey);
        setSmtpPort(res.smtpPort);
        setLiveMxDomains(res.liveMxDomains);
      })
      .catch(() => {});
  }, [refreshLogsOnly]);

  useEffect(() => {
    loadEnterpriseData();
  }, [loadEnterpriseData]);

  useEffect(() => {
    if (liveSignal > 0) {
      void refreshLogsOnly();
    }
  }, [liveSignal, refreshLogsOnly]);

  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const targetAddress = activeInbox?.address ?? 'qa-automation@relaybox.dev';
  const authHeader = revealedKey
    ? `Authorization: Bearer ${revealedKey}`
    : 'Authorization: Bearer YOUR_RELAYBOX_API_KEY';

  const snippets: Record<SnippetLang, string> = {
    playwright: `import { test, expect } from '@playwright/test';

test('user signup receives verification OTP via RelayBox API', async ({ page, request }) => {
  const baseUrl = '${origin}';
  const headers = {
    'Content-Type': 'application/json',
    ${revealedKey ? `Authorization: 'Bearer ${revealedKey}',` : requireApiKey ? `Authorization: 'Bearer ' + process.env.RELAYBOX_API_KEY,` : `// Optional when Auth Required is on: Authorization: 'Bearer ' + process.env.RELAYBOX_API_KEY,`}
  };

  const inboxRes = await request.post(\`\${baseUrl}/api/v1/addresses\`, {
    headers,
    data: { mode: 'live-mx', ttl: '15m', label: 'Playwright Signup Flow' },
  });
  const { inbox } = await inboxRes.json();

  await page.goto('https://your-app.example.com/signup');
  await page.getByLabel('Email').fill(inbox.address);
  await page.getByRole('button', { name: 'Create Account' }).click();

  const waitRes = await request.get(
    \`\${baseUrl}/api/v1/inboxes/\${encodeURIComponent(inbox.address)}/wait?timeout=30000\`,
    { headers },
  );
  expect(waitRes.ok()).toBeTruthy();
  const { otp, actionUrl } = await waitRes.json();
});`,
    cypress: `it('verifies magic link login via RelayBox API', () => {
  const baseUrl = '${origin}';
  const auth = ${revealedKey ? `'Bearer ${revealedKey}'` : `'Bearer ' + Cypress.env('RELAYBOX_API_KEY')`};

  cy.request({
    method: 'POST',
    url: \`\${baseUrl}/api/v1/addresses\`,
    headers: { Authorization: auth },
    body: { mode: 'live-mx', ttl: '15m' },
  }).then(({ body }) => {
    const email = body.inbox.address;

    cy.visit('/login');
    cy.get('input[type="email"]').type(email);
    cy.contains('button', 'Send Magic Link').click();

    cy.request({
      url: \`\${baseUrl}/api/v1/inboxes/\${encodeURIComponent(email)}/wait?timeout=30000\`,
      headers: { Authorization: auth },
      timeout: 35000,
    }).then((res) => {
      expect(res.body.actionUrl).to.include('https://');
      cy.visit(res.body.actionUrl);
    });
  });
});`,
    node: `const baseUrl = '${origin}';
const headers = {
  'Content-Type': 'application/json',
  ${revealedKey ? `Authorization: 'Bearer ${revealedKey}',` : `Authorization: \`Bearer \${process.env.RELAYBOX_API_KEY}\`,`}
};

// 1. Provision mailbox (or use existing ${targetAddress})
const { inbox } = await fetch(\`\${baseUrl}/api/v1/addresses\`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ mode: 'webhook', provider: 'webhook', domain: '${webhookDomains[0] || 'relaybox.dev'}', ttl: '1h' }),
}).then((r) => r.json());

// 2. Long-poll wait for OTP / magic link
const res = await fetch(
  \`\${baseUrl}/api/v1/inboxes/\${encodeURIComponent(inbox.address)}/wait?timeout=30000\`,
  { headers },
);
const { otp, actionUrl, message } = await res.json();
console.log({ subject: message.subject, otp, actionUrl });`,
    python: `import os, requests
from urllib.parse import quote

BASE_URL = "${origin}"
HEADERS = {
    "Content-Type": "application/json",
    "Authorization": f"Bearer {os.getenv('RELAYBOX_API_KEY', '${revealedKey || 'YOUR_API_KEY'}')}",
}

inbox = requests.post(
    f"{BASE_URL}/api/v1/addresses",
    headers=HEADERS,
    json={"mode": "live-mx", "ttl": "15m", "label": "Pytest E2E"},
    timeout=10,
).json()["inbox"]

wait_res = requests.get(
    f"{BASE_URL}/api/v1/inboxes/{quote(inbox['address'])}/wait?timeout=30000",
    headers=HEADERS,
    timeout=35,
).json()
print("OTP:", wait_res.get("otp"), "Link:", wait_res.get("actionUrl"))`,
    curl: `# 1. Provision a real Live MX temporary mailbox
curl -X POST "${origin}/api/v1/addresses" \\
  -H "Content-Type: application/json" \\
  -H "${authHeader}" \\
  -d '{"mode": "live-mx", "ttl": "1h"}'

# 2. Wait for incoming email & auto-extracted OTP on ${targetAddress}
curl -H "${authHeader}" \\
  "${origin}/api/v1/inboxes/${encodeURIComponent(targetAddress)}/wait?timeout=30000"

# 3. Push email via Inbound Webhook (Mailgun / SendGrid / Custom CI)
curl -X POST "${origin}/api/v1/inbound" \\
  -H "Content-Type: application/json" \\
  -H "${authHeader}" \\
  -H "X-Event-Id: evt-demo-001" \\
  -d '{"to":"${targetAddress}","from":"auth@yourapp.com","subject":"Confirm","text":"Code: 492011","autoCreateInbox":true}'`,
    'webhook-verify': `import crypto from 'node:crypto';

// Verify X-RelayBox-Signature in Express / Fastify / Webhook Receiver
export function verifyRelayBoxWebhook(rawBody, signatureHeader, signingSecret) {
  const parts = Object.fromEntries(
    String(signatureHeader || '').split(',').map((p) => p.trim().split('=')),
  );
  const ts = Number(parts.t);
  if (!ts || !parts.v1 || Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) {
    return false;
  }
  const expected = crypto
    .createHmac('sha256', signingSecret)
    .update(\`\${ts}.\${rawBody}\`, 'utf8')
    .digest('hex');

  return (
    expected.length === parts.v1.length &&
    crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(parts.v1, 'hex'))
  );
}`,
  };

  const toggleScope = (scope: ApiKeyScope) => {
    setSelectedScopes((curr) =>
      curr.includes(scope)
        ? curr.length > 1
          ? curr.filter((s) => s !== scope)
          : curr
        : [...curr, scope],
    );
  };

  const toggleHookEvent = (evName: string) => {
    setHookEvents((curr) =>
      curr.includes(evName)
        ? curr.length > 1
          ? curr.filter((e) => e !== evName)
          : curr
        : [...curr, evName],
    );
  };

  const handleQuickAutomationSetup = async () => {
    setSettingUpAuto(true);
    setKeyError(null);
    try {
      let targetInbox =
        activeInbox ??
        inboxes.find((i) => i.mode === 'webhook') ??
        inboxes[0] ??
        null;

      if (!targetInbox) {
        const res = await createInbox({
          mode: 'webhook',
          provider: 'webhook',
          domain: webhookDomains[0] || 'relaybox.dev',
          ttl: '7d',
          label: 'Automation Pipeline',
        });
        targetInbox = res.inbox;
        onInboxCreated?.(targetInbox);
      }

      const keyRes = await createApiKey(
        `Automation (${new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })})`,
        ['read', 'write', 'webhooks'],
        240,
      );
      setKeys((prev) => [keyRes.key, ...prev]);
      setRevealedKey(keyRes.plaintextKey);

      const envText = [
        `RELAYBOX_BASE_URL=${origin}`,
        `RELAYBOX_API_KEY=${keyRes.plaintextKey}`,
        `RELAYBOX_INBOX_ID=${targetInbox.id}`,
        `RELAYBOX_INBOX_ADDRESS=${targetInbox.address}`,
        `RELAYBOX_INBOUND_URL=${origin}/api/v1/inbound`,
        `RELAYBOX_WAIT_URL=${origin}/api/v1/inboxes/${encodeURIComponent(targetInbox.address)}/wait?timeout=30000`,
      ].join('\n');

      setAutoEnvSnippet(envText);
      onCopyValue(envText, 'ค่าเชื่อมต่อ Automation (.env)');
      void refreshLogsOnly();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'ไม่สามารถสร้างชุดเชื่อมต่ออัตโนมัติได้';
      setKeyError(msg);
      onNotify?.(msg, 'error');
    } finally {
      setSettingUpAuto(false);
    }
  };

  const handleTestInboundPipeline = async () => {
    setTestingInbound(true);
    setInboundTestResult(null);
    try {
      const webhookInbox =
        (activeInbox && activeInbox.mode === 'webhook' ? activeInbox : null) ??
        inboxes.find((i) => i.mode === 'webhook') ??
        null;

      const targetAddr =
        webhookInbox?.address ?? `qa-auto@${webhookDomains[0] || 'relaybox.dev'}`;
      const otpSample = String(Math.floor(100000 + Math.random() * 900000));
      const eventId = `evt_ui_${Date.now()}`;

      const res = await ingestInboundEmail({
        to: targetAddr,
        from: 'ci-runner@yourapp.test',
        subject: `Automation Pipeline Verification - ${otpSample}`,
        text: `Your automation verification code is ${otpSample}. Verify at https://app.example.com/verify?code=${otpSample}`,
        html: `<p>Your automation verification code is <strong>${otpSample}</strong>.</p><p><a href="https://app.example.com/verify?code=${otpSample}">Verify Account</a></p>`,
        autoCreateInbox: true,
        eventId,
      });

      setInboundTestResult({
        ok: true,
        address: targetAddr,
        otp: res.otp ?? otpSample,
        messageId: res.message?.id,
      });
      onNotify?.(`ส่งทดสอบ Inbound API เข้า ${targetAddr} สำเร็จ (OTP: ${res.otp ?? otpSample})`);
      void refreshLogsOnly();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'ทดสอบ Inbound API ไม่สำเร็จ';
      setInboundTestResult({
        ok: false,
        address: targetAddress,
        otp: null,
        error: msg,
      });
      onNotify?.(msg, 'error');
    } finally {
      setTestingInbound(false);
    }
  };

  const handleCreateKey = async (e: FormEvent) => {
    e.preventDefault();
    setCreatingKey(true);
    setKeyError(null);
    try {
      const res = await createApiKey(
        keyName.trim() || 'Integration Key',
        selectedScopes,
        Math.max(10, Math.min(2000, Number(rateLimitPerMin) || 120)),
      );
      setKeys((prev) => [res.key, ...prev]);
      setRevealedKey(res.plaintextKey);
      setKeyName('');
      onNotify?.(`สร้าง API Key "${res.key.name}" แล้ว`);
      void refreshLogsOnly();
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : 'ไม่สามารถสร้าง API Key ได้');
    } finally {
      setCreatingKey(false);
    }
  };

  const handleRevokeKey = async (id: string) => {
    try {
      await revokeApiKey(id);
      setKeys((prev) => prev.filter((k) => k.id !== id));
      onNotify?.('ยกเลิก API Key แล้ว');
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : 'ไม่สามารถลบ API Key ได้');
    }
  };

  const handleToggleAuth = async () => {
    try {
      const next = !requireApiKey;
      const res = await updateSettings(next);
      setRequireApiKey(res.requireApiKey);
      onNotify?.(
        res.requireApiKey
          ? 'เปิดใช้งานโหมดบังคับ API Key แล้ว'
          : 'สลับเป็นโหมด Open Access สำหรับ Dev แล้ว',
      );
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : 'ไม่สามารถเปลี่ยนการตั้งค่า Auth ได้');
    }
  };

  const handleSaveWebhook = async (e: FormEvent) => {
    e.preventDefault();
    if (!activeInbox) return;
    setSavingWebhook(true);
    setWebhookStatus(null);
    try {
      const res = await updateInboxWebhook(activeInbox.id, webhookInput.trim() || null);
      onInboxUpdated(res.inbox);
      setWebhookStatus({
        type: 'ok',
        text: res.inbox.webhookUrl ? 'บันทึก Webhook ประจำกล่องเรียบร้อยแล้ว' : 'ลบการส่งต่อ Webhook ประจำกล่องแล้ว',
      });
    } catch (err) {
      setWebhookStatus({
        type: 'err',
        text: err instanceof Error ? err.message : 'ไม่สามารถบันทึก Webhook ได้',
      });
    } finally {
      setSavingWebhook(false);
    }
  };

  const handleTestInboxHook = async () => {
    if (!activeInbox) return;
    const urlToTest = webhookInput.trim() || activeInbox.webhookUrl;
    if (!urlToTest) {
      setWebhookStatus({ type: 'err', text: 'กรุณาระบุ Webhook URL ก่อนกดทดสอบ' });
      return;
    }
    setTestingInboxHook(true);
    setWebhookStatus(null);
    try {
      const res = await testInboxWebhook(activeInbox.id, urlToTest);
      setWebhookStatus({
        type: res.ok ? 'ok' : 'err',
        text: res.ok
          ? `ส่งทดสอบสำเร็จ HTTP ${res.httpStatus} (${res.latencyMs}ms)`
          : `ส่งไม่สำเร็จ: ${res.error || `HTTP ${res.httpStatus}`}`,
      });
      void refreshLogsOnly();
    } catch (err) {
      setWebhookStatus({
        type: 'err',
        text: err instanceof Error ? err.message : 'ทดสอบ Webhook ไม่สำเร็จ',
      });
    } finally {
      setTestingInboxHook(false);
    }
  };

  const handleRegisterWebhook = async (e: FormEvent) => {
    e.preventDefault();
    if (!newHookUrl.trim()) return;
    setAddingHook(true);
    setRegisterHookError(null);
    try {
      const res = await createWebhook({
        url: newHookUrl.trim(),
        inboxId: hookScopeTarget === 'inbox' ? activeInbox?.id : undefined,
        events: hookEvents,
      });
      setWebhooks((prev) => [res.webhook, ...prev]);
      setRevealedHookSecret(res.signingSecret);
      setNewHookUrl('');
      onNotify?.('เพิ่ม Signed Webhook Endpoint แล้ว');
      void refreshLogsOnly();
    } catch (err) {
      setRegisterHookError(
        err instanceof Error ? err.message : 'URL ไม่ถูกต้องหรือถูกบล็อกเพื่อความปลอดภัย',
      );
    } finally {
      setAddingHook(false);
    }
  };

  const handleToggleWebhookEnabled = async (wh: WebhookConfig) => {
    try {
      const res = await updateWebhook(wh.id, { enabled: !wh.enabled });
      setWebhooks((prev) => prev.map((item) => (item.id === wh.id ? res.webhook : item)));
    } catch (err) {
      setRegisterHookError(err instanceof Error ? err.message : 'ไม่สามารถเปลี่ยนสถานะ Webhook ได้');
    }
  };

  const handleTestRegisteredWebhook = async (wh: WebhookConfig) => {
    setTestingHookId(wh.id);
    try {
      const res = await testWebhook(wh.id);
      setHookTestFeedback((prev) => ({
        ...prev,
        [wh.id]: {
          ok: res.ok,
          text: res.ok
            ? `OK HTTP ${res.httpStatus} (${res.latencyMs}ms)`
            : `Fail: ${res.error || `HTTP ${res.httpStatus}`}`,
        },
      }));
      void refreshLogsOnly();
    } catch (err) {
      setHookTestFeedback((prev) => ({
        ...prev,
        [wh.id]: {
          ok: false,
          text: err instanceof Error ? err.message : 'Test failed',
        },
      }));
    } finally {
      setTestingHookId(null);
    }
  };

  const handleDeleteRegisteredWebhook = async (id: string) => {
    try {
      await deleteWebhook(id);
      setWebhooks((prev) => prev.filter((w) => w.id !== id));
      onNotify?.('ลบ Webhook แล้ว');
    } catch (err) {
      setRegisterHookError(err instanceof Error ? err.message : 'ไม่สามารถลบ Webhook ได้');
    }
  };

  const handleRunSmtpTest = async (e: FormEvent) => {
    e.preventDefault();
    setTestingSmtp(true);
    setSmtpTestResult(null);
    try {
      const res = await testSmtp({
        host: testSmtpHost.trim() || '127.0.0.1',
        port: Number(testSmtpPort) || 2525,
      });
      setSmtpTestResult(res);
      void refreshLogsOnly();
    } catch (err) {
      setSmtpTestResult({
        ok: false,
        latencyMs: 0,
        error: err instanceof Error ? err.message : 'SMTP connection failed',
      });
    } finally {
      setTestingSmtp(false);
    }
  };

  const handleCopyCode = () => {
    onCopyValue(snippets[snippetLang], `${snippetLang} snippet`);
    setCopiedSnippet(true);
    setTimeout(() => setCopiedSnippet(false), 1600);
  };

  return (
    <div className="flex-1 overflow-y-auto bg-[#0b0f19] p-4 sm:p-6 lg:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-bold text-slate-50">
              API, Webhooks &amp; ระบบอัตโนมัติ
            </h1>
            <p className="mt-1 text-sm text-slate-400 max-w-2xl">
              เชื่อมต่อ REST API, Inbound/Outbound HMAC Webhooks และ Live MX ({liveMxDomains.join(', ') || 'Mail.tm'}) สำหรับ Playwright, Cypress, n8n หรือ CI/CD Pipeline ได้ทันที
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleTestInboundPipeline()}
              disabled={testingInbound}
              className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-slate-100 bg-[#161f33] hover:bg-[#1c2842] border border-[#2c3a57] hover:border-[#637bff] rounded-xl transition-colors cursor-pointer disabled:opacity-50"
            >
              <Send className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
              <span>{testingInbound ? 'กำลังทดสอบ…' : 'ทดสอบยิง Inbound API'}</span>
            </button>
            <button
              type="button"
              onClick={() => void handleQuickAutomationSetup()}
              disabled={settingUpAuto}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-[#637bff] hover:bg-[#526bf5] rounded-xl transition-colors cursor-pointer disabled:opacity-50"
            >
              <Zap className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{settingUpAuto ? 'กำลังตั้งค่า…' : 'เชื่อมต่ออัตโนมัติ & คัดลอก .env'}</span>
            </button>
          </div>
        </div>

        {/* Automation Quick-Connect Endpoints Card */}
        <section className="bg-[#121929] border border-[#26334d] rounded-2xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-sm font-semibold text-slate-100 flex items-center gap-2">
                <Zap className="w-4 h-4 text-[#7b93ff]" aria-hidden="true" />
                <span>Endpoint พร้อมเชื่อมต่อทันที (Live Connection URLs)</span>
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                คัดลอก URL ด้านล่างไปใช้ใน n8n, Zapier, GitHub Actions, Mailgun/SendGrid Inbound หรือ Test Runner
              </p>
            </div>
            <span className="text-[11px] font-mono px-2.5 py-1 rounded bg-[#0f1625] border border-[#26334d] text-slate-300">
              Active Target: <strong className="text-[#8da2ff]">{targetAddress}</strong>
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {[
              {
                label: 'Base REST API v1',
                val: `${origin}/api/v1`,
              },
              {
                label: 'Inbound Webhook Receiver (POST)',
                val: `${origin}/api/v1/inbound`,
              },
              {
                label: 'Wait OTP Long-Poll (GET)',
                val: `${origin}/api/v1/inboxes/${encodeURIComponent(targetAddress)}/wait?timeout=30000`,
              },
              {
                label: 'Real-Time SSE Stream (GET)',
                val: `${origin}/api/v1/events`,
              },
            ].map((item) => (
              <div
                key={item.label}
                className="flex items-center justify-between gap-3 px-3.5 py-2.5 bg-[#0b101b] border border-[#24314b] rounded-xl"
              >
                <div className="min-w-0">
                  <div className="text-[11px] text-slate-400 font-medium">{item.label}</div>
                  <div className="font-mono text-xs text-slate-100 truncate">{item.val}</div>
                </div>
                <button
                  type="button"
                  onClick={() => onCopyValue(item.val, item.label)}
                  aria-label={`Copy ${item.label}`}
                  className="p-1.5 text-slate-300 hover:text-white bg-[#161f33] border border-[#2c3a57] rounded-lg shrink-0 cursor-pointer"
                >
                  <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>

          {autoEnvSnippet && (
            <div className="p-3.5 bg-[#080c14] border border-emerald-500/40 rounded-xl space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-emerald-400">
                  พร้อมเชื่อมต่อแล้ว! คัดลอกค่า .env ด้านล่างไปใช้งานกับระบบอัตโนมัติของคุณ
                </span>
                <button
                  type="button"
                  onClick={() => onCopyValue(autoEnvSnippet, '.env configuration')}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-100 bg-[#161f33] border border-[#2c3a57] rounded-lg cursor-pointer"
                >
                  <Copy className="w-3 h-3" aria-hidden="true" />
                  <span>Copy .env</span>
                </button>
              </div>
              <pre className="font-mono text-xs text-slate-200 overflow-x-auto leading-relaxed">
                <code>{autoEnvSnippet}</code>
              </pre>
            </div>
          )}

          {inboundTestResult && (
            <div
              className={`p-3 rounded-xl border text-xs flex flex-wrap items-center justify-between gap-2 ${
                inboundTestResult.ok
                  ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-200'
                  : 'bg-red-950/30 border-red-500/40 text-red-200'
              }`}
            >
              <div className="flex items-center gap-2">
                {inboundTestResult.ok ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
                ) : (
                  <XCircle className="w-4 h-4 text-red-400 shrink-0" aria-hidden="true" />
                )}
                <span>
                  {inboundTestResult.ok
                    ? `ยิง POST /api/v1/inbound เข้ากล่อง ${inboundTestResult.address} สำเร็จ — สกัด OTP: ${inboundTestResult.otp} (Message ID: ${inboundTestResult.messageId})`
                    : inboundTestResult.error}
                </span>
              </div>
            </div>
          )}
        </section>

        {/* Code Integration Snippets */}
        <section className="bg-[#121929] border border-[#26334d] rounded-2xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-[#243049] flex flex-wrap items-center justify-between gap-3">
            <div role="tablist" aria-label="SDK snippet language" className="flex flex-wrap items-center gap-1">
              {(
                [
                  { id: 'playwright', label: 'Playwright' },
                  { id: 'cypress', label: 'Cypress' },
                  { id: 'node', label: 'Node.js Fetch' },
                  { id: 'python', label: 'Python' },
                  { id: 'curl', label: 'cURL' },
                  { id: 'webhook-verify', label: 'Verify Webhook (HMAC)' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={snippetLang === tab.id}
                  onClick={() => setSnippetLang(tab.id)}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                    snippetLang === tab.id
                      ? 'bg-[#637bff] text-white'
                      : 'text-slate-400 hover:text-slate-100 hover:bg-[#1a243d]'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={handleCopyCode}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-200 bg-[#161f33] border border-[#2c3a57] hover:border-[#4b618f] rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              {copiedSnippet ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Copy Snippet</span>
                </>
              )}
            </button>
          </div>

          <pre className="p-5 bg-[#080c14] text-slate-200 font-mono text-xs overflow-x-auto leading-relaxed">
            <code>{snippets[snippetLang]}</code>
          </pre>
        </section>

        {/* Two-column grid: Scoped API Keys & Webhooks / SMTP */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Scoped API Keys */}
          <section className="bg-[#121929] border border-[#26334d] rounded-2xl p-5 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-display text-base font-semibold text-slate-100 flex items-center gap-2">
                  <Key className="w-4 h-4 text-[#7b93ff]" aria-hidden="true" />
                  <span>Scoped API Keys &amp; Rate Limits</span>
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Keys are SHA-256 hashed server-side with granular scopes and per-minute quotas.
                </p>
              </div>

              <button
                type="button"
                role="switch"
                aria-checked={requireApiKey}
                onClick={() => void handleToggleAuth()}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap cursor-pointer ${
                  requireApiKey
                    ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/50'
                    : 'bg-[#161f33] text-slate-200 border-[#2c3a57] hover:border-[#4b618f]'
                }`}
              >
                <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{requireApiKey ? 'Auth Required' : 'Open Access'}</span>
              </button>
            </div>

            <form onSubmit={(e) => void handleCreateKey(e)} className="space-y-3">
              <div className="flex items-center gap-2">
                <label htmlFor="new-api-key-name" className="sr-only">
                  API key label
                </label>
                <input
                  id="new-api-key-name"
                  type="text"
                  value={keyName}
                  onChange={(e) => setKeyName(e.target.value)}
                  placeholder="e.g. CI Runner / n8n Production"
                  className="flex-1 min-w-0 px-3 py-2 text-sm bg-[#0b101b] text-slate-100 placeholder:text-slate-500 border border-[#2c3b59] rounded-xl focus:outline-none focus:border-[#637bff]"
                />
                <label htmlFor="new-api-key-rpm" className="sr-only">
                  Requests per minute
                </label>
                <input
                  id="new-api-key-rpm"
                  type="number"
                  min={10}
                  max={2000}
                  value={rateLimitPerMin}
                  onChange={(e) => setRateLimitPerMin(Number(e.target.value))}
                  title="Requests per minute"
                  className="w-24 px-2.5 py-2 font-mono text-xs bg-[#0b101b] text-slate-100 border border-[#2c3b59] rounded-xl focus:outline-none focus:border-[#637bff]"
                />
                <button
                  type="submit"
                  disabled={creatingKey}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white bg-[#637bff] hover:bg-[#526bf5] rounded-xl whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                >
                  <Plus className="w-4 h-4" aria-hidden="true" />
                  <span>{creatingKey ? 'Creating…' : 'Generate'}</span>
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-slate-400">Scopes:</span>
                {ALL_SCOPES.map((sc) => {
                  const checked = selectedScopes.includes(sc);
                  return (
                    <button
                      key={sc}
                      type="button"
                      onClick={() => toggleScope(sc)}
                      aria-pressed={checked}
                      className={`px-2 py-0.5 font-mono text-[11px] rounded border cursor-pointer ${
                        checked
                          ? 'bg-[#192440] text-[#8da2ff] border-[#637bff]'
                          : 'bg-[#0f1625] text-slate-500 border-[#24314b]'
                      }`}
                    >
                      {sc}
                    </button>
                  );
                })}
                <span className="text-[11px] text-slate-500 ml-auto">rpm limit</span>
              </div>
            </form>

            {keyError && <p className="text-xs text-red-400">{keyError}</p>}

            {revealedKey && (
              <div className="p-3 bg-[#080c14] border border-emerald-500/40 text-slate-100 rounded-xl space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-emerald-400">
                    New key created — copy now, it will not be shown again
                  </span>
                  <button
                    type="button"
                    onClick={() => onCopyValue(revealedKey, 'API key')}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-[#161f33] border border-[#2c3a57] rounded cursor-pointer"
                  >
                    <Copy className="w-3 h-3" aria-hidden="true" />
                    <span>Copy</span>
                  </button>
                </div>
                <div className="font-mono text-xs break-all text-white">{revealedKey}</div>
              </div>
            )}

            <div className="divide-y divide-[#202b42] border border-[#26334d] bg-[#0f1625] rounded-xl">
              {keys.length === 0 ? (
                <div className="p-4 text-xs text-slate-400">
                  No API keys generated yet. Generate one above or click &ldquo;เชื่อมต่ออัตโนมัติ&rdquo;.
                </div>
              ) : (
                keys.map((k) => (
                  <div key={k.id} className="px-3.5 py-2.5 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-100 truncate">{k.name}</div>
                      <div className="text-xs font-mono text-slate-400 flex flex-wrap items-center gap-2 mt-0.5">
                        <span>{k.prefix}</span>
                        <span aria-hidden="true">·</span>
                        <span>{k.rateLimitPerMin}/min</span>
                        <span aria-hidden="true">·</span>
                        <span className="text-[#8da2ff]">{(k.scopes || []).join(', ')}</span>
                        <span aria-hidden="true">·</span>
                        <span>{formatRelativeTime(k.createdAt)}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleRevokeKey(k.id)}
                      aria-label={`Revoke API key ${k.name}`}
                      className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-red-950/50 rounded transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" aria-hidden="true" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* Webhooks & SMTP Verification */}
          <section className="bg-[#121929] border border-[#26334d] rounded-2xl p-5 space-y-5">
            <div>
              <h2 className="font-display text-base font-semibold text-slate-100 flex items-center gap-2">
                <Webhook className="w-4 h-4 text-[#7b93ff]" aria-hidden="true" />
                <span>HMAC Webhooks &amp; Forwarding</span>
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Quick-forward for <span className="font-mono text-slate-200">{targetAddress}</span> or register global HMAC-signed webhook endpoints.
              </p>

              {/* Per-inbox quick forward */}
              <form onSubmit={(e) => void handleSaveWebhook(e)} className="mt-3 space-y-2">
                <label htmlFor="webhook-url-input" className="sr-only">
                  Inbox webhook URL
                </label>
                <div className="flex flex-wrap sm:flex-nowrap items-center gap-2">
                  <input
                    id="webhook-url-input"
                    type="url"
                    value={webhookInput}
                    onChange={(e) => setWebhookInput(e.target.value)}
                    disabled={!activeInbox}
                    placeholder="https://hooks.example.com/email-events"
                    className="flex-1 min-w-0 px-3 py-2 font-mono text-xs bg-[#0b101b] text-slate-100 placeholder:text-slate-500 border border-[#2c3b59] rounded-xl focus:outline-none focus:border-[#637bff] disabled:opacity-50"
                  />
                  <button
                    type="submit"
                    disabled={!activeInbox || savingWebhook}
                    className="px-3 py-2 text-xs font-semibold text-white bg-[#637bff] hover:bg-[#526bf5] rounded-xl whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                  >
                    {savingWebhook ? 'Saving…' : 'Save Hook'}
                  </button>
                  <button
                    type="button"
                    disabled={!activeInbox || testingInboxHook}
                    onClick={() => void handleTestInboxHook()}
                    className="px-3 py-2 text-xs font-semibold text-slate-200 bg-[#161f33] hover:bg-[#1c2842] border border-[#2c3a57] rounded-xl whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                  >
                    {testingInboxHook ? 'Testing…' : 'Test'}
                  </button>
                </div>
                {webhookStatus && (
                  <p
                    className={`text-xs ${
                      webhookStatus.type === 'ok' ? 'text-emerald-400' : 'text-red-400'
                    }`}
                  >
                    {webhookStatus.text}
                  </p>
                )}
              </form>

              {/* Global / Scoped HMAC Webhook Registry */}
              <form
                onSubmit={(e) => void handleRegisterWebhook(e)}
                className="mt-3 pt-3 border-t border-[#222e46] space-y-2.5"
              >
                <div className="flex flex-wrap sm:flex-nowrap items-center gap-2">
                  <label htmlFor="register-hmac-hook" className="sr-only">
                    Register HMAC Webhook endpoint
                  </label>
                  <input
                    id="register-hmac-hook"
                    type="url"
                    value={newHookUrl}
                    onChange={(e) => setNewHookUrl(e.target.value)}
                    placeholder="https://your-automation.com/relaybox-webhook"
                    className="flex-1 min-w-0 px-3 py-2 font-mono text-xs bg-[#0b101b] text-slate-100 placeholder:text-slate-500 border border-[#2c3b59] rounded-xl focus:outline-none focus:border-[#637bff]"
                  />
                  <select
                    aria-label="Webhook target scope"
                    value={hookScopeTarget}
                    onChange={(e) => setHookScopeTarget(e.target.value as 'global' | 'inbox')}
                    className="px-2.5 py-2 text-xs bg-[#0b101b] text-slate-200 border border-[#2c3b59] rounded-xl focus:outline-none focus:border-[#637bff]"
                  >
                    <option value="global">ทุกกล่อง (Global)</option>
                    {activeInbox && <option value="inbox">เฉพาะกล่องนี้</option>}
                  </select>
                  <button
                    type="submit"
                    disabled={addingHook}
                    className="px-3.5 py-2 text-xs font-semibold text-slate-100 bg-[#161f33] hover:bg-[#1c2842] border border-[#2c3a57] hover:border-[#637bff] rounded-xl whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                  >
                    {addingHook ? 'Adding…' : 'Add Signed Hook'}
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-slate-400">Events:</span>
                  {WEBHOOK_EVENTS.map((evName) => {
                    const active = hookEvents.includes(evName);
                    return (
                      <button
                        key={evName}
                        type="button"
                        onClick={() => toggleHookEvent(evName)}
                        aria-pressed={active}
                        className={`px-2 py-0.5 font-mono text-[11px] rounded border cursor-pointer ${
                          active
                            ? 'bg-[#192440] text-[#8da2ff] border-[#637bff]'
                            : 'bg-[#0f1625] text-slate-500 border-[#24314b]'
                        }`}
                      >
                        {evName}
                      </button>
                    );
                  })}
                </div>
                {registerHookError && <p className="text-xs text-red-400">{registerHookError}</p>}
              </form>

              {revealedHookSecret && (
                <div className="mt-2.5 p-2.5 bg-[#080c14] border border-emerald-500/40 rounded-xl text-xs">
                  <div className="flex items-center justify-between gap-2 text-emerald-400 font-medium">
                    <span>Webhook Signing Secret (HMAC-SHA256) — copy once</span>
                    <button
                      type="button"
                      onClick={() => onCopyValue(revealedHookSecret, 'Webhook secret')}
                      className="px-2 py-0.5 bg-[#161f33] border border-[#2c3a57] text-slate-200 rounded cursor-pointer"
                    >
                      Copy
                    </button>
                  </div>
                  <div className="font-mono text-white mt-1 break-all">{revealedHookSecret}</div>
                </div>
              )}

              {webhooks.length > 0 && (
                <div className="mt-2.5 divide-y divide-[#202b42] border border-[#26334d] bg-[#0f1625] rounded-xl">
                  {webhooks.map((wh) => {
                    const feedback = hookTestFeedback[wh.id];
                    return (
                      <div key={wh.id} className="px-3 py-2.5 space-y-1.5 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="font-mono text-slate-200 truncate flex items-center gap-2">
                              <span
                                className={`inline-block w-2 h-2 rounded-full shrink-0 ${
                                  wh.enabled ? 'bg-emerald-400' : 'bg-slate-500'
                                }`}
                              />
                              <span className="truncate">{wh.url}</span>
                            </div>
                            <div className="text-[11px] text-slate-400 font-mono mt-0.5 flex flex-wrap items-center gap-1.5">
                              <span>{wh.secretPrefix}</span>
                              <span aria-hidden="true">·</span>
                              <span>{wh.inboxAddress || 'All inboxes'}</span>
                              <span aria-hidden="true">·</span>
                              <span className="text-[#8da2ff]">{wh.events.join(', ')}</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => void handleTestRegisteredWebhook(wh)}
                              disabled={testingHookId === wh.id}
                              aria-label={`Test webhook ${wh.url}`}
                              className="px-2 py-1 text-[11px] font-medium text-slate-200 bg-[#161f33] hover:bg-[#1f2b45] border border-[#2c3a57] rounded cursor-pointer disabled:opacity-50"
                            >
                              {testingHookId === wh.id ? 'Testing…' : 'Test'}
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleToggleWebhookEnabled(wh)}
                              aria-label={
                                wh.enabled
                                  ? `Pause webhook ${wh.url}`
                                  : `Enable webhook ${wh.url}`
                              }
                              title={wh.enabled ? 'Pause webhook' : 'Enable webhook'}
                              className="p-1.5 text-slate-300 hover:text-white bg-[#161f33] border border-[#2c3a57] rounded cursor-pointer"
                            >
                              {wh.enabled ? (
                                <Pause className="w-3 h-3" aria-hidden="true" />
                              ) : (
                                <Play className="w-3 h-3 text-emerald-400" aria-hidden="true" />
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDeleteRegisteredWebhook(wh.id)}
                              aria-label={`Delete webhook ${wh.url}`}
                              className="p-1.5 text-slate-400 hover:text-red-400 rounded cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                        {feedback && (
                          <div
                            className={`text-[11px] font-mono ${
                              feedback.ok ? 'text-emerald-400' : 'text-red-400'
                            }`}
                          >
                            {feedback.text}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* SMTP Bridge & Connection Test */}
            <div className="pt-4 border-t border-[#243049] space-y-3">
              <div>
                <h3 className="font-display text-sm font-semibold text-slate-100 flex items-center gap-2">
                  <Server className="w-4 h-4 text-sky-400" aria-hidden="true" />
                  <span>SMTP Bridge &amp; Connectivity Tester</span>
                </h3>
                <div className="mt-2 p-3 bg-[#0f1625] border border-[#26334d] rounded-xl font-mono text-xs text-slate-200 space-y-1">
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    <span>
                      Inbound: {smtpInbound?.host ?? '127.0.0.1'}:
                      {smtpInbound?.port ?? smtpPort ?? 2525}
                    </span>
                    <span>Auth: {smtpInbound?.authRequired ? 'Required' : 'Optional'}</span>
                  </div>
                  <div className="text-[11px] text-slate-400">
                    Outbound Relay:{' '}
                    {smtpOutbound?.configured
                      ? `${smtpOutbound.host}:${smtpOutbound.port} (Configured)`
                      : 'Not configured (set SMTP_OUTBOUND_HOST in environment for external delivery)'}
                  </div>
                </div>
              </div>

              <form onSubmit={(e) => void handleRunSmtpTest(e)} className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={testSmtpHost}
                  onChange={(e) => setTestSmtpHost(e.target.value)}
                  aria-label="SMTP Host"
                  placeholder="127.0.0.1"
                  className="flex-1 min-w-[130px] px-3 py-1.5 font-mono text-xs bg-[#0b101b] text-slate-100 border border-[#2c3b59] rounded-lg"
                />
                <input
                  type="number"
                  value={testSmtpPort}
                  onChange={(e) => setTestSmtpPort(e.target.value)}
                  aria-label="SMTP Port"
                  className="w-20 px-2.5 py-1.5 font-mono text-xs bg-[#0b101b] text-slate-100 border border-[#2c3b59] rounded-lg"
                />
                <button
                  type="submit"
                  disabled={testingSmtp}
                  className="px-3 py-1.5 text-xs font-semibold text-white bg-[#637bff] hover:bg-[#526bf5] rounded-lg cursor-pointer disabled:opacity-50"
                >
                  {testingSmtp ? 'Testing…' : 'Test SMTP Handshake'}
                </button>
              </form>

              {smtpTestResult && (
                <div
                  className={`p-2.5 rounded-xl border text-xs flex items-center gap-2 ${
                    smtpTestResult.ok
                      ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-200'
                      : 'bg-red-950/30 border-red-500/40 text-red-200'
                  }`}
                >
                  {smtpTestResult.ok ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
                  ) : (
                    <XCircle className="w-4 h-4 text-red-400 shrink-0" aria-hidden="true" />
                  )}
                  <span className="font-mono break-all">
                    {smtpTestResult.ok
                      ? `OK (${smtpTestResult.latencyMs}ms) — ${smtpTestResult.banner || 'EHLO verified'}`
                      : smtpTestResult.error || 'Connection failed'}
                  </span>
                </div>
              )}
            </div>
          </section>
        </div>

        {/* Webhook Delivery Logs & API Usage Logs */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <section className="bg-[#121929] border border-[#26334d] rounded-2xl overflow-hidden">
            <div className="px-5 py-3 border-b border-[#243049] flex items-center justify-between">
              <h2 className="font-display text-sm font-semibold text-slate-100 flex items-center gap-2">
                <Webhook className="w-4 h-4 text-[#7b93ff]" aria-hidden="true" />
                <span>Webhook Delivery Logs</span>
              </h2>
              <button
                type="button"
                onClick={() => void refreshLogsOnly()}
                aria-label="Refresh webhook and API logs"
                className="p-1.5 text-slate-400 hover:text-slate-100 rounded-lg hover:bg-[#1a243d] cursor-pointer"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${refreshingLogs ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
              </button>
            </div>
            <div className="divide-y divide-[#202b42] max-h-64 overflow-y-auto">
              {deliveries.length === 0 ? (
                <div className="p-4 text-xs text-slate-400">
                  No outbound webhook deliveries recorded yet. Add a signed webhook above and click Test.
                </div>
              ) : (
                deliveries.map((d) => (
                  <div key={d.id} className="px-4 py-2.5 text-xs flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-mono text-slate-200 truncate">{d.targetUrl}</div>
                      <div className="text-[11px] text-slate-400">
                        {d.eventType} · {d.attempts} attempt(s)
                        {d.error ? ` · ${d.error}` : ''}
                      </div>
                    </div>
                    <span
                      className={`font-mono text-[11px] font-semibold px-2 py-0.5 rounded shrink-0 ${
                        d.status === 'delivered'
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : 'bg-red-500/15 text-red-300'
                      }`}
                    >
                      {d.httpStatus ?? d.status}
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="bg-[#121929] border border-[#26334d] rounded-2xl overflow-hidden">
            <div className="px-5 py-3 border-b border-[#243049] flex items-center justify-between">
              <h2 className="font-display text-sm font-semibold text-slate-100 flex items-center gap-2">
                <Activity className="w-4 h-4 text-[#7b93ff]" aria-hidden="true" />
                <span>Recent API Usage Logs</span>
              </h2>
              <button
                type="button"
                onClick={() => void refreshLogsOnly()}
                aria-label="Refresh API usage logs"
                className="p-1.5 text-slate-400 hover:text-slate-100 rounded-lg hover:bg-[#1a243d] cursor-pointer"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${refreshingLogs ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
              </button>
            </div>
            <div className="divide-y divide-[#202b42] max-h-64 overflow-y-auto">
              {usageLogs.length === 0 ? (
                <div className="p-4 text-xs text-slate-400">No API requests logged yet.</div>
              ) : (
                usageLogs.map((u) => (
                  <div
                    key={u.id}
                    className="px-4 py-2 text-xs flex items-center justify-between gap-2 font-mono"
                  >
                    <div className="min-w-0 truncate text-slate-200">
                      <span className="text-[#8da2ff] font-semibold mr-2">{u.method}</span>
                      <span>{u.path}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 text-[11px]">
                      <span className={u.status < 400 ? 'text-emerald-400' : 'text-amber-400'}>
                        {u.status}
                      </span>
                      <span className="text-slate-500">{u.durationMs}ms</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        {/* REST Endpoints Table */}
        <section className="bg-[#121929] border border-[#26334d] rounded-2xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-[#243049]">
            <h2 className="font-display text-base font-semibold text-slate-100">
              REST API v1 Reference
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#243049] bg-[#161f33]">
                  <th className="px-5 py-2.5 text-xs font-semibold text-slate-300 w-28">Method</th>
                  <th className="px-5 py-2.5 text-xs font-semibold text-slate-300">Endpoint</th>
                  <th className="px-5 py-2.5 text-xs font-semibold text-slate-300">Behavior</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#202b42]">
                {ENDPOINTS.map((ep) => (
                  <tr key={`${ep.method}-${ep.path}`} className="hover:bg-[#172136]">
                    <td className="px-5 py-2.5 font-mono text-xs font-semibold text-[#8da2ff]">
                      {ep.method}
                    </td>
                    <td className="px-5 py-2.5 font-mono text-xs text-slate-100 whitespace-nowrap">
                      {ep.path}
                    </td>
                    <td className="px-5 py-2.5 text-xs text-slate-300">{ep.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
