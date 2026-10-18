/**
 * 舒呼(SootheBreath) v7.0 ES6 Module — uiControls.js
 * 狀態機視圖切換、臨床調試面板 (Debug Drawer) 與全域 UI 事件監聽器 (State Machine & UI Controls)
 */

import { STATES, DEFAULT_THRESHOLDS, THRESHOLDS, AppState } from './state.js';
import { dom, showToast } from './dom.js';
import { stopCamera } from './camera.js';
import { speakText } from './tts.js';
import {
  runCalibrationSequence,
  enterCalibrationStepWaiting,
  startStep3sCountdown,
  finalizeCurrentCalibrationStep,
  advanceToNextCalibrationStepOrSummary,
  syncThresholdsToDebugDrawer,
  showCalibrationConfirmation
} from './calibration.js';
import {
   runTrainingSequence,
  applyPrivacyModeStyles,
  applyDisplayModeStyles,
  finalizeCurrentCycle
} from './training.js';
import {
  renderSummaryReport,
  exportDeidentifiedCSV,
  saveSessionToLocalStorage,
  loadAndRenderLocalHistory
} from './summary.js';

// ============================================================================
// 8. 狀態一至四之生命週期 (State Machine Lifecycle)
// ============================================================================
export function switchViewState(targetState) {
  if (AppState.calibTimerId) {
    clearInterval(AppState.calibTimerId);
    AppState.calibTimerId = null;
  }

  AppState.currentState = targetState;
  AppState.isPaused = false;
  AppState.isCalibConfirming = false;

  if (targetState !== STATES.CALIBRATING && dom.calibVideo) {
    dom.calibVideo.srcObject = null;
  }
  dom.stateIdle.classList.add('hidden');
  dom.stateCalib.classList.add('hidden');
  dom.stateTrain.classList.add('hidden');
  dom.stateSummary.classList.add('hidden');
  dom.bottomBanner.classList.add('hidden');

  switch (targetState) {
    case STATES.IDLE:
      dom.stateIdle.classList.remove('hidden');
      stopCamera();
      break;

    case STATES.CALIBRATING:
      dom.stateCalib.classList.remove('hidden');
      runCalibrationSequence(true);
      break;

    case STATES.TRAINING:
      dom.stateTrain.classList.remove('hidden');
      dom.bottomBanner.classList.remove('hidden');
      runTrainingSequence();
      break;

    case STATES.SUMMARY:
      dom.stateSummary.classList.remove('hidden');
      stopCamera();
      renderSummaryReport();
      break;
  }
}


// ============================================================================
// 12. 調試面板與使用者介面監聽器 (Debug Drawer & Event Listeners)
// ============================================================================
export function updateDebugReadouts() {
  const m = AppState.currentMetrics;
  if (!dom.dbgLar) return;
  dom.dbgLar.textContent = m.lar.toFixed(3);
  if (dom.dbgJaw) dom.dbgJaw.textContent = m.jawOpen.toFixed(3);
  dom.dbgPucker.textContent = m.mouthPucker.toFixed(3);
  dom.dbgFunnel.textContent = m.mouthFunnel.toFixed(3);
  dom.dbgShoulder.textContent = m.deltaYRelative.toFixed(3);
  if (dom.dbgDistEs) dom.dbgDistEs.textContent = m.distCurr.toFixed(3);
  dom.dbgDeye.textContent = m.dEye.toFixed(3);
  if (dom.dbgTilt) dom.dbgTilt.textContent = m.shoulderTilt.toFixed(3);
  if (dom.dbgRr) {
    const rrLabel = AppState.training.pctRr === null ? '統計中' : `${AppState.training.pctRr}%`;
    dom.dbgRr.textContent = `${AppState.training.avgRR.toFixed(1)} BPM (${rrLabel})`;
  }
  if (dom.dbgLatch) {
    const latchNames = {
      inhale: '合口吸氣 (<80%)',
      exhale: '噘唇呼氣 (<80%)',
      shoulder: '沉肩放鬆 (<80%)',
      rr: '呼吸速率 (<80%)'
    };
    const consecSec = AppState.feedback.latchedModule
      ? ((AppState.training.consecutiveImprovedSec && AppState.training.consecutiveImprovedSec[AppState.feedback.latchedModule]) || 0).toFixed(1)
      : '0.0';
    dom.dbgLatch.textContent = AppState.feedback.latchedModule
      ? `🔒 鎖定中：${latchNames[AppState.feedback.latchedModule] || AppState.feedback.latchedModule} (連續改善 ${consecSec}s/10s)`
      : '✅ 持續保持 (全部 ≥80%)';
  }
}

