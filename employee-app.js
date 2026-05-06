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

  /** Strip legacy prompt threads (peer "New message" / "ok" artifacts). */
  function sanitizeChatStoreThreads(o) {
    if (!o || typeof o !== 'object' || o.version !== 1 || !Array.isArray(o.threads)) return o;
    var re = /^new\s*message$/i;
    var threads = o.threads.filter(function (t) {
      return !re.test(String((t && t.peerName) || '').trim());
    });
    var active = o.activeThreadId;
    if (active && !threads.some(function (t) {
      return t && t.id === active;
    })) {
      active = null;
    }
    return { version: 1, activeThreadId: active, threads: threads };
  }

  function chatStoreNeedsResave(before, after) {
    if (!before || !after) return false;
    return (
      before.threads.length !== after.threads.length || before.activeThreadId !== after.activeThreadId
    );
  }

  function loadChatStore() {
    try {
      var raw = localStorage.getItem(CHAT_KEY);
      if (raw) {
        var o = JSON.parse(raw);
        if (o && typeof o === 'object' && o.version === 1 && Array.isArray(o.threads)) {
          var cleaned = sanitizeChatStoreThreads(o);
          if (chatStoreNeedsResave(o, cleaned)) saveChatStore(cleaned);
          return cleaned;
        }
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
          subtitle: 'Back of the House',
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
    if (
      typeof window !== 'undefined' &&
      window.gmSupabaseEnabled &&
      typeof window.gmCalloutQueueEmployeeChatCloudSave === 'function'
    ) {
      window.gmCalloutQueueEmployeeChatCloudSave(store);
    }
  }

  var employeeAppEventsBound = false;

  function init() {
    if (!document.documentElement.classList.contains('employee-app')) return;

    var bridge = window.gmCalloutBridge;
    if (!bridge) return;

    var WORKER =
      bridge.getEmployeeLoginName && typeof bridge.getEmployeeLoginName === 'function'
        ? bridge.getEmployeeLoginName()
        : bridge.employeeLoginName || 'Jordan Ma';
    if (!WORKER) return;
    var titles = { home: 'Home', messages: 'Messages', requests: 'Actions' };

    var screenTitle = el('empScreenTitle');
    var welcomeCard = el('empWelcomeCard');
    var listToday = el('empShiftsToday');
    var listUp = el('empShiftsUpcoming');
    var upcomingPrevWeekBtn = el('empUpcomingPrevWeek');
    var upcomingNextWeekBtn = el('empUpcomingNextWeek');
    var upcomingWeekLabel = el('empUpcomingWeekLabel');
    var managerBanner = el('empManagerBanner');
    var messageSearchInput = el('empMessageSearch');
    var threadList = el('empThreadList');
    var chatPanel = el('empChatPanel');
    var chatLog = el('empChatLog');
    var chatTitle = el('empChatTitle');
    var chatForm = el('empChatForm');
    var chatInput = el('empChatInput');
    var chatBackBtn = el('empChatBack');
    var messagesLayout = el('empMessagesLayout');
    var feedback = el('empRequestFeedback');
    var empAvailWeekChips = el('empAvailWeekChips');
    var empAvailGrid = el('empAvailGrid');
    var empAvailCheckAllBtn = el('empAvailCheckAllBtn');
    var empTimeoffStartDate = el('empTimeoffStartDate');
    var empTimeoffEndDate = el('empTimeoffEndDate');
    var empTimeoffNote = el('empTimeoffNote');
    var empSwapShiftOffer = el('empSwapShiftOffer');
    var empSwapAvailableShift = el('empSwapAvailableShift');
    var empSwapAcceptBtn = el('empSwapAcceptBtn');
    var empSwapAcceptNote = el('empSwapAcceptNote');
    var upcomingWeekCursor = 0;
    var upcomingWeekStarts = [];
    var upcomingRowsByWeek = {};
    var availWeekOptions = [];
    var selectedAvailWeekIndex = 0;
    var currentAvailGrid = null;
    var messagesSearchQuery = '';

    var store = loadChatStore();

    function threadHasMessages(t) {
      return !!(t && t.messages && t.messages.length);
    }

    function threadLastActivityMs(t) {
      if (!threadHasMessages(t)) return 0;
      var last = t.messages[t.messages.length - 1];
      var ms = last && last.at ? Date.parse(String(last.at)) : 0;
      return Number.isFinite(ms) ? ms : 0;
    }

    function sortThreadsByRecentDesc(arr) {
      return arr.slice().sort(function (a, b) {
        return threadLastActivityMs(b) - threadLastActivityMs(a);
      });
    }

    function threadsForMainScreen() {
      if (!store || !Array.isArray(store.threads)) return [];
      return sortThreadsByRecentDesc(store.threads.filter(threadHasMessages));
    }

    function threadsMatchingSearch() {
      var q = String(messagesSearchQuery || '')
        .trim()
        .toLowerCase();
      var withMsg = store.threads.filter(threadHasMessages);
      if (!q) return sortThreadsByRecentDesc(withMsg);
      return sortThreadsByRecentDesc(
        withMsg.filter(function (t) {
          if (!t) return false;
          var last = t.messages[t.messages.length - 1];
          var preview = last ? String(last.body) : '';
          var blob = (
            String(t.peerName || '') +
            ' ' +
            String(t.subtitle || '') +
            ' ' +
            preview
          ).toLowerCase();
          return blob.indexOf(q) !== -1;
        })
      );
    }

    function recipientsMatchingSearch() {
      var q = String(messagesSearchQuery || '')
        .trim()
        .toLowerCase();
      if (!q) return [];
      if (!bridge || typeof bridge.getMessageRecipients !== 'function') return [];
      var all = bridge.getMessageRecipients() || [];
      return all.filter(function (p) {
        if (!p) return false;
        var blob = (String(p.name || '') + ' ' + String(p.subtitle || '')).toLowerCase();
        return blob.indexOf(q) !== -1;
      });
    }

    function stableThreadIdForRecipient(recipient) {
      if (recipient.id === 'msg-mgr') return 'msg-mgr';
      return 'msg-emp-' + String(recipient.id);
    }

    function findThreadForRecipient(recipient) {
      var tid = stableThreadIdForRecipient(recipient);
      var byId = store.threads.find(function (t) {
        return t.id === tid;
      });
      if (byId) return byId;
      var nm = String(recipient.name || '')
        .trim()
        .toLowerCase();
      return store.threads.find(function (t) {
        return String(t.peerName || '')
          .trim()
          .toLowerCase() === nm;
      });
    }

    function recipientHasMessagedThread(p) {
      var t = findThreadForRecipient(p);
      return threadHasMessages(t);
    }

    function ensureOpenThreadForRecipient(recipient) {
      var found = findThreadForRecipient(recipient);
      if (found) {
        openThread(found.id);
        return;
      }
      var tid = stableThreadIdForRecipient(recipient);
      store.threads.unshift({
        id: tid,
        peerName: recipient.name,
        subtitle: recipient.subtitle || '',
        messages: [],
      });
      saveChatStore(store);
      renderThreadsList();
      openThread(tid);
    }

    function showEmpNav(key) {
      if (key !== 'messages') {
        closeThreadView();
      }
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

    function parseIsoDate(iso) {
      if (!iso) return null;
      var m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return null;
      var y = parseInt(m[1], 10);
      var mo = parseInt(m[2], 10) - 1;
      var d = parseInt(m[3], 10);
      return new Date(y, mo, d);
    }

    function formatCalendarDateLabel(row) {
      var d = parseIsoDate(row && row.iso);
      if (!d || Number.isNaN(d.getTime())) {
        return row && row.day ? String(row.day) : '';
      }
      var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      var weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      return weekdays[d.getDay()] + ', ' + months[d.getMonth()] + ' ' + d.getDate();
    }

    function weekStartIsoFromIso(iso) {
      var d = parseIsoDate(iso);
      if (!d || Number.isNaN(d.getTime())) return '';
      var day = d.getDay(); // Sun=0...Sat=6
      var monOffset = day === 0 ? -6 : 1 - day;
      var mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() + monOffset);
      var y = mon.getFullYear();
      var m = String(mon.getMonth() + 1).padStart(2, '0');
      var dd = String(mon.getDate()).padStart(2, '0');
      return y + '-' + m + '-' + dd;
    }

    function formatWeekHeaderLabel(weekStartIso) {
      var d = parseIsoDate(weekStartIso);
      if (!d || Number.isNaN(d.getTime())) return 'Upcoming';
      var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return 'Week of ' + months[d.getMonth()] + ' ' + d.getDate();
    }

    function renderShiftItemHtml(r) {
      var rc = r.roleClass || mapRoleClass(r.role);
      var pill = escapeHtml(r.groupLabel || r.role || '');
      var tl =
        r.timeLabel ||
        (bridge.formatShiftTimeRedPoke && r.start && r.end
          ? bridge.formatShiftTimeRedPoke(r.start, r.end)
          : (r.start || '') + ' – ' + (r.end || ''));
      var br = r.redPokeBreak != null ? r.redPokeBreak : '(3:00PM BREAK TIME)';
      var hrs = r.redPokeHours != null ? String(r.redPokeHours) : '';
      var dayLabel = formatCalendarDateLabel(r);
      return (
        '<li class="emp-shift-item">' +
        '<div class="emp-shift-top">' +
        '<span class="role-pill ' +
        escapeHtml(rc) +
        '">' +
        pill +
        '</span>' +
        '<span class="emp-shift-day">' +
        escapeHtml(dayLabel) +
        '</span>' +
        '</div>' +
        '<div class="emp-shift-rp">' +
        '<div class="emp-shift-rp-time">' +
        escapeHtml(tl) +
        '</div>' +
        '<div class="emp-shift-rp-break">' +
        escapeHtml(br) +
        '</div>' +
        '<div class="emp-shift-rp-hours">' +
        escapeHtml(hrs) +
        '</div>' +
        '</div>' +
        '<p class="emp-shift-meta">' +
        escapeHtml(r.restaurantName || '') +
        '</p>' +
        '</li>'
      );
    }

    function renderShiftList(ul, rows, emptyMsg) {
      if (!ul) return;
      if (!rows || !rows.length) {
        ul.innerHTML = '<li class="emp-shift-empty">' + escapeHtml(emptyMsg) + '</li>';
        return;
      }
      ul.innerHTML = rows.map(renderShiftItemHtml).join('');
    }

    function partitionUpcomingByWeek(rows) {
      var groups = {};
      var order = [];
      (rows || []).forEach(function (r) {
        var wk = weekStartIsoFromIso(r && r.iso) || 'unknown';
        if (!groups[wk]) {
          groups[wk] = [];
          order.push(wk);
        }
        groups[wk].push(r);
      });
      return { order: order, groups: groups };
    }

    function renderUpcomingWeekPager(ul, emptyMsg) {
      if (!ul) return;
      if (!upcomingWeekStarts.length) {
        ul.innerHTML = '<li class="emp-shift-empty">' + escapeHtml(emptyMsg) + '</li>';
        if (upcomingWeekLabel) upcomingWeekLabel.textContent = 'No upcoming shifts';
        if (upcomingPrevWeekBtn) upcomingPrevWeekBtn.disabled = true;
        if (upcomingNextWeekBtn) upcomingNextWeekBtn.disabled = true;
        return;
      }
      if (upcomingWeekCursor < 0) upcomingWeekCursor = 0;
      if (upcomingWeekCursor >= upcomingWeekStarts.length) upcomingWeekCursor = upcomingWeekStarts.length - 1;
      var wk = upcomingWeekStarts[upcomingWeekCursor];
      var rows = upcomingRowsByWeek[wk] || [];
      ul.innerHTML = rows.map(renderShiftItemHtml).join('');
      if (upcomingWeekLabel) upcomingWeekLabel.textContent = formatWeekHeaderLabel(wk);
      if (upcomingPrevWeekBtn) upcomingPrevWeekBtn.disabled = upcomingWeekCursor <= 0;
      if (upcomingNextWeekBtn) upcomingNextWeekBtn.disabled = upcomingWeekCursor >= upcomingWeekStarts.length - 1;
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
          '</p>';
      }
      var buckets = bridge.getWorkerScheduleBuckets(WORKER);
      renderShiftList(
        listToday,
        buckets.today,
        'You have no shifts today in the current 3-week window.'
      );
      var grouped = partitionUpcomingByWeek(buckets.upcoming);
      upcomingWeekStarts = grouped.order;
      upcomingRowsByWeek = grouped.groups;
      if (upcomingWeekStarts.length && upcomingWeekCursor >= upcomingWeekStarts.length) {
        upcomingWeekCursor = upcomingWeekStarts.length - 1;
      }
      renderUpcomingWeekPager(listUp, 'No later shifts in the current 3-week window.');
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
      var q = String(messagesSearchQuery || '').trim();
      var threadRows = q ? threadsMatchingSearch() : threadsForMainScreen();
      var recipients = q ? recipientsMatchingSearch() : [];
      var parts = [];

      threadRows.forEach(function (t) {
        if (!t) return;
        var last = t.messages && t.messages.length ? t.messages[t.messages.length - 1] : null;
        var previewText = last ? String(last.body || '') : '';
        parts.push(
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
            escapeHtml(previewText) +
            '</span>' +
            '</button></li>'
        );
      });

      recipients.forEach(function (p) {
        if (!p || recipientHasMessagedThread(p)) return;
        parts.push(
          '<li>' +
            '<button type="button" class="emp-thread-row emp-thread-row--pick" data-emp-msg-recipient="' +
            escapeHtml(String(p.id)) +
            '" data-emp-msg-name="' +
            escapeHtml(p.name) +
            '" data-emp-msg-sub="' +
            escapeHtml(p.subtitle || '') +
            '">' +
            '<span class="emp-thread-name">' +
            escapeHtml(p.name) +
            '</span>' +
            '<span class="emp-thread-pick-hint">Start a conversation</span>' +
            '<span class="emp-thread-sub">' +
            escapeHtml(p.subtitle || '') +
            '</span>' +
            '</button></li>'
        );
      });

      if (!parts.length) {
        threadList.innerHTML =
          '<li class="emp-thread-empty"><p class="emp-shift-empty">' +
          (q
            ? 'No conversations or team members match your search.'
            : 'Type in the search box to find someone and start a conversation.') +
          '</p></li>';
        return;
      }

      threadList.innerHTML = parts.join('');
      threadList.querySelectorAll('[data-thread-id]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          openThread(btn.getAttribute('data-thread-id'));
        });
      });
      threadList.querySelectorAll('[data-emp-msg-recipient]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          ensureOpenThreadForRecipient({
            id: btn.getAttribute('data-emp-msg-recipient'),
            name: btn.getAttribute('data-emp-msg-name') || '',
            subtitle: btn.getAttribute('data-emp-msg-sub') || '',
          });
        });
      });
    }

    function threadById(id) {
      return store.threads.find(function (t) {
        return t.id === id;
      });
    }

    function formatMessageBubbleTime(iso) {
      if (!iso) return '';
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      var now = new Date();
      var sameDay =
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();
      if (sameDay) {
        return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      }
      return d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    }

    function renderChatMessages(thread) {
      if (!chatLog || !thread) return;
      if (!thread.messages || !thread.messages.length) {
        chatLog.innerHTML =
          '<p class="emp-chat-empty">No messages yet. Type below to send your first message.</p>';
        return;
      }
      chatLog.innerHTML = (thread.messages || [])
        .map(function (m) {
          var self = m.who === 'self';
          var timeLabel = formatMessageBubbleTime(m.at);
          return (
            '<div class="emp-msg ' +
            (self ? 'emp-msg--self' : 'emp-msg--peer') +
            '">' +
            '<p class="emp-msg-body">' +
            escapeHtml(m.body) +
            '</p>' +
            (timeLabel
              ? '<p class="emp-msg-time">' + escapeHtml(timeLabel) + '</p>'
              : '') +
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

    function populateSwapShiftOfferSelect() {
      if (!empSwapShiftOffer) return;
      var rows = allShiftsForSelect();
      if (!rows.length) {
        empSwapShiftOffer.innerHTML = '<option value="">No upcoming shifts available</option>';
        empSwapShiftOffer.disabled = true;
        return;
      }
      empSwapShiftOffer.disabled = false;
      empSwapShiftOffer.innerHTML =
        '<option value="">Choose a shift…</option>' +
        rows
          .map(function (r) {
            var label = r.day + ' · ' + (r.timeLabel || r.start + ' – ' + r.end) + ' · ' + r.restaurantName;
            var value =
              r.restaurantId + '|' + r.id + '|' + encodeURIComponent(r.day) + '|' + encodeURIComponent(r.timeLabel || '');
            return '<option value="' + escapeHtml(value) + '">' + escapeHtml(label) + '</option>';
          })
          .join('');
    }

    function populateAvailableSwapOffersSelect() {
      if (!empSwapAvailableShift) return;
      var offers = bridge.getOpenSwapOffers ? bridge.getOpenSwapOffers(WORKER) : [];
      if (!offers.length) {
        empSwapAvailableShift.innerHTML = '<option value="">No open shift swap offers</option>';
        empSwapAvailableShift.disabled = true;
        return;
      }
      empSwapAvailableShift.disabled = false;
      empSwapAvailableShift.innerHTML =
        '<option value="">Choose an offer…</option>' +
        offers
          .map(function (o) {
            var label = o.offeredShiftLabel + ' · offered by ' + o.employeeName;
            return '<option value="' + escapeHtml(o.id) + '">' + escapeHtml(label) + '</option>';
          })
          .join('');
    }

    function showRequestFeedback(msg) {
      if (!feedback) return;
      feedback.textContent = msg || '';
      feedback.hidden = !msg;
    }

    function showEmpRequestForm(formKey) {
      var map = {
        availability: 'empFormAvailability',
        timeoff: 'empFormTimeoff',
        swap: 'empFormSwap',
        callout_request: 'empFormCallout',
      };
      Object.keys(map).forEach(function (k) {
        var f = el(map[k]);
        if (f) f.hidden = k !== formKey;
      });
      document.querySelectorAll('[data-req-form]').forEach(function (c) {
        c.classList.toggle('active', c.getAttribute('data-req-form') === formKey);
      });
    }

    function renderAvailWeekChips() {
      if (!empAvailWeekChips) return;
      empAvailWeekChips.innerHTML = availWeekOptions
        .map(function (w, idx) {
          var active = idx === selectedAvailWeekIndex;
          return (
            '<button type="button" class="filter-chip' +
            (active ? ' active' : '') +
            '" data-avail-week-idx="' +
            idx +
            '" role="tab" aria-selected="' +
            (active ? 'true' : 'false') +
            '">' +
            escapeHtml(w.label) +
            '</button>'
          );
        })
        .join('');
    }

    function collectAvailabilityGridFromDom() {
      var out = {};
      if (!empAvailGrid) return out;
      empAvailGrid.querySelectorAll('input.availability-grid-cb').forEach(function (inp) {
        var wk = inp.getAttribute('data-wk');
        var sk = inp.getAttribute('data-slot-key');
        if (!wk || !sk) return;
        if (!out[wk]) out[wk] = {};
        out[wk][sk] = !!inp.checked;
      });
      return out;
    }

    function renderAvailabilityRequestGrid(roleCode) {
      if (!empAvailGrid || !bridge.getDefaultAvailabilityGridForRole || !bridge.renderAvailabilityGridEditor) return;
      if (!currentAvailGrid) currentAvailGrid = bridge.getDefaultAvailabilityGridForRole(roleCode);
      empAvailGrid.innerHTML = bridge.renderAvailabilityGridEditor(currentAvailGrid, roleCode);
    }

    function checkAllAvailabilityGrid() {
      if (!empAvailGrid) return;
      empAvailGrid.querySelectorAll('input.availability-grid-cb').forEach(function (inp) {
        inp.checked = true;
      });
      currentAvailGrid = collectAvailabilityGridFromDom();
    }

    function initAvailabilityRequestForm() {
      var roleCode = bridge.getWorkerRoleCode(WORKER);
      currentAvailGrid = bridge.getDefaultAvailabilityGridForRole
        ? bridge.getDefaultAvailabilityGridForRole(roleCode)
        : null;
      availWeekOptions = bridge.getAvailabilityWeekOptions ? bridge.getAvailabilityWeekOptions() : [];
      selectedAvailWeekIndex = 0;
      renderAvailWeekChips();
      renderAvailabilityRequestGrid(roleCode);
    }

    function initTimeoffDateRangeForm() {
      if (empTimeoffStartDate) empTimeoffStartDate.value = '';
      if (empTimeoffEndDate) empTimeoffEndDate.value = '';
      if (empTimeoffNote) empTimeoffNote.value = '';
    }

    function wireRequestForm(formId, getPayload) {
      var form = el(formId);
      if (!form) return;
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var payload = getPayload();
        if (!payload) return;
        bridge.submitEmployeeRequest(payload);
        if (formId === 'empFormAvailability') initAvailabilityRequestForm();
        else if (formId === 'empFormTimeoff') initTimeoffDateRangeForm();
        else form.reset();
        showRequestFeedback('Submitted. Your manager will see it under Actions.');
        setTimeout(function () {
          showRequestFeedback('');
        }, 4000);
      });
    }

    var roleCode = bridge.getWorkerRoleCode(WORKER);

    if (!employeeAppEventsBound) {
      employeeAppEventsBound = true;

      if (chatBackBtn) {
        chatBackBtn.addEventListener('click', function () {
          closeThreadView();
          renderThreadsList();
        });
      }

      if (messageSearchInput) {
        messageSearchInput.addEventListener('input', function () {
          messagesSearchQuery = String(this.value || '');
          renderThreadsList();
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
          renderThreadsList();
        });
      }

      wireRequestForm('empFormAvailability', function () {
        var weekOpt = availWeekOptions[selectedAvailWeekIndex];
        if (!weekOpt) return null;
        var roleCodeNow = bridge.getWorkerRoleCode(WORKER);
        var roleLine = bridge.getWorkerRoleLine(WORKER);
        var collected = collectAvailabilityGridFromDom();
        currentAvailGrid = collected;
        return {
          type: 'availability',
          employeeName: WORKER,
          role: roleCodeNow,
          summary: 'Availability update for ' + weekOpt.label + ' (' + roleLine + ').',
          submittedWeekLabel: weekOpt.label,
          submittedWeekIndex: weekOpt.weekIndex,
          submittedGrid: collected,
        };
      });

      wireRequestForm('empFormSwap', function () {
        var ta = el('empSwapDetails');
        var sel = empSwapShiftOffer;
        if (!sel || sel.disabled || !sel.value) {
          showRequestFeedback('Choose one of your upcoming shifts to offer.');
          return null;
        }
        var opt = sel.options[sel.selectedIndex];
        var note = (ta && ta.value) || '';
        var shiftLabel = opt ? opt.textContent : '';
        return {
          type: 'swap',
          employeeName: WORKER,
          role: roleCode,
          offeredShiftLabel: shiftLabel,
          summary:
            'Shift Swap Offer: ' +
            shiftLabel +
            (String(note).trim() ? '. Notes: ' + String(note).trim() : ''),
        };
      });

      wireRequestForm('empFormTimeoff', function () {
        var start = empTimeoffStartDate ? String(empTimeoffStartDate.value || '') : '';
        var end = empTimeoffEndDate ? String(empTimeoffEndDate.value || '') : '';
        var note = empTimeoffNote ? String(empTimeoffNote.value || '').trim() : '';
        if (!start || !end) return null;
        if (end < start) {
          showRequestFeedback('End date must be on or after start date.');
          return null;
        }
        return {
          type: 'timeoff',
          employeeName: WORKER,
          role: roleCode,
          summary: 'Time Off: ' + start + ' to ' + end + (note ? '. Notes: ' + note : ''),
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
          if (!t) return;
          showEmpRequestForm(t);
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
            populateSwapShiftOfferSelect();
            populateAvailableSwapOffersSelect();
            initAvailabilityRequestForm();
            initTimeoffDateRangeForm();
            showEmpRequestForm('availability');
            showRequestFeedback('');
          }
          showEmpNav(key);
        });
      });

      if (empAvailWeekChips) {
        empAvailWeekChips.addEventListener('click', function (e) {
          var btn = e.target.closest('[data-avail-week-idx]');
          if (!btn) return;
          var idx = parseInt(btn.getAttribute('data-avail-week-idx'), 10);
          if (Number.isNaN(idx) || idx < 0 || idx >= availWeekOptions.length) return;
          selectedAvailWeekIndex = idx;
          renderAvailWeekChips();
        });
      }

      if (empAvailCheckAllBtn) {
        empAvailCheckAllBtn.addEventListener('click', function () {
          checkAllAvailabilityGrid();
        });
      }

      if (empSwapAcceptBtn) {
        empSwapAcceptBtn.addEventListener('click', function () {
          if (!empSwapAvailableShift || empSwapAvailableShift.disabled || !empSwapAvailableShift.value) {
            showRequestFeedback('Choose an available shift offer to accept.');
            return;
          }
          var offerId = empSwapAvailableShift.value;
          var offerOpt = empSwapAvailableShift.options[empSwapAvailableShift.selectedIndex];
          var offerLabel = offerOpt ? offerOpt.textContent : '';
          var note = empSwapAcceptNote ? String(empSwapAcceptNote.value || '').trim() : '';
          bridge.submitEmployeeRequest({
            type: 'swap',
            employeeName: WORKER,
            role: roleCode,
            swapOfferId: offerId,
            summary:
              'Shift Swap Acceptance (manager approval): ' +
              offerLabel +
              (note ? '. Note: ' + note : ''),
          });
          if (empSwapAcceptNote) empSwapAcceptNote.value = '';
          populateAvailableSwapOffersSelect();
          showRequestFeedback('Submitted. Waiting for manager approval.');
          setTimeout(function () {
            showRequestFeedback('');
          }, 4000);
        });
      }

      if (upcomingPrevWeekBtn) {
        upcomingPrevWeekBtn.addEventListener('click', function () {
          if (upcomingWeekCursor <= 0) return;
          upcomingWeekCursor -= 1;
          renderUpcomingWeekPager(listUp, 'No later shifts in the current 3-week window.');
        });
      }

      if (upcomingNextWeekBtn) {
        upcomingNextWeekBtn.addEventListener('click', function () {
          if (upcomingWeekCursor >= upcomingWeekStarts.length - 1) return;
          upcomingWeekCursor += 1;
          renderUpcomingWeekPager(listUp, 'No later shifts in the current 3-week window.');
        });
      }
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
