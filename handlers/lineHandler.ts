import { openai, lineClient } from '../config/clients.js';
import { pool } from '../config/db.js';
import {
  getSalespersonByUserId,
  insertSalesperson,
  updateSalespersonByUserId,
  insertMessage,
  getRecentMessages,
  getQuotationsByIds,
  getQuotationsByNos,
  getRecentConfirmedQuotations,
  deletePendingQuotations,
  getStaticBranches,
  getBranchesByCodes,
} from '../db/repositories.js';
import { validateProductPriceWithPromotions } from '../utils/promotionValidator.js';
import { 
  createBranchSelectionFlex, 
  getQuotationSummaryMessage, 
  createListFlexMessage,
  createEditMenuFlex,
  createSalespersonProfileFlex,
  createProfileConfirmationFlex,
  createCartConfirmationFlex
} from '../utils/flexTemplates.js';
import { findProduct } from '../services/productService.js';
import { 
  findCustomerCandidates,
  findContactCandidates,
  formatLineLabel,
  splitCustomerContact
} from '../services/customerService.js';
import { 
  getQuotationNo, 
  processQuotationRequest, 
  resolveContactFlow,
  cancelOldRevision,
  updateQuotationCustomerSnapshot,
  insertDraftQuotations,
  enrichQuotationData
} from '../services/quotationService.js';

export async function handleImage(event: any): Promise<any> {
  try {
    return await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: 'ขออภัยครับ ตอนนี้ยังไม่รองรับการส่งภาพเข้ามาประมวลผลครับ 📷' }]
    });
  } catch (err) {
    console.error("Error in handleImage:", err);
  }
}

