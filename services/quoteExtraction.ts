// ─────────────────────────────────────────────────────────────────────────────
//  quoteExtraction — "ข้อความดิบ → ร่างใบ" ที่ LINE และหน้าเว็บแอดมินเรียกร่วมกัน
//  เฟส C ของ docs/plan-web-quote-request.md (ขั้น 1′)
//
//  ที่มา: โค้ดก้อนนี้เคยอยู่กลาง handleEvent() ของ handlers/lineHandler.ts (~265 บรรทัด)
//  ซึ่งเป็นชิ้นเดียวของวงจร "ร่าง → แก้ → ยืนยัน → PDF" ที่ยังผูกกับ LINE อยู่
//  ⇒ ย้ายออกมาทั้งก้อนเพื่อให้เส้นทางเว็บเรียกได้โดยไม่ต้องประกอบ event ปลอม
//
//  ⚠️ กติกาเหล็กของไฟล์นี้ (เฟส C ตั้งใจให้ผลลัพธ์เท่าเดิมทุกบิต):
//     * **prompt ต้องเหมือนเดิมทุกตัวอักษร รวมช่องว่างและย่อหน้า** — มันเป็นส่วนหนึ่งของ
//       input ที่โมเดลเห็น · โค้ดที่ย้ายมาจึงคง "ระดับการเยื้อง" เดิมของ handleEvent ไว้
//       ทั้งก้อน ห้ามจัดย่อหน้าใหม่ให้สวย เพราะย่อหน้าคือเนื้อ prompt
//       (ด่าน `npm run diag:line-parity` เทียบ prompt กับ fixtures/extractionPrompt.golden.txt
//        ซึ่งถอดจากซอร์สก่อนย้ายทีละตัวอักษร — แก้ช่องว่างเมื่อไหร่ด่านล้มทันที)
//     * `MAX_EXTRACTION_ATTEMPTS = 3` และเกณฑ์ `remainingMs() < 8_000` ห้ามขยับ
//     * `findProduct` ต้องยิงพร้อมกันด้วย Promise.all เหมือนเดิม
//
//  ค่าปริยายต้อง "ไม่จำกัด/ไม่ตรวจ": ไม่ส่ง remainingMs = ไม่มีงบเวลา · ไม่ส่ง checkpoint =
//  ไม่มีด่านยกเลิก — เส้นทาง CLI/diag/เว็บ จึงเรียกได้โดยไม่ต้องปลอม deadline ของ LINE
// ─────────────────────────────────────────────────────────────────────────────
import { createChatCompletion } from '../config/clients.js';
import { getRecentMessages, deletePendingQuotations } from '../db/repositories.js';
import { findProduct } from './productService.js';
import { calcNetPrice, round2 } from '../utils/pricing.js';

/** สถานะการ resolve ของสินค้า 1 รายการ — เรียงตามลำดับที่เซลส์พิมพ์เสมอ */
export interface QuoteSlot {
  resolved: boolean;
  itemForDb?: any;                 // resolved = true
  item?: any;                      // resolved = false — ของที่ AI สกัดมาได้
  candidates?: any[];              // มี candidate = กำกวม (ให้เลือก) · ไม่มี = พิมพ์ผิด
}

export interface ExtractedQuote {
  intent: 'QUOTATION' | 'REGISTER' | 'PRODUCT_INFO' | 'UNCLEAR' | string;
  extraction_failed?: boolean;     // UNCLEAR เพราะระบบล่ม ไม่ใช่เพราะเซลส์พิมพ์ไม่ชัด
  reply_message?: string;
  /** ผลดิบจาก LLM ทั้งก้อน — ปลายทาง LINE ยังต้องใช้ branch PRODUCT_INFO/REGISTER/UNCLEAR ที่ไม่ได้ย้ายมา */
  raw: any;
  // ── ต่อไปนี้มีเฉพาะเมื่อ intent = QUOTATION และมีรายการสินค้า ──
  quoteData?: any;                 // quotation_data ดิบจาก AI (customer_query / contact_query / …)
  slots?: QuoteSlot[];
  isAllValid?: boolean;
  hasNotFoundIssue?: boolean;
  itemReports?: string;            // รายงานรายการที่มีปัญหา
  successReport?: string;          // ข้อความสรุปรายการที่ resolve ได้
  itemsForDb?: any[];
  totalSum?: number;
  issueCount?: number;
}

export interface ExtractQuoteParams {
  /** ใช้ดึงประวัติแชท + ล้างใบค้างของเจ้าของ id นี้ — เว็บส่ง web:<admin>:<sp> เข้ามา */
  userId: string;
  text: string;
  /** เหลืองบเวลาอีกกี่ ms — ไม่ส่ง = ไม่จำกัด */
  remainingMs?: () => number;
  /** ด่านตรวจก่อนเริ่มขั้นตอนหนัก (C.3) — ไม่ส่ง = ไม่ตรวจ */
  checkpoint?: (step: string) => void;
  /**
   * ล้างใบร่างที่ค้างของ `userId` ทิ้งก่อนสกัดหรือไม่ — **ค่าปริยาย `true` = พฤติกรรมของ LINE เดิมเป๊ะ**
   *
   * ข้อยกเว้นเดียวของ "ค่าปริยาย = ไม่ทำอะไร" ในไฟล์นี้ และตั้งใจให้เป็นแบบนั้น:
   * ทางเดินของ LINE พึ่งพาการล้างตรงนี้อยู่ (แชทไม่มีที่ให้ "ดูก่อนแล้วค่อยกด" — สกัดใหม่
   * = ทิ้งของเก่าเสมอ) ถ้าค่าปริยายเป็น false เส้นทางเดิมจะเปลี่ยนพฤติกรรมเงียบ ๆ
   *
   * หน้าเว็บส่ง `false` เพราะ `proposeFromText()` เป็นแค่การ "ขอดูร่าง" ยังไม่ตัดสินใจอะไร —
   * แค่วางข้อความผิดแล้วไปลบร่างที่แอดมินทำค้างไว้ทิ้ง คือของที่แก้คืนไม่ได้
   * (docs/plan-web-quote-request.md ขั้น 3′ · ด่าน `diag:web-quote` ข้อ 2 ตรวจข้อนี้โดยตรง)
   */
  purgePending?: boolean;
}

