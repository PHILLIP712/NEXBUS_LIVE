lucide.createIcons();

// ==========================================
// 1. GLOBAL STRING NORMALIZER & UTILITIES
// ==========================================
function normalizeStr(str) {
  if (!str) return "";
  return str.toString()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ""); // Strips spaces, brackets, hyphens
}

// Global Application State (Dynamic - No hardcoded route)
let activeRouteKey = null;
let currentStopsList = [];
let currentDirection = "UP"; // User's active searched travel direction ("UP" or "DOWN")
let isTrackingConfirmed = false;
let selectedPickupStop = null;
let selectedDestStop = null;
let busNearestStopIdx = 0;
const GEOFENCE_RADIUS_METERS = 80;

const activeBuses = {};
const activeBusMarkers = {};
let selectedBusPlate = null;

// ==========================================
// 2. LEAFLET MAP & TILE LAYER (FREE OSM)
// ==========================================
const map = L.map('map', { center: [22.5000, 88.2500], zoom: 12, zoomControl: false });

// Free OpenStreetMap Tile Layer (No API Key Required)
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

// Pop down bottom drawer on map click or pan
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
    size = 16;
    border = "3px solid #fff; box-shadow: 0 0 10px #10b981;";
  } else if (type === "bus_loc") {
    color = "#f59e0b";
    size = 14;
    border = "2px solid #fff; box-shadow: 0 0 8px #f59e0b;";
  } else if (type === "dest") {
    color = "#ef4444";
    size = 16;
    border = "3px solid #fff; box-shadow: 0 0 10px #ef4444;";
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

// Find nearest stop index for any bus coordinate
function findBusNearestStopIndex(busLat, busLng, stops) {
  if (!stops || stops.length === 0) return 0;
  let closestIdx = 0;
  let minDirect = Infinity;
  stops.forEach((stop, idx) => {
    const d = getDistanceMeters(busLat, busLng, stop.lat, stop.lng);
    if (d < minDirect) {
      minDirect = d;
      closestIdx = idx;
    }
  });

  if (minDirect > GEOFENCE_RADIUS_METERS && closestIdx < stops.length - 1) {
    const dNext = getDistanceMeters(busLat, busLng, stops[closestIdx + 1].lat, stops[closestIdx + 1].lng);
    const interDist = getDistanceMeters(stops[closestIdx].lat, stops[closestIdx].lng, stops[closestIdx + 1].lat, stops[closestIdx + 1].lng);
    if (dNext < interDist) return closestIdx + 1;
  }
  return closestIdx;
}

// Calculate live road ETA to target stop index
function calculateEtaToStopIndex(busLat, busLng, busSpeedKmph, targetStopIdx, stops) {
  if (!stops || targetStopIdx < 0 || targetStopIdx >= stops.length) return "--";

  const busIdx = findBusNearestStopIndex(busLat, busLng, stops);
  if (busIdx > targetStopIdx) {
    return "Departed"; // Bus already passed this stop
  }

  const ROAD_CURVATURE = 1.25;
  const DWELL_SEC = 30;
  const effectiveSpeed = busSpeedKmph >= 12 ? (busSpeedKmph * 0.7 + 20 * 0.3) : 20.0;
  const speedMps = (effectiveSpeed * 1000) / 3600;

  if (busIdx === targetStopIdx) {
    const direct = getDistanceMeters(busLat, busLng, stops[targetStopIdx].lat, stops[targetStopIdx].lng);
    if (direct <= GEOFENCE_RADIUS_METERS) return "At Stop";
    return formatEtaTime((direct * ROAD_CURVATURE) / speedMps);
  }

  let accDist = getDistanceMeters(busLat, busLng, stops[busIdx].lat, stops[busIdx].lng) * ROAD_CURVATURE;
  let intermediateStops = 0;

  for (let i = busIdx + 1; i <= targetStopIdx; i++) {
    const prev = stops[i - 1];
    accDist += getDistanceMeters(prev.lat, prev.lng, stops[i].lat, stops[i].lng) * ROAD_CURVATURE;
    intermediateStops++;
  }

  const travelSec = (accDist / speedMps) + (intermediateStops * DWELL_SEC);
  return formatEtaTime(travelSec);
}

// Detect individual vehicle's road heading
function detectBusHeadingDirection(heading) {
  if (heading !== undefined && heading >= 0) {
    if (heading >= 15 && heading <= 135) return "UP";
    if (heading >= 195 && heading <= 315) return "DOWN";
  }
  return "UP";
}

// ==========================================
// 3. AUTOCOMPLETE & UNIQUE STOPS ENGINE
// ==========================================
function getAllUniqueStops() {
  const mapUnique = new Map();
  if (!window.ROUTES_DATABASE) return [];

  Object.values(window.ROUTES_DATABASE).forEach(r => {
    r.forwardStops.forEach(s => {
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
      normalizeStr(s.name).includes(qNorm) || normalizeStr(s.area).includes(qNorm)
    );
    render(matches);
  });

  input.addEventListener('focus', () => {
    const rawQ = input.value.trim();
    const qNorm = normalizeStr(rawQ);
    const allStops = getAllUniqueStops();
    const matches = qNorm
      ? allStops.filter(s => normalizeStr(s.name).includes(qNorm) || normalizeStr(s.area).includes(qNorm))
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

// ==========================================
// 4. DRAWER CONTROLS
// ==========================================
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
// 5. SEARCH & ROUTE MATCHING (DIRECTION LOCKED)
// ==========================================
function updateDirectionBannerText() {
  if (!window.ROUTES_DATABASE || !activeRouteKey) return;
  const routeConfig = window.ROUTES_DATABASE[activeRouteKey];
  if (!routeConfig) return;

  const terminals = routeConfig.subTitle.split("<->");
  const startTerm = terminals[0].trim();
  const endTerm = terminals[1].trim();

  const labelElem = document.getElementById("currentDirectionLabel");
  if (!labelElem) return;

  if (currentDirection === "UP") {
    labelElem.innerText = `${routeConfig.name} : ${startTerm} ➔ ${endTerm}`;
  } else {
    labelElem.innerText = `${routeConfig.name} : ${endTerm} ➔ ${startTerm}`;
  }
}

function findMatchingRoutes(pName, dName) {
  const matches = [];
  const pNorm = normalizeStr(pName);
  const dNorm = normalizeStr(dName);

  if (!window.ROUTES_DATABASE) return matches;

  for (const [rKey, rObj] of Object.entries(window.ROUTES_DATABASE)) {
    // Check Forward (UP)
    const pUp = rObj.forwardStops.findIndex(s => normalizeStr(s.name).includes(pNorm));
    const dUp = rObj.forwardStops.findIndex(s => normalizeStr(s.name).includes(dNorm));
    if (pUp !== -1 && dUp !== -1 && pUp < dUp) {
      matches.push({ routeKey: rKey, direction: "UP", stops: rObj.forwardStops });
      continue;
    }

    // Check Return (DOWN)
    const pDown = rObj.returnStops.findIndex(s => normalizeStr(s.name).includes(pNorm));
    const dDown = rObj.returnStops.findIndex(s => normalizeStr(s.name).includes(dNorm));
    if (pDown !== -1 && dDown !== -1 && pDown < dDown) {
      matches.push({ routeKey: rKey, direction: "DOWN", stops: rObj.returnStops });
    }
  }
  return matches;
}

function handleSearchClick() {
  const pickVal = document.getElementById("pickup-input").value.trim();
  const destVal = document.getElementById("dest-input").value.trim();

  if (!pickVal || !destVal) {
    alert("Please select both Pickup and Destination stops!");
    return;
  }

  const matchingRoutes = findMatchingRoutes(pickVal, destVal);
  if (matchingRoutes.length === 0) {
    alert("No direct route found between these stops in this travel direction.");
    return;
  }

  // 1. Lock searched route and travel direction
  const primary = matchingRoutes[0];
  activeRouteKey = primary.routeKey;
  currentDirection = primary.direction; // Properly sets UP or DOWN
  currentStopsList = primary.stops;

  const pNorm = normalizeStr(pickVal);
  const dNorm = normalizeStr(destVal);
  selectedPickupStop = currentStopsList.find(s => normalizeStr(s.name).includes(pNorm));
  selectedDestStop = currentStopsList.find(s => normalizeStr(s.name).includes(dNorm));

  // 2. Synchronize banner immediately
  updateDirectionBannerText();

  openBottomSheet();
  renderSchedulePreview();
  updateAvailableBusesList();
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
  document.getElementById("floatingBusCard").classList.remove("hidden");
  
  renderRoutePins();
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
  
  renderRoutePins();
  renderSchedulePreview();
  updateAvailableBusesList();
}

function renderSchedulePreview() {
  const tbody = document.getElementById("stopsTableBody");
  tbody.innerHTML = "";

  currentStopsList.forEach((stop, idx) => {
    let rowClass = "";
    if (selectedPickupStop && normalizeStr(stop.name) === normalizeStr(selectedPickupStop.name)) {
      rowClass = "bg-emerald-50 border-l-4 border-emerald-500 font-bold text-slate-900";
    } else if (selectedDestStop && normalizeStr(stop.name) === normalizeStr(selectedDestStop.name)) {
      rowClass = "bg-rose-50 border-l-4 border-rose-500 font-bold text-slate-900";
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

function renderRoutePins() {
  if (routePolylineLayer) map.removeLayer(routePolylineLayer);
  stopMarkersLayer.clearLayers();

  if (!isTrackingConfirmed) return;

  const pathPoints = currentStopsList.map(s => [s.lat, s.lng]);
  routePolylineLayer = L.polyline(pathPoints, { color: '#0284c7', weight: 5, opacity: 0.8 }).addTo(map);

  currentStopsList.forEach((stop, index) => {
    let type = "regular";
    let label = `<b>Stop #${index + 1}:</b> ${stop.name}`;

    if (selectedPickupStop && normalizeStr(stop.name) === normalizeStr(selectedPickupStop.name)) {
      type = "pickup";
      label = `🟢 <b>Your Boarding Stop:</b> ${stop.name}`;
    } else if (selectedDestStop && normalizeStr(stop.name) === normalizeStr(selectedDestStop.name)) {
      type = "dest";
      label = `🔴 <b>Your Deboarding Stop:</b> ${stop.name}`;
    } else if (index === busNearestStopIdx) {
      type = "bus_loc";
      label = `🟡 <b>Bus's Current Location:</b> ${stop.name}`;
    }

    L.marker([stop.lat, stop.lng], { icon: createPinIcon(type) }).bindPopup(label).addTo(stopMarkersLayer);
  });
}

// ==========================================
// 6. MULTI-BUS DRAWER CARDS (DIRECTION & DEPARTURE FILTERED)
// ==========================================
function updateAvailableBusesList() {
  const container = document.getElementById("busesListContainer");
  container.innerHTML = "";

  // 1. Get user pickup stop index along current route list
  let userPickupIdx = -1;
  if (selectedPickupStop) {
    userPickupIdx = currentStopsList.findIndex(
      s => normalizeStr(s.name) === normalizeStr(selectedPickupStop.name)
    );
  }

  // 2. Filter buses strictly:
  //    - Must match searched route (or first available route if browsing)
  //    - Must match searched direction
  //    - Must NOT have already passed the user's pickup stop!
  const qualifyingBuses = Object.entries(activeBuses).filter(([plate, bus]) => {
    const isSameRoute = !activeRouteKey || (normalizeStr(bus.route) === normalizeStr(activeRouteKey));
    const isSameDirection = !selectedPickupStop || (bus.busDir === currentDirection);

    if (!isSameRoute || !isSameDirection) return false;

    // Verify bus is BEHIND or AT the stop
    if (userPickupIdx !== -1) {
      const busCurrentIdx = findBusNearestStopIndex(bus.lat, bus.lng, currentStopsList);
      if (busCurrentIdx > userPickupIdx) {
        return false; // Bus already departed / passed the user's boarding point!
      }
    }

    return true;
  });

  if (qualifyingBuses.length === 0) {
    const dirText = currentDirection === "UP" ? "Forward (UP)" : "Return (DOWN)";
    let msg = `No active buses currently moving in the <b>${dirText}</b> direction on ${activeRouteKey || 'this route'}.`;
    if (userPickupIdx !== -1) {
      msg = `No upcoming buses for <b>${selectedPickupStop.name}</b> (any buses in this direction have already departed this stop).`;
    }

    container.innerHTML = `
      <div class="p-4 text-center text-slate-400 text-xs">
        ${msg}
      </div>
    `;
    return;
  }

  // Automatically select the first upcoming qualifying bus if none selected
  if (!selectedBusPlate || !qualifyingBuses.some(([plate]) => plate === selectedBusPlate)) {
    selectedBusPlate = qualifyingBuses[0][0];
  }

  for (const [plate, bus] of qualifyingBuses) {
    const isSelected = (plate === selectedBusPlate);
    const card = document.createElement("div");

    // Dynamic Live Pickup ETA calculation
    let etaLabel = bus.etaToPickupMin || "--";
    if (userPickupIdx !== -1) {
      etaLabel = calculateEtaToStopIndex(bus.lat, bus.lng, bus.spd, userPickupIdx, currentStopsList);
    }

    card.className = `p-3 rounded-2xl border-2 transition-all cursor-pointer flex items-center justify-between ${
      isSelected ? 'bg-sky-50/70 border-sky-500 shadow-sm' : 'bg-white border-slate-200 hover:border-slate-300'
    }`;
    card.onclick = () => selectBus(plate);

    card.innerHTML = `
      <div class="flex items-center gap-3">
        <div class="px-2.5 py-2 rounded-xl bg-sky-100/70 text-sky-700 font-extrabold text-xs flex items-center justify-center shrink-0 border border-sky-200/60 min-w-[50px] text-center">
          ${bus.route}
        </div>
        <div>
          <div class="text-xs font-bold text-sky-900 leading-tight">${bus.route} : <span class="text-slate-600 font-medium">${bus.subTitle}</span></div>
          <div class="text-[10px] text-slate-400 font-mono mt-0.5">${bus.plate} • <span class="text-emerald-600 font-bold">${bus.busDir}</span></div>
        </div>
      </div>
      <div class="text-right">
        <div class="text-[10px] text-emerald-600 font-bold uppercase tracking-wider">PICKUP ETA</div>
        <div class="text-xs font-extrabold text-slate-800 mt-0.5">${etaLabel}</div>
      </div>
    `;
    container.appendChild(card);
  }
}

function selectBus(plate) {
  selectedBusPlate = plate;
  updateAvailableBusesList();
  if (activeBuses[plate]) {
    map.panTo([activeBuses[plate].lat, activeBuses[plate].lng]);
  }
}

function updateStopsTable(busLat, busLng, currentSpeedKmph) {
  if (!isTrackingConfirmed) return;

  const tbody = document.getElementById("stopsTableBody");
  tbody.innerHTML = "";

  const ROAD_CURVATURE = 1.25;
  const DWELL_SEC = 30;
  const effectiveSpeed = currentSpeedKmph >= 12 ? (currentSpeedKmph * 0.7 + 20 * 0.3) : 20.0;
  const speedMps = (effectiveSpeed * 1000) / 3600;

  const nextTargetIdx = findBusNearestStopIndex(busLat, busLng, currentStopsList);
  busNearestStopIdx = nextTargetIdx;

  let accDist = 0;
  let intermediateStops = 0;

  currentStopsList.forEach((stop, idx) => {
    let rowClass = "";
    let badgeClass = "bg-sky-50 text-sky-700 border border-sky-200";
    let distLabel = "--";
    let etaLabel = "--";
    let remLabel = "--";

    if (selectedPickupStop && normalizeStr(stop.name) === normalizeStr(selectedPickupStop.name)) {
      rowClass = "bg-emerald-50 border-l-4 border-emerald-500 font-bold text-slate-900";
    } else if (selectedDestStop && normalizeStr(stop.name) === normalizeStr(selectedDestStop.name)) {
      rowClass = "bg-rose-50 border-l-4 border-rose-500 font-bold text-slate-900";
    } else if (idx === busNearestStopIdx) {
      rowClass = "bg-amber-50 border-l-4 border-amber-500 font-bold text-slate-900";
    } else if (idx < nextTargetIdx) {
      rowClass = "opacity-40";
      badgeClass = "bg-slate-100 text-slate-400";
      distLabel = "Passed";
      etaLabel = "Departed";
      remLabel = "0";
    }

    if (idx === nextTargetIdx) {
      const direct = getDistanceMeters(busLat, busLng, stop.lat, stop.lng);
      remLabel = "Approaching";
      if (direct <= GEOFENCE_RADIUS_METERS) {
        badgeClass = "bg-emerald-100 text-emerald-800 border border-emerald-300";
        distLabel = `${Math.round(direct)} m`;
        etaLabel = "At Stop";
      } else {
        accDist = direct * ROAD_CURVATURE;
        distLabel = accDist >= 1000 ? `${(accDist / 1000).toFixed(1)} km` : `${Math.round(accDist)} m`;
        etaLabel = formatEtaTime(accDist / speedMps);
      }
    } else if (idx > nextTargetIdx) {
      const prev = currentStopsList[idx - 1];
      accDist += getDistanceMeters(prev.lat, prev.lng, stop.lat, stop.lng) * ROAD_CURVATURE;
      intermediateStops++;

      const diff = idx - nextTargetIdx;
      remLabel = `${diff} stop${diff > 1 ? 's' : ''}`;

      const travelSec = (accDist / speedMps) + (intermediateStops * DWELL_SEC);
      distLabel = accDist >= 1000 ? `${(accDist / 1000).toFixed(1)} km` : `${Math.round(accDist)} m`;
      etaLabel = formatEtaTime(travelSec);

      if (selectedPickupStop && normalizeStr(stop.name) === normalizeStr(selectedPickupStop.name) && selectedBusPlate && activeBuses[selectedBusPlate]) {
        activeBuses[selectedBusPlate].etaToPickupMin = etaLabel;
      }
    }

    const tr = document.createElement("tr");
    if (rowClass) tr.className = rowClass;
    tr.innerHTML = `
      <td class="p-2.5 pl-4">${idx + 1}</td>
      <td class="p-2.5 font-semibold text-slate-800">${stop.name}</td>
      <td class="p-2.5 text-slate-600">${distLabel}</td>
      <td class="p-2.5 text-slate-600">${remLabel}</td>
      <td class="p-2.5 pr-4"><span class="px-2 py-0.5 rounded text-[11px] font-bold ${badgeClass}">${etaLabel}</span></td>
    `;
    tbody.appendChild(tr);
  });

  renderRoutePins();
  updateAvailableBusesList();
}

function recenterMap() {
  if (selectedBusPlate && activeBusMarkers[selectedBusPlate]) {
    map.flyTo(activeBusMarkers[selectedBusPlate].getLatLng(), 15, { animate: true, duration: 1 });
  }
}

// ==========================================
// 7. MQTT TELEMETRY (DECOUPLED FROM USER TRIP)
// ==========================================
updateAvailableBusesList();

const client = mqtt.connect('wss://broker.hivemq.com:8884/mqtt');

client.on('connect', () => {
  const badge = document.getElementById('connBadge');
  badge.className = "px-2.5 py-0.5 rounded-full font-bold bg-emerald-50 text-emerald-700 border border-emerald-200";
  badge.innerText = "Live Connected";
  client.subscribe("citytransit/+/+/data");
});

client.on('message', (topic, message) => {
  try {
    const d = JSON.parse(message.toString());
    const busPlate = d.bus_no || "UNKNOWN";
    const rawRouteName = d.route || "77A_NOBATA";

    // Direct key resolution with normalization fallback
    let resolvedRouteKey = Object.keys(window.ROUTES_DATABASE || {}).find(
      key => normalizeStr(key) === normalizeStr(rawRouteName)
    ) || Object.keys(window.ROUTES_DATABASE || {})[0];

    const routeConfig = window.ROUTES_DATABASE[resolvedRouteKey];

    // Auto-select route if app just opened and no search was performed
    if (!activeRouteKey && routeConfig) {
      activeRouteKey = resolvedRouteKey;
      currentStopsList = routeConfig.forwardStops;
      updateDirectionBannerText();
    }

    activeBuses[busPlate] = {
      plate: busPlate,
      route: routeConfig.name,
      subTitle: routeConfig.subTitle,
      lat: d.lat,
      lng: d.lng,
      spd: d.spd,
      heading: d.heading,
      busDir: detectBusHeadingDirection(d.heading),
      lastSeen: Date.now(),
      etaToPickupMin: activeBuses[busPlate]?.etaToPickupMin || "--"
    };

    if (!selectedBusPlate) {
      selectedBusPlate = busPlate;
    }

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

    if (busPlate === selectedBusPlate) {
      document.getElementById('floatBusPlate').innerText = busPlate;
      document.getElementById('floatTelemetry').innerText = `Speed: ${d.spd.toFixed(1)} km/h • ${routeConfig.name}`;
    }

    // Only update progress table if active tracking is confirmed for this bus
    if (isTrackingConfirmed && busPlate === selectedBusPlate) {
      updateStopsTable(d.lat, d.lng, d.spd);
    } else {
      updateAvailableBusesList();
    }
  } catch (e) {
    console.error("Payload error:", e);
  }
});

// Stale bus cleanup (removes inactive buses after 30s)
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
        selectedBusPlate = Object.keys(activeBuses)[0] || null;
      }
      updateAvailableBusesList();
    }
  }
}, 10000);

client.on('offline', () => {
  const badge = document.getElementById('connBadge');
  badge.className = "px-2.5 py-0.5 rounded-full font-bold bg-rose-50 text-rose-700 border border-rose-200";
  badge.innerText = "Reconnecting...";
});