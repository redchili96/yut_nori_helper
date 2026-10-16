import { createGame, cloneGame, startGame, applyRoll, legalMoves, applyMove, scoreBand, finishedCount, observedMoveCandidates } from './engine.js';
import { ROLLS, NODE_POSITIONS, EDGES, HOME, FINISH } from './board.js';
import { recommendRoll, recommendMove, buildRollTelemetry, buildMoveTelemetry } from './strategy.js';
import { configureProbabilityModel } from './probabilities.js';
import { makeId, createSourceId, readArchive, writeArchive, upsertGame, buildGameRecord, exportBundle, mergeBundle, archiveToCsv } from './archive.js';
import { pushCheckpoint, undoState, redoState } from './timeline.js';

let game = createGame();
let pendingMoves = [];
let history = [];
let redoHistory = [];
let selectedProbability = null;
let boardSelection = null;
let boardInference = null;
let dragState = null;
let suppressBoardClickUntil = 0;
const HELPER_VERSION = '0.9.1';
const sourceId = createSourceId();
let session = { gameId: makeId('game'), startedAt: new Date().toISOString() };

const $ = sel => document.querySelector(sel);
const boardSvg = $('#board');

const RESYNC_POSITIONS = [
  { value: HOME, label: 'HOME / not on board' },
  ...Array.from({ length: 19 }, (_, i) => {
    const n = i + 1;
    const notes = { 1: 'first above Goal', 5: 'top-right corner', 10: 'top-left corner', 15: 'bottom-left corner' };
    return { value: `O${n}`, label: `O${n}${notes[n] ? ` — ${notes[n]}` : ''}` };
  }),
  { value: 'TR1', label: 'TR1 — top-right shortcut 1' },
  { value: 'TR2', label: 'TR2 — top-right shortcut 2' },
  { value: 'TL1', label: 'TL1 — top-left shortcut 1' },
  { value: 'TL2', label: 'TL2 — top-left shortcut 2' },
  { value: 'C', label: 'C — centre' },
  { value: 'BL2', label: 'BL2 — centre → bottom-left 1' },
  { value: 'BL1', label: 'BL1 — centre → bottom-left 2' },
  { value: 'BR2', label: 'BR2 — centre → Goal 1' },
  { value: 'BR1', label: 'BR1 — centre → Goal 2' },
  { value: FINISH, label: 'FINISHED / at Goal' }
];

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

function makeTimelineSnapshot(label = '') {
  return {
    label,
    game: cloneGame(game),
    pendingMoves: structuredClone(pendingMoves),
    selectedProbability
  };
}

function restoreTimelineSnapshot(snapshot) {
  game = snapshot.game;
  pendingMoves = snapshot.pendingMoves;
  selectedProbability = snapshot.selectedProbability ?? null;
  boardSelection = null;
  dragState = null;
  hideBoardInference();
  $('#resync-panel').classList.add('hidden');
}

function checkpoint(label) {
  pushCheckpoint(history, redoHistory, makeTimelineSnapshot(label));
}

function undoLast() {
  const snapshot = undoState(history, redoHistory, makeTimelineSnapshot());
  if (!snapshot) return;
  restoreTimelineSnapshot(snapshot);
  render();
}

function redoLast() {
  const snapshot = redoState(history, redoHistory, makeTimelineSnapshot());
  if (!snapshot) return;
  restoreTimelineSnapshot(snapshot);
  render();
}

function currentRecord(status = null) {
  return buildGameRecord({
    game,
    gameId: session.gameId,
    sourceId,
    helperVersion: HELPER_VERSION,
    startedAt: session.startedAt,
    status: status ?? (game.winner ? 'completed' : 'in-progress')
  });
}

function persistCurrentGame(status = null) {
  if (game.phase === 'INITIAL_TOSS' || !game.log.length) return;
  upsertGame(currentRecord(status));
  configureProbabilityModel(readArchive());
  renderArchiveCount();
}

function downloadText(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function safeDateLabel(value) {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value ?? '');
  }
}

function exportGamesJson(games, filename = 'yut-nori-logs.json') {
  const bundle = exportBundle(games, { sourceId, helperVersion: HELPER_VERSION });
  downloadText(filename, JSON.stringify(bundle, null, 2));
}

function renderArchiveCount() {
  const count = readArchive().length;
  const el = $('#history-count');
  if (el) el.textContent = count;
}

function summarizeArchive(games) {
  const completed = games.filter(g => g.status === 'completed');
  const wins = completed.filter(g => g.winner === 'player').length;
  const gold = completed.filter(g => g.finalBand === 'Gold').length;
  const playerRolls = games.flatMap(g => g.events ?? []).filter(e => e.type === 'roll' && e.actor === 'player').length;
  return { total: games.length, completed: completed.length, wins, gold, playerRolls };
}

function renderHistory() {
  const games = readArchive();
  renderArchiveCount();
  const summary = summarizeArchive(games);
  $('#archive-summary').innerHTML = `<span><b>${summary.total}</b> games</span><span><b>${summary.completed}</b> completed</span><span><b>${summary.wins}</b> wins</span><span><b>${summary.gold}</b> Gold</span><span><b>${summary.playerRolls}</b> player rolls</span>`;
  const list = $('#history-list');
  list.innerHTML = '';
  if (!games.length) {
    list.innerHTML = '<div class="archive-empty">No games saved yet.</div>';
    return;
  }
  for (const record of games) {
    const details = document.createElement('details');
    details.className = 'history-game';
    const summaryEl = document.createElement('summary');
    const statusLabel = record.status === 'completed' ? (record.winner === 'player' ? 'WIN' : 'LOSS') : record.status.toUpperCase();
    summaryEl.innerHTML = `<div><strong>${statusLabel} · ${record.finalBand}</strong><span>${safeDateLabel(record.startedAt)}</span></div><div class="history-meta"><b>${record.finalPoints}</b> pts · ${record.throwsRemaining} throws</div>`;
    details.appendChild(summaryEl);

    const body = document.createElement('div');
    body.className = 'history-game-body';
    const rolls = (record.events ?? []).filter(e => e.type === 'roll' && e.actor === 'player');
    const mapped = rolls.filter(e => e.selectedProbability).length;
    const strategyDecisions = (record.events ?? []).filter(e => e.strategyTelemetry).length;
    const info = document.createElement('div');
    info.className = 'history-stats';
    info.innerHTML = `<span>${record.helperVersion}</span><span>${record.events?.length ?? 0} events</span><span>${mapped}/${rolls.length} rolls with probability data</span>${strategyDecisions ? `<span>${strategyDecisions} strategy decisions</span>` : ''}`;
    body.appendChild(info);

    const eventList = document.createElement('div');
    eventList.className = 'history-events';
    for (const event of (record.events ?? []).slice(-12)) {
      const row = document.createElement('div');
      if (event.type === 'roll') {
        const prob = event.actor === 'player' && event.selectedProbability ? ` · selected ${rollLabel(event.selectedProbability)}` : '';
        row.textContent = `${event.actor} · ${rollLabel(event.rollKey)}${prob}${event.bonus ? ' · bonus' : ''}`;
      } else if (event.type === 'move') {
        row.textContent = `${event.actor} · ${event.pieceIds.join('+')} · ${event.from} → ${event.to}`;
      } else if (event.type === 'start') row.textContent = `Start · ${event.starter}`;
      else row.textContent = event.type;
      eventList.appendChild(row);
    }
    body.appendChild(eventList);

    const actions = document.createElement('div');
    actions.className = 'history-actions';
    const exportBtn = document.createElement('button');
    exportBtn.className = 'secondary';
    exportBtn.textContent = 'Export game JSON';
    exportBtn.onclick = event => {
      event.preventDefault();
      exportGamesJson([record], `yut-nori-${record.gameId}.json`);
    };
    actions.appendChild(exportBtn);
    body.appendChild(actions);
    details.appendChild(body);
    list.appendChild(details);
  }
}

