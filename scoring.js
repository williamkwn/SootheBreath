/**
 * 舒呼(SootheBreath) v9.3 ES6 Module — scoring.js
 * 全程累計時間百分比運算、階段結束評估 (Phase-End Evaluation) 與連續失敗/實時錯誤警示排程引擎
 *
 * v9.2 核心修正 (Fix 3):
 * 1. 排除開頭 400ms 生理轉換緩衝期對 phaseAccum 錯誤比例之稀釋，並將單階段失敗門檻調敏至 PHASE_FAIL_ERROR_RATIO = 0.35 (>= 35% 錯誤時間即判定為 Phase_Fail)。
 * 2. 於吸氣 (INHALE) 與呼氣 (EXHALE) 階段結束時均評估沉肩代償 (shoulder)，確保吸氣聳肩亦能即時累積失敗次數。
 * 3. 整合三層優先警示判定 (getHighestPriorityAlert)：
 *    - Tier 1：已納入「需要改善排程」(inAlertSchedule && consecutiveFails >= 2) 之指標。
 *    - Tier 2：當前階段正在持續發生錯誤動作 (>= REALTIME_ERROR_BANNER_SEC 0.90s) 之實時糾正警示。
 *    - Tier 3：累計百分比已跌穿 < 80% (PASSING_SCORE_PCT) 且尚未連續 2 次合格解鎖之指標，徹底消除「卡片變紅但底部橫幅仍顯示做得好」之矛盾。
 */

import {
  PHASES,
  INITIAL_GRACE_SECONDS,
  PASSING_SCORE_PCT,
  REALTIME_ERROR_BANNER_SEC,
  clampVal,
  AppState
} from './state.js';

export const FRAME_VALID_SCORE_THRESHOLD = 0.70; // 單幀合格門檻
export const PHASE_FAIL_ERROR_RATIO = 0.35;      // Fix 3: 單一階段錯誤時間 >= 35% (0.35) 判定為 Phase_Fail
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

  train.realtimeErrorSec = {
    inhale: 0,
    exhale: 0,
    shoulder: 0
  };

  train.alertSchedule = {
    inhale: {
      key: 'inhale',
      label: '合口吸氣',
      consecutiveFails: 0,
      consecutivePasses: 0,
      inAlertSchedule: false,
      unlockedWhileLowPct: false,
      lastPhaseResult: 'PASS',
      order: 2
    },
    exhale: {
      key: 'exhale',
      label: '噘唇呼氣',
      consecutiveFails: 0,
      consecutivePasses: 0,
      inAlertSchedule: false,
      unlockedWhileLowPct: false,
      lastPhaseResult: 'PASS',
      order: 3
    },
    shoulder: {
      key: 'shoulder',
      label: '沉肩放鬆',
      consecutiveFails: 0,
      consecutivePasses: 0,
      inAlertSchedule: false,
      unlockedWhileLowPct: false,
      lastPhaseResult: 'PASS',
      order: 1
    }
  };

  AppState.feedback.latchedModule = null;
}

/**
 * 逐幀累加全程總時間 (Total Time) 與有效時間 (Valid Time)，即時更新卡片百分比
 * Fix 3: 新增 isInGracePeriod 參數，開頭 400ms 緩衝期不計入 phaseAccum 分母，避免稀釋真實錯誤率
 */
