"use strict";

const STORAGE_KEY = "planspiel-kommunikation-state-v1";
const THEME_STORAGE_KEY = "planspiel-kommunikation-theme-v1";
const CURRENT_FILE_DB = "planspiel-kommunikation-file-link-v1";
const CURRENT_FILE_STORE = "file-handles";
const CURRENT_FILE_KEY = "current-json";
const PARTY_WIDTH = 300;
const PARTY_HALF_WIDTH = PARTY_WIDTH / 2;
const PARTY_HEIGHT = 96;
const GRAPH_SPREAD = 1.25;
const MIN_PARTY_TEXT_PIXELS = 10;
const MAX_PARTY_SCALE = 6;
const MESSAGE_LABEL_LIMIT = 50;
const PARTY_SPACING_VERSION_KEY = "planspiel-kommunikation-party-spacing-v2";
const PARTY_SPACING_VERSION = "6";
const CATEGORY = {
  rot: { color: "#8C023F", marker: "arrow-red", label: "Kritisch" },
  gruen: { color: "#468C73", marker: "arrow-green", label: "Positiv" },
  schwarz: { color: "#013154", marker: "arrow-black", label: "Neutral" }
};

/** @typedef {{ id: string, name: string, description: string, x: number | null, y: number | null }} Party */
/** @typedef {{ id: string, from: string, to: string, category: string, timestamp: string, text: string, notes: string }} Message */
/** @typedef {{ parties: Party[], messages: Message[] }} AppState */
const DEFAULT_PARTIES = ["Hausleitung", "Teamer", "Spaziergänger", "Jugendleiter", "Pärchen", "Im Haus geblieben"];
const history = { undo: [], redo: [], limit: 80 };
let currentFileHandle = null;
let currentFileWriteQueue = Promise.resolve();
let state = loadState();
let currentTime = null;
let playbackTimer = null;
let toastTimer = null;
let currentDetailId = null;
const selectedParties = new Set();
let d3Zoom = null;
let partyVisualScale = 1;
let zoomRenderFrame = 0;
let graphInitialized = false;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const svg = d3.select("#graph");
const linkLayer = svg.select(".links-layer");
const nodeLayer = svg.select(".nodes-layer");
const zoomLayer = svg.select(".zoom-layer");
const spreadLayer = svg.select(".spread-layer");
const labelMeasureContext = document.createElement("canvas").getContext("2d");

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultState() {
  const parties = DEFAULT_PARTIES.map((name, index) => ({ id: `party-${index + 1}`, name, description: "", x: null, y: null }));
  return { parties, messages: [] };
}

/** Restore a validated app snapshot from browser storage, or create the first-run parties. */
function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && Array.isArray(saved.parties) && Array.isArray(saved.messages)) return normalizeState(saved);
  } catch (error) {
    console.warn("Gespeicherte Daten konnten nicht gelesen werden.", error);
  }
  return defaultState();
}

/** Validate imported or stored records and discard messages with missing party references. @param {AppState} input @returns {AppState} */
function normalizeState(input) {
  const parties = input.parties.filter((party) => party && party.id && party.name).map((party) => ({
    id: String(party.id), name: String(party.name), description: String(party.description || ""),
    x: party.x !== null && party.x !== undefined && Number.isFinite(Number(party.x)) ? Number(party.x) : null,
    y: party.y !== null && party.y !== undefined && Number.isFinite(Number(party.y)) ? Number(party.y) : null
  }));
  const partyIds = new Set(parties.map((party) => party.id));
  const messages = input.messages.filter((message) => message && partyIds.has(String(message.from)) && partyIds.has(String(message.to))).map((message) => ({
    id: String(message.id || makeId("message")), from: String(message.from), to: String(message.to),
    category: CATEGORY[message.category] ? message.category : "schwarz", timestamp: normalizeTime(message.timestamp),
    text: String(message.text || ""), notes: String(message.notes || "")
  }));
  return { parties, messages };
}

function snapshot() { return JSON.stringify(state); }

function openCurrentFileDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CURRENT_FILE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(CURRENT_FILE_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getSavedCurrentFileHandle() {
  const database = await openCurrentFileDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(CURRENT_FILE_STORE, "readonly");
    const request = transaction.objectStore(CURRENT_FILE_STORE).get(CURRENT_FILE_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
}

async function storeCurrentFileHandle(handle) {
  const database = await openCurrentFileDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(CURRENT_FILE_STORE, "readwrite");
    transaction.objectStore(CURRENT_FILE_STORE).put(handle, CURRENT_FILE_KEY);
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { database.close(); reject(transaction.error); };
  });
}

function updateCurrentFileButton(linked, needsPermission = false) {
  $("#current-file-label").textContent = needsPermission ? "Freigeben" : linked ? "current.json aktiv" : "current.json";
  $("#current-file-button").title = needsPermission ? "Zugriff auf current.json erneut erlauben" : linked ? "current.json wird automatisch gespeichert" : "Autospeicherung mit current.json verbinden";
  $("#current-file-button").setAttribute("aria-label", needsPermission ? "Zugriff auf current.json erlauben" : linked ? "current.json ist als Autospeicher verbunden" : "Autospeicherung mit current.json verbinden");
}

function queueCurrentFileWrite() {
  const handle = currentFileHandle;
  if (!handle) return;
  const contents = `${JSON.stringify({ version: 1, savedAt: new Date().toISOString(), ...state }, null, 2)}\n`;
  currentFileWriteQueue = currentFileWriteQueue.catch(() => {}).then(async () => {
    if (currentFileHandle !== handle) return;
    const writable = await handle.createWritable();
    await writable.write(contents);
    await writable.close();
    if (currentFileHandle === handle) $("#save-status").textContent = "current.json gespeichert";
  }).catch((error) => {
    $("#save-status").textContent = "Dateispeicherung fehlgeschlagen";
    showToast(`current.json konnte nicht gespeichert werden: ${error.message}`);
  });
}

async function restoreCurrentFileHandle(handle) {
  const file = await handle.getFile();
  if (file.size === 0) {
    queueCurrentFileWrite();
    return;
  }
  const parsed = JSON.parse(await file.text());
  if (!Array.isArray(parsed.parties) || !Array.isArray(parsed.messages)) throw new Error("current.json enthält kein gültiges Planspiel.");
  const restored = normalizeState(parsed);
  if (!restored.parties.length) throw new Error("current.json enthält keine Parteien.");
  state = restored;
  graphInitialized = false;
  currentTime = null;
  selectedParties.clear();
  localStorage.setItem(STORAGE_KEY, snapshot());
  renderAll();
  requestAnimationFrame(fitGraph);
  queueCurrentFileWrite();
}

async function restoreLinkedCurrentFile() {
  try {
    currentFileHandle = await getSavedCurrentFileHandle();
    if (!currentFileHandle) return;
    const permission = await currentFileHandle.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") {
      updateCurrentFileButton(true, true);
      $("#save-status").textContent = "current.json benötigt Freigabe";
      return;
    }
    await restoreCurrentFileHandle(currentFileHandle);
  } catch (error) {
    currentFileHandle = null;
    $("#save-status").textContent = "current.json konnte nicht gelesen werden";
    updateCurrentFileButton(false);
    console.warn("current.json konnte nicht wiederhergestellt werden.", error);
  }
}

