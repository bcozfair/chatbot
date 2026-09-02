// ─────────────────────────────────────────────────────────────────────────────
//  ออกกุญแจให้เครื่องภายนอกที่จะมาดึงข้อมูลไป sync
//
//  รัน:  npm run sync:key -- --name "NUC-Kay"
//        npm run sync:key -- --name "เครื่อง X" --tables products,customers
//        npm run sync:key -- --list
//        npm run sync:key -- --revoke <id>
//
//  กุญแจจะถูกพิมพ์ออกมา "ครั้งเดียวตอนออก" เท่านั้น — ใน DB เก็บแค่ sha256
//  ทำหายแล้วไม่มีทางเอาคืน ต้องออกใหม่แล้วเพิกถอนใบเก่า (เจตนา — กุญแจที่ขอดูย้อนหลังได้
//  แปลว่าใครที่เข้า DB ได้ก็เอาไปใช้ได้ทุกใบ)
// ─────────────────────────────────────────────────────────────────────────────
import { randomBytes } from 'crypto';
import { pool } from '../config/db.js';
import { hashSyncKey, SYNC_KEY_PREFIX_LEN } from '../config/syncApiAuth.js';
import { TABLE_REGISTRY } from '../services/externalSync.js';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function list() {
  const { rows } = await pool.query(
    `SELECT id, name, key_prefix, allowed_tables, is_active, created_at, last_used_at, revoked_at
       FROM public.sync_api_keys ORDER BY id`
  );
  if (rows.length === 0) {
    console.log('ยังไม่มีกุญแจในระบบ');
    return;
  }
  for (const r of rows) {
    const state = r.revoked_at ? 'เพิกถอนแล้ว' : r.is_active ? 'ใช้งานได้' : 'ปิดอยู่';
    console.log(
      `#${r.id}  ${r.name}  [${r.key_prefix}...]  ${state}\n` +
      `     ตาราง: ${r.allowed_tables ? r.allowed_tables.join(', ') : 'ทุกตาราง'}\n` +
      `     ออกเมื่อ ${r.created_at.toISOString()}  ใช้ล่าสุด ${r.last_used_at ? r.last_used_at.toISOString() : '—'}`
    );
  }
}

async function revoke(id: string) {
  const { rows } = await pool.query(
    `UPDATE public.sync_api_keys SET is_active = false, revoked_at = NOW()
      WHERE id = $1 RETURNING id, name`,
    [id]
  );
  if (rows.length === 0) {
    console.error(`ไม่พบกุญแจ #${id}`);
    process.exitCode = 1;
    return;
  }
  console.log(`เพิกถอนกุญแจ #${rows[0].id} (${rows[0].name}) แล้ว — ปลายทางจะได้ 401 ทันทีในครั้งถัดไป`);
}

async function create(name: string, tablesArg: string | undefined, note: string | undefined) {
  let allowed: string[] | null = null;
  if (tablesArg) {
    allowed = tablesArg.split(',').map((t) => t.trim()).filter(Boolean);
    const known = new Set(TABLE_REGISTRY.map((d) => d.table));
    const unknown = allowed.filter((t) => !known.has(t));
    if (unknown.length > 0) {
      throw new Error(
        `ตารางนี้ไม่อยู่ในทะเบียน sync: ${unknown.join(', ')}\n` +
        `ที่มีให้เลือก: ${[...known].join(', ')}`
      );
    }
  }

  // 32 ไบต์สุ่มจาก CSPRNG = 256 บิต · base64url ไม่มีอักขระที่ต้อง escape เวลาไปอยู่ใน header/ไฟล์ env
  const rawKey = 'sk_' + randomBytes(32).toString('base64url');
  const { rows } = await pool.query(
    `INSERT INTO public.sync_api_keys (name, key_prefix, key_hash, allowed_tables, created_by, note)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [name, rawKey.slice(0, SYNC_KEY_PREFIX_LEN), hashSyncKey(rawKey), allowed, 'createSyncApiKey.ts', note ?? null]
  );

  console.log(`\nออกกุญแจ #${rows[0].id} ให้ "${name}" แล้ว`);
  console.log(`ตารางที่อ่านได้: ${allowed ? allowed.join(', ') : 'ทุกตารางในทะเบียน'}`);
  console.log('\n──────── กุญแจ (แสดงครั้งเดียว เก็บใส่ .env ของเครื่องปลายทางทันที) ────────');
  console.log(rawKey);
  console.log('────────────────────────────────────────────────────────────────────\n');
  console.log('ทดสอบจากเครื่องปลายทาง:');
  console.log(`  curl -H "Authorization: Bearer ${rawKey}" \\`);
  console.log(`       "${process.env.APP_URL ?? 'https://<subdomain>'}/api/sync/v1/tables"\n`);
}

async function main() {
  if (process.argv.includes('--list')) return list();

  const revokeId = argValue('--revoke');
  if (revokeId) return revoke(revokeId);

  const name = argValue('--name');
  if (!name) {
    console.error(
      'ต้องระบุชื่อเครื่องปลายทาง:\n' +
      '  npm run sync:key -- --name "NUC-Kay" [--tables a,b] [--note "..."]\n' +
      '  npm run sync:key -- --list\n' +
      '  npm run sync:key -- --revoke <id>'
    );
    process.exitCode = 1;
    return;
  }
  return create(name, argValue('--tables'), argValue('--note'));
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
