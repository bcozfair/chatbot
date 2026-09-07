// ─────────────────────────────────────────────────────────────────────────────
//  ตัวจ่ายข้อมูลออกไปให้ระบบภายนอก sync (endpoint /api/sync/v1/* ใน index.ts)
//
//  หลักคิด 3 ข้อที่ทำให้ไฟล์นี้ "ต่อเติมได้โดยไม่ต้องรื้อ":
//    1. ตารางไหน sync ยังไง อยู่ใน TABLE_REGISTRY ที่เดียว — เพิ่มตารางใหม่ = เพิ่ม 1 บรรทัด
//    2. รายชื่อคอลัมน์ "ไม่ hardcode" — อ่านจาก information_schema ตอนใช้งานครั้งแรกแล้ว cache ไว้
//       เติมคอลัมน์ใหม่ใน DB แล้วปลายทางได้ไปเองโดยไม่ต้องแก้โค้ดที่นี่
//       (ผลข้างเคียงที่ตั้งใจ: คอลัมน์ที่ "ห้ามส่งออก" ต้องประกาศใน exclude เท่านั้นถึงจะไม่หลุด)
//    3. ทุกชื่อตาราง/คอลัมน์ที่ถูกเอาไปต่อเป็น SQL ต้องผ่าน registry หรือ information_schema ก่อน
//       ค่าจากผู้เรียกไม่เคยถูกต่อเข้า SQL ตรง ๆ เลยแม้แต่ที่เดียว
//
//  3 โหมดของการ sync — เลือกจาก "ตารางนั้นถูกแก้และถูกลบยังไง" ไม่ใช่จากขนาด:
//
//    incremental  มี updated_at ที่ขยับทุกครั้งที่เขียน และ "ไม่มีการลบแถว"
//                 → ส่งเฉพาะที่เปลี่ยนหลัง cursor · ปลายทาง upsert ทับ
//                 ใช้กับ sale_orders / customers / products (upsert จาก gateway ล้วน)
//                 และ quotations ที่ลบได้ → จึงมี endpoint /ids ไว้ให้ปลายทางไล่ลบตาม
//
//    append       insert อย่างเดียว ไม่เคย UPDATE → cursor เป็น id ก็พอ ไม่ต้องพึ่ง timestamp
//                 ใช้กับ api_logs / messages
//
//    snapshot     ตารางเล็กที่ "มีการลบจริง" (promotions, rules, blacklist, salesperson, ...)
//                 → ส่งทั้งตาราง ปลายทางแทนที่ยกชุด · delete หายไปเองโดยไม่ต้องทำ tombstone
//                 ตัวใหญ่สุดในกลุ่มนี้คือ product_stock_rules 536 kB — ถูกกว่าการทำ tombstone มาก
//
//  ทุกโหมดแบ่งหน้าแบบ keyset (WHERE (cursor, pk) > (...)) ไม่ใช่ OFFSET
//  เพราะ OFFSET จะข้าม/ซ้ำทันทีที่มีคนเขียนตารางระหว่างที่ปลายทางไล่ดึงหน้าถัด ๆ ไป
// ─────────────────────────────────────────────────────────────────────────────
import { pool, type DbExecutor } from '../config/db.js';

export type SyncMode = 'incremental' | 'append' | 'snapshot';

