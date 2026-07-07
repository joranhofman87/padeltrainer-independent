import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { DateInputField } from '@/components/ui/date-input-field';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { formatCurrency } from '@/lib/format';
import {
  listExpenses, createExpense, updateExpense, deleteExpense,
  EXPENSE_CATEGORIES, type Expense, type ExpenseOwner, type ExpenseInput,
} from '@/lib/expenses';

const ownerKey = (o: ExpenseOwner) => ('academyProfileId' in o ? o.academyProfileId : o.trainerId);
const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });

interface FormState {
  expense_date: string;
  amount: string;
  category: string;
  description: string;
}
const emptyForm = (): FormState => ({ expense_date: todayISO(), amount: '', category: 'court_rental', description: '' });

/** Money-out manager: list + add/edit + delete, owner-scoped (academy or trainer). RLS enforces
 *  the tenant boundary (migration 20260718100000); this is the input surface for the money chart. */
export default function ExpensesManager({ owner }: { owner: ExpenseOwner }) {
  const { t } = useTranslation('common');
  const qc = useQueryClient();
  const key = ownerKey(owner);
  const queryKey = ['expenses', key];

  const { data: expenses = [], isLoading } = useQuery({
    queryKey,
    queryFn: () => listExpenses(owner),
    enabled: !!key,
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());

  const catLabel = (c: string) => t(`expenses.category.${c}`, c);

  const monthTotal = useMemo(() => {
    const m = todayISO().slice(0, 7);
    return expenses.filter((e) => e.expense_date.slice(0, 7) === m).reduce((s, e) => s + Number(e.amount), 0);
  }, [expenses]);

  const openAdd = () => { setEditing(null); setForm(emptyForm()); setDialogOpen(true); };
  const openEdit = (e: Expense) => {
    setEditing(e);
    setForm({ expense_date: e.expense_date, amount: String(e.amount), category: e.category, description: e.description ?? '' });
    setDialogOpen(true);
  };

  const save = useMutation({
    mutationFn: async () => {
      const input: ExpenseInput = {
        expense_date: form.expense_date,
        amount: Number(form.amount),
        category: form.category,
        description: form.description,
      };
      if (editing) await updateExpense(editing.id, input);
      else await createExpense(owner, input);
    },
    onSuccess: () => {
      toast.success(t('expenses.saved', 'Uitgave opgeslagen'));
      setDialogOpen(false);
      qc.invalidateQueries({ queryKey });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteExpense(id),
    onSuccess: () => { toast.success(t('expenses.deleted', 'Uitgave verwijderd')); qc.invalidateQueries({ queryKey }); },
    onError: (e) => toast.error((e as Error).message),
  });

  const amountValid = Number(form.amount) > 0;
  const canSave = amountValid && !!form.expense_date && !!form.category && !save.isPending;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {t('expenses.totalThisMonth', 'Deze maand uitgegeven')}:{' '}
          <span className="font-semibold text-foreground">{formatCurrency(monthTotal)}</span>
        </p>
        <Button size="sm" onClick={openAdd}>
          <Plus className="h-4 w-4 mr-1" /> {t('expenses.add', 'Uitgave toevoegen')}
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>
          ) : expenses.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              {t('expenses.empty', 'Nog geen uitgaven. Voeg je eerste uitgave toe om je winst bij te houden.')}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="whitespace-nowrap">{t('expenses.colDate', 'Datum')}</TableHead>
                    <TableHead>{t('expenses.colCategory', 'Categorie')}</TableHead>
                    <TableHead className="hidden sm:table-cell">{t('expenses.colDescription', 'Omschrijving')}</TableHead>
                    <TableHead className="text-right whitespace-nowrap">{t('expenses.colAmount', 'Bedrag')}</TableHead>
                    <TableHead className="w-16" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {expenses.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="whitespace-nowrap">{fmtDate(e.expense_date)}</TableCell>
                      <TableCell>{catLabel(e.category)}</TableCell>
                      <TableCell className="hidden sm:table-cell text-muted-foreground">{e.description || '—'}</TableCell>
                      <TableCell className="text-right tabular-nums whitespace-nowrap">{formatCurrency(Number(e.amount))}</TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEdit(e)} aria-label={t('expenses.edit', 'Bewerken')}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" aria-label={t('expenses.delete', 'Verwijderen')}>
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>{t('expenses.deleteConfirmTitle', 'Uitgave verwijderen?')}</AlertDialogTitle>
                                <AlertDialogDescription>
                                  {t('expenses.deleteConfirmBody', 'Deze uitgave wordt definitief verwijderd.')}
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>{t('common:cancel', 'Annuleren')}</AlertDialogCancel>
                                <AlertDialogAction onClick={() => remove.mutate(e.id)}>
                                  {t('expenses.delete', 'Verwijderen')}
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? t('expenses.editTitle', 'Uitgave bewerken') : t('expenses.add', 'Uitgave toevoegen')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="exp-date">{t('expenses.formDate', 'Datum')}</Label>
                <DateInputField id="exp-date" value={form.expense_date} onChange={(e) => setForm((f) => ({ ...f, expense_date: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="exp-amount">{t('expenses.formAmount', 'Bedrag (€)')}</Label>
                <Input id="exp-amount" type="number" min="0" step="0.01" inputMode="decimal"
                  value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                  className={form.amount && !amountValid ? 'border-destructive' : ''} />
              </div>
            </div>
            <div className="space-y-1">
              <Label>{t('expenses.formCategory', 'Categorie')}</Label>
              <Select value={form.category} onValueChange={(v) => setForm((f) => ({ ...f, category: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {EXPENSE_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>{catLabel(c)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="exp-desc">{t('expenses.formDescription', 'Omschrijving (optioneel)')}</Label>
              <Input id="exp-desc" value={form.description} maxLength={200}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={save.isPending}>{t('common:cancel', 'Annuleren')}</Button>
            <Button onClick={() => save.mutate()} disabled={!canSave}>
              {save.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              {t('expenses.save', 'Opslaan')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
