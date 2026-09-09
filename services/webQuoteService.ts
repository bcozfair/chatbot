// ─────────────────────────────────────────────────────────────────────────────
//  webQuoteService — หลังบ้านของหน้าเว็บ "ขอใบเสนอราคา" (เฟส D)
//  แผน: docs/plan-web-quote-request.md ขั้น 3′ (§0.4 · §2.3 · §6.0)
//
//  ⚠️ กติกาเหล็กของไฟล์นี้:
//     * **ไม่แตะ handleEvent · ไม่ประกอบ Flex · ไม่มี replyToken** — คืน "ข้อมูลดิบ" ให้
//       frontend เรนเดอร์เอง ทุกอย่างที่เป็นรูปร่างของ LINE ห้ามหลุดเข้ามาในไฟล์นี้
//       (appendReviseFrom ที่ import จาก utils/flexTemplates เป็นตัวต่อสตริง customer_name
//        ล้วน ๆ ไม่ได้สร้าง Flex — ใช้ตัวเดียวกับ handleQuotationEditRequest เพื่อให้
//        รูปแบบ meta `revise_from=` ของสองเส้นไม่มีวันเพี้ยนออกจากกัน)
//     * ทุกฟังก์ชันรับ `adminId` + `spUserId` แล้วแปลงเป็น `webUserId` ด้วย ensureWebProxy()
//       **ก่อนเสมอ** — กัน FK 23503 ตอน insert และ refresh ชื่อ/เบอร์/รหัสของเซลส์ให้ทันปัจจุบัน
//     * ตรรกะธุรกิจทั้งหมด (ราคา · ส่วนลด · กฎบล็อก · blacklist · เครดิต) **เรียกของเดิม**
//       ไม่ก๊อปมาไว้ที่นี่ ไม่งั้นวันหนึ่งใบที่ออกจากเว็บกับจาก LINE จะคิดเลขไม่ตรงกัน
//
//  ทำไม propose กับ createDraft ถึงแยกเป็นสองก้าว: ของเดิมใน LINE ทำรวดเดียว (ล้างใบค้าง
//  แล้ว insert ทันที) เพราะแชทไม่มีที่ให้ "ดูก่อนแล้วค่อยกด" · ฟอร์มมี ⇒ แยกได้ **และต้องแยก**
//  ไม่งั้นแค่วางข้อความผิดก็ไปลบร่างที่ค้างอยู่ทิ้งแล้ว (ด่าน diag:web-quote ข้อ 2 ตรวจข้อนี้)
// ─────────────────────────────────────────────────────────────────────────────
import { pool } from '../config/db.js';
import { getCustomerById, getContactById, getSalespersonByUserId } from '../db/repositories.js';
import { KeyedTaskQueue, runWithDeadline } from './webhookQueue.js';
import { extractQuoteFromText, buildResolvedItem, type QuoteSlot } from './quoteExtraction.js';
import { findCustomerCandidates, findContactCandidates } from './customerService.js';
import { getProductById, findProduct } from './productService.js';
import {
  validateQuotationItems,
  insertDraftQuotations,
  buildViolationText,
  type Violation,
} from './quotationService.js';
import { loadActiveQuotation } from './quotationAgent.js';
import { appendReviseFrom } from '../utils/flexTemplates.js';
import {
  ensureWebProxy,
  getAdminIssuerProfile,
  listActingSalespersons,
  type ActingSalesperson,
} from './webIdentity.js';

/**
 * งบเวลาต่อ 1 คำขอของหน้าเว็บ
 *
 * เว็บไม่มี replyToken เดินถอยหลัง 1 นาทีมาบีบเหมือน LINE (ผู้ใช้นั่งดูสปินเนอร์อยู่ กดใหม่ได้เอง)
 * ⇒ ให้งบยาวกว่าเพื่อไม่ตัดงานที่ "ช้าแต่จะสำเร็จ" ทิ้งฟรี ๆ แต่ยังต้องมีเพดาน ไม่งั้น request
 * ที่ค้างจะกินสล็อตคิวไว้ตลอดกาล
 */
