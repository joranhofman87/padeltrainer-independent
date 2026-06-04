-- Lisa Test: full row dump (read-only)
SELECT 'profiles' AS src, to_jsonb(p) AS row
FROM profiles p
WHERE user_id IN (
  '726ef4ee-972d-49c3-a6ea-6491dace69d0','bf418dca-36dd-4077-a391-dfabcb3c6209','4d9d9e84-ad2b-48b1-9028-cfc6bfa56f7f',
  '84585ae7-8ab0-4187-9ea9-6be79001bf88','7881939e-67fb-40e4-8ab3-ba316545a097'
)
UNION ALL
SELECT 'user_roles', to_jsonb(ur) FROM user_roles ur WHERE user_id IN (
  '726ef4ee-972d-49c3-a6ea-6491dace69d0','bf418dca-36dd-4077-a391-dfabcb3c6209','4d9d9e84-ad2b-48b1-9028-cfc6bfa56f7f',
  '84585ae7-8ab0-4187-9ea9-6be79001bf88','7881939e-67fb-40e4-8ab3-ba316545a097'
)
UNION ALL
SELECT 'trainer_profiles', to_jsonb(tp) FROM trainer_profiles tp WHERE user_id IN (
  '726ef4ee-972d-49c3-a6ea-6491dace69d0','bf418dca-36dd-4077-a391-dfabcb3c6209','4d9d9e84-ad2b-48b1-9028-cfc6bfa56f7f',
  '84585ae7-8ab0-4187-9ea9-6be79001bf88','7881939e-67fb-40e4-8ab3-ba316545a097'
)
UNION ALL
SELECT 'academy_profiles', to_jsonb(ap) FROM academy_profiles ap WHERE created_by IN (
  '726ef4ee-972d-49c3-a6ea-6491dace69d0','bf418dca-36dd-4077-a391-dfabcb3c6209','4d9d9e84-ad2b-48b1-9028-cfc6bfa56f7f',
  '84585ae7-8ab0-4187-9ea9-6be79001bf88','7881939e-67fb-40e4-8ab3-ba316545a097'
)
UNION ALL
SELECT 'club_profiles', to_jsonb(cp) FROM club_profiles cp WHERE created_by IN (
  '726ef4ee-972d-49c3-a6ea-6491dace69d0','bf418dca-36dd-4077-a391-dfabcb3c6209','4d9d9e84-ad2b-48b1-9028-cfc6bfa56f7f',
  '84585ae7-8ab0-4187-9ea9-6be79001bf88','7881939e-67fb-40e4-8ab3-ba316545a097'
)
UNION ALL
SELECT 'academy_managers', to_jsonb(am) FROM academy_managers am WHERE user_id IN (
  '726ef4ee-972d-49c3-a6ea-6491dace69d0','bf418dca-36dd-4077-a391-dfabcb3c6209','4d9d9e84-ad2b-48b1-9028-cfc6bfa56f7f',
  '84585ae7-8ab0-4187-9ea9-6be79001bf88','7881939e-67fb-40e4-8ab3-ba316545a097'
)
UNION ALL
SELECT 'auth.users', to_jsonb(u) FROM auth.users u WHERE email LIKE 'lisa-test-%@test.com';
