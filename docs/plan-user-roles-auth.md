# แผนงาน: ระบบผู้ใช้และสิทธิ์ (Auth & Roles) — Admin Portal

> สถานะ: **เฟส 1-3 และ 5 เสร็จแล้ว (2026-08-06)** · เฟส 4 (blacklist) ออกแบบจบแล้ว รอลงมือ
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

**สถานะ:** ☐ ออกแบบจบแล้ว 2026-08-06 รอลงมือ
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

**ห้ามแตะ `customers_data_view`** — เป็น MATERIALIZED VIEW ([`schema.sql:219`](../migrations/schema.sql#L219)) ที่ถูก `REFRESH ... CONCURRENTLY` ทุกรอบ sync ([`refreshCustomerDirectory.ts:25`](../scripts/sync/refreshCustomerDirectory.ts#L25))
ถ้าใส่ `is_blocked` เข้าไปใน matview จะเจอ:
* **ค่าที่กดบล็อกไม่มีผลจนกว่า sync รอบถัดไปจะ refresh** ← ข้อนี้ข้อเดียวก็ตัดทิ้งได้แล้ว
* matview ไม่มี `CREATE OR REPLACE` ต้อง DROP แล้วสร้างใหม่ พร้อม index 2 ตัวและ plain view `customers_data` ที่ครอบอยู่
* กระทบ `syncCustomers.ts` / `syncSaleorders.ts` / `syncService.ts` ที่เรียก refresh ตัวนี้

**ห้ามแปลง matview เป็นตารางจริงแล้วใส่คอลัมน์** — ข้อมูลใน matview เกิดจากการ blend `customers` + `sale_orders` ที่ sync ทับใหม่จาก Odoo ทุกรอบ ค่า `is_blocked` จะถูกทับหายทุกรอบ sync

**ห้ามกรอง blacklist ในการค้นหา** — ต้อง JOIN blacklist เข้า query ค้นหา = แตะ logic ที่ทำงานดีอยู่แล้ว และเซลล์จะงงว่าทำไมหาบริษัทที่มีอยู่จริงไม่เจอ
ให้ "ค้นเจอได้ แต่ยืนยันไม่ได้" แทน แล้วติดป้ายเตือนที่ผลลัพธ์

**ความรู้เรื่อง blacklist อยู่ในไฟล์เดียว** — `services/blacklistService.ts` จุดอื่นเรียกใช้ฟังก์ชัน ไม่มีใครรู้จักโครงสร้างตารางนอกจากไฟล์นี้

#### 4.2 ตารางใหม่

`migrations/changes/YYYY-MM-DD_NN_quotation_blacklist.sql`

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

```ts
export const BLACKLIST_MESSAGE =
  'บริษัท/ผู้ติดต่อ รายนี้ถูกระงับการเสนอราคา กรุณาติดต่อแอดมิน';

/** error ชนิดเฉพาะ เพื่อให้ caller แยกออกจาก error อื่นแล้วตอบข้อความที่ถูกต้อง */
export class BlacklistedCustomerError extends Error { ... }

/** บล็อกถ้าเจอแถวระดับบริษัท (contact_id IS NULL) หรือแถวที่ตรงทั้ง company + contact */
export async function isBlacklisted(companyId, contactId, executor?): Promise<boolean>

/** ใช้ติดป้ายในผลค้นหา — คืน Set ของ company_id ที่ถูกบล็อกทั้งบริษัท (query เดียว ไม่ยิงทีละแถว) */
export async function findBlockedCompanyIds(companyIds: number[]): Promise<Set<number>>
```

`isBlacklisted` ต้องรับ `executor` ได้ (ตาม pattern `DbExecutor` ใน [`config/db.ts`](../config/db.ts)) เพราะด่านที่ 3 ต้องเรียกจากใน transaction ที่ถือ row lock อยู่

#### 4.4 ด่านบังคับใช้ — 3 จุด ครอบทุกเส้นทาง

ทั้งการสร้างร่างและการยืนยันมี**จุดคอขวดเดียว**อยู่แล้ว ทำให้ไม่ต้องไล่แก้รายเส้นทาง:

| ด่าน | ที่ตั้ง | ครอบอะไร | พฤติกรรม |
| --- | --- | --- | --- |
| **A — สร้างร่าง** | `insertDraftQuotations()` [`quotationService.ts:429`](../services/quotationService.ts#L429) | ถูกเรียกจาก 10 ที่ (LINE flow, LIFF, REST, quotationAgent, revise) | มี `customerId` และถูกบล็อก → `throw BlacklistedCustomerError` |
| **B — เปลี่ยนลูกค้า** | `PUT /api/quotation/:id` [`index.ts:684`](../index.ts#L684) | เลือก/เปลี่ยนบริษัท-ผู้ติดต่อจาก LIFF | ตอบ `400` |
| **C — ยืนยัน** | `confirmQuotationAtomic()` [`quotationService.ts:156`](../services/quotationService.ts#L156) | **ทั้งปุ่มใน Flex และ REST** — คอมเมนต์ในไฟล์เขียนเองว่า "จุดเดียวในระบบที่เปลี่ยน status เป็น confirmed" | คืน `outcome: 'blocked'` |

```
① แชท + Flex → ปุ่มยืนยัน (lineHandler.ts:596) ─┐
                                                 ├─→ confirmQuotationAtomic()  ← ด่าน C
② LIFF → POST /api/quotation/:id/confirm ────────┘
```

**⚠️ กติกาสำคัญของด่าน B** — LIFF ส่ง `customer_id` มาทุกครั้งที่เซฟ ถ้าบล็อกแบบเหมารวมจะทำให้ **ร่างที่ค้างอยู่แก้ไขต่อไม่ได้ ซึ่งขัดกับข้อ 2 ที่ตกลงกันไว้**
ต้องบล็อกเฉพาะตอน **เปลี่ยนไปเป็นลูกค้ารายใหม่ที่ถูกบล็อก** เท่านั้น — ถ้า `(customer_id, contact_id)` ที่ส่งมาตรงกับที่ผูกอยู่เดิมในใบ ให้ผ่าน
(เทียบกับ `quote.customer_id` / `quote.contact_id` ที่อ่านมาแล้วที่ [`index.ts:783-784`](../index.ts#L783))

**ทำไมด่าน A ใช้ throw ไม่ใช่ return** — caller มี 10 ที่ ถ้าเปลี่ยน return type ต้องแก้ทุกที่ การ throw ทำให้ caller ที่ไม่ได้ส่ง `customerId` (สถานะ `pending_company`) ไม่ต้องแก้อะไรเลย และถ้าวันหน้ามี caller ใหม่ มันจะถูกกันอัตโนมัติ
ที่ต้องเพิ่ม `catch` มี 3 จุดคือ [`index.ts:268`](../index.ts#L268) (REST → 400), [`lineHandler.ts:1441`](../handlers/lineHandler.ts#L1441) (revise → reply ข้อความ), [`quotationAgent.ts:123`](../services/quotationAgent.ts#L123) (flow AI → reply ข้อความ)
ตอบกลับใน LINE ใช้ **replyToken เท่านั้น** ห้าม push (AGENTS.md §8)

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
| DELETE | `/api/admin/blacklist/:id` | `admin` + `user` |

* ต้องเปลี่ยน `GET /api/admin/customers/search` ([`index.ts`](../index.ts)) จาก `requireRole('admin')` เป็น `requireRole('admin', 'user')` เพื่อให้ role `user` ค้นหาบริษัทตอนเพิ่มรายการได้
* หน้าใหม่ `frontend/src/admin/Blacklist.tsx` + เพิ่มใน `NAV_ITEMS` โดยตั้ง `roles: ['admin', 'user']`
* ลบหน้า "ยังไม่มีเมนูสำหรับสิทธิ์ของคุณ" ใน [`AdminApp.tsx`](../frontend/src/admin/AdminApp.tsx) ออก เพราะ role `user` มีเมนูของตัวเองแล้ว
* GET ต้อง join ชื่อบริษัท/ผู้ติดต่อจาก `customers_data_view` มาแสดง (อ่านอย่างเดียว ไม่แก้ view)

#### 4.7 สิ่งที่ยืนยันว่า "ไม่ถูกแตะ"

`customers_data_view` และ sync ทั้งหมด · SQL ค้นหาลูกค้า/สินค้า · Fuse.js matching · `utils/pricing.ts` · `utils/promotionValidator.ts` · `services/rules/` · `pdfGenerator.ts` · การคำนวณส่วนลด/ค่าขนส่ง/MOQ/วันจัดส่ง · `quotation_rules` / `promotions` / `products` ทุกตาราง

#### 4.8 ลำดับงานย่อยและการตรวจ

1. migration + `blacklistService.ts` (ยังไม่มีใครเรียก — ปลอดภัย 100%)
2. API + UI แอดมิน (เพิ่มรายการได้ แต่ยังไม่มีผลกับใบเสนอราคา)
3. ด่าน C (ยืนยัน) — ด่านที่สำคัญที่สุด ทำก่อน
4. ด่าน A (สร้างร่าง) + ด่าน B (เปลี่ยนลูกค้า)
5. เตือนต้นทาง: ปุ่ม Flex + `is_blacklisted` + LIFF

**Verify:** `docker run ... npx tsc --noEmit` · `docker build --target frontend` · `npx eslint .` · `npm run diag:confirm-race` (แตะ confirm path) · `tsx scripts/evalCustomerSearch.ts` (**เทียบผลก่อน/หลัง ต้องเท่าเดิมเป๊ะ** — เป็นหลักฐานว่าไม่ได้แตะการค้นหา)

ทดสอบมือ:
1. ขึ้นบัญชีทั้งบริษัท → สั่งใบใหม่ผ่านแชท → ต้องถูกปฏิเสธพร้อมข้อความไทย
2. ขึ้นบัญชีเฉพาะผู้ติดต่อ A → เสนอราคาให้ผู้ติดต่อ B ของบริษัทเดียวกัน → **ต้องผ่าน**
3. ร่างค้างอยู่ก่อน → ขึ้นบัญชี → แก้ไขร่างได้ แต่กดยืนยันไม่ผ่าน
4. ใบที่ยืนยันไปแล้ว → ขึ้นบัญชี → ใบเดิมยังโหลด/ดาวน์โหลด PDF ได้ตามปกติ
5. ลบออกจากบัญชี → ทุกอย่างกลับมาทำงานปกติทันที (ไม่ต้องรอ sync)

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
          └─→ เฟส 4 (blacklist)          ☐ ออกแบบจบ รอลงมือ
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
8. **migration ต้องรันผ่าน `scripts/runMigration.ts` หรือ psql** ห้ามแก้ DB ด้วยมือ (AGENTS.md §5)
   ไฟล์ .sql ใหม่ยังไม่อยู่ใน image เก่าที่รันอยู่ → `docker compose exec app npx tsx ...` จะหาไฟล์ไม่เจอ ให้ใช้ psql ผ่าน stdin ตาม DEPLOY.md ขั้น 4

---

## 7. ไฟล์ที่แตะไปแล้ว

| เฟส | ไฟล์ใหม่ | ไฟล์ที่แก้ |
| --- | --- | --- |
| 1-3 (✅) | `migrations/changes/2026-08-06_01_admin_users_roles.sql`, `frontend/src/admin/Users.tsx`, `frontend/src/admin/ChangePasswordModal.tsx` | `config/auth.ts`, `index.ts`, `migrations/schema.sql`, `frontend/src/admin/AdminApp.tsx`, `frontend/src/context/AuthContext.tsx`, `DEPLOY.md` |
| 4 (☐ ออกแบบแล้ว) | `services/blacklistService.ts`, `frontend/src/admin/Blacklist.tsx`, `migrations/changes/YYYY-MM-DD_NN_quotation_blacklist.sql` | `services/quotationService.ts`, `index.ts`, `handlers/lineHandler.ts`, `services/quotationAgent.ts`, `utils/flexTemplates.ts`, `liff_pages/quote-edit.html`, `frontend/src/admin/AdminApp.tsx`, `migrations/schema.sql` |
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
