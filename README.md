# paperclip-plugin-telegram

[![npm](https://img.shields.io/npm/v/paperclip-plugin-telegram)](https://www.npmjs.com/package/paperclip-plugin-telegram)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Bidirectional Telegram integration for [Paperclip](https://github.com/paperclipai/paperclip). Push agent notifications to Telegram, receive bot commands, approve requests with inline buttons, gather community signals, run multi-agent sessions in threads, process media attachments, register custom commands, and deploy proactive agent suggestions.

Built on the Paperclip plugin SDK and the domain event bridge ([PR #909](https://github.com/paperclipai/paperclip/pull/909)).

## Why this exists

Multiple Paperclip users asked for notifications on the same day the plugin system shipped (2026-03-14):

> "is there a way to have codex/claude check paperclip to see when tasks are done without me prompting it?" - @Choose Liberty, Discord #dev

> "basically to have it 'let me know when its done'" - @Choose Liberty, Discord #dev

> "can claude code check paperclip to see when tasks are done" - @Nascozz, Discord #dev

@dotta (maintainer) responded: "we're also adding issue-changed hooks for plugins so when that lands someone could [make notifications]." The event bridge ([PR #909](https://github.com/paperclipai/paperclip/pull/909)) shipped that same day. @Ryze said "Really excited by the plugins. I had developed a custom plugin bridge that I will now deprecate and migrate over to the new supported plugin system."

This is that plugin.

## What it does

### Notifications (MarkdownV2 with plain text fallback)

- **Issue created** - Title, description, status, priority, assignee, project fields, and a "View Issue" link
- **Issue done** - Completion confirmation with status fields
- **Approval requested** - Interactive **Approve** and **Reject** inline buttons. Click to act without leaving Telegram.
- **Agent error** - Error message with warning indicator
- **Agent run started/finished** - Lifecycle notifications

### Interactive approvals
- Approve/reject inline buttons on every approval notification
- Clicking a button calls the Paperclip API and updates the Telegram message inline
- Callback query acknowledgment with result text

### Per-type chat routing
- `approvalsChatId` - Dedicated chat for approval notifications
- `approvalsTopicId` - Dedicated forum topic for approval notifications
- `errorsChatId` - Dedicated chat for agent errors
- `errorsTopicId` - Dedicated forum topic for agent errors
- `digestChatId` - Dedicated chat for digest notifications
- `digestTopicId` - Dedicated forum topic for digest notifications
- `escalationChatId` - Dedicated chat for agent escalations
- Falls back to `defaultChatId` when per-type chats aren't configured
- Per-company overrides via `/connect`

### Bot commands
- `/status` - Show active agents and recent completions
- `/issues` - List open issues
- `/agents` - List agents with status indicators
- `/approve <id>` - Approve a pending approval
- `/help` - Display all available commands
- `/connect <company>` - Link this chat to a Paperclip company
- `/connect_topic <project-name> [topic-id]` - Map a forum topic to an existing Paperclip project
- `/topics list` - Show forum topic mappings for this chat
- `/topics remove <project-name>` - Remove one forum topic mapping
- `/topics clear` - Remove all forum topic mappings for this chat
- `/acp spawn <agent>` - Start a new agent session in the current thread
- `/acp status` - Check ACP session status
- `/acp cancel` - Cancel a running ACP session
- `/acp close` - Close a completed ACP session
- `/commands import <json>` - Import a workflow command
- `/commands list` - List registered workflow commands
- `/commands run <name> [args]` - Execute a workflow command
- `/commands delete <name>` - Delete a workflow command

### Phase 1: HITL Escalation
- Agents call `escalate_to_human` tool when stuck (low confidence, user request, policy violation, unknown intent)
- Escalation posted to dedicated channel with conversation context, suggested reply, and confidence score
- Inline buttons: Send Suggested Reply, Reply, Override, Dismiss
- Configurable timeout with default actions (`defer`, `auto_reply`, `close`)
- Hold message sent to customer while waiting for human response
- Reply routing back to originating chat via native or ACP transport

### Phase 2: Multi-Agent Group Threads
- Multiple agents per thread (up to 5 configurable via `maxAgentsPerThread`)
- `@mention` routing: address a specific agent by name in a multi-agent thread
- Reply-to routing: reply to an agent's message to route to that agent
- Fallback routing: most recently active agent receives unaddressed messages
- **Handoff**: agents call `handoff_to_agent` tool to transfer work, with optional human approval gate
- **Discuss**: agents call `discuss_with_agent` tool to start back-and-forth conversation loops
- Conversation loops with configurable max turns and human checkpoint pauses
- Stale loop detection (auto-pause when output repeats)
- Output sequencing so multi-agent responses don't interleave
- Native-first spawning: tries Paperclip agent sessions before falling back to ACP
- Auto-spawn on handoff/discuss if target agent isn't already in the thread

### Phase 3: Media-to-Task Pipeline
- Voice messages, audio, video notes, documents, and photos routed to agents
- Voice/audio transcription via Whisper API with transcription preview posted back
- **Brief Agent**: media sent to intake channels is forwarded to a configurable Brief Agent for triage
- Media in active agent threads is routed to the active session (native or ACP)

### Phase 4: Custom Workflow Commands
- `/commands import <json>` - import a multi-step workflow as a custom slash command
- `/commands list` - show all registered custom commands
- `/commands run <name> [args]` - execute a workflow
- `/commands delete <name>` - remove a custom command
- Custom commands invocable directly as `/<name>` (cannot override built-ins)
- **Workflow step types**: `fetch_issue`, `invoke_agent`, `http_request`, `send_message`, `create_issue`, `wait_approval`, `set_state`
- Template interpolation: `{{arg0}}`, `{{args}}`, `{{prev.result}}`, `{{step_id.result}}`
- Per-company command registry

### Phase 5: Proactive Agent Suggestions
- Agents call `register_watch` tool to set up condition-based monitors
- Watch conditions: `gt`, `lt`, `eq`, `ne`, `contains`, `exists` operators on entity fields
- Watches evaluate against issues, agents, or custom state-stored data
- Built-in templates: `invoice-overdue`, `lead-stale`
- Custom templates with `{{field}}` placeholder interpolation
- Rate limiting: configurable max suggestions per hour per company
- Deduplication: same watch+entity won't re-fire within a configurable window (default 24h)
- Scheduled job checks all watches periodically

### Reply routing
- Reply to any bot notification to route your message back to Paperclip
- Replies to issue notifications create issue comments automatically
- Replies to escalation notifications resolve the escalation as a human reply
- Enable/disable with `enableInbound` config toggle (default: true)

### Daily digest
- Configurable digest summaries posted to your Telegram chats
- Modes: `daily` (once), `bidaily` (twice), `tridaily` (three times per day)
- Configure via the `digestMode` config setting
- Includes: tasks completed/created, active agents, in-progress/review/blocked issues

### Forum topic routing
- Map Telegram forum topics to existing Paperclip projects via `/connect_topic`
- Manage mappings with `/topics list`, `/topics remove <project-name>`, and `/topics clear`
- Notifications for a project are routed to its mapped topic
- Requires a group with forum topics enabled

### Notification topic routing
- `approvalsTopicId` routes approval notifications to a dedicated forum topic.
- `errorsTopicId` routes agent error notifications to a dedicated forum topic.
- `digestTopicId` routes daily/bidaily/tridaily digest notifications to a dedicated forum topic.
- If a topic ID is empty, the plugin keeps its existing behavior. Digest messages in forum groups fall back to the General topic.
- `onlyNotifyBoardApprovals` can restrict approval notifications to `request_board_approval` approvals so internal CEO approvals stay inside Paperclip.

## Install

```bash
npm install paperclip-plugin-telegram
```

Or register with your Paperclip instance directly:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"paperclip-plugin-telegram"}'
```

## Setup

1. Open Telegram and chat with [@BotFather](https://t.me/BotFather)
2. Run `/newbot` and follow the prompts to create a bot
3. Save the bot token
4. Send a message to your bot, then run `curl "https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates"` and find the `chat.id` field
5. In Paperclip, go to **Settings -> Secrets -> Create new secret**, paste your bot token as the secret value, and copy the resulting UUID
6. Configure the plugin with the secret UUID in `telegramBotTokenRef` and your chat ID in `defaultChatId`
7. If your Paperclip deployment requires authenticated board mutations, open the plugin settings page from a company context and complete **Board Access Connection**. This stores a Paperclip board API token as a company secret and lets Telegram approval actions authenticate without pasting raw tokens into the plugin config.

## Configuration

| Setting | Required | Description |
|---------|----------|-------------|
| `telegramBotTokenRef` | Yes | Secret UUID for your bot token |
| `defaultChatId` | No | Fallback chat ID for notifications |
| `approvalsChatId` | No | Separate chat for approvals |
| `approvalsTopicId` | No | Forum topic ID for approvals inside the selected approvals/default chat |
| `errorsChatId` | No | Separate chat for errors |
| `errorsTopicId` | No | Forum topic ID for errors inside the selected errors/default chat |
| `digestChatId` | No | Separate chat for digest notifications |
| `digestTopicId` | No | Forum topic ID for digests inside the selected digest/company/default chat |
| `escalationChatId` | No | Dedicated chat for agent escalations |
| `paperclipBaseUrl` | No | Internal Paperclip API URL (default: http://localhost:3100) |
| `paperclipBoardApiTokenRef` | No | Advanced/manual secret reference to a Paperclip board API token used by Telegram approval buttons and `/approve` commands. Prefer the Board Access Connection settings UI when available |
| `paperclipPublicUrl` | No | Public URL for issue links in messages |
| `enableCommands` | No | Enable bot commands (default: true) |
| `enableInbound` | No | Route Telegram replies to issues (default: true) |
| `onlyNotifyBoardApprovals` | No | When enabled, send Telegram approval notifications only for `request_board_approval` approvals |
| `allowedTelegramUserIds` | No | Optional allowlist of Telegram user IDs allowed to use commands, inbound replies, media intake, and inline buttons. Empty means any user is allowed |
| `allowedTelegramChatIds` | No | Optional allowlist of Telegram chat IDs where commands, inbound replies, media intake, and inline buttons are accepted. Empty means any chat is allowed |
| `topicRouting` | No | Map forum topics to projects (default: false) |
| `digestMode` | No | Digest frequency: off, daily, bidaily, tridaily (default: off) |
| `dailyDigestTime` | No | UTC time for digest, HH:MM (default: 09:00) |
| `bidailySecondTime` | No | Second digest time for bidaily mode (default: 17:00) |
| `tridailyTimes` | No | Comma-separated HH:MM times for tridaily (default: 07:00,13:00,19:00) |
| `escalationTimeoutMs` | No | Timeout before default action fires (default: 900000 / 15 min) |
| `escalationDefaultAction` | No | Action on timeout: `defer`, `auto_reply`, `close` (default: `defer`) |
| `escalationHoldMessage` | No | Message sent to customer while waiting |
| `maxAgentsPerThread` | No | Max concurrent agents per thread (default: 5) |
| `briefAgentId` | No | Agent ID for media intake Brief Agent |
| `briefAgentChatIds` | No | Chat IDs that act as media intake channels |
| `transcriptionApiKeyRef` | No | Secret reference to OpenAI API key for Whisper |
| `maxSuggestionsPerHourPerCompany` | No | Rate limit for proactive suggestions (default: 10) |
| `watchDeduplicationWindowMs` | No | Suppress duplicate watch suggestions within this window (default: 86400000 / 24h) |

### Inbound security allowlists

Telegram does not provide a BotFather setting to disable direct messages while still allowing group use. To safely enable `enableCommands` or `enableInbound`, configure one or both allowlists:

- `allowedTelegramUserIds`: who may interact with the bot
- `allowedTelegramChatIds`: where interactions are accepted

If both allowlists are configured, both must match. For example, a user must be on the user allowlist and the message must come from an allowed DM or group chat.

The allowlists apply to:

- bot commands
- inbound replies routed back to Paperclip
- media intake
- inline button callbacks

Leave an allowlist empty only if that dimension should be unrestricted. After changing allowlists, save the plugin settings and restart the plugin if the new values are not picked up immediately.

### Board access for approval actions

Approval buttons and `/approve <approval-id>` call Paperclip approval APIs. Authenticated Paperclip deployments may require a board API token for those mutations.

Use **Board Access Connection** on the plugin settings page to connect board access:

1. Open the Telegram plugin settings page inside a company.
2. Click **Connect board access**.
3. Approve the Paperclip board-access request in the opened window.

The plugin stores the resulting board API token as a Paperclip company secret and keeps only the secret reference in plugin state. The advanced `paperclipBoardApiTokenRef` config field is still supported for manual setups.

## Agent tools

| Tool | Phase | Description |
|------|-------|-------------|
| `escalate_to_human` | 1 | Escalate a conversation to a human when confidence is low |
| `handoff_to_agent` | 2 | Hand off work to another agent in this thread |
| `discuss_with_agent` | 2 | Start a back-and-forth conversation with another agent |
| `register_watch` | 5 | Register a proactive watch that monitors entities and sends suggestions |

## Comparison with PR #407

| Feature | PR #407 | This plugin |
|---------|---------|-------------|
| Push notifications | Yes | Yes |
| Receive messages | No | Yes |
| Bot commands | No | /status, /issues, /agents, /approve, /topics, /acp, /commands |
| Inline buttons | No | Approve/reject on approvals + escalations + handoffs |
| Reply routing | No | Replies become issue comments |
| Topic routing | No | Forum topic = project |
| Daily digest | No | Yes |
| HITL escalation | No | Dedicated channel with suggested replies + timeout |
| Multi-agent threads | No | Up to 5 agents per thread, @mention routing, handoff, discuss |
| Media pipeline | No | Voice transcription, Brief Agent intake |
| Custom commands | No | Importable multi-step workflows |
| Proactive suggestions | No | Watch conditions with built-in sales templates |
| Architecture | Monorepo example | Standalone npm package |

## Migration

### v0.2.1

The `telegramBotTokenRef` and `transcriptionApiKeyRef` fields now require a Paperclip secret reference (a UUID), not the raw token value. If you previously entered your raw bot token in the field, follow these steps to migrate:

1. Go to **Settings -> Secrets -> Create new secret**
2. Paste your Telegram bot token as the secret value and save
3. Copy the resulting UUID
4. Open **Plugin Settings for Telegram Bot** and paste the UUID into "Telegram Bot Token"
5. Save and restart the plugin

The plugin will fail to activate if a raw token (non-UUID) is entered in the field.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

~80 tests covering notifications, approvals, escalation, session registry, media pipeline, custom commands, proactive suggestions, MarkdownV2 formatting, and bot commands.

## Contributing

Issues and PRs welcome at [github.com/mvanhorn/paperclip-plugin-telegram](https://github.com/mvanhorn/paperclip-plugin-telegram).

Auto-publishes to npm on push to `main` via OIDC trusted publishing.

## Credits

[@MatB57](https://github.com/MatB57) - Escalation channel concept, "Chat OS" vision for turning chat plugins into bidirectional agent command centers, and the HITL suggested-reply flow.

[@leeknowsai](https://github.com/leeknowsai) - Worker bootstrap patterns adapted from the Discord plugin.

Inspired by [OpenClaw's Telegram integration](https://github.com/openclaw/openclaw) (grammY, bidirectional messaging, inline buttons) and adapted for the Paperclip plugin SDK.

## License

MIT
