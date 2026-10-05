// Glance stores a canvas of projects in localStorage under "glance.v2".
// {
//   version: 2,
//   camera: { x, y, zoom },
//   openId,
//   projects: [{
//     id, name, x, y, startDate,
//     current: null | { kind: "stage" | "milestone", id },
//     stages: [{ id, name, description, date, milestones: [{ id, name, date, done }] }]
//   }]
// }

const STORAGE_KEY = "glance.v2";
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2.25;
const GRID = 24;
const CALENDAR_ICON = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2 7h12M5.5 1.8v2.4M10.5 1.8v2.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;

const app = document.querySelector("#app");

const ui = {
  confirmDelete: false,
  reveal: false,
  wizard: null,
};

const MAX_WIZARD_STAGES = 30;

let state = loadState();
let pendingFocus = null;
let gesture = null;
let spaceDown = false;
let blockClick = false;
let persistTimer = 0;
let persistOk = true;

let canvas;
let world;
let panel;
let empty;
let zoomLabel;
let wizardEl;
let wizardCountTicket = 0;

function uid() {
  if (globalThis.crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function emptyState() {
  return { version: 2, camera: { x: 0, y: 0, zoom: 1 }, openId: null, projects: [] };
}

function loadState() {
  const raw = readStorage();
  if (!raw) return emptyState();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 2) return emptyState();
    const next = normalize(parsed);
    const cleaned = JSON.stringify(next);
    if (cleaned !== raw) writeStorage(cleaned);
    return next;
  } catch (err) {
    return emptyState();
  }
}

function readStorage() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    persistOk = false;
    return null;
  }
}

function writeStorage(value) {
  localStorage.setItem(STORAGE_KEY, value);
}

function finite(value, fallback) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return value;
}

function earliestProjectDate(stages) {
  let earliest = null;
  for (const stage of stages) {
    if (stage.date && (!earliest || stage.date < earliest)) earliest = stage.date;
  }
  return earliest;
}

function clamp(number, min, max) {
  return Math.min(max, Math.max(min, number));
}

function normalize(raw) {
  const projects = [];
  const seen = new Set();
  const source = Array.isArray(raw.projects) ? raw.projects : [];
  for (const project of source) {
    if (!project || typeof project.id !== "string" || seen.has(project.id)) continue;
    seen.add(project.id);
    const stages = [];
    if (Array.isArray(project.stages)) {
      for (const stage of project.stages) {
        if (!stage || typeof stage.id !== "string") continue;
        const milestones = [];
        if (Array.isArray(stage.milestones)) {
          for (const milestone of stage.milestones) {
            if (!milestone || typeof milestone.id !== "string") continue;
            milestones.push({
              id: milestone.id,
              name: typeof milestone.name === "string" ? milestone.name : "",
              date: validDate(milestone.date),
              done: milestone.done === true,
            });
          }
        }
        stages.push({
          id: stage.id,
          name: typeof stage.name === "string" ? stage.name : "",
          description: typeof stage.description === "string" ? stage.description : "",
          date: validDate(stage.date),
          milestones,
        });
      }
    }
    const current = normalizeCurrent(project.current, stages);
    projects.push({
      id: project.id,
      name: typeof project.name === "string" ? project.name : "",
      x: finite(project.x, 0),
      y: finite(project.y, 0),
      startDate: validDate(project.startDate) || earliestProjectDate(stages) || todayISO(),
      current,
      stages,
    });
  }
  const camera = raw.camera || {};
  let openId = typeof raw.openId === "string" ? raw.openId : null;
  if (!projects.some((project) => project.id === openId)) openId = null;
  return {
    version: 2,
    camera: {
      x: finite(camera.x, 0),
      y: finite(camera.y, 0),
      zoom: clamp(finite(camera.zoom, 1), MIN_ZOOM, MAX_ZOOM),
    },
    openId,
    projects,
  };
}

function normalizeCurrent(current, stages) {
  if (!current || (current.kind !== "stage" && current.kind !== "milestone") || typeof current.id !== "string") {
    return null;
  }
  if (current.kind === "stage" && stages.some((stage) => stage.id === current.id)) {
    return { kind: "stage", id: current.id };
  }
  if (current.kind === "milestone") {
    for (const stage of stages) {
      if (stage.milestones.some((milestone) => milestone.id === current.id)) {
        return { kind: "milestone", id: current.id };
      }
    }
  }
  return null;
}

function persistNow() {
  clearTimeout(persistTimer);
  persistTimer = 0;
  const wasOk = persistOk;
  try {
    writeStorage(JSON.stringify(state));
    persistOk = true;
  } catch (err) {
    persistOk = false;
  }
  const warning = document.querySelector(".warning");
  if (warning && wasOk !== persistOk) warning.hidden = persistOk;
}

function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 120);
}

function refreshFromStorage() {
  if (gesture) return;
  if (persistTimer) persistNow();
  const raw = readStorage();
  if (raw === JSON.stringify(state)) return;
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    state = parsed && parsed.version === 2 ? normalize(parsed) : emptyState();
  } catch (err) {
    return;
  }
  ui.confirmDelete = false;
  render();
}

function findProject(id) {
  return state.projects.find((project) => project.id === id) || null;
}

function activeProject() {
  return findProject(state.openId);
}

function findStage(project, stageId) {
  return project.stages.find((stage) => stage.id === stageId) || null;
}

function findMilestone(project, milestoneId) {
  for (const stage of project.stages) {
    const milestone = stage.milestones.find((item) => item.id === milestoneId);
    if (milestone) return milestone;
  }
  return null;
}

function cardEl(id) {
  const nodes = world.querySelectorAll(".card");
  for (const node of nodes) if (node.dataset.projectId === id) return node;
  return null;
}

