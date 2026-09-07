#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
//  ตัวดึงข้อมูลจาก salechatbot (PostgreSQL) มาลง MongoDB ของ NUC-Kay
//
//  ไฟล์นี้รันบน "เครื่องปลายทาง" ไม่ใช่บนเซิร์ฟเวอร์แชทบอท — คุยกันผ่าน HTTPS สาธารณะอย่างเดียว
//  ไม่ต้องต่อ LAN ไม่ต้องเปิดพอร์ตฝั่ง NUC เลย (NUC เป็นฝ่ายเรียกออกทุกครั้ง)
//
//  ตั้งใจให้เป็น "รันจบแล้วออก" ไม่ใช่ daemon — ให้ cron/systemd timer เรียกทุก 10-15 นาที
//  เพราะ process ที่ตายแล้วไม่มีใครรู้ คือโหมดพังที่เจอบ่อยที่สุดของตัว sync แบบอยู่ยาว
//
//  ต้องการ: Node 18+ (ใช้ fetch ในตัว) และแพ็กเกจ mongodb อย่างเดียว
//  รัน:  node pull.mjs                 ดึงทุกตารางที่ถึงรอบ
//        node pull.mjs --table products ดึงเฉพาะตารางเดียว (ข้ามการเช็ครอบ)
//        node pull.mjs --full           ล้าง cursor แล้วดึงใหม่ทั้งหมดตั้งแต่ต้น
//        node pull.mjs --reconcile      บังคับไล่ลบแถวที่หายไปจากต้นทางรอบนี้ด้วย
// ─────────────────────────────────────────────────────────────────────────────
import { MongoClient } from 'mongodb';

const CFG = {
  apiUrl: (process.env.SYNC_API_URL || '').replace(/\/+$/, ''),
  apiKey: process.env.SYNC_API_KEY || '',
  mongoUrl: process.env.MONGO_URL || 'mongodb://127.0.0.1:27017',
  mongoDb: process.env.MONGO_DB || 'salechatbot',
  pageLimit: Number(process.env.PAGE_LIMIT || 1000),
  // เผื่อเวลาถอยหลังตอนขึ้นรอบใหม่ — กันเคส transaction ที่จับเวลา NOW() ไว้ก่อน แต่ commit ทีหลัง
  // ซึ่งจะโผล่ใน DB "ย้อนหลัง" จุดที่เราหยุดไว้ · ยอมดึงซ้ำ 60 วิทุกรอบ ถูกกว่าข้อมูลหายถาวรมาก
  lagSeconds: Number(process.env.LAG_SECONDS || 60),
  // ตารางที่ต้องไล่เทียบรายการ id เพื่อ "ลบตาม" ต้นทาง (ต้นทางลบแถวได้จริงเฉพาะ quotations)
  reconcileTables: (process.env.RECONCILE_TABLES || 'quotations').split(',').map((s) => s.trim()).filter(Boolean),
  reconcileEveryMinutes: Number(process.env.RECONCILE_EVERY_MINUTES || 60),
  onlyTables: (process.env.TABLES || '').split(',').map((s) => s.trim()).filter(Boolean),
};

const ARG = {
  table: argValue('--table'),
  full: process.argv.includes('--full'),
  reconcile: process.argv.includes('--reconcile'),
};

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const STATE_COLLECTION = '_sync_state';
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ── ชั้นเรียก API: retry เฉพาะที่ควร retry ────────────────────────────────────────────
// 429/5xx = ลองใหม่ได้ · 401/404 = ลองใหม่กี่ครั้งก็เหมือนเดิม ต้องหยุดแล้วให้คนดู
async function apiGet(path, params = {}) {
  const url = new URL(CFG.apiUrl + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));

  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${CFG.apiKey}` },
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      lastErr = err;
      await sleep(Math.min(30_000, 2000 * 2 ** (attempt - 1)));
      continue;
    }

    if (res.ok) return res.json();

    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('retry-after')) || 0;
      lastErr = new Error(`HTTP ${res.status}`);
      await sleep(retryAfter > 0 ? retryAfter * 1000 : Math.min(30_000, 2000 * 2 ** (attempt - 1)));
      continue;
    }

    throw new Error(`${url.pathname} ตอบ HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  throw lastErr ?? new Error('เรียก API ไม่สำเร็จ');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * _id ของ Mongo มาจาก pk ของฝั่ง Postgres เสมอ — ไม่ให้ Mongo สุ่ม ObjectId เอง
 * เพราะการดึงรอบถัดไปต้องทับแถวเดิมให้ได้ ไม่ใช่สร้างซ้ำ · pk หลายคอลัมน์ต่อด้วย | (คั่นด้วยอักขระ
 * ที่ไม่โผล่ในรหัสลูกค้า/รหัสสินค้าของระบบนี้)
 */
function docId(row, pk) {
  if (pk.length === 1) return row[pk[0]];
  return pk.map((c) => String(row[c])).join('|');
}

