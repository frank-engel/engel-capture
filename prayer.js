// Engel Capture — Prayer List (Phase 2).
//
// The app owns Spaces/Prayer/Prayer List.md from here on. Prayer requests
// live in the phone's IndexedDB as people, requests and dated updates, and
// the sync regenerates the whole file from them in the same commit as any
// waiting captures. An edit made to the file outside the app is never
// silently overwritten: the sync stops touching the file and the Prayer
// view asks which version to keep.
//
// Loaded before app.js. Everything here is a declaration except a few DOM
// lookups; it only calls into app.js (dbTx, getFile, nowParts, syncNow, …)
// at run time, after both scripts have loaded.

const PRAYER_CATEGORIES = [
  { slug: "people", title: "People" },
  { slug: "church", title: "Church" },
  { slug: "self", title: "Self" },
  { slug: "praise", title: "Praise" },
];
const ANSWERED_TITLE = "Answered / Resolved";

// Old headings fold into the four Frank chose (2026-10-30): Life, Pain and
// Theology become Self. Anything unrecognised also lands in Self.
const HEADING_TO_CATEGORY = {
  people: "people", church: "church", praise: "praise",
  self: "self", life: "self", pain: "self", theology: "self", theodicy: "self",
};

const PERSONS_STORE = "persons";
const REQUESTS_STORE = "prayer_requests";
const UPDATES_STORE = "prayer_updates";
const META_STORE = "meta";
const PRAYER_STORES = [PERSONS_STORE, REQUESTS_STORE, UPDATES_STORE, META_STORE];
const PRAYER_META_KEY = "prayer";

const PRAYER_INTRO =
  "This list is kept by the Engel Capture app (the 🙏 view), which rewrites this file when it syncs. " +
  "Add, update and close prayers there. An edit made here isn't lost: the app notices it and asks which version to keep.";

const pels = {
  view: document.getElementById("prayerView"),
  content: document.getElementById("prayerContent"),
  status: document.getElementById("prayerStatus"),
  banner: document.getElementById("prayerBanner"),
  syncState: document.getElementById("prayerSyncState"),
  search: document.getElementById("prayerSearch"),
  newBtn: document.getElementById("prayerNewBtn"),
  arrangeBtn: document.getElementById("prayerArrangeBtn"),
  reqDialog: document.getElementById("prayerRequestDialog"),
  reqTitle: document.getElementById("prayerReqTitle"),
  reqPerson: document.getElementById("prayerReqPerson"),
  reqRelation: document.getElementById("prayerReqRelation"),
  reqVia: document.getElementById("prayerReqVia"),
  reqCategory: document.getElementById("prayerReqCategory"),
  reqSummary: document.getElementById("prayerReqSummary"),
  reqDate: document.getElementById("prayerReqDate"),
  reqDateField: document.getElementById("prayerReqDateField"),
  reqUpdates: document.getElementById("prayerReqUpdates"),
  reqEditExtras: document.getElementById("prayerReqEditExtras"),
  reqSave: document.getElementById("prayerReqSave"),
  reqCancel: document.getElementById("prayerReqCancel"),
  reqAnswer: document.getElementById("prayerReqAnswer"),
  reqArchive: document.getElementById("prayerReqArchive"),
  reqReopen: document.getElementById("prayerReqReopen"),
  reqDelete: document.getElementById("prayerReqDelete"),
  personList: document.getElementById("prayerPersonList"),
  closeDialog: document.getElementById("prayerCloseDialog"),
  closeTitle: document.getElementById("prayerCloseTitle"),
  closeNote: document.getElementById("prayerCloseNote"),
  closeDate: document.getElementById("prayerCloseDate"),
  closeSave: document.getElementById("prayerCloseSave"),
  closeCancel: document.getElementById("prayerCloseCancel"),
};

let prayerData = { persons: [], requests: [], updates: [], meta: null };
const prayerUi = { composingFor: null, expanded: new Set(), editingId: null, closing: null, arranging: false };

// ---------- ids and dates ----------

function prefixedId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `${prefix}-${[...bytes].map((b) => ID_ALPHABET[b & 31]).join("")}`;
}

function todayLocal() { return nowParts().date; }

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const s = `${MONTHS[m - 1]} ${d}`;
  return y === new Date().getFullYear() ? s : `${s}, ${y}`;
}

// One line in the vault, so rewording never breaks the list.
function flat(text) { return String(text || "").replace(/\s*\n\s*/g, " ").trim(); }

// ---------- parsing Prayer List.md ----------

const DATE_CHAIN_RE = /^(\d{4}-\d{2}-\d{2}(?:\s*\/\s*\d{4}-\d{2}-\d{2})*)\s+—\s+([\s\S]*)$/;
const ONE_DATE_RE = /^(\d{4}-\d{2}-\d{2})\s+—\s+([\s\S]*)$/;
const BLOCK_ID_RE = /\s+\^([a-z]-[0-9a-z]{6})$/;
const PRAISE_MARK = "🙌";

