'use strict';

const {
  app,
  BrowserWindow,
  Menu,
  WebContentsView,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  screen,
  session,
  shell,
} = require('electron');
const path = require('node:path');
const config = require('./config');
const i18n = require('./i18n');
const { t } = i18n;

const SIDEBAR_WIDTH = 68;
const SETTINGS_ID = 'settings';
const RETRY_DELAY_MS = 15000;
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const IN_APP_PROTOCOLS = new Set(['http:', 'https:', 'about:', 'blob:']);
/** Harmless permissions, granted to any frame (e.g. a fullscreen video embed). */
const ANY_SITE_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);
/** Granted only to pages on the service's own site (see siteOf). */
const SERVICE_SITE_PERMISSIONS = new Set([
  'notifications',
  'media',
  'clipboard-read',
  'pointerLock',
  'openExternal',
  'speaker-selection',
]);
/** Second-level labels that belong to the suffix, as in "example.com.br" or "example.co.uk". */
const SECOND_LEVEL_SUFFIXES = new Set(['com', 'co', 'org', 'net', 'gov', 'edu', 'ac']);

let mainWindow = null;
let state = null;
let selectedId = null;
let quitting = false;
let saveBoundsTimer = null;

/** service id -> { view, service, titleCount, titleDot, badgeCount, badgeDot, favicon, retryTimer } */
const entries = new Map();
const configuredSessions = new WeakSet();

const noop = () => {};

// ---------------------------------------------------------------------------
// Helpers

function partitionFor(id) {
  return `persist:service-${id}`;
}

function entryForWebContents(wc) {
  if (!wc) return null;
  for (const entry of entries.values()) {
    if (entry.view.webContents === wc) return entry;
  }
  return null;
}

function currentWebContents() {
  return entries.get(selectedId)?.view.webContents ?? null;
}

function openExternal(url) {
  try {
    const parsed = new URL(url);
    if (EXTERNAL_PROTOCOLS.has(parsed.protocol)) shell.openExternal(parsed.href).catch(noop);
  } catch {
    // Ignore malformed URLs.
  }
}

/**
 * Approximate registrable domain ("www.facebook.com" -> "facebook.com"), so login
 * pages on sibling subdomains count as the same service. Null for non-web URLs.
 */
function siteOf(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const host = parsed.hostname;
  if (/^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) return host; // IP or localhost
  const labels = host.split('.');
  const suffixHasTwoLabels =
    labels.length > 2 && labels.at(-1).length === 2 && SECOND_LEVEL_SUFFIXES.has(labels.at(-2));
  return labels.slice(suffixHasTwoLabels ? -3 : -2).join('.');
}

function isServiceSite(entry, url) {
  const site = siteOf(url);
  return site !== null && site === siteOf(entry.service.url);
}

/** Removes "Electron/x.y" and "MiniMessenger/x.y" so sites see a plain Chrome UA. */
function cleanUserAgent(ua) {
  return ua
    .replace(/\sElectron\/\S+/gi, '')
    .replace(/\sMiniMessenger\/\S+/gi, '')
    .replace(/\sminimessenger\/\S+/gi, '');
}

