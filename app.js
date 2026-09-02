lucide.createIcons();

// ==========================================
// 1. GLOBAL STRING NORMALIZER & UTILITIES
// ==========================================
function normalizeStr(str) {
  if (!str) return "";
  return str.toString()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// Global Application State
let activeRouteKey = null;
let activeMatchingRoutes = [];
let currentStopsList = [];
let currentDirection = "UP";
let isTrackingConfirmed = false;
let selectedPickupStop = null;
let selectedDestStop = null;
let busNearestStopIdx = 0;
let activeTransferPlan = null;
let currentTripPlanType = "DIRECT"; // "DIRECT" or "TRANSFER"
let lastSearchResult = null;
let hasAutoScrolledForCurrentTrip = false;
let currentMobileTab = "buses"; // "buses" or "schedule"
let shouldResetScrollOnNextRender = false;
let savedPlaces = { home: null, work: null, favorites: [] };
let chipHoldTimer = null;
let chipHoldFired = false;
const CHIP_HOLD_MS = 600;
const SAVED_PLACES_STORAGE_KEY = "nexbus_saved_places_v1";

const activeBuses = {};
const activeBusMarkers = {};
let selectedBusPlate = null;

function findStopIndexInList(stops, targetStop) {
  if (!stops || !targetStop) return -1;
  const targetNorm = normalizeStr(typeof targetStop === 'string' ? targetStop : targetStop.name);
  if (!targetNorm) return -1;

  let idx = stops.findIndex(s => normalizeStr(s.name) === targetNorm);
  if (idx !== -1) return idx;

  idx = stops.findIndex(s => {
    const sNorm = normalizeStr(s.name);
    return sNorm.includes(targetNorm) || targetNorm.includes(sNorm) || (s.area && normalizeStr(s.area).includes(targetNorm));
  });
  return idx;
}

// ==========================================
// MOBILE VIEW TAB SWITCHER
// ==========================================
function switchMobileTab(tab) {
  currentMobileTab = tab;
  const busesCol = document.getElementById("busesListContainer");
  const scheduleCol = document.getElementById("scheduleColumn");
  const tabBusesBtn = document.getElementById("tabBusesBtn");
  const tabScheduleBtn = document.getElementById("tabScheduleBtn");

  if (window.innerWidth < 768) {
    if (tab === 'schedule') {
      busesCol?.classList.add('hidden');
      scheduleCol?.classList.remove('hidden');
      scheduleCol?.classList.add('flex');
      if (tabScheduleBtn && tabBusesBtn) {
        tabScheduleBtn.className = "flex-1 py-1.5 text-xs font-bold rounded-xl bg-white text-slate-900 shadow-sm transition-all flex items-center justify-center gap-1.5";
        tabBusesBtn.className = "flex-1 py-1.5 text-xs font-bold rounded-xl text-slate-500 hover:text-slate-800 transition-all flex items-center justify-center gap-1.5";
      }
    } else {
      busesCol?.classList.remove('hidden');
      scheduleCol?.classList.add('hidden');
      scheduleCol?.classList.remove('flex');
      if (tabScheduleBtn && tabBusesBtn) {
        tabBusesBtn.className = "flex-1 py-1.5 text-xs font-bold rounded-xl bg-white text-slate-900 shadow-sm transition-all flex items-center justify-center gap-1.5";
        tabScheduleBtn.className = "flex-1 py-1.5 text-xs font-bold rounded-xl text-slate-500 hover:text-slate-800 transition-all flex items-center justify-center gap-1.5";
      }
    }
  } else {
    busesCol?.classList.remove('hidden');
    if (scheduleCol) {
      scheduleCol.classList.remove('hidden');
      scheduleCol.classList.add('flex');
    }
  }
  lucide.createIcons();
}

window.addEventListener('resize', () => {
  if (window.innerWidth >= 768) {
    document.getElementById("busesListContainer")?.classList.remove('hidden');
    const scheduleCol = document.getElementById("scheduleColumn");
    if (scheduleCol) {
      scheduleCol.classList.remove('hidden');
      scheduleCol.classList.add('flex');
    }
  } else {
    switchMobileTab(currentMobileTab);
  }
});

// ==========================================
// 2. LEAFLET MAP SETUP & SMOOTH TRANSITIONS
// ==========================================
const map = L.map('map', { center: [22.5000, 88.2500], zoom: 12, zoomControl: false });

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

map.on('click', () => closeBottomSheet());
map.on('dragstart', () => closeBottomSheet());

map.on('movestart', () => {
  document.querySelectorAll('.bus-marker-wrapper').forEach(el => {
    el.style.transition = 'none';
  });
});

map.on('moveend', () => {
  document.querySelectorAll('.bus-marker-wrapper').forEach(el => {
    el.style.transition = 'transform 3s linear';
  });
});

let routePolylineLayer = null;
let approachPolylineLayer = null;
let leg1PolylineLayer = null;
let leg2PolylineLayer = null;
let stopMarkersLayer = L.layerGroup().addTo(map);
let breadcrumbLines = {};

function createDynamicBusMapIcon(routeString, busPlate, heading = 0, destTerminal = "") {
  const rotationStyle = (heading !== undefined && heading !== null) 
    ? `transform: rotate(${heading}deg);` 
    : '';

  const tagLabel = destTerminal 
    ? `${routeString} ➔ ${destTerminal}` 
    : routeString;

  return L.divIcon({
    className: '',
    html: `
      <div class="bus-marker-wrapper flex flex-col items-center">
        <div class="bus-tag-top whitespace-nowrap px-2 py-0.5 rounded shadow text-[10px] font-extrabold bg-sky-600 text-white flex items-center gap-1">
          <span>${tagLabel}</span>
        </div>

        <div class="relative w-9 h-9 flex items-center justify-center my-0.5">
          <div class="bus-pulse"></div>
          
          <div class="absolute inset-0 flex items-center justify-center pointer-events-none transition-transform duration-500 ease-linear" style="${rotationStyle}">
            <div class="w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-b-[10px] border-b-[#00ABE4] absolute -top-1.5 drop-shadow-md"></div>
          </div>

          <div class="relative z-10 w-8 h-8 bg-slate-900 text-white rounded-full border-2 border-white shadow-xl flex items-center justify-center">
            <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-[#00ABE4]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6v6"/><path d="M15 6v6"/><path d="M2 12h19.6"/><path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><circle cx="15" cy="18" r="2"/></svg>
          </div>
        </div>

        <div class="bus-tag-bottom px-1.5 py-0.5 rounded text-[9px] font-bold bg-slate-900 text-white border border-slate-700 shadow font-mono">
          ${busPlate}
        </div>
      </div>
    `,
    iconSize: [0, 0],
    iconAnchor: [0, 0]
  });
}

function createPinIcon(type) {
  let color = "#94a3b8";
  let size = 8;
  let border = "1px solid #fff";

  if (type === "pickup") {
    color = "#10B981";
    size = 18;
    border = "3px solid #fff; box-shadow: 0 0 12px #10B981;";
  } else if (type === "bus_loc") {
    color = "#f59e0b";
    size = 16;
    border = "3px solid #fff; box-shadow: 0 0 10px #f59e0b;";
  } else if (type === "transfer") {
    color = "#00ABE4";
    size = 16;
    border = "3px solid #fff; box-shadow: 0 0 12px #00ABE4;";
  } else if (type === "dest") {
    color = "#ef4444";
    size = 18;
    border = "3px solid #fff; box-shadow: 0 0 12px #ef4444;";
  }

  return L.divIcon({
    className: '',
    html: `<div style="background:${color}; width:${size}px; height:${size}px; border-radius:50%; border:${border}; margin-left:-${size/2}px; margin-top:-${size/2}px;"></div>`,
    iconSize: [0, 0]
  });
}

function formatEtaTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return "--";
  if (seconds <= 60) return "Due (< 1 min)";
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return hours > 0 ? (mins > 0 ? `${hours} hr ${mins} mins` : `${hours} hr`) : `${mins} mins`;
}

function formatClockTime(secondsFromNow) {
  if (!isFinite(secondsFromNow) || secondsFromNow < 0) return "--:--";
  const d = new Date(Date.now() + secondsFromNow * 1000);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function tlRow({ name, badge, subLabel, timeLabel, statusText, statusClass, dotState, dim, active }) {
  return `
    <div class="tl-row${dim ? ' tl-row-dim' : ''}${active ? ' active-target-stop' : ''}">
      <div class="tl-rail">
        <div class="tl-line-top"></div>
        <div class="tl-dot ${dotState}"></div>
        <div class="tl-line-bottom"></div>
      </div>
      <div class="tl-content">
        <div class="min-w-0">
          <div class="tl-name truncate">${name}${badge ? ` <span class="text-[9px] font-bold ${badge.cls}">(${badge.text})</span>` : ''}</div>
          <div class="tl-sub truncate">${subLabel}</div>
        </div>
        <div class="shrink-0 text-right">
          <div class="tl-time">${timeLabel}</div>
          <div class="tl-status ${statusClass}">${statusText}</div>
        </div>
      </div>
    </div>`;
}

function tlDivider(html) {
  return `<div class="tl-transfer-divider">🔄 ${html}</div>`;
}

function setTimelineHTML(rowsHtmlArray) {
  const container = document.getElementById("stopsTimeline");
  if (container) container.innerHTML = rowsHtmlArray.join("");
}

function getDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const phi1 = lat1 * Math.PI / 180;
  const phi2 = lat2 * Math.PI / 180;
  const dPhi = (lat2 - lat1) * Math.PI / 180;
  const dLam = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dPhi/2) * Math.sin(dPhi/2) + Math.cos(phi1)*Math.cos(phi2) * Math.sin(dLam/2)*Math.sin(dLam/2);
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function calculateRouteSegmentDistance(idxA, idxB, stopsList) {
  if (idxA === idxB) return 0;
  const start = Math.min(idxA, idxB);
  const end = Math.max(idxA, idxB);
  let totalMeters = 0;
  for (let i = start + 1; i <= end; i++) {
    totalMeters += getDistanceMeters(stopsList[i - 1].lat, stopsList[i - 1].lng, stopsList[i].lat, stopsList[i].lng) * 1.18;
  }
  return totalMeters;
}

function findBusNearestStopIndex(busLat, busLng, stops) {
  if (!stops || stops.length === 0) return 0;
  let closestIdx = 0;
  let minDirect = Infinity;
  for (let i = 0; i < stops.length; i++) {
    const d = getDistanceMeters(busLat, busLng, stops[i].lat, stops[i].lng);
    if (d < minDirect) {
      minDirect = d;
      closestIdx = i;
    }
  }
  return closestIdx;
}

function calculateEtaSeconds(busLat, busLng, busSpeedKmph, targetStopIdx, stops) {
  if (!stops || targetStopIdx < 0 || targetStopIdx >= stops.length) return Infinity;

  const busIdx = findBusNearestStopIndex(busLat, busLng, stops);
  if (busIdx > targetStopIdx) return Infinity;

  const DWELL_SEC = 20;
  const effectiveSpeed = (busSpeedKmph >= 3.0) ? busSpeedKmph : 20.0;
  const speedMps = (effectiveSpeed * 1000) / 3600;

  if (busIdx === targetStopIdx) {
    const direct = getDistanceMeters(busLat, busLng, stops[targetStopIdx].lat, stops[targetStopIdx].lng);
    return Math.max(20, (direct * 1.18) / speedMps);
  }

  let accDist = calculateRouteSegmentDistance(busIdx, targetStopIdx, stops);
  let intermediateStops = targetStopIdx - busIdx;

  return (accDist / speedMps) + (intermediateStops * DWELL_SEC);
}

function calculateAccurateBusToStopDistance(busLat, busLng, targetStopIdx, stops) {
  if (!stops || targetStopIdx < 0 || targetStopIdx >= stops.length) return 0;
  const busIdx = findBusNearestStopIndex(busLat, busLng, stops);
  if (busIdx > targetStopIdx) return 0;
  return calculateRouteSegmentDistance(busIdx, targetStopIdx, stops);
}

function calculateTripSummary(pickupStop, destStop, stopsList, effectiveSpeedKmph = 20.0) {
  const pIdx = findStopIndexInList(stopsList, pickupStop);
  const dIdx = findStopIndexInList(stopsList, destStop);
  
  if (pIdx === -1 || dIdx === -1 || pIdx >= dIdx) return null;

  const DWELL_SEC = 20;
  const speedMps = (effectiveSpeedKmph * 1000) / 3600;

  const totalMeters = calculateRouteSegmentDistance(pIdx, dIdx, stopsList);
  const intermediateStops = dIdx - pIdx;
  const inRideSec = (totalMeters / speedMps) + (intermediateStops * DWELL_SEC);

  return {
    distanceMeters: totalMeters,
    distanceKm: (totalMeters / 1000).toFixed(1),
    rideDurationSec: inRideSec,
    rideDuration: formatEtaTime(inRideSec),
    totalStops: intermediateStops + 1
  };
}

function checkLegLiveAvailability(routeKey, direction, maxStopIdx, stops) {
  if (!stops || stops.length === 0) return false;
  return Object.values(activeBuses).some(b => {
    const isLine = normalizeStr(b.routeKey || b.route).includes(normalizeStr(routeKey)) || normalizeStr(routeKey).includes(normalizeStr(b.routeKey || b.route));
    const isDir = (b.busDir === direction);
    if (!isLine || !isDir) return false;
    const bIdx = findBusNearestStopIndex(b.lat, b.lng, stops);
    return maxStopIdx === -1 || bIdx <= maxStopIdx;
  });
}