function openHistory() {
  renderHistory();
  $('#history-panel').classList.remove('hidden');
}

function closeHistory() {
  $('#history-panel').classList.add('hidden');
}

function setSelectedProbability(rollKey) {
  selectedProbability = rollKey;
  document.querySelectorAll('[data-probability]').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.probability === selectedProbability);
  });
}

function sameMove(a, b) {
  if (!a || !b) return false;
  return a.from === b.from && a.to === b.to && a.route === b.route && a.pieceIds.join('+') === b.pieceIds.join('+');
}

function activeBoardActor() {
  if (game.phase !== 'PLAYING' || game.winner) return null;
  return game.pendingRoll?.actor ?? game.turn;
}

function samePieceIds(a = [], b = []) {
  return [...a].sort().join('+') === [...b].sort().join('+');
}

function stackIdsForPiece(actor, pieceId) {
  const piece = game[actor]?.find(p => p.id === pieceId);
  if (!piece || piece.finished) return [];
  if (piece.node === HOME) return [piece.id];
  return game[actor].filter(p => !p.finished && p.node === piece.node).map(p => p.id);
}

function candidatesForSelection(selection = boardSelection) {
  if (!selection) return [];
  if (game.pendingRoll) {
    if (game.pendingRoll.actor !== selection.actor) return [];
    return pendingMoves
      .filter(move => samePieceIds(move.pieceIds, selection.pieceIds))
      .map(move => ({ rollKey: game.pendingRoll.rollKey, move, pending: true }));
  }
  if (game.turn !== selection.actor) return [];
  return observedMoveCandidates(game, selection.actor, selection.pieceIds);
}

function boardTargetMap() {
  const map = new Map();
  for (const candidate of candidatesForSelection()) {
    if (!map.has(candidate.move.to)) map.set(candidate.move.to, []);
    map.get(candidate.move.to).push(candidate);
  }
  return map;
}

function hideBoardInference() {
  boardInference = null;
  const panel = $('#board-inference');
  if (panel) panel.classList.add('hidden');
}

function clearBoardSelection({ redraw = false } = {}) {
  boardSelection = null;
  dragState = null;
  hideBoardInference();
  if (redraw) {
    drawBoard();
    renderDockPieces();
  }
}

function selectBoardPiece(actor, pieceIds, { redraw = true } = {}) {
  if (actor !== activeBoardActor()) {
    $('#board-hint').textContent = actor === 'player' ? 'It is not your turn.' : 'It is not the CPU turn.';
    return false;
  }
  const ids = [...pieceIds].sort();
  const nextSelection = { actor, pieceIds: ids };
  const candidates = candidatesForSelection(nextSelection);
  if (!candidates.length) {
    $('#board-hint').textContent = 'No legal one-roll destination is available for that piece right now.';
    return false;
  }
  boardSelection = nextSelection;
  hideBoardInference();
  const label = ids.join('+');
  $('#board-status').textContent = `${label} selected`;
  $('#board-hint').textContent = game.pendingRoll
    ? `Choose where ${label} moved for ${rollLabel(game.pendingRoll.rollKey)}.`
    : `Click or drag ${label} to the position shown in Metin2.`;
  if (redraw) {
    drawBoard();
    renderDockPieces();
  }
  return true;
}

function recommendedMoveSnapshot(rec) {
  return rec?.best?.move ? {
    pieceIds: [...rec.best.move.pieceIds],
    from: rec.best.move.from,
    to: rec.best.move.to,
    route: rec.best.move.route
  } : null;
}

function commitBoardCandidate(candidate) {
  if (!candidate?.move) return;
  const actor = candidate.move.actor;
  hideBoardInference();
  checkpoint(`board ${actor} ${candidate.move.pieceIds.join('+')} ${candidate.move.from}→${candidate.move.to}`);

  if (!game.pendingRoll) {
    const rollRec = actor === 'player' ? recommendRoll(game, 'player') : null;
    const chosenProbability = actor === 'player' ? (selectedProbability ?? rollRec?.best?.rollKey ?? null) : null;
    const rollTelemetry = actor === 'player' && rollRec
      ? buildRollTelemetry(game, rollRec, chosenProbability)
      : null;
    applyRoll(game, actor, candidate.rollKey, {
      bonus: game.bonusThrow,
      selectedProbability: chosenProbability,
      recommendedProbability: actor === 'player' ? rollRec?.best?.rollKey ?? null : null,
      strategyTelemetry: rollTelemetry,
      inputMethod: 'interactive-board'
    });
    pendingMoves = legalMoves(game, actor, candidate.rollKey);
    if (actor === 'player') selectedProbability = null;
  }

  const recBeforeMove = actor === 'player' ? recommendMove(game, 'player') : null;
  const strategyTelemetry = recBeforeMove ? buildMoveTelemetry(game, recBeforeMove, candidate.move) : null;
  applyMove(game, candidate.move, {
    recommendedMove: recommendedMoveSnapshot(recBeforeMove),
    strategyTelemetry,
    inputMethod: 'interactive-board'
  });
  pendingMoves = [];
  boardSelection = null;
  dragState = null;
  render();
}

function showBoardInference(candidates, targetNode) {
  boardInference = { candidates, targetNode };
  const panel = $('#board-inference');
  const options = $('#board-inference-options');
  if (!panel || !options) return;
  const from = candidates[0]?.move?.from ?? '';
  const pieces = candidates[0]?.move?.pieceIds?.join('+') ?? '';
  $('#board-inference-title').textContent = `${pieces}: ${nodeLabel(from)} → ${nodeLabel(targetNode)}`;
  const distinctRolls = new Set(candidates.map(c => c.rollKey));
  $('#board-inference-text').textContent = distinctRolls.size > 1
    ? 'More than one roll can reach this position. Choose the result that appeared in Metin2.'
    : 'This destination has more than one legal route. Choose the route used in Metin2.';
  options.innerHTML = '';
  for (const candidate of candidates) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'secondary';
    const route = candidate.move.route !== 'OUTER' ? ` · ${routeLabel(candidate.move.route)}` : '';
    btn.textContent = `${rollLabel(candidate.rollKey)}${route}`;
    btn.onclick = () => commitBoardCandidate(candidate);
    options.appendChild(btn);
  }
  panel.classList.remove('hidden');
}