export function openDebugDrawer() {
  dom.debugDrawer.classList.remove('translate-x-full');
  if (dom.debugBackdrop) dom.debugBackdrop.classList.remove('hidden');
}

export function closeDebugDrawer() {
  dom.debugDrawer.classList.add('translate-x-full');
  if (dom.debugBackdrop) dom.debugBackdrop.classList.add('hidden');
}

/**
 * 根據設定的 BPM (20 至 5) 與吸呼比例 (1:2 或 1:3) 自動計算吸氣與呼氣秒數
 */
export function updatePacingCalculationsUI() {
  const bpm = Math.max(5, Math.min(20, AppState.targetBpm));
  const ratio = AppState.ieRatio === 3 ? 3 : 2;
  const totalCycleSec = 60.0 / bpm;
  const inhaleSec = totalCycleSec / (1 + ratio);
  const exhaleSec = inhaleSec * ratio;

  AppState.inhaleTarget = inhaleSec;
  AppState.exhaleTarget = exhaleSec;

  const activeBtnCls = "flex-1 py-2.5 rounded-xl text-xs font-bold bg-[#2E7D32] text-white shadow-sm transition cursor-pointer";
  const inactiveBtnCls = "flex-1 py-2.5 rounded-xl text-xs font-semibold bg-white hover:bg-teal-50 text-slate-600 border border-slate-200 transition cursor-pointer";

  if (dom.btnRatio12) dom.btnRatio12.className = ratio === 2 ? activeBtnCls : inactiveBtnCls;
  if (dom.btnRatio13) dom.btnRatio13.className = ratio === 3 ? activeBtnCls : inactiveBtnCls;

  if (dom.labelIePreset) dom.labelIePreset.textContent = `目標 1 : ${ratio}`;
  if (dom.valTargetBpm) dom.valTargetBpm.textContent = `${bpm} BPM (次/分)`;
  if (dom.valInhaleCalc) dom.valInhaleCalc.textContent = `${inhaleSec.toFixed(1)} 秒`;
  if (dom.valExhaleCalc) dom.valExhaleCalc.textContent = `${exhaleSec.toFixed(1)} 秒`;
  if (dom.valCycleTotal) {
    dom.valCycleTotal.textContent = `單次循環總長: ${totalCycleSec.toFixed(1)} 秒 (自動換算：吸氣 ${inhaleSec.toFixed(1)}s / 呼氣 ${exhaleSec.toFixed(1)}s)`;
  }

  const mins = Math.round(AppState.totalDuration / 60);
  if (dom.valDurationMins) {
    dom.valDurationMins.textContent = `${mins} 分鐘`;
  }
}

