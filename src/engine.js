import { FINISH, HOME, ROLLS, ROUTES, routeChoicesForNode } from './board.js';

export function createPiece(id) {
  return { id, node: HOME, route: 'OUTER', finished: false };
}

export function createGame() {
  return {
    phase: 'INITIAL_TOSS',
    points: 250,
    throws: 20,
    turn: null,
    bonusThrow: false,
    player: [createPiece('P1'), createPiece('P2')],
    computer: [createPiece('C1'), createPiece('C2')],
    winner: null,
    lastRoll: { player: null, computer: null },
    log: []
  };
}

export function cloneGame(game) {
  return structuredClone(game);
}

export function startGame(game, starter) {
  if (game.phase !== 'INITIAL_TOSS') throw new Error('Game has already started.');
  if (!['player', 'computer'].includes(starter)) throw new Error(`Unknown starter: ${starter}`);
  game.phase = 'PLAYING';
  game.turn = starter;
  game.log.unshift({ type: 'start', starter });
  return game;
}

function routeIndex(route, node) {
  return ROUTES[route]?.indexOf(node) ?? -1;
}

function moveOnRoute(piece, steps, routeName) {
  const route = ROUTES[routeName];
  const idx = routeIndex(routeName, piece.node);
  if (idx < 0) return null;
  const targetIndex = idx + steps;
  if (targetIndex < 0) return null;

  // In the live client, a forward throw may complete a piece even when the
  // throw contains more steps than remain before Finish. This matters most at
  // Centre: Yut/Mo can take the centre -> bottom-right diagonal and finish.
  if (targetIndex >= route.length) {
    if (steps > 0 && route.at(-1) === FINISH) {
      return { node: FINISH, route: routeName, special: 'CROSSES_FINISH' };
    }
    return null;
  }

  const target = route[targetIndex];
  return { node: target, route: routeName };
}

function forwardFromHome(steps) {
  if (steps <= 0) return null;
  if (steps >= 20) return { node: FINISH, route: 'OUTER' };
  return { node: `O${steps}`, route: 'OUTER' };
}

export function destinationsForPiece(piece, rollKey) {
  if (piece.finished) return [];
  const roll = ROLLS[rollKey];
  if (!roll) throw new Error(`Unknown roll: ${rollKey}`);

  if (piece.node === HOME) {
    const dest = forwardFromHome(roll.steps);
    return dest ? [dest] : [];
  }

  // Confirmed in the 2026 client: Back Do from the first outer node reaches Start/Finish and completes the piece.
  if (roll.steps === -1 && piece.node === 'O1') {
    return [{ node: FINISH, route: 'OUTER', special: 'FIRST_NODE_BACK_DO_FINISH' }];
  }

  if (roll.steps < 0) {
    const dest = moveOnRoute(piece, roll.steps, piece.route);
    return dest ? [dest] : [];
  }

  const routes = routeChoicesForNode(piece.node, piece.route);
  const unique = new Map();
  for (const route of routes) {
    const dest = moveOnRoute(piece, roll.steps, route);
    if (dest) unique.set(`${dest.node}:${dest.route}`, dest);
  }

  if (!unique.size) {
    const dest = moveOnRoute(piece, roll.steps, piece.route);
    if (dest) unique.set(`${dest.node}:${dest.route}`, dest);
  }

  return [...unique.values()];
}

export function getStack(piece, pieces) {
  if (piece.finished || piece.node === HOME) return [piece];
  return pieces.filter(p => !p.finished && p.node === piece.node);
}

export function legalMoves(game, actor, rollKey) {
  if (game.phase !== 'PLAYING') return [];
  const pieces = game[actor];
  const seenStacks = new Set();
  const moves = [];

  for (const piece of pieces) {
    const stack = getStack(piece, pieces);
    const stackKey = stack.map(p => p.id).sort().join('+');
    if (seenStacks.has(stackKey)) continue;
    seenStacks.add(stackKey);

    for (const destination of destinationsForPiece(piece, rollKey)) {
      moves.push({
        actor,
        pieceIds: stack.map(p => p.id),
        from: piece.node,
        to: destination.node,
        route: destination.route,
        special: destination.special ?? null
      });
    }
  }
  return moves;
}

function piecesAt(pieces, node) {
  return pieces.filter(p => !p.finished && p.node === node);
}

function markFinished(piece) {
  piece.node = FINISH;
  piece.finished = true;
}

function resetHome(piece) {
  piece.node = HOME;
  piece.route = 'OUTER';
  piece.finished = false;
}

export function applyRoll(game, actor, rollKey, { bonus = game.bonusThrow, selectedProbability = null, recommendedProbability = null } = {}) {
  if (game.phase !== 'PLAYING') throw new Error('Complete the initial toss first.');
  if (game.winner) return game;
  if (game.turn !== actor) throw new Error(`It is ${game.turn}'s turn, not ${actor}'s.`);
  const roll = ROLLS[rollKey];
  game.lastRoll[actor] = rollKey;

  if (actor === 'player' && !bonus) {
    game.points -= 10;
    game.throws = Math.max(0, game.throws - 1);
  }

  game.bonusThrow = false;
  game.pendingRoll = { actor, rollKey, bonus, grantsBonus: Boolean(roll.bonus) };
  game.log.unshift({ type: 'roll', actor, rollKey, bonus, selectedProbability: actor === 'player' ? selectedProbability : null, recommendedProbability: actor === 'player' ? recommendedProbability : null });
  return game;
}

export function applyMove(game, move, metadata = {}) {
  if (!game.pendingRoll) throw new Error('No pending roll.');
  const actor = move.actor;
  const own = game[actor];
  const opponentActor = actor === 'player' ? 'computer' : 'player';
  const opponent = game[opponentActor];
  const moving = own.filter(p => move.pieceIds.includes(p.id));

  let captured = [];
  let finishedCount = 0;

  if (move.to !== FINISH) {
    captured = piecesAt(opponent, move.to);
    for (const piece of captured) resetHome(piece);
  }

  for (const piece of moving) {
    piece.route = move.route;
    if (move.to === FINISH) {
      markFinished(piece);
      finishedCount += 1;
    } else {
      piece.node = move.to;
      piece.finished = false;
    }
  }

  if (actor === 'player') {
    game.points += captured.length * 10;
    game.points += finishedCount * 10;
  } else {
    game.points -= captured.length * 10;
    game.points -= finishedCount * 10;
  }

  const grantsBonus = game.pendingRoll.grantsBonus;
  game.log.unshift({
    type: 'move', actor, pieceIds: move.pieceIds, from: move.from, to: move.to,
    route: move.route, captured: captured.map(p => p.id), finishedCount,
    special: move.special ?? null,
    recommendedMove: metadata.recommendedMove ?? null
  });
  game.pendingRoll = null;

  const playerFinished = game.player.filter(p => p.finished).length;
  const computerFinished = game.computer.filter(p => p.finished).length;
  if (playerFinished === 2) game.winner = 'player';
  if (computerFinished === 2) {
    game.winner = 'computer';
    game.points = 0;
  }

  if (!game.winner) {
    if (grantsBonus) {
      game.bonusThrow = true;
      game.turn = actor;
    } else {
      game.turn = opponentActor;
    }
  }

  return game;
}

export function scoreBand(points) {
  if (points >= 220) return 'Gold';
  if (points >= 150) return 'Silver';
  return 'Bronze';
}

export function finishedCount(game, actor) {
  return game[actor].filter(p => p.finished).length;
}
