'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('minimessenger', {
  getState: () => ipcRenderer.invoke('ui:get-state'),
  onState: (callback) => ipcRenderer.on('state', (_event, state) => callback(state)),
  getI18n: () => ipcRenderer.invoke('ui:get-i18n'),
  onI18n: (callback) => ipcRenderer.on('i18n', (_event, bundle) => callback(bundle)),
  setLanguage: (preference) => ipcRenderer.invoke('ui:set-language', preference),
  confirmDelete: (name) => ipcRenderer.invoke('ui:confirm-delete', name),
  select: (id) => ipcRenderer.send('ui:select', id),
  showServiceMenu: (id) => ipcRenderer.send('ui:service-menu', id),
  saveServices: (services) => ipcRenderer.invoke('ui:save-services', services),
  getOpenAtLogin: () => ipcRenderer.invoke('ui:get-open-at-login'),
  setOpenAtLogin: (value) => ipcRenderer.invoke('ui:set-open-at-login', value),
});
