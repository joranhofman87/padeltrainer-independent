import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface LineItem {
  description: string;
  quantity: number;
  unit_price: number;
  date?: string;
  vat_rate?: number;
}

interface InvoiceData {
  id: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string;
  player_name: string;
  player_business_name: string | null;
  player_address: string | null;
  player_btw_number: string | null;
  line_items: LineItem[];
  subtotal: number;
  vat_rate: number;
  vat_amount: number;
  total: number;
  notes: string | null;
  vat_breakdown?: Record<string, { subtotal: number; vat: number }> | null;
  logo_url: string | null;
  banner_color: string | null;
  payment_url: string | null;
  trainer: {
    business_name: string;
    business_address: string;
    kvk_number: string;
    btw_number: string | null;
    iban: string;
    bic: string | null;
    payment_terms_days: number;
  };
}

function generateInvoiceHTML(invoice: InvoiceData): string {
  const accentColor = invoice.banner_color || '#16a34a';
  
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(amount);
  };

  const lineItemsHTML = invoice.line_items.map(item => `
    <tr>
      <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">
        ${item.description}
        ${item.date ? `<br><span style="font-size: 12px; color: #6b7280;">${formatDate(item.date)}</span>` : ''}
      </td>
      <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: center;">${item.quantity}</td>
      <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right;">${formatCurrency(item.unit_price)}</td>
      <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right;">${formatCurrency(item.quantity * item.unit_price)}</td>
    </tr>
  `).join('');

  return `
<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Factuur ${invoice.invoice_number}</title>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #1f2937; margin: 0; padding: 0; }
    .branded-header { background: ${accentColor}; padding: 14px 40px; text-align: center; }
    .branded-header img { max-height: 36px; max-width: 200px; object-fit: contain; }
    .branded-header h2 { color: white; font-size: 18px; font-weight: bold; margin: 0; }
    .invoice-container { max-width: 800px; margin: 0 auto; padding: 30px 40px; }
    .header { display: flex; justify-content: space-between; margin-bottom: 24px; }
    .invoice-title { font-size: 32px; font-weight: bold; color: ${accentColor}; margin: 0; }
    .invoice-meta { text-align: right; }
    .invoice-meta p { margin: 4px 0; }
    .parties { display: flex; justify-content: space-between; margin-bottom: 24px; }
    .party { width: 45%; }
    .party-label { font-size: 12px; color: #6b7280; text-transform: uppercase; margin-bottom: 8px; }
    .party-name { font-weight: bold; font-size: 16px; }
    .party-details { font-size: 14px; color: #4b5563; white-space: pre-line; }
    .items-table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    .items-table th { background: ${accentColor}15; padding: 12px; text-align: left; font-size: 12px; text-transform: uppercase; color: #4b5563; border-bottom: 2px solid ${accentColor}40; }
    .items-table th:nth-child(2), .items-table th:nth-child(3), .items-table th:nth-child(4) { text-align: right; }
    .items-table th:nth-child(2) { text-align: center; }
    .totals { margin-left: auto; width: 300px; }
    .totals-row { display: flex; justify-content: space-between; padding: 8px 0; }
    .totals-row.total { font-weight: bold; font-size: 18px; border-top: 2px solid ${accentColor}; padding-top: 12px; margin-top: 8px; color: ${accentColor}; }
    .payment-info { background: #f9fafb; padding: 14px; border-radius: 8px; margin-top: 20px; border-left: 4px solid ${accentColor}; }
    .payment-title { font-weight: bold; margin-bottom: 12px; }
    .payment-row { display: flex; gap: 24px; font-size: 14px; }
    .payment-label { color: #6b7280; width: 120px; }
    .notes { margin-top: 24px; padding: 16px; background: #fef3c7; border-radius: 8px; font-size: 14px; }
    @media print {
      body { padding: 0; }
      .branded-header { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
      .items-table th, .totals-row.total, .payment-info { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
      .invoice-container { max-width: 100%; }
    }
  </style>
</head>
<body>
  <div class="branded-header">
    ${invoice.logo_url ? `<img src="${invoice.logo_url}" alt="Logo" />` : `<h2>${invoice.trainer.business_name}</h2>`}
  </div>
  <div class="invoice-container">
    <div class="header">
      <h1 class="invoice-title">FACTUUR</h1>
      <div class="invoice-meta">
        <p><strong>Factuurnummer:</strong> ${invoice.invoice_number}</p>
        <p><strong>Factuurdatum:</strong> ${formatDate(invoice.invoice_date)}</p>
        <p><strong>Vervaldatum:</strong> ${formatDate(invoice.due_date)}</p>
      </div>
    </div>

    <div class="parties">
      <div class="party">
        <div class="party-label">Van</div>
        <div class="party-name">${invoice.trainer.business_name}</div>
        <div class="party-details">${invoice.trainer.business_address}</div>
        <div class="party-details" style="margin-top: 8px;">
          KvK: ${invoice.trainer.kvk_number}
          ${invoice.trainer.btw_number ? `<br>BTW: ${invoice.trainer.btw_number}` : ''}
        </div>
      </div>
      <div class="party">
        <div class="party-label">Aan</div>
        ${invoice.player_business_name ? `<div class="party-name">${invoice.player_business_name}</div>` : ''}
        <div class="${invoice.player_business_name ? 'party-details' : 'party-name'}">${invoice.player_name}</div>
        ${invoice.player_address ? `<div class="party-details">${invoice.player_address}</div>` : ''}
        ${invoice.player_btw_number ? `<div class="party-details" style="margin-top: 8px;">BTW: ${invoice.player_btw_number}</div>` : ''}
      </div>
    </div>

    <table class="items-table">
      <thead>
        <tr>
          <th>Omschrijving</th>
          <th style="text-align: center;">Aantal</th>
          <th style="text-align: right;">Prijs</th>
          <th style="text-align: right;">Bedrag</th>
        </tr>
      </thead>
      <tbody>
        ${lineItemsHTML}
      </tbody>
    </table>

    <div class="totals">
      <div class="totals-row">
        <span>Subtotaal</span>
        <span>${formatCurrency(invoice.subtotal)}</span>
      </div>
      ${(() => {
        const nonZeroEntries = invoice.vat_breakdown 
          ? Object.entries(invoice.vat_breakdown).filter(([_, data]) => (data as any).vat !== 0)
          : [];
        if (nonZeroEntries.length > 1) {
          return nonZeroEntries
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([rate, data]) => `
              <div class="totals-row">
                <span>BTW ${rate}%</span>
                <span>${formatCurrency((data as any).vat)}</span>
              </div>
            `).join('');
        } else {
          return `<div class="totals-row">
            <span>BTW ${invoice.vat_rate}%</span>
            <span>${formatCurrency(invoice.vat_amount)}</span>
          </div>`;
        }
      })()}
      <div class="totals-row total">
        <span>Totaal</span>
        <span>${formatCurrency(invoice.total)}</span>
      </div>
    </div>

    ${invoice.payment_url ? `
    <div class="payment-info">
      <div class="payment-title">Betaal online</div>
      <div style="display: flex; align-items: center; gap: 24px;">
        <img src="https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(invoice.payment_url)}&size=100x100&color=${(invoice.banner_color || '#16a34a').replace('#', '')}" 
             alt="QR code" width="80" height="80" style="border-radius: 6px;" />
        <div>
          <p style="margin: 0 0 4px 0; font-size: 13px;">Scan de QR code of klik op de link om online te betalen:</p>
          <a href="${invoice.payment_url}" style="color: ${accentColor}; font-weight: bold; word-break: break-all; font-size: 13px;">${invoice.payment_url}</a>
          <p style="margin-top: 6px; font-size: 12px; color: #6b7280;">
            Referentie: ${invoice.invoice_number} · Vervaldatum: ${formatDate(invoice.due_date)}
          </p>
        </div>
      </div>
    </div>
    ` : `
    <div class="payment-info">
      <div class="payment-title">Betalingsgegevens</div>
      <div class="payment-row">
        <span class="payment-label">IBAN:</span>
        <span>${invoice.trainer.iban}</span>
      </div>
      ${invoice.trainer.bic ? `
      <div class="payment-row">
        <span class="payment-label">BIC:</span>
        <span>${invoice.trainer.bic}</span>
      </div>
      ` : ''}
      <div class="payment-row">
        <span class="payment-label">Referentie:</span>
        <span>${invoice.invoice_number}</span>
      </div>
      <div class="payment-row">
        <span class="payment-label">Vervaldatum:</span>
        <span>${formatDate(invoice.due_date)}</span>
      </div>
    </div>
    `}

    ${invoice.notes ? `<div class="notes">${invoice.notes}</div>` : ''}
  </div>
</body>
</html>
  `;
}