function persist() {
  try {
    config.save(state);
  } catch (err) {
    console.error('Failed to save config:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Unread counts

/**
 * Most web messengers expose unread counts in the title:
 *   WhatsApp:   "(3) WhatsApp"
 *   Mattermost: "(2) * Town Square - Team" ("*" = unread without mentions)
 */
function parseTitle(title) {
  const match = /^\s*\((\d+)\)/.exec(title);
  return {
    titleCount: match ? Number(match[1]) : 0,
    titleDot: /^\s*(?:\(\d+\)\s*)?[*•]/.test(title),
  };
}

// ---------------------------------------------------------------------------
// Icons

/**
 * Lists the icons the page declares with their pixel size. Electron's
 * page-favicon-updated reports them in document order, which is often the
 * 16x16 one first, so we pick the largest ourselves.
 */
const LIST_ICONS_SCRIPT = `(() => {
  const selector = 'link[rel~="icon"], link[rel~="apple-touch-icon"], link[rel~="apple-touch-icon-precomposed"]';
  return [...document.querySelectorAll(selector)].map((link) => {
    const sizes = (link.getAttribute('sizes') || '').toLowerCase();
    let size = 0;
    if (sizes === 'any' || /\\.svg(\\?|#|$)/i.test(link.href)) size = 1024;
    for (const token of sizes.split(/\\s+/)) {
      const n = parseInt(token, 10);
      if (n > size) size = n;
    }
    if (!size && /apple-touch/.test(link.rel)) size = 180;
    return { href: link.href, size };
  });
})()`;

const MIN_GOOD_ICON_SIZE = 48;

function isDisplayableIcon(url) {
  return typeof url === 'string' && /^(https?:|data:)/.test(url);
}

async function refreshPageIcon(entry) {
  let icons;
  try {
    icons = await entry.view.webContents.executeJavaScript(LIST_ICONS_SCRIPT, true);
  } catch {
    return; // page navigating or crashed; next load will retry
  }
  const best = (Array.isArray(icons) ? icons : [])
    .filter((icon) => isDisplayableIcon(icon.href))
    .sort((a, b) => b.size - a.size)[0];
  const pageIcon = best && best.size >= MIN_GOOD_ICON_SIZE ? best.href : null;
  if (pageIcon !== entry.pageIcon) {
    entry.pageIcon = pageIcon;
    rememberIcon(entry);
    broadcast();
  }
}

function iconOf(entry, service) {
  return service.icon || entry?.pageIcon || entry?.favicon || state.iconCache[service.id] || null;
}

/** Remembers the page's icon so the sidebar can still show it while the service is disabled. */
function rememberIcon(entry) {
  const icon = entry.pageIcon || entry.favicon;
  const id = entry.service.id;
  if (!icon || state.iconCache[id] === icon) return;
  state.iconCache[id] = icon;
  persist();
}

function unreadOf(entry) {
  return entry.badgeCount ?? entry.titleCount;
}

function hasDot(entry) {
  return entry.titleDot || entry.badgeDot;
}

function updateDockBadge() {
  let total = 0;
  for (const entry of entries.values()) total += unreadOf(entry);
  app.dock?.setBadge(total > 0 ? String(total) : '');
}

// ---------------------------------------------------------------------------
// State sent to the UI

function publicState() {
  return {
    selectedId,
    services: state.services.map((service) => {
      const entry = entries.get(service.id);
      return {
        ...service,
        unread: entry ? unreadOf(entry) : 0,
        dot: entry ? hasDot(entry) : false,
        displayIcon: iconOf(entry, service),
      };
    }),
  };
}

function broadcast() {
  updateDockBadge();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('state', publicState());
}

// ---------------------------------------------------------------------------
// Sessions and service views

function configureSession(ses) {
  if (configuredSessions.has(ses)) return;
  configuredSessions.add(ses);

  ses.setUserAgent(cleanUserAgent(ses.getUserAgent()));

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(allowPermission(wc, permission, details?.requestingUrl ?? wc?.getURL()));
  });

  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) =>
    allowPermission(wc, permission, requestingOrigin));
}

/**
 * Camera, microphone, notifications and the like are granted only to the service's
 * own site, so a page the view navigated to (or a third-party iframe) gets nothing.
 */
function allowPermission(wc, permission, requestingUrl) {
  if (ANY_SITE_PERMISSIONS.has(permission)) return true;
  if (!SERVICE_SITE_PERMISSIONS.has(permission)) return false;
  const entry = entryForWebContents(wc);
  if (!entry || !isServiceSite(entry, requestingUrl)) return false;
  return permission !== 'notifications' || entry.service.notifications;
}

function layoutEntry(entry) {
  const [width, height] = mainWindow.getContentSize();
  entry.view.setBounds({
    x: SIDEBAR_WIDTH,
    y: 0,
    width: Math.max(0, width - SIDEBAR_WIDTH),
    height,
  });
}

