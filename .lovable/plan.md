

# Show Academy Connections Without Active Subscription

Allow academy-location connections to be visible on location pages regardless of subscription status, while restricting full profile access and editing capabilities to subscribed academies.

---

## Current Behavior

| Feature | Current State |
|---------|---------------|
| Academy on location page | Shows only if `is_public: true` (working for Dutch Padel School) |
| Academy public profile | Requires `is_verified: true` (blocking access) |
| Academy dashboard editing | Blocked by SubscriptionOverlay if trial expired |

---

## Identified Issue

The `getAcademyBySlug` function in `src/lib/academy.ts` filters for `is_verified: true` on line 216. This means:
- Dutch Padel School appears on location pages (via `getAcademiesAtLocation`)
- But clicking on the academy leads to a 404 because their own profile page requires verification

---

## Proposed Changes

### 1. Show Academy Profile Without is_verified Requirement

Update `getAcademyBySlug` to allow unverified but public academies to be visible. The verified checkmark will still only show for verified academies.

```text
Current: .eq('is_verified', true)
New: Remove this filter - rely only on is_public: true from the view
```

### 2. Add Subscription Status Awareness to Profile Page

On the academy public profile page (`AcademyPublicProfile.tsx`), display a notice or limited view for academies without an active subscription:
- Still show the academy card, name, logo, locations
- Hide contact buttons or booking options if trial expired
- Optionally show "Coming soon" or "Not yet active" badge

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/lib/academy.ts` | Remove `is_verified` filter from `getAcademyBySlug` |
| `src/pages/AcademyPublicProfile.tsx` | Add subscription-aware UI (optional) |

---

## Visibility Rules After Change

| Academy State | Location Page | Academy Profile | Editing |
|---------------|---------------|-----------------|---------|
| Trial (active, is_public) | Visible | Accessible | Allowed |
| Trial expired, is_public | Visible | Accessible (limited) | Blocked |
| is_public: false | Hidden | Hidden | N/A |
| Subscribed + is_public | Visible + Featured | Full access | Allowed |

---

## Verification Badge Logic

The verified checkmark on academy cards will continue to show only when:
- `is_verified: true` (manually verified by admin), OR
- `subscription_status: 'active'` (paid subscription)

This is already handled in the existing memory: "The verified checkmark is displayed on an academy profile if it is either manually verified by an administrator or has an 'active' paid subscription status."

---

## Implementation

This is a minimal change - simply removing one filter line in `getAcademyBySlug`. The `is_public` check in the view already provides the necessary visibility control.

