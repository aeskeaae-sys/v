import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import type { FlowMailStore } from './store.ts';
import { normalizeEmailAddress, parseMimeRawEmail } from './parser.ts';

const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
const SOCKET_IDLE_MS = 60_000;

export interface OutboundSmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  configured: boolean;
}

export function getOutboundSmtpConfig(): OutboundSmtpConfig {
  const host = (process.env.SMTP_OUTBOUND_HOST || '').trim();
  const port = Number(process.env.SMTP_OUTBOUND_PORT || 587);
  const secure = process.env.SMTP_OUTBOUND_SECURE === 'true' || port === 465;
  const user = (process.env.SMTP_OUTBOUND_USER || '').trim() || undefined;
  const pass = (process.env.SMTP_OUTBOUND_PASS || '').trim() || undefined;
  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : 587,
    secure,
    user,
    pass,
    configured: Boolean(host),
  };
}

export async function testSmtpConnection(params: {
  host: string;
  port: number;
  secure?: boolean;
}): Promise<{ ok: boolean; latencyMs: number; banner?: string; error?: string }> {
  const host = params.host.trim();
  const port = Number(params.port);
  if (!host || !Number.isFinite(port) || port < 1 || port > 65535) {
    return { ok: false, latencyMs: 0, error: 'Invalid SMTP host or port.' };
  }

  const startedAt = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (res: { ok: boolean; banner?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      resolve({ ...res, latencyMs: Date.now() - startedAt });
    };

    const socket = params.secure
      ? tls.connect({ host, port, servername: host, timeout: 5000 })
      : net.createConnection({ host, port, timeout: 5000 });

    let stage: 'greeting' | 'ehlo' = 'greeting';
    let buffer = '';

    socket.setTimeout(5000);
    socket.on('timeout', () => {
      socket.destroy();
      finish({ ok: false, error: 'SMTP connection timed out after 5000ms.' });
    });

    socket.on('error', (err) => {
      finish({ ok: false, error: err.message });
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (!buffer.includes('\n')) return;
      const lines = buffer.trim().split(/\r?\n/);
      const last = lines[lines.length - 1] || '';

      if (stage === 'greeting' && /^220[\s-]/.test(last)) {
        stage = 'ehlo';
        const banner = lines[0];
        buffer = '';
        socket.write('EHLO relaybox.local\r\n');
        setTimeout(() => {
          if (!settled) {
            socket.write('QUIT\r\n');
            socket.end();
            finish({ ok: true, banner });
          }
        }, 120);
      } else if (stage === 'ehlo' && /^250[\s-]/.test(last)) {
        const banner = lines[0];
        socket.write('QUIT\r\n');
        socket.end();
        finish({ ok: true, banner });
      }
    });
  });
}