export const WEB_BUDGET_MS = 60_000;

/**
 * คิวของหน้าเว็บ — **instance ของตัวเอง ห้ามใช้ตัวเดียวกับ /callback**
 *
 * ถ้าใช้ร่วมกัน แอดมิน 1 คนวางข้อความยาว ๆ จะไปกินสล็อตของเซลส์ที่รอ LINE ตอบอยู่
 * ซึ่งฝั่งนั้นมี replyToken เดินถอยหลังอยู่ = เสียหายกว่ากันมาก
 * maxConcurrency 4 เพราะงานหนักของเส้นนี้คือ LLM + ค้นสินค้า ซึ่งไปกิน LLM/DB ตัวเดียวกับ LINE
 *
 * key = webUserId ⇒ แอดมินคนเดียวกันที่ออกใบในนามเซลส์คนเดียวกันถูกจัดคิวทีละงาน
 * (กดปุ่มรัว ๆ ไม่สร้างร่างซ้อนกัน) ส่วนคู่อื่น ๆ ยังขนานกันได้ตามปกติ
 */
const webQueue = new KeyedTaskQueue(4);

/** ให้ด่านตรวจดูสถานะคิวได้ โดยไม่ต้อง export ตัวคิวออกไปให้ใครแก้สถานะ */
export function webQueueStats() {
  return { active: webQueue.activeCount, pending: webQueue.pendingCount, idle: webQueue.isIdle };
}

export type WebQuoteErrorCode =
  | 'MAKER_NOT_SET'            // แอดมินยังไม่ได้ตั้งชื่อผู้จัดทำ (เฟส B/B2)
  | 'ADMIN_NOT_FOUND'
  | 'SALESPERSON_NOT_FOUND'
  | 'BAD_REQUEST'
  | 'QUOTATION_NOT_FOUND'
  | 'QUOTATION_NOT_CONFIRMED'
  | 'PRODUCT_NOT_FOUND'
  | 'RULE_VIOLATION'
  | 'INSERT_FAILED'
  | 'TIMEOUT';

/** error ที่ route แปลงเป็น HTTP status ได้ตรง ๆ โดยไม่ต้องเดาจากข้อความ */
export class WebQuoteError extends Error {
  constructor(
    public readonly code: WebQuoteErrorCode,
    message: string,
    public readonly status: number,
    /** รายละเอียดเพิ่มให้ UI แสดง (เช่น violations ที่ติดกฎ) */
    public readonly detail?: any
  ) {
    super(message);
    this.name = 'WebQuoteError';
  }
}

/**
 * แปลง (แอดมิน × เซลส์) เป็น `webUserId` — ด่านแรกของทุกฟังก์ชันในไฟล์นี้
 *
 * ตรวจ "ตั้งชื่อผู้จัดทำแล้วหรือยัง" ที่นี่แทนที่จะปล่อยให้ ensureWebProxy โยน Error ดิบ
 * เพราะเป็นเคสที่ผู้ใช้แก้เองได้ (ไปตั้งชื่อในแถบโปรไฟล์) ⇒ ต้องได้ 400 พร้อมบอกวิธี ไม่ใช่ 500
 */