function loadService(entry) {
  entry.view.webContents.loadURL(entry.service.url).catch(noop); // failures handled by did-fail-load
}

function scheduleRetry(entry) {
  clearTimeout(entry.retryTimer);
  entry.retryTimer = setTimeout(() => {
    entry.retryTimer = null;
    if (entries.get(entry.service.id) === entry) loadService(entry);
  }, RETRY_DELAY_MS);
}

function createEntry(service) {
  const partition = partitionFor(service.id);
  configureSession(session.fromPartition(partition));

  const view = new WebContentsView({
    webPreferences: {
      partition,
      preload: path.join(__dirname, 'preload-service.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep hidden services connected
      spellcheck: true,
    },
  });

  const entry = {
    view,
    service,
    titleCount: 0,
    titleDot: false,
    badgeCount: null,
    badgeDot: false,
    favicon: null,
    pageIcon: null,
    retryTimer: null,
  };
  entries.set(service.id, entry);

  const wc = view.webContents;

  wc.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });

  // Keep the view on the web: a dropped file or a link to another scheme would
  // otherwise replace the service page. mailto:/tel: go to the system handler.
  wc.on('will-navigate', (event, legacyUrl) => {
    const url = event.url ?? legacyUrl;
    let protocol;
    try {
      protocol = new URL(url).protocol;
    } catch {
      protocol = null;
    }
    if (IN_APP_PROTOCOLS.has(protocol)) return;
    event.preventDefault();
    openExternal(url);
  });

  wc.on('page-title-updated', (_event, title) => {
    Object.assign(entry, parseTitle(title));
    broadcast();
  });

  wc.on('page-favicon-updated', (_event, favicons) => {
    const icon = favicons.find(isDisplayableIcon);
    if (icon && icon !== entry.favicon) {
      entry.favicon = icon;
      rememberIcon(entry);
      broadcast();
    }
    refreshPageIcon(entry);
  });

  wc.on('did-finish-load', () => refreshPageIcon(entry));

  wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = aborted, usually a redirect
    console.warn(`[${entry.service.name}] load failed (${code} ${description}) for ${url}; retrying`);
    scheduleRetry(entry);
  });

  wc.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    console.warn(`[${entry.service.name}] renderer gone (${details.reason}); reloading`);
    scheduleRetry(entry);
  });

  wc.on('context-menu', (_event, params) => showContextMenu(wc, params));

  mainWindow.contentView.addChildView(view);
  view.setVisible(false);
  layoutEntry(entry);
  loadService(entry);
  return entry;
}

function destroyEntry(entry) {
  clearTimeout(entry.retryTimer);
  entries.delete(entry.service.id);
  mainWindow.contentView.removeChildView(entry.view);
  entry.view.webContents.close();
}

function clearServiceData(id) {
  const ses = session.fromPartition(partitionFor(id));
  ses.clearStorageData().catch(noop);
  ses.clearCache().catch(noop);
}

// ---------------------------------------------------------------------------
// Selection

function firstSelectableId() {
  return state.services.find((s) => s.enabled && entries.has(s.id))?.id ?? SETTINGS_ID;
}

function select(id) {
  if (id !== SETTINGS_ID && !entries.has(id)) id = firstSelectableId();
  selectedId = id;

  for (const [entryId, entry] of entries) entry.view.setVisible(entryId === id);

  const entry = entries.get(id);
  if (entry) entry.view.webContents.focus();
  else mainWindow.webContents.focus();
  mainWindow.setTitle(entry ? entry.service.name : t('settings.title'));

  if (state.selectedId !== id) {
    state.selectedId = id;
    persist();
  }
  broadcast();
}

