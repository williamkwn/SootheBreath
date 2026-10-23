/**
 * 舒呼(SootheBreath) v10.1 ES6 Module — training.js
 * 實時訓練主迴圈、單一 rAF 整合、MediaPipe 20Hz 交錯推論、DOM Dirty-Check 節流與 v10.1 互動引導雙欄兼容模式
 *
 * v10.1 核心升級重點：
 * - 將「互動模式 (interactive)」完全整合為「呼吸引導顯示模式 (displayMode)」子項：
 *   當「相機顯示模式 (privacyMode)」選擇「實時鏡像模式 (mirror)」或「去識別化骨架網格模式 (privacy_mesh)」時，
 *   保留左側視訊/網格面板可見，並與右側 3D 互動模式同屏運作；當選擇「純引導模式 (minimalist)」時，則採用全屏單欄純引導版面。
 * - 訓練開始時即常駐顯示底部警示橫幅為「分析中...」，防止數秒後橫幅彈出造成模組走位。
 * - 支援從主頁「繼續使用上次校準設定」或「免鏡頭預覽」直接跳過校準進入訓練頁面時自動啟動相機與模型。
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
import { initMediaPipeVision } from './vision.js';
import { startCamera } from './camera.js';
import {
  calculateDEye,
  calculateLAR,
  extractV10MouthAndPoseMetrics,
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
import { speakText, updateVoiceToggleUI } from './tts.js';
import {
  resetScoringState,
  accumulateFrameScore,
  evaluateCompletedPhase,
  getHighestPriorityAlert
} from './scoring.js';
import {
  ANALYZING_BANNER_TEXT,
  renderBottomBanner,
  evaluateStickyPriorityFeedback
} from './feedback.js';
import {
  initInteractive3D,
  disposeInteractive3D,
  switchInteractiveObjectMode,
  startInteractiveBlowing,
  stopInteractiveBlowing,
  renderInteractive3DFrame,
  resizeInteractive3D
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
export async function runTrainingSequence() {
  if (AppState.animFrameId) {
    cancelAnimationFrame(AppState.animFrameId);
    AppState.animFrameId = null;
  }

  // v10.1: 若從「繼續使用上次校準設定」直接進入訓練且尚未開啟相機或載入模型，在此自動啟動
  if (!AppState.isDemoMode) {
    if (!AppState.stream || !AppState.stream.active) {
      const started = await startCamera(dom.trainVideo);
      if (!started) {
        switchViewState(STATES.IDLE);
        return;
      }
    } else if (dom.trainVideo) {
      dom.trainVideo.srcObject = AppState.stream;
      await dom.trainVideo.play().catch(e => console.log(e));
    }

    if (!AppState.faceLandmarker || !AppState.poseLandmarker) {
      await initMediaPipeVision();
    }
  }

  const now = performance.now();
  const targetRR = AppState.targetBpm;

  AppState.training.startTime = now;
  AppState.training.lastFrameTime = now;
  AppState.training.lastInferenceTime = 0;
  AppState.training.inferenceTickCount = 0;
  AppState.training.phaseStartTime = now;
  AppState.training.cycleStartTime = now;
  AppState.ema.initialized = false;
  AppState.ema.faceInitialized = false;
  AppState.ema.occlusionHoldSec = 0;
  AppState.ema.occlusionRecoveryTicks = 0;
  AppState.ema.momentumPauseTicks = 0;
  AppState.ema.prevValidCols = 3;
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

  domCache.timerLeft = '';
  domCache.cycleCount = -1;
  domCache.phaseHint = '';
  domCache.lastUiUpdateTs = 0;
  domCache.lastDebugUpdateTs = 0;

  resetScoringState();

  // v10.1: 訓練開始時底部橫幅即常駐顯示「分析中...」，避免 10 秒後彈出造成版面模組走位
  AppState.feedback.latchedModule = null;
  AppState.feedback.currentPriority = 0;
  AppState.feedback.currentPMessage = ANALYZING_BANNER_TEXT;
  AppState.feedback.pendingMessage = '';
  renderBottomBanner(ANALYZING_BANNER_TEXT, 0);

  if (dom.btnPauseTrain) {
    dom.btnPauseTrain.textContent = "⏸️ 暫停訓練";
  }

  updateVoiceToggleUI();
  applyPrivacyModeStyles();
  applyDisplayModeStyles();
  syncCanvasDimensions();
  window.addEventListener('resize', syncCanvasDimensions);

  triggerPhaseSwitch(PHASES.INHALE);
  updateLiveRespiratoryRate(now);
  renderIndicatorCards();

  AppState.animFrameId = requestAnimationFrame(trainingInferenceLoop);
}

export function syncCanvasDimensions() {
  const mode = AppState.privacyMode;
  if (dom.visionContainer && dom.trainCanvas && mode !== 'minimalist') {
    dom.trainCanvas.width = dom.visionContainer.clientWidth || 640;
    dom.trainCanvas.height = dom.visionContainer.clientHeight || 480;
  }
}

export function applyPrivacyModeStyles() {
  if (AppState.privacyMode === 'interactive') {
    AppState.privacyMode = AppState.lastNonInteractivePrivacyMode || 'privacy_mesh';
  }
  const mode = AppState.privacyMode;
  if (dom.selectPrivacy && dom.selectPrivacy.value !== mode) {
    dom.selectPrivacy.value = mode;
  }

  const activeCls = "px-2.5 py-1 rounded-lg text-xs font-bold bg-[#4DB6AC] text-white shadow-sm transition cursor-pointer";
  const inactiveCls = "px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-600 transition cursor-pointer";
  if (dom.btnModeMirror) dom.btnModeMirror.className = mode === 'mirror' ? activeCls : inactiveCls;
  if (dom.btnModeMesh) dom.btnModeMesh.className = mode === 'privacy_mesh' ? activeCls : inactiveCls;
  if (dom.btnModeMinimal) dom.btnModeMinimal.className = mode === 'minimalist' ? activeCls : inactiveCls;

  // v10.1: 僅當選擇「純引導模式 (minimalist)」時隱藏視訊面板；Mirror Mode 或 Privacy Mesh Mode 下（包括互動模式）均保持視訊/網格面板可見
  const isSingleColumnGuideLayout = (mode === 'minimalist');

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
  }

  setTimeout(() => {
    syncCanvasDimensions();
    resizeInteractive3D();
  }, 50);
}

export function applyDisplayModeStyles() {
  const isInteractive = (AppState.displayMode === 'interactive');
  const isHuman = (!isInteractive && AppState.displayMode === 'human');
  const isBalloon = (!isInteractive && !isHuman);
  const gender = AppState.humanGender;
  const interObj = AppState.interactiveObject || 'pinwheel';

  const idleActive = "flex-1 py-2.5 px-3 rounded-xl text-xs font-bold bg-[#2E7D32] text-white shadow-sm transition cursor-pointer";
  const idleInactive = "flex-1 py-2.5 px-3 rounded-xl text-xs font-semibold bg-white hover:bg-teal-50 text-slate-600 border border-slate-200 transition cursor-pointer";

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
    dom.imgHumanInhale.src = imgPair.inhale;
  }
  if (dom.imgHumanExhale && dom.imgHumanExhale.getAttribute('src') !== imgPair.exhale) {
    dom.imgHumanExhale.src = imgPair.exhale;
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
      setTimeout(resizeInteractive3D, 50);
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
// P0-1 & P1-2: 單一 60 FPS 訓練與 3D 渲染迴圈 + MediaPipe 20Hz 交錯推論 + DOM 節流
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
  const timerStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  if (timerStr !== domCache.timerLeft) {
    domCache.timerLeft = timerStr;
    if (dom.valTimerLeft) dom.valTimerLeft.textContent = timerStr;
  }
  if (train.cycleIndex !== domCache.cycleCount) {
    domCache.cycleCount = train.cycleIndex;
    if (dom.valCycleCount) dom.valCycleCount.textContent = train.cycleIndex;
  }

  if (remainingTotal <= 0) {
    finalizeCurrentCycle(now, train.isSoftTransitioning);
    switchViewState(STATES.SUMMARY);
    return;
  }

  const isInteractive = (AppState.displayMode === 'interactive');
  const shouldRunInference = (now - (train.lastInferenceTime || 0)) >= INFERENCE_INTERVAL_MS;

  // 1. P0-1 & Fix 4: MediaPipe 推論降頻 (20 FPS) 與單雙幀交錯推論 (傳遞 faceUpdated / poseUpdated 標記)
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

  // 2. 呼吸節奏狀態機推進 (P1-2: 互動模式下自動跳過隱藏氣球之 DOM 操作)
  advanceBreathingPacer(now);

  // 3. v10.1: 支援 3D 互動模式與左側視訊/骨架網格 Canvas 同屏同步渲染
  if (isInteractive) {
    renderInteractive3DFrame(dt);
  }
  if (AppState.privacyMode !== 'minimalist') {
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
  if (dom.valLiveRr) {
    const nextRr = liveAvgRR.toFixed(1);
    if (dom.valLiveRr.textContent !== nextRr) {
      dom.valLiveRr.textContent = nextRr;
    }
  }
}

// ----------------------------------------------------------------------------
// 逐幀特徵點運算、v10 16+4 點幾何評分、70% 呼氣柔性過渡與互動模式吹風控制
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

  // Fix 4 & v10: 僅在該幀實際更新了 FaceLandmarker (或尚未初始化) 時才執行面部幾何提取與 EMA 濾波
  if (faceUpdated || !AppState.ema.faceInitialized) {
    const isSim = Boolean(faceResult.isSimulated || AppState.isDemoMode);
    const v10Geo = extractV10MouthAndPoseMetrics(face, cal, { isSimulated: isSim });
    m.dEye = v10Geo.dEye;
    const larRaw = calculateLAR(face);
    const blendshapes = extractBlendshapes(faceResult.faceBlendshapes);
    const smoothedFace = smoothFacialSignalsEMA(
      larRaw,
      blendshapes.jawOpen,
      blendshapes.mouthPucker,
      blendshapes.mouthFunnel,
      v10Geo,
      dt
    );

    m.larRaw = larRaw;
    m.lar = smoothedFace.larFiltered;
    m.jawOpenRaw = blendshapes.jawOpen;
    m.jawOpen = smoothedFace.jawOpenFiltered;
    m.mouthPuckerRaw = blendshapes.mouthPucker;
    m.mouthPucker = smoothedFace.mouthPuckerFiltered;
    m.mouthFunnelRaw = blendshapes.mouthFunnel;
    m.mouthFunnel = smoothedFace.mouthFunnelFiltered;

    m.hInnerRaw = v10Geo.hInnerRobust;
    m.hInner = smoothedFace.hInnerFiltered;
    m.hCenterRaw = v10Geo.hCenter;
    m.hCenter = smoothedFace.hCenterFiltered;
    m.wOuterRaw = v10Geo.wOuterNorm;
    m.wOuter = smoothedFace.wOuterFiltered;
    m.olarRaw = v10Geo.olar;
    m.olar = smoothedFace.olarFiltered;
    m.noi = smoothedFace.noiFiltered;
    m.noiCenter = smoothedFace.noiCenterFiltered;
    m.mwr = smoothedFace.mwrFiltered;
    m.olarRatio = smoothedFace.olarRatioFiltered;
    m.yawDeg = v10Geo.yawDeg;
    m.pitchDeg = v10Geo.pitchDeg;
    m.zProtrusion = v10Geo.zProtrusion;
    m.poseValidForZ = v10Geo.poseValidForZ;
    m.validCols = v10Geo.validCols;
    m.hasValidMouth = smoothedFace.hasValidMouth;

    m.deltaLar = smoothedFace.deltaLar;
    m.deltaJawOpen = smoothedFace.deltaJawOpen;
    m.deltaMouthPucker = smoothedFace.deltaMouthPucker;
    m.deltaNoi = smoothedFace.deltaNoi;
    m.deltaMwr = smoothedFace.deltaMwr;
  } else {
    m.deltaLar = 0;
    m.deltaJawOpen = 0;
    m.deltaMouthPucker = 0;
    m.deltaNoi = 0;
    m.deltaMwr = 0;
  }

  // Level 4 降級保護：若有效唇柱為 0 持續超過 OCCLUSION_HOLD_MAX_SEC (300ms)，暫停吹風與計分
  if (!m.hasValidMouth) {
    if (train.isInteractiveBlowing) {
      train.isInteractiveBlowing = false;
      stopInteractiveBlowing();
    }
    evaluateStickyPriorityFeedback(false);
    return;
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

  // v10: 組裝幾何與遲滯狀態物件傳入 getInhaleScore / getExhaleScore
  const v10MetricsObj = {
    noi: m.noi,
    noiCenter: m.noiCenter,
    mwr: m.mwr,
    olarRatio: m.olarRatio,
    zProtrusion: m.zProtrusion,
    poseValidForZ: m.poseValidForZ,
    isCurrentlyBlowing: train.isInteractiveBlowing
  };

  // Fix 2: 先計算未經動量豁免之真實基礎動作分數
  const rawInhaleMotionScore = getInhaleScore(m.lar, m.jawOpen, v10MetricsObj);
  const rawExhaleMotionScore = getExhaleScore(m.lar, m.mouthPucker, m.mouthFunnel, v10MetricsObj);

  // Fix 1 & v10: 套用抗抖動與抗遮擋恢復動量豁免
  let inhaleScore = applyActionMomentumExemption(
    PHASES.INHALE,
    rawInhaleMotionScore,
    m.deltaLar,
    m.deltaMouthPucker,
    { deltaNoi: m.deltaNoi, deltaMwr: m.deltaMwr }
  );
  let exhaleScore = applyActionMomentumExemption(
    PHASES.EXHALE,
    rawExhaleMotionScore,
    m.deltaLar,
    m.deltaMouthPucker,
    { deltaNoi: m.deltaNoi, deltaMwr: m.deltaMwr }
  );

  let isInGracePeriod = false;

  if (train.currentPhase === PHASES.INHALE) {
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
    // 1. 優先評估「70% 呼氣時間柔性過渡 (Early Exhale Soft Transition)」
    const phaseElapsed = (now - train.phaseStartTime) / 1000;
    const isOver70Pct = phaseElapsed >= (AppState.exhaleTarget * THRESHOLDS.earlyExhaleRatio);
    const isGoodPlbDuration = (train.tExActual >= (phaseElapsed * 0.70)) && isShoulderRelaxed;
    const isNotWideMouthError = (m.noiCenter <= (THRESHOLDS.noiExhaleWideErr ?? 0.55)) &&
                                (m.lar <= THRESHOLDS.larExhaleWideErr);
    const isLipsNaturallyRelaxed = isNotWideMouthError && (
      (m.mwr > (THRESHOLDS.mwrExhaleHold ?? 0.91)) ||
      (m.noiCenter < (THRESHOLDS.noiExhaleMin ?? 0.025)) ||
      (m.lar < THRESHOLDS.larExhaleMin) ||
      (m.mouthPucker < THRESHOLDS.puckerClosedErrMax) ||
      (rawExhaleMotionScore < 0.70)
    );

    if (!train.isSoftTransitioning && isOver70Pct && isGoodPlbDuration && isLipsNaturallyRelaxed) {
      train.isSoftTransitioning = true;
      train.softTransitionStartTime = now;
      const currentProgress = Math.min(1, phaseElapsed / AppState.exhaleTarget);
      train.softTransitionStartScale = 1.30 - (currentProgress * 0.45);
    }

    if (train.isSoftTransitioning) {
      exhaleScore = 1.0;
    }

    // 2. 實時呼氣確認與中途錯誤即刻斷開吹風機制 (Real-Time Hold & Release + 70% 柔性過渡尾段防斷吹保護)
    const isPursedLipExhaleValidNow =
      (rawExhaleMotionScore >= 0.70 || isPlbExhaleValid(m.lar, m.mouthPucker, m.mouthFunnel, v10MetricsObj)) &&
      isShoulderRelaxed &&
      (shoulderScore >= 0.70);

    if (isPursedLipExhaleValidNow) {
      train.exhaleValidHoldSec = (train.exhaleValidHoldSec || 0) + dt;
      train.exhaleInvalidCutoffSec = 0;
      if (!train.isInteractiveBlowing && train.inhaleQualifiedForBlow && train.exhaleValidHoldSec >= EXHALE_BLOW_CONFIRM_SEC) {
        train.isInteractiveBlowing = true;
        startInteractiveBlowing();
      }
    } else if (train.isSoftTransitioning && isShoulderRelaxed && isNotWideMouthError) {
      train.exhaleInvalidCutoffSec = 0;
    } else {
      train.exhaleInvalidCutoffSec = (train.exhaleInvalidCutoffSec || 0) + dt;
      train.exhaleValidHoldSec = 0;
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
  const isInteractive = (AppState.displayMode === 'interactive');
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
      train.inhaleQualifiedForBlow = (getInhaleScore(m.lar, m.jawOpen, { noi: m.noi }) >= 0.70) && (m.shoulderScore >= 0.70);
    }

    if (train.exhaleGraceCycleTriggered !== train.cycleIndex) {
      train.exhaleGraceCycleTriggered = train.cycleIndex;
      train.exhaleEntryTimestamp = now;
      train.exhaleGraceCompleted = false;
    }
  }

  const isInhale = newPhase === PHASES.INHALE;
  const isMinimal = (AppState.privacyMode === "minimalist");
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
// Canvas 覆蓋繪製 (Section 5 Canvas Rendering & Privacy Mesh Mode)
// ----------------------------------------------------------------------------
export function renderTrainingCanvas(faceResults, poseResults) {
  const canvas = dom.trainCanvas;
  if (!canvas) return;
  const mode = AppState.privacyMode;
  if (mode === 'minimalist') return;

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

    const v10MetricsObj = {
      noi: m.noi,
      noiCenter: m.noiCenter,
      mwr: m.mwr,
      olarRatio: m.olarRatio,
      zProtrusion: m.zProtrusion,
      poseValidForZ: m.poseValidForZ,
      isCurrentlyBlowing: AppState.training.isInteractiveBlowing
    };

    const isGoodPlb = AppState.training.currentPhase === PHASES.INHALE
      ? isNasalInhaleValid(m.lar, m.jawOpen, v10MetricsObj)
      : (isPlbExhaleValid(m.lar, m.mouthPucker, m.mouthFunnel, v10MetricsObj) || AppState.training.isSoftTransitioning);

    ctx.save();
    ctx.lineWidth = 3.0;
    ctx.strokeStyle = isGoodPlb ? '#4DB6AC' : '#FF7043';
    ctx.fillStyle = isGoodPlb ? 'rgba(77, 182, 172, 0.26)' : 'rgba(255, 112, 67, 0.26)';

    // 繪製外唇環 (61, 0, 291, 17) 與內唇環 (78, 82, 13, 312, 308, 317, 14, 87)
    if (face[61] && face[291] && face[0] && face[17]) {
      const outerPts = [61, 0, 291, 17].map(idx => ({ x: face[idx].x * w, y: face[idx].y * h }));
      ctx.beginPath();
      ctx.moveTo(outerPts[0].x, outerPts[0].y);
      for (let i = 1; i < outerPts.length; i++) {
        ctx.lineTo(outerPts[i].x, outerPts[i].y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    const innerIndices = (face[82] && face[312]) ? [78, 82, 13, 312, 308, 317, 14, 87] : [78, 13, 308, 14];
    const lipPoints = innerIndices.map(idx => ({
      x: face[idx].x * w,
      y: face[idx].y * h
    }));

    ctx.beginPath();
    ctx.moveTo(lipPoints[0].x, lipPoints[0].y);
    for (let i = 1; i < lipPoints.length; i++) {
      ctx.lineTo(lipPoints[i].x, lipPoints[i].y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }
}
