export interface ScriptedUtterance {
  text: string;
  lang: string;
}

/**
 * Carries the TEXT of simulated speech out of band: synthetic audio cannot be recognised by any
 * STT, so the simulator (`sim.say`) or `debug.say` puts the words here and `ScriptedStt` turns
 * them into transcripts at the pace of the audio that actually arrives.
 */
export class UtteranceBus {
  private readonly queues = new Map<string, ScriptedUtterance[]>();

  say(key: string, utterance: ScriptedUtterance): void {
    const queue = this.queues.get(key) ?? [];
    queue.push(utterance);
    this.queues.set(key, queue);
  }

  take(key: string): ScriptedUtterance | undefined {
    return this.queues.get(key)?.shift();
  }

  pending(key: string): number {
    return this.queues.get(key)?.length ?? 0;
  }

  clear(key: string): void {
    this.queues.delete(key);
  }
}
