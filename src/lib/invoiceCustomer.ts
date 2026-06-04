/** Player linking for manual invoice creation. */

export type ParsedInvoicePlayerParam =
  | { kind: 'guest'; guestPlayerId: string }
  | { kind: 'profile'; profileId: string };

export type InvoiceReceiverFormFields = {
  playerName: string;
  playerBusinessName: string;
  playerStreet: string;
  playerZipCode: string;
  playerCity: string;
  playerBtwNumber: string;
  playerEmail: string;
};

export type InvoicePlayerLink = {
  profileId: string | null;
  guestPlayerId: string | null;
  linkedDisplayName: string | null;
};

export function parseInvoicePlayerIdParam(
  raw: string | null | undefined,
): ParsedInvoicePlayerParam | null {
  if (!raw?.trim()) return null;
  const value = raw.trim();
  if (value.startsWith('g_')) {
    return { kind: 'guest', guestPlayerId: value.slice(2) };
  }
  if (value.startsWith('p_')) {
    return { kind: 'profile', profileId: value.slice(2) };
  }
  return null;
}

export function toInvoicePlayerIdParam(link: InvoicePlayerLink): string | null {
  if (link.profileId) return `p_${link.profileId}`;
  if (link.guestPlayerId) return `g_${link.guestPlayerId}`;
  return null;
}

export function splitBillingAddress(address: string | null | undefined): {
  street: string;
  zipCode: string;
  city: string;
} {
  if (!address?.trim()) {
    return { street: '', zipCode: '', city: '' };
  }
  const lines = address.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 2) {
    const last = lines[lines.length - 1];
    const zipCity = last.match(/^(\d{4}\s?[A-Za-z]{0,2}\s?)(.+)$/);
    if (zipCity) {
      return {
        street: lines.slice(0, -1).join('\n'),
        zipCode: zipCity[1].trim(),
        city: zipCity[2].trim(),
      };
    }
    return { street: lines.slice(0, -1).join('\n'), zipCode: '', city: last };
  }
  const single = lines[0];
  const zipCity = single.match(/^(.+?)\s+(\d{4}\s?[A-Za-z]{0,2})\s+(.+)$/);
  if (zipCity) {
    return { street: zipCity[1].trim(), zipCode: zipCity[2].trim(), city: zipCity[3].trim() };
  }
  return { street: single, zipCode: '', city: '' };
}

export function joinBillingAddress(street: string, zipCode: string, city: string): string | null {
  const parts = [street.trim(), [zipCode.trim(), city.trim()].filter(Boolean).join(' ')].filter(Boolean);
  return parts.length ? parts.join('\n') : null;
}

export function billingToReceiverFields(input: {
  full_name: string;
  email?: string | null;
  billing_business_name?: string | null;
  billing_address?: string | null;
  billing_btw_number?: string | null;
}): InvoiceReceiverFormFields {
  const { street, zipCode, city } = splitBillingAddress(input.billing_address);
  return {
    playerName: input.full_name?.trim() || '',
    playerEmail: input.email?.trim() || '',
    playerBusinessName: input.billing_business_name?.trim() || '',
    playerBtwNumber: input.billing_btw_number?.trim() || '',
    playerStreet: street,
    playerZipCode: zipCode,
    playerCity: city,
  };
}

export function getAcademyCreateInvoiceUrl(playerRouteId: string): string {
  return `/app/academy/invoices/new?playerId=${encodeURIComponent(playerRouteId)}`;
}

export function getTrainerCreateInvoiceUrl(playerRouteId: string): string {
  return `/app/trainer/invoices/new?playerId=${encodeURIComponent(playerRouteId)}`;
}

/** Route id for trainer player detail / invoice prefill (`g_` / `p_`). */
export function toTrainerPlayerRouteId(player: {
  type: 'guest' | 'registered';
  id: string;
  guest_player_id?: string | null;
  profile_id?: string | null;
}): string {
  if (player.guest_player_id) return `g_${player.guest_player_id}`;
  if (player.profile_id) return `p_${player.profile_id}`;
  if (player.type === 'registered' && player.id.startsWith('reg-')) {
    return `p_${player.id.slice(4)}`;
  }
  if (player.type === 'guest') return `g_${player.id}`;
  return `p_${player.id}`;
}
