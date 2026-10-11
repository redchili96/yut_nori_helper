export const ARCHIVE_SCHEMA_VERSION = 1;
export const ARCHIVE_FORMAT = 'metin2-yut-nori-community-log';
export const ARCHIVE_STORAGE_KEY = 'yutNoriHelper.archive.v1';
export const SOURCE_STORAGE_KEY = 'yutNoriHelper.sourceId.v1';

export function makeId(prefix = 'id') {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createSourceId(storage = globalThis.localStorage) {
  try {
    const existing = storage?.getItem(SOURCE_STORAGE_KEY);
    if (existing) return existing;
    const id = makeId('source');
    storage?.setItem(SOURCE_STORAGE_KEY, id);
    return id;
  } catch {
    return makeId('source');
  }
}

export function readArchive(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(ARCHIVE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeArchive(games, storage = globalThis.localStorage) {
  storage?.setItem(ARCHIVE_STORAGE_KEY, JSON.stringify(games));
  return games;
}

export function upsertGame(record, storage = globalThis.localStorage) {
  const games = readArchive(storage);
  const key = `${record.sourceId}:${record.gameId}`;
  const idx = games.findIndex(g => `${g.sourceId}:${g.gameId}` === key);
  if (idx >= 0) games[idx] = record;
  else games.unshift(record);
  games.sort((a, b) => String(b.savedAt ?? b.startedAt).localeCompare(String(a.savedAt ?? a.startedAt)));
  writeArchive(games, storage);
  return games;
}

export function buildGameRecord({ game, gameId, sourceId, helperVersion, startedAt, savedAt = new Date().toISOString(), status = 'manual' }) {
  const startEvent = [...game.log].reverse().find(e => e.type === 'start');
  const chronologicalEvents = [...game.log].reverse().map((event, index) => ({ index: index + 1, ...event }));
  return {
    format: ARCHIVE_FORMAT,
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    sourceId,
    gameId,
    helperVersion,
    startedAt,
    endedAt: game.winner ? savedAt : null,
    savedAt,
    status: game.winner ? 'completed' : status,
    starter: startEvent?.starter ?? null,
    winner: game.winner ?? null,
    finalPoints: game.points,
    finalBand: game.points >= 220 ? 'Gold' : game.points >= 150 ? 'Silver' : 'Bronze',
    throwsRemaining: game.throws,
    playerFinished: game.player.filter(p => p.finished).length,
    computerFinished: game.computer.filter(p => p.finished).length,
    events: chronologicalEvents,
    finalState: {
      turn: game.turn,
      bonusThrow: Boolean(game.bonusThrow),
      player: structuredClone(game.player),
      computer: structuredClone(game.computer)
    }
  };
}

export function exportBundle(games, { sourceId = null, helperVersion = null, exportedAt = new Date().toISOString() } = {}) {
  return {
    format: ARCHIVE_FORMAT,
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    exportedAt,
    sourceId,
    helperVersion,
    games
  };
}

export function validateBundle(bundle) {
  if (!bundle || bundle.format !== ARCHIVE_FORMAT) throw new Error('Not a Yut Nori community log file.');
  if (bundle.schemaVersion !== ARCHIVE_SCHEMA_VERSION) throw new Error(`Unsupported log schema: ${bundle.schemaVersion}`);
  if (!Array.isArray(bundle.games)) throw new Error('Invalid log bundle: games missing.');
  if (bundle.games.length > 2000) throw new Error('Too many games in one import (limit: 2000).');
  for (const game of bundle.games) {
    if (!game || typeof game !== 'object' || typeof game.gameId !== 'string' || typeof game.sourceId !== 'string' || !Array.isArray(game.events)) throw new Error('Invalid game record in bundle.');
    if (!game.gameId || !game.sourceId || game.gameId.length > 128 || game.sourceId.length > 128) throw new Error('Invalid game/source ID.');
    if (game.events.length > 2000) throw new Error('Too many events in a game (limit: 2000).');
    if (game.events.some(event => !event || typeof event !== 'object' || typeof event.type !== 'string')) throw new Error('Invalid event in game record.');
  }
  return true;
}

export function mergeBundle(existingGames, bundle) {
  validateBundle(bundle);
  const byKey = new Map(existingGames.map(g => [`${g.sourceId}:${g.gameId}`, g]));
  for (const game of bundle.games) {
    const key = `${game.sourceId}:${game.gameId}`;
    const current = byKey.get(key);
    if (!current || String(game.savedAt ?? '') > String(current.savedAt ?? '')) byKey.set(key, game);
  }
  return [...byKey.values()].sort((a, b) => String(b.savedAt ?? b.startedAt).localeCompare(String(a.savedAt ?? a.startedAt)));
}

export function archiveToCsv(games) {
  const headers = [
    'sourceId','gameId','helperVersion','startedAt','winner','finalPoints','finalBand','throwsRemaining',
    'eventIndex','actor','selectedProbability','actualRoll','bonus','pieceIds','from','to','route','captured','finishedCount','special'
  ];
  const esc = value => {
    let s = value == null ? '' : String(value);
    // Spreadsheet programs can evaluate imported text as a formula. Treat
    // untrusted log fields as text even if they start with formula triggers.
    if (/^[\s\uFEFF\u200B]*[=+@-]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replaceAll('"','""')}"` : s;
  };
  const rows = [headers];
  for (const game of games) {
    const rolls = game.events.filter(e => e.type === 'roll');
    for (const event of rolls) {
      const nextMove = game.events.find(e => e.index > event.index && e.type === 'move' && e.actor === event.actor);
      rows.push([
        game.sourceId, game.gameId, game.helperVersion, game.startedAt, game.winner, game.finalPoints, game.finalBand, game.throwsRemaining,
        event.index, event.actor, event.selectedProbability ?? '', event.rollKey ?? '', Boolean(event.bonus),
        nextMove?.pieceIds?.join('+') ?? '', nextMove?.from ?? '', nextMove?.to ?? '', nextMove?.route ?? '', nextMove?.captured?.join('+') ?? '', nextMove?.finishedCount ?? '', nextMove?.special ?? ''
      ]);
    }
  }
  return rows.map(row => row.map(esc).join(',')).join('\n');
}
