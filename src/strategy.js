import { ROLLS, FINISH, HOME, ROUTES, routeChoicesForNode } from './board.js';
import { cloneGame, legalMoves, applyRoll, applyMove, scoreBand } from './engine.js';
import { ROLL_KEYS, distributionFor, getProbabilityModel } from './probabilities.js';

const SEARCH_DEPTH = 3;
const MOVE_SEARCH_DEPTH = 2;
const GOLD_THRESHOLD = 220;
const EQUIVALENCE_TOLERANCE = 120;
const GOLD_CHANCE_TOLERANCE = 0.0025;
const WIN_CHANCE_TOLERANCE = 0.0075;
const PROJECTED_POINTS_TOLERANCE = 1.5;
const THROWS_TOLERANCE = 0.15;
const CAPTURE_RISK_TOLERANCE = 0.015;

// Recommendation-level caches avoid repeating the same depth-limited search several
// times during one UI render (board highlight, recommendation card, click metadata).
const rollRecommendationCache = new Map();
const moveRecommendationCache = new Map();
const CACHE_LIMIT = 120;

function remember(cache, key, value) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, value);
  return value;
}

function probabilityModelKey(model) {
  const confidence = model.confidence?.evidenceWeight ?? 0;
  return `${model.source}:${model.sample.cpuRolls}:${model.sample.selectedPlayerRolls}:${model.selectionMultiplier.toFixed(4)}:${confidence.toFixed(4)}`;
}

const STRATEGIC_NODE_BONUS = {
  O1: 1350,
  O5: 520,
  O10: 1450,
  O15: 280,
  C: 700
};

function opponentOf(actor) {
  return actor === 'player' ? 'computer' : 'player';
}

function routeRemaining(routeName, node) {
  const route = ROUTES[routeName];
  if (!route) return Infinity;
  const idx = route.indexOf(node);
  if (idx < 0) return Infinity;
  return route.length - 1 - idx;
}

function effectiveRemaining(piece) {
  if (piece.finished || piece.node === FINISH) return 0;
  if (piece.node === HOME) return 20;

  const choices = new Set([piece.route, ...routeChoicesForNode(piece.node, piece.route)]);
  let best = Infinity;
  for (const routeName of choices) {
    best = Math.min(best, routeRemaining(routeName, piece.node));
  }
  return Number.isFinite(best) ? best : 20;
}

function groupedPieces(pieces) {
  const groups = new Map();
  for (const piece of pieces) {
    if (piece.finished || piece.node === HOME) continue;
    if (!groups.has(piece.node)) groups.set(piece.node, []);
    groups.get(piece.node).push(piece);
  }
  return groups;
}

function captureThreat(game, actor, model = getProbabilityModel()) {
  const opponent = opponentOf(actor);
  if (game.winner || game.turn !== opponent) {
    return {
      weightedRisk: 0, exposedPieces: 0, stackAtRisk: false,
      stackCaptureProbability: 0, expectedProgressLoss: 0, outcomes: []
    };
  }

  const ownByNode = groupedPieces(game[actor]);
  if (!ownByNode.size) {
    return {
      weightedRisk: 0, exposedPieces: 0, stackAtRisk: false,
      stackCaptureProbability: 0, expectedProgressLoss: 0, outcomes: []
    };
  }

  const distribution = distributionFor(opponent, null, model);
  let weightedRisk = 0;
  let exposedPieces = 0;
  let stackAtRisk = false;
  let stackCaptureProbability = 0;
  let expectedProgressLoss = 0;
  const outcomes = [];

  for (const rollKey of ROLL_KEYS) {
    const probability = distribution[rollKey] ?? 0;
    if (!probability) continue;
    const moves = legalMoves(game, opponent, rollKey);
    let best = null;
    for (const move of moves) {
      const targets = ownByNode.get(move.to) ?? [];
      if (!targets.length) continue;
      const progressLoss = targets.reduce((sum, piece) => {
        const routeProgress = Math.max(0, 20 - effectiveRemaining(piece));
        const strategicProgress = (STRATEGIC_NODE_BONUS[piece.node] ?? 0) / 320;
        const o1FinishExposure = piece.node === 'O1' ? 7 : 0;
        return sum + routeProgress + strategicProgress + o1FinishExposure;
      }, 0);
      const damage = targets.length * 10 + progressLoss;
      if (!best || damage > best.damage) {
        best = { move, targets, progressLoss, damage };
      }
    }
    if (!best) continue;
    const captured = best.targets.length;
    weightedRisk += captured * probability;
    expectedProgressLoss += best.progressLoss * probability;
    exposedPieces = Math.max(exposedPieces, captured);
    if (captured >= 2) {
      stackAtRisk = true;
      stackCaptureProbability += probability;
    }
    outcomes.push({
      rollKey, probability, captured, node: best.move.to,
      progressLoss: best.progressLoss
    });
  }

  return {
    weightedRisk, exposedPieces, stackAtRisk,
    stackCaptureProbability, expectedProgressLoss, outcomes
  };
}

