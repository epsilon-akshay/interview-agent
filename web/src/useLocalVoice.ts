import { useCallback, useRef, useState } from "react";

export type VoiceStatus = "idle" | "connecting" | "connected" | "thinking" | "speaking" | "error";
type SpeechEvent = Event & { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> };
type Recognition = {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult: ((event: SpeechEvent) => void) | null;
  onerror: ((event: Event & { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void;
};
type History = { role: "user" | "assistant"; text: string };

function getRecognition() {
  const speechWindow = window as typeof window & {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  };
  return speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
}

export function useLocalVoice() {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [error, setError] = useState("");
  const recognitionRef = useRef<Recognition | null>(null);
  const historyRef = useRef<History[]>([]);
  const activeRef = useRef(false);
  const listeningRef = useRef(true);
  const processingRef = useRef(false);

  const startListening = useCallback(() => {
    if (!activeRef.current || !listeningRef.current || processingRef.current) return;
    try { recognitionRef.current?.start(); } catch { /* already listening */ }
  }, []);

  const speak = useCallback((text: string) => {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.02;
    const voices = window.speechSynthesis.getVoices();
    utterance.voice = voices.find((voice) => /Samantha|Google US English|Daniel/i.test(voice.name)) || voices.find((voice) => voice.lang.startsWith("en")) || null;
    utterance.onstart = () => setStatus("speaking");
    const resume = () => { processingRef.current = false; setStatus("connected"); startListening(); };
    utterance.onend = resume;
    utterance.onerror = resume;
    window.speechSynthesis.speak(utterance);
  }, [startListening]);

  const sendTurn = useCallback(async (message: string) => {
    const clean = message.trim();
    if (!clean || processingRef.current) return;
    processingRef.current = true;
    recognitionRef.current?.stop();
    setStatus("thinking");
    setError("");
    const started = performance.now();
    try {
      const response = await fetch("/api/local-voice/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: clean, history: historyRef.current })
      });
      if (!response.ok) throw new Error((await response.text()).trim() || `Conversation failed (${response.status}).`);
      const data = await response.json() as { reply?: string };
      if (!data.reply) throw new Error("Codex returned no reply.");
      setLatencyMs(Math.round(performance.now() - started));
      historyRef.current = [...historyRef.current, { role: "user", text: clean }, { role: "assistant", text: data.reply }].slice(-12) as History[];
      speak(data.reply);
    } catch (reason) {
      processingRef.current = false;
      setStatus("error");
      setError(reason instanceof Error ? reason.message : "Local voice conversation failed.");
    }
  }, [speak]);

  const disconnect = useCallback(() => {
    activeRef.current = false;
    processingRef.current = false;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    window.speechSynthesis.cancel();
    setStatus("idle");
  }, []);

  const connect = useCallback(async (_media: MediaStream) => {
    disconnect();
    const RecognitionClass = getRecognition();
    if (!RecognitionClass) {
      setStatus("error");
      setError("Speech recognition is unavailable. Use Chrome or Edge for local voice mode.");
      throw new Error("Speech recognition is unavailable in this browser.");
    }
    setStatus("connecting");
    setError("");
    setLatencyMs(null);
    historyRef.current = [];
    activeRef.current = true;
    listeningRef.current = true;
    const recognition = new RecognitionClass();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      let transcript = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        if (event.results[index].isFinal) transcript += event.results[index][0].transcript;
      }
      if (transcript.trim()) void sendTurn(transcript);
    };
    recognition.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      setError(`Speech recognition error: ${event.error || "unknown error"}.`);
      setStatus("error");
    };
    recognition.onend = () => {
      if (activeRef.current && listeningRef.current && !processingRef.current) window.setTimeout(startListening, 250);
    };
    recognitionRef.current = recognition;
    setStatus("connected");
    startListening();
    await sendTurn("Start our conversation with a brief, friendly greeting.");
  }, [disconnect, sendTurn, startListening]);

  const setMuted = useCallback((muted: boolean) => {
    listeningRef.current = !muted;
    if (muted) recognitionRef.current?.stop(); else startListening();
  }, [startListening]);

  return { status, latencyMs, error, connect, disconnect, setMuted };
}
