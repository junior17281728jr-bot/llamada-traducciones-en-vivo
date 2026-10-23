import { useState, type FormEvent } from 'react';
import { COMMON_PASSENGER_LANGUAGES, type Speaker } from '@tw/shared';
import type { UseLanguageCatalog } from '../core/catalog';
import { langName } from './labels';

interface DebugSayProps {
  languages: UseLanguageCatalog;
  onSay: (text: string, lang: string, as: Speaker) => void;
}

/** Simulated mode only: speak as the passenger or as the operator without a phone or a microphone. */
export function DebugSay({ languages, onSay }: DebugSayProps) {
  const [text, setText] = useState('');
  const [lang, setLang] = useState('en');
  const options = languages.options('passengerSpeaks');
  const codes = options.length > 0 ? options.map((option) => option.code as string) : [...COMMON_PASSENGER_LANGUAGES];

  const submit = (as: Speaker) => (event: FormEvent) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    onSay(trimmed, as === 'operator' ? 'es' : lang, as);
    setText('');
  };

  return (
    <form className="debug-say" aria-label="Probar con voz simulada" onSubmit={submit('passenger')}>
      <p className="badge badge--simulated">Simulado</p>
      <label className="field field--grow">
        <span className="field__label">Frase de prueba</span>
        <input value={text} onChange={(event) => setText(event.target.value)} placeholder="Escribe lo que se dirá…" maxLength={500} />
      </label>
      <label className="field">
        <span className="field__label">Idioma del pasajero</span>
        <select value={lang} onChange={(event) => setLang(event.target.value)}>
          {codes.map((code) => (
            <option key={code} value={code}>
              {langName(code)}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="button">
        Dice el pasajero
      </button>
      <button type="button" className="button" onClick={submit('operator')}>
        Dices tú (en español)
      </button>
    </form>
  );
}
