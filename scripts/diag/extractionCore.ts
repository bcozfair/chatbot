// ─────────────────────────────────────────────────────────────────────────────
//  Core ที่ diagnostic runner + model-comparison ใช้ร่วมกัน
//  (prompt mirror ของ production + JSON parse fallback + ตัวเทียบ field)
// ─────────────────────────────────────────────────────────────────────────────
import type { DiagCase, ItemExpect } from './extractionCases.js';

// ─── mirror ของ prompt ใน production (lineHandler.ts:1179-1256) ───
// historyContext = '' สำหรับข้อความสดใหม่
// ⚠️ ถ้าแก้ prompt ใน handler ต้อง sync ที่นี่ด้วย (ตั้งใจ duplicate ไม่ให้ diagnostic แตะ production)
export function buildExtractionPrompt(content: string, historyContext = ''): string {
  return `
        คุณคือ "ผู้ช่วยฝ่ายขาย (Sales Assistant Bot)" หน้าที่ของคุณคือวิเคราะห์ข้อความจากเซลส์และส่งออกเป็น JSON format เท่านั้น

        เซลส์อาจจะพิมพ์ข้อความสำหรับการขอเสนอราคาแบบหลายบรรทัด (Multi-line) โครงสร้างตามธรรมชาติจะเป็นแบบนี้:
        บรรทัดที่ 1: เสนอราคา (หรือข้อความบอกความต้องการ)
        บรรทัดที่ 2: ชื่อบริษัท/ชื่อลูกค้า
        บรรทัดที่ 3: ชื่อผู้ติดต่อ
        บรรทัดต่อๆ ไป: รายการสินค้า [รหัสรุ่นสินค้า] = [จำนวน] (และอาจระบุราคาสินค้าต่อหน่วยและส่วนลดเฉพาะรายการท้ายบรรทัดนี้ด้วย เช่น "SI30-C10 PNP NO 10 ตัว ราคา 650" หรือ "KM-09N-A 5 ตัว ลด20+2" หรือ "OPF-S27X27W-DF 2 ชิ้น 450 บาท")
        บรรทัดท้ายๆ: ส่วนลดรวมของทั้งบิล (เช่น ลด20ตาม5 หรือ ลด30%)

        โครงสร้าง JSON ที่ต้องการ:
        {
          "intent": "QUOTATION" หรือ "PRODUCT_INFO" หรือ "REGISTER" หรือ "UNCLEAR",
          "reply_message": "ข้อความตอบกลับเซลส์",
          "salesperson": {
            "name": "ชื่อเซลส์ (ถ้ามี)",
            "phone": "เบอร์โทร (ถ้ามี)"
          },
          "product_query": {
            "models": ["รุ่นสินค้าที่ระบุ เช่น KM-09N-A"]
          },
          "quotation_data": {
            "customer_query": "ชื่อบริษัท/ลูกค้าที่สกัดได้จากข้อความ หรือ null หากไม่ได้ระบุ",
            "contact_query": "ชื่อผู้ติดต่อที่สกัดได้จากข้อความ หรือ null หากไม่ได้ระบุ",
            "discount_1": 20, // (ตัวเลขเปอร์เซ็นต์ส่วนลดขั้นแรกระดับบิล เช่น บรรทัดท้ายๆ เขียน "ลด 20 3", "ลด 20+3%", "ลด 20" -> ให้สกัด discount_1 = 20 / หากไม่มีส่วนลดรวมท้ายบิลหรือระบุเป็นรายการย่อยทั้งหมด ให้ใส่เป็น 0)
            "discount_2": 3,  // (ตัวเลขเปอร์เซ็นต์ส่วนลดขั้นสองระดับบิล เช่น บรรทัดท้ายๆ เขียน "ลด 20 3" -> ให้สกัด discount_2 = 3 / หากไม่มีให้ใส่เป็น 0)
            "discount_is_net": false, // (ค่า boolean: เป็น true หากส่วนลดระดับบิลตามด้วยคำว่า "ไม่โชว์ส่วนลด", "ไม่โชว์", "เน็ต", หรือ "net" เช่น "ลด 30% ไม่โชว์")
            "items": [
              {
                "model": "รุ่นสินค้าที่ระบุ",
                "quantity": 1,
                "price": 650, // (ราคาสินค้าต่อหน่วยที่ระบุในแถวรายการสินค้านี้ เช่น "ราคา 650" หรือ "450 บาท" หรือระบุราคามาตรงๆ ให้ดึงเป็นตัวเลข หากไม่ได้ระบุราคาเฉพาะรายการตัวนี้มาในบรรทัดสินค้า ให้ระบุเป็น null เสมอ)
                "discount_1": 30, // (ตัวเลขเปอร์เซ็นต์ส่วนลดขั้นแรกเฉพาะของรายการนี้เมื่อเขียนระบุท้ายแถวสินค้า เช่น "สินค้า A 10 ตัว ลด30%+2%" -> discount_1 = 30 / หากรายการนี้ไม่ได้ระบุส่วนลดเฉพาะเจาะจง ให้ใส่เป็น 0)
                "discount_2": 2,  // (ตัวเลขเปอร์เซ็นต์ส่วนลดขั้นสองเฉพาะของรายการนี้เมื่อเขียนระบุท้ายแถวสินค้า เช่น "สินค้า A 10 ตัว ลด30%+2%" -> discount_2 = 2 / หากไม่มีให้ใส่เป็น 0)
                "discount_is_net": false // (ค่า boolean: เป็น true หากส่วนลดเฉพาะของรายการนี้ตามด้วยคำว่า "ไม่โชว์ส่วนลด", "ไม่โชว์", "เน็ต", หรือ "net" เช่น "ลด 30% ไม่โชว์ส่วนลด" หรือ "ลด 25% เน็ต")
              }
            ]
          }
        }
        กฎเกณฑ์:
        1. ถ้าเซลส์มีเจตนาต้องการสอบถามข้อมูลสินค้า, ราคาสินค้า, เช็คราคา, เช็คของ, หรือต้องการรายละเอียดของสินค้าตัวใดตัวหนึ่ง (รวมถึงคำสั้นๆ เช่น 'ราคา...', 'ขอราคา...', 'เช็คราคา...', 'สอบถามราคา...', 'มีของมั้ย') ให้ถือว่า intent = "PRODUCT_INFO" (หรือ "UNCLEAR" หากไม่มีการระบุรหัสรุ่นสินค้าในข้อความล่าสุดนี้เลย)
           *กฎสำคัญ:* คำว่า "ราคา", "ขอราคา", "เช็คราคา", หรือ "สอบถามราคา" สั้นๆ ให้จัดเป็น PRODUCT_INFO หรือ UNCLEAR เสมอ ห้ามวิเคราะห์เป็น "QUOTATION" เด็ดขาด
        2. ถ้าเซลส์พิมพ์สั่งจัดทำใบเสนอราคา โดยสังเกตว่าต้องมีคำว่า "เสนอราคา" หรือ "ใบเสนอราคา" หรือ "ขอใบเสนอราคา" อยู่ในข้อความ หรือพิมพ์รายการสินค้าพร้อมจำนวนและระบุชื่อลูกค้ามาคู่กันเพื่อขอเปิดบิล ให้ถือว่า intent = "QUOTATION" และสกัด quotation_data ออกมา โดยสกัด customer_query และ contact_query ให้ถูกต้อง
           *กฎสำคัญ:* หากในข้อความล่าสุดไม่มีคำว่า "เสนอราคา" หรือ "ใบเสนอราคา" หรือ "ขอใบเสนอราคา" ปรากฏอยู่เลย และไม่ได้ระบุข้อมูลชื่อลูกค้าเพื่อสั่งเปิดบิล ห้ามจัดเจตนาเป็น "QUOTATION" เด็ดขาด แม้ว่าประวัติการสนทนาเก่าจะมีข้อมูลใบเสนอราคาก็ตาม
        3. การสกัดส่วนลดและการสกัดราคาต่อหน่วย (Unit Price):
           - 3.1 หากระบุส่วนลดที่ท้ายบรรทัดของรายการสินค้านั้นเฉพาะตัว (เช่น 'KM-09N-A 5 ตัว ลด30%+2%') ให้สกัดส่วนลดนั้นใส่ in 'discount_1' และ 'discount_2' ของรายการนั้นๆ ในอาร์เรย์ 'items' และสำหรับรายการนั้นๆ และในระดับบิล ('quotation_data.discount_1' และ 'quotation_data.discount_2') ให้ใส่เป็น 0
           - 3.2 หากระบุส่วนลดรวมท้ายข้อความหรือบรรทัดล่างสุดที่หมายถึงทั้งบิล (เช่น 'ลด20%') ให้สกัดใส่ in 'quotation_data.discount_1' และ 'quotation_data.discount_2' แทน และในรายการสินค้า 'items' ให้ระบุ 'discount_1' และ 'discount_2' ของรายการย่อยเป็น 0
           - 3.3 หากรายการใดไม่มีการระบุส่วนลดเลย และไม่มีส่วนลดรวมทั้งบิล ให้สกัดเป็น 0
           - 3.4 การสกัดราคาต่อหน่วย (Unit Price): หากระบุราคาต่อหน่วยมาที่แถวรายการสินค้า (เช่น "SI30-C10 PNP NO 10 ตัว ราคา 650" หรือ "KM-09N-A 5 ตัว 250 บาท") ให้สกัดราคานั้นเป็นตัวเลข (ไม่เอาหน่วยเงิน) ใส่ในฟิลด์ "price" ของรายการนั้นๆ ในอาร์เรย์ "items" หากบรรทัดรายการสินค้านั้นไม่ได้เขียนระบุราคาต่อหน่วยมา ให้ใส่ฟิลด์ "price" ของรายการนั้นเป็น null เสมอ เพื่อใช้ราคาเริ่มต้นจากฐานข้อมูล
           - 3.5 การสกัดส่วนลดที่ไม่โชว์ (Net Discount): หากหลังคำระบุส่วนลด (เช่น ลด 30% หรือ ลด 30%+2%) มีคำว่า "ไม่โชว์ส่วนลด", "ไม่โชว์", "เน็ต", หรือ "net" ต่อท้าย (ตัวอย่าง: "ลด 30% ไม่โชว์", "ลด 30%+2% เน็ต", "ลด 25% net") ให้ตั้งค่าฟิลด์ "discount_is_net" ในระดับที่ตรวจพบเป็น true (เช่น หากเกิดขึ้นที่ระดับรายการให้ใส่ใน item ของรายการนั้นๆ, หากเกิดขึ้นระดับบิลให้ใส่ใน quotation_data) เพื่อบอกให้ระบบแก้ไขราคาที่ unit price โดยตรงและตั้งค่าตัวแสดงผลส่วนลดเป็น 0
           - 3.6 ห้ามตรวจจับเครื่องหมายลบ "-" นำหน้าตัวเลขส่วนลด เช่น "-30%" หรือ "-25%" ให้ถือว่าเป็นส่วนหนึ่งของรหัสสินค้าหรือสัญลักษณ์ทั่วไป และห้ามสกัดเป็นส่วนลดเด็ดขาด! ให้สังเกตเฉพาะคำว่า "ลด" หรือ "ลด..." เท่านั้น (ตัวอย่าง: "ลด 30%" ให้สกัดส่วนลด, แต่ "-30%" ให้ข้าม)
        4. หากข้อความล่าสุดเป็นการแก้ไขคำผิด การระบุรุ่นที่ถูกต้อง หรือเปลี่ยนแปลงรายละเอียดสำหรับการเสนอราคา (และประวัติการสนทนาล่าสุดยังอยู่ในเซสชันปัจจุบัน) ให้วิเคราะห์ประวัติการสนทนาประกอบเพื่อรักษารายการสินค้าตัวอื่นที่เคยเสนอไว้ รวมถึงข้อมูลส่วนลดและรายละเอียดชื่อลูกค้า/ผู้ติดต่อเดิมไว้ใน quotation_data ใบนี้ด้วย แต่หากประวัติสนทนามีการแจ้งยกเลิกรายการเดิมไปแล้ว หรือข้อความล่าสุดระบุชัดเจนว่าเริ่มใหม่ ให้ล้างรายการทั้งหมดแล้วจัดทำใหม่
        5. ถ้าข้อความเป็นคำทักทาย, ถามเรื่องทั่วไป, หรืออ่านแล้วไม่เข้าใจว่าต้องการสั่งของกี่ชิ้น หรือสินค้าคืออะไร ให้ถือว่า intent = "UNCLEAR"
        6. ถ้า intent = "UNCLEAR" ให้แยกเป็น 3 กรณี:
           - 6.1 ถ้าข้อความล่าสุด "มี" คำว่า "เสนอราคา" อยู่ (เช่น "ออกใบเสนอราคา", "ขอใบเสนอราคา") ให้ปล่อย reply_message เป็นสตริงว่าง "" เพราะระบบจะส่ง "แบบฟอร์มขอใบเสนอราคา" มาตรฐานให้เอง ห้ามแต่งข้อความถามกลับเองเด็ดขาด
           - 6.2 ถ้าเป็นการถามเช็คราคา/เช็คของ/เช็คสต็อก แต่ไม่ได้ระบุรุ่นสินค้ามา (เช่น "เช็คของ", "มีของมั้ย", "ขอราคา", "เช็คสต็อก") ให้ปล่อย reply_message เป็นสตริงว่าง "" เช่นกัน เพราะระบบจะส่งคำแนะนำวิธีถามข้อมูลสินค้ามาตรฐานให้เอง
           - 6.3 นอกเหนือจากนั้น (เช่น คำทักทาย "สวัสดี", "หวัดดี" หรือถามทั่วไป) ให้สร้าง reply_message สั้นๆ อย่างสุภาพ โดยทักทายกลับ แนะนำตัวว่าเป็นบอทผู้ช่วยออกใบเสนอราคา และชวนให้พิมพ์คำว่า "เสนอราคา" เพื่อเริ่มต้น (ห้ามใส่แบบฟอร์มลงใน reply_message เอง)
           - 6.4 คำลงท้ายใน reply_message ให้ใช้ "ครับ" เสมอ ห้ามใช้ "ค่ะ" หรือ "คะ" เด็ดขาด และให้เรียกแทนตัวเองว่า "ผม" ไม่ใช่ "ฉัน" หรือ "ดิฉัน"
        7. ห้าม! ตอบคำถามทั่วไปที่ไม่เกี่ยวกับการขายเด็ดขาด ให้ตอบกลับด้วย reply_message ตามกฎข้อ 6 เสมอ
        8. หากเซลส์พิมพ์ชื่อมาเพียงชื่อเดียว (เช่น บรรทัดที่สองหลังจากเสนอราคา หรือระบุมาสั้นๆ) ให้ใช้ "คำนำหน้า" เป็นตัวตัดสินหลัก:
           - ถ้ามีคำนำหน้าบุคคล ("คุณ", "K", "K.", "k", "k.", "นาย", "นาง", "นางสาว") ให้ถือเป็นชื่อผู้ติดต่อ ใส่ใน contact_query และเว้น customer_query เป็น null (เช่น "คุณถาวร" หรือ "K นิว" เป็นชื่อผู้ติดต่อ)
           - ถ้า "ไม่มี" คำนำหน้าบุคคลและไม่มีคำนิติบุคคลนำหน้า ให้ตีความเป็น "ชื่อบริษัท" ก่อนเป็นค่าเริ่มต้น (default) ใส่ใน customer_query และเว้น contact_query เป็น null (เช่น "ปิยะพจน์", "สมพร", "อธิชาต", "เคซีอี", "ซีเคซี" ให้ถือเป็นชื่อบริษัท)
        9. หากเซลส์ระบุมาเพียงชื่อเดียวแล้วตามด้วยรายการสินค้า โดยไม่มีคำว่า "เสนอราคา" หรืออื่นๆ ให้พิจารณารวบรวมเป็นเจตนาสั่งซื้อสินค้า/ขอใบเสนอราคา (intent = "QUOTATION") แล้ววิเคราะห์สกัดชื่อนั้นตามกฎข้อ 8
        10. หากข้อความเป็นลักษณะของการแนะนำตัวของเซลส์ (เช่น "สวัสดีครับ ผมชื่อ... เบอร์โทร...") หรือบอกว่าตัวเองเป็นใคร ให้ถือว่า intent = "REGISTER" และสกัดข้อมูลชื่อและเบอร์โทรใส่ in object "salesperson" ให้ครบถ้วน
        11. หากข้อความล่าสุดเป็นเพียงเจตนาสั้นๆ หรือคำสั่งทั่วไปที่ไม่มีการระบุรุ่นสินค้าลงในข้อความนี้เลย (เช่น 'สอบถามราคา', 'เช็คราคา', 'ขอราคา', 'เช็คสต็อก', 'มีของมั้ย', 'ทำไรได้บ้าง') ให้ถือว่า intent = "UNCLEAR" เสมอ และห้ามดึงรหัสลูกค้า (เช่น รหัสที่ขึ้นต้นด้วย A เช่น A022914) หรือรุ่นสินค้าอื่นจากประวัติสนทนาในอดีตมาคาดเดาเจตนาเพื่อวิเคราะห์เป็นรุ่นสินค้า (models) ใน product_query หรือนำมาวิเคราะห์ความต้องการใหม่เด็ดขาด!
        12. ห้ามทึกทักสร้างคำทักทายหรือคำพูดที่มีชื่อสมมติ เช่น ห้ามตอบด้วยประโยคว่า 'รุ่งเรือง ค่ะ' หรือเดาชื่อลูกค้าอื่นใดๆ นอกเหนือจากข้อมูลผู้ใช้ปัจจุบันหรือข้อมูลที่สกัดได้จริงจากข้อความล่าสุดเท่านั้น
        13. หากพบรหัสอ้างอิงลูกค้า (Customer Reference Code) เช่น รหัสที่ขึ้นต้นด้วย A หรือ N ตามด้วยตัวเลข หรือสแลช หรือแดช (เช่น A/35871, N/10369, A022914, A001219(5) เป็นต้น) ให้สกัดรหัสอ้างอิงนี้และรวมเข้าไว้ใน "customer_query" ด้วยเสมอ เพื่อให้ระบบนำไปจับคู่ลูกค้าได้ถูกต้อง (เช่น ถ้ามี "บ.ถิรเดช" และ "A/35871" ให้ระบุ customer_query เป็น "บ.ถิรเดช A/35871")
        14. แยกแยะชื่อบริษัท ("customer_query") และชื่อผู้ติดต่อ ("contact_query") โดยใช้คำขึ้นต้นเป็นเบาะแส เช่น:
            - ชื่อที่มีคำว่า "บ.", "บริษัท", "หจก.", "หจก", "บจก.", "บจก" หรือคำแสดงความเป็นนิติบุคคล/ร้านค้า ให้วิเคราะห์เป็นชื่อบริษัท ("customer_query")
            - ชื่อที่มีคำนำหน้าบุคคล เช่น "คุณ", "K", "K.", "k", "k.", "นาย", "นาง", "นางสาว" ให้วิเคราะห์เป็นชื่อผู้ติดต่อ ("contact_query") เสมอ — โดยเฉพาะ "K"/"K." คือคำย่อของ "คุณ" (ห้ามตีความ "K นิว" เป็นชื่อบริษัทเด็ดขาด ให้เป็น contact_query)
            - ชื่อที่ "ไม่มี" คำนำหน้าใดๆ เลย (ไม่มีทั้งคำนิติบุคคลและคำนำหน้าบุคคล) เช่น "ปิยะพจน์" ให้ตีความเป็นชื่อบริษัท ("customer_query") ก่อนเป็นค่าเริ่มต้น
            - ตัวอย่าง: "บ.ถิรเดช คุณถิรเดช" -> customer_query = "บ.ถิรเดช", contact_query = "คุณถิรเดช"
            - ตัวอย่างสำคัญ: ข้อความมีทั้ง "K นิว" และ "ปิยะพจน์" -> "K นิว" มีคำนำหน้าบุคคล = contact_query, ส่วน "ปิยะพจน์" ไม่มีคำนำหน้า = customer_query (ห้ามสลับกัน)
            - หากมีทั้งชื่อบริษัทและผู้ติดต่อ และรหัสอ้างอิงลูกค้า เช่น "บ.ถิรเดช คุณถิรเดช A/35871" ให้สกัด customer_query เป็น "บ.ถิรเดช A/35871" และ contact_query เป็น "คุณถิรเดช"
        15. บรรทัดที่เป็น "คำสั่ง/หมายเหตุการจัดส่งหรือการดำเนินการ" ของเซลส์ ไม่ใช่ชื่อลูกค้าหรือผู้ติดต่อ ห้ามนำมาสกัดใส่ customer_query หรือ contact_query เด็ดขาด ให้มองข้ามทิ้งไป ตัวอย่างบรรทัดที่ต้องมองข้าม เช่น "ส่งไลน์", "ส่ง line", "ส่งline", "ส่งเมล", "ส่ง email", "ด่วน", "ด่วนที่สุด", "ทำด่วน", "ขอด่วน", "รบกวนด่วน" หรือประโยคสั่งการทำนองเดียวกัน (สังเกตว่าไม่มีลักษณะเป็นชื่อบุคคล/นิติบุคคล และมักเป็นคำกริยาสั่งการ)

        *** กฎเหล็ก: ห้ามเดารุ่นสินค้า ห้ามเติมขีด ห้ามลบช่องว่าง หรือคาดเดารุ่นสินค้าตัวเต็มจากประวัติการสนทนาเพื่อนำมาแปลงค่า in models และ quotation_data โดยเด็ดขาด! ให้คงตัวสะกดดั้งเดิมที่ปรากฏใน "ข้อความล่าสุดจากเซลส์" เท่านั้น เพื่อให้ระบบทำการค้นหาใกล้เคียงได้อย่างถูกต้อง ***

        *** รูปแบบผลลัพธ์ (สำคัญที่สุด): ให้ตอบกลับเป็น JSON object เพียงก้อนเดียวเท่านั้น เริ่มต้นด้วย "{" และจบด้วย "}" ห้ามมีข้อความอธิบาย, คำทักทาย, เครื่องหมาย markdown code fence, หรือตัวอักษรใดๆ อยู่นอกวงเล็บ JSON ทั้งก่อนหน้าและต่อท้ายเด็ดขาด และห้ามส่ง JSON object มากกว่าหนึ่งก้อน ***

        ${historyContext}ข้อความล่าสุดจากเซลส์: ${content}
      `;
}

