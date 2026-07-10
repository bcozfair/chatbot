import { db, openai } from '../config/clients.js';
import Fuse from 'fuse.js';

const STOP_WORDS = new Set([
  'บริษัท', 'จำกัด', 'มหาชน', 'หจก', 'บจก', 'ห้างหุ้นส่วน', 'สำนักงานใหญ่', 'สาขา',
  'แอนด์', 'and',
  'เซอร์วิส', 'service', 'services',
  'ซัพพลาย', 'supply', 'supplies',
  'อินเตอร์', 'inter',
  'เทรดดิ้ง', 'trading',
  'เอ็นจิเนียริ่ง', 'engineering',
  'ประเทศไทย', 'thailand',
  'กรุ๊ป', 'group',
  'ไทย', 'thai',
  'บิลดิ้ง', 'building',
  'มาเก็ตติ้ง', 'marketing',
  'โลจิสติกส์', 'logistics',
  'โซลูชั่น', 'solution', 'solutions',
  'คอนสตรัคชั่น', 'construction',
  'โฮลดิ้ง', 'holding', 'holdings',
  'แมเนจเม้นท์', 'management',
  'ซิสเต็ม', 'system', 'systems',
  'พาร์ท', 'part', 'parts',
  'ออโตเมชั่น', 'automation',
  'เทคโนโลยี', 'technology', 'technologies',
  'อุตสาหกรรม', 'industry', 'industries',
  'การค้า', 'trade',
  'สยาม', 'siam',
  'คอร์ปอเรชั่น', 'corporation', 'corp',
  'อินเตอร์เนชั่นแนล', 'international',
  'โปรดักส์', 'product', 'products',
  'เซ็นเตอร์', 'center', 'centre',
  'ดีเวลลอปเม้นท์', 'development',
  'ซิสเท็ม', 'จำหน่าย'
]);

