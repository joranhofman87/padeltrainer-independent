UPDATE academy_mollie_accounts
SET charges_enabled = true, payouts_enabled = true, onboarding_complete = true
WHERE mollie_organization_id = 'org_19475084';