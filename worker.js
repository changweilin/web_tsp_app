let points = [];
let currentStepGlobal = 0;
let totalStepsGlobal = 1;
let routeDeadline = Infinity;

function reportProgress(msg, subProgress = 0) {
    const safeSub = Math.max(0, Math.min(1, subProgress));
    const totalP = Math.min(100, Math.max(0, ((currentStepGlobal + safeSub) / totalStepsGlobal) * 100));
    self.postMessage({ type: 'progress', message: msg, percent: totalP.toFixed(1) });
}

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

// Distance wrapper (used outside of matrix context)
function getDistance(p1, p2) {
    return getHaversineDistance(p1.lat, p1.lon, p2.lat, p2.lon);
}

// Distance matrix (precomputed per points array — O(1) lookup)
let distMatrix = null;
let distN = 0;

// Candidate neighbor list for 2-opt (k-nearest per city)
let neighborList = null;
const NEIGHBOR_K = 10;

function buildDistMatrix() {
    const n = points.length;
    distN = n;
    distMatrix = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const d = getHaversineDistance(points[i].lat, points[i].lon, points[j].lat, points[j].lon);
            distMatrix[i * n + j] = d;
            distMatrix[j * n + i] = d;
        }
    }
    // Build neighbor list alongside distance matrix
    const k = Math.min(NEIGHBOR_K, n - 1);
    neighborList = new Array(n);
    for (let i = 0; i < n; i++) {
        // Collect distances from i to all other cities
        const row = [];
        for (let j = 0; j < n; j++) {
            if (j !== i) row.push({ city: j, d: distMatrix[i * n + j] });
        }
        row.sort((a, b) => a.d - b.d);
        neighborList[i] = new Int32Array(k);
        for (let ki = 0; ki < k; ki++) neighborList[i][ki] = row[ki].city;
    }
}

function getDist(i, j) {
    return distMatrix[i * distN + j];
}

// Total route length
function tourLength(tour, closedLoop = true) {
    let len = 0;
    const endCount = closedLoop ? tour.length : tour.length - 1;
    for (let i = 0; i < endCount; i++) {
        len += getDist(tour[i], tour[(i + 1) % tour.length]);
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
            let d = getDist(current, j);
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
    const n = points.length;

    // Union-Find with path-halving and union-by-rank: O(α(n)) per operation
    const parent = Array.from({ length: n }, (_, i) => i);
    const rank = new Array(n).fill(0);
    function find(x) {
        while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
        return x;
    }
    function union(x, y) {
        const px = find(x), py = find(y);
        if (rank[px] < rank[py]) parent[px] = py;
        else if (rank[px] > rank[py]) parent[py] = px;
        else { parent[py] = px; rank[px]++; }
    }

    let edges = [];
    for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++)
            edges.push({ i, j, d: getDist(i, j) });
    edges.sort((a, b) => a.d - b.d);

    let adj = Array.from({ length: n }, () => []);
    let edgeCount = 0;

    for (let e of edges) {
        if (adj[e.i].length < 2 && adj[e.j].length < 2) {
            // Allow last edge (closes the cycle); otherwise reject if same component
            if (edgeCount === n - 1 || find(e.i) !== find(e.j)) {
                adj[e.i].push(e.j);
                adj[e.j].push(e.i);
                if (edgeCount < n - 1) union(e.i, e.j); // don't union on closing edge
                edgeCount++;
                if (edgeCount === n) break;
            }
        }
    }

    let tour = [0];
    let curr = 0, prev = -1;
    while (tour.length < n) {
        let next = adj[curr][0] === prev ? adj[curr][1] : adj[curr][0];
        if (next === undefined) break; // L1: guard against degree-1 endpoint
        tour.push(next);
        prev = curr; curr = next;
    }
    return tour;
}

