/**
 * 舒呼(SootheBreath) v7.0 ES6 Module — calibration.js
 * 五步個人化動態基準校準系統 (5-Step Personalized Dynamic Baseline Calibration)
 */

import {
  STATES,
  THRESHOLDS,
  DEFAULT_CALIB_BASELINES,
  CALIB_STEPS_CONFIG,
  getNextTimestamp,
  clampVal,
  roundTo,
  computeTrimmedMean,
  AppState
} from './state.js';
import { dom, showToast } from './dom.js';
import { initMediaPipeVision } from './vision.js';
import { startCamera } from './camera.js';
import {
  calculateDEye,
  calculateLAR,
  extractBlendshapes,
  smoothFacialSignalsEMA,
  smoothShoulderLandmarksEMA,
  calculateEarShoulderDistance,
  generateSimulatedDetections
} from './cvEngine.js';
import { speakText } from './tts.js';
import { switchViewState, updateDebugReadouts } from './uiControls.js';

// ============================================================================
// 9. 五步個人化動態基準校準系統 (Section B: 5-Step Personalized Calibration)
// ============================================================================
let calibLoopRunning = false;

export async function runCalibrationSequence(resetAll = true) {
  if (AppState.calibTimerId) {
    clearInterval(AppState.calibTimerId);
    AppState.calibTimerId = null;
  }
  AppState.isCalibConfirming = false;
  AppState.ema.initialized = false;
  AppState.ema.faceInitialized = false;

  if (resetAll) {
    AppState.calibration = {
      currentStep: 1,
      subState: 'WAITING_CONFIRM',
      retestSingleStepMode: false,
      countdownRemaining: 3,
      stepSamples: {
        dEye: [],
        lar: [],
        jawOpen: [],
        mouthPucker: [],
        mouthFunnel: [],
        distEarShoulder: [],
        yShoulder: []
      },
      stepSource: { 1: 'default', 2: 'default', 3: 'default', 4: 'default', 5: 'default' },
      stepSampleCounts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      LAR_closed: DEFAULT_CALIB_BASELINES.LAR_closed,
      jawOpen_closed: DEFAULT_CALIB_BASELINES.jawOpen_closed,
      D_eye: DEFAULT_CALIB_BASELINES.D_eye,
      LAR_open: DEFAULT_CALIB_BASELINES.LAR_open,
      jawOpen_open: DEFAULT_CALIB_BASELINES.jawOpen_open,
      LAR_plb: DEFAULT_CALIB_BASELINES.LAR_plb,
      mouthPucker_plb: DEFAULT_CALIB_BASELINES.mouthPucker_plb,
      mouthFunnel_plb: DEFAULT_CALIB_BASELINES.mouthFunnel_plb,
      Dist_shrug: DEFAULT_CALIB_BASELINES.Dist_shrug,
      Dist_relax: DEFAULT_CALIB_BASELINES.Dist_relax,
      dEyeBase: DEFAULT_CALIB_BASELINES.D_eye,
      distBase: DEFAULT_CALIB_BASELINES.Dist_base,
      yShoulderBase: DEFAULT_CALIB_BASELINES.yShoulderBase,
      larRest: DEFAULT_CALIB_BASELINES.LAR_closed
    };
  }

  if (dom.calibStepWorkspace) dom.calibStepWorkspace.classList.remove('hidden');
  if (dom.calibVideoBox) dom.calibVideoBox.classList.remove('hidden');
  if (dom.calibConfirmOverlay) dom.calibConfirmOverlay.classList.add('hidden');

  const started = await startCamera(dom.calibVideo);
  if (!started) {
    switchViewState(STATES.IDLE);
    return;
  }

  if (!AppState.isDemoMode && (!AppState.faceLandmarker || !AppState.poseLandmarker)) {
    if (dom.calibStatusPill) dom.calibStatusPill.textContent = "⏳ 正在載入本地 AI 視覺模型...";
    await initMediaPipeVision();
  }

  enterCalibrationStepWaiting(AppState.calibration.currentStep);

  if (!calibLoopRunning) {
    calibLoopRunning = true;
    requestAnimationFrame(calibFrameLoop);
  }
}

export function clearStepSamplesBuffer() {
  AppState.calibration.stepSamples = {
    dEye: [],
    lar: [],
    jawOpen: [],
    mouthPucker: [],
    mouthFunnel: [],
    distEarShoulder: [],
    yShoulder: []
  };
}

/**
 * 進入指定步驟（1–5）之「等待治療師確認」狀態（不自動開始倒數）
 */
