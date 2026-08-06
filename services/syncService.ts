import { pool } from '../config/db.js';
import { GatewayUnreachableError } from '../scripts/sync/gatewayClient.js';
import { refreshCustomerDataView } from '../scripts/sync/refreshCustomerDirectory.js';
import { clearCustomerSearchCache } from './customerService.js';
import { thaiDateParts } from '../utils/thaiTime.js';

// ============================================================
// Registry ของ resource ที่ sync ได้
//  - id       : ค่าที่ frontend/endpoint ใช้
//  - stateKey : คีย์ในตาราง sync_state (สคริปต์เดิมเขียนไว้)
//  - label    : ชื่อไทยไว้โชว์
//  - load     : dynamic import ฟังก์ชัน sync (lazy — env ของ gateway จะถูกตรวจ
//               ตอนเรียกจริงเท่านั้น ไม่ throw ตอน boot เซิร์ฟเวอร์)
// ============================================================
type ResourceId = 'products' | 'customers' | 'saleorders';

/** ฟังก์ชัน sync ของแต่ละ resource — forceFull = reset cursor แล้วกวาดใหม่ทั้งหมดจาก since=1970 */
type SyncFn = (opts?: { forceFull?: boolean }) => Promise<unknown>;

interface ResourceDef {
  id: ResourceId;
  stateKey: string;
  label: string;
  load: () => Promise<SyncFn>;
}

const RESOURCES: Record<ResourceId, ResourceDef> = {
  products: {
    id: 'products',
    stateKey: 'product_template',
    label: 'สินค้า',
    load: async () => (await import('../scripts/sync/syncProducts.js')).syncProducts,
  },
  customers: {
    id: 'customers',
    stateKey: 'res_partner',
    label: 'ลูกค้า',
    load: async () => (await import('../scripts/sync/syncCustomers.js')).syncCustomers,
  },
  saleorders: {
    id: 'saleorders',
    stateKey: 'sale_order',
    label: 'ใบสั่งขาย',
    load: async () => (await import('../scripts/sync/syncSaleorders.js')).syncSaleOrders,
  },
};

export const RESOURCE_IDS = Object.keys(RESOURCES) as ResourceId[];

export function isValidResource(id: unknown): id is ResourceId {
  return typeof id === 'string' && id in RESOURCES;
}

// ============================================================
// สถานะการรันในหน่วยความจำ + mutex (กัน sync ซ้อนกัน)
// ============================================================
interface RunState {
  running: boolean;
  currentResource: ResourceId | null;
  queue: ResourceId[];
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  /** true = รอบล่าสุดถูกยกเลิกกลางคันเพราะติดต่อ gateway ไม่ได้ */
  aborted: boolean;
  trigger: 'manual' | 'schedule' | null;
  /** true = รอบนี้เป็น full sync (reset cursor กวาดใหม่ทั้งหมด) */
  forceFull: boolean;
}

const runState: RunState = {
  running: false,
  currentResource: null,
  queue: [],
  startedAt: null,
  finishedAt: null,
  lastError: null,
  aborted: false,
  trigger: null,
  forceFull: false,
};

export function isRunning() {
  return runState.running;
}

// ============================================================
// บันทึกผลรอบ sync ลง sync_state (แถวเดียวกับที่เก็บ cursor)
//
// กติกาสำคัญ: รอบที่ "สำเร็จ" ห้ามแตะ last_error / last_error_at
// เพราะ auto sync เป็นแบบ interval ถ้าล้าง error ทุกครั้งที่สำเร็จ error ตอนตี 2
// จะถูกทับตอน 2:15 แล้วเช้ามาไม่มีใครรู้ว่าเมื่อคืนระบบล่มไป
// ============================================================
type RunStatus = 'success' | 'failed' | 'aborted' | 'skipped';

/** ตัดข้อความ error ยาว ๆ (เช่น HTML error page) ไม่ให้ยัดลง DB ทั้งก้อน */
function trimErrorMessage(message: string) {
  const clean = String(message).replace(/\s+/g, ' ').trim();
  return clean.length > 1000 ? `${clean.slice(0, 997)}...` : clean;
}

