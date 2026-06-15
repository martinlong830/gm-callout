/**
 * Compare unsanitized vs sanitized ExcelJS round-trip (merge/view/formula issues).
 * Run: node scripts/verify-xlsx-sanitize-effect.mjs
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx-js-style');
const ExcelJS = require('exceljs');

function xlSanitizeSheetForExport(ws) {
  if (!ws) return ws;
  delete ws['!views'];
  const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
  if (ws['!merges'] && ws['!merges'].length) {
    ws['!merges'] = ws['!merges'].filter(function (m) {
      if (!m || !m.s || !m.e) return false;
      return (
        m.s.r >= range.s.r &&
        m.s.c >= range.s.c &&
        m.e.r <= range.e.r &&
        m.e.c <= range.e.c &&
        m.s.r <= m.e.r &&
        m.s.c <= m.e.c
      );
    });
  }
  Object.keys(ws).forEach(function (k) {
    if (k.charAt(0) === '!') return;
    const cell = ws[k];
    if (!cell || cell.f == null) return;
    const f = String(cell.f).trim();
    if (f.charAt(0) === '=') cell.f = f.slice(1);
  });
  return ws;
}

function cloneSheet(ws) {
  return JSON.parse(JSON.stringify(ws));
}

function buildProblemSheet() {
  const ws = {};
  ws.A1 = { v: 'Bad merge', t: 's' };
  ws.B1 = { f: '=SUM(B2:B3)', t: 'n' };
  ws.B2 = { v: 1, t: 'n' };
  ws.B3 = { v: 2, t: 'n' };
  ws['!ref'] = 'A1:B3';
  ws['!merges'] = [{ s: { r: 5, c: 0 }, e: { r: 6, c: 1 } }];
  ws['!views'] = [{ state: 'frozen', ySplit: 99, activeCell: 'Z999' }];
  return ws;
}

async function roundTrip(label, ws) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Test');
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer', bookSST: false });
  const excelWb = new ExcelJS.Workbook();
  await excelWb.xlsx.load(buf);
  return excelWb.xlsx.writeBuffer();
}

async function main() {
  const raw = buildProblemSheet();
  const clean = cloneSheet(raw);
  xlSanitizeSheetForExport(clean);

  await roundTrip('sanitized', clean);
  console.log('OK: sanitized problematic sheet round-trips through ExcelJS');

  try {
    await roundTrip('unsanitized', raw);
    console.log('NOTE: unsanitized sheet also round-tripped (environment may tolerate bad merges)');
  } catch (err) {
    console.log('OK: unsanitized sheet failed round-trip as expected:', err.message);
  }
}

main().catch(function (err) {
  console.error('FAIL:', err);
  process.exit(1);
});
