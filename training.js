/**
 * 舒呼(SootheBreath) v9.2 ES6 Module — training.js
 * 實時訓練主迴圈、單一 rAF 整合、MediaPipe 20Hz 交錯推論、DOM Dirty-Check 節流與精準吹風觸發/中斷引擎
 *
 * v9.2 評分與互動觸發修復重點 (Fix 2, Fix 3 & Fix 4):
 * - [Fix 2] 修正 3D 互動模式吹風觸發與中途即時斷開邏輯 (Real-Time Hold & Release)：
 *           1. rawInhaleMotionScore 與 rawExhaleMotionScore 直接取自未經動量豁免之 getInhaleScore() 與 getExhaleScore()。
 *           2. 吸氣階段需同時達成「合口時間比例 >= 70%」且「無聳肩時間比例 >= 70%」才取得吹氣資格 (inhaleQualifiedForBlow = true)。
 *           3. 呼氣階段需連續 >= 0.10s (EXHALE_BLOW_CONFIRM_SEC) 維持真實噘唇且無聳肩才觸發 startInteractiveBlowing()；
 *              一旦呼氣中途張大口、放開噘唇或聳肩連續 >= 0.20s (EXHALE_BLOW_CUTOFF_SEC)，即刻呼叫 stopInteractiveBlowing() 停止吹風。
 * - [Fix 3] 開頭 400ms 緩衝期標記傳入 accumulateFrameScore，避免緩衝期稀釋錯誤時間比例；收緊呼氣 70% 柔性過渡條件。
 * - [Fix 4] 修復單雙幀交錯推論時重複執行 EMA 之問題：僅在 faceUpdated 為 true 時更新面部 EMA 與斜率，僅在 poseUpdated 為 true 時更新雙肩 EMA。
 */

import {
  STATES,
  PHASES,
  THRESHOLDS,
  HUMAN_IMAGES,
  INITIAL_GRACE_SECONDS,
  PHASE_ENTRY_GRACE_MS,
  PASSING_SCORE_PCT,
  INFERENCE_INTERVAL_MS,
  UI_THROTTLE_MS,
  EXHALE_BLOW_CONFIRM_SEC,
  EXHALE_BLOW_CUTOFF_SEC,
  getNextTimestamp,
  clampVal,
  AppState
} from './state.js';
import { dom, showToast } from './dom.js';
import {
  calculateDEye,
  calculateLAR,
  extractBlendshapes,
  calculateShoulderMetrics,
  smoothFacialSignalsEMA,
  getInhaleScore,
  getExhaleScore,
  applyActionMomentumExemption,
  isPlbExhaleValid,
  generateSimulatedDetections
} from './cvEngine.js';
import { speakText } from './tts.js';
import {
  resetScoringState,
  accumulateFrameScore,
  evaluateCompletedPhase,
  getHighestPriorityAlert
} from './scoring.js';
import { evaluateStickyPriorityFeedback } from './feedback.js';
import {
  initInteractive3D,
  disposeInteractive3D,
  switchInteractiveObjectMode,
  startInteractiveBlowing,
  stopInteractiveBlowing,
  renderInteractive3DFrame
} from './interactive3d.js';
import { switchViewState, updateDebugReadouts } from './uiControls.js';

// Dirty-check cache to prevent redundant DOM reflows/repaints
const domCache = {
  timerLeft: '',
  cycleCount: -1,
  phaseHint: '',
  lastUiUpdateTs: 0,
  lastDebugUpdateTs: 0
};

// ============================================================================
// 10. 實時訓練主迴圈與四大百分比指標 (Section C: STATE_TRAINING)
// ============================================================================
export function runTrainingSequence() {
  const now = performance.now();
  const targetRR = Math.max(1, AppState.targetBpm);

  AppState.training.startTime = now;
  AppState.training.lastFrameTime = now;
  AppState.training.lastInferenceTime = 0;
  AppState.training.inferenceTickCount = 0;
  AppState.training.phaseStartTime = now;
  AppState.training.cycleStartTime = now;
  AppState.ema.initialized = false;
  AppState.ema.faceInitialized = false;

  AppState.training.elapsedSeconds = 0;
  AppState.training.currentPhase = PHASES.INHALE;
  AppState.training.cycleIndex = 0;

  AppState.training.inhaleGraceCycleTriggered = 0;
  AppState.training.inhaleEntryTimestamp = now;
  AppState.training.inhaleGraceCompleted = false;
  AppState.training.exhaleGraceCycleTriggered = -1;
  AppState.training.exhaleEntryTimestamp = 0;
  AppState.training.exhaleGraceCompleted = false;

  AppState.training.isSoftTransitioning = false;
  AppState.training.softTransitionStartTime = 0;
  AppState.training.cyclesHistory = [];
  AppState.training.tInActual = 0;
  AppState.training.tExActual = 0;
  AppState.training.inhaleLipClosedTime = 0;
  AppState.training.inhaleNoShrugTime = 0;
  AppState.training.inhalePhaseTime = 0;
  AppState.training.inhaleQualifiedForBlow = false;
  AppState.training.isInteractiveBlowing = false;
  AppState.training.exhaleValidHoldSec = 0;
  AppState.training.exhaleInvalidCutoffSec = 0;
  AppState.training.avgRR = targetRR;
  AppState.training.isWarmingUp = true;

  domCache.timerLeft = '';
  domCache.cycleCount = -1;
  domCache.phaseHint = '';
  domCache.lastUiUpdateTs = 0;
  domCache.lastDebugUpdateTs = 0;

  resetScoringState();

  AppState.feedback.latchedModule = null;
  AppState.feedback.currentPriority = 5;
  AppState.feedback.currentPMessage = '';
  AppState.feedback.pendingMessage = '';
  if (dom.bottomBanner) {
    dom.bottomBanner.classList.add('hidden');
  }

  if (dom.btnPauseTrain) {
    dom.btnPauseTrain.textContent = "⏸️ 暫停訓練";
  }

  applyPrivacyModeStyles();
  applyDisplayModeStyles();
  syncCanvasDimensions();
  renderIndicatorCards();

  triggerPhaseSwitch(PHASES.INHALE, true);

  if (AppState.animFrameId) cancelAnimationFrame(AppState.animFrameId);
  AppState.animFrameId = requestAnimationFrame(trainingInferenceLoop);
}