function todayISO() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function addDays(iso, days) {
  const parsed = validDate(iso) || todayISO();
  const [year, month, day] = parsed.split("-").map(Number);
  const date = new Date(year, month - 1, day + days);
  const nextMonth = String(date.getMonth() + 1).padStart(2, "0");
  const nextDay = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${nextMonth}-${nextDay}`;
}

function formatDate(iso) {
  return validDate(iso) || iso;
}

function isoDateHtml(options) {
  const value = validDate(options.value) ? options.value : "";
  const textClass = options.textClass ? ` ${options.textClass}` : "";
  const wrapClass = options.wrapClass ? ` ${options.wrapClass}` : "";
  return `
    <span class="iso-date${wrapClass}">
      <input class="iso-date-text${textClass}" type="text" inputmode="numeric" maxlength="10" placeholder="YYYY-MM-DD" spellcheck="false" autocomplete="off" aria-label="${esc(options.label)}" value="${esc(value)}" ${options.attrs || ""}>
      <button type="button" class="iso-date-cal" data-action="open-calendar" aria-label="${esc(options.calLabel || `Choose ${options.label}`)}">${CALENDAR_ICON}</button>
      <input class="iso-date-picker" type="date" tabindex="-1" aria-hidden="true" value="${esc(value)}">
    </span>
  `;
}

function syncIsoPicker(text) {
  if (!text || !text.parentElement) return;
  const picker = text.parentElement.querySelector(".iso-date-picker");
  if (!picker) return;
  const iso = validDate(text.value.trim());
  picker.value = iso || "";
}

function currentInfo(project) {
  if (!project.current) return null;
  if (project.current.kind === "stage") {
    const stage = findStage(project, project.current.id);
    if (!stage) return null;
    return { label: stage.name.trim() || "Untitled stage" };
  }
  for (const stage of project.stages) {
    const milestone = stage.milestones.find((item) => item.id === project.current.id);
    if (milestone) return { label: milestone.name.trim() || "Untitled milestone" };
  }
  return null;
}

function datedItems(project) {
  const items = [];
  for (const stage of project.stages) {
    const stageLabel = stage.name.trim() || "Stage";
    if (stage.date) items.push({ date: stage.date, label: stageLabel });
    for (const milestone of stage.milestones) {
      if (!milestone.date) continue;
      items.push({ date: milestone.date, label: milestone.name.trim() || stageLabel });
    }
  }
  return items;
}

function nextDate(project) {
  const items = datedItems(project);
  if (!items.length) return null;
  const today = todayISO();
  const upcoming = items.filter((item) => item.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  if (upcoming.length) return upcoming[0];
  return items.sort((a, b) => b.date.localeCompare(a.date))[0];
}

function summary(project) {
  const current = currentInfo(project);
  const date = nextDate(project);
  const name = project.name.trim() || "Untitled project";
  let dateLine = "No date";
  if (date) {
    const formatted = formatDate(date.date);
    dateLine = current && date.label === current.label ? formatted : `${formatted} · ${date.label}`;
  }
  const currentLine = current ? current.label : project.stages.length ? "No current stage" : "No stages yet";
  return {
    name,
    nameEmpty: !project.name.trim(),
    current: currentLine,
    currentSet: Boolean(current),
    date: dateLine,
    datePlaceholder: !date,
    currentPlaceholder: !current,
    aria: `${name}. ${currentLine}. ${dateLine}.`,
  };
}

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cardHtml(project) {
  const info = summary(project);
  const open = state.openId === project.id;
  return `
    <article class="card${open ? " is-open" : ""}${info.currentSet ? " has-current" : ""}"
      data-project-id="${esc(project.id)}"
      data-focus-id="card-${esc(project.id)}"
      style="transform: translate(${project.x}px, ${project.y}px)"
      role="button" tabindex="0"
      aria-expanded="${open ? "true" : "false"}"
      aria-label="${esc(info.aria)}">
      <p class="card-name${info.nameEmpty ? " is-placeholder" : ""}">${esc(info.name)}</p>
      <p class="card-current">
        <span class="dot" aria-hidden="true"${info.currentSet ? "" : " hidden"}></span>
        <span class="card-current-text${info.currentPlaceholder ? " is-placeholder" : ""}">${esc(info.current)}</span>
      </p>
      <p class="card-date${info.datePlaceholder ? " is-placeholder" : ""}">${esc(info.date)}</p>
    </article>
  `;
}

function milestoneHtml(project, milestone) {
  const on = project.current && project.current.kind === "milestone" && project.current.id === milestone.id;
  const pid = esc(project.id);
  const mid = esc(milestone.id);
  return `
    <div class="node milestone${on ? " is-current" : ""}${milestone.done ? " is-done" : ""}${milestone.date ? " has-date" : ""}">
      <div class="node-stretch">
        <button type="button" class="node-current" data-action="current-milestone" data-project-id="${pid}" data-milestone-id="${mid}" data-focus-id="current-milestone-${mid}" aria-pressed="${on ? "true" : "false"}" aria-label="${on ? "Current milestone" : "Set as current"}"></button>
        <button type="button" class="mark${milestone.done ? " is-filled" : ""}" data-action="toggle-done" data-project-id="${pid}" data-milestone-id="${mid}" data-focus-id="done-${mid}" aria-pressed="${milestone.done ? "true" : "false"}" aria-label="${milestone.done ? "Done" : "Not done"}"></button>
        <input class="milestone-name" type="text" data-field="milestone-name" data-project-id="${pid}" data-milestone-id="${mid}" data-focus-id="milestone-name-${mid}" value="${esc(milestone.name)}" placeholder="Milestone" aria-label="Milestone name" maxlength="160" autocomplete="off">
      </div>
      ${isoDateHtml({
        value: milestone.date,
        label: "Milestone date",
        textClass: "milestone-date",
        attrs: `data-field="milestone-date" data-project-id="${pid}" data-milestone-id="${mid}" data-focus-id="milestone-date-${mid}"`,
      })}
      <button type="button" class="node-remove" data-action="delete-milestone" data-project-id="${pid}" data-milestone-id="${mid}" aria-label="Delete milestone"><span aria-hidden="true">×</span></button>
    </div>
  `;
}

function stageHtml(project, stage) {
  const stageOn = project.current && project.current.kind === "stage" && project.current.id === stage.id;
  const pid = esc(project.id);
  const sid = esc(stage.id);
  const nodes = stage.milestones.map((milestone) => milestoneHtml(project, milestone)).join("");
  return `
    <article class="stage-row${stageOn ? " is-stage-current" : ""}">
      <div class="stage-label">
        <div class="stage-id">
          <button type="button" class="stage-current${stageOn ? " is-on" : ""}" data-action="current-stage" data-project-id="${pid}" data-stage-id="${sid}" data-focus-id="current-stage-${sid}" aria-pressed="${stageOn ? "true" : "false"}" aria-label="${stageOn ? "Current stage" : "Set stage as current"}"><span class="stage-current-mark" aria-hidden="true"></span></button>
          <input class="stage-name" type="text" data-field="stage-name" data-project-id="${pid}" data-stage-id="${sid}" data-focus-id="stage-name-${sid}" value="${esc(stage.name)}" placeholder="Stage" aria-label="Stage name" maxlength="160" autocomplete="off">
          <button type="button" class="node-remove" data-action="delete-stage" data-project-id="${pid}" data-stage-id="${sid}" aria-label="Delete stage"><span aria-hidden="true">×</span></button>
        </div>
        <textarea class="stage-description" data-field="stage-description" data-project-id="${pid}" data-stage-id="${sid}" data-focus-id="stage-desc-${sid}" placeholder="Description" aria-label="Stage description" maxlength="4000" rows="1">${esc(stage.description)}</textarea>
        ${isoDateHtml({
          value: stage.date,
          label: "Stage date",
          textClass: "stage-date",
          wrapClass: `stage-date-control${stage.date ? " has-date" : ""}`,
          attrs: `data-field="stage-date" data-project-id="${pid}" data-stage-id="${sid}" data-focus-id="stage-date-${sid}"`,
        })}
      </div>
      <div class="timeline">
        ${nodes}
        <button type="button" class="add-node" data-action="add-milestone" data-project-id="${pid}" data-stage-id="${sid}" aria-label="Add milestone"><span aria-hidden="true">+</span></button>
      </div>
    </article>
  `;
}

function panelHtml(project) {
  const stages = project.stages.map((stage) => stageHtml(project, stage)).join("");
  const foot = ui.confirmDelete
    ? `<div class="confirm">
        <p>Delete this project and everything on it?</p>
        <button type="button" class="button button-danger" data-action="confirm-delete-project" data-focus-id="confirm-delete-project">Delete project</button>
        <button type="button" class="button button-quiet" data-action="cancel-delete-project">Cancel</button>
      </div>`
    : `<button type="button" class="text-button danger" data-action="ask-delete-project" data-focus-id="ask-delete-project">Delete project</button>`;
  return `
    <div class="board-top">
      <div class="board-title">
        <input class="project-name" type="text" data-field="project-name" data-project-id="${esc(project.id)}" data-focus-id="project-name" value="${esc(project.name)}" placeholder="Project name" aria-label="Project name" maxlength="120" autocomplete="off">
        <div class="project-start">
          <span>Project start</span>
          ${isoDateHtml({
            value: project.startDate,
            label: "Project start",
            attrs: `data-field="project-start" data-project-id="${esc(project.id)}" data-focus-id="project-start"`,
          })}
        </div>
      </div>
      <button type="button" class="button button-quiet" data-action="collapse">Collapse</button>
    </div>
    <div class="panel-body">
      ${stages || `<p class="quiet">No stages yet.</p>`}
      <button type="button" class="add-stage" data-action="add-stage" data-project-id="${esc(project.id)}">Add stage</button>
    </div>
    <div class="panel-foot">${foot}</div>
  `;
}

function render() {
  const previous = document.activeElement;
  const previousScroll = panel.querySelector(".panel-body");
  const scrollTop = previousScroll ? previousScroll.scrollTop : 0;
  world.innerHTML = state.projects.map(cardHtml).join("");
  const project = activeProject();
  if (!project) {
    panel.hidden = true;
    panel.innerHTML = "";
  } else {
    panel.hidden = false;
    panel.innerHTML = panelHtml(project);
    const body = panel.querySelector(".panel-body");
    if (body) body.scrollTop = scrollTop;
  }
  empty.hidden = state.projects.length > 0;
  document.body.classList.toggle("panel-open", Boolean(project));
  syncTitle();
  applyCamera();
  restoreFocus(previous);
  presentWizard();
  if (ui.reveal && project) {
    ui.reveal = false;
    reveal(project);
    persistNow();
  }
}

function restoreFocus(previous) {
  const requested = pendingFocus;
  pendingFocus = null;
  const previousId = previous && previous.dataset ? previous.dataset.focusId : null;
  const id = requested || previousId;
  if (!id) return;
  const el = focusElement(id);
  if (!el) return;
  el.focus();
  if (!requested) {
    const selection = readSelection(previous);
    if (selection && typeof el.setSelectionRange === "function") {
      try {
        el.setSelectionRange(selection.start, selection.end);
      } catch (err) {
        // Date inputs do not support a text selection.
      }
    }
  } else if (el.closest(".panel")) {
    el.scrollIntoView({ block: "nearest" });
  }
}

function readSelection(element) {
  if (!element) return null;
  try {
    if (typeof element.selectionStart !== "number") return null;
    return { start: element.selectionStart, end: element.selectionEnd };
  } catch (err) {
    return null;
  }
}

function focusElement(id) {
  const nodes = app.querySelectorAll("[data-focus-id]");
  for (const node of nodes) if (node.dataset.focusId === id) return node;
  return null;
}

function syncTitle() {
  const project = activeProject();
  document.title = project ? `Glance · ${project.name.trim() || "Untitled project"}` : "Glance";
}

function placeChrome() {
  const bar = document.querySelector(".bar");
  if (!bar) return;
  const top = Math.ceil(bar.getBoundingClientRect().bottom + 12);
  document.documentElement.style.setProperty("--chrome-top", `${top}px`);
}

function applyCamera() {
  const camera = state.camera;
  world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`;
  const size = GRID * camera.zoom;
  canvas.style.backgroundSize = `${size}px ${size}px`;
  canvas.style.backgroundPosition = `${camera.x}px ${camera.y}px`;
  zoomLabel.textContent = `${Math.round(camera.zoom * 100)}%`;
}