export async function resolveWebUserId(adminId: number, spUserId: string): Promise<string> {
  const sp = String(spUserId ?? '').trim();
  if (sp === '') throw new WebQuoteError('BAD_REQUEST', 'ต้องระบุเซลส์ที่จะออกใบในนาม (sp_user_id)', 400);

  const profile = await getAdminIssuerProfile(adminId);
  if (!profile) throw new WebQuoteError('ADMIN_NOT_FOUND', `ไม่พบแอดมิน id=${adminId}`, 404);
  if (!profile.employee_quotation_id) {
    throw new WebQuoteError(
      'MAKER_NOT_SET',
      'ยังไม่ได้ตั้งชื่อผู้เสนอราคา/ผู้จัดทำ — ตั้งค่าที่แถบโปรไฟล์ก่อนออกใบ',
      400
    );
  }

  try {
    return await ensureWebProxy({ id: adminId, employee_quotation_id: profile.employee_quotation_id }, sp);
  } catch (err: any) {
    // ensureWebProxy โยนเมื่อไม่พบเซลส์ที่ active — ข้อมูลที่ client ส่งมาผิด ไม่ใช่ระบบพัง
    if (String(err?.message || '').includes('ไม่พบเซลส์')) {
      throw new WebQuoteError('SALESPERSON_NOT_FOUND', `ไม่พบเซลส์ที่ใช้งานอยู่ (user_id=${sp})`, 400);
    }
    throw err;
  }
}

/**
 * รันงาน 1 ชิ้นผ่านคิวของหน้าเว็บภายใต้ WEB_BUDGET_MS
 *
 * runWithDeadline คืนแค่ "ผลของการรัน" ไม่ใช่ค่าที่งานคืน ⇒ ต้องรับค่าออกมาทางตัวแปรนอกสุดเอง
 * · งานที่หมดเวลาถูก abort แล้ว error ที่ตามมาทีหลังถูกกลืนที่ onGhostError ไม่ปล่อยให้กลายเป็น
 * unhandledRejection (ซึ่ง Node จะฆ่าโปรเซสทิ้งทั้งตัว)
 */
async function runQueued<T>(key: string, work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    webQueue.push(key, async () => {
      let value: T | undefined;
      const res = await runWithDeadline(
        WEB_BUDGET_MS,
        async () => { value = await work(); },
        (err) => console.error('[webQuote] งานที่ถูกตัดเวลาพังทีหลัง (ไม่กระทบคำตอบที่ส่งไปแล้ว):', err)
      );
      if (res.outcome === 'ok') return resolve(value as T);
      if (res.outcome === 'timeout') {
        return reject(new WebQuoteError('TIMEOUT', 'ระบบใช้เวลานานเกินกำหนด รบกวนลองใหม่อีกครั้ง', 504));
      }
      reject(res.error);
    });
  });
}

// ── 1) ข้อความ → ร่าง (ยังไม่เขียน quotations) ───────────────────────────────

export interface ProposeResult {
  web_user_id: string;
  intent: string;
  /** true = UNCLEAR เพราะระบบไม่ว่าง ไม่ใช่เพราะข้อความไม่ชัด — UI ขึ้นแถบแดง + ปุ่มลองใหม่ */
  extraction_failed: boolean;
  reply_message: string | null;
  /** quotation_data ดิบจาก AI (customer_query / contact_query / ส่วนลดระดับบิล) */
  quote_data: any | null;
  slots: QuoteSlot[];
  /** จำนวน slot ที่ยัง resolve ไม่ได้ — ฟอร์มต้องให้แอดมินเคาะให้ครบก่อนสร้างร่าง */
  unresolved_count: number;
  customer_candidates: any[];
  contact_candidates: any[];
}

/**
 * วางข้อความ → คืน slots + candidates โดย **ไม่เขียน DB สักแถว**
 *
 * ต่างจากทางเดินของ LINE 2 จุดเท่านั้น:
 *   1. `purgePending: false` — ยังไม่ใช่การตัดสินใจ จึงไม่มีสิทธิ์ไปลบร่างที่ค้างอยู่
 *   2. ไม่เรียก processQuotationRequest — ฟังก์ชันนั้นเขียนใบสถานะ `pending_*` ระหว่างไล่ถามหา
 *      บริษัท/ผู้ติดต่อ ซึ่งเป็นกลไกของแชทล้วน ๆ · ฟอร์มถามทั้งหมดจบในหน้าเดียวก่อน insert
 *      ⇒ เรียก findCustomerCandidates/findContactCandidates (อ่านอย่างเดียว) ตรง ๆ แทน
 */
