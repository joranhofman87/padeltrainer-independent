import type { LucideIcon } from 'lucide-react';
import { ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { AppPage, surfaceCardClass } from '@/components/ui/app-page';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/** One "how do I set this up?" option rendered as a card on a {@link SetupHub}. */
export interface SetupOption {
  id: string;
  icon: LucideIcon;
  /** Tailwind bg for the icon chip, e.g. 'bg-sky-500/10'. */
  iconBg: string;
  /** Tailwind text colour for the icon, e.g. 'text-sky-600'. */
  iconColor: string;
  title: string;
  description: string;
  cta: string;
  /** Destination route (in-app). The whole card and the CTA navigate here. */
  to: string;
  testId?: string;
}

interface SetupHubProps {
  title: string;
  description?: string;
  options: SetupOption[];
  testId?: string;
}

/**
 * A discovery hub that surfaces the different ways to set something up — each as a
 * card with an icon, a title, an explanation of WHAT it does, and a CTA that links to
 * the page where you do it. Presentational + config-driven: callers pass the applicable
 * {@link SetupOption}s (they differ per dashboard/role).
 */
export function SetupHub({ title, description, options, testId }: SetupHubProps) {
  const navigate = useNavigate();

  return (
    <AppPage width="default" as="main" data-testid={testId}>
      <PageHeader title={title} description={description} />

      <div className="grid gap-4 md:grid-cols-2">
        {options.map((opt) => {
          const Icon = opt.icon;
          return (
            <Card
              key={opt.id}
              className={cn(surfaceCardClass(), 'flex flex-col cursor-pointer transition-colors hover:bg-muted/30')}
              onClick={() => navigate(opt.to)}
              data-testid={opt.testId}
            >
              <CardHeader className="pb-2">
                <div className="flex items-center gap-3">
                  <div className={cn('rounded-lg p-2', opt.iconBg)}>
                    <Icon className={cn('h-5 w-5', opt.iconColor)} />
                  </div>
                  <CardTitle className="text-lg">{opt.title}</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col justify-between gap-4">
                <CardDescription className="text-sm leading-relaxed">{opt.description}</CardDescription>
                <Button
                  variant="secondary"
                  className="w-fit gap-1.5"
                  // Card already navigates; stop propagation so we don't double-fire.
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(opt.to);
                  }}
                >
                  {opt.cta}
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </AppPage>
  );
}
