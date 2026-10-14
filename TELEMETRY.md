# Strategy Telemetry — v0.8.1

Strategy telemetry is optional metadata stored on new **player** roll and move events. It is designed for post-match analysis and does not change Strategy Engine v2 recommendations.

## Probability decision

A player `roll` event may include `strategyTelemetry` with:

- `kind: "probability-decision"`
- `engineVersion` and search `horizon`
- `utilityScale: "internal-relative-not-percentage"`
- the probability model source/sample sizes
- the Strategy v2 recommendation
- the option actually selected in Metin2 and its rank
- all six ranked probability alternatives
- each alternative's internal utility and gap from the best option
- opening-plan classification when applicable
- intended move and compact resulting-state diagnostics

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

Diagnostics may include projected reward points, Gold-potential proxy, win-potential proxy, estimated throws to Finish, immediate capture risk and finished-piece counts. These values are model diagnostics only. They must not be presented as measured probabilities or guaranteed outcomes.

## Compatibility

The Community Log schema remains version 1. Telemetry is optional, so v0.8.0 and older schema-v1 records remain valid and importable.


## Input method — v0.9.0

Roll and move events may also include `inputMethod`. Interactive-board actions use `"interactive-board"`; the legacy controls use `"buttons"`. This does not affect Strategy Engine scoring. It allows later analysis to distinguish inferred board transitions from manually recorded roll/move events.