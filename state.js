/**
 * 舒呼(SootheBreath) 呼吸復康訓練 — 實時呼吸視覺生物反饋系統 (PWA v10.1)
 * ESM Core Engine: MediaPipe Tasks Vision 0.10.14 + Three.js 3D Interactive Mode (60 FPS Optimized)
 *
 * v10.1 核心升級重點：
 * - 完整保留 v10 16+4 點純 2D 幾何主導唇環演算法、三柱穩健質量過濾、雙軌個人化比例尺 (NOI / NOI_center) 與 P0–P2 60 FPS 渲染管線。
 * - 新增臨床訓練完成後自動儲存個人化校準設定 (LAST_CALIB_STORAGE_KEY) 與主頁「繼續使用上次校準設定」免重校準快速啟動狀態管理。
 * - 將「互動模式 (interactive)」完全整合為「呼吸引導顯示模式 (displayMode)」子模式，與「相機顯示模式 (privacyMode: mirror / privacy_mesh / minimalist)」獨立解耦，支援於實時鏡像或骨架網格模式下同時顯示左側視訊/網格面板與右側 3D 互動模式。
 */

// ============================================================================
// 1. 系統常數與狀態定義 (System Constants & States)
// ============================================================================
export const STATES = {
  IDLE: 'STATE_IDLE',
  CALIBRATING: 'STATE_CALIBRATING',
  TRAINING: 'STATE_TRAINING',
  SUMMARY: 'STATE_SUMMARY'
};

export const PHASES = {
  INHALE: 'INHALE',
  EXHALE: 'EXHALE'
};

export const LAST_CALIB_STORAGE_KEY = 'soothebreath_saved_calib_v10_1';

// 預設臨床推薦閾值 (Default Clinical Thresholds — 用於初始化與「恢復預設推薦閾值」)
export const DEFAULT_THRESHOLDS = {
  larInhaleMax: 0.06,          // 向後兼容：吸氣閉口鼻吸 LAR 上限
  jawOpenInhaleMax: 0.05,      // 吸氣雙重聯合判定：下頜微張上限 (jawOpen < 0.05，當 NOI <= 0.20 時自動豁免放寬至 1.8 倍)
  larInhaleErr: 0.08,          // 吸氣張口明顯錯誤閾值
  larExhaleMin: 0.04,          // 呼氣噘唇 LAR 下限 (0.04 <= LAR <= 0.24)
  larExhaleMax: 0.24,          // 呼氣噘唇 LAR 上限
  larExhaleWideErr: 0.26,      // 呼氣張大口錯誤閾值
  larExhaleClosedErr: 0.03,    // 呼氣完全閉口錯誤閾值
  mouthPuckerMin: 0.36,        // 呼氣噘唇 mouthPucker 輔助參考閾值 (預設 0.52 * 70% = 0.36)
  mouthFunnelMin: 0.35,        // 呼氣漏斗狀 mouthFunnel 輔助參考閾值 (>= 0.35)
  puckerWideErrMax: 0.30,
  puckerClosedErrMax: 0.25,    // 呼氣自然放鬆唇形閾值 (mouthPucker < 0.25)
  shoulderHikeWarn: 0.12,      // 耳肩相對間距縮短聳肩代償警示 (Delta_Y_relative > 0.12)
  shoulderHikeNormal: 0.10,    // 正常沉肩範圍 (Delta_Y_relative <= 0.10)
  shoulderTiltMax: 0.15,       // 雙肩左右傾斜度上限
  earlyExhaleRatio: 0.70,      // 呼氣階段 70% 動態完成柔性過渡門檻 (phaseElapsed >= T_exhale_target * 0.70)
  emaAlpha: 0.35,              // 雙肩座標 EMA 指數移動平均平滑係數 (alpha = 0.35)
  emaLarAlpha: 0.25,           // 嘴唇幾何指標 EMA 平滑係數 (alpha = 0.25)
  emaJawAlpha: 0.25,           // 下頜張開度 jawOpen EMA 平滑係數 (alpha = 0.25)
  emaPuckerAlpha: 0.30,        // 噘唇度 mouthPucker EMA 平滑係數 (alpha = 0.30)
  puckerPeakEffortDiscount: 0.70, // 校準峰值努力折扣係數 (70% of calibrated peak contraction)

  // v10 新增：16+4 點純 2D 幾何主導演算法與遲滯防抖統一閾值
  noiInhalePassMax: 0.22,      // 吸氣個人化開合比例尺 NOI 滿分寬容上限 (0%–22% 均視為合格閉口鼻吸，容許 1-2mm 自然放鬆微縫)
  noiInhaleZeroMax: 0.38,      // 吸氣個人化開合比例尺 NOI 零分上限 (22%–38% 平滑線性衰減，27% 對應 0.70 合格線)
  mwrExhaleTarget: 0.88,       // 呼氣外嘴角收窄比 MWR 滿分目標閾值 (預設 0.88，動態校準範圍 [0.82, 0.92])
  mwrExhaleHold: 0.91,         // 呼氣吹風保持遲滯保護門檻 Hysteresis (mwrExhaleTarget + 0.03，範圍 [0.85, 0.94])
  mwrExhaleMax: 0.97,          // 呼氣外嘴角未收窄零分門檻 (MWR >= 0.97 代表完全未縮窄嘴闊，S_mwr = 0)
  olarRatioTarget: 1.18,       // 呼氣外唇圓潤長寬比提升目標 (OLAR_curr / OLAR_closed >= 1.18 滿分，動態範圍 [1.12, 1.35])
  noiExhaleMin: 0.025,         // 呼氣中柱專屬最小氣孔守門員 (NOI_center >= 2.5%，攔截完全閉口死抿無氣孔)
  noiExhaleMax: 0.42,          // 呼氣中柱專屬理想圓孔上限 (NOI_center <= 42%)
  noiExhaleWideErr: 0.55,      // 呼氣中柱張大口硬性錯誤攔截門檻 (NOI_center > 55% 強制 0 分)
  yawMaxForZDeg: 12.0,         // Z 軸輔助微調之偏航角門控上限 (|yawDeg| <= 12°)
  pitchMaxForZDeg: 10.0,       // Z 軸輔助微調之俯仰角門控上限 (|pitchDeg| <= 10°)
  yawSideFilterDeg: 15.0       // 側臉單側內唇柱剔除與外嘴角半闊度補償門檻 (|yawDeg| > 15°)
};