export async function proposeFromText(params: {
  adminId: number;
  spUserId: string;
  text: string;
}): Promise<ProposeResult> {
  const text = String(params.text ?? '').trim();
  if (text === '') throw new WebQuoteError('BAD_REQUEST', 'ต้องมีข้อความที่จะสกัด (text)', 400);

  const webUserId = await resolveWebUserId(params.adminId, params.spUserId);

  return runQueued(webUserId, async () => {
    const extracted = await extractQuoteFromText({ userId: webUserId, text, purgePending: false });

    const base: ProposeResult = {
      web_user_id: webUserId,
      intent: extracted.intent,
      extraction_failed: !!extracted.extraction_failed,
      reply_message: extracted.reply_message ?? null,
      quote_data: extracted.quoteData ?? null,
      slots: extracted.slots ?? [],
      unresolved_count: (extracted.slots ?? []).filter(s => !s.resolved).length,
      customer_candidates: [],
      contact_candidates: [],
    };

    // intent อื่น (REGISTER / PRODUCT_INFO / UNCLEAR) ไม่มีอะไรให้เติม — ฟอร์มขึ้นข้อความจาก AI
    if (!extracted.quoteData) return base;

    // ใช้แถวเซลส์ "ตัวจริง" ไม่ใช่แถวพร็อกซี — การให้คะแนนใช้ชื่อเจ้าของลูกค้าและสาขา
    // ซึ่งแถวพร็อกซีไม่ได้ก๊อป branch มาด้วยตามที่ §2.3 ตั้งใจ ⇒ ใช้พร็อกซีจะได้คะแนน
    // ต่างจากตอนเซลส์คนนั้นทักเอง ทั้งที่เป็นใบของลูกค้ารายเดียวกัน
    const realSp = await getSalespersonByUserId(String(params.spUserId).trim());
    const customerQuery = String(extracted.quoteData.customer_query ?? '').trim();
    const contactQuery = String(extracted.quoteData.contact_query ?? '').trim();

    if (customerQuery) {
      base.customer_candidates = await findCustomerCandidates(customerQuery, realSp, contactQuery);
    }

    // ผู้ติดต่อค้นได้ก็ต่อเมื่อรู้บริษัทแน่นอนแล้ว — บริษัทกำกวมให้ฟอร์มเคาะก่อน แล้วค่อยเรียก
    // `GET /api/customer/:id/contacts` เดิมเอง (endpoint นั้นไม่ผูก LINE — §0.3)
    if (base.customer_candidates.length === 1 && contactQuery) {
      const customerId = base.customer_candidates[0]?.item?.id;
      if (customerId) base.contact_candidates = await findContactCandidates(customerId, contactQuery);
    }

    return base;
  });
}

// ── 2) ฟอร์มที่แอดมินเคาะแล้ว → ร่างจริงใน DB ────────────────────────────────

export interface WebQuoteItemInput {
  /** ชี้สินค้าด้วย product_template_id เป็นหลัก (มาจาก candidates / product-search) */
  product_template_id?: number | string | null;
  /** ทางสำรองเมื่อ client มีแต่รหัสรุ่น */
  model?: string | null;
  quantity?: number | string;
  /** ราคาต่อหน่วยที่แอดมินตั้ง — ไม่ส่ง/0 = ใช้ราคาขายของสินค้าจาก DB */
  price?: number | string | null;
  discount_1?: number | string | null;
  discount_2?: number | string | null;
}

export interface CreateDraftResult {
  web_user_id: string;
  customer_id: number;
  contact_id: number;
  customer_name: string;
  quotes: any[];
}

