import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';

/**
 * หัวเรื่องของหน้า — แสดงบน "แถบบน" ของ AdminApp ที่เดียว ไม่ใช่การ์ดในเนื้อหาของแต่ละหน้า
 *
 * ทำไมต้องเป็น portal ไม่ใช่ prop ส่งขึ้นไปให้ AdminApp เรนเดอร์:
 *   ปุ่ม action ของแต่ละหน้า (เช่น "ส่งออก Odoo" ที่มีเมนูของตัวเอง) ผูกกับ state ของหน้านั้น
 *   ถ้ายกไปไว้ที่ AdminApp ต้องยก state ตามขึ้นไปด้วยทั้งชุด = รื้อของที่ทำงานดีอยู่แล้วโดยไม่จำเป็น
 *   portal ทำให้ "เขียนไว้ในหน้าเดิม แต่ไปโผล่บนแถบบน" — เจ้าของ state ไม่เปลี่ยนมือ
 *
 * หน้าที่ยังไม่ได้ใส่ <PageHeader /> ไม่ต้องแก้อะไร แถบบนจะ fallback ไปใช้ชื่อเมนูจาก PAGE_TITLES เอง
 * (1 แท็บ = 1 หน้าที่ใส่ PageHeader เท่านั้น ถ้าใส่สองตัวพร้อมกันจะซ้อนกันบนแถบเดียว)
 */

interface PageHeaderSlot {
  /** กล่องปลายทางบนแถบบน — null ตอนเรนเดอร์รอบแรกก่อน ref จะติด */
  node: HTMLElement | null;
  setNode: (el: HTMLElement | null) => void;
  /** มีหน้าไหนยึดช่องนี้อยู่หรือยัง — ใช้ตัดสินว่าจะโชว์ชื่อ fallback ไหม */
  filled: boolean;
  setFilled: (v: boolean) => void;
}

const SlotContext = createContext<PageHeaderSlot | null>(null);

export const PageHeaderProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [filled, setFilled] = useState(false);
  // setNode/setFilled จาก useState มี identity คงที่อยู่แล้ว value จึงเปลี่ยนเฉพาะตอน node/filled เปลี่ยนจริง
  const value = useMemo<PageHeaderSlot>(() => ({ node, setNode, filled, setFilled }), [node, filled]);
  return <SlotContext.Provider value={value}>{children}</SlotContext.Provider>;
};

/**
 * ช่องรับหัวเรื่องบนแถบบน — วางได้ที่เดียวใน AdminApp
 * กล่องเป้าหมายเป็น `display: contents` เพื่อให้ของที่ portal เข้ามากลายเป็นลูกของ flex บนแถบโดยตรง
 * (ถ้าเป็น div ปกติ ตอนยังไม่มีหน้าไหนยึดช่อง กล่องเปล่าจะกินพื้นที่และดันชื่อ fallback ไปทางขวา)
 */
export const PageHeaderOutlet: React.FC<{ fallbackTitle: string }> = ({ fallbackTitle }) => {
  const slot = useContext(SlotContext);
  return (
    <>
      <div ref={slot?.setNode} className="contents" />
      {!slot?.filled && (
        <h2 className="text-base font-bold text-slate-900 leading-tight truncate">{fallbackTitle}</h2>
      )}
    </>
  );
};

interface PageHeaderProps {
  /** ไอคอนหน้าเรื่อง (lucide-react) — สีแบรนด์ให้เอง ไม่ต้องส่ง className มา */
  icon?: LucideIcon;
  title: string;
  /** คำอธิบายสั้น ๆ — ซ่อนบนจอแคบเพราะแถบบนมีที่จำกัด */
  description?: string;
  /** ปุ่ม action ของหน้า — วางชิดขวาของแถบ */
  children?: React.ReactNode;
}

export const PageHeader: React.FC<PageHeaderProps> = ({ icon: Icon, title, description, children }) => {
  const slot = useContext(SlotContext);
  const setFilled = slot?.setFilled;

  useEffect(() => {
    setFilled?.(true);
    return () => setFilled?.(false);
  }, [setFilled]);

  if (!slot?.node) return null;

  return createPortal(
    <>
      <div className="flex items-center gap-2 min-w-0">
        {Icon && <Icon className="w-5 h-5 text-[#009032] shrink-0" />}
        <h2 className="text-base font-bold text-slate-900 whitespace-nowrap">{title}</h2>
        {description && (
          <span className="text-xs text-slate-400 hidden xl:inline truncate">{description}</span>
        )}
      </div>
      <div className="flex-1" />
      {children && <div className="flex items-center gap-2 shrink-0">{children}</div>}
    </>,
    slot.node
  );
};
