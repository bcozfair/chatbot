import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { resolvePgBin } from './pgBin.js';

dotenv.config();

/**
 * ดัมป์ฐานข้อมูลทั้งก้อนเป็นไฟล์ custom format (.dump) สำหรับยกไป deploy
 *
 *   tsx scripts/dbDump.ts              ดัมป์ทุกตาราง (~466 MB)
 *   tsx scripts/dbDump.ts --no-sync    ข้าม sale_orders/customers ที่ดึงกลับมาได้ด้วย npm run sync:* (~45 MB)
 *
 * ไฟล์ผลลัพธ์ลง backup/ ซึ่ง .gitignore กันไว้แล้ว — มี PII ลูกค้าและ bcrypt hash ห้าม commit
 * กู้คืนด้วย: tsx scripts/dbRestore.ts backup/<ไฟล์>.dump
 */

// ตารางที่ sync กลับมาจากต้นทางได้ ไม่จำเป็นต้องยกข้ามเครื่อง
const SYNCABLE = ['public.sale_orders', 'public.customers'];

function main() {
  const skipSync = process.argv.includes('--no-sync');
  const { PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD } = process.env;

  for (const [k, v] of Object.entries({ PG_HOST, PG_DATABASE, PG_USER, PG_PASSWORD })) {
    if (!v) throw new Error(`ไม่พบตัวแปร ${k} ใน .env`);
  }

  const outDir = path.join(process.cwd(), 'backup');
  fs.mkdirSync(outDir, { recursive: true });

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const outFile = path.join(outDir, `${PG_DATABASE}_${stamp}${skipSync ? '_noSync' : ''}.dump`);

  const args = [
    '--host', PG_HOST!, '--port', String(PG_PORT ?? 5432),
    '--username', PG_USER!, '--dbname', PG_DATABASE!,
    '--format', 'custom',   // บีบอัดในตัว + pg_restore เลือก restore ทีละตารางได้
    '--no-owner', '--no-privileges',
    '--file', outFile,
  ];
  if (skipSync) {
    // ยกโครงสร้างไปด้วยแต่ไม่เอาข้อมูล — ค่อย npm run sync:* ที่ปลายทาง
    args.push(...SYNCABLE.flatMap(t => ['--exclude-table-data', t]));
  }

  console.log(`กำลังดัมป์ "${PG_DATABASE}" → ${path.relative(process.cwd(), outFile)}`);
  if (skipSync) console.log(`ข้ามข้อมูลใน: ${SYNCABLE.join(', ')} (โครงสร้างยังไปด้วย)`);

  const r = spawnSync(resolvePgBin('pg_dump'), args, {
    env: { ...process.env, PGPASSWORD: PG_PASSWORD },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status ?? 1);

  const mb = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
  console.log(`เสร็จแล้ว: ${path.relative(process.cwd(), outFile)} (${mb} MB)`);
  console.log('ไฟล์นี้มี PII ลูกค้าและ password hash — อย่า commit และอย่าส่งผ่านช่องทางที่ไม่เข้ารหัส');
}

main();
