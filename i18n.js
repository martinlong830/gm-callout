/**
 * Lightweight i18n for the web SPA.
 * Persist: localStorage key gm-callout-locale-v1
 * Usage: gmI18n.t('nav.schedule') | data-i18n / data-i18n-placeholder / data-i18n-aria / data-i18n-html
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'gm-callout-locale-v1';
  var locale = 'en';
  var listeners = [];

  function dictFor(lang) {
    if (lang === 'es') return global.GM_I18N_ES || {};
    return global.GM_I18N_EN || {};
  }

  function interpolate(str, vars) {
    if (!vars) return str;
    return String(str).replace(/\{(\w+)\}/g, function (_, key) {
      return vars[key] != null ? String(vars[key]) : '{' + key + '}';
    });
  }

  function t(key, vars) {
    var d = dictFor(locale);
    var en = dictFor('en');
    var raw = d[key] != null ? d[key] : en[key] != null ? en[key] : key;
    return interpolate(raw, vars);
  }

  function getLocale() {
    return locale;
  }

  function readStored() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      if (v === 'es' || v === 'en') return v;
    } catch (e) {}
    return 'en';
  }

  function writeStored(lang) {
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch (e) {}
  }

  function applyDomI18n(root) {
    var scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach(function (el) {
      var key = el.getAttribute('data-i18n');
      if (!key) return;
      el.textContent = t(key);
    });
    scope.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      var key = el.getAttribute('data-i18n-html');
      if (!key) return;
      el.innerHTML = t(key);
    });
    scope.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      var key = el.getAttribute('data-i18n-placeholder');
      if (!key) return;
      el.setAttribute('placeholder', t(key));
    });
    scope.querySelectorAll('[data-i18n-aria]').forEach(function (el) {
      var key = el.getAttribute('data-i18n-aria');
      if (!key) return;
      el.setAttribute('aria-label', t(key));
    });
    scope.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      var key = el.getAttribute('data-i18n-title');
      if (!key) return;
      el.setAttribute('title', t(key));
    });
    scope.querySelectorAll('.lang-toggle-btn').forEach(function (btn) {
      var lang = btn.getAttribute('data-lang');
      var active = lang === locale;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function refreshDynamicUi() {
    try {
      if (typeof global.gmCalloutOnLocaleChange === 'function') {
        global.gmCalloutOnLocaleChange(locale);
      }
    } catch (e) {
      console.warn('gmCalloutOnLocaleChange', e);
    }
  }

  function ensureLocaleDictLoaded(lang) {
    return new Promise(function (resolve) {
      if (lang !== 'es') {
        resolve();
        return;
      }
      if (global.GM_I18N_ES && typeof global.GM_I18N_ES === 'object') {
        resolve();
        return;
      }
      var existing = document.querySelector('script[data-gm-locale-es]');
      if (existing) {
        existing.addEventListener('load', function () {
          resolve();
        });
        existing.addEventListener('error', function () {
          resolve();
        });
        return;
      }
      var s = document.createElement('script');
      s.src = 'locales/es.js?v=perf-1';
      s.setAttribute('data-gm-locale-es', '1');
      s.onload = function () {
        resolve();
      };
      s.onerror = function () {
        resolve();
      };
      document.head.appendChild(s);
    });
  }

  function setLocale(lang, opts) {
    var next = lang === 'es' ? 'es' : 'en';
    var silent = opts && opts.silent;
    function apply() {
      locale = next;
      writeStored(next);
      try {
        document.documentElement.lang = next === 'es' ? 'es' : 'en';
      } catch (e) {}
      applyDomI18n(document);
      if (!silent) refreshDynamicUi();
      listeners.forEach(function (fn) {
        try {
          fn(next);
        } catch (e) {}
      });
    }
    if (next === 'es') {
      ensureLocaleDictLoaded('es').then(apply);
      return next;
    }
    apply();
    return next;
  }

  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
    return function () {
      listeners = listeners.filter(function (x) {
        return x !== fn;
      });
    };
  }

  function staffTypeLabel(code) {
    if (code === 'Kitchen') return t('staff.kitchen');
    if (code === 'Bartender') return t('staff.bartender');
    if (code === 'Server') return t('staff.server');
    return code || t('staff.staff');
  }

  function statusLabel(status) {
    var s = String(status || '').toLowerCase();
    if (s === 'approved') return t('status.approved');
    if (s === 'declined') return t('status.declined');
    if (s === 'awaiting_cover') return t('status.awaiting_cover');
    if (s === 'pending') return t('status.pending');
    if (s === 'draft') return t('status.draft');
    return status || '';
  }

  function dateLocale() {
    return locale === 'es' ? 'es' : 'en-US';
  }

  function bindToggleRoot(root) {
    if (!root) return;
    root.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('.lang-toggle-btn') : null;
      if (!btn) return;
      var lang = btn.getAttribute('data-lang');
      if (lang === 'en' || lang === 'es') setLocale(lang);
    });
  }

  function buildToggleHtml(extraClass) {
    var cls = 'lang-toggle' + (extraClass ? ' ' + extraClass : '');
    return (
      '<div class="' +
      cls +
      '" role="group" aria-label="' +
      t('common.language') +
      '">' +
      '<button type="button" class="lang-toggle-btn' +
      (locale === 'en' ? ' is-active' : '') +
      '" data-lang="en" aria-pressed="' +
      (locale === 'en' ? 'true' : 'false') +
      '">EN</button>' +
      '<button type="button" class="lang-toggle-btn' +
      (locale === 'es' ? ' is-active' : '') +
      '" data-lang="es" aria-pressed="' +
      (locale === 'es' ? 'true' : 'false') +
      '">ES</button>' +
      '</div>'
    );
  }

  function ensureLoginToggle() {
    var card = document.querySelector('#login-screen .login-card');
    if (!card || card.querySelector('.lang-toggle')) return;
    var wrap = document.createElement('div');
    wrap.className = 'login-lang-wrap';
    wrap.innerHTML = buildToggleHtml('lang-toggle--login');
    card.insertBefore(wrap, card.firstChild);
    bindToggleRoot(wrap);
  }

  function ensureHeaderToggles() {
    document.querySelectorAll('.header-actions').forEach(function (actions) {
      if (actions.querySelector('.lang-toggle')) return;
      var wrap = document.createElement('div');
      wrap.innerHTML = buildToggleHtml('lang-toggle--header');
      var node = wrap.firstChild;
      actions.insertBefore(node, actions.firstChild);
      bindToggleRoot(node);
    });
    var tcHeader = document.querySelector('#appTimeclock .header');
    if (tcHeader && !tcHeader.querySelector('.lang-toggle')) {
      var signOut = tcHeader.querySelector('[data-session-signout], .header-signout-btn');
      var wrap2 = document.createElement('div');
      wrap2.innerHTML = buildToggleHtml('lang-toggle--header');
      var node2 = wrap2.firstChild;
      if (signOut && signOut.parentNode) {
        signOut.parentNode.insertBefore(node2, signOut);
      } else {
        tcHeader.appendChild(node2);
      }
      bindToggleRoot(node2);
    }
  }

  function ensureAccountLanguageRow() {
    var form = document.getElementById('accountSettingsForm');
    if (!form || form.querySelector('.account-lang-row')) return;
    var row = document.createElement('div');
    row.className = 'form-field form-field-block account-lang-row';
    row.innerHTML =
      '<span class="form-label" data-i18n="common.language">Language</span>' +
      buildToggleHtml('lang-toggle--account');
    form.insertBefore(row, form.firstChild);
    bindToggleRoot(row);
    applyDomI18n(row);
  }

  function init() {
    locale = readStored();
    try {
      document.documentElement.lang = locale === 'es' ? 'es' : 'en';
    } catch (e) {}
    function finish() {
      ensureLoginToggle();
      ensureHeaderToggles();
      ensureAccountLanguageRow();
      applyDomI18n(document);
      bindToggleRoot(document);
    }
    if (locale === 'es') {
      ensureLocaleDictLoaded('es').then(finish);
      return;
    }
    finish();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.gmI18n = {
    t: t,
    getLocale: getLocale,
    setLocale: setLocale,
    applyDomI18n: applyDomI18n,
    onChange: onChange,
    staffTypeLabel: staffTypeLabel,
    statusLabel: statusLabel,
    dateLocale: dateLocale,
    STORAGE_KEY: STORAGE_KEY,
    ensureHeaderToggles: ensureHeaderToggles,
    ensureLoginToggle: ensureLoginToggle,
    ensureAccountLanguageRow: ensureAccountLanguageRow,
  };

  global.t = t;
})(typeof window !== 'undefined' ? window : globalThis);
