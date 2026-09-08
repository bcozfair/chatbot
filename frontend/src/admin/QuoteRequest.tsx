// ─────────────────────────────────────────────────────────────────────────────
//  หน้า "ขอใบเสนอราคา" — หน้าเดียวจบ (เฟส E · ขั้น 9′)
//  แผน: docs/plan-web-quote-request.md §0 (form-first) · ขั้น 9′
//
//  v5 ตัดการจำลองแชท LINE ทิ้งทั้งก้อน — หน้านี้ไม่มี Flex ไม่มีฟองแชท ไม่มี postback
//  มีแค่ 3 ส่วนเรียงลงมาในหน้าเดียว ไม่มีการเปลี่ยนหน้า:
//    ส่วนที่ 0  แถบตัวตนของใบ            → QuoteIssuerProfile.tsx
//    ส่วนที่ 1  ช่องวางข้อความ            → POST /api/admin/webquote/propose  (ยังไม่เขียน DB)
//    ส่วนที่ 2  ฟอร์มร่าง (หัวใจของ v5)   → POST /api/admin/webquote/drafts   → โหมดแก้ใบร่าง
//    ส่วนที่ 3  revise จากเลขที่ใบ        → POST /api/admin/webquote/revise
//
//  ความกำกวมทั้งหมด (บริษัทซ้ำ · รุ่นกำกวม · รุ่นพิมพ์ผิด) ถูกเคาะในฟอร์ม **ก่อน** สร้างร่าง
//  ⇒ ไม่มี state `pending_product`/`pending_company` ใน DB จากเส้นทางนี้เลย
//
//  ขั้นตอนหลังได้ร่างแล้วใช้ endpoint เดิมของ LIFF ทั้งหมด (PUT/confirm/cancel) ซึ่งตรวจสิทธิ์
//  ด้วย `userId` ใน body ⇒ ต้องแนบ `web_user_id` ที่ได้จาก /drafts ไปทุกครั้ง (ขั้น 8′)
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { PageHeader } from './PageHeader';
import { QuoteIssuerProfile } from './QuoteIssuerProfile';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Ban,
  CheckCircle2,
  FilePlus2,
  FileText,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Search,
  Trash2,
  X,
} from 'lucide-react';

const BRAND = 'var(--brand-fg)';

// ── รูปร่างข้อมูลที่ backend ส่งมา ───────────────────────────────────────────

interface Candidate {
  model: string;
  sales_price: number | string;
  quantity_on_hand_unreserved: number | string;
  product_template_id: number;
  name: string;
  brand?: string;
  series?: string;
  production?: string;
}

interface Slot {
  resolved: boolean;
  itemForDb?: Record<string, unknown>;
  item?: Record<string, unknown>;
  candidates?: Candidate[];
}

interface Scored<T> {
  item: T;
  score: number;
}

interface CustomerRow {
  id: number;
  display_name: string;
  reference?: string | null;
  // เครดิตมาจาก 2 ต้นทางที่ตั้งชื่อคอลัมน์ไม่ตรงกัน และหน้านี้ใช้ทั้งคู่ในลิสต์เดียว:
  //   · `/api/customers/search`  → `payment_terms`          (ADMIN_COMPANY_SUBQ alias ไว้)
  //   · candidates จาก /propose → `customer_payment_terms`  (CDV_COMPANY_SUBQ ไม่ alias)
  // อ่านตัวเดียวจะได้ "—" ครึ่งหนึ่งของเคส จึงต้องรับทั้งสองชื่อ
  payment_terms?: string | null;
  customer_payment_terms?: string | null;
}

interface ContactRow {
  id: number;
  name: string;
  phone?: string | null;
  email?: string | null;
}

interface ProposeResult {
  web_user_id: string;
  intent: string;
  extraction_failed: boolean;
  reply_message: string | null;
  quote_data: Record<string, unknown> | null;
  slots: Slot[];
  unresolved_count: number;
  customer_candidates: Scored<CustomerRow>[];
  contact_candidates: Scored<ContactRow>[];
}

interface QuoteItem {
  product_id: number | null;
  model: string;
  name: string;
  quantity: number;
  price: number;
  discount_1: number;
  discount_2: number;
  is_shipping_fee?: boolean;
}

interface Quote {
  id: string;
  status: string;
  quotation_no: string | null;
  total_sum: number | string;
  customer_name: string;
  company_name: string;
  contact_name: string;
  quote_company?: string;
  items: QuoteItem[];
}

// ── แถวในตารางสินค้าของฟอร์ม (ก่อนสร้างร่าง) ────────────────────────────────

type RowStatus = 'ok' | 'ambiguous' | 'notfound';

