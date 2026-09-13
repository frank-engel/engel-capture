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
  editingNoteLine: null,
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

async function captureJournal(text) {
  const { date, time } = nowParts();
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

async function captureEncounter(type, category, text, extra) {
  const { date, time } = nowParts();
  const existing = await getFile(ENCOUNTERS_PATH);

  let lines, sha;
  if (existing) {
    lines = existing.content.split("\n");
    sha = existing.sha;
  } else {
    lines = fallbackInbox().split("\n");
    sha = null;
  }

  let line;
  if (type === "task") {
    line = `- [ ] #capture/task ${date} ${time} — ${text}${extra || ""}`;
  } else if (type === "prayer") {
    line = `- #capture/prayer/${category} ${date} — ${text}`;
  } else {
    line = `- #capture/${type} ${date} — ${text}`;
  }

  const updated = insertUnderHeading(lines, CAPTURES_HEADING, [line], true);
  await putFile(ENCOUNTERS_PATH, updated.join("\n"), sha, `Capture (${type}): ${date} ${time}`);
}

// ---------- recent notes ----------

const NOTE_LINE_RE = /^- #capture\/note \d{4}-\d{2}-\d{2} — /;

function parseRecentNotes(content) {
  const lines = content.split("\n");
  const headingIdx = lines.findIndex((l) => l.trim() === CAPTURES_HEADING);
  if (headingIdx === -1) return [];
  let nextHeadingIdx = lines.findIndex(
    (l, i) => i > headingIdx && /^#{1,6}\s/.test(l)
  );
  if (nextHeadingIdx === -1) nextHeadingIdx = lines.length;
  return lines
    .slice(headingIdx + 1, nextHeadingIdx)
    .filter((l) => NOTE_LINE_RE.test(l));
}

function noteText(line) {
  return line.replace(NOTE_LINE_RE, "");
}

function setEditingNote(line) {
  state.editingNoteLine = line;
  els.cancelEditLink.style.display = line ? "inline" : "none";
  [...els.recentNotesList.children].forEach((c) => {
    c.classList.toggle("editing", c.dataset.line === line);
  });
}

function renderRecentNotes(lines) {
  els.recentNotesList.innerHTML = "";
  if (!lines.length) {
    const empty = document.createElement("div");
    empty.className = "recent-notes-empty";
    empty.textContent = "No notes yet.";
    els.recentNotesList.appendChild(empty);
    return;
  }
  lines.slice(0, 15).forEach((line) => {
    const item = document.createElement("div");
    item.className = "recent-note-item";
    item.dataset.line = line;
    item.textContent = noteText(line).replace(/\n/g, " ");
    if (line === state.editingNoteLine) item.classList.add("editing");
    item.addEventListener("click", () => {
      els.entryText.value = noteText(line);
      setEditingNote(line);
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

async function updateNote(oldLine, newText) {
  const existing = await getFile(ENCOUNTERS_PATH);
  if (!existing) throw new Error("Inbox not found");
  const lines = existing.content.split("\n");
  const idx = lines.indexOf(oldLine);
  if (idx === -1) throw new Error("Note not found — it may have changed.");
  const prefix = oldLine.match(NOTE_LINE_RE)[0];
  lines[idx] = prefix + newText;
  const { date, time } = nowParts();
  await putFile(ENCOUNTERS_PATH, lines.join("\n"), existing.sha, `Update note: ${date} ${time}`);
}

// ---------- submit ----------

els.submitBtn.addEventListener("click", async () => {
  const text = els.entryText.value.trim();
  if (!text) {
    setStatus("Nothing to capture.", "err");
    return;
  }
  const { token } = getSettings();
  if (!token) {
    setStatus("Set up your GitHub token first.", "err");
    openSettings();
    return;
  }
  if (state.type === "task" && els.recurUnitInput.value && !els.dueDateInput.value) {
    setStatus("Recurring tasks need a due date to recur from.", "err");
    return;
  }

  els.submitBtn.disabled = true;
  setStatus("Sending…", "pending");
  try {
    if (state.type === "journal") {
      await captureJournal(text);
    } else if (state.type === "task") {
      await captureEncounter(state.type, state.category, text, buildTaskSuffix());
      resetTaskFields();
    } else if (state.type === "note" && state.editingNoteLine) {
      await updateNote(state.editingNoteLine, text);
      setEditingNote(null);
      await loadRecentNotes();
    } else {
      await captureEncounter(state.type, state.category, text);
      if (state.type === "note") await loadRecentNotes();
    }
    els.entryText.value = "";
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
