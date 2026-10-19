/**
 * 舒呼(SootheBreath) 呼吸復康訓練 — 實時呼吸視覺生物反饋系統 (PWA v8.0)
 * ESM Core Engine: MediaPipe Tasks Vision 0.10.14
 *
 * v6.0 核心升級項目：
 * A) 主設定頁面與全域模式命名規範：
 *    1. 移除主設定頁面底部「廣東話 (zh-HK) 語音導航口令已預設開啟...」提示橫幅（背景維持預設開啟廣東話語音導航）。
 *    2. 全域統一英文相機模式首字母大寫：
 *       - 實時鏡像模式 Mirror Mode
 *       - 去識別化骨架網格模式 Privacy Mesh Mode
 *       - 純引導模式 Pure Guiding Mode
 * B) 鏡頭校準模式 (STATE_CALIBRATING) 升級為「五步個人化動態基準校準系統」：
 *    1. 五步依序動作採集：第1步【閉嘴】、第2步【張大口】、第3步【噘唇】、第4步【縮膊頭】、第5步【放鬆膊頭】。
 *    2. 治療師確認機制：每步進入「等待確認」狀態，點擊「✅ 確定開始採集此動作」後方進行 3 秒倒數採集（配廣東話語音）；
 *       提供「下一步」、「🔄 重測此動作」及「⏭️ 使用預設值並跳至下一步」兜底機制。
 *    3. 個人化動態閾值自動計算 (去極端值平均 Trimmed Mean + 安全上下限 Clamping) 並同步至 Debug Drawer 滑桿與數值。
 *    4. 五步個人化基準校準總結面板（支援單步重測或全部重測）與免鏡頭模擬模式 (Demo Mode) 完整五步模擬數據生成。
 * C) 訓練頁面 (STATE_TRAINING) 實時百分比生物反饋與鎖定平滑警示機制：
 *    1. 四張生物反饋指示卡改為顯示「實時合格率 / 準確度百分比 (0%–100%)」：
 *       【合口吸氣】、【噘唇呼氣】、【沉肩放鬆】、【呼吸速率】，隱藏卡片上之工程數值（僅保留於 Debug Drawer）。
 *    2. 最近 20 秒滾動時間窗 (Rolling Window) 實時計算 + 開局前 10 秒緩衝期（預設顯示 100% 且不觸發低分警示）；
 *       訓練結束 Summary 報告維持計算全程總平均。
 *    3. 三段式合格標準樣式：≥80%「合格達標」(綠)、70%–79%「持續保持」(淺藍/中性緩衝)、<70%「需要改善」(橙紅警示)。
 *    4. 最低分優先與「鎖定直到回升 ≥70%」平滑警示機制 (Sticky Priority Latch)。
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

// 預設臨床推薦閾值 (Default Clinical Thresholds — 用於初始化與「恢復預設推薦閾值」)
export const DEFAULT_THRESHOLDS = {
  larInhaleMax: 0.06,          // 吸氣閉口鼻吸 LAR 上限 (LAR <= 0.06)
  jawOpenInhaleMax: 0.05,      // 吸氣雙重聯合判定：下頜微張上限 (jawOpen < 0.05)
  larInhaleErr: 0.08,          // 吸氣張口明顯錯誤閾值
  larExhaleMin: 0.04,          // 呼氣噘唇 LAR 下限 (0.04 <= LAR <= 0.24)
  larExhaleMax: 0.24,          // 呼氣噘唇 LAR 上限
  larExhaleWideErr: 0.26,      // 呼氣張大口錯誤閾值
  larExhaleClosedErr: 0.03,    // 呼氣完全閉口錯誤閾值
  mouthPuckerMin: 0.36,        // 呼氣噘唇 mouthPucker 下限 (預設 0.52 * 70% = 0.36)
  mouthFunnelMin: 0.35,        // 呼氣漏斗狀 mouthFunnel 下限 (>= 0.35)
  puckerWideErrMax: 0.30,
  puckerClosedErrMax: 0.25,    // 呼氣自然放鬆唇形閾值 (mouthPucker < 0.25)
  shoulderHikeWarn: 0.12,      // 耳肩相對間距縮短聳肩代償警示 (Delta_Y_relative > 0.12)
  shoulderHikeNormal: 0.10,    // 正常沉肩範圍 (Delta_Y_relative <= 0.10)
  shoulderTiltMax: 0.15,       // 雙肩左右傾斜度上限
  earlyExhaleRatio: 0.70,      // 呼氣階段 70% 動態完成柔性過渡門檻 (phaseElapsed >= T_exhale_target * 0.70)
  emaAlpha: 0.35,              // 雙肩座標 EMA 指數移動平均平滑係數 (alpha = 0.35)
  emaLarAlpha: 0.25,           // 嘴唇開合比 LAR EMA 平滑係數 (alpha = 0.25)
  emaJawAlpha: 0.25,           // 下頜張開度 jawOpen EMA 平滑係數 (alpha = 0.25)
  emaPuckerAlpha: 0.30,        // 噘唇度 mouthPucker EMA 平滑係數 (alpha = 0.30)
  puckerPeakEffortDiscount: 0.70 // 校準峰值努力折扣係數 (70% of calibrated peak mouthPucker)
};

// 全域動態臨床閾值 (由五步個人化基準校準或 Debug Drawer 動態更新)
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
  yShoulderBase: 0.720
};

// 五步校準步驟定義 (Step 1 to Step 5)
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
    inhale: (window.__SOOTHE_IMAGES && window.__SOOTHE_IMAGES['1.jpg']) || '1.jpg',
    exhale: (window.__SOOTHE_IMAGES && window.__SOOTHE_IMAGES['2.jpg']) || '2.jpg'
  },
  female: {
    inhale: (window.__SOOTHE_IMAGES && window.__SOOTHE_IMAGES['3.jpg']) || '3.jpg',
    exhale: (window.__SOOTHE_IMAGES && window.__SOOTHE_IMAGES['4.jpg']) || '4.jpg'
  }
};

// 訓練滾動時間窗與開局緩衝期常數 (Section C.2)
export const ROLLING_WINDOW_SECONDS = 20.0; // 最近 20 秒滾動時間窗
export const INITIAL_GRACE_SECONDS = 10.0;  // 前 10 秒開局緩衝期
export const PHASE_ENTRY_GRACE_MS = 400;    // 吸呼雙向階段切換前 400ms 生理反應緩衝期 (每階段僅觸發一次)
export const PASSING_SCORE_PCT = 80;        // 合格達標門檻 80% (< 80% 直接顯示「需要改善」並納入警示排程)
export const CONSECUTIVE_IMPROVE_SECONDS = 10.0; // 連續 10 秒表現改善後即轉移提醒其他需要改善項目

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

/**
 * 指數移動平均濾波器 (Exponential Moving Average, EMA)
 * 用於消除 MediaPipe 原始特徵點高頻抖動 (±0.02 jitter)
 */
