#!/usr/bin/env bash
# เทียบ "ส่วน A" ของ AGENTS.md สองรีโปว่ายังเป็นข้อความชุดเดียวกันอยู่ไหม
#
# ส่วน A คือกติกาการทำงานบนเครื่อง dev เครื่องนี้ ซึ่งทั้ง primus-chat และ sales-chatbot
# ใช้ร่วมกัน แต่เก็บเป็นสำเนาคนละไฟล์ เพราะกฎต้องเดินทางไปกับ repo (primus-chat มี agent
# รันบนเครื่อง server ด้วย) สำเนาไม่พังตอนก๊อป มันพังตอนที่แก้ไปที่เดียว — สคริปต์นี้คือตัวจับ
#
# ใช้: bash tools/diff-section-a.sh [path ของ AGENTS.md อีกรีโป]

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/AGENTS.md"
THERE="${1:-}"

if [ -z "$THERE" ]; then
  for guess in ../primus-chat/AGENTS.md ../sales-chatbot/AGENTS.md ../chatbot/AGENTS.md; do
    [ -f "$guess" ] || continue
    [ "$(cd "$(dirname "$guess")" && pwd)" = "$(dirname "$HERE")" ] && continue
    THERE="$guess"
    break
  done
fi

if [ -z "$THERE" ] || [ ! -f "$THERE" ]; then
  echo "หาไฟล์ AGENTS.md ของอีกรีโปไม่เจอ — ส่ง path มาเป็นอาร์กิวเมนต์"
  exit 2
fi

extract() {
  # tr -d '\r' เพราะสองรีโปอาจ checkout คนละ line ending (Windows ได้ CRLF ผ่าน
  # core.autocrlf ส่วน Linux ได้ LF) — เราเทียบ "เนื้อ" ไม่ใช่ท้ายบรรทัด
  sed -n '/ส่วน A: เริ่ม/,/ส่วน A: จบ/p' "$1" | tr -d '\r'
}

A="$(extract "$HERE")"
B="$(extract "$THERE")"

if [ -z "$A" ]; then echo "ไม่พบมาร์กเกอร์ส่วน A ใน $HERE"; exit 2; fi
if [ -z "$B" ]; then echo "ไม่พบมาร์กเกอร์ส่วน A ใน $THERE"; exit 2; fi

if [ "$A" = "$B" ]; then
  echo "ส่วน A ตรงกัน ($(printf '%s\n' "$A" | wc -l | tr -d ' ') บรรทัด)"
  echo "  $HERE"
  echo "  $THERE"
  exit 0
fi

echo "ส่วน A ไม่ตรงกัน — มีรีโปหนึ่งถูกแก้แล้วอีกรีโปยังไม่ตาม"
echo "  < $HERE"
echo "  > $THERE"
echo
diff <(printf '%s\n' "$A") <(printf '%s\n' "$B") || true
exit 1
