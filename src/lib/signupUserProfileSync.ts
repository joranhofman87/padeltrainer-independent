/** Profile name fields written by signup-user (no timezone — lives on trainer_profiles only). */
export function buildProfileNamePatch(args: {
  firstName: string;
  lastName: string | null;
  fullName: string;
  phone?: string;
  language?: string;
  stripeCustomerId?: string | null;
}): Record<string, string | null> {
  const patch: Record<string, string | null> = {
    first_name: args.firstName,
    last_name: args.lastName,
    full_name: args.fullName,
  };
  if (args.phone) patch.phone = args.phone;
  if (args.language) patch.preferred_language = args.language;
  if (args.stripeCustomerId) patch.stripe_customer_id = args.stripeCustomerId;
  return patch;
}