async function connectCurrentFile() {
  try {
    const savedHandle = currentFileHandle || await getSavedCurrentFileHandle();
    if (savedHandle) {
      const permission = await savedHandle.requestPermission({ mode: "readwrite" });
      if (permission !== "granted") { showToast("Bitte erlaube den Zugriff auf current.json."); return; }
      currentFileHandle = savedHandle;
      await restoreCurrentFileHandle(savedHandle);
      updateCurrentFileButton(true);
      showToast("current.json wurde verbunden.");
      return;
    }
    if (typeof window.showSaveFilePicker !== "function") {
      showToast("Dieser Browser unterstützt keine automatische Dateispeicherung. Nutze den JSON-Export.");
      return;
    }
    const handle = await window.showSaveFilePicker({
      suggestedName: "current.json",
      types: [{ description: "JSON-Datei", accept: { "application/json": [".json"] } }]
    });
    if (handle.name !== "current.json") { showToast("Bitte wähle eine Datei mit dem Namen current.json."); return; }
    const permission = await handle.requestPermission({ mode: "readwrite" });
    if (permission !== "granted") { showToast("Bitte erlaube den Zugriff auf current.json."); return; }
    const existing = await handle.getFile();
    if (existing.size && !confirm("Die bestehende current.json durch den aktuellen Browserstand ersetzen und künftig automatisch sichern?")) return;
    currentFileHandle = handle;
    await storeCurrentFileHandle(handle);
    updateCurrentFileButton(true);
    queueCurrentFileWrite();
    showToast("current.json ist verbunden und wird automatisch aktualisiert.");
  } catch (error) {
    if (error.name !== "AbortError") showToast(`current.json konnte nicht verbunden werden: ${error.message}`);
  }
}

/** Store the current state before a user mutation so Undo can restore it atomically. */
function saveHistory() {
  history.undo.push(snapshot());
  if (history.undo.length > history.limit) history.undo.shift();
  history.redo = [];
  updateHistoryButtons();
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, snapshot());
    $("#save-status").textContent = currentFileHandle ? "Browser und current.json gespeichert" : "Lokal gespeichert";
    queueCurrentFileWrite();
  } catch (error) {
    $("#save-status").textContent = "Speichern fehlgeschlagen";
    showToast("Der Browser konnte den lokalen Speicher nicht aktualisieren.");
  }
}

function restoreSnapshot(source, destination) {
  if (!source.length) return;
  destination.push(snapshot());
  state = normalizeState(JSON.parse(source.pop()));
  stopPlayback();
  persist();
  renderAll();
  updateHistoryButtons();
}

function undo() { restoreSnapshot(history.undo, history.redo); }
function redo() { restoreSnapshot(history.redo, history.undo); }
function updateHistoryButtons() {
  $("#undo-button").disabled = history.undo.length === 0;
  $("#redo-button").disabled = history.redo.length === 0;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2400);
}

function applyTheme(theme, save = true) {
  const isLight = theme === "light";
  document.documentElement.dataset.theme = isLight ? "light" : "dark";
  nodeLayer.selectAll(".node-rect")
    .style("transition", "stroke .16s ease")
    .style("fill", isLight ? "#ffffff" : "#203139", "important")
    .style("stroke", isLight ? "#8fa7ad" : "#39525a", "important");
  $("#theme-toggle").setAttribute("aria-pressed", String(isLight));
  $("#theme-toggle").title = isLight ? "Zu dunklem Design wechseln" : "Zu hellem Design wechseln";
  $("#theme-toggle").setAttribute("aria-label", isLight ? "Dunkles Design aktivieren" : "Helles Design aktivieren");
  $("#theme-icon").textContent = isLight ? "☾" : "☼";
  $("#theme-label").textContent = isLight ? "Dunkel" : "Hell";
  if (save) localStorage.setItem(THEME_STORAGE_KEY, isLight ? "light" : "dark");
}

