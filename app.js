/* ================================================
   STL Bus – app.js
   Fetches real-time bus schedules from STL API
   ================================================ */

'use strict';

// ─── Route configuration ─────────────────────────────────────────────────────
const ROUTES = [
  { id: '33N', routeId: '33N', stopId: '46063', label: '33 Aller',  cardKey: '33N' },
  { id: '33S', routeId: '33S', stopId: '48033', label: '33 Retour', cardKey: '33S' },
  { id: '63N', routeId: '63N', stopId: '41267', label: '63 Aller',  cardKey: '63N' },
  { id: '63S', routeId: '63S', stopId: '43509', label: '63 Retour', cardKey: '63S' },
];


const AUTO_REFRESH_INTERVAL = 60 * 1000; // 60 s

// ─── State ───────────────────────────────────────────────────────────────────
let scheduleData = {}; // { '33N': [...allTimes], ... }
let currentService = null; // SEM | SAM | DIM
let refreshTimer = null;
let countdownTimer = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns today's date formatted as DD-MM-YYYY for the STL API URL */
function getTodayForUrl() {
  const now = new Date();
  const day   = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year  = now.getFullYear();
  return `${day}-${month}-${year}`;
}

/** Returns the date string in DD-MM-YYYY format for the STL API path */
function getApiDate() {
  const now = new Date();
  const d  = String(now.getDate()).padStart(2, '0');
  const m  = String(now.getMonth() + 1).padStart(2, '0');
  const y  = now.getFullYear();
  return `${d}-${m}-${y}`;
}

/** Returns current service type based on day of week */
function getServiceType() {
  const day = new Date().getDay(); // 0=Sun, 6=Sat
  if (day === 0) return 'DIM';
  if (day === 6) return 'SAM';
  return 'SEM';
}

/** Converts HH:MM time string to minutes since midnight (handles 24h+ for next-day) */
function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

/** Returns current time in minutes since midnight */
function nowMinutes() {
  const n = new Date();
  return n.getHours() * 60 + n.getMinutes();
}

/** Formats minutes difference as human-readable countdown */
function formatCountdown(diffMinutes) {
  if (diffMinutes < 0) return null;
  if (diffMinutes === 0) return 'Maintenant !';
  if (diffMinutes < 60) return `dans ${diffMinutes} min`;
  const h = Math.floor(diffMinutes / 60);
  const m = diffMinutes % 60;
  return `dans ${h}h${m > 0 ? String(m).padStart(2, '0') : ''}`;
}

/** Returns CSS class for countdown urgency */
function countdownClass(diffMinutes) {
  if (diffMinutes <= 3)  return 'countdown-soon';
  if (diffMinutes <= 10) return 'countdown-close';
  return 'countdown-ok';
}

