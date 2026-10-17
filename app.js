/**
 * 舒呼(SootheBreath) 呼吸復康訓練 — 實時呼吸視覺生物反饋系統 (PWA v6.0)
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
const STATES = {
  IDLE: 'STATE_IDLE',
  CALIBRATING: 'STATE_CALIBRATING',
  TRAINING: 'STATE_TRAINING',
  SUMMARY: 'STATE_SUMMARY'
};

const PHASES = {
  INHALE: 'INHALE',
  EXHALE: 'EXHALE'
};

// 預設臨床推薦閾值 (Default Clinical Thresholds — 用於初始化與「恢復預設推薦閾值」)
const DEFAULT_THRESHOLDS = {
  larInhaleMax: 0.06,          // 吸氣閉口鼻吸 LAR 上限 (LAR <= 0.06)
  jawOpenInhaleMax: 0.05,      // 吸氣雙重聯合判定：下頜微張上限 (jawOpen < 0.05)
  larInhaleErr: 0.08,          // 吸氣張口明顯錯誤閾值
  larExhaleMin: 0.04,          // 呼氣噘唇 LAR 下限 (0.04 <= LAR <= 0.24)
  larExhaleMax: 0.24,          // 呼氣噘唇 LAR 上限
  larExhaleWideErr: 0.26,      // 呼氣張大口錯誤閾值
  larExhaleClosedErr: 0.03,    // 呼氣完全閉口錯誤閾值
  mouthPuckerMin: 0.40,        // 呼氣噘唇 mouthPucker 下限 (>= 0.40)
  mouthFunnelMin: 0.35,        // 呼氣漏斗狀 mouthFunnel 下限 (>= 0.35)
  puckerWideErrMax: 0.30,
  puckerClosedErrMax: 0.25,    // 呼氣自然放鬆唇形閾值 (mouthPucker < 0.25)
  shoulderHikeWarn: 0.12,      // 耳肩相對間距縮短聳肩代償警示 (Delta_Y_relative > 0.12)
  shoulderHikeNormal: 0.10,    // 正常沉肩範圍 (Delta_Y_relative <= 0.10)
  shoulderTiltMax: 0.15,       // 雙肩左右傾斜度上限
  earlyExhaleRatio: 0.70,      // 呼氣階段 70% 動態完成柔性過渡門檻 (phaseElapsed >= T_exhale_target * 0.70)
  emaAlpha: 0.35               // 雙肩座標 EMA 指數移動平均平滑係數 (alpha = 0.35)
};

// 全域動態臨床閾值 (由五步個人化基準校準或 Debug Drawer 動態更新)
const THRESHOLDS = { ...DEFAULT_THRESHOLDS };

// 五步個人化動態基準校準之臨床預設值 (Fallback Defaults)
const DEFAULT_CALIB_BASELINES = {
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
const CALIB_STEPS_CONFIG = [
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
const HUMAN_IMAGES = {
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
const ROLLING_WINDOW_SECONDS = 20.0; // 最近 20 秒滾動時間窗
const INITIAL_GRACE_SECONDS = 10.0;  // 前 10 秒開局緩衝期

// 確保 MediaPipe 視訊時間戳嚴格遞增
let lastVideoTimestamp = 0;
function getNextTimestamp() {
  const now = Math.floor(performance.now());
  lastVideoTimestamp = Math.max(now, lastVideoTimestamp + 1);
  return lastVideoTimestamp;
}

function clampVal(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

function roundTo(val, decimals = 2) {
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

/**
 * 去極端值平均 (Trimmed Mean, 剔除最高 20% 與最低 20% 樣本以防瞬時抖動)
 */
