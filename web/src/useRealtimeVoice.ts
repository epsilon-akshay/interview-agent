import { useCallback, useRef, useState } from "react";

export type VoiceStatus = "idle" | "connecting" | "connected" | "speaking" | "error";
type RealtimeEvent = { type?: string; error?: { message?: string } };

export function useRealtimeVoice() {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [error, setError] = useState("");
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const speechStoppedRef = useRef<number | null>(null);

  const disconnect = useCallback(() => {
    channelRef.current?.close();
    peerRef.current?.close();
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.srcObject = null; }
    channelRef.current = null;
    peerRef.current = null;
    audioRef.current = null;
    setStatus("idle");
  }, []);

  const connect = useCallback(async (media: MediaStream) => {
    disconnect();
    setStatus("connecting");
    setError("");
    setLatencyMs(null);
    try {
      const track = media.getAudioTracks()[0];
      if (!track) throw new Error("No microphone track is available.");
      const peer = new RTCPeerConnection();
      peerRef.current = peer;
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audioRef.current = audio;
      peer.ontrack = (event) => { audio.srcObject = event.streams[0]; void audio.play().catch(() => undefined); };
      peer.onconnectionstatechange = () => {
        if (["failed", "disconnected", "closed"].includes(peer.connectionState)) {
          setStatus(peer.connectionState === "closed" ? "idle" : "error");
          if (peer.connectionState !== "closed") setError(`Voice connection ${peer.connectionState}.`);
        }
      };
      peer.addTrack(track, media);
      const channel = peer.createDataChannel("oai-events");
      channelRef.current = channel;
      channel.onopen = () => {
        setStatus("connected");
        channel.send(JSON.stringify({ type: "response.create", response: { instructions: "Greet the candidate naturally and start a casual conversation now." } }));
      };
      channel.onmessage = (message) => {
        let event: RealtimeEvent;
        try { event = JSON.parse(message.data) as RealtimeEvent; } catch { return; }
        if (event.type === "input_audio_buffer.speech_stopped") { speechStoppedRef.current = performance.now(); setStatus("connected"); }
        if (event.type === "response.created" && speechStoppedRef.current !== null) setLatencyMs(Math.round(performance.now() - speechStoppedRef.current));
        if (event.type === "response.output_audio.delta" || event.type === "output_audio_buffer.started") setStatus("speaking");
        if (event.type === "response.done" || event.type === "output_audio_buffer.stopped") setStatus("connected");
        if (event.type === "error") { setStatus("error"); setError(event.error?.message || "Realtime voice returned an error."); }
      };
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const response = await fetch("/api/realtime/session", { method: "POST", headers: { "Content-Type": "application/sdp" }, body: offer.sdp });
      if (!response.ok) throw new Error((await response.text()).trim() || `Could not create voice session (${response.status}).`);
      await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });
    } catch (reason) {
      peerRef.current?.close();
      setStatus("error");
      setError(reason instanceof Error ? reason.message : "Could not connect to Realtime voice.");
      throw reason;
    }
  }, [disconnect]);

  return { status, latencyMs, error, connect, disconnect };
}