function attemptBoardTarget(targetNode) {
  if (!boardSelection) return false;
  const candidates = candidatesForSelection().filter(candidate => candidate.move.to === targetNode);
  if (!candidates.length) {
    $('#board-hint').textContent = `${nodeLabel(targetNode)} is not a legal one-roll destination for the selected piece.`;
    return false;
  }
  if (candidates.length === 1) {
    commitBoardCandidate(candidates[0]);
    return true;
  }
  showBoardInference(candidates, targetNode);
  return true;
}

function boardPointFromClient(clientX, clientY) {
  const rect = boardSvg.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    x: ((clientX - rect.left) / rect.width) * 800,
    y: ((clientY - rect.top) / rect.height) * 800
  };
}

function nearestSelectedTarget(clientX, clientY, maxDistance = 58) {
  const point = boardPointFromClient(clientX, clientY);
  if (!point) return null;
  let best = null;
  for (const node of boardTargetMap().keys()) {
    const position = NODE_POSITIONS[node];
    if (!position) continue;
    const dx = point.x - position[0] * 800;
    const dy = point.y - position[1] * 800;
    const distance = Math.hypot(dx, dy);
    if (distance <= maxDistance && (!best || distance < best.distance)) best = { node, distance };
  }
  return best?.node ?? null;
}

function findRenderedPiece(actor, pieceIds) {
  const wanted = [...pieceIds].sort().join('+');
  return [...boardSvg.querySelectorAll('.piece[data-piece-ids]')].find(el =>
    el.dataset.actor === actor && el.dataset.pieceIds.split(',').sort().join('+') === wanted
  ) ?? null;
}

function currentRecommendedMoves() {
  if (!game.pendingRoll || game.pendingRoll.actor !== 'player' || game.winner) return [];
  const rec = recommendMove(game, 'player');
  if (!rec?.best) return [];
  return rec.equivalent ? rec.tiedBest.map(row => row.move) : [rec.best.move];
}

function drawBoard() {
  boardSvg.innerHTML = '';
  const size = 800;

  const defs = svgEl('defs');
  const pattern = svgEl('pattern', { id: 'board-speckle', width: 26, height: 26, patternUnits: 'userSpaceOnUse' });
  pattern.appendChild(svgEl('circle', { cx: 4, cy: 5, r: 1.2, class: 'speckle-dot' }));
  pattern.appendChild(svgEl('circle', { cx: 17, cy: 15, r: .9, class: 'speckle-dot faint' }));
  defs.appendChild(pattern);
  const grad = svgEl('radialGradient', { id: 'pumpkin-grad', cx: '50%', cy: '42%', r: '66%' });
  grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#ffd868', 'stop-opacity': '.98' }));
  grad.appendChild(svgEl('stop', { offset: '48%', 'stop-color': '#f29a20', 'stop-opacity': '.96' }));
  grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#9e4710', 'stop-opacity': '.9' }));
  defs.appendChild(grad);

  const playerGrad = svgEl('radialGradient', { id: 'piece-player-grad', cx: '34%', cy: '26%', r: '76%' });
  playerGrad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#ffe69b' }));
  playerGrad.appendChild(svgEl('stop', { offset: '38%', 'stop-color': '#f6b335' }));
  playerGrad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#c96f0f' }));
  defs.appendChild(playerGrad);

  const cpuGrad = svgEl('radialGradient', { id: 'piece-cpu-grad', cx: '34%', cy: '24%', r: '78%' });
  cpuGrad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#fffdf7' }));
  cpuGrad.appendChild(svgEl('stop', { offset: '52%', 'stop-color': '#eee1cf' }));
  cpuGrad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#cdb9a5' }));
  defs.appendChild(cpuGrad);
  boardSvg.appendChild(defs);
  boardSvg.appendChild(svgEl('rect', { x: 0, y: 0, width: size, height: size, fill: 'url(#board-speckle)', class: 'board-texture' }));
  boardSvg.appendChild(svgEl('rect', { x: 7, y: 7, width: size-14, height: size-14, fill: 'none', stroke: 'rgba(255,201,99,.18)', 'stroke-width': 1 }));
  boardSvg.appendChild(svgEl('rect', { x: 2, y: 2, width: size-4, height: size-4, fill: 'none', stroke: 'rgba(0,0,0,.35)', 'stroke-width': 2 }));

  // Jack-o'-lantern silhouette, tuned to the client board.
  const pumpkin = svgEl('g', { transform: 'translate(400 456) scale(0.96)' });
  pumpkin.appendChild(svgEl('ellipse', { cx: 0, cy: 0, rx: 194, ry: 160, class: 'pumpkin-shell' }));
  pumpkin.appendChild(svgEl('ellipse', { cx: -82, cy: 2, rx: 77, ry: 145, class: 'pumpkin-lobe' }));
  pumpkin.appendChild(svgEl('ellipse', { cx: 82, cy: 2, rx: 77, ry: 145, class: 'pumpkin-lobe' }));
  pumpkin.appendChild(svgEl('polygon', { points: '-112,-67 -40,-15 -135,-12', class: 'pumpkin-cut' }));
  pumpkin.appendChild(svgEl('polygon', { points: '112,-67 135,-12 40,-15', class: 'pumpkin-cut' }));
  pumpkin.appendChild(svgEl('path', { d: 'M-142 52 C-112 105,-62 132,0 136 C62 132,112 105,142 52 C112 88,70 94,0 92 C-70 94,-112 88,-142 52 Z', class: 'pumpkin-cut' }));
  pumpkin.appendChild(svgEl('path', { d: 'M-116 91 L-88 124 L-55 99 L-20 135 L16 100 L52 132 L87 97 L113 116', class: 'pumpkin-teeth', fill: 'none' }));
  boardSvg.appendChild(pumpkin);

  EDGES.forEach(([a, b], index) => {
    const [ax, ay] = NODE_POSITIONS[a];
    const [bx, by] = NODE_POSITIONS[b];
    const attrs = { x1: ax * size, y1: ay * size, x2: bx * size, y2: by * size };
    if (index < 20) {
      boardSvg.appendChild(svgEl('line', { ...attrs, class: 'outer-edge-shadow' }));
      boardSvg.appendChild(svgEl('line', { ...attrs, class: 'outer-edge' }));
      boardSvg.appendChild(svgEl('line', { ...attrs, class: 'outer-edge-highlight' }));
    } else {
      boardSvg.appendChild(svgEl('line', { ...attrs, class: 'diagonal-edge-shadow' }));
      boardSvg.appendChild(svgEl('line', { ...attrs, class: 'diagonal-edge' }));
      boardSvg.appendChild(svgEl('line', { ...attrs, class: 'diagonal-edge-highlight' }));
    }
  });

  // Direction arrows matched to the real board: outer route clockwise from Start,
  // shortcuts from the upper corners toward centre, then out to the lower corners.
  const arrows = [
    [670, 80, 180, 1],    // top: left — unchanged
    [80, 154, 90, 1],     // left: down — unchanged
    [154, 720, 0, 1],     // bottom: right — unchanged
    [720, 644, -90, 1],   // right: up — unchanged
    [150, 150, 45, 1],    // top-left diagonal — unchanged
    [650, 150, 135, 1],   // top-right diagonal — unchanged
    [378, 438, 135, .76], // centre -> bottom-left — tuned to original
    [422, 438, 45, .76]   // centre -> bottom-right — tuned to original
  ];
  for (const [x, y, r, scale = 1] of arrows) {
    const a = svgEl('g', { class: 'route-arrow', transform: `translate(${x} ${y}) rotate(${r}) scale(${scale})` });
    a.appendChild(svgEl('path', { d: 'M-12 -6.5 L10 0 L-12 6.5 Z' }));
    boardSvg.appendChild(a);
  }

  // Special-node pointers follow the real client's visual directions.
  const targetMap = boardTargetMap();
  const specialRotations = { O5: 135, O10: 45, O15: 0, C: 45 };
  for (const [node, [x, y]] of Object.entries(NODE_POSITIONS)) {
    const isFinish = node === FINISH;
    const isSpecial = Object.prototype.hasOwnProperty.call(specialRotations, node);
    const isBoardTarget = targetMap.has(node);
    const g = svgEl('g', {
      class: `node ${isFinish ? 'finish-node' : ''} ${isSpecial ? 'special-node' : ''} ${isBoardTarget ? 'board-target' : ''}`.trim(),
      'data-node': node,
      role: isBoardTarget ? 'button' : 'presentation',
      tabindex: isBoardTarget ? '0' : '-1'
    });
    const radius = isFinish ? 29 : isSpecial ? 24 : 15;
    g.appendChild(svgEl('circle', { cx: x * size, cy: y * size, r: radius }));
    g.appendChild(svgEl('circle', { cx: x * size, cy: y * size, r: radius - 5, class: 'node-rim' }));
    if (isSpecial) {
      g.appendChild(svgEl('circle', { cx: x * size, cy: y * size, r: radius - 8, class: 'special-node-inner' }));
      const icon = svgEl('g', { transform: `translate(${x * size} ${y * size}) rotate(${specialRotations[node]})`, class: 'special-node-icon' });
      icon.appendChild(svgEl('path', { d: 'M-10 -8 L11 0 L-10 8 Z' }));
      g.appendChild(icon);
    }
    if (isFinish) {
      const t = svgEl('text', { x: x * size, y: y * size + 5, 'text-anchor': 'middle' });
      t.textContent = game.phase === 'INITIAL_TOSS' ? 'Start' : 'Goal';
      g.appendChild(t);
    }
    boardSvg.appendChild(g);
  }

  for (const node of targetMap.keys()) {
    const [x, y] = NODE_POSITIONS[node];
    boardSvg.appendChild(svgEl('circle', {
      cx: x * size, cy: y * size, r: node === FINISH ? 39 : 29, class: 'board-target-ring'
    }));
    boardSvg.appendChild(svgEl('circle', {
      cx: x * size, cy: y * size, r: 3.2, class: 'board-target-dot'
    }));
  }

  drawPieces('player');
  drawPieces('computer');

  for (const move of currentRecommendedMoves()) {
    if (move.from !== HOME && NODE_POSITIONS[move.from]) {
      const [x, y] = NODE_POSITIONS[move.from];
      boardSvg.appendChild(svgEl('circle', { cx: x * size, cy: y * size, r: 27, class: 'recommended-origin-ring' }));
    }
    if (NODE_POSITIONS[move.to]) {
      const [x, y] = NODE_POSITIONS[move.to];
      boardSvg.appendChild(svgEl('circle', { cx: x * size, cy: y * size, r: move.to === FINISH ? 36 : 27, class: 'recommended-target-ring' }));
    }
  }
}

