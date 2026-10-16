# 舒呼(SootheBreath) 呼吸復康訓練 — 實時呼吸視覺生物反饋系統 (PWA v4.0)

本專案係嚴格按照《舒呼 (SootheBreath) — 產品需求文件 (PRD v4.0) & AI Coding Blueprint (PWA)》構建的 Progressive Web App (PWA)，專為慢性阻塞性肺病 (COPD) 長者及復康醫護人員設計。正式版 v4 程式碼存放於 `v4/` 子資料夾內。

## 專案核心特色與演算法升級 (v4)
- **100% 本地端邊緣 AI 推論**：採用 `@mediapipe/tasks-vision@0.10.14` (ESM)，所有運算於瀏覽器 WebAssembly (WASM) 記憶體內完成，零影像傳輸與錄影。
- **三大核心臨床演算法升級**：
  1. **「起肩代償」演算法升級（軀幹穩定基準 + EMA 濾波平滑）**：
     - **EMA 座標平滑處理**：對雙肩座標（Pose Landmark 11, 12）套用指數移動平均濾波 `Y_smooth = alpha * Y_curr + (1 - alpha) * Y_prev`（`alpha = 0.35`），消除視訊高頻雜訊抖動。
     - **軀幹/耳肩相對基準定位（Torso Anchoring）**：計算雙肩相對於耳部（Pose Landmark 7 左耳、8 右耳）的垂直相對間距 `Dist_ear_shoulder = ((pose[11].y - pose[7].y) + (pose[12].y - pose[8].y)) / 2`，於 10 秒校準階段記錄 `Dist_base`，並以 `Delta_Y_relative = (Dist_base - Dist_curr) / D_eye > 0.12` 判定聳肩代償，排除長者深呼吸時身體前後晃動造成的誤判。
  2. **「鼻口呼吸 (PLB)」吸氣雙重聯合判定**：
     - **吸氣階段（閉口鼻吸）**：必須同時滿足 `LAR <= 0.06` 且 `faceBlendshapes.jawOpen < 0.05`，精準捕捉下頜下垂或咬合微張狀態。
     - **呼氣階段（噘唇吹氣）**：維持 `0.04 <= LAR <= 0.24` 且 (`mouthPucker >= 0.40` 或 `mouthFunnel >= 0.35`)。
  3. **呼氣階段彈性容錯與柔性過渡（Exhalation Soft Transition）**：
     - 當呼氣經過時間達目標呼氣時間 70% 以上（`phaseElapsed >= T_exhale_target * 0.70`）且期間有效噘唇時間良好，若長者自然放鬆唇形或閉口（`LAR < 0.04` 或 `mouthPucker < 0.25`），系統即判定為「合格呼氣完成」，不觸發提早中斷呼氣錯誤警示，並即刻平滑過渡進入下一次吸氣。
- **直覺化設定與顯示模式面板**：
  - **目標吸呼時間與呼吸頻率**：直接設定目標呼吸頻率 **BPM（範圍 20 至 5）** 及 **吸呼比例（1 : 2 或 1 : 3）**，系統自動換算吸氣與呼氣秒數；內建 **訓練總時長滑桿（1 至 10 分鐘）**。
  - **顯示模式**：
    - **呼吸引導顯示模式（雙重呼吸導引模式）**：支援「🎈 氣球模式」與「🧑 真人示範（👨 男性 / 👩 女性，不顯示 1/2/3/4 字樣）」。
    - **相機顯示模式（支援訓練中即時切換）**：
      1. `實時鏡像模式 Mirror mode`
      2. `去識別化骨架網格模式 privacy mesh mode`（深色畫布 `#0f172a` 隱藏五官與背景，僅呈現特徵點與耳肩骨架）
      3. `純引導模式 pure guiding mode`（自動收合左側視訊欄，將呼吸節奏球或真人示範全螢幕居中）
  - **廣東話 (zh-HK) 語音導航口令**：預設為開啟（Default ON），設定面板無需手動切換開關，具備 800ms 防閃爍時間窗與 4500ms 語音冷卻排程。
- **10 秒兩階段坐姿基準校準 + 確認機制**：前 7 秒收集基準，後 3 秒顯示「請確認位置」；倒數結束後提供「確認並開始訓練」、「重新校準」、「調整設定」三顆按鈕，並於訓練畫面右上角常駐「🔄 重校準」按鈕。
- **免鏡頭互動模擬模式**：無相機或權限受阻時，可一鍵進入模擬訓練預覽完整流程與匿名 CSV 臨床報表。

## 檔案目錄結構 (`v4/` 子資料夾)

- `v4/index.html`：主頁面結構（標題「舒呼(SootheBreath) 呼吸復康訓練」、四大視圖狀態、設定面板與調試抽屜）
- `v4/style.css`：輕柔療癒配色變數、呼吸節奏球動畫、真人示範淡入淡出與高對比度 UI 樣式
- `v4/app.js`：ESM 核心邏輯（MediaPipe Vision 0.10.14、EMA + 耳肩相對距離校準、吸氣雙重判定、呼氣 70% 柔性過渡、廣東話 TTS 與 CSV 匯出）
- `v4/manifest.json`：PWA 安裝配置 (`v4.1.0`)
- `v4/sw.js`：Service Worker 離線快取腳本 (`soothebreath-v4.1.0`)
- `v4/vercel.json`：Vercel 靜態部署設定
- `v4/1.jpg`, `v4/2.jpg`, `v4/3.jpg`, `v4/4.jpg`：真人示範模式實景圖片（男性吸/呼、女性吸/呼）
- `README.md` & `PRD`：專案與技術規格說明文件

## 本地測試與 Vercel / iPad PWA 部署指南

1. **本地端測試 (Local Testing)**：
   - 由於 WebRTC `getUserMedia` 需要 HTTPS 或 `localhost` 安全環境，請進入 `v4/` 資料夾使用 VS Code `Live Server` 或於終端機執行 `npx serve .` 後開啟 `http://localhost:3000`。
2. **Vercel 靜態部署**：
   - 將 `v4/` 資料夾推送至 GitHub 後匯入 Vercel，Framework Preset 選擇 `Other` 即可一鍵獲得 HTTPS 安全網址。
3. **iPad / 平板全螢幕 PWA 安裝**：
   - 使用 Safari 開啟部署網址，點擊「分享」→「加入主畫面」，即可從主畫面以全螢幕獨立應用程式模式啟動「舒呼(SootheBreath) 呼吸復康訓練」。