interface Row {
  key: string;
  productTemplateId: number | null;
  model: string;
  name: string;
  /** เก็บเป็น string เพื่อให้ลบทั้งช่องแล้วพิมพ์ใหม่ได้ (เหมือนหน้าตั้งค่าอื่นในระบบ) */
  quantity: string;
  price: string;
  disc1: string;
  disc2: string;
  candidates: Candidate[];
  status: RowStatus;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const money = (v: unknown): string =>
  num(v).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** ยอดรวมของแถว — ตรรกะเดียวกับ calcNetPrice ฝั่ง server (แสดงผลอย่างเดียว server ตัดสินจริงเสมอ) */
const rowTotal = (r: Row): number =>
  num(r.quantity) * num(r.price) * (1 - num(r.disc1) / 100) * (1 - num(r.disc2) / 100);

let rowSeq = 0;
const newKey = () => `r${++rowSeq}`;

function rowsFromSlots(slots: Slot[], quoteData: Record<string, unknown> | null): Row[] {
  const billD1 = quoteData ? String(num(quoteData.discount_1) || '') : '';
  const billD2 = quoteData ? String(num(quoteData.discount_2) || '') : '';
  return slots.map((s) => {
    if (s.resolved && s.itemForDb) {
      const it = s.itemForDb as Record<string, unknown>;
      return {
        key: newKey(),
        productTemplateId: num(it.product_id) || null,
        model: String(it.model ?? ''),
        name: String(it.name ?? ''),
        quantity: String(num(it.quantity) || 1),
        price: String(num(it.price)),
        disc1: String(num(it.discount_1) || ''),
        disc2: String(num(it.discount_2) || ''),
        candidates: [],
        status: 'ok' as RowStatus,
      };
    }
    const raw = (s.item ?? {}) as Record<string, unknown>;
    const cands = s.candidates ?? [];
    return {
      key: newKey(),
      productTemplateId: null,
      model: String(raw.model ?? raw.product_code ?? ''),
      name: '',
      quantity: String(num(raw.quantity) || 1),
      price: '',
      // ส่วนลดตั้งต้นตามกติกาเดียวกับตอนสกัด: ระบุรายบรรทัดมา = ใช้ของบรรทัด ไม่งั้นใช้ของท้ายบิล
      disc1: String(num(raw.discount_1) || '') || billD1,
      disc2: String(num(raw.discount_1) || '') ? String(num(raw.discount_2) || '') : billD2,
      candidates: cands,
      status: (cands.length > 0 ? 'ambiguous' : 'notfound') as RowStatus,
    };
  });
}

// ── ช่องค้นหาสินค้าแบบกะทัดรัดสำหรับ "ในแถวตาราง" ───────────────────────────
//  ไม่ใช้ ProductComboBox ของหน้าตั้งค่า เพราะตัวนั้นเป็นฟิลด์เต็มความสูง 44px พร้อม label
//  ซึ่งวางในเซลล์ตารางไม่ได้ และไม่คืนราคามาให้ (แถวนี้ต้องเติมราคาตั้งต้นทันทีที่เลือก)

interface SearchHit {
  product_id: number;
  model: string;
  name: string;
  price: number | string;
  stock?: number | string;
}

const ProductPickerCell: React.FC<{ initialQuery: string; onPick: (hit: SearchHit) => void }> = ({
  initialQuery,
  onPick,
}) => {
  const [query, setQuery] = useState(initialQuery);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/products/search?q=${encodeURIComponent(q)}&limit=12`);
        const data = res.ok ? await res.json() : [];
        setHits(Array.isArray(data) ? data : []);
        setOpen(true);
      } catch {
        setHits([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (boxRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  return (
    <div className="relative" ref={boxRef}>
      <div className="flex items-center gap-1.5 h-9 px-2.5 rounded-lg border border-red-300 bg-card">
        <Search className="w-3.5 h-3.5 text-red-400 shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => hits.length > 0 && setOpen(true)}
          placeholder="ค้นหารุ่นที่ถูกต้อง..."
          className="flex-1 bg-transparent outline-none text-xs text-slate-800 placeholder:text-slate-400 min-w-0"
        />
        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
      </div>
      {open && hits.length > 0 && (
        <div className="absolute z-40 mt-1 w-[320px] max-w-[80vw] bg-card border border-slate-200 rounded-xl shadow-xl max-h-56 overflow-y-auto divide-y divide-slate-100">
          {hits.map((h) => (
            <button
              key={h.product_id}
              type="button"
              onClick={() => {
                onPick(h);
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 hover:bg-slate-50 flex flex-col gap-0.5"
            >
              <span className="text-xs font-semibold text-slate-800">{h.model}</span>
              <span className="text-[11px] text-slate-500 line-clamp-1">{h.name}</span>
              <span className="text-[11px] text-slate-400">
                ฿{money(h.price)} · คงเหลือ {money(h.stock ?? 0)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// ── ช่องตัวเลขของตารางใบร่าง ────────────────────────────────────────────────
//  ตารางฟอร์ม (ส่วนที่ 2) เก็บค่าเป็น string อยู่แล้ว แต่ใบร่างที่โหลดจาก server เป็นตัวเลขจริง
//  ถ้าแปลงกลับเป็นตัวเลขทุกครั้งที่พิมพ์ จะเกิด 2 อาการที่ทำให้แก้ราคาไม่ได้จริง:
//    · พิมพ์ "1250.5" ไม่ได้ — จุดทศนิยมถูกตัดทิ้งทันทีที่พิมพ์ ("1250." → 1250 → "1250")
//    · ลบทั้งช่องเพื่อพิมพ์ใหม่ไม่ได้ — ช่องว่างเด้งกลับเป็น "0"
//  จึงเก็บ "สิ่งที่พิมพ์" ไว้ในตัวเอง แล้วส่งออกเป็นตัวเลขให้ผู้เรียกทุกครั้งที่เปลี่ยน
const NumCell: React.FC<{ value: number; disabled?: boolean; onCommit: (n: number) => void }> = ({
  value,
  disabled,
  onCommit,
}) => {
  const [text, setText] = useState(() => String(value ?? ''));
  const textRef = useRef(text);
  useEffect(() => { textRef.current = text; }, [text]);

  // ค่าจริงเปลี่ยนจากข้างนอก (โหลดใบกลับมาใหม่หลังบันทึก) → ทับสิ่งที่พิมพ์ค้างไว้
  // เทียบกันเป็น "ตัวเลข" ไม่ใช่ข้อความ ไม่งั้น "12." ที่กำลังพิมพ์อยู่จะถูกเขียนทับทุก re-render
  useEffect(() => {
    if (num(textRef.current) !== num(value)) setText(String(value ?? ''));
  }, [value]);

  return (
    <input
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onCommit(num(e.target.value));
      }}
      inputMode="decimal"
      disabled={disabled}
      className="w-full h-9 px-2 rounded-lg border border-slate-200 bg-card text-xs text-right outline-none disabled:bg-slate-100"
    />
  );
};

// ── หน้าหลัก ─────────────────────────────────────────────────────────────────

export const QuoteRequest: React.FC = () => {
  const { token } = useAuth();
  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const [profileReady, setProfileReady] = useState(false);
  const [spUserId, setSpUserId] = useState('');
  const onReadyChange = useCallback((v: boolean) => setProfileReady(v), []);

  // ── ส่วนที่ 1 ──
  const [text, setText] = useState('');
  const [proposing, setProposing] = useState(false);
  const [proposeError, setProposeError] = useState('');
  const [systemBusy, setSystemBusy] = useState(false);

  // ── ส่วนที่ 2 ──
  const [webUserId, setWebUserId] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [aiMessage, setAiMessage] = useState('');
  const [customerOptions, setCustomerOptions] = useState<CustomerRow[]>([]);
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [customerQuery, setCustomerQuery] = useState('');
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [contactId, setContactId] = useState<number | null>(null);
  const [creatingDraft, setCreatingDraft] = useState(false);
  const [draftError, setDraftError] = useState('');

  // ── โหมดแก้ใบร่าง / ผลลัพธ์ ──
  const [quotes, setQuotes] = useState<Quote[] | null>(null);
  const [busyQuoteId, setBusyQuoteId] = useState<string | null>(null);
  const [quoteError, setQuoteError] = useState('');
  const [results, setResults] = useState<{ quotation_no: string; pdf_link: string }[]>([]);

  // ── ส่วนที่ 3 ──
  const [reviseNo, setReviseNo] = useState('');
  const [revising, setRevising] = useState(false);
  const [reviseError, setReviseError] = useState('');
  const [reviseFrom, setReviseFrom] = useState('');

  const selectedCustomer = customerOptions.find((c) => c.id === customerId) ?? null;

  // อ่าน customerId ล่าสุดจากใน effect ค้นหาได้โดยไม่ต้องยิงค้นใหม่ทุกครั้งที่เปลี่ยนบริษัท
  const customerIdRef = useRef<number | null>(null);
  useEffect(() => { customerIdRef.current = customerId; }, [customerId]);

  const resetAll = () => {
    setText('');
    setRows(null);
    setAiMessage('');
    setCustomerOptions([]);
    setCustomerId(null);
    setCustomerQuery('');
    setContacts([]);
    setContactId(null);
    setQuotes(null);
    setResults([]);
    setReviseFrom('');
    setProposeError('');
    setDraftError('');
    setQuoteError('');
    setSystemBusy(false);
  };

  /** อ่าน error ที่ backend ส่งมาเป็นข้อความจริง ไม่ใช่ "HTTP 400" ลอย ๆ */
  const readError = async (res: Response, fallback: string) => {
    const body = await res.json().catch(() => ({}));
    return String(body?.error || fallback);
  };

  // โหลดผู้ติดต่อทุกครั้งที่บริษัทเปลี่ยน — endpoint เดิมของ LIFF ใช้ได้ตรง ๆ (§0.3)
  useEffect(() => {
    if (customerId === null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/customer/${customerId}/contacts`);
        const data = res.ok ? await res.json() : [];
        if (cancelled) return;
        const list: ContactRow[] = Array.isArray(data) ? data : [];
        setContacts(list);
        // ผู้ติดต่อที่ระบบเดาไว้ให้อาจไม่มีในลิสต์ของบริษัทที่เลือก — findContactCandidates ค้นข้าม
        // ทุกรหัสสาขาของนิติบุคคลเดียวกัน คนที่ได้มาจึงอาจอยู่ใต้อีก company_id
        // ปล่อยค้างไว้ = dropdown ว่างแต่ปุ่ม "สร้างใบร่าง" กดได้ แล้วใบไปโผล่ผิดผู้ติดต่อ
        setContactId((cur) => (cur !== null && list.some((c) => c.id === cur) ? cur : null));
      } catch {
        if (!cancelled) setContacts([]);
      }
    })();
    return () => { cancelled = true; };
  }, [customerId]);

  // ค้นบริษัทเพิ่ม — หน่วง 300ms เท่ากับช่องค้นสินค้า ไม่งั้นยิงคิวรีทุกตัวอักษรที่พิมพ์
  useEffect(() => {
    const q = customerQuery.trim();
    if (!q) return;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/customers/search?q=${encodeURIComponent(q)}`);
        const data = res.ok ? await res.json() : [];
        if (!Array.isArray(data)) return;
        setCustomerOptions((prev) => {
          // บริษัทที่เลือกไว้ต้องอยู่ในลิสต์เสมอ ไม่งั้น <select> แสดงว่างทั้งที่ customerId ยังตั้งอยู่
          // (ผู้ใช้เห็น "ยังไม่เลือก" แต่ปุ่มสร้างร่างกดได้ = ออกใบให้บริษัทที่มองไม่เห็นบนจอ)
          const keep = prev.find((c) => c.id === customerIdRef.current);
          return keep && !data.some((c: CustomerRow) => c.id === keep.id) ? [keep, ...data] : data;
        });
      } catch {
        /* ค้นไม่ได้ = คงรายการเดิมไว้ ไม่ล้างของที่ผู้ใช้กำลังดูอยู่ */
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [customerQuery]);

  // ── ส่วนที่ 1: วางข้อความ → ร่าง ──
  const propose = async () => {
    if (!text.trim() || !spUserId) return;
    setProposing(true);
    setProposeError('');
    setSystemBusy(false);
    setQuoteError('');
    try {
      const res = await fetch('/api/admin/webquote/propose', {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sp_user_id: spUserId, text }),
      });
      if (!res.ok) throw new Error(await readError(res, 'สร้างร่างไม่สำเร็จ'));
      const data: ProposeResult = await res.json();

      setWebUserId(data.web_user_id);
      setQuotes(null);
      setResults([]);
      setReviseFrom('');

      if (data.extraction_failed) {
        // ไม่ล้างข้อความที่พิมพ์ไว้ — ผู้ใช้ต้องกดลองใหม่ได้ทันทีโดยไม่ต้องวางใหม่
        setSystemBusy(true);
        setRows(null);
        return;
      }
      if (!data.slots || data.slots.length === 0) {
        setRows(null);
        setAiMessage(data.reply_message || 'ระบบอ่านข้อความนี้เป็นคำสั่งขอใบเสนอราคาไม่ได้');
        return;
      }

      setAiMessage('');
      setRows(rowsFromSlots(data.slots, data.quote_data));

      const custs = data.customer_candidates.map((c) => c.item);
      // ชื่อบริษัทซ้ำกันได้หลายรหัส — ตัดซ้ำด้วย id ไม่ใช่ชื่อ
      const seen = new Set<number>();
      const uniq = custs.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
      setCustomerOptions(uniq);
      // เจอตัวเดียว = เลือกให้เลย · หลายตัว = ปล่อยว่างแล้วไฮไลต์ว่าต้องเคาะ (ขั้น 9′)
      setCustomerId(uniq.length === 1 ? uniq[0].id : null);
      setContactId(
        uniq.length === 1 && data.contact_candidates.length === 1 ? data.contact_candidates[0].item.id : null
      );
      setCustomerQuery('');
    } catch (e) {
      setProposeError(e instanceof Error ? e.message : 'สร้างร่างไม่สำเร็จ');
    } finally {
      setProposing(false);
    }
  };

  // ── ส่วนที่ 2: ตารางสินค้า ──
  const patchRow = (key: string, patch: Partial<Row>) =>
    setRows((rs) => (rs ? rs.map((r) => (r.key === key ? { ...r, ...patch } : r)) : rs));

  const pickCandidate = (key: string, c: Candidate) =>
    patchRow(key, {
      productTemplateId: c.product_template_id,
      model: c.model,
      name: c.name,
      price: String(num(c.sales_price)),
      candidates: [],
      status: 'ok',
    });

  const addRow = () =>
    setRows((rs) => [
      ...(rs ?? []),
      { key: newKey(), productTemplateId: null, model: '', name: '', quantity: '1', price: '', disc1: '', disc2: '', candidates: [], status: 'notfound' },
    ]);

  const removeRow = (key: string) => setRows((rs) => (rs ? rs.filter((r) => r.key !== key) : rs));

  const unresolved = (rows ?? []).filter((r) => r.status !== 'ok').length;
  const formTotal = (rows ?? []).reduce((sum, r) => sum + (r.status === 'ok' ? rowTotal(r) : 0), 0);
  const canCreateDraft =
    !!rows && rows.length > 0 && unresolved === 0 && customerId !== null && contactId !== null && !creatingDraft;

  const createDraft = async () => {
    if (!canCreateDraft || !rows) return;
    setCreatingDraft(true);
    setDraftError('');
    try {
      const res = await fetch('/api/admin/webquote/drafts', {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sp_user_id: spUserId,
          customer_id: customerId,
          contact_id: contactId,
          items: rows.map((r) => ({
            product_template_id: r.productTemplateId,
            model: r.model,
            quantity: num(r.quantity) || 1,
            price: num(r.price) || null,
            discount_1: num(r.disc1) || 0,
            discount_2: num(r.disc2) || 0,
          })),
        }),
      });
      if (!res.ok) throw new Error(await readError(res, 'สร้างร่างไม่สำเร็จ'));
      const data = await res.json();
      setWebUserId(data.web_user_id);
      setQuotes(data.quotes as Quote[]);
      setRows(null);
    } catch (e) {
      setDraftError(e instanceof Error ? e.message : 'สร้างร่างไม่สำเร็จ');
    } finally {
      setCreatingDraft(false);
    }
  };

  // ── โหมดแก้ใบร่าง (ใช้ endpoint เดิมของ LIFF ทั้งหมด) ──
  const reloadQuotes = async (ids: string[]) => {
    const res = await fetch(`/api/quotations?ids=${ids.join(',')}`);
    if (!res.ok) throw new Error('โหลดใบเสนอราคาไม่สำเร็จ');
    return (await res.json()) as Quote[];
  };

  const patchQuoteItem = (quoteId: string, idx: number, patch: Partial<QuoteItem>) =>
    setQuotes((qs) =>
      qs
        ? qs.map((q) =>
            q.id === quoteId ? { ...q, items: q.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)) } : q
          )
        : qs
    );

  const removeQuoteItem = (quoteId: string, idx: number) =>
    setQuotes((qs) =>
      qs ? qs.map((q) => (q.id === quoteId ? { ...q, items: q.items.filter((_, i) => i !== idx) } : q)) : qs
    );

  const saveQuote = async (q: Quote) => {
    setBusyQuoteId(q.id);
    setQuoteError('');
    try {
      const total = q.items.reduce(
        (s, it) => s + num(it.quantity) * num(it.price) * (1 - num(it.discount_1) / 100) * (1 - num(it.discount_2) / 100),
        0
      );
      const res = await fetch(`/api/quotation/${q.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // userId = web_user_id เท่านั้น — isQuotationOwner ฝั่ง server เทียบกับเจ้าของใบ (ขั้น 8′)
        body: JSON.stringify({ items: q.items, total_sum: total, userId: webUserId }),
      });
      if (!res.ok) throw new Error(await readError(res, 'บันทึกไม่สำเร็จ'));
      const fresh = await reloadQuotes((quotes ?? []).map((x) => x.id));
      setQuotes(fresh);
    } catch (e) {
      setQuoteError(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ');
    } finally {
      setBusyQuoteId(null);
    }
  };

  const confirmQuote = async (q: Quote) => {
    setBusyQuoteId(q.id);
    setQuoteError('');
    try {
      const res = await fetch(`/api/quotation/${q.id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: webUserId }),
      });
      if (!res.ok) throw new Error(await readError(res, 'ยืนยันไม่สำเร็จ'));
      const body = await res.json();
      setResults((r) => [...r, { quotation_no: body.quotation_no, pdf_link: body.pdf_link }]);
      const fresh = await reloadQuotes((quotes ?? []).map((x) => x.id));
      setQuotes(fresh);
    } catch (e) {
      setQuoteError(e instanceof Error ? e.message : 'ยืนยันไม่สำเร็จ');
    } finally {
      setBusyQuoteId(null);
    }
  };

  const cancelQuote = async (q: Quote) => {
    setBusyQuoteId(q.id);
    setQuoteError('');
    try {
      const res = await fetch(`/api/quotation/${q.id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: webUserId }),
      });
      if (!res.ok) throw new Error(await readError(res, 'ยกเลิกไม่สำเร็จ'));
      const fresh = await reloadQuotes((quotes ?? []).map((x) => x.id));
      setQuotes(fresh);
    } catch (e) {
      setQuoteError(e instanceof Error ? e.message : 'ยกเลิกไม่สำเร็จ');
    } finally {
      setBusyQuoteId(null);
    }
  };

  // ── ส่วนที่ 3: revise ──
  const doRevise = async () => {
    if (!reviseNo.trim() || !spUserId) return;
    setRevising(true);
    setReviseError('');
    try {
      const res = await fetch('/api/admin/webquote/revise', {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sp_user_id: spUserId, quotation_no: reviseNo }),
      });
      if (!res.ok) throw new Error(await readError(res, 'เตรียมใบแก้ไขไม่สำเร็จ'));
      const data = await res.json();
      setWebUserId(data.web_user_id);
      setQuotes(data.quotes as Quote[]);
      setReviseFrom(data.revise_from);
      setRows(null);
      setResults([]);
      setText('');
    } catch (e) {
      setReviseError(e instanceof Error ? e.message : 'เตรียมใบแก้ไขไม่สำเร็จ');
    } finally {
      setRevising(false);
    }
  };

  const blocked = !profileReady;

  return (
    <div className="space-y-5">
      <PageHeader icon={FilePlus2} title="ขอใบเสนอราคา" description="วางข้อความ → เคาะในฟอร์ม → ยืนยัน">
        {(rows || quotes) && (
          <button
            onClick={resetAll}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            เริ่มใหม่
          </button>
        )}
      </PageHeader>

      {/* ── ส่วนที่ 0 — แถบตัวตนของใบ ── */}
      <QuoteIssuerProfile spUserId={spUserId} onSpUserIdChange={setSpUserId} onReadyChange={onReadyChange} />

      {/* ── ส่วนที่ 1 — ช่องพิมพ์ข้อความ ── */}
      <div className={`bg-card border border-slate-200 rounded-2xl shadow-sm p-4 space-y-3 ${blocked ? 'opacity-50 pointer-events-none' : ''}`}>
        <div className="flex items-center gap-2">
          <FileText className="w-[18px] h-[18px]" style={{ color: BRAND }} />
          <h3 className="text-sm font-bold text-slate-800">วางข้อความขอใบเสนอราคา</h3>
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={7}
          placeholder={'เสนอราคา\nบริษัท ...\nคุณ ...\nรุ่นสินค้า = จำนวน\nลด 30%'}
          className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3 text-sm text-slate-800 outline-none focus:border-[var(--brand-fg)] focus:bg-card resize-y font-mono"
        />
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={propose}
            disabled={!text.trim() || !spUserId || proposing}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ backgroundColor: BRAND }}
          >
            {proposing ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
            {proposing ? 'กำลังสกัดคำสั่ง...' : 'สร้างร่าง'}
          </button>
          {!spUserId && <span className="text-xs text-amber-700">เลือกพนักงานขายที่จะออกใบในนามก่อน</span>}
          {proposing && <span className="text-xs text-slate-400">ระบบมีเวลาสกัดสูงสุด 60 วินาที</span>}
        </div>

        {systemBusy && (
          <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-sm text-red-700">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-semibold">ระบบไม่ว่างชั่วคราว</p>
              <p className="text-xs">ข้อความที่พิมพ์ไว้ยังอยู่ครบ กด “สร้างร่าง” อีกครั้งได้เลย</p>
            </div>
          </div>
        )}
        {proposeError && (
          <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-xs text-red-700">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
            <span>{proposeError}</span>
          </div>
        )}
        {aiMessage && (
          <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
            <span>{aiMessage}</span>
          </div>
        )}
      </div>

      {/* ── ส่วนที่ 2 — ฟอร์มร่าง ── */}
      {rows && (
        <div className="bg-card border border-slate-200 rounded-2xl shadow-sm p-4 space-y-4">
          <h3 className="text-sm font-bold text-slate-800">ตรวจและเคาะรายละเอียด</h3>

          {/* หัวฟอร์ม */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider">
                บริษัท / ลูกค้า
              </label>
              <select
                value={customerId ?? ''}
                onChange={(e) => {
                  setCustomerId(e.target.value ? Number(e.target.value) : null);
                  setContactId(null);
                }}
                className={`w-full h-11 px-3 rounded-xl border text-sm outline-none ${
                  customerId === null ? 'border-amber-400 bg-amber-50' : 'border-slate-200 bg-slate-50'
                }`}
              >
                <option value="">— เลือกบริษัท —</option>
                {customerOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.display_name}
                    {c.reference ? ` [${c.reference}]` : ''}
                  </option>
                ))}
              </select>
              <div className="flex items-center gap-1.5 h-9 px-2.5 rounded-lg border border-slate-200 bg-card">
                <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                <input
                  value={customerQuery}
                  onChange={(e) => setCustomerQuery(e.target.value)}
                  placeholder="ค้นหาบริษัทเพิ่มเติม..."
                  className="flex-1 bg-transparent outline-none text-xs text-slate-800 placeholder:text-slate-400 min-w-0"
                />
              </div>
              {customerId === null && (
                <p className="text-[11px] text-amber-700">พบบริษัทใกล้เคียงหลายราย — ต้องเลือกก่อนสร้างร่าง</p>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider">ผู้ติดต่อ</label>
              <select
                value={contactId ?? ''}
                onChange={(e) => setContactId(e.target.value ? Number(e.target.value) : null)}
                disabled={customerId === null}
                className={`w-full h-11 px-3 rounded-xl border text-sm outline-none disabled:opacity-50 ${
                  contactId === null ? 'border-amber-400 bg-amber-50' : 'border-slate-200 bg-slate-50'
                }`}
              >
                <option value="">— เลือกผู้ติดต่อ —</option>
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.phone ? ` · ${c.phone}` : ''}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-slate-500">
                เครดิต:{' '}
                <span className="font-semibold text-slate-700">
                  {selectedCustomer?.payment_terms || selectedCustomer?.customer_payment_terms || '—'}
                </span>
                <span className="text-slate-300 mx-1.5">·</span>
                เงื่อนไขจัดส่ง: <span className="text-slate-600">ระบบคำนวณให้ตอนบันทึกร่าง</span>
              </p>
            </div>
          </div>

          {/* ตารางสินค้า — 1 แถวต่อ 1 slot เรียงตามที่พิมพ์เสมอ */}
          <div className="overflow-x-auto -mx-4 px-4">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
                  <th className="text-left py-2 w-8">#</th>
                  <th className="text-left py-2">สินค้า</th>
                  <th className="text-right py-2 w-20">จำนวน</th>
                  <th className="text-right py-2 w-28">ราคา/หน่วย</th>
                  <th className="text-right py-2 w-20">ลด 1 %</th>
                  <th className="text-right py-2 w-20">ลด 2 %</th>
                  <th className="text-right py-2 w-28">รวม</th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r, i) => (
                  <tr key={r.key} className={r.status === 'notfound' ? 'bg-red-50/60' : r.status === 'ambiguous' ? 'bg-amber-50/60' : ''}>
                    <td className="py-2 text-xs text-slate-400 align-top pt-4">{i + 1}</td>
                    <td className="py-2 pr-3 align-top">
                      {r.status === 'ok' ? (
                        <div className="pt-1.5">
                          <p className="font-semibold text-slate-800 text-sm">{r.model}</p>
                          <p className="text-[11px] text-slate-500 line-clamp-1">{r.name}</p>
                        </div>
                      ) : r.status === 'ambiguous' ? (
                        <div className="space-y-1">
                          <p className="text-[11px] text-amber-800">
                            “{r.model}” ตรงกับหลายรุ่น — เลือกรุ่นที่ถูกต้อง
                          </p>
                          <select
                            defaultValue=""
                            onChange={(e) => {
                              const c = r.candidates.find((x) => String(x.product_template_id) === e.target.value);
                              if (c) pickCandidate(r.key, c);
                            }}
                            className="w-full h-9 px-2.5 rounded-lg border border-amber-400 bg-card text-xs outline-none"
                          >
                            <option value="">— เลือกรุ่น —</option>
                            {r.candidates.map((c) => (
                              <option key={c.product_template_id} value={c.product_template_id}>
                                {c.model} · ฿{money(c.sales_price)} · คงเหลือ {money(c.quantity_on_hand_unreserved)}
                              </option>
                            ))}
                          </select>
                        </div>
                      ) : (
                        <div className="space-y-1">
                          <p className="text-[11px] text-red-700">
                            {r.model ? `ไม่พบรุ่น “${r.model}” ในระบบ` : 'ยังไม่ได้เลือกสินค้า'}
                          </p>
                          <ProductPickerCell
                            initialQuery={r.model}
                            onPick={(h) =>
                              patchRow(r.key, {
                                productTemplateId: h.product_id,
                                model: h.model,
                                name: h.name,
                                price: String(num(h.price)),
                                status: 'ok',
                                candidates: [],
                              })
                            }
                          />
                        </div>
                      )}
                    </td>
                    <td className="py-2 align-top">
                      <input
                        value={r.quantity}
                        onChange={(e) => patchRow(r.key, { quantity: e.target.value })}
                        inputMode="decimal"
                        className="w-full h-9 px-2 rounded-lg border border-slate-200 bg-card text-xs text-right outline-none"
                      />
                    </td>
                    <td className="py-2 pl-2 align-top">
                      <input
                        value={r.price}
                        onChange={(e) => patchRow(r.key, { price: e.target.value })}
                        inputMode="decimal"
                        placeholder="ราคาตั้ง"
                        disabled={r.status !== 'ok'}
                        className="w-full h-9 px-2 rounded-lg border border-slate-200 bg-card text-xs text-right outline-none disabled:bg-slate-100"
                      />
                    </td>
                    <td className="py-2 pl-2 align-top">
                      <input
                        value={r.disc1}
                        onChange={(e) => patchRow(r.key, { disc1: e.target.value })}
                        inputMode="decimal"
                        disabled={r.status !== 'ok'}
                        className="w-full h-9 px-2 rounded-lg border border-slate-200 bg-card text-xs text-right outline-none disabled:bg-slate-100"
                      />
                    </td>
                    <td className="py-2 pl-2 align-top">
                      <input
                        value={r.disc2}
                        onChange={(e) => patchRow(r.key, { disc2: e.target.value })}
                        inputMode="decimal"
                        disabled={r.status !== 'ok'}
                        className="w-full h-9 px-2 rounded-lg border border-slate-200 bg-card text-xs text-right outline-none disabled:bg-slate-100"
                      />
                    </td>
                    <td className="py-2 pl-2 text-right align-top pt-4 tabular-nums text-slate-800 font-semibold">
                      {r.status === 'ok' ? money(rowTotal(r)) : '—'}
                    </td>
                    <td className="py-2 text-right align-top pt-3">
                      <button
                        onClick={() => removeRow(r.key)}
                        className="w-7 h-7 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 flex items-center justify-center"
                        aria-label="ลบแถว"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={addRow}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
            >
              <Plus className="w-3.5 h-3.5" />
              เพิ่มแถวสินค้า
            </button>
            <div className="ml-auto text-sm">
              <span className="text-slate-500">ยอดรวม (ก่อน VAT/ค่าขนส่ง): </span>
              <span className="font-extrabold text-slate-900 tabular-nums">฿{money(formTotal)}</span>
            </div>
          </div>

          {unresolved > 0 && (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-xs text-amber-800">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
              <span>ยังมี {unresolved} รายการที่ยังไม่ได้เลือกสินค้า — เคาะให้ครบก่อนสร้างร่าง</span>
            </div>
          )}
          {draftError && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-xs text-red-700 whitespace-pre-wrap">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
              <span>{draftError}</span>
            </div>
          )}

          <button
            onClick={createDraft}
            disabled={!canCreateDraft}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ backgroundColor: BRAND }}
          >
            {creatingDraft ? <Loader2 className="w-4 h-4 animate-spin" /> : <FilePlus2 className="w-4 h-4" />}
            สร้างใบร่าง
          </button>
        </div>
      )}

      {/* ── โหมดแก้ใบร่าง ── */}
      {quotes && quotes.length > 0 && (
        <div className="space-y-4">
          {reviseFrom && (
            <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-600">
              <RotateCcw className="w-3.5 h-3.5" />
              กำลังแก้ไขจากใบเลขที่ <span className="font-semibold text-slate-800">{reviseFrom}</span>
            </div>
          )}
          {quoteError && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-xs text-red-700 whitespace-pre-wrap">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
              <span>{quoteError}</span>
            </div>
          )}

          {quotes.map((q) => {
            const busy = busyQuoteId === q.id;
            const done = q.status === 'confirmed';
            const cancelled = q.status === 'cancelled';
            return (
              <div key={q.id} className="bg-card border border-slate-200 rounded-2xl shadow-sm p-4 space-y-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h3 className="text-sm font-bold text-slate-800">
                    ใบร่าง {q.quote_company ? `(${q.quote_company})` : ''}
                  </h3>
                  <span className="text-xs text-slate-500">{q.company_name} · {q.contact_name}</span>
                  {done && (
                    <span className="flex items-center gap-1 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-2 py-0.5">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      ยืนยันแล้ว {q.quotation_no}
                    </span>
                  )}
                  {cancelled && (
                    <span className="flex items-center gap-1 text-xs font-semibold text-slate-600 bg-slate-100 border border-slate-200 rounded-lg px-2 py-0.5">
                      <Ban className="w-3.5 h-3.5" />
                      ยกเลิกแล้ว
                    </span>
                  )}
                </div>

                <div className="overflow-x-auto -mx-4 px-4">
                  <table className="w-full min-w-[760px] text-sm">
                    <thead>
                      <tr className="text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
                        <th className="text-left py-2">สินค้า</th>
                        <th className="text-right py-2 w-20">จำนวน</th>
                        <th className="text-right py-2 w-28">ราคา/หน่วย</th>
                        <th className="text-right py-2 w-20">ลด 1 %</th>
                        <th className="text-right py-2 w-20">ลด 2 %</th>
                        <th className="text-right py-2 w-28">รวม</th>
                        <th className="w-10"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {q.items.map((it, idx) => {
                        const locked = done || cancelled || !!it.is_shipping_fee;
                        const line =
                          num(it.quantity) * num(it.price) * (1 - num(it.discount_1) / 100) * (1 - num(it.discount_2) / 100);
                        return (
                          <tr key={`${q.id}-${idx}`}>
                            <td className="py-2 pr-3">
                              <p className="font-semibold text-slate-800 text-sm">{it.model}</p>
                              <p className="text-[11px] text-slate-500 line-clamp-1">{it.name}</p>
                            </td>
                            {(['quantity', 'price', 'discount_1', 'discount_2'] as const).map((field) => (
                              <td key={field} className="py-2 pl-2">
                                <NumCell
                                  value={num(it[field])}
                                  disabled={locked}
                                  onCommit={(n) => patchQuoteItem(q.id, idx, { [field]: n } as Partial<QuoteItem>)}
                                />
                              </td>
                            ))}
                            <td className="py-2 pl-2 text-right tabular-nums font-semibold text-slate-800">{money(line)}</td>
                            <td className="py-2 text-right">
                              {!locked && (
                                <button
                                  onClick={() => removeQuoteItem(q.id, idx)}
                                  className="w-7 h-7 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 flex items-center justify-center"
                                  aria-label="ลบรายการ"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-sm mr-auto">
                    <span className="text-slate-500">ยอดรวมที่บันทึกไว้: </span>
                    <span className="font-extrabold text-slate-900 tabular-nums">฿{money(q.total_sum)}</span>
                  </div>
                  {!done && !cancelled && (
                    <>
                      <button
                        onClick={() => saveQuote(q)}
                        disabled={busy}
                        className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      >
                        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                        บันทึก
                      </button>
                      <button
                        onClick={() => cancelQuote(q)}
                        disabled={busy}
                        className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50"
                      >
                        <Ban className="w-3.5 h-3.5" />
                        ยกเลิกใบนี้
                      </button>
                      <button
                        onClick={() => confirmQuote(q)}
                        disabled={busy}
                        className="flex items-center gap-1.5 text-xs font-semibold px-4 py-2 rounded-lg text-white disabled:opacity-50"
                        style={{ backgroundColor: BRAND }}
                      >
                        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                        ยืนยันออกเลขที่
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}

          {results.length > 0 && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-4 space-y-2">
              <p className="text-sm font-bold text-emerald-800">ออกใบเสนอราคาสำเร็จ</p>
              {results.map((r) => (
                <div key={r.quotation_no} className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="font-semibold text-slate-800 tabular-nums">{r.quotation_no}</span>
                  <a
                    href={r.pdf_link}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-emerald-300 text-emerald-800 hover:bg-emerald-100"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    เปิดไฟล์ PDF
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── ส่วนที่ 3 — revise ── */}
      <div className={`bg-card border border-slate-200 rounded-2xl shadow-sm p-4 space-y-3 ${blocked ? 'opacity-50 pointer-events-none' : ''}`}>
        <div className="flex items-center gap-2">
          <RotateCcw className="w-[18px] h-[18px]" style={{ color: BRAND }} />
          <h3 className="text-sm font-bold text-slate-800">แก้ไขใบที่ออกไปแล้ว (revise)</h3>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={reviseNo}
            onChange={(e) => setReviseNo(e.target.value)}
            placeholder="เลขที่ใบ เช่น QP-260705030"
            className="h-10 px-3 rounded-xl border border-slate-200 bg-slate-50 text-sm text-slate-800 outline-none focus:border-[var(--brand-fg)] focus:bg-card w-64"
          />
          <button
            onClick={doRevise}
            disabled={!reviseNo.trim() || !spUserId || revising}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            {revising ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
            เตรียมใบแก้ไข
          </button>
          <span className="text-xs text-slate-400">ใบที่ยังไม่มีเลขที่ (ร่าง) แก้แบบ revision ไม่ได้</span>
        </div>
        {reviseError && (
          <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-xs text-red-700">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
            <span>{reviseError}</span>
          </div>
        )}
      </div>
    </div>
  );
};
