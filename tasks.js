// Engel Capture: tasks and the Today list.
//
// The "☐ Task" toggle next to Capture turns that capture into an Obsidian
// Tasks line under "## Tasks" in the day's note:
//
//   - [ ] Call Dr. Le about labs ^t-7k3qxm
//
// The vault is where tasks live. The app keeps a copy of each task it knows
// about in IndexedDB (store "tasks"), so the Today list works offline. On
// every sync it re-reads those lines by their ^t- block id, so a due date,
// priority or check-off added in Obsidian, or by a Claude skill, shows up on
// the phone. A task moved into Atlas/Tasks MOC (process-captures does this)
// or swept into Tasks Archive is still found by its id.
//
// Open tasks in Tasks MOC that the app didn't write are shown too. If one of
// them is checked off on the phone, it gets a ^t- id in the same edit so the
// app can find it again.
//
// Edits made on the phone (add, check off, pin to today) are queued on the
// task row and written in the next sync commit, alongside any captures.
// Every write is idempotent: an add is skipped if the id is already in the
// file, and an edit just sets the line to the state the phone wants. So a
// sync that is retried, or whose response was lost, never writes twice.
//
// Loaded after prayer.js and before app.js. Like prayer.js, it only calls
// into app.js (dbTx, getFile, nowParts, syncNow, …) at run time.

const TASKS_STORE = "tasks";
const TASKS_MOC_PATH = "Atlas/Tasks MOC.md";
const TASKS_ARCHIVE_PATH = "Atlas/Tasks Archive.md";
const TASKS_HEADING = "## Tasks";
const TODAY_CAP = 5;
const TASK_SYNC_DELAY_MS = 4000;
const TASK_REFRESH_MIN_MS = 60 * 1000;
const DONE_KEEP_DAYS = 14;

// Where to look for a task that isn't in the file the app last saw it in.
const TASK_FALLBACK_PATHS = [TASKS_MOC_PATH, TASKS_ARCHIVE_PATH, "+ Encounters/Inbox.md"];

const TASK_LINE_RE = /^(\s*)- \[(.)\] (.*)$/;
const TASK_BLOCK_RE = /\s\^(t-[0-9a-z]{6})\s*$/;
const TASK_DUE_RE = /📅\s*(\d{4}-\d{2}-\d{2})/;
const TASK_SCHED_RE = /⏳\s*(\d{4}-\d{2}-\d{2})/;
const TASK_DONE_RE = /✅\s*(\d{4}-\d{2}-\d{2})/;
const TASK_PRIORITY = { "🔺": 5, "⏫": 4, "🔼": 3, "🔽": 1, "⏬": 0 };
// Every Tasks-plugin field emoji: the description is the text before the first.
const TASK_FIELD_RE = /\s*(?:📅|⏳|🛫|✅|➕|❌|🔁|🔺|⏫|🔼|🔽|⏬|🆔|⛔)/u;
// Old Inbox captures carried "#capture/task 2026-10-05 19:49 — " up front.
const TASK_OLD_PREFIX_RE = /^(?:#capture\/task\s+)?\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?\s+—\s+/;

const tels = {
  toggle: document.getElementById("taskToggle"),
  section: document.getElementById("todayTasks"),
  list: document.getElementById("todayList"),
  laterBtn: document.getElementById("laterBtn"),
  laterList: document.getElementById("laterList"),
};

const taskUi = { on: false, laterOpen: false, syncTimer: null, lastRefresh: 0 };

// ---------- ids and dates ----------

function newTaskId() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return "t-" + [...bytes].map((b) => ID_ALPHABET[b & 31]).join("");
}

function taskHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return "m-" + h.toString(36);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b + "T12:00:00") - Date.parse(a + "T12:00:00")) / 86400000);
}

// ---------- parsing and rewriting task lines ----------

function parseTaskLine(line) {
  const m = TASK_LINE_RE.exec(line);
  if (!m) return null;
  const rest = m[3];
  const block = TASK_BLOCK_RE.exec(rest);
  const body = block ? rest.slice(0, block.index) : rest;
  const fieldAt = body.search(TASK_FIELD_RE);
  const desc = (fieldAt === -1 ? body : body.slice(0, fieldAt)).trim();
  let priority = 2;
  for (const [mark, p] of Object.entries(TASK_PRIORITY)) if (body.includes(mark)) priority = p;
  const done = m[2] !== " ";
  return {
    block_id: block ? block[1] : null,
    text: desc.replace(TASK_OLD_PREFIX_RE, "") || desc,
    done,
    done_date: done ? ((TASK_DONE_RE.exec(body) || [])[1] || null) : null,
    due: (TASK_DUE_RE.exec(body) || [])[1] || null,
    scheduled: (TASK_SCHED_RE.exec(body) || [])[1] || null,
    priority,
    recurring: body.includes("🔁"),
  };
}

