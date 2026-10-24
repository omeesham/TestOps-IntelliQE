import { useState } from 'react';
import { Sparkles, Check, Undo2, Loader2 } from 'lucide-react';
import { suggestPrompts, type PromptSuggestion } from '@/services/api';

interface Props {
  /** The text the user typed. */
  value: string;
  /** Replace the text with a chosen suggestion (or the original, on Undo). */
  onApply: (text: string) => void;
  /** Names only, for grounded suggestions. */
  appName?: string;
  environment?: string;
}

const MIN_CHARS = 10;

/**
 * Turns plain-language requirement text into up to 3 sharper versions
 * (focused, broader coverage, risk-focused). Optional: the user picks one,
 * edits it, or ignores the suggestions.
 */
export default function PromptSuggestions({ value, onApply, appName, environment }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<PromptSuggestion[]>([]);
  // The text the suggestions were made for, and the suggestion applied (if any).
  const [basis, setBasis] = useState<string | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);

  const ready = value.trim().length >= MIN_CHARS;
  // Suggestions belong to the text they were made for: hide them once the user
  // edits the text (applying a suggestion does not count as an edit).
  const current = basis !== null && (value === basis || (chosen !== null && value === suggestions[chosen]?.prompt));
  const shown = current ? suggestions : [];

  const analyze = async () => {
    setLoading(true);
    setError(null);
    setChosen(null);
    try {
      const res = await suggestPrompts({ text: value.trim(), appName, environment });
      setSuggestions(res);
      setBasis(value);
    } catch (err) {
      const message = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(message || 'Could not get suggestions right now. You can continue without them.');
      setSuggestions([]);
    } finally {
      setLoading(false);
    }
  };

  const choose = (i: number) => {
    setChosen(i);
    onApply(suggestions[i].prompt);
  };

  // Undo only while the chosen suggestion is unedited, so later edits are never lost.
  const canUndo = chosen !== null && basis !== null && value === suggestions[chosen]?.prompt;
  const undo = () => {
    if (canUndo) onApply(basis!);
    setChosen(null);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={analyze}
          disabled={!ready || loading}
          title={ready ? 'Get clearer versions of your text' : `Type at least ${MIN_CHARS} characters first`}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-violet-300 text-violet-700 bg-white hover:bg-violet-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          {loading ? 'Suggesting…' : shown.length ? 'Suggest again' : 'Suggest improvements'}
        </button>
        {canUndo && (
          <button type="button" onClick={undo} className="inline-flex items-center gap-1 text-[11px] text-gray-500 hover:text-violet-700">
            <Undo2 className="w-3 h-3" /> Undo
          </button>
        )}
        {!shown.length && !loading && (
          <span className="text-[11px] text-gray-400">Optional: get clearer, more testable versions of your text.</span>
        )}
      </div>

      {error && <p className="text-[11px] text-rose-600" role="alert">{error}</p>}

      {shown.length > 0 && (
        <div className="space-y-2" role="listbox" aria-label="Suggested versions">
          {shown.map((s, i) => (
            <button
              key={i}
              type="button"
              role="option"
              aria-selected={chosen === i}
              onClick={() => choose(i)}
              className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
                chosen === i ? 'border-violet-500 bg-violet-50' : 'border-gray-200 bg-white hover:border-violet-300'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-gray-800">{s.title}</span>
                {chosen === i
                  ? <span className="inline-flex items-center gap-1 text-[11px] font-medium text-violet-700"><Check className="w-3.5 h-3.5" />Using this</span>
                  : <span className="text-[11px] text-violet-700">Use this</span>}
              </div>
              {s.why && <p className="text-[11px] text-gray-500 mt-0.5">{s.why}</p>}
              <p className="text-xs text-gray-700 mt-1 line-clamp-3">{s.prompt}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
