import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, startGame, legalMoves, applyRoll, applyMove, observedMoveCandidates } from '../src/engine.js';

function readyGame(starter = 'player') {
  const g = createGame();
  startGame(g, starter);
  return g;
}

function getMove(game, actor, roll, predicate) {
  return legalMoves(game, actor, roll).find(predicate);
}

test('starting as player preserves initial Points and Throws', () => {
  const g = createGame();
  startGame(g, 'player');
  assert.equal(g.phase, 'PLAYING');
  assert.equal(g.turn, 'player');
  assert.equal(g.points, 250);
  assert.equal(g.throws, 20);
  assert.equal(g.log[0].type, 'start');
});

test('starting as computer sets the correct turn', () => {
  const g = createGame();
  startGame(g, 'computer');
  assert.equal(g.phase, 'PLAYING');
  assert.equal(g.turn, 'computer');
  assert.equal(g.points, 250);
  assert.equal(g.throws, 20);
});

test('normal player roll costs 10 points and one throw', () => {
  const g = readyGame();
  applyRoll(g, 'player', 'DO', { bonus: false });
  assert.equal(g.points, 240);
  assert.equal(g.throws, 19);
});

test('bonus throw costs neither points nor throws', () => {
  const g = readyGame();
  g.bonusThrow = true;
  applyRoll(g, 'player', 'GAE', { bonus: true });
  assert.equal(g.points, 250);
  assert.equal(g.throws, 20);
});

test('Back Do from first node finishes a piece', () => {
  const g = readyGame();
  g.player[0].node = 'O1';
  const move = getMove(g, 'player', 'BACK_DO', m => m.pieceIds.includes('P1'));
  assert.equal(move.to, 'FINISH');
  assert.equal(move.special, 'FIRST_NODE_BACK_DO_FINISH');
  applyRoll(g, 'player', 'BACK_DO');
  applyMove(g, move);
  assert.equal(g.player[0].finished, true);
});

test('Back Do from first node finishes a two-piece stack and wins', () => {
  const g = readyGame();
  g.player[0].node = 'O1';
  g.player[1].node = 'O1';
  const move = legalMoves(g, 'player', 'BACK_DO')[0];
  assert.deepEqual(move.pieceIds.sort(), ['P1', 'P2']);
  applyRoll(g, 'player', 'BACK_DO');
  applyMove(g, move);
  assert.equal(g.winner, 'player');
  assert.equal(g.points, 260);
});

test('Yut grants a free follow-up throw after the move', () => {
  const g = readyGame();
  applyRoll(g, 'player', 'YUT');
  const move = legalMoves(g, 'player', 'YUT').find(m => m.pieceIds.includes('P1'));
  applyMove(g, move);
  assert.equal(g.turn, 'player');
  assert.equal(g.bonusThrow, true);
  const points = g.points;
  const throws = g.throws;
  applyRoll(g, 'player', 'GAE', { bonus: true });
  assert.equal(g.points, points);
  assert.equal(g.throws, throws);
});

test('capture of a two-piece CPU stack awards +20 and resets both pieces', () => {
  const g = readyGame();
  g.player[0].node = 'O1';
  g.computer[0].node = 'O3';
  g.computer[1].node = 'O3';
  applyRoll(g, 'player', 'GAE');
  const move = legalMoves(g, 'player', 'GAE').find(m => m.pieceIds.includes('P1'));
  applyMove(g, move);
  assert.equal(g.points, 260);
  assert.equal(g.computer[0].node, 'HOME');
  assert.equal(g.computer[1].node, 'HOME');
});

test('top-left shortcut observed path reaches Finish in six steps', () => {
  const g = readyGame();
  g.player[0].node = 'O10';
  g.player[0].route = 'OUTER';
  const yutMove = legalMoves(g, 'player', 'YUT').find(m => m.route === 'TL_TO_FINISH');
  assert.equal(yutMove.to, 'BR2');
  applyRoll(g, 'player', 'YUT');
  applyMove(g, yutMove);
  const gaeMove = legalMoves(g, 'player', 'GAE').find(m => m.pieceIds.includes('P1'));
  assert.equal(gaeMove.to, 'FINISH');
});

test('observed regression: Back Do moves a two-piece CPU stack from O5 back to O4', () => {
  const g = readyGame('computer');
  g.computer[0].node = 'O5';
  g.computer[1].node = 'O5';
  g.computer[0].route = 'OUTER';
  g.computer[1].route = 'OUTER';
  const move = legalMoves(g, 'computer', 'BACK_DO')[0];
  assert.deepEqual(move.pieceIds.sort(), ['C1', 'C2']);
  assert.equal(move.to, 'O4');
  applyRoll(g, 'computer', 'BACK_DO');
  applyMove(g, move);
  assert.equal(g.computer[0].node, 'O4');
  assert.equal(g.computer[1].node, 'O4');
});

test('observed regression: Gae from an O10 stack can take both pieces to TL2', () => {
  const g = readyGame();
  g.player[0].node = 'O10';
  g.player[1].node = 'O10';
  const move = legalMoves(g, 'player', 'GAE').find(m => m.route === 'TL_TO_FINISH');
  assert.ok(move);
  assert.deepEqual(move.pieceIds.sort(), ['P1', 'P2']);
  assert.equal(move.to, 'TL2');
});

