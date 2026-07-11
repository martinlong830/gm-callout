/**
 * Timeclock role: login panels (name + password via portal-auth-client.js).
 */
(function () {
  'use strict';

  var SESSION_KEY = 'gm-callout-session';

  var landingPanel = document.getElementById('landingPanel');
  var accessCodePanel = document.getElementById('accessCodePanel');
  var createCompanyPanel = document.getElementById('createCompanyPanel');
  var companyPendingPanel = document.getElementById('companyPendingPanel');
  var setupAccessCodePanel = document.getElementById('setupAccessCodePanel');
  var loginPanel = document.getElementById('loginPanel');
  var registerPanel = document.getElementById('registerPanel');
  var managerRegisterPanel = document.getElementById('managerRegisterPanel');
  var timeclockLoginPanel = document.getElementById('timeclockLoginPanel');
  var timeclockRegisterPanel = document.getElementById('timeclockRegisterPanel');
  var loginScreenEl = document.getElementById('login-screen');

  function hideAllLoginPanels() {
    if (landingPanel) landingPanel.hidden = true;
    if (accessCodePanel) accessCodePanel.hidden = true;
    if (createCompanyPanel) createCompanyPanel.hidden = true;
    if (companyPendingPanel) companyPendingPanel.hidden = true;
    if (setupAccessCodePanel) setupAccessCodePanel.hidden = true;
    if (loginPanel) loginPanel.hidden = true;
    if (registerPanel) registerPanel.hidden = true;
    if (managerRegisterPanel) managerRegisterPanel.hidden = true;
    if (timeclockLoginPanel) timeclockLoginPanel.hidden = true;
    if (timeclockRegisterPanel) timeclockRegisterPanel.hidden = true;
  }

  function showLoginPanel() {
    hideAllLoginPanels();
    if (loginPanel) loginPanel.hidden = false;
    if (loginScreenEl) loginScreenEl.classList.remove('login-screen--register');
    if (typeof window.gmCalloutUpdateLoginBranding === 'function') {
      window.gmCalloutUpdateLoginBranding();
    }
  }

  function showTimeclockLoginPanel() {
    hideAllLoginPanels();
    if (timeclockLoginPanel) timeclockLoginPanel.hidden = false;
    syncTimeclockLocationUi();
    if (typeof window.gmCalloutUpdateLoginBranding === 'function') {
      window.gmCalloutUpdateLoginBranding();
    }
  }

  function scheduleMatchApi() {
    return window.gmTimeclockScheduleMatch || null;
  }

  function selectedTimeclockRestaurantId() {
    var activeBtn = document.querySelector('.timeclock-location-btn--active');
    var api = scheduleMatchApi();
    if (activeBtn && activeBtn.getAttribute('data-tc-location')) {
      return api && typeof api.normalizeRestaurantId === 'function'
        ? api.normalizeRestaurantId(activeBtn.getAttribute('data-tc-location'))
        : activeBtn.getAttribute('data-tc-location');
    }
    if (api && typeof api.resolveDeviceRestaurantId === 'function') {
      return api.resolveDeviceRestaurantId() || 'rp-9';
    }
    return 'rp-9';
  }

  function applyTimeclockLocationSelection(restaurantId, locked) {
    var api = scheduleMatchApi();
    var norm =
      api && typeof api.normalizeRestaurantId === 'function'
        ? api.normalizeRestaurantId(restaurantId)
        : restaurantId === 'rp-8'
          ? 'rp-8'
          : 'rp-9';
    document.querySelectorAll('.timeclock-location-toggle').forEach(function (toggle) {
      toggle.classList.toggle('timeclock-location-toggle--locked', !!locked);
      toggle.querySelectorAll('.timeclock-location-btn').forEach(function (btn) {
        var isActive = btn.getAttribute('data-tc-location') === norm;
        btn.classList.toggle('timeclock-location-btn--active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        btn.disabled = !!locked;
      });
    });
    if (api && typeof api.setStoredRestaurantId === 'function') {
      api.setStoredRestaurantId(norm);
    }
    syncTimeclockLocationCopy(norm);
  }

  function syncTimeclockLocationCopy(restaurantId) {
    var api = scheduleMatchApi();
    var id = restaurantId || selectedTimeclockRestaurantId();
    var label =
      api && typeof api.restaurantLabel === 'function' && id ? api.restaurantLabel(id) : '';
    var subtitleEl = document.getElementById('timeclockLoginSubtitle');
    if (subtitleEl) {
      subtitleEl.textContent = label ? 'Time clock — ' + label : 'Time clock device';
    }
    var regSubtitleEl = document.getElementById('timeclockRegisterSubtitle');
    if (regSubtitleEl) {
      regSubtitleEl.textContent = label
        ? 'Register time clock device (' + label + ')'
        : 'Register time clock device';
    }
  }

  function syncTimeclockLocationUi() {
    var api = scheduleMatchApi();
    var fromPath =
      api && typeof api.restaurantFromPagePath === 'function' ? api.restaurantFromPagePath() : null;
    var initial =
      fromPath ||
      (api && typeof api.resolveDeviceRestaurantId === 'function'
        ? api.resolveDeviceRestaurantId()
        : null) ||
      'rp-9';
    applyTimeclockLocationSelection(initial, !!fromPath);
  }

  function showTimeclockRegisterPanel() {
    hideAllLoginPanels();
    if (timeclockRegisterPanel) timeclockRegisterPanel.hidden = false;
    syncTimeclockLocationUi();
    if (typeof window.gmCalloutUpdateLoginBranding === 'function') {
      window.gmCalloutUpdateLoginBranding();
    }
  }

  function bindTimeclockLocationToggles() {
    document.querySelectorAll('.timeclock-location-toggle').forEach(function (toggle) {
      toggle.addEventListener('click', function (e) {
        var btn = e.target.closest('.timeclock-location-btn');
        if (!btn || btn.disabled || toggle.classList.contains('timeclock-location-toggle--locked')) {
          return;
        }
        var id = btn.getAttribute('data-tc-location');
        if (!id) return;
        applyTimeclockLocationSelection(id, false);
      });
    });
  }

  function showTcLoginError(msg, variant) {
    var el = document.getElementById('timeclockLoginError');
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
    if (!msg) el.classList.remove('is-success');
    else el.classList.toggle('is-success', variant === 'success');
  }

  function showTcRegisterError(msg) {
    var el = document.getElementById('timeclockRegisterError');
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  function applyTimeclockShell() {
    var root = document.documentElement;
    root.classList.add('authed', 'timeclock-app');
    root.classList.remove('manager-app', 'employee-app');
    if (typeof window.gmCalloutSetLoginGateOpen === 'function') {
      window.gmCalloutSetLoginGateOpen(false);
    }
  }

  async function finishTimeclockSignIn() {
    applyTimeclockLocationSelection(selectedTimeclockRestaurantId(), false);
    try {
      sessionStorage.setItem(SESSION_KEY, 'timeclock');
    } catch (_e) {
      /* ignore */
    }
    applyTimeclockShell();
    if (typeof window.gmCalloutTimeclockBootstrap === 'function') {
      window.gmCalloutTimeclockBootstrap();
    }
  }

  function portalReady() {
    return window.gmPortalAuth && window.gmPortalAuth.enabled && window.gmPortalAuth.enabled();
  }

  var showTcLoginBtn = document.getElementById('showTimeclockLoginPanelBtn');
  if (showTcLoginBtn) showTcLoginBtn.addEventListener('click', showTimeclockLoginPanel);
  bindTimeclockLocationToggles();
  var showTcRegBtn = document.getElementById('showTimeclockRegisterPanelBtn');
  if (showTcRegBtn) showTcRegBtn.addEventListener('click', showTimeclockRegisterPanel);
  var backFromTc = document.getElementById('showLoginFromTimeclockPanelBtn');
  if (backFromTc) backFromTc.addEventListener('click', showLoginPanel);
  var backFromTcReg = document.getElementById('showLoginFromTimeclockRegisterBtn');
  if (backFromTcReg) backFromTcReg.addEventListener('click', showLoginPanel);

  var tcLoginForm = document.getElementById('timeclockLoginForm');
  if (tcLoginForm) {
    tcLoginForm.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!portalReady()) {
        showTcLoginError('Server sign-in is not ready. Check .env and restart npm start.');
        return;
      }
      var nameEl = document.getElementById('timeclockLoginName');
      var pw = document.getElementById('timeclockLoginPassword');
      showTcLoginError('');
      (async function () {
        var res = await window.gmPortalAuth.signIn(
          nameEl && nameEl.value,
          pw && pw.value
        );
        if (!res.ok) {
          showTcLoginError(res.message || 'Sign in failed.');
          return;
        }
        if (res.role !== 'timeclock') {
          showTcLoginError('This account is not a time clock device.');
          if (window.gmSupabase && window.gmSupabase.auth) {
            await window.gmSupabase.auth.signOut();
          }
          return;
        }
        await finishTimeclockSignIn();
      })();
    });
  }

  var tcRegForm = document.getElementById('timeclockRegisterForm');
  var tcRegSubmitBtn = tcRegForm ? tcRegForm.querySelector('button[type="submit"]') : null;

  if (tcRegForm) {
    tcRegForm.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!portalReady()) {
        showTcRegisterError('Server sign-in is not ready. Check .env and restart npm start.');
        return;
      }
      var codeEl = document.getElementById('tcRegAccessCode');
      var nameEl = document.getElementById('tcRegDeviceName');
      var pwEl = document.getElementById('tcRegPassword');
      var pw2El = document.getElementById('tcRegPasswordConfirm');
      var p1 = pwEl && pwEl.value ? String(pwEl.value) : '';
      var p2 = pw2El && pw2El.value ? String(pw2El.value) : '';
      if (p1 !== p2) {
        showTcRegisterError('Passwords do not match.');
        return;
      }
      if (p1.length < 4) {
        showTcRegisterError('Password must be at least 4 characters.');
        return;
      }
      var deviceName = nameEl && nameEl.value ? String(nameEl.value).trim() : '';
      if (!deviceName) {
        showTcRegisterError('Device name is required.');
        return;
      }
      showTcRegisterError('');
      if (tcRegSubmitBtn) {
        tcRegSubmitBtn.disabled = true;
        tcRegSubmitBtn.textContent = 'Creating…';
      }
      (async function () {
        try {
          var up = await window.gmPortalAuth.signUp({
            loginName: deviceName,
            password: p1,
            role: 'timeclock',
            accessCode: codeEl && codeEl.value,
            displayName: deviceName,
          });
          if (!up.ok) {
            showTcRegisterError(up.message || 'Could not create account.');
            return;
          }
          if (up.needsSignIn) {
            tcRegForm.reset();
            showTimeclockLoginPanel();
            var nameIn = document.getElementById('timeclockLoginName');
            if (nameIn) nameIn.value = deviceName;
            showTcLoginError(
              up.message || 'Account created. Sign in with your device name and password.',
              'success'
            );
            return;
          }
          if (up.role !== 'timeclock') {
            showTcRegisterError('Account was created with the wrong role.');
            return;
          }
          tcRegForm.reset();
          await finishTimeclockSignIn();
        } catch (ex) {
          showTcRegisterError((ex && ex.message) || 'Registration failed.');
        } finally {
          if (tcRegSubmitBtn) {
            tcRegSubmitBtn.disabled = false;
            tcRegSubmitBtn.textContent = 'Create device account';
          }
        }
      })();
    });
  }

  window.gmCalloutApplySupabaseRole = function (role) {
    if (role === 'timeclock') {
      void finishTimeclockSignIn();
      return true;
    }
    return false;
  };

  (async function restoreTimeclockSession() {
    try {
      if (sessionStorage.getItem(SESSION_KEY) !== 'timeclock') return;
      if (!window.gmSupabase || !window.gmSupabaseEnabled) return;
      var data = await window.gmSupabase.auth.getSession();
      if (!data.data || !data.data.session) return;
      var prof = await window.gmSupabase
        .from('profiles')
        .select('role')
        .eq('id', data.data.session.user.id)
        .maybeSingle();
      if (prof.data && prof.data.role === 'timeclock') {
        applyTimeclockShell();
        if (typeof window.gmCalloutTimeclockBootstrap === 'function') {
          window.gmCalloutTimeclockBootstrap();
        }
      }
    } catch (_ex) {
      /* ignore */
    }
  })();

  (function openTimeclockLoginOnKioskPath() {
    var api = window.gmTimeclockScheduleMatch;
    if (!api || typeof api.isTimeclockKioskPath !== 'function' || !api.isTimeclockKioskPath()) {
      return;
    }
    try {
      if (sessionStorage.getItem(SESSION_KEY) === 'timeclock') return;
    } catch (_e) {
      /* ignore */
    }
    showTimeclockLoginPanel();
  })();
})();
