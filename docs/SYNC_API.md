# Sync API — ดึงข้อมูลจากแชทบอทออกไปให้ระบบภายนอก

`/api/sync/v1/*` เป็น API **อ่านอย่างเดียว** ให้ระบบภายนอกดึงข้อมูลจาก PostgreSQL ของแชทบอทไป sync
ลงฐานข้อมูลของตัวเอง ผ่าน **HTTPS สาธารณะ** ไม่ต้องต่อ LAN ไม่ต้องเปิดพอร์ตฝั่งปลายทาง

- Base URL: `https://salechatbot.primus-iot.com` (ค่า `APP_URL` ใน `.env`)
- โค้ด: [`services/externalSync.ts`](../services/externalSync.ts) · [`config/syncApiAuth.ts`](../config/syncApiAuth.ts) · route อยู่ท้าย [`index.ts`](../index.ts)
- ตัวอย่างตัวดึงที่ใช้งานจริง: [`integrations/nuc-sync-client/`](../integrations/nuc-sync-client/)
- การติดตั้ง/ออกกุญแจ: [`DEPLOY.md` ขั้น 4.9](../DEPLOY.md)

**ทิศทางเป็น "ปลายทางดึง" ไม่ใช่ "เราส่งไปให้"** — ปลายทางเปิด outbound HTTPS อย่างเดียวก็ใช้ได้
เราไม่ต้องรู้จัก IP ของเขา ไม่ต้องทำคิว retry ฝั่งเรา และเวลาปลายทางล่มก็ไม่มีอะไรค้างที่ฝั่งเรา

---

## 1. การยืนยันตัวตน

ทุก endpoint ต้องแนบกุญแจ:

