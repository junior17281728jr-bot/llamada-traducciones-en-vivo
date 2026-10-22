import {
  speakerOfDirection,
  type CallId,
  type DirectionPipeline,
  type DirectionPipelineConfig,
  type PipelineFactory,
  type Speaker,
} from '@tw/shared';
import { TranslationDirectionPipeline, type DirectionPipelineOptions } from './direction-pipeline.js';
import { MockTextTranslator } from './mock/mock-translator.js';
import { MockTts } from './mock/mock-tts.js';
import { ScriptedStt } from './mock/scripted-stt.js';
import type { UtteranceBus } from './mock/utterance-bus.js';

/** Key of the bus queue that feeds the simulated STT of one speaker of one call. */
export const utteranceKey = (callId: CallId, speaker: Speaker): string => `${callId}:${speaker}`;

export interface MockPipelineFactoryOptions {
  bus: UtteranceBus;
  translator?: MockTextTranslator;
  tts?: MockTts;
  pipeline?: Partial<DirectionPipelineOptions>;
}

/**
 * PROVIDERS=mock. Everything here is SIMULATED: the transcripts come from the utterance bus, the
 * translation from a tiny dictionary and the voice is a synthetic tone. Nothing contacts a real service.
 */
export class MockPipelineFactory implements PipelineFactory {
  readonly simulated = true;
  private readonly translator: MockTextTranslator;
  private readonly tts: MockTts;

  constructor(private readonly options: MockPipelineFactoryOptions) {
    this.translator = options.translator ?? new MockTextTranslator();
    this.tts = options.tts ?? new MockTts({ realtime: true });
  }

  createDirectionPipeline(config: DirectionPipelineConfig): DirectionPipeline {
    const stt = new ScriptedStt({ bus: this.options.bus, key: utteranceKey(config.callId, speakerOfDirection(config.direction)) });
    return new TranslationDirectionPipeline(config, { stt, translator: this.translator, tts: this.tts }, this.options.pipeline);
  }
}