// Splits the file into list items, each with its heading and any indented
// sub-bullets. Continuation lines (indented, not a bullet) join the item or
// sub-bullet above them; anything else ends the item.
function parsePrayerItems(md) {
  const items = [];
  let section = null;
  let current = null;
  for (const raw of md.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const heading = /^##\s+(.*)/.exec(line);
    if (heading) { section = heading[1].trim(); current = null; continue; }
    if (/^#\s/.test(line)) { section = null; current = null; continue; }
    if (!section) continue;
    const top = /^-\s+(.*)$/.exec(line);
    if (top) { current = { section, text: top[1], subs: [] }; items.push(current); continue; }
    const sub = /^\s{2,}[-*]\s+(.*)$/.exec(line);
    if (sub && current) { current.subs.push(sub[1]); continue; }
    if (current && /^\s{2,}\S/.test(line)) {
      if (current.subs.length) current.subs[current.subs.length - 1] += " " + line.trim();
      else current.text += " " + line.trim();
      continue;
    }
    current = null;
  }
  return items;
}

function stripBlockId(text, prefix) {
  const m = BLOCK_ID_RE.exec(text);
  if (m && m[1].startsWith(prefix + "-")) return { text: text.slice(0, m.index), id: m[1] };
  return { text, id: null };
}

// "Dawn Belair, Scott's wife: …" → name, relation, summary.
// "Shannon (via Nancy): …" → name, via, summary.
// Only a short, sentence-free prefix counts as a name, so a line like
// "That I would succeed in new habits. Update 10/20: …" stays whole.
function splitPersonPrefix(text) {
  const idx = text.indexOf(": ");
  if (idx > 0 && idx <= 60) {
    const prefix = text.slice(0, idx);
    if (!/[.!?;]\s/.test(prefix) && !/^\(/.test(prefix) && prefix.split(/\s+/).length <= 7) {
      let p = prefix;
      let via = null;
      const v = /\s*\(via ([^)]+)\)\s*$/i.exec(p);
      if (v) { via = v[1].trim(); p = p.slice(0, v.index); }
      let relation = null;
      const c = p.indexOf(", ");
      if (c > 0) { relation = p.slice(c + 2).trim(); p = p.slice(0, c); }
      if (p.trim()) return { name: p.trim(), relation, via, summary: text.slice(idx + 2).trim() };
    }
  }
  return { name: null, relation: null, via: null, summary: text.trim() };
}

function sectionStatus(title) {
  return /answered|resolved|archive/i.test(title) ? "answered" : "active";
}

// Turns the file into rows. Every date in a line's chain is kept: the first
// is opened_on, the rest become updates with no note (they were touches),
// except where an indented sub-bullet carries that date's own words.
function recordsFromPrayerFile(md) {
  const now = Date.now();
  const persons = [];
  const personByName = new Map();
  const requests = [];
  const updates = [];
  const taken = new Set();
  const uniqueId = (prefix, wanted) => {
    let id = wanted && !taken.has(wanted) ? wanted : null;
    while (!id || taken.has(id)) id = prefixedId(prefix);
    taken.add(id);
    return id;
  };
  const personFor = (name, relation) => {
    const key = name.toLowerCase();
    if (!personByName.has(key)) {
      const p = { id: uniqueId("w"), name, relation: relation || null, aliases: [], created_at: now, updated_at: now };
      personByName.set(key, p);
      persons.push(p);
    } else if (relation && !personByName.get(key).relation) {
      personByName.get(key).relation = relation;
    }
    return personByName.get(key);
  };

  parsePrayerItems(md).forEach((item, order) => {
    let { text, id } = stripBlockId(item.text.trim(), "p");
    let dates = [];
    const dm = DATE_CHAIN_RE.exec(text);
    if (dm) { dates = dm[1].split("/").map((s) => s.trim()); text = dm[2]; }
    dates = [...new Set(dates)].sort();
    const status = sectionStatus(item.section);
    const { name, relation, via, summary } = splitPersonPrefix(text);
    const person = name ? personFor(name, relation) : null;
    const category = status === "active"
      ? (HEADING_TO_CATEGORY[item.section.toLowerCase()] || "self")
      : (person ? "people" : "self");
    const opened = dates[0] || todayLocal();
    const closed = status === "active" ? null : dates[dates.length - 1] || opened;
    const req = {
      id: uniqueId("p", id),
      person_id: person ? person.id : null,
      via: via || null,
      category,
      summary,
      status,
      opened_on: opened,
      closed_on: closed,
      closed_note: null,
      sort_key: order + 1,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    requests.push(req);

    const covered = new Set([opened]);
    if (closed) covered.add(closed);
    for (const rawSub of item.subs) {
      let { text: t, id: uid } = stripBlockId(rawSub.trim(), "u");
      let praise = false;
      if (t.endsWith(PRAISE_MARK)) { praise = true; t = t.slice(0, -PRAISE_MARK.length).trimEnd(); }
      const sm = ONE_DATE_RE.exec(t);
      const onDate = sm ? sm[1] : dates[dates.length - 1] || opened;
      covered.add(onDate);
      updates.push({
        id: uniqueId("u", uid), request_id: req.id, on_date: onDate,
        note: (sm ? sm[2] : t).trim() || null, is_praise: praise,
        source_entry_id: null, created_at: now,
      });
    }
    for (const d of dates) {
      if (covered.has(d)) continue;
      covered.add(d);
      updates.push({
        id: uniqueId("u"), request_id: req.id, on_date: d, note: null,
        is_praise: false, source_entry_id: null, created_at: now,
      });
    }
  });
  return { persons, requests, updates };
}

// ---------- generating Prayer List.md ----------

function updatesByRequest(updates) {
  const map = new Map();
  for (const u of updates) {
    if (!map.has(u.request_id)) map.set(u.request_id, []);
    map.get(u.request_id).push(u);
  }
  for (const list of map.values()) {
    list.sort((a, b) => (a.on_date < b.on_date ? -1 : a.on_date > b.on_date ? 1 : a.created_at - b.created_at));
  }
  return map;
}

function requestPrefix(req, person) {
  if (person) {
    const rel = person.relation ? `, ${person.relation}` : "";
    const via = req.via ? ` (via ${req.via})` : "";
    return `${person.name}${rel}${via}: `;
  }
  return req.via ? `(via ${req.via}) ` : "";
}

function requestDates(req, ups) {
  return [...new Set([req.opened_on, ...ups.map((u) => u.on_date), req.closed_on].filter(Boolean))].sort();
}

function renderRequestLines(req, person, ups) {
  let body = requestPrefix(req, person) + flat(req.summary);
  if (req.status === "answered" && req.closed_note) body += ` Answered — ${flat(req.closed_note)}`;
  if (req.status === "archived") {
    if (req.closed_note) body += ` Archived — ${flat(req.closed_note)}`;
    else if (!/archived/i.test(body)) body += " (Archived.)";
  }
  const lines = [`- ${requestDates(req, ups).join(" / ")} — ${body} ^${req.id}`];
  for (const u of ups) {
    if (!u.note) continue;
    lines.push(`  - ${u.on_date} — ${flat(u.note)}${u.is_praise ? " " + PRAISE_MARK : ""} ^${u.id}`);
  }
  return lines;
}

const bySortKey = (a, b) => a.sort_key - b.sort_key || (a.id < b.id ? -1 : 1);

function renderPrayerFile({ persons, requests, updates }) {
  const personById = new Map(persons.map((p) => [p.id, p]));
  const ups = updatesByRequest(updates);
  const live = requests.filter((r) => !r.deleted_at);
  const lines = ["---", 'up: "[[Home]]"', "tags:", "  - reference", "---", "# Prayer List", "", PRAYER_INTRO, ""];
  const section = (title, reqs) => {
    lines.push(`## ${title}`, "");
    for (const r of reqs.sort(bySortKey)) lines.push(...renderRequestLines(r, personById.get(r.person_id), ups.get(r.id) || []));
    if (reqs.length) lines.push("");
  };
  for (const cat of PRAYER_CATEGORIES) {
    section(cat.title, live.filter((r) => r.status === "active" && r.category === cat.slug));
  }
  section(ANSWERED_TITLE, live.filter((r) => r.status !== "active"));
  return lines.join("\n").replace(/\n+$/, "\n");
}

// ---------- database ----------

function defaultPrayerMeta() {
  return { key: PRAYER_META_KEY, imported_at: null, rev: 0, synced_rev: 0, last_blob_sha: null, conflict_sha: null };
}

async function loadPrayerData() {
  prayerData = await dbTx(PRAYER_STORES, "readonly", (s, out) => {
    const res = { persons: [], requests: [], updates: [], meta: defaultPrayerMeta() };
    s[PERSONS_STORE].getAll().onsuccess = (e) => { res.persons = e.target.result; };
    s[REQUESTS_STORE].getAll().onsuccess = (e) => { res.requests = e.target.result; };
    s[UPDATES_STORE].getAll().onsuccess = (e) => { res.updates = e.target.result; };
    s[META_STORE].get(PRAYER_META_KEY).onsuccess = (e) => { if (e.target.result) res.meta = e.target.result; };
    out.result = res;
  });
  return prayerData;
}

async function getPrayerMeta() {
  const meta = await dbTx([META_STORE], "readonly", (s, out) => {
    s[META_STORE].get(PRAYER_META_KEY).onsuccess = (e) => { out.result = e.target.result; };
  });
  return meta || defaultPrayerMeta();
}

// Read-modify-write of the meta row inside one transaction.
function updatePrayerMeta(fn) {
  return dbTx([META_STORE], "readwrite", (s, out) => {
    const req = s[META_STORE].get(PRAYER_META_KEY);
    req.onsuccess = () => {
      const m = req.result || defaultPrayerMeta();
      fn(m);
      s[META_STORE].put(m);
      out.result = m;
    };
  });
}

async function prayerNeedsSync() {
  try {
    const m = await getPrayerMeta();
    return !!m.imported_at && !m.conflict_sha && m.rev > m.synced_rev;
  } catch { return false; }
}

function markPrayerSynced(rev, blobSha) {
  return updatePrayerMeta((m) => {
    m.synced_rev = Math.max(m.synced_rev || 0, rev);
    m.last_blob_sha = blobSha;
  });
}

function flagPrayerConflict(remoteSha) {
  return updatePrayerMeta((m) => { m.conflict_sha = remoteSha || "missing"; });
}

// Writes changed rows and bumps the revision in one transaction, then
// re-renders and kicks off a sync. The vault file follows on the next sync.
async function commitPrayerChange({ persons = [], requests = [], updates = [], deleteUpdates = [] }) {
  await dbTx(PRAYER_STORES, "readwrite", (s) => {
    persons.forEach((p) => s[PERSONS_STORE].put(p));
    requests.forEach((r) => s[REQUESTS_STORE].put(r));
    updates.forEach((u) => s[UPDATES_STORE].put(u));
    deleteUpdates.forEach((id) => s[UPDATES_STORE].delete(id));
    const req = s[META_STORE].get(PRAYER_META_KEY);
    req.onsuccess = () => {
      const m = req.result || defaultPrayerMeta();
      m.rev = (m.rev || 0) + 1;
      s[META_STORE].put(m);
    };
  });
  await loadPrayerData();
  renderPrayerView();
  updatePendingBadge();
  schedulePrayerSync();
}

// Several quick changes (a prayer-group round) go out as one commit: the
// sync waits until there's been a few seconds without a new change.
const PRAYER_SYNC_DELAY_MS = 4000;
let prayerSyncTimer = null;
function schedulePrayerSync() {
  clearTimeout(prayerSyncTimer);
  prayerSyncTimer = setTimeout(() => {
    prayerSyncTimer = null;
    syncNow().then(() => loadPrayerData().then(renderPrayerSyncState));
  }, PRAYER_SYNC_DELAY_MS);
}

// Replaces everything prayer-related on the phone with what the vault file
// says right now. Used for the first import and for "use the vault's version".
async function importPrayerList() {
  const file = await getFile(PRAYER_LIST_PATH);
  const recs = recordsFromPrayerFile(file ? file.content : "");
  const now = Date.now();
  await dbTx(PRAYER_STORES, "readwrite", (s) => {
    s[PERSONS_STORE].clear();
    s[REQUESTS_STORE].clear();
    s[UPDATES_STORE].clear();
    recs.persons.forEach((p) => s[PERSONS_STORE].add(p));
    recs.requests.forEach((r) => s[REQUESTS_STORE].add(r));
    recs.updates.forEach((u) => s[UPDATES_STORE].add(u));
    // rev 1 > synced 0: the next sync rewrites the file once in the app's
    // own shape (four headings, ids on each line).
    s[META_STORE].put({
      key: PRAYER_META_KEY, imported_at: now, rev: 1, synced_rev: 0,
      last_blob_sha: file ? file.sha : null, conflict_sha: null,
    });
  });
  return recs;
}

// The part of a sync commit that belongs to the Prayer List. Given the
// branch head, returns { content, rev } to write, or null to leave the file
// alone (nothing changed, or someone edited it outside the app).
async function planPrayerWrite(headSha) {
  const meta = await getPrayerMeta();
  if (!meta.imported_at || meta.conflict_sha || meta.rev <= meta.synced_rev) return null;
  const remote = await getFile(PRAYER_LIST_PATH, headSha);
  const remoteSha = remote ? remote.sha : null;
  if (remoteSha !== (meta.last_blob_sha || null)) {
    await flagPrayerConflict(remoteSha);
    return null;
  }
  const data = await loadPrayerData();
  const content = renderPrayerFile(data);
  if (remote && remote.content === content) {
    await markPrayerSynced(meta.rev, remoteSha);
    return null;
  }
  return { content, rev: meta.rev };
}

// "Send each capture separately" path: one Contents API PUT for the file.
async function sendPrayerDirect() {
  const plan = await planPrayerWrite(undefined);
  if (!plan) return;
  const meta = await getPrayerMeta();
  const res = await putFile(PRAYER_LIST_PATH, plan.content, meta.last_blob_sha, `Prayer List: ${todayLocal()} ${nowParts().time}`);
  await markPrayerSynced(plan.rev, res && res.content ? res.content.sha : null);
}

// Checks for an outside edit when the view opens, so the banner shows up
// even when there's nothing waiting to sync. Chained behind any running sync
// so the app's own fresh commit isn't mistaken for an outside edit.
function checkPrayerRemote() {
  return syncChain.then(async () => {
    const meta = await getPrayerMeta();
    if (!meta.imported_at || meta.conflict_sha || !navigator.onLine) return;
    const file = await getFile(PRAYER_LIST_PATH);
    const sha = file ? file.sha : null;
    if (sha !== (meta.last_blob_sha || null)) {
      await flagPrayerConflict(sha);
      await loadPrayerData();
      renderPrayerView();
    }
  }).catch((err) => console.error(err));
}

// ---------- mutations ----------

function findOrMakePerson(name, relation) {
  const clean = flat(name);
  if (!clean) return { person: null, changed: null };
  const now = Date.now();
  const existing = prayerData.persons.find((p) => p.name.toLowerCase() === clean.toLowerCase());
  if (existing) {
    const rel = flat(relation) || null;
    // undefined = "not given" (a quick capture), so keep what's there.
    if (relation !== undefined && rel !== existing.relation) return { person: existing, changed: { ...existing, relation: rel, updated_at: now } };
    return { person: existing, changed: null };
  }
  const p = { id: prefixedId("w"), name: clean, relation: flat(relation) || null, aliases: [], created_at: now, updated_at: now };
  return { person: p, changed: p };
}

function nextSortKey() {
  return Math.max(Date.now(), ...prayerData.requests.map((r) => r.sort_key + 1));
}

async function addPrayerRequest({ personName, relation, via, category, summary, date }) {
  const { person, changed } = findOrMakePerson(personName, relation);
  const now = Date.now();
  const req = {
    id: prefixedId("p"), person_id: person ? person.id : null, via: flat(via) || null,
    category: category || "people", summary: flat(summary), status: "active",
    opened_on: date || todayLocal(), closed_on: null, closed_note: null,
    sort_key: nextSortKey(), created_at: now, updated_at: now, deleted_at: null,
  };
  await commitPrayerChange({ persons: changed ? [changed] : [], requests: [req] });
  return req;
}

async function addPrayerUpdate(reqId, { note, isPraise, date }) {
  const req = prayerData.requests.find((r) => r.id === reqId);
  if (!req) return;
  const now = Date.now();
  const u = {
    id: prefixedId("u"), request_id: reqId, on_date: date || todayLocal(),
    note: flat(note) || null, is_praise: !!isPraise, source_entry_id: null, created_at: now,
  };
  await commitPrayerChange({ updates: [u], requests: [{ ...req, updated_at: now }] });
}

async function editPrayerRequest(reqId, { personName, relation, via, category, summary }) {
  const req = prayerData.requests.find((r) => r.id === reqId);
  if (!req) return;
  const { person, changed } = findOrMakePerson(personName, relation);
  await commitPrayerChange({
    persons: changed ? [changed] : [],
    requests: [{
      ...req, person_id: person ? person.id : null, via: flat(via) || null,
      category, summary: flat(summary), updated_at: Date.now(),
    }],
  });
}

async function closePrayerRequest(reqId, status, note, date) {
  const req = prayerData.requests.find((r) => r.id === reqId);
  if (!req) return;
  await commitPrayerChange({
    requests: [{
      ...req, status, closed_on: date || todayLocal(), closed_note: flat(note) || null,
      sort_key: nextSortKey(), updated_at: Date.now(),
    }],
  });
}

async function reopenPrayerRequest(reqId) {
  const req = prayerData.requests.find((r) => r.id === reqId);
  if (!req) return;
  await commitPrayerChange({
    requests: [{ ...req, status: "active", closed_on: null, closed_note: null, sort_key: nextSortKey(), updated_at: Date.now() }],
  });
}

async function deletePrayerRequest(reqId) {
  const req = prayerData.requests.find((r) => r.id === reqId);
  if (!req) return;
  const now = Date.now();
  await commitPrayerChange({ requests: [{ ...req, deleted_at: now, updated_at: now }] });
}

// Swaps a prayer with its neighbour in the same category (dir -1 = up,
// +1 = down). Only sort_key changes: updated_at stays put, so rearranging
// doesn't count as praying for someone today.
async function movePrayerRequest(reqId, dir) {
  const req = prayerData.requests.find((r) => r.id === reqId);
  if (!req) return;
  const peers = prayerData.requests
    .filter((r) => !r.deleted_at && r.status === "active" && r.category === req.category)
    .sort(bySortKey);
  const i = peers.indexOf(req);
  const other = peers[i + dir];
  if (!other) return;
  let a = req.sort_key, b = other.sort_key;
  if (a === b) { a = b + dir; } // ties (old imports) still need to move
  await commitPrayerChange({ requests: [{ ...req, sort_key: b }, { ...other, sort_key: a }] });
}

// One-tap sorts in Arrange mode. Each rewrites the order of every category
// once (sort_key only, like the arrows); the arrows can fine-tune after.
const PRAYER_SORTS = [
  { label: "A–Z", key: "az" },
  { label: "Oldest", key: "oldest" },
  { label: "Newest", key: "newest" },
  { label: "Recent", key: "recent" },
];

async function sortPrayerRequests(how) {
  const personById = new Map(prayerData.persons.map((p) => [p.id, p]));
  const ups = updatesByRequest(prayerData.updates);
  const name = (r) => ((personById.get(r.person_id) || {}).name || r.summary || "").toLowerCase();
  const last = (r) => { const d = requestDates(r, ups.get(r.id) || []); return d[d.length - 1] || ""; };
  const cmp = {
    az: (a, b) => name(a).localeCompare(name(b)),
    oldest: (a, b) => (a.opened_on || "").localeCompare(b.opened_on || "") || a.created_at - b.created_at,
    newest: (a, b) => (b.opened_on || "").localeCompare(a.opened_on || "") || b.created_at - a.created_at,
    recent: (a, b) => last(b).localeCompare(last(a)) || bySortKey(a, b),
  }[how];
  const changed = [];
  for (const cat of PRAYER_CATEGORIES) {
    const reqs = prayerData.requests
      .filter((r) => !r.deleted_at && r.status === "active" && r.category === cat.slug)
      .sort(bySortKey);
    const keys = reqs.map((r) => r.sort_key).sort((a, b) => a - b);
    // Reuse the category's own keys (made unique), so nothing else shifts.
    let prev = -Infinity;
    [...reqs].sort((a, b) => cmp(a, b) || bySortKey(a, b)).forEach((r, i) => {
      const k = Math.max(keys[i], prev + 1);
      prev = k;
      if (r.sort_key !== k) changed.push({ ...r, sort_key: k });
    });
  }
  if (changed.length) await commitPrayerChange({ requests: changed });
}

// ---------- view ----------

function setPrayerStatus(msg, kind) {
  pels.status.textContent = msg;
  pels.status.className = kind || "";
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text; // textContent, never innerHTML: prayer text is untrusted
  return n;
}

function renderPrayerSyncState() {
  const m = prayerData.meta;
  if (!m || !m.imported_at) { pels.syncState.textContent = ""; return; }
  if (m.conflict_sha) pels.syncState.textContent = "Sync paused";
  else if (m.rev > m.synced_rev) pels.syncState.textContent = getSettings().token ? "Waiting to sync…" : "Saved on phone";
  else pels.syncState.textContent = "Synced ✓";
}

function renderImportPanel() {
  const box = el("div", "prayer-import");
  box.appendChild(el("h2", null, "Bring your Prayer List into the app"));
  box.appendChild(el("p", null,
    "This reads Spaces/Prayer/Prayer List.md once. From then on the app keeps that file: it rewrites it when it syncs, " +
    "folds Life, Pain and Theology into Self, and adds a short id to the end of each line so it can find it again."));
  const btn = el("button", "primary-btn", "Import Prayer List");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    setPrayerStatus("Importing…", "pending");
    try {
      const recs = await importPrayerList();
      await loadPrayerData();
      const active = recs.requests.filter((r) => r.status === "active").length;
      setPrayerStatus(`Imported ${active} active and ${recs.requests.length - active} answered prayers.`, "ok");
      renderPrayerView();
      updatePendingBadge();
      syncNow().then(() => loadPrayerData().then(renderPrayerSyncState));
    } catch (err) {
      console.error(err);
      setPrayerStatus("Couldn't read the Prayer List — check your connection and token.", "err");
      btn.disabled = false;
    }
  });
  box.appendChild(btn);
  pels.content.appendChild(box);
}

