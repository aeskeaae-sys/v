import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySpam,
  computeThreadId,
  extractArtifacts,
  extractLinks,
  extractOtpCodes,
  normalizeEmailAddress,
  parseMimeRawEmail,
  sanitizeAttachmentFilename,
  sanitizeEmailHtmlForSandbox,
  stripHtmlToText,
  validateAttachment,
  validateOutboundWebhookTarget,
  validateOutboundWebhookUrl,
} from './parser.ts';

test('normalizeEmailAddress handles plain and display-name formats', () => {
  const plain = normalizeEmailAddress('  QA-Signup@FlowMail.CC ');
  assert.deepEqual(plain, {
    localPart: 'qa-signup',
    domain: 'flowmail.cc',
    full: 'qa-signup@flowmail.cc',
    displayName: undefined,
  });

  const formatted = normalizeEmailAddress('"Acme Auth" <no-reply@qa.flowmail.cc>');
  assert.deepEqual(formatted, {
    localPart: 'no-reply',
    domain: 'qa.flowmail.cc',
    full: 'no-reply@qa.flowmail.cc',
    displayName: 'Acme Auth',
  });

  assert.equal(normalizeEmailAddress('invalid-email'), null);
  assert.equal(normalizeEmailAddress('user@bad..domain.com'), null);
});

test('extractOtpCodes extracts contextual and standalone verification codes while ignoring years', () => {
  const otpText = 'Copyright 2026 Acme Inc. Your verification code is 482910. It expires in 10 minutes.';
  assert.deepEqual(extractOtpCodes(otpText), ['482910']);

  const hyphenOtp = 'Use one-time passcode 931-408 to complete sign in.';
  assert.deepEqual(extractOtpCodes(hyphenOtp), ['931-408']);

  const fiveDigit = 'รหัส OTP ของคุณคือ 59201 ใช้ภายใน 5 นาที';
  assert.deepEqual(extractOtpCodes(fiveDigit), ['59201']);

  const alphaOtp = 'Your recovery code is AB12CD90 for account login.';
  assert.deepEqual(extractOtpCodes(alphaOtp), ['AB12CD90']);

  const yearOnly = 'Welcome to our newsletter from 2026!';
  assert.deepEqual(extractOtpCodes(yearOnly), []);

  const invoiceId = 'Payment of $49.00 succeeded for Invoice #INV-2026-0842.';
  assert.deepEqual(extractOtpCodes(invoiceId), []);
});

test('extractLinks filters unsafe protocols and classifies verification and reset links', () => {
  const html = `
    <p>Click below to verify:</p>
    <a href="https://app.example.com/auth/verify?token=abc123">Verify Email Address</a>
    <a href="javascript:alert(1)">Bad Link</a>
    <a href="https://app.example.com/reset-password?code=xyz">Reset Password</a>
  `;
  const links = extractLinks('Visit https://app.example.com/docs for help.', html);
  assert.equal(links.length, 3);
  assert.equal(links[0].kind, 'verification');
  assert.equal(links[0].label, 'Verify Email Address');
  assert.equal(links[1].kind, 'reset');
  assert.equal(links[2].kind, 'general');
  assert.equal(links.some((l) => l.url.startsWith('javascript:')), false);
});

test('extractArtifacts selects primaryOtp and primaryActionUrl', () => {
  const artifacts = extractArtifacts(
    'Your sign-in code is 774120.',
    '<a href="https://example.com/magic-login?t=123">Sign in immediately</a>',
  );
  assert.equal(artifacts.primaryOtp, '774120');
  assert.equal(artifacts.primaryActionUrl, 'https://example.com/magic-login?t=123');
});

test('stripHtmlToText removes scripts, styles, and decodes entities', () => {
  const result = stripHtmlToText(
    '<style>.a{color:red}</style><script>alert(1)</script><p>Hello &amp; welcome<br/>Code: <b>123456</b></p>',
  );
  assert.equal(result, 'Hello & welcome\nCode: 123456');
});

