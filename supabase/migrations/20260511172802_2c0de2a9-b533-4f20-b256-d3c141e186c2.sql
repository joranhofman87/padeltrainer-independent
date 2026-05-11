CREATE TABLE public.mollie_oauth_states (
  state TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('trainer','academy')),
  entity_id UUID NOT NULL,
  user_id UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '15 minutes'),
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.mollie_oauth_states ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_mollie_oauth_states_expires_at
  ON public.mollie_oauth_states (expires_at);