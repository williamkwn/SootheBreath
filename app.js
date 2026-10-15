/**
 * 舒呼 (SootheBreath) — 實時呼吸視覺生物反饋系統 (PWA)
 * ESM Core Engine v4.0: MediaPipe Tasks Vision 0.10.14, 10s Calibration + Confirmation,
 * Human Mode (1.jpg-4.jpg), Centered Pacer Mode, Real-Time Average RR, Math & Feedback
 * 嚴格保留全部臨床偵測邏輯與預設 THRESHOLDS
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

// 預設臨床閾值 (Default Clinical Thresholds — 嚴格保持不變)
const THRESHOLDS = {
  larInhaleMax: 0.06,
  larInhaleErr: 0.08,
  larExhaleMin: 0.04,
  larExhaleMax: 0.24,
  larExhaleWideErr: 0.26,
  larExhaleClosedErr: 0.03,
  mouthPuckerMin: 0.40,
  mouthFunnelMin: 0.35,
  puckerWideErrMax: 0.30,
  puckerClosedErrMax: 0.25,
  shoulderHikeWarn: 0.12,
  shoulderHikeNormal: 0.10,
  shoulderTiltMax: 0.15,
  earlyExhaleRatio: 0.70
};

// 真人模式圖片路徑映射 (1=男吸 / 2=男呼 / 3=女吸 / 4=女呼)
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
  
  // 使用者設定
  inhaleTarget: 2.0,          // 秒
  exhaleTarget: 4.0,          // 秒
  totalDuration: 120,         // 秒
  privacyMode: 'privacy_mesh', // 'mirror' | 'privacy_mesh' | 'minimalist'
  displayMode: 'balloon',     // 'balloon' | 'human'
  humanGender: 'male',        // 'male' | 'female'
  voiceEnabled: true,
  
  // 10秒基準校準結果 (前7秒收集基準，後3秒確認位置)
  calibration: {
    dEyeBase: 0.22,
    yShoulderBase: 0.68,
    larRest: 0.04,
    samplesCount: 0,
    sumDEye: 0,
    sumYShoulder: 0,
    sumLar: 0,
    elapsedCalibSec: 0
  },

  // 實時推論變數
  currentMetrics: {
    dEye: 0.22,
    lar: 0.04,
    mouthPucker: 0.10,
    mouthFunnel: 0.10,
    yShoulderCurr: 0.68,
    deltaYShoulder: 0.01,
    shoulderTilt: 0.02,
    hasFace: false,
    hasPose: false
  },

  // 訓練過程狀態機
  training: {
    startTime: 0,
    elapsedSeconds: 0,
    currentPhase: PHASES.INHALE,
    phaseStartTime: 0,
    cycleStartTime: 0,
    cycleIndex: 0,
    
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

    // 頂部導航欄按鈕
    btnHeaderVoice: document.getElementById('btn-header-voice'),

    // 設定控制器 (STATE_IDLE)
    inputInhale: document.getElementById('input-inhale-time'),
    inputExhale: document.getElementById('input-exhale-time'),
    valInhale: document.getElementById('val-inhale-time'),
    valExhale: document.getElementById('val-exhale-time'),
    labelIePreset: document.getElementById('label-ie-preset'),
    valTargetBpm: document.getElementById('val-target-bpm'),
    valCycleTotal: document.getElementById('val-cycle-total'),
    selectPrivacy: document.getElementById('select-privacy-mode'),
    selectDuration: document.getElementById('select-duration'),
    toggleVoice: document.getElementById('toggle-voice'),
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

    // 四張實時生物反饋指示卡 (含新增平均呼吸頻率卡)
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
    dbgPucker: document.getElementById('dbg-val-pucker'),
    dbgFunnel: document.getElementById('dbg-val-funnel'),
    dbgShoulder: document.getElementById('dbg-val-shoulder'),
    dbgDeye: document.getElementById('dbg-val-deye'),
    dbgTilt: document.getElementById('dbg-val-tilt'),
    dbgRr: document.getElementById('dbg-val-rr'),
    dbgRangeLarInMax: document.getElementById('dbg-range-lar-in-max'),
    dbgLblLarInMax: document.getElementById('dbg-lbl-lar-in-max'),
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
    // 若已有運行中的視訊串流且有效，直接複用避免重複請求閃爍
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
// 5. 核心電腦視覺運算公式 (Section 3 Math & Algorithms — 嚴格保留全部臨床邏輯)
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
 * mouthPucker (噘唇/嘟嘴) 與 mouthFunnel (漏斗狀微張)
 */