export function enterCalibrationStepWaiting(stepNum) {
  if (AppState.calibTimerId) {
    clearInterval(AppState.calibTimerId);
    AppState.calibTimerId = null;
  }

  const stepIdx = clampVal(stepNum, 1, 5);
  const cfg = CALIB_STEPS_CONFIG[stepIdx - 1];
  const cal = AppState.calibration;

  cal.currentStep = stepIdx;
  cal.subState = 'WAITING_CONFIRM';
  cal.countdownRemaining = 3;
  AppState.isCalibConfirming = false;
  clearStepSamplesBuffer();

  if (dom.calibStepWorkspace) dom.calibStepWorkspace.classList.remove('hidden');
  if (dom.calibVideoBox) dom.calibVideoBox.classList.remove('hidden');
  if (dom.calibConfirmOverlay) dom.calibConfirmOverlay.classList.add('hidden');

  updateCalibrationStepperUI(stepIdx, 'WAITING_CONFIRM');

  if (dom.calibTitle) dom.calibTitle.textContent = cfg.title;
  if (dom.calibSubtitle) dom.calibSubtitle.textContent = cfg.instruction;
  if (dom.calibTargetMetricsDesc) dom.calibTargetMetricsDesc.textContent = cfg.metricsDesc;

  if (dom.calibCountdown) {
    dom.calibCountdown.textContent = "等待確認";
    dom.calibCountdown.className = "text-2xl md:text-3xl font-black text-teal-800";
  }
  if (dom.calibStepStateLabel) {
    dom.calibStepStateLabel.textContent = `請指導病人擺好【${cfg.shortName}】動作，確認後點擊下方綠色按鈕開始 3 秒採集`;
  }
  if (dom.calibStepTimerBarWrap) dom.calibStepTimerBarWrap.classList.add('hidden');
  if (dom.calibStepTimerBar) dom.calibStepTimerBar.style.width = '0%';
  if (dom.calibStepResultBox) {
    dom.calibStepResultBox.classList.add('hidden');
    dom.calibStepResultBox.innerHTML = '';
  }

  // 按鈕狀態切換：顯示「確定開始採集」與「使用預設值並跳至下一步」
  if (dom.btnCalibConfirmStep) {
    dom.btnCalibConfirmStep.classList.remove('hidden');
    dom.btnCalibConfirmStep.disabled = false;
    dom.btnCalibConfirmStep.textContent = `✅ 確定開始採集此動作 (3 秒倒數)`;
  }
  if (dom.btnCalibNextStep) dom.btnCalibNextStep.classList.add('hidden');
  if (dom.btnCalibRetestStep) dom.btnCalibRetestStep.classList.add('hidden');
  if (dom.btnCalibPrevStep) {
    dom.btnCalibPrevStep.classList.toggle('hidden', stepIdx <= 1 && !cal.retestSingleStepMode);
    dom.btnCalibPrevStep.textContent = cal.retestSingleStepMode ? "↩️ 返回校準總結" : "⬅️ 返回上一步";
  }
  if (dom.btnCalibUseDefault) {
    dom.btnCalibUseDefault.classList.remove('hidden');
  }

  speakText(cfg.ttsWait, true);
}

export function updateCalibrationStepperUI(stepIdx, subState) {
  if (dom.calibStageBadge) {
    const cfg = CALIB_STEPS_CONFIG[stepIdx - 1];
    dom.calibStageBadge.textContent = `步驟 ${stepIdx} / 5：${cfg.shortName}`;
  }
  if (dom.calibProgressBar) {
    const pct = subState === 'STEP_DONE'
      ? (stepIdx / 5) * 100
      : ((stepIdx - 1) / 5) * 100 + (subState === 'COUNTDOWN' ? 10 : 4);
    dom.calibProgressBar.style.width = `${clampVal(pct, 5, 100)}%`;
  }

  const pills = [
    dom.calibStepPill1,
    dom.calibStepPill2,
    dom.calibStepPill3,
    dom.calibStepPill4,
    dom.calibStepPill5
  ];
  pills.forEach((pill, idx) => {
    if (!pill) return;
    const s = idx + 1;
    if (s < stepIdx || (s === stepIdx && subState === 'STEP_DONE')) {
      pill.className = "flex-1 py-1.5 px-2 rounded-xl text-xs font-extrabold bg-[#2E7D32] text-white text-center shadow-2xs transition";
    } else if (s === stepIdx) {
      pill.className = "flex-1 py-1.5 px-2 rounded-xl text-xs font-extrabold bg-[#4DB6AC] text-white ring-2 ring-teal-300 text-center shadow-sm transition";
    } else {
      pill.className = "flex-1 py-1.5 px-2 rounded-xl text-xs font-semibold bg-slate-100 text-slate-500 text-center border border-slate-200 transition";
    }
  });

  if (dom.calibStatusPill) {
    if (subState === 'WAITING_CONFIRM') {
      dom.calibStatusPill.textContent = `⏳ 步驟 ${stepIdx}/5：等待治療師確認開始`;
      dom.calibStatusPill.className = "px-3 py-1 rounded-full text-xs font-bold bg-amber-500/90 text-white shadow";
    } else if (subState === 'COUNTDOWN') {
      dom.calibStatusPill.textContent = `🔴 步驟 ${stepIdx}/5：正在採集基準數據 (3 秒倒數)...`;
      dom.calibStatusPill.className = "px-3 py-1 rounded-full text-xs font-bold bg-rose-600 text-white animate-pulse shadow";
    } else if (subState === 'STEP_DONE') {
      dom.calibStatusPill.textContent = `✅ 步驟 ${stepIdx}/5：此動作採集完成`;
      dom.calibStatusPill.className = "px-3 py-1 rounded-full text-xs font-bold bg-emerald-600 text-white shadow";
    }
  }
}

/**
 * 當治療師點擊「✅ 確定開始採集此動作」後，啟動 3 秒倒數採集
 */
