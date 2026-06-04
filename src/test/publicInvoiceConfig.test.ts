import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('supabase public invoice function config', () => {
  const config = readFileSync(resolve(process.cwd(), 'supabase/config.toml'), 'utf8');

  it('disables JWT verification for get-public-invoice', () => {
    expect(config).toMatch(/\[functions\.get-public-invoice\][\s\S]*?verify_jwt\s*=\s*false/);
  });

  it('disables JWT verification for create-invoice-payment', () => {
    expect(config).toMatch(/\[functions\.create-invoice-payment\][\s\S]*?verify_jwt\s*=\s*false/);
  });
});
