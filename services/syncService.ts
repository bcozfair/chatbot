import { pool } from '../config/db.js';

// ============================================================
// Registry ของ resource ที่ sync ได้
//  - id       : ค่าที่ frontend/endpoint ใช้
//  - stateKey : คีย์ในตาราง sync_state (สคริปต์เดิมเขียนไว้)
//  - label    : ชื่อไทยไว้โชว์
//  - load     : dynamic import ฟังก์ชัน sync (lazy — env ของ gateway จะถูกตรวจ
//               ตอนเรียกจริงเท่านั้น ไม่ throw ตอน boot เซิร์ฟเวอร์)
// ============================================================
type ResourceId = 'products' | 'customers' | 'saleorders';

interface ResourceDef {
  id: ResourceId;
  stateKey: string;
  label: string;
  load: () => Promise<() => Promise<unknown>>;
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
  trigger: 'manual' | 'schedule' | null;
}

const runState: RunState = {
  running: false,
  currentResource: null,
  queue: [],
  startedAt: null,
  finishedAt: null,
  lastError: null,
  trigger: null,
};

export function isRunning() {
  return runState.running;
}

/**
 * เริ่ม sync แบบ background (fire-and-forget) — คืนค่าทันที ไม่รอให้จบ
 * เพราะ sync สินค้าใช้เวลาหลายนาที (HTTP request ไม่ควรค้างรอ)
 * คืน false ถ้ามี sync กำลังรันอยู่แล้ว
 */
export function startSync(resources: ResourceId[], trigger: 'manual' | 'schedule'): boolean {
  if (runState.running) return false;

  const list = resources.filter(isValidResource);
  if (list.length === 0) return false;

  runState.running = true;
  runState.queue = [...list];
  runState.currentResource = null;
  runState.startedAt = new Date().toISOString();
  runState.finishedAt = null;
  runState.lastError = null;
  runState.trigger = trigger;

  // ไม่ await — ปล่อยรันเบื้องหลัง
  void (async () => {
    for (const id of list) {
      runState.currentResource = id;
      const def = RESOURCES[id];
      try {
        console.log(`[sync] เริ่ม sync ${def.label} (${id}) — trigger=${trigger}`);
        const fn = await def.load();
        await fn();
        console.log(`[sync] sync ${def.label} เสร็จแล้ว`);
      } catch (err: any) {
        // resource ที่ล้ม ไม่บล็อกตัวถัดไป แต่บันทึก error ไว้
        const msg = err?.message || String(err);
        runState.lastError = `${def.label}: ${msg}`;
        console.error(`[sync] sync ${def.label} ล้มเหลว:`, msg);
      }
    }
    runState.running = false;
    runState.currentResource = null;
    runState.queue = [];
    runState.finishedAt = new Date().toISOString();
    console.log('[sync] จบรอบ sync ทั้งหมด');
  })();

  return true;
}

// ============================================================
// ตาราง config ตารางเวลา (sync_settings) — แถวเดียว id=1
// ============================================================
/** ค่าที่อนุญาตสำหรับ interval (นาที) */
export const INTERVAL_MINUTE_OPTIONS = [1, 3, 5, 10, 15, 30, 60] as const;
const DEFAULT_INTERVAL_MINUTES = 15;

export interface SyncSettings {
  auto_enabled: boolean;
  mode: 'daily' | 'interval';
  daily_time: string; // 'HH:MM'
  interval_minutes: number;
  resources: ResourceId[];
  updated_at: string | null;
}

const DEFAULT_SETTINGS: SyncSettings = {
  auto_enabled: false,
  mode: 'daily',
  daily_time: '02:00',
  interval_minutes: DEFAULT_INTERVAL_MINUTES,
  resources: [...RESOURCE_IDS],
  updated_at: null,
};

