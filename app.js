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

// ─── Modal – horaires complets ────────────────────────────────────────────────

/** Metadata for each route (used by the modal) */
const ROUTE_META = {
  '33N': { label: 'Ligne 33 – Aller',  stop: 'Arrêt #46063', badgeClass: 'badge-33', routeClass: 'route-33', number: '33' },
  '33S': { label: 'Ligne 33 – Retour', stop: 'Arrêt #48033', badgeClass: 'badge-33', routeClass: 'route-33', number: '33' },
  '63N': { label: 'Ligne 63 – Aller',  stop: 'Arrêt #41267', badgeClass: 'badge-63', routeClass: 'route-63', number: '63' },
  '63S': { label: 'Ligne 63 – Retour', stop: 'Arrêt #43509', badgeClass: 'badge-63', routeClass: 'route-63', number: '63' },
};

function openModal(routeKey) {
  const meta   = ROUTE_META[routeKey];
  const times  = scheduleData[routeKey];
  const now    = nowMinutes();

  // Populate header
  const badge = el('modalBadge');
  badge.textContent   = meta.number;
  badge.className     = 'modal-badge ' + meta.badgeClass;
  el('modalTitle').textContent    = meta.label;
  el('modalSubtitle').textContent = meta.stop;

  // Build body
  const body = el('modalBody');
  if (!times || times.length === 0) {
    body.innerHTML = '<div class="modal-no-data">Aucun horaire disponible pour aujourd\'hui.</div>';
  } else {
    // Find first upcoming bus index
    const nextIdx = times.findIndex(t => timeToMinutes(t.time) >= now);
    const isRoute63 = routeKey.startsWith('63');

    // Group into periods (morning / afternoon / evening) based on hour
    const periods = [
      { key: 'morning',   label: 'Matin',        range: [0,  11] },
      { key: 'afternoon', label: 'Après-midi',    range: [12, 17] },
      { key: 'evening',   label: 'Soir / Nuit',   range: [18, 30] },
    ];

    let html = '';
    periods.forEach(period => {
      const periodTimes = times.filter(t => {
        const h = parseInt(t.time.split(':')[0], 10);
        return h >= period.range[0] && h <= period.range[1];
      });
      if (periodTimes.length === 0) return;

      html += `<div class="modal-period-header">${period.label}</div>`;
      periodTimes.forEach(bus => {
        const busMinutes = timeToMinutes(bus.time);
        const idx        = times.indexOf(bus);
        const isPast     = busMinutes < now;
        const isNext     = idx === nextIdx;
        const diff       = busMinutes - now;
        const cdown      = !isPast ? formatCountdown(diff) : '';
        const cclass     = !isPast && diff >= 0 ? countdownClass(diff) : '';
        const rowRoute   = isRoute63 ? 'route-63' : 'route-33';

        let rowClass = 'modal-time-row';
        if (isPast)  rowClass += ' is-past';
        if (isNext)  rowClass += ' is-next ' + rowRoute;

        const pillHtml = isNext
          ? `<span class="modal-next-pill">Prochain</span>`
          : `${renderCrowding(bus.crowding)}`;

        html += `
          <div class="${rowClass}">
            <span class="modal-time-val">${bus.time}</span>
            ${pillHtml}
            <span class="modal-time-cdown ${cclass}">${isPast ? 'Passé' : cdown}</span>
          </div>`;
      });
    });

    body.innerHTML = html;

    // Scroll to the next bus row
    requestAnimationFrame(() => {
      const nextRow = body.querySelector('.is-next');
      if (nextRow) nextRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  el('modalOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  el('modalOverlay').classList.remove('open');
  document.body.style.overflow = '';
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

  // ── Click on any bus card → open modal
  ROUTES.forEach(r => {
    el('card-' + r.id).addEventListener('click', () => openModal(r.id));
  });

  // ── Close modal
  el('modalClose').addEventListener('click', closeModal);
  el('modalOverlay').addEventListener('click', e => {
    if (e.target === el('modalOverlay')) closeModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
  });

  // Initial fetch
  fetchAll();

  // Auto-refresh every 60 s
  scheduleAutoRefresh();

  // Countdown labels update every 30 s
  startCountdownTicker();
}

document.addEventListener('DOMContentLoaded', init);
