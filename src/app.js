import { createGame, cloneGame, startGame, applyRoll, legalMoves, applyMove, scoreBand, finishedCount } from './engine.js';
import { ROLLS, NODE_POSITIONS, EDGES, HOME, FINISH } from './board.js';
import { recommendRoll, recommendMove } from './strategy.js';
import { configureProbabilityModel } from './probabilities.js';
import { makeId, createSourceId, readArchive, writeArchive, upsertGame, buildGameRecord, exportBundle, mergeBundle, archiveToCsv } from './archive.js';
import { pushCheckpoint, undoState, redoState } from './timeline.js';
import { escapeHtml, safeFileId } from './security.js';

let game = createGame();
let pendingMoves = [];
let history = [];
let redoHistory = [];
let selectedProbability = null;
const HELPER_VERSION = '0.8.0';
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
    const statusLabel = record.status === 'completed' ? (record.winner === 'player' ? 'WIN' : 'LOSS') : String(record.status ?? 'unknown').toUpperCase();
    summaryEl.innerHTML = `<div><strong>${escapeHtml(statusLabel)} · ${escapeHtml(record.finalBand)}</strong><span>${escapeHtml(safeDateLabel(record.startedAt))}</span></div><div class="history-meta"><b>${escapeHtml(record.finalPoints)}</b> pts · ${escapeHtml(record.throwsRemaining)} throws</div>`;
    details.appendChild(summaryEl);

    const body = document.createElement('div');
    body.className = 'history-game-body';
    const rolls = (record.events ?? []).filter(e => e.type === 'roll' && e.actor === 'player');
    const mapped = rolls.filter(e => e.selectedProbability).length;
    const info = document.createElement('div');
    info.className = 'history-stats';
    info.innerHTML = `<span>${escapeHtml(record.helperVersion)}</span><span>${record.events?.length ?? 0} events</span><span>${mapped}/${rolls.length} rolls with probability data</span>`;
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
      exportGamesJson([record], `yut-nori-${safeFileId(record.gameId)}.json`);
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
  const specialRotations = { O5: 135, O10: 45, O15: 0, C: 45 };
  for (const [node, [x, y]] of Object.entries(NODE_POSITIONS)) {
    const isFinish = node === FINISH;
    const isSpecial = Object.prototype.hasOwnProperty.call(specialRotations, node);
    const g = svgEl('g', { class: `node ${isFinish ? 'finish-node' : ''} ${isSpecial ? 'special-node' : ''}`.trim() });
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
    const g = svgEl('g', { class: `piece ${actor}${isStack ? ' stacked' : ''}` });

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
    help.textContent = 'Set this probability in Metin2. Then roll and click the result that actually appears.';
    pill.textContent = game.bonusThrow ? 'You · Bonus' : 'You';
    return;
  }

  if (!pending && !playerTurn) {
    kicker.textContent = 'CPU TURN';
    title.textContent = 'Record the CPU roll';
    help.textContent = 'Watch the sticks in Metin2 and click the result. If it moves too quickly, use “Missed CPU turn”.';
    pill.textContent = game.bonusThrow ? 'CPU · Bonus' : 'CPU';
    return;
  }

  if (pending && game.pendingRoll.actor === 'player') {
    const rec = recommendMove(game, 'player');
    kicker.textContent = 'YOUR MOVE';
    title.textContent = rec?.best ? (rec.equivalent ? 'Either move is equivalent' : `Move ${rec.best.move.pieceIds.join('+')}`) : 'Confirm your move';
    help.textContent = 'Make the recommended move in Metin2, then confirm the same move here.';
    pill.textContent = 'You';
    return;
  }

  kicker.textContent = 'CPU MOVE';
  title.textContent = 'What did the CPU move?';
  help.textContent = 'Choose the movement you actually saw. We do not guess the CPU piece.';
  pill.textContent = 'CPU';
}

function renderRecommendation() {
  const rec = game.phase === 'PLAYING' && !game.winner && game.turn === 'player' && !game.pendingRoll
    ? recommendRoll(game, 'player') : null;
  $('#recommendation').innerHTML = rec
    ? `<strong>${rollLabel(rec.best.rollKey)}</strong><span>${rec.best.reason}</span><small>Strategy v2 · multi-turn search · provisional community probabilities.</small>`
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
      checkpoint(`move ${move.pieceIds.join('+')} ${move.from}→${move.to}`);
      const recBeforeMove = game.pendingRoll?.actor === 'player' ? recommendMove(game, 'player') : null;
      const recommendedMove = recBeforeMove?.best?.move ? { pieceIds: recBeforeMove.best.move.pieceIds, from: recBeforeMove.best.move.from, to: recBeforeMove.best.move.to, route: recBeforeMove.best.move.route } : null;
      applyMove(game, move, { recommendedMove });
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
  const setChip = (id, piece) => {
    const el = document.querySelector(id);
    if (!el) return;
    el.classList.toggle('finished', Boolean(piece.finished));
    el.classList.toggle('home', !piece.finished && piece.node === HOME);
    el.classList.toggle('active', !piece.finished && piece.node !== HOME);
  };
  setChip('#player-chip-1', game.player[0]);
  setChip('#player-chip-2', game.player[1]);
  setChip('#cpu-chip-1', game.computer[0]);
  setChip('#cpu-chip-2', game.computer[1]);
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
  if (game.phase === 'PLAYING' && game.log.length) persistCurrentGame();
  $('#points').textContent = game.points;
  $('#throws').textContent = game.throws;
  const band = scoreBand(game.points);
  $('#band').textContent = band;
  $('#band').dataset.band = band.toLowerCase();
  $('#player-finished').textContent = `${finishedCount(game, 'player')}/2`;
  $('#cpu-finished').textContent = `${finishedCount(game, 'computer')}/2`;
  $('#turn').textContent = game.phase === 'INITIAL_TOSS' ? 'Setup' : game.winner ? 'Finished' : game.turn === 'player' ? (game.bonusThrow ? 'Your bonus' : 'Your turn') : (game.bonusThrow ? 'CPU bonus' : 'CPU turn');

  $('#board-status').textContent = game.phase === 'INITIAL_TOSS' ? 'Waiting to start' : game.winner ? 'Game finished' : game.pendingRoll ? 'Confirm the movement' : game.turn === 'player' ? 'Your turn' : 'CPU turn';
  $('#board-hint').textContent = game.pendingRoll?.actor === 'player' ? 'Blue dashed ring = piece to move · green ring = destination.' : 'Mirror every move from Metin2 here.';

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
  const actor = game.turn;
  checkpoint(`${actor} roll ${rollLabel(rollKey)}`);
  const rollRec = actor === 'player' ? recommendRoll(game, 'player') : null;
  applyRoll(game, actor, rollKey, {
    bonus: game.bonusThrow,
    selectedProbability: actor === 'player' ? selectedProbability : null,
    recommendedProbability: actor === 'player' ? rollRec?.best?.rollKey ?? null : null
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
    if (file.size > 10 * 1024 * 1024) throw new Error('File exceeds the 10 MB safety limit.');
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
