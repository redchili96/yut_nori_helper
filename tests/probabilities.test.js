import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProbabilityModel, distributionFor, ROLL_KEYS } from '../src/probabilities.js';

function sumDistribution(dist) {
  return ROLL_KEYS.reduce((sum, key) => sum + dist[key], 0);
}

test('provisional baseline is evidence-based and not forced to equal probabilities', () => {
  const model = buildProbabilityModel([]);
  assert.equal(model.source, '2026-10-11 provisional seed');
  assert.equal(model.sample.cpuRolls, 73);
  assert.equal(model.sample.selectedPlayerRolls, 48);
  assert.notEqual(model.baseline.GAE, model.baseline.MO);
  assert.ok(Math.abs(sumDistribution(model.baseline) - 1) < 1e-9);
});

test('selection multiplier is fitted from observed logs and raises the selected target conservatively', () => {
  const model = buildProbabilityModel([]);
  assert.ok(model.selectionMultiplier > 1);
  assert.ok(model.selectionMultiplier < 4);
  for (const selected of ROLL_KEYS) {
    const dist = distributionFor('player', selected, model);
    assert.ok(Math.abs(sumDistribution(dist) - 1) < 1e-9);
    assert.ok(dist[selected] > model.baseline[selected]);
  }
});

test('community archive replaces the seed calibration after minimum sample thresholds', () => {
  const events = [];
  for (let i = 0; i < 40; i += 1) {
    events.push({ type: 'roll', actor: 'computer', rollKey: i % 2 ? 'DO' : 'GAE' });
  }
  for (let i = 0; i < 30; i += 1) {
    events.push({
      type: 'roll', actor: 'player', selectedProbability: 'DO',
      rollKey: i % 3 === 0 ? 'DO' : 'GAE'
    });
  }
  const model = buildProbabilityModel([{ events }]);
  assert.equal(model.source, 'local/community archive');
  assert.equal(model.sample.cpuRolls, 40);
  assert.equal(model.sample.selectedPlayerRolls, 30);
});

test('v0.9.1 shrinks sparse selection evidence and exposes confidence metadata', () => {
  const events = [];
  const baseline = ['BACK_DO','DO','GAE','GEOL','YUT','MO'];
  for (let i = 0; i < 60; i += 1) {
    events.push({ type: 'roll', actor: 'computer', rollKey: baseline[i % baseline.length] });
  }
  for (let i = 0; i < 60; i += 1) {
    const selectedProbability = baseline[i % baseline.length];
    const rollKey = baseline[(i + 1) % baseline.length]; // deliberately never matches selection
    events.push({ type: 'roll', actor: 'player', selectedProbability, rollKey });
  }

  const model = buildProbabilityModel([{ events }], { minCommunityCpuRolls: 0, minCommunitySelectedRolls: 0 });
  assert.ok(model.rawSelectionMultiplier <= 1);
  assert.equal(model.selectionMultiplier, 1);
  assert.equal(model.confidence.level, 'low');
  assert.ok(model.confidence.evidenceWeight > 0 && model.confidence.evidenceWeight < 0.5);
  for (const selected of ROLL_KEYS) {
    const dist = distributionFor('player', selected, model);
    for (const key of ROLL_KEYS) assert.ok(Math.abs(dist[key] - model.baseline[key]) < 1e-12);
  }
});