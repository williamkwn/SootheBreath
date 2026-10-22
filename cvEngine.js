/**
 * 舒呼(SootheBreath) v10 ES6 Module — cvEngine.js
 * 核心電腦視覺幾何運算、16+4 點純 2D 幾何主導演算法、三柱穩健質量過濾與免鏡頭模擬器
 *
 * v10 核心升級重點：
 * 1. 16+4 點純 2D 幾何主導與零成本 3D 姿態門控 (extractV10MouthAndPoseMetrics)：
 *    - 外嘴角 (61, 291)、外唇正中 (0, 17)、內嘴角 (78, 308)、內唇左中右三柱 (82-87, 13-14, 312-317)、
 *      雙眼外角 (33, 263) 及剛性姿態錨點 (鼻尖 4、眉心 10、鼻底 2、下巴 152、左右顴骨 234, 454)。
 *    - Z 軸僅作選填微調項，當 |yawDeg| > 12° 或 |pitchDeg| > 10° 時強制將 Z 軸權重歸零。
 * 2. 內唇三柱雙層質量過濾與 3->2->1->0 分級穩健聚合：
 *    - 兼容未來 visibility/presence 欄位（絕不將預設 0 或 undefined 誤判為無效），結合畫面邊界、上下唇拓撲防反轉、
 *      側臉 |yawDeg| > 15° 自遮擋剔除、單幀劇烈跳變與跨柱異常值剔除。
 *    - 遮擋恢復後啟動 6 幀 (300ms) 漸進 EMA 平滑 Ramp 及首 4 幀 (200ms) 動量豁免暫停保護。
 * 3. 吸氣個人化開合比例尺 NOI (0%–22% 滿分寬容區 + 下巴微鬆協同豁免) 與呼氣中柱專屬 NOI_center 雙軌基準。
 * 4. 呼氣 85% 純 2D 幾何 (50% MWR 外嘴角收窄比 + 35% 中央氣孔守門員與 OLAR 外唇圓潤比) + 15% Blendshape 衝突解算。
 * 5. 免鏡頭模擬器採用明確 faceResult.isSimulated = true 標記並完整生成 16+4 點座標，廢除硬編碼座標檢查。
 */

import {
  STATES,
  PHASES,
  DEFAULT_CALIB_BASELINES,
  THRESHOLDS,
  OCCLUSION_HOLD_MAX_SEC,
  OCCLUSION_RECOVERY_TICKS,
  MOMENTUM_RECOVERY_PAUSE_TICKS,
  clampVal,
  ema,
  AppState
} from './state.js';

export const MOMENTUM_MIN_BASE_SCORE = 0.35;
export const MOMENTUM_DELTA_LAR_THRESHOLD = -0.008;
export const MOMENTUM_DELTA_PUCKER_THRESHOLD = 0.015;
export const MOMENTUM_DELTA_NOI_THRESHOLD = -0.012;
export const MOMENTUM_DELTA_MWR_THRESHOLD = -0.010;

// ============================================================================
// 5. 核心電腦視覺運算公式 (v10 16+4 點純 2D 幾何主導與三柱穩健臨床演算法)
// ============================================================================

/**
 * 雙眼外眥間距 (Inter-ocular Distance, D_eye)
 * Face Landmark 33 (右眼外眼角) 與 263 (左眼外眼角)
 */
export function calculateDEye(faceLandmarks) {
  const p33 = faceLandmarks[33];
  const p263 = faceLandmarks[263];
  if (!p33 || !p263) return DEFAULT_CALIB_BASELINES.D_eye;
  return Math.hypot(p33.x - p263.x, p33.y - p263.y);
}

/**
 * 傳統 4 點嘴唇開合長寬比 (Lip Aspect Ratio, LAR — 保留供向後兼容與輔助顯示)
 * 上唇內緣中點 13、下唇內緣中點 14、左內嘴角 78、右內嘴角 308
 */
export function calculateLAR(faceLandmarks) {
  const p13 = faceLandmarks[13];
  const p14 = faceLandmarks[14];
  const p78 = faceLandmarks[78];
  const p308 = faceLandmarks[308];
  if (!p13 || !p14 || !p78 || !p308) return 0;

  const lipHeight = Math.hypot(p13.x - p14.x, p13.y - p14.y);
  const lipWidth = Math.hypot(p78.x - p308.x, p78.y - p308.y);

  if (lipWidth === 0) return 0;
  return lipHeight / lipWidth;
}

/**
 * 【v10 核心】提取 16+4 點純 2D 嘴唇幾何、零成本 3D 頭部姿態 (Yaw/Pitch) 與三柱雙層質量過濾指標
 * @param {Array} faceLandmarks - MediaPipe 478 點面部座標陣列
 * @param {Object} cal - AppState.calibration 個人化校準基準
 * @param {Object} options - 附加選項 (如 { isSimulated: boolean })
 */