export function startStep3sCountdown() {
  if (AppState.currentState !== STATES.CALIBRATING) return;
  const cal = AppState.calibration;
  const stepIdx = cal.currentStep;
  const cfg = CALIB_STEPS_CONFIG[stepIdx - 1];

  if (AppState.calibTimerId) {
    clearInterval(AppState.calibTimerId);
    AppState.calibTimerId = null;
  }

  clearStepSamplesBuffer();
  cal.subState = 'COUNTDOWN';
  cal.countdownRemaining = 3;

  updateCalibrationStepperUI(stepIdx, 'COUNTDOWN');

  if (dom.btnCalibConfirmStep) {
    dom.btnCalibConfirmStep.disabled = true;
    dom.btnCalibConfirmStep.textContent = "⏳ 正在採集數據中 (請保持動作)...";
  }
  if (dom.calibStepResultBox) dom.calibStepResultBox.classList.add('hidden');
  if (dom.calibStepTimerBarWrap) dom.calibStepTimerBarWrap.classList.remove('hidden');
  if (dom.calibStepTimerBar) dom.calibStepTimerBar.style.width = '10%';

  if (dom.calibCountdown) {
    dom.calibCountdown.textContent = "3";
    dom.calibCountdown.className = "text-5xl md:text-6xl font-black text-[#FF7043] drop-shadow-xs";
  }
  if (dom.calibStepStateLabel) {
    dom.calibStepStateLabel.textContent = `正在採集【${cfg.shortName}】個人基準數據，請保持動作 3 秒...`;
  }

  speakText(cfg.ttsStart, true);

  let ticks = 0;
  const totalTicks = 30; // 3.0 秒 (每 100ms 更新進度條)
  AppState.calibTimerId = setInterval(() => {
    if (AppState.currentState !== STATES.CALIBRATING || cal.subState !== 'COUNTDOWN') {
      clearInterval(AppState.calibTimerId);
      AppState.calibTimerId = null;
      return;
    }

    ticks++;
    const pct = Math.min(100, Math.round((ticks / totalTicks) * 100));
    if (dom.calibStepTimerBar) dom.calibStepTimerBar.style.width = `${pct}%`;

    const secsLeft = Math.ceil((totalTicks - ticks) / 10);
    if (secsLeft !== cal.countdownRemaining && secsLeft > 0) {
      cal.countdownRemaining = secsLeft;
      if (dom.calibCountdown) dom.calibCountdown.textContent = String(secsLeft);
    }

    if (ticks >= totalTicks) {
      clearInterval(AppState.calibTimerId);
      AppState.calibTimerId = null;
      finalizeCurrentCalibrationStep(false);
    }
  }, 100);
}

/**
 * 完成單一步驟採集（或點擊「⏭️ 使用預設值並跳至下一步」）
 */