function computeTrimmedMean(samples, fallbackValue) {
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
const AppState = {
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

  // EMA 平滑濾波狀態器 (針對 Pose Landmark 11 左肩, 12 右肩)
  ema: {
    initialized: false,
    y11Prev: 0,
    y12Prev: 0
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

  // 實時推論變數
  currentMetrics: {
    dEye: 0.22,
    lar: 0.04,
    jawOpen: 0.01,
    mouthPucker: 0.10,
    mouthFunnel: 0.10,
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

    // 四大模組實時合格率 / 準確度百分比 (0% - 100%)
    pctInhale: 100,
    pctExhale: 100,
    pctShoulder: 100,
    pctRr: 100,

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

  // 鎖定平滑過渡警示機制 (Sticky Priority Latch) 與 800ms 防閃爍佇列 (Section C.4)
  feedback: {
    latchedModule: null,       // null | 'inhale' | 'exhale' | 'shoulder' | 'rr'
    currentPMessage: '做得好，繼續跟住節奏慢慢呼吸',
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

// ============================================================================
// 2. DOM 元素快取 (DOM Element References)
// ============================================================================
let dom = {};

function cacheDomElements() {
  dom = {
    // 狀態視圖容器
    stateIdle: document.getElementById('state-idle'),
    stateCalib: document.getElementById('state-calibrating'),
    stateTrain: document.getElementById('state-training'),
    stateSummary: document.getElementById('state-summary'),
    bottomBanner: document.getElementById('bottom-banner'),
    toast: document.getElementById('toast-notification'),
    toastText: document.getElementById('toast-text'),

    // 設定面板 1：目標吸呼時間與呼吸頻率 (STATE_IDLE)
    inputBpm: document.getElementById('input-bpm'),
    valTargetBpm: document.getElementById('val-target-bpm'),
    btnRatio12: document.getElementById('btn-ratio-1-2'),
    btnRatio13: document.getElementById('btn-ratio-1-3'),
    labelIePreset: document.getElementById('label-ie-preset'),
    valInhaleCalc: document.getElementById('val-inhale-calc'),
    valExhaleCalc: document.getElementById('val-exhale-calc'),
    valCycleTotal: document.getElementById('val-cycle-total'),
    inputDuration: document.getElementById('input-duration'),
    valDurationMins: document.getElementById('val-duration-mins'),

    // 設定面板 2：顯示模式 (STATE_IDLE)
    selectPrivacy: document.getElementById('select-privacy-mode'),
    btnPacerBalloon: document.getElementById('btn-pacer-balloon'),
    btnPacerHuman: document.getElementById('btn-pacer-human'),
    wrapperHumanGender: document.getElementById('wrapper-human-gender'),
    btnGenderMale: document.getElementById('btn-gender-male'),
    btnGenderFemale: document.getElementById('btn-gender-female'),
    btnStart: document.getElementById('btn-start'),
    btnStartDemo: document.getElementById('btn-start-demo'),

    // 五步個人化動態基準校準系統元件 (STATE_CALIBRATING)
    calibVideo: document.getElementById('calib-video'),
    calibCanvas: document.getElementById('calib-canvas'),
    btnCancelCalib: document.getElementById('btn-cancel-calib'),
    calibStageBadge: document.getElementById('calib-stage-badge'),
    calibProgressBar: document.getElementById('calib-progress-bar'),
    calibStepPill1: document.getElementById('calib-step-pill-1'),
    calibStepPill2: document.getElementById('calib-step-pill-2'),
    calibStepPill3: document.getElementById('calib-step-pill-3'),
    calibStepPill4: document.getElementById('calib-step-pill-4'),
    calibStepPill5: document.getElementById('calib-step-pill-5'),
    calibStatusPill: document.getElementById('calib-status-pill'),
    calibLiveReadout: document.getElementById('calib-live-readout'),
    calibStepWorkspace: document.getElementById('calib-step-workspace'),
    calibTitle: document.getElementById('calib-title'),
    calibSubtitle: document.getElementById('calib-subtitle'),
    calibTargetMetricsDesc: document.getElementById('calib-target-metrics-desc'),
    calibCountdown: document.getElementById('calib-countdown'),
    calibStepStateLabel: document.getElementById('calib-step-state-label'),
    calibStepTimerBarWrap: document.getElementById('calib-step-timer-bar-wrap'),
    calibStepTimerBar: document.getElementById('calib-step-timer-bar'),
    calibStepResultBox: document.getElementById('calib-step-result-box'),
    btnCalibConfirmStep: document.getElementById('btn-calib-confirm-step'),
    btnCalibNextStep: document.getElementById('btn-calib-next-step'),
    btnCalibRetestStep: document.getElementById('btn-calib-retest-step'),
    btnCalibPrevStep: document.getElementById('btn-calib-prev-step'),
    btnCalibUseDefault: document.getElementById('btn-calib-use-default'),

    // 五步校準完成總結面板
    calibConfirmOverlay: document.getElementById('calib-confirm-overlay'),
    calibSummaryMetrics: document.getElementById('calib-summary-metrics'),
    calibSummaryThresholds: document.getElementById('calib-summary-thresholds'),
    btnConfirmStart: document.getElementById('btn-confirm-start'),
    btnRecalibrate: document.getElementById('btn-recalibrate'),
    btnAdjustSettings: document.getElementById('btn-adjust-settings'),

    // 訓練畫面視訊、畫布與佈局容器 (STATE_TRAINING)
    visionContainer: document.getElementById('vision-container'),
    guidancePanel: document.getElementById('guidance-panel'),
    trainVideo: document.getElementById('train-video'),
    trainCanvas: document.getElementById('train-canvas'),
    badgeMeshMode: document.getElementById('badge-mesh-mode'),

    // 訓練畫面頂部狀態與右上角控制按鈕
    pillPhase: document.getElementById('pill-phase'),
    pillCycle: document.getElementById('pill-cycle'),
    valCycleCount: document.getElementById('val-cycle-count'),
    valTimerLeft: document.getElementById('val-timer-left'),
    valLiveRr: document.getElementById('val-live-rr'),
    btnModeMirror: document.getElementById('btn-mode-mirror'),
    btnModeMesh: document.getElementById('btn-mode-mesh'),
    btnModeMinimal: document.getElementById('btn-mode-minimal'),
    btnTrainBalloon: document.getElementById('btn-train-balloon'),
    btnTrainMale: document.getElementById('btn-train-male'),
    btnTrainFemale: document.getElementById('btn-train-female'),
    btnTrainRecalibrate: document.getElementById('btn-train-recalibrate'),

    // 呼吸節奏球與真人示範元件
    pacerVisualArea: document.getElementById('pacer-visual-area'),
    pacerOuterRing: document.getElementById('pacer-outer-ring'),
    pacerBall: document.getElementById('pacer-ball'),
    pacerActionText: document.getElementById('pacer-action-text'),
    pacerSecondsText: document.getElementById('pacer-seconds-text'),
    humanDemoWrapper: document.getElementById('human-demo-wrapper'),
    humanDemoBox: document.getElementById('human-demo-box'),
    imgHumanInhale: document.getElementById('img-human-inhale'),
    imgHumanExhale: document.getElementById('img-human-exhale'),
    humanActionText: document.getElementById('human-action-text'),
    humanSecondsText: document.getElementById('human-seconds-text'),
    pacerPhaseHint: document.getElementById('pacer-phase-hint'),

    // 四張實時百分比生物反饋指示卡 (Section C.1 & C.3)
    biofeedbackCardsGrid: document.getElementById('biofeedback-cards-grid'),
    cardInhale: document.getElementById('card-status-inhale'),
    textInhaleState: document.getElementById('text-inhale-state'),
    badgeInhalePct: document.getElementById('badge-inhale-pct'),
    cardExhale: document.getElementById('card-status-exhale'),
    textExhaleState: document.getElementById('text-exhale-state'),
    badgeExhalePct: document.getElementById('badge-exhale-pct'),
    cardShoulder: document.getElementById('card-status-shoulder'),
    textShoulderState: document.getElementById('text-shoulder-state'),
    badgeShoulderPct: document.getElementById('badge-shoulder-pct'),
    cardRr: document.getElementById('card-status-rr'),
    textRrState: document.getElementById('text-rr-state'),
    badgeRrPct: document.getElementById('badge-rr-pct'),

    // 訓練底部控制按鈕
    btnPauseTrain: document.getElementById('btn-pause-train'),
    btnStopEarly: document.getElementById('btn-stop-early'),

    // 總結報告畫面元件 (STATE_SUMMARY)
    btnRestart: document.getElementById('btn-restart'),
    btnExportCsv: document.getElementById('btn-export-csv'),
    btnSaveLocal: document.getElementById('btn-save-local'),
    btnClearHistory: document.getElementById('btn-clear-history'),
    sumCycles: document.getElementById('sum-cycles'),
    sumDuration: document.getElementById('sum-duration'),
    sumRr: document.getElementById('sum-rr'),
    sumIe: document.getElementById('sum-ie'),
    sumPlbAcc: document.getElementById('sum-plb-acc'),
    sumShoulderAcc: document.getElementById('sum-shoulder-acc'),
    sumGrade: document.getElementById('sum-grade'),
    listHistory: document.getElementById('list-history'),

    // 調試面板 (Debug Drawer)
    btnToggleDebug: document.getElementById('btn-toggle-debug'),
    btnCloseDebug: document.getElementById('btn-close-debug'),
    debugDrawer: document.getElementById('debug-drawer'),
    debugBackdrop: document.getElementById('debug-backdrop'),
    dbgLar: document.getElementById('dbg-val-lar'),
    dbgJaw: document.getElementById('dbg-val-jaw'),
    dbgPucker: document.getElementById('dbg-val-pucker'),
    dbgFunnel: document.getElementById('dbg-val-funnel'),
    dbgShoulder: document.getElementById('dbg-val-shoulder'),
    dbgDistEs: document.getElementById('dbg-val-dist-es'),
    dbgDeye: document.getElementById('dbg-val-deye'),
    dbgTilt: document.getElementById('dbg-val-tilt'),
    dbgRr: document.getElementById('dbg-val-rr'),
    dbgLatch: document.getElementById('dbg-val-latch'),
    dbgRangeLarInMax: document.getElementById('dbg-range-lar-in-max'),
    dbgLblLarInMax: document.getElementById('dbg-lbl-lar-in-max'),
    dbgRangeJawInMax: document.getElementById('dbg-range-jaw-in-max'),
    dbgLblJawInMax: document.getElementById('dbg-lbl-jaw-in-max'),
    dbgRangeLarWideErr: document.getElementById('dbg-range-lar-wide-err'),
    dbgLblLarWideErr: document.getElementById('dbg-lbl-lar-wide-err'),
    dbgRangeLarExMin: document.getElementById('dbg-range-lar-ex-min'),
    dbgLblLarExMin: document.getElementById('dbg-lbl-lar-ex-min'),
    dbgRangeLarExMax: document.getElementById('dbg-range-lar-ex-max'),
    dbgLblLarExMax: document.getElementById('dbg-lbl-lar-ex-max'),
    dbgRangePuckerMin: document.getElementById('dbg-range-pucker-min'),
    dbgLblPuckerMin: document.getElementById('dbg-lbl-pucker-min'),
    dbgRangeFunnelMin: document.getElementById('dbg-range-funnel-min'),
    dbgLblFunnelMin: document.getElementById('dbg-lbl-funnel-min'),
    dbgRangeShoulderMax: document.getElementById('dbg-range-shoulder-max'),
    dbgLblShoulderMax: document.getElementById('dbg-lbl-shoulder-max'),
    btnResetThresholds: document.getElementById('btn-reset-thresholds'),

    // 相機錯誤 Modal
    modalError: document.getElementById('modal-camera-error'),
    modalErrorTitle: document.getElementById('modal-error-title'),
    modalErrorDesc: document.getElementById('modal-error-desc'),
    modalErrorSteps: document.getElementById('modal-error-steps'),
    btnModalRetry: document.getElementById('btn-modal-retry'),
    btnModalDemo: document.getElementById('btn-modal-demo'),
    btnModalClose: document.getElementById('btn-modal-close')
  };
}

function showToast(message) {
  if (!dom.toast || !dom.toastText) return;
  dom.toastText.textContent = message;
  dom.toast.classList.remove('hidden', 'opacity-0', 'translate-y-4');
  dom.toast.classList.add('opacity-100', 'translate-y-0');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => {
    dom.toast.classList.add('opacity-0', 'translate-y-4');
    setTimeout(() => dom.toast.classList.add('hidden'), 300);
  }, 2800);
}

// ============================================================================
// 3. MediaPipe 0.10.14 ESM 模型初始化 (Model Initialization with Fallback)
// ============================================================================
async function loadMediaPipeModule() {
  const cdnCandidates = [
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs",
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm",
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14"
  ];

  let lastErr = null;
  for (const url of cdnCandidates) {
    try {
      const mod = await import(url);
      if (mod && mod.FilesetResolver && mod.FaceLandmarker && mod.PoseLandmarker) {
        console.log("成功從 CDN 載入 MediaPipe 模組:", url);
        return mod;
      }
    } catch (e) {
      console.warn("嘗試載入 CDN 失敗:", url, e);
      lastErr = e;
    }
  }
  throw lastErr || new Error("無法載入 @mediapipe/tasks-vision 0.10.14 ESM 模組");
}

async function initMediaPipeVision() {
  if (AppState.faceLandmarker && AppState.poseLandmarker) return true;
  if (AppState.modelsLoadingPromise) return AppState.modelsLoadingPromise;

  AppState.modelsLoadingPromise = (async () => {
    try {
      const { FilesetResolver, FaceLandmarker, PoseLandmarker } = await loadMediaPipeModule();
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
      );

      try {
        AppState.faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
            delegate: "GPU"
          },
          runningMode: "VIDEO",
          numFaces: 1,
          outputFaceBlendshapes: true
        });

        AppState.poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
            delegate: "GPU"
          },
          runningMode: "VIDEO",
          numPoses: 1
        });
        console.log("舒呼 SootheBreath — MediaPipe Tasks Vision 0.10.14 (GPU) 模型加載成功");
      } catch (gpuErr) {
        console.warn("GPU 加速初始化失敗，自動切換至 CPU 模式:", gpuErr);
        AppState.faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
            delegate: "CPU"
          },
          runningMode: "VIDEO",
          numFaces: 1,
          outputFaceBlendshapes: true
        });

        AppState.poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
            delegate: "CPU"
          },
          runningMode: "VIDEO",
          numPoses: 1
        });
        console.log("舒呼 SootheBreath — MediaPipe Tasks Vision 0.10.14 (CPU) 模型加載成功");
      }
      return true;
    } catch (err) {
      console.error("MediaPipe 初始化失敗:", err);
      AppState.modelsLoadingPromise = null;
      return false;
    }
  })();

  return AppState.modelsLoadingPromise;
}

