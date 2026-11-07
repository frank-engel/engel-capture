// Engel Capture — quick-capture PWA for the Engel-Personal Obsidian vault.
// No backend: every capture is saved to a local IndexedDB database first,
// then synced into the vault repo through the GitHub API using a PAT stored
// in this browser's localStorage. See README.md for the full design.

const DEFAULT_OWNER = "frank-engel";
const DEFAULT_REPO = "Engel-Personal";
const ENCOUNTERS_PATH = "+ Encounters/Inbox.md";
const CAPTURES_HEADING = "## Captures";
const JOURNAL_HEADING = "## Journal";
const PRAYER_LIST_PATH = "Spaces/Prayer/Prayer List.md";

const state = {
  type: "journal",
  category: "people",
};

const els = {
  typeRow: document.getElementById("typeRow"),
  categoryRow: document.getElementById("categoryRow"),
  taskFields: document.getElementById("taskFields"),
  dueDateInput: document.getElementById("dueDateInput"),
  recurIntervalInput: document.getElementById("recurIntervalInput"),
  recurUnitInput: document.getElementById("recurUnitInput"),
  recurWhenDoneInput: document.getElementById("recurWhenDoneInput"),
  whenDoneLabel: document.getElementById("whenDoneLabel"),
  entryText: document.getElementById("entryText"),
  submitBtn: document.getElementById("submitBtn"),
  status: document.getElementById("status"),
  settingsBtn: document.getElementById("settingsBtn"),
  settingsDialog: document.getElementById("settingsDialog"),
  tokenInput: document.getElementById("tokenInput"),
  ownerInput: document.getElementById("ownerInput"),
  repoInput: document.getElementById("repoInput"),
  saveSettingsBtn: document.getElementById("saveSettingsBtn"),
  clearTokenBtn: document.getElementById("clearTokenBtn"),
  captureView: document.getElementById("captureView"),
  prayerView: document.getElementById("prayerView"),
  prayerNavBtn: document.getElementById("prayerNavBtn"),
  prayerBackBtn: document.getElementById("prayerBackBtn"),
  pendingBtn: document.getElementById("pendingBtn"),
  pendingCount: document.getElementById("pendingCount"),
  checkinRow: document.getElementById("checkinRow"),
  oneByOneInput: document.getElementById("oneByOneInput"),
  practiceInputs: [1, 2, 3].map((n) => document.getElementById(`practice${n}Input`)),
  themeInput: document.getElementById("themeInput"),
  todayTitle: document.getElementById("todayTitle"),
};

// ---------- appearance ----------
//
// Auto follows the phone's light/dark setting; Light or Dark pins it. The
// choice is applied before first paint by a small script in index.html; this
// keeps it in step afterwards and colors the phone's status bar to match.

const THEME_KEY = "ec_theme";

function getTheme() {
  const t = localStorage.getItem(THEME_KEY);
  return t === "light" || t === "dark" ? t : "auto";
}

function applyTheme(theme = getTheme()) {
  const root = document.documentElement;
  if (theme === "auto") delete root.dataset.theme;
  else root.dataset.theme = theme;
  const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && bg) meta.setAttribute("content", bg);
}

els.themeInput.addEventListener("change", () => {
  // Takes effect right away, so you can see it before closing Settings.
  localStorage.setItem(THEME_KEY, els.themeInput.value);
  applyTheme();
});
window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => applyTheme());
applyTheme();

// ---------- today's page ----------
//
// The header shows today's date ("Saturday, Nov 7") instead of the app name:
// this is today's page. Refreshed when you come back to the app.

function renderTodayTitle() {
  els.todayTitle.textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long", month: "short", day: "numeric",
  });
}
renderTodayTitle();

// A quiet "it's safe" moment on the Capture button: its label fades to a
// check for a beat, plus a tiny buzz where the phone supports it. Errors
// and anything needing action still use the status line.
let ackTimer = null;
function acknowledge(label = "Captured") {
  els.submitBtn.dataset.ack = "✓ " + label;
  els.submitBtn.classList.add("acked");
  try { navigator.vibrate?.(35); } catch { /* not supported */ }
  clearTimeout(ackTimer);
  ackTimer = setTimeout(() => els.submitBtn.classList.remove("acked"), 1400);
}

// ---------- settings ----------

function getSettings() {
  return {
    token: localStorage.getItem("ec_token") || "",
    owner: localStorage.getItem("ec_owner") || DEFAULT_OWNER,
    repo: localStorage.getItem("ec_repo") || DEFAULT_REPO,
    oneByOne: localStorage.getItem("ec_one_by_one") === "1",
  };
}

function openSettings() {
  const s = getSettings();
  els.tokenInput.value = s.token;
  els.ownerInput.value = s.owner;
  els.repoInput.value = s.repo;
  els.oneByOneInput.checked = s.oneByOne;
  const labels = getPractices().map((p) => p.label);
  els.practiceInputs.forEach((input, i) => { input.value = labels[i] || ""; });
  els.themeInput.value = getTheme();
  els.settingsDialog.showModal();
}

// The Prayer List nav button only appears once a token is saved — no
// dangling affordance hinting at prayer content for anyone picking up
// the phone without it configured.
function updateNavVisibility() {
  els.prayerNavBtn.hidden = !getSettings().token;
}

els.settingsBtn.addEventListener("click", openSettings);

