# Ritual Notifier — Requirements

## Status: 🔴 TODO (P1)

## Problem
When a ritual runs (especially in background or long-running workflows),
there's no way to get notified when phases complete or approval is needed.

## Goals

### NOTIFY-1: Channel notifications
- Send messages to Telegram/Discord/Slack when:
  - Ritual starts
  - Phase completes (with artifacts)
  - Approval required (with approval instructions)
  - Ritual completes (success/failure)
  - Phase fails (with error details)

### NOTIFY-2: Inline approval
- Approval requests include buttons (Telegram inline keyboard)
- User can approve/reject directly from notification
- Notifier sends approval back to engine via state file

### NOTIFY-3: Configuration
- Channel config in ritual.yml:
  ```yaml
  config:
    notify:
      channel: telegram
      chat_id: 123456
      events: [approval_required, phase_complete, ritual_complete]
  ```

## Dependencies
- ritual-engine (done) — notifier hooks into phase transitions
- Channel plugin (Telegram/Discord) — notifier uses OpenClaw message tool or direct API

## Design Options

### Option A: Use OpenClaw message tool
Notifier calls OpenClaw's `message` tool (same as harness/notifier.rs does).
Works if ritual runs inside OpenClaw agent.

### Option B: Direct channel API
Notifier has its own Telegram/Discord API client.
Works standalone (outside OpenClaw).

### Decision: Option A first (simpler), Option B later (standalone)

## Acceptance Criteria
- `gid ritual run` sends notifications to configured channel
- Approval requests show up with buttons
- Clicking "Approve" advances the ritual
- Works when ritual runs in background