```
Authorization: Bearer sk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

(รองรับ header `X-Sync-Key: <key>` ด้วย สำหรับ client ที่ตั้ง Authorization ไม่ได้)

- กุญแจนี้ **ไม่ใช่** token แอดมิน ทำได้อย่างเดียวคืออ่านผ่าน `/api/sync/v1/*`
- เพิกถอนได้ทันทีรายตัว และจำกัดได้ว่ากุญแจไหนเห็นตารางไหน
- ใน DB เก็บแค่ `sha256` ตัวกุญแจจริงไม่มีอยู่ที่ไหนเลย → ทำหายต้องออกใหม่

### ออก / ดู / เพิกถอนกุญแจ (สั่งบนเซิร์ฟเวอร์แชทบอท)

```bash
docker compose exec app npm run sync:key -- --name "NUC-Kay"
docker compose exec app npm run sync:key -- --name "เครื่อง X" --tables products,customers
docker compose exec app npm run sync:key -- --list
docker compose exec app npm run sync:key -- --revoke 1
```

---

## 2. Endpoint ทั้งหมด (มี 3 ตัว)

### 2.1 `GET /api/sync/v1/tables` — ทะเบียนตาราง

เรียกตัวนี้ก่อนเสมอ ตัวดึงควรอ่านโครงจากที่นี่ ไม่ใช่ hardcode ไว้เอง

```bash
curl -H "Authorization: Bearer $KEY" \
  "https://salechatbot.primus-iot.com/api/sync/v1/tables"
```

```jsonc
{
  "server_time": "2026-09-02T08:32:30.052Z",
  "key_name": "NUC-Kay",
  "max_limit": 2000,
  "default_limit": 500,
  "tables": [
    {
      "table": "sale_orders",
      "mode": "incremental",          // incremental | append | snapshot
      "pk": ["order_reference"],      // คีย์สำหรับ upsert ฝั่งปลายทาง
      "cursor_column": "updated_at",  // null ในโหมด snapshot
      "columns": ["order_reference", "customer_reference", "..."],
      "poll_hint_seconds": 600,       // ควรถามถี่แค่ไหน (ข้อแนะนำ ไม่ได้บังคับ)
      "supports_ids": true,           // เรียก /ids ได้ไหม
      "note": null
    }
  ]
}
```

`columns` อ่านสด ๆ จาก DB ทุกครั้งที่แอปบูต → **คอลัมน์ใหม่ที่เพิ่มใน migration จะไหลไปหาปลายทางเอง**
โดยไม่ต้องแก้โค้ดทั้งสองฝั่ง

### 2.2 `GET /api/sync/v1/tables/:table` — ดึงข้อมูลทีละหน้า

| พารามิเตอร์ | ใช้กับโหมด | ความหมาย |
|---|---|---|
| `since` | `incremental` | ISO 8601 — เอาเฉพาะแถวที่ `updated_at >= since` · ใช้เฉพาะ **การเรียกครั้งแรกของรอบ** |
| `cursor` | ทุกโหมด | token จากหน้าก่อน · ถ้าส่งมาคู่กับ `since` จะยึด `cursor` เสมอ |
| `limit` | ทุกโหมด | ค่าตั้งต้น 500 เพดาน 2000 · ค่าที่เกิน/เพี้ยนจะถูกหั่นให้อยู่ในกรอบ ไม่ error |

```bash
curl -H "Authorization: Bearer $KEY" \
  "https://salechatbot.primus-iot.com/api/sync/v1/tables/sale_orders?since=2026-09-02T08:00:00Z&limit=2000"
```

```jsonc
{
  "table": "sale_orders",
  "mode": "incremental",
  "pk": ["order_reference"],
  "server_time": "2026-09-02T08:32:31.100Z",  // เวลาของ "ฝั่งเรา" — ใช้ตัวนี้เท่านั้น ห้ามใช้นาฬิกาตัวเอง
  "count": 2000,
  "has_more": true,
  "next_cursor": "WyIyMDI2LTA5LTAyIDE1OjEwOjExLjM0MDAyNSswNyIsIlNPMTIzNDUiXQ",
  "generation": null,                          // ไม่ null เฉพาะ customers_data_view
  "rows": [ { "order_reference": "SO12345", "...": "..." } ]
}
```

**ไล่หน้าจนกว่า `has_more` เป็น `false`** ระหว่างนั้นส่ง `next_cursor` ของหน้าก่อนกลับมาเป็น `cursor`

### 2.3 `GET /api/sync/v1/tables/:table/ids` — รายการคีย์ทั้งตาราง (ไว้ลบตาม)

มีเฉพาะตารางโหมด `incremental` (`supports_ids: true`) ตารางโหมดอื่นตอบ **400**

```bash
curl -H "Authorization: Bearer $KEY" \
  "https://salechatbot.primus-iot.com/api/sync/v1/tables/quotations/ids?limit=2000"
```

คืนเฉพาะคอลัมน์ `pk` ไล่หน้าด้วย `cursor` เหมือนกัน — ปลายทางเอาไปเทียบแล้วลบแถวที่ไม่อยู่ในรายการ

---

## 3. โหมดการ sync 3 แบบ

เลือกจาก **"ตารางนั้นถูกแก้และถูกลบยังไง"** ไม่ใช่จากขนาด

### `incremental` — ดึงเฉพาะที่เปลี่ยน

ใช้กับตารางที่มี `updated_at` ขยับทุกครั้งที่เขียน · ปลายทาง **upsert ทับด้วย `pk`**

3 ตารางใหญ่ (`sale_orders`, `customers`, `products`) มาจากการ sync กับ gateway ซึ่งเป็น **upsert ล้วน
ไม่มีการลบแถวเลย** จึงไม่ต้อง reconcile · ส่วน `quotations` ลบได้จริง (ล้างใบค้าง/ยกเลิกใบ) ต้องใช้ `/ids`

### `append` — ตารางที่ insert อย่างเดียว

`messages`, `api_logs` — เดินด้วย `id` ไม่ต้องพึ่ง timestamp เก็บ `next_cursor` ข้ามรอบได้ตรง ๆ

> `api_logs` ฝั่งเราลบของเก่าทิ้งตาม `API_LOG_RETENTION_DAYS` — ปลายทางเก็บยาวกว่าได้ตามใจ ไม่ต้องลบตาม

### `snapshot` — ดึงยกตาราง

ตารางเล็กที่ **มีการลบแถวจริง** (ตารางตั้งค่า/กฎ/ทะเบียน) วิธีที่ถูกคือดึงทั้งตารางแล้ว
**ลบสิ่งที่ไม่ได้มากับรอบนี้ทิ้ง** — จบปัญหา delete โดยไม่ต้องทำ tombstone ที่ฝั่งต้นทาง

ตัวใหญ่สุดในกลุ่มนี้คือ `product_stock_rules` 536 kB ถูกกว่าการทำ tombstone มาก

### ตารางทั้งหมด (23 ตาราง)

| ตาราง | โหมด | pk | poll hint | ขนาด/แถว | หมายเหตุ |
|---|---|---|---|---|---|
| `sale_orders` | incremental | `order_reference` | 600 | 429 MB / 316k | ก้อนใหญ่สุด |
| `customers` | incremental | `company_id`,`contact_id` | 600 | 84 MB / 78k | |
| `products` | incremental | `product_template_id` | 600 | 47 MB / 51k | |
| `quotations` | incremental | `id` | 600 | 4.2 MB / 1.2k | **ลบแถวได้ → ต้อง `/ids`** |
| `messages` | append | `id` | 600 | 3.8 MB / 4.7k | ตัด `reply_token` ออก |
| `api_logs` | append | `id` | 3600 | 4.8 MB / 16k | |
| `admin_users` | snapshot | `id` | 3600 | เล็ก | **ตัด `password_hash` ออก** |
| `salesperson` | snapshot | `user_id` | 900 | เล็ก | |
| `promotions` | snapshot | `id` | 900 | เล็ก | |
| `quotation_rules` | snapshot | `id` | 900 | เล็ก | |
| `quotation_blacklist` | snapshot | `id` | 900 | เล็ก | |
| `quotation_credit_policy` | snapshot | `id` | 900 | เล็ก | |
| `quotation_counters` | snapshot | `counter_key` | 900 | เล็ก | |
| `shipping_fee_config` | snapshot | `id` | 900 | เล็ก | |
| `product_stock_rules` | snapshot | `internal_reference` | 900 | 536 kB / 5.3k | |
| `product_moq_rules` | snapshot | `internal_reference` | 900 | เล็ก | |
| `product_optional_links` | snapshot | `id` | 900 | เล็ก | |
| `sync_settings` | snapshot | `id` | 900 | เล็ก | |
| `sync_state` | snapshot | `resource` | 900 | เล็ก | |
| `customers_data_view_state` | snapshot | `id` | 900 | เล็ก | |
| `quotation_export_log` | snapshot | `id` | 900 | 560 kB / 2.9k | แถวถูก UPDATE ทีหลังได้ (ถอนการส่งออก) |
| `quotation_export_batches` | snapshot | `id` | 900 | เล็ก | เหตุผลเดียวกัน |
| `customers_data_view` | snapshot | `company_id`,`contact_id` | 86400 | 41 MB / 82k | ตารางสรุป — ดู `generation` ข้างล่าง |

ตารางที่ **ไม่อยู่ในทะเบียน** ตอบ 404 เสมอ (`sync_api_keys` จงใจไม่เปิด — ไม่ส่งกุญแจของตัวเองออกไป)
ตารางใหม่ที่ migration สร้างขึ้นจะไม่หลุดออกไปเองจนกว่าจะมีคนใส่ทะเบียนใน `TABLE_REGISTRY`

---

## 4. วิธีดึงที่ถูกต้อง

### 4.1 รอบแรก (full sync)

ไม่ต้องส่ง `since` และ `cursor` เลย แล้วไล่ `next_cursor` ไปจนสุด

```bash
KEY=sk_xxx
BASE=https://salechatbot.primus-iot.com
cursor=""
while :; do
  resp=$(curl -s -H "Authorization: Bearer $KEY" \
    "$BASE/api/sync/v1/tables/products?limit=2000${cursor:+&cursor=$cursor}")
  echo "$resp" | jq -c '.rows[]' >> products.ndjson
  [ "$(echo "$resp" | jq -r .has_more)" = "true" ] || break
  cursor=$(echo "$resp" | jq -r .next_cursor)
done
```

> ทั้งฐาน ~610 MB **ให้ทำนอกเวลาทำงาน** · วัดจริง: 2,000 แถว/3.7 MB ต่อ ~0.16 วินาที

### 4.2 รอบถัดไป (incremental) — จุดที่พลาดกันบ่อยที่สุด

```
1. ยิงหน้าแรกด้วย since = ค่าที่เก็บไว้จากรอบก่อน
2. จำ server_time ของ "หน้าแรก" ไว้
3. ไล่ next_cursor จนกว่า has_more = false
4. เก็บ since ของรอบหน้า = server_time(หน้าแรก) − 60 วินาที
```

**กฎ 3 ข้อ:**

1. **ใช้ `server_time` ที่ API ส่งมา ห้ามใช้นาฬิกาของเครื่องตัวเอง** — นาฬิกา 2 เครื่องไม่มีวันตรงกันเป๊ะ
   คลาดไปทางลบเมื่อไหร่คือข้อมูลหายเงียบ
2. **เอา `server_time` ของ *หน้าแรก* ไม่ใช่หน้าสุดท้าย** — แถวที่ถูกเขียนระหว่างที่เราไล่หน้าอยู่ มี
   `updated_at` ใหม่กว่าจุดนั้นเสมอ จึงถูกดึงในรอบหน้าแน่นอน
3. **ถอยหลัง ~60 วินาทีทุกรอบ** — กัน transaction ที่จับเวลา `NOW()` ไว้ก่อนแต่ commit ทีหลัง ซึ่งจะ
   โผล่ใน DB "ย้อนหลัง" จุดที่เราหยุดไว้ · ยอมดึงซ้ำ 60 วิ ถูกกว่าข้อมูลหายถาวรมาก
   (การดึงซ้ำไม่มีผลเสีย เพราะปลายทาง upsert ด้วย `pk` อยู่แล้ว)

ตัวกรอง `since` เทียบแบบ **`>=` ไม่ใช่ `>`** โดยเจตนา — ยอมให้ซ้ำ 1 แถวดีกว่าเสี่ยงข้าม

### 4.3 โหมด snapshot

```
1. สร้าง runId ใหม่
2. ไล่ทุกหน้า → upsert พร้อมตีตรา _syncRun = runId ทุกแถว
3. จบแล้วลบทุกแถวที่ _syncRun != runId
```

วิธีตีตราแบบนี้ไม่ต้องกองรายการ id ทั้งตารางไว้ในหน่วยความจำ และไม่ต้องล้างตารางก่อนเขียนใหม่
(ซึ่งจะทำให้ปลายทางมีช่วงที่ข้อมูลหายจริง ๆ ถ้าดึงพังกลางคัน)

### 4.4 `generation` — เฉพาะ `customers_data_view`

ตารางนี้ฝั่งเราถูก **สร้างใหม่ทั้งใบแล้วสลับ** เป็นรอบ ๆ ไม่ได้แก้ทีละแถว ทุกหน้าจึงแนบ `generation`
(เวลาที่ build รอบล่าสุด) กลับไปด้วย

**ถ้า `generation` เปลี่ยนระหว่างที่กำลังไล่หน้าอยู่ = ต้นทางสลับใบกลางคัน → ทิ้งของที่ได้มาแล้วเริ่มใหม่**
ไม่งั้นจะได้ครึ่งใบเก่าครึ่งใบใหม่ปนกัน

ถ้าไม่อยากดึงก้อน 41 MB นี้เลยก็ข้ามได้ — ปลายทางประกอบเองจาก `customers` + `sale_orders` ได้
(สูตรอยู่ใน [`migrations/schema.sql`](../migrations/schema.sql) ส่วน `customers_data_build`)

### 4.5 ลบตามต้นทาง (reconcile)

จำเป็นกับ **`quotations` ตารางเดียว**

```
1. ไล่ /ids จนครบ → เก็บเป็น Set
2. อ่าน pk ทั้งหมดฝั่งตัวเอง → ตัวไหนไม่อยู่ใน Set ให้ลบ
```

ไม่ต้องทำทุกรอบ — ชั่วโมงละครั้งพอ

---

## 5. cursor คืออะไร

`next_cursor` เป็น base64url ของ JSON array `[ค่า cursor, ค่า pk...]` ที่ชี้ "แถวสุดท้ายของหน้าที่แล้ว"

- **ห้ามแกะออกมาอ่านหรือประกอบขึ้นเอง** — โครงข้างในเป็นเรื่องภายในของฝั่งต้นทาง วันหน้าถ้าเพิ่ม
  คอลัมน์ตัดสินลำดับ ตัวดึงที่แกะเองจะพังทันที
- **ไม่ควรเก็บถาวรข้ามรอบในโหมด `incremental`** — ใช้ `since` (ดูข้อ 4.2) แทน
  ส่วนโหมด `append` เก็บข้ามรอบได้ เพราะเดินด้วย `id` ไม่เกี่ยวกับเวลา
- cursor ที่เสีย/ผิดรูป ตอบ **400** — ให้เริ่มรอบใหม่โดยไม่ส่ง `cursor`

การแบ่งหน้าเป็นแบบ keyset (`WHERE (updated_at, pk) > (...)`) ไม่ใช่ `OFFSET` เพราะ `OFFSET` จะข้าม
หรือซ้ำทันทีที่มีคนเขียนตารางระหว่างที่ไล่หน้าอยู่

---

## 6. ชนิดข้อมูลที่ต้องระวัง

| ชนิดใน Postgres | ที่ได้ใน JSON | ข้อควรระวัง |
|---|---|---|
| `numeric` (ยอดเงิน, จำนวน) | **สตริง** `"1234.50"` | ตั้งใจให้เป็นสตริง — แปลงเป็น `double` ของ JS แล้วทศนิยมเพี้ยน ถ้าต้องคำนวณเงินให้ใช้ decimal ของฝั่งปลายทาง อย่า `parseFloat` ตรง ๆ |
| `timestamptz` | สตริง ISO 8601 | UTC เสมอ |
| `bigint` (`id` ของ `messages`/`api_logs`) | **สตริง** | เกินช่วง `Number.MAX_SAFE_INTEGER` ได้ |
| `jsonb` (`customer_details`, `item_details`, `print_snapshot`) | object/array ตรง ๆ | |
| `text[]` (`sync_settings.resources`) | array | |

---

## 7. ข้อจำกัดและรหัสข้อผิดพลาด

| รหัส | ความหมาย | ทำยังไง |
|---|---|---|
| **401** | ไม่ส่งกุญแจ / กุญแจผิด / ถูกเพิกถอน | ขอกุญแจใหม่ · retry ไม่ช่วย |
| **404** | ตารางไม่อยู่ในทะเบียน หรือกุญแจนี้ไม่มีสิทธิ์เห็น (จงใจตอบเหมือนกัน) | เช็คชื่อตารางกับ `/tables` |
| **400** | `cursor` เสีย หรือเรียก `/ids` กับตารางที่ไม่ใช่ `incremental` | เริ่มรอบใหม่โดยไม่ส่ง `cursor` |
| **429** | มีคนยิงพร้อมกันเกิน 4 เส้น | รอตาม header `Retry-After` แล้วลองใหม่ · เจอบ่อย = cron ยิงทับกัน (รอบก่อนยังไม่จบ) |
| **500** | ฝั่งเราพัง | ลองใหม่แบบ backoff · ดู `docker compose logs app` |

- เพดาน `limit` = 2000 แถว/หน้า
- เพดาน request พร้อมกัน = 4 (ทั้งระบบ ไม่ใช่ต่อกุญแจ) — ตั้งไว้กัน connection pool 40 เส้นที่บอท/LIFF/
  แอดมินใช้ร่วมกัน ไม่ให้ตัวดึงข้อมูลไปแย่งจนลูกค้าที่รอบอทตอบเจ็บแทน
- ทุก request ถูกบันทึกใน `api_logs` (ดูได้ที่หน้าแอดมิน) → ตอบได้ว่ากุญแจไหนดึงอะไรไปเมื่อไหร่

---

## 8. สิ่งที่ **ไม่** ถูกส่งออกไปเด็ดขาด

- `admin_users.password_hash` — bcrypt hash ที่หลุดออกไปคือของที่เอาไปไล่เดาต่อได้
- `messages.reply_token` — กุญแจตอบกลับ LINE
- ตาราง `sync_api_keys` ทั้งตาราง

รายชื่อคอลัมน์อ่านสดจาก DB ทุกครั้งที่บูต **แปลว่าคอลัมน์ลับตัวใหม่จะหลุดออกไปเองถ้าไม่ประกาศใน `exclude`**
— `npm run diag:sync-api` มีข้อคอยเตือนเมื่อเจอชื่อคอลัมน์ที่หน้าตาเหมือนของลับ

---

## 9. ตรวจสุขภาพ

```bash
docker compose exec app npm run diag:sync-api    # อ่านอย่างเดียว รันบน production ได้
```

ครอบ: ทะเบียนตรงกับ DB · `pk` มี unique index รองรับจริง · ไล่หน้าแล้วไม่ข้ามไม่ซ้ำ · คอลัมน์ลับไม่หลุด ·
query ใช้ index ไม่ใช่ Seq Scan · ตัวนับ concurrent ไม่รั่ว

ให้รันซ้ำทุกครั้งที่แตะ `services/externalSync.ts`, `config/syncApiAuth.ts` หรือเพิ่ม/ลบตารางใน migration