els.saveSettingsBtn.addEventListener("click", (e) => {
  e.preventDefault();
  localStorage.setItem("ec_token", els.tokenInput.value.trim());
  localStorage.setItem("ec_owner", els.ownerInput.value.trim() || DEFAULT_OWNER);
  localStorage.setItem("ec_repo", els.repoInput.value.trim() || DEFAULT_REPO);
  localStorage.setItem("ec_one_by_one", els.oneByOneInput.checked ? "1" : "0");
  savePracticeLabels(els.practiceInputs.map((input) => input.value));
  els.settingsDialog.close();
  setStatus("Settings saved.", "ok");
  updateNavVisibility();
  syncNow();
});

els.clearTokenBtn.addEventListener("click", (e) => {
  e.preventDefault();
  localStorage.removeItem("ec_token");
  els.tokenInput.value = "";
  updateNavVisibility();
  if (!els.prayerView.classList.contains("view-hidden")) showView("capture");
});

updateNavVisibility();

// ---------- UI ----------

els.typeRow.addEventListener("click", async (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  // Once the Prayer List lives in the app, the Prayer chip is a shortcut to
  // it. Anything already typed opens as a new prayer, "Name: text" split out.
  if (chip.dataset.type === "prayer" && getSettings().token && (await prayerListImported())) {
    const typed = els.entryText.value.trim();
    await openPrayerView();
    if (typed) {
      const { name, via, summary } = splitPersonPrefix(flat(typed));
      openRequestDialog(null, { personName: name || "", summary });
      if (via) pels.reqVia.value = via;
      els.entryText.value = "";
    }
    return;
  }
  state.type = chip.dataset.type;
  [...els.typeRow.children].forEach((c) => c.classList.toggle("active", c === chip));
  els.categoryRow.classList.toggle("show", state.type === "prayer");
  els.taskFields.classList.toggle("show", state.type === "task");
  els.checkinRow.classList.toggle("show", state.type === "journal");
  tels.toggle.hidden = state.type !== "journal";
  tels.section.hidden = state.type !== "journal";
  if (state.type !== "journal") setTaskToggle(false);
  els.captureView.classList.toggle("calendar-mode", state.type === "calendar");
  if (state.type === "calendar") openCalendar();
});

els.categoryRow.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  state.category = chip.dataset.category;
  [...els.categoryRow.children].forEach((c) => c.classList.toggle("active", c === chip));
});

els.recurUnitInput.addEventListener("change", () => {
  const repeating = !!els.recurUnitInput.value;
  els.recurIntervalInput.disabled = !repeating;
  els.whenDoneLabel.style.display = repeating ? "flex" : "none";
  if (!repeating) els.recurWhenDoneInput.checked = false;
});

function resetTaskFields() {
  els.dueDateInput.value = "";
  els.recurUnitInput.value = "";
  els.recurIntervalInput.value = "1";
  els.recurIntervalInput.disabled = true;
  els.recurWhenDoneInput.checked = false;
  els.whenDoneLabel.style.display = "none";
}

function setStatus(msg, kind) {
  els.status.textContent = msg;
  els.status.className = kind || "";
}

// ---------- prayer list view ----------
//
// The view itself lives in prayer.js. This just switches screens.

function showView(view) {
  els.captureView.classList.toggle("view-hidden", view !== "capture");
  els.prayerView.classList.toggle("view-hidden", view !== "prayer");
}

els.prayerNavBtn.addEventListener("click", openPrayerView);
els.prayerBackBtn.addEventListener("click", () => showView("capture"));

// ---------- time ----------

function pad(n) { return String(n).padStart(2, "0"); }