/** Convert HH:mm or a legacy date-time value to minutes after midnight. */
function timeValue(timestamp) {
  const match = String(timestamp || "").trim().match(/^(?:\d{4}-\d{2}-\d{2}[T ])?(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

function formatTime(value) {
  if (!Number.isFinite(value)) return "Keine Uhrzeit";
  const totalMinutes = Math.floor(value);
  const hours = String(Math.floor(totalMinutes / 60) % 24).padStart(2, "0");
  const minutes = String(totalMinutes % 60).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function normalizeTime(timestamp) {
  const minutes = timeValue(timestamp);
  return minutes === null ? String(timestamp || "") : formatTime(minutes);
}

function localTime(value = new Date()) {
  return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}

function graphSize() {
  const bounds = $("#graph-wrap").getBoundingClientRect();
  return { width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) };
}

function setupZoom() {
  d3Zoom = d3.zoom().scaleExtent([0.3, 2.5]).on("zoom", (event) => {
    zoomLayer.attr("transform", event.transform);
    const nextScale = Math.max(1, Math.min(MAX_PARTY_SCALE, MIN_PARTY_TEXT_PIXELS / (26 * GRAPH_SPREAD * event.transform.k)));
    if (Math.abs(nextScale - partyVisualScale) > .01) {
      partyVisualScale = nextScale;
      if (!zoomRenderFrame) zoomRenderFrame = requestAnimationFrame(() => { zoomRenderFrame = 0; renderGraph(); });
    }
  });
  svg.call(d3Zoom).on("dblclick.zoom", null);
}

function fitGraph() {
  if (!state.parties.length) return;
  const { width, height } = graphSize();
  const bounds = zoomLayer.node().getBBox();
  const margin = 56;
  const extraPartyWidth = PARTY_HALF_WIDTH * (MAX_PARTY_SCALE - 1);
  const extraPartyHeight = PARTY_HEIGHT / 2 * (MAX_PARTY_SCALE - 1);
  const minX = bounds.x - margin - extraPartyWidth;
  const maxX = bounds.x + bounds.width + margin + extraPartyWidth;
  const minY = bounds.y - margin - extraPartyHeight;
  const maxY = bounds.y + bounds.height + margin + extraPartyHeight;
  const scale = Math.min(1.5, (width - margin * 2) / Math.max(1, maxX - minX), (height - margin * 2) / Math.max(1, maxY - minY));
  const x = width / 2 - ((minX + maxX) / 2) * scale;
  const y = height / 2 - ((minY + maxY) / 2) * scale;
  svg.transition().duration(350).call(d3Zoom.transform, d3.zoomIdentity.translate(x, y).scale(scale));
}

/** Position only parties without saved coordinates; existing positions stay pinned during the one-time force pass. */
function weightedLayout() {
  const unpositioned = state.parties.filter((party) => !Number.isFinite(party.x) || !Number.isFinite(party.y));
  if (!unpositioned.length || !state.parties.length) return;
  const { width, height } = graphSize();
  const positions = state.parties.map((party, index) => {
    if (Number.isFinite(party.x) && Number.isFinite(party.y)) return { ...party, fx: party.x, fy: party.y };
    const angle = (index / Math.max(1, state.parties.length)) * Math.PI * 2 - Math.PI / 2;
    const radius = Math.max(120, Math.min(width * .42, height * .42));
    return { ...party, x: width / 2 + Math.cos(angle) * radius, y: height / 2 + Math.sin(angle) * radius };
  });
  const linkCounts = new Map();
  for (const message of state.messages) {
    const [source, target] = [message.from, message.to].sort();
    const key = `${source}\u0000${target}`;
    linkCounts.set(key, (linkCounts.get(key) || 0) + 1);
  }
  const links = [...linkCounts].map(([key, count]) => {
    const [source, target] = key.split("\u0000");
    return { source, target, count };
  });
  const simulation = d3.forceSimulation(positions)
    .force("link", d3.forceLink(links).id((party) => party.id).distance((link) => Math.max(190, 310 - Math.min(120, link.count * 5))).strength(.38))
    .force("charge", d3.forceManyBody().strength(-900))
    .force("collision", d3.forceCollide(110))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .stop();
  simulation.tick(160);
  for (const party of positions) {
    const actual = state.parties.find((item) => item.id === party.id);
    if (actual && (!Number.isFinite(actual.x) || !Number.isFinite(actual.y))) {
      actual.x = Math.min(width - 85, Math.max(85, party.x));
      actual.y = Math.min(height - 45, Math.max(45, party.y));
    }
  }
}

function messageStats() {
  const sent = new Map(state.parties.map((party) => [party.id, 0]));
  const received = new Map(state.parties.map((party) => [party.id, 0]));
  for (const message of state.messages) {
    sent.set(message.from, (sent.get(message.from) || 0) + 1);
    received.set(message.to, (received.get(message.to) || 0) + 1);
  }
  return { sent, received };
}

function buildMessageLanes(messages) {
  const grouped = new Map();
  for (const message of messages) {
    const key = [message.from, message.to].sort().join("\u0000");
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(message);
  }
  const orderedGroups = [...grouped.entries()].sort((first, second) => second[1].length - first[1].length || first[0].localeCompare(second[0]));
  const lanes = new Map();
  let nextRow = 0;
  for (const [, group] of orderedGroups) {
    group.sort((first, second) => (timeValue(first.timestamp) ?? 0) - (timeValue(second.timestamp) ?? 0) || first.id.localeCompare(second.id));
    group.forEach((message, index) => lanes.set(message.id, { index, count: group.length, row: nextRow + index }));
    nextRow += group.length + 2;
  }
  const totalRows = Math.max(1, nextRow - Math.min(2, orderedGroups.length * 2));
  lanes.forEach((lane) => { lane.totalRows = totalRows; });
  return lanes;
}

function messageLabelText(text) {
  return text.length > MESSAGE_LABEL_LIMIT ? `${text.slice(0, MESSAGE_LABEL_LIMIT - 1).trimEnd()}…` : text;
}

function messageLabelWidth(text) {
  const visibleText = messageLabelText(text);
  if (!labelMeasureContext) return Math.ceil(visibleText.length * 8);
  labelMeasureContext.font = '700 24px "Segoe UI", Arial, sans-serif';
  return Math.ceil(labelMeasureContext.measureText(visibleText).width);
}

function ensurePartySpacing(compact = false, parties = state.parties, messages = state.messages) {
  if (parties.length < 2) return false;
  const pairDistances = new Map();
  const pairTraffic = new Map();
  for (const message of messages) {
    if (message.from === message.to) continue;
    const key = [message.from, message.to].sort().join("\u0000");
    const required = messageLabelWidth(message.text) + PARTY_WIDTH * MAX_PARTY_SCALE;
    pairDistances.set(key, Math.max(pairDistances.get(key) || 0, required));
    pairTraffic.set(key, (pairTraffic.get(key) || 0) + 1);
  }
  const ordered = compact ? [] : [...parties].sort((first, second) => first.x - second.x || first.id.localeCompare(second.id));
  if (compact) {
    const degree = (partyId) => [...pairTraffic].reduce((sum, [key, count]) => sum + (key.split("\u0000").includes(partyId) ? count : 0), 0);
    if (parties.length <= 8) {
      let bestCost = Infinity;
      let bestOrder = [];
      const scoreOrder = (partyOrder) => {
        const xById = new Map();
        partyOrder.forEach((party, index) => {
          let x = index ? xById.get(partyOrder[index - 1].id) + PARTY_WIDTH * MAX_PARTY_SCALE + 48 : 0;
          for (let previous = 0; previous < index; previous++) {
            const key = [partyOrder[previous].id, party.id].sort().join("\u0000");
            x = Math.max(x, xById.get(partyOrder[previous].id) + (pairDistances.get(key) || 0));
          }
          xById.set(party.id, x);
        });
        let total = 0;
        for (const [key, count] of pairTraffic) {
          const [sourceId, targetId] = key.split("\u0000");
          total += count * Math.abs(xById.get(sourceId) - xById.get(targetId));
        }
        return total;
      };
      const visitOrders = (prefix, remaining) => {
        if (!remaining.length) {
          const cost = scoreOrder(prefix);
          if (cost < bestCost) { bestCost = cost; bestOrder = [...prefix]; }
          return;
        }
        for (let index = 0; index < remaining.length; index++) {
          visitOrders([...prefix, remaining[index]], [...remaining.slice(0, index), ...remaining.slice(index + 1)]);
        }
      };
      visitOrders([], [...parties].sort((first, second) => first.id.localeCompare(second.id)));
      ordered.push(...bestOrder);
    } else {
      const remaining = new Set(parties.map((party) => party.id));
      const first = [...parties].sort((left, right) => degree(right.id) - degree(left.id) || left.id.localeCompare(right.id))[0];
      ordered.push(first);
      remaining.delete(first.id);
      while (remaining.size) {
        const candidates = parties.filter((party) => remaining.has(party.id));
        candidates.sort((left, right) => {
          const score = (party) => ordered.reduce((total, previous, index) => {
            const key = [party.id, previous.id].sort().join("\u0000");
            return total + (pairTraffic.get(key) || 0) / (ordered.length - index);
          }, 0);
          return score(right) - score(left) || degree(right.id) - degree(left.id) || left.id.localeCompare(right.id);
        });
        ordered.push(candidates[0]);
        remaining.delete(candidates[0].id);
      }
    }
  }
  const arranged = [];
  for (let index = 0; index < ordered.length; index++) {
    const minimumX = index ? arranged[index - 1].x + PARTY_WIDTH * MAX_PARTY_SCALE + 48 : ordered[index].x;
    let x = compact ? minimumX : Math.max(ordered[index].x, minimumX);
    for (let previous = 0; previous < index; previous++) {
      const key = [ordered[previous].id, ordered[index].id].sort().join("\u0000");
      const required = pairDistances.get(key);
      if (required) x = Math.max(x, arranged[previous].x + required);
    }
    arranged.push({ party: ordered[index], x });
  }
  const oldCenter = parties.reduce((sum, party) => sum + party.x, 0) / parties.length;
  const newCenter = (arranged[0].x + arranged.at(-1).x) / 2;
  const translation = oldCenter - newCenter;
  let changed = false;
  for (const item of arranged) {
    const x = item.x + translation;
    if (Math.abs(item.party.x - x) > .5) changed = true;
    item.party.x = x;
  }
  if (changed && parties.some((party) => state.parties.includes(party))) persist();
  return changed;
}

/** Build a right-angle route with chronological lanes for parallel and reverse messages. @param {Message} message */
function routeFor(message, messageLanes, partyById, laneCenterY, laneGap) {
  const source = partyById.get(message.from);
  const target = partyById.get(message.to);
  if (!source || !target) return { path: "", labelPath: "" };
  const dx = target.x - source.x;
  const lane = messageLanes.get(message.id) || { index: 0, count: 1, row: 0, totalRows: 1 };
  const laneY = laneCenterY + (lane.row - (lane.totalRows - 1) / 2) * laneGap;
  const labelWidth = messageLabelWidth(message.text);
  if (message.from === message.to) {
    const offset = 92 + lane.index * 24;
    const nodeHalfWidth = PARTY_HALF_WIDTH * partyVisualScale;
    const rightEdge = source.x + nodeHalfWidth;
    const leftEdge = source.x - nodeHalfWidth;
    const loopRight = source.x + Math.max(offset, labelWidth - nodeHalfWidth);
    return {
      path: `M${rightEdge},${source.y} L${loopRight},${source.y} L${loopRight},${laneY} L${leftEdge},${laneY} L${leftEdge},${source.y}`,
      labelPath: `M${leftEdge},${laneY} L${loopRight},${laneY}`
    };
  }
  const direction = Math.sign(dx) || 1;
  const nodeHalfWidth = PARTY_HALF_WIDTH * partyVisualScale;
  const startX = source.x + direction * nodeHalfWidth;
  const endX = target.x - direction * nodeHalfWidth;
  const path = `M${startX},${source.y} L${startX},${laneY} L${endX},${laneY} L${endX},${target.y}`;
  const labelPath = `M${Math.min(startX, endX)},${laneY} L${Math.max(startX, endX)},${laneY}`;
  return { path, labelPath };
}

function getFilters() {
  const categories = new Set($$(".filter-row input:checked").map((input) => input.value));
  const query = $("#search-input").value.trim().toLocaleLowerCase("de");
  const from = $("#date-from").value ? timeValue($("#date-from").value) : -Infinity;
  const to = $("#date-to").value ? timeValue($("#date-to").value) : Infinity;
  return { categories, query, from, to };
}

/** Evaluate category, party, search, date, and simulation-time visibility without changing graph positions. */
function visibleStatus(message, filters) {
  const timestamp = timeValue(message.timestamp);
  const search = `${message.text} ${message.notes} ${partyName(message.from)} ${partyName(message.to)}`.toLocaleLowerCase("de");
  const singlePartyId = selectedParties.size === 1 ? selectedParties.values().next().value : null;
  const partyMatches = !selectedParties.size || (singlePartyId !== null
    ? message.from === singlePartyId || message.to === singlePartyId
    : selectedParties.has(message.from) && selectedParties.has(message.to));
  const inRange = timestamp !== null && (filters.from > filters.to
    ? timestamp >= filters.from || timestamp <= filters.to
    : timestamp >= filters.from && timestamp <= filters.to);
  const matches = filters.categories.has(message.category) && partyMatches
    && (!filters.query || search.includes(filters.query)) && inRange;
  const inTime = currentTime === null || timestamp <= currentTime;
  return { matches, inTime, searchMatch: Boolean(filters.query && search.includes(filters.query)) };
}

function getPartyFilteredView() {
  if (!selectedParties.size) return { parties: state.parties, messages: state.messages };
  const isSingleParty = selectedParties.size === 1;
  const messages = state.messages.filter((message) => isSingleParty
    ? message.from === [...selectedParties][0] || message.to === [...selectedParties][0]
    : selectedParties.has(message.from) && selectedParties.has(message.to));
  const visiblePartyIds = new Set(selectedParties);
  if (isSingleParty) messages.forEach((message) => { visiblePartyIds.add(message.from); visiblePartyIds.add(message.to); });
  return {
    parties: state.parties.filter((party) => visiblePartyIds.has(party.id)),
    messages
  };
}

function partyName(id) { return state.parties.find((party) => party.id === id)?.name || "Unbekannt"; }

function renderGraph() {
  if (!graphInitialized) {
    weightedLayout();
    const compactLegacyLayout = state.messages.length > 0 && localStorage.getItem(PARTY_SPACING_VERSION_KEY) !== PARTY_SPACING_VERSION;
    ensurePartySpacing(compactLegacyLayout);
    if (state.messages.length > 0) localStorage.setItem(PARTY_SPACING_VERSION_KEY, PARTY_SPACING_VERSION);
    graphInitialized = true;
  }
  const { width, height } = graphSize();
  $("#graph-wrap").classList.toggle("dense", state.messages.length > 30);
  const spread = GRAPH_SPREAD;
  spreadLayer.attr("transform", `translate(${width / 2 * (1 - spread)},${height / 2 * (1 - spread)}) scale(${spread})`);
  svg.attr("viewBox", `0 0 ${width} ${height}`);
  const { sent, received } = messageStats();
  const filters = getFilters();
  const partyView = getPartyFilteredView();
  const messageLanes = buildMessageLanes(partyView.messages);
  const laneGap = partyView.messages.length > 30 ? 34 : 42;
  const partyById = new Map(partyView.parties.map((party) => [party.id, party]));
  const items = partyView.messages.map((message) => ({ ...message, route: routeFor(message, messageLanes, partyById, height / 2, laneGap), status: visibleStatus(message, filters) }));
  const links = linkLayer.selectAll("g.link-group").data(items, (message) => message.id).join(
    (enter) => {
      const group = enter.append("g").attr("class", "link-group").attr("tabindex", 0).attr("role", "button").attr("aria-label", (message) => `${partyName(message.from)} an ${partyName(message.to)}: ${message.text}`);
      group.append("path").attr("class", "link-path").attr("fill", "none");
      group.append("path").attr("class", "label-path").attr("fill", "none").attr("stroke", "none");
      group.append("text").attr("class", "link-label").append("textPath").attr("startOffset", "50%").attr("text-anchor", "middle");
      group.append("title");
      group.on("click", (event, message) => { event.stopPropagation(); openDetails(message.id); })
        .on("keydown", (event, message) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openDetails(message.id); } });
      return group;
    },
    (update) => update,
    (exit) => exit.remove()
  );
  links.attr("class", (message) => `link-group${message.status.matches ? "" : " filtered"}${message.status.inTime ? "" : " future"}`)
    .select(".link-path").attr("id", (message) => `path-${message.id}`).attr("d", (message) => message.route.path)
    .attr("stroke", (message) => CATEGORY[message.category].color).attr("marker-end", (message) => `url(#${CATEGORY[message.category].marker})`)
    .attr("class", (message) => `link-path${message.status.searchMatch ? " search-match" : ""}${message.status.inTime ? "" : " future"}`);
  links.select(".label-path").attr("id", (message) => `label-path-${message.id}`).attr("d", (message) => message.route.labelPath);
  links.select("textPath").attr("href", (message) => `#label-path-${message.id}`).text((message) => messageLabelText(message.text));
  links.each(function () {
    const labelPath = this.querySelector(".label-path");
    const textPath = this.querySelector("textPath");
    const availableLength = Math.max(1, labelPath.getTotalLength());
    if (textPath.getComputedTextLength() > availableLength) {
      textPath.setAttribute("textLength", availableLength);
      textPath.setAttribute("lengthAdjust", "spacingAndGlyphs");
    } else {
      textPath.removeAttribute("textLength");
      textPath.removeAttribute("lengthAdjust");
    }
  });
  links.select("title").text((message) => `${partyName(message.from)} → ${partyName(message.to)}\n${message.timestamp}\n${message.text}`);

  const nodes = nodeLayer.selectAll("g.node-card").data(partyView.parties, (party) => party.id).join(
    (enter) => {
      const group = enter.append("g").attr("class", "node-card").attr("tabindex", 0).attr("role", "button");
      group.append("rect").attr("class", "node-selection-ring").attr("x", -PARTY_HALF_WIDTH - 7).attr("y", -PARTY_HEIGHT / 2 - 7).attr("width", PARTY_WIDTH + 14).attr("height", PARTY_HEIGHT + 14).attr("rx", 14);
      group.append("rect").attr("class", "node-rect").attr("x", -PARTY_HALF_WIDTH).attr("y", -PARTY_HEIGHT / 2).attr("width", PARTY_WIDTH).attr("height", PARTY_HEIGHT).attr("rx", 10)
        .style("transition", "stroke .16s ease")
        .style("fill", document.documentElement.dataset.theme === "light" ? "#ffffff" : "#203139", "important")
        .style("stroke", document.documentElement.dataset.theme === "light" ? "#8fa7ad" : "#39525a", "important");
      group.append("text").attr("class", "node-name").attr("text-anchor", "middle").attr("y", -8);
      group.append("text").attr("class", "node-meta").attr("text-anchor", "middle").attr("y", 32);
      group.append("title");
      group.on("click", (event, party) => { if (event.defaultPrevented) return; openPartyDialog(party.id); })
        .on("mouseenter", (event) => d3.select(event.currentTarget).select(".node-rect")
          .style("fill", document.documentElement.dataset.theme === "light" ? "#e8f4f6" : "#263d45", "important")
          .style("stroke", document.documentElement.dataset.theme === "light" ? "#008ba4" : "#00a9c5", "important"))
        .on("mouseleave", (event) => d3.select(event.currentTarget).select(".node-rect")
          .style("fill", document.documentElement.dataset.theme === "light" ? "#ffffff" : "#203139", "important")
          .style("stroke", document.documentElement.dataset.theme === "light" ? "#8fa7ad" : "#39525a", "important"))
        .on("keydown", (event, party) => { if (event.key === "Enter") openPartyDialog(party.id); });
      return group;
    },
    (update) => update,
    (exit) => exit.remove()
  );
  nodes.attr("transform", (party) => `translate(${party.x},${party.y}) scale(${partyVisualScale})`)
    .classed("party-focused", (party) => selectedParties.has(party.id))
    .attr("aria-label", (party) => `${party.name}, ${sent.get(party.id) || 0} gesendet, ${received.get(party.id) || 0} empfangen`);
  nodes.select(".node-name").text((party) => party.name.length > 21 ? `${party.name.slice(0, 19)}…` : party.name);
  nodes.select(".node-meta").text((party) => `${sent.get(party.id) || 0} gesendet · ${received.get(party.id) || 0} empfangen`);
  nodes.select("title").text((party) => party.description ? `${party.name}\n${party.description}` : party.name);
  nodes.call(d3.drag()
    .on("start", (event) => { if (!event.active) saveHistory(); event.sourceEvent.stopPropagation(); })
    .on("drag", (event, party) => { party.x = event.x; party.y = event.y; renderGraph(); })
    .on("end", () => { persist(); renderGraph(); renderPartyList(); }));
  $("#graph-empty").hidden = state.messages.length > 0;
}

function renderPartyList() {
  const { sent, received } = messageStats();
  const rows = d3.select("#party-list").selectAll("label.party-row").data(state.parties, (party) => party.id).join("label").attr("class", (party) => `party-row${selectedParties.has(party.id) ? " selected" : ""}`);
  rows.html("");
  rows.append("input").attr("type", "checkbox").attr("aria-label", (party) => `Kommunikation mit ${party.name} einbeziehen`).property("checked", (party) => selectedParties.has(party.id))
    .on("change", (event, party) => {
      if (event.currentTarget.checked) selectedParties.add(party.id);
      else selectedParties.delete(party.id);
      const partyView = getPartyFilteredView();
      ensurePartySpacing(true, partyView.parties, partyView.messages);
      renderAll();
      requestAnimationFrame(fitGraph);
    });
  rows.append("span").attr("class", "party-avatar").text((party) => party.name.trim().slice(0, 1).toLocaleUpperCase("de"));
  rows.append("span").text((party) => party.name);
  rows.append("span").attr("class", "party-row-count").text((party) => (sent.get(party.id) || 0) + (received.get(party.id) || 0));
  $("#party-count").textContent = state.parties.length;
}

function renderCounts() {
  for (const category of Object.keys(CATEGORY)) {
    $(`#count-${category}`).textContent = state.messages.filter((message) => message.category === category).length;
  }
  $("#message-count").textContent = `${state.messages.length} ${state.messages.length === 1 ? "Nachricht" : "Nachrichten"}`;
}

function updateTimeline() {
  const times = state.messages.map((message) => timeValue(message.timestamp)).filter(Number.isFinite).sort((a, b) => a - b);
  const slider = $("#time-slider");
  if (!times.length) {
    slider.min = "0"; slider.max = "1439"; slider.value = "1439"; slider.disabled = true;
    currentTime = null;
    $("#timeline-date").textContent = "Keine Uhrzeit";
    $("#slider-ticks").replaceChildren();
    return;
  }
  slider.disabled = false;
  const min = times[0]; const max = times.at(-1);
  slider.min = String(min); slider.max = String(max === min ? min + 1 : max);
  if (currentTime === null) currentTime = max;
  currentTime = Math.max(min, Math.min(max, currentTime));
  slider.value = String(currentTime);
  $("#timeline-date").textContent = formatTime(currentTime);
  const ticks = [...new Set(times)].slice(0, 12);
  $("#slider-ticks").replaceChildren(...ticks.map((time) => {
    const tick = document.createElement("i");
    tick.style.left = `${max === min ? 100 : ((time - min) / (max - min)) * 100}%`;
    return tick;
  }));
}

function renderStats() {
  const visible = state.messages;
  $("#stats-total").textContent = `${visible.length} Nachrichten`;
  const activity = new Map(state.parties.map((party) => [party.id, 0]));
  visible.forEach((message) => {
    activity.set(message.from, activity.get(message.from) + 1);
    activity.set(message.to, activity.get(message.to) + 1);
  });
  const top = [...activity.entries()].sort((a, b) => b[1] - a[1])[0];
  $("#top-party").textContent = top?.[1] ? partyName(top[0]) : "–";
  $("#top-party-count").textContent = `${top?.[1] || 0} Beteiligungen`;
  const maxCategory = Math.max(1, ...Object.keys(CATEGORY).map((category) => visible.filter((message) => message.category === category).length));
  $("#category-chart").innerHTML = Object.entries(CATEGORY).map(([key, category]) => {
    const count = visible.filter((message) => message.category === key).length;
    return `<div class="bar-row"><span>${category.label}</span><div class="bar-track"><div class="bar-fill" style="width:${count / maxCategory * 100}%;background:${category.color}"></div></div><span>${count}</span></div>`;
  }).join("");
  const maxParty = Math.max(1, ...activity.values());
  $("#party-chart").innerHTML = state.parties.slice(0, 12).map((party) => `<div class="party-bar-wrap" title="${escapeHtml(party.name)}: ${activity.get(party.id)}"><div class="party-bar" style="height:${Math.max(2, activity.get(party.id) / maxParty * 58)}px"></div><span>${escapeHtml(party.name)}</span></div>`).join("");
  const timeRoot = d3.select("#time-chart").html("").append("svg");
  const times = visible.map((message) => timeValue(message.timestamp)).filter(Number.isFinite);
  if (times.length) {
    const width = 250; const height = 80; const margin = { top: 5, right: 5, bottom: 4, left: 5 };
    const domain = d3.extent(times); const bins = d3.bin().domain(domain[0] === domain[1] ? [domain[0], domain[0] + 1] : domain).thresholds(Math.min(12, Math.max(3, times.length)))(times);
    const timeScale = d3.scaleLinear().domain(domain[0] === domain[1] ? [domain[0], domain[0] + 1] : domain).range([margin.left, width - margin.right]);
    const activityScale = d3.scaleLinear().domain([0, d3.max(bins, (bin) => bin.length) || 1]).range([height - margin.bottom, margin.top]);
    const area = d3.area().x((bin) => timeScale((bin.x0 + bin.x1) / 2)).y0(height - margin.bottom).y1((bin) => activityScale(bin.length)).curve(d3.curveMonotoneX);
    const line = d3.line().x((bin) => timeScale((bin.x0 + bin.x1) / 2)).y((bin) => activityScale(bin.length)).curve(d3.curveMonotoneX);
    timeRoot.attr("viewBox", `0 0 ${width} ${height}`).append("path").datum(bins).attr("class", "time-area").attr("d", area);
    timeRoot.append("path").datum(bins).attr("class", "time-line").attr("d", line);
  }
}

function renderMessagesList() {
  const filters = getFilters();
  const messages = state.messages.filter((message) => visibleStatus(message, filters).matches)
    .sort((first, second) => timeValue(first.timestamp) - timeValue(second.timestamp));
  const rows = d3.select("#messages-list").selectAll("button.message-row").data(messages, (message) => message.id).join("button")
    .attr("type", "button").attr("class", (message) => `message-row category-${message.category}`)
    .attr("aria-label", (message) => `${message.timestamp}, ${partyName(message.from)} an ${partyName(message.to)}: ${message.text}`)
    .on("click", (event, message) => openDetails(message.id));
  rows.html("");
  rows.append("span").attr("class", "message-row-time").text((message) => message.timestamp);
  rows.append("span").attr("class", "message-row-parties").text((message) => `${partyName(message.from)} → ${partyName(message.to)}`);
  rows.append("span").attr("class", "message-row-category").text((message) => CATEGORY[message.category].label);
  rows.append("span").attr("class", "message-row-text").text((message) => message.text);
  $("#messages-panel-count").textContent = `${messages.length} ${messages.length === 1 ? "Nachricht" : "Nachrichten"}`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);
}

