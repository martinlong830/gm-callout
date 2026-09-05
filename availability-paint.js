/**
 * WhenIsGood-style availability paint grid helpers.
 * Paint dense 30-min cells (9:00–23:00), project onto draft schedule slotKeys.
 */
(function (global) {
  'use strict';

  var WEEKDAY_KEYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var PAINT_START_MIN = 9 * 60;
  var PAINT_END_MIN = 23 * 60;
  var PAINT_STEP_MIN = 30;

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function minsToHHMM(mins) {
    var m = ((mins % (24 * 60)) + 24 * 60) % (24 * 60);
    var h = Math.floor(m / 60);
    var mi = m % 60;
    return pad2(h) + ':' + pad2(mi);
  }

  function hhmmToMins(t) {
    var p = String(t || '').split(':');
    var h = parseInt(p[0], 10);
    var mi = parseInt(p[1], 10);
    if (isNaN(h)) h = 0;
    if (isNaN(mi)) mi = 0;
    return h * 60 + mi;
  }

  function paintCellKeys() {
    var keys = [];
    for (var m = PAINT_START_MIN; m < PAINT_END_MIN; m += PAINT_STEP_MIN) {
      keys.push(minsToHHMM(m));
    }
    return keys;
  }

  function emptyPaintGrid() {
    var out = {};
    var cells = paintCellKeys();
    WEEKDAY_KEYS.forEach(function (wk) {
      out[wk] = {};
      cells.forEach(function (ck) {
        out[wk][ck] = false;
      });
    });
    return out;
  }

  function parseSlotKey(slotKey) {
    var parts = String(slotKey || '').split('|');
    if (parts.length < 2) return null;
    return { start: parts[0], end: parts[1], slotKey: parts[0] + '|' + parts[1] };
  }

  function normalizeSlot(slot) {
    if (!slot) return null;
    if (slot.slotKey && slot.start && slot.end) {
      return { start: slot.start, end: slot.end, slotKey: slot.slotKey };
    }
    if (slot.slotKey) return parseSlotKey(slot.slotKey);
    if (slot.start && slot.end) {
      return { start: slot.start, end: slot.end, slotKey: slot.start + '|' + slot.end };
    }
    return null;
  }

  function slotIntervalMins(slot) {
    var ss = hhmmToMins(slot.start);
    var se = hhmmToMins(slot.end);
    if (se <= ss) se += 24 * 60;
    return { start: ss, end: se };
  }

  /** Paint cells that overlap the slot interval (within the 9–23 window). */
  function cellsOverlappingSlot(slot) {
    var s = normalizeSlot(slot);
    if (!s) return [];
    var iv = slotIntervalMins(s);
    var out = [];
    paintCellKeys().forEach(function (ck) {
      var cs = hhmmToMins(ck);
      var ce = cs + PAINT_STEP_MIN;
      if (cs < iv.end && ce > iv.start) out.push(ck);
    });
    return out;
  }

  function slotFullyPainted(paintDay, slot) {
    var cells = cellsOverlappingSlot(slot);
    if (!cells.length) return false;
    var day = paintDay || {};
    for (var i = 0; i < cells.length; i += 1) {
      if (!day[cells[i]]) return false;
    }
    return true;
  }

  function cellOverlapsSlot(cellStartHHMM, slot) {
    var s = normalizeSlot(slot);
    if (!s) return false;
    var iv = slotIntervalMins(s);
    var cs = hhmmToMins(cellStartHHMM);
    var ce = cs + PAINT_STEP_MIN;
    return cs < iv.end && ce > iv.start;
  }

  /**
   * Prefill paint cells from checked weeklyGrid slots (union of covered minutes).
   * @param {object} weeklyGrid
   * @param {Array<{start,end,slotKey}>} slots
   */
  function gridFromWeeklySlots(weeklyGrid, slots) {
    var paint = emptyPaintGrid();
    var list = (slots || []).map(normalizeSlot).filter(Boolean);
    WEEKDAY_KEYS.forEach(function (wk) {
      var day = (weeklyGrid && weeklyGrid[wk]) || {};
      list.forEach(function (slot) {
        if (!day[slot.slotKey]) return;
        paintCellKeys().forEach(function (ck) {
          if (cellOverlapsSlot(ck, slot)) paint[wk][ck] = true;
        });
      });
      /* Also honor any slotKeys present in the day map not in list. */
      Object.keys(day).forEach(function (sk) {
        if (!day[sk]) return;
        var slot = parseSlotKey(sk);
        if (!slot) return;
        paintCellKeys().forEach(function (ck) {
          if (cellOverlapsSlot(ck, slot)) paint[wk][ck] = true;
        });
      });
    });
    return paint;
  }

  /**
   * Project paint → weeklyGrid booleans (slot true iff every overlapping paint cell is on).
   */
  function projectPaintToWeeklyGrid(paintByDay, slots, baseGrid) {
    var out = {};
    WEEKDAY_KEYS.forEach(function (wk) {
      out[wk] = {};
    });
    var list = (slots || []).map(normalizeSlot).filter(Boolean);
    var seen = {};
    list.forEach(function (slot) {
      seen[slot.slotKey] = slot;
    });
    if (baseGrid && typeof baseGrid === 'object') {
      WEEKDAY_KEYS.forEach(function (wk) {
        Object.keys(baseGrid[wk] || {}).forEach(function (sk) {
          if (!seen[sk]) {
            var p = parseSlotKey(sk);
            if (p) {
              seen[sk] = p;
              list.push(p);
            }
          }
        });
      });
    }
    WEEKDAY_KEYS.forEach(function (wk) {
      var paintDay = (paintByDay && paintByDay[wk]) || {};
      list.forEach(function (slot) {
        out[wk][slot.slotKey] = slotFullyPainted(paintDay, slot);
      });
    });
    return out;
  }

  function formatPaintLabel(hhmm) {
    var mins = hhmmToMins(hhmm);
    var h = Math.floor(mins / 60) % 24;
    var m = mins % 60;
    var pm = h >= 12;
    var h12 = h % 12;
    if (h12 === 0) h12 = 12;
    if (m === 0) return String(h12) + (pm ? 'p' : 'a');
    return String(h12) + ':' + pad2(m) + (pm ? 'p' : 'a');
  }

  /** Compact range labels from a day's paint map, e.g. "10a–2p, 5p–9p". */
  function summarizeDayRanges(paintDay) {
    var day = paintDay || {};
    var cells = paintCellKeys();
    var ranges = [];
    var runStart = null;
    var runEnd = null;
    cells.forEach(function (ck) {
      if (day[ck]) {
        if (runStart == null) runStart = ck;
        runEnd = minsToHHMM(hhmmToMins(ck) + PAINT_STEP_MIN);
      } else if (runStart != null) {
        ranges.push(formatPaintLabel(runStart) + '–' + formatPaintLabel(runEnd));
        runStart = null;
        runEnd = null;
      }
    });
    if (runStart != null) {
      ranges.push(formatPaintLabel(runStart) + '–' + formatPaintLabel(runEnd));
    }
    return ranges.join(', ');
  }

  function paintAll(paintByDay, on) {
    var paint = paintByDay ? JSON.parse(JSON.stringify(paintByDay)) : emptyPaintGrid();
    var cells = paintCellKeys();
    WEEKDAY_KEYS.forEach(function (wk) {
      cells.forEach(function (ck) {
        paint[wk][ck] = !!on;
      });
    });
    return paint;
  }

  function clearPaintDay(paintByDay, wk) {
    var paint = paintByDay ? JSON.parse(JSON.stringify(paintByDay)) : emptyPaintGrid();
    if (!paint[wk]) paint[wk] = {};
    paintCellKeys().forEach(function (ck) {
      paint[wk][ck] = false;
    });
    return paint;
  }

  function collectPaintGridFromRoot(root) {
    var paint = emptyPaintGrid();
    if (!root) return paint;
    root.querySelectorAll('[data-avail-paint-cell]').forEach(function (el) {
      var wk = el.getAttribute('data-avail-wk');
      var ck = el.getAttribute('data-avail-cell');
      if (!wk || !ck || !paint[wk]) return;
      paint[wk][ck] = el.getAttribute('aria-pressed') === 'true' || el.classList.contains('is-on');
    });
    return paint;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function weekdayShortLabel(wk) {
    return String(wk || '').slice(0, 3);
  }

  /**
   * Render paint grid HTML for employee availability.
   * @param {object} paintByDay
   * @param {{ readOnly?: boolean }} [opts]
   */
  function renderAvailabilityPaintHtml(paintByDay, opts) {
    opts = opts || {};
    var ro = !!opts.readOnly;
    var paint = paintByDay || emptyPaintGrid();
    var cells = paintCellKeys();
    var parts = [];
    parts.push(
      '<div class="avail-paint' +
        (ro ? ' avail-paint--readonly' : '') +
        '" data-avail-paint-root="1">' +
        '<div class="avail-paint-scroll">' +
        '<table class="avail-paint-table">' +
        '<thead><tr><th class="avail-paint-corner" scope="col"><span class="visually-hidden">Time</span></th>'
    );
    WEEKDAY_KEYS.forEach(function (wk) {
      var summary = summarizeDayRanges(paint[wk]);
      parts.push(
        '<th scope="col" class="avail-paint-dayhead">' +
          '<span class="avail-paint-dayhead-dow">' +
          escapeHtml(weekdayShortLabel(wk)) +
          '</span>' +
          '<span class="avail-paint-dayhead-sum" title="' +
          escapeHtml(summary || '—') +
          '">' +
          escapeHtml(summary || '—') +
          '</span>' +
          (ro
            ? ''
            : '<button type="button" class="avail-paint-clear-day" data-avail-clear-day="' +
              escapeHtml(wk) +
              '" title="Clear ' +
              escapeHtml(wk) +
              '">Clear</button>') +
          '</th>'
      );
    });
    parts.push('</tr></thead><tbody>');
    cells.forEach(function (ck) {
      parts.push(
        '<tr><th scope="row" class="avail-paint-time">' + escapeHtml(formatPaintLabel(ck)) + '</th>'
      );
      WEEKDAY_KEYS.forEach(function (wk) {
        var on = !!(paint[wk] && paint[wk][ck]);
        if (ro) {
          parts.push(
            '<td class="avail-paint-cell' +
              (on ? ' is-on' : '') +
              '" data-avail-paint-cell data-avail-wk="' +
              escapeHtml(wk) +
              '" data-avail-cell="' +
              escapeHtml(ck) +
              '" aria-pressed="' +
              (on ? 'true' : 'false') +
              '"></td>'
          );
        } else {
          parts.push(
            '<td class="avail-paint-cell' +
              (on ? ' is-on' : '') +
              '" data-avail-paint-cell data-avail-wk="' +
              escapeHtml(wk) +
              '" data-avail-cell="' +
              escapeHtml(ck) +
              '" role="button" tabindex="0" aria-pressed="' +
              (on ? 'true' : 'false') +
              '" aria-label="' +
              escapeHtml(wk + ' ' + formatPaintLabel(ck)) +
              '"></td>'
          );
        }
      });
      parts.push('</tr>');
    });
    parts.push('</tbody></table></div></div>');
    return parts.join('');
  }

  function setPaintCellEl(el, on) {
    if (!el) return;
    el.classList.toggle('is-on', !!on);
    el.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function refreshDaySummaries(root) {
    if (!root) return;
    var paint = collectPaintGridFromRoot(root);
    WEEKDAY_KEYS.forEach(function (wk) {
      var sumEl = root.querySelector(
        '.avail-paint-dayhead .avail-paint-dayhead-sum'
      );
      /* Find summary under the matching clear button's parent th */
      var th = root.querySelector('[data-avail-clear-day="' + wk + '"]');
      th = th ? th.closest('th') : null;
      if (!th) {
        var heads = root.querySelectorAll('.avail-paint-dayhead');
        var idx = WEEKDAY_KEYS.indexOf(wk);
        th = heads[idx] || null;
      }
      if (!th) return;
      var label = th.querySelector('.avail-paint-dayhead-sum');
      if (!label) return;
      var text = summarizeDayRanges(paint[wk]) || '—';
      label.textContent = text;
      label.setAttribute('title', text);
    });
  }

  /**
   * Bind drag-to-paint on a paint grid root. onChange(paintByDay) after each stroke.
   */
  function bindAvailabilityPaintGrid(root, onChange) {
    if (!root || root.getAttribute('data-avail-paint-bound') === '1') return;
    if (root.classList.contains('avail-paint--readonly')) return;
    root.setAttribute('data-avail-paint-bound', '1');

    var painting = false;
    var paintValue = true;

    function cellFromEvent(ev) {
      var t = ev.target;
      if (!t || !t.closest) return null;
      return t.closest('[data-avail-paint-cell]');
    }

    function applyCell(el) {
      if (!el) return;
      setPaintCellEl(el, paintValue);
    }

    function finish() {
      if (!painting) return;
      painting = false;
      refreshDaySummaries(root);
      if (typeof onChange === 'function') onChange(collectPaintGridFromRoot(root));
    }

    root.addEventListener('mousedown', function (ev) {
      var el = cellFromEvent(ev);
      if (!el) return;
      ev.preventDefault();
      painting = true;
      var wasOn = el.classList.contains('is-on');
      paintValue = !wasOn;
      applyCell(el);
    });

    root.addEventListener('mouseover', function (ev) {
      if (!painting) return;
      var el = cellFromEvent(ev);
      if (el) applyCell(el);
    });

    document.addEventListener('mouseup', finish);

    root.addEventListener(
      'touchstart',
      function (ev) {
        var touch = ev.changedTouches && ev.changedTouches[0];
        if (!touch) return;
        var el = document.elementFromPoint(touch.clientX, touch.clientY);
        el = el && el.closest ? el.closest('[data-avail-paint-cell]') : null;
        if (!el || !root.contains(el)) return;
        ev.preventDefault();
        painting = true;
        paintValue = !el.classList.contains('is-on');
        applyCell(el);
      },
      { passive: false }
    );

    root.addEventListener(
      'touchmove',
      function (ev) {
        if (!painting) return;
        var touch = ev.changedTouches && ev.changedTouches[0];
        if (!touch) return;
        ev.preventDefault();
        var el = document.elementFromPoint(touch.clientX, touch.clientY);
        el = el && el.closest ? el.closest('[data-avail-paint-cell]') : null;
        if (el && root.contains(el)) applyCell(el);
      },
      { passive: false }
    );

    root.addEventListener('touchend', finish);
    root.addEventListener('touchcancel', finish);

    root.addEventListener('click', function (ev) {
      var clearBtn = ev.target && ev.target.closest && ev.target.closest('[data-avail-clear-day]');
      if (!clearBtn) return;
      ev.preventDefault();
      var wk = clearBtn.getAttribute('data-avail-clear-day');
      if (!wk) return;
      root.querySelectorAll('[data-avail-paint-cell][data-avail-wk="' + wk + '"]').forEach(function (el) {
        setPaintCellEl(el, false);
      });
      refreshDaySummaries(root);
      if (typeof onChange === 'function') onChange(collectPaintGridFromRoot(root));
    });

    root.addEventListener('keydown', function (ev) {
      if (ev.key !== ' ' && ev.key !== 'Enter') return;
      var el = cellFromEvent(ev);
      if (!el) return;
      ev.preventDefault();
      setPaintCellEl(el, !el.classList.contains('is-on'));
      refreshDaySummaries(root);
      if (typeof onChange === 'function') onChange(collectPaintGridFromRoot(root));
    });
  }

  global.gmAvailabilityPaint = {
    WEEKDAY_KEYS: WEEKDAY_KEYS,
    PAINT_START_MIN: PAINT_START_MIN,
    PAINT_END_MIN: PAINT_END_MIN,
    PAINT_STEP_MIN: PAINT_STEP_MIN,
    paintCellKeys: paintCellKeys,
    emptyPaintGrid: emptyPaintGrid,
    gridFromWeeklySlots: gridFromWeeklySlots,
    projectPaintToWeeklyGrid: projectPaintToWeeklyGrid,
    summarizeDayRanges: summarizeDayRanges,
    paintAll: paintAll,
    clearPaintDay: clearPaintDay,
    collectPaintGridFromRoot: collectPaintGridFromRoot,
    renderAvailabilityPaintHtml: renderAvailabilityPaintHtml,
    bindAvailabilityPaintGrid: bindAvailabilityPaintGrid,
    cellsOverlappingSlot: cellsOverlappingSlot,
    formatPaintLabel: formatPaintLabel,
  };
})(typeof window !== 'undefined' ? window : global);
