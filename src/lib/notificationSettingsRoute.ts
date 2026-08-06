/**
 * The ROLE-AGNOSTIC notification settings entry.
 *
 * Outbound email footers link HERE rather than to a role surface. A sender cannot know which
 * surface a recipient belongs to — an academy manager sent to the trainer path is bounced by
 * TrainerLayout to the player dashboard and the deep link is silently discarded — so the link
 * stays neutral and the app resolves it after login.
 *
 * The route RENDERS the settings page rather than forwarding to a role route; see
 * `src/pages/NotificationSettingsEntry.tsx` for why forwarding cannot work here.
 *
 * Lives in lib, not beside the page, so email/footer code can cite the path without importing a
 * React page.
 */
export const NOTIFICATION_SETTINGS_ENTRY_PATH = '/app/settings/notifications';
