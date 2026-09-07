import React, { useEffect, useRef, useState } from 'react';

/**
 * กราฟของกลุ่ม "Activity Log" — วาดด้วย SVG ล้วน ไม่ดึงไลบรารีกราฟเข้าโปรเจกต์
 *
 * ทำไมไม่ใช้ recharts/chart.js: bundle ของ admin ตอนนี้ 626 kB อยู่แล้ว ไลบรารีกราฟ
 * ตัวเล็กสุดก็ยังเพิ่มอีกราว 100 kB gzip ไม่ได้ เพื่อกราฟ 3 แบบที่รูปทรงตายตัว
 * และเราต้องคุมสีให้วิ่งตาม CSS variable ของธีม (สลับมืด/สว่างได้) ซึ่งไลบรารีสำเร็จรูป
 * มักต้องแฮ็กเพิ่มอยู่ดี · ข้อแลกเปลี่ยน: ถ้าวันหน้าต้องการกราฟที่ซับซ้อนกว่านี้จริง ๆ
 * (zoom, brush, แกนคู่) ให้ทบทวนใหม่ อย่าดันไฟล์นี้ให้กลายเป็นไลบรารีเอง
 *
 * สีทุกจุดอ้าง CSS variable ไม่ฝังค่าฮาร์ดโค้ด — ธีมสว่างจึงได้กราฟที่อ่านออกฟรี
 */

/** วัดความกว้างจริงของกล่อง — SVG ต้องรู้ px จริง ไม่งั้นตัวอักษรบนแกนจะถูกยืดตาม viewBox */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setW(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/**
 * ขีดแกน Y — เลือก "ขั้น" เป็น 1/2/5 × กำลังสิบ แล้วไล่จาก 0 ขึ้นไปจนคลุมค่าสูงสุด
 *
 * ทำแบบนี้แทนการหารเพดานเป็น 4 ส่วนเท่า ๆ กัน เพราะการหารจะได้ป้ายอย่าง 0 · 1 · 3 · 4 · 5
 * (มาจากการปัดเศษ 1.25 กับ 3.75) ซึ่งอ่านแล้วสะดุด · ค่าที่นับได้เป็นจำนวนเต็มเสมอ
 * จึงไม่ใส่ 2.5 ไว้ในชุดตัวคูณ ป้ายจะได้ไม่มีจุดทศนิยมโผล่มา
 */
function axisTicks(maxVal: number): number[] {
  const raw = Math.max(1, maxVal) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map(m => m * mag).find(s => s >= raw) ?? 10 * mag;
  const count = Math.ceil(maxVal / step) || 1;
  return Array.from({ length: count + 1 }, (_, i) => i * step);
}

/**
 * เส้นโค้งผ่านทุกจุดแบบ quadratic ที่จุดกึ่งกลาง
 * เลือกวิธีนี้เพราะ "ไม่มีทางแกว่งเกินค่าจริง" ต่างจาก cubic spline ทั่วไปที่ขาลงชัน ๆ
 * อาจงอทะลุลงใต้ศูนย์ แล้วกราฟจะโกหกว่ามีชั่วโมงที่ค่าติดลบ
 */
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return '';
  if (pts.length < 3) return pts.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    d += ` Q${pts[i].x},${pts[i].y} ${mx},${my}`;
  }
  const last = pts[pts.length - 1];
  d += ` L${last.x},${last.y}`;
  return d;
}

export interface ChartSeries {
  key: string;
  label: string;
  /** สี CSS — ส่งเป็น var(--…) ได้ตรง ๆ */
  color: string;
  values: number[];
}

/**
 * กราฟเส้น + พื้นไล่สี รองรับหลายเส้น
 *
 * การชี้เมาส์จับ "ทั้งคอลัมน์" ไม่ใช่จับที่จุด — ผู้ใช้ไม่ต้องเล็งให้โดนจุดเล็ก ๆ
 * ค่าที่อ่านได้จึงเป็นของชั่วโมงที่ใกล้ตำแหน่งเมาส์ที่สุดเสมอ
 */
