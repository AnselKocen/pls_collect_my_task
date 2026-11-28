(function () {
  'use strict';

  const catalog = window.CatSanctuaryThemeCatalog;
  const room = window.CatRoomScene;
  if (!catalog?.themes?.length || !room?.setImage) return;
  const $ = id => document.getElementById(id);
  const root = document.documentElement, image = $('room'), select = $('roomThemeSelect');
  const controls = $('roomThemeControls'), status = $('roomThemeStatus');
  const sync = window.MemoThemeSync;
  const usesSettingsApi = /^https?:$/.test(location.protocol) && root.dataset.roomSettings !== 'local';
  const themes = catalog.themes, byKey = new Map(themes.map(theme => [theme.key, theme]));
  const defaults = {bg:'#FBF7E9',card:'#FFFFFF',accent:'#E8B84B',text:'#4A3A28',border:'#C8B8A0',deco:'#FCE888'};
  const customKeys = Object.keys(defaults);
  const validCustom = colors => colors && customKeys.every(key => /^#[\da-f]{6}$/i.test(colors[key] || ''));
  function linkedCustomColors() {
    const value = new URLSearchParams(location.hash.slice(1)).get('colors');
    const parts = value?.split('-');
    if (parts?.length !== customKeys.length || !parts.every(part => /^[\da-f]{6}$/i.test(part))) return null;
    return Object.fromEntries(customKeys.map((key, index) => [key, '#' + parts[index]]));
  }
  const normalize = key => key === 'pink' ? 'berry' : byKey.has(key) || key === 'custom' ? key : 'gold';
  const query = new URLSearchParams(location.search).get('theme');
  let preview = !!query && (byKey.has(query) || query === 'pink' || query === 'custom');
  let customColors = {...defaults}, selected = 'gold', sceneKey = 'gold', version = 0;
  let busy = false, failure = null, pendingSaves = 0, saveQueue = Promise.resolve();
  let currentColors = byKey.get('gold').palette;
  const cache = new Map();

  themes.forEach(theme => select.add(new Option(theme.name, theme.key)));
  const customOption = new Option('自定义配色', 'custom');
  customOption.disabled = true; select.add(customOption);

  const rgb = hex => [1,3,5].map(start => parseInt(hex.slice(start, start + 2), 16));
  const luminance = hex => rgb(hex).map(value => value/255).map(value => value <= .04045 ? value/12.92 : ((value+.055)/1.055)**2.4).reduce((sum,value,index) => sum + value*[.2126,.7152,.0722][index],0);
  const contrast = (a,b) => (Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
  const blend = (a, b, ratio) => '#' + rgb(a).map((value, index) => Math.round(value * (1-ratio) + rgb(b)[index] * ratio).toString(16).padStart(2,'0')).join('');
  function rememberCustom(colors) {
    if (validCustom(colors)) { customColors = {...colors}; customOption.disabled = false; }
  }
  function customPalette() {
    return {
      '--t-primary': customColors.accent, '--t-secondary': blend(customColors.accent, '#FFFFFF', .65),
      '--t-accent': customColors.accent, '--t-accent-dark': blend(customColors.accent, '#000000', .2),
      '--t-bg': customColors.bg, '--t-card': customColors.card,
      '--t-text': customColors.text, '--t-text-light': blend(customColors.text, customColors.card, .3),
      '--t-border': customColors.border, '--t-border-light': blend(customColors.border, customColors.card, .4)
    };
  }
  function customScene() {
    // Custom colors have no finite set of generated images. Keep the custom
    // cat palette and use the closest existing room, without recoloring it.
    const target = rgb(customColors.accent), decoration = rgb(customColors.deco);
    const distance = theme => {
      const main = rgb(theme.palette['--t-primary']), extra = rgb(theme.palette['--t-secondary']);
      return target.reduce((sum, value, i) => sum + (value-main[i])**2, 0)
        + .35 * decoration.reduce((sum, value, i) => sum + (value-extra[i])**2, 0);
    };
    return themes.reduce((closest, theme) => distance(theme) < distance(closest) ? theme : closest, themes[0]);
  }
  function refreshMeta() {
    document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.body).getPropertyValue('--paper').trim();
  }
  function paintHeaderCat() {
    const frame = window.CCPixelCat?.frameForIdleAction('rest', 0), canvas = $('catMark');
    if (!frame || !canvas) return;
    const colors = {};
    document.querySelectorAll('#roomCat .cat-palette [data-color]').forEach(swatch => {
      colors[swatch.dataset.color] = getComputedStyle(swatch).backgroundColor;
    });
    const context = canvas.getContext('2d');
    context.clearRect(0,0,canvas.width,canvas.height); context.imageSmoothingEnabled = false;
    frame.pixels.forEach(pixel => {
      context.fillStyle = colors[pixel.color] || '#4D443C';
      context.fillRect((pixel.x+1)*2,(pixel.y+4)*2,(pixel.w||1)*2,(pixel.h||1)*2);
    });
  }
  function applyPalette(key, palette) {
    root.setAttribute('data-theme', key);
    for (const [variable, token] of Object.entries({
      '--paper':'--t-bg','--surface':'--t-card','--ink':'--t-text',
      '--muted':'--t-text-light','--line':'--t-border-light','--sage':'--t-accent'
    })) root.style.setProperty(variable, palette[token]);
    root.style.setProperty('--dot', palette['--t-border'] + '30');
    root.style.setProperty('--shadow', palette['--t-text'] + '16');
    const activeText = contrast(palette['--t-text'],palette['--t-accent']) >= 4.5 ? palette['--t-text'] : contrast('#FFFFFF',palette['--t-accent']) >= 4.5 ? '#FFFFFF' : '#000000';
    root.style.setProperty('--active-text', activeText);
    for (const key of ['--cc-body','--cc-body-light','--cc-body-dark']) root.style.removeProperty(key);
    if (key === 'custom') {
      root.style.setProperty('--cc-body', customColors.accent);
      root.style.setProperty('--cc-body-light', blend(customColors.accent,'#FFFFFF',.35));
      root.style.setProperty('--cc-body-dark', blend(customColors.accent,'#000000',.2));
    }
    currentColors = palette;
    refreshMeta(); paintHeaderCat();
  }
  function announce(message, error = false) {
    status.textContent = message;
    status.className = error ? 'room-theme-error' : 'visually-hidden';
  }
  function loadImage(src) {
    const url = new URL(src, document.baseURI).href;
    if (!cache.has(url)) {
      const pending = new Promise((resolve, reject) => {
        const next = new Image();
        next.onload = () => (next.decode ? next.decode().catch(() => {}) : Promise.resolve()).then(() => resolve(next));
        next.onerror = () => reject(new Error('Theme image unavailable'));
        next.src = url;
      }).catch(error => { cache.delete(url); throw error; });
      cache.set(url, pending);
    }
    return cache.get(url);
  }
  function updateUrl(key) {
    try {
      const url = new URL(location.href); url.searchParams.set('theme', key);
      history.replaceState(history.state, '', url);
    } catch {}
  }
  function saveSelection(selection) {
    if (!usesSettingsApi) return Promise.resolve();
    pendingSaves++;
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      try {
        const response = await fetch('/api/settings', {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(selection)});
        if (!response.ok) throw new Error('Save failed');
      } catch {
        if (selected === selection.theme) announce('主题已切换，这次未能保存；下次打开时可能恢复原来的主题。', true);
      } finally { pendingSaves--; }
    });
    return saveQueue;
  }
  async function applyTheme(value, options = {}) {
    const key = normalize(value), request = ++version;
    rememberCustom(options.customColors);
    if (key === 'custom') customOption.disabled = false;
    const background = key === 'custom' ? customScene() : byKey.get(key);
    const palette = key === 'custom' ? customPalette() : background.palette;
    const label = key === 'custom' ? '自定义配色' : background.name;
    select.value = key; busy = true; failure = null;
    controls.setAttribute('aria-busy','true'); $('scene').setAttribute('aria-busy','true');
    announce(`正在换上${label}的小窝`);
    try {
      await loadImage(background.image);
      if (request !== version) return false;
      // All consumers switch in the same task, after the image is decoded.
      // The foreground cutouts always sample the same image as the room.
      const outline = window.CatRoomOutlines?.[background.key];
      if (outline) image.style.setProperty('--room-outline', `url("${outline}")`);
      else image.style.removeProperty('--room-outline');
      room.setImage(background.image);
      selected = key; sceneKey = background.key;
      applyPalette(key, palette);
      image.alt = `${label}配色的等距像素猫咪小屋，包含猫爬架、猫窝、玩具和喂食角。`;
      $('downloadScene').download = `猫咪的秘密基地-${label}.png`;
      announce(`已换上${label}，小猫也换好配色了`);
      if (options.updateUrl) updateUrl(key);
      if (options.user) {
        preview = false;
        const selection = {theme:key, ...(key === 'custom' ? {customColors:{...customColors}} : {})};
        sync?.publish(selection);
        saveSelection(selection);
      }
      window.dispatchEvent(new CustomEvent('cat-room:theme-change',{detail:{theme:key,sceneTheme:sceneKey,image:background.image}}));
      return true;
    } catch {
      if (request !== version) return false;
      failure = key; select.value = selected;
      announce(`暂时没能打开${label}的小窝，先保留当前主题，请稍后再试。`, true);
      return false;
    } finally {
      if (request === version) { busy = false; controls.setAttribute('aria-busy','false'); $('scene').setAttribute('aria-busy','false'); }
    }
  }
  select.addEventListener('change', () => applyTheme(select.value,{user:true,updateUrl:true}));
  function step(direction) {
    const options = [...select.options].filter(option => !option.disabled);
    const index = options.findIndex(option => option.value === select.value);
    applyTheme(options[(index + direction + options.length) % options.length].value,{user:true,updateUrl:true});
  }
  $('roomThemePrev').addEventListener('click', () => step(-1));
  $('roomThemeNext').addEventListener('click', () => step(1));
  sync?.subscribe(selection => {
    if (preview) return;
    rememberCustom(selection.customColors);
    applyTheme(selection.theme,{customColors:selection.customColors});
  });
  async function refreshSettings() {
    if (!usesSettingsApi || preview || pendingSaves || busy) return;
    const revision = version, controller = new AbortController(), timeout = setTimeout(() => controller.abort(),2500);
    try {
      const response = await fetch('/api/settings',{signal:controller.signal,cache:'no-store'});
      if (!response.ok) return;
      const settings = await response.json();
      if (revision !== version || pendingSaves || preview) return;
      const previous = JSON.stringify(customColors); rememberCustom(settings.customColors);
      const theme = normalize(settings.theme || 'gold');
      if (theme !== selected || theme === 'custom' && previous !== JSON.stringify(customColors)) await applyTheme(theme,{customColors:settings.customColors});
    } catch {} finally { clearTimeout(timeout); }
  }
  window.addEventListener('focus', refreshSettings);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshSettings(); });

  const api = window.CatRoomThemes = {
    applyTheme, refreshMeta,
    whenSaved: () => saveQueue,
    snapshot: () => ({theme:selected,sceneTheme:sceneKey,requestedTheme:select.value,busy,error:failure,image:image.getAttribute('src'),palette:{...currentColors}}),
    themes: themes.map(({key,name}) => ({key,name}))
  };
  api.ready = (async () => {
    const saved = sync?.read(); rememberCustom(saved?.customColors);
    if (query === 'custom') rememberCustom(linkedCustomColors());
    await applyTheme(preview ? query : saved?.theme || 'gold');
    await refreshSettings();
  })();
})();
