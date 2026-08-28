// Engel Capture — quick-capture PWA for the Engel-Personal Obsidian vault.
// No backend: talks straight to the GitHub Contents API using a PAT stored
// in this browser's localStorage. See README.md for the full design.

const DEFAULT_OWNER = "frank-engel";
const DEFAULT_REPO = "Engel-Personal";
const ENCOUNTERS_PATH = "+ Encounters/Inbox.md";
const CAPTURES_HEADING = "## Captures";
const JOURNAL_HEADING = "## Journal";

const state = {
  type: "journal",
  category: "people",
};

const els = {
  typeRow: document.getElementById("typeRow"),
  categoryRow: document.getElementById("categoryRow"),
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

els.settingsBtn.addEventListener("click", openSettings);

els.saveSettingsBtn.addEventListener("click", (e) => {
  e.preventDefault();
  localStorage.setItem("ec_token", els.tokenInput.value.trim());
  localStorage.setItem("ec_owner", els.ownerInput.value.trim() || DEFAULT_OWNER);
  localStorage.setItem("ec_repo", els.repoInput.value.trim() || DEFAULT_REPO);
  els.settingsDialog.close();
  setStatus("Settings saved.", "ok");
});

els.clearTokenBtn.addEventListener("click", (e) => {
  e.preventDefault();
  localStorage.removeItem("ec_token");
  els.tokenInput.value = "";
});

// ---------- UI ----------

els.typeRow.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  state.type = chip.dataset.type;
  [...els.typeRow.children].forEach((c) => c.classList.toggle("active", c === chip));
  els.categoryRow.classList.toggle("show", state.type === "prayer");
});

els.categoryRow.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  state.category = chip.dataset.category;
  [...els.categoryRow.children].forEach((c) => c.classList.toggle("active", c === chip));
});

function setStatus(msg, kind) {
  els.status.textContent = msg;
  els.status.className = kind || "";
}

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

async function captureEncounter(type, category, text) {
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
    line = `- [ ] #capture/task ${date} ${time} — ${text}`;
  } else if (type === "prayer") {
    line = `- #capture/prayer/${category} ${date} — ${text}`;
  } else {
    line = `- #capture/${type} ${date} — ${text}`;
  }

  const updated = insertUnderHeading(lines, CAPTURES_HEADING, [line], true);
  await putFile(ENCOUNTERS_PATH, updated.join("\n"), sha, `Capture (${type}): ${date} ${time}`);
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

  els.submitBtn.disabled = true;
  setStatus("Sending…", "pending");
  try {
    if (state.type === "journal") {
      await captureJournal(text);
    } else {
      await captureEncounter(state.type, state.category, text);
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
