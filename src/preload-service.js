'use strict';

// Preload for service pages (WhatsApp, Telegram, ...). Runs in an isolated
// world; patches a few APIs in the page's main world and relays events to the
// main process.

const { contextBridge, ipcRenderer, webFrame } = require('electron');

function mainWorldPatch() {
  const TAG = '__minimessenger';
  const post = (type, extra = {}) =>
    window.postMessage({ [TAG]: type, ...extra }, window.location.origin);

  // Report notification clicks so the app can switch to this service.
  const NativeNotification = window.Notification;
  if (typeof NativeNotification === 'function') {
    class PatchedNotification extends NativeNotification {
      constructor(title, options) {
        super(title, options);
        this.addEventListener('click', () => post('notification-click'));
      }
    }
    Object.defineProperty(window, 'Notification', {
      value: PatchedNotification,
      writable: true,
      configurable: true,
    });
  }

  // Electron does not display service worker ("persistent") notifications,
  // so route them through the regular Notification API.
  if (typeof window.ServiceWorkerRegistration === 'function') {
    const proto = window.ServiceWorkerRegistration.prototype;
    proto.showNotification = function showNotification(title, options = {}) {
      const { body, icon, tag, silent, data, lang, dir, requireInteraction } = options || {};
      try {
        new window.Notification(title, { body, icon, tag, silent, data, lang, dir, requireInteraction });
        return Promise.resolve();
      } catch (err) {
        return Promise.reject(err);
      }
    };
    proto.getNotifications = function getNotifications() {
      return Promise.resolve([]);
    };
  }

  // Badging API: some apps report unread counts this way instead of the title.
  const define = (name, fn) =>
    Object.defineProperty(navigator, name, { value: fn, writable: true, configurable: true });
  define('setAppBadge', (count) => {
    post('badge', { count: count === undefined ? -1 : Number(count) });
    return Promise.resolve();
  });
  define('clearAppBadge', () => {
    post('badge', { count: 0 });
    return Promise.resolve();
  });
}

// On Google's sign-in page, look like Firefox to scripts too (main.js already rewrites
// the request headers). Otherwise the login is rejected as an "insecure browser".
function googleLoginPatch(ua) {
  const define = (name, value) =>
    Object.defineProperty(Navigator.prototype, name, { get: () => value, configurable: true });
  define('userAgent', ua);
  define('appVersion', ua.slice('Mozilla/'.length));
  define('vendor', '');
  define('userAgentData', undefined);
  try {
    delete window.chrome;
  } catch {
    // not deletable: leave it
  }
}

function runInMainWorld(func, args = []) {
  if (typeof contextBridge.executeInMainWorld === 'function') {
    contextBridge.executeInMainWorld({ func, args });
  } else {
    webFrame.executeJavaScript(`(${func.toString()})(...${JSON.stringify(args)});`);
  }
}

try {
  runInMainWorld(mainWorldPatch);
  const uaArg = process.argv.find((arg) => arg.startsWith('--minimessenger-google-ua='));
  if (uaArg && window.location.hostname === 'accounts.google.com') {
    runInMainWorld(googleLoginPatch, [uaArg.slice(uaArg.indexOf('=') + 1)]);
  }
} catch (err) {
  console.error('minimessenger: failed to patch page', err);
}

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  switch (data.__minimessenger) {
    case 'notification-click':
      ipcRenderer.send('service:notification-click');
      break;
    case 'badge':
      ipcRenderer.send('service:badge', data.count);
      break;
    default:
      break;
  }
});
