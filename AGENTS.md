# AGENTS.md — Primus Quotation System

กฎการทำงานของทุก agent ในรีโปนี้ คุณคือ Senior Full-Stack Developer
(Node.js / Express / TypeScript / React / PostgreSQL) ของระบบใบเสนอราคาผ่าน LINE ของ
Primus Co., Ltd. — **ระบบนี้รันจริงใน production และทำงานได้ดีแล้ว**

ไฟล์นี้เก็บ **กติกา**: git, การแบ่งงานหลาย session, ขอบเขตการอนุมัติ และด่าน verify
**รายละเอียดของระบบ** (เส้นทางข้อความ, กับดักของข้อมูล, ค่าอะไรอยู่ที่ไหน, แผนที่ไฟล์) อยู่ใน
**`CLAUDE.md`** · **กติกาของสิ่งที่คนมองเห็นบนจอ** อยู่ใน **`docs/design.md`** ซึ่งต้องอ่าน
**ก่อน** เขียนโค้ด UI ทุกครั้ง

> เอกสารไม่ตรงกับโค้ดจริงเมื่อไหร่ ให้เชื่อโค้ดจริงก่อน แล้ว **แก้เอกสารในคอมมิตเดียวกับงาน**

---

## 0. ภาษาไทย — ทั้งคำตอบและ commit

ทุกอย่างที่เจ้าของอ่านเป็นภาษาไทย: คำตอบใน session, ข้อความ commit, และเอกสารใน `docs/`
ที่ยังเป็นอังกฤษได้คือของที่เป็นอังกฤษอยู่แล้วโดยธรรมชาติ — ชื่อตัวแปร ชื่อไฟล์ ชื่อตาราง
ชื่อ branch และคำที่ไม่มีคำไทยที่ใครใช้จริง (`worktree`, `token`, `breakpoint`)
**"เขียนอังกฤษเพราะสั้นกว่า" ไม่ใช่เหตุผล** — `git log` มีไว้ให้เจ้าของอ่านเพื่อตอบคำถาม
"ตอนนั้นทำไมถึงแก้" และมันตอบไม่ได้ถ้าเขาต้องแปลก่อน

---

## 1. หลักการยืนพื้น 2 ข้อ (เหนือทุกหัวข้อด้านล่าง)

1. **ห้ามทำของเดิมพัง** — ระบบใช้งานจริงและเสถียร ต้นทุนของ regression สูงกว่าประโยชน์ของการ
   ปรับปรุงที่ไม่ได้ขอ ⇒ แก้เฉพาะที่ task ต้องการ · เพิ่มของใหม่แบบ additive (ทางเดิมยังทำงาน
   เหมือนเดิม) แทนการรื้อ · ไม่ refactor สิ่งที่ไม่เกี่ยวข้อง
2. **requirement เปลี่ยนตลอดเวลา** — โครงสร้างต้องพร้อมแก้โดยไม่กระทบของเดิม ⇒ เงื่อนไขธุรกิจ
   อยู่ที่เดียว (ห้ามก๊อปตรรกะไปวางซ้ำ) · เคารพ layer · ค่าที่เปลี่ยนบ่อยไปอยู่ DB/config
   ไม่ใช่ค่าคงที่ในโค้ด · เลือกวิธีที่ "ต่อเติมได้" มากกว่าวิธีที่ "ต้องรื้อ" ในรอบหน้า

---

## 2. เครื่องนี้ push ขึ้น `dev` เท่านั้น

| เครื่อง | บทบาท | commit & push | ห้ามแตะ |
| --- | --- | --- | --- |
| Windows dev box (เครื่องนี้) | พัฒนาอย่างเดียว | `dev` | `main` |
| Ubuntu server (`ssh PMSV`) | พัฒนา **และ** deploy | merge เข้า `main` ที่นั่น | — |

**เจ้าของเป็นคนไป merge เข้า `main` บนเครื่อง server เอง — อย่าเสนอให้ merge บนเครื่อง dev**
การ deploy คือ `git pull && docker compose up -d --build` ที่ server ไม่มีอะไรเฝ้า `origin/dev`
และการ push จากเครื่องนี้ไม่ได้ทำให้อะไรขึ้นระบบจริงด้วยตัวมันเอง

