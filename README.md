# BreathGuide COPD — 實時噘唇呼吸視覺生物反饋系統 (PWA)


本專案係嚴格按照《BreathGuide COPD - PRD & AI Coding Blueprint (PWA)》第 0 至第 7 節規格構建的 Progressive Web App (PWA)。


## 專案核心特色
- **100% 本地端邊緣 AI 推論**：採用 `@mediapipe/tasks-vision@0.10.14` (ESM)，所有運算於瀏覽器 WebAssembly (WASM) 記憶體內完成，零影像傳輸。
- **三種視覺私隱模式**：
  1. 實時鏡像 + AR 輔助框 (Mirror Mode)
  2. 去識別化黑底骨架網格模式 (Privacy Mesh Mode, 畫布塗黑 #0f172a，僅呈現特徵點與骨架)
  3. 純呼吸節奏球模式 (Minimalist Pacer Mode)
- **臨床指標即時運算**：
  - 雙眼外眥間距 ($D_{eye}$) 標準化與 3 秒坐姿基準校準
  - 嘴唇開合長寬比 (LAR) 及 Blendshapes (`mouthPucker` / `mouthFunnel`) 縮唇識別
  - 雙肩垂直位移 ($\Delta Y_{shoulder}$) 輔助肌聳肩代償監測
  - 吸呼比 (I:E Ratio) 狀態機與防閃爍 (800ms) 廣東話語音導航
- **多平台支援**：Windows / macOS Laptop、iPad Safari（「加入主畫面」全螢幕 PWA）及 Android 平板。


---


## 檔案目錄結構 (File Structure)


```text
breathguide-copd/
├── index.html        # 主頁面結構 (Tailwind CSS, View States, Debug Drawer)
├── style.css         # 呼吸節奏球動畫、Canvas 鏡像與高對比度 UI 樣式
├── css/
│   └── style.css     # (備用副本，同時支援子目錄引入)
├── app.js            # ESM Core: MediaPipe Vision, Calibration, Math, TTS
├── js/
│   └── app.js        # (備用副本，同時支援子目錄引入)
├── manifest.json     # PWA 配置 (Standalone, Landscape Orientation)
├── sw.js             # Service Worker 離線快取腳本
├── vercel.json       # Vercel 部署設定
└── README.md         # 部署與使用說明文件
```


---


## 本地測試與 GitHub + Vercel 部署指南


### 1. 本地端測試 (Local Testing)
由於鏡頭 WebRTC `getUserMedia` 需要 HTTPS 或 localhost 環境，請勿直接以 `file://` 開啟 HTML：
- **方法 A (VS Code)**：安裝 `Live Server` 擴充套件，右鍵 `index.html` 點選 **Open with Live Server**。
- **方法 B (Node.js)**：在終端機進入專案目錄，執行：
  ```bash
  npx serve .
  ```
  然後瀏覽器開啟 `http://localhost:3000`。


### 2. 推送至 GitHub
1. 在 GitHub 上建立一個新的公開或私有 Repository（例如 `breathguide-copd-pwa`）。
2. 在本地專案資料夾執行：
   ```bash
   git init
   git add .
   git commit -m "feat: complete BreathGuide COPD PWA implementation"
   git branch -M main
   git remote add origin https://github.com/<你的用戶名>/<專案名稱>.git
   git push -u origin main
   ```


### 3. 一鍵部署至 Vercel
1. 登入 [Vercel](https://vercel.com/)。
2. 點擊 **Add New Project**，並匯入方才推送的 GitHub Repository。
3. **Framework Preset** 選擇 **Other**（純靜態網站）。
4. 點擊 **Deploy**，約 30 秒即可獲得專屬 HTTPS 安全網址。


### 4. iPad / 平板全螢幕 PWA 設定
1. 使用 iPad Safari 開啟 Vercel 部署生成的 HTTPS 網址。
2. 點擊右上角或下方的 **「分享 (Share)」** 按鈕。
3. 選擇 **「加入主畫面 (Add to Home Screen)」**。
4. 在桌面點擊 BreathGuide 圖示開啟，即可體驗無網址列干擾的專業全螢幕臨床訓練介面！