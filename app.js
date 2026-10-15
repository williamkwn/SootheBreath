/**
 * BreathGuide — 實時呼吸視覺生物反饋系統 (PWA)
 * ESM Core Engine v3.0: MediaPipe Tasks Vision 0.10.14, Calibration, Math & Feedback
 * 嚴格符合 PRD Section 0 至 Section 7 規範（全面採用「噘唇」術語與互動美學升級）
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

// 預設臨床閾值 (Default Clinical Thresholds)
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
  
  // 使用者設定
  inhaleTarget: 2.0,      // 秒
  exhaleTarget: 4.0,      // 秒
  totalDuration: 120,     // 秒
  privacyMode: 'privacy_mesh', // 'mirror' | 'privacy_mesh' | 'minimalist'
  voiceEnabled: true,
  
  // 3秒基準校準結果 (Baseline Calibration)
  calibration: {
    dEyeBase: 0.22,
    yShoulderBase: 0.68,
    larRest: 0.04,
    samplesCount: 0,
    sumDEye: 0,
    sumYShoulder: 0,
    sumLar: 0
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
    cycleIndex: 0,
    
    // 當前週期累計有效時間
    tInActual: 0,
    tExActual: 0,
    
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

    // 設定控制器
    inputInhale: document.getElementById('input-inhale-time'),
    inputExhale: document.getElementById('input-exhale-time'),
    valInhale: document.getElementById('val-inhale-time'),
    valExhale: document.getElementById('val-exhale-time'),
    labelIePreset: document.getElementById('label-ie-preset'),
    selectPrivacy: document.getElementById('select-privacy-mode'),
    selectDuration: document.getElementById('select-duration'),
    toggleVoice: document.getElementById('toggle-voice'),
    btnStart: document.getElementById('btn-start'),
    btnStartDemo: document.getElementById('btn-start-demo'),
    btnCancelCalib: document.getElementById('btn-cancel-calib'),
    btnPauseTrain: document.getElementById('btn-pause-train'),
    btnStopEarly: document.getElementById('btn-stop-early'),
    btnRestart: document.getElementById('btn-restart'),
    btnExportCsv: document.getElementById('btn-export-csv'),
    btnSaveLocal: document.getElementById('btn-save-local'),
    btnClearHistory: document.getElementById('btn-clear-history'),

    // 訓練畫面即時模式切換按鈕
    btnModeMirror: document.getElementById('btn-mode-mirror'),
    btnModeMesh: document.getElementById('btn-mode-mesh'),
    btnModeMinimal: document.getElementById('btn-mode-minimal'),

    // 校準與訓練視訊/畫布
    calibVideo: document.getElementById('calib-video'),
    calibCanvas: document.getElementById('calib-canvas'),
    calibCountdown: document.getElementById('calib-countdown'),
    trainVideo: document.getElementById('train-video'),
    trainCanvas: document.getElementById('train-canvas'),
    badgeMeshMode: document.getElementById('badge-mesh-mode'),

    // 狀態欄與節奏球
    pillPhase: document.getElementById('pill-phase'),
    pillCycle: document.getElementById('pill-cycle'),
    valCycleCount: document.getElementById('val-cycle-count'),
    valTimerLeft: document.getElementById('val-timer-left'),
    pacerBall: document.getElementById('pacer-ball'),
    pacerActionText: document.getElementById('pacer-action-text'),
    pacerSecondsText: document.getElementById('pacer-seconds-text'),
    pacerPhaseHint: document.getElementById('pacer-phase-hint'),

    // 三張指示燈卡
    cardPlb: document.getElementById('card-status-plb'),
    textPlbState: document.getElementById('text-plb-state'),
    badgePlbScore: document.getElementById('badge-plb-score'),
    cardShoulder: document.getElementById('card-status-shoulder'),
    textShoulderState: document.getElementById('text-shoulder-state'),
    badgeShoulderDelta: document.getElementById('badge-shoulder-delta'),
    cardIe: document.getElementById('card-status-ie'),
    textIeState: document.getElementById('text-ie-state'),
    badgeIeActual: document.getElementById('badge-ie-actual'),

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
    btnModalClose: document.getElementById('btn-modal-close'),

    // 總結報告數值
    sumCycles: document.getElementById('sum-cycles'),
    sumDuration: document.getElementById('sum-duration'),
    sumRr: document.getElementById('sum-rr'),
    sumIe: document.getElementById('sum-ie'),
    sumPlbAcc: document.getElementById('sum-plb-acc'),
    sumShoulderAcc: document.getElementById('sum-shoulder-acc'),
    sumGrade: document.getElementById('sum-grade'),
    listHistory: document.getElementById('list-history')
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
        console.log("MediaPipe Tasks Vision 0.10.14 (GPU) 模型加載成功");
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
        console.log("MediaPipe Tasks Vision 0.10.14 (CPU) 模型加載成功");
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
        <p>3. 若目前裝置無鏡頭，你可點擊下方「<b>進入免鏡頭模擬訓練</b>」預覽完整功能。</p>
      `;
      break;

    case 'NotReadableError':
    case 'TrackStartError':
      title = "鏡頭被其他應用程式佔用 (Camera Occupied)";
      desc = "相機硬體正在被其他視訊通話或後台程式使用。";
      stepsHtml = `
        <p>1. 請檢查並先完全關閉 <b>Zoom、Microsoft Teams、Google Meet、FaceTime</b> 或其他相機軟件。</p>
        <p>2. 重新整理本網頁後再試一次，或先使用「<b>免鏡頭模擬訓練</b>」。</p>
      `;
      break;

    default:
      title = "未知相機存取錯誤 (" + (error.name || "Error") + ")";
      desc = error.message || "系統發生未預期的鏡頭存取問題。";
      stepsHtml = `<p>請嘗試重新整理瀏覽器，或點擊下方「免鏡頭模擬訓練」體驗完整呼吸節奏導引。</p>`;
      break;
  }

  dom.modalErrorTitle.textContent = title;
  dom.modalErrorDesc.textContent = desc;
  dom.modalErrorSteps.innerHTML = stepsHtml;
  dom.modalError.classList.remove('hidden');
}

// ============================================================================
// 5. 核心電腦視覺運算公式 (Section 3 Math & Algorithms)
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

  // 建立模擬面部特徵點
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

  // 臉部橢圓輪廓點
  const ovalIndices = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
  ovalIndices.forEach((idx, k) => {
    const angle = (k / ovalIndices.length) * Math.PI * 2 - Math.PI / 2;
    face[idx] = {
      x: 0.50 + Math.cos(angle) * 0.13,
      y: 0.40 + Math.sin(angle) * 0.17
    };
  });

  // 雙肩特徵點
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
      voices.find(v => v.lang.includes('HK')) ||
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
    dom.bottomBanner.className = "shrink-0 w-full py-3.5 px-6 text-center z-30 font-extrabold text-2xl md:text-3xl leading-snug border-t border-rose-500/80 bg-rose-950/95 text-rose-100";
  } else if (priority <= 4) {
    dom.bottomBanner.className = "shrink-0 w-full py-3.5 px-6 text-center z-30 font-extrabold text-2xl md:text-3xl leading-snug border-t border-amber-500/80 bg-amber-950/95 text-amber-100";
  } else {
    dom.bottomBanner.className = "shrink-0 w-full py-3.5 px-6 text-center z-30 font-extrabold text-2xl md:text-3xl leading-snug border-t border-emerald-500/60 bg-slate-900/95 text-emerald-300";
  }
}

// ============================================================================
// 8. 狀態一至四之生命週期 (State Machine Lifecycle)
// ============================================================================

function switchViewState(targetState) {
  AppState.currentState = targetState;
  AppState.isPaused = false;

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
// 3 秒坐姿基準校準 (Section 3.1 CALIBRATING State)
// ----------------------------------------------------------------------------
async function runCalibrationSequence() {
  dom.calibCountdown.textContent = "準備中";

  const started = await startCamera(dom.calibVideo);
  if (!started) {
    switchViewState(STATES.IDLE);
    return;
  }

  if (!AppState.isDemoMode && (!AppState.faceLandmarker || !AppState.poseLandmarker)) {
    dom.calibCountdown.textContent = "AI 載入中";
    await initMediaPipeVision();
  }

  AppState.calibration = {
    dEyeBase: 0.22,
    yShoulderBase: 0.72,
    larRest: 0.04,
    samplesCount: 0,
    sumDEye: 0,
    sumYShoulder: 0,
    sumLar: 0
  };

  speakText("請自然坐直、沉肩放鬆、閉上嘴巴，正在記錄基準坐姿", true);

  let secondsRemaining = 3;
  dom.calibCountdown.textContent = secondsRemaining;

  const timer = setInterval(() => {
    if (AppState.currentState !== STATES.CALIBRATING) {
      clearInterval(timer);
      return;
    }
    secondsRemaining--;
    if (secondsRemaining > 0) {
      dom.calibCountdown.textContent = secondsRemaining;
    } else {
      clearInterval(timer);
      finalizeCalibration();
    }
  }, 1000);

  function calibFrameLoop() {
    if (AppState.currentState !== STATES.CALIBRATING) return;

    if (AppState.isDemoMode) {
      AppState.calibration.sumDEye += 0.18;
      AppState.calibration.sumLar += 0.04;
      AppState.calibration.sumYShoulder += 0.72;
      AppState.calibration.samplesCount++;
    } else if (dom.calibVideo.readyState >= 2 && AppState.faceLandmarker && AppState.poseLandmarker) {
      try {
        const ts = getNextTimestamp();
        const faceResult = AppState.faceLandmarker.detectForVideo(dom.calibVideo, ts);
        const poseResult = AppState.poseLandmarker.detectForVideo(dom.calibVideo, ts);

        if (faceResult.faceLandmarks && faceResult.faceLandmarks.length > 0 &&
            poseResult.landmarks && poseResult.landmarks.length > 0) {
          const face = faceResult.faceLandmarks[0];
          const pose = poseResult.landmarks[0];

          const dEye = calculateDEye(face);
          const lar = calculateLAR(face);
          const yShoulder = (pose[11].y + pose[12].y) / 2;

          AppState.calibration.sumDEye += dEye;
          AppState.calibration.sumLar += lar;
          AppState.calibration.sumYShoulder += yShoulder;
          AppState.calibration.samplesCount++;
        }
      } catch (e) {
        console.warn("校準幀運算略過:", e);
      }
    }
    requestAnimationFrame(calibFrameLoop);
  }
  requestAnimationFrame(calibFrameLoop);
}

function finalizeCalibration() {
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

  speakText("基準坐姿已記錄，現在開始訓練", true);
  setTimeout(() => {
    if (AppState.currentState === STATES.CALIBRATING) {
      switchViewState(STATES.TRAINING);
    }
  }, 350);
}

// ----------------------------------------------------------------------------
// 實時訓練主迴圈 (Section 5 TRAINING State)
// ----------------------------------------------------------------------------
async function runTrainingSequence() {
  if (!AppState.isDemoMode && AppState.stream) {
    dom.trainVideo.srcObject = AppState.stream;
    await dom.trainVideo.play().catch(e => console.log(e));
  }

  AppState.training.startTime = performance.now();
  AppState.training.phaseStartTime = performance.now();
  AppState.training.currentPhase = PHASES.INHALE;
  AppState.training.cycleIndex = 1;
  AppState.training.cyclesHistory = [];
  AppState.training.tInActual = 0;
  AppState.training.tExActual = 0;
  AppState.training.totalInhaleFrames = 0;
  AppState.training.validInhaleFrames = 0;
  AppState.training.totalExhaleFrames = 0;
  AppState.training.validPlbExhaleFrames = 0;
  AppState.training.totalShoulderFrames = 0;
  AppState.training.validShoulderFrames = 0;

  if (dom.btnPauseTrain) {
    dom.btnPauseTrain.textContent = "⏸️ 暫停訓練";
  }

  syncCanvasDimensions();
  window.addEventListener('resize', syncCanvasDimensions);

  applyPrivacyModeStyles();
  triggerPhaseSwitch(PHASES.INHALE);

  requestAnimationFrame(trainingInferenceLoop);
}

function syncCanvasDimensions() {
  const container = document.getElementById('vision-container');
  if (container && dom.trainCanvas) {
    dom.trainCanvas.width = container.clientWidth || 640;
    dom.trainCanvas.height = container.clientHeight || 480;
  }
}

function applyPrivacyModeStyles() {
  const mode = AppState.privacyMode;
  if (dom.selectPrivacy && dom.selectPrivacy.value !== mode) {
    dom.selectPrivacy.value = mode;
  }

  // 更新訓練畫面右上角模式按鈕高亮
  const activeCls = "px-2.5 py-1 rounded-lg text-xs font-bold bg-teal-500 text-slate-950 shadow transition cursor-pointer";
  const inactiveCls = "px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-800/90 hover:bg-slate-700 text-slate-300 transition cursor-pointer";
  if (dom.btnModeMirror) dom.btnModeMirror.className = mode === 'mirror' ? activeCls : inactiveCls;
  if (dom.btnModeMesh) dom.btnModeMesh.className = mode === 'privacy_mesh' ? activeCls : inactiveCls;
  if (dom.btnModeMinimal) dom.btnModeMinimal.className = mode === 'minimalist' ? activeCls : inactiveCls;

  if (mode === 'privacy_mesh') {
    dom.trainVideo.style.opacity = '0';
    dom.trainCanvas.style.opacity = '1';
    dom.trainCanvas.classList.add('privacy-mesh-canvas');
    dom.badgeMeshMode.textContent = AppState.isDemoMode ? "🧪 免鏡頭模擬骨架模式" : "🔒 去識別化黑底骨架模式";
    dom.badgeMeshMode.classList.remove('hidden');
  } else if (mode === 'minimalist') {
    dom.trainVideo.style.opacity = '0';
    dom.trainCanvas.style.opacity = '0';
    dom.badgeMeshMode.textContent = "🧘 純呼吸節奏球專注模式";
    dom.badgeMeshMode.classList.remove('hidden');
  } else {
    dom.trainVideo.style.opacity = AppState.isDemoMode ? '0' : '1';
    dom.trainCanvas.style.opacity = '1';
    dom.trainCanvas.classList.remove('privacy-mesh-canvas');
    dom.badgeMeshMode.textContent = "📷 實時鏡像 + AR 輔助框";
    dom.badgeMeshMode.classList.remove('hidden');
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
    finalizeCurrentCycle();
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

  // 3. 繪製視覺 Canvas 覆蓋層
  renderTrainingCanvas(AppState.lastFaceResult, AppState.lastPoseResult);

  // 4. 更新調試面板讀數
  updateDebugReadouts();

  requestAnimationFrame(trainingInferenceLoop);
}

// ----------------------------------------------------------------------------
// 逐幀特徵點運算與臨床規則評估 (Frame Processing & Clinical Rules)
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
// 右側節奏球與週期狀態機推進 (Pacer Timing & Switching)
// ----------------------------------------------------------------------------
function advanceBreathingPacer(now) {
  const train = AppState.training;
  const phaseElapsed = (now - train.phaseStartTime) / 1000;

  if (train.currentPhase === PHASES.INHALE) {
    const progress = Math.min(1, phaseElapsed / AppState.inhaleTarget);
    const secsLeft = Math.max(0, AppState.inhaleTarget - phaseElapsed).toFixed(1);
    
    dom.pacerActionText.textContent = "用鼻吸氣";
    dom.pacerSecondsText.textContent = `${secsLeft}s`;
    if (dom.pacerPhaseHint) dom.pacerPhaseHint.textContent = "閉口由鼻吸氣 · 雙肩保持下沉";
    
    const scale = 1.0 + (progress * 0.62);
    dom.pacerBall.style.transform = `scale(${scale})`;
    dom.pacerBall.className = "w-24 h-24 rounded-full bg-gradient-to-tr from-emerald-500 to-teal-300 shadow-2xl shadow-emerald-500/50 flex flex-col items-center justify-center text-slate-950 font-bold transition-transform duration-100";

    if (phaseElapsed >= AppState.inhaleTarget) {
      triggerPhaseSwitch(PHASES.EXHALE);
    }
  } else {
    const progress = Math.min(1, phaseElapsed / AppState.exhaleTarget);
    const secsLeft = Math.max(0, AppState.exhaleTarget - phaseElapsed).toFixed(1);

    dom.pacerActionText.textContent = "噘唇吹氣";
    dom.pacerSecondsText.textContent = `${secsLeft}s`;
    if (dom.pacerPhaseHint) dom.pacerPhaseHint.textContent = "嘴唇噘起如吹蠟燭 · 均勻慢呼";

    const scale = 1.62 - (progress * 0.77);
    dom.pacerBall.style.transform = `scale(${scale})`;
    dom.pacerBall.className = "w-24 h-24 rounded-full bg-gradient-to-tr from-cyan-500 to-blue-500 shadow-2xl shadow-cyan-500/50 flex flex-col items-center justify-center text-white font-bold transition-transform duration-100";

    if (phaseElapsed > (AppState.exhaleTarget * 0.5) && train.tExActual < (phaseElapsed * 0.5)) {
      updateFeedbackQueue(4, "呼氣太快完喇，試下跟住圓圈慢慢吹長啲氣");
    }

    if (phaseElapsed >= AppState.exhaleTarget) {
      finalizeCurrentCycle();
      train.cycleIndex++;
      triggerPhaseSwitch(PHASES.INHALE);
    }
  }
}

function triggerPhaseSwitch(newPhase) {
  const train = AppState.training;
  train.currentPhase = newPhase;
  train.phaseStartTime = performance.now();

  if (newPhase === PHASES.INHALE) {
    dom.pillPhase.textContent = "吸氣階段 (閉口鼻吸)";
    dom.pillPhase.className = "px-3.5 py-1.5 rounded-xl font-bold text-sm bg-slate-900/90 text-emerald-400 border border-emerald-500/40 shadow-lg backdrop-blur";
    speakText("吸氣", true);
  } else {
    dom.pillPhase.textContent = "呼氣階段 (噘唇吹氣)";
    dom.pillPhase.className = "px-3.5 py-1.5 rounded-xl font-bold text-sm bg-slate-900/90 text-cyan-400 border border-cyan-500/40 shadow-lg backdrop-blur";
    speakText("慢慢噘唇呼氣", true);
  }
}

function finalizeCurrentCycle() {
  const train = AppState.training;
  const safeTin = Math.max(train.tInActual, 0.5);
  const achievedIeRatio = train.tExActual / safeTin;

  train.cyclesHistory.push({
    cycle: train.cycleIndex,
    tInActual: train.tInActual,
    tExActual: train.tExActual,
    achievedIe: achievedIeRatio,
    targetIe: AppState.exhaleTarget / AppState.inhaleTarget
  });

  dom.badgeIeActual.textContent = `1 : ${achievedIeRatio.toFixed(1)}`;
  dom.textIeState.textContent = `1 : ${achievedIeRatio.toFixed(1)} (目標 1:${(AppState.exhaleTarget / AppState.inhaleTarget).toFixed(1)})`;

  train.tInActual = 0;
  train.tExActual = 0;
}

// ----------------------------------------------------------------------------
// 右側 3 張實時指示卡渲染 (Indicator Cards)
// ----------------------------------------------------------------------------
function renderIndicatorCards(isShoulderRelaxed) {
  const m = AppState.currentMetrics;
  const train = AppState.training;

  dom.badgePlbScore.textContent = `LAR: ${m.lar.toFixed(2)}`;
  if (train.currentPhase === PHASES.INHALE) {
    if (m.lar <= THRESHOLDS.larInhaleMax) {
      dom.textPlbState.textContent = "閉口鼻吸 (達標)";
      dom.textPlbState.className = "text-sm font-bold text-emerald-400";
      dom.cardPlb.className = "p-3 md:p-3.5 rounded-2xl bg-emerald-950/40 border border-emerald-500/40 flex items-center justify-between transition-all";
    } else {
      dom.textPlbState.textContent = "吸氣張口 (需閉口)";
      dom.textPlbState.className = "text-sm font-bold text-rose-400";
      dom.cardPlb.className = "p-3 md:p-3.5 rounded-2xl bg-rose-950/40 border border-rose-500/40 flex items-center justify-between transition-all";
    }
  } else {
    const isPlb = (m.lar >= THRESHOLDS.larExhaleMin && m.lar <= THRESHOLDS.larExhaleMax) &&
                  (m.mouthPucker >= THRESHOLDS.mouthPuckerMin || m.mouthFunnel >= THRESHOLDS.mouthFunnelMin);
    if (isPlb) {
      dom.textPlbState.textContent = "噘唇吹氣 (達標)";
      dom.textPlbState.className = "text-sm font-bold text-emerald-400";
      dom.cardPlb.className = "p-3 md:p-3.5 rounded-2xl bg-emerald-950/40 border border-emerald-500/40 flex items-center justify-between transition-all";
    } else {
      dom.textPlbState.textContent = "未形成噘唇吹氣";
      dom.textPlbState.className = "text-sm font-bold text-amber-400";
      dom.cardPlb.className = "p-3 md:p-3.5 rounded-2xl bg-amber-950/40 border border-amber-500/40 flex items-center justify-between transition-all";
    }
  }

  dom.badgeShoulderDelta.textContent = `ΔY: ${m.deltaYShoulder >= 0 ? '+' : ''}${m.deltaYShoulder.toFixed(2)}`;
  if (isShoulderRelaxed) {
    dom.textShoulderState.textContent = "放鬆沉肩 (正常)";
    dom.textShoulderState.className = "text-sm font-bold text-emerald-400";
    dom.cardShoulder.className = "p-3 md:p-3.5 rounded-2xl bg-slate-950/80 border border-slate-800 flex items-center justify-between transition-all";
    dom.cardShoulder.classList.remove('shoulder-alert-active');
  } else {
    dom.textShoulderState.textContent = "偵測到聳肩代償";
    dom.textShoulderState.className = "text-sm font-bold text-rose-400";
    dom.cardShoulder.className = "p-3 md:p-3.5 rounded-2xl bg-rose-950/60 border border-rose-500 flex items-center justify-between shoulder-alert-active transition-all";
  }
}

// ----------------------------------------------------------------------------
// Canvas 覆蓋繪製 (Section 5 Canvas Rendering & Privacy Mesh Mode)
// ----------------------------------------------------------------------------
function renderTrainingCanvas(faceResults, poseResults) {
  const canvas = dom.trainCanvas;
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
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
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
      ctx.strokeStyle = '#10b981';
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
      ctx.fillStyle = '#38bdf8';
      const ovalIndices = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
      ovalIndices.forEach(idx => {
        if (face[idx]) {
          ctx.beginPath();
          ctx.arc(face[idx].x * w, face[idx].y * h, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      });

      // 雙眼外眼角特徵點 (33, 263)
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
    ctx.strokeStyle = isGoodPlb ? '#10b981' : '#f59e0b';
    ctx.fillStyle = isGoodPlb ? 'rgba(16, 185, 129, 0.28)' : 'rgba(245, 158, 11, 0.28)';

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

  const meanRR = ((completedCycles / totalSecs) * 60).toFixed(1);

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

  speakText(`訓練完成，你共完成了${completedCycles}次呼吸週期，評級為${gradeText}`);
  loadAndRenderLocalHistory();
}

function exportDeidentifiedCSV() {
  const train = AppState.training;
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 8);

  let csvContent = "data:text/csv;charset=utf-8,";
  csvContent += "=== BreathGuide — 實時呼吸視覺生物反饋系統 匿名臨床數據報表 ===\n";
  csvContent += `訓練日期,${dateStr}\n`;
  csvContent += `訓練時間,${timeStr}\n`;
  csvContent += `總訓練秒數,${Math.round(train.elapsedSeconds)}\n`;
  csvContent += `完成循環總數,${train.cyclesHistory.length}\n`;
  csvContent += `設定目標吸呼比,1:${(AppState.exhaleTarget / AppState.inhaleTarget).toFixed(1)}\n\n`;

  csvContent += "週期序號,實測有效吸氣時間(秒),實測噘唇呼氣時間(秒),實測I:E吸呼比\n";
  train.cyclesHistory.forEach(c => {
    csvContent += `${c.cycle},${c.tInActual.toFixed(2)},${c.tExActual.toFixed(2)},1:${c.achievedIe.toFixed(2)}\n`;
  });

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `BreathGuide_Report_${dateStr}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast("📥 匿名 CSV 臨床報表已開始下載");
}

function saveSessionToLocalStorage() {
  const train = AppState.training;
  const historyKey = 'breathguide_history_v3';
  const existing = JSON.parse(localStorage.getItem(historyKey) || '[]');

  const record = {
    date: new Date().toLocaleString('zh-HK'),
    duration: Math.round(train.elapsedSeconds),
    cycles: train.cyclesHistory.length,
    plbAcc: dom.sumPlbAcc.textContent,
    shoulderAcc: dom.sumShoulderAcc.textContent,
    grade: dom.sumGrade.textContent
  };

  existing.unshift(record);
  const trimmed = existing.slice(0, 10);
  localStorage.setItem(historyKey, JSON.stringify(trimmed));
  loadAndRenderLocalHistory();
  showToast("✅ 訓練紀錄已成功儲存至本機瀏覽器");
}

function loadAndRenderLocalHistory() {
  if (!dom.listHistory) return;
  const historyKey = 'breathguide_history_v3';
  const records = JSON.parse(localStorage.getItem(historyKey) || '[]');
  
  if (records.length === 0) {
    dom.listHistory.innerHTML = `<div class="text-slate-500 py-2 text-center">暫無本地歷史紀錄（完成訓練後可點擊上方儲存）</div>`;
    return;
  }

  dom.listHistory.innerHTML = records.map((r, i) => `
    <div class="flex justify-between items-center bg-slate-950/70 px-3 py-2 rounded-xl border border-slate-800/80">
      <div>
        <span class="text-emerald-400 font-bold">#${records.length - i}</span>
        <span class="text-slate-400 ml-2">${r.date}</span>
      </div>
      <div class="space-x-3 text-right">
        <span class="text-slate-300">${r.cycles} 週期</span>
        <span class="text-teal-400">噘唇達標: ${r.plbAcc}</span>
        <span class="text-emerald-300 font-bold">${r.grade}</span>
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
}

function openDebugDrawer() {
  dom.debugDrawer.classList.remove('translate-x-full');
  if (dom.debugBackdrop) dom.debugBackdrop.classList.remove('hidden');
}

function closeDebugDrawer() {
  dom.debugDrawer.classList.add('translate-x-full');
  if (dom.debugBackdrop) dom.debugBackdrop.classList.add('hidden');
}

function highlightActiveIeButton() {
  const ratio = AppState.exhaleTarget / AppState.inhaleTarget;
  document.querySelectorAll('.btn-ie-quick').forEach(btn => {
    const btnIn = parseFloat(btn.dataset.in);
    const btnEx = parseFloat(btn.dataset.ex);
    const isMatch = Math.abs(AppState.inhaleTarget - btnIn) < 0.05 && Math.abs(AppState.exhaleTarget - btnEx) < 0.05;
    if (isMatch) {
      btn.className = "btn-ie-quick flex-1 py-1.5 rounded-xl text-xs font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/50 shadow-sm transition cursor-pointer";
    } else {
      btn.className = "btn-ie-quick flex-1 py-1.5 rounded-xl text-xs font-medium bg-slate-800/80 hover:bg-slate-700 text-slate-300 border border-slate-700 transition cursor-pointer";
    }
  });
  dom.labelIePreset.textContent = `目標 1 : ${ratio.toFixed(1)}`;
}

function setupEventListeners() {
  dom.inputInhale.addEventListener('input', (e) => {
    AppState.inhaleTarget = parseFloat(e.target.value);
    dom.valInhale.textContent = `${AppState.inhaleTarget.toFixed(1)} 秒`;
    highlightActiveIeButton();
  });

  dom.inputExhale.addEventListener('input', (e) => {
    AppState.exhaleTarget = parseFloat(e.target.value);
    dom.valExhale.textContent = `${AppState.exhaleTarget.toFixed(1)} 秒`;
    highlightActiveIeButton();
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
      highlightActiveIeButton();
      showToast(`⏱️ 已切換吸呼比為 1 : ${(exVal / inVal).toFixed(0)}（吸氣 ${inVal}s / 呼氣 ${exVal}s）`);
    });
  });

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

  dom.selectDuration.addEventListener('change', (e) => {
    AppState.totalDuration = parseInt(e.target.value, 10);
  });

  dom.toggleVoice.addEventListener('change', (e) => {
    AppState.voiceEnabled = e.target.checked;
    showToast(AppState.voiceEnabled ? "🔊 已開啟廣東話語音導航" : "🔇 已靜音語音導航");
  });

  // 啟動真實相機訓練
  dom.btnStart.addEventListener('click', () => {
    AppState.isDemoMode = false;
    switchViewState(STATES.CALIBRATING);
  });

  // 啟動免鏡頭模擬預覽訓練
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
    localStorage.removeItem('breathguide_history_v3');
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
  if (window.__breathGuideBootstrapped) return;
  window.__breathGuideBootstrapped = true;

  cacheDomElements();
  setupEventListeners();
  highlightActiveIeButton();
  initTTS();
  loadAndRenderLocalHistory();
  initMediaPipeVision();
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', bootstrapApp);
} else {
  bootstrapApp();
}
