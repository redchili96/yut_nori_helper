import { ROLLS } from './board.js';

export const ROLL_KEYS = ['BACK_DO', 'DO', 'GAE', 'GEOL', 'YUT', 'MO'];

// Provisional calibration snapshot from the community logs reviewed on 2026-10-11.
// CPU rolls are the best available estimate of the unselected/base distribution.
// Selected rows are observed actual outcomes conditional on the option chosen.
// These are observations, not claimed Gameforge RNG constants.
const SEED_BASELINE_COUNTS = {
  BACK_DO: 6,
  DO: 17,
  GAE: 28,
  GEOL: 12,
  YUT: 6,
  MO: 4
};

const SEED_SELECTED_COUNTS = {
  BACK_DO: { BACK_DO: 1, DO: 1, GAE: 2, GEOL: 2, YUT: 0, MO: 0 },
  DO:      { BACK_DO: 0, DO: 3, GAE: 1, GEOL: 4, YUT: 0, MO: 0 },
  GAE:     { BACK_DO: 0, DO: 2, GAE: 1, GEOL: 0, YUT: 0, MO: 0 },
  GEOL:    { BACK_DO: 0, DO: 0, GAE: 2, GEOL: 3, YUT: 0, MO: 1 },
  YUT:     { BACK_DO: 2, DO: 3, GAE: 5, GEOL: 4, YUT: 1, MO: 0 },
  MO:      { BACK_DO: 1, DO: 0, GAE: 4, GEOL: 4, YUT: 0, MO: 1 }
};

export const DEFAULT_PROBABILITY_CONFIG = Object.freeze({
  // The selected option is modelled as a common multiplicative lift on its
  // base probability. v0.9.1 deliberately shrinks this effect toward 1.0
  // until substantially more selected-roll evidence exists. This prevents a
  // sparse/noisy archive from creating overconfident probability advice.
  minRawSelectionMultiplier: 0.5,
  maxRawSelectionMultiplier: 4,
  selectionEvidenceHalfLife: 180,
  minCommunityCpuRolls: 40,
  minCommunitySelectedRolls: 30
});

function emptyCounts() {
  return Object.fromEntries(ROLL_KEYS.map(key => [key, 0]));
}

function emptySelectedCounts() {
  return Object.fromEntries(ROLL_KEYS.map(selected => [selected, emptyCounts()]));
}

function totalCounts(counts) {
  return ROLL_KEYS.reduce((sum, key) => sum + (counts[key] ?? 0), 0);
}

function normalize(counts) {
  const total = totalCounts(counts);
  if (!total) {
    const equal = 1 / ROLL_KEYS.length;
    return Object.fromEntries(ROLL_KEYS.map(key => [key, equal]));
  }
  return Object.fromEntries(ROLL_KEYS.map(key => [key, (counts[key] ?? 0) / total]));
}

export function collectObservedCounts(games = []) {
  const baselineCounts = emptyCounts();
  const selectedCounts = emptySelectedCounts();
  let cpuRolls = 0;
  let selectedPlayerRolls = 0;

  for (const game of games ?? []) {
    for (const event of game?.events ?? []) {
      if (event?.type !== 'roll' || !ROLLS[event.rollKey]) continue;
      if (event.actor === 'computer') {
        baselineCounts[event.rollKey] += 1;
        cpuRolls += 1;
      } else if (event.actor === 'player' && ROLLS[event.selectedProbability]) {
        selectedCounts[event.selectedProbability][event.rollKey] += 1;
        selectedPlayerRolls += 1;
      }
    }
  }

  return { baselineCounts, selectedCounts, cpuRolls, selectedPlayerRolls };
}

function selectedDistribution(baseline, selectedKey, multiplier) {
  const weights = Object.fromEntries(ROLL_KEYS.map(key => [
    key,
    baseline[key] * (key === selectedKey ? multiplier : 1)
  ]));
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(ROLL_KEYS.map(key => [key, weights[key] / total]));
}

function selectionLogLikelihood(baseline, selectedCounts, multiplier) {
  let ll = 0;
  for (const selectedKey of ROLL_KEYS) {
    const distribution = selectedDistribution(baseline, selectedKey, multiplier);
    const row = selectedCounts[selectedKey] ?? {};
    for (const actualKey of ROLL_KEYS) {
      const count = row[actualKey] ?? 0;
      if (!count) continue;
      ll += count * Math.log(Math.max(1e-12, distribution[actualKey]));
    }
  }
  return ll;
}

