import pg from 'pg';

/**
 * REFRESH materialized view customers_data_view — single source of truth ของ logic REFRESH
 * (เรียกจากทั้ง CLI sync scripts และ services/syncService.ts)
 *
 * ⚠️ ต้องใช้ pg.Client เฉพาะกิจ ไม่ใช่ pool — เพราะ pool ตั้ง statement_timeout/query_timeout=15s
 *    แต่ REFRESH CONCURRENTLY ใช้ ~10s+ (จะถูกฆ่ากลางคัน). REFRESH CONCURRENTLY ต้องมี unique index
 *    (idx_cdv_company_contact) และห้ามอยู่ใน transaction. ห้าม throw — เป็น guard ท้าย sync
 *
 * NB: ไม่ล้าง in-memory search cache ที่นี่ — นั่นเป็นเรื่องของโปรเซสแอปที่รันอยู่
 *     (syncService ห่อฟังก์ชันนี้แล้วเรียก clearCustomerSearchCache ต่อเอง); CLI one-shot ไม่ต้องใช้
 */
export async function refreshCustomerDataView(): Promise<void> {
  const client = new pg.Client({
    host: process.env.PG_HOST,
    port: process.env.PG_PORT ? parseInt(process.env.PG_PORT) : undefined,
    database: process.env.PG_DATABASE,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
  });
  try {
    await client.connect();
    const t0 = Date.now();
    await client.query('REFRESH MATERIALIZED VIEW CONCURRENTLY public.customers_data_view');
    console.log(`[sync] ♻️ refreshed customers_data_view ใน ${Date.now() - t0}ms`);
  } catch (err: any) {
    console.error('[sync] refresh customers_data_view ล้มเหลว:', err?.message || err);
  } finally {
    try { await client.end(); } catch {}
  }
}
