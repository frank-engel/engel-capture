// Engel Capture — quick-capture PWA for the Engel-Personal Obsidian vault.
// No backend: talks straight to the GitHub Contents API using a PAT stored
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
};

// ---------- settings ----------

function getSettings() {
  return {
    token: localStorage.getItem("ec_token") || "",
    owner: localStorage.getItem("ec_owner") || DEFAULT_OWNER,
    repo: localStorage.getItem("ec_repo") || DEFAULT_REPO,
  };
}

function openSettings() {
  const s = getSettings();
  els.tokenInput.value = s.token;
  els.ownerInput.value = s.owner;
  els.repoInput.value = s.repo;
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
  els.settingsDialog.close();
  setStatus("Settings saved.", "ok");
  updateNavVisibility();
  flushOutbox();
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

function nowParts() {
  const d = new Date();
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

// ---------- GitHub Contents API ----------

function apiUrl(path, owner, repo) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${owner}/${repo}/contents/${encoded}`;
}

async function getFile(path) {
  const { token, owner, repo } = getSettings();
  const res = await fetch(apiUrl(path, owner, repo), {
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

// `when` is the { date, time } the entry was written, not sent — an entry
// that sat in the outbox overnight still lands in the day it was written.
async function captureJournal(text, when) {
  const { date, time } = when;
  const path = `Calendar/${date}.md`;
  const existing = await getFile(path);

  let lines, sha;
  if (existing) {
    lines = existing.content.split("\n");
    sha = existing.sha;
  } else {
    lines = fallbackDailyNote(date).split("\n");
    sha = null;
  }

  const entry = [`_${time}_ — ${text}`, ""];
  const updated = insertUnderHeading(lines, JOURNAL_HEADING, entry, false);
  await putFile(path, updated.join("\n"), sha, `Journal: ${date} ${time}`);
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

async function captureEncounter(type, category, text, extra, when) {
  const { date, time } = when;
  const existing = await getFile(ENCOUNTERS_PATH);

  let lines, sha;
  if (existing) {
    lines = existing.content.split("\n");
    sha = existing.sha;
  } else {
    lines = fallbackInbox().split("\n");
    sha = null;
  }

  let prefix;
  if (type === "task") {
    prefix = `- [ ] #capture/task ${date} ${time} — `;
  } else if (type === "prayer") {
    prefix = `- #capture/prayer/${category} ${date} — `;
  } else {
    prefix = `- #capture/${type} ${date} — `;
  }

  const entryLines = buildCaptureLines(prefix, text, extra);
  const updated = insertUnderHeading(lines, CAPTURES_HEADING, entryLines, true);
  await putFile(ENCOUNTERS_PATH, updated.join("\n"), sha, `Capture (${type}): ${date} ${time}`);
}

// ---------- recent notes ----------
//
// A capture's text can itself contain newlines (multi-line textarea input).
// captureEncounter writes those as an indented list continuation (two
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

// ---------- outbox ----------
//
// Every new capture is written to IndexedDB first and then sent, so the
// text is safe on the device before any network call happens. A failed or
// offline send just leaves it queued; flushOutbox() retries on app open,
// reconnect, returning to the tab, saving settings, a tap on the pending
// badge, and once a minute while anything is waiting. Entries are sent
// oldest first and a failure stops the run, so captures land in the order
// they were written. Nothing is ever dropped from the queue except by a
// successful send.
//
// Note edits are not queued: they splice into a block that might have
// changed by the time a retry runs, and the Recent Notes list they edit
// needs the network to load anyway.

const DB_NAME = "engel-capture";
const OUTBOX_STORE = "outbox";
const RETRY_INTERVAL_MS = 60 * 1000;