// 全域動態臨床閾值 (由五步個人化基準校準或調試面板動態更新)
export const THRESHOLDS = { ...DEFAULT_THRESHOLDS };

// 五步個人化動態基準校準之臨床預設值 (Fallback Defaults)
export const DEFAULT_CALIB_BASELINES = {
  LAR_closed: 0.035,
  jawOpen_closed: 0.015,
  D_eye: 0.220,
  LAR_open: 0.360,
  jawOpen_open: 0.420,
  LAR_plb: 0.120,
  mouthPucker_plb: 0.520,
  mouthFunnel_plb: 0.450,
  Dist_shrug: 0.240,
  Dist_relax: 0.300,
  Dist_base: 0.300,
  yShoulderBase: 0.720,

  // v10 新增：雙軌內唇高度基準 (三柱穩健 vs 中柱專屬) 與外唇幾何基準
  H_inner_closed: 0.018,       // 第 1 步【閉嘴】三柱穩健內唇高度基準 (供吸氣 NOI 使用)
  H_inner_open: 0.165,         // 第 2 步【張大口】三柱穩健內唇高度基準 (供吸氣 NOI 使用)
  H_center_closed: 0.020,      // 第 1 步【閉嘴】中柱 (13-14) 專屬內唇高度基準 (供呼氣 NOI_center 使用)
  H_center_open: 0.180,        // 第 2 步【張大口】中柱 (13-14) 專屬內唇高度基準 (供呼氣 NOI_center 使用)
  W_outer_closed: 0.460,       // 第 1 步【閉嘴】外嘴角 (61-291) 眼距正規化闊度基準
  W_outer_plb: 0.382,          // 第 3 步【噘唇】外嘴角 (61-291) 眼距正規化闊度基準
  MWR_plb: 0.830,              // 第 3 步【噘唇】個人外嘴角收窄比基準 (W_outer_plb / W_outer_closed)
  OLAR_closed: 0.250,          // 第 1 步【閉嘴】外唇圓潤長寬比基準 (Dist(0,17) / Dist(61,291))
  OLAR_plb: 0.345,             // 第 3 步【噘唇】外唇圓潤長寬比基準
  pitchRatio_closed: 0.750,    // 第 1 步【閉嘴】頭部垂直俯仰比基準
  zProtrusion_closed: 0.012    // 第 1 步【閉嘴】唇中相對嘴角 Z 軸深度差基準
};