export const AreaChart: React.FC<{
  /** ป้ายกำกับของแต่ละจุด — โผล่เป็นหัวเรื่องในกล่องลอย */
  labels: string[];
  series: ChartSeries[];
  height?: number;
  /** จุดที่ต้องเตือน เช่นชั่วโมงที่ connection pool ไม่พอ — ขึ้นเป็นขีดสีแดงบนแกนล่าง */
  marks?: boolean[];
  markHint?: string;
  /** บรรทัดเพิ่มเติมในกล่องลอย เช่น p95 ของชั่วโมงนั้น */
  extra?: (i: number) => React.ReactNode;
  format?: (n: number) => string;
}> = ({ labels, series, height = 200, marks, markHint, extra, format = (n) => n.toLocaleString('th-TH') }) => {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const PAD = { top: 12, right: 12, bottom: 22, left: 44 };
  const n = labels.length;
  const innerW = Math.max(0, w - PAD.left - PAD.right);
  const innerH = height - PAD.top - PAD.bottom;

  const ticks = axisTicks(Math.max(1, ...series.flatMap(s => s.values)));
  const max = ticks[ticks.length - 1];
  const xAt = (i: number) => (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW) + PAD.left;
  const yAt = (v: number) => PAD.top + innerH - (v / max) * innerH;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - box.left - PAD.left;
    const i = n <= 1 ? 0 : Math.round((x / innerW) * (n - 1));
    setHover(Math.min(n - 1, Math.max(0, i)));
  };

  return (
    <div ref={ref} className="relative select-none" style={{ height }}>
      {w > 0 && n > 0 && (
        <svg
          width={w}
          height={height}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          className="touch-pan-y"
        >
          <defs>
            {series.map(s => (
              <linearGradient key={s.key} id={`grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity="0.30" />
                <stop offset="100%" stopColor={s.color} stopOpacity="0.02" />
              </linearGradient>
            ))}
          </defs>

          {/* เส้นกริด + ป้ายแกน Y */}
          {ticks.map(t => (
            <g key={t}>
              <line
                x1={PAD.left} x2={w - PAD.right} y1={yAt(t)} y2={yAt(t)}
                stroke="var(--c-line)" strokeDasharray={t === 0 ? undefined : '3 4'}
              />
              <text
                x={PAD.left - 8} y={yAt(t) + 3} textAnchor="end"
                fontSize="10" fill="var(--c-text-faint)" className="tabular-nums"
              >
                {format(t)}
              </text>
            </g>
          ))}

          {series.map(s => {
            const pts = s.values.map((v, i) => ({ x: xAt(i), y: yAt(v) }));
            const line = smoothPath(pts);
            return (
              <g key={s.key}>
                <path
                  d={`${line} L${xAt(n - 1)},${yAt(0)} L${xAt(0)},${yAt(0)} Z`}
                  fill={`url(#grad-${s.key})`}
                />
                <path d={line} fill="none" stroke={s.color} strokeWidth="2"
                      strokeLinecap="round" strokeLinejoin="round" />
              </g>
            );
          })}

          {/* ขีดเตือนใต้แกน — ข้อมูลนี้เคยสื่อด้วย "แท่งสีแดง" ซึ่งชนกับสีของเส้น error */}
          {marks?.map((m, i) => m && (
            <rect key={i} x={xAt(i) - 1.5} y={height - PAD.bottom + 3} width="3" height="4" rx="1.5"
                  fill="var(--color-red-600)">
              <title>{markHint}</title>
            </rect>
          ))}

          {/* เส้นชี้ + จุดของทุกเส้นในคอลัมน์ที่ชี้อยู่ */}
          {hover !== null && (
            <g>
              <line x1={xAt(hover)} x2={xAt(hover)} y1={PAD.top} y2={PAD.top + innerH}
                    stroke="var(--c-line-strong)" strokeWidth="1" />
              {series.map(s => (
                <circle key={s.key} cx={xAt(hover)} cy={yAt(s.values[hover] ?? 0)} r="3.5"
                        fill="var(--c-surface)" stroke={s.color} strokeWidth="2" />
              ))}
            </g>
          )}

          {/* ป้ายแกน X — เอาแค่หัวกับท้าย ป้ายทุกจุดจะทับกันจนอ่านไม่ออก */}
          <text x={PAD.left} y={height - 5} fontSize="10" fill="var(--c-text-faint)">{labels[0]}</text>
          <text x={w - PAD.right} y={height - 5} fontSize="10" fill="var(--c-text-faint)"
                textAnchor="end">{labels[n - 1]}</text>
        </svg>
      )}

      {/* กล่องลอย — เป็น HTML ไม่ใช่ <text> ใน SVG เพื่อให้จัดบรรทัด/ตัวเลขได้ตามปกติ */}
      {hover !== null && w > 0 && (
        <div
          className="pointer-events-none absolute top-1 z-10 rounded-xl border border-slate-200
                     bg-card shadow-lg px-3 py-2 text-[11px] whitespace-nowrap"
          style={{
            left: Math.min(Math.max(xAt(hover) - 70, 0), Math.max(0, w - 150)),
          }}
        >
          <div className="font-semibold text-slate-800">{labels[hover]}</div>
          {series.map(s => (
            <div key={s.key} className="flex items-center gap-2 mt-1">
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: s.color }} />
              <span className="text-slate-500">{s.label}</span>
              <span className="ml-auto font-medium text-slate-800 tabular-nums">
                {format(s.values[hover] ?? 0)}
              </span>
            </div>
          ))}
          {extra && <div className="mt-1 pt-1 border-t border-slate-100 text-slate-400">{extra(hover)}</div>}
        </div>
      )}
    </div>
  );
};