function drawPieces(actor) {
  const size = 800;
  const grouped = new Map();
  for (const p of game[actor]) {
    if (p.node === HOME || p.finished) continue;
    if (!grouped.has(p.node)) grouped.set(p.node, []);
    grouped.get(p.node).push(p);
  }

  for (const [node, stack] of grouped.entries()) {
    const [x, y] = NODE_POSITIONS[node];
    const px = x * size;
    const py = y * size;
    const isStack = stack.length === 2;
    const pieceIds = stack.map(p => p.id).sort();
    const selectable = actor === activeBoardActor() && candidatesForSelection({ actor, pieceIds }).length > 0;
    const selected = Boolean(boardSelection && boardSelection.actor === actor && samePieceIds(boardSelection.pieceIds, pieceIds));
    const g = svgEl('g', {
      class: `piece ${actor}${isStack ? ' stacked' : ''}${selectable ? ' board-interactive' : ''}${selected ? ' board-selected' : ''}`,
      'data-actor': actor,
      'data-piece-ids': pieceIds.join(','),
      'data-node': node,
      role: selectable ? 'button' : 'presentation',
      tabindex: selectable ? '0' : '-1',
      'aria-label': `${actor === 'player' ? 'Player' : 'Computer'} ${pieceIds.join(' + ')} at ${node}`
    });

    // A stacked pair gets a second medallion behind the main token.
    if (isStack) {
      g.appendChild(svgEl('circle', {
        cx: px - 5.2, cy: py + 4.8, r: 22.5,
        class: `piece-stack-back ${actor}`
      }));
    }

    // Outer halo makes pieces visually distinct from board nodes.
    g.appendChild(svgEl('circle', { cx: px, cy: py, r: 25.5, class: `piece-halo ${actor}` }));
    g.appendChild(svgEl('circle', { cx: px, cy: py, r: 22.2, class: 'piece-token' }));
    g.appendChild(svgEl('circle', { cx: px, cy: py, r: 17.4, class: 'piece-inner-ring' }));

    if (actor === 'player') {
      // Pumpkin medallion: triangular eyes + carved smile.
      g.appendChild(svgEl('polygon', {
        points: `${px-8.2},${py-4} ${px-2.2},${py-11.5} ${px+0.7},${py-3.4}`,
        class: 'piece-icon-shape player-face'
      }));
      g.appendChild(svgEl('polygon', {
        points: `${px+1.2},${py-3.4} ${px+7.2},${py-11.5} ${px+9.4},${py-3.3}`,
        class: 'piece-icon-shape player-face'
      }));
      g.appendChild(svgEl('path', {
        d: `M${px-9} ${py+4.2} Q${px} ${py+13.5} ${px+9} ${py+4.2} Q${px+4.5} ${py+9.1} ${px} ${py+7.1} Q${px-4.5} ${py+9.1} ${px-9} ${py+4.2}`,
        class: 'piece-icon-shape player-mouth'
      }));
      // Tiny stem/notch to make the silhouette less generic.
      g.appendChild(svgEl('path', {
        d: `M${px-3.2} ${py-20.5} Q${px} ${py-25.3} ${px+4.2} ${py-20.2}`,
        class: 'piece-player-stem'
      }));
    } else {
      // CPU medallion: ivory token with a red stamped crest.
      g.appendChild(svgEl('circle', { cx: px, cy: py-1, r: 10.8, class: 'cpu-crest-ring' }));
      g.appendChild(svgEl('circle', { cx: px-4.5, cy: py-4.1, r: 2.1, class: 'piece-icon-shape cpu-eye' }));
      g.appendChild(svgEl('circle', { cx: px+4.5, cy: py-4.1, r: 2.1, class: 'piece-icon-shape cpu-eye' }));
      g.appendChild(svgEl('path', {
        d: `M${px-7.2} ${py+4.8} Q${px} ${py+10} ${px+7.2} ${py+4.8}`,
        class: 'piece-icon-shape cpu-mouth'
      }));
      g.appendChild(svgEl('path', {
        d: `M${px} ${py-13} L${px} ${py-9} M${px-11.5} ${py+1} L${px-8.5} ${py+1} M${px+8.5} ${py+1} L${px+11.5} ${py+1}`,
        class: 'cpu-crest-detail'
      }));
    }

    // Piece number sits in a larger corner badge and moves inward near board edges.
    const badgeValue = isStack ? '×2' : stack[0].id.replace(/\D/g, '');
    const badgeDx = x > 0.75 ? -17 : 17;
    const badgeDy = y < 0.25 ? 17 : -17;
    const badgeX = px + badgeDx;
    const badgeY = py + badgeDy;
    g.appendChild(svgEl('circle', { cx: badgeX, cy: badgeY, r: isStack ? 10 : 9, class: `piece-badge ${actor}` }));
    const bt = svgEl('text', { x: badgeX, y: badgeY + 0.8, class: `piece-badge-text ${actor}${isStack ? ' stack-text' : ''}` });
    bt.textContent = badgeValue;
    g.appendChild(bt);

    boardSvg.appendChild(g);
  }
}

