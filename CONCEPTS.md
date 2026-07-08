# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Telegram notification domain

### Paperclip Agent
A Paperclip-controlled worker identity that owns or performs work and may emit events that the Telegram plugin turns into messages.

### Agent Run
One execution attempt by a Paperclip Agent. Run lifecycle events are useful for machine correlation and debugging, but they are usually lower signal than failures or approvals in human chat channels.

### Telegram Notification
A message sent by the plugin from Paperclip state or events into Telegram. Notifications should lead with human-readable context and reserve internal identifiers for links, metadata, or compact fallback labels.