// 五步校準步驟定義 (Step 1 to Step 5 — 0-indexed Array 供 calibration.js 讀取)
export const CALIB_STEPS_CONFIG = [
  {
    step: 1,
    key: 'closed',
    shortName: '閉嘴',
    title: '第 1 步【閉嘴】：自然閉上嘴巴',
    instruction: '請指導病人自然坐直、閉上嘴巴，面部正對鏡頭，系統將採集個人閉口基準與雙眼間距。',
    metricsDesc: '採集指標：個人閉口嘴唇比 (LAR_closed)、下頜閉合基準 (jawOpen_closed)、雙眼間距 (D_eye)',
    ttsWait: '第一步，閉嘴。請指導病人自然閉上嘴巴，準備好之後按確定開始採集。',
    ttsStart: '開始採集閉嘴基準，請保持閉上嘴巴三秒',
    focusType: 'mouth_closed'
  },
  {
    step: 2,
    key: 'open',
    shortName: '張大口',
    title: '第 2 步【張大口】：自然張開嘴巴',
    instruction: '請指導病人自然張開嘴巴（無需過度勉強），系統將採集個人最大張口基準。',
    metricsDesc: '採集指標：個人最大張口嘴唇比 (LAR_open)、最大下頜張開度 (jawOpen_open)',
    ttsWait: '第二步，張大口。請指導病人自然張開嘴巴，準備好之後按確定開始採集。',
    ttsStart: '開始採集張大口基準，請保持張開嘴巴三秒',
    focusType: 'mouth_open'
  },
  {
    step: 3,
    key: 'plb',
    shortName: '噘唇',
    title: '第 3 步【噘唇】：做出吹蠟燭 / 吹口哨動作',
    instruction: '請指導病人做出吹蠟燭或吹口哨嘅噘唇動作，系統將採集個人噘唇基準。',
    metricsDesc: '採集指標：個人噘唇長寬比 (LAR_plb)、噘唇收縮度 (mouthPucker_plb)、漏斗唇形度 (mouthFunnel_plb)',
    ttsWait: '第三步，噘唇。請指導病人做出吹蠟燭嘅噘唇動作，準備好之後按確定開始採集。',
    ttsStart: '開始採集噘唇基準，請保持吹蠟燭嘴型三秒',
    focusType: 'mouth_plb'
  },
  {
    step: 4,
    key: 'shrug',
    shortName: '縮膊頭',
    title: '第 4 步【縮膊頭】：雙肩向上縮起（模擬聳肩）',
    instruction: '請指導病人將雙肩向上縮起（模擬吸氣聳肩代償），系統將採集個人聳肩耳肩垂直距離。',
    metricsDesc: '採集指標：聳肩狀態下之耳肩垂直相對距離 (Dist_shrug)',
    ttsWait: '第四步，縮膊頭。請指導病人雙肩向上縮起，準備好之後按確定開始採集。',
    ttsStart: '開始採集縮膊頭基準，請保持雙肩縮起三秒',
    focusType: 'shoulder_shrug'
  },
  {
    step: 5,
    key: 'relax',
    shortName: '放鬆膊頭',
    title: '第 5 步【放鬆膊頭】：雙肩完全下沉放鬆',
    instruction: '請指導病人雙肩完全下沉放鬆、自然坐直，系統將採集沉肩耳肩基準距離及雙肩水平基準線。',
    metricsDesc: '採集指標：沉肩耳肩基準距離 (Dist_relax / Dist_base) 及雙肩水平基準線 (yShoulderBase)',
    ttsWait: '第五步，放鬆膊頭。請指導病人雙肩完全下沉放鬆，準備好之後按確定開始採集。',
    ttsStart: '開始採集放鬆膊頭基準，請保持沉肩放鬆三秒',
    focusType: 'shoulder_relax'
  }
];

