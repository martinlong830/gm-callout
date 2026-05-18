/**
 * Manager Timecards: roster → employee shifts → shift detail / edits.
 * Initialized from app.js via gmCalloutTimecards.init(deps).
 */
(function (global) {
  'use strict';

  var deps = null;
  var weekEntries = [];
  var timecardState = { employeeId: null, shiftId: null, shiftRow: null, entryId: null };
  var rosterCache = null;
  var rosterSort = { col: 'name', dir: 'asc' };

  var ROSTER_SORT_COLS = [
    'name',
    'role',
    'scheduled',
    'regular',
    'overtime',
    'total',
    'status',
  ];

  function d() {
    if (!deps) {
      throw new Error('gmCalloutTimecards.init was not called');
    }
    return deps;
  }

  function payWeekBounds() {
    var b = d().getPayWeekBounds();
    return { start: b.start, end: b.end };
  }

  function weekBoundsKey(b) {
    return b.start.toISOString().slice(0, 10);
  }

  function isoFromDate(dt) {
    return (
      dt.getFullYear() +
      '-' +
      String(dt.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(dt.getDate()).padStart(2, '0')
    );
  }

  function parseScheduledHoursDecimal(shift) {
    if (shift.redPokeHours != null && shift.redPokeHours !== '') {
      return parseFloat(shift.redPokeHours) || 0;
    }
    return parseFloat(d().redPokeShiftHoursDecimal(shift.start, shift.end)) || 0;
  }

  function parseBreakMinutesFromAnnotation(text) {
    var s = String(text || '').toLowerCase();
    var m = s.match(/(\d+)\s*(?:min|minute)/);
    if (m) return parseInt(m[1], 10) || 0;
    if (s.indexOf('break') !== -1 && s.indexOf('no') === -1) return 30;
    return 0;
  }

  function recordedPaidMinutes(entry) {
    if (!entry) return 0;
    var gross = d().punchShiftRoundedMinutes(entry.clock_in_at, entry.clock_out_at);
    var br = entry.break_minutes != null ? Number(entry.break_minutes) : 0;
    return Math.max(0, gross - (Number.isNaN(br) ? 0 : br));
  }

  function scheduledPaidMinutes(shift) {
    var hrs = parseScheduledHoursDecimal(shift);
    var br = parseBreakMinutesFromAnnotation(shift.redPokeBreak);
    return Math.max(0, Math.round(hrs * 60) - br);
  }

  var OT_WEEKLY_MINUTES = 40 * 60;
  var OT_RATE_MULTIPLIER = 1.5;

  function decimalHoursFromMinutes(mins) {
    var h = mins / 60;
    if (Math.abs(h - Math.round(h * 10) / 10) < 0.01) {
      return (Math.round(h * 10) / 10).toFixed(1);
    }
    return (Math.round(h * 100) / 100).toFixed(2);
  }

  function employeeHourlyRate(emp) {
    if (!emp || emp.hourlyRate == null || Number.isNaN(Number(emp.hourlyRate))) return null;
    var r = Number(emp.hourlyRate);
    return r >= 0 ? r : null;
  }

  function formatPayAmount(amount) {
    if (amount == null || Number.isNaN(amount)) return '—';
    return '$' + amount.toFixed(2);
  }

  function splitRegularAndOvertimeMinutes(paidMins) {
    var total = Math.max(0, Math.round(paidMins));
    var regMins = Math.min(total, OT_WEEKLY_MINUTES);
    var otMins = Math.max(0, total - OT_WEEKLY_MINUTES);
    return { regMins: regMins, otMins: otMins, totalMins: regMins + otMins };
  }

  function weekPayBreakdown(emp, paidMins) {
    var split = splitRegularAndOvertimeMinutes(paidMins);
    var rate = employeeHourlyRate(emp);
    if (rate == null) {
      return {
        regMins: split.regMins,
        otMins: split.otMins,
        totalMins: split.totalMins,
        regPay: null,
        otPay: null,
        totalPay: null,
      };
    }
    var regPay = (split.regMins / 60) * rate;
    var otPay = (split.otMins / 60) * rate * OT_RATE_MULTIPLIER;
    return {
      regMins: split.regMins,
      otMins: split.otMins,
      totalMins: split.totalMins,
      regPay: regPay,
      otPay: otPay,
      totalPay: regPay + otPay,
    };
  }

  function statusSortRank(status) {
    if (status === 'OK') return 0;
    if (status === 'Open') return 1;
    if (status === 'Review') return 2;
    return 3;
  }

  function buildRosterRowData(emp) {
    var agg = aggregateEmployeeWeek(emp);
    var pay = weekPayBreakdown(emp, agg.paidMins);
    return {
      emp: emp,
      name: d().employeeDisplayName(emp),
      role: d().STAFF_TYPE_LABELS[emp.staffType] || emp.staffType || '',
      schedMins: agg.schedMins,
      regMins: pay.regMins,
      otMins: pay.otMins,
      totalMins: pay.totalMins,
      regPay: pay.regPay,
      otPay: pay.otPay,
      totalPay: pay.totalPay,
      status: agg.status,
      statusRank: statusSortRank(agg.status),
    };
  }

  function compareRosterRows(a, b, col, dir) {
    var mul = dir === 'desc' ? -1 : 1;
    var cmp = 0;
    if (col === 'name') cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    else if (col === 'role') cmp = a.role.localeCompare(b.role, undefined, { sensitivity: 'base' });
    else if (col === 'scheduled') cmp = a.schedMins - b.schedMins;
    else if (col === 'regular') cmp = a.regMins - b.regMins;
    else if (col === 'overtime') cmp = a.otMins - b.otMins;
    else if (col === 'total') cmp = a.totalMins - b.totalMins;
    else if (col === 'status') cmp = a.statusRank - b.statusRank || a.status.localeCompare(b.status);
    else cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    if (cmp === 0) cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    return cmp * mul;
  }

  function sortedRosterRows(rows) {
    return rows.slice().sort(function (a, b) {
      return compareRosterRows(a, b, rosterSort.col, rosterSort.dir);
    });
  }

  function sortIndicator(col) {
    if (rosterSort.col !== col) return '<span class="timecards-sort-ind timecards-sort-ind--idle" aria-hidden="true">↕</span>';
    return (
      '<span class="timecards-sort-ind" aria-hidden="true">' +
      (rosterSort.dir === 'asc' ? '↑' : '↓') +
      '</span>'
    );
  }

  function rosterSortHeader(col, label) {
    var active = rosterSort.col === col;
    return (
      '<th scope="col">' +
      '<button type="button" class="timecards-sort-btn' +
      (active ? ' timecards-sort-btn--active' : '') +
      '" data-roster-sort="' +
      d().escapeHtml(col) +
      '" aria-sort="' +
      (active ? (rosterSort.dir === 'asc' ? 'ascending' : 'descending') : 'none') +
      '">' +
      d().escapeHtml(label) +
      sortIndicator(col) +
      '</button></th>'
    );
  }

  function renderRosterRowHtml(row) {
    return (
      '<tr class="timecards-row-clickable" data-timecard-employee-id="' +
      d().escapeHtml(row.emp.id) +
      '">' +
      '<td class="timecards-name">' +
      d().escapeHtml(row.name) +
      '</td>' +
      '<td>' +
      d().escapeHtml(row.role) +
      '</td>' +
      '<td class="timecards-num">' +
      d().escapeHtml(decimalHoursFromMinutes(row.schedMins)) +
      'h</td>' +
      rosterHoursCell(row.regMins, row.regPay) +
      rosterHoursCell(row.otMins, row.otPay) +
      rosterHoursCell(row.totalMins, row.totalPay) +
      '<td><span class="timecards-status ' +
      statusClass(row.status) +
      '">' +
      d().escapeHtml(row.status) +
      '</span></td>' +
      '</tr>'
    );
  }

  function csvEscape(val) {
    var s = val == null ? '' : String(val);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function payCsv(val) {
    if (val == null || Number.isNaN(val)) return '';
    return val.toFixed(2);
  }

  function downloadRosterSpreadsheet() {
    if (!rosterCache || !rosterCache.rows.length) return;
    var rows = sortedRosterRows(rosterCache.rows);
    var header = [
      'Name',
      'Role',
      'Scheduled (hrs)',
      'Regular (hrs)',
      'Regular pay',
      'Overtime (hrs)',
      'Overtime pay',
      'Total (hrs)',
      'Total pay',
      'Status',
      'Hourly rate',
    ];
    var lines = [header.map(csvEscape).join(',')];
    rows.forEach(function (row) {
      var rate = employeeHourlyRate(row.emp);
      lines.push(
        [
          row.name,
          row.role,
          decimalHoursFromMinutes(row.schedMins),
          decimalHoursFromMinutes(row.regMins),
          payCsv(row.regPay),
          decimalHoursFromMinutes(row.otMins),
          payCsv(row.otPay),
          decimalHoursFromMinutes(row.totalMins),
          payCsv(row.totalPay),
          row.status,
          rate != null ? rate.toFixed(2) : '',
        ]
          .map(csvEscape)
          .join(',')
      );
    });
    var blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = rosterCache.fileBase + '.csv';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function wireRosterTable(wrap) {
    wrap.querySelectorAll('[data-timecard-employee-id]').forEach(function (tr) {
      tr.addEventListener('click', function () {
        openEmployee(tr.getAttribute('data-timecard-employee-id'));
      });
    });
    wrap.querySelectorAll('[data-roster-sort]').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var col = btn.getAttribute('data-roster-sort');
        if (!col || ROSTER_SORT_COLS.indexOf(col) === -1) return;
        if (rosterSort.col === col) {
          rosterSort.dir = rosterSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          rosterSort.col = col;
          rosterSort.dir = col === 'name' || col === 'role' || col === 'status' ? 'asc' : 'desc';
        }
        paintRosterTable(wrap);
      });
    });
    var dlBtn = wrap.querySelector('[data-timecards-download]');
    if (dlBtn) {
      dlBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        downloadRosterSpreadsheet();
      });
    }
  }

  function paintRosterTable(wrap) {
    if (!rosterCache) return;
    var sorted = sortedRosterRows(rosterCache.rows);
    var body = sorted.map(renderRosterRowHtml).join('');
    wrap.innerHTML =
      '<div class="timecards-roster-toolbar">' +
      '<p class="timecards-week-label"><strong>Pay week:</strong> ' +
      d().escapeHtml(rosterCache.weekLabel) +
      '</p>' +
      '<button type="button" class="btn btn-secondary timecards-download-btn" data-timecards-download>Download CSV</button>' +
      '</div>' +
      '<div class="timecards-table-wrap"><table class="timecards-table timecards-table--roster">' +
      '<thead><tr>' +
      rosterSortHeader('name', 'Name') +
      rosterSortHeader('role', 'Role') +
      rosterSortHeader('scheduled', 'Scheduled') +
      rosterSortHeader('regular', 'Regular') +
      rosterSortHeader('overtime', 'Overtime') +
      rosterSortHeader('total', 'Total') +
      rosterSortHeader('status', 'Status') +
      '</tr></thead><tbody>' +
      body +
      '</tbody></table></div>';
    wireRosterTable(wrap);
  }

  function rosterHoursCell(mins, pay) {
    var hrs = d().escapeHtml(decimalHoursFromMinutes(mins) + 'h');
    var payHtml =
      pay != null
        ? '<span class="timecards-pay">' + d().escapeHtml(formatPayAmount(pay)) + '</span>'
        : '<span class="timecards-pay timecards-pay--muted">—</span>';
    return (
      '<td class="timecards-hours-cell"><span class="timecards-hrs">' +
      hrs +
      '</span>' +
      payHtml +
      '</td>'
    );
  }

  function dateToDatetimeLocalValue(iso) {
    if (!iso) return '';
    var dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return '';
    var pad = function (n) {
      return String(n).padStart(2, '0');
    };
    return (
      dt.getFullYear() +
      '-' +
      pad(dt.getMonth() + 1) +
      '-' +
      pad(dt.getDate()) +
      'T' +
      pad(dt.getHours()) +
      ':' +
      pad(dt.getMinutes())
    );
  }

  function datetimeLocalToIso(val) {
    if (!val) return null;
    var dt = new Date(val);
    if (Number.isNaN(dt.getTime())) return null;
    return dt.toISOString();
  }

  function shiftStatusLabel(shift, entry) {
    if (!entry) return 'No punch';
    if (!entry.clock_out_at) return 'Open';
    var sched = scheduledPaidMinutes(shift);
    var rec = recordedPaidMinutes(entry);
    if (Math.abs(sched - rec) <= 15) return 'OK';
    return 'Review';
  }

  function statusClass(word) {
    if (word === 'OK') return 'timecards-status--ok';
    if (word === 'Open') return 'timecards-status--open';
    if (word === 'Review') return 'timecards-status--review';
    return 'timecards-status--missing';
  }

  function buildShiftsForEmployeeInWeek(emp) {
    var name = d().employeeDisplayName(emp);
    var bounds = payWeekBounds();
    var startIso = isoFromDate(bounds.start);
    var endIso = isoFromDate(bounds.end);
    var all = d().buildAllLocationScheduleSnapshot();
    var todayIso = isoFromDate(new Date());
    return all
      .filter(function (s) {
        if (!d().shiftRowIncludesWorker(s, name)) return false;
        var meta = d().WEEK_META.find(function (m) {
          return m.label === s.day;
        });
        if (!meta || !meta.iso) return false;
        if (meta.iso < startIso || meta.iso > endIso) return false;
        return true;
      })
      .map(function (s) {
        var meta = d().WEEK_META.find(function (m) {
          return m.label === s.day;
        });
        return {
          shift: s,
          iso: meta ? meta.iso : '',
          isToday: meta && meta.iso === todayIso,
          isUpcoming: meta && meta.iso > todayIso,
        };
      })
      .sort(function (a, b) {
        if (a.iso !== b.iso) return String(a.iso).localeCompare(String(b.iso));
        return String(a.shift.start).localeCompare(String(b.shift.start));
      });
  }

  function findEntryForShift(empId, shiftId, shiftIso) {
    var linked = weekEntries.filter(function (e) {
      return e.employee_id === empId && e.schedule_shift_id === shiftId;
    });
    if (linked.length) return linked[0];
    return (
      weekEntries.find(function (e) {
        if (e.employee_id !== empId || !e.clock_in_at) return false;
        try {
          var day = isoFromDate(new Date(e.clock_in_at));
          return day === shiftIso;
        } catch (_e) {
          return false;
        }
      }) || null
    );
  }

  async function loadWeekEntries() {
    if (!d().gmSupabaseReadyNow()) return { ok: false, reason: 'no_client' };
    var sb = global.gmSupabase;
    var sess = await sb.auth.getSession();
    if (!sess.data || !sess.data.session) return { ok: false, reason: 'no_session' };
    var bounds = payWeekBounds();
    var sel =
      'id, employee_id, clock_in_at, clock_out_at, break_minutes, schedule_shift_id, edit_history, updated_at';
    var res = await sb
      .from('time_clock_entries')
      .select(sel)
      .gte('clock_in_at', bounds.start.toISOString())
      .lte('clock_in_at', bounds.end.toISOString())
      .order('clock_in_at', { ascending: true });
    if (res.error && /break_minutes|schedule_shift_id|edit_history/i.test(res.error.message || '')) {
      res = await sb
        .from('time_clock_entries')
        .select('id, employee_id, clock_in_at, clock_out_at, updated_at')
        .gte('clock_in_at', bounds.start.toISOString())
        .lte('clock_in_at', bounds.end.toISOString())
        .order('clock_in_at', { ascending: true });
    }
    if (res.error) return { ok: false, reason: res.error.message };
    weekEntries = res.data || [];
    return { ok: true };
  }

  function aggregateEmployeeWeek(emp) {
    var shifts = buildShiftsForEmployeeInWeek(emp);
    var schedMins = 0;
    var recMins = 0;
    var needsReview = false;
    var open = false;
    shifts.forEach(function (row) {
      schedMins += scheduledPaidMinutes(row.shift);
      var entry = findEntryForShift(emp.id, row.shift.id, row.iso);
      if (entry) {
        recMins += recordedPaidMinutes(entry);
        var st = shiftStatusLabel(row.shift, entry);
        if (st === 'Review') needsReview = true;
        if (st === 'Open') open = true;
      } else if (row.iso <= isoFromDate(new Date())) {
        needsReview = true;
      }
    });
    var status = open ? 'Open' : needsReview ? 'Review' : 'OK';
    return {
      schedMins: schedMins,
      paidMins: recMins,
      status: status,
      shiftCount: shifts.length,
    };
  }

  function renderRoster() {
    var wrap = document.getElementById('timecardsRosterWrap');
    if (!wrap) return;
    if (!deps) {
      wrap.innerHTML =
        '<p class="calendar-hint">Timecards failed to start. Hard-refresh the page.</p>';
      return;
    }
    if (!d().gmSupabaseReadyNow()) {
      wrap.innerHTML =
        '<p class="calendar-hint">Timecards need Supabase on this server (SUPABASE_URL and SUPABASE_ANON_KEY). Sign in as Martin Long or Ongi Management after redeploy.</p>';
      return;
    }
    wrap.innerHTML = '<p class="calendar-hint">Loading timecards…</p>';
    loadWeekEntries().then(function (loadRes) {
      if (!loadRes.ok) {
        wrap.innerHTML =
          '<p class="calendar-hint">' + d().escapeHtml(loadRes.reason || 'Could not load.') + '</p>';
        return;
      }
      var bounds = payWeekBounds();
      var weekLabel =
        bounds.start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
        ' – ' +
        bounds.end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      var emps = d().employees.slice();
      if (!emps.length) {
        rosterCache = null;
        wrap.innerHTML = '<p class="calendar-hint">No employees on the roster.</p>';
        return;
      }
      rosterCache = {
        weekLabel: weekLabel,
        fileBase: 'timecards-' + isoFromDate(bounds.start) + '_' + isoFromDate(bounds.end),
        rows: emps.map(buildRosterRowData),
      };
      paintRosterTable(wrap);
    });
  }

  function openEmployee(empId) {
    var emp = d().employees.find(function (e) {
      return e.id === empId;
    });
    if (!emp) return;
    timecardState.employeeId = empId;
    timecardState.shiftId = null;
    timecardState.shiftRow = null;
    timecardState.entryId = null;
    d().setTimecardTitle(11, d().employeeDisplayName(emp));
    renderEmployeeShifts(emp);
    d().showScreen(11);
  }

  function renderEmployeeShifts(emp) {
    var tbody = document.getElementById('timecardsEmployeeBody');
    var weekLbl = document.getElementById('timecardsEmployeeWeekLabel');
    if (!tbody) return;
    var bounds = payWeekBounds();
    if (weekLbl) {
      weekLbl.textContent =
        d().employeeDisplayName(emp) +
        ' · Pay week ' +
        bounds.start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
        ' – ' +
        bounds.end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
    var rows = buildShiftsForEmployeeInWeek(emp);
    if (!rows.length) {
      tbody.innerHTML =
        '<tr><td colspan="5" class="timecards-empty">No scheduled shifts this pay week.</td></tr>';
      return;
    }
    tbody.innerHTML = rows
      .map(function (row) {
        var s = row.shift;
        var entry = findEntryForShift(emp.id, s.id, row.iso);
        var schedH = decimalHoursFromMinutes(scheduledPaidMinutes(s)) + 'h';
        var recH = entry
          ? decimalHoursFromMinutes(recordedPaidMinutes(entry)) + 'h'
          : '—';
        var st = shiftStatusLabel(s, entry);
        var when =
          (row.isToday ? 'Today · ' : row.isUpcoming ? 'Upcoming · ' : '') +
          s.day +
          ' · ' +
          (s.timeLabel || d().redPokeShiftTimeLabel(s.start, s.end));
        return (
          '<tr class="timecards-row-clickable" data-timecard-shift-id="' +
          d().escapeHtml(s.id) +
          '">' +
          '<td>' +
          d().escapeHtml(s.day.split(' ').slice(0, 2).join(' ')) +
          '</td>' +
          '<td>' +
          d().escapeHtml(when) +
          '</td>' +
          '<td class="timecards-num">' +
          d().escapeHtml(schedH) +
          '</td>' +
          '<td class="timecards-num">' +
          d().escapeHtml(recH) +
          '</td>' +
          '<td><span class="timecards-status ' +
          statusClass(st) +
          '">' +
          d().escapeHtml(st) +
          '</span></td>' +
          '</tr>'
        );
      })
      .join('');
    tbody.querySelectorAll('[data-timecard-shift-id]').forEach(function (tr) {
      tr.addEventListener('click', function () {
        var shiftId = tr.getAttribute('data-timecard-shift-id');
        var shiftRow = rows.find(function (r) {
          return r.shift.id === shiftId;
        });
        if (shiftRow) openShift(emp, shiftRow);
      });
    });
  }

  function openShift(emp, shiftRow) {
    timecardState.employeeId = emp.id;
    timecardState.shiftId = shiftRow.shift.id;
    timecardState.shiftRow = shiftRow;
    var entry = findEntryForShift(emp.id, shiftRow.shift.id, shiftRow.iso);
    timecardState.entryId = entry ? entry.id : null;
    var s = shiftRow.shift;
    d().setTimecardTitle(
      12,
      s.day + ' · ' + (s.timeLabel || d().redPokeShiftTimeLabel(s.start, s.end))
    );
    renderShiftDetail(emp, shiftRow, entry);
    d().showScreen(12);
  }

  function renderShiftDetail(emp, shiftRow, entry) {
    var el = document.getElementById('timecardsShiftDetail');
    if (!el) return;
    var s = shiftRow.shift;
    var schedHrs = parseScheduledHoursDecimal(s);
    var schedBreak = parseBreakMinutesFromAnnotation(s.redPokeBreak);
    var schedPaid = scheduledPaidMinutes(s);
    var inVal = entry && entry.clock_in_at ? dateToDatetimeLocalValue(entry.clock_in_at) : '';
    var outVal = entry && entry.clock_out_at ? dateToDatetimeLocalValue(entry.clock_out_at) : '';
    var breakVal =
      entry && entry.break_minutes != null ? String(entry.break_minutes) : String(schedBreak);
    var history = (entry && entry.edit_history) || [];
    if (!Array.isArray(history)) history = [];
    var histHtml = history.length
      ? history
          .slice()
          .reverse()
          .map(function (h) {
            var when = h.at
              ? new Date(h.at).toLocaleString(undefined, {
                  dateStyle: 'short',
                  timeStyle: 'short',
                })
              : '';
            var parts = [];
            if (h.changes && typeof h.changes === 'object') {
              Object.keys(h.changes).forEach(function (k) {
                var c = h.changes[k];
                parts.push(k + ': ' + (c.from || '—') + ' → ' + (c.to || '—'));
              });
            }
            return (
              '<li class="timecards-history-item"><span class="timecards-history-when">' +
              d().escapeHtml(when) +
              '</span> ' +
              d().escapeHtml(parts.join(' · ') || 'Updated') +
              '</li>'
            );
          })
          .join('')
      : '<li class="timecards-history-item timecards-empty">No edits yet.</li>';

    el.innerHTML =
      '<div class="timecards-detail-grid">' +
      '<section class="timecards-detail-card">' +
      '<h3 class="emp-form-subtitle">Scheduled</h3>' +
      '<dl class="timecards-dl">' +
      '<div><dt>Shift</dt><dd>' +
      d().escapeHtml(s.day + ' · ' + (s.timeLabel || '')) +
      '</dd></div>' +
      '<div><dt>Hours</dt><dd>' +
      d().escapeHtml(String(schedHrs) + 'h · paid ' + decimalHoursFromMinutes(schedPaid) + 'h') +
      '</dd></div>' +
      '<div><dt>Break (unpaid)</dt><dd>' +
      d().escapeHtml(schedBreak ? schedBreak + ' min' : 'None') +
      '</dd></div>' +
      '</dl></section>' +
      '<section class="timecards-detail-card">' +
      '<h3 class="emp-form-subtitle">Recorded</h3>' +
      '<form id="timecardsShiftForm" class="timecards-edit-form">' +
      '<label class="form-field form-field-block"><span class="form-label">Clock in</span>' +
      '<input type="datetime-local" id="tcClockIn" class="timecards-input" value="' +
      d().escapeHtml(inVal) +
      '" /></label>' +
      '<label class="form-field form-field-block"><span class="form-label">Clock out</span>' +
      '<input type="datetime-local" id="tcClockOut" class="timecards-input" value="' +
      d().escapeHtml(outVal) +
      '" /></label>' +
      '<label class="form-field form-field-block"><span class="form-label">Break (minutes, unpaid)</span>' +
      '<input type="number" id="tcBreakMin" class="timecards-input" min="0" step="5" value="' +
      d().escapeHtml(breakVal) +
      '" /></label>' +
      '<p class="calendar-hint" id="timecardsRecordedPreview"></p>' +
      '<button type="submit" class="btn btn-primary btn-block">Save timecard</button>' +
      '</form></section>' +
      '<section class="timecards-detail-card">' +
      '<h3 class="emp-form-subtitle">Edit history</h3>' +
      '<ul class="timecards-history-list">' +
      histHtml +
      '</ul></section></div>';

    updateRecordedPreview();
    var form = document.getElementById('timecardsShiftForm');
    if (form) {
      form.onsubmit = function (ev) {
        ev.preventDefault();
        saveShiftDetail(emp, shiftRow, entry);
      };
    }
    ['tcClockIn', 'tcClockOut', 'tcBreakMin'].forEach(function (id) {
      var inp = document.getElementById(id);
      if (inp) inp.addEventListener('input', updateRecordedPreview);
    });
  }

  function updateRecordedPreview() {
    var prev = document.getElementById('timecardsRecordedPreview');
    if (!prev) return;
    var inIso = datetimeLocalToIso(document.getElementById('tcClockIn').value);
    var outIso = datetimeLocalToIso(document.getElementById('tcClockOut').value);
    var br = parseInt(document.getElementById('tcBreakMin').value, 10) || 0;
    if (!inIso) {
      prev.textContent = 'Enter clock in to preview paid time.';
      return;
    }
    var fake = { clock_in_at: inIso, clock_out_at: outIso, break_minutes: br };
    var paid = recordedPaidMinutes(fake);
    prev.textContent =
      'Paid time (rounded, after break): ' +
      decimalHoursFromMinutes(paid) +
      'h' +
      (!outIso ? ' · shift still open' : '');
  }

  async function saveShiftDetail(emp, shiftRow, priorEntry) {
    if (!d().gmSupabaseReadyNow()) return;
    var sb = global.gmSupabase;
    var inIso = datetimeLocalToIso(document.getElementById('tcClockIn').value);
    var outIso = datetimeLocalToIso(document.getElementById('tcClockOut').value);
    var br = parseInt(document.getElementById('tcBreakMin').value, 10) || 0;
    if (!inIso) {
      alert('Clock in is required.');
      return;
    }
    var changes = {};
    var row = {
      employee_id: emp.id,
      clock_in_at: inIso,
      clock_out_at: outIso,
      break_minutes: br,
      schedule_shift_id: shiftRow.shift.id,
    };
    if (priorEntry) {
      row.id = priorEntry.id;
      if (priorEntry.clock_in_at !== inIso) {
        changes.clock_in_at = { from: priorEntry.clock_in_at, to: inIso };
      }
      if (priorEntry.clock_out_at !== outIso) {
        changes.clock_out_at = { from: priorEntry.clock_out_at, to: outIso };
      }
      if (Number(priorEntry.break_minutes) !== br) {
        changes.break_minutes = { from: priorEntry.break_minutes, to: br };
      }
      var hist = Array.isArray(priorEntry.edit_history) ? priorEntry.edit_history.slice() : [];
      if (Object.keys(changes).length) {
        hist.push({ at: new Date().toISOString(), by: 'manager', changes: changes });
      }
      row.edit_history = hist;
      var up = await sb.from('time_clock_entries').update(row).eq('id', priorEntry.id).select('*').maybeSingle();
      if (up.error) {
        alert(up.error.message || 'Save failed.');
        return;
      }
    } else {
      row.edit_history = [];
      var ins = await sb.from('time_clock_entries').insert(row).select('*').maybeSingle();
      if (ins.error) {
        alert(ins.error.message || 'Save failed.');
        return;
      }
      priorEntry = ins.data;
    }
    await loadWeekEntries();
    openShift(emp, shiftRow);
    renderEmployeeShifts(emp);
  }

  function handleBack(fromScreen) {
    if (fromScreen === 12) {
      var emp = d().employees.find(function (e) {
        return e.id === timecardState.employeeId;
      });
      if (emp) {
        renderEmployeeShifts(emp);
        d().setTimecardTitle(11, d().employeeDisplayName(emp));
        d().showScreen(11);
      } else {
        d().showScreen(10);
      }
      return true;
    }
    if (fromScreen === 11) {
      timecardState.employeeId = null;
      d().showScreen(10);
      renderRoster();
      return true;
    }
    return false;
  }

  function init(dependencies) {
    deps = dependencies;
  }

  global.gmCalloutTimecards = {
    init: init,
    renderRoster: renderRoster,
    handleBack: handleBack,
    reloadWeek: loadWeekEntries,
  };

  if (typeof global.__gmCalloutTimecardsInitPending === 'function') {
    global.__gmCalloutTimecardsInitPending();
    global.__gmCalloutTimecardsInitPending = null;
  }
})(window);
