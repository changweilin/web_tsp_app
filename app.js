window.onerror = function (message, source, lineno, colno, error) {
    alert("執行時發生未預期錯誤，請截圖給開發者:\n" + message + "\nLine: " + lineno + "\nSource: " + source);
    return false;
};

// Elements
const btnCalculate = document.getElementById('btnCalculate');
const btnClear = document.getElementById('btnClear');
const statsPanel = document.getElementById('statsPanel');
const totalDistanceEl = document.getElementById('totalDistance');
const pointCountEl = document.getElementById('pointCount');
const loadingOverlay = document.getElementById('loading');
const loadingTextEl = document.getElementById('loadingText');
const progressBar = document.getElementById('progressBar');
const toastEl = document.getElementById('toast');
const gpxInput = document.getElementById('gpxInput');
const btnLoadGpx = document.getElementById('btnLoadGpx');
const btnLocation = document.getElementById('btnLocation');

// State
let points = []; // stores {lat, lon, marker, element?}
let optimizedRoute = []; // stores indices for primary export strategy (2-opt if avail, else first)
let isCalculating = false;
let origGpxDoc = null; // Store the original XML Document if loaded from GPX
let userLocationMarker = null;
let currentCalculatedRoutes = []; // Stores all generated strategy results
let origFileName = "route"; // Default filename base

// Map layers
let initialPolyline = null;
let strategyPolylines = {}; // Key: strat ID, Value: L.polyline
let pointGroup = L.layerGroup();

// Initialize Leaflet Map (Centered on Taiwan by default)
const map = L.map('map', { doubleClickZoom: false }).setView([23.6978, 120.9605], 7);

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

    // Reset all to default dot and update tooltip to reflect the new route sequence
    points.forEach((p, i) => {
        p.marker.setIcon(dotIcon);
        const sequenceRank = routeIndices.indexOf(i);
        if (sequenceRank > -1) {
            p.marker.setTooltipContent((sequenceRank + 1).toString());
        } else {
            p.marker.setTooltipContent("-");
        }
    });

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
let mapClickTimeout = null;

map.on('click', function (e) {
    if (isCalculating) return;

    // Debounce the map click to allow double-clicks to register as double-clicks without firing single clicks first.
    if (mapClickTimeout) clearTimeout(mapClickTimeout);

    mapClickTimeout = setTimeout(() => {
        addPoint(e.latlng.lat, e.latlng.lng);
        mapClickTimeout = null;
    }, 250); // wait 250ms to see if a second click creates a dblclick
});

map.on('dblclick', function (e) {
    // If the user double clicked the map explicitly (not a marker), we just clear the timeout so it doesn't add a point.
    if (mapClickTimeout) {
        clearTimeout(mapClickTimeout);
        mapClickTimeout = null;
    }
});

