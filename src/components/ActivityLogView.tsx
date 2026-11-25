import { useCallback, useEffect, useState } from 'react';
import { Activity, ChevronLeft, ChevronRight, Download, RefreshCw, Search } from 'lucide-react';
import type { ActivityEvent, ActivityEventType, ActivityStatus } from '../../shared/types';
import { downloadActivityExport, listActivities } from '../api/client';
import { formatExactTimestamp } from '../utils/format';

interface ActivityLogViewProps {
  activities: ActivityEvent[];
  onRefresh: () => void;
}

const EVENT_LABELS: Record<ActivityEventType, string> = {
  'inbox:created': 'Inbox Created',
  'inbox:updated': 'Inbox Updated',
  'inbox:deleted': 'Inbox Deleted',
  'address:switched': 'Address Switched',
  'email:received': 'Email Received',
  'email:read': 'Email Read',
  'email:sent': 'Email Sent / Draft',
  'otp:detected': 'OTP Detected',
  'wait:matched': 'API Wait Matched',
  'wait:timeout': 'API Wait Timeout',
  'key:created': 'API Key Created',
  'key:revoked': 'API Key Revoked',
  'webhook:created': 'Webhook Registered',
  'webhook:delivered': 'Webhook Delivered',
  'webhook:failed': 'Webhook Failed',
  'webhook:retry': 'Webhook Retry',
  'system:maintenance': 'System Maintenance',
  'inbox:synced': 'Inbox Synced',
  'auth:failed': 'Auth Failed',
  'auth:event': 'Auth Event',
  'smtp:test': 'SMTP Check',
};

const STATUS_BADGE: Record<ActivityStatus, string> = {
  success: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  info: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  warning: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  error: 'bg-red-500/15 text-red-300 border-red-500/30',
};

const PAGE_SIZE = 25;

