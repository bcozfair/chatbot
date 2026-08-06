import pg from 'pg';

/**
 * สร้าง customers_data_view ใหม่ — single source of truth ของ logic refresh
 * (เรียกจากทั้ง CLI sync scripts และ services/syncService.ts)
 *
 * ⚠️ customers_data_view เป็น "ตารางจริง" ไม่ใช่ materialized view แล้ว (ตั้งแต่
 *    migrations/changes/2026-08-06_01_customers_data_fast_refresh.sql) — ห้ามสั่ง
 *    REFRESH MATERIALIZED VIEW กับมันอีก
 *
 * กลไก build + swap: สร้างตารางใหม่ทั้งก้อนจาก view customers_data_build (ไม่ล็อกใคร ~2.1 วิ)
 * แล้วสลับชื่อใน transaction เดียว (ถือ AccessExclusiveLock ระดับ ms)
 *   ทำไมไม่ใช้ REFRESH MATERIALIZED VIEW CONCURRENTLY อีก: วัดบน prod ได้ 10.0–11.5 วิ
 *   ทั้งที่ query เองใช้ ~3 วิ — ส่วนต่างคือ Postgres ต้องสร้าง temp table 82k แถว
 *   + สร้าง unique index บนมัน + FULL OUTER JOIN เทียบทั้งแถว 23 คอลัมน์ (เพิ่ม work_mem ไม่ช่วย)
 *
 * ⚠️ ต้องใช้ pg.Client เฉพาะกิจ ไม่ใช่ pool — pool ตั้ง statement_timeout/query_timeout=15s
 *    และ build+swap ห้ามอยู่ใน transaction ของคนอื่น. ห้าม throw — เป็น guard ท้าย sync
 *
 * NB: ไม่ล้าง in-memory search cache ที่นี่ — นั่นเป็นเรื่องของโปรเซสแอปที่รันอยู่
 *     (syncService ห่อฟังก์ชันนี้แล้วเรียก clearCustomerSearchCache ต่อเอง); CLI one-shot ไม่ต้องใช้
 */

/**
 * work_mem ของ session ที่ build เท่านั้น (default 4MB ทำให้ทุก sort/hash ลงดิสก์:
 * sort ของ latest_so external merge 49MB/worker, CTE base 33MB, HashAggregate แตก 21 batches)
 * วัดแล้วขนาดที่ spill จริงสูงสุด ~50MB ต่อ node → 128MB พอครอบ ไม่ต้องเผื่อเกิน
 * jit ปิดเพราะ query นี้เสียเวลา compile ~184ms โดยไม่ได้อะไรกลับมา
 */
const BUILD_SETTINGS = [
  "SET work_mem = '128MB'",
  'SET jit = off',
  // build ปกติ ~2–3 วิ; เผื่อไว้กว้างเพื่อกันตายกลางคันตอนเครื่องโหลดสูง แต่ยังมีเพดาน
  "SET statement_timeout = '120s'",
];

/** ตารางชั่วคราวระหว่าง build — ตั้งชื่อคงที่เพื่อให้รอบถัดไปเก็บกวาดของค้างได้ */
const NEW_TABLE = 'public.customers_data_view_new';

export interface RefreshResult {
  /** true = ข้ามเพราะข้อมูลต้นทางไม่ขยับตั้งแต่รอบก่อน */
  skipped: boolean;
  ms: number;
  rows?: number;
}

