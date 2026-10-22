/**
 * @tw/pipeline: STT, translation, TTS, language control and simulated providers.
 * Contracts live in @tw/shared (`SttProvider`, `TextTranslator`, `TtsProvider`, `DirectionPipeline`...).
 */
export const PIPELINE_PACKAGE = '@tw/pipeline' as const;

export { Emitter } from './util/emitter.js';
export {
  DEFAULT_LANGUAGE_CONTROLLER_CONFIG,
  LanguageController,
  countWords,
  heardLanguageFor,
  type HeardLanguage,
  type LanguageControllerConfig,
  type LanguageEvidence,
  type LanguageUpdate,
} from './language/controller.js';
export {
  DEFAULT_DIRECTION_PIPELINE_OPTIONS,
  TranslationDirectionPipeline,
  type DirectionPipelineOptions,
  type DirectionPipelineProviders,
} from './direction-pipeline.js';
export { UtteranceBus, type ScriptedUtterance } from './mock/utterance-bus.js';
export { ScriptedStt, type ScriptedSttOptions } from './mock/scripted-stt.js';
export { MockTextTranslator, guessLanguage, type MockTranslatorOptions } from './mock/mock-translator.js';
export { MockTts, mockVoicePitchHz, type MockTtsOptions } from './mock/mock-tts.js';
export { MockPipelineFactory, utteranceKey, type MockPipelineFactoryOptions } from './factory.js';
