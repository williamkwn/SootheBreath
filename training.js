/**
 * 舒呼(SootheBreath) v9.3 ES6 Module — training.js
 * 實時訓練主迴圈、單一 rAF 整合、MediaPipe 20Hz 交錯推論、DOM Dirty-Check 節流與精準吹風觸發/中斷引擎
 *
 * v9.3 修復與整合重點：
 * - 完整保留 v8_ES / v9 / v9.1 之相機串流綁定 (dom.trainVideo.srcObject = AppState.stream)、視窗 resize 同步、
 *   cyclesHistory 結構與隱私模式樣式切換，徹底解決真實鏡頭訓練黑屏與第 1 週期結束崩潰問題。
 * - [Fix 2] 3D 互動模式實時吹風觸發與中途即刻斷開邏輯 (Real-Time Hold & Release)：
 *           1. rawInhaleMotionScore 與 rawExhaleMotionScore 直接取自未經動量豁免之 getInhaleScore() 與 getExhaleScore()。
 *           2. 吸氣階段需同時達成「合口時間比例 >= 70%」且「無聳肩時間比例 >= 70%」才取得吹氣資格 (inhaleQualifiedForBlow = true)。
 *           3. 呼氣階段需連續 >= 0.10s (EXHALE_BLOW_CONFIRM_SEC) 維持真實噘唇且無聳肩才觸發 startInteractiveBlowing()；
 *              一旦呼氣中途張大口、放開噘唇或聳肩連續 >= 0.20s (EXHALE_BLOW_CUTOFF_SEC)，即刻呼叫 stopInteractiveBlowing() 停止吹風。
 * - [Fix 3] 開頭 400ms 緩衝期標記傳入 accumulateFrameScore，避免緩衝期稀釋錯誤時間比例；收緊呼氣 70% 柔性過渡條件。
 * - [Fix 4] 單雙幀交錯推論 EMA 保護：僅在 faceUpdated 為 true 時更新面部 EMA 與斜率，僅在 poseUpdated 為 true 時更新雙肩 EMA。
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
  roundTo,
  AppState
} from './state.js';
import { dom } from './dom.js';
import {
  calculateDEye,
  calculateLAR,
  extractBlendshapes,
  smoothFacialSignalsEMA,
  calculateShoulderMetrics,
  getInhaleScore,
  getExhaleScore,
  applyActionMomentumExemption,
  isNasalInhaleValid,
  isPlbExhaleValid,
  generateSimulatedDetections
} from './cvEngine.js';
import {
  resetScoringState,
  accumulateFrameScore,
  evaluateCompletedPhase
} from './scoring.js';
import { speakText } from './tts.js';
import {
  SUCCESS_BANNER_TEXT,
  evaluateStickyPriorityFeedback,
  renderBottomBanner
} from './feedback.js';
import { updateDebugReadouts } from './uiControls.js';
import {
  initInteractive3D,
  disposeInteractive3D,
  renderInteractive3DFrame,
  startInteractiveBlowing,
  stopInteractiveBlowing,
  switchInteractiveObjectMode
} from './interactive3d.js';

// P1-2: 模組內部 DOM 節流與快取狀態，避免每幀重複寫入相同字串觸發 Layout Thrashing
const domCache = {
  timerText: '',
  phaseHint: '',
  rrSubtitle: '',
  lastUiUpdateTs: 0,
  lastDebugUpdateTs: 0
};

// ============================================================================
// 10. 實時訓練主迴圈與四大百分比指標 (Section C: STATE_TRAINING)
// ============================================================================
export async function runTrainingSequence() {
  if (!AppState.isDemoMode && AppState.stream) {
    dom.trainVideo.srcObject = AppState.stream;
    await dom.trainVideo.play().catch(e => console.log(e));
  }

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
  AppState.training.cycleIndex = 1;
  AppState.training.inhaleGraceCycleTriggered = -1;
  AppState.training.inhaleEntryTimestamp = 0;
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

  resetScoringState();

  AppState.feedback.latchedModule = null;
  AppState.feedback.currentPriority = 5;
  AppState.feedback.currentPMessage = SUCCESS_BANNER_TEXT;
  AppState.feedback.pendingMessage = '';

  domCache.timerText = '';
  domCache.phaseHint = '';
  domCache.rrSubtitle = '';
  domCache.lastUiUpdateTs = 0;
  domCache.lastDebugUpdateTs = 0;

  if (dom.bottomBanner) {
    dom.bottomBanner.classList.add('hidden');
  }

  applyPrivacyModeStyles();
  applyDisplayModeStyles();
  syncCanvasDimensions();
  window.addEventListener('resize', syncCanvasDimensions);

  triggerPhaseSwitch(PHASES.INHALE);
  updateLiveRespiratoryRate(now);
  renderIndicatorCards();

  if (AppState.animFrameId) cancelAnimationFrame(AppState.animFrameId);
  AppState.animFrameId = requestAnimationFrame(trainingInferenceLoop);
}

export function syncCanvasDimensions() {
  const rect = dom.trainVideo.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    if (dom.trainCanvas.width !== Math.round(rect.width) || dom.trainCanvas.height !== Math.round(rect.height)) {
      dom.trainCanvas.width = Math.round(rect.width);
      dom.trainCanvas.height = Math.round(rect.height);
    }
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

  const isSingleColumnLayout = (mode === 'minimalist' || mode === 'interactive');
  const isPureGuiding = (mode === 'minimalist');

  if (dom.pacerVisualRegion) {
    dom.pacerVisualRegion.classList.toggle('pure-guiding-region', isPureGuiding);
  }
  if (dom.pacerOuterRing) {
    dom.pacerOuterRing.classList.toggle('pure-guiding-ring', isPureGuiding);
  }
  if (dom.pacerBall) {
    dom.pacerBall.classList.toggle('pure-guiding-ball', isPureGuiding);
  }
  if (dom.humanDemoBox) {
    dom.humanDemoBox.classList.toggle('pure-guiding-human', isPureGuiding);
  }

  if (isSingleColumnLayout) {
    if (dom.videoColumn) dom.videoColumn.classList.add('hidden');
    if (dom.trainingGrid) {
      dom.trainingGrid.className = "flex-1 grid grid-cols-1 gap-3 p-3 md:p-4 overflow-y-auto items-center justify-items-center bg-gradient-to-b from-[#f5fafd] to-teal-50/30";
    }
    if (dom.pacerColumn) {
      dom.pacerColumn.className = "w-full max-w-4xl flex flex-col justify-between bg-white/95 backdrop-blur-md border border-teal-200/80 rounded-3xl p-4 md:p-6 shadow-xl space-y-3 mx-auto my-auto";
    }
    if (dom.biofeedbackCardsGrid) {
      dom.biofeedbackCardsGrid.className = "w-full grid grid-cols-2 lg:grid-cols-4 gap-3 pt-1";
    }
  } else {
    if (dom.videoColumn) dom.videoColumn.classList.remove('hidden');
    if (dom.trainingGrid) {
      dom.trainingGrid.className = "flex-1 grid grid-cols-1 md:grid-cols-12 gap-3 p-3 md:p-4 overflow-y-auto md:overflow-hidden items-stretch";
    }
    if (dom.pacerColumn) {
      dom.pacerColumn.className = "md:col-span-5 flex flex-col justify-between bg-white/90 backdrop-blur-md border border-teal-100/90 rounded-3xl p-4 md:p-5 shadow-md space-y-3";
    }
    if (dom.biofeedbackCardsGrid) {
      dom.biofeedbackCardsGrid.className = "w-full grid grid-cols-1 sm:grid-cols-2 md:grid-cols-1 lg:grid-cols-2 gap-2.5";
    }

    if (mode === 'privacy_mesh') {
      dom.trainVideo.style.opacity = '0';
      dom.trainCanvas.style.opacity = '1';
      dom.trainCanvas.classList.add('privacy-mesh-canvas');
      dom.badgeMeshMode.textContent = "🔒 去識別化骨架網格模式 Privacy Mesh Mode";
      dom.badgeMeshMode.classList.remove('hidden');
    } else {
      dom.trainVideo.style.opacity = AppState.isDemoMode ? '0' : '1';
      dom.trainCanvas.style.opacity = '1';
      dom.trainCanvas.classList.remove('privacy-mesh-canvas');
      dom.badgeMeshMode.textContent = "📷 實時鏡像模式 Mirror Mode";
      dom.badgeMeshMode.classList.remove('hidden');
    }
    setTimeout(syncCanvasDimensions, 50);
  }
}

export function applyDisplayModeStyles() {
  const dMode = AppState.displayMode;
  const gender = AppState.humanGender;
  const iObj = AppState.interactiveObject || 'pinwheel';

  const activeMain = "py-2.5 px-3 rounded-xl text-xs font-bold bg-[#2E7D32] text-white shadow-sm transition cursor-pointer flex items-center justify-center gap-1.5";
  const inactiveMain = "py-2.5 px-3 rounded-xl text-xs font-semibold bg-white hover:bg-teal-50 text-slate-600 border border-slate-200 transition cursor-pointer flex items-center justify-center gap-1.5";

  if (dom.btnPacerBalloon) dom.btnPacerBalloon.className = dMode === 'balloon' ? activeMain : inactiveMain;
  if (dom.btnPacerHuman) dom.btnPacerHuman.className = dMode === 'human' ? activeMain : inactiveMain;
  if (dom.btnPacerInteractive) dom.btnPacerInteractive.className = dMode === 'interactive' ? activeMain : inactiveMain;

  if (dom.humanGenderSelector) {
    dom.humanGenderSelector.classList.toggle('hidden', dMode !== 'human');
  }
  if (dom.interactiveObjectSelector) {
    dom.interactiveObjectSelector.classList.toggle('hidden', dMode !== 'interactive');
  }

  const activeSub = "flex-1 py-1.5 rounded-lg text-xs font-bold bg-[#4DB6AC] text-white shadow-xs transition cursor-pointer";
  const inactiveSub = "flex-1 py-1.5 rounded-lg text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-600 transition cursor-pointer";
  if (dom.btnGenderMale) dom.btnGenderMale.className = gender === 'male' ? activeSub : inactiveSub;
  if (dom.btnGenderFemale) dom.btnGenderFemale.className = gender === 'female' ? activeSub : inactiveSub;
  if (dom.btnInteractivePinwheel) dom.btnInteractivePinwheel.className = iObj === 'pinwheel' ? activeSub : inactiveSub;
  if (dom.btnInteractiveDandelion) dom.btnInteractiveDandelion.className = iObj === 'dandelion' ? activeSub : inactiveSub;

  const tActive = "px-2.5 py-1 rounded-lg text-xs font-bold bg-[#2E7D32] text-white shadow-xs transition cursor-pointer";
  const tInactive = "px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-600 transition cursor-pointer";
  if (dom.btnTrainBalloon) dom.btnTrainBalloon.className = dMode === 'balloon' ? tActive : tInactive;
  if (dom.btnTrainMale) dom.btnTrainMale.className = (dMode === 'human' && gender === 'male') ? tActive : tInactive;
  if (dom.btnTrainFemale) dom.btnTrainFemale.className = (dMode === 'human' && gender === 'female') ? tActive : tInactive;
  if (dom.btnTrainInteractive) dom.btnTrainInteractive.className = dMode === 'interactive' ? tActive : tInactive;

  const imgPair = HUMAN_IMAGES[gender] || HUMAN_IMAGES.male;
  if (dom.imgHumanInhale && dom.imgHumanInhale.getAttribute('src') !== imgPair.inhale) {
    dom.imgHumanInhale.src = imgPair.inhale;
  }
  if (dom.imgHumanExhale && dom.imgHumanExhale.getAttribute('src') !== imgPair.exhale) {
    dom.imgHumanExhale.src = imgPair.exhale;
  }

  if (dom.pacerOuterRing) {
    dom.pacerOuterRing.classList.toggle('hidden', dMode !== 'balloon');
  }
  if (dom.humanDemoBox) {
    dom.humanDemoBox.classList.toggle('hidden', dMode !== 'human');
  }
  if (dom.interactive3dWrapper) {
    dom.interactive3dWrapper.classList.toggle('hidden', dMode !== 'interactive');
  }

  if (dMode === 'interactive') {
    if (AppState.currentState === STATES.TRAINING) {
      initInteractive3D(iObj);
      switchInteractiveObjectMode(iObj);
    }
  } else {
    disposeInteractive3D();
  }

  if (dom.labelActiveDisplayMode) {
    if (dMode === 'balloon') {
      dom.labelActiveDisplayMode.textContent = "🎈 氣球動畫導引";
    } else if (dMode === 'human') {
      dom.labelActiveDisplayMode.textContent = gender === 'female' ? "👩 真人呼吸示範 (女性)" : "👨 真人呼吸示範 (男性)";
    } else {
      dom.labelActiveDisplayMode.textContent = iObj === 'dandelion'
        ? "🌼 互動模式 · 蒲公英 (動作感測吹風)"
        : "🎡 互動模式 · 微風風車 (動作感測吹風)";
    }
  }
}

// ============================================================================
// P0-1, P1-2 & Fix 4: 單一 60 FPS 訓練與 3D 渲染迴圈 + MediaPipe 20Hz 交錯推論 + DOM 節流
// ============================================================================
export function trainingInferenceLoop() {
  if (AppState.currentState !== STATES.TRAINING) return;

  if (AppState.isPaused) {
    AppState.animFrameId = requestAnimationFrame(trainingInferenceLoop);
    return;
  }

  const now = performance.now();
  const train = AppState.training;
  const dt = Math.min(0.1, Math.max(0.001, (now - (train.lastFrameTime || now)) / 1000));
  train.lastFrameTime = now;

  const elapsedTotal = (now - train.startTime) / 1000;
  train.elapsedSeconds = elapsedTotal;

  const remainingTotal = Math.max(0, AppState.totalDuration - elapsedTotal);
  const mins = Math.floor(remainingTotal / 60);
  const secs = Math.floor(remainingTotal % 60);
  const nextTimerText = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

  if (domCache.timerText !== nextTimerText) {
    domCache.timerText = nextTimerText;
    dom.timerDisplay.textContent = nextTimerText;
  }

  if (remainingTotal <= 0) {
    finalizeCurrentCycle(now, false);
    import('./uiControls.js').then(m => m.switchViewState(STATES.SUMMARY));
    return;
  }

  const isInteractive = (AppState.displayMode === 'interactive' || AppState.privacyMode === 'interactive');
  const shouldRunInference = (now - (train.lastInferenceTime || 0)) >= INFERENCE_INTERVAL_MS;

  // 1. P0-1 & Fix 4: MediaPipe 推論降頻 (20 FPS) 與單雙幀交錯推論 (傳遞 faceUpdated / poseUpdated 標記)
  if (shouldRunInference) {
    const inferenceDt = train.lastInferenceTime > 0
      ? Math.min(0.25, Math.max(0.001, (now - train.lastInferenceTime) / 1000))
      : (INFERENCE_INTERVAL_MS / 1000);
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
          // 互動模式下單雙次推論交錯執行 Face 與 Pose，將單幀 AI 推論時間減半
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

  // 2. 呼吸節奏狀態機推進 (P1-2: 互動模式下自動跳過隱藏氣球之 DOM 操作)
  advanceBreathingPacer(now);

  // 3. 繪製視覺 Canvas 或驅動 60 FPS 3D 互動模式渲染 (P0-1: 單一主迴圈整合)
  if (isInteractive) {
    renderInteractive3DFrame(dt);
  } else if (AppState.privacyMode !== 'minimalist') {
    renderTrainingCanvas(AppState.lastFaceResult, AppState.lastPoseResult);
  }

  // 4. P1-2: 僅於調試面板展開時以 150ms 節流更新讀數
  if (dom.debugDrawer && !dom.debugDrawer.classList.contains('translate-x-full')) {
    if (now - domCache.lastDebugUpdateTs >= 150) {
      domCache.lastDebugUpdateTs = now;
      updateDebugReadouts();
    }
  }

  AppState.animFrameId = requestAnimationFrame(trainingInferenceLoop);
}

// ----------------------------------------------------------------------------
// 實測呼吸頻率計算 (Actual Respiratory Rate)
// ----------------------------------------------------------------------------
export function updateLiveRespiratoryRate(now) {
  const train = AppState.training;
  const targetCycleSec = AppState.inhaleTarget + AppState.exhaleTarget;
  const targetRR = AppState.targetBpm;

  const elapsedSec = Math.max(0.1, (now - train.startTime) / 1000);
  const currentCycleElapsed = Math.max(0, (now - train.cycleStartTime) / 1000);
  const currentCycleProgress = Math.min(0.99, currentCycleElapsed / targetCycleSec);

  let liveAvgRR = targetRR;
  if (train.cyclesHistory.length > 0) {
    const recentCycles = train.cyclesHistory.slice(-4);
    const totalRecentDuration = recentCycles.reduce((acc, c) => acc + (c.cycleDuration || targetCycleSec), 0);
    const meanRecentRR = (recentCycles.length / Math.max(1, totalRecentDuration)) * 60;
    const sessionRR = ((train.cyclesHistory.length + currentCycleProgress) / elapsedSec) * 60;
    liveAvgRR = (meanRecentRR * 0.65) + (sessionRR * 0.35);
  } else if (elapsedSec >= 2.0) {
    liveAvgRR = ((currentCycleProgress) / elapsedSec) * 60;
  }

  train.avgRR = liveAvgRR;

  const nextSubtitle = `目標 ${targetRR} · 實測 ${liveAvgRR.toFixed(1)} 次/分`;
  if (dom.subRrTarget && domCache.rrSubtitle !== nextSubtitle) {
    domCache.rrSubtitle = nextSubtitle;
    dom.subRrTarget.textContent = nextSubtitle;
  }
}

// ----------------------------------------------------------------------------
// 逐幀特徵點運算、全程累計時間百分比與 v9.2/v9.3 互動模式實時吹風觸發/中斷邏輯
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

  const hasFace = !!(faceResult && faceResult.faceLandmarks && faceResult.faceLandmarks.length > 0);
  const hasPose = !!(poseResult && poseResult.landmarks && poseResult.landmarks.length > 0);
  m.hasFace = hasFace;
  m.hasPose = hasPose;

  if (!hasFace || !hasPose) {
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
    const smoothedFace = smoothFacialSignalsEMA(
      larRaw,
      blendshapes.jawOpen,
      blendshapes.mouthPucker,
      blendshapes.mouthFunnel
    );

    m.larRaw = larRaw;
    m.lar = smoothedFace.larFiltered;
    m.jawOpenRaw = blendshapes.jawOpen;
    m.jawOpen = smoothedFace.jawOpenFiltered;
    m.mouthPuckerRaw = blendshapes.mouthPucker;
    m.mouthPucker = smoothedFace.mouthPuckerFiltered;
    m.mouthFunnelRaw = blendshapes.mouthFunnel;
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
    const isLipsNaturallyRelaxed = (m.lar < THRESHOLDS.larExhaleMin) || (m.mouthPucker < THRESHOLDS.puckerClosedErrMax) || (exhaleScore < 0.70);

    if (!train.isSoftTransitioning && isOver70Pct && isGoodPlbDuration && isLipsNaturallyRelaxed) {
      train.isSoftTransitioning = true;
      train.softTransitionStartTime = now;
      const currentProgress = Math.min(1, phaseElapsed / AppState.exhaleTarget);
      train.softTransitionStartScale = 1.30 - (currentProgress * 0.45);
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

export function triggerPhaseSwitch(newPhase) {
  const train = AppState.training;
  const now = performance.now();
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
    dom.pillPhase.textContent = "吸氣階段 (閉口鼻吸)";
    dom.pillPhase.className = "px-3.5 py-1.5 rounded-xl font-bold text-xs md:text-sm bg-[#4DB6AC] text-white shadow-sm";
    speakText("吸氣", true);
  } else {
    dom.pillPhase.textContent = "呼氣階段 (噘唇吹氣)";
    dom.pillPhase.className = "px-3.5 py-1.5 rounded-xl font-bold text-xs md:text-sm bg-[#FF7043] text-white shadow-sm";
    speakText("慢慢噘唇呼氣", true);
  }

  renderIndicatorCards();
}

export function finalizeCurrentCycle(now = performance.now(), wasSoftTransition = false) {
  const train = AppState.training;
  const safeTin = Math.max(train.tInActual, 0.5);
  const achievedIeRatio = roundTo(train.tExActual / safeTin, 2);
  const cycleDuration = Math.max(1.0, (now - (train.cycleStartTime || train.phaseStartTime)) / 1000);
  const cycleRR = 60 / cycleDuration;

  train.cyclesHistory.push({
    cycle: train.cycleIndex,
    tInActual: train.tInActual,
    tExActual: train.tExActual,
    achievedIe: achievedIeRatio,
    targetIe: AppState.ieRatio,
    softTransitionCompleted: wasSoftTransition,
    cycleDuration: cycleDuration,
    cycleRR: cycleRR,
    avgRR: train.avgRR
  });

  updateLiveRespiratoryRate(now);

  train.tInActual = 0;
  train.tExActual = 0;
}

/**
 * P1-2: 加入 Dirty-Check，僅在文字或樣式實際改變時寫入 DOM，消除無謂之 Style Recalculation
 */
