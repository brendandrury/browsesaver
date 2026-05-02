// content.js - Browsesaver
"use strict";

const browser = globalThis.browser || globalThis.chrome;

// =============================================================================
// State
// =============================================================================
let currentContext = null;
let arenaSessionId = null;
let lastArenaUrl = null;
const seenMessages = new Map();
const contentTimestamps = new Map(); // key -> {sig, firstSeen}
let pendingMessages = [];
let flushTimer = null;

const STABLE_MS = 500;

function log(level, msg, data) {
  console.log(`[Browsesaver][${level.toUpperCase()}]`, msg, data || '');
}

// =============================================================================
// Site Detection
// =============================================================================
function isLMArena() { return location.hostname === 'lmarena.ai' || location.hostname === 'arena.ai'; }
function isDiscord() { return location.hostname.includes('discord.com'); }

function getArenaSessionIdFromUrl() {
  const match = location.pathname.match(/\/c\/([a-f0-9-]+)/i);
  return match ? match[1] : null;
}

// =============================================================================
// Text Extraction
// =============================================================================
function extractMarkdown(node) {
  if (!node) return "";
  let result = "";
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      result += child.textContent;
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = child.tagName.toLowerCase();
      const inner = extractMarkdown(child);
      switch (tag) {
        case 's': case 'del': result += '~~' + inner + '~~'; break;
        case 'strong': case 'b': result += '**' + inner + '**'; break;
        case 'em': case 'i': result += '*' + inner + '*'; break;
        case 'u': result += '__' + inner + '__'; break;
        case 'code': result += '`' + inner + '`'; break;
        case 'pre': result += '```\n' + child.textContent + '\n```'; break;
        case 'br': result += '\n'; break;
        case 'img': result += child.getAttribute('alt') || ''; break;
        default: result += inner;
      }
    }
  }
  return result;
}

function extractArenaProseText(proseEl) {
  if (!proseEl) return "";
  
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    
    const tag = node.tagName.toLowerCase();
    let inner = "";
    for (const c of node.childNodes) inner += walk(c);
    
    switch (tag) {
      case 'h1': return '# ' + inner.trim() + '\n\n';
      case 'h2': return '## ' + inner.trim() + '\n\n';
      case 'h3': return '### ' + inner.trim() + '\n\n';
      case 'h4': return '#### ' + inner.trim() + '\n\n';
      case 'p': return inner.trim() + '\n\n';
      case 'li': return '- ' + inner.trim() + '\n';
      case 'ul': case 'ol': return inner + '\n';
      case 'strong': case 'b': return '**' + inner + '**';
      case 'em': case 'i': return '*' + inner + '*';
      case 'code': return '`' + inner + '`';
      case 'pre': return '```\n' + node.textContent.trim() + '\n```\n\n';
      case 'hr': return '\n---\n\n';
      case 'br': return '\n';
      default: return inner;
    }
  }
  
  return walk(proseEl).replace(/\n{3,}/g, '\n\n').trim();
}

// =============================================================================
// Discord Support
// =============================================================================
function getCurrentUser() {
  if (isLMArena()) return 'user';
  const userArea = document.querySelector('section[aria-label="User area"]');
  const avatarLabel = userArea?.querySelector('[aria-label*=","]')?.getAttribute('aria-label');
  return avatarLabel ? avatarLabel.split(',')[0].trim() : null;
}

