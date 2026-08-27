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

const activeBuses = {};
const activeBusMarkers = {};
let selectedBusPlate = null;

// ==========================================
// 2. LEAFLET MAP SETUP
// ==========================================
const map = L.map('map', { center: [22.5000, 88.2500], zoom: 12, zoomControl: false });

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

map.on('click', () => closeBottomSheet());
map.on('dragstart', () => closeBottomSheet());

let routePolylineLayer = null;
let stopMarkersLayer = L.layerGroup().addTo(map);
let breadcrumbLines = {};

function createDynamicBusMapIcon(routeString, busPlate) {
  return L.divIcon({
    className: '',
    html: `
      <div class="bus-marker-wrapper">
        <div class="bus-tag-top">${routeString}</div>
        <div class="relative w-8 h-8 flex items-center justify-center">
          <div class="bus-pulse"></div>
          <div class="relative z-10 w-8 h-8 bg-slate-900 text-white rounded-full border-2 border-white shadow-xl flex items-center justify-center">
            <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6v6"/><path d="M15 6v6"/><path d="M2 12h19.6"/><path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><circle cx="15" cy="18" r="2"/></svg>
          </div>
        </div>
        <div class="bus-tag-bottom">${busPlate}</div>
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
  } else if (type === "transfer") {
    color = "#f59e0b";
    size = 16;
    border = "3px solid #fff; box-shadow: 0 0 12px #f59e0b;";
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
    totalStops: intermediateStops
  };
}

function updateBusDirectionFromMovement(busPlate, newLat, newLng, newHeading) {
  const prev = activeBuses[busPlate];
  if (!prev) {
    if (newHeading !== undefined && newHeading >= 0) {
      if (newHeading >= 20 && newHeading <= 160) return "UP";
      if (newHeading >= 200 && newHeading <= 340) return "DOWN";
    }
    return "UP";
  }

  const dLng = newLng - prev.lng;
  const moved = getDistanceMeters(prev.lat, prev.lng, newLat, newLng);

  if (moved >= 4.0) {
    if (dLng > 0.00003) return "UP";
    if (dLng < -0.00003) return "DOWN";
  }

  return prev.busDir || "UP";
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
// 4. ROUTE SEARCH ENGINE (OPTIMAL TRANSFERS)
// ==========================================
function updateDirectionBannerText() {
  const labelElem = document.getElementById("currentDirectionLabel");
  if (!labelElem) return;

  if (activeTransferPlan) {
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

  if (!window.ROUTES_DATABASE || !activeRouteKey) return;
  const routeConfig = window.ROUTES_DATABASE[activeRouteKey];
  if (!routeConfig) return;

  const parts = (routeConfig.subTitle || "").split(/<->|↔|->|-/).map(s => s.trim()).filter(Boolean);
  const startTerm = parts[0] || "";
  const endTerm = parts[1] || "";

  if (currentDirection === "UP") {
    labelElem.innerHTML = `<span class="text-slate-900 font-bold">${routeConfig.name}:</span> ${startTerm} <span class="text-emerald-600 font-bold">➔</span> ${endTerm}`;
  } else {
    labelElem.innerHTML = `<span class="text-slate-900 font-bold">${routeConfig.name}:</span> ${endTerm} <span class="text-emerald-600 font-bold">➔</span> ${startTerm}`;
  }
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

    const card = document.createElement("div");
    card.className = "p-3 rounded-2xl border border-slate-200/80 bg-slate-50/60 flex items-center justify-between hover:border-emerald-500 transition-all";
    card.innerHTML = `
      <div class="flex items-center gap-3">
        <div class="px-2.5 py-1.5 rounded-xl bg-emerald-100/80 text-emerald-800 font-extrabold text-xs shrink-0 border border-emerald-200/60 min-w-[55px] text-center">
          ${config.name}
        </div>
        <div>
          <div class="text-xs font-bold text-slate-800">${lineDir}</div>
          <div class="text-[10px] text-slate-400 mt-0.5">${config.forwardStops.length} Total Route Stops</div>
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

function findMatchingRoutes(pName, dName) {
  const pNorm = normalizeStr(pName);
  const dNorm = normalizeStr(dName);
  const directMatches = [];
  const transferMatches = [];

  if (!window.ROUTES_DATABASE) return { direct: [], transfers: [] };

  const allRouteKeys = Object.keys(window.ROUTES_DATABASE);

  // 1. Direct Route Check
  for (const rKey of allRouteKeys) {
    const rObj = window.ROUTES_DATABASE[rKey];
    
    const pUp = rObj.forwardStops.findIndex(s => normalizeStr(s.name).includes(pNorm) || (s.area && normalizeStr(s.area).includes(pNorm)));
    const dUp = rObj.forwardStops.findIndex(s => normalizeStr(s.name).includes(dNorm) || (s.area && normalizeStr(s.area).includes(dNorm)));
    if (pUp !== -1 && dUp !== -1 && pUp < dUp) {
      directMatches.push({ type: 'DIRECT', routeKey: rKey, direction: "UP", stops: rObj.forwardStops });
      continue;
    }

    const pDown = rObj.returnStops.findIndex(s => normalizeStr(s.name).includes(pNorm) || (s.area && normalizeStr(s.area).includes(pNorm)));
    const dDown = rObj.returnStops.findIndex(s => normalizeStr(s.name).includes(dNorm) || (s.area && normalizeStr(s.area).includes(dNorm)));
    if (pDown !== -1 && dDown !== -1 && pDown < dDown) {
      directMatches.push({ type: 'DIRECT', routeKey: rKey, direction: "DOWN", stops: rObj.returnStops });
    }
  }

  if (directMatches.length > 0) {
    return { direct: directMatches, transfers: [] };
  }

  // 2. Optimal 1-Transfer Check (Prefers maximum initial ride length)
  for (const r1Key of allRouteKeys) {
    const r1 = window.ROUTES_DATABASE[r1Key];
    const directions1 = [
      { dir: "UP", stops: r1.forwardStops },
      { dir: "DOWN", stops: r1.returnStops }
    ];

    for (const leg1 of directions1) {
      const pIdx = leg1.stops.findIndex(s => normalizeStr(s.name).includes(pNorm) || (s.area && normalizeStr(s.area).includes(pNorm)));
      if (pIdx === -1) continue;

      for (let tIdx = leg1.stops.length - 1; tIdx > pIdx; tIdx--) {
        const transferStop = leg1.stops[tIdx];
        const tNorm = normalizeStr(transferStop.name);

        for (const r2Key of allRouteKeys) {
          if (r2Key === r1Key) continue;
          const r2 = window.ROUTES_DATABASE[r2Key];
          const directions2 = [
            { dir: "UP", stops: r2.forwardStops },
            { dir: "DOWN", stops: r2.returnStops }
          ];

          for (const leg2 of directions2) {
            const t2Idx = leg2.stops.findIndex(s => normalizeStr(s.name).includes(tNorm) || (s.area && normalizeStr(s.area).includes(tNorm)));
            const d2Idx = leg2.stops.findIndex(s => normalizeStr(s.name).includes(dNorm) || (s.area && normalizeStr(s.area).includes(dNorm)));

            if (t2Idx !== -1 && d2Idx !== -1 && t2Idx < d2Idx) {
              transferMatches.push({
                type: 'TRANSFER',
                transferStopName: transferStop.name,
                leg1: {
                  routeKey: r1Key,
                  direction: leg1.dir,
                  stops: leg1.stops,
                  pickupStop: leg1.stops[pIdx],
                  transferStop: leg1.stops[tIdx],
                  pIdx: pIdx,
                  tIdx: tIdx
                },
                leg2: {
                  routeKey: r2Key,
                  direction: leg2.dir,
                  stops: leg2.stops,
                  transferStop: leg2.stops[t2Idx],
                  destStop: leg2.stops[d2Idx],
                  tIdx: t2Idx,
                  dIdx: d2Idx
                }
              });
            }
          }
        }
      }
    }
  }

  // Sort transfers by maximizing Leg 1 progress
  transferMatches.sort((a, b) => (b.leg1.tIdx - b.leg1.pIdx) - (a.leg1.tIdx - a.leg1.pIdx));

  return { direct: [], transfers: transferMatches };
}

function handleSearchClick() {
  const pickVal = document.getElementById("pickup-input").value.trim();
  const destVal = document.getElementById("dest-input").value.trim();

  if (!pickVal || !destVal) {
    alert("Please select both Pickup and Destination stops!");
    return;
  }

  const result = findMatchingRoutes(pickVal, destVal);

  busNearestStopIdx = 0;
  selectedBusPlate = null;

  if (result.direct.length > 0) {
    activeTransferPlan = null;
    activeMatchingRoutes = result.direct;
    const primary = result.direct[0];
    activeRouteKey = primary.routeKey;
    currentDirection = primary.direction;
    currentStopsList = primary.stops;

    const pNorm = normalizeStr(pickVal);
    const dNorm = normalizeStr(destVal);
    selectedPickupStop = currentStopsList.find(s => normalizeStr(s.name).includes(pNorm) || (s.area && normalizeStr(s.area).includes(pNorm)));
    selectedDestStop = currentStopsList.find(s => normalizeStr(s.name).includes(dNorm) || (s.area && normalizeStr(s.area).includes(dNorm)));

    updateDirectionBannerText();
    updateTripSummaryUI();
    openBottomSheet();
    renderSchedulePreview();
    
    if (isTrackingConfirmed) {
      renderRoutePins(true);
    }
    
    updateAvailableBusesList();
    return;
  }

  if (result.transfers.length > 0) {
    activeTransferPlan = result.transfers[0];
    activeMatchingRoutes = [{ routeKey: activeTransferPlan.leg1.routeKey, direction: activeTransferPlan.leg1.direction }];
    activeRouteKey = activeTransferPlan.leg1.routeKey;
    currentDirection = activeTransferPlan.leg1.direction;
    currentStopsList = activeTransferPlan.leg1.stops;
    
    selectedPickupStop = activeTransferPlan.leg1.pickupStop;
    selectedDestStop = activeTransferPlan.leg2.destStop;

    updateDirectionBannerText();
    updateTripSummaryUI();
    openBottomSheet();
    renderSchedulePreview();
    
    if (isTrackingConfirmed) {
      renderRoutePins(true);
    }
    
    updateAvailableBusesList();
    return;
  }

  alert("No direct or connecting route found between these locations in this direction.");
}

function updateTripSummaryUI() {
  if (!selectedPickupStop || !selectedDestStop) return;

  if (activeTransferPlan) {
    const s1 = calculateTripSummary(activeTransferPlan.leg1.pickupStop, activeTransferPlan.leg1.transferStop, activeTransferPlan.leg1.stops);
    const s2 = calculateTripSummary(activeTransferPlan.leg2.transferStop, activeTransferPlan.leg2.destStop, activeTransferPlan.leg2.stops);
    
    const totalDist = ((parseFloat(s1?.distanceKm || 0)) + (parseFloat(s2?.distanceKm || 0))).toFixed(1);
    const totalStops = (s1?.totalStops || 0) + (s2?.totalStops || 0);

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
    document.getElementById("journeyStopsCount").innerText = `(${summary.totalStops} stops)`;
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

  isTrackingConfirmed = true;
  
  const btn = document.getElementById("btnTrackAction");
  btn.className = "bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs px-4 py-2 rounded-xl shadow-md shadow-rose-600/20 transition-all flex items-center gap-1.5 active:scale-95";
  btn.innerHTML = `<i data-lucide="x" class="w-3.5 h-3.5"></i><span>Cancel Track</span>`;
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
  btn.innerHTML = `<i data-lucide="check" class="w-3.5 h-3.5"></i><span>Confirm Route & Track</span>`;
  lucide.createIcons();

  document.getElementById("activeTripBar").classList.add("hidden");
  document.getElementById("floatingBusCard").classList.add("hidden");
  document.getElementById("tripStatsPill").classList.add("hidden");
  
  renderRoutePins(false);
  renderSchedulePreview();
  updateAvailableBusesList();
}

// ==========================================
// 5. SCHEDULE PREVIEW (SUPPORTS FULL 2-LEG TRANSFERS)
// ==========================================
function renderSchedulePreview() {
  const tbody = document.getElementById("stopsTableBody");
  tbody.innerHTML = "";

  document.querySelector("#bottomSheet .overflow-y-auto")?.scrollTo({ top: 0 });

  if (activeTransferPlan) {
    const leg1Stops = activeTransferPlan.leg1.stops.slice(activeTransferPlan.leg1.pIdx, activeTransferPlan.leg1.tIdx + 1);
    const leg2Stops = activeTransferPlan.leg2.stops.slice(activeTransferPlan.leg2.tIdx + 1, activeTransferPlan.leg2.dIdx + 1);

    const r1Name = window.ROUTES_DATABASE[activeTransferPlan.leg1.routeKey]?.name || "Bus 1";
    const r2Name = window.ROUTES_DATABASE[activeTransferPlan.leg2.routeKey]?.name || "Bus 2";

    let stepNum = 1;

    // Leg 1 Stops
    leg1Stops.forEach((stop, idx) => {
      const isBoarding = (idx === 0);
      const isTransferPoint = (idx === leg1Stops.length - 1);
      
      let rowClass = isBoarding ? "bg-emerald-50/80 border-l-4 border-emerald-500 font-bold text-slate-900" : "";
      if (isTransferPoint) rowClass = "bg-amber-50/80 border-l-4 border-amber-500 font-bold text-slate-900";

      const tr = document.createElement("tr");
      if (rowClass) tr.className = rowClass;
      tr.innerHTML = `
        <td class="p-2.5 pl-4">${stepNum++}</td>
        <td class="p-2.5 font-semibold text-slate-800">${stop.name} <span class="text-[10px] text-sky-700 font-bold">(${r1Name})</span></td>
        <td class="p-2.5 text-slate-400">--</td>
        <td class="p-2.5 text-slate-500">${isBoarding ? "Board First Bus" : (isTransferPoint ? "Alight for Transfer" : "Ride")}</td>
        <td class="p-2.5 pr-4"><span class="px-2 py-0.5 rounded text-[11px] font-bold bg-slate-100 text-slate-500">Ready</span></td>
      `;
      tbody.appendChild(tr);
    });

    // Transfer Row Indicator
    const transferTr = document.createElement("tr");
    transferTr.className = "bg-amber-100/70 font-extrabold text-amber-900";
    transferTr.innerHTML = `
      <td class="p-2 pl-4 text-center">🔄</td>
      <td colspan="4" class="p-2 text-xs">Switch to <span class="underline decoration-amber-600 font-black">${r2Name}</span> towards ${selectedDestStop.name}</td>
    `;
    tbody.appendChild(transferTr);

    // Leg 2 Stops
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
        <td class="p-2.5 pr-4"><span class="px-2 py-0.5 rounded text-[11px] font-bold bg-slate-100 text-slate-500">Ready</span></td>
      `;
      tbody.appendChild(tr);
    });
    return;
  }

  // Direct Route Single Schedule
  const pIdx = selectedPickupStop ? currentStopsList.findIndex(s => normalizeStr(s.name) === normalizeStr(selectedPickupStop.name)) : 0;
  const dIdx = selectedDestStop ? currentStopsList.findIndex(s => normalizeStr(s.name) === normalizeStr(selectedDestStop.name)) : currentStopsList.length - 1;

  const journeyStops = currentStopsList.slice(pIdx, dIdx + 1);

  journeyStops.forEach((stop, idx) => {
    let rowClass = "";
    if (idx === 0) {
      rowClass = "bg-emerald-50/80 border-l-4 border-emerald-500 font-bold text-slate-900";
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
      <td class="p-2.5 pr-4"><span class="px-2 py-0.5 rounded text-[11px] font-bold bg-slate-100 text-slate-500">Ready</span></td>
    `;
    tbody.appendChild(tr);
  });
}

// ==========================================
// 6. MAP POLYLINE (SUPPORTS FULL 2-LEG TRANSFERS)
// ==========================================
function renderRoutePins(autoFit = false) {
  if (routePolylineLayer) map.removeLayer(routePolylineLayer);
  stopMarkersLayer.clearLayers();

  if (!isTrackingConfirmed || !selectedPickupStop || !selectedDestStop) return;

  if (activeTransferPlan) {
    const leg1Stops = activeTransferPlan.leg1.stops.slice(activeTransferPlan.leg1.pIdx, activeTransferPlan.leg1.tIdx + 1);
    const leg2Stops = activeTransferPlan.leg2.stops.slice(activeTransferPlan.leg2.tIdx, activeTransferPlan.leg2.dIdx + 1);

    const fullJourney = [...leg1Stops, ...leg2Stops.slice(1)];
    const pathPoints = fullJourney.map(s => [s.lat, s.lng]);

    routePolylineLayer = L.polyline(pathPoints, {
      color: '#059669',
      weight: 6,
      opacity: 0.9
    }).addTo(map);

    if (autoFit && pathPoints.length > 0) {
      map.fitBounds(routePolylineLayer.getBounds(), { padding: [50, 50] });
    }

    L.marker([selectedPickupStop.lat, selectedPickupStop.lng], { icon: createPinIcon("pickup") })
      .bindPopup(`🟢 <b>Board First Bus:</b> ${selectedPickupStop.name}`)
      .addTo(stopMarkersLayer);

    const transferPt = activeTransferPlan.leg1.transferStop;
    L.marker([transferPt.lat, transferPt.lng], { icon: createPinIcon("transfer") })
      .bindPopup(`🔄 <b>Interchange Point:</b> ${transferPt.name}`)
      .addTo(stopMarkersLayer);

    L.marker([selectedDestStop.lat, selectedDestStop.lng], { icon: createPinIcon("dest") })
      .bindPopup(`🔴 <b>Final Destination:</b> ${selectedDestStop.name}`)
      .addTo(stopMarkersLayer);
    return;
  }

  const pIdx = currentStopsList.findIndex(s => normalizeStr(s.name) === normalizeStr(selectedPickupStop.name));
  const dIdx = currentStopsList.findIndex(s => normalizeStr(s.name) === normalizeStr(selectedDestStop.name));

  if (pIdx === -1 || dIdx === -1 || pIdx >= dIdx) return;

  const tripSegmentStops = currentStopsList.slice(pIdx, dIdx + 1);
  const pathPoints = tripSegmentStops.map(s => [s.lat, s.lng]);

  routePolylineLayer = L.polyline(pathPoints, {
    color: '#059669',
    weight: 6,
    opacity: 0.9
  }).addTo(map);

  if (autoFit && pathPoints.length > 0) {
    map.fitBounds(routePolylineLayer.getBounds(), { padding: [50, 50] });
  }

  tripSegmentStops.forEach((stop, index) => {
    const actualIdx = pIdx + index;
    let type = "regular";
    let label = `<b>Stop:</b> ${stop.name}`;

    if (actualIdx === pIdx) {
      type = "pickup";
      label = `🟢 <b>Boarding Stop:</b> ${stop.name}`;
    } else if (actualIdx === dIdx) {
      type = "dest";
      label = `🔴 <b>Deboarding Stop:</b> ${stop.name}`;
    }

    L.marker([stop.lat, stop.lng], { icon: createPinIcon(type) })
      .bindPopup(label)
      .addTo(stopMarkersLayer);
  });
}

// ==========================================
// 7. MULTI-BUS DRAWER & LIVE TABLE UPDATES
// ==========================================
function updateAvailableBusesList() {
  const container = document.getElementById("busesListContainer");
  const floatingCard = document.getElementById("floatingBusCard");
  container.innerHTML = "";

  let userPickupIdx = -1;
  let userDestIdx = -1;

  if (selectedPickupStop && selectedDestStop) {
    userPickupIdx = currentStopsList.findIndex(s => normalizeStr(s.name) === normalizeStr(selectedPickupStop.name));
    userDestIdx = activeTransferPlan 
      ? activeTransferPlan.leg1.tIdx 
      : currentStopsList.findIndex(s => normalizeStr(s.name) === normalizeStr(selectedDestStop.name));
  }

  const allowedRouteKeys = activeMatchingRoutes.length > 0
    ? activeMatchingRoutes.map(r => normalizeStr(r.routeKey))
    : (activeRouteKey ? [normalizeStr(activeRouteKey)] : []);

  const routeBuses = Object.entries(activeBuses).filter(([plate, bus]) => {
    const busRouteNorm = normalizeStr(bus.routeKey || bus.route);
    const isCorridorMatch = allowedRouteKeys.length === 0 || allowedRouteKeys.some(rKey => busRouteNorm.includes(rKey) || rKey.includes(busRouteNorm));
    const isSameDir = (bus.busDir === currentDirection);
    return isCorridorMatch && isSameDir;
  });

  const viableBuses = [];

  routeBuses.forEach(([plate, bus]) => {
    const busCurrentIdx = findBusNearestStopIndex(bus.lat, bus.lng, currentStopsList);
    const busLocName = currentStopsList[busCurrentIdx]?.name || "En Route";

    if (userPickupIdx !== -1 && busCurrentIdx > userPickupIdx) {
      return; 
    }

    if (userDestIdx !== -1 && busCurrentIdx >= userDestIdx) {
      return;
    }

    const etaSec = userPickupIdx !== -1 ? calculateEtaSeconds(bus.lat, bus.lng, bus.spd, userPickupIdx, currentStopsList) : Infinity;

    let distMeters = getDistanceMeters(bus.lat, bus.lng, currentStopsList[busCurrentIdx].lat, currentStopsList[busCurrentIdx].lng) * 1.25;
    for (let k = busCurrentIdx + 1; k <= userPickupIdx; k++) {
      distMeters += getDistanceMeters(currentStopsList[k - 1].lat, currentStopsList[k - 1].lng, currentStopsList[k].lat, currentStopsList[k].lng) * 1.25;
    }

    viableBuses.push({
      plate,
      bus,
      currentLocationName: busLocName,
      targetStopName: selectedPickupStop ? selectedPickupStop.name : busLocName,
      etaSec,
      etaLabel: formatEtaTime(etaSec),
      distMeters,
      stopsAway: userPickupIdx - busCurrentIdx
    });
  });

  if (viableBuses.length === 0) {
    const dirText = currentDirection === "UP" ? "Forward (UP)" : "Return (DOWN)";
    container.innerHTML = `
      <div class="p-4 text-center text-slate-400 text-xs">
        No active buses currently upcoming to your pickup stop in the <b>${dirText}</b> direction.
      </div>
    `;
    floatingCard.classList.add("hidden");
    selectedBusPlate = null;
    
    if (isTrackingConfirmed) {
      cancelTracking();
    }
    return;
  }

  viableBuses.sort((a, b) => a.etaSec - b.etaSec);

  if (!selectedBusPlate || !viableBuses.some(b => b.plate === selectedBusPlate)) {
    selectedBusPlate = viableBuses[0].plate;
  }

  const activeSelectedBus = viableBuses.find(b => b.plate === selectedBusPlate) || viableBuses[0];

  if (isTrackingConfirmed) {
    floatingCard.classList.remove("hidden");
    
    const floatBusConfig = (activeSelectedBus.bus.routeKey && window.ROUTES_DATABASE?.[activeSelectedBus.bus.routeKey]) || activeSelectedBus.bus;
    const floatParts = (floatBusConfig.subTitle || "").split(/<->|↔|->|-/).map(s => s.trim()).filter(Boolean);
    const destTerminal = (activeSelectedBus.bus.busDir === "DOWN") ? (floatParts[0] || "Down") : (floatParts[1] || "Up");

    document.getElementById('floatBusPlate').innerHTML = `
      <div class="flex items-center gap-1.5 flex-nowrap">
        <span class="font-bold text-slate-900">${activeSelectedBus.plate}</span>
        <span class="text-[10px] font-extrabold text-sky-800 bg-sky-100/90 px-2 py-0.5 rounded border border-sky-200 whitespace-nowrap flex items-center gap-1">
          <span>➔</span>
          <span>${destTerminal}</span>
        </span>
      </div>
    `;
    document.getElementById('floatTelemetry').innerText = `Near: ${activeSelectedBus.currentLocationName} • Speed: ${activeSelectedBus.bus.spd.toFixed(1)} km/h`;
  }

  viableBuses.forEach((item, rank) => {
    const isSelected = (item.plate === selectedBusPlate);
    const card = document.createElement("div");

    const distStr = item.distMeters >= 1000 
      ? `${(item.distMeters / 1000).toFixed(1)} km away` 
      : `${Math.round(item.distMeters)} m away`;

    const isBest = (rank === 0);
    const stopCountdownText = item.stopsAway === 0 
      ? 'Approaching now' 
      : `${item.stopsAway} stop${item.stopsAway > 1 ? 's' : ''} to pickup`;

    const badgeHtml = `
      <div class="text-[10px] ${isBest ? 'text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded' : 'text-emerald-600'} font-bold uppercase tracking-wider">
        ${isBest ? '★ BEST BUS (ETA)' : 'PICKUP ETA'}
      </div>
      <div class="text-xs font-extrabold text-slate-800 mt-0.5">${item.etaLabel}</div>
      <div class="text-[10px] font-bold text-sky-600 mt-0.5">${distStr} • ${stopCountdownText}</div>
    `;

    const thisBusConfig = (item.bus.routeKey && window.ROUTES_DATABASE?.[item.bus.routeKey]) || item.bus;
    let startTerm = "";
    let endTerm = "";

    if (thisBusConfig.subTitle) {
      const parts = thisBusConfig.subTitle.split(/<->|↔|->|-/).map(s => s.trim()).filter(Boolean);
      startTerm = parts[0] || "";
      endTerm = parts[1] || "";
    }

    const displayDirection = (item.bus.busDir === "DOWN" || currentDirection === "DOWN")
      ? `${endTerm} ➔ ${startTerm}`
      : `${startTerm} ➔ ${endTerm}`;

    card.className = `p-3 rounded-2xl border-2 transition-all flex items-center justify-between cursor-pointer ${isSelected ? 'bg-sky-50/80 border-sky-500 shadow-sm' : 'bg-white border-slate-200 hover:border-slate-300'}`;
    card.onclick = () => selectBus(item.plate);

    card.innerHTML = `
      <div class="flex items-center gap-3">
        <div class="px-2.5 py-2 rounded-xl bg-sky-100/70 text-sky-700 font-extrabold text-xs flex items-center justify-center shrink-0 border border-sky-200/60 min-w-[50px] text-center">
          ${item.bus.route}
        </div>
        <div>
          <div class="text-xs font-bold text-sky-900 leading-tight">
            ${item.bus.route} : <span class="text-slate-700 font-semibold">${displayDirection}</span>
          </div>
          <div class="text-[10px] text-slate-500 font-medium mt-0.5">
            📍 <span class="text-slate-800 font-semibold">${item.currentLocationName}</span> • <span class="font-mono text-slate-400">${item.bus.plate}</span>
          </div>
        </div>
      </div>
      <div class="text-right">
        ${badgeHtml}
      </div>
    `;
    container.appendChild(card);
  });
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

function updateStopsTable(busLat, busLng, currentSpeedKmph) {
  if (!isTrackingConfirmed || !selectedPickupStop || !selectedDestStop) return;

  if (!selectedBusPlate || !activeBuses[selectedBusPlate]) {
    renderSchedulePreview();
    return;
  }

  // Handle transfer route table updates
  if (activeTransferPlan) {
    renderSchedulePreview();
    return;
  }

  const tbody = document.getElementById("stopsTableBody");
  tbody.innerHTML = "";

  const pIdx = currentStopsList.findIndex(s => normalizeStr(s.name) === normalizeStr(selectedPickupStop.name));
  const dIdx = currentStopsList.findIndex(s => normalizeStr(s.name) === normalizeStr(selectedDestStop.name));
  if (pIdx === -1 || dIdx === -1 || pIdx >= dIdx) return;

  const journeyStops = currentStopsList.slice(pIdx, dIdx + 1);
  const busAbsoluteIdx = findBusNearestStopIndex(busLat, busLng, currentStopsList);
  busNearestStopIdx = busAbsoluteIdx;

  const ROAD_CURVATURE = 1.25;
  let accRideDist = 0;

  journeyStops.forEach((stop, relIdx) => {
    const actualStopIdx = pIdx + relIdx;
    let rowClass = "";
    let badgeClass = "bg-sky-50 text-sky-700 border border-sky-200";
    let distLabel = "--";
    let etaLabel = "--";
    let remLabel = "--";

    if (actualStopIdx === pIdx) {
      distLabel = "0.0 km (Pickup)";
    } else {
      const prev = currentStopsList[actualStopIdx - 1];
      accRideDist += getDistanceMeters(prev.lat, prev.lng, stop.lat, stop.lng) * ROAD_CURVATURE;
      distLabel = `${(accRideDist / 1000).toFixed(1)} km`;
    }

    if (busAbsoluteIdx > actualStopIdx) {
      etaLabel = "Departed";
      badgeClass = "bg-slate-100 text-slate-400";
      remLabel = "Missed";
      rowClass = "opacity-40";
    } else if (actualStopIdx === pIdx) {
      rowClass = "bg-emerald-50/80 border-l-4 border-emerald-500 font-bold text-slate-900";
      const stopEtaSec = calculateEtaSeconds(busLat, busLng, currentSpeedKmph, actualStopIdx, currentStopsList);
      etaLabel = formatEtaTime(stopEtaSec);
      
      const stopsToPickup = actualStopIdx - busAbsoluteIdx;
      remLabel = stopsToPickup === 0 ? "Approaching Now" : `${stopsToPickup} stop${stopsToPickup > 1 ? 's' : ''} to arrival`;
    } else if (relIdx === journeyStops.length - 1) {
      rowClass = "bg-rose-50/80 border-l-4 border-rose-500 font-bold text-slate-900";
      const stopEtaSec = calculateEtaSeconds(busLat, busLng, currentSpeedKmph, actualStopIdx, currentStopsList);
      etaLabel = formatEtaTime(stopEtaSec);
      remLabel = "🏁 Final Stop";
    } else {
      const stopEtaSec = calculateEtaSeconds(busLat, busLng, currentSpeedKmph, actualStopIdx, currentStopsList);
      etaLabel = formatEtaTime(stopEtaSec);
      remLabel = `+${relIdx} stop${relIdx > 1 ? 's' : ''} ride`;
    }

    const tr = document.createElement("tr");
    if (rowClass) tr.className = rowClass;
    tr.innerHTML = `
      <td class="p-2.5 pl-4">${relIdx + 1}</td>
      <td class="p-2.5 font-semibold text-slate-800">${stop.name}</td>
      <td class="p-2.5 text-slate-600">${distLabel}</td>
      <td class="p-2.5 text-slate-600">${remLabel}</td>
      <td class="p-2.5 pr-4"><span class="px-2 py-0.5 rounded text-[11px] font-bold ${badgeClass}">${etaLabel}</span></td>
    `;
    tbody.appendChild(tr);
  });

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
// 8. MQTT TELEMETRY
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

    let resolvedRouteKey = Object.keys(window.ROUTES_DATABASE || {}).find(
      key => normalizeStr(key) === normalizeStr(rawRouteName)
    ) || Object.keys(window.ROUTES_DATABASE || {})[0];

    const routeConfig = window.ROUTES_DATABASE[resolvedRouteKey];

    if (!activeRouteKey && routeConfig) {
      activeRouteKey = resolvedRouteKey;
      currentStopsList = routeConfig.forwardStops;
      updateDirectionBannerText();
    }

    const detectedDir = updateBusDirectionFromMovement(busPlate, d.lat, d.lng, d.heading);

    activeBuses[busPlate] = {
      plate: busPlate,
      routeKey: resolvedRouteKey,
      route: routeConfig.name,
      subTitle: routeConfig.subTitle,
      lat: d.lat,
      lng: d.lng,
      spd: d.spd,
      heading: d.heading,
      busDir: detectedDir,
      lastSeen: Date.now()
    };

    const pos = [d.lat, d.lng];
    if (!activeBusMarkers[busPlate]) {
      activeBusMarkers[busPlate] = L.marker(pos, {
        icon: createDynamicBusMapIcon(routeConfig.name, busPlate)
      }).addTo(map);
      breadcrumbLines[busPlate] = L.polyline([], { color: '#0284c7', weight: 4 }).addTo(map);
    } else {
      activeBusMarkers[busPlate].setLatLng(pos);
      activeBusMarkers[busPlate].setIcon(createDynamicBusMapIcon(routeConfig.name, busPlate));
    }
    breadcrumbLines[busPlate].addLatLng(pos);

    if (isTrackingConfirmed && busPlate === selectedBusPlate) {
      updateStopsTable(d.lat, d.lng, d.spd);
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