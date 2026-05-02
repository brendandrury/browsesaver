// background.js - Browsesaver
"use strict";

const browser = globalThis.browser || globalThis.chrome;

// =============================================================================
// State
// =============================================================================
const state = {
  messages: new Map(),
  channels: new Map(),
  spoolBuffer: [],
  settings: {
    enabled: true,      // Start disabled - user must explicitly enable
    autoSpool: true,
    spoolDelayMs: 3000
  }
};

let spoolTimerId = null;

// Always enabled

// =============================================================================
// Logging
// =============================================================================
const logBuffer = [];
const LOG_MAX = 500;

function log(level, msg, data = null) {
  const entry = { ts: Date.now(), level, msg, data };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_MAX) logBuffer.shift();
  
  const prefix = `[Browsesaver][${level.toUpperCase()}]`;
  if (data) {
    console.log(prefix, msg, data);
  } else {
    console.log(prefix, msg);
  }
}

function getLogTail(n = 100) {
  return logBuffer.slice(-Math.min(n, LOG_MAX));
}

// =============================================================================
// Helpers
// =============================================================================
function sanitizeFilename(s) {
  return String(s || "unknown")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || "unknown";
}

// =============================================================================
// Message Storage
// =============================================================================
function upsertChannel(meta) {
  if (!meta || !meta.channelKey) return;
  state.channels.set(meta.channelKey, {
    ...meta,
    lastSeen: Date.now()
  });
}

function upsertMessages(messages) {
  const newMessages = [];
  
  for (const msg of messages) {
    if (!msg || !msg.messageId || !msg.channelKey) continue;
    
    let channelMap = state.messages.get(msg.channelKey);
    if (!channelMap) {
      channelMap = new Map();
      state.messages.set(msg.channelKey, channelMap);
    }
    
    const existing = channelMap.get(msg.messageId);
    if (!existing) {
      channelMap.set(msg.messageId, msg);
      newMessages.push(msg);
    } else {
      // Re-emit on meaningful changes
      const contentGrew = (msg.contentText || "").length > (existing.contentText || "").length;
      const moreAttachments = (msg.attachments || []).length > (existing.attachments || []).length;
      const reactionsChanged = JSON.stringify(msg.reactions || []) !== JSON.stringify(existing.reactions || []);
      const newlyEdited = msg.edited && !existing.edited;
      if (contentGrew || moreAttachments || reactionsChanged || newlyEdited) {
        channelMap.set(msg.messageId, { ...existing, ...msg });
        newMessages.push({ ...existing, ...msg });
      }
    }
  }
  
  return newMessages;
}

function getChannelMessages(channelKey) {
  const channelMap = state.messages.get(channelKey);
  if (!channelMap) return [];
  
  return Array.from(channelMap.values()).sort((a, b) => {
    const ta = a.timestampMs || 0;
    const tb = b.timestampMs || 0;
    return ta - tb || String(a.messageId).localeCompare(String(b.messageId));
  });
}

function getChannelCount(channelKey) {
  const channelMap = state.messages.get(channelKey);
  return channelMap ? channelMap.size : 0;
}

function clearAll() {
  state.messages.clear();
  state.channels.clear();
  state.spoolBuffer = [];
  log("info", "Cleared all data");
}