function nextTurnCapturePotential(game, actor, model = getProbabilityModel()) {
  if (game.winner) return 0;
  const opponent = opponentOf(actor);
  const opponentByNode = groupedPieces(game[opponent]);
  if (!opponentByNode.size) return 0;

  const distribution = distributionFor(actor, null, model);
  let expected = 0;
  for (const rollKey of ROLL_KEYS) {
    let best = 0;
    for (const move of legalMoves(game, actor, rollKey)) {
      best = Math.max(best, (opponentByNode.get(move.to) ?? []).length);
    }
    expected += best * (distribution[rollKey] ?? 0);
  }
  return expected;
}

function estimatedThrowsToFinish(game, actor) {
  const unfinished = game[actor].filter(piece => !piece.finished);
  if (!unfinished.length) return 0;

  // Stacked pieces travel together, so estimate each occupied group once.
  const groups = [];
  const seen = new Set();
  for (const piece of unfinished) {
    const key = piece.node === HOME ? piece.id : `${piece.node}:${piece.route}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const same = piece.node === HOME
      ? [piece]
      : unfinished.filter(p => p.node === piece.node && p.route === piece.route);
    groups.push(same);
  }

  let throws = 0;
  for (const group of groups) {
    const piece = group[0];
    if (piece.node === 'O1') {
      // O1 has the unique Back Do finish line, so ordinary distance is misleading.
      throws += 1.6;
      continue;
    }
    const remaining = effectiveRemaining(piece);
    // This is a leaf heuristic only. The actual near-term outcomes are handled by expectimax.
    throws += Math.max(1, remaining / 2.9);
  }
  return throws;
}

function projectedRewardPoints(game) {
  if (game.winner) return game.points;
  const unfinished = game.player.filter(piece => !piece.finished).length;
  const finishCredits = unfinished * 10;
  const estimatedThrowCost = estimatedThrowsToFinish(game, 'player') * 10;
  return game.points + finishCredits - estimatedThrowCost;
}

function normalCdf(z) {
  // Fast erf approximation; sufficient for a bounded heuristic estimate.
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf = sign * (1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x));
  return 0.5 * (1 + erf);
}

function goldChanceEstimate(game) {
  if (game.winner) return game.winner === 'player' && game.points >= GOLD_THRESHOLD ? 1 : 0;

  const unfinished = game.player.filter(piece => !piece.finished).length;
  const finishCredits = unfinished * 10;
  const paidThrowBudget = (game.points + finishCredits - GOLD_THRESHOLD) / 10;
  if (paidThrowBudget < 0) return 0;

  const meanPaidThrows = estimatedThrowsToFinish(game, 'player');
  // Conservative uncertainty around the leaf estimate. Future capture points are
  // intentionally excluded: they are upside, not guaranteed Gold budget.
  const sigma = Math.max(1.2, meanPaidThrows * 0.4);
  const z = (paidThrowBudget + 0.5 - meanPaidThrows) / sigma;
  return Math.max(0, Math.min(1, normalCdf(z)));
}

function goldPotential(game) {
  return goldChanceEstimate(game);
}

function winPotential(game) {
  if (game.winner) return game.winner === 'player' ? 1 : 0;
  const ownFinished = game.player.filter(p => p.finished).length;
  const cpuFinished = game.computer.filter(p => p.finished).length;
  const ownRemaining = game.player.reduce((sum, p) => sum + effectiveRemaining(p), 0);
  const cpuRemaining = game.computer.reduce((sum, p) => sum + effectiveRemaining(p), 0);
  const advantage = (ownFinished - cpuFinished) * 0.22 + (cpuRemaining - ownRemaining) / 80;
  return Math.max(0, Math.min(1, 0.5 + advantage));
}

function boardValue(game, actor = 'player', model = getProbabilityModel()) {
  const opponent = opponentOf(actor);
  if (game.winner === actor) {
    const band = actor === 'player' ? scoreBand(game.points) : 'Bronze';
    if (actor === 'player' && band === 'Gold') return 10_000_000 + game.points * 100;
    return 3_000_000 + (actor === 'player' ? game.points * 50 : 0);
  }
  if (game.winner === opponent) return -10_000_000;

  let value = 0;
  const own = game[actor];
  const opp = game[opponent];

  const ownFinished = own.filter(p => p.finished).length;
  const oppFinished = opp.filter(p => p.finished).length;
  value += ownFinished * 22_000;
  value -= oppFinished * 19_000;

  for (const piece of own) {
    if (piece.finished) continue;
    const remaining = effectiveRemaining(piece);
    value += (20 - remaining) * 320;
    value += STRATEGIC_NODE_BONUS[piece.node] ?? 0;
  }

  for (const piece of opp) {
    if (piece.finished) continue;
    const remaining = effectiveRemaining(piece);
    value -= (20 - remaining) * 210;
  }

  const ownGroups = groupedPieces(own);
  for (const [node, pieces] of ownGroups.entries()) {
    if (pieces.length < 2) continue;
    const remaining = Math.min(...pieces.map(effectiveRemaining));
    value += 900;
    if (remaining <= 8) value += 850;
    if (remaining <= 4) value += 1000;
    if (node === 'O1') value += 2600;
    if (node === 'O10' || node === 'C') value += 900;
  }

  const oppGroups = groupedPieces(opp);
  for (const pieces of oppGroups.values()) {
    if (pieces.length >= 2) value -= 600;
  }

  const threat = captureThreat(game, actor, model);
  // Capture exposure is priced as expected reset damage, not merely the number
  // of pieces on the target square. Losing a two-piece stack must hurt much more
  // than losing one early piece.
  value -= threat.weightedRisk * 5200;
  value -= threat.expectedProgressLoss * 520;
  value -= threat.stackCaptureProbability * 7200;
  value += nextTurnCapturePotential(game, actor, model) * 900;

  if (actor === 'player') {
    // Gold remains the primary strategic objective, but avoid the old threshold
    // cliff that could make a risky stack look artificially superior solely
    // because it reduced the leaf throw estimate.
    const projected = projectedRewardPoints(game);
    const projectedMargin = Math.max(-120, Math.min(80, projected - GOLD_THRESHOLD));
    value += game.points * 42;
    value += goldChanceEstimate(game) * 26_000;
    value += winPotential(game) * 10_000;
    value += projectedMargin * 32;
  }

  if (game.turn === actor && game.bonusThrow) value += 1700;
  return value;
}

function transitionFacts(before, after, actor, move) {
  const opponent = opponentOf(actor);
  const beforeOppHome = before[opponent].filter(p => p.node === HOME).length;
  const afterOppHome = after[opponent].filter(p => p.node === HOME).length;
  const beforeFinished = before[actor].filter(p => p.finished).length;
  const afterFinished = after[actor].filter(p => p.finished).length;
  const captured = Math.max(0, afterOppHome - beforeOppHome);
  const finished = Math.max(0, afterFinished - beforeFinished);
  const ownAtDestination = move.to === FINISH
    ? 0
    : after[actor].filter(p => !p.finished && p.node === move.to).length;

  return {
    captured,
    finished,
    formedStack: ownAtDestination === 2 && move.pieceIds.length === 1,
    movedStack: move.pieceIds.length === 2,
    shortcut: move.route !== 'OUTER',
    remaining: move.to === FINISH
      ? 0
      : Math.min(...after[actor].filter(p => move.pieceIds.includes(p.id)).map(effectiveRemaining))
  };
}

function resolvePass(game) {
  if (!game.pendingRoll) return game;
  const { actor, grantsBonus } = game.pendingRoll;
  const opponent = opponentOf(actor);
  game.pendingRoll = null;
  if (grantsBonus) {
    game.turn = actor;
    game.bonusThrow = true;
  } else {
    game.turn = opponent;
    game.bonusThrow = false;
  }
  return game;
}

function stateKey(game, depth) {
  const pieces = ['player', 'computer'].flatMap(actor => game[actor].map(p => `${p.id}:${p.node}:${p.route}:${p.finished ? 1 : 0}`)).join('|');
  return `${depth};${game.turn};${game.bonusThrow ? 1 : 0};${game.points};${game.throws};${game.winner ?? '-'};${pieces}`;
}

function searchTurn(game, depth, model, memo) {
  if (game.winner || depth <= 0) return boardValue(game, 'player', model);
  const key = stateKey(game, depth);
  if (memo.has(key)) return memo.get(key);

  let value;
  if (game.turn === 'player') {
    value = -Infinity;
    for (const selected of ROLL_KEYS) {
      value = Math.max(value, evaluatePlayerSelection(game, selected, depth, model, memo).value);
    }
  } else {
    value = evaluateCpuChance(game, depth, model, memo);
  }

  memo.set(key, value);
  return value;
}

function continuationAfterMove(afterRoll, move, depthAfterRoll, model, memo) {
  const next = cloneGame(afterRoll);
  applyMove(next, move);
  return searchTurn(next, depthAfterRoll, model, memo);
}

function evaluateRollForActor(game, actor, actualRoll, depth, model, memo) {
  const afterRoll = cloneGame(game);
  applyRoll(afterRoll, actor, actualRoll, { bonus: afterRoll.bonusThrow });
  const moves = legalMoves(afterRoll, actor, actualRoll);
  const nextDepth = depth - 1;

  if (!moves.length) {
    resolvePass(afterRoll);
    return { value: searchTurn(afterRoll, nextDepth, model, memo), bestMove: null, bestAfter: afterRoll };
  }

  const scored = moves.map(move => {
    const after = cloneGame(afterRoll);
    applyMove(after, move);
    return { move, after, value: searchTurn(after, nextDepth, model, memo) };
  });

  scored.sort((a, b) => actor === 'player' ? b.value - a.value : a.value - b.value);
  return { value: scored[0].value, bestMove: scored[0].move, bestAfter: scored[0].after, alternatives: scored };
}

function evaluatePlayerSelection(game, selectedProbability, depth, model, memo) {
  const distribution = distributionFor('player', selectedProbability, model);
  let expected = 0;
  const outcomes = [];
  for (const actualRoll of ROLL_KEYS) {
    const probability = distribution[actualRoll] ?? 0;
    if (!probability) continue;
    const result = evaluateRollForActor(game, 'player', actualRoll, depth, model, memo);
    expected += probability * result.value;
    outcomes.push({ actualRoll, probability, ...result });
  }
  return { value: expected, selectedProbability, outcomes };
}

function stateDecisionDiagnostics(after, model) {
  if (!after) {
    return {
      goldChance: 0,
      winChance: 0,
      projectedRewardPoints: -Infinity,
      estimatedThrowsToFinish: Infinity,
      captureRisk: Infinity
    };
  }
  const threat = captureThreat(after, 'player', model);
  return {
    goldChance: goldChanceEstimate(after),
    winChance: winPotential(after),
    projectedRewardPoints: projectedRewardPoints(after),
    estimatedThrowsToFinish: estimatedThrowsToFinish(after, 'player'),
    captureRisk: threat.weightedRisk
  };
}

function selectionDiagnostics(evaluated, model) {
  const metrics = {
    goldChance: 0,
    winChance: 0,
    projectedRewardPoints: 0,
    estimatedThrowsToFinish: 0,
    captureRisk: 0
  };
  for (const outcome of evaluated.outcomes ?? []) {
    const p = outcome.probability ?? 0;
    if (!p) continue;
    const row = stateDecisionDiagnostics(outcome.bestAfter, model);
    metrics.goldChance += p * row.goldChance;
    metrics.winChance += p * row.winChance;
    metrics.projectedRewardPoints += p * row.projectedRewardPoints;
    metrics.estimatedThrowsToFinish += p * row.estimatedThrowsToFinish;
    metrics.captureRisk += p * row.captureRisk;
  }
  return metrics;
}

function targetOutcomeDiagnostics(evaluated, rollKey, model) {
  const intended = evaluated.outcomes?.find(outcome => outcome.actualRoll === rollKey);
  return stateDecisionDiagnostics(intended?.bestAfter ?? null, model);
}

function compareDecisionMetrics(ad, bd) {
  const goldDiff = bd.goldChance - ad.goldChance;
  if (Math.abs(goldDiff) > GOLD_CHANCE_TOLERANCE) return goldDiff;

  const winDiff = bd.winChance - ad.winChance;
  if (Math.abs(winDiff) > WIN_CHANCE_TOLERANCE) return winDiff;

  const projectedDiff = bd.projectedRewardPoints - ad.projectedRewardPoints;
  if (Math.abs(projectedDiff) > PROJECTED_POINTS_TOLERANCE) return projectedDiff;

  const throwsDiff = ad.estimatedThrowsToFinish - bd.estimatedThrowsToFinish;
  if (Math.abs(throwsDiff) > THROWS_TOLERANCE) return throwsDiff;

  const riskDiff = ad.captureRisk - bd.captureRisk;
  if (Math.abs(riskDiff) > CAPTURE_RISK_TOLERANCE) return riskDiff;
  return 0;
}

function compareRollRows(a, b) {
  // Primary ranking: expected outcomes under the calibrated selection model.
  const expectedDiff = compareDecisionMetrics(a.selectionDiagnostics, b.selectionDiagnostics);
  if (expectedDiff) return expectedDiff;

  // When the current data says selection has little/no measurable effect, every
  // option can have identical expected utility. Do not let array order silently
  // choose Back Do. Use the quality of the requested target line as an explicit,
  // low-confidence secondary ordering for the UI selection that Metin2 requires.
  const targetDiff = compareDecisionMetrics(a.targetDiagnostics, b.targetDiagnostics);
  if (targetDiff) return targetDiff;

  const valueDiff = b.value - a.value;
  if (Math.abs(valueDiff) > 1e-6) return valueDiff;

  // Stable final fallback only; this is never presented as probability evidence.
  return ROLL_KEYS.indexOf(a.rollKey) - ROLL_KEYS.indexOf(b.rollKey);
}

function evaluateCpuChance(game, depth, model, memo) {
  const distribution = distributionFor('computer', null, model);
  let expected = 0;
  for (const actualRoll of ROLL_KEYS) {
    const probability = distribution[actualRoll] ?? 0;
    if (!probability) continue;
    const result = evaluateRollForActor(game, 'computer', actualRoll, depth, model, memo);
    expected += probability * result.value;
  }
  return expected;
}

function describeMove(before, after, actor, move, facts, model = getProbabilityModel()) {
  const reasons = [];
  if (after.winner === actor) reasons.push('wins the game');
  if (facts.finished === 2) reasons.push('finishes both pieces');
  else if (facts.finished === 1) reasons.push('finishes a piece');
  if (move.special === 'FIRST_NODE_BACK_DO_FINISH') reasons.push('Back Do from O1 → Finish');
  if (facts.captured === 2) reasons.push('captures a 2-piece stack');
  else if (facts.captured === 1) reasons.push('captures a CPU piece');
  if (facts.formedStack) reasons.push('stacks your pieces');
  if (move.to === 'O10') reasons.push('reaches the fast O10 shortcut');
  else if (move.to === 'C') reasons.push('reaches centre');
  else if (move.to === 'O5') reasons.push('opens the top-right shortcut');
  if (facts.shortcut && ['TL1', 'TL2', 'BR2', 'BR1'].includes(move.to)) reasons.push('uses the fast finish shortcut');
  if (after.turn === actor && after.bonusThrow) reasons.push('keeps the turn with a bonus throw');

  const threat = captureThreat(after, actor, model);
  if (threat.weightedRisk === 0 && move.to !== FINISH) reasons.push('avoids an immediate CPU capture line');
  else if (threat.stackAtRisk) reasons.push('stack is exposed to a CPU capture');

  if (!reasons.length) {
    if (facts.remaining <= 5) reasons.push('very close to Finish');
    else if (facts.remaining <= 9) reasons.push('strong route progress');
    else reasons.push('best multi-turn position');
  }
  return reasons;
}

function scorePendingMove(game, actor, move, model, memo) {
  const before = cloneGame(game);
  const after = cloneGame(game);
  applyMove(after, move);
  const facts = transitionFacts(before, after, actor, move);
  const value = searchTurn(after, MOVE_SEARCH_DEPTH, model, memo);
  return { value, reasons: describeMove(before, after, actor, move, facts, model), remaining: facts.remaining, facts };
}

function isOpeningState(game) {
  if (game.winner || game.player.some(p => p.finished)) return false;
  const normalRollsUsed = Math.max(0, 20 - game.throws);
  const maxProgress = Math.max(...game.player.map(p => 20 - effectiveRemaining(p)));
  return normalRollsUsed <= 5 && maxProgress <= 8;
}

function classifyOpeningPlan(game, row, model) {
  const intended = row.outcomes.find(outcome => outcome.actualRoll === row.rollKey);
  const move = intended?.bestMove ?? null;
  const after = intended?.bestAfter ?? null;
  if (!move || !after) {
    return { key: 'FLEXIBLE', label: 'Flexible opening', explanation: 'Keeps multiple routes available while the roll model is still uncertain.' };
  }

  const facts = transitionFacts(game, after, 'player', move);
  if (row.rollKey === 'DO' && move.from === HOME && move.to === 'O1') {
    const threat = captureThreat(after, 'player', model);
    return {
      key: 'EARLY_FINISH',
      label: 'Early Finish',
      explanation: facts.captured > 0
        ? 'Target O1, capture the CPU piece, then look for Back Do to Finish early.'
        : threat.weightedRisk > 0
          ? 'Target O1, then Back Do; multi-turn search discounts the line for CPU capture risk.'
          : 'Target O1, then Back Do for the shortest early Finish line.'
    };
  }

  if (facts.captured > 0) {
    return {
      key: 'CAPTURE',
      label: 'Capture',
      explanation: `Target ${move.to} to reset ${facts.captured === 2 ? 'the CPU stack' : 'a CPU piece'} and delay its progress.`
    };
  }

  if (facts.formedStack || facts.movedStack) {
    return { key: 'STACK', label: 'Stack setup', explanation: 'Move both pieces more efficiently while balancing capture exposure.' };
  }

  if (move.to === 'O5' || move.to === 'O10' || move.route !== 'OUTER') {
    return { key: 'SHORTCUT', label: 'Shortcut setup', explanation: 'Position for a forced diagonal and a shorter route to Finish.' };
  }

  if (ROLLS[row.rollKey]?.bonus) {
    return { key: 'BONUS_TEMPO', label: 'Bonus tempo', explanation: 'Target a bonus-throw result to keep initiative and compound progress.' };
  }

  return { key: 'PROGRESS', label: 'Positioning', explanation: 'Best expected multi-turn balance of reward score, safety and progress.' };
}

function telemetryNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function telemetryMove(move) {
  if (!move) return null;
  return {
    pieceIds: [...move.pieceIds],
    from: move.from,
    to: move.to,
    route: move.route,
    special: move.special ?? null
  };
}

function telemetryStateDiagnostics(game, actor = 'player', model = getProbabilityModel()) {
  const threat = captureThreat(game, actor, model);
  return {
    points: game.points,
    rewardBand: scoreBand(game.points),
    projectedRewardPoints: telemetryNumber(projectedRewardPoints(game)),
    goldPotentialProxy: telemetryNumber(goldPotential(game), 4),
    goldChanceEstimate: telemetryNumber(goldChanceEstimate(game), 4),
    winPotentialProxy: telemetryNumber(winPotential(game), 4),
    estimatedThrowsToFinish: telemetryNumber(estimatedThrowsToFinish(game, actor)),
    immediateCaptureRisk: telemetryNumber(threat.weightedRisk, 4),
    stackAtRisk: Boolean(threat.stackAtRisk),
    playerFinished: game.player.filter(p => p.finished).length,
    computerFinished: game.computer.filter(p => p.finished).length
  };
}

/**
 * Serialize the already-computed Strategy v2 probability recommendation into a
 * compact, analysis-friendly snapshot. Utilities are internal relative scores,
 * never probabilities or predicted win rates. This function does not influence
 * recommendation ranking.
 */
export function buildRollTelemetry(game, recommendation = recommendRoll(game, 'player'), selectedProbability = null) {
  if (!recommendation?.best) return null;
  const model = getProbabilityModel();
  const bestValue = recommendation.best.value;
  const alternatives = recommendation.alternatives.map((row, index) => {
    const intended = row.details?.outcomes?.find(outcome => outcome.actualRoll === row.rollKey);
    const after = intended?.bestAfter ?? null;
    return {
      rank: index + 1,
      rollKey: row.rollKey,
      utility: telemetryNumber(row.value),
      utilityGapFromBest: telemetryNumber(bestValue - row.value),
      plan: row.plan ? { key: row.plan.key, label: row.plan.label } : null,
      reason: row.reason,
      decisionMetrics: row.selectionDiagnostics ? {
        goldChanceEstimate: telemetryNumber(row.selectionDiagnostics.goldChance, 4),
        winPotentialProxy: telemetryNumber(row.selectionDiagnostics.winChance, 4),
        projectedRewardPoints: telemetryNumber(row.selectionDiagnostics.projectedRewardPoints),
        estimatedThrowsToFinish: telemetryNumber(row.selectionDiagnostics.estimatedThrowsToFinish),
        captureRisk: telemetryNumber(row.selectionDiagnostics.captureRisk, 4)
      } : null,
      targetLineMetrics: row.targetDiagnostics ? {
        goldChanceEstimate: telemetryNumber(row.targetDiagnostics.goldChance, 4),
        winPotentialProxy: telemetryNumber(row.targetDiagnostics.winChance, 4),
        projectedRewardPoints: telemetryNumber(row.targetDiagnostics.projectedRewardPoints),
        estimatedThrowsToFinish: telemetryNumber(row.targetDiagnostics.estimatedThrowsToFinish),
        captureRisk: telemetryNumber(row.targetDiagnostics.captureRisk, 4)
      } : null,
      intendedMove: telemetryMove(row.bestMove),
      intendedState: after ? telemetryStateDiagnostics(after, 'player', model) : null
    };
  });
  const chosen = selectedProbability ? alternatives.find(row => row.rollKey === selectedProbability) ?? null : null;

  return {
    kind: 'probability-decision',
    engineVersion: recommendation.version ?? 'v2',
    horizon: recommendation.horizon ?? SEARCH_DEPTH,
    utilityScale: 'internal-relative-not-percentage',
    rankingBasis: 'Gold chance estimate → win potential → projected points → throws → safety → search utility',
    probabilityModel: { ...recommendation.probabilityModel },
    recommendation: {
      rollKey: recommendation.best.rollKey,
      utility: telemetryNumber(recommendation.best.value),
      plan: recommendation.best.plan ? { key: recommendation.best.plan.key, label: recommendation.best.plan.label } : null,
      reason: recommendation.best.reason
    },
    selectedChoice: chosen ? {
      rollKey: chosen.rollKey,
      rank: chosen.rank,
      utility: chosen.utility,
      utilityGapFromBest: chosen.utilityGapFromBest
    } : null,
    alternatives
  };
}

/**
 * Serialize a move recommendation and the player's actual choice before the
 * move is applied. This lets later analysis compare Helper vs player decisions
 * without changing Strategy v2 itself.
 */
export function buildMoveTelemetry(game, recommendation = recommendMove(game, 'player'), actualMove = null) {
  if (!recommendation?.alternatives?.length) return null;
  const model = getProbabilityModel();
  const bestValue = recommendation.alternatives[0].value;
  const alternatives = recommendation.alternatives.map((row, index) => {
    const after = cloneGame(game);
    applyMove(after, row.move);
    return {
      rank: index + 1,
      move: telemetryMove(row.move),
      utility: telemetryNumber(row.value),
      utilityGapFromBest: telemetryNumber(bestValue - row.value),
      reasons: [...(row.reasons ?? [])],
      facts: row.facts ? {
        captured: row.facts.captured,
        finished: row.facts.finished,
        formedStack: Boolean(row.facts.formedStack),
        movedStack: Boolean(row.facts.movedStack),
        shortcut: Boolean(row.facts.shortcut),
        remaining: row.facts.remaining
      } : null,
      resultingState: telemetryStateDiagnostics(after, 'player', model)
    };
  });
  const actual = actualMove ? alternatives.find(row => {
    const move = row.move;
    return move.from === actualMove.from && move.to === actualMove.to && move.route === actualMove.route
      && move.pieceIds.join('+') === actualMove.pieceIds.join('+');
  }) ?? null : null;

  return {
    kind: 'move-decision',
    engineVersion: recommendation.version ?? 'v2',
    horizon: MOVE_SEARCH_DEPTH,
    utilityScale: 'internal-relative-not-percentage',
    equivalentBest: Boolean(recommendation.equivalent),
    recommendation: {
      move: telemetryMove(recommendation.best?.move ?? null),
      utility: telemetryNumber(recommendation.best?.value),
      reason: recommendation.reason
    },
    actualChoice: actual ? {
      move: actual.move,
      rank: actual.rank,
      utility: actual.utility,
      utilityGapFromBest: actual.utilityGapFromBest
    } : null,
    alternatives
  };
}

export function evaluateOpeningPlans(game, actor = 'player', model = getProbabilityModel()) {
  if (actor !== 'player' || !isOpeningState(game)) return [];
  const memo = new Map();
  const rows = ROLL_KEYS.map(rollKey => {
    const evaluated = evaluatePlayerSelection(game, rollKey, SEARCH_DEPTH, model, memo);
    const row = {
      rollKey,
      value: evaluated.value,
      outcomes: evaluated.outcomes,
      selectionDiagnostics: selectionDiagnostics(evaluated, model),
      targetDiagnostics: targetOutcomeDiagnostics(evaluated, rollKey, model)
    };
    return { ...row, plan: classifyOpeningPlan(game, row, model) };
  }).sort(compareRollRows);
  return rows;
}

export function recommendRoll(game, actor = 'player') {
  if (game.winner || actor !== 'player' || game.turn !== actor || game.pendingRoll) return null;
  const model = getProbabilityModel();
  const cacheKey = `roll:${probabilityModelKey(model)}:${stateKey(game, SEARCH_DEPTH)}`;
  if (rollRecommendationCache.has(cacheKey)) return rollRecommendationCache.get(cacheKey);
  const memo = new Map();
  const opening = isOpeningState(game);

  const rows = ROLL_KEYS.map(rollKey => {
    const evaluated = evaluatePlayerSelection(game, rollKey, SEARCH_DEPTH, model, memo);
    const row = {
      rollKey,
      value: evaluated.value,
      outcomes: evaluated.outcomes,
      selectionDiagnostics: selectionDiagnostics(evaluated, model),
      targetDiagnostics: targetOutcomeDiagnostics(evaluated, rollKey, model)
    };
    const plan = opening ? classifyOpeningPlan(game, row, model) : null;
    const intended = evaluated.outcomes.find(outcome => outcome.actualRoll === rollKey);
    const intendedMove = intended?.bestMove ?? null;
    let reason;
    if (plan) {
      reason = `Opening strategy: ${plan.label}. ${plan.explanation}`;
    } else if (intendedMove && intended?.bestAfter) {
      const facts = transitionFacts(game, intended.bestAfter, actor, intendedMove);
      reason = describeMove(game, intended.bestAfter, actor, intendedMove, facts, model).join(' · ');
    } else {
      reason = 'Best provisional multi-turn line from the current board state.';
    }

    return {
      rollKey,
      value: evaluated.value,
      bestMove: intendedMove,
      reason,
      plan,
      details: evaluated,
      selectionDiagnostics: row.selectionDiagnostics,
      targetDiagnostics: row.targetDiagnostics
    };
  }).sort(compareRollRows);

  return remember(rollRecommendationCache, cacheKey, {
    best: rows[0],
    alternatives: rows,
    version: 'v2',
    horizon: SEARCH_DEPTH,
    probabilityModel: {
      source: model.source,
      cpuRolls: model.sample.cpuRolls,
      selectedPlayerRolls: model.sample.selectedPlayerRolls,
      selectionMultiplier: model.selectionMultiplier,
      rawSelectionMultiplier: model.rawSelectionMultiplier,
      confidence: model.confidence ? { ...model.confidence } : null
    }
  });
}

export function recommendMove(game, actor = 'player') {
  if (game.winner || !game.pendingRoll || game.pendingRoll.actor !== actor) return null;
  const rollKey = game.pendingRoll.rollKey;
  const moves = legalMoves(game, actor, rollKey);
  if (!moves.length) return { best: null, alternatives: [], equivalent: false, reason: 'No legal move', version: 'v2' };

  const model = getProbabilityModel();
  const cacheKey = `move:${probabilityModelKey(model)}:${stateKey(game, MOVE_SEARCH_DEPTH)}:${game.pendingRoll.rollKey}`;
  if (moveRecommendationCache.has(cacheKey)) return moveRecommendationCache.get(cacheKey);
  const memo = new Map();
  const rows = moves.map(move => ({ move, ...scorePendingMove(game, actor, move, model, memo) }))
    .sort((a, b) => b.value - a.value);

  const bestValue = rows[0].value;
  const tiedBest = rows.filter(row => Math.abs(row.value - bestValue) <= EQUIVALENCE_TOLERANCE);
  const equivalent = tiedBest.length > 1;

  return remember(moveRecommendationCache, cacheKey, {
    best: rows[0],
    tiedBest,
    alternatives: rows,
    equivalent,
    reason: equivalent
      ? 'These moves are effectively equivalent in the current multi-turn search.'
      : rows[0].reasons.join(' · '),
    version: 'v2'
  });
}

export const __strategyInternals = {
  effectiveRemaining,
  captureThreat,
  boardValue,
  projectedRewardPoints,
  goldPotential,
  goldChanceEstimate,
  winPotential,
  selectionDiagnostics,
  targetOutcomeDiagnostics,
  compareRollRows,
  estimatedThrowsToFinish,
  isOpeningState,
  searchTurn,
  classifyOpeningPlan
};