function rollLabel(key) { return ROLLS[key]?.label ?? key; }

function rollVisualMarkup(rollKey, compact = false) {
  const map = {
    DO: ['curved','curved','curved','flat'],
    GAE: ['curved','curved','flat','flat skull'],
    GEOL: ['curved','flat','flat','flat skull'],
    YUT: ['flat','flat','flat skull','flat'],
    MO: ['curved','curved','curved','curved'],
    BACK_DO: ['curved','curved','curved','flat skull']
  };
  const sticks = (map[rollKey] || []).map(cls => `<span class="stick ${cls}"></span>`).join('');
  return `<span class="roll-visual${compact ? ' compact' : ''}">${sticks}</span>`;
}

function describeRollForHumans(rollKey) {
  return {
    DO: 'Advance 1 space.', GAE: 'Advance 2 spaces.', GEOL: 'Advance 3 spaces.',
    YUT: 'Advance 4 spaces and throw again.', MO: 'Advance 5 spaces and throw again.',
    BACK_DO: 'Move 1 space backwards.'
  }[rollKey] ?? '';
}

function nodeLabel(node) {
  if (node === 'C') return 'Centre';
  if (node === FINISH) return 'Finish';
  if (node === HOME) return 'Home';
  return node;
}

function routeLabel(route) {
  return {
    TR_TO_BL: 'top-right shortcut', TL_TO_FINISH: 'top-left shortcut',
    C_TO_BL: 'centre → bottom-left', C_TO_FINISH: 'centre → finish'
  }[route] ?? route;
}

function formatMove(move) {
  if (!move) return '';
  const route = move.route !== 'OUTER' ? ` via ${routeLabel(move.route)}` : '';
  return `${move.pieceIds.join('+')}: ${nodeLabel(move.from)} → ${nodeLabel(move.to)}${route}`;
}

function chooseStarter(actor) {
  if (game.phase !== 'INITIAL_TOSS') return;
  clearBoardSelection();
  checkpoint('choose starter');
  startGame(game, actor);
  session.startedAt = new Date().toISOString();
  pendingMoves = [];
  render();
}

function renderActionState() {
  const setup = game.phase === 'INITIAL_TOSS';
  const winner = Boolean(game.winner);
  const pending = Boolean(game.pendingRoll);
  const playerTurn = game.turn === 'player';

  $('#initial-panel').classList.toggle('hidden', !setup);
  $('#probability-section').classList.toggle('hidden', setup || winner || pending || !playerTurn);
  $('#roll-section').classList.toggle('hidden', setup || winner || pending);
  $('#move-section').classList.toggle('hidden', setup || winner || !pending);
  $('#winner-section').classList.toggle('hidden', !winner);

  const kicker = $('#action-kicker');
  const title = $('#action-title');
  const help = $('#action-help');
  const pill = $('#action-state-pill');

  if (setup) {
    kicker.textContent = 'START GAME';
    title.textContent = 'Who starts?';
    help.textContent = 'Use the initial toss in Metin2, then choose who starts. Nothing else needs to be recorded.';
    pill.textContent = 'Setup';
    return;
  }

  if (winner) {
    const youWon = game.winner === 'player';
    kicker.textContent = 'GAME OVER';
    title.textContent = youWon ? 'You won' : 'Computer won';
    help.textContent = youWon ? 'The board is complete. Start a new game when ready.' : 'The CPU finished both pieces first. Use the log if you want to review the sequence.';
    pill.textContent = 'Finished';
    $('#winner-message').innerHTML = youWon
      ? `<strong>Victory</strong><span>Final score: ${game.points} · ${scoreBand(game.points)}</span>`
      : '<strong>Defeat</strong><span>The game ended when the CPU finished both pieces.</span>';
    return;
  }

  if (!pending && playerTurn) {
    const rec = recommendRoll(game, 'player');
    kicker.textContent = game.bonusThrow ? 'BONUS THROW' : 'YOUR TURN';
    title.textContent = rec?.best ? `Select ${rollLabel(rec.best.rollKey)}` : 'Choose a probability';
    help.textContent = 'Set this probability in Metin2. After the piece moves, mirror it directly on the board — or use the result buttons as fallback.';
    pill.textContent = game.bonusThrow ? 'You · Bonus' : 'You';
    return;
  }

  if (!pending && !playerTurn) {
    kicker.textContent = 'CPU TURN';
    title.textContent = 'Record the CPU roll';
    help.textContent = 'Click or drag the CPU piece to where it moved. The Helper infers the roll when possible; result buttons remain available as fallback.';
    pill.textContent = game.bonusThrow ? 'CPU · Bonus' : 'CPU';
    return;
  }

  if (pending && game.pendingRoll.actor === 'player') {
    const rec = recommendMove(game, 'player');
    kicker.textContent = 'YOUR MOVE';
    title.textContent = rec?.best ? (rec.equivalent ? 'Either move is equivalent' : `Move ${rec.best.move.pieceIds.join('+')}`) : 'Confirm your move';
    help.textContent = 'Make the move in Metin2, then click or drag the same piece to its destination here. The movement buttons remain available as fallback.';
    pill.textContent = 'You';
    return;
  }

  kicker.textContent = 'CPU MOVE';
  title.textContent = 'What did the CPU move?';
  help.textContent = 'Click or drag the CPU piece to the destination you saw. If the move is ambiguous, the Helper will ask which roll appeared.';
  pill.textContent = 'CPU';
}

