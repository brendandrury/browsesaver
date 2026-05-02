// popup.js - Browsesaver
"use strict";

const browser = globalThis.browser || globalThis.chrome;

const $ = (sel) => document.querySelector(sel);

function setStatus(msg) {
  $("#status").textContent = msg;
}

async function sendBg(msg) {
  try {
    return await browser.runtime.sendMessage(msg);
  } catch (err) {
    console.error("Background message failed:", err);
    throw err;
  }
}

async function sendTab(tabId, msg) {
  try {
    return await browser.tabs.sendMessage(tabId, msg);
  } catch (err) {
    console.error("Tab message failed:", err);
    throw err;
  }
}

async function getActiveTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function refreshContext() {
  const tab = await getActiveTab();
  
  if (!tab) {
    $("#site").textContent = "No tab";
    $("#channel").textContent = "(no active tab)";
    $("#stats").textContent = "";
    return null;
  }
  
  // Detect site from URL
  const url = tab.url || "";
  let siteName = "Unknown";
  if (url.includes("discord.com")) {
    siteName = "Discord";
  } else if (url.includes("lmarena.ai")) {
    siteName = "LMArena";
  } else {
    $("#site").textContent = "Not supported";
    $("#channel").textContent = "(not on Discord or LMArena)";
    $("#stats").textContent = "";
    return null;
  }
  
  $("#site").textContent = siteName;
  
  try {
    const res = await sendTab(tab.id, { type: "GET_CONTEXT" });
    if (res?.ok && res.context) {
      const ctx = res.context;
      const displayName = ctx.channelName || ctx.channelKey || "Unknown";
      $("#channel").textContent = displayName;
      
      if (ctx.currentUser) {
        $("#channel").textContent += `\n(as ${ctx.currentUser})`;
      }
      
      const stats = await sendBg({ type: "GET_STATS", channelKey: ctx.channelKey });
      if (stats?.ok) {
        $("#stats").textContent = `${stats.count} messages saved (${stats.totalMessages} total)`;
      }
      
      return ctx;
    }
  } catch (err) {
    console.error("Failed to get context:", err);
  }
  
  $("#channel").textContent = "(content script not ready)";
  $("#stats").textContent = "";
  return null;
}

async function refreshLog() {
  try {
    const res = await sendBg({ type: "GET_LOG", n: 50 });
    if (res?.ok) {
      const lines = res.entries.map(e => {
        const time = new Date(e.ts).toISOString().slice(11, 19);
        return `[${time}] ${e.level}: ${e.msg}`;
      });
      $("#debugLog").textContent = lines.join("\n") || "(empty)";
    }
  } catch (err) {
    $("#debugLog").textContent = `Error: ${err.message}`;
  }
}

async function handleScan() {
  setStatus("Scanning...");
  const tab = await getActiveTab();
  if (!tab) return setStatus("No active tab");
  
  try {
    await sendTab(tab.id, { type: "SCAN_NOW" });
    setStatus("Scan complete");
    setTimeout(refreshContext, 500);
  } catch (err) {
    setStatus(`Scan failed: ${err.message}`);
  }
}

async function handleExport(format = "ndjson") {
  setStatus("Exporting...");
  
  const ctx = await refreshContext();
  if (!ctx) return setStatus("No context available");
  
  try {
    const res = await sendBg({ 
      type: "EXPORT_CHANNEL", 
      channelKey: ctx.channelKey,
      format 
    });
    if (res?.ok) {
      setStatus(`Exported to ${res.filename}`);
    } else {
      setStatus(`Export failed: ${res?.error || "Unknown error"}`);
    }
  } catch (err) {
    setStatus(`Export failed: ${err.message}`);
  }
  
  refreshLog();
}

async function handleFlush() {
  setStatus("Flushing...");
  try {
    await sendBg({ type: "FLUSH_SPOOL" });
    setStatus("Flush complete");
  } catch (err) {
    setStatus(`Flush failed: ${err.message}`);
  }
  refreshLog();
}

async function handleClear() {
  if (!confirm("Clear all saved messages from memory?")) return;
  
  setStatus("Clearing...");
  try {
    await sendBg({ type: "CLEAR_ALL" });
    setStatus("Cleared");
    refreshContext();
  } catch (err) {
    setStatus(`Clear failed: ${err.message}`);
  }
  refreshLog();
}

async function handleExportLog() {
  setStatus("Exporting log...");
  try {
    const res = await sendBg({ type: "EXPORT_DEBUG_LOG" });
    if (res?.ok) {
      setStatus(`Log exported`);
    } else {
      setStatus("Log export failed");
    }
  } catch (err) {
    setStatus(`Failed: ${err.message}`);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  $("#scanBtn").addEventListener("click", handleScan);
  $("#exportBtn").addEventListener("click", () => handleExport("ndjson"));
  $("#flushBtn").addEventListener("click", handleFlush);
  $("#clearBtn").addEventListener("click", handleClear);
  $("#exportLogBtn").addEventListener("click", handleExportLog);
  
  await refreshContext();
  await refreshLog();
  
  setInterval(() => {
    refreshContext();
    refreshLog();
  }, 3000);
});
