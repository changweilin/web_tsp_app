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

    const exportDropdown = document.getElementById('exportDropdown');
    exportDropdown.classList.add('hidden');

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

    const exportDropdown = document.getElementById('exportDropdown');
    exportDropdown.classList.remove('hidden');

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

    const exportDropdown = document.getElementById('exportDropdown');
    if (exportDropdown) exportDropdown.classList.add('hidden');
    updateStats();

    if (this === btnClear) {
        showToast("畫面已清除");
    }
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
const dbProgressBar  = document.getElementById('dbProgressBar');
const dbProgressLabel = document.getElementById('dbProgressLabel');
const dbProgressPct  = document.getElementById('dbProgressPct');
const dbProgressRoute = document.getElementById('dbProgressRoute');

if (dbDropArea) {
    function logDb(msg) {
        dbLogArea.innerHTML += `<div>${msg}</div>`;
        dbLogArea.scrollTop = dbLogArea.scrollHeight;
    }

    dbDropArea.addEventListener('click', () => dbInput.click());
    dbDropArea.addEventListener('dragover', (e) => { e.preventDefault(); dbDropArea.style.borderColor = '#3b82f6'; });
    dbDropArea.addEventListener('dragleave', (e) => { dbDropArea.style.borderColor = 'rgba(255,255,255,0.2)'; });
    dbDropArea.addEventListener('drop', (e) => {
        e.preventDefault();
        dbDropArea.style.borderColor = 'rgba(255,255,255,0.2)';
        if (e.dataTransfer.files.length) processDbFile(e.dataTransfer.files[0]);
    });
    dbInput.addEventListener('change', (e) => {
        if (e.target.files.length) processDbFile(e.target.files[0]);
    });

    async function processDbFile(file) {
        if (!file.name.endsWith('.db')) {
            logDb(`<span style="color:#ef4444">錯誤: 請上傳 .db 檔案</span>`);
            return;
        }

        const stratId = dbStratSelect.value;
        const optId   = dbOptSelect.value;

        // 人類可讀的 TSP 方法名稱（用於檔名後綴）
        const stratLabel = { nn: 'nn', greedy: 'greedy', insertion: 'ins' }[stratId] || stratId;
        const optLabel   = { none: 'noopt', '2opt': '2opt', lk: 'lk', sa: 'sa', ga: 'ga' }[optId] || optId;
        const methodSuffix = `${stratLabel}_${optLabel}`;

        logDb(`<br><span style="color:#60a5fa">--- 開始處理: ${file.name} ---</span>`);
        logDb(`<span style="color:#94a3b8">TSP 方法：${stratLabel.toUpperCase()} + ${optLabel.toUpperCase()}</span>`);

        // 禁用拖放區避免重複觸發
        dbDropArea.style.pointerEvents = 'none';
        dbDropArea.style.opacity = '0.5';

        // 顯示進度條
        dbProgressWrap.style.display = 'flex';
        dbProgressBar.style.width = '0%';
        dbProgressPct.textContent = '0%';
        dbProgressLabel.textContent = '讀取檔案...';
        dbProgressRoute.textContent = '';

        const buffer  = await file.arrayBuffer();
        // ★ 立即複製一份作為寫入目標，保留原始 buffer 不動
        const workBuf = buffer.slice(0);
        const bytes   = new Uint8Array(buffer);   // 只讀，用於掃描名稱與 header

        // ====== 1. 從 DB 二進位掃描路線名稱 ======
        // Realm DB 以 AAAA(0x41414141) + 0x11 + 0x00 + 0x00 + length + UTF-8 string 儲存字串
        logDb(`<span style="color:#94a3b8">掃描路線名稱...</span>`);
        await new Promise(res => setTimeout(res, 5));

        const decoder = new TextDecoder('utf-8');
        const allDbNames = [];
        for (let i = 0; i <= bytes.length - 8; i++) {
            if (bytes[i] === 0x41 && bytes[i+1] === 0x41 && bytes[i+2] === 0x41 && bytes[i+3] === 0x41 &&
                bytes[i+4] === 0x11 && bytes[i+5] === 0x00 && bytes[i+6] === 0x00) {
                const len = bytes[i + 7];
                if (len >= 2 && i + 8 + len <= bytes.length) {
                    try {
                        const name = decoder.decode(bytes.subarray(i + 8, i + 8 + len)).replace(/\0/g, '').trim();
                        if (name.length >= 2 && !name.startsWith('http') &&
                            !name.includes('Landmark') && !name.includes('Recreational Area')) {
                            allDbNames.push(name);
                        }
                    } catch (e) { /* skip non-UTF-8 */ }
                }
            }
        }

        // ====== 2. 掃描座標資料（Realm leaf-node 串流解析法）======
        // Realm 以 B-tree 儲存座標：所有 lat 值連續存為一個大陣列，所有 lon 值另一個大陣列，
        // 各自分割成 1000 元素的 leaf node（header = AAAA 0x0C 0x00 0x03 0xE8）。
        // 路線邊界由 lat 與 lon 同時出現大幅跳躍（> 0.3°）來偵測。
        logDb(`<span style="color:#94a3b8">掃描座標資料 (Realm leaf-node 格式)...</span>`);
        await new Promise(res => setTimeout(res, 5));

        // view 指向複製品 workBuf，所有 setFloat64 寫入都進 workBuf，原始 buffer 不受影響
        const view = new DataView(workBuf);

        // 2a. 找所有 AAAA+0x0C+0x00+0x03+0xE8 header（8-byte 對齊掃描）
        const leafHdrOffsets = [];
        for (let i = 0; i + 7 < bytes.length; i += 8) {
            if (bytes[i]===0x41 && bytes[i+1]===0x41 && bytes[i+2]===0x41 && bytes[i+3]===0x41 &&
                bytes[i+4]===0x0C && bytes[i+5]===0x00 && bytes[i+6]===0x03 && bytes[i+7]===0xE8) {
                leafHdrOffsets.push(i);
            }
        }

        // 2b. 將連續 header 分組（相鄰 header 間距 8008 = 8 header + 1000×8 data bytes）
        const allRuns = [];
        if (leafHdrOffsets.length > 0) {
            let curRun2 = [leafHdrOffsets[0]];
            for (let k = 1; k < leafHdrOffsets.length; k++) {
                if (leafHdrOffsets[k] === leafHdrOffsets[k-1] + 8008) {
                    curRun2.push(leafHdrOffsets[k]);
                } else {
                    allRuns.push([...curRun2]);
                    curRun2 = [leafHdrOffsets[k]];
                }
            }
            allRuns.push(curRun2);
        }

        // 2c. 過濾座標 run（首值非零、有限、|v| > 0.001），按檔案位置排序
        const coordRuns = allRuns
            .filter(r => {
                const v = view.getFloat64(r[0] + 8, true);
                return isFinite(v) && Math.abs(v) > 0.001;
            })
            .sort((a, b) => a[0] - b[0]);

        if (coordRuns.length < 2) {
            logDb(`<span style="color:#ef4444">無法找到完整座標資料（需要 lat + lon 兩個 leaf-node run）。</span>`);
            return;
        }

        const latRun = coordRuns[0]; // 第一個 run = 緯度 (lat)
        const lonRun = coordRuns[1]; // 第二個 run = 經度 (lon)
        const nodeCount = Math.min(latRun.length, lonRun.length);
        const totalPts = nodeCount * 1000;

        // 2d. 讀取全部 lat / lon 值到連續陣列
        const allLats = new Float64Array(totalPts);
        const allLons = new Float64Array(totalPts);
        for (let k = 0; k < nodeCount; k++) {
            for (let j = 0; j < 1000; j++) {
                allLats[k * 1000 + j] = view.getFloat64(latRun[k] + 8 + j * 8, true);
                allLons[k * 1000 + j] = view.getFloat64(lonRun[k] + 8 + j * 8, true);
            }
        }

        // 2e. 偵測路線邊界：lat 與 lon 同時跳躍 > 0.3°（約 30 km）
        const JUMP_THRESH = 0.3;
        const routeStarts = [0];
        for (let i = 1; i < totalPts; i++) {
            if (Math.abs(allLats[i] - allLats[i-1]) > JUMP_THRESH &&
                Math.abs(allLons[i] - allLons[i-1]) > JUMP_THRESH) {
                routeStarts.push(i);
            }
        }
        routeStarts.push(totalPts);

        // 2f. 建立路線物件（過濾 < 10 點的雜訊片段）
        let routes = [];
        for (let r = 0; r < routeStarts.length - 1; r++) {
            const start = routeStarts[r], end = routeStarts[r + 1];
            if (end - start >= 10) routes.push({ start, end, len: end - start });
        }

        if (routes.length === 0) {
            logDb(`<span style="color:#ef4444">找不到任何路線資料（需要長度 ≥ 10 的座標序列）。</span>`);
            return;
        }

        // ====== 3. 名稱與路徑一對一驗證 ======
        logDb(`<br><span style="color:#c084fc; font-weight:bold;">📋 名稱與路徑一對一驗證</span>`);
        logDb(`資料庫路線名稱數量：<b style="color:#f8fafc">${allDbNames.length}</b> 條`);
        logDb(`具備座標資料路線數量：<b style="color:#f8fafc">${routes.length}</b> 條`);

        // 檢查重複名稱
        const nameCount = {};
        allDbNames.forEach(n => nameCount[n] = (nameCount[n] || 0) + 1);
        const duplicates = Object.entries(nameCount).filter(([, c]) => c > 1);

        if (allDbNames.length === routes.length && duplicates.length === 0) {
            logDb(`<span style="color:#34d399; font-weight:bold;">✅ 驗證通過：名稱與座標路線完全一對一配對！</span>`);
        } else {
            if (allDbNames.length !== routes.length) {
                const diff = allDbNames.length - routes.length;
                if (diff > 0) {
                    logDb(`<span style="color:#fbbf24;">⚠ 名稱（${allDbNames.length}）多於座標路線（${routes.length}），差異 ${diff} 條</span>`);
                    logDb(`&nbsp;&nbsp;└ ${diff} 條路線名稱尚無對應座標資料（可能為未下載的範本路線）`);
                } else {
                    logDb(`<span style="color:#ef4444;">⚠ 座標路線（${routes.length}）多於名稱（${allDbNames.length}），差異 ${Math.abs(diff)} 條</span>`);
                    logDb(`&nbsp;&nbsp;└ ${Math.abs(diff)} 條座標路線缺少對應名稱`);
                }
            }
            if (duplicates.length > 0) {
                logDb(`<span style="color:#fbbf24;">⚠ 發現 ${duplicates.length} 個重複路線名稱：</span>`);
                duplicates.slice(0, 5).forEach(([name, count]) =>
                    logDb(`&nbsp;&nbsp;└ "${name}" 重複 ${count} 次`)
                );
                if (duplicates.length > 5) logDb(`&nbsp;&nbsp;└ ...（共 ${duplicates.length} 個）`);
            }
            logDb(`<span style="color:#60a5fa;">→ 將對 ${routes.length} 條含座標資料的路線進行優化</span>`);
        }

        // 地理關鍵字輔助辨識（用於日誌顯示名稱）
        function geoKeyword(lat, lon) {
            if (lat >= 21.5 && lat <= 25.5 && lon >= 119.5 && lon <= 122.5) return '台灣';
            if (lat >= 26   && lat <= 46   && lon >= 127   && lon <= 146  ) return '日本';
            if (lat >= 33   && lat <= 38.5 && lon >= 124.5 && lon <= 130  ) return '韓國';
            if (lat >= 14   && lat <= 24   && lon >= 100   && lon <= 110  ) return '越南';
            if (lat >= 5    && lat <= 21   && lon >= 97    && lon <= 105  ) return '泰國';
            if (lat >= 35   && lat <= 44   && lon >= -10   && lon <= 5   ) return '西班牙';
            if (lat >= 41   && lat <= 52   && lon >= -5    && lon <= 9   ) return '法國';
            if (lat >= 47   && lat <= 56   && lon >= 5     && lon <= 15  ) return '德國';
            if (lat >= 49   && lat <= 59   && lon >= -8    && lon <= 2   ) return '英國';
            if (lat >= 24   && lat <= 49   && lon >= -125  && lon <= -66 ) return '美國';
            if (lat >= -44  && lat <= -10  && lon >= 113   && lon <= 154 ) return '澳洲';
            if (lat >= -52  && lat <= -22  && lon >= -73   && lon <= -35 ) return '巴西';
            if (lat >= 36   && lat <= 42   && lon >= 26    && lon <= 45  ) return '土耳其';
            if (lat >= 36   && lat <= 43   && lon >= 20    && lon <= 28  ) return '希臘';
            if (lat >= 1    && lat <= 1.5  && lon >= 103   && lon <= 105 ) return '新加坡';
            if (lat >= 51   && lat <= 54   && lon >= 3     && lon <= 8   ) return '荷蘭';
            if (lat >= 49.5 && lat <= 51.5 && lon >= 2     && lon <= 6.5 ) return '比利時';
            if (lat >= -47  && lat <= -34  && lon >= 166   && lon <= 178 ) return '紐西蘭';
            if (lat >= 22   && lat <= 35   && lon >= 50    && lon <= 60  ) return '阿拉伯';
            if (lat >= 50   && lat <= 71   && lon >= 37    && lon <= 68  ) return '俄';
            if (lat >= 49   && lat <= 55   && lon >= 12    && lon <= 23  ) return '捷克';
            if (lat >= 47   && lat <= 49   && lon >= 9     && lon <= 18  ) return '奧地利';
            if (lat >= 37   && lat <= 47   && lon >= 6     && lon <= 19  ) return '義大利';
            if (lat >= 44   && lat <= 47   && lon >= 14    && lon <= 23  ) return '克羅埃西亞';
            if (lat >= 43   && lat <= 47   && lon >= 19    && lon <= 24  ) return '塞爾維亞';
            if (lat >= 45   && lat <= 52   && lon >= 22    && lon <= 40  ) return '烏克蘭';
            if (lat >= 40   && lat <= 45   && lon >= 23    && lon <= 28  ) return '保加利亞';
            if (lat >= 1    && lat <= 5    && lon >= 103   && lon <= 105 ) return '新加坡';
            if (lat >= -12  && lat <= 5    && lon >= 95    && lon <= 141 ) return '印尼';
            if (lat >= 28   && lat <= 38   && lon >= 68    && lon <= 98  ) return '印度';
            if (lat >= 3    && lat <= 8    && lon >= 99    && lon <= 120 ) return '馬來西亞';
            if (lat >= 12   && lat <= 24   && lon >= 92    && lon <= 101 ) return '緬甸';
            if (lat >= 22   && lat <= 42   && lon >= 73    && lon <= 135 ) return '中國';
            if (lat >= -60  && lat <= -50  && lon >= -75   && lon <= -55 ) return '智利';
            if (lat >= -55  && lat <= -22  && lon >= -73   && lon <= -53 ) return '阿根廷';
            if (lat >= -4   && lat <= 13   && lon >= -17   && lon <= 5   ) return '西非';
            if (lat >= -35  && lat <= 5    && lon >= 10    && lon <= 45  ) return '非洲';
            return null;
        }

        function getRouteName(lats, lons, idx) {
            const n = lats.length;
            let sumLat = 0, sumLon = 0;
            for (let k = 0; k < n; k++) { sumLat += lats[k]; sumLon += lons[k]; }
            const cLat = sumLat / n, cLon = sumLon / n;

            // 若名稱數量與路線數量完全一致，則按順序直接對應
            if (allDbNames.length === routes.length) return allDbNames[idx];

            // 地理關鍵字匹配
            const kw = geoKeyword(cLat, cLon);
            if (kw) {
                const matches = allDbNames.filter(nm => nm.includes(kw));
                if (matches.length === 1) return matches[0];
                if (matches.length > 1) return `${kw}地區路線（${matches.length} 條符合）`;
            }

            // 回退：顯示座標
            return `路線 ${idx + 1}（${cLat.toFixed(2)}°N, ${cLon.toFixed(2)}°E）`;
        }

        const totalRoutes = routes.length;
        logDb(`<br>開始優化 <b style="color:#f8fafc">${totalRoutes}</b> 條路線`
            + ` [${dbStratSelect.options[dbStratSelect.selectedIndex].text}`
            + ` + ${dbOptSelect.options[dbOptSelect.selectedIndex].text}]...`);

        // 進度條輔助函式
        function setProgress(done, label, routeName) {
            const pct = Math.round((done / totalRoutes) * 100);
            dbProgressBar.style.width  = pct + '%';
            dbProgressPct.textContent  = pct + '%';
            dbProgressLabel.textContent = label;
            dbProgressRoute.textContent = routeName || '';
        }

        // ====== 4. 逐條路線優化 ======
        const tStart = Date.now();

        // 時間格式化輔助
        function fmtTime(s) {
            s = Math.round(s);
            if (s < 60) return `${s}s`;
            return `${Math.floor(s / 60)}m ${s % 60}s`;
        }

        // 寫回輔助函式（Worker 與 fallback 共用）
        function applyTour(r, tour) {
            const { start, end, len } = routes[r];
            const lats = allLats.slice(start, end);
            const lons = allLons.slice(start, end);
            const newLats = new Float64Array(len);
            const newLons = new Float64Array(len);
            for (let j = 0; j < len; j++) {
                newLats[j] = lats[tour[j]];
                newLons[j] = lons[tour[j]];
            }
            for (let j = 0; j < len; j++) {
                const gi = start + j;
                const leafIdx   = Math.floor(gi / 1000);
                const posInLeaf = gi % 1000;
                view.setFloat64(latRun[leafIdx] + 8 + posInLeaf * 8, newLats[j], true);
                view.setFloat64(lonRun[leafIdx] + 8 + posInLeaf * 8, newLons[j], true);
            }
            const routeLabel = getRouteName(lats, lons, r);
            const elapsedSec = (Date.now() - tStart) / 1000;
            const done = r + 1;
            const remaining = totalRoutes - done;
            const eta = remaining > 0 ? (elapsedSec / done) * remaining : 0;
            const etaStr = remaining > 0 ? `剩約 ${fmtTime(eta)}` : '即將完成';
            setProgress(done,
                `路線 ${done} / ${totalRoutes}  ·  已用 ${fmtTime(elapsedSec)}  ·  ${etaStr}`,
                `${routeLabel}（${len} 點）`
            );
            logDb(`- [${routeLabel}]：${len} 點 <span style="color:#34d399">✓</span>`);
        }

        // 嘗試用 Web Worker（不阻塞主執行緒，log 即時顯示）
        try {
            // 準備路線資料傳給 Worker
            const routeData = routes.map(({ start, end, len }) => {
                const pts = [];
                for (let j = 0; j < len; j++) {
                    pts.push({ lat: allLats[start + j], lon: allLons[start + j] });
                }
                return pts;
            });

            await new Promise((resolve, reject) => {
                const dbWorker = new Worker('worker.js');
                dbWorker.onmessage = (e) => {
                    if (e.data.type === 'db-route-done') {
                        applyTour(e.data.idx, e.data.tour);
                    } else if (e.data.type === 'progress') {
                        dbProgressLabel.textContent = e.data.message;
                    } else if (e.data.type === 'db-batch-done') {
                        dbWorker.terminate();
                        resolve();
                    }
                };
                dbWorker.onerror = (err) => { dbWorker.terminate(); reject(err); };
                dbWorker.postMessage({ type: 'db-batch', routes: routeData, stratId, optId });
            });

        } catch (_) {
            // Fallback：同步處理（file:// 協議或舊瀏覽器）
            logDb(`<span style="color:#fbbf24">⚠ Web Worker 不可用，改用同步處理...</span>`);
            for (let r = 0; r < totalRoutes; r++) {
                const { start, end, len } = routes[r];
                const lats = allLats.slice(start, end);
                const lons = allLons.slice(start, end);
                const oldPoints = [...points];
                points = [];
                for (let j = 0; j < len; j++) points.push({ lat: lats[j], lon: lons[j] });
                let tour;
                if (stratId === 'nn') tour = runNearestNeighbor();
                else if (stratId === 'greedy') tour = runGreedy();
                else if (stratId === 'insertion') tour = runInsertion();
                else tour = points.map((_, i) => i);
                if (optId === '2opt') tour = run2Opt(tour);
                else if (optId === 'lk') tour = runLinKernighan(tour);
                else if (optId === 'sa') tour = runSimulatedAnnealing(tour);
                else if (optId === 'ga') tour = runGeneticAlgorithm(tour);
                points = oldPoints;
                applyTour(r, tour);
                if ((r + 1) % 5 === 0) await new Promise(res => setTimeout(res, 0));
            }
        }

        // 完成進度條
        const totalSec = ((Date.now() - tStart) / 1000).toFixed(1);
        setProgress(totalRoutes, `完成！共 ${totalRoutes} 條  ·  耗時 ${totalSec}s`, '');

        logDb(`<br><span style="color:#34d399; font-weight:bold;">✅ 全部 ${totalRoutes} 條路線優化完成（${totalSec}s）</span>`);
        logDb(`準備下載...`);
        await new Promise(res => setTimeout(res, 30));

        // ====== 5. 下載修改後的 workBuf ======
        const blob = new Blob([workBuf], { type: 'application/octet-stream' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        const baseName = file.name.replace(/\.db$/i, '');
        a.download = `${baseName}_${methodSuffix}.db`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        logDb(`<span style="color:#fbbf24">📥 已下載: ${a.download}</span>`);

        // 恢復拖放區
        dbDropArea.style.pointerEvents = '';
        dbDropArea.style.opacity = '';
    }
}
