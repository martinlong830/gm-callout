/**
 * In-app notification center (web) — bell in header, unread badge, mark read.
 * Relies on public.app_notifications (RLS: own rows). Realtime + light poll fallback.
 *
 * The panel is portaled to document.body while open so .header { overflow:hidden }
 * and sibling chrome (top-nav / main) cannot clip or cover it.
 */
(function () {
  'use strict';

  var POLL_MS = 45000;
  var channel = null;
  var pollTimer = null;
  var items = [];
  var panelOpen = false;
  var portaledPanel = null;
  var portalHome = null;
  var viewportBound = false;

  function t(key, vars) {
    if (typeof window.gmT === 'function') return window.gmT(key, vars);
    return key;
  }

  function sb() {
    return window.gmSupabase || null;
  }

  function activeScope() {
    var root = document.documentElement;
    if (root.classList.contains('employee-app')) {
      return document.getElementById('appEmployee') || document;
    }
    if (root.classList.contains('manager-app')) {
      return document.querySelector('.app') || document;
    }
    return document.querySelector('.app') || document.getElementById('appEmployee') || document;
  }

  function els() {
    var scope = activeScope();
    var wrap = scope.querySelector('.header-notifications-wrap');
    var btn = scope.querySelector('.header-notifications-btn');
    var badge = scope.querySelector('.header-notifications-badge');
    var panel =
      (portaledPanel && document.body.contains(portaledPanel) && portaledPanel) ||
      (wrap && wrap.querySelector('.notifications-panel')) ||
      scope.querySelector('.notifications-panel');
    return {
      wrap: wrap,
      btn: btn,
      badge: badge,
      panel: panel,
      list: panel ? panel.querySelector('.notifications-panel-list') : null,
      empty: panel ? panel.querySelector('.notifications-panel-empty') : null,
      markAll: panel ? panel.querySelector('.notifications-mark-all') : null,
    };
  }

  function clearPanelPosition(panel) {
    if (!panel) return;
    panel.classList.remove('is-portaled');
    panel.style.top = '';
    panel.style.right = '';
    panel.style.left = '';
    panel.style.width = '';
    panel.style.maxWidth = '';
  }

  function positionPanel(panel, btn) {
    if (!panel || !btn) return;
    var rect = btn.getBoundingClientRect();
    var gutter = 12;
    var width = Math.min(22 * 16, window.innerWidth - gutter * 2);
    var right = Math.max(gutter, window.innerWidth - rect.right);
    panel.classList.add('is-portaled');
    panel.style.top = Math.round(rect.bottom + 6) + 'px';
    panel.style.right = right + 'px';
    panel.style.left = 'auto';
    panel.style.width = width + 'px';
    panel.style.maxWidth = 'calc(100vw - ' + gutter * 2 + 'px)';
  }

  function portalPanel(panel) {
    if (!panel) return;
    if (panel.parentElement === document.body) {
      portaledPanel = panel;
      return;
    }
    portalHome = { parent: panel.parentElement, nextSibling: panel.nextSibling };
    document.body.appendChild(panel);
    portaledPanel = panel;
  }

  function unportalPanel() {
    if (!portaledPanel) return;
    clearPanelPosition(portaledPanel);
    if (portalHome && portalHome.parent) {
      if (portalHome.nextSibling && portalHome.nextSibling.parentNode === portalHome.parent) {
        portalHome.parent.insertBefore(portaledPanel, portalHome.nextSibling);
      } else {
        portalHome.parent.appendChild(portaledPanel);
      }
    }
    portaledPanel = null;
    portalHome = null;
  }

  function onViewportChange() {
    if (!panelOpen) return;
    var e = els();
    if (e.panel && e.btn) positionPanel(e.panel, e.btn);
  }

  function bindViewport() {
    if (viewportBound) return;
    viewportBound = true;
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
  }

  function unreadCount() {
    return items.filter(function (n) {
      return n && !n.read_at;
    }).length;
  }

  function renderBadge() {
    document.querySelectorAll('.header-notifications-badge').forEach(function (badge) {
      var n = unreadCount();
      if (n <= 0) {
        badge.hidden = true;
        badge.textContent = '';
      } else {
        badge.hidden = false;
        badge.textContent = n > 99 ? '99+' : String(n);
      }
    });
    document.querySelectorAll('.header-notifications-btn').forEach(function (btn) {
      var n = unreadCount();
      btn.setAttribute(
        'aria-label',
        n > 0
          ? t('notifications.title') + ' (' + n + ' ' + t('notifications.unread') + ')'
          : t('notifications.title')
      );
    });
  }

  function formatWhen(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch (_e) {
      return '';
    }
  }

  function subsectionFromRequestType(requestType) {
    var t = String(requestType || '')
      .trim()
      .toLowerCase();
    if (t === 'callout' || t === 'callout_request') return 'callout';
    if (t === 'timeoff' || t === 'vacation' || t === 'sick' || t === 'pto') return 'timeoff';
    if (t === 'swap' || t === 'shift_swap') return 'swap';
    if (t === 'availability') return 'availability';
    return null;
  }

  /** Resolve notification → { screen, subsection, requestId, weekMondayIso }. */
  function resolveNotificationRoute(type, data) {
    var d = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    var notifType = String(type || d.type || '')
      .trim()
      .toLowerCase();
    var requestType = String(d.requestType || d.request_type || '').trim();
    var requestId = String(
      d.requestId || d.request_id || d.staffRequestId || d.staff_request_id || ''
    ).trim();
    var weekMondayIso = String(d.weekMondayIso || d.week_monday_iso || '')
      .trim()
      .slice(0, 10);
    var explicit = String(d.subsection || d.screen || '')
      .trim()
      .toLowerCase();
    var subsection = null;
    if (
      explicit === 'timeoff' ||
      explicit === 'swap' ||
      explicit === 'callout' ||
      explicit === 'availability' ||
      explicit === 'schedule'
    ) {
      subsection = explicit;
    } else {
      subsection = subsectionFromRequestType(requestType);
    }
    if (!subsection) {
      if (notifType === 'availability_submitted') subsection = 'availability';
      else if (
        notifType === 'schedule_published' ||
        notifType === 'schedule_review_pending'
      ) {
        subsection = 'schedule';
      }
      else if (
        notifType === 'swap_offer_targeted' ||
        notifType === 'swap_offer_submitted' ||
        notifType === 'swap_accepted_pending' ||
        notifType.indexOf('swap') >= 0
      ) {
        subsection = 'swap';
      } else if (notifType.indexOf('callout') >= 0) subsection = 'callout';
      else if (
        notifType.indexOf('timeoff') >= 0 ||
        notifType.indexOf('vacation') >= 0 ||
        notifType.indexOf('sick') >= 0
      ) {
        subsection = 'timeoff';
      }
    }
    if (!subsection) return null;
    if (subsection === 'availability') {
      return { screen: 'availability', subsection: subsection, requestId: requestId || null };
    }
    if (subsection === 'schedule') {
      var openApprovals =
        notifType === 'schedule_review_pending' ||
        d.openScheduleApprovals === true ||
        d.open_schedule_approvals === true;
      var restaurantId = String(d.restaurantId || d.restaurant_id || '').trim() || null;
      return {
        screen: 'schedule',
        subsection: subsection,
        requestId: requestId || null,
        weekMondayIso: /^\d{4}-\d{2}-\d{2}$/.test(weekMondayIso) ? weekMondayIso : null,
        openScheduleApprovals: !!openApprovals,
        restaurantId: restaurantId,
      };
    }
    return {
      screen: 'actions',
      subsection: subsection,
      requestId: requestId || null,
    };
  }

  function openNotificationRoute(route) {
    if (!route) return;
    if (typeof window.gmCalloutOpenNotificationRoute === 'function') {
      window.gmCalloutOpenNotificationRoute(route);
      return;
    }
    if (
      document.documentElement.classList.contains('employee-app') &&
      typeof window.gmCalloutEmployeeOpenNotificationRoute === 'function'
    ) {
      window.gmCalloutEmployeeOpenNotificationRoute(route);
    }
  }

  function onNotificationClick(n) {
    var route = resolveNotificationRoute(n && n.type, n && n.data);
    void markRead(n && n.id ? [n.id] : []).then(function () {
      setPanelOpen(false);
      openNotificationRoute(route);
    });
  }

  function renderList() {
    var e = els();
    if (!e.list) return;
    e.list.innerHTML = '';
    if (!items.length) {
      if (e.empty) e.empty.hidden = false;
      return;
    }
    if (e.empty) e.empty.hidden = true;
    items.forEach(function (n) {
      var li = document.createElement('li');
      li.className = 'notifications-item' + (n.read_at ? '' : ' is-unread');
      li.setAttribute('data-id', n.id);
      li.setAttribute('role', 'button');
      li.tabIndex = 0;
      var title = document.createElement('div');
      title.className = 'notifications-item-title';
      title.textContent = n.title || '';
      var body = document.createElement('div');
      body.className = 'notifications-item-body';
      body.textContent = n.body || '';
      var meta = document.createElement('div');
      meta.className = 'notifications-item-meta';
      meta.textContent = formatWhen(n.created_at);
      li.appendChild(title);
      if (n.body) li.appendChild(body);
      li.appendChild(meta);
      li.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        onNotificationClick(n);
      });
      li.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          onNotificationClick(n);
        }
      });
      e.list.appendChild(li);
    });
  }

  function setPanelOpen(open) {
    panelOpen = !!open;
    document.querySelectorAll('.notifications-panel').forEach(function (panel) {
      panel.hidden = true;
    });
    document.querySelectorAll('.header-notifications-btn').forEach(function (btn) {
      btn.setAttribute('aria-expanded', 'false');
    });
    if (!panelOpen) {
      unportalPanel();
      return;
    }
    var e = els();
    if (!e.panel || !e.btn) {
      panelOpen = false;
      return;
    }
    portalPanel(e.panel);
    positionPanel(e.panel, e.btn);
    e.panel.hidden = false;
    e.btn.setAttribute('aria-expanded', 'true');
    bindViewport();
    void refresh({ silent: true }).then(function () {
      renderList();
    });
  }

  async function currentUserId() {
    var client = sb();
    if (!client) return null;
    try {
      var sess = await client.auth.getSession();
      return (
        (sess.data && sess.data.session && sess.data.session.user && sess.data.session.user.id) ||
        null
      );
    } catch (_e) {
      return null;
    }
  }

  async function refresh(opts) {
    var silent = !!(opts && opts.silent);
    var client = sb();
    var uid = await currentUserId();
    if (!client || !uid) {
      items = [];
      renderBadge();
      if (panelOpen) renderList();
      return;
    }
    var res = await client
      .from('app_notifications')
      .select('id, type, title, body, data, read_at, created_at, restaurant_id')
      .eq('user_id', uid)
      .order('created_at', { ascending: false })
      .limit(50);
    if (res.error) {
      if (!silent) console.warn('notifications refresh', res.error);
      return;
    }
    items = res.data || [];
    renderBadge();
    if (panelOpen) renderList();
  }

  async function markRead(ids) {
    var client = sb();
    var uid = await currentUserId();
    if (!client || !uid || !ids || !ids.length) return;
    var now = new Date().toISOString();
    var res = await client
      .from('app_notifications')
      .update({ read_at: now })
      .eq('user_id', uid)
      .in('id', ids)
      .is('read_at', null);
    if (res.error) {
      console.warn('notifications markRead', res.error);
      return;
    }
    var idSet = Object.create(null);
    ids.forEach(function (id) {
      idSet[id] = true;
    });
    items = items.map(function (n) {
      if (n && idSet[n.id] && !n.read_at) return Object.assign({}, n, { read_at: now });
      return n;
    });
    renderBadge();
    if (panelOpen) renderList();
  }

  async function markAllRead() {
    var client = sb();
    var uid = await currentUserId();
    if (!client || !uid) return;
    var now = new Date().toISOString();
    var res = await client
      .from('app_notifications')
      .update({ read_at: now })
      .eq('user_id', uid)
      .is('read_at', null);
    if (res.error) {
      console.warn('notifications markAllRead', res.error);
      return;
    }
    items = items.map(function (n) {
      return n && !n.read_at ? Object.assign({}, n, { read_at: now }) : n;
    });
    renderBadge();
    if (panelOpen) renderList();
  }

  function stopRealtime() {
    var client = sb();
    if (channel && client) {
      try {
        client.removeChannel(channel);
      } catch (_e) {
        /* ignore */
      }
    }
    channel = null;
  }

  async function startRealtime() {
    stopRealtime();
    var client = sb();
    var uid = await currentUserId();
    if (!client || !uid) return;
    try {
      channel = client
        .channel('app_notifications_own')
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'app_notifications',
            filter: 'user_id=eq.' + uid,
          },
          function () {
            void refresh({ silent: true });
          }
        )
        .subscribe();
    } catch (err) {
      console.warn('notifications realtime', err);
    }
  }

  function startPoll() {
    stopPoll();
    pollTimer = setInterval(function () {
      void refresh({ silent: true });
    }, POLL_MS);
  }

  function stopPoll() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function bindUi() {
    document.querySelectorAll('.header-notifications-btn').forEach(function (btn) {
      if (btn.__gmNotifBound) return;
      btn.__gmNotifBound = true;
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var e = els();
        var alreadyOpen = e.panel && !e.panel.hidden && e.btn === btn;
        setPanelOpen(!alreadyOpen);
      });
    });
    document.querySelectorAll('.notifications-mark-all').forEach(function (btn) {
      if (btn.__gmNotifBound) return;
      btn.__gmNotifBound = true;
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        void markAllRead();
      });
    });
    if (!document.__gmNotifDocBound) {
      document.__gmNotifDocBound = true;
      document.addEventListener('click', function (ev) {
        if (!panelOpen) return;
        var e = els();
        if (e.wrap && e.wrap.contains(ev.target)) return;
        if (e.panel && e.panel.contains(ev.target)) return;
        setPanelOpen(false);
      });
      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' && panelOpen) setPanelOpen(false);
      });
    }
  }

  async function start() {
    bindUi();
    var root = document.documentElement;
    if (!root.classList.contains('authed') || root.classList.contains('timeclock-app')) {
      stop();
      return;
    }
    await refresh({ silent: true });
    await startRealtime();
    startPoll();
  }

  function stop() {
    stopRealtime();
    stopPoll();
    setPanelOpen(false);
    items = [];
    renderBadge();
  }

  window.gmCalloutNotificationsCenter = {
    start: start,
    stop: stop,
    refresh: refresh,
    resolveRoute: resolveNotificationRoute,
  };

  document.addEventListener('DOMContentLoaded', function () {
    bindUi();
  });
})();
