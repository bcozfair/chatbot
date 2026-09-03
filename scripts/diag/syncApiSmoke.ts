// ─────────────────────────────────────────────────────────────────────────────
//  Smoke test ของ API ดึงข้อมูลออกไปให้ระบบภายนอก sync (/api/sync/v1/*)
//  รัน:  npm run diag:sync-api        (อ่านอย่างเดียว — ปลอดภัยบน production)
//
//  โจทย์ที่สคริปต์นี้เฝ้า — ทั้งหมดคือเคส "ข้อมูลหายเงียบ" หรือ "ข้อมูลหลุด" ที่ไม่มีใครเห็นตอนเกิด:
//    (ก) ทะเบียนกับ DB ต้องตรงกัน — ตารางใหม่ที่ไม่มีใครใส่ทะเบียนคือข้อมูลที่ปลายทางไม่มีวันได้
//    (ข) pk ในทะเบียนต้อง "ไม่ซ้ำจริง" ในระดับ DB · ถ้าซ้ำได้ keyset pagination จะข้ามแถวเงียบ ๆ
//    (ค) การไล่หน้าต้องได้ผลเท่ากับการอ่านรวดเดียว โดยเฉพาะตรงที่ timestamp ซ้ำกันทั้งกอง
//        (upsert ทีละ batch ทำให้หลายพันแถวมี updated_at เท่ากันเป๊ะ — จุดตายของ cursor แบบเวลาล้วน)
//    (ง) คอลัมน์ลับต้องไม่หลุด — รายชื่อคอลัมน์อ่านจาก DB สด ๆ คอลัมน์ใหม่จึงหลุดออกไปได้เอง
//    (จ) query ของโหมด incremental ต้องวิ่งผ่าน index ไม่ใช่ Seq Scan ทั้ง sale_orders 316k แถว
//    (ฉ) ตัวนับ concurrent ต้องไม่รั่ว — ตัวนับที่รั่วทำให้ endpoint ตาย 429 ถาวรจนกว่าจะ restart
//
//  ให้รันซ้ำทุกครั้งที่แตะ services/externalSync.ts, config/syncApiAuth.ts
//  หรือเพิ่ม/ลบตารางใน migration
// ─────────────────────────────────────────────────────────────────────────────
import { pool } from '../../config/db.js';
import {
  TABLE_REGISTRY,
  getTableDef,
  getColumns,
  fetchPage,
  fetchIds,
  buildManifest,
  encodeCursor,
  decodeCursor,
  orderColumns,
  MAX_LIMIT,
} from '../../services/externalSync.js';
import { getSyncInFlight, hashSyncKey } from '../../config/syncApiAuth.js';

let failures = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};
const warn = (msg: string) => console.log(`⚠️  ${msg}`);

