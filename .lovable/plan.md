

# Clean Up: Delete 6 Orphaned Onboarding Email Records

## What
Delete 6 orphaned records left behind by previously deleted test accounts. These are the only legacy records in the entire database.

## Records to delete
- **3 rows** from `onboarding_email_queue` (IDs: `596187af...`, `00cf8959...`, `24e92324...`)
- **3 rows** from `onboarding_email_logs` (IDs: `d72525f2...`, `d903f366...`, `73cbe8cd...`)

All have `status: sent` and belong to deleted users — no functional impact.

## How
Use the database insert tool to run two `DELETE` statements filtering by the 3 orphaned `user_id` values:
- `2d176d26-aac0-4df1-a4e3-9a3f218f14f8`
- `855883a7-a0ce-4e5d-9344-45d501b8e5d4`
- `33d4bf56-d5a4-41fc-9241-31140f80d9be`

No code or schema changes needed.

