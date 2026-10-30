# Engel Capture

A tiny quick-capture PWA for the [Engel-Personal](https://github.com/frank-engel/Engel-Personal) Obsidian vault. No backend, no build step — static HTML/JS that saves to a local database on the phone and syncs into the vault repo via the GitHub API. Meant to sit on an Android home screen for 5-second daily capture.

This repo is deliberately public and contains no personal content — just app code. All actual content lives in the private `Engel-Personal` repo.

## What it does

Pick a type, type a sentence, hit Capture:

- **Journal** → appends a timestamped line into today's `Calendar/YYYY-MM-DD.md` in the vault (creating the file from a minimal template if today's note doesn't exist yet)
- **Prayer** (with a People/Church/Life/Praise/Pain/Theology category), **Idea**, **Task**, **Note** → appends one tagged line to the top of `+ Encounters/Inbox.md` in the vault, for later triage with the vault's `process-captures` Claude Code skill

**Task** also gets an optional due date and repeat interval, written in the [Tasks plugin's](https://publish.obsidian.md/tasks/) own emoji syntax (🔁 recurrence, 📅 due date) so the checkbox is immediately live in any Tasks query — no triage needed for it to work. Recurrence needs a due date to recur from, so the app requires one whenever a repeat interval is set.

A 🙏 button next to the settings gear opens a read-only view of `Spaces/Prayer/Prayer List.md`, grouped by whatever `##` categories are currently in the file. That button only renders once a token is saved — with no token configured there's no visible sign the feature exists, so someone picking up the phone without the PAT set up doesn't stumble onto the prayer list.

**Check-ins.** Under the Capture button on the Journal tab, **Check in:** Daily Office · Lectio · Workout logs that practice in one tap as an ordinary journal line with a trailing tag, e.g. `_07:12_ — Did the Daily Office. #practice/daily-office`, so the weekly review can count them. Anything already typed in the box becomes the line's text instead of the default sentence. The send waits five seconds, and the status line offers **Undo** for a mis-tap.

**Local-first database.** Every capture is saved to an IndexedDB database on the phone before anything touches the network, and the text box clears as soon as it's saved. The phone is the source of truth; the vault is where entries get synced to. Each entry gets a short id (`j-7k3qxm` for journal, `n-…` for Inbox captures), the phone's time zone, and the date and time it was written, so an entry made offline at 10pm still lands in that day's note. Entries stay on the phone after they sync; ids are not written into the vault yet, so vault lines are exactly what they've always been.

**Sync.** Whatever is waiting goes to the vault as **one commit** (GitHub Git Data API: read the branch head, apply the entries to each file at that commit, write a tree, a commit, and a fast-forward ref update). If something else pushed in between (Obsidian Git, a Claude Code skill), the commit is rebuilt on the new head. A small ↻ badge in the header shows how many entries are waiting. The app syncs on open, on reconnect, when you switch back to it, after saving settings, once a minute while anything is waiting, and when you tap the badge. Editing an existing Note isn't queued; it needs the network.

**Fallback.** Settings → *Send each capture separately (the old way)* switches back to the original path: one Contents API PUT, and one commit, per entry, using the same local queue. Use it if one-commit sync ever misbehaves.

**Upgrading from the outbox version.** The first open of this version moves anything still waiting in the old `outbox` store into the new `entries` store in one transaction and sends it, so nothing queued before the upgrade is stranded.

## One-time setup

1. **Create a fine-grained GitHub token**: [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens) → *Generate new token* → Repository access: **Only select repositories** → `Engel-Personal` → Permissions → **Contents: Read and write**. Nothing else. Copy the token.
2. Open the app (see below), tap the ⚙️ in the top right, paste the token in, confirm the repo owner/name are correct, **Save**. The token is stored only in this browser's local storage — it never goes anywhere but straight to GitHub.
3. On Android Chrome: menu → **Add to Home screen**.

## Hosting

Served as-is via GitHub Pages from this repo (`main` branch, root). No build step — just push and it's live at whatever URL Pages assigns.

## Design notes

- Two destinations only (today's journal note, or the Encounters inbox) — deliberately avoids any "find this heading and splice content in" logic beyond a single fixed heading per file, to keep the client-side logic small and reliable.
- No GitHub Actions, no server — the page calls the GitHub API directly, which is simpler and faster than a repository-dispatch pipeline for something this small.
- An entry only counts as synced after GitHub confirms the ref update. The new commit's sha is remembered before that update, so if the update lands but the response is lost, the next sync sees the commit is already on the branch and doesn't write the lines twice. (The old one-by-one path still has the rare duplicate-on-retry case it always had: a duplicate line, never a lost one.)
- The app asks the browser for persistent storage on start, so the local database isn't evicted under storage pressure.
- The PAT is scoped to exactly one repo's contents, nothing else, so a compromised/lost phone has a small, easily-revocable blast radius.
