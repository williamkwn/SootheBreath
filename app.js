/**
 * 舒呼(SootheBreath) 呼吸復康訓練 — 實時呼吸視覺生物反饋系統 (PWA v10.1 ES6 Modular Edition)
 * Main Entry Point (app.js)
 *
 * 模組化架構 (ES6 Modules Architecture - 14 Modules):
 * - ./state.js         : 系統常數、臨床預設與動態閾值、五步校準配置、全域狀態 (AppState) 與統計輔助函式
 * - ./dom.js           : DOM 元素快取 (dom) 與非阻塞式 Toast 通知
 * - ./vision.js        : MediaPipe Tasks Vision 0.10.14 ESM 模型載入與初始化
 * - ./camera.js        : WebRTC 相機串流啟動、停止與錯誤診斷對話框
 * - ./cvEngine.js      : 核心電腦視覺幾何運算、臨床生物力學判定與免鏡頭模擬器 (Demo Mode)
 * - ./scoring.js       : 全程累計時間百分比運算、階段結束評估與連續失敗警示排程引擎
 * - ./tts.js           : 廣東話 (zh-HK) Web Speech API 語音合成導航與人聲靜音切換
 * - ./feedback.js      : 常駐底部警示橫幅（「分析中...」與白底橙字改善提示）及語音回饋引擎
 * - ./calibration.js   : 五步個人化動態基準校準系統（無模糊遮罩清晰預覽、底部確認按鈕與自動儲存校準設定）
 * - ./interactive3d.js : 3D 互動模式（微風風車 Pinwheel & 蒲公英 Dandelion）與 Three.js 資源釋放引擎
 * - ./training.js      : 實時訓練主迴圈、累計時間百分比卡片、互動引導雙欄同屏與 AR 畫布渲染
 * - ./summary.js       : 訓練總結報告、自動儲存本次校準設定、去識別化 CSV 匯出與 LocalStorage 歷史紀錄
 * - ./uiControls.js    : 四大視圖狀態機切換、臨床演算法調試面板與 UI 事件監聽器
 */

import { cacheDomElements } from './dom.js';
import { initMediaPipeVision } from './vision.js';
import { initTTS } from './tts.js';
import {
  syncThresholdsToDebugDrawer,
  loadSavedCalibrationSettings,
  updateContinueLastCalibButtonUI
} from './calibration.js';
import { applyPrivacyModeStyles, applyDisplayModeStyles } from './training.js';
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
export * from './interactive3d.js';
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
  loadSavedCalibrationSettings(false);
  updateContinueLastCalibButtonUI();
  setupEventListeners();
  updatePacingCalculationsUI();
  applyPrivacyModeStyles();
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
