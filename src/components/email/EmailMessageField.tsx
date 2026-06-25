import { useRef } from "react";
import { Save } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

/** Default personalization tokens an email edge fn substitutes server-side. */
const DEFAULT_EMAIL_VARIABLES = ["{first_name}", "{last_name}", "{full_name}"] as const;

/** Default character cap; each caller should mirror its own server-side limit. */
const DEFAULT_EMAIL_MESSAGE_MAX = 2000;

interface EmailMessageFieldProps {
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
  /** Personalization tokens shown as cursor-aware insert buttons. */
  variables?: readonly string[];
  /** Max characters — mirror the server cap of the consuming email fn. */
  maxLength?: number;
}

/**
 * Shared email-message editor: a capped textarea + cursor-aware token insert
 * buttons (e.g. `{first_name}`) + a char counter, plus an optional "Save as
 * default" action. Namespace-agnostic (the caller supplies labels/tokens/cap),
 * so it's reused across invoice emails, rebooking invites and reminders, etc.
 */
export function EmailMessageField({
  value,
  onChange,
  disabled,
  label,
  placeholder,
  variablesHelp,
  id = "email-message",
  onSaveDefault,
  saveDefaultLabel,
  variables = DEFAULT_EMAIL_VARIABLES,
  maxLength = DEFAULT_EMAIL_MESSAGE_MAX,
}: EmailMessageFieldProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const insertVariable = (token: string) => {
    const el = textareaRef.current;
    if (!el) {
      onChange((value + token).slice(0, maxLength));
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = (value.slice(0, start) + token + value.slice(end)).slice(0, maxLength);
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
        onChange={(e) => onChange(e.target.value.slice(0, maxLength))}
        placeholder={placeholder}
        rows={8}
        disabled={disabled}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground mr-1">{variablesHelp}</span>
        {variables.map((token) => (
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
        {onSaveDefault && saveDefaultLabel && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs ml-auto"
            onClick={onSaveDefault}
            disabled={disabled}
          >
            <Save className="h-3.5 w-3.5 mr-1" />
            {saveDefaultLabel}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{value.length}/{maxLength}</p>
    </div>
  );
}
