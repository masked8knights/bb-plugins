# Copy Session ID

> Install from the [BB Community marketplace](https://github.com/get-bb/marketplace/pull/88) (entry pending review).

This plugin adds **Copy session ID** to the context menu for thread rows in
BB's left sidebar. It copies the row's BB thread/session identifier to the
clipboard and shows a success or error toast.

The built-in sidebar stays in place. The plugin uses BB's trusted frontend
content-script surface to add the item after the host menu opens, and removes
its DOM nodes, observers, listeners, and timers when the plugin reloads or is
disabled.

## Development

From the repository root:

    pnpm install
    pnpm --filter bb-plugin-copy-session-id typecheck
    pnpm --filter bb-plugin-copy-session-id test
    pnpm --filter bb-plugin-copy-session-id build

Install the local plugin into the running BB instance with:

    bb plugin install ./packages/bb-plugin-copy-session-id --yes

After source changes, rebuild and reload:

    bb plugin build ./packages/bb-plugin-copy-session-id
    bb plugin reload copy-session-id

The menu item depends on the host's stable
data-sidebar-thread-id row attribute. The implementation also accepts
data-thread-id and data-session-id for compatibility with older host markup.