function renderAll() {
  renderGraph();
  renderPartyList();
  renderCounts();
  updateTimeline();
  renderStats();
  renderMessagesList();
  updateDetailPanel();
}

function renderFilteredViews() {
  renderGraph();
  renderMessagesList();
}

function populatePartyOptions() {
  const options = state.parties.map((party) => `<option value="${escapeHtml(party.id)}">${escapeHtml(party.name)}</option>`).join("");
  $("#message-from").innerHTML = options;
  $("#message-to").innerHTML = options;
}

function openMessageDialog(message = null) {
  if (!state.parties.length) { showToast("Lege zuerst mindestens eine Partei an."); return; }
  populatePartyOptions();
  $("#message-dialog-title").textContent = message ? "Nachricht bearbeiten" : "Neue Nachricht";
  $("#message-dialog-kicker").textContent = message ? "BEARBEITEN" : "NACHRICHT ERSTELLEN";
  $("#message-id").value = message?.id || "";
  $("#message-from").value = message?.from || state.parties[0].id;
  $("#message-to").value = message?.to || state.parties[Math.min(1, state.parties.length - 1)].id;
  $("#message-category").value = message?.category || "schwarz";
  $("#message-timestamp").value = message ? normalizeTime(message.timestamp) : localTime();
  $("#message-text").value = message?.text || "";
  $("#message-notes").value = message?.notes || "";
  $("#delete-message-button").hidden = !message;
  $("#message-dialog").showModal();
  $("#message-text").focus();
}