function parseDiscordContext() {
  const parts = location.pathname.split("/").filter(Boolean);
  if (parts[0] !== "channels" || parts.length < 3) return null;
  const guildId = parts[1], channelId = parts[2], threadId = parts[3] || null;
  const channelKey = threadId ? `${guildId}:${channelId}:${threadId}` : `${guildId}:${channelId}`;
  let channelName = (document.title || "").split(" - ")[0].replace(/^#/, "").trim();
  return { guildId, channelId, threadId, channelKey, channelName, currentUser: getCurrentUser() };
}

function updateDiscordContext() {
  const newContext = parseDiscordContext();
  if (!currentContext || currentContext.channelKey !== newContext?.channelKey) {
    currentContext = newContext;
    if (currentContext) sendToBackground({ type: "UPSERT_CHANNEL", meta: currentContext });
  }
  return currentContext;
}

function snowflakeToTimestamp(id) {
  try { return Number((BigInt(id) >> 22n) + 1420070400000n); } catch { return 0; }
}

function extractMessageId(el) {
  const m1 = (el.id || "").match(/^chat-messages-\d+-(\d{17,22})$/);
  if (m1) return m1[1];
  const m2 = (el.getAttribute("data-list-item-id") || "").match(/chat-messages___(\d{17,22})/);
  return m2 ? m2[1] : null;
}

function extractTimestamp(el, messageId) {
  const timeEl = el.querySelector("time[datetime]");
  if (timeEl) { const ms = Date.parse(timeEl.getAttribute("datetime")); if (!isNaN(ms)) return ms; }
  return messageId ? snowflakeToTimestamp(messageId) : 0;
}

function extractAuthor(el) {
  // Scope to main contents area to avoid reply context author
  const contents = el.querySelector('[class*="contents_"]');
  const scope = contents || el;
  for (const sel of ['[id^="message-username-"] span[data-text]', '[id^="message-username-"]', 'span[data-text]']) {
    const node = scope.querySelector(sel);
    const text = node?.getAttribute('data-text') || node?.textContent?.trim();
    if (text && text.length > 0 && text.length < 100) return text;
  }
  // Fallback for continuation messages: resolve via aria-labelledby
  const article = el.querySelector('[role="article"]') || el;
  const labelledBy = article.getAttribute('aria-labelledby') || '';
  const usernameIdMatch = labelledBy.match(/message-username-\d+/);
  if (usernameIdMatch) {
    const refEl = document.getElementById(usernameIdMatch[0]);
    if (refEl) {
      const text = refEl.querySelector('span[data-text]')?.getAttribute('data-text') || refEl.textContent?.trim();
      if (text && text.length > 0 && text.length < 100) return text;
    }
  }
  return "Unknown";
}

function extractContent(el) {
  // Scope to contents area to avoid reply context content
  const contents = el.querySelector('[class*="contents_"]');
  const scope = contents || el;
  for (const sel of ['[id^="message-content-"]', '[class*="messageContent_"]']) {
    const node = scope.querySelector(sel);
    if (node) {
      // Clone and remove UI elements (edited indicator, hidden timestamps)
      const clone = node.cloneNode(true);
      clone.querySelectorAll('[class*="timestamp_"], [class*="hiddenVisually_"]').forEach(e => e.remove());
      return extractMarkdown(clone).trim();
    }
  }
  return "";
}

function extractAttachments(el) {
  const attachments = [], seen = new Set();
  // Find file attachments and images via CDN links
  const selectors = [
    'a[href*="cdn.discordapp.com/attachments"]',
    'a[href*="media.discordapp.net/attachments"]'
  ];
  for (const sel of selectors) {
    for (const link of el.querySelectorAll(sel)) {
      if (link.closest('[class*="repliedMessage"]')) continue;
      const url = link.href;
      if (!seen.has(url)) {
        seen.add(url);
        const filename = url.split("/").pop()?.split("?")[0] || "file";
        attachments.push({ url, filename });
      }
    }
  }
  return attachments;
}

function extractReplyContext(el) {
  const replyEl = el.querySelector('[class*="repliedMessage_"]');
  if (!replyEl) return null;
  const authorEl = replyEl.querySelector('[class*="username_"]');
  const author = authorEl?.getAttribute('data-text') || authorEl?.textContent?.trim() || "Unknown";
  const contentEl = replyEl.querySelector('[class*="repliedTextContent_"]');
  const content = contentEl ? extractMarkdown(contentEl).trim() : "";
  return { author, content };
}

function extractReactions(el) {
  const reactions = [];
  const container = el.querySelector('[class*="reactions_"][role="group"]');
  if (!container) return reactions;
  for (const reaction of container.querySelectorAll('[class*="reaction_"]:not([class*="reactionBtn"])')) {
    const inner = reaction.querySelector('[class*="reactionInner_"]');
    if (!inner) continue;
    const emojiEl = inner.querySelector('img.emoji') || inner.querySelector('[data-name]');
    const emoji = emojiEl?.getAttribute('alt') || emojiEl?.getAttribute('data-name') || "?";
    const countEl = inner.querySelector('[class*="reactionCount"]');
    const count = parseInt(countEl?.textContent || "1", 10);
    reactions.push({ emoji, count });
  }
  return reactions;
}

function parseDiscordMessage(el) {
  const messageId = extractMessageId(el);
  if (!messageId || !currentContext) return null;
  const contentText = extractContent(el);
  const attachments = extractAttachments(el);
  const replyTo = extractReplyContext(el);
  const reactions = extractReactions(el);
  const edited = !!el.querySelector('[class*="edited_"]');
  if (!contentText && !attachments.length) return null;
  // Signature-based dedup: re-emit on content/attachment/reaction/edit changes
  const sig = contentText.length + "|" + attachments.length + "|" + reactions.map(r => r.emoji + r.count).join(",") + "|" + (edited ? "e" : "");
  const prev = seenMessages.get(messageId);
  if (prev === sig) return null;
  seenMessages.set(messageId, sig);
  return {
    messageId, channelKey: currentContext.channelKey, guildId: currentContext.guildId,
    channelId: currentContext.channelId, threadId: currentContext.threadId,
    channelName: currentContext.channelName, currentUser: currentContext.currentUser,
    timestampMs: extractTimestamp(el, messageId), author: extractAuthor(el),
    contentText, attachments, replyTo, reactions, edited,
    capturedAt: Date.now(), source: 'discord'
  };
}

function scanDiscordMessages() {
  const container = document.querySelector('ol[data-list-id="chat-messages"]');
  if (!container) return;
  updateDiscordContext();
  if (!currentContext) return;
  const newMessages = [];
  for (const el of container.querySelectorAll('li[id^="chat-messages-"]')) {
    const msg = parseDiscordMessage(el);
    if (msg) newMessages.push(msg);
  }
  if (newMessages.length) enqueue(newMessages);
}

// =============================================================================
// LMArena Support
// =============================================================================
let arenaContext = null;


function isArenaStreaming() {
  // The spinning loader appears next to model name while generating
  // It has animate-spin class and contains a canvas
  const chatArea = document.getElementById('chat-area');
  if (!chatArea) return false;
  
  const spinner = chatArea.querySelector('.animate-spin canvas');
  return spinner !== null;
}

function getArenaModelName() {
  const chatArea = document.getElementById('chat-area');
  if (chatArea) {
    const truncate = chatArea.querySelector('span.truncate');
    if (truncate) return truncate.textContent?.trim() || 'unknown';
  }
  return 'unknown-model';
}

function resetArenaState() {
  arenaContext = null;
  arenaSessionId = null;
  for (const key of seenMessages.keys()) {
    if (key.startsWith('_arena_')) seenMessages.delete(key);
  }
  contentTimestamps.clear();
}

function initArenaContext(sessionId) {
  const modelName = getArenaModelName();
  arenaContext = {
    guildId: 'lmarena',
    channelId: sessionId,
    threadId: null,
    channelKey: `lmarena:${sessionId}`,
    channelName: `LMArena - ${modelName} - ${sessionId}`,
    currentUser: 'user'
  };
  arenaSessionId = sessionId;
  log("info", "Arena context init", { sessionId, modelName });
  sendToBackground({ type: "UPSERT_CHANNEL", meta: arenaContext });
}

function parseArenaMessages() {
  const chatArea = document.getElementById('chat-area');
  if (!chatArea) return [];
  
  const chatOl = chatArea.querySelector('ol');
  if (!chatOl) return [];
  
  const isReversed = chatOl.className.includes('flex-col-reverse');
  let children = Array.from(chatOl.children).filter(c => !c.classList.contains('h-0') && c.tagName !== 'H2');
  if (isReversed) children = children.reverse();
  
  const messages = [];
  
  for (const child of children) {
    const isUser = child.querySelector(':scope > .group.self-end') !== null
                || child.classList.contains('self-end')
                || (child.classList.contains('group') && child.querySelector('.self-end .prose'));
    const isAssistant = child.classList.contains('bg-surface-primary')
                     || child.querySelector(':scope > .bg-surface-primary') !== null;
    
    let contentText = null;
    let author = 'user';
    
    if (isUser) {
      const userBubble = child.querySelector('.self-end .prose') 
                      || child.querySelector('.bg-surface-tertiary .prose')
                      || child.querySelector('.prose');
      contentText = userBubble ? extractArenaProseText(userBubble) : null;
    } else if (isAssistant) {
      author = getArenaModelName();
      
      let thinkingText = null;
      const thinkingSection = child.querySelector('[data-state] .space-y-4.font-mono');
      if (thinkingSection) thinkingText = extractArenaProseText(thinkingSection);
      
      let responseText = null;
      for (const prose of child.querySelectorAll('.prose')) {
        if (prose.closest('.font-mono')) continue;
        if (prose.closest('[id^="radix-"]')) continue;
        const text = extractArenaProseText(prose);
        if (text && text.length > 0) { responseText = text; break; }
      }
      
      if (thinkingText && responseText) {
        contentText = `[Thinking]\n${thinkingText}\n\n[Response]\n${responseText}`;
      } else {
        contentText = responseText;
      }
    }
    
    if (contentText && contentText.length >= 2) {
      messages.push({ author, content: contentText });
    }
  }
  
  return messages;
}

function scanArenaMessages() {
  const currentUrl = location.href;
  const urlSessionId = getArenaSessionIdFromUrl();
  
  if (currentUrl !== lastArenaUrl || urlSessionId !== arenaSessionId) {
    log("info", "Arena URL/session changed", { urlSessionId, arenaSessionId });
    lastArenaUrl = currentUrl;
    if (urlSessionId !== arenaSessionId) {
      resetArenaState();
      if (urlSessionId) initArenaContext(urlSessionId);
    }
  }
  
  if (!urlSessionId || !arenaContext) return;
  
  const messages = parseArenaMessages();
  if (!messages.length) return;
  
  // Skip if still streaming
  if (isArenaStreaming()) {
    log("debug", "Still streaming...");
    return;
  }
  
  // Stability check: only send messages unchanged for STABLE_MS
  const now = Date.now();
  const stableMessages = [];
  
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const key = `${arenaSessionId}-${i}`;
    const sig = m.content.slice(-100) + '|' + m.content.length;
    
    const prev = contentTimestamps.get(key);
    
    if (!prev || prev.sig !== sig) {
      contentTimestamps.set(key, { sig, firstSeen: now });
      if (m.author === 'user') stableMessages.push({ ...m, idx: i });
    } else if (now - prev.firstSeen >= STABLE_MS) {
      stableMessages.push({ ...m, idx: i });
    }
  }
  
  if (!stableMessages.length) return;
  
  const finalSig = stableMessages.map(m => m.author[0] + m.content.length).join(',');
  const sigKey = `_arena_${arenaSessionId}`;
  if (seenMessages.get(sigKey) === finalSig) return;
  seenMessages.set(sigKey, finalSig);
  
  log("info", `Arena: sending ${stableMessages.length} stable of ${messages.length}`);
  
  const final = stableMessages.map(m => ({
    messageId: `${arenaSessionId}-${String(m.idx+1).padStart(4,'0')}`,
    turnIndex: m.idx + 1,
    channelKey: arenaContext.channelKey,
    guildId: 'lmarena',
    channelId: arenaContext.channelId,
    threadId: null,
    channelName: arenaContext.channelName,
    currentUser: 'user',
    timestampMs: m.idx + 1,
    author: m.author,
    contentText: m.content,
    attachments: [],
    capturedAt: Date.now(),
    source: 'lmarena'
  }));
  
  enqueue(final);
}

