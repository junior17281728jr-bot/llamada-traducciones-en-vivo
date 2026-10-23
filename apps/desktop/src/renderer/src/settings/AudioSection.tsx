import { useCallback, useEffect, useId, useState } from 'react';
import { readAudioPref, writeAudioPref, type AudioPrefKey } from '../core/audio-prefs';

type DeviceSupport = 'checking' | 'ok' | 'unsupported';

interface DeviceSelectProps {
  id: string;
  label: string;
  prefKey: AudioPrefKey;
  kind: 'audioinput' | 'audiooutput';
  devices: MediaDeviceInfo[];
  value: string;
  hint?: string;
  onChange: (prefKey: AudioPrefKey, value: string) => void;
}

function deviceLabel(device: MediaDeviceInfo, index: number): string {
  if (device.label) return device.label;
  return `${device.kind === 'audioinput' ? 'Micrófono' : 'Altavoz'} ${index + 1} (nombre oculto hasta dar permiso)`;
}

function DeviceSelect({ id, label, prefKey, kind, devices, value, hint, onChange }: DeviceSelectProps) {
  const options = devices.filter((device) => device.kind === kind);
  const known = value === '' || options.some((device) => device.deviceId === value);
  const hintId = `${id}-hint`;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <select id={id} value={value} aria-describedby={hint ? hintId : undefined} onChange={(event) => onChange(prefKey, event.target.value)}>
        <option value="">Predeterminado del sistema</option>
        {!known ? (
          <option value={value} disabled>
            Dispositivo guardado no conectado ahora
          </option>
        ) : null}
        {options.map((device, index) => (
          <option key={device.deviceId || index} value={device.deviceId}>
            {deviceLabel(device, index)}
          </option>
        ))}
      </select>
      {hint ? (
        <span className="field__hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

function readVolume(): number {
  const raw = Number(readAudioPref('volume'));
  return readAudioPref('volume') !== null && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 1;
}

/**
 * Audio devices of this computer: operator microphone and headphones, translated-voice volume and the two
 * virtual-cable devices of "modo audio del PC". Everything is stored locally (audio-prefs) and applies
 * from the next call.
 *
 * UNVERIFIED inside Electron (the binary never ran here): `enumerateDevices` label visibility, the
 * `getUserMedia` permission prompt and whether output selection (`setSinkId`) is honoured. The screen only
 * promises what the browser APIs report and says the default output is used when selection is unsupported.
 */
export function AudioSection() {
  const ids = { input: useId(), output: useId(), volume: useId(), pin: useId(), pout: useId() };
  const [support, setSupport] = useState<DeviceSupport>('checking');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [permissionNeeded, setPermissionNeeded] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Record<AudioPrefKey, string>>(() => ({
    input: readAudioPref('input') ?? '',
    output: readAudioPref('output') ?? '',
    volume: String(readVolume()),
    passengerInput: readAudioPref('passengerInput') ?? '',
    passengerOutput: readAudioPref('passengerOutput') ?? '',
  }));

  const refresh = useCallback(async (): Promise<void> => {
    const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!media || typeof media.enumerateDevices !== 'function') {
      setSupport('unsupported');
      return;
    }
    try {
      const list = await media.enumerateDevices();
      const audio = list.filter((device) => device.kind === 'audioinput' || device.kind === 'audiooutput');
      setDevices(audio);
      setPermissionNeeded(audio.length > 0 && audio.every((device) => !device.label));
      setSupport('ok');
    } catch {
      setSupport('unsupported');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!media || typeof media.addEventListener !== 'function') return undefined;
    const onChange = (): void => void refresh();
    media.addEventListener('devicechange', onChange);
    return () => media.removeEventListener('devicechange', onChange);
  }, [refresh]);

  async function requestPermission(): Promise<void> {
    setPermissionError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      await refresh();
    } catch {
      setPermissionError('No se concedió el permiso del micrófono. Permítelo en los ajustes del sistema y vuelve a intentarlo.');
    }
  }

  function update(key: AudioPrefKey, value: string): void {
    writeAudioPref(key, value);
    setPrefs((current) => ({ ...current, [key]: value }));
  }

  const volumePercent = Math.round(Number(prefs.volume) * 100);

  return (
    <section className="card settings__section" id="ajustes-audio" aria-labelledby="audio-title" data-testid="audio-section">
      <header className="card__header">
        <div>
          <h2 className="card__title" id="audio-title">
            Audio
          </h2>
          <p className="card__subtitle">Se guarda en este ordenador y se aplica a partir de la próxima llamada.</p>
        </div>
        {support === 'ok' ? (
          <button type="button" className="button button--small" onClick={() => void refresh()}>
            Volver a buscar dispositivos
          </button>
        ) : null}
      </header>

      <p className="notice notice--warn" role="note">
        <span className="notice__title">Usa auriculares.</span> Con altavoces, la voz traducida vuelve a entrar por el micrófono y se traduce otra vez.
      </p>

      {support === 'unsupported' ? (
        <p className="notice notice--info" data-testid="audio-unsupported">
          Este entorno no permite listar los dispositivos de audio. Se usarán los predeterminados del sistema.
        </p>
      ) : null}

      {support === 'ok' && permissionNeeded ? (
        <div className="notice notice--info" data-testid="audio-permission">
          <p>Para ver los nombres de los dispositivos hace falta el permiso del micrófono.</p>
          <div className="notice__actions">
            <button type="button" className="button button--small button--primary" onClick={() => void requestPermission()}>
              Permitir micrófono
            </button>
          </div>
        </div>
      ) : null}
      {permissionError ? (
        <p className="notice notice--danger" role="alert">
          {permissionError}
        </p>
      ) : null}

      <div className="stack stack--tight">
        <h3 className="section-title">Tu micrófono y tus auriculares</h3>
        <div className="form-grid">
          <DeviceSelect id={ids.input} label="Micrófono" prefKey="input" kind="audioinput" devices={devices} value={prefs.input} onChange={update} />
          <DeviceSelect
            id={ids.output}
            label="Altavoz o auriculares"
            prefKey="output"
            kind="audiooutput"
            devices={devices}
            value={prefs.output}
            hint="Donde oyes la voz traducida del pasajero. Si el sistema no permite elegir salida, se usa la predeterminada."
            onChange={update}
          />
          <label className="field" htmlFor={ids.volume}>
            <span className="field__label">Volumen de la voz traducida: {volumePercent}%</span>
            <input
              id={ids.volume}
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={prefs.volume}
              aria-valuetext={`${volumePercent} por ciento`}
              onChange={(event) => update('volume', event.target.value)}
            />
          </label>
        </div>
      </div>

      <div className="stack stack--tight" data-testid="pc-audio-mode">
        <h3 className="section-title">Modo audio del PC</h3>
        <p className="muted small">
          Para traducir una llamada que ya tienes en otro programa (por ejemplo WhatsApp Desktop) hacen falta dos cables de audio virtuales: uno trae la voz del
          pasajero desde ese programa hasta Telecomway y otro lleva tu voz traducida hasta el micrófono de ese programa. Cómo instalarlos y configurarlos:{' '}
          <code>docs/MODO-AUDIO-PC.md</code>.
        </p>
        <div className="form-grid">
          <DeviceSelect
            id={ids.pin}
            label="Entrada con la voz del pasajero"
            prefKey="passengerInput"
            kind="audioinput"
            devices={devices}
            value={prefs.passengerInput}
            hint="El cable virtual que recibe la salida de audio del otro programa."
            onChange={update}
          />
          <DeviceSelect
            id={ids.pout}
            label="Salida hacia el micrófono del otro programa"
            prefKey="passengerOutput"
            kind="audiooutput"
            devices={devices}
            value={prefs.passengerOutput}
            hint="El cable virtual que el otro programa usa como micrófono; aquí se reproduce tu voz traducida."
            onChange={update}
          />
        </div>
      </div>
    </section>
  );
}