function openPartyDialog(id = null) {
  const party = state.parties.find((item) => item.id === id);
  $("#party-dialog-title").textContent = party ? "Partei bearbeiten" : "Partei hinzufügen";
  $("#party-id").value = party?.id || "";
  $("#party-name").value = party?.name || "";
  $("#party-description").value = party?.description || "";
  $("#delete-party-button").hidden = !party;
  $("#party-dialog").showModal();
  $("#party-name").focus();
}

function openDetails(id) {
  currentDetailId = id;
  $("#detail-panel").classList.add("open");
  $("#detail-panel").setAttribute("aria-hidden", "false");
  updateDetailPanel();
}

function closeDetails() {
  currentDetailId = null;
  $("#detail-panel").classList.remove("open");
  $("#detail-panel").setAttribute("aria-hidden", "true");
}

function updateDetailPanel() {
  const message = state.messages.find((item) => item.id === currentDetailId);
  if (!message) { if (currentDetailId) closeDetails(); return; }
  const panel = $("#detail-content");
  panel.innerHTML = `<div class="detail-route"><strong>${escapeHtml(partyName(message.from))}</strong> <span>sendet an</span> <strong>${escapeHtml(partyName(message.to))}</strong></div>
    <div class="detail-content-fields">
      <label class="detail-field">Sender<select id="detail-from">${partyOptions(message.from)}</select></label>
      <label class="detail-field">Empfänger<select id="detail-to">${partyOptions(message.to)}</select></label>
      <label class="detail-field">Kategorie<select id="detail-category"><option value="rot" ${message.category === "rot" ? "selected" : ""}>Rot · Kritisch</option><option value="gruen" ${message.category === "gruen" ? "selected" : ""}>Grün · Positiv</option><option value="schwarz" ${message.category === "schwarz" ? "selected" : ""}>Schwarz · Neutral</option></select></label>
      <label class="detail-field">Uhrzeit<input id="detail-timestamp" class="time-entry" type="text" inputmode="numeric" autocomplete="off" maxlength="5" pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]" placeholder="HH:mm" title="Uhrzeit im 24-Stunden-Format HH:mm" value="${escapeHtml(normalizeTime(message.timestamp))}"></label>
      <label class="detail-field">Nachricht<textarea id="detail-text" rows="4">${escapeHtml(message.text)}</textarea></label>
      <label class="detail-field">Notizen<textarea id="detail-notes" rows="3">${escapeHtml(message.notes)}</textarea></label>
    </div><div class="detail-actions"><button class="button button-primary" id="save-detail">Änderungen speichern</button><button class="button button-danger-text" id="remove-detail">Löschen</button></div>`;
  $("#save-detail").onclick = () => {
    saveHistory();
    Object.assign(message, { from: $("#detail-from").value, to: $("#detail-to").value, category: $("#detail-category").value, timestamp: $("#detail-timestamp").value, text: $("#detail-text").value.trim(), notes: $("#detail-notes").value.trim() });
    currentTime = null; graphInitialized = false; persist(); renderAll(); showToast("Nachricht aktualisiert.");
  };
  $("#remove-detail").onclick = () => deleteMessage(message.id);
}

