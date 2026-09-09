import { lineClient as defaultLineClient } from '../config/clients.js';
import type { ReplyClient } from '../services/chatChannel.js';
import { pool, withTransaction } from '../config/db.js';
import {
  getSalespersonByUserId,
  insertSalesperson,
  updateSalespersonByUserId,
  insertMessage,
  getQuotationsByIds,
  getQuotationsByNos,
  getRecentConfirmedQuotations,
  getStaticBranches,
  getBranchesByCodes,
} from '../db/repositories.js';
import { buildPdfLink, parseQuotationNosFromText } from '../utils/quotationLink.js';
import { getAppUrl } from '../config/appUrl.js';
import { 
  createBranchSelectionFlex, 
  getQuotationSummaryMessage, 
  createListFlexMessage,
  createEditMenuFlex,
  createSalespersonProfileFlex,
  createProfileConfirmationFlex,
  createCartConfirmationFlex,
  appendReviseFrom,
  createRevisionFlex,
  isCustomerInfoIncomplete
} from '../utils/flexTemplates.js';
import { findProduct } from '../services/productService.js';
// เฟส C — "ข้อความดิบ → ร่างใบ" ย้ายไปอยู่ที่นี่ทั้งก้อน (เดิมอยู่กลาง handleEvent ~265 บรรทัด)
// buildResolvedItem ยังถูกเรียกจากเส้นทางกดเลือกรุ่น (postback) ในไฟล์นี้ด้วย จึง import กลับมา
import { extractQuoteFromText, buildResolvedItem } from '../services/quoteExtraction.js';
import { 
  findCustomerCandidates,
  findContactCandidates,
  splitCustomerContact,
  dedupeIdenticalCompanies,
  buildCompanyOptionLabel
} from '../services/customerService.js';
import {
  confirmQuotationAtomic,
  type ConfirmResult,
  processQuotationRequest,
  resolveContactFlow,
  updateQuotationCustomerSnapshot,
  insertDraftQuotations,
  enrichQuotationData
} from '../services/quotationService.js';
import { applyShippingFeeToQuoteGroup } from '../services/shippingFee.js';
import { detectQuotationEditIntent, handleQuotationEditRequest } from '../services/quotationAgent.js';

// ข้อความตอบกลับเมื่อเจตนาไม่ชัด (UNCLEAR) — ส่งแบบฟอร์มขอใบเสนอราคาให้เซลส์ก๊อปไปกรอก
// แทนการถามกลับลอยๆ (เซลส์พิมพ์ "ออกใบเสนอราคา" เฉยๆ แล้ววนถามซ้ำไม่จบ)
// กำหนดเป็นค่าคงที่ ไม่ให้ LLM แต่งเอง เพื่อให้รูปแบบฟอร์มเหมือนกันทุกครั้ง
const QUOTATION_FORM_REPLY = `รบกวนพิมพ์ข้อมูลตามรูปแบบนี้ครับ 📝

เสนอราคา
บริษัท:
ผู้ติดต่อ:
รหัสลูกค้า:
รายการสินค้า:
1. TMPxxxxx = 5 ตัว
2. CMPxxxxx = 10 ตัว
ส่วนลด:
ลด 30%
หรือ ลด 20+5%
หรือ ลด 25 ตาม 5`;

// เซลส์ถามเช็คราคา/เช็คของ แต่ไม่ได้ระบุรุ่นมา (ตกเป็น UNCLEAR ตามกฎข้อ 11 เพื่อกันเดารุ่นจากประวัติ)
// → บอกวิธีถามให้ถูก แทนที่จะทักทายกลับลอยๆ
const PRODUCT_INFO_HINT_REPLY = `ต้องการเช็คสต๊อก/ราคาใช่ไหมครับ 🔍
รบกวนพิมพ์ "รหัสรุ่นสินค้า" มาด้วยครับ เช่น

สต๊อก TMP-48
ราคา KM-09N-A`;

// คำที่บ่งว่าเซลส์อยากเช็คข้อมูลสินค้า — เช็คหลัง "เสนอราคา" เสมอ เพราะ "เสนอราคา" มีคำว่า "ราคา" อยู่ด้วย
const PRODUCT_INFO_KEYWORDS = ['ราคา', 'เช็คของ', 'เช็คสินค้า', 'มีของ', 'ของมี', 'สต็อก', 'สต๊อก', 'stock'];

// ตัวสำรองสำหรับ UNCLEAR ที่ไม่ได้พูดถึงการเสนอราคา (ทักทาย/ถามทั่วไป) เผื่อ LLM ไม่ส่ง reply_message มา
const GREETING_REPLY = `สวัสดีครับ ผมเป็นบอทผู้ช่วยออกใบเสนอราคา 🙏
พิมพ์คำว่า "เสนอราคา" เพื่อดูแบบฟอร์มการขอใบเสนอราคาได้เลยครับ`;

// สร้างข้อความเลือกรุ่นสินค้าที่กำกวม (mirror การเลือกบริษัท) — postback: action=select_product&slot=<i>&pick=<j>
// คืน 2 ข้อความ: ปุ่ม candidate + ปุ่มค้นหาเพิ่มเติม (ทางออกเมื่อไม่มี candidate ตัวไหนถูก — คงไว้เหมือน flow เดิม)
function buildProductSelectionMessages(slot: any, slotIndex: number, userId: string): any[] {
  const query = String(slot?.item?.model || slot?.item?.product_code || '').trim();

  // ปุ่มเลือกรุ่น: model เด่นชัด (ตัวใหญ่/น้ำเงิน) กว่าราคา (เขียว) และจำนวนคงเหลือ (เทา/แดงถ้าหมด)
  const optionBoxes: any[] = (slot.candidates || []).map((c: any, i: number) => {
    const price = Number(c.sales_price || 0).toLocaleString();
    const stock = Number(c.quantity_on_hand_unreserved || 0);
    const outOfStock = stock <= 0;
    return {
      type: 'box',
      layout: 'vertical',
      backgroundColor: outOfStock ? '#FEF2F2' : '#F9FAFB',
      cornerRadius: 'md',
      paddingAll: '10px',
      spacing: 'xs',
      margin: 'sm',
      action: {
        type: 'postback',
        data: `action=select_product&slot=${slotIndex}&pick=${i}`,
        displayText: `เลือกรุ่น ${c.model}`
      },
      contents: [
        {
          type: 'text',
          text: String(c.model || ''),
          weight: 'bold',
          size: 'md',
          color: '#1D4ED8',
          wrap: true
        },
        {
          type: 'box',
          layout: 'horizontal',
          spacing: 'sm',
          contents: [
            {
              type: 'text',
              text: `💵 ฿${price}`,
              size: 'xs',
              color: '#059669',
              flex: 1,
              wrap: true
            },
            {
              type: 'text',
              text: outOfStock ? '📦 คงเหลือ 0' : `📦 คงเหลือ ${stock}`,
              size: 'xs',
              color: outOfStock ? '#DC2626' : '#6B7280',
              weight: outOfStock ? 'bold' : 'regular',
              align: 'end',
              flex: 0
            }
          ]
        }
      ]
    };
  });

  optionBoxes.push({
    type: 'button',
    action: {
      type: 'postback',
      label: '❌ ยกเลิกรายการนี้',
      data: 'action=cancel_pending',
      displayText: 'ยกเลิก'
    },
    style: 'link',
    color: '#EF4444',
    height: 'sm',
    margin: 'md'
  });

  const productFlex = {
    type: 'flex',
    altText: '📦 เลือกรุ่นสินค้าที่ถูกต้อง',
    contents: {
      type: 'bubble',
      size: 'giga',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#1D4ED8',
        paddingAll: '12px',
        contents: [
          {
            type: 'text',
            text: '📦 เลือกรุ่นสินค้าที่ถูกต้อง',
            weight: 'bold',
            color: '#FFFFFF',
            size: 'md'
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        contents: [
          {
            type: 'text',
            text: `พบหลายรุ่นใกล้เคียงกับ "${query}" ครับ กรุณากดเลือกรุ่นที่ถูกต้อง 👇`,
            wrap: true,
            size: 'xs',
            color: '#6B7280'
          },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'md',
            spacing: 'xs',
            contents: optionBoxes
          }
        ]
      }
    }
  };

  const messages: any[] = [productFlex];

  const liffProductSearchId = process.env.LIFF_PRODUCT_SEARCH_ID || process.env.LIFF_QUOTE_ID || '';
  if (liffProductSearchId) {
    let searchLiffUrl = `https://liff.line.me/${liffProductSearchId}?userId=${userId}`;
    if (query) searchLiffUrl += `&q=${encodeURIComponent(query)}`;
    messages.push({
      type: 'flex',
      altText: 'ค้นหาสินค้าเพิ่มเติม',
      contents: {
        type: 'bubble',
        size: 'kilo',
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          paddingAll: '12px',
          contents: [
            {
              type: 'text',
              text: 'ไม่มีรุ่นที่ต้องการ?',
              size: 'sm',
              color: '#6B7280',
              wrap: true
            },
            {
              type: 'button',
              action: {
                type: 'uri',
                label: '🔎 ค้นหาสินค้าเพิ่มเติม',
                uri: searchLiffUrl
              },
              style: 'primary',
              color: '#2563EB',
              height: 'sm'
            }
          ]
        }
      }
    });
  }
  return messages;
}

export async function handleImage(event: any): Promise<any> {
  try {
    return await defaultLineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: 'ขออภัยครับ ตอนนี้ยังไม่รองรับการส่งภาพเข้ามาประมวลผลครับ 📷' }]
    });
  } catch (err) {
    console.error("Error in handleImage:", err);
  }
}

/** ตราประทับบน error ที่ "ด่านตรวจของ C.3" โยนเอง — ใช้แยกจาก AbortError ของไลบรารีอื่น */
const DEADLINE_ABORT = Symbol.for('chatbot.deadlineAbort');

