/**
 * Text-to-Speech (TTS) service for Tessa bot voice-over.
 * Uses the Web Speech Synthesis API with voice selection.
 */

/** Preferred voice names in priority order — Microsoft Zira is the default */
const PREFERRED_VOICES = [
  'Microsoft Zira',          // Windows — clear female US (DEFAULT)
  'Microsoft Zira Desktop',  // Windows — Zira offline variant
  'Google US English',       // Chrome — female US fallback
  'Samantha',                // macOS — default Siri female
  'Google UK English Female',// Chrome UK
  'Microsoft Hazel',         // Windows UK female
  'Karen',                   // macOS — Australian English
  'Victoria',                // macOS — female
  'Microsoft Mark',          // Windows — male US English
  'Fiona',                   // macOS — Scottish
];

let _voices: SpeechSynthesisVoice[] = [];
let _selectedVoice: SpeechSynthesisVoice | null = null;
let _voiceLocked = false;   // once Zira is found, don't re-select on voiceschanged
let _enabled = true;        // ON by default
let _rate = 0.95;
let _pitch = 1.0;
const _volume = 1.0;
let _initialized = false;

/** Load voices and pick the best match — Zira is locked once selected */
function loadVoices(): void {
  const synth = window.speechSynthesis;
  if (!synth) return;

  _voices = synth.getVoices();
  if (_voices.length === 0) return;

  // If voice is already locked (Zira found), don't re-select
  if (_voiceLocked && _selectedVoice) return;

  // Try preferred voices in order — first match wins and locks
  for (const preferred of PREFERRED_VOICES) {
    const found = _voices.find(v => v.name === preferred || v.name.startsWith(preferred));
    if (found) {
      _selectedVoice = found;
      _voiceLocked = true;   // lock: never change voice again during session
      return;
    }
  }

  // Fallback: any English voice — lock whatever we find
  const englishVoices = _voices.filter(v => v.lang.startsWith('en'));
  if (englishVoices.length > 0) {
    _selectedVoice = englishVoices[0];
  } else if (_voices.length > 0) {
    _selectedVoice = _voices[0];
  }
  if (_selectedVoice) _voiceLocked = true;
}

/** Returns a Promise that resolves once voices are loaded and a voice is selected */
export function waitForVoices(): Promise<void> {
  return new Promise((resolve) => {
    // Already have a voice selected — resolve immediately
    if (_selectedVoice) { resolve(); return; }

    const synth = window.speechSynthesis;
    if (!synth) { resolve(); return; }

    // Try loading right now (some browsers have them synchronously)
    loadVoices();
    if (_selectedVoice) { resolve(); return; }

    // Wait for voiceschanged event
    const onChanged = () => {
      loadVoices();
      if (_selectedVoice) {
        synth.removeEventListener('voiceschanged', onChanged);
        clearTimeout(timeout);
        resolve();
      }
    };
    synth.addEventListener('voiceschanged', onChanged);

    // Safety timeout — resolve after 2s even if no voice found
    const timeout = setTimeout(() => {
      synth.removeEventListener('voiceschanged', onChanged);
      loadVoices(); // one last try
      resolve();
    }, 2000);
  });
}

/** Initialize the TTS engine — call once on app mount */
export function initTTS(): void {
  if (_initialized) return;
  _initialized = true;

  const synth = window.speechSynthesis;
  if (!synth) {
    console.warn('SpeechSynthesis API not supported in this browser');
    return;
  }

  // Load voices (some browsers load them async via voiceschanged event)
  loadVoices();
  synth.onvoiceschanged = () => {
    // Only re-run loadVoices if we haven't locked a voice yet
    if (!_voiceLocked) loadVoices();
  };

  // Voice is always ON by default — only turn off if user explicitly disabled
  const stored = localStorage.getItem('intelliqe_tts_enabled');
  _enabled = stored === null ? true : stored === 'true';

  // Restore rate & pitch (voice name is NOT restored from storage — always use Zira)
  const savedRate = localStorage.getItem('intelliqe_tts_rate');
  if (savedRate) _rate = parseFloat(savedRate) || 0.95;
  const savedPitch = localStorage.getItem('intelliqe_tts_pitch');
  if (savedPitch) _pitch = parseFloat(savedPitch) || 1.0;
}