export interface DonutSlice {
  key: string;
  label: string;
  value: number;
  color: string;
}

/**
 * โดนัทสัดส่วน + คำอธิบายข้าง ๆ
 *
 * ใช้ได้เฉพาะกับข้อมูลที่ "รวมกันแล้วเท่ากับ 100% จริง ๆ" เท่านั้น (เช่นกลุ่ม status ของ request)
 * ห้ามเอาไปใช้กับอันดับ endpoint — วงกลมที่มี 20 ชิ้นอ่านไม่ออก และเทียบขนาดกันด้วยตาไม่ได้
 * ของแบบนั้นใช้แถบแนวนอนเรียงลำดับซึ่งอ่านง่ายกว่าเสมอ
 */
export const Donut: React.FC<{
  slices: DonutSlice[];
  size?: number;
  centerLabel?: string;
}> = ({ slices, size = 168, centerLabel = 'ทั้งหมด' }) => {
  const [hover, setHover] = useState<string | null>(null);
  const total = slices.reduce((a, s) => a + s.value, 0);
  const r = size / 2 - 14;
  const c = 2 * Math.PI * r;

  // ความยาวส่วนโค้งของแต่ละชิ้น แล้วเลื่อนจุดเริ่มด้วยผลรวมของชิ้นก่อนหน้า
  // (คิดแบบผลรวมสะสมแทนการบวกทับตัวแปรเดิม — กติกา react-hooks/immutability)
  const drawn = slices.filter(s => s.value > 0);
  const lens = drawn.map(s => (total > 0 ? (s.value / total) * c : 0));
  const arcs = drawn.map((s, i) => ({
    ...s,
    len: lens[i],
    offset: -lens.slice(0, i).reduce((a, b) => a + b, 0),
  }));

  const focus = hover ? slices.find(s => s.key === hover) : null;
  const shown = focus ?? null;

  return (
    // วงกับคำอธิบายอยู่ "ข้างกัน" ไม่ใช่บนล่าง — การ์ดนี้วางคู่กับกราฟเส้นในกริดเดียวกัน
    // ถ้าเรียงลงมาการ์ดจะสูงเกินเพื่อนจนแถวดูไม่เท่ากัน · ตกบรรทัดเฉพาะตอนจอแคบจริง ๆ
    <div className="flex items-center justify-center gap-4 flex-wrap">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none"
                  stroke="var(--c-surface-3)" strokeWidth="14" />
          {arcs.map(a => (
            <circle
              key={a.key}
              cx={size / 2} cy={size / 2} r={r} fill="none"
              stroke={a.color}
              strokeWidth={hover === a.key ? 20 : 14}
              strokeDasharray={`${a.len} ${c - a.len}`}
              strokeDashoffset={a.offset}
              strokeLinecap="butt"
              className="transition-all duration-150 cursor-default"
              onPointerEnter={() => setHover(a.key)}
              onPointerLeave={() => setHover(null)}
            />
          ))}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <div className="text-xl font-bold text-slate-900 tabular-nums">
            {(shown ? shown.value : total).toLocaleString('th-TH')}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-slate-400 text-center px-4">
            {shown ? shown.label : centerLabel}
          </div>
        </div>
      </div>

      <div className="space-y-1 text-[11px] min-w-44 flex-1">
        {slices.map(s => (
          <div
            key={s.key}
            onPointerEnter={() => setHover(s.key)}
            onPointerLeave={() => setHover(null)}
            className={`flex items-center gap-2 rounded-lg px-2 py-1 transition-colors ${
              hover === s.key ? 'bg-slate-50' : ''
            }`}
          >
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: s.color }} />
            <span className="text-slate-600">{s.label}</span>
            <span className="ml-auto tabular-nums text-slate-800 font-medium">
              {s.value.toLocaleString('th-TH')}
            </span>
            <span className="tabular-nums text-slate-400 w-11 text-right">
              {total > 0 ? `${(s.value * 100 / total).toFixed(1)}%` : '—'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

/** คำอธิบายสีของกราฟ — วางบนหัวการ์ดคู่กับชื่อกราฟ */
export const ChartLegend: React.FC<{ items: { label: string; color: string }[] }> = ({ items }) => (
  <div className="flex items-center gap-3 text-[11px] text-slate-500 shrink-0">
    {items.map(i => (
      <span key={i.label} className="inline-flex items-center gap-1.5">
        <span className="w-2.5 h-0.5 rounded-full" style={{ background: i.color }} />
        {i.label}
      </span>
    ))}
  </div>
);