// ============================================================================
// 4. WebRTC 相機啟動與診斷規格 (Section 6 Camera Diagnostics)
// ============================================================================
async function startCamera(videoElement) {
  if (AppState.isDemoMode) return true;

  const isSecure = window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!isSecure) {
    showCameraDiagnosticError({ name: 'SecurityError' });
    return false;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showCameraDiagnosticError({ name: 'SecurityError' });
    return false;
  }

  const constraints = {
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: "user"
    },
    audio: false
  };

  try {
    if (AppState.stream && AppState.stream.active) {
      videoElement.srcObject = AppState.stream;
      await videoElement.play().catch(() => {});
      return true;
    }

    if (AppState.stream) {
      AppState.stream.getTracks().forEach(track => track.stop());
    }

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    AppState.stream = stream;
    videoElement.srcObject = stream;

    await new Promise((resolve) => {
      videoElement.onloadedmetadata = () => {
        videoElement.play().then(resolve).catch(resolve);
      };
    });

    return true;
  } catch (error) {
    console.error("相機啟動異常:", error);
    showCameraDiagnosticError(error);
    return false;
  }
}

function stopCamera() {
  if (AppState.stream) {
    AppState.stream.getTracks().forEach(track => track.stop());
    AppState.stream = null;
  }
}

function showCameraDiagnosticError(error) {
  let title = "相機啟動受阻";
  let desc = "瀏覽器無法正常存取視訊鏡頭硬體。";
  let stepsHtml = "";

  switch (error.name) {
    case 'SecurityError':
      title = "安全性限制 (Non-HTTPS / 本地檔案)";
      desc = "目前處於未加密的網絡環境或直接開啟本機 HTML 檔案。";
      stepsHtml = `
        <p>1. 瀏覽器安全策略規定，相機存取必須在 <b>HTTPS 加密協定</b> 或 <b>localhost</b> 下運行。</p>
        <p>2. 若在本地測試，請使用 VS Code Live Server 或在終端機執行 <code>npx serve</code>。</p>
        <p>3. 若已部署至 Vercel，請確認網址以 <code>https://</code> 開頭。</p>
      `;
      break;

    case 'NotAllowedError':
    case 'PermissionDeniedError':
      title = "鏡頭存取權限被拒 (Permission Denied)";
      desc = "你或瀏覽器設定拒絕了此網頁存取相機的權限。";
      stepsHtml = `
        <p>1. 點擊瀏覽器網址列最左側的 <b>🔒 鎖頭圖示</b> 或設定按鈕。</p>
        <p>2. 將「相機 (Camera)」設定由「封鎖」改為<b>「允許」</b>。</p>
        <p>3. <b>iPad / Mac 用家</b>：請檢查 系統設定 &gt; 私隱與安全性 &gt; 相機，確認 Safari / Chrome 已獲授權。</p>
        <p>4. <b>Windows 用家</b>：請檢查 Windows 設定 &gt; 私隱 &gt; 相機，開啟「允許桌面應用程式存取相機」。</p>
      `;
      break;

    case 'NotFoundError':
    case 'DevicesNotFoundError':
      title = "未偵測到鏡頭硬體 (Not Found)";
      desc = "系統找不到任何可用的視訊輸入裝置。";
      stepsHtml = `
        <p>1. 請檢查手提電腦 (Laptop) 鏡頭上方的<b>實體防窺撥片 (Privacy Shutter)</b> 是否已打開。</p>
        <p>2. 部分品牌電腦（如 Lenovo、ASUS、MSI）配有鍵盤相機開關快速鍵（例如 Fn + F8 或 F10）。</p>
        <p>3. 若目前裝置無鏡頭，你可點擊下方「<b>🧪 免鏡頭模擬訓練</b>」預覽完整功能。</p>
      `;
      break;

    case 'NotReadableError':
    case 'TrackStartError':
      title = "鏡頭被其他應用程式佔用 (Camera Occupied)";
      desc = "相機硬體正在被其他視訊通話或後台程式使用。";
      stepsHtml = `
        <p>1. 請檢查並先完全關閉 <b>Zoom、Microsoft Teams、Google Meet、FaceTime</b> 或其他相機軟件。</p>
        <p>2. 重新整理本網頁後再試一次，或先使用「<b>🧪 免鏡頭模擬訓練</b>」。</p>
      `;
      break;

    default:
      title = "未知相機存取錯誤 (" + (error.name || "Error") + ")";
      desc = error.message || "系統發生未預期的鏡頭存取問題。";
      stepsHtml = `<p>請嘗試重新整理瀏覽器，或點擊下方「🧪 免鏡頭模擬訓練」體驗完整呼吸節奏導引。</p>`;
      break;
  }

  dom.modalErrorTitle.textContent = title;
  dom.modalErrorDesc.textContent = desc;
  dom.modalErrorSteps.innerHTML = stepsHtml;
  dom.modalError.classList.remove('hidden');
}

// ============================================================================
// 5. 核心電腦視覺運算公式 (Section 3 Math & Upgraded Clinical Algorithms)
// ============================================================================

/**
 * 雙眼外眥間距 (Inter-ocular Distance, D_eye)
 * Face Landmark 33 (右眼外眼角) 與 263 (左眼外眼角)
 */
function calculateDEye(faceLandmarks) {
  const p33 = faceLandmarks[33];
  const p263 = faceLandmarks[263];
  return Math.hypot(p33.x - p263.x, p33.y - p263.y);
}

/**
 * 嘴唇開合長寬比 (Lip Aspect Ratio, LAR)
 * 上唇內緣中點 13、下唇內緣中點 14、左嘴角 78、右嘴角 308
 */