/** Speak text as Tessa */
export function speak(text: string): void {
  if (!_enabled) return;

  const synth = window.speechSynthesis;
  if (!synth) return;

  // Cancel any ongoing speech to prevent overlap
  synth.cancel();

  // Clean text for speech — remove markdown, emojis, special formatting
  const cleanText = text
    .replace(/[*_~`#>]/g, '')           // Markdown chars
    .replace(/\[REDACTED\]/g, 'redacted')
    .replace(/\bhttps?:\/\/\S+/g, '')   // URLs
    .replace(/\n+/g, '. ')              // Newlines to pauses
    .replace(/\s{2,}/g, ' ')            // Multiple spaces
    .trim();

  if (!cleanText) return;

  const utterance = new SpeechSynthesisUtterance(cleanText);
  // Match language to selected voice (Hindi voice needs hi-IN, others en-US)
  utterance.lang = _selectedVoice?.lang || 'en-US';
  utterance.rate = _rate;
  utterance.pitch = _pitch;
  utterance.volume = _volume;

  if (_selectedVoice) {
    utterance.voice = _selectedVoice;
  }

  synth.speak(utterance);
}

/**
 * Speak text and return a Promise that resolves when speech finishes.
 * Use this when you need to wait for speech to complete before continuing
 * (e.g., before starting an execution process).
 */
export function speakAsync(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (!_enabled) { resolve(); return; }

    const synth = window.speechSynthesis;
    if (!synth) { resolve(); return; }

    // Cancel any ongoing speech
    synth.cancel();

    // Clean text for speech
    const cleanText = text
      .replace(/[*_~`#>]/g, '')
      .replace(/\[REDACTED\]/g, 'redacted')
      .replace(/\bhttps?:\/\/\S+/g, '')
      .replace(/\n+/g, '. ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (!cleanText) { resolve(); return; }

    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.lang = _selectedVoice?.lang || 'en-US';
    utterance.rate = _rate;
    utterance.pitch = _pitch;
    utterance.volume = _volume;
    if (_selectedVoice) utterance.voice = _selectedVoice;

    utterance.onend = () => resolve();
    utterance.onerror = () => resolve(); // resolve even on error so execution isn't blocked

    // Safety timeout — if speech takes longer than 60s, resolve anyway
    const safetyTimer = setTimeout(() => {
      synth.cancel();
      resolve();
    }, 60000);

    utterance.onend = () => { clearTimeout(safetyTimer); resolve(); };
    utterance.onerror = () => { clearTimeout(safetyTimer); resolve(); };

    synth.speak(utterance);
  });
}

/** Check if speech is currently in progress */
export function isSpeaking(): boolean {
  return window.speechSynthesis?.speaking ?? false;
}

/** Wait for any current speech to finish (resolves immediately if not speaking) */
export function waitForSpeech(): Promise<void> {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    if (!synth || !synth.speaking) { resolve(); return; }

    // Poll until speech finishes
    const check = setInterval(() => {
      if (!synth.speaking) {
        clearInterval(check);
        clearTimeout(safety);
        resolve();
      }
    }, 100);

    // Safety timeout
    const safety = setTimeout(() => {
      clearInterval(check);
      resolve();
    }, 60000);
  });
}

/** Stop any current speech */
export function stopSpeaking(): void {
  window.speechSynthesis?.cancel();
}

/** Check if TTS is enabled */
export function isTTSEnabled(): boolean {
  return _enabled;
}

/** Toggle TTS on/off */
export function toggleTTS(): boolean {
  _enabled = !_enabled;
  localStorage.setItem('intelliqe_tts_enabled', String(_enabled));
  if (!_enabled) {
    stopSpeaking();
  }
  return _enabled;
}

/** Set TTS enabled state directly */
export function setTTSEnabled(enabled: boolean): void {
  _enabled = enabled;
  localStorage.setItem('intelliqe_tts_enabled', String(enabled));
  if (!enabled) {
    stopSpeaking();
  }
}

/** Get available voice names for debugging/settings */
export function getAvailableVoices(): { name: string; lang: string; selected: boolean }[] {
  return _voices.map(v => ({
    name: v.name,
    lang: v.lang,
    selected: v === _selectedVoice,
  }));
}

/** Get current voice name */
export function getCurrentVoiceName(): string {
  return _selectedVoice?.name || 'Default';
}

/** Set the active voice by name and persist to localStorage */
export function setVoice(voiceName: string): boolean {
  const match = _voices.find(v => v.name === voiceName);
  if (match) {
    _selectedVoice = match;
    localStorage.setItem('intelliqe_tts_voice', voiceName);
    return true;
  }
  return false;
}

/** Get current speech rate */
export function getRate(): number { return _rate; }

/** Set speech rate (0.5 – 2.0) and persist */
export function setRate(rate: number): void {
  _rate = Math.max(0.5, Math.min(2.0, rate));
  localStorage.setItem('intelliqe_tts_rate', String(_rate));
}

/** Get current pitch */
export function getPitch(): number { return _pitch; }

/** Set speech pitch (0.5 – 2.0) and persist */
export function setPitch(pitch: number): void {
  _pitch = Math.max(0.5, Math.min(2.0, pitch));
  localStorage.setItem('intelliqe_tts_pitch', String(_pitch));
}
