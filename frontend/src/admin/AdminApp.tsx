import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { AuthProvider, useAuth, type Role } from '../context/AuthContext';
import { Login } from './Login';
import { Users } from './Users';
import { Blacklist } from './Blacklist';
import { CreditPolicy } from './CreditPolicy';
import { ChangePasswordModal } from './ChangePasswordModal';
import { Promotions } from './Promotions';
import { Salespersons } from './Salespersons';
import { Quotations } from './Quotations';
import { PageHeaderProvider, PageHeaderOutlet } from './PageHeader';
import { ThemeToggle } from './ThemeToggle';
import { QuotationRules } from './QuotationRules';
import { OptionalLinks } from './OptionalLinks';
import { StockRules } from './StockRules';
import { ProductMoqRules } from './ProductMoqRules';
import { ShippingFee } from './ShippingFee';
import { SyncPanel } from './SyncPanel';
import { ApiLogs } from './ApiLogs';
import { Traffic } from './logs/Traffic';
import { AuditLogs } from './logs/AuditLogs';
import { SystemLogs } from './logs/SystemLogs';
import {
  LogOut,
  User as UserIcon,
  Shield,
  LayoutDashboard,
  Loader2,
  Tag,
  UserCheck,
  FileText,
  Sliders,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  Menu,
  X,
  AlertCircle,
  Users as UsersIcon,
  KeyRound,
  Ban,
  ClipboardList,
} from 'lucide-react';

type MainTab =
  | 'dashboard' | 'quotations' | 'salespersons' | 'promotions' | 'users' | 'blacklist'
  // กลุ่ม "บันทึกและรายงาน" — 4 หน้าที่อยู่ใต้หัวข้อพับได้อันเดียวกัน
  | 'traffic' | 'apilogs' | 'auditlogs' | 'systemlogs'
  | 'settings';
type SubTab = 'quotation' | 'optional' | 'stock' | 'moq' | 'shipping';

interface AdminStats {
  quotations: number;
  promotions: number;
  salespersons: number;
  quotation_rules: number;
  optional_links: number;
  stock_rules: number;
  moq_rules: number;
}

const BRAND = 'var(--brand-fg)';
const BRAND_SOFT = 'var(--brand-soft)';
const BRAND_SOFT_STRONG = 'var(--brand-soft-strong)';
const BRAND_BORDER = 'var(--brand-border)';

// roles = สิทธิ์ที่เห็นเมนูนี้ — เป็นแค่การซ่อน UI เท่านั้น ตัวบังคับจริงคือ requireRole ฝั่ง backend
const NAV_ITEMS: { key: MainTab; label: string; icon: typeof LayoutDashboard; roles: Role[] }[] = [
  { key: 'dashboard', label: 'แผงควบคุม', icon: LayoutDashboard, roles: ['admin'] },
  { key: 'quotations', label: 'ประวัติใบเสนอราคา', icon: FileText, roles: ['admin', 'subadmin'] },
  { key: 'promotions', label: 'จัดการโปรโมชันส่วนลด', icon: Tag, roles: ['admin'] },
  { key: 'salespersons', label: 'จัดการข้อมูลพนักงาน', icon: UserCheck, roles: ['admin'] },
  { key: 'users', label: 'จัดการผู้ใช้งานระบบ', icon: UsersIcon, roles: ['admin'] },
  { key: 'blacklist', label: 'บัญชีห้ามเสนอราคา', icon: Ban, roles: ['admin', 'user'] },
];

/**
 * กลุ่ม "บันทึกและรายงาน" — 4 หน้าที่ตอบคนละคำถามแต่ใช้ request_id ตัวเดียวกันโยงถึงกันได้
 *
 * "บันทึกการเรียก API" คือหน้าเดิมที่ย้ายเข้ามาอยู่ในกลุ่ม ไม่ได้ถูกแก้แม้แต่บรรทัดเดียว
 * (ApiLogs.tsx ใช้งานได้ดีอยู่แล้ว — การขยับเพื่อความสวยของโค้ดคือความเสี่ยงเปล่า)
 */