function constantTimeStrEq(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

export function startSmtpBridge(
  store: FlowMailStore,
  port = Number(process.env.SMTP_PORT || 2525),
): { port: number | null; authRequired: boolean; close: () => void } {
  let activePort: number | null = null;
  const authUser = (process.env.SMTP_AUTH_USER || '').trim();
  const authPass = (process.env.SMTP_AUTH_PASS || '').trim();
  const authRequired = Boolean(authUser && authPass);

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.setTimeout(SOCKET_IDLE_MS);

    let mailFrom = '';
    const rcptTo: string[] = [];
    let inData = false;
    let awaitingAuthLoginUser = false;
    let awaitingAuthLoginPass = false;
    let pendingAuthUser = '';
    let authenticated = !authRequired;
    let buffer = '';
    let dataBytes = 0;
    let dataLines: string[] = [];

    const writeLine = (line: string) => {
      if (!socket.destroyed) {
        socket.write(`${line}\r\n`);
      }
    };

    writeLine('220 relaybox.dev ESMTP RelayBox Inbound Bridge');

    const processLine = (line: string) => {
      if (awaitingAuthLoginUser) {
        awaitingAuthLoginUser = false;
        awaitingAuthLoginPass = true;
        pendingAuthUser = Buffer.from(line.trim(), 'base64').toString('utf8');
        writeLine('334 UGFzc3dvcmQ6');
        return;
      }

      if (awaitingAuthLoginPass) {
        awaitingAuthLoginPass = false;
        const pass = Buffer.from(line.trim(), 'base64').toString('utf8');
        if (constantTimeStrEq(pendingAuthUser, authUser) && constantTimeStrEq(pass, authPass)) {
          authenticated = true;
          writeLine('235 2.7.0 Authentication successful');
        } else {
          writeLine('535 5.7.8 Authentication credentials invalid');
        }
        return;
      }

      if (inData) {
        if (line === '.') {
          inData = false;
          const parsed = parseMimeRawEmail(dataLines.join('\r\n'));
          const sender = parsed.from || mailFrom || 'smtp@localhost';
          let deliveredCount = 0;
          for (const rcpt of rcptTo) {
            try {
              store.ingestMessage({
                to: rcpt,
                from: sender,
                subject: parsed.subject,
                text: parsed.text,
                html: parsed.html,
                headers: parsed.headers,
                attachments: parsed.attachments,
                autoCreateInbox: true,
                source: 'smtp',
              });
              deliveredCount += 1;
            } catch {
              // Ignore unsupported domain recipients
            }
          }
          dataLines = [];
          dataBytes = 0;
          mailFrom = '';
          rcptTo.length = 0;
          if (deliveredCount > 0) {
            writeLine('250 2.0.0 Ok: queued in RelayBox');
          } else {
            writeLine('550 5.1.1 No valid RelayBox recipients accepted');
          }
        } else {
          dataBytes += Buffer.byteLength(line, 'utf8') + 2;
          if (dataBytes > MAX_MESSAGE_BYTES) {
            inData = false;
            dataLines = [];
            dataBytes = 0;
            writeLine('552 5.3.4 Message size exceeds fixed maximum (5 MB)');
            return;
          }
          dataLines.push(line.startsWith('..') ? line.slice(1) : line);
        }
        return;
      }

      const upper = line.toUpperCase();
      if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
        writeLine('250-relaybox.dev');
        writeLine(`250-SIZE ${MAX_MESSAGE_BYTES}`);
        if (authRequired) {
          writeLine('250 AUTH PLAIN LOGIN');
        } else {
          writeLine('250 8BITMIME');
        }
      } else if (upper.startsWith('AUTH PLAIN')) {
        if (!authRequired) {
          authenticated = true;
          writeLine('235 2.7.0 Ok');
          return;
        }
        const b64 = line.slice(10).trim();
        const decoded = Buffer.from(b64, 'base64').toString('utf8');
        const parts = decoded.split('\0');
        const user = parts[1] ?? '';
        const pass = parts[2] ?? '';
        if (constantTimeStrEq(user, authUser) && constantTimeStrEq(pass, authPass)) {
          authenticated = true;
          writeLine('235 2.7.0 Authentication successful');
        } else {
          writeLine('535 5.7.8 Authentication credentials invalid');
        }
      } else if (upper === 'AUTH LOGIN') {
        if (!authRequired) {
          authenticated = true;
          writeLine('235 2.7.0 Ok');
          return;
        }
        awaitingAuthLoginUser = true;
        writeLine('334 VXNlcm5hbWU6');
      } else if (upper.startsWith('MAIL FROM:')) {
        if (!authenticated) {
          writeLine('530 5.7.0 Authentication required');
          return;
        }
        const parsed = normalizeEmailAddress(line.slice(10));
        mailFrom = parsed?.full || line.slice(10).replace(/[<>]/g, '').trim();
        writeLine('250 2.1.0 Ok');
      } else if (upper.startsWith('RCPT TO:')) {
        if (!authenticated) {
          writeLine('530 5.7.0 Authentication required');
          return;
        }
        const parsed = normalizeEmailAddress(line.slice(8));
        if (parsed) {
          rcptTo.push(parsed.full);
          writeLine('250 2.1.5 Ok');
        } else {
          writeLine('550 5.1.1 Invalid recipient address');
        }
      } else if (upper === 'DATA') {
        if (!authenticated) {
          writeLine('530 5.7.0 Authentication required');
          return;
        }
        inData = true;
        dataBytes = 0;
        dataLines = [];
        writeLine('354 End data with <CR><LF>.<CR><LF>');
      } else if (upper === 'RSET') {
        mailFrom = '';
        rcptTo.length = 0;
        inData = false;
        dataBytes = 0;
        dataLines = [];
        writeLine('250 2.0.0 Ok');
      } else if (upper === 'NOOP') {
        writeLine('250 2.0.0 Ok');
      } else if (upper === 'QUIT') {
        writeLine('221 2.0.0 Bye');
        socket.end();
      } else {
        writeLine('502 5.5.2 Command not recognized');
      }
    };

    socket.on('timeout', () => {
      writeLine('421 4.4.2 Connection timed out due to inactivity');
      socket.destroy();
    });

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (!inData && Buffer.byteLength(buffer, 'utf8') > 65_536) {
        writeLine('500 5.5.2 Command line too long');
        socket.destroy();
        return;
      }
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const rawLine = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        processLine(rawLine);
      }
    });

    socket.on('error', () => {
      // Ignore client socket disconnects
    });
  });

  server.on('error', () => {
    activePort = null;
  });

  try {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        activePort = addr.port;
      }
    });
  } catch {
    activePort = null;
  }

  return {
    get port() {
      return activePort;
    },
    authRequired,
    close: () => {
      try {
        server.close();
      } catch {
        // Ignore close error
      }
    },
  };
}