/**
 * @param opts.deadlineAt เวลา (epoch ms) ที่งบตอบกลับหมด — คิดจาก "ตอนรับ webhook" ไม่ใช่ตอนเริ่มทำงาน
 *   ส่งมาจาก index.ts เพื่อให้ขั้นตอนที่ลองใหม่ได้ (เช่น retry ของ extraction) ถามงบก่อนเผาเวลาเพิ่ม
 *   ไม่ส่งมา = ไม่จำกัด (เส้นทาง CLI/เทสที่ไม่มี replyToken)
 * @param opts.signal ธงยกเลิกจาก index.ts — ถูก abort ตอน Promise.race ตัดเพราะหมดงบ
 *   ไม่ส่งมา = ไม่มีใครยกเลิก (เส้นทาง CLI/เทส)
 * @param opts.client ตัวตอบกลับที่จะใช้แทน lineClient — ช่องฉีดของเส้นทางเว็บ (เฟส A ของ
 *   docs/plan-web-quote-request.md) **ไม่ส่งมา = lineClient ตัวเดิมทุกบิต** เส้นทาง LINE
 *   จึงไม่ขยับ · ตัวที่ส่งเข้ามาจริงคือ createCaptureClient() ซึ่งเก็บข้อความแทนยิงออก LINE
 */