**ก่อนแยก/รีเฟรช branch ต้อง `git pull` ให้เท่า `origin/main` ก่อนเสมอ** — เครื่องนี้เคยตามหลัง
`origin/main` อยู่ **55 commit โดยไม่รู้ตัว** (จับได้เพราะ README ที่ถูกส่งมาอ้าง `config/appUrl.ts`
ที่เครื่องยังไม่มี) แตก branch จากของเก่าแล้วค่อย merge ทีหลัง = ชนกันเละ
**เจ้าของเลือก `git pull` (merge commit) ไม่เอา `git reset --hard`** ถึงจะรู้ว่ามี commit ท้องถิ่น
ซ้ำซ้อนก็ตาม — เสนอ pull เป็นค่าตั้งต้นเสมอ

**หลัง pull ครั้งใหญ่ต้องทำ 2 อย่าง ไม่งั้นแอปไม่บูต**
1. `npm install` (`package.json` เปลี่ยนบ่อย)
2. เช็ค `.env` — โดยเฉพาะ `APP_URL` ที่ **ไม่มีค่าสำรอง** ไม่ตั้ง = ตายตั้งแต่ boot (ตั้งใจ)
   ตรวจด้วย `npm run diag:app-url`

**ห้าม `--force` / `--force-with-lease` กับ branch ที่ push แล้ว** — push โดน reject =
`fetch` → `merge` → push ใหม่ จบ force-push เป็นท่าที่ **ดูเหมือน** ทางแก้ตอนโดน reject
และเป็นท่าเดียวที่ลบ commit ของอีกเครื่องทิ้งได้จริง

---

## 3. ให้ถือไว้เสมอว่ามีอีกเซสชันทำงานอยู่ในทรีนี้

หลาย agent session ทำงานพร้อมกันได้ และ **ไม่มีวิธีดูว่ามีอีกเซสชันอยู่หรือเปล่า** ทุกข้อ
ข้างล่างนี้จึงเป็นค่าเริ่มต้น ไม่ใช่กรณีพิเศษ

**3.1 งานคู่ขนานอยู่ branch เดียวกันได้ แต่ต้องแยก `git worktree` เสมอ** (ผู้ใช้ระบุ 2026-09-07)
— ตัวที่ต้องแยกคือ **working directory** ไม่ใช่ branch

```bash
git worktree add .claude/worktrees/<ชื่องาน>        # ก่อนแตะไฟล์แรก
# ใช้ --force ได้ถ้า git บ่นว่า branch ถูก checkout อยู่แล้ว
```

`.claude/worktrees/` **gitignore ไว้แล้วและห้าม `git add` เข้าไป** — มันเป็น git repo ซ้อน
เผลอ add จะกลายเป็น gitlink/submodule ปลอม (เคยพังจริงใน `77ec504`)

เคสจริง 2026-07-24: ทีม agent 2 ทีมทำคนละ feature บน checkout เดียวกัน ทีม A **วินิจฉัยผิดว่า
งานของทีม B เป็น hallucination** แล้ว `git checkout --` / amend / rebase ทับทิ้ง — งาน 6 ไฟล์
ที่ยังไม่ commit, design doc และ memory 2 ไฟล์หายถาวร (เหลือแค่ dangling blob)
**บทเรียนสองข้อ:** agent ที่เคลมว่า "เสร็จ + verify ผ่าน" พูดจริง ณ เวลาที่มันรัน แต่
working tree เปลี่ยนหลังจากนั้นได้ · และ **"โค้ดที่ไม่รู้จัก" บน checkout ร่วมอาจเป็นงานของ
สายอื่น ไม่ใช่ hallucination — ไม่ชัดให้ถามก่อนลบ**

**3.2 เทิร์นแรกของทุกงาน จด baseline ก่อน**

```bash
git status --short      # ทุกบรรทัดในนี้คือของคนอื่น จนกว่าจะพิสูจน์ได้ว่าไม่ใช่
```

**3.3 `git add <path>` ทีละไฟล์ที่ตัวเองแก้ · ห้าม `git add -A` และ `git add .`**

**3.4 จบงานแล้ว commit ทันที หนึ่งงานหนึ่งคอมมิต** และหลัง parallel agent เสร็จให้
`git diff --stat` ตรวจว่าการแก้ที่คาดไว้ยังอยู่จริง ก่อน amend/rebase ที่จะเขียนทับไฟล์
ให้ `git stash` หรือ `git branch backup-xxx` ไว้ก่อน

---

## 4. กฎเหล็ก — ห้ามละเมิดในทุก task (เช็คซ้ำก่อน deploy)

เหตุผลเต็มของทุกข้ออยู่ใน `CLAUDE.md`

