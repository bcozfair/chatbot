import fs from 'fs';
import path from 'path';

/**
 * หา path ของ binary ฝั่ง PostgreSQL (pg_dump / pg_restore)
 * ลำดับ: PG_BIN_DIR ใน .env → PostgreSQL ที่ติดตั้งบน Windows (เวอร์ชันสูงสุดก่อน) → PATH
 */
export function resolvePgBin(binName: string): string {
  // บน Windows ไฟล์จริงคือ pg_dump.exe — ต้องลองทั้งสองชื่อ ไม่งั้น existsSync พลาดทุกครั้ง
  const names = process.platform === 'win32' ? [`${binName}.exe`, binName] : [binName];

  const dirs: string[] = [];
  if (process.env.PG_BIN_DIR) dirs.push(process.env.PG_BIN_DIR);

  const root = 'C:/Program Files/PostgreSQL';
  if (fs.existsSync(root)) {
    const versions = fs.readdirSync(root)
      .filter(v => /^\d+$/.test(v))
      .sort((a, b) => Number(b) - Number(a));
    dirs.push(...versions.map(v => path.join(root, v, 'bin')));
  }

  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }

  // ไม่เจอ path เต็ม → หวังว่าอยู่ใน PATH (กรณี Linux/Docker ตอน deploy)
  return binName;
}
