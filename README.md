舒呼 (SootheBreath) 呼吸復康訓練 — 實時呼吸視覺生物反饋系統 (PWA v7.0 · v7_ES)
本資料夾 (v7_ES) 為基於 v6_ES ES6 模組化架構全面升級之 v7.0 正式版。在完整保留既有五步個人化動態基準校準、廣東話語音導航與匿名 CSV 匯出之基礎上，v7.0 完成校準頁面防遮擋、純引導模式 ~40% 視覺放大、面部訊號 EMA 抗抖動、連續模糊評分及訓練回饋邏輯升級。
a. 1. v7.0 核心升級與訓練邏輯調整總覽
● Task A — 校準頁面視訊框與控制/設定面板防遮擋修復 (STATE_CALIBRATING)：
○ 於 style.css 及 index.html 為 #calib-video-box 設定嚴格邊界 (min-width: 0, max-width: 100%, height: clamp(230px, 40vh, 360px), isolation: isolate, z-index: 1)，並為右側控制面板 (#calib-control-panel, z-index: 20) 與調試面板 (#debug-drawer, z-index: 100) 建立獨立圖層；進入五步校準總結確認面板時自動隱藏 #calib-video-box (calibration.js)。
● Task B — 純引導模式 (Pure Guiding Mode) 氣球與真人示範圖放大至佔訓練頁 ~40% (STATE_TRAINING)：
○ 於純引導模式下，透過 .pure-guiding-ring、.pure-guiding-ball 及 .pure-guiding-human 樣式 (style.css, training.js) 將呼吸節奏球外環與真人示範圖框放大至 clamp(250px, 40vmin, 420px)（配搭 min-h-[44vh] 視覺區）。
● Task C — 面部生物訊號抗抖動、連續模糊評分與臨床過渡機制升級 (state.js, cvEngine.js, calibration.js, training.js)：
b. 原始訊號 EMA 濾波 (smoothFacialSignalsEMA)：對 LAR (α=0.25)、jawOpen (α=0.25)、mouthPucker (α=0.30) 及 mouthFunnel (α=0.30) 進行指數移動平均濾波，並以濾波後數值計算 ΔLAR 與 ΔmouthPucker。
c. 連續模糊評分 (getInhaleScore & getExhaleScore)：由二元 true/false 升級為 0.0–1.0 連續浮點數評分。
d. 嚴格時間加權 (dt) 20 秒滾動時間窗：每幀記錄 { score, dt }，以 weightedScore = Σ(score_i * dt_i) / Σ(dt_i) 計算百分比。
e. 雙向 400ms 階段轉換緩衝期 (PHASE_ENTRY_GRACE_MS = 400)：吸氣與呼氣開始前 400ms 自動給予 score = 1.0，每個階段週期嚴格僅觸發一次。
f. 動作動量豁免機制 (applyActionMomentumExemption — Δ Trend Check)：當絕對分數 < 1.0 時，若吸氣階段嘴巴正主動閉合 (ΔLAR < 0) 或呼氣階段嘴唇正主動噘起 (ΔmouthPucker > 0)，將該幀分數豁免提升為 1.0。
g. 解決校準「峰值努力陷阱」(Peak Effort Trap — 70% 折扣)：mouthPuckerMin 訓練閾值固定設為 3 秒校準峰值之 70% (0.70)。
● 訓練回饋與卡片顯示邏輯調整 (Training Logic Adjustments 1–3 — training.js, feedback.js, state.js, index.html)：
h. 開局緩衝期預設顯示「統計中」：訓練開始前 10 秒開局緩衝期 (elapsedSeconds < INITIAL_GRACE_SECONDS)，四張生物反饋指示卡預設顯示 「統計中」（取代原本的 100%），且不觸發低分警示。
i. 二段式 80% 合格標準（移除卡片 70%–79% 分段）：刪除訓練頁面卡片原本的 70%–79%：持續保持 區間；凡 >= 80% (PASSING_SCORE_PCT = 80) 顯示 「合格達標」（綠色柔和樣式），凡 低於 80% (< 80%) 直接顯示「需要改善」（橙紅警示樣式，並直接納入警示排程）。
j. 連續 10 秒改善自動轉移提醒與「持續保持」狀態 (CONSECUTIVE_IMPROVE_SECONDS = 10.0)：當某項 < 80% 指標被鎖定提醒時，只要使用者於該項目連續 10 秒展現改善技巧（consecutiveImprovedSec >= 10.0）或百分比回升至 >= 80%，系統即解除該項目鎖定並自動轉移提醒其他 < 80% 的「需要改善」項目；若所有其他項目均 >= 80%，底部橫幅與語音即顯示及播報 「持續保持」。
2. ES6 模組化檔案結構與 AI 維護導航表 (v7_ES/)
檔案名稱
行數
核心職責與匯出項目 (Exports)
index.html
1,093 行
主頁面結構（含開局「統計中」預設卡片、校準防遮擋佈局、純引導模式 ~40% 容器及 <script type="module" src="./app.js?v=7.0">）
style.css
269 行
輕柔療癒配色、校準視訊框嚴格邊界控制 (#calib-video-box) 及純引導模式 ~40% 放大樣式 (.pure-guiding-ring, .pure-guiding-ball, .pure-guiding-human)
app.js
61 行
ES6 啟動入口 (bootstrapApp) 與全模組 Barrel Re-exports
state.js

系統常數、THRESHOLDS、PASSING_SCORE_PCT = 80、CONSECUTIVE_IMPROVE_SECONDS = 10.0、PHASE_ENTRY_GRACE_MS = 400、ema() 與 AppState
dom.js

152 個 DOM 元素快取參照 (dom, cacheDomElements, 含 calibVideoBox) 與 showToast
vision.js

@mediapipe/tasks-vision@0.10.14 ESM 模型載入與 Face/Pose Landmarker 初始化
camera.js

WebRTC 相機串流管理 (startCamera, stopCamera) 與硬體/權限診斷彈窗 (showCameraDiagnosticError)
cvEngine.js

面部 EMA 濾波與動量計算 (smoothFacialSignalsEMA)、連續模糊評分 (getInhaleScore, getExhaleScore)、動作動量豁免 (applyActionMomentumExemption)
tts.js

廣東話 (zh-HK) Web Speech API 語音導航引擎 (initTTS, speakText)
feedback.js

< 80% 最低分優先鎖定、連續 10 秒改善自動轉移提醒與「持續保持」回饋引擎 (evaluateStickyPriorityFeedback)
calibration.js

五步個人化動態基準校準、視訊框防遮擋切換、EMA 即時預覽與 70% 峰值努力折扣動態閾值計算
training.js

實時訓練主迴圈、開局 10 秒「統計中」緩衝、二段式 80% 卡片樣式 (applyModuleCardStyle) 與各模組連續改善秒數計時 (consecutiveImprovedSec)
summary.js

訓練總結報告生成 (renderSummaryReport)、去識別化 CSV 匯出 (exportDeidentifiedCSV) 與本機歷史紀錄
uiControls.js

狀態機切換 (switchViewState)、臨床演算法調試面板 (updateDebugReadouts) 與全域 UI 事件監聽器
sw.js / manifest.json / vercel.json

PWA v7.0 離線快取與靜態部署設定，搭配真人示範圖檔 1.jpg–4.jpg
