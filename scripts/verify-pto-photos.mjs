/**
 * Smoke-test PTO photo embed path: sanitize → XLSX → ExcelJS → Uint8Array image → write.
 * Run: node scripts/verify-pto-photos.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx-js-style');
const ExcelJS = require('exceljs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

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
    ws['!merges'] = xlDedupeMergesForExport(ws['!merges']);
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

function buildPtoLikeSheet() {
  const ws = {};
  ws.A1 = { v: 'EMPLOYEE TIME OFF TRACKER', t: 's' };
  ws.A3 = { v: 'MO', t: 's' }; // initials placeholder row 3 (0-based row 2)
  ws['!ref'] = 'A1:Z10';
  ws['!merges'] = [
    { s: { r: 2, c: 0 }, e: { r: 6, c: 1 } },
    // Duplicate merge (PAYSLIP bug): same region listed twice breaks ExcelJS load.
    { s: { r: 2, c: 10 }, e: { r: 2, c: 11 } },
    { s: { r: 2, c: 10 }, e: { r: 2, c: 11 } },
  ];
  ws['!views'] = [{ state: 'frozen', ySplit: 2, activeCell: 'A3' }];
  return ws;
}

function xlDedupeMergesForExport(merges) {
  if (!merges || !merges.length) return merges;
  const kept = [];
  merges.forEach(function (m) {
    if (!m || !m.s || !m.e || m.s.r > m.e.r || m.s.c > m.e.c) return;
    const duplicate = kept.some(function (k) {
      return k.s.r === m.s.r && k.s.c === m.s.c && k.e.r === m.e.r && k.e.c === m.e.c;
    });
    if (duplicate) return;
    const overlap = kept.some(function (k) {
      return !(k.e.r < m.s.r || k.s.r > m.e.r || k.e.c < m.s.c || k.s.c > m.e.c);
    });
    if (!overlap) kept.push(m);
  });
  return kept;
}

function countZipEntries(buf, prefix) {
  // Minimal check: xlsx is zip; embedded images live under xl/media/
  const needle = Buffer.from(prefix);
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = buf.indexOf(needle, pos);
    if (idx === -1) break;
    count += 1;
    pos = idx + needle.length;
  }
  return count;
}

async function runCase(label, imageBuffer, useUint8Array) {
  const wb = XLSX.utils.book_new();
  const ws = buildPtoLikeSheet();
  xlSanitizeSheetForExport(ws);
  XLSX.utils.book_append_sheet(wb, ws, 'PTO');
  const xlsxBuf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer', bookSST: false });

  const excelWb = new ExcelJS.Workbook();
  await excelWb.xlsx.load(xlsxBuf);
  const sheet = excelWb.getWorksheet('PTO');
  if (!sheet) throw new Error(label + ': PTO sheet missing after load');

  const buf = useUint8Array ? new Uint8Array(imageBuffer) : imageBuffer;
  const imageId = excelWb.addImage({ buffer: buf, extension: 'jpeg' });
  sheet.addImage(imageId, {
    tl: { col: 0.2, row: 2.15 },
    ext: { width: 72, height: 72 },
  });

  const out = await excelWb.xlsx.writeBuffer();
  const outBuf = Buffer.from(out);
  const mediaHits = countZipEntries(outBuf, 'xl/media/');
  console.log(label + ': media entries in zip ~', mediaHits, useUint8Array ? '(Uint8Array)' : '(Buffer)');
  if (mediaHits < 1) throw new Error(label + ': no xl/media/ in output');
  return outBuf;
}

async function main() {
  const imagePath = path.join(ROOT, 'assets', 'employee-photos', 'mark_ong.jpg');
  if (!fs.existsSync(imagePath)) throw new Error('Missing test photo: ' + imagePath);
  const raw = fs.readFileSync(imagePath);

  await runCase('Buffer', raw, false);
  await runCase('Uint8Array', raw, true);

  const outPath = path.join(ROOT, '.tmp-pto-photos-test.xlsx');
  const out = await runCase('Final write', raw, true);
  fs.writeFileSync(outPath, out);
  console.log('OK: wrote', outPath);
}

main().catch(function (err) {
  console.error('FAIL:', err);
  process.exit(1);
});
