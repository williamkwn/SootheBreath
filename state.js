/**
 * 舒呼(SootheBreath) 呼吸復康訓練 — 實時呼吸視覺生物反饋系統 (PWA v9.2)
 * ESM Core Engine: MediaPipe Tasks Vision 0.10.14 + Three.js 3D Interactive Mode (60 FPS + Fix 1–4 Accuracy Edition)
 */

// ============================================================================
// 1. 系統常數與全域狀態管理 (State Machine, Clinical Defaults & Dynamic Thresholds)
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

// 真人示範模式圖片資源映射 (對應根目錄 1.jpg - 4.jpg)
export const HUMAN_IMAGES = {
  male: {
    inhale: '1.jpg', // 男性吸氣 (閉口鼻吸)
    exhale: '2.jpg'  // 男性呼氣 (噘唇慢呼)
  },
  female: {
    inhale: '3.jpg', // 女性吸氣 (閉口鼻吸)
    exhale: '4.jpg'  // 女性呼氣 (噘唇慢呼)
  }
};

// 預設個人化基準值 (當治療師點擊「使用預設值並跳至下一步」或免鏡頭模式兜底時使用)
export const DEFAULT_CALIB_BASELINES = {
  D_eye: 0.220,
  LAR_closed: 0.038,
  jawOpen_closed: 0.018,
  LAR_open: 0.350,
  jawOpen_open: 0.420,
  LAR_pucker: 0.120,
  mouthPucker_max: 0.550,
  mouthFunnel_max: 0.450,
  Dist_shrug: 0.240,
  Dist_relax: 0.300,
  Dist_base: 0.300,
  yShoulderBase: 0.720
};

// 預設臨床生物力學閾值 (可於五步校準後自動個人化更新，或於 Debug Drawer 即時微調)
export const DEFAULT_THRESHOLDS = {
  // 吸氣閉口判定閾值 (Inhale Lip Closure & Jaw Open)
  larInhaleMax: 0.08,
  jawOpenInhaleMax: 0.10,

  // 呼氣噘唇判定閾值 (Exhale Pursed-Lip Breathing - PLB)
  larExhaleMin: 0.04,
  larExhaleMax: 0.26,
  larExhaleWideErr: 0.30, // 呼氣張大口錯誤閾值 (LAR > 0.30 視為張大口吐氣)
  mouthPuckerMin: 0.32,   // MediaPipe Blendshape mouthPucker 閾值
  mouthFunnelMin: 0.25,   // MediaPipe Blendshape mouthFunnel 備援閾值

  // 沉肩代償閾值 (Shoulder Hike Compensation via Torso/Ear-Shoulder Anchoring)
  shoulderHikeWarn: 0.040, // (Dist_base - Dist_curr) / D_eye > 0.040 視為聳肩代償
  shoulderTiltMax: 0.10,

  // EMA 平滑係數 (Exponential Moving Average Alpha)
  emaAlpha: 0.35,          // 雙肩座標 EMA Alpha
  emaLarAlpha: 0.25,       // 嘴唇開合比 LAR EMA Alpha
  emaJawAlpha: 0.25,       // 下頜張開 jawOpen EMA Alpha
  emaPuckerAlpha: 0.30,    // 噘唇 mouthPucker / mouthFunnel EMA Alpha

  // 呼氣 70% 提前達標柔性過渡比例
  earlyExhaleRatio: 0.70
};

// 實時生效之閾值物件
export const THRESHOLDS = { ...DEFAULT_THRESHOLDS };