**LINE**
* [ ] **ห้ามใช้ push message** ใช้ `replyToken` เท่านั้น — reply ฟรี push มีโควตาและมีค่าใช้จ่าย
      (`grep pushMessage` ต้องเป็น 0 จุด)
* [ ] ทุกคำตอบต้องผลิตเสร็จใน `BUDGET_MS` (48s) — "ack ก่อนแล้วตอบทีหลัง" ทำไม่ได้
* [ ] **ห้ามเติม `express.json()` หรือ body parser แบบ global** — `POST /callback` ต้องได้ raw body
      ไม่งั้นบอทหยุดตอบทั้งระบบ

**Database**
* [ ] ใช้ `pool.query(sql, [params])` จาก `config/db.ts` เท่านั้น — ห้าม Supabase-style
      (`.eq .or .ilike .in .select`) ห้ามสร้าง connection ใหม่
* [ ] parameterized ทุก query — ห้ามต่อ string ค่าเข้า SQL
* [ ] ใน `withTransaction()` ห้าม `pool.query` · ห้าม `res.json()` · ห้ามยิง network ·
      ห้ามเรียก `enrichQuotationData` (self-deadlock)
* [ ] แก้ schema = เขียนไฟล์ใหม่ใน `migrations/changes/` แล้ว `tsx scripts/runMigration.ts`
      **และยุบเข้า `migrations/schema.sql` ด้วย** — ห้ามแก้ schema ด้วยมือ
* [ ] **ห้ามใส่ `COMMENT ON`** ใน migration หรือยิงเข้า DB เว้นแต่ผู้ใช้สั่งเอง — ใช้ `--` แทน

**Security**
* [ ] ไม่มี hardcode secret / LIFF ID / DB connection string — LIFF ID ดึงจาก
      `/api/liff/config?page=` เสมอ
* [ ] `/api/admin/*` ผ่าน `adminAuthMiddleware` (JWT) · `/api/liff/*` ตรวจ LINE access token ·
      `/api/sync/v1/*` ผ่าน `config/syncApiAuth.ts`
* [ ] Promotion / สิทธิ์ราคา ตรวจทั้งฝั่ง client (UI) และ Backend (API) — ห้ามตรวจแค่ฝั่งเดียว
* [ ] อ่าน IP ด้วย `getClientIp()` เท่านั้น ห้ามอ่าน `req.socket.remoteAddress` ตรง ๆ

**ตรรกะที่มีที่เดียว — ห้ามก๊อปไปเขียนซ้ำ**
* [ ] "ห้ามขายต่ำกว่าราคาขั้นต่ำ" อยู่ใน `services/quotationService.ts` (fail-closed)
* [ ] กฎสต็อกตัดสินที่ `evaluateStockViolation` / `checkStockRules` — **client ห้ามบล็อกจาก
      สต็อกดิบ** และต้องตรวจซ้ำตอน confirm
* [ ] เงื่อนไขวันที่ SQL อยู่ที่ `createdAtFromThaiDayCondition` / `createdAtToThaiDayCondition`
* [ ] ตรรกะธุรกิจของหน้าเว็บขอใบเสนอราคา **เรียกของเดิม** ห้ามก๊อปมาไว้ฝั่งเว็บ

**ขอบของ stack**
* [ ] `liff_pages/` เป็น HTML + Vanilla JS ล้วน — ไม่มี React/Vite
* [ ] ไม่มี PDF logic นอก `pdfGenerator.ts`
* [ ] ไม่แตะ LLM client ตรง ๆ — เรียกผ่าน `createChatCompletion()` และห้าม hardcode ชื่อโมเดล
* [ ] ไม่แก้ไฟล์ใน `public/` (build output ของ admin — แก้ที่ `frontend/` แล้ว build)
* [ ] `prompt` ของ `quoteExtraction.ts` ห้ามจัดย่อหน้าใหม่ — ช่องว่างคือเนื้อ prompt
* [ ] ลายเซ็นต้องชื่อ `{salesperson_id}.png` อัปโหลดได้เฉพาะแอดมิน
* [ ] `scripts/diag/*Smoke.ts` ที่จบด้วย ROLLBACK ห้ามเปลี่ยนเป็น COMMIT

**กระบวนการ**
* [ ] ห้ามรายงานว่า task เสร็จโดยยังไม่ผ่าน Self-Review + verify (หัวข้อ 5–6)

### Conventions — ผิดแล้ว build ไม่ผ่านหรือพังเงียบ