export function applyModuleCardStyle(cardEl, stateEl, pctEl, pctVal, isLatchedTarget = false, inAlertSchedule = false) {
  if (!cardEl || !stateEl || !pctEl) return;

  const clamped = clampVal(Math.round(pctVal ?? 100), 0, 100);
  const nextPctText = `${clamped}%`;
  if (pctEl.textContent !== nextPctText) {
    pctEl.textContent = nextPctText;
  }

  let nextCardCls = '';
  let nextPctCls = '';
  let nextStateText = '';
  let nextStateCls = '';

  if (clamped >= PASSING_SCORE_PCT && !inAlertSchedule) {
    nextCardCls = "bg-emerald-50/90 border border-emerald-200 rounded-2xl p-3 flex flex-col justify-between transition-all shadow-xs";
    nextPctCls = "text-2xl md:text-3xl font-black font-mono text-[#2E7D32] tracking-tight";
    nextStateText = "合格達標";
    nextStateCls = "px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-[#2E7D32] border border-emerald-300";
  } else {
    const highlightCls = isLatchedTarget ? " shoulder-alert-active ring-2 ring-rose-400" : "";
    nextCardCls = `bg-rose-50/95 border border-rose-300 rounded-2xl p-3 flex flex-col justify-between transition-all shadow-xs${highlightCls}`;
    nextPctCls = "text-2xl md:text-3xl font-black font-mono text-rose-600 tracking-tight";
    nextStateText = "需要改善";
    nextStateCls = "px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-100 text-rose-700 border border-rose-300";
  }

  if (cardEl.className !== nextCardCls) cardEl.className = nextCardCls;
  if (pctEl.className !== nextPctCls) pctEl.className = nextPctCls;
  if (stateEl.textContent !== nextStateText) stateEl.textContent = nextStateText;
  if (stateEl.className !== nextStateCls) stateEl.className = nextStateCls;
}

