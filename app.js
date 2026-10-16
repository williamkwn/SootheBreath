/**
 * 舒呼(SootheBreath) 呼吸復康訓練 — 實時呼吸視覺生物反饋系統 (PWA v4.0)
 * ESM Core Engine: MediaPipe Tasks Vision 0.10.14, 10s Calibration + Confirmation,
 * 1. 起肩代償演算法升級 (EMA 座標平滑 alpha=0.35 + 軀幹/耳肩相對基準定位 Torso Anchoring)
 * 2. 鼻口呼吸 (PLB) 吸氣雙重聯合判定 (LAR <= 0.06 且 jawOpen < 0.05)
 * 3. 呼氣階段 70% 彈性容錯與柔性過渡 (Exhalation Soft Transition)
 * 4. 雙重呼吸導引模式 (氣球節奏球 + 真人示範 男性/女性) 及廣東話 (zh-HK) 預設語音導航
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

// 預設臨床閾值 (Default Clinical Thresholds — PRD v4.0 升級版)
const THRESHOLDS = {
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

// 確保 MediaPipe 視訊時間戳嚴格遞增
let lastVideoTimestamp = 0;
function getNextTimestamp() {
  const now = Math.floor(performance.now());
  lastVideoTimestamp = Math.max(now, lastVideoTimestamp + 1);
  return lastVideoTimestamp;
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
  ieRatio: 2,                  // 目標吸呼比 1:2 或 1:3 (值為 2 或 3，不包含 1:4)
  inhaleTarget: 2.0,           // 由 BPM 與吸呼比自動計算：60 / BPM / (1 + ieRatio)
  exhaleTarget: 4.0,           // 由 BPM 與吸呼比自動計算：inhaleTarget * ieRatio
  totalDuration: 120,          // 訓練總時長秒數 (1 至 10 分鐘滑桿，預設 2 分鐘 = 120 秒)
  privacyMode: 'privacy_mesh', // 'mirror' (實時鏡像模式 Mirror mode) | 'privacy_mesh' (去識別化骨架網格模式 privacy mesh mode) | 'minimalist' (純引導模式 pure guiding mode)
  displayMode: 'balloon',      // 'balloon' | 'human'
  humanGender: 'male',         // 'male' (男性) | 'female' (女性)
  voiceEnabled: true,          // 廣東話 (zh-HK) 語音導航口令：預設開啟 (Default ON)

  // EMA 平滑濾波狀態器 (針對 Pose Landmark 11 左肩, 12 右肩)
  ema: {
    initialized: false,
    y11Prev: 0,
    y12Prev: 0
  },

  // 10秒基準校準結果 (前7秒收集基準 Dist_base，後3秒確認位置)
  calibration: {
    dEyeBase: 0.22,
    distBase: 0.30,            // 10秒校準階段記錄之耳肩垂直相對基準間距 Dist_base
    yShoulderBase: 0.68,       // 畫布參考水平線位置
    larRest: 0.04,
    samplesCount: 0,
    sumDEye: 0,
    sumDistEarShoulder: 0,
    sumYShoulder: 0,
    sumLar: 0,
    elapsedCalibSec: 0
  },

  // 實時推論變數
  currentMetrics: {
    dEye: 0.22,
    lar: 0.04,
    jawOpen: 0.01,             // Face Blendshapes: jawOpen
    mouthPucker: 0.10,
    mouthFunnel: 0.10,
    y11Smooth: 0.68,
    y12Smooth: 0.68,
    yShoulderCurr: 0.68,
    distCurr: 0.30,            // 當前耳肩垂直相對間距 Dist_curr
    deltaYRelative: 0.00,      // (Dist_base - Dist_curr) / D_eye
    deltaYShoulder: 0.00,      // 與 deltaYRelative 同步
    shoulderTilt: 0.02,
    hasFace: false,
    hasPose: false
  },

  // 訓練過程狀態機
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

    // 實時平均呼吸頻率 (Average Respiratory Rate, breaths/min)
    avgRR: 10.0,

    // 全程統計指標
    cyclesHistory: [],
    totalInhaleFrames: 0,
    validInhaleFrames: 0,
    totalExhaleFrames: 0,
    validPlbExhaleFrames: 0,
    totalShoulderFrames: 0,
    validShoulderFrames: 0
  },

  // 800ms 防閃爍與優先級提示佇列 (Debounce & Priority Queue)
  feedback: {
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

    // 10秒校準與確認機制元件 (STATE_CALIBRATING)
    calibVideo: document.getElementById('calib-video'),
    calibCanvas: document.getElementById('calib-canvas'),
    btnCancelCalib: document.getElementById('btn-cancel-calib'),
    calibCountdownOverlay: document.getElementById('calib-countdown-overlay'),
    calibStageBadge: document.getElementById('calib-stage-badge'),
    calibCountdown: document.getElementById('calib-countdown'),
    calibTitle: document.getElementById('calib-title'),
    calibSubtitle: document.getElementById('calib-subtitle'),
    calibProgressBar: document.getElementById('calib-progress-bar'),
    calibConfirmOverlay: document.getElementById('calib-confirm-overlay'),
    calibSummaryMetrics: document.getElementById('calib-summary-metrics'),
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

    // 四張實時生物反饋指示卡
    biofeedbackCardsGrid: document.getElementById('biofeedback-cards-grid'),
    cardPlb: document.getElementById('card-status-plb'),
    textPlbState: document.getElementById('text-plb-state'),
    badgePlbScore: document.getElementById('badge-plb-score'),
    cardShoulder: document.getElementById('card-status-shoulder'),
    textShoulderState: document.getElementById('text-shoulder-state'),
    badgeShoulderDelta: document.getElementById('badge-shoulder-delta'),
    cardIe: document.getElementById('card-status-ie'),
    textIeState: document.getElementById('text-ie-state'),
    badgeIeActual: document.getElementById('badge-ie-actual'),
    cardRr: document.getElementById('card-status-rr'),
    textRrState: document.getElementById('text-rr-state'),
    badgeRrActual: document.getElementById('badge-rr-actual'),

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
    dbgRangeLarInMax: document.getElementById('dbg-range-lar-in-max'),
    dbgLblLarInMax: document.getElementById('dbg-lbl-lar-in-max'),
    dbgRangeJawInMax: document.getElementById('dbg-range-jaw-in-max'),
    dbgLblJawInMax: document.getElementById('dbg-lbl-jaw-in-max'),
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
 * 【改進一：EMA 座標平滑處理】
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
 * 【改進一：軀幹/耳肩相對基準定位 (Torso Anchoring)】
 * 計算雙肩相對於頭部/耳部（Pose Landmark 7 左耳、8 右耳）的垂直相對間距：
 * Dist_ear_shoulder = ((pose[11].y - pose[7].y) + (pose[12].y - pose[8].y)) / 2
 * 並即時監控雙肩相對上升/縮頸量：
 * Delta_Y_relative = (Dist_base - Dist_curr) / D_eye
 */
