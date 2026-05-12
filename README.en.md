# Web TSP Optimizer

## 1. Title & Description

Web TSP Optimizer is a browser-based frontend application that helps solve route optimization problems directly in your browser without a backend server. It supports two main workflows:

1. Build or import point sets on an interactive map and compute optimized TSP routes.
2. Parse and optimize GPS Joystick Realm `.db` files directly in-browser and export reordered binary outputs.

The app is implemented with Leaflet, Web Workers, and local file processing, and includes a complete workflow for visualizing, tuning, and exporting route results.

## 2. Key Features

- Three-page SPA: Route Planner, Algorithm Tutorial, Realm DB Batch Optimizer.
- Map interaction: add/delete/insert points by click, drag, and context controls.
- Theme support: light/dark mode with persisted user preference.
- Baseline strategies: Nearest Neighbor, Greedy, Insertion.
- Optimization methods: 2-Opt, Lin-Kernighan, Simulated Annealing, Genetic Algorithm.
- Multi-strategy visualization: compare route variants in the same session.
- Import/export: GPX input and GPX/KML/GeoJSON output.
- Realm DB batch optimization: parse DB structures and rewrite optimized coordinate sequences.
- Progress and diagnostics: per-route status updates, timeout handling, and improvement threshold controls.
- Responsive layout: works on desktop and mobile.

## 3. Prerequisites & Installation

### 3.1 Prerequisites

- Modern browser (Chrome / Edge / Firefox / Safari).
- Web Worker support.
- A local static file server available (Python 3, Node.js, or PHP).
- Git (optional, for cloning the repository).

### 3.2 Setup and run

```bash
git clone <your-repo-url>
cd web_tsp_app
```

```bash
python -m http.server 8000
```

```bash
npx serve .
```

```bash
php -S 127.0.0.1:8000
```

Open in browser:

```bash
http://127.0.0.1:8000/
```

> Tip: Running via `file://` is not recommended because Worker and local file behavior may be restricted.

## 4. Quick Start / Usage

### 4.1 Route Planner (Page 1)

1. Open the app and switch to Route Planner.
2. Add waypoints on the map or click `Load GPX` to import a file.
3. Select baseline strategies and optimization options.
4. Click `Start` to compute routes.
5. Export GPX/KML/GeoJSON from the export menu.

### 4.2 Algorithm Tutorial (Page 2)

1. Open the tutorial page.
2. Review animations and formulas for NN, Greedy, Insertion, 2-Opt, L-K, SA, and GA.
3. Return to Page 1 and run the most suitable strategy set.

### 4.3 DB Optimizer (Page 3)

1. Open Page 3 and upload one or more `.db` files.
2. Choose route strategy, optimizer, timeout, and improvement threshold.
3. Click `Start Optimization`.
4. Download the generated ZIP containing optimized `.db` and optional GPX outputs.

## 5. Project Structure

```text
web_tsp_app/
  ├─ .gitattributes
  ├─ index.html
  ├─ app.js
  ├─ worker.js
  ├─ index.css
  ├─ README.md
  ├─ README.en.md
  └─ assets/
      └─ readme/
          ├─ tsp-city-desktop.png
          └─ tsp-city-mobile.png
```

### 5.1 Core source files

- `index.html`: Entry page, tab structure, external script/style references.
- `app.js`: Main UI logic, map interactions, route calculations, GPX import/export handling.
- `worker.js`: Web Worker implementation for CPU-heavy TSP and DB batch optimization.
- `index.css`: Theme, layout, responsive styles, animation and map control styling.
- `assets/readme/*`: README demo screenshots.
- `.gitattributes`: Git text normalization settings.

### 5.2 Configuration and dependencies

- No `package.json` and no build chain are included.
- External CDN dependencies:
  - Leaflet 1.9.4
  - JSZip 3.10.1
- Served as a static web app.

## 6. License

This project is licensed under the **Apache License 2.0**.

- You may use, modify, distribute, and integrate this project under the terms of the license.
- Keep attribution and license notice in derivative works.
- Official text:
  https://www.apache.org/licenses/LICENSE-2.0