function extractBlendshapes(blendshapesList) {
  let mouthPucker = 0;
  let mouthFunnel = 0;

  if (blendshapesList && blendshapesList[0] && blendshapesList[0].categories) {
    const cats = blendshapesList[0].categories;
    for (let i = 0; i < cats.length; i++) {
      if (cats[i].categoryName === 'mouthPucker') {
        mouthPucker = cats[i].score;
      } else if (cats[i].categoryName === 'mouthFunnel') {
        mouthFunnel = cats[i].score;
      }
    }
  }

  return { mouthPucker, mouthFunnel };
}

/**
 * 標準化雙肩垂直上升量與傾斜度 (Shoulder Hike Proxy)
 * Pose Landmarks 左肩 11、右肩 12
 */
function calculateShoulderMetrics(poseLandmarks, dEye, yShoulderBase) {
  const p11 = poseLandmarks[11];
  const p12 = poseLandmarks[12];

  const yShoulderCurr = (p11.y + p12.y) / 2;
  const dEyeSafe = Math.max(dEye, 0.05);

  // 頂部 Y 為 0，聳肩時 yShoulderCurr 變小，Delta_Y 為正數
  const deltaYShoulder = (yShoulderBase - yShoulderCurr) / dEyeSafe;
  const shoulderTilt = Math.abs(p11.y - p12.y) / dEyeSafe;

  return { yShoulderCurr, deltaYShoulder, shoulderTilt };
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
  const breathShift = isExhale ? 0.003 : -0.004;
  pose[11] = { x: 0.30, y: 0.72 + breathShift };
  pose[12] = { x: 0.70, y: 0.72 + breathShift };

  return {
    faceResult: {
      faceLandmarks: [face],
      faceBlendshapes: [{
        categories: [
          { categoryName: 'mouthPucker', score: pucker },
          { categoryName: 'mouthFunnel', score: funnel }
        ]
      }]
    },
    poseResult: {
      landmarks: [pose]
    }
  };
}

