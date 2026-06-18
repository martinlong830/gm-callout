/**
 * Verify PAYSLIP layout: up to 5 stubs per row, vertical column breaks at each
 * stub boundary (bold black separators), no horizontal row page breaks.
 * Exported xlsx sets autoPageBreaks=0 (Excel "Use custom page breaks" ON).
 * Run: node scripts/verify-payslip-pagination.mjs
 */
import { createRequire } from 'module';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx-js-style');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PAY_STUB_COLS = 14;
const PAY_STUB_PER_ROW_MAX = 5;
const PAY_STUB_COL_WIDTHS = [3.7, 13.7, 13.7, 15.7, 20.7, 20.7, 10.7, 10.7, 10.7, 10.7, 12.7, 12.7, 12.7, 3.7];
const PAY_STUB_BLOCK_ROWS = 21;
const PAY_STUB_PAIR_GAP_ROWS = 4;
const PAY_STUB_SHEET_TOP_ROW = 3;
const PAYSLIP_PRINT_SCALE = 50;
const PAY_STUB_TOTAL_COLS = PAY_STUB_PER_ROW_MAX * PAY_STUB_COLS;

function payStubStartCol(slotIndex) {
  return slotIndex * PAY_STUB_COLS;
}

function payslipPrintLastCol() {
  return PAY_STUB_TOTAL_COLS;
}

function payslipSheetColWidths(maxColIndex) {
  const cols = [];
  const printCols = payslipPrintLastCol();
  const need = maxColIndex == null ? printCols : Math.min(maxColIndex + 1, printCols);
  for (let i = 0; i < need; i += 1) {
    cols.push({ wch: PAY_STUB_COL_WIDTHS[i % PAY_STUB_COL_WIDTHS.length] });
  }
  return cols;
}

