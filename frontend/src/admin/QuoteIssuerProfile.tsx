// ─────────────────────────────────────────────────────────────────────────────
//  แถบตั้งค่าตัวตนของใบที่ออกจากหน้าเว็บ (เฟส E · ขั้น 9′ ส่วนที่ 0)
//  แผน: docs/plan-web-quote-request.md §2 (ตัวตนผู้เสนอราคา) · §2.5b (เบอร์)
//
//  ใบที่ออกจากหน้านี้มี "คนสองคน" อยู่บนกระดาษใบเดียวกัน และนี่คือที่เดียวที่ตั้งค่าทั้งคู่:
//    · พนักงานขาย        = เซลส์ที่แอดมิน "ออกในนาม" (เลือกใหม่ได้ทุกใบ)
//    · ผู้เสนอราคา/ผู้จัดทำ = ตัวแอดมินเอง (ตั้งครั้งเดียว จำไว้ แก้ได้ทีหลัง)
//
//  กติกาที่ห้ามเผลอทำกลับด้าน:
//    · ยังไม่ตั้ง "ชื่อผู้จัดทำ" = ออกใบไม่ได้เลย (is_ready:false → บล็อกทั้งหน้า)
//    · ยัง "ไม่มีลายเซ็น" = ออกใบได้ตามปกติ ขึ้นแค่ป้ายเตือน — เจ้าของเคาะไว้ 2026-09-08 (§2.8)
//    · เบอร์เป็นช่องอ่านอย่างเดียวเสมอ — server หาให้จากชื่อ (เบอร์ในใบล่าสุด) และเป็น path
//      เดียวที่เขียนคอลัมน์นั้น ⇒ ไม่มีทางที่ชื่อกับเบอร์บนใบจะเป็นของคนละคน
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  AlertTriangle,
  ChevronDown,
  Hash,
  Loader2,
  Phone,
  Search,
  Trash2,
  Upload,
  User,
  UserCog,
} from 'lucide-react';

const BRAND = 'var(--brand-fg)';

interface Maker {
  name: string;
  phone: string | null;
}

interface IssuerProfile {
  admin_id: number;
  name: string;
  role: string;
  employee_quotation_id: string | null;
  employee_quotation_phone: string | null;
  has_signature: boolean;
  signature_url: string | null;
  is_ready: boolean;
}

interface ActingSalesperson {
  user_id: string;
  name: string;
  salesperson_id: string | null;
  phone: string | null;
  has_sale_sig: boolean;
  sig_url: string | null;
  /** จำนวนบัญชี LINE ซ้ำที่ถูกยุบเข้าแถวนี้ (0 = ไม่มีซ้ำ) — ฝั่ง server ยุบมาให้แล้ว */
  merged_count?: number;
  /** ใช้งานล่าสุด (ISO) — เกณฑ์ที่ server ใช้เลือกบัญชีตัวแทน */
  last_active_at?: string | null;
}

interface Props {
  /** เซลส์ที่เลือก "ออกในนาม" — ว่าง = ยังไม่เลือก (หน้าแม่ใช้บล็อกปุ่มสร้างร่าง) */
  spUserId: string;
  onSpUserIdChange: (userId: string) => void;
  /** true เมื่อตั้งชื่อผู้จัดทำแล้ว — หน้าแม่ใช้บล็อกทั้งหน้าเมื่อยังไม่พร้อม */
  onReadyChange: (ready: boolean) => void;
}

/** กรอบพรีวิวลายเซ็นให้เท่ากับที่ PDF ใช้จริง — เห็นตั้งแต่ตอนอัปว่ารูปจะถูกย่อจนอ่านไม่ออกไหม */
const SIG_BOX = 'max-h-[50px] max-w-[180px] object-contain';

