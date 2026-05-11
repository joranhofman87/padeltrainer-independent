import { supabase } from '@/lib/supabaseClient';

/**
 * Call generate-invoice, get the signed PDF URL, and trigger a real file download.
 * Falls back to opening the HTML in a new tab for printing if PDF is unavailable.
 */
export async function downloadInvoicePdf(invoiceId: string, invoiceNumber?: string): Promise<boolean> {
  const { data, error } = await supabase.functions.invoke('generate-invoice', {
    body: { invoiceId },
  });

  if (error) {
    console.error('generate-invoice error:', error);
    return false;
  }

  // Prefer actual PDF download
  if (data?.pdfUrl) {
    const response = await fetch(data.pdfUrl);
    if (response.ok) {
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${invoiceNumber || 'factuur'}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return true;
    }
  }

  // No safe fallback: previously we did document.write(data.html), but that
  // executes any scripts in the returned HTML and is an XSS sink. Surface
  // failure to the caller instead so they can show a toast.
  return false;
}
