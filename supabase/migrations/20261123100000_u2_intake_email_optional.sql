-- U2 — an applicant without an email address.
--
-- `intake_requests.email` has been NOT NULL since the table only ever received public form
-- submissions, where an address is genuinely required (it is where the confirmation goes). Staff
-- adding an applicant by hand are in a different situation: children, walk-ins and people who
-- decline to give an address are ordinary players, and the column made them unrepresentable.
--
-- That is not a cosmetic limit. It is one of the reasons placeholder addresses exist in this data —
-- and a placeholder address is indistinguishable, to every matcher downstream, from a household
-- address two real people share. The NOT NULL was manufacturing exactly the ambiguity U2 exists to
-- stop resolving by guesswork.
--
-- RELAXING ONLY. No existing row changes, no reader that already had an address loses it, and the
-- public endpoint still requires one (`submit-guest-intake` rejects a submission without it, and its
-- duplicate-suppression window is keyed on the address).

ALTER TABLE public.intake_requests ALTER COLUMN email DROP NOT NULL;

COMMENT ON COLUMN public.intake_requests.email IS
  'Applicant address. NULL is allowed since U2: a manually added applicant may not have one, and inventing a placeholder is worse than recording the absence. Public submissions still require it.';