/**
 * แปลง item ที่ฟอร์มส่งมาเป็น itemForDb — การ map ฟิลด์ใช้ `buildResolvedItem` ตัวเดียวกับทางเดิม
 *
 * ไม่รับข้อมูลสินค้าที่ client ส่งมาเป็นของจริงสักฟิลด์ — ชื่อ · brand · series · production ·
 * product_id · ราคาตั้ง ถูกอ่านใหม่จาก DB เสมอ · client กำหนดได้แค่ "จำนวน · ราคา · ส่วนลด"
 * ซึ่งเป็นสิทธิ์ของคนออกใบอยู่แล้ว
 *
 * ⚠️ **จุดเดียวที่เส้นเว็บต่างจากเส้น LINE โดยตั้งใจ: ราคาที่ตั้งเองไม่ล้างส่วนลด**
 * `buildResolvedItem` มีกติกา "พิมพ์ราคามาเอง = ราคาสุทธิ ⇒ ส่วนลดเป็น 0" ซึ่งถูกต้องสำหรับ
 * *ข้อความอิสระ* (เซลส์พิมพ์ "ราคา 650" หมายถึงสุทธิ) แต่ผิดสำหรับ *ฟอร์ม* ที่มีช่องราคาและ
 * ช่องส่วนลดแยกกันอยู่ตรงหน้า — สิ่งที่แอดมินเห็นในฟอร์มต้องเป็นสิ่งที่ถูกบันทึกเป๊ะ ไม่งั้น
 * แค่เปิดร่างที่ระบบสกัดมา (ราคาตั้ง + ลด 30%) แล้วกดสร้าง ส่วนลดจะหายไปเงียบ ๆ
 * ⇒ เรียก buildResolvedItem โดย **ไม่ส่ง price** (ให้มันคิดส่วนลดบนราคาตั้งตามปกติ)
 *   แล้วค่อยทับราคาต่อหน่วยทีหลังถ้าแอดมินตั้งมา
 */
async function resolveItems(items: WebQuoteItemInput[]): Promise<any[]> {
  const out: any[] = [];
  for (const [i, raw] of items.entries()) {
    const tplId = raw?.product_template_id;
    let product: any = null;

    if (tplId !== undefined && tplId !== null && String(tplId).trim() !== '') {
      product = await getProductById(Number(tplId));
    }
    if (!product) {
      const code = String(raw?.model ?? '').trim();
      if (code) {
        // findProduct ตัวเดียวกับทางเดิม — รหัสที่ฟอร์มเลือกมาแล้วเข้า Stage 1 exact ตรง ๆ
        const found = await findProduct(code);
        if (found.found && found.product) product = found.product;
      }
    }
    if (!product) {
      throw new WebQuoteError(
        'PRODUCT_NOT_FOUND',
        `ไม่พบสินค้าของรายการที่ ${i + 1} (${raw?.model ?? raw?.product_template_id ?? '-'})`,
        400
      );
    }

    const qty = Number(raw?.quantity);
    const { itemForDb } = buildResolvedItem(
      product,
      {
        quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
        discount_1: raw?.discount_1,
        discount_2: raw?.discount_2,
      },
      {}
    );

    const price = Number(raw?.price);
    if (Number.isFinite(price) && price > 0) itemForDb.price = price;
    out.push(itemForDb);
  }
  return out;
}

/**
 * สร้างร่างจริงจากฟอร์มที่เคาะแล้ว
 *
 * ด่านกฎใช้ `validateQuotationItems(stage:'draft')` ตัวเดียวกับทุกเส้น และส่ง
 * `customerId`/`contactId` เข้าไปด้วย ⇒ ครอบทั้ง blacklist และเครดิตระดับลูกค้าในด่านเดียว
 * (ใน LINE ต้องแยกไปตรวจซ้ำใน resolveContactFlow เพราะตอนเรียกด่านกลางยังไม่รู้ว่าลูกค้าคือใคร
 *  — ฟอร์มรู้ตั้งแต่ต้น จึงไม่ต้องมีด่านที่สอง)
 */
