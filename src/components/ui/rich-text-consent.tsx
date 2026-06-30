import * as React from 'react';
import { Loader2, FileText } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { SafeHtml } from '@/components/ui/SafeHtml';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { cn } from '@/lib/utils';

export interface RichTextConsentProps {
  /**
   * Sanitized rich HTML (rules / terms). Rendered through {@link SafeHtml} (DOMPurify), so a
   * caller never has to pre-sanitize. Null/empty renders NOTHING — the whole component returns
   * null, so a page can mount it unconditionally and it only appears when there is content. This
   * matches the `!!content && !accepted` gate idiom callers use; normalize a visually-blank
   * editor value (e.g. `<p></p>`) to null at write/fetch time so the gate and the display agree.
   */
  content: string | null | undefined;
  loading?: boolean;
  /** Shown next to the spinner while `loading`. */
  loadingLabel?: React.ReactNode;
  accepted: boolean;
  onAcceptChange: (accepted: boolean) => void;
  /** Heading shown above the box / on the accordion trigger. */
  title: React.ReactNode;
  /** The opt-in checkbox label (e.g. "I agree to the rebooking rules"). */
  checkboxLabel: React.ReactNode;
  /**
   * `box` (default) = an always-visible bordered scroll box (the booking-terms look).
   * `accordion` = a collapsed disclosure the reader expands to view the rules.
   */
  variant?: 'box' | 'accordion';
  /**
   * Stable id linking the checkbox to its label. Auto-generated when omitted — pass an explicit
   * value only when a test/consumer asserts on it, and keep it unique if several render on one page.
   */
  id?: string;
  /** Icon next to the title in the `box` variant. Defaults to a document icon; pass `null` to hide. */
  icon?: React.ReactNode | null;
  className?: string;
  /** Overrides the prose classes applied to the rendered content. */
  contentClassName?: string;
}

/**
 * Reusable "show rich-text content + require an opt-in" widget. Renders academy-authored rich HTML
 * (terms, rebooking rules, …) in either an always-visible box or a collapsible accordion, with a
 * mandatory consent checkbox below it. The caller owns the `accepted` state and gates its own
 * action (e.g. `disabled={!!content && !accepted}`). {@link TermsAcceptance} is a thin wrapper of
 * this for the booking general-terms case.
 */
export function RichTextConsent({
  content,
  loading,
  loadingLabel,
  accepted,
  onAcceptChange,
  title,
  checkboxLabel,
  variant = 'box',
  id,
  icon,
  className,
  contentClassName,
}: RichTextConsentProps) {
  const autoId = React.useId();
  const checkboxId = id ?? `rich-text-consent-${autoId}`;

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        {loadingLabel}
      </div>
    );
  }

  if (!content) return null;
  const html = content;

  const consent = (
    <div className="flex items-start space-x-3">
      <Checkbox
        id={checkboxId}
        checked={accepted}
        onCheckedChange={(checked) => onAcceptChange(checked === true)}
      />
      <Label
        htmlFor={checkboxId}
        className="font-normal text-sm leading-relaxed cursor-pointer"
      >
        {checkboxLabel}
      </Label>
    </div>
  );

  if (variant === 'accordion') {
    return (
      <div className={cn('space-y-3', className)}>
        <Accordion type="single" collapsible className="rounded-lg border px-3">
          <AccordionItem value="content" className="border-b-0">
            <AccordionTrigger className="text-sm">{title}</AccordionTrigger>
            <AccordionContent>
              <SafeHtml
                html={html}
                className={cn(
                  'prose prose-sm dark:prose-invert max-w-none text-sm',
                  contentClassName,
                )}
              />
            </AccordionContent>
          </AccordionItem>
        </Accordion>
        {consent}
      </div>
    );
  }

  return (
    <div className={cn('space-y-3', className)}>
      <div className="border rounded-lg p-3 max-h-40 overflow-y-auto bg-muted/30">
        <div className="flex items-center gap-2 text-sm font-medium mb-2">
          {icon === null ? null : icon ?? <FileText className="h-4 w-4" />}
          {title}
        </div>
        <SafeHtml
          html={html}
          className={cn(
            'prose prose-xs dark:prose-invert max-w-none text-xs',
            contentClassName,
          )}
        />
      </div>
      {consent}
    </div>
  );
}
