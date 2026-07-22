import dotenv from 'dotenv';

dotenv.config();

// ============================================================
// ตัวเรียก gateway (Odoo) ตัวกลางของสคริปต์ sync ทั้ง 3 ตัว
//
// ทำไมต้องรวมไว้ที่เดียว: เดิม gatewayGet ถูก copy ไว้ใน syncProducts /
// syncCustomers / syncSaleorders เหมือนกันทุกบรรทัด ต่างแค่ชื่อ env ของ API key
// → แก้ที่เดียวไม่ครบ 3 ที่เมื่อไหร่ พฤติกรรมจะเพี้ยนกันเงียบ ๆ
//
// สิ่งที่เพิ่มจากของเดิม: timeout ต่อ request + แยกประเภท error ให้ผู้เรียกรู้ว่า
// "ติดต่อ gateway ไม่ได้" (ควรยกเลิกทั้งรอบ) หรือ "gateway ปฏิเสธ" (ล้มเฉพาะตัวนี้)
// ============================================================

/** timeout ต่อ 1 request — ครอบทั้งการรอ header และการโหลด body */
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 5;
const INITIAL_RETRY_DELAY_MS = 2000;

/**
 * ติดต่อ gateway ไม่ได้ / gateway ไม่ไหว — ยิง resource อื่นต่อก็พังเหมือนกัน
 * ผู้เรียก (syncService) จะยกเลิกทั้งรอบเมื่อเจอ error ตัวนี้
 */
export class GatewayUnreachableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as any);
    this.name = 'GatewayUnreachableError';
  }
}

/**
 * ต่อถึง gateway ได้ แต่ถูกปฏิเสธ (400/401/403/404) — เป็นปัญหาเฉพาะ resource นั้น
 * เพราะ API key แยกกันคนละตัวต่อ resource (Product_full_sync / Customer_full_sync / Saleorder_full_sync)
 * key ตัวหนึ่งผิดจึงไม่ได้แปลว่าตัวอื่นผิดด้วย → ตัวถัดไปยังต้องได้วิ่ง
 */
export class GatewayRejectedError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GatewayRejectedError';
    this.status = status;
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function requiredEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  throw new Error(`Missing required environment variable. Expected one of: ${names.join(', ')}`);
}

function trimTrailingSlash(value: string) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/** true = ปัญหาการเชื่อมต่อ/ฝั่ง gateway ล่ม (ไม่ใช่ความผิดของ request เรา) */
function isConnectivityError(error: any): boolean {
  if (!error) return false;
  // AbortSignal.timeout() → TimeoutError, abort อื่น ๆ → AbortError
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  // undici โยน TypeError('fetch failed') โดยมีสาเหตุจริงอยู่ใน cause
  const code = error.code || error.cause?.code;
  if (code && ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)) {
    return true;
  }
  return error instanceof TypeError && /fetch failed|network|socket/i.test(error.message || '');
}

/**
 * สร้างฟังก์ชัน GET ที่ผูกกับ API key ชุดหนึ่ง
 *
 * env ถูกอ่านตอนเรียกฟังก์ชันนี้ (ซึ่งสคริปต์เรียกที่ top-level ของตัวเอง) ไม่ใช่ตอน import
 * โมดูล — เพื่อคงพฤติกรรมเดิมที่ syncService ตั้งใจ lazy import ไว้: env หาย ต้องพังตอน
 * เริ่ม sync (ซึ่งมี try/catch รออยู่) ไม่ใช่ตอน boot เซิร์ฟเวอร์
 */
export function createGatewayGet(apiKeyEnvNames: string[]) {
  const baseUrl = trimTrailingSlash(requiredEnv('GATEWAY_BASE_URL', 'gateway_host'));
  const apiKey = requiredEnv(...apiKeyEnvNames);

  return async function gatewayGet(path: string): Promise<any> {
    const url = `${baseUrl}${path}`;
    let attempts = 0;
    let delay = INITIAL_RETRY_DELAY_MS;

    while (attempts < MAX_ATTEMPTS) {
      attempts += 1;
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'x-api-key': apiKey
          },
          // กันเคสร้ายที่สุด: gateway รับ connection แล้วเงียบ ไม่ตอบ ไม่ปิด
          // ถ้าไม่มีบรรทัดนี้ sync จะค้างถาวรและล็อก mutex ไว้จน restart container
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });

        if (response.status === 429 || response.status === 503 || response.status === 504) {
          if (attempts >= MAX_ATTEMPTS) {
            throw new GatewayUnreachableError(
              `Gateway API Error: ${response.status} - ${response.statusText} (max attempts reached)`
            );
          }
          console.warn(`[gateway] temporary ${response.status}, retrying in ${delay / 1000}s (${attempts}/${MAX_ATTEMPTS})`);
          await sleep(delay);
          delay *= 2;
          continue;
        }

        const body: any = await response.json();
        if (!response.ok) {
          const message = body?.message || body?.error || `Gateway API Error: ${response.status}`;
          if ([400, 401, 403, 404].includes(response.status)) {
            // ปัญหาของ request/key เอง — ยิงซ้ำก็ได้ผลเดิม
            throw new GatewayRejectedError(message, response.status);
          }
          const err: any = new Error(message);
          err.status = response.status;
          throw err;
        }

        return body;
      } catch (error: any) {
        if (error instanceof GatewayRejectedError) throw error;

        if (attempts >= MAX_ATTEMPTS) {
          if (error instanceof GatewayUnreachableError) throw error;
          // 5xx ที่ retry จนครบ หรือเชื่อมต่อไม่ได้ → ถือว่า gateway ใช้งานไม่ได้
          if (isConnectivityError(error) || (error?.status && error.status >= 500)) {
            throw new GatewayUnreachableError(
              `ติดต่อ gateway ไม่ได้ (${error?.message || error}) — ลองแล้ว ${MAX_ATTEMPTS} ครั้ง`,
              { cause: error }
            );
          }
          throw error;
        }

        console.warn(`[gateway] request failed: ${error.message}. retrying in ${delay / 1000}s (${attempts}/${MAX_ATTEMPTS})`);
        await sleep(delay);
        delay *= 2;
      }
    }

    throw new GatewayUnreachableError('Gateway request failed unexpectedly');
  };
}