// ============================================================================
// 6. 廣東話語音合成導航 (Section 4 Cantonese TTS)
// ============================================================================
function initTTS() {
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

function syncVoiceUI() {
  if (dom.toggleVoice) {
    dom.toggleVoice.checked = AppState.voiceEnabled;
  }
  if (dom.btnHeaderVoice) {
    dom.btnHeaderVoice.innerHTML = AppState.voiceEnabled
      ? `<span>🔊</span><span class="hidden sm:inline">語音導航</span>`
      : `<span>🔇</span><span class="hidden sm:inline">已靜音</span>`;
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
// 10 秒坐姿基準校準 + 確認機制 (Requirement 4: 前7秒收集基準，後3秒顯示「請確認位置」)
// ----------------------------------------------------------------------------
async function runCalibrationSequence() {
  if (AppState.calibTimerId) {
    clearInterval(AppState.calibTimerId);
    AppState.calibTimerId = null;
  }
  AppState.isCalibConfirming = false;

  // 顯示倒數覆蓋層，隱藏結束後的確認面板
  if (dom.calibCountdownOverlay) dom.calibCountdownOverlay.classList.remove('hidden');
  if (dom.calibConfirmOverlay) dom.calibConfirmOverlay.classList.add('hidden');

  dom.calibCountdown.textContent = "準備中";
  if (dom.calibStageBadge) {
    dom.calibStageBadge.textContent = "步驟 1/2：收集基準坐姿 (前 7 秒)";
    dom.calibStageBadge.className = "inline-flex items-center gap-1.5 px-3.5 py-1 rounded-full text-xs font-bold bg-[#4DB6AC]/20 text-teal-800 border border-[#4DB6AC]/40";
  }
  if (dom.calibTitle) dom.calibTitle.textContent = "請自然坐直、沉肩放鬆、閉上嘴巴";
  if (dom.calibSubtitle) dom.calibSubtitle.textContent = "正在啟動鏡頭並準備收集 7 秒基準坐姿...";
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
    yShoulderBase: 0.72,
    larRest: 0.04,
    samplesCount: 0,
    sumDEye: 0,
    sumYShoulder: 0,
    sumLar: 0,
    elapsedCalibSec: 0
  };

  speakText("請自然坐直、沉肩放鬆、閉上嘴巴，正在記錄基準坐姿", true);

  const totalCalibSeconds = 10;
  let secondsRemaining = totalCalibSeconds;
  dom.calibCountdown.textContent = secondsRemaining;
  if (dom.calibSubtitle) {
    dom.calibSubtitle.textContent = "前 7 秒：正在記錄雙眼間距 (D_eye) 與雙肩靜止基準高度...";
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
      // 前 7 秒 (倒數 10 -> 4)：收集基準
      dom.calibCountdown.textContent = secondsRemaining;
      if (dom.calibStageBadge) {
        dom.calibStageBadge.textContent = `步驟 1/2：收集基準坐姿 (剩餘 ${secondsRemaining - 3} 秒)`;
      }
      if (dom.calibTitle) dom.calibTitle.textContent = "請自然坐直、沉肩放鬆、閉上嘴巴";
      if (dom.calibSubtitle) dom.calibSubtitle.textContent = "正在記錄雙眼間距 (D_eye) 與雙肩靜止基準高度...";
    } else if (secondsRemaining > 0) {
      // 後 3 秒 (倒數 3 -> 1)：顯示「請確認位置」
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
      // 10 秒結束：不自動開始訓練，進入確認畫面
      clearInterval(AppState.calibTimerId);
      AppState.calibTimerId = null;
      showCalibrationConfirmation();
    }
  }, 1000);

  function calibFrameLoop() {
    if (AppState.currentState !== STATES.CALIBRATING) return;

    const isCollectingPhase = !AppState.isCalibConfirming && (AppState.calibration.elapsedCalibSec < 7);

    if (AppState.isDemoMode) {
      if (isCollectingPhase) {
        AppState.calibration.sumDEye += 0.20;
        AppState.calibration.sumLar += 0.04;
        AppState.calibration.sumYShoulder += 0.72;
        AppState.calibration.samplesCount++;
      }
      renderCalibrationCanvas(generateSimulatedDetections(performance.now()));
    } else if (dom.calibVideo.readyState >= 2 && AppState.faceLandmarker && AppState.poseLandmarker) {
      try {
        const ts = getNextTimestamp();
        const faceResult = AppState.faceLandmarker.detectForVideo(dom.calibVideo, ts);
        const poseResult = AppState.poseLandmarker.detectForVideo(dom.calibVideo, ts);

        if (faceResult.faceLandmarks && faceResult.faceLandmarks.length > 0 &&
            poseResult.landmarks && poseResult.landmarks.length > 0) {
          const face = faceResult.faceLandmarks[0];
          const pose = poseResult.landmarks[0];

          if (isCollectingPhase) {
            const dEye = calculateDEye(face);
            const lar = calculateLAR(face);
            const yShoulder = (pose[11].y + pose[12].y) / 2;

            AppState.calibration.sumDEye += dEye;
            AppState.calibration.sumLar += lar;
            AppState.calibration.sumYShoulder += yShoulder;
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
    c.yShoulderBase = c.sumYShoulder / c.samplesCount;
  } else {
    c.dEyeBase = 0.20;
    c.larRest = 0.04;
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
    dom.calibSummaryMetrics.textContent = `已收集 ${c.samplesCount} 幀基準 · D_eye: ${c.dEyeBase.toFixed(2)} · 肩高基準: ${c.yShoulderBase.toFixed(2)} · 閉口 LAR: ${c.larRest.toFixed(2)}`;
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
    const p11 = { x: pose[11].x * w, y: pose[11].y * h };
    const p12 = { x: pose[12].x * w, y: pose[12].y * h };
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
  const targetRR = 60 / (AppState.inhaleTarget + AppState.exhaleTarget);

  AppState.training.startTime = now;
  AppState.training.phaseStartTime = now;
  AppState.training.cycleStartTime = now;
  AppState.training.currentPhase = PHASES.INHALE;
  AppState.training.cycleIndex = 1;
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
 * 切換視覺私隱模式 + Pacer 模式圓球與文字提示完全居中 (Requirement 6)
 */
function applyPrivacyModeStyles() {
  const mode = AppState.privacyMode;
  if (dom.selectPrivacy && dom.selectPrivacy.value !== mode) {
    dom.selectPrivacy.value = mode;
  }

  // 更新訓練畫面右上角模式按鈕高亮
  const activeCls = "px-2.5 py-1 rounded-lg text-xs font-bold bg-[#4DB6AC] text-white shadow-sm transition cursor-pointer";
  const inactiveCls = "px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-600 transition cursor-pointer";
  if (dom.btnModeMirror) dom.btnModeMirror.className = mode === 'mirror' ? activeCls : inactiveCls;
  if (dom.btnModeMesh) dom.btnModeMesh.className = mode === 'privacy_mesh' ? activeCls : inactiveCls;
  if (dom.btnModeMinimal) dom.btnModeMinimal.className = mode === 'minimalist' ? activeCls : inactiveCls;

  if (mode === 'minimalist') {
    // Requirement 6: Pacer 模式時隱藏左側空白視訊欄，讓圓球與文字提示在畫面正中央居中
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
    // 雙欄模式 (Mirror / Privacy Mesh)：左側 60% 視訊/骨架，右側 40% 引導欄
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
      dom.badgeMeshMode.textContent = AppState.isDemoMode ? "🧪 免鏡頭模擬骨架模式" : "🔒 去識別化黑底骨架模式";
      dom.badgeMeshMode.classList.remove('hidden');
    } else {
      dom.trainVideo.style.opacity = AppState.isDemoMode ? '0' : '1';
      dom.trainCanvas.style.opacity = '1';
      dom.trainCanvas.classList.remove('privacy-mesh-canvas');
      dom.badgeMeshMode.textContent = "📷 實時鏡像 + AR 輔助框";
      dom.badgeMeshMode.classList.remove('hidden');
    }
    setTimeout(syncCanvasDimensions, 50);
  }
}

/**
 * 切換氣球模式 vs 真人模式 (Requirement 3: 1=男吸 / 2=男呼 / 3=女吸 / 4=女呼)
 */
function applyDisplayModeStyles() {
  const isHuman = AppState.displayMode === 'human';
  const gender = AppState.humanGender;

  // 更新 STATE_IDLE 設定按鈕樣式
  const idleActive = "flex-1 py-2 px-3 rounded-xl text-xs font-bold bg-[#2E7D32] text-white shadow-sm transition cursor-pointer";
  const idleInactive = "flex-1 py-2 px-3 rounded-xl text-xs font-semibold bg-white hover:bg-teal-50 text-slate-600 border border-slate-200 transition cursor-pointer";

  if (dom.btnPacerBalloon) dom.btnPacerBalloon.className = !isHuman ? idleActive : idleInactive;
  if (dom.btnPacerHuman) dom.btnPacerHuman.className = isHuman ? idleActive : idleInactive;
  if (dom.wrapperHumanGender) {
    dom.wrapperHumanGender.classList.toggle('hidden', !isHuman);
  }
  if (dom.btnGenderMale) dom.btnGenderMale.className = gender === 'male' ? idleActive : idleInactive;
  if (dom.btnGenderFemale) dom.btnGenderFemale.className = gender === 'female' ? idleActive : idleInactive;

  // 更新 STATE_TRAINING 頂部快速切換按鈕樣式
  const trainActive = "px-2.5 py-1 rounded-lg text-xs font-bold bg-[#2E7D32] text-white shadow-sm transition cursor-pointer";
  const trainInactive = "px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-600 transition cursor-pointer";
  if (dom.btnTrainBalloon) dom.btnTrainBalloon.className = !isHuman ? trainActive : trainInactive;
  if (dom.btnTrainMale) dom.btnTrainMale.className = (isHuman && gender === 'male') ? trainActive : trainInactive;
  if (dom.btnTrainFemale) dom.btnTrainFemale.className = (isHuman && gender === 'female') ? trainActive : trainInactive;

  // 更新圖片路徑 (1.jpg/2.jpg 或 3.jpg/4.jpg)
  const imgPair = HUMAN_IMAGES[gender] || HUMAN_IMAGES.male;
  if (dom.imgHumanInhale && dom.imgHumanInhale.getAttribute('src') !== imgPair.inhale) {
    dom.imgHumanInhale.src = imgPair.inhale;
  }
  if (dom.imgHumanExhale && dom.imgHumanExhale.getAttribute('src') !== imgPair.exhale) {
    dom.imgHumanExhale.src = imgPair.exhale;
  }

  // 切換氣球或真人框顯示
  if (dom.pacerOuterRing) {
    dom.pacerOuterRing.classList.toggle('hidden', isHuman);
  }
  if (dom.humanDemoWrapper) {
    dom.humanDemoWrapper.classList.toggle('hidden', !isHuman);
  }

  // 同步當前吸呼階段的圖片透明度
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
  const elapsedTotal = (now - train.startTime) / 1000;
  train.elapsedSeconds = elapsedTotal;

  const remainingTotal = Math.max(0, AppState.totalDuration - elapsedTotal);
  const mins = Math.floor(remainingTotal / 60);
  const secs = Math.floor(remainingTotal % 60);
  dom.valTimerLeft.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  dom.valCycleCount.textContent = train.cycleIndex;

  if (remainingTotal <= 0) {
    finalizeCurrentCycle(now);
    switchViewState(STATES.SUMMARY);
    return;
  }

  // 1. 取得視訊推論或模擬特徵點
  if (AppState.isDemoMode) {
    const sim = generateSimulatedDetections(now);
    AppState.lastFaceResult = sim.faceResult;
    AppState.lastPoseResult = sim.poseResult;
    processFrameDetections(sim.faceResult, sim.poseResult);
  } else if (dom.trainVideo.readyState >= 2 && AppState.faceLandmarker && AppState.poseLandmarker) {
    try {
      const ts = getNextTimestamp();
      const faceResult = AppState.faceLandmarker.detectForVideo(dom.trainVideo, ts);
      const poseResult = AppState.poseLandmarker.detectForVideo(dom.trainVideo, ts);

      AppState.lastFaceResult = faceResult;
      AppState.lastPoseResult = poseResult;

      processFrameDetections(faceResult, poseResult);
    } catch (e) {
      console.warn("推論幀略過:", e);
    }
  }

  // 2. 呼吸節奏狀態機推進
  advanceBreathingPacer(now);

  // 3. 即時更新平均呼吸頻率 (Requirement 7)
  updateLiveRespiratoryRate(now);

  // 4. 繪製視覺 Canvas 覆蓋層
  renderTrainingCanvas(AppState.lastFaceResult, AppState.lastPoseResult);

  // 5. 更新調試面板讀數
  updateDebugReadouts();

  requestAnimationFrame(trainingInferenceLoop);
}

// ----------------------------------------------------------------------------
// 實時平均呼吸頻率計算與回饋 (Requirement 7: Average Respiratory Rate)
// ----------------------------------------------------------------------------
function updateLiveRespiratoryRate(now) {
  const train = AppState.training;
  const targetCycleSec = AppState.inhaleTarget + AppState.exhaleTarget;
  const targetRR = 60 / targetCycleSec;

  const elapsedSec = Math.max(0.1, (now - train.startTime) / 1000);
  const currentCycleElapsed = Math.max(0, (now - train.cycleStartTime) / 1000);
  const currentCycleProgress = Math.min(0.99, currentCycleElapsed / targetCycleSec);

  // 結合已完成週期與當前週期進度計算即時平均呼吸頻率 (breaths/min)
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
      dom.textRrState.textContent = `${rrFormatted} BPM (目標 ${targetRR.toFixed(1)} 達標)`;
      dom.textRrState.className = "text-xs md:text-sm font-bold text-[#2E7D32]";
      dom.cardRr.className = "p-3 rounded-2xl bg-emerald-50/80 border border-emerald-200 flex items-center justify-between transition-all shadow-sm";
    } else {
      dom.textRrState.textContent = `${rrFormatted} BPM (目標 ${targetRR.toFixed(1)})`;
      dom.textRrState.className = "text-xs md:text-sm font-bold text-teal-700";
      dom.cardRr.className = "p-3 rounded-2xl bg-white border border-slate-200 flex items-center justify-between transition-all shadow-sm";
    }
  }
}

// ----------------------------------------------------------------------------
// 逐幀特徵點運算與臨床規則評估 (Frame Processing & Clinical Rules — 嚴格保留)
// ----------------------------------------------------------------------------
function processFrameDetections(faceResult, poseResult) {
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

  const shoulder = calculateShoulderMetrics(pose, m.dEye, cal.yShoulderBase);
  m.yShoulderCurr = shoulder.yShoulderCurr;
  m.deltaYShoulder = shoulder.deltaYShoulder;
  m.shoulderTilt = shoulder.shoulderTilt;

  train.totalShoulderFrames++;
  const isShoulderRelaxed = m.deltaYShoulder <= THRESHOLDS.shoulderHikeWarn;
  if (isShoulderRelaxed) {
    train.validShoulderFrames++;
  }

  if (train.currentPhase === PHASES.INHALE) {
    train.totalInhaleFrames++;
    const isMouthClosed = m.lar <= THRESHOLDS.larInhaleMax;

    if (isMouthClosed && isShoulderRelaxed) {
      train.validInhaleFrames++;
      train.tInActual += 0.033;
    }

    if (m.deltaYShoulder > THRESHOLDS.shoulderHikeWarn) {
      updateFeedbackQueue(2, "偵測到聳肩用力，請沉肩放鬆");
    } else if (m.lar > THRESHOLDS.larInhaleErr) {
      updateFeedbackQueue(3, "請閉上嘴巴，用鼻慢慢吸氣");
    } else {
      updateFeedbackQueue(5, "做得好，用鼻吸氣，沉肩放鬆");
    }

  } else {
    // 呼氣階段 (EXHALE - 噘唇吹氣判定)
    train.totalExhaleFrames++;
    const isPlbShape = 
      (m.lar >= THRESHOLDS.larExhaleMin && m.lar <= THRESHOLDS.larExhaleMax) &&
      (m.mouthPucker >= THRESHOLDS.mouthPuckerMin || m.mouthFunnel >= THRESHOLDS.mouthFunnelMin);

    if (isPlbShape) {
      train.validPlbExhaleFrames++;
      train.tExActual += 0.033;
    }

    if (m.deltaYShoulder > THRESHOLDS.shoulderHikeWarn) {
      updateFeedbackQueue(2, "呼氣時請保持雙肩放鬆，切勿聳肩");
    } else if (m.lar > THRESHOLDS.larExhaleWideErr && m.mouthPucker < THRESHOLDS.puckerWideErrMax) {
      updateFeedbackQueue(3, "請將嘴唇噘起成吹口哨狀，唔好張大口呼氣");
    } else if (m.lar < THRESHOLDS.larExhaleClosedErr && m.mouthPucker < THRESHOLDS.puckerClosedErrMax) {
      updateFeedbackQueue(3, "請微微噘起嘴唇，慢慢吹氣出嚟");
    } else {
      updateFeedbackQueue(5, "噘唇嘴型很好，繼續慢慢吹長氣");
    }
  }

  renderIndicatorCards(isShoulderRelaxed);
}

// ----------------------------------------------------------------------------
// 節奏球 / 真人示範與週期狀態機推進 (Pacer Timing & Switching)
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

    if (phaseElapsed > (AppState.exhaleTarget * 0.5) && train.tExActual < (phaseElapsed * 0.5)) {
      updateFeedbackQueue(4, "呼氣太快完喇，試下跟住圓圈慢慢吹長啲氣");
    }

    if (phaseElapsed >= AppState.exhaleTarget) {
      finalizeCurrentCycle(now);
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

function finalizeCurrentCycle(now = performance.now()) {
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
    targetIe: AppState.exhaleTarget / AppState.inhaleTarget,
    cycleDuration: cycleDuration,
    cycleRR: cycleRR,
    avgRR: train.avgRR
  });

  dom.badgeIeActual.textContent = `1 : ${achievedIeRatio.toFixed(1)}`;
  dom.textIeState.textContent = `1 : ${achievedIeRatio.toFixed(1)} (目標 1:${(AppState.exhaleTarget / AppState.inhaleTarget).toFixed(1)})`;

  train.tInActual = 0;
  train.tExActual = 0;
}

// ----------------------------------------------------------------------------
// 實時指示卡渲染 (Indicator Cards — 輕柔高對比配色)
// ----------------------------------------------------------------------------
function renderIndicatorCards(isShoulderRelaxed) {
  const m = AppState.currentMetrics;
  const train = AppState.training;

  dom.badgePlbScore.textContent = `LAR: ${m.lar.toFixed(2)}`;
  if (train.currentPhase === PHASES.INHALE) {
    if (m.lar <= THRESHOLDS.larInhaleMax) {
      dom.textPlbState.textContent = "閉口鼻吸 (達標)";
      dom.textPlbState.className = "text-xs md:text-sm font-bold text-[#2E7D32]";
      dom.cardPlb.className = "p-3 rounded-2xl bg-emerald-50/80 border border-emerald-200 flex items-center justify-between transition-all shadow-sm";
    } else {
      dom.textPlbState.textContent = "吸氣張口 (需閉口)";
      dom.textPlbState.className = "text-xs md:text-sm font-bold text-rose-600";
      dom.cardPlb.className = "p-3 rounded-2xl bg-rose-50/90 border border-rose-300 flex items-center justify-between transition-all shadow-sm";
    }
  } else {
    const isPlb = (m.lar >= THRESHOLDS.larExhaleMin && m.lar <= THRESHOLDS.larExhaleMax) &&
                  (m.mouthPucker >= THRESHOLDS.mouthPuckerMin || m.mouthFunnel >= THRESHOLDS.mouthFunnelMin);
    if (isPlb) {
      dom.textPlbState.textContent = "噘唇吹氣 (達標)";
      dom.textPlbState.className = "text-xs md:text-sm font-bold text-[#2E7D32]";
      dom.cardPlb.className = "p-3 rounded-2xl bg-emerald-50/80 border border-emerald-200 flex items-center justify-between transition-all shadow-sm";
    } else {
      dom.textPlbState.textContent = "未形成噘唇吹氣";
      dom.textPlbState.className = "text-xs md:text-sm font-bold text-amber-600";
      dom.cardPlb.className = "p-3 rounded-2xl bg-amber-50/90 border border-amber-300 flex items-center justify-between transition-all shadow-sm";
    }
  }

  dom.badgeShoulderDelta.textContent = `ΔY: ${m.deltaYShoulder >= 0 ? '+' : ''}${m.deltaYShoulder.toFixed(2)}`;
  if (isShoulderRelaxed) {
    dom.textShoulderState.textContent = "放鬆沉肩 (正常)";
    dom.textShoulderState.className = "text-xs md:text-sm font-bold text-[#2E7D32]";
    dom.cardShoulder.className = "p-3 rounded-2xl bg-white border border-slate-200 flex items-center justify-between transition-all shadow-sm";
    dom.cardShoulder.classList.remove('shoulder-alert-active');
  } else {
    dom.textShoulderState.textContent = "偵測到聳肩代償";
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

  // 繪製雙肩基準線與當前骨架連線
  if (m.hasPose && poseResults && poseResults.landmarks && poseResults.landmarks.length > 0) {
    const pose = poseResults.landmarks[0];
    const p11 = { x: pose[11].x * w, y: pose[11].y * h };
    const p12 = { x: pose[12].x * w, y: pose[12].y * h };

    if (AppState.calibration.yShoulderBase > 0) {
      const yBasePx = AppState.calibration.yShoulderBase * h;
      ctx.save();
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(w * 0.15, yBasePx);
      ctx.lineTo(w * 0.85, yBasePx);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.lineWidth = 4;
    if (m.deltaYShoulder > THRESHOLDS.shoulderHikeWarn) {
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
      ? (m.lar <= THRESHOLDS.larInhaleMax)
      : (m.lar >= THRESHOLDS.larExhaleMin && m.lar <= THRESHOLDS.larExhaleMax);
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
  const meanIe = completedCycles > 0 ? (sumIe / completedCycles).toFixed(1) : "2.0";

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

  speakText(`訓練完成，你共完成了${completedCycles}次呼吸週期，平均呼吸頻率為每分鐘${meanRR}次，評級為${gradeText}`);
  loadAndRenderLocalHistory();
}

function exportDeidentifiedCSV() {
  const train = AppState.training;
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 8);
  const meanRR = dom.sumRr ? dom.sumRr.textContent : train.avgRR.toFixed(1);

  let csvContent = "data:text/csv;charset=utf-8,\uFEFF";
  csvContent += "=== 舒呼 (SootheBreath) — 實時呼吸視覺生物反饋系統 匿名臨床數據報表 ===\n";
  csvContent += `訓練日期,${dateStr}\n`;
  csvContent += `訓練時間,${timeStr}\n`;
  csvContent += `總訓練秒數,${Math.round(train.elapsedSeconds)}\n`;
  csvContent += `完成循環總數,${train.cyclesHistory.length}\n`;
  csvContent += `平均呼吸頻率(次/分),${meanRR}\n`;
  csvContent += `設定目標吸呼比,1:${(AppState.exhaleTarget / AppState.inhaleTarget).toFixed(1)}\n\n`;

  csvContent += "週期序號,實測有效吸氣時間(秒),實測噘唇呼氣時間(秒),實測I:E吸呼比,單次週期呼吸頻率(次/分),累計平均呼吸頻率(次/分)\n";
  train.cyclesHistory.forEach(c => {
    const cRR = c.cycleRR ? c.cycleRR.toFixed(1) : (60 / (AppState.inhaleTarget + AppState.exhaleTarget)).toFixed(1);
    const aRR = c.avgRR ? c.avgRR.toFixed(1) : meanRR;
    csvContent += `${c.cycle},${c.tInActual.toFixed(2)},${c.tExActual.toFixed(2)},1:${c.achievedIe.toFixed(2)},${cRR},${aRR}\n`;
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
  dom.dbgPucker.textContent = m.mouthPucker.toFixed(3);
  dom.dbgFunnel.textContent = m.mouthFunnel.toFixed(3);
  dom.dbgShoulder.textContent = m.deltaYShoulder.toFixed(3);
  dom.dbgDeye.textContent = m.dEye.toFixed(3);
  dom.dbgTilt.textContent = m.shoulderTilt.toFixed(3);
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

function updatePacingCalculationsUI() {
  const ratio = AppState.exhaleTarget / AppState.inhaleTarget;
  const totalCycleSec = AppState.inhaleTarget + AppState.exhaleTarget;
  const targetBpm = 60 / totalCycleSec;

  document.querySelectorAll('.btn-ie-quick').forEach(btn => {
    const btnIn = parseFloat(btn.dataset.in);
    const btnEx = parseFloat(btn.dataset.ex);
    const isMatch = Math.abs(AppState.inhaleTarget - btnIn) < 0.05 && Math.abs(AppState.exhaleTarget - btnEx) < 0.05;
    if (isMatch) {
      btn.className = "btn-ie-quick flex-1 py-2 rounded-xl text-xs font-bold bg-[#2E7D32] text-white shadow-sm transition cursor-pointer";
    } else {
      btn.className = "btn-ie-quick flex-1 py-2 rounded-xl text-xs font-semibold bg-white hover:bg-teal-50 text-slate-600 border border-slate-200 transition cursor-pointer";
    }
  });

  if (dom.labelIePreset) dom.labelIePreset.textContent = `目標 1 : ${ratio.toFixed(1)}`;
  if (dom.valTargetBpm) dom.valTargetBpm.textContent = `${targetBpm.toFixed(1)} BPM (次/分)`;
  if (dom.valCycleTotal) dom.valCycleTotal.textContent = `單次循環總長: ${totalCycleSec.toFixed(1)} 秒 (吸 ${AppState.inhaleTarget.toFixed(1)}s / 呼 ${AppState.exhaleTarget.toFixed(1)}s)`;
}

function setupEventListeners() {
  dom.inputInhale.addEventListener('input', (e) => {
    AppState.inhaleTarget = parseFloat(e.target.value);
    dom.valInhale.textContent = `${AppState.inhaleTarget.toFixed(1)} 秒`;
    updatePacingCalculationsUI();
  });

  dom.inputExhale.addEventListener('input', (e) => {
    AppState.exhaleTarget = parseFloat(e.target.value);
    dom.valExhale.textContent = `${AppState.exhaleTarget.toFixed(1)} 秒`;
    updatePacingCalculationsUI();
  });

  document.querySelectorAll('.btn-ie-quick').forEach(btn => {
    btn.addEventListener('click', () => {
      const inVal = parseFloat(btn.dataset.in);
      const exVal = parseFloat(btn.dataset.ex);
      AppState.inhaleTarget = inVal;
      AppState.exhaleTarget = exVal;
      dom.inputInhale.value = inVal;
      dom.inputExhale.value = exVal;
      dom.valInhale.textContent = `${inVal.toFixed(1)} 秒`;
      dom.valExhale.textContent = `${exVal.toFixed(1)} 秒`;
      updatePacingCalculationsUI();
      showToast(`⏱️ 已切換吸呼比為 1 : ${(exVal / inVal).toFixed(0)}（目標頻率 ${(60 / (inVal + exVal)).toFixed(1)} BPM）`);
    });
  });

  // 視覺私隱模式選擇
  dom.selectPrivacy.addEventListener('change', (e) => {
    AppState.privacyMode = e.target.value;
    applyPrivacyModeStyles();
  });

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

  // 真人模式與性別切換 (STATE_IDLE 與 STATE_TRAINING)
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

  // 訓練中快速切換氣球 / 男示範 / 女示範
  if (dom.btnTrainBalloon) {
    dom.btnTrainBalloon.addEventListener('click', () => {
      AppState.displayMode = 'balloon';
      applyDisplayModeStyles();
      showToast("🎈 已切換至氣球節奏球模式");
    });
  }
  if (dom.btnTrainMale) {
    dom.btnTrainMale.addEventListener('click', () => {
      AppState.displayMode = 'human';
      AppState.humanGender = 'male';
      applyDisplayModeStyles();
      showToast("👨 已切換至真人示範（男性：1=男吸 / 2=男呼）");
    });
  }
  if (dom.btnTrainFemale) {
    dom.btnTrainFemale.addEventListener('click', () => {
      AppState.displayMode = 'human';
      AppState.humanGender = 'female';
      applyDisplayModeStyles();
      showToast("👩 已切換至真人示範（女性：3=女吸 / 4=女呼）");
    });
  }

  dom.selectDuration.addEventListener('change', (e) => {
    AppState.totalDuration = parseInt(e.target.value, 10);
  });

  dom.toggleVoice.addEventListener('change', (e) => {
    AppState.voiceEnabled = e.target.checked;
    syncVoiceUI();
    showToast(AppState.voiceEnabled ? "🔊 已開啟廣東話語音導航" : "🔇 已靜音語音導航");
  });

  if (dom.btnHeaderVoice) {
    dom.btnHeaderVoice.addEventListener('click', () => {
      AppState.voiceEnabled = !AppState.voiceEnabled;
      syncVoiceUI();
      showToast(AppState.voiceEnabled ? "🔊 已開啟廣東話語音導航" : "🔇 已靜音語音導航");
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

  // 校準畫面取消返回設定
  if (dom.btnCancelCalib) {
    dom.btnCancelCalib.addEventListener('click', () => {
      switchViewState(STATES.IDLE);
    });
  }

  // Requirement 4: 10秒校準結束後的確認畫面三顆按鈕
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

  // Requirement 5: TRAINING 右上角「🔄 重校準」按鈕，隨時可回 CALIBRATING
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
    THRESHOLDS.mouthPuckerMin = 0.40;
    THRESHOLDS.mouthFunnelMin = 0.35;
    THRESHOLDS.shoulderHikeWarn = 0.12;

    dom.dbgRangeLarInMax.value = 0.06;
    dom.dbgLblLarInMax.textContent = "0.06";
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
  syncVoiceUI();
  initTTS();
  loadAndRenderLocalHistory();
  initMediaPipeVision();
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', bootstrapApp);
} else {
  bootstrapApp();
}