function runInsertion() {
    const n = points.length;
    if (n < 3) return points.map((_, i) => i); // degenerate: 0, 1, or 2 points
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
            let increase = getDist(i, k) + getDist(k, j) - getDist(i, j);
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
    const n = points.length;
    if (n < 4) return [...initialTour];

    const k = neighborList ? neighborList[0].length : 0;
    let tour = [...initialTour];

    // pos[city] = current index in tour — enables O(1) city→position lookup
    const pos = new Int32Array(n);
    for (let i = 0; i < n; i++) pos[tour[i]] = i;

    let improved = true;
    let iterations = 0;
    const maxIterations = n * 100;

    while (improved && iterations < maxIterations) {
        if (Date.now() > routeDeadline) break;
        improved = false;
        iterations++;

        for (let i = 1; i < n - 1; i++) {
            if (Date.now() > routeDeadline) { improved = false; break; }
            const a = tour[i - 1];
            let b = tour[i];
            let dAB = getDist(a, b);

            // OPT2: iterate only over k-nearest neighbors of a
            for (let ki = 0; ki < k; ki++) {
                const c = neighborList[a][ki];
                // Early-exit: neighbors sorted by dist; if getDist(a,c) ≥ dAB no swap can help
                if (getDist(a, c) >= dAB) break;
                const j = pos[c] + 1; // want tour[j-1]=c, tour[j]=d
                if (j <= i + 1 || j >= n) continue; // segment must have length ≥ 2
                const d = tour[j];
                const delta = getDist(a, c) + getDist(b, d) - dAB - getDist(c, d);
                if (delta < -0.00001) {
                    // Reverse segment [i..j-1] in-place; maintain pos[]
                    let lo = i, hi = j - 1;
                    while (lo < hi) {
                        pos[tour[lo]] = hi; pos[tour[hi]] = lo;
                        [tour[lo], tour[hi]] = [tour[hi], tour[lo]];
                        lo++; hi--;
                    }
                    if (lo === hi) pos[tour[lo]] = lo;
                    improved = true;
                    b = tour[i];
                    dAB = getDist(a, b);
                }
            }
        }
    }

    const startIndex = tour.indexOf(0);
    if (startIndex !== -1 && startIndex !== 0) {
        return [...tour.slice(startIndex), ...tour.slice(0, startIndex)];
    }
    return tour;
}

// OPT3: Or-opt — relocate segments of 1–3 cities to better positions
function runOrOpt(initialTour) {
    const n = points.length;
    if (n < 5) return [...initialTour];

    const k = neighborList ? neighborList[0].length : 0;
    let tour = [...initialTour];
    const pos = new Int32Array(n);
    for (let i = 0; i < n; i++) pos[tour[i]] = i;

    let improved = true;
    while (improved) {
        if (Date.now() > routeDeadline) break;
        improved = false;

        outer:
        for (let segLen = 1; segLen <= 3; segLen++) {
            // Non-wrapping: keep index 0 fixed (same as 2-opt convention)
            for (let i = 1; i <= n - segLen - 1; i++) {
                if (Date.now() > routeDeadline) { improved = false; break outer; }

                const prev    = tour[i - 1];
                const seg0    = tour[i];
                const segLast = tour[i + segLen - 1];
                const after   = tour[i + segLen];

                // Delta from removing the segment: bridge prev→after directly
                const removeDelta = getDist(prev, after)
                                  - getDist(prev, seg0)
                                  - getDist(segLast, after);

                // Try inserting seg after each k-nearest neighbor of seg0
                for (let ki = 0; ki < k; ki++) {
                    const ins = neighborList[seg0][ki];
                    const j = pos[ins];

                    // Skip if insertion point overlaps the removed segment's neighbourhood
                    if (j >= i - 1 && j <= i + segLen) continue;

                    const insNext = tour[j + 1 < n ? j + 1 : 0];
                    const insertDelta = getDist(ins, seg0) + getDist(segLast, insNext)
                                      - getDist(ins, insNext);

                    if (removeDelta + insertDelta < -0.00001) {
                        // Apply: splice segment out, reinsert after ins
                        const seg = tour.splice(i, segLen);
                        const newJ = j > i ? j - segLen : j; // adjust index after splice
                        tour.splice(newJ + 1, 0, ...seg);
                        for (let x = 0; x < n; x++) pos[tour[x]] = x;
                        improved = true;
                        break outer;
                    }
                }
            }
        }
    }

    const startIndex = tour.indexOf(0);
    if (startIndex !== -1 && startIndex !== 0) {
        return [...tour.slice(startIndex), ...tour.slice(0, startIndex)];
    }
    return tour;
}