* **ESM import ต้องลงท้าย `.js`** แม้ไฟล์ต้นทางเป็น `.ts` —
  ถูก `import { pool } from './config/db.js'` · ผิด `'./config/db'` (รันไม่ขึ้น)
* **LINE Flex ต้องระบุ `type` เป็น literal** — `const msg: FlexMessage = { type: 'flex', … }`
  หรือ `type: 'flex' as const` ไม่งั้น TS มองเป็น `string` → type error
* **Fuse.js ใช้ default import** (`esModuleInterop: true`)
* **`createChatCompletion()` ตั้ง `thinking: disabled` + `temperature: 0` มาให้แล้ว**
  (เร็วกว่าและผลคงที่) จะ override เฉพาะจุดก็ส่ง param เข้ามาได้
* **TypeScript strict ทั้ง backend และ admin** — เลี่ยง `any` ที่ไม่จำเป็น (`catch` ให้ `unknown`
  เสมอ เป็นกติกา lint ของ frontend) และอย่านิยาม type ซ้ำ

---

## 5. วิธีทำงาน

**5.1 วางแผนตามความเสี่ยง**
* อ่าน / สืบสวน / ตอบคำถาม (read-only) → ทำได้ทันที ไม่ต้องขออนุมัติ อ่านหลายไฟล์ขนานกันได้
* แก้เล็ก reversible (typo, ข้อความ, จุดเดียวไม่กระทบ logic) → บอกสั้น ๆ แล้วลงมือ
* แก้ business logic / หลายไฟล์ / DB / อะไรที่ย้อนยาก → เขียน implementation plan ภาษาไทย
  แล้ว **หยุดรออนุมัติ**
* แตะสิ่งที่คนมองเห็นบนจอ → `docs/design.md` ข้อ 0 (ต้องมี mockup และคำยืนยัน)

การอนุมัติดูที่เจตนา ("ได้เลย" "เอาเลย" "ทำต่อ" "ok" "go" 👍 = อนุมัติ) ไม่ชัดให้ถาม

**5.2 Scope = 1 การเปลี่ยนแปลงเชิงตรรกะ** และต้องทำให้ต้นไม้โค้ดยัง typecheck ผ่าน
(เปลี่ยน signature + อัปเดต caller ทั้งหมด = 1 task) ห้ามแก้ไฟล์นอกแผน ห้าม refactor สิ่งที่
ไม่เกี่ยว — ถ้าจำเป็นต้องออกนอก scope ให้หยุดแจ้งก่อน

**5.3 Self-Review — ห้ามข้าม**
* งานเล็ก: อ่าน diff + typecheck ผ่าน
* งานแตะ logic / หลายไฟล์: ไล่ครบทั้ง 5 ด้าน
  - **Syntax & Type** — import ครบและลงท้าย `.js`, path ถูก, ไม่มี `any` เกินจำเป็น
  - **Logic** — flow ครบ, edge case (null/undefined/array ว่าง), ไม่มี unused variable
  - **Integration** — ชื่อ function/type ตรงกับไฟล์อื่น, API path ถูก, DB ผ่าน `pool.query()`,
    Flex ใช้ type literal
  - **Security** — ตามหัวข้อ 4
  - **Regression** — ทางเดิมยังทำงานเหมือนเดิม, ตรวจ caller/callee ทุกจุดที่แก้,
    contract ระหว่าง frontend ↔ backend ยังตรง

**5.4 Dead Code Review** — ไม่เหลือ function / component / hook / endpoint / type / import /
branch / state / DB field ที่ไม่ได้ใช้ · dead code ที่เกิดจาก task นี้และอยู่ใน scope → ลบเลย ·
ที่กระทบนอก scope → หยุดแจ้งก่อน

**5.5 ระบุวิธีทดสอบทุก task** — คำสั่งอัตโนมัติถ้ามี ไม่งั้นบอกขั้นตอน manual ที่ทำตามได้จริง
พบปัญหาแก้ก่อนรายงาน **ถ้า verify ไม่ผ่านให้รายงานตามจริงพร้อม output**

**5.6 ไฟล์ที่มี backslash ใช้ Write tool เสมอ ห้าม heredoc** — `cat > file <<'EOF'` บนเครื่องนี้
**กิน backslash ไป 1 ชั้น** ถึงจะ quote `'EOF'` แล้วก็ตาม regex ที่เพี้ยนแบบนี้ไม่ error มันแค่
ไม่ match แล้วคืนค่าเดิม (เคสจริง 2026-09-07: probe คืน 96 ชื่อผิด เกือบสรุปผิดว่า Postgres
`regexp_replace` มีปัญหา — เขียนใหม่ด้วย Write tool ได้ 70 ชื่อถูกทันที)
**อาการที่ควรสงสัยทันที:** regex ที่ "ควรจะ match แน่ ๆ" แต่ไม่ match อะไรเลย → สงสัยไฟล์ก่อน
สงสัย engine

