// Calendar tab — a read-only look back at the journal.
//
// A week row (tap the month name for the whole month) with a dot under each
// day that has something written, and that day's entries below it. Practice
// check-ins fold into one line; only actual writing shows at full size.
//
// Where the days come from: the vault's Calendar/ folder is the source, so
// edits made in Obsidian show up too. Opening the tab lists the folder (one
// call), then reads only the daily notes in view whose blob sha changed since
// last time. Parsed days are cached in the "meta" store under "cal:<date>",
// so a month read once opens offline afterwards. Entries still waiting on
// the phone (or written before the vault was reachable) are merged in from
// the local database, so a capture shows up here right away.
//
// Nothing here writes to the vault.

const CAL_DIR = "Calendar";
const CAL_META_PREFIX = "cal:";
const CAL_LIST_MIN_MS = 60 * 1000;
const CAL_FETCH_CONCURRENCY = 4;
const CAL_TIME_RE = /^_(\d{1,2}:\d{2})_\s*[—–-]\s?(.*)$/;
const CAL_PRACTICE_RE = /\s*#practice\/([a-z0-9-]+)/g;

const cels = {
  section: document.getElementById("calendarSection"),
  prev: document.getElementById("calPrev"),
  next: document.getElementById("calNext"),
  monthBtn: document.getElementById("calMonthBtn"),
  grid: document.getElementById("calGrid"),
  day: document.getElementById("calDay"),
  note: document.getElementById("calNote"),
};

const cal = {
  selected: null,       // YYYY-MM-DD
  expanded: false,      // month grid open
  index: new Map(),     // date -> blob sha, from the folder listing
  cache: new Map(),     // date -> { sha, entries } parsed from the vault
  local: new Map(),     // date -> [entry rows] from this phone
  listedAt: 0,
  offline: false,
  fetching: new Set(),
};

// ---------- dates ----------

function calParse(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function calIso(d) { return nowParts(d).date; }
function calAddDays(iso, n) { const d = calParse(iso); d.setDate(d.getDate() + n); return calIso(d); }
function calWeekStart(iso) { const d = calParse(iso); d.setDate(d.getDate() - d.getDay()); return calIso(d); }

function calVisibleDays() {
  const sel = calParse(cal.selected);
  let start, end;
  if (cal.expanded) {
    const first = new Date(sel.getFullYear(), sel.getMonth(), 1);
    const last = new Date(sel.getFullYear(), sel.getMonth() + 1, 0);
    start = calWeekStart(calIso(first));
    end = calAddDays(calWeekStart(calIso(last)), 6);
  } else {
    start = calWeekStart(cal.selected);
    end = calAddDays(start, 6);
  }
  const days = [];
  for (let d = start; d <= end; d = calAddDays(d, 1)) days.push(d);
  return days;
}

// ---------- reading a daily note ----------

// The "## Journal" section, split into entries at each "_HH:MM_ — " line.
// Lines after it (a list under an entry, a second paragraph) belong to it.
function calParseJournal(content) {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.trim() === JOURNAL_HEADING);
  if (start === -1) return [];
  const out = [];
  let cur = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,6}\s/.test(line)) break;
    const m = line.match(CAL_TIME_RE);
    if (m) {
      cur = { time: m[1].padStart(5, "0"), lines: [m[2]] };
      out.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    } else if (line.trim()) {
      cur = { time: "", lines: [line] };
      out.push(cur);
    }
  }
  return out
    .map((e) => ({ time: e.time, raw: e.lines.join("\n").trim() }))
    .filter((e) => e.raw);
}

function calKey(time, raw) { return `${time}|${raw.replace(/\s+/g, " ").trim()}`; }

// A check-in is a practice line with nothing of your own in it: just the
// default sentence (or nothing) plus its #practice tag. Anything you typed
// along with the tap counts as writing.
function calShape(raw) {
  const practices = [...raw.matchAll(CAL_PRACTICE_RE)].map((m) => m[1]);
  const text = raw.replace(CAL_PRACTICE_RE, "").trim();
  const defaults = new Set(Object.values(PRACTICE_TEXT));
  const checkinOnly = practices.length > 0 && (!text || defaults.has(text) || /^Checked in: .+\.$/.test(text));
  return { text, practices, checkinOnly };
}

