// ─────────────────────────────────────────────────────────────────────────────
//  ชุดเคสทดสอบชั้น "extraction (LLM)" — วินิจฉัยจากเคสจริง 5 หมวดที่เซลส์พิมพ์
//  โฟกัสเฉพาะสิ่งที่ LLM ควบคุม (intent / customer_query / contact_query /
//  items[].model+quantity+price+discount / ส่วนลดระดับบิล) — ไม่ทดสอบชั้นจับคู่ DB
//
//  expect.* = ค่าที่ "ควรจะสกัดได้" ตามกฎใน prompt ของ production
//  ตัวเช็ก *_includes เทียบแบบ normalize (ตัดช่องว่าง + lower) เพื่อไม่ติด format ย่อย
// ─────────────────────────────────────────────────────────────────────────────

export interface ItemExpect {
  model_includes: string;      // model ที่สกัดได้ต้อง "มี" สตริงนี้ (ตัดช่องว่าง/ตัวพิมพ์)
  quantity?: number;           // จำนวนที่คาดหวัง (เช็กเป๊ะ)
  price_null?: boolean;        // true = price ต้องเป็น null (ไม่ระบุราคาต่อหน่วย)
  price?: number;              // ราคาต่อหน่วยที่คาดหวัง
  discount_1?: number;
  discount_2?: number;
  discount_is_net?: boolean;
}

export interface CaseExpect {
  intent: 'QUOTATION' | 'PRODUCT_INFO' | 'REGISTER' | 'UNCLEAR';
  customer_includes?: string;      // customer_query ต้องมีสตริงนี้
  contact_includes?: string;       // contact_query ต้องมีสตริงนี้
  customer_null?: boolean;         // customer_query ต้องเป็น null
  contact_null?: boolean;          // contact_query ต้องเป็น null
  bill_discount_1?: number;
  bill_discount_2?: number;
  bill_is_net?: boolean;
  items?: ItemExpect[];
  models_includes?: string[];      // สำหรับ PRODUCT_INFO — product_query.models ต้องมีรุ่นเหล่านี้
}

export interface DiagCase {
  id: string;
  category: string;
  note: string;
  message: string;
  expect: CaseExpect;
}

