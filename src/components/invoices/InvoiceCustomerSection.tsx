import { useTranslation } from 'react-i18next';
import { Check, UserRound } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { flushOnMobileCardClass } from '@/components/ui/surface';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { GuestPlayerSlotCombobox } from '@/components/players/GuestPlayerSlotCombobox';
import type { GuestPlayer } from '@/components/players/guestPlayer';
import type { InvoiceReceiverFormFields, InvoicePlayerLink } from '@/lib/invoiceCustomer';
import type { InvoiceSelectablePlayer } from '@/lib/invoiceSelectablePlayers';
import { billingToReceiverFields } from '@/lib/invoiceCustomer';

export type InvoiceCustomerSectionProps = {
  players: InvoiceSelectablePlayer[];
  playersLoading?: boolean;
  playerLink: InvoicePlayerLink;
  onPlayerLinkChange: (link: InvoicePlayerLink) => void;
  receiver: InvoiceReceiverFormFields;
  onReceiverChange: (patch: Partial<InvoiceReceiverFormFields>) => void;
  /** When true (e.g. opened from player profile), skip search UI. */
  hidePlayerSearch?: boolean;
  oneTimeMode: boolean;
  onOneTimeModeChange: (oneTime: boolean) => void;
  /**
   * Server-search mode: provide both to make the picker input controlled and
   * have `players` server-filtered for the (debounced) search; cmdk's
   * client-side filtering is disabled. Omit for client-side filtering.
   */
  searchValue?: string;
  onSearchValueChange?: (search: string) => void;
};

function toComboboxPlayers(players: InvoiceSelectablePlayer[]): GuestPlayer[] {
  return players.map((p) => ({
    id: p.comboboxId,
    trainer_id: null,
    academy_profile_id: null,
    first_name: null,
    last_name: null,
    full_name: p.full_name,
    email: p.email,
    phone: p.phone,
    skill_rating: null,
    rating_system: 'knltb',
    notes: null,
    created_at: '',
    updated_at: '',
    linked_profile_id: p.profileId,
  }));
}

export function InvoiceCustomerSection({
  players,
  playersLoading,
  playerLink,
  onPlayerLinkChange,
  receiver,
  onReceiverChange,
  hidePlayerSearch = false,
  oneTimeMode,
  onOneTimeModeChange,
  searchValue,
  onSearchValueChange,
}: InvoiceCustomerSectionProps) {
  const { t } = useTranslation('common');

  const comboboxPlayers = toComboboxPlayers(players);
  const comboboxValue =
    playerLink.profileId != null
      ? `p_${playerLink.profileId}`
      : playerLink.guestPlayerId != null
        ? `g_${playerLink.guestPlayerId}`
        : '';

  const handleSelectPlayer = (comboboxId: string) => {
    if (!comboboxId) {
      onPlayerLinkChange({ profileId: null, guestPlayerId: null, linkedDisplayName: null });
      return;
    }
    const player = players.find((p) => p.comboboxId === comboboxId);
    if (!player) return;
    onPlayerLinkChange({
      profileId: player.profileId,
      guestPlayerId: player.guestPlayerId,
      linkedDisplayName: player.full_name,
    });
    onReceiverChange(billingToReceiverFields(player));
    onOneTimeModeChange(false);
  };

  const showSearch = !hidePlayerSearch && !oneTimeMode;
  const showOneTimeToggle = !hidePlayerSearch;

  return (
    <Card className={flushOnMobileCardClass()}>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          {showSearch || showOneTimeToggle
            ? t('invoiceForm.customer.title', 'Customer')
            : t('invoiceForm.receiver.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {showSearch && (
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">
              {t('invoiceForm.customer.searchPlayer', 'Search player…')}
            </Label>
            <GuestPlayerSlotCombobox
              players={comboboxPlayers}
              value={comboboxValue}
              showEmail
              placeholder={
                playersLoading
                  ? t('invoiceForm.customer.loadingPlayers', 'Loading players…')
                  : t('invoiceForm.customer.searchPlayer', 'Search player…')
              }
              emptyLabel={t('invoiceForm.customer.noPlayersFound', 'No player found.')}
              className="h-10 w-full"
              data-testid="invoice-customer-search"
              onValueChange={handleSelectPlayer}
              searchValue={searchValue}
              onSearchValueChange={onSearchValueChange}
              selectedLabel={playerLink.linkedDisplayName ?? undefined}
            />
          </div>
        )}

        {playerLink.linkedDisplayName && !oneTimeMode && (
          <p
            className="flex items-center gap-1.5 text-sm text-primary"
            data-testid="invoice-linked-player-indicator"
          >
            <Check className="h-4 w-4 shrink-0" />
            {t('invoiceForm.customer.linkedToPlayer', {
              name: playerLink.linkedDisplayName,
              defaultValue: 'Linked to {{name}}',
            })}
          </p>
        )}

        {showOneTimeToggle && (
          <div className="flex flex-wrap items-center gap-2">
            {oneTimeMode ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => {
                  onOneTimeModeChange(false);
                }}
              >
                <UserRound className="h-3.5 w-3.5" />
                {t('invoiceForm.customer.linkExistingPlayer', 'Link to existing player')}
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => {
                  onPlayerLinkChange({
                    profileId: null,
                    guestPlayerId: null,
                    linkedDisplayName: null,
                  });
                  onOneTimeModeChange(true);
                }}
              >
                {t('invoiceForm.customer.useOneTimeCustomer', 'Use one-time customer')}
              </Button>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label className="text-xs text-muted-foreground">{t('invoiceForm.receiver.nameRequired')}</Label>
            <Input
              value={receiver.playerName}
              onChange={(e) => onReceiverChange({ playerName: e.target.value })}
              placeholder={t('invoiceForm.receiver.namePlaceholder')}
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">{t('invoiceForm.receiver.businessName')}</Label>
            <Input
              value={receiver.playerBusinessName}
              onChange={(e) => onReceiverChange({ playerBusinessName: e.target.value })}
              placeholder={t('invoiceForm.receiver.businessNamePlaceholder')}
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">{t('invoiceForm.receiver.btwNumber')}</Label>
            <Input
              value={receiver.playerBtwNumber}
              onChange={(e) => onReceiverChange({ playerBtwNumber: e.target.value })}
              placeholder={t('invoiceForm.receiver.btwNumberPlaceholder')}
            />
          </div>
          <div className="sm:col-span-2">
            <Label className="text-xs text-muted-foreground">{t('invoiceForm.receiver.street')}</Label>
            <Input
              value={receiver.playerStreet}
              onChange={(e) => onReceiverChange({ playerStreet: e.target.value })}
              placeholder={t('invoiceForm.receiver.streetPlaceholder')}
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">{t('invoiceForm.receiver.zipCode')}</Label>
            <Input
              value={receiver.playerZipCode}
              onChange={(e) => onReceiverChange({ playerZipCode: e.target.value })}
              placeholder={t('invoiceForm.receiver.zipCodePlaceholder')}
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">{t('invoiceForm.receiver.city')}</Label>
            <Input
              value={receiver.playerCity}
              onChange={(e) => onReceiverChange({ playerCity: e.target.value })}
              placeholder={t('invoiceForm.receiver.cityPlaceholder')}
            />
          </div>
          <div className="sm:col-span-2">
            <Label className="text-xs text-muted-foreground">{t('invoiceForm.receiver.email')}</Label>
            <Input
              type="email"
              value={receiver.playerEmail}
              onChange={(e) => onReceiverChange({ playerEmail: e.target.value })}
              placeholder={t('invoiceForm.receiver.emailPlaceholder')}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
