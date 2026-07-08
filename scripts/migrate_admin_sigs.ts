import { pool } from '../config/db.js';
import { computeAdminKey } from '../services/adminService.js';
import fs from 'fs';
import path from 'path';

/**
 * Migration: เปลี่ยนการตั้งชื่อไฟล์ลายเซ็นแอดมิน
 *   เดิม: data/admin_sigs/{salesperson_id}.{ext}   (ผูกกับเซลส์ → ซ้ำซ้อน)
 *   ใหม่: data/admin_sigs/{adminKey}.{ext}          (ผูกกับชื่อแอดมิน → คนเดียว = ไฟล์เดียว)
 *
 * adminKey = computeAdminKey(salesperson.employee_quotations)
 *
 * รันแบบ preview (ไม่แก้ไฟล์จริง):  tsx scripts/migrate_admin_sigs.ts
 * รันจริง:                          tsx scripts/migrate_admin_sigs.ts --apply
 */

const APPLY = process.argv.includes('--apply');
const EXTENSIONS = ['.png', '.jpg', '.jpeg'];
const ADMIN_DIR = path.join(process.cwd(), 'data', 'admin_sigs');

async function run() {
  console.log(`>>> Migrate admin_sigs  (${APPLY ? 'APPLY' : 'DRY-RUN — ไม่แก้ไฟล์จริง'})`);

  if (!fs.existsSync(ADMIN_DIR)) {
    console.log('ไม่พบโฟลเดอร์ data/admin_sigs — ไม่มีอะไรต้องย้าย');
    return;
  }

  const { rows } = await pool.query(
    `SELECT salesperson_id, employee_quotations
     FROM salesperson
     WHERE salesperson_id IS NOT NULL
       AND employee_quotations IS NOT NULL
       AND TRIM(employee_quotations) <> ''`
  );

  let moved = 0, deduped = 0, skipped = 0, missingKey = 0;
  // เก็บไฟล์ต้นทางที่ประมวลผลแล้ว เพื่อลบทีหลัง
  const sourcesToRemove: string[] = [];
  // key ที่วางแผนสร้างแล้วในรอบนี้ (ให้ DRY-RUN แสดงผล dedupe ได้ถูกต้องแม้ยังไม่เขียนไฟล์)
  const plannedKeys = new Set<string>();

  for (const row of rows) {
    const spId = String(row.salesperson_id).trim();
    const adminKey = computeAdminKey(row.employee_quotations);

    // หาไฟล์ต้นทางที่ตั้งชื่อด้วย salesperson_id
    const srcExt = EXTENSIONS.find(ext => fs.existsSync(path.join(ADMIN_DIR, `${spId}${ext}`)));
    if (!srcExt) continue; // เซลส์คนนี้ไม่มีไฟล์ลายเซ็นแอดมินเดิม

    if (!adminKey) {
      console.warn(`  ⚠️  sp ${spId}: คำนวณ adminKey จาก "${row.employee_quotations}" ไม่ได้ — ข้าม`);
      missingKey++;
      continue;
    }

    const srcPath = path.join(ADMIN_DIR, `${spId}${srcExt}`);
    const targetExists = plannedKeys.has(adminKey)
      || EXTENSIONS.some(ext => fs.existsSync(path.join(ADMIN_DIR, `${adminKey}${ext}`)));

    if (targetExists) {
      // แอดมินคนนี้มีไฟล์ keyed อยู่แล้ว (จากเซลส์คนก่อน) → ไฟล์ต้นทางซ้ำซ้อน ลบทิ้ง
      console.log(`  ↺ sp ${spId} → ${adminKey}${srcExt} : มีไฟล์แอดมินอยู่แล้ว (ซ้ำ) → จะลบต้นทาง`);
      sourcesToRemove.push(srcPath);
      deduped++;
    } else {
      const targetPath = path.join(ADMIN_DIR, `${adminKey}${srcExt}`);
      console.log(`  ✎ sp ${spId} → ${adminKey}${srcExt} : ย้าย "${String(row.employee_quotations).trim()}"`);
      if (APPLY) {
        fs.copyFileSync(srcPath, targetPath);
      }
      plannedKeys.add(adminKey);
      sourcesToRemove.push(srcPath);
      moved++;
    }
  }

  // ลบไฟล์ต้นทางที่ตั้งชื่อด้วย salesperson_id หลังคัดลอกครบ
  for (const src of sourcesToRemove) {
    if (APPLY) {
      try {
        if (fs.existsSync(src)) fs.unlinkSync(src);
      } catch (err) {
        console.error(`  ✗ ลบไฟล์ต้นทางไม่สำเร็จ: ${src}`, err);
        skipped++;
      }
    }
  }

  console.log('----------------------------------------');
  console.log(`ย้ายใหม่: ${moved} | ซ้ำ(ลบต้นทาง): ${deduped} | คำนวณ key ไม่ได้: ${missingKey} | ลบไม่สำเร็จ: ${skipped}`);
  if (!APPLY) {
    console.log('นี่คือ DRY-RUN — ยังไม่แก้ไฟล์จริง รันซ้ำด้วย --apply เพื่อดำเนินการจริง');
  } else {
    console.log('เสร็จสิ้น ✅');
  }
}

run()
  .catch(err => { console.error('Migration error:', err); process.exitCode = 1; })
  .finally(async () => { await pool.end(); });
