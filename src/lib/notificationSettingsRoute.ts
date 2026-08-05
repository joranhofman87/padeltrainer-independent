import type { UserRole } from '@/lib/auth';

/**
 * The ROLE-AGNOSTIC notification settings entry.
 *
 * Outbound email footers link HERE rather than to a role surface. A sender cannot know which
 * surface a recipient belongs to — an academy manager sent to the trainer path is bounced by
 * TrainerLayout to the player dashboard and the deep link is silently discarded — so the link
 * stays neutral and the app resolves it after login.
 *
 * Lives in lib, not next to the page, so email/footer code can cite the path without importing a
 * React page.
 */
export const NOTIFICATION_SETTINGS_ENTRY_PATH = '/app/settings/notifications';

/**
 * Where a given account's notification settings actually live, or `null` if it has none.
 *
 * Precedence is academy → trainer → player, matching the app's own convention: `isAcademyManager`
 * is a separate grant rather than an entry in `roles`, and Auth resolves it before role. For
 * someone holding several the destination is interchangeable anyway — the settings page treats
 * academy_manager and trainer as one staff bucket.
 */
export function notificationSettingsPathFor(input: {
  isAcademyManager: boolean;
  roles: readonly UserRole[];
}): string | null {
  if (input.isAcademyManager) return '/app/academy/settings/notifications';
  if (input.roles.includes('trainer')) return '/app/trainer/settings/notifications';
  // Admin is included deliberately: PlayerLayout admits it, and an admin-only account otherwise
  // has no notification surface at all.
  if (input.roles.includes('player') || input.roles.includes('admin')) {
    return '/app/player/settings/notifications';
  }
  // A club-only account has no notification settings surface anywhere. Forwarding it anyway would
  // hand it to a layout guard that bounces — and a redirect loop is a worse answer than a plain one.
  return null;
}