function calculateEarShoulderDistance(poseLandmarks, y11Smooth, y12Smooth) {
  const shoulderLeftY = (typeof y11Smooth === 'number') ? y11Smooth : poseLandmarks[11].y;
  const shoulderRightY = (typeof y12Smooth === 'number') ? y12Smooth : poseLandmarks[12].y;
  const earLeftY = poseLandmarks[7] ? poseLandmarks[7].y : (shoulderLeftY - 0.25);
  const earRightY = poseLandmarks[8] ? poseLandmarks[8].y : (shoulderRightY - 0.25);

  // Dist_ear_shoulder = ((pose[11].y - pose[7].y) + (pose[12].y - pose[8].y)) / 2
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
 * 【改進二：「鼻口呼吸 (PLB)」吸氣雙重聯合判定】
 * 吸氣階段（閉口鼻吸）必須同時滿足 LAR <= 0.06 且 faceBlendshapes.jawOpen < 0.05
 */
function isNasalInhaleValid(lar, jawOpen) {
  return (lar <= THRESHOLDS.larInhaleMax) && (jawOpen < THRESHOLDS.jawOpenInhaleMax);
}

/**
 * 呼氣階段（噘唇吹氣）維持原 PRD 判定：
 * 0.04 <= LAR <= 0.24 且 (mouthPucker >= 0.40 或 mouthFunnel >= 0.35)
 */
function isPlbExhaleValid(lar, mouthPucker, mouthFunnel) {
  return (
    lar >= THRESHOLDS.larExhaleMin &&
    lar <= THRESHOLDS.larExhaleMax &&
    (mouthPucker >= THRESHOLDS.mouthPuckerMin || mouthFunnel >= THRESHOLDS.mouthFunnelMin)
  );
}

/**
 * 生成模擬生物特徵點 (供免鏡頭模擬模式使用)
 */
function generateSimulatedDetections(now) {
  const train = AppState.training;
  const isExhale = train.currentPhase === PHASES.EXHALE;
  const wave = Math.sin(now / 350);

  const lar = isExhale ? (0.11 + wave * 0.02) : (0.03 + Math.abs(wave) * 0.01);
  const pucker = isExhale ? (0.58 + wave * 0.08) : 0.08;
  const funnel = isExhale ? (0.48 + wave * 0.06) : 0.06;
  const jawOpen = isExhale ? 0.06 : 0.015;

  const face = [];
  for (let i = 0; i < 468; i++) {
    face.push({ x: 0.5, y: 0.42, z: 0 });
  }
  face[33] = { x: 0.41, y: 0.36 };
  face[263] = { x: 0.59, y: 0.36 };
  face[78] = { x: 0.45, y: 0.49 };
  face[308] = { x: 0.55, y: 0.49 };
  face[13] = { x: 0.50, y: 0.49 - (lar * 0.05) };
  face[14] = { x: 0.50, y: 0.49 + (lar * 0.05) };

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
  const breathShift = isExhale ? 0.002 : -0.002;
  pose[7] = { x: 0.42, y: 0.42 };  // 左耳 Landmark 7
  pose[8] = { x: 0.58, y: 0.42 };  // 右耳 Landmark 8
  pose[11] = { x: 0.30, y: 0.72 + breathShift }; // 左肩 Landmark 11
  pose[12] = { x: 0.70, y: 0.72 + breathShift }; // 右肩 Landmark 12

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
// 6. 廣東話語音合成導航 (Section 4 Cantonese TTS — 預設開啟)
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

function speakText(text, isPhaseSwitch = false) {
  if (!AppState.voiceEnabled || !('speechSynthesis' in window)) return;

  const now = performance.now();
  if (!isPhaseSwitch && (now - AppState.tts.lastSpokenTime < AppState.tts.cooldownMs)) {
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
// 7. 防閃爍提示佇列引擎 (Section 4 Priority Feedback Queue)
// ============================================================================
function updateFeedbackQueue(priority, message) {
  const now = performance.now();
  const fb = AppState.feedback;

  if (priority < fb.currentPriority) {
    fb.currentPriority = priority;
    fb.currentPMessage = message;
    renderBottomBanner(message, priority);
    speakText(message);
    return;
  }

  if (message !== fb.currentPMessage) {
    if (fb.pendingMessage !== message) {
      fb.pendingMessage = message;
      fb.pendingPriority = priority;
      fb.pendingTimestamp = now;
    } else if (now - fb.pendingTimestamp >= fb.debounceMs) {
      fb.currentPriority = priority;
      fb.currentPMessage = message;
      renderBottomBanner(message, priority);
      if (priority <= 3) {
        speakText(message);
      }
    }
  } else {
    fb.pendingMessage = '';
  }
}

function renderBottomBanner(message, priority) {
  if (AppState.currentState !== STATES.TRAINING) return;
  dom.bottomBanner.textContent = message;
  dom.bottomBanner.classList.remove('hidden');

  if (priority <= 2) {
    dom.bottomBanner.className = "shrink-0 w-full py-3.5 px-6 text-center z-30 font-extrabold text-xl md:text-2xl leading-snug border-t-2 border-rose-400 bg-rose-600 text-white shadow-lg";
  } else if (priority <= 4) {
    dom.bottomBanner.className = "shrink-0 w-full py-3.5 px-6 text-center z-30 font-extrabold text-xl md:text-2xl leading-snug border-t-2 border-amber-400 bg-amber-500 text-white shadow-lg";
  } else {
    dom.bottomBanner.className = "shrink-0 w-full py-3.5 px-6 text-center z-30 font-extrabold text-xl md:text-2xl leading-snug border-t-2 border-teal-200 bg-white/95 text-[#2E7D32] shadow-md";
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
      runCalibrationSequence();
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

// ----------------------------------------------------------------------------
// 10 秒坐姿基準校準 + 確認機制 (前7秒收集基準 Dist_base，後3秒顯示「請確認位置」)
// ----------------------------------------------------------------------------
async function runCalibrationSequence() {
  if (AppState.calibTimerId) {
    clearInterval(AppState.calibTimerId);
    AppState.calibTimerId = null;
  }
  AppState.isCalibConfirming = false;
  AppState.ema.initialized = false;

  if (dom.calibCountdownOverlay) dom.calibCountdownOverlay.classList.remove('hidden');
  if (dom.calibConfirmOverlay) dom.calibConfirmOverlay.classList.add('hidden');

  dom.calibCountdown.textContent = "準備中";
  if (dom.calibStageBadge) {
    dom.calibStageBadge.textContent = "步驟 1/2：收集基準坐姿 (前 7 秒)";
    dom.calibStageBadge.className = "inline-flex items-center gap-1.5 px-3.5 py-1 rounded-full text-xs font-bold bg-[#4DB6AC]/20 text-teal-800 border border-[#4DB6AC]/40";
  }
  if (dom.calibTitle) dom.calibTitle.textContent = "請自然坐直、沉肩放鬆、閉上嘴巴";
  if (dom.calibSubtitle) dom.calibSubtitle.textContent = "正在啟動鏡頭並準備收集 7 秒耳肩相對基準間距 (Dist_base)...";
  if (dom.calibProgressBar) dom.calibProgressBar.style.width = "0%";

  const started = await startCamera(dom.calibVideo);
  if (!started) {
    switchViewState(STATES.IDLE);
    return;
  }

  if (!AppState.isDemoMode && (!AppState.faceLandmarker || !AppState.poseLandmarker)) {
    dom.calibCountdown.textContent = "AI 載入中";
    await initMediaPipeVision();
  }

  // 重置校準累計器
  AppState.calibration = {
    dEyeBase: 0.22,
    distBase: 0.30,
    yShoulderBase: 0.72,
    larRest: 0.04,
    samplesCount: 0,
    sumDEye: 0,
    sumDistEarShoulder: 0,
    sumYShoulder: 0,
    sumLar: 0,
    elapsedCalibSec: 0
  };

  speakText("請自然坐直、沉肩放鬆、閉上嘴巴，正在記錄基準坐姿", true);

  const totalCalibSeconds = 10;
  let secondsRemaining = totalCalibSeconds;
  dom.calibCountdown.textContent = secondsRemaining;
  if (dom.calibSubtitle) {
    dom.calibSubtitle.textContent = "前 7 秒：正在記錄雙眼間距 (D_eye) 與耳肩相對基準間距 (Dist_base)...";
  }

  AppState.calibTimerId = setInterval(() => {
    if (AppState.currentState !== STATES.CALIBRATING) {
      clearInterval(AppState.calibTimerId);
      AppState.calibTimerId = null;
      return;
    }

    secondsRemaining--;
    const elapsed = totalCalibSeconds - secondsRemaining;
    AppState.calibration.elapsedCalibSec = elapsed;

    if (dom.calibProgressBar) {
      dom.calibProgressBar.style.width = `${Math.min(100, (elapsed / totalCalibSeconds) * 100)}%`;
    }

    if (secondsRemaining > 3) {
      dom.calibCountdown.textContent = secondsRemaining;
      if (dom.calibStageBadge) {
        dom.calibStageBadge.textContent = `步驟 1/2：收集基準坐姿 (剩餘 ${secondsRemaining - 3} 秒)`;
      }
      if (dom.calibTitle) dom.calibTitle.textContent = "請自然坐直、沉肩放鬆、閉上嘴巴";
      if (dom.calibSubtitle) dom.calibSubtitle.textContent = "正在記錄雙眼間距 (D_eye) 與耳肩相對基準間距 (Dist_base)...";
    } else if (secondsRemaining > 0) {
      dom.calibCountdown.textContent = secondsRemaining;
      if (secondsRemaining === 3) {
        lockBaselineFromSamples();
        speakText("請確認位置", true);
      }
      if (dom.calibStageBadge) {
        dom.calibStageBadge.textContent = "步驟 2/2：位置確認階段 (後 3 秒)";
        dom.calibStageBadge.className = "inline-flex items-center gap-1.5 px-3.5 py-1 rounded-full text-xs font-bold bg-[#FF7043]/20 text-[#d84315] border border-[#FF7043]/40";
      }
      if (dom.calibTitle) dom.calibTitle.textContent = "請確認位置";
      if (dom.calibSubtitle) dom.calibSubtitle.textContent = "基準已鎖定，請保持面部及雙肩對齊於綠色參考框內...";
    } else {
      clearInterval(AppState.calibTimerId);
      AppState.calibTimerId = null;
      showCalibrationConfirmation();
    }
  }, 1000);

  function calibFrameLoop() {
    if (AppState.currentState !== STATES.CALIBRATING) return;

    const isCollectingPhase = !AppState.isCalibConfirming && (AppState.calibration.elapsedCalibSec < 7);

    if (AppState.isDemoMode) {
      const sim = generateSimulatedDetections(performance.now());
      if (isCollectingPhase) {
        const face = sim.faceResult.faceLandmarks[0];
        const pose = sim.poseResult.landmarks[0];
        const { y11Smooth, y12Smooth, yShoulderSmooth } = smoothShoulderLandmarksEMA(pose, THRESHOLDS.emaAlpha);
        const distEarShoulder = calculateEarShoulderDistance(pose, y11Smooth, y12Smooth);
        AppState.calibration.sumDEye += calculateDEye(face);
        AppState.calibration.sumLar += calculateLAR(face);
        AppState.calibration.sumDistEarShoulder += distEarShoulder;
        AppState.calibration.sumYShoulder += yShoulderSmooth;
        AppState.calibration.samplesCount++;
      }
      renderCalibrationCanvas(sim);
    } else if (dom.calibVideo.readyState >= 2 && AppState.faceLandmarker && AppState.poseLandmarker) {
      try {
        const ts = getNextTimestamp();
        const faceResult = AppState.faceLandmarker.detectForVideo(dom.calibVideo, ts);
        const poseResult = AppState.poseLandmarker.detectForVideo(dom.calibVideo, ts);

        if (faceResult.faceLandmarks && faceResult.faceLandmarks.length > 0 &&
            poseResult.landmarks && poseResult.landmarks.length > 0) {
          const face = faceResult.faceLandmarks[0];
          const pose = poseResult.landmarks[0];

          const { y11Smooth, y12Smooth, yShoulderSmooth } = smoothShoulderLandmarksEMA(pose, THRESHOLDS.emaAlpha);
          const distEarShoulder = calculateEarShoulderDistance(pose, y11Smooth, y12Smooth);

          if (isCollectingPhase) {
            const dEye = calculateDEye(face);
            const lar = calculateLAR(face);

            AppState.calibration.sumDEye += dEye;
            AppState.calibration.sumLar += lar;
            AppState.calibration.sumDistEarShoulder += distEarShoulder;
            AppState.calibration.sumYShoulder += yShoulderSmooth;
            AppState.calibration.samplesCount++;
          }
        }
        renderCalibrationCanvas({ faceResult, poseResult });
      } catch (e) {
        console.warn("校準幀運算略過:", e);
      }
    }
    requestAnimationFrame(calibFrameLoop);
  }
  requestAnimationFrame(calibFrameLoop);
}

function lockBaselineFromSamples() {
  const c = AppState.calibration;
  if (c.samplesCount > 5) {
    c.dEyeBase = c.sumDEye / c.samplesCount;
    c.larRest = c.sumLar / c.samplesCount;
    c.distBase = c.sumDistEarShoulder / c.samplesCount;
    c.yShoulderBase = c.sumYShoulder / c.samplesCount;
  } else {
    c.dEyeBase = 0.20;
    c.larRest = 0.04;
    c.distBase = 0.30;
    c.yShoulderBase = 0.72;
  }
}

function showCalibrationConfirmation() {
  lockBaselineFromSamples();
  AppState.isCalibConfirming = true;

  if (dom.calibCountdownOverlay) dom.calibCountdownOverlay.classList.add('hidden');
  if (dom.calibConfirmOverlay) dom.calibConfirmOverlay.classList.remove('hidden');

  const c = AppState.calibration;
  if (dom.calibSummaryMetrics) {
    dom.calibSummaryMetrics.textContent = `已收集 ${c.samplesCount} 幀基準 · D_eye: ${c.dEyeBase.toFixed(2)} · 耳肩基準 Dist_base: ${c.distBase.toFixed(2)} · 閉口 LAR: ${c.larRest.toFixed(2)}`;
  }

  speakText("請確認位置，準備好可以點擊確認並開始訓練", true);
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
      ctx.strokeStyle = 'rgba(77, 182, 172, 0.55)';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(p7.x, p7.y);
      ctx.lineTo(p11.x, p11.y);
      ctx.moveTo(p8.x, p8.y);
      ctx.lineTo(p12.x, p12.y);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.strokeStyle = '#4DB6AC';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(p11.x, p11.y);
    ctx.lineTo(p12.x, p12.y);
    ctx.stroke();
    ctx.fillStyle = '#4DB6AC';
    ctx.beginPath();
    ctx.arc(p11.x, p11.y, 6, 0, Math.PI * 2);
    ctx.arc(p12.x, p12.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  if (faceResult && faceResult.faceLandmarks && faceResult.faceLandmarks.length > 0) {
    const face = faceResult.faceLandmarks[0];
    const lipPoints = [78, 13, 308, 14].map(idx => ({
      x: face[idx].x * w,
      y: face[idx].y * h
    }));
    ctx.save();
    ctx.strokeStyle = '#4DB6AC';
    ctx.lineWidth = 3;
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

// ----------------------------------------------------------------------------
// 實時訓練主迴圈 (Section 5 TRAINING State)
// ----------------------------------------------------------------------------
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
  AppState.training.totalInhaleFrames = 0;
  AppState.training.validInhaleFrames = 0;
  AppState.training.totalExhaleFrames = 0;
  AppState.training.validPlbExhaleFrames = 0;
  AppState.training.totalShoulderFrames = 0;
  AppState.training.validShoulderFrames = 0;

  if (dom.btnPauseTrain) {
    dom.btnPauseTrain.textContent = "⏸️ 暫停訓練";
  }

  applyPrivacyModeStyles();
  applyDisplayModeStyles();
  syncCanvasDimensions();
  window.addEventListener('resize', syncCanvasDimensions);

  triggerPhaseSwitch(PHASES.INHALE);
  updateLiveRespiratoryRate(now);

  requestAnimationFrame(trainingInferenceLoop);
}

function syncCanvasDimensions() {
  if (dom.visionContainer && dom.trainCanvas && AppState.privacyMode !== 'minimalist') {
    dom.trainCanvas.width = dom.visionContainer.clientWidth || 640;
    dom.trainCanvas.height = dom.visionContainer.clientHeight || 480;
  }
}

/**
 * 切換相機顯示模式 (實時鏡像模式 Mirror mode / 去識別化骨架網格模式 privacy mesh mode / 純引導模式 pure guiding mode)
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
    // 純引導模式 pure guiding mode：隱藏左側視訊欄，將引導圖示與提示文字全螢幕居中
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
    // 雙欄模式：實時鏡像模式 Mirror mode / 去識別化骨架網格模式 privacy mesh mode
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
      dom.badgeMeshMode.textContent = "🔒 去識別化骨架網格模式 privacy mesh mode";
      dom.badgeMeshMode.classList.remove('hidden');
    } else {
      dom.trainVideo.style.opacity = AppState.isDemoMode ? '0' : '1';
      dom.trainCanvas.style.opacity = '1';
      dom.trainCanvas.classList.remove('privacy-mesh-canvas');
      dom.badgeMeshMode.textContent = "📷 實時鏡像模式 Mirror mode";
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

  // 1. 取得視訊推論或模擬特徵點
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

  // 2. 呼吸節奏狀態機推進 (包含呼氣 70% 柔性過渡)
  advanceBreathingPacer(now);

  // 3. 即時更新平均呼吸頻率
  updateLiveRespiratoryRate(now);

  // 4. 繪製視覺 Canvas 覆蓋層
  renderTrainingCanvas(AppState.lastFaceResult, AppState.lastPoseResult);

  // 5. 更新調試面板讀數
  updateDebugReadouts();

  requestAnimationFrame(trainingInferenceLoop);
}

// ----------------------------------------------------------------------------
// 實時平均呼吸頻率計算與回饋 (Average Respiratory Rate)
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
    const totalCompletedDuration = train.cyclesHistory.reduce((acc, c) => acc + (c.cycleDuration || targetCycleSec), 0);
    const meanCompletedRR = (train.cyclesHistory.length / Math.max(1, totalCompletedDuration)) * 60;
    const sessionRR = ((train.cyclesHistory.length + currentCycleProgress) / elapsedSec) * 60;
    liveAvgRR = (meanCompletedRR * 0.5) + (sessionRR * 0.5);
  } else if (elapsedSec >= 1.5) {
    liveAvgRR = ((currentCycleProgress) / elapsedSec) * 60;
  }

  train.avgRR = liveAvgRR;
  const rrFormatted = liveAvgRR.toFixed(1);

  if (dom.valLiveRr) {
    dom.valLiveRr.textContent = rrFormatted;
  }
  if (dom.badgeRrActual) {
    dom.badgeRrActual.textContent = `${rrFormatted} 次/分`;
  }
  if (dom.textRrState && dom.cardRr) {
    const diff = Math.abs(liveAvgRR - targetRR);
    if (liveAvgRR > 20) {
      dom.textRrState.textContent = `${rrFormatted} BPM (呼吸偏快，請放慢)`;
      dom.textRrState.className = "text-xs md:text-sm font-bold text-amber-600";
      dom.cardRr.className = "p-3 rounded-2xl bg-amber-50/90 border border-amber-300 flex items-center justify-between transition-all shadow-sm";
    } else if (diff <= 2.5) {
      dom.textRrState.textContent = `${rrFormatted} BPM (目標 ${targetRR} 達標)`;
      dom.textRrState.className = "text-xs md:text-sm font-bold text-[#2E7D32]";
      dom.cardRr.className = "p-3 rounded-2xl bg-emerald-50/80 border border-emerald-200 flex items-center justify-between transition-all shadow-sm";
    } else {
      dom.textRrState.textContent = `${rrFormatted} BPM (目標 ${targetRR})`;
      dom.textRrState.className = "text-xs md:text-sm font-bold text-teal-700";
      dom.cardRr.className = "p-3 rounded-2xl bg-white border border-slate-200 flex items-center justify-between transition-all shadow-sm";
    }
  }
}

// ----------------------------------------------------------------------------
// 逐幀特徵點運算與臨床規則評估 (Upgraded Frame Processing & Clinical Rules)
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
    updateFeedbackQueue(1, "請調整坐姿，確保面部及雙肩喺鏡頭框內");
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

  // 【改進一】EMA 雙肩平滑 + 軀幹耳肩相對基準定位 (Torso Anchoring)
  const shoulder = calculateShoulderMetrics(pose, m.dEye, cal.distBase);
  m.y11Smooth = shoulder.y11Smooth;
  m.y12Smooth = shoulder.y12Smooth;
  m.yShoulderCurr = shoulder.yShoulderCurr;
  m.distCurr = shoulder.distCurr;
  m.deltaYRelative = shoulder.deltaYRelative;
  m.deltaYShoulder = shoulder.deltaYRelative;
  m.shoulderTilt = shoulder.shoulderTilt;

  train.totalShoulderFrames++;
  const isShoulderRelaxed = m.deltaYRelative <= THRESHOLDS.shoulderHikeWarn;
  if (isShoulderRelaxed) {
    train.validShoulderFrames++;
  }

  if (train.currentPhase === PHASES.INHALE) {
    // 【改進二】吸氣階段（閉口鼻吸）雙重聯合檢驗：LAR <= 0.06 且 jawOpen < 0.05
    train.totalInhaleFrames++;
    const isMouthClosed = isNasalInhaleValid(m.lar, m.jawOpen);

    if (isMouthClosed && isShoulderRelaxed) {
      train.validInhaleFrames++;
      train.tInActual += dt;
    }

    if (m.deltaYRelative > THRESHOLDS.shoulderHikeWarn) {
      updateFeedbackQueue(2, "偵測到聳肩用力，請沉肩放鬆");
    } else if (!isMouthClosed && (m.lar > THRESHOLDS.larInhaleMax || m.jawOpen >= THRESHOLDS.jawOpenInhaleMax)) {
      updateFeedbackQueue(3, "請閉上嘴巴，用鼻慢慢吸氣");
    } else {
      updateFeedbackQueue(5, "做得好，用鼻吸氣，沉肩放鬆");
    }

  } else {
    // 呼氣階段 (EXHALE — 噘唇吹氣判定 + 70% 呼氣彈性容錯與柔性過渡)
    train.totalExhaleFrames++;
    const isPlbShape = isPlbExhaleValid(m.lar, m.mouthPucker, m.mouthFunnel);

    if (isPlbShape) {
      train.validPlbExhaleFrames++;
      train.tExActual += dt;
    }

    const phaseElapsed = (now - train.phaseStartTime) / 1000;
    const isOver70Pct = phaseElapsed >= (AppState.exhaleTarget * THRESHOLDS.earlyExhaleRatio);
    const isGoodPlbDuration = train.tExActual >= (phaseElapsed * 0.50);
    const isLipsNaturallyRelaxed = (m.lar < THRESHOLDS.larExhaleMin) || (m.mouthPucker < THRESHOLDS.puckerClosedErrMax);

    // 【改進三】呼氣階段彈性容錯與柔性過渡 (Exhalation Soft Transition)
    if (isOver70Pct && isGoodPlbDuration && isLipsNaturallyRelaxed) {
      if (!train.isSoftTransitioning) {
        train.isSoftTransitioning = true;
        train.softTransitionStartTime = now;
        const currentProgress = Math.min(1, phaseElapsed / AppState.exhaleTarget);
        train.softTransitionStartScale = 1.30 - (currentProgress * 0.45);
      }
      // 判定該週期為「合格呼氣完成」，不得觸發「提早中斷呼氣」錯誤警示
      updateFeedbackQueue(5, "合格呼氣完成，平順過渡至下一次吸氣");
    } else if (!train.isSoftTransitioning) {
      if (m.deltaYRelative > THRESHOLDS.shoulderHikeWarn) {
        updateFeedbackQueue(2, "呼氣時請保持雙肩放鬆，切勿聳肩");
      } else if (m.lar > THRESHOLDS.larExhaleWideErr && m.mouthPucker < THRESHOLDS.puckerWideErrMax) {
        updateFeedbackQueue(3, "請將嘴唇噘起成吹口哨狀，唔好張大口呼氣");
      } else if (!isOver70Pct && m.lar < THRESHOLDS.larExhaleClosedErr && m.mouthPucker < THRESHOLDS.puckerClosedErrMax) {
        updateFeedbackQueue(3, "請微微噘起嘴唇，慢慢吹氣出嚟");
      } else if (!isOver70Pct && phaseElapsed > (AppState.exhaleTarget * 0.5) && train.tExActual < (phaseElapsed * 0.5)) {
        updateFeedbackQueue(4, "呼氣太快完喇，試下跟住圓圈慢慢吹長啲氣");
      } else {
        updateFeedbackQueue(5, "噘唇嘴型很好，繼續慢慢吹長氣");
      }
    }
  }

  renderIndicatorCards(isShoulderRelaxed);
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

      // 真人示範照片同步提前淡入吸氣預備態
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

    // 僅在未達 70% 柔性完成門檻且有效噘唇時間不足時，才提示提早中斷呼氣警示
    const isOver70Pct = phaseElapsed >= (AppState.exhaleTarget * THRESHOLDS.earlyExhaleRatio);
    if (!isOver70Pct && phaseElapsed > (AppState.exhaleTarget * 0.5) && train.tExActual < (phaseElapsed * 0.5)) {
      updateFeedbackQueue(4, "呼氣太快完喇，試下跟住圓圈慢慢吹長啲氣");
    }

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

  dom.badgeIeActual.textContent = `1 : ${achievedIeRatio.toFixed(1)}`;
  dom.textIeState.textContent = wasSoftTransition
    ? `1 : ${achievedIeRatio.toFixed(1)} (合格呼氣柔性完成)`
    : `1 : ${achievedIeRatio.toFixed(1)} (目標 1:${AppState.ieRatio})`;

  train.tInActual = 0;
  train.tExActual = 0;
}

// ----------------------------------------------------------------------------
// 實時指示卡渲染 (Indicator Cards — 輕柔高對比配色)
// ----------------------------------------------------------------------------
function renderIndicatorCards(isShoulderRelaxed) {
  const m = AppState.currentMetrics;
  const train = AppState.training;

  dom.badgePlbScore.textContent = `LAR:${m.lar.toFixed(2)} | Jaw:${m.jawOpen.toFixed(2)}`;
  if (train.currentPhase === PHASES.INHALE) {
    if (isNasalInhaleValid(m.lar, m.jawOpen)) {
      dom.textPlbState.textContent = "閉口鼻吸 (雙重達標)";
      dom.textPlbState.className = "text-xs md:text-sm font-bold text-[#2E7D32]";
      dom.cardPlb.className = "p-3 rounded-2xl bg-emerald-50/80 border border-emerald-200 flex items-center justify-between transition-all shadow-sm";
    } else {
      dom.textPlbState.textContent = "吸氣微張/下頜下垂 (需閉口)";
      dom.textPlbState.className = "text-xs md:text-sm font-bold text-rose-600";
      dom.cardPlb.className = "p-3 rounded-2xl bg-rose-50/90 border border-rose-300 flex items-center justify-between transition-all shadow-sm";
    }
  } else {
    const isPlb = isPlbExhaleValid(m.lar, m.mouthPucker, m.mouthFunnel);
    if (train.isSoftTransitioning) {
      dom.textPlbState.textContent = "合格呼氣完成 (柔性過渡)";
      dom.textPlbState.className = "text-xs md:text-sm font-bold text-[#2E7D32]";
      dom.cardPlb.className = "p-3 rounded-2xl bg-emerald-50/80 border border-emerald-200 flex items-center justify-between transition-all shadow-sm";
    } else if (isPlb) {
      dom.textPlbState.textContent = "噘唇吹氣 (達標)";
      dom.textPlbState.className = "text-xs md:text-sm font-bold text-[#2E7D32]";
      dom.cardPlb.className = "p-3 rounded-2xl bg-emerald-50/80 border border-emerald-200 flex items-center justify-between transition-all shadow-sm";
    } else {
      dom.textPlbState.textContent = "未形成噘唇吹氣";
      dom.textPlbState.className = "text-xs md:text-sm font-bold text-amber-600";
      dom.cardPlb.className = "p-3 rounded-2xl bg-amber-50/90 border border-amber-300 flex items-center justify-between transition-all shadow-sm";
    }
  }

  dom.badgeShoulderDelta.textContent = `ΔY_rel: ${m.deltaYRelative >= 0 ? '+' : ''}${m.deltaYRelative.toFixed(2)}`;
  if (isShoulderRelaxed) {
    dom.textShoulderState.textContent = "耳肩距離穩定 (放鬆沉肩)";
    dom.textShoulderState.className = "text-xs md:text-sm font-bold text-[#2E7D32]";
    dom.cardShoulder.className = "p-3 rounded-2xl bg-white border border-slate-200 flex items-center justify-between transition-all shadow-sm";
    dom.cardShoulder.classList.remove('shoulder-alert-active');
  } else {
    dom.textShoulderState.textContent = "偵測到起肩代償";
    dom.textShoulderState.className = "text-xs md:text-sm font-bold text-rose-600";
    dom.cardShoulder.className = "p-3 rounded-2xl bg-rose-50 border border-rose-500 flex items-center justify-between shoulder-alert-active transition-all shadow-sm";
  }
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

// ----------------------------------------------------------------------------
// 9. 總結報告生成與 CSV 匯出 (Section 5 Summary & CSV Export)
// ----------------------------------------------------------------------------
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

  const plbAcc = train.totalExhaleFrames > 0
    ? Math.round((train.validPlbExhaleFrames / train.totalExhaleFrames) * 100)
    : 92;

  const shoulderAcc = train.totalShoulderFrames > 0
    ? Math.round((train.validShoulderFrames / train.totalShoulderFrames) * 100)
    : 96;

  let gradeText = "優秀 (A)";
  if (plbAcc < 70 || shoulderAcc < 75) {
    gradeText = "需加強練習 (C)";
  } else if (plbAcc < 85 || shoulderAcc < 85) {
    gradeText = "良好 (B)";
  }

  dom.sumCycles.textContent = `${completedCycles} 週期`;
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  dom.sumDuration.textContent = `總時間 ${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
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
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 8);
  const meanRR = dom.sumRr ? dom.sumRr.textContent : train.avgRR.toFixed(1);

  let csvContent = "data:text/csv;charset=utf-8,\uFEFF";
  csvContent += "=== 舒呼(SootheBreath) 呼吸復康訓練 — 匿名臨床數據報表 ===\n";
  csvContent += `訓練日期,${dateStr}\n`;
  csvContent += `訓練時間,${timeStr}\n`;
  csvContent += `總訓練秒數,${Math.round(train.elapsedSeconds)}\n`;
  csvContent += `完成循環總數,${train.cyclesHistory.length}\n`;
  csvContent += `設定目標呼吸頻率(BPM),${AppState.targetBpm}\n`;
  csvContent += `實測平均呼吸頻率(次/分),${meanRR}\n`;
  csvContent += `設定目標吸呼比,1:${AppState.ieRatio}\n\n`;

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
  link.setAttribute("download", `SootheBreath_Report_${dateStr}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast("📥 匿名 CSV 臨床報表已開始下載");
}

function saveSessionToLocalStorage() {
  const train = AppState.training;
  const historyKey = 'soothebreath_history_v4';
  let existing = [];
  try {
    existing = JSON.parse(localStorage.getItem(historyKey) || localStorage.getItem('breathguide_history_v3') || '[]');
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
    records = JSON.parse(localStorage.getItem('soothebreath_history_v4') || localStorage.getItem('breathguide_history_v3') || '[]');
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

// ----------------------------------------------------------------------------
// 10. 調試面板與使用者介面監聽器 (Debug Drawer & Event Listeners)
// ----------------------------------------------------------------------------
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
  if (dom.dbgRr) dom.dbgRr.textContent = AppState.training.avgRR.toFixed(1) + " BPM";
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

  // 3. 訓練總時長滑桿 (1 至 10 分鐘，已移至目標吸呼時間與呼吸頻率面板)
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

  // 啟動真實相機訓練 -> 進入 10 秒校準
  dom.btnStart.addEventListener('click', () => {
    AppState.isDemoMode = false;
    switchViewState(STATES.CALIBRATING);
  });

  // 啟動免鏡頭模擬預覽訓練 -> 進入 10 秒校準
  if (dom.btnStartDemo) {
    dom.btnStartDemo.addEventListener('click', () => {
      AppState.isDemoMode = true;
      showToast("🧪 已啟動免鏡頭互動模擬模式");
      switchViewState(STATES.CALIBRATING);
    });
  }

  if (dom.btnCancelCalib) {
    dom.btnCancelCalib.addEventListener('click', () => {
      switchViewState(STATES.IDLE);
    });
  }

  // 10秒校準結束後的確認畫面三顆按鈕
  if (dom.btnConfirmStart) {
    dom.btnConfirmStart.addEventListener('click', () => {
      speakText("現在開始呼吸訓練", true);
      switchViewState(STATES.TRAINING);
    });
  }
  if (dom.btnRecalibrate) {
    dom.btnRecalibrate.addEventListener('click', () => {
      showToast("🔄 重新進行 10 秒基準校準");
      runCalibrationSequence();
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
      showToast("🔄 返回 10 秒基準校準畫面");
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

  dom.dbgRangeLarInMax.addEventListener('input', (e) => {
    THRESHOLDS.larInhaleMax = parseFloat(e.target.value);
    dom.dbgLblLarInMax.textContent = THRESHOLDS.larInhaleMax.toFixed(2);
  });

  if (dom.dbgRangeJawInMax) {
    dom.dbgRangeJawInMax.addEventListener('input', (e) => {
      THRESHOLDS.jawOpenInhaleMax = parseFloat(e.target.value);
      dom.dbgLblJawInMax.textContent = THRESHOLDS.jawOpenInhaleMax.toFixed(2);
    });
  }

  dom.dbgRangePuckerMin.addEventListener('input', (e) => {
    THRESHOLDS.mouthPuckerMin = parseFloat(e.target.value);
    dom.dbgLblPuckerMin.textContent = THRESHOLDS.mouthPuckerMin.toFixed(2);
  });

  dom.dbgRangeFunnelMin.addEventListener('input', (e) => {
    THRESHOLDS.mouthFunnelMin = parseFloat(e.target.value);
    dom.dbgLblFunnelMin.textContent = THRESHOLDS.mouthFunnelMin.toFixed(2);
  });

  dom.dbgRangeShoulderMax.addEventListener('input', (e) => {
    THRESHOLDS.shoulderHikeWarn = parseFloat(e.target.value);
    dom.dbgLblShoulderMax.textContent = THRESHOLDS.shoulderHikeWarn.toFixed(2);
  });

  dom.btnResetThresholds.addEventListener('click', () => {
    THRESHOLDS.larInhaleMax = 0.06;
    THRESHOLDS.jawOpenInhaleMax = 0.05;
    THRESHOLDS.mouthPuckerMin = 0.40;
    THRESHOLDS.mouthFunnelMin = 0.35;
    THRESHOLDS.shoulderHikeWarn = 0.12;

    dom.dbgRangeLarInMax.value = 0.06;
    dom.dbgLblLarInMax.textContent = "0.06";
    if (dom.dbgRangeJawInMax) {
      dom.dbgRangeJawInMax.value = 0.05;
      dom.dbgLblJawInMax.textContent = "0.05";
    }
    dom.dbgRangePuckerMin.value = 0.40;
    dom.dbgLblPuckerMin.textContent = "0.40";
    dom.dbgRangeFunnelMin.value = 0.35;
    dom.dbgLblFunnelMin.textContent = "0.35";
    dom.dbgRangeShoulderMax.value = 0.12;
    dom.dbgLblShoulderMax.textContent = "0.12";
    showToast("🔄 已恢復預設臨床閾值");
  });

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
// 11. 程式啟動入口 (Immediate Safe Bootstrapping)
// ============================================================================
function bootstrapApp() {
  if (window.__sootheBreathBootstrapped) return;
  window.__sootheBreathBootstrapped = true;

  cacheDomElements();
  setupEventListeners();
  updatePacingCalculationsUI();
  applyDisplayModeStyles();
  initTTS();
  loadAndRenderLocalHistory();
  initMediaPipeVision();
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', bootstrapApp);
} else {
  bootstrapApp();
}