export function finalizeCurrentCalibrationStep(useDefaultFallback = false) {
  const cal = AppState.calibration;
  const stepIdx = cal.currentStep;
  const samples = cal.stepSamples;

  if (AppState.calibTimerId) {
    clearInterval(AppState.calibTimerId);
    AppState.calibTimerId = null;
  }

  let summaryHtml = '';
  const sampleCount = Math.max(samples.lar.length, samples.distEarShoulder.length);

  if (useDefaultFallback || sampleCount === 0) {
    cal.stepSource[stepIdx] = 'default';
    cal.stepSampleCounts[stepIdx] = 0;

    if (stepIdx === 1) {
      cal.LAR_closed = DEFAULT_CALIB_BASELINES.LAR_closed;
      cal.jawOpen_closed = DEFAULT_CALIB_BASELINES.jawOpen_closed;
      cal.D_eye = DEFAULT_CALIB_BASELINES.D_eye;
      cal.dEyeBase = cal.D_eye;
      cal.larRest = cal.LAR_closed;
      summaryHtml = `已套用【閉嘴】臨床預設值：<code>LAR_closed = ${cal.LAR_closed.toFixed(3)}</code> · <code>jawOpen_closed = ${cal.jawOpen_closed.toFixed(3)}</code> · <code>D_eye = ${cal.D_eye.toFixed(3)}</code>`;
    } else if (stepIdx === 2) {
      cal.LAR_open = DEFAULT_CALIB_BASELINES.LAR_open;
      cal.jawOpen_open = DEFAULT_CALIB_BASELINES.jawOpen_open;
      summaryHtml = `已套用【張大口】臨床預設值：<code>LAR_open = ${cal.LAR_open.toFixed(3)}</code> · <code>jawOpen_open = ${cal.jawOpen_open.toFixed(3)}</code>`;
    } else if (stepIdx === 3) {
      cal.LAR_plb = DEFAULT_CALIB_BASELINES.LAR_plb;
      cal.mouthPucker_plb = DEFAULT_CALIB_BASELINES.mouthPucker_plb;
      cal.mouthFunnel_plb = DEFAULT_CALIB_BASELINES.mouthFunnel_plb;
      summaryHtml = `已套用【噘唇】臨床預設值：<code>LAR_plb = ${cal.LAR_plb.toFixed(3)}</code> · <code>Pucker = ${cal.mouthPucker_plb.toFixed(2)}</code> · <code>Funnel = ${cal.mouthFunnel_plb.toFixed(2)}</code>`;
    } else if (stepIdx === 4) {
      cal.Dist_shrug = DEFAULT_CALIB_BASELINES.Dist_shrug;
      summaryHtml = `已套用【縮膊頭】臨床預設值：<code>Dist_shrug = ${cal.Dist_shrug.toFixed(3)}</code>`;
    } else if (stepIdx === 5) {
      cal.Dist_relax = DEFAULT_CALIB_BASELINES.Dist_relax;
      cal.distBase = cal.Dist_relax;
      cal.yShoulderBase = DEFAULT_CALIB_BASELINES.yShoulderBase;
      summaryHtml = `已套用【放鬆膊頭】臨床預設值：<code>Dist_relax (Dist_base) = ${cal.Dist_relax.toFixed(3)}</code> · <code>yShoulderBase = ${cal.yShoulderBase.toFixed(3)}</code>`;
    }

    // 點擊「⏭️ 使用預設值並跳至下一步」時直接推進至下一步或總結面板
    if (useDefaultFallback) {
      showToast(`⏭️ 第 ${stepIdx} 步已採用臨床預設值`);
      advanceToNextCalibrationStepOrSummary();
      return;
    }
  } else {
    cal.stepSource[stepIdx] = 'measured';
    cal.stepSampleCounts[stepIdx] = sampleCount;

    if (stepIdx === 1) {
      cal.LAR_closed = clampVal(computeTrimmedMean(samples.lar, DEFAULT_CALIB_BASELINES.LAR_closed), 0.01, 0.10);
      cal.jawOpen_closed = clampVal(computeTrimmedMean(samples.jawOpen, DEFAULT_CALIB_BASELINES.jawOpen_closed), 0.002, 0.09);
      cal.D_eye = clampVal(computeTrimmedMean(samples.dEye, DEFAULT_CALIB_BASELINES.D_eye), 0.08, 0.45);
      cal.dEyeBase = cal.D_eye;
      cal.larRest = cal.LAR_closed;
      summaryHtml = `✅ 採集成功 (${sampleCount} 幀去極端值平均)：<br><code>LAR_closed = ${cal.LAR_closed.toFixed(3)}</code> · <code>jawOpen_closed = ${cal.jawOpen_closed.toFixed(3)}</code> · <code>D_eye = ${cal.D_eye.toFixed(3)}</code>`;
    } else if (stepIdx === 2) {
      cal.LAR_open = clampVal(computeTrimmedMean(samples.lar, DEFAULT_CALIB_BASELINES.LAR_open), Math.max(0.15, cal.LAR_closed + 0.10), 0.75);
      cal.jawOpen_open = clampVal(computeTrimmedMean(samples.jawOpen, DEFAULT_CALIB_BASELINES.jawOpen_open), Math.max(0.15, cal.jawOpen_closed + 0.10), 0.95);
      summaryHtml = `✅ 採集成功 (${sampleCount} 幀去極端值平均)：<br><code>LAR_open = ${cal.LAR_open.toFixed(3)}</code> · <code>jawOpen_open = ${cal.jawOpen_open.toFixed(3)}</code>`;
    } else if (stepIdx === 3) {
      cal.LAR_plb = clampVal(computeTrimmedMean(samples.lar, DEFAULT_CALIB_BASELINES.LAR_plb), 0.04, 0.25);
      cal.mouthPucker_plb = clampVal(computeTrimmedMean(samples.mouthPucker, DEFAULT_CALIB_BASELINES.mouthPucker_plb), 0.25, 0.95);
      cal.mouthFunnel_plb = clampVal(computeTrimmedMean(samples.mouthFunnel, DEFAULT_CALIB_BASELINES.mouthFunnel_plb), 0.20, 0.95);
      summaryHtml = `✅ 採集成功 (${sampleCount} 幀去極端值平均)：<br><code>LAR_plb = ${cal.LAR_plb.toFixed(3)}</code> · <code>mouthPucker_plb = ${cal.mouthPucker_plb.toFixed(2)}</code> · <code>mouthFunnel_plb = ${cal.mouthFunnel_plb.toFixed(2)}</code>`;
    } else if (stepIdx === 4) {
      cal.Dist_shrug = clampVal(computeTrimmedMean(samples.distEarShoulder, DEFAULT_CALIB_BASELINES.Dist_shrug), 0.10, 0.45);
      if (samples.dEye.length > 0 && cal.stepSource[1] === 'default') {
        cal.D_eye = clampVal(computeTrimmedMean(samples.dEye, DEFAULT_CALIB_BASELINES.D_eye), 0.08, 0.45);
        cal.dEyeBase = cal.D_eye;
      }
      summaryHtml = `✅ 採集成功 (${sampleCount} 幀去極端值平均)：<br><code>聳肩耳肩距離 Dist_shrug = ${cal.Dist_shrug.toFixed(3)}</code>`;
    } else if (stepIdx === 5) {
      cal.Dist_relax = clampVal(computeTrimmedMean(samples.distEarShoulder, DEFAULT_CALIB_BASELINES.Dist_relax), 0.14, 0.52);
      // 確保放鬆耳肩距離大於聳肩耳肩距離至少 0.025，防止倒置
      if (cal.Dist_relax <= cal.Dist_shrug + 0.02) {
        cal.Dist_relax = roundTo(cal.Dist_shrug + 0.05, 3);
      }
      cal.distBase = cal.Dist_relax;
      cal.yShoulderBase = clampVal(computeTrimmedMean(samples.yShoulder, DEFAULT_CALIB_BASELINES.yShoulderBase), 0.40, 0.92);
      summaryHtml = `✅ 採集成功 (${sampleCount} 幀去極端值平均)：<br><code>沉肩基準 Dist_relax (Dist_base) = ${cal.Dist_relax.toFixed(3)}</code> · <code>雙肩基準線 yShoulderBase = ${cal.yShoulderBase.toFixed(3)}</code>`;
    }
  }

  cal.subState = 'STEP_DONE';
  updateCalibrationStepperUI(stepIdx, 'STEP_DONE');

  if (dom.calibCountdown) {
    dom.calibCountdown.textContent = "完成";
    dom.calibCountdown.className = "text-3xl md:text-4xl font-black text-[#2E7D32]";
  }
  if (dom.calibStepStateLabel) {
    dom.calibStepStateLabel.textContent = `第 ${stepIdx} 步採集完成！可點擊「下一步」繼續，或「🔄 重測此動作」`;
  }
  if (dom.calibStepResultBox) {
    dom.calibStepResultBox.innerHTML = summaryHtml;
    dom.calibStepResultBox.classList.remove('hidden');
  }

  if (dom.btnCalibConfirmStep) dom.btnCalibConfirmStep.classList.add('hidden');
  if (dom.btnCalibNextStep) {
    dom.btnCalibNextStep.classList.remove('hidden');
    if (cal.retestSingleStepMode || stepIdx >= 5) {
      dom.btnCalibNextStep.textContent = "✅ 完成並查看五步校準總結";
    } else {
      const nextCfg = CALIB_STEPS_CONFIG[stepIdx];
      dom.btnCalibNextStep.textContent = `➡️ 下一步：第 ${stepIdx + 1} 步【${nextCfg.shortName}】`;
    }
  }
  if (dom.btnCalibRetestStep) dom.btnCalibRetestStep.classList.remove('hidden');

  speakText(`第${stepIdx}步採集完成`, true);
}