// 真人示範模式圖片路徑映射 (男性 / 女性)
export const HUMAN_IMAGES = {
  male: {
    inhale: (typeof window !== 'undefined' && window.__SOOTHE_IMAGES && window.__SOOTHE_IMAGES['1.jpg']) || '1.jpg',
    exhale: (typeof window !== 'undefined' && window.__SOOTHE_IMAGES && window.__SOOTHE_IMAGES['2.jpg']) || '2.jpg'
  },
  female: {
    inhale: (typeof window !== 'undefined' && window.__SOOTHE_IMAGES && window.__SOOTHE_IMAGES['3.jpg']) || '3.jpg',
    exhale: (typeof window !== 'undefined' && window.__SOOTHE_IMAGES && window.__SOOTHE_IMAGES['4.jpg']) || '4.jpg'
  }
};

// 訓練開局緩衝期、門檻、效能節流常數與互動吹風/實時警示常數
export const ROLLING_WINDOW_SECONDS = 20.0;
export const INITIAL_GRACE_SECONDS = 10.0;       // 前 10 秒開局緩衝期
export const PHASE_ENTRY_GRACE_MS = 400;         // 吸呼雙向階段切換前 400ms 生理反應緩衝期
export const PASSING_SCORE_PCT = 80;             // 合格達標門檻 80%
export const CONSECUTIVE_IMPROVE_SECONDS = 10.0;
export const INFERENCE_INTERVAL_MS = 50;         // P0-1: MediaPipe 推論間隔 50ms (20 FPS)
export const UI_THROTTLE_MS = 120;               // P1-2: 卡片與 DOM 更新節流間隔 120ms (~8.3 Hz)
export const EXHALE_BLOW_CONFIRM_SEC = 0.10;     // Fix 2: 呼氣階段連續維持合格噘唇 >= 0.10s 啟動吹風
export const EXHALE_BLOW_CUTOFF_SEC = 0.20;      // Fix 2: 呼氣中途錯誤動作持續 >= 0.20s 立即切斷吹風
export const REALTIME_ERROR_BANNER_SEC = 0.90;   // Fix 3: 單一階段內持續發生錯誤動作 >= 0.90s 即時觸發橫幅提示
export const OCCLUSION_HOLD_MAX_SEC = 0.30;      // v10: 有效唇柱為 0 時最多保留上一幀有效值 0.30s (6 ticks)
export const OCCLUSION_RECOVERY_TICKS = 6;       // v10: 遮擋恢復後 6 幀 (300ms) 漸進 EMA 平滑過渡
export const MOMENTUM_RECOVERY_PAUSE_TICKS = 4;  // v10: 遮擋恢復後首 4 幀 (200ms) 暫停動量豁免防暴衝

// 確保 MediaPipe 視訊時間戳嚴格遞增
let lastVideoTimestamp = 0;
export function getNextTimestamp() {
  const now = Math.floor(performance.now());
  lastVideoTimestamp = Math.max(now, lastVideoTimestamp + 1);
  return lastVideoTimestamp;
}

