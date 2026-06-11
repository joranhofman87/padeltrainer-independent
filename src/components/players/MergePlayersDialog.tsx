import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowLeftRight, Info, Loader2, Search } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { useToast } from '@/hooks/use-toast';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { fetchPlayersOverview } from '@/lib/playersOverview';
import { invalidateAllPlayerData, playerKeys, type PlayerScope } from '@/lib/playerQueryKeys';
import {
  buildMergeFields,
  compareMergeFields,
  isLinkedAccountsMergeError, getMergeErrorMessage, parseEmailConflictName,
  parseMergeCounts,
  type MergeChoice,
  type MergeComparisonKey,
} from '@/lib/mergePlayers';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { cn } from '@/lib/utils';
import type { Database, Json } from '@/integrations/supabase/types';

type GuestPlayerRow = Database['public']['Tables']['guest_players']['Row'];

interface MergePlayersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: PlayerScope;
  currentPlayer: { guestPlayerId: string; full_name: string };
  /** Called after a successful merge with the SURVIVING guest id. */
  onMerged: (targetGuestId: string) => void;
}

export function MergePlayersDialog({
  open,
  onOpenChange,
  scope,
  currentPlayer,
  onMerged,
}: MergePlayersDialogProps) {
  const { t } = useTranslation('trainer');
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [otherId, setOtherId] = useState<string | null>(null);
  const [swapped, setSwapped] = useState(false);
  const [choices, setChoices] = useState<Partial<Record<MergeComparisonKey, MergeChoice>>>({});
  const [merging, setMerging] = useState(false);

  // Full reset whenever the dialog closes so it always reopens on step 1.
  useEffect(() => {
    if (!open) {
      setSearch('');
      setOtherId(null);
      setSwapped(false);
      setChoices({});
      setMerging(false);
    }
  }, [open]);

  const debouncedSearch = useDebouncedValue(search);

  // STEP 1 — candidate search (guests only, never the current player itself).
  const { data: searchData, isFetching: searching } = useQuery({
    queryKey: playerKeys.picker(scope.kind, scope.id, `merge:${debouncedSearch}`),
    queryFn: () => fetchPlayersOverview(scope, { search: debouncedSearch, pageSize: 20 }),
    enabled: open && !otherId,
    placeholderData: keepPreviousData,
  });
  const candidates = useMemo(
    () =>
      (searchData?.rows ?? []).filter(
        (row) => row.guest_player_id && row.guest_player_id !== currentPlayer.guestPlayerId,
      ),
    [searchData, currentPlayer.guestPlayerId],
  );

  // STEP 2 — both full guest rows.
  const { data: pairRows, isLoading: pairLoading } = useQuery({
    queryKey: [
      ...playerKeys.scope(scope.kind, scope.id),
      'merge-pair',
      currentPlayer.guestPlayerId,
      otherId,
    ],
    enabled: open && Boolean(otherId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('guest_players')
        .select('*')
        .in('id', [currentPlayer.guestPlayerId, otherId as string]);
      if (error) throw error;
      return (data ?? []) as GuestPlayerRow[];
    },
  });

  const currentRow = pairRows?.find((r) => r.id === currentPlayer.guestPlayerId) ?? null;
  const otherRow = pairRows?.find((r) => r.id === otherId) ?? null;
  // Default direction: the CURRENT player is the target (kept).
  const targetRow = swapped ? otherRow : currentRow;
  const sourceRow = swapped ? currentRow : otherRow;

  const fieldStates = useMemo(
    () => (targetRow && sourceRow ? compareMergeFields(targetRow, sourceRow) : []),
    [targetRow, sourceRow],
  );
  const conflicts = fieldStates.filter((f) => f.kind === 'conflict');
  const carried = fieldStates.filter((f) => f.kind === 'carry_from_source');

  const fieldLabel = (key: MergeComparisonKey): string => {
    switch (key) {
      case 'full_name': return t('players.merge.fields.fullName', 'Name');
      case 'email': return t('players.merge.fields.email', 'Email');
      case 'phone': return t('players.merge.fields.phone', 'Phone');
      case 'skill': return t('players.merge.fields.skill', 'Level');
      case 'birth_date': return t('players.merge.fields.birthDate', 'Date of birth');
      case 'notes': return t('players.merge.fields.notes', 'Notes');
      case 'billing_business_name': return t('players.merge.fields.billingBusinessName', 'Billing business name');
      case 'billing_address': return t('players.merge.fields.billingAddress', 'Billing address');
      case 'billing_btw_number': return t('players.merge.fields.billingBtwNumber', 'VAT number');
    }
  };

  function pickCandidate(guestId: string) {
    setOtherId(guestId);
    setSwapped(false);
    setChoices({});
  }

  function handleSwap() {
    setSwapped((prev) => !prev);
    setChoices({});
  }

  async function handleConfirm() {
    if (!targetRow || !sourceRow) return;
    setMerging(true);
    try {
      const fields = buildMergeFields(targetRow, sourceRow, choices);
      const { data, error } = await supabase.rpc('merge_guest_players', {
        p_scope: scope.kind,
        p_scope_id: scope.id,
        p_source_guest_id: sourceRow.id,
        p_target_guest_id: targetRow.id,
        p_fields: fields as Json,
      });
      if (error) throw error;

      const counts = parseMergeCounts(data);
      toast({
        title: t('players.merge.success', 'Players merged'),
        description: t(
          'players.merge.successDescription',
          'Merged into {{name}}: {{bookings}} trainings and {{invoices}} invoices moved.',
          {
            name: targetRow.full_name,
            bookings: counts.bookingsMoved,
            invoices: counts.invoicesMoved,
          },
        ),
      });
      await invalidateAllPlayerData(queryClient, scope);
      onOpenChange(false);
      onMerged(targetRow.id);
    } catch (err: unknown) {
      logger.error(
        'Error merging guest players',
        err instanceof Error ? err : new Error(String(err)),
        { component: 'MergePlayersDialog' },
      );
      const message = getMergeErrorMessage(err);
      const conflictName = parseEmailConflictName(message);
      toast({
        title: t('players.merge.errorTitle', 'Merge failed'),
        description: isLinkedAccountsMergeError(message)
          ? t(
              'players.merge.errors.linkedAccounts',
              'These players are linked to two different accounts and cannot be merged.',
            )
          : conflictName
            ? t('players.merge.errors.emailConflict', {
                name: conflictName,
                defaultValue:
                  'That email address is already used by another player: {{name}}. Merge or update that player first.',
              })
            : message,
        variant: 'destructive',
      });
    } finally {
      setMerging(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="merge-players-dialog">
        <DialogHeader>
          <DialogTitle>{t('players.merge.title', 'Merge players')}</DialogTitle>
          <DialogDescription>
            {otherId
              ? t(
                  'players.merge.compareDescription',
                  'Check the result before merging. This cannot be undone.',
                )
              : t(
                  'players.merge.pickDescription',
                  'Search the duplicate player to merge with {{name}}. Only guest players can be merged.',
                  { name: currentPlayer.full_name },
                )}
          </DialogDescription>
        </DialogHeader>

        {!otherId ? (
          /* ---------------- STEP 1: pick the other player ---------------- */
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                autoFocus
                data-testid="merge-search-input"
                className="pl-8"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('players.merge.searchPlaceholder', 'Search by name or email…')}
              />
            </div>
            <div className="max-h-64 overflow-y-auto rounded-md border divide-y">
              {searching && candidates.length === 0 ? (
                <div className="py-8 flex justify-center text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              ) : candidates.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {t('players.merge.noResults', 'No mergeable guest players found')}
                </p>
              ) : (
                candidates.map((row) => (
                  <button
                    key={row.guest_player_id}
                    type="button"
                    data-testid={`merge-candidate-${row.guest_player_id}`}
                    aria-label={row.full_name}
                    onClick={() => pickCandidate(row.guest_player_id as string)}
                    className="w-full text-left p-3 hover:bg-muted/50 transition-colors"
                  >
                    <p className="font-medium text-sm">{row.full_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {[row.email, row.phone].filter(Boolean).join(' · ') ||
                        t('players.merge.noContactInfo', 'No contact info')}
                    </p>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : pairLoading || !targetRow || !sourceRow ? (
          <div className="py-10 flex justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          /* ---------------- STEP 2: comparison + confirm ---------------- */
          <div className="space-y-4">
            <div className="flex items-stretch gap-2">
              <div
                className="flex-1 rounded-md border border-primary/40 bg-primary/5 p-3 min-w-0"
                data-testid="merge-kept-box"
              >
                <Badge variant="secondary" className="mb-1">
                  {t('players.merge.keptLabel', 'Kept')}
                </Badge>
                <p className="font-medium text-sm truncate">{targetRow.full_name}</p>
                {targetRow.email && (
                  <p className="text-xs text-muted-foreground truncate">{targetRow.email}</p>
                )}
              </div>
              <div className="flex items-center">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  data-testid="merge-swap"
                  onClick={handleSwap}
                  aria-label={t('players.merge.swap', 'Swap which player is kept')}
                  title={t('players.merge.swap', 'Swap which player is kept')}
                >
                  <ArrowLeftRight className="h-4 w-4" />
                </Button>
              </div>
              <div
                className="flex-1 rounded-md border border-destructive/50 bg-destructive/5 p-3 min-w-0"
                data-testid="merge-deleted-box"
              >
                <Badge variant="destructive" className="mb-1">
                  {t('players.merge.deletedLabel', 'Will be deleted')}
                </Badge>
                <p className="font-medium text-sm truncate">{sourceRow.full_name}</p>
                {sourceRow.email && (
                  <p className="text-xs text-muted-foreground truncate">{sourceRow.email}</p>
                )}
              </div>
            </div>

            {conflicts.length > 0 && (
              <div className="space-y-3">
                <p className="text-sm font-medium">
                  {t('players.merge.chooseValues', 'Choose which details to keep')}
                </p>
                <div className="space-y-3 max-h-56 overflow-y-auto pr-1">
                  {conflicts.map((field) => {
                    const value = choices[field.key] ?? 'target';
                    return (
                      <div key={field.key} className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">
                          {fieldLabel(field.key)}
                        </Label>
                        <RadioGroup
                          value={value}
                          onValueChange={(next) =>
                            setChoices((prev) => ({ ...prev, [field.key]: next as MergeChoice }))
                          }
                          className="gap-1.5"
                        >
                          {(['target', 'source'] as const).map((side) => {
                            const row = side === 'target' ? targetRow : sourceRow;
                            const display =
                              side === 'target' ? field.targetValue : field.sourceValue;
                            const id = `merge-${field.key}-${side}`;
                            return (
                              <div
                                key={side}
                                className={cn(
                                  'flex items-start gap-2 rounded-md border p-2',
                                  value === side ? 'border-primary bg-primary/5' : 'border-border',
                                )}
                              >
                                <RadioGroupItem
                                  value={side}
                                  id={id}
                                  data-testid={id}
                                  className="mt-0.5"
                                />
                                <Label htmlFor={id} className="font-normal cursor-pointer min-w-0">
                                  <span className="block text-sm break-words">{display}</span>
                                  <span className="block text-xs text-muted-foreground">
                                    {t('players.merge.fromPlayer', 'From {{name}}', {
                                      name: row.full_name,
                                    })}
                                  </span>
                                </Label>
                              </div>
                            );
                          })}
                        </RadioGroup>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {carried.length > 0 && (
              <div className="rounded-md bg-muted/50 p-3 space-y-1" data-testid="merge-auto-carried">
                <p className="text-xs font-medium text-muted-foreground">
                  {t('players.merge.autoCarried', 'Carried over automatically')}
                </p>
                {carried.map((field) => (
                  <p key={field.key} className="text-xs text-muted-foreground">
                    {fieldLabel(field.key)}: <span className="text-foreground">{field.sourceValue}</span>
                  </p>
                ))}
              </div>
            )}

            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription className="text-xs">
                {t(
                  'players.merge.combinedInfo',
                  'Trainings/cycluses, invoices, emails, tags and notes from both players will be combined.',
                )}{' '}
                {t(
                  'players.merge.emailHistoryNote',
                  'Email history follows the email address you keep.',
                )}
              </AlertDescription>
            </Alert>

            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOtherId(null)}
                disabled={merging}
              >
                <ArrowLeft className="h-4 w-4 mr-2" />
                {t('players.merge.back', 'Back')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                data-testid="merge-confirm"
                disabled={merging}
                onClick={() => void handleConfirm()}
              >
                {merging && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {t('players.merge.confirm', 'Merge and delete {{name}}', {
                  name: sourceRow.full_name,
                })}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
