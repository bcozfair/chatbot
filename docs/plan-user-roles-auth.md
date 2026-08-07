# แผนงาน: ระบบผู้ใช้และสิทธิ์ (Auth & Roles) — Admin Portal

> สถานะ: **ทุกเฟสเขียนโค้ดเสร็จแล้ว** — เฟส 4 รอ deploy ขึ้น production (migration รันบน DB จริงไปแล้ว ไม่มี migration ใหม่หลังจากนั้น)
> §4.3-4.4 ถูกเขียนใหม่ 2026-08-06 หลังสำรวจโค้ดรอบสอง — เดิมออกแบบเป็น "3 ด่านใหม่ + throw" ซึ่ง**กันไม่ครบและตอบข้อความผิด** เปลี่ยนเป็นต่อยอด `validateQuotationItems` ที่มีอยู่แล้ว
> §4.3.1 เพิ่ม 2026-08-07 หลังพบว่าบล็อกหลุดเพราะ Odoo แตกนิติบุคคลเดียวกันเป็นหลาย `company_id`/`contact_id` — **อ่านก่อนแตะ `blacklistService.ts` ทุกครั้ง** มีทั้งกติกาการขยายและรูปแบบ SQL ที่บังคับ
> อ่านไฟล์นี้ก่อนเริ่มงานทุกครั้ง แล้วอัปเดตช่อง "สถานะ" ของแต่ละเฟสเมื่อทำเสร็จ

---

## 1. เป้าหมาย

| ต้องการ | รายละเอียด |
| --- | --- |
| เปลี่ยนรหัสผ่านได้ | ✅ ทำแล้ว — ปุ่มรูปกุญแจข้างปุ่มออกจากระบบ |
| role `admin` | ✅ ทำแล้ว — เมนู "จัดการผู้ใช้งานระบบ" เพิ่ม/ลบ/แก้/เปลี่ยนสิทธิ์/ตั้งรหัสให้คนอื่น |
| role `user` | ✅ สิทธิ์บังคับใช้แล้ว · เมนูของตัวเอง (blacklist) มาพร้อมเฟส 4 |
| blacklist | ☐ ออกแบบจบแล้ว (§เฟส 4) รอลงมือ — บล็อกไม่ให้ออกใบเสนอราคาให้บริษัท/ผู้ติดต่อที่ถูกขึ้นบัญชี |

---

## 2. สถานะปัจจุบัน (สำรวจจากโค้ดจริง 2026-08-06)

### 2.1 สิ่งที่มีอยู่แล้ว