// Returns `line` with the phone's changes applied: the checkbox and ✅ date
// when `want.done` is set, the ⏳ date when `want.scheduled` is set, and a
// block id at the very end if it has none yet. Everything else (the text,
// 📅, priority, tags) is left exactly as the vault has it.
function rewriteTaskLine(line, want) {
  const m = TASK_LINE_RE.exec(line);
  if (!m) return line;
  let rest = m[3];
  const block = TASK_BLOCK_RE.exec(rest);
  let blockId = block ? block[1] : want.block_id;
  if (block) rest = rest.slice(0, block.index);
  let status = m[2];
  if ("done" in want) {
    status = want.done ? "x" : " ";
    rest = rest.replace(/\s*✅\s*\d{4}-\d{2}-\d{2}/g, "");
    if (want.done) rest += ` ✅ ${want.done_date}`;
  }
  if ("scheduled" in want) {
    rest = rest.replace(/\s*⏳\s*\d{4}-\d{2}-\d{2}/g, "");
    if (want.scheduled) rest += ` ⏳ ${want.scheduled}`;
  }
  return `${m[1]}- [${status}] ${rest.trimEnd()}${blockId ? ` ^${blockId}` : ""}`;
}

function findTaskLine(lines, row) {
  if (row.block_id) {
    const tail = `^${row.block_id}`;
    return lines.findIndex((l) => TASK_LINE_RE.test(l) && l.trimEnd().endsWith(tail));
  }
  return row.raw ? lines.indexOf(row.raw) : -1;
}

function hasTaskId(content, id) {
  return content.split("\n").some((l) => TASK_LINE_RE.test(l) && l.trimEnd().endsWith(`^${id}`));
}