function payslipExcelColLetter(colNum) {
  let col = colNum;
  let s = '';
  while (col > 0) {
    const m = (col - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    col = Math.floor((col - 1) / 26);
  }
  return s;
}

function computePayslipPrintMeta(employeeCount) {
  let row = PAY_STUB_SHEET_TOP_ROW;
  let bottom = row;
  let printLastCol = 0;
  let maxStubsInRow = 0;

  for (let i = 0; i < employeeCount; i += PAY_STUB_PER_ROW_MAX) {
    if (i > 0) row = bottom + PAY_STUB_PAIR_GAP_ROWS;
    const stubsThisRow = Math.min(PAY_STUB_PER_ROW_MAX, employeeCount - i);
    maxStubsInRow = Math.max(maxStubsInRow, stubsThisRow);
    printLastCol = Math.max(printLastCol, stubsThisRow * PAY_STUB_COLS);
    const rowEnd = row + PAY_STUB_BLOCK_ROWS;
    bottom = rowEnd;
  }

  const pageBreakCols = [];
  for (let stubIdx = 1; stubIdx < maxStubsInRow; stubIdx += 1) {
    pageBreakCols.push(payStubStartCol(stubIdx));
  }

  return {
    pageBreakCols,
    printLastExcelRow: bottom,
    printLastCol,
  };
}

function patchPayslipPageSetUpPrAttrs(attrs) {
  let next = attrs || '';
  if (/autoPageBreaks="/i.test(next)) {
    next = next.replace(/autoPageBreaks="[^"]*"/i, 'autoPageBreaks="0"');
  } else {
    next += ' autoPageBreaks="0"';
  }
  if (/fitToPage="/i.test(next)) {
    next = next.replace(/fitToPage="[^"]*"/i, 'fitToPage="0"');
  } else {
    next += ' fitToPage="0"';
  }
  return next;
}

function patchPayslipPageSetupAttrs(attrs) {
  let next = attrs || '';
  next = next.replace(/\sfitToWidth="[^"]*"/g, '');
  next = next.replace(/\sfitToHeight="[^"]*"/g, '');
  if (/scale="/i.test(next)) {
    next = next.replace(/scale="[^"]*"/i, 'scale="' + PAYSLIP_PRINT_SCALE + '"');
  } else {
    next += ' scale="' + PAYSLIP_PRINT_SCALE + '"';
  }
  if (/orientation="/i.test(next)) {
    next = next.replace(/orientation="[^"]*"/i, 'orientation="portrait"');
  } else {
    next += ' orientation="portrait"';
  }
  if (!/horizontalCentered="/i.test(next)) {
    next += ' horizontalCentered="1"';
  }
  if (!/verticalCentered="/i.test(next)) {
    next += ' verticalCentered="1"';
  }
  return next;
}

function payslipPageMarginsXml() {
  return '<pageMargins left="0.2" right="0.2" top="0.2" bottom="0.2" header="0" footer="0"/>';
}

function payslipPageSetupXml() {
  return (
    '<pageSetup orientation="portrait" scale="' +
    PAYSLIP_PRINT_SCALE +
    '" horizontalCentered="1" verticalCentered="1"/>'
  );
}

function payslipColBreaksXml(pageBreakCols) {
  if (!pageBreakCols || !pageBreakCols.length) return '';
  const brks = pageBreakCols
    .map(function (colId) {
      return '<brk id="' + colId + '" max="16384" man="1"/>';
    })
    .join('');
  return (
    '<colBreaks count="' +
    pageBreakCols.length +
    '" manualBreakCount="' +
    pageBreakCols.length +
    '">' +
    brks +
    '</colBreaks>'
  );
}

function patchPayslipSheetPrintXml(xml, pageBreakCols) {
  if (!xml) return xml;
  let out = xml;
  out = out.replace(/<rowBreaks\b[^>]*\/>/g, '');
  out = out.replace(/<rowBreaks[\s\S]*?<\/rowBreaks>/g, '');
  out = out.replace(/<colBreaks\b[^>]*\/>/g, '');
  out = out.replace(/<colBreaks[\s\S]*?<\/colBreaks>/g, '');
  if (/<pageSetup[^>]*\/>/.test(out)) {
    out = out.replace(/<pageSetup([^>]*)\/>/, (_match, attrs) => {
      return '<pageSetup' + patchPayslipPageSetupAttrs(attrs) + '/>';
    });
  } else if (/<pageSetup[^>]*>/.test(out)) {
    out = out.replace(/<pageSetup([^>]*)>/, (_match, attrs) => {
      return '<pageSetup' + patchPayslipPageSetupAttrs(attrs) + '>';
    });
  }
  if (/<pageSetUpPr[^>]*\/>/.test(out)) {
    out = out.replace(/<pageSetUpPr([^>]*)\/>/, (_match, attrs) => {
      return '<pageSetUpPr' + patchPayslipPageSetUpPrAttrs(attrs) + '/>';
    });
  } else if (/<pageSetUpPr[^>]*>[\s\S]*?<\/pageSetUpPr>/.test(out)) {
    out = out.replace(/<pageSetUpPr([^>]*)>[\s\S]*?<\/pageSetUpPr>/, (_match, attrs) => {
      return '<pageSetUpPr' + patchPayslipPageSetUpPrAttrs(attrs) + '/>';
    });
  } else if (/<sheetPr\s*\/>/.test(out)) {
    out = out.replace(
      /<sheetPr\s*\/>/,
      '<sheetPr><pageSetUpPr fitToPage="0" autoPageBreaks="0"/></sheetPr>'
    );
  } else if (/<sheetPr[^>]*>/.test(out)) {
    out = out.replace(
      /<sheetPr([^>]*)>/,
      '<sheetPr$1><pageSetUpPr fitToPage="0" autoPageBreaks="0"/>'
    );
  } else if (!/<sheetPr/.test(out)) {
    out = out.replace(
      /<worksheet([^>]*)>/,
      '<worksheet$1><sheetPr><pageSetUpPr fitToPage="0" autoPageBreaks="0"/></sheetPr>'
    );
  }
  out = out.replace(/<pageMargins\b[^>]*\/>/g, '');
  out = out.replace(/<pageMargins\b[^>]*>[\s\S]*?<\/pageMargins>/g, '');
  let printTail = payslipPageMarginsXml();
  if (!/<pageSetup\b/.test(out)) {
    printTail += payslipPageSetupXml();
  }
  const colBreaksXml = payslipColBreaksXml(pageBreakCols);
  if (colBreaksXml) printTail += colBreaksXml;
  out = out.replace(/<\/worksheet>/, printTail + '</worksheet>');
  return out;
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

function assertPatchedPayslipXml(patchedXml, pageBreakCols) {
  assert(!patchedXml.includes('rowBreaks'), 'rowBreaks must not be present in worksheet XML');
  assert(patchedXml.includes('colBreaks'), 'expected colBreaks in worksheet XML');
  pageBreakCols.forEach(function (excelCol) {
    assert(patchedXml.includes('id="' + excelCol + '"'), 'missing col break at ' + excelCol);
  });
  assert(patchedXml.includes('scale="50"'), 'expected scale 50 in worksheet XML');
  assert(patchedXml.includes('orientation="portrait"'), 'expected portrait orientation');
  assert(patchedXml.includes('fitToPage="0"'), 'expected fitToPage=0 in worksheet XML');
  assert(patchedXml.includes('autoPageBreaks="0"'), 'expected custom page breaks (autoPageBreaks=0)');
  assert(patchedXml.includes('horizontalCentered="1"'), 'expected horizontalCentered in worksheet XML');
  assert(!patchedXml.includes('fitToWidth'), 'fitToWidth must not be present');
  assert(!patchedXml.includes('fitToHeight'), 'fitToHeight must not be present');
  assert(patchedXml.includes('left="0.2"'), 'expected 0.2in margins in worksheet XML');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertSameArray(got, expected, label) {
  const same =
    got.length === expected.length &&
    got.every(function (v, idx) {
      return v === expected[idx];
    });
  assert(same, label + ' expected ' + JSON.stringify(expected) + ' got ' + JSON.stringify(got));
}

function main() {
  assert(payslipSheetColWidths(null).length === 70, 'expected 70 column widths for full row');
  assert(payslipSheetColWidths(69).length === 70, 'column widths must cap at full row width');

  const cases = [
    { n: 1, colBreaks: [], printLastExcelRow: 24, printLastCol: 14 },
    { n: 3, colBreaks: [14, 28], printLastExcelRow: 24, printLastCol: 42 },
    { n: 4, colBreaks: [14, 28, 42], printLastExcelRow: 24, printLastCol: 56 },
    { n: 5, colBreaks: [14, 28, 42, 56], printLastExcelRow: 24, printLastCol: 70 },
    { n: 6, colBreaks: [14, 28, 42, 56], printLastExcelRow: 49, printLastCol: 70 },
    { n: 7, colBreaks: [14, 28, 42, 56], printLastExcelRow: 49, printLastCol: 70 },
    { n: 14, colBreaks: [14, 28, 42, 56], printLastExcelRow: 74, printLastCol: 70 },
  ];

  cases.forEach(function (c) {
    const got = computePayslipPrintMeta(c.n);
    assertSameArray(got.pageBreakCols, c.colBreaks, 'n=' + c.n + ' col breaks');
    assert(
      got.printLastExcelRow === c.printLastExcelRow,
      'n=' +
        c.n +
        ' expected printLastExcelRow ' +
        c.printLastExcelRow +
        ' got ' +
        got.printLastExcelRow
    );
    assert(
      got.printLastCol === c.printLastCol,
      'n=' + c.n + ' expected printLastCol ' + c.printLastCol + ' got ' + got.printLastCol
    );
  });

  console.log('layout math ok for', cases.length, 'cases');
  console.log('PAY_STUB_PER_ROW_MAX =', PAY_STUB_PER_ROW_MAX);
  const meta14 = computePayslipPrintMeta(14);
  console.log('14 employees -> col breaks at Excel cols', meta14.pageBreakCols);
  console.log('14 employees -> print area ends', payslipExcelColLetter(meta14.printLastCol) + meta14.printLastExcelRow);
}

async function smokeExcelPrintSettings() {
  const printMeta = computePayslipPrintMeta(7);
  const ws = { A1: { v: 'PAYSLIP smoke', t: 's' }, '!ref': 'A1' };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Payslip');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const excelWb = new ExcelJS.Workbook();
  await excelWb.xlsx.load(buf);
  const sheet = excelWb.getWorksheet('Payslip');

  sheet.pageSetup.printArea =
    'A1:' +
    payslipExcelColLetter(printMeta.printLastCol) +
    String(printMeta.printLastExcelRow);
  sheet.pageSetup.orientation = 'portrait';
  sheet.pageSetup.scale = PAYSLIP_PRINT_SCALE;
  sheet.pageSetup.fitToPage = false;
  delete sheet.pageSetup.fitToWidth;
  delete sheet.pageSetup.fitToHeight;
  sheet.pageSetup.useCustomPageBreaks = true;
  sheet.pageSetup.horizontalCentered = true;
  sheet.pageSetup.verticalCentered = true;
  sheet.pageSetup.colBreaks = printMeta.pageBreakCols.slice();
  sheet.pageSetup.margins = {
    left: 0.2,
    right: 0.2,
    top: 0.2,
    bottom: 0.2,
    header: 0,
    footer: 0,
  };

  let outBuf = await excelWb.xlsx.writeBuffer();
  const zip = await JSZip.loadAsync(outBuf);
  const sheetPath = 'xl/worksheets/sheet1.xml';
  const sheetXml = await zip.file(sheetPath).async('string');
  const patched = patchPayslipSheetPrintXml(sheetXml, printMeta.pageBreakCols);
  zip.file(sheetPath, patched);
  outBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  const outPath = path.join(__dirname, '..', '.tmp-payslip-pagination.xlsx');
  fs.writeFileSync(outPath, outBuf);
  const patchedXml = execSync('unzip -p ' + JSON.stringify(outPath) + ' xl/worksheets/sheet1.xml').toString();
  const workbookXml = execSync('unzip -p ' + JSON.stringify(outPath) + ' xl/workbook.xml').toString();
  assertPatchedPayslipXml(patchedXml, printMeta.pageBreakCols);
  assert(workbookXml.includes('Print_Area'), 'expected Print_Area defined name in workbook XML');
  assert(
    workbookXml.includes('$' + payslipExcelColLetter(printMeta.printLastCol) + printMeta.printLastExcelRow),
    'expected print area through ' +
      payslipExcelColLetter(printMeta.printLastCol) +
      printMeta.printLastExcelRow
  );
  fs.unlinkSync(outPath);
  console.log('ExcelJS print settings + vertical col breaks + scale 50 smoke ok');
}

/** SheetJS-only path (actual full-report export): no pageSetup until OOXML patch. */
async function smokeSheetJsOnlyPatch() {
  const printMeta = computePayslipPrintMeta(7);
  const wb = XLSX.utils.book_new();
  ['Labor Cost', 'CPA', 'Payroll', 'Payslip', 'Schedule', 'PTO'].forEach(function (name) {
    const ws = XLSX.utils.aoa_to_sheet([[name]]);
    XLSX.utils.book_append_sheet(wb, ws, name);
  });
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', bookSST: false });
  const zip = await JSZip.loadAsync(buf);
  const wbXml = await zip.file('xl/workbook.xml').async('string');
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const sheetPath = worksheetPathFromWorkbook(wbXml, relsXml, 'Payslip');
  assert(sheetPath, 'Payslip sheet path not found in multi-sheet workbook');
  const rawXml = await zip.file(sheetPath).async('string');
  assert(!rawXml.includes('pageSetup'), 'SheetJS must not emit pageSetup before patch');
  const patched = patchPayslipSheetPrintXml(rawXml, printMeta.pageBreakCols);
  assertPatchedPayslipXml(patched, printMeta.pageBreakCols);
  console.log('SheetJS-only payslip OOXML patch ok (path ' + sheetPath + ')');
}

/** Legacy ExcelJS export may leave fitToWidth + horizontal rowBreaks; patch must fix. */
async function smokeLegacyExcelJsRepair() {
  const printMeta = computePayslipPrintMeta(14);
  const legacyXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetPr><pageSetUpPr fitToPage="1" autoPageBreaks="0"/></sheetPr>' +
    '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>PAYSLIP</t></is></c></row></sheetData>' +
    '<pageSetup fitToWidth="1" fitToHeight="0"/>' +
    '<rowBreaks count="4" manualBreakCount="4">' +
    '<brk id="28" max="16838" man="1"/><brk id="53" max="16838" man="1"/>' +
    '<brk id="78" max="16838" man="1"/><brk id="103" max="16838" man="1"/></rowBreaks>' +
    '</worksheet>';
  const patched = patchPayslipSheetPrintXml(legacyXml, printMeta.pageBreakCols);
  assertPatchedPayslipXml(patched, printMeta.pageBreakCols);
  console.log('legacy ExcelJS payslip print XML repair ok');
}

async function smokeFormulaRoundtrip() {
  const ws = {};
  ws.K4 = { f: 'SUM($E$15,$E$16,$F$23)', t: 'n', z: '#,##0.00' };
  ws.C21 = { f: 'SUM($D$21,$B$23)', t: 'n' };
  ws.D15 = { v: 0, t: 'n' };
  ws.E15 = { v: 0, t: 'n' };
  ws.E16 = { v: 0, t: 'n' };
  ws.F23 = { v: 100, t: 'n' };
  ws.D21 = { v: 8, t: 'n' };
  ws.B23 = { v: 2, t: 'n' };
  ws['!ref'] = 'B4:K23';
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Payslip');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const excelWb = new ExcelJS.Workbook();
  await excelWb.xlsx.load(buf);
  const sheet = excelWb.getWorksheet('Payslip');
  assert(sheet.getCell('K4').formula === 'SUM($E$15,$E$16,$F$23)', 'formula lost on ExcelJS load');
  assert(sheet.getCell('C21').formula === 'SUM($D$21,$B$23)', 'worktot formula lost on ExcelJS load');
  const outBuf = await excelWb.xlsx.writeBuffer();
  const zip = await JSZip.loadAsync(outBuf);
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert(xml.includes('SUM($E$15,$E$16,$F$23)'), 'total paid formula missing from written OOXML');
  assert(xml.includes('SUM($D$21,$B$23)'), 'worktot formula missing from written OOXML');
  console.log('payslip formula roundtrip ok');
}

main();
await smokeSheetJsOnlyPatch();
await smokeLegacyExcelJsRepair();
await smokeExcelPrintSettings();
await smokeFormulaRoundtrip();