export function syncCanvasDimensions() {
  const mode = AppState.privacyMode;
  if (dom.visionContainer && dom.trainCanvas && mode !== 'minimalist' && mode !== 'interactive') {
    dom.trainCanvas.width = dom.visionContainer.clientWidth || 640;
    dom.trainCanvas.height = dom.visionContainer.clientHeight || 480;
  }
}

export function applyPrivacyModeStyles() {
  const mode = AppState.privacyMode;
  if (dom.selectPrivacy && dom.selectPrivacy.value !== mode) {
    dom.selectPrivacy.value = mode;
  }

  const activeCls = "px-2.5 py-1 rounded-lg text-xs font-bold bg-[#4DB6AC] text-white shadow-sm transition cursor-pointer";
  const inactiveCls = "px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-600 transition cursor-pointer";

  if (dom.btnModeMirror) dom.btnModeMirror.className = mode === 'mirror' ? activeCls : inactiveCls;
  if (dom.btnModeMesh) dom.btnModeMesh.className = mode === 'privacy_mesh' ? activeCls : inactiveCls;
  if (dom.btnModeMinimal) dom.btnModeMinimal.className = mode === 'minimalist' ? activeCls : inactiveCls;
  if (dom.btnModeInteractive) dom.btnModeInteractive.className = mode === 'interactive' ? activeCls : inactiveCls;

  const isSingleColumnGuideLayout = (mode === 'minimalist' || mode === 'interactive');

  if (isSingleColumnGuideLayout) {
    if (dom.visionContainer) {
      dom.visionContainer.className = "w-px h-px opacity-0 pointer-events-none fixed -left-[9999px] overflow-hidden";
    }
    if (dom.guidancePanel) {
      dom.guidancePanel.className = "w-full flex-1 h-full bg-[#f5fafd] flex flex-col items-center justify-between p-4 md:p-6 overflow-y-auto pure-guiding-mode";
    }
    if (dom.pacerVisualArea) {
      dom.pacerVisualArea.className = "flex-1 flex flex-col items-center justify-center py-2 relative min-h-[44vh] w-full max-w-3xl mx-auto text-center";
    }
    if (dom.pacerOuterRing) {
      dom.pacerOuterRing.classList.add('pure-guiding-ring');
    }
    if (dom.pacerBall) {
      dom.pacerBall.classList.add('pure-guiding-ball');
    }
    if (dom.humanDemoBox) {
      dom.humanDemoBox.classList.add('pure-guiding-human');
    }
    if (dom.biofeedbackCardsGrid) {
      dom.biofeedbackCardsGrid.className = "w-full max-w-3xl mx-auto grid grid-cols-2 lg:grid-cols-4 gap-3";
    }
  } else {
    if (dom.visionContainer) {
      dom.visionContainer.className = "w-full md:w-[60%] h-[42vh] md:h-full relative bg-slate-900 flex items-center justify-center border-b md:border-b-0 md:border-r border-teal-100 overflow-hidden shrink-0";
    }
    if (dom.guidancePanel) {
      dom.guidancePanel.className = "w-full md:w-[40%] h-[58vh] md:h-full bg-white/90 backdrop-blur-md flex flex-col items-center justify-between p-4 md:p-5 overflow-y-auto space-y-3";
    }
    if (dom.pacerVisualArea) {
      dom.pacerVisualArea.className = "flex-1 flex flex-col items-center justify-center py-2 relative min-h-[195px] w-full text-center";
    }
    if (dom.pacerOuterRing) {
      dom.pacerOuterRing.classList.remove('pure-guiding-ring');
    }
    if (dom.pacerBall) {
      dom.pacerBall.classList.remove('pure-guiding-ball');
    }
    if (dom.humanDemoBox) {
      dom.humanDemoBox.classList.remove('pure-guiding-human');
    }
    if (dom.biofeedbackCardsGrid) {
      dom.biofeedbackCardsGrid.className = "w-full grid grid-cols-1 sm:grid-cols-2 md:grid-cols-1 lg:grid-cols-2 gap-2.5";
    }

    if (mode === 'mirror') {
      if (dom.trainVideo) dom.trainVideo.classList.remove('opacity-0');
      if (dom.trainCanvas) dom.trainCanvas.classList.remove('privacy-mesh-canvas');
      if (dom.badgeMeshMode) dom.badgeMeshMode.textContent = "🪞 實時鏡像模式 Mirror Mode";
    } else {
      if (dom.trainVideo) dom.trainVideo.classList.add('opacity-0');
      if (dom.trainCanvas) dom.trainCanvas.classList.add('privacy-mesh-canvas');
      if (dom.badgeMeshMode) {
        dom.badgeMeshMode.textContent = AppState.isDemoMode
          ? "🧪 免鏡頭模擬骨架模式 (Demo Mode)"
          : "🔒 去識別化骨架網格模式 Privacy Mesh Mode";
      }
    }
    syncCanvasDimensions();
  }
}

