import {
  Activity,
  ChevronLeft,
  Inbox as InboxIcon,
  KeyRound,
  LayoutDashboard,
  LogIn,
  LogOut,
  Mail,
  Shield,
  UserCheck,
  Wand2,
  X,
} from 'lucide-react';
import type { User } from 'firebase/auth';

export type NavSection = 'dashboard' | 'create' | 'mailbox' | 'otp' | 'addresses';

interface AppSidebarProps {
  activeSection: NavSection;
  unreadCount: number;
  otpCount: number;
  inboxCount: number;
  collapsed: boolean;
  mobileOpen: boolean;
  firebaseUser?: User | null;
  signingIn?: boolean;
  cloudInboxCount?: number;
  onSignInGoogle?: () => void;
  onSignOutGoogle?: () => void;
  onSelectSection: (section: NavSection) => void;
  onOpenAdmin?: () => void;
  onToggleCollapse: () => void;
  onCloseMobile: () => void;
}

export function AppSidebar({
  activeSection,
  unreadCount,
  otpCount,
  inboxCount,
  collapsed,
  mobileOpen,
  firebaseUser,
  signingIn,
  cloudInboxCount = 0,
  onSignInGoogle,
  onSignOutGoogle,
  onSelectSection,
  onOpenAdmin,
  onToggleCollapse,
  onCloseMobile,
}: AppSidebarProps) {
  const navItems: {
    id: NavSection;
    label: string;
    icon: typeof LayoutDashboard;
    badge?: number;
  }[] = [
    { id: 'dashboard', label: 'แดชบอร์ด', icon: LayoutDashboard },
    { id: 'create', label: 'สร้างอีเมล', icon: Wand2 },
    {
      id: 'mailbox',
      label: 'กล่องจดหมาย',
      icon: InboxIcon,
      badge: unreadCount > 0 ? unreadCount : undefined,
    },
    {
      id: 'otp',
      label: 'ศูนย์ OTP',
      icon: KeyRound,
      badge: otpCount > 0 ? otpCount : undefined,
    },
    {
      id: 'addresses',
      label: 'บัญชีของฉัน',
      icon: UserCheck,
      badge: inboxCount > 0 ? inboxCount : undefined,
    },
  ];

  const handleSelect = (id: NavSection) => {
    onSelectSection(id);
    onCloseMobile();
  };

  const sidebarContent = (
    <div className="flex flex-col h-full bg-[#0e1422] border-r border-[#243049] select-none">
      {/* Brand Header */}
      <div className="h-16 px-4 flex items-center justify-between gap-2 border-b border-[#1d273c] shrink-0">
        <a
          href="#/dashboard"
          onClick={(e) => {
            e.preventDefault();
            handleSelect('dashboard');
          }}
          className="flex items-center gap-3 min-w-0 focus-visible:outline-2 focus-visible:outline-[#637bff] rounded-lg"
        >
          <span
            aria-hidden="true"
            className="w-9 h-9 rounded-xl bg-[#5e74ff] shadow-md shadow-[#5e74ff]/25 flex items-center justify-center shrink-0 text-white"
          >
            <Mail className="w-4.5 h-4.5" />
          </span>
          {!collapsed && (
            <span className="min-w-0">
              <span className="block font-display text-sm font-bold text-slate-100 leading-tight truncate">
                RelayBox
              </span>
              <span className="block text-[11px] text-slate-400 leading-tight truncate">
                หน้าบ้าน · User Portal
              </span>
            </span>
          )}
        </a>

        {/* Desktop collapse toggle */}
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="hidden lg:inline-flex items-center justify-center w-8 h-8 rounded-full bg-[#161f33] border border-[#283552] hover:border-[#445882] text-slate-400 hover:text-slate-100 transition-colors shrink-0 cursor-pointer"
        >
          <ChevronLeft
            className={`w-4 h-4 transition-transform ${collapsed ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        </button>

        {/* Mobile close toggle */}
        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Close navigation"
          className="inline-flex lg:hidden items-center justify-center w-8 h-8 rounded-lg bg-[#161f33] border border-[#283552] text-slate-300 hover:text-white cursor-pointer"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>

      {/* Navigation Links */}
      <nav aria-label="Main navigation" className="flex-1 overflow-y-auto p-3 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = activeSection === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => handleSelect(item.id)}
              aria-current={active ? 'page' : undefined}
              title={collapsed ? item.label : undefined}
              className={`w-full flex items-center ${
                collapsed ? 'justify-center px-2' : 'justify-between px-3.5'
              } py-2.5 rounded-xl text-sm font-medium transition-colors cursor-pointer whitespace-nowrap ${
                active
                  ? 'bg-[#1a243d] text-[#8da2ff] border border-[#2d3e66]'
                  : 'text-slate-400 hover:text-slate-100 hover:bg-[#141c2e] border border-transparent'
              }`}
            >
              <span className="flex items-center gap-3 min-w-0">
                <Icon
                  className={`w-4 h-4 shrink-0 ${active ? 'text-[#7b93ff]' : 'text-slate-400'}`}
                  aria-hidden="true"
                />
                {!collapsed && <span className="truncate">{item.label}</span>}
              </span>
              {!collapsed && item.badge !== undefined && (
                <span
                  className={`font-mono text-xs tabular-nums ${
                    active ? 'text-[#a5b6ff]' : 'text-slate-500'
                  }`}
                >
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Portal Footer: Admin Switch & Google Account */}
      <div className="p-3 border-t border-[#1d273c] shrink-0 space-y-2">
        {onOpenAdmin && (
          <button
            type="button"
            onClick={() => {
              onOpenAdmin();
              onCloseMobile();
            }}
            title="เข้าสู่ระบบหลังบ้าน (Admin)"
            className={`w-full flex items-center ${
              collapsed ? 'justify-center px-2' : 'justify-between px-3'
            } py-2 rounded-xl text-xs font-semibold text-amber-200 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 transition-colors cursor-pointer`}
          >
            <span className="flex items-center gap-2 min-w-0">
              <Shield className="w-3.5 h-3.5 text-amber-300 shrink-0" aria-hidden="true" />
              {!collapsed && <span className="truncate">ระบบหลังบ้าน (Admin)</span>}
            </span>
          </button>
        )}

        {(onSignInGoogle || firebaseUser) && (
          <div>
            {firebaseUser ? (
              <div
                className={`flex items-center ${
                  collapsed ? 'justify-center' : 'justify-between gap-2.5'
                } px-2.5 py-2 rounded-xl bg-[#131b2e] border border-[#25324e]`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  {firebaseUser.photoURL ? (
                    <img
                      src={firebaseUser.photoURL}
                      alt={firebaseUser.displayName || 'User avatar'}
                      referrerPolicy="no-referrer"
                      className="w-7 h-7 rounded-full border border-[#324675] shrink-0 object-cover"
                    />
                  ) : (
                    <span className="w-7 h-7 rounded-full bg-[#5e74ff]/20 border border-[#5e74ff]/40 text-[#9fb2ff] text-xs font-bold flex items-center justify-center shrink-0">
                      {(firebaseUser.displayName || firebaseUser.email || 'U')[0].toUpperCase()}
                    </span>
                  )}
                  {!collapsed && (
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-100 truncate">
                        {firebaseUser.displayName || firebaseUser.email || 'บัญชีผู้ใช้'}
                      </div>
                      <div className="text-[11px] text-emerald-400 truncate">
                        {cloudInboxCount > 0
                          ? `ซิงก์แล้ว (${cloudInboxCount} กล่อง)`
                          : firebaseUser.email || 'เชื่อมต่อ Google แล้ว'}
                      </div>
                    </div>
                  )}
                </div>
                {!collapsed && onSignOutGoogle && (
                  <button
                    type="button"
                    onClick={onSignOutGoogle}
                    title="ออกจากระบบ"
                    aria-label="Sign out"
                    className="p-1.5 text-slate-400 hover:text-slate-100 hover:bg-[#1c2842] rounded-lg shrink-0 cursor-pointer"
                  >
                    <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={onSignInGoogle}
                disabled={signingIn}
                title="เข้าสู่ระบบด้วย Google"
                className={`w-full flex items-center ${
                  collapsed ? 'justify-center px-2' : 'justify-center gap-2 px-3'
                } py-2 rounded-xl text-xs font-semibold text-slate-100 bg-[#161f33] hover:bg-[#1e2a45] border border-[#2c3b59] hover:border-[#637bff] transition-colors cursor-pointer disabled:opacity-50`}
              >
                <LogIn className="w-3.5 h-3.5 text-[#7b93ff] shrink-0" aria-hidden="true" />
                {!collapsed && (
                  <span className="truncate">
                    {signingIn ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบด้วย Google'}
                  </span>
                )}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Rail */}
      <aside
        aria-label="Primary sidebar"
        className={`hidden lg:flex flex-col shrink-0 transition-[width] duration-150 ${
          collapsed ? 'w-[74px]' : 'w-[244px]'
        }`}
      >
        {sidebarContent}
      </aside>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            onClick={onCloseMobile}
            className="fixed inset-0 bg-black/65"
            aria-hidden="true"
          />
          <aside
            aria-label="Mobile sidebar"
            className="relative z-10 w-[264px] max-w-[82vw] h-full flex flex-col"
          >
            {sidebarContent}
          </aside>
        </div>
      )}
    </>
  );
}