export function extractV10MouthAndPoseMetrics(faceLandmarks, cal = AppState.calibration, options = {}) {
  const isSimulated = Boolean(
    options.isSimulated ||
    (faceLandmarks && faceLandmarks.isSimulated) ||
    AppState.isDemoMode
  );

  const p33 = faceLandmarks[33];
  const p263 = faceLandmarks[263];
  const p4 = faceLandmarks[4];
  const p2 = faceLandmarks[2];
  const p152 = faceLandmarks[152];
  const p234 = faceLandmarks[234];
  const p454 = faceLandmarks[454];
  const p61 = faceLandmarks[61];
  const p291 = faceLandmarks[291];
  const p0 = faceLandmarks[0];
  const p17 = faceLandmarks[17];
  const p13 = faceLandmarks[13];
  const p14 = faceLandmarks[14];
  const p82 = faceLandmarks[82];
  const p87 = faceLandmarks[87];
  const p312 = faceLandmarks[312];
  const p317 = faceLandmarks[317];

  const dEyeRaw = calculateDEye(faceLandmarks);

  // 向後兼容保護：僅當外部舊式測試傳入未初始化外嘴角 (61 與 291 重疊為 0 距離) 之殘缺陣列時回退
  const outerSpanRaw = (p61 && p291) ? Math.hypot(p61.x - p291.x, p61.y - p291.y) : 0;
  if (outerSpanRaw < 1e-6 || !p0 || !p17 || !p82 || !p87 || !p312 || !p317) {
    const dEyeSafe = Math.max(dEyeRaw, 0.05);
    const larLegacy = calculateLAR(faceLandmarks);
    const wInnerNorm = (faceLandmarks[78] && faceLandmarks[308])
      ? Math.hypot(faceLandmarks[78].x - faceLandmarks[308].x, faceLandmarks[78].y - faceLandmarks[308].y) / dEyeSafe
      : 0.45;
    const wOuterEst = wInnerNorm * 1.02;
    const hInnerEst = larLegacy * wInnerNorm;
    const olarEst = Math.max(0.20, (hInnerEst + 0.09) / Math.max(wOuterEst, 0.15));
    return {
      isSimulated,
      dEye: dEyeSafe,
      yawDeg: 0,
      pitchDeg: 0,
      pitchRatio: DEFAULT_CALIB_BASELINES.pitchRatio_closed,
      hInnerRobust: hInnerEst,
      hCenter: hInnerEst * 1.08,
      wOuterNorm: wOuterEst,
      olar: olarEst,
      zProtrusion: DEFAULT_CALIB_BASELINES.zProtrusion_closed,
      poseValidForZ: true,
      validCols: 3,
      colMap: { L: hInnerEst * 0.92, M: hInnerEst * 1.08, R: hInnerEst * 0.92 }
    };
  }

  // 1. 零成本 3D 頭部姿態估算 (Yaw 水平偏航角 & Pitch 垂直俯仰角)
  let yawDeg = 0;
  if (p4 && p234 && p454) {
    const dL = Math.hypot(p4.x - p234.x, p4.y - p234.y);
    const dR = Math.hypot(p4.x - p454.x, p4.y - p454.y);
    if (dL + dR > 1e-4) {
      yawDeg = clampVal(((dR - dL) / (dL + dR)) * 90.0, -60.0, 60.0);
    }
  }

  let pitchRatio = DEFAULT_CALIB_BASELINES.pitchRatio_closed;
  if (p33 && p263 && p2 && p152) {
    const eyeMidY = (p33.y + p263.y) * 0.5;
    const noseToChinY = Math.max(p152.y - p2.y, 0.02);
    const eyeToNoseY = p2.y - eyeMidY;
    if (eyeToNoseY > 0.005) {
      pitchRatio = eyeToNoseY / noseToChinY;
    }
  }
  const pitchBase = (cal && typeof cal.pitchRatio_closed === 'number')
    ? cal.pitchRatio_closed
    : DEFAULT_CALIB_BASELINES.pitchRatio_closed;
  const pitchDeg = clampVal((pitchRatio - pitchBase) * 75.0, -45.0, 45.0);

  // 眼距加入側臉餘弦補償，防止轉頭時分母縮細導致高度膨脹
  const yawCos = Math.max(Math.cos((yawDeg * Math.PI) / 180.0), 0.80);
  const dEye = Math.max(dEyeRaw / yawCos, 0.05);

  // 2. 內唇左 (82-87)、中 (13-14)、右 (312-317) 三柱雙層質量過濾
  const yawSideLimit = THRESHOLDS.yawSideFilterDeg || 15.0;
  const cols = [
    { id: 'L', up: p82, low: p87, yawBlocked: yawDeg < -yawSideLimit },
    { id: 'M', up: p13, low: p14, yawBlocked: false },
    { id: 'R', up: p312, low: p317, yawBlocked: yawDeg > yawSideLimit }
  ];

  const hMRaw = Math.hypot(p13.x - p14.x, p13.y - p14.y) / dEye;
  const hLRaw = Math.hypot(p82.x - p87.x, p82.y - p87.y) / dEye;
  const hRRaw = Math.hypot(p312.x - p317.x, p312.y - p317.y) / dEye;

  // 以三柱原始中位數作為跨柱異常值檢測基準，防止單柱被手部/鼻導管遮擋暴衝時污染其他柱
  const rawSorted = [hLRaw, hMRaw, hRRaw].sort((a, b) => a - b);
  const medianRaw = rawSorted[1];
  const prevCols = (AppState.ema && AppState.ema.lastColHeights) || { L: medianRaw, M: medianRaw, R: medianRaw };

  const validHeights = [];
  const colMap = {};

  for (const c of cols) {
    const up = c.up;
    const low = c.low;
    if (!up || !low) continue;

    // Layer 1: API 置信度兼容層 (僅當 visibility 或 presence 存在且非預設 0 時啟用過濾)
    const hasVisField = (typeof up.visibility === 'number' && up.visibility > 0) ||
                        (typeof low.visibility === 'number' && low.visibility > 0);
    const visOk = !hasVisField || (Math.min(up.visibility ?? 1, low.visibility ?? 1) >= 0.50);

    const hasPresField = (typeof up.presence === 'number' && up.presence > 0) ||
                         (typeof low.presence === 'number' && low.presence > 0);
    const presOk = !hasPresField || (Math.min(up.presence ?? 1, low.presence ?? 1) >= 0.50);

    const notExplicitlyOccluded = !(up.occluded === true || low.occluded === true);

    // Layer 2: 畫面邊界、上下唇拓撲防反轉、側臉 Yaw 自遮擋與跨柱異常值剔除
    const inBounds = (
      up.x >= 0.02 && up.x <= 0.98 &&
      up.y >= 0.02 && up.y <= 0.98 &&
      low.x >= 0.02 && low.x <= 0.98 &&
      low.y >= 0.02 && low.y <= 0.98
    );
    const topologyOk = (low.y - up.y) >= (-0.008 * dEye);
    const hVal = Math.hypot(up.x - low.x, up.y - low.y) / dEye;

    // 跨柱一致性檢查：若某柱偏離三柱中位數超過 max(2.4 * medianRaw, 0.075)，視為局部遮擋異常值剔除
    const outlierLimit = Math.max(2.4 * medianRaw, 0.075);
    const outlierOk = Math.abs(hVal - medianRaw) <= outlierLimit;

    // 單幀異常跳變檢查：若單柱在單幀內暴衝 > 0.20 而中位數保持穩定，剔除該異常柱
    const prevColVal = typeof prevCols[c.id] === 'number' ? prevCols[c.id] : medianRaw;
    const singleColSpike = (Math.abs(hVal - prevColVal) > 0.20) && (Math.abs(hVal - medianRaw) > 0.06);

    if (visOk && presOk && notExplicitlyOccluded && inBounds && topologyOk && !c.yawBlocked && outlierOk && !singleColSpike) {
      validHeights.push(hVal);
      colMap[c.id] = hVal;
    }
  }

  // 更新上一幀各柱有效高度紀錄
  if (AppState.ema && AppState.ema.lastColHeights) {
    if (colMap.L !== undefined) AppState.ema.lastColHeights.L = colMap.L;
    if (colMap.M !== undefined) AppState.ema.lastColHeights.M = colMap.M;
    if (colMap.R !== undefined) AppState.ema.lastColHeights.R = colMap.R;
  }

  // 3. 三柱穩健聚合與 3 -> 2 -> 1 -> 0 分級降級策略
  const nValid = validHeights.length;
  let hInnerRobust = (AppState.ema && typeof AppState.ema.hInnerPrev === 'number')
    ? AppState.ema.hInnerPrev
    : DEFAULT_CALIB_BASELINES.H_inner_closed;

  if (nValid === 3) {
    const sorted = [...validHeights].sort((a, b) => a - b);
    const medianH = sorted[1];
    const weightedH = 0.25 * colMap.L + 0.50 * colMap.M + 0.25 * colMap.R;
    hInnerRobust = 0.50 * medianH + 0.50 * weightedH;
  } else if (nValid === 2) {
    if (colMap.M !== undefined) {
      const sideVal = colMap.L !== undefined ? colMap.L : colMap.R;
      hInnerRobust = 0.65 * colMap.M + 0.35 * sideVal;
    } else {
      hInnerRobust = 0.50 * (validHeights[0] + validHeights[1]);
    }
  } else if (nValid === 1) {
    hInnerRobust = validHeights[0];
  }
  // nValid === 0 時保持上一幀 hInnerPrev (Hold State)

  // 中柱專屬高度 (若中柱被遮擋剔除，回退使用 hInnerRobust * 1.08 對齊中柱解剖比例)
  const hCenter = colMap.M !== undefined ? colMap.M : (hInnerRobust * 1.08);

  // 4. 外嘴角闊度 W_outer (61-291) 與側臉/單側遮擋半嘴闊補償
  const lipMidX = (p0.x + p17.x) * 0.5;
  const lipMidY = (p0.y + p17.y) * 0.5;
  const leftCornerValid = (p61.x >= 0.02 && p61.x <= 0.98 && !p61.occluded && yawDeg >= -yawSideLimit);
  const rightCornerValid = (p291.x >= 0.02 && p291.x <= 0.98 && !p291.occluded && yawDeg <= yawSideLimit);

  let wOuterRaw;
  if (leftCornerValid && !rightCornerValid) {
    wOuterRaw = 2.0 * Math.hypot(p61.x - lipMidX, p61.y - lipMidY);
  } else if (!leftCornerValid && rightCornerValid) {
    wOuterRaw = 2.0 * Math.hypot(p291.x - lipMidX, p291.y - lipMidY);
  } else {
    wOuterRaw = Math.hypot(p61.x - p291.x, p61.y - p291.y);
  }
  const wOuterNorm = Math.max(wOuterRaw / dEye, 0.10);

  // 5. 外唇垂直高度 (0-17) 與外唇圓潤長寬比 OLAR
  const hOuterNorm = Math.hypot(p0.x - p17.x, p0.y - p17.y) / dEye;
  const olar = hOuterNorm / Math.max(wOuterNorm, 0.10);

  // 6. 選填 Z 軸相對前突量 (嚴格受 |yawDeg| <= 12° 及 |pitchDeg| <= 10° 姿態門控)
  const yawLimitZ = THRESHOLDS.yawMaxForZDeg || 12.0;
  const pitchLimitZ = THRESHOLDS.pitchMaxForZDeg || 10.0;
  const poseValidForZ = (Math.abs(yawDeg) <= yawLimitZ && Math.abs(pitchDeg) <= pitchLimitZ && nValid >= 2);
  let zProtrusion = 0;
  if (poseValidForZ) {
    const zCenter = ((p0.z || 0) + (p13.z || 0) + (p14.z || 0) + (p17.z || 0)) * 0.25;
    const zCorners = ((p61.z || 0) + (p291.z || 0)) * 0.5;
    zProtrusion = zCorners - zCenter;
  }

  return {
    isSimulated,
    dEye,
    yawDeg,
    pitchDeg,
    pitchRatio,
    hInnerRobust,
    hCenter,
    wOuterNorm,
    olar,
    zProtrusion,
    poseValidForZ,
    validCols: nValid,
    colMap
  };
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
 * 對 MediaPipe Pose 提取的雙肩座標（Landmark 11 左肩, 12 右肩）套用指數移動平均濾波
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
 * 【v10 雙軌個人化比例尺 (NOI / NOI_center)、MWR、OLAR 與遮擋恢復漸進平滑濾波】
 * - 支援傳入 v10Geo 物件進行完整 16+4 點濾波，亦完全兼容舊式 4 參數呼叫。
 * - 當有效唇柱由 <= 1 恢復至 >= 2 時，啟動 6 幀 (300ms) 漸進平滑 Ramp 與 4 幀 (200ms) 動量豁免暫停保護。
 */
export function smoothFacialSignalsEMA(rawLar, rawJawOpen, rawMouthPucker, rawMouthFunnel = 0, v10Geo = null, dt = 0.05) {
  const baseAlphaLar = THRESHOLDS.emaLarAlpha || 0.25;
  const baseAlphaJaw = THRESHOLDS.emaJawAlpha || 0.25;
  const baseAlphaPucker = THRESHOLDS.emaPuckerAlpha || 0.30;
  const cal = AppState.calibration || DEFAULT_CALIB_BASELINES;

  const validCols = v10Geo && typeof v10Geo.validCols === 'number' ? v10Geo.validCols : 3;

  // 檢測是否剛從遮擋狀態 (validCols <= 1) 恢復至正常狀態 (validCols >= 2)
  if (AppState.ema.faceInitialized && AppState.ema.prevValidCols <= 1 && validCols >= 2) {
    AppState.ema.occlusionRecoveryTicks = OCCLUSION_RECOVERY_TICKS;
    AppState.ema.momentumPauseTicks = MOMENTUM_RECOVERY_PAUSE_TICKS;
  }
  AppState.ema.prevValidCols = validCols;

  if (validCols === 0) {
    AppState.ema.occlusionHoldSec = (AppState.ema.occlusionHoldSec || 0) + dt;
  } else {
    AppState.ema.occlusionHoldSec = 0;
  }

  // 計算有效 EMA Alpha（單柱降級時降低 Alpha 至 0.15 抑噪；遮擋恢復期間按 1/7..6/7 漸進放開）
  let rampFactor = 1.0;
  if (AppState.ema.occlusionRecoveryTicks > 0) {
    const step = OCCLUSION_RECOVERY_TICKS - AppState.ema.occlusionRecoveryTicks + 1;
    rampFactor = step / (OCCLUSION_RECOVERY_TICKS + 1);
    AppState.ema.occlusionRecoveryTicks--;
  }
  if (AppState.ema.momentumPauseTicks > 0) {
    AppState.ema.momentumPauseTicks--;
  }

  const colScale = validCols === 1 ? 0.60 : (validCols === 0 ? 0.0 : 1.0);
  const alphaGeom = baseAlphaLar * rampFactor * colScale;
  const alphaJaw = baseAlphaJaw * rampFactor * (validCols === 0 ? 0.0 : 1.0);
  const alphaPucker = baseAlphaPucker * rampFactor * (validCols === 0 ? 0.0 : 1.0);

  // 提取或推算原始幾何值
  const rawHInner = v10Geo ? v10Geo.hInnerRobust : (rawLar * (cal.W_outer_closed || 0.46));
  const rawHCenter = v10Geo ? v10Geo.hCenter : (rawHInner * 1.08);
  const rawWOuter = v10Geo ? v10Geo.wOuterNorm : (cal.W_outer_closed || 0.46);
  const rawOlar = v10Geo ? v10Geo.olar : Math.max(0.20, (rawHInner + 0.09) / Math.max(rawWOuter, 0.15));

  if (!AppState.ema.faceInitialized) {
    AppState.ema.larPrev = rawLar;
    AppState.ema.jawOpenPrev = rawJawOpen;
    AppState.ema.mouthPuckerPrev = rawMouthPucker;
    AppState.ema.mouthFunnelPrev = rawMouthFunnel;
    AppState.ema.hInnerPrev = rawHInner;
    AppState.ema.hCenterPrev = rawHCenter;
    AppState.ema.wOuterPrev = rawWOuter;
    AppState.ema.olarPrev = rawOlar;
    AppState.ema.deltaLar = 0;
    AppState.ema.deltaJawOpen = 0;
    AppState.ema.deltaMouthPucker = 0;
    AppState.ema.deltaMouthFunnel = 0;
    AppState.ema.deltaNoi = 0;
    AppState.ema.deltaMwr = 0;
    AppState.ema.faceInitialized = true;
  } else if (validCols > 0) {
    const prevLar = AppState.ema.larPrev;
    const prevJaw = AppState.ema.jawOpenPrev;
    const prevPucker = AppState.ema.mouthPuckerPrev;
    const prevFunnel = AppState.ema.mouthFunnelPrev;

    const larFiltered = ema(rawLar, prevLar, alphaGeom);
    const jawOpenFiltered = ema(rawJawOpen, prevJaw, alphaJaw);
    const mouthPuckerFiltered = ema(rawMouthPucker, prevPucker, alphaPucker);
    const mouthFunnelFiltered = ema(rawMouthFunnel, prevFunnel, alphaPucker);

    const hInnerFiltered = ema(rawHInner, AppState.ema.hInnerPrev, alphaGeom);
    const hCenterFiltered = ema(rawHCenter, AppState.ema.hCenterPrev, alphaGeom);
    const wOuterFiltered = ema(rawWOuter, AppState.ema.wOuterPrev, alphaGeom);
    const olarFiltered = ema(rawOlar, AppState.ema.olarPrev, alphaGeom);

    AppState.ema.deltaLar = larFiltered - prevLar;
    AppState.ema.deltaJawOpen = jawOpenFiltered - prevJaw;
    AppState.ema.deltaMouthPucker = mouthPuckerFiltered - prevPucker;
    AppState.ema.deltaMouthFunnel = mouthFunnelFiltered - prevFunnel;

    AppState.ema.larPrev = larFiltered;
    AppState.ema.jawOpenPrev = jawOpenFiltered;
    AppState.ema.mouthPuckerPrev = mouthPuckerFiltered;
    AppState.ema.mouthFunnelPrev = mouthFunnelFiltered;
    AppState.ema.hInnerPrev = hInnerFiltered;
    AppState.ema.hCenterPrev = hCenterFiltered;
    AppState.ema.wOuterPrev = wOuterFiltered;
    AppState.ema.olarPrev = olarFiltered;
  } else {
    // validCols === 0 (Hold State): 凍結斜率為 0
    AppState.ema.deltaLar = 0;
    AppState.ema.deltaJawOpen = 0;
    AppState.ema.deltaMouthPucker = 0;
    AppState.ema.deltaMouthFunnel = 0;
  }

  // 計算雙軌個人化開合指數：
  // 1) NOI (基於三柱穩健基準 H_inner_closed & H_inner_open，供吸氣階段閉口判定)
  const hInClosed = cal.H_inner_closed ?? DEFAULT_CALIB_BASELINES.H_inner_closed;
  const hInOpen = Math.max(cal.H_inner_open ?? DEFAULT_CALIB_BASELINES.H_inner_open, hInClosed + 0.08);
  const noiFiltered = clampVal((AppState.ema.hInnerPrev - hInClosed) / (hInOpen - hInClosed), 0.0, 1.5);

  // 2) NOI_center (基於中柱 13-14 專屬基準 H_center_closed & H_center_open，供呼氣中央氣孔守門員判定)
  const hCenClosed = cal.H_center_closed ?? DEFAULT_CALIB_BASELINES.H_center_closed;
  const hCenOpen = Math.max(cal.H_center_open ?? DEFAULT_CALIB_BASELINES.H_center_open, hCenClosed + 0.08);
  const noiCenterFiltered = (v10Geo && v10Geo.colMap && v10Geo.colMap.M === undefined)
    ? noiFiltered // 若中柱被遮擋，自動回退使用三柱穩健 NOI
    : clampVal((AppState.ema.hCenterPrev - hCenClosed) / (hCenOpen - hCenClosed), 0.0, 1.5);

  // 3) 外嘴角收窄比 MWR 與外唇圓潤提升比 OLAR_ratio
  const wOuterClosed = Math.max(cal.W_outer_closed ?? DEFAULT_CALIB_BASELINES.W_outer_closed, 0.15);
  const mwrFiltered = clampVal(AppState.ema.wOuterPrev / wOuterClosed, 0.45, 1.35);

  const olarClosed = Math.max(cal.OLAR_closed ?? DEFAULT_CALIB_BASELINES.OLAR_closed, 0.10);
  const olarRatioFiltered = clampVal(AppState.ema.olarPrev / olarClosed, 0.50, 2.50);

  AppState.ema.deltaNoi = validCols > 0 ? (noiFiltered - (AppState.ema.noiPrev ?? noiFiltered)) : 0;
  AppState.ema.deltaMwr = validCols > 0 ? (mwrFiltered - (AppState.ema.mwrPrev ?? mwrFiltered)) : 0;
  AppState.ema.noiPrev = noiFiltered;
  AppState.ema.noiCenterPrev = noiCenterFiltered;
  AppState.ema.mwrPrev = mwrFiltered;
  AppState.ema.olarRatioPrev = olarRatioFiltered;

  return {
    larFiltered: AppState.ema.larPrev,
    jawOpenFiltered: AppState.ema.jawOpenPrev,
    mouthPuckerFiltered: AppState.ema.mouthPuckerPrev,
    mouthFunnelFiltered: AppState.ema.mouthFunnelPrev,
    hInnerFiltered: AppState.ema.hInnerPrev,
    hCenterFiltered: AppState.ema.hCenterPrev,
    wOuterFiltered: AppState.ema.wOuterPrev,
    olarFiltered: AppState.ema.olarPrev,
    noiFiltered,
    noiCenterFiltered,
    mwrFiltered,
    olarRatioFiltered,
    deltaLar: AppState.ema.deltaLar,
    deltaJawOpen: AppState.ema.deltaJawOpen,
    deltaMouthPucker: AppState.ema.deltaMouthPucker,
    deltaMouthFunnel: AppState.ema.deltaMouthFunnel,
    deltaNoi: AppState.ema.deltaNoi,
    deltaMwr: AppState.ema.deltaMwr,
    hasValidMouth: AppState.ema.occlusionHoldSec <= OCCLUSION_HOLD_MAX_SEC
  };
}

/**
 * 【v10 連續模糊評分 — 吸氣階段 (getInhaleScore: 0.0 至 1.0)】
 * - 採用個人化開合比例尺 NOI：0% 至 22% (noiInhalePassMax = 0.22) 一律 1.0 滿分合格（容許自然輕合或 1-2mm 放鬆微縫，無須用力死抿）。
 * - 22% 至 38% (noiInhaleZeroMax = 0.38) 平滑線性衰減（27% 對應 0.70 合格線）。
 * - 下巴微鬆協同保護：當唇部已自然閉攏 (NOI <= 0.22) 時，放寬 jawOpen 門檻至 1.8 倍 (預設 0.09)，防止口腔內放鬆牙骹被誤殺。
 */
export function getInhaleScore(larFiltered, jawOpenFiltered, v10Metrics = null) {
  const cal = AppState.calibration || DEFAULT_CALIB_BASELINES;
  const noiPassMax = THRESHOLDS.noiInhalePassMax ?? 0.22;
  const noiZeroMax = Math.max(THRESHOLDS.noiInhaleZeroMax ?? 0.38, noiPassMax + 0.08);

  // 優先使用明確傳入之 v10Metrics.noi；若為二參數呼叫，將 larFiltered 映射至個人化 [LAR_closed, LAR_open] 比例尺
  let noiVal;
  if (v10Metrics && typeof v10Metrics.noi === 'number') {
    noiVal = v10Metrics.noi;
  } else {
    const larClosed = cal.LAR_closed ?? DEFAULT_CALIB_BASELINES.LAR_closed;
    const larOpen = Math.max(cal.LAR_open ?? DEFAULT_CALIB_BASELINES.LAR_open, larClosed + 0.15);
    // 同步兼容 Debug Drawer 對 THRESHOLDS.larInhaleMax 之手動微調
    const dynamicShift = (THRESHOLDS.larInhaleMax ?? 0.06) - 0.06;
    noiVal = clampVal((larFiltered - dynamicShift - larClosed) / (larOpen - larClosed), 0.0, 1.5);
  }

  let lipScore = 1.0;
  if (noiVal <= noiPassMax) {
    lipScore = 1.0;
  } else if (noiVal >= noiZeroMax) {
    lipScore = 0.0;
  } else {
    lipScore = clampVal(1.0 - (noiVal - noiPassMax) / (noiZeroMax - noiPassMax), 0.0, 1.0);
  }

  // 下巴微鬆協同判定：若唇部已處於自然閉攏區 (noiVal <= noiPassMax)，放寬 jawOpen 上限避免連坐誤殺
  const baseJawMax = THRESHOLDS.jawOpenInhaleMax ?? 0.05;
  const effectiveJawMax = (noiVal <= noiPassMax)
    ? Math.max(baseJawMax * 1.8, 0.09)
    : baseJawMax;
  const jawDecaySpan = (noiVal <= noiPassMax)
    ? Math.max(effectiveJawMax * 0.65, 0.04)
    : Math.max(effectiveJawMax * 0.45, 0.02);

  const jawScore = clampVal(
    1.0 - Math.max(0, jawOpenFiltered - effectiveJawMax) / jawDecaySpan,
    0.0,
    1.0
  );

  return Math.min(lipScore, jawScore);
}

/**
 * 【v10 連續模糊評分 — 呼氣階段 (getExhaleScore: 0.0 至 1.0)】
 * 採用「85% 純 2D 幾何主導 + 15% Blendshape 輔助 + 衝突解算與遲滯保護」：
 * - 條件一 (50% 權重)：純幾何外嘴角收窄比 MWR (mwr <= mwrExhaleTarget (0.88) 滿分；吹氣中啟用遲滯門檻 mwrExhaleHold (0.91)；>= 0.97 得 0 分)。
 * - 條件二 (35% 權重)：中柱專屬中央氣孔守門員 G_aperture (noiCenter 2.5%–42%) × 外唇圓潤比提升度 OLAR_ratio (>= 1.18 滿分)。
 * - 條件三 (15% 權重)：Blendshape (mouthPucker / mouthFunnel) + 姿態門控 Z 軸微調，受幾何衝突解算器嚴格約束。
 */
export function getExhaleScore(larFiltered, mouthPuckerFiltered, mouthFunnelFiltered = 0, v10Metrics = null) {
  // 硬性張大口錯誤攔截
  if (typeof larFiltered === 'number' && larFiltered > THRESHOLDS.larExhaleWideErr) {
    return 0.0;
  }

  const puckerMin = Math.max(THRESHOLDS.mouthPuckerMin, 0.01);
  const funnelMin = Math.max(THRESHOLDS.mouthFunnelMin, 0.01);
  const puckerRatio = mouthPuckerFiltered / puckerMin;
  const funnelRatio = mouthFunnelFiltered / funnelMin;
  const effectiveBsRatio = Math.max(puckerRatio, funnelRatio);

  // 若未傳入 v10Metrics (純舊式三參數呼叫)，但至少檢查 larExhaleMin 防止完全死抿 (larFiltered < 0.028) 誤判滿分
  if (!v10Metrics || typeof v10Metrics.mwr !== 'number') {
    if (typeof larFiltered === 'number' && larFiltered < (THRESHOLDS.larExhaleClosedErr || 0.028)) {
      return clampVal(effectiveBsRatio * 0.50, 0.0, 0.55);
    }
    if (effectiveBsRatio >= 1.0) return 1.0;
    if (effectiveBsRatio >= 0.65) {
      return clampVal(0.70 + ((effectiveBsRatio - 0.65) / 0.35) * 0.25, 0.70, 0.95);
    }
    return 0.0;
  }

  const mwr = v10Metrics.mwr;
  const noiCenter = typeof v10Metrics.noiCenter === 'number' ? v10Metrics.noiCenter : (v10Metrics.noi ?? 0.12);
  const olarRatio = typeof v10Metrics.olarRatio === 'number' ? v10Metrics.olarRatio : 1.20;
  const isBlowing = Boolean(v10Metrics.isCurrentlyBlowing || (AppState.training && AppState.training.isInteractiveBlowing));

  // 中柱張大口硬性攔截
  const noiWideErr = THRESHOLDS.noiExhaleWideErr ?? 0.55;
  if (noiCenter > noiWideErr) {
    return 0.0;
  }

  // 1. 條件一 (50% 權重)：純幾何外嘴角收窄比 MWR (零 Blendshape 否決權)
  const targetMwr = isBlowing
    ? (THRESHOLDS.mwrExhaleHold ?? 0.91)
    : (THRESHOLDS.mwrExhaleTarget ?? 0.88);
  const maxMwr = Math.max(THRESHOLDS.mwrExhaleMax ?? 0.97, targetMwr + 0.03);

  let sMwr = 0.0;
  if (mwr <= targetMwr) {
    sMwr = 1.0;
  } else if (mwr < maxMwr) {
    sMwr = clampVal((maxMwr - mwr) / (maxMwr - targetMwr), 0.0, 1.0);
  } else {
    sMwr = 0.0;
  }

  // 2. 條件二 (35% 權重)：中柱專屬氣孔守門員 G_aperture 與外唇圓潤提升比 OLAR_ratio
  const noiMin = THRESHOLDS.noiExhaleMin ?? 0.025;
  const noiMax = THRESHOLDS.noiExhaleMax ?? 0.42;

  let gAperture = 1.0;
  const isTightLipSeal = (noiCenter < noiMin) && (typeof larFiltered === 'number' ? larFiltered < 0.032 : true);
  if (isTightLipSeal) {
    // TC-02B：呼氣時完全死抿密封無氣孔，守門員壓低分數
    gAperture = 0.20;
  } else if (noiCenter <= noiMax) {
    gAperture = 1.0;
  } else {
    gAperture = clampVal(1.0 - (noiCenter - noiMax) / Math.max(noiWideErr - noiMax, 0.05), 0.0, 1.0);
  }

  const olarTarget = Math.max(THRESHOLDS.olarRatioTarget ?? 1.18, 1.08);
  const sRound = clampVal((olarRatio - 1.02) / (olarTarget - 1.02), 0.0, 1.0);
  let sShape = gAperture * (0.65 * sRound + 0.35 * gAperture);

  // 3. 條件三 (15% 權重)：Blendshape 輔助分 + 嚴格姿態門控 Z 軸微調
  let sBs = clampVal(effectiveBsRatio, 0.0, 1.0);
  let zBonus = 0.0;
  if (v10Metrics.poseValidForZ) {
    const zBase = (AppState.calibration && AppState.calibration.zProtrusion_closed) || DEFAULT_CALIB_BASELINES.zProtrusion_closed;
    if ((v10Metrics.zProtrusion - zBase) >= 0.005) {
      zBonus = 0.15;
    }
  }
  let sAux = clampVal(sBs + zBonus, 0.0, 1.0);

  // 4. 幾何 MWR 與 Blendshape 衝突處理邏輯
  if (sMwr >= 0.75 && gAperture >= 0.80 && sShape >= 0.65) {
    // 情境 A：2D 幾何明確證實嘴角收窄且具圓潤氣孔，即使 Blendshape 為 0 亦給予保底輔助分
    sAux = Math.max(sAux, 0.65 * Math.min(sMwr, sShape));
  } else if (sMwr < 0.25) {
    // 情境 B (TC-07)：外嘴角完全無收窄 (如張口講 Oh/Ah)，強制壓制 Blendshape 與圓潤分，杜絕假陽性
    sAux = sAux * sMwr;
    sShape = sShape * Math.max(sMwr, 0.30);
  }

  let totalScore = 0.50 * sMwr + 0.35 * sShape + 0.15 * sAux;

  // 若呼氣完全死抿無氣孔 (TC-02B)，總分上限鎖定為 0.55 (< 0.70 合格線)
  if (isTightLipSeal) {
    totalScore = Math.min(totalScore, 0.55);
  }

  return clampVal(totalScore, 0.0, 1.0);
}

/**
 * 【v10 抗抖動動作動量豁免機制 (Noise-Resistant Action-Momentum Exemption)】
 * - 當遮擋剛恢復 (AppState.ema.momentumPauseTicks > 0) 時暫停動量豁免 200ms，防止遮擋移開瞬間因斜率跳變而誤豁免。
 * - 同時支援傳統 deltaLar / deltaMouthPucker 及 v10 之 deltaNoi (主動合口) / deltaMwr (主動收窄嘴角)。
 */
export function applyActionMomentumExemption(phase, baseScore, deltaLar, deltaMouthPucker, v10Deltas = null) {
  if (baseScore >= 1.0) return 1.0;
  if (baseScore < MOMENTUM_MIN_BASE_SCORE) {
    return clampVal(baseScore, 0, 1);
  }
  if (AppState.ema && AppState.ema.momentumPauseTicks > 0) {
    return clampVal(baseScore, 0, 1);
  }

  const dNoi = v10Deltas && typeof v10Deltas.deltaNoi === 'number' ? v10Deltas.deltaNoi : 0;
  const dMwr = v10Deltas && typeof v10Deltas.deltaMwr === 'number' ? v10Deltas.deltaMwr : 0;

  if (phase === PHASES.INHALE && (deltaLar < MOMENTUM_DELTA_LAR_THRESHOLD || dNoi < MOMENTUM_DELTA_NOI_THRESHOLD)) {
    return Math.max(baseScore, 0.85);
  }
  if (phase === PHASES.EXHALE && (deltaMouthPucker > MOMENTUM_DELTA_PUCKER_THRESHOLD || dMwr < MOMENTUM_DELTA_MWR_THRESHOLD)) {
    return Math.max(baseScore, 0.85);
  }
  return clampVal(baseScore, 0, 1);
}

/**
 * 向後兼容之布林輔助判定（連續模糊分數 >= 0.70 視為合格）
 */
export function isNasalInhaleValid(lar, jawOpen, v10Metrics = null) {
  return getInhaleScore(lar, jawOpen, v10Metrics) >= 0.70;
}

export function isPlbExhaleValid(lar, mouthPucker, mouthFunnel = 0, v10Metrics = null) {
  return getExhaleScore(lar, mouthPucker, mouthFunnel, v10Metrics) >= 0.70;
}

/**
 * 生成模擬生物特徵點 (供免鏡頭模擬模式 Demo Mode 使用，具備明確 isSimulated = true Flag 並完整生成 16+4 點座標)
 */
export function generateSimulatedDetections(now) {
  const wave = Math.sin(now / 350);
  let lar = 0.035;
  let pucker = 0.08;
  let funnel = 0.06;
  let jawOpen = 0.015;
  let shoulderY = 0.72;
  let innerWidthHalf = 0.049;
  let outerWidthHalf = 0.0506; // D_eye = 0.22 -> W_outer_norm = 0.1012 / 0.22 = 0.460
  let outerHeightHalf = 0.0127; // OLAR_closed = 0.0254 / 0.1012 = 0.251
  let zCenterOffset = -0.003;

  if (AppState.currentState === STATES.CALIBRATING) {
    const step = AppState.calibration.currentStep;
    if (step === 1) {
      // 第 1 步【閉嘴】
      lar = 0.034 + Math.abs(wave) * 0.004;
      jawOpen = 0.014 + Math.abs(wave) * 0.003;
      pucker = 0.08;
      funnel = 0.06;
      outerWidthHalf = 0.0506;
      outerHeightHalf = 0.0127;
      shoulderY = 0.72;
    } else if (step === 2) {
      // 第 2 步【張大口】
      lar = 0.36 + wave * 0.015;
      jawOpen = 0.42 + wave * 0.02;
      pucker = 0.05;
      funnel = 0.12;
      outerWidthHalf = 0.0515;
      outerHeightHalf = 0.0285;
      shoulderY = 0.72;
    } else if (step === 3) {
      // 第 3 步【噘唇】：外嘴角明顯向內收窄 (MWR ≈ 0.83) 且外唇變圓潤 (OLAR ≈ 0.35)
      lar = 0.12 + wave * 0.01;
      jawOpen = 0.06;
      pucker = 0.54 + wave * 0.03;
      funnel = 0.46 + wave * 0.03;
      innerWidthHalf = 0.038;
      outerWidthHalf = 0.0420; // W_outer_plb = 0.084 / 0.22 = 0.382 (MWR_plb = 0.83)
      outerHeightHalf = 0.0146; // OLAR_plb = 0.0292 / 0.084 = 0.348 (OLAR_ratio = 1.38)
      zCenterOffset = -0.012;
      shoulderY = 0.72;
    } else if (step === 4) {
      // 第 4 步【縮膊頭】
      lar = 0.036;
      jawOpen = 0.015;
      shoulderY = 0.658 + wave * 0.003;
    } else {
      // 第 5 步【放鬆膊頭】
      lar = 0.035;
      jawOpen = 0.015;
      shoulderY = 0.72 + wave * 0.002;
    }
  } else {
    const train = AppState.training;
    const isExhale = train.currentPhase === PHASES.EXHALE;
    lar = isExhale ? (0.11 + wave * 0.015) : (0.035 + Math.abs(wave) * 0.006);
    pucker = isExhale ? (0.56 + wave * 0.05) : 0.08;
    funnel = isExhale ? (0.46 + wave * 0.04) : 0.06;
    jawOpen = isExhale ? 0.06 : 0.018;
    innerWidthHalf = isExhale ? 0.039 : 0.049;
    outerWidthHalf = isExhale ? (0.0418 + wave * 0.0008) : 0.0506; // 呼氣 MWR ≈ 0.826 (<= 0.88 滿分)
    outerHeightHalf = isExhale ? 0.0145 : 0.0127;
    zCenterOffset = isExhale ? -0.012 : -0.003;
    shoulderY = 0.72 + (isExhale ? 0.002 : -0.002);
  }

  const lipWidthTotal = innerWidthHalf * 2;
  const centerHeightHalf = (lar * lipWidthTotal) / 2;
  const sideHeightHalf = centerHeightHalf * 0.86;

  const face = [];
  for (let i = 0; i < 478; i++) {
    face.push({ x: 0.5, y: 0.42, z: 0 });
  }
  // 標記此陣列來自模擬器 (Comment 2: 明確 Flag，不靠硬編碼座標猜測)
  face.isSimulated = true;

  // 1. 雙眼與剛性頭部姿態錨點 (D_eye = 0.220)
  face[33] = { x: 0.39, y: 0.36, z: 0.0 };
  face[263] = { x: 0.61, y: 0.36, z: 0.0 };
  face[10] = { x: 0.50, y: 0.23, z: 0.01 };
  face[4] = { x: 0.50, y: 0.42, z: -0.03 };
  face[2] = { x: 0.50, y: 0.45, z: -0.015 };
  face[152] = { x: 0.50, y: 0.57 + jawOpen * 0.04, z: 0.01 };
  face[234] = { x: 0.37, y: 0.41, z: 0.04 };
  face[454] = { x: 0.63, y: 0.41, z: 0.04 };
  face[97] = { x: 0.47, y: 0.445, z: -0.01 };
  face[326] = { x: 0.53, y: 0.445, z: -0.01 };

  // 2. 外唇環 4 點 (左外嘴角 61、右外嘴角 291、上外唇正中 0、下外唇正中 17)
  face[61] = { x: 0.50 - outerWidthHalf, y: 0.49, z: 0.002 };
  face[291] = { x: 0.50 + outerWidthHalf, y: 0.49, z: 0.002 };
  face[0] = { x: 0.50, y: 0.49 - outerHeightHalf, z: zCenterOffset };
  face[17] = { x: 0.50, y: 0.49 + outerHeightHalf, z: zCenterOffset };

  // 3. 內唇環 8 點 (內嘴角 78, 308 及左 82-87、中 13-14、右 312-317 三柱)
  face[78] = { x: 0.50 - innerWidthHalf, y: 0.49, z: 0.001 };
  face[308] = { x: 0.50 + innerWidthHalf, y: 0.49, z: 0.001 };
  face[13] = { x: 0.50, y: 0.49 - centerHeightHalf, z: zCenterOffset };
  face[14] = { x: 0.50, y: 0.49 + centerHeightHalf, z: zCenterOffset };
  face[82] = { x: 0.50 - innerWidthHalf * 0.45, y: 0.49 - sideHeightHalf, z: zCenterOffset * 0.8 };
  face[87] = { x: 0.50 - innerWidthHalf * 0.45, y: 0.49 + sideHeightHalf, z: zCenterOffset * 0.8 };
  face[312] = { x: 0.50 + innerWidthHalf * 0.45, y: 0.49 - sideHeightHalf, z: zCenterOffset * 0.8 };
  face[317] = { x: 0.50 + innerWidthHalf * 0.45, y: 0.49 + sideHeightHalf, z: zCenterOffset * 0.8 };

  const ovalIndices = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
  ovalIndices.forEach((idx, k) => {
    const angle = (k / ovalIndices.length) * Math.PI * 2 - Math.PI / 2;
    face[idx] = {
      x: 0.50 + Math.cos(angle) * 0.13,
      y: 0.40 + Math.sin(angle) * 0.17,
      z: 0.02
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
    isSimulated: true,
    faceResult: {
      isSimulated: true,
      simSchemaVersion: 'v10',
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
      isSimulated: true,
      landmarks: [pose]
    }
  };
}
