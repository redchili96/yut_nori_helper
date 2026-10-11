export function pushCheckpoint(undoStack, redoStack, snapshot, limit = 80) {
  undoStack.push(snapshot);
  if (undoStack.length > limit) undoStack.shift();
  redoStack.length = 0;
}

export function undoState(undoStack, redoStack, currentSnapshot, limit = 80) {
  const target = undoStack.pop();
  if (!target) return null;
  redoStack.push({ ...currentSnapshot, label: target.label });
  if (redoStack.length > limit) redoStack.shift();
  return target;
}

export function redoState(undoStack, redoStack, currentSnapshot, limit = 80) {
  const target = redoStack.pop();
  if (!target) return null;
  undoStack.push({ ...currentSnapshot, label: target.label });
  if (undoStack.length > limit) undoStack.shift();
  return target;
}
