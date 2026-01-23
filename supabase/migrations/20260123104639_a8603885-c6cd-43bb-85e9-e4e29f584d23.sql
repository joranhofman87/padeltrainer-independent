-- Create cycles table for training program cycles
CREATE TABLE public.cycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type TEXT NOT NULL CHECK (owner_type IN ('trainer', 'club')),
  owner_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  enrollment_deadline TIMESTAMPTZ,
  settings JSONB DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create intake_requests table for player applications
CREATE TABLE public.intake_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id UUID NOT NULL REFERENCES public.cycles(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES public.profiles(id),
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  rating NUMERIC,
  rating_system TEXT DEFAULT 'knltb',
  lesson_type TEXT NOT NULL CHECK (lesson_type IN ('private', 'duo', 'group', 'kids')),
  preferred_days TEXT[] NOT NULL,
  preferred_time_windows JSONB NOT NULL,
  preferred_duration_minutes INTEGER DEFAULT 60,
  preferred_trainer_id UUID REFERENCES public.trainer_profiles(id),
  location_id UUID REFERENCES public.locations(id),
  notes TEXT,
  consent_given BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'proposed', 'confirmed', 'rejected', 'waitlist')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(cycle_id, player_id)
);

-- Create proposed_assignments table for auto-generated scheduling proposals
CREATE TABLE public.proposed_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_request_id UUID NOT NULL REFERENCES public.intake_requests(id) ON DELETE CASCADE,
  slot_id UUID NOT NULL REFERENCES public.availability_slots(id) ON DELETE CASCADE,
  trainer_id UUID NOT NULL REFERENCES public.trainer_profiles(id),
  confidence_score INTEGER CHECK (confidence_score >= 0 AND confidence_score <= 100),
  rationale JSONB,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'confirmed', 'rejected', 'manual_override')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS on all new tables
ALTER TABLE public.cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intake_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proposed_assignments ENABLE ROW LEVEL SECURITY;

-- Cycles RLS policies
CREATE POLICY "Anyone can view open cycles"
  ON public.cycles FOR SELECT
  USING (status = 'open');

CREATE POLICY "Trainers can view their own cycles"
  ON public.cycles FOR SELECT
  USING (
    owner_type = 'trainer' AND 
    owner_id IN (SELECT id FROM trainer_profiles WHERE user_id = auth.uid())
  );

CREATE POLICY "Trainers can create their own cycles"
  ON public.cycles FOR INSERT
  WITH CHECK (
    owner_type = 'trainer' AND 
    owner_id IN (SELECT id FROM trainer_profiles WHERE user_id = auth.uid())
  );

CREATE POLICY "Trainers can update their own cycles"
  ON public.cycles FOR UPDATE
  USING (
    owner_type = 'trainer' AND 
    owner_id IN (SELECT id FROM trainer_profiles WHERE user_id = auth.uid())
  );

CREATE POLICY "Trainers can delete their own cycles"
  ON public.cycles FOR DELETE
  USING (
    owner_type = 'trainer' AND 
    owner_id IN (SELECT id FROM trainer_profiles WHERE user_id = auth.uid())
  );

CREATE POLICY "Club managers can view their club cycles"
  ON public.cycles FOR SELECT
  USING (
    owner_type = 'club' AND 
    owner_id IN (SELECT get_user_club_ids(auth.uid()))
  );

CREATE POLICY "Club managers can create club cycles"
  ON public.cycles FOR INSERT
  WITH CHECK (
    owner_type = 'club' AND 
    owner_id IN (SELECT get_user_club_ids(auth.uid()))
  );

CREATE POLICY "Club managers can update club cycles"
  ON public.cycles FOR UPDATE
  USING (
    owner_type = 'club' AND 
    owner_id IN (SELECT get_user_club_ids(auth.uid()))
  );

CREATE POLICY "Club managers can delete club cycles"
  ON public.cycles FOR DELETE
  USING (
    owner_type = 'club' AND 
    owner_id IN (SELECT get_user_club_ids(auth.uid()))
  );

-- Intake requests RLS policies
CREATE POLICY "Players can view their own intake requests"
  ON public.intake_requests FOR SELECT
  USING (player_id IN (SELECT id FROM profiles WHERE user_id = auth.uid()));

CREATE POLICY "Players can create intake requests"
  ON public.intake_requests FOR INSERT
  WITH CHECK (player_id IN (SELECT id FROM profiles WHERE user_id = auth.uid()));

