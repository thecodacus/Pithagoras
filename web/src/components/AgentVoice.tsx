import { useEffect, useState } from "react";
import { LuPlus } from "react-icons/lu";
import { api, type VoiceConfig } from "../api";
import { Select } from "./Select";
import { AddVoiceForm, voicePresets, type Preset } from "./VoiceLibrary";
import { t } from "../i18n";

/** Picked in the voice menu to add a voice rather than choose one. */
const ADD_VOICE = "\u0000add";

/**
 * The voice an agent speaks with in voice mode: the one in the voice settings
 * (""), the designed voice, or one from the library. The last entry adds a
 * voice to the library, in place, and picks it. Nothing at all without the
 * voice add-on installed and speaking.
 */
export function VoicePicker({ value, onChange }: { value: string; onChange: (voice: string) => void }) {
  const [config, setConfig] = useState<VoiceConfig | null>(null);
  const [voices, setVoices] = useState<Preset[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.voice().then(setConfig, () => {});
    voicePresets().then(setVoices, () => {});
  }, []);

  if (!config?.enabled || config.speech === false) return null;

  const named = (id: string | undefined) => (!id || id === "design" ? t("Designed voice") : (voices.find((v) => v.id === id)?.name ?? id));

  return (
    <div className="mt-4">
      <div className="text-xs text-fg-muted">
        {t("Voice")}
        <Select
          className="mt-1 w-full"
          aria-label={t("Voice")}
          value={value}
          onChange={(v) => (v === ADD_VOICE ? setAdding(true) : onChange(v))}
          options={[
            { value: "", label: t("As in the voice settings"), hint: named(config.voice) },
            { value: "design", label: t("Designed voice") },
            ...voices.map((v) => ({ value: v.id, label: v.name, text: v.name, hint: v.kind === "clone" ? t("Reference clone") : t("Designed") })),
            {
              value: ADD_VOICE,
              label: <span className="inline-flex items-center gap-1.5 text-accent"><LuPlus className="h-3.5 w-3.5" />{t("Add voice")}</span>,
              text: t("Add voice"),
            },
          ]}
        />
      </div>
      {error && <p role="alert" className="mt-1 text-xs text-danger">{error}</p>}
      {adding && (
        <div className="mt-2 rounded-lg border border-line bg-surface p-3">
          <AddVoiceForm
            onError={setError}
            onAdded={(voice) => {
              setVoices((v) => [...v, voice]);
              setAdding(false);
              setError("");
              onChange(voice.id);
            }}
          />
          <button type="button" onClick={() => setAdding(false)} className="mt-2 text-xs text-fg-muted hover:text-fg">
            {t("Cancel")}
          </button>
        </div>
      )}
    </div>
  );
}