export async function createDraft(params: {
  adminId: number;
  spUserId: string;
  customerId: number | string;
  contactId: number | string;
  items: WebQuoteItemInput[];
}): Promise<CreateDraftResult> {
  if (!Array.isArray(params.items) || params.items.length === 0) {
    throw new WebQuoteError('BAD_REQUEST', 'ต้องมีรายการสินค้าอย่างน้อย 1 รายการ (items)', 400);
  }
  // id ทั้งสองตัวเป็นเลขของ customers_data_view — บังคับเป็น number ตั้งแต่ปากทาง
  // ไม่งั้นค่าที่มาจาก JSON body แบบสตริงจะไหลไปถึง insertDraftQuotations แล้วชนกับ FK ทีหลัง
  const customerIdIn = Number(params.customerId);
  const contactId = Number(params.contactId);
  if (!Number.isFinite(customerIdIn) || customerIdIn <= 0) {
    throw new WebQuoteError('BAD_REQUEST', 'ต้องระบุบริษัท (customer_id) เป็นตัวเลข', 400);
  }
  if (!Number.isFinite(contactId) || contactId <= 0) {
    throw new WebQuoteError('BAD_REQUEST', 'ต้องระบุผู้ติดต่อ (contact_id) เป็นตัวเลข', 400);
  }

  const webUserId = await resolveWebUserId(params.adminId, params.spUserId);

  return runQueued(webUserId, async () => {
    const contact = await getContactById(contactId);
    if (!contact) throw new WebQuoteError('BAD_REQUEST', `ไม่พบผู้ติดต่อ id=${contactId}`, 400);

    // ผู้ติดต่อที่เลือกอาจอยู่ใต้ company_id ของสาขาอื่นในนิติบุคคลเดียวกัน — ผูกใบตามบริษัทของ
    // "คนที่เลือกจริง" เสมอ (กติกาเดียวกับ resolveContactFlow) ไม่งั้นคู่ (customer_id, contact_id)
    // จะชี้แถวที่ไม่มีอยู่ ⇒ snapshot และด่านตรวจ lookup ไม่เจอ
    const resolvedCustomerId = Number(contact.customer_id ?? customerIdIn);
    const customer = await getCustomerById(resolvedCustomerId);
    if (!customer) throw new WebQuoteError('BAD_REQUEST', `ไม่พบบริษัท id=${resolvedCustomerId}`, 400);

    const itemsForDb = await resolveItems(params.items);

    const { items: expanded, violations } = await validateQuotationItems(itemsForDb, {
      stage: 'draft',
      customerName: customer.display_name,
      customerId: resolvedCustomerId,
      contactId,
    });
    if (violations.length > 0) {
      throw new WebQuoteError('RULE_VIOLATION', buildViolationText(violations), 422, { violations });
    }

    const customerName = `${customer.display_name} | ${contact.name}`;
    const quotes = await insertDraftQuotations(
      webUserId, customerName, expanded, 'draft', resolvedCustomerId, contactId
    );
    if (!quotes || quotes.length === 0) {
      throw new WebQuoteError('INSERT_FAILED', 'ไม่สามารถบันทึกข้อมูลใบเสนอราคาได้', 500);
    }

    return {
      web_user_id: webUserId,
      customer_id: resolvedCustomerId,
      contact_id: contactId,
      customer_name: customerName,
      quotes,
    };
  });
}

// ── 5) revise ────────────────────────────────────────────────────────────────

export interface ReviseResult {
  web_user_id: string;
  /** id ของ "ร่าง" ที่เพิ่งสร้าง — ฟอร์มเปิดใบนี้ต่อในหน้าเดิม */
  draft_quote_id: string;
  /** เลขที่ใบต้นทางที่กำลังแก้ */
  revise_from: string;
  quotes: any[];
}