export function renderIndicatorCards() {
  const train = AppState.training;
  const latched = AppState.feedback.latchedModule;
  const sched = train.alertSchedule || {};

  applyModuleCardStyle(
    dom.cardInhale,
    dom.stateInhale,
    dom.pctInhale,
    train.pctInhale,
    latched === 'inhale',
    !!(sched.inhale && sched.inhale.inAlertSchedule)
  );
  applyModuleCardStyle(
    dom.cardExhale,
    dom.stateExhale,
    dom.pctExhale,
    train.pctExhale,
    latched === 'exhale',
    !!(sched.exhale && sched.exhale.inAlertSchedule)
  );
  applyModuleCardStyle(
    dom.cardShoulder,
    dom.stateShoulder,
    dom.pctShoulder,
    train.pctShoulder,
    latched === 'shoulder',
    !!(sched.shoulder && sched.shoulder.inAlertSchedule)
  );
  applyModuleCardStyle(
    dom.cardRr,
    dom.stateRr,
    dom.pctRr,
    train.pctRr,
    false,
    false
  );
}

// ----------------------------------------------------------------------------
// Canvas 覆蓋繪製 (Section 5 Canvas Rendering & Privacy Mesh Mode)
// ----------------------------------------------------------------------------
export function renderTrainingCanvas(faceResults, poseResults) {
  const canvas = dom.trainCanvas;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const mode = AppState.privacyMode;
  const m = AppState.currentMetrics;

  ctx.clearRect(0, 0, w, h);

  if (mode === 'privacy_mesh' || AppState.isDemoMode) {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(77, 182, 172, 0.08)';
    ctx.lineWidth = 1;
    const step = 36;
    for (let x = 0; x < w; x += step) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = 0; y < h; y += step) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
  }

  if (m.hasPose && poseResults && poseResults.landmarks && poseResults.landmarks.length > 0) {
    const pose = poseResults.landmarks[0];
    const y11 = AppState.ema.initialized ? AppState.ema.y11Prev : pose[11].y;
    const y12 = AppState.ema.initialized ? AppState.ema.y12Prev : pose[12].y;
    const p11 = { x: pose[11].x * w, y: y11 * h };
    const p12 = { x: pose[12].x * w, y: y12 * h };

    if (pose[7] && pose[8]) {
      const p7 = { x: pose[7].x * w, y: pose[7].y * h };
      const p8 = { x: pose[8].x * w, y: pose[8].y * h };
      ctx.save();
      ctx.strokeStyle = 'rgba(77, 182, 172, 0.50)';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(p7.x, p7.y);
      ctx.lineTo(p11.x, p11.y);
      ctx.moveTo(p8.x, p8.y);
      ctx.lineTo(p12.x, p12.y);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.lineWidth = 4;
    if (m.deltaYRelative > THRESHOLDS.shoulderHikeWarn) {
      ctx.strokeStyle = '#ef4444';
      ctx.setLineDash([8, 6]);
    } else {
      ctx.strokeStyle = '#4DB6AC';
      ctx.setLineDash([]);
    }

    ctx.beginPath();
    ctx.moveTo(p11.x, p11.y);
    ctx.lineTo(p12.x, p12.y);
    ctx.stroke();

    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.arc(p11.x, p11.y, 7, 0, Math.PI * 2);
    ctx.arc(p12.x, p12.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  if (m.hasFace && faceResults && faceResults.faceLandmarks && faceResults.faceLandmarks.length > 0) {
    const face = faceResults.faceLandmarks[0];

    if (mode === 'privacy_mesh' || AppState.isDemoMode) {
      ctx.fillStyle = '#4DB6AC';
      const ovalIndices = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
      ovalIndices.forEach(idx => {
        if (face[idx]) {
          ctx.beginPath();
          ctx.arc(face[idx].x * w, face[idx].y * h, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      });

      if (face[33] && face[263]) {
        ctx.fillStyle = '#94a3b8';
        ctx.beginPath();
        ctx.arc(face[33].x * w, face[33].y * h, 3.5, 0, Math.PI * 2);
        ctx.arc(face[263].x * w, face[263].y * h, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const lipPoints = [78, 13, 308, 14].map(idx => ({
      x: face[idx].x * w,
      y: face[idx].y * h
    }));

    ctx.save();
    ctx.lineWidth = 3.5;
    const isGoodPlb = AppState.training.currentPhase === PHASES.INHALE
      ? isNasalInhaleValid(m.lar, m.jawOpen)
      : (isPlbExhaleValid(m.lar, m.mouthPucker, m.mouthFunnel) || AppState.training.isSoftTransitioning);
    ctx.strokeStyle = isGoodPlb ? '#4DB6AC' : '#FF7043';
    ctx.fillStyle = isGoodPlb ? 'rgba(77, 182, 172, 0.28)' : 'rgba(255, 112, 67, 0.28)';

    ctx.beginPath();
    ctx.moveTo(lipPoints[0].x, lipPoints[0].y);
    for (let i = 1; i < lipPoints.length; i++) {
      ctx.lineTo(lipPoints[i].x, lipPoints[i].y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    lipPoints.forEach(pt => {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }
}