function screenPoint(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function zoomAt(sx, sy, factor) {
  const camera = state.camera;
  const next = clamp(camera.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  if (next === camera.zoom) return;
  const worldX = (sx - camera.x) / camera.zoom;
  const worldY = (sy - camera.y) / camera.zoom;
  camera.zoom = next;
  camera.x = sx - worldX * next;
  camera.y = sy - worldY * next;
  applyCamera();
}

function coveringPanelWidth() {
  if (!panel || panel.hidden) return 0;
  const rect = canvas.getBoundingClientRect();
  const width = panel.getBoundingClientRect().width;
  if (width > rect.width * 0.75) return 0;
  return width;
}

function zoomAroundCenter(factor) {
  const rect = canvas.getBoundingClientRect();
  const panelWidth = coveringPanelWidth();
  zoomAt((rect.width - panelWidth) / 2, rect.height / 2, factor);
  persistSoon();
}

function resetZoom() {
  const camera = state.camera;
  const rect = canvas.getBoundingClientRect();
  const sx = rect.width / 2;
  const sy = rect.height / 2;
  const worldX = (sx - camera.x) / camera.zoom;
  const worldY = (sy - camera.y) / camera.zoom;
  camera.zoom = 1;
  camera.x = sx - worldX;
  camera.y = sy - worldY;
  applyCamera();
  persistNow();
}

function visibleRight() {
  const rect = canvas.getBoundingClientRect();
  return rect.width - coveringPanelWidth() - 24;
}

function reveal(project) {
  const el = cardEl(project.id);
  if (!el) return;
  const camera = state.camera;
  const rect = canvas.getBoundingClientRect();
  const width = el.offsetWidth * camera.zoom;
  const height = el.offsetHeight * camera.zoom;
  let screenX = project.x * camera.zoom + camera.x;
  let screenY = project.y * camera.zoom + camera.y;
  const right = visibleRight();
  let dx = 0;
  let dy = 0;
  if (screenX + width > right) dx = right - (screenX + width);
  if (screenX + dx < 16) dx = 16 - screenX;
  if (screenY + height > rect.height - 24) dy = rect.height - 24 - (screenY + height);
  if (screenY + dy < 72) dy = 72 - screenY;
  if (dx === 0 && dy === 0) return;
  camera.x += dx;
  camera.y += dy;
  applyCamera();
}

function placePoint() {
  const rect = canvas.getBoundingClientRect();
  const panelWidth = coveringPanelWidth();
  const camera = state.camera;
  let x = ((rect.width - panelWidth) / 2 - camera.x) / camera.zoom - 116;
  let y = (rect.height / 2 - camera.y) / camera.zoom - 48;
  let step = 0;
  while (state.projects.some((project) => Math.hypot(project.x - x, project.y - y) < 20) && step < 12) {
    x += 28;
    y += 28;
    step += 1;
  }
  return { x, y };
}

function patchProject(project) {
  const info = summary(project);
  const card = cardEl(project.id);
  if (card) {
    card.classList.toggle("is-open", state.openId === project.id);
    card.classList.toggle("has-current", info.currentSet);
    card.setAttribute("aria-expanded", state.openId === project.id ? "true" : "false");
    card.setAttribute("aria-label", info.aria);
    const name = card.querySelector(".card-name");
    name.textContent = info.name;
    name.classList.toggle("is-placeholder", info.nameEmpty);
    const current = card.querySelector(".card-current-text");
    current.textContent = info.current;
    current.classList.toggle("is-placeholder", info.currentPlaceholder);
    const dot = card.querySelector(".dot");
    if (dot) dot.hidden = !info.currentSet;
    const date = card.querySelector(".card-date");
    date.textContent = info.date;
    date.classList.toggle("is-placeholder", info.datePlaceholder);
  }
  if (state.openId === project.id) {
    const glance = document.querySelector(".panel-glance");
    if (glance) glance.textContent = `${info.current} · ${info.date}`;
    syncTitle();
  }
}

function openProject(id) {
  if (!findProject(id)) return;
  state.openId = id;
  ui.confirmDelete = false;
  ui.reveal = true;
  pendingFocus = "project-name";
  persistNow();
  render();
}

function collapse() {
  const id = state.openId;
  state.openId = null;
  ui.confirmDelete = false;
  pendingFocus = id ? `card-${id}` : null;
  persistNow();
  render();
}

function wizardCount(value) {
  const text = String(value == null ? "" : value).trim();
  if (!/^[1-9]\d*$/.test(text)) return null;
  const count = Number(text);
  if (count > MAX_WIZARD_STAGES) return null;
  return count;
}

function wizardStartDate() {
  return (ui.wizard && validDate(ui.wizard.startDate)) || todayISO();
}

function stageChainDate(previousStage) {
  if (!previousStage) return wizardStartDate();
  const milestones = previousStage.milestones || [];
  for (let i = milestones.length - 1; i >= 0; i -= 1) {
    const date = validDate(milestones[i].date);
    if (date) return date;
  }
  return validDate(previousStage.date) || wizardStartDate();
}

function blankWizardMilestone(index, anchor) {
  return {
    name: `Milestone ${index + 1}`,
    date: validDate(anchor) || wizardStartDate(),
  };
}

function blankWizardStage(index, previousStage) {
  const date = index === 0 ? wizardStartDate() : stageChainDate(previousStage);
  return {
    name: `Stage ${index + 1}`,
    description: "",
    date,
    milestones: [blankWizardMilestone(0, date)],
  };
}

function wizardDurationHtml(action, stageIndex, milestoneIndex) {
  const stageAttr = ` data-stage-index="${stageIndex}"`;
  const indexAttr = milestoneIndex == null ? "" : ` data-index="${milestoneIndex}"`;
  const day1 = action === "wizard-stage-duration" ? "wizard-stage-day1" : "wizard-milestone-day1";
  const adds = [30, 90, 180].map((days) => `
    <button type="button" class="wizard-duration" data-action="${action}" data-days="${days}"${stageAttr}${indexAttr} aria-label="Add ${days} days">+${days}</button>
  `).join("");
  return `
    <button type="button" class="wizard-duration wizard-day1" data-action="${day1}"${stageAttr}${indexAttr} aria-label="Reset to project start">Day 1</button>
    ${adds}
  `;
}

function openWizard() {
  ui.wizard = {
    step: 0,
    name: "",
    countText: "",
    startDate: todayISO(),
    count: 0,
    stages: [],
    error: "",
    focus: "project-name",
  };
  presentWizard();
}

function closeWizard() {
  ui.wizard = null;
  presentWizard();
  const el = focusElement("add-project-assisted");
  if (el) el.focus();
}

function presentWizard() {
  if (!wizardEl) return;
  if (!ui.wizard) {
    wizardEl.hidden = true;
    wizardEl.innerHTML = "";
    wizardEl.dataset.key = "";
    wizardEl.classList.remove("is-board");
    return;
  }
  wizardEl.classList.toggle("is-board", ui.wizard.step > 0);
  const milestoneKey = ui.wizard.stages.map((stage) => stage.milestones.length).join(",");
  const key = `${ui.wizard.step}:${ui.wizard.stages.length}:${milestoneKey}:${ui.wizard.error}`;
  if (wizardEl.dataset.key === key && !wizardEl.hidden) return;
  const focus = ui.wizard.focus;
  wizardEl.hidden = false;
  wizardEl.dataset.key = key;
  wizardEl.innerHTML = wizardHtml();
  if (!focus) return;
  const el = wizardEl.querySelector(`[data-wizard-focus="${focus}"]`) || wizardEl.querySelector("[data-wizard-focus]");
  if (el) el.focus();
}

function showWizardError() {
  const w = ui.wizard;
  if (!wizardEl || !w) return;
  let note = wizardEl.querySelector(".wizard-note");
  if (!w.error) {
    if (note) note.hidden = true;
    return;
  }
  if (!note) {
    note = document.createElement("p");
    note.className = "wizard-note";
    note.setAttribute("role", "alert");
    const side = wizardEl.querySelector(".wizard-side, .wizard-body");
    const title = wizardEl.querySelector("#wizard-title");
    if (title) title.insertAdjacentElement("afterend", note);
    else if (side) side.prepend(note);
    else return;
  }
  note.hidden = false;
  note.textContent = w.error;
}

function wizardHtml() {
  if (ui.wizard.step > 0) return wizardBoardHtml();
  const w = ui.wizard;
  const note = w.error ? `<p class="wizard-note" role="alert">${esc(w.error)}</p>` : "";
  return `
    <div class="wizard-scrim" data-action="wizard-cancel"></div>
    <div class="wizard-card" role="dialog" aria-modal="true" aria-labelledby="wizard-title">
      <div class="wizard-progress" aria-hidden="true"><span style="width:8%"></span></div>
      <div class="wizard-top">
        <div class="wizard-heading">
          <p class="wizard-kicker">Assisted</p>
          <h2 id="wizard-title">New project</h2>
        </div>
        <button type="button" class="wizard-close" data-action="wizard-cancel" aria-label="Close"><span aria-hidden="true">×</span></button>
      </div>
      <div class="wizard-body">
        ${note}
        ${wizardStartHtml()}
      </div>
      <div class="wizard-foot">
        <button type="button" class="text-button" data-action="wizard-cancel">Cancel</button>
        <div class="wizard-nav">
          <button type="button" class="button" data-action="wizard-next">Next</button>
        </div>
      </div>
    </div>
  `;
}

function wizardBoardHtml() {
  const w = ui.wizard;
  const note = w.error ? `<p class="wizard-note" role="alert">${esc(w.error)}</p>` : "";
  const rows = w.stages.map((stage, index) => wizardStageRowHtml(stage, index)).join("");
  return `
    <div class="wizard-scrim" data-action="wizard-cancel"></div>
    <div class="wizard-card" role="dialog" aria-modal="true" aria-labelledby="wizard-title">
      <div class="wizard-board">
        <aside class="wizard-side">
          <p class="wizard-kicker">Assisted</p>
          <h2 id="wizard-title">Project</h2>
          ${note}
          <label class="wizard-field">
            <span>Project name</span>
            <input class="wizard-name" type="text" data-wizard-field="project-name" data-wizard-focus="project-name" value="${esc(w.name)}" placeholder="Project name" maxlength="120" autocomplete="off">
          </label>
          <div class="wizard-field">
            <span>Project start</span>
            ${isoDateHtml({
              value: w.startDate,
              label: "Project start",
              attrs: `data-wizard-field="project-start" data-wizard-focus="project-start"`,
            })}
          </div>
          <label class="wizard-field">
            <span>Number of stages</span>
            <input class="wizard-count" type="text" inputmode="numeric" data-wizard-field="stage-count" data-wizard-focus="stage-count" value="${esc(w.countText)}" placeholder="3" maxlength="2" autocomplete="off">
          </label>
          <button type="button" class="text-button wizard-back" data-action="wizard-back">Back</button>
        </aside>
        <div class="wizard-stage-scroll" tabindex="-1">
          ${rows}
        </div>
      </div>
      <div class="wizard-foot">
        <button type="button" class="text-button" data-action="wizard-cancel">Cancel</button>
        <button type="button" class="button" data-action="wizard-finish">Create project</button>
      </div>
      <button type="button" class="wizard-close" data-action="wizard-cancel" aria-label="Close"><span aria-hidden="true">×</span></button>
    </div>
  `;
}

function wizardStartHtml() {
  const w = ui.wizard;
  return `
    <p class="wizard-lead">Name the project, set day 1, and choose how many stages. Next opens every stage together. Later dates start where the previous one left off. +30, +90, and +180 add to the date shown. Nothing is added until you finish.</p>
    <label class="wizard-field">
      <span>Project name</span>
      <input class="wizard-name" type="text" data-wizard-field="project-name" data-wizard-focus="project-name" value="${esc(w.name)}" placeholder="Project name" maxlength="120" autocomplete="off">
    </label>
    <div class="wizard-field">
      <span>Project start</span>
      ${isoDateHtml({
        value: w.startDate,
        label: "Project start",
        attrs: `data-wizard-field="project-start"`,
      })}
    </div>
    <label class="wizard-field">
      <span>Number of stages</span>
      <input class="wizard-count" type="text" inputmode="numeric" data-wizard-field="stage-count" data-wizard-focus="stage-count" value="${esc(w.countText)}" placeholder="3" maxlength="2" autocomplete="off">
    </label>
  `;
}

function wizardStageRowHtml(stage, stageIndex) {
  const milestones = stage.milestones.map((milestone, index) => `
    <div class="wizard-milestone">
      <div class="wizard-milestone-head">
        <input class="wizard-milestone-name" type="text" data-wizard-field="milestone-name" data-stage-index="${stageIndex}" data-index="${index}" data-wizard-focus="milestone-${stageIndex}-${index}" value="${esc(milestone.name)}" placeholder="Milestone" maxlength="160" aria-label="Milestone ${index + 1} name" autocomplete="off">
        <button type="button" class="wizard-remove" data-action="wizard-remove-milestone" data-stage-index="${stageIndex}" data-index="${index}" aria-label="Remove milestone"><span aria-hidden="true">×</span></button>
      </div>
      ${isoDateHtml({
        value: milestone.date,
        label: `Milestone ${index + 1} date`,
        textClass: "wizard-milestone-date",
        attrs: `data-wizard-field="milestone-date" data-stage-index="${stageIndex}" data-index="${index}"`,
      })}
      <div class="wizard-durations" role="group" aria-label="Add days or return to day 1">
        ${wizardDurationHtml("wizard-milestone-duration", stageIndex, index)}
      </div>
    </div>
  `).join("");
  const open = stage.description ? " open" : "";
  return `
    <section class="wizard-stage-row">
      <div class="wizard-stage-label">
        <input class="wizard-stage-name" type="text" data-wizard-field="stage-name" data-stage-index="${stageIndex}" data-wizard-focus="stage-${stageIndex}-name" value="${esc(stage.name)}" placeholder="Stage name" maxlength="160" aria-label="Stage ${stageIndex + 1} name" autocomplete="off">
        <div class="wizard-when">
          <div class="wizard-date-row">
            ${isoDateHtml({
              value: stage.date,
              label: `Stage ${stageIndex + 1} date`,
              textClass: "wizard-stage-date",
              attrs: `data-wizard-field="stage-date" data-stage-index="${stageIndex}"`,
            })}
            <div class="wizard-durations" role="group" aria-label="Add days or return to day 1">
              ${wizardDurationHtml("wizard-stage-duration", stageIndex)}
            </div>
          </div>
        </div>
        <details class="wizard-desc"${open}>
          <summary>Description</summary>
          <textarea class="wizard-description" data-wizard-field="stage-description" data-stage-index="${stageIndex}" placeholder="Optional" maxlength="4000" rows="2">${esc(stage.description)}</textarea>
        </details>
      </div>
      <div class="wizard-stage-track">
        ${milestones}
        <button type="button" class="add-node wizard-add-milestone" data-action="wizard-add-milestone" data-stage-index="${stageIndex}" aria-label="Add milestone">+</button>
      </div>
    </section>
  `;
}

function readIsoValue(el, previous) {
  const raw = el.value.trim();
  if (validDate(raw)) return raw;
  if (raw === "") return "";
  return previous;
}

function readWizardFields() {
  const w = ui.wizard;
  if (!w || !wizardEl) return;
  wizardEl.querySelectorAll("[data-wizard-field]").forEach((el) => {
    const field = el.dataset.wizardField;
    if (field === "project-name") w.name = el.value;
    else if (field === "project-start") {
      const next = readIsoValue(el, w.startDate);
      if (next) w.startDate = next;
    } else if (field === "stage-count") w.countText = el.value;
    else if (w.step > 0) {
      const stage = w.stages[Number(el.dataset.stageIndex)];
      if (!stage) return;
      if (field === "stage-name") stage.name = el.value;
      else if (field === "stage-date") stage.date = readIsoValue(el, stage.date);
      else if (field === "stage-description") stage.description = el.value;
      else if (field === "milestone-name" || field === "milestone-date") {
        const index = Number(el.dataset.index);
        if (!stage.milestones[index]) return;
        if (field === "milestone-name") stage.milestones[index].name = el.value;
        else stage.milestones[index].date = readIsoValue(el, stage.milestones[index].date);
      }
    }
  });
}

function rememberWizardField(el) {
  if (!ui.wizard || !el.dataset.wizardField) return;
  readWizardFields();
  if (ui.wizard.error) {
    ui.wizard.error = "";
    const note = wizardEl.querySelector(".wizard-note");
    if (note) note.hidden = true;
  }
}

function resizeWizardStages(count) {
  const w = ui.wizard;
  w.count = count;
  w.countText = String(count);
  while (w.stages.length < count) {
    const index = w.stages.length;
    w.stages.push(blankWizardStage(index, index > 0 ? w.stages[index - 1] : null));
  }
  if (w.stages.length > count) w.stages.length = count;
}

function commitWizardCount() {
  if (!ui.wizard || ui.wizard.step < 1) return;
  const ticket = ++wizardCountTicket;
  setTimeout(() => {
    if (ticket !== wizardCountTicket || !ui.wizard || ui.wizard.step < 1) return;
    readWizardFields();
    const count = wizardCount(ui.wizard.countText);
    if (!count) {
      ui.wizard.error = "Enter a number of stages from 1 to 30.";
      showWizardError();
      return;
    }
    const changed = count !== ui.wizard.stages.length;
    ui.wizard.count = count;
    ui.wizard.error = "";
    showWizardError();
    if (!changed) return;
    resizeWizardStages(count);
    const active = document.activeElement;
    let focus = "stage-count";
    if (active && wizardEl.contains(active) && active.dataset.wizardFocus && active.dataset.wizardFocus !== "stage-count") {
      focus = active.dataset.wizardFocus;
    } else if (active && wizardEl.contains(active) && !active.dataset.wizardField) {
      focus = "";
    }
    ui.wizard.focus = focus;
    wizardEl.dataset.key = "";
    presentWizard();
  }, 0);
}

function wizardCurrentDate(stageIndex, kind, index) {
  const stage = ui.wizard.stages[stageIndex];
  if (!stage) return wizardStartDate();
  if (kind === "stage") return validDate(stage.date) || wizardStartDate();
  const milestone = stage.milestones[index];
  return (milestone && validDate(milestone.date)) || validDate(stage.date) || wizardStartDate();
}

function wizardWriteDate(stageIndex, kind, index, iso) {
  const stage = ui.wizard.stages[stageIndex];
  if (!stage) return;
  let input = null;
  if (kind === "stage") {
    stage.date = iso;
    input = wizardEl.querySelector(`[data-wizard-field='stage-date'][data-stage-index='${stageIndex}']`);
  } else if (stage.milestones[index]) {
    stage.milestones[index].date = iso;
    input = wizardEl.querySelector(`[data-wizard-field='milestone-date'][data-stage-index='${stageIndex}'][data-index='${index}']`);
  }
  if (!input) return;
  input.value = iso;
  syncIsoPicker(input);
}

function wizardApplyDuration(stageIndex, kind, index, days) {
  if (!ui.wizard || ui.wizard.step < 1 || !Number.isFinite(days)) return;
  readWizardFields();
  wizardWriteDate(stageIndex, kind, index, addDays(wizardCurrentDate(stageIndex, kind, index), days));
}

function wizardDay1(stageIndex, kind, index) {
  if (!ui.wizard || ui.wizard.step < 1) return;
  readWizardFields();
  wizardWriteDate(stageIndex, kind, index, wizardStartDate());
}

function wizardNext() {
  if (!ui.wizard) return;
  readWizardFields();
  const w = ui.wizard;
  if (w.step === 0) {
    if (!w.name.trim()) {
      w.error = "Name the project to continue.";
      w.focus = "project-name";
      wizardEl.dataset.key = "";
      presentWizard();
      return;
    }
    const count = wizardCount(w.countText);
    if (!count) {
      w.error = "Enter a number of stages from 1 to 30.";
      w.focus = "stage-count";
      wizardEl.dataset.key = "";
      presentWizard();
      return;
    }
    w.startDate = validDate(w.startDate) || todayISO();
    resizeWizardStages(count);
    w.step = 1;
    w.error = "";
    w.focus = "stage-0-name";
    wizardEl.dataset.key = "";
    presentWizard();
  }
}

function wizardBack() {
  if (!ui.wizard || ui.wizard.step < 1) return;
  readWizardFields();
  ui.wizard.error = "";
  ui.wizard.step = 0;
  ui.wizard.focus = "project-name";
  wizardEl.dataset.key = "";
  presentWizard();
}

function wizardAddMilestone(stageIndex) {
  if (!ui.wizard || ui.wizard.step < 1) return;
  readWizardFields();
  const stage = ui.wizard.stages[stageIndex];
  if (!stage) return;
  const index = stage.milestones.length;
  const previous = index > 0 ? stage.milestones[index - 1] : null;
  const anchor = previous
    ? validDate(previous.date) || validDate(stage.date) || wizardStartDate()
    : validDate(stage.date) || wizardStartDate();
  stage.milestones.push(blankWizardMilestone(index, anchor));
  ui.wizard.error = "";
  ui.wizard.focus = `milestone-${stageIndex}-${index}`;
  wizardEl.dataset.key = "";
  presentWizard();
}

function wizardRemoveMilestone(stageIndex, index) {
  if (!ui.wizard || ui.wizard.step < 1) return;
  readWizardFields();
  const stage = ui.wizard.stages[stageIndex];
  if (!stage || !stage.milestones[index]) return;
  stage.milestones.splice(index, 1);
  ui.wizard.error = "";
  ui.wizard.focus = `stage-${stageIndex}-name`;
  wizardEl.dataset.key = "";
  presentWizard();
}

function wizardCreate() {
  if (!ui.wizard || ui.wizard.step < 1) return;
  readWizardFields();
  const w = ui.wizard;
  if (!w.name.trim()) {
    w.error = "Name the project to continue.";
    w.focus = "project-name";
    wizardEl.dataset.key = "";
    presentWizard();
    return;
  }
  const count = wizardCount(w.countText);
  if (!count) {
    w.error = "Enter a number of stages from 1 to 30.";
    w.focus = "stage-count";
    wizardEl.dataset.key = "";
    presentWizard();
    return;
  }
  if (count !== w.stages.length) resizeWizardStages(count);
  for (let i = 0; i < w.stages.length; i += 1) {
    const stage = w.stages[i];
    if (!stage.name.trim()) {
      w.error = "Name each stage to continue.";
      w.focus = `stage-${i}-name`;
      wizardEl.dataset.key = "";
      presentWizard();
      return;
    }
    const unnamed = stage.milestones.findIndex((milestone) => !milestone.name.trim() && milestone.date);
    if (unnamed >= 0) {
      w.error = "Name each milestone, or remove it.";
      w.focus = `milestone-${i}-${unnamed}`;
      wizardEl.dataset.key = "";
      presentWizard();
      return;
    }
    stage.milestones = stage.milestones.filter((milestone) => milestone.name.trim());
  }
  finishWizard();
}

function finishWizard() {
  const w = ui.wizard;
  const point = placePoint();
  const stages = w.stages.map((stage) => ({
    id: uid(),
    name: stage.name.trim(),
    description: stage.description.trim(),
    date: validDate(stage.date),
    milestones: stage.milestones.filter((milestone) => milestone.name.trim()).map((milestone) => ({
      id: uid(),
      name: milestone.name.trim(),
      date: validDate(milestone.date),
      done: false,
    })),
  }));
  const project = {
    id: uid(),
    name: w.name.trim(),
    x: point.x,
    y: point.y,
    startDate: validDate(w.startDate) || todayISO(),
    current: stages.length ? { kind: "stage", id: stages[0].id } : null,
    stages,
  };
  state.projects.push(project);
  state.openId = project.id;
  ui.confirmDelete = false;
  ui.reveal = true;
  ui.wizard = null;
  pendingFocus = "project-name";
  persistNow();
  render();
}

function addProject() {
  const point = placePoint();
  const project = {
    id: uid(),
    name: "",
    x: point.x,
    y: point.y,
    startDate: todayISO(),
    current: null,
    stages: [],
  };
  state.projects.push(project);
  state.openId = project.id;
  ui.confirmDelete = false;
  ui.reveal = true;
  pendingFocus = "project-name";
  persistNow();
  render();
}

function addStage(projectId) {
  const project = findProject(projectId);
  if (!project) return;
  const stage = { id: uid(), name: "", description: "", date: null, milestones: [] };
  project.stages.push(stage);
  if (!project.current) project.current = { kind: "stage", id: stage.id };
  pendingFocus = `stage-name-${stage.id}`;
  persistNow();
  render();
}

function addMilestone(projectId, stageId) {
  const project = findProject(projectId);
  const stage = project && findStage(project, stageId);
  if (!stage) return;
  const milestone = { id: uid(), name: "", date: null, done: false };
  stage.milestones.push(milestone);
  pendingFocus = `milestone-name-${milestone.id}`;
  persistNow();
  render();
}

function deleteStage(projectId, stageId) {
  const project = findProject(projectId);
  if (!project) return;
  project.stages = project.stages.filter((stage) => stage.id !== stageId);
  project.current = normalizeCurrent(project.current, project.stages);
  persistNow();
  render();
}

function deleteMilestone(projectId, milestoneId) {
  const project = findProject(projectId);
  if (!project) return;
  for (const stage of project.stages) {
    stage.milestones = stage.milestones.filter((milestone) => milestone.id !== milestoneId);
  }
  project.current = normalizeCurrent(project.current, project.stages);
  persistNow();
  render();
}

function toggleDone(projectId, milestoneId) {
  const project = findProject(projectId);
  const milestone = project && findMilestone(project, milestoneId);
  if (!milestone) return;
  milestone.done = !milestone.done;
  pendingFocus = `done-${milestoneId}`;
  persistNow();
  render();
}

function setCurrent(projectId, kind, id) {
  const project = findProject(projectId);
  if (!project) return;
  const same = project.current && project.current.kind === kind && project.current.id === id;
  project.current = same ? null : { kind, id };
  pendingFocus = `current-${kind}-${id}`;
  persistNow();
  render();
}

function setStageDate(project, stageId, value) {
  const stage = findStage(project, stageId);
  if (!stage) return;
  stage.date = validDate(value);
  persistNow();
  patchProject(project);
}

function setMilestoneDate(project, milestoneId, value) {
  const milestone = findMilestone(project, milestoneId);
  if (!milestone) return;
  milestone.date = validDate(value);
  persistNow();
  patchProject(project);
}

function deleteProject() {
  const id = state.openId;
  state.projects = state.projects.filter((project) => project.id !== id);
  state.openId = null;
  ui.confirmDelete = false;
  persistNow();
  render();
}

function openIsoCalendar(button) {
  const wrap = button.closest(".iso-date");
  if (!wrap) return;
  const text = wrap.querySelector(".iso-date-text");
  const picker = wrap.querySelector(".iso-date-picker");
  if (!text || !picker) return;
  const iso = validDate(text.value.trim());
  if (iso) picker.value = iso;
  try {
    if (typeof picker.showPicker === "function") picker.showPicker();
    else picker.focus();
  } catch (err) {
    picker.focus();
  }
}

function applyProjectDate(el) {
  const project = findProject(el.dataset.projectId);
  if (!project) return;
  const raw = el.value.trim();
  const iso = validDate(raw);
  if (!iso && raw !== "") return;
  const field = el.dataset.field;
  if (field === "project-start") {
    if (!iso) return;
    project.startDate = iso;
  } else if (field === "stage-date") {
    setStageDate(project, el.dataset.stageId, raw);
    const wrap = el.closest(".stage-date-control");
    if (wrap) wrap.classList.toggle("has-date", Boolean(iso));
    syncIsoPicker(el);
    return;
  } else if (field === "milestone-date") {
    setMilestoneDate(project, el.dataset.milestoneId, raw);
    const node = el.closest(".node");
    if (node) node.classList.toggle("has-date", Boolean(iso));
    syncIsoPicker(el);
    return;
  } else return;
  syncIsoPicker(el);
  persistNow();
  patchProject(project);
}

function restoreIsoText(el) {
  if (!el || !el.classList || !el.classList.contains("iso-date-text")) return;
  const raw = el.value.trim();
  if (validDate(raw)) {
    syncIsoPicker(el);
    return;
  }
  if (raw === "") return;
  let stored = "";
  if (el.dataset.wizardField && ui.wizard) {
    readWizardFields();
    if (el.dataset.wizardField === "project-start") stored = ui.wizard.startDate || "";
    else if (el.dataset.wizardField === "stage-date") {
      const stage = ui.wizard.stages[Number(el.dataset.stageIndex)];
      stored = stage ? stage.date || "" : "";
    } else if (el.dataset.wizardField === "milestone-date") {
      const stage = ui.wizard.stages[Number(el.dataset.stageIndex)];
      const milestone = stage && stage.milestones[Number(el.dataset.index)];
      stored = milestone ? milestone.date || "" : "";
    }
  } else if (el.dataset.field) {
    const project = findProject(el.dataset.projectId);
    if (project && el.dataset.field === "project-start") stored = project.startDate || "";
    else if (project && el.dataset.field === "stage-date") {
      const stage = findStage(project, el.dataset.stageId);
      stored = stage ? stage.date || "" : "";
    } else if (project && el.dataset.field === "milestone-date") {
      const milestone = findMilestone(project, el.dataset.milestoneId);
      stored = milestone ? milestone.date || "" : "";
    }
  }
  el.value = stored;
  syncIsoPicker(el);
}

function onInput(event) {
  const el = event.target;
  if (el.classList && el.classList.contains("iso-date-picker")) return;
  if (el.dataset.wizardField) {
    rememberWizardField(el);
    if (el.classList.contains("iso-date-text")) syncIsoPicker(el);
    return;
  }
  const field = el.dataset.field;
  if (field === "project-start" || field === "stage-date" || field === "milestone-date") {
    applyProjectDate(el);
    return;
  }
  if (!field || field.endsWith("-date")) return;
  const project = findProject(el.dataset.projectId);
  if (!project) return;
  if (field === "project-name") project.name = el.value;
  if (field === "stage-name") {
    const stage = findStage(project, el.dataset.stageId);
    if (stage) stage.name = el.value;
  }
  if (field === "stage-description") {
    const stage = findStage(project, el.dataset.stageId);
    if (stage) stage.description = el.value;
  }
  if (field === "milestone-name") {
    const milestone = findMilestone(project, el.dataset.milestoneId);
    if (milestone) milestone.name = el.value;
  }
  persistNow();
  patchProject(project);
}

function onChange(event) {
  const el = event.target;
  if (el.classList && el.classList.contains("iso-date-picker")) {
    const text = el.parentElement && el.parentElement.querySelector(".iso-date-text");
    if (!text) return;
    text.value = el.value;
    text.dispatchEvent(new Event("input", { bubbles: true }));
    text.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  if (el.dataset.wizardField) {
    rememberWizardField(el);
    if (el.dataset.wizardField === "stage-count") commitWizardCount();
    return;
  }
  if (el.dataset.field === "project-start" || el.dataset.field === "stage-date" || el.dataset.field === "milestone-date") {
    applyProjectDate(el);
  }
}

function onClick(event) {
  const card = event.target.closest(".card");
  if (card) {
    if (blockClick) {
      blockClick = false;
      return;
    }
    openProject(card.dataset.projectId);
    return;
  }
  blockClick = false;
  const summary = event.target.closest && event.target.closest(".wizard-desc > summary");
  if (summary && wizardEl && wizardEl.contains(summary)) {
    const details = summary.parentElement;
    const area = details.querySelector("textarea");
    requestAnimationFrame(() => {
      if (details.open && area) area.focus();
    });
  }
  const el = event.target.closest("[data-action]");
  if (!el || !app.contains(el)) return;
  const projectId = el.dataset.projectId || state.openId;
  const action = el.dataset.action;
  if (action === "add-project") addProject();
  else if (action === "add-project-assisted") openWizard();
  else if (action === "wizard-cancel") closeWizard();
  else if (action === "wizard-back") wizardBack();
  else if (action === "wizard-next") wizardNext();
  else if (action === "wizard-finish") wizardCreate();
  else if (action === "wizard-add-milestone") wizardAddMilestone(Number(el.dataset.stageIndex));
  else if (action === "wizard-stage-duration") wizardApplyDuration(Number(el.dataset.stageIndex), "stage", 0, Number(el.dataset.days));
  else if (action === "wizard-milestone-duration") wizardApplyDuration(Number(el.dataset.stageIndex), "milestone", Number(el.dataset.index), Number(el.dataset.days));
  else if (action === "wizard-stage-day1") wizardDay1(Number(el.dataset.stageIndex), "stage", 0);
  else if (action === "wizard-milestone-day1") wizardDay1(Number(el.dataset.stageIndex), "milestone", Number(el.dataset.index));
  else if (action === "open-calendar") openIsoCalendar(el);
  else if (action === "wizard-remove-milestone") wizardRemoveMilestone(Number(el.dataset.stageIndex), Number(el.dataset.index));
  else if (action === "collapse") collapse();
  else if (action === "add-stage") addStage(projectId);
  else if (action === "add-milestone") addMilestone(projectId, el.dataset.stageId);
  else if (action === "delete-stage") deleteStage(projectId, el.dataset.stageId);
  else if (action === "delete-milestone") deleteMilestone(projectId, el.dataset.milestoneId);
  else if (action === "current-stage") setCurrent(projectId, "stage", el.dataset.stageId);
  else if (action === "current-milestone") setCurrent(projectId, "milestone", el.dataset.milestoneId);
  else if (action === "toggle-done") toggleDone(projectId, el.dataset.milestoneId);
  else if (action === "clear-stage-date") {
    const project = findProject(projectId);
    if (project) {
      setStageDate(project, el.dataset.stageId, "");
      const input = panel.querySelector(`[data-focus-id="stage-date-${el.dataset.stageId}"]`);
      if (input) input.value = "";
      el.hidden = true;
    }
  } else if (action === "clear-milestone-date") {
    const project = findProject(projectId);
    if (project) {
      setMilestoneDate(project, el.dataset.milestoneId, "");
      const input = panel.querySelector(`[data-focus-id="milestone-date-${el.dataset.milestoneId}"]`);
      if (input) input.value = "";
      el.hidden = true;
    }
  } else if (action === "ask-delete-project") {
    ui.confirmDelete = true;
    pendingFocus = "confirm-delete-project";
    render();
  } else if (action === "cancel-delete-project") {
    ui.confirmDelete = false;
    pendingFocus = "ask-delete-project";
    render();
  } else if (action === "confirm-delete-project") deleteProject();
  else if (action === "zoom-in") zoomAroundCenter(1.12);
  else if (action === "zoom-out") zoomAroundCenter(1 / 1.12);
  else if (action === "zoom-reset") resetZoom();
}

function onKeyDown(event) {
  if (event.key === "Escape") {
    if (ui.wizard) {
      closeWizard();
      return;
    }
    if (ui.confirmDelete) {
      ui.confirmDelete = false;
      pendingFocus = "ask-delete-project";
      render();
      return;
    }
    if (state.openId) collapse();
    return;
  }
  const card = event.target.closest && event.target.closest(".card");
  if (card && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    openProject(card.dataset.projectId);
    return;
  }
  const inControl = typingTarget(event.target) || (event.target.closest && event.target.closest("button, .card, .wizard"));
  if ((inControl || ui.wizard) && event.code === "Space") return;
  if (event.code === "Space") {
    event.preventDefault();
    spaceDown = true;
    document.body.classList.add("is-space");
    return;
  }
  if (ui.wizard || typingTarget(event.target)) return;
  if (event.key === "+" || event.key === "=") zoomAroundCenter(1.12);
  if (event.key === "-" || event.key === "_") zoomAroundCenter(1 / 1.12);
  if (event.key === "0") resetZoom();
}

function typingTarget(element) {
  return Boolean(element && element.closest && element.closest("input, textarea, select"));
}

function onPointerDown(event) {
  if (!canvas.contains(event.target)) return;
  if (event.button !== 0 && event.button !== 1) return;
  blockClick = false;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size >= 2) {
    gesture = makePinch();
    canvas.classList.add("is-panning");
    return;
  }
  const card = event.button === 0 && !spaceDown ? event.target.closest(".card") : null;
  if (card) {
    const project = findProject(card.dataset.projectId);
    if (!project) return;
    gesture = {
      type: "card",
      pointerId: event.pointerId,
      projectId: project.id,
      startX: event.clientX,
      startY: event.clientY,
      origX: project.x,
      origY: project.y,
      moved: false,
    };
    return;
  }
  gesture = {
    type: "pan",
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    origX: state.camera.x,
    origY: state.camera.y,
  };
  canvas.classList.add("is-panning");
  if (event.button === 1) event.preventDefault();
}

const pointers = new Map();

function onPointerMove(event) {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (!gesture) return;
  if (gesture.type === "pinch") {
    applyPinch();
    return;
  }
  if (gesture.pointerId !== event.pointerId) return;
  const dx = event.clientX - gesture.startX;
  const dy = event.clientY - gesture.startY;
  if (gesture.type === "pan") {
    state.camera.x = gesture.origX + dx;
    state.camera.y = gesture.origY + dy;
    applyCamera();
    return;
  }
  if (!gesture.moved && Math.hypot(dx, dy) < 6) return;
  gesture.moved = true;
  const project = findProject(gesture.projectId);
  if (!project) return;
  project.x = gesture.origX + dx / state.camera.zoom;
  project.y = gesture.origY + dy / state.camera.zoom;
  const el = cardEl(project.id);
  if (!el) return;
  el.classList.add("is-dragging");
  el.style.transform = `translate(${project.x}px, ${project.y}px)`;
}

function onPointerUp(event) {
  pointers.delete(event.pointerId);
  if (!gesture) return;
  if (gesture.type === "pinch") {
    if (pointers.size >= 2) {
      gesture = makePinch();
      return;
    }
    blockClick = true;
    endGesture(true);
    return;
  }
  if (gesture.pointerId !== event.pointerId) return;
  const moved = gesture.type === "pan" || gesture.moved;
  if (moved) blockClick = true;
  endGesture(moved);
}

function endGesture(save) {
  gesture = null;
  canvas.classList.remove("is-panning");
  world.querySelectorAll(".is-dragging").forEach((el) => el.classList.remove("is-dragging"));
  if (save) persistNow();
}

function makePinch() {
  const points = [...pointers.values()];
  const first = points[0];
  const second = points[1];
  const mid = screenPoint((first.x + second.x) / 2, (first.y + second.y) / 2);
  return {
    type: "pinch",
    startDist: Math.max(24, Math.hypot(second.x - first.x, second.y - first.y)),
    startZoom: state.camera.zoom,
    startCamX: state.camera.x,
    startCamY: state.camera.y,
    startMidX: mid.x,
    startMidY: mid.y,
  };
}

function applyPinch() {
  const points = [...pointers.values()];
  if (points.length < 2 || !gesture || gesture.type !== "pinch") return;
  const first = points[0];
  const second = points[1];
  const mid = screenPoint((first.x + second.x) / 2, (first.y + second.y) / 2);
  const dist = Math.max(24, Math.hypot(second.x - first.x, second.y - first.y));
  const next = clamp(gesture.startZoom * (dist / gesture.startDist), MIN_ZOOM, MAX_ZOOM);
  const worldX = (gesture.startMidX - gesture.startCamX) / gesture.startZoom;
  const worldY = (gesture.startMidY - gesture.startCamY) / gesture.startZoom;
  state.camera.zoom = next;
  state.camera.x = mid.x - worldX * next;
  state.camera.y = mid.y - worldY * next;
  applyCamera();
}

function wheelDelta(event, value) {
  if (event.deltaMode === 1) return value * 16;
  if (event.deltaMode === 2) return value * 240;
  return value;
}

function isZoomWheel(event) {
  if (event.ctrlKey || event.metaKey) return true;
  if (event.deltaMode !== 0) return true;
  return Math.abs(event.deltaX) < 1 && Math.abs(event.deltaY) >= 50;
}

function onWheel(event) {
  event.preventDefault();
  const point = screenPoint(event.clientX, event.clientY);
  if (event.shiftKey && !event.ctrlKey && !event.metaKey) {
    state.camera.x -= wheelDelta(event, event.deltaY);
    state.camera.y -= wheelDelta(event, event.deltaX);
    applyCamera();
    persistSoon();
    return;
  }
  if (isZoomWheel(event)) {
    const pixels = wheelDelta(event, event.deltaY);
    // Pinch events are small. A mouse notch is a large delta and needs a gentler step.
    const pinch = (event.ctrlKey || event.metaKey) && Math.abs(pixels) < 50;
    const speed = pinch ? 0.012 : 0.0018;
    zoomAt(point.x, point.y, Math.exp(-pixels * speed));
    persistSoon();
    return;
  }
  state.camera.x -= wheelDelta(event, event.deltaX);
  state.camera.y -= wheelDelta(event, event.deltaY);
  applyCamera();
  persistSoon();
}

function mount() {
  app.innerHTML = `
    <div id="canvas" class="canvas" aria-label="Project canvas">
      <div id="world" class="world"></div>
    </div>
    <header class="bar">
      <h1 class="wordmark">Glance</h1>
      <button type="button" class="button" data-action="add-project">New project</button>
      <button type="button" class="button button-quiet" data-action="add-project-assisted" data-focus-id="add-project-assisted">Add project (assisted)</button>
    </header>
    <div class="zoom" aria-label="Zoom">
      <button type="button" data-action="zoom-out" aria-label="Zoom out">−</button>
      <button type="button" class="zoom-label" data-action="zoom-reset" aria-label="Reset zoom">100%</button>
      <button type="button" data-action="zoom-in" aria-label="Zoom in">+</button>
    </div>
    <div id="empty" class="empty">
      <div class="empty-card">
        <h2>No projects yet</h2>
        <p>Add a project to put it on the canvas. Click a project to open it, and drag it to move it.</p>
        <div class="empty-actions">
          <button type="button" class="button" data-action="add-project">Add a project</button>
          <button type="button" class="button button-quiet" data-action="add-project-assisted">Add project (assisted)</button>
        </div>
      </div>
    </div>
    <aside id="panel" class="panel" hidden aria-label="Project"></aside>
    <div id="wizard" class="wizard" hidden></div>
    <p class="warning" role="alert"${persistOk ? " hidden" : ""}>This browser blocked saving. Your changes will disappear on reload.</p>
  `;
  canvas = document.querySelector("#canvas");
  world = document.querySelector("#world");
  panel = document.querySelector("#panel");
  empty = document.querySelector("#empty");
  zoomLabel = document.querySelector(".zoom-label");
  wizardEl = document.querySelector("#wizard");

  app.addEventListener("click", onClick);
  app.addEventListener("input", onInput);
  app.addEventListener("change", onChange);
  app.addEventListener("focusout", (event) => restoreIsoText(event.target));
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", (event) => {
    if (event.code !== "Space") return;
    spaceDown = false;
    document.body.classList.remove("is-space");
  });
  canvas.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) refreshFromStorage();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persistNow();
    else refreshFromStorage();
  });
  window.addEventListener("pagehide", persistNow);
  window.addEventListener("resize", () => {
    placeChrome();
    applyCamera();
  });
  placeChrome();
  render();
}

mount();
