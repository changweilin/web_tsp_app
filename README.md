[README.md](https://github.com/user-attachments/files/25746658/README.md)
# Web TSP Optimizer — 網頁版旅行推銷員問題最佳化工具

> A purely client-side SPA — no server, no build step, no dependencies beyond a static file host.
> 純前端、無後端依賴的單頁應用程式。

---

## Contents / 目錄

- [🌍 English](#-english)
  1. [Overview](#1-overview)
  2. [Architecture](#2-architecture)
  3. [Algorithms](#3-algorithms)
  4. [Realm DB Binary Parsing](#4-realm-db-binary-parsing)
  5. [Web Worker Concurrency](#5-web-worker-concurrency)
  6. [Batch Optimization Settings](#6-batch-optimization-settings)
  7. [Running Locally](#7-running-locally)
  8. [File Structure](#8-file-structure)
- [🇹🇼 繁體中文](#-繁體中文)

---

## 🌍 English

### 1. Overview

| Page | Function |
|------|----------|
| **Page 1 — Route Planner** | Upload GPX/XML, click-to-add waypoints on map, real-time TSP solve, export GPX |
| **Page 2 — Algorithm Tutorial** | Animated diagrams for all 7 algorithms + expandable math formulas and variable tables |
| **Page 3 — DB Batch Optimizer** | Parse GPS Joystick Realm `.db`, reorder coordinates in-place, download modified file |

---

### 2. Architecture

```
best_gpx/
└── web_tsp_app/
    ├── index.html   — Three-page SPA (tab switching, no framework)
    ├── app.js       — All frontend logic (~1900 lines)
    │                  · Page 1: map interaction (Leaflet)
    │                  · Page 3: DB parsing and write-back
    │                  · TSP algorithms (synchronous fallback)
    ├── index.css    — Styles (Glassmorphism design language)
    └── worker.js    — Web Worker: TSP algorithms (async primary path)
```

**Runtime requirements**: modern browser (ES2020+), local HTTP server (to avoid `file://` CORS restrictions).
**External dependencies**: [Leaflet.js](https://leafletjs.com/) only (map rendering).

---

### 3. Algorithms

All algorithms compute distances using the **Haversine formula** for great-circle distance:

```
a    = sin²(Δφ/2) + cos φᵢ · cos φⱼ · sin²(Δλ/2)
d(i,j) = 2R · arctan2(√a, √(1−a))       R = 6,371,000 m
```

#### Base Strategies (constructing an initial tour)

##### 1. Nearest Neighbor — O(n²)

At each step, greedily select the closest unvisited point:

```
next = argmin_{j ∈ U} d(current, j)
```

- **Pro**: Extremely fast.
- **Con**: Late-stage long crossings are common; solution quality is typically 15–25% worse than Greedy.

##### 2. Greedy — O(n² log n)

Sort all n(n−1)/2 edges by length, then add each edge if it satisfies:

```
add edge(i,j)  ⟺  deg(i)<2  ∧  deg(j)<2  ∧  (|E|=n−1  ∨  ¬cycle(i,j))
```

- `deg(v)`: current degree of node v (capped at 2).
- `cycle(i,j)`: DFS check — would adding this edge close a premature loop?
- The sort is the O(n² log n) bottleneck; each cycle check is O(n).

##### 3. Insertion — O(n²)

Build the tour incrementally, inserting each new point k at the position of minimum cost increase:

```
Δ(i, k, j) = d(i,k) + d(k,j) − d(i,j)
pos*        = argmin_{(i,j)∈T} Δ(i, k, j)
```

- Initial tour: T = [0, 1, 0]; iteratively inserts {2, …, n−1}.
- Produces very stable results with few crossings — an excellent seed for 2-Opt.

---

#### Optimization Methods (improving an existing tour)

##### A. 2-Opt — O(n²) per pass

Enumerate all non-adjacent edge pairs (i, j). If reversing the segment T[i..j] shortens the tour, accept:

```
Δ   = [d(t₁,t₃) + d(t₂,t₄)] − [d(t₁,t₂) + d(t₃,t₄)]
T'  = T[0..i] + reverse(T[i..j]) + T[j..n]    (accepted when Δ < 0)
```

| Parameter | Value |
|-----------|-------|
| `maxIterations` | n × 100 |
| Improvement threshold | new length < old length − 0.00001 m |
| Timeout granularity | Every O(n) steps (top of the i-loop) |

##### B. Lin-Kernighan (L-K) — O(50 × n²)

Uses a **Double-Bridge Kick** (4-opt perturbation) to escape local minima that 2-Opt cannot:

```
T  = A | B | C | D   (split at random p₁ < p₂ < p₃)
T' = A + D + C + B   (reconnect; equivalent to removing 4 edges simultaneously)

Cut-point ranges:
  p₁ ∈ [1,      n/4)
  p₂ ∈ [p₁+1,  p₁+n/4)
  p₃ ∈ [p₂+1,  p₂+n/4)
```

Each perturbation is followed by a full 2-Opt local search; 50 perturbation rounds total.
For n < 8, degrades to a random Swap perturbation.

##### C. Simulated Annealing

Accepts worse solutions probabilistically via the Metropolis–Hastings criterion, with geometric cooling:

```
P(accept) = e^(−Δ/T)          Δ = L_new − L_current  (Δ ≥ 0)
T_{k+1}   = α · T_k
Total steps K = ⌈log(T_min / T₀) / log(α)⌉ ≈ 1,840
```

| Parameter | Value |
|-----------|-------|
| `T₀` | 10,000 |
| `α` (coolingRate) | 0.995 |
| `T_min` | 0.001 |
| `iterationsPerTemp` | min(n×2, 100) |

The high-temperature phase allows temporary quality regression to escape local minima; the low-temperature phase fine-tunes toward the optimum.

##### D. Genetic Algorithm — O(generations × popSize × n)

```
Fitness:   f(T) = Σ_{i=0}^{n−1} d(T[i], T[(i+1) mod n])   (minimize)

Selection: parent = scored[⌊r³ × popSize⌋],  r ~ Uniform(0,1)
           (cubic bias — better individuals are selected proportionally more often)

Crossover: Order Crossover (OX)
           1. Copy segment T[start..end] from parent1 into child
           2. Fill remaining positions in parent2's order, skipping already-placed genes
           3. First and last nodes are fixed and never crossed
```

| Parameter | Value |
|-----------|-------|
| `popSize` | max(50, n×2) |
| `generations` | 200 |
| `mutationRate` | 0.1 (random Swap mutation on child) |
| Elitism | Top 2 individuals carried forward each generation |

---

### 4. Realm DB Binary Parsing

> The most technically complex part of the project. The entire `.db` file is manipulated client-side using `ArrayBuffer` + `DataView` — **no Realm SDK, no server required**.

GPS Joystick exports a Realm database with an internal B-tree page structure. Rather than using the SDK, we scan the raw bytes directly to locate coordinate data.

#### Magic Bytes — Node Identification

Every critical node is prefixed with the sentinel `0xAAAAAAAA` (4 bytes).

| Node type | Magic sequence | Description |
|-----------|---------------|-------------|
| Route name | `AAAA + 0x11 + 0x00 + 0x00 + <len>` | Non-aligned scan; followed by UTF-8 string |
| Float64 leaf | `AAAA + 0x0C + 0x00 + 0x03 + 0xE8` | 8-byte aligned; **1000** float64 values per node |
| Route index table | `AAAA + 0x46` | N × uint32 LE offsets pointing to 0x05 nodes |
| Coordinate index node | `AAAA + 0x05` | header = uint16 BE point count; data = N × uint16 LE global indices |

#### Float64 Coordinate Run Layout

Coordinates are stored in three sequential runs, each sharing the same node structure:

```
Run 0  →  latitude  for all routes
Run 1  →  longitude for all routes
Run 2  →  elevation / speed
```

Each Float64 leaf node holds exactly 1000 values (matching GPS Joystick's per-route maximum). A global coordinate index `gi` maps to its leaf and in-leaf offset as:

```
leafIdx   = Math.floor(gi / 1000)
posInLeaf = gi % 1000

// Reading latitude:
lat = view.getFloat64(latRun[leafIdx] + 8 + posInLeaf * 8, true)   // little-endian
```

#### Route Index Structure (0x46 / 0x05)

This two-level structure gives an exact, deterministic name ↔ coordinate mapping:

```
0x46 node
  └─ [offset₀, offset₁, …, offsetₙ]   (uint32 LE, one per route)
        │
        ▼  (each offset points to a 0x05 node)
     0x05 node
       ├─ cnt          (uint16 BE)  ← number of coordinate points in this route
       └─ [idx₀, …, idx_{cnt-1}]   (uint16 LE) ← global coordinate indices
```

**Locating the correct 0x46 node**: scan all `AAAA+0x46` occurrences and take the last one whose entry count equals `allDbNames.length`.

**Ring Buffer Wrap-Around correction**: coordinate indices are stored as uint16 (max 65535), but the global coordinate pool can exceed this. When a sequential index decreases (`idx[k] < idx[k-1]`), a carry counter corrects the overflow:

```javascript
if (raw < prev) carry += 0x10000;
globalIndex = carry + raw;
```

#### Write-Back

After optimization, the reordered coordinates are written back into the original `ArrayBuffer` at the exact same byte offsets:

```javascript
view.setFloat64(latRun[leafIdx] + 8 + posInLeaf * 8, newLats[j], true);
view.setFloat64(lonRun[leafIdx] + 8 + posInLeaf * 8, newLons[j], true);
```

The entire `workBuf` (a full copy of the original file) is wrapped in a `Blob` and downloaded. **All other Realm structural bytes remain byte-for-byte identical.**

---

### 5. Web Worker Concurrency

TSP computation runs in `worker.js` off the main thread, keeping the UI responsive during batch processing.

```
app.js (main thread)                    worker.js (Worker thread)
────────────────────────────────────    ──────────────────────────────────────
postMessage({                      ──▶  handleDbBatch({ routes, stratId,
  type: 'db-batch',                       optId, routeTimeoutMs })
  routes, stratId, optId,
  routeTimeoutMs                          for each route r:
})                                          points       = routes[r]
                                            routeDeadline = now + timeout
                                            origLen       = tourLength(origTour)
                                            tour          = runStrategy()
                                            tour          = runOptimizer(tour)
                                            newLen        = tourLength(tour)
                                     ◀──  postMessage({ type: 'db-route-done',
applyTour(origIdx, tour,                    idx: r, tour, origLen, newLen })
  doneCount, origLen, newLen)
                                     ◀──  postMessage({ type: 'db-batch-done' })
```

If the Worker throws (e.g., a malformed route from a degenerate Greedy graph), the `onerror` handler rejects the Promise and the main thread falls back to synchronous processing — gracefully degrading for `file://` environments.

#### Per-Route Timeout

Each route receives an independent `routeDeadline` (Unix ms timestamp). Deadline checks are embedded at **O(n) granularity** — inside the inner loops of each optimizer — so the worker breaks out promptly rather than waiting for an entire O(n²) pass to complete:

```javascript
// 2-Opt: checked at the top of the i-loop (every O(n) steps)
for (let i = 1; i < bestTour.length - 1; i++) {
    if (Date.now() > routeDeadline) { improved = false; break; }
    // inner j-loop ...
}

// GA: checked before evaluating each individual in the population
for (let pi = 0; pi < population.length; pi++) {
    if (Date.now() > routeDeadline) break;
    scored.push({ tour: population[pi], len: tourLength(population[pi], true) });
}
```

---

### 6. Batch Optimization Settings

Page 3 exposes three configurable options for the batch run:

| Option | Default | Description |
|--------|---------|-------------|
| Skip routes exceeding N points | 256 (editable) | Routes above the threshold are logged amber and skipped entirely |
| Per-route timeout | 3 minutes | Dropdown: 1 min / 3 min / 10 min / unlimited |
| Minimum improvement threshold | 0% | If `(origLen − newLen) / origLen` is below this, coordinates are **not** written back |

Improvement threshold formula:

```
improvement = max(0, (origLen − newLen) / origLen)
if improvement ≥ threshold  →  write back reordered coords
else                         →  skip; original bytes unchanged
```

---

### 7. Running Locally

Web Workers are blocked under the `file://` protocol (CORS). Start a local HTTP server:

```bash
# Python 3
python -m http.server 8000

# Node.js (npx required)
npx serve .
```

Then open `http://localhost:8000/web_tsp_app/`.

---

### 8. File Structure

```
best_gpx/
├── README.md
├── data/
│   └── gpsjoystick_*.db          Sample Realm database (2 MB, 576 routes)
└── web_tsp_app/
    ├── index.html                 SPA entry point, three-page structure
    ├── app.js                     Main logic
    │   ├── Tab routing / page switching
    │   ├── Page 1: Leaflet map, GPX import/export, TSP main flow
    │   ├── Page 3: Realm DB parsing (scan, index rebuild, coord location)
    │   │          · Name scan:      0x11 node non-aligned scan
    │   │          · Coord location: 0x0C+0x03E8 leaf node, 8-byte aligned
    │   │          · Route index:    0x46/0x05 tree rebuild + ring buffer carry
    │   │          · Write-back:     DataView.setFloat64 in-place injection
    │   └── Algorithms (sync fallback): NN / Greedy / Insertion / 2-Opt / LK / SA / GA
    ├── worker.js                  Web Worker
    │   ├── Same algorithms (primary async path)
    │   └── handleDbBatch: per-route optimization loop + timeout control
    └── index.css                  Styles (Glassmorphism + animation keyframes)
```

---

## 🇹🇼 繁體中文

### 1. 功能總覽

| 頁面 | 功能 |
|------|------|
| **Page 1 — 路徑規劃器** | 上傳 GPX/XML、地圖點擊建點、即時 TSP 求解、匯出 GPX |
| **Page 2 — 演算法教學** | 七種演算法的動態圖解 + 可展開的數學公式/變數說明 |
| **Page 3 — DB 批量優化** | 解析 GPS Joystick Realm `.db`，原地重排座標並下載 |

---

### 2. 技術架構

```
best_gpx/
└── web_tsp_app/
    ├── index.html   — 三頁 SPA（Tab 切換，無框架）
    ├── app.js       — 全部前端邏輯 (~1900 行)
    │                  · Page 1 地圖互動 (Leaflet)
    │                  · Page 3 DB 解析與寫回
    │                  · TSP 演算法（同步 fallback 用）
    ├── index.css    — 樣式（Glassmorphism 設計語言）
    └── worker.js    — Web Worker：TSP 演算法（非同步主路徑）
```

**執行環境要求**：現代瀏覽器（ES2020+）、本機 HTTP 伺服器（避免 `file://` CORS 限制）。
**外部依賴**：僅 [Leaflet.js](https://leafletjs.com/)（地圖渲染）。

---

### 3. 演算法詳解

所有演算法使用 **Haversine 公式**計算球面距離：

```
a = sin²(Δφ/2) + cos φᵢ · cos φⱼ · sin²(Δλ/2)
d(i,j) = 2R · arctan2(√a, √(1−a))        R = 6,371,000 m
```

#### 基礎策略（產生初始路徑）

##### 1. 最近鄰居法 Nearest Neighbor — O(n²)

每步從未訪問集合 U 中選取距目前位置最近的點：

```
next = argmin_{j ∈ U} d(current, j)
```

- 優點：速度極快
- 缺點：末段常出現長跨越，品質通常比 Greedy 差 15–25%

##### 2. 貪婪法 Greedy — O(n² log n)

對所有 n(n−1)/2 條邊排序後依序嘗試加入，條件：

```
加入邊(i,j) ⟺ deg(i)<2 ∧ deg(j)<2 ∧ (|E|=n−1 ∨ ¬cycle(i,j))
```

- `deg(v)`：節點 v 目前已連接邊數（上限 2）
- `cycle(i,j)`：DFS 判斷是否提前形成封閉迴圈
- 排序是 O(n² log n) 的瓶頸，迴圈判斷每次 O(n)

##### 3. 插入法 Insertion — O(n²)

每輪將候選點 k 插入現有路徑中代價最小的位置：

```
Δ(i, k, j) = d(i,k) + d(k,j) − d(i,j)
pos* = argmin_{(i,j)∈T} Δ(i, k, j)
```

- 初始路徑 T = [0, 1, 0]，逐一插入 {2,…,n−1}
- 結果穩定，幾乎不出現嚴重交叉，適合作為 2-Opt 的高品質初始解

---

#### 優化方法（改進已有路徑）

##### A. 2-Opt — O(n²) / 每輪

枚舉所有不相鄰邊對 (i,j)，若反轉片段 T[i..j] 能縮短路徑則接受：

```
Δ = [d(t₁,t₃) + d(t₂,t₄)] − [d(t₁,t₂) + d(t₃,t₄)]
T' = T[0..i] + reverse(T[i..j]) + T[j..n]    （當 Δ < 0 時接受）
```

| 參數 | 值 |
|------|----|
| `maxIterations` | n × 100 |
| 改善門檻 | 新長度 < 舊長度 − 0.00001 m |
| 逾時檢查 | 每 O(n) 步（i-loop 頂端）|

##### B. Lin-Kernighan (L-K) — O(50 × n²)

以 **Double-Bridge Kick**（4-Opt 擾動）跳出 2-Opt 的局部最佳解：

```
T = A | B | C | D   （以隨機 p₁ < p₂ < p₃ 切割）
T' = A + D + C + B  （重組；等效於同時移除 4 條邊）

切割點範圍：
  p₁ ∈ [1,  n/4)
  p₂ ∈ [p₁+1, p₁+n/4)
  p₃ ∈ [p₂+1, p₂+n/4)
```

每次擾動後再執行完整 2-Opt 局部優化，共 50 輪。
n < 8 時退化為隨機 Swap 擾動。

##### C. 模擬退火 Simulated Annealing

以 Metropolis–Hastings 準則接受較差解，幾何降溫：

```
P(接受) = e^(−Δ/T)           Δ = L_new − L_current ≥ 0
T_{k+1} = α · T_k
總步數 K = ⌈log(T_min/T₀) / log(α)⌉ ≈ 1,840 輪
```

| 參數 | 值 |
|------|----|
| `T₀` | 10,000 |
| `α` (coolingRate) | 0.995 |
| `T_min` | 0.001 |
| `iterationsPerTemp` | min(n×2, 100) |

##### D. 基因演算法 Genetic Algorithm — O(generations × popSize × n)

```
適應度：f(T) = Σ_{i=0}^{n−1} d(T[i], T[(i+1) mod n])   （越小越好）

選擇：parent = scored[⌊r³ × popSize⌋]，r ~ Uniform(0,1)
      （r³ 使優秀個體被選中機率顯著偏高）

交叉：Order Crossover (OX)
      1. 複製 parent1 片段 T[start..end] 到 child
      2. 其餘位置依 parent2 順序填入未出現的基因
      3. 首尾節點固定不交叉
```

| 參數 | 值 |
|------|----|
| `popSize` | max(50, n×2) |
| `generations` | 200 |
| `mutationRate` | 0.1（Swap 突變） |
| Elitism | 每代保留最優 2 個 |

---

### 4. Realm DB 二進位解析

> Page 3 最具技術含量的部分。完全在瀏覽器端以 `ArrayBuffer` + `DataView` 操作 `.db` 二進位，**不需要 Realm SDK，不需要伺服器**。

GPS Joystick 所匯出的 `.db` 是一個 Realm 資料庫，內部採用 B-tree 式分頁結構。我們繞過 SDK，直接以位元組掃描的方式定位資料。

#### 節點識別碼（Magic Bytes）

所有關鍵節點都以 `0xAAAAAAAA`（4 bytes）作為前置識別碼。

| 節點型別 | 魔術序列 | 說明 |
|---------|---------|------|
| 路線名稱 | `AAAA + 0x11 + 0x00 + 0x00 + <len>` | 非對齊掃描，後接 UTF-8 字串 |
| Float64 葉節點 | `AAAA + 0x0C + 0x00 + 0x03 + 0xE8` | 8-byte 對齊，每節點 **1000** 個 float64 |
| 路線索引表 | `AAAA + 0x46` | 含 N 個 uint32 LE 偏移量（指向 0x05 節點） |
| 座標索引節點 | `AAAA + 0x05` | header = uint16 BE 點數，data = 點數個 uint16 LE 索引 |

#### Float64 座標的 Run 結構

座標按「Run」順序存放，三個 Run 的節點序列格式相同：

```
Run 0 → 所有路線的緯度  (latitude)
Run 1 → 所有路線的經度  (longitude)
Run 2 → 高度 / 速度      (elevation / speed)
```

每個 Float64 葉節點存放 1000 個 float64（GPS Joystick 每條路線上限即 1000 點）。
全局座標索引 `gi` 對應到葉節點與節點內偏移：

```
leafIdx   = Math.floor(gi / 1000)
posInLeaf = gi % 1000

// 讀取緯度：
lat = view.getFloat64(latRun[leafIdx] + 8 + posInLeaf * 8, true)  // LE
```

#### 路線索引結構（0x46 / 0x05）

這是名稱與座標一對一配對的關鍵：

```
0x46 節點
  └─ [offset₀, offset₁, …, offsetₙ]   (uint32 LE，共 N 個)
        │
        ▼（每個 offset 指向一個 0x05 節點）
     0x05 節點
       ├─ cnt        (uint16 BE) ← 這條路線的座標點數
       └─ [idx₀, idx₁, …, idx_{cnt-1}]  (uint16 LE) ← 全局座標索引
```

**尋找正確的 0x46 節點**：掃描所有 `AAAA+0x46`，取 `cnt == allDbNames.length` 的最後一個。

**Ring Buffer Wrap-Around 修正**：uint16 最大 65535，但實際座標池可超過此數。若連續索引出現跳躍（`idx[k] < idx[k-1]`），以 carry 計數修正溢位：

```javascript
if (raw < prev) carry += 0x10000;
globalIndex = carry + raw;
```

#### 寫回流程

優化完成後，將重排後的座標寫回原始 `ArrayBuffer`：

```javascript
view.setFloat64(latRun[leafIdx] + 8 + posInLeaf * 8, newLats[j], true);
view.setFloat64(lonRun[leafIdx] + 8 + posInLeaf * 8, newLons[j], true);
```

整個 `workBuf`（原始檔案的完整複本）以 `Blob` 包裝後觸發瀏覽器下載，**Realm 的其他結構位元組完全不受影響**。

---

### 5. Web Worker 並行架構

TSP 運算在 `worker.js` 中執行，避免阻塞主執行緒（UI 仍可更新）。

```
app.js (主執行緒)                    worker.js (Worker 執行緒)
─────────────────────────────────    ──────────────────────────────────
postMessage({                   ──▶  handleDbBatch({ routes, stratId,
  type: 'db-batch',                    optId, routeTimeoutMs })
  routes, stratId, optId,
  routeTimeoutMs                       for each route r:
})                                       points        = routes[r]
                                         routeDeadline = now + timeout
                                         origLen        = tourLength(origTour)
                                         tour           = runStrategy()
                                         tour           = runOptimizer(tour)
                                         newLen         = tourLength(tour)
                                   ◀──  postMessage({ type: 'db-route-done',
applyTour(origIdx, tour,                   idx: r, tour, origLen, newLen })
  doneCount, origLen, newLen)
                                   ◀──  postMessage({ type: 'db-batch-done' })
```

Worker 拋出例外時，主執行緒的 `onerror` 攔截後 fallback 至同步模式（適用於 `file://` 協定）。

#### 逾時機制

每條路線設定獨立的 `routeDeadline`（Unix ms）。逾時檢查嵌入在各優化演算法的 **O(n) 粒度**迴圈中，確保在 routeTimeoutMs 後能及時中止：

```javascript
// run2Opt 內層 i-loop 頂端（每 O(n) 步檢查一次）
for (let i = 1; i < bestTour.length - 1; i++) {
    if (Date.now() > routeDeadline) { improved = false; break; }
    // ...
}

// runGeneticAlgorithm 族群評估（每個體前檢查）
for (let pi = 0; pi < population.length; pi++) {
    if (Date.now() > routeDeadline) break;
    scored.push({ tour: population[pi], len: tourLength(...) });
}
```

---

### 6. 優化設定參數

Page 3 提供三個可調整的批量處理選項：

| 選項 | 預設 | 說明 |
|------|------|------|
| 略過超過 N 點的路線 | 256（可編輯） | 點數超過門檻的路線直接跳過，不執行 TSP |
| 單一路線逾時上限 | 3 分鐘 | 1m / 3m / 10m / 不限時 |
| 最低改善門檻 | 0% | 優化後若改善幅度未達門檻，不寫回座標 |

改善門檻計算：

```
improvement = max(0, (origLen − newLen) / origLen)
若 improvement ≥ threshold → 寫回；否則略過，原始座標不變
```

---

### 7. 本機執行

由於 Web Worker 在 `file://` 協定下受 CORS 限制，需啟動本機 HTTP 伺服器：

```bash
# Python 3
python -m http.server 8000

# 或 Node.js（需安裝 npx）
npx serve .
```

然後開啟 `http://localhost:8000/web_tsp_app/`。

---

### 8. 檔案結構

```
best_gpx/
├── README.md
├── data/
│   └── gpsjoystick_*.db          範例 Realm 資料庫（2 MB，576 條路線）
└── web_tsp_app/
    ├── index.html                 SPA 入口，三頁結構
    ├── app.js                     主邏輯
    │   ├── 頁面切換 / Tab 路由
    │   ├── Page 1：Leaflet 地圖、GPX 匯入/匯出、TSP 主流程
    │   ├── Page 3：Realm DB 解析（掃描、索引重建、座標定位）
    │   │          · 名稱掃描：0x11 節點非對齊掃描
    │   │          · 座標定位：0x0C+0x03E8 葉節點 8-byte 對齊
    │   │          · 路線索引：0x46/0x05 結構重建 + ring buffer carry
    │   │          · 寫回：DataView.setFloat64 原地注入
    │   └── 演算法（fallback）：NN / Greedy / Insertion / 2-Opt / LK / SA / GA
    ├── worker.js                  Web Worker
    │   ├── 相同演算法（主路徑）
    │   └── handleDbBatch：批量逐條路線優化 + 逾時控制
    └── index.css                  樣式（Glassmorphism + 動態圖解動畫）
```
