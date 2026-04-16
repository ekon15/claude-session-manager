# Coding Agent Session Manager

A local web UI for browsing, resuming, and managing coding agent sessions (Claude Code and Codex).

## What it does

- Lists all sessions from `~/.claude/projects/` (Claude Code) and `~/.codex/sessions/` (Codex) sorted by most recent
- Filter by Today, This Week, Active (7d), All, or Archived
- Click any session to resume it in an embedded in-browser terminal
- Add notes, titles, and tags to sessions
- Pin important sessions to the top
- Soft-delete sessions (never touches the underlying JSONL files)
- **+ New** opens a fresh session in the browser terminal — choose Claude Code or Codex

## Requirements

- macOS (uses `node-pty` for the embedded terminal)
- [Node.js](https://nodejs.org) >= 18
- [Claude Code](https://claude.ai/code) and/or [Codex](https://github.com/openai/codex) CLI installed and in PATH

## Setup

```bash
git clone https://github.com/ekon15/claude-session-manager
cd claude-session-manager
npm install
npm start
```

Opens automatically at http://localhost:7367.

## Usage

| Action | How |
|--------|-----|
| Resume a session | Click **Resume** on any card |
| Start a new session | Click **+ New ▾** — choose Claude Code or Codex |
| Quick scratch session | Click **⚡ Playground ▾** — same as New, but auto-tags and archives the session when you exit, keeping your list clean |
| Add/edit a note | Click the note area below the session title |
| Edit the title | Click the title text |
| Add a tag | Click **+ tag** |
| Pin to top | Click **⊙** |
| Archive | Click **⊟** |
| Delete | Click **⊗** |
| Copy resume command | Click **Copy** |
| Close terminal panel | Click **✕** (agent keeps running) |
| Reconnect to running session | Click **Resume** again |

## Configuration

Copy `.env.example` to `.env` if you want to customize anything:

```bash
cp .env.example .env
```

Run on a different port:

```bash
npm start -- --port 8080
```

## How it works

Claude Code session data is read from `~/.claude/projects/` and Codex session data from `~/.codex/sessions/`. Metadata (titles, notes, tags, pins, archives) is stored separately in `~/.claude/session-manager.json` — the original session files are never modified.

The embedded terminal uses `node-pty` on the server and xterm.js in the browser, connected over WebSocket. Closing the browser panel detaches without killing the agent process.
