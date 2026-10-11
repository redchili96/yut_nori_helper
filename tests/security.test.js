import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, safeFileId } from '../src/security.js';
import { validateBundle, archiveToCsv } from '../src/archive.js';

test('HTML escaping makes imported fields safe to interpolate', () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(escapeHtml(`' & < > "`), '&#39; &amp; &lt; &gt; &quot;');
});

test('download filename ID removes path and unsafe characters', () => {
  assert.equal(safeFileId('../../my game:<script>'), '______my_game__script_');
});

test('bundle validator rejects malicious oversized or invalid records', () => {
  const standard = { format: 'metin2-yut-nori-community-log', schemaVersion: 1 };
  assert.throws(() => validateBundle({ ...standard, games: [{ gameId:'g', sourceId:'s', events:new Array(2001).fill({}) }] }), /Too many events/);
  assert.throws(() => validateBundle({ ...standard, games: [{ gameId:'g', sourceId:'s', events:'bad' }] }), /Invalid game record/);
});


test('CSV export neutralizes a spreadsheet formula in an imported source ID', () => {
  const exported = archiveToCsv([{
    sourceId: '=HYPERLINK("http://example.invalid")',
    gameId:'game-1', helperVersion:'0.8.0', startedAt:'2026-10-11',
    winner:'player', finalPoints:100, finalBand:'Bronze', throwsRemaining:10,
    events:[{ index:1,type:'roll',actor:'player',rollKey:'DO',selectedProbability:'DO' }]
  }]);
  assert.match(exported, /^sourceId,/);
  assert.match(exported, /"'=HYPERLINK/);
});
