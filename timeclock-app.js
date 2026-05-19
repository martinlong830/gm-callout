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
  var enterBlockEls = [];

  function sb() {
    return window.gmSupabase;
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
    introEl.textContent =
      punchMode === 'out'
        ? 'Enter PIN, then confirm clock out.'
        : 'Enter PIN, then confirm clock in.';
  }

  function syncModeButtons() {
    if (modeInBtn) {
      modeInBtn.classList.toggle('timeclock-mode-btn--active', punchMode === 'in');
    }
    if (modeOutBtn) {
      modeOutBtn.classList.toggle('timeclock-mode-btn--active', punchMode === 'out');
    }
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
  }

  function setPunchMode(mode) {
    if (busy || phase === 'confirm') return;
    punchMode = mode === 'out' ? 'out' : 'in';
    syncModeButtons();
    syncIntro();
    updateConfirmButton();
  }

  function updateConfirmButton() {
    if (!confirmBtn) return;
    confirmBtn.textContent = punchMode === 'out' ? 'Clock out' : 'Clock in';
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
    busy = true;
    setStatus('Checking PIN…', null);
    try {
      var res = await client.rpc('timeclock_lookup_pin', { pin_input: pinBuffer });
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
      setEnterUiVisible(false);
      var name = String(data.display_name || 'Employee').trim();
      if (confirmNameEl) confirmNameEl.textContent = name;
      if (confirmHintEl) {
        if (punchMode === 'in' && data.is_clocked_in) {
          confirmHintEl.textContent = 'Already clocked in. Switch to Clock out if leaving.';
        } else if (punchMode === 'out' && !data.is_clocked_in) {
          confirmHintEl.textContent = 'Not clocked in. Switch to Clock in if starting a shift.';
        } else {
          confirmHintEl.textContent =
            punchMode === 'out' ? 'Tap Clock out to record your punch.' : 'Tap Clock in to record your punch.';
        }
      }
      updateConfirmButton();
      setStatus('', null);
    } catch (ex) {
      setStatus((ex && ex.message) || 'Network error.', 'err');
      clearPinSoon(4000);
    } finally {
      busy = false;
    }
  }

  async function confirmPunch() {
    if (!pendingLookup || busy) return;
    var client = sb();
    if (!client) {
      setStatus('Supabase is not configured.', 'err');
      return;
    }
    busy = true;
    if (confirmBtn) confirmBtn.disabled = true;
    setStatus('Saving…', null);
    try {
      var res = await client.rpc('timeclock_punch_with_action', {
        pin_input: pinBuffer,
        punch_action: punchMode,
      });
      if (
        res.error &&
        /timeclock_punch_with_action|schema cache|function/i.test(res.error.message || '')
      ) {
        res = await client.rpc('timeclock_punch', { pin_input: pinBuffer });
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
        } else if (data && data.error === 'unknown_pin') {
          errMsg = 'PIN not recognized.';
        } else if (data && data.error === 'invalid_pin') {
          errMsg = 'Enter a 4-digit PIN.';
        }
        setStatus(errMsg, 'err');
        return;
      }
      var name = String(data.display_name || 'Employee').trim();
      var verb = data.action === 'out' ? 'Clocked out' : 'Clocked in';
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
      busy = false;
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
        appendDigit(btn.getAttribute('data-tc-digit'));
        return;
      }
      if (e.target.closest('#timeclockBackspace')) {
        backspacePin();
        return;
      }
      if (e.target.closest('#timeclockClear')) {
        clearPin();
      }
    });
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
        if (hiddenInputEl && phase === 'enter') hiddenInputEl.focus();
      });
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
    pinBuffer = '';
    busy = false;
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
    bindPad();
    bindModeToggle();
    bindConfirm();
    bindKeyboard();
    void loadDeviceLabel();
    if (hiddenInputEl) hiddenInputEl.focus();
  };
})();