function cycle(direction) {
  const ids = state.services.filter((s) => entries.has(s.id)).map((s) => s.id);
  if (ids.length === 0) return;
  const index = ids.indexOf(selectedId);
  const next = index === -1 ? 0 : (index + direction + ids.length) % ids.length;
  select(ids[next]);
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------------------------------------------------------------------------
// Applying settings

function applyServices(rawList) {
  const next = config.normalizeServices(rawList);
  const nextIds = new Set(next.map((s) => s.id));

  for (const removed of state.services.filter((s) => !nextIds.has(s.id))) {
    const entry = entries.get(removed.id);
    if (entry) destroyEntry(entry);
    clearServiceData(removed.id);
    delete state.iconCache[removed.id];
  }

  for (const service of next) {
    const entry = entries.get(service.id);
    if (!service.enabled) {
      if (entry) destroyEntry(entry);
      continue;
    }
    if (!entry) {
      createEntry(service);
      continue;
    }
    const previous = entry.service;
    entry.service = service;
    if (previous.url !== service.url) loadService(entry);
    else if (previous.notifications !== service.notifications) entry.view.webContents.reload();
  }

  state.services = next;
  persist();
  buildMenu();
  select(selectedId);
}

function setServiceEnabled(id, enabled) {
  applyServices(state.services.map((s) => (s.id === id ? { ...s, enabled } : s)));
}

function refreshService(id) {
  const entry = entries.get(id);
  if (!entry) return;
  clearTimeout(entry.retryTimer);
  entry.retryTimer = null;
  const wc = entry.view.webContents;
  // After a failed first load there is nothing to reload, so load the URL again.
  if (wc.getURL()) wc.reload();
  else loadService(entry);
}

// ---------------------------------------------------------------------------
// Menus

function setZoom(delta, reset = false) {
  const wc = currentWebContents();
  if (!wc) return;
  wc.setZoomLevel(reset ? 0 : wc.getZoomLevel() + delta);
}

function buildMenu() {
  const separator = { type: 'separator' };
  const serviceItems = state.services
    .filter((s) => s.enabled)
    .map((s, index) => ({
      label: s.name,
      accelerator: index < 9 ? `CmdOrCtrl+${index + 1}` : undefined,
      click: () => select(s.id),
    }));

  const appVars = { app: app.name };
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: t('menu.about', appVars) },
        separator,
        { label: t('menu.settings'), accelerator: 'CmdOrCtrl+,', click: () => select(SETTINGS_ID) },
        separator,
        { role: 'services', label: t('menu.macServices') },
        separator,
        { role: 'hide', label: t('menu.hide', appVars) },
        { role: 'hideOthers', label: t('menu.hideOthers') },
        { role: 'unhide', label: t('menu.showAll') },
        separator,
        { role: 'quit', label: t('menu.quit', appVars) },
      ],
    },
    {
      role: 'editMenu',
      label: t('menu.edit'),
      submenu: [
        { role: 'undo', label: t('menu.undo') },
        { role: 'redo', label: t('menu.redo') },
        separator,
        { role: 'cut', label: t('menu.cut') },
        { role: 'copy', label: t('menu.copy') },
        { role: 'paste', label: t('menu.paste') },
        { role: 'pasteAndMatchStyle', label: t('menu.pasteAndMatchStyle') },
        { role: 'delete', label: t('menu.delete') },
        { role: 'selectAll', label: t('menu.selectAll') },
        separator,
        {
          label: t('menu.speech'),
          submenu: [
            { role: 'startSpeaking', label: t('menu.startSpeaking') },
            { role: 'stopSpeaking', label: t('menu.stopSpeaking') },
          ],
        },
      ],
    },
    {
      label: t('menu.view'),
      submenu: [
        { label: t('menu.reloadService'), accelerator: 'CmdOrCtrl+R', click: () => currentWebContents()?.reload() },
        {
          label: t('menu.forceReloadService'),
          accelerator: 'Shift+CmdOrCtrl+R',
          click: () => currentWebContents()?.reloadIgnoringCache(),
        },
        separator,
        { label: t('menu.actualSize'), accelerator: 'CmdOrCtrl+0', click: () => setZoom(0, true) },
        { label: t('menu.zoomIn'), accelerator: 'CmdOrCtrl+Plus', click: () => setZoom(0.5) },
        { label: t('menu.zoomIn'), accelerator: 'CmdOrCtrl+=', visible: false, click: () => setZoom(0.5) },
        { label: t('menu.zoomOut'), accelerator: 'CmdOrCtrl+-', click: () => setZoom(-0.5) },
        separator,
        {
          label: t('menu.toggleDevTools'),
          accelerator: 'Alt+CmdOrCtrl+I',
          click: () => (currentWebContents() ?? mainWindow.webContents).toggleDevTools(),
        },
        separator,
        { role: 'togglefullscreen', label: t('menu.toggleFullScreen') },
      ],
    },
    {
      label: t('menu.services'),
      submenu: [
        ...serviceItems,
        ...(serviceItems.length ? [separator] : []),
        { label: t('menu.nextService'), accelerator: 'Ctrl+Tab', click: () => cycle(1) },
        { label: t('menu.previousService'), accelerator: 'Ctrl+Shift+Tab', click: () => cycle(-1) },
      ],
    },
    {
      role: 'windowMenu',
      label: t('menu.window'),
      submenu: [
        { role: 'minimize', label: t('menu.minimize') },
        { role: 'zoom', label: t('menu.zoom') },
        separator,
        { role: 'front', label: t('menu.bringAllToFront') },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showContextMenu(wc, params) {
  const separator = { type: 'separator' };
  const items = [];

  for (const suggestion of params.dictionarySuggestions ?? []) {
    items.push({ label: suggestion, click: () => wc.replaceMisspelling(suggestion) });
  }
  if (params.misspelledWord) {
    items.push({
      label: t('context.addToDictionary'),
      click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord),
    });
    items.push(separator);
  }

  if (params.linkURL) {
    items.push({ label: t('context.openLinkInBrowser'), click: () => openExternal(params.linkURL) });
    items.push({ label: t('context.copyLink'), click: () => clipboard.writeText(params.linkURL) });
    items.push(separator);
  }

  if (params.mediaType === 'image' && params.srcURL) {
    items.push({ label: t('context.copyImage'), click: () => wc.copyImageAt(params.x, params.y) });
    items.push(separator);
  }

  if (params.isEditable) {
    items.push(
      { role: 'cut', label: t('menu.cut') },
      { role: 'copy', label: t('menu.copy') },
      { role: 'paste', label: t('menu.paste') },
      { role: 'pasteAndMatchStyle', label: t('menu.pasteAndMatchStyle') },
    );
    items.push(separator, { role: 'selectAll', label: t('menu.selectAll') });
  } else if (params.selectionText) {
    items.push({ role: 'copy', label: t('menu.copy') });
  }

  while (items.length && items.at(-1).type === 'separator') items.pop();
  if (items.length === 0) return;
  Menu.buildFromTemplate(items).popup({ window: mainWindow });
}

/** Right-click menu for a service icon in the sidebar. */
function showServiceMenu(id) {
  const service = state.services.find((s) => s.id === id);
  if (!service) return;
  const template = [
    { label: t('service.refresh'), enabled: entries.has(id), click: () => refreshService(id) },
    { type: 'separator' },
    {
      label: t(service.enabled ? 'service.disable' : 'service.enable'),
      click: () => setServiceEnabled(id, !service.enabled),
    },
  ];
  Menu.buildFromTemplate(template).popup({ window: mainWindow });
}

// ---------------------------------------------------------------------------
// Language

function applyLanguage() {
  i18n.setLocale(i18n.resolve(state.language, app.getPreferredSystemLanguages()));
}

function setLanguage(preference) {
  state.language = config.normalizeLanguage(preference);
  persist();
  applyLanguage();
  buildMenu();
  select(selectedId); // refreshes the window title
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('i18n', i18n.uiBundle(state.language));
  }
}