// Adds a task line at the end of the "## Tasks" list, keeping the list
// together and one blank line before the next heading.
function insertTaskLine(content, date, line) {
  const lines = (content ?? fallbackDailyNote(date)).split("\n");
  let h = lines.findIndex((l) => l.trim() === TASKS_HEADING);
  if (h === -1) {
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.concat(["", TASKS_HEADING, "", line, ""]).join("\n");
  }
  let next = lines.findIndex((l, i) => i > h && /^#{1,6}\s/.test(l));
  if (next === -1) next = lines.length;
  const section = lines.slice(h + 1, next);
  while (section.length && section[section.length - 1] === "") section.pop();
  if (!section.length) section.push("");
  section.push(line, "");
  return lines.slice(0, h + 1).concat(section, lines.slice(next)).join("\n");
}

// ---------- local store ----------

function allTasks() {
  return dbTx([TASKS_STORE], "readonly", (s, out) => {
    const req = s[TASKS_STORE].getAll();
    req.onsuccess = () => { out.result = req.result; };
  });
}

function hasPending(row) {
  return !!(row.pending && Object.keys(row.pending).length);
}

async function pendingTasks() {
  try {
    return (await allTasks()).filter(hasPending).sort((a, b) => a.created_at - b.created_at);
  } catch { return []; }
}

// Applies fn(row) to one task and bumps its rev, in one transaction.
function changeTask(id, fn) {
  return dbTx([TASKS_STORE], "readwrite", (s, out) => {
    const req = s[TASKS_STORE].get(id);
    req.onsuccess = () => {
      const row = req.result;
      if (!row) return;
      fn(row);
      row.rev = (row.rev || 0) + 1;
      row.updated_at = Date.now();
      s[TASKS_STORE].put(row);
      out.result = row;
    };
  });
}

function scheduleTaskSync() {
  clearTimeout(taskUi.syncTimer);
  updatePendingBadge();
  // A short wait, so a mis-tap that's undone right away never leaves the phone.
  taskUi.syncTimer = setTimeout(syncNow, TASK_SYNC_DELAY_MS);
}

// Saves a new task from the capture box. Resolves to the row.
async function captureTask(text) {
  const now = new Date();
  const { date } = nowParts(now);
  const row = {
    id: newTaskId(),
    text: flat(text).replace(/^- \[.\]\s*/, ""),
    done: false, done_date: null, due: null, scheduled: null, priority: 2, recurring: false,
    path: `Calendar/${date}.md`,
    created_date: date,
    created_at: now.getTime(),
    source: "app",
    pending: { add: true },
    rev: 1,
    missing: false,
    raw: null,
    updated_at: now.getTime(),
  };
  row.block_id = row.id;
  // Typed fields ride along ("… 📅 2026-11-06"): written as typed, shown
  // on the list as a date.
  row.line_text = row.text;
  const parsed = parseTaskLine(`- [ ] ${row.text}`);
  Object.assign(row, { text: parsed.text, due: parsed.due, scheduled: parsed.scheduled, priority: parsed.priority });
  await dbTx([TASKS_STORE], "readwrite", (s) => { s[TASKS_STORE].add(row); });
  return row;
}

async function setTaskDone(id, done) {
  await changeTask(id, (row) => {
    row.done = done;
    row.done_date = done ? nowParts().date : null;
    row.pending = { ...(row.pending || {}), done: true };
  });
  renderTasks();
  scheduleTaskSync();
}

async function pinTaskToday(id) {
  await changeTask(id, (row) => {
    row.scheduled = nowParts().date;
    row.pending = { ...(row.pending || {}), scheduled: true };
  });
  renderTasks();
  scheduleTaskSync();
}

// ---------- sync: writing ----------

// Applies every queued task change onto `files` (path → new content),
// reading files it doesn't have yet with `read(path)`. Entries are applied
// first, so a task added to today's note builds on today's journal lines.
// Returns what to record once the commit lands.
async function planTaskWrites(files, read) {
  const rows = await pendingTasks();
  const plan = { rows: [], changed: false, count: 0 };
  const cache = new Map();
  const load = async (path) => {
    if (files.has(path)) return files.get(path);
    if (!cache.has(path)) cache.set(path, await read(path));
    return cache.get(path);
  };
  const put = (path, before, after) => {
    if (after !== before) { files.set(path, after); plan.changed = true; }
  };

  for (const row of rows) {
    const rec = { id: row.id, rev: row.rev, path: row.path, block_id: row.block_id, missing: false, raw: row.raw };
    if (row.pending.add) {
      const before = await load(row.path);
      if (!before || !hasTaskId(before, row.block_id)) {
        put(row.path, before, insertTaskLine(before, row.created_date, `- [ ] ${row.line_text || row.text} ^${row.block_id}`));
      }
    }
    const want = {};
    if (row.pending.done) { want.done = row.done; want.done_date = row.done_date; }
    if (row.pending.scheduled) want.scheduled = row.scheduled;
    if (Object.keys(want).length) {
      // An id-less Tasks MOC line gets an id with this edit.
      if (!row.block_id) want.block_id = rec.block_id = newTaskId();
      let found = false;
      const paths = [...new Set([row.path, ...TASK_FALLBACK_PATHS])];
      for (const path of paths) {
        const before = await load(path);
        if (!before) continue;
        const lines = before.split("\n");
        const i = findTaskLine(lines, row);
        if (i === -1) continue;
        lines[i] = rewriteTaskLine(lines[i], want);
        rec.path = path;
        rec.raw = lines[i];
        put(path, before, lines.join("\n"));
        found = true;
        break;
      }
      if (!found) rec.missing = true;
    }
    plan.rows.push(rec);
    plan.count++;
  }
  return plan;
}

// Records a landed commit: clears each task's queue, unless it was tapped
// again meanwhile, in which case only the add is cleared (the line exists
// now) and the newer change goes out next time.
function markTasksSynced(plan) {
  if (!plan || !plan.rows.length) return Promise.resolve();
  return dbTx([TASKS_STORE], "readwrite", (s) => {
    const store = s[TASKS_STORE];
    for (const rec of plan.rows) {
      const req = store.get(rec.id);
      req.onsuccess = () => {
        const row = req.result;
        if (!row) return;
        row.path = rec.path;
        row.block_id = row.block_id || rec.block_id;
        row.raw = rec.raw;
        row.missing = rec.missing;
        if (row.rev === rec.rev) row.pending = {};
        else if (row.pending) delete row.pending.add;
        store.put(row);
      };
    }
  });
}

// "Send each capture separately" mode: the same plan, one PUT per file.
async function sendTasksDirect() {
  const files = new Map();
  const shas = new Map();
  const plan = await planTaskWrites(files, async (path) => {
    const f = await getFile(path);
    if (f) shas.set(path, f.sha);
    return f ? f.content : null;
  });
  const { date, time } = nowParts();
  for (const [path, content] of files) {
    await putFile(path, content, shas.get(path) || null, `Tasks: ${date} ${time}`);
  }
  await markTasksSynced(plan);
}

// ---------- sync: reading back ----------

function indexTaskFile(path, content, byId, openLines) {
  for (const line of content.split("\n")) {
    const t = parseTaskLine(line);
    if (!t) continue;
    if (t.block_id) byId.set(t.block_id, { ...t, path, raw: line });
    else if (openLines && !t.done) openLines.push({ ...t, path, raw: line });
  }
}

// Re-reads the files the app's open tasks live in, plus Tasks MOC, and
// updates the local copies. Rows with queued changes are left alone (the
// phone's change wins until it has been written). Runs after each sync, at
// most once a minute unless `force`.
async function refreshTasksFromVault(force) {
  if (!getSettings().token || navigator.onLine === false) return;
  if (!force && Date.now() - taskUi.lastRefresh < TASK_REFRESH_MIN_MS) return;
  taskUi.lastRefresh = Date.now();

  let rows;
  try { rows = await allTasks(); } catch { return; }
  const today = nowParts().date;
  const live = rows.filter((r) => !hasPending(r) && !r.missing && (!r.done || r.done_date === today));

  const byId = new Map();
  const openLines = [];
  const read = new Set();
  const readPath = async (path, collectOpen) => {
    if (read.has(path)) return true;
    const f = await getFile(path);
    read.add(path);
    if (f) indexTaskFile(path, f.content, byId, collectOpen ? openLines : null);
    return true;
  };

  try {
    await readPath(TASKS_MOC_PATH, true);
    for (const p of new Set(live.filter((r) => r.block_id).map((r) => r.path))) await readPath(p);
    if (live.some((r) => r.block_id && !byId.has(r.block_id))) {
      for (const p of TASK_FALLBACK_PATHS) await readPath(p);
    }
  } catch (err) {
    console.error(err);
    return;
  }

  const known = new Map(rows.map((r) => [r.block_id || r.id, r]));
  const updates = [];
  const removes = [];
  for (const r of live) {
    const hit = r.block_id ? byId.get(r.block_id) : openLines.find((l) => l.raw === r.raw);
    if (hit) {
      updates.push({ id: r.id, rev: r.rev, fields: {
        text: hit.text, done: hit.done, done_date: hit.done_date, due: hit.due,
        scheduled: hit.scheduled, priority: hit.priority, recurring: hit.recurring,
        path: hit.path, raw: hit.raw, missing: false,
      } });
    } else if (r.source === "vault" && !r.block_id) {
      removes.push({ id: r.id, rev: r.rev }); // checked off or edited in Obsidian
    } else {
      updates.push({ id: r.id, rev: r.rev, fields: { missing: true } });
    }
  }

  // Open Tasks MOC lines the app hasn't seen yet.
  const added = [];
  const now = Date.now();
  const seenMoc = [...byId.values()].filter((t) => t.path === TASKS_MOC_PATH && !t.done);
  for (const t of [...openLines, ...seenMoc]) {
    const key = t.block_id || taskHash(t.raw);
    if (known.has(key) || added.some((a) => a.id === key)) continue;
    if (!t.block_id && rows.some((r) => r.raw === t.raw)) continue;
    added.push({
      id: key, block_id: t.block_id, text: t.text, done: false, done_date: null,
      due: t.due, scheduled: t.scheduled, priority: t.priority, recurring: t.recurring,
      path: t.path, raw: t.raw, created_date: today, created_at: now, source: "vault",
      pending: {}, rev: 1, missing: false, updated_at: now,
    });
  }

  // Old finished tasks have no further use on the phone.
  for (const r of rows) {
    if (!hasPending(r) && r.done && r.done_date && daysBetween(r.done_date, today) > DONE_KEEP_DAYS) {
      removes.push({ id: r.id, rev: r.rev });
    }
  }

  await dbTx([TASKS_STORE], "readwrite", (s) => {
    const store = s[TASKS_STORE];
    for (const u of updates) {
      const req = store.get(u.id);
      req.onsuccess = () => {
        const row = req.result;
        if (!row || row.rev !== u.rev || hasPending(row)) return; // tapped meanwhile
        store.put({ ...row, ...u.fields });
      };
    }
    for (const d of removes) {
      const req = store.get(d.id);
      req.onsuccess = () => { if (req.result && req.result.rev === d.rev && !hasPending(req.result)) store.delete(d.id); };
    }
    for (const a of added) store.put(a);
  });
  renderTasks();
}

// ---------- the Today list ----------

// Today: overdue or due today, pinned (⏳) to today or earlier, or captured
// today with no date. Everything else open is Later. Capped at TODAY_CAP;
// the overflow goes to Later too.
function bucketTasks(rows, today) {
  const open = rows.filter((r) => !r.done && !r.missing);
  const isToday = (r) =>
    (r.due && r.due <= today) || (r.scheduled && r.scheduled <= today) ||
    (!r.due && !r.scheduled && r.created_date === today && r.source === "app");
  const rank = (r) => [
    r.due && r.due <= today ? 0 : r.scheduled && r.scheduled <= today ? 1 : 2,
    r.due || r.scheduled || "9999",
    -r.priority,
    r.created_at,
  ];
  const cmp = (a, b) => {
    const x = rank(a), y = rank(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
  };
  const todayAll = open.filter(isToday).sort(cmp);
  const later = open.filter((r) => !isToday(r))
    .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999") || b.created_at - a.created_at);
  return {
    today: todayAll.slice(0, TODAY_CAP),
    later: todayAll.slice(TODAY_CAP).concat(later),
    doneToday: rows.filter((r) => r.done && r.done_date === today && !r.missing),
  };
}

function taskWhen(r, today) {
  if (r.due) {
    if (r.due === today) return "due today";
    if (r.due < today) return `since ${shortDate(r.due)}`;
    return `due ${shortDate(r.due)}`;
  }
  if (r.scheduled && r.scheduled > today) return shortDate(r.scheduled);
  return "";
}

function taskItem(r, today, { later = false } = {}) {
  const item = el("div", "task-item" + (r.done ? " done" : ""));
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = r.done;
  box.setAttribute("aria-label", r.done ? "Mark not done" : "Mark done");
  if (r.recurring && !r.done) {
    box.disabled = true;
    box.title = "Repeating task: check it off in Obsidian so the next one is made";
  }
  box.addEventListener("change", () => setTaskDone(r.id, box.checked));
  const label = el("label", "task-text", r.text);
  label.addEventListener("click", () => { if (!box.disabled) { box.checked = !box.checked; setTaskDone(r.id, box.checked); } });
  item.append(box, label);
  const when = r.done ? "" : taskWhen(r, today);
  const sending = hasPending(r) ? " · sending" : "";
  if (when || sending) item.append(el("span", "task-when", when + sending));
  if (later) {
    const pin = el("button", "task-pin", "+ Today");
    pin.title = "Put this on today's list";
    pin.addEventListener("click", () => pinTaskToday(r.id));
    item.append(pin);
  }
  return item;
}

async function renderTasks() {
  if (!tels.section) return;
  let rows = [];
  try { rows = await allTasks(); } catch { /* no IndexedDB: no list */ }
  const today = nowParts().date;
  const { today: now, later, doneToday } = bucketTasks(rows, today);

  tels.list.innerHTML = "";
  if (!now.length && !doneToday.length) {
    tels.list.append(el("p", "task-empty", later.length ? "Nothing for today." : "No tasks. Tap ☐ Task to add one."));
  }
  now.forEach((r) => tels.list.append(taskItem(r, today)));
  doneToday.forEach((r) => tels.list.append(taskItem(r, today)));

  tels.laterBtn.hidden = !later.length;
  tels.laterBtn.textContent = `${taskUi.laterOpen ? "▾" : "▸"} Later (${later.length})`;
  tels.laterList.innerHTML = "";
  tels.laterList.hidden = !taskUi.laterOpen || !later.length;
  if (taskUi.laterOpen) later.forEach((r) => tels.laterList.append(taskItem(r, today, { later: true })));
}

// ---------- capture toggle ----------

function setTaskToggle(on) {
  taskUi.on = on;
  tels.toggle.classList.toggle("active", on);
  tels.toggle.textContent = on ? "☑ Task" : "☐ Task";
  tels.toggle.setAttribute("aria-pressed", on ? "true" : "false");
  els.submitBtn.textContent = on ? "Add task" : "Capture";
}

function initTasks() {
  if (!tels.section) return;
  tels.toggle.addEventListener("click", () => setTaskToggle(!taskUi.on));
  tels.laterBtn.addEventListener("click", () => {
    taskUi.laterOpen = !taskUi.laterOpen;
    renderTasks();
  });
  renderTasks();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") renderTasks();
  });
}
