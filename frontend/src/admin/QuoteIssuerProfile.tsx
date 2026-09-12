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
//
//  รูปร่างของ UI (เจ้าของสั่ง 2026-09-12 · รอบที่ 4): **แถวเดียว ไม่มีย่อ/กาง**
//  หนึ่งฝั่ง = [ป้ายบอกบทบาท] [ช่องเลือกชื่อที่ค้นหาได้ — มีเบอร์/รหัสอยู่ในช่อง] [กรอบลายเซ็น]
//  เบอร์และรหัสอยู่ "ในช่องเลือก" เพราะมันเป็นข้อเท็จจริงของชื่อที่เลือก ไม่ใช่ข้อมูลคนละชิ้น
//  ⇒ ข้อมูลทุกชิ้นโชว์จุดเดียว ไม่มีอะไรซ้ำกันสองที่ และไม่ต้องกดอะไรก่อนถึงจะแก้ได้
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { PersonComboBox, type PersonOption } from './PersonComboBox';
import { AlertTriangle, Loader2, Trash2, Upload, User, UserCog } from 'lucide-react';

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

/**
 * กรอบลายเซ็นในแถว — ย่อจากช่องบน PDF (180×50) ลง 80% **โดยคงอัตราส่วน 3.6:1 เป๊ะ**
 * ⇒ สัดส่วนที่เห็นตรงกับบนกระดาษ รูปที่ยาวเกินจนจะถูกย่อจนอ่านไม่ออกดูออกตั้งแต่ตอนอัป
 * ทั้งสองฝั่งต้องใช้ค่าเดียวกัน เพราะนี่คือจุดที่ตาใช้เทียบซ้าย–ขวา
 */
const SIG_FRAME =
  'relative w-[144px] h-[40px] shrink-0 rounded-xl border border-dashed border-slate-300 bg-slate-50 flex items-center justify-center overflow-hidden';
const SIG_BOX = 'max-h-[36px] max-w-[138px] object-contain';