/**
 * upsert เพราะ resource ที่ยังไม่เคย sync สำเร็จจะยังไม่มีแถวใน sync_state
 * (เกิดจริงกับสถานะ skipped — ถูกข้ามตั้งแต่รอบแรกที่ gateway ล่ม)
 * ตัวนี้ห้ามโยน error ออกไป ไม่งั้นการบันทึกผลจะไปล้ม loop ของ sync เอง
 */
async function recordResult(id: ResourceId, status: RunStatus, errorMessage?: string) {
  const stateKey = RESOURCES[id].stateKey;
  try {
    if (status === 'success') {
      await pool.query(
        `INSERT INTO sync_state (resource, last_status, last_run_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (resource) DO UPDATE
           SET last_status = EXCLUDED.last_status,
               last_run_at = EXCLUDED.last_run_at`,
        [stateKey, status]
      );
      return;
    }

    await pool.query(
      `INSERT INTO sync_state (resource, last_status, last_run_at, last_error, last_error_at)
       VALUES ($1, $2, NOW(), $3, NOW())
       ON CONFLICT (resource) DO UPDATE
         SET last_status = EXCLUDED.last_status,
             last_run_at = EXCLUDED.last_run_at,
             last_error = EXCLUDED.last_error,
             last_error_at = EXCLUDED.last_error_at`,
      [stateKey, status, trimErrorMessage(errorMessage || 'ไม่ทราบสาเหตุ')]
    );
  } catch (err: any) {
    console.error(`[sync] บันทึกผล (${id}=${status}) ล้มเหลว:`, err?.message || err);
  }
}

/**
 * นับ contact ที่มีใน sale_orders แต่ไม่มีใน customers (ลูกค้า/ผู้ติดต่อ "หาย") แล้ว log
 * เป็น guard เตือนหลังจบรอบ sync ว่า customer sync ยังกวาดไม่ครบ
 *
 * ⚠️ ใช้ contact_id เป็นคีย์เท่านั้น — sale_orders.company_id เก็บบริษัทผู้ขาย (res.company)
 *    ไม่ใช่ลูกค้า จึงเชื่อมกับ customers ไม่ได้ (ดู memory: sale-orders-company-id-trap)
 * EXCEPT ใช้ hash/sort เร็ว (dedupe ในตัว) — เบากว่า NOT EXISTS ต่อแถว
 * ห้าม throw — เป็นแค่ตัวรายงาน ไม่ควรไปล้มรอบ sync
 */
async function reconcileOrphanContacts() {
  try {
    const { rows } = await pool.query(`
      SELECT COUNT(*)::int AS n FROM (
        SELECT contact_id FROM sale_orders WHERE contact_id > 0
        EXCEPT
        SELECT contact_id FROM customers WHERE contact_id > 0
      ) t`);
    const n = rows[0]?.n ?? 0;
    if (n > 0) {
      console.warn(`[sync] ⚠️ contact มีใน sale_orders แต่ไม่มีใน customers: ${n} — customer sync อาจกวาดไม่ครบ (ดู npm run diag:orphan-contacts แล้ว sync:customers -- --full / backfill:contacts)`);
    } else {
      console.log('[sync] ✓ ไม่มี contact ตกค้าง (sale_orders ⊆ customers by contact_id)');
    }
  } catch (err: any) {
    console.error('[sync] reconcile orphan contacts ล้มเหลว:', err?.message || err);
  }
}

