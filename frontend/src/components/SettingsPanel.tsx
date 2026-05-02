import { useMemo } from "react";
import type { Settings, Voice } from "../types";
import { groupByLangPrefix, pickDefaultVoice } from "../voices";

interface Props {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  onChange: (next: Settings) => void;
  voices: Voice[];
  voicesError: string | null;
  onReloadVoices: () => void;
}

interface LangOption {
  prefix: string;
  label: string;
  count: number;
}

function buildLangOptions(voices: Voice[]): LangOption[] {
  const grouped = groupByLangPrefix(voices);
  const DN = (typeof Intl !== "undefined" && (Intl as { DisplayNames?: typeof Intl.DisplayNames }).DisplayNames)
    ? new Intl.DisplayNames([navigator.language || "en"], { type: "language" })
    : null;
  const opts: LangOption[] = [];
  for (const [prefix, list] of grouped) {
    let label = prefix;
    try {
      label = DN?.of(prefix) ?? prefix;
    } catch {
      label = prefix;
    }
    opts.push({ prefix, label, count: list.length });
  }
  opts.sort((a, b) => a.label.localeCompare(b.label));
  return opts;
}

export default function SettingsPanel({
  open,
  onClose,
  settings,
  onChange,
  voices,
  voicesError,
  onReloadVoices,
}: Props) {
  const grouped = useMemo(() => groupByLangPrefix(voices), [voices]);
  const langOptions = useMemo(() => buildLangOptions(voices), [voices]);

  const configuredLangs = useMemo(() => {
    const set = new Set<string>(Object.keys(settings.voicesByLang));
    set.add(settings.primaryLang.toLowerCase().split("-")[0]);
    return Array.from(set).sort();
  }, [settings]);

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    onChange({ ...settings, [key]: value });
  }

  function setVoiceForLang(prefix: string, voiceShortName: string | null) {
    const next = { ...settings.voicesByLang };
    if (!voiceShortName) delete next[prefix];
    else next[prefix] = voiceShortName;
    update("voicesByLang", next);
  }

  function addLang(prefix: string) {
    if (!prefix) return;
    if (settings.voicesByLang[prefix]) return;
    const def = pickDefaultVoice(voices, prefix);
    if (!def) return;
    setVoiceForLang(prefix, def.shortName);
  }

  return (
    <>
      <div
        className={`drawer-backdrop ${open ? "open" : ""}`}
        onClick={onClose}
        aria-hidden={!open}
      />
      <aside
        className={`drawer settings-drawer ${open ? "open" : ""}`}
        role="dialog"
        aria-label="Settings"
      >
        <header className="drawer-head">
          <h2>Settings</h2>
          <button onClick={onClose} aria-label="Close">✕</button>
        </header>

        <section>
          <label className="field">
            <span>Worker URL</span>
            <input
              type="url"
              value={settings.workerUrl}
              onChange={(e) => update("workerUrl", e.target.value)}
              placeholder="https://tts-relay.your-account.workers.dev"
            />
            <small>Leave as <code>/api</code> for local <code>wrangler dev</code>.</small>
          </label>
        </section>

        <section>
          <h3>Voices</h3>
          {voicesError && (
            <div className="error-banner">
              {voicesError}
              <button onClick={onReloadVoices}>Retry</button>
            </div>
          )}
          {voices.length === 0 && !voicesError && (
            <div className="muted">Loading voice list…</div>
          )}

          <label className="field">
            <span>Primary language (fallback for ambiguous text)</span>
            <select
              value={settings.primaryLang}
              onChange={(e) => update("primaryLang", e.target.value)}
            >
              {langOptions.map((o) => (
                <option key={o.prefix} value={o.prefix}>
                  {o.label} ({o.prefix}) · {o.count} voices
                </option>
              ))}
            </select>
          </label>

          <div className="voices-by-lang">
            {configuredLangs.map((prefix) => {
              const list = grouped.get(prefix) ?? [];
              const selected = settings.voicesByLang[prefix]
                ?? pickDefaultVoice(voices, prefix)?.shortName
                ?? "";
              const langLabel =
                langOptions.find((o) => o.prefix === prefix)?.label ?? prefix;
              return (
                <div key={prefix} className="voice-row">
                  <div className="voice-row-head">
                    <strong>{langLabel}</strong>
                    <code>{prefix}</code>
                    {prefix !== settings.primaryLang.toLowerCase().split("-")[0] && (
                      <button
                        className="link"
                        onClick={() => setVoiceForLang(prefix, null)}
                      >
                        remove
                      </button>
                    )}
                  </div>
                  <select
                    value={selected}
                    onChange={(e) => setVoiceForLang(prefix, e.target.value)}
                  >
                    {list.length === 0 && <option value="">No voices for this language</option>}
                    {list.map((v) => (
                      <option key={v.shortName} value={v.shortName}>
                        {v.displayName} · {v.locale} · {v.gender} · {v.provider}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>

          <div className="add-lang">
            <label>
              <span>Add another language</span>
              <select
                value=""
                onChange={(e) => {
                  addLang(e.target.value);
                  e.currentTarget.value = "";
                }}
              >
                <option value="">Choose a language…</option>
                {langOptions
                  .filter((o) => !configuredLangs.includes(o.prefix))
                  .map((o) => (
                    <option key={o.prefix} value={o.prefix}>
                      {o.label} ({o.prefix})
                    </option>
                  ))}
              </select>
            </label>
          </div>
        </section>

        <section>
          <h3>Reading</h3>
          <label className="field check">
            <input
              type="checkbox"
              checked={settings.skipHeaderFooter}
              onChange={(e) => update("skipHeaderFooter", e.target.checked)}
            />
            <span>Skip page headers and footers</span>
          </label>
        </section>

        <section>
          <h3>Prosody</h3>
          <label className="field">
            <span>Rate ({settings.rate})</span>
            <input
              type="range"
              min={-50}
              max={100}
              step={5}
              value={parseInt(settings.rate, 10) || 0}
              onChange={(e) => {
                const n = Number(e.target.value);
                update("rate", `${n >= 0 ? "+" : ""}${n}%`);
              }}
            />
          </label>
          <label className="field">
            <span>Pitch ({settings.pitch})</span>
            <input
              type="range"
              min={-50}
              max={50}
              step={1}
              value={parseInt(settings.pitch, 10) || 0}
              onChange={(e) => {
                const n = Number(e.target.value);
                update("pitch", `${n >= 0 ? "+" : ""}${n}Hz`);
              }}
            />
          </label>
        </section>
      </aside>
    </>
  );
}