function forceSendArenaMessages() {
  if (!arenaContext) {
    const sessionId = getArenaSessionIdFromUrl();
    if (sessionId) initArenaContext(sessionId);
  }
  if (!arenaContext) return;
  
  contentTimestamps.clear();
  seenMessages.delete(`_arena_${arenaSessionId}`);
  
  const messages = parseArenaMessages();
  if (!messages.length) return;
  
  log("info", `Force-sending ${messages.length} messages`);
  
  const final = messages.map((m, i) => ({
    messageId: `${arenaSessionId}-${String(i+1).padStart(4,'0')}`,
    turnIndex: i + 1,
    channelKey: arenaContext.channelKey,
    guildId: 'lmarena',
    channelId: arenaContext.channelId,
    threadId: null,
    channelName: arenaContext.channelName,
    currentUser: 'user',
    timestampMs: i + 1,
    author: m.author,
    contentText: m.content,
    attachments: [],
    capturedAt: Date.now(),
    source: 'lmarena'
  }));
  
  enqueue(final);
}

// =============================================================================
// Queue & Background
// =============================================================================
function enqueue(messages) {
  pendingMessages.push(...messages);
  if (!flushTimer) flushTimer = setTimeout(flush, 500);
}

async function flush() {
  flushTimer = null;
  if (!pendingMessages.length) return;
  const batch = pendingMessages;
  pendingMessages = [];
  try {
    await sendToBackground({ type: "UPSERT_MESSAGES", channelKey: arenaContext?.channelKey || currentContext?.channelKey || "", messages: batch });
  } catch (e) {
    pendingMessages = batch.concat(pendingMessages);
    flushTimer = setTimeout(flush, 2000);
  }
}