// 五步個人化動態基準校準配置表 (Section B.1)
export const CALIB_STEPS_CONFIG = {
  1: {
    step: 1,
    shortName: '閉嘴',
    title: '第 1 步【閉嘴】：自然閉上嘴巴',
    subtitle: '請指導病人自然坐直、閉上嘴巴，面部正對鏡頭，系統將採集個人閉口基準與雙眼間距。',
    metricsDesc: '採集指標：個人閉口嘴唇比 (LAR_closed)、下頜閉合基準 (jawOpen_closed)、雙眼間距 (D_eye)',
    ttsPrompt: '第一步，請自然閉上嘴巴，保持面部正對鏡頭'
  },
  2: {
    step: 2,
    shortName: '張大口',
    title: '第 2 步【張大口】：自然張大嘴巴',
    subtitle: '請指導病人自然張大嘴巴（如發「啊」音），系統將採集個人最大張口幅度以建立呼吸錯誤邊界。',
    metricsDesc: '採集指標：最大張口嘴唇比 (LAR_open)、最大下頜張開幅度 (jawOpen_open)',
    ttsPrompt: '第二步，請自然張大嘴巴，保持三秒'
  },
  3: {
    step: 3,
    shortName: '噘唇',
    title: '第 3 步【噘唇】：嘴唇噘起如吹蠟燭',
    subtitle: '請指導病人將嘴唇噘起成吹口哨或吹蠟燭狀，系統將採集個人化噘唇肌力與開口範圍。',
    metricsDesc: '採集指標：噘唇嘴唇比 (LAR_pucker)、最大噘唇收縮值 (mouthPucker_max)、漏斗唇值 (mouthFunnel_max)',
    ttsPrompt: '第三步，請將嘴唇噘起，好似吹蠟燭咁保持住'
  },
  4: {
    step: 4,
    shortName: '縮膊頭',
    title: '第 4 步【縮膊頭】：雙肩向上縮起',
    subtitle: '請指導病人雙肩向上聳起（縮膊頭），系統將採集個人聳肩代償極限時之耳肩距離。',
    metricsDesc: '採集指標：聳肩狀態耳肩垂直距離 (Dist_shrug)',
    ttsPrompt: '第四步，請將兩邊膊頭向上縮起，保持三秒'
  },
  5: {
    step: 5,
    shortName: '放鬆膊頭',
    title: '第 5 步【放鬆膊頭】：雙肩完全下沉放鬆',
    subtitle: '請指導病人將雙肩完全放鬆下沉，系統將確立個人化耳肩距離基準 (Dist_relax) 並自動計算動態閾值。',
    metricsDesc: '採集指標：放鬆狀態耳肩基準距離 (Dist_relax / Dist_base)',
    ttsPrompt: '第五步，請將兩邊膊頭完全放鬆沉低，保持自然呼吸'
  }
};

// 訓練開局緩衝期、門檻與 v9.2 效能/準確度常數
export const ROLLING_WINDOW_SECONDS = 20.0;
export const INITIAL_GRACE_SECONDS = 10.0;  // 前 10 秒開局緩衝期
export const PHASE_ENTRY_GRACE_MS = 400;    // 吸呼雙向階段切換前 400ms 生理反應緩衝期
export const PASSING_SCORE_PCT = 80;        // 合格達標門檻 80%
export const CONSECUTIVE_IMPROVE_SECONDS = 10.0;
export const INFERENCE_INTERVAL_MS = 50;    // P0-1: MediaPipe 推論間隔 50ms (20 FPS)
export const UI_THROTTLE_MS = 120;          // P1-2: 卡片與 DOM 更新節流間隔 120ms (~8.3 Hz)
export const EXHALE_BLOW_CONFIRM_SEC = 0.10; // Fix 2: 呼氣需連續 >= 0.10s 真實噘唇且無聳肩才觸發吹風
export const EXHALE_BLOW_CUTOFF_SEC = 0.20;  // Fix 2: 呼氣中途做錯動作或聳肩連續 >= 0.20s 即刻停止吹風
export const REALTIME_ERROR_BANNER_SEC = 0.90; // Fix 3: 當前階段連續做錯動作 >= 0.90s 即時觸發橫幅與語音糾正

// 確保 MediaPipe 視訊時間戳嚴格遞增
let lastVideoTimestamp = 0;
export function getNextTimestamp() {
  const now = Math.floor(performance.now());
  if (now <= lastVideoTimestamp) {
    lastVideoTimestamp += 1;
  } else {
    lastVideoTimestamp = now;
  }
  return lastVideoTimestamp;
}