let dbPromise = null;
let flushChain = Promise.resolve();
let lastSendError = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        reject(new Error("IndexedDB unavailable"));
        return;
      }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(OUTBOX_STORE, { keyPath: "id", autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

async function outboxRequest(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOX_STORE, mode);
    const req = fn(tx.objectStore(OUTBOX_STORE));
    let result;
    req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const outboxAdd = (entry) => outboxRequest("readwrite", (s) => s.add(entry));
const outboxAll = () => outboxRequest("readonly", (s) => s.getAll()); // key order = oldest first
const outboxDelete = (id) => outboxRequest("readwrite", (s) => s.delete(id));
const outboxCount = () => outboxRequest("readonly", (s) => s.count());

// Everything needed to send the capture later, frozen at the moment it was
// written — including task fields, which get reset as soon as it's queued.
function buildOutboxEntry(text) {
  return {
    type: state.type,
    category: state.category,
    text,
    suffix: state.type === "task" ? buildTaskSuffix() : "",
    when: nowParts(),
    createdAt: Date.now(),
  };
}

function sendEntry(entry) {
  if (entry.type === "journal") return captureJournal(entry.text, entry.when);
  return captureEncounter(entry.type, entry.category, entry.text, entry.suffix, entry.when);
}

async function updatePendingBadge() {
  let n = 0;
  try { n = await outboxCount(); } catch { /* no IndexedDB: nothing can be pending */ }
  els.pendingBtn.hidden = n === 0;
  els.pendingCount.textContent = String(n);
  els.pendingBtn.title = n === 1 ? "1 capture waiting to send — tap to retry" : `${n} captures waiting to send — tap to retry`;
  return n;
}

// Sends queued captures oldest first and resolves to the ids that went
// through. Calls are chained rather than skipped while one is running, so a
// capture made mid-retry still gets its own pass instead of looking stuck.
function flushOutbox() {
  const run = flushChain.then(runFlush);
  flushChain = run.catch(() => {});
  return run;
}

async function runFlush() {
  const sent = new Set();
  if (!getSettings().token) {
    await updatePendingBadge();
    return sent;
  }
  try {
    const run = async () => {
      for (const entry of await outboxAll()) {
        try {
          await sendEntry(entry);
        } catch (err) {
          console.error(err);
          lastSendError = err;
          break;
        }
        await outboxDelete(entry.id);
        sent.add(entry.id);
        lastSendError = null;
      }
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
// so say so. Anything else (no network, 5xx, a sha race) just needs a retry.
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
  await flushOutbox();
  if (await updatePendingBadge()) setQueuedStatus();
});

window.addEventListener("online", flushOutbox);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") flushOutbox();
});
setInterval(async () => {
  if (document.visibilityState === "visible" && !els.pendingBtn.hidden) flushOutbox();
}, RETRY_INTERVAL_MS);
flushOutbox();

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

  const entry = buildOutboxEntry(text);
  let id;
  try {
    id = await outboxAdd(entry);
  } catch (err) {
    // No IndexedDB (e.g. some private modes) — fall back to a direct send
    // so capture still works, just without the safety net.
    console.error(err);
  }

  if (id !== undefined) {
    // The text is safe on the device now, so clear the box right away —
    // ready for the next thought whether or not the send goes through.
    els.entryText.value = "";
    if (state.type === "task") resetTaskFields();
    if (!getSettings().token) {
      await updatePendingBadge();
      setQueuedStatus();
      openSettings();
      return;
    }
    setStatus("Sending…", "pending");
    const sent = await flushOutbox();
    if (sent.has(id)) {
      setStatus("Captured.", "ok");
      if (entry.type === "note") await loadRecentNotes();
    } else {
      setQueuedStatus();
    }
    return;
  }

  if (!getSettings().token) {
    setStatus("Set up your GitHub token first.", "err");
    openSettings();
    return;
  }
  els.submitBtn.disabled = true;
  setStatus("Sending…", "pending");
  try {
    await sendEntry(entry);
    els.entryText.value = "";
    if (state.type === "task") resetTaskFields();
    if (entry.type === "note") await loadRecentNotes();
    setStatus("Captured.", "ok");
  } catch (err) {
    console.error(err);
    setStatus("Failed — check your token/settings and try again.", "err");
  } finally {
    els.submitBtn.disabled = false;
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