async function sendToBackground(msg) { return browser.runtime.sendMessage(msg); }

// =============================================================================
// Observers
// =============================================================================
let observer = null;

function setupDiscordObserver() {
  const container = document.querySelector('ol[data-list-id="chat-messages"]');
  if (!container) return false;
  if (observer) observer.disconnect();
  observer = new MutationObserver(() => scanDiscordMessages());
  observer.observe(container, { childList: true, subtree: true });
  return true;
}

function setupArenaObserver() {
  const container = document.getElementById('chat-area');
  if (!container) return false;
  if (observer) observer.disconnect();
  observer = new MutationObserver(() => scanArenaMessages());
  observer.observe(container, { childList: true, subtree: true });
  log("info", "Arena observer on #chat-area");
  return true;
}

// =============================================================================
// Message Handler
// =============================================================================
browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === "GET_CONTEXT") {
    return Promise.resolve({ ok: true, context: isLMArena() ? arenaContext : currentContext, site: isLMArena() ? 'lmarena' : 'discord' });
  }
  if (msg.type === "SCAN_NOW") {
    if (isLMArena()) forceSendArenaMessages();
    else scanDiscordMessages();
    return Promise.resolve({ ok: true });
  }
});

// =============================================================================
// Init
// =============================================================================
function init() {
  log("info", "Init", { url: location.href, site: isLMArena() ? 'lmarena' : 'discord' });
  lastArenaUrl = location.href;
  
  if (isLMArena()) {
    const sessionId = getArenaSessionIdFromUrl();
    if (sessionId) initArenaContext(sessionId);
    
    let attempts = 0;
    const trySetup = () => {
      attempts++;
      if (setupArenaObserver()) scanArenaMessages();
      else if (attempts < 30) setTimeout(trySetup, 500);
    };
    setTimeout(trySetup, 500);
    setInterval(scanArenaMessages, 2000);
  } else if (isDiscord()) {
    updateDiscordContext();
    let attempts = 0;
    const trySetup = () => {
      attempts++;
      if (setupDiscordObserver()) scanDiscordMessages();
      else if (attempts < 20) setTimeout(trySetup, 500);
    };
    setTimeout(trySetup, 500);
    setInterval(() => {
      const oldKey = currentContext?.channelKey;
      updateDiscordContext();
      if (currentContext?.channelKey !== oldKey) { setupDiscordObserver(); scanDiscordMessages(); }
    }, 1000);
  }
}

init();

window.debugBrowsesaver = function() {
  console.log("URL:", location.href);
  console.log("Session:", arenaSessionId);
  console.log("Context:", arenaContext || currentContext);
  console.log("Timestamps:", Array.from(contentTimestamps.entries()));
};
