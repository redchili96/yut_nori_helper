# Yut Nori Helper — Observed Rules (2026)

## Confirmed directly in the current Gameforge client

- Each side has 2 pieces.
- The game ends as soon as one side finishes both pieces.
- A finished piece can no longer be moved.
- Two allied pieces on the same node form a stack and move together.
- Capturing a 2-piece stack resets both pieces and is worth +20 points to the player.
- A normal player throw costs 10 points and consumes 1 Throw.
- Yut and Mo grant a free bonus throw.
- The probability bias can be changed before that bonus throw.
- Back Do moves one space backwards.
- **Back Do from the first node after Start/Finish moves the piece to Finish.** A 2-piece stack there can therefore finish both pieces at once.
- Shortcut use requires landing on the relevant branch node; merely passing it is not enough.
- On player defeat, the displayed final score becomes 0.
- **Initial toss: the lower result starts.** The initial toss does not consume Points or Throws. The helper only records who starts; the toss results themselves are not required for gameplay state.

## Intentionally not hard-coded yet / needs more validation

- Tie behaviour during the initial toss.
- Exact probability multiplier applied by the bias dropdown.
- Whether consecutive identical outcomes are impossible under all circumstances.
- Exact centre-routing rule for every possible approach direction beyond the now-confirmed bottom-right Finish option.
- Complete CPU movement policy. The mt2helper CPU inference has already been observed diverging from the real client (Mo to corner, bonus Gae continued the same piece through the shortcut while mt2helper introduced piece 2).

## Additional real-game regressions confirmed (11 Oct 2026)

- From **Centre**, the player can continue on the **bottom-right diagonal toward Finish**. A throw that has more steps than remain on that diagonal still completes the piece at Finish.
- A 2-piece CPU stack on **O5** receiving **Back Do** moves together to **O4**.
- A 2-piece player stack on **O10** can use **Gae** to take the top-left shortcut to **TL2**.
- On that shortcut, **TL2 + Gae → BR2**, then **BR2 + Gae → Finish**, finishing both stacked pieces together.
- A player move landing on a 2-piece CPU stack captures and resets both CPU pieces to Home.
- The observed winning sequence reinforces the strategic value of forming a stack, reaching O10, and taking the fast finish shortcut.
- **Shortcut-entry corners are forced for forward movement:** from **O5** the next forward move follows the top-right diagonal toward Centre; from **O10** the next forward move follows the top-left diagonal toward Centre/Finish. The helper must not offer the outer horizontal/vertical continuation from those corners. Back Do remains route-relative (e.g. O5 → O4).

## Data collection note (v0.6.1)

For player rolls the helper now records both:
- `selectedProbability`: the probability selected in the Metin2 dropdown before the throw.
- `rollKey`: the result that actually appeared.

This distinction is required before estimating the real probability distribution for Monte Carlo / Expectimax.