function renderRecommendation() {
  const rec = game.phase === 'PLAYING' && !game.winner && game.turn === 'player' && !game.pendingRoll
    ? recommendRoll(game, 'player') : null;
  const probabilityConfidence = rec?.probabilityModel?.confidence?.level;
  const probabilityNote = probabilityConfidence
    ? `Probability effect confidence: ${probabilityConfidence}.`
    : 'Provisional community probabilities.';
  $('#recommendation').innerHTML = rec
    ? `<strong>${rollLabel(rec.best.rollKey)}</strong><span>${rec.best.reason}</span><small>Strategy v2 · Gold-first ranking · ${probabilityNote}</small>`
    : '';

  if (rec && !selectedProbability) selectedProbability = rec.best.rollKey;
  document.querySelectorAll('[data-probability]').forEach(btn => {
    btn.classList.toggle('selected', Boolean(selectedProbability && btn.dataset.probability === selectedProbability));
  });

  document.querySelectorAll('[data-roll]').forEach(btn => {
    btn.classList.toggle('recommended-roll', Boolean(rec && btn.dataset.roll === rec.best.rollKey));
  });
}

function renderMoveChoices() {
  const box = $('#move-choices');
  const recBox = $('#move-recommendation');
  const explainer = $('#current-roll-explainer');
  const pass = $('#pass-turn');
  box.innerHTML = '';
  recBox.innerHTML = '';
  recBox.classList.add('hidden');
  pass.classList.add('hidden');

  if (!game.pendingRoll) return;
  explainer.innerHTML = `<b>${rollLabel(game.pendingRoll.rollKey)}</b> ${rollVisualMarkup(game.pendingRoll.rollKey, true)} <span>· ${describeRollForHumans(game.pendingRoll.rollKey)}</span>`;

  if (!pendingMoves.length) {
    box.innerHTML = '<span class="muted">No legal movement for this result.</span>';
    pass.classList.remove('hidden');
    pass.disabled = false;
    return;
  }

  const moveRec = game.pendingRoll.actor === 'player' ? recommendMove(game, 'player') : null;
  if (moveRec?.best) {
    recBox.classList.remove('hidden');
    if (moveRec.equivalent) {
      const labels = moveRec.tiedBest.map(row => row.move.pieceIds.join('+')).join(' or ');
      recBox.innerHTML = `<span class="move-rec-label">RECOMMENDED</span><strong>${labels}</strong><span>Either highlighted move is equivalent.</span><small>${moveRec.reason}</small>`;
    } else {
      recBox.innerHTML = `<span class="move-rec-label">RECOMMENDED</span><strong>Move ${moveRec.best.move.pieceIds.join('+')}</strong><span>${formatMove(moveRec.best.move)}</span><small>${moveRec.reason}</small>`;
    }
  }

  for (const move of pendingMoves) {
    const isRecommended = Boolean(moveRec?.best && (moveRec.equivalent
      ? moveRec.tiedBest.some(row => sameMove(row.move, move))
      : sameMove(moveRec.best.move, move)));
    const btn = document.createElement('button');
    btn.className = `move-btn${isRecommended ? ' recommended' : ''}`;
    btn.innerHTML = `${isRecommended ? '<span class="recommended-badge">Recommended</span>' : ''}<span>${formatMove(move)}</span>`;
    btn.onclick = () => {
      clearBoardSelection();
      checkpoint(`move ${move.pieceIds.join('+')} ${move.from}→${move.to}`);
      const recBeforeMove = game.pendingRoll?.actor === 'player' ? recommendMove(game, 'player') : null;
      const recommendedMove = recBeforeMove?.best?.move ? { pieceIds: recBeforeMove.best.move.pieceIds, from: recBeforeMove.best.move.from, to: recBeforeMove.best.move.to, route: recBeforeMove.best.move.route } : null;
      const strategyTelemetry = recBeforeMove ? buildMoveTelemetry(game, recBeforeMove, move) : null;
      applyMove(game, move, { recommendedMove, strategyTelemetry, inputMethod: 'buttons' });
      pendingMoves = [];
      render();
    };
    box.appendChild(btn);
  }
}

function renderPieceStatus() {
  const fmt = p => p.finished ? 'FINISHED' : p.node;
  $('#player-state').textContent = game.player.map(p => `${p.id}: ${fmt(p)}`).join(' · ');
  $('#cpu-state').textContent = game.computer.map(p => `${p.id}: ${fmt(p)}`).join(' · ');
}


function renderDockPieces() {
  const setChip = (id, actor, piece) => {
    const el = document.querySelector(id);
    if (!el) return;
    const pieceIds = stackIdsForPiece(actor, piece.id);
    const selectable = !piece.finished && actor === activeBoardActor() && pieceIds.length > 0 && candidatesForSelection({ actor, pieceIds }).length > 0;
    const selected = Boolean(boardSelection && boardSelection.actor === actor && samePieceIds(boardSelection.pieceIds, pieceIds));
    el.dataset.actor = actor;
    el.dataset.pieceId = piece.id;
    el.classList.toggle('finished', Boolean(piece.finished));
    el.classList.toggle('home', !piece.finished && piece.node === HOME);
    el.classList.toggle('active', !piece.finished && piece.node !== HOME);
    el.classList.toggle('board-interactive', selectable);
    el.classList.toggle('board-selected', selected);
    el.setAttribute('aria-disabled', selectable ? 'false' : 'true');
    el.title = selectable ? `Select ${piece.id} and choose where it moved` : '';
  };
  setChip('#player-chip-1', 'player', game.player[0]);
  setChip('#player-chip-2', 'player', game.player[1]);
  setChip('#cpu-chip-1', 'computer', game.computer[0]);
  setChip('#cpu-chip-2', 'computer', game.computer[1]);
  const reward = document.querySelector('#reward-band');
  if (reward) reward.textContent = scoreBand(game.points);
}

function renderLog() {
  const box = $('#log');
  box.innerHTML = '';
  for (const item of game.log.slice(0, 40)) {
    const row = document.createElement('div');
    row.className = `log-row ${item.actor ?? ''}`;
    if (item.type === 'start') row.textContent = `Game start · ${item.starter === 'player' ? 'You start' : 'CPU starts'}`;
    else if (item.type === 'roll') { const prob = item.actor === 'player' && item.selectedProbability ? ` · selected ${rollLabel(item.selectedProbability)}` : ''; row.textContent = `${item.actor} · ${rollLabel(item.rollKey)}${prob}${item.bonus ? ' · bonus' : ''}`; }
    else if (item.type === 'resync') { row.textContent = `Manual resync · next: ${item.turn}${item.bonus ? ' · bonus' : ''}`; row.classList.add('resync'); }
    else {
      const cap = item.captured?.length ? ` · captures ${item.captured.join(', ')}` : '';
      const fin = item.finishedCount ? ` · finishes ${item.finishedCount}` : '';
      row.textContent = `${item.actor} · ${item.pieceIds.join('+')} · ${item.from} → ${item.to}${cap}${fin}`;
    }
    box.appendChild(row);
  }
}