export function applyDisplayModeStyles() {
  const isInteractive = (AppState.displayMode === 'interactive' || AppState.privacyMode === 'interactive');
  const isHuman = (!isInteractive && AppState.displayMode === 'human');
  const isBalloon = (!isInteractive && !isHuman);
  const gender = AppState.humanGender;
  const interObj = AppState.interactiveObject || 'pinwheel';

  const idleActive = "flex-1 py-2 px-3 rounded-xl text-xs font-bold bg-[#2E7D32] text-white shadow-sm transition cursor-pointer";
  const idleInactive = "flex-1 py-2 px-3 rounded-xl text-xs font-semibold bg-white hover:bg-teal-50 text-slate-600 border border-slate-200 transition cursor-pointer";

  if (dom.btnPacerBalloon) dom.btnPacerBalloon.className = isBalloon ? idleActive : idleInactive;
  if (dom.btnPacerHuman) dom.btnPacerHuman.className = isHuman ? idleActive : idleInactive;
  if (dom.btnPacerInteractive) dom.btnPacerInteractive.className = isInteractive ? idleActive : idleInactive;

  if (dom.wrapperHumanGender) {
    dom.wrapperHumanGender.classList.toggle('hidden', !isHuman);
  }
  if (dom.btnGenderMale) dom.btnGenderMale.className = gender === 'male' ? idleActive : idleInactive;
  if (dom.btnGenderFemale) dom.btnGenderFemale.className = gender === 'female' ? idleActive : idleInactive;

  if (dom.wrapperInteractiveObject) {
    dom.wrapperInteractiveObject.classList.toggle('hidden', !isInteractive);
  }
  if (dom.btnInteractivePinwheel) dom.btnInteractivePinwheel.className = interObj === 'pinwheel' ? idleActive : idleInactive;
  if (dom.btnInteractiveDandelion) dom.btnInteractiveDandelion.className = interObj === 'dandelion' ? idleActive : idleInactive;

  const trainActive = "px-2.5 py-1 rounded-lg text-xs font-bold bg-[#2E7D32] text-white shadow-sm transition cursor-pointer";
  const trainInactive = "px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-600 transition cursor-pointer";
  if (dom.btnTrainBalloon) dom.btnTrainBalloon.className = isBalloon ? trainActive : trainInactive;
  if (dom.btnTrainMale) dom.btnTrainMale.className = (isHuman && gender === 'male') ? trainActive : trainInactive;
  if (dom.btnTrainFemale) dom.btnTrainFemale.className = (isHuman && gender === 'female') ? trainActive : trainInactive;
  if (dom.btnTrainInteractive) dom.btnTrainInteractive.className = isInteractive ? trainActive : trainInactive;

  const imgPair = HUMAN_IMAGES[gender] || HUMAN_IMAGES.male;
  if (dom.imgHumanInhale && dom.imgHumanInhale.getAttribute('src') !== imgPair.inhale) {
    dom.imgHumanInhale.setAttribute('src', imgPair.inhale);
  }
  if (dom.imgHumanExhale && dom.imgHumanExhale.getAttribute('src') !== imgPair.exhale) {
    dom.imgHumanExhale.setAttribute('src', imgPair.exhale);
  }

  if (dom.pacerOuterRing) {
    dom.pacerOuterRing.classList.toggle('hidden', !isBalloon);
  }
  if (dom.humanDemoWrapper) {
    dom.humanDemoWrapper.classList.toggle('hidden', !isHuman);
  }
  if (dom.interactive3dWrapper) {
    dom.interactive3dWrapper.classList.toggle('hidden', !isInteractive);
  }

  if (isInteractive) {
    if (AppState.currentState === STATES.TRAINING) {
      initInteractive3D(interObj);
      switchInteractiveObjectMode(interObj);
    }
  } else {
    disposeInteractive3D();
  }

  const isInhale = AppState.training.currentPhase === PHASES.INHALE;
  if (dom.imgHumanInhale && dom.imgHumanExhale) {
    dom.imgHumanInhale.classList.toggle('active-img', isInhale);
    dom.imgHumanExhale.classList.toggle('active-img', !isInhale);
  }
  if (dom.humanDemoBox) {
    dom.humanDemoBox.classList.toggle('exhale-border', !isInhale);
  }
}

// ============================================================================
// P0-1, P1-2 & Fix 4: 單一 60 FPS 訓練與 3D 渲染迴圈 + MediaPipe 20Hz 交錯推論
// ============================================================================
export function trainingInferenceLoop() {
  if (AppState.currentState !== STATES.TRAINING) return;

  const now = performance.now();
  const train = AppState.training;

  if (AppState.isPaused) {
    train.lastFrameTime = now;
    requestAnimationFrame(trainingInferenceLoop);
    return;
  }

  const dt = Math.min(0.25, Math.max(0.001, (now - (train.lastFrameTime || now)) / 1000));
  train.lastFrameTime = now;

  train.elapsedSeconds += dt;
  const elapsedTotal = train.elapsedSeconds;
  const remainingTotal = Math.max(0, AppState.totalDuration - elapsedTotal);
  const mins = Math.floor(remainingTotal / 60);
  const secs = Math.floor(remainingTotal % 60);
  const timerStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  if (timerStr !== domCache.timerLeft) {
    domCache.timerLeft = timerStr;
    dom.valTimerLeft.textContent = timerStr;
  }
  if (train.cycleIndex !== domCache.cycleCount) {
    domCache.cycleCount = train.cycleIndex;
    dom.valCycleCount.textContent = train.cycleIndex;
  }

  if (remainingTotal <= 0) {
    finalizeCurrentCycle(now, train.isSoftTransitioning);
    switchViewState(STATES.SUMMARY);
    return;
  }

  const isInteractive = (AppState.displayMode === 'interactive' || AppState.privacyMode === 'interactive');
  const shouldRunInference = (now - (train.lastInferenceTime || 0)) >= INFERENCE_INTERVAL_MS;

  // 1. MediaPipe 推論降頻 (20 FPS) 與單雙幀交錯推論 (Fix 4: 傳遞 faceUpdated / poseUpdated 標記)
  if (shouldRunInference) {
    const inferenceDt = train.lastInferenceTime > 0
      ? Math.min(0.25, Math.max(0.001, (now - train.lastInferenceTime) / 1000))
      : dt;
    train.lastInferenceTime = now;
    train.inferenceTickCount = (train.inferenceTickCount || 0) + 1;

    updateLiveRespiratoryRate(now);

    if (AppState.isDemoMode) {
      const sim = generateSimulatedDetections(now);
      AppState.lastFaceResult = sim.faceResult;
      AppState.lastPoseResult = sim.poseResult;
      processFrameDetections(sim.faceResult, sim.poseResult, now, inferenceDt, true, true);
    } else if (dom.trainVideo.readyState >= 2 && AppState.faceLandmarker && AppState.poseLandmarker) {
      try {
        const ts = getNextTimestamp();
        let faceUpdated = true;
        let poseUpdated = true;

        if (isInteractive && AppState.lastFaceResult && AppState.lastPoseResult) {
          if (train.inferenceTickCount % 2 === 1) {
            AppState.lastFaceResult = AppState.faceLandmarker.detectForVideo(dom.trainVideo, ts);
            faceUpdated = true;
            poseUpdated = false;
          } else {
            AppState.lastPoseResult = AppState.poseLandmarker.detectForVideo(dom.trainVideo, ts);
            faceUpdated = false;
            poseUpdated = true;
          }
        } else {
          AppState.lastFaceResult = AppState.faceLandmarker.detectForVideo(dom.trainVideo, ts);
          AppState.lastPoseResult = AppState.poseLandmarker.detectForVideo(dom.trainVideo, ts);
        }
        processFrameDetections(
          AppState.lastFaceResult,
          AppState.lastPoseResult,
          now,
          inferenceDt,
          faceUpdated,
          poseUpdated
        );
      } catch (e) {
        console.warn("推論幀略過:", e);
      }
    }
  }

  // 2. 呼吸節奏狀態機推進
  advanceBreathingPacer(now);

  // 3. 繪製視覺 Canvas 或驅動 60 FPS 3D 互動模式渲染
  if (isInteractive) {
    renderInteractive3DFrame(dt);
  } else if (AppState.privacyMode !== 'minimalist') {
    renderTrainingCanvas(AppState.lastFaceResult, AppState.lastPoseResult);
  }

  // 4. 僅於調試面板展開時以 150ms 節流更新讀數
  if (dom.debugDrawer && !dom.debugDrawer.classList.contains('translate-x-full')) {
    if (now - domCache.lastDebugUpdateTs >= 150) {
      domCache.lastDebugUpdateTs = now;
      updateDebugReadouts();
    }
  }

  requestAnimationFrame(trainingInferenceLoop);
}

