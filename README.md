# **舒呼 (SootheBreath) 呼吸復康訓練 — 實時呼吸視覺生物反饋系統 (PWA v9.1 · 60 FPS 高效能優化版)**

本資料夾 ([v9.1](https://drive.google.com/drive/folders/1NTxpDN3dtGxNRc4almg5agLgjA7bRkGR)) 為基於 [v9](https://drive.google.com/drive/folders/1tqYcEjma60Bgb-jVfZDgB8cp5N8aygEY) 進行 P0 至 P2 全方位 60 FPS 效能優化 之正式版本。在 100% 保留五步個人化動態基準校準、面部 EMA 濾波、P0.4 連續模糊評分、全程累計時間百分比與階段結束排程 ([scoring.js](https://drive.google.com/file/d/1MezjPROCMrBNclHtOUSl8co8z37Ww-cE/view?usp=drivesdk))、3D 互動模式（微風風車 Pinwheel / 蒲公英 Dandelion）動作感測吹風與自動記憶體清理之基礎上，徹底解決互動模式卡頓 (Lag) 問題。

# **1\. v9.1 核心效能優化總覽 (P0 – P2 Performance Optimizations)**

## **P0-1. 單一主迴圈整合 \+ MediaPipe 20Hz 單雙幀交錯推論 ([training.js](https://drive.google.com/file/d/1g31fIf4Powz5A71Sh2IFR1qxySuCbssE/view?usp=drivesdk), [interactive3d.js](https://drive.google.com/file/d/1-yDwucrE81_PgtHnfcx-PR0JPQfXM64d/view?usp=drivesdk), [state.js](https://drive.google.com/file/d/130oo8gtSXGclBg-hCs0C3iGSY9yEJml6/view?usp=drivesdk))**

* **消除雙重 `requestAnimationFrame` 競爭**：移除 `interactive3d.js` 內部獨立運行的第二個 `requestAnimationFrame` 迴圈，改為匯出 `renderInteractive3DFrame(dt)` 由 `trainingInferenceLoop()` 單一 60 FPS 主迴圈統一驅動。  
* **AI 推論降頻與單雙幀交錯 (`INFERENCE_INTERVAL_MS = 50`)**：將 MediaPipe 推論頻率設為每 `50ms`（20 FPS），並於互動模式下單數推論幀執行 `FaceLandmarker`、雙數推論幀執行 `PoseLandmarker`，主執行緒與 GPU 推論負載降低 **\>65%**。

## **P0-2. 蒲公英零動態記憶體配置物件池與 Draw Calls 大幅精簡 ([interactive3d.js](https://drive.google.com/file/d/1-yDwucrE81_PgtHnfcx-PR0JPQfXM64d/view?usp=drivesdk))**

* **零動態配置原位飛行 (Zero-Allocation In-Place Flight)**：徹底廢除吹氣時每幀 `new THREE.Group()` / `new THREE.Mesh()` 建立新飛行種子之 `spawnFlyingSeed()`；當種子被吹離時，直接將蒲公英頭上原有的 `s.mesh` 標記為 `isFlying = true` 原位飛出，吸氣重生時原位復原至 `(homeX, homeY, homeZ)`，飛行期間動態記憶體配置降為 **0**，完全消除 Garbage Collection (GC) 卡頓。  
* **精簡種子數與單一高飽滿度 Sprite (`TOTAL_SEEDS = 128`)**：將種子數由 260 精簡至 128 粒，並將每粒種子合併為單一高飽滿度絨毛 `Sprite` (`scale = 0.78`)，視覺飽滿度不變，但 Draw Calls 與 Scene Graph 節點減少 **\>72%**。

## **P1-1. 移除 WebGL 舞台上之實時 CSS 高斯模糊濾鏡 ([style.css](https://drive.google.com/file/d/1EMjpX0H3krM583e2vj36PDeOx7B8T5G_/view?usp=drivesdk), [interactive3d.js](https://drive.google.com/file/d/1-yDwucrE81_PgtHnfcx-PR0JPQfXM64d/view?usp=drivesdk))**

* **預烘焙淺景深草地背景 (`#bg-dof-canvas`)**：於初始化時直接以 `160×120` 低解析度多段漸層烘焙柔和淺景深草地，移除 [style.css](https://drive.google.com/file/d/1EMjpX0H3krM583e2vj36PDeOx7B8T5G_/view?usp=drivesdk) 內昂貴的實時 `filter: blur(22px) saturate(1.15)`。  
* **移除 WebGL 上方 `.glass-pill` 之 `backdrop-filter: blur(16px)`**：改用高對比半透明背景 `rgba(18, 28, 22, 0.86)`，並於 `#interactive-3d-stage` 加入 `contain: layout paint; isolation: isolate;`，消除瀏覽器合成器每幀多次回讀 WebGL Framebuffer 之開銷。

## **P1-2. DOM Dirty-Check 與 120ms 節流更新 (`Layout Thrashing` 消除 — [training.js](https://drive.google.com/file/d/1g31fIf4Powz5A71Sh2IFR1qxySuCbssE/view?usp=drivesdk))**

* **互動模式跳過隱藏元件更新**：當處於「互動模式」時，`advanceBreathingPacer()` 自動跳過已隱藏之 `#pacer-ball` 與 `#human-demo-box` 樣式計算。  
* **DOM Dirty-Check 與節流 (`UI_THROTTLE_MS = 120`)**：四張百分比指示卡 (`renderIndicatorCards`)、倒數計時器與階段提示文字僅於數值實際變更且達 `120ms` 間隔時才寫入 DOM；調試面板 (`updateDebugReadouts`) 僅於面板展開時每 `150ms` 更新一次。

## **P2-1 & P2-2. 風車網格/材質輕量化與 Web Audio 節點自動釋放 ([interactive3d.js](https://drive.google.com/file/d/1-yDwucrE81_PgtHnfcx-PR0JPQfXM64d/view?usp=drivesdk))**

* **風車網格與材質優化**：風車葉片細分由 `48×44` 降至 `24×22`（頂點減少 **75%**），將昂貴的 `MeshPhysicalMaterial` (`clearcoat`) 改為高效能 `MeshStandardMaterial`，並設定 `powerPreference: 'high-performance'` 及限制 `devicePixelRatio <= 1.25`。  
* **Web Audio 節點節流與 `onended` 自動 `disconnect()`**：為風聲碎片音效加入 `90ms` Cooldown 節流，並於所有短命音源綁定 `onended` 自動 `disconnect()`。

# **2\. ES6 模組化檔案結構與導航表 (`v9.1/`)**

| 檔案名稱 | 核心職責與匯出項目 (Exports) |
| :---- | :---- |
| [index.html](https://drive.google.com/file/d/1StELYwZH1_R7SA-krcB1ffdVXFHC0jbZ/view?usp=drivesdk) | 主頁面與訓練頁面結構（含 `#interactive-3d-wrapper` 3D 舞台及底部 `#app-version-footer` 版本 `v9.1` 備註） |
| [style.css](https://drive.google.com/file/d/1EMjpX0H3krM583e2vj36PDeOx7B8T5G_/view?usp=drivesdk) | 輕柔療癒配色、校準視訊毛玻璃過渡及 P1-1 零實時 CSS 模糊之 `#interactive-3d-stage` 樣式 |
| [app.js](https://drive.google.com/file/d/1TaTZRzhrq7bzcE9EkMdKxCcQCjDw7LrG/view?usp=drivesdk) | ES6 啟動入口 (`bootstrapApp`) 與全 14 模組 Barrel Re-exports |
| [interactive3d.js](https://drive.google.com/file/d/1-yDwucrE81_PgtHnfcx-PR0JPQfXM64d/view?usp=drivesdk) | **v9.1 P0–P2 高效能 3D 互動模式模組**：`initInteractive3D`, `disposeInteractive3D`, `renderInteractive3DFrame`, `startInteractiveBlowing`, `stopInteractiveBlowing` |
| [training.js](https://drive.google.com/file/d/1g31fIf4Powz5A71Sh2IFR1qxySuCbssE/view?usp=drivesdk) | 單一 60 FPS 主迴圈、MediaPipe 20Hz 交錯推論、DOM Dirty-Check 節流與動作感測觸發吹風 |
| [state.js](https://drive.google.com/file/d/130oo8gtSXGclBg-hCs0C3iGSY9yEJml6/view?usp=drivesdk) | 系統常數、`INFERENCE_INTERVAL_MS = 50`、`UI_THROTTLE_MS = 120`、`THRESHOLDS` 與 `AppState` |
| [dom.js](https://drive.google.com/file/d/1PETM1_hQvctSnm5Vb-TjukP7-p_-Kd8N/view?usp=drivesdk) | 180 個 DOM 元素快取參照 (`dom`, `cacheDomElements`) 與 `showToast` |
| [scoring.js](https://drive.google.com/file/d/1MezjPROCMrBNclHtOUSl8co8z37Ww-cE/view?usp=drivesdk) | 全程累計時間百分比運算 (`accumulateFrameScore`)、階段結束評估 (`evaluateCompletedPhase`) 與連續失敗排程 |
| [feedback.js](https://drive.google.com/file/d/1jM7Rn6jrQpExPIT7ruXmLqlJyRwcSwyY/view?usp=drivesdk) | 底部橫幅與廣東話語音綁定引擎 (`evaluateStickyPriorityFeedback`) |
| [calibration.js](https://drive.google.com/file/d/1j1Xpnspec9Vla0shi4mONHdr9UQKCDXI/view?usp=drivesdk) | 五步個人化動態基準校準與 70% 峰值努力折扣閾值計算 |
| [cvEngine.js](https://drive.google.com/file/d/1yEM9TKXfnyKyXXmE-mmOOT-G4jWayBsu/view?usp=drivesdk) | 面部 EMA 濾波 (`smoothFacialSignalsEMA`)、P0.4 連續模糊評分、動作動量豁免與耳肩代償偵測 |
| [vision.js](https://drive.google.com/file/d/1CrglOENvwzoHJPqyDbKvAM4jvVUDpBRC/view?usp=drivesdk) | `@mediapipe/tasks-vision@0.10.14` ESM 模型載入與初始化 |
| [camera.js](https://drive.google.com/file/d/1XQU-K9MePzkT5kXtroWp58Q59ntTPYwj/view?usp=drivesdk) | WebRTC 相機串流管理與 6 大臨床相機錯誤診斷彈窗 |
| [tts.js](https://drive.google.com/file/d/1t8V2NokoN4ioLNM5Oe6t01Zjf2wMzrjM/view?usp=drivesdk) | 廣東話 (`zh-HK`) Web Speech API 語音合成 |
| [summary.js](https://drive.google.com/file/d/1YWKss20UKthOKUovNL0rK9ZvhHhfFh6N/view?usp=drivesdk) | 訓練總結報告、去識別化 CSV 匯出與本機歷史紀錄 |
| [uiControls.js](https://drive.google.com/file/d/1BGtOENkmINk0hgFo0k4vK_zGFrexOoBP/view?usp=drivesdk) | 狀態機切換 (`switchViewState`)、互動模式切換與 Three.js 資源釋放掛鉤 |
| [sw.js](https://drive.google.com/file/d/1j4iMt88QxIEc4cUs-iN9XqrbnRo7BI9q/view?usp=drivesdk), [manifest.json](https://drive.google.com/file/d/1FFWIXp0znVRQyvvVq5A5KvekYi-zum_q/view?usp=drivesdk), [vercel.json](https://drive.google.com/file/d/1UYyRGJvN8xImS8SYr093or3R8PxIJgci/view?usp=drivesdk) | PWA 離線快取 (`soothebreath-v9.1.0`)、安裝資訊清單與靜態部署設定 |
| [1.jpg](https://drive.google.com/file/d/1Ew6x3RgFdkp1a6uMcjvG7RPRV8L0sF-d/view?usp=drivesdk), [2.jpg](https://drive.google.com/file/d/1xgW5sb0TJF8UHtADtiG3pqlPBps26wbd/view?usp=drivesdk), [3.jpg](https://drive.google.com/file/d/1cWZqSqOFUtfim3LLzoz_J9Z8DYPs5lsY/view?usp=drivesdk), [4.jpg](https://drive.google.com/file/d/13MZR352N5ksmzzo7oBDG28bpmTiNZZY8/view?usp=drivesdk) | 真人示範模式男/女性吸氣與呼氣實景圖 |
| [舒呼 (SootheBreath) — 產品需求文件 (PRD v9.1) & AI Coding Blueprint (PWA)](https://docs.google.com/document/d/1jPUqEOsFHvcl299qnOYWCnq2kZENfg8O4aYsjbB0e9c/edit) | 完整產品需求規格書與 AI 模組化編碼藍圖 (PRD v9.1) |
| [舒呼 (SootheBreath) — v9.1 效能優化版本更新報告 (Version Update Report)](https://docs.google.com/document/d/14s5zTnrXeOXLGg8MXFQBJQlKCQTFPONSHa7zoBHbS9Q/edit) | v9.1 P0–P2 效能優化項目、技術實作細節與端到端驗證報告 |

