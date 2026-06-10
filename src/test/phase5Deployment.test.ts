import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

describe('Phase 5 deployment configuration', () => {
  it('documents local dev port 8080', () => {
    const vite = read('vite.config.ts');
    const example = read('.env.example');
    expect(vite).toContain('port: 8080');
    expect(example).toContain('localhost:8080');
  });

  it('vercel.json defines cron routes and security headers', () => {
    const vercel = read('vercel.json');
    expect(vercel).toContain('/api/cron/hourly-maintenance');
    expect(vercel).toContain('/api/cron/daily-maintenance');
    expect(vercel).toContain('X-Frame-Options');
  });

  it('cron API verifies CRON_SECRET', () => {
    const cron = read('api/_lib/cron.ts');
    expect(cron).toContain('CRON_SECRET');
    expect(cron).toContain('verifyCronSecret');
    expect(cron).not.toContain('VITE_');
  });

  it('resend-send uses bounded retries', () => {
    const source = read('supabase/functions/_shared/resend-send.ts');
    expect(source).toContain('RESEND_MAX_ATTEMPTS = 3');
    expect(source).toContain('RESEND_BASE_DELAY_MS');
  });

  it('migration adds atomic onboarding email claim', () => {
    const sql = read('supabase/migrations/20260606120000_phase5_email_idempotency_and_cron_ficwb.sql');
    expect(sql).toContain('claim_onboarding_email_queue_item');
    expect(sql).toContain('idx_onboarding_email_logs_queue_sent_unique');
    expect(sql).toContain('ficwbdrzefmblkbkomzw');
  });

  it('send-auth-email uses /app/auth and /app/reset-password defaults', () => {
    const source = read('supabase/functions/send-auth-email/index.ts');
    expect(source).toContain('/app/auth');
    expect(source).toContain('/app/reset-password');
    expect(source).toContain('sendResendEmail');
  });
});
