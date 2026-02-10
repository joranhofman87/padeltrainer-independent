
ALTER TABLE public.trainer_profiles ADD COLUMN waiting_list_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.academy_profiles ADD COLUMN waiting_list_enabled boolean NOT NULL DEFAULT false;
