import { EmailMessageField } from "@/components/email/EmailMessageField";

/** Server caps the message at 2000 chars (send-invoice-email); mirror it here. */
export const INVOICE_EMAIL_MESSAGE_MAX = 2000;

interface InvoiceEmailMessageFieldProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Field label (i18n resolved by the caller — keeps this component namespace-agnostic). */
  label: string;
  placeholder?: string;
  /** Helper text before the variable-insert buttons, e.g. "Insert variable:". */
  variablesHelp: string;
  id?: string;
  /** When provided, renders a "Save as default" button (persisting is the caller's job). */
  onSaveDefault?: () => void;
  saveDefaultLabel?: string;
}

/**
 * Invoice-flavoured wrapper around the shared {@link EmailMessageField}: pins the
 * `{first_name}`/`{last_name}`/`{full_name}` tokens + the 2000-char cap that the
 * `send-invoice-email` edge fn substitutes/enforces. Used by both the single-send
 * (SendInvoiceEmailDialog) and bulk (BulkInvoiceEmailDialog) composers.
 */
export function InvoiceEmailMessageField({ id = "invoice-email-message", ...props }: InvoiceEmailMessageFieldProps) {
  return <EmailMessageField id={id} maxLength={INVOICE_EMAIL_MESSAGE_MAX} {...props} />;
}
