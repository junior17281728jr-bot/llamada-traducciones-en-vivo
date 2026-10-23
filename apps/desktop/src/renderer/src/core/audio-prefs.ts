/**
 * Audio device preferences of this computer (localStorage; they never leave the machine).
 * Settings writes them; the call client reads them when a call starts.
 */
export const AUDIO_PREF_KEYS = {
  /** Operator microphone (deviceId). */
  input: 'tw.audio.input',
  /** Operator headphones (deviceId, used with setSinkId where supported). */
  output: 'tw.audio.output',
  /** Volume of the translated passenger voice, 0..1. */
  volume: 'tw.audio.volume',
  /** "Modo audio del PC": input device that carries the passenger's voice (virtual cable from WhatsApp's output). */
  passengerInput: 'tw.audio.passengerInput',
  /** "Modo audio del PC": output device WhatsApp uses as its microphone (virtual cable), where the translated operator voice is played. */
  passengerOutput: 'tw.audio.passengerOutput',
} as const;

export type AudioPrefKey = keyof typeof AUDIO_PREF_KEYS;

export function readAudioPref(key: AudioPrefKey): string | null {
  try {
    return window.localStorage.getItem(AUDIO_PREF_KEYS[key]);
  } catch {
    return null;
  }
}

export function writeAudioPref(key: AudioPrefKey, value: string | null): void {
  try {
    if (value === null || value === '') window.localStorage.removeItem(AUDIO_PREF_KEYS[key]);
    else window.localStorage.setItem(AUDIO_PREF_KEYS[key], value);
  } catch {
    /* storage unavailable */
  }
}