export function advanceToNextCalibrationStepOrSummary() {
  const cal = AppState.calibration;
  if (cal.retestSingleStepMode || cal.currentStep >= 5) {
    cal.retestSingleStepMode = false;
    showCalibrationConfirmation();
  } else {
    enterCalibrationStepWaiting(cal.currentStep + 1);
  }
}

/**
 * 【B.3 個人化動態閾值自動計算與同步 (Dynamic Threshold Computation)】
 * 利用五步實測數據自動計算並更新全域 THRESHOLDS（含安全上下限 Clamping），
 * 並同步更新至右側 Debug Drawer 滑桿與數值顯示。
 */
export function computeAndSyncDynamicThresholds() {
  const cal = AppState.calibration;

  const larClosed = cal.LAR_closed;
  const larOpen = Math.max(cal.LAR_open, larClosed + 0.12);
  const larRange = larOpen - larClosed;

  const jawClosed = cal.jawOpen_closed;
  const jawOpenMax = Math.max(cal.jawOpen_open, jawClosed + 0.12);
  const jawRange = jawOpenMax - jawClosed;

  // 1. 吸氣閉口上限 (larInhaleMax & jawOpenInhaleMax)：基於【閉嘴】與【張大口】個人範圍動態設定
  THRESHOLDS.larInhaleMax = clampVal(roundTo(larClosed + Math.max(0.02, larRange * 0.08), 2), 0.04, 0.12);
  THRESHOLDS.jawOpenInhaleMax = clampVal(roundTo(jawClosed + Math.max(0.02, jawRange * 0.09), 2), 0.03, 0.12);
  THRESHOLDS.larInhaleErr = clampVal(roundTo(THRESHOLDS.larInhaleMax + 0.02, 2), 0.06, 0.15);

  // 2. 呼氣張大口錯誤閾值 (larExhaleWideErr)：基於【閉嘴】與【張大口】插值設定 (70% 處)
  THRESHOLDS.larExhaleWideErr = clampVal(roundTo(larClosed + larRange * 0.70, 2), 0.18, 0.40);

  // 3. 呼氣噘唇達標閾值 (mouthPuckerMin, mouthFunnelMin, larExhaleMin/Max)：
  // 【C.6 解決峰值努力陷阱 Peak Effort Trap】將 mouthPucker 訓練閾值固定設為 3 秒校準峰值之 70% (0.70)
  const effortDiscount = THRESHOLDS.puckerPeakEffortDiscount || 0.70;
  THRESHOLDS.mouthPuckerMin = clampVal(roundTo(cal.mouthPucker_plb * effortDiscount, 2), 0.15, 0.70);
  THRESHOLDS.mouthFunnelMin = clampVal(roundTo(cal.mouthFunnel_plb * effortDiscount, 2), 0.15, 0.60);
  THRESHOLDS.larExhaleMin = clampVal(roundTo(Math.min(larClosed + 0.005, cal.LAR_plb * 0.35), 2), 0.02, 0.08);
  THRESHOLDS.larExhaleMax = clampVal(roundTo(Math.min(THRESHOLDS.larExhaleWideErr - 0.02, Math.max(cal.LAR_plb * 1.9, 0.18)), 2), 0.14, 0.35);

  // 4. 起肩代償警告閾值 (shoulderHikeWarn)：基於【放鬆膊頭】與【縮膊頭】耳肩距離差 ΔY_max 之 40%
  const dEyeSafe = Math.max(cal.D_eye, 0.08);
  const deltaYMax = Math.max(0.08, (cal.Dist_relax - cal.Dist_shrug) / dEyeSafe);
  THRESHOLDS.shoulderHikeWarn = clampVal(roundTo(deltaYMax * 0.40, 2), 0.05, 0.25);
  THRESHOLDS.shoulderHikeNormal = clampVal(roundTo(THRESHOLDS.shoulderHikeWarn * 0.83, 2), 0.04, 0.22);

  syncThresholdsToDebugDrawer();
}

export function syncThresholdsToDebugDrawer() {
  if (dom.dbgRangeLarInMax) {
    dom.dbgRangeLarInMax.value = THRESHOLDS.larInhaleMax;
    dom.dbgLblLarInMax.textContent = THRESHOLDS.larInhaleMax.toFixed(2);
  }
  if (dom.dbgRangeJawInMax) {
    dom.dbgRangeJawInMax.value = THRESHOLDS.jawOpenInhaleMax;
    dom.dbgLblJawInMax.textContent = THRESHOLDS.jawOpenInhaleMax.toFixed(2);
  }
  if (dom.dbgRangeLarWideErr) {
    dom.dbgRangeLarWideErr.value = THRESHOLDS.larExhaleWideErr;
    dom.dbgLblLarWideErr.textContent = THRESHOLDS.larExhaleWideErr.toFixed(2);
  }
  if (dom.dbgRangeLarExMin) {
    dom.dbgRangeLarExMin.value = THRESHOLDS.larExhaleMin;
    dom.dbgLblLarExMin.textContent = THRESHOLDS.larExhaleMin.toFixed(2);
  }
  if (dom.dbgRangeLarExMax) {
    dom.dbgRangeLarExMax.value = THRESHOLDS.larExhaleMax;
    dom.dbgLblLarExMax.textContent = THRESHOLDS.larExhaleMax.toFixed(2);
  }
  if (dom.dbgRangePuckerMin) {
    dom.dbgRangePuckerMin.value = THRESHOLDS.mouthPuckerMin;
    dom.dbgLblPuckerMin.textContent = THRESHOLDS.mouthPuckerMin.toFixed(2);
  }
  if (dom.dbgRangeFunnelMin) {
    dom.dbgRangeFunnelMin.value = THRESHOLDS.mouthFunnelMin;
    dom.dbgLblFunnelMin.textContent = THRESHOLDS.mouthFunnelMin.toFixed(2);
  }
  if (dom.dbgRangeShoulderMax) {
    dom.dbgRangeShoulderMax.value = THRESHOLDS.shoulderHikeWarn;
    dom.dbgLblShoulderMax.textContent = THRESHOLDS.shoulderHikeWarn.toFixed(2);
  }
}