export const QuoteIssuerProfile: React.FC<Props> = ({ spUserId, onSpUserIdChange, onReadyChange }) => {
  const { token } = useAuth();
  const [profile, setProfile] = useState<IssuerProfile | null>(null);
  const [makers, setMakers] = useState<Maker[]>([]);
  const [salespersons, setSalespersons] = useState<ActingSalesperson[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // dropdown ชื่อผู้จัดทำ — 70 ชื่อ จึงต้องพิมพ์กรองได้ ไม่ใช่ <select> ยาวเหยียด
  const [makerOpen, setMakerOpen] = useState(false);
  const [makerQuery, setMakerQuery] = useState('');
  const makerBoxRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  // อ่านค่าล่าสุดของ spUserId ได้โดยไม่ต้องใส่ใน deps ของ effect โหลดข้อมูล
  // (ใส่ตรง ๆ = ยิง 3 endpoint ใหม่ทุกครั้งที่เปลี่ยนเซลส์)
  const spUserIdRef = useRef(spUserId);
  useEffect(() => { spUserIdRef.current = spUserId; }, [spUserId]);

  const loadAll = useCallback(async () => {
    const [meRes, makersRes, spRes] = await Promise.all([
      fetch('/api/admin/webquote/me', { headers: authHeaders }),
      fetch('/api/admin/webquote/makers', { headers: authHeaders }),
      fetch('/api/admin/webquote/salespersons', { headers: authHeaders }),
    ]);
    if (!meRes.ok || !makersRes.ok || !spRes.ok) throw new Error('โหลดข้อมูลผู้เสนอราคาไม่สำเร็จ');
    const me: IssuerProfile = await meRes.json();
    const mk = await makersRes.json();
    const sp = await spRes.json();
    return { me, makers: (mk.makers ?? []) as Maker[], salespersons: (sp.salespersons ?? []) as ActingSalesperson[] };
  }, [authHeaders]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await loadAll();
        if (cancelled) return;
        setProfile(data.me);
        setMakers(data.makers);
        setSalespersons(data.salespersons);
        onReadyChange(data.me.is_ready);
        // ยังตั้งค่าไม่ครบ = กางแถบทิ้งไว้เลย ไม่ต้องให้ไปกดหา
        // "ครบ" ต้องรวม **เซลส์ที่จะออกในนาม** ด้วย ไม่ใช่แค่ชื่อผู้จัดทำ — dropdown ตัวนั้นอยู่ใน
        // แถบที่ยุบอยู่ ถ้ายุบไว้ หน้าแม่จะขึ้นว่า "เลือกพนักงานขายก่อน" ทั้งที่ไม่มีช่องให้เลือก
        setExpanded(!data.me.is_ready || !spUserIdRef.current);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'โหลดข้อมูลไม่สำเร็จ');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, loadAll, onReadyChange]);

  // ปิด dropdown ชื่อเมื่อคลิกนอกพื้นที่
  useEffect(() => {
    if (!makerOpen) return;
    const onPointer = (e: MouseEvent) => {
      if (makerBoxRef.current?.contains(e.target as Node)) return;
      setMakerOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [makerOpen]);

  const selectedSp = salespersons.find((s) => s.user_id === spUserId) ?? null;
  /** รวมจำนวนบัญชีซ้ำที่ถูกยุบทิ้ง — ใช้บอกใต้ dropdown ว่าทำไมรายชื่อสั้นกว่าที่เคยเห็น */
  const mergedTotal = salespersons.reduce((sum, s) => sum + (s.merged_count ?? 0), 0);
  const filteredMakers = makerQuery.trim()
    ? makers.filter((m) => m.name.toLowerCase().includes(makerQuery.trim().toLowerCase()))
    : makers;

  const saveMaker = async (name: string) => {
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/admin/webquote/me', {
        method: 'PUT',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        // ส่งแค่ชื่อ — เบอร์ที่โชว์เป็นค่าที่ server จะเขียนให้ ไม่ได้ส่งกลับไป (§2.5b)
        body: JSON.stringify({ employee_quotation_id: name }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'บันทึกชื่อผู้จัดทำไม่สำเร็จ');
      setProfile((p) =>
        p ? { ...p, employee_quotation_id: body.employee_quotation_id, employee_quotation_phone: body.employee_quotation_phone, is_ready: true } : p
      );
      onReadyChange(true);
      setMakerOpen(false);
      setMakerQuery('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  };

  const uploadSignature = async (file: File) => {
    setSaving(true);
    setError('');
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('อ่านไฟล์รูปไม่สำเร็จ'));
        reader.readAsDataURL(file);
      });
      const res = await fetch('/api/admin/webquote/me/signature', {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'อัปโหลดลายเซ็นไม่สำเร็จ');
      // อัปทับใช้ key เดิม ⇒ URL เท่าเดิม ต้องต่อ cache-buster ไม่งั้นเบราว์เซอร์โชว์รูปเก่า
      setProfile((p) => (p ? { ...p, has_signature: true, signature_url: `${body.signature_url}?t=${Date.now()}` } : p));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'อัปโหลดไม่สำเร็จ');
    } finally {
      setSaving(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const deleteSignature = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/admin/webquote/me/signature', { method: 'DELETE', headers: authHeaders });
      if (!res.ok) throw new Error('ลบลายเซ็นไม่สำเร็จ');
      setProfile((p) => (p ? { ...p, has_signature: false, signature_url: null } : p));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ลบไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-card border border-slate-200 rounded-2xl px-4 py-3 flex items-center gap-2 text-sm text-slate-500">
        <Loader2 className="w-4 h-4 animate-spin" style={{ color: BRAND }} />
        กำลังโหลดโปรไฟล์ผู้เสนอราคา...
      </div>
    );
  }

  /**
   * แถวเนื้อหาของทั้งสองฝั่งสูงเท่ากันแบบตายตัว — ไม่ผูกกับว่ามีลายเซ็นไหม มีปุ่มลบไหม
   * มีเบอร์ไหม ⇒ การ์ดสองใบไม่ขยับตามข้อมูล และเส้นแบ่งกลางไม่มีวันเหลื่อม
   */
  const ROW_H = 'h-[74px]';
  /**
   * กรอบลายเซ็นซ้าย–ขวาต้องเท่ากันเป๊ะ เพราะมันคือจุดที่ตาใช้เทียบสองฝั่ง
   * กว้าง 190 = กว้างกว่า SIG_BOX (180) เล็กน้อย ⇒ ลายเซ็นที่เต็มขนาดจริงบน PDF ยังอยู่ในกรอบพอดี
   * ไม่ถูก overflow-hidden ครอบตัดจนดูเหมือนรูปเสีย
   */
  const SIG_FRAME =
    'relative w-[190px] h-[58px] shrink-0 rounded-xl border border-dashed border-slate-300 bg-slate-50 flex items-center justify-center overflow-hidden';
  const issuerName = profile?.employee_quotation_id ?? null;
  const issuerPhone = profile?.employee_quotation_phone ?? null;

  return (
    // ห้ามใส่ overflow-hidden — dropdown 70 ชื่อสูงกว่าการ์ด ถ้าคลิปจะเลือกชื่อท้าย ๆ ไม่ได้
    <div className="bg-card border border-slate-200 rounded-2xl shadow-sm">
      {/*
        แถบสรุปตัวตนของใบ — ค้างไว้ตลอดขณะพิมพ์ เพื่อไม่ให้ออกใบผิดชื่อโดยไม่รู้ตัว
        เรียง "ผู้เสนอราคา → ออกในนาม" ลำดับเดียวกับสองคอลัมน์ข้างล่าง และลายเซ็นย่อ
        เกาะอยู่กับเจ้าของมัน · ปุ่มขวาสุดเป็นปุ่มเดียวที่ย่อ/กางแถบนี้ (ไม่มีปุ่มย่อซ้ำที่อื่น)
      */}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex flex-1 flex-wrap items-center gap-x-4 gap-y-2 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <UserCog className="w-[18px] h-[18px] shrink-0" style={{ color: BRAND }} />
            <span className="text-xs text-slate-400 shrink-0">ผู้เสนอราคา</span>
            <span className={`text-sm font-semibold truncate ${issuerName ? 'text-slate-800' : 'text-amber-700'}`}>
              {issuerName ?? 'ยังไม่ตั้ง'}
            </span>
            {issuerPhone && <span className="text-sm text-slate-500 shrink-0">{issuerPhone}</span>}
            {profile?.signature_url && (
              <img
                src={profile.signature_url}
                alt="ลายเซ็นผู้เสนอราคา"
                className="h-6 max-w-[76px] object-contain shrink-0"
              />
            )}
          </div>

          <span className="hidden sm:block w-px h-5 bg-slate-200 shrink-0" aria-hidden="true" />

          <div className="flex items-center gap-2 min-w-0">
            <User className="w-[18px] h-[18px] shrink-0 text-slate-400" />
            <span className="text-xs text-slate-400 shrink-0">ออกในนาม</span>
            <span className={`text-sm font-semibold truncate ${selectedSp ? 'text-slate-800' : 'text-amber-700'}`}>
              {selectedSp ? selectedSp.name : 'ยังไม่เลือก'}
            </span>
            {selectedSp?.salesperson_id && (
              <span className="text-sm text-slate-500 shrink-0">{selectedSp.salesperson_id}</span>
            )}
          </div>
        </div>

        <button
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-fg)]/30"
        >
          {expanded ? 'ย่อ' : 'แก้ไข'}
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {/* เตือนเฉพาะเรื่องที่ "ออกใบไม่ได้" — ส่วนที่ดูเอาได้จากกรอบลายเซ็นไม่ต้องมีป้ายซ้ำ */}
      {!profile?.is_ready && (
        <div className="mx-4 mb-3 flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-xs text-amber-800">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
          <span>ยังไม่ได้ตั้งชื่อผู้เสนอราคา/ผู้จัดทำ — ต้องตั้งก่อนจึงจะออกใบได้</span>
        </div>
      )}
      {error && (
        <div className="mx-4 mb-3 flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-xs text-red-700">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
          <span>{error}</span>
        </div>
      )}

      {/*
        กาง = สองคอลัมน์ = คนสองคนที่จะขึ้นกระดาษใบเดียวกัน (ล้อกับ PDF ที่มีช่องเซ็น 2 ช่องคู่กัน)
        แต่ละฝั่ง = แถวเดียว: [ช่องเลือกชื่อ + เบอร์/รหัส] | [กรอบลายเซ็น]
        ⇒ ชื่อกับลายเซ็นของคนเดียวกันอยู่ระดับสายตาเดียวกัน และสองฝั่งสูงเท่ากันตายตัว
      */}
      {expanded && (
        <div className="border-t border-slate-100 grid grid-cols-1 lg:grid-cols-2">
          {/* ── ซ้าย: ผู้เสนอราคา = ตัวแอดมินเอง (แก้ชื่อและลายเซ็นได้ที่นี่) ── */}
          <section className="px-4 py-4 space-y-2.5">
            <h3 className="text-sm font-semibold text-slate-800">ผู้เสนอราคา / ผู้จัดทำ</h3>

            <div className={`flex items-start gap-3 ${ROW_H}`}>
              <div className="flex-1 min-w-0 space-y-1.5">
                <div className="relative" ref={makerBoxRef}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setMakerOpen(true)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setMakerOpen(true);
                      }
                    }}
                    className={`flex items-center gap-2 w-full h-11 px-3.5 rounded-xl border text-sm cursor-pointer transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-fg)]/30 ${
                      makerOpen
                        ? 'border-[var(--brand-fg)] ring-2 ring-[var(--brand-fg)]/10 bg-card'
                        : 'border-slate-200 bg-slate-50 hover:border-slate-300'
                    }`}
                  >
                    <Search className="w-4 h-4 text-slate-400 shrink-0" />
                    {makerOpen ? (
                      <input
                        autoFocus
                        value={makerQuery}
                        onChange={(e) => setMakerQuery(e.target.value)}
                        placeholder="พิมพ์ชื่อเพื่อค้นหา..."
                        className="flex-1 bg-transparent outline-none text-sm text-slate-800 placeholder:text-slate-400"
                      />
                    ) : (
                      <span className={`flex-1 truncate ${issuerName ? 'text-slate-800 font-semibold' : 'text-slate-400'}`}>
                        {issuerName ?? 'เลือกชื่อจากรายการ'}
                      </span>
                    )}
                    {saving ? (
                      <Loader2 className="w-4 h-4 animate-spin text-slate-400 shrink-0" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
                    )}
                  </div>

                  {makerOpen && (
                    <div className="absolute z-50 mt-1.5 w-full bg-card border border-slate-200 rounded-xl shadow-xl max-h-60 overflow-y-auto divide-y divide-slate-100">
                      {filteredMakers.length === 0 ? (
                        <div className="p-4 text-center text-xs text-slate-400">ไม่พบชื่อนี้ในรายการจาก Odoo</div>
                      ) : (
                        filteredMakers.map((m) => (
                          <button
                            key={m.name}
                            type="button"
                            onClick={() => saveMaker(m.name)}
                            className="w-full text-left px-4 py-2.5 text-sm hover:bg-slate-50 flex items-center justify-between gap-2"
                          >
                            <span className="font-medium text-slate-800 truncate">{m.name}</span>
                            <span className="text-xs text-slate-400 shrink-0">{m.phone ?? 'ไม่มีเบอร์'}</span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>

                {/* เบอร์ — อ่านอย่างเดียวเสมอ (§2.5b) · ไอคอนแทนคำว่า "เบอร์บนใบ" */}
                <p className="flex items-center gap-1.5 text-xs">
                  <Phone className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  {issuerPhone ? (
                    <span className="font-semibold text-slate-700">{issuerPhone}</span>
                  ) : issuerName ? (
                    <span className="text-amber-700">ชื่อนี้ไม่มีเบอร์ในระบบ</span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </p>
              </div>

              {/* ลายเซ็น: กรอบคือปุ่มอัปโหลดในตัว ⇒ ไม่ต้องมีปุ่มข้อความและคำอธิบายใต้กรอบ */}
              <div className={SIG_FRAME}>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) uploadSignature(f);
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={saving}
                  title={profile?.has_signature ? 'เปลี่ยนลายเซ็น (PNG/JPG)' : 'อัปโหลดลายเซ็น (PNG/JPG)'}
                  aria-label={profile?.has_signature ? 'เปลี่ยนลายเซ็น' : 'อัปโหลดลายเซ็น'}
                  className="w-full h-full flex items-center justify-center rounded-xl hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-fg)]/30 disabled:opacity-50"
                >
                  {profile?.signature_url ? (
                    <img src={profile.signature_url} alt="ลายเซ็นของฉัน" className={SIG_BOX} />
                  ) : (
                    <span className="flex items-center gap-1.5 text-[11px] text-slate-400">
                      <Upload className="w-3.5 h-3.5" />
                      อัปโหลดลายเซ็น
                    </span>
                  )}
                </button>
                {profile?.has_signature && (
                  <button
                    type="button"
                    onClick={deleteSignature}
                    disabled={saving}
                    title="ลบลายเซ็น"
                    aria-label="ลบลายเซ็น"
                    className="absolute top-1 right-1 w-6 h-6 rounded-lg flex items-center justify-center text-slate-400 bg-card/80 hover:text-red-600 hover:bg-red-50 disabled:opacity-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          </section>

          {/* ── ขวา: พนักงานขายที่ออกในนาม (ลายเซ็นของเขาแก้ที่นี่ไม่ได้ จึงเป็นกรอบอ่านอย่างเดียว) ── */}
          <section className="px-4 py-4 space-y-2.5 border-t lg:border-t-0 lg:border-l border-slate-100">
            <h3 className="flex items-baseline gap-2 text-sm font-semibold text-slate-800">
              ออกใบในนาม (พนักงานขาย)
              {mergedTotal > 0 && (
                <span
                  className="text-[11px] font-medium text-slate-400"
                  title={`ยุบบัญชี LINE ที่ชื่อ/รหัสซ้ำกันออก ${mergedTotal} บัญชี — ใช้บัญชีที่ใช้งานล่าสุด`}
                >
                  ยุบบัญชีซ้ำ {mergedTotal}
                </span>
              )}
            </h3>

            <div className={`flex items-start gap-3 ${ROW_H}`}>
              <div className="flex-1 min-w-0 space-y-1.5">
                <select
                  value={spUserId}
                  onChange={(e) => onSpUserIdChange(e.target.value)}
                  aria-label="พนักงานขายที่จะออกใบในนาม"
                  className="w-full h-11 px-3 rounded-xl border border-slate-200 bg-slate-50 text-sm text-slate-800 outline-none focus:border-[var(--brand-fg)] focus:bg-card"
                >
                  <option value="">— เลือกพนักงานขาย —</option>
                  {salespersons.map((s) => (
                    <option key={s.user_id} value={s.user_id}>
                      {s.name}
                      {s.salesperson_id ? ` (${s.salesperson_id})` : ''}
                    </option>
                  ))}
                </select>

                <p className="flex items-center gap-3 text-xs">
                  <span className="flex items-center gap-1.5 min-w-0">
                    <Phone className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <span className={selectedSp?.phone ? 'font-semibold text-slate-700 truncate' : 'text-slate-400'}>
                      {selectedSp?.phone ?? '—'}
                    </span>
                  </span>
                  {selectedSp?.salesperson_id && (
                    <span className="flex items-center gap-1 text-slate-400 shrink-0">
                      <Hash className="w-3.5 h-3.5" />
                      {selectedSp.salesperson_id}
                    </span>
                  )}
                </p>
              </div>

              <div className={SIG_FRAME}>
                {selectedSp?.sig_url ? (
                  <img src={selectedSp.sig_url} alt="ลายเซ็นพนักงานขาย" className={SIG_BOX} />
                ) : (
                  <span
                    className={`px-2 text-center text-[11px] ${selectedSp ? 'text-amber-700' : 'text-slate-400'}`}
                    title={selectedSp ? 'ใบที่ออกจะไม่มีลายเซ็นช่อง “พนักงานขาย”' : undefined}
                  >
                    {selectedSp ? 'ไม่มีลายเซ็น' : 'เลือกพนักงานขายก่อน'}
                  </span>
                )}
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
};