/**
 * สร้าง customers_data_view ใหม่หลัง sync (customers/sale_orders เปลี่ยนผ่าน sync เท่านั้น
 * → rebuild ท้าย sync = ข้อมูลสดเสมอในทางปฏิบัติ) แล้วล้าง in-memory search cache
 *
 * logic จริงอยู่ใน refreshCustomerDataView() (แชร์กับ CLI sync scripts); ที่นี่ห่อเพิ่ม
 * clearCustomerSearchCache() ซึ่งเป็นเรื่องเฉพาะโปรเซสแอปที่รันอยู่
 *
 * ถ้ารอบนั้นถูกข้าม (ข้อมูลต้นทางไม่ขยับ) ก็ไม่ต้องล้าง cache — ข้อมูลใน cache ยังตรงอยู่
 * และการล้างทิ้งเปล่า ๆ ทำให้ค้นหาครั้งถัดไปต้องโหลด 52k แถวใหม่ฟรี ๆ
 */
async function refreshCustomerDirectory() {
  const result = await refreshCustomerDataView();
  if (!result.skipped) clearCustomerSearchCache();
}

/** เพิ่ม 4 คอลัมน์ผลรอบล่าสุด — เรียกตอน boot เพื่อให้ deploy แล้วใช้ได้เลยไม่ต้องรันมือ */
async function ensureSyncStateColumns() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sync_state (
      resource TEXT PRIMARY KEY,
      sync_cursor TEXT,
      sync_cursor_timestamp TEXT,
      sync_mode TEXT NOT NULL DEFAULT 'full',
      pages_synced INTEGER NOT NULL DEFAULT 0,
      records_synced INTEGER NOT NULL DEFAULT 0,
      last_success_at TIMESTAMPTZ
    )
  `);
  await pool.query(`ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS last_status TEXT`);
  await pool.query(`ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS last_error TEXT`);
  await pool.query(`ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ`);
}

/**
 * เริ่ม sync แบบ background (fire-and-forget) — คืนค่าทันที ไม่รอให้จบ
 * เพราะ sync สินค้าใช้เวลาหลายนาที (HTTP request ไม่ควรค้างรอ)
 * คืน false ถ้ามี sync กำลังรันอยู่แล้ว
 *
 * opts.forceFull = reset cursor ก่อนกวาด (เท่ากับ npm run sync:xxx -- --full)
 * ใช้เวลานานกว่ารอบ incremental มาก จึงให้สั่งได้เฉพาะแบบ manual เท่านั้น
 */
export function startSync(
  resources: ResourceId[],
  trigger: 'manual' | 'schedule',
  opts?: { forceFull?: boolean }
): boolean {
  if (runState.running) return false;

  const list = resources.filter(isValidResource);
  if (list.length === 0) return false;

  // full sync กินเวลานาน — อนุญาตเฉพาะ manual ทีละ resource
  // (ห้าม scheduler สั่งเอง ไม่งั้นรอบอัตโนมัติทุก 15 นาทีจะกวาดใหม่ทั้งฐาน)
  const forceFull = trigger === 'manual' && !!opts?.forceFull && list.length === 1;

  runState.running = true;
  runState.queue = [...list];
  runState.currentResource = null;
  runState.startedAt = new Date().toISOString();
  runState.finishedAt = null;
  runState.lastError = null;
  runState.aborted = false;
  runState.trigger = trigger;
  runState.forceFull = forceFull;

  // ไม่ await — ปล่อยรันเบื้องหลัง
  void (async () => {
    // try/finally: running ต้องถูกปลดทุกเส้นทาง ไม่งั้น mutex ค้างและ sync ทั้งระบบตายจน restart
    try {
      for (let i = 0; i < list.length; i++) {
        const id = list[i];
        runState.currentResource = id;
        const def = RESOURCES[id];
        try {
          console.log(
            `[sync] เริ่ม sync ${def.label} (${id}) — trigger=${trigger}${forceFull ? ' mode=full' : ''}`
          );
          const fn = await def.load();
          await fn({ forceFull });
          console.log(`[sync] sync ${def.label} เสร็จแล้ว`);
          await recordResult(id, 'success');
        } catch (err: any) {
          const msg = err?.message || String(err);
          runState.lastError = `${def.label}: ${msg}`;
          console.error(`[sync] sync ${def.label} ล้มเหลว:`, msg);

          // ติดต่อ gateway ไม่ได้ → ยิง resource ที่เหลือก็พังเหมือนกัน ยกเลิกทั้งรอบเลย
          // (error อื่น เช่น payload ผิดรูป/DB พัง/env หาย ยังไปต่อตัวถัดไปตามเดิม)
          if (err instanceof GatewayUnreachableError) {
            runState.aborted = true;
            await recordResult(id, 'aborted', msg);
            for (const rest of list.slice(i + 1)) {
              await recordResult(rest, 'skipped', `ยกเลิกทั้งรอบ: ${msg}`);
            }
            console.error(`[sync] ยกเลิกทั้งรอบ — ข้าม ${list.length - i - 1} รายการที่เหลือ (รอรอบถัดไป)`);
            break;
          }

          await recordResult(id, 'failed', msg);
        }
      }
    } finally {
      runState.running = false;
      runState.currentResource = null;
      runState.queue = [];
      runState.finishedAt = new Date().toISOString();
      console.log(runState.aborted ? '[sync] จบรอบ sync (ถูกยกเลิก)' : '[sync] จบรอบ sync ทั้งหมด');
      // guard: เตือนถ้ายังมี contact ตกค้าง (อ่าน DB อย่างเดียว ไม่ throw)
      await reconcileOrphanContacts();
      // สร้าง customers_data_view ใหม่ให้สะท้อนข้อมูลที่ sync มาใหม่ + ล้าง search cache
      await refreshCustomerDirectory();
    }
  })();

  return true;
}

// ============================================================
// ตาราง config ตารางเวลา (sync_settings) — แถวเดียว id=1
// ============================================================
/** ขอบเขตของ interval — ต่ำกว่า 30 วิ ไม่มีประโยชน์เพราะรอบ sync จริงกินเวลาเป็นนาที */
export const MIN_INTERVAL_SECONDS = 30;
export const MAX_INTERVAL_SECONDS = 86400; // 24 ชม.
const DEFAULT_INTERVAL_SECONDS = 900; // 15 นาที

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface SyncSettings {
  auto_enabled: boolean;
  /** วันที่ให้ทำงาน 0=อาทิตย์ … 6=เสาร์ (ตรงกับ Date.getDay()) — ว่าง = ทุกวัน */
  days: number[];
  window_start: string; // 'HH:MM' เวลาไทย
  window_end: string; // 'HH:MM' เวลาไทย (>= window_start)
  interval_seconds: number;
  resources: ResourceId[];
  updated_at: string | null;
}

const DEFAULT_SETTINGS: SyncSettings = {
  auto_enabled: false,
  days: [0, 1, 2, 3, 4, 5, 6],
  window_start: '00:00',
  window_end: '23:59',
  interval_seconds: DEFAULT_INTERVAL_SECONDS,
  resources: [...RESOURCE_IDS],
  updated_at: null,
};

// ensure ทำงานครั้งเดียวพอ — scheduler เรียก getSettings() ทุก 5 วินาที ถ้าปล่อยให้ยิง
// DDL ทุกครั้งจะกลายเป็นหลายพันคำสั่งต่อชั่วโมงโดยไม่ได้อะไรเลย
let settingsTableReady = false;

async function ensureSyncSettings() {
  if (settingsTableReady) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sync_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      auto_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      days INTEGER[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
      window_start TEXT NOT NULL DEFAULT '00:00',
      window_end TEXT NOT NULL DEFAULT '23:59',
      interval_seconds INTEGER NOT NULL DEFAULT 900,
      resources TEXT[] NOT NULL DEFAULT ARRAY['products','customers','saleorders'],
      updated_at TIMESTAMPTZ,
      CONSTRAINT sync_settings_singleton CHECK (id = 1)
    )
  `);
  // ตารางที่สร้างไว้ก่อนหน้าจะยังไม่มีคอลัมน์ชุดใหม่ — เติมให้ครบ
  await pool.query(`ALTER TABLE sync_settings ADD COLUMN IF NOT EXISTS days INTEGER[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}'`);
  await pool.query(`ALTER TABLE sync_settings ADD COLUMN IF NOT EXISTS window_start TEXT NOT NULL DEFAULT '00:00'`);
  await pool.query(`ALTER TABLE sync_settings ADD COLUMN IF NOT EXISTS window_end TEXT NOT NULL DEFAULT '23:59'`);
  await pool.query(`ALTER TABLE sync_settings ADD COLUMN IF NOT EXISTS interval_seconds INTEGER NOT NULL DEFAULT 900`);

  // แปลงค่าจากโหมดเดิม (daily/interval) แล้วทิ้งคอลัมน์เก่า — ทำในโค้ดเหมือนที่เคยทำกับ
  // interval_hours เพื่อไม่ให้ตารางเวลาที่ผู้ใช้ตั้งไว้เพี้ยนไปเป็น default ถ้ายังไม่ได้รัน
  // migration ไฟล์ 2026-07-22_02_* (ซึ่งมีคำสั่งชุดเดียวกัน ไว้สำหรับตั้ง DB ใหม่/รันมือ)
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'sync_settings' AND column_name = 'mode'
      ) THEN
        UPDATE sync_settings
           SET window_start = COALESCE(NULLIF(daily_time, ''), '02:00'),
               window_end   = COALESCE(NULLIF(daily_time, ''), '02:00'),
               interval_seconds = 3600,
               days = '{0,1,2,3,4,5,6}'
         WHERE mode = 'daily';
        UPDATE sync_settings
           SET window_start = '00:00',
               window_end   = '23:59',
               interval_seconds = GREATEST(30, COALESCE(interval_minutes, 15) * 60),
               days = '{0,1,2,3,4,5,6}'
         WHERE mode = 'interval';
      END IF;
    END $$;
  `);
  await pool.query(`ALTER TABLE sync_settings DROP COLUMN IF EXISTS mode`);
  await pool.query(`ALTER TABLE sync_settings DROP COLUMN IF EXISTS daily_time`);
  await pool.query(`ALTER TABLE sync_settings DROP COLUMN IF EXISTS interval_minutes`);

  await pool.query(`
    INSERT INTO sync_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING
  `);

  settingsTableReady = true;
}

/** กรองให้เหลือเลขวัน 0–6 ไม่ซ้ำ เรียงจากอาทิตย์ */
function normalizeDays(input: any): number[] {
  if (!Array.isArray(input)) return [...DEFAULT_SETTINGS.days];
  const days = Array.from(
    new Set(input.map((d: any) => Math.trunc(Number(d))).filter((d: number) => d >= 0 && d <= 6))
  ).sort((a, b) => a - b);
  return days.length ? days : [...DEFAULT_SETTINGS.days];
}

export async function getSettings(): Promise<SyncSettings> {
  await ensureSyncSettings();
  const { rows } = await pool.query(`SELECT * FROM sync_settings WHERE id = 1`);
  if (rows.length === 0) return { ...DEFAULT_SETTINGS };
  const r = rows[0];
  const resources = (Array.isArray(r.resources) ? r.resources : []).filter(isValidResource);
  return {
    auto_enabled: !!r.auto_enabled,
    days: normalizeDays(r.days),
    window_start: TIME_RE.test(r.window_start) ? r.window_start : DEFAULT_SETTINGS.window_start,
    window_end: TIME_RE.test(r.window_end) ? r.window_end : DEFAULT_SETTINGS.window_end,
    interval_seconds: Number(r.interval_seconds) || DEFAULT_SETTINGS.interval_seconds,
    resources: resources.length ? resources : [...RESOURCE_IDS],
    updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
}

/** validate + บันทึก config; คืนค่าที่บันทึกจริง */
export async function saveSettings(input: any): Promise<SyncSettings> {
  await ensureSyncSettings();

  const days = normalizeDays(input?.days);

  let start = String(input?.window_start ?? DEFAULT_SETTINGS.window_start).trim();
  if (!TIME_RE.test(start)) start = DEFAULT_SETTINGS.window_start;

  let end = String(input?.window_end ?? DEFAULT_SETTINGS.window_end).trim();
  if (!TIME_RE.test(end)) end = DEFAULT_SETTINGS.window_end;

  // ไม่รองรับช่วงข้ามเที่ยงคืน (22:00–02:00) เพราะเงื่อนไข "วัน" จะกำกวมว่านับวันเริ่มหรือวันจบ
  // → ยุบให้เป็นช่วงจุดเดียวแทนการเดาใจ
  if (end < start) end = start;

  let intervalSeconds = Math.trunc(Number(input?.interval_seconds));
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    intervalSeconds = DEFAULT_INTERVAL_SECONDS;
  }
  intervalSeconds = Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, intervalSeconds));

  const resources: ResourceId[] = Array.isArray(input?.resources)
    ? input.resources.filter(isValidResource)
    : [...RESOURCE_IDS];
  const finalResources = resources.length ? Array.from(new Set(resources)) : [...RESOURCE_IDS];

  const autoEnabled = !!input?.auto_enabled;

  await pool.query(
    `UPDATE sync_settings
       SET auto_enabled = $1, days = $2, window_start = $3, window_end = $4,
           interval_seconds = $5, resources = $6, updated_at = NOW()
     WHERE id = 1`,
    [autoEnabled, days, start, end, intervalSeconds, finalResources]
  );

  // reset ตัวจับเวลา interval เพื่อให้เริ่มนับใหม่จากตอนบันทึก
  lastIntervalRun = Date.now();

  return getSettings();
}

// ============================================================
// สถานะรวม (สำหรับ GET /api/admin/sync/status)
// ============================================================
export async function getStatus() {
  const settings = await getSettings();

  let resourceRows: any[] = [];
  try {
    const keys = RESOURCE_IDS.map((id) => RESOURCES[id].stateKey);
    const { rows } = await pool.query(
      `SELECT resource, sync_mode, records_synced, last_success_at,
              last_status, last_run_at, last_error, last_error_at
         FROM sync_state
        WHERE resource = ANY($1)`,
      [keys]
    );
    resourceRows = rows;
  } catch {
    // ตาราง sync_state อาจยังไม่ถูกสร้าง (ยังไม่เคย sync) — ถือว่าไม่มีข้อมูล
    resourceRows = [];
  }

  const byKey = new Map(resourceRows.map((r) => [r.resource, r]));
  const resources = RESOURCE_IDS.map((id) => {
    const def = RESOURCES[id];
    const row = byKey.get(def.stateKey);
    return {
      id,
      label: def.label,
      // หมายเหตุ: last_success_at = "commit หน้าล่าสุดสำเร็จ" (ถูกเด้งทุกหน้าระหว่างรอบ)
      // ไม่ใช่ "รอบล่าสุดสำเร็จ" — ฝั่ง UI ต้องอ่านคู่กับ last_status เสมอ
      last_success_at: row?.last_success_at ? new Date(row.last_success_at).toISOString() : null,
      records_synced: row ? Number(row.records_synced) || 0 : 0,
      sync_mode: row?.sync_mode || null,
      last_status: row?.last_status || null,
      last_run_at: row?.last_run_at ? new Date(row.last_run_at).toISOString() : null,
      last_error: row?.last_error || null,
      last_error_at: row?.last_error_at ? new Date(row.last_error_at).toISOString() : null,
    };
  });

  return {
    running: runState.running,
    currentResource: runState.currentResource,
    startedAt: runState.startedAt,
    finishedAt: runState.finishedAt,
    lastError: runState.lastError,
    aborted: runState.aborted,
    trigger: runState.trigger,
    forceFull: runState.forceFull,
    resources,
    settings,
  };
}

// ============================================================
// Scheduler — เช็คทุก 60 วินาที
// ============================================================
let lastIntervalRun = Date.now(); // epoch ms ของรอบล่าสุดที่สั่งไป
let schedulerTimer: NodeJS.Timeout | null = null;

/** ต้องถี่กว่า MIN_INTERVAL_SECONDS พอสมควร ไม่งั้น interval 30 วิ จะเพี้ยนเป็น 60 วิ */
const TICK_MS = 5000;

/** เวลาปัจจุบันโซน Asia/Bangkok เป็น { date:'YYYY-MM-DD', time:'HH:MM', day:0-6 } */
function bangkokNow(): { date: string; time: string; day: number } {
  const { year, month, day, hour, minute, weekday } = thaiDateParts();
  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}`,
    day: weekday,
  };
}

