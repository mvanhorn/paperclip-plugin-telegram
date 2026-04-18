# twb-digital fork notes

This is the TWB-Digital fork of `paperclip-plugin-telegram`. It extends the
upstream plugin with filters and an inbound wake branch so the board gets only
signal-worthy pings and can wake an agent (typically the CEO) by typing in
Telegram. Tracking issue: `TWB-94` (depends on `TWB-93`, `TWB-90`).

## What this fork adds

### Config flags (all backwards-compatible; see `src/manifest.ts` for schemas)

- `notifyOnAgentRunStarted` — default **false**. Previously unconditional at
  worker.js:219. Gated behind this flag to stop chat flooding.
- `notifyOnAgentRunFinished` — default **false**. Previously unconditional at
  worker.js:220. Gated behind this flag.
- `notifyOnIssueBlocked` — default **true**. Subscribes to `issue.updated`,
  forwards when `status === 'blocked'` **and** the issue has a non-null
  `assigneeUserId` (assigned to a human/board member). Agent-assigned
  blockers are ignored.
- `notifyOnBoardMention` — default **true**. Subscribes to
  `issue.comment.created`, forwards only when the comment body contains
  `@<boardUsername>` for any username listed in `boardUsernames`. Word-boundary
  aware (`@jonasX` does not match `@jonas`). Case-insensitive.
- `boardUsernames` — array of handles to watch for. `@` prefix optional.
- `inboxAgentId` — target agent ID for the inbound wake branch. Empty disables.
- `inboxChatIds` — optional chat allow-list. If empty, only `defaultChatId` is
  accepted.

### Inbound wake (TWB-90 requirement)

In `handleUpdate`, after the media branch and bot-command branch and **before**
the reply-routing branch, a new branch fires when **all** hold:

- `inboxAgentId` is set
- message is plain text (not a `/command`, no media)
- message is **not** a reply (so reply-to-bot still routes to its issue
  comment path)
- message has no `message_thread_id` (top-level chat only)
- `chatId` matches `defaultChatId` or one of `inboxChatIds`

The branch creates a new issue assigned to `inboxAgentId` with the Telegram
sender, chat id, and message id in the description, transitions it to `todo`,
and replies "Forwarded to agent — `<identifier>`" in chat. The agent wakes
through the normal Paperclip assignment path.

SDK methods only (`ctx.issues.create`, `ctx.issues.update`, `ctx.metrics.write`,
`ctx.logger`) — no raw `ctx.http.fetch` to loopback.

## Local install

```bash
npm install
npm run build
./scripts/install-twb.sh              # default: ~/.paperclip/plugins
# or: ./scripts/install-twb.sh /custom/plugins/dir
```

The script copies the built package to
`~/.paperclip/plugins/node_modules/paperclip-plugin-telegram-twb/`, rewrites
the package `name` and `PLUGIN_ID` so Paperclip registers it as a distinct
plugin, and registers it in `~/.paperclip/plugins/package.json` as a
`file:` dependency.

After install:

1. Disable the stock `paperclip-plugin-telegram` instance in the Paperclip
   UI — both cannot long-poll the same bot token.
2. Configure the new `paperclip-plugin-telegram-twb` instance:
   - `telegramBotTokenRef` (same secret UUID the stock plugin used)
   - `defaultChatId` (board chat)
   - `boardUsernames: ["jonas"]` (or equivalent)
   - `inboxAgentId` (CEO agent ID)
   - flip `notifyOnAgentRunStarted` / `notifyOnAgentRunFinished` to `true`
     only if you actually want started/finished pings
3. Restart Paperclip or the plugin worker.
4. Smoke-test: send a plain text message in the board chat → the CEO agent
   should wake (visible in Paperclip as a new `[Inbox] …` issue assigned to
   the CEO).

## Rebasing on upstream

```bash
git fetch upstream
git rebase upstream/main
# resolve conflicts in src/constants.ts, src/manifest.ts, src/worker.ts,
# src/formatters.ts, tests/twb-filters.test.ts
npm install
npm run typecheck
npm test                 # twb-filters.test.ts must pass
npm run build
./scripts/install-twb.sh
```

The changes are additive and confined to five files — rebase should stay
manageable. If upstream renames `PLUGIN_ID` or adds a matching feature, drop
the duplicated code from this fork and re-run `install-twb.sh`.