// =============================================================================
// Download
// =============================================================================
async function downloadFile(filename, content) {
  try {
    const blob = new Blob([content], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    
    const downloadId = await browser.downloads.download({
      url: url,
      filename: filename,
      saveAs: false,
      conflictAction: "uniquify"
    });
    
    setTimeout(() => {
      try { URL.revokeObjectURL(url); } catch (e) {}
    }, 60000);
    
    log("info", "Download started", { downloadId, filename });
    return { ok: true, downloadId, filename };
  } catch (err) {
    log("error", "Download failed", { filename, error: err.message });
    return { ok: false, error: err.message };
  }
}

// =============================================================================
// Spooling
// =============================================================================
function enqueueForSpool(messages) {
  if (!state.settings.enabled || !state.settings.autoSpool) return;
  
  state.spoolBuffer.push(...messages);
  
  if (!spoolTimerId) {
    spoolTimerId = setTimeout(flushSpool, state.settings.spoolDelayMs);
  }
}

async function flushSpool() {
  spoolTimerId = null;
  
  if (state.spoolBuffer.length === 0) return;
  
  const batch = state.spoolBuffer;
  state.spoolBuffer = [];
  
  const byChannel = new Map();
  for (const msg of batch) {
    const key = msg.channelKey;
    if (!byChannel.has(key)) byChannel.set(key, []);
    byChannel.get(key).push(msg);
  }
  
  for (const [channelKey, msgs] of byChannel) {
    const meta = state.channels.get(channelKey) || {};
    const channelName = sanitizeFilename(meta.channelName || channelKey);
    
    const ndjson = msgs.map(m => JSON.stringify(m)).join("\n") + "\n";

    const currentUser = msgs[0]?.currentUser || "unknown";
    const safeUser = sanitizeFilename(currentUser);
    const filename = `Browsesaver/spool/${safeUser}/${channelName}/${Date.now()}.ndjson`;
    
    await downloadFile(filename, ndjson);
    log("info", "Spooled messages", { channelKey, count: msgs.length, filename });
  }
}

// =============================================================================
// Export Functions
// =============================================================================
async function exportChannel(channelKey, format = "ndjson") {
  const msgs = getChannelMessages(channelKey);
  if (msgs.length === 0) {
    return { ok: false, error: "No messages to export" };
  }
  
  const meta = state.channels.get(channelKey) || {};
  const channelName = sanitizeFilename(meta.channelName || channelKey);
  const accountKey = sanitizeFilename(meta.accountKey || "default");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  
  let content, ext;
  if (format === "txt") {
    content = formatAsText(msgs, meta);
    ext = "txt";
  } else {
    content = msgs.map(m => JSON.stringify(m)).join("\n") + "\n";
    ext = "ndjson";
  }
  
  const filename = `Browsesaver/export/${accountKey}/${channelName}_${timestamp}.${ext}`;
  return downloadFile(filename, content);
}

function formatAsText(msgs, meta) {
  const lines = [
    `# Browsesaver Export`,
    `# Channel: ${meta.channelName || "Unknown"}`,
    `# Exported: ${new Date().toISOString()}`,
    `# Messages: ${msgs.length}`,
    ``
  ];
  
  for (const msg of msgs) {
    const time = msg.timestampMs 
      ? new Date(msg.timestampMs).toLocaleString()
      : "Unknown time";
    let header = `[${time}] ${msg.author || "Unknown"}`;
    if (msg.edited) header += " (edited)";
    lines.push(header);
    if (msg.replyTo) {
      lines.push(`  > replying to ${msg.replyTo.author}: ${msg.replyTo.content}`);
    }
    if (msg.contentText) lines.push(msg.contentText);
    if (msg.attachments && msg.attachments.length) {
      for (const att of msg.attachments) {
        lines.push(`  [Attachment: ${att.filename || "file"}: ${att.url || ""}]`);
      }
    }
    if (msg.reactions && msg.reactions.length) {
      lines.push("  [Reactions: " + msg.reactions.map(r => r.emoji + " x" + r.count).join(", ") + "]");
    }
    lines.push("");
  }
  
  return lines.join("\n");
}

async function exportDebugLog() {
  const lines = getLogTail(500).map(e => {
    const time = new Date(e.ts).toISOString();
    const data = e.data ? " " + JSON.stringify(e.data) : "";
    return `${time} [${e.level}] ${e.msg}${data}`;
  });
  
  const filename = `Browsesaver/debug/log_${Date.now()}.txt`;
  return downloadFile(filename, lines.join("\n") + "\n");
}

// =============================================================================
// Broadcast enabled state to all Discord tabs
// =============================================================================
async function broadcastEnabledState() {
  try {
    const tabs = await browser.tabs.query({ url: ["*://discord.com/*", "*://ptb.discord.com/*", "*://canary.discord.com/*"] });
    for (const tab of tabs) {
      try {
        await browser.tabs.sendMessage(tab.id, { type: "SET_ENABLED", enabled: state.settings.enabled });
      } catch (e) {
        // Tab might not have content script loaded
      }
    }
  } catch (e) {
    log("warn", "Failed to broadcast enabled state", { error: e.message });
  }
}

// =============================================================================
// Message Handler
// =============================================================================
browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.type) return;
  
  const accountKey = sender?.tab?.cookieStoreId || "default";
  
  switch (msg.type) {
    case "PING":
      return Promise.resolve({ ok: true, ts: Date.now() });
    
    case "GET_ENABLED":
      return Promise.resolve({ ok: true, enabled: state.settings.enabled });
    
    case "UPSERT_CHANNEL":
      // Always process
      upsertChannel({ ...msg.meta, accountKey });
      return Promise.resolve({ ok: true });
    
    case "UPSERT_MESSAGES": {
      // Always process messages
      
      const messages = (msg.messages || []).map(m => ({ 
        ...m, 
        accountKey,
        currentUser: m.currentUser || null 
      }));
      const newMsgs = upsertMessages(messages);
      
      log("debug", "Upserted messages", {
        received: messages.length,
        new: newMsgs.length,
        channelKey: msg.channelKey
      });
      
      if (newMsgs.length > 0) {
        enqueueForSpool(newMsgs);
      }
      
      return Promise.resolve({ 
        ok: true, 
        received: messages.length, 
        new: newMsgs.length 
      });
    }
    
    case "GET_STATS":
      return Promise.resolve({
        ok: true,
        count: getChannelCount(msg.channelKey),
        totalChannels: state.channels.size,
        totalMessages: Array.from(state.messages.values())
          .reduce((sum, m) => sum + m.size, 0)
      });
    
    case "GET_LOG":
      return Promise.resolve({ ok: true, entries: getLogTail(msg.n || 100) });
    
    case "GET_SETTINGS":
      return Promise.resolve({ ok: true, settings: state.settings });
    
    case "SET_SETTINGS": {
      const oldEnabled = state.settings.enabled;
      Object.assign(state.settings, msg.settings || {});
      log("info", "Settings updated", state.settings);
      
      // Broadcast if enabled state changed
      if (oldEnabled !== state.settings.enabled) {
        broadcastEnabledState();
        // Persist to storage
        // Storage disabled
      }
      
      return Promise.resolve({ ok: true, settings: state.settings });
    }
    
    case "EXPORT_CHANNEL":
      return exportChannel(msg.channelKey, msg.format || "ndjson");
    
    case "EXPORT_DEBUG_LOG":
      return exportDebugLog();
    
    case "FLUSH_SPOOL":
      return flushSpool().then(() => ({ ok: true }));
    
    case "CLEAR_ALL":
      clearAll();
      return Promise.resolve({ ok: true });
    
    default:
      return Promise.resolve({ ok: false, error: "Unknown message type" });
  }
});

log("info", "Background script loaded");
