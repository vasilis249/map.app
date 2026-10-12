import { Capacitor } from "@capacitor/core";
import { TextToSpeech } from "@capacitor-community/text-to-speech";
import type { SpeechEngine } from "./speech-queue";

/**
 * The voice for guidance. In the iOS app: the native text-to-speech plugin (AVSpeechSynthesizer with its own audio
 * session — it never changes the web view's session, so the walkie's Web Audio isn't paused, LESSONS #1). Elsewhere
 * (browser, an older app build without the plugin): the Web Speech API.
 */

const native = () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("TextToSpeech");
const web = () => (typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null);
const tag = (lang: string) => (lang.startsWith("en") ? "en-US" : "el-GR");

function webVoice(lang: string): SpeechSynthesisVoice | null {
  const voices = web()?.getVoices() ?? [];
  const t = tag(lang).toLowerCase();
  return voices.find((v) => v.lang.toLowerCase() === t) ?? voices.find((v) => v.lang.toLowerCase().startsWith(t.slice(0, 2))) ?? null;
}

export function speechEngine(lang: string): SpeechEngine {
  return {
    speak(text) {
      if (native()) return TextToSpeech.speak({ text, lang: tag(lang), rate: 1, category: "playback" }).catch(() => undefined);
      const s = web();
      if (!s) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = tag(lang);
        const v = webVoice(lang);
        if (v) u.voice = v;
        // Some engines never fire onend (no voice installed): don't wait forever.
        const guard = setTimeout(resolve, 2_000 + text.length * 120);
        u.onend = u.onerror = () => {
          clearTimeout(guard);
          resolve();
        };
        s.speak(u);
      });
    },
    stop() {
      if (native()) void TextToSpeech.stop().catch(() => undefined);
      else web()?.cancel();
    },
  };
}

/** iOS Safari speaks only after a first utterance from a tap: call inside the "Start" tap. */
export function unlockSpeech() {
  const s = web();
  if (native() || !s) return;
  const u = new SpeechSynthesisUtterance(" ");
  u.volume = 0;
  s.speak(u);
}