export function updateLiveRespiratoryRate(now) {
  const train = AppState.training;
  const targetRR = Math.max(1, AppState.targetBpm);
  const targetCycleSec = Math.max(1, AppState.inhaleTarget + AppState.exhaleTarget);

  let liveAvgRR = targetRR;
  if (train.cyclesHistory.length > 0) {
    const recentCycles = train.cyclesHistory.slice(-4);
    const totalRecentDuration = recentCycles.reduce((acc, c) => acc + (c.cycleDuration || targetCycleSec), 0);
    const meanRecentRR = (recentCycles.length / Math.max(1, totalRecentDuration)) * 60;
    liveAvgRR = clampVal(meanRecentRR, 4.0, 35.0);
  } else if (train.elapsedSeconds > 1.0) {
    const currentCycleElapsed = (now - train.cycleStartTime) / 1000;
    const effectiveCycleSec = Math.max(targetCycleSec, currentCycleElapsed);
    liveAvgRR = clampVal(60 / effectiveCycleSec, 4.0, 35.0);
  }

  train.avgRR = liveAvgRR;
  if (dom.valLiveRr) {
    const nextRr = liveAvgRR.toFixed(1);
    if (dom.valLiveRr.textContent !== nextRr) {
      dom.valLiveRr.textContent = nextRr;
    }
  }
}