* ตาราง `admin_users` — [`migrations/schema.sql:48`](../migrations/schema.sql#L48)
  คอลัมน์: `id, username, password_hash, name, role, created_at, updated_at`
  **มีคอลัมน์ `role` อยู่แล้ว** (`varchar(20)` default `'admin'`) แต่**ไม่มี CHECK constraint** — ใส่ค่าอะไรก็ได้
* Login ตรวจรหัสด้วย bcrypt แล้วออก JWT อายุ 24 ชม. — [`index.ts:1410`](../index.ts#L1410)
  **JWT payload มี `role` อยู่แล้ว** (`{ id, username, name, role }`)
* `adminAuthMiddleware` — [`config/auth.ts:15`](../config/auth.ts#L15)
* ฝั่ง frontend `AdminUser` มีฟิลด์ `role` แล้ว — [`frontend/src/context/AuthContext.tsx:4`](../frontend/src/context/AuthContext.tsx#L4)

> สรุป: **ท่อของ role วางครบแล้วตั้งแต่ DB ถึง frontend** งานที่เหลือคือ "ทำให้มันมีผลจริง"

### 2.2 ช่องโหว่ที่ปิดไปแล้ว (เฟส 2)

เดิม **`adminAuthMiddleware` เช็คแค่ว่า token ถูกต้อง ไม่เคยอ่าน `role` เลย**
ถ้าเพิ่ม user role `'user'` ตอนนั้น คนนั้นจะยิง `/api/admin/*` ได้ทุกเส้น — ลบพนักงาน ลบโปรโมชัน สั่ง sync ใหม่ ได้หมด
การซ่อนเมนูฝั่ง React ไม่ช่วยอะไร เพราะเรียก API ตรงได้ → เฟส 2 จึงเป็นเงื่อนไขบังคับก่อนสร้าง user คนแรก

### 2.3 สิ่งที่ยังไม่มี

* ไม่มี blacklist บริษัท/ผู้ติดต่อ (เฟส 4)
  (คำว่า "บล็อกห้ามเสนอราคา" ใน [`QuotationRules.tsx:1043`](../frontend/src/admin/QuotationRules.tsx#L1043) เป็นระดับ **สินค้า** — `products.is_locked` คนละเรื่องกัน)

---

## 3. ข้อตัดสินใจที่ล็อกแล้ว

### 3.1 โมเดลสิทธิ์: role ตายตัว 2 แบบ

ไม่ทำตาราง permission ต่อคน ใช้ `admin_users.role` ที่มีอยู่ + ตารางค่าคงที่ในโค้ดที่เดียว

```ts
// config/auth.ts (backend) และ frontend/src/context/AuthContext.tsx (frontend) — ต้องตรงกันเสมอ
export type Role = 'admin' | 'user';
```
เก็บ type ไว้คู่กับ `requireRole` ใน `config/auth.ts` แทนการแยกไฟล์ `permissions.ts` ตามที่เคยร่างไว้ — มีแค่ type เดียว ไม่คุ้มกับไฟล์ใหม่
ฝั่ง DB มี CHECK constraint `admin_users_role_check` เป็นด่านสุดท้าย ใส่ค่าอื่นไม่ผ่านแม้จะเลี่ยง API ได้

เหตุผล: มีแค่ 2 role และเส้นแบ่งชัด ("ทุกอย่าง" กับ "blacklist อย่างเดียว") การทำ permission ต่อคนตอนนี้คือเพิ่มตาราง + UI ติ๊ก + งานอีก 2 เท่า โดยยังไม่มีเคสใช้จริง
วันหน้าถ้าต้องการ role ที่ 3 — เพิ่มค่าใน union แล้วไล่ `requireRole` ตามจุด ไม่ต้อง migrate ข้อมูล

### 3.2 การจัดการรหัสผ่าน — **ไม่ใช้ .env**

เคยพิจารณาให้ `.env` seed บัญชีแอดมินตอนบูต แต่**ตัดทิ้งแล้ว** เหตุผล: ต้องเขียนโค้ด bootstrap เพิ่ม, รหัส plaintext ค้างในไฟล์ตลอด, ต้อง restart ทุกครั้งที่แก้ และมีกับดักว่า seed จะทับรหัสที่เปลี่ยนผ่าน UI ทุกครั้งที่ `docker compose up -d`
ข้อดีเดียวคือ deploy บนเครื่องเปล่าแล้วมี admin อัตโนมัติ ซึ่งไม่คุ้มกับระบบที่มีเครื่องเดียวและต่อ DB ตรงได้อยู่แล้ว ([`docker-compose.override.yml`](../docker-compose.override.yml) publish `127.0.0.1:5432` ไว้สำหรับ VSCode DB extension)

| กรณี | ใช้อะไร |
| --- | --- |
| เปลี่ยนรหัสผ่านของตัวเอง | UI (ทุก role) — เฟส 1 |
| เพิ่ม/ลบ/แก้ user, เปลี่ยน role, รีเซ็ตรหัสคนอื่น | UI (admin เท่านั้น) — เฟส 3 |
| ลืมรหัส admin จนเข้าไม่ได้ / ยังไม่มี admin เลย | SQL ผ่าน DB extension (§3.3) |

### 3.3 วิธีกู้คืน/ตั้งรหัสผ่านด้วย SQL

**พิมพ์รหัสผ่านดิบลงคอลัมน์ `password_hash` ไม่ได้** — login ใช้ `bcrypt.compare()` ([`index.ts:1428`](../index.ts#L1428)) เทียบกับค่าที่ต้องเป็น bcrypt hash เท่านั้น ใส่ค่าดิบไปจะได้ `false` เสมอ

ใช้ `pgcrypto` ของ Postgres สร้าง hash ได้ในตัว (ติดตั้งใน DB นี้อยู่แล้ว — [`schema.sql:37`](../migrations/schema.sql#L37))

```sql
-- เปลี่ยนรหัสผ่าน
UPDATE admin_users
SET password_hash = crypt('รหัสใหม่', gen_salt('bf', 10)),
    updated_at = CURRENT_TIMESTAMP
WHERE username = 'admin';

-- สร้าง admin คนแรกตอน DB ว่าง
INSERT INTO admin_users (username, password_hash, name, role)
VALUES ('admin', crypt('รหัสใหม่', gen_salt('bf', 10)), 'ผู้ดูแลระบบ', 'admin');
```

> **ยืนยันแล้วว่าใช้ด้วยกันได้จริง** (ทดสอบ 2026-08-06): `gen_salt('bf', 10)` ให้ hash ขึ้นต้น `$2a$` ซึ่ง `bcryptjs` ของแอปตรวจผ่าน — รหัสถูกได้ `true` รหัสผิดได้ `false`
> `bf` = Blowfish คือชื่อที่ pgcrypto ใช้เรียก bcrypt · เลข `10` คือ cost — ค่านี้ฝังอยู่ในตัว hash แล้ว จึงไม่จำเป็นต้องตรงกับที่โค้ดใช้ แต่ควรใช้ค่าเดียวกันทั้งระบบเพื่อความสม่ำเสมอ
> ระวัง: รหัสผ่านปรากฏเป็น plaintext ในตัว SQL ที่พิมพ์ — อย่าเซฟไฟล์ `.sql` ทิ้งไว้ และล้าง query history

---

## 4. เฟสงาน

### เฟส 1 — เปลี่ยนรหัสผ่านตัวเอง

**สถานะ:** ✅ เสร็จ 2026-08-06 — migration รันบน DB จริงแล้ว
**ความเสี่ยง:** ต่ำ — ไม่แตะพฤติกรรมเดิม

**1.1 migration** `migrations/changes/2026-08-06_01_admin_users_roles.sql`
```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

UPDATE admin_users SET role = 'admin' WHERE role NOT IN ('admin', 'user');

ALTER TABLE admin_users
  ADD CONSTRAINT admin_users_role_check CHECK (role IN ('admin', 'user'));
```
> `pgcrypto` ติดตั้งใน DB นี้อยู่แล้ว บรรทัด `CREATE EXTENSION IF NOT EXISTS` ใส่ไว้เพื่อให้ DB ที่ตั้งใหม่ได้ครบเหมือนกัน (§3.3)
> `UPDATE` ต้องมาก่อน `ALTER` ไม่งั้นถ้ามีแถวค่าเพี้ยนอยู่ ALTER จะล้มทั้งไฟล์
> รันผ่าน `tsx scripts/runMigration.ts` เท่านั้น (ห้ามแก้ DB ด้วยมือ — AGENTS.md §5)

**1.2 endpoint เปลี่ยนรหัสตัวเอง** `POST /api/admin/change-password` (ผ่าน `adminAuthMiddleware` ทุก role ใช้ได้)
* body: `{ currentPassword, newPassword }`
* ต้อง `bcrypt.compare` รหัสเดิมก่อนเสมอ — token ที่ถูกขโมยจะได้เปลี่ยนรหัสไม่ได้
* ใช้ `req.admin.id` เป็นตัวระบุคน **ห้ามรับ id จาก body** (ไม่งั้นเปลี่ยนรหัสคนอื่นได้)
* กติการหัสใหม่: อย่างน้อย 8 ตัว และต้องไม่ซ้ำรหัสเดิม

**1.3 UI** — ฟอร์มเปลี่ยนรหัสผ่าน วางที่แถบผู้ใช้ท้าย sidebar ([`AdminApp.tsx:292-321`](../frontend/src/admin/AdminApp.tsx#L292)) ซึ่งแสดงชื่อ/role/ปุ่มออกจากระบบอยู่แล้ว — เพิ่มปุ่ม "เปลี่ยนรหัสผ่าน" ข้างปุ่ม logout เปิดเป็น modal
เปลี่ยนสำเร็จ → เรียก `logout()` ให้ล็อกอินใหม่ ชัดเจนกว่าปล่อย token เดิมค้าง

**1.4 เอกสาร** — เพิ่มหัวข้อ "ตั้ง/กู้รหัสผ่านด้วย SQL" (เนื้อหาจาก §3.3) ลง [`DEPLOY.md`](../DEPLOY.md) เพื่อให้หาเจอตอนล็อกตัวเองออกจริง ๆ

**Verify:** `npx tsc --noEmit` · `npm --prefix frontend run build` · ทดสอบมือ:
1. เปลี่ยนรหัสผ่านผ่าน UI → ถูกเด้งออก → ล็อกอินด้วยรหัสใหม่ได้ รหัสเก่าใช้ไม่ได้
2. ส่ง `currentPassword` ผิด → ต้องได้ 400/401 ไม่ใช่เปลี่ยนสำเร็จ
3. ตั้งรหัสด้วย SQL ตาม §3.3 → ล็อกอินด้วยรหัสนั้นได้จริง

---

### เฟส 2 — บังคับใช้สิทธิ์ฝั่ง server

**สถานะ:** ✅ เสร็จ 2026-08-06 — ใส่ `requireRole('admin')` ครบทั้ง 45 เส้น
**ความเสี่ยง:** สูง — แตะทุก endpoint ของ admin ถ้าพลาดคือแอดมินใช้งานไม่ได้

**2.1** `config/auth.ts` — เปลี่ยน `AdminRequest.admin.role` จาก `string` เป็น `Role` เพื่อให้ TS จับตอน compile
พร้อมกันนั้น `adminAuthMiddleware` เปลี่ยนไปอ่านข้อมูลผู้ใช้สดจาก DB แทนการเชื่อ payload ใน JWT (เหตุผลใน §5.1)

**2.2** middleware ใหม่ `requireRole(...roles: Role[])` ใน `config/auth.ts`
ใช้ต่อจาก `adminAuthMiddleware` เสมอ (อ่าน `req.admin` ที่ตัวแรกเซ็ตไว้) → ไม่ผ่านตอบ `403` พร้อมข้อความไทย

**2.3 ไล่ใส่ทุก endpoint — default คือ admin เท่านั้น**
วิธีที่ปลอดภัย: ใส่ `requireRole('admin')` ให้ทุกเส้นก่อน แล้วค่อยถอดออกเฉพาะเส้นที่ user ต้องใช้จริง
(ไล่ "ปิดทีละอัน" มีโอกาสลืมแล้วเปิดช่องทิ้งไว้ ไล่ "เปิดทีละอัน" ถ้าลืมแค่ใช้งานไม่ได้ ซึ่งเห็นทันที)

**ตารางสิทธิ์เป้าหมาย** (endpoint ทั้งหมดใน `/api/admin/*` ณ วันเขียนแผน):

| Endpoint | admin | user |
| --- | :---: | :---: |
| `POST /api/admin/login` | — ไม่ต้อง auth — | |
| `GET /api/admin/verify` | ✓ | ✓ |
| `POST /api/admin/change-password` *(เฟส 1)* | ✓ | ✓ |
| `GET/POST/PUT/DELETE /api/admin/users*` *(เฟส 3)* | ✓ | ✗ |
| `GET /api/admin/customers/search` | ✓ | ✗ *(จะเปิดให้ user ตอนทำเฟส 4)* |
| `GET/POST/PUT/DELETE /api/admin/blacklist*` *(เฟส 4 ยังไม่ทำ)* | ✓ | ✓ |
| `POST /api/admin/signatures/upload` · `DELETE /api/admin/signatures/:id` | ✓ | ✗ |
| `GET/PUT/DELETE /api/admin/salespersons*` | ✓ | ✗ |
| `GET /api/admin/stats` | ✓ | ✗ |
| `GET /api/admin/sync/status` · `POST /api/admin/sync/run` · `PUT /api/admin/sync/settings` | ✓ | ✗ |
| `/api/admin/promotions*` (7 เส้น รวม export/import) | ✓ | ✗ |
| `/api/admin/quotation-rules*` (5 เส้น) | ✓ | ✗ |
| `/api/admin/shipping-fee-config` (2 เส้น) | ✓ | ✗ |
| `GET /api/admin/products/search` · `GET /api/admin/customers/types` | ✓ | ✗ |
| `/api/admin/quotations*` (5 เส้น รวม export/export-batches) | ✓ | ✗ |
| `/api/admin/optional-links*` (4 เส้น) | ✓ | ✗ |
| `/api/admin/stock-rules*` (6 เส้น) | ✓ | ✗ |
| `/api/admin/moq-rules*` (4 เส้น) | ✓ | ✗ |

> endpoint นอก `/api/admin/*` (เส้นของ LIFF/บอท เช่น `/api/quotations`, `/api/customers/search`) ไม่เกี่ยวกับ role — ใช้ LINE access token คนละระบบ ห้ามไปแตะ

**Verify:** `npx tsc --noEmit` · ทดสอบมือ: ล็อกอินเป็น `user` แล้ว `curl` ยิง endpoint ฝั่ง admin ต้องได้ `403` ทุกเส้น · ล็อกอินเป็น admin ต้องใช้งานได้ครบเหมือนเดิม (ไล่กดทุกหน้า)

---

### เฟส 3 — UI จัดการ user (เห็นเฉพาะ admin)

**สถานะ:** ✅ เสร็จ 2026-08-06 — `frontend/src/admin/Users.tsx`

**3.1 API** — ทุกเส้นผ่าน `adminAuthMiddleware` + `requireRole('admin')`

| Method | Path | หมายเหตุ |
| --- | --- | --- |
| GET | `/api/admin/users` | **ห้าม select `password_hash` ออกไป** |
| POST | `/api/admin/users` | สร้าง: `username, password, name, role` |
| PUT | `/api/admin/users/:id` | แก้ `name` / `role` |
| PUT | `/api/admin/users/:id/password` | admin รีเซ็ตรหัสคนอื่น (ไม่ต้องรู้รหัสเดิม) |
| DELETE | `/api/admin/users/:id` | |

**กฎกันพลาด — ต้องเช็คฝั่ง server ทุกข้อ:**
* ห้ามลบตัวเอง / ห้ามลดสิทธิ์ตัวเองจาก `admin` เป็น `user`
* ห้ามลบหรือลดสิทธิ์ **admin คนสุดท้าย** (เช็คด้วย `SELECT count(*) ... WHERE role='admin'` ใน transaction เดียวกับคำสั่งแก้ ไม่งั้นสองคนกดพร้อมกันแล้วเหลือศูนย์)
* `username` ซ้ำไม่ได้ (มี unique constraint อยู่แล้ว — ดักให้ตอบข้อความไทยแทน error 500)
* รหัสผ่านใหม่ ≥ 8 ตัว

**3.2 UI** — `frontend/src/admin/Users.tsx` + เพิ่มใน `NAV_ITEMS` ของ [`AdminApp.tsx:50`](../frontend/src/admin/AdminApp.tsx#L50)
กรองเมนูตาม `user.role` จาก `useAuth()` — **ย้ำว่าเป็นแค่ UX ตัวกันจริงคือเฟส 2**

**Verify:** `npm --prefix frontend run lint` · `npm --prefix frontend run build` · ทดสอบมือ: ลอง ลบตัวเอง / ลบ admin คนสุดท้าย / ตั้ง username ซ้ำ → ต้องโดนปฏิเสธพร้อมข้อความไทยที่อ่านรู้เรื่อง

---

### เฟส 4 — Blacklist บริษัท/ผู้ติดต่อ

**สถานะ:** ✅ เขียนโค้ดครบทุกขั้นแล้ว 2026-08-06 · migration รันบน DB จริงแล้ว · **ยังไม่ deploy** (โค้ดในคอนเทนเนอร์ที่รันอยู่ยังเป็นตัวเก่า)
**ความเสี่ยง:** ปานกลาง — แตะ flow ใบเสนอราคาที่ใช้งานจริงอยู่ จึงออกแบบให้ "เพิ่มด่าน" ไม่ใช่ "แก้ของเดิม"

#### 4.0 ข้อสรุปที่เคาะแล้ว

| ประเด็น | ข้อสรุป |
| --- | --- |
| แนวทาง | **แผน B — กันที่ปลายทาง + เตือนตั้งแต่ต้นทาง** |
| ใบที่ยืนยันไปแล้วก่อนถูกขึ้นบัญชี | ปล่อยไว้เฉย ๆ ไม่ย้อนหลัง ไม่แตะ |
| ร่างที่ค้างอยู่ตอนถูกขึ้นบัญชี | แก้ไขต่อได้ แต่กดยืนยันไม่ผ่าน |
| ระดับการบล็อก | ทั้ง "ทั้งบริษัท" และ "เฉพาะผู้ติดต่อบางคน" |
| ข้อความที่เซลล์เห็น | `บริษัท/ผู้ติดต่อ รายนี้ถูกระงับการเสนอราคา กรุณาติดต่อแอดมิน` (ไม่บอกเหตุผลที่แอดมินกรอก) |
| สร้างร่างใหม่ให้ลูกค้าที่ถูกบล็อก | บล็อกด้วย |

#### 4.1 หลักการออกแบบ — แยกส่วน ไม่แตะของเดิม

**ห้ามใส่ `is_blocked` ลง `customers_data_view`**

> ⚠️ แก้ข้อมูลผิด 2026-08-06: หัวข้อนี้เคยเขียนว่า `customers_data_view` เป็น MATERIALIZED VIEW ที่ถูก `REFRESH ... CONCURRENTLY`
> **ไม่จริงแล้ว** — ตั้งแต่ [`2026-08-06_01_customers_data_fast_refresh.sql`](../migrations/changes/2026-08-06_01_customers_data_fast_refresh.sql) มันเป็น **ตารางจริง** ที่ sync สร้างใหม่ทั้งก้อนแบบ build+swap
> (`CREATE TABLE ..._new AS SELECT * FROM customers_data_build` → `DROP TABLE` ตัวเก่า → `RENAME` ใน transaction เดียว — [`refreshCustomerDirectory.ts`](../scripts/sync/refreshCustomerDirectory.ts))
> และ plain view `customers_data` ที่เคยครอบอยู่ถูกลบทิ้งแล้วใน [`2026-08-06_02`](../migrations/changes/2026-08-06_02_drop_customers_data_view_wrapper.sql)
> นิยามของข้อมูลย้ายไปอยู่ที่ **view `customers_data_build`** แทน

ข้อสรุป "ห้ามใส่คอลัมน์" ยังเหมือนเดิม แต่เหตุผลเปลี่ยน:

* **ตารางถูก `DROP` แล้วสร้างใหม่ทุกรอบ sync** — คอลัมน์ที่เติมด้วย `ALTER TABLE` หายเกลี้ยงรอบถัดไป
* ถ้าเลี่ยงด้วยการ blend blacklist เข้าไปใน `customers_data_build` แทน (ซึ่งอยู่รอด rebuild) จะเจอข้อที่ตัดทิ้งได้ทันที: **ค่าที่แอดมินกดบล็อกไม่มีผลจนกว่า sync รอบถัดไปจะ rebuild** — ผิดข้อ 5 ของทดสอบมือใน §4.8 ที่ต้องการให้ลบออกจากบัญชีแล้วใช้ได้ทันที
* build+swap ถือ `AccessExclusiveLock` ตอนสลับตาราง — งานที่ทำให้ขั้นตอนนี้หนักขึ้นกระทบทุกคนที่กำลังค้นหาลูกค้าอยู่

**อีกผลหนึ่งของการเป็น build+swap:** ตารางนี้ถูก `DROP` เป็นรอบ ๆ → **สร้าง FK ชี้ไปหามันไม่ได้เลย** (FK จะบล็อก `DROP TABLE` ทั้งรอบ sync) เป็นเหตุผลเพิ่มที่ยืนยันว่า `quotation_blacklist` ต้องเก็บ id ดิบตาม §4.2 การอ่านชื่อทำด้วย `LEFT JOIN` ตอน query เท่านั้น

**ห้ามกรอง blacklist ในการค้นหา** — ต้อง JOIN blacklist เข้า query ค้นหา = แตะ logic ที่ทำงานดีอยู่แล้ว และเซลล์จะงงว่าทำไมหาบริษัทที่มีอยู่จริงไม่เจอ
ให้ "ค้นเจอได้ แต่ยืนยันไม่ได้" แทน แล้วติดป้ายเตือนที่ผลลัพธ์

**ความรู้เรื่อง blacklist อยู่ในไฟล์เดียว** — `services/blacklistService.ts` จุดอื่นเรียกใช้ฟังก์ชัน ไม่มีใครรู้จักโครงสร้างตารางนอกจากไฟล์นี้

#### 4.2 ตารางใหม่

`migrations/changes/2026-08-06_03_quotation_blacklist.sql`

```sql
CREATE TABLE public.quotation_blacklist (
  id           serial PRIMARY KEY,
  company_id   integer NOT NULL,
  contact_id   integer,                -- NULL = บล็อกทั้งบริษัท
  reason       text,                   -- บันทึกไว้ให้แอดมินอ่านกันเอง ไม่แสดงให้เซลล์
  created_by   integer REFERENCES public.admin_users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- กันเพิ่มซ้ำ: NULL ไม่ชนกันเองใน unique index ปกติ จึงต้องแยกเป็น 2 ตัว
CREATE UNIQUE INDEX quotation_blacklist_company_uniq
  ON public.quotation_blacklist (company_id) WHERE contact_id IS NULL;
CREATE UNIQUE INDEX quotation_blacklist_contact_uniq
  ON public.quotation_blacklist (company_id, contact_id) WHERE contact_id IS NOT NULL;
```

> **ไม่ใส่ FK ไป `customers`** เพราะตารางนั้นถูก sync ทับจาก Odoo เป็นรอบ FK จะทำให้ sync ล้มหรือ blacklist หายโดยไม่ตั้งใจ — เก็บ id ดิบไว้แล้ว join ตอนอ่านเพื่อโชว์ชื่อ
> **`created_by` มี FK ไป `admin_users`** ได้ เพราะเป็นข้อมูลของระบบเราเอง ไม่ถูก sync ทับ · `ON DELETE SET NULL` = ลบผู้ใช้แล้วรายการ blacklist ยังอยู่

#### 4.3 โมดูลใหม่ `services/blacklistService.ts`

ไฟล์นี้ถือ**ความรู้เรื่องตาราง** อย่างเดียว — ไม่มีข้อความ ไม่มีการตัดสินใจว่าจะบล็อกที่ไหน

```ts
/** บล็อกถ้าเจอแถวระดับบริษัท (contact_id IS NULL) หรือแถวที่ตรงทั้ง company + contact */
export async function isBlacklisted(companyId, contactId): Promise<boolean>

/** ใช้ติดป้ายในผลค้นหา — คืน Set ของ company_id ที่ถูกบล็อกทั้งบริษัท (query เดียว ไม่ยิงทีละแถว) */
export async function findBlockedCompanyIds(companyIds: number[]): Promise<Set<number>>

/** ใช้ติดป้ายในรายชื่อผู้ติดต่อของบริษัทเดียว — คืน "รหัสผู้ติดต่อของบริษัทที่ถาม" เท่านั้น */
export async function findBlockedContacts(companyId): Promise<{ wholeCompany, contactIds }>

/** พรีวิวฝั่งแอดมิน — กดครั้งนี้แล้วครอบรหัสบริษัทไหน / คู่บริษัท–ผู้ติดต่อคู่ไหนบ้าง */
export async function listRelatedCompanies(companyId): Promise<RelatedCompany[]>
export async function listRelatedContacts(companyId, contactId): Promise<RelatedContact[]>
```

> `contact_id = 0` ในระบบนี้แปลว่า "แถวบริษัทที่ไม่มีผู้ติดต่อ" ([`repositories.ts:128`](../db/repositories.ts#L128)) — `isBlacklisted` ต้อง normalize `0 → null` ก่อนเทียบ ไม่งั้นจะหลุดทั้ง unique index และ logic "บล็อกทั้งบริษัท"
> **ไม่ต้องรับ `executor`** ตามที่เคยร่างไว้ เพราะด่านยืนยันทำงานนอก transaction เหมือนกฎอื่นทุกตัวอยู่แล้ว (เหตุผลใน §4.4)

##### 4.3.1 การขยาย "เป็นรายเดียวกัน" — เทียบ id ตรง ๆ ไม่พอ (แก้ 2026-08-07)

**อาการที่เจอจริง:** แอดมินบล็อก `company_id = 1` แต่เซลล์ออกใบด้วย `company_id = 969120` ได้ — เป็นนิติบุคคลเดียวกันที่ Odoo แตกเป็นหลายรหัส

| สิ่งที่วัดจากข้อมูลจริง | ตัวเลข |
| --- | ---: |
| เลขภาษีที่ผูกกับ `company_id` มากกว่า 1 ตัว | 2,021 เลข ครอบ 4,929 รหัส (มากสุด 50 รหัส/นิติบุคคล) |
| ชื่อผู้ติดต่อเดียวกันโผล่ใต้หลาย `company_id` ในนิติบุคคลเดียวกัน | 1,081 เคส — **ทุกเคส `contact_id` ต่างกันหมด** |
| `company_id` ที่ไม่มีเลขภาษีเลย | 20,040 รหัส |
| ผู้ติดต่อที่ไม่มีชื่อ หรือชื่อเป็น `'none'` | 8,168 จาก 81,994 แถว |

**กติกาที่ใช้** — เก็บ `id` เป็นตัวยึด (รู้ว่าแอดมินกดอะไร ตรวจย้อนหลังได้) แล้วใช้**ชื่อเป็นตัวขยาย**:
* **ชั้นบริษัท** — เลขผู้เสียภาษี / รหัสอ้างอิง / ชื่อบริษัท ตรงข้อใดข้อหนึ่ง = รายเดียวกัน
* **ชั้นผู้ติดต่อ** — ชื่อผู้ติดต่อตรงกัน **ภายในกลุ่มบริษัทข้างบนแล้วเท่านั้น** (ชื่อคนซ้ำข้ามบริษัทเป็นเรื่องปกติมาก)

**ทำไมไม่คีย์ด้วย `customer_name` + `contact_name` แทน id ไปเลย** — มี 1,942 กลุ่มเลขภาษีที่ชื่อบริษัทเขียนไม่ตรงกัน (เติม "จำกัด" บ้าง เว้นวรรคต่างบ้าง) ทิ้ง `tax_id`/`reference` ไปจะกลับมาหลุดมากกว่าบั๊กเดิม และชื่อถูกแก้ใน Odoo ได้ตลอด วันที่มีคนแก้ชื่อ บล็อกจะเลิกทำงานเงียบ ๆ ไม่มี error ให้เห็น

**ทำไมไม่คลี่เป็นแถวคู่ `(company_id, contact_id)` ตอนกดบันทึก** — เร็วกว่าจริง (เหลือ index lookup ล้วน) แต่ `customers_data_view` ถูกสร้างใหม่ทุกรอบ sync และ Odoo แตกรหัสใหม่เรื่อย ๆ snapshot จะไม่มีรหัสที่เกิดทีหลัง = ปลุกบั๊กเดิมกลับมาในรูปที่หน้าจอยังโชว์ว่า "ครอบ N รหัส" ให้ดูน่าเชื่อถือ

**⚠️ กับดักที่ต้องคงไว้**
* ค่าว่างห้าม match กันเอง — ทุกเงื่อนไขผ่าน `NULLIF(TRIM(...),'')` และคัดทิ้งก่อนเทียบ ไม่งั้น 20,040 รหัสไร้เลขภาษีจะโดนเหมารวด
* `'none'` คือค่าที่ Odoo ใส่แทนผู้ติดต่อไร้ชื่อ ต้องคัดออกเหมือนค่าว่าง
* `findBlockedContacts` ต้องคืน**รหัสผู้ติดต่อของบริษัทที่ถาม** ห้ามคืน `contact_id` ในบัญชีดำดิบ ๆ — รายการอาจถูกบันทึกใต้รหัสพี่น้องคนละตัว แล้วป้ายจะไม่ขึ้นทั้งที่โดนบล็อกจริง
* เกณฑ์ "ชื่อ" ครอบกว้าง (151 ชื่อบริษัทผูกหลายรหัสโดยไม่มีเลขภาษีเลย เช่น `คุณไก่` = 4 รหัสคนละคน) → หน้าแอดมิน**ต้อง**โชว์ว่าจะครอบอะไรก่อนกดบันทึก

**รูปแบบ SQL ที่บังคับ** — ยุบคีย์ของบริษัทเป็น `array` ด้วย index scan แล้วเทียบด้วย `&&` / `= ANY(...)`
เคยเขียนเป็น `cdv q JOIN cdv t ON (เงื่อนไขตรงกัน)` แล้ว planner **ตัดความสัมพันธ์กับตาราง blacklist ทิ้ง** เปลี่ยน `EXISTS` เป็น hashed SubPlan ที่ต้อง scan cdv ทั้ง 82k แถวก่อนเสมอ → **1,091 ms** · รูปแบบปัจจุบันทุกขั้นเป็น index scan → **1.6 ms อ่าน 28 buffers** (ของเดิม 9,367)
CTE `bl` ต้องเป็น `CROSS JOIN LATERAL` เท่านั้น เพราะ `LATERAL` บังคับให้ `c.company_id = b.company_id` เป็น index cond planner แปลงเป็น hashed subplan ไม่ได้

**เวลาที่วัดได้** — `isBlacklisted` 1.6 ms · `findBlockedContacts` 2 ms · `findBlockedCompanyIds` (30 รหัส) 2 ms · `listBlacklist` 1 ms · `listRelatedContacts` 41 ms · `listRelatedCompanies` 67 ms
สองตัวหลังอยู่ในหน้าแอดมินเท่านั้น ไม่อยู่ในเส้นทางแชท — คำถาม "มีใครบ้าง" ไม่มี index รองรับ ต้อง scan cdv รอบเดียว จึงห้ามเอาไปนับความครอบในหน้ารายการ (เคยลองแล้วได้ 2.7 วิ และ 12.5 วิ)

#### 4.4 ด่านบังคับใช้ — ต่อยอดด่านตรวจกฎเดิม ไม่สร้างด่านใหม่

**ระบบมี "จุดรวมเงื่อนไขการออกใบเสนอราคา" อยู่แล้ว** คือ [`validateQuotationItems()`](../services/quotationService.ts#L971) → `Violation[]` → [`buildViolationDisplay()`](../services/quotationService.ts#L48) ("ถ้อยคำเดียวของทั้งระบบ") ปัจจุบันถือ 5 เงื่อนไข (`BLOCKED`, `OUT_OF_STOCK`, `MOQ_VIOLATION`, `MIN_PRICE_VIOLATION`, `SYSTEM_ERROR`) และถูกเรียกครบทั้ง 3 stage (`draft` / `save` / `confirm`)

blacklist จึงเข้าเป็น **เงื่อนไขที่ 6 ของด่านเดิม** ไม่ใช่ด่านที่ 4:

1. `Violation['type']` เพิ่ม `'CUSTOMER_BLACKLISTED'`
2. `buildViolationDisplay` เพิ่ม 1 case → `บริษัท/ผู้ติดต่อ รายนี้ถูกระงับการเสนอราคา กรุณาติดต่อแอดมิน`
3. `validateQuotationItems` รับ `opts.customerId / contactId` เพิ่ม แล้วเรียก `isBlacklisted()`

ผลพลอยได้: **ไม่มี `throw` ไม่มี `BlacklistedCustomerError` ไม่ต้องเพิ่ม `catch` สักจุด** · fail-closed มีอยู่แล้วที่ [`:1016`](../services/quotationService.ts#L1016) · มี smoke test รออยู่ที่ [`scripts/diag/quoteValidationSmoke.ts`](../scripts/diag/quoteValidationSmoke.ts)
และ **เงื่อนไขใหม่ในอนาคต** (ค้างชำระ / เกินวงเงิน / ฯลฯ) = แก้ 3 ที่ในไฟล์เดียว แล้วทุก call site ทั้ง 3 stage ได้ผลทันทีโดยไม่ต้องแตะ

**ทำไมไม่ต้องเช็คใน transaction ของ `confirmQuotationAtomic`** — ด่าน `stage: 'confirm'` ทำงานก่อนเข้า transaction เหมือนกฎราคาขั้นต่ำ/โปรโมชันทุกตัว ตามที่ [`confirmQuotationAtomic` เขียนกำกับไว้เอง](../services/quotationService.ts#L150) ("ต้องเรียกหลัง enrich + ตรวจราคาขั้นต่ำเสร็จแล้ว ทำนอก transaction เพราะจะขอ connection ซ้อนขณะถือ row lock จนตัน") ช่องแข่ง (แอดมินกดบล็อกเสี้ยววินาทีเดียวกับที่เซลล์กดยืนยัน) เป็นช่องเดียวกับที่กฎเดิมมีอยู่แล้ว — ยอมรับตามมาตรฐานเดิมของระบบ

##### จุดที่เขียน `customer_id` / `contact_id` ลง DB — สำรวจจาก SQL ทุกคำสั่ง (2026-08-06)

ไล่จาก `INSERT/UPDATE quotations` ทั้งไฟล์ ไม่ได้ไล่จาก flow (ไล่จาก flow มีโอกาสตกหล่น):

| # | คำสั่งที่เขียนจริง | ปิดด้วย |
| --- | --- | --- |
| 1 | `INSERT INTO quotations` [`quotationService.ts:676`](../services/quotationService.ts#L676) ใน `insertDraftQuotations` | ด่านที่ caller |
| 2 | `UPDATE ... SET customer_id, status='pending_contact'` [`quotationService.ts:1231`](../services/quotationService.ts#L1231) | guard บนสุดของ `resolveContactFlow` |
| 3 | `UPDATE ... SET customer_id, contact_id` [`quotationService.ts:1398`](../services/quotationService.ts#L1398) ใน `updateQuotationCustomerSnapshot` | guard ที่ caller ทั้ง 2 ที่ |
| 4 | `UPDATE ... SET customer_id, contact_id` [`index.ts:945`](../index.ts#L945) ใน `PUT /api/quotation/:id` | ด่าน `stage: 'save'` |

> **จุดที่ 2 คือเหตุผลที่แผนเดิมพลาด** — เป็น `pool.query` ตรง ๆ ใน `resolveContactFlow` ไม่ผ่าน `insertDraftQuotations` เลย การวางด่านไว้ที่ `insertDraftQuotations` อย่างเดียวจึงกันไม่ครบ และ guard ต้องอยู่**บนสุดของฟังก์ชัน ก่อนเขียนอะไรทั้งสิ้น**
> [`lineHandler.ts:1989/2014`](../handlers/lineHandler.ts#L1989) เขียนแค่ `customer_details` (ข้อความที่เซลล์พิมพ์) ไม่มี id และคาสถานะ `pending_*` ไว้ — ไม่ใช่การผูกลูกค้า ไม่ต้องมีด่าน
> **ทางเข้าสถานะ `confirmed` มีทางเดียวจริง** — `SET status='confirmed'` ปรากฏที่ [`quotationService.ts:181`](../services/quotationService.ts#L181) ที่เดียวในโค้ดโปรดักชัน (ที่เหลืออยู่ใน diag script)

##### ผังครอบคลุม — ยืนยันครบทั้ง 3 ทางเข้า

**① เลือกลูกค้าผ่านแชท (พิมพ์ชื่อ)** — ทุกเส้นลงที่ `resolveContactFlow` หมด: สั่งครั้งแรก [`quotationService.ts:1024`](../services/quotationService.ts#L1024) · พิมพ์แก้ตอน `pending_company` [`lineHandler:2039`](../handlers/lineHandler.ts#L2039) · ตอน `pending_contact` [`lineHandler:2089`](../handlers/lineHandler.ts#L2089) · หลังกดเลือกรุ่นสินค้า [`lineHandler:909`](../handlers/lineHandler.ts#L909)
ส่วน revise ([`lineHandler:1441`](../handlers/lineHandler.ts#L1441), [`quotationAgent:123`](../services/quotationAgent.ts#L123)) ปิดด้วยด่าน `stage:'draft'` ที่มีอยู่เหนือมันแล้ว

**② Flex message** — `select_company` [`lineHandler:718`](../handlers/lineHandler.ts#L718) → `resolveContactFlow` · `select_contact` [`lineHandler:813`](../handlers/lineHandler.ts#L813) → **จุดเดียวในระบบที่เรียก `updateQuotationCustomerSnapshot` โดยไม่ผ่าน `resolveContactFlow` จึงต้องมี guard ของตัวเอง** · `confirm` [`lineHandler:596`](../handlers/lineHandler.ts#L596) → ด่าน `stage:'confirm'` ที่ [`:578`](../handlers/lineHandler.ts#L578)

**③ LIFF `quote-edit.html`** — เลือกบริษัท/ผู้ติดต่อ ([`:3222`](../liff_pages/quote-edit.html#L3222), [`:3242`](../liff_pages/quote-edit.html#L3242)) เป็น state ในหน้าเว็บ ยังไม่แตะ DB · กดบันทึก → `PUT /api/quotation/:id` ([`:2983`](../liff_pages/quote-edit.html#L2983)) → ด่าน `stage:'save'` · สร้างใบใหม่ → `POST /api/quotations` ([`:3610`](../liff_pages/quote-edit.html#L3610)) → ด่าน `stage:'draft'` · **หน้านี้ยืนยันเองไม่ได้แล้ว** ([คอมเมนต์ `:1802`](../liff_pages/quote-edit.html#L1802)) ต้องไปกดปุ่มใน Flex

##### รายการแก้ทั้งหมด — 8 จุด

**เติม `customerId`/`contactId` เข้าด่านที่มีอยู่แล้ว 6 จุด** (ไม่เพิ่มด่านใหม่):
[`index.ts:260`](../index.ts#L260) `draft` · [`index.ts:766`](../index.ts#L766) `save` · [`index.ts:1055`](../index.ts#L1055) `confirm` · [`lineHandler:578`](../handlers/lineHandler.ts#L578) `confirm` · [`lineHandler:1416`](../handlers/lineHandler.ts#L1416) `draft` · [`quotationAgent:100`](../services/quotationAgent.ts#L100) `draft`

**guard ใหม่ 2 จุด** (เรียก `isBlacklisted()` ตัวเดียวกัน แล้ว `return { text }` — shape ที่ caller รองรับอยู่แล้วทุกที่ ไม่ต้องแตะ caller):
บนสุดของ [`resolveContactFlow`](../services/quotationService.ts#L1140) · [`lineHandler:813`](../handlers/lineHandler.ts#L813)

**ไม่ต้องแตะ:** [`index.ts:662`](../index.ts#L662) และ [`quotationService:1051/1078/1096/1117`](../services/quotationService.ts#L1051) — ทั้งหมดสร้างใบสถานะ `pending_company` ที่ยังไม่มี id

##### กติกาสำคัญ 3 ข้อ

* **guard ที่ `resolveContactFlow` ไม่ทำให้ร่างเดิมพัง** — ฟังก์ชันนี้ถูกเรียกเฉพาะตอนใบอยู่สถานะ `pending_company`/`pending_contact` ซึ่งยังไม่เคยผูกลูกค้า = เป็นการ "ผูกใหม่" เสมอ ไม่มีเคส false positive
* **ด่าน `save` ต้องบล็อกเฉพาะตอนเปลี่ยนไปเป็นลูกค้ารายใหม่** — LIFF ส่ง `customer_id` มาทุกครั้งที่เซฟ ถ้าบล็อกเหมารวมจะทำให้ร่างที่ค้างอยู่แก้ไขต่อไม่ได้ ขัดกับ §4.0 ข้อ 3
  ตัดสินที่ call site ([`index.ts:766`](../index.ts#L766)) ว่าจะส่ง id เข้าด่านหรือไม่ — **ไม่ยัดเงื่อนไขนี้เข้าด่านกลาง** เพราะเป็นกติกาของ endpoint นั้นเอง
  **⚠️ ต้อง `Number()` ทั้งสองฝั่งก่อนเทียบ** — ค่าจาก body เป็น JSON ส่วนใน DB เป็น `integer` เทียบ `!==` ตรง ๆ จะได้ `'123' !== 123` แล้วบล็อกร่างเดิมที่ควรแก้ต่อได้
* **เช็คครั้งเดียวก่อน loop** — `insertDraftQuotations` สร้างได้หลายใบต่อครั้ง และเส้นทางแชทมีงบเวลา (`deadlineAt` ใน `handleEvent`) ห้ามยิง query รายใบ

#### 4.5 เตือนต้นทาง (ชั้นที่ 2 ของแผน B)

ไม่ใช่ security — เป็นเรื่องไม่ให้เซลล์เสียเวลาทำใบที่ยืนยันไม่ได้

| จุด | ทำอะไร |
| --- | --- |
| ปุ่มยืนยันใน Flex [`flexTemplates.ts:1190`](../utils/flexTemplates.ts#L1190) | ใบที่ผูกลูกค้าที่ถูกบล็อก → ไม่สร้างปุ่ม `action=confirm` แสดงข้อความแทน |
| `GET /api/customers/search` [`index.ts:546`](../index.ts#L546) | เติมฟิลด์ใหม่ `is_blacklisted` ต่อท้ายผลลัพธ์ (annotate หลัง query ด้วย `findBlockedCompanyIds` — **ไม่แตะ SQL ค้นหา**) |
| `GET /api/customer/:id/contacts` [`index.ts:559`](../index.ts#L559) | เติม `is_blacklisted` รายผู้ติดต่อแบบเดียวกัน |
| `liff_pages/quote-edit.html` | ผลค้นหาที่ `is_blacklisted` → ป้ายแดง + กดเลือกไม่ได้ |

การเติมฟิลด์เป็นการ **เพิ่ม** ไม่ใช่แก้ — client เก่าที่ไม่รู้จักฟิลด์นี้ยังทำงานเหมือนเดิม

#### 4.6 API + UI ฝั่งแอดมิน

| Method | Path | สิทธิ์ |
| --- | --- | --- |
| GET | `/api/admin/blacklist` | `admin` + `user` |
| POST | `/api/admin/blacklist` | `admin` + `user` |
| PUT | `/api/admin/blacklist/:id` | `admin` + `user` |
| DELETE | `/api/admin/blacklist/:id` | `admin` + `user` |
| GET | `/api/admin/blacklist/customers` | `admin` + `user` |
| GET | `/api/admin/blacklist/customers/:id/contacts` | `admin` + `user` |
| GET | `/api/admin/blacklist/customers/:id/related` | `admin` + `user` |
| GET | `/api/admin/blacklist/customers/:id/related-contacts` | `admin` + `user` |

* ต้องเปลี่ยน `GET /api/admin/customers/search` ([`index.ts`](../index.ts)) จาก `requireRole('admin')` เป็น `requireRole('admin', 'user')` เพื่อให้ role `user` ค้นหาบริษัทตอนเพิ่มรายการได้
* หน้าใหม่ `frontend/src/admin/Blacklist.tsx` + เพิ่มใน `NAV_ITEMS` โดยตั้ง `roles: ['admin', 'user']`
* ลบหน้า "ยังไม่มีเมนูสำหรับสิทธิ์ของคุณ" ใน [`AdminApp.tsx`](../frontend/src/admin/AdminApp.tsx) ออก เพราะ role `user` มีเมนูของตัวเองแล้ว
* GET ต้อง **`LEFT JOIN`** ชื่อบริษัท/ผู้ติดต่อจาก `customers_data_view` มาแสดง (อ่านอย่างเดียว ไม่แก้ตาราง)
  ต้องเป็น `LEFT JOIN` เพราะลูกค้าที่ถูกลบจาก Odoo จะหายจากตารางนี้รอบ sync ถัดไป — `INNER JOIN` จะทำให้รายการ blacklist หายจากหน้าจอทั้งที่ยังบล็อกอยู่จริง ให้โชว์ id ดิบแทนชื่อ

#### 4.7 สิ่งที่ยืนยันว่า "ไม่ถูกแตะ"

`customers_data_view` และ sync ทั้งหมด · SQL ค้นหาลูกค้า/สินค้า · Fuse.js matching · `utils/pricing.ts` · `utils/promotionValidator.ts` · `services/rules/` · `pdfGenerator.ts` · การคำนวณส่วนลด/ค่าขนส่ง/MOQ/วันจัดส่ง · `quotation_rules` / `promotions` / `products` ทุกตาราง

#### 4.8 ลำดับงานย่อยและการตรวจ

1. ✅ **เสร็จ 2026-08-06** — `migrations/changes/2026-08-06_03_quotation_blacklist.sql` (รันบน DB จริงผ่าน psql แล้ว) + `services/blacklistService.ts` + เพิ่มตารางใน `schema.sql`
   ยังไม่มีใครเรียกโมดูลนี้ → ทั้งโค้ดและ DB ไม่กระทบพฤติกรรมเดิมเลย
   ตรวจแล้วด้วย harness ชั่วคราว 31 เคส (สร้าง-รัน-ลบทิ้ง): constraint ระดับตาราง, unique index ทั้งสองตัว, normalize `contact_id = 0 → NULL`, string id จาก JSON body, บล็อกทั้งบริษัทไม่ลามผิดคน, `ON DELETE SET NULL` ของ `created_by`
2. ✅ API แอดมิน 5 เส้นใน `index.ts` + หน้า `frontend/src/admin/Blacklist.tsx` + `NAV_ITEMS` + ลบหน้า "ยังไม่มีเมนู"
   **แก้จากแผนเดิม:** §4.6 เคยสั่งให้ปลด `GET /api/admin/customers/search` เป็น `requireRole('admin','user')` — **ทำไม่ได้**
   เส้นนั้นคืนแค่ `reference` + `display_name` จากตาราง `customers` ไม่มี `company_id` ที่หน้านี้ต้องใช้ และเป็นของหน้าโปรโมชัน
   จึงเพิ่มเส้นใหม่แทน: `GET /api/admin/blacklist/customers` และ `/api/admin/blacklist/customers/:id/contacts` (ใช้ `searchCustomersAdmin` / `getContactsByCustomerId` ที่มีอยู่แล้ว)
3. ✅ `CUSTOMER_BLACKLISTED` เข้า `Violation` + `buildViolationDisplay` + `validateQuotationItems`
   **ย้าย early-return ของ "ใบไม่มีสินค้า" ลงมาไว้หลังการตรวจ blacklist** — ไม่งั้นใบที่ยังไม่มีบรรทัดสินค้าจะข้ามด่านระดับลูกค้าไปทั้งใบ
4. ✅ เติม id เข้าด่าน `stage: 'confirm'` 2 จุด
5. ✅ เติม id เข้าด่าน `draft`/`save` อีก 4 จุด + guard **3 จุด** (มากกว่าที่วางแผนไว้ 1 จุด)
   `resolveContactFlow` ต้องมี **2 ด่าน** ไม่ใช่ 1: ด่านบนสุดตรวจได้แค่ระดับบริษัท (ยังไม่รู้ว่าผู้ติดต่อคือใคร)
   ต้องตรวจซ้ำระดับผู้ติดต่อตอน auto-match ได้ตัวคนแล้ว ก่อนเขียน DB · อีกจุดคือ postback `select_contact` ใน `lineHandler`
6. ✅ เตือนต้นทาง: ปุ่มยืนยันใน Flex + `is_blacklisted` ใน `/api/customers/search` และ `/api/customer/:id/contacts` + ป้ายแดง/กดไม่ได้ในหน้า LIFF
7. ✅ **เสร็จ 2026-08-07 (ยังไม่ deploy)** — ปิดรูรั่ว "นิติบุคคลเดียวกันแต่คนละ `company_id`/`contact_id`" ตาม §4.3.1
   เขียน `blacklistService.ts` ใหม่ทั้งไฟล์ให้ใช้นิยาม "เป็นรายเดียวกัน" ชุดเดียวทุกฟังก์ชัน + เพิ่ม `listRelatedContacts`
   + `PUT /api/admin/blacklist/:id` (แก้ไขขอบเขต/เหตุผล) + คอลัมน์รหัสบริษัท + `CoveragePreview` ในหน้าแอดมิน
   harness ชั่วคราว 21 เคส (สร้าง-รัน-ลบทิ้ง) กับข้อมูลจริงของ บ.โลหะกิจรุ่งเจริญทรัพย์ (`435106` สนญ. / `435114` สาขา 00002 เลขภาษีเดียวกัน):
   "คุณสนธยา" `973133` ↔ `984909` ต้องโดนทั้งคู่ · "คุณสุภาพร"/"คุณอาท" ต้องไม่โดน · `"คุณเอ๋"` vs `"คุณเอ๋ (จัดซื้อบางกระเจ้า)"` ชื่อไม่ตรงเป๊ะต้องไม่โดน
   · บล็อกรายคนต้องไม่ลามเป็นทั้งบริษัท · ผู้ติดต่อชื่อ `'none'` ห้าม match กันเอง · ป้ายเตือนต้องคืนรหัสของบริษัทที่ถาม · regression ของการบล็อกทั้งบริษัท
   ⚠️ harness ห้าม seed ด้วย `company_id = 1` — เป็นรายการจริงที่แอดมินบล็อกไว้ unique index จะฟ้อง `23505` แล้ว cleanup จะลบของจริงทิ้ง

**ผลตรวจอัตโนมัติ (รันจริง 2026-08-06 — ผ่านทั้งหมด):**
`npx tsc --noEmit` ✓ · `docker build --target frontend` ✓ · `npx eslint .` ✓ · `npm run diag:quote-validation` ✓ (12/12)
`npm run diag:confirm-race` ✓ (ต้องส่ง `-e APP_URL=http://app:3011` เมื่อรันในคอนเทนเนอร์ชั่วคราว ไม่งั้นได้ HTTP 0 ทุกใบ)
`tsx scripts/evalCustomerSearch.ts` ✓ **เทียบกับ baseline ที่ checkout จาก HEAD แล้วเท่ากันเป๊ะ** — top-1 50/54, top-3 54/54, zero-candidate 0, wrong-auto-select 0
harness ชั่วคราวเฉพาะเฟสนี้ 26 เคส (สร้าง-รัน-ลบทิ้ง): ด่านกลางครบ 3 stage, บล็อกรายผู้ติดต่อไม่ลามคนอื่น, string id, ใบไม่มีสินค้า, guard ใน `resolveContactFlow` ไม่เขียน DB เลย, ปุ่ม Flex หาย/ไม่หาย, ปลดออกแล้วมีผลทันที

**Verify:** `docker run ... npx tsc --noEmit` · `docker build --target frontend` · `npx eslint .` · `npm run diag:confirm-race` (แตะ confirm path) · **`tsx scripts/diag/quoteValidationSmoke.ts`** (แตะ `validateQuotationItems`/`buildViolationDisplay` โดยตรง — ไฟล์นั้นสั่งไว้เองว่าให้รันซ้ำทุกครั้งที่แตะ) · `tsx scripts/evalCustomerSearch.ts` (**เทียบผลก่อน/หลัง ต้องเท่าเดิมเป๊ะ** — เป็นหลักฐานว่าไม่ได้แตะการค้นหา)

ทดสอบมือ — ข้อ 1-3 ต้องทำ **ครบทั้ง 3 ทางเข้า** (พิมพ์ในแชท / ปุ่มใน Flex / หน้า LIFF) ตามผังใน §4.4:
1. ขึ้นบัญชีทั้งบริษัท → สั่งใบใหม่ → ต้องถูกปฏิเสธพร้อมข้อความไทย
2. ขึ้นบัญชีเฉพาะผู้ติดต่อ A → เสนอราคาให้ผู้ติดต่อ B ของบริษัทเดียวกัน → **ต้องผ่าน**
3. ร่างค้างอยู่ก่อน → ขึ้นบัญชี → แก้ไขร่าง**และกดบันทึกใน LIFF ได้** แต่กดยืนยันไม่ผ่าน (ข้อนี้คือตัวจับ bug `'123' !== 123` ใน §4.4)
4. ใบที่ยืนยันไปแล้ว → ขึ้นบัญชี → ใบเดิมยังโหลด/ดาวน์โหลด PDF ได้ตามปกติ
5. ลบออกจากบัญชี → ทุกอย่างกลับมาทำงานปกติทันที (ไม่ต้องรอ sync)
6. ใบที่ยังไม่ผูกบริษัท (`pending_company`) → พิมพ์ชื่อบริษัทที่ถูกบล็อกเข้าไป → ต้องถูกปฏิเสธ **และร่างต้องไม่ถูกผูก id ทิ้งไว้** (กัน regression ของจุดเขียนที่ 2 ใน §4.4)

---

### เฟส 5 — เก็บกวาดความปลอดภัย

**สถานะ:** ✅ เสร็จครบทั้ง 3 ข้อ — 5.1 และ 5.2 จบไปพร้อมเฟส 2 · 5.3 ทำ 2026-08-06

**5.1 token ค้างหลังเปลี่ยนสิทธิ์** — ✅ แก้แล้วด้วยทางเลือก (ก)
`adminAuthMiddleware` อ่าน `id, username, name, role` สดจาก DB ทุก request แทนการเชื่อค่าใน JWT
ผลคือลดสิทธิ์/ลบผู้ใช้แล้วมีผลกับ token ใบเดิมทันที ไม่ต้องรอ 24 ชม. (ยืนยันด้วยการทดสอบจริงแล้ว)
ทำพร้อมเฟส 2 เพราะถ้าไม่ทำ หน้าจัดการสิทธิ์จะกลายเป็นของหลอก — กดลดสิทธิ์แล้วอีกฝ่ายยังทำได้เหมือนเดิมทั้งวัน

**5.2 ชื่อตาราง `admin_users`** — ✅ ตัดสินแล้ว: ไม่เปลี่ยนชื่อ
(ต้องแก้ทั้ง schema.sql, query, migration, FK ที่จะเพิ่มในเฟส 4) เขียน comment กำกับไว้ในไฟล์ migration แทน

**5.3 rate limit `/api/admin/login`** — ✅ ทำแล้วใน `config/loginRateLimit.ts`

กติกา: กรอกผิดได้ **8 ครั้งต่อช่วง 15 นาที** เกินนั้นตอบ `429` พร้อม header `Retry-After` และข้อความไทยบอกเวลาที่ต้องรอ
ล็อกอินสำเร็จเมื่อไหร่ตัวนับของคีย์นั้นถูกล้างทันที

**คีย์ของตัวนับคือ `IP + ชื่อผู้ใช้` ไม่ใช่ IP อย่างเดียว** — จุดนี้ตั้งใจ:
* นับต่อ IP ล้วน → คนออฟฟิศเดียวกันใช้ IP ขาออกร่วมกัน คนหนึ่งพิมพ์ผิดจนถูกกั้นจะลากคนอื่นไปด้วย
* นับต่อชื่อผู้ใช้ล้วน → ใครก็ได้ยิงชื่อ `admin` รัว ๆ เพื่อกันแอดมินตัวจริงไม่ให้เข้าระบบได้
* รวมสองอย่าง → คนเดารหัสต้องอยู่ IP เดียวกับเหยื่อถึงจะกวนได้

**การหา IP จริง** — เส้นทางคือ ผู้ใช้ → Cloudflare edge → `cf-tunnel` (cloudflared, อยู่ network `primus-chatbot_default` เดียวกับแอป) → แอป
`req.socket.remoteAddress` จึงเป็น IP ของ cloudflared ทุก request ใช้แยกคนไม่ได้
ต้องอ่าน `CF-Connecting-IP` ที่ Cloudflare เขียนทับให้ที่ edge (ปลอมจากภายนอกไม่ได้) แล้วค่อย fallback ไป `X-Forwarded-For` → socket

**ข้อจำกัดที่ยอมรับ**
* ตัวนับอยู่ใน memory ของ process → restart แอปแล้วรีเซ็ตหมด รับได้เพราะ deploy ไม่ได้บ่อยพอจะใช้เป็นช่องล้างตัวนับ
* ถ้าวันหน้าเปลี่ยน reverse proxy จน `CF-Connecting-IP` หายไป ทุกคนจะกลายเป็น IP เดียวกัน ผลคือคนเดารหัสจะกั้นได้ทีละ 1 ชื่อผู้ใช้ (นานสุด 15 นาที) ไม่ใช่กั้นทั้งระบบ — ตรวจได้จาก log `[login] <ip> ...` ว่าเห็น IP จริงหรือไม่

---

## 5. ลำดับที่ต้องทำตาม (มีลำดับบังคับ)

```
เฟส 1 (เปลี่ยนรหัสผ่าน + pgcrypto)      ✅
   └─→ เฟส 2 (บังคับสิทธิ์ server)      ✅  ← ห้ามสร้าง user role 'user' ก่อนเฟสนี้เสร็จ
          ├─→ เฟส 3 (UI จัดการ user)     ✅
          └─→ เฟส 4 (blacklist)          ✅ โค้ดครบ รอ deploy
                 └─→ เฟส 5 (เก็บกวาด)    ✅
```

---

## 6. กับดักที่ต้องระวัง (สรุปรวม)

1. **ห้ามพิมพ์รหัสผ่านดิบลง `password_hash`** — ต้องผ่าน `crypt(..., gen_salt('bf', 10))` เสมอ (§3.3)
2. **ซ่อนเมนูฝั่ง React ไม่ใช่ security** — ตัวจริงคือ `requireRole` ฝั่ง server (§2.2)
3. **เพิ่ม endpoint `/api/admin/*` ใหม่ต้องใส่ `requireRole('admin')` ด้วยเสมอ** — ใส่แค่ `adminAuthMiddleware` เท่ากับเปิดให้ role `user` เข้าถึงด้วย
4. **admin คนสุดท้าย** — กันทั้งการลบและการลดสิทธิ์ ใน transaction เดียวกันพร้อม `FOR UPDATE` (§เฟส 3)
5. **blacklist ต้องเช็คฝั่ง backend** — ตรงกับกฎ AGENTS.md §4 ที่ว่าห้ามตรวจสิทธิ์แค่ฝั่งเดียว
6. **ห้าม log รหัสผ่าน** และอย่าเก็บไฟล์ `.sql` ที่มีรหัสผ่าน plaintext ไว้หลังใช้เสร็จ
7. **ห้ามส่ง `password_hash` ออก API** — endpoint ของผู้ใช้ทุกตัวเลือกคอลัมน์ผ่านค่าคงที่ `USER_PUBLIC_COLUMNS` ห้ามใช้ `SELECT *`
8. **เงื่อนไขใหม่ของการออกใบเสนอราคา ให้เพิ่มใน `validateQuotationItems` ที่เดียว** — ห้ามสร้างด่านแยก
   ถ้าเขียนโค้ดที่ `INSERT/UPDATE quotations` แล้วเซ็ต `customer_id`/`contact_id` ขึ้นมาใหม่ ต้องกลับไปเติมในตาราง §4.4 ด้วย ไม่งั้นจะกลายเป็นรูที่มองไม่เห็น
9. **การบล็อกไม่ได้ผูกกับ `company_id`/`contact_id` ตัวเดียว** — Odoo แตกนิติบุคคลเดียวกันเป็นหลายรหัส ระบบจึงขยายด้วยชื่อ/รหัสอ้างอิง/เลขภาษี
   แตะ `blacklistService.ts` เมื่อไหร่ **ต้องอ่าน §4.3.1 ก่อน** — เขียน `JOIN cdv กับตัวเอง` ตรง ๆ จะทำให้ planner ตัด correlation ทิ้งแล้ว scan 82k แถว (1,091 ms) โดยผลลัพธ์ยังถูกอยู่ จับไม่ได้จากการเทียบผล ต้องดู `EXPLAIN`
10. **migration ต้องรันผ่าน `scripts/runMigration.ts` หรือ psql** ห้ามแก้ DB ด้วยมือ (AGENTS.md §5)
   ไฟล์ .sql ใหม่ยังไม่อยู่ใน image เก่าที่รันอยู่ → `docker compose exec app npx tsx ...` จะหาไฟล์ไม่เจอ ให้ใช้ psql ผ่าน stdin ตาม DEPLOY.md ขั้น 4

---

## 7. ไฟล์ที่แตะไปแล้ว

| เฟส | ไฟล์ใหม่ | ไฟล์ที่แก้ |
| --- | --- | --- |
| 1-3 (✅) | `migrations/changes/2026-08-06_01_admin_users_roles.sql`, `frontend/src/admin/Users.tsx`, `frontend/src/admin/ChangePasswordModal.tsx` | `config/auth.ts`, `index.ts`, `migrations/schema.sql`, `frontend/src/admin/AdminApp.tsx`, `frontend/src/context/AuthContext.tsx`, `DEPLOY.md` |
| 4 (✅ รอ deploy) | `services/blacklistService.ts`, `frontend/src/admin/Blacklist.tsx`, `migrations/changes/2026-08-06_03_quotation_blacklist.sql` | `services/quotationService.ts`, `index.ts`, `handlers/lineHandler.ts`, `services/quotationAgent.ts`, `utils/flexTemplates.ts`, `liff_pages/quote-edit.html`, `frontend/src/admin/AdminApp.tsx`, `migrations/schema.sql` |
| 5.3 (✅) | `config/loginRateLimit.ts` | `index.ts` |

---

## 8. คำสั่ง verify ที่ใช้จริงกับโปรเจกต์นี้

`node_modules` ไม่ได้ติดตั้งบนเครื่อง host และ image ของแอปก็ไม่ได้ mount โค้ดจาก host (`COPY . .` ตอน build)
คำสั่งใน AGENTS.md §7 จึงรันตรง ๆ ไม่ได้ ต้องรันผ่านคอนเทนเนอร์ชั่วคราวแบบนี้:

```bash
# typecheck backend — ใช้ node_modules จาก image แต่โค้ดจาก host
docker run --rm -v "$PWD":/app -v /app/node_modules -w /app primus-chatbot-app npx tsc --noEmit

# typecheck + build admin SPA (ไม่เขียนทับ public/ บน host)
docker build --target frontend -t primus-frontend-check .

# eslint ของ admin (ใช้ image ที่เพิ่ง build ข้างบน)
docker run --rm -w /app/frontend primus-frontend-check npx eslint .
```

> lint ผ่านสะอาด (exit 0) ตั้งแต่ 2026-08-06 — ใช้เป็นด่านตรวจแบบผ่าน/ไม่ผ่านได้เลย
> ก่อนหน้านั้นมี error ค้าง 2 จุด (`AuthContext.tsx`, `StockRules.tsx`) จากกฎ `react-hooks/set-state-in-effect`
> ที่มากับ `eslint-plugin-react-hooks` v7 ซึ่งใหม่กว่าโค้ดสองจุดนั้น — แก้ไปแล้วพร้อมงานชุดนี้
