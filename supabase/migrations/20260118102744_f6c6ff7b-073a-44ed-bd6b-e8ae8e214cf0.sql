-- Add business fields to trainer_profiles for invoice generation
ALTER TABLE public.trainer_profiles 
ADD COLUMN IF NOT EXISTS business_name text,
ADD COLUMN IF NOT EXISTS business_address text,
ADD COLUMN IF NOT EXISTS kvk_number text,
ADD COLUMN IF NOT EXISTS btw_number text,
ADD COLUMN IF NOT EXISTS iban text,
ADD COLUMN IF NOT EXISTS bic text,
ADD COLUMN IF NOT EXISTS payment_terms_days integer DEFAULT 14,
ADD COLUMN IF NOT EXISTS use_manual_invoicing boolean DEFAULT false;

-- Create invoices table for manual invoice management
CREATE TABLE public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_id uuid NOT NULL REFERENCES public.trainer_profiles(id) ON DELETE CASCADE,
  invoice_number text NOT NULL,
  invoice_date date NOT NULL DEFAULT CURRENT_DATE,
  due_date date NOT NULL,
  player_id uuid REFERENCES public.profiles(id),
  guest_player_id uuid REFERENCES public.guest_players(id),
  player_name text NOT NULL,
  player_address text,
  player_btw_number text,
  line_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal numeric NOT NULL DEFAULT 0,
  vat_rate numeric NOT NULL DEFAULT 21,
  vat_amount numeric NOT NULL DEFAULT 0,
  total numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft',
  pdf_url text,
  booking_ids uuid[] DEFAULT '{}',
  notes text,
  sent_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoices_status_check CHECK (status IN ('draft', 'sent', 'paid', 'cancelled', 'overdue')),
  CONSTRAINT unique_invoice_number_per_trainer UNIQUE (trainer_id, invoice_number)
);

-- Enable RLS on invoices
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

-- RLS policies for invoices
CREATE POLICY "Trainers can view their own invoices"
ON public.invoices FOR SELECT
USING (trainer_id IN (
  SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()
));

CREATE POLICY "Trainers can create their own invoices"
ON public.invoices FOR INSERT
WITH CHECK (trainer_id IN (
  SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()
));

CREATE POLICY "Trainers can update their own invoices"
ON public.invoices FOR UPDATE
USING (trainer_id IN (
  SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()
));

CREATE POLICY "Trainers can delete their own draft invoices"
ON public.invoices FOR DELETE
USING (
  trainer_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid())
  AND status = 'draft'
);

-- Create updated_at trigger for invoices
CREATE TRIGGER update_invoices_updated_at
BEFORE UPDATE ON public.invoices
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Create invoices storage bucket
INSERT INTO storage.buckets (id, name, public) 
VALUES ('invoices', 'invoices', false)
ON CONFLICT (id) DO NOTHING;

-- Storage policies for invoices bucket
CREATE POLICY "Trainers can upload their own invoices"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'invoices' 
  AND auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "Trainers can view their own invoices"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'invoices' 
  AND auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "Trainers can update their own invoices"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'invoices' 
  AND auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "Trainers can delete their own invoices"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'invoices' 
  AND auth.uid()::text = (storage.foldername(name))[1]
);