async function confirmDelete(name) {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    message: t('dialog.deleteTitle', { name: name || t('dialog.deleteFallbackName') }),
    detail: t('dialog.deleteDetail'),
    buttons: [t('dialog.delete'), t('dialog.cancel')],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
}

// ---------------------------------------------------------------------------
// Window

function restoredBounds() {
  const saved = state.window;
  const bounds = { width: 1280, height: 860 };
  if (!saved) return bounds;

  if (Number.isFinite(saved.width) && Number.isFinite(saved.height)) {
    bounds.width = saved.width;
    bounds.height = saved.height;
  }
  if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    const visible = screen.getAllDisplays().some(({ workArea: a }) =>
      saved.x >= a.x && saved.y >= a.y && saved.x < a.x + a.width && saved.y < a.y + a.height);
    if (visible) {
      bounds.x = saved.x;
      bounds.y = saved.y;
    }
  }
  return bounds;
}

function saveBounds() {
  clearTimeout(saveBoundsTimer);
  saveBoundsTimer = null;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  state.window = mainWindow.getNormalBounds();
  persist();
}

function saveBoundsSoon() {
  clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(saveBounds, 500);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    ...restoredBounds(),
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: app.name,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#242426' : '#f7f7f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload-ui.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  mainWindow.on('resize', () => {
    for (const entry of entries.values()) layoutEntry(entry);
    saveBoundsSoon();
  });
  mainWindow.on('move', saveBoundsSoon);

  // Closing the window only hides it, so services keep running and notifying.
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    if (mainWindow.isFullScreen()) {
      mainWindow.once('leave-full-screen', () => mainWindow.hide());
      mainWindow.setFullScreen(false);
    } else {
      mainWindow.hide();
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
}