function renderConflictBanner() {
  const m = prayerData.meta;
  pels.banner.innerHTML = "";
  pels.banner.hidden = !(m && m.conflict_sha);
  if (pels.banner.hidden) return;
  pels.banner.appendChild(el("p", null,
    "Prayer List.md was changed outside the app since the last sync, so the app has stopped writing it. Which version should stay?"));
  const row = el("div", "banner-actions");
  const keepApp = el("button", null, "Keep the app's list");
  keepApp.addEventListener("click", async () => {
    if (!confirm("Overwrite Prayer List.md with the app's list? The outside edit stays in git history.")) return;
    await updatePrayerMeta((mm) => {
      mm.last_blob_sha = mm.conflict_sha === "missing" ? null : mm.conflict_sha;
      mm.conflict_sha = null;
      mm.rev = (mm.rev || 0) + 1;
    });
    await loadPrayerData();
    renderPrayerView();
    syncNow().then(() => loadPrayerData().then(renderPrayerSyncState));
  });
  const useVault = el("button", null, "Use the vault's version");
  useVault.addEventListener("click", async () => {
    const pending = m.rev > m.synced_rev;
    if (!confirm(pending
      ? "Re-import from the vault? Changes made in the app since the last sync will be dropped."
      : "Re-import the Prayer List from the vault?")) return;
    setPrayerStatus("Re-importing…", "pending");
    try {
      await importPrayerList();
      await loadPrayerData();
      setPrayerStatus("Re-imported from the vault.", "ok");
      renderPrayerView();
      syncNow().then(() => loadPrayerData().then(renderPrayerSyncState));
    } catch (err) {
      console.error(err);
      setPrayerStatus("Couldn't read the Prayer List.", "err");
    }
  });
  row.append(keepApp, useVault);
  pels.banner.appendChild(row);
}

