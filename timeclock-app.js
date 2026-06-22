/**
 * Shared time-clock kiosk (profiles.role = timeclock).
 * PIN-only entry; available actions depend on current punch state.
 */
(function () {
  'use strict';

  var PIN_LEN = 4;
  var pinBuffer = '';
  var busy = false;
  var resetTimer = null;
  var punchMode = null;
  var phase = 'enter';
  var pendingLookup = null;

  var padEl = document.getElementById('timeclockPinPad');
  var displayEl = document.getElementById('timeclockPinDisplay');
  var hiddenInputEl = document.getElementById('timeclockPinInput');
  var statusEl = document.getElementById('timeclockStatus');
  var recentEl = document.getElementById('timeclockRecentList');
  var deviceLabelEl = document.getElementById('timeclockDeviceLabel');
  var introEl = document.getElementById('timeclockIntro');
  var confirmPanel = document.getElementById('timeclockConfirm');
  var confirmNameEl = document.getElementById('timeclockConfirmName');
  var confirmHintEl = document.getElementById('timeclockConfirmHint');
  var actionBtnsEl = document.getElementById('timeclockActionBtns');
  var cancelBtn = document.getElementById('timeclockCancelBtn');
  var enterBlockEls = [];
  var uiBound = false;
  var focusBound = false;
  var busySince = 0;
  var watchdogTimer = null;
  var RPC_TIMEOUT_MS = 15000;
  var BUSY_STUCK_MS = 20000;
  var deviceRestaurantId = 'rp-9';
  var scheduleAssignments = null;
  var scheduleContextReady = null;

  var MODE_LABELS = {
    in: 'Clock in',
    out: 'Clock out',
    break_start: 'Start break',
    break_end: 'End break',
  };

  function sb() {
    return window.gmSupabase;
  }

  function setBusy(next) {
    busy = !!next;
    busySince = busy ? Date.now() : 0;
  }

  function unlockIfStuck(forceMsg) {
    if (!busy) return false;
    if (Date.now() - busySince < BUSY_STUCK_MS) return false;
    setBusy(false);
    if (actionBtnsEl) {
      actionBtnsEl.querySelectorAll('button').forEach(function (btn) {
        btn.disabled = false;
      });
    }
    resetToEnter();
    if (forceMsg) setStatus(forceMsg, 'err');
    return true;
  }

  function rpcWithTimeout(client, fn, args) {
    return Promise.race([
      client.rpc(fn, args),
      new Promise(function (_resolve, reject) {
        setTimeout(function () {
          reject(new Error('Request timed out. Tap Clear and try again.'));
        }, RPC_TIMEOUT_MS);
      }),
    ]);
  }

  function scheduleMatchApi() {
    return window.gmTimeclockScheduleMatch || null;
  }

  function punchIsoLocal() {
    var api = scheduleMatchApi();
    if (api && typeof api.isoFromDate === 'function') {
      return api.isoFromDate(new Date());
    }
    var d = new Date();
    var pad = function (n) {
      return String(n).padStart(2, '0');
    };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function inferDeviceRestaurantId(displayName) {
    var api = scheduleMatchApi();
    if (api && typeof api.restaurantFromDeviceLabel === 'function') {
      var fromLabel = api.restaurantFromDeviceLabel(displayName);
      if (fromLabel) return fromLabel;
    }
    return 'rp-9';
  }

  async function ensureScheduleContext() {
    if (scheduleContextReady) return scheduleContextReady;
    var client = sb();
    if (!client) {
      scheduleContextReady = Promise.resolve();
      return scheduleContextReady;
    }
    scheduleContextReady = (async function () {
      try {
        var teamRes = await client.from('team_state').select('schedule_assignments').eq('id', 'main').maybeSingle();
        if (!teamRes.error && teamRes.data && teamRes.data.schedule_assignments) {
          scheduleAssignments = teamRes.data.schedule_assignments;
        }
      } catch (_ex) {
        /* ignore — off-schedule punches still work without schedule data */
      }
    })();
    return scheduleContextReady;
  }

  function resolvePunchContext(employeeName, openEntry) {
    if (openEntry && (openEntry.open_schedule_shift_id || openEntry.open_clock_restaurant_id)) {
      return {
        scheduleShiftId: openEntry.open_schedule_shift_id || null,
        restaurantId: openEntry.open_clock_restaurant_id || deviceRestaurantId,
      };
    }
    var api = scheduleMatchApi();
    if (!api || typeof api.resolvePunchScheduleContext !== 'function') {
      return { scheduleShiftId: null, restaurantId: deviceRestaurantId };
    }
    return api.resolvePunchScheduleContext({
      assignments: scheduleAssignments || {},
      employeeName: employeeName,
      punchIso: punchIsoLocal(),
      deviceRestaurantId: deviceRestaurantId,
    });
  }

  /** Phones/tablets/iPads: use on-screen pad only — never focus the hidden input (opens OS keyboard). */
  function prefersOnScreenPadOnly() {
    if (typeof window.matchMedia === 'function') {
      if (window.matchMedia('(pointer: coarse)').matches) return true;
      if (window.matchMedia('(hover: none)').matches && navigator.maxTouchPoints > 0) return true;
    }
    return typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
  }

  function armHiddenInputForEntry() {
    if (!hiddenInputEl || phase !== 'enter') return;
    if (prefersOnScreenPadOnly()) return;
    hiddenInputEl.removeAttribute('readonly');
    try {
      hiddenInputEl.focus({ preventScroll: true });
    } catch (_e) {
      hiddenInputEl.focus();
    }
  }

  function disarmHiddenInput() {
    if (!hiddenInputEl) return;
    hiddenInputEl.setAttribute('readonly', 'readonly');
    hiddenInputEl.blur();
  }

  function startWatchdog() {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(function () {
      var app = document.getElementById('appTimeclock');
      if (!app || app.hidden) return;
      unlockIfStuck('Connection timed out. Tap Clear and try again.');
    }, 5000);
  }

  function setStatus(msg, kind) {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.hidden = !msg;
    statusEl.classList.remove('timeclock-status--ok', 'timeclock-status--err');
    if (kind === 'ok') statusEl.classList.add('timeclock-status--ok');
    if (kind === 'err') statusEl.classList.add('timeclock-status--err');
  }

  function renderPinDisplay() {
    if (!displayEl) return;
    var dots = '';
    for (var i = 0; i < PIN_LEN; i += 1) {
      dots += i < pinBuffer.length ? '●' : '○';
    }
    displayEl.textContent = dots;
    if (hiddenInputEl && hiddenInputEl.value !== pinBuffer) {
      hiddenInputEl.value = pinBuffer;
    }
  }

  function syncIntro() {
    if (!introEl) return;
    introEl.textContent = 'Enter your 4-digit PIN.';
  }

  function setEnterUiVisible(show) {
    enterBlockEls.forEach(function (el) {
      if (el) el.hidden = !show;
    });
    if (confirmPanel) confirmPanel.hidden = show;
  }

  function clearPinSoon(ms) {
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(function () {
      resetToEnter();
    }, ms || 2800);
  }

  function resetToEnter() {
    pinBuffer = '';
    pendingLookup = null;
    punchMode = null;
    phase = 'enter';
    renderPinDisplay();
    setStatus('', null);
    setEnterUiVisible(true);
    syncIntro();
    if (actionBtnsEl) actionBtnsEl.innerHTML = '';
    setBusy(false);
    if (phase === 'enter') armHiddenInputForEntry();
  }

  function availableActionsForLookup(data) {
    if (!data || !data.is_clocked_in) return ['in'];
    if (data.on_break) return ['out', 'break_end'];
    return ['out', 'break_start'];
  }

  function hintForActions(actions) {
    if (actions.length === 1 && actions[0] === 'in') {
      return 'Confirm clock in to start your shift.';
    }
    if (actions.indexOf('break_end') !== -1) {
      return 'Choose clock out or end break.';
    }
    return 'Choose clock out or start break.';
  }

  function renderConfirmActions(actions) {
    if (!actionBtnsEl) return;
    actionBtnsEl.innerHTML = actions
      .map(function (action) {
        var cls =
          action === 'out'
            ? 'btn btn-secondary btn-block timeclock-action-btn'
            : 'btn btn-primary btn-block timeclock-action-btn';
        return (
          '<button type="button" class="' +
          cls +
          '" data-tc-action="' +
          action +
          '">' +
          (MODE_LABELS[action] || action) +
          '</button>'
        );
      })
      .join('');
  }

  function appendDigit(d) {
    if (busy || phase === 'confirm' || pinBuffer.length >= PIN_LEN) return;
    pinBuffer += d;
    renderPinDisplay();
    setStatus('', null);
    if (pinBuffer.length === PIN_LEN) {
      void lookupPin();
    }
  }

  function backspacePin() {
    if (busy || phase === 'confirm') return;
    pinBuffer = pinBuffer.slice(0, -1);
    renderPinDisplay();
    setStatus('', null);
  }

  function clearPin() {
    if (busy) return;
    resetToEnter();
  }

  async function lookupPin() {
    var client = sb();
    if (!client) {
      setStatus('Supabase is not configured.', 'err');
      clearPinSoon(4000);
      return;
    }
    setBusy(true);
    setStatus('Checking PIN…', null);
    try {
      await ensureScheduleContext();
      var res = await rpcWithTimeout(client, 'timeclock_lookup_pin', { pin_input: pinBuffer });
      if (res.error) {
        setStatus(res.error.message || 'Could not verify PIN.', 'err');
        clearPinSoon(4000);
        return;
      }
      var data = res.data;
      if (!data || data.ok !== true) {
        var err =
          data && data.error === 'unknown_pin'
            ? 'PIN not recognized. Ask your manager.'
            : data && data.error === 'invalid_pin'
              ? 'Enter a 4-digit PIN.'
              : 'Could not verify PIN.';
        setStatus(err, 'err');
        clearPinSoon(4000);
        return;
      }
      pendingLookup = data;
      phase = 'confirm';
      disarmHiddenInput();
      setEnterUiVisible(false);
      var name = String(data.display_name || 'Employee').trim();
      if (confirmNameEl) confirmNameEl.textContent = name;
      var actions = availableActionsForLookup(data);
      renderConfirmActions(actions);
      if (confirmHintEl) confirmHintEl.textContent = hintForActions(actions);
      setStatus('', null);
    } catch (ex) {
      setStatus((ex && ex.message) || 'Network error.', 'err');
      clearPinSoon(4000);
    } finally {
      setBusy(false);
    }
  }

  async function confirmPunch(action) {
    if (!pendingLookup || busy || !action) return;
    punchMode = action;
    var client = sb();
    if (!client) {
      setStatus('Supabase is not configured.', 'err');
      return;
    }
    setBusy(true);
    if (actionBtnsEl) {
      actionBtnsEl.querySelectorAll('button').forEach(function (btn) {
        btn.disabled = true;
      });
    }
    setStatus('Saving…', null);
    try {
      await ensureScheduleContext();
      var punchCtx = resolvePunchContext(
        pendingLookup.display_name,
        pendingLookup.is_clocked_in ? pendingLookup : null
      );
      var rpcArgs = {
        pin_input: pinBuffer,
        punch_action: punchMode,
        p_restaurant_id: punchCtx.restaurantId,
      };
      if (punchMode === 'in') {
        rpcArgs.p_schedule_shift_id = punchCtx.scheduleShiftId;
      }
      var res = await rpcWithTimeout(client, 'timeclock_punch_with_action', rpcArgs);
      if (
        res.error &&
        /p_restaurant_id|p_schedule_shift_id|clock_restaurant|schema cache|Could not find the function/i.test(
          res.error.message || ''
        )
      ) {
        res = await rpcWithTimeout(client, 'timeclock_punch_with_action', {
          pin_input: pinBuffer,
          punch_action: punchMode,
        });
      }
      if (
        res.error &&
        /timeclock_punch_with_action|schema cache|function/i.test(res.error.message || '')
      ) {
        res = await rpcWithTimeout(client, 'timeclock_punch', { pin_input: pinBuffer });
      }
      if (res.error) {
        setStatus(res.error.message || 'Punch failed.', 'err');
        return;
      }
      var data = res.data;
      if (!data || data.ok !== true) {
        var errMsg = 'Could not record punch.';
        if (data && data.error === 'already_in') {
          errMsg = (data.display_name || 'Employee') + ' is already clocked in.';
        } else if (data && data.error === 'not_in') {
          errMsg = (data.display_name || 'Employee') + ' is not clocked in.';
        } else if (data && data.error === 'already_on_break') {
          errMsg = (data.display_name || 'Employee') + ' is already on break.';
        } else if (data && data.error === 'not_on_break') {
          errMsg = (data.display_name || 'Employee') + ' is not on break.';
        } else if (data && data.error === 'unknown_pin') {
          errMsg = 'PIN not recognized.';
        } else if (data && data.error === 'invalid_pin') {
          errMsg = 'Enter a 4-digit PIN.';
        }
        setStatus(errMsg, 'err');
        return;
      }
      var name = String(data.display_name || 'Employee').trim();
      var verb =
        data.action === 'out'
          ? 'Clocked out'
          : data.action === 'break_start'
            ? 'Break started'
            : data.action === 'break_end'
              ? 'Break ended'
              : 'Clocked in';
      setStatus(verb + ' — ' + name, 'ok');
      prependRecent(name, verb, data.at);
      pinBuffer = '';
      pendingLookup = null;
      punchMode = null;
      phase = 'enter';
      setEnterUiVisible(true);
      renderPinDisplay();
      clearPinSoon(3500);
    } catch (ex) {
      setStatus((ex && ex.message) || 'Network error.', 'err');
    } finally {
      setBusy(false);
      if (actionBtnsEl) {
        actionBtnsEl.querySelectorAll('button').forEach(function (btn) {
          btn.disabled = false;
        });
      }
    }
  }

  function prependRecent(name, verb, atIso) {
    if (!recentEl) return;
    var li = document.createElement('li');
    li.className = 'timeclock-recent-item';
    var when = '';
    try {
      when = new Date(atIso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch (_e) {
      when = '';
    }
    li.textContent = (when ? when + ' · ' : '') + verb + ' — ' + name;
    if (recentEl.firstChild) recentEl.insertBefore(li, recentEl.firstChild);
    else recentEl.appendChild(li);
    while (recentEl.children.length > 8) {
      recentEl.removeChild(recentEl.lastChild);
    }
  }

  function bindPad() {
    if (!padEl) return;
    padEl.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-tc-digit]');
      if (btn) appendDigit(btn.getAttribute('data-tc-digit'));
    });
  }

  function bindPadActions() {
    var clearBtn = document.getElementById('timeclockClear');
    var backspaceBtn = document.getElementById('timeclockBackspace');
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        clearPin();
      });
    }
    if (backspaceBtn) {
      backspaceBtn.addEventListener('click', function () {
        backspacePin();
      });
    }
  }

  function bindConfirm() {
    if (actionBtnsEl) {
      actionBtnsEl.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-tc-action]');
        if (!btn || btn.disabled) return;
        void confirmPunch(btn.getAttribute('data-tc-action'));
      });
    }
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        clearPin();
      });
    }
  }

  function bindKeyboard() {
    document.addEventListener('keydown', function (e) {
      var app = document.getElementById('appTimeclock');
      if (!app || app.hidden) return;
      if (unlockIfStuck()) return;
      if (busy) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (phase === 'confirm') {
        if (e.key === 'Escape') {
          e.preventDefault();
          clearPin();
        }
        return;
      }
      if (e.key >= '0' && e.key <= '9') {
        e.preventDefault();
        appendDigit(e.key);
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        backspacePin();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        clearPin();
      }
    });

    if (hiddenInputEl) {
      hiddenInputEl.setAttribute('readonly', 'readonly');
      hiddenInputEl.addEventListener('input', function () {
        if (busy || phase === 'confirm') return;
        var digits = String(hiddenInputEl.value || '').replace(/\D/g, '').slice(0, PIN_LEN);
        if (digits === pinBuffer) return;
        pinBuffer = digits;
        renderPinDisplay();
        setStatus('', null);
        if (pinBuffer.length === PIN_LEN) {
          void lookupPin();
        }
      });
    }

    if (displayEl) {
      displayEl.addEventListener('click', function () {
        if (phase === 'enter') armHiddenInputForEntry();
      });
    }

    if (!focusBound) {
      focusBound = true;
      document.addEventListener('visibilitychange', function () {
        var app = document.getElementById('appTimeclock');
        if (!app || app.hidden) return;
        if (document.visibilityState === 'visible') {
          unlockIfStuck('Screen was idle. Tap Clear if the keypad does not respond.');
          if (phase === 'enter') armHiddenInputForEntry();
        } else {
          disarmHiddenInput();
        }
      });
      window.addEventListener('pagehide', disarmHiddenInput);
    }
  }

  async function loadDeviceLabel() {
    if (!sb()) return;
    try {
      var sess = await sb().auth.getSession();
      var uid = sess.data && sess.data.session && sess.data.session.user && sess.data.session.user.id;
      if (!uid) return;
      var prof = await sb()
        .from('profiles')
        .select('display_name')
        .eq('id', uid)
        .maybeSingle();
      if (prof.data && prof.data.display_name) {
        deviceRestaurantId = inferDeviceRestaurantId(prof.data.display_name);
        if (deviceLabelEl) deviceLabelEl.textContent = prof.data.display_name;
      }
    } catch (_ex) {
      /* ignore */
    }
  }

  window.gmCalloutTimeclockBootstrap = function () {
    if (resetTimer) clearTimeout(resetTimer);
    pinBuffer = '';
    setBusy(false);
    punchMode = null;
    phase = 'enter';
    pendingLookup = null;
    enterBlockEls = [
      padEl,
      document.querySelector('.timeclock-pad-actions'),
      displayEl,
      introEl,
      hiddenInputEl,
    ].filter(Boolean);
    renderPinDisplay();
    syncIntro();
    setEnterUiVisible(true);
    setStatus('', null);
    if (!uiBound) {
      bindPad();
      bindPadActions();
      bindConfirm();
      bindKeyboard();
      startWatchdog();
      uiBound = true;
    }
    void loadDeviceLabel();
    void ensureScheduleContext();
    if (hiddenInputEl) {
      hiddenInputEl.setAttribute('readonly', 'readonly');
      if (phase === 'enter') armHiddenInputForEntry();
    }
  };
})();
