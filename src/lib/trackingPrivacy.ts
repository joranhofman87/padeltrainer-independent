export type TrackingPropertyValue = string | number | boolean | null;
export type TrackingProperties = Record<string, TrackingPropertyValue>;

const SAFE_ANALYTICS_QUERY_KEYS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'source',
  'role',
  'method',
  'plan',
  'billing_cycle',
  'result',
  'country',
  'level',
  'style',
  'budget',
  'arm',
  'weight',
  'shape',
]);

const SENSITIVE_QUERY_KEYS = new Set([
  'email',
  'mail',
  'name',
  'first_name',
  'last_name',
  'full_name',
  'phone',
  'redirect',
  'token',
  'invoice',
  'invoice_id',
  'booking_id',
]);

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const EMAIL_GLOBAL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function toSnakeish(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s.-]+/g, '_')
    .toLowerCase();
}

export function buildPersonTrackingId(personUid: string): string {
  return personUid.startsWith('person:') ? personUid : `person:${personUid}`;
}

export function buildPseudonymousTrackingEmail(personUid: string): string {
  const safeUid = buildPersonTrackingId(personUid).replace(/[^a-z0-9._-]/gi, '-');
  return `${safeUid}@uid.padeltrainer.invalid`;
}

export function isSensitiveTrackingKey(key: string): boolean {
  const normalized = toSnakeish(key);

  if (
    normalized === 'email'
    || normalized === 'mail'
    || normalized === 'email_address'
    || normalized === 'name'
    || normalized === 'first_name'
    || normalized === 'last_name'
    || normalized === 'full_name'
    || normalized === 'player_name'
    || normalized === 'trainer_name'
    || normalized === 'academy_name'
    || normalized === 'business_name'
    || normalized === 'contact_name'
    || normalized === 'user_name'
    || normalized === 'username'
    || normalized === 'user_id'
    || normalized === 'auth_user_id'
    || normalized === 'slug'
    || normalized.endsWith('_slug')
  ) {
    return true;
  }

  return /(^|_)(phone|address|street|postal|postcode|zip|btw|vat|iban|billing|token|secret|password|pdf|url)($|_)/.test(normalized);
}

export function redactTrackingString(value: string): string {
  return value
    .replace(EMAIL_GLOBAL_RE, '[redacted-email]')
    .replace(/(\/pay\/)[^\s/?#]+/g, '$1:token')
    .replace(/([?&](?:token|email|name|redirect)=)[^&#\s]+/gi, '$1[redacted]');
}

export function sanitizeTrackingProperties(
  properties?: Record<string, unknown>,
): TrackingProperties | undefined {
  if (!properties) return undefined;

  const sanitized: TrackingProperties = {};

  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined || isSensitiveTrackingKey(key)) continue;

    if (typeof value === 'string') {
      const redacted = redactTrackingString(value).trim();
      if (redacted.length === 0) continue;
      sanitized[key] = redacted.length > 160 ? `${redacted.slice(0, 157)}...` : redacted;
      continue;
    }

    if (typeof value === 'number') {
      if (Number.isFinite(value)) sanitized[key] = value;
      continue;
    }

    if (typeof value === 'boolean' || value === null) {
      sanitized[key] = value as boolean | null;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function normalizeSearch(search: string): string {
  return search.startsWith('?') ? search.slice(1) : search;
}

function sanitizeQueryValue(value: string): string | null {
  const redacted = redactTrackingString(value).trim();
  if (!redacted || redacted.includes('[redacted-')) return null;
  if (!/^[a-z0-9._~:-]+$/i.test(redacted)) return null;
  return redacted.length > 80 ? redacted.slice(0, 80) : redacted;
}

export function sanitizeAnalyticsSearch(search = ''): string {
  const params = new URLSearchParams(normalizeSearch(search));
  const sanitized = new URLSearchParams();

  for (const [key, value] of params.entries()) {
    const normalizedKey = key.toLowerCase();
    if (!SAFE_ANALYTICS_QUERY_KEYS.has(normalizedKey)) continue;

    const sanitizedValue = sanitizeQueryValue(value);
    if (sanitizedValue) sanitized.append(normalizedKey, sanitizedValue);
  }

  const result = sanitized.toString();
  return result ? `?${result}` : '';
}

export function hasSensitiveAnalyticsSearch(search = ''): boolean {
  const params = new URLSearchParams(normalizeSearch(search));

  for (const [key, value] of params.entries()) {
    const normalizedKey = key.toLowerCase();
    if (SENSITIVE_QUERY_KEYS.has(normalizedKey)) return true;
    if (!SAFE_ANALYTICS_QUERY_KEYS.has(normalizedKey)) return true;
    if (EMAIL_RE.test(value)) return true;
    if (!sanitizeQueryValue(value)) return true;
  }

  return false;
}

export function isSensitiveAnalyticsPath(pathname: string, search = ''): boolean {
  return /^\/pay\/[^/]+/.test(pathname)
    || /^\/booking\/[^/]+/.test(pathname)
    || /^\/academies\/[^/]+\/pay\/[^/]+/.test(pathname)
    || hasSensitiveAnalyticsSearch(search);
}