function render() {
  if (boardSelection && (boardSelection.actor !== activeBoardActor() || !candidatesForSelection().length)) {
    boardSelection = null;
    hideBoardInference();
  }
  if (game.phase === 'PLAYING' && game.log.length) persistCurrentGame();
  $('#points').textContent = game.points;
  $('#throws').textContent = game.throws;
  const band = scoreBand(game.points);
  $('#band').textContent = band;
  $('#band').dataset.band = band.toLowerCase();
  $('#player-finished').textContent = `${finishedCount(game, 'player')}/2`;
  $('#cpu-finished').textContent = `${finishedCount(game, 'computer')}/2`;
  $('#turn').textContent = game.phase === 'INITIAL_TOSS' ? 'Setup' : game.winner ? 'Finished' : game.turn === 'player' ? (game.bonusThrow ? 'Your bonus' : 'Your turn') : (game.bonusThrow ? 'CPU bonus' : 'CPU turn');

  if (boardSelection) {
    $('#board-status').textContent = `${boardSelection.pieceIds.join('+')} selected`;
    $('#board-hint').textContent = game.pendingRoll
      ? `Choose the highlighted destination for ${rollLabel(game.pendingRoll.rollKey)}.`
      : 'Click a highlighted node or drag the piece there. The Helper will infer the roll.';
  } else {
    $('#board-status').textContent = game.phase === 'INITIAL_TOSS' ? 'Waiting to start' : game.winner ? 'Game finished' : game.pendingRoll ? 'Confirm the movement' : game.turn === 'player' ? 'Your turn' : 'CPU turn';
    $('#board-hint').textContent = game.phase === 'INITIAL_TOSS'
      ? 'Start the match, then mirror the board from Metin2.'
      : game.winner
        ? 'Review the log or start a new game.'
        : game.pendingRoll
          ? 'Click or drag the piece to its highlighted destination, or use the movement buttons.'
          : 'Click or drag the piece that moved in Metin2. Roll buttons remain available as fallback.';
  }

  $('#switch-turn').disabled = game.phase !== 'PLAYING' || Boolean(game.pendingRoll || game.winner);
  $('#undo').disabled = history.length === 0;
  $('#undo').title = history.length ? `Undo: ${history.at(-1).label}` : 'Nothing to undo';
  $('#redo').disabled = redoHistory.length === 0;
  $('#redo').title = redoHistory.length ? `Redo: ${redoHistory.at(-1).label}` : 'Nothing to redo';
  const cpuMoment = game.phase === 'PLAYING' && !game.winner && (game.turn === 'computer' || game.pendingRoll?.actor === 'computer');
  $('#missed-cpu').disabled = !cpuMoment;

  renderActionState();
  renderRecommendation();
  renderMoveChoices();
  renderPieceStatus();
  renderLog();
  renderDockPieces();
  drawBoard();
  renderArchiveCount();

  document.querySelectorAll('[data-roll]').forEach(btn => {
    btn.disabled = game.phase !== 'PLAYING' || Boolean(game.winner || game.pendingRoll);
  });
}

function handleRoll(rollKey) {
  if (game.phase !== 'PLAYING' || game.pendingRoll || game.winner) return;
  clearBoardSelection();
  const actor = game.turn;
  checkpoint(`${actor} roll ${rollLabel(rollKey)}`);
  const rollRec = actor === 'player' ? recommendRoll(game, 'player') : null;
  const strategyTelemetry = actor === 'player' && rollRec
    ? buildRollTelemetry(game, rollRec, selectedProbability)
    : null;
  applyRoll(game, actor, rollKey, {
    bonus: game.bonusThrow,
    selectedProbability: actor === 'player' ? selectedProbability : null,
    recommendedProbability: actor === 'player' ? rollRec?.best?.rollKey ?? null : null,
    strategyTelemetry,
    inputMethod: 'buttons'
  });
  selectedProbability = null;
  pendingMoves = legalMoves(game, actor, rollKey);
  render();
}

function populateResyncOptions() {
  for (const id of ['resync-p1','resync-p2','resync-c1','resync-c2']) {
    const select = $(`#${id}`);
    if (select.options.length) continue;
    for (const pos of RESYNC_POSITIONS) {
      const option = document.createElement('option');
      option.value = pos.value;
      option.textContent = pos.label;
      select.appendChild(option);
    }
  }
}

function pieceValue(piece) { return piece.finished ? FINISH : piece.node; }

function openResync() {
  clearBoardSelection();
  populateResyncOptions();
  $('#resync-p1').value = pieceValue(game.player[0]);
  $('#resync-p2').value = pieceValue(game.player[1]);
  $('#resync-c1').value = pieceValue(game.computer[0]);
  $('#resync-c2').value = pieceValue(game.computer[1]);
  $('#resync-points').value = game.points;
  $('#resync-throws').value = game.throws;
  $('#resync-turn').value = game.turn ?? 'player';
  $('#resync-bonus').checked = Boolean(game.bonusThrow);
  $('#resync-panel').classList.remove('hidden');
}

function inferRoute(node) {
  if (['TR1','TR2','BL2','BL1'].includes(node)) return 'TR_TO_BL';
  if (['TL1','TL2','BR2','BR1'].includes(node)) return 'TL_TO_FINISH';
  if (node === 'C') return 'C_TO_FINISH';
  return 'OUTER';
}

function setPieceFromResync(piece, value) {
  if (value === FINISH) { piece.node = FINISH; piece.finished = true; piece.route = 'OUTER'; return; }
  piece.node = value;
  piece.finished = false;
  piece.route = value === HOME ? 'OUTER' : inferRoute(value);
}

function applyResync() {
  clearBoardSelection();
  checkpoint('manual resync');
  game.phase = 'PLAYING';
  setPieceFromResync(game.player[0], $('#resync-p1').value);
  setPieceFromResync(game.player[1], $('#resync-p2').value);
  setPieceFromResync(game.computer[0], $('#resync-c1').value);
  setPieceFromResync(game.computer[1], $('#resync-c2').value);
  game.points = Math.max(0, Math.min(999, Number.parseInt($('#resync-points').value, 10) || 0));
  game.throws = Math.max(0, Math.min(20, Number.parseInt($('#resync-throws').value, 10) || 0));
  game.turn = $('#resync-turn').value;
  game.bonusThrow = $('#resync-bonus').checked;
  game.pendingRoll = null;
  game.winner = null;
  if (finishedCount(game,'player') === 2) game.winner = 'player';
  if (finishedCount(game,'computer') === 2) { game.winner = 'computer'; game.points = 0; }
  game.log.unshift({ type:'resync', turn:game.turn, bonus:game.bonusThrow });
  pendingMoves = [];
  $('#resync-panel').classList.add('hidden');
  render();
}

function resetGame() {
  clearBoardSelection();
  if (game.phase === 'PLAYING' && game.log.length) persistCurrentGame(game.winner ? 'completed' : 'interrupted');
  game = createGame();
  pendingMoves = [];
  history = [];
  redoHistory = [];
  selectedProbability = null;
  session = { gameId: makeId('game'), startedAt: new Date().toISOString() };
  $('#resync-panel').classList.add('hidden');
  render();
}

function selectDockPiece(actor, pieceId) {
  const pieceIds = stackIdsForPiece(actor, pieceId);
  if (!pieceIds.length) return;
  selectBoardPiece(actor, pieceIds);
}

boardSvg.addEventListener('pointerdown', event => {
  const pieceEl = event.target.closest?.('.piece.board-interactive');
  if (!pieceEl) return;
  const actor = pieceEl.dataset.actor;
  const pieceIds = pieceEl.dataset.pieceIds.split(',').filter(Boolean);
  if (!selectBoardPiece(actor, pieceIds, { redraw: true })) return;

  const rendered = findRenderedPiece(actor, pieceIds);
  dragState = {
    pointerId: event.pointerId,
    actor,
    pieceIds,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
    element: rendered
  };
  try { boardSvg.setPointerCapture(event.pointerId); } catch {}
  event.preventDefault();
});

