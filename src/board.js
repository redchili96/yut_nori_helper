export const FINISH = 'FINISH';
export const HOME = 'HOME';

export const ROLLS = {
  BACK_DO: { key: 'BACK_DO', label: 'Back Do', steps: -1 },
  DO: { key: 'DO', label: 'Do', steps: 1 },
  GAE: { key: 'GAE', label: 'Gae', steps: 2 },
  GEOL: { key: 'GEOL', label: 'Geol', steps: 3 },
  YUT: { key: 'YUT', label: 'Yut', steps: 4, bonus: true },
  MO: { key: 'MO', label: 'Mo', steps: 5, bonus: true }
};

export const OUTER = Array.from({ length: 19 }, (_, i) => `O${i + 1}`);

// O5 = top-right corner, O10 = top-left corner, O15 = bottom-left corner.
export const ROUTES = {
  OUTER: [...OUTER, FINISH],
  TR_TO_BL: ['O5', 'TR1', 'TR2', 'C', 'BL2', 'BL1', 'O15', 'O16', 'O17', 'O18', 'O19', FINISH],
  TL_TO_FINISH: ['O10', 'TL1', 'TL2', 'C', 'BR2', 'BR1', FINISH],
  C_TO_BL: ['C', 'BL2', 'BL1', 'O15', 'O16', 'O17', 'O18', 'O19', FINISH],
  C_TO_FINISH: ['C', 'BR2', 'BR1', FINISH]
};

export const BRANCH_NODES = new Set(['O5', 'O10', 'C']);
export const SPECIAL_NODES = new Set(['O5', 'O10', 'O15', 'C']);

// Normalized coordinates for the SVG board.
export const NODE_POSITIONS = {
  // Tuned to the actual Gameforge board: six evenly-spaced nodes per outer side.
  FINISH: [0.90, 0.90],
  O1: [0.90, 0.74], O2: [0.90, 0.58], O3: [0.90, 0.42], O4: [0.90, 0.26], O5: [0.90, 0.10],
  O6: [0.74, 0.10], O7: [0.58, 0.10], O8: [0.42, 0.10], O9: [0.26, 0.10], O10: [0.10, 0.10],
  O11: [0.10, 0.26], O12: [0.10, 0.42], O13: [0.10, 0.58], O14: [0.10, 0.74], O15: [0.10, 0.90],
  O16: [0.26, 0.90], O17: [0.42, 0.90], O18: [0.58, 0.90], O19: [0.74, 0.90],
  TR1: [0.74, 0.26], TR2: [0.58, 0.42], C: [0.50, 0.50], BL2: [0.42, 0.58], BL1: [0.26, 0.74],
  TL1: [0.26, 0.26], TL2: [0.42, 0.42], BR2: [0.58, 0.58], BR1: [0.74, 0.74]
};

export const EDGES = [
  // Outer route.
  ['FINISH', 'O1'], ['O1', 'O2'], ['O2', 'O3'], ['O3', 'O4'], ['O4', 'O5'],
  ['O5', 'O6'], ['O6', 'O7'], ['O7', 'O8'], ['O8', 'O9'], ['O9', 'O10'],
  ['O10', 'O11'], ['O11', 'O12'], ['O12', 'O13'], ['O13', 'O14'], ['O14', 'O15'],
  ['O15', 'O16'], ['O16', 'O17'], ['O17', 'O18'], ['O18', 'O19'], ['O19', 'FINISH'],
  // Diagonals.
  ['O5', 'TR1'], ['TR1', 'TR2'], ['TR2', 'C'], ['C', 'BL2'], ['BL2', 'BL1'], ['BL1', 'O15'],
  ['O10', 'TL1'], ['TL1', 'TL2'], ['TL2', 'C'], ['C', 'BR2'], ['BR2', 'BR1'], ['BR1', 'FINISH']
];

export function routeChoicesForNode(node, currentRoute = 'OUTER') {
  // Confirmed in the live 2026 client: once a piece is standing on the two
  // shortcut-entry corners, its next forward move is forced onto the diagonal.
  // Back Do is handled separately by the engine and still follows the route
  // the piece used to reach the corner (e.g. O5 -> O4).
  if (node === 'O5') return ['TR_TO_BL'];
  if (node === 'O10') return ['TL_TO_FINISH'];
  if (node === 'C') {
    // Confirmed in the live client: Centre can continue toward either lower diagonal,
    // including the bottom-right route to Finish.
    return ['C_TO_BL', 'C_TO_FINISH'];
  }
  return [currentRoute];
}
