# paperclip-plugin-telegram

[![npm](https://img.shields.io/npm/v/paperclip-plugin-telegram)](https://www.npmjs.com/package/paperclip-plugin-telegram)

Bidirectional Telegram integration for [Paperclip](https://github.com/paperclipai/paperclip). Push agent notifications to Telegram, receive bot commands, approve requests with inline buttons, and route forum topics to projects.

Built on the Paperclip plugin SDK and the domain event bridge ([PR #909](https://github.com/paperclipai/paperclip/pull/909)).

## Features

### Core

- **Push notifications** on issue created, issue done, approval requested, agent error, run lifecycle
- **Bot commands**: `/status`, `/issues`, `/agents`, `/approve`, `/help`, `/connect`, `/connect-topic`, `/acp`, `/commands`
- **Inline buttons** for approve/reject on approval notifications
- **Inbound routing**: reply to a notification in Telegram and it becomes an issue comment in Paperclip
- **Per-company chat routing** with `/connect` command
- **Forum topic routing**: map Telegram topics to Paperclip projects
- **Daily digest**: scheduled summary of agent activity
- **MarkdownV2 formatting** with automatic plain text fallback
- **ACP bridge**: `/acp spawn`, `/acp status`, `/acp cancel`, `/acp close` for managing agent sessions

### Phase 1: HITL Escalation

- Agents call `escalate_to_human` tool when stuck (low confidence, user request, policy violation, unknown intent)
- Escalation posted to dedicated channel with conversation context, suggested reply, and confidence score
- Inline buttons: Send Suggested Reply, Reply, Override, Dismiss
- Configurable timeout with default actions (`defer`, `auto_reply`, `close`)
- Hold message sent to customer while waiting for human response
- Reply routing back to originating chat via native or ACP transport

### Phase 2: Multi-Agent Group Threads

- Multiple agents per thread (up to 5 configurable via `MAX_AGENTS_PER_THREAD`)
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

## Setup

### 1. Create a Telegram bot

1. Open Telegram and chat with [@BotFather](https://t.me/BotFather)
2. Run `/newbot` and follow the prompts
3. Save the bot token

### 2. Get your chat ID

Send a message to your bot, then run:

```bash
curl "https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates"
```

Find the `chat.id` field in the response. For groups, the ID is a negative number.

### 3. Install the plugin

```bash
npm install paperclip-plugin-telegram
```

Or register with your Paperclip instance directly:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"paperclip-plugin-telegram"}'
```

### 4. Store your bot token as a Paperclip secret

The bot token field requires a Paperclip secret reference (a UUID), not the raw token.

1. In Paperclip, go to **Settings → Secrets → Create new secret**
2. Paste your Telegram bot token as the secret value and save
3. Copy the UUID of the created secret
4. Use that UUID in the `telegramBotTokenRef` field below

Do the same for `transcriptionApiKeyRef` if you want Whisper transcription.

### 5. Configure

In your Paperclip instance settings, configure:

| Setting | Required | Description |
|---------|----------|-------------|
| `telegramBotTokenRef` | Yes | Secret UUID for your bot token (see step 4) |
| `defaultChatId` | Yes | Chat ID for notifications |
| `approvalsChatId` | No | Separate chat for approvals |
| `errorsChatId` | No | Separate chat for errors |
| `enableCommands` | No | Enable bot commands (default: true) |
| `enableInbound` | No | Route Telegram replies to issues (default: true) |
| `dailyDigestEnabled` | No | Send daily activity summary |
| `topicRouting` | No | Map forum topics to projects |
| `escalationChatId` | No | Dedicated chat/topic for agent escalations |
| `escalationTimeoutMs` | No | Timeout before default action fires (default: 900000 / 15 min) |
| `escalationDefaultAction` | No | Action on timeout: `defer`, `close`, `retry`, `escalate_further` (default: `defer`) |
| `escalationHoldMessage` | No | Message sent to customer while waiting (default: "Let me check on that - I'll get back to you shortly.") |
| `briefAgentId` | No | Agent ID for the Brief Agent (Phase 3 media intake) |
| `briefAgentChatIds` | No | Chat IDs that act as media intake channels for the Brief Agent |
| `transcriptionApiKeyRef` | No | Secret reference to OpenAI API key for Whisper transcription |
| `maxSuggestionsPerHourPerCompany` | No | Rate limit for proactive suggestions (default: 10) |
| `watchDeduplicationWindowMs` | No | Window before same watch+entity can re-fire (default: 86400000 / 24h) |

### 6. Add bot to group (optional)

If using a group chat:
1. Add the bot to your Telegram group
2. Disable privacy mode via BotFather (`/setprivacy` -> Disable) if you want the bot to see all messages
3. Run `/connect <company-name>` in the group

## How it works

### Notifications (outbound)

When Paperclip events fire (issue created, approval needed, agent error), the plugin formats them as Telegram messages with MarkdownV2 and sends to the configured chat.

Approval notifications include inline Approve/Reject buttons. Clicking a button calls the Paperclip API directly and updates the message to show the resolution.

### Commands (inbound)

The bot registers commands with Telegram's command menu. Users can interact with Paperclip directly:

- `/status` - overview of agents and tasks
- `/issues` - list open issues
- `/agents` - list agents with status
- `/approve <id>` - approve a pending request
- `/connect <company>` - link this chat to a Paperclip company

### Reply routing

When a user replies to a bot notification, the plugin looks up which Paperclip entity that notification was about and posts the reply as an issue comment. This turns Telegram threads into a natural conversation interface for Paperclip issues.

## Comparison with PR #407

| Feature | PR #407 | This plugin |
|---------|---------|-------------|
| Push notifications | Yes | Yes |
| Receive messages | No | Yes |
| Bot commands | No | /status, /issues, /agents, /approve, /acp, /commands |
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

1. Go to **Settings → Secrets → Create new secret**
2. Paste your Telegram bot token as the secret value and save
3. Copy the resulting UUID
4. Open **Plugin Settings for Telegram Bot** and paste the UUID into "Telegram Bot Token"
5. Save and restart the plugin

The plugin will fail to activate if a raw token (non-UUID) is entered in the field.

## Development

```bash
pnpm install
pnpm build
pnpm typecheck
```

## License

MIT

## Credits

[@MatB57](https://github.com/MatB57) - Escalation channel concept, "Chat OS" vision for turning chat plugins into bidirectional agent command centers, and the HITL suggested-reply flow.

[@leeknowsai](https://github.com/leeknowsai) - Worker bootstrap patterns adapted from the Discord plugin.

Inspired by [OpenClaw's Telegram integration](https://github.com/openclaw/openclaw) (grammY, bidirectional messaging, inline buttons) and adapted for the Paperclip plugin SDK.