function runLinKernighan(baseTour) {
    let n = points.length;
    if (n < 4) return run2Opt(points.map((_, i) => i));

    let bestTour = run2Opt([...baseTour]);
    let bestLen = tourLength(bestTour, true);
    let currentTour = [...bestTour];

    const maxIterations = 50;

    for (let i = 0; i < maxIterations; i++) {
        if (Date.now() > routeDeadline) break;
        if (i % 5 === 0) reportProgress("正在更深入優化 (L-K)...", i / maxIterations);
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

function runSimulatedAnnealing(baseTour) {
    let n = points.length;
    if (n < 4) return run2Opt(points.map((_, i) => i));

    let currentTour = [...baseTour];
    let currentLen = tourLength(currentTour, true);

    let bestTour = [...currentTour];
    let bestLen = currentLen;

    // SA Parameters
    let temp = 10000;
    const coolingRate = 0.995;
    const minTemp = 0.001;
    const iterationsPerTemp = Math.min(n * 2, 100);

    const totalExpectedIter = Math.ceil(Math.log(minTemp / temp) / Math.log(coolingRate));
    let iter = 0;

    while (temp > minTemp) {
        if (Date.now() > routeDeadline) break;
        if (iter % 50 === 0) reportProgress("正在運用模擬退火優化 (SA)...", iter / totalExpectedIter);
        for (let i = 0; i < iterationsPerTemp; i++) {
            let idx1 = 1 + Math.floor(Math.random() * (n - 2));
            let idx2 = 1 + Math.floor(Math.random() * (n - 2));
            if (idx1 === idx2) continue;
            if (idx1 > idx2) [idx1, idx2] = [idx2, idx1];

            // Compute delta via 4-edge formula — no array allocation needed
            const a = currentTour[idx1 - 1], b = currentTour[idx1];
            const c = currentTour[idx2 - 1], d = currentTour[idx2];
            const delta = getDist(a, c)
                        + getDist(b, d)
                        - getDist(a, b)
                        - getDist(c, d);

            if (delta < 0 || Math.random() < Math.exp(-delta / temp)) {
                // Reverse segment [idx1..idx2-1] in-place
                let lo = idx1, hi = idx2 - 1;
                while (lo < hi) { [currentTour[lo], currentTour[hi]] = [currentTour[hi], currentTour[lo]]; lo++; hi--; }
                currentLen += delta; // O(1) update instead of full tourLength scan
                if (currentLen < bestLen) {
                    bestTour = [...currentTour];
                    bestLen = currentLen;
                }
            }
        }
        temp *= coolingRate;
        iter++;
        // Resync every 200 steps to prevent floating-point drift in cumulative delta
        if (iter % 200 === 0) currentLen = tourLength(currentTour, true);
    }

    return bestTour;
}

function runGeneticAlgorithm(baseTour) {
    let n = points.length;
    if (n < 4) return run2Opt(points.map((_, i) => i));

    const popSize = Math.max(50, n * 2);
    const generations = 200;
    const mutationRate = 0.1;

    // Initialize population
    let population = [];
    population.push([...baseTour]); // Ensure base is in population

    for (let i = 1; i < popSize; i++) {
        let tour = [...baseTour];
        // randomize middle
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
        if (Date.now() > routeDeadline) break;
        if (gen % 10 === 0) reportProgress("正在運用基因演算法優化 (GA)...", gen / generations);
        // Evaluate
        let scored = [];
        for (let pi = 0; pi < population.length; pi++) {
            if (Date.now() > routeDeadline) break;
            scored.push({ tour: population[pi], len: tourLength(population[pi], true) });
        }
        if (scored.length < 2) break; // not enough evaluated to continue
        scored.sort((a, b) => a.len - b.len);

        if (scored[0].len < bestOverallLen) {
            bestOverallLen = scored[0].len;
            bestOverallTour = [...scored[0].tour];
        }

        let nextPop = [];
        // Elitism
        nextPop.push(scored[0].tour);
        nextPop.push(scored[1].tour);

        // Crossover and mutate
        const evalCount = scored.length; // may be < popSize if deadline cut evaluation short
        while (nextPop.length < popSize) {
            // Tournament selection (cap range to evalCount to avoid out-of-bounds)
            let parent1 = scored[Math.floor(Math.pow(Math.random(), 3) * evalCount)].tour;
            let parent2 = scored[Math.floor(Math.pow(Math.random(), 3) * evalCount)].tour;

            // Order Crossover (OX)
            let start = 1 + Math.floor(Math.random() * (n - 2));
            let end = 1 + Math.floor(Math.random() * (n - 2));
            if (start > end) [start, end] = [end, start];
            if (start === end) end = Math.min(end + 1, n - 1); // ensure non-empty segment

            // Build placed-gene Set upfront for O(1) membership checks
            const placed = new Set([parent1[0], parent1[n - 1]]);
            for (let i = start; i < end; i++) placed.add(parent1[i]);

            let child = new Array(n).fill(-1);
            child[0] = parent1[0];
            child[n - 1] = parent1[n - 1];
            for (let i = start; i < end; i++) child[i] = parent1[i];

            let p2Idx = 1;
            for (let i = 1; i < n - 1; i++) {
                if (child[i] === -1) {
                    while (p2Idx < n - 1 && placed.has(parent2[p2Idx])) p2Idx++;
                    const gene = p2Idx < n - 1 ? parent2[p2Idx] : parent1[i];
                    child[i] = gene;
                    placed.add(gene);
                }
            }

            // Mutate
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

// ====== DB Batch Mode ======
function handleDbBatch({ routes, stratId, optId, routeTimeoutMs }) {
    const total = routes.length;
    for (let r = 0; r < total; r++) {
        points = routes[r]; // array of {lat, lon}
        buildDistMatrix();
        const startTime = Date.now();

        // Set per-route deadline
        routeDeadline = routeTimeoutMs > 0 ? Date.now() + routeTimeoutMs : Infinity;

        // Original tour = current DB order
        const origTour = points.map((_, i) => i);
        const origLen  = tourLength(origTour, true);

        let tour;
        try {
            if (stratId === 'nn') tour = runNearestNeighbor();
            else if (stratId === 'greedy') tour = runGreedy();
            else if (stratId === 'insertion') tour = runInsertion();
            else tour = [...origTour];

            if (optId === '2opt') tour = run2Opt(tour);
            else if (optId === 'lk') tour = runLinKernighan(tour);
            else if (optId === 'sa') tour = runSimulatedAnnealing(tour);
            else if (optId === 'ga') tour = runGeneticAlgorithm(tour);
            // OPT3: Or-opt as universal post-processing step
            if (optId !== 'none' && Date.now() < routeDeadline) tour = runOrOpt(tour);
        } catch(e) {
            tour = origTour.slice(); // fall back to original order
        }

        const endTime = Date.now();
        const executionTime = endTime - startTime;
        const timedOut = Date.now() > routeDeadline;

        routeDeadline = Infinity; // reset
        let newLen;
        try { 
            newLen = tourLength(tour, true); 
        } catch(e) { 
            newLen = origLen; 
            tour = origTour.slice(); 
        }

        self.postMessage({ 
            type: 'db-route-done', 
            idx: r, 
            tour, 
            origLen, 
            newLen, 
            pointCount: points.length,
            executionTime,
            timedOut
        });
    }
    self.postMessage({ type: 'db-batch-done' });
}

self.addEventListener('message', function (e) {
    if (e.data.type === 'db-batch') {
        handleDbBatch(e.data);
        return;
    }

    points = e.data.points;
    buildDistMatrix();
    const config = e.data.config;

    try {
        let baseStratsCount = 0;
        if (config.stratNN) baseStratsCount++;
        if (config.stratGreedy) baseStratsCount++;
        if (config.stratInsertion) baseStratsCount++;

        let optCount = 0;
        if (config.opt2Opt) optCount++;
        if (config.optLK) optCount++;
        if (config.optSA) optCount++;
        if (config.optGA) optCount++;

        totalStepsGlobal = (config.stratInitial ? 1 : 0) + baseStratsCount + (baseStratsCount * optCount);
        currentStepGlobal = 0;

        const results = [];

        // 1. Extra Display (Initial)
        if (config.stratInitial) {
            reportProgress("生成初始順序...");
            const tour = points.map((_, i) => i);
            results.push({ id: 'initial', tour, len: tourLength(tour, true), color: '#94a3b8', name: '初始順序', weight: 4, dash: null, opacity: 0.8, offset: 0 });
            currentStepGlobal++;
        }

        // 2. Base Strategies Generation
        const baseStrats = [];
        if (config.stratNN) {
            reportProgress('正在執行基礎策略 (最近鄰居法)...');
            baseStrats.push({ id: 'nn', tour: runNearestNeighbor(), color: '#fbbf24', name: '最近鄰居' });
            currentStepGlobal++;
        }
        if (config.stratGreedy) {
            reportProgress('正在執行基礎策略 (貪婪演算法)...');
            baseStrats.push({ id: 'greedy', tour: runGreedy(), color: '#34d399', name: '貪婪' });
            currentStepGlobal++;
        }
        if (config.stratInsertion) {
            reportProgress('正在執行基礎策略 (插入法)...');
            baseStrats.push({ id: 'insertion', tour: runInsertion(), color: '#c084fc', name: '插入法' });
            currentStepGlobal++;
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
                reportProgress(`正在優化 ${base.name} (2-Opt)...`);
                const optTour = runOrOpt(run2Opt(base.tour));
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
                currentStepGlobal++;
            }

            if (config.optLK) {
                reportProgress(`正在更深入優化 ${base.name} (L-K)...`);
                const lkTour = runOrOpt(runLinKernighan(base.tour));
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
                currentStepGlobal++;
            }

            if (config.optSA) {
                reportProgress(`正在運用模擬退火優化 ${base.name} (SA)...`);
                const saTour = runOrOpt(runSimulatedAnnealing(base.tour));
                results.push({
                    id: base.id + '_sa',
                    tour: saTour,
                    len: tourLength(saTour, true),
                    color: base.color,
                    name: base.name + ' + SA',
                    weight: 4,
                    dash: '15, 10, 5, 10',
                    opacity: 1,
                    offset: 0
                });
                currentStepGlobal++;
            }

            if (config.optGA) {
                reportProgress(`正在運用基因演算法優化 ${base.name} (GA)...`);
                const gaTour = runOrOpt(runGeneticAlgorithm(base.tour));
                results.push({
                    id: base.id + '_ga',
                    tour: gaTour,
                    len: tourLength(gaTour, true),
                    color: base.color,
                    name: base.name + ' + GA',
                    weight: 4,
                    dash: '15, 5, 5, 5',
                    opacity: 1,
                    offset: 0
                });
                currentStepGlobal++;
            }
        });

        self.postMessage({ success: true, results: results });
    } catch (err) {
        self.postMessage({ success: false, error: err.message, stack: err.stack });
    }
});