function matchesSearch(req, person, ups, q) {
  if (!q) return true;
  const hay = [person && person.name, person && person.relation, req.via, req.summary, req.closed_note, ...ups.map((u) => u.note)]
    .filter(Boolean).join(" ").toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

function renderComposer(req) {
  const box = el("div", "prayer-composer");
  const ta = el("textarea");
  ta.placeholder = "What's new? (Leave blank to just mark that you prayed today.)";
  ta.rows = 3;
  const row = el("div", "composer-row");
  const date = el("input");
  date.type = "date";
  date.value = todayLocal();
  const praiseLabel = el("label", "checkbox-label");
  const praise = el("input");
  praise.type = "checkbox";
  praiseLabel.append(praise, document.createTextNode(" Praise 🙌"));
  row.append(date, praiseLabel);
  const actions = el("div", "composer-actions");
  const cancel = el("button", null, "Cancel");
  const save = el("button", "primary-btn", "Save");
  cancel.addEventListener("click", () => { prayerUi.composingFor = null; renderPrayerView(); });
  save.addEventListener("click", async () => {
    save.disabled = true;
    await addPrayerUpdate(req.id, { note: ta.value, isPraise: praise.checked, date: date.value });
    prayerUi.composingFor = null;
    setPrayerStatus(ta.value.trim() ? "Update logged." : "Logged that you prayed today.", "ok");
    renderPrayerView();
  });
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); save.click(); }
  });
  actions.append(cancel, save);
  box.append(ta, row, actions);
  setTimeout(() => ta.focus(), 0);
  return box;
}

