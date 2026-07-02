import { useRef } from "react";
import { Save } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

/** Default personalization tokens an email edge fn substitutes server-side. */
const DEFAULT_EMAIL_VARIABLES = ["{first_name}", "{last_name}", "{full_name}"] as const;

/** Default subject cap; the edge fns sanitize + cap authoritatively (150). */
const DEFAULT_EMAIL_SUBJECT_MAX = 150;

interface EmailSubjectFieldProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Field label (i18n resolved by the caller — keeps this component namespace-agnostic). */
  label: string;
  placeholder?: string;
  /** Helper text before the variable-insert buttons, e.g. "Insert variable:". */
  variablesHelp?: string;
  id?: string;
  /** When provided, renders a "Save as default" button (persisting is the caller's job). */
  onSaveDefault?: () => void;
  saveDefaultLabel?: string;
  /** Personalization tokens shown as cursor-aware insert buttons. Empty array hides them. */
  variables?: readonly string[];
  /** Max characters — mirror the server cap of the consuming email fn. */
  maxLength?: number;
}

/**
 * Shared email-SUBJECT editor: the single-line companion to {@link EmailMessageField}
 * — a capped `<Input>` with cursor-aware token insert (e.g. `{first_name}`), a char
 * counter, and an optional "Save as default" action. Namespace-agnostic. Leaving it
 * empty makes the edge fn fall back to its default subject.
 */
export function EmailSubjectField({
  value,
  onChange,
  disabled,
  label,
  placeholder,
  variablesHelp,
  id = "email-subject",
  onSaveDefault,
  saveDefaultLabel,
  variables = DEFAULT_EMAIL_VARIABLES,
  maxLength = DEFAULT_EMAIL_SUBJECT_MAX,
}: EmailSubjectFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const insertVariable = (token: string) => {
    const el = inputRef.current;
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

  const showVariables = variables.length > 0;

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value.slice(0, maxLength))}
        placeholder={placeholder}
        disabled={disabled}
      />
      {(showVariables || (onSaveDefault && saveDefaultLabel)) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {showVariables && <span className="mr-1 text-xs text-muted-foreground">{variablesHelp}</span>}
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
              className="ml-auto h-7 px-2 text-xs"
              onClick={onSaveDefault}
              disabled={disabled}
            >
              <Save className="mr-1 h-3.5 w-3.5" />
              {saveDefaultLabel}
            </Button>
          )}
        </div>
      )}
      <p className="text-xs text-muted-foreground">{value.length}/{maxLength}</p>
    </div>
  );
}
