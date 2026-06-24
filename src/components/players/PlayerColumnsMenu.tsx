import { Columns3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ColumnDescriptor } from './useVisibleColumns';

interface PlayerColumnsMenuProps<K extends string> {
  allColumns: ColumnDescriptor<K>[];
  isColVisible: (key: K) => boolean;
  onToggle: (key: K) => void;
  labels: { button: string; default: string; optional: string };
}

/**
 * The "Columns" visibility dropdown for the trainer + academy player-list tables (default + optional
 * sections of checkbox items). Pairs with `useVisibleColumns`. Column labels live on the descriptors;
 * the three chrome labels are injected so each page keeps its own i18n call.
 */
export function PlayerColumnsMenu<K extends string>({
  allColumns,
  isColVisible,
  onToggle,
  labels,
}: PlayerColumnsMenuProps<K>) {
  const items = (isDefault: boolean) =>
    allColumns
      .filter((c) => c.isDefault === isDefault)
      .map((c) => (
        <DropdownMenuCheckboxItem
          key={c.key}
          checked={isColVisible(c.key)}
          onCheckedChange={() => onToggle(c.key)}
          onSelect={(e) => e.preventDefault()}
        >
          {c.label}
        </DropdownMenuCheckboxItem>
      ));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="hidden md:inline-flex">
          <Columns3 className="mr-2 h-4 w-4" />
          {labels.button}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>{labels.default}</DropdownMenuLabel>
        {items(true)}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{labels.optional}</DropdownMenuLabel>
        {items(false)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