function partyOptions(selected) {
  return state.parties.map((party) => `<option value="${escapeHtml(party.id)}" ${party.id === selected ? "selected" : ""}>${escapeHtml(party.name)}</option>`).join("");
}

function deleteMessage(id) {
  const message = state.messages.find((item) => item.id === id);
  if (!message || !confirm("Diese Nachricht wirklich löschen?")) return;
  saveHistory();
  state.messages = state.messages.filter((item) => item.id !== id);
  if ($("#message-dialog").open) $("#message-dialog").close();
  closeDetails(); currentTime = null; persist(); renderAll(); showToast("Nachricht gelöscht.");
}

function deleteParty(id) {
  const party = state.parties.find((item) => item.id === id);
  if (!party) return;
  const relatedCount = state.messages.filter((message) => message.from === id || message.to === id).length;
  const confirmation = relatedCount ? `„${party.name}“ und ${relatedCount} verknüpfte ${relatedCount === 1 ? "Nachricht" : "Nachrichten"} löschen?` : `„${party.name}“ wirklich löschen?`;
  if (!confirm(confirmation)) return;
  saveHistory();
  state.parties = state.parties.filter((item) => item.id !== id);
  state.messages = state.messages.filter((message) => message.from !== id && message.to !== id);
  selectedParties.delete(id); graphInitialized = true;
  $("#party-dialog").close(); persist(); renderAll(); showToast("Partei und verknüpfte Nachrichten gelöscht.");
}

