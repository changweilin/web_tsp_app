let points = [];
let currentStepGlobal = 0;
let totalStepsGlobal = 1;

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
        if (iter % 50 === 0) reportProgress("正在運用模擬退火優化 (SA)...", iter / totalExpectedIter);
        for (let i = 0; i < iterationsPerTemp; i++) {
            // Pick two random edges to 2-opt swap
            let idx1 = 1 + Math.floor(Math.random() * (n - 2));
            let idx2 = 1 + Math.floor(Math.random() * (n - 2));
            if (idx1 === idx2) continue;
            if (idx1 > idx2) [idx1, idx2] = [idx2, idx1];

            // Calculate delta length
            let newTour = [
                ...currentTour.slice(0, idx1),
                ...currentTour.slice(idx1, idx2).reverse(),
                ...currentTour.slice(idx2)
            ];

            let newLen = tourLength(newTour, true);
            let delta = newLen - currentLen;

            // Acceptance probability
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
        iter++;
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
        if (gen % 10 === 0) reportProgress("正在運用基因演算法優化 (GA)...", gen / generations);
        // Evaluate
        let scored = population.map(t => ({ tour: t, len: tourLength(t, true) }));
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
        while (nextPop.length < popSize) {
            // Tournament selection
            let parent1 = scored[Math.floor(Math.pow(Math.random(), 3) * popSize)].tour;
            let parent2 = scored[Math.floor(Math.pow(Math.random(), 3) * popSize)].tour;

            // Order Crossover (OX)
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
function handleDbBatch({ routes, stratId, optId }) {
    const total = routes.length;
    for (let r = 0; r < total; r++) {
        points = routes[r]; // array of {lat, lon}

        let tour;
        if (stratId === 'nn') tour = runNearestNeighbor();
        else if (stratId === 'greedy') tour = runGreedy();
        else if (stratId === 'insertion') tour = runInsertion();
        else tour = points.map((_, i) => i);

        if (optId === '2opt') tour = run2Opt(tour);
        else if (optId === 'lk') tour = runLinKernighan(tour);
        else if (optId === 'sa') tour = runSimulatedAnnealing(tour);
        else if (optId === 'ga') tour = runGeneticAlgorithm(tour);

        self.postMessage({ type: 'db-route-done', idx: r, tour });
    }
    self.postMessage({ type: 'db-batch-done' });
}

self.addEventListener('message', function (e) {
    if (e.data.type === 'db-batch') {
        handleDbBatch(e.data);
        return;
    }

    points = e.data.points;
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
                currentStepGlobal++;
            }

            if (config.optLK) {
                reportProgress(`正在更深入優化 ${base.name} (L-K)...`);
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
                currentStepGlobal++;
            }

            if (config.optSA) {
                reportProgress(`正在運用模擬退火優化 ${base.name} (SA)...`);
                const saTour = runSimulatedAnnealing(base.tour);
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
                const gaTour = runGeneticAlgorithm(base.tour);
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