/**
 * ถึงเวลา sync หรือยัง — ฟังก์ชันบริสุทธิ์ แยกออกมาให้เทสได้โดยไม่ต้องรอเวลาจริง
 *
 * เงื่อนไขต้องผ่านครบ 3 ข้อ: วันตรง → อยู่ในช่วงเวลา → เว้นระยะครบ interval
 */
export function shouldRunNow(
  settings: Pick<SyncSettings, 'days' | 'window_start' | 'window_end' | 'interval_seconds'>,
  now: { time: string; day: number },
  msSinceLastRun: number
): boolean {
  // 1) วันนี้อยู่ในวันที่เลือกไหม (อาเรย์ว่าง = ทุกวัน)
  if (settings.days.length > 0 && !settings.days.includes(now.day)) return false;

  // 2) อยู่ในช่วงเวลาไหม — เทียบ 'HH:MM' เป็นสตริงได้ตรง ๆ เพราะเลขศูนย์นำครบ
  if (now.time < settings.window_start || now.time > settings.window_end) return false;

  // 3) เว้นระยะครบ interval หรือยัง
  return msSinceLastRun >= settings.interval_seconds * 1000;
}

async function schedulerTick() {
  try {
    if (runState.running) return; // มี sync รันอยู่ — ข้าม
    const settings = await getSettings();
    if (!settings.auto_enabled) return;

    const { time, day } = bangkokNow();
    if (!shouldRunNow(settings, { time, day }, Date.now() - lastIntervalRun)) return;

    lastIntervalRun = Date.now();
    const started = startSync(settings.resources, 'schedule');
    console.log(
      `[scheduler] ถึงเวลา auto sync (วัน ${day} เวลา ${time} ในช่วง ${settings.window_start}-${settings.window_end}` +
        ` ทุก ${settings.interval_seconds} วิ) — started=${started}`
    );
  } catch (err: any) {
    console.error('[scheduler] tick error:', err?.message || err);
  }
}