async function ensureSyncSettings() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sync_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      auto_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      mode TEXT NOT NULL DEFAULT 'daily',
      daily_time TEXT NOT NULL DEFAULT '02:00',
      interval_minutes INTEGER NOT NULL DEFAULT 15,
      resources TEXT[] NOT NULL DEFAULT ARRAY['products','customers','saleorders'],
      updated_at TIMESTAMPTZ,
      CONSTRAINT sync_settings_singleton CHECK (id = 1)
    )
  `);
  // migration: เดิมเก็บเป็นชั่วโมง (interval_hours) — เปลี่ยนเป็นนาที
  await pool.query(`
    ALTER TABLE sync_settings ADD COLUMN IF NOT EXISTS interval_minutes INTEGER NOT NULL DEFAULT 15
  `);
  await pool.query(`
    ALTER TABLE sync_settings DROP COLUMN IF EXISTS interval_hours
  `);
  await pool.query(`
    INSERT INTO sync_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING
  `);
}

export async function getSettings(): Promise<SyncSettings> {
  await ensureSyncSettings();
  const { rows } = await pool.query(`SELECT * FROM sync_settings WHERE id = 1`);
  if (rows.length === 0) return { ...DEFAULT_SETTINGS };
  const r = rows[0];
  const resources = (Array.isArray(r.resources) ? r.resources : []).filter(isValidResource);
  return {
    auto_enabled: !!r.auto_enabled,
    mode: r.mode === 'interval' ? 'interval' : 'daily',
    daily_time: r.daily_time || DEFAULT_SETTINGS.daily_time,
    interval_minutes: Number(r.interval_minutes) || DEFAULT_SETTINGS.interval_minutes,
    resources: resources.length ? resources : [...RESOURCE_IDS],
    updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
}

/** validate + บันทึก config; คืนค่าที่บันทึกจริง */
export async function saveSettings(input: any): Promise<SyncSettings> {
  await ensureSyncSettings();

  const mode: 'daily' | 'interval' = input?.mode === 'interval' ? 'interval' : 'daily';

  // daily_time ต้องเป็น HH:MM 00:00–23:59
  let dailyTime = String(input?.daily_time ?? DEFAULT_SETTINGS.daily_time).trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(dailyTime)) dailyTime = DEFAULT_SETTINGS.daily_time;

  let intervalMinutes = Math.trunc(Number(input?.interval_minutes));
  // อนุญาตเฉพาะค่าในชุด {1,3,5,10,15,30,60} — ถ้าไม่ตรง ใช้ค่า default
  if (!(INTERVAL_MINUTE_OPTIONS as readonly number[]).includes(intervalMinutes)) {
    intervalMinutes = DEFAULT_INTERVAL_MINUTES;
  }

  const resources: ResourceId[] = Array.isArray(input?.resources)
    ? input.resources.filter(isValidResource)
    : [...RESOURCE_IDS];
  const finalResources = resources.length ? Array.from(new Set(resources)) : [...RESOURCE_IDS];

  const autoEnabled = !!input?.auto_enabled;

  await pool.query(
    `UPDATE sync_settings
       SET auto_enabled = $1, mode = $2, daily_time = $3, interval_minutes = $4,
           resources = $5, updated_at = NOW()
     WHERE id = 1`,
    [autoEnabled, mode, dailyTime, intervalMinutes, finalResources]
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
      `SELECT resource, sync_mode, records_synced, last_success_at
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
      last_success_at: row?.last_success_at ? new Date(row.last_success_at).toISOString() : null,
      records_synced: row ? Number(row.records_synced) || 0 : 0,
      sync_mode: row?.sync_mode || null,
    };
  });

  return {
    running: runState.running,
    currentResource: runState.currentResource,
    startedAt: runState.startedAt,
    finishedAt: runState.finishedAt,
    lastError: runState.lastError,
    trigger: runState.trigger,
    resources,
    settings,
  };
}

// ============================================================
// Scheduler — เช็คทุก 60 วินาที
// ============================================================
let lastTriggeredDay: string | null = null; // 'YYYY-MM-DD' สำหรับโหมด daily
let lastIntervalRun = Date.now(); // epoch ms สำหรับโหมด interval
let schedulerTimer: NodeJS.Timeout | null = null;

/** เวลาปัจจุบันโซน Asia/Bangkok เป็น { date:'YYYY-MM-DD', time:'HH:MM' } */
function bangkokNow(): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
  let hh = get('hour');
  if (hh === '24') hh = '00'; // Intl อาจคืน 24 ตอนเที่ยงคืน
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${hh}:${get('minute')}` };
}

async function schedulerTick() {
  try {
    if (runState.running) return; // มี sync รันอยู่ — ข้าม
    const settings = await getSettings();
    if (!settings.auto_enabled) return;

    let shouldRun = false;
    if (settings.mode === 'daily') {
      const { date, time } = bangkokNow();
      if (time === settings.daily_time && lastTriggeredDay !== date) {
        shouldRun = true;
        lastTriggeredDay = date;
      }
    } else {
      const elapsed = Date.now() - lastIntervalRun;
      if (elapsed >= settings.interval_minutes * 60 * 1000) {
        shouldRun = true;
        lastIntervalRun = Date.now();
      }
    }

    if (shouldRun) {
      const started = startSync(settings.resources, 'schedule');
      console.log(`[scheduler] ถึงเวลา auto sync (${settings.mode}) — started=${started}`);
    }
  } catch (err: any) {
    console.error('[scheduler] tick error:', err?.message || err);
  }
}

/** เรียกครั้งเดียวหลัง app.listen */
export async function initScheduler() {
  try {
    await ensureSyncSettings();
  } catch (err: any) {
    console.error('[scheduler] ensureSyncSettings ล้มเหลว:', err?.message || err);
  }
  lastIntervalRun = Date.now(); // เริ่มนับ interval จากตอน boot
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = setInterval(schedulerTick, 60 * 1000);
  console.log('[scheduler] เริ่มทำงาน (เช็คทุก 60 วินาที)');
}
