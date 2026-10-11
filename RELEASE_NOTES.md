# Yut Nori Helper v0.8.0 — Public Beta

This build is the first release-ready community beta under the M2 Companion brand.

## Release polish

- Final M2 Companion header treatment with a separate `BETA` status badge.
- Product naming standardized to **Yut Nori Helper**.
- Restrained red / ember / gold accents inspired by the M2 Companion logo while preserving the Metin2-like board.
- Optimized logo asset plus browser favicon.
- Improved button hierarchy, hover, pressed and keyboard-focus states.
- Cleaner responsive header behavior for smaller screens.
- Added reduced-motion support.
- Added a minimal release footer with local-only / beta status.
- Updated community-log copy to make local storage and anonymous export clearer.
- Strategy Engine v2, History, Undo/Redo, Resync and Community Log schema remain unchanged.

## Validation

- Full automated suite: **40/40 passing**.
- `src/app.js` syntax check passes.
- Existing schema version 1 community logs remain compatible.

## Known beta limitations

- Strategy probabilities remain provisional and improve as more community logs are collected.
- CPU movement is still confirmed manually when multiple legal moves exist.
- The helper mirrors the live Metin2 board; it does not read the game client automatically.
