import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * เก็บ "สถานะของหน้า" (ตัวกรอง/ช่วงเวลา/หน้า) ไว้ใน URL hash
 *
 * ทำไมต้องมี: หน้าพวกนี้มีไว้ให้คน "ส่งต่อ" — แอดมินเจอความผิดปกติแล้วต้องส่งลิงก์ให้ dev ดูจุดเดิม
 * ถ้าสถานะอยู่แค่ใน memory ก็ได้แต่บอกปากเปล่าว่า "กรองอะไรบ้าง" ซึ่งพลาดง่ายและเสียเวลาทั้งสองฝ่าย
 *
 * ทำไมเป็น hash ไม่ใช่ query string: Admin Portal ไม่มี router (สลับหน้าใน state ของ AdminApp)
 * การไปเติม router เข้ามาเพื่อเรื่องนี้อย่างเดียวคือการรื้อของที่ทำงานอยู่โดยไม่จำเป็น
 * hash เปลี่ยนได้โดยไม่ทำให้หน้า reload และไม่ถูกส่งขึ้น server (ตัวกรองบางตัวมีข้อมูลส่วนบุคคล)
 *
 * รูปแบบ: #<page>?<key>=<value>&...   เช่น  #audit?entityType=promotion&dateFrom=2026-09-01
 */

export type HashState = Record<string, string>;

/** อ่าน hash ปัจจุบัน — คืนชื่อหน้าและค่าตัวกรอง */
export function readHash(): { page: string; state: HashState } {
  const raw = window.location.hash.replace(/^#/, '');
  const qIdx = raw.indexOf('?');
  const page = qIdx < 0 ? raw : raw.slice(0, qIdx);
  const state: HashState = {};
  if (qIdx >= 0) {
    for (const [k, v] of new URLSearchParams(raw.slice(qIdx + 1))) state[k] = v;
  }
  return { page, state };
}

/**
 * สถานะที่ผูกกับ hash
 *
 * @param page  ชื่อหน้าใน hash — ใช้ตรวจว่า hash ที่อยู่ตอนนี้เป็นของหน้านี้จริงไหม
 *              (สลับไปหน้าอื่นแล้ว hash ของหน้าเก่าต้องไม่มาเขียนทับ)
 * @param defaults ค่าตั้งต้น · คีย์ที่ค่าตรงกับค่าตั้งต้นจะไม่ถูกเขียนลง URL (ลิงก์จึงสั้นและอ่านออก)
 */
export function useHashState(page: string, defaults: HashState) {
  const [state, setState] = useState<HashState>(() => {
    const h = readHash();
    return h.page === page ? { ...defaults, ...h.state } : { ...defaults };
  });

  // ค่าตั้งต้นถูกอ่านครั้งเดียวตอน mount — ถ้าอ่านสดทุกรอบ การพิมพ์ในช่องค้นหาจะทำให้
  // effect ที่ขึ้นกับ defaults ยิงใหม่ทุกตัวอักษร
  const defaultsRef = useRef(defaults);

  useEffect(() => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(state)) {
      if (v && v !== defaultsRef.current[k]) params.set(k, v);
    }
    const qs = params.toString();
    const next = `#${page}${qs ? `?${qs}` : ''}`;
    // replaceState ไม่ใช่ pushState — ทุกตัวอักษรที่พิมพ์ในช่องค้นหาไม่ควรกลายเป็นประวัติย้อนกลับ
    if (window.location.hash !== next) {
      window.history.replaceState(null, '', next);
    }
  }, [page, state]);

  const set = useCallback((patch: HashState) => {
    setState(prev => ({ ...prev, ...patch }));
  }, []);

  const reset = useCallback(() => {
    setState({ ...defaultsRef.current });
  }, []);

  return { state, set, reset };
}
