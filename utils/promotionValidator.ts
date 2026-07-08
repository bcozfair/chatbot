export interface CustomerData {
  customer_type: string | null;
  reference: string | null;
}

export interface Promotion {
  id: number;
  code: string;
  name: string;
  description: string | null;
  discount_type: string; // 'percent' | 'fixed' | 'override'
  discount_value: string | number;
  product_code: string | null;
  customer_type: string | null;
  customer_refs: string | null;
  min_qty: number;
  start_date: string | null;
  end_date: string | null;
  is_active: boolean;
}

export interface ValidationResult {
  allowed: boolean;
  newMinPrice: number;
  appliedPromo: Promotion | null;
}

/**
 * ตรวจสอบว่าราคาสินค้าที่เสนอขาย (หลังหักส่วนลด) ผ่านเกณฑ์โปรโมชันใดๆ หรือไม่
 * หากผ่าน จะส่งค่า allowed เป็น true พร้อมข้อมูลโปรโมชันที่นำมาใช้
 */
export function validateProductPriceWithPromotions(
  itemKey: string,
  quantity: number,
  discountedPrice: number,
  minPrice: number,
  customer: CustomerData | null,
  activePromos: Promotion[]
): ValidationResult {
  const now = new Date();
  
  // กรองโปรโมชันที่กำลังมีผลใช้งานตามเวลาปัจจุบัน
  const validPromos = activePromos.filter(promo => {
    if (promo.start_date && new Date(promo.start_date) > now) return false;
    if (promo.end_date && new Date(promo.end_date) < now) return false;
    return true;
  });

  let bestResult: ValidationResult = {
    allowed: false,
    newMinPrice: minPrice,
    appliedPromo: null
  };

  for (const promo of validPromos) {
    // 1. ตรวจสอบจำนวนขั้นต่ำ
    if (quantity < promo.min_qty) continue;

    // 2. ตรวจสอบสินค้าที่ร่วมรายการ (product_code)
    if (promo.product_code && promo.product_code.trim()) {
      const promoProducts = promo.product_code.split(',').map(p => p.trim().toLowerCase());
      if (!promoProducts.includes(itemKey.trim().toLowerCase())) {
        continue;
      }
    }

    // 3. ตรวจสอบประเภทลูกค้า (customer_type)
    if (promo.customer_type && promo.customer_type.trim()) {
      if (!customer || !customer.customer_type || !customer.customer_type.trim()) {
        continue;
      }
      const promoCustTypes = promo.customer_type.split(',').map(t => t.trim().toLowerCase());
      if (!promoCustTypes.includes(customer.customer_type.trim().toLowerCase())) {
        continue;
      }
    }

    // 4. ตรวจสอบรหัสอ้างอิงลูกค้า (customer_refs)
    if (promo.customer_refs && promo.customer_refs.trim()) {
      if (!customer || !customer.reference || !customer.reference.trim()) {
        continue;
      }
      const promoCustRefs = promo.customer_refs.split(',').map(r => r.trim().toLowerCase());
      if (!promoCustRefs.includes(customer.reference.trim().toLowerCase())) {
        continue;
      }
    }

    // คำนวณราคาขั้นต่ำใหม่ภายใต้โปรโมชันนี้
    let allowedMinPrice = minPrice;
    const discValue = parseFloat(promo.discount_value as string) || 0;

    if (promo.discount_type === 'override') {
      allowedMinPrice = 0;
    } else if (promo.discount_type === 'percent') {
      allowedMinPrice = minPrice * (1 - discValue / 100);
    } else if (promo.discount_type === 'fixed') {
      allowedMinPrice = Math.max(0, minPrice - discValue);
    }

    // หากราคาขายจริง `>=` ราคาขั้นต่ำใหม่ (ยอมรับค่าปัดเศษทศนิยม 0.01 บาท)
    if (discountedPrice >= allowedMinPrice - 0.01) {
      // เลือกโปรโมชันที่ให้ราคาขั้นต่ำต่ำสุด หรือกรณีผ่านแล้วให้เก็บตัวที่ทำให้ผ่านไว้
      if (!bestResult.allowed || allowedMinPrice < bestResult.newMinPrice) {
        bestResult = {
          allowed: true,
          newMinPrice: allowedMinPrice,
          appliedPromo: promo
        };
      }
    }
  }

  return bestResult;
}

/**
 * ค้นหาโปรโมชันที่เกี่ยวข้องกับสินค้าและลูกค้ารายนี้ (โดยละเว้นการเช็คราคาและจำนวนขั้นต่ำ)
 * เพื่อนำมาใช้ในการแสดงผลเตือนราคาขั้นต่ำโปรโมชันเป้าหมาย
 */
export function getRelevantPromotion(
  itemKey: string,
  customer: CustomerData | null,
  activePromos: Promotion[]
): Promotion | null {
  const now = new Date();
  
  // กรองโปรโมชันที่กำลังมีผลใช้งานตามเวลาปัจจุบัน
  const validPromos = activePromos.filter(promo => {
    if (promo.start_date && new Date(promo.start_date) > now) return false;
    if (promo.end_date && new Date(promo.end_date) < now) return false;
    return true;
  });

  let bestPromo: Promotion | null = null;

  for (const promo of validPromos) {
    // 1. ตรวจสอบสินค้าที่ร่วมรายการ
    if (promo.product_code && promo.product_code.trim()) {
      const promoProducts = promo.product_code.split(',').map(p => p.trim().toLowerCase());
      if (!promoProducts.includes(itemKey.trim().toLowerCase())) {
        continue;
      }
    }

    // 2. ตรวจสอบประเภทลูกค้า
    if (promo.customer_type && promo.customer_type.trim()) {
      if (!customer || !customer.customer_type || !customer.customer_type.trim()) {
        continue;
      }
      const promoCustTypes = promo.customer_type.split(',').map(t => t.trim().toLowerCase());
      if (!promoCustTypes.includes(customer.customer_type.trim().toLowerCase())) {
        continue;
      }
    }

    // 3. ตรวจสอบรหัสลูกค้า
    if (promo.customer_refs && promo.customer_refs.trim()) {
      if (!customer || !customer.reference || !customer.reference.trim()) {
        continue;
      }
      const promoCustRefs = promo.customer_refs.split(',').map(r => r.trim().toLowerCase());
      if (!promoCustRefs.includes(customer.reference.trim().toLowerCase())) {
        continue;
      }
    }

    // เลือกโปรโมชันที่เกี่ยวข้อง (หากมีหลายตัว ให้เลือกตัวที่ให้ส่วนลดดีที่สุด หรือ override)
    if (!bestPromo) {
      bestPromo = promo;
    } else {
      if (promo.discount_type === 'override') {
        bestPromo = promo;
      } else if (bestPromo.discount_type !== 'override') {
        const val1 = parseFloat(promo.discount_value as string) || 0;
        const val2 = parseFloat(bestPromo.discount_value as string) || 0;
        if (val1 > val2) {
          bestPromo = promo;
        }
      }
    }
  }

  return bestPromo;
}
