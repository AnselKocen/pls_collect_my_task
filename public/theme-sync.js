(function (global) {
  'use strict';

  // Shared by the journal and its separate cat-room page. Passive receivers
  // update their view only; the page where the user chose a theme saves it.
  const storageKey = 'memo:theme-selection:v1';
  const source = global.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
  const listeners = new Set();
  let lastTimestamp = 0, lastSignature = '', channel = null;
  const clean = value => {
    if (!value || typeof value !== 'object' || !/^[a-z]{1,24}$/.test(value.theme || '')) return null;
    const result = {theme: value.theme};
    if (value.customColors && typeof value.customColors === 'object') {
      const colors = {};
      for (const key of ['bg', 'card', 'accent', 'text', 'border', 'deco']) {
        if (/^#[\da-f]{6}$/i.test(value.customColors[key] || '')) colors[key] = value.customColors[key];
      }
      if (Object.keys(colors).length === 6) result.customColors = colors;
    }
    return result;
  };
  function read() {
    try { return clean(JSON.parse(global.localStorage.getItem(storageKey))); }
    catch { return null; }
  }
  function receive(value) {
    const selection = clean(value);
    if (!selection || value.source === source) return;
    const signature = JSON.stringify(selection), timestamp = Number(value.updatedAt) || 0;
    if (timestamp < lastTimestamp || signature === lastSignature) return;
    lastTimestamp = timestamp; lastSignature = signature;
    listeners.forEach(listener => listener(selection));
  }
  function publish(value) {
    const selection = clean(value);
    if (!selection) return;
    const signature = JSON.stringify(selection);
    if (signature === lastSignature) return;
    lastSignature = signature;
    lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
    const message = {...selection, updatedAt: lastTimestamp, source};
    try { global.localStorage.setItem(storageKey, JSON.stringify(message)); } catch {}
    channel?.postMessage(message);
  }
  if (/^https?:$/.test(global.location.protocol) && typeof global.BroadcastChannel === 'function') {
    try {
      channel = new global.BroadcastChannel('memo-theme');
      channel.addEventListener('message', event => receive(event.data));
    } catch {}
  }
  global.addEventListener('storage', event => {
    if (event.key !== storageKey || !event.newValue) return;
    try { receive(JSON.parse(event.newValue)); } catch {}
  });
  global.MemoThemeSync = {
    read,
    publish,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
})(window);
