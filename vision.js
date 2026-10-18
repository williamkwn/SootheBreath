/**
 * 舒呼(SootheBreath) v7.0 ES6 Module — vision.js
 * MediaPipe Tasks Vision 0.10.14 ESM 模型載入與初始化 (Vision Engine Initialization)
 */

import { AppState } from './state.js';

// ============================================================================
// 3. MediaPipe 0.10.14 ESM 模型初始化 (Model Initialization with Fallback)
// ============================================================================
export async function loadMediaPipeModule() {
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

export async function initMediaPipeVision() {
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

