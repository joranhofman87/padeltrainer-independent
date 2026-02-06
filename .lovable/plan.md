

# Show Mollie Connection Status When Balance Is Unavailable

## Problem

The trainer "Trainer Test" has Mollie fully connected (`charges_enabled: true`, `onboarding_complete: true`), but the earnings page shows nothing about Mollie. This is because:

1. The "Connect with Mollie" card (line 470) is hidden when `chargesEnabled` is true -- correct behavior.
2. The "Mollie Balance" card (line 515) only shows when `connectStatus.balance` exists -- but the Mollie balance API returns `null` (common in test mode or new accounts).

Result: neither card renders, so the trainer sees no Mollie-related UI at all.

## Solution

Add a "Mollie Connected" status card that shows when the account is connected but balance data is unavailable. This gives visual confirmation and provides a link to the Mollie dashboard.

## Technical Changes

### `src/pages/TrainerEarnings.tsx`

After the existing Mollie Balance card block (after line 544), add a fallback "connected" card:

```
{/* Mollie Connected (no balance data) */}
{!academyPaymentInfo?.isAcademyTrainer && !useManualInvoicing && 
  connectStatus?.chargesEnabled && !connectStatus.balance && (
  <Card className="mb-8 border-green-200">
    <CardContent className="p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="p-3 rounded-full bg-green-100 dark:bg-green-900">
            <Wallet className="h-6 w-6 text-green-600" />
          </div>
          <div>
            <p className="font-medium">Mollie Connected</p>
            <p className="text-sm text-muted-foreground">
              Your account is set up to receive payments
            </p>
          </div>
        </div>
        <Badge variant="outline" className="border-green-300 text-green-600">
          <CheckCircle2 className="h-3 w-3 mr-1" />
          Active
        </Badge>
      </div>
    </CardContent>
  </Card>
)}
```

This ensures the trainer always sees confirmation that Mollie is connected, regardless of whether the balance API returns data.
