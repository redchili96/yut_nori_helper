# Strategy Engine v2 — Architecture Notes

## Diagnosis of Strategy v1

Strategy v1 combined board-state scoring with large explicit tactical bonuses. In particular, a captured piece received a large immediate bonus on top of board value, while future Finish lines were represented mostly through route distance and fixed node bonuses. This made an immediate capture capable of dominating an opening even when a short multi-turn Finish plan could preserve more reward score.

The v1 approach was useful for validating board logic, but it had three strategic limitations:

1. it evaluated the chosen roll mainly through its best immediate movement;
2. CPU response was approximated through a capture-risk penalty instead of an explicit response branch;
3. the Probability selector was not backed by a calibrated stochastic model.

## v2 components

### 1. Probability model (`src/probabilities.js`)

- Observed CPU rolls estimate the provisional base distribution.
- Selected Probability → actual roll observations fit a single common selection multiplier.
- A common multiplier is used because per-option samples are currently too sparse to justify six independent hidden-RNG modifiers.
- The multiplier and thresholds are configurable constants.
- Local/community logs replace the seed calibration when the archive contains enough observations.

### 2. Opening Planner (`src/strategy.js`)

The planner classifies the intended line for every selectable Probability option:

- Early Finish
- Capture
- Stack setup
- Shortcut setup
- Bonus tempo
- Positioning / flexible opening

Classification is explanatory; the winning plan is selected by the multi-turn value calculation, not by a fixed plan priority.

### 3. Depth-limited expectimax-style search

Player Probability choice is a decision node. Actual rolls are chance nodes using the provisional selected distribution. Player movement chooses the highest continuation value.

CPU rolls are chance nodes using the observed base distribution. For each actual CPU roll, the CPU movement is treated conservatively as the legal move that minimizes player value.

The default probability recommendation horizon is three roll events. This normally covers:

1. the current player action;
2. one CPU response;
3. the next player action.

Bonus throws remain inside the same search horizon and are handled as additional roll events.

### 4. Objective / leaf evaluation

Terminal Gold wins receive the highest utility tier. Non-Gold wins remain positive, and losses are strongly negative. For non-terminal leaves the engine uses a reward-preservation proxy based on:

- current points;
- remaining Finish credits;
- estimated paid throws still required;
- player and CPU Finish progress;
- O1 Back Do opportunity;
- stack efficiency;
- shortcut position;
- explicit CPU capture exposure.

The projected Gold value is a search heuristic, not a displayed probability.

## Current evidence result: CPU O2 opening

With both player pieces at HOME and one CPU piece at O2, the current provisional model ranks **Do / Early Finish** above **Gae / Capture**. The reason is that Do can establish O1 for a subsequent Back Do Finish attempt, while the search explicitly discounts the line for the possibility that the CPU captures O1 first.

This conclusion is provisional and can change as imported community logs alter the probability calibration.

## Remaining limitations

- The Probability-selector effect is based on a small dataset and one common fitted multiplier.
- CPU behavior is modelled as a conservative best response after each observed roll; it is not learned from a CPU policy model yet.
- Search is depth-limited rather than full-game solving.
- Gold potential at non-terminal leaves is a heuristic. Because capture points can restore score, the engine should not label Gold mathematically impossible before the game is over without stronger constraints.
- No reliable win-rate or Gold-rate percentages are shown yet.

A later v3 can replace the provisional chance model with larger-sample calibration and deeper Monte Carlo / expectimax evaluation, preferably in a Web Worker if search depth materially increases.