// คำนวณรายการสินค้าที่พร้อมบันทึก (ราคา/ส่วนลดสุทธิ) จาก product ในฐานข้อมูล + item ที่เซลส์ระบุ + ส่วนลดระดับบิล
// ใช้ทั้งตอนสกัดครั้งแรก และตอน resume หลังเซลส์กดเลือกรุ่นจากปุ่ม เพื่อให้ตรรกะราคาตรงกันเป๊ะ (ไม่ drift)
export function buildResolvedItem(dbProduct: any, item: any, quoteData: any): { itemForDb: any; itemTotal: number; price: number; disc1: number; disc2: number } {
  const requestedQty = Number(item.quantity) || 1;
  const hasCustomPrice = (item.price !== undefined && item.price !== null && Number(item.price) > 0);
  let price = hasCustomPrice ? Number(item.price) : (Number(dbProduct.sales_price) || 0);
  const isNetDiscount = !!item.discount_is_net || !!quoteData.discount_is_net;
  let disc1 = hasCustomPrice ? 0 : (Number(item.discount_1) > 0 ? Number(item.discount_1) : (Number(quoteData.discount_1) || 0));
  let disc2 = hasCustomPrice ? 0 : (Number(item.discount_1) > 0 ? (Number(item.discount_2) || 0) : (Number(quoteData.discount_2) || 0));
  if (isNetDiscount) {
    // จุดเดียวในระบบที่ปัดเศษราคาต่อหน่วย — ส่วนลดแบบ net เขียนทับ unit price จริง จึงต้องเป็นเลขสวย
    price = round2(calcNetPrice(price, disc1, disc2));
    disc1 = 0;
    disc2 = 0;
  }
  const discountedPrice = calcNetPrice(price, disc1, disc2);
  const itemTotal = requestedQty * discountedPrice;
  const itemForDb = {
    product_id: dbProduct.product_template_id,
    product_code: dbProduct.model,
    model: dbProduct.model,
    name: dbProduct.name,
    brand: dbProduct.brand || '',
    series: dbProduct.series || '',
    quantity: requestedQty,
    price,
    discount_1: disc1,
    discount_2: disc2,
    production: dbProduct.production || ''
  };
  return { itemForDb, itemTotal, price, disc1, disc2 };
}

/**
 * prompt สกัดคำสั่ง — แยกออกมาเป็นฟังก์ชันเพื่อให้ "เทียบทีละตัวอักษร" ได้
 * เนื้อในย้ายมาจาก handleEvent ทั้งก้อนโดยไม่แตะแม้แต่ช่องว่างเดียว (ดูหัวไฟล์)
 * scripts/diag/extractionCore.ts เคยถือสำเนาของ prompt นี้ไว้เองเพื่อใช้ในด่านตรวจ —
 * เฟส C ยุบสำเนานั้นทิ้ง ให้ทุกด่านมาอ่านของจริงจากที่นี่ที่เดียว
 */
