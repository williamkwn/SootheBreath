/**
 * 舒呼(SootheBreath) v8.0 ES6 Module — scoring.js
 * 全程累計時間百分比運算、階段結束評估 (Phase-End Evaluation) 與連續失敗警示排程引擎
 *
 * 核心規格 (v8.0 Specification):
 * 1. 全程累計時間百分比 (Cumulative Total Time Percentage):
 *    - 移除 20 秒滾動時間窗，改為計算整個訓練過程之累計時間百分比：
 *      Percentage = (Σ validTime / Σ totalTime) * 100
 *    - 開局前 10 秒緩衝期 (Warm-up Buffer) 保持百分比計算開啟並即時顯示於四張卡片，但絕不觸發任何警示。
 * 2. 階段結束評估 (Phase-End Evaluation):
 *    - 於每次吸氣 (INHALE) 結束時評估 Inhale；於每次呼氣 (EXHALE / 完整吸呼週期) 結束時評估 Exhale 與 Shoulder。
 *    - 失敗條件 (Phase_Fail)：若該階段內錯誤時間 (errorTime, frameScore < 0.70) 超過該階段總時長 50% (> 50%)，判定為 Phase_Fail。
 * 3. 連續失敗計數與警示排程 (Consecutive Fails & Alert Schedule):
 *    - 維護 Inhale、Exhale、Shoulder 三項指標之 consecutiveFails 與 consecutivePasses。
 *    - 當發生 Phase_Fail：consecutiveFails += 1，consecutivePasses = 0；當 consecutiveFails >= 2 時納入「需要改善排程」(inAlertSchedule = true)。
 *    - 解鎖條件 (Unlock Condition)：納入排程或失敗後，連續達成 2 次階段合格 (consecutivePasses >= 2)，即重置 consecutiveFails = 0 並移出警示排程解鎖。
 * 4. 底部橫幅優先順序 (Bottom Banner Priority):
 *    - 若警示排程內有多個項目：先按 consecutiveFails 由高至低排序；若相同則按累計百分比 (%) 由低至高排序。
 *    - 若警示排程為空（全部合格或已解鎖），於 10 秒開局緩衝期結束後顯示綠色橫幅：「✅ 做得非常好，繼續保持！」。
 */

import { PHASES, INITIAL_GRACE_SECONDS, clampVal, AppState } from './state.js';

export const FRAME_VALID_SCORE_THRESHOLD = 0.70; // 與 P0.4 Continuous Fuzzy Scoring 一致之單幀合格門檻
export const PHASE_FAIL_ERROR_RATIO = 0.50;      // 單一階段錯誤時間超過 50% (> 0.50) 判定為 Phase_Fail
export const ALERT_TRIGGER_FAILS = 2;            // 連續失敗 >= 2 次納入「需要改善排程」
export const ALERT_UNLOCK_PASSES = 2;            // 失敗後連續合格 >= 2 次重置 consecutiveFails = 0 並解鎖

/**
 * 初始化/重置訓練評分與階段警示排程狀態
 */
export function resetScoringState() {
  const train = AppState.training;
  train.totalInhaleFrames = 0;
  train.validInhaleFrames = 0;
  train.totalExhaleFrames = 0;
  train.validPlbExhaleFrames = 0;
  train.totalShoulderFrames = 0;
  train.validShoulderFrames = 0;

  train.totalInhaleTimeSec = 0;
  train.validInhaleTimeSec = 0;
  train.totalExhaleTimeSec = 0;
  train.validPlbExhaleTimeSec = 0;
  train.totalShoulderTimeSec = 0;
  train.validShoulderTimeSec = 0;

  train.pctInhale = 100;
  train.pctExhale = 100;
  train.pctShoulder = 100;
  train.pctRr = 100;

  train.phaseAccum = {
    inhale: { totalTime: 0, errorTime: 0 },
    exhale: { totalTime: 0, errorTime: 0 },
    shoulder: { totalTime: 0, errorTime: 0 }
  };

  train.alertSchedule = {
    inhale: {
      key: 'inhale',
      label: '合口吸氣',
      consecutiveFails: 0,
      consecutivePasses: 0,
      inAlertSchedule: false,
      lastPhaseResult: 'PASS',
      order: 2
    },
    exhale: {
      key: 'exhale',
      label: '噘唇呼氣',
      consecutiveFails: 0,
      consecutivePasses: 0,
      inAlertSchedule: false,
      lastPhaseResult: 'PASS',
      order: 3
    },
    shoulder: {
      key: 'shoulder',
      label: '沉肩放鬆',
      consecutiveFails: 0,
      consecutivePasses: 0,
      inAlertSchedule: false,
      lastPhaseResult: 'PASS',
      order: 1
    }
  };

  AppState.feedback.latchedModule = null;
}