/**
 * ทำ revision ของใบที่ยืนยันแล้ว — เดินลำดับเดียวกับ handleQuotationEditRequest() เป๊ะ
 * (loadActiveQuotation → validateQuotationItems → ยกเลิกร่างค้าง → insertDraftQuotations)
 * ต่างกันแค่ **คืน id ของร่าง แทนที่จะคืน Flex**
 *
 * ⚠️ ลำดับ "ตรวจกฎก่อนยกเลิกร่างค้าง" ห้ามสลับ — ถ้าตรวจทีหลังแล้วติดกฎ ร่างที่แอดมิน
 *    ทำค้างไว้จะถูกทิ้งไปฟรี ๆ ทั้งที่ทำอะไรต่อไม่ได้เลย
 */
export async function reviseQuotation(params: {
  adminId: number;
  spUserId: string;
  quotationNo: string;
}): Promise<ReviseResult> {
  const quoteNo = String(params.quotationNo ?? '').trim().toUpperCase();
  if (quoteNo === '') throw new WebQuoteError('BAD_REQUEST', 'ต้องระบุเลขที่ใบเสนอราคา (quotation_no)', 400);

  const webUserId = await resolveWebUserId(params.adminId, params.spUserId);

  return runQueued(webUserId, async () => {
    const active = await loadActiveQuotation(quoteNo);
    if (!active) {
      throw new WebQuoteError('QUOTATION_NOT_FOUND', `ไม่พบใบเสนอราคาเลขที่ "${quoteNo}" ในระบบ`, 404);
    }
    if (!active.quotation_no) {
      throw new WebQuoteError(
        'QUOTATION_NOT_CONFIRMED',
        'ใบเสนอราคานี้ยังเป็นร่าง (ยังไม่มีเลขที่ยืนยัน) จึงยังแก้ไขแบบ revision ไม่ได้',
        400
      );
    }

    const { items: revExpanded, violations } = await validateQuotationItems(active.items, {
      stage: 'draft', customerId: active.customer_id, contactId: active.contact_id
    });
    if (violations.length > 0) {
      throw new WebQuoteError('RULE_VIOLATION', buildViolationText(violations), 422, { violations });
    }

    // ยกเลิกร่างที่ค้างของ "คู่ (แอดมิน × เซลส์) นี้เท่านั้น" — ไม่แตะร่างของเซลส์ตัวจริง
    // และไม่แตะร่างที่แอดมินคนเดียวกันทำค้างไว้ในนามเซลส์คนอื่น
    try {
      await pool.query(
        "UPDATE quotations SET status = 'cancelled' WHERE user_id = $1 AND status = ANY($2)",
        [webUserId, ['pending_company', 'pending_contact', 'draft']]
      );
    } catch (err) {
      console.error('[webQuote] cancel pending drafts error:', err);
    }

    const quotes = await insertDraftQuotations(
      webUserId,
      appendReviseFrom(active.customer_name, active.quotation_no),
      revExpanded,
      'draft',
      active.customer_id,
      active.contact_id
    );
    if (!quotes || quotes.length === 0) {
      throw new WebQuoteError('INSERT_FAILED', 'ไม่สามารถเตรียมใบเสนอราคาเพื่อแก้ไขได้', 500);
    }

    return {
      web_user_id: webUserId,
      draft_quote_id: String(quotes[0].id),
      revise_from: active.quotation_no,
      quotes,
    };
  });
}

// ── รายชื่อ "ออกในนาม" ───────────────────────────────────────────────────────

/**
 * รายชื่อเซลส์ที่เลือกเป็น "ออกในนาม" ได้ — ตัวเดียวกับที่เฟส B เขียนไว้ (พก sig_url มาด้วย
 * ตั้งแต่เฟส D เพื่อให้หน้าเว็บพรีวิวลายเซ็นได้ก่อนออกใบ) · ห่อไว้ที่นี่เพื่อให้ route ของ
 * กลุ่ม webquote อ่านจากไฟล์เดียวกันทั้งเฟส
 */
export async function listSalespersonsForWeb(): Promise<ActingSalesperson[]> {
  return listActingSalespersons();
}

export type { Violation };
