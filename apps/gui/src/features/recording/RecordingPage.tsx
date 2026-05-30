import { useEffect, useState, useCallback } from "react";
import { useStore } from "../../store";
import { Square, Mic, MicOff, Volume2, VolumeX } from "lucide-react";
import { formatDuration } from "../../shared/lib/format";
import { api } from "../../shared/lib/api";
import { AudioWaveform } from "./AudioWaveform";

export function RecordingPage() {
  const {
    isRecording,
    recordingStartTime,
    stopRecording,
    recordingDevice,
    selectedMicDevice,
  } = useStore();
  const [elapsed, setElapsed] = useState(0);
  const [chunks, setChunks] = useState(0);
  const [micMuted, setMicMuted] = useState(false);
  const [systemMuted, setSystemMuted] = useState(false);

  useEffect(() => {
    if (!isRecording || !recordingStartTime) return;
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - recordingStartTime) / 1000));
    }, 100);
    return () => clearInterval(timer);
  }, [isRecording, recordingStartTime]);

  useEffect(() => {
    if (!isRecording) return;
    const poll = setInterval(async () => {
      try {
        const status = await api.getRecordingStatus();
        if (status.chunks !== undefined) setChunks(status.chunks);
      } catch {
        /* ignore */
      }
    }, 2000);
    return () => clearInterval(poll);
  }, [isRecording]);

  // Poll mute state
  useEffect(() => {
    if (!isRecording) return;
    const fetchLevels = async () => {
      try {
        const levels = await api.getRecordingLevels();
        setMicMuted(levels.mic.muted);
        setSystemMuted(levels.system.muted);
      } catch {
        /* ignore */
      }
    };
    fetchLevels();
    const poll = setInterval(fetchLevels, 2000);
    return () => clearInterval(poll);
  }, [isRecording]);

  const toggleMicMute = useCallback(async () => {
    const newMuted = !micMuted;
    setMicMuted(newMuted);
    try {
      await api.setMute("mic", newMuted);
    } catch {
      setMicMuted(!newMuted);
    }
  }, [micMuted]);

  const toggleSystemMute = useCallback(async () => {
    const newMuted = !systemMuted;
    setSystemMuted(newMuted);
    try {
      await api.setMute("system", newMuted);
    } catch {
      setSystemMuted(!newMuted);
    }
  }, [systemMuted]);

  if (!isRecording) return null;

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 relative">
      {/* Background pulse */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="w-64 h-64 rounded-full bg-recording/5 animate-ping" />
      </div>

      {/* Main content */}
      <div className="relative z-10 flex flex-col items-center gap-6 w-full max-w-lg">
        {/* Waveform visualization */}
        <div className="w-full px-4">
          <AudioWaveform isActive={!systemMuted} barCount={40} height={72} />
        </div>

        {/* Time display */}
        <div className="text-center">
          <p className="text-5xl font-mono font-light text-text-primary tracking-wider">
            {formatDuration(elapsed)}
          </p>
          <p className="text-sm text-text-secondary mt-3">
            Recording from {recordingDevice || "default device"}
          </p>
          {chunks > 0 && (
            <p className="text-xs text-text-muted mt-1">
              {chunks} chunks saved
            </p>
          )}
        </div>

        {/* Controls row: Mute buttons + Stop */}
        <div className="flex items-center gap-6">
          {/* System audio mute */}
          <button
            onClick={toggleSystemMute}
            className={`w-12 h-12 rounded-full flex items-center justify-center transition-all cursor-pointer ${
              systemMuted
                ? "bg-text-muted/20 border border-text-muted/40 text-text-muted"
                : "bg-accent/10 border border-accent/30 text-accent hover:bg-accent/20"
            }`}
            title={
              systemMuted ? "Ativar áudio do sistema" : "Mutar áudio do sistema"
            }
          >
            {systemMuted ? (
              <VolumeX className="w-5 h-5" />
            ) : (
              <Volume2 className="w-5 h-5" />
            )}
          </button>

          {/* Stop button */}
          <button
            onClick={stopRecording}
            className="w-16 h-16 rounded-full bg-recording hover:bg-red-500 flex items-center justify-center shadow-xl shadow-recording/30 transition-all cursor-pointer"
          >
            <Square className="w-6 h-6 text-white fill-white" />
          </button>

          {/* Mic mute */}
          {selectedMicDevice && (
            <button
              onClick={toggleMicMute}
              className={`w-12 h-12 rounded-full flex items-center justify-center transition-all cursor-pointer ${
                micMuted
                  ? "bg-text-muted/20 border border-text-muted/40 text-text-muted"
                  : "bg-accent/10 border border-accent/30 text-accent hover:bg-accent/20"
              }`}
              title={micMuted ? "Ativar microfone" : "Mutar microfone"}
            >
              {micMuted ? (
                <MicOff className="w-5 h-5" />
              ) : (
                <Mic className="w-5 h-5" />
              )}
            </button>
          )}
        </div>

        <p className="text-xs text-text-muted">Click to stop recording</p>
      </div>
    </div>
  );
}