// "Touched today": an update dated today, or the prayer was added or edited
// today. The import itself doesn't count (it stamps every row at once).
function touchedToday(req, ups) {
  const today = todayLocal();
  if (ups.some((u) => u.on_date === today)) return true;
  const importedAt = (prayerData.meta && prayerData.meta.imported_at) || 0;
  return req.updated_at > importedAt && nowParts(new Date(req.updated_at)).date === today;
}

// Arrange mode: one compact row per prayer with up/down arrows.
function renderArrangeRow(req, person, isFirst, isLast) {
  const row = el("div", "prayer-card prayer-arrange-row");
  const label = el("div", "prayer-arrange-label");
  const title = person ? person.name : "";
  if (title) label.appendChild(el("span", "prayer-name", title));
  label.appendChild(el("span", "prayer-arrange-summary", req.summary));
  row.appendChild(label);
  const btns = el("div", "prayer-arrange-btns");
  const up = el("button", null, "↑");
  up.setAttribute("aria-label", "Move up");
  up.disabled = isFirst;
  up.addEventListener("click", () => movePrayerRequest(req.id, -1));
  const down = el("button", null, "↓");
  down.setAttribute("aria-label", "Move down");
  down.disabled = isLast;
  down.addEventListener("click", () => movePrayerRequest(req.id, 1));
  btns.append(up, down);
  row.appendChild(btns);
  return row;
}