// ----------------------------------------------------------------------------
// 逐幀特徵點運算、全程累計時間百分比與 v9.2 互動模式實時吹風觸發/中斷邏輯
// ----------------------------------------------------------------------------
export function processFrameDetections(
  faceResult,
  poseResult,
  now = performance.now(),
  dt = 0.033,
  faceUpdated = true,
  poseUpdated = true
) {
  const m = AppState.currentMetrics;
  const cal = AppState.calibration;
  const train = AppState.training;

  m.hasFace = Boolean(faceResult && faceResult.faceLandmarks && faceResult.faceLandmarks.length > 0);
  m.hasPose = Boolean(poseResult && poseResult.landmarks && poseResult.landmarks.length > 0);

  if (!m.hasFace || !m.hasPose) {
    if (train.isInteractiveBlowing) {
      train.isInteractiveBlowing = false;
      stopInteractiveBlowing();
    }
    evaluateStickyPriorityFeedback(false);
    return;
  }

  const face = faceResult.faceLandmarks[0];
  const pose = poseResult.landmarks[0];

  // Fix 4: 僅在該幀實際更新了 FaceLandmarker (或尚未初始化) 時才執行面部 EMA 濾波，防止交錯幀重複放大斜率
  if (faceUpdated || !AppState.ema.faceInitialized) {
    m.dEye = calculateDEye(face);
    const larRaw = calculateLAR(face);
    const blendshapes = extractBlendshapes(faceResult.faceBlendshapes);
    const jawOpenRaw = blendshapes.jawOpen;
    const mouthPuckerRaw = blendshapes.mouthPucker;
    const mouthFunnelRaw = blendshapes.mouthFunnel;

    m.larRaw = larRaw;
    m.jawOpenRaw = jawOpenRaw;
    m.mouthPuckerRaw = mouthPuckerRaw;
    m.mouthFunnelRaw = mouthFunnelRaw;

    const smoothedFace = smoothFacialSignalsEMA(larRaw, jawOpenRaw, mouthPuckerRaw, mouthFunnelRaw);
    m.lar = smoothedFace.larFiltered;
    m.jawOpen = smoothedFace.jawOpenFiltered;
    m.mouthPucker = smoothedFace.mouthPuckerFiltered;
    m.mouthFunnel = smoothedFace.mouthFunnelFiltered;
    m.deltaLar = smoothedFace.deltaLar;
    m.deltaJawOpen = smoothedFace.deltaJawOpen;
    m.deltaMouthPucker = smoothedFace.deltaMouthPucker;
  } else {
    m.deltaLar = 0;
    m.deltaJawOpen = 0;
    m.deltaMouthPucker = 0;
  }

  // Fix 4: 僅在該幀實際更新了 PoseLandmarker (或尚未初始化) 時才更新雙肩 EMA
  if (poseUpdated || !AppState.ema.initialized) {
    const shoulder = calculateShoulderMetrics(pose, m.dEye, cal.distBase);
    m.y11Smooth = shoulder.y11Smooth;
    m.y12Smooth = shoulder.y12Smooth;
    m.yShoulderCurr = shoulder.yShoulderCurr;
    m.distCurr = shoulder.distCurr;
    m.deltaYRelative = shoulder.deltaYRelative;
    m.deltaYShoulder = shoulder.deltaYRelative;
    m.shoulderTilt = shoulder.shoulderTilt;
  }

  const isShoulderRelaxed = m.deltaYRelative <= THRESHOLDS.shoulderHikeWarn;
  const shoulderScore = isShoulderRelaxed
    ? 1.0
    : clampVal(1 - (m.deltaYRelative - THRESHOLDS.shoulderHikeWarn) / Math.max(THRESHOLDS.shoulderHikeWarn * 0.5, 0.02), 0, 1);
  m.shoulderScore = shoulderScore;

  // Fix 2: 先計算未經動量豁免之真實基礎動作分數 (rawInhaleMotionScore / rawExhaleMotionScore)
  const rawInhaleMotionScore = getInhaleScore(m.lar, m.jawOpen);
  const rawExhaleMotionScore = getExhaleScore(m.lar, m.mouthPucker, m.mouthFunnel);

  // Fix 1: 套用抗抖動動量豁免 (僅對 baseScore >= 0.35 且超越噪訊死區之動作生效)
  let inhaleScore = applyActionMomentumExemption(PHASES.INHALE, rawInhaleMotionScore, m.deltaLar, m.deltaMouthPucker);
  let exhaleScore = applyActionMomentumExemption(PHASES.EXHALE, rawExhaleMotionScore, m.deltaLar, m.deltaMouthPucker);

  let isInGracePeriod = false;

  if (train.currentPhase === PHASES.INHALE) {
    // Fix 2: 互動模式吸氣資格累積 — 必須使用未豁免之真實閉口分數 >= 0.70 且比例 >= 70%
    train.inhalePhaseTime = (train.inhalePhaseTime || 0) + dt;
    if (rawInhaleMotionScore >= 0.70) {
      train.inhaleLipClosedTime = (train.inhaleLipClosedTime || 0) + dt;
    }
    if (isShoulderRelaxed && shoulderScore >= 0.70) {
      train.inhaleNoShrugTime = (train.inhaleNoShrugTime || 0) + dt;
    }
    const lipClosedRatio = train.inhaleLipClosedTime / Math.max(0.001, train.inhalePhaseTime);
    const noShrugRatio = train.inhaleNoShrugTime / Math.max(0.001, train.inhalePhaseTime);
    train.inhaleQualifiedForBlow = (lipClosedRatio >= 0.70) && (noShrugRatio >= 0.70);

    // 雙向 400ms 階段轉換緩衝期
    if (!train.inhaleGraceCompleted) {
      if (train.inhaleGraceCycleTriggered === train.cycleIndex && (now - train.inhaleEntryTimestamp) <= PHASE_ENTRY_GRACE_MS) {
        isInGracePeriod = true;
        if (inhaleScore >= 0.35) {
          inhaleScore = 1.0;
        }
      } else {
        train.inhaleGraceCompleted = true;
      }
    }
    m.inhaleScore = inhaleScore;
  } else {
    // 呼氣階段 (EXHALE)
    // Fix 2: 實時呼氣確認與中途錯誤即刻斷開吹風機制 (Real-Time Hold & Release)
    const isPursedLipExhaleValidNow =
      (rawExhaleMotionScore >= 0.70 || isPlbExhaleValid(m.lar, m.mouthPucker, m.mouthFunnel)) &&
      isShoulderRelaxed &&
      (shoulderScore >= 0.70);

    if (isPursedLipExhaleValidNow) {
      train.exhaleValidHoldSec = (train.exhaleValidHoldSec || 0) + dt;
      train.exhaleInvalidCutoffSec = 0;
      if (!train.isInteractiveBlowing && train.inhaleQualifiedForBlow && train.exhaleValidHoldSec >= EXHALE_BLOW_CONFIRM_SEC) {
        train.isInteractiveBlowing = true;
        startInteractiveBlowing();
      }
    } else {
      train.exhaleInvalidCutoffSec = (train.exhaleInvalidCutoffSec || 0) + dt;
      train.exhaleValidHoldSec = 0;
      // 若使用者於呼氣中途張大口、停止噘唇或聳肩代償超過 EXHALE_BLOW_CUTOFF_SEC (0.20s)，即刻停止吹風！
      if (train.isInteractiveBlowing && train.exhaleInvalidCutoffSec >= EXHALE_BLOW_CUTOFF_SEC) {
        train.isInteractiveBlowing = false;
        stopInteractiveBlowing();
      }
    }

    // 雙向 400ms 階段轉換緩衝期
    if (!train.exhaleGraceCompleted) {
      if (train.exhaleGraceCycleTriggered === train.cycleIndex && (now - train.exhaleEntryTimestamp) <= PHASE_ENTRY_GRACE_MS) {
        isInGracePeriod = true;
        if (exhaleScore >= 0.35) {
          exhaleScore = 1.0;
        }
      } else {
        train.exhaleGraceCompleted = true;
      }
    }

    const phaseElapsed = (now - train.phaseStartTime) / 1000;
    const isOver70Pct = phaseElapsed >= (AppState.exhaleTarget * THRESHOLDS.earlyExhaleRatio);
    // Fix 3: 收緊呼氣 70% 提前達標條件，需當前呼氣有效比例 >= 70% 且無聳肩才允許柔性過渡
    const isGoodPlbDuration = (train.tExActual >= (phaseElapsed * 0.70)) && isShoulderRelaxed;

    if (!train.isSoftTransitioning && isOver70Pct && isGoodPlbDuration && exhaleScore < 0.70) {
      train.isSoftTransitioning = true;
      train.softTransitionStartTime = now;

      const currentProgress = Math.min(1, phaseElapsed / AppState.exhaleTarget);
      train.softTransitionStartScale = 1.30 - (currentProgress * 0.45);

      if (dom.pillPhase) {
        dom.pillPhase.textContent = "✨ 呼氣達標 · 準備吸氣";
        dom.pillPhase.className = "px-3.5 py-1.5 rounded-xl font-bold text-xs md:text-sm bg-[#4DB6AC] text-white shadow-sm";
      }
    }

    if (train.isSoftTransitioning) {
      exhaleScore = 1.0;
    }
    m.exhaleScore = exhaleScore;
  }

  train.isWarmingUp = (train.elapsedSeconds < INITIAL_GRACE_SECONDS);
  accumulateFrameScore(
    train.currentPhase,
    dt,
    inhaleScore,
    exhaleScore,
    shoulderScore,
    isShoulderRelaxed,
    isInGracePeriod
  );

  const targetRR = Math.max(1, AppState.targetBpm);
  const actualRR = train.avgRR;
  train.pctRr = clampVal(Math.max(0, Math.round((1 - Math.abs(actualRR - targetRR) / targetRR) * 100)), 0, 100);

  if (now - domCache.lastUiUpdateTs >= UI_THROTTLE_MS || domCache.lastUiUpdateTs === 0) {
    domCache.lastUiUpdateTs = now;
    renderIndicatorCards();
  }
  evaluateStickyPriorityFeedback(true);
}