export function setupEventListeners() {
  // 1. BPM 設定滑桿 (20 至 5 BPM)
  if (dom.inputBpm) {
    dom.inputBpm.addEventListener('input', (e) => {
      AppState.targetBpm = parseInt(e.target.value, 10);
      updatePacingCalculationsUI();
    });
  }

  // 2. 吸呼比例 (僅限 1:2 或 1:3)
  if (dom.btnRatio12) {
    dom.btnRatio12.addEventListener('click', () => {
      AppState.ieRatio = 2;
      updatePacingCalculationsUI();
      showToast(`⏱️ 已切換吸呼比為 1 : 2（目標頻率 ${AppState.targetBpm} BPM）`);
    });
  }
  if (dom.btnRatio13) {
    dom.btnRatio13.addEventListener('click', () => {
      AppState.ieRatio = 3;
      updatePacingCalculationsUI();
      showToast(`⏱️ 已切換吸呼比為 1 : 3（目標頻率 ${AppState.targetBpm} BPM）`);
    });
  }

  // 3. 訓練總時長滑桿 (1 至 10 分鐘)
  if (dom.inputDuration) {
    dom.inputDuration.addEventListener('input', (e) => {
      const mins = parseInt(e.target.value, 10);
      AppState.totalDuration = mins * 60;
      if (dom.valDurationMins) dom.valDurationMins.textContent = `${mins} 分鐘`;
    });
  }

  // 4. 相機顯示模式選擇
  if (dom.selectPrivacy) {
    dom.selectPrivacy.addEventListener('change', (e) => {
      AppState.privacyMode = e.target.value;
      applyPrivacyModeStyles();
    });
  }

  if (dom.btnModeMirror) {
    dom.btnModeMirror.addEventListener('click', () => {
      AppState.privacyMode = 'mirror';
      applyPrivacyModeStyles();
    });
  }
  if (dom.btnModeMesh) {
    dom.btnModeMesh.addEventListener('click', () => {
      AppState.privacyMode = 'privacy_mesh';
      applyPrivacyModeStyles();
    });
  }
  if (dom.btnModeMinimal) {
    dom.btnModeMinimal.addEventListener('click', () => {
      AppState.privacyMode = 'minimalist';
      applyPrivacyModeStyles();
    });
  }

  // 5. 呼吸引導顯示模式：氣球模式 vs 真人示範 (男性 / 女性)
  if (dom.btnPacerBalloon) {
    dom.btnPacerBalloon.addEventListener('click', () => {
      AppState.displayMode = 'balloon';
      applyDisplayModeStyles();
    });
  }
  if (dom.btnPacerHuman) {
    dom.btnPacerHuman.addEventListener('click', () => {
      AppState.displayMode = 'human';
      applyDisplayModeStyles();
    });
  }
  if (dom.btnGenderMale) {
    dom.btnGenderMale.addEventListener('click', () => {
      AppState.humanGender = 'male';
      applyDisplayModeStyles();
    });
  }
  if (dom.btnGenderFemale) {
    dom.btnGenderFemale.addEventListener('click', () => {
      AppState.humanGender = 'female';
      applyDisplayModeStyles();
    });
  }

  // 訓練中快速切換氣球 / 男性 / 女性
  if (dom.btnTrainBalloon) {
    dom.btnTrainBalloon.addEventListener('click', () => {
      AppState.displayMode = 'balloon';
      applyDisplayModeStyles();
      showToast("🎈 已切換至氣球模式");
    });
  }
  if (dom.btnTrainMale) {
    dom.btnTrainMale.addEventListener('click', () => {
      AppState.displayMode = 'human';
      AppState.humanGender = 'male';
      applyDisplayModeStyles();
      showToast("👨 已切換至真人示範（男性）");
    });
  }
  if (dom.btnTrainFemale) {
    dom.btnTrainFemale.addEventListener('click', () => {
      AppState.displayMode = 'human';
      AppState.humanGender = 'female';
      applyDisplayModeStyles();
      showToast("👩 已切換至真人示範（女性）");
    });
  }

  // 啟動真實相機訓練 -> 進入五步個人化動態基準校準
  dom.btnStart.addEventListener('click', () => {
    AppState.isDemoMode = false;
    switchViewState(STATES.CALIBRATING);
  });

  // 啟動免鏡頭模擬預覽訓練 -> 進入五步個人化動態基準校準
  if (dom.btnStartDemo) {
    dom.btnStartDemo.addEventListener('click', () => {
      AppState.isDemoMode = true;
      showToast("🧪 已啟動免鏡頭五步校準與互動模擬模式");
      switchViewState(STATES.CALIBRATING);
    });
  }

  if (dom.btnCancelCalib) {
    dom.btnCancelCalib.addEventListener('click', () => {
      switchViewState(STATES.IDLE);
    });
  }

  // 五步校準控制按鈕監聽器 (Section B.2)
  if (dom.btnCalibConfirmStep) {
    dom.btnCalibConfirmStep.addEventListener('click', () => {
      startStep3sCountdown();
    });
  }
  if (dom.btnCalibNextStep) {
    dom.btnCalibNextStep.addEventListener('click', () => {
      advanceToNextCalibrationStepOrSummary();
    });
  }
  if (dom.btnCalibRetestStep) {
    dom.btnCalibRetestStep.addEventListener('click', () => {
      showToast(`🔄 重新採集第 ${AppState.calibration.currentStep} 步動作`);
      enterCalibrationStepWaiting(AppState.calibration.currentStep);
    });
  }
  if (dom.btnCalibPrevStep) {
    dom.btnCalibPrevStep.addEventListener('click', () => {
      if (AppState.calibration.retestSingleStepMode) {
        AppState.calibration.retestSingleStepMode = false;
        showCalibrationConfirmation();
      } else if (AppState.calibration.currentStep > 1) {
        enterCalibrationStepWaiting(AppState.calibration.currentStep - 1);
      }
    });
  }
  if (dom.btnCalibUseDefault) {
    dom.btnCalibUseDefault.addEventListener('click', () => {
      finalizeCurrentCalibrationStep(true);
    });
  }

  // 五步校準總結畫面按鈕
  if (dom.btnConfirmStart) {
    dom.btnConfirmStart.addEventListener('click', () => {
      speakText("個人化基準已鎖定，現在開始呼吸訓練", true);
      switchViewState(STATES.TRAINING);
    });
  }
  if (dom.btnRecalibrate) {
    dom.btnRecalibrate.addEventListener('click', () => {
      showToast("🔄 重新進行五步個人化基準校準");
      runCalibrationSequence(true);
    });
  }
  if (dom.btnAdjustSettings) {
    dom.btnAdjustSettings.addEventListener('click', () => {
      switchViewState(STATES.IDLE);
    });
  }

  // TRAINING 右上角「🔄 重校準」按鈕
  if (dom.btnTrainRecalibrate) {
    dom.btnTrainRecalibrate.addEventListener('click', () => {
      showToast("🔄 返回五步個人化基準校準畫面");
      switchViewState(STATES.CALIBRATING);
    });
  }

  if (dom.btnPauseTrain) {
    dom.btnPauseTrain.addEventListener('click', () => {
      if (!AppState.isPaused) {
        AppState.isPaused = true;
        AppState.pauseStartTime = performance.now();
        dom.btnPauseTrain.textContent = "▶️ 繼續訓練";
        showToast("⏸️ 訓練已暫停");
      } else {
        const pausedDuration = performance.now() - AppState.pauseStartTime;
        AppState.training.startTime += pausedDuration;
        AppState.training.phaseStartTime += pausedDuration;
        AppState.training.cycleStartTime += pausedDuration;
        AppState.training.lastFrameTime = performance.now();
        AppState.isPaused = false;
        dom.btnPauseTrain.textContent = "⏸️ 暫停訓練";
        showToast("▶️ 訓練繼續");
      }
    });
  }

  dom.btnStopEarly.addEventListener('click', () => {
    finalizeCurrentCycle();
    switchViewState(STATES.SUMMARY);
  });

  dom.btnRestart.addEventListener('click', () => {
    switchViewState(STATES.IDLE);
  });

  dom.btnExportCsv.addEventListener('click', exportDeidentifiedCSV);
  dom.btnSaveLocal.addEventListener('click', saveSessionToLocalStorage);

  dom.btnClearHistory.addEventListener('click', () => {
    try {
      localStorage.removeItem('soothebreath_history_v6');
      localStorage.removeItem('soothebreath_history_v4');
      localStorage.removeItem('breathguide_history_v3');
    } catch (e) {}
    loadAndRenderLocalHistory();
    showToast("🗑️ 已清空本機歷史紀錄");
  });

  dom.btnToggleDebug.addEventListener('click', () => {
    if (dom.debugDrawer.classList.contains('translate-x-full')) {
      openDebugDrawer();
    } else {
      closeDebugDrawer();
    }
  });

  dom.btnCloseDebug.addEventListener('click', closeDebugDrawer);
  if (dom.debugBackdrop) {
    dom.debugBackdrop.addEventListener('click', closeDebugDrawer);
  }

  // Debug Drawer 閾值滑桿雙向同步
  if (dom.dbgRangeLarInMax) {
    dom.dbgRangeLarInMax.addEventListener('input', (e) => {
      THRESHOLDS.larInhaleMax = parseFloat(e.target.value);
      dom.dbgLblLarInMax.textContent = THRESHOLDS.larInhaleMax.toFixed(2);
    });
  }

  if (dom.dbgRangeJawInMax) {
    dom.dbgRangeJawInMax.addEventListener('input', (e) => {
      THRESHOLDS.jawOpenInhaleMax = parseFloat(e.target.value);
      dom.dbgLblJawInMax.textContent = THRESHOLDS.jawOpenInhaleMax.toFixed(2);
    });
  }

  if (dom.dbgRangeLarWideErr) {
    dom.dbgRangeLarWideErr.addEventListener('input', (e) => {
      THRESHOLDS.larExhaleWideErr = parseFloat(e.target.value);
      dom.dbgLblLarWideErr.textContent = THRESHOLDS.larExhaleWideErr.toFixed(2);
    });
  }

  if (dom.dbgRangeLarExMin) {
    dom.dbgRangeLarExMin.addEventListener('input', (e) => {
      THRESHOLDS.larExhaleMin = parseFloat(e.target.value);
      dom.dbgLblLarExMin.textContent = THRESHOLDS.larExhaleMin.toFixed(2);
    });
  }

  if (dom.dbgRangeLarExMax) {
    dom.dbgRangeLarExMax.addEventListener('input', (e) => {
      THRESHOLDS.larExhaleMax = parseFloat(e.target.value);
      dom.dbgLblLarExMax.textContent = THRESHOLDS.larExhaleMax.toFixed(2);
    });
  }

  if (dom.dbgRangePuckerMin) {
    dom.dbgRangePuckerMin.addEventListener('input', (e) => {
      THRESHOLDS.mouthPuckerMin = parseFloat(e.target.value);
      dom.dbgLblPuckerMin.textContent = THRESHOLDS.mouthPuckerMin.toFixed(2);
    });
  }

  if (dom.dbgRangeFunnelMin) {
    dom.dbgRangeFunnelMin.addEventListener('input', (e) => {
      THRESHOLDS.mouthFunnelMin = parseFloat(e.target.value);
      dom.dbgLblFunnelMin.textContent = THRESHOLDS.mouthFunnelMin.toFixed(2);
    });
  }

  if (dom.dbgRangeShoulderMax) {
    dom.dbgRangeShoulderMax.addEventListener('input', (e) => {
      THRESHOLDS.shoulderHikeWarn = parseFloat(e.target.value);
      dom.dbgLblShoulderMax.textContent = THRESHOLDS.shoulderHikeWarn.toFixed(2);
    });
  }

  if (dom.btnResetThresholds) {
    dom.btnResetThresholds.addEventListener('click', () => {
      Object.assign(THRESHOLDS, DEFAULT_THRESHOLDS);
      syncThresholdsToDebugDrawer();
      showToast("🔄 已恢復預設推薦閾值");
    });
  }

  dom.btnModalClose.addEventListener('click', () => {
    dom.modalError.classList.add('hidden');
    switchViewState(STATES.IDLE);
  });

  dom.btnModalRetry.addEventListener('click', () => {
    dom.modalError.classList.add('hidden');
    AppState.isDemoMode = false;
    switchViewState(STATES.CALIBRATING);
  });

  if (dom.btnModalDemo) {
    dom.btnModalDemo.addEventListener('click', () => {
      dom.modalError.classList.add('hidden');
      AppState.isDemoMode = true;
      showToast("🧪 已切換至免鏡頭模擬訓練模式");
      switchViewState(STATES.CALIBRATING);
    });
  }
}