function renderCard(req, person, ups) {
  const touched = req.status === "active" && touchedToday(req, ups);
  const card = el("div", "prayer-card" + (touched ? " touched" : ""));
  const head = el("div", "prayer-card-head");
  const dates = requestDates(req, ups);
  const last = dates[dates.length - 1];
  const title = person ? person.name + (person.relation ? `, ${person.relation}` : "") : "";
  head.appendChild(el("span", "prayer-name", title + (req.via ? ` (via ${req.via})` : "")));
  head.appendChild(touched
    ? el("span", "prayer-today", "✓ Today")
    : el("span", "prayer-last", shortDate(last) + (dates.length > 1 ? ` · ${dates.length}×` : "")));
  card.appendChild(head);

  const summary = el("div", "prayer-summary" + (prayerUi.expanded.has(req.id) ? " expanded" : ""), req.summary);
  summary.addEventListener("click", () => {
    if (prayerUi.expanded.has(req.id)) prayerUi.expanded.delete(req.id);
    else prayerUi.expanded.add(req.id);
    summary.classList.toggle("expanded");
  });
  card.appendChild(summary);
  if (req.status !== "active" && req.closed_note) {
    card.appendChild(el("div", "prayer-closed", `${req.status === "answered" ? "Answered" : "Archived"} ${shortDate(req.closed_on)}: ${req.closed_note}`));
  }

  const notes = ups.filter((u) => u.note);
  if (notes.length) {
    const ul = el("ul", "prayer-updates");
    const shown = prayerUi.expanded.has(req.id) ? notes : notes.slice(-3);
    for (const u of shown) {
      const li = el("li");
      li.appendChild(el("span", "update-date", shortDate(u.on_date)));
      li.appendChild(document.createTextNode(` ${u.note}${u.is_praise ? " " + PRAISE_MARK : ""}`));
      ul.appendChild(li);
    }
    card.appendChild(ul);
  }

  if (prayerUi.composingFor === req.id) {
    card.appendChild(renderComposer(req));
  } else {
    const actions = el("div", "prayer-actions");
    if (req.status === "active" && !touched) {
      // One tap = a blank update for today ("prayed", no note). A mistaken
      // tap can be removed under Edit.
      const prayed = el("button", "primary-btn", "🙏 Prayed");
      prayed.addEventListener("click", () => {
        prayed.disabled = true;
        addPrayerUpdate(req.id, { note: null });
      });
      actions.appendChild(prayed);
    }
    if (req.status === "active") {
      // Once touched today the button goes quiet, but still works for a second update.
      const log = el("button", touched ? "done-btn" : null, touched ? "✓ Prayed · add note" : "Add note");
      log.addEventListener("click", () => { prayerUi.composingFor = req.id; renderPrayerView(); });
      actions.appendChild(log);
    }
    const edit = el("button", null, "Edit");
    edit.addEventListener("click", () => openRequestDialog(req.id));
    actions.appendChild(edit);
    card.appendChild(actions);
  }
  return card;
}