export function buildExtractionPrompt(content: string, historyContext = ''): string {
  return `
        คุณคือ "ผู้ช่วยฝ่ายขาย (Sales Assistant Bot)" หน้าที่ของคุณคือวิเคราะห์ข้อความจากเซลส์และส่งออกเป็น JSON format เท่านั้น
        
        เซลส์อาจจะพิมพ์ข้อความสำหรับการขอเสนอราคาแบบหลายบรรทัด (Multi-line) โครงสร้างตามธรรมชาติจะเป็นแบบนี้:
        บรรทัดที่ 1: เสนอราคา (หรือข้อความบอกความต้องการ)
        บรรทัดที่ 2: ชื่อบริษัท/ชื่อลูกค้า
        บรรทัดที่ 3: ชื่อผู้ติดต่อ
        บรรทัดต่อๆ ไป: รายการสินค้า [รหัสรุ่นสินค้า] = [จำนวน] (และอาจระบุราคาสินค้าต่อหน่วยและส่วนลดเฉพาะรายการท้ายบรรทัดนี้ด้วย เช่น "SI30-C10 PNP NO 10 ตัว ราคา 650" หรือ "KM-09N-A 5 ตัว ลด20+2" หรือ "OPF-S27X27W-DF 2 ชิ้น 450 บาท")
        บรรทัดท้ายๆ: ส่วนลดรวมของทั้งบิล (เช่น ลด20ตาม5 หรือ ลด30%)
 
        โครงสร้าง JSON ที่ต้องการ:
        {
          "intent": "QUOTATION" หรือ "PRODUCT_INFO" หรือ "REGISTER" หรือ "UNCLEAR",
          "reply_message": "ข้อความตอบกลับเซลส์",
          "salesperson": {
            "name": "ชื่อเซลส์ (ถ้ามี)",
            "phone": "เบอร์โทร (ถ้ามี)"
          },
          "product_query": {
            "models": ["รุ่นสินค้าที่ระบุ เช่น KM-09N-A"]
          },
          "quotation_data": {
            "customer_query": "ชื่อบริษัท/ลูกค้าที่สกัดได้จากข้อความ หรือ null หากไม่ได้ระบุ",
            "contact_query": "ชื่อผู้ติดต่อที่สกัดได้จากข้อความ หรือ null หากไม่ได้ระบุ",
            "discount_1": 20, // (ตัวเลขเปอร์เซ็นต์ส่วนลดขั้นแรกระดับบิล เช่น บรรทัดท้ายๆ เขียน "ลด 20 3", "ลด 20+3%", "ลด 20" -> ให้สกัด discount_1 = 20 / หากไม่มีส่วนลดรวมท้ายบิลหรือระบุเป็นรายการย่อยทั้งหมด ให้ใส่เป็น 0)
            "discount_2": 3,  // (ตัวเลขเปอร์เซ็นต์ส่วนลดขั้นสองระดับบิล เช่น บรรทัดท้ายๆ เขียน "ลด 20 3" -> ให้สกัด discount_2 = 3 / หากไม่มีให้ใส่เป็น 0)
            "discount_is_net": false, // (ค่า boolean: เป็น true หากส่วนลดระดับบิลตามด้วยคำว่า "ไม่โชว์ส่วนลด", "ไม่โชว์", "เน็ต", หรือ "net" เช่น "ลด 30% ไม่โชว์")
            "items": [
              { 
                "model": "รุ่นสินค้าที่ระบุ", 
                "quantity": 1,
                "price": 650, // (ราคาสินค้าต่อหน่วยที่ระบุในแถวรายการสินค้านี้ เช่น "ราคา 650" หรือ "450 บาท" หรือระบุราคามาตรงๆ ให้ดึงเป็นตัวเลข หากไม่ได้ระบุราคาเฉพาะรายการตัวนี้มาในบรรทัดสินค้า ให้ระบุเป็น null เสมอ)
                "discount_1": 30, // (ตัวเลขเปอร์เซ็นต์ส่วนลดขั้นแรกเฉพาะของรายการนี้เมื่อเขียนระบุท้ายแถวสินค้า เช่น "สินค้า A 10 ตัว ลด30%+2%" -> discount_1 = 30 / หากรายการนี้ไม่ได้ระบุส่วนลดเฉพาะเจาะจง ให้ใส่เป็น 0)
                "discount_2": 2,  // (ตัวเลขเปอร์เซ็นต์ส่วนลดขั้นสองเฉพาะของรายการนี้เมื่อเขียนระบุท้ายแถวสินค้า เช่น "สินค้า A 10 ตัว ลด30%+2%" -> discount_2 = 2 / หากไม่มีให้ใส่เป็น 0)
                "discount_is_net": false // (ค่า boolean: เป็น true หากส่วนลดเฉพาะของรายการนี้ตามด้วยคำว่า "ไม่โชว์ส่วนลด", "ไม่โชว์", "เน็ต", หรือ "net" เช่น "ลด 30% ไม่โชว์ส่วนลด" หรือ "ลด 25% เน็ต")
              }
            ]
          }
        }
        กฎเกณฑ์:
        1. ถ้าเซลส์มีเจตนาต้องการสอบถามข้อมูลสินค้า, ราคาสินค้า, เช็คราคา, เช็คของ, หรือต้องการรายละเอียดของสินค้าตัวใดตัวหนึ่ง (รวมถึงคำสั้นๆ เช่น 'ราคา...', 'ขอราคา...', 'เช็คราคา...', 'สอบถามราคา...', 'มีของมั้ย') ให้ถือว่า intent = "PRODUCT_INFO" (หรือ "UNCLEAR" หากไม่มีการระบุรหัสรุ่นสินค้าในข้อความล่าสุดนี้เลย)
           *กฎสำคัญ:* คำว่า "ราคา", "ขอราคา", "เช็คราคา", หรือ "สอบถามราคา" สั้นๆ ให้จัดเป็น PRODUCT_INFO หรือ UNCLEAR เสมอ ห้ามวิเคราะห์เป็น "QUOTATION" เด็ดขาด
        2. ถ้าเซลส์พิมพ์สั่งจัดทำใบเสนอราคา โดยสังเกตว่าต้องมีคำว่า "เสนอราคา" หรือ "ใบเสนอราคา" หรือ "ขอใบเสนอราคา" อยู่ในข้อความ หรือพิมพ์รายการสินค้าพร้อมจำนวนและระบุชื่อลูกค้ามาคู่กันเพื่อขอเปิดบิล ให้ถือว่า intent = "QUOTATION" และสกัด quotation_data ออกมา โดยสกัด customer_query และ contact_query ให้ถูกต้อง
           *กฎสำคัญ:* หากในข้อความล่าสุดไม่มีคำว่า "เสนอราคา" หรือ "ใบเสนอราคา" หรือ "ขอใบเสนอราคา" ปรากฏอยู่เลย และไม่ได้ระบุข้อมูลชื่อลูกค้าเพื่อสั่งเปิดบิล ห้ามจัดเจตนาเป็น "QUOTATION" เด็ดขาด แม้ว่าประวัติการสนทนาเก่าจะมีข้อมูลใบเสนอราคาก็ตาม
        3. การสกัดส่วนลดและการสกัดราคาต่อหน่วย (Unit Price):
           - 3.1 หากระบุส่วนลดที่ท้ายบรรทัดของรายการสินค้านั้นเฉพาะตัว (เช่น 'KM-09N-A 5 ตัว ลด30%+2%') ให้สกัดส่วนลดนั้นใส่ in 'discount_1' และ 'discount_2' ของรายการนั้นๆ ในอาร์เรย์ 'items' และสำหรับรายการนั้นๆ และในระดับบิล ('quotation_data.discount_1' และ 'quotation_data.discount_2') ให้ใส่เป็น 0
           - 3.2 หากระบุส่วนลดรวมท้ายข้อความหรือบรรทัดล่างสุดที่หมายถึงทั้งบิล (เช่น 'ลด20%') ให้สกัดใส่ in 'quotation_data.discount_1' และ 'quotation_data.discount_2' แทน และในรายการสินค้า 'items' ให้ระบุ 'discount_1' และ 'discount_2' ของรายการย่อยเป็น 0
           - 3.3 หากรายการใดไม่มีการระบุส่วนลดเลย และไม่มีส่วนลดรวมทั้งบิล ให้สกัดเป็น 0
           - 3.4 การสกัดราคาต่อหน่วย (Unit Price): หากระบุราคาต่อหน่วยมาที่แถวรายการสินค้า (เช่น "SI30-C10 PNP NO 10 ตัว ราคา 650" หรือ "KM-09N-A 5 ตัว 250 บาท") ให้สกัดราคานั้นเป็นตัวเลข (ไม่เอาหน่วยเงิน) ใส่ในฟิลด์ "price" ของรายการนั้นๆ ในอาร์เรย์ "items" หากบรรทัดรายการสินค้านั้นไม่ได้เขียนระบุราคาต่อหน่วยมา ให้ใส่ฟิลด์ "price" ของรายการนั้นเป็น null เสมอ เพื่อใช้ราคาเริ่มต้นจากฐานข้อมูล
           - 3.5 การสกัดส่วนลดที่ไม่โชว์ (Net Discount): หากหลังคำระบุส่วนลด (เช่น ลด 30% หรือ ลด 30%+2%) มีคำว่า "ไม่โชว์ส่วนลด", "ไม่โชว์", "เน็ต", หรือ "net" ต่อท้าย (ตัวอย่าง: "ลด 30% ไม่โชว์", "ลด 30%+2% เน็ต", "ลด 25% net") ให้ตั้งค่าฟิลด์ "discount_is_net" ในระดับที่ตรวจพบเป็น true (เช่น หากเกิดขึ้นที่ระดับรายการให้ใส่ใน item ของรายการนั้นๆ, หากเกิดขึ้นระดับบิลให้ใส่ใน quotation_data) เพื่อบอกให้ระบบแก้ไขราคาที่ unit price โดยตรงและตั้งค่าตัวแสดงผลส่วนลดเป็น 0
           - 3.6 ห้ามตรวจจับเครื่องหมายลบ "-" นำหน้าตัวเลขส่วนลด เช่น "-30%" หรือ "-25%" ให้ถือว่าเป็นส่วนหนึ่งของรหัสสินค้าหรือสัญลักษณ์ทั่วไป และห้ามสกัดเป็นส่วนลดเด็ดขาด! ให้สังเกตเฉพาะคำว่า "ลด" หรือ "ลด..." เท่านั้น (ตัวอย่าง: "ลด 30%" ให้สกัดส่วนลด, แต่ "-30%" ให้ข้าม)
        4. หากข้อความล่าสุดเป็นการแก้ไขคำผิด การระบุรุ่นที่ถูกต้อง หรือเปลี่ยนแปลงรายละเอียดสำหรับการเสนอราคา (และประวัติการสนทนาล่าสุดยังอยู่ในเซสชันปัจจุบัน) ให้วิเคราะห์ประวัติการสนทนาประกอบเพื่อรักษารายการสินค้าตัวอื่นที่เคยเสนอไว้ รวมถึงข้อมูลส่วนลดและรายละเอียดชื่อลูกค้า/ผู้ติดต่อเดิมไว้ใน quotation_data ใบนี้ด้วย แต่หากประวัติสนทนามีการแจ้งยกเลิกรายการเดิมไปแล้ว หรือข้อความล่าสุดระบุชัดเจนว่าเริ่มใหม่ ให้ล้างรายการทั้งหมดแล้วจัดทำใหม่
        5. ถ้าข้อความเป็นคำทักทาย, ถามเรื่องทั่วไป, หรืออ่านแล้วไม่เข้าใจว่าต้องการสั่งของกี่ชิ้น หรือสินค้าคืออะไร ให้ถือว่า intent = "UNCLEAR"
        6. ถ้า intent = "UNCLEAR" ให้แยกเป็น 3 กรณี:
           - 6.1 ถ้าข้อความล่าสุด "มี" คำว่า "เสนอราคา" อยู่ (เช่น "ออกใบเสนอราคา", "ขอใบเสนอราคา") ให้ปล่อย reply_message เป็นสตริงว่าง "" เพราะระบบจะส่ง "แบบฟอร์มขอใบเสนอราคา" มาตรฐานให้เอง ห้ามแต่งข้อความถามกลับเองเด็ดขาด
           - 6.2 ถ้าเป็นการถามเช็คราคา/เช็คของ/เช็คสต็อก แต่ไม่ได้ระบุรุ่นสินค้ามา (เช่น "เช็คของ", "มีของมั้ย", "ขอราคา", "เช็คสต็อก") ให้ปล่อย reply_message เป็นสตริงว่าง "" เช่นกัน เพราะระบบจะส่งคำแนะนำวิธีถามข้อมูลสินค้ามาตรฐานให้เอง
           - 6.3 นอกเหนือจากนั้น (เช่น คำทักทาย "สวัสดี", "หวัดดี" หรือถามทั่วไป) ให้สร้าง reply_message สั้นๆ อย่างสุภาพ โดยทักทายกลับ แนะนำตัวว่าเป็นบอทผู้ช่วยออกใบเสนอราคา และชวนให้พิมพ์คำว่า "เสนอราคา" เพื่อเริ่มต้น (ห้ามใส่แบบฟอร์มลงใน reply_message เอง)
           - 6.4 คำลงท้ายใน reply_message ให้ใช้ "ครับ" เสมอ ห้ามใช้ "ค่ะ" หรือ "คะ" เด็ดขาด และให้เรียกแทนตัวเองว่า "ผม" ไม่ใช่ "ฉัน" หรือ "ดิฉัน"
        7. ห้าม! ตอบคำถามทั่วไปที่ไม่เกี่ยวกับการขายเด็ดขาด ให้ตอบกลับด้วย reply_message ตามกฎข้อ 6 เสมอ
        8. หากเซลส์พิมพ์ชื่อมาเพียงชื่อเดียว (เช่น บรรทัดที่สองหลังจากเสนอราคา หรือระบุมาสั้นๆ) ให้ใช้ "คำนำหน้า" เป็นตัวตัดสินหลัก:
           - ถ้ามีคำนำหน้าบุคคล ("คุณ", "K", "K.", "k", "k.", "นาย", "นาง", "นางสาว") ให้ถือเป็นชื่อผู้ติดต่อ ใส่ใน contact_query และเว้น customer_query เป็น null (เช่น "คุณถาวร" หรือ "K นิว" เป็นชื่อผู้ติดต่อ)
           - ถ้า "ไม่มี" คำนำหน้าบุคคลและไม่มีคำนิติบุคคลนำหน้า ให้ตีความเป็น "ชื่อบริษัท" ก่อนเป็นค่าเริ่มต้น (default) ใส่ใน customer_query และเว้น contact_query เป็น null (เช่น "ปิยะพจน์", "สมพร", "อธิชาต", "เคซีอี", "ซีเคซี" ให้ถือเป็นชื่อบริษัท)
        9. หากเซลส์ระบุมาเพียงชื่อเดียวแล้วตามด้วยรายการสินค้า โดยไม่มีคำว่า "เสนอราคา" หรืออื่นๆ ให้พิจารณารวบรวมเป็นเจตนาสั่งซื้อสินค้า/ขอใบเสนอราคา (intent = "QUOTATION") แล้ววิเคราะห์สกัดชื่อนั้นตามกฎข้อ 8
        10. หากข้อความเป็นลักษณะของการแนะนำตัวของเซลส์ (เช่น "สวัสดีครับ ผมชื่อ... เบอร์โทร...") หรือบอกว่าตัวเองเป็นใคร ให้ถือว่า intent = "REGISTER" และสกัดข้อมูลชื่อและเบอร์โทรใส่ in object "salesperson" ให้ครบถ้วน
        11. หากข้อความล่าสุดเป็นเพียงเจตนาสั้นๆ หรือคำสั่งทั่วไปที่ไม่มีการระบุรุ่นสินค้าลงในข้อความนี้เลย (เช่น 'สอบถามราคา', 'เช็คราคา', 'ขอราคา', 'เช็คสต็อก', 'มีของมั้ย', 'ทำไรได้บ้าง') ให้ถือว่า intent = "UNCLEAR" เสมอ และห้ามดึงรหัสลูกค้า (เช่น รหัสที่ขึ้นต้นด้วย A เช่น A022914) หรือรุ่นสินค้าอื่นจากประวัติสนทนาในอดีตมาคาดเดาเจตนาเพื่อวิเคราะห์เป็นรุ่นสินค้า (models) ใน product_query หรือนำมาวิเคราะห์ความต้องการใหม่เด็ดขาด!
        12. ห้ามทึกทักสร้างคำทักทายหรือคำพูดที่มีชื่อสมมติ เช่น ห้ามตอบด้วยประโยคว่า 'รุ่งเรือง ค่ะ' หรือเดาชื่อลูกค้าอื่นใดๆ นอกเหนือจากข้อมูลผู้ใช้ปัจจุบันหรือข้อมูลที่สกัดได้จริงจากข้อความล่าสุดเท่านั้น
        13. หากพบรหัสอ้างอิงลูกค้า (Customer Reference Code) เช่น รหัสที่ขึ้นต้นด้วย A หรือ N ตามด้วยตัวเลข หรือสแลช หรือแดช (เช่น A/35871, N/10369, A022914, A001219(5) เป็นต้น) ให้สกัดรหัสอ้างอิงนี้และรวมเข้าไว้ใน "customer_query" ด้วยเสมอ เพื่อให้ระบบนำไปจับคู่ลูกค้าได้ถูกต้อง (เช่น ถ้ามี "บ.ถิรเดช" และ "A/35871" ให้ระบุ customer_query เป็น "บ.ถิรเดช A/35871")
        14. แยกแยะชื่อบริษัท ("customer_query") และชื่อผู้ติดต่อ ("contact_query") โดยใช้คำขึ้นต้นเป็นเบาะแส เช่น:
            - ชื่อที่มีคำว่า "บ.", "บริษัท", "หจก.", "หจก", "บจก.", "บจก" หรือคำแสดงความเป็นนิติบุคคล/ร้านค้า ให้วิเคราะห์เป็นชื่อบริษัท ("customer_query")
            - ชื่อที่มีคำนำหน้าบุคคล เช่น "คุณ", "K", "K.", "k", "k.", "นาย", "นาง", "นางสาว" ให้วิเคราะห์เป็นชื่อผู้ติดต่อ ("contact_query") เสมอ — โดยเฉพาะ "K"/"K." คือคำย่อของ "คุณ" (ห้ามตีความ "K นิว" เป็นชื่อบริษัทเด็ดขาด ให้เป็น contact_query)
            - ชื่อที่ "ไม่มี" คำนำหน้าใดๆ เลย (ไม่มีทั้งคำนิติบุคคลและคำนำหน้าบุคคล) เช่น "ปิยะพจน์" ให้ตีความเป็นชื่อบริษัท ("customer_query") ก่อนเป็นค่าเริ่มต้น
            - ตัวอย่าง: "บ.ถิรเดช คุณถิรเดช" -> customer_query = "บ.ถิรเดช", contact_query = "คุณถิรเดช"
            - ตัวอย่างสำคัญ: ข้อความมีทั้ง "K นิว" และ "ปิยะพจน์" -> "K นิว" มีคำนำหน้าบุคคล = contact_query, ส่วน "ปิยะพจน์" ไม่มีคำนำหน้า = customer_query (ห้ามสลับกัน)
            - หากมีทั้งชื่อบริษัทและผู้ติดต่อ และรหัสอ้างอิงลูกค้า เช่น "บ.ถิรเดช คุณถิรเดช A/35871" ให้สกัด customer_query เป็น "บ.ถิรเดช A/35871" และ contact_query เป็น "คุณถิรเดช"
        15. บรรทัดที่เป็น "คำสั่ง/หมายเหตุการจัดส่งหรือการดำเนินการ" ของเซลส์ ไม่ใช่ชื่อลูกค้าหรือผู้ติดต่อ ห้ามนำมาสกัดใส่ customer_query หรือ contact_query เด็ดขาด ให้มองข้ามทิ้งไป ตัวอย่างบรรทัดที่ต้องมองข้าม เช่น "ส่งไลน์", "ส่ง line", "ส่งline", "ส่งเมล", "ส่ง email", "ด่วน", "ด่วนที่สุด", "ทำด่วน", "ขอด่วน", "รบกวนด่วน" หรือประโยคสั่งการทำนองเดียวกัน (สังเกตว่าไม่มีลักษณะเป็นชื่อบุคคล/นิติบุคคล และมักเป็นคำกริยาสั่งการ)

        *** กฎเหล็ก: ห้ามเดารุ่นสินค้า ห้ามเติมขีด ห้ามลบช่องว่าง หรือคาดเดารุ่นสินค้าตัวเต็มจากประวัติการสนทนาเพื่อนำมาแปลงค่า in models และ quotation_data โดยเด็ดขาด! ให้คงตัวสะกดดั้งเดิมที่ปรากฏใน "ข้อความล่าสุดจากเซลส์" เท่านั้น เพื่อให้ระบบทำการค้นหาใกล้เคียงได้อย่างถูกต้อง ***

        *** รูปแบบผลลัพธ์ (สำคัญที่สุด): ให้ตอบกลับเป็น JSON object เพียงก้อนเดียวเท่านั้น เริ่มต้นด้วย "{" และจบด้วย "}" ห้ามมีข้อความอธิบาย, คำทักทาย, เครื่องหมาย markdown code fence, หรือตัวอักษรใดๆ อยู่นอกวงเล็บ JSON ทั้งก่อนหน้าและต่อท้ายเด็ดขาด และห้ามส่ง JSON object มากกว่าหนึ่งก้อน ***

        ${historyContext}ข้อความล่าสุดจากเซลส์: ${content}
      `;
}

