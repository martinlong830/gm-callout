/**
 * Verify full-report export path: sanitized XLSX → ExcelJS photos → zip merge → payslip patch.
 * Run: node scripts/verify-full-report-export.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx-js-style');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function xlsxBytesFromOutput(buffer) {
  if (!buffer) return new Uint8Array(0);
  if (buffer instanceof Uint8Array) return buffer;
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  if (Array.isArray(buffer)) return new Uint8Array(buffer);
  if (buffer.buffer instanceof ArrayBuffer && typeof buffer.byteLength === 'number') {
    return new Uint8Array(buffer.buffer, buffer.byteOffset || 0, buffer.byteLength);
  }
  return new Uint8Array(buffer);
}

function worksheetPathFromWorkbook(wbXml, relsXml, sheetName) {
  if (!wbXml || !relsXml || !sheetName) return null;
  const sheetRe = new RegExp(
    '<sheet[^>]*name="' + String(sheetName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*\\/?>',
    'gi'
  );
  let sheetTag;
  while ((sheetTag = sheetRe.exec(wbXml))) {
    const tag = sheetTag[0];
    const ridMatch = tag.match(/\br:id="([^"]+)"/);
    if (!ridMatch) continue;
    const rid = ridMatch[1];
    const relRe = new RegExp(
      '<Relationship[^>]*Id="' + rid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*Target="([^"]+)"'
    );
    const relMatch = relsXml.match(relRe);
    if (!relMatch) continue;
    const target = relMatch[1];
    if (target.indexOf('xl/') === 0) return target;
    return 'xl/' + target.replace(/^\/?/, '');
  }
  return null;
}

function ptoSheetRelsPath(ptoPath) {
  return ptoPath
    .replace('xl/worksheets/', 'xl/worksheets/_rels/')
    .replace(/sheet(\d+)\.xml$/, 'sheet$1.xml.rels');
}

function ptoDrawingTagFromSheetXml(sheetXml) {
  if (!sheetXml) return null;
  const selfClose = sheetXml.match(/<drawing\b[^>]*\/>/);
  if (selfClose) return selfClose[0];
  const paired = sheetXml.match(/<drawing\b[^>]*>[\s\S]*?<\/drawing>/);
  return paired ? paired[0] : null;
}

function ptoSheetXmlHasBrokenStringRefs(ptoXml, zip) {
  if (!ptoXml || ptoXml.indexOf('t="s"') < 0) return false;
  if (ptoXml.indexOf('t="str"') >= 0) return false;
  return !zip.file('xl/sharedStrings.xml');
}

function mergeContentTypeOverrides(baseCtXml, photoCtXml) {
  if (!photoCtXml) return baseCtXml;
  if (!baseCtXml) return photoCtXml;
  const existing = {};
  const overrideRe = /<Override[^>]+PartName="([^"]+)"[^>]*\/>/g;
  let m;
  while ((m = overrideRe.exec(baseCtXml))) existing[m[1]] = true;
  let inserts = '';
  photoCtXml.replace(overrideRe, function (full, partName) {
    if (existing[partName]) return '';
    existing[partName] = true;
    inserts += full;
    return '';
  });
  if (!inserts) return baseCtXml;
  return baseCtXml.replace(/<\/Types>/, inserts + '</Types>');
}

/** Match timecards-manager.js: keep SheetJS PTO XML, splice drawing/media only. */
async function mergePtoPhotoZipIntoBase(baseBuffer, photoBuffer) {
  const baseZip = await JSZip.loadAsync(xlsxBytesFromOutput(baseBuffer));
  const photoZip = await JSZip.loadAsync(xlsxBytesFromOutput(photoBuffer));
  const wbXml = await baseZip.file('xl/workbook.xml').async('string');
  const relsXml = await baseZip.file('xl/_rels/workbook.xml.rels').async('string');
  const ptoPath = worksheetPathFromWorkbook(wbXml, relsXml, 'PTO');
  if (!ptoPath) return baseBuffer;
  const basePtoFile = baseZip.file(ptoPath);
  if (!basePtoFile) return baseBuffer;
  const photoPtoFile = photoZip.file(ptoPath);
  if (!photoPtoFile) return baseBuffer;

  let hasMedia = false;
  photoZip.forEach((assetPath) => {
    if (assetPath.indexOf('xl/media/') === 0) hasMedia = true;
  });
  if (!hasMedia) return baseBuffer;

  const assetPaths = [];
  photoZip.forEach((assetPath) => {
    if (assetPath.indexOf('xl/drawings/') === 0 || assetPath.indexOf('xl/media/') === 0) {
      assetPaths.push(assetPath);
    }
  });
  for (const assetPath of assetPaths) {
    const assetFile = photoZip.file(assetPath);
    if (assetFile) baseZip.file(assetPath, await assetFile.async('uint8array'));
  }

  const ptoRelsPath = ptoSheetRelsPath(ptoPath);
  const photoRelsFile = photoZip.file(ptoRelsPath);
  if (photoRelsFile) {
    baseZip.file(ptoRelsPath, await photoRelsFile.async('uint8array'));
  }

  const photoPtoXml = await photoPtoFile.async('string');
  const drawingTag = ptoDrawingTagFromSheetXml(photoPtoXml);
  let basePtoXml = await basePtoFile.async('string');
  if (drawingTag && basePtoXml.indexOf('<drawing') < 0) {
    basePtoXml = basePtoXml.replace(/<\/worksheet>/, drawingTag + '</worksheet>');
    baseZip.file(ptoPath, basePtoXml);
  } else if (!drawingTag) {
    baseZip.file(ptoRelsPath, null);
  }

  const baseCtFile = baseZip.file('[Content_Types].xml');
  const photoCtFile = photoZip.file('[Content_Types].xml');
  if (baseCtFile && photoCtFile) {
    baseZip.file(
      '[Content_Types].xml',
      mergeContentTypeOverrides(
        await baseCtFile.async('string'),
        await photoCtFile.async('string')
      )
    );
  }

  const merged = await baseZip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  const mergedZip = await JSZip.loadAsync(merged);
  const mergedPtoXml = await mergedZip.file(ptoPath).async('string');
  if (ptoSheetXmlHasBrokenStringRefs(mergedPtoXml, mergedZip)) {
    throw new Error('PTO merge produced shared-string refs without sharedStrings.xml');
  }
  return merged;
}