/**
 * 【B.4 五步個人化基準校準總結面板】
 */
export function showCalibrationConfirmation() {
  computeAndSyncDynamicThresholds();
  const cal = AppState.calibration;
  cal.subState = 'SUMMARY';
  AppState.isCalibConfirming = true;

  if (dom.calibStepWorkspace) dom.calibStepWorkspace.classList.add('hidden');
  if (dom.calibVideoBox) dom.calibVideoBox.classList.add('hidden');
  if (dom.calibConfirmOverlay) dom.calibConfirmOverlay.classList.remove('hidden');

  const badgeHtml = (step) => cal.stepSource[step] === 'measured'
    ? `<span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-emerald-100 text-[#2E7D32]">實測 (${cal.stepSampleCounts[step]}幀)</span>`
    : `<span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-100 text-amber-800">預設值兜底</span>`;

  if (dom.calibSummaryMetrics) {
    dom.calibSummaryMetrics.innerHTML = `
      <div class="space-y-1.5 text-left">
        <div class="flex flex-wrap items-center justify-between gap-1 bg-white p-2 rounded-xl border border-slate-200">
          <div>
            <span class="font-bold text-slate-800">1. 【閉嘴】</span>
            <span class="text-slate-600 ml-1">LAR_closed: <b>${cal.LAR_closed.toFixed(3)}</b> · jawOpen: <b>${cal.jawOpen_closed.toFixed(3)}</b> · D_eye: <b>${cal.D_eye.toFixed(3)}</b></span>
          </div>
          <div class="flex items-center gap-1.5">
            ${badgeHtml(1)}
            <button type="button" data-retest-step="1" class="btn-retest-single px-2 py-0.5 rounded bg-teal-50 hover:bg-teal-100 text-teal-800 font-bold text-[11px] border border-teal-200 cursor-pointer">🔄 重測</button>
          </div>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-1 bg-white p-2 rounded-xl border border-slate-200">
          <div>
            <span class="font-bold text-slate-800">2. 【張大口】</span>
            <span class="text-slate-600 ml-1">LAR_open: <b>${cal.LAR_open.toFixed(3)}</b> · jawOpen_open: <b>${cal.jawOpen_open.toFixed(3)}</b></span>
          </div>
          <div class="flex items-center gap-1.5">
            ${badgeHtml(2)}
            <button type="button" data-retest-step="2" class="btn-retest-single px-2 py-0.5 rounded bg-teal-50 hover:bg-teal-100 text-teal-800 font-bold text-[11px] border border-teal-200 cursor-pointer">🔄 重測</button>
          </div>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-1 bg-white p-2 rounded-xl border border-slate-200">
          <div>
            <span class="font-bold text-slate-800">3. 【噘唇】</span>
            <span class="text-slate-600 ml-1">LAR_plb: <b>${cal.LAR_plb.toFixed(3)}</b> · Pucker: <b>${cal.mouthPucker_plb.toFixed(2)}</b> · Funnel: <b>${cal.mouthFunnel_plb.toFixed(2)}</b></span>
          </div>
          <div class="flex items-center gap-1.5">
            ${badgeHtml(3)}
            <button type="button" data-retest-step="3" class="btn-retest-single px-2 py-0.5 rounded bg-teal-50 hover:bg-teal-100 text-teal-800 font-bold text-[11px] border border-teal-200 cursor-pointer">🔄 重測</button>
          </div>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-1 bg-white p-2 rounded-xl border border-slate-200">
          <div>
            <span class="font-bold text-slate-800">4. 【縮膊頭】</span>
            <span class="text-slate-600 ml-1">聳肩耳肩距離 Dist_shrug: <b>${cal.Dist_shrug.toFixed(3)}</b></span>
          </div>
          <div class="flex items-center gap-1.5">
            ${badgeHtml(4)}
            <button type="button" data-retest-step="4" class="btn-retest-single px-2 py-0.5 rounded bg-teal-50 hover:bg-teal-100 text-teal-800 font-bold text-[11px] border border-teal-200 cursor-pointer">🔄 重測</button>
          </div>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-1 bg-white p-2 rounded-xl border border-slate-200">
          <div>
            <span class="font-bold text-slate-800">5. 【放鬆膊頭】</span>
            <span class="text-slate-600 ml-1">沉肩基準 Dist_relax: <b>${cal.Dist_relax.toFixed(3)}</b> · yShoulderBase: <b>${cal.yShoulderBase.toFixed(3)}</b></span>
          </div>
          <div class="flex items-center gap-1.5">
            ${badgeHtml(5)}
            <button type="button" data-retest-step="5" class="btn-retest-single px-2 py-0.5 rounded bg-teal-50 hover:bg-teal-100 text-teal-800 font-bold text-[11px] border border-teal-200 cursor-pointer">🔄 重測</button>
          </div>
        </div>
      </div>
    `;

    // 綁定單步重測按鈕
    const retestBtns = dom.calibSummaryMetrics.querySelectorAll('.btn-retest-single');
    retestBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const targetStep = parseInt(btn.getAttribute('data-retest-step'), 10);
        AppState.calibration.retestSingleStepMode = true;
        enterCalibrationStepWaiting(targetStep);
      });
    });
  }

  if (dom.calibSummaryThresholds) {
    dom.calibSummaryThresholds.innerHTML = `
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-2 text-left text-[11px] font-mono">
        <div class="bg-teal-50/70 p-2 rounded-lg border border-teal-200">
          <span class="text-slate-500 block">吸氣閉口上限</span>
          <span class="font-extrabold text-[#2E7D32]">LAR ≤ ${THRESHOLDS.larInhaleMax.toFixed(2)} | Jaw &lt; ${THRESHOLDS.jawOpenInhaleMax.toFixed(2)}</span>
        </div>
        <div class="bg-teal-50/70 p-2 rounded-lg border border-teal-200">
          <span class="text-slate-500 block">呼氣噘唇達標閾值 (70% 努力折扣)</span>
          <span class="font-extrabold text-[#2E7D32]">Pucker ≥ ${THRESHOLDS.mouthPuckerMin.toFixed(2)} | Funnel ≥ ${THRESHOLDS.mouthFunnelMin.toFixed(2)}</span>
        </div>
        <div class="bg-teal-50/70 p-2 rounded-lg border border-teal-200">
          <span class="text-slate-500 block">呼氣 LAR 範圍 / 張口錯誤</span>
          <span class="font-extrabold text-teal-900">${THRESHOLDS.larExhaleMin.toFixed(2)}–${THRESHOLDS.larExhaleMax.toFixed(2)} (錯誤 &gt; ${THRESHOLDS.larExhaleWideErr.toFixed(2)})</span>
        </div>
        <div class="col-span-2 sm:col-span-3 bg-emerald-50/80 p-2 rounded-lg border border-emerald-200 flex justify-between items-center">
          <span class="text-slate-600 font-sans font-semibold">起肩代償警告閾值 (shoulderHikeWarn · 40% ΔY_max)</span>
          <span class="font-extrabold text-rose-600">ΔY_rel &gt; ${THRESHOLDS.shoulderHikeWarn.toFixed(2)} (已同步至調試面板)</span>
        </div>
      </div>
    `;
  }

  speakText("五步個人化基準校準完成，請確認數據並點擊開始訓練", true);
}