export function clampVal(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

export function roundTo(val, decimals = 2) {
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

export function ema(rawVal, prevVal, alpha) {
  if (typeof prevVal !== 'number' || Number.isNaN(prevVal)) return rawVal;
  return alpha * rawVal + (1 - alpha) * prevVal;
}

export function computeTrimmedMean(samples, fallbackValue) {
  if (!samples || samples.length === 0) return fallbackValue;
  const valid = samples.filter(v => typeof v === 'number' && !isNaN(v));
  if (valid.length === 0) return fallbackValue;
  const sorted = [...valid].sort((a, b) => a - b);
  if (sorted.length < 5) {
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    return sum / sorted.length;
  }
  const trimCount = Math.floor(sorted.length * 0.2);
  const sliced = sorted.slice(trimCount, sorted.length - trimCount);
  const sum = sliced.reduce((acc, v) => acc + v, 0);
  return sum / sliced.length;
}

// 系統全域狀態
export const AppState = {
  currentState: STATES.IDLE,
  stream: null,
  isDemoMode: false,
  isPaused: false,
  pauseStartTime: 0,
  faceLandmarker: null,
  poseLandmarker: null,
  modelsLoadingPromise: null,
  lastFaceResult: null,
  lastPoseResult: null,
  calibTimerId: null,
  animFrameId: null,
  isCalibConfirming: false,

  // v10.1 新增：自動儲存上次完成臨床訓練之個人化校準設定狀態
  hasSavedCalibration: false,
  savedCalibrationSnapshot: null,

  targetBpm: 10,
  ieRatio: 2,
  inhaleTarget: 2.0,
  exhaleTarget: 4.0,
  totalDuration: 120,
  privacyMode: 'privacy_mesh', // 'mirror' | 'privacy_mesh' | 'minimalist'
  lastNonInteractivePrivacyMode: 'privacy_mesh',
  displayMode: 'balloon',      // 'balloon' | 'human' | 'interactive'
  lastNonInteractiveDisplayMode: 'balloon',
  humanGender: 'male',
  interactiveObject: 'pinwheel', // 'pinwheel' (風車) | 'dandelion' (蒲公英)
  voiceEnabled: true,

  ema: {
    initialized: false,
    y11Prev: 0,
    y12Prev: 0,
    faceInitialized: false,
    larPrev: 0.035,
    jawOpenPrev: 0.015,
    mouthPuckerPrev: 0.10,
    mouthFunnelPrev: 0.10,
    deltaLar: 0,
    deltaJawOpen: 0,
    deltaMouthPucker: 0,
    deltaMouthFunnel: 0,

    // v10 新增：16+4 點幾何與遮擋恢復狀態
    hInnerPrev: 0.018,
    hCenterPrev: 0.020,
    wOuterPrev: 0.460,
    olarPrev: 0.250,
    noiPrev: 0.0,
    noiCenterPrev: 0.0,
    mwrPrev: 1.0,
    olarRatioPrev: 1.0,
    deltaNoi: 0,
    deltaMwr: 0,
    lastColHeights: { L: 0.018, M: 0.020, R: 0.018 },
    prevValidCols: 3,
    occlusionHoldSec: 0,
    occlusionRecoveryTicks: 0,
    momentumPauseTicks: 0
  },

  calibration: {
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
      yShoulder: [],
      hInner: [],
      hCenter: [],
      wOuter: [],
      olar: [],
      pitchRatio: [],
      zProtrusion: []
    },
    stepSource: {
      1: 'default',
      2: 'default',
      3: 'default',
      4: 'default',
      5: 'default'
    },
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
    larRest: DEFAULT_CALIB_BASELINES.LAR_closed,

    // v10 新增：雙軌內唇高度與外唇縮寬/圓潤個人化基準
    H_inner_closed: DEFAULT_CALIB_BASELINES.H_inner_closed,
    H_inner_open: DEFAULT_CALIB_BASELINES.H_inner_open,
    H_center_closed: DEFAULT_CALIB_BASELINES.H_center_closed,
    H_center_open: DEFAULT_CALIB_BASELINES.H_center_open,
    W_outer_closed: DEFAULT_CALIB_BASELINES.W_outer_closed,
    W_outer_plb: DEFAULT_CALIB_BASELINES.W_outer_plb,
    MWR_plb: DEFAULT_CALIB_BASELINES.MWR_plb,
    OLAR_closed: DEFAULT_CALIB_BASELINES.OLAR_closed,
    OLAR_plb: DEFAULT_CALIB_BASELINES.OLAR_plb,
    pitchRatio_closed: DEFAULT_CALIB_BASELINES.pitchRatio_closed,
    zProtrusion_closed: DEFAULT_CALIB_BASELINES.zProtrusion_closed
  },

  currentMetrics: {
    dEye: 0.22,
    larRaw: 0.04,
    lar: 0.04,
    jawOpenRaw: 0.01,
    jawOpen: 0.01,
    mouthPuckerRaw: 0.10,
    mouthPucker: 0.10,
    mouthFunnelRaw: 0.10,
    mouthFunnel: 0.10,
    deltaLar: 0.00,
    deltaJawOpen: 0.00,
    deltaMouthPucker: 0.00,

    // v10 新增：實時幾何、姿態與質量指標
    hInnerRaw: 0.018,
    hInner: 0.018,
    hCenterRaw: 0.020,
    hCenter: 0.020,
    wOuterRaw: 0.460,
    wOuter: 0.460,
    olarRaw: 0.250,
    olar: 0.250,
    noi: 0.00,
    noiCenter: 0.00,
    mwr: 1.00,
    olarRatio: 1.00,
    deltaNoi: 0.00,
    deltaMwr: 0.00,
    yawDeg: 0.0,
    pitchDeg: 0.0,
    zProtrusion: 0.0,
    poseValidForZ: true,
    validCols: 3,
    hasValidMouth: true,

    inhaleScore: 1.0,
    exhaleScore: 1.0,
    shoulderScore: 1.0,
    y11Smooth: 0.68,
    y12Smooth: 0.68,
    yShoulderCurr: 0.68,
    distCurr: 0.30,
    deltaYRelative: 0.00,
    deltaYShoulder: 0.00,
    shoulderTilt: 0.02,
    hasFace: false,
    hasPose: false
  },

  training: {
    startTime: 0,
    lastFrameTime: 0,
    lastInferenceTime: 0,
    inferenceTickCount: 0,
    elapsedSeconds: 0,
    currentPhase: PHASES.INHALE,
    phaseStartTime: 0,
    cycleStartTime: 0,
    cycleIndex: 0,

    inhaleGraceCycleTriggered: -1,
    inhaleEntryTimestamp: 0,
    inhaleGraceCompleted: false,
    exhaleGraceCycleTriggered: -1,
    exhaleEntryTimestamp: 0,
    exhaleGraceCompleted: false,

    isSoftTransitioning: false,
    softTransitionStartTime: 0,
    softTransitionStartScale: 1.0,

    tInActual: 0,
    tExActual: 0,

    inhaleLipClosedTime: 0,
    inhaleNoShrugTime: 0,
    inhalePhaseTime: 0,
    inhaleQualifiedForBlow: false,
    isInteractiveBlowing: false,
    exhaleValidHoldSec: 0,
    exhaleInvalidCutoffSec: 0,

    avgRR: 10.0,
    rollingWindow: [],
    isWarmingUp: true,

    pctInhale: 100,
    pctExhale: 100,
    pctShoulder: 100,
    pctRr: 100,

    phaseAccum: {
      inhale: { totalTime: 0, errorTime: 0 },
      exhale: { totalTime: 0, errorTime: 0 },
      shoulder: { totalTime: 0, errorTime: 0 }
    },

    realtimeErrorSec: {
      inhale: 0,
      exhale: 0,
      shoulder: 0
    },

    alertSchedule: {
      inhale: { key: 'inhale', label: '合口吸氣', consecutiveFails: 0, consecutivePasses: 0, inAlertSchedule: false, unlockedWhileLowPct: false, lastPhaseResult: 'PASS', order: 2 },
      exhale: { key: 'exhale', label: '噘唇呼氣', consecutiveFails: 0, consecutivePasses: 0, inAlertSchedule: false, unlockedWhileLowPct: false, lastPhaseResult: 'PASS', order: 3 },
      shoulder: { key: 'shoulder', label: '沉肩放鬆', consecutiveFails: 0, consecutivePasses: 0, inAlertSchedule: false, unlockedWhileLowPct: false, lastPhaseResult: 'PASS', order: 1 }
    },

    cyclesHistory: [],
    totalInhaleFrames: 0,
    validInhaleFrames: 0,
    totalExhaleFrames: 0,
    validPlbExhaleFrames: 0,
    totalShoulderFrames: 0,
    validShoulderFrames: 0,
    totalInhaleTimeSec: 0,
    validInhaleTimeSec: 0,
    totalExhaleTimeSec: 0,
    validPlbExhaleTimeSec: 0,
    totalShoulderTimeSec: 0,
    validShoulderTimeSec: 0
  },

  feedback: {
    latchedModule: null,
    latchedImprovedSec: 0,
    satisfiedBy10s: {
      inhale: false,
      exhale: false,
      shoulder: false,
      rr: false
    },
    currentPMessage: '分析中...',
    currentPriority: 0,
    pendingPriority: 0,
    pendingMessage: '',
    pendingTimestamp: 0,
    debounceMs: 800
  },

  tts: {
    lastSpokenTime: 0,
    cooldownMs: 4500,
    speechSynthesisVoice: null
  }
};
