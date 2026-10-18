/**
 * 舒呼(SootheBreath) v7.0 ES6 Module — cvEngine.js
 * 核心電腦視覺幾何運算、臨床生物力學判定公式與免鏡頭模擬器 (Core CV Math & Clinical Algorithms)
 */

import { STATES, PHASES, THRESHOLDS, clampVal, ema, AppState } from './state.js';

// ============================================================================
// 5. 核心電腦視覺運算公式 (Section 3 Math & Upgraded Clinical Algorithms)
// ============================================================================

/**
 * 雙眼外眥間距 (Inter-ocular Distance, D_eye)
 * Face Landmark 33 (右眼外眼角) 與 263 (左眼外眼角)
 */
export function calculateDEye(faceLandmarks) {
  const p33 = faceLandmarks[33];
  const p263 = faceLandmarks[263];
  return Math.hypot(p33.x - p263.x, p33.y - p263.y);
}

/**
 * 嘴唇開合長寬比 (Lip Aspect Ratio, LAR)
 * 上唇內緣中點 13、下唇內緣中點 14、左嘴角 78、右嘴角 308
 */
export function calculateLAR(faceLandmarks) {
  const p13 = faceLandmarks[13];
  const p14 = faceLandmarks[14];
  const p78 = faceLandmarks[78];
  const p308 = faceLandmarks[308];

  const lipHeight = Math.hypot(p13.x - p14.x, p13.y - p14.y);
  const lipWidth = Math.hypot(p78.x - p308.x, p78.y - p308.y);

  if (lipWidth === 0) return 0;
  return lipHeight / lipWidth;
}

/**
 * 提取 MediaPipe Face Blendshapes 分數
 * 包含 mouthPucker (噘唇)、mouthFunnel (漏斗狀微張) 及 jawOpen (下頜張開分數)
 */
export function extractBlendshapes(blendshapesList) {
  let mouthPucker = 0;
  let mouthFunnel = 0;
  let jawOpen = 0;

  if (blendshapesList && blendshapesList[0] && blendshapesList[0].categories) {
    const cats = blendshapesList[0].categories;
    for (let i = 0; i < cats.length; i++) {
      const name = cats[i].categoryName;
      if (name === 'mouthPucker') {
        mouthPucker = cats[i].score;
      } else if (name === 'mouthFunnel') {
        mouthFunnel = cats[i].score;
      } else if (name === 'jawOpen') {
        jawOpen = cats[i].score;
      }
    }
  }

  return { mouthPucker, mouthFunnel, jawOpen };
}

/**
 * 【EMA 座標平滑處理】
 * 對 MediaPipe Pose 提取的雙肩座標（Landmark 11 左肩, 12 右肩）套用指數移動平均濾波：
 * Y_smooth = alpha * Y_curr + (1 - alpha) * Y_prev（預設 alpha = 0.35）
 */
export function smoothShoulderLandmarksEMA(poseLandmarks, alpha = THRESHOLDS.emaAlpha) {
  const y11Curr = poseLandmarks[11].y;
  const y12Curr = poseLandmarks[12].y;

  if (!AppState.ema.initialized) {
    AppState.ema.y11Prev = y11Curr;
    AppState.ema.y12Prev = y12Curr;
    AppState.ema.initialized = true;
  } else {
    AppState.ema.y11Prev = alpha * y11Curr + (1 - alpha) * AppState.ema.y11Prev;
    AppState.ema.y12Prev = alpha * y12Curr + (1 - alpha) * AppState.ema.y12Prev;
  }

  const y11Smooth = AppState.ema.y11Prev;
  const y12Smooth = AppState.ema.y12Prev;
  const yShoulderSmooth = (y11Smooth + y12Smooth) / 2;

  return { y11Smooth, y12Smooth, yShoulderSmooth };
}

/**
 * 【軀幹/耳肩相對基準定位 (Torso Anchoring)】
 * 計算雙肩相對於頭部/耳部（Pose Landmark 7 左耳、8 右耳）的垂直相對間距：
 * Dist_ear_shoulder = ((pose[11].y - pose[7].y) + (pose[12].y - pose[8].y)) / 2
 */