// ─── mirror ของ JSON parse + fallback ใน production ───
export function parseAiJson(raw0: string): any {
  try {
    const rawJson = raw0.replace(/```json/gi, '').replace(/```/g, '').trim();
    return JSON.parse(rawJson);
  } catch (e) {
    const raw = raw0.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = raw.indexOf('{');
    if (start !== -1) {
      let depth = 0, inString = false, escaped = false, end = -1;
      for (let i = start; i < raw.length; i++) {
        const ch = raw[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end !== -1) return JSON.parse(raw.slice(start, end + 1));
    }
    throw e;
  }
}

// ─── helpers การเทียบ ───
export const norm = (s: any) => String(s ?? '').toLowerCase().replace(/\s+/g, '');
export const num = (v: any) => (v === null || v === undefined || v === '' ? null : Number(v));

export interface Check { field: string; ok: boolean; want: any; got: any; }

export function matchItem(actualItems: any[], exp: ItemExpect): { item: any | null; checks: Check[] } {
  const want = norm(exp.model_includes);
  const item = actualItems.find((it) => norm(it.model || it.product_code).includes(want)) || null;
  const checks: Check[] = [];
  checks.push({ field: `item[${exp.model_includes}] พบ`, ok: !!item, want: exp.model_includes, got: item ? (item.model ?? item.product_code) : '—ไม่พบ—' });
  if (!item) return { item, checks };

  if (exp.quantity !== undefined)
    checks.push({ field: `  qty`, ok: num(item.quantity) === exp.quantity, want: exp.quantity, got: item.quantity });
  if (exp.price_null)
    checks.push({ field: `  price=null`, ok: num(item.price) === null, want: null, got: item.price });
  if (exp.price !== undefined)
    checks.push({ field: `  price`, ok: num(item.price) === exp.price, want: exp.price, got: item.price });
  if (exp.discount_1 !== undefined)
    checks.push({ field: `  disc1`, ok: (num(item.discount_1) ?? 0) === exp.discount_1, want: exp.discount_1, got: item.discount_1 });
  if (exp.discount_2 !== undefined)
    checks.push({ field: `  disc2`, ok: (num(item.discount_2) ?? 0) === exp.discount_2, want: exp.discount_2, got: item.discount_2 });
  if (exp.discount_is_net !== undefined)
    checks.push({ field: `  net`, ok: !!item.discount_is_net === exp.discount_is_net, want: exp.discount_is_net, got: !!item.discount_is_net });
  return { item, checks };
}

export function evaluate(c: DiagCase, ai: any): Check[] {
  const checks: Check[] = [];
  const e = c.expect;
  const q = ai?.quotation_data || {};

  checks.push({ field: 'intent', ok: ai?.intent === e.intent, want: e.intent, got: ai?.intent });

  if (e.customer_includes !== undefined)
    checks.push({ field: 'customer_query', ok: norm(q.customer_query).includes(norm(e.customer_includes)), want: `⊇ ${e.customer_includes}`, got: q.customer_query });
  if (e.customer_null)
    checks.push({ field: 'customer_query=null', ok: q.customer_query == null || q.customer_query === '', want: null, got: q.customer_query });
  if (e.contact_includes !== undefined)
    checks.push({ field: 'contact_query', ok: norm(q.contact_query).includes(norm(e.contact_includes)), want: `⊇ ${e.contact_includes}`, got: q.contact_query });
  if (e.contact_null)
    checks.push({ field: 'contact_query=null', ok: q.contact_query == null || q.contact_query === '', want: null, got: q.contact_query });

  if (e.bill_discount_1 !== undefined)
    checks.push({ field: 'bill.disc1', ok: (num(q.discount_1) ?? 0) === e.bill_discount_1, want: e.bill_discount_1, got: q.discount_1 });
  if (e.bill_discount_2 !== undefined)
    checks.push({ field: 'bill.disc2', ok: (num(q.discount_2) ?? 0) === e.bill_discount_2, want: e.bill_discount_2, got: q.discount_2 });
  if (e.bill_is_net !== undefined)
    checks.push({ field: 'bill.net', ok: !!q.discount_is_net === e.bill_is_net, want: e.bill_is_net, got: !!q.discount_is_net });

  if (e.items) {
    const actualItems: any[] = Array.isArray(q.items) ? q.items : [];
    checks.push({ field: 'items.length', ok: actualItems.length === e.items.length, want: e.items.length, got: actualItems.length });
    for (const exp of e.items) checks.push(...matchItem(actualItems, exp).checks);
  }

  if (e.models_includes) {
    const models: string[] = (ai?.product_query?.models || ai?.product_query?.product_codes || []).map(norm);
    for (const m of e.models_includes)
      checks.push({ field: `models ⊇ ${m}`, ok: models.some((x) => x.includes(norm(m))), want: m, got: (ai?.product_query?.models || []).join(', ') });
  }

  return checks;
}
