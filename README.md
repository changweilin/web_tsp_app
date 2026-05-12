# Web TSP Optimizer

## 1. 專案標題與簡介 (Title & Description)

Web TSP Optimizer 是一個「純前端」的 TSP 路線最佳化 Web App，完整使用瀏覽器端執行，不需要後端服務，主要有兩種作業模式：

1. 在互動地圖上建立或匯入 GPX 點位，執行不同策略組合，計算更短的巡迴路徑。
2. 匯入 GPS Joystick 匯出的 Realm `.db`，在不連接資料庫 SDK 的情況下直接解析二進位結構並回寫最佳化結果。

整體使用 Leaflet 地圖、Web Worker 及本機端檔案儲存流程，適合用於路線規劃、運動訓練軌跡整理、跨軌路徑優化驗證。

## 2. 核心功能特性 (Features)

- 三頁式單頁應用：路徑規劃、演算法教學、Realm DB 批次最佳化。
- 地圖互動流程：手動點擊/拖曳新增節點、刪除節點、插入節點，中途可即時預覽。
- 多種基礎策略：Nearest Neighbor、Greedy、Insertion。
- 多種優化策略：2-Opt、Lin-Kernighan、Simulated Annealing、Genetic Algorithm。
- 主題切換：深色與淺色主題，並保留使用者偏好。
- 匯入匯出：支援 GPX 上傳，輸出 GPX、KML、GeoJSON。
- DB 解析與回寫：支援 `.db` 檔的坐標區塊重排與輸出。
- 進階控制：DB 模式可設定路徑長度上限、逾時、最低改善門檻，並可選擇匯出 GPX。
- 即時回饋：支援進度條、每筆日誌、toast 提示。
- RWD 介面：支援桌機與行動裝置瀏覽與操作。

## 3. 系統需求與安裝步驟 (Prerequisites & Installation)

### 3.1 系統需求

- 現代瀏覽器（建議 Chrome / Edge / Firefox / Safari 最新版）。
- 支援 Web Worker。
- 可用本機 HTTP Server（Python 3、Node.js 或 PHP）。

### 3.2 安裝與啟動

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

開啟瀏覽器輸入：

```bash
http://127.0.0.1:8000/
```

> 注意：建議避免使用 `file://` 直接開啟，因為 Worker 與某些本機檔案操作在該協定下會受限。

## 4. 快速上手與使用範例 (Quick Start / Usage)

### 4.1 路徑規劃頁（Page 1）

1. 進入頁面後先確認左側控制面板有可用策略。
2. 點擊地圖空白處加入節點，或按「Load GPX」匯入 `.gpx`。
3. 勾選想要比較的策略（例如 NN、Greedy）和優化方法（例如 2-Opt）。
4. 按「開始計算」，稍候後在地圖上看到結果路徑。
5. 點「Export」可選 GPX / KML / GeoJSON 輸出。

### 4.2 演算法教學頁（Page 2）

1. 切到教學頁檢視 7 種策略說明。
2. 展開每張卡片觀看公式與參數。
3. 依實際需求回到第一頁，調整策略組合重跑。

### 4.3 DB 批次最佳化頁（Page 3）

1. 切到第三頁並拖放 `.db` 檔。
2. 選擇基礎策略與優化方法，設定逾時秒數與改善門檻。
3. 按「開始最佳化」。
4. 完成後下載產物 ZIP，內含最佳化後 `.db`，以及可選 GPX 資料。

## 5. 專案架構說明 (Project Structure)

```text
web_tsp_app/
  ├─ .gitattributes
  ├─ index.html
  ├─ app.js
  ├─ worker.js
  ├─ index.css
  ├─ README.md
  └─ assets/
      └─ readme/
          ├─ tsp-city-desktop.png
          └─ tsp-city-mobile.png
```

### 5.1 主要原始碼檔角色

- `index.html`：主頁面與三個功能頁籤、外部資源引入。
- `app.js`：主執行邏輯，負責 UI 事件、地圖互動、GPX 解析、演算法呼叫、路線繪製、進度與輸出。
- `worker.js`：Web Worker 計算核心，承擔 TSP 計算與 DB 批次流程，避免阻塞主執行緒。
- `index.css`：樣式、主題變數、地圖控制項、RWD 斷點與動畫。
- `assets/readme/*`：README 及展示用素材。
- `.gitattributes`：版本控制文字檔案的換行正規化設定。

### 5.2 設定檔與外部依賴

- 目前專案沒有 `package.json`，不需要安裝 Node 依賴。
- 透過 CDN 載入：Leaflet 1.9.4 及 JSZip 3.10.1。
- 啟動方式採本地靜態伺服器。

## 6. 授權條款 (License)

本專案採用 **Apache License 2.0**。

- 商用、修改、散佈、再發佈皆受條款允許。
- 需保留授權聲明與版權標示。
- 你可將完整授權條文放在 `LICENSE` 檔案，建議參考：
  - https://www.apache.org/licenses/LICENSE-2.0