function bindMarkerEvents(marker, pointObj) {
    marker.on('dragend', function (event) {
        if (isCalculating) return;
        const position = marker.getLatLng();
        pointObj.lat = position.lat;
        pointObj.lon = position.lng;
        // Optimization routes are invalidated on drag
        resetRouteState();
    });

    // Native right click to open the custom action popup context menu
    marker.on('contextmenu', (e) => {
        if (isCalculating) return;
        L.DomEvent.stopPropagation(e);
        marker.openPopup();
    });

    const popupContent = document.createElement('div');
    popupContent.className = 'custom-marker-popup';
    popupContent.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 6px; padding: 4px;">
            <button class="popup-btn delete-btn" style="padding: 6px; text-align: left; background: #fee2e2; color: #dc2626; border: 1px solid #fecaca; border-radius: 4px; cursor: pointer;">🗑️ 刪除座標點</button>
            <button class="popup-btn insert-prev-btn" style="padding: 6px; text-align: left; background: #e0f2fe; color: #0284c7; border: 1px solid #bae6fd; border-radius: 4px; cursor: pointer;">➕ 新增上一點</button>
            <button class="popup-btn insert-next-btn" style="padding: 6px; text-align: left; background: #e0f2fe; color: #0284c7; border: 1px solid #bae6fd; border-radius: 4px; cursor: pointer;">➕ 新增下一點</button>
        </div>
    `;

    popupContent.querySelector('.delete-btn').addEventListener('click', () => {
        if (isCalculating) return;
        removePoint(pointObj);
        map.closePopup();
    });

    popupContent.querySelector('.insert-prev-btn').addEventListener('click', () => {
        if (isCalculating) return;
        insertInterpolatedPoint(pointObj, -1);
        map.closePopup();
    });

    popupContent.querySelector('.insert-next-btn').addEventListener('click', () => {
        if (isCalculating) return;
        insertInterpolatedPoint(pointObj, 1);
        map.closePopup();
    });

    marker.bindPopup(popupContent, { minWidth: 140, closeButton: false });
}

function insertInterpolatedPoint(targetPointObj, offsetDirection) {
    if (points.length < 2) {
        showToast("點數不足，無法內插");
        return;
    }
    const idx = points.indexOf(targetPointObj);
    if (idx === -1) return;

    // Calculate neighbor index considering array wrapping
    let neighborIdx;
    if (offsetDirection === -1) {
        neighborIdx = (idx - 1 + points.length) % points.length;
    } else {
        neighborIdx = (idx + 1) % points.length;
    }

    const neighbor = points[neighborIdx];
    const newLat = (targetPointObj.lat + neighbor.lat) / 2;
    const newLon = (targetPointObj.lon + neighbor.lon) / 2;

    const insertIndex = offsetDirection === -1 ? idx : idx + 1;
    addPoint(newLat, newLon, null, insertIndex);
}

function addPoint(lat, lon, element = null, insertIndex = -1, bulkLoad = false) {
    // Add visual marker
    const marker = L.marker([lat, lon], {
        icon: dotIcon,
        draggable: true // Make marker draggable
    }).bindTooltip("", {
        permanent: true,
        direction: 'top',
        className: 'custom-tooltip'
    });

    pointGroup.addLayer(marker);

    const pointObj = { lat, lon, marker, element, ele: 0 };

    if (insertIndex !== -1) {
        points.splice(insertIndex, 0, pointObj);
    } else {
        points.push(pointObj);
    }

    // Event listeners via Popup Context Menu
    bindMarkerEvents(marker, pointObj);

    if (!bulkLoad) {
        // Sync baseline numbers
        const baselineIndices = points.map((_, i) => i);
        updatePointMarkers(baselineIndices);

        resetRouteState();
    }
}

function removePoint(pointObj) {
    const index = points.indexOf(pointObj);
    if (index > -1) {
        // Remove from map
        pointGroup.removeLayer(pointObj.marker);
        // Remove from array
        points.splice(index, 1);

        resetRouteState();
    }
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

    const elevationPanel = document.getElementById('elevationPanel');
    if (elevationPanel) elevationPanel.classList.add('hidden');

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

    document.getElementById('btnExportMenu').disabled = true;

    if (typeof saveState === 'function') saveState();
}

function saveState() {
    if (isCalculating) return;

    // Save configuration checkboxes
    const configStrats = {
        stratNN: document.getElementById('stratNN')?.checked,
        stratGreedy: document.getElementById('stratGreedy')?.checked,
        stratInsertion: document.getElementById('stratInsertion')?.checked,
        optNone: document.getElementById('optNone')?.checked,
        opt2Opt: document.getElementById('opt2Opt')?.checked,
        optLK: document.getElementById('optLK')?.checked,
        optSA: document.getElementById('optSA')?.checked,
        optGA: document.getElementById('optGA')?.checked,
        stratInitial: document.getElementById('stratInitial')?.checked
    };

    // Extract pure coordinates from points
    const pts = points.map(p => ({ lat: p.lat, lon: p.lon }));

    localStorage.setItem('tsp_config', JSON.stringify(configStrats));
    localStorage.setItem('tsp_points', JSON.stringify(pts));
    localStorage.setItem('tsp_filename', origFileName);
}

function updateStats() {
    pointCountEl.textContent = points.length;

    if (points.length > 0) {
        const wasHidden = statsPanel.classList.contains('hidden');
        statsPanel.classList.remove('hidden');
        if (wasHidden && window.innerWidth <= 768) statsPanel.classList.add('collapsed');
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

function runLinKernighan(baseTour) {
    // Simplified L-K heuristic (Iterated Local Search via Double-Bridge kick + 2-opt)
    // Achieves comparable results to L-K for these sizes while being fast enough for JS.
    let n = points.length;
    if (n < 4) return run2Opt(points.map((_, i) => i));

    let bestTour = run2Opt([...baseTour]);
    let bestLen = tourLength(bestTour, true);
    let currentTour = [...bestTour];

    const maxIterations = 50;

    for (let i = 0; i < maxIterations; i++) {
        // Double bridge perturbation (4-opt kick)
        if (n >= 8) {
            let p1 = 1 + Math.floor(Math.random() * (n / 4));
            let p2 = p1 + 1 + Math.floor(Math.random() * (n / 4));
            let p3 = p2 + 1 + Math.floor(Math.random() * (n / 4));

            let A = currentTour.slice(0, p1);
            let B = currentTour.slice(p1, p2);
            let C = currentTour.slice(p2, p3);
            let D = currentTour.slice(p3);

            currentTour = [...A, ...D, ...C, ...B];
        } else {
            // For small n, simple swap
            let idx1 = 1 + Math.floor(Math.random() * (n - 2));
            let idx2 = 1 + Math.floor(Math.random() * (n - 2));
            [currentTour[idx1], currentTour[idx2]] = [currentTour[idx2], currentTour[idx1]];
        }

        currentTour = run2Opt(currentTour);
        let currentLen = tourLength(currentTour, true);

        if (currentLen < bestLen - 0.00001) {
            bestTour = [...currentTour];
            bestLen = currentLen;
        } else {
            // Revert back to best if no improvement locally
            currentTour = [...bestTour];
        }
    }
    return bestTour;
}

function runSimulatedAnnealing(baseTour) {
    let n = points.length;
    if (n < 4) return run2Opt(points.map((_, i) => i));

    let currentTour = [...baseTour];
    let currentLen = tourLength(currentTour, true);

    let bestTour = [...currentTour];
    let bestLen = currentLen;

    let temp = 10000;
    const coolingRate = 0.995;
    const minTemp = 0.001;
    const iterationsPerTemp = Math.min(n * 2, 100);

    while (temp > minTemp) {
        for (let i = 0; i < iterationsPerTemp; i++) {
            let idx1 = 1 + Math.floor(Math.random() * (n - 2));
            let idx2 = 1 + Math.floor(Math.random() * (n - 2));
            if (idx1 === idx2) continue;
            if (idx1 > idx2) [idx1, idx2] = [idx2, idx1];

            let newTour = [
                ...currentTour.slice(0, idx1),
                ...currentTour.slice(idx1, idx2).reverse(),
                ...currentTour.slice(idx2)
            ];

            let newLen = tourLength(newTour, true);
            let delta = newLen - currentLen;

            if (delta < 0 || Math.random() < Math.exp(-delta / temp)) {
                currentTour = newTour;
                currentLen = newLen;

                if (currentLen < bestLen) {
                    bestTour = [...currentTour];
                    bestLen = currentLen;
                }
            }
        }
        temp *= coolingRate;
    }

    return bestTour;
}

function runGeneticAlgorithm(baseTour) {
    let n = points.length;
    if (n < 4) return run2Opt(points.map((_, i) => i));

    const popSize = Math.max(50, n * 2);
    const generations = 200;
    const mutationRate = 0.1;

    let population = [];
    population.push([...baseTour]);

    for (let i = 1; i < popSize; i++) {
        let tour = [...baseTour];
        for (let k = 0; k < n; k++) {
            let i1 = 1 + Math.floor(Math.random() * (n - 2));
            let i2 = 1 + Math.floor(Math.random() * (n - 2));
            [tour[i1], tour[i2]] = [tour[i2], tour[i1]];
        }
        population.push(tour);
    }

    let bestOverallTour = [...baseTour];
    let bestOverallLen = tourLength(baseTour, true);

    for (let gen = 0; gen < generations; gen++) {
        let scored = population.map(t => ({ tour: t, len: tourLength(t, true) }));
        scored.sort((a, b) => a.len - b.len);

        if (scored[0].len < bestOverallLen) {
            bestOverallLen = scored[0].len;
            bestOverallTour = [...scored[0].tour];
        }

        let nextPop = [];
        nextPop.push(scored[0].tour);
        nextPop.push(scored[1].tour);

        while (nextPop.length < popSize) {
            let parent1 = scored[Math.floor(Math.pow(Math.random(), 3) * popSize)].tour;
            let parent2 = scored[Math.floor(Math.pow(Math.random(), 3) * popSize)].tour;

            let start = 1 + Math.floor(Math.random() * (n - 2));
            let end = 1 + Math.floor(Math.random() * (n - 2));
            if (start > end) [start, end] = [end, start];

            let child = new Array(n).fill(-1);
            child[0] = parent1[0];
            child[n - 1] = parent1[n - 1];

            for (let i = start; i < end; i++) {
                child[i] = parent1[i];
            }

            let p2Idx = 1;
            for (let i = 1; i < n - 1; i++) {
                if (child[i] === -1) {
                    while (child.includes(parent2[p2Idx])) {
                        p2Idx++;
                    }
                    child[i] = parent2[p2Idx];
                }
            }

            if (Math.random() < mutationRate) {
                let m1 = 1 + Math.floor(Math.random() * (n - 2));
                let m2 = 1 + Math.floor(Math.random() * (n - 2));
                [child[m1], child[m2]] = [child[m2], child[m1]];
            }

            nextPop.push(child);
        }
        population = nextPop;
    }

    return bestOverallTour;
}

// We store the rendered lines and tours globally to allow individual replay and interaction
window.routeAnimators = {};
window.calculatedTours = {};

function formatTime(ms) {
    if (ms < 1000) return ms.toFixed(0) + "ms";
    return (ms / 1000).toFixed(1) + "s";
}

function renderResults(results) {
    Object.values(strategyPolylines).forEach(poly => map.removeLayer(poly));
    strategyPolylines = {};

    let bestRouteOverall = null;
    let minLenOverall = Infinity;
    let statsHtml = '';

    currentCalculatedRoutes = results;

    results.forEach((res, index) => {
        if (res.len < minLenOverall) {
            minLenOverall = res.len;
            bestRouteOverall = res.tour;
        }

        const latlngs = res.tour.map(idx => [points[idx].lat, points[idx].lon]);
        latlngs.push([points[res.tour[0]].lat, points[res.tour[0]].lon]);

        const offsetLatLngs = latlngs.map(ll => [ll[0] + (index * 0.00005), ll[1] + (index * 0.00005)]);

        const poly = L.polyline([], {
            color: res.color,
            weight: res.weight,
            dashArray: res.dash,
            opacity: res.opacity,
            lineJoin: 'round'
        }).addTo(map);

        strategyPolylines[res.id] = poly;

        // Smooth distance-based continuous interpolation animation
        const segments = [];
        let totalPathDist = 0;
        for (let i = 0; i < offsetLatLngs.length - 1; i++) {
            const p1 = L.latLng(offsetLatLngs[i]);
            const p2 = L.latLng(offsetLatLngs[i + 1]);
            const dist = p1.distanceTo(p2);
            segments.push({ p1, p2, dist, accumStart: totalPathDist });
            totalPathDist += dist;
        }

        // Velocity = constant for all routes so longer routes take longer.
        // Base is ~2000px/s equivalent map distance. Let's make the shortest route take 3 seconds minimum for SLOW MOTION.
        const speed = Math.max(minLenOverall, 1000) / 3000; // meters per millisecond
        const durationMs = totalPathDist / speed;

        window.routeAnimators[res.id] = function playAnimation() {
            poly.setLatLngs([]); // Reset
            let startTime = null;

            function animatePolyline(timestamp) {
                if (!startTime) startTime = timestamp;
                const elapsed = timestamp - startTime;
                const currentDist = elapsed * speed;

                if (currentDist >= totalPathDist) {
                    poly.setLatLngs(offsetLatLngs);
                    poly.bindTooltip(`${res.name}: ${(res.len > 1000 ? (res.len / 1000).toFixed(2) + ' km' : res.len.toFixed(0) + ' m')}`, { sticky: true });
                    return;
                }

                const currentPts = [];
                for (let seg of segments) {
                    if (currentDist >= seg.accumStart + seg.dist) {
                        currentPts.push(seg.p1);
                    } else if (currentDist > seg.accumStart) {
                        currentPts.push(seg.p1);
                        const ratio = (currentDist - seg.accumStart) / seg.dist;
                        const interpLat = seg.p1.lat + (seg.p2.lat - seg.p1.lat) * ratio;
                        const interpLng = seg.p1.lng + (seg.p2.lng - seg.p1.lng) * ratio;
                        currentPts.push(L.latLng(interpLat, interpLng));
                        break;
                    }
                }
                poly.setLatLngs(currentPts);
                requestAnimationFrame(animatePolyline);
            }
            requestAnimationFrame(animatePolyline);
        };

        // Start playing immediately
        window.routeAnimators[res.id]();

        window.calculatedTours[res.id] = res.tour;

        const distStr = res.len > 1000 ? (res.len / 1000).toFixed(2) + ' km' : res.len.toFixed(0) + ' m';
        statsHtml += `<div style="font-size: 0.85rem; display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px;">
        <span class="route-name-btn" data-id="${res.id}" style="color: ${res.color}; flex: 1; cursor: pointer; padding: 2px 4px; border-radius: 4px; transition: background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.1)'" onmouseout="this.style.background='transparent'" title="點擊以依照此路線順序重新編號地圖座標">● ${res.name} <span style="font-size: 0.7rem; color: #64748b;">(${formatTime(durationMs)})</span></span>
        <span style="font-weight: 600;">${distStr}</span>
        <button class="replay-btn" data-id="${res.id}" style="background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; padding: 2px 6px; cursor: pointer; color: white; display: flex; align-items: center; justify-content: center;" title="重播路線動畫">▶️重播</button>
    </div>`;
    });

    optimizedRoute = bestRouteOverall;
    updatePointMarkers(bestRouteOverall);

    updateDistanceDisplay(minLenOverall);
    drawElevationProfile(bestRouteOverall);

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

    // Bind replay buttons
    extraStatsDiv.querySelectorAll('.replay-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = e.currentTarget.getAttribute('data-id');
            if (window.routeAnimators[id]) window.routeAnimators[id]();
        });
    });

    extraStatsDiv.querySelectorAll('.route-name-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = e.currentTarget.getAttribute('data-id');
            const tour = window.calculatedTours[id];
            if (tour) {
                optimizedRoute = tour;
                updatePointMarkers(tour);
                showToast("已更新座標點編號順序");
            }
        });
    });

    if (initialPolyline) {
        initialPolyline.setStyle({ opacity: 0.2, weight: 2 });
    }

    document.getElementById('btnExportMenu').disabled = false;

    loadingOverlay.classList.add('hidden');
    isCalculating = false;
    btnCalculate.disabled = false;

    showToast("計算完成！");
}

async function calculateTSPFallback(config) {
    if (progressBar) progressBar.style.width = '0%';

    let baseStratsCount = 0;
    if (config.stratNN) baseStratsCount++;
    if (config.stratGreedy) baseStratsCount++;
    if (config.stratInsertion) baseStratsCount++;

    let optCount = 0;
    if (config.opt2Opt) optCount++;
    if (config.optLK) optCount++;
    if (config.optSA) optCount++;
    if (config.optGA) optCount++;

    const totalStepsGlobal = (config.stratInitial ? 1 : 0) + baseStratsCount + (baseStratsCount * optCount);
    let currentStepGlobal = 0;

    const updateProgress = async (msg, subPercent = 0) => {
        const safeSub = Math.max(0, Math.min(1, subPercent));
        const totalP = Math.min(100, Math.max(0, ((currentStepGlobal + safeSub) / totalStepsGlobal) * 100));

        if (loadingTextEl) loadingTextEl.textContent = msg;
        if (progressBar) progressBar.style.width = totalP.toFixed(1) + '%';
        // Yield to browser rendering loop
        await new Promise(r => setTimeout(r, 10));
    };

    try {
        const results = [];

        if (config.stratInitial) {
            await updateProgress("生成初始順序...");
            const tour = points.map((_, i) => i);
            results.push({ id: 'initial', tour, len: tourLength(tour, true), color: '#94a3b8', name: '初始順序', weight: 4, dash: null, opacity: 0.8, offset: 0 });
            currentStepGlobal++;
        }

        const baseStrats = [];
        if (config.stratNN) {
            await updateProgress("計算基礎策略 (最近鄰居)...");
            baseStrats.push({ id: 'nn', tour: runNearestNeighbor(), color: '#fbbf24', name: '最近鄰居' });
            currentStepGlobal++;
        }
        if (config.stratGreedy) {
            await updateProgress("計算基礎策略 (貪婪演算法)...");
            baseStrats.push({ id: 'greedy', tour: runGreedy(), color: '#34d399', name: '貪婪' });
            currentStepGlobal++;
        }
        if (config.stratInsertion) {
            await updateProgress("計算基礎策略 (插入法)...");
            baseStrats.push({ id: 'insertion', tour: runInsertion(), color: '#c084fc', name: '插入法' });
            currentStepGlobal++;
        }

        for (const base of baseStrats) {
            if (config.optNone) {
                results.push({ id: base.id + '_none', tour: base.tour, len: tourLength(base.tour, true), color: base.color, name: base.name + ' (無)', weight: 4, dash: null, opacity: 0.8, offset: 0 });
            }
            if (config.opt2Opt) {
                await updateProgress(`優化 ${base.name} (2-Opt)...`);
                const optTour = run2Opt(base.tour);
                results.push({ id: base.id + '_2opt', tour: optTour, len: tourLength(optTour, true), color: base.color, name: base.name + ' + 2-Opt', weight: 4, dash: '10, 8', opacity: 1, offset: 0 });
                currentStepGlobal++;
            }
            if (config.optLK) {
                await updateProgress(`深入優化 ${base.name} (L-K)...`);
                const lkTour = runLinKernighan(base.tour);
                results.push({ id: base.id + '_lk', tour: lkTour, len: tourLength(lkTour, true), color: base.color, name: base.name + ' + L-K', weight: 4, dash: '5, 5', opacity: 1, offset: 0 });
                currentStepGlobal++;
            }
            if (config.optSA) {
                await updateProgress(`模擬退火 ${base.name} (SA)...`);
                const saTour = runSimulatedAnnealing(base.tour);
                results.push({ id: base.id + '_sa', tour: saTour, len: tourLength(saTour, true), color: base.color, name: base.name + ' + SA', weight: 4, dash: '15, 10, 5, 10', opacity: 1, offset: 0 });
                currentStepGlobal++;
            }
            if (config.optGA) {
                await updateProgress(`基因演算 ${base.name} (GA)...`);
                const gaTour = runGeneticAlgorithm(base.tour);
                results.push({ id: base.id + '_ga', tour: gaTour, len: tourLength(gaTour, true), color: base.color, name: base.name + ' + GA', weight: 4, dash: '15, 5, 5, 5', opacity: 1, offset: 0 });
                currentStepGlobal++;
            }
        }

        renderResults(results);
    } catch (e) {
        alert("Fallback 錯誤: " + e.message);
        console.error(e);
        loadingOverlay.classList.add('hidden');
        isCalculating = false;
        btnCalculate.disabled = false;
    }
}

// Async API
function calculateTSP() {
    if (points.length < 3) return;

    // Check selected base strategies
    const stratNN = document.getElementById('stratNN')?.checked;
    const stratGreedy = document.getElementById('stratGreedy')?.checked;
    const stratInsertion = document.getElementById('stratInsertion')?.checked;

    // Check selected optimizations
    const optNone = document.getElementById('optNone')?.checked;
    const opt2Opt = document.getElementById('opt2Opt')?.checked;
    const optLK = document.getElementById('optLK')?.checked;
    const optSA = document.getElementById('optSA')?.checked;
    const optGA = document.getElementById('optGA')?.checked;

    // Check extra display
    const stratInitial = document.getElementById('stratInitial')?.checked;

    if (!stratInitial && !stratNN && !stratGreedy && !stratInsertion) {
        showToast("請至少選擇一種基礎策略或初始順序");
        return;
    }

    if (!stratInitial && !optNone && !opt2Opt && !optLK && !optSA && !optGA) {
        showToast("請至少選擇一種優化方式");
        return;
    }

    isCalculating = true;
    loadingOverlay.classList.remove('hidden');
    if (progressBar) progressBar.style.width = '0%';
    btnCalculate.disabled = true;

    // Show a more informative toast
    showToast("正在計算路線中...請稍候");

    const loadingTextStr = document.getElementById('loadingText');
    if (loadingTextStr) loadingTextStr.textContent = "正在準備計算...";

    const payloadConfig = { stratNN, stratGreedy, stratInsertion, optNone, opt2Opt, optLK, optSA, optGA, stratInitial };

    try {
        // Initialize worker if needed
        if (!tspWorker) {
            tspWorker = new Worker('worker.js');

            tspWorker.onmessage = function (e) {
                if (e.data.type === 'progress') {
                    if (loadingTextStr) loadingTextStr.textContent = e.data.message;
                    if (e.data.percent !== undefined && progressBar) progressBar.style.width = e.data.percent + '%';
                    return;
                }

                if (!e.data.success) {
                    console.error("Worker returned internal error:", e.data.error);
                    console.warn("Falling back to synchronous calculation due to internal worker error.");
                    calculateTSPFallback(payloadConfig);
                    return;
                }
                renderResults(e.data.results);
            };

            tspWorker.onerror = function (e) {
                console.warn("Worker loading/execution failed. Falling back to synchronous calculation.");
                calculateTSPFallback(payloadConfig);
                e.preventDefault(); // Prevent bubbling to window.onerror
            };
        }

        const payloadPoints = points.map(p => ({ lat: p.lat, lon: p.lon }));
        tspWorker.postMessage({ points: payloadPoints, config: payloadConfig });

    } catch (e) {
        // This catches CORS errors like trying to load a Worker from a file:// URL
        console.warn("Could not create Web Worker (likely file:// protocol restriction). Falling back to synchronous calculation.");
        calculateTSPFallback(payloadConfig);
    }
}

function updateDistanceDisplay(meters) {
    if (meters > 1000) {
        totalDistanceEl.textContent = (meters / 1000).toFixed(2) + " km";
    } else {
        totalDistanceEl.textContent = meters.toFixed(0) + " m";
    }
}

function drawElevationProfile(tour) {
    const hasElevation = points.some(p => p.ele !== undefined && p.ele !== 0);
    const elevationPanel = document.getElementById('elevationPanel');

    if (!hasElevation || !elevationPanel) {
        if (elevationPanel) elevationPanel.classList.add('hidden');
        return;
    }

    elevationPanel.classList.remove('hidden');

    let currentDist = 0;
    const profileData = [];
    for (let i = 0; i <= tour.length; i++) {
        const idx = tour[i % tour.length];
        const pt = points[idx];
        const ele = pt.ele || 0;

        profileData.push({ dist: currentDist, ele });

        if (i < tour.length) {
            const nextIdx = tour[(i + 1) % tour.length];
            // Compute distance via existing getter fallback mapping (getDistance is in app.js scope)
            if (typeof getDistance === 'function') {
                currentDist += getDistance(pt, points[nextIdx]);
            }
        }
    }

    const maxDist = currentDist || 1;
    let minEle = Math.min(...profileData.map(d => d.ele));
    let maxEle = Math.max(...profileData.map(d => d.ele));

    // add margin
    const diff = maxEle - minEle;
    if (diff === 0) {
        maxEle += 10;
        minEle -= 10;
    } else {
        maxEle += diff * 0.1;
        minEle -= diff * 0.1;
    }
    const eleRange = maxEle - minEle;

    const svgChart = document.getElementById('eleChart');
    let pathData = `0,100 `;
    profileData.forEach(d => {
        const x = (d.dist / maxDist) * 100;
        const y = 100 - (((d.ele - minEle) / eleRange) * 100);
        pathData += `${x},${y} `;
    });
    pathData += `100,100`;

    svgChart.setAttribute('viewBox', '0 0 100 100');
    svgChart.setAttribute('preserveAspectRatio', 'none');
    const polyline = document.getElementById('elePolyline');
    if (polyline) polyline.setAttribute('points', pathData);
}

// --- GPX File Loading & Projection ---
btnLoadGpx.addEventListener('click', () => {
    // Clear input first so selecting the same file triggers 'change' again
    gpxInput.value = '';
    gpxInput.click();
});

gpxInput.addEventListener('change', (e) => {
    try {
        const file = e.target.files[0];
        if (!file) {
            gpxInput.value = '';
            return;
        }

        const incomingFileName = file.name.replace(/\.[^/.]+$/, "");
        const reader = new FileReader();

        reader.onload = function (event) {
            try {
                const text = event.target.result;
                parseGPX(text, incomingFileName);
            } catch (err) {
                alert("GPX 載入過程發生程式錯誤: " + err.message + "\n請截圖告知開發者！");
                console.error(err);
            } finally {
                gpxInput.value = '';
            }
        };

        reader.onerror = function (err) {
            alert("讀取檔案時發生錯誤: " + err);
            gpxInput.value = '';
        };

        reader.readAsText(file);
    } catch (err) {
        alert("檔案讀取啟動失敗: " + err.message);
        gpxInput.value = '';
    }
});

function parseGPX(xmlText, incomingFileName = null) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, "text/xml");

    // Fallback safe way to check parsererror without querySelector
    const errorNodes = xmlDoc.getElementsByTagName("parsererror");
    if (errorNodes && errorNodes.length > 0) {
        alert("GPX 檔案解析失敗: 存在 parsererror 標籤。\n內容: " + errorNodes[0].textContent);
        return;
    }

    // Extract Waypoints (<wpt>) or Trackpoints (<trkpt>) using namespace-agnostic search
    let ptElements = Array.from(xmlDoc.getElementsByTagNameNS('*', 'wpt'));
    if (ptElements.length === 0) {
        ptElements = Array.from(xmlDoc.getElementsByTagNameNS('*', 'trkpt'));
    }
    if (ptElements.length === 0) {
        ptElements = Array.from(xmlDoc.getElementsByTagNameNS('*', 'rtept'));
    }

    if (ptElements.length === 0) {
        // Fallback to strict queries in case wildcard completely fails in this environment
        ptElements = Array.from(xmlDoc.getElementsByTagName('wpt'));
        if (ptElements.length === 0) {
            ptElements = Array.from(xmlDoc.getElementsByTagName('trkpt'));
        }
        if (ptElements.length === 0) {
            ptElements = Array.from(xmlDoc.getElementsByTagName('rtept'));
        }
    }

    if (ptElements.length === 0) {
        alert(`GPX 載入失敗！找不到 <wpt> 或 <trkpt> 座標點。\n檢查結果：wildcard wpt=${xmlDoc.getElementsByTagNameNS('*', 'wpt').length}, trkpt=${xmlDoc.getElementsByTagNameNS('*', 'trkpt').length}\n請確定您的 GPX 格式正確！`);
        return;
    }

    // Clear everything
    clearAll();

    // Restore the filename if one was provided
    if (incomingFileName) {
        origFileName = incomingFileName;
    }

    origGpxDoc = xmlDoc; // Save reference for exporting later

    let bounds = L.latLngBounds();

    ptElements.forEach(pt => {
        const lat = parseFloat(pt.getAttribute('lat'));
        const lon = parseFloat(pt.getAttribute('lon'));

        let ele = 0;
        const eleNodes = pt.getElementsByTagNameNS('*', 'ele');
        if (eleNodes && eleNodes.length > 0) {
            ele = parseFloat(eleNodes[0].textContent);
        }

        if (!isNaN(lat) && !isNaN(lon)) {
            const marker = L.marker([lat, lon], { icon: dotIcon, draggable: true })
                .bindTooltip((points.length + 1).toString(), {
                    permanent: true,
                    direction: 'top',
                    className: 'custom-tooltip'
                });

            pointGroup.addLayer(marker);
            points.push({ lat, lon, marker, element: pt, ele });
            bounds.extend([lat, lon]);

            // Add popup context menus and interaction handlers
            const pointObj = points[points.length - 1];
            bindMarkerEvents(marker, pointObj);
        }
    });

    if (points.length < 3) {
        alert(`GPX 檔案中的座標點過少 (需要至少 3 點)！\n偵測到的節點數: ${ptElements.length}\n成功轉換的座標點數: ${points.length}`);
        return;
    }

    // Zoom the map to fit the loaded points
    map.fitBounds(bounds, { padding: [50, 50] });

    resetRouteState();
    showToast(`成功載入 ${points.length} 個座標點`);
}

// --- File Exporting (ZIP) ---
async function exportZip(formatExt, generatorFunc) {
    if (currentCalculatedRoutes.length === 0) return;

    const routesToExport = currentCalculatedRoutes.filter(res => res.id !== 'initial');

    if (routesToExport.length === 0) {
        showToast("沒有可匯出的規劃路線");
        return;
    }

    if (typeof JSZip === 'undefined') {
        alert("無法載入 ZIP 壓縮套件，無法匯出。請確認網路連線！");
        return;
    }

    try {
        showToast(`正在壓縮打包 ${routesToExport.length} 個 ${formatExt.toUpperCase()} 路線檔案...`);

        const zip = new JSZip();
        const folder = zip.folder(origFileName);

        routesToExport.forEach((res) => {
            const contentStr = generatorFunc(res.tour, res.name);
            const safeSuffix = res.name.replace(/[ \/+()]/g, '_').replace(/_+/g, '_').replace(/_$/, '');
            const fileName = `${origFileName}_${safeSuffix}.${formatExt}`;
            folder.file(fileName, contentStr);
        });

        const content = await zip.generateAsync({ type: "blob" });

        const url = URL.createObjectURL(content);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${origFileName}_optimized_${formatExt}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast("打包完成！已開始下載 ZIP 壓縮檔。");
    } catch (e) {
        console.error(e);
        alert("打包 ZIP 過程中發生錯誤：" + e.message);
    }
}

document.getElementById('btnExportGpxItem').addEventListener('click', () => {
    exportZip('gpx', generateOptimizedGpxXML);
});

document.getElementById('btnExportKmlItem').addEventListener('click', () => {
    exportZip('kml', generateOptimizedKML);
});

document.getElementById('btnExportGeoJsonItem').addEventListener('click', () => {
    exportZip('geojson', generateOptimizedGeoJSON);
});

function generateOptimizedGpxXML(tour, routeName) {
    let gpxStr = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    gpxStr += `<gpx version="1.1" creator="TSP Optimizer" xmlns="http://www.topografix.com/GPX/1/1">\n`;
    gpxStr += `  <trk>\n`;
    gpxStr += `    <name>${routeName}</name>\n`;
    gpxStr += `    <trkseg>\n`;

    // Add points in the calculated order
    for (let i = 0; i <= tour.length; i++) {
        const pt = points[tour[i % tour.length]];
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

function generateOptimizedKML(tour, routeName) {
    let kmlStr = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    kmlStr += `<kml xmlns="http://www.opengis.net/kml/2.2">\n`;
    kmlStr += `  <Document>\n`;
    kmlStr += `    <name>${routeName}</name>\n`;
    kmlStr += `    <Placemark>\n`;
    kmlStr += `      <name>${routeName}</name>\n`;
    kmlStr += `      <LineString>\n`;
    kmlStr += `        <coordinates>\n`;

    for (let i = 0; i <= tour.length; i++) {
        const pt = points[tour[i % tour.length]];
        const ele = pt.element ? pt.element.querySelector('ele') : null;
        const eleStr = ele ? `,${ele.textContent}` : ``;
        kmlStr += `          ${pt.lon},${pt.lat}${eleStr}\n`;
    }

    kmlStr += `        </coordinates>\n`;
    kmlStr += `      </LineString>\n`;
    kmlStr += `    </Placemark>\n`;
    kmlStr += `  </Document>\n`;
    kmlStr += `</kml>`;
    return kmlStr;
}

function generateOptimizedGeoJSON(tour, routeName) {
    let coords = [];
    for (let i = 0; i <= tour.length; i++) {
        const pt = points[tour[i % tour.length]];
        const ele = pt.element ? pt.element.querySelector('ele') : null;
        if (ele) {
            coords.push(`[${pt.lon}, ${pt.lat}, ${ele.textContent}]`);
        } else {
            coords.push(`[${pt.lon}, ${pt.lat}]`);
        }
    }

    return `{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {
        "name": "${routeName}"
      },
      "geometry": {
        "type": "LineString",
        "coordinates": [\n        ${coords.join(',\n        ')}\n      ]
      }
    }
  ]
}`;
}

// Button bindings
btnCalculate.addEventListener('click', calculateTSP);

L.DomEvent.disableClickPropagation(btnLocation);
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

const btnReplayAll = document.getElementById('btnReplayAll');
if (btnReplayAll) {
    btnReplayAll.addEventListener('click', () => {
        if (!window.routeAnimators) return;
        Object.values(window.routeAnimators).forEach(animator => {
            if (typeof animator === 'function') animator();
        });
    });
}

// Bind config changes to saveState
document.querySelectorAll('.strategy-option input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', saveState);
});

// State Restoration
function loadState() {
    try {
        const configJson = localStorage.getItem('tsp_config');
        if (configJson) {
            const config = JSON.parse(configJson);
            if (config.stratNN !== undefined) document.getElementById('stratNN').checked = config.stratNN;
            if (config.stratGreedy !== undefined) document.getElementById('stratGreedy').checked = config.stratGreedy;
            if (config.stratInsertion !== undefined) document.getElementById('stratInsertion').checked = config.stratInsertion;
            if (config.optNone !== undefined) document.getElementById('optNone').checked = config.optNone;
            if (config.opt2Opt !== undefined) document.getElementById('opt2Opt').checked = config.opt2Opt;
            if (config.optLK !== undefined) document.getElementById('optLK').checked = config.optLK;
            if (config.optSA !== undefined) { const el = document.getElementById('optSA'); if (el) el.checked = config.optSA; }
            if (config.optGA !== undefined) { const el = document.getElementById('optGA'); if (el) el.checked = config.optGA; }
            if (config.stratInitial !== undefined) document.getElementById('stratInitial').checked = config.stratInitial;
        }

        const savedFileName = localStorage.getItem('tsp_filename');
        if (savedFileName) {
            origFileName = savedFileName;
        }

        const ptsJson = localStorage.getItem('tsp_points');
        if (ptsJson) {
            const pts = JSON.parse(ptsJson);
            if (Array.isArray(pts) && pts.length > 0) {
                // Temporarily disable saveState to prevent redundant writes
                const originalSaveState = saveState;
                saveState = function () { };

                pts.forEach(p => addPoint(p.lat, p.lon, null, -1, true));

                // Perform bulk UI sync once
                const baselineIndices = points.map((_, i) => i);
                updatePointMarkers(baselineIndices);
                resetRouteState();

                saveState = originalSaveState;

                let bounds = L.latLngBounds();
                pts.forEach(p => bounds.extend([p.lat, p.lon]));
                map.fitBounds(bounds, { padding: [50, 50] });
            }
        }
    } catch (e) {
        console.error("Failed to load state", e);
    }
}

document.addEventListener('DOMContentLoaded', loadState);
function clearAll() {
    points = [];
    optimizedRoute = [];
    origGpxDoc = null;
    currentCalculatedRoutes = [];
    origFileName = "route";
    localStorage.removeItem('tsp_filename');
    localStorage.removeItem('tsp_points');

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

    document.getElementById('btnExportMenu').disabled = true;
    updateStats();

    if (this === btnClear) {
        showToast("畫面已清除");
    }
}

// --- Collapsible Panels ---
document.getElementById('strategyPanelHeader')?.addEventListener('click', () => {
    document.getElementById('strategyPanel').classList.toggle('collapsed');
});
document.getElementById('statsPanelHeader')?.addEventListener('click', () => {
    document.getElementById('statsPanel').classList.toggle('collapsed');
});
// Default collapsed on mobile
if (window.innerWidth <= 768) {
    document.getElementById('strategyPanel')?.classList.add('collapsed');
    document.getElementById('statsPanel')?.classList.add('collapsed');
}

// --- Tutorial Sub-tabs + Swipe ---
function switchTutPanel(targetId) {
    document.querySelectorAll('.tutorial-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tutorial-panel').forEach(p => p.classList.remove('active'));
    document.querySelector(`.tutorial-tab[data-panel="${targetId}"]`)?.classList.add('active');
    document.getElementById(targetId)?.classList.add('active');
}
document.querySelectorAll('.tutorial-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTutPanel(btn.dataset.panel));
});
const tutPanelsContainer = document.getElementById('tutorialPanels');
if (tutPanelsContainer) {
    let swipeStartX = 0;
    tutPanelsContainer.addEventListener('touchstart', e => {
        swipeStartX = e.touches[0].clientX;
    }, { passive: true });
    tutPanelsContainer.addEventListener('touchend', e => {
        const dx = e.changedTouches[0].clientX - swipeStartX;
        if (Math.abs(dx) < 50) return;
        const tabs = [...document.querySelectorAll('.tutorial-tab')];
        const idx = tabs.findIndex(b => b.classList.contains('active'));
        if (dx < 0 && idx < tabs.length - 1) switchTutPanel(tabs[idx + 1].dataset.panel);
        if (dx > 0 && idx > 0) switchTutPanel(tabs[idx - 1].dataset.panel);
    }, { passive: true });
}

// --- Tab Navigation Logic ---
const tabBtns = document.querySelectorAll('.tab-btn');
const pages = document.querySelectorAll('.page');

tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const targetId = btn.dataset.target;

        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        pages.forEach(p => p.classList.remove('active'));
        document.getElementById(targetId).classList.add('active');

        if (targetId === 'page-planner') {
            setTimeout(() => map.invalidateSize(), 50);
        }
    });
});

// --- DB Optimizer Logic (Page 3) ---
const dbDropArea = document.getElementById('dbDropArea');
const dbInput = document.getElementById('dbInput');
const dbLogArea = document.getElementById('dbLogArea');
const dbStratSelect = document.getElementById('dbStratSelect');
const dbOptSelect = document.getElementById('dbOptSelect');
const dbProgressWrap = document.getElementById('dbProgressWrap');
const dbProgressBar = document.getElementById('dbProgressBar');
const dbProgressLabel = document.getElementById('dbProgressLabel');
const dbProgressPct = document.getElementById('dbProgressPct');
const dbProgressRoute = document.getElementById('dbProgressRoute');
const dbSkipLarge = document.getElementById('dbSkipLarge');
const dbSkipLargeThreshold = document.getElementById('dbSkipLargeThreshold');
const dbTimeoutSelect = document.getElementById('dbTimeoutSelect');
const dbThresholdSlider = document.getElementById('dbThresholdSlider');
const dbThresholdVal = document.getElementById('dbThresholdVal');
const dbAbortBtn = document.getElementById('dbAbortBtn');

const dbMergeTracks = document.getElementById('dbMergeTracks');
const dbExportGpx = document.getElementById('dbExportGpx');
const dbFileStatus = document.getElementById('dbFileStatus');
const dbStartOptimize = document.getElementById('dbStartOptimize');

let selectedDbFiles = [];

if (dbDropArea) {
    let dbCurrentWorker = null;
    let dbAbortFn = null;

    dbAbortBtn.addEventListener('click', () => {
        if (dbAbortFn) dbAbortFn();
    });

    function logDb(msg) {
        dbLogArea.innerHTML += `<div>${msg}</div>`;
        dbLogArea.scrollTop = dbLogArea.scrollHeight;
    }


    dbThresholdSlider.addEventListener('input', () => {
        dbThresholdVal.textContent = dbThresholdSlider.value;
        saveDbSettings();
    });

    function saveDbSettings() {
        localStorage.setItem('db_settings', JSON.stringify({
            strat: dbStratSelect.value,
            opt: dbOptSelect.value,
            skipLarge: dbSkipLarge.checked,
            skipLargeThreshold: dbSkipLargeThreshold.value,
            timeout: dbTimeoutSelect.value,
            threshold: dbThresholdSlider.value,
            mergeTracks: dbMergeTracks.checked,
            exportGpx: dbExportGpx.checked,
        }));
    }

    function loadDbSettings() {
        const raw = localStorage.getItem('db_settings');
        if (!raw) return;
        try {
            const s = JSON.parse(raw);
            if (s.strat !== undefined) dbStratSelect.value = s.strat;
            if (s.opt !== undefined) dbOptSelect.value = s.opt;
            if (s.skipLarge !== undefined) dbSkipLarge.checked = s.skipLarge;
            if (s.skipLargeThreshold !== undefined) dbSkipLargeThreshold.value = s.skipLargeThreshold;
            if (s.timeout !== undefined) dbTimeoutSelect.value = s.timeout;
            if (s.threshold !== undefined) {
                dbThresholdSlider.value = s.threshold;
                dbThresholdVal.textContent = s.threshold;
            }
            if (s.mergeTracks !== undefined) dbMergeTracks.checked = s.mergeTracks;
            if (s.exportGpx !== undefined) dbExportGpx.checked = s.exportGpx;
        } catch (e) { }
    }

    dbStratSelect.addEventListener('change', saveDbSettings);
    dbOptSelect.addEventListener('change', saveDbSettings);
    dbSkipLarge.addEventListener('change', saveDbSettings);
    dbSkipLargeThreshold.addEventListener('change', saveDbSettings);
    dbTimeoutSelect.addEventListener('change', saveDbSettings);
    dbMergeTracks.addEventListener('change', saveDbSettings);
    dbExportGpx.addEventListener('change', saveDbSettings);

    loadDbSettings();

    dbStartOptimize.addEventListener('click', startDbOptimization);

    function handleFilesSelection(files) {
        selectedDbFiles = Array.from(files).filter(f => f.name.endsWith('.db'));
        if (selectedDbFiles.length > 0) {
            dbFileStatus.textContent = `已選擇 ${selectedDbFiles.length} 個 .db 檔案`;
            dbStartOptimize.disabled = false;
        } else {
            dbFileStatus.textContent = "未選擇有效的 .db 檔案";
            dbStartOptimize.disabled = true;
        }
    }

    dbDropArea.addEventListener('click', () => dbInput.click());
    dbDropArea.addEventListener('dragover', (e) => { e.preventDefault(); dbDropArea.style.borderColor = '#3b82f6'; });
    dbDropArea.addEventListener('dragleave', (e) => { dbDropArea.style.borderColor = 'rgba(255,255,255,0.2)'; });
    dbDropArea.addEventListener('drop', (e) => {
        e.preventDefault();
        dbDropArea.style.borderColor = 'rgba(255,255,255,0.2)';
        handleFilesSelection(e.dataTransfer.files);
    });
    dbInput.addEventListener('change', (e) => {
        handleFilesSelection(e.target.files);
    });

    async function startDbOptimization() {
        if (selectedDbFiles.length === 0) return;

        const isMerge = dbMergeTracks.checked;
        const zip = new JSZip();
        const mainFolder = zip.folder(`optimized_results_${new Date().toISOString().slice(0, 10)}`);

        dbProgressWrap.style.display = 'flex';
        dbStartOptimize.disabled = true;
        dbDropArea.style.pointerEvents = 'none';
        dbDropArea.style.opacity = '0.5';
        dbLogArea.innerHTML = '';

        let anySuccess = false;
        if (!isMerge) {
            for (let i = 0; i < selectedDbFiles.length; i++) {
                const res = await analyzeAndOptimizeDb(selectedDbFiles[i], mainFolder, i + 1, selectedDbFiles.length);
                if (res.success) anySuccess = true;
            }
        } else {
            const res = await mergeAndOptimizeMultipleDbs(selectedDbFiles, mainFolder);
            if (res && res.success) anySuccess = true;
        }

        if (anySuccess) await finalizeZip(zip);

        dbStartOptimize.disabled = false;
        dbDropArea.style.pointerEvents = '';
        dbDropArea.style.opacity = '';
    }

    async function finalizeZip(zip) {
        dbProgressLabel.textContent = "正在生成 ZIP 打包檔...";
        const content = await zip.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(content);
        const a = document.createElement('a');
        a.href = url;
        a.download = `optimized_results_${new Date().getTime()}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        logDb(`<br><span style="color:#fbbf24; font-weight:bold;">📥 已下載所有優化結果 ZIP</span>`);
        dbProgressLabel.textContent = "分析完成！";
    }

    // Helper for Haversine distance (used in readDbStructure)
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

        return R * c; // in metres
    }

    // Helper for GPX generation (simplified, assuming `points` is globally available or passed)
    function generateOptimizedGpxXML(tour, name, pts) {
        let gpx = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<gpx xmlns="http://www.topografix.com/GPX/1/1" creator="GPS Joystick DB Optimizer" version="1.1">
  <trk>
    <name>${name}</name>
    <trkseg>`;
        for (let i = 0; i < tour.length; i++) {
            const p = pts[tour[i]];
            gpx += `      <trkpt lat="${p.lat}" lon="${p.lon}"></trkpt>\n`;
        }
        gpx += `    </trkseg>
  </trk>
</gpx>`;
        return gpx;
    }

    async function readDbStructure(file) {
        const buffer = await file.arrayBuffer();
        const workBuf = buffer.slice(0);
        const bytes = new Uint8Array(buffer);
        const view = new DataView(workBuf);

        // Scan names
        const decoder = new TextDecoder('utf-8');
        const allDbNames = [];
        for (let i = 0; i <= bytes.length - 8; i++) {
            if (bytes[i] === 0x41 && bytes[i + 1] === 0x41 && bytes[i + 2] === 0x41 && bytes[i + 3] === 0x41 &&
                bytes[i + 4] === 0x11 && bytes[i + 5] === 0x00 && bytes[i + 6] === 0x00) {
                const len = bytes[i + 7];
                if (len >= 2 && i + 8 + len <= bytes.length) {
                    try {
                        const name = decoder.decode(bytes.subarray(i + 8, i + 8 + len)).replace(/\0/g, '').trim();
                        if (name.length >= 2 && !name.startsWith('http')) allDbNames.push(name);
                    } catch (e) { }
                }
            }
        }

        // Scan runs
        const leafHdrOffsets = [];
        for (let i = 0; i + 7 < bytes.length; i += 8) {
            if (bytes[i] === 0x41 && bytes[i + 1] === 0x41 && bytes[i + 2] === 0x41 && bytes[i + 3] === 0x41 &&
                bytes[i + 4] === 0x0C && bytes[i + 5] === 0x00 && bytes[i + 6] === 0x03 && bytes[i + 7] === 0xE8) {
                leafHdrOffsets.push(i);
            }
        }
        const allRuns = [];
        if (leafHdrOffsets.length > 0) {
            let cur = [leafHdrOffsets[0]];
            for (let k = 1; k < leafHdrOffsets.length; k++) {
                if (leafHdrOffsets[k] === leafHdrOffsets[k - 1] + 8008) cur.push(leafHdrOffsets[k]);
                else { allRuns.push([...cur]); cur = [leafHdrOffsets[k]]; }
            }
            allRuns.push(cur);
        }
        const coordRuns = allRuns.filter(r => {
            const v = view.getFloat64(r[0] + 8, true);
            return isFinite(v) && Math.abs(v) > 0.001;
        }).sort((a, b) => a[0] - b[0]);

        if (coordRuns.length < 2) return null;
        let latRun = coordRuns[0];
        let lonRun = coordRuns[1];

        // Validate lat/lon assignment by checking the first finite value of each run.
        // If run[0] values exceed ±90 but run[1] values fit within ±90, they are swapped.
        const firstVal0 = view.getFloat64(coordRuns[0][0] + 8, true);
        const firstVal1 = view.getFloat64(coordRuns[1][0] + 8, true);
        if (Math.abs(firstVal0) > 90 && Math.abs(firstVal1) <= 90) {
            latRun = coordRuns[1];
            lonRun = coordRuns[0];
            logDb(`<span style="color:#fbbf24">⚠ 偵測到 lat/lon 順序相反，已自動交換。</span>`);
        } else if (Math.abs(firstVal0) > 90 && Math.abs(firstVal1) > 90) {
            logDb(`<span style="color:#ef4444">⚠ 兩個座標 run 的首值均超過 ±90°，無法確認 lat/lon，結果可能不正確。</span>`);
        }
        const nodeCount = Math.min(latRun.length, lonRun.length);
        const totalPts = nodeCount * 1000;
        const allLats = new Float64Array(totalPts);
        const allLons = new Float64Array(totalPts);
        for (let k = 0; k < nodeCount; k++) {
            if (k % 10 === 0) await new Promise(res => setTimeout(res, 0));
            for (let j = 0; j < 1000; j++) {
                allLats[k * 1000 + j] = view.getFloat64(latRun[k] + 8 + j * 8, true);
                allLons[k * 1000 + j] = view.getFloat64(lonRun[k] + 8 + j * 8, true);
            }
        }

        // Parse routes (simple jump detection fallback)
        const routes = [];
        let start = 0;
        for (let i = 1; i < totalPts; i++) {
            if (i % 10000 === 0) await new Promise(res => setTimeout(res, 0));
            const d = getHaversineDistance(allLats[i - 1], allLons[i - 1], allLats[i], allLons[i]);
            if (d > 300000) {
                const len = i - start;
                if (len > 5) {
                    const name = allDbNames[routes.length] || `Route_${routes.length + 1}`;
                    const idxArr = new Int32Array(len);
                    for (let j = 0; j < len; j++) idxArr[j] = start + j;
                    routes.push({ name, idxArr, len });
                }
                start = i;
            }
        }
        const lastLen = totalPts - start;
        if (lastLen > 5) {
            const name = allDbNames[routes.length] || `Route_${routes.length + 1}`;
            const idxArr = new Int32Array(lastLen);
            for (let j = 0; j < lastLen; j++) idxArr[j] = start + j;
            routes.push({ name, idxArr, len: lastLen });
        }

        return { bytes, workBuf, allDbNames, latRun, lonRun, allLats, allLons, routes };
    }

    async function runTspOnTracks(tracks) {
        const stratId = dbStratSelect.value;
        const optId = dbOptSelect.value;
        const routeTimeoutMs = parseInt(dbTimeoutSelect.value, 10);
        const skipLargeThreshold = parseInt(dbSkipLargeThreshold.value, 10) || 256;
        const isSkipLarge = dbSkipLarge.checked;
        const impThreshold = parseFloat(dbThresholdSlider.value) || 0;
        
        const results = [];

        let done = 0;
        for (let i = 0; i < tracks.length; i++) {
            const t = tracks[i];
            const routeData = t.pts;
            const ptCount = routeData.length;

            // 1. Check if we should skip this route due to size
            if (isSkipLarge && ptCount > skipLargeThreshold) {
                logDb(`<span style="color:#94a3b8">⏭️ [${i+1}/${tracks.length}] ${t.name} : 跳過 (點數 ${ptCount} > 上限 ${skipLargeThreshold})</span>`);
                results.push({ name: t.name, pts: routeData });
                done++;
                updateProgress(done, tracks.length, t.name);
                continue;
            }

            const res = await new Promise((resolve, reject) => {
                const worker = new Worker('worker.js');
                const timeout = setTimeout(() => {
                    worker.terminate();
                    resolve({ 
                        name: t.name, 
                        pts: routeData, 
                        isTimeout: true, 
                        pointCount: ptCount,
                        executionTime: routeTimeoutMs });
                }, routeTimeoutMs > 0 ? routeTimeoutMs + 5000 : 3600000);

                worker.onmessage = (e) => {
                    if (e.data.type === 'db-route-done') {
                        clearTimeout(timeout);
                        worker.terminate();
                        
                        const d = e.data;
                        const tour = d.tour;
                        const ratioNum = d.origLen > 0 ? ((d.origLen - d.newLen) / d.origLen * 100) : 0;
                        const ratioStr = ratioNum.toFixed(2);
                        
                        let shouldReplace = true;
                        let reason = "優化成功";

                        if (d.timedOut) {
                            shouldReplace = false;
                            reason = "執行逾時 (局部最佳解)";
                        } else if (ratioNum < impThreshold) {
                            shouldReplace = false;
                            reason = `改善比例 ${ratioStr}% 未達門檻 ${impThreshold}%`;
                        }

                        const finalPts = shouldReplace ? tour.map(idx => routeData[idx]) : routeData;
                        
                        // Detailed log
                        const logMsg = `
                            <div style="border-left: 2px solid ${shouldReplace ? '#34d399' : '#f87171'}; padding-left: 8px; margin: 4px 0; font-size: 0.8rem;">
                                <div style="color: #f8fafc; font-weight: bold;">[${i+1}/${tracks.length}] ${t.name}</div>
                                <div style="color: #94a3b8;">
                                    點數: ${d.pointCount} | 
                                    時間: ${formatTime(d.executionTime)} | 
                                    ${shouldReplace ? "✅ 已替換" : "❌ 未替換"} (${reason})
                                </div>
                                <div style="color: #60a5fa;">
                                    長度: ${d.origLen.toFixed(1)}m ➔ ${d.newLen.toFixed(1)}m 
                                    (改善: <span style="color: ${ratioNum > 0 ? '#34d399' : '#94a3b8'}">${ratioStr}%</span>)
                                </div>
                            </div>
                        `;
                        logDb(logMsg);

                        resolve({ name: t.name, pts: finalPts });
                    }
                };
                worker.onerror = (err) => {
                    clearTimeout(timeout);
                    worker.terminate();
                    logDb(`<span style="color:#f87171">❌ [${i+1}/${tracks.length}] ${t.name} : 執行錯誤 (${err.message})</span>`);
                    resolve({ name: t.name, pts: routeData });
                };
                worker.postMessage({ type: 'db-batch', routes: [routeData], stratId, optId, routeTimeoutMs });
            });

            results.push(res);
            done++;
            updateProgress(done, tracks.length, res.name);
        }
        return results;
    }

    function updateProgress(done, total, currentName) {
        const pct = Math.round(done / total * 100);
        dbProgressBar.style.width = pct + '%';
        dbProgressPct.textContent = pct + '%';
        dbProgressLabel.textContent = `處理中 (${done}/${total})`;
        dbProgressRoute.textContent = currentName;
    }

    function writeTracksToBuffer(bytes, results, latRun, lonRun, capacity) {
        const workBuf = bytes.buffer.slice(0);
        const view = new DataView(workBuf);
        let currentPos = 0;
        let lastLat = 0;
        let lastLon = 0;
        let hasWritten = false;

        for (let t = 0; t < results.length; t++) {
            const res = results[t];
            if (res.pts.length === 0) continue;

            // Insert gap point between tracks (+3° lat ≈ 333km)
            // GPS Joystick uses 300km discontinuity detection to split routes visually
            if (hasWritten && currentPos < capacity) {
                const leafIdx = Math.floor(currentPos / 1000);
                const posInLeaf = currentPos % 1000;
                view.setFloat64(latRun[leafIdx] + 8 + posInLeaf * 8, lastLat + 3.0, true);
                view.setFloat64(lonRun[leafIdx] + 8 + posInLeaf * 8, lastLon, true);
                currentPos++;
            }

            for (const p of res.pts) {
                if (currentPos >= capacity) break;
                const leafIdx = Math.floor(currentPos / 1000);
                const posInLeaf = currentPos % 1000;
                view.setFloat64(latRun[leafIdx] + 8 + posInLeaf * 8, p.lat, true);
                view.setFloat64(lonRun[leafIdx] + 8 + posInLeaf * 8, p.lon, true);
                currentPos++;
                lastLat = p.lat;
                lastLon = p.lon;
                hasWritten = true;
            }
        }

        // Pad remaining capacity with last written coordinate
        // Prevents stale data from the template file being misread as a new route
        if (hasWritten) {
            while (currentPos < capacity) {
                const leafIdx = Math.floor(currentPos / 1000);
                const posInLeaf = currentPos % 1000;
                view.setFloat64(latRun[leafIdx] + 8 + posInLeaf * 8, lastLat, true);
                view.setFloat64(lonRun[leafIdx] + 8 + posInLeaf * 8, lastLon, true);
                currentPos++;
            }
        }

        return workBuf;
    }

    async function analyzeAndOptimizeDb(file, zipFolder, fileIdx = 1, fileTotal = 1) {
        const data = await readDbStructure(file);
        if (!data) return { success: false };

        logDb(`<br><span style="color:#60a5fa">--- 處理: ${file.name} ---</span>`);
        const tracks = data.routes.map(r => {
            const pts = [];
            for (let i = 0; i < r.len; i++) pts.push({ lat: data.allLats[r.idxArr[i]], lon: data.allLons[r.idxArr[i]] });
            return { name: r.name, pts };
        });

        const results = await runTspOnTracks(tracks);
        // capacity = total leaf slots; writeTracksToBuffer uses this as a hard cap.
        // Gap points (R-1 for R tracks) count against capacity, so real data points
        // that fit = capacity - (results.length - 1). For typical non-full files this
        // is not an issue, but log a warning when packing is tight.
        const capacity = data.latRun.length * 1000;
        const gapSlots = Math.max(0, results.length - 1);
        const totalDataPts = results.reduce((s, r) => s + r.pts.length, 0);
        if (totalDataPts + gapSlots > capacity) {
            logDb(`<span style="color:#fbbf24">⚠ 軌跡總點數 (${totalDataPts}) + 間隔點 (${gapSlots}) 超過容量 (${capacity})，末尾 ${totalDataPts + gapSlots - capacity} 點將被截斷。</span>`);
        }
        const workBuf = writeTracksToBuffer(data.bytes, results, data.latRun, data.lonRun, capacity);

        const baseName = file.name.replace(/\.db$/i, '');
        zipFolder.file(`${baseName}_optimized.db`, workBuf);

        if (dbExportGpx.checked) {
            const gpxFolder = zipFolder.folder(`${baseName}_gpx`);
            results.forEach(res => {
                const gpxContent = generateOptimizedGpxXML(new Array(res.pts.length).fill(0).map((_, i) => i), res.name, res.pts);
                const safeName = res.name.replace(/[ \/+()]/g, '_').replace(/_+/g, '_');
                gpxFolder.file(`${safeName}.gpx`, gpxContent);
            });
        }
        return { success: true };
    }

    async function mergeAndOptimizeMultipleDbs(files, zipFolder) {
        logDb(`<br><span style="color:#60a5fa">--- 開始合併 ${files.length} 個 .db 檔案 ---</span>`);

        let allTracks = [];
        let firstFileResult = null;
        let maxCapacity = 0;
        let templateFileName = "";

        for (let i = 0; i < files.length; i++) {
            const data = await readDbStructure(files[i]);
            if (!data) {
                logDb(`<span style="color:#ef4444">⚠ 讀取 ${files[i].name} 失敗，跳過。</span>`);
                continue;
            }

            const currentCapacity = data.latRun.length * 1000;
            if (currentCapacity > maxCapacity) {
                maxCapacity = currentCapacity;
                firstFileResult = data;
                templateFileName = files[i].name;
            }

            for (let j = 0; j < data.routes.length; j++) {
                const r = data.routes[j];
                if (j % 5 === 0) await new Promise(res => setTimeout(res, 0));
                const pts = [];
                for (let k = 0; k < r.len; k++) pts.push({ lat: data.allLats[r.idxArr[k]], lon: data.allLons[r.idxArr[k]] });
                allTracks.push({ name: `${files[i].name.replace(/\.db$/i, '')}_${r.name}`, pts });
            }

            dbProgressLabel.textContent = `載入中：${files[i].name} (${i + 1}/${files.length})`;
            dbProgressBar.style.width = ((i + 1) / files.length * 20) + '%';
        }

        if (allTracks.length === 0 || !firstFileResult) {
            logDb(`<span style="color:#ef4444">找不到任何有效的軌跡資料。</span>`);
            return;
        }

        logDb(`<span style="color:#60a5fa">ℹ 已自動選擇容量最大的 <b>${templateFileName}</b> 作為合併模板 (可容納 ${maxCapacity} 點)。</span>`);
        logDb(`找到 ${allTracks.length} 條軌跡。開始計算容量並準備優化...`);

        // Capacity check before TSP
        let tracksToOptimize = [];
        let skippedTracksGroup = [];
        let accumulatedPts = 0;

        for (let i = 0; i < allTracks.length; i++) {
            const t = allTracks[i];
            const ptCount = t.pts.length;
            // +1 slot for the gap point inserted before each track except the first
            const gapCost = tracksToOptimize.length > 0 ? 1 : 0;
            if (accumulatedPts + gapCost + ptCount > maxCapacity) {
                skippedTracksGroup.push(t);
                logDb(`<span style="color:#fbbf24">⚠ 空間不足，跳過軌跡: ${t.name} (需要 ${ptCount + gapCost} 點，剩餘 ${maxCapacity - accumulatedPts} 點)</span>`);
            } else {
                tracksToOptimize.push(t);
                accumulatedPts += gapCost + ptCount;
            }
        }

        // Perform TSP on the filtered valid tracks
        const optimizedResults = await runTspOnTracks(tracksToOptimize);

        // Merge into a single buffer using the first file as template
        const workBuf = writeTracksToBuffer(firstFileResult.bytes, optimizedResults, firstFileResult.latRun, firstFileResult.lonRun, maxCapacity);
        zipFolder.file(`merged_optimized.db`, workBuf);

        if (dbExportGpx.checked) {
            const gpxFolder = zipFolder.folder(`merged_gpx`);
            
            // Export optimized ones
            optimizedResults.forEach(res => {
                const gpxContent = generateOptimizedGpxXML(new Array(res.pts.length).fill(0).map((_, i) => i), res.name, res.pts);
                const safeName = res.name.replace(/[ \/+()]/g, '_').replace(/_+/g, '_');
                gpxFolder.file(`${safeName}.gpx`, gpxContent);
            });

            // If user checked GPX export, they probably still want the GPX for the skipped tracks even if we couldn't fit them in the .db!
            if (skippedTracksGroup.length > 0) {
                const skippedFolder = gpxFolder.folder(`skipped_due_to_db_capacity`);
                skippedTracksGroup.forEach(res => {
                    const gpxContent = generateOptimizedGpxXML(new Array(res.pts.length).fill(0).map((_, i) => i), res.name, res.pts);
                    const safeName = res.name.replace(/[ \/+()]/g, '_').replace(/_+/g, '_');
                    skippedFolder.file(`${safeName}.gpx`, gpxContent);
                });
                logDb(`<span style="color:#34d399">ℹ 已將空間不足跳過的 ${skippedTracksGroup.length} 條軌跡匯出為原始 GPX，您可以單獨匯入它們。</span>`);
            }
        }

        logDb(`<br><span style="color:#34d399; font-weight:bold;">✅ 合併優化完成！</span>`);
        return { success: true };
    }
}

function toggleDetail(header) {
    const panel = header.parentElement.querySelector('.detail-panel');
    if (!panel) return;
    header.classList.toggle('open');
    panel.classList.toggle('open');
}