export async function refreshCustomerDataView(opts?: { force?: boolean }): Promise<RefreshResult> {
  const t0 = Date.now();
  const client = new pg.Client({
    host: process.env.PG_HOST,
    port: process.env.PG_PORT ? parseInt(process.env.PG_PORT) : undefined,
    database: process.env.PG_DATABASE,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
  });

  try {
    await client.connect();

    // ── 1. watermark: customers/sale_orders ขยับตั้งแต่รอบก่อนไหม ──
    // อ่านก่อน build เสมอ — ถ้ามีข้อมูลเข้ามาระหว่าง build จะได้ถูกจับในรอบถัดไป
    // (บันทึก watermark ที่เก่ากว่าไว้ = พลาดทาง "refresh เกิน" ซึ่งปลอดภัย ไม่ใช่ "refresh ขาด")
    const { rows: wmRows } = await client.query(`
      SELECT GREATEST(
               (SELECT max(sync_updated_at) FROM public.customers),
               (SELECT max(updated_at)      FROM public.sale_orders)
             ) AS wm,
             (SELECT source_watermark FROM public.customers_data_view_state WHERE id = 1) AS prev`);
    const wm: Date | null = wmRows[0]?.wm ?? null;
    const prev: Date | null = wmRows[0]?.prev ?? null;

    if (!opts?.force && wm && prev && wm.getTime() === prev.getTime()) {
      const ms = Date.now() - t0;
      console.log(`[sync] ⏭️ ข้าม refresh customers_data_view — ข้อมูลต้นทางไม่เปลี่ยน (${ms}ms)`);
      return { skipped: true, ms };
    }

    for (const stmt of BUILD_SETTINGS) await client.query(stmt);

    // ── 2. build ตารางใหม่ (ไม่ล็อกของเดิม คนอ่านยังใช้ตารางเก่าได้ตลอด) ──
    await client.query(`DROP TABLE IF EXISTS ${NEW_TABLE}`);
    const tBuild = Date.now();
    await client.query(`CREATE TABLE ${NEW_TABLE} AS SELECT * FROM public.customers_data_build`);
    await client.query(
      `CREATE UNIQUE INDEX idx_cdv_new_company_contact ON ${NEW_TABLE} (company_id, contact_id)`
    );
    await client.query(`CREATE INDEX idx_cdv_new_company ON ${NEW_TABLE} (company_id)`);

    // ตารางที่เพิ่งสร้างยังไม่มี stats — ต้อง ANALYZE ก่อนสลับ ไม่งั้น query แรก ๆ ของแอปจะได้ plan มั่ว
    // (ทำก่อน swap เพราะตอนนี้ยังไม่มีใครอ่านตารางนี้ ไม่กระทบใคร)
    //
    // ⚠️ ANALYZE เต็มรูปแบบตารางนี้ใช้ 7.3 วิ — แพงกว่าตัว build เอง! ต้นเหตุคือคอลัมน์ text ภาษาไทย
    //    (วัดแยก: ANALYZE (customer_name) อย่างเดียว = 5.1 วิ / ANALYZE (company_id, contact_id) = 0.1 วิ)
    //    เพราะการสร้าง MCV/histogram ต้อง sort 30,000 ตัวอย่างด้วย collation ไทยต่อคอลัมน์
    // แก้ด้วยการลด sample ของคอลัมน์ text (target 10 = สุ่ม 3,000 แถว) → 0.7 วิ
    //    คอลัมน์ text ในแอปถูกใช้แค่ ILIKE '%x%' / TRIM(x)=TRIM($1) / IS NOT NULL ซึ่ง planner
    //    ไม่ได้พึ่ง histogram ละเอียดอยู่แล้ว (ไม่มี index บนคอลัมน์เหล่านี้ ยังไง ๆ ก็ seq scan)
    // แล้วเก็บ stats ละเอียดเฉพาะ 2 คอลัมน์ที่เป็นคีย์จริง ๆ ของทุก query (0.1 วิ)
    await client.query('SET default_statistics_target = 10');
    await client.query(`ANALYZE ${NEW_TABLE}`);
    await client.query('SET default_statistics_target = 100');
    await client.query(`ANALYZE ${NEW_TABLE} (company_id, contact_id)`);
    const buildMs = Date.now() - tBuild;

    const { rows: cntRows } = await client.query(`SELECT count(*)::int AS n FROM ${NEW_TABLE}`);
    const rowCount: number = cntRows[0]?.n ?? 0;

    // guard: ตารางว่าง = นิยาม/ข้อมูลต้นทางพัง — อย่าเอาไปทับของเดิมที่ยังใช้งานได้
    if (rowCount === 0) {
      await client.query(`DROP TABLE IF EXISTS ${NEW_TABLE}`);
      console.error('[sync] refresh customers_data_view ยกเลิก: build ได้ 0 แถว — คงตารางเดิมไว้');
      return { skipped: true, ms: Date.now() - t0 };
    }

    // ── 3. สลับชื่อใน transaction เดียว (atomic — ล้มก็ไม่มีช่วงที่ตารางหายไป) ──
    // ห้ามมี view ครอบ customers_data_view — view ผูกกับ OID ของตาราง พอ DROP TABLE ก็ต้อง
    // DROP+CREATE view ตามไปด้วยทุกรอบ ซึ่งยืดเวลาถือ AccessExclusiveLock โดยไม่จำเป็น
    // (customers_data ถูกเลิกใช้แล้วใน migration 2026-08-06_02)
    // lock_timeout กันกรณีมี query ยาวค้างอยู่: ถ้ารอเกิน 5 วิให้ถอย ไม่งั้นคำขอ AccessExclusiveLock
    // ที่ค้างในคิวจะบล็อกคนอ่านที่มาทีหลังทั้งหมดตามไปด้วย — ยอมใช้ข้อมูลรอบก่อนแล้วไปเอาใหม่รอบหน้า
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query('DROP TABLE IF EXISTS public.customers_data_view');
      await client.query(`ALTER TABLE ${NEW_TABLE} RENAME TO customers_data_view`);
      await client.query('ALTER INDEX idx_cdv_new_company_contact RENAME TO idx_cdv_company_contact');
      await client.query('ALTER INDEX idx_cdv_new_company RENAME TO idx_cdv_company');
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      await client.query(`DROP TABLE IF EXISTS ${NEW_TABLE}`).catch(() => {});
      throw err;
    }

    const ms = Date.now() - t0;
    await client.query(
      `UPDATE public.customers_data_view_state
          SET source_watermark = $1, refreshed_at = NOW(), build_ms = $2, row_count = $3
        WHERE id = 1`,
      [wm, buildMs, rowCount]
    );

    console.log(
      `[sync] ♻️ rebuilt customers_data_view ใน ${ms}ms (build ${buildMs}ms, ${rowCount} แถว)`
    );
    return { skipped: false, ms, rows: rowCount };
  } catch (err: any) {
    console.error('[sync] refresh customers_data_view ล้มเหลว:', err?.message || err);
    return { skipped: true, ms: Date.now() - t0 };
  } finally {
    try { await client.end(); } catch {}
  }
}
