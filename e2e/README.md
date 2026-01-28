# E2E Tests

This directory contains comprehensive end-to-end tests for the PadelTrainer application using Playwright.

## Test Structure

```
e2e/
├── fixtures/
│   ├── test-data.ts      # Test constants and mock data
│   └── helpers.ts        # Reusable test utilities
├── auth.spec.ts          # Authentication flows (login, signup, password reset)
├── navigation.spec.ts    # Marketing pages and navigation
├── booking.spec.ts       # Booking and slot selection flows
├── dashboard.spec.ts     # Protected dashboard routes
├── roles.spec.ts         # Role-specific flows (player, trainer, club, academy)
├── i18n.spec.ts          # Internationalization tests
├── accessibility.spec.ts # A11y compliance tests
├── error-handling.spec.ts# Error states and edge cases
└── performance.spec.ts   # Performance and load time tests
```

## Running Tests

```bash
# Run all E2E tests
npx playwright test

# Run specific test file
npx playwright test e2e/auth.spec.ts

# Run tests in headed mode (see browser)
npx playwright test --headed

# Run tests with UI mode
npx playwright test --ui

# Run tests in debug mode
npx playwright test --debug

# Generate HTML report
npx playwright test --reporter=html
```

## Test Categories

### Authentication (`auth.spec.ts`)
- Login form validation
- Signup flows (player, trainer)
- Password reset flow
- OAuth buttons presence
- Form validation

### Navigation (`navigation.spec.ts`)
- Home page hero and CTAs
- Trainers listing page
- Locations listing page
- Pricing page
- Footer and legal links
- Responsive navigation

### Booking (`booking.spec.ts`)
- Trainer profile view
- Available slots display
- Booking flow initiation
- Location detail pages
- Cycle registration

### Dashboard (`dashboard.spec.ts`)
- Protected route redirects
- Role-based access control
- Onboarding routes

### Roles (`roles.spec.ts`)
- Academy-specific flows
- Club-specific flows
- Trainer dashboard routes
- Player dashboard routes
- Invitation token handling

### i18n (`i18n.spec.ts`)
- English route variations
- Dutch route variations
- Language switching
- SEO metadata per language
- App routes (no prefix)

### Accessibility (`accessibility.spec.ts`)
- Keyboard navigation
- Focus indicators
- ARIA labels
- Heading structure
- Image alt attributes
- Responsive design

### Error Handling (`error-handling.spec.ts`)
- 404 page display
- Invalid resource handling
- Form validation errors
- Console error detection

### Performance (`performance.spec.ts`)
- Page load times
- Network request count
- Bundle size indicators
- Core Web Vitals proxies

## Writing New Tests

1. Import the test fixture:
```typescript
import { test, expect } from '../playwright-fixture';
```

2. Use helpers for common operations:
```typescript
import { dismissCookieConsent, waitForNavigation } from './fixtures/helpers';
```

3. Follow the describe/test pattern:
```typescript
test.describe('Feature Name', () => {
  test.beforeEach(async ({ page }) => {
    await dismissCookieConsent(page);
  });

  test('should do something', async ({ page }) => {
    await page.goto('/path');
    await expect(page.locator('selector')).toBeVisible();
  });
});
```

## Best Practices

- Use `data-testid` attributes for stable selectors when possible
- Prefer role-based selectors (`getByRole`, `getByLabel`) over CSS selectors
- Always wait for navigation or loading states before assertions
- Handle cookie consent in `beforeEach` hooks
- Use conditional checks for optional elements with `isVisible({ timeout })`
- Log performance metrics for visibility in CI