export function ema(rawVal, prevVal, alpha) {
  if (typeof prevVal !== 'number' || Number.isNaN(prevVal)) return rawVal;
  return alpha * rawVal + (1 - alpha) * prevVal;
}

/**
 * 去極端值平均 (Trimmed Mean, 剔除最高 20% 與最低 20% 樣本以防瞬時抖動)
 */
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
  isCalibConfirming: false,

  // 使用者設定 (僅設定 BPM [20 至 5]、吸呼比 [1:2 或 1:3]、訓練總時長 [1-10 分鐘滑桿])
  targetBpm: 10,               // 目標呼吸頻率 BPM (範圍 20 至 5，預設 10 BPM)
  ieRatio: 2,                  // 目標吸呼比 1:2 或 1:3 (值為 2 或 3)
  inhaleTarget: 2.0,           // 由 BPM 與吸呼比自動計算：60 / BPM / (1 + ieRatio)
  exhaleTarget: 4.0,           // 由 BPM 與吸呼比自動計算：inhaleTarget * ieRatio
  totalDuration: 120,          // 訓練總時長秒數 (1 至 10 分鐘滑桿，預設 2 分鐘 = 120 秒)
  privacyMode: 'privacy_mesh', // 'mirror' (實時鏡像模式 Mirror Mode) | 'privacy_mesh' (去識別化骨架網格模式 Privacy Mesh Mode) | 'minimalist' (純引導模式 Pure Guiding Mode)
  displayMode: 'balloon',      // 'balloon' | 'human'
  humanGender: 'male',         // 'male' (男性) | 'female' (女性)
  voiceEnabled: true,          // 廣東話 (zh-HK) 語音導航口令：預設背景開啟 (Default ON)

  // EMA 平滑濾波狀態器 (涵蓋雙肩 Pose 11/12 與面部 LAR / jawOpen / mouthPucker / mouthFunnel 及 Δ 趨勢)
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
    deltaMouthFunnel: 0
  },

  // 五步個人化動態基準校準狀態與結果 (Section B)
  calibration: {
    currentStep: 1,            // 1 至 5
    subState: 'WAITING_CONFIRM', // 'WAITING_CONFIRM' | 'COUNTDOWN' | 'STEP_DONE' | 'SUMMARY'
    retestSingleStepMode: false, // 若從總結面板單獨重測某一步，完成後可直接返回總結
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
      1: 'default', // 'measured' | 'default'
      2: 'default',
      3: 'default',
      4: 'default',
      5: 'default'
    },
    stepSampleCounts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },

    // 五步採集之個人化基準數值
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

    // 與核心訓練算法對接之別名欄位
    dEyeBase: DEFAULT_CALIB_BASELINES.D_eye,
    distBase: DEFAULT_CALIB_BASELINES.Dist_base,
    yShoulderBase: DEFAULT_CALIB_BASELINES.yShoulderBase,
    larRest: DEFAULT_CALIB_BASELINES.LAR_closed
  },

  // 實時推論變數 (lar, jawOpen, mouthPucker, mouthFunnel 均為 EMA 濾波後數值)
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

  // 訓練過程狀態機與四大實時百分比指標
  training: {
    startTime: 0,
    lastFrameTime: 0,
    elapsedSeconds: 0,
    currentPhase: PHASES.INHALE,
    phaseStartTime: 0,
    cycleStartTime: 0,
    cycleIndex: 0,

    // 雙向 400ms 階段轉換緩衝期單次觸發鎖定狀態 (Bidirectional 400ms Entry Grace — Strictly Once Per Phase Cycle)
    inhaleGraceCycleTriggered: -1,
    inhaleEntryTimestamp: 0,
    inhaleGraceCompleted: false,
    exhaleGraceCycleTriggered: -1,
    exhaleEntryTimestamp: 0,
    exhaleGraceCompleted: false,

    // 呼氣 70% 柔性過渡狀態
    isSoftTransitioning: false,
    softTransitionStartTime: 0,
    softTransitionStartScale: 1.0,

    // 當前週期累計有效時間
    tInActual: 0,
    tExActual: 0,

    // 實時呼吸頻率 (Actual RR, breaths/min)
    avgRR: 10.0,

    // 最近 20 秒滾動時間窗樣本佇列 (Section C.2)
    rollingWindow: [],

    // 開局前 10 秒緩衝期狀態 (期間保持累計百分比運算開啟，但不觸發任何警示或成功橫幅)
    isWarmingUp: true,

    // 四大模組全程累計時間百分比 (Cumulative Total Time Percentage: 0% - 100%)
    pctInhale: 100,
    pctExhale: 100,
    pctShoulder: 100,
    pctRr: 100,

    // 單一階段錯誤時間累計器 (Phase-End Evaluation: errorTime > 50% -> Phase_Fail)
    phaseAccum: {
      inhale: { totalTime: 0, errorTime: 0 },
      exhale: { totalTime: 0, errorTime: 0 },
      shoulder: { totalTime: 0, errorTime: 0 }
    },

    // 連續失敗計數與「需要改善排程」(Alert Schedule: consecutiveFails >= 2 觸發; 連續 2 次 Pass 解鎖)
    alertSchedule: {
      inhale: { key: 'inhale', label: '合口吸氣', consecutiveFails: 0, consecutivePasses: 0, inAlertSchedule: false, lastPhaseResult: 'PASS', order: 2 },
      exhale: { key: 'exhale', label: '噘唇呼氣', consecutiveFails: 0, consecutivePasses: 0, inAlertSchedule: false, lastPhaseResult: 'PASS', order: 3 },
      shoulder: { key: 'shoulder', label: '沉肩放鬆', consecutiveFails: 0, consecutivePasses: 0, inAlertSchedule: false, lastPhaseResult: 'PASS', order: 1 }
    },

    // 全程統計指標 (供 STATE_SUMMARY 報告計算全程總平均)
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

  // 鎖定平滑過渡警示機制 (Sticky Priority Latch · <80% 警示與連續 10 秒改善轉移)
  feedback: {
    latchedModule: null,       // null | 'inhale' | 'exhale' | 'shoulder' | 'rr'
    latchedImprovedSec: 0,     // 當前鎖定項目已連續改善之秒數 (滿 10 秒轉移)
    satisfiedBy10s: {          // 已透過連續 10 秒改善而解除鎖定之項目
      inhale: false,
      exhale: false,
      shoulder: false,
      rr: false
    },
    currentPMessage: '持續保持',
    currentPriority: 5,
    pendingPriority: 5,
    pendingMessage: '',
    pendingTimestamp: 0,
    debounceMs: 800
  },

  // TTS 語音排程 (4500ms Cooldown)
  tts: {
    lastSpokenTime: 0,
    cooldownMs: 4500,
    speechSynthesisVoice: null
  }
};

