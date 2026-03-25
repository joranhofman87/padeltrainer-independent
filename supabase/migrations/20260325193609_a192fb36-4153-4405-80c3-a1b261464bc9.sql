-- Fix INV-2026-0054: remove deleted booking, update to 16 sessions
UPDATE invoices
SET 
  booking_ids = array_remove(booking_ids, '716961ff-0d06-43c6-89e4-0d1b11933444'),
  line_items = '[{"description":"Maandag 20:00 - Joran, Nick (16 weken) (1/2)","quantity":16,"unit_price":46.25},{"description":"Baanhuur PAZ avond (per sessie) (1/2)","quantity":16,"unit_price":18,"vat_rate":0}]'::jsonb,
  subtotal = 966.90,
  vat_amount = 61.10,
  total = 1028.00,
  vat_breakdown = '{"0":{"subtotal":288,"vat":0},"9":{"subtotal":678.90,"vat":61.10}}'::jsonb,
  pdf_url = null
WHERE id = '9de091d7-b4cf-4e6e-9aef-3f9eb072d0e1';

-- Fix INV-2026-0055: remove deleted booking, update to 16 sessions
UPDATE invoices
SET 
  booking_ids = array_remove(booking_ids, '476c63f2-6d87-4f5c-96dc-0b3994ab1172'),
  line_items = '[{"description":"Maandag 20:00 - Joran, Nick (16 weken) (1/2)","quantity":16,"unit_price":46.25},{"description":"Baanhuur PAZ avond (per sessie) (1/2)","quantity":16,"unit_price":18,"vat_rate":0}]'::jsonb,
  subtotal = 966.90,
  vat_amount = 61.10,
  total = 1028.00,
  vat_breakdown = '{"0":{"subtotal":288,"vat":0},"9":{"subtotal":678.90,"vat":61.10}}'::jsonb,
  pdf_url = null
WHERE id = 'a433f771-a133-45db-9715-073072969f15';