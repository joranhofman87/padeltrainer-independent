/**
 * WHO MAY CHANGE WHAT ON A TRAINER'S ACCOUNT — and, since OD-1, the answer for global identity is
 * "not a tenant manager, ever".
 *
 * A trainer has ONE login and ONE `profiles` row, and can work for several academies and clubs at
 * the same time. An earlier version of this module answered the narrower question "does this
 * manager manage every tenant the trainer belongs to?", and let an exclusive manager rotate the
 * login. The owner resolved that (OD-1, 2026-08-06) in the strict direction: identity is
 * self-service. A tenant manager manages membership, academy role and permissions; the trainer
 * owns their credentials and changes them from their own account. An academy may INITIATE an
 * invitation, an email-change confirmation or a password reset — flows that end with the trainer
 * acting. A platform-administrator recovery path exists and is audited.
 *
 * So the tenancy calculation is gone rather than left dead: a rule nobody consults is a rule that
 * quietly comes back. What remains is the field list, because the question "is this field part of
 * the shared identity?" is exactly what the endpoint still has to ask.
 */

/**
 * The fields that live on the ONE shared identity — the login and the `profiles` row every tenant
 * reads. Listed explicitly rather than derived, so adding a profile column is a decision about
 * whose it is rather than an accident.
 */
export const GLOBAL_IDENTITY_FIELDS = [
  "email", "full_name", "phone", "bio", "avatar_url",
  "skill_rating", "rating_system", "rating_member_id",
] as const;
