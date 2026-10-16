import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, startGame, applyRoll, legalMoves, applyMove } from '../src/engine.js';
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


test('game record preserves optional Strategy v2 telemetry on roll and move events', () => {
  const game = createGame();
  startGame(game, 'player');
  const rollTelemetry = {
    kind:'probability-decision', engineVersion:'v2', utilityScale:'internal-relative-not-percentage',
    selectedChoice:{ rollKey:'GAE', rank:2, utility:100, utilityGapFromBest:25 },
    alternatives:[{rank:1,rollKey:'DO',utility:125,utilityGapFromBest:0}]
  };
  applyRoll(game, 'player', 'GAE', {
    selectedProbability:'GAE', recommendedProbability:'DO', strategyTelemetry:rollTelemetry
  });
  const move = legalMoves(game, 'player', 'GAE')[0];
  const moveTelemetry = {
    kind:'move-decision', engineVersion:'v2',
    recommendation:{move:{pieceIds:move.pieceIds,from:move.from,to:move.to,route:move.route},utility:200},
    actualChoice:{move:{pieceIds:move.pieceIds,from:move.from,to:move.to,route:move.route},rank:1,utility:200,utilityGapFromBest:0},
    alternatives:[]
  };
  applyMove(game, move, { recommendedMove: move, strategyTelemetry: moveTelemetry });
  const record = buildGameRecord({
    game, gameId:'g-telemetry', sourceId:'s-telemetry', helperVersion:'0.8.1',
    startedAt:'2026-10-11T13:00:00.000Z', savedAt:'2026-10-11T13:01:00.000Z'
  });
  const roll = record.events.find(e => e.type === 'roll');
  const moved = record.events.find(e => e.type === 'move');
  assert.deepEqual(roll.strategyTelemetry, rollTelemetry);
  assert.deepEqual(moved.strategyTelemetry, moveTelemetry);
});

test('schema v1 community logs without telemetry remain valid and mergeable', () => {
  const legacy = exportBundle([{sourceId:'legacy', gameId:'g1', savedAt:'2026-10-11', events:[]}], {
    sourceId:'legacy', helperVersion:'0.8.0'
  });
  const merged = mergeBundle([], legacy);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].events[0], undefined);
});

test('CSV adds telemetry analysis columns while retaining legacy roll columns', () => {
  const csv = archiveToCsv([{
    sourceId:'s1', gameId:'g1', helperVersion:'0.8.1', startedAt:'x', winner:'player', finalPoints:220,
    finalBand:'Gold', throwsRemaining:10,
    events:[
      {index:1,type:'roll',actor:'player',selectedProbability:'GAE',recommendedProbability:'DO',rollKey:'GEOL',bonus:false,
       strategyTelemetry:{recommendation:{utility:120},selectedChoice:{rank:2,utility:87,utilityGapFromBest:33}}},
      {index:2,type:'move',actor:'player',pieceIds:['P1'],from:'HOME',to:'O3',route:'OUTER',captured:[],finishedCount:0,
       strategyTelemetry:{recommendation:{move:{to:'O3'},utility:200},actualChoice:{rank:1,utility:200,utilityGapFromBest:0}}}
    ]
  }]);
  assert.match(csv, /recommendedProbability,recommendedProbabilityUtility,selectedProbabilityRank,selectedProbabilityUtility,probabilityUtilityGap/);
  assert.match(csv, /recommendedMoveUtility,actualMoveRank,actualMoveUtility,moveUtilityGap/);
  assert.match(csv, /GAE,GEOL/);
  assert.match(csv, /DO,120,2,87,33,[^\n]*,200,1,200,0/);
});


test('CSV does not attach a later-turn move to a roll that had no legal movement', () => {
  const csv = archiveToCsv([{
    sourceId:'s1', gameId:'pass-game', helperVersion:'0.8.1', startedAt:'x', winner:null, finalPoints:230,
    finalBand:'Gold', throwsRemaining:18,
    events:[
      {index:1,type:'roll',actor:'player',selectedProbability:'BACK_DO',rollKey:'BACK_DO',bonus:false},
      {index:2,type:'roll',actor:'computer',rollKey:'DO',bonus:false},
      {index:3,type:'move',actor:'computer',pieceIds:['C1'],from:'HOME',to:'O1',route:'OUTER',captured:[],finishedCount:0},
      {index:4,type:'roll',actor:'player',selectedProbability:'DO',rollKey:'DO',bonus:false},
      {index:5,type:'move',actor:'player',pieceIds:['P1'],from:'HOME',to:'O1',route:'OUTER',captured:[],finishedCount:0}
    ]
  }]);
  const rows = csv.split('\n');
  const firstPlayerRoll = rows.find(row => row.includes('BACK_DO,BACK_DO'));
  assert.ok(firstPlayerRoll);
  assert.doesNotMatch(firstPlayerRoll, /P1/);
});


test('CSV records interactive-board input method for inferred moves', () => {
  const csv = archiveToCsv([{
    sourceId:'s1', gameId:'interactive', helperVersion:'0.9.0', startedAt:'x', winner:null, finalPoints:240,
    finalBand:'Gold', throwsRemaining:19,
    events:[
      {index:1,type:'roll',actor:'player',inputMethod:'interactive-board',selectedProbability:'DO',rollKey:'GEOL',bonus:false},
      {index:2,type:'move',actor:'player',inputMethod:'interactive-board',pieceIds:['P1'],from:'HOME',to:'O3',route:'OUTER',captured:[],finishedCount:0}
    ]
  }]);
  assert.match(csv, /inputMethod/);
  assert.match(csv, /player,interactive-board,DO,GEOL/);
});