const LOGS_SUBITEMS: { key: MainTab; label: string }[] = [
  { key: 'traffic', label: 'รายงานการใช้งาน' },
  { key: 'apilogs', label: 'บันทึกการเรียก API' },
  { key: 'auditlogs', label: 'บันทึกการแก้ไข' },
  { key: 'systemlogs', label: 'บันทึกระบบ' },
];

/** แท็บที่อยู่ใต้กลุ่ม "บันทึกและรายงาน" — ใช้ตัดสินว่าหัวข้อกลุ่มควรขึ้นสถานะ active ไหม */
const LOG_TABS = new Set<MainTab>(LOGS_SUBITEMS.map((i) => i.key));

const SETTINGS_SUBITEMS: { key: SubTab; label: string }[] = [
  { key: 'quotation', label: 'เงื่อนไขหลัก' },
  { key: 'optional', label: 'สินค้าพ่วงเสริม' },
  { key: 'stock', label: 'ระงับเมื่อหมดสต็อก' },
  { key: 'moq', label: 'ขั้นต่ำสั่งซื้อ' },
  { key: 'shipping', label: 'ค่าขนส่ง & เครดิต' },
];

const PAGE_TITLES: Record<MainTab, string> = {
  dashboard: 'แผงควบคุม',
  quotations: 'ประวัติใบเสนอราคา',
  promotions: 'จัดการโปรโมชันส่วนลด',
  salespersons: 'จัดการข้อมูลพนักงาน',
  users: 'จัดการผู้ใช้งานระบบ',
  blacklist: 'บัญชีห้ามเสนอราคา',
  traffic: 'รายงานการใช้งาน',
  apilogs: 'บันทึกการเรียก API',
  auditlogs: 'บันทึกการแก้ไข',
  systemlogs: 'บันทึกระบบ',
  settings: 'ตั้งค่าเงื่อนไข & กฎ',
};