export async function handleEvent(event: any): Promise<any> {
  let customMessages: any = null;
  try {
    const userId = event?.source?.userId || 'unknown';
    // ดึงข้อมูลพนักงานขายเพื่อตรวจสอบสถานะ
    const salesperson = await getSalespersonByUserId(userId);

    // 1. ตรวจสอบสถานะการลงทะเบียนพนักงานขาย
    const isRegisteringText = event.type === 'message' && event.message.type === 'text' && 
      (event.message.text.trim() === '🎉 ลงทะเบียนพนักงานขายสำเร็จ' || event.message.text.trim() === '✅ อัปเดตข้อมูลพนักงานขายสำเร็จ');

    if (!salesperson || (salesperson.status !== 'active' && !salesperson.status.startsWith('edit_') && !salesperson.status.startsWith('custom_quote:'))) {
      if (isRegisteringText) {
        // ให้ส่งผ่านไปยังตัวประมวลผลข้อความด้านล่าง เพื่อยืนยันความสำเร็จ
      } else {
        if (!salesperson) {
          await insertSalesperson({
            user_id: userId,
            name: 'รอดำเนินการ',
            status: 'pending_branch'
          });
        }
        const flexMsg = createBranchSelectionFlex('', false, userId);
        return lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [
            { type: 'text', text: 'สวัสดีครับ คุณยังไม่ได้ลงทะเบียนผู้ใช้งานในระบบ เพื่อความปลอดภัย กรุณาลงทะเบียนผ่านลิงก์ด้านล่างก่อนเริ่มต้นใช้งานครับ 🙏' },
            flexMsg as any
          ]
        });
      }
    }

    if (event.type === 'postback') {
      const data = event.postback.data;
      const params = new URLSearchParams(data);
      const action = params.get('action');
      const quoteIdParam = params.get('id') || params.get('quoteId') || '';



      if (action === 'edit_menu') {
        const sub = params.get('sub');
        if (sub === 'profile' || sub === 'branches') {
          const flexMsg = createBranchSelectionFlex(salesperson.branch_code || '', true, userId);
          return lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [flexMsg as any]
          });
        } else if (sub === 'quotation') {
          await updateSalespersonByUserId(userId, { status: 'edit_quote_number' });
          return lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ 
              type: 'text', 
              text: 'กรุณาระบุเลขที่ใบเสนอราคาที่ต้องการแก้ไขครับ 📄 (ตัวอย่าง: QT-260605001 หรือ QP-260605001)' 
            }]
          });
        }
      }

      if (action === 'edit_btn') {
        const target = params.get('target');
        const field = params.get('field');
        if (target === 'salesperson') {
          let label = '';
          if (field === 'name') label = 'ชื่อ-นามสกุลจริง';
          else if (field === 'phone') label = 'เบอร์โทรศัพท์';
          else if (field === 'salesperson_id') label = 'รหัสพนักงาน';
          
          await updateSalespersonByUserId(userId, { status: `edit_field:salesperson:${field}` });
          return lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{
              type: 'text',
              text: `👤 กรุณาพิมพ์ **${label}ใหม่** ที่ต้องการแก้ไข ส่งเข้ามาในห้องแชทได้เลยครับ\n\n(หรือพิมพ์ "ยกเลิก" เพื่อข้าม)`,
              quickReply: {
                items: [
                  { type: 'action', action: { type: 'message', label: '❌ ยกเลิก', text: 'ยกเลิก' } }
                ]
              }
            }]
          });
        }
      }

      if (action === 'cancel') {
        const quoteIds = quoteIdParam.split(',').filter(Boolean);
        const replyMessages: any[] = [];
        for (const qId of quoteIds) {
          const quoteRes = await pool.query(
            'SELECT status, quotation_no FROM quotations WHERE id = $1',
            [qId]
          );

          if (quoteRes.rows.length === 0) {
            replyMessages.push({
              type: 'text',
              text: `❌ ไม่พบข้อมูลใบเสนอราคา ID: ${qId}`
            });
            continue;
          }

          const currentQuote = quoteRes.rows[0];

          if (currentQuote.status === 'confirmed') {
            replyMessages.push({
              type: 'text',
              text: `❌ ใบเสนอราคาเลขที่: ${currentQuote.quotation_no || '-'} ออกเอกสารสำเร็จแล้ว ไม่สามารถยกเลิกได้`
            });
            continue;
          }
          if (currentQuote.status === 'cancelled') {
            replyMessages.push({
              type: 'text',
              text: `❌ ใบเสนอราคานี้ได้รับการยกเลิกเรียบร้อยแล้ว`
            });
            continue;
          }

          const hasQuotationNo = currentQuote.quotation_no && currentQuote.quotation_no.trim() !== '';

          if (!hasQuotationNo) {
            await pool.query(
              'DELETE FROM quotations WHERE id = $1',
              [qId]
            );
            replyMessages.push({
              type: 'text',
              text: `❌ ยกเลิกการออกใบเสนอราคาเรียบร้อยแล้ว`
            });
          } else {
            await pool.query(
              "UPDATE quotations SET status = 'cancelled' WHERE id = $1",
              [qId]
            );
            replyMessages.push({
              type: 'text',
              text: `❌ ยกเลิกการออกใบเสนอราคาเรียบร้อยแล้ว`
            });
          }

          // บันทึกลง messages เพื่อเคลียร์ประวัติในบอท
          try {
            await insertMessage({
              user_id: userId,
              message_id: `postback_cancel_${Date.now()}`,
              type: 'postback',
              content: 'ยกเลิก',
              reply_token: event.replyToken,
              reply_content: '❌ ยกเลิกการออกใบเสนอราคาเรียบร้อยแล้ว'
            });
          } catch (err) {
            console.error("Error logging cancel postback:", err);
          }
        }
        return lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: replyMessages.slice(0, 5)
        });
      }
      if (action === 'cancel_pending') {
        await pool.query(
          "DELETE FROM quotations WHERE user_id = $1 AND status = ANY($2)",
          [userId, ['pending_company', 'pending_contact', 'draft']]
        );

        // บันทึกลง messages เพื่อเคลียร์ประวัติในบอท
        try {
          await insertMessage({
            user_id: userId,
            message_id: `postback_cancel_pending_${Date.now()}`,
            type: 'postback',
            content: 'ยกเลิก',
            reply_token: event.replyToken,
            reply_content: '❌ ยกเลิกการออกใบเสนอราคาเรียบร้อยแล้ว'
          });
        } catch (err) {
          console.error("Error logging cancel_pending postback:", err);
        }

        return lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'text', text: '❌ ยกเลิกการออกใบเสนอราคาเรียบร้อยแล้ว' }]
        });
      }
      if (action === 'confirm') {
        const quoteIds = quoteIdParam.split(',').filter(Boolean);
        const replyMessages: any[] = [];
        for (const qId of quoteIds) {
          // 1. ดึงข้อมูลใบเสนอราคาปัจจุบันก่อนเพื่อดูเวลาสร้าง (created_at)
          let currentQuote: any = null;
          try {
            const fetchRes = await pool.query("SELECT * FROM quotations WHERE id = $1 LIMIT 1", [qId]);
            if (fetchRes.rows.length > 0) {
              currentQuote = await enrichQuotationData(fetchRes.rows[0]);
            }
          } catch (err) {
            console.error("Fetch quote error:", err);
          }
          if (!currentQuote) {
            replyMessages.push({
              type: 'text',
              text: `❌ ไม่พบข้อมูลใบเสนอราคา ID: ${qId}`
            });
            continue;
          }

          if (currentQuote.status === 'cancelled') {
            replyMessages.push({
              type: 'text',
              text: `❌ ใบเสนอราคานี้ถูกยกเลิกไปแล้ว ไม่สามารถยืนยันได้`
            });
            continue;
          }

          const reqUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3011}`;
          const pdfLink = `${reqUrl}/download-pdf/${qId}?openExternalBrowser=1`;

          if (currentQuote.status === 'confirmed') {
            replyMessages.push({
              type: 'text',
              text: `ℹ️ ใบเสนอราคาเลขที่: ${currentQuote.quotation_no || '-'} ได้รับการยืนยันออกเอกสารเรียบร้อยแล้ว`
            });
            replyMessages.push({
              type: 'template',
              altText: `ดาวน์โหลดใบเสนอราคา ${currentQuote.quotation_no} (PDF)`,
              template: {
                type: 'buttons',
                text: `ดาวน์โหลดใบเสนอราคา ${currentQuote.quotation_no}`,
                actions: [
                  {
                    type: 'uri',
                    label: '📥 ดาวน์โหลด PDF',
                    uri: pdfLink
                  }
                ]
              }
            });
            continue;
          }

          // ตรวจสอบราคาสินค้าแต่ละรายการหลังหักส่วนลดต้อง >= minimum_sales_price หรือตรงเงื่อนไขโปรโมชัน
          if (currentQuote.items && Array.isArray(currentQuote.items)) {
            const productCodes = currentQuote.items.map((item: any) => item.model || item.product_code).filter(Boolean);
            if (productCodes.length > 0) {
              try {
                // คิวรีดึงขั้นต่ำสินค้าด้วย pool.query (ตามกฎงดใช้ Supabase-style query สำหรับการพัฒนาใหม่)
                const prodRes = await pool.query(
                  'SELECT model AS code, minimum_sales_price FROM products WHERE model = ANY($1)',
                  [productCodes]
                );
                const productsData = prodRes.rows;

                if (productsData) {
                  const minPriceMap: Record<string, number> = {};
                  productsData.forEach((p: any) => {
                    minPriceMap[p.code] = parseFloat(p.minimum_sales_price) || 0;
                  });

                  // คิวรีข้อมูลลูกค้า (customer_type, reference)
                  let companyName = currentQuote.customer_name || 'ลูกค้าทั่วไป';
                  if (currentQuote.customer_name && currentQuote.customer_name.includes(' | ')) {
                    companyName = currentQuote.customer_name.split(' | ')[0].trim();
                  }

                  let customerData = null;
                  if (companyName && companyName !== 'ลูกค้าทั่วไป') {
                    const custRes = await pool.query(
                      'SELECT customer_type, reference FROM customers_view WHERE display_name = $1 LIMIT 1',
                      [companyName]
                    );
                    if (custRes.rows.length > 0) {
                      customerData = {
                        customer_type: custRes.rows[0].customer_type,
                        reference: custRes.rows[0].reference
                      };
                    }
                  }

                  // คิวรีข้อมูลโปรโมชันที่กำลัง active ทั้งหมด
                  const promoRes = await pool.query(
                    'SELECT * FROM promotions WHERE is_active = true'
                  );
                  const activePromos = promoRes.rows;

                  const violations: string[] = [];
                  for (const item of currentQuote.items) {
                    const itemKey = item.model || item.product_code;
                    const minPrice = minPriceMap[itemKey] || 0;
                    if (minPrice <= 0) continue;
                    const price = parseFloat(item.price) || 0;
                    const disc1 = parseFloat(item.discount_1) || 0;
                    const disc2 = parseFloat(item.discount_2) || 0;
                    const discountedPrice = price * (1 - disc1 / 100) * (1 - disc2 / 100);

                    if (discountedPrice < minPrice - 0.01) {
                      // หากไม่ผ่านขั้นต่ำปกติ ให้ไปตรวจสอบสิทธิ์จากโปรโมชัน
                      const promoResult = validateProductPriceWithPromotions(
                        itemKey,
                        item.quantity || 1,
                        discountedPrice,
                        minPrice,
                        customerData,
                        activePromos
                      );

                      if (!promoResult.allowed) {
                        violations.push(`• ${itemKey}: ราคาหลังลด ฿${discountedPrice.toFixed(2)} < ขั้นต่ำ ฿${minPrice.toFixed(2)} (ไม่เข้าเงื่อนไขโปรโมชัน)`);
                      }
                    }
                  }

                  if (violations.length > 0) {
                    replyMessages.push({
                      type: 'text',
                      text: `❌ ไม่สามารถยืนยันใบเสนอราคาได้\nราคาหลังหักส่วนลดต่ำกว่าราคาขั้นต่ำที่กำหนด และไม่เข้าเงื่อนไขโปรโมชัน:\n${violations.join('\n')}\n\nกรุณาแก้ไขส่วนลดหรือราคาแล้วลองใหม่อีกครั้ง`
                    });
                    continue;
                  }
                }
              } catch (minPriceErr) {
                console.error("Error checking minimum_sales_price in chatbot confirm:", minPriceErr);
              }
            }
          }

          // 2. ถ้ามีเลขที่อยู่แล้วให้ใช้เลขเดิม (ป้องกันการกดยืนยันซ้ำแล้วเลขรันเพิ่ม)
          let quoteNo = currentQuote.quotation_no;
          const isRevision = currentQuote.customer_name && currentQuote.customer_name.includes('revise_from=');
          if (!quoteNo) {
            quoteNo = await getQuotationNo(currentQuote);
          }
          
          const updatePayload: any = {
            status: 'confirmed',
            quotation_no: quoteNo
          };
          if (isRevision) {
            updatePayload.created_at = new Date().toISOString();
          }

          // 3. อัปเดตสถานะเป็น confirmed และบันทึก quotation_no ลงในฐานข้อมูล
          let hasUpdateError = false;
          try {
            if (isRevision && updatePayload.created_at) {
              await pool.query(
                "UPDATE quotations SET status = $1, quotation_no = $2, created_at = $3, updated_at = NOW() WHERE id = $4",
                [updatePayload.status, updatePayload.quotation_no, updatePayload.created_at, qId]
              );
            } else {
              await pool.query(
                "UPDATE quotations SET status = $1, quotation_no = $2, updated_at = NOW() WHERE id = $3",
                [updatePayload.status, updatePayload.quotation_no, qId]
              );
            }
          } catch (err) {
            console.error("Update confirmed error:", err);
            hasUpdateError = true;
          }
          if (hasUpdateError) {
            replyMessages.push({
              type: 'text',
              text: `❌ เกิดข้อผิดพลาดในการยืนยันใบเสนอราคา ID: ${qId}`
            });
            continue;
          }

          if (isRevision) {
            await cancelOldRevision(currentQuote.customer_name);
          }

          // สร้างลิงก์ให้ดาวน์โหลด โดยส่งแค่ quoteId ไป (ระบบจะไปวาด PDF สดๆ เมื่อเซลส์กดลิงก์)
          replyMessages.push({
            type: 'text',
            text: `✅ ยืนยันสำเร็จ!\n📄 ใบเสนอราคาเลขที่: ${quoteNo}`
          });
          replyMessages.push({
            type: 'template',
            altText: `ดาวน์โหลดใบเสนอราคา ${quoteNo} (PDF)`,
            template: {
              type: 'buttons',
              text: `ดาวน์โหลดใบเสนอราคา ${quoteNo}`,
              actions: [
                {
                  type: 'uri',
                  label: '📥 ดาวน์โหลด PDF',
                  uri: pdfLink
                }
              ]
            }
          });

          // บันทึกลง messages เพื่อเคลียร์ประวัติในบอท
          try {
            await insertMessage({
              user_id: userId,
              message_id: `postback_confirm_${Date.now()}`,
              type: 'postback',
              content: 'ยืนยันออกใบเสนอราคา',
              reply_token: event.replyToken,
              reply_content: `✅ ยืนยันสำเร็จ!\n📄 ใบเสนอราคาเลขที่: ${quoteNo}`
            });
          } catch (err) {
            console.error("Error logging confirm postback:", err);
          }
        }
        const finalMessages = replyMessages.slice(0, 5);
        return lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: finalMessages
        });
      }

      if (action === 'select_company') {
        const custId = params.get('custId');
        if (!custId) {
          return lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '❌ ข้อมูลไม่ถูกต้องหรือเซสชันหมดอายุ' }]
          });
        }

        // Fetch pending quotations for this user
        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        let pendingQuotes: any[] = [];
        try {
          const selectRes = await pool.query(
            "SELECT * FROM quotations WHERE user_id = $1 AND status = 'pending_company' AND created_at >= $2 ORDER BY created_at DESC",
            [userId, tenMinutesAgo]
          );
          const enrichPromises = selectRes.rows.map(q => enrichQuotationData(q));
          pendingQuotes = await Promise.all(enrichPromises);
        } catch (err) {
          console.error("Error fetching pending quotes in select_company:", err);
        }

        if (pendingQuotes.length === 0) {
          return lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '❌ เซสชันหมดอายุหรือไม่มีใบเสนอราคาที่กำลังดำเนินการ' }]
          });
        }

        // Find customer ID
        let customer: any = null;
        try {
          const compRes = await pool.query(
            "SELECT id, display_name FROM customers_view WHERE id = $1 LIMIT 1",
            [custId]
          );
          if (compRes.rows.length > 0) {
            customer = compRes.rows[0];
          }
        } catch (err) {
          console.error("Error fetching customer in select_company:", err);
        }

        if (!customer) {
          return lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: `❌ ไม่พบข้อมูลบริษัทในระบบ` }]
          });
        }

        const companyName = customer.display_name;
        const quoteIdsStr = pendingQuotes.map((q: any) => q.id).join(',');

        const parts = pendingQuotes[0].customer_name.split('|');
        const contactQuery = parts[1] ? parts[1].trim() : '';

        const result = await resolveContactFlow(
          userId,
          quoteIdsStr,
          customer.id,
          companyName,
          contactQuery,
          null,
          salesperson
        );

        if (result.success) {
          const summary = await getQuotationSummaryMessage(result.quotes);
          return lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: summary.messages as any
          });
        } else {
          let messages: any[];
          if (result.type === 'flex') {
            messages = [result];
          } else {
            messages = [{ type: 'text', text: result.text }];
            if (result.quickReply) {
              messages[0].quickReply = result.quickReply;
            }
          }
          return lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: messages
          });
        }
      }

      if (action === 'select_contact') {
        const contactId = params.get('contactId');

        // Fetch pending quotations for this user
        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        let pendingQuotes: any[] = [];
        try {
          const selectRes = await pool.query(
            "SELECT * FROM quotations WHERE user_id = $1 AND status = 'pending_contact' AND created_at >= $2 ORDER BY created_at DESC",
            [userId, tenMinutesAgo]
          );
          const enrichPromises = selectRes.rows.map(q => enrichQuotationData(q));
          pendingQuotes = await Promise.all(enrichPromises);
        } catch (err) {
          console.error("Error fetching pending quotes in select_contact:", err);
        }

        if (pendingQuotes.length === 0) {
          return lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '❌ เซสชันหมดอายุหรือไม่มีใบเสนอราคาที่กำลังดำเนินการ' }]
          });
        }

        if (!contactId) {
          return lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '❌ ข้อมูลผู้ติดต่อไม่ถูกต้อง' }]
          });
        }

        let dbContact: any = null;
        try {
          const contactRes = await pool.query(
            "SELECT name, customer_id FROM contacts_view WHERE id = $1 LIMIT 1",
            [contactId]
          );
          if (contactRes.rows.length > 0) {
            dbContact = contactRes.rows[0];
          }
        } catch (err) {
          console.error("Error fetching contact in select_contact:", err);
        }

        if (!dbContact) {
          return lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '❌ ไม่พบข้อมูลผู้ติดต่อในระบบ' }]
          });
        }

        const contactName = dbContact.name;
        const resolvedCustomerId = dbContact.customer_id;

        const quoteIds = pendingQuotes.map((q: any) => q.id);
        const parts = pendingQuotes[0].customer_name.split('|');
        const companyName = parts[0] ? parts[0].trim() : '';
        const finalCustomerName = `${companyName} | ${contactName}`;

        // Update all quotations to draft and update customer_details Snapshot
        let updatedQuotes: any[] = [];
        try {
          updatedQuotes = await updateQuotationCustomerSnapshot(quoteIds, finalCustomerName, 'draft', salesperson, resolvedCustomerId, Number(contactId));
        } catch (err) {
          console.error("Error updating snapshot in select_contact:", err);
        }

        if (updatedQuotes.length === 0) {
          return lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '❌ ไม่สามารถอัปเดตข้อมูลใบเสนอราคาได้' }]
          });
        }

        // Generate summary and confirm/cancel options
        const summary = await getQuotationSummaryMessage(updatedQuotes);
        return lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: summary.messages as any
        });
      }
      return;
    }
    if (event.type === "message" && event.message.type === "image") {
      return handleImage(event);
    }
    if (event.type !== 'message') return null;
    const replyToken = event.replyToken || '';
    const messageId = event.message.id;
    const messageType = event.message.type;
    let content = '';
    let botReplyText = '';
    if (event.message.type === 'text') {
      content = event.message.text;

      // Ignore status messages sent by LIFF back to the chat to prevent loops
      const trimmedContent = content.trim();
      if (trimmedContent === '❌ ยกเลิกการออกใบเสนอราคาเรียบร้อยแล้ว') {
        return null;
      }

      if (trimmedContent.startsWith('💾 ร่างใบเสนอราคา')) {
        const match = trimmedContent.match(/(?:รหัส):\s*([a-zA-Z0-9,\s-]+)/);
        let quoteIds = '';
        if (match) {
          quoteIds = match[1].trim();
        } else {
          const uuids = trimmedContent.match(/[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}/g);
          if (uuids) {
            quoteIds = uuids.join(',');
          }
        }

        if (quoteIds) {
          const liffId = process.env.LIFF_QUOTE_ID || process.env.LIFF_ID || '';
          const liffUrl = `https://liff.line.me/${liffId}?quoteIds=${encodeURIComponent(quoteIds)}`;

          const flexMsg = {
            type: "flex",
            altText: "กรอกข้อมูลลูกค้า",
            contents: {
              type: "bubble",
              size: "mega",
              body: {
                type: "box",
                layout: "vertical",
                spacing: "md",
                contents: [
                  {
                    type: "text",
                    text: "รับทราบครับ กรุณาระบุ ชื่อลูกค้า/ผู้ติดต่อ ที่ต้องการเสนอราคาด้วยการพิมพ์หรือกดปุ่มด้านล่าง เพื่อดำเนินการต่อครับ",
                    wrap: true,
                    size: "sm",
                    color: "#374151"
                  }
                ]
              },
              footer: {
                type: "box",
                layout: "vertical",
                contents: [
                  {
                    type: "button",
                    action: {
                      type: "uri",
                      label: "🏢 กรอกข้อมูลลูกค้า",
                      uri: liffUrl
                    },
                    style: "primary",
                    color: "#2563EB",
                    height: "sm"
                  }
                ]
              }
            }
          };

          try {
            await insertMessage({
              user_id: userId,
              message_id: messageId,
              type: 'text',
              content: content,
              reply_token: replyToken,
              reply_content: 'รับทราบครับ กรุณาระบุ ชื่อลูกค้า/ผู้ติดต่อ ที่ต้องการเสนอราคาด้วยการพิมพ์หรือกดปุ่มด้านล่างเพื่อดำเนินการต่อครับ (กรอกข้อมูลลูกค้า)'
            });
          } catch (dbErr) {
            console.error("Error logging draft cart message:", dbErr);
          }

          return lineClient.replyMessage({
            replyToken: replyToken,
            messages: [flexMsg as any]
          });
        }
      }

      if (trimmedContent.includes('📄 ยืนยันใบเสนอราคาสำเร็จ')) {
        let quoteIds: string[] = [];
        let quotationNos: string[] = [];

        const match = trimmedContent.match(/(?:รหัส|เลขที่):\s*([a-zA-Z0-9,\s-]+)/);
        if (match) {
          const tokens = match[1].split(',').map(t => t.trim());
          for (const token of tokens) {
            if (token.length === 36) {
              quoteIds.push(token);
            } else if (token.toUpperCase().startsWith('QP-') || token.toUpperCase().startsWith('QT-')) {
              quotationNos.push(token.toUpperCase());
            }
          }
        }

        // Also check for zero-width fallback just in case
        const decodeZeroWidth = (text: string) => {
          const m = text.match(/[\u200b\u200c\u200d]+/);
          if (!m) return '';
          try {
            return m[0].split('\u200d').map(b => {
              if (!b) return '';
              const binary = b.split('').map(c => c === '\u200b' ? '0' : '1').join('');
              return String.fromCharCode(parseInt(binary, 2));
            }).join('');
          } catch (e) {
            return '';
          }
        };

        const zeroWidthDecoded = decodeZeroWidth(trimmedContent);
        if (zeroWidthDecoded) {
          quoteIds = quoteIds.concat(zeroWidthDecoded.split(','));
        }

        try {
          let quotes: any[] | null = null;

          if (quoteIds.length > 0) {
            // Fetch quotation details from postgresdb using IDs
            quotes = await getQuotationsByIds(quoteIds);
          } else if (quotationNos.length > 0) {
            // Fetch quotation details from postgresdb using quotation numbers
            quotes = await getQuotationsByNos(quotationNos);
          } else {
            // Fallback: Query the latest confirmed quotations for this user in the last 1 minute
            const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
            quotes = await getRecentConfirmedQuotations(userId, oneMinuteAgo);
          }

          if (quotes && quotes.length > 0) {
            const reqUrl = process.env.APP_URL || '';
            const messages: any[] = [];

            for (const q of quotes) {
              const quoteNo = q.quotation_no || '-';
              const pdfLink = `${reqUrl}/download-pdf/${q.id}?openExternalBrowser=1`;
              
              messages.push({
                type: 'text',
                text: `✅ ยืนยันสำเร็จ!\n📄 ใบเสนอราคาเลขที่: ${quoteNo}`
              });

              messages.push({
                type: 'template',
                altText: `ดาวน์โหลดใบเสนอราคา ${quoteNo} (PDF)`,
                template: {
                  type: 'buttons',
                  text: `ดาวน์โหลดใบเสนอราคา ${quoteNo}`,
                  actions: [
                    {
                      type: 'uri',
                      label: '📥 ดาวน์โหลด PDF',
                      uri: pdfLink
                    }
                  ]
                }
              });
            }

            const finalMessages = messages.slice(0, 5);

            return lineClient.replyMessage({
              replyToken: replyToken,
              messages: finalMessages
            });
          }
        } catch (err) {
          console.error("Error processing confirm quote trigger:", err);
        }
      }

      if (trimmedContent === '🎉 ลงทะเบียนพนักงานขายสำเร็จ' || trimmedContent === '✅ อัปเดตข้อมูลพนักงานขายสำเร็จ') {
        const isRegistering = trimmedContent === '🎉 ลงทะเบียนพนักงานขายสำเร็จ';
        try {
          // Fetch salesperson profile
          const sp = await getSalespersonByUserId(userId);

          if (sp) {
            // Fetch branch names
            const selectedCodes = sp.branch_code ? sp.branch_code.split(',').map((c: any) => c.trim()).filter(Boolean) : [];
            let branchNames = sp.branch_code || 'ไม่ได้เลือกสาขา';
            if (selectedCodes.length > 0) {
              const branches = getBranchesByCodes(selectedCodes);
              if (branches && branches.length > 0) {
                branchNames = branches.map((b: any) => b.name).join(', ');
              }
            }

            let msg = '';
            if (isRegistering) {
              msg = `ลงทะเบียนสำเร็จเรียบร้อยแล้วครับ! 🎉\n\n👤 คุณ: ${sp.name}\n🏢 สังกัดสาขา: ${branchNames}`;
              if (sp.salesperson_id) msg += `\n🆔 รหัสพนักงาน: ${sp.salesperson_id}`;
              if (sp.phone) msg += `\n📞 เบอร์โทร: ${sp.phone}`;
              msg += `\n\nตอนนี้ระบบพร้อมใช้งานแล้วครับ คุณสามารถพิมพ์สั่งเช็คสต็อกสินค้าหรือพิมพ์ขอให้ออกใบเสนอราคาได้ทันทีครับ 🤖✨`;
            } else {
              msg = `✅ อัปเดตข้อมูลส่วนตัวและสาขาดูแลสำเร็จเรียบร้อยแล้วครับ!\n\n👤 คุณ: ${sp.name}\n🏢 สาขาที่ดูแลในปัจจุบัน: ${branchNames}`;
              if (sp.salesperson_id) msg += `\n🆔 รหัสพนักงาน: ${sp.salesperson_id}`;
              if (sp.phone) msg += `\n📞 เบอร์โทร: ${sp.phone}`;
            }

            return lineClient.replyMessage({
              replyToken: replyToken,
              messages: [{ type: 'text', text: msg }]
            });
          }
        } catch (err) {
          console.error("Error processing profile update reply:", err);
        }
      }

      if (trimmedContent.includes('[DRAFT_CART]:')) {
        const match = trimmedContent.match(/\[DRAFT_CART\]:ids=([^&]+)&count=(\d+)/);
        if (match) {
          const quoteIds = match[1];
          const count = parseInt(match[2]);
          const flexMsg = createCartConfirmationFlex(quoteIds, count);
          return lineClient.replyMessage({
            replyToken: replyToken,
            messages: [flexMsg as any]
          });
        }
      }

      // 🔎 Trigger: พิมพ์เลขที่ใบเสนอราคาล้วน ๆ (เช่น "QT-260705020") → ตอบปุ่มดาวน์โหลด PDF
      // ใช้กับ LINE PC ที่ liff.sendMessages ใช้ไม่ได้ และใช้ขอ PDF ย้อนหลังได้ทุกเมื่อ
      // gate เฉพาะ status 'active' เพื่อไม่ชน flow แก้ไขใบ (edit_quote_number) ที่ user พิมพ์เลขที่เช่นกัน
      if (
        salesperson.status === 'active' &&
        /^\s*(?:(?:QT|QP)-[0-9]+(?:-R[0-9]+)?[\s,]*)+$/i.test(trimmedContent)
      ) {
        const quotationNos = trimmedContent.toUpperCase().match(/(?:QT|QP)-[0-9]+(?:-R[0-9]+)?/g) || [];
        try {
          const quotes = await getQuotationsByNos(quotationNos);

          if (quotes && quotes.length > 0) {
            const reqUrl = process.env.APP_URL || '';
            const messages: any[] = [];
            for (const q of quotes) {
              const quoteNo = q.quotation_no || '-';
              const pdfLink = `${reqUrl}/download-pdf/${q.id}?openExternalBrowser=1`;
              messages.push({
                type: 'template',
                altText: `ดาวน์โหลดใบเสนอราคา ${quoteNo} (PDF)`,
                template: {
                  type: 'buttons',
                  text: `ดาวน์โหลดใบเสนอราคา ${quoteNo}`,
                  actions: [
                    {
                      type: 'uri',
                      label: '📥 ดาวน์โหลด PDF',
                      uri: pdfLink
                    }
                  ]
                }
              });
            }
            return lineClient.replyMessage({
              replyToken: replyToken,
              messages: messages.slice(0, 5)
            });
          }

          return lineClient.replyMessage({
            replyToken: replyToken,
            messages: [{ type: 'text', text: `❌ ไม่พบใบเสนอราคาเลขที่: ${quotationNos.join(', ')}` }]
          });
        } catch (err) {
          console.error("Error processing quotation-number trigger:", err);
        }
      }

      const cleanText = content.trim().toLowerCase();

      if (['แก้ไข', '/edit', 'edit', 'แก้ไขข้อมูล', 'เมนูแก้ไข'].includes(cleanText)) {
        const flexMsg = createEditMenuFlex();
        return lineClient.replyMessage({
          replyToken: replyToken,
          messages: [flexMsg as any]
        });
      }


      
      // 2. Check if salesperson is editing profile fields
      if (salesperson.status && salesperson.status.startsWith('edit_field:salesperson:')) {
        let val = content.trim();
        const field = salesperson.status.split(':')[2];
        
        if (val.toLowerCase() === 'ยกเลิก' || val === 'cancel') {
          await updateSalespersonByUserId(userId, { status: 'active' });
          return lineClient.replyMessage({
            replyToken: replyToken,
            messages: [{ type: 'text', text: '❌ ยกเลิกการแก้ไขข้อมูลส่วนตัว' }]
          });
        }
        
        const updates: any = {};
        updates[field] = val === '-' ? null : val;
        updates.status = 'active';
        await updateSalespersonByUserId(userId, updates);
        
        const updatedSp = await getSalespersonByUserId(userId);
        const branches = getStaticBranches();
        const flexMsg = createSalespersonProfileFlex(updatedSp, branches || []);
        
        return lineClient.replyMessage({
          replyToken: replyToken,
          messages: [
            { type: 'text', text: '✅ อัปเดตข้อมูลส่วนตัวสำเร็จเรียบร้อยครับ!' },
            flexMsg as any
          ]
        });
      }

      if (salesperson.status === 'edit_quote_number') {
        let val = content.trim().toUpperCase();
        
        if (val === 'ยกเลิก' || val === 'CANCEL') {
          await updateSalespersonByUserId(userId, { status: 'active' });
          return lineClient.replyMessage({
            replyToken: replyToken,
            messages: [{ type: 'text', text: '❌ ยกเลิกการแก้ไขใบเสนอราคา' }]
          });
        }
        
        let baseQuoteNo = val;
        const match = val.match(/^((?:QP|QT)-\d+)(-\d+)$/i);
        if (match) {
          baseQuoteNo = match[1];
        }

        let quotes: any[] = [];
        try {
          const res = await pool.query(
            "SELECT * FROM quotations WHERE quotation_no = $1 OR quotation_no ILIKE $2",
            [baseQuoteNo, `${baseQuoteNo}-%`]
          );
          const enrichPromises = res.rows.map(q => enrichQuotationData(q));
          quotes = await Promise.all(enrichPromises);
        } catch (quoteError) {
          console.error("Fetch quote error:", quoteError);
          return lineClient.replyMessage({
            replyToken: replyToken,
            messages: [{ type: 'text', text: '❌ เกิดข้อผิดพลาดในการค้นหาข้อมูลใบเสนอราคา' }]
          });
        }
        
        let quote: any = null;
        if (quotes && quotes.length > 0) {
          quotes.sort((a: any, b: any) => {
            const getRev = (qNo: string) => {
              const m = qNo.match(/^((?:QP|QT)-\d+)-(\d+)$/i);
              return m ? parseInt(m[2]) : 0;
            };
            return getRev(b.quotation_no) - getRev(a.quotation_no);
          });
          quote = quotes[0];
        }
        
        if (!quote) {
          return lineClient.replyMessage({
            replyToken: replyToken,
            messages: [{ 
              type: 'text', 
              text: `❌ ไม่พบใบเสนอราคาเลขที่ "${val}" ในระบบ\nกรุณาตรวจสอบเลขที่และพิมพ์ส่งเข้ามาใหม่อีกครั้งครับ หรือพิมพ์ "ยกเลิก" เพื่อยกเลิก` 
            }]
          });
        }
        
        const { appendReviseFrom, createRevisionFlex } = await import('../utils/flexTemplates.js');
        const revisedCustomerName = appendReviseFrom(quote.customer_name, quote.quotation_no);
        
        try {
          await pool.query(
            "UPDATE quotations SET status = 'cancelled' WHERE user_id = $1 AND status = ANY($2)",
            [userId, ['pending_company', 'pending_contact', 'draft']]
          );
        } catch (err) {
          console.error("Error cancelling pending quotations:", err);
        }
          
        let newQuote: any = null;
        try {
          const insertedQuotes = await insertDraftQuotations(userId, revisedCustomerName, quote.items, 'draft', quote.customer_id, quote.contact_id);
          if (insertedQuotes && insertedQuotes.length > 0) {
            newQuote = insertedQuotes[0];
          }
        } catch (insertError) {
          console.error("Insert revised quote error:", insertError);
        }
          
        if (!newQuote) {
          return lineClient.replyMessage({
            replyToken: replyToken,
            messages: [{ type: 'text', text: '❌ ไม่สามารถคัดลอกข้อมูลใบเสนอราคาเพื่อแก้ไขได้' }]
          });
        }
        
        await updateSalespersonByUserId(userId, { status: 'active' });
        
        const flexMsg = createRevisionFlex(quote.quotation_no, newQuote.id);
        return lineClient.replyMessage({
          replyToken: replyToken,
          messages: [flexMsg as any]
        });
      }
    } else {
      content = `[Received ${messageType} message]`;
      botReplyText = `ได้รับข้อความประเภท ${messageType} แล้วครับ`;
    }
    // 4.1 ให้ Gemini/Deepseek ช่วยคิดคำตอบ (ถ้าเป็นข้อความ)
    if (event.message.type === 'text' && content) {
      // ดึงประวัติการคุยย้อนหลังของ userId นี้
      let historyContext = "";
      try {
        const history = await getRecentMessages(userId, 10);
        if (history && history.length > 0) {
          // กรองข้อมูลเฉพาะ 15 นาทีล่าสุดเพื่อไม่ให้ดึงประวัติเก่าที่ค้างมาข้ามวัน/ชั่วโมง
          const now = new Date();
          const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);
          let recentHistory = history.filter((h: any) => new Date(h.created_at) >= fifteenMinutesAgo);
 
          // ตัดประวัติเมื่อพบการกดยกเลิกหรือยืนยันใบเสนอราคาเสร็จสมบูรณ์ไปแล้ว
          const closeIndex = recentHistory.findIndex((h: any) => 
            h.reply_content && (
              h.reply_content.includes("ยกเลิกการออกใบเสนอราคา") ||
              h.reply_content.includes("ยกเลิกการเสนอราคา") ||
              h.reply_content.includes("ยืนยันสำเร็จ") ||
              h.reply_content.includes("ลงทะเบียนสำเร็จ")
            )
          );
          if (closeIndex !== -1) {
            recentHistory = recentHistory.slice(0, closeIndex);
          }
 
          if (recentHistory.length > 0) {
            const chatHistory = [...recentHistory].reverse();
            historyContext = "ประวัติการสนทนาล่าสุดในห้องแชทนี้:\n" +
              chatHistory.map((h: any) => `เซลส์: ${h.content}\nบอท: ${h.reply_content}`).join("\n") + "\n\n";
          }
        }
      } catch (e) {
        console.error("Exception fetching chat history:", e);
      }
      const prompt = `
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
        6. ถ้า intent = "UNCLEAR" ให้สร้าง reply_message ถามเซลส์กลับอย่างสุภาพ เช่น "ผมเป็นผู้ช่วยเซลส์ ไม่แน่ใจว่าต้องการให้ออกใบเสนอราคาใช่หรือไม่ครับ? รบกวนพิมพ์ชื่อลูกค้าและรายการสินค้าให้ผมหน่อยนะครับ"
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
      const response = await openai.chat.completions.create({
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' }
      });
      let aiResult: any;
      try {
        let rawJson = (response.choices[0].message.content || '').replace(/```json/gi, '').replace(/```/g, '').trim();
        aiResult = JSON.parse(rawJson);
      } catch (e) {
        // โมเดลบางครั้งตอบ JSON แล้วมีข้อความเกินต่อท้าย (เช่น {...} + คำอธิบาย หรือ {...}{...})
        // ลองดึงเฉพาะ JSON object ก้อนแรกที่วงเล็บ balance ครบออกมา parse ใหม่
        try {
          const raw = (response.choices[0].message.content || '').replace(/```json/gi, '').replace(/```/g, '').trim();
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
            if (end !== -1) {
              aiResult = JSON.parse(raw.slice(start, end + 1));
            } else {
              throw e;
            }
          } else {
            throw e;
          }
        } catch (e2) {
          console.error("JSON Parse Error:", e2);
          aiResult = { intent: "UNCLEAR", reply_message: "ขออภัยครับ ผมไม่สามารถประมวลผลคำสั่งได้ กรุณาลองใหม่อีกครั้งครับ" };
        }
      }

      if (aiResult.intent === 'REGISTER') {
        const flexMsg = createBranchSelectionFlex('', false, userId);
        return lineClient.replyMessage({
          replyToken: replyToken,
          messages: [
            { type: 'text', text: 'คุณสามารถลงทะเบียนหรือปรับปรุงข้อมูลพนักงานขายได้โดยตรงผ่านลิงก์นี้ครับ' },
            flexMsg as any
          ]
        });
      } else if (aiResult.intent === 'QUOTATION' && aiResult.quotation_data && aiResult.quotation_data.items && aiResult.quotation_data.items.length > 0) {
        // ลบรายการใบเสนอราคาเก่าที่ยังค้างอยู่ทั้งหมดออกถาวร
        await deletePendingQuotations(userId);

        let quoteData = aiResult.quotation_data;
        let isAllValid = true;
        let hasNotFoundIssue = false;
        let itemReports = '';
        let successReport = '';
        const itemsForDb: any[] = [];
        let totalSum = 0;
        let issueCount = 0;
        const productPromises = quoteData.items.map(async (item: any) => {
          const codeRaw = String(item.model || item.product_code || '').trim();
          const result = await findProduct(codeRaw);
          return { item, result };
        });
        const productResults = await Promise.all(productPromises);

        for (let i = 0; i < productResults.length; i++) {
          const { item, result } = productResults[i];
          const requestedQty = Number(item.quantity) || 1;
          if (result.found && result.product) {
            const dbProduct = result.product;
            const hasCustomPrice = (item.price !== undefined && item.price !== null && Number(item.price) > 0);
            let price = hasCustomPrice
               ? Number(item.price)
               : (Number(dbProduct.sales_price) || 0);
            const stock = Number(dbProduct.actual_quantity) || 0;
            
            const isNetDiscount = !!item.discount_is_net || !!quoteData.discount_is_net;

            let disc1 = hasCustomPrice
               ? 0
               : (item.discount_1 !== undefined && item.discount_1 !== null && Number(item.discount_1) > 0)
                  ? Number(item.discount_1)
                  : (Number(quoteData.discount_1) || 0);
            let disc2 = hasCustomPrice
               ? 0
               : (item.discount_1 !== undefined && item.discount_1 !== null && Number(item.discount_1) > 0)
                  ? (Number(item.discount_2) || 0)
                  : (Number(quoteData.discount_2) || 0);

            if (isNetDiscount) {
              price = price * (1 - disc1 / 100) * (1 - disc2 / 100);
              price = Math.round(price * 100) / 100;
              disc1 = 0;
              disc2 = 0;
            }

            const discountedPrice = price * (1 - disc1 / 100) * (1 - disc2 / 100);
            const itemTotal = requestedQty * discountedPrice;
            totalSum += itemTotal;
            let discDesc = '';
            if (disc1 > 0 && disc2 > 0) {
              discDesc = ` (ลด ${disc1}+${disc2}%)`;
            } else if (disc1 > 0) {
              discDesc = ` (ลด ${disc1}%)`;
            }
            successReport += `${i + 1}. [${dbProduct.model}]: ${requestedQty} x ${price.toLocaleString()}${discDesc} = ${itemTotal.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} บาท\n`;
            itemsForDb.push({
              product_id: dbProduct.product_template_id,
              product_code: dbProduct.model,
              model: dbProduct.model,
              name: dbProduct.name,
              brand: dbProduct.brand || '',
              series: dbProduct.series || '',
              quantity: requestedQty,
              price: price,
              discount_1: disc1,
              discount_2: disc2,
              production: dbProduct.production || ''
            });

          } else {
            isAllValid = false;
            hasNotFoundIssue = true;
            itemReports += result.report;
            issueCount++;
          }
        }
        if (!isAllValid) {
          let headerText = '❌ ยังไม่สามารถออกใบเสนอราคาได้\n';
          if (hasNotFoundIssue) {
            headerText += `พบรุ่นที่ไม่ชัดเจน ${issueCount} รายการ \n\nกรุณาพิมพ์ชื่อรุ่นที่ถูกต้องอีกครั้งนะครับ\n\n`;
          } else {
            headerText += `พบปัญหาเรื่องสินค้า ${issueCount} รายการ \n\nรบกวนตรวจสอบอีกครั้งนะครับ\n\n`;
          }
          botReplyText = headerText + itemReports.trim();

          const messages: any[] = [
            { type: 'text', text: botReplyText }
          ];

          const liffProductSearchId = process.env.LIFF_PRODUCT_SEARCH_ID || process.env.LIFF_QUOTE_ID || '';
          if (liffProductSearchId) {
            let firstFailCode = '';
            const failItem = quoteData.items.find((item: any) => item && (item.model || item.product_code));
            if (failItem) {
              firstFailCode = String(failItem.model || failItem.product_code || '').trim();
            }

            let searchLiffUrl = `https://liff.line.me/${liffProductSearchId}?userId=${userId}`;
            if (firstFailCode) {
              searchLiffUrl += `&q=${encodeURIComponent(firstFailCode)}`;
            }

            messages.push({
              type: "flex",
              altText: "ค้นหาสินค้าเพิ่มเติม / เตรียมออกใบเสนอราคา",
              contents: {
                type: "bubble",
                size: "kilo",
                body: {
                  type: "box",
                  layout: "vertical",
                  spacing: "sm",
                  paddingAll: "12px",
                  contents: [
                    {
                      type: "button",
                      action: {
                        type: "uri",
                        label: "🔎 ค้นหาสินค้าเพิ่มเติม",
                        uri: searchLiffUrl
                      },
                      style: "primary",
                      color: "#2563EB",
                      height: "sm"
                    }
                  ]
                }
              }
            });
          }
          customMessages = messages;
        } else { 
          const result = await processQuotationRequest(
            userId,
            quoteData.customer_query,
            quoteData.contact_query,
            itemsForDb,
            salesperson
          );

          if (result.success) {
            const summary = await getQuotationSummaryMessage(result.quotes);
            customMessages = summary.messages;
            botReplyText = summary.summaryText;
          } else {
            if (result.type === 'flex') {
              customMessages = [result];
              botReplyText = result.altText || 'กรุณาเลือกรายการ';
            } else {
              const messages: any[] = [{ type: 'text', text: result.text }];
              if (result.quickReply) {
                messages[0].quickReply = result.quickReply;
              }
              customMessages = messages;
              botReplyText = result.text;
            }
          }
        }
      } else if (aiResult.intent === 'PRODUCT_INFO' && aiResult.product_query && 
                 ((aiResult.product_query.models && aiResult.product_query.models.length > 0) || 
                  (aiResult.product_query.product_codes && aiResult.product_query.product_codes.length > 0))) {
        const queryModels = aiResult.product_query.models || aiResult.product_query.product_codes || [];
        let infoReport = "";
        const infoPromises = queryModels.map(async (codeRaw: any) => {
          const result = await findProduct(codeRaw);
          return { codeRaw, result };
        });
        const infoResults = await Promise.all(infoPromises);

        for (const { codeRaw, result } of infoResults) {
          if (result.found && result.product) {
            const dbProduct = result.product;
            const price = Number(dbProduct.sales_price) || 0;
            const stock = Number(dbProduct.actual_quantity) || 0;
            infoReport += `ข้อมูลสินค้า [${dbProduct.model}]:\n`;
            infoReport += `📂 หมวดหมู่: ${dbProduct.product_category}\n`;
            infoReport += `💵 ราคา: ${price.toLocaleString()} บาท\n`;
            infoReport += `📦 สต๊อกพร้อมส่ง: ${stock} ชิ้น\n`;
            infoReport += `-------------------------\n`;
          } else {
            infoReport += `🔍 ค้นหารุ่น "${codeRaw}":\n${result.report}`;
          }
        }
        botReplyText = infoReport.trim();

        const messages: any[] = [
          { type: 'text', text: botReplyText }
        ];

        const liffProductSearchId = process.env.LIFF_PRODUCT_SEARCH_ID || process.env.LIFF_QUOTE_ID || '';
        if (liffProductSearchId) {
          const firstCode = queryModels[0] || '';
          let searchLiffUrl = `https://liff.line.me/${liffProductSearchId}?userId=${userId}`;
          if (firstCode) {
            searchLiffUrl += `&q=${encodeURIComponent(firstCode)}`;
          }

          messages.push({
            type: "flex",
            altText: "ค้นหาสินค้าเพิ่มเติม / เตรียมออกใบเสนอราคา",
            contents: {
              type: "bubble",
              size: "kilo",
              body: {
                type: "box",
                layout: "vertical",
                spacing: "sm",
                paddingAll: "12px",
                contents: [
                  {
                    type: "button",
                    action: {
                      type: "uri",
                      label: "🔎 ค้นหาสินค้าเพิ่มเติม",
                      uri: searchLiffUrl
                    },
                    style: "primary",
                    color: "#2563EB",
                    height: "sm"
                  }
                ]
              }
            }
          });
        }
        customMessages = messages;
      } else {
        // UNCLEAR or other intent
        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        let pendingQuotes: any[] = [];
        try {
          const selectRes = await pool.query(
            "SELECT * FROM quotations WHERE user_id = $1 AND status = ANY($2) AND created_at >= $3 ORDER BY created_at DESC",
            [userId, ['pending_company', 'pending_contact'], tenMinutesAgo]
          );
          const enrichPromises = selectRes.rows.map(q => enrichQuotationData(q));
          pendingQuotes = await Promise.all(enrichPromises);
        } catch (err) {
          console.error("Error fetching pending quotes in UNCLEAR:", err);
        }

        if (pendingQuotes && pendingQuotes.length > 0) {
          const latestStatus = pendingQuotes[0].status;

          if (['ยกเลิก', 'cancel', 'ยกเลิกการออกใบเสนอราคา'].includes(content.trim().toLowerCase())) {
            try {
              await pool.query(
                "DELETE FROM quotations WHERE id = ANY($1)",
                [pendingQuotes.map((q: any) => q.id)]
              );
            } catch (err) {
              console.error("Error deleting quotations in UNCLEAR cancel:", err);
            }

            botReplyText = '❌ ยกเลิกการออกใบเสนอราคาเรียบร้อยแล้ว';
          } else {
            const quoteIdsStr = pendingQuotes.map((q: any) => q.id).join(',');
            const typedVal = content.trim();

            if (latestStatus === 'pending_company') {
              const parts = pendingQuotes[0].customer_name.split('|');
              let contactQuery = parts[1] ? parts[1].trim() : '';
              let companyQuery = typedVal;

              // Backstop: user พิมพ์แก้มาแบบ "บ.X คุณY" บรรทัดเดียว → แยกส่วนผู้ติดต่อออก
              if (companyQuery && !contactQuery) {
                const split = splitCustomerContact(companyQuery);
                if (split.contact) {
                  companyQuery = split.customer;
                  contactQuery = split.contact;
                }
              }

              const customerCandidates = await findCustomerCandidates(companyQuery, salesperson, contactQuery);

              if (customerCandidates.length === 0) {
                const rawName = `${companyQuery} | ${contactQuery}`;
                const customerDetailsTemp = {
                  customer_name: rawName,
                  customer_code: '',
                  customer_tax_id: '',
                  contact_name: contactQuery || '-',
                  phone: '-',
                  email: '-',
                  address: '-',
                  payment_terms: '-',
                  revise_from: null,
                  custom_meta: ''
                };
                
                try {
                  await pool.query(
                    "UPDATE quotations SET customer_details = $1, updated_at = NOW() WHERE id = ANY($2)",
                    [JSON.stringify(customerDetailsTemp), pendingQuotes.map((q: any) => q.id)]
                  );
                } catch (err) {
                  console.error("Error updating customer details in pending_company fallback:", err);
                }

                botReplyText = `❌ ไม่พบชื่อบริษัท "${companyQuery}" ในระบบเลยครับ รบกวนพิมพ์ชื่อบริษัทที่ถูกต้องใหม่อีกครั้ง หรือเลือกบริษัทด้วยตนเองผ่านปุ่มในข้อความ Flex ก่อนหน้า หรือติดต่อแอดมินเพื่อเพิ่มข้อมูลลูกค้าครับ 🏢`;
              } else if (customerCandidates.length > 1) {
                const rawName = `${companyQuery} | ${contactQuery}`;
                const customerDetailsTemp = {
                  customer_name: rawName,
                  customer_code: '',
                  customer_tax_id: '',
                  contact_name: contactQuery || '-',
                  phone: '-',
                  email: '-',
                  address: '-',
                  payment_terms: '-',
                  revise_from: null,
                  custom_meta: ''
                };
                
                try {
                  await pool.query(
                    "UPDATE quotations SET customer_details = $1, updated_at = NOW() WHERE id = ANY($2)",
                    [JSON.stringify(customerDetailsTemp), pendingQuotes.map((q: any) => q.id)]
                  );
                } catch (err) {
                  console.error("Error updating customer details in pending_company multi-candidate:", err);
                }

                const options = customerCandidates.slice(0, 12).map((c: any) => ({
                  label: formatLineLabel(c.item.display_name),
                  data: `action=select_company&custId=${c.item.id}`,
                  displayText: `เลือก ${c.item.display_name}`
                }));

                const flexMessage = createListFlexMessage(
                  "🏢 เลือกบริษัทที่ถูกต้อง",
                  `พบชื่อบริษัทใกล้เคียงกับ "${companyQuery}" หลายบริษัทเลยครับ กรุณาเลือกบริษัทที่ถูกต้องด้านล่างนี้ครับ 👇`,
                  options
                );

                customMessages = [flexMessage];
                botReplyText = `พบชื่อบริษัทใกล้เคียงกับ "${companyQuery}" หลายบริษัทเลยครับ กรุณาเลือกบริษัทที่ถูกต้องด้านล่างนี้ครับ 👇`;
              } else {
                const selectedCompany = customerCandidates[0].item.display_name;
                const selectedCustomerId = customerCandidates[0].item.id;

                const result = await resolveContactFlow(
                  userId,
                  quoteIdsStr,
                  selectedCustomerId,
                  selectedCompany,
                  contactQuery,
                  null,
                  salesperson
                );

                if (result.success) {
                  const summary = await getQuotationSummaryMessage(result.quotes);
                  customMessages = summary.messages;
                  botReplyText = summary.summaryText;
                } else {
                  if (result.type === 'flex') {
                    customMessages = [result];
                    botReplyText = result.altText || 'กรุณาเลือกรายการ';
                  } else {
                    const messages: any[] = [{ type: 'text', text: result.text }];
                    if (result.quickReply) {
                      messages[0].quickReply = result.quickReply;
                    }
                    customMessages = messages;
                    botReplyText = result.text;
                  }
                }
              }
            } else if (latestStatus === 'pending_contact') {
              const parts = pendingQuotes[0].customer_name.split('|');
              const companyName = parts[0] ? parts[0].trim() : '';
              const contactQuery = typedVal;

              let customer: any = null;
              try {
                const compRes = await pool.query(
                  "SELECT id FROM customers_view WHERE display_name = $1 LIMIT 1",
                  [companyName]
                );
                if (compRes.rows.length > 0) {
                  customer = compRes.rows[0];
                }
              } catch (err) {
                console.error("Error fetching customer in pending_contact:", err);
              }

              if (!customer) {
                botReplyText = `❌ เกิดข้อผิดพลาดในการโหลดข้อมูลบริษัท "${companyName}"`;
              } else {
                const result = await resolveContactFlow(
                  userId,
                  quoteIdsStr,
                  customer.id,
                  companyName,
                  contactQuery,
                  null,
                  salesperson
                );

                if (result.success) {
                  const summary = await getQuotationSummaryMessage(result.quotes);
                  customMessages = summary.messages;
                  botReplyText = summary.summaryText;
                } else {
                  if (result.type === 'flex') {
                    customMessages = [result];
                    botReplyText = result.altText || 'กรุณาเลือกรายการ';
                  } else {
                    const messages: any[] = [{ type: 'text', text: result.text }];
                    if (result.quickReply) {
                      messages[0].quickReply = result.quickReply;
                    }
                    customMessages = messages;
                    botReplyText = result.text;
                  }
                }
              }
            }
          }
        } else {
          botReplyText = aiResult.reply_message || "ผมเป็นบอทผู้ช่วยเซลส์ ไม่แน่ใจว่าต้องการให้ออกใบเสนอราคาใช่หรือไม่ครับ? รบกวนพิมพ์ชื่อลูกค้าและรายการสินค้าให้ผมหน่อยนะครับ";
        }
      }
    }
    // 4.2 บันทึกประวัติการแชทลงฐานข้อมูล postgresdb
    await insertMessage({
      user_id: userId,
      message_id: messageId,
      type: messageType,
      content: content,
      reply_token: replyToken,
      reply_content: botReplyText
    });
    // 4.3 ส่งข้อความกลับไปหาผู้ใช้ทาง LINE
    if (customMessages) {
      return await lineClient.replyMessage({
        replyToken: replyToken,
        messages: customMessages,
      });
    }
    return await lineClient.replyMessage({
      replyToken: replyToken,
      messages: [{ type: 'text', text: botReplyText }],
    });
  } catch (error: any) {
    console.error('เกิดข้อผิดพลาดในการประมวลผลระบบ:', error);
    if (event && event.replyToken) {
      try {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text' as const,
            text: '⚠️ ขออภัย ระบบขัดข้องชั่วคราว\nกรุณาพิมพ์คำสั่งใหม่อีกครั้ง 🙏'
          }]
        });
      } catch (replyErr: any) {
        console.error('ไม่สามารถส่งข้อความแจ้งข้อผิดพลาดกลับไปยังผู้ใช้ได้:', replyErr.message || replyErr);
      }
    }
  }
}