boardSvg.addEventListener('pointermove', event => {
  if (!dragState || dragState.pointerId !== event.pointerId) return;
  const dxClient = event.clientX - dragState.startX;
  const dyClient = event.clientY - dragState.startY;
  if (!dragState.moved && Math.hypot(dxClient, dyClient) < 5) return;
  dragState.moved = true;
  const rect = boardSvg.getBoundingClientRect();
  const dx = dxClient * (800 / Math.max(1, rect.width));
  const dy = dyClient * (800 / Math.max(1, rect.height));
  if (dragState.element) dragState.element.setAttribute('transform', `translate(${dx} ${dy})`);
  event.preventDefault();
});

function endBoardDrag(event) {
  if (!dragState || dragState.pointerId !== event.pointerId) return;
  const current = dragState;
  if (current.element) current.element.removeAttribute('transform');
  try { boardSvg.releasePointerCapture(event.pointerId); } catch {}
  dragState = null;
  suppressBoardClickUntil = performance.now() + 220;

  if (current.moved && event.type !== 'pointercancel') {
    const targetNode = nearestSelectedTarget(event.clientX, event.clientY);
    if (targetNode) {
      attemptBoardTarget(targetNode);
      return;
    }
    $('#board-hint').textContent = 'Drop the piece on one of the highlighted destinations.';
  }
  drawBoard();
  renderDockPieces();
}

boardSvg.addEventListener('pointerup', endBoardDrag);
boardSvg.addEventListener('pointercancel', endBoardDrag);

boardSvg.addEventListener('click', event => {
  if (performance.now() < suppressBoardClickUntil) return;
  const pieceEl = event.target.closest?.('.piece.board-interactive');
  if (pieceEl) {
    selectBoardPiece(pieceEl.dataset.actor, pieceEl.dataset.pieceIds.split(',').filter(Boolean));
    return;
  }
  const nodeEl = event.target.closest?.('.node.board-target');
  if (nodeEl?.dataset.node) attemptBoardTarget(nodeEl.dataset.node);
});

boardSvg.addEventListener('keydown', event => {
  if (!['Enter', ' '].includes(event.key)) return;
  const pieceEl = event.target.closest?.('.piece.board-interactive');
  if (pieceEl) {
    event.preventDefault();
    selectBoardPiece(pieceEl.dataset.actor, pieceEl.dataset.pieceIds.split(',').filter(Boolean));
    return;
  }
  const nodeEl = event.target.closest?.('.node.board-target');
  if (nodeEl?.dataset.node) {
    event.preventDefault();
    attemptBoardTarget(nodeEl.dataset.node);
  }
});

for (const [selector, actor, pieceId] of [
  ['#player-chip-1', 'player', 'P1'],
  ['#player-chip-2', 'player', 'P2'],
  ['#cpu-chip-1', 'computer', 'C1'],
  ['#cpu-chip-2', 'computer', 'C2']
]) {
  const el = $(selector);
  el?.addEventListener('click', () => selectDockPiece(actor, pieceId));
  el?.addEventListener('keydown', event => {
    if (!['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    selectDockPiece(actor, pieceId);
  });
}

$('#board-inference-cancel').addEventListener('click', () => {
  hideBoardInference();
  $('#board-hint').textContent = 'Movement inference cancelled. Choose another highlighted destination or use the result buttons.';
});

document.querySelectorAll('[data-roll]').forEach(btn => btn.addEventListener('click', () => handleRoll(btn.dataset.roll)));
$('#starter-player').addEventListener('click', () => chooseStarter('player'));
$('#starter-computer').addEventListener('click', () => chooseStarter('computer'));
$('#undo').addEventListener('click', undoLast);
$('#redo').addEventListener('click', redoLast);
$('#open-resync').addEventListener('click', openResync);
$('#missed-cpu').addEventListener('click', openResync);
$('#close-resync').addEventListener('click', () => $('#resync-panel').classList.add('hidden'));
$('#cancel-resync').addEventListener('click', () => $('#resync-panel').classList.add('hidden'));
$('#apply-resync').addEventListener('click', applyResync);
$('#new-game').addEventListener('click', resetGame);
$('#winner-new-game').addEventListener('click', resetGame);
$('#pass-turn').addEventListener('click', () => {
  if (!game.pendingRoll) return;
  clearBoardSelection();
  checkpoint('pass turn');
  const grantsBonus = game.pendingRoll.grantsBonus;
  const actor = game.pendingRoll.actor;
  game.pendingRoll = null;
  if (grantsBonus) { game.bonusThrow = true; game.turn = actor; }
  else game.turn = actor === 'player' ? 'computer' : 'player';
  pendingMoves = [];
  render();
});
$('#switch-turn').addEventListener('click', () => {
  if (game.phase !== 'PLAYING' || game.pendingRoll || game.winner) return;
  clearBoardSelection();
  checkpoint('switch turn');
  game.turn = game.turn === 'player' ? 'computer' : 'player';
  render();
});

document.querySelectorAll('[data-probability]').forEach(btn => btn.addEventListener('click', () => setSelectedProbability(btn.dataset.probability)));
$('#history-toggle').addEventListener('click', openHistory);
$('#close-history').addEventListener('click', closeHistory);
$('#save-game').addEventListener('click', () => {
  if (game.phase === 'INITIAL_TOSS' || !game.log.length) return;
  persistCurrentGame(game.winner ? 'completed' : 'manual');
  renderHistory();
  $('#board-hint').textContent = 'Game saved locally.';
});
$('#export-all-json').addEventListener('click', () => {
  const games = readArchive();
  if (!games.length) return;
  exportGamesJson(games, `yut-nori-community-logs-${new Date().toISOString().slice(0,10)}.json`);
});
$('#export-all-csv').addEventListener('click', () => {
  const games = readArchive();
  if (!games.length) return;
  downloadText(`yut-nori-rolls-${new Date().toISOString().slice(0,10)}.csv`, archiveToCsv(games), 'text/csv');
});
$('#import-logs').addEventListener('click', () => $('#import-logs-file').click());
$('#import-logs-file').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const bundle = JSON.parse(await file.text());
    const merged = mergeBundle(readArchive(), bundle);
    writeArchive(merged);
    configureProbabilityModel(merged);
    renderHistory();
    $('#board-hint').textContent = `Imported community logs · ${bundle.games.length} games.`;
  } catch (error) {
    alert(`Could not import logs: ${error.message}`);
  } finally {
    event.target.value = '';
  }
});

document.addEventListener('keydown', event => {
  const target = event.target;
  const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable;
  if (typing || !(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  if (key === 'z' && event.shiftKey) {
    if (redoHistory.length) { event.preventDefault(); redoLast(); }
  } else if (key === 'z') {
    if (history.length) { event.preventDefault(); undoLast(); }
  } else if (key === 'y') {
    if (redoHistory.length) { event.preventDefault(); redoLast(); }
  }
});

configureProbabilityModel(readArchive());
render();