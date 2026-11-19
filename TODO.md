# TODO

## Facebook unread count includes non-message notifications

Confirmed: the `(N)` in Facebook's page title counts every Facebook notification,
not only messages, so the sidebar and Dock badges overstate unread messages.

Options (decision pending):

1. **Count from the page DOM (preferred).** Inject a script in the Facebook service
   that reads the Messenger button badge in the top bar (or counts unread threads in
   the chat list) and reports it through the existing `service:badge` path, which
   already wins over the title count. Fall back to the title count when the element
   isn't found. Facebook changes its markup often, so this may break from time to time.
2. **Ignore the title for this service.** Add a per-service option such as
   "badge from title: off". Simple and robust, but Messenger shows no count at all
   (native notifications still work).

Needed for option 1: with unread messages on Facebook, open the service, use
View → Toggle Developer Tools, right-click the Messenger counter in the top bar →
Inspect, and copy the HTML of that element and a few of its parents.

## To observe

- Whether notifications now show the new app icon after the icon cache refresh
  (`lsregister -f` + restarting `usernoted`). If not:
  `sudo rm -rf /Library/Caches/com.apple.iconservices.store` and reboot.