// ----------------------------------------------------------------------------
// P1-2: 節奏球 / 真人示範 / 3D 互動模式推進 (互動模式下跳過隱藏氣球之 DOM 重排)
// ----------------------------------------------------------------------------
export function advanceBreathingPacer(now) {
  const train = AppState.training;
  const phaseElapsed = (now - train.phaseStartTime) / 1000;
  const isInteractive = (AppState.displayMode === 'interactive' || AppState.privacyMode === 'interactive');
  const isHuman = (!isInteractive && AppState.displayMode === 'human');

  if (train.currentPhase === PHASES.INHALE) {
    const progress = Math.min(1, phaseElapsed / AppState.inhaleTarget);
    const secsLeft = Math.max(0, AppState.inhaleTarget - phaseElapsed).toFixed(1);
    const nextHint = `閉口由鼻吸氣 (${secsLeft}s) · 雙肩保持下沉`;

    if (dom.pacerPhaseHint && domCache.phaseHint !== nextHint) {
      domCache.phaseHint = nextHint;
      dom.pacerPhaseHint.textContent = nextHint;
    }

    if (!isInteractive) {
      if (isHuman) {
        if (dom.humanActionText && dom.humanActionText.textContent !== "用鼻吸氣") dom.humanActionText.textContent = "用鼻吸氣";
        if (dom.humanSecondsText && dom.humanSecondsText.textContent !== `${secsLeft}s`) dom.humanSecondsText.textContent = `${secsLeft}s`;
      } else {
        if (dom.pacerActionText.textContent !== "用鼻吸氣") dom.pacerActionText.textContent = "用鼻吸氣";
        if (dom.pacerSecondsText.textContent !== `${secsLeft}s`) dom.pacerSecondsText.textContent = `${secsLeft}s`;
        const scale = 0.85 + (progress * 0.45);
        dom.pacerBall.style.transform = `scale(${scale})`;
      }
    }

    if (phaseElapsed >= AppState.inhaleTarget) {
      evaluateCompletedPhase(PHASES.INHALE, train.elapsedSeconds);
      triggerPhaseSwitch(PHASES.EXHALE);
    }
  } else {
    if (train.isSoftTransitioning) {
      const softDuration = 0.35;
      const softElapsed = (now - train.softTransitionStartTime) / 1000;
      const softProgress = Math.min(1, softElapsed / softDuration);

      const nextHint = "呼氣已達標完成 · 平順進入下一次吸氣";
      if (dom.pacerPhaseHint && domCache.phaseHint !== nextHint) {
        domCache.phaseHint = nextHint;
        dom.pacerPhaseHint.textContent = nextHint;
      }

      if (!isInteractive) {
        const startScale = train.softTransitionStartScale || 0.95;
        const scale = startScale - (startScale - 0.85) * softProgress;
        dom.pacerActionText.textContent = "合格呼氣完成";
        dom.pacerSecondsText.textContent = "平順過渡";
        if (dom.humanActionText) dom.humanActionText.textContent = "合格呼氣完成";
        if (dom.humanSecondsText) dom.humanSecondsText.textContent = "平順過渡";
        dom.pacerBall.style.transform = `scale(${scale})`;

        if (dom.imgHumanInhale && dom.imgHumanExhale) {
          dom.imgHumanInhale.classList.add('active-img');
          dom.imgHumanExhale.classList.remove('active-img');
        }
      }

      if (softProgress >= 1) {
        evaluateCompletedPhase(PHASES.EXHALE, train.elapsedSeconds);
        finalizeCurrentCycle(now, true);
        train.cycleIndex++;
        train.cycleStartTime = now;
        triggerPhaseSwitch(PHASES.INHALE);
      }
      return;
    }

    const progress = Math.min(1, phaseElapsed / AppState.exhaleTarget);
    const secsLeft = Math.max(0, AppState.exhaleTarget - phaseElapsed).toFixed(1);
    const nextHint = `嘴唇噘起如吹蠟燭 (${secsLeft}s) · 均勻慢呼`;

    if (dom.pacerPhaseHint && domCache.phaseHint !== nextHint) {
      domCache.phaseHint = nextHint;
      dom.pacerPhaseHint.textContent = nextHint;
    }

    if (!isInteractive) {
      if (isHuman) {
        if (dom.humanActionText && dom.humanActionText.textContent !== "噘唇吹氣") dom.humanActionText.textContent = "噘唇吹氣";
        if (dom.humanSecondsText && dom.humanSecondsText.textContent !== `${secsLeft}s`) dom.humanSecondsText.textContent = `${secsLeft}s`;
      } else {
        if (dom.pacerActionText.textContent !== "噘唇吹氣") dom.pacerActionText.textContent = "噘唇吹氣";
        if (dom.pacerSecondsText.textContent !== `${secsLeft}s`) dom.pacerSecondsText.textContent = `${secsLeft}s`;
        const scale = 1.30 - (progress * 0.45);
        dom.pacerBall.style.transform = `scale(${scale})`;
      }
    }

    if (phaseElapsed >= AppState.exhaleTarget) {
      evaluateCompletedPhase(PHASES.EXHALE, train.elapsedSeconds);
      finalizeCurrentCycle(now, false);
      train.cycleIndex++;
      train.cycleStartTime = now;
      triggerPhaseSwitch(PHASES.INHALE);
    }
  }
}