CREATE POLICY "Players can update their own pending intake requests"
  ON public.intake_requests FOR UPDATE
  USING (
    player_id IN (SELECT id FROM profiles WHERE user_id = auth.uid()) AND
    status = 'new'
  );

CREATE POLICY "Trainers can view intake requests for their cycles"
  ON public.intake_requests FOR SELECT
  USING (
    cycle_id IN (
      SELECT id FROM cycles 
      WHERE owner_type = 'trainer' 
      AND owner_id IN (SELECT id FROM trainer_profiles WHERE user_id = auth.uid())
    )
  );

CREATE POLICY "Trainers can update intake requests for their cycles"
  ON public.intake_requests FOR UPDATE
  USING (
    cycle_id IN (
      SELECT id FROM cycles 
      WHERE owner_type = 'trainer' 
      AND owner_id IN (SELECT id FROM trainer_profiles WHERE user_id = auth.uid())
    )
  );

CREATE POLICY "Club managers can view intake requests for club cycles"
  ON public.intake_requests FOR SELECT
  USING (
    cycle_id IN (
      SELECT id FROM cycles 
      WHERE owner_type = 'club' 
      AND owner_id IN (SELECT get_user_club_ids(auth.uid()))
    )
  );

CREATE POLICY "Club managers can update intake requests for club cycles"
  ON public.intake_requests FOR UPDATE
  USING (
    cycle_id IN (
      SELECT id FROM cycles 
      WHERE owner_type = 'club' 
      AND owner_id IN (SELECT get_user_club_ids(auth.uid()))
    )
  );

-- Proposed assignments RLS policies
CREATE POLICY "Trainers can view proposals for their cycles"
  ON public.proposed_assignments FOR SELECT
  USING (
    intake_request_id IN (
      SELECT ir.id FROM intake_requests ir
      JOIN cycles c ON ir.cycle_id = c.id
      WHERE c.owner_type = 'trainer' 
      AND c.owner_id IN (SELECT id FROM trainer_profiles WHERE user_id = auth.uid())
    )
  );

CREATE POLICY "Trainers can manage proposals for their cycles"
  ON public.proposed_assignments FOR ALL
  USING (
    intake_request_id IN (
      SELECT ir.id FROM intake_requests ir
      JOIN cycles c ON ir.cycle_id = c.id
      WHERE c.owner_type = 'trainer' 
      AND c.owner_id IN (SELECT id FROM trainer_profiles WHERE user_id = auth.uid())
    )
  );

CREATE POLICY "Club managers can view proposals for club cycles"
  ON public.proposed_assignments FOR SELECT
  USING (
    intake_request_id IN (
      SELECT ir.id FROM intake_requests ir
      JOIN cycles c ON ir.cycle_id = c.id
      WHERE c.owner_type = 'club' 
      AND c.owner_id IN (SELECT get_user_club_ids(auth.uid()))
    )
  );

CREATE POLICY "Club managers can manage proposals for club cycles"
  ON public.proposed_assignments FOR ALL
  USING (
    intake_request_id IN (
      SELECT ir.id FROM intake_requests ir
      JOIN cycles c ON ir.cycle_id = c.id
      WHERE c.owner_type = 'club' 
      AND c.owner_id IN (SELECT get_user_club_ids(auth.uid()))
    )
  );

CREATE POLICY "Players can view their confirmed proposals"
  ON public.proposed_assignments FOR SELECT
  USING (
    status = 'confirmed' AND
    intake_request_id IN (
      SELECT id FROM intake_requests 
      WHERE player_id IN (SELECT id FROM profiles WHERE user_id = auth.uid())
    )
  );

-- Create updated_at triggers
CREATE TRIGGER update_cycles_updated_at
  BEFORE UPDATE ON public.cycles
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_intake_requests_updated_at
  BEFORE UPDATE ON public.intake_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_proposed_assignments_updated_at
  BEFORE UPDATE ON public.proposed_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Create indexes for performance
CREATE INDEX idx_cycles_owner ON public.cycles(owner_type, owner_id);
CREATE INDEX idx_cycles_status ON public.cycles(status);
CREATE INDEX idx_intake_requests_cycle ON public.intake_requests(cycle_id);
CREATE INDEX idx_intake_requests_player ON public.intake_requests(player_id);
CREATE INDEX idx_intake_requests_status ON public.intake_requests(status);
CREATE INDEX idx_proposed_assignments_intake ON public.proposed_assignments(intake_request_id);
CREATE INDEX idx_proposed_assignments_slot ON public.proposed_assignments(slot_id);