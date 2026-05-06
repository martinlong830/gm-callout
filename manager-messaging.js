(function () {
  'use strict';

  var CHAT_KEY = 'gm-callout-manager-messages-v1';

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
              body: 'Hey — want to trade a lunch shift next week? Let me know what works.',
              at: new Date().toISOString(),
            },
          ],
        },
        {
          id: 'alex',
          peerName: 'Alex R.',
          subtitle: 'Delivery/Dishwasher',
          messages: [
            {
              who: 'peer',
              body: 'Can you confirm Sat brunch coverage after the swap?',
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

  var managerMessagingBound = false;
  var store;
  var messagesSearchQuery = '';

  function getBridge() {
    return typeof window !== 'undefined' ? window.gmCalloutBridge : null;
  }

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
    if (!store || !Array.isArray(store.threads)) return [];
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
    var bridge = getBridge();
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

  function ensureOpenThreadForRecipient(recipient, threadList) {
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
    renderThreadsList(threadList);
    openThread(tid);
  }

  function renderThreadsList(threadList) {
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
          '<button type="button" class="emp-thread-row" data-mgr-thread-id="' +
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
          '<button type="button" class="emp-thread-row emp-thread-row--pick" data-mgr-msg-recipient="' +
          escapeHtml(String(p.id)) +
          '" data-mgr-msg-name="' +
          escapeHtml(p.name) +
          '" data-mgr-msg-sub="' +
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
          : 'Type in the search box to find a team member and start a conversation.') +
        '</p></li>';
      return;
    }

    threadList.innerHTML = parts.join('');
    threadList.querySelectorAll('[data-mgr-thread-id]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openThread(btn.getAttribute('data-mgr-thread-id'));
      });
    });
    threadList.querySelectorAll('[data-mgr-msg-recipient]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        ensureOpenThreadForRecipient(
          {
            id: btn.getAttribute('data-mgr-msg-recipient'),
            name: btn.getAttribute('data-mgr-msg-name') || '',
            subtitle: btn.getAttribute('data-mgr-msg-sub') || '',
          },
          threadList
        );
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

  function renderChatMessages(chatLog, thread) {
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
    var chatPanel = el('mgrChatPanel');
    var chatTitle = el('mgrChatTitle');
    var chatLog = el('mgrChatLog');
    var chatInput = el('mgrChatInput');
    var messagesLayout = el('mgrMessagesLayout');
    if (!thread || !chatPanel) return;
    store.activeThreadId = id;
    saveChatStore(store);
    chatPanel.hidden = false;
    if (messagesLayout) messagesLayout.classList.add('emp-messages-layout--chat-open');
    if (chatTitle) chatTitle.textContent = thread.peerName;
    renderChatMessages(chatLog, thread);
    if (chatInput) chatInput.focus();
  }

  function closeThreadView() {
    store.activeThreadId = null;
    saveChatStore(store);
    var chatPanel = el('mgrChatPanel');
    var messagesLayout = el('mgrMessagesLayout');
    if (chatPanel) chatPanel.hidden = true;
    if (messagesLayout) messagesLayout.classList.remove('emp-messages-layout--chat-open');
  }

  function closeMessagesToList() {
    closeThreadView();
    renderThreadsList(el('mgrThreadList'));
  }

  function init() {
    if (!document.documentElement.classList.contains('manager-app')) return;
    if (document.documentElement.classList.contains('employee-app')) return;

    store = loadChatStore();
    var threadList = el('mgrThreadList');
    var chatPanel = el('mgrChatPanel');
    var chatLog = el('mgrChatLog');
    var chatForm = el('mgrChatForm');
    var chatInput = el('mgrChatInput');
    var messageSearchInput = el('mgrMessageSearch');
    var chatBackBtn = el('mgrChatBack');

    renderThreadsList(threadList);

    if (!managerMessagingBound) {
      managerMessagingBound = true;
      if (chatBackBtn) {
        chatBackBtn.addEventListener('click', function () {
          closeThreadView();
          renderThreadsList(threadList);
        });
      }
      if (messageSearchInput) {
        messageSearchInput.addEventListener('input', function () {
          messagesSearchQuery = String(this.value || '');
          renderThreadsList(threadList);
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
          renderChatMessages(chatLog, thread);
          renderThreadsList(el('mgrThreadList'));
        });
      }
    }
  }

  function refreshUi() {
    if (!document.documentElement.classList.contains('manager-app')) return;
    if (document.documentElement.classList.contains('employee-app')) return;
    store = loadChatStore();
    closeThreadView();
    renderThreadsList(el('mgrThreadList'));
  }

  window.gmCalloutManagerMessagingBootstrap = init;
  window.gmCalloutManagerMessagesRefreshUi = refreshUi;
  window.gmCalloutManagerCloseMessagesToList = closeMessagesToList;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
