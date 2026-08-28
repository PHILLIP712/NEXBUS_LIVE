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

const activeBuses = {};
const activeBusMarkers = {};
let selectedBusPlate = null;

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
        <!-- Top Route & Destination Tag -->
        <div class="bus-tag-top whitespace-nowrap px-2 py-0.5 rounded shadow text-[10px] font-extrabold bg-sky-600 text-white flex items-center gap-1">
          <span>${tagLabel}</span>
        </div>

        <!-- Bus Icon Container with Heading Pointer -->
        <div class="relative w-9 h-9 flex items-center justify-center my-0.5">
          <div class="bus-pulse"></div>
          
          <!-- Direction Pointer Cone -->
          <div class="absolute inset-0 flex items-center justify-center pointer-events-none transition-transform duration-500 ease-linear" style="${rotationStyle}">
            <div class="w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-b-[10px] border-b-emerald-400 absolute -top-1.5 drop-shadow-md"></div>
          </div>

          <!-- Central Bus Circle -->
          <div class="relative z-10 w-8 h-8 bg-slate-900 text-white rounded-full border-2 border-white shadow-xl flex items-center justify-center">
            <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6v6"/><path d="M15 6v6"/><path d="M2 12h19.6"/><path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><circle cx="15" cy="18" r="2"/></svg>
          </div>
        </div>

        <!-- Bottom Plate Tag -->
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
    color = "#3b82f6";
    size = 16;
    border = "3px solid #fff; box-shadow: 0 0 12px #3b82f6;";
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

  const ROAD_CURVATURE = 1.25;
  const DWELL_SEC = 30;
  const effectiveSpeed = busSpeedKmph >= 12 ? (busSpeedKmph * 0.7 + 20 * 0.3) : 20.0;
  const speedMps = (effectiveSpeed * 1000) / 3600;

  if (busIdx === targetStopIdx) {
    const direct = getDistanceMeters(busLat, busLng, stops[targetStopIdx].lat, stops[targetStopIdx].lng);
    return Math.max(30, (direct * ROAD_CURVATURE) / speedMps);
  }

  let accDist = getDistanceMeters(busLat, busLng, stops[busIdx].lat, stops[busIdx].lng) * ROAD_CURVATURE;
  let intermediateStops = 0;

  for (let i = busIdx + 1; i <= targetStopIdx; i++) {
    const prev = stops[i - 1];
    accDist += getDistanceMeters(prev.lat, prev.lng, stops[i].lat, stops[i].lng) * ROAD_CURVATURE;
    intermediateStops++;
  }

  return (accDist / speedMps) + (intermediateStops * DWELL_SEC);
}

function calculateAccurateBusToStopDistance(busLat, busLng, targetStopIdx, stops) {
  if (!stops || targetStopIdx < 0 || targetStopIdx >= stops.length) return 0;
  const busIdx = findBusNearestStopIndex(busLat, busLng, stops);
  if (busIdx > targetStopIdx) return 0;

  const ROAD_CURVATURE = 1.25;
  let accDist = getDistanceMeters(busLat, busLng, stops[busIdx].lat, stops[busIdx].lng) * ROAD_CURVATURE;
  for (let i = busIdx + 1; i <= targetStopIdx; i++) {
    const prev = stops[i - 1];
    accDist += getDistanceMeters(prev.lat, prev.lng, stops[i].lat, stops[i].lng) * ROAD_CURVATURE;
  }
  return accDist;
}

function calculateTripSummary(pickupStop, destStop, stopsList, effectiveSpeedKmph = 22.0) {
  const pIdx = stopsList.findIndex(s => normalizeStr(s.name) === normalizeStr(pickupStop.name));
  const dIdx = stopsList.findIndex(s => normalizeStr(s.name) === normalizeStr(destStop.name));
  
  if (pIdx === -1 || dIdx === -1 || pIdx >= dIdx) return null;

  const ROAD_CURVATURE = 1.25;
  const DWELL_SEC = 30;
  const speedMps = (effectiveSpeedKmph * 1000) / 3600;

  let totalMeters = 0;
  let intermediateStops = 0;

  for (let i = pIdx + 1; i <= dIdx; i++) {
    const prev = stopsList[i - 1];
    const curr = stopsList[i];
    totalMeters += getDistanceMeters(prev.lat, prev.lng, curr.lat, curr.lng) * ROAD_CURVATURE;
    intermediateStops++;
  }

  const inRideSec = (totalMeters / speedMps) + (intermediateStops * DWELL_SEC);

  return {
    distanceKm: (totalMeters / 1000).toFixed(1),
    rideDuration: formatEtaTime(inRideSec),
    totalStops: intermediateStops + 1
  };
}

// ==========================================
// ROBUST JITTER-PROOF DIRECTION STABILIZER
// ==========================================
function updateBusDirectionFromMovement(busPlate, newLat, newLng, newHeading, newSpeedKmph, payloadDir, routeConfig) {
  if (payloadDir && (payloadDir.toUpperCase() === "UP" || payloadDir.toUpperCase() === "DOWN")) {
    return payloadDir.toUpperCase();
  }

  const prev = activeBuses[busPlate];

  if (!prev && routeConfig) {
    const fStops = routeConfig.forwardStops || [];
    const rStops = routeConfig.returnStops || [];
    if (fStops.length > 0 && rStops.length > 0) {
      const dUp = getDistanceMeters(newLat, newLng, fStops[0].lat, fStops[0].lng);
      const dDown = getDistanceMeters(newLat, newLng, rStops[0].lat, rStops[0].lng);
      return dUp < dDown ? "UP" : "DOWN";
    }
  }

  if (newSpeedKmph < 5.0) {
    if (prev && prev.busDir) {
      return prev.busDir;
    }
  }

  if (newSpeedKmph >= 5.0 && newHeading !== undefined && newHeading >= 0) {
    if (newHeading >= 20 && newHeading <= 160) return "UP";
    if (newHeading >= 200 && newHeading <= 340) return "DOWN";
  }

  if (prev && routeConfig) {
    const moved = getDistanceMeters(prev.lat, prev.lng, newLat, newLng);
    if (moved >= 15.0) {
      const forwardStops = routeConfig.forwardStops || [];
      const prevIdx = findBusNearestStopIndex(prev.lat, prev.lng, forwardStops);
      const currIdx = findBusNearestStopIndex(newLat, newLng, forwardStops);
      if (currIdx > prevIdx) return "UP";
      if (currIdx < prevIdx) return "DOWN";
    }
    return prev.busDir || "UP";
  }

  return prev ? (prev.busDir || "UP") : "UP";
}