async function loadState(db, table) {
  return (await db.collection(STATE_COLLECTION).findOne({ _id: table })) ?? {};
}

async function saveState(db, table, patch) {
  await db.collection(STATE_COLLECTION).updateOne({ _id: table }, { $set: patch }, { upsert: true });
}

async function upsertRows(db, table, pk, rows, extraSet = {}) {
  if (rows.length === 0) return;
  await db.collection(table).bulkWrite(
    rows.map((row) => ({
      updateOne: {
        filter: { _id: docId(row, pk) },
        update: { $set: { ...row, ...extraSet, _syncedAt: new Date() } },
        upsert: true,
      },
    })),
    { ordered: false }
  );
}

// ── โหมด incremental: ดึงเฉพาะที่เปลี่ยนหลัง since ─────────────────────────────────────
//
// ที่ใช้ since (เวลาของฝั่งต้นทาง) เป็นหลักแทนการเก็บ next_cursor ข้ามรอบ:
// next_cursor ชี้ตำแหน่งได้แม่นก็จริง แต่มันเป็นของ "ภายใน" ของฝั่งต้นทาง เราไม่ควรเก็บถาวร
// ส่วน server_time ของหน้าแรกคือจุดที่ปลอดภัย: แถวที่ถูกเขียนหลังจากนั้นมี updated_at ใหม่กว่าเสมอ
// จึงถูกดึงในรอบหน้าแน่นอน · ภายในรอบเดียวกันยังเดินด้วย next_cursor ตามปกติ
async function pullIncremental(db, def, state) {
  const since = ARG.full ? undefined : state.since;
  let cursor;
  let firstServerTime = null;
  let total = 0;

  for (;;) {
    const page = await apiGet(`/api/sync/v1/tables/${def.table}`, {
      since: cursor ? undefined : since,
      cursor,
      limit: CFG.pageLimit,
    });
    if (firstServerTime === null) firstServerTime = page.server_time;

    await upsertRows(db, def.table, def.pk, page.rows);
    total += page.rows.length;

    if (!page.has_more || !page.next_cursor) break;
    cursor = page.next_cursor;
  }

  const nextSince = new Date(new Date(firstServerTime).getTime() - CFG.lagSeconds * 1000).toISOString();
  await saveState(db, def.table, { mode: def.mode, since: nextSince, last_ok_at: new Date(), last_rows: total });
  return total;
}

// ── โหมด append: เดินด้วย id ต่อจากรอบก่อนได้ตรง ๆ ไม่มีปัญหาเรื่องเวลา ────────────────
async function pullAppend(db, def, state) {
  let cursor = ARG.full ? undefined : state.cursor;
  let total = 0;
  let lastCursor = cursor;

  for (;;) {
    const page = await apiGet(`/api/sync/v1/tables/${def.table}`, { cursor, limit: CFG.pageLimit });
    await upsertRows(db, def.table, def.pk, page.rows);
    total += page.rows.length;
    if (page.next_cursor) lastCursor = page.next_cursor;
    if (!page.has_more || !page.next_cursor) break;
    cursor = page.next_cursor;
  }

  await saveState(db, def.table, { mode: def.mode, cursor: lastCursor, last_ok_at: new Date(), last_rows: total });
  return total;
}

// ── โหมด snapshot: ยกตาราง แล้วลบสิ่งที่ไม่ได้มากับรอบนี้ ─────────────────────────────
//
// ตีตรา _syncRun ลงทุกแถวที่ดึงมารอบนี้ แล้วลบแถวที่ตราไม่ตรง — วิธีนี้ไม่ต้องกองรายการ id
// ทั้งตารางไว้ในหน่วยความจำ (customers_data_view มี 82,000 แถว) และไม่ต้องลบทั้งตารางก่อนเขียนใหม่
// ซึ่งจะทำให้ฝั่ง NUC มีช่วงที่ข้อมูลหายจริง ๆ ถ้าดึงพัง
async function pullSnapshot(db, def) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let cursor;
    let generation = null;
    let total = 0;
    let restart = false;

    for (;;) {
      const page = await apiGet(`/api/sync/v1/tables/${def.table}`, { cursor, limit: CFG.pageLimit });

      // ตารางสรุปฝั่งต้นทางถูกสร้างใหม่ทั้งใบเป็นรอบ ๆ — ถ้าสลับใบระหว่างที่เราไล่หน้าอยู่
      // สิ่งที่ได้จะเป็นครึ่งใบเก่าครึ่งใบใหม่ ต้องทิ้งแล้วเริ่มใหม่ ไม่ใช่เขียนลงไปทั้งอย่างนั้น
      if (generation === null) generation = page.generation ?? null;
      else if ((page.generation ?? null) !== generation) { restart = true; break; }

      await upsertRows(db, def.table, def.pk, page.rows, { _syncRun: runId });
      total += page.rows.length;

      if (!page.has_more || !page.next_cursor) break;
      cursor = page.next_cursor;
    }

    if (restart) {
      log(`  ${def.table}: ต้นทาง refresh กลางคัน (generation เปลี่ยน) — เริ่มใหม่ รอบที่ ${attempt + 1}`);
      continue;
    }

    const del = await db.collection(def.table).deleteMany({ _syncRun: { $ne: runId } });
    await saveState(db, def.table, {
      mode: def.mode, generation, last_ok_at: new Date(), last_rows: total, last_deleted: del.deletedCount,
    });
    return total;
  }
  throw new Error(`${def.table}: ต้นทาง refresh ชนกันทุกครั้ง ลอง 3 รอบแล้วไม่จบ — ค่อยเอาใหม่รอบหน้า`);
}