function calPracticeLabel(key) {
  try {
    const hit = getPractices().find((p) => p.key === key);
    if (hit) return hit.label;
  } catch { /* settings not ready */ }
  return key.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

// Everything for one day: the vault's entries plus any on the phone the
// vault doesn't have yet, oldest first.
function calDayEntries(date) {
  const vault = (cal.cache.get(date) || {}).entries || [];
  const seen = new Set(vault.map((e) => calKey(e.time, e.raw)));
  const merged = vault.map((e) => ({ ...e, pending: false }));
  for (const row of cal.local.get(date) || []) {
    const raw = entryText(row);
    if (seen.has(calKey(row.local_time, raw))) continue;
    merged.push({ time: row.local_time, raw, pending: row.sync_state === "pending" });
  }
  merged.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  return merged.map((e) => ({ ...e, ...calShape(e.raw) }));
}

function calHasWriting(date) {
  return calDayEntries(date).some((e) => !e.checkinOnly);
}

// ---------- loading ----------

async function calLoadCache() {
  if (cal.cache.size) return;
  try {
    const rows = await dbTx([META_STORE], "readonly", (s, out) => {
      const req = s[META_STORE].getAll();
      req.onsuccess = () => { out.result = req.result; };
    });
    for (const r of rows || []) {
      if (typeof r.key === "string" && r.key.startsWith(CAL_META_PREFIX)) {
        cal.cache.set(r.key.slice(CAL_META_PREFIX.length), { sha: r.sha, entries: r.entries || [] });
      }
    }
  } catch (err) { console.error(err); }
}

async function calLoadLocal() {
  try {
    const rows = await dbTx([ENTRIES_STORE], "readonly", (s, out) => {
      const req = s[ENTRIES_STORE].getAll();
      req.onsuccess = () => { out.result = req.result; };
    });
    cal.local = new Map();
    for (const r of rows || []) {
      if (r.type !== "journal") continue;
      if (!cal.local.has(r.local_date)) cal.local.set(r.local_date, []);
      cal.local.get(r.local_date).push(r);
    }
  } catch (err) { console.error(err); }
}

async function calLoadIndex(force) {
  if (!getSettings().token || navigator.onLine === false) { cal.offline = true; return; }
  if (!force && Date.now() - cal.listedAt < CAL_LIST_MIN_MS) return;
  try {
    const items = await gh("GET", `/contents/${CAL_DIR}`);
    const index = new Map();
    for (const it of items) {
      const m = it.type === "file" && it.name.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
      if (m) index.set(m[1], it.sha);
    }
    cal.index = index;
    cal.listedAt = Date.now();
    cal.offline = false;
  } catch (err) {
    console.error(err);
    cal.offline = true;
  }
}

async function calFetchDay(date, sha) {
  const blob = await gh("GET", `/git/blobs/${sha}`);
  const entries = calParseJournal(b64Decode(blob.content));
  cal.cache.set(date, { sha, entries });
  try {
    await dbTx([META_STORE], "readwrite", (s) => {
      s[META_STORE].put({ key: CAL_META_PREFIX + date, sha, entries });
    });
  } catch (err) { console.error(err); }
}

// Reads the days in view whose file is new or changed, a few at a time.
async function calFetchVisible() {
  if (cal.offline) return;
  const todo = calVisibleDays().filter((d) => {
    const sha = cal.index.get(d);
    return sha && !cal.fetching.has(d) && (cal.cache.get(d) || {}).sha !== sha;
  });
  if (!todo.length) return;
  todo.forEach((d) => cal.fetching.add(d));
  renderCalendar();
  const queue = todo.slice();
  const worker = async () => {
    while (queue.length) {
      const d = queue.shift();
      try { await calFetchDay(d, cal.index.get(d)); } catch (err) { console.error(err); }
      cal.fetching.delete(d);
    }
  };
  await Promise.all(Array.from({ length: CAL_FETCH_CONCURRENCY }, worker));
  renderCalendar();
}

async function openCalendar() {
  const today = nowParts().date;
  if (!cal.selected || cal.selected > today) cal.selected = today;
  await Promise.all([calLoadCache(), calLoadLocal()]);
  renderCalendar();
  await calLoadIndex(false);
  renderCalendar();
  await calFetchVisible();
}

// ---------- view ----------

function calSelect(date, { collapse } = {}) {
  const today = nowParts().date;
  if (date > today) return;
  cal.selected = date;
  if (collapse) cal.expanded = false;
  renderCalendar();
  calFetchVisible();
}

function calStep(dir) {
  const today = nowParts().date;
  if (cal.expanded) {
    const d = calParse(cal.selected);
    const target = new Date(d.getFullYear(), d.getMonth() + dir, 1);
    const lastOfTarget = new Date(target.getFullYear(), target.getMonth() + 1, 0);
    target.setDate(Math.min(d.getDate(), lastOfTarget.getDate()));
    let iso = calIso(target);
    if (iso > today) iso = today;
    calSelect(iso);
  } else {
    let iso = calAddDays(cal.selected, dir * 7);
    if (iso > today) iso = today;
    calSelect(iso);
  }
}

function renderCalendar() {
  if (!cal.selected) return;
  const today = nowParts().date;
  const sel = calParse(cal.selected);

  cels.monthBtn.textContent = sel.toLocaleDateString(undefined, { month: "long", year: "numeric" }) + (cal.expanded ? " ▴" : " ▾");
  cels.monthBtn.setAttribute("aria-expanded", String(cal.expanded));
  const nextDisabled = cal.expanded
    ? new Date(sel.getFullYear(), sel.getMonth() + 1, 1) > calParse(today)
    : calAddDays(calWeekStart(cal.selected), 7) > today;
  cels.next.disabled = nextDisabled;
  cels.prev.setAttribute("aria-label", cal.expanded ? "Previous month" : "Previous week");
  cels.next.setAttribute("aria-label", cal.expanded ? "Next month" : "Next week");

  cels.grid.textContent = "";
  for (const d of calVisibleDays()) {
    const cell = el("button", "cal-cell");
    const dt = calParse(d);
    cell.appendChild(el("span", "cal-num", String(dt.getDate())));
    const dot = el("span", "cal-dot");
    if (calHasWriting(d)) dot.classList.add("on");
    cell.appendChild(dot);
    if (d === today) cell.classList.add("today");
    if (d === cal.selected) cell.classList.add("selected");
    if (dt.getMonth() !== sel.getMonth()) cell.classList.add("other");
    if (d > today) { cell.classList.add("future"); cell.disabled = true; }
    cell.setAttribute("aria-label", dt.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }));
    cell.addEventListener("click", () => calSelect(d, { collapse: true }));
    cels.grid.appendChild(cell);
  }

  renderCalendarDay();

  if (!getSettings().token) cels.note.textContent = "Showing what's on this phone. Add your GitHub token to see older days.";
  else if (cal.offline) cels.note.textContent = "Offline: showing days read before.";
  else cels.note.textContent = "";
}

