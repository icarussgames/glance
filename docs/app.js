// Lists live in localStorage under "glance".
// { lists: [{ id, name, notes: [{ id, title, startDate, steps: [{ id, title, done }] }] }], activeListId }

const STORAGE_KEY = "glance";
const STARTER_NOTES = 15;
const STARTER_STEPS = 4;

const app = document.querySelector("#app");

const ui = {
  dialogOpen: false,
  confirmDelete: false,
  focusId: null,
  scrollToTop: false,
};

let persistOk = true;
let state = loadState();

function uid() {
  if (globalThis.crypto && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function loadState() {
  const raw = readStorage();
  if (!raw) return { lists: [], activeListId: null };
  try {
    const next = normalize(JSON.parse(raw));
    const cleaned = JSON.stringify(next);
    if (cleaned !== raw) {
      try {
        localStorage.setItem(STORAGE_KEY, cleaned);
      } catch (err) {
        persistOk = false;
      }
    }
    return next;
  } catch (err) {
    return { lists: [], activeListId: null };
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

function normalize(raw) {
  const lists = [];
  const source = raw && Array.isArray(raw.lists) ? raw.lists : [];
  for (const list of source) {
    if (!list || typeof list.id !== "string") continue;
    const notes = [];
    if (Array.isArray(list.notes)) {
      for (const note of list.notes) {
        if (!note || typeof note.id !== "string") continue;
        const steps = [];
        if (Array.isArray(note.steps)) {
          for (const step of note.steps) {
            if (!step || typeof step.id !== "string") continue;
            steps.push({
              id: step.id,
              title: typeof step.title === "string" ? step.title : "",
              done: step.done === true,
            });
          }
        }
        notes.push({
          id: note.id,
          title: typeof note.title === "string" ? note.title : "",
          startDate: validDate(note.startDate),
          steps,
        });
      }
    }
    const name = typeof list.name === "string" ? list.name : "";
    lists.push({ id: list.id, name, notes });
  }
  let activeListId = raw && typeof raw.activeListId === "string" ? raw.activeListId : null;
  if (!lists.some((list) => list.id === activeListId)) {
    activeListId = lists[0] ? lists[0].id : null;
  }
  return { lists, activeListId };
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function persist() {
  const wasOk = persistOk;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    persistOk = true;
  } catch (err) {
    persistOk = false;
  }
  if (wasOk === persistOk) return;
  const existing = app.querySelector(".warning");
  if (!persistOk && !existing) {
    const message = document.createElement("p");
    message.className = "warning";
    message.setAttribute("role", "alert");
    message.textContent = "This browser blocked saving. Your changes will disappear on reload.";
    app.querySelector(".wrap").append(message);
  } else if (persistOk && existing) {
    existing.remove();
  }
}

function activeList() {
  return state.lists.find((list) => list.id === state.activeListId) || null;
}

function findNote(noteId) {
  const list = activeList();
  if (!list) return null;
  return list.notes.find((note) => note.id === noteId) || null;
}

function findStep(noteId, stepId) {
  const note = findNote(noteId);
  if (!note) return null;
  return note.steps.find((step) => step.id === stepId) || null;
}

function listLabel(list) {
  const name = list.name.trim();
  return name || "Untitled list";
}

function countDone(steps) {
  return steps.reduce((sum, step) => sum + (step.done ? 1 : 0), 0);
}

function listStats(list) {
  let done = 0;
  let steps = 0;
  for (const note of list.notes) {
    steps += note.steps.length;
    done += countDone(note.steps);
  }
  return { notes: list.notes.length, done, steps };
}

function summaryText(stats) {
  const notes = stats.notes === 1 ? "1 note" : `${stats.notes} notes`;
  if (stats.steps === 0) return `${notes} · No steps yet`;
  const steps = stats.steps === 1 ? "1 step" : `${stats.steps} steps`;
  return `${notes} · ${stats.done} of ${steps}`;
}

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function percent(done, total) {
  if (total === 0) return 0;
  return Math.round((done / total) * 1000) / 10;
}

function progressBar(done, total, label) {
  return `<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}" aria-label="${esc(label)}"><span style="width:${percent(done, total)}%"></span></div>`;
}

function starterNotes() {
  const notes = [];
  for (let i = 1; i <= STARTER_NOTES; i += 1) {
    const steps = [];
    for (let s = 0; s < STARTER_STEPS; s += 1) {
      steps.push({ id: uid(), title: "", done: false });
    }
    notes.push({ id: uid(), title: `Note ${i}`, startDate: null, steps });
  }
  return notes;
}

function view() {
  const list = activeList();
  return `
    <a class="skip" href="#notes">Skip to notes</a>
    <div class="wrap">
      <div class="sticky">
        ${header()}
        ${list ? summary(list) : ""}
      </div>
      <main id="notes">
        ${list ? notesView(list) : emptyView()}
      </main>
      ${persistOk ? "" : `<p class="warning" role="alert">This browser blocked saving. Your changes will disappear on reload.</p>`}
    </div>
    ${ui.dialogOpen ? dialog() : ""}
  `;
}

function header() {
  return `
    <header class="mast">
      <h1 class="wordmark">Glance</h1>
      <button type="button" class="button" data-action="open-dialog" data-focus-id="open-dialog-header">New list</button>
    </header>
  `;
}

function emptyView() {
  return `
    <div class="empty">
      <h2>No lists yet</h2>
      <p>Create a list, then add notes and tick off steps. Progress stays on this screen, in this browser.</p>
      <button type="button" class="button" data-action="open-dialog" data-focus-id="open-dialog-empty">Create a list</button>
    </div>
  `;
}

function summary(list) {
  const stats = listStats(list);
  const complete = stats.steps > 0 && stats.done === stats.steps;
  return `
    <section aria-label="Open list">
      ${switcher()}
      <input class="list-name" type="text" data-field="list-name" data-list-id="${esc(list.id)}" data-focus-id="list-name" value="${esc(list.name)}" placeholder="List name" aria-label="List name" maxlength="120" autocomplete="off">
      <p class="summary-meta${complete ? " is-complete" : ""}">${esc(summaryText(stats))}</p>
      ${progressBar(stats.done, stats.steps, "List progress")}
    </section>
  `;
}

function switcher() {
  if (state.lists.length < 2) return "";
  const options = state.lists
    .map((list) => {
      const selected = list.id === state.activeListId ? " selected" : "";
      return `<option value="${esc(list.id)}"${selected}>${esc(listLabel(list))}</option>`;
    })
    .join("");
  return `
    <label class="switcher">
      <span>Open list</span>
      <select id="open-list" data-field="open-list">${options}</select>
    </label>
  `;
}

function notesView(list) {
  const notes = list.notes.length
    ? list.notes.map(noteCard).join("")
    : `<p class="quiet">No notes yet.</p>`;
  return `
    <div class="notes">${notes}</div>
    <div class="list-actions">
      <button type="button" class="button button-quiet" data-action="add-note">Add note</button>
      ${deleteListControl()}
    </div>
  `;
}

function deleteListControl() {
  if (!ui.confirmDelete) {
    return `<button type="button" class="text-button danger" data-action="ask-delete-list" data-focus-id="ask-delete-list">Delete list</button>`;
  }
  return `
    <div class="confirm">
      <p>Delete this list and its notes?</p>
      <button type="button" class="button button-danger" data-action="confirm-delete-list" data-focus-id="confirm-delete-list">Delete list</button>
      <button type="button" class="button button-quiet" data-action="cancel-delete-list">Cancel</button>
    </div>
  `;
}

function noteCard(note) {
  const done = countDone(note.steps);
  const total = note.steps.length;
  const complete = total > 0 && done === total;
  const count = total === 0 ? "0 steps" : `${done}/${total}`;
  const label = note.title.trim() ? `Progress for ${note.title}` : "Note progress";
  const steps = note.steps.map((step) => stepRow(note, step)).join("");
  return `
    <article class="note">
      <div class="note-head">
        <input class="note-title" type="text" data-field="note-title" data-note-id="${esc(note.id)}" data-focus-id="note-title-${esc(note.id)}" value="${esc(note.title)}" placeholder="Note title" aria-label="Note title" maxlength="160" autocomplete="off">
        <p class="count${complete ? " is-complete" : ""}">${esc(count)}</p>
      </div>
      ${progressBar(done, total, label)}
      <div class="date-row">
        <label class="date-label">
          <span>Start date</span>
          <input type="date" data-field="start-date" data-note-id="${esc(note.id)}" data-focus-id="note-date-${esc(note.id)}" value="${note.startDate ? esc(note.startDate) : ""}">
        </label>
        <button type="button" class="text-button" data-action="clear-date" data-note-id="${esc(note.id)}"${note.startDate ? "" : " hidden"}>Clear date</button>
      </div>
      ${steps ? `<div class="steps">${steps}</div>` : ""}
      <div class="note-actions">
        <button type="button" class="text-button" data-action="add-step" data-note-id="${esc(note.id)}" data-focus-id="add-step-${esc(note.id)}">Add step</button>
        <button type="button" class="text-button danger" data-action="delete-note" data-note-id="${esc(note.id)}">Delete note</button>
      </div>
    </article>
  `;
}

function stepRow(note, step) {
  const doneLabel = step.title.trim() ? `Mark “${step.title}” done` : "Mark step done";
  return `
    <div class="step${step.done ? " is-done" : ""}">
      <input type="checkbox" data-field="step-done" data-note-id="${esc(note.id)}" data-step-id="${esc(step.id)}" data-focus-id="step-done-${esc(step.id)}"${step.done ? " checked" : ""} aria-label="${esc(doneLabel)}">
      <input class="step-title" type="text" data-field="step-title" data-note-id="${esc(note.id)}" data-step-id="${esc(step.id)}" data-focus-id="step-title-${esc(step.id)}" value="${esc(step.title)}" placeholder="Step" aria-label="Step title" maxlength="200" autocomplete="off">
      <button type="button" class="icon-button" data-action="delete-step" data-note-id="${esc(note.id)}" data-step-id="${esc(step.id)}" aria-label="Delete step"><span aria-hidden="true">×</span></button>
    </div>
  `;
}

function dialog() {
  return `
    <div class="backdrop">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <form id="new-list-form" autocomplete="off">
          <h2 id="dialog-title">New list</h2>
          <label class="field">
            <span>Name</span>
            <input id="new-list-name" name="name" data-focus-id="new-list-name" required maxlength="120" placeholder="For example, Modules" autocomplete="off">
          </label>
          <fieldset>
            <legend>Start from</legend>
            <label class="choice">
              <input type="radio" name="kind" value="blank" checked>
              <span>
                <span class="choice-title">Blank</span>
                <span class="choice-hint">An empty list.</span>
              </span>
            </label>
            <label class="choice">
              <input type="radio" name="kind" value="starter">
              <span>
                <span class="choice-title">Starter</span>
                <span class="choice-hint">${STARTER_NOTES} notes, ${STARTER_STEPS} empty steps each. You can add and remove notes and steps later.</span>
              </span>
            </label>
          </fieldset>
          <div class="dialog-actions">
            <button type="button" class="button button-quiet" data-action="close-dialog">Cancel</button>
            <button type="submit" class="button">Create list</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function render() {
  const scrollY = window.scrollY;
  const previous = document.activeElement;
  const previousId = previous && previous.dataset ? previous.dataset.focusId : null;
  const selection = readSelection(previous);
  const requestedFocus = ui.focusId;
  const scrollToTop = ui.scrollToTop;
  ui.focusId = null;
  ui.scrollToTop = false;

  app.innerHTML = view();
  document.body.classList.toggle("has-dialog", ui.dialogOpen);
  syncTitle();

  if (scrollToTop) window.scrollTo(0, 0);
  else window.scrollTo(0, scrollY);

  const targetId = requestedFocus || previousId;
  const target = targetId ? focusElement(targetId) : null;
  if (!target) return;
  target.focus();
  if (!requestedFocus && selection && typeof target.setSelectionRange === "function") {
    try {
      target.setSelectionRange(selection.start, selection.end);
    } catch (err) {
      // Date inputs do not support a text selection.
    }
  }
  if (requestedFocus && !target.closest(".dialog")) {
    target.scrollIntoView({ block: "nearest" });
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
  for (const node of nodes) {
    if (node.dataset.focusId === id) return node;
  }
  return null;
}

function syncTitle() {
  const list = activeList();
  if (!list) {
    document.title = "Glance";
    return;
  }
  const stats = listStats(list);
  document.title = stats.steps === 0 ? "Glance" : `Glance · ${stats.done}/${stats.steps}`;
}

function openDialog(returnFocus) {
  ui.dialogOpen = true;
  ui.focusId = "new-list-name";
  ui.returnFocus = returnFocus || "open-dialog-header";
  render();
}

function closeDialog() {
  ui.dialogOpen = false;
  ui.focusId = ui.returnFocus || "open-dialog-header";
  render();
}

function createList(name, kind) {
  const list = {
    id: uid(),
    name,
    notes: kind === "starter" ? starterNotes() : [],
  };
  state.lists.push(list);
  state.activeListId = list.id;
  ui.dialogOpen = false;
  ui.confirmDelete = false;
  ui.scrollToTop = true;
  persist();
  render();
}

function addNote() {
  const list = activeList();
  if (!list) return;
  const note = { id: uid(), title: "", startDate: null, steps: [] };
  list.notes.push(note);
  ui.confirmDelete = false;
  ui.focusId = `note-title-${note.id}`;
  persist();
  render();
}

function addStep(noteId, afterStepId) {
  const note = findNote(noteId);
  if (!note) return;
  const step = { id: uid(), title: "", done: false };
  if (afterStepId) {
    const index = note.steps.findIndex((item) => item.id === afterStepId);
    note.steps.splice(index === -1 ? note.steps.length : index + 1, 0, step);
  } else {
    note.steps.push(step);
  }
  ui.confirmDelete = false;
  ui.focusId = `step-title-${step.id}`;
  persist();
  render();
}

function deleteNote(noteId) {
  const list = activeList();
  if (!list) return;
  const index = list.notes.findIndex((note) => note.id === noteId);
  if (index === -1) return;
  list.notes.splice(index, 1);
  ui.confirmDelete = false;
  persist();
  render();
}

function deleteStep(noteId, stepId) {
  const note = findNote(noteId);
  if (!note) return;
  const index = note.steps.findIndex((step) => step.id === stepId);
  if (index === -1) return;
  note.steps.splice(index, 1);
  const neighbor = note.steps[index] || note.steps[index - 1];
  ui.focusId = neighbor ? `step-title-${neighbor.id}` : `add-step-${noteId}`;
  persist();
  render();
}

function clearDate(noteId) {
  const note = findNote(noteId);
  if (!note) return;
  note.startDate = null;
  ui.focusId = `note-date-${noteId}`;
  persist();
  render();
}

function setDate(noteId, value) {
  const note = findNote(noteId);
  if (!note) return;
  note.startDate = validDate(value);
  persist();
  render();
}

function toggleStep(noteId, stepId, done) {
  const step = findStep(noteId, stepId);
  if (!step) return;
  step.done = done;
  persist();
  render();
}

function deleteActiveList() {
  const current = state.activeListId;
  state.lists = state.lists.filter((list) => list.id !== current);
  state.activeListId = state.lists[0] ? state.lists[0].id : null;
  ui.confirmDelete = false;
  ui.scrollToTop = true;
  persist();
  render();
}

function rememberText(element) {
  const field = element.dataset.field;
  if (field === "list-name") {
    const list = state.lists.find((item) => item.id === element.dataset.listId);
    if (!list || list.name === element.value) return;
    list.name = element.value;
    const option = [...document.querySelectorAll("#open-list option")].find((item) => item.value === list.id);
    if (option) option.textContent = listLabel(list);
    persist();
    return;
  }
  if (field === "note-title") {
    const note = findNote(element.dataset.noteId);
    if (!note || note.title === element.value) return;
    note.title = element.value;
    persist();
    return;
  }
  if (field === "step-title") {
    const step = findStep(element.dataset.noteId, element.dataset.stepId);
    if (!step || step.title === element.value) return;
    step.title = element.value;
    persist();
  }
}

function onClick(event) {
  if (event.target.classList.contains("backdrop")) {
    closeDialog();
    return;
  }
  const el = event.target.closest("[data-action]");
  if (!el || !app.contains(el)) return;
  const { action, noteId, stepId } = el.dataset;
  switch (action) {
    case "open-dialog":
      openDialog(el.dataset.focusId);
      break;
    case "close-dialog":
      closeDialog();
      break;
    case "add-note":
      addNote();
      break;
    case "add-step":
      addStep(noteId);
      break;
    case "delete-note":
      deleteNote(noteId);
      break;
    case "delete-step":
      deleteStep(noteId, stepId);
      break;
    case "clear-date":
      clearDate(noteId);
      break;
    case "ask-delete-list":
      ui.confirmDelete = true;
      ui.focusId = "confirm-delete-list";
      render();
      break;
    case "cancel-delete-list":
      ui.confirmDelete = false;
      ui.focusId = "ask-delete-list";
      render();
      break;
    case "confirm-delete-list":
      deleteActiveList();
      break;
    default:
      break;
  }
}

function onInput(event) {
  rememberText(event.target);
}

function onChange(event) {
  const el = event.target;
  if (el.dataset.field === "step-done") {
    toggleStep(el.dataset.noteId, el.dataset.stepId, el.checked);
    return;
  }
  if (el.dataset.field === "start-date") {
    setDate(el.dataset.noteId, el.value);
    return;
  }
  if (el.dataset.field === "open-list") {
    const nextId = el.value;
    if (!state.lists.some((list) => list.id === nextId)) return;
    state.activeListId = nextId;
    ui.confirmDelete = false;
    ui.scrollToTop = true;
    persist();
    render();
    return;
  }
  rememberText(el);
}

function onKeydown(event) {
  if (event.isComposing) return;
  if (event.key === "Escape" && ui.dialogOpen) {
    event.preventDefault();
    closeDialog();
    return;
  }
  if (event.key === "Enter" && event.target.dataset.field === "step-title") {
    event.preventDefault();
    addStep(event.target.dataset.noteId, event.target.dataset.stepId);
    return;
  }
  if (!ui.dialogOpen || event.key !== "Tab") return;
  const dialog = app.querySelector("[role=dialog]");
  if (!dialog) return;
  const focusable = [...dialog.querySelectorAll("button, input, select, textarea")].filter((el) => !el.disabled);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function onSubmit(event) {
  if (event.target.id !== "new-list-form") return;
  event.preventDefault();
  const data = new FormData(event.target);
  const name = String(data.get("name") || "").trim();
  const input = event.target.querySelector("input[name=name]");
  if (!name) {
    if (input) input.focus();
    return;
  }
  const kind = data.get("kind") === "starter" ? "starter" : "blank";
  createList(name, kind);
}

function refreshFromStorage() {
  const raw = readStorage();
  const current = JSON.stringify(state);
  if (raw === current) return;
  if (raw === null && state.lists.length === 0 && state.activeListId === null) return;
  try {
    const next = normalize(raw ? JSON.parse(raw) : null);
    state = next;
    ui.dialogOpen = false;
    ui.confirmDelete = false;
    render();
  } catch (err) {
    // Keep the current screen if storage cannot be read.
  }
}

app.addEventListener("click", onClick);
app.addEventListener("input", onInput);
app.addEventListener("change", onChange);
app.addEventListener("keydown", onKeydown);
app.addEventListener("submit", onSubmit);
window.addEventListener("storage", (event) => {
  if (event.key !== STORAGE_KEY) return;
  refreshFromStorage();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshFromStorage();
});
window.addEventListener("focus", refreshFromStorage);
render();