// ==========================================
// 4-TIER DIRECTION DETECTION (STABILIZED)
// ==========================================
function updateBusDirectionFromMovement(busPlate, newLat, newLng, newHeading, newSpeedKmph, payloadDir, routeConfig) {
  // 1. Hardware Override
  if (payloadDir && (payloadDir.toUpperCase() === "UP" || payloadDir.toUpperCase() === "DOWN")) {
    return payloadDir.toUpperCase();
  }

  const prev = activeBuses[busPlate];
  if (!routeConfig) return prev ? (prev.busDir || "UP") : "UP";

  const fStops = routeConfig.forwardStops || [];
  const rStops = routeConfig.returnStops || [];

  // 2. Terminal Geofence Lock (Prevents flipping when parked at ends of the line)
  if (fStops.length > 0 && rStops.length > 0 && newSpeedKmph < 10.0) {
    const dToUpStart = getDistanceMeters(newLat, newLng, fStops[0].lat, fStops[0].lng);
    const dToDownStart = getDistanceMeters(newLat, newLng, rStops[0].lat, rStops[0].lng);
    
    if (dToUpStart < 300) return "UP";    // Locked to Start Terminal
    if (dToDownStart < 300) return "DOWN";  // Locked to End Terminal
  }

  // 3. Stop Progression Logic (Guarded against stationary GPS drift)
  if (prev && fStops.length > 0) {
    const moved = getDistanceMeters(prev.lat, prev.lng, newLat, newLng);
    // Only evaluate stop progression if the bus actually moved 30+ meters AND is traveling at least 3 km/h
    if (moved >= 30.0 && newSpeedKmph >= 3.0) {
      const prevIdx = findBusNearestStopIndex(prev.lat, prev.lng, fStops);
      const currIdx = findBusNearestStopIndex(newLat, newLng, fStops);
      if (currIdx > prevIdx) return "UP";
      if (currIdx < prevIdx) return "DOWN";
    }
  }

  // 4. Heading Fallback
  if (newSpeedKmph >= 3.0 && newHeading !== undefined && newHeading !== null && newHeading >= 0) {
    if (newHeading >= 15 && newHeading <= 165) return "UP";
    if (newHeading >= 195 && newHeading <= 345) return "DOWN";
  }

  // 5. State Retention
  if (prev && prev.busDir) {
    return prev.busDir;
  }

  // 6. Global Proximity Fallback
  if (fStops.length > 0 && rStops.length > 0) {
    const dToUpStart = getDistanceMeters(newLat, newLng, fStops[0].lat, fStops[0].lng);
    const dToDownStart = getDistanceMeters(newLat, newLng, rStops[0].lat, rStops[0].lng);
    return dToUpStart < dToDownStart ? "UP" : "DOWN";
  }

  return "UP";
}

function scrollTableToActiveRow(force = false) {
  if (!isTrackingConfirmed && !force) return;
  if (hasAutoScrolledForCurrentTrip && !force) return;

  setTimeout(() => {
    const activeRow = document.querySelector(".active-target-stop");
    if (activeRow) {
      activeRow.scrollIntoView({ behavior: "smooth", block: "nearest" });
      hasAutoScrolledForCurrentTrip = true;
    }
  }, 80);
}

// ==========================================
// 3. AUTOCOMPLETE & INPUT HANDLERS
// ==========================================
function getAllUniqueStops() {
  const mapUnique = new Map();
  if (!window.ROUTES_DATABASE) return [];

  Object.values(window.ROUTES_DATABASE).forEach(r => {
    [...(r.forwardStops || []), ...(r.returnStops || [])].forEach(s => {
      const norm = normalizeStr(s.name);
      if (!mapUnique.has(norm)) {
        mapUnique.set(norm, s);
      }
    });
  });
  return Array.from(mapUnique.values());
}

function setupStopAutocomplete(inputId, dropdownId, type) {
  const input = document.getElementById(inputId);
  const dropdown = document.getElementById(dropdownId);
  const clearBtn = document.getElementById(type === 'pickup' ? 'pickup-clear' : 'dest-clear');

  function render(matches) {
    dropdown.innerHTML = '';
    if (matches.length === 0) {
      dropdown.innerHTML = `<li class="p-3 text-xs text-slate-400 text-center">No matching bus stops</li>`;
      dropdown.classList.remove('hidden');
      return;
    }

    matches.forEach(stop => {
      const li = document.createElement('li');
      li.className = 'px-3.5 py-2.5 hover:bg-[#00ABE4]/5 cursor-pointer flex items-center gap-3 transition-colors';
      const iconColor = type === 'pickup' ? 'text-[#10B981] bg-[#10B981]/10' : 'text-[#00ABE4]/70 bg-[#00ABE4]/10';
      const isFav = savedPlaces.favorites.some(f => normalizeStr(f.name) === normalizeStr(stop.name));

      li.innerHTML = `
        <div class="w-7 h-7 rounded-lg ${iconColor} flex items-center justify-center shrink-0">
          <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>
        </div>
        <div class="min-w-0 flex-1">
          <div class="text-xs sm:text-sm font-semibold text-slate-800 truncate">${stop.name}</div>
          <div class="text-[10px] sm:text-xs text-slate-400 truncate">${stop.area || 'Bus Stop'}</div>
        </div>
        <button class="stop-fav-btn shrink-0 w-7 h-7 rounded-full hover:bg-[#00ABE4]/10 flex items-center justify-center transition-colors ${isFav ? 'is-fav text-[#00ABE4]' : 'text-slate-300'}" onclick='event.stopPropagation(); toggleFavoriteStopByName(${JSON.stringify(stop.name)}, this);' title="${isFav ? 'Remove from Favorites' : 'Add to Favorites'}">
          <i data-lucide="star" class="w-3.5 h-3.5"></i>
        </button>
      `;

      li.addEventListener('click', () => {
        input.value = stop.name;
        dropdown.classList.add('hidden');
        clearBtn.classList.remove('hidden');
        if (type === 'pickup') selectedPickupStop = stop;
        else selectedDestStop = stop;
      });

      dropdown.appendChild(li);
    });

    dropdown.classList.remove('hidden');
    lucide.createIcons();
  }

  input.addEventListener('input', (e) => {
    const rawQ = e.target.value.trim();
    const qNorm = normalizeStr(rawQ);
    clearBtn.classList.toggle('hidden', !rawQ);
    if (!qNorm) { dropdown.classList.add('hidden'); return; }

    const allStops = getAllUniqueStops();
    const matches = allStops.filter(s => 
      normalizeStr(s.name).includes(qNorm) || (s.area && normalizeStr(s.area).includes(qNorm))
    );
    render(matches);
  });

  input.addEventListener('focus', () => {
    const rawQ = input.value.trim();
    const qNorm = normalizeStr(rawQ);
    const allStops = getAllUniqueStops();
    const matches = qNorm
      ? allStops.filter(s => normalizeStr(s.name).includes(qNorm) || (s.area && normalizeStr(s.area).includes(qNorm)))
      : allStops.slice(0, 6);
    render(matches);
  });

  document.addEventListener('click', (e) => {
    if (!input.contains(e.target) && !dropdown.contains(e.target)) dropdown.classList.add('hidden');
  });
}

setupStopAutocomplete('pickup-input', 'pickup-results', 'pickup');
setupStopAutocomplete('dest-input', 'dest-results', 'dest');

function clearInput(type) {
  if (type === 'pickup') {
    document.getElementById('pickup-input').value = '';
    document.getElementById('pickup-clear').classList.add('hidden');
    selectedPickupStop = null;
  } else {
    document.getElementById('dest-input').value = '';
    document.getElementById('dest-clear').classList.add('hidden');
    selectedDestStop = null;
  }
  cancelTracking();
}

function swapPickupAndDestination() {
  const pickupInput = document.getElementById('pickup-input');
  const destInput = document.getElementById('dest-input');
  const pickupClear = document.getElementById('pickup-clear');
  const destClear = document.getElementById('dest-clear');
  const swapIcon = document.getElementById('swapIcon');

  if (swapIcon) {
    swapIcon.classList.toggle('rotate-180');
  }

  const tempVal = pickupInput.value;
  pickupInput.value = destInput.value;
  destInput.value = tempVal;

  const tempStop = selectedPickupStop;
  selectedPickupStop = selectedDestStop;
  selectedDestStop = tempStop;

  pickupClear.classList.toggle('hidden', !pickupInput.value);
  destClear.classList.toggle('hidden', !destInput.value);

  busNearestStopIdx = 0;
  selectedBusPlate = null;

  if (pickupInput.value && destInput.value) {
    handleSearchClick();
  } else {
    cancelTracking();
  }
}

function showQuickToast(message, durationMs = 2800) {
  let toast = document.getElementById('quickToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'quickToast';
    toast.className = 'fixed left-1/2 -translate-x-1/2 top-3 z-[70] max-w-[92vw] sm:max-w-sm text-center bg-slate-900 text-white text-[11px] sm:text-xs font-semibold px-4 py-2.5 rounded-full shadow-2xl opacity-0 pointer-events-none transition-opacity duration-300';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.opacity = '1';
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => { toast.style.opacity = '0'; }, durationMs);
}

function loadSavedPlaces() {
  try {
    const raw = localStorage.getItem(SAVED_PLACES_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      savedPlaces.home = parsed.home || null;
      savedPlaces.work = parsed.work || null;
      savedPlaces.favorites = Array.isArray(parsed.favorites) ? parsed.favorites : [];
    }
  } catch (e) {}
  refreshQuickChipsUI();
}

function persistSavedPlaces() {
  try {
    localStorage.setItem(SAVED_PLACES_STORAGE_KEY, JSON.stringify(savedPlaces));
  } catch (e) {}
}

function refreshQuickChipsUI() {
  const activeClass = "flex items-center justify-center gap-1.5 py-2 rounded-xl border border-[#00ABE4]/40 bg-[#00ABE4]/10 text-[#0091C2] text-[11px] sm:text-xs font-bold transition-colors active:scale-[0.97]";
  const inactiveClass = "flex items-center justify-center gap-1.5 py-2 rounded-xl border border-slate-200 bg-white hover:bg-[#00ABE4]/5 hover:border-[#00ABE4]/30 text-slate-700 text-[11px] sm:text-xs font-bold transition-colors active:scale-[0.97]";

  const homeBtn = document.getElementById('chipHome');
  const workBtn = document.getElementById('chipWork');
  if (homeBtn) homeBtn.className = savedPlaces.home ? activeClass : inactiveClass;
  if (workBtn) workBtn.className = savedPlaces.work ? activeClass : inactiveClass;
}

function startChipHold(kind) {
  chipHoldFired = false;
  clearTimeout(chipHoldTimer);
  chipHoldTimer = setTimeout(() => {
    chipHoldFired = true;
    saveCurrentLocationAs(kind);
  }, CHIP_HOLD_MS);
}

function cancelChipHold() {
  clearTimeout(chipHoldTimer);
}

