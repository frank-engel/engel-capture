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
  editingNoteBlock: null,
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
  recentNotes: document.getElementById("recentNotes"),
  recentNotesList: document.getElementById("recentNotesList"),
  cancelEditLink: document.getElementById("cancelEditLink"),
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
  prayerRefreshBtn: document.getElementById("prayerRefreshBtn"),
  prayerStatus: document.getElementById("prayerStatus"),
  prayerContent: document.getElementById("prayerContent"),
  pendingBtn: document.getElementById("pendingBtn"),
  pendingCount: document.getElementById("pendingCount"),
  checkinRow: document.getElementById("checkinRow"),
  oneByOneInput: document.getElementById("oneByOneInput"),
};

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

els.typeRow.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  state.type = chip.dataset.type;
  setEditingNote(null);
  [...els.typeRow.children].forEach((c) => c.classList.toggle("active", c === chip));
  els.categoryRow.classList.toggle("show", state.type === "prayer");
  els.taskFields.classList.toggle("show", state.type === "task");
  els.recentNotes.classList.toggle("show", state.type === "note");
  els.checkinRow.classList.toggle("show", state.type === "journal");
  if (state.type === "note") loadRecentNotes();
});

els.cancelEditLink.addEventListener("click", (e) => {
  e.preventDefault();
  setEditingNote(null);
  els.entryText.value = "";
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

function showView(view) {
  els.captureView.classList.toggle("view-hidden", view !== "capture");
  els.prayerView.classList.toggle("view-hidden", view !== "prayer");
}

function setPrayerStatus(msg, kind) {
  els.prayerStatus.textContent = msg;
  els.prayerStatus.className = kind || "";
}

// Groups lines under each "## Heading" into { title, items }. Reads
// whatever headings are actually in the file rather than a hardcoded
// category list, so renaming/adding a category on the Prayer List needs
// no matching change here.
function parsePrayerList(md) {
  const sections = [];
  let current = null;
  for (const line of md.split("\n")) {
    const heading = /^##\s+(.*)/.exec(line);
    if (heading) {
      current = { title: heading[1].trim(), items: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const item = /^-\s+(.*)/.exec(line);
    if (item) current.items.push(item[1].trim());
  }
  return sections;
}

function renderPrayerList(sections) {
  els.prayerContent.innerHTML = "";
  if (!sections.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "No categories found.";
    els.prayerContent.appendChild(p);
    return;
  }
  for (const section of sections) {
    const h2 = document.createElement("h2");
    h2.textContent = section.title;
    els.prayerContent.appendChild(h2);
    if (!section.items.length) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "Nothing here.";
      els.prayerContent.appendChild(p);
      continue;
    }
    const ul = document.createElement("ul");
    for (const item of section.items) {
      const li = document.createElement("li");
      li.textContent = item; // textContent, not innerHTML — entries are untrusted text
      ul.appendChild(li);
    }
    els.prayerContent.appendChild(ul);
  }
}

async function loadPrayerList() {
  setPrayerStatus("Loading…", "pending");
  els.prayerContent.innerHTML = "";
  try {
    const file = await getFile(PRAYER_LIST_PATH);
    if (!file) {
      setPrayerStatus("Prayer List.md not found.", "err");
      return;
    }
    renderPrayerList(parsePrayerList(file.content));
    setPrayerStatus("", "");
  } catch (err) {
    console.error(err);
    setPrayerStatus("Failed to load — check your token/settings.", "err");
  }
}

els.prayerNavBtn.addEventListener("click", () => {
  showView("prayer");
  loadPrayerList();
});
els.prayerBackBtn.addEventListener("click", () => showView("capture"));
els.prayerRefreshBtn.addEventListener("click", loadPrayerList);

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

// ---------- recent notes ----------
//
// A capture's text can itself contain newlines (multi-line textarea input).
// applyEncounter writes those as an indented list continuation (two
// leading spaces), so a block's continuation lines are exactly the ones
// that are blank or indented — anything else (unrelated vault content,
// another capture, a heading) ends the block. Without the indent check
// this would happily swallow everything up to the next heading, capture
// or not.

const NOTE_LINE_RE = /^- #capture\/note \d{4}-\d{2}-\d{2} — /;
const CAPTURE_START_RE = /^-\s(?:\[.\]\s)?#capture\//;

let currentNoteBlocks = [];

function isBlockContinuation(line) {
  return line === "" || line.startsWith("  ");
}

function capturesSection(content) {
  const lines = content.split("\n");
  const headingIdx = lines.findIndex((l) => l.trim() === CAPTURES_HEADING);
  if (headingIdx === -1) return [];
  let nextHeadingIdx = lines.findIndex(
    (l, i) => i > headingIdx && /^#{1,6}\s/.test(l)
  );
  if (nextHeadingIdx === -1) nextHeadingIdx = lines.length;
  return lines.slice(headingIdx + 1, nextHeadingIdx);
}

function captureBlocks(section) {
  const blocks = [];
  let current = null;
  for (const line of section) {
    if (CAPTURE_START_RE.test(line)) {
      current = [line];
      blocks.push(current);
    } else if (current && isBlockContinuation(line)) {
      current.push(line);
    } else {
      current = null;
    }
  }
  return blocks;
}

function parseRecentNotes(content) {
  return captureBlocks(capturesSection(content)).filter((block) =>
    NOTE_LINE_RE.test(block[0])
  );
}

function blockText(block) {
  const rest = block.slice(1).map((l) => (l.startsWith("  ") ? l.slice(2) : l));
  return [block[0].replace(NOTE_LINE_RE, ""), ...rest].join("\n").trimEnd();
}

function findBlockIndex(lines, block) {
  outer: for (let i = 0; i <= lines.length - block.length; i++) {
    for (let j = 0; j < block.length; j++) {
      if (lines[i + j] !== block[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function setEditingNote(block) {
  state.editingNoteBlock = block;
  els.cancelEditLink.style.display = block ? "inline" : "none";
  [...els.recentNotesList.children].forEach((c, i) => {
    c.classList.toggle("editing", currentNoteBlocks[i] === block);
  });
}

function renderRecentNotes(blocks) {
  currentNoteBlocks = blocks.slice(0, 15);
  els.recentNotesList.innerHTML = "";
  if (!currentNoteBlocks.length) {
    const empty = document.createElement("div");
    empty.className = "recent-notes-empty";
    empty.textContent = "No notes yet.";
    els.recentNotesList.appendChild(empty);
    return;
  }
  currentNoteBlocks.forEach((block) => {
    const item = document.createElement("div");
    item.className = "recent-note-item";
    item.textContent = blockText(block).replace(/\n/g, " ↵ ");
    if (block === state.editingNoteBlock) item.classList.add("editing");
    item.addEventListener("click", () => {
      els.entryText.value = blockText(block);
      setEditingNote(block);
      els.entryText.focus();
    });
    els.recentNotesList.appendChild(item);
  });
}

async function loadRecentNotes() {
  const { token } = getSettings();
  if (!token) {
    els.recentNotesList.innerHTML = '<div class="recent-notes-empty">Set up your GitHub token to see recent notes.</div>';
    return;
  }
  els.recentNotesList.innerHTML = '<div class="recent-notes-empty">Loading…</div>';
  try {
    const existing = await getFile(ENCOUNTERS_PATH);
    renderRecentNotes(existing ? parseRecentNotes(existing.content) : []);
  } catch (err) {
    console.error(err);
    els.recentNotesList.innerHTML = '<div class="recent-notes-empty">Couldn\'t load notes.</div>';
  }
}

async function updateNote(oldBlock, newText) {
  const existing = await getFile(ENCOUNTERS_PATH);
  if (!existing) throw new Error("Inbox not found");
  const lines = existing.content.split("\n");
  const idx = findBlockIndex(lines, oldBlock);
  if (idx === -1) throw new Error("Note not found — it may have changed.");
  const prefix = oldBlock[0].match(NOTE_LINE_RE)[0];
  const newLines = buildCaptureLines(prefix, newText);
  lines.splice(idx, oldBlock.length, ...newLines);
  const { date, time } = nowParts();
  await putFile(ENCOUNTERS_PATH, lines.join("\n"), existing.sha, `Update note: ${date} ${time}`);
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
//
// The ids aren't written into the vault yet, so vault lines stay exactly
// as they were. They're there for the later phases' read-back.

const DB_NAME = "engel-capture";
const DB_VERSION = 2;
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
  if (landed) await markSynced(p.ids, p.sha);
  localStorage.removeItem(PENDING_COMMIT_KEY);
}

function batchCommitMessage(entries) {
  if (entries.length === 1) return entryCommitMessage(entries[0]);
  const first = entries[0], last = entries[entries.length - 1];
  return [
    `Capture sync: ${entries.length} entries, ${first.local_date} ${first.local_time} to ${last.local_date} ${last.local_time}`,
    "",
    ...entries.map((e) => `- ${entryCommitMessage(e)}`),
  ].join("\n");
}

async function syncAsOneCommit(entries) {
  const branch = await defaultBranch();
  for (let attempt = 0; attempt < 4; attempt++) {
    const ref = await gh("GET", `/git/ref/heads/${encodeURIComponent(branch)}`);
    const headSha = ref.object.sha;

    await settlePendingCommit(headSha);
    const still = new Set((await pendingEntries()).map((e) => e.id));
    entries = entries.filter((e) => still.has(e.id));
    if (!entries.length) return entries;

    const head = await gh("GET", `/git/commits/${headSha}`);
    const files = new Map();
    for (const entry of entries) {
      const path = entryPath(entry);
      if (!files.has(path)) {
        const existing = await getFile(path, headSha);
        files.set(path, existing ? existing.content : null);
      }
      files.set(path, applyEntry(files.get(path), entry));
    }

    const tree = await gh("POST", "/git/trees", {
      base_tree: head.tree.sha,
      tree: [...files].map(([path, content]) => ({ path, mode: "100644", type: "blob", content })),
    });
    const commit = await gh("POST", "/git/commits", {
      message: batchCommitMessage(entries),
      tree: tree.sha,
      parents: [headSha],
    });

    const { owner, repo } = getSettings();
    const ids = entries.map((e) => e.id);
    localStorage.setItem(PENDING_COMMIT_KEY, JSON.stringify({ owner, repo, sha: commit.sha, ids }));
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
    localStorage.removeItem(PENDING_COMMIT_KEY);
    return entries;
  }
  throw new Error("GitHub sync failed: 409 the branch kept moving, will retry");
}

async function updatePendingBadge() {
  let n = 0;
  try { n = await pendingCount(); } catch { /* no IndexedDB: nothing can be pending */ }
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
  try {
    const run = async () => {
      const entries = await pendingEntries();
      if (!entries.length) return;
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
        } else {
          done.push(...(await syncAsOneCommit(entries)));
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
  // A submit that sent straight through overwrites this with "Captured."
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

async function submitNoteEdit(text) {
  els.submitBtn.disabled = true;
  setStatus("Sending…", "pending");
  try {
    await updateNote(state.editingNoteBlock, text);
    setEditingNote(null);
    await loadRecentNotes();
    els.entryText.value = "";
    setStatus("Captured.", "ok");
  } catch (err) {
    console.error(err);
    setStatus("Failed — check your token/settings and try again.", "err");
  } finally {
    els.submitBtn.disabled = false;
  }
}

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
  if (state.type === "note" && state.editingNoteBlock) {
    await submitNoteEdit(text);
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
    setStatus("Captured.", "ok");
    if (entry.type === "note") await loadRecentNotes();
  } else if (outcome === "queued") {
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

const CHECKINS = {
  "daily-office": { label: "Daily Office", text: "Did the Daily Office." },
  lectio: { label: "Lectio", text: "Did Lectio Divina." },
  workout: { label: "Workout", text: "Worked out." },
};
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

els.checkinRow.addEventListener("click", async (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const key = chip.dataset.practice;
  const practice = CHECKINS[key];
  const typed = els.entryText.value.trim();
  const entry = buildEntry({ type: "journal", body: typed || practice.text, tags: [`practice/${key}`] });

  const outcome = await captureEntry(entry, {
    onSaved: () => { if (typed) els.entryText.value = ""; },
    delaySync: CHECKIN_UNDO_MS,
  });
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
    if (removed) {
      if (typed && !els.entryText.value) els.entryText.value = typed;
      setStatus(`Removed ${practice.label} check-in.`, "pending");
    } else {
      setStatus("Already sent — delete the line in Obsidian if it was a mistake.", "err");
    }
  });
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
