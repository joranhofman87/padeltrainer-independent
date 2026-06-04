import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const MIGRATION_FILE = '20260531100000_player_app_security_hardening.sql';

function readMigration(): string {
  const path = join(process.cwd(), 'supabase', 'migrations', MIGRATION_FILE);
  expect(existsSync(path), `migration file missing: ${path}`).toBe(true);
  return readFileSync(path, 'utf8');
}

describe('player app security hardening migration', () => {
  it('enables RLS on session_reports with scoped player and trainer policies', () => {
    const sql = readMigration();
    expect(sql).toContain('ALTER TABLE public.session_reports ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('Players can view session reports for their bookings');
    expect(sql).toContain('get_profile_id_for_user(auth.uid())');
    expect(sql).toContain("session_reports.reporter_role = 'trainer'");
    expect(sql).toContain('Players can insert their own session reports');
    expect(sql).toContain("session_reports.reporter_role = 'player'");
    expect(sql).toContain('Trainers can view session reports on their slots');
    expect(sql).toContain('Academy managers can view session reports on academy slots');
    expect(sql).toContain('Admins can manage all session reports');
  });

  it('hardens trainer_followers player update/delete to get_profile_id_for_user with WITH CHECK', () => {
    const sql = readMigration();
    expect(sql).toContain('Players can update their own follows');
    expect(sql).toMatch(
      /Players can update their own follows[\s\S]*WITH CHECK \(player_id = public\.get_profile_id_for_user\(auth\.uid\(\)\)\)/
    );
    expect(sql).toContain('Players can delete their own follows');
    expect(sql).toMatch(
      /Players can delete their own follows[\s\S]*USING \(player_id = public\.get_profile_id_for_user\(auth\.uid\(\)\)\)/
    );
  });

  it('adds WITH CHECK on notification_preferences update', () => {
    const sql = readMigration();
    expect(sql).toContain('Users can update their own preferences');
    expect(sql).toMatch(
      /Users can update their own preferences[\s\S]*WITH CHECK \(auth\.uid\(\) = user_id\)/
    );
  });
});