export function calculateEarShoulderDistance(poseLandmarks, y11Smooth, y12Smooth) {
  const shoulderLeftY = (typeof y11Smooth === 'number') ? y11Smooth : poseLandmarks[11].y;
  const shoulderRightY = (typeof y12Smooth === 'number') ? y12Smooth : poseLandmarks[12].y;
  const earLeftY = poseLandmarks[7] ? poseLandmarks[7].y : (shoulderLeftY - 0.25);
  const earRightY = poseLandmarks[8] ? poseLandmarks[8].y : (shoulderRightY - 0.25);

  return ((shoulderLeftY - earLeftY) + (shoulderRightY - earRightY)) / 2;
}

export function calculateShoulderMetrics(poseLandmarks, dEye, distBase) {
  const { y11Smooth, y12Smooth, yShoulderSmooth } = smoothShoulderLandmarksEMA(poseLandmarks, THRESHOLDS.emaAlpha);
  const distCurr = calculateEarShoulderDistance(poseLandmarks, y11Smooth, y12Smooth);
  const dEyeSafe = Math.max(dEye, 0.05);

  // 聳肩或縮頸時耳肩距離縮短 (Dist_curr < Dist_base)，Delta_Y_relative 為正值
  const deltaYRelative = (distBase - distCurr) / dEyeSafe;
  const shoulderTilt = Math.abs(y11Smooth - y12Smooth) / dEyeSafe;

  return {
    y11Smooth,
    y12Smooth,
    yShoulderCurr: yShoulderSmooth,
    distCurr,
    deltaYRelative,
    deltaYShoulder: deltaYRelative,
    shoulderTilt
  };
}

/**
 * 【C.1 面部訊號 EMA 指數移動平均濾波與 Δ 動量計算】
 * 在進入任何評分或判定函式前，對原始訊號進行 EMA 平滑以消除 MediaPipe (±0.02) 高頻抖動：
 * - LAR_filtered = ema(LAR_raw, prev, 0.25)
 * - jawOpen_filtered = ema(jawOpen_raw, prev, 0.25)
 * - mouthPucker_filtered = ema(mouthPucker_raw, prev, 0.30)
 * - mouthFunnel_filtered = ema(mouthFunnel_raw, prev, 0.30)
 * 並以濾波後數值計算 ΔLAR 與 ΔmouthPucker 供動作動量豁免 (Action-Momentum Exemption) 使用。
 */
export function smoothFacialSignalsEMA(rawLar, rawJawOpen, rawMouthPucker, rawMouthFunnel = 0) {
  const alphaLar = THRESHOLDS.emaLarAlpha || 0.25;
  const alphaJaw = THRESHOLDS.emaJawAlpha || 0.25;
  const alphaPucker = THRESHOLDS.emaPuckerAlpha || 0.30;

  if (!AppState.ema.faceInitialized) {
    AppState.ema.larPrev = rawLar;
    AppState.ema.jawOpenPrev = rawJawOpen;
    AppState.ema.mouthPuckerPrev = rawMouthPucker;
    AppState.ema.mouthFunnelPrev = rawMouthFunnel;
    AppState.ema.deltaLar = 0;
    AppState.ema.deltaJawOpen = 0;
    AppState.ema.deltaMouthPucker = 0;
    AppState.ema.deltaMouthFunnel = 0;
    AppState.ema.faceInitialized = true;
  } else {
    const prevLar = AppState.ema.larPrev;
    const prevJaw = AppState.ema.jawOpenPrev;
    const prevPucker = AppState.ema.mouthPuckerPrev;
    const prevFunnel = AppState.ema.mouthFunnelPrev;

    const larFiltered = ema(rawLar, prevLar, alphaLar);
    const jawOpenFiltered = ema(rawJawOpen, prevJaw, alphaJaw);
    const mouthPuckerFiltered = ema(rawMouthPucker, prevPucker, alphaPucker);
    const mouthFunnelFiltered = ema(rawMouthFunnel, prevFunnel, alphaPucker);

    AppState.ema.deltaLar = larFiltered - prevLar;
    AppState.ema.deltaJawOpen = jawOpenFiltered - prevJaw;
    AppState.ema.deltaMouthPucker = mouthPuckerFiltered - prevPucker;
    AppState.ema.deltaMouthFunnel = mouthFunnelFiltered - prevFunnel;

    AppState.ema.larPrev = larFiltered;
    AppState.ema.jawOpenPrev = jawOpenFiltered;
    AppState.ema.mouthPuckerPrev = mouthPuckerFiltered;
    AppState.ema.mouthFunnelPrev = mouthFunnelFiltered;
  }

  return {
    larFiltered: AppState.ema.larPrev,
    jawOpenFiltered: AppState.ema.jawOpenPrev,
    mouthPuckerFiltered: AppState.ema.mouthPuckerPrev,
    mouthFunnelFiltered: AppState.ema.mouthFunnelPrev,
    deltaLar: AppState.ema.deltaLar,
    deltaJawOpen: AppState.ema.deltaJawOpen,
    deltaMouthPucker: AppState.ema.deltaMouthPucker,
    deltaMouthFunnel: AppState.ema.deltaMouthFunnel
  };
}