export interface SyncTableDef {
  /** ชื่อตารางใน schema public — ต้องตรงเป๊ะ ใช้เป็น whitelist ของ SQL ที่ประกอบขึ้น */
  table: string;
  mode: SyncMode;
  /** คอลัมน์ที่ระบุแถวได้ไม่ซ้ำ · ใช้ทั้งตัดสิน tie ของ cursor และเป็นคีย์ upsert ฝั่งปลายทาง */
  pk: string[];
  /** incremental = คอลัมน์เวลา · append = คอลัมน์ id · snapshot ไม่ต้องมี */
  cursor?: string;
  /** คอลัมน์ที่ห้ามส่งออกเด็ดขาด (ไม่งั้นจะหลุดเองเพราะรายชื่อคอลัมน์อ่านจาก DB) */
  exclude?: string[];
  /** ปลายทางควรถามถี่แค่ไหน (วินาที) — ส่งไปใน manifest ให้ตัวดึงอ่านเอง ไม่ได้บังคับที่ฝั่งนี้ */
  pollHintSeconds: number;
  /**
   * ตารางที่ถูก "สร้างใหม่ทั้งใบแล้วสลับ" ไม่ใช่แก้ทีละแถว → ระหว่างไล่ดึงหน้า อาจสลับใบกลางคัน
   * ประกาศที่มาของ watermark ไว้ ทุกหน้าจะแนบ generation กลับไป ปลายทางเห็นค่าเปลี่ยน = เริ่มใหม่
   */
  generation?: { table: string; column: string };
  note?: string;
}

/**
 * ทะเบียนตารางทั้งหมดที่เปิดให้ sync ออกไป
 *
 * ตารางที่ "ไม่อยู่ในนี้" = ยิงเข้ามาได้ 404 เสมอ (default deny) — ตารางใหม่ที่ migration สร้างขึ้น
 * จะไม่หลุดออกไปเองโดยไม่มีใครตัดสินใจ · scripts/diag/syncApiSmoke.ts คอยเตือนว่ามีตารางตกทะเบียน
 */
