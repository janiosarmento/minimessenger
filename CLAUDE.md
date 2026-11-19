# MiniMessenger

Personal, minimal macOS multi-messenger (Rambox/Ferdium replacement). Web
versions of WhatsApp, Telegram, Mattermost and Facebook Messenger in one
window, with native notifications and Dock/sidebar badges. Single user, no
distribution, no frills: reliability of those services matters more than features.

## Commands

```bash
npm start              # run from source (dev instance)
npm run dist           # electron-builder --mac dir + ad-hoc codesign
npm run install-app    # dist + copy to /Applications (quits running app first)
python3 scripts/make-icon.py <image.png>   # regenerate build/icon.{png,icns}
```

- `npm run install-app` quits the running MiniMessenger. Logins survive (persistent partitions).
- Don't leave a dev instance (`npm start`) running. The single-instance lock makes
  the installed app focus the dev window instead of opening. Kill dev runs by PID
  (main `Electron` process and its `npm exec` parent), not with a partial `pkill -f`,
  because that once killed only the network helper and left a half-dead window open.
- After changing UI/main code, rebuild with `npm run install-app`; the user runs the
  installed app, not `npm start`.

## Layout

```
src/main.js             main process: window, WebContentsView per service, menus, IPC, badges
src/config.js           load/save/validate config (userData/config.json), default services
src/i18n.js             language resolution (setting or OS) and t(key, vars)
src/locales/*.json      UI strings: en (fallback) and pt-BR
src/preload-service.js  preload for service pages: patches Notification / SW notifications / Badging API
src/preload-ui.js       contextBridge API (`window.minimessenger`) for the sidebar/settings UI
src/ui/                 index.html, ui.js, style.css: sidebar + settings panel (plain DOM, no framework)
scripts/install.sh      build, copy to /Applications, clear quarantine xattr, verify signature
scripts/make-icon.py    icon pipeline (Pillow + iconutil)
assets/icon-source.png  original icon art (transparent PNG supplied by the user)
build/pt_BR.lproj/      InfoPlist.strings (Portuguese mic/camera prompts), copied into the bundle
build/icon.{png,icns}   generated app icon (committed; referenced by package.json build.mac.icon)
```

## Architecture and decisions

- **Electron** (v45 at creation). Chosen over Swift/WKWebView for web-app compatibility
  and free native notifications. Tauri/Rust is not an option: the user's team uses
  Bash/Python/basic Go only.
- One `WebContentsView` per enabled service, all created at startup, toggled with
  `setVisible`. `backgroundThrottling: false` keeps hidden services connected.
- Session per service: partition `persist:service-<id>`. The id is stable, so editing
  a service's URL keeps its login. Deleting a service in settings calls
  `clearStorageData` on its partition; disabling keeps the data.
- User agent: strips `Electron/x` and `MiniMessenger/x` so sites (WhatsApp) see plain Chrome.
- Sidebar shows all services; disabled ones are dimmed and not clickable. Right-click
  on an icon opens a native menu (built in main via `ui:service-menu`): Refresh, and
  Disable/Enable, which goes through `applyServices` like the settings Save.
- Window close only hides it (notifications keep working); ⌘Q quits.
- Links / `window.open` go to the default browser (`shell.openExternal`, http/https/mailto/tel only).
- Failed main-frame loads and renderer crashes are retried every 15 s.
- Permissions: notifications, media, clipboard-read, pointerLock, openExternal and
  speaker-selection are granted only when the requesting URL is on the service's site
  (`siteOf`: approximate registrable domain, so `m.facebook.com` matches `www.facebook.com`).
  Fullscreen and clipboard writes are allowed everywhere. Notifications also follow the
  per-service toggle; toggling it reloads the service so the page re-reads the permission.
  Cross-site navigation inside a view is allowed (SSO logins) but loses those permissions.
- Service views only navigate to http/https/about/blob; anything else (a dropped file,
  `mailto:`) is blocked and handed to `openExternal`.

### Languages

- English and Portuguese (Brazil). Setting `language` in config: `system` (default),
  `en` or `pt-BR`. `system` uses the first supported entry of
  `app.getPreferredSystemLanguages()` (any `pt-*` → pt-BR), otherwise English.
  This list honors the per-app language in macOS System Settings.
- Main process translates menus, context menus, dialogs and validation errors
  (`ConfigError` carries a key; logs use English). The UI gets the strings via
  `ui:get-i18n` and fills `data-i18n`, `data-i18n-html`, `data-i18n-title`.