function nowParts(d = new Date()) {
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

// ---------- base64 (UTF-8 safe) ----------

function b64Encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

function b64Decode(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ---------- GitHub API ----------

function apiUrl(path, owner, repo) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${owner}/${repo}/contents/${encoded}`;
}

// JSON call against /repos/{owner}/{repo}{route}. Errors keep the
// "failed: <status>" wording queuedMessage() looks for, plus err.status.
async function gh(method, route, body) {
  const { token, owner, repo } = getSettings();
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = new Error(`GitHub ${method} ${route || "/"} failed: ${res.status} ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// `ref` (a commit sha) reads the file as of that commit instead of the
// default branch's tip, so a sync builds on exactly the head it read.
async function getFile(path, ref) {
  const { token, owner, repo } = getSettings();
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const res = await fetch(apiUrl(path, owner, repo) + query, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return { content: b64Decode(json.content), sha: json.sha };
}

async function putFile(path, content, sha, message) {
  const { token, owner, repo } = getSettings();
  const body = {
    message,
    content: b64Encode(content),
  };
  if (sha) body.sha = sha;
  const res = await fetch(apiUrl(path, owner, repo), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub PUT ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ---------- content shaping ----------

function insertUnderHeading(lines, heading, insertLines, atTop) {
  const headingIdx = lines.findIndex((l) => l.trim() === heading);
  if (headingIdx === -1) {
    // Heading missing (unexpected) — just append at the end of the file.
    return lines.concat([""], insertLines);
  }
  let nextHeadingIdx = lines.findIndex(
    (l, i) => i > headingIdx && /^#{1,6}\s/.test(l)
  );
  if (nextHeadingIdx === -1) nextHeadingIdx = lines.length;

  const before = lines.slice(0, headingIdx + 1);
  const section = lines.slice(headingIdx + 1, nextHeadingIdx);
  const after = lines.slice(nextHeadingIdx);

  const newSection = atTop ? insertLines.concat(section) : section.concat(insertLines);
  return before.concat(newSection, after);
}

function fallbackDailyNote(date) {
  return [
    "---",
    'up: "[[Home]]"',
    `date: ${date}`,
    "tags:",
    "  - daily",
    "---",
    `# ${date}`,
    "",
    JOURNAL_HEADING,
    "",
    "## Prayer / Gratitude",
    "",
    "## Tasks",
    "",
    "## Sparks",
    "",
  ].join("\n");
}

// Every vault write goes through applyEntry(): it takes a file's current
// text (null if the file doesn't exist yet) and returns it with one entry
// added. The lines are exactly the ones the app has always written; the
// local database only changes *when* they get sent, not what they say.
// An entry carries the date and time it was written, not sent, so one that
// sat on the phone overnight still lands in the day it was written.

function entryPath(entry) {
  return entry.type === "journal" ? `Calendar/${entry.local_date}.md` : ENCOUNTERS_PATH;
}

// Check-in tags ride at the end of the text as #tags; plain captures have none.
function entryText(entry) {
  const tags = (entry.tags || []).map((t) => `#${t}`).join(" ");
  return tags ? `${entry.body} ${tags}` : entry.body;
}

function applyJournal(content, entry) {
  const lines = (content ?? fallbackDailyNote(entry.local_date)).split("\n");
  const block = [`_${entry.local_time}_ — ${entryText(entry)}`, ""];
  return insertUnderHeading(lines, JOURNAL_HEADING, block, false).join("\n");
}

function fallbackInbox() {
  return [
    "---",
    'up: "[[Home]]"',
    "tags:",
    "  - reference",
    "---",
    "# Inbox",
    "",
    CAPTURES_HEADING,
    "",
  ].join("\n");
}

// Builds the trailing Tasks-plugin fields for a task line, e.g.
// " 🔁 every 2 weeks 📅 2026-09-05". Tasks plugin's documented field
// order is priority, then recurrence, then dates — recurrence before due.
function buildTaskSuffix() {
  const due = els.dueDateInput.value;
  const unit = els.recurUnitInput.value;
  let suffix = "";

  if (unit) {
    const interval = Math.max(1, parseInt(els.recurIntervalInput.value, 10) || 1);
    const unitWord = interval === 1 ? unit : `${unit}s`;
    const amount = interval === 1 ? "" : `${interval} `;
    const whenDone = els.recurWhenDoneInput.checked ? " when done" : "";
    suffix += ` 🔁 every ${amount}${unitWord}${whenDone}`;
  }
  if (due) {
    suffix += ` 📅 ${due}`;
  }
  return suffix;
}

// Splits multi-line text into a properly-indented Markdown list item: the
// first physical line carries the prefix (and, for tasks, the trailing
// metadata so the Tasks plugin still sees it on the task's own line), and
// any further lines are indented two spaces so they read as a continuation
// of the same bullet instead of breaking the list — and so a later parse
// can tell them apart from unrelated content that follows.
function buildCaptureLines(prefix, text, suffix) {
  const [first, ...rest] = text.split("\n");
  const firstLine = prefix + first + (suffix || "");
  const restLines = rest.map((l) => (l ? `  ${l}` : ""));
  return [firstLine, ...restLines];
}

function applyEncounter(content, entry) {
  const lines = (content ?? fallbackInbox()).split("\n");
  const { type, local_date: date, local_time: time } = entry;

  let prefix;
  if (type === "task") {
    prefix = `- [ ] #capture/task ${date} ${time} — `;
  } else if (type === "prayer") {
    prefix = `- #capture/prayer/${entry.category} ${date} — `;
  } else {
    prefix = `- #capture/${type} ${date} — `;
  }

  const entryLines = buildCaptureLines(prefix, entryText(entry), entry.task_suffix);
  return insertUnderHeading(lines, CAPTURES_HEADING, entryLines, true).join("\n");
}

function applyEntry(content, entry) {
  return entry.type === "journal" ? applyJournal(content, entry) : applyEncounter(content, entry);
}

function entryCommitMessage(entry) {
  const stamp = `${entry.local_date} ${entry.local_time}`;
  return entry.type === "journal" ? `Journal: ${stamp}` : `Capture (${entry.type}): ${stamp}`;
}

// The old send path: one Contents API GET + PUT, and so one commit, per
// entry. Still used when "Send each capture separately" is on in Settings,
// and as the last resort when this browser has no IndexedDB.
async function sendEntryDirect(entry) {
  const path = entryPath(entry);
  const existing = await getFile(path);
  const updated = applyEntry(existing ? existing.content : null, entry);
  await putFile(path, updated, existing ? existing.sha : null, entryCommitMessage(entry));
}

// ---------- local database ----------
//
// The phone is the source of truth. Every capture is saved as an entry in
// IndexedDB before any network call, and the text box clears as soon as it
// is saved. An entry stays sync_state "pending" until GitHub confirms it
// landed in the vault, then flips to "synced" and stays on the phone.
//
// Database "engel-capture":
//   v1  outbox   the old send queue (PR #1). Kept only so leftovers can be
//                imported; nothing new is ever written to it.
//   v2  entries  one row per capture, keyed by a short id ('j-7k3qxm' for
//                journal, 'n-…' for everything that goes to the Inbox).
//   v3  persons, prayer_requests, prayer_updates, meta — the Prayer List
//                (see prayer.js). 'w-…' people, 'p-…' requests, 'u-…' updates.
//   v4  tasks    the app's copy of task lines, keyed by their ^t-… block id
//                (see tasks.js).
//
// The ids aren't written into the vault yet, so vault lines stay exactly
// as they were. They're there for the later phases' read-back.

const DB_NAME = "engel-capture";
const DB_VERSION = 4;
const OUTBOX_STORE = "outbox";
const ENTRIES_STORE = "entries";
const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        reject(new Error("IndexedDB unavailable"));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
          db.createObjectStore(OUTBOX_STORE, { keyPath: "id", autoIncrement: true });
        }
        if (!db.objectStoreNames.contains(ENTRIES_STORE)) {
          const entries = db.createObjectStore(ENTRIES_STORE, { keyPath: "id" });
          entries.createIndex("sync_state", "sync_state");
          entries.createIndex("local_date", "local_date");
        }
        if (!db.objectStoreNames.contains(PERSONS_STORE)) {
          db.createObjectStore(PERSONS_STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(REQUESTS_STORE)) {
          const reqs = db.createObjectStore(REQUESTS_STORE, { keyPath: "id" });
          reqs.createIndex("status", "status");
        }
        if (!db.objectStoreNames.contains(UPDATES_STORE)) {
          const ups = db.createObjectStore(UPDATES_STORE, { keyPath: "id" });
          ups.createIndex("request_id", "request_id");
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(TASKS_STORE)) {
          db.createObjectStore(TASKS_STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // Let a newer version of the app (another tab, after an update)
        // upgrade the database instead of being blocked by this one.
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

// Runs fn(stores, tx) in one transaction and resolves once it commits, with
// whatever fn last put in `out.result`. Any failure aborts the whole thing.
async function dbTx(storeNames, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    const out = { result: undefined };
    const stores = Object.fromEntries(storeNames.map((n) => [n, tx.objectStore(n)]));
    fn(stores, out, tx);
    tx.oncomplete = () => resolve(out.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function newId(type) {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const tail = [...bytes].map((b) => ID_ALPHABET[b & 31]).join("");
  return `${type === "journal" ? "j" : "n"}-${tail}`;
}

function phoneTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; }
}

// Everything needed to write the entry later, frozen at the moment it was
// written — including task fields, which get reset as soon as it's saved.
// local_date/local_time follow the phone's clock and time zone, so the
// daily note is the one for the day it was written where Frank was.
let lastCreatedAt = 0;

function buildEntry({ type, category, body, taskSuffix, tags }) {
  const now = new Date();
  const { date, time } = nowParts(now);
  // Strictly increasing, so two captures in the same millisecond still
  // sort (and land in the vault) in the order they were made.
  const createdAt = Math.max(now.getTime(), lastCreatedAt + 1);
  lastCreatedAt = createdAt;
  return {
    id: newId(type),
    type,
    category: type === "prayer" ? category : null,
    body,
    tags: tags || [],
    task_suffix: taskSuffix || "",
    occurred_at: now.toISOString(),
    tz: phoneTimeZone(),
    local_date: date,
    local_time: time,
    created_at: createdAt,
    updated_at: createdAt,
    sync_state: "pending",
    synced_at: null,
    commit_sha: null,
  };
}

// `add` refuses a duplicate id, so a (one-in-a-billion) collision just
// rolls a new id and tries again.
async function saveEntry(entry) {
  for (let attempt = 0; ; attempt++) {
    try {
      await dbTx([ENTRIES_STORE], "readwrite", (s) => { s[ENTRIES_STORE].add(entry); });
      return entry;
    } catch (err) {
      if (err && err.name === "ConstraintError" && attempt < 5) {
        entry.id = newId(entry.type);
        continue;
      }
      throw err;
    }
  }
}

async function pendingEntries() {
  const rows = await dbTx([ENTRIES_STORE], "readonly", (s, out) => {
    const req = s[ENTRIES_STORE].index("sync_state").getAll("pending");
    req.onsuccess = () => { out.result = req.result; };
  });
  // Oldest first, so captures land in the order they were written.
  return rows.sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
}

const pendingCount = () =>
  dbTx([ENTRIES_STORE], "readonly", (s, out) => {
    const req = s[ENTRIES_STORE].index("sync_state").count("pending");
    req.onsuccess = () => { out.result = req.result; };
  });

function markSynced(ids, commitSha) {
  const at = Date.now();
  return dbTx([ENTRIES_STORE], "readwrite", (s) => {
    const store = s[ENTRIES_STORE];
    for (const id of ids) {
      const req = store.get(id);
      req.onsuccess = () => {
        const row = req.result;
        if (!row || row.sync_state !== "pending") return;
        store.put({ ...row, sync_state: "synced", synced_at: at, commit_sha: commitSha || null, updated_at: at });
      };
    }
  });
}

// Removes an entry only while it's still pending (the check-in Undo).
// Resolves true if it was removed, false if it had already gone out.
function deleteIfPending(id) {
  return dbTx([ENTRIES_STORE], "readwrite", (s, out) => {
    const store = s[ENTRIES_STORE];
    out.result = false;
    const req = store.get(id);
    req.onsuccess = () => {
      if (req.result && req.result.sync_state === "pending") {
        store.delete(id);
        out.result = true;
      }
    };
  });
}

// Moves anything still sitting in the old v1 outbox into `entries` as
// pending, in one transaction: either every leftover is imported and the
// outbox emptied, or nothing changes. Runs before every sync, so even a
// capture an out-of-date tab queued after the upgrade gets picked up.
function importLegacyOutbox() {
  return dbTx([OUTBOX_STORE, ENTRIES_STORE], "readwrite", (s, out) => {
    const outbox = s[OUTBOX_STORE];
    const entries = s[ENTRIES_STORE];
    const keysReq = entries.getAllKeys();
    keysReq.onsuccess = () => {
      const taken = new Set(keysReq.result);
      const oldReq = outbox.getAll();
      oldReq.onsuccess = () => {
        out.result = oldReq.result.length;
        for (const old of oldReq.result) {
          let id;
          do { id = newId(old.type); } while (taken.has(id));
          taken.add(id);
          entries.add({
            id,
            type: old.type,
            category: old.type === "prayer" ? old.category : null,
            body: old.text,
            tags: [],
            task_suffix: old.suffix || "",
            occurred_at: new Date(old.createdAt).toISOString(),
            tz: phoneTimeZone(),
            local_date: old.when.date,
            local_time: old.when.time,
            created_at: old.createdAt,
            updated_at: Date.now(),
            sync_state: "pending",
            synced_at: null,
            commit_sha: null,
          });
        }
        outbox.clear();
      };
    };
  });
}

// Asks the browser not to evict the database under storage pressure. An
// installed PWA usually gets this granted without a prompt.
async function requestPersistentStorage() {
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch { /* best effort */ }
}

// ---------- sync ----------
//
// All pending entries go out together as one commit, built with the Git
// Data API: read the branch head, fetch each file the entries touch at that
// commit, apply the entries oldest first, then write a tree, a commit and a
// fast-forward ref update. If someone else pushed in between (Obsidian Git,
// a Claude Code skill) the ref update is refused and the whole thing is
// rebuilt on the new head, which is safe because every write is an append.
//
// Before the ref update the new commit's sha is remembered. If the update
// went through but the response was lost, the next sync sees that commit
// is already on the branch and marks those entries synced instead of
// writing them twice.
//
// The "Send each capture separately" setting switches back to the old
// path: one Contents API PUT, and one commit, per entry.

const RETRY_INTERVAL_MS = 60 * 1000;
const PENDING_COMMIT_KEY = "ec_pending_commit";

let syncChain = Promise.resolve();
let lastSendError = null;

function branchKey() {
  const { owner, repo } = getSettings();
  return `ec_branch:${owner}/${repo}`;
}

async function defaultBranch() {
  const cached = localStorage.getItem(branchKey());
  if (cached) return cached;
  const info = await gh("GET", "");
  const branch = info.default_branch || "main";
  localStorage.setItem(branchKey(), branch);
  return branch;
}

function readPendingCommit() {
  try {
    const p = JSON.parse(localStorage.getItem(PENDING_COMMIT_KEY) || "null");
    const { owner, repo } = getSettings();
    return p && p.owner === owner && p.repo === repo ? p : null;
  } catch { return null; }
}

// Settles a commit whose ref update may or may not have landed last time.
async function settlePendingCommit(headSha) {
  const p = readPendingCommit();
  if (!p) return;
  let landed = p.sha === headSha;
  if (!landed) {
    try {
      const cmp = await gh("GET", `/compare/${p.sha}...${headSha}`);
      landed = cmp.status === "ahead" || cmp.status === "identical";
    } catch (err) {
      if (err.status !== 404) throw err; // unknown commit: it never landed
    }
  }
  if (landed) {
    await markSynced(p.ids, p.sha);
    if (p.prayer) await markPrayerSynced(p.prayer.rev, p.prayer.blobSha);
  }
  localStorage.removeItem(PENDING_COMMIT_KEY);
}

function batchCommitMessage(entries, withPrayer, taskCount = 0) {
  const taskLine = taskCount === 1 ? "- 1 task updated" : `- ${taskCount} tasks updated`;
  if (!entries.length) {
    const { date, time } = nowParts();
    if (withPrayer && taskCount) return [`Prayer List: ${date} ${time}`, "", taskLine].join("\n");
    return withPrayer ? `Prayer List: ${date} ${time}` : `Tasks: ${date} ${time}`;
  }
  if (withPrayer || taskCount) {
    return [
      batchCommitMessage(entries, false),
      "",
      ...(withPrayer ? ["- Prayer List updated"] : []),
      ...(taskCount ? [taskLine] : []),
    ].join("\n");
  }
  if (entries.length === 1) return entryCommitMessage(entries[0]);
  const first = entries[0], last = entries[entries.length - 1];
  return [
    `Capture sync: ${entries.length} entries, ${first.local_date} ${first.local_time} to ${last.local_date} ${last.local_time}`,
    "",
    ...entries.map((e) => `- ${entryCommitMessage(e)}`),
  ].join("\n");
}

// `withPrayer` adds a regenerated Prayer List.md to the same commit when the
// app's prayer data changed since the last sync (prayer.js planPrayerWrite).
async function syncAsOneCommit(entries, withPrayer) {
  const branch = await defaultBranch();
  for (let attempt = 0; attempt < 4; attempt++) {
    const ref = await gh("GET", `/git/ref/heads/${encodeURIComponent(branch)}`);
    const headSha = ref.object.sha;

    await settlePendingCommit(headSha);
    const still = new Set((await pendingEntries()).map((e) => e.id));
    entries = entries.filter((e) => still.has(e.id));
    const prayer = withPrayer ? await planPrayerWrite(headSha) : null;

    const files = new Map();
    if (prayer) files.set(PRAYER_LIST_PATH, prayer.content);
    for (const entry of entries) {
      const path = entryPath(entry);
      if (!files.has(path)) {
        const existing = await getFile(path, headSha);
        files.set(path, existing ? existing.content : null);
      }
      files.set(path, applyEntry(files.get(path), entry));
    }
    // Task changes go on top, so a task in today's note builds on today's
    // journal lines. Every task write is idempotent (see tasks.js).
    const tasks = await planTaskWrites(files, async (path) => {
      const existing = await getFile(path, headSha);
      return existing ? existing.content : null;
    });
    if (!entries.length && !prayer && !tasks.changed) {
      // Nothing to write: any queued task change is already in the vault.
      await markTasksSynced(tasks);
      return entries;
    }

    const head = await gh("GET", `/git/commits/${headSha}`);

    const tree = await gh("POST", "/git/trees", {
      base_tree: head.tree.sha,
      tree: [...files].map(([path, content]) => ({ path, mode: "100644", type: "blob", content })),
    });
    const commit = await gh("POST", "/git/commits", {
      message: batchCommitMessage(entries, !!prayer, tasks.changed ? tasks.count : 0),
      tree: tree.sha,
      parents: [headSha],
    });

    const { owner, repo } = getSettings();
    const ids = entries.map((e) => e.id);
    const prayerDone = prayer && {
      rev: prayer.rev,
      blobSha: (tree.tree.find((t) => t.path === PRAYER_LIST_PATH) || {}).sha || null,
    };
    localStorage.setItem(PENDING_COMMIT_KEY, JSON.stringify({ owner, repo, sha: commit.sha, ids, prayer: prayerDone }));
    try {
      await gh("PATCH", `/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha, force: false });
    } catch (err) {
      // 422 = not a fast-forward: someone pushed since we read the head.
      // Our commit is now orphaned, so forget it and rebuild on the new head.
      if (err.status === 422) {
        localStorage.removeItem(PENDING_COMMIT_KEY);
        continue;
      }
      throw err;
    }
    await markSynced(ids, commit.sha);
    if (prayerDone) await markPrayerSynced(prayerDone.rev, prayerDone.blobSha);
    await markTasksSynced(tasks);
    localStorage.removeItem(PENDING_COMMIT_KEY);
    return entries;
  }
  throw new Error("GitHub sync failed: 409 the branch kept moving, will retry");
}

async function updatePendingBadge() {
  let n = 0;
  try { n = await pendingCount(); } catch { /* no IndexedDB: nothing can be pending */ }
  if (await prayerNeedsSync()) n += 1; // the Prayer List counts as one waiting change
  n += (await pendingTasks()).length;
  els.pendingBtn.hidden = n === 0;
  els.pendingCount.textContent = String(n);
  els.pendingBtn.title = n === 1 ? "1 capture waiting to send — tap to retry" : `${n} captures waiting to send — tap to retry`;
  return n;
}

// Sends pending entries and resolves to the ids that went through. Calls
// are chained rather than skipped while one is running, so a capture made
// mid-sync still gets its own pass instead of looking stuck.
function syncNow() {
  const run = syncChain.then(runSync);
  syncChain = run.catch(() => {});
  return run;
}

async function runSync() {
  const sent = new Set();
  try {
    await importLegacyOutbox();
  } catch (err) {
    console.error(err);
  }
  if (!getSettings().token) {
    await updatePendingBadge();
    return sent;
  }
  pushVaultSettingsIfNeeded().catch((err) => console.error(err));
  try {
    const run = async () => {
      const entries = await pendingEntries();
      const withPrayer = await prayerNeedsSync();
      const withTasks = (await pendingTasks()).length > 0;
      if (!entries.length && !withPrayer && !withTasks) return;
      // One-by-one marks each entry as it goes, so a failure part-way
      // still reports the ones that made it.
      const done = [];
      try {
        if (getSettings().oneByOne) {
          for (const e of entries) {
            await sendEntryDirect(e);
            await markSynced([e.id], null);
            done.push(e);
          }
          if (withPrayer) await sendPrayerDirect();
          if (withTasks) await sendTasksDirect();
        } else {
          done.push(...(await syncAsOneCommit(entries, withPrayer)));
        }
        lastSendError = null;
      } catch (err) {
        console.error(err);
        lastSendError = err;
      }
      done.forEach((e) => sent.add(e.id));
    };
    // Web Locks keep two open tabs from sending the same entry twice.
    if (navigator.locks) await navigator.locks.request("engel-capture-outbox", run);
    else await run();
  } catch (err) {
    console.error(err);
  }
  const remaining = await updatePendingBadge();
  // Read task lines back (due dates, check-offs made in Obsidian), and show
  // whatever this sync changed.
  refreshTasksFromVault(sent.size > 0).catch((err) => console.error(err)).finally(renderTasks);
  // A submit that sent straight through clears this and shows its own check.
  if (sent.size && remaining === 0) {
    setStatus(sent.size === 1 ? "Queued capture sent." : `${sent.size} queued captures sent.`, "ok");
  }
  return sent;
}

// A 401/403/404 almost always means the token or repo settings are wrong,
// so say so. Anything else (no network, 5xx, a busy branch) just needs a retry.
function queuedMessage() {
  if (!getSettings().token) return "Saved on this device — add your GitHub token to send it.";
  const m = lastSendError && /failed: (\d{3})/.exec(lastSendError.message);
  if (m && ["401", "403", "404"].includes(m[1])) {
    return "Saved on this device — GitHub refused it, check your token/settings.";
  }
  return navigator.onLine === false
    ? "Saved offline — will send when you're back online."
    : "Saved on this device — will retry shortly.";
}

function setQueuedStatus() {
  setStatus(queuedMessage(), "pending");
}

els.pendingBtn.addEventListener("click", async () => {
  setStatus("Retrying…", "pending");
  await syncNow();
  if (await updatePendingBadge()) setQueuedStatus();
});

window.addEventListener("online", syncNow);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") syncNow();
});
setInterval(async () => {
  if (document.visibilityState === "visible" && !els.pendingBtn.hidden) syncNow();
}, RETRY_INTERVAL_MS);
requestPersistentStorage();
syncNow();

// ---------- submit ----------

// Saves the entry on the phone, then tries to send it. Resolves to "sent",
// "queued", or "failed" (no IndexedDB and the direct send failed too).
// onSaved runs the moment the entry is safe: right after the local save,
// or, with no IndexedDB, once the direct send has gone through.
// `delaySync` holds the send back a few seconds so a check-in can be undone.
async function captureEntry(entry, { onSaved = () => {}, delaySync = 0 } = {}) {
  let saved = false;
  try {
    await saveEntry(entry);
    saved = true;
  } catch (err) {
    // No IndexedDB (e.g. some private modes) — fall back to a direct send
    // so capture still works, just without the safety net.
    console.error(err);
  }

  if (saved) {
    onSaved();
    if (!getSettings().token) {
      await updatePendingBadge();
      return "queued";
    }
    if (delaySync) {
      await updatePendingBadge();
      setTimeout(syncNow, delaySync);
      return "queued";
    }
    const sent = await syncNow();
    return sent.has(entry.id) ? "sent" : "queued";
  }

  if (!getSettings().token) return "failed";
  try {
    await sendEntryDirect(entry);
    onSaved();
    return "sent";
  } catch (err) {
    console.error(err);
    return "failed";
  }
}

els.submitBtn.addEventListener("click", async () => {
  const text = els.entryText.value.trim();
  if (!text) {
    setStatus("Nothing to capture.", "err");
    return;
  }
  if (state.type === "task" && els.recurUnitInput.value && !els.dueDateInput.value) {
    setStatus("Recurring tasks need a due date to recur from.", "err");
    return;
  }
  if (state.type === "journal" && taskUi.on) {
    try {
      await captureTask(text);
      els.entryText.value = "";
      setTaskToggle(false);
      renderTasks();
      acknowledge("Task added");
      if (!getSettings().token) {
        setQueuedStatus();
      } else {
        setStatus("");
        await syncNow();
        if (await updatePendingBadge()) setQueuedStatus();
        else setStatus("");
      }
    } catch (err) {
      console.error(err);
      setStatus("Couldn't save that task — try again.", "err");
    }
    return;
  }
  if (state.type === "prayer" && (await prayerListImported())) {
    try {
      await capturePrayerRequest(text, state.category);
      els.entryText.value = "";
      setStatus("");
      acknowledge("Prayer added");
    } catch (err) {
      console.error(err);
      setStatus("Couldn't save that prayer — try again.", "err");
    }
    return;
  }

  const entry = buildEntry({
    type: state.type,
    category: state.category,
    body: text,
    taskSuffix: state.type === "task" ? buildTaskSuffix() : "",
  });

  els.submitBtn.disabled = true;
  setStatus("Sending…", "pending");
  const outcome = await captureEntry(entry, {
    // The text is safe now, so clear the box right away — ready for the
    // next thought whether or not the send goes through.
    onSaved: () => {
      els.entryText.value = "";
      if (entry.type === "task") resetTaskFields();
      els.submitBtn.disabled = false;
    },
  });
  els.submitBtn.disabled = false;

  if (outcome === "sent") {
    setStatus("");
    acknowledge();
  } else if (outcome === "queued") {
    // Safe on the phone, just not sent yet: still worth the check.
    acknowledge();
    setQueuedStatus();
    if (!getSettings().token) openSettings();
  } else if (!getSettings().token) {
    setStatus("Set up your GitHub token first.", "err");
    openSettings();
  } else {
    setStatus("Failed — check your token/settings and try again.", "err");
  }
});

// ---------- practice check-ins ----------
//
// One tap logs a practice as an ordinary journal line with a trailing tag,
// e.g. "_07:12_ — Did the Daily Office. #practice/daily-office", so the
// weekly review can count them without reading prose. Anything already in
// the box becomes the line's text instead of the default sentence. The send
// waits a few seconds so a mis-tap can be undone.

// Which practices get a chip is a setting (up to 3). The tag is a slug of
// the label, so "Daily Office", "Lectio" and "Workout" keep the tags they
// have always had, and the weekly review keeps counting the same way.
const MAX_PRACTICES = 3;
const PRACTICES_KEY = "ec_practices";
const DEFAULT_PRACTICES = ["Daily Office", "Lectio", "Workout"];
const PRACTICE_TEXT = {
  "daily-office": "Did the Daily Office.",
  lectio: "Did Lectio Divina.",
  workout: "Worked out.",
};

function practiceKey(label) {
  return label.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "practice";
}

function getPractices() {
  let labels = DEFAULT_PRACTICES;
  try {
    const saved = JSON.parse(localStorage.getItem(PRACTICES_KEY) || "null");
    if (Array.isArray(saved)) labels = saved;
  } catch { /* bad value: use the defaults */ }
  const seen = new Set();
  const out = [];
  for (const raw of labels) {
    const label = String(raw).trim();
    const key = label && practiceKey(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label, text: PRACTICE_TEXT[key] || `Checked in: ${label}.` });
    if (out.length === MAX_PRACTICES) break;
  }
  return out;
}

function savePracticeLabels(labels) {
  const before = JSON.stringify(getPractices());
  localStorage.setItem(PRACTICES_KEY, JSON.stringify(labels.map((l) => l.trim()).filter(Boolean)));
  if (JSON.stringify(getPractices()) !== before) {
    localStorage.setItem(VAULT_SETTINGS_DIRTY_KEY, "1");
    renderCheckinChips();
  }
}

function renderCheckinChips() {
  for (const chip of els.checkinRow.querySelectorAll(".chip")) chip.remove();
  for (const p of getPractices()) {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.dataset.practice = p.key;
    chip.textContent = p.label;
    els.checkinRow.appendChild(chip);
  }
  els.checkinRow.querySelector(".checkin-label").hidden = !getPractices().length;
  refreshCheckinMarks();
}

// The evening check-in runs in the vault (a GitHub Action), so it needs the
// practice list too. It lives in .journal-app/settings.json, written on its
// own whenever the list changes and retried on later syncs until it lands.
const VAULT_SETTINGS_PATH = ".journal-app/settings.json";
const VAULT_SETTINGS_DIRTY_KEY = "ec_vault_settings_dirty";

async function pushVaultSettingsIfNeeded() {
  // Unset counts as dirty, so the file is written once even if the list
  // is never edited.
  if (localStorage.getItem(VAULT_SETTINGS_DIRTY_KEY) === "0" || !getSettings().token) return;
  const content = JSON.stringify({
    practices: getPractices().map(({ key, label }) => ({ key, label })),
    updated_at: new Date().toISOString(),
  }, null, 2) + "\n";
  const existing = await getFile(VAULT_SETTINGS_PATH);
  await putFile(VAULT_SETTINGS_PATH, content, existing && existing.sha, "App settings: daily practices");
  localStorage.setItem(VAULT_SETTINGS_DIRTY_KEY, "0");
}

const CHECKIN_UNDO_MS = 5000;

function setStatusWithUndo(msg, onUndo) {
  setStatus(msg + " ", "ok");
  const link = document.createElement("a");
  link.href = "#";
  link.textContent = "Undo";
  link.addEventListener("click", (e) => {
    e.preventDefault();
    onUndo();
  });
  els.status.appendChild(link);
  setTimeout(() => link.remove(), CHECKIN_UNDO_MS);
}

// Done-today marks: a practice chip turns green with a ✓ once a check-in for
// it is saved on this phone today (the phone's date, like the daily note).
// Entries stay on the phone after they sync, so the local database is enough.
async function refreshCheckinMarks() {
  let done = new Set();
  try {
    const today = nowParts().date;
    const rows = await dbTx([ENTRIES_STORE], "readonly", (s, out) => {
      const req = s[ENTRIES_STORE].index("local_date").getAll(today);
      req.onsuccess = () => { out.result = req.result; };
    });
    for (const row of rows || []) {
      for (const tag of row.tags || []) if (tag.startsWith("practice/")) done.add(tag.slice(9));
    }
  } catch { /* no IndexedDB: no marks */ }
  for (const chip of els.checkinRow.querySelectorAll(".chip")) {
    const key = chip.dataset.practice;
    const isDone = done.has(key);
    chip.classList.toggle("done", isDone);
    const practice = getPractices().find((p) => p.key === key);
    chip.textContent = (isDone ? "✓ " : "") + (practice ? practice.label : key);
  }
}

els.checkinRow.addEventListener("click", async (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const key = chip.dataset.practice;
  const practice = getPractices().find((p) => p.key === key);
  if (!practice) return;
  const typed = els.entryText.value.trim();
  const entry = buildEntry({ type: "journal", body: typed || practice.text, tags: [`practice/${key}`] });

  const outcome = await captureEntry(entry, {
    onSaved: () => { if (typed) els.entryText.value = ""; },
    delaySync: CHECKIN_UNDO_MS,
  });
  refreshCheckinMarks();
  if (outcome === "failed") {
    setStatus("Failed — check your token/settings and try again.", "err");
    return;
  }
  if (outcome === "sent") {
    setStatus(`Logged ${practice.label}.`, "ok");
    return;
  }
  setStatusWithUndo(`Logged ${practice.label}.`, async () => {
    let removed = false;
    try { removed = await deleteIfPending(entry.id); } catch (err) { console.error(err); }
    await updatePendingBadge();
    refreshCheckinMarks();
    if (removed) {
      if (typed && !els.entryText.value) els.entryText.value = typed;
      setStatus(`Removed ${practice.label} check-in.`, "pending");
    } else {
      setStatus("Already sent — delete the line in Obsidian if it was a mistake.", "err");
    }
  });
});

renderCheckinChips();
initTasks();
// Re-check on return to the app, so yesterday's marks clear after midnight.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    refreshCheckinMarks();
    renderTodayTitle();
  }
});

// Cmd/Ctrl+Enter submits from the textarea.
els.entryText.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    els.submitBtn.click();
  }
});

// ---------- service worker (app-shell caching for installability) ----------

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