export const TABLE_REGISTRY: SyncTableDef[] = [
  // ── ก้อนใหญ่ 3 ตารางที่มาจาก gateway: upsert ล้วน ไม่มี DELETE ที่ไหนในโค้ดเลย ───────────
  // cursor ใช้ updated_at (= NOW() ตอนเราเขียน) ไม่ใช่ sync_updated_at (= เวลาของฝั่ง Odoo)
  // เพราะสิ่งที่ปลายทางถามคือ "มีอะไรเปลี่ยนใน DB นี้หลังจากที่ฉันดึงไปแล้วบ้าง"
  // ถ้าใช้เวลาของ Odoo แถวที่เพิ่งไหลเข้ามาแต่มี timestamp เก่าจะอยู่หลัง cursor แล้วหายถาวร
  { table: 'sale_orders', mode: 'incremental', pk: ['order_reference'], cursor: 'updated_at', pollHintSeconds: 600 },
  { table: 'customers',   mode: 'incremental', pk: ['company_id', 'contact_id'], cursor: 'updated_at', pollHintSeconds: 600 },
  { table: 'products',    mode: 'incremental', pk: ['product_template_id'], cursor: 'updated_at', pollHintSeconds: 600 },

  // ใบเสนอราคา — incremental แต่ "ลบได้จริง" (ล้างใบค้าง pending, ยกเลิกใบ)
  // ปลายทางต้องเรียก /ids เป็นรอบ ๆ เพื่อไล่ลบใบที่หายไป ไม่งั้นใบผีจะค้างที่ปลายทางตลอดกาล
  {
    table: 'quotations', mode: 'incremental', pk: ['id'], cursor: 'updated_at', pollHintSeconds: 600,
    note: 'มีการลบแถวจริง — ต้องไล่ /ids เพื่อ reconcile',
  },

  // ── insert ล้วน ────────────────────────────────────────────────────────────────────
  // messages: reply_token ตัดออก — เป็นกุญแจตอบกลับ LINE (อายุ 1 นาที) ไม่มีเหตุผลให้ออกนอกเครื่อง
  { table: 'messages', mode: 'append', pk: ['id'], cursor: 'id', exclude: ['reply_token'], pollHintSeconds: 600 },
  // api_logs: ฝั่งนี้ลบของเก่าทิ้งตาม API_LOG_RETENTION_DAYS — ปลายทางเก็บได้ยาวกว่าตามใจ
  { table: 'api_logs', mode: 'append', pk: ['id'], cursor: 'id', pollHintSeconds: 3600 },

  // ── ตารางเล็กที่มี DELETE → snapshot ยกตาราง ─────────────────────────────────────────
  // admin_users: password_hash ตัดออกเด็ดขาด — bcrypt hash ที่หลุดออกไปคือของที่เอาไปไล่เดาต่อได้
  { table: 'admin_users', mode: 'snapshot', pk: ['id'], exclude: ['password_hash'], pollHintSeconds: 3600 },
  { table: 'salesperson',              mode: 'snapshot', pk: ['user_id'],            pollHintSeconds: 900 },
  { table: 'promotions',               mode: 'snapshot', pk: ['id'],                 pollHintSeconds: 900 },
  { table: 'quotation_rules',          mode: 'snapshot', pk: ['id'],                 pollHintSeconds: 900 },
  { table: 'quotation_blacklist',      mode: 'snapshot', pk: ['id'],                 pollHintSeconds: 900 },
  { table: 'quotation_credit_policy',  mode: 'snapshot', pk: ['id'],                 pollHintSeconds: 900 },
  { table: 'quotation_counters',       mode: 'snapshot', pk: ['counter_key'],        pollHintSeconds: 900 },
  { table: 'shipping_fee_config',      mode: 'snapshot', pk: ['id'],                 pollHintSeconds: 900 },
  { table: 'product_stock_rules',      mode: 'snapshot', pk: ['internal_reference'], pollHintSeconds: 900 },
  { table: 'product_moq_rules',        mode: 'snapshot', pk: ['internal_reference'], pollHintSeconds: 900 },
  { table: 'product_optional_links',   mode: 'snapshot', pk: ['id'],                 pollHintSeconds: 900 },
  { table: 'sync_settings',            mode: 'snapshot', pk: ['id'],                 pollHintSeconds: 900 },
  { table: 'sync_state',               mode: 'snapshot', pk: ['resource'],           pollHintSeconds: 900 },
  { table: 'customers_data_view_state', mode: 'snapshot', pk: ['id'],                pollHintSeconds: 900 },
  // 2 ตารางนี้แถวถูก UPDATE ทีหลังได้ (ถอนเครื่องหมายส่งออก → reverted_at) จึงเป็น snapshot
  // ไม่ใช่ append ทั้งที่หน้าตาเหมือน log — append จะไม่มีวันเห็นการถอนเลย
  { table: 'quotation_export_log',     mode: 'snapshot', pk: ['id'],                 pollHintSeconds: 900 },
  { table: 'quotation_export_batches', mode: 'snapshot', pk: ['id'],                 pollHintSeconds: 900 },

  // ── ตารางสรุปที่ถูกสร้างใหม่ทั้งใบทุกรอบ refresh ──────────────────────────────────────
  // 82k แถว/41 MB และไม่มี updated_at รายแถว → ดึงทั้งใบอย่างเดียว จึงตั้ง hint เป็นวันละครั้ง
  // ปลายทางที่ไม่อยากดึงก้อนนี้ก็ประกอบเองได้จาก customers + sale_orders (สูตรอยู่ใน migrations/schema.sql)
  {
    table: 'customers_data_view', mode: 'snapshot', pk: ['company_id', 'contact_id'], pollHintSeconds: 86400,
    generation: { table: 'customers_data_view_state', column: 'refreshed_at' },
    note: 'ตารางสรุปที่ถูก build ใหม่แล้วสลับทั้งใบ — เทียบ generation ทุกหน้า ถ้าเปลี่ยนให้ดึงใหม่ตั้งแต่ต้น',
  },
];

const REGISTRY_BY_TABLE = new Map(TABLE_REGISTRY.map((d) => [d.table, d]));

export function getTableDef(table: string): SyncTableDef | undefined {
  return REGISTRY_BY_TABLE.get(table);
}

