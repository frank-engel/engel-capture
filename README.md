# Engel Capture

A tiny quick-capture PWA for the [Engel-Personal](https://github.com/frank-engel/Engel-Personal) Obsidian vault. No backend, no build step — static HTML/JS that saves to a local database on the phone and syncs into the vault repo via the GitHub API. Meant to sit on an Android home screen for 5-second daily capture.

This repo is deliberately public and contains no personal content — just app code. All actual content lives in the private `Engel-Personal` repo.

## What it does

Pick a type, type a sentence, hit Capture:

- **Journal** → appends a timestamped line into today's `Calendar/YYYY-MM-DD.md` in the vault (creating the file from a minimal template if today's note doesn't exist yet)
- **Prayer** (with a People/Church/Self/Praise category) → straight onto the app's Prayer List once it's been imported (see below); before that, an Inbox line like the others
- **Note** → appends one tagged line to the top of `+ Encounters/Inbox.md` in the vault, for later triage with the vault's `process-captures` Claude Code skill

The Idea and Task chips were removed in Phase 2 (2026-11-01): ideas are a `#idea` typed in a journal line, and tasks now use the **☐ Task** toggle below. Inbox lines they wrote before are untouched, and the task-field code is still in `app.js`, unused.

**Tasks.** On the Journal tab, tapping **☐ Task** next to Capture (it turns to ☑ and the button reads *Add task*) makes the next capture a task instead of a journal line. It's written as an Obsidian Tasks line under `## Tasks` in that day's note, ending in a block id: `- [ ] Call Dr. Le about labs ^t-7k3qxm`. Anything typed after the text, like `📅 2026-11-06`, goes in as typed. The toggle turns itself off after each task, so a plain capture is still zero decisions.

The bottom of the Journal tab shows **Today**: at most five open tasks. Overdue and due-today tasks come first, then tasks pinned to today (`⏳`), then tasks captured today without a date. Nothing is shown in red; an overdue task just says "since Oct 11". Everything else open is folded under **Later (n)**, where **+ Today** pins a task to today by adding `⏳` with today's date. Ticking a box checks the task off (`- [x] … ✅ 2026-11-03`), and tasks finished today stay on the list, struck through, so a mis-tap can be unticked. Each change goes out a few seconds later in the next sync commit. Repeating (`🔁`) tasks can't be ticked on the phone, because Obsidian has to create the next occurrence.

The vault is where tasks live; the phone keeps a copy (IndexedDB store `tasks`) so the list works offline. After each sync the app re-reads its tasks by their `^t-` id, so a due date, priority, or check-off added in Obsidian or by a Claude skill shows up. If a task has moved (for example, `process-captures` filed it into `Atlas/Tasks MOC.md`, or the weekly review swept it into `Tasks Archive.md`), it's found there by id. Open tasks in Tasks MOC that the app didn't write appear too. When you check one of those off on the phone, it gets a `^t-` id in the same edit. Every task write is idempotent, so a retried or half-finished sync never writes a line twice.

**Prayer List.** A 🙏 button next to the settings gear opens the Prayer List, which the app now keeps itself (Phase 2). The first time, **Import Prayer List** reads `Spaces/Prayer/Prayer List.md` into the phone's database as people, requests and dated updates; from then on the app owns that file and rewrites it whole when it syncs, in the same commit as any waiting captures. The view shows active prayers by category (People, Church, Self, Praise; the old Life, Pain and Theology fold into Self) with the answered ones folded away at the bottom, plus a search box. On each prayer:

- **Log update** adds a dated note (or, left blank, just marks that you prayed for it that day), with a 🙌 Praise toggle. In the file the date joins the line's date chain and a note sits under it as an indented sub-bullet.
- **Edit** rewords it, changes the person, relation, who shared it, or category, removes a mistaken update, marks it answered or archived (with an optional note), reopens it, or deletes it.
- **+ New prayer** adds one. Once the list is imported, the capture screen's Prayer chip just opens this view; if something is already typed it opens as a new prayer, so `Jordan: surgery Tuesday` files under Jordan.

A prayer you've logged an update on, added, or edited today gets a green edge, a **✓ Today** mark and a quieter **✓ Logged** button, and the top of the list counts how many you've prayed through today, so a pass down the list shows what's left.

Each line in the file ends with a short Obsidian block id (`^p-4m2vda`, `^u-…` on updates) so the app can match it again. If the file is edited outside the app (Obsidian, a Claude skill), the next sync notices, stops writing it, and the Prayer view asks whether to keep the app's list or re-import the vault's version, so nothing is silently overwritten. Changes made in a quick burst go out together a few seconds after the last one. The 🙏 button only renders once a token is saved, so someone picking up the phone without the PAT set up doesn't stumble onto the prayer list.

**Check-ins.** Under the Capture button on the Journal tab, **Check in:** Daily Office · Lectio · Workout logs that practice in one tap as an ordinary journal line with a trailing tag, e.g. `_07:12_ — Did the Daily Office. #practice/daily-office`, so the weekly review can count them. Anything already typed in the box becomes the line's text instead of the default sentence. The send waits five seconds, and the status line offers **Undo** for a mis-tap. Once a practice is logged today its chip turns green with a ✓ ("✓ Workout"), counted from the check-ins saved on this phone for today's date, so you can see at a glance what's done; it resets at midnight. Tapping a green chip still logs another one.

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
