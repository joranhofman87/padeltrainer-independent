

# Add Player Name Search to Invoices Page

## Change

### File: `src/pages/academy/AcademyInvoices.tsx`

1. **Add search state**: `const [searchQuery, setSearchQuery] = useState("")`

2. **Add search input** between the tabs and the stats section (or next to the tabs), using the existing `Input` component with a `Search` icon:
   ```
   <div className="relative">
     <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
     <Input placeholder="Search player name..." className="pl-9 w-64" />
   </div>
   ```

3. **Filter invoices by search**: Update the `filteredInvoices` computation to also filter by `player_name` matching the search query (case-insensitive):
   ```typescript
   const searchFiltered = tabFiltered.filter(i =>
     !searchQuery || i.player_name.toLowerCase().includes(searchQuery.toLowerCase())
   );
   ```

4. **Add translations** for the search placeholder in EN, NL, and DE academy.json files.

### Files
- `src/pages/academy/AcademyInvoices.tsx` — Add search state, input, and filter logic
- `src/i18n/locales/en/academy.json` — Search placeholder
- `src/i18n/locales/nl/academy.json` — Search placeholder
- `src/i18n/locales/de/academy.json` — Search placeholder