/**
 * ชื่อคอลัมน์ชั่วคราวที่ใช้พาค่าเวลาแบบ "ข้อความเต็มความละเอียด" ออกมาทำ cursor แล้วถูกลบทิ้งก่อนตอบ
 * ขึ้นต้นด้วย __ เพื่อไม่ให้ชนกับคอลัมน์จริง · scripts/diag/syncApiSmoke.ts มีข้อคอยตรวจว่าไม่ชนจริง
 */
const CURSOR_TS_ALIAS = '__cursor_ts';

/** ค่าตั้งต้น/เพดานจำนวนแถวต่อหน้า — เพดานคุมทั้งขนาด response และเวลาต่อ query ให้อยู่ใต้ statement_timeout 15 วิ */
export const DEFAULT_LIMIT = 500;
export const MAX_LIMIT = 2000;

/** ชื่อ identifier ที่ยอมให้ประกอบเป็น SQL ได้ — กันพลาดซ้ำอีกชั้นแม้ค่าจะมาจาก registry/DB แล้ว */
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

function quoteIdent(name: string): string {
  if (!IDENT_RE.test(name)) {
    throw new Error(`[externalSync] ชื่อคอลัมน์/ตารางไม่ผ่านการตรวจ: ${name}`);
  }
  return `"${name}"`;
}

// รายชื่อคอลัมน์ต่อตาราง — อ่านครั้งเดียวต่ออายุ process (schema เปลี่ยนต้อง restart แอป ซึ่ง
// ทุกวันนี้ก็ต้อง restart อยู่แล้วเวลาลง migration ที่แตะโครงตาราง)
const columnCache = new Map<string, string[]>();

export async function getColumns(def: SyncTableDef, db: DbExecutor = pool): Promise<string[]> {
  const cached = columnCache.get(def.table);
  if (cached) return cached;

  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [def.table]
  );
  if (rows.length === 0) {
    throw new Error(`[externalSync] ไม่พบตาราง ${def.table} ใน DB (registry กับ schema ไม่ตรงกัน)`);
  }

  const excluded = new Set(def.exclude ?? []);
  const cols = rows.map((r: any) => r.column_name as string).filter((c) => !excluded.has(c));
  columnCache.set(def.table, cols);
  return cols;
}

/** ล้าง cache รายชื่อคอลัมน์ — มีไว้ให้ diag ทดสอบซ้ำได้โดยไม่ต้องเปิด process ใหม่ */
export function clearColumnCache(): void {
  columnCache.clear();
}

/**
 * cursor ที่ส่งกลับไปให้ปลายทางเป็น base64url ของ JSON array = [ค่า cursor, ค่า pk...]
 *
 * ที่ห่อแทนการส่งค่าดิบ: ปลายทางจะได้ไม่ไปเดาโครงสร้างแล้วประกอบเอง เวลาเราเพิ่มคอลัมน์ตัดสิน tie
 * ในอนาคตจะได้ไม่พังทั้งระบบ · ไม่ได้เข้ารหัสและไม่ต้องเข้า — ในนั้นไม่มีอะไรที่ปลายทางไม่มีสิทธิ์เห็น
 */
export function encodeCursor(values: unknown[]): string {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
}

export function decodeCursor(token: string, expectedLength: number): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw new Error('cursor ไม่ถูกต้อง');
  }
  if (!Array.isArray(parsed) || parsed.length !== expectedLength) {
    throw new Error('cursor ไม่ถูกต้อง');
  }
  return parsed;
}

/** คอลัมน์ที่ประกอบเป็นลำดับของการไล่หน้า: incremental = [cursor, ...pk] · append/snapshot = [cursor|...pk] */
export function orderColumns(def: SyncTableDef): string[] {
  if (def.mode === 'incremental') return [def.cursor!, ...def.pk];
  if (def.mode === 'append') return [def.cursor!];
  return def.pk;
}

