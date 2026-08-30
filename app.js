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

const activeBuses = {};
const activeBusMarkers = {};
let selectedBusPlate = null;

// Fuzzy stop matcher that tolerates name variations
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
// 2. LEAFLET MAP SETUP & DYNAMIC ROTATING MARKERS
// ==========================================
const map = L.map('map', { center: [22.5000, 88.2500], zoom: 12, zoomControl: false });

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

map.on('click', () => closeBottomSheet());
map.on('dragstart', () => closeBottomSheet());

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
            <div class="w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-b-[10px] border-b-emerald-400 absolute -top-1.5 drop-shadow-md"></div>
          </div>

          <div class="relative z-10 w-8 h-8 bg-slate-900 text-white rounded-full border-2 border-white shadow-xl flex items-center justify-center">
            <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6v6"/><path d="M15 6v6"/><path d="M2 12h19.6"/><path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><circle cx="15" cy="18" r="2"/></svg>
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
    color = "#10b981";
    size = 18;
    border = "3px solid #fff; box-shadow: 0 0 12px #10b981;";
  } else if (type === "bus_loc") {
    color = "#f59e0b";
    size = 16;
    border = "3px solid #fff; box-shadow: 0 0 10px #f59e0b;";
  } else if (type === "transfer") {
    color = "#8b5cf6";
    size = 16;
    border = "3px solid #fff; box-shadow: 0 0 12px #8b5cf6;";
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

function getDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const phi1 = lat1 * Math.PI / 180;
  const phi2 = lat2 * Math.PI / 180;
  const dPhi = (lat2 - lat1) * Math.PI / 180;
  const dLam = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dPhi/2) * Math.sin(dPhi/2) + Math.cos(phi1)*Math.cos(phi2) * Math.sin(dLam/2)*Math.sin(dLam/2);
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
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

  let accDist = getDistanceMeters(busLat, busLng, stops[busIdx].lat, stops[busIdx].lng) * 1.18;
  let intermediateStops = 0;

  for (let i = busIdx + 1; i <= targetStopIdx; i++) {
    const prev = stops[i - 1];
    accDist += getDistanceMeters(prev.lat, prev.lng, stops[i].lat, stops[i].lng) * 1.18;
    intermediateStops++;
  }

  return (accDist / speedMps) + (intermediateStops * DWELL_SEC);
}

function calculateAccurateBusToStopDistance(busLat, busLng, targetStopIdx, stops) {
  if (!stops || targetStopIdx < 0 || targetStopIdx >= stops.length) return 0;
  const busIdx = findBusNearestStopIndex(busLat, busLng, stops);
  if (busIdx > targetStopIdx) return 0;

  let accDist = getDistanceMeters(busLat, busLng, stops[busIdx].lat, stops[busIdx].lng) * 1.18;
  for (let i = busIdx + 1; i <= targetStopIdx; i++) {
    const prev = stops[i - 1];
    accDist += getDistanceMeters(prev.lat, prev.lng, stops[i].lat, stops[i].lng) * 1.18;
  }
  return accDist;
}

function calculateTripSummary(pickupStop, destStop, stopsList, effectiveSpeedKmph = 20.0) {
  const pIdx = findStopIndexInList(stopsList, pickupStop);
  const dIdx = findStopIndexInList(stopsList, destStop);
  
  if (pIdx === -1 || dIdx === -1 || pIdx >= dIdx) return null;

  const DWELL_SEC = 20;
  const speedMps = (effectiveSpeedKmph * 1000) / 3600;

  let totalMeters = 0;
  let intermediateStops = 0;

  for (let i = pIdx + 1; i <= dIdx; i++) {
    const prev = stopsList[i - 1];
    const curr = stopsList[i];
    const segmentDist = getDistanceMeters(prev.lat, prev.lng, curr.lat, curr.lng);
    totalMeters += segmentDist * 1.18;
    intermediateStops++;
  }

  const inRideSec = (totalMeters / speedMps) + (intermediateStops * DWELL_SEC);

  return {
    distanceMeters: totalMeters,
    distanceKm: (totalMeters / 1000).toFixed(1),
    rideDurationSec: inRideSec,
    rideDuration: formatEtaTime(inRideSec),
    totalStops: intermediateStops + 1
  };
}