function stopPlayback() {
  if (playbackTimer) clearInterval(playbackTimer);
  playbackTimer = null;
  $("#play-button").textContent = "▶";
  $("#play-button").title = "Abspielen";
  $("#play-button").setAttribute("aria-label", "Abspielen");
}

/** Advance through the complete scenario range at the selected relative speed. */
function startPlayback() {
  const slider = $("#time-slider");
  if (slider.disabled) return;
  if (Number(slider.value) >= Number(slider.max)) currentTime = Number(slider.min);
  stopPlayback();
  const start = Number(slider.min);
  const end = Number(slider.max);
  const minutesPerTick = Math.max(1, (end - start) / 600) * Number($("#speed-select").value);
  $("#play-button").textContent = "Ⅱ";
  $("#play-button").title = "Pause";
  $("#play-button").setAttribute("aria-label", "Pause");
  playbackTimer = setInterval(() => {
    const next = Number(currentTime) + minutesPerTick;
    if (next >= end) { currentTime = end; stopPlayback(); }
    else currentTime = next;
    slider.value = String(currentTime);
    $("#timeline-date").textContent = formatTime(currentTime);
    renderGraph();
  }, 100);
}

function exportJson() {
  const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), ...state }, null, 2)], { type: "application/json" });
  downloadBlob(blob, `planspiel-kommunikation-${new Date().toISOString().slice(0, 10)}.json`);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Replace the active state with a validated JSON file while keeping the operation undoable. @param {File} file */
async function importJson(file) {
  try {
    const parsed = JSON.parse(await file.text());
    if (!Array.isArray(parsed.parties) || !Array.isArray(parsed.messages)) throw new Error("Die Datei benötigt parties und messages.");
    const imported = normalizeState(parsed);
    if (!imported.parties.length) throw new Error("Die Datei enthält keine gültigen Parteien.");
    if (parsed.messages.length !== imported.messages.length) showToast("Ungültige Nachrichten ohne bekannte Parteien wurden übersprungen.");
    if (!confirm(`${imported.parties.length} Parteien und ${imported.messages.length} Nachrichten laden? Der aktuelle Stand wird ersetzt.`)) return;
    saveHistory(); state = imported; graphInitialized = false; currentTime = null; selectedParties.clear();
    persist(); renderAll(); fitGraph(); showToast("Daten erfolgreich geladen.");
  } catch (error) {
    showToast(`Import fehlgeschlagen: ${error.message}`);
  } finally {
    $("#import-file").value = "";
  }
}