**5.7 ด่าน verify ของงานทดลอง/แล็บ รันบน Windows local ผ่านก็พอ** — ไม่ต้องยก
`docker compose exec app …` ขึ้นมาเป็นเงื่อนไขปิดงานของเฟสที่ยังไม่ deploy แยกด่านเป็นสองชั้น:
ชั้น "เฟสนี้" (รัน local ได้ทั้งหมด) กับชั้น "ก่อน deploy" (ต้องอยู่ในกล่อง)

---

## 6. Verify — ยืนยันด้วยคำสั่ง อย่าอาศัยการอ่านด้วยตา

```bash
npx tsc --noEmit                   # typecheck backend ทั้งหมด — ต้องผ่าน
npm --prefix frontend run lint     # eslint ของ admin
npm --prefix frontend run build    # typecheck + build admin
```

**ไม่มี unit test suite** (`npm test` เป็น stub) — typecheck + `scripts/diag/*` คือด่านตรวจหลัก

**ด่านที่เป็น gate: รันทั้งก่อนและหลังแล้วเทียบผล** ตัวเลขที่เท่ากันคือหลักฐาน ตัวเลขที่ดีขึ้น
ต้องอธิบายได้ว่าดีขึ้นเพราะอะไร

| แตะอะไร | gate |
| --- | --- |
| การจับคู่ลูกค้า | `npm run diag:customer-search` (เทียบ baseline — **ห้าม `--refresh-corpus` ตอนเทียบ**) และ `tsx scripts/evalCustomerSearch.ts` (54 เคส · `wrong-auto-select` ต้องเป็น 0 · **ห้าม `--mine` ตอนเทียบ**) |
| อะไรที่เกี่ยวกับวันที่ | `npm run diag:date-filter` |
| flow ยืนยัน / การออกเลขใบ | `npm run diag:confirm-race` (ต้องเปิด server ก่อน) |
| กฎสต็อก / validation ของใบ | `npm run diag:stock-rule` · `diag:stock-rule-put` · `diag:quote-validation` |
| ชื่อลูกค้า / ส่งออก Odoo | `npm run diag:odoo-export` — ถ้าขึ้น `(ตรวจ 0 ชื่อ)` แปลว่าด่านผ่านแบบว่างเปล่า อย่าเชื่อ |
| กฎเครดิต | `npm run diag:credit-hold` (read-only รันกับ prod ได้) |
| `prompt` ของการสกัด / Flex | `npm run diag:line-parity` |
| หน้าเว็บขอใบเสนอราคา | `npm run diag:web-quote` · `diag:pdf-issuer` · `diag:sp-dedupe` |
| สินค้าพ่วง / กฎบล็อก | `npm run diag:optional-pair` · `diag:block-rule` · `diag:block-parity` |
| คิว / งบเวลาตอบ | `npm run diag:queue-sim` · `diag:load-probe` · `diag:abort-check` · `diag:shutdown-check` |
| PDF | `npm run diag:pdf-render` · `diag:pdf-cache` |
| ค่าขนส่ง · api_logs · sync API · `APP_URL` | `diag:shipping-fee` · `diag:api-log` · `diag:sync-api` · `diag:app-url` |

รายการเต็มอยู่ใน `package.json` (46 ไฟล์ใน `scripts/diag/`)

---

## 7. หน้าตาของแอปเป็นของเจ้าของ

**ห้ามเขียนโค้ด UI ก่อนได้คำยืนยัน** — ลำดับห้าขั้นและเช็กลิสต์ก่อนบอกว่าจอเสร็จอยู่ใน
`docs/design.md` เงียบไม่ใช่โอเค และตอบเรื่องใกล้เคียงก็ไม่ใช่โอเค

**responsive คือครึ่งหนึ่งของดีไซน์ ไม่ใช่งานเก็บตอนท้าย** — LIFF เปิดบนมือถือเป็นหลัก
Admin Portal เปิดบนจอทำงาน และ PDF ออกมาเป็นกระดาษ A4 ทั้งสามความกว้างต้องถูกดูจริงในรอบเดียวกัน