export async function handleEvent(
  event: any,
  opts: { deadlineAt?: number; signal?: AbortSignal; client?: ReplyClient } = {}
): Promise<any> {
  // ⚠️ ต้องเป็นบรรทัดแรกสุดของฟังก์ชัน — ชื่อนี้บังตัว import ไว้ทั้งสโคป ถ้ามีโค้ดอ้าง
  // lineClient เหนือบรรทัดนี้จะเจอ TDZ แล้วพังตอน "รัน" ไม่ใช่ตอน compile (tsc จับไม่ได้)
  const lineClient: ReplyClient = opts.client ?? defaultLineClient;

  /** เหลืองบอีกกี่ ms (Infinity ถ้าไม่ได้กำหนด deadline มา) */
  const remainingMs = () => (opts.deadlineAt === undefined ? Infinity : opts.deadlineAt - Date.now());

  /**
   * C.3 — ด่านตรวจก่อนเริ่ม "ขั้นตอนหนัก" แต่ละขั้น (query DB ก้อนใหญ่ / เรียก LLM / สร้างใบเสนอราคา)
   * จงใจไม่ cancel งานที่กำลังรันค้างอยู่ — แค่ไม่เริ่มขั้นถัดไปก็พอที่จะคืน slot ให้คิว
   * ไม่ให้งานผีสะสมแย่ง CPU/DB จากคนที่ยังตอบทัน (ซึ่งเป็นโดมิโนตัวจริงตามที่ C.0 วัดไว้)
   */
  const checkpoint = (step: string) => {
    if (!opts.signal?.aborted) return;
    const err: any = new Error(`หมดงบเวลา — ไม่เริ่มขั้นตอน "${step}"`);
    err.name = 'AbortError';
    // ปักธงของเราเองด้วย ไม่ดูแค่ name: HTTP client ที่ถูก abort ก็โยน error ชื่อ 'AbortError'
    // เหมือนกัน ถ้าไปเหมาว่าเป็นตัวเดียวกันจะกลืน error จริงแล้วเงียบใส่ผู้ใช้โดยไม่รู้ตัว
    err[DEADLINE_ABORT] = true;
    throw err;
  };
  let customMessages: any = null;
  try {
    const userId = event?.source?.userId || 'unknown';
    checkpoint('เริ่มประมวลผล event');
    // ดึงข้อมูลพนักงานขายเพื่อตรวจสอบสถานะ
    const salesperson = await getSalespersonByUserId(userId);

    // 1. ตรวจสอบสถานะการลงทะเบียนพนักงานขาย
    const isRegisteringText = event.type === 'message' && event.message.type === 'text' && 
      (event.message.text.trim() === '🎉 ลงทะเบียนพนักงานขายสำเร็จ' || event.message.text.trim() === '✅ อัปเดตข้อมูลพนักงานขายสำเร็จ');

    if (!salesperson || (salesperson.status !== 'active' && !salesperson.status.startsWith('edit_') && !salesperson.status.startsWith('custom_quote:'))) {
      if (isRegisteringText) {
        // ให้ส่งผ่านไปยังตัวประมวลผลข้อความด้านล่าง เพื่อยืนยันความสำเร็จ
      } else {
        if (!salesperson) {
          await insertSalesperson({
            user_id: userId,
            name: 'รอดำเนินการ',
            status: 'pending_branch'
          });
        }
        const flexMsg = createBranchSelectionFlex('', userId);
        return lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [
            { type: 'text', text: 'สวัสดีครับ คุณยังไม่ได้ลงทะเบียนผู้ใช้งานในระบบ เพื่อความปลอดภัย กรุณาลงทะเบียนผ่านลิงก์ด้านล่างก่อนเริ่มต้นใช้งานครับ 🙏' },
            flexMsg as any
          ]
        });
      }
    }

    if (event.type === 'postback') {
      const data = event.postback.data;
      const params = new URLSearchParams(data);
      const action = params.get('action');
      const quoteIdParam = params.get('id') || params.get('quoteId') || '';



      if (action === 'edit_menu') {
        const sub = params.get('sub');
        if (sub === 'quotation') {
          await updateSalespersonByUserId(userId, { status: 'edit_quote_number' });
          return lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ 
              type: 'text', 
              text: 'กรุณาระบุเลขที่ใบเสนอราคาที่ต้องการแก้ไขครับ เช่น QT/QP-260605xxx'
            }]
          });
        }
      }

      if (action === 'edit_btn') {
        const target = params.get('target');
        const field = params.get('field');
        if (target === 'salesperson') {
          let label = '';
          if (field === 'name') label = 'ชื่อ-นามสกุลจริง';
          else if (field === 'phone') label = 'เบอร์โทรศัพท์';
          else if (field === 'salesperson_id') label = 'รหัสพนักงาน';
          
          await updateSalespersonByUserId(userId, { status: `edit_field:salesperson:${field}` });
          return lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{
              type: 'text',
              text: `👤 กรุณาพิมพ์ **${label}ใหม่** ที่ต้องการแก้ไข ส่งเข้ามาในห้องแชทได้เลยครับ\n\n(หรือพิมพ์ "ยกเลิก" เพื่อข้าม)`,
              quickReply: {
                items: [
                  { type: 'action', action: { type: 'message', label: '❌ ยกเลิก', text: 'ยกเลิก' } }
                ]
              }
            }]
          });
        }
      }

      if (action === 'cancel') {
        const quoteIds = quoteIdParam.split(',').filter(Boolean);
        const replyMessages: any[] = [];
        for (const qId of quoteIds) {
          const quoteRes = await pool.query(
            'SELECT status, quotation_no FROM quotations WHERE id = $1',
            [qId]
          );

          if (quoteRes.rows.length === 0) {
            // แถวหายจาก DB = ร่างเดิมถูกลบทับตอนขึ้นร่างใหม่ (ระบบร่างได้ครั้งละ 1 ใบ)
            replyMessages.push({
              type: 'text',
              text: `❌ ใบเสนอราคาฉบับนี้ถูกแทนที่แล้ว\nด้วยฉบับล่าสุด (ร่างได้ครั้งละ 1 ใบ)\n👉 กรุณาเริ่มรายการใหม่ครับ`
            });
            continue;
          }

          const currentQuote = quoteRes.rows[0];

          if (currentQuote.status === 'confirmed') {
            replyMessages.push({
              type: 'text',
              text: `❌ ใบเสนอราคาเลขที่: ${currentQuote.quotation_no || '-'} ออกเอกสารสำเร็จแล้ว ไม่สามารถยกเลิกได้`
            });
            continue;
          }
          if (currentQuote.status === 'cancelled') {
            replyMessages.push({
              type: 'text',
              text: `❌ ใบเสนอราคานี้ได้รับการยกเลิกเรียบร้อยแล้ว`
            });
            continue;
          }

          const hasQuotationNo = currentQuote.quotation_no && currentQuote.quotation_no.trim() !== '';

          if (!hasQuotationNo) {
            await pool.query(
              'DELETE FROM quotations WHERE id = $1',
              [qId]
            );
            replyMessages.push({
              type: 'text',
              text: `❌ ยกเลิกการออกใบเสนอราคาเรียบร้อยแล้ว`
            });
          } else {
            await pool.query(
              "UPDATE quotations SET status = 'cancelled' WHERE id = $1",
              [qId]
            );
            replyMessages.push({
              type: 'text',
              text: `❌ ยกเลิกการออกใบเสนอราคาเรียบร้อยแล้ว`
            });
          }

          // บันทึกลง messages เพื่อเคลียร์ประวัติในบอท
          try {
            await insertMessage({
              user_id: userId,
              message_id: `postback_cancel_${Date.now()}`,
              type: 'postback',
              content: 'ยกเลิก',
              reply_token: event.replyToken,
              reply_content: '❌ ยกเลิกการออกใบเสนอราคาเรียบร้อยแล้ว'
            });
          } catch (err) {
            console.error("Error logging cancel postback:", err);
          }
        }
        return lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: replyMessages.slice(0, 5)
        });
      }
      if (action === 'cancel_pending') {
        await pool.query(
          "DELETE FROM quotations WHERE user_id = $1 AND status = ANY($2)",
          [userId, ['pending_company', 'pending_contact', 'pending_product', 'draft']]
        );

        // บันทึกลง messages เพื่อเคลียร์ประวัติในบอท
        try {
          await insertMessage({
            user_id: userId,
            message_id: `postback_cancel_pending_${Date.now()}`,
            type: 'postback',
            content: 'ยกเลิก',
            reply_token: event.replyToken,
            reply_content: '❌ ยกเลิกการออกใบเสนอราคาเรียบร้อยแล้ว'
          });
        } catch (err) {
          console.error("Error logging cancel_pending postback:", err);
        }

        return lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: '❌ ยกเลิกการออกใบเสนอราคาเรียบร้อยแล้ว' }]
        });
      }
      if (action === 'confirm') {
        const quoteIds = quoteIdParam.split(',').filter(Boolean);

        // ค่าขนส่งอัตโนมัติ — กันเหนียวก่อนออกเลขจริง เผื่อยอดเปลี่ยนหลังบันทึกครั้งสุดท้าย
        // (ทำก่อนลูปเพราะกฎคิดจากยอดรวมทุกใบ และไม่แตะใบที่ยืนยัน/ยกเลิกไปแล้ว)
        await applyShippingFeeToQuoteGroup(userId);

        const replyMessages: any[] = [];
        for (const qId of quoteIds) {
          // 1. ดึงข้อมูลใบเสนอราคาปัจจุบันก่อนเพื่อดูเวลาสร้าง (created_at)
          let currentQuote: any = null;
          try {
            const fetchRes = await pool.query("SELECT * FROM quotations WHERE id = $1 LIMIT 1", [qId]);
            if (fetchRes.rows.length > 0) {
              currentQuote = await enrichQuotationData(fetchRes.rows[0]);
            }
          } catch (err) {
            console.error("Fetch quote error:", err);
          }
          if (!currentQuote) {
            // แถวหายจาก DB = ร่างเดิมถูกลบทับตอนขึ้นร่างใหม่ (ระบบร่างได้ครั้งละ 1 ใบ)
            replyMessages.push({
              type: 'text',
              text: `❌ ใบเสนอราคาฉบับนี้ถูกแทนที่แล้ว\nด้วยฉบับล่าสุด (ร่างได้ครั้งละ 1 ใบ)\n👉 กรุณาเริ่มรายการใหม่ครับ`
            });
            continue;
          }

          if (currentQuote.status === 'cancelled') {
            replyMessages.push({
              type: 'text',
              text: `❌ ใบเสนอราคานี้ถูกยกเลิกไปแล้ว ไม่สามารถยืนยันได้`
            });
            continue;
          }

          // กันการกดยืนยันจาก Flex เก่าในประวัติแชท ทั้งที่ใบยังไม่ได้ผูกลูกค้า
          // (เลขที่เอกสารใน quotation_counters เดินหน้าแล้วย้อนคืนไม่ได้)
          if (isCustomerInfoIncomplete(currentQuote)) {
            replyMessages.push({
              type: 'text',
              text: `❌ ยังยืนยันไม่ได้ — ใบเสนอราคานี้ยังไม่ได้ระบุข้อมูลลูกค้า\nกรุณากดปุ่ม "🏢 กรอกข้อมูลลูกค้า" เพื่อเลือกบริษัทและผู้ติดต่อก่อนครับ`
            });
            continue;
          }

          const reqUrl = getAppUrl();

          if (currentQuote.status === 'confirmed') {
            // ยืนยันไปแล้ว — แสดงผลสำเร็จเหมือนเดิม (ผู้กดยืนยันต้องเห็น ✅ เสมอ ไม่ใช่ข้อความคลุมเครือ)
            const confirmedNo = currentQuote.quotation_no || '-';
            const pdfLink = buildPdfLink(reqUrl, qId, currentQuote.quotation_no);
            replyMessages.push({
              type: 'text',
              text: `✅ ยืนยันสำเร็จ!\n📄 ใบเสนอราคาเลขที่: ${confirmedNo}`
            });
            replyMessages.push({
              type: 'template',
              altText: `ดาวน์โหลดใบเสนอราคา ${confirmedNo} (PDF)`,
              template: {
                type: 'buttons',
                text: `ดาวน์โหลดใบเสนอราคา ${confirmedNo}`,
                actions: [
                  {
                    type: 'uri',
                    label: '📥 ดาวน์โหลด PDF',
                    uri: pdfLink
                  }
                ]
              }
            });
            continue;
          }

          // ด่านตรวจกฎรวมก่อนออกเลข (fail-closed — throw ในด่านกลางกลายเป็น SYSTEM_ERROR violation)
          let confirmViolations: import('../services/quotationService.js').Violation[];
          try {
            const { validateQuotationItems } = await import('../services/quotationService.js');
            const r = await validateQuotationItems(currentQuote.items, {
              customerName: currentQuote.customer_name, stage: 'confirm',
              customerId: currentQuote.customer_id, contactId: currentQuote.contact_id
            });
            confirmViolations = r.violations;
          } catch (valErr) {
            console.error('validateQuotationItems on confirm error:', valErr);
            confirmViolations = [{ type: 'SYSTEM_ERROR', model: '-', display_message: '⚠️ ตรวจสอบกฎไม่สำเร็จ กรุณาลองใหม่หรือติดต่อแอดมิน' }];
          }
          if (confirmViolations.length > 0) {
            const { buildViolationText } = await import('../services/quotationService.js');
            replyMessages.push({ type: 'text', text: buildViolationText(confirmViolations) });
            continue;
          }

          // 2. ยืนยันแบบ atomic + idempotent (ออกเลข + เปลี่ยน status ใน transaction เดียว
          //    พร้อม row lock — กันกดพร้อมกันได้เลขซ้ำ/สถานะเพี้ยน และ cancelOldRevision อยู่ใน tx เดียวกัน)
          let confirmResult: ConfirmResult;
          try {
            confirmResult = await confirmQuotationAtomic(qId, currentQuote);
          } catch (err) {
            console.error("confirmQuotationAtomic error:", err);
            replyMessages.push({
              type: 'text',
              text: `❌ เกิดข้อผิดพลาดในการยืนยันใบเสนอราคา ID: ${qId}`
            });
            continue;
          }

          if (confirmResult.outcome === 'not_found') {
            // แถวหายจาก DB = ร่างเดิมถูกลบทับตอนขึ้นร่างใหม่ (ระบบร่างได้ครั้งละ 1 ใบ)
            replyMessages.push({ type: 'text', text: `❌ ใบเสนอราคาฉบับนี้ถูกแทนที่แล้ว\nด้วยฉบับล่าสุด (ร่างได้ครั้งละ 1 ใบ)\n👉 กรุณาเริ่มรายการใหม่ครับ` });
            continue;
          }
          if (confirmResult.outcome === 'cancelled') {
            replyMessages.push({ type: 'text', text: `❌ ใบเสนอราคานี้ถูกยกเลิกไปแล้ว ไม่สามารถยืนยันได้` });
            continue;
          }

          // confirmed และ already_confirmed → ตอบผลสำเร็จเหมือนกัน (ผู้กดยืนยันต้องเห็น ✅ เสมอ)
          const quoteNo = confirmResult.quotationNo;
          const pdfLink = buildPdfLink(reqUrl, qId, quoteNo);
          replyMessages.push({
            type: 'text',
            text: `✅ ยืนยันสำเร็จ!\n📄 ใบเสนอราคาเลขที่: ${quoteNo}`
          });
          replyMessages.push({
            type: 'template',
            altText: `ดาวน์โหลดใบเสนอราคา ${quoteNo} (PDF)`,
            template: {
              type: 'buttons',
              text: `ดาวน์โหลดใบเสนอราคา ${quoteNo}`,
              actions: [
                {
                  type: 'uri',
                  label: '📥 ดาวน์โหลด PDF',
                  uri: pdfLink
                }
              ]
            }
          });

          // บันทึกลง messages เพื่อเคลียร์ประวัติในบอท
          try {
            await insertMessage({
              user_id: userId,
              message_id: `postback_confirm_${Date.now()}`,
              type: 'postback',
              content: 'ยืนยันออกใบเสนอราคา',
              reply_token: event.replyToken,
              reply_content: `✅ ยืนยันสำเร็จ!\n📄 ใบเสนอราคาเลขที่: ${quoteNo}`
            });
          } catch (err) {
            console.error("Error logging confirm postback:", err);
          }
        }
        const finalMessages = replyMessages.slice(0, 5);
        return lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: finalMessages
        });
      }

      if (action === 'select_company') {
        const custId = params.get('custId');
        if (!custId) {
          return lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '❌ ข้อมูลไม่ถูกต้องหรือเซสชันหมดอายุ' }]
          });
        }

        // Fetch pending quotations for this user (ค้างได้ไม่จำกัดจนกว่าจะยืนยัน/ยกเลิก/ถูกทับ)
        let pendingQuotes: any[] = [];
        try {
          const selectRes = await pool.query(
            "SELECT * FROM quotations WHERE user_id = $1 AND status = 'pending_company' ORDER BY created_at DESC",
            [userId]
          );
          const enrichPromises = selectRes.rows.map(q => enrichQuotationData(q));
          pendingQuotes = await Promise.all(enrichPromises);
        } catch (err) {
          console.error("Error fetching pending quotes in select_company:", err);
        }

        if (pendingQuotes.length === 0) {
          return lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '❌ เซสชันหมดอายุหรือไม่มีใบเสนอราคาที่กำลังดำเนินการ' }]
          });
        }

        // Find customer ID
        let customer: any = null;
        try {
          const compRes = await pool.query(
            // customers_data_view: 1 แถว/ผู้ติดต่อ → DISTINCT ON ให้เหลือ 1 แถว/บริษัท
            `SELECT DISTINCT ON (company_id) company_id AS id, customer_name AS display_name
             FROM customers_data_view WHERE company_id = $1 ORDER BY company_id, contact_id LIMIT 1`,
            [custId]
          );
          if (compRes.rows.length > 0) {
            customer = compRes.rows[0];
          }
        } catch (err) {
          console.error("Error fetching customer in select_company:", err);
        }

        if (!customer) {
          return lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: `❌ ไม่พบข้อมูลบริษัทในระบบ` }]
          });
        }

        const companyName = customer.display_name;
        const quoteIdsStr = pendingQuotes.map((q: any) => q.id).join(',');

        const parts = pendingQuotes[0].customer_name.split('|');
        const contactQuery = parts[1] ? parts[1].trim() : '';

        const result = await resolveContactFlow(
          userId,
          quoteIdsStr,
          customer.id,
          companyName,
          contactQuery,
          null,
          salesperson
        );

        if (result.success) {
          const summary = await getQuotationSummaryMessage(result.quotes);
          return lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: summary.messages as any
          });
        } else {
          let messages: any[];
          if (result.type === 'flex') {
            messages = [result];
          } else {
            messages = [{ type: 'text', text: result.text }];
            if (result.quickReply) {
              messages[0].quickReply = result.quickReply;
            }
          }
          return lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: messages
          });
        }
      }

      if (action === 'select_contact') {
        const contactId = params.get('contactId');

        // Fetch pending quotations for this user (ค้างได้ไม่จำกัดจนกว่าจะยืนยัน/ยกเลิก/ถูกทับ)
        let pendingQuotes: any[] = [];
        try {
          const selectRes = await pool.query(
            "SELECT * FROM quotations WHERE user_id = $1 AND status = 'pending_contact' ORDER BY created_at DESC",
            [userId]
          );
          const enrichPromises = selectRes.rows.map(q => enrichQuotationData(q));
          pendingQuotes = await Promise.all(enrichPromises);
        } catch (err) {
          console.error("Error fetching pending quotes in select_contact:", err);
        }

        if (pendingQuotes.length === 0) {
          return lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '❌ เซสชันหมดอายุหรือไม่มีใบเสนอราคาที่กำลังดำเนินการ' }]
          });
        }

        if (!contactId) {
          return lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '❌ ข้อมูลผู้ติดต่อไม่ถูกต้อง' }]
          });
        }

        let dbContact: any = null;
        try {
          const contactRes = await pool.query(
            `SELECT contact_name AS name, company_id AS customer_id
             FROM customers_data_view WHERE contact_id = $1 LIMIT 1`,
            [contactId]
          );
          if (contactRes.rows.length > 0) {
            dbContact = contactRes.rows[0];
          }
        } catch (err) {
          console.error("Error fetching contact in select_contact:", err);
        }

        if (!dbContact) {
          return lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '❌ ไม่พบข้อมูลผู้ติดต่อในระบบ' }]
          });
        }

        const contactName = dbContact.name;
        const resolvedCustomerId = dbContact.customer_id;

        const quoteIds = pendingQuotes.map((q: any) => q.id);
        const parts = pendingQuotes[0].customer_name.split('|');
        const companyName = parts[0] ? parts[0].trim() : '';

        // รายชื่อผู้ติดต่อค้นข้ามนิติบุคคล (getRelatedContactsByCustomerId) การกดเลือกคนจึงเป็น
        // การเลือกบริษัทไปในตัว — ใบต้องย้ายไปผูกบริษัทของคนที่เลือก ไม่ใช่บริษัทที่ค้นเจอตอนแรก
        // ชื่อบริษัทใน snapshot ถูก updateQuotationCustomerSnapshot ดึงใหม่จากคู่ที่ผูกจริง
        // (ดู companyNameOfRow) ตรงนี้จึง log ไว้ให้ตามรอยได้เวลาใบเปลี่ยนบริษัทกลางคัน
        if (String(pendingQuotes[0].customer_id ?? '') !== String(resolvedCustomerId ?? '')) {
          console.log(`[select_contact] ผู้ติดต่อ "${contactName}" อยู่ใต้บริษัทพี่น้อง → ย้ายใบจากบริษัท ${pendingQuotes[0].customer_id} ไป ${resolvedCustomerId} (ค้นด้วย "${companyName}")`);
        }

        const finalCustomerName = `${companyName} | ${contactName}`;

        // ด่าน blacklist — จุดเดียวในระบบที่เรียก updateQuotationCustomerSnapshot โดยไม่ผ่าน
        // resolveContactFlow จึงต้องมีด่านของตัวเอง (ดู docs/plan-user-roles-auth.md §4.4)
        // ต้องเช็ค "ก่อน" เรียก ไม่ใช่ให้ snapshot โยน error ออกมา ไม่งั้นจะตกไป catch ด้านล่าง
        // แล้วตอบ "อัปเดตข้อมูลไม่สำเร็จ" ซึ่งเป็นข้อความคนละเรื่อง
        {
          const { isBlacklisted } = await import('../services/blacklistService.js');
          const { checkCreditHold } = await import('../services/creditHoldService.js');
          const { buildViolationText, blacklistViolation, creditHoldViolation, systemErrorViolation } =
            await import('../services/quotationService.js');
          let blockText: string | null = null;
          try {
            if (await isBlacklisted(resolvedCustomerId, contactId)) {
              blockText = buildViolationText([blacklistViolation()]);
            } else {
              const credit = await checkCreditHold(resolvedCustomerId);
              if (credit.held) blockText = buildViolationText([creditHoldViolation(credit)]);
            }
          } catch (err) {
            console.error('[select_contact] customer gate failed (blacklist/credit, fail-closed):', err);
            blockText = buildViolationText([systemErrorViolation()]);
          }
          if (blockText) {
            return lineClient.replyMessage({
              replyToken: event.replyToken,
              messages: [{ type: 'text', text: blockText }]
            });
          }
        }

        // Update all quotations to draft and update customer_details Snapshot
        let updatedQuotes: any[] = [];
        try {
          updatedQuotes = await updateQuotationCustomerSnapshot(quoteIds, finalCustomerName, 'draft', salesperson, resolvedCustomerId, Number(contactId));
        } catch (err) {
          console.error("Error updating snapshot in select_contact:", err);
        }

        if (updatedQuotes.length === 0) {
          return lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '❌ ไม่สามารถอัปเดตข้อมูลใบเสนอราคาได้' }]
          });
        }

        // Generate summary and confirm/cancel options
        const summary = await getQuotationSummaryMessage(updatedQuotes);
        return lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: summary.messages as any
        });
      }
      if (action === 'select_product') {
        const slotIdx = parseInt(params.get('slot') || '-1', 10);
        const pick = parseInt(params.get('pick') || '-1', 10);

        // โหลด + แก้ slot + persist แบบ atomic (SELECT ... FOR UPDATE) กัน lost update เวลากดเลือกรุ่น
        // ซ้อนกัน (KeyedTaskQueue serialize ต่อ user อยู่แล้ว นี่คือ defense-in-depth ชั้นที่สอง)
        // reply/processQuotationRequest ทำนอก transaction เสมอ (ห้าม network ใน tx)
        let outcome: 'no_pending' | 'invalid' | 'next' | 'done' = 'no_pending';
        let slots: any[] = [];
        let billCtx: any = {};
        let nextIdx = -1;
        try {
          await withTransaction(async (client) => {
            const res = await client.query(
              "SELECT * FROM quotations WHERE user_id = $1 AND status = 'pending_product' ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
              [userId]
            );
            const pending = res.rows[0] || null;
            if (!pending) { outcome = 'no_pending'; return; }

            slots = Array.isArray(pending.item_details) ? pending.item_details : [];
            billCtx = pending.customer_details || {};
            const slot = slots[slotIdx];
            if (!slot || slot.resolved || !Array.isArray(slot.candidates) || !slot.candidates[pick]) {
              outcome = 'invalid';
              return;
            }

            // resolve รุ่นที่กดเลือก → คำนวณราคา/ส่วนลดด้วยตรรกะเดียวกับตอนสกัดครั้งแรก (buildResolvedItem)
            const chosen = slot.candidates[pick];
            const { itemForDb } = buildResolvedItem(chosen, slot.item, billCtx);
            slots[slotIdx] = { resolved: true, itemForDb };

            nextIdx = slots.findIndex((s: any) => !s.resolved && Array.isArray(s.candidates) && s.candidates.length > 0);
            if (nextIdx !== -1) {
              // ยังมีรุ่นกำกวมเหลือ → อัปเดต state ไว้ก่อน
              await client.query(
                "UPDATE quotations SET item_details = $1, updated_at = NOW() WHERE id = $2",
                [JSON.stringify(slots), pending.id]
              );
              outcome = 'next';
            } else {
              // ครบทุกรุ่นแล้ว → เคลียร์ pending_product แล้วค่อยเดินหน้าออกใบต่อ (นอก tx)
              await client.query("DELETE FROM quotations WHERE id = $1", [pending.id]);
              outcome = 'done';
            }
          });
        } catch (err) {
          console.error('[select_product] transaction error:', err);
          return lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '❌ เกิดข้อผิดพลาด รบกวนลองใหม่อีกครั้งครับ' }]
          });
        }

        if (outcome === 'no_pending') {
          return lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '❌ เซสชันหมดอายุหรือไม่มีรายการที่รอเลือกรุ่น รบกวนพิมพ์คำสั่งเสนอราคาใหม่อีกครั้งครับ' }]
          });
        }
        if (outcome === 'invalid') {
          return lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '❌ ตัวเลือกไม่ถูกต้องหรือหมดอายุ รบกวนลองใหม่อีกครั้งครับ' }]
          });
        }
        if (outcome === 'next') {
          return lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: buildProductSelectionMessages(slots[nextIdx], nextIdx, userId) as any
          });
        }

        // outcome === 'done'
        const itemsForDb = slots.map((s: any) => s.itemForDb).filter(Boolean);
        checkpoint('สร้างใบเสนอราคาหลังกดเลือกรุ่น');
        const result = await processQuotationRequest(
          userId,
          billCtx.customer_query,
          billCtx.contact_query,
          itemsForDb,
          salesperson
        );

        if (result.success) {
          const summary = await getQuotationSummaryMessage(result.quotes);
          return lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: summary.messages as any
          });
        }
        if (result.type === 'flex') {
          return lineClient.replyMessage({ replyToken: event.replyToken, messages: [result] });
        }
        const productMsgs: any[] = [{ type: 'text', text: result.text }];
        if (result.quickReply) productMsgs[0].quickReply = result.quickReply;
        return lineClient.replyMessage({ replyToken: event.replyToken, messages: productMsgs });
      }
      return;
    }
    if (event.type === "message" && event.message.type === "image") {
      return handleImage(event);
    }
    if (event.type !== 'message') return null;
    const replyToken = event.replyToken || '';
    const messageId = event.message.id;
    const messageType = event.message.type;
    let content = '';
    let botReplyText = '';
    if (event.message.type === 'text') {
      content = event.message.text;

      const trimmedContent = content.trim();

      // 📝 Trigger จากหน้า LIFF แก้ไขใบเสนอราคา หลังกดปุ่ม "บันทึก"
      // หน้า LIFF ไม่ยืนยันออกเอกสารเองแล้ว — บันทึกเสร็จต้องกลับมาสรุปร่างในแชทเสมอ
      // แล้วให้กดยืนยันจากปุ่มใน Flex สรุปนี้เท่านั้น (action=confirm)
      if (trimmedContent.startsWith('📝 บันทึกร่างใบเสนอราคา')) {
        const savedQuoteIds = trimmedContent.match(/[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}/g) || [];
        if (savedQuoteIds.length > 0) {
          try {
            const savedRes = await pool.query(
              `SELECT * FROM quotations
               WHERE id = ANY($1) AND user_id = $2 AND status <> 'confirmed' AND status <> 'cancelled'
               ORDER BY created_at ASC`,
              [savedQuoteIds, userId]
            );
            const savedQuotes = await Promise.all(savedRes.rows.map((q: any) => enrichQuotationData(q)));

            if (savedQuotes.length > 0) {
              const summary = await getQuotationSummaryMessage(savedQuotes);
              try {
                await insertMessage({
                  user_id: userId,
                  message_id: messageId,
                  type: 'text',
                  content: content,
                  reply_token: replyToken,
                  reply_content: summary.summaryText
                });
              } catch (dbErr) {
                console.error("Error logging saved draft message:", dbErr);
              }
              return lineClient.replyMessage({
                replyToken: replyToken,
                messages: summary.messages as any
              });
            }
          } catch (err) {
            console.error("Error processing saved draft trigger:", err);
          }

          return lineClient.replyMessage({
            replyToken: replyToken,
            messages: [{ type: 'text', text: '❌ ไม่พบร่างใบเสนอราคาที่บันทึกไว้ (อาจถูกยืนยันหรือยกเลิกไปแล้ว) รบกวนเริ่มรายการใหม่อีกครั้งครับ' }]
          });
        }
      }

      if (trimmedContent.startsWith('💾 ร่างใบเสนอราคา')) {
        const match = trimmedContent.match(/(?:รหัส):\s*([a-zA-Z0-9,\s-]+)/);
        let quoteIds = '';
        if (match) {
          quoteIds = match[1].trim();
        } else {
          const uuids = trimmedContent.match(/[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}/g);
          if (uuids) {
            quoteIds = uuids.join(',');
          }
        }

        if (quoteIds) {
          // ตอบด้วย Flex สรุปร่างเต็ม ๆ เลย (ข้อมูลลูกค้าจะขึ้นเป็น "-" และไม่มีปุ่มยืนยัน
          // จนกว่าจะกดเข้าไปเลือกบริษัท/ผู้ติดต่อในหน้า LIFF — ดู isCustomerInfoIncomplete)
          try {
            const draftRes = await pool.query(
              `SELECT * FROM quotations
               WHERE id = ANY($1) AND user_id = $2 AND status <> 'confirmed' AND status <> 'cancelled'
               ORDER BY created_at ASC`,
              [quoteIds.split(',').map(id => id.trim()).filter(Boolean), userId]
            );
            const draftQuotes = await Promise.all(draftRes.rows.map((q: any) => enrichQuotationData(q)));

            if (draftQuotes.length > 0) {
              const summary = await getQuotationSummaryMessage(draftQuotes);
              try {
                await insertMessage({
                  user_id: userId,
                  message_id: messageId,
                  type: 'text',
                  content: content,
                  reply_token: replyToken,
                  reply_content: summary.summaryText
                });
              } catch (dbErr) {
                console.error("Error logging draft cart message:", dbErr);
              }
              return lineClient.replyMessage({
                replyToken: replyToken,
                messages: summary.messages as any
              });
            }
          } catch (err) {
            console.error("Error processing draft cart trigger:", err);
          }

          return lineClient.replyMessage({
            replyToken: replyToken,
            messages: [{ type: 'text', text: '❌ ไม่พบร่างใบเสนอราคาที่บันทึกไว้ (อาจถูกยืนยันหรือยกเลิกไปแล้ว) รบกวนเริ่มรายการใหม่อีกครั้งครับ' }]
          });
        }
      }

      if (trimmedContent.includes('📄 ยืนยันใบเสนอราคาสำเร็จ')) {
        let quoteIds: string[] = [];
        let quotationNos: string[] = [];

        const match = trimmedContent.match(/(?:รหัส|เลขที่):\s*([a-zA-Z0-9,\s-]+)/);
        if (match) {
          const tokens = match[1].split(',').map(t => t.trim());
          for (const token of tokens) {
            if (token.length === 36) {
              quoteIds.push(token);
            } else if (token.toUpperCase().startsWith('QP-') || token.toUpperCase().startsWith('QT-')) {
              quotationNos.push(token.toUpperCase());
            }
          }
        }

        // Also check for zero-width fallback just in case
        const decodeZeroWidth = (text: string) => {
          const m = text.match(/[\u200b\u200c\u200d]+/);
          if (!m) return '';
          try {
            return m[0].split('\u200d').map(b => {
              if (!b) return '';
              const binary = b.split('').map(c => c === '\u200b' ? '0' : '1').join('');
              return String.fromCharCode(parseInt(binary, 2));
            }).join('');
          } catch (e) {
            return '';
          }
        };

        const zeroWidthDecoded = decodeZeroWidth(trimmedContent);
        if (zeroWidthDecoded) {
          quoteIds = quoteIds.concat(zeroWidthDecoded.split(','));
        }

        try {
          let quotes: any[] | null = null;

          if (quoteIds.length > 0) {
            // Fetch quotation details from postgresdb using IDs (กรอง user_id กันดึงใบคนอื่น)
            quotes = await getQuotationsByIds(quoteIds, userId);
          } else if (quotationNos.length > 0) {
            // Fetch quotation details from postgresdb using quotation numbers (กรอง user_id)
            quotes = await getQuotationsByNos(quotationNos, userId);
          } else {
            // Fallback: Query the latest confirmed quotations for this user in the last 1 minute
            const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
            quotes = await getRecentConfirmedQuotations(userId, oneMinuteAgo);
          }

          if (quotes && quotes.length > 0) {
            const reqUrl = getAppUrl();
            const messages: any[] = [];

            for (const q of quotes) {
              const quoteNo = q.quotation_no || '-';
              const pdfLink = buildPdfLink(reqUrl, q.id, q.quotation_no);

              messages.push({
                type: 'text',
                text: `✅ ยืนยันสำเร็จ!\n📄 ใบเสนอราคาเลขที่: ${quoteNo}`
              });

              messages.push({
                type: 'template',
                altText: `ดาวน์โหลดใบเสนอราคา ${quoteNo} (PDF)`,
                template: {
                  type: 'buttons',
                  text: `ดาวน์โหลดใบเสนอราคา ${quoteNo}`,
                  actions: [
                    {
                      type: 'uri',
                      label: '📥 ดาวน์โหลด PDF',
                      uri: pdfLink
                    }
                  ]
                }
              });
            }

            const finalMessages = messages.slice(0, 5);

            return lineClient.replyMessage({
              replyToken: replyToken,
              messages: finalMessages
            });
          }
        } catch (err) {
          console.error("Error processing confirm quote trigger:", err);
        }
      }

      if (trimmedContent === '🎉 ลงทะเบียนพนักงานขายสำเร็จ' || trimmedContent === '✅ อัปเดตข้อมูลพนักงานขายสำเร็จ') {
        const isRegistering = trimmedContent === '🎉 ลงทะเบียนพนักงานขายสำเร็จ';
        try {
          // Fetch salesperson profile
          const sp = await getSalespersonByUserId(userId);

          if (sp) {
            // Fetch branch names
            const selectedCodes = sp.branch_code ? sp.branch_code.split(',').map((c: any) => c.trim()).filter(Boolean) : [];
            let branchNames = sp.branch_code || 'ไม่ได้เลือกสาขา';
            if (selectedCodes.length > 0) {
              const branches = getBranchesByCodes(selectedCodes);
              if (branches && branches.length > 0) {
                branchNames = branches.map((b: any) => b.name).join(', ');
              }
            }

            let msg = '';
            if (isRegistering) {
              msg = `ลงทะเบียนสำเร็จเรียบร้อยแล้วครับ! 🎉\n\n👤 คุณ: ${sp.name}\n🏢 สังกัดสาขา: ${branchNames}`;
              if (sp.salesperson_id) msg += `\n🆔 รหัสพนักงาน: ${sp.salesperson_id}`;
              if (sp.phone) msg += `\n📞 เบอร์โทร: ${sp.phone}`;
              msg += `\n\nตอนนี้ระบบพร้อมใช้งานแล้วครับ คุณสามารถพิมพ์สั่งเช็คสต็อกสินค้าหรือพิมพ์ขอให้ออกใบเสนอราคาได้ทันทีครับ 🤖✨`;
            } else {
              msg = `✅ อัปเดตข้อมูลส่วนตัวและสาขาดูแลสำเร็จเรียบร้อยแล้วครับ!\n\n👤 คุณ: ${sp.name}\n🏢 สาขาที่ดูแลในปัจจุบัน: ${branchNames}`;
              if (sp.salesperson_id) msg += `\n🆔 รหัสพนักงาน: ${sp.salesperson_id}`;
              if (sp.phone) msg += `\n📞 เบอร์โทร: ${sp.phone}`;
            }

            return lineClient.replyMessage({
              replyToken: replyToken,
              messages: [{ type: 'text', text: msg }]
            });
          }
        } catch (err) {
          console.error("Error processing profile update reply:", err);
        }
      }

      if (trimmedContent.includes('[DRAFT_CART]:')) {
        const match = trimmedContent.match(/\[DRAFT_CART\]:ids=([^&]+)&count=(\d+)/);
        if (match) {
          const quoteIds = match[1];
          const count = parseInt(match[2]);
          const flexMsg = createCartConfirmationFlex(quoteIds, count, userId);
          return lineClient.replyMessage({
            replyToken: replyToken,
            messages: [flexMsg as any]
          });
        }
      }

      // 🔎 Trigger: พิมพ์เลขที่ใบเสนอราคาล้วน ๆ (เช่น "QT-260705020") → ตอบปุ่มดาวน์โหลด PDF
      // ใช้กับ LINE PC ที่ liff.sendMessages ใช้ไม่ได้ และใช้ขอ PDF ย้อนหลังได้ทุกเมื่อ
      // gate เฉพาะ status 'active' เพื่อไม่ชน flow แก้ไขใบ (edit_quote_number) ที่ user พิมพ์เลขที่เช่นกัน
      //
      // รูปแบบเลขที่ (รวมใบฉบับแก้ไข "-01") อยู่ที่ parseQuotationNosFromText ที่เดียว
      // — เดิมเขียน regex ไว้ตรงนี้เป็น -R[0-9]+ ซึ่งไม่มีอยู่จริง ใบ revision จึงขอ PDF ไม่ได้
      //
      const quotationNos =
        salesperson.status === 'active' ? parseQuotationNosFromText(trimmedContent) : null;
      if (quotationNos) {
        try {
          const quotes = await getQuotationsByNos(quotationNos, userId);

          if (quotes && quotes.length > 0) {
            const reqUrl = getAppUrl();
            const messages: any[] = [];
            for (const q of quotes) {
              const quoteNo = q.quotation_no || '-';
              const pdfLink = buildPdfLink(reqUrl, q.id, q.quotation_no);
              messages.push({
                type: 'template',
                altText: `ดาวน์โหลดใบเสนอราคา ${quoteNo} (PDF)`,
                template: {
                  type: 'buttons',
                  text: `ดาวน์โหลดใบเสนอราคา ${quoteNo}`,
                  actions: [
                    {
                      type: 'uri',
                      label: '📥 ดาวน์โหลด PDF',
                      uri: pdfLink
                    }
                  ]
                }
              });
            }
            return lineClient.replyMessage({
              replyToken: replyToken,
              messages: messages.slice(0, 5)
            });
          }

          return lineClient.replyMessage({
            replyToken: replyToken,
            messages: [{ type: 'text', text: `❌ ไม่พบใบเสนอราคาเลขที่: ${quotationNos.join(', ')}` }]
          });
        } catch (err) {
          console.error("Error processing quotation-number trigger:", err);
        }
      }

      // 🤖 Agent: แก้ไขใบเสนอราคาผ่านแชท (เช่น "แก้ไข QP-260705030 เพิ่มจำนวน RP-03W-C-1 อีก 2 ตัว")
      // ต้องมีเลขที่ใบ + คำสั่งแก้ไข — AI จะสร้างฉบับแก้ไข (revision) เป็นร่างให้กดยืนยัน
      if (salesperson.status === 'active') {
        const editIntent = detectQuotationEditIntent(trimmedContent);
        if (editIntent) {
          try {
            const res = await handleQuotationEditRequest({
              userId,
              quoteNo: editIntent.quoteNo,
              instruction: editIntent.instruction,
              salesperson
            });
            try {
              await insertMessage({
                user_id: userId,
                message_id: messageId,
                type: messageType,
                content: content,
                reply_token: replyToken,
                reply_content: res.replyText
              });
            } catch (logErr) {
              console.error('Error logging quotation-edit turn:', logErr);
            }
            return lineClient.replyMessage({
              replyToken: replyToken,
              messages: res.messages
            });
          } catch (err) {
            console.error('Error handling quotation-edit request:', err);
            return lineClient.replyMessage({
              replyToken: replyToken,
              messages: [{ type: 'text', text: '⚠️ ขออภัยครับ ระบบแก้ไขใบเสนอราคาขัดข้องชั่วคราว รบกวนลองใหม่อีกครั้งครับ' }]
            });
          }
        }

        // คำสั่งแนวแก้ไข แต่ไม่ได้ระบุเลขที่ใบ (เช่น "แก้ไขส่วนลดเป็น 30%")
        // → ไม่ส่งให้ LLM เดา แต่ถามเลขที่ใบ + โชว์เมนูแก้ไข เพื่อให้เซลส์แก้ผ่านหน้า LIFF
        else if (
          /^(แก้ไข|แก้|เปลี่ยน|ปรับ)/.test(trimmedContent) &&
          trimmedContent.replace(/\s/g, '').length > 6 &&
          !['แก้ไขข้อมูล', 'เมนูแก้ไข'].includes(trimmedContent)
        ) {
          return lineClient.replyMessage({
            replyToken: replyToken,
            messages: [
              { type: 'text', text: 'ต้องการแก้ไขใบเสนอราคาใบไหนครับ?\nรบกวนพิมพ์พร้อมเลขที่ใบ เช่น "แก้ไข QP-260705001"\nหรือกดปุ่มเพื่อเลือกเมนูด้านล่างครับ 👇' },
              createEditMenuFlex(userId) as any
            ]
          });
        }
      }

      const cleanText = content.trim().toLowerCase();

      if (['แก้ไข', '/edit', 'edit', 'แก้ไขข้อมูล', 'เมนูแก้ไข'].includes(cleanText)) {
        const flexMsg = createEditMenuFlex(userId);
        return lineClient.replyMessage({
          replyToken: replyToken,
          messages: [flexMsg as any]
        });
      }


      
      // 2. Check if salesperson is editing profile fields
      if (salesperson.status && salesperson.status.startsWith('edit_field:salesperson:')) {
        let val = content.trim();
        const field = salesperson.status.split(':')[2];
        
        if (val.toLowerCase() === 'ยกเลิก' || val === 'cancel') {
          await updateSalespersonByUserId(userId, { status: 'active' });
          return lineClient.replyMessage({
            replyToken: replyToken,
            messages: [{ type: 'text', text: '❌ ยกเลิกการแก้ไขข้อมูลส่วนตัว' }]
          });
        }
        
        const updates: any = {};
        updates[field] = val === '-' ? null : val;
        updates.status = 'active';
        await updateSalespersonByUserId(userId, updates);
        
        const updatedSp = await getSalespersonByUserId(userId);
        const branches = getStaticBranches();
        const flexMsg = createSalespersonProfileFlex(updatedSp, branches || []);
        
        return lineClient.replyMessage({
          replyToken: replyToken,
          messages: [
            { type: 'text', text: '✅ อัปเดตข้อมูลส่วนตัวสำเร็จเรียบร้อยครับ!' },
            flexMsg as any
          ]
        });
      }

      if (salesperson.status === 'edit_quote_number') {
        let val = content.trim().toUpperCase();

        if (val === 'ยกเลิก' || val === 'CANCEL') {
          await updateSalespersonByUserId(userId, { status: 'active' });
          return lineClient.replyMessage({
            replyToken: replyToken,
            messages: [{ type: 'text', text: '❌ ยกเลิกการแก้ไขใบเสนอราคา' }]
          });
        }

        // ดึงเฉพาะเลขที่ใบเสนอราคาออกจากข้อความ (เผื่อเซลส์พิมพ์เป็นประโยค เช่น "แก้ไข QP-260705001 ลด 30%")
        const qnoMatch = val.match(/(QP|QT)-\d{6,}(?:-\d+)?/i);
        if (!qnoMatch) {
          // ไม่มีเลขที่ใบเลย → หลุดจากโหมดรอเลขที่ใบอัตโนมัติ แล้วตอบให้เหมาะกับสิ่งที่พิมพ์
          await updateSalespersonByUserId(userId, { status: 'active' });
          salesperson.status = 'active';

          // ยังเป็นคำสั่งแนวแก้ไข → แนะนำวิธีที่ถูกต้องพร้อมเมนู
          if (/^(แก้ไข|แก้|เปลี่ยน|ปรับ)/.test(trimmedContent)) {
            return lineClient.replyMessage({
              replyToken: replyToken,
              messages: [
                { type: 'text', text: 'หากต้องการแก้ไขใบเสนอราคา รบกวนพิมพ์พร้อมเลขที่ใบ เช่น "แก้ไข QP-260705001" หรือกดปุ่มด้านล่างครับ 👇' },
                createEditMenuFlex(userId) as any
              ]
            });
          }
          // ไม่ใช่คำสั่งแก้ไข → ไม่ return ปล่อยให้ประมวลผลข้อความตามปกติด้านล่าง (LLM)
        } else {
          val = qnoMatch[0].toUpperCase();

          let baseQuoteNo = val;
          const match = val.match(/^((?:QP|QT)-\d+)(-\d+)$/i);
          if (match) {
            baseQuoteNo = match[1];
          }

          let quotes: any[] = [];
          try {
            const res = await pool.query(
              "SELECT * FROM quotations WHERE quotation_no = $1 OR quotation_no ILIKE $2",
              [baseQuoteNo, `${baseQuoteNo}-%`]
            );
            const enrichPromises = res.rows.map(q => enrichQuotationData(q));
            quotes = await Promise.all(enrichPromises);
          } catch (quoteError) {
            console.error("Fetch quote error:", quoteError);
            return lineClient.replyMessage({
              replyToken: replyToken,
              messages: [{ type: 'text', text: '❌ เกิดข้อผิดพลาดในการค้นหาข้อมูลใบเสนอราคา' }]
            });
          }

          let quote: any = null;
          if (quotes && quotes.length > 0) {
            quotes.sort((a: any, b: any) => {
              const getRev = (qNo: string) => {
                const m = qNo.match(/^((?:QP|QT)-\d+)-(\d+)$/i);
                return m ? parseInt(m[2]) : 0;
              };
              return getRev(b.quotation_no) - getRev(a.quotation_no);
            });
            quote = quotes[0];
          }

          if (!quote) {
            return lineClient.replyMessage({
              replyToken: replyToken,
              messages: [{
                type: 'text',
                text: `❌ ไม่พบใบเสนอราคาเลขที่ "${val}" ในระบบ\nกรุณาตรวจสอบเลขที่และพิมพ์ส่งเข้ามาใหม่อีกครั้งครับ หรือพิมพ์ "ยกเลิก" เพื่อยกเลิก`
              }]
            });
          }

          // ตรวจกฎก่อนสร้างร่าง revision (เดิมข้ามการตรวจ) — reply แบบเดียวกับ error อื่นใน handler นี้
          let revExpandedItems = quote.items;
          {
            const { validateQuotationItems, buildViolationText } = await import('../services/quotationService.js');
            const { items: revExpanded, violations: revV } = await validateQuotationItems(quote.items, {
              stage: 'draft', customerId: quote.customer_id, contactId: quote.contact_id
            });
            if (revV.length > 0) {
              return lineClient.replyMessage({
                replyToken: replyToken,
                messages: [{ type: 'text', text: buildViolationText(revV) }]
              });
            }
            revExpandedItems = revExpanded;
          }

          const revisedCustomerName = appendReviseFrom(quote.customer_name, quote.quotation_no);

          try {
            await pool.query(
              "UPDATE quotations SET status = 'cancelled' WHERE user_id = $1 AND status = ANY($2)",
              [userId, ['pending_company', 'pending_contact', 'draft']]
            );
          } catch (err) {
            console.error("Error cancelling pending quotations:", err);
          }

          // insert ด้วย revExpandedItems จาก validateQuotationItems ด้านบน — gate นั้น expand สินค้าพ่วงให้แล้ว
          // (ใบเก่าอาจไม่เคยผ่าน expand — กฎคู่สินค้าหลัก-เสริม ต้องพ่วงให้ครบตอนคัดลอกมาแก้)
          let newQuote: any = null;
          try {
            const insertedQuotes = await insertDraftQuotations(userId, revisedCustomerName, revExpandedItems, 'draft', quote.customer_id, quote.contact_id);
            if (insertedQuotes && insertedQuotes.length > 0) {
              newQuote = insertedQuotes[0];
            }
          } catch (insertError) {
            console.error("Insert revised quote error:", insertError);
          }

          if (!newQuote) {
            return lineClient.replyMessage({
              replyToken: replyToken,
              messages: [{ type: 'text', text: '❌ ไม่สามารถคัดลอกข้อมูลใบเสนอราคาเพื่อแก้ไขได้' }]
            });
          }

          await updateSalespersonByUserId(userId, { status: 'active' });

          const flexMsg = createRevisionFlex(quote.quotation_no, newQuote.id, userId);
          return lineClient.replyMessage({
            replyToken: replyToken,
            messages: [flexMsg as any]
          });
        }
      }
    } else {
      content = `[Received ${messageType} message]`;
      botReplyText = `ได้รับข้อความประเภท ${messageType} แล้วครับ`;
    }
    // 4.1 ให้ Gemini/Deepseek ช่วยคิดคำตอบ (ถ้าเป็นข้อความ)
    if (event.message.type === 'text' && content) {
      // ── ข้อความดิบ → ร่างใบ: ย้ายออกไปที่ services/quoteExtraction.ts ทั้งก้อนแล้ว (เฟส C) ──
      // ประวัติแชท + prompt + retry + findProduct + slots อยู่ในนั้นหมด · ที่นี่เหลือแค่เรียก 1 ครั้ง
      // แล้วเอาผลไปเรนเดอร์ Flex เหมือนเดิมทุกบรรทัด · remainingMs/checkpoint ส่งของเดิมเข้าไปตรง ๆ
      // จึงยังนับงบเวลาและถูก abort ที่จุดเดิมเป๊ะ
      const extracted = await extractQuoteFromText({ userId, text: content, remainingMs, checkpoint });
      const aiResult = extracted.raw;

      if (aiResult.intent === 'REGISTER') {
        const flexMsg = createBranchSelectionFlex('', userId);
        return lineClient.replyMessage({
          replyToken: replyToken,
          messages: [
            { type: 'text', text: 'คุณสามารถลงทะเบียนหรือปรับปรุงข้อมูลพนักงานขายได้โดยตรงผ่านลิงก์นี้ครับ' },
            flexMsg as any
          ]
        });
      } else if (aiResult.intent === 'QUOTATION' && aiResult.quotation_data && aiResult.quotation_data.items && aiResult.quotation_data.items.length > 0) {
        // ค่าทุกตัวข้างล่างนี้คำนวณเสร็จมาแล้วจาก extractQuoteFromText (เฟส C ย้ายออกไปทั้งก้อน)
        // ที่เหลือในนี้คือ "เอา slots ไปเรนเดอร์ Flex" ซึ่งเป็นของ LINE ล้วน ๆ ไม่ได้ย้ายไปไหน
        // (successReport / totalSum ที่ service คำนวณไว้ ฝั่ง LINE ไม่ได้ใช้มาแต่เดิม — ไม่ดึงมา)
        const quoteData: any = extracted.quoteData;
        const slots: any[] = extracted.slots!;
        const isAllValid = extracted.isAllValid!;
        const hasNotFoundIssue = extracted.hasNotFoundIssue!;
        const itemReports = extracted.itemReports!;
        const itemsForDb = extracted.itemsForDb!;
        const issueCount = extracted.issueCount!;

        const ambiguousSlots = slots.filter((s: any) => !s.resolved && s.candidates && s.candidates.length > 0);
        const hasHardNotFound = slots.some((s: any) => !s.resolved && (!s.candidates || s.candidates.length === 0));

        if (!isAllValid && ambiguousSlots.length > 0 && !hasHardNotFound) {
          // ── ปุ่มเลือกรุ่น: รุ่นที่ไม่พบทั้งหมดเป็นแบบ "กำกวมมี candidate" → เก็บ context ค้าง (pending_product) แล้วให้กดเลือก ──
          const billCtx = {
            customer_query: quoteData.customer_query ?? null,
            contact_query: quoteData.contact_query ?? null,
            discount_1: Number(quoteData.discount_1) || 0,
            discount_2: Number(quoteData.discount_2) || 0,
            discount_is_net: !!quoteData.discount_is_net
          };
          try {
            await pool.query(
              "INSERT INTO quotations (user_id, status, customer_details, item_details) VALUES ($1, 'pending_product', $2, $3)",
              [userId, JSON.stringify(billCtx), JSON.stringify(slots)]
            );
          } catch (err) {
            console.error('[quotation] insert pending_product error:', err);
          }
          const firstIdx = slots.findIndex((s: any) => !s.resolved && s.candidates && s.candidates.length > 0);
          customMessages = buildProductSelectionMessages(slots[firstIdx], firstIdx, userId);
          botReplyText = `พบหลายรุ่นใกล้เคียง กรุณากดเลือกรุ่นที่ถูกต้อง`;
        } else if (!isAllValid) {
          let headerText = '❌ ยังไม่สามารถออกใบเสนอราคาได้\n';
          if (hasNotFoundIssue) {
            headerText += `พบรุ่นที่ไม่ชัดเจน ${issueCount} รายการ \n\nกรุณาพิมพ์ชื่อรุ่นที่ถูกต้องอีกครั้งนะครับ\n\n`;
          } else {
            headerText += `พบปัญหาเรื่องสินค้า ${issueCount} รายการ \n\nรบกวนตรวจสอบอีกครั้งนะครับ\n\n`;
          }
          botReplyText = headerText + itemReports.trim();

          const messages: any[] = [
            { type: 'text', text: botReplyText }
          ];

          const liffProductSearchId = process.env.LIFF_PRODUCT_SEARCH_ID || process.env.LIFF_QUOTE_ID || '';
          if (liffProductSearchId) {
            let firstFailCode = '';
            const failItem = quoteData.items.find((item: any) => item && (item.model || item.product_code));
            if (failItem) {
              firstFailCode = String(failItem.model || failItem.product_code || '').trim();
            }

            let searchLiffUrl = `https://liff.line.me/${liffProductSearchId}?userId=${userId}`;
            if (firstFailCode) {
              searchLiffUrl += `&q=${encodeURIComponent(firstFailCode)}`;
            }

            messages.push({
              type: "flex",
              altText: "ค้นหาสินค้าเพิ่มเติม / เตรียมออกใบเสนอราคา",
              contents: {
                type: "bubble",
                size: "kilo",
                body: {
                  type: "box",
                  layout: "vertical",
                  spacing: "sm",
                  paddingAll: "12px",
                  contents: [
                    {
                      type: "button",
                      action: {
                        type: "uri",
                        label: "🔎 ค้นหาสินค้าเพิ่มเติม",
                        uri: searchLiffUrl
                      },
                      style: "primary",
                      color: "#2563EB",
                      height: "sm"
                    }
                  ]
                }
              }
            });
          }
          customMessages = messages;
        } else {
          checkpoint('ค้นหาลูกค้า + บันทึกใบเสนอราคา');
          const result = await processQuotationRequest(
            userId,
            quoteData.customer_query,
            quoteData.contact_query,
            itemsForDb,
            salesperson
          );

          if (result.success) {
            const summary = await getQuotationSummaryMessage(result.quotes);
            customMessages = summary.messages;
            botReplyText = summary.summaryText;
          } else {
            if (result.type === 'flex') {
              customMessages = [result];
              botReplyText = result.altText || 'กรุณาเลือกรายการ';
            } else {
              const messages: any[] = [{ type: 'text', text: result.text }];
              if (result.quickReply) {
                messages[0].quickReply = result.quickReply;
              }
              customMessages = messages;
              botReplyText = result.text;
            }
          }
        }
      } else if (aiResult.intent === 'PRODUCT_INFO' && aiResult.product_query && 
                 ((aiResult.product_query.models && aiResult.product_query.models.length > 0) || 
                  (aiResult.product_query.product_codes && aiResult.product_query.product_codes.length > 0))) {
        const queryModels = aiResult.product_query.models || aiResult.product_query.product_codes || [];
        let infoReport = "";
        checkpoint(`ค้นหาสินค้า ${queryModels.length} รายการ (PRODUCT_INFO)`);
        const infoPromises = queryModels.map(async (codeRaw: any) => {
          const result = await findProduct(codeRaw, content);
          return { codeRaw, result };
        });
        const infoResults = await Promise.all(infoPromises);

        for (const { codeRaw, result } of infoResults) {
          if (result.found && result.product) {
            const dbProduct = result.product;
            const price = Number(dbProduct.sales_price) || 0;
            const stock = Number(dbProduct.quantity_on_hand_unreserved) || 0;
            infoReport += `ข้อมูลสินค้า [${dbProduct.model}]:\n`;
            infoReport += `📂 หมวดหมู่: ${dbProduct.product_category}\n`;
            infoReport += `💵 ราคา: ${price.toLocaleString()} บาท\n`;
            infoReport += `📦 สต๊อกพร้อมส่ง: ${stock} ชิ้น\n`;
            infoReport += `-------------------------\n`;
          } else {
            infoReport += `🔍 ค้นหารุ่น "${codeRaw}":\n${result.report}`;
          }
        }
        botReplyText = infoReport.trim();

        const messages: any[] = [
          { type: 'text', text: botReplyText }
        ];

        const liffProductSearchId = process.env.LIFF_PRODUCT_SEARCH_ID || process.env.LIFF_QUOTE_ID || '';
        if (liffProductSearchId) {
          const firstCode = queryModels[0] || '';
          let searchLiffUrl = `https://liff.line.me/${liffProductSearchId}?userId=${userId}`;
          if (firstCode) {
            searchLiffUrl += `&q=${encodeURIComponent(firstCode)}`;
          }

          messages.push({
            type: "flex",
            altText: "ค้นหาสินค้าเพิ่มเติม / เตรียมออกใบเสนอราคา",
            contents: {
              type: "bubble",
              size: "kilo",
              body: {
                type: "box",
                layout: "vertical",
                spacing: "sm",
                paddingAll: "12px",
                contents: [
                  {
                    type: "button",
                    action: {
                      type: "uri",
                      label: "🔎 ค้นหาสินค้าเพิ่มเติม",
                      uri: searchLiffUrl
                    },
                    style: "primary",
                    color: "#2563EB",
                    height: "sm"
                  }
                ]
              }
            }
          });
        }
        customMessages = messages;
      } else {
        // UNCLEAR or other intent (pending ค้างได้ไม่จำกัดจนกว่าจะยืนยัน/ยกเลิก/ถูกทับ)
        let pendingQuotes: any[] = [];
        try {
          const selectRes = await pool.query(
            "SELECT * FROM quotations WHERE user_id = $1 AND status = ANY($2) ORDER BY created_at DESC",
            [userId, ['pending_company', 'pending_contact']]
          );
          const enrichPromises = selectRes.rows.map(q => enrichQuotationData(q));
          pendingQuotes = await Promise.all(enrichPromises);
        } catch (err) {
          console.error("Error fetching pending quotes in UNCLEAR:", err);
        }

        if (pendingQuotes && pendingQuotes.length > 0) {
          const latestStatus = pendingQuotes[0].status;

          if (['ยกเลิก', 'cancel', 'ยกเลิกการออกใบเสนอราคา'].includes(content.trim().toLowerCase())) {
            try {
              await pool.query(
                "DELETE FROM quotations WHERE id = ANY($1)",
                [pendingQuotes.map((q: any) => q.id)]
              );
            } catch (err) {
              console.error("Error deleting quotations in UNCLEAR cancel:", err);
            }

            botReplyText = '❌ ยกเลิกการออกใบเสนอราคาเรียบร้อยแล้ว';
          } else {
            const quoteIdsStr = pendingQuotes.map((q: any) => q.id).join(',');
            const typedVal = content.trim();

            if (latestStatus === 'pending_company') {
              const parts = pendingQuotes[0].customer_name.split('|');
              let contactQuery = parts[1] ? parts[1].trim() : '';
              let companyQuery = typedVal;

              // Backstop: user พิมพ์แก้มาแบบ "บ.X คุณY" บรรทัดเดียว → แยกส่วนผู้ติดต่อออก
              if (companyQuery && !contactQuery) {
                const split = splitCustomerContact(companyQuery);
                if (split.contact) {
                  companyQuery = split.customer;
                  contactQuery = split.contact;
                }
              }

              const customerCandidates = await findCustomerCandidates(companyQuery, salesperson, contactQuery);

              if (customerCandidates.length === 0) {
                const rawName = `${companyQuery} | ${contactQuery}`;
                const customerDetailsTemp = {
                  customer_name: rawName,
                  customer_code: '',
                  customer_tax_id: '',
                  contact_name: contactQuery || '-',
                  phone: '-',
                  email: '-',
                  address: '-',
                  payment_terms: '-',
                  revise_from: null,
                  custom_meta: ''
                };
                
                try {
                  await pool.query(
                    "UPDATE quotations SET customer_details = $1, updated_at = NOW() WHERE id = ANY($2)",
                    [JSON.stringify(customerDetailsTemp), pendingQuotes.map((q: any) => q.id)]
                  );
                } catch (err) {
                  console.error("Error updating customer details in pending_company fallback:", err);
                }

                botReplyText = `❌ ไม่พบชื่อบริษัท "${companyQuery}" ในระบบเลยครับ รบกวนพิมพ์ชื่อบริษัทที่ถูกต้องใหม่อีกครั้ง หรือเลือกบริษัทด้วยตนเองผ่านปุ่มในข้อความ Flex ก่อนหน้า หรือติดต่อแอดมินเพื่อเพิ่มข้อมูลลูกค้าครับ 🏢`;
              } else if (customerCandidates.length > 1) {
                const rawName = `${companyQuery} | ${contactQuery}`;
                const customerDetailsTemp = {
                  customer_name: rawName,
                  customer_code: '',
                  customer_tax_id: '',
                  contact_name: contactQuery || '-',
                  phone: '-',
                  email: '-',
                  address: '-',
                  payment_terms: '-',
                  revise_from: null,
                  custom_meta: ''
                };
                
                try {
                  await pool.query(
                    "UPDATE quotations SET customer_details = $1, updated_at = NOW() WHERE id = ANY($2)",
                    [JSON.stringify(customerDetailsTemp), pendingQuotes.map((q: any) => q.id)]
                  );
                } catch (err) {
                  console.error("Error updating customer details in pending_company multi-candidate:", err);
                }

                const options = dedupeIdenticalCompanies(customerCandidates).slice(0, 12).map((c: any) => ({
                  label: buildCompanyOptionLabel(c),
                  data: `action=select_company&custId=${c.item.id}`,
                  displayText: `เลือก ${c.item.display_name}`
                }));

                const flexMessage = createListFlexMessage(
                  "🏢 เลือกบริษัทที่ถูกต้อง",
                  `พบชื่อบริษัทใกล้เคียงกับ "${companyQuery}" หลายบริษัทเลยครับ กรุณาเลือกบริษัทที่ถูกต้องด้านล่างนี้ครับ 👇`,
                  options
                );

                customMessages = [flexMessage];
                botReplyText = `พบชื่อบริษัทใกล้เคียงกับ "${companyQuery}" หลายบริษัทเลยครับ กรุณาเลือกบริษัทที่ถูกต้องด้านล่างนี้ครับ 👇`;
              } else {
                const selectedCompany = customerCandidates[0].item.display_name;
                const selectedCustomerId = customerCandidates[0].item.id;

                const result = await resolveContactFlow(
                  userId,
                  quoteIdsStr,
                  selectedCustomerId,
                  selectedCompany,
                  contactQuery,
                  null,
                  salesperson
                );

                if (result.success) {
                  const summary = await getQuotationSummaryMessage(result.quotes);
                  customMessages = summary.messages;
                  botReplyText = summary.summaryText;
                } else {
                  if (result.type === 'flex') {
                    customMessages = [result];
                    botReplyText = result.altText || 'กรุณาเลือกรายการ';
                  } else {
                    const messages: any[] = [{ type: 'text', text: result.text }];
                    if (result.quickReply) {
                      messages[0].quickReply = result.quickReply;
                    }
                    customMessages = messages;
                    botReplyText = result.text;
                  }
                }
              }
            } else if (latestStatus === 'pending_contact') {
              const parts = pendingQuotes[0].customer_name.split('|');
              const companyName = parts[0] ? parts[0].trim() : '';
              const contactQuery = typedVal;

              let customer: any = null;
              try {
                const compRes = await pool.query(
                  `SELECT DISTINCT ON (company_id) company_id AS id
                   FROM customers_data_view WHERE customer_name = $1 ORDER BY company_id, contact_id LIMIT 1`,
                  [companyName]
                );
                if (compRes.rows.length > 0) {
                  customer = compRes.rows[0];
                }
              } catch (err) {
                console.error("Error fetching customer in pending_contact:", err);
              }

              if (!customer) {
                botReplyText = `❌ เกิดข้อผิดพลาดในการโหลดข้อมูลบริษัท "${companyName}"`;
              } else {
                const result = await resolveContactFlow(
                  userId,
                  quoteIdsStr,
                  customer.id,
                  companyName,
                  contactQuery,
                  null,
                  salesperson
                );

                if (result.success) {
                  const summary = await getQuotationSummaryMessage(result.quotes);
                  customMessages = summary.messages;
                  botReplyText = summary.summaryText;
                } else {
                  if (result.type === 'flex') {
                    customMessages = [result];
                    botReplyText = result.altText || 'กรุณาเลือกรายการ';
                  } else {
                    const messages: any[] = [{ type: 'text', text: result.text }];
                    if (result.quickReply) {
                      messages[0].quickReply = result.quickReply;
                    }
                    customMessages = messages;
                    botReplyText = result.text;
                  }
                }
              }
            }
          }
        } else {
          // เลือกคำแนะนำตามสิ่งที่เซลส์พิมพ์มา (เรียงลำดับสำคัญ: "เสนอราคา" ต้องมาก่อน "ราคา")
          // - เอ่ยถึง "เสนอราคา" แต่ข้อมูลไม่พอ → ส่งแบบฟอร์มให้ก๊อปไปกรอก
          // - ถามเช็คราคา/เช็คของ แต่ไม่ได้ระบุรุ่น → บอกให้พิมพ์รหัสรุ่นมาด้วย
          // - นอกนั้น (ทักทาย/ถามทั่วไป/ระบบสกัดล่ม) → ตอบตามบริบทที่ LLM สร้างมา
          const lowerContent = content.toLowerCase();
          if (aiResult.extraction_failed) {
            botReplyText = aiResult.reply_message || GREETING_REPLY;
          } else if (content.includes('เสนอราคา')) {
            botReplyText = QUOTATION_FORM_REPLY;
          } else if (PRODUCT_INFO_KEYWORDS.some(kw => lowerContent.includes(kw))) {
            botReplyText = PRODUCT_INFO_HINT_REPLY;
          } else {
            botReplyText = aiResult.reply_message || GREETING_REPLY;
          }
        }
      }
    }
    // 4.2 บันทึกประวัติการแชทลงฐานข้อมูล postgresdb
    await insertMessage({
      user_id: userId,
      message_id: messageId,
      type: messageType,
      content: content,
      reply_token: replyToken,
      reply_content: botReplyText
    });
    // 4.3 ส่งข้อความกลับไปหาผู้ใช้ทาง LINE
    if (customMessages) {
      return await lineClient.replyMessage({
        replyToken: replyToken,
        messages: customMessages,
      });
    }
    return await lineClient.replyMessage({
      replyToken: replyToken,
      messages: [{ type: 'text', text: botReplyText }],
    });
  } catch (error: any) {
    // C.3 — ไม่ใช่ระบบพัง แต่เป็นการหยุดตัวเองเพราะงบหมด (index.ts สั่ง abort และ log [queue] TIMEOUT ไว้แล้ว)
    // ห้าม reply ที่นี่: reply token เป็น single-use และเส้นทางบางเส้นตอบไปแล้วก่อนถึงด่านตรวจ
    // การยิงข้อความ "ระบบขัดข้อง" ทับจะทำให้เซลส์เห็นข้อความผิด — ปล่อยเงียบแล้วไปวัดที่ log แทน
    if (error?.[DEADLINE_ABORT]) {
      console.warn(`[abort] user=${event?.source?.userId || 'unknown'} type=${event?.type} — ${error.message}`);
      return null;
    }
    console.error('เกิดข้อผิดพลาดในการประมวลผลระบบ:', error);
    if (event && event.replyToken) {
      try {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text' as const,
            text: '⚠️ ขออภัย ระบบขัดข้องชั่วคราว\nกรุณาพิมพ์คำสั่งใหม่อีกครั้ง 🙏'
          }]
        });
      } catch (replyErr: any) {
        console.error('ไม่สามารถส่งข้อความแจ้งข้อผิดพลาดกลับไปยังผู้ใช้ได้:', replyErr.message || replyErr);
      }
    }
  }
}
