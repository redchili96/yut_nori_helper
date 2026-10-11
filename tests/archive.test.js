import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, startGame, applyRoll } from '../src/engine.js';
import { buildGameRecord, exportBundle, mergeBundle, archiveToCsv } from '../src/archive.js';

test('game record preserves selected probability and actual roll', () => {
  const game = createGame();
  startGame(game, 'player');
  applyRoll(game, 'player', 'GEOL', { selectedProbability: 'GAE' });
  const record = buildGameRecord({
    game,
    gameId: 'game-1',
    sourceId: 'source-1',
    helperVersion: '0.6.1',
    startedAt: '2026-10-11T09:00:00.000Z',
    savedAt: '2026-10-11T09:01:00.000Z'
  });
  const roll = record.events.find(e => e.type === 'roll');
  assert.equal(roll.selectedProbability, 'GAE');
  assert.equal(roll.rollKey, 'GEOL');
});

test('community bundle merge deduplicates sourceId + gameId', () => {
  const oldGame = { sourceId:'s1', gameId:'g1', savedAt:'2026-01-01', events:[] };
  const newGame = { sourceId:'s1', gameId:'g1', savedAt:'2026-01-02', events:[] };
  const bundle = exportBundle([newGame], { sourceId:'s1', helperVersion:'0.6.1' });
  const merged = mergeBundle([oldGame], bundle);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].savedAt, '2026-01-02');
});

test('CSV contains probability and actual result columns', () => {
  const csv = archiveToCsv([{
    sourceId:'s1', gameId:'g1', helperVersion:'0.6.1', startedAt:'x', winner:'player', finalPoints:220,
    finalBand:'Gold', throwsRemaining:10,
    events:[{index:1,type:'roll',actor:'player',selectedProbability:'GAE',rollKey:'GEOL',bonus:false}]
  }]);
  assert.match(csv, /selectedProbability/);
  assert.match(csv, /GAE,GEOL/);
});