export function accumulateFrameScore(
  phase,
  dt,
  inhaleScore,
  exhaleScore,
  shoulderScore,
  isShoulderRelaxed,
  isInGracePeriod = false
) {
  const train = AppState.training;
  if (!train.phaseAccum || !train.alertSchedule) {
    resetScoringState();
  }
  if (!train.realtimeErrorSec) {
    train.realtimeErrorSec = { inhale: 0, exhale: 0, shoulder: 0 };
  }

  // 1. 沉肩放鬆 (Shoulder)：全程累計 + 當前階段錯誤時間累計 + 實時連續錯誤計時
  train.totalShoulderFrames++;
  train.totalShoulderTimeSec += dt;
  const isShoulderValid = isShoulderRelaxed && (shoulderScore >= FRAME_VALID_SCORE_THRESHOLD);
  const shValidDt = isShoulderValid ? (shoulderScore * dt) : 0;
  train.validShoulderTimeSec += shValidDt;
  if (isShoulderValid) {
    train.validShoulderFrames++;
    train.realtimeErrorSec.shoulder = 0;
  } else {
    train.realtimeErrorSec.shoulder += dt;
    if (train.alertSchedule.shoulder) {
      train.alertSchedule.shoulder.unlockedWhileLowPct = false;
    }
  }

  train.phaseAccum.shoulder.totalTime += dt;
  if (!isShoulderValid) {
    train.phaseAccum.shoulder.errorTime += dt;
  }

  train.pctShoulder = clampVal(
    Math.round((train.validShoulderTimeSec / Math.max(0.001, train.totalShoulderTimeSec)) * 100),
    0,
    100
  );

  // 2. 吸氣階段 (Inhale) 或 呼氣階段 (Exhale)
  if (phase === PHASES.INHALE) {
    train.realtimeErrorSec.exhale = 0;
    train.totalInhaleFrames++;
    train.totalInhaleTimeSec += dt;
    const isInhaleValid = inhaleScore >= FRAME_VALID_SCORE_THRESHOLD;
    const inValidDt = isInhaleValid ? (inhaleScore * dt) : 0;
    train.validInhaleTimeSec += inValidDt;

    if (isInhaleValid) {
      train.validInhaleFrames++;
      if (isShoulderRelaxed) {
        train.tInActual += inValidDt;
      }
      if (!isInGracePeriod) {
        train.realtimeErrorSec.inhale = 0;
      }
    } else {
      train.realtimeErrorSec.inhale += dt;
      if (train.alertSchedule.inhale) {
        train.alertSchedule.inhale.unlockedWhileLowPct = false;
      }
    }

    // 僅在非 400ms 開頭緩衝期（或即使在緩衝期但已明確發生錯誤）才累計入 phaseAccum
    if (!isInGracePeriod || !isInhaleValid) {
      train.phaseAccum.inhale.totalTime += dt;
      if (!isInhaleValid) {
        train.phaseAccum.inhale.errorTime += dt;
      }
    }

    train.pctInhale = clampVal(
      Math.round((train.validInhaleTimeSec / Math.max(0.001, train.totalInhaleTimeSec)) * 100),
      0,
      100
    );
  } else {
    train.realtimeErrorSec.inhale = 0;
    train.totalExhaleFrames++;
    train.totalExhaleTimeSec += dt;
    const isExhaleValid = exhaleScore >= FRAME_VALID_SCORE_THRESHOLD;
    const exValidDt = isExhaleValid ? (exhaleScore * dt) : 0;
    train.validPlbExhaleTimeSec += exValidDt;

    if (isExhaleValid) {
      train.validPlbExhaleFrames++;
      train.tExActual += exValidDt;
      if (!isInGracePeriod) {
        train.realtimeErrorSec.exhale = 0;
      }
    } else {
      train.realtimeErrorSec.exhale += dt;
      if (train.alertSchedule.exhale) {
        train.alertSchedule.exhale.unlockedWhileLowPct = false;
      }
    }

    if (!isInGracePeriod || !isExhaleValid) {
      train.phaseAccum.exhale.totalTime += dt;
      if (!isExhaleValid) {
        train.phaseAccum.exhale.errorTime += dt;
      }
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
 * - Fail Condition: errorTime / phaseTotalTime >= PHASE_FAIL_ERROR_RATIO (0.35)
 * - Alert Trigger: consecutiveFails >= 2 (且非前 10 秒開局緩衝期)
 * - Unlock Condition: 失敗後連續 2 次 Phase_Pass (consecutivePasses >= 2) 重置 consecutiveFails = 0 並移出排程
 */
export function evaluateMetricPhaseResult(metricKey, phaseTotalTime, phaseErrorTime, isWarmupBuffer = false) {
  const train = AppState.training;
  if (!train.alertSchedule || !train.alertSchedule[metricKey]) return null;

  const entry = train.alertSchedule[metricKey];
  if (phaseTotalTime <= 0.05) return entry;

  const errorRatio = phaseErrorTime / phaseTotalTime;
  const isPhaseFail = errorRatio >= PHASE_FAIL_ERROR_RATIO;

  if (isWarmupBuffer) {
    entry.lastPhaseResult = isPhaseFail ? 'WARMUP_FAIL_IGNORED' : 'WARMUP_PASS';
    return entry;
  }

  if (isPhaseFail) {
    entry.consecutiveFails += 1;
    entry.consecutivePasses = 0;
    entry.unlockedWhileLowPct = false;
    entry.lastPhaseResult = 'FAIL';
    if (entry.consecutiveFails >= ALERT_TRIGGER_FAILS) {
      entry.inAlertSchedule = true;
    }
  } else {
    entry.lastPhaseResult = 'PASS';
    entry.consecutivePasses = (entry.consecutivePasses || 0) + 1;
    if (entry.inAlertSchedule || entry.consecutiveFails > 0) {
      if (entry.consecutivePasses >= ALERT_UNLOCK_PASSES) {
        entry.consecutiveFails = 0;
        entry.consecutivePasses = 0;
        entry.inAlertSchedule = false;
        entry.unlockedWhileLowPct = true;
      }
    } else if (entry.consecutivePasses >= ALERT_UNLOCK_PASSES) {
      entry.unlockedWhileLowPct = true;
    }
  }

  return entry;
}

/**
 * 於每個呼吸階段結束時呼叫：
 * - INHALE 結束時：評估 inhale 與 shoulder 階段表現
 * - EXHALE 結束時：評估 exhale 與 shoulder 階段表現
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

    // 若吸氣期間發生明顯聳肩代償，於吸氣結束時即刻評估，不需苦等呼氣結束
    if (train.phaseAccum.shoulder.totalTime > 0.2 &&
        (train.phaseAccum.shoulder.errorTime / train.phaseAccum.shoulder.totalTime) >= PHASE_FAIL_ERROR_RATIO) {
      evaluateMetricPhaseResult(
        'shoulder',
        train.phaseAccum.shoulder.totalTime,
        train.phaseAccum.shoulder.errorTime,
        isWarmup
      );
      train.phaseAccum.shoulder.totalTime = 0;
      train.phaseAccum.shoulder.errorTime = 0;
    }
  } else if (finishedPhase === PHASES.EXHALE) {
    evaluateMetricPhaseResult(
      'exhale',
      train.phaseAccum.exhale.totalTime,
      train.phaseAccum.exhale.errorTime,
      isWarmup
    );
    train.phaseAccum.exhale.totalTime = 0;
    train.phaseAccum.exhale.errorTime = 0;

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
 * Fix 3: 根據三層優先規則取得目前最需要提示改善之指標：
 * - Tier 1: 已進入「需要改善排程」(inAlertSchedule && consecutiveFails >= 2)
 * - Tier 2: 當前階段正在持續做錯動作 (realtimeErrorSec >= REALTIME_ERROR_BANNER_SEC)
 * - Tier 3: 累計百分比已跌穿 < 80% (PASSING_SCORE_PCT) 且尚未透過連續 2 次合格解鎖
 */
export function getHighestPriorityAlert() {
  const train = AppState.training;
  if (!train.alertSchedule) return null;

  const pctMap = {
    inhale: train.pctInhale ?? 100,
    exhale: train.pctExhale ?? 100,
    shoulder: train.pctShoulder ?? 100
  };

  // Tier 1: 連續階段失敗排程 (Alert Schedule)
  const activeAlerts = Object.values(train.alertSchedule)
    .filter(item => item.inAlertSchedule && item.consecutiveFails >= ALERT_TRIGGER_FAILS)
    .map(item => ({
      ...item,
      pct: pctMap[item.key] ?? 100,
      reason: 'SCHEDULE'
    }));

  if (activeAlerts.length > 0) {
    activeAlerts.sort((a, b) => {
      if (b.consecutiveFails !== a.consecutiveFails) {
        return b.consecutiveFails - a.consecutiveFails;
      }
      if (a.pct !== b.pct) {
        return a.pct - b.pct;
      }
      return a.order - b.order;
    });
    const topAlert = activeAlerts[0];
    AppState.feedback.latchedModule = topAlert.key;
    return topAlert;
  }

  // Tier 2: 當前階段實時連續錯誤動作 (>= 0.90s)
  const rtErr = train.realtimeErrorSec || { inhale: 0, exhale: 0, shoulder: 0 };
  if (rtErr.shoulder >= REALTIME_ERROR_BANNER_SEC) {
    const item = train.alertSchedule.shoulder;
    AppState.feedback.latchedModule = 'shoulder';
    return {
      ...item,
      consecutiveFails: Math.max(1, item.consecutiveFails),
      pct: pctMap.shoulder,
      reason: 'REALTIME'
    };
  }
  if (train.currentPhase === PHASES.INHALE && rtErr.inhale >= REALTIME_ERROR_BANNER_SEC) {
    const item = train.alertSchedule.inhale;
    AppState.feedback.latchedModule = 'inhale';
    return {
      ...item,
      consecutiveFails: Math.max(1, item.consecutiveFails),
      pct: pctMap.inhale,
      reason: 'REALTIME'
    };
  }
  if (train.currentPhase === PHASES.EXHALE && rtErr.exhale >= REALTIME_ERROR_BANNER_SEC) {
    const item = train.alertSchedule.exhale;
    AppState.feedback.latchedModule = 'exhale';
    return {
      ...item,
      consecutiveFails: Math.max(1, item.consecutiveFails),
      pct: pctMap.exhale,
      reason: 'REALTIME'
    };
  }

  // Tier 3: 卡片累計百分比 < 80% 且尚未連續 2 次合格解鎖 (避免卡片變紅「需要改善」但底部橫幅卻顯示「做得非常好」)
  const lowPctAlerts = Object.values(train.alertSchedule)
    .filter(item => (pctMap[item.key] ?? 100) < PASSING_SCORE_PCT && !item.unlockedWhileLowPct)
    .map(item => ({
      ...item,
      consecutiveFails: Math.max(1, item.consecutiveFails),
      pct: pctMap[item.key] ?? 100,
      reason: 'LOW_PCT'
    }));

  if (lowPctAlerts.length > 0) {
    lowPctAlerts.sort((a, b) => {
      if (a.pct !== b.pct) return a.pct - b.pct;
      return a.order - b.order;
    });
    const topLow = lowPctAlerts[0];
    AppState.feedback.latchedModule = topLow.key;
    return topLow;
  }

  AppState.feedback.latchedModule = null;
  return null;
}