function fitSelectionMultiplier(baseline, selectedCounts, config) {
  const lo = Math.max(0.05, config.minRawSelectionMultiplier);
  const hi = Math.max(lo, config.maxRawSelectionMultiplier);
  let best = lo;
  let bestLl = -Infinity;

  // Tiny one-dimensional fit; deterministic and cheap enough to rebuild after imports.
  const coarseSteps = 350;
  for (let i = 0; i <= coarseSteps; i += 1) {
    const m = lo + (hi - lo) * (i / coarseSteps);
    const ll = selectionLogLikelihood(baseline, selectedCounts, m);
    if (ll > bestLl) {
      bestLl = ll;
      best = m;
    }
  }

  const radius = (hi - lo) / coarseSteps;
  const refineLo = Math.max(lo, best - radius);
  const refineHi = Math.min(hi, best + radius);
  for (let i = 0; i <= 100; i += 1) {
    const m = refineLo + (refineHi - refineLo) * (i / 100);
    const ll = selectionLogLikelihood(baseline, selectedCounts, m);
    if (ll > bestLl) {
      bestLl = ll;
      best = m;
    }
  }
  return best;
}

export function buildProbabilityModel(games = [], config = {}) {
  const cfg = { ...DEFAULT_PROBABILITY_CONFIG, ...config };
  const observed = collectObservedCounts(games);
  const useCommunity = observed.cpuRolls >= cfg.minCommunityCpuRolls
    && observed.selectedPlayerRolls >= cfg.minCommunitySelectedRolls;

  const baselineCounts = useCommunity ? observed.baselineCounts : { ...SEED_BASELINE_COUNTS };
  const selectedCounts = useCommunity ? observed.selectedCounts : structuredClone(SEED_SELECTED_COUNTS);
  const baseline = normalize(baselineCounts);
  const rawSelectionMultiplier = fitSelectionMultiplier(baseline, selectedCounts, cfg);
  const selectedPlayerRolls = useCommunity
    ? observed.selectedPlayerRolls
    : Object.values(SEED_SELECTED_COUNTS).reduce((sum, row) => sum + totalCounts(row), 0);
  const evidenceWeight = selectedPlayerRolls / (selectedPlayerRolls + Math.max(1, cfg.selectionEvidenceHalfLife));
  // Never infer that selecting an option actively makes that option less likely.
  // If the current sample points below 1.0, treat the effect as unproven instead.
  const positiveLift = Math.max(0, rawSelectionMultiplier - 1);
  const selectionMultiplier = 1 + positiveLift * evidenceWeight;
  const selected = Object.fromEntries(ROLL_KEYS.map(selectedKey => [
    selectedKey,
    selectedDistribution(baseline, selectedKey, selectionMultiplier)
  ]));

  const selectedByChoice = Object.fromEntries(ROLL_KEYS.map(key => [key, totalCounts(selectedCounts[key])]));
  const choiceConfidence = Object.fromEntries(ROLL_KEYS.map(key => {
    const n = selectedByChoice[key];
    return [key, n / (n + 100)];
  }));
  const confidenceLevel = evidenceWeight < 0.33 ? 'low' : evidenceWeight < 0.67 ? 'medium' : 'high';
  return {
    source: useCommunity ? 'local/community archive' : '2026-10-11 provisional seed',
    observed: useCommunity,
    config: cfg,
    baseline,
    selected,
    rawSelectionMultiplier,
    selectionMultiplier,
    confidence: {
      level: confidenceLevel,
      evidenceWeight,
      byChoice: choiceConfidence
    },
    sample: {
      cpuRolls: useCommunity ? observed.cpuRolls : totalCounts(SEED_BASELINE_COUNTS),
      selectedPlayerRolls,
      selectedByChoice
    }
  };
}

let activeModel = buildProbabilityModel([]);

export function configureProbabilityModel(games = [], config = {}) {
  activeModel = buildProbabilityModel(games, config);
  return activeModel;
}

export function getProbabilityModel() {
  return activeModel;
}

export function distributionFor(actor, selectedProbability = null, model = activeModel) {
  if (actor === 'player' && selectedProbability && model.selected[selectedProbability]) {
    return model.selected[selectedProbability];
  }
  return model.baseline;
}

export const __probabilityInternals = {
  normalize,
  totalCounts,
  selectedDistribution,
  selectionLogLikelihood,
  fitSelectionMultiplier,
  SEED_BASELINE_COUNTS,
  SEED_SELECTED_COUNTS
};