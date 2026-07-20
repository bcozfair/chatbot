// ─────────────────────────────────────────────────────────────────────────────
//  TTL cache สำหรับตารางกฏ (อ่านบ่อยมาก แก้ไขน้อยมาก)
//
//  - แอดมินแก้กฏ → เรียก invalidateRuleCache() ทุก write path → เห็นผลทันที
//    TTL เป็นแค่ safety net เผื่อมีคนแก้ DB ตรง ๆ
//  - ตั้ง RULES_CACHE_TTL_MS=0 เพื่อปิด cache ทั้งหมด (kill switch)
//  - ระบบรัน Node โปรเซสเดียว 1 container จึงไม่ต้องมี cache invalidation ข้ามเครื่อง
// ─────────────────────────────────────────────────────────────────────────────

/** ชื่อ cache ของแต่ละตารางกฏ — เพิ่มตัวใหม่เมื่อมี rule type ใหม่ */
export type RuleCacheKey = 'quotation_rules';

interface CacheEntry {
  rows: any[];
  loadedAt: number;
  inflight: Promise<any[]> | null;
}

const store = new Map<RuleCacheKey, CacheEntry>();

const DEFAULT_TTL_MS = 60_000;

function cacheTtlMs(): number {
  const raw = process.env.RULES_CACHE_TTL_MS;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_MS;
}

/**
 * อ่านจาก cache ถ้ายังไม่หมดอายุ ไม่งั้นเรียก loader
 * ระหว่างที่ loader ยังทำงานอยู่ ผู้เรียกรายอื่นจะได้ promise เดียวกัน (กัน thundering herd)
 *
 * หมายเหตุ: ตารางกฏเป็น reference data ที่ไม่ถูกแก้ใน transaction ใด ๆ
 * ผู้เรียกที่ส่ง client ของ transaction เข้ามาจึงใช้ค่าที่ cache ไว้ได้อย่างปลอดภัย
 */
export async function loadCached<T>(key: RuleCacheKey, loader: () => Promise<T[]>): Promise<T[]> {
  const ttl = cacheTtlMs();
  if (ttl === 0) return await loader();

  const now = Date.now();
  const entry = store.get(key);

  if (entry) {
    if (entry.inflight) return await entry.inflight as T[];
    if (now - entry.loadedAt < ttl) return entry.rows as T[];
  }

  const inflight = loader()
    .then(rows => {
      store.set(key, { rows: rows as any[], loadedAt: Date.now(), inflight: null });
      return rows as any[];
    })
    .catch(err => {
      // โหลดพลาด → ทิ้ง entry ทิ้งไปเลย ให้ครั้งหน้าลองใหม่ ไม่ค้าง promise ที่ reject ไว้ใน cache
      store.delete(key);
      throw err;
    });

  store.set(key, { rows: entry?.rows ?? [], loadedAt: entry?.loadedAt ?? 0, inflight });
  return await inflight as T[];
}

/** ล้าง cache — ไม่ระบุ key = ล้างทั้งหมด เรียกจากทุก write path ของหน้าแอดมิน */
export function invalidateRuleCache(key?: RuleCacheKey): void {
  if (key) store.delete(key);
  else store.clear();
}