function scrollTableToActiveRow() {
  setTimeout(() => {
    const tableContainer = document.querySelector("#bottomSheet .overflow-y-auto");
    const activeRow = document.querySelector(".active-target-stop");
    if (tableContainer) {
      if (activeRow) {
        const topOffset = activeRow.offsetTop - tableContainer.offsetTop - 50;
        tableContainer.scrollTo({ top: Math.max(0, topOffset), behavior: "smooth" });
      } else {
        tableContainer.scrollTo({ top: 0, behavior: "instant" });
      }
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
        <div class="w-8 h-8 rounded-lg ${iconColor} flex items-center justify-center shrink-0">
          <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>
        </div>
        <div class="min-w-0">
          <div class="text-sm font-semibold text-slate-800 truncate">${stop.name}</div>
          <div class="text-xs text-slate-400 truncate">${stop.area || 'Bus Stop'}</div>
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
// 4. SMART BANNER (STRICT PICKUP ➔ DESTINATION)
// ==========================================
function updateDirectionBannerText() {
  const labelElem = document.getElementById("currentDirectionLabel");
  if (!labelElem) return;

  // 1-Transfer Trip Header
  if (currentTripPlanType === "TRANSFER" && activeTransferPlan) {
    const r1Name = window.ROUTES_DATABASE[activeTransferPlan.leg1.routeKey]?.name || "Bus 1";
    const r2Name = window.ROUTES_DATABASE[activeTransferPlan.leg2.routeKey]?.name || "Bus 2";
    labelElem.innerHTML = `
      <div class="flex items-center gap-1.5 flex-wrap">
        <span class="bg-amber-100 text-amber-800 px-2 py-0.5 rounded text-[10px] font-extrabold shrink-0">1 TRANSFER</span>
        <span class="text-slate-900 font-bold">${r1Name}</span>
        <span class="text-slate-400">➔</span>
        <span class="text-sky-800 font-bold">Change at ${activeTransferPlan.transferStopName}</span>
        <span class="text-slate-400">➔</span>
        <span class="text-slate-900 font-bold">${r2Name}</span>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  // Multiple Lines Available Header
  if (activeMatchingRoutes.length > 1 && selectedPickupStop && selectedDestStop) {
    const totalLines = activeMatchingRoutes.length;
    labelElem.innerHTML = `
      <div class="flex items-center gap-1.5 flex-wrap">
        <button onclick="openLinesModal()" class="bg-sky-100 hover:bg-sky-200 active:scale-95 text-sky-800 px-2.5 py-0.5 rounded-lg text-[10px] font-extrabold shrink-0 flex items-center gap-1 border border-sky-200 transition-all cursor-pointer shadow-sm">
          <span>${totalLines} LINES AVAILABLE</span>
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
    return;
  }

  // Single Direct Line: Show User's Exact Pickup ➔ Destination
  if (!window.ROUTES_DATABASE || !activeRouteKey || !selectedPickupStop || !selectedDestStop) return;
  const routeConfig = window.ROUTES_DATABASE[activeRouteKey];
  if (!routeConfig) return;

  labelElem.innerHTML = `
    <span class="text-slate-900 font-bold">${routeConfig.name}:</span> 
    <span class="text-slate-800 font-semibold">${selectedPickupStop.name}</span> 
    <span class="text-emerald-600 font-bold">➔</span> 
    <span class="text-slate-800 font-semibold">${selectedDestStop.name}</span>
  `;
}

function openLinesModal() {
  const modal = document.getElementById("linesModal");
  const listContainer = document.getElementById("linesModalList");
  if (!modal || !listContainer) return;

  listContainer.innerHTML = "";

  activeMatchingRoutes.forEach(r => {
    const config = window.ROUTES_DATABASE[r.routeKey];
    if (!config) return;

    const pIdx = r.stops.findIndex(s => selectedPickupStop && normalizeStr(s.name) === normalizeStr(selectedPickupStop.name));

    const liveBusesOnThisLine = Object.values(activeBuses).filter(b => {
      const isLine = normalizeStr(b.routeKey || b.route).includes(normalizeStr(r.routeKey));
      const isDir = (b.busDir === currentDirection);
      if (!isLine || !isDir) return false;
      
      const busIdx = findBusNearestStopIndex(b.lat, b.lng, r.stops);
      return (pIdx === -1 || busIdx <= pIdx);
    });

    const isLive = liveBusesOnThisLine.length > 0;

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
    card.className = "p-3 rounded-2xl border border-slate-200/80 bg-slate-50/60 flex items-center justify-between hover:border-emerald-500 transition-all";
    card.innerHTML = `
      <div class="flex items-center gap-3">
        <div class="px-2.5 py-1.5 rounded-xl bg-emerald-100/80 text-emerald-800 font-extrabold text-xs shrink-0 border border-emerald-200/60 min-w-[55px] text-center">
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
               <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>${liveBusesOnThisLine.length} Upcoming
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
// UNIVERSAL GEOMETRIC & DIRECTIONAL ENGINE
// ==========================================
function findMatchingRoutes(pName, dName) {
  let pNorm = normalizeStr(pName);
  let dNorm = normalizeStr(dName);
  const directMatches = [];
  const candidateTransfers = [];

  if (!window.ROUTES_DATABASE) return { direct: [], transfers: [] };

  const allRouteKeys = Object.keys(window.ROUTES_DATABASE);

  // 1. Direct Route Discovery
  for (const rKey of allRouteKeys) {
    const rObj = window.ROUTES_DATABASE[rKey];
    
    // UP Direction
    const pUp = rObj.forwardStops.findIndex(s => normalizeStr(s.name).includes(pNorm) || (s.area && normalizeStr(s.area).includes(pNorm)));
    const dUp = rObj.forwardStops.findIndex(s => normalizeStr(s.name).includes(dNorm) || (s.area && normalizeStr(s.area).includes(dNorm)));
    if (pUp !== -1 && dUp !== -1 && pUp < dUp) {
      directMatches.push({ type: 'DIRECT', routeKey: rKey, direction: "UP", stops: rObj.forwardStops, pIdx: pUp, dIdx: dUp });
      continue;
    }

    // DOWN Direction
    const pDown = rObj.returnStops.findIndex(s => normalizeStr(s.name).includes(pNorm) || (s.area && normalizeStr(s.area).includes(pNorm)));
    const dDown = rObj.returnStops.findIndex(s => normalizeStr(s.name).includes(dNorm) || (s.area && normalizeStr(s.area).includes(dNorm)));
    if (pDown !== -1 && dDown !== -1 && pDown < dDown) {
      directMatches.push({ type: 'DIRECT', routeKey: rKey, direction: "DOWN", stops: rObj.returnStops, pIdx: pDown, dIdx: dDown });
    }
  }

  // If a direct route exists, return directly
  if (directMatches.length > 0) {
    return { direct: directMatches, transfers: [] };
  }

  // 2. 1-Transfer Route Discovery
  for (const r1Key of allRouteKeys) {
    const r1 = window.ROUTES_DATABASE[r1Key];
    const directions1 = [
      { dir: "UP", stops: r1.forwardStops },
      { dir: "DOWN", stops: r1.returnStops }
    ];

    for (const leg1 of directions1) {
      let pIdx = leg1.stops.findIndex(s => normalizeStr(s.name).includes(pNorm) || (s.area && normalizeStr(s.area).includes(pNorm)));
      if (pIdx === -1) continue;

      const pStop = leg1.stops[pIdx];

      for (const r2Key of allRouteKeys) {
        if (r2Key === r1Key) continue;
        const r2 = window.ROUTES_DATABASE[r2Key];
        const directions2 = [
          { dir: "UP", stops: r2.forwardStops },
          { dir: "DOWN", stops: r2.returnStops }
        ];

        for (const leg2 of directions2) {
          let d2Idx = leg2.stops.findIndex(s => normalizeStr(s.name).includes(dNorm) || (s.area && normalizeStr(s.area).includes(dNorm)));
          if (d2Idx === -1) continue;

          const dStop = leg2.stops[d2Idx];
          const commonStops = [];

          for (let tIdx = pIdx + 1; tIdx < leg1.stops.length; tIdx++) {
            const transferStop = leg1.stops[tIdx];
            const tNorm = normalizeStr(transferStop.name);

            const t2Idx = leg2.stops.findIndex(s => normalizeStr(s.name).includes(tNorm) || (s.area && normalizeStr(s.area).includes(tNorm)));

            // Leg 2 must move forward from transfer point to destination
            if (t2Idx !== -1 && t2Idx < d2Idx) {
              const distPickupToDest = getDistanceMeters(pStop.lat, pStop.lng, dStop.lat, dStop.lng);
              const distTransferToDest = getDistanceMeters(transferStop.lat, transferStop.lng, dStop.lat, dStop.lng);
              const distLeg1 = getDistanceMeters(pStop.lat, pStop.lng, transferStop.lat, transferStop.lng);
              const distLeg2 = getDistanceMeters(transferStop.lat, transferStop.lng, dStop.lat, dStop.lng);
              const totalTransferDist = distLeg1 + distLeg2;

              // Geometric constraint against circular looping
              if (totalTransferDist <= Math.max(distPickupToDest * 2.2, 7500) && distTransferToDest <= distPickupToDest + 1200) {
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
            let bestTransfer = null;

            if (leg1.dir !== leg2.dir) {
              // OPPOSITE DIRECTIONS (e.g. UP ➔ DOWN to pocket branches like Batanagar River Side):
              // Transfer at the FIRST common intersection where routes cross
              commonStops.sort((a, b) => a.tIdx - b.tIdx || a.totalDist - b.totalDist);
              bestTransfer = commonStops[0];
            } else {
              // SAME DIRECTION (e.g. UP ➔ UP or DOWN ➔ DOWN):
              // Maximize passenger stretch on Leg 1: transfer at the FURTHEST shared stop along Leg 1 (maximum tIdx)
              // (e.g. Brace Bridge for Eden City -> Howrah; Batanagar Bata More for Howrah -> Eden City)
              commonStops.sort((a, b) => b.tIdx - a.tIdx || a.distTransferToDest - b.distTransferToDest);
              bestTransfer = commonStops[0];
            }

            // Live bus detection on Leg 1
            const liveLeg1Buses = Object.values(activeBuses).filter(b => {
              const isLine = normalizeStr(b.routeKey || b.route).includes(normalizeStr(r1Key));
              if (!isLine || b.busDir !== leg1.dir) return false;
              const bIdx = findBusNearestStopIndex(b.lat, b.lng, leg1.stops);
              return bIdx <= pIdx;
            });

            // Live bus detection on Leg 2
            const liveLeg2Buses = Object.values(activeBuses).filter(b => {
              const isLine = normalizeStr(b.routeKey || b.route).includes(normalizeStr(r2Key));
              if (!isLine || b.busDir !== leg2.dir) return false;
              const bIdx = findBusNearestStopIndex(b.lat, b.lng, leg2.stops);
              return bIdx <= bestTransfer.t2Idx;
            });

            candidateTransfers.push({
              type: 'TRANSFER',
              transferStopName: bestTransfer.transferStopName,
              totalDist: bestTransfer.totalDist,
              leg1StopsCount: bestTransfer.leg1StopsCount,
              hasLiveLeg1: liveLeg1Buses.length > 0,
              hasLiveLeg2: liveLeg2Buses.length > 0,
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

  // Prioritize live Leg 1 bus, then live connecting bus, then shortest distance
  candidateTransfers.sort((a, b) => {
    const liveScoreA = (a.hasLiveLeg1 ? 2 : 0) + (a.hasLiveLeg2 ? 1 : 0);
    const liveScoreB = (b.hasLiveLeg1 ? 2 : 0) + (b.hasLiveLeg2 ? 1 : 0);
    return liveScoreB - liveScoreA || a.totalDist - b.totalDist;
  });

  return { direct: directMatches, transfers: candidateTransfers };
}

function handleSearchClick() {
  const pickVal = document.getElementById("pickup-input").value.trim();
  const destVal = document.getElementById("dest-input").value.trim();

  if (!pickVal || !destVal) {
    alert("Please select both Pickup and Destination stops!");
    return;
  }

  lastSearchResult = findMatchingRoutes(pickVal, destVal);

  busNearestStopIdx = 0;
  selectedBusPlate = null;

  // 1. Direct Routes Take Absolute Precedence (Live GPS preferred, otherwise Scheduled)
  if (lastSearchResult.direct.length > 0) {
    selectDirectOption(0, false);
    return;
  }

  // 2. Optimized 1-Transfer
  if (lastSearchResult.transfers.length > 0) {
    selectTransferOption(0, false);
    return;
  }

  alert("No direct or connecting route found between these locations in this direction.");
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
  openBottomSheet();

  // Find candidate live buses heading same direction and upstream of pickup
  const upcomingBuses = Object.values(activeBuses).filter(b => {
    const isLine = normalizeStr(b.routeKey || b.route).includes(normalizeStr(activeRouteKey));
    if (!isLine || b.busDir !== currentDirection) return false;
    const busCurrentIdx = findBusNearestStopIndex(b.lat, b.lng, currentStopsList);
    return busCurrentIdx <= primary.pIdx;
  });

  if (upcomingBuses.length > 0) {
    selectedBusPlate = upcomingBuses[0].plate;
    const b = upcomingBuses[0];
    updateStopsTable(b.lat, b.lng, b.spd);
  } else {
    selectedBusPlate = null;
    renderSchedulePreview();
  }

  if (isTrackingConfirmed) {
    renderRoutePins(true);
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
  openBottomSheet();

  // Find candidate live buses for Leg 1 heading in matching direction
  const upcomingLeg1Buses = Object.values(activeBuses).filter(b => {
    const isLine = normalizeStr(b.routeKey || b.route).includes(normalizeStr(activeTransferPlan.leg1.routeKey));
    if (!isLine || b.busDir !== activeTransferPlan.leg1.direction) return false;
    const bIdx = findBusNearestStopIndex(b.lat, b.lng, activeTransferPlan.leg1.stops);
    return bIdx <= activeTransferPlan.leg1.pIdx;
  });

  if (upcomingLeg1Buses.length > 0) {
    selectedBusPlate = upcomingLeg1Buses[0].plate;
    const b = upcomingLeg1Buses[0];
    updateStopsTable(b.lat, b.lng, b.spd);
  } else {
    selectedBusPlate = null;
    renderSchedulePreview();
  }

  if (isTrackingConfirmed) {
    renderRoutePins(true);
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
    const totalDist = ((parseFloat(s1?.distanceKm || 0)) + (parseFloat(s2?.distanceKm || 0))).toFixed(1);

    document.getElementById("tripDistText").innerText = `${totalDist} km`;
    document.getElementById("tripDurationText").innerText = `~${Math.round(totalDist * 2.8)} mins`;
    document.getElementById("tripStatsPill").classList.remove("hidden");
    document.getElementById("journeyStopsCount").innerText = `(${totalStops} stops, 1 Transfer)`;
    return;
  }

  if (!currentStopsList.length) return;

  const summary = calculateTripSummary(selectedPickupStop, selectedDestStop, currentStopsList);
  if (summary) {
    document.getElementById("tripDistText").innerText = `${summary.distanceKm} km`;
    document.getElementById("tripDurationText").innerText = `${summary.rideDuration} in-ride`;
    document.getElementById("tripStatsPill").classList.remove("hidden");
    
    const pIdx = currentStopsList.findIndex(s => normalizeStr(s.name) === normalizeStr(selectedPickupStop.name));
    const approachingCount = (busNearestStopIdx > 0 && busNearestStopIdx < pIdx) ? (pIdx - busNearestStopIdx) : 0;
    
    if (approachingCount > 0) {
      document.getElementById("journeyStopsCount").innerText = `(${summary.totalStops} stops ride • ${approachingCount} incoming)`;
    } else {
      document.getElementById("journeyStopsCount").innerText = `(${summary.totalStops} stops)`;
    }
  }
}

function toggleTrackingAction() {
  if (isTrackingConfirmed) {
    cancelTracking();
  } else {
    startTracking();
  }
}

function startTracking() {
  if (!selectedPickupStop || !selectedDestStop) {
    alert("Please select your stops and click Search first!");
    return;
  }

  // Bind active upcoming bus plate for 1-Transfer routes
  if (currentTripPlanType === "TRANSFER" && activeTransferPlan) {
    const upcomingLeg1Buses = Object.values(activeBuses).filter(b => {
      const isLine = normalizeStr(b.routeKey || b.route).includes(normalizeStr(activeTransferPlan.leg1.routeKey));
      if (!isLine || b.busDir !== activeTransferPlan.leg1.direction) return false;
      const bIdx = findBusNearestStopIndex(b.lat, b.lng, activeTransferPlan.leg1.stops);
      return bIdx <= activeTransferPlan.leg1.pIdx;
    });

    if (upcomingLeg1Buses.length > 0) {
      selectedBusPlate = upcomingLeg1Buses[0].plate;
    }
  }

  isTrackingConfirmed = true;
  
  const btn = document.getElementById("btnTrackAction");
  btn.className = "bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs px-4 py-2 rounded-xl shadow-md shadow-rose-600/20 transition-all flex items-center gap-1.5 active:scale-95";
  btn.innerHTML = `<i data-lucide="x" class="w-3.5 h-3.5"></i><span id="btnTrackActionText">Cancel Track</span>`;
  lucide.createIcons();

  updateDirectionBannerText();
  document.getElementById("activeTripBar").classList.remove("hidden");
  
  renderRoutePins(true);
  updateAvailableBusesList();

  if (selectedBusPlate && activeBuses[selectedBusPlate]) {
    const b = activeBuses[selectedBusPlate];
    updateStopsTable(b.lat, b.lng, b.spd);
  }
}

function cancelTracking() {
  isTrackingConfirmed = false;
  
  const btn = document.getElementById("btnTrackAction");
  btn.className = "bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs px-4 py-2 rounded-xl shadow-md shadow-emerald-600/20 transition-all flex items-center gap-1.5 active:scale-95";
  btn.innerHTML = `<i data-lucide="check" class="w-3.5 h-3.5"></i><span id="btnTrackActionText">Confirm Route & Track</span>`;
  lucide.createIcons();

  document.getElementById("activeTripBar").classList.add("hidden");
  document.getElementById("floatingBusCard").classList.add("hidden");
  document.getElementById("tripStatsPill").classList.add("hidden");
  
  renderRoutePins(false);
  renderSchedulePreview();
  updateAvailableBusesList();
}

// ==========================================
// 5. SCHEDULE PREVIEW (FALLBACK WHEN NO LIVE GPS)
// ==========================================
function renderSchedulePreview() {
  const tbody = document.getElementById("stopsTableBody");
  tbody.innerHTML = "";

  if (currentTripPlanType === "TRANSFER" && activeTransferPlan) {
    const leg1Stops = activeTransferPlan.leg1.stops.slice(activeTransferPlan.leg1.pIdx, activeTransferPlan.leg1.tIdx + 1);
    const leg2Stops = activeTransferPlan.leg2.stops.slice(activeTransferPlan.leg2.tIdx + 1, activeTransferPlan.leg2.dIdx + 1);

    const r1Name = window.ROUTES_DATABASE[activeTransferPlan.leg1.routeKey]?.name || "Bus 1";
    const r2Name = window.ROUTES_DATABASE[activeTransferPlan.leg2.routeKey]?.name || "Bus 2";

    let stepNum = 1;

    leg1Stops.forEach((stop, idx) => {
      const isBoarding = (idx === 0);
      const isTransferPoint = (idx === leg1Stops.length - 1);
      
      let rowClass = isBoarding ? "bg-emerald-50/80 border-l-4 border-emerald-500 font-bold text-slate-900 active-target-stop" : "";
      if (isTransferPoint) rowClass = "bg-amber-50/80 border-l-4 border-amber-500 font-bold text-slate-900";

      const tr = document.createElement("tr");
      if (rowClass) tr.className = rowClass;
      tr.innerHTML = `
        <td class="p-2.5 pl-4">${stepNum++}</td>
        <td class="p-2.5 font-semibold text-slate-800">${stop.name} <span class="text-[10px] text-sky-700 font-bold">(${r1Name})</span></td>
        <td class="p-2.5 text-slate-400">--</td>
        <td class="p-2.5 text-slate-500">${isBoarding ? "Board First Bus" : (isTransferPoint ? "Alight for Transfer" : "Ride")}</td>
        <td class="p-2.5 pr-4"><span class="px-2 py-0.5 rounded text-[11px] font-bold bg-slate-100 text-slate-500">Scheduled</span></td>
      `;
      tbody.appendChild(tr);
    });

    const transferTr = document.createElement("tr");
    transferTr.className = "bg-amber-100/70 font-extrabold text-amber-900";
    transferTr.innerHTML = `
      <td class="p-2 pl-4 text-center">🔄</td>
      <td colspan="4" class="p-2 text-xs">Switch to <span class="underline decoration-amber-600 font-black">${r2Name}</span> towards ${selectedDestStop.name}</td>
    `;
    tbody.appendChild(transferTr);

    leg2Stops.forEach((stop, idx) => {
      const isFinal = (idx === leg2Stops.length - 1);
      let rowClass = isFinal ? "bg-rose-50/80 border-l-4 border-rose-500 font-bold text-slate-900" : "";

      const tr = document.createElement("tr");
      if (rowClass) tr.className = rowClass;
      tr.innerHTML = `
        <td class="p-2.5 pl-4">${stepNum++}</td>
        <td class="p-2.5 font-semibold text-slate-800">${stop.name} <span class="text-[10px] text-amber-700 font-bold">(${r2Name})</span></td>
        <td class="p-2.5 text-slate-400">--</td>
        <td class="p-2.5 text-slate-500">${isFinal ? "🏁 Final Destination" : "Connecting Ride"}</td>
        <td class="p-2.5 pr-4"><span class="px-2 py-0.5 rounded text-[11px] font-bold bg-slate-100 text-slate-500">Scheduled</span></td>
      `;
      tbody.appendChild(tr);
    });

    scrollTableToActiveRow();
    return;
  }

  const pIdx = selectedPickupStop ? currentStopsList.findIndex(s => normalizeStr(s.name) === normalizeStr(selectedPickupStop.name)) : 0;
  const dIdx = selectedDestStop ? currentStopsList.findIndex(s => normalizeStr(s.name) === normalizeStr(selectedDestStop.name)) : currentStopsList.length - 1;

  const journeyStops = (pIdx !== -1 && dIdx !== -1 && pIdx <= dIdx) ? currentStopsList.slice(pIdx, dIdx + 1) : [];

  journeyStops.forEach((stop, idx) => {
    let rowClass = "";
    if (idx === 0) {
      rowClass = "bg-emerald-50/80 border-l-4 border-emerald-500 font-bold text-slate-900 active-target-stop";
    } else if (idx === journeyStops.length - 1) {
      rowClass = "bg-rose-50/80 border-l-4 border-rose-500 font-bold text-slate-900";
    }

    const tr = document.createElement("tr");
    if (rowClass) tr.className = rowClass;
    tr.innerHTML = `
      <td class="p-2.5 pl-4">${idx + 1}</td>
      <td class="p-2.5 font-medium">${stop.name}</td>
      <td class="p-2.5 text-slate-400">--</td>
      <td class="p-2.5 text-slate-400">--</td>
      <td class="p-2.5 pr-4"><span class="px-2 py-0.5 rounded text-[11px] font-bold bg-slate-100 text-slate-500">Scheduled</span></td>
    `;
    tbody.appendChild(tr);
  });

  scrollTableToActiveRow();
}

// ==========================================
// 6. DUAL-COLOR TRANSFER & ACCURATE APPROACH ENGINE
// ==========================================
function renderRoutePins(autoFit = false) {
  if (routePolylineLayer) { map.removeLayer(routePolylineLayer); routePolylineLayer = null; }
  if (approachPolylineLayer) { map.removeLayer(approachPolylineLayer); approachPolylineLayer = null; }
  if (leg1PolylineLayer) { map.removeLayer(leg1PolylineLayer); leg1PolylineLayer = null; }
  if (leg2PolylineLayer) { map.removeLayer(leg2PolylineLayer); leg2PolylineLayer = null; }
  stopMarkersLayer.clearLayers();

  if (!isTrackingConfirmed || !selectedPickupStop || !selectedDestStop) return;

  const activeBus = (selectedBusPlate && activeBuses[selectedBusPlate]) ? activeBuses[selectedBusPlate] : null;

  // ====================================================
  // 1-TRANSFER MULTI-COLOR RENDERING
  // ====================================================
  if (currentTripPlanType === "TRANSFER" && activeTransferPlan) {
    const pIdx = activeTransferPlan.leg1.pIdx;
    const tIdx = activeTransferPlan.leg1.tIdx;
    const t2Idx = activeTransferPlan.leg2.tIdx;
    const d2Idx = activeTransferPlan.leg2.dIdx;

    let approachPoints = [];

    // Approach Path: Connect ONLY between the active GPS bus and boarding stop
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

    // Leg 1: Boarding Point -> Transfer Stop (Solid Emerald Green)
    const leg1Stops = activeTransferPlan.leg1.stops.slice(pIdx, tIdx + 1);
    const leg1Points = leg1Stops.map(s => [s.lat, s.lng]);
    leg1PolylineLayer = L.polyline(leg1Points, {
      color: '#059669',
      weight: 6,
      opacity: 0.95
    }).addTo(map);

    // Leg 2: Transfer Stop -> Destination (Solid Indigo Blue)
    const leg2Stops = activeTransferPlan.leg2.stops.slice(t2Idx, d2Idx + 1);
    const leg2Points = leg2Stops.map(s => [s.lat, s.lng]);
    leg2PolylineLayer = L.polyline(leg2Points, {
      color: '#4f46e5',
      weight: 6,
      opacity: 0.95
    }).addTo(map);

    // AutoFit Bounds
    if (autoFit) {
      const allPoints = [...approachPoints, ...leg1Points, ...leg2Points];
      if (allPoints.length >= 2) {
        map.fitBounds(L.polyline(allPoints).getBounds(), { padding: [50, 50] });
      }
    }

    // Stop Markers
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

  // ====================================================
  // DIRECT ROUTE RENDERING
  // ====================================================
  const pIdx = currentStopsList.findIndex(s => normalizeStr(s.name) === normalizeStr(selectedPickupStop.name));
  const dIdx = currentStopsList.findIndex(s => normalizeStr(s.name) === normalizeStr(selectedDestStop.name));

  if (pIdx === -1 || dIdx === -1 || pIdx >= dIdx) return;

  let approachPoints = [];

  // Approach Path: Connect ONLY between the active GPS bus and boarding stop
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

  // In-Ride Path (Solid Emerald Green)
  const rideStops = currentStopsList.slice(pIdx, dIdx + 1);
  const ridePoints = rideStops.map(s => [s.lat, s.lng]);
  routePolylineLayer = L.polyline(ridePoints, {
    color: '#059669',
    weight: 6,
    opacity: 0.95
  }).addTo(map);

  if (autoFit) {
    const allPoints = [...approachPoints, ...ridePoints];
    if (allPoints.length >= 2) {
      map.fitBounds(L.polyline(allPoints).getBounds(), { padding: [50, 50] });
    }
  }

  // Stop Markers
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
// 7. COMPACT BUS CARDS (MULTI-TRANSFER OPTIONS RENDERED)
// ==========================================
function updateAvailableBusesList() {
  const container = document.getElementById("busesListContainer");
  const floatingCard = document.getElementById("floatingBusCard");
  if (!container) return;
  container.innerHTML = "";

  // ====================================================
  // 1. IF CURRENT PLAN IS A 1-TRANSFER ROUTE
  // ====================================================
  if (currentTripPlanType === "TRANSFER" && activeTransferPlan) {
    const transferOptions = (lastSearchResult && lastSearchResult.transfers) ? lastSearchResult.transfers : [activeTransferPlan];

    transferOptions.forEach((plan, planIdx) => {
      const isSelectedPlan = (plan.leg1.routeKey === activeTransferPlan.leg1.routeKey && plan.leg2.routeKey === activeTransferPlan.leg2.routeKey && plan.transferStopName === activeTransferPlan.transferStopName);

      const r1Config = window.ROUTES_DATABASE[plan.leg1.routeKey] || {};
      const r2Config = window.ROUTES_DATABASE[plan.leg2.routeKey] || {};
      const r1Name = r1Config.name || "Bus 1";
      const r2Name = r2Config.name || "Bus 2";

      const leg1Count = plan.leg1.tIdx - plan.leg1.pIdx + 1;
      const leg2Count = plan.leg2.dIdx - plan.leg2.tIdx;
      const totalStops = leg1Count + leg2Count;

      const upcomingLeg1Buses = Object.values(activeBuses).filter(b => {
        const isLine = normalizeStr(b.routeKey || b.route).includes(normalizeStr(plan.leg1.routeKey));
        if (!isLine || b.busDir !== plan.leg1.direction) return false;
        const busCurrentIdx = findBusNearestStopIndex(b.lat, b.lng, plan.leg1.stops);
        return busCurrentIdx <= plan.leg1.pIdx;
      });

      const isUpcomingLive = upcomingLeg1Buses.length > 0;
      const liveBus = isUpcomingLive ? upcomingLeg1Buses[0] : null;

      if (isSelectedPlan) {
        if (isUpcomingLive && (!selectedBusPlate || !upcomingLeg1Buses.some(b => b.plate === selectedBusPlate))) {
          selectedBusPlate = liveBus.plate;
        } else if (!isUpcomingLive) {
          selectedBusPlate = null;
        }

        if (isTrackingConfirmed && floatingCard && liveBus) {
          floatingCard.classList.remove("hidden");
          document.getElementById('floatBusPlate').innerHTML = `
            <div class="flex items-center gap-1.5 flex-nowrap">
              <span class="font-bold text-slate-900">${liveBus.plate}</span>
              <span class="text-[10px] font-extrabold text-amber-800 bg-amber-100/90 px-2 py-0.5 rounded border border-amber-200 whitespace-nowrap flex items-center gap-1">
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

      const card = document.createElement("div");
      card.className = `bg-white border ${isSelectedPlan ? 'border-blue-500 ring-2 ring-blue-500/10' : 'border-slate-200'} hover:border-blue-500 rounded-2xl p-3.5 shadow-sm transition-all duration-200 hover:shadow-md cursor-pointer mb-2.5`;
      card.onclick = () => {
        selectTransferOption(planIdx, false);
      };

      card.innerHTML = `
        <!-- Top Row -->
        <div class="flex items-center justify-between pb-2 border-b border-slate-100">
          <div>
            ${planIdx === 0 ? `
              <span class="inline-flex items-center gap-1 bg-emerald-600 text-white text-[10px] font-extrabold px-2 py-0.5 rounded-md shadow-sm">
                ★ Best Option
              </span>
            ` : `
              <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Alternate Transfer</span>
            `}
          </div>
          <span class="inline-flex items-center gap-1.5 text-[11px] font-bold ${isUpcomingLive ? 'text-emerald-600' : 'text-slate-400'}">
            <span class="w-2 h-2 rounded-full ${isUpcomingLive ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'}"></span>
            ${isUpcomingLive ? 'Live' : 'Scheduled'}
          </span>
        </div>

        <!-- Middle Row -->
        <div class="mt-2.5">
          <div class="flex items-baseline justify-between gap-2">
            <div class="text-lg font-black text-blue-600 tracking-tight flex items-center gap-1.5 flex-wrap">
              <span>${r1Name}</span>
              <span class="text-xs text-slate-400 font-normal">➔</span>
              <span>${r2Name}</span>
            </div>
            <div class="text-right shrink-0">
              <div class="text-base font-black ${isUpcomingLive ? 'text-emerald-600' : 'text-slate-700'} leading-tight">${etaStr}</div>
              <div class="text-[10px] text-slate-400">${isUpcomingLive ? 'to pickup' : 'Timetable'}</div>
            </div>
          </div>

          <div class="text-xs font-bold text-slate-800 truncate mt-1">
            ${selectedPickupStop ? selectedPickupStop.name : 'Origin'} 
            <span class="text-slate-400 font-normal">➔</span> 
            ${selectedDestStop ? selectedDestStop.name : 'Destination'}
          </div>
          <div class="text-[10px] text-amber-800 font-semibold mt-0.5 flex items-center gap-1">
            <span>🔄 Change at:</span>
            <span class="underline">${plan.transferStopName}</span>
            <span class="text-slate-400 font-normal">(${totalStops} stops total)</span>
          </div>
        </div>

        <!-- Bottom Metadata Row -->
        <div class="flex items-center justify-between text-[11px] font-medium text-slate-500 mt-2.5 pt-2 border-t border-slate-100">
          <span class="font-mono font-bold text-slate-700">${liveBus ? liveBus.plate : 'Timetable'}</span>
          <span class="flex items-center gap-1">
            <i data-lucide="radio" class="w-3 h-3 text-slate-400"></i> ${isUpcomingLive ? 'Connecting' : 'Regular'}
          </span>
          <span class="flex items-center gap-1 text-slate-600">
            <i data-lucide="map-pin" class="w-3 h-3 text-slate-400"></i> Change Hub
          </span>
        </div>

        <!-- Stable Track Button -->
        <div class="mt-3">
          <button onclick="event.stopPropagation(); selectTransferOption(${planIdx}, false); startTracking();" class="w-full bg-blue-600 hover:bg-blue-700 active:scale-[0.98] text-white font-bold text-xs py-2 px-4 rounded-xl shadow-md shadow-blue-500/20 flex items-center justify-center gap-2 transition-all">
            <i data-lucide="map-pin" class="w-3.5 h-3.5"></i>
            <span>Track this route</span>
          </button>
        </div>
      `;

      container.appendChild(card);
    });

    lucide.createIcons();
    return;
  }

  // ====================================================
  // 2. DIRECT ROUTE BUS CARDS
  // ====================================================
  const effectiveStops = currentStopsList;
  let userPickupIdx = selectedPickupStop ? effectiveStops.findIndex(s => normalizeStr(s.name) === normalizeStr(selectedPickupStop.name)) : -1;
  let userDestIdx = selectedDestStop ? effectiveStops.findIndex(s => normalizeStr(s.name) === normalizeStr(selectedDestStop.name)) : -1;

  const allowedRouteKeys = activeMatchingRoutes.length > 0
    ? activeMatchingRoutes.map(r => normalizeStr(r.routeKey))
    : (activeRouteKey ? [normalizeStr(activeRouteKey)] : []);

  const viableBuses = [];

  Object.entries(activeBuses).forEach(([plate, bus]) => {
    const busRouteNorm = normalizeStr(bus.routeKey || bus.route);
    const isCorridorMatch = allowedRouteKeys.length === 0 || allowedRouteKeys.some(rKey => busRouteNorm.includes(rKey) || rKey.includes(busRouteNorm));
    const isSameDir = (bus.busDir === currentDirection);

    if (!isCorridorMatch || !isSameDir) return;

    const busCurrentIdx = findBusNearestStopIndex(bus.lat, bus.lng, effectiveStops);
    const busLocName = effectiveStops[busCurrentIdx]?.name || "En Route";

    // Strict Filter: Bus MUST be behind pickup stop
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

    if (!selectedBusPlate || !viableBuses.some(b => b.plate === selectedBusPlate)) {
      selectedBusPlate = viableBuses[0].plate;
    }

    const activeSelectedBus = viableBuses.find(b => b.plate === selectedBusPlate) || viableBuses[0];

    if (isTrackingConfirmed && floatingCard) {
      floatingCard.classList.remove("hidden");
      document.getElementById('floatBusPlate').innerHTML = `
        <div class="flex items-center gap-1.5 flex-nowrap">
          <span class="font-bold text-slate-900">${activeSelectedBus.plate}</span>
          <span class="text-[10px] font-extrabold text-sky-800 bg-sky-100/90 px-2 py-0.5 rounded border border-sky-200 whitespace-nowrap flex items-center gap-1">
            <span>➔</span>
            <span>${selectedDestStop ? selectedDestStop.name : 'En Route'}</span>
          </span>
        </div>
      `;
      document.getElementById('floatTelemetry').innerText = `Near: ${activeSelectedBus.currentLocationName} • Speed: ${activeSelectedBus.bus.spd.toFixed(1)} km/h`;
    }

    viableBuses.forEach((item, rank) => {
      const isSelected = (item.plate === selectedBusPlate);
      const isBest = (rank === 0);
      const cardinalDir = (item.bus.busDir === "UP") ? "North Bound" : "South Bound";

      const card = document.createElement("div");
      card.className = `bg-white border ${isSelected ? 'border-blue-500 ring-2 ring-blue-500/10' : 'border-slate-200'} hover:border-blue-500 rounded-2xl p-3.5 shadow-sm transition-all duration-200 hover:shadow-md cursor-pointer mb-2.5`;
      card.onclick = () => selectBus(item.plate);

      card.innerHTML = `
        <!-- Top Row -->
        <div class="flex items-center justify-between pb-2 border-b border-slate-100">
          <div>
            ${isBest ? `
              <span class="inline-flex items-center gap-1 bg-emerald-600 text-white text-[10px] font-extrabold px-2 py-0.5 rounded-md shadow-sm">
                ★ Best Option
              </span>
            ` : `
              <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Alternate</span>
            `}
          </div>
          <span class="inline-flex items-center gap-1.5 text-[11px] font-bold text-emerald-600">
            <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            Live
          </span>
        </div>

        <!-- Middle Row: Route Name & Direct Pickup ➔ Dest & ETA -->
        <div class="flex items-center justify-between mt-2.5 gap-2">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-2xl font-black text-blue-600 tracking-tight shrink-0">${item.bus.route}</span>
              <span class="text-xs font-bold text-slate-800 truncate">
                ${selectedPickupStop ? selectedPickupStop.name : 'Origin'} 
                <span class="text-slate-400 font-normal">➔</span> 
                ${selectedDestStop ? selectedDestStop.name : 'Destination'}
              </span>
            </div>
            <div class="text-[11px] text-slate-400 truncate mt-0.5">
              Near ${item.currentLocationName}
            </div>
          </div>

          <div class="text-right shrink-0">
            <div class="text-lg font-black text-emerald-600 leading-tight">${item.etaLabel}</div>
            <div class="text-[10px] text-slate-400 whitespace-nowrap">${item.stopsAway === 0 ? 'Approaching' : `${item.stopsAway} stops away`}</div>
          </div>
        </div>

        <!-- Bottom Info: Plate, Radio, Cardinal Direction -->
        <div class="flex items-center justify-between text-[11px] font-medium text-slate-500 mt-2.5 pt-2 border-t border-slate-100">
          <span class="font-mono font-bold text-slate-700">${item.bus.plate}</span>
          <span class="flex items-center gap-1 text-slate-500">
            <i data-lucide="radio" class="w-3 h-3 text-slate-400"></i> Live
          </span>
          <span class="flex items-center gap-1 text-slate-600">
            <i data-lucide="navigation" class="w-3 h-3 text-slate-400"></i> ${cardinalDir}
          </span>
        </div>

        <!-- Stable Track Button -->
        <div class="mt-3">
          <button onclick="event.stopPropagation(); selectBus('${item.plate}'); startTracking();" class="w-full bg-blue-600 hover:bg-blue-700 active:scale-[0.98] text-white font-bold text-xs py-2 px-4 rounded-xl shadow-md shadow-blue-500/20 flex items-center justify-center gap-2 transition-all">
            <i data-lucide="map-pin" class="w-3.5 h-3.5"></i>
            <span>Track this bus</span>
          </button>
        </div>
      `;

      container.appendChild(card);
    });
  } else {
    if (floatingCard) floatingCard.classList.add("hidden");
    selectedBusPlate = null;

    const corridorRoutes = (activeMatchingRoutes.length > 0) ? activeMatchingRoutes : (lastSearchResult?.direct || []);

    corridorRoutes.forEach(r => {
      const config = window.ROUTES_DATABASE[r.routeKey];
      if (!config) return;

      const card = document.createElement("div");
      card.className = "bg-white border border-slate-200 rounded-2xl p-3.5 shadow-sm transition-all duration-200 mb-2.5";
      card.innerHTML = `
        <div class="flex items-center justify-between pb-2 border-b border-slate-100">
          <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Scheduled Service</span>
          <span class="text-[11px] font-semibold text-slate-400">No Live GPS</span>
        </div>
        <div class="flex items-center justify-between mt-2.5">
          <div class="flex items-center gap-2.5 min-w-0 pr-2">
            <div class="text-2xl font-black text-slate-600 tracking-tight shrink-0">${config.name}</div>
            <div class="min-w-0">
              <div class="text-xs font-bold text-slate-800 truncate">
                ${selectedPickupStop ? selectedPickupStop.name : 'Origin'} ➔ ${selectedDestStop ? selectedDestStop.name : 'Destination'}
              </div>
              <div class="text-[10px] text-slate-400">Timetable Route</div>
            </div>
          </div>
        </div>
      `;
      container.appendChild(card);
    });
  }

  lucide.createIcons();
}

function selectBus(plate) {
  selectedBusPlate = plate;
  updateAvailableBusesList();
  if (activeBuses[plate]) {
    map.panTo([activeBuses[plate].lat, activeBuses[plate].lng]);
    if (isTrackingConfirmed) {
      updateStopsTable(activeBuses[plate].lat, activeBuses[plate].lng, activeBuses[plate].spd);
    }
  }
}

// ==========================================
// 8. STOP TIMELINE TABLE (LIVE IN PREVIEW & TRACKING)
// ==========================================
function updateStopsTable(busLat, busLng, currentSpeedKmph) {
  if (!selectedPickupStop || !selectedDestStop) return;

  if (!selectedBusPlate || !activeBuses[selectedBusPlate]) {
    renderSchedulePreview();
    return;
  }

  // 1-Transfer Live Tracking Table
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
    const ROAD_CURVATURE = 1.25;

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
        distLabel = dMeters >= 1000 ? `${(dMeters / 1000).toFixed(1)} km from bus` : `${Math.round(dMeters)} m from bus`;
      } else if (actualStopIdx === activeTransferPlan.leg1.pIdx) {
        displayStepNum = `${rideStepNum++}`;
        const dToPickup = calculateAccurateBusToStopDistance(busLat, busLng, activeTransferPlan.leg1.pIdx, activeTransferPlan.leg1.stops);
        const pickupDistStr = dToPickup >= 1000 ? `${(dToPickup / 1000).toFixed(1)} km` : `${Math.round(dToPickup)} m`;
        distLabel = `${pickupDistStr} (Boarding)`;
      } else {
        displayStepNum = `${rideStepNum++}`;
        const prev = activeTransferPlan.leg1.stops[actualStopIdx - 1];
        accRideDist += getDistanceMeters(prev.lat, prev.lng, stop.lat, stop.lng) * ROAD_CURVATURE;
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
          remLabel = (dDirectToStop <= 100) ? "🟢 Boarding (Arrived)" : "🟢 Boarding (Approaching)";
        } else {
          remLabel = `🟢 Boarding (${stopsToPickup} stop${stopsToPickup > 1 ? 's' : ''} away)`;
        }
      } else if (idx === leg1Stops.length - 1) {
        rowClass = "bg-amber-50/80 border-l-4 border-amber-500 font-bold text-slate-900";
        const stopEtaSec = calculateEtaSeconds(busLat, busLng, currentSpeedKmph, actualStopIdx, activeTransferPlan.leg1.stops);
        etaLabel = formatEtaTime(stopEtaSec);
        remLabel = "🔄 Alight for Transfer";
      } else if (actualStopIdx < activeTransferPlan.leg1.pIdx) {
        const stopEtaSec = calculateEtaSeconds(busLat, busLng, currentSpeedKmph, actualStopIdx, activeTransferPlan.leg1.stops);
        etaLabel = formatEtaTime(stopEtaSec);
        const stopsAway = actualStopIdx - busAbsoluteIdx;
        remLabel = `Approach stop • ${stopsAway} stop${stopsAway > 1 ? 's' : ''} away`;
      } else {
        const stopEtaSec = calculateEtaSeconds(busLat, busLng, currentSpeedKmph, actualStopIdx, activeTransferPlan.leg1.stops);
        etaLabel = formatEtaTime(stopEtaSec);
        const inRideStops = actualStopIdx - activeTransferPlan.leg1.pIdx;
        remLabel = `+${inRideStops} stop${inRideStops > 1 ? 's' : ''} ride`;
      }

      const tr = document.createElement("tr");
      if (rowClass) tr.className = rowClass;
      tr.innerHTML = `
        <td class="p-2.5 pl-4">${displayStepNum}</td>
        <td class="p-2.5 font-semibold text-slate-800">${stop.name} <span class="text-[10px] text-sky-700 font-bold">(${r1Name})</span></td>
        <td class="p-2.5 text-slate-600">${distLabel}</td>
        <td class="p-2.5 text-slate-600">${remLabel}</td>
        <td class="p-2.5 pr-4"><span class="px-2 py-0.5 rounded text-[11px] font-bold ${badgeClass}">${etaLabel}</span></td>
      `;
      tbody.appendChild(tr);
    });

    const transferTr = document.createElement("tr");
    transferTr.className = "bg-amber-100/70 font-extrabold text-amber-900";
    transferTr.innerHTML = `
      <td class="p-2 pl-4 text-center">🔄</td>
      <td colspan="4" class="p-2 text-xs">Switch to <span class="underline decoration-amber-600 font-black">${r2Name}</span> towards ${selectedDestStop.name}</td>
    `;
    tbody.appendChild(transferTr);

    leg2Stops.forEach((stop, idx) => {
      const isFinal = (idx === leg2Stops.length - 1);
      const tr = document.createElement("tr");
      if (isFinal) tr.className = "bg-rose-50/80 border-l-4 border-rose-500 font-bold text-slate-900";
      tr.innerHTML = `
        <td class="p-2.5 pl-4">${rideStepNum++}</td>
        <td class="p-2.5 font-semibold text-slate-800">${stop.name} <span class="text-[10px] text-amber-700 font-bold">(${r2Name})</span></td>
        <td class="p-2.5 text-slate-400">--</td>
        <td class="p-2.5 text-slate-500">${isFinal ? "🏁 Final Destination" : "Connecting Ride"}</td>
        <td class="p-2.5 pr-4"><span class="px-2 py-0.5 rounded text-[11px] font-bold bg-slate-100 text-slate-500">Scheduled</span></td>
      `;
      tbody.appendChild(tr);
    });

    scrollTableToActiveRow();
    renderRoutePins(false);
    updateAvailableBusesList();
    updateTripSummaryUI();
    return;
  }

  // Direct Route Live Tracking Table
  const tbody = document.getElementById("stopsTableBody");
  tbody.innerHTML = "";

  const pIdx = currentStopsList.findIndex(s => normalizeStr(s.name) === normalizeStr(selectedPickupStop.name));
  const dIdx = currentStopsList.findIndex(s => normalizeStr(s.name) === normalizeStr(selectedDestStop.name));
  if (pIdx === -1 || dIdx === -1 || pIdx >= dIdx) return;

  const busAbsoluteIdx = findBusNearestStopIndex(busLat, busLng, currentStopsList);
  busNearestStopIdx = busAbsoluteIdx;

  const startSpanIdx = Math.min(busAbsoluteIdx, pIdx);
  const journeyStops = currentStopsList.slice(startSpanIdx, dIdx + 1);

  const ROAD_CURVATURE = 1.25;
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
      distLabel = dMeters >= 1000 ? `${(dMeters / 1000).toFixed(1)} km from bus` : `${Math.round(dMeters)} m from bus`;
    } else if (actualStopIdx === pIdx) {
      displayStepNum = `${rideStepNum++}`;
      const dToPickup = calculateAccurateBusToStopDistance(busLat, busLng, pIdx, currentStopsList);
      const pickupDistStr = dToPickup >= 1000 ? `${(dToPickup / 1000).toFixed(1)} km` : `${Math.round(dToPickup)} m`;
      distLabel = `${pickupDistStr} (Boarding)`;
    } else {
      displayStepNum = `${rideStepNum++}`;
      const prev = currentStopsList[actualStopIdx - 1];
      accRideDist += getDistanceMeters(prev.lat, prev.lng, stop.lat, stop.lng) * ROAD_CURVATURE;
      distLabel = (actualStopIdx === dIdx) ? `+${(accRideDist / 1000).toFixed(1)} km (Drop)` : `+${(accRideDist / 1000).toFixed(1)} km ride`;
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
        remLabel = (dDirectToStop <= 100) ? "🟢 Boarding (Arrived)" : "🟢 Boarding (Approaching)";
      } else {
        remLabel = `🟢 Boarding (${stopsToPickup} stop${stopsToPickup > 1 ? 's' : ''} away)`;
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
      remLabel = `Approach stop • ${stopsAway} stop${stopsAway > 1 ? 's' : ''} away`;
    } else {
      const stopEtaSec = calculateEtaSeconds(busLat, busLng, currentSpeedKmph, actualStopIdx, currentStopsList);
      etaLabel = formatEtaTime(stopEtaSec);
      const inRideStops = actualStopIdx - pIdx;
      remLabel = `+${inRideStops} stop${inRideStops > 1 ? 's' : ''} ride`;
    }

    const tr = document.createElement("tr");
    if (rowClass) tr.className = rowClass;
    tr.innerHTML = `
      <td class="p-2.5 pl-4">${displayStepNum}</td>
      <td class="p-2.5 font-semibold text-slate-800">${stop.name}</td>
      <td class="p-2.5 text-slate-600">${distLabel}</td>
      <td class="p-2.5 text-slate-600">${remLabel}</td>
      <td class="p-2.5 pr-4"><span class="px-2 py-0.5 rounded text-[11px] font-bold ${badgeClass}">${etaLabel}</span></td>
    `;
    tbody.appendChild(tr);
  });

  scrollTableToActiveRow();
  renderRoutePins(false);
  updateAvailableBusesList();
  updateTripSummaryUI();
}