test('sanitizeEmailHtmlForSandbox strips scripts, svg, form, srcdoc, inline handlers, and adds strict CSP', () => {
  const out = sanitizeEmailHtmlForSandbox(
    '<div onclick="alert(1)"><script>steal()</script><svg onload="x()"><path/></svg><form action="/phish"><input name="pw"/></form><iframe srcdoc="<script>1</script>"></iframe><a href="javascript:void(0)">Click</a><img src="https://tracker.test/p.png"></div>',
    false,
  );
  assert.equal(out.includes('<script>'), false);
  assert.equal(out.includes('<svg'), false);
  assert.equal(out.includes('<form'), false);
  assert.equal(out.includes('srcdoc='), false);
  assert.equal(out.includes('onclick='), false);
  assert.equal(out.includes('javascript:'), false);
  assert.equal(out.includes("img-src data:;"), true);
});

test('validateOutboundWebhookUrl blocks private/loopback hosts and allows public https', () => {
  assert.equal(validateOutboundWebhookUrl('https://hooks.example.com/flowmail').ok, true);
  assert.equal(validateOutboundWebhookUrl('http://127.0.0.1:8080/hook').ok, false);
  assert.equal(validateOutboundWebhookUrl('http://localhost:3000/hook').ok, false);
  assert.equal(validateOutboundWebhookUrl('http://169.254.169.254/latest').ok, false);
  assert.equal(validateOutboundWebhookUrl('ftp://example.com/hook').ok, false);
});

test('validateOutboundWebhookTarget rejects DNS rebinding to private addresses', async () => {
  const rebound = await validateOutboundWebhookTarget('https://public.example.com/hook', async () => [
    { address: '127.0.0.1' },
  ]);
  assert.equal(rebound.ok, false);

  const metadata = await validateOutboundWebhookTarget('https://public.example.com/hook', async () => [
    { address: '169.254.169.254' },
  ]);
  assert.equal(metadata.ok, false);

  const allowed = await validateOutboundWebhookTarget('https://public.example.com/hook', async () => [
    { address: '93.184.216.34' },
  ]);
  assert.equal(allowed.ok, true);
});

test('MIME multipart parser decodes quoted-printable/base64 and sanitizes attachments', () => {
  const raw = [
    'From: "Relay Test" <bot@example.com>',
    'To: target@relaybox.dev',
    'Subject: Re: Verification Alert',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b123"',
    '',
    '--b123',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Your OTP is 654321=20today.',
    '--b123',
    'Content-Type: application/pdf; name="../../etc/invoice.pdf"',
    'Content-Disposition: attachment; filename="../../etc/invoice.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('PDFDATA').toString('base64'),
    '--b123--',
  ].join('\r\n');

  const parsed = parseMimeRawEmail(raw);
  assert.equal(parsed.subject, 'Re: Verification Alert');
  assert.ok(parsed.text.includes('654321'));
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].filename, 'invoice.pdf');
  assert.equal(sanitizeAttachmentFilename('..\\evil/run.txt'), 'run.txt');
  assert.equal(validateAttachment({ filename: 'malware.exe', contentType: 'application/octet-stream', size: 100 }).ok, false);
  assert.equal(validateAttachment({ filename: 'huge.zip', contentType: 'application/zip', size: 20 * 1024 * 1024 }).ok, false);
});

test('spam classifier flags phishing + executable payloads and threadId groups replies', () => {
  const clean = classifySpam({
    from: 'auth@acme.com',
    subject: 'Your verification code',
    text: 'Code: 445566',
    html: '',
    headers: { 'authentication-results': 'spf=pass dkim=pass' },
    attachments: [],
  });
  assert.equal(clean.isSpam, false);

  const spam = classifySpam({
    from: 'winner@scam.invalid',
    subject: 'URGENT: Claim $1,000,000 crypto prize — verify your bank account now!',
    text: 'You are a lottery winner! Send bitcoins now.',
    html: '<script>alert(1)</script>',
    headers: { 'authentication-results': 'spf=fail' },
    attachments: [{ filename: 'claim.exe', contentType: 'application/x-msdownload', size: 1024 }],
  });
  assert.equal(spam.isSpam, true);
  assert.ok(spam.score >= 60);

  assert.equal(
    computeThreadId('Verification Notice', {}),
    computeThreadId('Re: Fwd: Verification Notice', {}),
  );
});