/**
 * parse JSON แบบทนทาน — ยกออกมาไว้ระดับโมดูลเพื่อให้ด่านตรวจ (scripts/diag/*) เรียกของจริงตัวเดียวกันได้
 * เดิมเป็น closure ใน handleEvent และมี "สำเนา" อยู่ใน scripts/diag/extractionCore.ts — เฟส C ยุบเหลือตัวเดียว
 * (ตัวฟังก์ชันบริสุทธิ์ ไม่อ้างอะไรนอกพารามิเตอร์ การยกออกมาจึงไม่เปลี่ยนพฤติกรรม)
 */
export const parseAiJson = (rawContent: string): any => {
  const rawJson = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(rawJson);
  } catch (e) {
    const start = rawJson.indexOf('{');
    if (start === -1) throw e;
    let depth = 0, inString = false, escaped = false, end = -1;
    for (let i = start; i < rawJson.length; i++) {
      const ch = rawJson[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) throw e;
    return JSON.parse(rawJson.slice(start, end + 1));
  }
};

/**
 * ข้อความดิบ 1 ข้อความ → ร่างใบเสนอราคา (ยังไม่บันทึก ยังไม่ค้นหาลูกค้า)
 *
 * ทำ 3 อย่างตามลำดับเดิมของ handleEvent เป๊ะ:
 *   1. ประกอบ historyContext จากประวัติแชท 15 นาทีล่าสุด (ตัดที่ยกเลิก/ยืนยันแล้ว)
 *   2. ยิง LLM สกัดเป็น JSON · retry 3 ครั้งผูกกับงบเวลา · ล้มหมดตกเป็น UNCLEAR + extraction_failed
 *   3. เฉพาะ intent = QUOTATION ที่มีรายการ: ล้างใบค้าง → findProduct ทุกตัวพร้อมกัน → สร้าง slots
 *
 * ไม่ตอบกลับใคร ไม่เรนเดอร์ Flex ไม่ตัดสินใจว่าจะส่งอะไร — คนเรียกตัดสินเองจาก slots
 */