function AdminContent() {
  const { isAuthenticated, isLoading, user, token, logout } = useAuth();
  const [activeTab, setActiveTab] = useState<MainTab>('dashboard');
  const [subTab, setSubTab] = useState<SubTab>('quotation');
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [settingsExpanded, setSettingsExpanded] = useState(true);
  // ตั้งต้นปิด — คนส่วนใหญ่เข้ามาทำงานประจำวัน ไม่ได้มาดู log ทุกครั้ง
  const [logsExpanded, setLogsExpanded] = useState(false);
  // ตอน sidebar ย่อ: กดไอคอนตั้งค่า → เปิด flyout เลือก sub-tab (nav มี overflow-y-auto จึงต้องลอยแบบ fixed)
  const [settingsFlyoutTop, setSettingsFlyoutTop] = useState<number | null>(null);
  const settingsBtnRef = useRef<HTMLButtonElement>(null);
  const settingsFlyoutRef = useRef<HTMLDivElement>(null);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);

  const isAdmin = user?.role === 'admin';
  const visibleNavItems = NAV_ITEMS.filter((item) => !!user && item.roles.includes(user.role));

  // แท็บที่แสดงจริง — activeTab ตั้งต้นเป็น 'dashboard' ซึ่ง role 'user' ไม่มีสิทธิ์เห็น
  // คำนวณตอน render แทนการ setState ใน effect: ไม่มี re-render รอบพิเศษ และครอบเคสถูกลดสิทธิ์
  // ระหว่างเปิดหน้าค้างไว้ด้วย (adminAuthMiddleware อ่าน role สดจาก DB ทุก request)
  const effectiveTab: MainTab =
    visibleNavItems.some((item) => item.key === activeTab) ||
    ((activeTab === 'settings' || LOG_TABS.has(activeTab)) && isAdmin)
      ? activeTab
      : (visibleNavItems[0]?.key ?? 'blacklist');

  useEffect(() => {
    // /api/admin/stats เปิดให้เฉพาะ admin — ยิงด้วย role อื่นจะได้ 403 แล้วขึ้น error ให้เปล่า ๆ
    if (activeTab !== 'dashboard' || !token || !isAdmin) return;
    let cancelled = false;
    const fetchStats = async () => {
      setStatsLoading(true);
      setStatsError(null);
      try {
        const res = await fetch('/api/admin/stats', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error('failed');
        const data: AdminStats = await res.json();
        if (!cancelled) setStats(data);
      } catch {
        if (!cancelled) setStatsError('ไม่สามารถโหลดข้อมูลสรุปได้');
      } finally {
        if (!cancelled) setStatsLoading(false);
      }
    };
    fetchStats();
    return () => {
      cancelled = true;
    };
  }, [activeTab, token, isAdmin]);

  const closeSettingsFlyout = useCallback(() => setSettingsFlyoutTop(null), []);

  // ปิด flyout เลือก sub-tab เมื่อคลิกนอกพื้นที่ / กด Esc
  useEffect(() => {
    if (settingsFlyoutTop === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSettingsFlyout();
    };
    const onPointer = (e: MouseEvent) => {
      const t = e.target as Node;
      if (settingsFlyoutRef.current?.contains(t) || settingsBtnRef.current?.contains(t)) return;
      closeSettingsFlyout();
    };
    window.addEventListener('keydown', onKey);
    // capture=true จับก่อน handler ปุ่มอื่น กันเคสคลิกปุ่มแล้ว flyout ยังค้าง
    window.addEventListener('mousedown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onPointer, true);
    };
  }, [settingsFlyoutTop, closeSettingsFlyout]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-800 flex flex-col items-center justify-center gap-3">
        <Loader2 className="w-10 h-10 animate-spin" style={{ color: BRAND }} />
        <p className="text-slate-500 text-sm font-medium">กำลังโหลดข้อมูล...</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Login />;
  }

  const goTo = (tab: MainTab) => {
    setActiveTab(tab);
    setMobileOpen(false);
    closeSettingsFlyout();
    if (tab === 'settings') setSettingsExpanded(true);
    if (LOG_TABS.has(tab)) setLogsExpanded(true);
  };

  const goToSubTab = (tab: SubTab) => {
    setActiveTab('settings');
    setSubTab(tab);
    setMobileOpen(false);
    closeSettingsFlyout();
  };

  // ปุ่มตั้งค่า: ย่ออยู่ → toggle flyout (คำนวณ top จากปุ่ม), ขยายอยู่ → accordion แบบเดิม
  const onSettingsClick = () => {
    if (!collapsed) {
      setSettingsExpanded((v) => !v);
      return;
    }
    setSettingsFlyoutTop((cur) => {
      if (cur !== null) return null;
      return settingsBtnRef.current?.getBoundingClientRect().top ?? null;
    });
  };

  // ย่อ/ขยาย sidebar — ปิด flyout ทุกครั้งไม่ให้ค้างลอยตอนความกว้างเปลี่ยน
  const toggleCollapsed = () => {
    closeSettingsFlyout();
    setCollapsed((v) => !v);
  };

  const SUMMARY_CARDS: {
    key: keyof AdminStats;
    label: string;
    unit: string;
    icon: typeof LayoutDashboard;
    onClick: () => void;
  }[] = [
    { key: 'quotations', label: 'ใบเสนอราคา', unit: 'รายการ', icon: FileText, onClick: () => goTo('quotations') },
    { key: 'promotions', label: 'โปรโมชันส่วนลด', unit: 'รายการ', icon: Tag, onClick: () => goTo('promotions') },
    { key: 'salespersons', label: 'ข้อมูลพนักงาน', unit: 'คน', icon: UserCheck, onClick: () => goTo('salespersons') },
    { key: 'quotation_rules', label: 'เงื่อนไขหลัก', unit: 'รายการ', icon: Sliders, onClick: () => goToSubTab('quotation') },
    { key: 'optional_links', label: 'สินค้าพ่วงเสริม', unit: 'รายการ', icon: Sliders, onClick: () => goToSubTab('optional') },
    { key: 'stock_rules', label: 'ระงับเมื่อหมดสต็อก', unit: 'รายการ', icon: Sliders, onClick: () => goToSubTab('stock') },
    { key: 'moq_rules', label: 'ขั้นต่ำสั่งซื้อ (MOQ)', unit: 'รายการ', icon: Sliders, onClick: () => goToSubTab('moq') },
  ];

  const sidebarWidth = collapsed ? 76 : 264;

  const SidebarContent = (
    <div className="h-full flex flex-col bg-card">
      {/* Brand / collapse control */}
      <div className="h-16 flex items-center gap-3 px-4 border-b border-slate-200 shrink-0">
        <img
          src="/logo.png"
          alt="Logo"
          className="w-9 h-9 object-contain bg-card p-1 rounded-lg border border-slate-200 shrink-0"
        />
        {!collapsed && (
          <div className="overflow-hidden">
            <h1 className="text-sm font-bold tracking-tight text-slate-900 leading-tight whitespace-nowrap">
              Primus <span style={{ color: BRAND }}>Admin</span>
            </h1>
            <p className="text-[10px] text-slate-400 font-medium whitespace-nowrap">Quotation Portal</p>
          </div>
        )}
        <button
          onClick={() => setMobileOpen(false)}
          className="lg:hidden ml-auto flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:bg-slate-50 shrink-0"
          aria-label="ปิดเมนู"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-3 px-2.5 space-y-0.5">
        {visibleNavItems.map(({ key, label, icon: Icon }) => {
          const active = effectiveTab === key;
          return (
            <button
              key={key}
              onClick={() => goTo(key)}
              title={collapsed ? label : undefined}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                collapsed ? 'justify-center' : ''
              } ${active ? '' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'}`}
              style={active ? { backgroundColor: BRAND_SOFT_STRONG, color: BRAND } : undefined}
            >
              <Icon className="w-[18px] h-[18px] shrink-0" />
              {!collapsed && <span className="whitespace-nowrap">{label}</span>}
            </button>
          );
        })}

        {isAdmin && (
          <>
        <div className="h-px bg-slate-100 my-2.5 mx-1.5" />

        {/* บันทึกและรายงาน — กลุ่มพับได้ แบบเดียวกับกลุ่มตั้งค่า */}
        <button
          onClick={() => (collapsed ? goTo('traffic') : setLogsExpanded((v) => !v))}
          title={collapsed ? 'บันทึกและรายงาน' : undefined}
          aria-expanded={collapsed ? undefined : logsExpanded}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition-all ${
            collapsed ? 'justify-center' : ''
          } ${LOG_TABS.has(effectiveTab) ? '' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'}`}
          style={LOG_TABS.has(effectiveTab) ? { backgroundColor: BRAND_SOFT_STRONG, color: BRAND } : undefined}
        >
          <ClipboardList className="w-[18px] h-[18px] shrink-0" />
          {!collapsed && (
            <>
              <span className="whitespace-nowrap flex-1 text-left">บันทึกและรายงาน</span>
              <ChevronDown
                className={`w-3.5 h-3.5 shrink-0 transition-transform ${logsExpanded ? '' : '-rotate-90'}`}
              />
            </>
          )}
        </button>

        {!collapsed && logsExpanded && (
          <div className="pl-4 mt-0.5 space-y-0.5">
            {LOGS_SUBITEMS.map(({ key, label }) => {
              const active = effectiveTab === key;
              return (
                <button
                  key={key}
                  onClick={() => goTo(key)}
                  className={`w-full text-left pl-6 pr-3 py-2 rounded-lg text-xs font-medium transition-all border-l-2 ${
                    active
                      ? 'border-current'
                      : 'border-transparent text-slate-400 hover:text-slate-700 hover:bg-slate-50'
                  }`}
                  style={active ? { color: BRAND, borderColor: BRAND, backgroundColor: BRAND_SOFT } : undefined}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}

        <div className="h-px bg-slate-100 my-2.5 mx-1.5" />

        {/* Settings group */}
        <button
          ref={settingsBtnRef}
          onClick={onSettingsClick}
          title={collapsed ? 'ตั้งค่าเงื่อนไข & กฎ' : undefined}
          aria-haspopup={collapsed ? 'menu' : undefined}
          aria-expanded={collapsed ? settingsFlyoutTop !== null : settingsExpanded}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition-all ${
            collapsed ? 'justify-center' : ''
          } ${activeTab === 'settings' ? '' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'}`}
          style={activeTab === 'settings' ? { backgroundColor: BRAND_SOFT_STRONG, color: BRAND } : undefined}
        >
          <Sliders className="w-[18px] h-[18px] shrink-0" />
          {!collapsed && (
            <>
              <span className="whitespace-nowrap flex-1 text-left">ตั้งค่าเงื่อนไข & กฎ</span>
              <ChevronDown
                className={`w-3.5 h-3.5 shrink-0 transition-transform ${settingsExpanded ? '' : '-rotate-90'}`}
              />
            </>
          )}
        </button>

        {!collapsed && settingsExpanded && (
          <div className="pl-4 mt-0.5 space-y-0.5">
            {SETTINGS_SUBITEMS.map(({ key, label }) => {
              const active = activeTab === 'settings' && subTab === key;
              return (
                <button
                  key={key}
                  onClick={() => goToSubTab(key)}
                  className={`w-full text-left pl-6 pr-3 py-2 rounded-lg text-xs font-medium transition-all border-l-2 ${
                    active
                      ? 'border-current'
                      : 'border-transparent text-slate-400 hover:text-slate-700 hover:bg-slate-50'
                  }`}
                  style={active ? { color: BRAND, borderColor: BRAND, backgroundColor: BRAND_SOFT } : undefined}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
          </>
        )}
      </nav>

      {/* User / logout — single row */}
      <div className="border-t border-slate-200 p-2.5 shrink-0">
        <div
          className={`flex items-center rounded-xl ${
            collapsed ? 'flex-col gap-1.5 py-1' : 'gap-2.5 px-2 py-2'
          }`}
        >
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
            style={{ backgroundColor: BRAND_SOFT, color: BRAND }}
          >
            <UserIcon className="w-4 h-4" />
          </div>
          {!collapsed && (
            <div className="text-left overflow-hidden flex-1 min-w-0">
              <p className="text-xs font-semibold text-slate-800 truncate">{user?.name || 'Administrator'}</p>
              <p className="text-[9px] text-slate-400 font-medium uppercase tracking-wider flex items-center gap-1">
                <Shield className="w-2.5 h-2.5 shrink-0" />
                <span className="truncate">{user?.role || 'Admin'}</span>
              </p>
            </div>
          )}
          <button
            id="admin-change-password-btn"
            onClick={() => setChangePasswordOpen(true)}
            title="เปลี่ยนรหัสผ่าน"
            aria-label="เปลี่ยนรหัสผ่าน"
            className="flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-[var(--brand-fg)] hover:bg-[var(--brand)]/10 transition-all active:scale-[0.95] shrink-0"
          >
            <KeyRound className="w-4 h-4" />
          </button>
          <ThemeToggle />
          <button
            id="admin-logout-btn"
            onClick={() => logout()}
            title="ออกจากระบบ"
            aria-label="ออกจากระบบ"
            className="flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-all active:scale-[0.95] shrink-0"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 flex">
      {/* Desktop sidebar */}
      <aside
        className="hidden lg:block relative shrink-0 border-r border-slate-200 sticky top-0 h-screen transition-[width] duration-200"
        style={{ width: sidebarWidth }}
      >
        {SidebarContent}
        <button
          onClick={toggleCollapsed}
          className="absolute z-10 flex items-center justify-center w-8 h-8 rounded-full bg-card shadow-md hover:shadow-lg transition-all active:scale-90"
          style={{ top: 18, right: -12, border: `1.5px solid var(--brand-border-strong)`, color: BRAND }}
          aria-label={collapsed ? 'ขยาย sidebar' : 'ย่อ sidebar'}
        >
          {collapsed ? <ChevronsRight className="w-3.5 h-3.5" /> : <ChevronsLeft className="w-3.5 h-3.5" />}
        </button>

        {/* Flyout เลือก sub-tab ตอน sidebar ย่อ — portal ไป body เพื่อหนี stacking context ของ
            <aside sticky> (ไม่งั้น input ในเนื้อหาลอยทับ flyout); fixed เพราะ nav มี overflow-y-auto ที่ clip */}
        {collapsed && settingsFlyoutTop !== null && createPortal(
          <div
            ref={settingsFlyoutRef}
            role="menu"
            className="fixed z-[60] w-56 py-1.5 bg-card border border-slate-200 rounded-xl shadow-xl animate-fade-in"
            style={{ top: settingsFlyoutTop, left: sidebarWidth + 6 }}
          >
            <p className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
              ตั้งค่าเงื่อนไข & กฎ
            </p>
            {SETTINGS_SUBITEMS.map(({ key, label }) => {
              const active = activeTab === 'settings' && subTab === key;
              return (
                <button
                  key={key}
                  role="menuitem"
                  onClick={() => goToSubTab(key)}
                  className={`w-full text-left px-3 py-2 text-xs font-medium transition-colors ${
                    active ? '' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                  }`}
                  style={active ? { backgroundColor: BRAND_SOFT, color: BRAND } : undefined}
                >
                  {label}
                </button>
              );
            })}
          </div>,
          document.body
        )}
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-40">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 shadow-xl">{SidebarContent}</aside>
        </div>
      )}

      {/* Main column */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top bar */}
        {/* แถบบน = หัวเรื่องของหน้า + ปุ่ม action ของหน้านั้น (มาจาก <PageHeader /> ผ่าน portal)
            ตัดบรรทัด "PRIMUS ADMIN" ทิ้งเพราะซ้ำกับโลโก้บน sidebar และกินความสูงฟรี ๆ */}
        <header className="bg-card border-b border-slate-200 sticky top-0 z-30 min-h-14 flex items-center gap-3 px-4 sm:px-6 py-2 shrink-0">
          <button
            onClick={() => setMobileOpen(true)}
            className="lg:hidden flex items-center justify-center w-9 h-9 rounded-lg text-slate-500 hover:bg-slate-50 border border-slate-200 shrink-0"
            aria-label="เปิดเมนู"
          >
            <Menu className="w-4 h-4" />
          </button>
          <PageHeaderOutlet fallbackTitle={PAGE_TITLES[effectiveTab]} />
        </header>

        <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5 space-y-6">
          {effectiveTab === 'blacklist' ? (
            /* เมนูเดียวที่ role 'user' เข้าถึงได้ — admin ก็เข้าได้เหมือนกัน */
            <div className="animate-fade-in">
              <Blacklist />
            </div>
          ) : effectiveTab === 'quotations' ? (
            <div className="animate-fade-in">
              <Quotations />
            </div>
          ) : effectiveTab === 'apilogs' ? (
            <div className="animate-fade-in">
              <ApiLogs />
            </div>
          ) : effectiveTab === 'traffic' ? (
            <div className="animate-fade-in">
              <Traffic />
            </div>
          ) : effectiveTab === 'auditlogs' ? (
            <div className="animate-fade-in">
              <AuditLogs />
            </div>
          ) : effectiveTab === 'systemlogs' ? (
            <div className="animate-fade-in">
              <SystemLogs />
            </div>
          ) : effectiveTab === 'dashboard' ? (
            <div className="grid grid-cols-1 gap-6">
              {/* Welcome Card */}
              <div className="relative bg-gradient-to-br from-[var(--brand-fg)]/5 via-card to-card border border-slate-200 rounded-2xl p-4 sm:p-5 overflow-hidden shadow-sm">
                <div className="absolute top-0 right-0 w-56 h-56 bg-[var(--brand)]/5 rounded-full blur-[70px] pointer-events-none"></div>

                <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 relative z-10">
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                      style={{ backgroundColor: BRAND_SOFT, color: BRAND, borderColor: BRAND_BORDER, borderWidth: 1 }}
                    >
                      <LayoutDashboard className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[11px] font-semibold" style={{ color: BRAND }}>
                        ยินดีต้อนรับกลับสู่ระบบ
                      </p>
                      <h2 className="text-lg sm:text-xl font-extrabold text-slate-900 leading-tight truncate">
                        สวัสดี, คุณ {user?.name || 'แอดมิน'} 👋
                      </h2>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 text-xs">
                    <span className="flex items-center gap-1.5 font-semibold text-slate-700">
                      <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span>
                      ระบบเปิดใช้งานปกติ
                    </span>
                    <span className="text-slate-300">·</span>
                    <span className="text-slate-500">
                      สิทธิ์: <span className="font-semibold" style={{ color: BRAND }}>{user?.role}</span>
                    </span>
                  </div>
                </div>
              </div>

              {/* Summary count cards */}
              {statsError && (
                <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-red-700 text-sm">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{statsError}</span>
                </div>
              )}

              {/* Summary cards (left 2/3) + Sync panel (right 1/3) */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6 items-start">
                <div className="lg:col-span-2 grid grid-cols-2 sm:grid-cols-3 gap-4 sm:gap-6">
                  {SUMMARY_CARDS.map(({ key, label, unit, icon: Icon, onClick }) => {
                    const count = stats ? stats[key] : null;
                    return (
                      <button
                        key={key}
                        onClick={onClick}
                        className="text-left bg-card border border-slate-200 hover:border-[var(--brand-fg)]/40 rounded-2xl p-4 transition-all group cursor-pointer active:scale-[0.99] shadow-sm flex flex-col gap-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div
                            className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                            style={{ backgroundColor: BRAND_SOFT, color: BRAND }}
                          >
                            <Icon className="w-5 h-5" />
                          </div>
                          <div className="flex items-baseline gap-1">
                            {statsLoading || count === null ? (
                              <span className="inline-block w-10 h-7 rounded-md bg-slate-100 animate-pulse" />
                            ) : (
                              <span className="text-2xl font-extrabold text-slate-900 tabular-nums">
                                {count.toLocaleString('th-TH')}
                              </span>
                            )}
                            <span className="text-xs font-medium text-slate-400">{unit}</span>
                          </div>
                        </div>
                        <h3 className="text-sm font-semibold text-slate-600 group-hover:text-slate-900 transition-colors">
                          {label}
                        </h3>
                      </button>
                    );
                  })}
                </div>

                {/* Sync data panel (right 1/3) */}
                <div className="lg:col-span-1">
                  <SyncPanel />
                </div>
              </div>
            </div>
          ) : effectiveTab === 'promotions' ? (
            <div className="animate-fade-in">
              <Promotions />
            </div>
          ) : effectiveTab === 'salespersons' ? (
            <div className="animate-fade-in">
              <Salespersons />
            </div>
          ) : effectiveTab === 'users' ? (
            <div className="animate-fade-in">
              <Users />
            </div>
          ) : (
            <div className="animate-fade-in">
              {subTab === 'quotation' && <QuotationRules />}
              {subTab === 'optional' && <OptionalLinks />}
              {subTab === 'stock' && <StockRules />}
              {subTab === 'moq' && <ProductMoqRules />}
              {/* สองกฎคนละตาราง/คนละ endpoint แต่รวมหน้าเดียวกันเพราะแอดมินตั้งค่าทีเดียวจบ
                  อยากแยกหน้าเมื่อไหร่ก็ย้าย <CreditPolicy /> ไป subTab ใหม่ได้เลย
                  วางซ้าย-ขวาบนจอกว้าง (ทั้งคู่เป็นบล็อกแคบ max-w-3xl อยู่แล้ว) และเรียงบนลงล่างเมื่อจอแคบกว่า xl
                  ไม่ใส่ items-start เพื่อให้ grid ยืดสองคอลัมน์สูงเท่ากัน (ตัวหน้าเองจัดการ่วนที่ยืดด้วย flex-1) */}
              {subTab === 'shipping' && (
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                  <ShippingFee />
                  <CreditPolicy />
                </div>
              )}
            </div>
          )}

        </main>
      </div>

      {changePasswordOpen && <ChangePasswordModal onClose={() => setChangePasswordOpen(false)} />}
    </div>
  );
}

export default function AdminApp() {
  return (
    <AuthProvider>
      {/* ช่องหัวเรื่องบนแถบบนเป็น state ร่วมของทั้งแอป — วางไว้เหนือ AdminContent ที่เดียว */}
      <PageHeaderProvider>
        <AdminContent />
      </PageHeaderProvider>
    </AuthProvider>
  );
}