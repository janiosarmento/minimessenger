'use strict';

const api = window.minimessenger;

const SETTINGS_ID = 'settings';

const serviceList = document.getElementById('service-list');
const settingsButton = document.getElementById('settings-button');
const settingsPanel = document.getElementById('settings');
const tbody = document.querySelector('#services-table tbody');
const addButton = document.getElementById('add-service');
const saveButton = document.getElementById('save');
const revertButton = document.getElementById('revert');
const saveStatus = document.getElementById('save-status');
const openAtLogin = document.getElementById('open-at-login');
const languageSelect = document.getElementById('language');

let current = null; // last state received from the main process
let draft = []; // services being edited in the settings table
let dirty = false;
let lastConfigKey = null;

const buttons = new Map(); // service id -> sidebar button

let strings = {}; // locale key -> text, sent by the main process

function t(key, vars = {}) {
  const template = strings[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole));
}

// ---------------------------------------------------------------------------
// Language

function fillLanguageSelect(bundle) {
  const options = [{ code: 'system', name: t('settings.languageSystem') }, ...bundle.languages];
  languageSelect.replaceChildren(...options.map(({ code, name }) => {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = name;
    return option;
  }));
  languageSelect.value = bundle.preference;
}

function applyI18n(bundle) {
  if (!bundle) return;
  strings = bundle.strings;
  document.documentElement.lang = bundle.locale;

  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  fillLanguageSelect(bundle);

  // Rebuild dynamic parts; the table keeps the unsaved draft.
  if (current) renderSidebar(current);
  renderTable();
  setStatus(dirty ? t('settings.unsaved') : '');
}

// ---------------------------------------------------------------------------
// Sidebar

function createServiceButton(id) {
  const button = document.createElement('button');
  button.className = 'service-button';

  const icon = document.createElement('span');
  icon.className = 'icon';

  const img = document.createElement('img');
  img.alt = '';
  img.hidden = true;

  const letter = document.createElement('span');
  letter.className = 'letter';

  img.addEventListener('load', () => {
    img.hidden = false;
    letter.hidden = true;
  });
  img.addEventListener('error', () => {
    img.hidden = true;
    letter.hidden = false;
  });

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.hidden = true;

  icon.append(img, letter);
  button.append(icon, badge);
  button.addEventListener('click', () => {
    if (!button.classList.contains('disabled')) api.select(id);
  });
  button.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    api.showServiceMenu(id);
  });
  return button;
}