/** เรียกครั้งเดียวหลัง app.listen */
export async function initScheduler() {
  try {
    await ensureSyncSettings();
    await ensureSyncStateColumns();
  } catch (err: any) {
    console.error('[scheduler] เตรียมตาราง sync ล้มเหลว:', err?.message || err);
  }
  lastIntervalRun = Date.now(); // เริ่มนับ interval จากตอน boot
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = setInterval(schedulerTick, TICK_MS);
  console.log(`[scheduler] เริ่มทำงาน (เช็คทุก ${TICK_MS / 1000} วินาที)`);
}

/**
 * หยุดตัวตั้งเวลา — ใช้ตอน graceful shutdown (C.4)
 *
 * เหตุผลที่ต้องหยุด: sync 1 รอบกิน CPU 10-18 วิ ถ้ามันดันเริ่มตอนที่เรากำลัง drain คิวอยู่
 * มันจะแย่ง CPU จากข้อความที่กำลังจะตอบทัน = ทำให้คนที่เรากำลังพยายามช่วยพลาดแทน
 *
 * หยุดได้แค่ "รอบใหม่" — รอบที่รันค้างอยู่แล้วยกเลิกกลางคันไม่ได้ (ดู isRunning())
 */
export function stopScheduler() {
  if (!schedulerTimer) return;
  clearInterval(schedulerTimer);
  schedulerTimer = null;
  console.log('[scheduler] หยุดแล้ว — จะไม่เริ่ม sync รอบใหม่');
}
