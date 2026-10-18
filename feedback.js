/**
 * 舒呼(SootheBreath) v7.0 ES6 Module — feedback.js
 * 最低分優先 (<80% 需要改善) 與「連續 10 秒改善轉移 / 回升 ≥80% 解鎖」平滑警示機制 (Sticky Priority Latch)
 */

import {
  STATES,
  PHASES,
  INITIAL_GRACE_SECONDS,
  PASSING_SCORE_PCT,
  CONSECUTIVE_IMPROVE_SECONDS,
  AppState
} from './state.js';
import { dom } from './dom.js';
import { speakText } from './tts.js';

// ============================================================================
// 7. 鎖定平滑過渡警示機制與防閃爍提示引擎 (Sticky Priority Latch & 10s Consecutive Improvement)
// ============================================================================
export function updateFeedbackBannerAndSpeech(priority, bannerMessage, ttsMessage = '') {
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
      const prevPriority = fb.currentPriority;
      fb.currentPriority = priority;
      fb.currentPMessage = bannerMessage;
      renderBottomBanner(bannerMessage, priority);
      if ((priority <= 3 || (prevPriority <= 3 && bannerMessage === "持續保持")) && (ttsMessage || bannerMessage)) {
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

export function renderBottomBanner(message, priority) {
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
 * 【訓練警示排程與連續 10 秒改善轉移機制 (Sticky Priority Latch v7.0)】
 * 1. 開局前 10 秒緩衝期：預設顯示「統計中」，不觸發任何低分警示。
 * 2. 80% 合格門檻：低於 80% (< 80%) 直接顯示「需要改善」（橙紅警示樣式，並納入警示排程）。
 * 3. 連續 10 秒改善轉移：當使用者於當前鎖定項目連續 10 秒表現改善 (consecutiveImprovedSec >= 10s) 或總分回升至 >= 80%，
 *    自動解除該項目鎖定並轉移提醒其他 < 80% 的「需要改善」項目；若所有其他項目均 >= 80%，則顯示「持續保持」。
 */
export function evaluateStickyPriorityFeedback(hasFaceAndPose) {
  const train = AppState.training;
  const fb = AppState.feedback;

  if (!fb.satisfiedBy10s) {
    fb.satisfiedBy10s = { inhale: false, exhale: false, shoulder: false, rr: false };
  }
  if (!train.consecutiveImprovedSec) {
    train.consecutiveImprovedSec = { inhale: 0, exhale: 0, shoulder: 0, rr: 0 };
  }

  // 最高優先：鏡頭未偵測到完整人臉或雙肩
  if (!hasFaceAndPose) {
    updateFeedbackBannerAndSpeech(
      1,
      "請調整坐姿，確保面部及雙肩喺鏡頭框內",
      "請調整坐姿，確保面部同雙肩喺鏡頭框入面"
    );
    return;
  }

  // 【調整 1】開局前 10 秒緩衝期：預設顯示「統計中」，不觸發任何低分警示
  if (train.elapsedSeconds < INITIAL_GRACE_SECONDS || train.isWarmingUp) {
    fb.latchedModule = null;
    fb.latchedImprovedSec = 0;
    const graceMsg = train.currentPhase === PHASES.INHALE
      ? "統計中 — 開局緩衝準備中：請跟隨節奏閉口用鼻吸氣，保持雙肩放鬆"
      : "統計中 — 開局緩衝準備中：請跟隨節奏噘唇慢慢呼氣，保持雙肩放鬆";
    updateFeedbackBannerAndSpeech(5, graceMsg, "");
    return;
  }

  const pctIn = train.pctInhale ?? 100;
  const pctEx = train.pctExhale ?? 100;
  const pctSh = train.pctShoulder ?? 100;
  const pctRr = train.pctRr ?? 100;

  // 四大模組狀態與對應修正指引 (< 80% 納入需要改善排程)
  const modulesMap = {
    inhale: {
      key: 'inhale',
      label: '合口吸氣',
      pct: pctIn,
      order: 2,
      bannerMsg: `【合口吸氣 ${pctIn}% · 需要改善】請閉上嘴巴，用鼻慢慢吸氣`,
      ttsMsg: '請閉上嘴巴，用鼻慢慢吸氣'
    },
    exhale: {
      key: 'exhale',
      label: '噘唇呼氣',
      pct: pctEx,
      order: 3,
      bannerMsg: `【噘唇呼氣 ${pctEx}% · 需要改善】請將嘴唇噘起成吹蠟燭狀，慢慢吹氣出嚟`,
      ttsMsg: '請將嘴唇噘起成吹口哨狀，慢慢吹氣出嚟'
    },
    shoulder: {
      key: 'shoulder',
      label: '沉肩放鬆',
      pct: pctSh,
      order: 1,
      bannerMsg: `【沉肩放鬆 ${pctSh}% · 需要改善】偵測到聳肩用力，請保持雙肩下沉放鬆`,
      ttsMsg: '偵測到聳肩用力，請沉肩放鬆'
    },
    rr: {
      key: 'rr',
      label: '呼吸速率',
      pct: pctRr,
      order: 4,
      bannerMsg: `【呼吸速率 ${pctRr}% · 需要改善】請跟住導引節奏，保持平穩呼吸頻率`,
      ttsMsg: '請跟住導引節奏，保持平穩呼吸速度'
    }
  };

  // 1. 檢查目前已鎖定 (Latched) 之項目是否已回升至 >= 80%，或已連續 10 秒表現改善
  if (fb.latchedModule && modulesMap[fb.latchedModule]) {
    const key = fb.latchedModule;
    const modPct = modulesMap[key].pct;
    const consecSec = train.consecutiveImprovedSec[key] || 0;
    fb.latchedImprovedSec = consecSec;

    if (modPct >= PASSING_SCORE_PCT) {
      // 百分比已正式回升至 >= 80%，解除鎖定
      fb.satisfiedBy10s[key] = false;
      fb.latchedModule = null;
      fb.latchedImprovedSec = 0;
    } else if (consecSec >= CONSECUTIVE_IMPROVE_SECONDS) {
      // 【調整 3】使用者已連續 10 秒展現改善技巧，解除當前鎖定並轉移提醒其他需要改善項目
      fb.satisfiedBy10s[key] = true;
      fb.latchedModule = null;
      fb.latchedImprovedSec = 0;
    }
  }

  // 2. 若目前無鎖定項目，檢查是否有其他 < 80% 且尚未完成連續 10 秒改善之「需要改善」項目
  if (!fb.latchedModule) {
    const lowModules = Object.values(modulesMap).filter(
      m => m.pct < PASSING_SCORE_PCT && !fb.satisfiedBy10s[m.key]
    );
    if (lowModules.length > 0) {
      lowModules.sort((a, b) => {
        if (a.pct !== b.pct) return a.pct - b.pct; // 最低分優先
        return a.order - b.order;
      });
      const nextKey = lowModules[0].key;
      fb.latchedModule = nextKey;
      train.consecutiveImprovedSec[nextKey] = 0;
      fb.latchedImprovedSec = 0;
    }
  }

  // 3. 根據鎖定狀態輸出底部橫幅與語音提示
  if (fb.latchedModule && modulesMap[fb.latchedModule]) {
    const activeWarning = modulesMap[fb.latchedModule];
    updateFeedbackBannerAndSpeech(2, activeWarning.bannerMsg, activeWarning.ttsMsg);
  } else {
    // 【調整 3】若所有其他項目均 >= 80%（或已完成連續 10 秒改善且無其他 < 80% 項目），顯示「持續保持」
    updateFeedbackBannerAndSpeech(5, "持續保持", "持續保持");
  }
}
