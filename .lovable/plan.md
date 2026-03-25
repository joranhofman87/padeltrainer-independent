

# Attach Invoice Document to Bookkeeper Forwarding Email

## Current State
The `forward-invoice` edge function sends an email with a **link** to the invoice HTML file in storage, but doesn't attach the actual document. Bookkeepers need the file attached so they can import it directly into their accounting software.

## Approach
Resend supports email attachments via `attachments: [{ filename, content }]` where `content` is a base64-encoded string. The invoice documents are stored as HTML files in Supabase Storage.

## Changes

### `supabase/functions/forward-invoice/index.ts`

1. **Download the invoice HTML** from storage using `supabase.storage.from('invoices').download(fileName)`
2. **If `pdf_url` is null**, first call `generate-invoice` to ensure the document exists before downloading
3. **Convert to base64** and attach to the Resend email as `{invoice_number}.html`
4. Keep the existing download link in the email body as a fallback

Key code addition (after the signed URL generation, before sending):
```typescript
// Download invoice file for attachment
const { data: fileData } = await supabase.storage
  .from("invoices")
  .download(fileName);

let attachments = [];
if (fileData) {
  const buffer = await fileData.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
  attachments = [{ filename: `${invoice.invoice_number}.html`, content: base64 }];
}
```

Then add `attachments` to each `resend.emails.send()` call.

| File | Change |
|------|--------|
| `supabase/functions/forward-invoice/index.ts` | Download invoice from storage, attach as HTML file to email |

