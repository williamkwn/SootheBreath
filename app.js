/**
 * BreathGuide COPD — 實時呼吸視覺生物反饋系統 (PWA)
 * ESM Core Engine: MediaPipe Tasks Vision 0.10.14, Calibration, Math & Feedback
 * 嚴格符合 PRD Section 0 至 Section 7 規範
 */


import {
  FilesetResolver,
  FaceLandmarker,
  PoseLandmarker
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";


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


// 系統全域狀態
const AppState = {
  modelsLoadingPromise: null,
  lastTimestampMs: 0,
  currentState: STATES.IDLE,
  currentState: STATES.IDLE,
  stream: null,
  faceLandmarker: null,
  poseLandmarker: null,
  
  // 使用者設定
  inhaleTarget: 2.0,      // 秒
  exhaleTarget: 4.0,      // 秒
  totalDuration: 120,     // 秒
  privacyMode: 'privacy_mesh', // 'mirror' | 'privacy_mesh' | 'minimalist'
  voiceEnabled: true,
  
  // 3秒基準校準結果 (Baseline Calibration)
  calibration: {
    dEyeBase: 0,
    yShoulderBase: 0,
    larRest: 0,
    samplesCount: 0,
    sumDEye: 0,
    sumYShoulder: 0,
    sumLar: 0
    sumLar: 0,
    timerId: null
  },


  // 實時推論變數
  currentMetrics: {
    dEye: 0,
    lar: 0,
    mouthPucker: 0,
    mouthFunnel: 0,
    yShoulderCurr: 0,
    deltaYShoulder: 0,
    shoulderTilt: 0,
    hasFace: false,
    hasPose: false
    hasPose: false,
    lastFaceLandmarks: null,
    lastPoseLandmarks: null
  },


  // 訓練過程狀態機
  training: {
    startTime: 0,
    lastFrameTime: 0,
    elapsedSeconds: 0,
    currentPhase: PHASES.INHALE,
    phaseStartTime: 0,
    cycleIndex: 0,
    
    // 當前週期累計有效時間
    tInActual: 0,
    tExActual: 0,
    phaseFramesTotal: 0,
    phaseFramesValid: 0,
    
    // 全程統計指標
    cyclesHistory: [], // 每週期的詳細數據
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
    cooldownMs: 4500,
    speechSynthesisVoice: null,
    unlocked: false
  }
};


// ============================================================================
// 2. DOM 元素快取 (DOM Element References)
// ============================================================================
const dom = {
  // 狀態視圖容器
  toastNotification: document.getElementById('toast-notification'),
  stateIdle: document.getElementById('state-idle'),
  stateCalib: document.getElementById('state-calibrating'),
  stateTrain: document.getElementById('state-training'),
  stateSummary: document.getElementById('state-summary'),
  bottomBanner: document.getElementById('bottom-banner'),


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
  btnStopEarly: document.getElementById('btn-stop-early'),
  btnRestart: document.getElementById('btn-restart'),
  btnExportCsv: document.getElementById('btn-export-csv'),
  btnSaveLocal: document.getElementById('btn-save-local'),
  btnClearHistory: document.getElementById('btn-clear-history'),


  // 校準與訓練視訊/畫布
  calibContainer: document.getElementById('calib-container'),
  calibStatusText: document.getElementById('calib-status-text'),
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


// ============================================================================
// 3. MediaPipe 0.10.14 ESM 模型初始化 (Model Initialization)
// ============================================================================
async function initMediaPipeVision() {
  if (AppState.faceLandmarker && AppState.poseLandmarker) return;
  if (AppState.modelsLoadingPromise) return AppState.modelsLoadingPromise;
  AppState.modelsLoadingPromise = (async () => {
  try {
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
    );


    // 1. Face Landmarker (Float16 Model with Blendshapes)
    AppState.faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        delegate: "GPU"
      },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true
    });


    // 2. Pose Landmarker (Lite Model)
    AppState.poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
        delegate: "GPU"
      },
      runningMode: "VIDEO",
      numPoses: 1
    });


    console.log("MediaPipe Tasks Vision 0.10.14 模型加載成功");
  } catch (err) {
    console.warn("GPU 加載失敗，嘗試切換 CPU 委派模式:", err);
    try {
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
      );
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
    } catch (fallbackErr) {
      console.error("MediaPipe 初始化完全失敗:", fallbackErr);
      showCameraDiagnosticError({ name: 'ModelLoadError', message: '無法從 Google CDN 加載 MediaPipe 視覺模型，請檢查網路連線或防火牆設定。' });
    }
  }
  })();
  return AppState.modelsLoadingPromise;
}


function detectVideoFrameSafe(videoEl) {
  if (!videoEl || videoEl.readyState < 2 || !videoEl.videoWidth || !AppState.faceLandmarker || !AppState.poseLandmarker) {
    return null;
  }
  const rawNow = Math.floor(performance.now());
  const safeTimestampMs = Math.max(rawNow, AppState.lastTimestampMs + 1);
  AppState.lastTimestampMs = safeTimestampMs;
  try {
    const faceResult = AppState.faceLandmarker.detectForVideo(videoEl, safeTimestampMs);
    const poseResult = AppState.poseLandmarker.detectForVideo(videoEl, safeTimestampMs);
    return { faceResult, poseResult };
  } catch (err) {
    console.warn("MediaPipe 單幀推論跳過:", err);
    return null;
  }
}