export function triggerPhaseSwitch(newPhase, isInitial = false) {
  const now = performance.now();
  const train = AppState.training;
  train.currentPhase = newPhase;
  train.phaseStartTime = now;
  train.isSoftTransitioning = false;
  train.softTransitionStartTime = 0;

  if (newPhase === PHASES.INHALE) {
    stopInteractiveBlowing();
    train.isInteractiveBlowing = false;
    train.inhaleLipClosedTime = 0;
    train.inhaleNoShrugTime = 0;
    train.inhalePhaseTime = 0;
    train.inhaleQualifiedForBlow = false;
    train.exhaleValidHoldSec = 0;
    train.exhaleInvalidCutoffSec = 0;

    if (train.inhaleGraceCycleTriggered !== train.cycleIndex) {
      train.inhaleGraceCycleTriggered = train.cycleIndex;
      train.inhaleEntryTimestamp = now;
      train.inhaleGraceCompleted = false;
    }
  } else if (newPhase === PHASES.EXHALE) {
    train.exhaleValidHoldSec = 0;
    train.exhaleInvalidCutoffSec = 0;

    if ((train.inhalePhaseTime || 0) > 0.05) {
      const lipClosedRatio = (train.inhaleLipClosedTime || 0) / train.inhalePhaseTime;
      const noShrugRatio = (train.inhaleNoShrugTime || 0) / train.inhalePhaseTime;
      train.inhaleQualifiedForBlow = (lipClosedRatio >= 0.70) && (noShrugRatio >= 0.70);
    } else {
      const m = AppState.currentMetrics;
      train.inhaleQualifiedForBlow = (getInhaleScore(m.lar, m.jawOpen) >= 0.70) && (m.shoulderScore >= 0.70);
    }

    if (train.exhaleGraceCycleTriggered !== train.cycleIndex) {
      train.exhaleGraceCycleTriggered = train.cycleIndex;
      train.exhaleEntryTimestamp = now;
      train.exhaleGraceCompleted = false;
    }
  }

  const isInhale = newPhase === PHASES.INHALE;
  const isMinimal = (AppState.privacyMode === "minimalist" || AppState.privacyMode === "interactive");
  if (dom.pacerBall) {
    dom.pacerBall.className = `w-32 h-32 md:w-36 md:h-36 ${isMinimal ? "pure-guiding-ball " : ""}rounded-full ${isInhale ? "pacer-inhale-style" : "pacer-exhale-style"} flex flex-col items-center justify-center text-white font-bold transition-transform duration-100`;
  }
  if (dom.imgHumanInhale && dom.imgHumanExhale) {
    dom.imgHumanInhale.classList.toggle('active-img', isInhale);
    dom.imgHumanExhale.classList.toggle('active-img', !isInhale);
  }
  if (dom.humanDemoBox) {
    dom.humanDemoBox.classList.toggle('exhale-border', !isInhale);
  }

  if (isInhale) {
    dom.pillPhase.textContent = "👃 鼻吸氣階段";
    dom.pillPhase.className = "px-3.5 py-1.5 rounded-xl font-bold text-xs md:text-sm bg-[#4DB6AC] text-white shadow-sm";
    if (!isInitial) {
      speakText("閉口，用鼻吸氣", true);
    } else {
      speakText("訓練開始，請閉口用鼻吸氣", true);
    }
  } else {
    dom.pillPhase.textContent = "👄 噘唇呼氣階段";
    dom.pillPhase.className = "px-3.5 py-1.5 rounded-xl font-bold text-xs md:text-sm bg-[#FF7043] text-white shadow-sm";
    speakText("慢慢噘唇呼氣", true);
  }

  renderIndicatorCards();
}

export function finalizeCurrentCycle(now = performance.now(), wasSoftTransition = false) {
  const train = AppState.training;
  const cycleDuration = Math.max(0.5, (now - train.cycleStartTime) / 1000);
  const tIn = Math.max(0.1, train.tInActual);
  const tEx = Math.max(0, train.tExActual);

  if (tIn > 0.2 || tEx > 0.2 || train.elapsedSeconds > 2) {
    const ratio = roundTo(tEx / Math.max(0.4, tIn), 2);
    const plbSuccess = wasSoftTransition || (tEx >= (AppState.exhaleTarget * 0.55));
    train.cyclesHistory.push({
      cycleNumber: train.cyclesHistory.length + 1,
      tIn: roundTo(tIn, 2),
      tEx: roundTo(tEx, 2),
      ratio,
      cycleDuration: roundTo(cycleDuration, 2),
      plbSuccess
    });

    updateLiveRespiratoryRate(now);
  }

  train.tInActual = 0;
  train.tExActual = 0;
}