/**
 * 【C.2 連續模糊評分 — 吸氣階段 (getInhaleScore: 0.0 至 1.0)】
 * 對 LAR_filtered 與 jawOpen_filtered 分別計算連續衰減分數並取 Math.min：
 * score = clamp(1 - (val_filtered - maxThreshold) / max(maxThreshold * 0.3, 0.01), 0, 1)
 */
export function getInhaleScore(larFiltered, jawOpenFiltered) {
  const larMax = THRESHOLDS.larInhaleMax;
  const jawMax = THRESHOLDS.jawOpenInhaleMax;

  const larScore = clampVal(
    1 - (larFiltered - larMax) / Math.max(larMax * 0.3, 0.01),
    0,
    1
  );
  const jawScore = clampVal(
    1 - (jawOpenFiltered - jawMax) / Math.max(jawMax * 0.3, 0.01),
    0,
    1
  );

  return Math.min(larScore, jawScore);
}

/**
 * 【C.2 連續模糊評分 — 呼氣階段 (getExhaleScore: 0.0 至 1.0)】
 * - 若 mouthPucker_filtered (或 mouthFunnel_filtered) >= 閾值 (100%)：score = 1.0
 * - 若介乎閾值之 65% 至 100%：線性映射至 0.70 – 0.95
 * - 若低於閾值之 65%：score = 0.0
 */
export function getExhaleScore(larFiltered, mouthPuckerFiltered, mouthFunnelFiltered = 0) {
  if (typeof larFiltered === 'number' && larFiltered > THRESHOLDS.larExhaleWideErr) {
    return 0.0;
  }

  const puckerMin = Math.max(THRESHOLDS.mouthPuckerMin, 0.01);
  const funnelMin = Math.max(THRESHOLDS.mouthFunnelMin, 0.01);

  const puckerRatio = mouthPuckerFiltered / puckerMin;
  const funnelRatio = mouthFunnelFiltered / funnelMin;
  const effectiveRatio = Math.max(puckerRatio, funnelRatio);

  if (effectiveRatio >= 1.0) {
    return 1.0;
  }
  if (effectiveRatio >= 0.65) {
    return clampVal(0.70 + ((effectiveRatio - 0.65) / (1.0 - 0.65)) * (0.95 - 0.70), 0.70, 0.95);
  }
  return 0.0;
}

/**
 * 【C.5 動作動量豁免機制 (Action-Momentum Exemption — Δ Trend Check)】
 * 當病人絕對分數 < 1.0 時，根據 EMA 濾波後之肌肉移動方向判斷其正確動作意圖：
 * - 吸氣 (INHALE)：若嘴巴正主動閉合 (ΔLAR < 0)，豁免並將該幀分數提升為 1.0
 * - 呼氣 (EXHALE)：若嘴唇正主動噘起 (ΔmouthPucker > 0)，豁免並將該幀分數提升為 1.0
 */
export function applyActionMomentumExemption(phase, baseScore, deltaLar, deltaMouthPucker) {
  if (baseScore >= 1.0) return 1.0;
  if (phase === PHASES.INHALE && deltaLar < 0) {
    return 1.0;
  }
  if (phase === PHASES.EXHALE && deltaMouthPucker > 0) {
    return 1.0;
  }
  return clampVal(baseScore, 0, 1);
}

/**
 * 向後兼容之布林輔助判定（連續模糊分數 >= 0.70 視為合格）
 */
export function isNasalInhaleValid(lar, jawOpen) {
  return getInhaleScore(lar, jawOpen) >= 0.70;
}

export function isPlbExhaleValid(lar, mouthPucker, mouthFunnel = 0) {
  return getExhaleScore(lar, mouthPucker, mouthFunnel) >= 0.70;
}

/**
 * 生成模擬生物特徵點 (供免鏡頭模擬模式 Demo Mode 使用，完整支援五步校準與訓練階段)
 */
