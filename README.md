# Engel Capture

A tiny quick-capture PWA for the [Engel-Personal](https://github.com/frank-engel/Engel-Personal) Obsidian vault. No backend, no build step — static HTML/JS that writes straight into the vault repo via the GitHub Contents API. Meant to sit on an Android home screen for 5-second daily capture.

This repo is deliberately public and contains no personal content — just app code. All actual content lives in the private `Engel-Personal` repo.

## What it does

Pick a type, type a sentence, hit Capture:

- **Journal** → appends a timestamped line into today's `Calendar/YYYY-MM-DD.md` in the vault (creating the file from a minimal template if today's note doesn't exist yet)
- **Prayer** (with a People/Church/Life/Praise/Pain/Theology category), **Idea**, **Task**, **Note** → appends one tagged line to the top of `+ Encounters/Inbox.md` in the vault, for later triage with the vault's `process-captures` Claude Code skill

**Task** also gets an optional due date and repeat interval, written in the [Tasks plugin's](https://publish.obsidian.md/tasks/) own emoji syntax (🔁 recurrence, 📅 due date) so the checkbox is immediately live in any Tasks query — no triage needed for it to work. Recurrence needs a due date to recur from, so the app requires one whenever a repeat interval is set.

A 🙏 button next to the settings gear opens a read-only view of `Spaces/Prayer/Prayer List.md`, grouped by whatever `##` categories are currently in the file. That button only renders once a token is saved — with no token configured there's no visible sign the feature exists, so someone picking up the phone without the PAT set up doesn't stumble onto the prayer list.

## One-time setup

1. **Create a fine-grained GitHub token**: [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens) → *Generate new token* → Repository access: **Only select repositories** → `Engel-Personal` → Permissions → **Contents: Read and write**. Nothing else. Copy the token.
2. Open the app (see below), tap the ⚙️ in the top right, paste the token in, confirm the repo owner/name are correct, **Save**. The token is stored only in this browser's local storage — it never goes anywhere but straight to GitHub.
3. On Android Chrome: menu → **Add to Home screen**.

## Hosting

Served as-is via GitHub Pages from this repo (`main` branch, root). No build step — just push and it's live at whatever URL Pages assigns.

## Design notes

- Two destinations only (today's journal note, or the Encounters inbox) — deliberately avoids any "find this heading and splice content in" logic beyond a single fixed heading per file, to keep the client-side logic small and reliable.
- No GitHub Actions, no server — the page calls the Contents API directly (GET for the current file + sha, PUT to update), which is simpler and faster than a repository-dispatch pipeline for something this small.
- The PAT is scoped to exactly one repo's contents, nothing else, so a compromised/lost phone has a small, easily-revocable blast radius.
