

# Update Player Sidebar: Level Test → Playground

## Change

In `src/components/player/PlayerSidebar.tsx`, rename the "Level Test" nav item to "Playground" and point it to the Playground hub instead of the external level test page.

### File: `src/components/player/PlayerSidebar.tsx`

- Change the link from an external `<a>` tag (pointing to `/${lang}/tools/padel-level-test`) to an internal `NavLink` pointing to `/app/player/playground` or the marketing playground page
- Update icon from `Target` to something like `Gamepad2` or keep `Target`
- Update translation key from `nav.levelTest` to `nav.playground` with fallback "Playground"
- Since the Playground hub is on the marketing site (`/:lang/playground`), keep it as an external `<a>` link but update the URL to `/${lang}/playground`

### File: `src/i18n/locales/*/player.json` (6 files)

- Add `nav.playground` key with translations (EN: "Playground", ES: "Zona de Juego", etc.)