export function generateSimulatedDetections(now) {
  const wave = Math.sin(now / 350);
  let lar = 0.035;
  let pucker = 0.08;
  let funnel = 0.06;
  let jawOpen = 0.015;
  let shoulderY = 0.72;
  let lipWidthHalf = 0.05;

  if (AppState.currentState === STATES.CALIBRATING) {
    const step = AppState.calibration.currentStep;
    if (step === 1) {
      // 第 1 步【閉嘴】
      lar = 0.034 + Math.abs(wave) * 0.004;
      jawOpen = 0.014 + Math.abs(wave) * 0.003;
      pucker = 0.08;
      funnel = 0.06;
      shoulderY = 0.72;
    } else if (step === 2) {
      // 第 2 步【張大口】
      lar = 0.36 + wave * 0.015;
      jawOpen = 0.42 + wave * 0.02;
      pucker = 0.05;
      funnel = 0.12;
      shoulderY = 0.72;
    } else if (step === 3) {
      // 第 3 步【噘唇】
      lar = 0.12 + wave * 0.01;
      jawOpen = 0.06;
      pucker = 0.54 + wave * 0.03;
      funnel = 0.46 + wave * 0.03;
      lipWidthHalf = 0.038;
      shoulderY = 0.72;
    } else if (step === 4) {
      // 第 4 步【縮膊頭】（雙肩向上縮起，耳肩距離縮短至 ~0.24）
      lar = 0.036;
      jawOpen = 0.015;
      shoulderY = 0.658 + wave * 0.003;
    } else {
      // 第 5 步【放鬆膊頭】（雙肩完全下沉放鬆，耳肩距離 ~0.30）
      lar = 0.035;
      jawOpen = 0.015;
      shoulderY = 0.72 + wave * 0.002;
    }
  } else {
    const train = AppState.training;
    const isExhale = train.currentPhase === PHASES.EXHALE;
    lar = isExhale ? (0.11 + wave * 0.02) : (0.032 + Math.abs(wave) * 0.008);
    pucker = isExhale ? (0.58 + wave * 0.06) : 0.08;
    funnel = isExhale ? (0.48 + wave * 0.05) : 0.06;
    jawOpen = isExhale ? 0.06 : 0.015;
    shoulderY = 0.72 + (isExhale ? 0.002 : -0.002);
  }

  const lipWidthTotal = lipWidthHalf * 2;
  const lipHeightHalf = (lar * lipWidthTotal) / 2;

  const face = [];
  for (let i = 0; i < 468; i++) {
    face.push({ x: 0.5, y: 0.42, z: 0 });
  }
  // D_eye = hypot(0.59 - 0.41, 0) = 0.18 -> let's set 0.39 and 0.61 so D_eye = 0.22
  face[33] = { x: 0.39, y: 0.36 };
  face[263] = { x: 0.61, y: 0.36 };
  face[78] = { x: 0.50 - lipWidthHalf, y: 0.49 };
  face[308] = { x: 0.50 + lipWidthHalf, y: 0.49 };
  face[13] = { x: 0.50, y: 0.49 - lipHeightHalf };
  face[14] = { x: 0.50, y: 0.49 + lipHeightHalf };

  const ovalIndices = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
  ovalIndices.forEach((idx, k) => {
    const angle = (k / ovalIndices.length) * Math.PI * 2 - Math.PI / 2;
    face[idx] = {
      x: 0.50 + Math.cos(angle) * 0.13,
      y: 0.40 + Math.sin(angle) * 0.17
    };
  });

  const pose = [];
  for (let i = 0; i < 33; i++) {
    pose.push({ x: 0.5, y: 0.7, z: 0 });
  }
  pose[7] = { x: 0.42, y: 0.42 };  // 左耳 Landmark 7
  pose[8] = { x: 0.58, y: 0.42 };  // 右耳 Landmark 8
  pose[11] = { x: 0.30, y: shoulderY }; // 左肩 Landmark 11
  pose[12] = { x: 0.70, y: shoulderY }; // 右肩 Landmark 12

  return {
    faceResult: {
      faceLandmarks: [face],
      faceBlendshapes: [{
        categories: [
          { categoryName: 'mouthPucker', score: pucker },
          { categoryName: 'mouthFunnel', score: funnel },
          { categoryName: 'jawOpen', score: jawOpen }
        ]
      }]
    },
    poseResult: {
      landmarks: [pose]
    }
  };
}