export function ActivityLogView({ activities: initialActivities, onRefresh }: ActivityLogViewProps) {
  const [items, setItems] = useState<ActivityEvent[]>(initialActivities);
  const [total, setTotal] = useState<number>(initialActivities.length);
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);

  const fetchFiltered = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listActivities({
        q: searchQuery.trim() || undefined,
        type: typeFilter || undefined,
        status: statusFilter || undefined,
        from: dateFrom ? new Date(dateFrom).toISOString() : undefined,
        to: dateTo ? new Date(`${dateTo}T23:59:59.999Z`).toISOString() : undefined,
        limit: PAGE_SIZE,
        offset,
      });
      setItems(res.activities);
      setTotal(res.total);
    } catch {
      // fallback to prop state on error
    } finally {
      setLoading(false);
    }
  }, [searchQuery, typeFilter, statusFilter, dateFrom, dateTo, offset]);

  useEffect(() => {
    void fetchFiltered();
  }, [fetchFiltered, initialActivities.length]);

  const handleRefresh = () => {
    onRefresh();
    void fetchFiltered();
  };

  return (
    <div className="flex-1 overflow-y-auto bg-[#0b0f19] p-4 sm:p-6 lg:p-8">
      <div className="max-w-6xl mx-auto space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-bold text-slate-50">
              บันทึกกิจกรรม (Activity Log)
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              ประวัติการสร้างกล่องจดหมาย การรับ/ส่งอีเมล Webhook การตรวจสอบสิทธิ์ และ API ({total} รายการ)
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void downloadActivityExport('json')}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-200 bg-[#161f33] border border-[#2c3a57] hover:border-[#4b618f] rounded-xl cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Export JSON</span>
            </button>
            <button
              type="button"
              onClick={() => void downloadActivityExport('csv')}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-200 bg-[#161f33] border border-[#2c3a57] hover:border-[#4b618f] rounded-xl cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Export CSV</span>
            </button>
            <button
              type="button"
              onClick={handleRefresh}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-[#637bff] hover:bg-[#526bf5] rounded-xl whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>รีเฟรช</span>
            </button>
          </div>
        </div>

        {/* Filter Controls */}
        <div className="bg-[#121929] border border-[#26334d] rounded-2xl p-3.5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="relative lg:col-span-2">
            <Search
              className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <label htmlFor="activity-search" className="sr-only">
              ค้นหาบันทึกกิจกรรม
            </label>
            <input
              id="activity-search"
              type="search"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setOffset(0);
              }}
              placeholder="ค้นหากิจกรรม, ที่อยู่อีเมล หรือรายละเอียด…"
              className="w-full pl-8.5 pr-3 py-2 text-xs bg-[#0b101b] border border-[#2c3b59] rounded-xl text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-[#637bff]"
            />
          </div>

          <select
            aria-label="กรองตามประเภทเหตุการณ์"
            value={typeFilter}
            onChange={(e) => {
              setTypeFilter(e.target.value);
              setOffset(0);
            }}
            className="px-3 py-2 text-xs bg-[#0b101b] border border-[#2c3b59] rounded-xl text-slate-100 focus:outline-none focus:border-[#637bff]"
          >
            <option value="">ทุกประเภทเหตุการณ์</option>
            {(Object.keys(EVENT_LABELS) as ActivityEventType[]).map((k) => (
              <option key={k} value={k}>
                {EVENT_LABELS[k]}
              </option>
            ))}
          </select>

          <select
            aria-label="กรองตามสถานะ"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setOffset(0);
            }}
            className="px-3 py-2 text-xs bg-[#0b101b] border border-[#2c3b59] rounded-xl text-slate-100 focus:outline-none focus:border-[#637bff]"
          >
            <option value="">ทุกสถานะ</option>
            <option value="success">Success</option>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="error">Error</option>
          </select>

          <div className="flex items-center gap-1.5">
            <input
              type="date"
              aria-label="ตั้งแต่วันที่"
              value={dateFrom}
              onChange={(e) => {
                setDateFrom(e.target.value);
                setOffset(0);
              }}
              className="flex-1 min-w-0 px-2 py-2 text-[11px] bg-[#0b101b] border border-[#2c3b59] rounded-xl text-slate-200"
            />
            <input
              type="date"
              aria-label="ถึงวันที่"
              value={dateTo}
              onChange={(e) => {
                setDateTo(e.target.value);
                setOffset(0);
              }}
              className="flex-1 min-w-0 px-2 py-2 text-[11px] bg-[#0b101b] border border-[#2c3b59] rounded-xl text-slate-200"
            />
          </div>
        </div>

        <div className="bg-[#121929] border border-[#26334d] rounded-2xl overflow-hidden">
          {items.length === 0 ? (
            <div className="p-8 text-center text-slate-400">
              <Activity className="w-7 h-7 text-slate-500 mx-auto mb-2" aria-hidden="true" />
              <p className="text-sm font-medium text-slate-200">ไม่พบกิจกรรมที่ตรงกับเงื่อนไข</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#243049] bg-[#161f33]">
                    <th className="px-4 py-2.5 text-xs font-semibold text-slate-300 w-36">
                      Event
                    </th>
                    <th className="px-4 py-2.5 text-xs font-semibold text-slate-300 w-24">
                      Status
                    </th>
                    <th className="px-4 py-2.5 text-xs font-semibold text-slate-300">
                      Summary
                    </th>
                    <th className="px-4 py-2.5 text-xs font-semibold text-slate-300">
                      Inbox
                    </th>
                    <th className="px-4 py-2.5 text-xs font-semibold text-slate-300 text-right w-44">
                      Timestamp
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#202b42]">
                  {items.map((ev) => (
                    <tr key={ev.id} className="hover:bg-[#172136]">
                      <td className="px-4 py-2.5 text-xs font-semibold text-[#8da2ff] whitespace-nowrap">
                        {EVENT_LABELS[ev.type] ?? ev.type}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <span
                          className={`inline-block px-2 py-0.5 text-[11px] font-semibold rounded border uppercase ${
                            STATUS_BADGE[ev.status ?? 'info']
                          }`}
                        >
                          {ev.status ?? 'info'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-slate-200 max-w-md">
                        <div>{ev.summary}</div>
                        {ev.detail && (
                          <div className="font-mono text-[11px] text-slate-400 mt-0.5 break-all">
                            {ev.detail}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-slate-300 whitespace-nowrap">
                        {ev.inboxAddress || '—'}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-slate-400 text-right tabular-nums whitespace-nowrap">
                        {formatExactTimestamp(ev.timestamp)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination Footer */}
          {total > PAGE_SIZE && (
            <div className="px-4 py-3 border-t border-[#243049] bg-[#101727] flex items-center justify-between text-xs text-slate-400">
              <span>
                แสดง {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} จาก {total} รายการ
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={offset === 0}
                  onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                  className="inline-flex items-center gap-1 px-2.5 py-1 bg-[#161f33] border border-[#2c3a57] rounded-lg text-slate-200 disabled:opacity-40 cursor-pointer"
                >
                  <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>ก่อนหน้า</span>
                </button>
                <button
                  type="button"
                  disabled={offset + PAGE_SIZE >= total}
                  onClick={() => setOffset((o) => o + PAGE_SIZE)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 bg-[#161f33] border border-[#2c3a57] rounded-lg text-slate-200 disabled:opacity-40 cursor-pointer"
                >
                  <span>ถัดไป</span>
                  <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
