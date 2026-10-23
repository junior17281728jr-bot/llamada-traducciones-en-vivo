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
  directAudioFor,
  type DirectionPipelineOptions,
  type DirectionPipelineProviders,
} from './direction-pipeline.js';
export { UtteranceBus, type ScriptedUtterance } from './mock/utterance-bus.js';
export { ScriptedStt, type ScriptedSttOptions } from './mock/scripted-stt.js';
export { MockTextTranslator, guessLanguage, type MockTranslatorOptions } from './mock/mock-translator.js';
export { MockTts, mockVoicePitchHz, type MockTtsOptions } from './mock/mock-tts.js';
export { MockPipelineFactory, utteranceKey, type MockPipelineFactoryOptions } from './factory.js';

// Real providers (ElevenLabs STT/TTS by WebSocket, Claude translator). Protocol names are UNVERIFIED
// against the live services and live only in ./elevenlabs/protocol.ts.
export * as elevenLabsProtocol from './elevenlabs/protocol.js';
export { ElevenLabsConfigError, ElevenLabsError, MISSING_ELEVENLABS_KEY_MESSAGE, type ElevenLabsErrorKind, type ElevenLabsService } from './elevenlabs/errors.js';
export {
  ELEVENLABS_ENV,
  TRANSLATOR_DEFAULT_MODEL,
  configuredVoiceLanguages,
  missingVoiceMessage,
  readElevenLabsSettings,
  resolveApiKey,
  voiceIdFor,
  type ApiKeySource,
  type ElevenLabsSettings,
  type Env as ProviderEnv,
} from './elevenlabs/settings.js';
export { defaultWebSocketFactory, type SocketOptions, type WebSocketFactory } from './elevenlabs/socket.js';
export { ElevenLabsSttProvider, ElevenLabsSttSession, type ElevenLabsSttOptions } from './elevenlabs/stt.js';
export { ElevenLabsTtsProvider, ElevenLabsTtsSession, type ElevenLabsTtsOptions } from './elevenlabs/tts.js';
export { TRANSLATOR_SYSTEM_PROMPT, buildTranslatorUserPrompt, parseTranslatorOutput, type ParsedTranslation } from './claude/prompt.js';
export {
  ClaudeTranslator,
  MISSING_ANTHROPIC_KEY_MESSAGE,
  TranslatorError,
  maxTokensFor,
  maxTranslationLength,
  speedTuningFor,
  type ClaudeTranslatorOptions,
  type TranslatorErrorKind,
} from './claude/translator.js';
export { ElevenLabsPipelineFactory, type ElevenLabsPipelineFactoryOptions, type ProviderSecretName } from './elevenlabs-factory.js';