async function generateInvoicePDF(invoice: InvoiceData): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const page = pdfDoc.addPage([595.28, 841.89]); // A4
  const { width, height } = page.getSize();
  const margin = 50;
  let y = height;

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(amount);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
  };

  // Parse accent color to RGB (0-1 range)
  const hexToRgb = (hex: string) => {
    const h = hex.replace('#', '');
    return rgb(
      parseInt(h.substring(0, 2), 16) / 255,
      parseInt(h.substring(2, 4), 16) / 255,
      parseInt(h.substring(4, 6), 16) / 255,
    );
  };
  const accentColor = hexToRgb(invoice.banner_color || '#16a34a');

  // Helper to draw text and return the y position
  const drawText = (text: string, x: number, yPos: number, options: { font?: any; size?: number; color?: any; maxWidth?: number } = {}) => {
    const f = options.font || font;
    const size = options.size || 10;
    const color = options.color || rgb(0.12, 0.16, 0.22);

    // Simple word wrapping
    if (options.maxWidth) {
      const words = text.split(' ');
      let line = '';
      let currentY = yPos;
      for (const word of words) {
        const testLine = line ? `${line} ${word}` : word;
        const testWidth = f.widthOfTextAtSize(testLine, size);
        if (testWidth > options.maxWidth && line) {
          page.drawText(line, { x, y: currentY, font: f, size, color });
          currentY -= size + 4;
          line = word;
        } else {
          line = testLine;
        }
      }
      if (line) {
        page.drawText(line, { x, y: currentY, font: f, size, color });
        currentY -= size + 4;
      }
      return currentY;
    }

    page.drawText(text, { x, y: yPos, font: f, size, color });
    return yPos - size - 4;
  };

  // ── Header bar ──
  page.drawRectangle({ x: 0, y: height - 50, width, height: 50, color: accentColor });
  page.drawText(invoice.trainer.business_name, {
    x: margin, y: height - 34, font: fontBold, size: 16, color: rgb(1, 1, 1),
  });
  y = height - 70;

  // ── FACTUUR title + meta ──
  page.drawText('FACTUUR', { x: margin, y, font: fontBold, size: 24, color: accentColor });

  const metaX = width - margin - 180;
  drawText(`Factuurnummer: ${invoice.invoice_number}`, metaX, y, { font: fontBold, size: 9 });
  drawText(`Factuurdatum: ${formatDate(invoice.invoice_date)}`, metaX, y - 14, { size: 9 });
  drawText(`Vervaldatum: ${formatDate(invoice.due_date)}`, metaX, y - 28, { size: 9 });
  y -= 55;

  // ── Parties ──
  const colLeft = margin;
  const colRight = width / 2 + 20;
  let yLeft = y;
  let yRight = y;

  // From
  yLeft = drawText('VAN', colLeft, yLeft, { font: fontBold, size: 8, color: rgb(0.42, 0.45, 0.5) });
  yLeft = drawText(invoice.trainer.business_name, colLeft, yLeft, { font: fontBold, size: 11 });
  if (invoice.trainer.business_address) {
    yLeft = drawText(invoice.trainer.business_address, colLeft, yLeft, { size: 9, maxWidth: 220 });
  }
  yLeft -= 4;
  yLeft = drawText(`KvK: ${invoice.trainer.kvk_number}`, colLeft, yLeft, { size: 9 });
  if (invoice.trainer.btw_number) {
    yLeft = drawText(`BTW: ${invoice.trainer.btw_number}`, colLeft, yLeft, { size: 9 });
  }

  // To
  yRight = drawText('AAN', colRight, yRight, { font: fontBold, size: 8, color: rgb(0.42, 0.45, 0.5) });
  if (invoice.player_business_name) {
    yRight = drawText(invoice.player_business_name, colRight, yRight, { font: fontBold, size: 11 });
    yRight = drawText(invoice.player_name, colRight, yRight, { size: 9 });
  } else {
    yRight = drawText(invoice.player_name, colRight, yRight, { font: fontBold, size: 11 });
  }
  if (invoice.player_address) {
    yRight = drawText(invoice.player_address, colRight, yRight, { size: 9, maxWidth: 220 });
  }
  if (invoice.player_btw_number) {
    yRight -= 4;
    yRight = drawText(`BTW: ${invoice.player_btw_number}`, colRight, yRight, { size: 9 });
  }

  y = Math.min(yLeft, yRight) - 20;

  // ── Line items table ──
  const colWidths = [250, 50, 90, 90]; // description, qty, price, amount
  const tableX = margin;
  const tableWidth = colWidths.reduce((a, b) => a + b, 0);

  // Table header
  page.drawRectangle({ x: tableX, y: y - 4, width: tableWidth, height: 20, color: rgb(0.96, 0.97, 0.98) });
  const headerY = y;
  const headers = ['Omschrijving', 'Aantal', 'Prijs', 'Bedrag'];
  let hx = tableX + 6;
  for (let i = 0; i < headers.length; i++) {
    const align = i === 0 ? hx : hx + colWidths[i] - font.widthOfTextAtSize(headers[i], 8) - 6;
    page.drawText(headers[i], { x: i === 0 ? hx : align, y: headerY, font: fontBold, size: 8, color: rgb(0.3, 0.35, 0.4) });
    hx += colWidths[i];
  }
  y -= 20;

  // Table rows
  for (const item of invoice.line_items) {
    const rowHeight = 18;
    y -= rowHeight;

    if (y < 80) {
      // Add new page if running out of space
      const newPage = pdfDoc.addPage([595.28, 841.89]);
      // For simplicity we stop here — most invoices fit on one page
      break;
    }

    // Draw separator
    page.drawLine({ start: { x: tableX, y: y + rowHeight - 2 }, end: { x: tableX + tableWidth, y: y + rowHeight - 2 }, thickness: 0.5, color: rgb(0.9, 0.91, 0.93) });

    let cx = tableX + 6;
    // Description (truncate if too long)
    let desc = item.description;
    const maxDescWidth = colWidths[0] - 12;
    while (font.widthOfTextAtSize(desc, 9) > maxDescWidth && desc.length > 3) {
      desc = desc.slice(0, -1);
    }
    page.drawText(desc, { x: cx, y: y + 4, font, size: 9 });
    cx += colWidths[0];

    // Quantity (center)
    const qtyText = `${item.quantity}`;
    const qtyWidth = font.widthOfTextAtSize(qtyText, 9);
    page.drawText(qtyText, { x: cx + (colWidths[1] - qtyWidth) / 2, y: y + 4, font, size: 9 });
    cx += colWidths[1];

    // Price (right)
    const priceText = formatCurrency(item.unit_price);
    page.drawText(priceText, { x: cx + colWidths[2] - font.widthOfTextAtSize(priceText, 9) - 6, y: y + 4, font, size: 9 });
    cx += colWidths[2];

    // Amount (right)
    const amountText = formatCurrency(item.quantity * item.unit_price);
    page.drawText(amountText, { x: cx + colWidths[3] - font.widthOfTextAtSize(amountText, 9) - 6, y: y + 4, font, size: 9 });
  }

  y -= 12;

  // ── Totals ──
  const totalsX = tableX + colWidths[0] + colWidths[1];
  const totalsWidth = colWidths[2] + colWidths[3];

  const drawTotalRow = (label: string, value: string, bold = false, accent = false) => {
    const f = bold ? fontBold : font;
    const size = bold ? 12 : 10;
    const color = accent ? accentColor : rgb(0.12, 0.16, 0.22);
    if (bold) {
      page.drawLine({ start: { x: totalsX, y: y + 14 }, end: { x: totalsX + totalsWidth, y: y + 14 }, thickness: 1.5, color: accentColor });
    }
    page.drawText(label, { x: totalsX + 6, y, font: f, size, color });
    const valW = f.widthOfTextAtSize(value, size);
    page.drawText(value, { x: totalsX + totalsWidth - valW - 6, y, font: f, size, color });
    y -= size + 8;
  };

  drawTotalRow('Subtotaal', formatCurrency(invoice.subtotal));

  // VAT rows
  const nonZeroEntries = invoice.vat_breakdown
    ? Object.entries(invoice.vat_breakdown).filter(([_, data]) => (data as any).vat !== 0)
    : [];
  if (nonZeroEntries.length > 1) {
    for (const [rate, data] of nonZeroEntries.sort(([a], [b]) => Number(a) - Number(b))) {
      drawTotalRow(`BTW ${rate}%`, formatCurrency((data as any).vat));
    }
  } else {
    drawTotalRow(`BTW ${invoice.vat_rate}%`, formatCurrency(invoice.vat_amount));
  }

  y -= 4;
  drawTotalRow('Totaal', formatCurrency(invoice.total), true, true);

  y -= 8;

  // ── Payment info ──
  if (y > 60) {
    page.drawRectangle({ x: margin, y: y - 50, width: tableWidth, height: 60, color: rgb(0.97, 0.97, 0.98) });
    page.drawRectangle({ x: margin, y: y - 50, width: 3, height: 60, color: accentColor });

    const payY = y;
    page.drawText('Betalingsgegevens', { x: margin + 12, y: payY, font: fontBold, size: 10 });

    if (invoice.payment_url) {
      drawText(`Betaallink: ${invoice.payment_url}`, margin + 12, payY - 16, { size: 8, maxWidth: tableWidth - 24 });
    } else {
      drawText(`IBAN: ${invoice.trainer.iban}`, margin + 12, payY - 16, { size: 9 });
      if (invoice.trainer.bic) {
        drawText(`BIC: ${invoice.trainer.bic}`, margin + 12, payY - 30, { size: 9 });
      }
    }
    drawText(`Referentie: ${invoice.invoice_number}`, margin + 12, payY - (invoice.trainer.bic ? 44 : 30), { size: 9 });
    y -= 70;
  }

  // ── Notes ──
  if (invoice.notes && y > 40) {
    y -= 6;
    drawText('Opmerking:', margin, y, { font: fontBold, size: 9 });
    drawText(invoice.notes, margin, y - 14, { size: 9, maxWidth: tableWidth });
  }

  return await pdfDoc.save();
}

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Authentication required" }),
        { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const token = authHeader.replace("Bearer ", "");
    
    // Allow service-role calls (from auto-create-invoice) to skip user auth check
    const isServiceRole = token === supabaseServiceKey;
    let user: any = null;

    if (!isServiceRole) {
      const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !authUser) {
        return new Response(
          JSON.stringify({ error: "Unauthorized" }),
          { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
      user = authUser;
    }

    const { invoiceId } = await req.json();
    if (!invoiceId) {
      return new Response(
        JSON.stringify({ error: "Missing invoiceId" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Fetch invoice
    const { data: invoice, error: invoiceError } = await supabase
      .from('invoices')
      .select('*')
      .eq('id', invoiceId)
      .single();

    if (invoiceError || !invoice) {
      return new Response(
        JSON.stringify({ error: "Invoice not found" }),
        { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Fetch trainer business info (only if trainer_id exists)
    let trainerProfile: any = null;
    if (invoice.trainer_id) {
      const { data: tp, error: trainerError } = await supabase
        .from('trainer_profiles')
        .select('business_name, business_address, kvk_number, btw_number, iban, bic, payment_terms_days, user_id, invoice_logo_url')
        .eq('id', invoice.trainer_id)
        .single();

      if (trainerError || !tp) {
        return new Response(
          JSON.stringify({ error: "Trainer profile not found" }),
          { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
      trainerProfile = tp;
    }

    // Fetch academy profile if invoice belongs to an academy
    let academyProfile: any = null;
    if (invoice.academy_profile_id) {
      const { data: ap } = await supabase
        .from('academy_profiles')
        .select('name, slug, business_name, business_address, kvk_number, btw_number, iban, bic, invoice_logo_url, invoice_banner_color, payment_terms_days')
        .eq('id', invoice.academy_profile_id)
        .single();
      academyProfile = ap;
    }

    // Allow the trainer, the player, AND academy managers to access the invoice
    const isTrainer = trainerProfile?.user_id === user.id;
    let isPlayer = invoice.player_id === user.id;
    let isAcademyManager = false;

    // player_id may reference profiles.id rather than auth user id, so check via profiles table
    if (!isPlayer && invoice.player_id) {
      const { data: playerProfile } = await supabase
        .from('profiles')
        .select('user_id')
        .eq('id', invoice.player_id)
        .single();
      if (playerProfile?.user_id === user.id) {
        isPlayer = true;
      }
    }

    // Check if user is an academy manager for this invoice's academy
    if (!isTrainer && !isPlayer && invoice.academy_profile_id) {
      const { data: managerCheck } = await supabase
        .from('academy_managers')
        .select('id')
        .eq('academy_profile_id', invoice.academy_profile_id)
        .eq('user_id', user.id)
        .maybeSingle();
      if (managerCheck) {
        isAcademyManager = true;
      }
    }

    if (!isTrainer && !isPlayer && !isAcademyManager) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Use academy details when available, fall back to trainer profile
    const businessSource = academyProfile || trainerProfile;
    const businessName = academyProfile
      ? (academyProfile.business_name || academyProfile.name || '')
      : (trainerProfile?.business_name || '');

    // Check for active Mollie connection to determine payment method
    let hasMollie = false;
    if (invoice.academy_profile_id) {
      const { data: mollieAccount } = await supabase
        .from('academy_mollie_accounts')
        .select('charges_enabled, onboarding_complete')
        .eq('academy_profile_id', invoice.academy_profile_id)
        .maybeSingle();
      hasMollie = !!(mollieAccount?.charges_enabled && mollieAccount?.onboarding_complete);
    } else if (invoice.trainer_id) {
      const { data: mollieAccount } = await supabase
        .from('trainer_mollie_accounts')
        .select('charges_enabled, onboarding_complete')
        .eq('trainer_id', invoice.trainer_id)
        .maybeSingle();
      hasMollie = !!(mollieAccount?.charges_enabled && mollieAccount?.onboarding_complete);
    }

    // Build payment URL if Mollie is connected and invoice has a public token
    let paymentUrl: string | null = null;
    if (hasMollie && invoice.public_token) {
      if (academyProfile?.slug) {
        paymentUrl = `https://padeltrainer.ai/nl/academies/${academyProfile.slug}/pay/${invoice.public_token}`;
      } else {
        paymentUrl = `https://padeltrainer.ai/nl/pay/${invoice.public_token}`;
      }
    }

    // Generate HTML invoice
    const invoiceData: InvoiceData = {
      id: invoice.id,
      invoice_number: invoice.invoice_number,
      invoice_date: invoice.invoice_date,
      due_date: invoice.due_date,
      player_name: invoice.player_name,
      player_business_name: invoice.player_business_name || null,
      player_address: invoice.player_address,
      player_btw_number: invoice.player_btw_number,
      line_items: invoice.line_items as LineItem[],
      subtotal: invoice.subtotal,
      vat_rate: invoice.vat_rate,
      vat_amount: invoice.vat_amount,
      total: invoice.total,
      notes: invoice.notes,
      vat_breakdown: invoice.vat_breakdown || null,
      logo_url: businessSource.invoice_logo_url || null,
      banner_color: (academyProfile?.invoice_banner_color) || null,
      payment_url: paymentUrl,
      trainer: {
        business_name: businessName,
        business_address: businessSource.business_address || '',
        kvk_number: businessSource.kvk_number || '',
        btw_number: businessSource.btw_number,
        iban: businessSource.iban || '',
        bic: businessSource.bic,
        payment_terms_days: businessSource.payment_terms_days || 14,
      },
    };

    const htmlContent = generateInvoiceHTML(invoiceData);
    
    // Generate PDF version
    const pdfBytes = await generateInvoicePDF(invoiceData);
    
    // Store under trainer's user_id or academy_profile_id folder
    const folderKey = trainerProfile?.user_id || invoice.academy_profile_id || 'custom';
    const fileName = `${folderKey}/${invoice.invoice_number}.html`;
    const pdfFileName = `${folderKey}/${invoice.invoice_number}.pdf`;

    // Upload HTML and PDF in parallel
    const [htmlUpload, pdfUpload] = await Promise.all([
      supabase.storage
        .from('invoices')
        .upload(fileName, new Blob([htmlContent], { type: 'text/html' }), {
          upsert: true,
          contentType: 'text/html',
        }),
      supabase.storage
        .from('invoices')
        .upload(pdfFileName, pdfBytes, {
          upsert: true,
          contentType: 'application/pdf',
        }),
    ]);

    if (htmlUpload.error) {
      console.error('HTML upload error:', htmlUpload.error);
      return new Response(
        JSON.stringify({ error: "Failed to save invoice HTML" }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    if (pdfUpload.error) {
      console.error('PDF upload error:', pdfUpload.error);
      // Non-fatal — continue without PDF
    } else {
      console.log('PDF invoice uploaded:', pdfFileName);
    }

    // Get signed URL for download
    const { data: signedUrl } = await supabase.storage
      .from('invoices')
      .createSignedUrl(fileName, 3600);

    // Update invoice with PDF URL
    await supabase
      .from('invoices')
      .update({ pdf_url: signedUrl?.signedUrl })
      .eq('id', invoiceId);

    console.log('Invoice generated successfully:', invoice.invoice_number);

    return new Response(
      JSON.stringify({ 
        success: true, 
        pdfUrl: signedUrl?.signedUrl,
        html: htmlContent 
      }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  } catch (error: any) {
    console.error("Error generating invoice:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
};

serve(handler);
