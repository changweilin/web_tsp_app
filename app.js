// Elements
const btnCalculate = document.getElementById('btnCalculate');
const btnClear = document.getElementById('btnClear');
const statsPanel = document.getElementById('statsPanel');
const totalDistanceEl = document.getElementById('totalDistance');
const pointCountEl = document.getElementById('pointCount');
const loadingOverlay = document.getElementById('loading');
const toastEl = document.getElementById('toast');
const gpxInput = document.getElementById('gpxInput');
const btnLoadGpx = document.getElementById('btnLoadGpx');
const btnExportGpx = document.getElementById('btnExportGpx');
const btnLocation = document.getElementById('btnLocation');

// State
let points = []; // stores {lat, lon, marker, element?}
let optimizedRoute = []; // stores indices for primary export strategy (2-opt if avail, else first)
let isCalculating = false;
let origGpxDoc = null; // Store the original XML Document if loaded from GPX
let userLocationMarker = null;

// Map layers
let initialPolyline = null;
let strategyPolylines = {}; // Key: strat ID, Value: L.polyline
let pointGroup = L.layerGroup();

// Initialize Leaflet Map (Centered on Taiwan by default)
const map = L.map('map').setView([23.6978, 120.9605], 7);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap'
}).addTo(map);

pointGroup.addTo(map);