/** Builds the STL API URL for a given route & stop */
function buildApiUrl(routeId, stopId) {
  const date = getApiDate();
  return `https://stlaval.ca/api/result/REGULIER/${date}?stopId=${stopId}&routeId=${routeId}&siteId=1`;
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function el(id) { return document.getElementById(id); }

function setStatus(msg, state = 'loading', service = '') {
  const dot  = el('statusDot');
  const text = el('statusText');
  const srv  = el('statusService');

  text.textContent = msg;
  dot.className = 'status-dot' + (state === 'ok' ? ' ok' : state === 'err' ? ' err' : '');
  srv.textContent = service;
}

function setCardStatusLoading(key) {
  const si = el('status-' + key);
  si.innerHTML = '<div class="spinner"></div>';
}
function setCardStatusOk(key) {
  const si = el('status-' + key);
  si.innerHTML = '<div class="check-icon">✓</div>';
}
function setCardStatusErr(key) {
  const si = el('status-' + key);
  si.innerHTML = '<div class="err-icon">✕</div>';
}

/** Renders the crowd indicator dots */
function renderCrowding(level) {
  // level: 1=low, 2=med, 3=high
  let html = '<div class="item-crowding">';
  for (let i = 1; i <= 3; i++) {
    const cls = i <= level ? `filled-${level}` : '';
    html += `<div class="crowd-dot ${cls}"></div>`;
  }
  html += '</div>';
  return html;
}

// ─── Schedule rendering ───────────────────────────────────────────────────────

function renderCard(key) {
  const times = scheduleData[key]; // array of {time, crowding}
  const now   = nowMinutes();

  const nextEl     = el('next-'     + key);
  const upcomingEl = el('upcoming-' + key);

  if (!times || times.length === 0) {
    nextEl.innerHTML = `
      <div class="next-label">Prochain départ</div>
      <div class="next-time" style="font-size:1.2rem;color:var(--text-muted)">Aucun départ</div>
      <div class="next-countdown">Plus de bus aujourd'hui</div>`;
    upcomingEl.innerHTML = '<div class="no-more">Fin de service pour aujourd\'hui</div>';
    return;
  }

  // Find next buses (after current time)
  const upcoming = times.filter(t => timeToMinutes(t.time) >= now);
  const past     = times.filter(t => timeToMinutes(t.time) <  now);

  const nextBus = upcoming[0] || null;

  // ── Next bus highlight
  if (nextBus) {
    const diff  = timeToMinutes(nextBus.time) - now;
    const cdown = formatCountdown(diff);
    const cclass = countdownClass(diff);
    nextEl.innerHTML = `
      <div class="next-label">Prochain départ</div>
      <div class="next-time">${nextBus.time}</div>
      <div class="next-countdown ${cclass}">${cdown}</div>`;
  } else {
    nextEl.innerHTML = `
      <div class="next-label">Prochain départ</div>
      <div class="next-time" style="font-size:1.2rem;color:var(--text-muted)">Aucun</div>
      <div class="next-countdown">Plus de bus ce soir</div>`;
  }

  // ── Upcoming list (next 4 after the first one)
  const listBuses = upcoming.slice(1, 5);
  if (listBuses.length === 0) {
    upcomingEl.innerHTML = past.length > 0
      ? '<div class="no-more">Dernier bus de la journée</div>'
      : '<div class="no-more">Aucun autre départ</div>';
  } else {
    upcomingEl.innerHTML = listBuses.map((bus, idx) => {
      const diff = timeToMinutes(bus.time) - now;
      const cdown = formatCountdown(diff);
      const style = `animation-delay: ${idx * 0.06}s`;
      return `
        <div class="upcoming-item" style="${style}">
          <span class="item-time">${bus.time}</span>
          ${renderCrowding(bus.crowding)}
          <span class="item-countdown">${cdown}</span>
        </div>`;
    }).join('');
  }
}

function updateAllCards() {
  ROUTES.forEach(r => renderCard(r.id));
}

// ─── API fetching ─────────────────────────────────────────────────────────────

async function fetchRoute(route) {
  setCardStatusLoading(route.id);
  const url = buildApiUrl(route.routeId, route.stopId);

  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    if (!data.success) throw new Error('API returned success=false');

    currentService = data.currentServiceId; // SEM | SAM | DIM

    // Extract times for this routeId from stopTimes
    const routeKey   = route.routeId;
    const stopTimes  = data.stopTimes?.[routeKey]?.[currentService];

    if (!stopTimes) {
      // Try to build from all periods anyway
      scheduleData[route.id] = [];
    } else {
      const allTimes = [
        ...(stopTimes.morning   || []),
        ...(stopTimes.afternoon || []),
        ...(stopTimes.evening   || []),
      ].map(t => ({ time: t.time, crowding: t.crowding || 1 }));

      scheduleData[route.id] = allTimes;
    }

    setCardStatusOk(route.id);
    return true;
  } catch (err) {
    console.warn(`Erreur route ${route.id}:`, err);
    scheduleData[route.id] = null;
    setCardStatusErr(route.id);
    return false;
  }
}

async function fetchAll() {
  const btn = el('refreshBtn');
  btn.classList.add('spinning');
  setStatus('Mise à jour des horaires…', 'loading');

  const results = await Promise.all(ROUTES.map(r => fetchRoute(r)));
  const okCount = results.filter(Boolean).length;

  // Determine service label
  const svcLabel = currentService === 'SEM' ? 'Semaine'
                 : currentService === 'SAM' ? 'Samedi'
                 : currentService === 'DIM' ? 'Dimanche'
                 : '';

  if (okCount === ROUTES.length) {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    setStatus(`Mis à jour à ${hh}:${mm}`, 'ok', svcLabel);
  } else if (okCount === 0) {
    setStatus('Impossible de récupérer les horaires', 'err', svcLabel);
  } else {
    setStatus(`Partiellement mis à jour (${okCount}/${ROUTES.length})`, 'loading', svcLabel);
  }

  updateAllCards();

  setTimeout(() => btn.classList.remove('spinning'), 700);
}

// ─── Clock & countdown ticker ─────────────────────────────────────────────────

function updateClock() {
  const now  = new Date();
  const hh   = String(now.getHours()).padStart(2, '0');
  const mm   = String(now.getMinutes()).padStart(2, '0');
  const ss   = String(now.getSeconds()).padStart(2, '0');
  el('clock').textContent = `${hh}:${mm}:${ss}`;

  // Date in French
  const opts = { weekday: 'long', day: 'numeric', month: 'long' };
  const dateStr = now.toLocaleDateString('fr-CA', opts);
  el('dateDisplay').textContent = dateStr.charAt(0).toUpperCase() + dateStr.slice(1);
}

function startCountdownTicker() {
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    updateAllCards();
    updateClock();
  }, 30 * 1000); // refresh countdowns every 30 s
}

// ─── Auto-refresh ─────────────────────────────────────────────────────────────

function scheduleAutoRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    fetchAll();
  }, AUTO_REFRESH_INTERVAL);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  // Clock ticks every second
  updateClock();
  setInterval(updateClock, 1000);

  // Manual refresh button
  el('refreshBtn').addEventListener('click', () => {
    fetchAll();
    scheduleAutoRefresh(); // reset the auto-refresh timer
  });

  // Initial fetch
  fetchAll();

  // Auto-refresh every 60 s
  scheduleAutoRefresh();

  // Countdown labels update every 30 s
  startCountdownTicker();
}

document.addEventListener('DOMContentLoaded', init);
