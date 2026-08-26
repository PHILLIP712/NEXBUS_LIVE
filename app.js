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
let currentStopsList = [];
let currentDirection = "UP";
let isTrackingConfirmed = false;
let selectedPickupStop = null;
let selectedDestStop = null;
let busNearestStopIdx = 0;

// Maximum stops a bus can be ahead of pickup before being hidden
const MAX_CATCH_STOPS_AHEAD = 3;

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
  } else if (type === "bus_loc") {
    color = "#f59e0b";
    size = 14;
    border = "2px solid #fff; box-shadow: 0 0 8px #f59e0b;";
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

// Precise Stop Matching
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

// Direction Tracker via Longitude Progression
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
// 4. ROUTE SEARCH ENGINE
// ==========================================
function updateDirectionBannerText() {
  if (!window.ROUTES_DATABASE || !activeRouteKey) return;
  const routeConfig = window.ROUTES_DATABASE[activeRouteKey];
  if (!routeConfig) return;

  const terminals = routeConfig.subTitle.split("<->");
  const startTerm = terminals[0] ? terminals[0].trim() : "";
  const endTerm = terminals[1] ? terminals[1].trim() : "";

  const labelElem = document.getElementById("currentDirectionLabel");
  if (!labelElem) return;

  if (currentDirection === "UP") {
    labelElem.innerHTML = `<span class="text-slate-900">${routeConfig.name}:</span> ${startTerm} <span class="text-emerald-600 font-bold">➔</span> ${endTerm}`;
  } else {
    labelElem.innerHTML = `<span class="text-slate-900">${routeConfig.name}:</span> ${endTerm} <span class="text-emerald-600 font-bold">➔</span> ${startTerm}`;
  }
}

function findMatchingRoutes(pName, dName) {
  const matches = [];
  const pNorm = normalizeStr(pName);
  const dNorm = normalizeStr(dName);

  if (!window.ROUTES_DATABASE) return matches;

  for (const [rKey, rObj] of Object.entries(window.ROUTES_DATABASE)) {
    const pUp = rObj.forwardStops.findIndex(s => normalizeStr(s.name).includes(pNorm));
    const dUp = rObj.forwardStops.findIndex(s => normalizeStr(s.name).includes(dNorm));
    if (pUp !== -1 && dUp !== -1 && pUp < dUp) {
      matches.push({ routeKey: rKey, direction: "UP", stops: rObj.forwardStops });
      continue;
    }

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
    alert("No direct bus route found between these stops in this direction.");
    return;
  }

  const primary = matchingRoutes[0];
  activeRouteKey = primary.routeKey;
  currentDirection = primary.direction;
  currentStopsList = primary.stops;

  const pNorm = normalizeStr(pickVal);
  const dNorm = normalizeStr(destVal);
  selectedPickupStop = currentStopsList.find(s => normalizeStr(s.name).includes(pNorm));
  selectedDestStop = currentStopsList.find(s => normalizeStr(s.name).includes(dNorm));

  updateDirectionBannerText();
  updateTripSummaryUI();

  openBottomSheet();
  renderSchedulePreview();
  updateAvailableBusesList();
}

// Dynamic Trip Summary (Recalculates from Live Catch Point)
function updateTripSummaryUI() {
  if (!selectedPickupStop || !selectedDestStop || !currentStopsList.length) return;

  const pIdx = currentStopsList.findIndex(s => normalizeStr(s.name) === normalizeStr(selectedPickupStop.name));
  const dIdx = currentStopsList.findIndex(s => normalizeStr(s.name) === normalizeStr(selectedDestStop.name));
  
  if (pIdx === -1 || dIdx === -1 || pIdx >= dIdx) return;

  // Latch start to live catch stop if original pickup was missed
  const activeStartIdx = (isTrackingConfirmed && busNearestStopIdx > pIdx && busNearestStopIdx < dIdx) 
    ? busNearestStopIdx 
    : pIdx;

  const summary = calculateTripSummary(currentStopsList[activeStartIdx], selectedDestStop, currentStopsList);
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

function renderSchedulePreview() {
  const tbody = document.getElementById("stopsTableBody");
  tbody.innerHTML = "";

  document.querySelector("#bottomSheet .overflow-y-auto")?.scrollTo({ top: 0 });

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
// 5. MAP POLYLINE (DYNAMIC ACTIVE TRIP FOCUS)
// ==========================================
function renderRoutePins(autoFit = false) {
  if (routePolylineLayer) map.removeLayer(routePolylineLayer);
  stopMarkersLayer.clearLayers();

  if (!isTrackingConfirmed || !selectedPickupStop || !selectedDestStop) return;

  const pIdx = currentStopsList.findIndex(s => normalizeStr(s.name) === normalizeStr(selectedPickupStop.name));
  const dIdx = currentStopsList.findIndex(s => normalizeStr(s.name) === normalizeStr(selectedDestStop.name));

  if (pIdx === -1 || dIdx === -1 || pIdx >= dIdx) return;

  // Shift polyline to start from live position if original pickup was missed
  const activeStartIdx = Math.max(pIdx, busNearestStopIdx);
  const displayStartIdx = Math.min(activeStartIdx, dIdx);

  const tripSegmentStops = currentStopsList.slice(pIdx, dIdx + 1);
  const activePathStops = currentStopsList.slice(displayStartIdx, dIdx + 1);
  const pathPoints = activePathStops.map(s => [s.lat, s.lng]);

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

    if (actualIdx === displayStartIdx) {
      type = "pickup";
      label = `🟢 <b>Boarding Stop:</b> ${stop.name}`;
    } else if (actualIdx === dIdx) {
      type = "dest";
      label = `🔴 <b>Deboarding Stop:</b> ${stop.name}`;
    } else if (actualIdx === busNearestStopIdx) {
      type = "bus_loc";
      label = `🟡 <b>Bus's Current Location:</b> ${stop.name}`;
    }

    L.marker([stop.lat, stop.lng], { icon: createPinIcon(type) })
      .bindPopup(label)
      .addTo(stopMarkersLayer);
  });
}

// ==========================================
// 6. MULTI-BUS DRAWER (EXPLICIT LOCATION NAMING)
// ==========================================
function updateAvailableBusesList() {
  const container = document.getElementById("busesListContainer");
  const floatingCard = document.getElementById("floatingBusCard");
  container.innerHTML = "";

  let userPickupIdx = -1;
  let userDestIdx = -1;

  if (selectedPickupStop && selectedDestStop) {
    userPickupIdx = currentStopsList.findIndex(s => normalizeStr(s.name) === normalizeStr(selectedPickupStop.name));
    userDestIdx = currentStopsList.findIndex(s => normalizeStr(s.name) === normalizeStr(selectedDestStop.name));
  }

  const routeBuses = Object.entries(activeBuses).filter(([plate, bus]) => {
    const isSameRoute = !activeRouteKey || (normalizeStr(bus.route) === normalizeStr(activeRouteKey));
    const isSameDir = (bus.busDir === currentDirection);
    return isSameRoute && isSameDir;
  });

  const viableBuses = [];

  routeBuses.forEach(([plate, bus]) => {
    const busCurrentIdx = findBusNearestStopIndex(bus.lat, bus.lng, currentStopsList);
    const busLocName = currentStopsList[busCurrentIdx]?.name || "En Route";

    // Hide if bus has passed destination
    if (userDestIdx !== -1 && busCurrentIdx >= userDestIdx) return;

    const hasPassedPickup = (userPickupIdx !== -1 && busCurrentIdx > userPickupIdx);
    const stopsAhead = busCurrentIdx - userPickupIdx;

    if (!hasPassedPickup) {
      // Standard Case: Approaching pickup stop
      const etaSec = userPickupIdx !== -1 ? calculateEtaSeconds(bus.lat, bus.lng, bus.spd, userPickupIdx, currentStopsList) : Infinity;

      let distMeters = getDistanceMeters(bus.lat, bus.lng, currentStopsList[busCurrentIdx].lat, currentStopsList[busCurrentIdx].lng) * 1.25;
      for (let k = busCurrentIdx + 1; k <= userPickupIdx; k++) {
        distMeters += getDistanceMeters(currentStopsList[k - 1].lat, currentStopsList[k - 1].lng, currentStopsList[k].lat, currentStopsList[k].lng) * 1.25;
      }

      viableBuses.push({
        plate,
        bus,
        isAlternativeCatch: false,
        currentLocationName: busLocName,
        targetStopName: selectedPickupStop ? selectedPickupStop.name : busLocName,
        etaSec,
        etaLabel: formatEtaTime(etaSec),
        distMeters,
        stopsAway: userPickupIdx - busCurrentIdx
      });
    } else if (stopsAhead <= MAX_CATCH_STOPS_AHEAD) {
      // Catch Mode: Offer upcoming stop the bus is currently approaching (busCurrentIdx)
      const catchStopIdx = busCurrentIdx;
      if (catchStopIdx < userDestIdx && catchStopIdx < currentStopsList.length) {
        const catchStop = currentStopsList[catchStopIdx];
        const catchEtaSec = calculateEtaSeconds(bus.lat, bus.lng, bus.spd, catchStopIdx, currentStopsList);
        const distToCatch = getDistanceMeters(bus.lat, bus.lng, catchStop.lat, catchStop.lng) * 1.25;

        viableBuses.push({
          plate,
          bus,
          isAlternativeCatch: true,
          currentLocationName: busLocName,
          targetStopName: catchStop.name,
          etaSec: catchEtaSec,
          etaLabel: formatEtaTime(catchEtaSec),
          distMeters: distToCatch,
          stopsAway: 0
        });
      }
    }
  });

  if (viableBuses.length === 0) {
    const dirText = currentDirection === "UP" ? "Forward (UP)" : "Return (DOWN)";
    container.innerHTML = `
      <div class="p-4 text-center text-slate-400 text-xs">
        No active buses currently operating in the <b>${dirText}</b> direction.
      </div>
    `;
    floatingCard.classList.add("hidden");
    return;
  }

  viableBuses.sort((a, b) => a.etaSec - b.etaSec);

  const bestUpcoming = viableBuses[0];
  selectedBusPlate = bestUpcoming.plate;

  if (isTrackingConfirmed) {
    floatingCard.classList.remove("hidden");
    document.getElementById('floatBusPlate').innerText = bestUpcoming.plate;
    document.getElementById('floatTelemetry').innerText = `Near: ${bestUpcoming.currentLocationName} • Speed: ${bestUpcoming.bus.spd.toFixed(1)} km/h`;
  }

  viableBuses.forEach((item, rank) => {
    const isSelected = (item.plate === selectedBusPlate);
    const card = document.createElement("div");

    const distStr = item.distMeters >= 1000 
      ? `${(item.distMeters / 1000).toFixed(1)} km away` 
      : `${Math.round(item.distMeters)} m away`;

    let badgeHtml = "";
    let cardStyle = isSelected ? 'bg-sky-50/80 border-sky-500 shadow-sm' : 'bg-white border-slate-200 hover:border-slate-300';

    if (item.isAlternativeCatch) {
      badgeHtml = `
        <div class="text-[10px] text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded font-bold uppercase tracking-wider">
          CATCH @ ${item.targetStopName}
        </div>
        <div class="text-xs font-extrabold text-slate-800 mt-0.5">${item.etaLabel}</div>
        <div class="text-[10px] font-bold text-amber-600 mt-0.5">${distStr}</div>
      `;
    } else {
      const isBest = (rank === 0);
      const stopCountdownText = item.stopsAway === 0 
        ? 'Approaching now' 
        : `${item.stopsAway} stop${item.stopsAway > 1 ? 's' : ''} to pickup`;

      badgeHtml = `
        <div class="text-[10px] ${isBest ? 'text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded' : 'text-emerald-600'} font-bold uppercase tracking-wider">
          ${isBest ? '★ BEST BUS (ETA)' : 'PICKUP ETA'}
        </div>
        <div class="text-xs font-extrabold text-slate-800 mt-0.5">${item.etaLabel}</div>
        <div class="text-[10px] font-bold text-sky-600 mt-0.5">${distStr} • ${stopCountdownText}</div>
      `;
    }

    card.className = `p-3 rounded-2xl border-2 transition-all flex items-center justify-between cursor-pointer ${cardStyle}`;
    card.onclick = () => selectBus(item.plate);

    card.innerHTML = `
      <div class="flex items-center gap-3">
        <div class="px-2.5 py-2 rounded-xl bg-sky-100/70 text-sky-700 font-extrabold text-xs flex items-center justify-center shrink-0 border border-sky-200/60 min-w-[50px] text-center">
          ${item.bus.route}
        </div>
        <div>
          <div class="text-xs font-bold text-sky-900 leading-tight">${item.bus.route} : <span class="text-slate-600 font-medium">${item.bus.subTitle}</span></div>
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
  }
}

// ==========================================
// 7. STOP TIMELINE TABLE (CLEAR TRANSIT LABELS)
// ==========================================
function updateStopsTable(busLat, busLng, currentSpeedKmph) {
  if (!isTrackingConfirmed || !selectedPickupStop || !selectedDestStop) return;

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

  // Identify first valid upcoming stop on journey
  const liveCatchActualIdx = Math.max(pIdx, busAbsoluteIdx);

  journeyStops.forEach((stop, relIdx) => {
    const actualStopIdx = pIdx + relIdx;
    let rowClass = "";
    let badgeClass = "bg-sky-50 text-sky-700 border border-sky-200";
    let distLabel = "--";
    let etaLabel = "--";
    let remLabel = "--";

    // Distance Accumulation Logic: Starts at 0.0 at the active boarding/catch stop
    if (actualStopIdx < liveCatchActualIdx) {
      distLabel = "--"; // Departed stops show clean dashes
    } else if (actualStopIdx === liveCatchActualIdx) {
      accRideDist = 0;
      distLabel = (actualStopIdx === pIdx) ? "0.0 km (Pickup)" : "0.0 km (Catch)";
    } else {
      const prev = currentStopsList[actualStopIdx - 1];
      accRideDist += getDistanceMeters(prev.lat, prev.lng, stop.lat, stop.lng) * ROAD_CURVATURE;
      distLabel = `${(accRideDist / 1000).toFixed(1)} km`;
    }

    if (busAbsoluteIdx > actualStopIdx) {
      // 1. Departed Stops
      etaLabel = "Departed";
      badgeClass = "bg-slate-100 text-slate-400";
      remLabel = "Missed";
      rowClass = "opacity-40";
    } else if (actualStopIdx === liveCatchActualIdx) {
      // 2. Active Boarding Stop
      rowClass = "bg-emerald-50/80 border-l-4 border-emerald-500 font-bold text-slate-900";
      const stopEtaSec = calculateEtaSeconds(busLat, busLng, currentSpeedKmph, actualStopIdx, currentStopsList);
      etaLabel = formatEtaTime(stopEtaSec);
      
      const stopsToPickup = actualStopIdx - busAbsoluteIdx;
      if (stopsToPickup === 0) {
        remLabel = "Approaching Now";
      } else {
        remLabel = `${stopsToPickup} stop${stopsToPickup > 1 ? 's' : ''} to arrival`;
      }
    } else if (relIdx === journeyStops.length - 1) {
      // 3. Final Destination Stop
      rowClass = "bg-rose-50/80 border-l-4 border-rose-500 font-bold text-slate-900";
      const stopEtaSec = calculateEtaSeconds(busLat, busLng, currentSpeedKmph, actualStopIdx, currentStopsList);
      etaLabel = formatEtaTime(stopEtaSec);
      remLabel = "🏁 Final Stop";
    } else {
      // 4. In-Ride Intermediate Stops
      const stopEtaSec = calculateEtaSeconds(busLat, busLng, currentSpeedKmph, actualStopIdx, currentStopsList);
      etaLabel = formatEtaTime(stopEtaSec);
      const rideStopsCount = actualStopIdx - liveCatchActualIdx;
      remLabel = `+${rideStopsCount} stop${rideStopsCount > 1 ? 's' : ''} ride`;
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
      route: routeConfig.name,
      subTitle: routeConfig.subTitle,
      lat: d.lat,
      lng: d.lng,
      spd: d.spd,
      heading: d.heading,
      busDir: detectedDir,
      lastSeen: Date.now()
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

    if (isTrackingConfirmed && busPlate === selectedBusPlate) {
      updateStopsTable(d.lat, d.lng, d.spd);
    } else {
      updateAvailableBusesList();
    }
  } catch (e) {
    console.error("Telemetry Payload error:", e);
  }
});

// Stale bus cleanup (removes buses offline > 30s)
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
  badge.className = "px-2.5 py-1 rounded-full font-bold bg-rose-50 text-rose-700 border border-rose-200 shadow-sm flex items-center gap-1";
  badge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse"></span><span>Reconnecting...</span>`;
});