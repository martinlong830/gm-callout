(function () {
  'use strict';

  var CHAT_KEY = 'gm-callout-employee-messages-v1';

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function el(id) {
    return document.getElementById(id);
  }

  function loadChatStore() {
    try {
      var raw = localStorage.getItem(CHAT_KEY);
      if (raw) {
        var o = JSON.parse(raw);
        if (o && typeof o === 'object' && o.version === 1 && Array.isArray(o.threads)) return o;
      }
    } catch (e0) {
      /* ignore */
    }
    return {
      version: 1,
      activeThreadId: null,
      threads: [
        {
          id: 'jamie',
          peerName: 'Jamie Li',
          subtitle: 'Kitchen',
          messages: [
            {
              who: 'peer',
              body: 'Hey Jordan — want to trade a lunch shift next week? Let me know what works.',
              at: new Date().toISOString(),
            },
          ],
        },
        {
          id: 'manager',
          peerName: 'Martin Long',
          subtitle: 'Manager',
          messages: [
            {
              who: 'peer',
              body: 'Hi Jordan — ping me here if you need anything on the schedule.',
              at: new Date().toISOString(),
            },
          ],
        },
      ],
    };
  }

  function saveChatStore(store) {
    try {
      localStorage.setItem(CHAT_KEY, JSON.stringify(store));
    } catch (e1) {
      /* ignore */
    }
  }

  var employeeAppEventsBound = false;

  function init() {
    if (!document.documentElement.classList.contains('employee-app')) return;

    var bridge = window.gmCalloutBridge;
    if (!bridge || !bridge.employeeLoginName) return;

    var WORKER = bridge.employeeLoginName;
    var titles = { home: 'Home', messages: 'Messages', requests: 'Requests' };

    var screenTitle = el('empScreenTitle');
    var welcomeCard = el('empWelcomeCard');
    var listToday = el('empShiftsToday');
    var listUp = el('empShiftsUpcoming');
    var managerBanner = el('empManagerBanner');
    var threadList = el('empThreadList');
    var chatPanel = el('empChatPanel');
    var chatLog = el('empChatLog');
    var chatTitle = el('empChatTitle');
    var chatForm = el('empChatForm');
    var chatInput = el('empChatInput');
    var backThreads = el('empBackThreads');
    var messagesLayout = el('empMessagesLayout');
    var feedback = el('empRequestFeedback');

    var store = loadChatStore();

    function showEmpNav(key) {
      document.querySelectorAll('[data-emp-nav]').forEach(function (b) {
        var on = b.getAttribute('data-emp-nav') === key;
        b.classList.toggle('active', on);
        if (on) b.setAttribute('aria-current', 'page');
        else b.removeAttribute('aria-current');
      });
      document.querySelectorAll('.emp-screen').forEach(function (sec) {
        var k = sec.getAttribute('data-emp-screen');
        sec.hidden = k !== key;
      });
      if (screenTitle) screenTitle.textContent = titles[key] || 'Home';
    }

    function mapRoleClass(role) {
      if (role === 'Kitchen') return 'role-kitchen';
      if (role === 'Bartender') return 'role-bartender';
      if (role === 'Server') return 'role-server';
      return 'role-server';
    }

    function renderShiftList(ul, rows, emptyMsg) {
      if (!ul) return;
      if (!rows || !rows.length) {
        ul.innerHTML = '<li class="emp-shift-empty">' + escapeHtml(emptyMsg) + '</li>';
        return;
      }
      ul.innerHTML = rows
        .map(function (r) {
          var rc = r.roleClass || mapRoleClass(r.role);
          var pill = escapeHtml(r.groupLabel || r.role || '');
          return (
            '<li class="emp-shift-item">' +
            '<div class="emp-shift-top">' +
            '<span class="role-pill ' +
            escapeHtml(rc) +
            '">' +
            pill +
            '</span>' +
            '<span class="emp-shift-day">' +
            escapeHtml(r.day) +
            '</span>' +
            '</div>' +
            '<p class="emp-shift-meta">' +
            escapeHtml(r.timeLabel || (r.start + ' – ' + r.end)) +
            ' · ' +
            escapeHtml(r.restaurantName || '') +
            '</p>' +
            '</li>'
          );
        })
        .join('');
    }

    function renderHome() {
      var role = bridge.getWorkerRoleLine(WORKER);
      if (welcomeCard) {
        welcomeCard.innerHTML =
          '<p class="emp-welcome-name">' +
          escapeHtml(WORKER) +
          '</p>' +
          '<p class="emp-welcome-meta">' +
          escapeHtml(role) +
          '</p>' +
          '<p class="emp-welcome-hint">Shifts match the manager schedule (all locations).</p>';
      }
      var buckets = bridge.getWorkerScheduleBuckets(WORKER);
      renderShiftList(
        listToday,
        buckets.today,
        'You have no shifts today in the current 3-week window.'
      );
      renderShiftList(
        listUp,
        buckets.upcoming,
        'No later shifts in the current 3-week window.'
      );
    }

    var mgr = bridge.getManagerContact();
    if (managerBanner) {
      managerBanner.innerHTML =
        '<p class="emp-manager-line"><strong>Manager</strong> — ' +
        escapeHtml(mgr.name) +
        '</p>' +
        '<p class="emp-manager-line muted">' +
        escapeHtml(mgr.email) +
        '</p>';
    }

    function renderThreadsList() {
      if (!threadList) return;
      threadList.innerHTML = store.threads
        .map(function (t) {
          var last = t.messages && t.messages.length ? t.messages[t.messages.length - 1] : null;
          var preview = last ? last.body : '';
          return (
            '<li>' +
            '<button type="button" class="emp-thread-row" data-thread-id="' +
            escapeHtml(t.id) +
            '">' +
            '<span class="emp-thread-name">' +
            escapeHtml(t.peerName) +
            '</span>' +
            '<span class="emp-thread-sub">' +
            escapeHtml(t.subtitle || '') +
            '</span>' +
            '<span class="emp-thread-preview">' +
            escapeHtml(preview) +
            '</span>' +
            '</button></li>'
          );
        })
        .join('');
      threadList.querySelectorAll('[data-thread-id]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          openThread(btn.getAttribute('data-thread-id'));
        });
      });
    }

    function threadById(id) {
      return store.threads.find(function (t) {
        return t.id === id;
      });
    }

    function renderChatMessages(thread) {
      if (!chatLog || !thread) return;
      chatLog.innerHTML = (thread.messages || [])
        .map(function (m) {
          var self = m.who === 'self';
          return (
            '<div class="emp-msg ' +
            (self ? 'emp-msg--self' : 'emp-msg--peer') +
            '">' +
            '<p class="emp-msg-body">' +
            escapeHtml(m.body) +
            '</p>' +
            '</div>'
          );
        })
        .join('');
      chatLog.scrollTop = chatLog.scrollHeight;
    }

    function openThread(id) {
      var thread = threadById(id);
      if (!thread || !chatPanel || !messagesLayout) return;
      store.activeThreadId = id;
      saveChatStore(store);
      chatPanel.hidden = false;
      messagesLayout.classList.add('emp-messages-layout--chat-open');
      if (chatTitle) chatTitle.textContent = thread.peerName;
      renderChatMessages(thread);
      if (chatInput) chatInput.focus();
    }

    function closeThreadView() {
      store.activeThreadId = null;
      saveChatStore(store);
      if (chatPanel) chatPanel.hidden = true;
      if (messagesLayout) messagesLayout.classList.remove('emp-messages-layout--chat-open');
    }

    function allShiftsForSelect() {
      var b = bridge.getWorkerScheduleBuckets(WORKER);
      return (b.today || []).concat(b.upcoming || []);
    }

    function populateCalloutShiftSelect() {
      var sel = el('empCalloutShift');
      if (!sel) return;
      var rows = allShiftsForSelect();
      if (!rows.length) {
        sel.innerHTML = '<option value="">No scheduled shifts in the current window</option>';
        sel.disabled = true;
        return;
      }
      sel.disabled = false;
      sel.innerHTML =
        '<option value="">Choose a shift…</option>' +
        rows
          .map(function (r, i) {
            var val =
              r.restaurantId +
              '|' +
              r.id +
              '|' +
              encodeURIComponent(r.day) +
              '|' +
              encodeURIComponent(r.timeLabel || r.start + '–' + r.end);
            var lab = r.day + ' · ' + (r.timeLabel || r.start + ' – ' + r.end) + ' · ' + r.restaurantName;
            return '<option value="' + escapeHtml(val) + '">' + escapeHtml(lab) + '</option>';
          })
          .join('');
    }

    function showRequestFeedback(msg) {
      if (!feedback) return;
      feedback.textContent = msg || '';
      feedback.hidden = !msg;
    }

    function wireRequestForm(formId, getPayload) {
      var form = el(formId);
      if (!form) return;
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var payload = getPayload();
        if (!payload) return;
        bridge.submitEmployeeRequest(payload);
        form.reset();
        showRequestFeedback('Submitted. Your manager will see it under Requests.');
        setTimeout(function () {
          showRequestFeedback('');
        }, 4000);
      });
    }

    var roleCode = bridge.getWorkerRoleCode(WORKER);

    if (!employeeAppEventsBound) {
      employeeAppEventsBound = true;

      if (backThreads) {
        backThreads.addEventListener('click', function () {
          closeThreadView();
        });
      }

      if (chatForm && chatInput) {
        chatForm.addEventListener('submit', function (e) {
          e.preventDefault();
          var id = store.activeThreadId;
          var thread = threadById(id);
          if (!thread) return;
          var text = (chatInput.value || '').trim();
          if (!text) return;
          thread.messages.push({
            who: 'self',
            body: text,
            at: new Date().toISOString(),
          });
          chatInput.value = '';
          saveChatStore(store);
          renderChatMessages(thread);
        });
      }

      wireRequestForm('empFormAvailability', function () {
        var ta = el('empAvailDetails');
        var summary = (ta && ta.value) || '';
        if (!String(summary).trim()) return null;
        return {
          type: 'availability',
          employeeName: WORKER,
          role: roleCode,
          summary: 'Availability update: ' + String(summary).trim(),
        };
      });

      wireRequestForm('empFormSwap', function () {
        var ta = el('empSwapDetails');
        var summary = (ta && ta.value) || '';
        if (!String(summary).trim()) return null;
        return {
          type: 'swap',
          employeeName: WORKER,
          role: roleCode,
          summary: 'Shift swap: ' + String(summary).trim(),
        };
      });

      wireRequestForm('empFormTimeoff', function () {
        var ta = el('empTimeoffDetails');
        var summary = (ta && ta.value) || '';
        if (!String(summary).trim()) return null;
        return {
          type: 'timeoff',
          employeeName: WORKER,
          role: roleCode,
          summary: 'Time off: ' + String(summary).trim(),
        };
      });

      wireRequestForm('empFormCallout', function () {
        var sel = el('empCalloutShift');
        var ta = el('empCalloutReason');
        if (!sel || sel.disabled || !sel.value) {
          showRequestFeedback('Pick a shift from the list.');
          setTimeout(function () {
            showRequestFeedback('');
          }, 3000);
          return null;
        }
        var reason = (ta && ta.value) || '';
        if (!String(reason).trim()) return null;
        var opt = sel.options[sel.selectedIndex];
        var summary =
          'Cannot work scheduled shift: ' + (opt ? opt.textContent : '') + '. ' + String(reason).trim();
        return {
          type: 'callout_request',
          employeeName: WORKER,
          role: roleCode,
          summary: summary,
        };
      });

      document.querySelectorAll('[data-req-form]').forEach(function (chip) {
        chip.addEventListener('click', function () {
          var t = chip.getAttribute('data-req-form');
          document.querySelectorAll('[data-req-form]').forEach(function (c) {
            c.classList.toggle('active', c === chip);
          });
          var map = {
            availability: 'empFormAvailability',
            swap: 'empFormSwap',
            timeoff: 'empFormTimeoff',
            callout_request: 'empFormCallout',
          };
          Object.keys(map).forEach(function (k) {
            var f = el(map[k]);
            if (f) f.hidden = k !== t;
          });
        });
      });

      document.querySelectorAll('[data-emp-nav]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var key = btn.getAttribute('data-emp-nav');
          if (key === 'home') renderHome();
          if (key === 'messages') {
            renderThreadsList();
            closeThreadView();
          }
          if (key === 'requests') {
            populateCalloutShiftSelect();
            showRequestFeedback('');
          }
          showEmpNav(key);
        });
      });
    }

    renderHome();
    showEmpNav('home');
  }

  window.gmCalloutEmployeeBootstrap = init;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
