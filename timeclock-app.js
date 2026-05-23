/**
 * Shared time-clock kiosk (profiles.role = timeclock).
 * PIN entry via keypad or keyboard; explicit clock-in / clock-out confirmation.
 */
(function () {
  'use strict';

  var PIN_LEN = 4;
  var pinBuffer = '';
  var busy = false;
  var resetTimer = null;
  var punchMode = 'in';
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
  var confirmBtn = document.getElementById('timeclockConfirmBtn');
  var cancelBtn = document.getElementById('timeclockCancelBtn');
  var modeInBtn = document.getElementById('timeclockModeIn');
  var modeOutBtn = document.getElementById('timeclockModeOut');
  var modeBreakStartBtn = document.getElementById('timeclockModeBreakStart');
  var modeBreakEndBtn = document.getElementById('timeclockModeBreakEnd');
  var enterBlockEls = [];
  var uiBound = false;
  var focusBound = false;
  var busySince = 0;
  var watchdogTimer = null;
  var RPC_TIMEOUT_MS = 15000;
  var BUSY_STUCK_MS = 20000;

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
    if (confirmBtn) confirmBtn.disabled = false;
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

  function armHiddenInputForEntry() {
    if (!hiddenInputEl || phase !== 'enter') return;
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
    if (punchMode === 'out') {
      introEl.textContent = 'Enter PIN, then confirm clock out.';
    } else if (punchMode === 'break_start') {
      introEl.textContent = 'Enter PIN, then confirm break start.';
    } else if (punchMode === 'break_end') {
      introEl.textContent = 'Enter PIN, then confirm break end.';
    } else {
      introEl.textContent = 'Enter PIN, then confirm clock in.';
    }
  }

  function syncModeButtons() {
    var modes = ['in', 'out', 'break_start', 'break_end'];
    var btns = [modeInBtn, modeOutBtn, modeBreakStartBtn, modeBreakEndBtn];
    btns.forEach(function (btn, i) {
      if (btn) btn.classList.toggle('timeclock-mode-btn--active', punchMode === modes[i]);
    });
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
    phase = 'enter';
    renderPinDisplay();
    setStatus('', null);
    setEnterUiVisible(true);
    syncIntro();
    updateConfirmButton();
    if (confirmBtn) confirmBtn.disabled = false;
    setBusy(false);
    if (phase === 'enter') armHiddenInputForEntry();
  }

  function setPunchMode(mode) {
    if (busy || phase === 'confirm') return;
    if (mode === 'out') punchMode = 'out';
    else if (mode === 'break_start') punchMode = 'break_start';
    else if (mode === 'break_end') punchMode = 'break_end';
    else punchMode = 'in';
    syncModeButtons();
    syncIntro();
    updateConfirmButton();
  }

  function updateConfirmButton() {
    if (!confirmBtn) return;
    confirmBtn.textContent = MODE_LABELS[punchMode] || 'Confirm';
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
      if (confirmHintEl) {
        if (punchMode === 'in' && data.is_clocked_in) {
          confirmHintEl.textContent = 'Already clocked in. Switch to Clock out or break.';
        } else if (punchMode === 'out' && !data.is_clocked_in) {
          confirmHintEl.textContent = 'Not clocked in. Switch to Clock in if starting a shift.';
        } else if (punchMode === 'break_start' && !data.is_clocked_in) {
          confirmHintEl.textContent = 'Not clocked in. Clock in before starting a break.';
        } else if (punchMode === 'break_start' && data.on_break) {
          confirmHintEl.textContent = 'Already on break. Switch to End break when returning.';
        } else if (punchMode === 'break_end' && !data.is_clocked_in) {
          confirmHintEl.textContent = 'Not clocked in.';
        } else if (punchMode === 'break_end' && !data.on_break) {
          confirmHintEl.textContent = 'Not on break. Switch to Start break first.';
        } else {
          confirmHintEl.textContent =
            'Tap ' + (MODE_LABELS[punchMode] || 'Confirm') + ' to record your punch.';
        }
      }
      updateConfirmButton();
      setStatus('', null);
    } catch (ex) {
      setStatus((ex && ex.message) || 'Network error.', 'err');
      clearPinSoon(4000);
    } finally {
      setBusy(false);
    }
  }

  async function confirmPunch() {
    if (!pendingLookup || busy) return;
    var client = sb();
    if (!client) {
      setStatus('Supabase is not configured.', 'err');
      return;
    }
    setBusy(true);
    if (confirmBtn) confirmBtn.disabled = true;
    setStatus('Saving…', null);
    try {
      var res = await rpcWithTimeout(client, 'timeclock_punch_with_action', {
        pin_input: pinBuffer,
        punch_action: punchMode,
      });
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
      phase = 'enter';
      setEnterUiVisible(true);
      renderPinDisplay();
      clearPinSoon(3500);
    } catch (ex) {
      setStatus((ex && ex.message) || 'Network error.', 'err');
    } finally {
      setBusy(false);
      if (confirmBtn) confirmBtn.disabled = false;
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
      if (btn) {
        armHiddenInputForEntry();
        appendDigit(btn.getAttribute('data-tc-digit'));
      }
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

  function bindModeToggle() {
    if (modeInBtn) {
      modeInBtn.addEventListener('click', function () {
        setPunchMode('in');
      });
    }
    if (modeOutBtn) {
      modeOutBtn.addEventListener('click', function () {
        setPunchMode('out');
      });
    }
    if (modeBreakStartBtn) {
      modeBreakStartBtn.addEventListener('click', function () {
        setPunchMode('break_start');
      });
    }
    if (modeBreakEndBtn) {
      modeBreakEndBtn.addEventListener('click', function () {
        setPunchMode('break_end');
      });
    }
  }

  function bindConfirm() {
    if (confirmBtn) {
      confirmBtn.addEventListener('click', function () {
        void confirmPunch();
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
        if (e.key === 'Enter') {
          e.preventDefault();
          void confirmPunch();
        } else if (e.key === 'Escape') {
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
    if (!deviceLabelEl || !sb()) return;
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
        deviceLabelEl.textContent = prof.data.display_name;
      }
    } catch (_ex) {
      /* ignore */
    }
  }

  window.gmCalloutTimeclockBootstrap = function () {
    if (resetTimer) clearTimeout(resetTimer);
    pinBuffer = '';
    setBusy(false);
    punchMode = 'in';
    phase = 'enter';
    pendingLookup = null;
    enterBlockEls = [
      padEl,
      document.querySelector('.timeclock-pad-actions'),
      displayEl,
      introEl,
      document.querySelector('.timeclock-mode-toggle'),
      hiddenInputEl,
    ].filter(Boolean);
    renderPinDisplay();
    syncModeButtons();
    syncIntro();
    updateConfirmButton();
    setEnterUiVisible(true);
    setStatus('', null);
    if (!uiBound) {
      bindPad();
      bindPadActions();
      bindModeToggle();
      bindConfirm();
      bindKeyboard();
      startWatchdog();
      uiBound = true;
    }
    void loadDeviceLabel();
    if (hiddenInputEl) {
      hiddenInputEl.setAttribute('readonly', 'readonly');
      if (phase === 'enter') armHiddenInputForEntry();
    }
  };
})();