// ============================================================================
// 4. WebRTC 相機啟動與診斷規格 (Section 6 Camera Diagnostics)
// ============================================================================
async function startCamera(videoElement) {
  // 檢查是否處於安全環境 (HTTPS 或 localhost)
  const isSecure = window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!isSecure) {
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
        videoElement.play();
        resolve();
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
        <p>3. <b>iPad / Mac 用家</b>：請檢查 系統設定 > 私隱與安全性 > 相機，確認 Safari / Chrome 已獲授權。</p>
        <p>4. <b>Windows 用家</b>：請檢查 Windows 設定 > 私隱 > 相機，開啟「允許桌面應用程式存取相機」。</p>
      `;
      break;


    case 'NotFoundError':
    case 'DevicesNotFoundError':
      title = "未偵測到鏡頭硬體 (Not Found)";
      desc = "系統找不到任何可用的視訊輸入裝置。";
      stepsHtml = `
        <p>1. 請檢查手提電腦 (Laptop) 鏡頭上方的<b>實體防窺撥片 (Privacy Shutter)</b> 是否已打開。</p>
        <p>2. 部分品牌電腦（如 Lenovo、ASUS、MSI）配有鍵盤相機開關快速鍵（例如 Fn + F8 或 F10）。</p>
        <p>3. 若使用外接 USB 鏡頭，請確認連接埠插頭穩固。</p>
      `;
      break;


    case 'NotReadableError':
    case 'TrackStartError':
      title = "鏡頭被其他應用程式佔用 (Camera Occupied)";
      desc = "相機硬體正在被其他視訊通話或後台程式使用。";
      stepsHtml = `
        <p>1. 請檢查並先完全關閉 <b>Zoom、Microsoft Teams、Google Meet、FaceTime</b> 或其他相機軟件。</p>
        <p>2. 重新整理本網頁後再試一次。</p>
      `;
      break;


    case 'ModelLoadError':
      title = "AI 視覺模型加載受阻";
      desc = error.message || "無法從 CDN 下載 MediaPipe WASM 與模型檔案。";
      stepsHtml = `
        <p>1. 請檢查您的裝置網路連線是否正常。</p>
        <p>2. 若在公司或醫院網路，請確認防火牆未封鎖 <code>cdn.jsdelivr.net</code> 與 <code>storage.googleapis.com</code>。</p>
        <p>3. 重新整理網頁再試一次。</p>
      `;
      break;


    default:
      title = "未知相機存取錯誤 (" + (error.name || "Error") + ")";
      desc = error.message || "系統發生未預期的鏡頭存取問題。";
      stepsHtml = `<p>請嘗試重新整理瀏覽器或重新啟動裝置。</p>`;
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


function mapNormalizedToCanvas(normX, normY, videoEl, canvasEl) {
  const cw = canvasEl.width || 1;
  const ch = canvasEl.height || 1;
  const vw = (videoEl && videoEl.videoWidth) ? videoEl.videoWidth : cw;
  const vh = (videoEl && videoEl.videoHeight) ? videoEl.videoHeight : ch;
  const scale = Math.max(cw / vw, ch / vh);
  const renderedW = vw * scale;
  const renderedH = vh * scale;
  const offsetX = (cw - renderedW) / 2;
  const offsetY = (ch - renderedH) / 2;
  return {
    x: normX * renderedW + offsetX,
    y: normY * renderedH + offsetY
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
    // 優先匹配廣東話 zh-HK，其次台灣國語 zh-TW
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


function unlockTTSOnUserGesture() {
  if (AppState.tts.unlocked || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance('');
    u.volume = 0;
    window.speechSynthesis.speak(u);
    AppState.tts.unlocked = true;
  } catch (e) {
    console.warn("TTS Unlock Error:", e);
  }
}


function speakText(text, isPhaseSwitch = false) {
  if (!AppState.voiceEnabled || !('speechSynthesis' in window)) return;


  const now = performance.now();
  // 強制相隔 4500ms 冷卻時間；若為階段切換（吸氣/呼氣）則優先播報
  if (!isPhaseSwitch && (now - AppState.tts.lastSpokenTime < AppState.tts.cooldownMs)) {
    return;
  }


  try {
    window.speechSynthesis.cancel(); // 停止先前的口令
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-HK';
    utterance.rate = 0.95; // 稍慢語速，適合長者聽清楚
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


  // 所有提示切換統一過 800ms 防閃爍 Window
  if (message !== fb.currentPMessage) {
    if (fb.pendingMessage !== message) {
      fb.pendingMessage = message;
      fb.pendingPriority = priority;
      fb.pendingTimestamp = now;
    } else if (now - fb.pendingTimestamp >= fb.debounceMs) {
      fb.currentPriority = priority;
      fb.currentPMessage = message;
      renderBottomBanner(message, priority);
      if (priority <= 4) {
        speakText(message, false);
      }
    }
  } else {
    fb.pendingMessage = '';
  }
}


function renderBottomBanner(message, priority) {
  dom.bottomBanner.textContent = message;
  dom.bottomBanner.classList.remove('hidden');


  // 樣式對齊優先級
  if (priority <= 2) {
    dom.bottomBanner.className = "shrink-0 w-full py-3.5 px-6 text-center z-30 font-extrabold text-2xl md:text-3xl leading-snug border-t border-rose-600 bg-rose-950 text-rose-200";
  } else if (priority <= 4) {
    dom.bottomBanner.className = "shrink-0 w-full py-3.5 px-6 text-center z-30 font-extrabold text-2xl md:text-3xl leading-snug border-t border-amber-600 bg-amber-950 text-amber-200";
  } else {
    dom.bottomBanner.className = "shrink-0 w-full py-3.5 px-6 text-center z-30 font-extrabold text-2xl md:text-3xl leading-snug border-t border-emerald-600 bg-emerald-950 text-emerald-300";
  }
}


// ============================================================================
// 8. 狀態一至四之生命週期 (State Machine Lifecycle)
// ============================================================================


// 切換主視圖
function switchViewState(targetState) {
  AppState.currentState = targetState;
  if (AppState.calibration.timerId) {
    clearInterval(AppState.calibration.timerId);
    AppState.calibration.timerId = null;
  }


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
  const [started] = await Promise.all([
    startCamera(dom.calibVideo),
    initMediaPipeVision()
  ]);
  if (!started) {
    switchViewState(STATES.IDLE);
    return;
  }


  // 重置校準累計器
  AppState.calibration = {
    dEyeBase: 0,
    yShoulderBase: 0,
    larRest: 0,
    samplesCount: 0,
    sumDEye: 0,
    sumYShoulder: 0,
    sumLar: 0
  };


  speakText("請自然坐直、沉肩放鬆、閉上嘴巴，正在記錄基準坐姿", true);


  let secondsRemaining = 3;
  dom.calibCountdown.textContent = secondsRemaining;


  AppState.calibration.timerId = setInterval(() => {
    secondsRemaining--;
    if (secondsRemaining > 0) {
      dom.calibCountdown.textContent = secondsRemaining;
    } else {
      clearInterval(AppState.calibration.timerId);
      AppState.calibration.timerId = null;
      finalizeCalibration();
    }
  }, 1000);


  // 幀迴圈收集座標
  function calibFrameLoop() {
    if (AppState.currentState !== STATES.CALIBRATING) return;


    const detection = detectVideoFrameSafe(dom.calibVideo);
    if (detection && detection.faceResult && detection.poseResult) {
      const faceResult = detection.faceResult;
      const poseResult = detection.poseResult;


      if (faceResult.faceLandmarks.length > 0 && poseResult.landmarks.length > 0) {
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
    }
    requestAnimationFrame(calibFrameLoop);
  }
  requestAnimationFrame(calibFrameLoop);
}


function finalizeCalibration() {
  const c = AppState.calibration;
  if (c.samplesCount > 10) {
    c.dEyeBase = c.sumDEye / c.samplesCount;
    c.larRest = c.sumLar / c.samplesCount;
    c.yShoulderBase = c.sumYShoulder / c.samplesCount;
  } else {
    // 預設容錯常數
    c.dEyeBase = 0.22;
    c.larRest = 0.05;
    c.yShoulderBase = 0.65;
  }


  console.log("3秒基準校準完成:", {
    dEyeBase: c.dEyeBase.toFixed(3),
    larRest: c.larRest.toFixed(3),
    yShoulderBase: c.yShoulderBase.toFixed(3),
    samples: c.samplesCount
  });


  speakText("基準坐姿已記錄，現在開始訓練", true);
  setTimeout(() => {
    switchViewState(STATES.TRAINING);
  }, 600);
}


// ----------------------------------------------------------------------------
// 實時訓練主迴圈 (Section 5 TRAINING State)
// ----------------------------------------------------------------------------
async function runTrainingSequence() {
  // 將視訊流引導至訓練 video 標籤
  dom.trainVideo.srcObject = AppState.stream;
  await dom.trainVideo.play().catch(e => console.log(e));


  // 重置訓練統計
  AppState.training.startTime = performance.now();
  AppState.training.lastFrameTime = performance.now();
  AppState.training.phaseStartTime = performance.now();
  AppState.training.currentPhase = PHASES.INHALE;
  AppState.training.cycleIndex = 1;
  AppState.training.cyclesHistory = [];
  AppState.training.tInActual = 0;
  AppState.training.tExActual = 0;
  AppState.training.phaseFramesTotal = 0;
  AppState.training.phaseFramesValid = 0;
  AppState.training.totalInhaleFrames = 0;
  AppState.training.validInhaleFrames = 0;
  AppState.training.totalExhaleFrames = 0;
  AppState.training.validPlbExhaleFrames = 0;
  AppState.training.totalShoulderFrames = 0;
  AppState.training.validShoulderFrames = 0;


  // 設定畫布尺寸
  syncCanvasDimensions();
  window.addEventListener('resize', syncCanvasDimensions);


  // 應用私隱模式外觀
  applyPrivacyModeStyles();


  // 播報首次口令
  triggerPhaseSwitch(PHASES.INHALE);


  // 啟動主渲染與推論迴圈
  requestAnimationFrame(trainingInferenceLoop);
}


function syncCanvasDimensions() {
  const container = document.getElementById('vision-container');
  if (container && dom.trainCanvas) {
    dom.trainCanvas.width = container.clientWidth;
    dom.trainCanvas.height = container.clientHeight;
  }
}


function applyPrivacyModeStyles() {
  const mode = AppState.privacyMode;
  dom.trainCanvas.style.opacity = '1';
  if (mode === 'privacy_mesh') {
    dom.trainVideo.style.opacity = '0';
    dom.trainCanvas.classList.add('privacy-mesh-canvas');
    dom.badgeMeshMode.classList.remove('hidden');
  } else if (mode === 'minimalist') {
    dom.trainVideo.style.opacity = '0';
    dom.trainCanvas.style.opacity = '0';
    dom.badgeMeshMode.classList.add('hidden');
  } else {
    // mirror mode
    dom.trainVideo.style.opacity = '1';
    dom.trainCanvas.classList.remove('privacy-mesh-canvas');
    dom.badgeMeshMode.classList.add('hidden');
  }
}


// 主推論迴圈 (Inference Loop)
function trainingInferenceLoop() {
  if (AppState.currentState !== STATES.TRAINING) return;


  const now = performance.now();
  const train = AppState.training;
  const elapsedTotal = (now - train.startTime) / 1000;
  train.elapsedSeconds = elapsedTotal;


  // 更新剩餘時間
  const remainingTotal = Math.max(0, AppState.totalDuration - elapsedTotal);
  const mins = Math.floor(remainingTotal / 60);
  const secs = Math.floor(remainingTotal % 60);
  dom.valTimerLeft.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  dom.valCycleCount.textContent = train.cycleIndex;


  // 檢查是否訓練時間結束
  if (remainingTotal <= 0) {
    finalizeCurrentCycle();
    switchViewState(STATES.SUMMARY);
    return;
  }


  const dt = Math.min(0.1, Math.max(0, (now - train.lastFrameTime) / 1000));
  train.lastFrameTime = now;


  // 1. 執行 Safe 單幀推論
  const detection = detectVideoFrameSafe(dom.trainVideo);
  if (detection) {
    processFrameDetections(detection.faceResult, detection.poseResult, dt, now);
  }


  // 2. 呼吸節奏狀態機推進 (Pacer Timing & State Machine)
  advanceBreathingPacer(now);


  // 3. 繪製視覺 Canvas 覆蓋層 (Privacy Mesh / AR)
  renderTrainingCanvas();


  // 4. 更新除錯面板讀數
  updateDebugReadouts();


  requestAnimationFrame(trainingInferenceLoop);
}


// ----------------------------------------------------------------------------
// 逐幀特徵點運算與臨床規則評估 (Frame Processing & Clinical Rules)
// ----------------------------------------------------------------------------
function processFrameDetections(faceResult, poseResult, dt, now) {
  const m = AppState.currentMetrics;
  const cal = AppState.calibration;
  const train = AppState.training;


  const hasFace = faceResult && faceResult.faceLandmarks && faceResult.faceLandmarks.length > 0;
  const hasPose = poseResult && poseResult.landmarks && poseResult.landmarks.length > 0;
  m.hasFace = hasFace;
  m.hasPose = hasPose;
  m.lastFaceLandmarks = hasFace ? faceResult.faceLandmarks[0] : null;
  m.lastPoseLandmarks = hasPose ? poseResult.landmarks[0] : null;


  // P1 檢查：是否遺失面部或雙肩
  if (!hasFace || !hasPose) {
    updateFeedbackQueue(1, "請調整坐姿，確保面部及雙肩喺鏡頭框內");
    return;
  }


  const face = faceResult.faceLandmarks[0];
  const pose = poseResult.landmarks[0];


  // 計算幾何指標
  m.dEye = calculateDEye(face);
  m.lar = calculateLAR(face);
  const blendshapes = extractBlendshapes(faceResult.faceBlendshapes);
  m.mouthPucker = blendshapes.mouthPucker;
  m.mouthFunnel = blendshapes.mouthFunnel;


  const shoulder = calculateShoulderMetrics(pose, m.dEye, cal.yShoulderBase);
  m.yShoulderCurr = shoulder.yShoulderCurr;
  m.deltaYShoulder = shoulder.deltaYShoulder;
  m.shoulderTilt = shoulder.shoulderTilt;


  // 臨床指標統計
  train.totalShoulderFrames++;
  const isShoulderRelaxed = m.deltaYShoulder <= THRESHOLDS.shoulderHikeWarn;
  if (isShoulderRelaxed) {
    train.validShoulderFrames++;
  }


  // 判定當前階段 (吸氣 vs 呼氣) 臨床達標狀況
  if (train.currentPhase === PHASES.INHALE) {
    train.totalInhaleFrames++;
    const isMouthClosed = m.lar <= THRESHOLDS.larInhaleMax;


    if (isMouthClosed && isShoulderRelaxed) {
      train.validInhaleFrames++;
      train.tInActual += dt;
    }


    // 優先級判斷 (吸氣階段)
    if (m.deltaYShoulder > THRESHOLDS.shoulderHikeWarn) {
      updateFeedbackQueue(2, "偵測到聳肩用力，請沉肩放鬆");
    } else if (m.lar > THRESHOLDS.larInhaleErr) {
      updateFeedbackQueue(3, "請閉上嘴巴，用鼻慢慢吸氣");
    } else {
      updateFeedbackQueue(5, "做得好，用鼻吸氣，沉肩放鬆");
    }


  } else {
    // 呼氣階段 (EXHALE - Pursed-Lip Breathing)
    train.totalExhaleFrames++;
    const isPlbShape = 
      (m.lar >= THRESHOLDS.larExhaleMin && m.lar <= THRESHOLDS.larExhaleMax) &&
      (m.mouthPucker >= THRESHOLDS.mouthPuckerMin || m.mouthFunnel >= THRESHOLDS.mouthFunnelMin);


    if (isPlbShape) {
      train.validPlbExhaleFrames++;
      train.tExActual += dt;
    }


    const phaseElapsed = (now - train.phaseStartTime) / 1000;
    // 優先級判斷 (呼氣階段)
    if (m.deltaYShoulder > THRESHOLDS.shoulderHikeWarn) {
      updateFeedbackQueue(2, "呼氣時請保持雙肩放鬆，切勿聳肩");
    } else if (m.lar > THRESHOLDS.larExhaleWideErr && m.mouthPucker < THRESHOLDS.puckerWideErrMax) {
      updateFeedbackQueue(3, "請將嘴唇噘起成吹口哨狀，唔好張大口呼氣");
    } else if (m.lar < THRESHOLDS.larExhaleClosedErr && m.mouthPucker < THRESHOLDS.puckerClosedErrMax) {
      updateFeedbackQueue(3, "請微微嘟起嘴唇，慢慢吹氣出嚟");
    } else if (phaseElapsed > (AppState.exhaleTarget * 0.5) && train.tExActual < (phaseElapsed * 0.5)) {
      updateFeedbackQueue(4, "呼氣太快完喇，試下跟住圓圈慢慢吹長啲氣");
    } else {
      updateFeedbackQueue(5, "噘唇嘴型很好，繼續慢慢吹長氣");
    }
  }


  // 更新右側 3 張實時指示卡
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
    
    // 動態球縮放與光暈
    const scale = 1.0 + (progress * 0.65);
    dom.pacerBall.style.transform = `scale(${scale})`;
    dom.pacerBall.className = "w-24 h-24 rounded-full bg-gradient-to-tr from-emerald-500 to-teal-400 shadow-2xl shadow-emerald-500/50 flex flex-col items-center justify-center text-slate-950 font-bold transition-transform duration-100";


    // 達到吸氣目標秒數，切換至呼氣
    if (phaseElapsed >= AppState.inhaleTarget) {
      triggerPhaseSwitch(PHASES.EXHALE);
    }
  } else {
    // 呼氣階段
    const progress = Math.min(1, phaseElapsed / AppState.exhaleTarget);
    const secsLeft = Math.max(0, AppState.exhaleTarget - phaseElapsed).toFixed(1);


    dom.pacerActionText.textContent = "噘唇吹氣";
    dom.pacerSecondsText.textContent = `${secsLeft}s`;


    // 球體平滑縮小至吹氣狀態
    const scale = 1.65 - (progress * 0.80);
    dom.pacerBall.style.transform = `scale(${scale})`;
    dom.pacerBall.className = "w-24 h-24 rounded-full bg-gradient-to-tr from-cyan-500 to-blue-500 shadow-2xl shadow-blue-500/50 flex flex-col items-center justify-center text-white font-bold transition-transform duration-100";


    // 達到呼氣目標秒數，記錄週期並切換回吸氣
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


  // 更新指示卡上的吸呼比讀數
  dom.badgeIeActual.textContent = `1 : ${achievedIeRatio.toFixed(1)}`;
  dom.textIeState.textContent = `1 : ${achievedIeRatio.toFixed(1)} (目標 1:${(AppState.exhaleTarget / AppState.inhaleTarget).toFixed(0)})`;


  // 重置該週期計數
  train.tInActual = 0;
  train.tExActual = 0;
}


// ----------------------------------------------------------------------------
// 右側 3 張實時指示卡渲染 (Indicator Cards)
// ----------------------------------------------------------------------------
function renderIndicatorCards(isShoulderRelaxed) {
  const m = AppState.currentMetrics;
  const train = AppState.training;


  // 1. 嘴型狀態卡
  dom.badgePlbScore.textContent = `LAR: ${m.lar.toFixed(2)}`;
  if (train.currentPhase === PHASES.INHALE) {
    if (m.lar <= THRESHOLDS.larInhaleMax) {
      dom.textPlbState.textContent = "閉口鼻吸 (達標)";
      dom.textPlbState.className = "text-sm font-bold text-emerald-400";
      dom.cardPlb.className = "p-3 md:p-3.5 rounded-2xl bg-emerald-950/40 border border-emerald-500/40 flex items-center justify-between";
    } else {
      dom.textPlbState.textContent = "吸氣張口 (需閉口)";
      dom.textPlbState.className = "text-sm font-bold text-rose-400";
      dom.cardPlb.className = "p-3 md:p-3.5 rounded-2xl bg-rose-950/40 border border-rose-500/40 flex items-center justify-between";
    }
  } else {
    // 呼氣階段
    const isPlb = (m.lar >= THRESHOLDS.larExhaleMin && m.lar <= THRESHOLDS.larExhaleMax) &&
                  (m.mouthPucker >= THRESHOLDS.mouthPuckerMin || m.mouthFunnel >= THRESHOLDS.mouthFunnelMin);
    if (isPlb) {
      dom.textPlbState.textContent = "噘唇吹氣 (達標)";
      dom.textPlbState.className = "text-sm font-bold text-emerald-400";
      dom.cardPlb.className = "p-3 md:p-3.5 rounded-2xl bg-emerald-950/40 border border-emerald-500/40 flex items-center justify-between";
    } else {
      dom.textPlbState.textContent = "未形成噘唇吹氣";
      dom.textPlbState.className = "text-sm font-bold text-amber-400";
      dom.cardPlb.className = "p-3 md:p-3.5 rounded-2xl bg-amber-950/40 border border-amber-500/40 flex items-center justify-between";
    }
  }


  // 2. 雙肩狀態卡
  dom.badgeShoulderDelta.textContent = `ΔY: ${m.deltaYShoulder >= 0 ? '+' : ''}${m.deltaYShoulder.toFixed(2)}`;
  if (isShoulderRelaxed) {
    dom.textShoulderState.textContent = "放鬆沉肩 (正常)";
    dom.textShoulderState.className = "text-sm font-bold text-emerald-400";
    dom.cardShoulder.className = "p-3 md:p-3.5 rounded-2xl bg-slate-950/80 border border-slate-800 flex items-center justify-between";
    dom.cardShoulder.classList.remove('shoulder-alert-active');
  } else {
    dom.textShoulderState.textContent = "偵測到聳肩代償";
    dom.textShoulderState.className = "text-sm font-bold text-rose-400";
    dom.cardShoulder.className = "p-3 md:p-3.5 rounded-2xl bg-rose-950/60 border border-rose-500 flex items-center justify-between shoulder-alert-active";
  }
}


// ----------------------------------------------------------------------------
// Canvas 覆蓋繪製 (Section 5 Canvas Rendering & Privacy Mesh Mode)
// ----------------------------------------------------------------------------
function renderTrainingCanvas() {
  const canvas = dom.trainCanvas;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const mode = AppState.privacyMode;
  const m = AppState.currentMetrics;


  // 清空畫布
  ctx.clearRect(0, 0, w, h);


  if (mode === 'minimalist') return;


  // 去識別化黑底模式 (Privacy Mesh Mode) 填滿背景 #0f172a
  if (mode === 'privacy_mesh') {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, w, h);
  }


  if (!m.hasFace && !m.hasPose) return;


  // 繪製雙肩骨架連線
  if (m.hasPose && m.lastPoseLandmarks) {
    const pose = m.lastPoseLandmarks;
    const p11 = mapNormalizedToCanvas(pose[11].x, pose[11].y, dom.trainVideo, canvas);
    const p12 = mapNormalizedToCanvas(pose[12].x, pose[12].y, dom.trainVideo, canvas);


      ctx.save();
      ctx.lineWidth = 4;
      if (m.deltaYShoulder > THRESHOLDS.shoulderHikeWarn) {
        ctx.strokeStyle = '#ef4444'; // 紅色警示連線
        ctx.setLineDash([8, 6]);
      } else {
        ctx.strokeStyle = mode === 'privacy_mesh' ? '#0d9488' : '#10b981';
        ctx.setLineDash([]);
      }


      ctx.beginPath();
      ctx.moveTo(p11.x, p11.y);
      ctx.lineTo(p12.x, p12.y);
      ctx.stroke();
      // 繪製校準基準肩膀水平線 (Baseline Shoulder Line)
      if (AppState.calibration && AppState.calibration.yShoulderBase) {
        const basePt = mapNormalizedToCanvas(0.5, AppState.calibration.yShoulderBase, dom.trainVideo, canvas);
        ctx.save();
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.6)';
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        ctx.moveTo(0, basePt.y);
        ctx.lineTo(w, basePt.y);
        ctx.stroke();
        ctx.restore();
      }


      // 繪製雙肩端點關節球
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.arc(p11.x, p11.y, 6, 0, Math.PI * 2);
      ctx.arc(p12.x, p12.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }


  // 繪製嘴唇與面部多邊形
  if (m.hasFace && m.lastFaceLandmarks) {
    const face = m.lastFaceLandmarks;


      // 若為去識別化模式，繪製面部外輪廓去識別點
      if (mode === 'privacy_mesh') {
        ctx.fillStyle = '#334155';
        const ovalIndices = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
        ovalIndices.forEach(idx => {
          if (face[idx]) {
            const pt = mapNormalizedToCanvas(face[idx].x, face[idx].y, dom.trainVideo, canvas);
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 2, 0, Math.PI * 2);
            ctx.fill();
          }
          }
        });
      }


      // 繪製嘴唇核心幾何輪廓 (13, 14, 78, 308 及外唇點)
      const lipPoints = [78, 13, 308, 14].map(idx => mapNormalizedToCanvas(face[idx].x, face[idx].y, dom.trainVideo, canvas));


      ctx.save();
      ctx.lineWidth = 3;
      const train = AppState.training;
      let isTargetShape = false;
      if (train.currentPhase === PHASES.INHALE) {
        isTargetShape = m.lar <= THRESHOLDS.larInhaleMax;
      } else {
        isTargetShape = (m.lar >= THRESHOLDS.larExhaleMin && m.lar <= THRESHOLDS.larExhaleMax) &&
                        (m.mouthPucker >= THRESHOLDS.mouthPuckerMin || m.mouthFunnel >= THRESHOLDS.mouthFunnelMin);
      }
      ctx.strokeStyle = isTargetShape ? '#10b981' : '#ef4444';
      ctx.fillStyle = isTargetShape ? 'rgba(16, 185, 129, 0.25)' : 'rgba(239, 68, 68, 0.25)';


      ctx.beginPath();
      ctx.moveTo(lipPoints[0].x, lipPoints[0].y);
      for (let i = 1; i < lipPoints.length; i++) {
        ctx.lineTo(lipPoints[i].x, lipPoints[i].y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();


      // 在 Mirror Mode 下加繪嘴型狀態提示文字
      if (mode === 'mirror') {
        ctx.save();
        ctx.scale(-1, 1);
        ctx.fillStyle = '#ffffff';
        ctx.font = '12px sans-serif';
        ctx.fillText(`LAR: ${m.lar.toFixed(2)}`, -lipPoints[0].x - 40, lipPoints[0].y - 12);
        ctx.restore();
      }


      ctx.restore();
    }
  }
}


// ----------------------------------------------------------------------------
// 9. 總結報告生成與 CSV 匯出 (Section 5 Summary & CSV Export)
// ----------------------------------------------------------------------------
function renderSummaryReport() {
  const train = AppState.training;
  const totalSecs = Math.max(1, Math.round(train.elapsedSeconds));
  const completedCycles = train.cyclesHistory.length;


  // 1. 平均呼吸頻率 (Mean RR, breaths/min)
  const meanRR = ((completedCycles / totalSecs) * 60).toFixed(1);


  // 2. 實測平均吸呼比 (Mean Achieved I:E)
  let sumIe = 0;
  train.cyclesHistory.forEach(c => sumIe += c.achievedIe);
  const meanIe = completedCycles > 0 ? (sumIe / completedCycles).toFixed(1) : "2.0";


  // 3. 噘唇嘴型達標率 (PLB Accuracy %)
  const plbAcc = train.totalExhaleFrames > 0 
    ? Math.round((train.validPlbExhaleFrames / train.totalExhaleFrames) * 100) 
    : 0;


  // 4. 雙肩放鬆達標率 (Shoulder Relaxation %)
  const shoulderAcc = train.totalShoulderFrames > 0 
    ? Math.round((train.validShoulderFrames / train.totalShoulderFrames) * 100) 
    : 0;


  // 綜合評級 (Grade)
  let gradeText = "優秀 (A)";
  if (plbAcc < 70 || shoulderAcc < 75) {
    gradeText = "需加強練習 (C)";
  } else if (plbAcc < 85 || shoulderAcc < 85) {
    gradeText = "良好 (B)";
  }


  // 寫入畫面
  dom.sumCycles.textContent = `${completedCycles} 週期`;
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  dom.sumDuration.textContent = `總時間 ${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  dom.sumRr.textContent = meanRR;
  dom.sumIe.textContent = `1 : ${meanIe}`;
  dom.sumPlbAcc.textContent = `${plbAcc}%`;
  dom.sumShoulderAcc.textContent = `${shoulderAcc}%`;
  dom.sumGrade.textContent = gradeText;


  // 播報語音祝賀
  speakText(`訓練完成，你共完成了${completedCycles}次呼吸週期，評級為${gradeText}`);


  // 刷新歷史紀錄表
  loadAndRenderLocalHistory();
}


// 匯出匿名 CSV 臨床報表
function exportDeidentifiedCSV() {
  const train = AppState.training;
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 8);


  let csvText = "\uFEFF";
  csvText += "=== BreathGuide COPD 臨床呼吸復康匿名數據報表 ===\n";
  csvText += `訓練日期,${dateStr}\n`;
  csvText += `訓練時間,${timeStr}\n`;
  csvText += `總訓練秒數,${Math.round(train.elapsedSeconds)}\n`;
  csvText += `完成循環總數,${train.cyclesHistory.length}\n`;
  csvText += `設定目標吸呼比,1:${(AppState.exhaleTarget / AppState.inhaleTarget).toFixed(1)}\n\n`;


  csvText += "週期序號,實測有效吸氣時間(秒),實測噘唇呼氣時間(秒),實測I:E吸呼比\n";
  train.cyclesHistory.forEach(c => {
    csvText += `${c.cycle},${c.tInActual.toFixed(2)},${c.tExActual.toFixed(2)},1:${c.achievedIe.toFixed(2)}\n`;
  });


  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `BreathGuide_COPD_Report_${dateStr}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}


// 儲存至本地 localStorage
function saveSessionToLocalStorage() {
  try {
  const train = AppState.training;
  const historyKey = 'breathguide_copd_history';
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
  const trimmed = existing.slice(0, 10); // 保存最近 10 次
  localStorage.setItem(historyKey, JSON.stringify(trimmed));
  loadAndRenderLocalHistory();
  showToastNotification("✅ 訓練紀錄已成功保存在本機瀏覽器。");
  } catch (e) {
    console.warn("localStorage save error:", e);
    showToastNotification("⚠️ 保存失敗，可能處於無痕模式或空間不足。");
  }
}


function showToastNotification(msg) {
  if (!dom.toastNotification) return;
  dom.toastNotification.textContent = msg;
  dom.toastNotification.classList.remove('hidden');
  setTimeout(() => {
    dom.toastNotification.classList.add('hidden');
  }, 3000);
}


function loadAndRenderLocalHistory() {
  let records = [];
  try {
    records = JSON.parse(localStorage.getItem('breathguide_copd_history') || '[]');
  } catch (e) {
    records = [];
  }
  
  if (records.length === 0) {
    dom.listHistory.innerHTML = `<div class="text-slate-500 py-1">暫無本地歷史紀錄</div>`;
    return;
  }


  dom.listHistory.innerHTML = records.map((r, i) => `
    <div class="flex justify-between items-center bg-slate-950/60 p-2 rounded border border-slate-800">
      <div>
        <span class="text-emerald-400 font-bold">#${records.length - i}</span>
        <span class="text-slate-400 ml-1.5">${r.date}</span>
      </div>
      <div class="space-x-2 text-right">
        <span>${r.cycles} 週期</span>
        <span class="text-teal-400">PLB: ${r.plbAcc}</span>
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
  dom.dbgLar.textContent = m.lar.toFixed(3);
  dom.dbgPucker.textContent = m.mouthPucker.toFixed(3);
  dom.dbgFunnel.textContent = m.mouthFunnel.toFixed(3);
  dom.dbgShoulder.textContent = m.deltaYShoulder.toFixed(3);
  dom.dbgDeye.textContent = m.dEye.toFixed(3);
  dom.dbgTilt.textContent = m.shoulderTilt.toFixed(3);
}