/**
 * 逐幀累加全程總時間 (Total Time) 與有效時間 (Valid Time)，即時更新卡片百分比
 * (開局前 10 秒緩衝期照常計算並顯示於卡片，供治療師觀察)
 */
export function accumulateFrameScore(phase, dt, inhaleScore, exhaleScore, shoulderScore, isShoulderRelaxed) {
  const train = AppState.training;
  if (!train.phaseAccum || !train.alertSchedule) {
    resetScoringState();
  }

  // 1. 沉肩放鬆 (Shoulder)：全程累計 + 當前階段錯誤時間累計
  train.totalShoulderFrames++;
  train.totalShoulderTimeSec += dt;
  const shValidDt = (shoulderScore >= FRAME_VALID_SCORE_THRESHOLD) ? (shoulderScore * dt) : 0;
  train.validShoulderTimeSec += shValidDt;
  if (isShoulderRelaxed && shoulderScore >= FRAME_VALID_SCORE_THRESHOLD) {
    train.validShoulderFrames++;
  }
  train.phaseAccum.shoulder.totalTime += dt;
  if (!isShoulderRelaxed || shoulderScore < FRAME_VALID_SCORE_THRESHOLD) {
    train.phaseAccum.shoulder.errorTime += dt;
  }
  train.pctShoulder = clampVal(
    Math.round((train.validShoulderTimeSec / Math.max(0.001, train.totalShoulderTimeSec)) * 100),
    0,
    100
  );

  // 2. 吸氣階段 (Inhale) 或 呼氣階段 (Exhale)
  if (phase === PHASES.INHALE) {
    train.totalInhaleFrames++;
    train.totalInhaleTimeSec += dt;
    const inValidDt = (inhaleScore >= FRAME_VALID_SCORE_THRESHOLD) ? (inhaleScore * dt) : 0;
    train.validInhaleTimeSec += inValidDt;
    if (inhaleScore >= FRAME_VALID_SCORE_THRESHOLD) {
      train.validInhaleFrames++;
      if (isShoulderRelaxed) {
        train.tInActual += inValidDt;
      }
    }
    train.phaseAccum.inhale.totalTime += dt;
    if (inhaleScore < FRAME_VALID_SCORE_THRESHOLD) {
      train.phaseAccum.inhale.errorTime += dt;
    }
    train.pctInhale = clampVal(
      Math.round((train.validInhaleTimeSec / Math.max(0.001, train.totalInhaleTimeSec)) * 100),
      0,
      100
    );
  } else {
    train.totalExhaleFrames++;
    train.totalExhaleTimeSec += dt;
    const exValidDt = (exhaleScore >= FRAME_VALID_SCORE_THRESHOLD) ? (exhaleScore * dt) : 0;
    train.validPlbExhaleTimeSec += exValidDt;
    if (exhaleScore >= FRAME_VALID_SCORE_THRESHOLD) {
      train.validPlbExhaleFrames++;
      train.tExActual += exValidDt;
    }
    train.phaseAccum.exhale.totalTime += dt;
    if (exhaleScore < FRAME_VALID_SCORE_THRESHOLD) {
      train.phaseAccum.exhale.errorTime += dt;
    }
    train.pctExhale = clampVal(
      Math.round((train.validPlbExhaleTimeSec / Math.max(0.001, train.totalExhaleTimeSec)) * 100),
      0,
      100
    );
  }
}

/**
 * 單一指標於階段結束時之評估與連續失敗/連續合格狀態更新
 * - Fail Condition: errorTime > 50% of phaseTotalTime
 * - Alert Trigger: consecutiveFails >= 2 (且非前 10 秒開局緩衝期)
 * - Unlock Condition: 失敗後連續 2 次 Phase_Pass (consecutivePasses >= 2) 重置 consecutiveFails = 0 並移出排程
 */