function recenterMap() {
  if (selectedBusPlate && activeBusMarkers[selectedBusPlate]) {
    map.flyTo(activeBusMarkers[selectedBusPlate].getLatLng(), 15, { animate: true, duration: 1 });
  }
}

// ==========================================
// 9. MQTT TELEMETRY
// ==========================================
updateAvailableBusesList();

const client = mqtt.connect('wss://broker.hivemq.com:8884/mqtt');

client.on('connect', () => {
  const badge = document.getElementById('connBadge');
  badge.className = "px-2.5 py-1 rounded-full font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 shadow-sm flex items-center gap-1";
  badge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span><span>Live Connected</span>`;
  client.subscribe("citytransit/+/+/data");
});

client.on('message', (topic, message) => {
  try {
    const d = JSON.parse(message.toString());
    const busPlate = d.bus_no || "UNKNOWN";
    const rawRouteName = d.route || "77A_NOBATA";
    const busSpeed = parseFloat(d.spd || 0);

    let resolvedRouteKey = Object.keys(window.ROUTES_DATABASE || {}).find(
      key => normalizeStr(key) === normalizeStr(rawRouteName)
    ) || Object.keys(window.ROUTES_DATABASE || {})[0];

    const routeConfig = window.ROUTES_DATABASE[resolvedRouteKey];

    if (!activeRouteKey && routeConfig) {
      activeRouteKey = resolvedRouteKey;
      currentStopsList = routeConfig.forwardStops;
      updateDirectionBannerText();
    }

    const detectedDir = updateBusDirectionFromMovement(busPlate, d.lat, d.lng, d.heading, busSpeed, d.dir, routeConfig);

    activeBuses[busPlate] = {
      plate: busPlate,
      routeKey: resolvedRouteKey,
      route: routeConfig.name,
      subTitle: routeConfig.subTitle,
      lat: d.lat,
      lng: d.lng,
      spd: busSpeed,
      heading: d.heading,
      busDir: detectedDir,
      lastSeen: Date.now()
    };

    const parts = (routeConfig.subTitle || "").split(/<->|↔|->|-/).map(s => s.trim()).filter(Boolean);
    const destTerminal = (detectedDir === "DOWN") ? (parts[0] || "Down") : (parts[1] || "Up");

    const pos = [d.lat, d.lng];
    const busHeading = d.heading !== undefined ? d.heading : (detectedDir === "UP" ? 45 : 225);

    if (!activeBusMarkers[busPlate]) {
      activeBusMarkers[busPlate] = L.marker(pos, {
        icon: createDynamicBusMapIcon(routeConfig.name, busPlate, busHeading, destTerminal)
      }).addTo(map);
      breadcrumbLines[busPlate] = L.polyline([], { color: '#0284c7', weight: 4 }).addTo(map);
    } else {
      activeBusMarkers[busPlate].setLatLng(pos);
      activeBusMarkers[busPlate].setIcon(createDynamicBusMapIcon(routeConfig.name, busPlate, busHeading, destTerminal));
    }
    breadcrumbLines[busPlate].addLatLng(pos);

    if (busPlate === selectedBusPlate) {
      updateStopsTable(d.lat, d.lng, busSpeed);
    } else {
      updateAvailableBusesList();
    }
  } catch (e) {
    console.error("Telemetry Payload error:", e);
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [plate, bus] of Object.entries(activeBuses)) {
    if (now - bus.lastSeen > 30000) {
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
      updateAvailableBusesList();
    }
  }
}, 10000);

client.on('offline', () => {
  const badge = document.getElementById('connBadge');
  badge.className = "px-2.5 py-1 rounded-full font-bold bg-rose-50 text-rose-700 border border-rose-200 shadow-sm flex items-center gap-1";
  badge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse"></span><span>Reconnecting...</span>`;
});