/**
 * 校準模式即時視訊推論與畫布渲染迴圈
 */
export function calibFrameLoop() {
  if (AppState.currentState !== STATES.CALIBRATING) {
    calibLoopRunning = false;
    return;
  }

  const cal = AppState.calibration;
  const isCollecting = (cal.subState === 'COUNTDOWN');

  let detections = null;
  if (AppState.isDemoMode) {
    detections = generateSimulatedDetections(performance.now());
  } else if (dom.calibVideo && dom.calibVideo.readyState >= 2 && AppState.faceLandmarker && AppState.poseLandmarker) {
    try {
      const ts = getNextTimestamp();
      const faceResult = AppState.faceLandmarker.detectForVideo(dom.calibVideo, ts);
      const poseResult = AppState.poseLandmarker.detectForVideo(dom.calibVideo, ts);
      detections = { faceResult, poseResult };
    } catch (e) {
      console.warn("校準幀運算略過:", e);
    }
  }

  if (detections) {
    const { faceResult, poseResult } = detections;
    const hasFace = !!(faceResult && faceResult.faceLandmarks && faceResult.faceLandmarks.length > 0);
    const hasPose = !!(poseResult && poseResult.landmarks && poseResult.landmarks.length > 0);

    let dEye = cal.D_eye;
    let lar = 0.04;
    let jawOpen = 0.01;
    let mouthPucker = 0.10;
    let mouthFunnel = 0.10;
    let distEarShoulder = cal.Dist_relax;
    let yShoulderSmooth = cal.yShoulderBase;

    if (hasFace) {
      const face = faceResult.faceLandmarks[0];
      dEye = calculateDEye(face);
      const larRaw = calculateLAR(face);
      const bs = extractBlendshapes(faceResult.faceBlendshapes);
      const smoothedFace = smoothFacialSignalsEMA(larRaw, bs.jawOpen, bs.mouthPucker, bs.mouthFunnel);
      lar = smoothedFace.larFiltered;
      jawOpen = smoothedFace.jawOpenFiltered;
      mouthPucker = smoothedFace.mouthPuckerFiltered;
      mouthFunnel = smoothedFace.mouthFunnelFiltered;

      AppState.currentMetrics.dEye = dEye;
      AppState.currentMetrics.larRaw = larRaw;
      AppState.currentMetrics.lar = lar;
      AppState.currentMetrics.jawOpenRaw = bs.jawOpen;
      AppState.currentMetrics.jawOpen = jawOpen;
      AppState.currentMetrics.mouthPuckerRaw = bs.mouthPucker;
      AppState.currentMetrics.mouthPucker = mouthPucker;
      AppState.currentMetrics.mouthFunnelRaw = bs.mouthFunnel;
      AppState.currentMetrics.mouthFunnel = mouthFunnel;
      AppState.currentMetrics.deltaLar = smoothedFace.deltaLar;
      AppState.currentMetrics.deltaJawOpen = smoothedFace.deltaJawOpen;
      AppState.currentMetrics.deltaMouthPucker = smoothedFace.deltaMouthPucker;
      AppState.currentMetrics.hasFace = true;
    } else {
      AppState.currentMetrics.hasFace = false;
    }

    if (hasPose) {
      const pose = poseResult.landmarks[0];
      const emaRes = smoothShoulderLandmarksEMA(pose, THRESHOLDS.emaAlpha);
      yShoulderSmooth = emaRes.yShoulderSmooth;
      distEarShoulder = calculateEarShoulderDistance(pose, emaRes.y11Smooth, emaRes.y12Smooth);

      AppState.currentMetrics.y11Smooth = emaRes.y11Smooth;
      AppState.currentMetrics.y12Smooth = emaRes.y12Smooth;
      AppState.currentMetrics.yShoulderCurr = yShoulderSmooth;
      AppState.currentMetrics.distCurr = distEarShoulder;
      AppState.currentMetrics.hasPose = true;
    } else {
      AppState.currentMetrics.hasPose = false;
    }

    // 若處於 3 秒倒數採集階段，收集樣本
    if (isCollecting) {
      if (hasFace) {
        cal.stepSamples.dEye.push(dEye);
        cal.stepSamples.lar.push(lar);
        cal.stepSamples.jawOpen.push(jawOpen);
        cal.stepSamples.mouthPucker.push(mouthPucker);
        cal.stepSamples.mouthFunnel.push(mouthFunnel);
      }
      if (hasPose) {
        cal.stepSamples.distEarShoulder.push(distEarShoulder);
        cal.stepSamples.yShoulder.push(yShoulderSmooth);
      }
    }

    // 更新畫面底部「即時關鍵指標讀數預覽」
    if (dom.calibLiveReadout) {
      if (!hasFace && !hasPose) {
        dom.calibLiveReadout.textContent = "⚠️ 未偵測到完整人臉與雙肩，請調整鏡頭角度";
      } else {
        const s = cal.currentStep;
        if (s === 1 || s === 2) {
          dom.calibLiveReadout.textContent = `即時指標預覽 · LAR: ${lar.toFixed(3)} | jawOpen: ${jawOpen.toFixed(3)} | D_eye: ${dEye.toFixed(3)}`;
        } else if (s === 3) {
          dom.calibLiveReadout.textContent = `即時指標預覽 · LAR: ${lar.toFixed(3)} | Pucker: ${mouthPucker.toFixed(2)} | Funnel: ${mouthFunnel.toFixed(2)}`;
        } else {
          dom.calibLiveReadout.textContent = `即時指標預覽 · 耳肩距離 Dist: ${distEarShoulder.toFixed(3)} | 雙肩高度 Y: ${yShoulderSmooth.toFixed(3)} | D_eye: ${dEye.toFixed(3)}`;
        }
      }
    }

    renderCalibrationCanvas(detections);
    updateDebugReadouts();
  }

  requestAnimationFrame(calibFrameLoop);
}

