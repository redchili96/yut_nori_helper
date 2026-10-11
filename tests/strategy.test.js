import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, startGame, applyRoll } from '../src/engine.js';
import { recommendMove, recommendRoll, evaluateOpeningPlans, buildRollTelemetry, buildMoveTelemetry, __strategyInternals } from '../src/strategy.js';

function playing() {
  const g = createGame();
  startGame(g, 'player');
  return g;
}

test('Geol from O5 recommends P1 via top-right shortcut to Centre over P2 from Home', () => {
  const g = playing();
  g.player[0].node = 'O5';
  g.player[0].route = 'OUTER';
  g.player[1].node = 'HOME';
  g.computer[0].node = 'O4';
  g.computer[1].node = 'O1';
  applyRoll(g, 'player', 'GEOL');
  const rec = recommendMove(g, 'player');
  assert.ok(rec?.best);
  assert.deepEqual(rec.best.move.pieceIds, ['P1']);
  assert.equal(rec.best.move.to, 'C');
  assert.equal(rec.best.move.route, 'TR_TO_BL');
  assert.equal(rec.equivalent, false);
});

test('Gae from an O10 stack prefers the fast top-left shortcut to TL2', () => {
  const g = playing();
  g.player[0].node = 'O10';
  g.player[1].node = 'O10';
  g.player[0].route = 'OUTER';
  g.player[1].route = 'OUTER';
  applyRoll(g, 'player', 'GAE');
  const rec = recommendMove(g, 'player');
  assert.ok(rec?.best);
  assert.deepEqual(rec.best.move.pieceIds.sort(), ['P1', 'P2']);
  assert.equal(rec.best.move.to, 'TL2');
  assert.equal(rec.best.move.route, 'TL_TO_FINISH');
});

test('when both pieces are at O1, Strategy v2 recommends Back Do as the probability target', () => {
  const g = playing();
  g.player[0].node = 'O1';
  g.player[1].node = 'O1';
  const rec = recommendRoll(g, 'player');
  assert.ok(rec?.best);
  assert.equal(rec.best.rollKey, 'BACK_DO');
});

test('Strategy v2 does not automatically prefer a capture over a stronger stack line', () => {
  const g = playing();
  g.player[0].node = 'O2';
  g.player[1].node = 'HOME';
  g.computer[0].node = 'O4';
  g.computer[1].node = 'O4';
  applyRoll(g, 'player', 'GAE');
  const rec = recommendMove(g, 'player');
  assert.ok(rec?.best);
  assert.deepEqual(rec.best.move.pieceIds, ['P2']);
  assert.equal(rec.best.move.to, 'O2');
  assert.match(rec.reason, /stacks your pieces/i);
  assert.ok(rec.alternatives.some(row => row.move.to === 'O4' && row.facts.captured === 2));
});

test('Yut at Centre recommends the finish diagonal instead of the bottom-left route', () => {
  const g = playing();
  g.player[0].node = 'C';
  g.player[0].route = 'TL_TO_FINISH';
  g.player[1].node = 'BR1';
  g.player[1].route = 'TL_TO_FINISH';

  applyRoll(g, 'player', 'YUT');
  const rec = recommendMove(g, 'player');

  assert.ok(rec?.best);
  assert.equal(rec.best.move.to, 'FINISH');
  assert.equal(rec.best.move.route, 'C_TO_FINISH');
  assert.deepEqual(rec.best.move.pieceIds, ['P1']);
});

test('Strategy v2 never offers the outer route when moving forward from O5', () => {
  const g = playing();
  g.player[0].node = 'O5';
  g.player[0].route = 'OUTER';
  g.player[1].finished = true;
  g.player[1].node = 'FINISH';
  applyRoll(g, 'player', 'GEOL');

  const rec = recommendMove(g, 'player');
  assert.ok(rec?.best);
  assert.equal(rec.alternatives.length, 1);
  assert.equal(rec.best.move.route, 'TR_TO_BL');
  assert.equal(rec.best.move.to, 'C');
});

test('opening planner: CPU O2 with both player pieces HOME compares capture vs early finish and currently prefers Do', () => {
  const g = playing();
  g.computer[0].node = 'O2';
  g.computer[0].route = 'OUTER';

  const rec = recommendRoll(g, 'player');
  assert.ok(rec?.best);
  assert.equal(rec.best.rollKey, 'DO');
  assert.equal(rec.best.plan?.key, 'EARLY_FINISH');
  assert.match(rec.best.reason, /Early Finish/i);

  const gae = rec.alternatives.find(row => row.rollKey === 'GAE');
  assert.equal(gae?.plan?.key, 'CAPTURE');
  assert.ok(rec.best.value > gae.value);
});

test('opening planner: CPU O1 with both player pieces HOME recognizes Do as a hybrid capture + O1 finish setup', () => {
  const g = playing();
  g.computer[0].node = 'O1';
  g.computer[0].route = 'OUTER';

  const rec = recommendRoll(g, 'player');
  assert.equal(rec.best.rollKey, 'DO');
  assert.equal(rec.best.plan?.key, 'EARLY_FINISH');
  assert.match(rec.best.reason, /capture the CPU piece/i);
});

