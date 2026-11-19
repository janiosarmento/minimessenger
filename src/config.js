'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const i18n = require('./i18n');

const DEFAULT_SERVICES = [
  { id: 'whatsapp', name: 'WhatsApp', url: 'https://web.whatsapp.com/', enabled: true, notifications: true },
  { id: 'telegram', name: 'Telegram', url: 'https://web.telegram.org/a/', enabled: true, notifications: true },
  { id: 'messenger', name: 'Messenger', url: 'https://www.facebook.com/messages/', enabled: true, notifications: true },
];

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Validation error carrying a locale key, so the UI can show it translated. */
class ConfigError extends Error {
  constructor(key, vars = {}) {
    super(i18n.english(key, vars));
    this.key = key;
    this.vars = vars;
  }
}

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function defaults() {
  return { services: structuredClone(DEFAULT_SERVICES), window: null, selectedId: null, iconCache: {}, language: 'system' };
}

function normalizeService(raw) {
  if (!raw || typeof raw !== 'object') throw new ConfigError('error.invalidEntry');

  const id = String(raw.id ?? '');
  if (!ID_RE.test(id)) throw new ConfigError('error.invalidId', { id });

  const name = String(raw.name ?? '').trim();
  if (!name) throw new ConfigError('error.nameRequired');

  let url;
  try {
    url = new URL(String(raw.url ?? '').trim());
  } catch {
    throw new ConfigError('error.invalidUrl', { name });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError('error.urlProtocol', { name });
  }

  const iconText = String(raw.icon ?? '').trim();
  let icon = '';
  if (iconText) {
    let iconUrl;
    try {
      iconUrl = new URL(iconText);
    } catch {
      throw new ConfigError('error.invalidIconUrl', { name });
    }
    if (!['https:', 'http:', 'data:'].includes(iconUrl.protocol)) {
      throw new ConfigError('error.iconProtocol', { name });
    }
    icon = iconUrl.href;
  }

  return {
    id,
    name: name.slice(0, 64),
    url: url.href,
    icon,
    enabled: raw.enabled !== false,
    notifications: raw.notifications !== false,
  };
}

/** Last known sidebar icon per service id, so disabled services keep their icon. */
function normalizeIconCache(raw) {
  const cache = {};
  if (!raw || typeof raw !== 'object') return cache;
  for (const [id, url] of Object.entries(raw)) {
    if (ID_RE.test(id) && typeof url === 'string' && /^(https?:|data:)/.test(url)) cache[id] = url;
  }
  return cache;
}

function normalizeLanguage(value) {
  return i18n.PREFERENCES.has(value) ? value : 'system';
}

function normalizeServices(list) {
  if (!Array.isArray(list)) throw new ConfigError('error.notArray');
  const seen = new Set();
  return list.map((raw) => {
    const service = normalizeService(raw);
    if (seen.has(service.id)) throw new ConfigError('error.duplicateId', { id: service.id });
    seen.add(service.id);
    return service;
  });
}

function load() {
  const file = configPath();
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return defaults();
    return recoverFromBrokenConfig(file, err);
  }

  try {
    return {
      services: normalizeServices(data.services),
      window: data.window && typeof data.window === 'object' ? data.window : null,
      selectedId: typeof data.selectedId === 'string' ? data.selectedId : null,
      iconCache: normalizeIconCache(data.iconCache),
      language: normalizeLanguage(data.language),
    };
  } catch (err) {
    return recoverFromBrokenConfig(file, err);
  }
}

function recoverFromBrokenConfig(file, err) {
  const backup = `${file}.broken-${Date.now()}`;
  console.error(`Config is invalid (${err.message}); moving it to ${backup} and using defaults`);
  try {
    fs.renameSync(file, backup);
  } catch (renameErr) {
    console.error('Could not back up broken config:', renameErr.message);
  }
  return defaults();
}

function save(state) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

module.exports = { load, save, normalizeServices, normalizeLanguage, configPath };