async function validateAllSheets(buf, label) {
  const zip = await JSZip.loadAsync(xlsxBytesFromOutput(buf));
  const paths = Object.keys(zip.files)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort();
  for (const p of paths) {
    const xml = await zip.file(p).async('string');
    const tmp = '/tmp/verify-' + p.replace(/\//g, '_');
    fs.writeFileSync(tmp, xml);
    execSync('xmllint --noout ' + tmp, { stdio: 'pipe' });
    if (!/^<\?xml/.test(xml) || !/<worksheet[\s\S]*<\/worksheet>\s*$/.test(xml)) {
      throw new Error(label + ' ' + p + ' failed structure check');
    }
  }
  console.log(label + ':', paths.length, 'worksheets valid');
}

function buildPtoLikeSheet() {
  const ws = {};
  const merges = [];
  const thin = {
    top: { style: 'thin' },
    bottom: { style: 'thin' },
    left: { style: 'thin' },
    right: { style: 'thin' },
  };
  const S = {
    font: { bold: true, sz: 11, name: 'Arial' },
    alignment: { vertical: 'center' },
    border: thin,
  };

  function xlSet(r, c, value) {
    ws[XLSX.utils.encode_cell({ r, c })] = { v: String(value), t: 's', s: S };
  }
  function xlMerge(r1, c1, r2, c2) {
    merges.push({ s: { r: r1, c: c1 }, e: { r: r2, c: c2 } });
  }

  xlSet(0, 0, 'EMPLOYEE TIME OFF TRACKER');
  xlMerge(0, 0, 0, 19);
  xlSet(1, 0, 'Pay week Jun 1 – Jun 7, 2026 · balances as of export');
  xlMerge(1, 0, 1, 19);
  xlSet(2, 0, 'MO');
  xlMerge(2, 0, 6, 1);
  xlSet(2, 2, 'MARK ONG');
  xlMerge(2, 2, 2, 5);
  xlSet(3, 2, 'SERVER');
  xlMerge(3, 2, 3, 5);
  ['VD', 'SD', 'VDH', 'SDH'].forEach((h, i) => xlSet(4, 2 + i, h));
  xlSet(5, 2, '10');
  xlSet(5, 3, '5');
  xlSet(2, 7, 'Vacation Leave');
  xlMerge(2, 7, 2, 8);
  xlSet(3, 7, 'USED');
  xlSet(3, 8, '1/10');
  xlSet(4, 9, '06/15/2026 · 8 HRS');
  xlSet(6, 9, 'REMAINING HOURS: 32');
  xlMerge(6, 9, 6, 12);
  xlSet(2, 13, 'SICK');
  xlSet(2, 14, 'Sick Leave');

  ws['!ref'] = 'A1:T20';
  ws['!merges'] = merges;
  return ws;
}

function buildSixSheetWb() {
  const wb = XLSX.utils.book_new();
  ['Labor Cost', 'CPA', 'Payroll', 'Payslip', 'Schedule'].forEach((name) => {
    const ws = XLSX.utils.aoa_to_sheet([[name, 100]]);
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
    XLSX.utils.book_append_sheet(wb, ws, name);
  });
  XLSX.utils.book_append_sheet(wb, buildPtoLikeSheet(), 'PTO');
  return wb;
}

async function assertPtoText(buf, label) {
  const zip = await JSZip.loadAsync(xlsxBytesFromOutput(buf));
  const wbXml = await zip.file('xl/workbook.xml').async('string');
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const ptoPath = worksheetPathFromWorkbook(wbXml, relsXml, 'PTO');
  const ptoXml = await zip.file(ptoPath).async('string');
  const required = [
    'EMPLOYEE TIME OFF TRACKER',
    'MARK ONG',
    'Vacation Leave',
    '06/15/2026 · 8 HRS',
    'REMAINING HOURS',
  ];
  for (const text of required) {
    if (ptoXml.indexOf(text) < 0) {
      throw new Error(label + ': PTO sheet missing text "' + text + '"');
    }
  }
  if (ptoSheetXmlHasBrokenStringRefs(ptoXml, zip)) {
    throw new Error(label + ': PTO sheet has broken shared-string refs');
  }
  console.log(label + ': PTO text OK (' + required.length + ' strings, inline or shared)');
}

async function main() {
  const wb = buildSixSheetWb();
  const sanitizedOut = xlsxBytesFromOutput(
    XLSX.write(wb, { bookType: 'xlsx', type: 'buffer', bookSST: false })
  );
  await validateAllSheets(sanitizedOut, 'sanitized');
  await assertPtoText(sanitizedOut, 'sanitized');

  const excelWb = new ExcelJS.Workbook();
  await excelWb.xlsx.load(sanitizedOut);
  const pto = excelWb.getWorksheet('PTO');
  const imagePath = path.join(ROOT, 'assets', 'employee-photos', 'mark_ong.jpg');
  if (fs.existsSync(imagePath)) {
    const imageId = excelWb.addImage({ buffer: fs.readFileSync(imagePath), extension: 'jpeg' });
    pto.addImage(imageId, { tl: { col: 0.2, row: 2.15 }, ext: { width: 72, height: 72 } });
  }
  const photoOut = await excelWb.xlsx.writeBuffer();
  const merged = await mergePtoPhotoZipIntoBase(sanitizedOut, photoOut);
  await validateAllSheets(merged, 'merged');
  await assertPtoText(merged, 'merged');

  const mergedZip = await JSZip.loadAsync(merged);
  const laborXml = await mergedZip.file('xl/worksheets/sheet1.xml').async('string');
  const sanitizedZip = await JSZip.loadAsync(sanitizedOut);
  const laborSanitized = await sanitizedZip.file('xl/worksheets/sheet1.xml').async('string');
  if (laborXml !== laborSanitized) {
    throw new Error('Labor Cost sheet XML changed after photo merge');
  }
  const mediaCount = Object.keys(mergedZip.files).filter((p) => p.indexOf('xl/media/') === 0).length;
  if (fs.existsSync(imagePath) && mediaCount < 1) {
    throw new Error('expected xl/media/ after merge');
  }

  const wbXml = await mergedZip.file('xl/workbook.xml').async('string');
  const relsXml = await mergedZip.file('xl/_rels/workbook.xml.rels').async('string');
  const ptoPath = worksheetPathFromWorkbook(wbXml, relsXml, 'PTO');
  const ptoXml = await mergedZip.file(ptoPath).async('string');
  if (ptoXml.indexOf('<drawing') < 0 && fs.existsSync(imagePath)) {
    throw new Error('expected drawing tag on PTO sheet after photo merge');
  }

  const outPath = path.join(ROOT, '.tmp-full-report-export-verify.xlsx');
  fs.writeFileSync(outPath, merged);
  console.log('OK: wrote', outPath, 'media files:', mediaCount);
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
