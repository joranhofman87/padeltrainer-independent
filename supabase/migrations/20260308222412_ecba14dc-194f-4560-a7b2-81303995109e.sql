ALTER TABLE public.cycles DROP CONSTRAINT cycles_type_check;
ALTER TABLE public.cycles ADD CONSTRAINT cycles_type_check CHECK (type = ANY (ARRAY['registration'::text, 'cyclus'::text, 'event'::text]));