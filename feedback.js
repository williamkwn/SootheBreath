/**
 * 舒呼(SootheBreath) v7.0 ES6 Module — feedback.js
 * 最低分優先與「鎖定直到回升 ≥70%」平滑警示機制 (Sticky Priority Latch & Bottom Banner)
 */

import { STATES, PHASES, INITIAL_GRACE_SECONDS, AppState } from './state.js';
import { dom } from './dom.js';
import { speakText } from './tts.js';

// ============================================================================
// 7. 鎖定平滑過渡警示機制與防閃爍提示引擎 (Section C.4 Sticky Priority Latch)
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
 * 【C.4 最低分優先與「鎖定直到回升 ≥ 70%」平滑警示機制 (Sticky Priority Latch)】
 * - 只有當某個項目百分比跌穿 70% (< 70%) 時才觸發底部橫幅與廣東話語音修正警示（未偵測到人臉/雙肩除外）。
 * - 若同時有多於一個項目低過 70%，根據「百分比分數最低」決定優先顯示。
 * - 一旦某個低分項目觸發警示，系統必須鎖定 (Latch) 該項目，中途不因其他項目波動而頻繁跳換；
 *   必須等到當前鎖定項目實時百分比回升至 >= 70% 後才解除鎖定，並平滑過渡檢查下一個 < 70% 最低分項目。
 */
export function evaluateStickyPriorityFeedback(hasFaceAndPose) {
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