export function clampVal(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

export function roundTo(val, decimals = 3) {
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
  if (valid.length < 5) {
    return valid.reduce((a, b) => a + b, 0) / valid.length;
  }
  const sorted = [...valid].sort((a, b) => a - b);
  const trimCount = Math.max(1, Math.floor(sorted.length * 0.2));
  const trimmed = sorted.slice(trimCount, sorted.length - trimCount);
  return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
}

export const AppState = {
  currentState: STATES.IDLE,
  visionReady: false,
  faceLandmarker: null,
  poseLandmarker: null,
  cameraStream: null,
  isDemoMode: false,
  isPaused: false,
  animFrameId: null,
  calibTimerId: null,
  isCalibConfirming: false,

  targetBpm: 10,
  ieRatio: 2,
  inhaleTarget: 2.0,
  exhaleTarget: 4.0,
  totalDuration: 120,
  privacyMode: 'privacy_mesh', // 'mirror' | 'privacy_mesh' | 'minimalist' | 'interactive'
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
    larPrev: 0.038,
    jawOpenPrev: 0.018,
    mouthPuckerPrev: 0.08,
    mouthFunnelPrev: 0.06,
    deltaLar: 0,
    deltaJawOpen: 0,
    deltaMouthPucker: 0,
    deltaMouthFunnel: 0
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
      yShoulder: []
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
    LAR_pucker: DEFAULT_CALIB_BASELINES.LAR_pucker,
    mouthPucker_max: DEFAULT_CALIB_BASELINES.mouthPucker_max,
    mouthFunnel_max: DEFAULT_CALIB_BASELINES.mouthFunnel_max,
    Dist_shrug: DEFAULT_CALIB_BASELINES.Dist_shrug,
    Dist_relax: DEFAULT_CALIB_BASELINES.Dist_relax,

    dEyeBase: DEFAULT_CALIB_BASELINES.D_eye,
    distBase: DEFAULT_CALIB_BASELINES.Dist_base,
    yShoulderBase: DEFAULT_CALIB_BASELINES.yShoulderBase,
    larRest: DEFAULT_CALIB_BASELINES.LAR_closed
  },

  currentMetrics: {
    dEye: 0.22,
    larRaw: 0.04,
    lar: 0.04,
    jawOpenRaw: 0.02,
    jawOpen: 0.02,
    mouthPuckerRaw: 0.10,
    mouthPucker: 0.10,
    mouthFunnelRaw: 0.08,
    mouthFunnel: 0.08,
    deltaLar: 0,
    deltaJawOpen: 0,
    deltaMouthPucker: 0,
    yShoulderCurr: 0.65,
    y11Smooth: 0.65,
    y12Smooth: 0.65,
    distCurr: 0.30,
    deltaYRelative: 0.0,
    deltaYShoulder: 0.0,
    shoulderTilt: 0.0,
    inhaleScore: 1.0,
    exhaleScore: 1.0,
    shoulderScore: 1.0,
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

    // v9.2 互動模式（風車 / 蒲公英）動作分析觸發與實時中斷狀態
    inhaleLipClosedTime: 0,
    inhaleNoShrugTime: 0,
    inhalePhaseTime: 0,
    inhaleQualifiedForBlow: false,
    isInteractiveBlowing: false,
    exhaleValidHoldSec: 0,
    exhaleInvalidCutoffSec: 0,

    // v9.2 實時連續錯誤計時器 (供 feedback.js 即時警示橫幅使用)
    realtimeErrorSec: {
      inhale: 0,
      exhale: 0,
      shoulder: 0
    },

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

    alertSchedule: {
      inhale: { key: 'inhale', label: '合口吸氣', consecutiveFails: 0, consecutivePasses: 0, inAlertSchedule: false, lastPhaseResult: 'PASS', order: 2 },
      exhale: { key: 'exhale', label: '噘唇呼氣', consecutiveFails: 0, consecutivePasses: 0, inAlertSchedule: false, lastPhaseResult: 'PASS', order: 3 },
      shoulder: { key: 'shoulder', label: '沉肩放鬆', consecutiveFails: 0, consecutivePasses: 0, inAlertSchedule: false, lastPhaseResult: 'PASS', order: 1 }
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
    currentPriority: 5,
    currentPMessage: '',
    pendingMessage: '',
    pendingPriority: 5,
    pendingTimestamp: 0,
    debounceMs: 600
  },

  tts: {
    lastSpokenTime: 0,
    cooldownMs: 4500,
    speechSynthesisVoice: null
  }
};
