# Antigravity Account Switcher

**Switch between multiple Google accounts (with AI Pro subscriptions) seamlessly — directly inside Antigravity IDE.**

---

## Features

- **🎨 Built-in UI Panel** — A beautiful dark-mode panel in the sidebar for managing all your saved profiles at a glance.
- **⚡ One-click Switch** — Switch to any saved Google account with a single click. The IDE automatically restarts with the new session active.
- **💾 Save Profiles** — Capture your current logged-in Google session and give it a name (e.g. "Pro Account", "Work", "Personal").
- **🗑 Delete Profiles** — Remove profiles you no longer need directly from the UI.
- **📌 Status Bar Shortcut** — Quick access button in the bottom status bar to open the panel at any time.
- **🔒 Secure & Local** — All profile data stays on your machine under `~/.gemini/antigravity-account-switcher-profiles`. Nothing is uploaded.

---

## How to Use

### 1. Open the Panel
Click the **Account Switcher** icon in the **Activity Bar** (left sidebar) or click the **"Account Switcher"** button in the status bar at the bottom right.

### 2. Save Your Current Session
While logged in with a Google account in Antigravity IDE:
1. Type a name in the input field (e.g. `"Pro Account"`)
2. Click **"Salva Account Corrente"**
3. Your session is saved locally.

### 3. Switch Between Accounts
1. Log in with a different Google account in the IDE.
2. Save that session too (e.g. `"Work Account"`).
3. From now on, click ⚡ next to any saved profile to switch instantly.
4. The IDE will reload with the selected account active.

---

## Commands

Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and search for:

| Command | Description |
|---|---|
| `Antigravity: Open Account Switcher` | Opens the sidebar panel |
| `Antigravity: Save Current Account Profile` | Saves the current session via prompt |
| `Antigravity: Switch Google Account` | Opens a quick-pick list to switch profiles |

---

## Requirements

- Antigravity IDE (VS Code-compatible)
- Be logged in with your Google account before saving a profile

---

## How it Works

The extension copies the active browser session folder (`~/.gemini/antigravity-browser-profile`) to a named directory inside `~/.gemini/antigravity-account-switcher-profiles/`. When switching, it swaps the active folder and reloads the IDE window — maintaining OAuth tokens without requiring a new login.

---

*Made with ⚡ by gfiore88*