export function cleanCompanyName(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .replace(/(บริษัท|จำกัด|มหาชน|หจก\.|หจก|บจก\.|บจก|ห้างหุ้นส่วนจำกัด|สำนักงานใหญ่|สาขาที่\s*\d+|สาขา|^บ\.\s*|^บ\s+)/g, '')
    .replace(/[()\[\]{}.,\\/|:;!?^$*+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanContactName(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .replace(/^(คุณ|นาย|นางสาว|นาง|นายแพทย์|แพทย์หญิง|ดร\.)/g, '')
    .trim();
}

export function formatLineLabel(text: string | null | undefined): string {
  if (!text) return '';
  // ลบเฉพาะคำนำหน้า "บริษัท" ออก แต่คง "(สำนักงานใหญ่)", "(ประเทศไทย)", สาขาฯ ไว้
  // เพื่อให้ label แยกแยะระหว่างบริษัทที่ชื่อคล้ายกันได้
  const trimmed = text
    .replace(/^บริษัท\s*/g, '')          // ลบ "บริษัท" นำหน้า
    .replace(/\s*จำกัด\s*\(มหาชน\)\s*$/, '') // ลบ "จำกัด (มหาชน)" ท้าย
    .replace(/\s*จำกัด\s*$/, '')           // ลบ "จำกัด" ท้าย
    .replace(/\s+/g, ' ')
    .trim();
  return trimmed;
}


/**
 * buildDotInitialVariants
 * สร้าง search variant สำหรับชื่อที่ใช้จุดคั่นตัวย่อ เช่น "บ.เอ.เค.พลาสติก"
 * คืนค่า: ["เอ.เค.พลาสติก", "เอเคพลาสติก"]
 *
 * ใช้เฉพาะเมื่อ raw text มี pattern ตัวอักษรเดี่ยว+จุดติดกัน ≥ 2 ตัว
 * Flow เดิม (cleanCompanyName) ไม่ถูกแตะ — ทำงานแยกกัน
 */
function buildDotInitialVariants(rawText: string): string[] {
  if (!rawText) return [];

  // ตรวจว่ามีตัวอักษร+จุด ≥ 2 ตำแหน่งในข้อความ (ไม่ต้องติดกัน)
  // ❌ เดิม: /(?:[\u0E00-\u0E7Fa-zA-Z]\.){2,}/ ← ต้องติดกัน (ไม่ work กับ Thai syllable เช่น เอ.เค.)
  // ✅ ใหม่: นับ occurrences ทั้งหมด ≥ 2
  const dotMatches = rawText.match(/[\u0E00-\u0E7Fa-zA-Z]\./g);
  // ≥ 1 → รองรับทั้ง single-initial ("ก.แสงทอง") และ multi-initial ("เอ.เค.")
  // เดิมใช้ ≥ 2 ทำให้ single-initial ถูกค้นด้วย space ("ก แสงทอง") แล้วไม่เจอ record ที่เก็บเป็น dot
  if (!dotMatches || dotMatches.length < 1) return [];

  // ลบคำนำหน้า/ท้าย แต่คงจุดระหว่าง initials ไว้
  const stripped = rawText
    .replace(/^(\u0E1A\u0E23\u0E34\u0E29\u0E31\u0E17\s+|\u0E1A\.\s*|\u0E1A\u0E08\u0E01\.\s*|\u0E2B\u0E08\u0E01\.\s*|\u0E23\u0E49\u0E32\u0E19\s*|\u0E2B\u0E49\u0E32\u0E07\u0E2B\u0E38\u0E49\u0E19\u0E2A\u0E48\u0E27\u0E19\u0E08\u0E33\u0E01\u0E31\u0E14\s*)/i, '')
    .replace(/\s*(\u0E08\u0E33\u0E01\u0E31\u0E14(\s*\(\u0E21\u0E2B\u0E32\u0E0A\u0E19\))?\s*|\(\u0E2A\u0E33\u0E19\u0E31\u0E01\u0E07\u0E32\u0E19\u0E43\u0E2B\u0E0D\u0E48\)|\(\u0E2A\u0E32\u0E02\u0E32[^)]*\)|Co\.?,?\s*Ltd\.?|Ltd\.?)\s*$/i, '')
    .replace(/[()[\]{}\\/|:;!?^$*+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!stripped || stripped.length < 2) return [];

  const variants: string[] = [];

  // Variant 1: dot-preserved full — "เอ.เค.พลาสติก" คงจุดไว้ทั้งหมด
  if (stripped !== rawText.trim()) {
    variants.push(stripped);
  }

  // Variant 2: compressed — ลบจุดออกโดยไม่ใส่ space → "เอเคพลาสติก"
  const compressed = stripped.replace(/\./g, '');
  if (compressed && compressed !== stripped && compressed.length >= 2) {
    variants.push(compressed);
  }

  // Variant 3: abbreviation prefix เท่านั้น — ตัดเฉพาะส่วน X.Y. ออกมา
  // เพื่อ match DB แม้ spelling ส่วนท้ายจะต่างกัน เช่น "แมสชีน" vs "แมชชิน"
  // "เอ.เค.พลาสติก" → abbrev = "เอ.เค" → ilike "%เอ.เค%" จะ match "เอ.เค.พลาสติกแมชชินเนอรี่"
  const abbrevMatch = stripped.match(/^((?:[\u0E00-\u0E7Fa-zA-Z]+\.)+)/);
  if (abbrevMatch) {
    const abbrev = abbrevMatch[1].replace(/\.$/, ''); // ตัด trailing dot
    if (abbrev && abbrev.length >= 2 && !variants.includes(abbrev)) {
      variants.push(abbrev);
    }
  }

  return variants;
}


export async function findCustomerCandidates(customerQuery: string, salesperson: any, contactQuery?: string): Promise<any[]> {
  if (!customerQuery) return [];

  // Split query by newlines first
  const rawLines = customerQuery.split('\n').map(l => l.trim()).filter(Boolean);
  if (rawLines.length === 0) return [];

  const referenceCodes = new Set<string>();
  const refRegex = /\b[A-Z][\/-]?\d{3,8}(?:\(\d+\))?(?![a-zA-Z0-9])/gi;

  for (const line of rawLines) {
    // Extract reference codes (e.g. A022914 or A011030(2) or A/35871)
    const matches = line.match(refRegex);
    if (matches) {
      for (const match of matches) {
        const cleanRef = match.replace(/[()]/g, '').trim();
        const normRef = cleanRef.replace(/[\/\s-]/g, '').trim();
        const numOnly = cleanRef.replace(/[^0-9]/g, '').trim();

        referenceCodes.add(match);
        referenceCodes.add(cleanRef);
        referenceCodes.add(normRef);
        if (numOnly.length >= 3) {
          referenceCodes.add(numOnly);
        }
      }
    }

    // Split by whitespace to check individual words for reference codes
    const words = line.split(/\s+/).map(w => w.trim()).filter(Boolean);
    for (const word of words) {
      if (word.match(/^[A-Z]?[\/-]?\d{3,8}(?:\(\d+\))?$/i)) {
        const cleanRef = word.replace(/[()]/g, '').trim();
        const normRef = cleanRef.replace(/[\/\s-]/g, '').trim();
        const numOnly = cleanRef.replace(/[^0-9]/g, '').trim();

        referenceCodes.add(word);
        referenceCodes.add(cleanRef);
        referenceCodes.add(normRef);
        if (numOnly.length >= 3) {
          referenceCodes.add(numOnly);
        }
      }
    }
  }

  // --- Step A: ถ้ารู้รหัส Reference ลองค้นจากรหัสก่อนเป็นอันดับแรก (Fast-path) ---
  if (referenceCodes.size > 0) {
    const refArray = Array.from(referenceCodes).filter(Boolean);
    const filterParts = refArray.map(ref => `reference.ilike.%${ref}%`);
    const refQuery: any = (db.from('customers') as any)
      .select('id, display_name, reference, branch_code, salesperson')
      .or(filterParts.join(','));

    const { data: refData, error: refError } = await refQuery.limit(30);
    if (refError) console.error("Ref query error:", refError);

    if (refData && refData.length > 0) {
      console.log(`[findCustomerCandidates] Found ${refData.length} candidates by reference codes (Fast-path)!`);
      
      const candidates = refData.map((c: any) => {
        const refLower = c.reference ? c.reference.toLowerCase().trim() : '';
        const refClean = refLower.replace(/[^a-z0-9]/g, '');
        
        let score = 0.5; // คะแนนเริ่มต้นสำหรับ match
        
        // เช็คว่าตรงเป๊ะในชุด normalized refs หรือไม่
        const isExact = refArray.some(r => {
          const cleanInput = r.toLowerCase().replace(/[^a-z0-9]/g, '');
          return cleanInput === refClean;
        });

        if (isExact) {
          score = 0.0; // ตรงเป๊ะ
        } else {
          const isFuzzy = refArray.some(r => {
            const cleanInput = r.toLowerCase().replace(/[^a-z0-9]/g, '');
            return refClean.includes(cleanInput) || cleanInput.includes(refClean);
          });
          if (isFuzzy) {
            score = 0.1; // เป็นสาขา หรือมีเลขท้ายห้อย
          }
        }

        return {
          item: {
            ...c,
            cleanName: cleanCompanyName(c.display_name)
          },
          score
        };
      });

      candidates.sort((a: any, b: any) => a.score - b.score);
      console.log('[findCustomerCandidates] Fast-path by Reference results:', candidates.map((r: any) => `${r.item.display_name} (score: ${r.score})`));
      return candidates;
    }
  }

  // --- Step B: ถ้าไม่พบรหัส Reference หรือหาจากรหัสไม่เจอ ค่อยค้นหาด้วยชื่อ ---
  const nameTerms = new Set<string>();
  const cleanedLines: string[] = [];

  // --- Pre-Search AI Normalizer (สกัดชื่อแกนกลางของบริษัทก่อนค้นหาจริง) ---
  let aiExtractedName = '';
  if (customerQuery) {
    try {
      console.log(`[findCustomerCandidates] Invoking AI (Pre-Search) to extract Core Name from: "${customerQuery.replace(/\n/g, ' ')}"`);
      const response = await openai.chat.completions.create({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'user',
            content: `วิเคราะห์ชื่อบริษัทที่ส่งมา และสกัดเฉพาะ "ชื่อเรียกหลักแกนกลาง" (Core Name/Brand Name) ออกมาเพื่อนำไปค้นหาต่อ
กติกา:
- ลบคำนำหน้า/คำย่อ เช่น บ., บจก., หจก., บริษัท, ร้าน, ห้างหุ้นส่วนจำกัด ออกทั้งหมด
- ลบคำต่อท้าย เช่น จำกัด, (มหาชน), Co., Ltd., Ltd. ออกทั้งหมด
- ลบวงเล็บ เช่น (สำนักงานใหญ่), (สาขา...) ออก
- คงเหลือเฉพาะตัวสะกดชื่อหลัก เช่น "บ.เคยู พลัส" -> "เคยู พลัส", "บริษัท ย่งฮง (ประเทศไทย) จำกัด" -> "ย่งฮง", "KU group" -> "KU"

ชื่อบริษัทที่ต้องการวิเคราะห์: "${customerQuery.split('\n')[0]}"

ตอบเฉพาะชื่อแกนกลางที่สกัดได้เท่านั้น ห้ามเขียนอธิบายใดๆ`
          }
        ]
      });

      const extracted = (response.choices[0].message.content || '').trim();
      aiExtractedName = cleanCompanyName(extracted);
      if (aiExtractedName) {
        console.log(`[findCustomerCandidates] AI extracted Core Name: "${aiExtractedName}"`);
        cleanedLines.push(aiExtractedName);
        nameTerms.add(aiExtractedName);
      }

      // dot-initial variants จาก raw ก่อน clean (AI output ยังมีจุดอยู่)
      const aiDotVariants = buildDotInitialVariants(extracted);
      if (aiDotVariants.length > 0) {
        console.log(`[findCustomerCandidates] dot-variants from AI: ${JSON.stringify(aiDotVariants)}`);
        aiDotVariants.forEach(v => { if (!cleanedLines.includes(v)) cleanedLines.push(v); });
      }
    } catch (err) {
      console.error('[findCustomerCandidates] Pre-Search AI extraction error:', err);
    }
  }

  for (const line of rawLines) {
    const cleanLine = cleanCompanyName(line);
    if (cleanLine) {
      cleanedLines.push(cleanLine);
    }

    // dot-initial variants จาก raw line ก่อน cleanCompanyName ลบจุดออก
    const lineDotVariants = buildDotInitialVariants(line);
    if (lineDotVariants.length > 0) {
      lineDotVariants.forEach(v => { if (!cleanedLines.includes(v)) cleanedLines.push(v); });
    }

    const words = line.split(/\s+/).map(w => w.trim()).filter(Boolean);
    for (const word of words) {
      if (!word.match(/^[A-Z]?[\/-]?\d{3,8}(?:\(\d+\))?$/i)) {
        const cleanW = cleanCompanyName(word);
        if (cleanW && cleanW.length >= 2) { // ปรับความยาวขั้นต่ำเป็น 2
          if (!STOP_WORDS.has(cleanW.toLowerCase())) {
            nameTerms.add(cleanW);
          }
        }
      }
    }
  }

  console.log('[findCustomerCandidates] cleanedLines (phrases):', cleanedLines);
  console.log('[findCustomerCandidates] nameTerms (words):', Array.from(nameTerms));
  console.log('[findCustomerCandidates] salesperson.branch_code:', salesperson?.branch_code);

  const dbCustomersMap = new Map<any, any>();

  // 1. Query by cleaned lines (phrases match display_name — NO branch_code filter)
  if (cleanedLines.length > 0) {
    const filterParts = cleanedLines.map(line => `display_name.ilike.%${line}%`);
    const phraseQuery: any = (db.from('customers') as any)
      .select('id, display_name, reference, branch_code, salesperson')
      .or(filterParts.join(','));

    const { data: phraseData, error: phraseError } = await phraseQuery.limit(30);
    if (phraseError) console.error("Phrase query error:", phraseError);
    console.log('[findCustomerCandidates] phraseData count:', phraseData?.length);
    if (phraseData) {
      phraseData.forEach((c: any) => dbCustomersMap.set(c.id, c));
    }
  }

  // 2. Query by individual name terms (words match display_name — NO branch_code filter)
  if (nameTerms.size > 0) {
    const nameArray = Array.from(nameTerms).filter(Boolean);
    const filterParts = nameArray.map(term => `display_name.ilike.%${term}%`);
    const nameQuery: any = (db.from('customers') as any)
      .select('id, display_name, reference, branch_code, salesperson')
      .or(filterParts.join(','));

    const { data: nameData, error: nameError } = await nameQuery.limit(50);
    if (nameError) console.error("Name query error:", nameError);
    console.log('[findCustomerCandidates] nameData count:', nameData?.length);
    if (nameData) {
      nameData.forEach((c: any) => {
        if (!dbCustomersMap.has(c.id)) {
          dbCustomersMap.set(c.id, c);
        }
      });
    }
  }

  const dbCustomers = Array.from(dbCustomersMap.values());

  const candidates = dbCustomers.map(c => ({
    ...c,
    cleanName: cleanCompanyName(c.display_name)
  }));

  // ดึง abbrev prefix จาก cleanedLines (เช่น "เอ.เค") เพื่อใช้เป็น mandatory filter
  const abbrevPrefix = cleanedLines.find(v => /^[\u0E00-\u0E7Fa-zA-Z]+\.[\u0E00-\u0E7Fa-zA-Z]/.test(v) && !v.includes(' ') && v.length <= 10);

  // กรองเฉพาะ candidate ที่มี core keyword ของ AI (aiExtractedName) อยู่ในชื่อ
  const coreKeywords = aiExtractedName
    ? aiExtractedName.split(/\s+/).filter(w => w.length >= 3 && !STOP_WORDS.has(w.toLowerCase()))
    : [];

  // ถ้ามี abbrevPrefix หรือ coreKeywords → กรอง candidates
  let filteredCandidates = candidates;
  if (abbrevPrefix || coreKeywords.length > 0) {
    const strict = candidates.filter(c => {
      const nameLower = (c.display_name || '').toLowerCase();
      // ต้องผ่าน abbrev check (ถ้ามี) เช่น ชื่อต้องมี "เอ.เค"
      const passAbbrev = abbrevPrefix ? nameLower.includes(abbrevPrefix.toLowerCase()) : true;
      // และต้องมี keyword อย่างน้อย 1 คำ (ถ้ามี) — ใช้ partial match เพื่อรองรับ spelling ต่างกัน
      const passKeyword = coreKeywords.length > 0
        ? coreKeywords.some(kw => {
            // partial match: ตัดจาก 4 ตัวแรกของ keyword เพื่อรองรับ "พลาสติก" vs "พลาสติก"
            const kwPartial = kw.slice(0, 4);
            return nameLower.includes(kwPartial.toLowerCase());
          })
        : true;
      return passAbbrev && passKeyword;
    });
    // fallback ถ้ากรองแล้วไม่เหลือเลย
    if (strict.length > 0) filteredCandidates = strict;
  }

  const fuse = new (Fuse as any)(filteredCandidates, {
    keys: ['cleanName', 'display_name', 'reference'],
    threshold: 0.35,
    includeScore: true
  });

  const resultsMap = new Map<any, any>();

  // Run Fuse search
  for (const cleanedLine of cleanedLines) {
    const results = fuse.search(cleanedLine);
    for (const r of results) {
      const existing = resultsMap.get(r.item.id);
      if (!existing || existing.score > r.score) {
        resultsMap.set(r.item.id, { item: r.item, score: r.score });
      }
    }
  }

  // Exact display_name / cleanName match boosting
  for (const c of filteredCandidates) {
    for (const line of rawLines) {
      const lineLower = line.toLowerCase().trim();
      // Exact display_name match
      if (c.display_name && c.display_name.toLowerCase() === lineLower) {
        resultsMap.set(c.id, { item: c, score: 0.0 });
      }
      // display_name contains the query or query contains display_name
      if (c.display_name && (c.display_name.toLowerCase().includes(lineLower) || lineLower.includes(c.display_name.toLowerCase()))) {
        const existing = resultsMap.get(c.id);
        if (!existing || existing.score > 0.01) {
          resultsMap.set(c.id, { item: c, score: 0.01 });
        }
      }
    }
    for (const cleanedLine of cleanedLines) {
      const cleanLower = cleanedLine.toLowerCase().trim();
      if (c.cleanName && c.cleanName.toLowerCase() === cleanLower) {
        resultsMap.set(c.id, { item: c, score: 0.0 });
      }
    }
  }

  console.log('[findCustomerCandidates] Final results before AI check:', Array.from(resultsMap.values()).map(r => `${r.item.display_name} (score: ${r.score})`));

  let finalCandidates = Array.from(resultsMap.values())
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))
    .slice(0, 8);

  // AI Matching logic:
  // If there are multiple candidates and we have a customerQuery, use AI to select the best one
  if (finalCandidates.length > 1 && customerQuery) {
    try {
      // ดึงรายชื่อผู้ติดต่อผูกร่วมกับ Candidates แต่ละตัวเพื่อความแม่นยำ
      for (const c of finalCandidates) {
        const { data: contactsData } = await (db.from('contacts') as any)
          .select('name')
          .eq('customer_id', c.item.id);
        c.contacts = contactsData ? contactsData.map((co: any) => co.name) : [];
      }

      // ── Log ข้อมูลที่ส่งให้ AI ─────────────────────────────────────────
      console.log(`[AI-Customer] ══════════════════════════════════════`);
      console.log(`[AI-Customer] customerQuery : "${customerQuery}"`);
      console.log(`[AI-Customer] contactQuery  : "${contactQuery || '-'}"`);
      console.log(`[AI-Customer] candidates (${finalCandidates.length}):`);
      finalCandidates.forEach((c, i) => {
        console.log(`  ${i + 1}. "${c.item.display_name}" | ref: ${c.item.reference || '-'} | contacts: [${(c.contacts || []).join(', ')}]`);
      });

      const response = await openai.chat.completions.create({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'user',
            content: `คุณคือผู้เชี่ยวชาญการวิเคราะห์ชื่อลูกค้าจากข้อความแชท (Customer Matcher)
งานของคุณคือจับคู่ข้อความคำสั่งซื้อ/เสนอราคา (Quotation Chat) กับรายการชื่อบริษัทในระบบให้ถูกต้อง

ข้อความแชทจากลูกค้า:
"${customerQuery}"

ชื่อผู้ติดต่อที่เซลส์ระบุในแชท: "${contactQuery || '-'}"

รายการชื่อบริษัทที่เป็นตัวเลือก (Candidates):
${finalCandidates.map((c, i) => `${i + 1}. ชื่อบริษัท: "${c.item.display_name}" | รหัสลูกค้า: "${c.item.reference || '-'}" | ผู้ติดต่อในระบบของบริษัทนี้: [${(c.contacts || []).join(', ')}]`).join('\n')}

กติกาการเลือก (ต้องปฏิบัติตามลำดับเคร่งครัด):

1. ตรวจสอบชื่อผู้ติดต่อก่อน (สำคัญที่สุด):
   - เปรียบเทียบชื่อผู้ติดต่อในแชท กับ "ผู้ติดต่อในระบบ" ของแต่ละบริษัท
   - หากชื่อผู้ติดต่อตรงหรือใกล้เคียงกับบริษัทใดบริษัทหนึ่งอย่างชัดเจน → เลือกบริษัทนั้น
   - หากชื่อผู้ติดต่อ **ไม่ตรงกับผู้ติดต่อในระบบของบริษัทใดเลย** → ตอบ 0 ทันที ห้ามเดา

2. หากไม่มีชื่อผู้ติดต่อในแชท ให้วิเคราะห์ชื่อบริษัทแทน:
   - หากในแชทระบุคำว่า "สำนักงานใหญ่", "hq", "headquarter", "สนญ" ให้มองหาตัวเลือกที่เป็นสำนักงานใหญ่
   - หากในแชทระบุสาขา (เช่น สาขา 1, สาขา ชลบุรี) ให้มองหาตัวเลือกที่เป็นสาขาที่ตรงกัน
   - หากชื่อบริษัทคลุมเครือ ไม่มีข้อมูลแยกแยะได้ → ตอบ 0

3. ตอบเป็น JSON รูปแบบนี้เท่านั้น ห้ามเพิ่มข้อความอื่น:
   {"choice": <ตัวเลข 1-${finalCandidates.length} หรือ 0>, "reason": "<อธิบายสั้นๆ ว่าเลือกเพราะอะไร หรือทำไมถึงตอบ 0>"}

⚠️ ข้อห้ามเด็ดขาด:
- ห้ามเดาว่าผู้ติดต่อ "น่าจะอยู่ในกลุ่ม" ของบริษัทใด
- ห้ามเลือกบริษัทที่มีผู้ติดต่อมากที่สุดโดยไม่มีการ match ที่แท้จริง
- ถ้าไม่มีหลักฐานชัดเจน ให้ตอบ 0 เสมอ`
          }
        ]
      });

      const rawAnswer = (response.choices[0].message.content || '').trim();
      console.log(`[AI-Customer] RAW response : ${rawAnswer}`);

      // Parse JSON response พร้อม fallback
      let answer = '0';
      try {
        const jsonMatch = rawAnswer.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          answer = String(parsed.choice ?? 0);
          console.log(`[AI-Customer] CHOICE : ${answer}`);
          console.log(`[AI-Customer] REASON : ${parsed.reason || '-'}`);
        } else {
          answer = rawAnswer.replace(/\D/g, '') || '0';
          console.log(`[AI-Customer] CHOICE (no-json fallback): ${answer}`);
        }
      } catch {
        answer = rawAnswer.replace(/\D/g, '') || '0';
        console.log(`[AI-Customer] CHOICE (parse-error fallback): ${answer}`);
      }
      console.log(`[AI-Customer] ══════════════════════════════════════`);
      const idx = parseInt(answer, 10) - 1;

      if (idx >= 0 && idx < finalCandidates.length) {
        const chosenCandidate = finalCandidates[idx];
        console.log(`[AI-Customer] ✅ chosen: ${chosenCandidate.item.display_name}`);
        
        finalCandidates.forEach((c, index) => {
          if (index === idx) {
            c.score = 0.0;
          } else {
            // ปรับคะแนนตัวเลือกอื่นๆ ให้อ่อนลง (penalty)
            if (c.score === undefined || c.score <= 0.2) {
              c.score = 0.3;
            }
          }
        });
      }
    } catch (err) {
      console.error('[findCustomerCandidates] AI selection error:', err);
    }
  }

  finalCandidates.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
  console.log('[findCustomerCandidates] Final results after AI check:', finalCandidates.map(r => `${r.item.display_name} (score: ${r.score})`));

  return finalCandidates;
}

