import test from 'node:test';
import assert from 'node:assert/strict';
import { pushCheckpoint, undoState, redoState } from '../src/timeline.js';

test('undo stores the current state for redo', () => {
  const undo = [];
  const redo = [];
  pushCheckpoint(undo, redo, { label: 'move P1', value: 1 });
  const target = undoState(undo, redo, { value: 2 });
  assert.equal(target.value, 1);
  assert.equal(redo.length, 1);
  assert.equal(redo[0].value, 2);
  assert.equal(redo[0].label, 'move P1');
});

test('redo restores the forward state and rebuilds undo history', () => {
  const undo = [{ label: 'move P1', value: 1 }];
  const redo = [];
  const back = undoState(undo, redo, { value: 2 });
  assert.equal(back.value, 1);
  const forward = redoState(undo, redo, { value: 1 });
  assert.equal(forward.value, 2);
  assert.equal(undo.length, 1);
  assert.equal(undo[0].value, 1);
});

test('a new checkpoint after undo clears redo history', () => {
  const undo = [{ label: 'old', value: 1 }];
  const redo = [];
  undoState(undo, redo, { value: 2 });
  assert.equal(redo.length, 1);
  pushCheckpoint(undo, redo, { label: 'new move', value: 3 });
  assert.equal(redo.length, 0);
});