export const QuoteIssuerProfile: React.FC<Props> = ({ spUserId, onSpUserIdChange, onReadyChange }) => {
  const { token } = useAuth();
  const [profile, setProfile] = useState<IssuerProfile | null>(null);
  const [makers, setMakers] = useState<Maker[]>([]);
  const [salespersons, setSalespersons] = useState<ActingSalesperson[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);

  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

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
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'โหลดข้อมูลไม่สำเร็จ');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token, loadAll, onReadyChange]);

  const selectedSp = salespersons.find((s) => s.user_id === spUserId) ?? null;
  /** รวมจำนวนบัญชีซ้ำที่ถูกยุบทิ้ง — อธิบายว่าทำไมรายชื่อสั้นกว่าที่เคยเห็น จึงไปอยู่ใต้รายชื่อ */
  const mergedTotal = salespersons.reduce((sum, s) => sum + (s.merged_count ?? 0), 0);

  // id ของฝั่งผู้จัดทำคือ "ชื่อ" เอง — endpoint นี้รับชื่อเป็นค่าที่บันทึก (§2.5b)
  const makerOptions: PersonOption[] = useMemo(
    () => makers.map((m) => ({ id: m.name, name: m.name, meta: m.phone ?? 'ไม่มีเบอร์' })),
    [makers],
  );
  const spOptions: PersonOption[] = useMemo(
    () =>
      salespersons.map((s) => ({
        id: s.user_id,
        name: s.name,
        meta: s.salesperson_id,
        // ค้นด้วยเบอร์ได้ แต่ไม่โชว์ในช่องแคบ ๆ — รหัสคือสิ่งที่คนในร้านใช้เรียกกัน
        keywords: s.phone,
      })),
    [salespersons],
  );

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

  const issuerName = profile?.employee_quotation_id ?? null;
  const issuerPhone = profile?.employee_quotation_phone ?? null;

  return (
    // ห้ามใส่ overflow-hidden — dropdown 70 ชื่อสูงกว่าการ์ด ถ้าคลิปจะเลือกชื่อท้าย ๆ ไม่ได้
    <div className="bg-card border border-slate-200 rounded-2xl shadow-sm">
      {/*
        สองฝั่ง = คนสองคนที่จะขึ้นกระดาษใบเดียวกัน (ล้อกับ PDF ที่มีช่องเซ็น 2 ช่องคู่กัน)
        เรียง "ผู้เสนอราคา → ออกในนาม" ลำดับเดียวกับบนใบ · จอแคบกว่า lg ซ้อนเป็นสองแถว
      */}
      <div className="grid grid-cols-1 lg:grid-cols-2">
        {/* ── ผู้เสนอราคา = ตัวแอดมินเอง (ชื่อและลายเซ็นแก้ได้ที่นี่) ── */}
        <div className="flex items-center gap-2.5 px-4 py-3 min-w-0">
          <UserCog className="w-[18px] h-[18px] shrink-0" style={{ color: BRAND }} />
          <span className="text-xs text-slate-400 shrink-0 hidden xl:block">ผู้เสนอราคา</span>

          <PersonComboBox
            value={issuerName ? { id: issuerName, name: issuerName, meta: issuerPhone ?? 'ไม่มีเบอร์' } : null}
            options={makerOptions}
            onPick={(o) => saveMaker(o.id)}
            placeholder="ตั้งชื่อผู้เสนอราคาก่อนออกใบ"
            emptyText="ไม่พบชื่อนี้ในรายการจาก Odoo"
            ariaLabel="ชื่อผู้เสนอราคา / ผู้จัดทำ"
            busy={saving}
            invalid={!profile?.is_ready}
            metaWarn={!issuerPhone}
          />

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
                  ลายเซ็น
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
                className="absolute top-0.5 right-0.5 w-5 h-5 rounded-md flex items-center justify-center text-slate-400 bg-card/80 hover:text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>

        {/* ── พนักงานขายที่ออกในนาม (ลายเซ็นของเขาแก้ที่นี่ไม่ได้ จึงเป็นกรอบอ่านอย่างเดียว) ── */}
        <div className="flex items-center gap-2.5 px-4 py-3 min-w-0 border-t lg:border-t-0 lg:border-l border-slate-100">
          <User className="w-[18px] h-[18px] shrink-0 text-slate-400" />
          <span className="text-xs text-slate-400 shrink-0 hidden xl:block">ออกในนาม</span>

          <PersonComboBox
            value={selectedSp ? { id: selectedSp.user_id, name: selectedSp.name, meta: selectedSp.salesperson_id } : null}
            options={spOptions}
            onPick={(o) => onSpUserIdChange(o.id)}
            placeholder="เลือกพนักงานขายที่จะออกใบในนาม"
            emptyText="ไม่พบพนักงานขายชื่อ/รหัสนี้"
            ariaLabel="พนักงานขายที่จะออกใบในนาม"
            invalid={!spUserId}
            footer={
              mergedTotal > 0 ? (
                <span>ยุบบัญชี LINE ที่ชื่อ/รหัสซ้ำกันออก {mergedTotal} บัญชี — เหลือบัญชีที่ใช้งานล่าสุด</span>
              ) : undefined
            }
          />

          <div className={SIG_FRAME} title={selectedSp && !selectedSp.sig_url ? 'ใบที่ออกจะไม่มีลายเซ็นช่อง “พนักงานขาย”' : undefined}>
            {selectedSp?.sig_url ? (
              <img src={selectedSp.sig_url} alt="ลายเซ็นพนักงานขาย" className={SIG_BOX} />
            ) : selectedSp ? (
              <span className="text-[11px] text-amber-700">ไม่มีลายเซ็น</span>
            ) : (
              <span className="text-[11px] text-slate-300">ลายเซ็น</span>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="mx-4 mb-3 flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-xs text-red-700">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
};
