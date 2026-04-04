

# Fix: Academy managers can't upload trainer avatars (RLS violation)

## Root cause
The `avatars` storage bucket and the `profiles` table have RLS policies for **club managers** to upload/update trainer avatars, but no equivalent policies exist for **academy managers**. When an academy manager tries to upload a photo for one of their trainers, both the storage upload and the profiles update are blocked.

## Changes

### 1. Storage RLS — allow academy managers to upload/update trainer avatars (SQL migration)
Two new storage policies on `storage.objects`:
- **INSERT** policy: academy managers can upload to folders matching their trainers' `user_id`
- **UPDATE** policy: academy managers can update (upsert) those same files

The lookup joins `academy_trainers` → `trainer_profiles` to get the trainer's `user_id`, filtered by `get_user_academy_ids(auth.uid())` and `status = 'active'`.

### 2. Profiles RLS — allow academy managers to update trainer profiles (SQL migration)
One new UPDATE policy on `public.profiles` so the `avatar_url` column update succeeds. Same join pattern as above.

### SQL

```sql
-- Academy managers can upload avatars for their trainers
CREATE POLICY "Academy managers can upload trainer avatars"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'avatars' AND
    (storage.foldername(name))[1] IN (
      SELECT tp.user_id::text
      FROM trainer_profiles tp
      JOIN academy_trainers at ON at.trainer_profile_id = tp.id
      WHERE at.status = 'active'
        AND at.academy_profile_id IN (SELECT get_user_academy_ids(auth.uid()))
    )
  );

CREATE POLICY "Academy managers can update trainer avatars"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'avatars' AND
    (storage.foldername(name))[1] IN (
      SELECT tp.user_id::text
      FROM trainer_profiles tp
      JOIN academy_trainers at ON at.trainer_profile_id = tp.id
      WHERE at.status = 'active'
        AND at.academy_profile_id IN (SELECT get_user_academy_ids(auth.uid()))
    )
  );

-- Academy managers can update profiles for their trainers
CREATE POLICY "Academy managers can update profiles for academy trainers"
  ON public.profiles FOR UPDATE TO authenticated
  USING (
    user_id IN (
      SELECT tp.user_id
      FROM trainer_profiles tp
      JOIN academy_trainers at ON at.trainer_profile_id = tp.id
      WHERE at.status = 'active'
        AND at.academy_profile_id IN (SELECT get_user_academy_ids(auth.uid()))
    )
  );
```

No code changes needed — the upload logic in `EditAcademyTrainerDialog.tsx` is already correct, it just needs the database to allow the operations.

| What | Change |
|------|--------|
| SQL migration | Add 3 RLS policies (2 storage, 1 profiles) for academy managers |

