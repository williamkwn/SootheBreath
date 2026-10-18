/**
 * 舒呼(SootheBreath) v7.0 ES6 Module — training.js
 * 實時訓練主迴圈、20 秒滾動時間窗四大百分比指標與呼吸節奏導引 (Real-Time Training & Biofeedback)
 */

import {
  STATES,
  PHASES,
  THRESHOLDS,
  HUMAN_IMAGES,
  ROLLING_WINDOW_SECONDS,
  INITIAL_GRACE_SECONDS,
  PHASE_ENTRY_GRACE_MS,
  getNextTimestamp,
  clampVal,
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
import { speakText } from './tts.js';
import { evaluateStickyPriorityFeedback } from './feedback.js';
import { switchViewState, updateDebugReadouts } from './uiControls.js';

// ============================================================================
// 10. 實時訓練主迴圈與四大百分比指標 (Section C: STATE_TRAINING)
// ============================================================================
export async function runTrainingSequence() {
  if (!AppState.isDemoMode && AppState.stream) {
    dom.trainVideo.srcObject = AppState.stream;
    await dom.trainVideo.play().catch(e => console.log(e));
  }

  const now = performance.now();
  const targetRR = AppState.targetBpm;

  AppState.training.startTime = now;
  AppState.training.lastFrameTime = now;
  AppState.training.phaseStartTime = now;
  AppState.training.cycleStartTime = now;
  AppState.ema.initialized = false;
  AppState.ema.faceInitialized = false;
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
  AppState.training.avgRR = targetRR;
  AppState.training.rollingWindow = [];
  AppState.training.pctInhale = 100;
  AppState.training.pctExhale = 100;
  AppState.training.pctShoulder = 100;
  AppState.training.pctRr = 100;
  AppState.training.totalInhaleFrames = 0;
  AppState.training.validInhaleFrames = 0;
  AppState.training.totalExhaleFrames = 0;
  AppState.training.validPlbExhaleFrames = 0;
  AppState.training.totalShoulderFrames = 0;
  AppState.training.validShoulderFrames = 0;
  AppState.training.totalInhaleTimeSec = 0;
  AppState.training.validInhaleTimeSec = 0;
  AppState.training.totalExhaleTimeSec = 0;
  AppState.training.validPlbExhaleTimeSec = 0;
  AppState.training.totalShoulderTimeSec = 0;
  AppState.training.validShoulderTimeSec = 0;

  AppState.feedback.latchedModule = null;
  AppState.feedback.currentPriority = 5;
  AppState.feedback.currentPMessage = '做得好，繼續跟住節奏慢慢呼吸';
  AppState.feedback.pendingMessage = '';

  if (dom.btnPauseTrain) {
    dom.btnPauseTrain.textContent = "⏸️ 暫停訓練";
  }

  applyPrivacyModeStyles();
  applyDisplayModeStyles();
  syncCanvasDimensions();
  window.addEventListener('resize', syncCanvasDimensions);

  triggerPhaseSwitch(PHASES.INHALE);
  updateLiveRespiratoryRate(now);
  renderIndicatorCards();

  requestAnimationFrame(trainingInferenceLoop);
}

export function syncCanvasDimensions() {
  if (dom.visionContainer && dom.trainCanvas && AppState.privacyMode !== 'minimalist') {
    dom.trainCanvas.width = dom.visionContainer.clientWidth || 640;
    dom.trainCanvas.height = dom.visionContainer.clientHeight || 480;
  }
}

/**
 * 切換相機顯示模式 (Section A.2 全域首字母大寫命名：
 * 實時鏡像模式 Mirror Mode / 去識別化骨架網格模式 Privacy Mesh Mode / 純引導模式 Pure Guiding Mode)
 */
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

  if (mode === 'minimalist') {
    // 【Task B】純引導模式 Pure Guiding Mode：隱藏左側視訊欄，將呼吸氣球/真人示範圖放大至佔訓練頁約 40% 空間
    if (dom.visionContainer) {
      dom.visionContainer.className = "w-px h-px opacity-0 pointer-events-none fixed -left-[9999px] overflow-hidden";
    }
    if (dom.guidancePanel) {
      dom.guidancePanel.className = "w-full flex-1 h-full bg-[#f5fafd] flex flex-col items-center justify-between p-4 md:p-6 overflow-y-auto pure-guiding-mode";
    }
    if (dom.pacerVisualArea) {
      dom.pacerVisualArea.className = "flex-1 flex flex-col items-center justify-center py-3 relative min-h-[44vh] w-full max-w-3xl mx-auto text-center";
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
    // 雙欄模式：實時鏡像模式 Mirror Mode / 去識別化骨架網格模式 Privacy Mesh Mode
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
    setTimeout(syncCanvasDimensions, 50);
  }
}

/**
 * 切換呼吸引導顯示模式：氣球模式 vs 真人示範 (男性 / 女性)
 */
export function applyDisplayModeStyles() {
  const isHuman = AppState.displayMode === 'human';
  const gender = AppState.humanGender;

  const idleActive = "flex-1 py-2 px-3 rounded-xl text-xs font-bold bg-[#2E7D32] text-white shadow-sm transition cursor-pointer";
  const idleInactive = "flex-1 py-2 px-3 rounded-xl text-xs font-semibold bg-white hover:bg-teal-50 text-slate-600 border border-slate-200 transition cursor-pointer";

  if (dom.btnPacerBalloon) dom.btnPacerBalloon.className = !isHuman ? idleActive : idleInactive;
  if (dom.btnPacerHuman) dom.btnPacerHuman.className = isHuman ? idleActive : idleInactive;
  if (dom.wrapperHumanGender) {
    dom.wrapperHumanGender.classList.toggle('hidden', !isHuman);
  }
  if (dom.btnGenderMale) dom.btnGenderMale.className = gender === 'male' ? idleActive : idleInactive;
  if (dom.btnGenderFemale) dom.btnGenderFemale.className = gender === 'female' ? idleActive : idleInactive;

  const trainActive = "px-2.5 py-1 rounded-lg text-xs font-bold bg-[#2E7D32] text-white shadow-sm transition cursor-pointer";
  const trainInactive = "px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-600 transition cursor-pointer";
  if (dom.btnTrainBalloon) dom.btnTrainBalloon.className = !isHuman ? trainActive : trainInactive;
  if (dom.btnTrainMale) dom.btnTrainMale.className = (isHuman && gender === 'male') ? trainActive : trainInactive;
  if (dom.btnTrainFemale) dom.btnTrainFemale.className = (isHuman && gender === 'female') ? trainActive : trainInactive;

  const imgPair = HUMAN_IMAGES[gender] || HUMAN_IMAGES.male;
  if (dom.imgHumanInhale && dom.imgHumanInhale.getAttribute('src') !== imgPair.inhale) {
    dom.imgHumanInhale.src = imgPair.inhale;
  }
  if (dom.imgHumanExhale && dom.imgHumanExhale.getAttribute('src') !== imgPair.exhale) {
    dom.imgHumanExhale.src = imgPair.exhale;
  }

  if (dom.pacerOuterRing) {
    dom.pacerOuterRing.classList.toggle('hidden', isHuman);
  }
  if (dom.humanDemoWrapper) {
    dom.humanDemoWrapper.classList.toggle('hidden', !isHuman);
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

export function trainingInferenceLoop() {
  if (AppState.currentState !== STATES.TRAINING) return;

  if (AppState.isPaused) {
    requestAnimationFrame(trainingInferenceLoop);
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
  dom.valTimerLeft.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  dom.valCycleCount.textContent = train.cycleIndex;

  if (remainingTotal <= 0) {
    finalizeCurrentCycle(now, train.isSoftTransitioning);
    switchViewState(STATES.SUMMARY);
    return;
  }

  // 1. 即時更新實測呼吸頻率 (Actual RR)
  updateLiveRespiratoryRate(now);

  // 2. 取得視訊推論或模擬特徵點並更新 20 秒滾動時間窗百分比
  if (AppState.isDemoMode) {
    const sim = generateSimulatedDetections(now);
    AppState.lastFaceResult = sim.faceResult;
    AppState.lastPoseResult = sim.poseResult;
    processFrameDetections(sim.faceResult, sim.poseResult, now, dt);
  } else if (dom.trainVideo.readyState >= 2 && AppState.faceLandmarker && AppState.poseLandmarker) {
    try {
      const ts = getNextTimestamp();
      const faceResult = AppState.faceLandmarker.detectForVideo(dom.trainVideo, ts);
      const poseResult = AppState.poseLandmarker.detectForVideo(dom.trainVideo, ts);

      AppState.lastFaceResult = faceResult;
      AppState.lastPoseResult = poseResult;

      processFrameDetections(faceResult, poseResult, now, dt);
    } catch (e) {
      console.warn("推論幀略過:", e);
    }
  }

  // 3. 呼吸節奏狀態機推進 (包含呼氣 70% 柔性過渡)
  advanceBreathingPacer(now);

  // 4. 繪製視覺 Canvas 覆蓋層
  renderTrainingCanvas(AppState.lastFaceResult, AppState.lastPoseResult);

  // 5. 更新調試面板讀數
  updateDebugReadouts();

  requestAnimationFrame(trainingInferenceLoop);
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
    // 取最近週期（支援 20 秒滾動感知）計算實測呼吸頻率
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
    dom.valLiveRr.textContent = liveAvgRR.toFixed(1);
  }
}

// ----------------------------------------------------------------------------
// 逐幀特徵點運算、20秒滾動時間窗百分比與 Sticky Priority Latch 評估
// ----------------------------------------------------------------------------
export function processFrameDetections(faceResult, poseResult, now = performance.now(), dt = 0.033) {
  const m = AppState.currentMetrics;
  const cal = AppState.calibration;
  const train = AppState.training;

  const hasFace = !!(faceResult && faceResult.faceLandmarks && faceResult.faceLandmarks.length > 0);
  const hasPose = !!(poseResult && poseResult.landmarks && poseResult.landmarks.length > 0);
  m.hasFace = hasFace;
  m.hasPose = hasPose;

  if (!hasFace || !hasPose) {
    evaluateStickyPriorityFeedback(false);
    return;
  }

  const face = faceResult.faceLandmarks[0];
  const pose = poseResult.landmarks[0];

  // 【C.1 原始訊號 EMA 濾波】先對 LAR、jawOpen、mouthPucker、mouthFunnel 進行 EMA 濾波再進入評分
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

  // EMA 雙肩平滑 + 軀幹耳肩相對基準定位 (Torso Anchoring)
  const shoulder = calculateShoulderMetrics(pose, m.dEye, cal.distBase);
  m.y11Smooth = shoulder.y11Smooth;
  m.y12Smooth = shoulder.y12Smooth;
  m.yShoulderCurr = shoulder.yShoulderCurr;
  m.distCurr = shoulder.distCurr;
  m.deltaYRelative = shoulder.deltaYRelative;
  m.deltaYShoulder = shoulder.deltaYRelative;
  m.shoulderTilt = shoulder.shoulderTilt;

  // 沉肩指標連續評分與合格判定
  const isShoulderRelaxed = m.deltaYRelative <= THRESHOLDS.shoulderHikeWarn;
  const shoulderScore = isShoulderRelaxed
    ? 1.0
    : clampVal(1 - (m.deltaYRelative - THRESHOLDS.shoulderHikeWarn) / Math.max(THRESHOLDS.shoulderHikeWarn * 0.5, 0.02), 0, 1);
  m.shoulderScore = shoulderScore;

  // 【C.2 連續模糊評分 (0.0 – 1.0)】取代單純布林一刀切
  let inhaleScore = getInhaleScore(m.lar, m.jawOpen);
  let exhaleScore = getExhaleScore(m.lar, m.mouthPucker, m.mouthFunnel);

  // 【C.5 動作動量豁免 (Action-Momentum Exemption — Δ Trend Check)】
  // 吸氣若嘴巴正主動閉合 (ΔLAR < 0) 或呼氣若嘴唇正主動噘起 (ΔmouthPucker > 0)，豁免提升為 1.0
  inhaleScore = applyActionMomentumExemption(PHASES.INHALE, inhaleScore, m.deltaLar, m.deltaMouthPucker);
  exhaleScore = applyActionMomentumExemption(PHASES.EXHALE, exhaleScore, m.deltaLar, m.deltaMouthPucker);

  // 全程沉肩統計累計 (時間加權 dt)
  train.totalShoulderFrames++;
  train.totalShoulderTimeSec += dt;
  train.validShoulderTimeSec += shoulderScore * dt;
  if (isShoulderRelaxed) {
    train.validShoulderFrames++;
  }

  let currentPhaseScore = 1.0;

  if (train.currentPhase === PHASES.INHALE) {
    // 【C.4 雙向 400ms 階段轉換緩衝期 — 吸氣開頭 400ms，每週期嚴格僅觸發一次】
    if (!train.inhaleGraceCompleted) {
      if (train.inhaleGraceCycleTriggered === train.cycleIndex && (now - train.inhaleEntryTimestamp) <= PHASE_ENTRY_GRACE_MS) {
        inhaleScore = 1.0;
      } else {
        train.inhaleGraceCompleted = true;
      }
    }

    m.inhaleScore = inhaleScore;
    currentPhaseScore = inhaleScore;

    train.totalInhaleFrames++;
    train.totalInhaleTimeSec += dt;
    train.validInhaleTimeSec += inhaleScore * dt;
    if (inhaleScore >= 0.70) {
      train.validInhaleFrames++;
      if (isShoulderRelaxed) {
        train.tInActual += inhaleScore * dt;
      }
    }
  } else {
    // 呼氣階段 (EXHALE)
    // 【C.4 雙向 400ms 階段轉換緩衝期 — 呼氣開頭 400ms，每週期嚴格僅觸發一次】
    if (!train.exhaleGraceCompleted) {
      if (train.exhaleGraceCycleTriggered === train.cycleIndex && (now - train.exhaleEntryTimestamp) <= PHASE_ENTRY_GRACE_MS) {
        exhaleScore = 1.0;
      } else {
        train.exhaleGraceCompleted = true;
      }
    }

    train.totalExhaleFrames++;
    train.totalExhaleTimeSec += dt;

    const phaseElapsed = (now - train.phaseStartTime) / 1000;
    const isOver70Pct = phaseElapsed >= (AppState.exhaleTarget * THRESHOLDS.earlyExhaleRatio);
    const isGoodPlbDuration = train.tExActual >= (phaseElapsed * 0.50);
    const isLipsNaturallyRelaxed = (m.lar < THRESHOLDS.larExhaleMin) || (m.mouthPucker < THRESHOLDS.puckerClosedErrMax);

    if (isOver70Pct && isGoodPlbDuration && isLipsNaturallyRelaxed) {
      if (!train.isSoftTransitioning) {
        train.isSoftTransitioning = true;
        train.softTransitionStartTime = now;
        const currentProgress = Math.min(1, phaseElapsed / AppState.exhaleTarget);
        train.softTransitionStartScale = 1.30 - (currentProgress * 0.45);
      }
    }

    // 若已進入 70% 呼氣柔性過渡期，連續分數視為 1.0
    if (train.isSoftTransitioning || (isOver70Pct && isGoodPlbDuration)) {
      exhaleScore = 1.0;
    }

    m.exhaleScore = exhaleScore;
    currentPhaseScore = exhaleScore;

    train.validPlbExhaleTimeSec += exhaleScore * dt;
    if (exhaleScore >= 0.70) {
      train.validPlbExhaleFrames++;
      train.tExActual += exhaleScore * dt;
    }
  }

  // ==========================================================================
  // 【C.3 時間加權 (dt) 20 秒滾動時間窗】weightedScore = Σ(score_i * dt_i) / Σ(dt_i)
  // ==========================================================================
  const elapsedSec = train.elapsedSeconds;
  train.rollingWindow.push({
    t: elapsedSec,
    dt: dt,
    phase: train.currentPhase,
    score: currentPhaseScore,
    inhaleScore: inhaleScore,
    exhaleScore: exhaleScore,
    shoulderScore: shoulderScore,
    inhaleValid: inhaleScore >= 0.70,
    exhaleValid: exhaleScore >= 0.70,
    shoulderValid: shoulderScore >= 0.70
  });

  // 移除超過 20 秒以前之舊樣本
  const cutoffTime = elapsedSec - ROLLING_WINDOW_SECONDS;
  while (train.rollingWindow.length > 0 && train.rollingWindow[0].t < cutoffTime) {
    train.rollingWindow.shift();
  }

  if (elapsedSec < INITIAL_GRACE_SECONDS) {
    // 訓練開始前 10 秒設為「開局緩衝期」，期間預設顯示 100%
    train.pctInhale = 100;
    train.pctExhale = 100;
    train.pctShoulder = 100;
    train.pctRr = 100;
  } else {
    let winInDtSum = 0;
    let winInWeightedSum = 0;
    let winExDtSum = 0;
    let winExWeightedSum = 0;
    let winShDtSum = 0;
    let winShWeightedSum = 0;

    for (let i = 0; i < train.rollingWindow.length; i++) {
      const s = train.rollingWindow[i];
      const itemDt = s.dt;
      const shScore = (typeof s.shoulderScore === 'number') ? s.shoulderScore : (s.shoulderValid ? 1.0 : 0.0);
      winShDtSum += itemDt;
      winShWeightedSum += shScore * itemDt;

      if (s.phase === PHASES.INHALE) {
        const inScore = (typeof s.inhaleScore === 'number') ? s.inhaleScore : (s.inhaleValid ? 1.0 : 0.0);
        winInDtSum += itemDt;
        winInWeightedSum += inScore * itemDt;
      } else {
        const exScore = (typeof s.exhaleScore === 'number') ? s.exhaleScore : (s.exhaleValid ? 1.0 : 0.0);
        winExDtSum += itemDt;
        winExWeightedSum += exScore * itemDt;
      }
    }

    // 模組 1【合口吸氣】時間加權百分比: Σ(score_i * dt_i) / Σ(dt_i)
    if (winInDtSum >= 0.25) {
      train.pctInhale = clampVal(Math.round((winInWeightedSum / winInDtSum) * 100), 0, 100);
    }
    // 模組 2【噘唇呼氣】時間加權百分比: Σ(score_i * dt_i) / Σ(dt_i)
    if (winExDtSum >= 0.25) {
      train.pctExhale = clampVal(Math.round((winExWeightedSum / winExDtSum) * 100), 0, 100);
    }
    // 模組 3【沉肩放鬆】時間加權百分比: Σ(score_i * dt_i) / Σ(dt_i)
    if (winShDtSum >= 0.25) {
      train.pctShoulder = clampVal(Math.round((winShWeightedSum / winShDtSum) * 100), 0, 100);
    }
    // 模組 4【呼吸速率】準確度百分比：max(0, round((1 - |Actual_RR - Target_RR| / Target_RR) * 100))%
    const targetRR = Math.max(1, AppState.targetBpm);
    const actualRR = train.avgRR;
    train.pctRr = clampVal(Math.max(0, Math.round((1 - Math.abs(actualRR - targetRR) / targetRR) * 100)), 0, 100);
  }

  // 更新四張百分比生物反饋指示卡 (C.3) 與底部鎖定平滑過渡橫幅 (C.4)
  renderIndicatorCards();
  evaluateStickyPriorityFeedback(true);
}

// ----------------------------------------------------------------------------
// 節奏球 / 真人示範與週期狀態機推進 (Pacer Timing & 70% Soft Transition)
// ----------------------------------------------------------------------------
export function advanceBreathingPacer(now) {
  const train = AppState.training;
  const phaseElapsed = (now - train.phaseStartTime) / 1000;

  if (train.currentPhase === PHASES.INHALE) {
    const progress = Math.min(1, phaseElapsed / AppState.inhaleTarget);
    const secsLeft = Math.max(0, AppState.inhaleTarget - phaseElapsed).toFixed(1);

    dom.pacerActionText.textContent = "用鼻吸氣";
    dom.pacerSecondsText.textContent = `${secsLeft}s`;
    if (dom.humanActionText) dom.humanActionText.textContent = "用鼻吸氣";
    if (dom.humanSecondsText) dom.humanSecondsText.textContent = `${secsLeft}s`;
    if (dom.pacerPhaseHint) dom.pacerPhaseHint.textContent = "閉口由鼻吸氣 · 雙肩保持下沉";

    const scale = 0.85 + (progress * 0.45);
    dom.pacerBall.style.transform = `scale(${scale})`;
    const isMinimalIn = AppState.privacyMode === "minimalist";
    dom.pacerBall.className = `w-32 h-32 md:w-36 md:h-36 ${isMinimalIn ? "pure-guiding-ball " : ""}rounded-full pacer-inhale-style flex flex-col items-center justify-center text-white font-bold transition-transform duration-100`;

    if (phaseElapsed >= AppState.inhaleTarget) {
      triggerPhaseSwitch(PHASES.EXHALE);
    }
  } else {
    // 呼氣階段 (EXHALE)：支援 70% 達標後即刻平滑收尾過渡至下一次吸氣
    if (train.isSoftTransitioning) {
      const softDuration = 0.35; // 350ms 平滑收尾動畫
      const softElapsed = (now - train.softTransitionStartTime) / 1000;
      const softProgress = Math.min(1, softElapsed / softDuration);
      const startScale = train.softTransitionStartScale || 0.95;
      const scale = startScale - (startScale - 0.85) * softProgress;

      dom.pacerActionText.textContent = "合格呼氣完成";
      dom.pacerSecondsText.textContent = "平順過渡";
      if (dom.humanActionText) dom.humanActionText.textContent = "合格呼氣完成";
      if (dom.humanSecondsText) dom.humanSecondsText.textContent = "平順過渡";
      if (dom.pacerPhaseHint) dom.pacerPhaseHint.textContent = "呼氣已達標完成 · 平順進入下一次吸氣";

      dom.pacerBall.style.transform = `scale(${scale})`;

      if (dom.imgHumanInhale && dom.imgHumanExhale) {
        dom.imgHumanInhale.classList.add('active-img');
        dom.imgHumanExhale.classList.remove('active-img');
      }

      if (softProgress >= 1) {
        finalizeCurrentCycle(now, true);
        train.cycleIndex++;
        train.cycleStartTime = now;
        triggerPhaseSwitch(PHASES.INHALE);
      }
      return;
    }

    const progress = Math.min(1, phaseElapsed / AppState.exhaleTarget);
    const secsLeft = Math.max(0, AppState.exhaleTarget - phaseElapsed).toFixed(1);

    dom.pacerActionText.textContent = "噘唇吹氣";
    dom.pacerSecondsText.textContent = `${secsLeft}s`;
    if (dom.humanActionText) dom.humanActionText.textContent = "噘唇吹氣";
    if (dom.humanSecondsText) dom.humanSecondsText.textContent = `${secsLeft}s`;
    if (dom.pacerPhaseHint) dom.pacerPhaseHint.textContent = "嘴唇噘起如吹蠟燭 · 均勻慢呼";

    const scale = 1.30 - (progress * 0.45);
    dom.pacerBall.style.transform = `scale(${scale})`;
    const isMinimalEx = AppState.privacyMode === "minimalist";
    dom.pacerBall.className = `w-32 h-32 md:w-36 md:h-36 ${isMinimalEx ? "pure-guiding-ball " : ""}rounded-full pacer-exhale-style flex flex-col items-center justify-center text-white font-bold transition-transform duration-100`;

    if (phaseElapsed >= AppState.exhaleTarget) {
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

  // 【C.4 雙向 400ms 階段轉換緩衝期】嚴格限制每個呼吸週期之吸氣與呼氣各僅能觸發一次
  if (newPhase === PHASES.INHALE) {
    if (train.inhaleGraceCycleTriggered !== train.cycleIndex) {
      train.inhaleGraceCycleTriggered = train.cycleIndex;
      train.inhaleEntryTimestamp = now;
      train.inhaleGraceCompleted = false;
    }
  } else if (newPhase === PHASES.EXHALE) {
    if (train.exhaleGraceCycleTriggered !== train.cycleIndex) {
      train.exhaleGraceCycleTriggered = train.cycleIndex;
      train.exhaleEntryTimestamp = now;
      train.exhaleGraceCompleted = false;
    }
  }

  const isInhale = newPhase === PHASES.INHALE;
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
}

export function finalizeCurrentCycle(now = performance.now(), wasSoftTransition = false) {
  const train = AppState.training;
  const safeTin = Math.max(train.tInActual, 0.5);
  const achievedIeRatio = train.tExActual / safeTin;
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

  train.tInActual = 0;
  train.tExActual = 0;
}

// ----------------------------------------------------------------------------
// 【C.3 模組 UI 顯示與三段式合格標準】
// 每個模組卡片只清晰顯示「指標名稱」、「狀態標籤」及「大字體百分比（如 88%）」
// - >= 80%：合格達標（綠色柔和樣式）
// - 70% – 79%：持續保持（淺藍/中性緩衝樣式，唔觸發新警示）
// - < 70%：需要改善（橙紅警示樣式，並納入警示排程）
// ----------------------------------------------------------------------------
export function applyModuleCardStyle(cardEl, stateEl, pctEl, pctVal, isLatchedTarget = false) {
  if (!cardEl || !stateEl || !pctEl) return;
  const clamped = clampVal(Math.round(pctVal), 0, 100);
  pctEl.textContent = `${clamped}%`;

  if (clamped >= 80) {
    stateEl.textContent = "合格達標";
    stateEl.className = "text-xs md:text-sm font-extrabold text-[#2E7D32]";
    pctEl.className = "text-2xl md:text-3xl font-black font-mono text-[#2E7D32]";
    cardEl.className = "p-3.5 rounded-2xl bg-emerald-50/85 border border-emerald-200 flex items-center justify-between transition-all shadow-sm";
  } else if (clamped >= 70) {
    stateEl.textContent = "持續保持";
    stateEl.className = "text-xs md:text-sm font-extrabold text-sky-700";
    pctEl.className = "text-2xl md:text-3xl font-black font-mono text-sky-700";
    cardEl.className = "p-3.5 rounded-2xl bg-sky-50/85 border border-sky-200 flex items-center justify-between transition-all shadow-sm";
  } else {
    stateEl.textContent = isLatchedTarget ? "需要改善 (優先修正)" : "需要改善";
    stateEl.className = "text-xs md:text-sm font-extrabold text-rose-600";
    pctEl.className = "text-2xl md:text-3xl font-black font-mono text-rose-600";
    const pulseCls = isLatchedTarget ? " shoulder-alert-active" : "";
    cardEl.className = `p-3.5 rounded-2xl bg-rose-50/90 border border-rose-300 flex items-center justify-between transition-all shadow-sm${pulseCls}`;
  }
}

export function renderIndicatorCards() {
  const train = AppState.training;
  const latched = AppState.feedback.latchedModule;

  applyModuleCardStyle(dom.cardInhale, dom.textInhaleState, dom.badgeInhalePct, train.pctInhale, latched === 'inhale');
  applyModuleCardStyle(dom.cardExhale, dom.textExhaleState, dom.badgeExhalePct, train.pctExhale, latched === 'exhale');
  applyModuleCardStyle(dom.cardShoulder, dom.textShoulderState, dom.badgeShoulderPct, train.pctShoulder, latched === 'shoulder');
  applyModuleCardStyle(dom.cardRr, dom.textRrState, dom.badgeRrPct, train.pctRr, latched === 'rr');
}

// ----------------------------------------------------------------------------
// Canvas 覆蓋繪製 (Section 5 Canvas Rendering & Privacy Mesh Mode)
// ----------------------------------------------------------------------------
export function renderTrainingCanvas(faceResults, poseResults) {
  const canvas = dom.trainCanvas;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const mode = AppState.privacyMode;
  const m = AppState.currentMetrics;

  ctx.clearRect(0, 0, w, h);

  if (mode === 'minimalist') return;

  if (mode === 'privacy_mesh' || AppState.isDemoMode) {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, w, h);
  }

  if (!m.hasFace && !m.hasPose) return;

  // 繪製耳肩相對基準垂線與 EMA 平滑後雙肩骨架連線
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

  // 繪製嘴唇與面部多邊形
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
    ctx.restore();
  }
}

