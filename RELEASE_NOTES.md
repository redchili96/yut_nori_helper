# Yut Nori Helper v0.9.0 — Interactive Board

## Added
- Click-to-move workflow: select the active piece, then choose a highlighted legal destination.
- Pointer drag for pieces already visible on the board.
- HOME-piece selection through the Player / Computer chips below the board.
- Rules-engine movement inference across Do, Gae, Geol, Yut, Mo and Back Do.
- Automatic roll logging when a board transition has one unique explanation.
- Compact ambiguity prompt when several rolls/routes can reach the same destination.
- Interactive-board input metadata in JSON/CSV community logs.
- Dedicated regression coverage for inferred CPU moves, stacks, Back Do → Finish and Finish-overrun ambiguity.

## Preserved
- Strategy Engine v2 recommendations and weights are unchanged.
- Strategy Telemetry remains active for player decisions.
- Existing roll/movement buttons remain available as fallback.
- Undo, Redo, Resync, History and schema-v1 Community Logs remain compatible.

## Known limitations
- The board infers one observed roll/move at a time; it does not reconstruct several missed CPU turns from a final position. Use Resync if the live client moved too quickly.
- Back Do from HOME has no movement to drag, so it still uses the result button + pass flow.
- When several throws can legally cross Finish, the user must identify the actual result shown in Metin2.

---

# Yut Nori Helper v0.8.1 — Strategy Telemetry

## Added
- Strategy v2 probability-decision telemetry in new player roll events.
- Ranked probability alternatives with internal utility, utility gap, plan label, intended move and compact state diagnostics.
- Move-decision telemetry comparing the Helper recommendation with the move actually selected by the player.
- Utility/rank telemetry columns in CSV exports.
- Strategy-decision count in History for v0.8.1+ records.

## Compatibility
- Strategy weights and recommendation logic are unchanged from v0.8.0.
- Existing Community Log schema v1 files remain importable.
- Old records without telemetry remain valid.
- Utility scores are internal relative values, not percentages or predicted win/Gold rates.

---

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