function calculateLAR(faceLandmarks) {
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
function extractBlendshapes(blendshapesList) {
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
function smoothShoulderLandmarksEMA(poseLandmarks, alpha = THRESHOLDS.emaAlpha) {
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
function calculateEarShoulderDistance(poseLandmarks, y11Smooth, y12Smooth) {
  const shoulderLeftY = (typeof y11Smooth === 'number') ? y11Smooth : poseLandmarks[11].y;
  const shoulderRightY = (typeof y12Smooth === 'number') ? y12Smooth : poseLandmarks[12].y;
  const earLeftY = poseLandmarks[7] ? poseLandmarks[7].y : (shoulderLeftY - 0.25);
  const earRightY = poseLandmarks[8] ? poseLandmarks[8].y : (shoulderRightY - 0.25);

  return ((shoulderLeftY - earLeftY) + (shoulderRightY - earRightY)) / 2;
}

function calculateShoulderMetrics(poseLandmarks, dEye, distBase) {
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
 * 【吸氣雙重聯合判定】
 * 吸氣階段（閉口鼻吸）必須同時滿足 LAR <= THRESHOLDS.larInhaleMax 且 jawOpen < THRESHOLDS.jawOpenInhaleMax
 */
function isNasalInhaleValid(lar, jawOpen) {
  return (lar <= THRESHOLDS.larInhaleMax) && (jawOpen < THRESHOLDS.jawOpenInhaleMax);
}

/**
 * 呼氣階段（噘唇吹氣）判定：
 * larExhaleMin <= LAR <= larExhaleMax 且 (mouthPucker >= mouthPuckerMin 或 mouthFunnel >= mouthFunnelMin)
 */
function isPlbExhaleValid(lar, mouthPucker, mouthFunnel) {
  return (
    lar >= THRESHOLDS.larExhaleMin &&
    lar <= THRESHOLDS.larExhaleMax &&
    (mouthPucker >= THRESHOLDS.mouthPuckerMin || mouthFunnel >= THRESHOLDS.mouthFunnelMin)
  );
}

/**
 * 生成模擬生物特徵點 (供免鏡頭模擬模式 Demo Mode 使用，完整支援五步校準與訓練階段)
 */
function generateSimulatedDetections(now) {
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

// ============================================================================
// 6. 廣東話語音合成導航 (Section 4 Cantonese TTS — 預設背景開啟)
// ============================================================================
function initTTS() {
  AppState.voiceEnabled = true; // 廣東話 (zh-HK) 語音導航口令預設開啟
  if (!('speechSynthesis' in window)) {
    console.warn("本瀏覽器不支援 Web Speech API");
    return;
  }

  const loadVoices = () => {
    const voices = window.speechSynthesis.getVoices();
    AppState.tts.speechSynthesisVoice =
      voices.find(v => v.lang === 'zh-HK' || v.lang === 'yue-Hant-HK') ||
      voices.find(v => v.lang.includes('HK') || v.lang.includes('yue')) ||
      voices.find(v => v.lang === 'zh-TW') ||
      voices.find(v => v.lang.startsWith('zh')) ||
      null;
  };

  loadVoices();
  window.speechSynthesis.onvoiceschanged = loadVoices;
}

function speakText(text, isImmediate = false) {
  if (!AppState.voiceEnabled || !('speechSynthesis' in window)) return;

  const now = performance.now();
  if (!isImmediate && (now - AppState.tts.lastSpokenTime < AppState.tts.cooldownMs)) {
    return;
  }

  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-HK';
    utterance.rate = 0.95;
    if (AppState.tts.speechSynthesisVoice) {
      utterance.voice = AppState.tts.speechSynthesisVoice;
    }
    window.speechSynthesis.speak(utterance);
    AppState.tts.lastSpokenTime = now;
  } catch (err) {
    console.warn("語音合成播放失敗:", err);
  }
}

// ============================================================================
// 7. 鎖定平滑過渡警示機制與防閃爍提示引擎 (Section C.4 Sticky Priority Latch)
// ============================================================================
function updateFeedbackBannerAndSpeech(priority, bannerMessage, ttsMessage = '') {
  const now = performance.now();
  const fb = AppState.feedback;

  // 若為鏡頭完全未偵測到人臉/雙肩 (P1)，最高優先處理
  if (priority === 1 && fb.currentPriority !== 1) {
    fb.currentPriority = 1;
    fb.currentPMessage = bannerMessage;
    renderBottomBanner(bannerMessage, 1);
    speakText(ttsMessage || bannerMessage);
    return;
  }

  if (bannerMessage !== fb.currentPMessage) {
    if (fb.pendingMessage !== bannerMessage) {
      fb.pendingMessage = bannerMessage;
      fb.pendingPriority = priority;
      fb.pendingTimestamp = now;
    } else if (now - fb.pendingTimestamp >= fb.debounceMs) {
      fb.currentPriority = priority;
      fb.currentPMessage = bannerMessage;
      renderBottomBanner(bannerMessage, priority);
      if (priority <= 3 && (ttsMessage || bannerMessage)) {
        speakText(ttsMessage || bannerMessage);
      }
    }
  } else {
    fb.pendingMessage = '';
    // 若持續鎖定同一低分警示且已過語音冷卻期，可定時溫和提醒
    if (priority <= 3 && (ttsMessage || bannerMessage)) {
      speakText(ttsMessage || bannerMessage, false);
    }
  }
}

function renderBottomBanner(message, priority) {
  if (AppState.currentState !== STATES.TRAINING) return;
  dom.bottomBanner.textContent = message;
  dom.bottomBanner.classList.remove('hidden');

  if (priority === 1) {
    dom.bottomBanner.className = "shrink-0 w-full py-3.5 px-6 text-center z-30 font-extrabold text-xl md:text-2xl leading-snug border-t-2 border-rose-500 bg-rose-600 text-white shadow-lg";
  } else if (priority <= 3) {
    dom.bottomBanner.className = "shrink-0 w-full py-3.5 px-6 text-center z-30 font-extrabold text-xl md:text-2xl leading-snug border-t-2 border-orange-400 bg-gradient-to-r from-rose-600 to-orange-500 text-white shadow-lg";
  } else {
    dom.bottomBanner.className = "shrink-0 w-full py-3.5 px-6 text-center z-30 font-extrabold text-xl md:text-2xl leading-snug border-t-2 border-teal-200 bg-white/95 text-[#2E7D32] shadow-md";
  }
}

/**
 * 【C.4 最低分優先與「鎖定直到回升 ≥ 70%」平滑警示機制 (Sticky Priority Latch)】
 * - 只有當某個項目百分比跌穿 70% (< 70%) 時才觸發底部橫幅與廣東話語音修正警示（未偵測到人臉/雙肩除外）。
 * - 若同時有多於一個項目低過 70%，根據「百分比分數最低」決定優先顯示。
 * - 一旦某個低分項目觸發警示，系統必須鎖定 (Latch) 該項目，中途不因其他項目波動而頻繁跳換；
 *   必須等到當前鎖定項目實時百分比回升至 >= 70% 後才解除鎖定，並平滑過渡檢查下一個 < 70% 最低分項目。
 */
function evaluateStickyPriorityFeedback(hasFaceAndPose) {
  const train = AppState.training;
  const fb = AppState.feedback;

  // 最高優先：鏡頭未偵測到完整人臉或雙肩
  if (!hasFaceAndPose) {
    updateFeedbackBannerAndSpeech(
      1,
      "請調整坐姿，確保面部及雙肩喺鏡頭框內",
      "請調整坐姿，確保面部同雙肩喺鏡頭框入面"
    );
    return;
  }

  // 開局前 10 秒緩衝期：預設顯示 100%，不觸發任何低分警示
  if (train.elapsedSeconds < INITIAL_GRACE_SECONDS) {
    fb.latchedModule = null;
    const graceMsg = train.currentPhase === PHASES.INHALE
      ? "開局緩衝準備中：請跟隨節奏閉口用鼻吸氣，保持雙肩放鬆"
      : "開局緩衝準備中：請跟隨節奏噘唇慢慢呼氣，保持雙肩放鬆";
    updateFeedbackBannerAndSpeech(5, graceMsg, "");
    return;
  }

  // 四大模組狀態與對應修正指引
  const modulesMap = {
    inhale: {
      key: 'inhale',
      label: '合口吸氣',
      pct: train.pctInhale,
      order: 2,
      bannerMsg: `【合口吸氣 ${train.pctInhale}% · 需要改善】請閉上嘴巴，用鼻慢慢吸氣`,
      ttsMsg: '請閉上嘴巴，用鼻慢慢吸氣'
    },
    exhale: {
      key: 'exhale',
      label: '噘唇呼氣',
      pct: train.pctExhale,
      order: 3,
      bannerMsg: `【噘唇呼氣 ${train.pctExhale}% · 需要改善】請將嘴唇噘起成吹蠟燭狀，慢慢吹氣出嚟`,
      ttsMsg: '請將嘴唇噘起成吹口哨狀，慢慢吹氣出嚟'
    },
    shoulder: {
      key: 'shoulder',
      label: '沉肩放鬆',
      pct: train.pctShoulder,
      order: 1,
      bannerMsg: `【沉肩放鬆 ${train.pctShoulder}% · 需要改善】偵測到聳肩用力，請保持雙肩下沉放鬆`,
      ttsMsg: '偵測到聳肩用力，請沉肩放鬆'
    },
    rr: {
      key: 'rr',
      label: '呼吸速率',
      pct: train.pctRr,
      order: 4,
      bannerMsg: `【呼吸速率 ${train.pctRr}% · 需要改善】請跟住導引節奏，保持平穩呼吸頻率`,
      ttsMsg: '請跟住導引節奏，保持平穩呼吸速度'
    }
  };

  // 1. 檢查目前已鎖定 (Latched) 之項目是否已回升至 >= 70%
  if (fb.latchedModule && modulesMap[fb.latchedModule]) {
    if (modulesMap[fb.latchedModule].pct >= 70) {
      // 已回升至 >= 70%，解除鎖定！
      fb.latchedModule = null;
    }
  }

  // 2. 若目前無鎖定項目，檢查是否有項目跌穿 70% (< 70%)，並取分數最低者鎖定
  if (!fb.latchedModule) {
    const lowModules = Object.values(modulesMap).filter(m => m.pct < 70);
    if (lowModules.length > 0) {
      lowModules.sort((a, b) => {
        if (a.pct !== b.pct) return a.pct - b.pct; // 最低分優先
        return a.order - b.order;
      });
      fb.latchedModule = lowModules[0].key;
    }
  }

  // 3. 根據鎖定狀態輸出底部橫幅與語音提示
  if (fb.latchedModule && modulesMap[fb.latchedModule]) {
    const activeWarning = modulesMap[fb.latchedModule];
    updateFeedbackBannerAndSpeech(2, activeWarning.bannerMsg, activeWarning.ttsMsg);
  } else {
    // 全部項目均 >= 70%，恢復正向鼓勵提示
    let positiveMsg = "做得好，繼續跟住節奏慢慢呼吸";
    if (train.isSoftTransitioning) {
      positiveMsg = "合格呼氣完成，平順過渡至下一次吸氣";
    } else if (train.currentPhase === PHASES.INHALE) {
      positiveMsg = "做得好，各項指標表現理想，繼續閉口用鼻吸氣";
    } else {
      positiveMsg = "噘唇嘴型與沉肩表現理想，繼續均勻慢慢呼氣";
    }
    updateFeedbackBannerAndSpeech(5, positiveMsg, "");
  }
}

// ============================================================================
// 8. 狀態一至四之生命週期 (State Machine Lifecycle)
// ============================================================================
function switchViewState(targetState) {
  if (AppState.calibTimerId) {
    clearInterval(AppState.calibTimerId);
    AppState.calibTimerId = null;
  }

  AppState.currentState = targetState;
  AppState.isPaused = false;
  AppState.isCalibConfirming = false;

  dom.stateIdle.classList.add('hidden');
  dom.stateCalib.classList.add('hidden');
  dom.stateTrain.classList.add('hidden');
  dom.stateSummary.classList.add('hidden');
  dom.bottomBanner.classList.add('hidden');

  switch (targetState) {
    case STATES.IDLE:
      dom.stateIdle.classList.remove('hidden');
      stopCamera();
      break;

    case STATES.CALIBRATING:
      dom.stateCalib.classList.remove('hidden');
      runCalibrationSequence(true);
      break;

    case STATES.TRAINING:
      dom.stateTrain.classList.remove('hidden');
      dom.bottomBanner.classList.remove('hidden');
      runTrainingSequence();
      break;

    case STATES.SUMMARY:
      dom.stateSummary.classList.remove('hidden');
      stopCamera();
      renderSummaryReport();
      break;
  }
}

// ============================================================================
// 9. 五步個人化動態基準校準系統 (Section B: 5-Step Personalized Calibration)
// ============================================================================
let calibLoopRunning = false;

async function runCalibrationSequence(resetAll = true) {
  if (AppState.calibTimerId) {
    clearInterval(AppState.calibTimerId);
    AppState.calibTimerId = null;
  }
  AppState.isCalibConfirming = false;
  AppState.ema.initialized = false;

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

function clearStepSamplesBuffer() {
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
function enterCalibrationStepWaiting(stepNum) {
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

function updateCalibrationStepperUI(stepIdx, subState) {
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
function startStep3sCountdown() {
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
function finalizeCurrentCalibrationStep(useDefaultFallback = false) {
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

function advanceToNextCalibrationStepOrSummary() {
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
function computeAndSyncDynamicThresholds() {
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

  // 3. 呼氣噘唇達標閾值 (mouthPuckerMin, mouthFunnelMin, larExhaleMin/Max)：基於【噘唇】實測值之 75%–80%
  THRESHOLDS.mouthPuckerMin = clampVal(roundTo(cal.mouthPucker_plb * 0.77, 2), 0.20, 0.70);
  THRESHOLDS.mouthFunnelMin = clampVal(roundTo(cal.mouthFunnel_plb * 0.78, 2), 0.15, 0.60);
  THRESHOLDS.larExhaleMin = clampVal(roundTo(Math.min(larClosed + 0.005, cal.LAR_plb * 0.35), 2), 0.02, 0.08);
  THRESHOLDS.larExhaleMax = clampVal(roundTo(Math.min(THRESHOLDS.larExhaleWideErr - 0.02, Math.max(cal.LAR_plb * 1.9, 0.18)), 2), 0.14, 0.35);

  // 4. 起肩代償警告閾值 (shoulderHikeWarn)：基於【放鬆膊頭】與【縮膊頭】耳肩距離差 ΔY_max 之 40%
  const dEyeSafe = Math.max(cal.D_eye, 0.08);
  const deltaYMax = Math.max(0.08, (cal.Dist_relax - cal.Dist_shrug) / dEyeSafe);
  THRESHOLDS.shoulderHikeWarn = clampVal(roundTo(deltaYMax * 0.40, 2), 0.05, 0.25);
  THRESHOLDS.shoulderHikeNormal = clampVal(roundTo(THRESHOLDS.shoulderHikeWarn * 0.83, 2), 0.04, 0.22);

  syncThresholdsToDebugDrawer();
}

function syncThresholdsToDebugDrawer() {
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
function showCalibrationConfirmation() {
  computeAndSyncDynamicThresholds();
  const cal = AppState.calibration;
  cal.subState = 'SUMMARY';
  AppState.isCalibConfirming = true;

  if (dom.calibStepWorkspace) dom.calibStepWorkspace.classList.add('hidden');
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
          <span class="text-slate-500 block">呼氣噘唇達標閾值</span>
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
function calibFrameLoop() {
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
      lar = calculateLAR(face);
      const bs = extractBlendshapes(faceResult.faceBlendshapes);
      jawOpen = bs.jawOpen;
      mouthPucker = bs.mouthPucker;
      mouthFunnel = bs.mouthFunnel;

      AppState.currentMetrics.dEye = dEye;
      AppState.currentMetrics.lar = lar;
      AppState.currentMetrics.jawOpen = jawOpen;
      AppState.currentMetrics.mouthPucker = mouthPucker;
      AppState.currentMetrics.mouthFunnel = mouthFunnel;
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

function renderCalibrationCanvas(detections) {
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

// ============================================================================
// 10. 實時訓練主迴圈與四大百分比指標 (Section C: STATE_TRAINING)
// ============================================================================
async function runTrainingSequence() {
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
  AppState.training.currentPhase = PHASES.INHALE;
  AppState.training.cycleIndex = 1;
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

function syncCanvasDimensions() {
  if (dom.visionContainer && dom.trainCanvas && AppState.privacyMode !== 'minimalist') {
    dom.trainCanvas.width = dom.visionContainer.clientWidth || 640;
    dom.trainCanvas.height = dom.visionContainer.clientHeight || 480;
  }
}

/**
 * 切換相機顯示模式 (Section A.2 全域首字母大寫命名：
 * 實時鏡像模式 Mirror Mode / 去識別化骨架網格模式 Privacy Mesh Mode / 純引導模式 Pure Guiding Mode)
 */
function applyPrivacyModeStyles() {
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
    // 純引導模式 Pure Guiding Mode：隱藏左側視訊欄，將引導圖示與提示文字全螢幕居中
    if (dom.visionContainer) {
      dom.visionContainer.className = "w-px h-px opacity-0 pointer-events-none fixed -left-[9999px] overflow-hidden";
    }
    if (dom.guidancePanel) {
      dom.guidancePanel.className = "w-full flex-1 h-full bg-[#f5fafd] flex flex-col items-center justify-between p-4 md:p-8 overflow-y-auto";
    }
    if (dom.pacerVisualArea) {
      dom.pacerVisualArea.className = "flex-1 flex flex-col items-center justify-center py-4 relative min-h-[240px] w-full max-w-xl mx-auto text-center";
    }
    if (dom.biofeedbackCardsGrid) {
      dom.biofeedbackCardsGrid.className = "w-full max-w-2xl mx-auto grid grid-cols-1 sm:grid-cols-2 gap-3";
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
function applyDisplayModeStyles() {
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

function trainingInferenceLoop() {
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
function updateLiveRespiratoryRate(now) {
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
function processFrameDetections(faceResult, poseResult, now = performance.now(), dt = 0.033) {
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

  m.dEye = calculateDEye(face);
  m.lar = calculateLAR(face);
  const blendshapes = extractBlendshapes(faceResult.faceBlendshapes);
  m.mouthPucker = blendshapes.mouthPucker;
  m.mouthFunnel = blendshapes.mouthFunnel;
  m.jawOpen = blendshapes.jawOpen;

  // EMA 雙肩平滑 + 軀幹耳肩相對基準定位 (Torso Anchoring)
  const shoulder = calculateShoulderMetrics(pose, m.dEye, cal.distBase);
  m.y11Smooth = shoulder.y11Smooth;
  m.y12Smooth = shoulder.y12Smooth;
  m.yShoulderCurr = shoulder.yShoulderCurr;
  m.distCurr = shoulder.distCurr;
  m.deltaYRelative = shoulder.deltaYRelative;
  m.deltaYShoulder = shoulder.deltaYRelative;
  m.shoulderTilt = shoulder.shoulderTilt;

  // 判定當前幀各項指標是否合格
  const isShoulderRelaxed = m.deltaYRelative <= THRESHOLDS.shoulderHikeWarn;
  const isMouthClosedInhale = isNasalInhaleValid(m.lar, m.jawOpen);
  const isPlbShapeRaw = isPlbExhaleValid(m.lar, m.mouthPucker, m.mouthFunnel);

  // 全程統計累計 (供 STATE_SUMMARY 報告使用)
  train.totalShoulderFrames++;
  train.totalShoulderTimeSec += dt;
  if (isShoulderRelaxed) {
    train.validShoulderFrames++;
    train.validShoulderTimeSec += dt;
  }

  let isCurrentExhaleValid = isPlbShapeRaw;

  if (train.currentPhase === PHASES.INHALE) {
    train.totalInhaleFrames++;
    train.totalInhaleTimeSec += dt;
    if (isMouthClosedInhale) {
      train.validInhaleFrames++;
      train.validInhaleTimeSec += dt;
      if (isShoulderRelaxed) {
        train.tInActual += dt;
      }
    }
  } else {
    // 呼氣階段 (EXHALE — 噘唇吹氣判定 + 70% 呼氣彈性容錯與柔性過渡)
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

    // 若已進入 70% 呼氣柔性過渡期，視為合格噘唇呼氣 (Section C.1 Module 2)
    isCurrentExhaleValid = isPlbShapeRaw || train.isSoftTransitioning || (isOver70Pct && isGoodPlbDuration);

    if (isCurrentExhaleValid) {
      train.validPlbExhaleFrames++;
      train.validPlbExhaleTimeSec += dt;
      train.tExActual += dt;
    }
  }

  // ==========================================================================
  // 【C.1 & C.2】最近 20 秒滾動時間窗 (Rolling Window) 與前 10 秒開局緩衝期計算
  // ==========================================================================
  const elapsedSec = train.elapsedSeconds;
  train.rollingWindow.push({
    t: elapsedSec,
    dt: dt,
    phase: train.currentPhase,
    inhaleValid: isMouthClosedInhale,
    exhaleValid: isCurrentExhaleValid,
    shoulderValid: isShoulderRelaxed
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
    let winInTotal = 0;
    let winInValid = 0;
    let winExTotal = 0;
    let winExValid = 0;
    let winShTotal = 0;
    let winShValid = 0;

    for (let i = 0; i < train.rollingWindow.length; i++) {
      const s = train.rollingWindow[i];
      winShTotal += s.dt;
      if (s.shoulderValid) winShValid += s.dt;

      if (s.phase === PHASES.INHALE) {
        winInTotal += s.dt;
        if (s.inhaleValid) winInValid += s.dt;
      } else {
        winExTotal += s.dt;
        if (s.exhaleValid) winExValid += s.dt;
      }
    }

    // 模組 1【合口吸氣】百分比
    if (winInTotal >= 0.25) {
      train.pctInhale = clampVal(Math.round((winInValid / winInTotal) * 100), 0, 100);
    }
    // 模組 2【噘唇呼氣】百分比
    if (winExTotal >= 0.25) {
      train.pctExhale = clampVal(Math.round((winExValid / winExTotal) * 100), 0, 100);
    }
    // 模組 3【沉肩放鬆】百分比
    if (winShTotal >= 0.25) {
      train.pctShoulder = clampVal(Math.round((winShValid / winShTotal) * 100), 0, 100);
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
function advanceBreathingPacer(now) {
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
    dom.pacerBall.className = "w-32 h-32 md:w-36 md:h-36 rounded-full pacer-inhale-style flex flex-col items-center justify-center text-white font-bold transition-transform duration-100";

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
    dom.pacerBall.className = "w-32 h-32 md:w-36 md:h-36 rounded-full pacer-exhale-style flex flex-col items-center justify-center text-white font-bold transition-transform duration-100";

    if (phaseElapsed >= AppState.exhaleTarget) {
      finalizeCurrentCycle(now, false);
      train.cycleIndex++;
      train.cycleStartTime = now;
      triggerPhaseSwitch(PHASES.INHALE);
    }
  }
}

function triggerPhaseSwitch(newPhase) {
  const train = AppState.training;
  train.currentPhase = newPhase;
  train.phaseStartTime = performance.now();
  train.isSoftTransitioning = false;
  train.softTransitionStartTime = 0;

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

function finalizeCurrentCycle(now = performance.now(), wasSoftTransition = false) {
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
function applyModuleCardStyle(cardEl, stateEl, pctEl, pctVal, isLatchedTarget = false) {
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

function renderIndicatorCards() {
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
function renderTrainingCanvas(faceResults, poseResults) {
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

// ============================================================================
// 11. 總結報告生成與 CSV 匯出 (Section 5 Summary & CSV Export — 維持計算全程總平均)
// ============================================================================
function renderSummaryReport() {
  const train = AppState.training;
  const totalSecs = Math.max(1, Math.round(train.elapsedSeconds));
  const completedCycles = train.cyclesHistory.length;

  const meanRR = completedCycles > 0
    ? ((completedCycles / totalSecs) * 60).toFixed(1)
    : train.avgRR.toFixed(1);

  let sumIe = 0;
  train.cyclesHistory.forEach(c => sumIe += c.achievedIe);
  const meanIe = completedCycles > 0 ? (sumIe / completedCycles).toFixed(1) : AppState.ieRatio.toFixed(1);

  const inhaleAcc = train.totalInhaleFrames > 0
    ? Math.round((train.validInhaleFrames / train.totalInhaleFrames) * 100)
    : 95;

  const plbAcc = train.totalExhaleFrames > 0
    ? Math.round((train.validPlbExhaleFrames / train.totalExhaleFrames) * 100)
    : 92;

  const shoulderAcc = train.totalShoulderFrames > 0
    ? Math.round((train.validShoulderFrames / train.totalShoulderFrames) * 100)
    : 96;

  let gradeText = "優秀 (A)";
  if (plbAcc < 70 || shoulderAcc < 70 || inhaleAcc < 70) {
    gradeText = "需加強練習 (C)";
  } else if (plbAcc < 80 || shoulderAcc < 80 || inhaleAcc < 80) {
    gradeText = "良好 (B)";
  }

  dom.sumCycles.textContent = `${completedCycles} 週期`;
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  dom.sumDuration.textContent = `總時間 ${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')} · 合口吸氣 ${inhaleAcc}%`;
  dom.sumRr.textContent = meanRR;
  dom.sumIe.textContent = `1 : ${meanIe}`;
  dom.sumPlbAcc.textContent = `${plbAcc}%`;
  dom.sumShoulderAcc.textContent = `${shoulderAcc}%`;
  dom.sumGrade.textContent = gradeText;

  speakText(`訓練完成，你共完成了${completedCycles}次呼吸週期，平均呼吸頻率為每分鐘${meanRR}次，評級為${gradeText}`, true);
  loadAndRenderLocalHistory();
}

function exportDeidentifiedCSV() {
  const train = AppState.training;
  const cal = AppState.calibration;
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 8);
  const meanRR = dom.sumRr ? dom.sumRr.textContent : train.avgRR.toFixed(1);
  const inhaleAcc = train.totalInhaleFrames > 0 ? Math.round((train.validInhaleFrames / train.totalInhaleFrames) * 100) : 95;
  const plbAcc = train.totalExhaleFrames > 0 ? Math.round((train.validPlbExhaleFrames / train.totalExhaleFrames) * 100) : 92;
  const shoulderAcc = train.totalShoulderFrames > 0 ? Math.round((train.validShoulderFrames / train.totalShoulderFrames) * 100) : 96;

  let csvContent = "data:text/csv;charset=utf-8,\uFEFF";
  csvContent += "=== 舒呼(SootheBreath) 呼吸復康訓練 (v6.0) — 匿名臨床數據報表 ===\n";
  csvContent += `訓練日期,${dateStr}\n`;
  csvContent += `訓練時間,${timeStr}\n`;
  csvContent += `總訓練秒數,${Math.round(train.elapsedSeconds)}\n`;
  csvContent += `完成循環總數,${train.cyclesHistory.length}\n`;
  csvContent += `設定目標呼吸頻率(BPM),${AppState.targetBpm}\n`;
  csvContent += `實測平均呼吸頻率(次/分),${meanRR}\n`;
  csvContent += `設定目標吸呼比,1:${AppState.ieRatio}\n`;
  csvContent += `全程合口吸氣達標率(%),${inhaleAcc}%\n`;
  csvContent += `全程噘唇呼氣達標率(%),${plbAcc}%\n`;
  csvContent += `全程沉肩放鬆達標率(%),${shoulderAcc}%\n\n`;

  csvContent += "=== 五步個人化基準校準與動態閾值 ===\n";
  csvContent += `Step1_閉嘴_LAR_closed,${cal.LAR_closed.toFixed(3)},jawOpen_closed,${cal.jawOpen_closed.toFixed(3)},D_eye,${cal.D_eye.toFixed(3)}\n`;
  csvContent += `Step2_張大口_LAR_open,${cal.LAR_open.toFixed(3)},jawOpen_open,${cal.jawOpen_open.toFixed(3)}\n`;
  csvContent += `Step3_噘唇_LAR_plb,${cal.LAR_plb.toFixed(3)},mouthPucker_plb,${cal.mouthPucker_plb.toFixed(2)},mouthFunnel_plb,${cal.mouthFunnel_plb.toFixed(2)}\n`;
  csvContent += `Step4_縮膊頭_Dist_shrug,${cal.Dist_shrug.toFixed(3)},Step5_放鬆膊頭_Dist_relax,${cal.Dist_relax.toFixed(3)},yShoulderBase,${cal.yShoulderBase.toFixed(3)}\n`;
  csvContent += `動態閾值_larInhaleMax,${THRESHOLDS.larInhaleMax.toFixed(2)},jawOpenInhaleMax,${THRESHOLDS.jawOpenInhaleMax.toFixed(2)},larExhaleWideErr,${THRESHOLDS.larExhaleWideErr.toFixed(2)},shoulderHikeWarn,${THRESHOLDS.shoulderHikeWarn.toFixed(2)}\n\n`;

  csvContent += "週期序號,實測有效吸氣時間(秒),實測噘唇呼氣時間(秒),實測I:E吸呼比,呼氣70%柔性過渡完成,單次週期呼吸頻率(次/分),累計平均呼吸頻率(次/分)\n";
  train.cyclesHistory.forEach(c => {
    const cRR = c.cycleRR ? c.cycleRR.toFixed(1) : AppState.targetBpm.toFixed(1);
    const aRR = c.avgRR ? c.avgRR.toFixed(1) : meanRR;
    const softFlag = c.softTransitionCompleted ? '是' : '否';
    csvContent += `${c.cycle},${c.tInActual.toFixed(2)},${c.tExActual.toFixed(2)},1:${c.achievedIe.toFixed(2)},${softFlag},${cRR},${aRR}\n`;
  });

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `SootheBreath_v6_Report_${dateStr}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast("📥 匿名 CSV 臨床報表已開始下載");
}

function saveSessionToLocalStorage() {
  const train = AppState.training;
  const historyKey = 'soothebreath_history_v6';
  let existing = [];
  try {
    existing = JSON.parse(
      localStorage.getItem(historyKey) ||
      localStorage.getItem('soothebreath_history_v4') ||
      localStorage.getItem('breathguide_history_v3') ||
      '[]'
    );
  } catch (e) {
    existing = [];
  }

  const record = {
    date: new Date().toLocaleString('zh-HK'),
    duration: Math.round(train.elapsedSeconds),
    cycles: train.cyclesHistory.length,
    meanRR: dom.sumRr ? dom.sumRr.textContent : train.avgRR.toFixed(1),
    plbAcc: dom.sumPlbAcc.textContent,
    shoulderAcc: dom.sumShoulderAcc.textContent,
    grade: dom.sumGrade.textContent
  };

  existing.unshift(record);
  const trimmed = existing.slice(0, 10);
  try {
    localStorage.setItem(historyKey, JSON.stringify(trimmed));
  } catch (e) {
    console.warn("localStorage 寫入受限:", e);
  }
  loadAndRenderLocalHistory();
  showToast("✅ 訓練紀錄已成功儲存至本機瀏覽器");
}

function loadAndRenderLocalHistory() {
  if (!dom.listHistory) return;
  let records = [];
  try {
    records = JSON.parse(
      localStorage.getItem('soothebreath_history_v6') ||
      localStorage.getItem('soothebreath_history_v4') ||
      localStorage.getItem('breathguide_history_v3') ||
      '[]'
    );
  } catch (e) {
    records = [];
  }

  if (records.length === 0) {
    dom.listHistory.innerHTML = `<div class="text-slate-400 py-2 text-center">暫無本地歷史紀錄（完成訓練後可點擊上方儲存）</div>`;
    return;
  }

  dom.listHistory.innerHTML = records.map((r, i) => `
    <div class="flex flex-wrap justify-between items-center bg-slate-50 px-3.5 py-2 rounded-xl border border-slate-200/80 gap-2">
      <div>
        <span class="text-[#2E7D32] font-bold">#${records.length - i}</span>
        <span class="text-slate-500 ml-2">${r.date}</span>
      </div>
      <div class="space-x-2.5 text-right">
        <span class="text-slate-700 font-medium">${r.cycles} 週期</span>
        ${r.meanRR ? `<span class="text-sky-700">RR: ${r.meanRR} 次/分</span>` : ''}
        <span class="text-teal-700">噘唇: ${r.plbAcc}</span>
        <span class="text-[#2E7D32] font-bold">${r.grade}</span>
      </div>
    </div>
  `).join('');
}

// ============================================================================
// 12. 調試面板與使用者介面監聽器 (Debug Drawer & Event Listeners)
// ============================================================================
function updateDebugReadouts() {
  const m = AppState.currentMetrics;
  if (!dom.dbgLar) return;
  dom.dbgLar.textContent = m.lar.toFixed(3);
  if (dom.dbgJaw) dom.dbgJaw.textContent = m.jawOpen.toFixed(3);
  dom.dbgPucker.textContent = m.mouthPucker.toFixed(3);
  dom.dbgFunnel.textContent = m.mouthFunnel.toFixed(3);
  dom.dbgShoulder.textContent = m.deltaYRelative.toFixed(3);
  if (dom.dbgDistEs) dom.dbgDistEs.textContent = m.distCurr.toFixed(3);
  dom.dbgDeye.textContent = m.dEye.toFixed(3);
  if (dom.dbgTilt) dom.dbgTilt.textContent = m.shoulderTilt.toFixed(3);
  if (dom.dbgRr) dom.dbgRr.textContent = `${AppState.training.avgRR.toFixed(1)} BPM (${AppState.training.pctRr}%)`;
  if (dom.dbgLatch) {
    const latchNames = {
      inhale: '合口吸氣 (<70%)',
      exhale: '噘唇呼氣 (<70%)',
      shoulder: '沉肩放鬆 (<70%)',
      rr: '呼吸速率 (<70%)'
    };
    dom.dbgLatch.textContent = AppState.feedback.latchedModule
      ? `🔒 鎖定中：${latchNames[AppState.feedback.latchedModule] || AppState.feedback.latchedModule}`
      : '✅ 無鎖定 (全部 ≥70%)';
  }
}

function openDebugDrawer() {
  dom.debugDrawer.classList.remove('translate-x-full');
  if (dom.debugBackdrop) dom.debugBackdrop.classList.remove('hidden');
}

function closeDebugDrawer() {
  dom.debugDrawer.classList.add('translate-x-full');
  if (dom.debugBackdrop) dom.debugBackdrop.classList.add('hidden');
}

/**
 * 根據設定的 BPM (20 至 5) 與吸呼比例 (1:2 或 1:3) 自動計算吸氣與呼氣秒數
 */
function updatePacingCalculationsUI() {
  const bpm = Math.max(5, Math.min(20, AppState.targetBpm));
  const ratio = AppState.ieRatio === 3 ? 3 : 2;
  const totalCycleSec = 60.0 / bpm;
  const inhaleSec = totalCycleSec / (1 + ratio);
  const exhaleSec = inhaleSec * ratio;

  AppState.inhaleTarget = inhaleSec;
  AppState.exhaleTarget = exhaleSec;

  const activeBtnCls = "flex-1 py-2.5 rounded-xl text-xs font-bold bg-[#2E7D32] text-white shadow-sm transition cursor-pointer";
  const inactiveBtnCls = "flex-1 py-2.5 rounded-xl text-xs font-semibold bg-white hover:bg-teal-50 text-slate-600 border border-slate-200 transition cursor-pointer";

  if (dom.btnRatio12) dom.btnRatio12.className = ratio === 2 ? activeBtnCls : inactiveBtnCls;
  if (dom.btnRatio13) dom.btnRatio13.className = ratio === 3 ? activeBtnCls : inactiveBtnCls;

  if (dom.labelIePreset) dom.labelIePreset.textContent = `目標 1 : ${ratio}`;
  if (dom.valTargetBpm) dom.valTargetBpm.textContent = `${bpm} BPM (次/分)`;
  if (dom.valInhaleCalc) dom.valInhaleCalc.textContent = `${inhaleSec.toFixed(1)} 秒`;
  if (dom.valExhaleCalc) dom.valExhaleCalc.textContent = `${exhaleSec.toFixed(1)} 秒`;
  if (dom.valCycleTotal) {
    dom.valCycleTotal.textContent = `單次循環總長: ${totalCycleSec.toFixed(1)} 秒 (自動換算：吸氣 ${inhaleSec.toFixed(1)}s / 呼氣 ${exhaleSec.toFixed(1)}s)`;
  }

  const mins = Math.round(AppState.totalDuration / 60);
  if (dom.valDurationMins) {
    dom.valDurationMins.textContent = `${mins} 分鐘`;
  }
}

function setupEventListeners() {
  // 1. BPM 設定滑桿 (20 至 5 BPM)
  if (dom.inputBpm) {
    dom.inputBpm.addEventListener('input', (e) => {
      AppState.targetBpm = parseInt(e.target.value, 10);
      updatePacingCalculationsUI();
    });
  }

  // 2. 吸呼比例 (僅限 1:2 或 1:3)
  if (dom.btnRatio12) {
    dom.btnRatio12.addEventListener('click', () => {
      AppState.ieRatio = 2;
      updatePacingCalculationsUI();
      showToast(`⏱️ 已切換吸呼比為 1 : 2（目標頻率 ${AppState.targetBpm} BPM）`);
    });
  }
  if (dom.btnRatio13) {
    dom.btnRatio13.addEventListener('click', () => {
      AppState.ieRatio = 3;
      updatePacingCalculationsUI();
      showToast(`⏱️ 已切換吸呼比為 1 : 3（目標頻率 ${AppState.targetBpm} BPM）`);
    });
  }

  // 3. 訓練總時長滑桿 (1 至 10 分鐘)
  if (dom.inputDuration) {
    dom.inputDuration.addEventListener('input', (e) => {
      const mins = parseInt(e.target.value, 10);
      AppState.totalDuration = mins * 60;
      if (dom.valDurationMins) dom.valDurationMins.textContent = `${mins} 分鐘`;
    });
  }

  // 4. 相機顯示模式選擇
  if (dom.selectPrivacy) {
    dom.selectPrivacy.addEventListener('change', (e) => {
      AppState.privacyMode = e.target.value;
      applyPrivacyModeStyles();
    });
  }

  if (dom.btnModeMirror) {
    dom.btnModeMirror.addEventListener('click', () => {
      AppState.privacyMode = 'mirror';
      applyPrivacyModeStyles();
    });
  }
  if (dom.btnModeMesh) {
    dom.btnModeMesh.addEventListener('click', () => {
      AppState.privacyMode = 'privacy_mesh';
      applyPrivacyModeStyles();
    });
  }
  if (dom.btnModeMinimal) {
    dom.btnModeMinimal.addEventListener('click', () => {
      AppState.privacyMode = 'minimalist';
      applyPrivacyModeStyles();
    });
  }

  // 5. 呼吸引導顯示模式：氣球模式 vs 真人示範 (男性 / 女性)
  if (dom.btnPacerBalloon) {
    dom.btnPacerBalloon.addEventListener('click', () => {
      AppState.displayMode = 'balloon';
      applyDisplayModeStyles();
    });
  }
  if (dom.btnPacerHuman) {
    dom.btnPacerHuman.addEventListener('click', () => {
      AppState.displayMode = 'human';
      applyDisplayModeStyles();
    });
  }
  if (dom.btnGenderMale) {
    dom.btnGenderMale.addEventListener('click', () => {
      AppState.humanGender = 'male';
      applyDisplayModeStyles();
    });
  }
  if (dom.btnGenderFemale) {
    dom.btnGenderFemale.addEventListener('click', () => {
      AppState.humanGender = 'female';
      applyDisplayModeStyles();
    });
  }

  // 訓練中快速切換氣球 / 男性 / 女性
  if (dom.btnTrainBalloon) {
    dom.btnTrainBalloon.addEventListener('click', () => {
      AppState.displayMode = 'balloon';
      applyDisplayModeStyles();
      showToast("🎈 已切換至氣球模式");
    });
  }
  if (dom.btnTrainMale) {
    dom.btnTrainMale.addEventListener('click', () => {
      AppState.displayMode = 'human';
      AppState.humanGender = 'male';
      applyDisplayModeStyles();
      showToast("👨 已切換至真人示範（男性）");
    });
  }
  if (dom.btnTrainFemale) {
    dom.btnTrainFemale.addEventListener('click', () => {
      AppState.displayMode = 'human';
      AppState.humanGender = 'female';
      applyDisplayModeStyles();
      showToast("👩 已切換至真人示範（女性）");
    });
  }

  // 啟動真實相機訓練 -> 進入五步個人化動態基準校準
  dom.btnStart.addEventListener('click', () => {
    AppState.isDemoMode = false;
    switchViewState(STATES.CALIBRATING);
  });

  // 啟動免鏡頭模擬預覽訓練 -> 進入五步個人化動態基準校準
  if (dom.btnStartDemo) {
    dom.btnStartDemo.addEventListener('click', () => {
      AppState.isDemoMode = true;
      showToast("🧪 已啟動免鏡頭五步校準與互動模擬模式");
      switchViewState(STATES.CALIBRATING);
    });
  }

  if (dom.btnCancelCalib) {
    dom.btnCancelCalib.addEventListener('click', () => {
      switchViewState(STATES.IDLE);
    });
  }

  // 五步校準控制按鈕監聽器 (Section B.2)
  if (dom.btnCalibConfirmStep) {
    dom.btnCalibConfirmStep.addEventListener('click', () => {
      startStep3sCountdown();
    });
  }
  if (dom.btnCalibNextStep) {
    dom.btnCalibNextStep.addEventListener('click', () => {
      advanceToNextCalibrationStepOrSummary();
    });
  }
  if (dom.btnCalibRetestStep) {
    dom.btnCalibRetestStep.addEventListener('click', () => {
      showToast(`🔄 重新採集第 ${AppState.calibration.currentStep} 步動作`);
      enterCalibrationStepWaiting(AppState.calibration.currentStep);
    });
  }
  if (dom.btnCalibPrevStep) {
    dom.btnCalibPrevStep.addEventListener('click', () => {
      if (AppState.calibration.retestSingleStepMode) {
        AppState.calibration.retestSingleStepMode = false;
        showCalibrationConfirmation();
      } else if (AppState.calibration.currentStep > 1) {
        enterCalibrationStepWaiting(AppState.calibration.currentStep - 1);
      }
    });
  }
  if (dom.btnCalibUseDefault) {
    dom.btnCalibUseDefault.addEventListener('click', () => {
      finalizeCurrentCalibrationStep(true);
    });
  }

  // 五步校準總結畫面按鈕
  if (dom.btnConfirmStart) {
    dom.btnConfirmStart.addEventListener('click', () => {
      speakText("個人化基準已鎖定，現在開始呼吸訓練", true);
      switchViewState(STATES.TRAINING);
    });
  }
  if (dom.btnRecalibrate) {
    dom.btnRecalibrate.addEventListener('click', () => {
      showToast("🔄 重新進行五步個人化基準校準");
      runCalibrationSequence(true);
    });
  }
  if (dom.btnAdjustSettings) {
    dom.btnAdjustSettings.addEventListener('click', () => {
      switchViewState(STATES.IDLE);
    });
  }

  // TRAINING 右上角「🔄 重校準」按鈕
  if (dom.btnTrainRecalibrate) {
    dom.btnTrainRecalibrate.addEventListener('click', () => {
      showToast("🔄 返回五步個人化基準校準畫面");
      switchViewState(STATES.CALIBRATING);
    });
  }

  if (dom.btnPauseTrain) {
    dom.btnPauseTrain.addEventListener('click', () => {
      if (!AppState.isPaused) {
        AppState.isPaused = true;
        AppState.pauseStartTime = performance.now();
        dom.btnPauseTrain.textContent = "▶️ 繼續訓練";
        showToast("⏸️ 訓練已暫停");
      } else {
        const pausedDuration = performance.now() - AppState.pauseStartTime;
        AppState.training.startTime += pausedDuration;
        AppState.training.phaseStartTime += pausedDuration;
        AppState.training.cycleStartTime += pausedDuration;
        AppState.training.lastFrameTime = performance.now();
        AppState.isPaused = false;
        dom.btnPauseTrain.textContent = "⏸️ 暫停訓練";
        showToast("▶️ 訓練繼續");
      }
    });
  }

  dom.btnStopEarly.addEventListener('click', () => {
    finalizeCurrentCycle();
    switchViewState(STATES.SUMMARY);
  });

  dom.btnRestart.addEventListener('click', () => {
    switchViewState(STATES.IDLE);
  });

  dom.btnExportCsv.addEventListener('click', exportDeidentifiedCSV);
  dom.btnSaveLocal.addEventListener('click', saveSessionToLocalStorage);

  dom.btnClearHistory.addEventListener('click', () => {
    try {
      localStorage.removeItem('soothebreath_history_v6');
      localStorage.removeItem('soothebreath_history_v4');
      localStorage.removeItem('breathguide_history_v3');
    } catch (e) {}
    loadAndRenderLocalHistory();
    showToast("🗑️ 已清空本機歷史紀錄");
  });

  dom.btnToggleDebug.addEventListener('click', () => {
    if (dom.debugDrawer.classList.contains('translate-x-full')) {
      openDebugDrawer();
    } else {
      closeDebugDrawer();
    }
  });

  dom.btnCloseDebug.addEventListener('click', closeDebugDrawer);
  if (dom.debugBackdrop) {
    dom.debugBackdrop.addEventListener('click', closeDebugDrawer);
  }

  // Debug Drawer 閾值滑桿雙向同步
  if (dom.dbgRangeLarInMax) {
    dom.dbgRangeLarInMax.addEventListener('input', (e) => {
      THRESHOLDS.larInhaleMax = parseFloat(e.target.value);
      dom.dbgLblLarInMax.textContent = THRESHOLDS.larInhaleMax.toFixed(2);
    });
  }

  if (dom.dbgRangeJawInMax) {
    dom.dbgRangeJawInMax.addEventListener('input', (e) => {
      THRESHOLDS.jawOpenInhaleMax = parseFloat(e.target.value);
      dom.dbgLblJawInMax.textContent = THRESHOLDS.jawOpenInhaleMax.toFixed(2);
    });
  }

  if (dom.dbgRangeLarWideErr) {
    dom.dbgRangeLarWideErr.addEventListener('input', (e) => {
      THRESHOLDS.larExhaleWideErr = parseFloat(e.target.value);
      dom.dbgLblLarWideErr.textContent = THRESHOLDS.larExhaleWideErr.toFixed(2);
    });
  }

  if (dom.dbgRangeLarExMin) {
    dom.dbgRangeLarExMin.addEventListener('input', (e) => {
      THRESHOLDS.larExhaleMin = parseFloat(e.target.value);
      dom.dbgLblLarExMin.textContent = THRESHOLDS.larExhaleMin.toFixed(2);
    });
  }

  if (dom.dbgRangeLarExMax) {
    dom.dbgRangeLarExMax.addEventListener('input', (e) => {
      THRESHOLDS.larExhaleMax = parseFloat(e.target.value);
      dom.dbgLblLarExMax.textContent = THRESHOLDS.larExhaleMax.toFixed(2);
    });
  }

  if (dom.dbgRangePuckerMin) {
    dom.dbgRangePuckerMin.addEventListener('input', (e) => {
      THRESHOLDS.mouthPuckerMin = parseFloat(e.target.value);
      dom.dbgLblPuckerMin.textContent = THRESHOLDS.mouthPuckerMin.toFixed(2);
    });
  }

  if (dom.dbgRangeFunnelMin) {
    dom.dbgRangeFunnelMin.addEventListener('input', (e) => {
      THRESHOLDS.mouthFunnelMin = parseFloat(e.target.value);
      dom.dbgLblFunnelMin.textContent = THRESHOLDS.mouthFunnelMin.toFixed(2);
    });
  }

  if (dom.dbgRangeShoulderMax) {
    dom.dbgRangeShoulderMax.addEventListener('input', (e) => {
      THRESHOLDS.shoulderHikeWarn = parseFloat(e.target.value);
      dom.dbgLblShoulderMax.textContent = THRESHOLDS.shoulderHikeWarn.toFixed(2);
    });
  }

  if (dom.btnResetThresholds) {
    dom.btnResetThresholds.addEventListener('click', () => {
      Object.assign(THRESHOLDS, DEFAULT_THRESHOLDS);
      syncThresholdsToDebugDrawer();
      showToast("🔄 已恢復預設推薦閾值");
    });
  }

  dom.btnModalClose.addEventListener('click', () => {
    dom.modalError.classList.add('hidden');
    switchViewState(STATES.IDLE);
  });

  dom.btnModalRetry.addEventListener('click', () => {
    dom.modalError.classList.add('hidden');
    AppState.isDemoMode = false;
    switchViewState(STATES.CALIBRATING);
  });

  if (dom.btnModalDemo) {
    dom.btnModalDemo.addEventListener('click', () => {
      dom.modalError.classList.add('hidden');
      AppState.isDemoMode = true;
      showToast("🧪 已切換至免鏡頭模擬訓練模式");
      switchViewState(STATES.CALIBRATING);
    });
  }
}

// ============================================================================
// 13. 程式啟動入口 (Immediate Safe Bootstrapping)
// ============================================================================
function bootstrapApp() {
  if (window.__sootheBreathBootstrapped) return;
  window.__sootheBreathBootstrapped = true;

  cacheDomElements();
  setupEventListeners();
  updatePacingCalculationsUI();
  applyDisplayModeStyles();
  syncThresholdsToDebugDrawer();
  initTTS();
  loadAndRenderLocalHistory();
  initMediaPipeVision();
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', bootstrapApp);
} else {
  bootstrapApp();
}
