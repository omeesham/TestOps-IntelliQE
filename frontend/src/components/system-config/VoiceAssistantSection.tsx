import { useState, useEffect, useCallback } from 'react';
import { Volume2, VolumeX, Play } from 'lucide-react';
import {
  initTTS,
  isTTSEnabled,
  setTTSEnabled,
  speak,
  getAvailableVoices,
  getCurrentVoiceName,
  setVoice,
  getRate,
  setRate,
  getPitch,
  setPitch,
} from '@/utils/tts';

export default function VoiceAssistantSection() {
  // ── State ─────────────────────────────────────────────
  const [voiceEnabled, setVoiceEnabled] = useState(() => isTTSEnabled());
  const [voices, setVoices] = useState<{ name: string; lang: string; selected: boolean }[]>([]);
  const [currentVoice, setCurrentVoice] = useState(() => getCurrentVoiceName());
  const [speechRate, setSpeechRate] = useState(() => getRate());
  const [speechPitch, setSpeechPitch] = useState(() => getPitch());
  const [testPlaying, setTestPlaying] = useState(false);

  // ── Initialise TTS and poll for voices ────────────────
  useEffect(() => {
    initTTS();
    const load = () => {
      const v = getAvailableVoices();
      if (v.length > 0) {
        setVoices(v);
        setCurrentVoice(getCurrentVoiceName());
      }
    };
    load();
    const timer = setInterval(load, 500);
    const timeout = setTimeout(() => clearInterval(timer), 3000);
    return () => {
      clearInterval(timer);
      clearTimeout(timeout);
    };
  }, []);

  // ── Handlers ──────────────────────────────────────────
  const handleVoiceToggle = useCallback((enabled: boolean) => {
    setTTSEnabled(enabled);
    setVoiceEnabled(enabled);
  }, []);

  const handleVoiceChange = useCallback((voiceName: string) => {
    setVoice(voiceName);
    setCurrentVoice(voiceName);
  }, []);

  const handleRateChange = useCallback((rate: number) => {
    setRate(rate);
    setSpeechRate(rate);
  }, []);

  const handlePitchChange = useCallback((pitch: number) => {
    setPitch(pitch);
    setSpeechPitch(pitch);
  }, []);

  const handleTestVoice = useCallback(() => {
    const wasEnabled = isTTSEnabled();
    if (!wasEnabled) setTTSEnabled(true);
    setTestPlaying(true);
    speak(
      'Hello! I am Tessa, your AI testing assistant. I will guide you through your test results and provide insights.',
    );
    // Re-disable if it was disabled before the test
    setTimeout(() => {
      setTestPlaying(false);
      if (!wasEnabled) setTTSEnabled(false);
    }, 4000);
  }, []);

  // ── Render ────────────────────────────────────────────
  return (
    <div>
      {/* Header + toggle */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          {voiceEnabled ? (
            <Volume2 className="w-4 h-4 text-[#7C3AED]" />
          ) : (
            <VolumeX className="w-4 h-4 text-gray-400" />
          )}
          <h3 className="text-sm font-semibold text-[#1E1B4B]">Tessa Voice Assistant</h3>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={voiceEnabled}
            onChange={(e) => handleVoiceToggle(e.target.checked)}
            className="sr-only peer"
          />
          <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-[#7C3AED]/20 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#7C3AED]" />
          <span className="ml-2 text-xs font-medium text-[#6B7280]">
            {voiceEnabled ? 'Enabled' : 'Disabled'}
          </span>
        </label>
      </div>

      {/* Controls — dim when disabled */}
      <div
        className={`space-y-4 transition-opacity ${voiceEnabled ? 'opacity-100' : 'opacity-50 pointer-events-none'}`}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Voice / Language selector */}
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-[#1E1B4B] mb-1">Voice / Language</label>
            <div className="flex gap-2">
              <select
                value={currentVoice}
                onChange={(e) => handleVoiceChange(e.target.value)}
                className="flex-1 px-3 py-2.5 rounded-xl border border-[#DDD6FE] bg-[#F5F3FF] text-sm outline-none focus:ring-2 focus:ring-[#7C3AED]/20 focus:border-[#7C3AED] transition-all"
              >
                {voices.length === 0 && <option value="Default">Loading voices...</option>}
                {voices.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name} ({v.lang})
                  </option>
                ))}
              </select>
              <button
                onClick={handleTestVoice}
                disabled={testPlaying}
                className="px-3 py-2.5 rounded-xl border border-[#DDD6FE] bg-[#F5F3FF] text-[#7C3AED] hover:bg-[#EDE9FE] transition-all disabled:opacity-50 flex items-center gap-1.5"
                title="Test voice"
              >
                <Play className="w-4 h-4" />
                <span className="text-xs font-medium">{testPlaying ? 'Playing...' : 'Test'}</span>
              </button>
            </div>
            <p className="text-[10px] text-[#6B7280] mt-1">
              Available voices depend on your browser and operating system
            </p>
          </div>

          {/* Speech Rate */}
          <div>
            <label className="block text-sm font-medium text-[#1E1B4B] mb-1">
              Speech Rate: {speechRate.toFixed(1)}x
            </label>
            <input
              type="range"
              min="0.5"
              max="2.0"
              step="0.1"
              value={speechRate}
              onChange={(e) => handleRateChange(parseFloat(e.target.value))}
              className="w-full h-2 bg-[#EDE9FE] rounded-lg appearance-none cursor-pointer accent-[#7C3AED]"
            />
            <div className="flex justify-between text-[10px] text-[#6B7280] mt-0.5">
              <span>Slow (0.5x)</span>
              <span>Normal (1.0x)</span>
              <span>Fast (2.0x)</span>
            </div>
          </div>

          {/* Pitch */}
          <div>
            <label className="block text-sm font-medium text-[#1E1B4B] mb-1">
              Pitch: {speechPitch.toFixed(1)}
            </label>
            <input
              type="range"
              min="0.5"
              max="2.0"
              step="0.1"
              value={speechPitch}
              onChange={(e) => handlePitchChange(parseFloat(e.target.value))}
              className="w-full h-2 bg-[#EDE9FE] rounded-lg appearance-none cursor-pointer accent-[#7C3AED]"
            />
            <div className="flex justify-between text-[10px] text-[#6B7280] mt-0.5">
              <span>Low (0.5)</span>
              <span>Normal (1.0)</span>
              <span>High (2.0)</span>
            </div>
          </div>
        </div>

        {/* Active voice info badge */}
        <div className="flex items-center gap-2 p-3 bg-[#F5F3FF] border border-[#DDD6FE]/60 rounded-lg">
          <Volume2 className="w-4 h-4 text-[#7C3AED] flex-shrink-0" />
          <p className="text-xs text-[#6B7280]">
            Active voice: <span className="font-medium text-[#1E1B4B]">{currentVoice}</span>
            {' '}&middot; Tessa will speak all bot responses in the chat
          </p>
        </div>
      </div>

      {/* Local-only info banner */}
      <p className="text-[10px] text-[#6B7280] mt-4">
        Voice settings are browser-specific and saved locally
      </p>
    </div>
  );
}