function renderPrayerView() {
  renderPrayerSyncState();
  renderConflictBanner();
  pels.content.innerHTML = "";
  const m = prayerData.meta;
  pels.newBtn.hidden = !(m && m.imported_at) || prayerUi.arranging;
  pels.search.hidden = !(m && m.imported_at) || prayerUi.arranging;
  pels.arrangeBtn.hidden = !(m && m.imported_at);
  pels.arrangeBtn.textContent = prayerUi.arranging ? "Done" : "Arrange";
  pels.arrangeBtn.classList.toggle("primary-btn", prayerUi.arranging);
  if (!m || !m.imported_at) { renderImportPanel(); return; }
  if (prayerUi.arranging) { renderArrangeView(); return; }

  const personById = new Map(prayerData.persons.map((p) => [p.id, p]));
  const ups = updatesByRequest(prayerData.updates);
  const q = pels.search.value.trim().toLowerCase();
  const live = prayerData.requests.filter((r) => !r.deleted_at)
    .filter((r) => matchesSearch(r, personById.get(r.person_id), ups.get(r.id) || [], q));

  const activeAll = prayerData.requests.filter((r) => !r.deleted_at && r.status === "active");
  const doneToday = activeAll.filter((r) => touchedToday(r, ups.get(r.id) || [])).length;
  if (doneToday) {
    pels.content.appendChild(el("div", "prayer-progress", `Prayed through ${doneToday} of ${activeAll.length} today`));
  }

  for (const cat of PRAYER_CATEGORIES) {
    const reqs = live.filter((r) => r.status === "active" && r.category === cat.slug).sort(bySortKey);
    if (q && !reqs.length) continue;
    const catDone = reqs.filter((r) => touchedToday(r, ups.get(r.id) || [])).length;
    pels.content.appendChild(el("h2", null, `${cat.title}${reqs.length ? ` (${catDone ? `${catDone}/` : ""}${reqs.length})` : ""}`));
    if (!reqs.length) { pels.content.appendChild(el("p", "muted", "Nothing here.")); continue; }
    for (const r of reqs) pels.content.appendChild(renderCard(r, personById.get(r.person_id), ups.get(r.id) || []));
  }

  const closed = live.filter((r) => r.status !== "active").sort((a, b) => bySortKey(b, a));
  if (closed.length) {
    const details = el("details", "prayer-answered");
    if (q) details.open = true;
    details.appendChild(el("summary", null, `${ANSWERED_TITLE} (${closed.length})`));
    for (const r of closed) details.appendChild(renderCard(r, personById.get(r.person_id), ups.get(r.id) || []));
    pels.content.appendChild(details);
  }
  if (q && !live.length) pels.content.appendChild(el("p", "muted", "No matches."));
}

function renderArrangeView() {
  const personById = new Map(prayerData.persons.map((p) => [p.id, p]));
  pels.content.appendChild(el("p", "muted", "Use the arrows to set the order within each group. Tap Done when you're finished."));
  const sortRow = el("div", "prayer-sort-row");
  sortRow.appendChild(el("span", "muted", "Sort:"));
  for (const s of PRAYER_SORTS) {
    const b = el("button", null, s.label);
    b.addEventListener("click", () => sortPrayerRequests(s.key));
    sortRow.appendChild(b);
  }
  pels.content.appendChild(sortRow);
  for (const cat of PRAYER_CATEGORIES) {
    const reqs = prayerData.requests
      .filter((r) => !r.deleted_at && r.status === "active" && r.category === cat.slug).sort(bySortKey);
    pels.content.appendChild(el("h2", null, cat.title));
    if (!reqs.length) { pels.content.appendChild(el("p", "muted", "Nothing here.")); continue; }
    reqs.forEach((r, i) => pels.content.appendChild(renderArrangeRow(r, personById.get(r.person_id), i === 0, i === reqs.length - 1)));
  }
}

async function openPrayerView() {
  showView("prayer");
  setPrayerStatus("", "");
  try {
    await loadPrayerData();
  } catch (err) {
    console.error(err);
    setPrayerStatus("This browser has no local database, so the Prayer List can't be kept here.", "err");
    return;
  }
  renderPrayerView();
  checkPrayerRemote();
}

// ---------- request dialog (new + edit) ----------