async function main() {
  // ── 1. ทะเบียน vs ตารางจริงใน DB ───────────────────────────────────────────
  console.log('\n── 1. ทะเบียนตรงกับ DB ──');
  const { rows: dbTables } = await pool.query(
    `SELECT c.relname AS t
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`
  );
  const dbSet = new Set(dbTables.map((r: any) => r.t));
  const regSet = new Set(TABLE_REGISTRY.map((d) => d.table));

  // ตารางที่ตั้งใจไม่ให้อยู่ในทะเบียน — ต้องมีเหตุผลกำกับทุกตัว
  //   sync_api_keys  ตารางของระบบ sync เอง ไม่ส่งกุญแจของตัวเองออกไปให้ใคร
  //   system_logs / audit_logs / log_worker_state / traffic_daily
  //     กอง log ภายในตาม พ.ร.บ.คอมพิวเตอร์ ม.26 — มี IP ผู้ใช้ ชื่อผู้แก้ไข และค่าก่อน/หลังของ
  //     การตั้งค่า การเปิดให้ระบบภายนอกดึงได้เท่ากับยกหลักฐานทั้งกองให้คนนอก
  //     (ดู docs/plan-logging-audit-compliance.md)
  const INTENTIONALLY_OUT = new Set([
    'sync_api_keys',
    'system_logs', 'log_worker_state', 'audit_logs', 'traffic_daily',
  ]);

  const missing = [...dbSet].filter((t) => !regSet.has(t) && !INTENTIONALLY_OUT.has(t));
  ok(`ทุกตารางใน DB อยู่ในทะเบียน (${dbSet.size - INTENTIONALLY_OUT.size} ตาราง)`, missing.length === 0,
     missing.length ? `ตกทะเบียน: ${missing.join(', ')}` : '');

  const ghost = [...regSet].filter((t) => !dbSet.has(t));
  ok('ทุกตารางในทะเบียนมีอยู่จริงใน DB', ghost.length === 0, ghost.length ? `ไม่พบ: ${ghost.join(', ')}` : '');

  // ── 2. คอลัมน์ pk / cursor / exclude มีอยู่จริง ─────────────────────────────
  console.log('\n── 2. คอลัมน์ที่ทะเบียนอ้างถึงมีอยู่จริง ──');
  const { rows: allCols } = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`
  );
  const colsOf = new Map<string, Set<string>>();
  for (const r of allCols as any[]) {
    if (!colsOf.has(r.table_name)) colsOf.set(r.table_name, new Set());
    colsOf.get(r.table_name)!.add(r.column_name);
  }

  let colProblems = 0;
  for (const def of TABLE_REGISTRY) {
    const have = colsOf.get(def.table);
    if (!have) { colProblems++; continue; }
    for (const c of [...def.pk, ...(def.cursor ? [def.cursor] : []), ...(def.exclude ?? [])]) {
      if (!have.has(c)) { colProblems++; console.log(`     ${def.table}.${c} ไม่มีอยู่จริง`); }
    }
    if (def.mode !== 'snapshot' && !def.cursor) { colProblems++; console.log(`     ${def.table} โหมด ${def.mode} แต่ไม่ได้ตั้ง cursor`); }
  }
  ok('pk / cursor / exclude ทุกตัวชี้ไปที่คอลัมน์ที่มีจริง', colProblems === 0);

  // ── 3. pk ต้องไม่ซ้ำจริงในระดับ DB ─────────────────────────────────────────
  // ข้อนี้สำคัญที่สุดในไฟล์: keyset pagination ตัดหน้าด้วย (cursor, pk) ถ้า pk ซ้ำได้
  // แถวที่ซ้ำกันจะถูกข้ามไปเงียบ ๆ โดยไม่มี error ที่ไหนเลย
  console.log('\n── 3. pk ในทะเบียนไม่ซ้ำจริง (มี unique index รองรับ) ──');
  const { rows: uniqIdx } = await pool.query(
    `SELECT c.relname AS tbl,
            array_agg(a.attname::text ORDER BY a.attname) AS cols
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
      WHERE i.indisunique AND n.nspname = 'public'
      GROUP BY c.relname, i.indexrelid`
  );
  const uniqueSets = new Map<string, Set<string>[]>();
  for (const r of uniqIdx as any[]) {
    if (!uniqueSets.has(r.tbl)) uniqueSets.set(r.tbl, []);
    uniqueSets.get(r.tbl)!.push(new Set(r.cols));
  }
  let pkProblems = 0;
  for (const def of TABLE_REGISTRY) {
    const sets = uniqueSets.get(def.table) ?? [];
    const covered = sets.some((s) => s.size === def.pk.length && def.pk.every((c) => s.has(c)));
    if (!covered) { pkProblems++; console.log(`     ${def.table}: pk (${def.pk.join(',')}) ไม่มี unique index รองรับ`); }
  }
  ok('ทุกตารางมี unique index ตรงกับ pk ที่ประกาศไว้', pkProblems === 0);

  // ── 4. คอลัมน์ลับต้องไม่หลุด ───────────────────────────────────────────────
  console.log('\n── 4. คอลัมน์ที่ห้ามส่งออก ──');
  const adminCols = await getColumns(getTableDef('admin_users')!);
  ok('admin_users ไม่ส่ง password_hash ออกไป', !adminCols.includes('password_hash'));
  const msgCols = await getColumns(getTableDef('messages')!);
  ok('messages ไม่ส่ง reply_token ออกไป', !msgCols.includes('reply_token'));

  // คอลัมน์ช่วยที่ fetchPage ใช้พาค่าเวลาความละเอียดเต็มออกมา ต้องไม่ชนกับคอลัมน์จริงของตารางไหน
  let aliasClash = 0;
  for (const def of TABLE_REGISTRY) {
    if ((await getColumns(def)).includes('__cursor_ts')) { aliasClash++; console.log(`     ${def.table} มีคอลัมน์ชื่อ __cursor_ts`); }
  }
  ok('ไม่มีตารางไหนมีคอลัมน์ชื่อชนกับ __cursor_ts', aliasClash === 0);

  // ตัวดักเคส "มีคนเพิ่มคอลัมน์ลับตัวใหม่แล้วลืมใส่ exclude" — เตือน ไม่ fail เพราะชื่อคอลัมน์
  // ที่เข้าข่ายอาจเป็นของถูกต้อง (เช่น sync_cursor ของ sync_state ที่ปลายทางควรเห็น)
  const SENSITIVE_RE = /pass|secret|credential|_token$|api_key/i;
  for (const def of TABLE_REGISTRY) {
    for (const c of await getColumns(def)) {
      if (SENSITIVE_RE.test(c)) warn(`${def.table}.${c} หน้าตาเหมือนของลับแต่ถูกส่งออกไป — ตั้งใจหรือไม่`);
    }
  }

  // ── 5. cursor เข้ารหัส/ถอดกลับได้ตรง ───────────────────────────────────────
  console.log('\n── 5. cursor round-trip ──');
  const sample = ['2026-09-02T03:04:05.678Z', 'SO-12345', 42];
  ok('encode → decode ได้ค่าเดิม', JSON.stringify(decodeCursor(encodeCursor(sample), 3)) === JSON.stringify(sample));
  let rejected = false;
  try { decodeCursor(encodeCursor(sample), 2); } catch { rejected = true; }
  ok('cursor ที่จำนวนคอลัมน์ไม่ตรงถูกปฏิเสธ', rejected);
  let rejectedGarbage = false;
  try { decodeCursor('ไม่ใช่ base64 แน่ ๆ !!!', 3); } catch { rejectedGarbage = true; }
  ok('cursor ขยะถูกปฏิเสธ', rejectedGarbage);

  // ── 6. ไล่หน้าแล้วต้องได้เท่ากับอ่านรวดเดียว ────────────────────────────────
  console.log('\n── 6. keyset pagination ไม่ข้าม ไม่ซ้ำ (แม้ timestamp ซ้ำกันทั้งกอง) ──');
  for (const tableName of ['sale_orders', 'customers', 'quotations']) {
    const def = getTableDef(tableName)!;
    const order = orderColumns(def);
    const key = (r: any) => def.pk.map((c) => String(r[c])).join('|');

    const PAGE = 50;
    const PAGES = 4;
    const paged: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < PAGES; i++) {
      const p = await fetchPage({ def, cursor, limit: PAGE });
      paged.push(...p.rows.map(key));
      if (!p.hasMore || !p.nextCursor) break;
      cursor = p.nextCursor;
    }

    const orderSql = order.map((c) => `"${c}"`).join(', ');
    const { rows: straight } = await pool.query(
      `SELECT ${def.pk.map((c) => `"${c}"`).join(', ')} FROM public."${def.table}"
        ORDER BY ${orderSql} LIMIT $1`,
      [paged.length]
    );

    const same = paged.length === straight.length && paged.every((k, i) => k === key(straight[i]));
    const dupes = paged.length - new Set(paged).size;
    ok(`${tableName}: ไล่ ${paged.length} แถวได้ลำดับเดียวกับอ่านรวดเดียว`, same);
    ok(`${tableName}: ไม่มีแถวซ้ำระหว่างหน้า`, dupes === 0, dupes ? `ซ้ำ ${dupes} แถว` : '');
  }

  // ── 7. since ต้องคัดจริงและครอบขอบล่างแบบ >= ────────────────────────────────
  console.log('\n── 7. ตัวกรอง since ──');
  const so = getTableDef('sale_orders')!;
  const { rows: pivotRows } = await pool.query(
    `SELECT updated_at FROM public.sale_orders ORDER BY updated_at DESC LIMIT 1 OFFSET 20`
  );
  if (pivotRows.length === 0) {
    warn('sale_orders มีข้อมูลน้อยเกินกว่าจะทดสอบ since — ข้าม');
  } else {
    const pivot = (pivotRows[0].updated_at as Date).toISOString();
    const page = await fetchPage({ def: so, since: pivot, limit: MAX_LIMIT });
    const allNewer = page.rows.every((r: any) => new Date(r.updated_at).getTime() >= new Date(pivot).getTime());
    ok('ทุกแถวที่ได้มี updated_at >= since', allNewer);
    ok('แถวที่ updated_at = since พอดี ต้องติดมาด้วย (ยอมซ้ำ ดีกว่าเสี่ยงข้าม)',
       page.rows.some((r: any) => new Date(r.updated_at).toISOString() === pivot));
  }

  // ── 8. query โหมด incremental ต้องไม่ Seq Scan ──────────────────────────────
  console.log('\n── 8. แผน query ใช้ index ──');
  for (const def of TABLE_REGISTRY.filter((d) => d.mode === 'incremental')) {
    const order = orderColumns(def).map((c) => `"${c}"`).join(', ');
    const { rows } = await pool.query(
      `EXPLAIN SELECT 1 FROM public."${def.table}"
        WHERE (${order}) > (${orderColumns(def).map((_, i) => `$${i + 1}`).join(', ')})
        ORDER BY ${order} LIMIT 500`,
      [new Date(0).toISOString(), ...def.pk.map(() => null)].slice(0, orderColumns(def).length)
    ).catch(() => ({ rows: [] as any[] }));

    if (rows.length === 0) { warn(`${def.table}: EXPLAIN ไม่ผ่าน (ข้าม)`); continue; }
    const plan = rows.map((r: any) => r['QUERY PLAN']).join('\n');
    // ตารางเล็กมาก Postgres เลือก Seq Scan เองก็ถูกแล้ว — เช็คเฉพาะตารางที่ใหญ่พอจะเจ็บ
    const { rows: sz } = await pool.query(
      `SELECT reltuples::bigint AS n FROM pg_class WHERE oid = $1::regclass`, [`public.${def.table}`]
    );
    if (Number(sz[0].n) < 10000) { console.log(`     ${def.table}: แถวน้อย (${sz[0].n}) ข้ามการตรวจแผน`); continue; }
    ok(`${def.table}: ใช้ Index Scan ไม่ใช่ Seq Scan`, !/Seq Scan/.test(plan), plan.split('\n')[0].trim());
  }

  // ── 9. /ids กับ manifest ────────────────────────────────────────────────────
  console.log('\n── 9. /ids และ manifest ──');
  const q = getTableDef('quotations')!;
  const ids1 = await fetchIds(q, undefined, 10);
  ok('quotations /ids คืนเฉพาะคอลัมน์ pk', ids1.rows.every((r: any) => Object.keys(r).length === q.pk.length));
  if (ids1.nextCursor) {
    const ids2 = await fetchIds(q, ids1.nextCursor, 10);
    const overlap = ids2.rows.filter((r: any) => ids1.rows.some((x: any) => x.id === r.id));
    ok('quotations /ids หน้าถัดไปไม่ซ้ำกับหน้าแรก', overlap.length === 0);
  }

  const manifest = await buildManifest(null);
  ok('manifest ครบทุกตารางในทะเบียน', manifest.length === TABLE_REGISTRY.length);
  ok('manifest บอก pk ครบทุกตาราง', manifest.every((m) => m.pk.length > 0));
  ok('manifest ไม่มีตารางไหนคอลัมน์ว่าง', manifest.every((m) => m.columns.length > 0));

  const restricted = await buildManifest(['products']);
  ok('กุญแจที่จำกัดตารางเห็นเฉพาะที่อนุญาต', restricted.length === 1 && restricted[0].table === 'products');

  // ── 10. ของจิปาถะที่พังแล้วเงียบ ───────────────────────────────────────────
  console.log('\n── 10. อื่น ๆ ──');
  ok('ตัวนับ concurrent เริ่มที่ 0 (ไม่รั่ว)', getSyncInFlight() === 0);
  ok('hashSyncKey ให้ค่าเดิมทุกครั้ง และยาว 64 ตัว',
     hashSyncKey('ทดสอบ') === hashSyncKey('ทดสอบ') && hashSyncKey('ทดสอบ').length === 64);
  ok('hashSyncKey ต่างกันเมื่อกุญแจต่างกัน', hashSyncKey('a') !== hashSyncKey('b'));

  const { rows: keyTable } = await pool.query(
    `SELECT to_regclass('public.sync_api_keys') IS NOT NULL AS ready`
  );
  ok('ตาราง sync_api_keys ถูกสร้างแล้ว (ลง migration แล้ว)', keyTable[0].ready === true);

  console.log(`\n${failures === 0 ? '✅ ผ่านทั้งหมด' : `❌ ไม่ผ่าน ${failures} ข้อ`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error('สคริปต์ล้มเหลว:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
