# **舒呼 (SootheBreath) 呼吸復康訓練 — 實時呼吸視覺生物反饋系統 (PWA v9)**

本資料夾 ([v9](https://drive.google.com/drive/folders/1tqYcEjma60Bgb-jVfZDgB8cp5N8aygEY)) 為基於 [v8\_ES](https://drive.google.com/drive/folders/1QCqTV2nkx0aIcjJ8tZAwjKaAQlr638xF) ES6 模組化架構全面升級之 **v9 正式版**。在 100% 完整保留五步個人化動態基準校準（視訊前置毛玻璃遮罩與固定尺寸面板）、面部特徵 EMA 抗抖動濾波、P0.4 連續模糊評分 (`frameScore` 0.0–1.0)、全程累計時間百分比 (`Percentage = (Σ validTime / Σ totalTime) * 100`)、階段結束 (`>50%` 錯誤率) 評估、連續兩次失敗排程與兩次合格解鎖 ([scoring.js](https://drive.google.com/file/d/1XOFNp31XGF5dmuVHJdMzkPzSl1a4-jCm/view?usp=drivesdk))、廣東話語音導航與匿名 CSV 匯出之基礎上，v9 新增 **底部版本備註 (v9)** 及 **3D 互動模式 (`互動模式` — 微風風車 Pinwheel / 蒲公英 Dandelion，[interactive3d.js](https://drive.google.com/file/d/1i2ye4a-7vhuhK9aa7FGNOf5bVrjKf--U/view?usp=drivesdk))**。

# **1\. v9 核心升級總覽 (What's New in v9)**

## **A. 應用程式底部版本編號備註 (`#app-version-footer` — [index.html](https://drive.google.com/file/d/1fCix0WQ6ZiL3PLA_6C5xCFynHa921zE_/view?usp=drivesdk))**

* 於應用程式底部新增全域版本備註欄 (`#app-version-footer`)：`舒呼 (SootheBreath) 呼吸復康訓練系統 · 版本備註 (Version)：v9`，並同步更新頂部導航欄標籤為 `PWA v9`。

## **B. 新增 3D 互動模式 (`互動模式` · 風車 Pinwheel / 蒲公英 Dandelion — [interactive3d.js](https://drive.google.com/file/d/1i2ye4a-7vhuhK9aa7FGNOf5bVrjKf--U/view?usp=drivesdk), [training.js](https://drive.google.com/file/d/1DwOv0z_blXpGM2EtwXhg1nCVN4x9M04f/view?usp=drivesdk), [uiControls.js](https://drive.google.com/file/d/1Osj9ObVv7xP5dPFWQUCGgsjBQ3W_7ZKi/view?usp=drivesdk), [index.html](https://drive.google.com/file/d/1fCix0WQ6ZiL3PLA_6C5xCFynHa921zE_/view?usp=drivesdk), [style.css](https://drive.google.com/file/d/1J0ZkRvWXDtL-WeP_oJ9nsQ21RWRhqhbL/view?usp=drivesdk))**

1. **主頁面 (`STATE_IDLE`) 與訓練頁面 (`STATE_TRAINING`) 雙向支援選擇「互動模式」**：  
   * **主頁面 (`STATE_IDLE`)**：於「呼吸引導顯示模式」新增 `🎡 互動模式` 按鈕 (`#btn-pacer-interactive`)，點選後展開 `🌈 風車 Pinwheel` (`#btn-interactive-pinwheel`) 與 `🌼 蒲公英 Dandelion` (`#btn-interactive-dandelion`) 子主題選擇器；同時於「相機顯示模式」下拉選單 (`#select-privacy-mode`) 新增 `互動模式 Interactive Mode (風車 / 蒲公英)` 選項。  
   * **訓練頁面 (`STATE_TRAINING`)**：於頂部導航列新增 `🎡 互動模式 Interactive Mode` (`#btn-mode-interactive`) 與 `🎡 互動模式` (`#btn-train-interactive`) 按鈕，並於 3D 互動舞台頂部 HUD 提供 `🌈 風車 Pinwheel` (`#mode-pinwheel-btn`)、`🌼 蒲公英 Dandelion` (`#mode-dandelion-btn`) 即時切換與 `柔和音樂：開啟/靜音` (`#music-toggle-btn`) 控制。  
2. **版面配置與「純引導模式 (Pure Guiding Mode)」完全一致**：  
   * 進入「互動模式」時，自動收合左側視訊欄 (`#vision-container`) 並將中央引導面板 (`#guidance-panel`) 擴展為全寬單欄置中佈局 (`.pure-guiding-mode`)，同時背景 `<video id="train-video">` 持續執行 MediaPipe 本地端推論，下方完整呈現四張實時百分比生物反饋指示卡與底部橫幅。  
3. **動作分析觸發吹風邏輯 (Motion-Analysis Blowing Trigger — 取代手動按住按鈕)**：  
   * 移除原本 3D 檔案中需要手動長按滑鼠/觸控或空白鍵的按鍵事件，改由 [training.js](https://drive.google.com/file/d/1DwOv0z_blXpGM2EtwXhg1nCVN4x9M04f/view?usp=drivesdk) 之即時動作分析驅動：  
     * **開始吹風 (`startInteractiveBlowing`)**：當使用者於吸氣階段成功達成「合口鼻吸氣 \+ 無聳肩代償」(`inhaleQualifiedForBlow === true`)，並於進入呼氣階段後成功以「噘唇動作」開始呼氣 (`isPursedLipExhaleInitiated && isShoulderRelaxed`) 時，系統自動視為「開始吹風（按住吹風按鈕不放）」，驅動 3D 風車均速加速旋轉或 3D 蒲公英種子隨風飄散。  
     * **停止吹風 (`stopInteractiveBlowing`)**：當使用者完成該次噘唇呼氣並切換回吸氣階段 (`EXHALE -> INHALE`) 時，系統自動視為「停止吹風（放開吹風按鈕）」，讓 3D 風車平滑減速停下或讓 3D 蒲公英絨毛種子平滑重新長出。  
4. **離開「互動模式」自動清除 Three.js 資源 (Memory Leak Prevention)**：  
   * 當使用者於訓練頁切換離開「互動模式」（例如切換至實時鏡像模式、去識別化骨架網格模式、純引導模式、氣球模式或真人示範）或離開訓練頁面 (`switchViewState`) 時，系統自動呼叫 `disposeInteractive3D()`，徹底釋放所有 Three.js `BufferGeometry`、`Material`、`CanvasTexture`、`WebGLRenderer` Context (`forceContextLoss()`)、`requestAnimationFrame` 及 Web Audio `AudioContext` 資源，確保零記憶體洩漏 (Zero Memory Leak)。

# **2\. ES6 模組化檔案結構與 AI 維護導航表 (`v9/`)**

| 檔案名稱 | 核心職責與匯出項目 (Exports) |
| :---- | :---- |
| [index.html](https://drive.google.com/file/d/1fCix0WQ6ZiL3PLA_6C5xCFynHa921zE_/view?usp=drivesdk) | 主頁面與訓練頁面結構（含 `#interactive-3d-wrapper` 3D 舞台、主頁面與訓練頁互動模式切換器、底部 `#app-version-footer` 版本 `v9` 備註） |
| [style.css](https://drive.google.com/file/d/1J0ZkRvWXDtL-WeP_oJ9nsQ21RWRhqhbL/view?usp=drivesdk) | 輕柔療癒配色、校準視訊毛玻璃過渡、純引導模式放大樣式及 v9 3D 互動模式樣式 (`#interactive-3d-stage`, `.bg-pinwheel`, `.bg-dandelion`, `.glass-pill`, `.spin-btn`) |
| [app.js](https://drive.google.com/file/d/1ddcZ-BfMrN_2oKNUJBKjSqHDtS_Te9X7/view?usp=drivesdk) | ES6 啟動入口 (`bootstrapApp`) 與全 14 模組 Barrel Re-exports（含 `interactive3d.js` 與 `scoring.js`） |
| [interactive3d.js](https://drive.google.com/file/d/1i2ye4a-7vhuhK9aa7FGNOf5bVrjKf--U/view?usp=drivesdk) | **v9 新增 3D 互動模式核心模組**：`initInteractive3D`, `disposeInteractive3D`, `switchInteractiveObjectMode`, `startInteractiveBlowing`, `stopInteractiveBlowing`, `stepInteractivePhysics`, `toggleInteractiveAudioMute`, `getInteractive3DStats` |
| [state.js](https://drive.google.com/file/d/1CHz2vGXR2YMqlOPLg3K06QqpwozmfBT2/view?usp=drivesdk) | 系統常數、`THRESHOLDS`、`AppState`（新增 `interactiveObject`, `inhaleQualifiedForBlow`, `isInteractiveBlowing` 等互動模式狀態欄位） |
| [dom.js](https://drive.google.com/file/d/13n3DLbMOOxXzptKsPlb0U2FYozVhx_Mw/view?usp=drivesdk) | 180 個 DOM 元素快取參照 (`dom`, `cacheDomElements`, 含 3D 互動舞台與底部 `v9` 版本列) 與 `showToast` |
| [scoring.js](https://drive.google.com/file/d/1XOFNp31XGF5dmuVHJdMzkPzSl1a4-jCm/view?usp=drivesdk) | 全程累計時間百分比運算 (`accumulateFrameScore`)、階段結束評估 (`evaluateCompletedPhase`) 與連續失敗排程引擎 (`getHighestPriorityAlert`) |
| [feedback.js](https://drive.google.com/file/d/1ABoDiYWhdpmG5L4ej0zW4wEkM1unNoho/view?usp=drivesdk) | 底部橫幅與廣東話語音綁定引擎 (`evaluateStickyPriorityFeedback`, 支援琥珀紅警示橫幅與 `✅ 做得非常好，繼續保持！` 綠色成功橫幅) |
| [calibration.js](https://drive.google.com/file/d/1YPrzkn0-ZeT30hEQKGjK0cUaBBKJfpBA/view?usp=drivesdk) | 五步個人化動態基準校準、視訊前置毛玻璃遮罩切換與 70% 峰值努力折扣閾值計算 |
| [training.js](https://drive.google.com/file/d/1DwOv0z_blXpGM2EtwXhg1nCVN4x9M04f/view?usp=drivesdk) | 實時訓練主迴圈、動作分析觸發 3D 吹風 (`startInteractiveBlowing` / `stopInteractiveBlowing`)、單欄純引導/互動版面切換與累計時間百分比渲染 |
| [cvEngine.js](https://drive.google.com/file/d/13M0-OObK76PqAtNaxG8dOtP7NH-mXMW2/view?usp=drivesdk) | 面部 EMA 濾波 (`smoothFacialSignalsEMA`)、P0.4 連續模糊評分 (`getInhaleScore`, `getExhaleScore`)、動作動量豁免與耳肩代償偵測 |
| [vision.js](https://drive.google.com/file/d/1-5o-FYWKzh9pl8kEcPJ5lJVA1vKhQoeG/view?usp=drivesdk) | `@mediapipe/tasks-vision@0.10.14` ESM 模型載入與 Face/Pose Landmarker 初始化 |
| [camera.js](https://drive.google.com/file/d/1gW4wxBK7ElSEUWIduTPvtor1RSV3P8Ew/view?usp=drivesdk) | WebRTC 相機串流管理與 6 大臨床相機錯誤診斷彈窗 |
| [tts.js](https://drive.google.com/file/d/1hBKSXcVO1crmI3p_qq34OkBpeNaEdYEB/view?usp=drivesdk) | 廣東話 (`zh-HK`) Web Speech API 語音合成 (`initTTS`, `speakText`) |
| [summary.js](https://drive.google.com/file/d/1e66twFmeMx3BunVpGMwknI6eqtRV3H96/view?usp=drivesdk) | 訓練總結報告 (`renderSummaryReport`)、去識別化 CSV 匯出與本機歷史紀錄 |
| [uiControls.js](https://drive.google.com/file/d/1Osj9ObVv7xP5dPFWQUCGgsjBQ3W_7ZKi/view?usp=drivesdk) | 狀態機切換 (`switchViewState`)、互動模式切換 (`activateInteractiveMode`)、Three.js 資源釋放掛鉤與全域事件綁定 |
| [sw.js](https://drive.google.com/file/d/14uTVwx6wC0xJb31YqaU5pg9nMDfGFXtp/view?usp=drivesdk), [manifest.json](https://drive.google.com/file/d/1VoorgTsHZFZWLlUd2DwDidrj84bxaxlP/view?usp=drivesdk), [vercel.json](https://drive.google.com/file/d/12C9eL-QPU1xblRE5Ihav8H97W9TzXpBW/view?usp=drivesdk) | PWA 離線快取 (`soothebreath-v9.0.0`)、安裝資訊清單與靜態部署設定 |
| [1.jpg](https://drive.google.com/file/d/1CfF3eap44IFY3pY-tobtyk11rrAudeZ6/view?usp=drivesdk), [2.jpg](https://drive.google.com/file/d/1UHQwDz4oNzfmaEVfFtc6vfhl2_BCNZLi/view?usp=drivesdk), [3.jpg](https://drive.google.com/file/d/1KyLVln5cwPhiDFrKEvK8Wh-7-CATlpZN/view?usp=drivesdk), [4.jpg](https://drive.google.com/file/d/1jF68RQfgargyVrIEhdFEUJTcscnjS_wB/view?usp=drivesdk) | 真人示範模式男/女性吸氣與呼氣實景圖 |
| [舒呼 (SootheBreath) — 產品需求文件 (PRD v9.0) & AI Coding Blueprint (PWA)](https://docs.google.com/document/d/1fgcW4mlTU97boviBF2LKLKdNf2v_ARN_wXjtrzQDwTQ/edit) | 完整產品需求規格書與 AI 模組化編碼藍圖 (PRD v9.0) |
| [舒呼 (SootheBreath) — v9.0 版本更新報告 (Version Update Report)](https://docs.google.com/document/d/1skV9dZu19xkJRo2FZlq3Rmiglq92j_24AmNjKJk-uu0/edit) | v9.0 升級項目、技術實作細節與端到端自動化驗證報告 |