function renderCalendarDay() {
  const date = cal.selected;
  const today = nowParts().date;
  const box = cels.day;
  box.textContent = "";

  const head = el("div", "cal-day-head");
  const label = calParse(date).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  head.appendChild(el("span", "cal-day-title", date === today ? `Today · ${label}` : label));
  box.appendChild(head);

  const entries = calDayEntries(date);
  const practices = [...new Set(entries.flatMap((e) => e.practices))];
  if (practices.length) {
    box.appendChild(el("div", "cal-checkins", "✓ " + practices.map(calPracticeLabel).join(" · ")));
  }

  const writing = entries.filter((e) => !e.checkinOnly);
  if (!writing.length) {
    const loading = cal.fetching.has(date) || (cal.index.has(date) && !cal.cache.has(date) && !cal.offline);
    box.appendChild(el("p", "cal-empty", loading ? "Loading…" : "Nothing written this day."));
    return;
  }

  // Newest first, like reading back up the page.
  for (const e of writing.slice().reverse()) {
    const item = el("div", "cal-entry");
    const meta = el("div", "cal-entry-time", e.time ? calTimeLabel(e.time) : "");
    if (e.pending) meta.appendChild(el("span", "cal-pending", " · on phone"));
    item.appendChild(meta);
    const text = el("div", "cal-entry-text", e.text);
    item.appendChild(text);
    item.addEventListener("click", () => text.classList.toggle("expanded"));
    box.appendChild(item);
  }
}

function calTimeLabel(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// ---------- controls ----------

cels.prev.addEventListener("click", () => calStep(-1));
cels.next.addEventListener("click", () => calStep(1));
cels.monthBtn.addEventListener("click", () => {
  cal.expanded = !cal.expanded;
  renderCalendar();
  calFetchVisible();
});

// Swipe the day's entries left or right to move a day.
(() => {
  let x0 = null, y0 = null;
  cels.day.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    x0 = t.clientX; y0 = t.clientY;
  }, { passive: true });
  cels.day.addEventListener("touchend", (e) => {
    if (x0 == null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0;
    x0 = null;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    calSelect(calAddDays(cal.selected, dx < 0 ? 1 : -1));
  }, { passive: true });
})();

// Coming back to the app on the Calendar tab picks up new days.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.type === "calendar") {
    cal.listedAt = 0;
    openCalendar();
  }
});
