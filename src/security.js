/** Encode potentially user-supplied values before placing them inside HTML templates. */
const HTML_ENTITIES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
});

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => HTML_ENTITIES[char]);
}

/** Imported IDs only become part of a download filename after sanitization. */
export function safeFileId(value) {
  return String(value ?? 'game').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'game';
}
