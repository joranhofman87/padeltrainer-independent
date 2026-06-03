import type { LucideIcon } from 'lucide-react';
import { MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export interface TrainerMoreMenuItem {
  label: string;
  onClick: () => void;
  icon?: LucideIcon;
}

interface TrainerMoreMenuProps {
  items: TrainerMoreMenuItem[];
  className?: string;
}

export function TrainerMoreMenu({ items, className }: TrainerMoreMenuProps) {
  const { t } = useTranslation('trainer');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className={cn('w-full sm:w-auto', className)}>
          <MoreHorizontal className="mr-2 h-4 w-4" />
          {t('shell.more')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <DropdownMenuItem key={item.label} onClick={item.onClick}>
              {Icon && <Icon className="mr-2 h-4 w-4" />}
              {item.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