// ── ไล่ลบแถวที่ต้นทางลบไปแล้ว (เฉพาะตารางโหมด incremental ที่มีการลบจริง) ────────────────
async function reconcileIds(db, def) {
  const alive = new Set();
  let cursor;
  for (;;) {
    const page = await apiGet(`/api/sync/v1/tables/${def.table}/ids`, { cursor, limit: 2000 });
    for (const row of page.rows) alive.add(String(docId(row, def.pk)));
    if (!page.has_more || !page.next_cursor) break;
    cursor = page.next_cursor;
  }

  // ไล่เทียบฝั่งเราทีละก้อน แทนการยิง $nin ก้อนใหญ่ (query ที่มีรายการเป็นหมื่นตัวทำ Mongo ช้ามาก)
  const toDelete = [];
  const local = db.collection(def.table).find({}, { projection: { _id: 1 } });
  for await (const doc of local) if (!alive.has(String(doc._id))) toDelete.push(doc._id);

  if (toDelete.length > 0) await db.collection(def.table).deleteMany({ _id: { $in: toDelete } });
  await saveState(db, def.table, { last_reconcile_at: new Date(), last_reconcile_deleted: toDelete.length });
  return toDelete.length;
}

function isDue(state, pollHintSeconds) {
  if (ARG.table || ARG.full) return true;
  if (!state.last_ok_at) return true;
  return Date.now() - new Date(state.last_ok_at).getTime() >= pollHintSeconds * 1000;
}

async function main() {
  if (!CFG.apiUrl || !CFG.apiKey) {
    throw new Error('ต้องตั้ง SYNC_API_URL และ SYNC_API_KEY ก่อน (ดู .env.example)');
  }

  const manifest = await apiGet('/api/sync/v1/tables');
  log(`ต่อกับ ${CFG.apiUrl} ในนามกุญแจ "${manifest.key_name}" — ${manifest.tables.length} ตาราง`);

  const mongo = new MongoClient(CFG.mongoUrl);
  await mongo.connect();
  const db = mongo.db(CFG.mongoDb);

  let failed = 0;
  try {
    for (const def of manifest.tables) {
      if (ARG.table && def.table !== ARG.table) continue;
      if (!ARG.table && CFG.onlyTables.length > 0 && !CFG.onlyTables.includes(def.table)) continue;

      const state = await loadState(db, def.table);
      if (!isDue(state, def.poll_hint_seconds)) continue;

      const t0 = Date.now();
      try {
        let n;
        if (def.mode === 'incremental') n = await pullIncremental(db, def, state);
        else if (def.mode === 'append') n = await pullAppend(db, def, state);
        else n = await pullSnapshot(db, def);
        log(`  ${def.table.padEnd(26)} ${String(n).padStart(7)} แถว  ${Date.now() - t0} ms`);

        const wantsReconcile =
          def.supports_ids &&
          CFG.reconcileTables.includes(def.table) &&
          (ARG.reconcile ||
            !state.last_reconcile_at ||
            Date.now() - new Date(state.last_reconcile_at).getTime() >= CFG.reconcileEveryMinutes * 60_000);
        if (wantsReconcile) {
          const removed = await reconcileIds(db, def);
          log(`  ${def.table.padEnd(26)} ไล่ลบตามต้นทาง: ${removed} แถว`);
        }
      } catch (err) {
        failed++;
        // ตารางเดียวพังต้องไม่ทำให้ตารางที่เหลือไม่ได้ sync — cursor ของตารางที่พังไม่ถูกบันทึก
        // จึงเริ่มจากจุดเดิมในรอบหน้าเองโดยอัตโนมัติ
        console.error(`  ✗ ${def.table}: ${err.message}`);
        await saveState(db, def.table, { last_error: err.message, last_error_at: new Date() });
      }
    }
  } finally {
    await mongo.close();
  }

  if (failed > 0) {
    log(`จบรอบ — มี ${failed} ตารางที่พัง (จะลองใหม่รอบหน้า)`);
    process.exitCode = 1;
  } else {
    log('จบรอบ — ครบทุกตาราง');
  }
}

main().catch((err) => {
  console.error('ล้มเหลว:', err.message);
  process.exitCode = 1;
});
