/**
 * 舒呼(SootheBreath) v7.0 ES6 Module — dom.js
 * DOM 元素快取與非阻塞式提示通知 (DOM Element References & Toast Utility)
 */

// ============================================================================
// 2. DOM 元素快取 (DOM Element References)
// ============================================================================
export const dom = {};

export function cacheDomElements() {
  Object.assign(dom, {
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
    calibVideoBox: document.getElementById('calib-video-box'),
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
  });
  return dom;
}

export function showToast(message) {
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

