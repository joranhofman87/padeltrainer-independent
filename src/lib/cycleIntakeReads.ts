// Intake-request READ functions, extracted from lib/cycles.ts (god-file split). One-way: these
// use only the shared mappers + supabase, never other cycles.ts internals, so cycles.ts re-exports
// them via `export *` and importers are unchanged.
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { format } from 'date-fns';
import { toIntakeRequest } from './cycleMappers';
import type { IntakeRequest, IntakeRequestWithProposal } from './cycleTypes';

export async function getIntakeRequests(cycleId: string): Promise<IntakeRequest[]> {
  const { data, error } = await supabase
    .from('intake_requests')
    .select('*')
    .eq('cycle_id', cycleId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return (data || []).map(toIntakeRequest);
}

export async function getIntakeRequestsByOwner(
  ownerType: 'trainer' | 'club' | 'academy',
  ownerId: string,
  status?: string
): Promise<IntakeRequest[]> {
  // First get cycles for this owner
  const cyclesQuery = supabase
    .from('cycles')
    .select('id')
    .eq('owner_type', ownerType)
    .eq('owner_id', ownerId);

  const { data: cycles, error: cyclesError } = await cyclesQuery;
  if (cyclesError) throw cyclesError;
  
  if (!cycles || cycles.length === 0) return [];

  const cycleIds = cycles.map(c => c.id);

  let query = supabase
    .from('intake_requests')
    .select('*')
    .in('cycle_id', cycleIds)
    .order('created_at', { ascending: true });

  if (status) {
    query = query.eq('status', status);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(toIntakeRequest);
}

// Fetch intake requests with their proposal details bundled
export async function getIntakeRequestsWithProposals(
  ownerType: 'trainer' | 'club' | 'academy',
  ownerId: string
): Promise<IntakeRequestWithProposal[]> {
  // First get all requests
  const requests = await getIntakeRequestsByOwner(ownerType, ownerId);
  if (requests.length === 0) return [];

  const requestIds = requests.map(r => r.id);

  // Payment status per request: registration/event cycles mint an invoice, so surface
  // paid/unpaid in the table. Read invoice_id straight off the rows (select('*')), then
  // resolve each invoice's status in one query.
  const { data: payRows } = await supabase
    .from('intake_requests')
    .select('id, invoice_id, payment_method')
    .in('id', requestIds);
  const invoiceIds = [...new Set((payRows || []).map(p => p.invoice_id).filter((x): x is string => !!x))];
  const invoiceStatusById = new Map<string, string>();
  if (invoiceIds.length > 0) {
    const { data: invs } = await supabase.from('invoices').select('id, status').in('id', invoiceIds);
    invs?.forEach(i => invoiceStatusById.set(i.id, i.status as string));
  }
  const payByReq = new Map<string, { invoice_id: string | null; payment_method: string | null; invoice_status: string | null }>();
  (payRows || []).forEach(p => payByReq.set(p.id, {
    invoice_id: p.invoice_id ?? null,
    payment_method: p.payment_method ?? null,
    invoice_status: p.invoice_id ? (invoiceStatusById.get(p.invoice_id) ?? null) : null,
  }));

  // Fetch all proposals for these requests with slot info (no nested profile join)
  const { data: proposals, error } = await supabase
    .from('proposed_assignments')
    .select(`
      *,
      slot:availability_slots(id, start_time, end_time)
    `)
    .in('intake_request_id', requestIds);

  if (error) {
    logger.warn('Error fetching proposals', { error });
    return requests; // Return requests without proposals on error
  }

  // Resolve trainer names via separate queries (no FK from trainer_profiles to profiles)
  const trainerIds = [...new Set((proposals || []).map(p => p.trainer_id).filter(Boolean))];
  const trainerProfileMap = new Map<string, { full_name: string; avatar_url: string | null }>();

  if (trainerIds.length > 0) {
    const { data: trainerProfiles } = await supabase
      .from('trainer_profiles')
      .select('id, user_id')
      .in('id', trainerIds);

    if (trainerProfiles && trainerProfiles.length > 0) {
      const userIds = trainerProfiles.map(tp => tp.user_id);
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, full_name, avatar_url')
        .in('user_id', userIds);

      trainerProfiles.forEach(tp => {
        const profile = profiles?.find(p => p.user_id === tp.user_id);
        if (profile) {
          trainerProfileMap.set(tp.id, {
            full_name: profile.full_name || 'Unknown',
            avatar_url: profile.avatar_url,
          });
        }
      });
    }
  }

  // Group proposals by slot_id to find group members
  const slotGroups = new Map<string, { requestId: string; name: string }[]>();
  proposals?.forEach(p => {
    const existing = slotGroups.get(p.slot_id) || [];
    const reqName = requests.find(r => r.id === p.intake_request_id)?.full_name;
    if (reqName) {
      existing.push({ requestId: p.intake_request_id, name: reqName });
    }
    slotGroups.set(p.slot_id, existing);
  });

  // Merge proposals into requests
  return requests.map(req => {
    const pay = payByReq.get(req.id) || { invoice_id: null, payment_method: null, invoice_status: null };
    const proposal = proposals?.find(p => p.intake_request_id === req.id);
    if (!proposal || !proposal.slot) return { ...req, ...pay };

    const groupMembers = slotGroups.get(proposal.slot_id)
      ?.filter(m => m.requestId !== req.id)
      ?.map(m => m.name) || [];

    const trainerInfo = trainerProfileMap.get(proposal.trainer_id);

    return {
      ...req,
      ...pay,
      proposal: {
        slot_day: format(new Date(proposal.slot.start_time), 'EEEE'),
        slot_time: `${format(new Date(proposal.slot.start_time), 'HH:mm')} - ${format(new Date(proposal.slot.end_time), 'HH:mm')}`,
        slot_date: format(new Date(proposal.slot.start_time), 'MMM d'),
        slot_start: proposal.slot.start_time,
        slot_end: proposal.slot.end_time,
        trainer_id: proposal.trainer_id,
        trainer_name: trainerInfo?.full_name || 'Unknown',
        trainer_avatar: trainerInfo?.avatar_url || null,
        confidence_score: proposal.confidence_score || 0,
        group_members: groupMembers,
      },
    };
  });
}

export async function getPlayerIntakeRequests(playerId: string): Promise<IntakeRequest[]> {
  const { data, error } = await supabase
    .from('intake_requests')
    .select('*')
    .eq('player_id', playerId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data || []).map(toIntakeRequest);
}

export async function getIntakeRequest(requestId: string): Promise<IntakeRequest | null> {
  const { data, error } = await supabase
    .from('intake_requests')
    .select('*')
    .eq('id', requestId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw error;
  }
  return toIntakeRequest(data);
}
