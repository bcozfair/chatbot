import puppeteer from "puppeteer";
// @ts-ignore
import ThaiBahtText from "thai-baht-text";
import fs from "fs";
import path from "path";
import { pool } from "./config/db.js";
import { resolveQuoteCompany } from "./services/quotationService.js";
import { computeAdminKey, cleanAdminName } from "./services/adminService.js";

// ใช้ Chrome ตัวเดียวร่วมกันทุก request แทนการ launch ใหม่ทุกครั้ง
// เดิม: launch ต่อ request และ browser.close() ไม่อยู่ใน finally -> error หนึ่งครั้ง = Chrome ค้าง 1 ตัว สะสมจน RAM หมด
let browserPromise: Promise<import("puppeteer").Browser> | null = null;

async function getBrowser(): Promise<import("puppeteer").Browser> {
  if (browserPromise) {
    try {
      const existing = await browserPromise;
      if (existing.connected) return existing;
    } catch {
      // launch รอบก่อนล้มเหลว — ตกไป launch ใหม่ด้านล่าง
    }
    browserPromise = null;
  }

  browserPromise = puppeteer
    .launch({
      headless: "new" as any,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    })
    .catch((err) => {
      // ถ้า launch พัง ต้องล้าง promise ทิ้ง ไม่งั้นทุก request ถัดไปจะได้ error เดิมค้างตลอด
      browserPromise = null;
      throw err;
    });

  const browser = await browserPromise;
  // Chrome ตายเอง (เช่นถูก OOM killer) -> ล้าง cache ให้ request ถัดไป launch ใหม่
  browser.once("disconnected", () => {
    browserPromise = null;
  });
  return browser;
}

/** ปิด Chrome ที่ใช้ร่วมกัน (สำหรับ graceful shutdown / เทสต์) */
export async function closePdfBrowser(): Promise<void> {
  const current = browserPromise;
  browserPromise = null;
  if (!current) return;
  try {
    const browser = await current;
    await browser.close();
  } catch (err) {
    console.error("[pdfGenerator] ปิด browser ไม่สำเร็จ:", err);
  }
}

