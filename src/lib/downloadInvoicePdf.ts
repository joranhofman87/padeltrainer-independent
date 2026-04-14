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

  // Fallback: open HTML for printing
  if (data?.html) {
    const printWindow = window.open('', '_blank');
    if (printWindow) {
      printWindow.document.write(data.html);
      printWindow.document.close();
      printWindow.onload = () => printWindow.print();
    }
    return true;
  }

  return false;
}
