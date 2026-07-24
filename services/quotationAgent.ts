import { pool } from '../config/db.js';
import {
  insertDraftQuotations,
  enrichQuotationData
} from './quotationService.js';
import {
  appendReviseFrom,
  createRevisionFlex
} from '../utils/flexTemplates.js';

export interface EditIntent {
  quoteNo: string;
  instruction: string;
}

/**
 * ตรวจจับว่าเป็นคำสั่ง "แก้ไขใบเสนอราคาผ่านแชท" หรือไม่
 * เงื่อนไข: ต้องมีเลขที่ใบเสนอราคา (QP/QT-...) + มีคำกริยาสั่งแก้ไข
 * (การพิมพ์เลขที่ล้วน ๆ หรือคำว่า "แก้ไข" เดี่ยว ๆ ถูกจัดการโดย trigger เดิมไปแล้ว)
 */
export function detectQuotationEditIntent(text: string): EditIntent | null {
  if (!text) return null;
  const quoteMatch = text.match(/(QP|QT)-\d{6,}(?:-\d+)?/i);
  if (!quoteMatch) return null;

  const editVerb = /(แก้ไข|แก้|เพิ่ม|ลด|เปลี่ยน|ปรับ|ลบ|เอาออก|ตัดออก|อัปเดต|อัพเดต|ใส่|set|update|change|add|remove|revise|revision)/i;
  if (!editVerb.test(text)) return null;

  return {
    quoteNo: quoteMatch[0].toUpperCase(),
    instruction: text.trim()
  };
}

/**
 * ดึงใบเสนอราคาที่ "ยังใช้งานอยู่" (active/ล่าสุด) จากเลขที่ที่เซลส์อ้างถึง
 * รองรับทั้งเลขฐาน (QP-260705030) และเลข revision (QP-260705030-01)
 * คืนค่าใบที่ revision สูงสุดและยังไม่ถูกยกเลิก
 */
async function loadActiveQuotation(quoteNo: string): Promise<any | null> {
  let baseQuoteNo = quoteNo;
  const m = quoteNo.match(/^((?:QP|QT)-\d+)(-\d+)$/i);
  if (m) baseQuoteNo = m[1];

  let rows: any[] = [];
  try {
    const res = await pool.query(
      'SELECT * FROM quotations WHERE quotation_no = $1 OR quotation_no ILIKE $2',
      [baseQuoteNo, `${baseQuoteNo}-%`]
    );
    rows = res.rows;
  } catch (err) {
    console.error('[quotationAgent] load quotation error:', err);
    return null;
  }

  if (!rows.length) return null;

  const getRev = (qNo: string) => {
    const rm = String(qNo || '').match(/^(?:QP|QT)-\d+-(\d+)$/i);
    return rm ? parseInt(rm[1]) : 0;
  };

  // เลือกใบที่ยังไม่ถูกยกเลิก และ revision สูงสุด (คือใบที่ใช้งานอยู่จริง)
  const usable = rows
    .filter((q: any) => q.status !== 'cancelled')
    .sort((a: any, b: any) => getRev(b.quotation_no) - getRev(a.quotation_no));

  const chosen = usable[0] || rows.sort((a: any, b: any) => getRev(b.quotation_no) - getRev(a.quotation_no))[0];
  return await enrichQuotationData(chosen);
}

/**
 * จัดการคำสั่งแก้ไขใบเสนอราคาผ่านแชท
 * แนวทาง: ตรวจจับ intent → คัดลอกใบเป็นฉบับแก้ไข (revision draft) →
 * ส่งปุ่มเปิดหน้าแก้ไข (LIFF) ให้เซลส์แก้เอง เหมือน flow แก้ไขเดิม (ปลอดภัย ไม่ให้ AI แก้ข้อมูลเอง)
 * คืน { messages, replyText } ให้ handler ส่งกลับและบันทึกประวัติ
 */
export async function handleQuotationEditRequest(params: {
  userId: string;
  quoteNo: string;
  instruction: string;
  salesperson: any;
}): Promise<{ messages: any[]; replyText: string }> {
  const { userId, quoteNo } = params;

  const activeQuote = await loadActiveQuotation(quoteNo);
  if (!activeQuote) {
    const t = `❌ ไม่พบใบเสนอราคาเลขที่ "${quoteNo}" ในระบบครับ\nรบกวนตรวจสอบเลขที่อีกครั้งนะครับ`;
    return { messages: [{ type: 'text', text: t }], replyText: t };
  }
  if (!activeQuote.quotation_no) {
    const t = `❌ ใบเสนอราคานี้ยังเป็นร่าง (ยังไม่มีเลขที่ยืนยัน) จึงยังแก้ไขแบบ revision ไม่ได้ครับ`;
    return { messages: [{ type: 'text', text: t }], replyText: t };
  }

  // ตรวจกฎก่อนสร้างร่าง revision (เดิมข้ามการตรวจ — สินค้าที่ติดกฎหลุดเข้าร่างได้)
  // ตรวจ "ก่อน" ยกเลิกใบร่างเดิม — ถ้าติดกฎจะได้ไม่เผลอทิ้งร่างที่ค้างอยู่ (ให้ตรงกับเส้น revise ใน lineHandler)
  const { validateQuotationItems } = await import('./quotationService.js');
  const { items: revExpanded, violations: revViolations } = await validateQuotationItems(activeQuote.items, { stage: 'draft' });
  if (revViolations.length > 0) {
    const { buildViolationText } = await import('./quotationService.js');
    const t = buildViolationText(revViolations);
    return { messages: [{ type: 'text', text: t }], replyText: t };
  }

  // ยกเลิกใบร่างที่ค้างอยู่ของเซลส์คนนี้ก่อน (เหมือน flow revise เดิม)
  try {
    await pool.query(
      "UPDATE quotations SET status = 'cancelled' WHERE user_id = $1 AND status = ANY($2)",
      [userId, ['pending_company', 'pending_contact', 'draft']]
    );
  } catch (err) {
    console.error('[quotationAgent] cancel pending drafts error:', err);
  }

  const revisedCustomerName = appendReviseFrom(activeQuote.customer_name, activeQuote.quotation_no);

  // insert ด้วย revExpanded จาก validateQuotationItems ด้านบน — gate นั้น expand สินค้าพ่วงให้แล้ว
  // (ใบเก่าอาจไม่เคยผ่าน expand — กฎคู่สินค้าหลัก-เสริม ต้องพ่วงให้ครบตอนคัดลอกมาแก้)
  let newQuote: any = null;
  try {
    const insertedQuotes = await insertDraftQuotations(
      userId,
      revisedCustomerName,
      revExpanded,
      'draft',
      activeQuote.customer_id,
      activeQuote.contact_id
    );
    if (insertedQuotes && insertedQuotes.length > 0) {
      newQuote = insertedQuotes[0];
    }
  } catch (err) {
    console.error('[quotationAgent] insert revised draft error:', err);
  }

  if (!newQuote) {
    const t = '❌ ไม่สามารถเตรียมใบเสนอราคาเพื่อแก้ไขได้ รบกวนลองใหม่อีกครั้งครับ';
    return { messages: [{ type: 'text', text: t }], replyText: t };
  }

  const flexMsg = createRevisionFlex(activeQuote.quotation_no, newQuote.id, userId);
  const replyText = `📄 เตรียมแก้ไขใบเสนอราคา ${activeQuote.quotation_no} (กดปุ่มเพื่อแก้ไขรายการ/จำนวน/ส่วนลด)`;
  return { messages: [flexMsg as any], replyText };
}
