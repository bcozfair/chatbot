// ─────────────────────────────────────────────────────────────────────────────
//  นิยาม "เป็นนิติบุคคลเดียวกัน" — จุดเดียวในระบบที่ตัดสินว่า company_id สองตัวคือรายเดียวกัน
//
//  ไฟล์นี้ให้ SQL fragment ล้วน ๆ ไม่ยิง query เอง เพื่อให้ผู้เรียกฝังลงใน query
//  ของตัวเองได้โดยไม่เสีย index (ดูเหตุผลเรื่อง planner ในคอมเมนต์ท้ายไฟล์)
//
//  ── ทำไมต้องขยาย ไม่เทียบ company_id ตรง ๆ ──
//  Odoo แตกนิติบุคคลเดียวกันออกเป็นหลาย company_id เช่น "บริษัท ไพรมัส จำกัด" มีทั้ง
//  company_id 1 (A/00000), 969120 (A0010), 624570 (N/03953), 1001848 (สาขา 00012) ...
//  วัดจากข้อมูลจริง: เลขภาษี 2,021 เลขผูกกับ company_id มากกว่า 1 ตัว รวม 4,929 รหัส
//  มากสุด 50 รหัสต่อนิติบุคคลเดียว
//
//  และชั้นผู้ติดต่อก็มีปัญหาเดียวกัน — Odoo ให้ contact_id คนละเลขกับ "คนคนเดียวกัน"
//  ที่อยู่ใต้คนละ company_id เช่น "คุณสนธยา" เป็น contact 973133 ใต้ company 435106
//  และ contact 984909 ใต้ company 435114 ทั้งที่เลขภาษีเดียวกัน
//  วัดได้ 1,081 เคสที่ชื่อผู้ติดต่อเดียวกันโผล่ใต้หลาย company_id ในนิติบุคคลเดียวกัน
//  และทั้ง 1,081 เคสมี contact_id ต่างกันหมด ไม่มีเคสไหนใช้เลขเดียวกันเลย
//
//  ── กติกา ──
//  บริษัท : ตรงกันแค่ข้อใดข้อหนึ่งใน 3 ข้อถือว่าเป็นรายเดียวกัน — เลขผู้เสียภาษี / รหัสอ้างอิง / ชื่อ
//  ผู้ติดต่อ: ชื่อผู้ติดต่อตรงกัน *ภายในกลุ่มบริษัทข้างบนแล้วเท่านั้น*
//
//  ⚠️ กติกานี้ถูกใช้ทั้งฝั่ง "ห้ามเสนอราคา" (services/blacklistService.ts) และฝั่ง
//     "ค้นผู้ติดต่อให้เซลส์เลือก" (db/repositories.ts) — ต้องเป็นนิยามเดียวกันเสมอ
//     ถ้าแยกกันเมื่อไหร่ จะเกิดช่องที่ค้นเจอแต่ด่านไม่เห็น (หรือกลับกัน)
// ─────────────────────────────────────────────────────────────────────────────

/** ยุบ "คีย์บ่งชี้นิติบุคคล" ของบริษัทหนึ่งเป็น array — ค่าว่างถูกคัดทิ้งก่อนเสมอ */
export function companyKeysSql(c: string): string {
  return `
    array_agg(DISTINCT NULLIF(TRIM(${c}.customer_tax_id),''))    FILTER (WHERE NULLIF(TRIM(${c}.customer_tax_id),'')    IS NOT NULL) AS taxes,
    array_agg(DISTINCT NULLIF(TRIM(${c}.customer_reference),'')) FILTER (WHERE NULLIF(TRIM(${c}.customer_reference),'') IS NOT NULL) AS refs,
    array_agg(DISTINCT NULLIF(TRIM(${c}.customer_name),''))      FILTER (WHERE NULLIF(TRIM(${c}.customer_name),'')      IS NOT NULL) AS nms`;
}

/**
 * ยุบ "ชื่อผู้ติดต่อที่เจาะจง" เป็น array (0 หรือ 1 ตัว) — `pin` คือเงื่อนไขเลือกแถวผู้ติดต่อ
 *
 * ⚠️ ค่าว่างและ 'none' ห้ามหลุดเข้ามา — 'none' คือค่าที่ Odoo ใส่แทนผู้ติดต่อที่ไม่มีชื่อ
 *    (4,397 แถว) รวมกับแถวที่ชื่อว่างเป็น 8,168 จาก 81,994 แถว ถ้าปล่อยให้ match กันเอง
 *    การบล็อกผู้ติดต่อไร้ชื่อคนเดียวจะกลายเป็นบล็อกผู้ติดต่อไร้ชื่อทั้งนิติบุคคล
 *    ซึ่งไม่ใช่สิ่งที่แอดมินสั่ง
 */
export function contactKeySql(c: string, pin: string): string {
  return `
    array_agg(DISTINCT NULLIF(TRIM(${c}.contact_name),'')) FILTER (
      WHERE ${pin}
        AND NULLIF(TRIM(${c}.contact_name),'') IS NOT NULL
        AND lower(TRIM(${c}.contact_name)) <> 'none') AS cnms`;
}

/** แถว `t` ของ cdv เป็นนิติบุคคลเดียวกับชุดคีย์ `k` หรือไม่ */
export function matchesKeysSql(t: string, k: string): string {
  return `(
       NULLIF(TRIM(${t}.customer_tax_id),'')    = ANY(${k}.taxes)
    OR NULLIF(TRIM(${t}.customer_reference),'') = ANY(${k}.refs)
    OR NULLIF(TRIM(${t}.customer_name),'')      = ANY(${k}.nms)
  )`;
}

/** ชุดคีย์สองชุดชี้ไปนิติบุคคลเดียวกันหรือไม่ */
export function keysOverlapSql(a: string, b: string): string {
  return `(${a}.taxes && ${b}.taxes OR ${a}.refs && ${b}.refs OR ${a}.nms && ${b}.nms)`;
}

// ── ทำไมยุบเป็น array แทนที่จะ JOIN cdv กับตัวเอง ──
// เคยเขียนเป็น `cdv q JOIN cdv t ON (เงื่อนไขตรงกัน)` แล้ววัดได้ 1,091 ms เพราะ planner
// ตัดความสัมพันธ์กับตารางที่กรองอยู่ทิ้ง (de-correlate) เปลี่ยน EXISTS เป็น hashed SubPlan
// ที่ต้อง scan cdv ทั้ง 82k แถวก่อนเสมอ
// รูปแบบปัจจุบันคือ "ยุบคีย์ของบริษัทเป็น array ด้วย index scan แล้วค่อยเทียบ array"
// ทุกขั้นจึงเป็น index scan แน่นอน — วัดได้ 0.98 ms อ่านแค่ 28 buffers (ของเดิม 9,367)