export function renderCalibrationCanvas(detections) {
  if (!dom.calibCanvas) return;
  const canvas = dom.calibCanvas;
  const rect = canvas.parentElement ? canvas.parentElement.getBoundingClientRect() : { width: 640, height: 360 };
  if (canvas.width !== Math.floor(rect.width) || canvas.height !== Math.floor(rect.height)) {
    canvas.width = Math.floor(rect.width) || 640;
    canvas.height = Math.floor(rect.height) || 360;
  }
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  if (AppState.isDemoMode) {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, w, h);
  }

  if (!detections) return;
  const { faceResult, poseResult } = detections;

  if (poseResult && poseResult.landmarks && poseResult.landmarks.length > 0) {
    const pose = poseResult.landmarks[0];
    const y11 = AppState.ema.initialized ? AppState.ema.y11Prev : pose[11].y;
    const y12 = AppState.ema.initialized ? AppState.ema.y12Prev : pose[12].y;
    const p11 = { x: pose[11].x * w, y: y11 * h };
    const p12 = { x: pose[12].x * w, y: y12 * h };

    // 繪製耳肩相對基準連線 (Landmark 7->11, 8->12)
    if (pose[7] && pose[8]) {
      const p7 = { x: pose[7].x * w, y: pose[7].y * h };
      const p8 = { x: pose[8].x * w, y: pose[8].y * h };
      ctx.save();
      ctx.strokeStyle = 'rgba(77, 182, 172, 0.65)';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(p7.x, p7.y);
      ctx.lineTo(p11.x, p11.y);
      ctx.moveTo(p8.x, p8.y);
      ctx.lineTo(p12.x, p12.y);
      ctx.stroke();
      ctx.restore();
    }

    const isShoulderStep = AppState.calibration.currentStep >= 4;
    ctx.save();
    ctx.strokeStyle = isShoulderStep ? '#FF7043' : '#4DB6AC';
    ctx.lineWidth = isShoulderStep ? 5 : 4;
    ctx.beginPath();
    ctx.moveTo(p11.x, p11.y);
    ctx.lineTo(p12.x, p12.y);
    ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.arc(p11.x, p11.y, 6, 0, Math.PI * 2);
    ctx.arc(p12.x, p12.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  if (faceResult && faceResult.faceLandmarks && faceResult.faceLandmarks.length > 0) {
    const face = faceResult.faceLandmarks[0];
    if (AppState.isDemoMode) {
      ctx.fillStyle = 'rgba(77, 182, 172, 0.5)';
      const ovalIndices = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
      ovalIndices.forEach(idx => {
        if (face[idx]) {
          ctx.beginPath();
          ctx.arc(face[idx].x * w, face[idx].y * h, 2, 0, Math.PI * 2);
          ctx.fill();
        }
      });
    }

    const lipPoints = [78, 13, 308, 14].map(idx => ({
      x: face[idx].x * w,
      y: face[idx].y * h
    }));
    const isMouthStep = AppState.calibration.currentStep <= 3;
    ctx.save();
    ctx.strokeStyle = isMouthStep ? '#4DB6AC' : 'rgba(77, 182, 172, 0.75)';
    ctx.fillStyle = isMouthStep ? 'rgba(77, 182, 172, 0.25)' : 'transparent';
    ctx.lineWidth = isMouthStep ? 3.5 : 2.5;
    ctx.beginPath();
    ctx.moveTo(lipPoints[0].x, lipPoints[0].y);
    for (let i = 1; i < lipPoints.length; i++) {
      ctx.lineTo(lipPoints[i].x, lipPoints[i].y);
    }
    ctx.closePath();
    if (isMouthStep) ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