export async function extractQuoteFromText(params: ExtractQuoteParams): Promise<ExtractedQuote> {
  const userId = params.userId;
  const content = params.text;
  const remainingMs = params.remainingMs ?? (() => Infinity);
  const checkpoint = params.checkpoint ?? (() => {});
  const purgePending = params.purgePending ?? true;

      checkpoint('ดึงประวัติแชท + สกัดคำสั่งด้วย LLM');
      // ดึงประวัติการคุยย้อนหลังของ userId นี้
      let historyContext = "";
      try {
        const history = await getRecentMessages(userId, 10);
        if (history && history.length > 0) {
          // กรองข้อมูลเฉพาะ 15 นาทีล่าสุดเพื่อไม่ให้ดึงประวัติเก่าที่ค้างมาข้ามวัน/ชั่วโมง
          const now = new Date();
          const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);
          let recentHistory = history.filter((h: any) => new Date(h.created_at) >= fifteenMinutesAgo);
 
          // ตัดประวัติเมื่อพบการกดยกเลิกหรือยืนยันใบเสนอราคาเสร็จสมบูรณ์ไปแล้ว
          const closeIndex = recentHistory.findIndex((h: any) => 
            h.reply_content && (
              h.reply_content.includes("ยกเลิกการออกใบเสนอราคา") ||
              h.reply_content.includes("ยกเลิกการเสนอราคา") ||
              h.reply_content.includes("ยืนยันสำเร็จ") ||
              h.reply_content.includes("ลงทะเบียนสำเร็จ")
            )
          );
          if (closeIndex !== -1) {
            recentHistory = recentHistory.slice(0, closeIndex);
          }
 
          if (recentHistory.length > 0) {
            const chatHistory = [...recentHistory].reverse();
            historyContext = "ประวัติการสนทนาล่าสุดในห้องแชทนี้:\n" +
              chatHistory.map((h: any) => `เซลส์: ${h.content}\nบอท: ${h.reply_content}`).join("\n") + "\n\n";
          }
        }
      } catch (e) {
        console.error("Exception fetching chat history:", e);
      }
      const prompt = buildExtractionPrompt(content, historyContext);
      // สกัดคำสั่งด้วย LLM ผ่าน createChatCompletion (deepseek-v4-flash + thinking disabled)
      // วัดจริง p95 ~2s, correctness 100% — เร็วเท่า non-thinking แต่ future-proof (ไม่ผูก deepseek-chat ที่จะ deprecate)
      const MAX_EXTRACTION_ATTEMPTS = 3;

      // Retry กัน failure mode ที่ flaky (content ว่าง / parse ไม่ได้) ก่อนยอมตกไป UNCLEAR —
      // เดิมพลาดครั้งเดียวก็ตอบ error ทั้งที่คำสั่งเซลส์ถูกต้อง
      let aiResult: any = null;
      let lastExtractionErr: any = null;
      for (let attempt = 1; attempt <= MAX_EXTRACTION_ATTEMPTS; attempt++) {
        // งบไม่พอสำหรับอีก 1 รอบ — หยุดเลย ดีกว่าเผาเวลาแล้วตอบไม่ทันอยู่ดี
        // (จงใจไม่ลดเลข MAX_EXTRACTION_ATTEMPTS: ให้ deadline เป็นตัวคุมแทน มีเวลาก็ retry ได้เต็มที่
        //  ไม่มีเวลาก็หยุดเอง — วัดแล้วว่าที่โหลดปกติ attempt 1 ไม่เคยพลาดเลยใน 150 call)
        // 8 วิ = p95 ของ 1 call (2.5s) + เผื่อ SDK ลองใหม่อีกรอบ + เวลาที่ยังต้องใช้หลังสกัดเสร็จ
        if (attempt > 1 && remainingMs() < 8_000) {
          console.warn(`[extraction] เหลืองบ ${remainingMs()}ms — ข้าม attempt ${attempt}/${MAX_EXTRACTION_ATTEMPTS}`);
          break;
        }
        // งบหมดจริงระหว่างรอ attempt ก่อนหน้า — โยนออกไปเลย ไม่ยิง LLM เพิ่มให้เสียเงินเปล่า
        checkpoint(`เรียก LLM attempt ${attempt}/${MAX_EXTRACTION_ATTEMPTS}`);
        try {
          const response = await createChatCompletion({
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: 'json_object' },
            // จำกัดเฉพาะ output (JSON ที่สร้างกลับ) ไม่เกี่ยว input เช่น ประวัติแชท/รายการสินค้าที่ยาว
            // 8192 เผื่อ order รายการเยอะ (~160 รายการ); v4-flash รองรับ output ได้สูงถึง 384K
            max_tokens: 8192
          });
          const rawContent = response.choices[0]?.message?.content || '';
          if (!rawContent.trim()) {
            lastExtractionErr = new Error('empty content');
            console.warn(`[extraction] attempt ${attempt}/${MAX_EXTRACTION_ATTEMPTS}: โมเดลคืน content ว่าง — ลองใหม่`);
            continue;
          }
          aiResult = parseAiJson(rawContent);
          // ต้อง log ตอน retry "สำเร็จ" ด้วย ไม่งั้นจะวัดไม่ได้เลยว่า retry มีประโยชน์แค่ไหน
          // (ของเดิม break เงียบ ๆ ⇒ DB/log เก็บร่องรอยไว้เฉพาะครั้งที่ retry ไม่ช่วย)
          if (attempt > 1) console.warn(`[extraction] ✅ กู้ได้ที่ attempt ${attempt}/${MAX_EXTRACTION_ATTEMPTS}`);
          break; // สำเร็จ
        } catch (e) {
          lastExtractionErr = e;
          console.warn(`[extraction] attempt ${attempt}/${MAX_EXTRACTION_ATTEMPTS} ล้มเหลว:`, (e as any)?.message || e);
        }
      }
      if (!aiResult) {
        console.error('[extraction] ทุก attempt ล้มเหลว — ตกไป UNCLEAR:', lastExtractionErr);
        // extraction_failed: บอกปลายทางว่าเป็น UNCLEAR เพราะระบบล่ม ไม่ใช่เพราะเซลส์พิมพ์ไม่ชัด
        // จะได้แจ้งว่าระบบไม่ว่าง แทนที่จะยัดแบบฟอร์มขอใบเสนอราคากลับไป
        aiResult = { intent: "UNCLEAR", extraction_failed: true, reply_message: "ขออภัยครับ ระบบไม่ว่างชั่วคราว รบกวนพิมพ์คำสั่งเดิมอีกครั้งนะครับ 🙏" };
      }

      // เงื่อนไขนี้คือตัวเดิมจาก handleEvent ทุกตัวอักษร — ฝั่ง LINE ก็ยังถามคำถามเดียวกันซ้ำ
      // เพื่อให้ branch REGISTER/PRODUCT_INFO/UNCLEAR ที่ไม่ได้ย้ายมายังอยู่ที่เดิมและอ่านง่าย
      if (aiResult.intent === 'QUOTATION' && aiResult.quotation_data && aiResult.quotation_data.items && aiResult.quotation_data.items.length > 0) {
        // ลบรายการใบเสนอราคาเก่าที่ยังค้างอยู่ทั้งหมดออกถาวร
        // (หน้าเว็บปิดด้วย purgePending: false — ยังไม่ถึงขั้นตัดสินใจ ดูหัวข้อ ExtractQuoteParams)
        if (purgePending) await deletePendingQuotations(userId);

        let quoteData = aiResult.quotation_data;
        let isAllValid = true;
        let hasNotFoundIssue = false;
        let itemReports = '';
        let successReport = '';
        const itemsForDb: any[] = [];
        let totalSum = 0;
        let issueCount = 0;
        checkpoint(`ค้นหาสินค้า ${quoteData.items.length} รายการ (QUOTATION)`);
        const productPromises = quoteData.items.map(async (item: any) => {
          const codeRaw = String(item.model || item.product_code || '').trim();
          // ส่งข้อความเต็มไปด้วย — เซลส์มักพิมพ์รหัสแตกหลายบรรทัด AI จะได้เห็นคำนำหน้ารุ่นที่อยู่บรรทัดอื่น
          const result = await findProduct(codeRaw, content);
          return { item, result };
        });
        const productResults = await Promise.all(productPromises);

        // ── ซ่อมเคสเซลส์พิมพ์รหัสสินค้าแตกเป็น 2 บรรทัด (เช่น "QH" + "50X800-550-3X220S-3000W-1") ──
        // เงื่อนไขเข้มเพื่อกันรวมมั่ว: ตัวหน้าต้อง "หาไม่เจอและไม่มี candidate เลย" (= เศษรหัส ไม่ใช่สินค้าจริง)
        // และรหัสที่ต่อกันแล้วต้อง match แบบ found เท่านั้น (ปกติจะเข้า stage1 exact → ไม่ต้องพึ่ง AI เดา)
        for (let i = 0; i < productResults.length - 1; i++) {
          const cur = productResults[i];
          const next = productResults[i + 1];
          if (!cur || !next) continue;
          if (cur.result.found || (cur.result.candidates && cur.result.candidates.length > 0)) continue;

          const curCode = String(cur.item.model || cur.item.product_code || '').trim();
          const nextCode = String(next.item.model || next.item.product_code || '').trim();
          if (!curCode || !nextCode) continue;

          const mergedResult = await findProduct(`${curCode} ${nextCode}`, content);
          if (!mergedResult.found || !mergedResult.product) continue;

          console.log(`[quotation] รวมรหัสที่ถูกตัดบรรทัด: "${curCode}" + "${nextCode}" → "${mergedResult.product.model}"`);
          // ใช้ item ของบรรทัดหลังเป็นฐาน (จำนวน/ราคา/ส่วนลดมักอยู่บรรทัดนั้น) แล้วยุบสองรายการเหลือรายการเดียว
          productResults.splice(i, 2, {
            item: { ...next.item, model: mergedResult.product.model },
            result: mergedResult
          });
        }

        // slots = สถานะการ resolve ต่อรายการ (ตามลำดับเดิม): resolved | กำกวม(มี candidate ให้กดเลือก) | พิมพ์ผิด(ไม่มี candidate)
        const slots: any[] = [];
        for (let i = 0; i < productResults.length; i++) {
          const { item, result } = productResults[i];
          if (result.found && result.product) {
            const { itemForDb, itemTotal, price, disc1, disc2 } = buildResolvedItem(result.product, item, quoteData);
            totalSum += itemTotal;
            let discDesc = '';
            if (disc1 > 0 && disc2 > 0) {
              discDesc = ` (ลด ${disc1}+${disc2}%)`;
            } else if (disc1 > 0) {
              discDesc = ` (ลด ${disc1}%)`;
            }
            successReport += `${i + 1}. [${itemForDb.model}]: ${itemForDb.quantity} x ${price.toLocaleString()}${discDesc} = ${itemTotal.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} บาท\n`;
            itemsForDb.push(itemForDb);
            slots.push({ resolved: true, itemForDb });
          } else {
            isAllValid = false;
            hasNotFoundIssue = true;
            itemReports += result.report;
            issueCount++;
            // เก็บ candidate (ถ้ามี) ไว้ทำปุ่มกดเลือก — เฉพาะรุ่นกำกวมที่ระบบเจอตัวใกล้เคียง (ตัวพิมพ์ผิดจะไม่มี candidate)
            const cands = (result.candidates || []).slice(0, 5).map((c: any) => ({
              model: c.model,
              sales_price: c.sales_price,
              quantity_on_hand_unreserved: c.quantity_on_hand_unreserved,
              product_template_id: c.product_template_id,
              name: c.name,
              brand: c.brand,
              series: c.series,
              production: c.production
            }));
            slots.push({ resolved: false, item, candidates: cands });
          }
        }

        return {
          intent: aiResult.intent,
          extraction_failed: aiResult.extraction_failed,
          reply_message: aiResult.reply_message,
          raw: aiResult,
          quoteData,
          slots,
          isAllValid,
          hasNotFoundIssue,
          itemReports,
          successReport,
          itemsForDb,
          totalSum,
          issueCount
        };
      }

      // ทุก intent ที่เหลือ (REGISTER / PRODUCT_INFO / UNCLEAR) — คนเรียกอ่านจาก raw เอง
      return {
        intent: aiResult.intent,
        extraction_failed: aiResult.extraction_failed,
        reply_message: aiResult.reply_message,
        raw: aiResult
      };
}