export function evaluateMetricPhaseResult(metricKey, phaseTotalTime, phaseErrorTime, isWarmupBuffer = false) {
  const train = AppState.training;
  if (!train.alertSchedule || !train.alertSchedule[metricKey]) return null;

  const entry = train.alertSchedule[metricKey];
  if (phaseTotalTime <= 0.05) return entry;

  const errorRatio = phaseErrorTime / phaseTotalTime;
  const isPhaseFail = errorRatio > PHASE_FAIL_ERROR_RATIO;

  // 開局前 10 秒緩衝期：不觸發任何警示排程累加
  if (isWarmupBuffer) {
    entry.lastPhaseResult = isPhaseFail ? 'WARMUP_FAIL_IGNORED' : 'WARMUP_PASS';
    return entry;
  }

  if (isPhaseFail) {
    entry.consecutiveFails += 1;
    entry.consecutivePasses = 0;
    entry.lastPhaseResult = 'FAIL';
    if (entry.consecutiveFails >= ALERT_TRIGGER_FAILS) {
      entry.inAlertSchedule = true;
    }
  } else {
    entry.lastPhaseResult = 'PASS';
    if (entry.inAlertSchedule || entry.consecutiveFails > 0) {
      entry.consecutivePasses += 1;
      if (entry.consecutivePasses >= ALERT_UNLOCK_PASSES) {
        entry.consecutiveFails = 0;
        entry.consecutivePasses = 0;
        entry.inAlertSchedule = false;
      }
    }
  }

  return entry;
}

/**
 * 於每個呼吸階段結束時呼叫：
 * - INHALE 結束時：評估 inhale 階段表現
 * - EXHALE 結束時（完整吸呼週期完成）：評估 exhale 與 shoulder 階段表現
 */
export function evaluateCompletedPhase(finishedPhase, elapsedSeconds = AppState.training.elapsedSeconds) {
  const train = AppState.training;
  if (!train.phaseAccum || !train.alertSchedule) return;

  const isWarmup = elapsedSeconds < INITIAL_GRACE_SECONDS;

  if (finishedPhase === PHASES.INHALE) {
    evaluateMetricPhaseResult(
      'inhale',
      train.phaseAccum.inhale.totalTime,
      train.phaseAccum.inhale.errorTime,
      isWarmup
    );
    train.phaseAccum.inhale.totalTime = 0;
    train.phaseAccum.inhale.errorTime = 0;
  } else if (finishedPhase === PHASES.EXHALE) {
    evaluateMetricPhaseResult(
      'exhale',
      train.phaseAccum.exhale.totalTime,
      train.phaseAccum.exhale.errorTime,
      isWarmup
    );
    train.phaseAccum.exhale.totalTime = 0;
    train.phaseAccum.exhale.errorTime = 0;

    // Remarks: 於每次呼氣（呼吸週期）結束時一併評估沉肩代償錯誤時間是否 > 50%
    evaluateMetricPhaseResult(
      'shoulder',
      train.phaseAccum.shoulder.totalTime,
      train.phaseAccum.shoulder.errorTime,
      isWarmup
    );
    train.phaseAccum.shoulder.totalTime = 0;
    train.phaseAccum.shoulder.errorTime = 0;
  }
}

/**
 * 根據優先規則取得目前「需要改善排程」(Alert Schedule) 中最高優先級之指標：
 * 1. 先按 consecutiveFails 由高至低排序 (highest first)
 * 2. 若平手，按全程累計百分比 (%) 由低至高排序 (lowest first)
 */
export function getHighestPriorityAlert() {
  const train = AppState.training;
  if (!train.alertSchedule) return null;

  const pctMap = {
    inhale: train.pctInhale ?? 100,
    exhale: train.pctExhale ?? 100,
    shoulder: train.pctShoulder ?? 100
  };

  const activeAlerts = Object.values(train.alertSchedule)
    .filter(item => item.inAlertSchedule && item.consecutiveFails >= ALERT_TRIGGER_FAILS)
    .map(item => ({
      ...item,
      pct: pctMap[item.key] ?? 100
    }));

  if (activeAlerts.length === 0) {
    AppState.feedback.latchedModule = null;
    return null;
  }

  activeAlerts.sort((a, b) => {
    if (b.consecutiveFails !== a.consecutiveFails) {
      return b.consecutiveFails - a.consecutiveFails; // 1. consecutiveFails 最高者優先
    }
    if (a.pct !== b.pct) {
      return a.pct - b.pct; // 2. 若平手，累計百分比 (%) 最低者優先
    }
    return a.order - b.order;
  });

  const topAlert = activeAlerts[0];
  AppState.feedback.latchedModule = topAlert.key;
  return topAlert;
}
