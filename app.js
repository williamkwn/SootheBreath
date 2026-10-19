/**
 * 舒呼(SootheBreath) 呼吸復康訓練 — 實時呼吸視覺生物反饋系統 (PWA v8.0 ES6 Modular Edition)
 * Main Entry Point (app.js)
 *
 * 模組化架構 (ES6 Modules Architecture):
 * - ./state.js       : 系統常數、臨床預設與動態閾值、五步校準配置、全域狀態 (AppState) 與統計輔助函式
 * - ./dom.js         : DOM 元素快取 (dom) 與非阻塞式 Toast 通知
 * - ./vision.js      : MediaPipe Tasks Vision 0.10.14 ESM 模型載入與初始化
 * - ./camera.js      : WebRTC 相機串流啟動、停止與錯誤診斷對話框
 * - ./cvEngine.js    : 核心電腦視覺幾何運算、臨床生物力學判定與免鏡頭模擬器 (Demo Mode)
 * - ./tts.js         : 廣東話 (zh-HK) Web Speech API 語音合成導航
 * - ./feedback.js    : 最低分優先與「鎖定直到回升 ≥70%」平滑警示機制 (Sticky Priority Latch)
 * - ./calibration.js : 五步個人化動態基準校準系統與動態閾值同步
 * - ./training.js    : 實時訓練主迴圈、20 秒滾動時間窗四大百分比指標、呼吸節奏球/真人示範與 AR 畫布渲染
 * - ./summary.js     : 訓練總結報告、去識別化 CSV 匯出與 LocalStorage 歷史紀錄
 * - ./uiControls.js  : 四大視圖狀態機切換、臨床演算法調試面板 (Debug Drawer) 與 UI 事件監聽器
 */

import { cacheDomElements } from './dom.js';
import { initMediaPipeVision } from './vision.js';
import { initTTS } from './tts.js';
import { syncThresholdsToDebugDrawer } from './calibration.js';
import { applyDisplayModeStyles } from './training.js';
import { loadAndRenderLocalHistory } from './summary.js';
import { updatePacingCalculationsUI, setupEventListeners } from './uiControls.js';

// 統一匯出各子模組 API 以便外部調試與未來 AI 擴充 (Re-export all module APIs)
export * from './state.js';
export * from './dom.js';
export * from './vision.js';
export * from './camera.js';
export * from './cvEngine.js';
export * from './scoring.js';
export * from './tts.js';
export * from './feedback.js';
export * from './calibration.js';
export * from './training.js';
export * from './summary.js';
export * from './uiControls.js';

// ============================================================================
// 13. 程式啟動入口 (Immediate Safe Bootstrapping)
// ============================================================================
export function bootstrapApp() {
  if (window.__sootheBreathBootstrapped) return;
  window.__sootheBreathBootstrapped = true;

  cacheDomElements();
  setupEventListeners();
  updatePacingCalculationsUI();
  applyDisplayModeStyles();
  syncThresholdsToDebugDrawer();
  initTTS();
  loadAndRenderLocalHistory();
  initMediaPipeVision();
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', bootstrapApp);
} else {
  bootstrapApp();
}
