

# Fix CSV Export: Use Semicolons as Delimiter for Excel Compatibility

## Problem
The CSV uses commas as delimiters, but Dutch/European Excel expects semicolons. This causes all data to appear in a single column (as shown in the screenshot).

## Fix

**File: `src/lib/cycles.ts`** — `exportIntakeRequestsToCsv` function

1. **Use semicolons** as the column delimiter instead of commas
2. **Wrap every value in double quotes** to safely handle commas, newlines, and semicolons within field values
3. Use `\r\n` line endings for better Excel compatibility

The change is ~5 lines in the existing function: replace `.join(',')` with `.join(';')` for both headers and rows, and always quote-wrap values.

