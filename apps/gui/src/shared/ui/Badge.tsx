import { clsx } from "clsx";

type SessionStatus = string;

const statusConfig: Record<string, { label: string; color: string }> = {
  created: {
    label: "Created",
    color: "bg-surface-active/20 text-text-muted border-border",
  },
  recording: {
    label: "Recording",
    color: "bg-recording/20 text-recording border-recording/30",
  },
  stopped: {
    label: "Stopped",
    color: "bg-warning/20 text-warning border-warning/30",
  },
  transcribing: {
    label: "Transcribing",
    color: "bg-warning/20 text-warning border-warning/30",
  },
  transcribed: {
    label: "Transcribed",
    color: "bg-accent/20 text-accent border-accent/30",
  },
  analyzing: {
    label: "Analyzing",
    color: "bg-accent/20 text-accent border-accent/30",
  },
  completed: {
    label: "Completed",
    color: "bg-success/20 text-success border-success/30",
  },
  failed: {
    label: "Failed",
    color: "bg-red-500/20 text-red-400 border-red-500/30",
  },
};

export function Badge({ status }: { status: SessionStatus }) {
  const { label, color } = statusConfig[status] ?? {
    label: status,
    color: "bg-surface-active text-text-muted border-border",
  };
  return (
    <span
      className={clsx(
        "inline-flex items-center px-2 py-0.5 text-[10px] font-medium rounded-full border",
        color,
      )}
    >
      {label}
    </span>
  );
}