export function applyModuleCardStyle(cardEl, stateEl, pctEl, pctVal, isLatchedTarget = false, inAlertSchedule = false) {
  if (!cardEl || !stateEl || !pctEl) return;

  const clamped = clampVal(Math.round(pctVal ?? 100), 0, 100);
  const nextPctText = `${clamped}%`;
  if (pctEl.textContent !== nextPctText) {
    pctEl.textContent = nextPctText;
  }

  let nextStateText, nextStateCls, nextPctCls, nextCardCls;
  if (!inAlertSchedule && clamped >= PASSING_SCORE_PCT) {
    nextStateText = "合格達標";
    nextStateCls = "text-xs md:text-sm font-extrabold text-[#2E7D32]";
    nextPctCls = "text-2xl md:text-3xl font-black font-mono text-[#2E7D32]";
    nextCardCls = "p-3.5 rounded-2xl bg-emerald-50/85 border border-emerald-200 flex items-center justify-between transition-all shadow-sm";
  } else {
    nextStateText = isLatchedTarget ? "需要改善 (優先修正)" : "需要改善";
    nextStateCls = "text-xs md:text-sm font-extrabold text-rose-600";
    nextPctCls = "text-2xl md:text-3xl font-black font-mono text-rose-600";
    const pulseCls = isLatchedTarget ? " shoulder-alert-active" : "";
    nextCardCls = `p-3.5 rounded-2xl bg-rose-50/90 border border-rose-300 flex items-center justify-between transition-all shadow-sm${pulseCls}`;
  }

  if (stateEl.textContent !== nextStateText) stateEl.textContent = nextStateText;
  if (stateEl.className !== nextStateCls) stateEl.className = nextStateCls;
  if (pctEl.className !== nextPctCls) pctEl.className = nextPctCls;
  if (cardEl.className !== nextCardCls) cardEl.className = nextCardCls;
}

export function renderIndicatorCards() {
  const train = AppState.training;
  const topAlert = (!train.isWarmingUp && train.elapsedSeconds >= INITIAL_GRACE_SECONDS)
    ? getHighestPriorityAlert()
    : null;
  const latched = topAlert ? topAlert.key : null;
  const sched = train.alertSchedule || {};

  applyModuleCardStyle(
    dom.cardInhale,
    dom.textInhaleState,
    dom.badgeInhalePct,
    train.pctInhale,
    latched === 'inhale',
    !!(sched.inhale && sched.inhale.inAlertSchedule)
  );
  applyModuleCardStyle(
    dom.cardExhale,
    dom.textExhaleState,
    dom.badgeExhalePct,
    train.pctExhale,
    latched === 'exhale',
    !!(sched.exhale && sched.exhale.inAlertSchedule)
  );
  applyModuleCardStyle(
    dom.cardShoulder,
    dom.textShoulderState,
    dom.badgeShoulderPct,
    train.pctShoulder,
    latched === 'shoulder',
    !!(sched.shoulder && sched.shoulder.inAlertSchedule)
  );
  applyModuleCardStyle(
    dom.cardRr,
    dom.textRrState,
    dom.badgeRrPct,
    train.pctRr,
    false,
    false
  );
}

// ----------------------------------------------------------------------------
// 視覺 Canvas 渲染 (鏡像模式 / 去識別化骨架網格模式 / 純引導模式 / 互動模式)
// ----------------------------------------------------------------------------
export function renderTrainingCanvas(faceResults, poseResults) {
  const canvas = dom.trainCanvas;
  if (!canvas) return;
  const mode = AppState.privacyMode;
  if (mode === 'minimalist' || mode === 'interactive') return;

  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const m = AppState.currentMetrics;

  ctx.clearRect(0, 0, w, h);

  if (mode === 'privacy_mesh' || AppState.isDemoMode) {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, w, h);
  }

  if (!m.hasFace && !m.hasPose) return;

  if (m.hasPose && poseResults && poseResults.landmarks && poseResults.landmarks.length > 0) {
    const pose = poseResults.landmarks[0];
    const y11 = AppState.ema.initialized ? AppState.ema.y11Prev : pose[11].y;
    const y12 = AppState.ema.initialized ? AppState.ema.y12Prev : pose[12].y;
    const x11 = pose[11].x * w;
    const x12 = pose[12].x * w;
    const sy11 = y11 * h;
    const sy12 = y12 * h;

    const isHiking = m.deltaYRelative > THRESHOLDS.shoulderHikeWarn;
    const lineColor = isHiking ? '#ef4444' : '#2dd4bf';

    ctx.save();
    if (pose[7] && pose[8]) {
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(pose[7].x * w, pose[7].y * h);
      ctx.lineTo(x11, sy11);
      ctx.moveTo(pose[8].x * w, pose[8].y * h);
      ctx.lineTo(x12, sy12);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.strokeStyle = lineColor;
    ctx.lineWidth = isHiking ? 5 : 4;
    ctx.beginPath();
    ctx.moveTo(x11, sy11);
    ctx.lineTo(x12, sy12);
    ctx.stroke();

    [
      [x11, sy11],
      [x12, sy12]
    ].forEach(([px, py]) => {
      ctx.fillStyle = lineColor;
      ctx.beginPath();
      ctx.arc(px, py, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
    });
    ctx.restore();
  }

  if (m.hasFace && faceResults && faceResults.faceLandmarks && faceResults.faceLandmarks.length > 0) {
    const face = faceResults.faceLandmarks[0];

    ctx.save();
    if (mode === 'privacy_mesh' || AppState.isDemoMode) {
      const ovalIndices = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
      ctx.strokeStyle = 'rgba(77, 182, 172, 0.45)';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ovalIndices.forEach((idx, i) => {
        if (!face[idx]) return;
        const x = face[idx].x * w;
        const y = face[idx].y * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
    }

    const lipIndices = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95];
    const isPhaseInhale = AppState.training.currentPhase === PHASES.INHALE;
    const isLipGood = isPhaseInhale ? (m.inhaleScore >= 0.70) : (m.exhaleScore >= 0.70);
    const lipColor = isLipGood
      ? (isPhaseInhale ? '#4DB6AC' : '#FF7043')
      : '#ef4444';

    ctx.strokeStyle = lipColor;
    ctx.fillStyle = isLipGood ? 'rgba(77, 182, 172, 0.18)' : 'rgba(239, 68, 68, 0.24)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    lipIndices.forEach((idx, i) => {
      if (!face[idx]) return;
      const x = face[idx].x * w;
      const y = face[idx].y * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}