/** shortcutIndex: position among enabled services (⌘1…⌘9), or -1 when disabled. */
function updateServiceButton(button, service, shortcutIndex, active) {
  button.classList.toggle('active', active);
  button.classList.toggle('disabled', !service.enabled);
  if (!service.enabled) button.title = t('service.disabledTooltip', { name: service.name });
  else button.title = shortcutIndex < 9 ? `${service.name} (⌘${shortcutIndex + 1})` : service.name;

  const img = button.querySelector('img');
  const letter = button.querySelector('.letter');
  const badge = button.querySelector('.badge');

  letter.textContent = service.name.trim().charAt(0).toUpperCase();

  if (service.displayIcon) {
    if (img.getAttribute('src') !== service.displayIcon) img.src = service.displayIcon;
  } else {
    img.removeAttribute('src');
    img.hidden = true;
    letter.hidden = false;
  }

  if (service.unread > 0) {
    badge.className = 'badge count';
    badge.textContent = service.unread > 99 ? '99+' : String(service.unread);
    badge.hidden = false;
  } else if (service.dot) {
    badge.className = 'badge dot';
    badge.textContent = '';
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

function renderSidebar(state) {
  const ids = new Set(state.services.map((s) => s.id));

  for (const [id, button] of buttons) {
    if (!ids.has(id)) {
      button.remove();
      buttons.delete(id);
    }
  }

  let shortcutIndex = 0;
  state.services.forEach((service, index) => {
    let button = buttons.get(service.id);
    if (!button) {
      button = createServiceButton(service.id);
      buttons.set(service.id, button);
    }
    if (serviceList.children[index] !== button) {
      serviceList.insertBefore(button, serviceList.children[index] ?? null);
    }
    updateServiceButton(button, service, service.enabled ? shortcutIndex++ : -1, state.selectedId === service.id);
  });

  settingsButton.classList.toggle('active', state.selectedId === SETTINGS_ID);
}

// ---------------------------------------------------------------------------
// Settings table

function editableFields({ id, name, url, icon, enabled, notifications }) {
  return { id, name, url, icon: icon ?? '', enabled, notifications };
}

function savedIds() {
  return new Set((current?.services ?? []).map((s) => s.id));
}

function newId() {
  return `svc-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function setStatus(text, isError = false) {
  saveStatus.textContent = text;
  saveStatus.classList.toggle('error', isError);
}

function markDirty() {
  dirty = true;
  saveButton.disabled = false;
  revertButton.disabled = false;
  setStatus(t('settings.unsaved'));
}

function clearDirty() {
  dirty = false;
  saveButton.disabled = true;
  revertButton.disabled = true;
}

function textInput(value, placeholder, type, onInput) {
  const input = document.createElement('input');
  input.type = type;
  input.value = value;
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.addEventListener('input', () => {
    onInput(input.value);
    markDirty();
  });
  return input;
}

function checkbox(checked, title, onChange) {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.title = title;
  input.addEventListener('change', () => {
    onChange(input.checked);
    markDirty();
  });
  return input;
}

function iconButton(label, title, disabled, onClick, extraClass = '') {
  const button = document.createElement('button');
  button.className = `icon-button ${extraClass}`.trim();
  button.textContent = label;
  button.title = title;
  button.disabled = disabled;
  button.addEventListener('click', onClick);
  return button;
}

function cell(className, ...children) {
  const td = document.createElement('td');
  if (className) td.className = className;
  td.append(...children);
  return td;
}

function move(index, direction) {
  const target = index + direction;
  if (target < 0 || target >= draft.length) return;
  [draft[index], draft[target]] = [draft[target], draft[index]];
  markDirty();
  renderTable();
}

async function remove(index) {
  const service = draft[index];
  if (savedIds().has(service.id) && !(await api.confirmDelete(service.name))) return;
  const position = draft.indexOf(service); // the draft may have changed while the dialog was open
  if (position === -1) return;
  draft.splice(position, 1);
  markDirty();
  renderTable();
}

function rowFor(service, index) {
  const tr = document.createElement('tr');
  tr.append(
    cell('', textInput(service.name, t('settings.namePlaceholder'), 'text', (v) => { service.name = v; })),
    cell('', textInput(service.url, 'https://…', 'url', (v) => { service.url = v; })),
    cell('', textInput(service.icon, t('settings.iconPlaceholder'), 'url', (v) => { service.icon = v; })),
    cell('center', checkbox(service.enabled, t('settings.colEnabledTooltip'), (v) => { service.enabled = v; })),
    cell('center', checkbox(service.notifications, t('settings.colNotifyTooltip'), (v) => { service.notifications = v; })),
    cell(
      'row-actions',
      iconButton('↑', t('settings.moveUp'), index === 0, () => move(index, -1)),
      iconButton('↓', t('settings.moveDown'), index === draft.length - 1, () => move(index, 1)),
      iconButton('✕', t('settings.delete'), false, () => remove(index), 'danger'),
    ),
  );
  return tr;
}

function renderTable() {
  tbody.replaceChildren(...draft.map(rowFor));
}

function resetDraft(state) {
  draft = state.services.map(editableFields);
  lastConfigKey = JSON.stringify(draft);
  clearDirty();
  renderTable();
}

// ---------------------------------------------------------------------------
// State

function render(state) {
  current = state;
  renderSidebar(state);
  settingsPanel.hidden = state.selectedId !== SETTINGS_ID;

  // Only rebuild the table when the saved config changed (not on badge updates)
  // and the user is not in the middle of editing.
  const key = JSON.stringify(state.services.map(editableFields));
  if (!dirty && key !== lastConfigKey) resetDraft(state);
}

addButton.addEventListener('click', () => {
  draft.push({ id: newId(), name: '', url: 'https://', icon: '', enabled: true, notifications: true });
  markDirty();
  renderTable();
  tbody.lastElementChild?.querySelector('input')?.focus();
});

saveButton.addEventListener('click', async () => {
  saveButton.disabled = true;
  const result = await api.saveServices(draft.map(editableFields));
  if (!result.ok) {
    saveButton.disabled = false;
    setStatus(result.error, true);
    return;
  }
  clearDirty();
  setStatus(t('settings.saved'));
  const state = await api.getState();
  resetDraft(state);
  render(state);
});

revertButton.addEventListener('click', () => {
  if (!current) return;
  resetDraft(current);
  setStatus('');
});

settingsButton.addEventListener('click', () => api.select(SETTINGS_ID));

openAtLogin.addEventListener('change', async () => {
  openAtLogin.checked = await api.setOpenAtLogin(openAtLogin.checked);
});

languageSelect.addEventListener('change', () => api.setLanguage(languageSelect.value));

api.onI18n(applyI18n);
api.onState(render);

(async () => {
  applyI18n(await api.getI18n()); // strings first, so the first render is already translated
  const state = await api.getState();
  if (state) render(state);
  openAtLogin.checked = await api.getOpenAtLogin();
})();
