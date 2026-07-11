/**
 * Smoke-test PTO photo embed path: sanitize → XLSX → ExcelJS → Uint8Array image → write.
 * Also asserts non-square photos keep aspect ratio (contain-fit into max box).
 * Run: node scripts/verify-pto-photos.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx-js-style');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PTO_PHOTO_PX = 72;

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

/** Mirror of timecards-manager.js ptoPhotoFitSize (contain into max box). */
function ptoPhotoFitSize(natW, natH, maxW, maxH) {
  const boxW = maxW > 0 ? maxW : PTO_PHOTO_PX;
  const boxH = maxH > 0 ? maxH : PTO_PHOTO_PX;
  if (!(natW > 0) || !(natH > 0)) return { width: boxW, height: boxH };
  const scale = Math.min(boxW / natW, boxH / natH);
  return {
    width: Math.max(1, Math.round(natW * scale)),
    height: Math.max(1, Math.round(natH * scale)),
  };
}

function readJpegDimensions(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8[0] !== 0xff || u8[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < u8.length) {
    if (u8[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = u8[i + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const segLen = (u8[i + 2] << 8) | u8[i + 3];
    if (segLen < 2) break;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      const jh = (u8[i + 5] << 8) | u8[i + 6];
      const jw = (u8[i + 7] << 8) | u8[i + 8];
      if (jw > 0 && jh > 0) return { width: jw, height: jh };
      return null;
    }
    i += 2 + segLen;
  }
  return null;
}

/** Build a wide non-square JPEG via sips (macOS) for aspect-ratio assertions. */
function makeWideTestJpeg(srcPath, destPath, width, height) {
  fs.copyFileSync(srcPath, destPath);
  execFileSync('sips', ['-z', String(height), String(width), destPath], { stdio: 'pipe' });
}

async function assertDrawingAspect(outBuf, expectedW, expectedH, label) {
  const zip = await JSZip.loadAsync(outBuf);
  const drawingPath = Object.keys(zip.files).find((p) => /xl\/drawings\/drawing\d+\.xml$/i.test(p));
  if (!drawingPath) throw new Error(label + ': no drawing XML');
  const xml = await zip.file(drawingPath).async('string');
  // Display size is on xdr:ext (oneCellAnchor), not a:ext inside spPr.
  const m = xml.match(/<xdr:ext\s+cx="(\d+)"\s+cy="(\d+)"\s*\/>/);
  if (!m) throw new Error(label + ': missing xdr:ext cx/cy in drawing');
  const cx = Number(m[1]);
  const cy = Number(m[2]);
  if (!(cx > 0) || !(cy > 0)) {
    throw new Error(label + ': invalid xdr:ext cx/cy ' + cx + '/' + cy);
  }
  // Excel uses EMUs; ExcelJS maps 1px ≈ 9525 EMUs at 96dpi
  const ratio = cx / cy;
  const expectedRatio = expectedW / expectedH;
  if (Math.abs(ratio - expectedRatio) > 0.02) {
    throw new Error(
      label +
        ': warped drawing aspect cx/cy=' +
        ratio.toFixed(4) +
        ' expected ~' +
        expectedRatio.toFixed(4) +
        ' (ext ' +
        expectedW +
        'x' +
        expectedH +
        ')'
    );
  }
  console.log(label + ': drawing aspect OK (cx/cy ≈', ratio.toFixed(3) + ')');
}

async function runCase(label, imageBuffer, useUint8Array, fitExt) {
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
  const dims = readJpegDimensions(buf);
  const fitted =
    fitExt ||
    ptoPhotoFitSize(
      dims && dims.width,
      dims && dims.height,
      PTO_PHOTO_PX,
      PTO_PHOTO_PX
    );
  const imageId = excelWb.addImage({ buffer: buf, extension: 'jpeg' });
  const padX = Math.max(0, (PTO_PHOTO_PX - fitted.width) / 2);
  const padY = Math.max(0, (PTO_PHOTO_PX - fitted.height) / 2);
  sheet.addImage(imageId, {
    tl: {
      col: 0.2 + padX / 56,
      row: 2.15 + padY / 20,
    },
    ext: { width: fitted.width, height: fitted.height },
  });

  const out = await excelWb.xlsx.writeBuffer();
  const outBuf = Buffer.from(out);
  const mediaHits = countZipEntries(outBuf, 'xl/media/');
  console.log(
    label + ': media entries in zip ~',
    mediaHits,
    useUint8Array ? '(Uint8Array)' : '(Buffer)',
    'ext',
    fitted.width + 'x' + fitted.height
  );
  if (mediaHits < 1) throw new Error(label + ': no xl/media/ in output');
  await assertDrawingAspect(outBuf, fitted.width, fitted.height, label);
  return outBuf;
}

async function main() {
  const imagePath = path.join(ROOT, 'assets', 'employee-photos', 'mark_ong.jpg');
  if (!fs.existsSync(imagePath)) throw new Error('Missing test photo: ' + imagePath);
  const raw = fs.readFileSync(imagePath);

  await runCase('Buffer', raw, false);
  await runCase('Uint8Array', raw, true);

  // Non-square: must not be forced into 72×72 (that warps).
  const widePath = path.join(ROOT, '.tmp-pto-wide-photo.jpg');
  makeWideTestJpeg(imagePath, widePath, 300, 150);
  const wideRaw = fs.readFileSync(widePath);
  const wideDims = readJpegDimensions(wideRaw);
  if (!wideDims || wideDims.width !== 300 || wideDims.height !== 150) {
    throw new Error(
      'wide test jpeg dims unexpected: ' + JSON.stringify(wideDims)
    );
  }
  const wideFit = ptoPhotoFitSize(wideDims.width, wideDims.height, PTO_PHOTO_PX, PTO_PHOTO_PX);
  if (wideFit.width !== 72 || wideFit.height !== 36) {
    throw new Error('contain-fit expected 72x36, got ' + wideFit.width + 'x' + wideFit.height);
  }
  // Old bug: square ext would yield cx===cy; assert we do not do that.
  await runCase('Wide contain-fit', wideRaw, true, wideFit);

  const outPath = path.join(ROOT, '.tmp-pto-photos-test.xlsx');
  const out = await runCase('Final write', raw, true);
  fs.writeFileSync(outPath, out);
  console.log('OK: wrote', outPath);
}

main().catch(function (err) {
  console.error('FAIL:', err);
  process.exit(1);
});
