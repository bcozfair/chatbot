import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { resolvePgBin } from './pgBin.js';

dotenv.config();

/**
 * กู้ไฟล์ .dump ที่ได้จาก scripts/dbDump.ts เข้า DB ปลายทาง
 *
 *   tsx scripts/dbRestore.ts backup/chatbot_primus_xxx.dump
 *
 * ปลายทางอ่านจาก .env (PG_HOST/PG_DATABASE/...) — ต้องสร้าง database เปล่าไว้ก่อน
 * ตัว --clean จะ DROP object เดิมก่อนสร้างใหม่ ถ้าชี้ผิด DB ข้อมูลหายได้
 */

function main() {
  const dumpFile = process.argv[2];
  if (!dumpFile) {
    throw new Error('ต้องระบุไฟล์: tsx scripts/dbRestore.ts backup/<ไฟล์>.dump');
  }
  const dumpPath = path.resolve(process.cwd(), dumpFile);
  if (!fs.existsSync(dumpPath)) {
    throw new Error(`ไม่พบไฟล์: ${dumpPath}`);
  }

  const { PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD } = process.env;
  for (const [k, v] of Object.entries({ PG_HOST, PG_DATABASE, PG_USER, PG_PASSWORD })) {
    if (!v) throw new Error(`ไม่พบตัวแปร ${k} ใน .env`);
  }

  console.log(`กำลังกู้ ${path.basename(dumpPath)} → "${PG_DATABASE}" ที่ ${PG_HOST}:${PG_PORT ?? 5432}`);
  console.log('object เดิมใน DB ปลายทางจะถูก DROP ก่อนสร้างใหม่');

  const r = spawnSync(resolvePgBin('pg_restore'), [
    '--host', PG_HOST!, '--port', String(PG_PORT ?? 5432),
    '--username', PG_USER!, '--dbname', PG_DATABASE!,
    '--clean', '--if-exists',
    '--no-owner', '--no-privileges',
    '--single-transaction',   // ล้มกลางคันแล้ว rollback ทั้งหมด ไม่ทิ้ง DB ครึ่ง ๆ กลาง ๆ
    dumpPath,
  ], {
    env: { ...process.env, PGPASSWORD: PG_PASSWORD },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log('กู้ข้อมูลสำเร็จ');
}

main();
