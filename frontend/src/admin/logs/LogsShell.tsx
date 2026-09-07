import React from 'react';
import { Activity, BarChart3, History, Terminal } from 'lucide-react';
import { Traffic } from './Traffic';
import { ApiLogs } from '../ApiLogs';
import { AuditLogs } from './AuditLogs';
import { SystemLogs } from './SystemLogs';

/**
 * กรอบร่วมของกลุ่ม "บันทึกและรายงาน" — แถบแท็บ + หน้าที่กำลังเปิด
 *
 * ทำไมต้องมีแถบแท็บ ทั้งที่เมนูข้างซ้ายก็มีเมนูย่อยครบอยู่แล้ว:
 *   4 หน้านี้ตอบคนละคำถามแต่ "ใช้ด้วยกันเป็นชุด" — เห็น 5xx ในบันทึกการเรียก API
 *   แล้วต้องข้ามไปดูบันทึกระบบว่าพังเพราะอะไรทันที การต้องเลื่อนตาไปหาเมนูข้างซ้าย
 *   (ซึ่งพับอยู่โดยค่าเริ่มต้น และหายไปเลยตอนย่อ sidebar) ทำให้ความสัมพันธ์นี้มองไม่เห็น
 *
 * แท็บกับเมนูย่อยชี้ที่เดียวกันทั้งคู่ ไม่ได้แทนกัน — onTab เรียก goTo ตัวเดียวกับที่เมนูใช้
 * สถานะจริงยังอยู่ที่ activeTab ของ AdminApp ที่เดียว ไม่มี state ซ้อนให้หลุดจากกัน
 */

export type LogTab = 'traffic' | 'apilogs' | 'auditlogs' | 'systemlogs';

const TABS: { key: LogTab; label: string; icon: React.ElementType }[] = [
  { key: 'traffic', label: 'รายงานการใช้งาน', icon: BarChart3 },
  { key: 'apilogs', label: 'บันทึกการเรียก API', icon: Activity },
  { key: 'auditlogs', label: 'บันทึกการแก้ไข', icon: History },
  { key: 'systemlogs', label: 'บันทึกระบบ', icon: Terminal },
];

export const LogsShell: React.FC<{ tab: LogTab; onTab: (t: LogTab) => void }> = ({ tab, onTab }) => (
  <div className="space-y-4">
    {/* แถบแท็บ — เส้นใต้ลากยาวเต็มความกว้างเพื่อให้เห็นว่าทั้งสี่อยู่ระนาบเดียวกัน */}
    <div className="border-b border-slate-200 flex gap-1 overflow-x-auto -mx-1 px-1">
      {TABS.map(({ key, label, icon: Icon }) => {
        const active = tab === key;
        return (
          <button
            key={key}
            onClick={() => onTab(key)}
            aria-current={active ? 'page' : undefined}
            className={`inline-flex items-center gap-2 px-3.5 py-2.5 text-sm whitespace-nowrap border-b-2 -mb-px
                        transition-colors ${
                          active
                            ? 'font-semibold border-current'
                            : 'border-transparent text-slate-500 hover:text-slate-800'
                        }`}
            style={active ? { color: 'var(--brand-fg)' } : undefined}
          >
            <Icon className="w-4 h-4 shrink-0" />
            {label}
          </button>
        );
      })}
    </div>

    {/* หน้าเดียวต่อครั้ง — เปลี่ยนแท็บแล้วหน้าเก่า unmount ไปพร้อมตัวจับเวลา/คำขอที่ค้างอยู่ */}
    {tab === 'traffic' && <Traffic />}
    {tab === 'apilogs' && <ApiLogs />}
    {tab === 'auditlogs' && <AuditLogs />}
    {tab === 'systemlogs' && <SystemLogs />}
  </div>
);