function saveCurrentLocationAs(kind) {
  const label = kind === 'home' ? 'Home' : 'Work';

  if (!navigator.geolocation) {
    showQuickToast("Geolocation isn't supported on this device/browser.");
    return;
  }

  showQuickToast(`📍 Getting your location to save as ${label}...`);

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      const allStops = getAllUniqueStops();
      if (!allStops.length) return;

      let nearest = allStops[0];
      let minDist = getDistanceMeters(latitude, longitude, nearest.lat, nearest.lng);
      for (const s of allStops) {
        const d = getDistanceMeters(latitude, longitude, s.lat, s.lng);
        if (d < minDist) { minDist = d; nearest = s; }
      }

      savedPlaces[kind] = { name: nearest.name, lat: nearest.lat, lng: nearest.lng };
      persistSavedPlaces();
      refreshQuickChipsUI();

      const input = document.getElementById('pickup-input');
      input.value = nearest.name;
      document.getElementById('pickup-clear').classList.remove('hidden');
      selectedPickupStop = nearest;

      showQuickToast(`Saved "${nearest.name}" as ${label} pickup`);
    },
    () => {
      showQuickToast("Couldn't access your location. Please check browser permissions.");
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

function useQuickLocation(kind) {
  if (chipHoldFired) { chipHoldFired = false; return; }
  const label = kind === 'home' ? 'Home' : 'Work';
  const place = savedPlaces[kind];

  if (!place) {
    showQuickToast(`No ${label} saved yet. Hold this button to save your current location as ${label}.`);
    return;
  }

  const pickupInput = document.getElementById('pickup-input');
  pickupInput.value = place.name;
  document.getElementById('pickup-clear').classList.remove('hidden');
  selectedPickupStop = place;
  showQuickToast(`Pickup set to ${label}: ${place.name}`);
}

function toggleFavoritesDropdown() {
  const dropdown = document.getElementById('favoritesDropdown');
  if (!dropdown) return;
  if (dropdown.classList.contains('hidden')) {
    renderFavoritesDropdown();
    dropdown.classList.remove('hidden');
  } else {
    dropdown.classList.add('hidden');
  }
}

function renderFavoritesDropdown() {
  const dropdown = document.getElementById('favoritesDropdown');
  if (!dropdown) return;

  if (!savedPlaces.favorites.length) {
    dropdown.innerHTML = `<li class="p-3 text-[11px] text-slate-400 text-center leading-snug">No favorites yet.<br>Tap the ⭐ on any searched stop to save it here.</li>`;
    return;
  }

  dropdown.innerHTML = savedPlaces.favorites.map((f, idx) => `
    <li class="px-3 py-2.5 hover:bg-[#00ABE4]/5 cursor-pointer flex items-center gap-2.5 transition-colors" onclick="selectFavorite(${idx})">
      <div class="w-6 h-6 rounded-lg bg-[#00ABE4]/10 text-[#00ABE4] flex items-center justify-center shrink-0">
        <i data-lucide="star" class="w-3 h-3"></i>
      </div>
      <span class="flex-1 min-w-0 text-xs font-semibold text-slate-800 truncate">${f.name}</span>
      <button onclick="event.stopPropagation(); removeFavorite(${idx});" class="w-6 h-6 rounded-full hover:bg-[#00ABE4]/10 text-slate-300 hover:text-[#00ABE4] flex items-center justify-center shrink-0">
        <i data-lucide="x" class="w-3.5 h-3.5"></i>
      </button>
    </li>
  `).join('');
  lucide.createIcons();
}

function selectFavorite(idx) {
  const f = savedPlaces.favorites[idx];
  if (!f) return;
  const destInput = document.getElementById('dest-input');
  destInput.value = f.name;
  document.getElementById('dest-clear').classList.remove('hidden');
  selectedDestStop = f;
  document.getElementById('favoritesDropdown').classList.add('hidden');
  showQuickToast(`Destination set to ${f.name}`);
}

function removeFavorite(idx) {
  const removed = savedPlaces.favorites.splice(idx, 1)[0];
  persistSavedPlaces();
  renderFavoritesDropdown();
  if (removed) showQuickToast(`Removed "${removed.name}" from Favorites`);
}

function toggleFavoriteStop(stop, btnEl) {
  const existingIdx = savedPlaces.favorites.findIndex(f => normalizeStr(f.name) === normalizeStr(stop.name));
  let isFavNow;
  if (existingIdx >= 0) {
    savedPlaces.favorites.splice(existingIdx, 1);
    isFavNow = false;
    showQuickToast(`Removed "${stop.name}" from Favorites`);
  } else {
    savedPlaces.favorites.push({ name: stop.name, lat: stop.lat, lng: stop.lng });
    isFavNow = true;
    showQuickToast(`Added "${stop.name}" to Favorites`);
  }
  persistSavedPlaces();

  if (btnEl) {
    btnEl.classList.toggle('is-fav', isFavNow);
    btnEl.classList.toggle('text-[#00ABE4]', isFavNow);
    btnEl.classList.toggle('text-slate-300', !isFavNow);
    btnEl.title = isFavNow ? 'Remove from Favorites' : 'Add to Favorites';
  }
}

function toggleFavoriteStopByName(stopName, btnEl) {
  const stop = getAllUniqueStops().find(s => normalizeStr(s.name) === normalizeStr(stopName));
  if (!stop) return;
  toggleFavoriteStop(stop, btnEl);
}

document.addEventListener('click', (e) => {
  const dropdown = document.getElementById('favoritesDropdown');
  const chip = document.getElementById('chipFavorites');
  if (dropdown && !dropdown.classList.contains('hidden')) {
    if (!dropdown.contains(e.target) && chip && !chip.contains(e.target)) {
      dropdown.classList.add('hidden');
    }
  }
});

function useCurrentLocationAsPickup() {
  if (!navigator.geolocation) {
    showQuickToast("Geolocation isn't supported on this device/browser.");
    return;
  }

  const btn = document.getElementById('useCurrentLocationBtn');
  if (btn) btn.classList.add('animate-pulse');

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      if (btn) btn.classList.remove('animate-pulse');
      const { latitude, longitude } = pos.coords;
      const allStops = getAllUniqueStops();
      if (!allStops.length) return;

      let nearest = allStops[0];
      let minDist = getDistanceMeters(latitude, longitude, nearest.lat, nearest.lng);
      for (const s of allStops) {
        const d = getDistanceMeters(latitude, longitude, s.lat, s.lng);
        if (d < minDist) { minDist = d; nearest = s; }
      }

      const input = document.getElementById('pickup-input');
      input.value = nearest.name;
      document.getElementById('pickup-clear').classList.remove('hidden');
      selectedPickupStop = nearest;

      const distLabel = minDist >= 1000 ? `${(minDist / 1000).toFixed(1)} km` : `${Math.round(minDist)} m`;
      showQuickToast(`📍 Nearest stop: ${nearest.name} (${distLabel} away)`);
    },
    () => {
      if (btn) btn.classList.remove('animate-pulse');
      showQuickToast("Couldn't access your location. Please check browser permissions.");
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

loadSavedPlaces();

function toggleBottomSheet() {
  document.getElementById('bottomSheet').classList.toggle('open');
}

function openBottomSheet() {
  document.getElementById('bottomSheet').classList.add('open');
}

function closeBottomSheet() {
  const sheet = document.getElementById('bottomSheet');
  if (sheet && sheet.classList.contains('open')) {
    sheet.classList.remove('open');
  }
}

function initBottomSheetDrag() {
  const sheet = document.getElementById("bottomSheet");
  const handle = document.getElementById("sheetDragHandle");
  if (!sheet || !handle) return;

  let dragging = false;
  let startY = 0;
  let sheetHeight = 0;

  const getClientY = (e) => (e.touches && e.touches.length ? e.touches[0].clientY : e.clientY);

  function onDragStart(e) {
    if (!sheet.classList.contains("open")) return;
    dragging = true;
    startY = getClientY(e);
    sheetHeight = sheet.getBoundingClientRect().height;
    sheet.classList.add("dragging");
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragEnd);
    document.addEventListener("touchmove", onDragMove, { passive: false });
    document.addEventListener("touchend", onDragEnd);
  }

  function onDragMove(e) {
    if (!dragging) return;
    const deltaY = Math.max(0, getClientY(e) - startY);
    sheet.style.transform = `translateY(${deltaY}px)`;
    if (e.cancelable) e.preventDefault();
  }

  function onDragEnd(e) {
    if (!dragging) return;
    dragging = false;
    const endY = (e.changedTouches && e.changedTouches.length) ? e.changedTouches[0].clientY : e.clientY;
    const deltaY = Math.max(0, endY - startY);

    sheet.classList.remove("dragging");
    sheet.style.transform = "";

    if (sheetHeight > 0 && deltaY > sheetHeight * 0.25) {
      closeBottomSheet();
    }

    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", onDragEnd);
    document.removeEventListener("touchmove", onDragMove);
    document.removeEventListener("touchend", onDragEnd);
  }

  handle.addEventListener("mousedown", onDragStart);
  handle.addEventListener("touchstart", onDragStart, { passive: true });
}

initBottomSheetDrag();

// ==========================================
// 4. SMART BANNER & ROUTE MODAL
// ==========================================
function updateTripStatusBadge() {
  const connBadge = document.getElementById('connBadge');
  if (!connBadge) return;

  if (currentTripPlanType === "TRANSFER" && activeTransferPlan) {
    const hasLiveLeg1 = checkLegLiveAvailability(
      activeTransferPlan.leg1.routeKey,
      activeTransferPlan.leg1.direction,
      activeTransferPlan.leg1.pIdx,
      activeTransferPlan.leg1.stops
    );
    const hasLiveLeg2 = checkLegLiveAvailability(
      activeTransferPlan.leg2.routeKey,
      activeTransferPlan.leg2.direction,
      activeTransferPlan.leg2.tIdx,
      activeTransferPlan.leg2.stops
    );

    if (hasLiveLeg1 && hasLiveLeg2) {
      connBadge.className = "px-2 py-0.5 sm:py-1 rounded-full font-bold bg-[#10B981]/10 text-[#10B981] border border-[#10B981]/30 shadow-sm flex items-center gap-1 text-[11px] whitespace-nowrap shrink-0";
      connBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-[#10B981] animate-pulse"></span><span>Connected</span>`;
    } else if (hasLiveLeg1 || hasLiveLeg2) {
      connBadge.className = "px-2 py-0.5 sm:py-1 rounded-full font-bold bg-amber-50 text-amber-700 border border-amber-200 shadow-sm flex items-center gap-1 text-[11px] whitespace-nowrap shrink-0";
      connBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span><span>Partial Connected</span>`;
    } else {
      connBadge.className = "px-2 py-0.5 sm:py-1 rounded-full font-bold bg-slate-100 text-slate-600 border border-slate-200 shadow-sm flex items-center gap-1 text-[11px] whitespace-nowrap shrink-0";
      connBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-slate-400"></span><span>Scheduled</span>`;
    }
    return;
  }

  if (activeRouteKey && currentStopsList.length > 0) {
    const pIdx = selectedPickupStop ? findStopIndexInList(currentStopsList, selectedPickupStop) : -1;
    const hasLiveDirectBus = checkLegLiveAvailability(activeRouteKey, currentDirection, pIdx, currentStopsList);

    if (hasLiveDirectBus) {
      connBadge.className = "px-2 py-0.5 sm:py-1 rounded-full font-bold bg-[#10B981]/10 text-[#10B981] border border-[#10B981]/30 shadow-sm flex items-center gap-1 text-[11px] whitespace-nowrap shrink-0";
      connBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-[#10B981] animate-pulse"></span><span>Connected</span>`;
    } else {
      connBadge.className = "px-2 py-0.5 sm:py-1 rounded-full font-bold bg-slate-100 text-slate-600 border border-slate-200 shadow-sm flex items-center gap-1 text-[11px] whitespace-nowrap shrink-0";
      connBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-slate-400"></span><span>Scheduled</span>`;
    }
    return;
  }

  connBadge.className = "px-2 py-0.5 sm:py-1 rounded-full font-bold bg-slate-100 text-slate-600 border border-slate-200 shadow-sm flex items-center gap-1 text-[11px] whitespace-nowrap shrink-0";
  connBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-slate-400"></span><span>Scheduled</span>`;
}

function updateDirectionBannerText() {
  const labelElem = document.getElementById("currentDirectionLabel");
  if (!labelElem) return;

  if (currentTripPlanType === "TRANSFER" && activeTransferPlan) {
    const r1Name = window.ROUTES_DATABASE[activeTransferPlan.leg1.routeKey]?.name || "Bus 1";
    const r2Name = window.ROUTES_DATABASE[activeTransferPlan.leg2.routeKey]?.name || "Bus 2";
    labelElem.innerHTML = `
      <div class="flex items-center gap-1.5 flex-wrap">
        <span class="bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded text-[9px] font-extrabold shrink-0">1 TRANSFER</span>
        <span class="text-slate-900 font-bold">${r1Name}</span>
        <span class="text-slate-400">➔</span>
        <span class="text-sky-800 font-bold">Change at ${activeTransferPlan.transferStopName}</span>
        <span class="text-slate-400">➔</span>
        <span class="text-slate-900 font-bold">${r2Name}</span>
      </div>
    `;
    lucide.createIcons();
    updateTripStatusBadge();
    return;
  }

  if (activeMatchingRoutes.length > 1 && selectedPickupStop && selectedDestStop) {
    const totalLines = activeMatchingRoutes.length;
    labelElem.innerHTML = `
      <div class="flex items-center gap-1.5 flex-wrap">
        <button onclick="openLinesModal()" class="bg-sky-100 hover:bg-sky-200 active:scale-95 text-sky-800 px-2 py-0.5 rounded-lg text-[9px] font-extrabold shrink-0 flex items-center gap-1 border border-sky-200 transition-all cursor-pointer shadow-sm">
          <span>${totalLines} LINES</span>
          <i data-lucide="chevron-right" class="w-3 h-3"></i>
        </button>
        <div class="flex items-center gap-1 text-xs font-bold text-slate-800">
          <span>${selectedPickupStop.name}</span>
          <span class="text-[#00ABE4] font-bold">➔</span>
          <span>${selectedDestStop.name}</span>
        </div>
      </div>
    `;
    lucide.createIcons();
    updateTripStatusBadge();
    return;
  }

  if (!window.ROUTES_DATABASE || !activeRouteKey || !selectedPickupStop || !selectedDestStop) return;
  const routeConfig = window.ROUTES_DATABASE[activeRouteKey];
  if (!routeConfig) return;

  labelElem.innerHTML = `
    <div class="flex items-center gap-1.5 flex-wrap">
      <span class="text-slate-900 font-bold">${routeConfig.name}:</span> 
      <span class="text-slate-800 font-semibold">${selectedPickupStop.name}</span> 
      <span class="text-[#00ABE4] font-bold">➔</span> 
      <span class="text-slate-800 font-semibold">${selectedDestStop.name}</span>
    </div>
  `;
  updateTripStatusBadge();
}

function openLinesModal() {
  const modal = document.getElementById("linesModal");
  const listContainer = document.getElementById("linesModalList");
  if (!modal || !listContainer) return;

  listContainer.innerHTML = "";

  activeMatchingRoutes.forEach(r => {
    const config = window.ROUTES_DATABASE[r.routeKey];
    if (!config) return;

    const pIdx = findStopIndexInList(r.stops, selectedPickupStop);
    const isLive = checkLegLiveAvailability(r.routeKey, currentDirection, pIdx, r.stops);

    const parts = (config.subTitle || "").split(/<->|↔|->|-/).map(s => s.trim()).filter(Boolean);
    const startTerm = parts[0] || "";
    const endTerm = parts[1] || "";
    const lineDir = (currentDirection === "DOWN")
      ? `${endTerm} ➔ ${startTerm}`
      : `${startTerm} ➔ ${endTerm}`;

    const totalStopsCount = (currentDirection === "DOWN")
      ? (config.returnStops || []).length
      : (config.forwardStops || []).length;

    const card = document.createElement("div");
    card.className = "p-2.5 sm:p-3 rounded-2xl border border-slate-200/80 bg-slate-50/60 flex items-center justify-between gap-2 hover:border-[#00ABE4] transition-all";
    card.innerHTML = `
      <div class="flex items-center gap-2.5 sm:gap-3 min-w-0">
        <div class="px-2 py-1 rounded-xl bg-[#00ABE4]/10 text-[#0091C2] font-extrabold text-xs shrink-0 border border-[#00ABE4]/30 min-w-[50px] text-center">
          ${config.name}
        </div>
        <div class="min-w-0">
          <div class="text-xs font-bold text-slate-800">${lineDir}</div>
          <div class="text-[10px] text-slate-400 mt-0.5">${totalStopsCount} Total Route Stops</div>
        </div>
      </div>
      <div class="text-right shrink-0">
        ${isLive 
          ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-[#10B981]/10 text-[#10B981] border border-[#10B981]/30 inline-flex items-center gap-1 whitespace-nowrap">
               <span class="w-1.5 h-1.5 rounded-full bg-[#10B981] animate-pulse shrink-0"></span>Live Line
             </span>` 
          : `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-200/70 text-slate-500 whitespace-nowrap">Scheduled</span>`
        }
      </div>
    `;
    listContainer.appendChild(card);
  });

  modal.classList.remove("hidden");
  lucide.createIcons();
}

function closeLinesModal() {
  const modal = document.getElementById("linesModal");
  if (modal) modal.classList.add("hidden");
}

// ==========================================
// 5. DETERMINISTIC NO-BACKTRACK TRANSIT ROUTER
// ==========================================
function findMatchingRoutes(pName, dName) {
  let pNorm = normalizeStr(pName);
  let dNorm = normalizeStr(dName);
  const directMatches = [];
  const rawTransfers = [];

  if (!window.ROUTES_DATABASE) return { direct: [], transfers: [] };

  const allRouteKeys = Object.keys(window.ROUTES_DATABASE);

  // 1. Direct Routes Discovery
  for (const rKey of allRouteKeys) {
    const rObj = window.ROUTES_DATABASE[rKey];
    if (!rObj) continue;

    const fStops = rObj.forwardStops || [];
    const rStops = rObj.returnStops || [];
    
    const pUp = fStops.findIndex(s => normalizeStr(s.name).includes(pNorm) || pNorm.includes(normalizeStr(s.name)) || (s.area && normalizeStr(s.area).includes(pNorm)));
    const dUp = fStops.findIndex(s => normalizeStr(s.name).includes(dNorm) || dNorm.includes(normalizeStr(s.name)) || (s.area && normalizeStr(s.area).includes(dNorm)));
    if (pUp !== -1 && dUp !== -1 && pUp < dUp) {
      directMatches.push({ type: 'DIRECT', routeKey: rKey, direction: "UP", stops: fStops, pIdx: pUp, dIdx: dUp });
    }

    const pDown = rStops.findIndex(s => normalizeStr(s.name).includes(pNorm) || pNorm.includes(normalizeStr(s.name)) || (s.area && normalizeStr(s.area).includes(pNorm)));
    const dDown = rStops.findIndex(s => normalizeStr(s.name).includes(dNorm) || dNorm.includes(normalizeStr(s.name)) || (s.area && normalizeStr(s.area).includes(dNorm)));
    if (pDown !== -1 && dDown !== -1 && pDown < dDown) {
      directMatches.push({ type: 'DIRECT', routeKey: rKey, direction: "DOWN", stops: rStops, pIdx: pDown, dIdx: dDown });
    }
  }

  // 2. 1-Transfer Discovery
  for (const r1Key of allRouteKeys) {
    const r1 = window.ROUTES_DATABASE[r1Key];
    if (!r1) continue;

    const directions1 = [
      { dir: "UP", stops: r1.forwardStops || [] },
      { dir: "DOWN", stops: r1.returnStops || [] }
    ];

    for (const leg1 of directions1) {
      let pIdx = leg1.stops.findIndex(s => normalizeStr(s.name).includes(pNorm) || pNorm.includes(normalizeStr(s.name)) || (s.area && normalizeStr(s.area).includes(pNorm)));
      if (pIdx === -1) continue;

      let d1Idx = leg1.stops.findIndex(s => normalizeStr(s.name).includes(dNorm) || dNorm.includes(normalizeStr(s.name)) || (s.area && normalizeStr(s.area).includes(dNorm)));
      if (d1Idx !== -1 && pIdx < d1Idx) continue;

      const pStop = leg1.stops[pIdx];

      for (const r2Key of allRouteKeys) {
        if (r2Key === r1Key) continue;
        const r2 = window.ROUTES_DATABASE[r2Key];
        if (!r2) continue;

        const directions2 = [
          { dir: "UP", stops: r2.forwardStops || [] },
          { dir: "DOWN", stops: r2.returnStops || [] }
        ];

        for (const leg2 of directions2) {
          let d2Idx = leg2.stops.findIndex(s => normalizeStr(s.name).includes(dNorm) || dNorm.includes(normalizeStr(s.name)) || (s.area && normalizeStr(s.area).includes(dNorm)));
          if (d2Idx === -1) continue;

          // Note: directP2Idx check has been removed here to allow "Leapfrog" partial live transfers.

          const dStop = leg2.stops[d2Idx];
          const distPickupToDest = getDistanceMeters(pStop.lat, pStop.lng, dStop.lat, dStop.lng);
          const isSameDir = (leg1.dir === leg2.dir);
          const commonStops = [];

          for (let tIdx = pIdx + 1; tIdx < leg1.stops.length; tIdx++) {
            const transferStop = leg1.stops[tIdx];
            const tNorm = normalizeStr(transferStop.name);

            const t2Idx = leg2.stops.findIndex(s => normalizeStr(s.name).includes(tNorm) || tNorm.includes(normalizeStr(s.name)) || (s.area && normalizeStr(s.area).includes(tNorm)));

            if (t2Idx !== -1 && t2Idx < d2Idx) {
              const distLeg1 = getDistanceMeters(pStop.lat, pStop.lng, transferStop.lat, transferStop.lng);
              const distLeg2 = getDistanceMeters(transferStop.lat, transferStop.lng, dStop.lat, dStop.lng);
              const totalTransferDist = distLeg1 + distLeg2;

              const isSensibleDetour = totalTransferDist <= Math.max(distPickupToDest * 2.2, 14000);

              if (isSensibleDetour) {
                commonStops.push({
                  transferStopName: transferStop.name,
                  tIdx: tIdx,
                  t2Idx: t2Idx,
                  totalDist: totalTransferDist,
                  leg1StopsCount: tIdx - pIdx,
                  leg2StopsCount: d2Idx - t2Idx
                });
              }
            }
          }

          if (commonStops.length > 0) {
            let bestTransfer;

            if (isSameDir) {
              const minTotalDist = Math.min(...commonStops.map(s => s.totalDist));
              const corridorOptions = commonStops.filter(s => s.totalDist <= minTotalDist + 1500);
              corridorOptions.sort((a, b) => b.tIdx - a.tIdx || a.totalDist - b.totalDist);
              bestTransfer = corridorOptions[0] || commonStops[0];
            } else {
              commonStops.sort((a, b) => a.tIdx - b.tIdx || a.totalDist - b.totalDist);
              bestTransfer = commonStops[0];
            }

            const isLeg1Live = checkLegLiveAvailability(r1Key, leg1.dir, pIdx, leg1.stops);
            const isLeg2Live = checkLegLiveAvailability(r2Key, leg2.dir, bestTransfer.t2Idx, leg2.stops);

            rawTransfers.push({
              type: 'TRANSFER',
              transferStopName: bestTransfer.transferStopName,
              totalDist: bestTransfer.totalDist,
              leg1StopsCount: bestTransfer.leg1StopsCount,
              hasLiveLeg1: isLeg1Live,
              hasLiveLeg2: isLeg2Live,
              isAllLive: (isLeg1Live && isLeg2Live),
              leg1: {
                routeKey: r1Key,
                direction: leg1.dir,
                stops: leg1.stops,
                pickupStop: leg1.stops[pIdx],
                transferStop: leg1.stops[bestTransfer.tIdx],
                pIdx: pIdx,
                tIdx: bestTransfer.tIdx
              },
              leg2: {
                routeKey: r2Key,
                direction: leg2.dir,
                stops: leg2.stops,
                transferStop: leg2.stops[bestTransfer.t2Idx],
                destStop: leg2.stops[d2Idx],
                tIdx: bestTransfer.t2Idx,
                dIdx: d2Idx
              }
            });
          }
        }
      }
    }
  }

  const uniqueTransfersMap = new Map();
  rawTransfers.forEach(plan => {
    const key = `${normalizeStr(plan.leg1.routeKey)}_${normalizeStr(plan.leg2.routeKey)}_${normalizeStr(plan.transferStopName)}`;
    if (!uniqueTransfersMap.has(key) || (plan.hasLiveLeg1 && !uniqueTransfersMap.get(key).hasLiveLeg1)) {
      uniqueTransfersMap.set(key, plan);
    }
  });

  const candidateTransfers = Array.from(uniqueTransfersMap.values());
  candidateTransfers.sort((a, b) => {
    const liveScoreA = (a.isAllLive ? 3 : (a.hasLiveLeg1 ? 2 : 0));
    const liveScoreB = (b.isAllLive ? 3 : (b.hasLiveLeg1 ? 2 : 0));
    return liveScoreB - liveScoreA || a.totalDist - b.totalDist;
  });

  return { direct: directMatches, transfers: candidateTransfers.slice(0, 2) };
}

function handleSearchClick() {
  const pickVal = document.getElementById("pickup-input").value.trim();
  const destVal = document.getElementById("dest-input").value.trim();

  if (!pickVal || !destVal) {
    alert("Please select both Pickup and Destination stops!");
    return;
  }

  shouldResetScrollOnNextRender = true;
  lastSearchResult = findMatchingRoutes(pickVal, destVal);
  busNearestStopIdx = 0;
  selectedBusPlate = null;

  const hasDirect = lastSearchResult.direct && lastSearchResult.direct.length > 0;
  const hasTransfers = lastSearchResult.transfers && lastSearchResult.transfers.length > 0;

  if (!hasDirect && !hasTransfers) {
    alert("No direct or connecting route found between these locations in this direction.");
    return;
  }

  if (window.innerWidth < 768) {
    switchMobileTab('buses');
  }

  let liveDirectIdx = -1;
  if (hasDirect) {
    liveDirectIdx = lastSearchResult.direct.findIndex(r => {
      const pIdx = findStopIndexInList(r.stops, pickVal);
      return checkLegLiveAvailability(r.routeKey, r.direction, pIdx, r.stops);
    });
  }

  let allLiveTransferIdx = -1;
  if (hasTransfers) {
    allLiveTransferIdx = lastSearchResult.transfers.findIndex(t => t.isAllLive);
  }

  let partialLiveTransferIdx = -1;
  if (hasTransfers) {
    partialLiveTransferIdx = lastSearchResult.transfers.findIndex(t => t.hasLiveLeg1);
  }

  if (liveDirectIdx !== -1) {
    selectDirectOption(liveDirectIdx, false);
  } else if (allLiveTransferIdx !== -1) {
    selectTransferOption(allLiveTransferIdx, false);
  } else if (partialLiveTransferIdx !== -1) {
    selectTransferOption(partialLiveTransferIdx, false);
  } else if (hasDirect) {
    selectDirectOption(0, false);
  } else {
    selectTransferOption(0, false);
  }
}

function selectDirectOption(index = 0, maintainTracking = false) {
  if (!lastSearchResult || !lastSearchResult.direct[index]) return;
  const primary = lastSearchResult.direct[index];
  currentTripPlanType = "DIRECT";
  activeTransferPlan = null;
  activeMatchingRoutes = lastSearchResult.direct;
  activeRouteKey = primary.routeKey;
  currentDirection = primary.direction;
  currentStopsList = primary.stops;

  selectedPickupStop = currentStopsList[primary.pIdx];
  selectedDestStop = currentStopsList[primary.dIdx];

  if (!maintainTracking) cancelTracking();

  updateDirectionBannerText();
  updateTripSummaryUI();
  updateTripStatusBadge();
  openBottomSheet();

  const upcomingBuses = Object.values(activeBuses).filter(b => {
    const isLine = normalizeStr(b.routeKey || b.route).includes(normalizeStr(activeRouteKey)) || normalizeStr(activeRouteKey).includes(normalizeStr(b.routeKey || b.route));
    if (!isLine || b.busDir !== currentDirection) return false;
    const busCurrentIdx = findBusNearestStopIndex(b.lat, b.lng, currentStopsList);
    return busCurrentIdx <= primary.pIdx;
  });

  selectedBusPlate = upcomingBuses.length > 0 ? upcomingBuses[0].plate : null;

  if (isTrackingConfirmed) {
    renderRoutePins(true);
    if (selectedBusPlate && activeBuses[selectedBusPlate]) {
      const b = activeBuses[selectedBusPlate];
      updateStopsTable(b.lat, b.lng, b.spd);
    } else {
      renderSchedulePreview();
    }
  } else {
    document.getElementById("stopsTimeline")?.classList.add("hidden");
    document.getElementById("noTrackPlaceholder")?.classList.remove("hidden");
  }

  updateAvailableBusesList();
}

function selectTransferOption(index = 0, maintainTracking = false) {
  if (!lastSearchResult || !lastSearchResult.transfers[index]) return;
  activeTransferPlan = lastSearchResult.transfers[index];
  currentTripPlanType = "TRANSFER";
  activeMatchingRoutes = [{ routeKey: activeTransferPlan.leg1.routeKey, direction: activeTransferPlan.leg1.direction, stops: activeTransferPlan.leg1.stops }];
  activeRouteKey = activeTransferPlan.leg1.routeKey;
  currentDirection = activeTransferPlan.leg1.direction;
  currentStopsList = activeTransferPlan.leg1.stops;

  selectedPickupStop = activeTransferPlan.leg1.pickupStop;
  selectedDestStop = activeTransferPlan.leg2.destStop;

  if (!maintainTracking) cancelTracking();

  updateDirectionBannerText();
  updateTripSummaryUI();
  updateTripStatusBadge();
  openBottomSheet();

  const upcomingLeg1Buses = Object.values(activeBuses).filter(b => {
    const isLine = normalizeStr(b.routeKey || b.route).includes(normalizeStr(activeTransferPlan.leg1.routeKey)) || normalizeStr(activeTransferPlan.leg1.routeKey).includes(normalizeStr(b.routeKey || b.route));
    if (!isLine || b.busDir !== activeTransferPlan.leg1.direction) return false;
    const bIdx = findBusNearestStopIndex(b.lat, b.lng, activeTransferPlan.leg1.stops);
    return bIdx <= activeTransferPlan.leg1.pIdx;
  });

  selectedBusPlate = upcomingLeg1Buses.length > 0 ? upcomingLeg1Buses[0].plate : null;

  if (isTrackingConfirmed) {
    renderRoutePins(true);
    if (selectedBusPlate && activeBuses[selectedBusPlate]) {
      const b = activeBuses[selectedBusPlate];
      updateStopsTable(b.lat, b.lng, b.spd);
    } else {
      renderSchedulePreview();
    }
  } else {
    document.getElementById("stopsTimeline")?.classList.add("hidden");
    document.getElementById("noTrackPlaceholder")?.classList.remove("hidden");
  }

  updateAvailableBusesList();
}

function updateTripSummaryUI() {
  if (!selectedPickupStop || !selectedDestStop) return;

  if (currentTripPlanType === "TRANSFER" && activeTransferPlan) {
    const leg1Count = activeTransferPlan.leg1.tIdx - activeTransferPlan.leg1.pIdx + 1;
    const leg2Count = activeTransferPlan.leg2.dIdx - activeTransferPlan.leg2.tIdx;
    const totalStops = leg1Count + leg2Count;

    const s1 = calculateTripSummary(activeTransferPlan.leg1.pickupStop, activeTransferPlan.leg1.transferStop, activeTransferPlan.leg1.stops);
    const s2 = calculateTripSummary(activeTransferPlan.leg2.transferStop, activeTransferPlan.leg2.destStop, activeTransferPlan.leg2.stops);
    
    const totalDist = (((s1?.distanceMeters || 0) + (s2?.distanceMeters || 0)) / 1000).toFixed(1);
    const totalDurationSec = (s1?.rideDurationSec || 0) + (s2?.rideDurationSec || 0) + (5 * 60);

    document.getElementById("tripDistText").innerText = `${totalDist} km`;
    document.getElementById("tripDurationText").innerText = `~${formatEtaTime(totalDurationSec)}`;
    document.getElementById("tripStatsPill").classList.remove("hidden");
    document.getElementById("journeyStopsCount").innerText = `(${totalStops} stops, 1 Transfer)`;
    updateTripStatusBadge();
    return;
  }

  if (!currentStopsList.length) return;

  const summary = calculateTripSummary(selectedPickupStop, selectedDestStop, currentStopsList);
  if (summary) {
    document.getElementById("tripDistText").innerText = `${summary.distanceKm} km`;
    document.getElementById("tripDurationText").innerText = `${summary.rideDuration} in-ride`;
    document.getElementById("tripStatsPill").classList.remove("hidden");
    
    const pIdx = findStopIndexInList(currentStopsList, selectedPickupStop);
    const approachingCount = (busNearestStopIdx > 0 && busNearestStopIdx < pIdx) ? (pIdx - busNearestStopIdx) : 0;
    
    if (approachingCount > 0) {
      document.getElementById("journeyStopsCount").innerText = `(${summary.totalStops} stops • ${approachingCount} incoming)`;
    } else {
      document.getElementById("journeyStopsCount").innerText = `(${summary.totalStops} stops)`;
    }
  }

  updateTripStatusBadge();
}

function startTracking() {
  if (!selectedPickupStop || !selectedDestStop) {
    alert("Please select your stops and click Find Buses first!");
    return;
  }

  hasAutoScrolledForCurrentTrip = false;
  isTrackingConfirmed = true;
  
  document.getElementById("stopsTimeline")?.classList.remove("hidden");
  document.getElementById("noTrackPlaceholder")?.classList.add("hidden");

  updateDirectionBannerText();
  document.getElementById("activeTripBar").classList.remove("hidden");
  
  renderRoutePins(true);
  updateAvailableBusesList();
  updateTripStatusBadge();

  if (window.innerWidth < 768) {
    switchMobileTab('schedule');
  }

  if (selectedBusPlate && activeBuses[selectedBusPlate]) {
    const b = activeBuses[selectedBusPlate];
    updateStopsTable(b.lat, b.lng, b.spd);
  } else {
    renderSchedulePreview();
  }
}

function cancelTracking() {
  isTrackingConfirmed = false;

  document.getElementById("stopsTimeline")?.classList.add("hidden");
  document.getElementById("noTrackPlaceholder")?.classList.remove("hidden");

  document.getElementById("activeTripBar").classList.add("hidden");
  document.getElementById("floatingBusCard").classList.add("hidden");
  document.getElementById("tripStatsPill").classList.add("hidden");
  
  renderRoutePins(false);
  updateAvailableBusesList();
  updateTripStatusBadge();

  if (window.innerWidth < 768) {
    switchMobileTab('buses');
  }
}

// ==========================================
// 6. TIMELINE PREVIEW & RENDERING (CUMULATIVE BOARDING DISTANCE)
// ==========================================
function renderSchedulePreview() {
  if (!isTrackingConfirmed) {
    document.getElementById("stopsTimeline")?.classList.add("hidden");
    document.getElementById("noTrackPlaceholder")?.classList.remove("hidden");
    return;
  }

  document.getElementById("stopsTimeline")?.classList.remove("hidden");
  document.getElementById("noTrackPlaceholder")?.classList.add("hidden");

  const rowsHtml = [];

  if (currentTripPlanType === "TRANSFER" && activeTransferPlan) {
    const leg1Stops = activeTransferPlan.leg1.stops.slice(activeTransferPlan.leg1.pIdx, activeTransferPlan.leg1.tIdx + 1);
    const leg2Stops = activeTransferPlan.leg2.stops.slice(activeTransferPlan.leg2.tIdx + 1, activeTransferPlan.leg2.dIdx + 1);

    const r1Name = window.ROUTES_DATABASE[activeTransferPlan.leg1.routeKey]?.name || "Bus 1";
    const r2Name = window.ROUTES_DATABASE[activeTransferPlan.leg2.routeKey]?.name || "Bus 2";

    leg1Stops.forEach((stop, idx) => {
      const actualStopIdx = activeTransferPlan.leg1.pIdx + idx;
      const isBoarding = (idx === 0);
      const isTransferPoint = (idx === leg1Stops.length - 1);
      
      const metersFromPickup = calculateRouteSegmentDistance(activeTransferPlan.leg1.pIdx, actualStopIdx, activeTransferPlan.leg1.stops);
      const distLabel = isBoarding ? "0.0 km" : `${(metersFromPickup / 1000).toFixed(1)} km from pickup`;

      let dotState = "normal", badge = { text: r1Name, cls: "text-sky-700" };
      let statusText = "Scheduled", statusClass = "text-slate-400", active = false;

      if (isBoarding) {
        dotState = "boarding"; active = true;
        badge = { text: `Boarding • ${r1Name}`, cls: "text-[#059669]" };
        statusText = "Now"; statusClass = "text-[#10B981] font-extrabold";
      } else if (isTransferPoint) {
        dotState = "transfer";
        badge = { text: `Transfer • ${r1Name}`, cls: "text-[#0091C2]" };
        statusText = "Switch buses"; statusClass = "text-[#00ABE4] font-extrabold";
      } else {
        statusText = `${leg1Stops.length - 1 - idx} left`;
      }

      rowsHtml.push(tlRow({ name: stop.name, badge, subLabel: distLabel, timeLabel: "--:--", statusText, statusClass, dotState, dim: false, active }));
    });

    rowsHtml.push(tlDivider(`Switch to <b>${r2Name}</b> towards ${selectedDestStop.name}`));

    leg2Stops.forEach((stop, idx) => {
      const actualStopIdx = activeTransferPlan.leg2.tIdx + 1 + idx;
      const isFinal = (idx === leg2Stops.length - 1);
      
      const metersFromTransfer = calculateRouteSegmentDistance(activeTransferPlan.leg2.tIdx, actualStopIdx, activeTransferPlan.leg2.stops);
      const distLabel = `${(metersFromTransfer / 1000).toFixed(1)} km from transfer`;

      let badge = { text: r2Name, cls: "text-amber-700" };
      let dotState = isFinal ? "destination" : "normal";
      let statusText = isFinal ? "0 left" : `${leg2Stops.length - 1 - idx} left`;
      let statusClass = isFinal ? "text-rose-600 font-extrabold" : "text-slate-400";
      if (isFinal) badge = { text: `Destination • ${r2Name}`, cls: "text-rose-700" };

      rowsHtml.push(tlRow({ name: stop.name, badge, subLabel: distLabel, timeLabel: "--:--", statusText, statusClass, dotState, dim: false, active: false }));
    });

    setTimelineHTML(rowsHtml);
    scrollTableToActiveRow();
    return;
  }

  const pIdx = selectedPickupStop ? findStopIndexInList(currentStopsList, selectedPickupStop) : 0;
  const dIdx = selectedDestStop ? findStopIndexInList(currentStopsList, selectedDestStop) : currentStopsList.length - 1;

  const validP = (pIdx !== -1) ? pIdx : 0;
  const validD = (dIdx !== -1 && dIdx >= validP) ? dIdx : currentStopsList.length - 1;
  const journeyStops = currentStopsList.slice(validP, validD + 1);
  const rName = window.ROUTES_DATABASE[activeRouteKey]?.name || "Direct";

  journeyStops.forEach((stop, idx) => {
    const actualStopIdx = validP + idx;
    const isBoarding = (idx === 0);
    const isFinal = (idx === journeyStops.length - 1);
    
    const metersFromPickup = calculateRouteSegmentDistance(validP, actualStopIdx, currentStopsList);
    const distLabel = isBoarding ? "0.0 km" : `${(metersFromPickup / 1000).toFixed(1)} km from pickup`;

    let dotState = "normal", statusText = "Scheduled", statusClass = "text-slate-400", active = false, badge = { text: rName, cls: "text-sky-700" };

    if (isBoarding) {
      dotState = "boarding"; active = true; badge = { text: `Boarding • ${rName}`, cls: "text-[#059669]" };
      statusText = "Now"; statusClass = "text-[#10B981] font-extrabold";
    } else if (isFinal) {
      dotState = "destination"; badge = { text: `Destination • ${rName}`, cls: "text-rose-700" };
      statusText = "0 left"; statusClass = "text-rose-600 font-extrabold";
    } else {
      statusText = `${journeyStops.length - 1 - idx} left`;
    }

    rowsHtml.push(tlRow({ name: stop.name, badge, subLabel: distLabel, timeLabel: "--:--", statusText, statusClass, dotState, dim: false, active }));
  });

  setTimelineHTML(rowsHtml);
  scrollTableToActiveRow();
}

function renderRoutePins(autoFit = false) {
  if (routePolylineLayer) { map.removeLayer(routePolylineLayer); routePolylineLayer = null; }
  if (approachPolylineLayer) { map.removeLayer(approachPolylineLayer); approachPolylineLayer = null; }
  if (leg1PolylineLayer) { map.removeLayer(leg1PolylineLayer); leg1PolylineLayer = null; }
  if (leg2PolylineLayer) { map.removeLayer(leg2PolylineLayer); leg2PolylineLayer = null; }
  stopMarkersLayer.clearLayers();

  if (!isTrackingConfirmed || !selectedPickupStop || !selectedDestStop) return;

  const activeBus = (selectedBusPlate && activeBuses[selectedBusPlate]) ? activeBuses[selectedBusPlate] : null;

  if (currentTripPlanType === "TRANSFER" && activeTransferPlan) {
    const pIdx = activeTransferPlan.leg1.pIdx;
    const tIdx = activeTransferPlan.leg1.tIdx;
    const t2Idx = activeTransferPlan.leg2.tIdx;
    const d2Idx = activeTransferPlan.leg2.dIdx;

    let approachPoints = [];

    if (activeBus) {
      const busCurrentIdx = findBusNearestStopIndex(activeBus.lat, activeBus.lng, activeTransferPlan.leg1.stops);
      if (busCurrentIdx < pIdx) {
        approachPoints = [
          [activeBus.lat, activeBus.lng],
          ...activeTransferPlan.leg1.stops.slice(busCurrentIdx, pIdx + 1).map(s => [s.lat, s.lng])
        ];
        approachPolylineLayer = L.polyline(approachPoints, {
          color: '#f59e0b',
          weight: 4,
          dashArray: '8, 8',
          opacity: 0.95
        }).addTo(map);
      }
    }

    const hasLiveLeg1 = checkLegLiveAvailability(
      activeTransferPlan.leg1.routeKey,
      activeTransferPlan.leg1.direction,
      activeTransferPlan.leg1.pIdx,
      activeTransferPlan.leg1.stops
    );

    const hasLiveLeg2 = checkLegLiveAvailability(
      activeTransferPlan.leg2.routeKey,
      activeTransferPlan.leg2.direction,
      activeTransferPlan.leg2.tIdx,
      activeTransferPlan.leg2.stops
    );

    const leg1Stops = activeTransferPlan.leg1.stops.slice(pIdx, tIdx + 1);
    const leg1Points = leg1Stops.map(s => [s.lat, s.lng]);

    leg1PolylineLayer = L.polyline(leg1Points, hasLiveLeg1 ? {
      color: '#059669',
      weight: 6,
      opacity: 0.95
    } : {
      color: '#64748b',
      weight: 5,
      dashArray: '8, 8',
      opacity: 0.85
    }).addTo(map);

    const leg2Stops = activeTransferPlan.leg2.stops.slice(t2Idx, d2Idx + 1);
    const leg2Points = leg2Stops.map(s => [s.lat, s.lng]);

    leg2PolylineLayer = L.polyline(leg2Points, hasLiveLeg2 ? {
      color: '#7c3aed',
      weight: 6,
      opacity: 0.95
    } : {
      color: '#818cf8',
      weight: 5,
      dashArray: '8, 8',
      opacity: 0.85
    }).addTo(map);

    if (autoFit) {
      const allPoints = [...approachPoints, ...leg1Points, ...leg2Points];
      if (allPoints.length >= 2) {
        map.fitBounds(L.polyline(allPoints).getBounds(), { padding: [40, 40] });
      }
    }

    L.marker([selectedPickupStop.lat, selectedPickupStop.lng], { icon: createPinIcon("pickup") })
      .bindPopup(`🟢 <b>Board Bus 1:</b> ${selectedPickupStop.name}`)
      .addTo(stopMarkersLayer);

    const transferPt = activeTransferPlan.leg1.transferStop;
    L.marker([transferPt.lat, transferPt.lng], { icon: createPinIcon("transfer") })
      .bindPopup(`🔄 <b>Interchange Point:</b> ${transferPt.name}`)
      .addTo(stopMarkersLayer);

    L.marker([selectedDestStop.lat, selectedDestStop.lng], { icon: createPinIcon("dest") })
      .bindPopup(`🔴 <b>Final Destination:</b> ${selectedDestStop.name}`)
      .addTo(stopMarkersLayer);

    if (activeBus) {
      const busCurrentIdx = findBusNearestStopIndex(activeBus.lat, activeBus.lng, activeTransferPlan.leg1.stops);
      if (busCurrentIdx < pIdx) {
        const busStop = activeTransferPlan.leg1.stops[busCurrentIdx];
        L.marker([busStop.lat, busStop.lng], { icon: createPinIcon("bus_loc") })
          .bindPopup(`🟡 <b>Bus Current Location:</b> ${busStop.name}`)
          .addTo(stopMarkersLayer);
      }
    }
    return;
  }

  const pIdx = findStopIndexInList(currentStopsList, selectedPickupStop);
  const dIdx = findStopIndexInList(currentStopsList, selectedDestStop);

  if (pIdx === -1 || dIdx === -1 || pIdx >= dIdx) return;

  let approachPoints = [];

  if (activeBus) {
    const busCurrentIdx = findBusNearestStopIndex(activeBus.lat, activeBus.lng, currentStopsList);
    if (busCurrentIdx < pIdx) {
      approachPoints = [
        [activeBus.lat, activeBus.lng],
        ...currentStopsList.slice(busCurrentIdx, pIdx + 1).map(s => [s.lat, s.lng])
      ];
      approachPolylineLayer = L.polyline(approachPoints, {
        color: '#f59e0b',
        weight: 4,
        dashArray: '8, 8',
        opacity: 0.95
      }).addTo(map);
    }
  }

  const hasLiveDirectBus = checkLegLiveAvailability(activeRouteKey, currentDirection, pIdx, currentStopsList);

  const rideStops = currentStopsList.slice(pIdx, dIdx + 1);
  const ridePoints = rideStops.map(s => [s.lat, s.lng]);

  routePolylineLayer = L.polyline(ridePoints, hasLiveDirectBus ? {
    color: '#059669',
    weight: 6,
    opacity: 0.95
  } : {
    color: '#64748b',
    weight: 5,
    dashArray: '8, 8',
    opacity: 0.85
  }).addTo(map);

  if (autoFit) {
    const allPoints = [...approachPoints, ...ridePoints];
    if (allPoints.length >= 2) {
      map.fitBounds(L.polyline(allPoints).getBounds(), { padding: [40, 40] });
    }
  }

  const busCurrentIdx = activeBus ? findBusNearestStopIndex(activeBus.lat, activeBus.lng, currentStopsList) : pIdx;
  const startSpanIdx = (busCurrentIdx < pIdx) ? busCurrentIdx : pIdx;
  const tripSegmentStops = currentStopsList.slice(startSpanIdx, dIdx + 1);

  tripSegmentStops.forEach((stop, index) => {
    const actualIdx = startSpanIdx + index;
    let type = "regular";
    let label = `<b>Stop:</b> ${stop.name}`;

    if (actualIdx === pIdx) {
      type = "pickup";
      label = `🟢 <b>Boarding Stop:</b> ${stop.name}`;
    } else if (actualIdx === dIdx) {
      type = "dest";
      label = `🔴 <b>Deboarding Stop:</b> ${stop.name}`;
    } else if (actualIdx === busCurrentIdx && busCurrentIdx < pIdx) {
      type = "bus_loc";
      label = `🟡 <b>Bus Current Location:</b> ${stop.name}`;
    }

    L.marker([stop.lat, stop.lng], { icon: createPinIcon(type) })
      .bindPopup(label)
      .addTo(stopMarkersLayer);
  });
}

// ==========================================
// 7. AVAILABLE BUSES LIST RENDERER
// ==========================================
function updateAvailableBusesList() {
  const container = document.getElementById("busesListContainer");
  const floatingCard = document.getElementById("floatingBusCard");
  if (!container || !lastSearchResult) return;

  const previousScrollTop = container.scrollTop;
  container.innerHTML = "";

  const allCards = [];

  if (lastSearchResult.transfers && lastSearchResult.transfers.length > 0) {
    lastSearchResult.transfers.forEach((plan, planIdx) => {
      const isSelectedPlan = (currentTripPlanType === "TRANSFER" && activeTransferPlan && plan.leg1.routeKey === activeTransferPlan.leg1.routeKey && plan.leg2.routeKey === activeTransferPlan.leg2.routeKey && plan.transferStopName === activeTransferPlan.transferStopName);

      const r1Config = window.ROUTES_DATABASE[plan.leg1.routeKey] || {};
      const r2Config = window.ROUTES_DATABASE[plan.leg2.routeKey] || {};
      const r1Name = r1Config.name || "Bus 1";
      const r2Name = r2Config.name || "Bus 2";

      const leg1Count = plan.leg1.tIdx - plan.leg1.pIdx + 1;
      const leg2Count = plan.leg2.dIdx - plan.leg2.tIdx;
      const totalStops = leg1Count + leg2Count;

      const upcomingLeg1Buses = Object.values(activeBuses).filter(b => {
        const isLine = normalizeStr(b.routeKey || b.route).includes(normalizeStr(plan.leg1.routeKey)) || normalizeStr(plan.leg1.routeKey).includes(normalizeStr(b.routeKey || b.route));
        if (!isLine || b.busDir !== plan.leg1.direction) return false;
        const busCurrentIdx = findBusNearestStopIndex(b.lat, b.lng, plan.leg1.stops);
        return busCurrentIdx <= plan.leg1.pIdx;
      });

      const isLeg1Live = upcomingLeg1Buses.length > 0;
      const isLeg2Live = checkLegLiveAvailability(plan.leg2.routeKey, plan.leg2.direction, plan.leg2.tIdx, plan.leg2.stops);

      const isAllLive = isLeg1Live && isLeg2Live;
      const isPartialLive = isLeg1Live && !isLeg2Live;
      const liveBus = isLeg1Live ? upcomingLeg1Buses[0] : null;

      if (isSelectedPlan) {
        if (isLeg1Live && (!selectedBusPlate || !upcomingLeg1Buses.some(b => b.plate === selectedBusPlate))) {
          selectedBusPlate = liveBus.plate;
        } else if (!isLeg1Live) {
          selectedBusPlate = null;
        }

        if (isTrackingConfirmed && floatingCard && liveBus) {
          floatingCard.classList.remove("hidden");
          const floatBusPlate = document.getElementById('floatBusPlate');
          floatBusPlate.className = "flex items-center gap-1.5 min-w-0";
          floatBusPlate.innerHTML = `
            <span class="font-bold text-slate-900 text-xs sm:text-sm shrink-0">${liveBus.plate}</span>
            <span class="text-[10px] font-extrabold text-[#0091C2] bg-[#00ABE4]/10 px-1.5 py-[2px] rounded border border-[#00ABE4]/30 truncate min-w-0">
              ➔ 1-Transfer
            </span>
          `;
          const busCurrentIdx = findBusNearestStopIndex(liveBus.lat, liveBus.lng, plan.leg1.stops);
          const busLocName = plan.leg1.stops[busCurrentIdx]?.name || "En Route";
          document.getElementById('floatTelemetry').innerText = `Near: ${busLocName} • Speed: ${liveBus.spd.toFixed(1)} km/h`;
        } else if (floatingCard) {
          floatingCard.classList.add("hidden");
        }
      }

      const etaSec = (liveBus && plan.leg1.pIdx >= 0)
        ? calculateEtaSeconds(liveBus.lat, liveBus.lng, liveBus.spd, plan.leg1.pIdx, plan.leg1.stops)
        : Infinity;
      const etaStr = etaSec !== Infinity ? formatEtaTime(etaSec) : "Scheduled";

      const isCurrentlyTracked = isTrackingConfirmed && isSelectedPlan;

      let badgeHtml = '';
      if (isAllLive) {
        badgeHtml = `
          <span class="inline-flex items-center gap-1.5 text-[11px] font-bold text-[#10B981]">
            <span class="w-2 h-2 rounded-full bg-[#10B981] animate-pulse"></span>
            Live
          </span>`;
      } else if (isPartialLive) {
        badgeHtml = `
          <span class="inline-flex items-center gap-1.5 text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-200/80 px-2 py-0.5 rounded-full">
            <span class="w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span>
            Partial Live
          </span>`;
      } else {
        badgeHtml = `
          <span class="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-400">
            <span class="w-2 h-2 rounded-full bg-slate-300"></span>
            No Active Bus
          </span>`;
      }

      const card = document.createElement("div");
      card.className = `bg-white border ${isSelectedPlan ? (isAllLive ? 'border-[#10B981] ring-2 ring-[#10B981]/10' : (isLeg1Live ? 'border-violet-500 ring-2 ring-violet-500/10' : 'border-slate-400 ring-2 ring-slate-400/10')) : 'border-slate-200'} hover:border-[#00ABE4] rounded-2xl p-2.5 sm:p-3 shadow-sm transition-all duration-200 hover:shadow-md cursor-pointer mb-2 sm:mb-2.5`;
      card.onclick = () => {
        selectTransferOption(planIdx, isCurrentlyTracked);
      };

      card.innerHTML = `
        <div class="flex items-center justify-between pb-1.5 sm:pb-2 border-b border-slate-100">
          <div>
            ${planIdx === 0 && isLeg1Live ? `
              <span class="inline-flex items-center gap-1 ${isAllLive ? 'bg-[#10B981]' : 'bg-violet-600'} text-white text-[9px] sm:text-[10px] font-extrabold px-2 py-0.5 rounded-md shadow-sm">
                ★ Best Option
              </span>
            ` : `
              <span class="text-[9px] sm:text-[10px] font-bold text-slate-400 uppercase tracking-wider">1-Transfer Route</span>
            `}
          </div>
          ${badgeHtml}
        </div>

        <div class="mt-2 sm:mt-2.5">
          <div class="flex items-baseline justify-between gap-2">
            <div class="text-base sm:text-lg font-black ${isAllLive ? 'text-[#10B981]' : (isLeg1Live ? 'text-violet-700' : 'text-slate-700')} tracking-tight flex items-center gap-1.5 flex-wrap min-w-0">
              <span>${r1Name}</span>
              <span class="text-xs text-slate-400 font-normal">➔</span>
              <span>${r2Name}</span>
            </div>
            <div class="text-right shrink-0">
              <div class="text-sm sm:text-base font-black ${isAllLive ? 'text-[#10B981]' : (isLeg1Live ? 'text-violet-600' : 'text-slate-600')} leading-tight">${etaStr}</div>
              <div class="text-[9px] sm:text-[10px] text-slate-400">${isLeg1Live ? 'to pickup' : 'Timetable'}</div>
            </div>
          </div>

          <div class="text-xs font-bold text-slate-800 truncate mt-1">
            ${selectedPickupStop ? selectedPickupStop.name : 'Origin'} 
            <span class="text-slate-400 font-normal">➔</span> 
            ${selectedDestStop ? selectedDestStop.name : 'Destination'}
          </div>
          <div class="text-[10px] ${isLeg1Live ? 'text-amber-800' : 'text-slate-500'} font-semibold mt-0.5 flex items-center gap-1 truncate">
            <span>🔄 Change:</span>
            <span class="underline truncate">${plan.transferStopName}</span>
            <span class="text-slate-400 font-normal shrink-0">(${totalStops} stops)</span>
          </div>
        </div>

        <div class="hidden sm:flex items-center justify-between text-[10px] sm:text-[11px] font-medium text-slate-500 mt-2.5 pt-2 border-t border-slate-100">
          <span class="font-mono font-bold text-slate-600">${liveBus ? liveBus.plate : 'Timetable'}</span>
          <span class="flex items-center gap-1 text-slate-500">
            <i data-lucide="${isLeg1Live ? 'radio' : 'calendar'}" class="w-3 h-3 text-slate-400"></i> ${isAllLive ? 'Full Live' : (isPartialLive ? 'Partial Live' : 'Scheduled')}
          </span>
          <span class="flex items-center gap-1 text-slate-500">
            <i data-lucide="git-merge" class="w-3 h-3 text-slate-400"></i> Change Hub
          </span>
        </div>

        <div class="mt-2 sm:mt-2.5">
          ${isCurrentlyTracked ? `
            <button onclick="event.stopPropagation(); cancelTracking();" class="w-full bg-rose-600 hover:bg-rose-700 active:scale-[0.98] text-white font-bold text-xs py-2 px-3.5 rounded-xl shadow-md shadow-rose-600/20 flex items-center justify-center gap-1.5 transition-all">
              <i data-lucide="x" class="w-3.5 h-3.5"></i>
              <span>Cancel Tracking</span>
            </button>
          ` : `
            <button onclick="event.stopPropagation(); selectTransferOption(${planIdx}, false); startTracking();" class="w-full ${isAllLive ? 'bg-[#10B981] hover:bg-[#059669] shadow-[#10B981]/20' : (isLeg1Live ? 'bg-violet-600 hover:bg-violet-700 shadow-violet-600/20' : 'bg-slate-800 hover:bg-slate-900')} active:scale-[0.98] text-white font-bold text-xs py-2 px-3.5 rounded-xl shadow-md flex items-center justify-center gap-1.5 transition-all">
              <i data-lucide="${isLeg1Live ? 'bus' : 'git-merge'}" class="w-3.5 h-3.5"></i>
              <span>${isLeg1Live ? 'Track this bus & route' : 'Track Scheduled Route'}</span>
            </button>
          `}
        </div>
      `;

      const transferPriority = isAllLive ? 1 : (isLeg1Live ? 2 : 4);
      allCards.push({ priority: transferPriority, etaSec: etaSec, elem: card });
    });
  }

  // 2. Process Direct Routes (Live & Scheduled) safely decoupled
  if (lastSearchResult.direct && lastSearchResult.direct.length > 0) {
    const viableBuses = [];

    Object.entries(activeBuses).forEach(([plate, bus]) => {
      const busRouteNorm = normalizeStr(bus.routeKey || bus.route);
      
      const matchedRoute = lastSearchResult.direct.find(r => 
        normalizeStr(r.routeKey) === busRouteNorm || 
        busRouteNorm.includes(normalizeStr(r.routeKey)) || 
        normalizeStr(r.routeKey).includes(busRouteNorm)
      );

      if (!matchedRoute) return;
      if (bus.busDir !== matchedRoute.direction) return;

      const routeStops = matchedRoute.stops;
      let routePickupIdx = selectedPickupStop ? findStopIndexInList(routeStops, selectedPickupStop) : -1;
      let routeDestIdx = selectedDestStop ? findStopIndexInList(routeStops, selectedDestStop) : -1;

      const busCurrentIdx = findBusNearestStopIndex(bus.lat, bus.lng, routeStops);
      const busLocName = routeStops[busCurrentIdx]?.name || "En Route";

      if (routePickupIdx !== -1 && busCurrentIdx > routePickupIdx) return;
      if (routeDestIdx !== -1 && busCurrentIdx >= routeDestIdx) return;

      const etaSec = routePickupIdx !== -1 ? calculateEtaSeconds(bus.lat, bus.lng, bus.spd, routePickupIdx, routeStops) : Infinity;
      const distMeters = routePickupIdx !== -1 ? calculateAccurateBusToStopDistance(bus.lat, bus.lng, routePickupIdx, routeStops) : 0;
      const stopsAway = Math.max(0, routePickupIdx - busCurrentIdx);

      viableBuses.push({
        plate,
        bus,
        currentLocationName: busLocName,
        targetStopName: selectedPickupStop ? selectedPickupStop.name : busLocName,
        etaSec,
        etaLabel: formatEtaTime(etaSec),
        distMeters,
        stopsAway: stopsAway
      });
    });

    if (viableBuses.length > 0) {
      viableBuses.sort((a, b) => a.etaSec - b.etaSec);

      if (currentTripPlanType === "DIRECT") {
        if (!selectedBusPlate || !viableBuses.some(b => b.plate === selectedBusPlate)) {
          selectedBusPlate = viableBuses[0].plate;
        }

        const activeSelectedBus = viableBuses.find(b => b.plate === selectedBusPlate) || viableBuses[0];

        if (isTrackingConfirmed && floatingCard) {
          floatingCard.classList.remove("hidden");
          const floatBusPlate = document.getElementById('floatBusPlate');
          floatBusPlate.className = "flex items-center gap-1.5 min-w-0";
          floatBusPlate.innerHTML = `
            <span class="font-bold text-slate-900 text-xs sm:text-sm shrink-0">${activeSelectedBus.plate}</span>
            <span class="text-[10px] font-extrabold text-sky-800 bg-sky-100/90 px-1.5 py-[2px] rounded border border-sky-200 truncate min-w-0">
              ➔ ${selectedDestStop ? selectedDestStop.name : 'En Route'}
            </span>
          `;
          document.getElementById('floatTelemetry').innerText = `Near: ${activeSelectedBus.currentLocationName} • Speed: ${activeSelectedBus.bus.spd.toFixed(1)} km/h`;
        }
      }

      // Render Live Direct Cards (Priority 0)
      viableBuses.forEach((item, rank) => {
        const isSelected = (currentTripPlanType === "DIRECT" && item.plate === selectedBusPlate);
        const isBest = (rank === 0);
        const cardinalDir = (item.bus.busDir === "UP") ? "North Bound" : "South Bound";
        const isCurrentlyTracked = isTrackingConfirmed && isSelected;

        const card = document.createElement("div");
        card.className = `bg-white border ${isSelected ? 'border-[#10B981] ring-2 ring-[#10B981]/10' : 'border-slate-200'} hover:border-[#10B981] rounded-2xl p-2.5 sm:p-3 shadow-sm transition-all duration-200 hover:shadow-md cursor-pointer mb-2 sm:mb-2.5`;
        card.onclick = () => { selectBus(item.plate); };

        card.innerHTML = `
          <div class="flex items-center justify-between pb-1.5 sm:pb-2 border-b border-slate-100">
            <div>
              ${isBest ? `
                <span class="inline-flex items-center gap-1 bg-[#10B981] text-white text-[9px] sm:text-[10px] font-extrabold px-2 py-0.5 rounded-md shadow-sm">
                  ★ Best Option
                </span>
              ` : `
                <span class="text-[9px] sm:text-[10px] font-bold text-slate-400 uppercase tracking-wider">Alternate</span>
              `}
            </div>
            <span class="inline-flex items-center gap-1.5 text-[11px] font-bold text-[#10B981]">
              <span class="w-2 h-2 rounded-full bg-[#10B981] animate-pulse"></span>
              Live
            </span>
          </div>

          <div class="flex items-center justify-between mt-2.5 gap-2">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 min-w-0"> <!-- FIX: Bound the wrapper to stop premature truncation collapse -->
                <span class="text-xl sm:text-2xl font-black text-[#10B981] tracking-tight shrink-0">${item.bus.route}</span>
                <span class="text-xs font-bold text-slate-800 truncate">
                  ${selectedPickupStop ? selectedPickupStop.name : 'Origin'} 
                  <span class="text-slate-400 font-normal">➔</span> 
                  ${selectedDestStop ? selectedDestStop.name : 'Destination'}
                </span>
              </div>
              <div class="text-[10px] sm:text-[11px] text-slate-400 truncate mt-0.5">
                Near ${item.currentLocationName}
              </div>
            </div>

            <div class="text-right shrink-0">
              <div class="text-base sm:text-lg font-black text-[#10B981] leading-tight">${item.etaLabel}</div>
              <div class="text-[9px] sm:text-[10px] text-slate-400 whitespace-nowrap">${item.stopsAway === 0 ? 'Approaching' : `${item.stopsAway} stops away`}</div>
            </div>
          </div>

          <div class="hidden sm:flex items-center justify-between text-[10px] sm:text-[11px] font-medium text-slate-500 mt-2.5 pt-2 border-t border-slate-100">
            <span class="font-mono font-bold text-slate-700">${item.bus.plate}</span>
            <span class="flex items-center gap-1 text-slate-500">
              <i data-lucide="radio" class="w-3 h-3 text-slate-400"></i> Live
            </span>
            <span class="flex items-center gap-1 text-slate-600">
              <i data-lucide="navigation" class="w-3 h-3 text-slate-400"></i> ${cardinalDir}
            </span>
          </div>

          <div class="mt-2 sm:mt-2.5">
            ${isCurrentlyTracked ? `
              <button onclick="event.stopPropagation(); cancelTracking();" class="w-full bg-rose-600 hover:bg-rose-700 active:scale-[0.98] text-white font-bold text-xs py-2 px-3.5 rounded-xl shadow-md shadow-rose-600/20 flex items-center justify-center gap-1.5 transition-all">
                <i data-lucide="x" class="w-3.5 h-3.5"></i>
                <span>Cancel Tracking</span>
              </button>
            ` : `
              <button onclick="event.stopPropagation(); selectBus('${item.plate}'); startTracking();" class="w-full bg-[#10B981] hover:bg-[#059669] active:scale-[0.98] text-white font-bold text-xs py-2 px-3.5 rounded-xl shadow-md shadow-[#10B981]/20 flex items-center justify-center gap-1.5 transition-all">
                <i data-lucide="bus" class="w-3.5 h-3.5"></i>
                <span>Track this bus</span>
              </button>
            `}
          </div>
        `;

        allCards.push({ priority: 0, etaSec: item.etaSec, elem: card });
      });
    } else {
      // Direct Scheduled Cards Fallback (Priority 3)
      if (currentTripPlanType === "DIRECT" && floatingCard) {
         floatingCard.classList.add("hidden");
      }
      
      lastSearchResult.direct.forEach((r, rIdx) => {
        const config = window.ROUTES_DATABASE[r.routeKey];
        if (!config) return;

        const isSelected = (currentTripPlanType === "DIRECT" && activeRouteKey === r.routeKey);
        const isCurrentlyTracked = isTrackingConfirmed && isSelected;
        const totalStopsCount = Math.max(1, (r.dIdx - r.pIdx + 1));

        const card = document.createElement("div");
        card.className = `bg-white border ${isSelected ? 'border-slate-400 ring-2 ring-slate-400/10' : 'border-slate-200'} hover:border-slate-400 rounded-2xl p-2.5 sm:p-3 shadow-sm transition-all duration-200 hover:shadow-md cursor-pointer mb-2 sm:mb-2.5`;
        card.onclick = () => selectDirectOption(rIdx, isCurrentlyTracked);

        card.innerHTML = `
          <div class="flex items-center justify-between pb-1.5 sm:pb-2 border-b border-slate-100">
            <div>
              <span class="text-[9px] sm:text-[10px] font-bold text-slate-400 uppercase tracking-wider">Direct Route</span>
            </div>
            <span class="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-400">
              <span class="w-2 h-2 rounded-full bg-slate-300"></span>
              No Active Bus
            </span>
          </div>

          <div class="mt-2 sm:mt-2.5">
            <div class="flex items-baseline justify-between gap-2">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 min-w-0">
                  <span class="text-xl sm:text-2xl font-black text-slate-700 tracking-tight shrink-0">${config.name}</span>
                  <span class="text-xs font-bold text-slate-800 truncate">
                    ${selectedPickupStop ? selectedPickupStop.name : 'Origin'} 
                    <span class="text-slate-400 font-normal">➔</span> 
                    ${selectedDestStop ? selectedDestStop.name : 'Destination'}
                  </span>
                </div>
              </div>
              <div class="text-right shrink-0">
                <div class="text-sm sm:text-base font-black text-slate-600 leading-tight">Scheduled</div>
                <div class="text-[9px] sm:text-[10px] text-slate-400">Timetable</div>
              </div>
            </div>

            <div class="text-[10px] text-slate-500 font-semibold mt-0.5 flex items-center gap-1 truncate">
              <span>Direct Corridor</span>
              <span class="text-slate-400 font-normal shrink-0">(${totalStopsCount} stops)</span>
            </div>
          </div>

          <div class="hidden sm:flex items-center justify-between text-[10px] sm:text-[11px] font-medium text-slate-500 mt-2.5 pt-2 border-t border-slate-100">
            <span class="font-mono font-bold text-slate-600">Timetable</span>
            <span class="flex items-center gap-1 text-slate-500">
              <i data-lucide="calendar" class="w-3 h-3 text-slate-400"></i> Scheduled
            </span>
            <span class="flex items-center gap-1 text-slate-500">
              <i data-lucide="map-pin" class="w-3 h-3 text-slate-400"></i> Direct Line
            </span>
          </div>

          <div class="mt-2 sm:mt-2.5">
            ${isCurrentlyTracked ? `
              <button onclick="event.stopPropagation(); cancelTracking();" class="w-full bg-rose-600 hover:bg-rose-700 active:scale-[0.98] text-white font-bold text-xs py-2 px-3.5 rounded-xl shadow-md shadow-rose-600/20 flex items-center justify-center gap-1.5 transition-all">
                <i data-lucide="x" class="w-3.5 h-3.5"></i>
                <span>Cancel Tracking</span>
              </button>
            ` : `
              <button onclick="event.stopPropagation(); selectDirectOption(${rIdx}, false); startTracking();" class="w-full bg-slate-800 hover:bg-slate-900 active:scale-[0.98] text-white font-bold text-xs py-2 px-3.5 rounded-xl shadow-md flex items-center justify-center gap-1.5 transition-all">
                <i data-lucide="map-pin" class="w-3.5 h-3.5"></i>
                <span>Track Scheduled Route</span>
              </button>
            `}
          </div>
        `;

        allCards.push({ priority: 3, etaSec: Infinity, elem: card });
      });
    }
  }

  // Sort strictly by Priority index
  allCards.sort((a, b) => a.priority - b.priority || a.etaSec - b.etaSec);
  allCards.forEach(c => container.appendChild(c.elem));

  if (shouldResetScrollOnNextRender) {
    container.scrollTop = 0;
    shouldResetScrollOnNextRender = false;
  } else {
    container.scrollTop = previousScrollTop;
  }

  lucide.createIcons();
}

function selectBus(plate) {
  selectedBusPlate = plate;
  const bus = activeBuses[plate];
  
  if (bus && window.ROUTES_DATABASE && window.ROUTES_DATABASE[bus.routeKey]) {
    const rConfig = window.ROUTES_DATABASE[bus.routeKey];
    activeRouteKey = bus.routeKey;
    currentTripPlanType = "DIRECT";
    activeTransferPlan = null;
    currentDirection = bus.busDir || "UP";
    currentStopsList = (currentDirection === "DOWN") ? (rConfig.returnStops || rConfig.forwardStops) : (rConfig.forwardStops || rConfig.returnStops);
    updateDirectionBannerText();
  }

  updateAvailableBusesList();
  updateTripStatusBadge();

  if (bus) {
    map.panTo([bus.lat, bus.lng]);
    if (isTrackingConfirmed) {
      updateStopsTable(bus.lat, bus.lng, bus.spd);
    }
  }
}

// ==========================================
// 8. STOP TIMELINE TABLE (LIVE GPS STREAM)
// ==========================================
function updateStopsTable(busLat, busLng, currentSpeedKmph) {
  if (!isTrackingConfirmed || !selectedPickupStop || !selectedDestStop) {
    document.getElementById("stopsTimeline")?.classList.add("hidden");
    document.getElementById("noTrackPlaceholder")?.classList.remove("hidden");
    return;
  }

  document.getElementById("stopsTimeline")?.classList.remove("hidden");
  document.getElementById("noTrackPlaceholder")?.classList.add("hidden");

  if (!selectedBusPlate || !activeBuses[selectedBusPlate]) {
    renderSchedulePreview();
    return;
  }

  if (currentTripPlanType === "TRANSFER" && activeTransferPlan) {
    const busAbsoluteIdx = findBusNearestStopIndex(busLat, busLng, activeTransferPlan.leg1.stops);
    busNearestStopIdx = busAbsoluteIdx;

    const pIdx = activeTransferPlan.leg1.pIdx;
    const tIdx = activeTransferPlan.leg1.tIdx;
    const startSpanIdx = Math.min(busAbsoluteIdx, pIdx);
    const leg1Stops = activeTransferPlan.leg1.stops.slice(startSpanIdx, tIdx + 1);
    const leg2Stops = activeTransferPlan.leg2.stops.slice(activeTransferPlan.leg2.tIdx + 1, activeTransferPlan.leg2.dIdx + 1);

    const r1Name = window.ROUTES_DATABASE[activeTransferPlan.leg1.routeKey]?.name || "Bus 1";
    const r2Name = window.ROUTES_DATABASE[activeTransferPlan.leg2.routeKey]?.name || "Bus 2";

    const rowsHtml = [];
    let prevEtaSec = 0;

    leg1Stops.forEach((stop, idx) => {
      const actualStopIdx = startSpanIdx + idx;
      const isTransferPoint = (actualStopIdx === tIdx);
      const dDirectToStop = getDistanceMeters(busLat, busLng, stop.lat, stop.lng);
      const stopEtaSec = calculateEtaSeconds(busLat, busLng, currentSpeedKmph, actualStopIdx, activeTransferPlan.leg1.stops);
      
      let distLabel = "";
      if (actualStopIdx < pIdx) {
        const metersToPickup = calculateRouteSegmentDistance(actualStopIdx, pIdx, activeTransferPlan.leg1.stops);
        distLabel = `${(metersToPickup / 1000).toFixed(1)} km to pickup`;
      } else if (actualStopIdx === pIdx) {
        distLabel = "0.0 km";
      } else {
        const metersFromPickup = calculateRouteSegmentDistance(pIdx, actualStopIdx, activeTransferPlan.leg1.stops);
        distLabel = `${(metersFromPickup / 1000).toFixed(1)} km from pickup`;
      }
      
      const segMinRaw = isFinite(stopEtaSec) ? Math.max(1, Math.round((stopEtaSec - prevEtaSec) / 60)) : null;
      const subLabel = segMinRaw !== null ? `${segMinRaw} min • ${distLabel}` : distLabel;

      let dotState = "normal", badge = { text: r1Name, cls: "text-sky-700" };
      let statusText = "", statusClass = "text-slate-400", timeLabel = formatClockTime(stopEtaSec), dim = false, active = false;

      if (actualStopIdx === pIdx) {
        dotState = "boarding";
        badge = { text: `Boarding • ${r1Name}`, cls: "text-[#059669]" };
        statusText = "Now"; statusClass = "text-[#10B981] font-extrabold";
        active = (busAbsoluteIdx <= pIdx);
        if (busAbsoluteIdx > pIdx) { dim = true; statusText = "Boarded"; }
      } else if (isTransferPoint) {
        dotState = "transfer";
        badge = { text: `Transfer • ${r1Name}`, cls: "text-[#0091C2]" };
        statusText = "Switch buses"; statusClass = "text-[#00ABE4] font-extrabold";
        active = (busAbsoluteIdx <= actualStopIdx);
      } else if (busAbsoluteIdx > actualStopIdx) {
        dotState = "passed"; dim = true; timeLabel = "--:--";
        statusText = "Missed"; statusClass = "text-slate-300";
      } else if (actualStopIdx === busAbsoluteIdx && busAbsoluteIdx < pIdx) {
        dotState = "live"; active = true;
        timeLabel = dDirectToStop <= 100 ? "Bus Here" : formatClockTime(stopEtaSec);
        statusText = "Live location"; statusClass = "text-amber-600";
      } else if (actualStopIdx < pIdx) {
        statusText = `${pIdx - actualStopIdx} left`;
      } else {
        statusText = `${tIdx - actualStopIdx} left`;
      }

      rowsHtml.push(tlRow({ name: stop.name, badge, subLabel, timeLabel, statusText, statusClass, dotState, dim, active }));
      if (isFinite(stopEtaSec)) prevEtaSec = stopEtaSec;
    });

    rowsHtml.push(tlDivider(`Switch to <b>${r2Name}</b> towards ${selectedDestStop.name}`));

    leg2Stops.forEach((stop, idx) => {
      const actualStopIdx = activeTransferPlan.leg2.tIdx + 1 + idx;
      const isFinal = (idx === leg2Stops.length - 1);
      
      const metersFromTransfer = calculateRouteSegmentDistance(activeTransferPlan.leg2.tIdx, actualStopIdx, activeTransferPlan.leg2.stops);
      const distLabel = `${(metersFromTransfer / 1000).toFixed(1)} km from transfer`;

      let badge = { text: r2Name, cls: "text-amber-700" };
      let dotState = isFinal ? "destination" : "normal";
      let statusText = isFinal ? "0 left" : `${leg2Stops.length - 1 - idx} left`;
      let statusClass = isFinal ? "text-rose-600 font-extrabold" : "text-slate-400";
      if (isFinal) badge = { text: `Destination • ${r2Name}`, cls: "text-rose-700" };

      rowsHtml.push(tlRow({ name: stop.name, badge, subLabel: distLabel, timeLabel: "--:--", statusText, statusClass, dotState, dim: false, active: false }));
    });

    setTimelineHTML(rowsHtml);
    scrollTableToActiveRow();
    renderRoutePins(false);
    updateTripSummaryUI();
    return;
  }

  const pIdx = findStopIndexInList(currentStopsList, selectedPickupStop);
  const dIdx = findStopIndexInList(currentStopsList, selectedDestStop);

  if (pIdx === -1 || dIdx === -1 || pIdx >= dIdx) {
    renderSchedulePreview();
    return;
  }

  const busAbsoluteIdx = findBusNearestStopIndex(busLat, busLng, currentStopsList);
  busNearestStopIdx = busAbsoluteIdx;

  const startSpanIdx = Math.min(busAbsoluteIdx, pIdx);
  const journeyStops = currentStopsList.slice(startSpanIdx, dIdx + 1);
  const rName = window.ROUTES_DATABASE[activeRouteKey]?.name || "Direct";

  const rowsHtml = [];
  let prevEtaSec = 0;

  journeyStops.forEach((stop, relIdx) => {
    const actualStopIdx = startSpanIdx + relIdx;
    const dDirectToStop = getDistanceMeters(busLat, busLng, stop.lat, stop.lng);
    const stopEtaSec = calculateEtaSeconds(busLat, busLng, currentSpeedKmph, actualStopIdx, currentStopsList);
    
    let distLabel = "";
    if (actualStopIdx < pIdx) {
      const metersToPickup = calculateRouteSegmentDistance(actualStopIdx, pIdx, currentStopsList);
      distLabel = `${(metersToPickup / 1000).toFixed(1)} km to pickup`;
    } else if (actualStopIdx === pIdx) {
      distLabel = "0.0 km";
    } else {
      const metersFromPickup = calculateRouteSegmentDistance(pIdx, actualStopIdx, currentStopsList);
      distLabel = `${(metersFromPickup / 1000).toFixed(1)} km from pickup`;
    }
    
    const segMinRaw = isFinite(stopEtaSec) ? Math.max(1, Math.round((stopEtaSec - prevEtaSec) / 60)) : null;
    const subLabel = segMinRaw !== null ? `${segMinRaw} min • ${distLabel}` : distLabel;

    let dotState = "normal", badge = { text: rName, cls: "text-sky-700" };
    let statusText = "", statusClass = "text-slate-400", timeLabel = formatClockTime(stopEtaSec), dim = false, active = false;

    if (actualStopIdx === pIdx) {
      dotState = "boarding";
      badge = { text: `Boarding • ${rName}`, cls: "text-[#059669]" };
      statusText = "Now"; statusClass = "text-[#10B981] font-extrabold";
      active = (busAbsoluteIdx <= pIdx);
      if (busAbsoluteIdx > pIdx) { dim = true; statusText = "Boarded"; }
    } else if (actualStopIdx === dIdx) {
      dotState = "destination";
      badge = { text: `Destination • ${rName}`, cls: "text-rose-700" };
      statusText = "0 left"; statusClass = "text-rose-600 font-extrabold";
    } else if (busAbsoluteIdx > actualStopIdx) {
      dotState = "passed"; dim = true; timeLabel = "--:--";
      statusText = "Missed"; statusClass = "text-slate-300";
    } else if (actualStopIdx === busAbsoluteIdx && busAbsoluteIdx < pIdx) {
      dotState = "live"; active = true;
      timeLabel = dDirectToStop <= 100 ? "Bus Here" : formatClockTime(stopEtaSec);
      statusText = "Live location"; statusClass = "text-amber-600";
    } else if (actualStopIdx < pIdx) {
      statusText = `${pIdx - actualStopIdx} left`;
    } else {
      statusText = `${dIdx - actualStopIdx} left`;
    }

    rowsHtml.push(tlRow({ name: stop.name, badge, subLabel, timeLabel, statusText, statusClass, dotState, dim, active }));
    if (isFinite(stopEtaSec)) prevEtaSec = stopEtaSec;
  });

  setTimelineHTML(rowsHtml);
  scrollTableToActiveRow();
  renderRoutePins(false);
  updateTripSummaryUI();
}

function recenterMap() {
  if (selectedBusPlate && activeBusMarkers[selectedBusPlate]) {
    map.flyTo(activeBusMarkers[selectedBusPlate].getLatLng(), 15, { animate: true, duration: 1 });
  }
}

// ==========================================
// 9. FLEET MQTT INGESTION (WEBSOCKETS)
// ==========================================
updateAvailableBusesList();

const client = mqtt.connect('wss://broker.hivemq.com:8884/mqtt', {
  clientId: 'WebClient_' + Math.random().toString(16).substr(2, 8),
  keepalive: 60,
  clean: true,
  reconnectPeriod: 3000
});

client.on('connect', () => {
  console.log('Connected to HiveMQ Unified Fleet Hub');
  updateTripStatusBadge();
  client.subscribe('citytransit/fleet/#', (err) => {
    if (err) console.error('Subscription error:', err);
  });
});

client.on('reconnect', () => {
  console.log('Reconnecting to HiveMQ...');
});

client.on('offline', () => {
  console.log('HiveMQ Offline');
});

client.on('message', (topic, message) => {
  try {
    const rawPayload = message.toString().trim();
    if (!rawPayload) return;

    const d = JSON.parse(rawPayload);
    if (!d || !d.lat || !d.lng || !window.ROUTES_DATABASE) return;

    const busPlate = d.bus_no || "WB42U2676";
    const rawRouteName = d.route || "77A_NOBATA";
    const busLat = parseFloat(d.lat);
    const busLng = parseFloat(d.lng);
    const busSpeed = parseFloat(d.spd || 0);
    const busHeading = parseFloat(d.heading || 0);

    let resolvedRouteKey = Object.keys(window.ROUTES_DATABASE).find(
      key => normalizeStr(key) === normalizeStr(rawRouteName)
    ) || Object.keys(window.ROUTES_DATABASE)[0];

    const routeConfig = window.ROUTES_DATABASE[resolvedRouteKey];
    if (!routeConfig) return;

    if (!activeRouteKey) {
      activeRouteKey = resolvedRouteKey;
      currentStopsList = routeConfig.forwardStops;
      updateDirectionBannerText();
    }

    const detectedDir = updateBusDirectionFromMovement(
      busPlate, 
      busLat, 
      busLng, 
      busHeading, 
      busSpeed, 
      d.dir || d.direction || null, 
      routeConfig
    );

    activeBuses[busPlate] = {
      plate: busPlate,
      routeKey: resolvedRouteKey,
      route: routeConfig.name,
      subTitle: routeConfig.subTitle,
      lat: busLat,
      lng: busLng,
      spd: busSpeed,
      heading: busHeading,
      busDir: detectedDir,
      lastSeen: Date.now()
    };

    const parts = (routeConfig.subTitle || "").split(/<->|↔|->|-/).map(s => s.trim()).filter(Boolean);
    const destTerminal = (detectedDir === "DOWN") ? (parts[0] || "Down") : (parts[1] || "Up");

    const pos = [busLat, busLng];

    if (!activeBusMarkers[busPlate]) {
      activeBusMarkers[busPlate] = L.marker(pos, {
        icon: createDynamicBusMapIcon(routeConfig.name, busPlate, busHeading, destTerminal)
      }).addTo(map);
      breadcrumbLines[busPlate] = L.polyline([], { color: '#0284c7', weight: 4 }).addTo(map);
      
      map.panTo(pos);
    } else {
      activeBusMarkers[busPlate].setLatLng(pos);
      activeBusMarkers[busPlate].setIcon(createDynamicBusMapIcon(routeConfig.name, busPlate, busHeading, destTerminal));
    }
    
    if (breadcrumbLines[busPlate]) {
      const latLngs = breadcrumbLines[busPlate].getLatLngs();
      if (latLngs.length > 0) {
        const lastPt = latLngs[latLngs.length - 1];
        const jumpDist = getDistanceMeters(lastPt.lat, lastPt.lng, busLat, busLng);
        if (jumpDist > 500) {
          breadcrumbLines[busPlate].setLatLngs([]);
        }
      }

      breadcrumbLines[busPlate].addLatLng(pos);
      
      const currentPts = breadcrumbLines[busPlate].getLatLngs();
      if (currentPts.length > 60) {
        breadcrumbLines[busPlate].setLatLngs(currentPts.slice(-60));
      }
    }

    if (busPlate === selectedBusPlate && isTrackingConfirmed) {
      updateStopsTable(busLat, busLng, busSpeed);
    } else {
      updateAvailableBusesList();
      if (isTrackingConfirmed) {
        renderRoutePins(false);
      }
    }
    updateTripStatusBadge();
  } catch (e) {
    console.error('Fleet MQTT parse error:', e);
  }
});

// Purge offline buses after 90 seconds of silence
setInterval(() => {
  const now = Date.now();
  let stateChanged = false;

  for (const [plate, bus] of Object.entries(activeBuses)) {
    if (now - bus.lastSeen > 90000) {
      stateChanged = true;
      if (activeBusMarkers[plate]) {
        map.removeLayer(activeBusMarkers[plate]);
        delete activeBusMarkers[plate];
      }
      if (breadcrumbLines[plate]) {
        map.removeLayer(breadcrumbLines[plate]);
        delete breadcrumbLines[plate];
      }
      delete activeBuses[plate];
      if (selectedBusPlate === plate) {
        selectedBusPlate = null;
      }
    }
  }

  if (stateChanged) {
    updateAvailableBusesList();
    updateTripStatusBadge();
    if (isTrackingConfirmed) {
      renderRoutePins(false);
    }
  }
}, 5000);