// Define custom icons
const dotIcon = L.divIcon({
    className: 'custom-div-icon',
    html: `<div style="background-color:#f43f5e; width:12px; height:12px; border-radius:50%; border:2px solid #fff; box-shadow: 0 0 8px rgba(244,63,94,0.6);"></div>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
    tooltipAnchor: [0, -10]
});

const getFlagHtml = (color, text) => `
    <div style="position: relative; width: 32px; height: 32px; display: flex; justify-content: center;">
        <svg viewBox="0 0 24 32" fill="${color}" stroke="#fff" stroke-width="2" style="filter: drop-shadow(0px 2px 4px rgba(0,0,0,0.6));">
            <path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 20 12 20s12-11 12-20c0-6.6-5.4-12-12-12zm0 16c-2.2 0-4-1.8-4-4s1.8-4 4-4 4 1.8 4 4-1.8 4-4 4z"/>
        </svg>
        <span style="position: absolute; top: 6px; color: white; font-size: 11px; font-weight: 800;">${text}</span>
    </div>
`;

const startIcon = L.divIcon({
    className: 'custom-flag-icon',
    html: getFlagHtml('#3b82f6', '起'),
    iconSize: [32, 32],
    iconAnchor: [16, 30],
    tooltipAnchor: [0, -32]
});

const endIcon = L.divIcon({
    className: 'custom-flag-icon',
    html: getFlagHtml('#ef4444', '終'),
    iconSize: [32, 32],
    iconAnchor: [16, 30],
    tooltipAnchor: [0, -32]
});

function updatePointMarkers(routeIndices) {
    if (points.length === 0) return;

    // Reset all to default dot
    points.forEach(p => p.marker.setIcon(dotIcon));

    if (routeIndices.length === 1) {
        points[routeIndices[0]].marker.setIcon(startIcon);
        return;
    }

    const startIdx = routeIndices[0];
    const endIdx = routeIndices[routeIndices.length - 1];

    points[startIdx].marker.setIcon(startIcon);
    points[endIdx].marker.setIcon(endIcon);
}

// Interaction handling
map.on('click', function (e) {
    if (isCalculating) return;
    addPoint(e.latlng.lat, e.latlng.lng);
});

function addPoint(lat, lon, element = null) {
    // Add visual marker
    const marker = L.marker([lat, lon], { icon: dotIcon })
        .bindTooltip((points.length + 1).toString(), {
            permanent: true,
            direction: 'top',
            className: 'custom-tooltip'
        });

    pointGroup.addLayer(marker);

    // Save state
    points.push({ lat, lon, marker, element });

    resetRouteState();
}

function resetRouteState() {
    optimizedRoute = [];
    updateStats();

    Object.values(strategyPolylines).forEach(poly => map.removeLayer(poly));
    strategyPolylines = {};

    const initIndices = points.map((_, i) => i);
    updatePointMarkers(initIndices);

    if (points.length >= 2) {
        drawInitialRoute();
    } else if (initialPolyline) {
        map.removeLayer(initialPolyline);
        initialPolyline = null;
    }

    // Enable calculate button if enough points
    if (points.length >= 3) {
        btnCalculate.disabled = false;
        btnCalculate.classList.remove('secondary');
        btnCalculate.classList.add('primary');
    } else {
        btnCalculate.disabled = true;
        btnCalculate.classList.remove('primary');
        btnCalculate.classList.add('secondary');
    }

    btnExportGpx.classList.add('hidden');
}

function updateStats() {
    pointCountEl.textContent = points.length;

    if (points.length > 0) {
        statsPanel.classList.remove('hidden');
    } else {
        statsPanel.classList.add('hidden');
    }
}

function showToast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');

    setTimeout(() => {
        toastEl.classList.remove('show');
    }, 2500);
}

// --- TSP Algorithm Logic ---

// Haversine Distance (in meters)
function getHaversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // metres
    const φ1 = lat1 * Math.PI / 180; // φ, λ in radians
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
        Math.cos(φ1) * Math.cos(φ2) *
        Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

// Distance wrapper
function getDistance(p1, p2) {
    return getHaversineDistance(p1.lat, p1.lon, p2.lat, p2.lon);
}

// Total route length
function tourLength(tour, closedLoop = true) {
    let len = 0;
    const endCount = closedLoop ? tour.length : tour.length - 1;
    for (let i = 0; i < endCount; i++) {
        len += getDistance(points[tour[i]], points[tour[(i + 1) % tour.length]]);
    }
    return len;
}

function drawInitialRoute() {
    const initRouteIndices = points.map((_, i) => i);

    const latlngs = initRouteIndices.map(idx => [points[idx].lat, points[idx].lon]);

    if (initialPolyline) {
        map.removeLayer(initialPolyline);
    }

    initialPolyline = L.polyline(latlngs, {
        color: '#f8fafc', // More prominent white/light slategray
        weight: 5,        // Thicker
        dashArray: '10, 8',
        opacity: 1        // Fully opaque
    }).addTo(map);

    // Temporarily update distance text for the initial route
    const dist = tourLength(initRouteIndices, false);
    updateDistanceDisplay(dist);
}

// --- TSP Algorithm Implementations ---

function runNearestNeighbor() {
    let unvisited = new Set(points.map((_, i) => i));
    let tour = [0];
    unvisited.delete(0);

    let current = 0;
    while (unvisited.size > 0) {
        let nearest = -1;
        let minDist = Infinity;
        for (let j of unvisited) {
            let d = getDistance(points[current], points[j]);
            if (d < minDist) {
                minDist = d;
                nearest = j;
            }
        }
        tour.push(nearest);
        unvisited.delete(nearest);
        current = nearest;
    }
    return tour;
}

function runGreedy() {
    let edges = [];
    const n = points.length;
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            edges.push({ i, j, d: getDistance(points[i], points[j]) });
        }
    }
    edges.sort((a, b) => a.d - b.d);

    let adj = Array.from({ length: n }, () => []);
    let edgeCount = 0;

    function createsCycle(u, v) {
        let visited = new Set();
        let stack = [u];
        while (stack.length > 0) {
            let curr = stack.pop();
            if (curr === v) return true;
            visited.add(curr);
            for (let neighbor of adj[curr]) {
                if (!visited.has(neighbor)) stack.push(neighbor);
            }
        }
        return false;
    }

    for (let e of edges) {
        if (adj[e.i].length < 2 && adj[e.j].length < 2) {
            if (edgeCount === n - 1 || !createsCycle(e.i, e.j)) {
                adj[e.i].push(e.j);
                adj[e.j].push(e.i);
                edgeCount++;
                if (edgeCount === n) break;
            }
        }
    }

    let tour = [0];
    let curr = 0;
    let prev = -1;
    while (tour.length < n) {
        let next = adj[curr][0] === prev ? adj[curr][1] : adj[curr][0];
        tour.push(next);
        prev = curr;
        curr = next;
    }
    return tour;
}

function runInsertion() {
    const n = points.length;
    let tour = [0, 1, 0];
    let unvisited = new Set();
    for (let i = 2; i < n; ++i) unvisited.add(i);

    while (unvisited.size > 0) {
        let bestK = -1;
        let bestEdgeIndex = -1;
        let minIncrease = Infinity;

        let k = unvisited.values().next().value;

        for (let idx = 0; idx < tour.length - 1; idx++) {
            let i = tour[idx];
            let j = tour[idx + 1];
            let increase = getDistance(points[i], points[k]) + getDistance(points[k], points[j]) - getDistance(points[i], points[j]);
            if (increase < minIncrease) {
                minIncrease = increase;
                bestK = k;
                bestEdgeIndex = idx;
            }
        }

        tour.splice(bestEdgeIndex + 1, 0, bestK);
        unvisited.delete(bestK);
    }
    tour.pop();
    return tour;
}

function run2Opt(initialTour) {
    let improved = true;
    let bestTour = [...initialTour];
    let bestLen = tourLength(bestTour, true);

    let iterations = 0;
    let maxIterations = points.length * 100;

    while (improved && iterations < maxIterations) {
        improved = false;
        iterations++;

        for (let i = 1; i < bestTour.length - 1; i++) {
            for (let j = i + 1; j < bestTour.length; j++) {
                if (j - i === 1) continue;

                let newTour = [
                    ...bestTour.slice(0, i),
                    ...bestTour.slice(i, j).reverse(),
                    ...bestTour.slice(j)
                ];

                let newLen = tourLength(newTour, true);
                if (newLen < bestLen - 0.00001) {
                    bestTour = newTour;
                    bestLen = newLen;
                    improved = true;
                }
            }
        }
    }

    const startIndex = bestTour.indexOf(0);
    if (startIndex !== -1 && startIndex !== 0) {
        bestTour = [...bestTour.slice(startIndex), ...bestTour.slice(0, startIndex)];
    }
    return bestTour;
}

// Async API
async function calculateTSP() {
    if (points.length < 3) return;

    // Check selected strategies
    const strat2Opt = document.getElementById('strat2Opt').checked;
    const stratNN = document.getElementById('stratNN').checked;
    const stratGreedy = document.getElementById('stratGreedy').checked;
    const stratInsertion = document.getElementById('stratInsertion').checked;

    if (!strat2Opt && !stratNN && !stratGreedy && !stratInsertion) {
        showToast("請至少選擇一種策略");
        return;
    }

    isCalculating = true;
    loadingOverlay.classList.remove('hidden');
    btnCalculate.disabled = true;

    setTimeout(() => {
        try {
            Object.values(strategyPolylines).forEach(poly => map.removeLayer(poly));
            strategyPolylines = {};

            const results = [];

            if (stratNN) {
                const tour = runNearestNeighbor();
                results.push({ id: 'nn', tour, len: tourLength(tour, true), color: '#fbbf24', name: '最近鄰居', weight: 4, dash: null, opacity: 0.8, offset: 0 });
            }
            if (stratGreedy) {
                const tour = runGreedy();
                results.push({ id: 'greedy', tour, len: tourLength(tour, true), color: '#34d399', name: '貪婪', weight: 4, dash: null, opacity: 0.8, offset: 0 });
            }
            if (stratInsertion) {
                const tour = runInsertion();
                results.push({ id: 'insertion', tour, len: tourLength(tour, true), color: '#c084fc', name: '插入法', weight: 4, dash: null, opacity: 0.8, offset: 0 });
            }
            if (strat2Opt) {
                const baseTour = stratNN ? results.find(r => r.id === 'nn').tour : points.map((_, i) => i);
                const tour = run2Opt(baseTour);
                results.push({ id: '2opt', tour, len: tourLength(tour, true), color: '#38bdf8', name: '2-Opt', weight: 6, dash: null, opacity: 1, offset: 0 });
            }

            let bestRouteOverall = null;
            let minLenOverall = Infinity;
            let statsHtml = '';

            results.forEach((res, index) => {
                if (res.len < minLenOverall) {
                    minLenOverall = res.len;
                    bestRouteOverall = res.tour;
                }

                const latlngs = res.tour.map(idx => [points[idx].lat, points[idx].lon]);
                latlngs.push([points[res.tour[0]].lat, points[res.tour[0]].lon]);

                const offsetLatLngs = latlngs.map(ll => [ll[0] + (index * 0.00005), ll[1] + (index * 0.00005)]);

                const poly = L.polyline(offsetLatLngs, {
                    color: res.color,
                    weight: res.weight,
                    dashArray: res.dash,
                    opacity: res.opacity,
                    lineJoin: 'round'
                }).addTo(map);

                poly.bindTooltip(`${res.name}: ${(res.len > 1000 ? (res.len / 1000).toFixed(2) + ' km' : res.len.toFixed(0) + ' m')}`, { sticky: true });
                strategyPolylines[res.id] = poly;

                const distStr = res.len > 1000 ? (res.len / 1000).toFixed(2) + ' km' : res.len.toFixed(0) + ' m';
                statsHtml += `<div style="font-size: 0.8rem; display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                <span style="color: ${res.color}">● ${res.name}</span>
                <span>${distStr}</span>
            </div>`;
            });

            optimizedRoute = bestRouteOverall;
            updatePointMarkers(bestRouteOverall);

            updateDistanceDisplay(minLenOverall);

            let extraStatsDiv = document.getElementById('extraStatsDetails');
            if (!extraStatsDiv) {
                extraStatsDiv = document.createElement('div');
                extraStatsDiv.id = 'extraStatsDetails';
                extraStatsDiv.style.marginTop = '5px';
                extraStatsDiv.style.borderTop = '1px solid rgba(255,255,255,0.1)';
                extraStatsDiv.style.paddingTop = '5px';
                statsPanel.appendChild(extraStatsDiv);
            }
            extraStatsDiv.innerHTML = statsHtml;

            if (initialPolyline) {
                initialPolyline.setStyle({ opacity: 0.2, weight: 2 });
            }

            btnExportGpx.classList.remove('hidden');
            btnExportGpx.disabled = false;

            loadingOverlay.classList.add('hidden');
            isCalculating = false;
            btnCalculate.disabled = false;

            showToast("計算完成！");
        } catch (e) {
            alert(e.message + "\n" + e.stack);
            console.error(e);
            loadingOverlay.classList.add('hidden');
            isCalculating = false;
            btnCalculate.disabled = false;
        }

    }, 50);
}

function updateDistanceDisplay(meters) {
    if (meters > 1000) {
        totalDistanceEl.textContent = (meters / 1000).toFixed(2) + " km";
    } else {
        totalDistanceEl.textContent = meters.toFixed(0) + " m";
    }
}


// --- GPX File Loading & Projection ---
btnLoadGpx.addEventListener('click', () => {
    gpxInput.click();
});

gpxInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (event) {
        const text = event.target.result;
        parseGPX(text);
        gpxInput.value = ''; // reset so same file can be loaded again if needed
    };
    reader.readAsText(file);
});

function parseGPX(xmlText) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, "text/xml");
    const err = xmlDoc.querySelector("parsererror");
    if (err) {
        alert("GPX 檔案解析失敗");
        return;
    }

    // Extract Waypoints (<wpt>) or Trackpoints (<trkpt>)
    let ptElements = Array.from(xmlDoc.querySelectorAll('wpt'));
    if (ptElements.length === 0) {
        ptElements = Array.from(xmlDoc.querySelectorAll('trkpt'));
    }

    if (ptElements.length === 0) {
        alert("找不到 GPX 座標點！");
        return;
    }

    // Clear everything
    clearAll();

    origGpxDoc = xmlDoc; // Save reference for exporting later

    let bounds = L.latLngBounds();

    ptElements.forEach(pt => {
        const lat = parseFloat(pt.getAttribute('lat'));
        const lon = parseFloat(pt.getAttribute('lon'));

        if (!isNaN(lat) && !isNaN(lon)) {
            const marker = L.marker([lat, lon], { icon: dotIcon })
                .bindTooltip((points.length + 1).toString(), {
                    permanent: true,
                    direction: 'top',
                    className: 'custom-tooltip'
                });

            pointGroup.addLayer(marker);
            points.push({ lat, lon, marker, element: pt });
            bounds.extend([lat, lon]);
        }
    });

    if (points.length < 3) {
        alert("GPX 檔案中的座標點過少 (需要至少 3 點)！");
        return;
    }

    // Zoom the map to fit the loaded points
    map.fitBounds(bounds, { padding: [50, 50] });

    resetRouteState();
    showToast(`成功載入 ${points.length} 個座標點`);
}

// --- GPX File Exporting ---
btnExportGpx.addEventListener('click', () => {
    if (optimizedRoute.length === 0) return;

    const newGpxStr = generateOptimizedGpxXML();

    const blob = new Blob([newGpxStr], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = 'optimized_route.gpx';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast("檔案已下載");
});

function generateOptimizedGpxXML() {
    let gpxStr = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    gpxStr += `<gpx version="1.1" creator="TSP Optimizer" xmlns="http://www.topografix.com/GPX/1/1">\n`;
    gpxStr += `  <trk>\n`;
    gpxStr += `    <name>Optimized TSP Route</name>\n`;
    gpxStr += `    <trkseg>\n`;

    // Add points in the calculated order
    for (let i = 0; i <= optimizedRoute.length; i++) {
        // Wrap around to the start to form a closed loop
        const pt = points[optimizedRoute[i % optimizedRoute.length]];
        gpxStr += `      <trkpt lat="${pt.lat}" lon="${pt.lon}">\n`;
        if (pt.element) {
            const ele = pt.element.querySelector('ele');
            if (ele) gpxStr += `        <ele>${ele.textContent}</ele>\n`;
        }
        gpxStr += `      </trkpt>\n`;
    }

    gpxStr += `    </trkseg>\n  </trk>\n</gpx>`;
    return gpxStr;
}

// Button bindings
btnCalculate.addEventListener('click', calculateTSP);

btnLocation.addEventListener('click', () => {
    map.locate({ setView: true, maxZoom: 16 });
});

map.on('locationfound', function (e) {
    if (!userLocationMarker) {
        const userLocIcon = L.divIcon({
            className: 'custom-user-loc',
            html: `<div style="background-color:#3b82f6; width:16px; height:16px; border-radius:50%; border:2px solid #fff; box-shadow: 0 0 10px rgba(59,130,246,0.8); animation: pulse 1.5s infinite;"></div>`,
            iconSize: [16, 16],
            iconAnchor: [8, 8]
        });
        userLocationMarker = L.marker(e.latlng, { icon: userLocIcon }).addTo(map);
    } else {
        userLocationMarker.setLatLng(e.latlng);
    }
});

map.on('locationerror', function (e) {
    showToast("無法取得您的位置");
});

btnClear.addEventListener('click', clearAll);

function clearAll() {
    points = [];
    optimizedRoute = [];
    origGpxDoc = null;

    pointGroup.clearLayers();
    if (initialPolyline) map.removeLayer(initialPolyline);

    Object.values(strategyPolylines).forEach(poly => map.removeLayer(poly));
    strategyPolylines = {};

    if (userLocationMarker) {
        map.removeLayer(userLocationMarker);
        userLocationMarker = null;
    }

    initialPolyline = null;

    totalDistanceEl.textContent = "0.00";
    let extraStatsDiv = document.getElementById('extraStatsDetails');
    if (extraStatsDiv) {
        extraStatsDiv.innerHTML = '';
    }
    btnCalculate.disabled = true;
    btnCalculate.classList.remove('primary');
    btnCalculate.classList.add('secondary');
    btnExportGpx.classList.add('hidden');
    updateStats();

    if (this === btnClear) {
        showToast("畫面已清除");
    }
}