- Changing the language in settings applies live: menu rebuilt, `i18n` event to the UI
  (unsaved table edits are kept).
- All role menu items get explicit labels, because Electron's role labels are English.
  Items macOS adds itself (Start Dictation, Emoji & Symbols…) follow the OS language,
  not the in-app setting.
- `electronLanguages: [en, pt_BR]` strips other `.lproj` so Cocoa only picks these two.
- New UI text: add the key to both `src/locales/*.json`.

### Notifications

- Electron shows web `Notification`s natively. The preload replaces `window.Notification`
  in the main world with a subclass that `postMessage`s on click, and the main process
  then shows the window and selects that service.
- Electron does not display service worker (persistent) notifications, so
  `ServiceWorkerRegistration.prototype.showNotification` is rerouted to `new Notification`.
- Main-world injection uses `contextBridge.executeInMainWorld` (fallback `webFrame.executeJavaScript`).

### Badges

- Unread count is parsed from the page title: `(N) …` is the count, and a leading `*`
  (Mattermost: unread without mentions) shows a grey dot in the sidebar.
- `navigator.setAppBadge` / `clearAppBadge` are overridden too. When a page reported via
  the Badging API, that value wins over the title count.
- Dock badge = sum of counts (dots are not counted).
- **Confirmed by the user:** Telegram Web A's unread count shows correctly (title or
  setAppBadge; which one was not checked).
- **Confirmed by the user:** Facebook's title count includes every Facebook notification,
  not only messages. Not fixed yet.

### Sidebar icons

- Electron's `page-favicon-updated` lists icons in document order (often 16×16 first,
  which made Mattermost blurry). `refreshPageIcon` runs a script in the page listing
  `link[rel~=icon|apple-touch-icon]` with sizes and picks the largest (≥ 48 px).
- Priority: per-service custom `icon` URL (settings) > largest page icon > reported favicon >
  cached icon (`iconCache` in config, last page icon seen) > letter avatar. The cache keeps
  disabled services' icons and is overwritten as soon as the page reports one again.

## Config

`~/Library/Application Support/MiniMessenger/config.json`:
`{ services: [{id, name, url, icon, enabled, notifications}], window, selectedId, iconCache, language }`.

- The app writes this file while running (selection, window bounds). **Quit the app
  before editing it by hand**, or the change gets overwritten.
- An invalid config is renamed to `config.json.broken-<ts>` and defaults are used.
- `DEFAULT_SERVICES` in `src/config.js` applies only on first run (no config file):
  WhatsApp, Telegram, Messenger. Mattermost has no generic URL, so users add their own.
- Messenger uses `https://www.facebook.com/messages/` (messenger.com and Meta's desktop
  app were discontinued in late 2025).

## Build and signing

- Electron ≥ 45.4 has no postinstall: `node_modules/electron` downloads its binary on
  the first `require('electron')` (or `npx install-electron`).
- The repo is public (MIT). No binaries are published; README explains building and `xattr`.

- No Apple Developer identity: `build.mac.identity: null` in electron-builder, then
  `codesign --force --deep --sign -` (ad-hoc), which Apple Silicon requires to run.
- `install.sh` also runs `xattr -dr com.apple.quarantine` (locally built apps aren't
  quarantined, kept as a safety net at the user's request).
- Info.plist gets mic/camera usage strings (voice messages, calls).

## Icon pipeline

`scripts/make-icon.py` accepts either a transparent PNG or a rounded square on white
(it flood-fills the background from the corners). For transparent sources it zeroes
alpha < 8 (haze) and forces alpha ≥ 245 to 255. The user's art had interior alpha 253,
which made the whole icon slightly translucent. Output follows Apple's grid: an 824 px
body centered on a 1024 px canvas, with a soft drop shadow. Check the result over dark
and light backgrounds before installing.

macOS caches app icons, so after an icon change notifications kept showing the old one
even though the bundle was correct. `install.sh` now runs `lsregister -f` and restarts
`usernoted`. If that isn't enough, run `sudo rm -rf /Library/Caches/com.apple.iconservices.store`
and reboot.

## Conventions

- All code, comments and commit messages in English. UI strings live in `src/locales/`.
- Conversation with the user in Portuguese.
- Keep it minimal: no frameworks in the UI, no extra dependencies without need.
- Pending work goes in `TODO.md` at the repo root (no beads).
- No AI co-author trailers in commits.

## Ideas not done yet

- Hibernate rarely used services to save memory. This would stop their notifications,
  so never for the main ones.
- Git remote: not configured yet; the user will pick one.