/** Rasterize the current SVG graph at 2x resolution and download it as a PNG. */
function exportPng() {
  const source = $("#graph");
  const clone = source.cloneNode(true);
  const { width, height } = graphSize();
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", width); clone.setAttribute("height", height);
  const isLight = document.documentElement.dataset.theme === "light";
  clone.querySelector(".canvas-bg").setAttribute("fill", isLight ? "#f4f8f9" : "#101a20");
  const styles = `text{font-family:Segoe UI,Arial,sans-serif}.node-rect{fill:${isLight ? "#ffffff" : "#203139"};stroke:${isLight ? "#93a9af" : "#39525a"};stroke-width:1}.node-name{fill:${isLight ? "#17262c" : "#e9f1f2"};font-size:26px;font-weight:600}.node-meta{fill:${isLight ? "#526970" : "#82989e"};font-size:20px}.link-label{fill:${isLight ? "#17262c" : "#d6e0e1"};font-size:24px;font-weight:700;paint-order:stroke;stroke:${isLight ? "#f4f8f9" : "#111d22"};stroke-width:1.5px}.link-path{fill:none;stroke-width:3px;opacity:.92}`;
  const style = document.createElementNS("http://www.w3.org/2000/svg", "style"); style.textContent = styles; clone.prepend(style);
  const data = new XMLSerializer().serializeToString(clone);
  const image = new Image();
  image.onload = () => {
    const canvas = document.createElement("canvas"); canvas.width = width * 2; canvas.height = height * 2;
    const context = canvas.getContext("2d"); context.scale(2, 2); context.drawImage(image, 0, 0, width, height);
    canvas.toBlob((blob) => blob && downloadBlob(blob, "planspiel-kommunikationskarte.png"));
  };
  image.onerror = () => showToast("PNG-Export konnte nicht erstellt werden.");
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(data)}`;
}

function bindEvents() {
  $("#current-file-button").addEventListener("click", connectCurrentFile);
  $("#theme-toggle").addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
  $("#add-message-button").addEventListener("click", () => openMessageDialog());
  $("#empty-add-message").addEventListener("click", () => openMessageDialog());
  $("#add-party-button").addEventListener("click", () => openPartyDialog());
  $("#import-button").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", (event) => { if (event.target.files[0]) importJson(event.target.files[0]); });
  $("#export-button").addEventListener("click", exportJson);
  $("#png-button").addEventListener("click", exportPng);
  $("#print-button").addEventListener("click", () => window.print());
  $("#fit-button").addEventListener("click", fitGraph);
  $("#zoom-in").addEventListener("click", () => svg.transition().call(d3Zoom.scaleBy, 1.25));
  $("#zoom-out").addEventListener("click", () => svg.transition().call(d3Zoom.scaleBy, .8));
  $("#undo-button").addEventListener("click", undo);
  $("#redo-button").addEventListener("click", redo);
  $("#statistics-button").addEventListener("click", (event) => {
    const panel = $("#stats-panel"); panel.hidden = !panel.hidden;
    event.currentTarget.setAttribute("aria-pressed", String(!panel.hidden));
    $("#messages-panel").hidden = true;
    $("#messages-button").setAttribute("aria-pressed", "false");
    if (!panel.hidden) requestAnimationFrame(fitGraph);
  });
  $("#messages-button").addEventListener("click", (event) => {
    const panel = $("#messages-panel"); panel.hidden = !panel.hidden;
    event.currentTarget.setAttribute("aria-pressed", String(!panel.hidden));
    $("#stats-panel").hidden = true;
    $("#statistics-button").setAttribute("aria-pressed", "false");
    if (!panel.hidden) { renderMessagesList(); requestAnimationFrame(fitGraph); }
  });
  $("#search-input").addEventListener("input", renderFilteredViews);
  $$(".filter-row input").forEach((input) => input.addEventListener("change", renderFilteredViews));
  $("#date-from").addEventListener("change", renderFilteredViews);
  $("#date-to").addEventListener("change", renderFilteredViews);
  $("#reset-filters").addEventListener("click", () => {
    $$(".filter-row input").forEach((input) => { input.checked = true; });
    $("#search-input").value = ""; $("#date-from").value = ""; $("#date-to").value = ""; selectedParties.clear();
    ensurePartySpacing(true, state.parties, state.messages);
    renderAll(); requestAnimationFrame(fitGraph);
  });
  $("#message-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const id = $("#message-id").value;
    const values = { from: $("#message-from").value, to: $("#message-to").value, category: $("#message-category").value, timestamp: $("#message-timestamp").value, text: $("#message-text").value.trim(), notes: $("#message-notes").value.trim() };
    if (!values.text) return;
    saveHistory();
    if (id) Object.assign(state.messages.find((message) => message.id === id), values);
    else state.messages.push({ id: makeId("message"), ...values });
    currentTime = null; graphInitialized = false; $("#message-dialog").close(); persist(); renderAll(); showToast(id ? "Nachricht aktualisiert." : "Nachricht erstellt.");
  });
  $("#party-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const id = $("#party-id").value;
    const name = $("#party-name").value.trim();
    if (!name) return;
    saveHistory();
    if (id) Object.assign(state.parties.find((party) => party.id === id), { name, description: $("#party-description").value.trim() });
    else {
      const { width, height } = graphSize();
      const angle = state.parties.length * 2.4;
      state.parties.push({ id: makeId("party"), name, description: $("#party-description").value.trim(), x: width / 2 + Math.cos(angle) * 145, y: height / 2 + Math.sin(angle) * 120 });
    }
    graphInitialized = false; $("#party-dialog").close(); persist(); renderAll(); showToast(id ? "Partei aktualisiert." : "Partei erstellt.");
  });
  $("#delete-message-button").addEventListener("click", () => deleteMessage($("#message-id").value));
  $("#delete-party-button").addEventListener("click", () => deleteParty($("#party-id").value));
  $("#close-detail").addEventListener("click", closeDetails);
  $$('[data-close]').forEach((button) => button.addEventListener("click", () => $(`#${button.dataset.close}`).close()));
  $("#time-slider").addEventListener("input", (event) => { stopPlayback(); currentTime = Number(event.target.value); $("#timeline-date").textContent = formatTime(currentTime); renderGraph(); });
  $("#play-button").addEventListener("click", () => playbackTimer ? stopPlayback() : startPlayback());
  $("#stop-button").addEventListener("click", () => { stopPlayback(); currentTime = Number($("#time-slider").min); $("#time-slider").value = String(currentTime); $("#timeline-date").textContent = formatTime(currentTime); renderGraph(); });
  $("#step-back").addEventListener("click", () => stepTime(-1));
  $("#step-forward").addEventListener("click", () => stepTime(1));
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const editing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !editing) { event.preventDefault(); event.shiftKey ? redo() : undo(); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y" && !editing) { event.preventDefault(); redo(); }
    else if (event.code === "Space" && !editing && !$("#message-dialog").open && !$("#party-dialog").open) { event.preventDefault(); playbackTimer ? stopPlayback() : startPlayback(); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); $("#search-input").focus(); }
    else if (event.key === "Escape" && currentDetailId) closeDetails();
  });
  window.addEventListener("resize", () => {
    if (!state.parties.length) return;
    const { width, height } = graphSize();
    svg.attr("viewBox", `0 0 ${width} ${height}`);
    renderGraph();
  });
}

function stepTime(amount) {
  if ($("#time-slider").disabled) return;
  stopPlayback();
  currentTime = Math.max(Number($("#time-slider").min), Math.min(Number($("#time-slider").max), Number(currentTime) + amount));
  $("#time-slider").value = String(currentTime);
  $("#timeline-date").textContent = formatTime(currentTime);
  renderGraph();
}

applyTheme(localStorage.getItem(THEME_STORAGE_KEY) || "dark", false);
setupZoom();
bindEvents();
renderAll();
if (!localStorage.getItem(STORAGE_KEY)) {
  weightedLayout();
  persist();
  renderGraph();
}
requestAnimationFrame(fitGraph);
updateHistoryButtons();
restoreLinkedCurrentFile();