// Strict directional live bus checker
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
// ROBUST DIRECTION STABILIZER
// ==========================================
function updateBusDirectionFromMovement(busPlate, newLat, newLng, newHeading, newSpeedKmph, payloadDir, routeConfig) {
  if (payloadDir && (payloadDir.toUpperCase() === "UP" || payloadDir.toUpperCase() === "DOWN")) {
    return payloadDir.toUpperCase();
  }

  const prev = activeBuses[busPlate];
  if (!routeConfig) return prev ? (prev.busDir || "UP") : "UP";

  const fStops = routeConfig.forwardStops || [];
  const rStops = routeConfig.returnStops || [];

  // Stop index progression check
  if (prev && fStops.length > 0) {
    const moved = getDistanceMeters(prev.lat, prev.lng, newLat, newLng);
    if (moved >= 12.0) {
      const prevIdx = findBusNearestStopIndex(prev.lat, prev.lng, fStops);
      const currIdx = findBusNearestStopIndex(newLat, newLng, fStops);
      if (currIdx > prevIdx) return "UP";
      if (currIdx < prevIdx) return "DOWN";
    }
  }

  // Heading-based direction
  if (newSpeedKmph >= 4.0 && newHeading !== undefined && newHeading !== null && newHeading >= 0) {
    if (newHeading >= 15 && newHeading <= 165) return "UP";
    if (newHeading >= 195 && newHeading <= 345) return "DOWN";
  }

  // Terminal proximity fallback
  if (prev && prev.busDir) {
    return prev.busDir;
  }

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
// 3. AUTOCOMPLETE & SWAP ENGINE
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
      li.className = 'px-3.5 py-2.5 hover:bg-slate-50 cursor-pointer flex items-center gap-3 transition-colors';
      const iconColor = type === 'pickup' ? 'text-emerald-500 bg-emerald-50' : 'text-indigo-500 bg-indigo-50';

      li.innerHTML = `
        <div class="w-7 h-7 rounded-lg ${iconColor} flex items-center justify-center shrink-0">
          <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>
        </div>
        <div class="min-w-0">
          <div class="text-xs sm:text-sm font-semibold text-slate-800 truncate">${stop.name}</div>
          <div class="text-[10px] sm:text-xs text-slate-400 truncate">${stop.area || 'Bus Stop'}</div>
        </div>
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

// ==========================================
// 4. SMART BANNER & ROUTE MODAL
// ==========================================
function updateTripStatusBadge() {
  const connBadge = document.getElementById('connBadge');
  if (!connBadge) return;

  // 1-TRANSFER ROUTE
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
      connBadge.className = "px-2 py-0.5 sm:py-1 rounded-full font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 shadow-sm flex items-center gap-1 text-[11px] whitespace-nowrap shrink-0";
      connBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span><span>Connected</span>`;
    } else if (hasLiveLeg1 || hasLiveLeg2) {
      connBadge.className = "px-2 py-0.5 sm:py-1 rounded-full font-bold bg-amber-50 text-amber-700 border border-amber-200 shadow-sm flex items-center gap-1 text-[11px] whitespace-nowrap shrink-0";
      connBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span><span>Partial Connected</span>`;
    } else {
      connBadge.className = "px-2 py-0.5 sm:py-1 rounded-full font-bold bg-slate-100 text-slate-600 border border-slate-200 shadow-sm flex items-center gap-1 text-[11px] whitespace-nowrap shrink-0";
      connBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-slate-400"></span><span>Scheduled</span>`;
    }
    return;
  }

  // DIRECT ROUTE
  if (activeRouteKey && currentStopsList.length > 0) {
    const pIdx = selectedPickupStop ? findStopIndexInList(currentStopsList, selectedPickupStop) : -1;
    const hasLiveDirectBus = checkLegLiveAvailability(activeRouteKey, currentDirection, pIdx, currentStopsList);

    if (hasLiveDirectBus) {
      connBadge.className = "px-2 py-0.5 sm:py-1 rounded-full font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 shadow-sm flex items-center gap-1 text-[11px] whitespace-nowrap shrink-0";
      connBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span><span>Connected</span>`;
    } else {
      connBadge.className = "px-2 py-0.5 sm:py-1 rounded-full font-bold bg-slate-100 text-slate-600 border border-slate-200 shadow-sm flex items-center gap-1 text-[11px] whitespace-nowrap shrink-0";
      connBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-slate-400"></span><span>Scheduled</span>`;
    }
    return;
  }

  // DEFAULT
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
          <span class="text-emerald-600 font-bold">➔</span>
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
      <span class="text-emerald-600 font-bold">➔</span> 
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
    card.className = "p-2.5 sm:p-3 rounded-2xl border border-slate-200/80 bg-slate-50/60 flex items-center justify-between hover:border-emerald-500 transition-all";
    card.innerHTML = `
      <div class="flex items-center gap-2.5 sm:gap-3">
        <div class="px-2 py-1 rounded-xl bg-emerald-100/80 text-emerald-800 font-extrabold text-xs shrink-0 border border-emerald-200/60 min-w-[50px] text-center">
          ${config.name}
        </div>
        <div>
          <div class="text-xs font-bold text-slate-800">${lineDir}</div>
          <div class="text-[10px] text-slate-400 mt-0.5">${totalStopsCount} Total Route Stops</div>
        </div>
      </div>
      <div class="text-right">
        ${isLive 
          ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-emerald-100 text-emerald-700 border border-emerald-200 flex items-center gap-1">
               <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>Live Line
             </span>` 
          : `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-200/70 text-slate-500">Scheduled</span>`
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
// 5. UNIFIED TRANSIT DISCOVERY ENGINE
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
    
    // UP Direction
    const pUp = rObj.forwardStops.findIndex(s => normalizeStr(s.name).includes(pNorm) || pNorm.includes(normalizeStr(s.name)) || (s.area && normalizeStr(s.area).includes(pNorm)));
    const dUp = rObj.forwardStops.findIndex(s => normalizeStr(s.name).includes(dNorm) || dNorm.includes(normalizeStr(s.name)) || (s.area && normalizeStr(s.area).includes(dNorm)));
    if (pUp !== -1 && dUp !== -1 && pUp < dUp) {
      directMatches.push({ type: 'DIRECT', routeKey: rKey, direction: "UP", stops: rObj.forwardStops, pIdx: pUp, dIdx: dUp });
      continue;
    }

    // DOWN Direction
    const pDown = rObj.returnStops.findIndex(s => normalizeStr(s.name).includes(pNorm) || pNorm.includes(normalizeStr(s.name)) || (s.area && normalizeStr(s.area).includes(pNorm)));
    const dDown = rObj.returnStops.findIndex(s => normalizeStr(s.name).includes(dNorm) || dNorm.includes(normalizeStr(s.name)) || (s.area && normalizeStr(s.area).includes(dNorm)));
    if (pDown !== -1 && dDown !== -1 && pDown < dDown) {
      directMatches.push({ type: 'DIRECT', routeKey: rKey, direction: "DOWN", stops: rObj.returnStops, pIdx: pDown, dIdx: dDown });
    }
  }

  // 2. 1-Transfer Discovery (Strict Anti-Redundancy & Directional Progress)
  for (const r1Key of allRouteKeys) {
    const r1 = window.ROUTES_DATABASE[r1Key];
    const directions1 = [
      { dir: "UP", stops: r1.forwardStops },
      { dir: "DOWN", stops: r1.returnStops }
    ];

    for (const leg1 of directions1) {
      let pIdx = leg1.stops.findIndex(s => normalizeStr(s.name).includes(pNorm) || pNorm.includes(normalizeStr(s.name)) || (s.area && normalizeStr(s.area).includes(pNorm)));
      if (pIdx === -1) continue;

      // Skip transfer if this route already directly reaches destination
      let directDIdx = leg1.stops.findIndex(s => normalizeStr(s.name).includes(dNorm) || dNorm.includes(normalizeStr(s.name)) || (s.area && normalizeStr(s.area).includes(dNorm)));
      if (directDIdx !== -1 && directDIdx > pIdx) {
        continue;
      }

      const pStop = leg1.stops[pIdx];

      for (const r2Key of allRouteKeys) {
        if (r2Key === r1Key) continue;
        const r2 = window.ROUTES_DATABASE[r2Key];
        const directions2 = [
          { dir: "UP", stops: r2.forwardStops },
          { dir: "DOWN", stops: r2.returnStops }
        ];

        for (const leg2 of directions2) {
          let d2Idx = leg2.stops.findIndex(s => normalizeStr(s.name).includes(dNorm) || dNorm.includes(normalizeStr(s.name)) || (s.area && normalizeStr(s.area).includes(dNorm)));
          if (d2Idx === -1) continue;

          const dStop = leg2.stops[d2Idx];
          const commonStops = [];

          for (let tIdx = pIdx + 1; tIdx < leg1.stops.length; tIdx++) {
            const transferStop = leg1.stops[tIdx];
            const tNorm = normalizeStr(transferStop.name);

            const t2Idx = leg2.stops.findIndex(s => normalizeStr(s.name).includes(tNorm) || tNorm.includes(normalizeStr(s.name)) || (s.area && normalizeStr(s.area).includes(tNorm)));

            if (t2Idx !== -1 && t2Idx < d2Idx) {
              const distPickupToDest = getDistanceMeters(pStop.lat, pStop.lng, dStop.lat, dStop.lng);
              const distTransferToDest = getDistanceMeters(transferStop.lat, transferStop.lng, dStop.lat, dStop.lng);
              const distLeg1 = getDistanceMeters(pStop.lat, pStop.lng, transferStop.lat, transferStop.lng);
              const distLeg2 = getDistanceMeters(transferStop.lat, transferStop.lng, dStop.lat, dStop.lng);
              const totalTransferDist = distLeg1 + distLeg2;

              // Transfer hub must not move backwards away from destination
              const makesProgress = distTransferToDest < distPickupToDest + 350;
              const isReasonableTotalDist = totalTransferDist <= Math.max(distPickupToDest * 1.6, 7000);

              if (makesProgress && isReasonableTotalDist) {
                commonStops.push({
                  transferStopName: transferStop.name,
                  tIdx: tIdx,
                  t2Idx: t2Idx,
                  totalDist: totalTransferDist,
                  leg1StopsCount: tIdx - pIdx,
                  distTransferToDest: distTransferToDest
                });
              }
            }
          }

          if (commonStops.length > 0) {
            commonStops.sort((a, b) => a.distTransferToDest - b.distTransferToDest || a.totalDist - b.totalDist);
            const bestTransfer = commonStops[0];

            // Validate live bus direction strictly
            const isLeg1Live = checkLegLiveAvailability(r1Key, leg1.dir, pIdx, leg1.stops);
            const isLeg2Live = checkLegLiveAvailability(r2Key, leg2.dir, bestTransfer.t2Idx, leg2.stops);

            rawTransfers.push({
              type: 'TRANSFER',
              transferStopName: bestTransfer.transferStopName,
              totalDist: bestTransfer.totalDist,
              leg1StopsCount: bestTransfer.leg1StopsCount,
              hasLiveLeg1: isLeg1Live,
              hasLiveLeg2: isLeg2Live,
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

  // Deduplicate transfer combinations
  const uniqueTransfersMap = new Map();
  rawTransfers.forEach(plan => {
    const key = `${normalizeStr(plan.leg1.routeKey)}_${normalizeStr(plan.leg2.routeKey)}_${normalizeStr(plan.transferStopName)}`;
    if (!uniqueTransfersMap.has(key) || (plan.hasLiveLeg1 && !uniqueTransfersMap.get(key).hasLiveLeg1)) {
      uniqueTransfersMap.set(key, plan);
    }
  });

  const candidateTransfers = Array.from(uniqueTransfersMap.values());
  candidateTransfers.sort((a, b) => {
    const liveScoreA = (a.hasLiveLeg1 ? 2 : 0) + (a.hasLiveLeg2 ? 1 : 0);
    const liveScoreB = (b.hasLiveLeg1 ? 2 : 0) + (b.hasLiveLeg2 ? 1 : 0);
    return liveScoreB - liveScoreA || a.totalDist - b.totalDist;
  });

  const topTransfers = candidateTransfers.slice(0, 2);
  return { direct: directMatches, transfers: topTransfers };
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

  const hasDirect = lastSearchResult.direct.length > 0;
  const hasTransfers = lastSearchResult.transfers.length > 0;

  if (!hasDirect && !hasTransfers) {
    alert("No direct or connecting route found between these locations in this direction.");
    return;
  }

  const hasLiveDirect = hasDirect && lastSearchResult.direct.some(d => {
    return checkLegLiveAvailability(d.routeKey, d.direction, d.pIdx, d.stops);
  });

  const hasLiveTransfer = hasTransfers && lastSearchResult.transfers.some(t => t.hasLiveLeg1);

  if (window.innerWidth < 768) {
    switchMobileTab('buses');
  }

  // Priority Selection Cascade
  if (hasLiveDirect) {
    selectDirectOption(0, false);
  } else if (hasLiveTransfer && !hasDirect) {
    selectTransferOption(0, false);
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

  if (!maintainTracking) {
    cancelTracking();
  }

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

  if (upcomingBuses.length > 0) {
    selectedBusPlate = upcomingBuses[0].plate;
  } else {
    selectedBusPlate = null;
  }

  if (isTrackingConfirmed) {
    renderRoutePins(true);
    if (selectedBusPlate && activeBuses[selectedBusPlate]) {
      const b = activeBuses[selectedBusPlate];
      updateStopsTable(b.lat, b.lng, b.spd);
    } else {
      renderSchedulePreview();
    }
  } else {
    document.getElementById("stopsTable")?.classList.add("hidden");
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

  if (!maintainTracking) {
    cancelTracking();
  }

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

  if (upcomingLeg1Buses.length > 0) {
    selectedBusPlate = upcomingLeg1Buses[0].plate;
  } else {
    selectedBusPlate = null;
  }

  if (isTrackingConfirmed) {
    renderRoutePins(true);
    if (selectedBusPlate && activeBuses[selectedBusPlate]) {
      const b = activeBuses[selectedBusPlate];
      updateStopsTable(b.lat, b.lng, b.spd);
    } else {
      renderSchedulePreview();
    }
  } else {
    document.getElementById("stopsTable")?.classList.add("hidden");
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
    alert("Please select your stops and click Search first!");
    return;
  }

  hasAutoScrolledForCurrentTrip = false;

  if (currentTripPlanType === "TRANSFER" && activeTransferPlan) {
    const upcomingLeg1Buses = Object.values(activeBuses).filter(b => {
      const isLine = normalizeStr(b.routeKey || b.route).includes(normalizeStr(activeTransferPlan.leg1.routeKey)) || normalizeStr(activeTransferPlan.leg1.routeKey).includes(normalizeStr(b.routeKey || b.route));
      if (!isLine || b.busDir !== activeTransferPlan.leg1.direction) return false;
      const bIdx = findBusNearestStopIndex(b.lat, b.lng, activeTransferPlan.leg1.stops);
      return bIdx <= activeTransferPlan.leg1.pIdx;
    });

    if (upcomingLeg1Buses.length > 0) {
      selectedBusPlate = upcomingLeg1Buses[0].plate;
    }
  }

  isTrackingConfirmed = true;
  
  document.getElementById("stopsTable")?.classList.remove("hidden");
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

  document.getElementById("stopsTable")?.classList.add("hidden");
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
// 6. UNIFIED SCHEDULE TIMELINE PREVIEW
// ==========================================
function renderSchedulePreview() {
  if (!isTrackingConfirmed) {
    document.getElementById("stopsTable")?.classList.add("hidden");
    document.getElementById("noTrackPlaceholder")?.classList.remove("hidden");
    return;
  }

  document.getElementById("stopsTable")?.classList.remove("hidden");
  document.getElementById("noTrackPlaceholder")?.classList.add("hidden");

  const tbody = document.getElementById("stopsTableBody");
  tbody.innerHTML = "";

  // 1-TRANSFER SCHEDULE
  if (currentTripPlanType === "TRANSFER" && activeTransferPlan) {
    const leg1Stops = activeTransferPlan.leg1.stops.slice(activeTransferPlan.leg1.pIdx, activeTransferPlan.leg1.tIdx + 1);
    const leg2Stops = activeTransferPlan.leg2.stops.slice(activeTransferPlan.leg2.tIdx + 1, activeTransferPlan.leg2.dIdx + 1);

    const r1Name = window.ROUTES_DATABASE[activeTransferPlan.leg1.routeKey]?.name || "Bus 1";
    const r2Name = window.ROUTES_DATABASE[activeTransferPlan.leg2.routeKey]?.name || "Bus 2";

    let stepNum = 1;
    let accLeg1Dist = 0;

    leg1Stops.forEach((stop, idx) => {
      const isBoarding = (idx === 0);
      const isTransferPoint = (idx === leg1Stops.length - 1);
      
      let rowClass = isBoarding ? "bg-emerald-50/80 border-l-4 border-emerald-500 font-bold text-slate-900 active-target-stop" : "";
      if (isTransferPoint) rowClass = "bg-amber-50/80 border-l-4 border-amber-500 font-bold text-slate-900";

      let distText = "--";
      if (!isBoarding) {
        const prev = leg1Stops[idx - 1];
        accLeg1Dist += getDistanceMeters(prev.lat, prev.lng, stop.lat, stop.lng) * 1.18;
        distText = `+${(accLeg1Dist / 1000).toFixed(1)} km ride`;
      } else {
        distText = "Origin";
      }

      const tr = document.createElement("tr");
      if (rowClass) tr.className = rowClass;
      tr.innerHTML = `
        <td class="py-2 px-1.5 sm:p-2.5 pl-2.5 sm:pl-4 font-bold">${stepNum++}</td>
        <td class="py-2 px-1.5 sm:p-2.5 font-semibold text-slate-800">${stop.name} <span class="text-[9px] text-sky-700 font-bold">(${r1Name})</span></td>
        <td class="py-2 px-1.5 sm:p-2.5 text-slate-500 font-medium whitespace-nowrap">${distText}</td>
        <td class="py-2 px-1.5 sm:p-2.5 text-slate-500 text-[10px] sm:text-[11px]">${isBoarding ? "Board First Bus" : (isTransferPoint ? "Alight for Transfer" : "Ride")}</td>
        <td class="py-2 px-1.5 sm:p-2.5 pr-2.5 sm:pr-4 text-right sm:text-left"><span class="px-1.5 sm:px-2 py-0.5 rounded text-[10px] sm:text-[11px] font-bold bg-slate-100 text-slate-500">Scheduled</span></td>
      `;
      tbody.appendChild(tr);
    });

    const transferTr = document.createElement("tr");
    transferTr.className = "bg-amber-100/70 font-extrabold text-amber-900";
    transferTr.innerHTML = `
      <td class="p-1.5 pl-3 sm:pl-4 text-center">🔄</td>
      <td colspan="4" class="p-1.5 text-xs">Switch to <span class="underline decoration-amber-600 font-black">${r2Name}</span> towards ${selectedDestStop.name}</td>
    `;
    tbody.appendChild(transferTr);

    let accLeg2Dist = accLeg1Dist;
    leg2Stops.forEach((stop, idx) => {
      const isFinal = (idx === leg2Stops.length - 1);
      const prev = idx === 0 ? activeTransferPlan.leg2.stops[activeTransferPlan.leg2.tIdx] : leg2Stops[idx - 1];
      accLeg2Dist += getDistanceMeters(prev.lat, prev.lng, stop.lat, stop.lng) * 1.18;
      const distText = `+${(accLeg2Dist / 1000).toFixed(1)} km ride`;

      const tr = document.createElement("tr");
      if (isFinal) tr.className = "bg-rose-50/80 border-l-4 border-rose-500 font-bold text-slate-900";
      tr.innerHTML = `
        <td class="py-2 px-1.5 sm:p-2.5 pl-2.5 sm:pl-4 font-bold">${stepNum++}</td>
        <td class="py-2 px-1.5 sm:p-2.5 font-semibold text-slate-800">${stop.name} <span class="text-[9px] text-amber-700 font-bold">(${r2Name})</span></td>
        <td class="py-2 px-1.5 sm:p-2.5 text-slate-500 font-medium whitespace-nowrap">${distText}</td>
        <td class="py-2 px-1.5 sm:p-2.5 text-slate-500 text-[10px] sm:text-[11px]">${isFinal ? "🏁 Final Destination" : "Connecting Ride"}</td>
        <td class="py-2 px-1.5 sm:p-2.5 pr-2.5 sm:pr-4 text-right sm:text-left"><span class="px-1.5 sm:px-2 py-0.5 rounded text-[10px] sm:text-[11px] font-bold bg-slate-100 text-slate-500">Scheduled</span></td>
      `;
      tbody.appendChild(tr);
    });

    scrollTableToActiveRow();
    return;
  }

  // DIRECT ROUTE SCHEDULE
  const pIdx = selectedPickupStop ? findStopIndexInList(currentStopsList, selectedPickupStop) : 0;
  const dIdx = selectedDestStop ? findStopIndexInList(currentStopsList, selectedDestStop) : currentStopsList.length - 1;

  const validP = (pIdx !== -1) ? pIdx : 0;
  const validD = (dIdx !== -1 && dIdx >= validP) ? dIdx : currentStopsList.length - 1;
  const journeyStops = currentStopsList.slice(validP, validD + 1);
  const rName = window.ROUTES_DATABASE[activeRouteKey]?.name || "Direct";

  let accRideDist = 0;

  journeyStops.forEach((stop, idx) => {
    const isBoarding = (idx === 0);
    const isFinal = (idx === journeyStops.length - 1);

    let rowClass = "";
    let progressLabel = "Ride";
    let distText = "--";

    if (isBoarding) {
      rowClass = "bg-emerald-50/80 border-l-4 border-emerald-500 font-bold text-slate-900 active-target-stop";
      progressLabel = "Board Bus";
      distText = "Origin";
    } else {
      const prev = journeyStops[idx - 1];
      accRideDist += getDistanceMeters(prev.lat, prev.lng, stop.lat, stop.lng) * 1.18;
      distText = `+${(accRideDist / 1000).toFixed(1)} km ride`;
    }

    if (isFinal) {
      rowClass = "bg-rose-50/80 border-l-4 border-rose-500 font-bold text-slate-900";
      progressLabel = "🏁 Final Destination";
    }

    const tr = document.createElement("tr");
    if (rowClass) tr.className = rowClass;
    tr.innerHTML = `
      <td class="py-2 px-1.5 sm:p-2.5 pl-2.5 sm:pl-4 font-bold">${idx + 1}</td>
      <td class="py-2 px-1.5 sm:p-2.5 font-semibold text-slate-800">${stop.name} <span class="text-[9px] text-sky-700 font-bold">(${rName})</span></td>
      <td class="py-2 px-1.5 sm:p-2.5 text-slate-500 font-medium whitespace-nowrap">${distText}</td>
      <td class="py-2 px-1.5 sm:p-2.5 text-slate-500 text-[10px] sm:text-[11px]">${progressLabel}</td>
      <td class="py-2 px-1.5 sm:p-2.5 pr-2.5 sm:pr-4 text-right sm:text-left"><span class="px-1.5 sm:px-2 py-0.5 rounded text-[10px] sm:text-[11px] font-bold bg-slate-100 text-slate-500">Scheduled</span></td>
    `;
    tbody.appendChild(tr);
  });

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

  // 1-TRANSFER POLYLINE RENDERING
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

  // DIRECT ROUTE POLYLINE RENDERING
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
// 7. UNIFIED BUS & ROUTE LIST RENDERER
// ==========================================
function updateAvailableBusesList() {
  const container = document.getElementById("busesListContainer");
  const floatingCard = document.getElementById("floatingBusCard");
  if (!container || !lastSearchResult) return;

  const previousScrollTop = container.scrollTop;
  container.innerHTML = "";

  const allCards = [];

  // 1. Process 1-Transfer Options
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
          document.getElementById('floatBusPlate').innerHTML = `
            <div class="flex items-center gap-1.5 flex-nowrap">
              <span class="font-bold text-slate-900">${liveBus.plate}</span>
              <span class="text-[10px] font-extrabold text-violet-800 bg-violet-100/90 px-1.5 py-0.2 rounded border border-violet-200 whitespace-nowrap flex items-center gap-1">
                <span>➔</span>
                <span>1-Transfer</span>
              </span>
            </div>
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
          <span class="inline-flex items-center gap-1.5 text-[11px] font-bold text-emerald-600">
            <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
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
      card.className = `bg-white border ${isSelectedPlan ? (isLeg1Live ? 'border-violet-500 ring-2 ring-violet-500/10' : 'border-slate-400 ring-2 ring-slate-400/10') : 'border-slate-200'} hover:border-violet-500 rounded-2xl p-3 shadow-sm transition-all duration-200 hover:shadow-md cursor-pointer mb-2.5`;
      card.onclick = () => {
        selectTransferOption(planIdx, isCurrentlyTracked);
      };

      card.innerHTML = `
        <div class="flex items-center justify-between pb-2 border-b border-slate-100">
          <div>
            ${planIdx === 0 && isLeg1Live ? `
              <span class="inline-flex items-center gap-1 bg-violet-600 text-white text-[9px] sm:text-[10px] font-extrabold px-2 py-0.5 rounded-md shadow-sm">
                ★ Best Transfer
              </span>
            ` : `
              <span class="text-[9px] sm:text-[10px] font-bold text-slate-400 uppercase tracking-wider">1-Transfer Route</span>
            `}
          </div>
          ${badgeHtml}
        </div>

        <div class="mt-2.5">
          <div class="flex items-baseline justify-between gap-2">
            <div class="text-base sm:text-lg font-black ${isLeg1Live ? 'text-violet-700' : 'text-slate-700'} tracking-tight flex items-center gap-1.5 flex-wrap">
              <span>${r1Name}</span>
              <span class="text-xs text-slate-400 font-normal">➔</span>
              <span>${r2Name}</span>
            </div>
            <div class="text-right shrink-0">
              <div class="text-sm sm:text-base font-black ${isLeg1Live ? 'text-emerald-600' : 'text-slate-600'} leading-tight">${etaStr}</div>
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

        <div class="flex items-center justify-between text-[10px] sm:text-[11px] font-medium text-slate-500 mt-2.5 pt-2 border-t border-slate-100">
          <span class="font-mono font-bold text-slate-600">${liveBus ? liveBus.plate : 'Timetable'}</span>
          <span class="flex items-center gap-1 text-slate-500">
            <i data-lucide="${isLeg1Live ? 'radio' : 'calendar'}" class="w-3 h-3 text-slate-400"></i> ${isAllLive ? 'Full Live' : (isPartialLive ? 'Partial Live' : 'Scheduled')}
          </span>
          <span class="flex items-center gap-1 text-slate-500">
            <i data-lucide="git-merge" class="w-3 h-3 text-slate-400"></i> Change Hub
          </span>
        </div>

        <div class="mt-2.5">
          ${isCurrentlyTracked ? `
            <button onclick="event.stopPropagation(); cancelTracking();" class="w-full bg-rose-600 hover:bg-rose-700 active:scale-[0.98] text-white font-bold text-xs py-2 px-3.5 rounded-xl shadow-md shadow-rose-600/20 flex items-center justify-center gap-1.5 transition-all">
              <i data-lucide="x" class="w-3.5 h-3.5"></i>
              <span>Cancel Tracking</span>
            </button>
          ` : `
            <button onclick="event.stopPropagation(); selectTransferOption(${planIdx}, false); startTracking();" class="w-full ${isLeg1Live ? 'bg-violet-600 hover:bg-violet-700 shadow-violet-600/20' : 'bg-slate-800 hover:bg-slate-900'} active:scale-[0.98] text-white font-bold text-xs py-2 px-3.5 rounded-xl shadow-md flex items-center justify-center gap-1.5 transition-all">
              <i data-lucide="${isLeg1Live ? 'bus' : 'git-merge'}" class="w-3.5 h-3.5"></i>
              <span>${isLeg1Live ? 'Track this bus & route' : 'Track Scheduled Route'}</span>
            </button>
          `}
        </div>
      `;

      allCards.push({ priority: isLeg1Live ? 1 : 4, etaSec: etaSec, elem: card });
    });
  }

  // 2. Process Direct Routes (Live & Scheduled)
  if (lastSearchResult.direct && lastSearchResult.direct.length > 0) {
    const effectiveStops = (currentTripPlanType === "DIRECT" && currentStopsList.length > 0) ? currentStopsList : lastSearchResult.direct[0].stops;
    let userPickupIdx = selectedPickupStop ? findStopIndexInList(effectiveStops, selectedPickupStop) : -1;
    let userDestIdx = selectedDestStop ? findStopIndexInList(effectiveStops, selectedDestStop) : -1;

    const allowedRouteKeys = lastSearchResult.direct.map(r => normalizeStr(r.routeKey));
    const viableBuses = [];

    Object.entries(activeBuses).forEach(([plate, bus]) => {
      const busRouteNorm = normalizeStr(bus.routeKey || bus.route);
      const isCorridorMatch = allowedRouteKeys.some(rKey => busRouteNorm.includes(rKey) || rKey.includes(busRouteNorm));
      const isSameDir = (bus.busDir === currentDirection);

      if (!isCorridorMatch || !isSameDir) return;

      const busCurrentIdx = findBusNearestStopIndex(bus.lat, bus.lng, effectiveStops);
      const busLocName = effectiveStops[busCurrentIdx]?.name || "En Route";

      if (userPickupIdx !== -1 && busCurrentIdx > userPickupIdx) return;
      if (userDestIdx !== -1 && busCurrentIdx >= userDestIdx) return;

      const etaSec = userPickupIdx !== -1 ? calculateEtaSeconds(bus.lat, bus.lng, bus.spd, userPickupIdx, effectiveStops) : Infinity;
      const distMeters = userPickupIdx !== -1 ? calculateAccurateBusToStopDistance(bus.lat, bus.lng, userPickupIdx, effectiveStops) : 0;
      const stopsAway = Math.max(0, userPickupIdx - busCurrentIdx);

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
          document.getElementById('floatBusPlate').innerHTML = `
            <div class="flex items-center gap-1.5 flex-nowrap">
              <span class="font-bold text-slate-900">${activeSelectedBus.plate}</span>
              <span class="text-[10px] font-extrabold text-sky-800 bg-sky-100/90 px-1.5 py-0.2 rounded border border-sky-200 whitespace-nowrap flex items-center gap-1">
                <span>➔</span>
                <span>${selectedDestStop ? selectedDestStop.name : 'En Route'}</span>
              </span>
            </div>
          `;
          document.getElementById('floatTelemetry').innerText = `Near: ${activeSelectedBus.currentLocationName} • Speed: ${activeSelectedBus.bus.spd.toFixed(1)} km/h`;
        }
      }

      viableBuses.forEach((item, rank) => {
        const isSelected = (currentTripPlanType === "DIRECT" && item.plate === selectedBusPlate);
        const isBest = (rank === 0);
        const cardinalDir = (item.bus.busDir === "UP") ? "North Bound" : "South Bound";
        const isCurrentlyTracked = isTrackingConfirmed && isSelected;

        const card = document.createElement("div");
        card.className = `bg-white border ${isSelected ? 'border-emerald-500 ring-2 ring-emerald-500/10' : 'border-slate-200'} hover:border-emerald-500 rounded-2xl p-3 shadow-sm transition-all duration-200 hover:shadow-md cursor-pointer mb-2.5`;
        card.onclick = () => {
          selectBus(item.plate);
        };

        card.innerHTML = `
          <div class="flex items-center justify-between pb-2 border-b border-slate-100">
            <div>
              ${isBest ? `
                <span class="inline-flex items-center gap-1 bg-emerald-600 text-white text-[9px] sm:text-[10px] font-extrabold px-2 py-0.5 rounded-md shadow-sm">
                  ★ Best Option
                </span>
              ` : `
                <span class="text-[9px] sm:text-[10px] font-bold text-slate-400 uppercase tracking-wider">Alternate</span>
              `}
            </div>
            <span class="inline-flex items-center gap-1.5 text-[11px] font-bold text-emerald-600">
              <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
              Live
            </span>
          </div>

          <div class="flex items-center justify-between mt-2.5 gap-2">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-xl sm:text-2xl font-black text-emerald-600 tracking-tight shrink-0">${item.bus.route}</span>
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
              <div class="text-base sm:text-lg font-black text-emerald-600 leading-tight">${item.etaLabel}</div>
              <div class="text-[9px] sm:text-[10px] text-slate-400 whitespace-nowrap">${item.stopsAway === 0 ? 'Approaching' : `${item.stopsAway} stops away`}</div>
            </div>
          </div>

          <div class="flex items-center justify-between text-[10px] sm:text-[11px] font-medium text-slate-500 mt-2.5 pt-2 border-t border-slate-100">
            <span class="font-mono font-bold text-slate-700">${item.bus.plate}</span>
            <span class="flex items-center gap-1 text-slate-500">
              <i data-lucide="radio" class="w-3 h-3 text-slate-400"></i> Live
            </span>
            <span class="flex items-center gap-1 text-slate-600">
              <i data-lucide="navigation" class="w-3 h-3 text-slate-400"></i> ${cardinalDir}
            </span>
          </div>

          <div class="mt-2.5">
            ${isCurrentlyTracked ? `
              <button onclick="event.stopPropagation(); cancelTracking();" class="w-full bg-rose-600 hover:bg-rose-700 active:scale-[0.98] text-white font-bold text-xs py-2 px-3.5 rounded-xl shadow-md shadow-rose-600/20 flex items-center justify-center gap-1.5 transition-all">
                <i data-lucide="x" class="w-3.5 h-3.5"></i>
                <span>Cancel Tracking</span>
              </button>
            ` : `
              <button onclick="event.stopPropagation(); selectBus('${item.plate}'); startTracking();" class="w-full bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] text-white font-bold text-xs py-2 px-3.5 rounded-xl shadow-md shadow-emerald-600/20 flex items-center justify-center gap-1.5 transition-all">
                <i data-lucide="bus" class="w-3.5 h-3.5"></i>
                <span>Track this bus</span>
              </button>
            `}
          </div>
        `;

        allCards.push({ priority: 0, etaSec: item.etaSec, elem: card });
      });
    } else {
      // Direct Scheduled Cards
      lastSearchResult.direct.forEach((r, rIdx) => {
        const config = window.ROUTES_DATABASE[r.routeKey];
        if (!config) return;

        const isSelected = (currentTripPlanType === "DIRECT" && activeRouteKey === r.routeKey);
        const isCurrentlyTracked = isTrackingConfirmed && isSelected;
        const totalStopsCount = Math.max(1, (r.dIdx - r.pIdx + 1));

        const card = document.createElement("div");
        card.className = `bg-white border ${isSelected ? 'border-slate-400 ring-2 ring-slate-400/10' : 'border-slate-200'} hover:border-slate-400 rounded-2xl p-3 shadow-sm transition-all duration-200 hover:shadow-md cursor-pointer mb-2.5`;
        card.onclick = () => selectDirectOption(rIdx, isCurrentlyTracked);

        card.innerHTML = `
          <div class="flex items-center justify-between pb-2 border-b border-slate-100">
            <div>
              <span class="text-[9px] sm:text-[10px] font-bold text-slate-400 uppercase tracking-wider">Direct Route</span>
            </div>
            <span class="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-400">
              <span class="w-2 h-2 rounded-full bg-slate-300"></span>
              No Active Bus
            </span>
          </div>

          <div class="mt-2.5">
            <div class="flex items-baseline justify-between gap-2">
              <div class="text-base sm:text-lg font-black text-slate-700 tracking-tight truncate">
                ${config.name}
              </div>
              <div class="text-right shrink-0">
                <div class="text-sm sm:text-base font-black text-slate-600 leading-tight">Scheduled</div>
                <div class="text-[9px] sm:text-[10px] text-slate-400">Timetable</div>
              </div>
            </div>

            <div class="text-xs font-bold text-slate-800 truncate mt-1">
              ${selectedPickupStop ? selectedPickupStop.name : 'Origin'} 
              <span class="text-slate-400 font-normal">➔</span> 
              ${selectedDestStop ? selectedDestStop.name : 'Destination'}
            </div>
            <div class="text-[10px] text-slate-500 font-semibold mt-0.5 flex items-center gap-1 truncate">
              <span>Direct Corridor</span>
              <span class="text-slate-400 font-normal shrink-0">(${totalStopsCount} stops)</span>
            </div>
          </div>

          <div class="flex items-center justify-between text-[10px] sm:text-[11px] font-medium text-slate-500 mt-2.5 pt-2 border-t border-slate-100">
            <span class="font-mono font-bold text-slate-600">Timetable</span>
            <span class="flex items-center gap-1 text-slate-500">
              <i data-lucide="calendar" class="w-3 h-3 text-slate-400"></i> Scheduled
            </span>
            <span class="flex items-center gap-1 text-slate-500">
              <i data-lucide="map-pin" class="w-3 h-3 text-slate-400"></i> Direct Line
            </span>
          </div>

          <div class="mt-2.5">
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
    document.getElementById("stopsTable")?.classList.add("hidden");
    document.getElementById("noTrackPlaceholder")?.classList.remove("hidden");
    return;
  }

  document.getElementById("stopsTable")?.classList.remove("hidden");
  document.getElementById("noTrackPlaceholder")?.classList.add("hidden");

  if (!selectedBusPlate || !activeBuses[selectedBusPlate]) {
    renderSchedulePreview();
    return;
  }

  if (currentTripPlanType === "TRANSFER" && activeTransferPlan) {
    const tbody = document.getElementById("stopsTableBody");
    tbody.innerHTML = "";

    const busAbsoluteIdx = findBusNearestStopIndex(busLat, busLng, activeTransferPlan.leg1.stops);
    busNearestStopIdx = busAbsoluteIdx;

    const startSpanIdx = Math.min(busAbsoluteIdx, activeTransferPlan.leg1.pIdx);
    const leg1Stops = activeTransferPlan.leg1.stops.slice(startSpanIdx, activeTransferPlan.leg1.tIdx + 1);
    const leg2Stops = activeTransferPlan.leg2.stops.slice(activeTransferPlan.leg2.tIdx + 1, activeTransferPlan.leg2.dIdx + 1);

    const r1Name = window.ROUTES_DATABASE[activeTransferPlan.leg1.routeKey]?.name || "Bus 1";
    const r2Name = window.ROUTES_DATABASE[activeTransferPlan.leg2.routeKey]?.name || "Bus 2";

    let rideStepNum = 1;
    let accRideDist = 0;

    leg1Stops.forEach((stop, idx) => {
      const actualStopIdx = startSpanIdx + idx;
      let rowClass = "";
      let badgeClass = "bg-sky-50 text-sky-700 border border-sky-200";
      let distLabel = "--";
      let etaLabel = "--";
      let remLabel = "--";
      let displayStepNum = "";

      if (actualStopIdx < activeTransferPlan.leg1.pIdx) {
        displayStepNum = `<span class="text-amber-500 font-black text-xs">●</span>`;
        const dMeters = calculateAccurateBusToStopDistance(busLat, busLng, actualStopIdx, activeTransferPlan.leg1.stops);
        distLabel = dMeters >= 1000 ? `${(dMeters / 1000).toFixed(1)} km away` : `${Math.round(dMeters)} m away`;
      } else if (actualStopIdx === activeTransferPlan.leg1.pIdx) {
        displayStepNum = `${rideStepNum++}`;
        const dToPickup = calculateAccurateBusToStopDistance(busLat, busLng, activeTransferPlan.leg1.pIdx, activeTransferPlan.leg1.stops);
        distLabel = dToPickup >= 1000 ? `${(dToPickup / 1000).toFixed(1)} km away` : `${Math.round(dToPickup)} m away`;
      } else {
        displayStepNum = `${rideStepNum++}`;
        const prevIdx = Math.max(0, actualStopIdx - 1);
        const prev = activeTransferPlan.leg1.stops[prevIdx] || stop;
        accRideDist += getDistanceMeters(prev.lat, prev.lng, stop.lat, stop.lng) * 1.18;
        distLabel = `+${(accRideDist / 1000).toFixed(1)} km ride`;
      }

      const dDirectToStop = getDistanceMeters(busLat, busLng, stop.lat, stop.lng);

      if (busAbsoluteIdx > actualStopIdx) {
        etaLabel = "Departed";
        badgeClass = "bg-slate-100 text-slate-400";
        remLabel = "Missed";
        rowClass = "opacity-40";
      } else if (actualStopIdx === busAbsoluteIdx && busAbsoluteIdx < activeTransferPlan.leg1.pIdx) {
        rowClass = "bg-amber-50/90 border-l-4 border-amber-500 font-bold text-slate-900 active-target-stop";
        if (dDirectToStop <= 100) {
          etaLabel = "Bus Here";
        } else {
          const stopEtaSec = calculateEtaSeconds(busLat, busLng, currentSpeedKmph, actualStopIdx, activeTransferPlan.leg1.stops);
          etaLabel = formatEtaTime(stopEtaSec);
        }
        remLabel = "🟡 Live Location";
      } else if (actualStopIdx === activeTransferPlan.leg1.pIdx) {
        rowClass = "bg-emerald-50/80 border-l-4 border-emerald-500 font-bold text-slate-900 active-target-stop";
        const stopEtaSec = calculateEtaSeconds(busLat, busLng, currentSpeedKmph, actualStopIdx, activeTransferPlan.leg1.stops);
        etaLabel = formatEtaTime(stopEtaSec);
        const stopsToPickup = actualStopIdx - busAbsoluteIdx;
        
        if (stopsToPickup === 0) {
          remLabel = (dDirectToStop <= 100) ? "🟢 Arrived" : "🟢 Approaching";
        } else {
          remLabel = `🟢 Boarding (${stopsToPickup} away)`;
        }
      } else if (idx === leg1Stops.length - 1) {
        rowClass = "bg-amber-50/80 border-l-4 border-amber-500 font-bold text-slate-900";
        const stopEtaSec = calculateEtaSeconds(busLat, busLng, currentSpeedKmph, actualStopIdx, activeTransferPlan.leg1.stops);
        etaLabel = formatEtaTime(stopEtaSec);
        remLabel = "🔄 Transfer Hub";
      } else if (actualStopIdx < activeTransferPlan.leg1.pIdx) {
        const stopEtaSec = calculateEtaSeconds(busLat, busLng, currentSpeedKmph, actualStopIdx, activeTransferPlan.leg1.stops);
        etaLabel = formatEtaTime(stopEtaSec);
        const stopsAway = actualStopIdx - busAbsoluteIdx;
        remLabel = `Approach • ${stopsAway} stop${stopsAway > 1 ? 's' : ''}`;
      } else {
        const stopEtaSec = calculateEtaSeconds(busLat, busLng, currentSpeedKmph, actualStopIdx, activeTransferPlan.leg1.stops);
        etaLabel = formatEtaTime(stopEtaSec);
        const inRideStops = actualStopIdx - activeTransferPlan.leg1.pIdx;
        remLabel = `+${inRideStops} stop${inRideStops > 1 ? 's' : ''} ride`;
      }

      const tr = document.createElement("tr");
      if (rowClass) tr.className = rowClass;
      tr.innerHTML = `
        <td class="py-2 px-1.5 sm:p-2.5 pl-2.5 sm:pl-4 font-bold">${displayStepNum}</td>
        <td class="py-2 px-1.5 sm:p-2.5 font-semibold text-slate-800">${stop.name} <span class="text-[9px] text-sky-700 font-bold">(${r1Name})</span></td>
        <td class="py-2 px-1.5 sm:p-2.5 text-slate-600 font-medium whitespace-nowrap">${distLabel}</td>
        <td class="py-2 px-1.5 sm:p-2.5 text-slate-600 text-[10px] sm:text-[11px]">${remLabel}</td>
        <td class="py-2 px-1.5 sm:p-2.5 pr-2.5 sm:pr-4 text-right sm:text-left"><span class="px-1.5 sm:px-2 py-0.5 rounded text-[10px] sm:text-[11px] font-bold ${badgeClass}">${etaLabel}</span></td>
      `;
      tbody.appendChild(tr);
    });

    const transferTr = document.createElement("tr");
    transferTr.className = "bg-amber-100/70 font-extrabold text-amber-900";
    transferTr.innerHTML = `
      <td class="p-1.5 pl-3 sm:pl-4 text-center">🔄</td>
      <td colspan="4" class="p-1.5 text-xs">Switch to <span class="underline decoration-amber-600 font-black">${r2Name}</span> towards ${selectedDestStop.name}</td>
    `;
    tbody.appendChild(transferTr);

    leg2Stops.forEach((stop, idx) => {
      const isFinal = (idx === leg2Stops.length - 1);
      const prev = idx === 0 ? activeTransferPlan.leg2.stops[activeTransferPlan.leg2.tIdx] : leg2Stops[idx - 1];
      accRideDist += getDistanceMeters(prev.lat, prev.lng, stop.lat, stop.lng) * 1.18;
      const distLabel = `+${(accRideDist / 1000).toFixed(1)} km ride`;

      const tr = document.createElement("tr");
      if (isFinal) tr.className = "bg-rose-50/80 border-l-4 border-rose-500 font-bold text-slate-900";
      tr.innerHTML = `
        <td class="py-2 px-1.5 sm:p-2.5 pl-2.5 sm:pl-4 font-bold">${rideStepNum++}</td>
        <td class="py-2 px-1.5 sm:p-2.5 font-semibold text-slate-800">${stop.name} <span class="text-[9px] text-amber-700 font-bold">(${r2Name})</span></td>
        <td class="py-2 px-1.5 sm:p-2.5 text-slate-400 whitespace-nowrap">${distLabel}</td>
        <td class="py-2 px-1.5 sm:p-2.5 text-slate-500 text-[10px] sm:text-[11px]">${isFinal ? "🏁 Final Destination" : "Connecting Ride"}</td>
        <td class="py-2 px-1.5 sm:p-2.5 pr-2.5 sm:pr-4 text-right sm:text-left"><span class="px-1.5 sm:px-2 py-0.5 rounded text-[10px] sm:text-[11px] font-bold bg-slate-100 text-slate-500">Scheduled</span></td>
      `;
      tbody.appendChild(tr);
    });

    scrollTableToActiveRow();
    renderRoutePins(false);
    updateTripSummaryUI();
    return;
  }

  // DIRECT ROUTE TABLE POPULATION
  const tbody = document.getElementById("stopsTableBody");
  tbody.innerHTML = "";

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

  let accRideDist = 0;
  let rideStepNum = 1;

  journeyStops.forEach((stop, relIdx) => {
    const actualStopIdx = startSpanIdx + relIdx;
    let rowClass = "";
    let badgeClass = "bg-sky-50 text-sky-700 border border-sky-200";
    let distLabel = "--";
    let etaLabel = "--";
    let remLabel = "--";
    let displayStepNum = "";

    if (actualStopIdx < pIdx) {
      displayStepNum = `<span class="text-amber-500 font-black text-xs">●</span>`;
      const dMeters = calculateAccurateBusToStopDistance(busLat, busLng, actualStopIdx, currentStopsList);
      distLabel = dMeters >= 1000 ? `${(dMeters / 1000).toFixed(1)} km away` : `${Math.round(dMeters)} m away`;
    } else if (actualStopIdx === pIdx) {
      displayStepNum = `${rideStepNum++}`;
      const dToPickup = calculateAccurateBusToStopDistance(busLat, busLng, pIdx, currentStopsList);
      distLabel = dToPickup >= 1000 ? `${(dToPickup / 1000).toFixed(1)} km away` : `${Math.round(dToPickup)} m away`;
    } else {
      displayStepNum = `${rideStepNum++}`;
      const prevIdx = Math.max(0, actualStopIdx - 1);
      const prev = currentStopsList[prevIdx] || stop;
      accRideDist += getDistanceMeters(prev.lat, prev.lng, stop.lat, stop.lng) * 1.18;
      distLabel = `+${(accRideDist / 1000).toFixed(1)} km ride`;
    }

    const dDirectToStop = getDistanceMeters(busLat, busLng, stop.lat, stop.lng);

    if (busAbsoluteIdx > actualStopIdx) {
      etaLabel = "Departed";
      badgeClass = "bg-slate-100 text-slate-400";
      remLabel = "Missed";
      rowClass = "opacity-40";
    } else if (actualStopIdx === busAbsoluteIdx && busAbsoluteIdx < pIdx) {
      rowClass = "bg-amber-50/90 border-l-4 border-amber-500 font-bold text-slate-900 active-target-stop";
      if (dDirectToStop <= 100) {
        etaLabel = "Bus Here";
      } else {
        const stopEtaSec = calculateEtaSeconds(busLat, busLng, currentSpeedKmph, actualStopIdx, currentStopsList);
        etaLabel = formatEtaTime(stopEtaSec);
      }
      remLabel = "🟡 Live Location";
    } else if (actualStopIdx === pIdx) {
      rowClass = "bg-emerald-50/80 border-l-4 border-emerald-500 font-bold text-slate-900 active-target-stop";
      const stopEtaSec = calculateEtaSeconds(busLat, busLng, currentSpeedKmph, actualStopIdx, currentStopsList);
      etaLabel = formatEtaTime(stopEtaSec);
      const stopsToPickup = actualStopIdx - busAbsoluteIdx;
      
      if (stopsToPickup === 0) {
        remLabel = (dDirectToStop <= 100) ? "🟢 Arrived" : "🟢 Approaching";
      } else {
        remLabel = `🟢 Boarding (${stopsToPickup} away)`;
      }
    } else if (relIdx === journeyStops.length - 1) {
      rowClass = "bg-rose-50/80 border-l-4 border-rose-500 font-bold text-slate-900";
      const stopEtaSec = calculateEtaSeconds(busLat, busLng, currentSpeedKmph, actualStopIdx, currentStopsList);
      etaLabel = formatEtaTime(stopEtaSec);
      remLabel = "🏁 Final Stop";
    } else if (actualStopIdx < pIdx) {
      const stopEtaSec = calculateEtaSeconds(busLat, busLng, currentSpeedKmph, actualStopIdx, currentStopsList);
      etaLabel = formatEtaTime(stopEtaSec);
      const stopsAway = actualStopIdx - busAbsoluteIdx;
      remLabel = `Approach • ${stopsAway} stop${stopsAway > 1 ? 's' : ''}`;
    } else {
      const stopEtaSec = calculateEtaSeconds(busLat, busLng, currentSpeedKmph, actualStopIdx, currentStopsList);
      etaLabel = formatEtaTime(stopEtaSec);
      const inRideStops = actualStopIdx - pIdx;
      remLabel = `+${inRideStops} stop${inRideStops > 1 ? 's' : ''} ride`;
    }

    const tr = document.createElement("tr");
    if (rowClass) tr.className = rowClass;
    tr.innerHTML = `
      <td class="py-2 px-1.5 sm:p-2.5 pl-2.5 sm:pl-4 font-bold">${displayStepNum}</td>
      <td class="py-2 px-1.5 sm:p-2.5 font-semibold text-slate-800">${stop.name} <span class="text-[9px] text-sky-700 font-bold">(${rName})</span></td>
      <td class="py-2 px-1.5 sm:p-2.5 text-slate-600 font-medium whitespace-nowrap">${distLabel}</td>
      <td class="py-2 px-1.5 sm:p-2.5 text-slate-600 text-[10px] sm:text-[11px]">${remLabel}</td>
      <td class="py-2 px-1.5 sm:p-2.5 pr-2.5 sm:pr-4 text-right sm:text-left"><span class="px-1.5 sm:px-2 py-0.5 rounded text-[10px] sm:text-[11px] font-bold bg-slate-100 text-slate-500">${etaLabel}</span></td>
    `;
    tbody.appendChild(tr);
  });

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
  console.log('Connected to HiveMQ Unified Fleet WebSocket Hub');
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

    // Accurately resolve UP/DOWN without hardcoding
    const detectedDir = updateBusDirectionFromMovement(busPlate, busLat, busLng, busHeading, busSpeed, d.dir || null, routeConfig);

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
    
    // Anti-teleportation filter
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