function fillPersonList() {
  pels.personList.innerHTML = "";
  for (const p of [...prayerData.persons].sort((a, b) => a.name.localeCompare(b.name))) {
    const o = document.createElement("option");
    o.value = p.name;
    pels.personList.appendChild(o);
  }
}

function openRequestDialog(reqId, preset = {}) {
  fillPersonList();
  prayerUi.editingId = reqId || null;
  const req = reqId ? prayerData.requests.find((r) => r.id === reqId) : null;
  const person = req ? prayerData.persons.find((p) => p.id === req.person_id) : null;
  pels.reqTitle.textContent = req ? "Edit prayer" : "New prayer";
  pels.reqPerson.value = person ? person.name : preset.personName || "";
  pels.reqRelation.value = person ? person.relation || "" : "";
  pels.reqVia.value = req ? req.via || "" : "";
  pels.reqCategory.value = req ? req.category : preset.category || "people";
  pels.reqSummary.value = req ? req.summary : preset.summary || "";
  pels.reqDate.value = todayLocal();
  pels.reqDateField.hidden = !!req;
  pels.reqEditExtras.hidden = !req;
  pels.reqUpdates.innerHTML = "";
  if (req) {
    const active = req.status === "active";
    pels.reqAnswer.hidden = !active;
    pels.reqArchive.hidden = !active;
    pels.reqReopen.hidden = active;
    const ups = (updatesByRequest(prayerData.updates).get(req.id) || []);
    if (!ups.length) pels.reqUpdates.appendChild(el("p", "help", "No updates yet."));
    for (const u of ups) {
      const row = el("div", "update-row");
      row.appendChild(el("span", null, `${shortDate(u.on_date)} — ${u.note || "(prayed)"}${u.is_praise ? " " + PRAISE_MARK : ""}`));
      const del = el("button", "link-btn", "Remove");
      del.addEventListener("click", async () => {
        if (!confirm("Remove this update?")) return;
        await commitPrayerChange({ deleteUpdates: [u.id] });
        openRequestDialog(req.id);
      });
      row.appendChild(del);
      pels.reqUpdates.appendChild(row);
    }
  }
  if (!pels.reqDialog.open) pels.reqDialog.showModal();
  if (!req) setTimeout(() => (preset.summary ? pels.reqSummary : pels.reqPerson).focus(), 0);
}

pels.reqCancel.addEventListener("click", (e) => { e.preventDefault(); pels.reqDialog.close(); });

pels.reqSave.addEventListener("click", async (e) => {
  e.preventDefault();
  const fields = {
    personName: pels.reqPerson.value, relation: pels.reqRelation.value, via: pels.reqVia.value,
    category: pels.reqCategory.value, summary: pels.reqSummary.value,
  };
  if (!flat(fields.summary)) { pels.reqSummary.focus(); return; }
  pels.reqDialog.close();
  if (prayerUi.editingId) {
    await editPrayerRequest(prayerUi.editingId, fields);
    setPrayerStatus("Saved.", "ok");
  } else {
    await addPrayerRequest({ ...fields, date: pels.reqDate.value });
    setPrayerStatus("Added.", "ok");
  }
});

function openCloseDialog(status) {
  const reqId = prayerUi.editingId;
  pels.reqDialog.close();
  prayerUi.closing = { reqId, status };
  pels.closeTitle.textContent = status === "answered" ? "Mark answered" : "Archive";
  pels.closeNote.placeholder = status === "answered" ? "How was it answered? (optional)" : "Why archive it? (optional)";
  pels.closeNote.value = "";
  pels.closeDate.value = todayLocal();
  pels.closeDialog.showModal();
}

pels.reqAnswer.addEventListener("click", (e) => { e.preventDefault(); openCloseDialog("answered"); });
pels.reqArchive.addEventListener("click", (e) => { e.preventDefault(); openCloseDialog("archived"); });
pels.reqReopen.addEventListener("click", async (e) => {
  e.preventDefault();
  const id = prayerUi.editingId;
  pels.reqDialog.close();
  await reopenPrayerRequest(id);
  setPrayerStatus("Moved back to the active list.", "ok");
});
pels.reqDelete.addEventListener("click", async (e) => {
  e.preventDefault();
  if (!confirm("Delete this prayer from the list? (Git history keeps the old text.)")) return;
  const id = prayerUi.editingId;
  pels.reqDialog.close();
  await deletePrayerRequest(id);
  setPrayerStatus("Deleted.", "ok");
});

pels.closeCancel.addEventListener("click", (e) => { e.preventDefault(); pels.closeDialog.close(); });
pels.closeSave.addEventListener("click", async (e) => {
  e.preventDefault();
  const { reqId, status } = prayerUi.closing || {};
  pels.closeDialog.close();
  if (!reqId) return;
  await closePrayerRequest(reqId, status, pels.closeNote.value, pels.closeDate.value);
  setPrayerStatus(status === "answered" ? "Marked answered. Praise God!" : "Archived.", "ok");
});

pels.newBtn.addEventListener("click", () => openRequestDialog(null));
pels.arrangeBtn.addEventListener("click", () => {
  prayerUi.arranging = !prayerUi.arranging;
  prayerUi.composingFor = null;
  renderPrayerView();
});
pels.search.addEventListener("input", renderPrayerView);

// The capture screen's Prayer chip: once the list is imported, a prayer
// goes straight onto it ("Jordan: surgery Tuesday" files under Jordan)
// instead of into the Inbox for triage.
async function prayerListImported() {
  try { return !!(await getPrayerMeta()).imported_at; } catch { return false; }
}

async function capturePrayerRequest(text, category) {
  await loadPrayerData();
  const { name, relation, via, summary } = splitPersonPrefix(flat(text));
  await addPrayerRequest({ personName: name, relation: relation || undefined, via, category, summary });
}
