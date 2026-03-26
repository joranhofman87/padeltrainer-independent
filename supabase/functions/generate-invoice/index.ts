import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #1f2937; margin: 0; padding: 40px; }
    .invoice-container { max-width: 800px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; margin-bottom: 40px; }
    .invoice-title { font-size: 32px; font-weight: bold; color: #16a34a; margin: 0; }
    .invoice-meta { text-align: right; }
    .invoice-meta p { margin: 4px 0; }
    .parties { display: flex; justify-content: space-between; margin-bottom: 40px; }
    .party { width: 45%; }
    .party-label { font-size: 12px; color: #6b7280; text-transform: uppercase; margin-bottom: 8px; }
    .party-name { font-weight: bold; font-size: 16px; }
    .party-details { font-size: 14px; color: #4b5563; white-space: pre-line; }
    .items-table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    .items-table th { background: #f3f4f6; padding: 12px; text-align: left; font-size: 12px; text-transform: uppercase; color: #6b7280; }
    .items-table th:nth-child(2), .items-table th:nth-child(3), .items-table th:nth-child(4) { text-align: right; }
    .items-table th:nth-child(2) { text-align: center; }
    .totals { margin-left: auto; width: 300px; }
    .totals-row { display: flex; justify-content: space-between; padding: 8px 0; }
    .totals-row.total { font-weight: bold; font-size: 18px; border-top: 2px solid #1f2937; padding-top: 12px; margin-top: 8px; }
    .payment-info { background: #f9fafb; padding: 20px; border-radius: 8px; margin-top: 40px; }
    .payment-title { font-weight: bold; margin-bottom: 12px; }
    .payment-row { display: flex; gap: 24px; font-size: 14px; }
    .payment-label { color: #6b7280; width: 120px; }
    .notes { margin-top: 24px; padding: 16px; background: #fef3c7; border-radius: 8px; font-size: 14px; }
    @media print {
      body { padding: 20px; }
      .invoice-container { max-width: 100%; }
    }
  </style>
</head>
<body>
  <div class="invoice-container">
    <div class="header">
      <div style="display: flex; align-items: center; gap: 16px;">
        ${invoice.logo_url ? `<img src="${invoice.logo_url}" alt="Logo" style="max-height: 60px; max-width: 200px; object-fit: contain;" />` : ''}
        <h1 class="invoice-title">FACTUUR</h1>
      </div>
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
      ${invoice.vat_breakdown && Object.keys(invoice.vat_breakdown).length > 1
        ? Object.entries(invoice.vat_breakdown)
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([rate, data]) => `
              <div class="totals-row">
                <span>BTW ${rate}%</span>
                <span>${formatCurrency((data as any).vat)}</span>
              </div>
            `).join('')
        : `<div class="totals-row">
            <span>BTW ${invoice.vat_rate}%</span>
            <span>${formatCurrency(invoice.vat_amount)}</span>
          </div>`
      }
      <div class="totals-row total">
        <span>Totaal</span>
        <span>${formatCurrency(invoice.total)}</span>
      </div>
    </div>

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

    ${invoice.notes ? `<div class="notes">${invoice.notes}</div>` : ''}
  </div>
</body>
</html>
  `;
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
    
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
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

    // Fetch trainer business info
    const { data: trainerProfile, error: trainerError } = await supabase
      .from('trainer_profiles')
      .select('business_name, business_address, kvk_number, btw_number, iban, bic, payment_terms_days, user_id, invoice_logo_url')
      .eq('id', invoice.trainer_id)
      .single();

    if (trainerError || !trainerProfile) {
      return new Response(
        JSON.stringify({ error: "Trainer profile not found" }),
        { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Fetch academy profile if invoice belongs to an academy
    let academyProfile: any = null;
    if (invoice.academy_profile_id) {
      const { data: ap } = await supabase
        .from('academy_profiles')
        .select('name, business_name, business_address, kvk_number, btw_number, iban, bic, invoice_logo_url, invoice_banner_color, payment_terms_days')
        .eq('id', invoice.academy_profile_id)
        .single();
      academyProfile = ap;
    }

    // Allow the trainer, the player, AND academy managers to access the invoice
    const isTrainer = trainerProfile.user_id === user.id;
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
      : (trainerProfile.business_name || '');

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
    
    // Store under trainer's user_id folder (consistent path)
    const fileName = `${trainerProfile.user_id}/${invoice.invoice_number}.html`;
    const { error: uploadError } = await supabase.storage
      .from('invoices')
      .upload(fileName, new Blob([htmlContent], { type: 'text/html' }), {
        upsert: true,
        contentType: 'text/html',
      });

    if (uploadError) {
      console.error('Upload error:', uploadError);
      return new Response(
        JSON.stringify({ error: "Failed to save invoice" }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
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