// หมายเหตุ: รหัสสินค้า/ชื่อบริษัทในเคสเป็น "รูปแบบจริง" ที่เซลส์พิมพ์ (ตามที่ผู้ใช้ให้มา)
// ไม่จำเป็นต้องมีจริงใน DB เพราะเราวินิจฉัยแค่การ "สกัด" ไม่ใช่การ "จับคู่"
export const CASES: DiagCase[] = [
  // ─── หมวด 1: ตำแหน่งคำว่า "เสนอราคา" ไม่คงที่ ───────────────────────────────
  {
    id: 'pos-start',
    category: '1-keyword-position',
    note: 'keyword ขึ้นต้นประโยค + ผู้ติดต่อก่อนบริษัท',
    message: 'เสนอราคา\nคุณ มิค\nบริษัท ฟอร์จูนเนท เพาเวอร์ จำกัด (สำนักงานใหญ่)\nCMP-48-RR-24 5 ตัว\nลด 30%',
    expect: {
      intent: 'QUOTATION',
      contact_includes: 'มิค',
      customer_includes: 'ฟอร์จูนเนท',
      bill_discount_1: 30,
      bill_discount_2: 0,
      items: [{ model_includes: 'CMP-48-RR-24', quantity: 5, price_null: true, discount_1: 0, discount_2: 0 }],
    },
  },
  {
    id: 'pos-middle',
    category: '1-keyword-position',
    note: 'keyword แทรกกลาง หลังรายการสินค้า',
    message: 'IM-B-I-0-24 2 ตัว เสนอราคา บ.อัสคา',
    expect: {
      intent: 'QUOTATION',
      customer_includes: 'อัสคา',
      items: [{ model_includes: 'IM-B-I-0-24', quantity: 2 }],
    },
  },
  {
    id: 'pos-polite',
    category: '1-keyword-position',
    note: 'คำสุภาพ "รบกวนเสนอราคา" + บริษัทย่อ + ผู้ติดต่อบรรทัดเดียว',
    message: 'รบกวนเสนอราคา บ.ช.จิรภัทร คุณสมชาย\nCMP-48-RR-24 3 ตัว',
    expect: {
      intent: 'QUOTATION',
      customer_includes: 'จิรภัทร',
      contact_includes: 'สมชาย',
      items: [{ model_includes: 'CMP-48-RR-24', quantity: 3 }],
    },
  },

  // ─── หมวด 2: ชื่อบริษัทเต็ม/ย่อ ─────────────────────────────────────────────
  {
    id: 'company-full',
    category: '2-company-name',
    note: 'ชื่อเต็ม + (สำนักงานใหญ่)',
    message: 'เสนอราคา บริษัท ฟอร์จูนเนท เพาเวอร์ จำกัด (สำนักงานใหญ่)\nCMP-48-RR-24 1 ตัว',
    expect: {
      intent: 'QUOTATION',
      customer_includes: 'ฟอร์จูนเนท',
      items: [{ model_includes: 'CMP-48-RR-24', quantity: 1 }],
    },
  },
  {
    id: 'company-abbrev-dot',
    category: '2-company-name',
    note: 'ย่อ "บ.ช.จิรภัทร" (บ. แทนบริษัท + ตัวย่อจุด)',
    message: 'เสนอราคา บ.ช.จิรภัทร\nCMP-48-RR-24 2 ตัว',
    expect: {
      intent: 'QUOTATION',
      customer_includes: 'จิรภัทร',
      items: [{ model_includes: 'CMP-48-RR-24', quantity: 2 }],
    },
  },

  // ─── หมวด 3: รหัสอ้างอิงลูกค้า (Ref) เขียนไม่มาตรฐาน ────────────────────────
  {
    id: 'ref-paren',
    category: '3-reference-code',
    note: 'ref มีวงเล็บต่อท้าย A003421(2)',
    message: 'เสนอราคา บ.ถิรเดช A003421(2)\nCMP-48-RR-24 1 ตัว',
    expect: {
      intent: 'QUOTATION',
      customer_includes: 'A003421',
      items: [{ model_includes: 'CMP-48-RR-24', quantity: 1 }],
    },
  },
  {
    id: 'ref-slash',
    category: '3-reference-code',
    note: 'ref ใช้สแลช A/39003',
    message: 'เสนอราคา บ.อัสคา A/39003\nIM-B-I-0-24 2 ตัว',
    expect: {
      intent: 'QUOTATION',
      customer_includes: 'A/39003',
      items: [{ model_includes: 'IM-B-I-0-24', quantity: 2 }],
    },
  },
  {
    id: 'ref-plain',
    category: '3-reference-code',
    note: 'ref เปล่าๆ อยู่คนละบรรทัด A003341',
    message: 'เสนอราคา\nA003341\nCMP-48-RR-24 4 ตัว',
    expect: {
      intent: 'QUOTATION',
      customer_includes: 'A003341',
      items: [{ model_includes: 'CMP-48-RR-24', quantity: 4 }],
    },
  },

  // ─── หมวด 4: การระบุจำนวนไม่สม่ำเสมอ (ตัว / =) ──────────────────────────────
  {
    id: 'qty-ตัว',
    category: '4-quantity',
    note: 'มาตรฐาน [รหัส] [จำนวน] ตัว',
    message: 'เสนอราคา บ.อัสคา\nCMP-48-RR-24 5 ตัว',
    expect: {
      intent: 'QUOTATION',
      items: [{ model_includes: 'CMP-48-RR-24', quantity: 5, price_null: true }],
    },
  },
  {
    id: 'qty-equal',
    category: '4-quantity',
    note: '⚠️ ใช้ = แทน "ตัว": CMA-003=1',
    message: 'เสนอราคา บ.อัสคา\nCMA-003=1',
    expect: {
      intent: 'QUOTATION',
      items: [{ model_includes: 'CMA-003', quantity: 1, price_null: true }],
    },
  },
  {
    id: 'qty-equal-space-no',
    category: '4-quantity',
    note: '⚠️ = มีเว้นวรรค + suffix NO เป็นส่วนของรหัส: SI12-A2 NO = 1',
    message: 'เสนอราคา บ.อัสคา\nSI12-A2 NO = 1',
    expect: {
      intent: 'QUOTATION',
      items: [{ model_includes: 'SI12-A2', quantity: 1, price_null: true }],
    },
  },
  {
    id: 'qty-mixed',
    category: '4-quantity',
    note: '⚠️ ปนกันในบิลเดียว: "ตัว" + "="',
    message: 'เสนอราคา บ.อัสคา\nCMP-48-RR-24 5 ตัว\nCMA-003=2',
    expect: {
      intent: 'QUOTATION',
      items: [
        { model_includes: 'CMP-48-RR-24', quantity: 5 },
        { model_includes: 'CMA-003', quantity: 2 },
      ],
    },
  },

  // ─── หมวด 5: ส่วนลดหลายฟอร์แมต ──────────────────────────────────────────────
  {
    id: 'disc-star',
    category: '5-discount',
    note: '⚠️ ** นำหน้า (markdown-ish): **ลด 30%',
    message: 'เสนอราคา บ.อัสคา\nCMP-48-RR-24 5 ตัว\n**ลด 30%',
    expect: {
      intent: 'QUOTATION',
      bill_discount_1: 30,
      bill_discount_2: 0,
      items: [{ model_includes: 'CMP-48-RR-24', quantity: 5, discount_1: 0 }],
    },
  },
  {
    id: 'disc-nospace',
    category: '5-discount',
    note: 'ไม่เว้นวรรค: ส่วนลด30%',
    message: 'เสนอราคา บ.อัสคา\nCMP-48-RR-24 5 ตัว\nส่วนลด30%',
    expect: {
      intent: 'QUOTATION',
      bill_discount_1: 30,
      bill_discount_2: 0,
    },
  },
  {
    id: 'disc-space',
    category: '5-discount',
    note: 'เว้นวรรค: ส่วนลด 30%',
    message: 'เสนอราคา บ.อัสคา\nCMP-48-RR-24 5 ตัว\nส่วนลด 30%',
    expect: {
      intent: 'QUOTATION',
      bill_discount_1: 30,
      bill_discount_2: 0,
    },
  },
  {
    id: 'disc-item-level',
    category: '5-discount',
    note: 'ส่วนลดระดับรายการ (ท้ายแถวสินค้า): ลด20+2',
    message: 'เสนอราคา บ.อัสคา\nCMP-48-RR-24 5 ตัว ลด20+2',
    expect: {
      intent: 'QUOTATION',
      bill_discount_1: 0,
      bill_discount_2: 0,
      items: [{ model_includes: 'CMP-48-RR-24', quantity: 5, discount_1: 20, discount_2: 2 }],
    },
  },
  {
    id: 'disc-two-bill',
    category: '5-discount',
    note: 'ส่วนลดสองชั้นระดับบิล: "ลด 20 3"',
    message: 'เสนอราคา บ.อัสคา\nCMP-48-RR-24 5 ตัว\nลด 20 3',
    expect: {
      intent: 'QUOTATION',
      bill_discount_1: 20,
      bill_discount_2: 3,
    },
  },
  {
    id: 'disc-net',
    category: '5-discount',
    note: 'ส่วนลดไม่โชว์ (net): "ลด 30% ไม่โชว์"',
    message: 'เสนอราคา บ.อัสคา\nCMP-48-RR-24 5 ตัว\nลด 30% ไม่โชว์',
    expect: {
      intent: 'QUOTATION',
      bill_discount_1: 30,
      bill_is_net: true,
    },
  },
  {
    id: 'disc-minus-not',
    category: '5-discount',
    note: 'กฎ 3.6: "-30%" ห้ามสกัดเป็นส่วนลด',
    message: 'เสนอราคา บ.อัสคา\nCMP-48-RR-24 5 ตัว -30%',
    expect: {
      intent: 'QUOTATION',
      bill_discount_1: 0,
      bill_discount_2: 0,
    },
  },

  // ─── กลุ่มควบคุม: intent gating (กันหลุดไป QUOTATION ผิด) ────────────────────
  {
    id: 'intent-price-short',
    category: '6-intent-gate',
    note: 'ขอราคาสั้นๆ ต้องเป็น PRODUCT_INFO',
    message: 'ขอราคา CMP-48-RR-24',
    expect: {
      intent: 'PRODUCT_INFO',
      models_includes: ['CMP-48-RR-24'],
    },
  },
  {
    id: 'intent-unclear',
    category: '6-intent-gate',
    note: '"เช็คราคา" ไม่มีรุ่น ต้องเป็น UNCLEAR',
    message: 'เช็คราคา',
    expect: { intent: 'UNCLEAR' },
  },
];
