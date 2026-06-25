import { useRef } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

/** Personalization tokens the send-invoice-email edge fn substitutes server-side. */
const VARIABLES = ["{first_name}", "{last_name}", "{full_name}"] as const;

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
}

/**
 * Shared invoice-email message editor: a capped textarea + `{first_name}` /
 * `{last_name}` / `{full_name}` cursor-aware insert buttons + a char counter.
 * Used by both the single-send (SendInvoiceEmailDialog) and bulk
 * (BulkInvoiceEmailDialog) composers so the editor stays identical.
 */
export function InvoiceEmailMessageField({
  value,
  onChange,
  disabled,
  label,
  placeholder,
  variablesHelp,
  id = "invoice-email-message",
}: InvoiceEmailMessageFieldProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const insertVariable = (token: string) => {
    const el = textareaRef.current;
    if (!el) {
      onChange((value + token).slice(0, INVOICE_EMAIL_MESSAGE_MAX));
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = (value.slice(0, start) + token + value.slice(end)).slice(0, INVOICE_EMAIL_MESSAGE_MAX);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = Math.min(start + token.length, next.length);
      el.setSelectionRange(pos, pos);
    });
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value.slice(0, INVOICE_EMAIL_MESSAGE_MAX))}
        placeholder={placeholder}
        rows={8}
        disabled={disabled}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground mr-1">{variablesHelp}</span>
        {VARIABLES.map((token) => (
          <Button
            key={token}
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            onClick={() => insertVariable(token)}
            disabled={disabled}
          >
            {token}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{value.length}/{INVOICE_EMAIL_MESSAGE_MAX}</p>
    </div>
  );
}
