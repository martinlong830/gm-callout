/**
 * Smoke-test: sanitized xlsx-js-style → ExcelJS load/write (same path as full report photos).
 * Run: node scripts/verify-xlsx-roundtrip.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx-js-style');
const ExcelJS = require('exceljs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

function buildSampleSheet() {
  const ws = {};
  ws.A1 = { v: 'Total', t: 's', s: { font: { bold: true } } };
  ws.B1 = { f: '=SUM(B2:B3)', t: 'n', s: { font: { bold: true } } };
  ws.A2 = { v: 'Row 1', t: 's' };
  ws.B2 = { v: 10, t: 'n' };
  ws.A3 = { v: 'Row 2', t: 's' };
  ws.B3 = { v: 20, t: 'n' };
  ws['!ref'] = 'A1:B3';
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 0 } }];
  ws['!views'] = [{ state: 'frozen', ySplit: 1, activeCell: 'A2' }];
  return ws;
}

async function main() {
  const wb = XLSX.utils.book_new();
  const ws = buildSampleSheet();
  xlSanitizeSheetForExport(ws);
  XLSX.utils.book_append_sheet(wb, ws, 'Payroll');
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer', bookSST: false });

  const excelWb = new ExcelJS.Workbook();
  await excelWb.xlsx.load(buf);
  const sheet = excelWb.getWorksheet('Payroll');
  const imagePath = path.join(__dirname, '..', 'assets', 'employee-photos', 'mark_ong.jpg');
  if (fs.existsSync(imagePath)) {
    const imageId = excelWb.addImage({
      buffer: fs.readFileSync(imagePath),
      extension: 'jpeg',
    });
    sheet.addImage(imageId, {
      tl: { col: 0.2, row: 1.15 },
      ext: { width: 72, height: 72 },
    });
  }
  const outPath = path.join(__dirname, '..', '.tmp-full-report-roundtrip.xlsx');
  await excelWb.xlsx.writeFile(outPath);

  const reload = new ExcelJS.Workbook();
  await reload.xlsx.readFile(outPath);
  const reSheet = reload.getWorksheet('Payroll');
  const formula = reSheet.getCell('B1').formula;
  if (!formula || !formula.includes('SUM')) {
    throw new Error('Formula lost after round-trip: ' + formula);
  }
  console.log('OK: round-trip xlsx written to', outPath);
  console.log('OK: formula preserved:', formula);
}

main().catch(function (err) {
  console.error('FAIL:', err);
  process.exit(1);
});
