let points = [];

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
    let n = points.length;
    if (n < 4) return run2Opt(points.map((_, i) => i));

    let bestTour = run2Opt([...baseTour]);
    let bestLen = tourLength(bestTour, true);
    let currentTour = [...bestTour];

    const maxIterations = 50;

    for (let i = 0; i < maxIterations; i++) {
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
            currentTour = [...bestTour];
        }
    }
    return bestTour;
}

self.addEventListener('message', function (e) {
    points = e.data.points;
    const config = e.data.config;

    try {
        const results = [];

        // 1. Extra Display (Initial)
        if (config.stratInitial) {
            const tour = points.map((_, i) => i);
            results.push({ id: 'initial', tour, len: tourLength(tour, true), color: '#94a3b8', name: '初始順序', weight: 4, dash: null, opacity: 0.8, offset: 0 });
        }

        // 2. Base Strategies Generation
        const baseStrats = [];
        if (config.stratNN) {
            baseStrats.push({ id: 'nn', tour: runNearestNeighbor(), color: '#fbbf24', name: '最近鄰居' });
        }
        if (config.stratGreedy) {
            baseStrats.push({ id: 'greedy', tour: runGreedy(), color: '#34d399', name: '貪婪' });
        }
        if (config.stratInsertion) {
            baseStrats.push({ id: 'insertion', tour: runInsertion(), color: '#c084fc', name: '插入法' });
        }

        // 3. Matrix Application (Base x Opt)
        baseStrats.forEach(base => {
            if (config.optNone) {
                results.push({
                    id: base.id + '_none',
                    tour: base.tour,
                    len: tourLength(base.tour, true),
                    color: base.color,
                    name: base.name + ' (無)',
                    weight: 4,
                    dash: null,
                    opacity: 0.8,
                    offset: 0
                });
            }

            if (config.opt2Opt) {
                const optTour = run2Opt(base.tour);
                results.push({
                    id: base.id + '_2opt',
                    tour: optTour,
                    len: tourLength(optTour, true),
                    color: base.color,
                    name: base.name + ' + 2-Opt',
                    weight: 4,
                    dash: '10, 8',
                    opacity: 1,
                    offset: 0
                });
            }

            if (config.optLK) {
                const lkTour = runLinKernighan(base.tour);
                results.push({
                    id: base.id + '_lk',
                    tour: lkTour,
                    len: tourLength(lkTour, true),
                    color: base.color,
                    name: base.name + ' + L-K',
                    weight: 4,
                    dash: '5, 5',
                    opacity: 1,
                    offset: 0
                });
            }
        });

        self.postMessage({ success: true, results: results });
    } catch (err) {
        self.postMessage({ success: false, error: err.message, stack: err.stack });
    }
});