// ---------------------------------------------------------------------------
// IPC

function fromUi(event) {
  return mainWindow && event.sender === mainWindow.webContents;
}

function registerIpc() {
  ipcMain.handle('ui:get-state', (event) => (fromUi(event) ? publicState() : null));

  ipcMain.on('ui:select', (event, id) => {
    if (fromUi(event)) select(String(id));
  });

  ipcMain.on('ui:service-menu', (event, id) => {
    if (fromUi(event)) showServiceMenu(String(id));
  });

  ipcMain.handle('ui:save-services', (event, list) => {
    if (!fromUi(event)) return { ok: false, error: 'Forbidden' };
    try {
      applyServices(list);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.key ? t(err.key, err.vars) : err.message };
    }
  });

  ipcMain.handle('ui:get-i18n', (event) => (fromUi(event) ? i18n.uiBundle(state.language) : null));

  ipcMain.handle('ui:set-language', (event, preference) => {
    if (fromUi(event)) setLanguage(String(preference));
  });

  ipcMain.handle('ui:confirm-delete', (event, name) => (fromUi(event) ? confirmDelete(String(name ?? '')) : false));

  ipcMain.handle('ui:get-open-at-login', (event) =>
    fromUi(event) ? app.getLoginItemSettings().openAtLogin : false);

  ipcMain.handle('ui:set-open-at-login', (event, value) => {
    if (!fromUi(event)) return false;
    app.setLoginItemSettings({ openAtLogin: Boolean(value) });
    return app.getLoginItemSettings().openAtLogin;
  });

  ipcMain.on('service:notification-click', (event) => {
    const entry = entryForWebContents(event.sender);
    if (!entry) return;
    showWindow();
    select(entry.service.id);
  });

  ipcMain.on('service:badge', (event, count) => {
    const entry = entryForWebContents(event.sender);
    if (!entry) return;
    const value = Number(count);
    if (!Number.isFinite(value)) return;
    if (value < 0) {
      // navigator.setAppBadge() without a number: "something is unread".
      entry.badgeCount = 0;
      entry.badgeDot = true;
    } else {
      entry.badgeCount = Math.floor(value);
      entry.badgeDot = false;
    }
    broadcast();
  });
}

// ---------------------------------------------------------------------------
// Startup

function start() {
  state = config.load();
  applyLanguage();
  app.userAgentFallback = cleanUserAgent(app.userAgentFallback);

  registerIpc();
  buildMenu();
  createWindow();

  for (const service of state.services) {
    if (service.enabled) createEntry(service);
  }
  select(state.selectedId);

  app.on('activate', showWindow);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('before-quit', () => {
    quitting = true;
    if (saveBoundsTimer) saveBounds();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.whenReady().then(start);
}
