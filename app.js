"use strict";

const STORAGE_KEY = "planspiel-kommunikation-state-v1";
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
let state = loadState();
let currentTime = null;
let playbackTimer = null;
let toastTimer = null;
let currentDetailId = null;
let selectedParty = null;
let d3Zoom = null;
let graphInitialized = false;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const svg = d3.select("#graph");
const linkLayer = svg.select(".links-layer");
const nodeLayer = svg.select(".nodes-layer");
const zoomLayer = svg.select(".zoom-layer");

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
    category: CATEGORY[message.category] ? message.category : "schwarz", timestamp: String(message.timestamp || ""),
    text: String(message.text || ""), notes: String(message.notes || "")
  }));
  return { parties, messages };
}

function snapshot() { return JSON.stringify(state); }

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
    $("#save-status").textContent = "Lokal gespeichert";
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

function timeValue(timestamp) {
  const parsed = Date.parse(timestamp.replace(" ", "T"));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatTime(value) {
  if (!Number.isFinite(value)) return "Kein Zeitraum";
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function localDateTime(value = new Date()) {
  const date = new Date(value.getTime() - value.getTimezoneOffset() * 60000);
  return date.toISOString().slice(0, 16);
}

function graphSize() {
  const bounds = $("#graph-wrap").getBoundingClientRect();
  return { width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) };
}

function setupZoom() {
  d3Zoom = d3.zoom().scaleExtent([0.3, 2.5]).on("zoom", (event) => zoomLayer.attr("transform", event.transform));
  svg.call(d3Zoom).on("dblclick.zoom", null);
}

function fitGraph() {
  if (!state.parties.length) return;
  const { width, height } = graphSize();
  const margin = 90;
  const xs = state.parties.map((party) => party.x);
  const ys = state.parties.map((party) => party.y);
  const minX = Math.min(...xs) - 85;
  const maxX = Math.max(...xs) + 85;
  const minY = Math.min(...ys) - 42;
  const maxY = Math.max(...ys) + 42;
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
    const radius = Math.max(90, Math.min(width * .3, height * .3));
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
    .force("link", d3.forceLink(links).id((party) => party.id).distance((link) => Math.max(125, 260 - Math.min(120, link.count * 9))).strength(.38))
    .force("charge", d3.forceManyBody().strength(-600))
    .force("collision", d3.forceCollide(80))
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

/** Build a quadratic route, separating parallel/reverse links and looping self-messages. @param {Message} message */
function curveFor(message, pairCounts, reversePairs, partyById) {
  const source = partyById.get(message.from);
  const target = partyById.get(message.to);
  if (!source || !target) return { path: "", labelPath: "" };
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const key = `${message.from}>${message.to}`;
  const indexInPair = pairCounts.get(key) || 0;
  pairCounts.set(key, indexInPair + 1);
  const reverseExists = reversePairs.has(`${message.to}>${message.from}`);
  const direction = message.from < message.to ? 1 : -1;
  if (message.from === message.to) {
    const offset = 32 + indexInPair * 17;
    const startX = source.x + 19;
    const startY = source.y - 14;
    const endX = source.x - 19;
    const endY = source.y - 14;
    return { path: `M${startX},${startY} C${source.x + offset},${source.y - offset * 2} ${source.x - offset},${source.y - offset * 2} ${endX},${endY}`, labelPath: `M${source.x - offset * .65},${source.y - offset * 1.45} Q${source.x},${source.y - offset * 1.85} ${source.x + offset * .65},${source.y - offset * 1.45}` };
  }
  const offset = (indexInPair - (Math.max(1, pairCounts.get(key)) - 1) / 2) * 15 + (reverseExists ? direction * 24 : 0);
  const midX = (source.x + target.x) / 2 - (dy / distance) * offset;
  const midY = (source.y + target.y) / 2 + (dx / distance) * offset;
  const shorten = 54 / distance;
  const startX = source.x + dx * shorten;
  const startY = source.y + dy * shorten;
  const endX = target.x - dx * shorten;
  const endY = target.y - dy * shorten;
  return { path: `M${startX},${startY} Q${midX},${midY} ${endX},${endY}`, labelPath: `M${startX},${startY} Q${midX},${midY} ${endX},${endY}` };
}

function getFilters() {
  const categories = new Set($$(".filter-row input:checked").map((input) => input.value));
  const query = $("#search-input").value.trim().toLocaleLowerCase("de");
  const from = $("#date-from").value ? new Date($("#date-from").value).getTime() : -Infinity;
  const to = $("#date-to").value ? new Date($("#date-to").value).getTime() : Infinity;
  return { categories, query, from, to };
}

/** Evaluate category, party, search, date, and simulation-time visibility without changing graph positions. */
function visibleStatus(message, filters) {
  const timestamp = timeValue(message.timestamp);
  const search = `${message.text} ${message.notes} ${partyName(message.from)} ${partyName(message.to)}`.toLocaleLowerCase("de");
  const matches = filters.categories.has(message.category) && (!selectedParty || message.from === selectedParty || message.to === selectedParty)
    && (!filters.query || search.includes(filters.query)) && timestamp !== null && timestamp >= filters.from && timestamp <= filters.to;
  const inTime = currentTime === null || timestamp <= currentTime;
  return { matches, inTime, searchMatch: Boolean(filters.query && search.includes(filters.query)) };
}

function partyName(id) { return state.parties.find((party) => party.id === id)?.name || "Unbekannt"; }

function renderGraph() {
  if (!graphInitialized) {
    weightedLayout();
    graphInitialized = true;
  }
  const { width, height } = graphSize();
  svg.attr("viewBox", `0 0 ${width} ${height}`);
  const { sent, received } = messageStats();
  const filters = getFilters();
  const pairCounts = new Map();
  const partyById = new Map(state.parties.map((party) => [party.id, party]));
  const reversePairs = new Set(state.messages.map((message) => `${message.from}>${message.to}`));
  const items = state.messages.map((message) => ({ ...message, route: curveFor(message, pairCounts, reversePairs, partyById), status: visibleStatus(message, filters) }));
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
  links.select("textPath").attr("href", (message) => `#label-path-${message.id}`).text((message) => message.text.length > 35 ? `${message.text.slice(0, 33)}…` : message.text);
  links.select("title").text((message) => `${partyName(message.from)} → ${partyName(message.to)}\n${message.timestamp}\n${message.text}`);

  const nodes = nodeLayer.selectAll("g.node-card").data(state.parties, (party) => party.id).join(
    (enter) => {
      const group = enter.append("g").attr("class", "node-card").attr("tabindex", 0).attr("role", "button");
      group.append("rect").attr("class", "node-rect").attr("x", -69).attr("y", -27).attr("width", 138).attr("height", 54).attr("rx", 9);
      group.append("text").attr("class", "node-name").attr("text-anchor", "middle").attr("y", -2);
      group.append("text").attr("class", "node-meta").attr("text-anchor", "middle").attr("y", 16);
      group.append("title");
      group.on("click", (event, party) => { if (event.defaultPrevented) return; openPartyDialog(party.id); })
        .on("keydown", (event, party) => { if (event.key === "Enter") openPartyDialog(party.id); });
      return group;
    },
    (update) => update,
    (exit) => exit.remove()
  );
  nodes.attr("transform", (party) => `translate(${party.x},${party.y})`)
    .classed("party-focused", (party) => selectedParty === party.id)
    .attr("aria-label", (party) => `${party.name}, ${sent.get(party.id) || 0} gesendet, ${received.get(party.id) || 0} empfangen`);
  nodes.select(".node-name").text((party) => party.name.length > 21 ? `${party.name.slice(0, 19)}…` : party.name);
  nodes.select(".node-meta").text((party) => `${sent.get(party.id) || 0} gesendet · ${received.get(party.id) || 0} empfangen`);
  nodes.select("title").text((party) => party.description ? `${party.name}\n${party.description}` : party.name);
  nodes.call(d3.drag()
    .on("start", (event) => { if (!event.active) saveHistory(); event.sourceEvent.stopPropagation(); })
    .on("drag", (event, party) => { party.x = event.x; party.y = event.y; renderGraph(); })
    .on("end", () => { persist(); renderPartyList(); }));
  $("#graph-empty").hidden = state.messages.length > 0;
}

function renderPartyList() {
  const { sent, received } = messageStats();
  const rows = d3.select("#party-list").selectAll("label.party-row").data(state.parties, (party) => party.id).join("label").attr("class", (party) => `party-row${selectedParty === party.id ? " selected" : ""}`);
  rows.html("");
  rows.append("input").attr("type", "checkbox").attr("aria-label", (party) => `Partei ${party.name} hervorheben`).property("checked", (party) => selectedParty === party.id)
    .on("change", (event, party) => { selectedParty = event.currentTarget.checked ? party.id : null; renderAll(); });
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
    slider.min = "0"; slider.max = "100"; slider.value = "100"; slider.disabled = true;
    currentTime = null;
    $("#timeline-date").textContent = "Kein Zeitraum";
    $("#slider-ticks").replaceChildren();
    return;
  }
  slider.disabled = false;
  const min = times[0]; const max = times.at(-1);
  slider.min = String(min); slider.max = String(max === min ? min + 60000 : max);
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
  const dated = visible.map((message) => timeValue(message.timestamp)).filter(Number.isFinite);
  if (dated.length) {
    const width = 250; const height = 80; const margin = { top: 5, right: 5, bottom: 4, left: 5 };
    const domain = d3.extent(dated); const bins = d3.bin().domain(domain[0] === domain[1] ? [domain[0], domain[0] + 1] : domain).thresholds(Math.min(12, Math.max(3, dated.length)))(dated);
    const timeScale = d3.scaleLinear().domain(domain[0] === domain[1] ? [domain[0], domain[0] + 1] : domain).range([margin.left, width - margin.right]);
    const activityScale = d3.scaleLinear().domain([0, d3.max(bins, (bin) => bin.length) || 1]).range([height - margin.bottom, margin.top]);
    const area = d3.area().x((bin) => timeScale((bin.x0 + bin.x1) / 2)).y0(height - margin.bottom).y1((bin) => activityScale(bin.length)).curve(d3.curveMonotoneX);
    const line = d3.line().x((bin) => timeScale((bin.x0 + bin.x1) / 2)).y((bin) => activityScale(bin.length)).curve(d3.curveMonotoneX);
    timeRoot.attr("viewBox", `0 0 ${width} ${height}`).append("path").datum(bins).attr("class", "time-area").attr("d", area);
    timeRoot.append("path").datum(bins).attr("class", "time-line").attr("d", line);
  }
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
  updateDetailPanel();
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
  $("#message-timestamp").value = message ? message.timestamp.replace(" ", "T") : localDateTime();
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
      <label class="detail-field">Zeitstempel<input id="detail-timestamp" type="datetime-local" value="${escapeHtml(message.timestamp.replace(" ", "T"))}"></label>
      <label class="detail-field">Nachricht<textarea id="detail-text" rows="4">${escapeHtml(message.text)}</textarea></label>
      <label class="detail-field">Notizen<textarea id="detail-notes" rows="3">${escapeHtml(message.notes)}</textarea></label>
    </div><div class="detail-actions"><button class="button button-primary" id="save-detail">Änderungen speichern</button><button class="button button-danger-text" id="remove-detail">Löschen</button></div>`;
  $("#save-detail").onclick = () => {
    saveHistory();
    Object.assign(message, { from: $("#detail-from").value, to: $("#detail-to").value, category: $("#detail-category").value, timestamp: $("#detail-timestamp").value.replace("T", " "), text: $("#detail-text").value.trim(), notes: $("#detail-notes").value.trim() });
    currentTime = null; persist(); renderAll(); showToast("Nachricht aktualisiert.");
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
  selectedParty = null; graphInitialized = true;
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
  const millisecondsPerTick = Math.max(1, (end - start) / 600) * Number($("#speed-select").value);
  $("#play-button").textContent = "Ⅱ";
  $("#play-button").title = "Pause";
  $("#play-button").setAttribute("aria-label", "Pause");
  playbackTimer = setInterval(() => {
    const next = Number(currentTime) + millisecondsPerTick;
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
    saveHistory(); state = imported; graphInitialized = false; currentTime = null; selectedParty = null;
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
  clone.querySelector(".canvas-bg").setAttribute("fill", "#101a20");
  const styles = `text{font-family:DM Sans,Arial,sans-serif}.node-rect{fill:#203139;stroke:#39525a;stroke-width:1}.node-name{fill:#e9f1f2;font-size:12px;font-weight:600}.node-meta{fill:#82989e;font-size:10px}.link-label{fill:#d6e0e1;font-size:10px;paint-order:stroke;stroke:#111d22;stroke-width:4px}.link-path{fill:none;stroke-width:1.8;opacity:.85}`;
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
    if (!panel.hidden) requestAnimationFrame(fitGraph);
  });
  $("#search-input").addEventListener("input", renderGraph);
  $$(".filter-row input").forEach((input) => input.addEventListener("change", renderGraph));
  $("#date-from").addEventListener("change", renderGraph);
  $("#date-to").addEventListener("change", renderGraph);
  $("#reset-filters").addEventListener("click", () => {
    $$(".filter-row input").forEach((input) => { input.checked = true; });
    $("#search-input").value = ""; $("#date-from").value = ""; $("#date-to").value = ""; selectedParty = null; renderAll();
  });
  $("#message-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const id = $("#message-id").value;
    const values = { from: $("#message-from").value, to: $("#message-to").value, category: $("#message-category").value, timestamp: $("#message-timestamp").value.replace("T", " "), text: $("#message-text").value.trim(), notes: $("#message-notes").value.trim() };
    if (!values.text) return;
    saveHistory();
    if (id) Object.assign(state.messages.find((message) => message.id === id), values);
    else state.messages.push({ id: makeId("message"), ...values });
    currentTime = null; $("#message-dialog").close(); persist(); renderAll(); showToast(id ? "Nachricht aktualisiert." : "Nachricht erstellt.");
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
    $("#party-dialog").close(); persist(); renderAll(); showToast(id ? "Partei aktualisiert." : "Partei erstellt.");
  });
  $("#delete-message-button").addEventListener("click", () => deleteMessage($("#message-id").value));
  $("#delete-party-button").addEventListener("click", () => deleteParty($("#party-id").value));
  $("#close-detail").addEventListener("click", closeDetails);
  $$('[data-close]').forEach((button) => button.addEventListener("click", () => $(`#${button.dataset.close}`).close()));
  $("#time-slider").addEventListener("input", (event) => { stopPlayback(); currentTime = Number(event.target.value); $("#timeline-date").textContent = formatTime(currentTime); renderGraph(); });
  $("#play-button").addEventListener("click", () => playbackTimer ? stopPlayback() : startPlayback());
  $("#stop-button").addEventListener("click", () => { stopPlayback(); currentTime = Number($("#time-slider").min); $("#time-slider").value = String(currentTime); $("#timeline-date").textContent = formatTime(currentTime); renderGraph(); });
  $("#step-back").addEventListener("click", () => stepTime(-60000));
  $("#step-forward").addEventListener("click", () => stepTime(60000));
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