function setupEventListeners() {
  // 吸呼秒數滑桿聯動
  dom.inputInhale.addEventListener('input', (e) => {
    AppState.inhaleTarget = parseFloat(e.target.value);
    dom.valInhale.textContent = `${AppState.inhaleTarget.toFixed(1)} 秒`;
    updateIePresetBadge();
  });


  dom.inputExhale.addEventListener('input', (e) => {
    AppState.exhaleTarget = parseFloat(e.target.value);
    dom.valExhale.textContent = `${AppState.exhaleTarget.toFixed(1)} 秒`;
    updateIePresetBadge();
  });


  // 快速 I:E 按鈕
  document.querySelectorAll('.btn-ie-quick').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const inVal = parseFloat(btn.dataset.in);
      const exVal = parseFloat(btn.dataset.ex);
      AppState.inhaleTarget = inVal;
      AppState.exhaleTarget = exVal;
      dom.inputInhale.value = inVal;
      dom.inputExhale.value = exVal;
      dom.valInhale.textContent = `${inVal.toFixed(1)} 秒`;
      dom.valExhale.textContent = `${exVal.toFixed(1)} 秒`;
      updateIePresetBadge();
    });
  });


  function updateIePresetBadge() {
    const ratio = (AppState.exhaleTarget / AppState.inhaleTarget).toFixed(1);
    dom.labelIePreset.textContent = `目標 1 : ${ratio}`;
  }


  // 私隱模式切換
  dom.selectPrivacy.addEventListener('change', (e) => {
    AppState.privacyMode = e.target.value;
    applyPrivacyModeStyles();
  });


  // 訓練時長切換
  dom.selectDuration.addEventListener('change', (e) => {
    AppState.totalDuration = parseInt(e.target.value, 10);
  });


  // 語音開關
  dom.toggleVoice.addEventListener('change', (e) => {
    AppState.voiceEnabled = e.target.checked;
  });


  // 主按鈕動作
  dom.btnStart.addEventListener('click', () => {
    unlockTTSOnUserGesture();
    switchViewState(STATES.CALIBRATING);
  });
    switchViewState(STATES.CALIBRATING);
  });


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
      localStorage.removeItem('breathguide_copd_history');
      loadAndRenderLocalHistory();
      showToastNotification("已清空本地歷史紀錄。");
    } catch (e) {
      console.warn("Clear history error:", e);
    }
  });


  // 調試面板開關
  dom.btnToggleDebug.addEventListener('click', () => {
    dom.debugDrawer.classList.toggle('translate-x-full');
  });


  dom.btnCloseDebug.addEventListener('click', () => {
    dom.debugDrawer.classList.add('translate-x-full');
  });


  // 調試面板閾值滑桿
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
  });


  // 相機錯誤 Modal 按鈕
  dom.btnModalClose.addEventListener('click', () => {
    dom.modalError.classList.add('hidden');
    switchViewState(STATES.IDLE);
  });


  dom.btnModalRetry.addEventListener('click', () => {
    dom.modalError.classList.add('hidden');
    switchViewState(STATES.CALIBRATING);
  });
}


// ============================================================================
// 11. 程式啟動入口 (Application Bootstrapping)
// ============================================================================
window.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  initTTS();
  loadAndRenderLocalHistory();
  await initMediaPipeVision();
});