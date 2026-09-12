import { useCallback, useEffect, useState } from 'react';
import { readHash } from './logs/useHashState';

/**
 * หน้าที่เปิดอยู่ของ Admin Portal — เก็บไว้ใน URL hash ไม่ใช่ใน memory อย่างเดียว
 *
 * ทำไมต้องมี: เดิมชื่อแท็บอยู่ใน useState ล้วน ๆ พอกด refresh (หรือเบราว์เซอร์รีโหลดเอง
 * ตอน token หมดอายุ/เน็ตสะดุด) ก็เด้งกลับ "แผงควบคุม" ทุกครั้ง — คนที่กำลังทำงานค้างอยู่
 * ต้องไล่กดกลับเข้าไปใหม่เอง
 *
 * ทำไมไม่ลง router: หน้านี้ serve จาก /admin ตัวเดียว ไม่มี server-side route
 * และ hash ถูกใช้เป็นที่เก็บสถานะอยู่แล้วโดย logs/useHashState (`#<page>?<filters>`)
 * โมดูลนี้จึงจองแค่ "ช่อง page" ของรูปแบบเดิม ไม่ไปยุ่งกับส่วน query ของหน้าลูก
 *
 * กติกาที่ทำให้สองฝั่งอยู่ร่วมกันได้:
 *   1. slug มีที่เดียวคือ TAB_SLUG ข้างล่าง · หน้าลูกอ้างค่านั้น ไม่พิมพ์สตริงซ้ำ
 *   2. เขียน hash เฉพาะตอน slug เปลี่ยนจริง ⇒ ตัวกรองที่หน้าลูกเพิ่งเขียนลง `?...` ไม่ถูกล้าง
 *      (effect ของลูกทำงานก่อน parent เสมอ ถ้าเขียนทับทุกรอบ ลิงก์ที่แชร์กันมาพร้อมตัวกรองจะเสีย)
 */

export type MainTab =
  | 'dashboard' | 'quoterequest' | 'quotations' | 'salespersons' | 'promotions' | 'users' | 'blacklist'
  // กลุ่ม "บันทึกและรายงาน" — 4 หน้าที่อยู่ใต้หัวข้อพับได้อันเดียวกัน
  | 'traffic' | 'apilogs' | 'auditlogs' | 'systemlogs'
  | 'settings';

export type SubTab = 'quotation' | 'optional' | 'stock' | 'moq' | 'block' | 'shipping';

export interface AdminRoute {
  tab: MainTab;
  sub: SubTab;
}

export const DEFAULT_ROUTE: AdminRoute = { tab: 'dashboard', sub: 'quotation' };

/**
 * ชื่อแท็บ → slug ใน hash · เป็น "ทะเบียนกลาง" ที่ทั้งเมนูและหน้าลูกอ้างถึงตัวเดียวกัน
 *
 * auditlogs/systemlogs มี slug สั้นกว่าชื่อแท็บ เพราะหน้าลูกเรียกตัวเองว่า 'audit'/'system'
 * ใน useHashState มาตั้งแต่ก่อนมีไฟล์นี้ (ลิงก์เก่าที่แชร์กันไว้ต้องยังเปิดได้)
 * หน้าลูกจึงส่ง TAB_SLUG.auditlogs เข้า useHashState แทนการพิมพ์สตริงเอง —
 * สองฝั่งไม่มีทางหลุดจากกันแม้จะเปลี่ยนชื่อ slug ทีหลัง
 */
export const TAB_SLUG: Record<MainTab, string> = {
  dashboard: 'dashboard',
  quoterequest: 'quoterequest',
  quotations: 'quotations',
  salespersons: 'salespersons',
  promotions: 'promotions',
  users: 'users',
  blacklist: 'blacklist',
  traffic: 'traffic',
  apilogs: 'apilogs',
  auditlogs: 'audit',
  systemlogs: 'system',
  settings: 'settings',
};

const SLUG_TAB = new Map<string, MainTab>(
  (Object.entries(TAB_SLUG) as [MainTab, string][]).map(([tab, slug]) => [slug, tab]),
);

const SUB_TABS = new Set<string>(['quotation', 'optional', 'stock', 'moq', 'block', 'shipping']);

/** หน้าตั้งค่ามีเมนูย่อย จึงเก็บเป็นสองชั้น: `settings/stock` */
export function routeToSlug(route: AdminRoute): string {
  return route.tab === 'settings' ? `settings/${route.sub}` : TAB_SLUG[route.tab];
}

/**
 * แปลง slug กลับเป็นแท็บ
 * - hash ว่าง = สภาพตอนเปิดเว็บครั้งแรก ⇒ หน้าเริ่มต้น (กด back กลับมาถึงตรงนี้ต้องได้หน้าเดียวกับที่เคยเห็น)
 * - slug ที่อ่านไม่ออก (พิมพ์มั่ว/ลิงก์เก่าที่เลิกใช้) ⇒ อยู่หน้าเดิม ไม่เด้งไปไหน
 */
export function slugToRoute(slug: string, fallback: AdminRoute): AdminRoute {
  if (slug === '') return { tab: DEFAULT_ROUTE.tab, sub: fallback.sub };
  if (slug.startsWith('settings/') || slug === 'settings') {
    const sub = slug.slice('settings/'.length);
    return { tab: 'settings', sub: SUB_TABS.has(sub) ? (sub as SubTab) : fallback.sub };
  }
  const tab = SLUG_TAB.get(slug);
  return tab ? { tab, sub: fallback.sub } : fallback;
}

/**
 * แท็บที่เปิดอยู่ + ตัวสั่งเปลี่ยนแท็บ
 *
 * pushState ไม่ใช่ replaceState: การกดเมนูเป็นการ "ไปหน้าใหม่" ปุ่ม back จึงควรพากลับแท็บก่อนหน้า
 * (ต่างจากการพิมพ์ในช่องค้นหาของหน้าลูก ที่ replaceState เพื่อไม่ให้ทุกตัวอักษรกลายเป็นประวัติ)
 */
export function useAdminRoute() {
  const [route, setRoute] = useState<AdminRoute>(() => slugToRoute(readHash().page, DEFAULT_ROUTE));

  useEffect(() => {
    // ยิงเมื่อกด back/forward หรือแก้ hash เอง — pushState/replaceState ของเราเองไม่ยิง event นี้
    const onHashChange = () => setRoute((prev) => slugToRoute(readHash().page, prev));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((next: AdminRoute) => {
    setRoute(next);
    const slug = routeToSlug(next);
    if (readHash().page !== slug) window.history.pushState(null, '', `#${slug}`);
  }, []);

  return { route, navigate };
}