const normalizePhone = (phoneStr: string | null | undefined): string => {
  if (!phoneStr) return '';
  const digits = phoneStr.replace(/[^0-9]/g, '');
  if (digits.length >= 9) {
    return digits.slice(-9);
  }
  return digits;
};

export function cleanContactNameExtra(name: string | null | undefined): string {
  if (!name) return '';
  // 1. Remove phone numbers
  let cleaned = name.replace(/0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}/g, '');
  // 2. Remove common title/position words
  const titles = [
    'คุณ', 'นาย', 'นางสาว', 'นาง', 'นายแพทย์', 'แพทย์หญิง', 'ดร.',
    'จัดซื้อ', 'จัดซื้อ/ประสานงาน', 'ประสานงาน', 'ฝ่ายจัดซื้อ',
    'วิศวกร', 'ช่าง', 'ธุรการ', 'บัญชี', 'การเงิน', 'HR'
  ];
  for (const t of titles) {
    cleaned = cleaned.replace(new RegExp(t, 'gi'), '');
  }
  // 3. Remove punctuation
  cleaned = cleaned.replace(/[()\[\]{}.,\\/|:;!?^$*+_-]/g, ' ');
  cleaned = cleaned.replace(/\s+/g, ' ');
  return cleaned.trim();
}

export async function findContactCandidates(customerId: any, contactQuery: string): Promise<any[]> {
  const phoneRegex = /0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}/g;
  const phoneMatches = contactQuery.match(phoneRegex) || [];
  const searchPhones = phoneMatches.map(p => normalizePhone(p)).filter(Boolean);

  const cleaned = cleanContactNameExtra(contactQuery);

  const { data: dbContacts, error } = await (db.from('contacts') as any)
    .select('id, name, mobile, phone, email, invoice_street, invoice_district, invoice_sub_district, invoice_state, invoice_zip')
    .eq('customer_id', customerId);

  if (error || !dbContacts || dbContacts.length === 0) {
    return [];
  }

  // Fetch company default address once
  let companyDefaultAddr: any = null;
  const { data: companyRows } = await (db.from('customers_raw') as any)
    .select('invoice_street, invoice_district, invoice_sub_district, invoice_state, invoice_zip')
    .eq('company_id', customerId)
    .order('contact_id', { ascending: true });

  if (companyRows && companyRows.length > 0) {
    companyDefaultAddr = companyRows.find((r: any) => r.invoice_street && r.invoice_street.trim()) || 
                         companyRows.find((r: any) => r.invoice_state && r.invoice_state.trim()) || 
                         companyRows[0];
  }

  // Construct address_complete on JavaScript side for each contact
  const cleanState = (s: any) => String(s || '').replace(/\s*\(.*/, '').split(/\s+/)[0].trim();
  const cleanAddressField = (fieldVal: any, rawState: any, zip: any) => {
    if (!fieldVal) return '';
    const cleanZip = String(zip || '').trim();
    const cleanStateVal = String(rawState || '').replace(/\s*\(.*/, '').trim();
    const words = fieldVal.split(/[\s,]+/).map((w: any) => w.trim()).filter(Boolean);
    const filtered = words.filter((word: any) => {
      const wordLower = word.toLowerCase();
      if (cleanZip && wordLower === cleanZip.toLowerCase()) return false;
      if (['thailand', 'th', 'china', 'taiwan', 'malaysia', 'singapore', 'israel'].includes(wordLower)) return false;
      if (cleanStateVal) {
        const stateLower = cleanStateVal.toLowerCase();
        if (stateLower.includes(wordLower) || wordLower.includes(stateLower)) return false;
      }
      return true;
    });
    return filtered.join(' ');
  };

  const contactsWithAddr = dbContacts.map((c: any) => {
    const hasAddr = (c.invoice_street && c.invoice_street.trim()) || (c.invoice_state && c.invoice_state.trim());
    const target = hasAddr ? c : (companyDefaultAddr || c);

    const stateCleaned = cleanState(target.invoice_state);
    const districtCleaned = cleanAddressField(target.invoice_district, target.invoice_state, target.invoice_zip);
    const subDistrictCleaned = cleanAddressField(target.invoice_sub_district, target.invoice_state, target.invoice_zip);

    const addr = [
      target.invoice_street,
      districtCleaned,
      subDistrictCleaned,
      stateCleaned,
      target.invoice_zip
    ].map(s => String(s || '').trim()).filter(Boolean).join(' ');

    return {
      ...c,
      invoice_street: target.invoice_street,
      invoice_district: districtCleaned,
      invoice_sub_district: subDistrictCleaned,
      invoice_state: stateCleaned,
      invoice_zip: target.invoice_zip,
      address_complete: addr || '-'
    };
  });

  const candidates = contactsWithAddr.map((c: any) => ({
    ...c,
    cleanName: cleanContactName(c.name || '')
  }));

  // 1. Phone matching
  let phoneMatchedCandidates: any[] = [];
  if (searchPhones.length > 0) {
    phoneMatchedCandidates = candidates.filter((c: any) => {
      const dbMobile = normalizePhone(c.mobile);
      const dbPhone = normalizePhone(c.phone);
      return searchPhones.some(sp => (dbMobile && dbMobile === sp) || (dbPhone && dbPhone === sp));
    }).map((c: any) => ({ item: c, score: 0.0 }));
  }

  if (phoneMatchedCandidates.length > 0) {
    return phoneMatchedCandidates;
  }

  // 2. Name matching with Fuse.js
  if (!cleaned) {
    return contactsWithAddr.map((c: any) => ({ item: c, score: 0 }));
  }

  const fuse = new (Fuse as any)(candidates, {
    keys: ['cleanName', 'name'],
    threshold: 0.5,
    includeScore: true
  });

  return fuse.search(cleaned).map((r: any) => ({
    item: r.item,
    score: r.score
  }));
}

export async function findCustomerByContactName(contactQuery: string, salesperson: any): Promise<any[]> {
  const cleaned = cleanContactName(contactQuery);
  if (!cleaned) return [];

  let query: any = (db.from('contacts') as any)
    .select('name, customer_id, customers!inner(id, display_name, salesperson, branch_code)')
    .ilike('name', `%${cleaned}%`);

  if (salesperson && salesperson.branch_code) {
    const branchCodes = salesperson.branch_code.split(',').map((c: any) => c.trim()).filter(Boolean);
    if (branchCodes.length > 0) {
      query = query.in('customers.branch_code', branchCodes);
    }
  }

  const { data: dbContacts, error } = await query.limit(50);

  if (error || !dbContacts) {
    console.error("Find customer by contact name error:", error);
    return [];
  }

  const candidates = dbContacts
    .filter((c: any) => c.customers)
    .map((c: any) => ({
      ...c,
      cleanName: cleanContactName(c.name || '')
    }));

  const fuse = new (Fuse as any)(candidates, {
    keys: ['cleanName', 'name'],
    threshold: 0.45,
    includeScore: true
  });

  const results = fuse.search(cleaned);

  const customerMap = new Map<any, any>();
  results.forEach((r: any) => {
    const item = r.item;
    const score = r.score;
    const custId = item.customers.id;

    if (!customerMap.has(custId) || customerMap.get(custId).score > score) {
      customerMap.set(custId, {
        id: custId,
        display_name: item.customers.display_name,
        contact_name: item.name,
        score: score
      });
    }
  });

  return Array.from(customerMap.values()).sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
}