export interface FetchPageParams {
  def: SyncTableDef;
  /** เอาเฉพาะแถวที่ cursor >= ค่านี้ (ISO timestamp) — ใช้เฉพาะ incremental และเฉพาะหน้าแรก */
  since?: string;
  /** token จากหน้าก่อน — มีแล้ว since จะถูกมองข้าม เพราะ token คุมตำแหน่งได้แม่นกว่า */
  cursor?: string;
  limit: number;
}

export interface FetchPageResult {
  rows: any[];
  nextCursor: string | null;
  hasMore: boolean;
  generation: string | null;
}

/**
 * ดึงข้อมูลหนึ่งหน้า
 *
 * ขอ limit+1 แถวเสมอเพื่อรู้ว่า "ยังมีต่อไหม" โดยไม่ต้อง COUNT(*) ซ้ำอีกรอบ
 * (COUNT บน sale_orders 316k แถวต่อหนึ่งหน้า = งานที่แพงกว่าตัว query หลักหลายเท่า)
 */
export async function fetchPage(params: FetchPageParams, db: DbExecutor = pool): Promise<FetchPageResult> {
  const { def, limit } = params;
  const cols = await getColumns(def, db);
  const order = orderColumns(def);

  const orderList = order.map(quoteIdent).join(', ');

  // ── ทำไมต้องดึงคอลัมน์เวลาซ้ำอีกรอบเป็น text ──────────────────────────────────────────
  // timestamptz ของ Postgres ละเอียดระดับไมโครวินาที แต่ Date ของ JS เก็บได้แค่มิลลิวินาที
  // ถ้าเอาค่าที่ผ่าน Date มาทำ cursor ค่าจะถูก "ปัดลง" ทุกครั้ง → หน้าถัดไปเริ่มก่อนจุดที่ค้างไว้
  // ผลคือได้แถวเดิมซ้ำทุกหน้า และถ้าทั้งหน้ามี updated_at อยู่ในมิลลิวินาทีเดียวกัน (ซึ่งเกิดจริง
  // เพราะ upsert เป็น batch) cursor จะไม่ขยับเลย = ตัวดึงวนลูปไม่รู้จบ ดึงแถวเดิมตลอดกาล
  // จึงให้ Postgres แปลงเป็นข้อความให้เอง (มี offset ติดมาด้วย เอากลับไป bind เป็น timestamptz ได้ตรง)
  const needsTextCursor = def.mode === 'incremental';
  const selectList =
    cols.map(quoteIdent).join(', ') +
    (needsTextCursor ? `, ${quoteIdent(def.cursor!)}::text AS ${quoteIdent(CURSOR_TS_ALIAS)}` : '');

  const values: unknown[] = [];
  const where: string[] = [];

  if (params.cursor) {
    const parts = decodeCursor(params.cursor, order.length);
    const placeholders = parts.map((v, i) => {
      values.push(v);
      // คอลัมน์เวลาต้องบอกชนิดให้ชัด — ค่าที่ส่งมาเป็นข้อความ ถ้าปล่อยให้ Postgres เดาเองในบางแผน
      // มันจะเทียบแบบข้อความ ซึ่ง "เรียงถูกโดยบังเอิญ" จนกว่าจะเจอค่าที่รูปแบบต่างกันแล้วพังเงียบ ๆ
      const cast = needsTextCursor && order[i] === def.cursor ? '::timestamptz' : '';
      return `$${values.length}${cast}`;
    });
    // เทียบแบบ row comparison ทีเดียว — ตรงกับ index (cursor, pk) พอดี และไม่ต้องเขียน
    // เงื่อนไข OR ซ้อนกันเองซึ่งเป็นจุดที่ keyset pagination พังบ่อยที่สุด
    where.push(`(${orderList}) > (${placeholders.join(', ')})`);
  } else if (params.since && def.mode === 'incremental') {
    values.push(params.since);
    // >= ไม่ใช่ > โดยเจตนา: ปลายทางส่ง since ที่ได้จากรอบก่อนกลับมา ยอมให้ซ้ำ 1 แถวดีกว่าเสี่ยงข้าม
    // (upsert ที่ปลายทางทำให้แถวซ้ำไม่มีผลอะไร แต่แถวที่ข้ามคือข้อมูลหายถาวร)
    where.push(`${quoteIdent(def.cursor!)} >= $${values.length}::timestamptz`);
  }

  values.push(limit + 1);
  const sql =
    `SELECT ${selectList} FROM public.${quoteIdent(def.table)}` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY ${orderList} LIMIT $${values.length}`;

  const { rows } = await db.query(sql, values);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor: string | null = null;
  if (page.length > 0) {
    const last = page[page.length - 1];
    nextCursor = encodeCursor(
      order.map((c) =>
        needsTextCursor && c === def.cursor ? last[CURSOR_TS_ALIAS] : normalizeCursorValue(last[c])
      )
    );
  }

  // คอลัมน์ช่วยของเราเอง ไม่ใช่ข้อมูลของตาราง — ต้องไม่หลุดออกไปให้ปลายทางเก็บไว้
  if (needsTextCursor) {
    for (const r of page) delete r[CURSOR_TS_ALIAS];
  }

  return { rows: page, nextCursor, hasMore, generation: await readGeneration(def, db) };
}

function normalizeCursorValue(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  return v;
}

async function readGeneration(def: SyncTableDef, db: DbExecutor): Promise<string | null> {
  if (!def.generation) return null;
  const { rows } = await db.query(
    `SELECT ${quoteIdent(def.generation.column)} AS gen FROM public.${quoteIdent(def.generation.table)} LIMIT 1`
  );
  const gen = rows[0]?.gen;
  return gen instanceof Date ? gen.toISOString() : gen ?? null;
}

/**
 * รายการ pk ทั้งตาราง สำหรับให้ปลายทางไล่ลบแถวที่หายไป (reconcile)
 *
 * เปิดเฉพาะโหมด incremental — snapshot ไม่ต้องใช้เพราะแทนที่ยกตารางอยู่แล้ว
 * ส่วน append ไม่มีการลบ (ยกเว้น api_logs ที่ลบตาม retention ซึ่งปลายทางไม่ควรลบตาม)
 */
export async function fetchIds(
  def: SyncTableDef,
  cursor: string | undefined,
  limit: number,
  db: DbExecutor = pool
): Promise<FetchPageResult> {
  const pkList = def.pk.map(quoteIdent).join(', ');
  const values: unknown[] = [];
  let where = '';

  if (cursor) {
    const parts = decodeCursor(cursor, def.pk.length);
    const placeholders = parts.map((v) => {
      values.push(v);
      return `$${values.length}`;
    });
    where = ` WHERE (${pkList}) > (${placeholders.join(', ')})`;
  }

  values.push(limit + 1);
  const { rows } = await db.query(
    `SELECT ${pkList} FROM public.${quoteIdent(def.table)}${where} ORDER BY ${pkList} LIMIT $${values.length}`,
    values
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    rows: page,
    nextCursor: last ? encodeCursor(def.pk.map((c) => normalizeCursorValue(last[c]))) : null,
    hasMore,
    generation: null,
  };
}

/** manifest ที่ปลายทางอ่านตอนเริ่มทำงาน เพื่อรู้ว่ามีตารางอะไร ต้อง upsert ด้วยคีย์ไหน ถามถี่แค่ไหน */
export async function buildManifest(allowed: string[] | null, db: DbExecutor = pool) {
  const defs = allowed ? TABLE_REGISTRY.filter((d) => allowed.includes(d.table)) : TABLE_REGISTRY;
  return Promise.all(
    defs.map(async (d) => ({
      table: d.table,
      mode: d.mode,
      pk: d.pk,
      cursor_column: d.cursor ?? null,
      columns: await getColumns(d, db),
      poll_hint_seconds: d.pollHintSeconds,
      supports_ids: d.mode === 'incremental',
      note: d.note ?? null,
    }))
  );
}
