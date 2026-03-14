

# Plan: Fix CSV Delimiter Detection for Comma-Decimal Coordinates

## Problem

`parseCSVLine` (line 181) treats both `,` and `;` as column delimiters simultaneously. When coordinates use commas as decimal separators (e.g. `-32,00`), the parser splits them into separate columns, shifting all subsequent data.

## Solution

Auto-detect the primary delimiter from the header row, then use **only that delimiter** for parsing. Files with comma-decimal coordinates will almost always use semicolons as the column delimiter (this is the European CSV convention).

## File: `src/components/admin/ImportLocationsDialog.tsx`

### Change 1: Add delimiter detection function

Before `parseCSVLine`, add a `detectDelimiter` function that counts semicolons vs commas in the header line (outside of quotes). If semicolons are present, use semicolons; otherwise use commas. This follows the standard European CSV convention.

```typescript
const detectDelimiter = (headerLine: string): string => {
  let commaCount = 0;
  let semicolonCount = 0;
  let inQuotes = false;
  for (const char of headerLine) {
    if (char === '"') inQuotes = !inQuotes;
    if (!inQuotes) {
      if (char === ',') commaCount++;
      if (char === ';') semicolonCount++;
    }
  }
  return semicolonCount > 0 ? ';' : ',';
};
```

### Change 2: Update `parseCSVLine` to accept a delimiter parameter

Change signature to `parseCSVLine(line: string, delimiter: string)` and replace the `(char === "," || char === ";")` check on line 191 with `char === delimiter`.

### Change 3: Detect delimiter once in `parseCSV` and pass it through

In `parseCSV`, detect the delimiter from the header line, then pass it to all `parseCSVLine` calls (header + data rows).

