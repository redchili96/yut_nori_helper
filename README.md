# M2 Companion — Yut Nori Helper v0.9.0 (Beta)

Manual-state browser helper for the 2026 Gameforge Metin2 Yut Nori event.

## Run

```bash
python -m http.server 8080
```

Open `http://localhost:8080`.

## Interactive Board — v0.9.0

The board can now be used as the primary match input instead of recording every roll and movement through buttons.

- Click a piece, then click one of the highlighted legal destinations.
- Drag an on-board piece directly to the position shown in Metin2.
- Pieces at HOME can be selected from the Player / Computer chips below the board.
- When the movement maps to one unique roll, the Helper infers and records that roll automatically.
- When several rolls can lead to the same destination (for example, crossing Finish), a compact confirmation asks which result actually appeared.
- Captures, stacks, shortcuts, Finish, Yut/Mo bonus turns, points and Throws continue to use the existing Rules Engine.
- The existing roll and movement buttons remain available as a fallback.
- Interactive-board events are marked in exported logs with `inputMethod: "interactive-board"`.

A one-roll movement must be inferable from the current state. If a CPU sequence happened too quickly or multiple moves were missed, use **Resync** rather than forcing an inferred path.

## Strategy Engine v2

v0.8.0 includes Strategy Engine v2, which replaces the one-step Strategy v1 ranking with a depth-limited expectimax-style planner.

The strategy objective is ordered around:

1. preserving the path to a Gold reward;
2. winning the game;
3. minimizing unnecessary paid throws / preserving points;
4. using captures, stacks, shortcuts and positioning as means to those goals.

### Opening Planner

The opening layer compares competing plans from the actual board state rather than using a fixed opening script:

- **Early Finish** — Do → O1 → future Back Do attempt;
- **Capture** — reset an exposed CPU piece or stack;
- **Shortcut setup** — early O5/O10/diagonal access;
- **Stack setup** — combine both player pieces when strategically useful;
- **Bonus tempo** — leverage Yut/Mo free follow-up throws;
- **Positioning** — fallback multi-turn board improvement.

The planner explicitly models CPU capture exposure before valuing the O1 / Back Do line.

### Multi-turn search

For probability recommendations the engine searches up to three roll events:

- current player probability choice and actual result;
- CPU stochastic response and best defensive/capturing move;
- next player decision, including bonus-turn branches.

Move recommendations also use continuation search instead of pure immediate tactical value.
Recommendation-level and state-level memoization keep repeated UI renders inexpensive.

### Probability calibration

The default provisional model is seeded from the community logs reviewed on 2026-10-11:

- base roll distribution is estimated from observed CPU rolls;
- the Probability selector is represented by one common multiplicative lift fitted from observed selected-option → actual-result data;
- the model does **not** assume equal 1/6 roll probabilities;
- the fitted lift is an evidence-based provisional model, not a claimed Gameforge RNG constant;
- imported/local community archives automatically replace the seed calibration once minimum sample thresholds are reached.

No win-rate or Gold-rate percentage is shown because the dataset is still too small for a reliable calibrated prediction.

See `STRATEGY_V2.md` for architecture and current limitations.

## Confirmed rule regression coverage

The automated suite preserves observed live-client behavior including:

- O1 + Back Do → Finish;
- O5 + Back Do → O4;
- forced forward shortcut from O5 and O10;
- Centre → bottom-right Finish route;
- overshooting Finish on a forward throw;
- stack movement and 2-piece captures;
- Yut/Mo bonus throws;
- TL shortcut sequences to Finish.

## Recovery and data controls

- Undo / Redo timeline;
- board Resync / Missed CPU turn recovery;
- local History archive;
- versioned community JSON export/import;
- CSV export;
- anonymous source IDs only;
- no server, account or external database required.

## Community log compatibility

Archive schema remains `metin2-yut-nori-community-log`, schema version 1. Existing v0.6.x game records remain importable.


## Beta release notes

- Branded for M2 Companion with a dedicated Beta badge and optimized local logo assets.
- Release shell polished for desktop and responsive layouts without changing the Yut Nori board model.
- Improved keyboard focus states and reduced-motion support.
- All match data remains browser-local unless the user explicitly exports a community log.
- Static deployment only: no server-side database, account system or external API is required.

## Publishing

This build can be hosted as a static website. Upload the contents of the project directory to any static host and keep the relative `assets/` and `src/` paths unchanged.


## v0.8.1 — Strategy Telemetry

This release keeps Strategy Engine v2 decision-making unchanged and enriches new match logs with decision telemetry for later analysis. Player probability decisions now store the ranked Strategy v2 alternatives, internal utility values, utility gaps, opening-plan labels, intended moves, and state diagnostics. Player move events store the ranked legal alternatives, the Helper recommendation, the actual move chosen, and the model utility gap.

The utility values are internal relative scores, not predicted win rates or percentages. Existing schema-v1 community logs remain compatible; telemetry is optional and is only present in games recorded with v0.8.1 or later. CSV exports include the key telemetry ranks, utilities, and gaps, while JSON exports contain the richer decision snapshots.


## v0.9.0 — Interactive Board

The board is now an input surface. Click or drag the active piece to mirror Metin2 and the Helper will infer the observed roll whenever the transition is unique. Ambiguous Finish/route cases require explicit confirmation. Existing button input, Undo/Redo, Resync, Strategy v2 and Strategy Telemetry remain available.