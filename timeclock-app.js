/**
 * Shared time-clock kiosk (profiles.role = timeclock).
 * Employees punch in/out with a 6-digit PIN via Supabase RPC timeclock_punch.
 */
(function () {
  'use strict';

  var PIN_LEN = 6;
  var pinBuffer = '';
  var busy = false;
  var resetTimer = null;

  var padEl = document.getElementById('timeclockPinPad');
  var displayEl = document.getElementById('timeclockPinDisplay');
  var statusEl = document.getElementById('timeclockStatus');
  var recentEl = document.getElementById('timeclockRecentList');
  var deviceLabelEl = document.getElementById('timeclockDeviceLabel');

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
  }

  function clearPinSoon(ms) {
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(function () {
      pinBuffer = '';
      renderPinDisplay();
      setStatus('', null);
    }, ms || 2800);
  }

  function appendDigit(d) {
    if (busy || pinBuffer.length >= PIN_LEN) return;
    pinBuffer += d;
    renderPinDisplay();
    setStatus('', null);
    if (pinBuffer.length === PIN_LEN) {
      void submitPin();
    }
  }

  function backspacePin() {
    if (busy) return;
    pinBuffer = pinBuffer.slice(0, -1);
    renderPinDisplay();
    setStatus('', null);
  }

  function clearPin() {
    if (busy) return;
    pinBuffer = '';
    renderPinDisplay();
    setStatus('', null);
  }

  async function submitPin() {
    var client = sb();
    if (!client) {
      setStatus('Supabase is not configured.', 'err');
      clearPinSoon(4000);
      return;
    }
    busy = true;
    setStatus('Checking PIN…', null);
    try {
      var res = await client.rpc('timeclock_punch', { pin_input: pinBuffer });
      if (res.error) {
        setStatus(res.error.message || 'Punch failed.', 'err');
        clearPinSoon(4000);
        return;
      }
      var data = res.data;
      if (!data || data.ok !== true) {
        var err =
          data && data.error === 'unknown_pin'
            ? 'PIN not recognized. Ask your manager.'
            : data && data.error === 'invalid_pin'
              ? 'Enter a 6-digit PIN.'
              : 'Could not record punch.';
        setStatus(err, 'err');
        clearPinSoon(4000);
        return;
      }
      var name = String(data.display_name || 'Employee').trim();
      var verb = data.action === 'out' ? 'Clocked out' : 'Clocked in';
      setStatus(verb + ' — ' + name, 'ok');
      prependRecent(name, verb, data.at);
      clearPinSoon(3500);
    } catch (ex) {
      setStatus((ex && ex.message) || 'Network error.', 'err');
      clearPinSoon(4000);
    } finally {
      busy = false;
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
    renderPinDisplay();
    setStatus('', null);
    bindPad();
    void loadDeviceLabel();
  };
})();