test('opening planner: P1 at O1 with CPU home can prefer Do to stack P2 before the Back Do finish attempt', () => {
  const g = playing();
  g.player[0].node = 'O1';
  g.player[0].route = 'OUTER';

  const rec = recommendRoll(g, 'player');
  assert.equal(rec.best.rollKey, 'DO');
  assert.equal(rec.best.bestMove?.from, 'HOME');
  assert.equal(rec.best.bestMove?.to, 'O1');
  assert.equal(rec.best.plan?.key, 'EARLY_FINISH');
});

test('opening planner: P1 at O1 with CPU O2 accounts for the Back Do capture threat', () => {
  const g = playing();
  g.player[0].node = 'O1';
  g.player[0].route = 'OUTER';
  g.computer[0].node = 'O2';
  g.computer[0].route = 'OUTER';

  const threat = __strategyInternals.captureThreat({ ...g, turn: 'computer' }, 'player');
  assert.ok(threat.weightedRisk > 0);
  assert.ok(threat.outcomes.some(row => row.rollKey === 'BACK_DO' && row.node === 'O1'));

  const rec = recommendRoll(g, 'player');
  assert.ok(rec?.best);
  assert.match(rec.best.reason, /capture risk/i);
});

test('immediate Finish can beat an immediate single capture', () => {
  const g = playing();
  g.player[0].node = 'BR1';
  g.player[0].route = 'C_TO_FINISH';
  g.player[1].node = 'O2';
  g.computer[0].node = 'O4';
  applyRoll(g, 'player', 'GAE');

  const rec = recommendMove(g, 'player');
  assert.equal(rec.best.move.to, 'FINISH');
  assert.match(rec.reason, /finishes a piece/i);
  assert.ok(rec.alternatives.some(row => row.move.to === 'O4' && row.facts.captured === 1));
});

test('a two-piece CPU capture can still beat a one-piece Finish when the board state justifies it', () => {
  const g = playing();
  g.player[0].node = 'BR1';
  g.player[0].route = 'C_TO_FINISH';
  g.player[1].node = 'O2';
  g.computer[0].node = 'O4';
  g.computer[1].node = 'O4';
  applyRoll(g, 'player', 'GAE');

  const rec = recommendMove(g, 'player');
  assert.equal(rec.best.move.to, 'O4');
  assert.equal(rec.best.facts.captured, 2);
});

test('Gold potential distinguishes a completed Gold win from a completed non-Gold win', () => {
  const gold = playing();
  gold.player[0].finished = true; gold.player[0].node = 'FINISH';
  gold.player[1].finished = true; gold.player[1].node = 'FINISH';
  gold.winner = 'player'; gold.points = 220;

  const silver = structuredClone(gold);
  silver.points = 219;

  assert.equal(__strategyInternals.goldPotential(gold), 1);
  assert.equal(__strategyInternals.goldPotential(silver), 0);
  assert.ok(__strategyInternals.boardValue(gold) > __strategyInternals.boardValue(silver));
});

test('opening planner exposes multiple competing strategies instead of one fixed rule', () => {
  const g = playing();
  g.computer[0].node = 'O2';
  const plans = evaluateOpeningPlans(g, 'player');
  const keys = new Set(plans.map(row => row.plan.key));
  assert.ok(keys.has('EARLY_FINISH'));
  assert.ok(keys.has('CAPTURE'));
  assert.ok(keys.has('SHORTCUT') || keys.has('BONUS_TEMPO'));
});

test('roll telemetry stores ranked Strategy v2 alternatives without changing the recommendation', () => {
  const g = playing();
  g.computer[0].node = 'O2';
  g.computer[0].route = 'OUTER';
  const before = structuredClone(g);
  const rec = recommendRoll(g, 'player');
  const telemetry = buildRollTelemetry(g, rec, 'GAE');

  assert.equal(rec.best.rollKey, 'DO');
  assert.equal(telemetry.kind, 'probability-decision');
  assert.equal(telemetry.utilityScale, 'internal-relative-not-percentage');
  assert.equal(telemetry.recommendation.rollKey, 'DO');
  assert.equal(telemetry.alternatives.length, 6);
  assert.equal(telemetry.alternatives[0].rank, 1);
  assert.equal(telemetry.alternatives[0].rollKey, 'DO');
  assert.equal(telemetry.selectedChoice.rollKey, 'GAE');
  assert.ok(telemetry.selectedChoice.rank > 1);
  assert.ok(telemetry.selectedChoice.utilityGapFromBest > 0);
  assert.deepEqual(g, before);
});

test('move telemetry records the player actual choice and model utility gap', () => {
  const g = playing();
  g.player[0].node = 'BR1';
  g.player[0].route = 'C_TO_FINISH';
  g.player[1].node = 'O2';
  g.computer[0].node = 'O4';
  applyRoll(g, 'player', 'GAE');

  const rec = recommendMove(g, 'player');
  const capture = rec.alternatives.find(row => row.move.to === 'O4').move;
  const telemetry = buildMoveTelemetry(g, rec, capture);

  assert.equal(telemetry.kind, 'move-decision');
  assert.equal(telemetry.recommendation.move.to, 'FINISH');
  assert.equal(telemetry.actualChoice.move.to, 'O4');
  assert.ok(telemetry.actualChoice.rank > 1);
  assert.ok(telemetry.actualChoice.utilityGapFromBest > 0);
  assert.ok(telemetry.alternatives.every(row => typeof row.utility === 'number'));
  assert.ok(telemetry.alternatives.every(row => row.resultingState));
});