// แยก sales_description เป็นบรรทัดตาม \n เดิมในข้อมูล (trim + ตัดบรรทัดว่างทิ้ง)
function splitSalesDescriptionLines(desc: string): string[] {
  return String(desc)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function generateQuotationPDF(quoteData: any, quoteNoInput?: string | null): Promise<Uint8Array> {
  const itemsList = quoteData.items || [];
  const itemSnapshots = quoteData.item_details || [];

  // คำนวณวันรับประกันและระยะเวลาจัดส่ง
  let minWarrantyDisplay = '1 ปี';
  let allItemsInStock = true;
  const itemDeliveryDays: number[] = [];

  // หากมี Snapshot ครบถ้วน (itemSnapshots) และความยาวเท่ากัน ให้ดึงค่าจาก Snapshot
  if (itemSnapshots && Array.isArray(itemSnapshots) && itemSnapshots.length > 0 && itemSnapshots.length === itemsList.length) {
    let minWarrantyMonths = Infinity;

    itemsList.forEach((item: any, idx: number) => {
      const snap = itemSnapshots[idx];
      const qty = Number(item.quantity) || 0;
      const stock = item.stock !== undefined && item.stock !== null ? Number(item.stock) : 0;
      const hasStock = qty <= stock;

      if (!hasStock) {
        allItemsInStock = false;
      }

      // ดึงเงื่อนไขการรับประกันจาก snapshot
      const warrantyText = snap.warranty_display || '1 ปี';
      let inMonths = 12;
      let warrantyVal = 1;
      let warrantyUnit = 'year';

      if (warrantyText.includes('เดือน')) {
        warrantyVal = parseInt(warrantyText) || 1;
        warrantyUnit = 'month';
        inMonths = warrantyVal;
      } else if (warrantyText.includes('ปี')) {
        warrantyVal = parseInt(warrantyText) || 1;
        warrantyUnit = 'year';
        inMonths = warrantyVal * 12;
      }

      if (inMonths < minWarrantyMonths) {
        minWarrantyMonths = inMonths;
        minWarrantyDisplay = warrantyText;
      }

      const itemInStockDays = snap.delivery_in_stock_days !== undefined ? snap.delivery_in_stock_days : 3;
      const itemOutOfStockDays = snap.delivery_out_of_stock_days !== undefined ? snap.delivery_out_of_stock_days : 7;

      const days = hasStock ? itemInStockDays : itemOutOfStockDays;
      itemDeliveryDays.push(days);
    });

    if (minWarrantyMonths === Infinity) {
      minWarrantyDisplay = '1 ปี';
    }
  } else {
    // Fallback: ดึงกฎเงื่อนไขจาก quotation_rules เดิม
    let quotationRules: any[] = [];
    try {
      const rulesRes = await pool.query('SELECT * FROM quotation_rules');
      quotationRules = rulesRes.rows || [];
    } catch (err) {
      console.error('Error fetching quotation rules in PDF generator:', err);
    }

    let minWarrantyMonths = Infinity;

    itemsList.forEach((item: any) => {
      const qty = Number(item.quantity) || 0;
      const stock = item.stock !== undefined && item.stock !== null ? Number(item.stock) : 0;
      const hasStock = qty <= stock;

      if (!hasStock) {
        allItemsInStock = false;
      }

      // Matching logic — rule match เฉพาะ field ที่ระบุไว้เท่านั้น
      let matchedRule = null;
      const iBrand      = item.brand      ? String(item.brand).trim().toLowerCase()      : '';
      const iSeries     = item.series     ? String(item.series).trim().toLowerCase()     : '';
      const iProduction = item.production ? String(item.production).trim().toLowerCase() : '';
      const clean = (s: string) => s.replace(/\s+/g, '').toLowerCase();

      matchedRule = quotationRules.find((r: any) => {
        if (r.production) {
          if (r.production === '__NULL__') {
            if (iProduction !== '') return false;
          } else {
            const rp = clean(r.production);
            const ip = clean(iProduction);
            const isImportMatch = (rp === 'import' && ip.startsWith('import'));
            const isExactMatch = (rp === ip);
            if (!isExactMatch && !isImportMatch) return false;
          }
        }
        if (r.brand  && r.brand.trim().toLowerCase() !== iBrand)   return false;
        if (r.series && r.series.trim().toLowerCase() !== iSeries) return false;
        return true;
      }) || null;

      // ตรวจสอบเงื่อนไขล็อคเสนอราคา
      if (matchedRule && matchedRule.is_locked) {
        const prodLabel = matchedRule.production === '__NULL__' ? '(ไม่มีฝ่ายผลิต)' : (matchedRule.production || '');
        throw new Error(`❌ ระงับการเสนอราคาสินค้า ${item.product_code || item.model}\nเงื่อนไข: ${prodLabel} > ${matchedRule.brand || ''} > ${matchedRule.series || ''}\nกรุณาติดต่อแอดมิน`);
      }

      const itemWarrantyVal = matchedRule ? matchedRule.warranty_years : 1;
      const itemWarrantyUnit = matchedRule ? (matchedRule.warranty_unit || 'year') : 'year';
      const inMonths = itemWarrantyUnit === 'year' ? itemWarrantyVal * 12 : itemWarrantyVal;

      const itemInStockDays = matchedRule ? matchedRule.delivery_in_stock_days : 3;
      const itemOutOfStockDays = matchedRule ? matchedRule.delivery_out_of_stock_days : 7;

      if (inMonths < minWarrantyMonths) {
        minWarrantyMonths = inMonths;
        if (itemWarrantyUnit === 'month') {
          minWarrantyDisplay = `${itemWarrantyVal} เดือน`;
        } else {
          minWarrantyDisplay = `${itemWarrantyVal} ปี`;
        }
      }

      const days = hasStock ? itemInStockDays : itemOutOfStockDays;
      itemDeliveryDays.push(days);
    });

    if (minWarrantyMonths === Infinity) {
      minWarrantyDisplay = '1 ปี';
    }
  }

  let deliveryTimeText = '';
  if (allItemsInStock) {
    const maxInStockDays = itemDeliveryDays.length > 0 ? Math.max(...itemDeliveryDays) : 3;
    deliveryTimeText = `In_stock.,With in  ${maxInStockDays}  Days`;
  } else {
    const maxDays = itemDeliveryDays.length > 0 ? Math.max(...itemDeliveryDays) : 7;
    deliveryTimeText = `Make to order.,With in  ${maxDays}  Days`;
  }

  let grossSubTotal = 0;
  let discountedSubTotal = 0;

  itemsList.forEach((item: any) => {
    const qty = Number(item.quantity) || 0;
    const price = Number(item.price) || 0;
    const disc1 = Number(item.discount_1) || 0;
    const disc2 = Number(item.discount_2) || 0;

    const rowGross = qty * price;
    const discountedPrice = price * (1 - disc1 / 100) * (1 - disc2 / 100);
    const rowNet = qty * discountedPrice;

    grossSubTotal += rowGross;
    discountedSubTotal += rowNet;
  });

  const totalDiscountAmount = 0.00;
  const vat = Math.round((discountedSubTotal * 0.07) * 100) / 100;
  const grandTotal = Math.round((discountedSubTotal + vat) * 100) / 100;

  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  const dateStr = `${dd}/${mm}/${yyyy}`;

  const quoteNo = quoteNoInput || (quoteData.quotation_no
    ? quoteData.quotation_no
    : (quoteData.id
      ? quoteData.id.split("-")[0].toUpperCase()
      : "DRAFT"));

  // พิจารณาค่ายจาก resolveQuoteCompany (เช็ค quotation_rules) โดยใช้รายการสินค้าแรกเป็น reference
  // ถ้าไม่มีสินค้าให้ fallback ไปเช็ค prefix ของเลขที่ใบเสนอราคา
  let isThemtech = false;
  const itemSourceList = itemsList.length > 0 ? itemsList : [];
  if (itemSourceList.length > 0) {
    try {
      const company = await resolveQuoteCompany(itemSourceList[0]);
      isThemtech = (company === 'THT');
    } catch (err) {
      console.error('Error resolving quote company in pdfGenerator:', err);
      // fallback: เช็ค prefix
      isThemtech = quoteNo.toUpperCase().startsWith('QT');
    }
  } else {
    isThemtech = quoteNo.toUpperCase().startsWith('QT');
  }

  // จัดการชื่อพนักงานขายตามเงื่อนไข (QT -> THT, QP -> PM)
  let salespersonNameFormatted = '';
  if (quoteData.salesperson_name && quoteData.salesperson_name !== '') {
    let cleanSpName = String(quoteData.salesperson_name).trim();
    // ตัดคำนำหน้าชื่อ
    cleanSpName = cleanSpName.replace(/^(คุณ)\s*/, '');
    // ลบวงเล็บ (PM) หรือ (THT) เดิมที่อาจติดมาออกก่อนเพื่อป้องกันการซ้อนกัน
    cleanSpName = cleanSpName.replace(/\s*\((PM|THT)\)$/gi, '');
    const suffix = isThemtech ? ' (THT)' : ' (PM)';
    salespersonNameFormatted = cleanSpName + suffix;
  }

  // ดึงไฟล์ภาพลายเซ็นพนักงานขายตามรหัสพนักงาน (ถ้ามี)
  let sigBase64: string | null = null;
  const empCode = quoteData.salesperson_employee_code ? String(quoteData.salesperson_employee_code).trim() : null;
  if (empCode) {
    const extensions = ['.png', '.jpg', '.jpeg', '.gif'];
    for (const ext of extensions) {
      const sigPath = path.join(process.cwd(), "data", "sale_sigs", `${empCode}${ext}`);
      if (fs.existsSync(sigPath)) {
        try {
          const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : `image/${ext.substring(1)}`;
          const imgBase64 = fs.readFileSync(sigPath).toString("base64");
          sigBase64 = `data:${mimeType};base64,${imgBase64}`;
          break; // ค้นพบแล้วให้หยุดลูป
        } catch (err) {
          console.error(`Error reading signature image ${sigPath}:`, err);
        }
      }
    }
  }

  // ดึงไฟล์ภาพลายเซ็นผู้อนุมัติ (แอดมิน) ตาม key ที่คำนวณจากชื่อแอดมิน (ถ้ามี)
  // แอดมินคนเดียวกัน → key เดียวกัน → ใช้ไฟล์ลายเซ็นไฟล์เดียวร่วมกัน
  let adminSigBase64: string | null = null;
  const adminKey = computeAdminKey(quoteData.employee_quotations);
  if (adminKey) {
    const extensions = ['.png', '.jpg', '.jpeg', '.gif'];
    for (const ext of extensions) {
      const sigPath = path.join(process.cwd(), "data", "admin_sigs", `${adminKey}${ext}`);
      if (fs.existsSync(sigPath)) {
        try {
          const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : `image/${ext.substring(1)}`;
          const imgBase64 = fs.readFileSync(sigPath).toString("base64");
          adminSigBase64 = `data:${mimeType};base64,${imgBase64}`;
          break; // ค้นพบแล้วให้หยุดลูป
        } catch (err) {
          console.error(`Error reading admin signature image ${sigPath}:`, err);
        }
      }
    }
  }

  const logoFile = isThemtech ? "logo2.png" : "logo.png";
  const logoBase64 = fs.readFileSync(path.join(process.cwd(), "data", logoFile)).toString("base64");
  const isoBase64 = fs.readFileSync(path.join(process.cwd(), "data", "iso.png")).toString("base64");

  let companyHtml = '';
  let addressHtml = '';
  let tNoteHtml = '';

  if (isThemtech) {
    companyHtml = `
      <div>บริษัท เดมเทค จำกัด (สาขาที่ 00002)</div>
      <div>Themtech Co., Ltd.</div>
    `;
    addressHtml = `
      118/60 อาคาร PRIMUS ชั้น 2 หมู่ที่ 18 ตำบลคลองหนึ่ง อำเภอคลองหลวง จังหวัด ปทุมธานี 12120<br />
      118/60 PRIMUS BUILDING, 2ND FLOOR MOO 18 , KHLONG NUENG , KHLONG LUANG , PATHUM THANI 12120<br />
      Tel: 0-2693-7005 (Auto lines) &nbsp; Fax:Sale:0-2277-3565 , 0-2277-1146 &nbsp; FaxAccount: 0-2276-7221, 0-2275-1912<br />
      https://www.themtech.co.th &nbsp; E-mail: sales_tht@themtech.co.th &nbsp; Tax ID: 0105542030032
    `;
    tNoteHtml = `
      ทางบริษัทฯ หวังเป็นอย่างยิ่งว่าจะได้บริการท่านในเร็ววันนี้<br>
      We look forward to give you our best service<br>
      บริษัท เดมเทค จำกัด
    `;
  } else {
    companyHtml = `
      <div>บริษัท ไพรมัส จํากัด (สาขาที่ 00012)</div>
      <div>Primus Co.,Ltd</div>
    `;
    addressHtml = `
      118/60 &nbsp;หมู่ 18 &nbsp;ตำบลคลองหนึ่ง &nbsp;อำเภอคลองหลวง
      &nbsp;จังหวัด ปทุมธานี &nbsp;12120<br />
      118/60 MOO 18 , KHLONG NUENG , KHLONG LUANG , PATHUM THANI 12120<br />
      Tel: 0-2693-7005 (Auto lines) &nbsp; Fax:Sale : 0-2277-3565 ,
      0-2277-1146 &nbsp; FaxAccount : 0-2276-7221, 0-2275-1912<br />
      https://www.primus.co.th &nbsp; E-mail: sales@primus.co.th &nbsp; Tax
      ID: 0105536011803
    `;
    tNoteHtml = `
      ทางบริษัทฯ หวังเป็นอย่างยิ่งว่าจะได้บริการท่านในเร็ววันนี้<br>
      We look forward to give you our best service<br>
      บริษัท ไพรมัส จำกัด
    `;
  }

  // Dynamic pagination based on item content weight
  // Each item gets a weight based on how much vertical space it needs
  const maxWeightPerPage = 9.0; // equivalent to 9 simple items

  function getItemWeight(item: any) {
    let weight = 1.0; // base row
    if (item.sales_description && item.sales_description.trim()) {
      const descLines = splitSalesDescriptionLines(item.sales_description);
      // นับบรรทัดแสดงผลจริง: บรรทัด description (font 10px) ≈ 0.4 หน่วยเทียบแถวฐาน 35px
      // และบรรทัดยาวเกิน ~70 ตัวอักษร (ความกว้างคอลัมน์ DESCRIPTION) จะ wrap เพิ่ม
      const visualLines = descLines.reduce(
        (s, l) => s + Math.max(1, Math.ceil(l.length / 70)),
        0,
      );
      weight += visualLines * 0.4;
    }
    if (item.remark && item.remark.trim()) {
      weight += 0.4;
    }
    const stock = item.stock !== undefined && item.stock !== null ? Number(item.stock) : 0;
    if ((Number(item.quantity) || 0) > stock) {
      weight += 0.3;
    }
    return weight;
  }

  // Split items into pages based on accumulated weight
  const pages = [];
  let currentPage = [];
  let currentWeight = 0;

  for (const item of itemsList) {
    const w = getItemWeight(item);
    if (currentPage.length > 0 && currentWeight + w > maxWeightPerPage) {
      pages.push(currentPage);
      currentPage = [item];
      currentWeight = w;
    } else {
      currentPage.push(item);
      currentWeight += w;
    }
  }
  if (currentPage.length > 0 || pages.length === 0) {
    pages.push(currentPage);
  }

  const totalPages = pages.length;
  let pagesHtml = "";
  let globalItemIndex = 0;

  for (let i = 0; i < totalPages; i++) {
    const pageNum = i + 1;
    const isLastPage = pageNum === totalPages;
    const itemsChunk = pages[i];
    const startIndex = globalItemIndex;

    // Pad with empty rows to fill remaining space
    const usedWeight = itemsChunk.reduce((sum, item) => sum + getItemWeight(item), 0);
    const remainingSlots = Math.floor(maxWeightPerPage - usedWeight);
    const paddedItems: any[] = [...itemsChunk];
    for (let e = 0; e < remainingSlots; e++) {
      paddedItems.push(null);
    }

    const itemsHtml = paddedItems.map((item, index) => {
      if (item) {
        const qty = Number(item.quantity) || 0;
        const price = Number(item.price) || 0;
        const disc1 = Number(item.discount_1) || 0;
        const disc2 = Number(item.discount_2) || 0;

        const discountedPrice = price * (1 - disc1 / 100) * (1 - disc2 / 100);
        const itemTotal = qty * discountedPrice;

        let discountDisplay = "";
        if (disc1 > 0 && disc2 > 0) {
          discountDisplay = `${disc1} % , ${disc2} %`;
        } else if (disc1 > 0) {
          discountDisplay = `${disc1} %`;
        } else if (disc2 > 0) {
          discountDisplay = `${disc2} %`;
        } else {
          discountDisplay = "";
        }

        const stock = item.stock !== undefined && item.stock !== null ? Number(item.stock) : 0;
        let warningHtml = "";
        if (qty > stock) {
          warningHtml = `<div style="color: #ef4444; font-size: 10px; font-weight: bold; margin-top: 2px;">(*** สินค้าคงเหลือ ${stock} pcs. ***)</div>`;
        }

        let remarkHtml = "";
        if (item.remark && item.remark.trim()) {
          remarkHtml = `<div style="color: #000000ff; font-size: 10px; margin-top: 2px;">หมายเหตุ: ${item.remark.trim()}</div>`;
        }

        let salesDescHtml = "";
        if (item.sales_description && item.sales_description.trim()) {
          const descLines = splitSalesDescriptionLines(item.sales_description);
          if (descLines.length > 0) {
            salesDescHtml = `<div style="color: #444; font-size: 10px; margin-top: 1px;">${descLines.join("<br>")}</div>`;
          }
        }

        return `
          <tr style="height: 35px;">
            <td class="text-center">${startIndex + index + 1}</td>
            <td>
              <div style="font-weight: 500;">${item.name}</div>
              ${salesDescHtml}
              ${remarkHtml}
              ${warningHtml}
            </td>
            <td class="text-center">${qty.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}&nbsp;&nbsp;Pcs</td>
            <td class="text-right">${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            <td class="text-right">${discountDisplay}</td>
            <td class="text-right">${itemTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          </tr>
        `;
      } else {
        return `
          <tr>
            <td class="text-center"></td>
            <td></td>
            <td class="text-center"></td>
            <td class="text-right"></td>
            <td class="text-right"></td>
            <td class="text-right"></td>
          </tr>
        `;
      }
    }).join("");

    const pageHtml = `
      <div class="page">
        <div class="pg-num">หน้า ${pageNum}/${totalPages}</div>

        <!-- ══ HEADER ══ -->
        <div class="hdr">
          <div class="logo-wrap">
              <img src="data:image/png;base64,${logoBase64}" alt="logo บริษัท" width="100" height="70" />
          </div>

          <div class="company">
            ${companyHtml}
          </div>

          <div class="cert-wrap">
            <div class="cert-seal">
              <img src="data:image/png;base64,${isoBase64}" alt="ISO logo" width="140" height="45" />
            </div>
          </div>
        </div>

        <div class="addr">
          ${addressHtml}
        </div>

        <hr class="hdr-line" />
        <div class="doc-title">ใบเสนอราคา : Quotation</div>

        <!-- ══ META ══ -->
        <div class="meta">
          <div class="meta-l">
            <div class="mrow-inline">
              <span class="ml" style="min-width: 56px">รหัสลูกค้า</span><span class="mc">:</span>
              <span class="mv">${quoteData.customer_code || ''}</span>
              <span class="ml2">เลขประจำตัวผู้เสียภาษีอากร</span><span class="mc">:</span>
              <span class="mv">${quoteData.customer_tax_id || ''}</span>
            </div>
            <div class="mrow">
              <span class="ml" style="min-width: 56px">นามผู้ซื้อ</span><span class="mc">:</span>
              <span class="mv">${quoteData.company_name || ''}</span>
            </div>
            <div class="mrow">
              <span class="ml" style="min-width: 56px">ผู้ติดต่อ</span><span class="mc">:</span>
              <span class="mv">${quoteData.contact_name || ''}</span>
            </div>
            <div class="mrow">
              <span class="ml" style="min-width: 56px">โทรศัพท์</span><span class="mc">:</span>
              <span class="mv">${quoteData.contact_phone || ''}</span>
            </div>
            <div class="mrow">
              <span class="ml" style="min-width: 56px">อีเมล</span><span class="mc">:</span>
              <span class="mv">${quoteData.contact_email || ''}</span>
            </div>
            <div class="mrow" style="align-items: flex-start">
              <span class="ml" style="min-width: 56px">ที่อยู่</span><span class="mc">:</span>
              <span class="mv">${quoteData.contact_address || ''}</span>
            </div>
          </div>

          <div class="meta-r">
            <div class="mrow">
              <span class="ml" style="min-width: 76px">เลขที่</span><span class="mc">:</span>
              <span class="mv">${quoteNo}</span>
            </div>
            <div class="mrow">
              <span class="ml" style="min-width: 76px">วันที่</span><span class="mc">:</span>
              <span class="mv">${dateStr}</span>
            </div>
            <div class="mrow">
              <span class="ml" style="min-width: 76px">PO Ref.</span><span class="mc">:</span>
              <span class="mv"></span>
            </div>
            <div class="mrow" style="align-items: flex-start">
              <span class="ml" style="min-width: 76px">สถานที่ส่งของ</span><span class="mc">:</span>
              <span class="mv">${quoteData.delivery_address || ''}</span>
            </div>
          </div>
        </div>

        <!-- ══ ITEMS TABLE ══ -->
        <table class="text-xs-custom item-table">
          <thead>
            <tr class="text-center uppercase font-bold" style="height: 35px;">
              <th class="w-8">ลำดับ<br />No.</th>
              <th>รายการ<br />DESCRIPTION</th>
              <th class="w-20">จำนวน<br />QUANTITY</th>
              <th class="w-20">หน่วยละ<br />UNIT</th>
              <th class="w-20">ส่วนลด<br />DISCOUNT</th>
              <th class="w-28">ราคา<br />AMOUNT</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHtml}
          </tbody>
        </table>

        <!-- ══ SUMMARY ══ -->
        <table class="sum-tbl">
          <colgroup>
            <col />
            <col style="width:10rem" />
            <col style="width:7rem" />
          </colgroup>
          <tbody>
            <tr>
              <td class="sum-note-pdpa" rowspan="2">
                 <div><b>หมายเหตุ:</b> เงื่อนไขการรับประกันสินค้า ${minWarrantyDisplay}</div>
              </td>
              <td class="sl">รวมเงิน</td>
              <td class="sa">${isLastPage ? discountedSubTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ""}</td>
            </tr>
            <tr>
              <td class="sl">ส่วนลด</td>
              <td class="sa">${isLastPage ? totalDiscountAmount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ""}</td>
            </tr>
            <tr>
              <td class="sum-note-pdpa">
                <div class="pdpa">
                  ขอแจ้งนโยบายขอข้อมูลส่วนบุคคล เพื่อประโยชน์ในการได้รับข้อมูลผลิตภัณฑ์หรือบริการาของเรา<br>
                  อาทิ ใบเสนอราคา, การติดต่อกลับเพื่อสอบถามหรือนำเสนอข้อมูล ดูรายละเอียดเพิ่มเติม:<br>
                  https://www.primusthai.com/primus/Activity/info?ID=340
                </div>
              </td>
              <td class="sl bld">มูลค่าหลังหักส่วนลด</td>
              <td class="sa bld">${isLastPage ? discountedSubTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ""}</td>
            </tr>
            <tr>
              <td class="sum-bw" rowspan="2">
                ตัวอักษร: ${isLastPage ? (ThaiBahtText as any)(grandTotal) : ""}
              </td>
              <td class="sl">ภาษีมูลค่าเพิ่ม 7%</td>
              <td class="sa">${isLastPage ? vat.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ""}</td>
            </tr>
            <tr>
              <td class="sl grand">ยอดเงินสุทธิ</td>
              <td class="sa grand">${isLastPage ? grandTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ""}</td>
            </tr>
          </tbody>
        </table>
       
        <!-- ══ TERMS ══ -->
        <div class="terms">
          <div class="t-keys">
            <div>Price Validity</div>
            <div>Term Payment</div>
            <div>Delivery Time</div>
          </div>
          <div class="t-vals">
            <div>: 7 Day</div>
            <div>: ${quoteData.payment_terms || ''}</div>
            <div>: ${deliveryTimeText}</div>
          </div>
          <div class="t-note">
            ${tNoteHtml}
          </div>
        </div>

        <!-- ══ SIGNATURES ══ -->
        <div class="sigs">
          <div class="sig">
            <div class="sig-space"></div>
            <div class="sig-line"></div>
            <div class="sig-name">ลูกค้า (ผู้มีอำนาจ)</div>
            <div class="sig-date">วันที่......./......./.......</div>
          </div>

          <div class="sig">
            <div class="sig-space">${sigBase64 ? `<img src="${sigBase64}" alt="ลายเซ็น" style="max-height: 50px; max-width: 180px; object-fit: contain; display: block; margin: 0 auto;" />` : ''}</div>
            <div class="sig-line"></div>
            <div class="sig-name">( ${salespersonNameFormatted === '' ? 'ชื่อพนักงานขาย' : salespersonNameFormatted} )</div>
            <div style="color: #111; font-size: 11px;">${quoteData.salesperson_phone && quoteData.salesperson_phone !== '' ? `( ${quoteData.salesperson_phone} )` : '( เบอร์โทร )'}</div>
            <div style="color: #111; font-size: 11px;">( พนักงานขาย )</div>
            <div class="sig-date">วันที่......./......./.......</div>
          </div>

          <div class="sig">
            <div class="sig-space">${adminSigBase64 ? `<img src="${adminSigBase64}" alt="ลายเซ็นผู้อนุมัติ" style="max-height: 50px; max-width: 180px; object-fit: contain; display: block; margin: 0 auto;" />` : ''}</div>
            <div class="sig-line"></div>
            <div class="sig-name">( ${quoteData.employee_quotations && quoteData.employee_quotations !== '' ? cleanAdminName(quoteData.employee_quotations) : 'ชื่อแอดมิน'} )</div>
            <div style="color: #111; font-size: 11px;">${quoteData.employee_quotations_phone && quoteData.employee_quotations_phone !== '' ? `( ${quoteData.employee_quotations_phone} )` : '( เบอร์โทร )'}</div>
            <div style="color: #111; font-size: 11px;">( ผู้เสนอราคา )</div>
            <div class="sig-date">วันที่......./......./.......</div>
          </div>
        </div>

        <div class="form-no">F-MK-04 REV.6</div>
      </div>
    `;
    pagesHtml += pageHtml;
    globalItemIndex += itemsChunk.length;
  }

  const htmlContent = `
<!doctype html>
<html lang="th">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1.0" />
    <title>ใบเสนอราคา - ${isThemtech ? 'Themtech' : 'Primus'}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link
      href="https://fonts.googleapis.com/css2?family=Sarabun:wght@300;400;500;600;700&display=swap"
      rel="stylesheet"
    />
    <style>
      *,
      *::before,
      *::after {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }

      body {
        font-family: 'Sarabun', sans-serif;
        background-color: #fff;
        display: block;
        padding: 0;
      }

      .page {
        background: #fff;
        width: 794px;
        height: 1123px;
        padding: 15px 30px 10px;
        font-size: 12px;
        color: #111;
        position: relative;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
      }

      .hdr, .addr, .hdr-line, .doc-title, .meta, .sum-tbl, .terms, .sigs, .form-no {
        flex-shrink: 0;
      }

      .item-table {
        flex: 1 1 auto;
      }

      .page:not(:last-child) {
        page-break-after: always;
      }

      .pg-num {
        position: absolute;
        top: 18px;
        right: 22px;
        font-size: 11px;
        color: #111;
      }

      /* ══════════ HEADER ══════════ */
      .hdr {
        display: flex;
        align-items: flex-start;
        padding-right: 0;
      }

      .logo-wrap {
        flex-shrink: 0;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        width: 106px;
      }

      .company {
        flex: 1;
        padding-left: 50px;
        padding-top: 30px;
        font-size: 12px;
        line-height: 1.5;
      }

      .cert-wrap {
        flex-shrink: 0;
        display: flex;
        align-items: stretch;
        margin-top: 15px;
      }

      .cert-seal {
        display: flex;
        align-items: flex-start;
        justify-content: flex-end;
        box-sizing: border-box;
      }


      .cert-seal img {
        width: 60%;
        height: 60%;
        object-fit: contain;
        display: block;
      }

      .logo-wrap img{
        width: 85%;
        height: 85%;
        object-fit: contain;
        display: block;
      }

      .addr {
        font-size: 11px;
        margin-top: 3px;
        line-height: 1.4;
      }

      .hdr-line {
        border: none;
        border-top: 0.8px solid #111;
        margin: 4px 0 0;
      }

      .doc-title {
        text-align: center;
        font-size: 15px;
        font-weight: 700;
        border-bottom: 0.8px solid #111;
        padding: 2px 0 3px;
      }

      /* ══════════ META ══════════ */
      .meta {
        display: grid;
        grid-template-columns: 1fr 1fr;
        margin-top: 5px;
        font-size: 12px;
      }
      .meta-l {
        padding-bottom: 10px;
      }
      .meta-r {
        padding-left: 15px;
      }

      .mrow, .mrow-inline {
        display: flex;
        padding: 1px 0;
      }
      .mrow { align-items: flex-start; }
      .mrow-inline { align-items: baseline; flex-wrap: wrap; }
      .ml {
        white-space: nowrap;
        flex-shrink: 0;
      }
      .mc {
        flex-shrink: 0;
        padding: 0 3px 0 2px;
      }
      .mv {
        line-height: 1.4;
        flex: 1;
      }
      .ml2 {
        white-space: nowrap;
        flex-shrink: 0;
        margin-left: 10px;
      }

      /* ══════════ SUMMARY TABLE ══════════ */
      .sum-tbl {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }

      .sum-note-pdpa {
        vertical-align: top !important;
        padding: 4px 8px 3px !important;
      }
      .sum-note-pdpa b {
        font-weight: 700;
      }

      .sum-tbl .pdpa {
        font-size: 11px;
        line-height: 1.2;
        color: #111;
      }

      .sum-bw {
        padding: 2px 5px !important;
        vertical-align: middle !important;
        font-size: 12px;
        border: 0.8px solid #111;
      }
      
      .sum-tbl .sa {
        width: 7rem;
        text-align: right;
      }

      .sum-tbl tr:nth-child(3) .sum-note-pdpa {
        border-top: none;
        padding-top: 0.2rem;
      }

      .sum-tbl tr:nth-child(1) .sum-note-pdpa {
        border-top: none;  
        border-bottom: none;
        padding-bottom: 0.2rem;
      }

      /* ══════════ TERMS ══════════ */
      .terms {
        display: flex;
        border: 0.8px solid #111;
        border-top: none;
        border-bottom: none;
        font-size: 12px;
      }
      .t-keys {
        padding: 2px 5px;
        line-height: 1.5;
        min-width: 100px;
        color: #111;
      }
      .t-vals {
        flex: 1;
        padding: 2px 5px;
        line-height: 1.5;
      }
      .t-note {
        flex: 1;
        padding: 2px 5px;
        text-align: right;
        font-size: 11px;
        line-height: 1.4;
      }

      /* ══════════ SIGNATURES ══════════ */
      .sigs {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;        
        border: 0.8px solid #111;
      }
      .sig {
        text-align: center;
        padding: 4px 6px;
        border-right: 0.8px solid #111;
        font-size: 12px;
      }
      .sig:last-child {
        border-right: none;
      }
      .sig-space {
        height: 50px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .sig-line {
        border-top: 0.8px solid #111;
        margin: 4px 18px 2px;
      }
      
      .sig-date {
        color: #111;
        font-size: 11px;
      }

      .form-no {
        font-size: 10px;
        color: #111;
        text-align: right;
        margin-top: 3px;
      }

      .text-xs-custom {
        font-size: 0.75rem;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        border: 0.8px solid #111;
        padding: 2px 5px;
        vertical-align: top;
        box-sizing: border-box;
      }

      tbody td {
        border-top: none;
        border-bottom: none;
      }
      tbody tr:last-child td {
        border-bottom: 0.8px solid #111;
      }
      /* Ensure summary table keeps its borders */
      .sum-tbl th,
      .sum-tbl td {
        border: 0.8px solid #111;
        padding: 6px 8px;
      }
      .sum-tbl tbody tr:first-child td {
        border-top: none;
      }
    </style>
  </head>
  <body>
    ${pagesHtml}
  </body>
</html>
  `;

  const finalHtml = htmlContent;

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(finalHtml, { waitUntil: "networkidle0" as any });
    return await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0", bottom: "0", left: "0", right: "0" },
    });
  } finally {
    // ปิด page เสมอแม้เกิด error ระหว่าง setContent/pdf — ไม่ปิด browser เพราะใช้ร่วมกัน
    await page.close().catch((err) => console.error("[pdfGenerator] ปิด page ไม่สำเร็จ:", err));
  }
}