test('observed regression: stacked shortcut sequence TL2 + Gae -> BR2 -> Finish', () => {
  const g = readyGame();
  g.player[0].node = 'TL2';
  g.player[1].node = 'TL2';
  g.player[0].route = 'TL_TO_FINISH';
  g.player[1].route = 'TL_TO_FINISH';

  applyRoll(g, 'player', 'GAE');
  const toBr2 = legalMoves(g, 'player', 'GAE')[0];
  assert.equal(toBr2.to, 'BR2');
  applyMove(g, toBr2);

  // The observed match had another normal player turn later; restore it here to
  // validate the route independently of intervening CPU turns.
  g.turn = 'player';
  applyRoll(g, 'player', 'GAE');
  const toFinish = legalMoves(g, 'player', 'GAE')[0];
  assert.equal(toFinish.to, 'FINISH');
  applyMove(g, toFinish);
  assert.equal(g.winner, 'player');
  assert.equal(g.player.filter(p => p.finished).length, 2);
});

test('observed regression: player captures a two-piece CPU stack on O4', () => {
  const g = readyGame();
  g.player[0].node = 'O2';
  g.computer[0].node = 'O4';
  g.computer[1].node = 'O4';
  applyRoll(g, 'player', 'GAE');
  const move = legalMoves(g, 'player', 'GAE').find(m => m.to === 'O4');
  applyMove(g, move);
  assert.equal(g.computer[0].node, 'HOME');
  assert.equal(g.computer[1].node, 'HOME');
});


test('observed regression: Yut from Centre can continue down-right and finish', () => {
  const g = readyGame();
  g.player[0].node = 'C';
  g.player[0].route = 'TL_TO_FINISH';

  const moves = legalMoves(g, 'player', 'YUT').filter(m => m.pieceIds.includes('P1'));
  const downLeft = moves.find(m => m.route === 'C_TO_BL');
  const downRight = moves.find(m => m.route === 'C_TO_FINISH');

  assert.ok(downLeft, 'centre -> bottom-left option should remain legal');
  assert.equal(downLeft.to, 'O16');
  assert.ok(downRight, 'centre -> bottom-right diagonal should be legal');
  assert.equal(downRight.to, 'FINISH');
});

test('forward throws may cross the final node and still finish', () => {
  const g = readyGame();
  g.player[0].node = 'BR2';
  g.player[0].route = 'TL_TO_FINISH';

  const move = legalMoves(g, 'player', 'GEOL').find(m => m.pieceIds.includes('P1'));
  assert.ok(move);
  assert.equal(move.to, 'FINISH');
  assert.equal(move.special, 'CROSSES_FINISH');
});


test('observed regression: forward movement from O5 is forced onto the top-right diagonal', () => {
  const g = readyGame();
  g.player[0].node = 'O5';
  g.player[0].route = 'OUTER';

  const moves = legalMoves(g, 'player', 'GEOL').filter(m => m.pieceIds.includes('P1'));
  assert.equal(moves.length, 1);
  assert.equal(moves[0].route, 'TR_TO_BL');
  assert.equal(moves[0].to, 'C');
  assert.equal(moves.some(m => m.route === 'OUTER' || m.to === 'O8'), false);
});

test('observed regression: forward movement from O10 is forced onto the top-left diagonal', () => {
  const g = readyGame();
  g.player[0].node = 'O10';
  g.player[0].route = 'OUTER';

  const moves = legalMoves(g, 'player', 'GAE').filter(m => m.pieceIds.includes('P1'));
  assert.equal(moves.length, 1);
  assert.equal(moves[0].route, 'TL_TO_FINISH');
  assert.equal(moves[0].to, 'TL2');
  assert.equal(moves.some(m => m.route === 'OUTER' || m.to === 'O12'), false);
});


test('interactive board infers a unique CPU Geol move from O2 to O5', () => {
  const g = readyGame('computer');
  g.computer[0].node = 'O2';
  const candidates = observedMoveCandidates(g, 'computer', ['C1'], 'O5');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].rollKey, 'GEOL');
  assert.equal(candidates[0].move.from, 'O2');
  assert.equal(candidates[0].move.to, 'O5');
});

test('interactive board infers stacked movement as one move', () => {
  const g = readyGame('computer');
  g.computer[0].node = 'O2';
  g.computer[1].node = 'O2';
  const candidates = observedMoveCandidates(g, 'computer', ['C1', 'C2'], 'O5');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].rollKey, 'GEOL');
  assert.deepEqual([...candidates[0].move.pieceIds].sort(), ['C1', 'C2']);
});

test('interactive board infers O1 to Finish as Back Do', () => {
  const g = readyGame();
  g.player[0].node = 'O1';
  const candidates = observedMoveCandidates(g, 'player', ['P1'], 'FINISH');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].rollKey, 'BACK_DO');
  assert.equal(candidates[0].move.special, 'FIRST_NODE_BACK_DO_FINISH');
});

test('interactive board reports ambiguity when several rolls can cross Finish', () => {
  const g = readyGame();
  g.player[0].node = 'O18';
  g.player[0].route = 'OUTER';
  const candidates = observedMoveCandidates(g, 'player', ['P1'], 'FINISH');
  assert.deepEqual(candidates.map(c => c.rollKey), ['GAE', 'GEOL', 'YUT', 'MO']);
});

test('interactive board can infer a HOME piece placement', () => {
  const g = readyGame();
  const candidates = observedMoveCandidates(g, 'player', ['P1'], 'O3');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].rollKey, 'GEOL');
});

test('interactive-board input method is preserved in roll and move logs', () => {
  const g = readyGame();
  const candidate = observedMoveCandidates(g, 'player', ['P1'], 'O2')[0];
  applyRoll(g, 'player', candidate.rollKey, { inputMethod: 'interactive-board' });
  applyMove(g, candidate.move, { inputMethod: 'interactive-board' });
  assert.equal(g.log[0].type, 'move');
  assert.equal(g.log[0].inputMethod, 'interactive-board');
  assert.equal(g.log[1].type, 'roll');
  assert.equal(g.log[1].inputMethod, 'interactive-board');
});