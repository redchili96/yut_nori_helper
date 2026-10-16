# Strategy Telemetry — v0.9.1

Strategy telemetry is optional metadata stored on new **player** roll and move events. It is designed for post-match analysis. Since v0.9.1 it also records the additional diagnostics used by the Strategy Stability Hotfix.

## Probability decision

A player `roll` event may include `strategyTelemetry` with:

- `kind: "probability-decision"`
- `engineVersion` and search `horizon`
- `utilityScale: "internal-relative-not-percentage"`
- the probability model source/sample sizes, raw/effective selection multiplier and evidence confidence
- the Strategy v2 recommendation
- the option actually selected in Metin2 and its rank
- all six ranked probability alternatives
- each alternative's internal utility and gap from the best option
- opening-plan classification when applicable
- intended move, expected-decision metrics, target-line metrics and compact resulting-state diagnostics

The observed result remains the event's existing `rollKey` field.

## Move decision

A player `move` event may include `strategyTelemetry` with:

- `kind: "move-decision"`
- the recommended move
- the move actually chosen by the player
- both ranks/internal utilities
- `utilityGapFromBest`
- all legal alternatives with reasons and transition facts
- compact resulting-state diagnostics

This makes it possible to identify cases where the player deviated from the Helper and later review whether Strategy v2 systematically over- or under-valued certain lines.

## Diagnostics

Diagnostics may include projected reward points, conservative Gold-completion estimate, win-potential proxy, estimated throws to Finish, immediate capture risk, stack exposure and finished-piece counts. These values are model diagnostics only. The Gold estimate is a heuristic planning estimate, not a measured or guaranteed probability. Utility scores remain internal relative values.

## Compatibility

The Community Log schema remains version 1. Telemetry is optional, so v0.8.0 and older schema-v1 records remain valid and importable.


## Input method — v0.9.0

Roll and move events may also include `inputMethod`. Interactive-board actions use `"interactive-board"`; the legacy controls use `"buttons"`. This does not affect Strategy Engine scoring. It allows later analysis to distinguish inferred board transitions from manually recorded roll/move events.


## Strategy Stability fields — v0.9.1

Probability decisions may additionally contain `rankingBasis`, `decisionMetrics`, `targetLineMetrics`, and `probabilityModel.confidence`. The effective selection multiplier is intentionally shrunk toward `1.0` while evidence is sparse. If it reaches `1.0`, all selector choices can have identical expected search utility; `targetLineMetrics` then provide an explicit strategic secondary ordering instead of relying on array order.