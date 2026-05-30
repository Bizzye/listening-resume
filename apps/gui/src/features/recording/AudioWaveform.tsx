import { useEffect, useRef } from "react";

interface AudioWaveformProps {
  isActive: boolean;
  barCount?: number;
  color?: string;
  height?: number;
}

export function AudioWaveform({
  isActive,
  barCount = 32,
  color = "var(--color-recording)",
  height = 64,
}: AudioWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  const barsRef = useRef<number[]>(Array(barCount).fill(0));
  const targetBarsRef = useRef<number[]>(Array(barCount).fill(0));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    let lastTime = 0;
    const barWidth = canvas.offsetWidth / barCount;
    const gap = 2;

    const animate = (time: number) => {
      const dt = Math.min((time - lastTime) / 1000, 0.1);
      lastTime = time;

      ctx.clearRect(0, 0, canvas.offsetWidth, height);

      // Update target bars with organic movement
      if (isActive) {
        for (let i = 0; i < barCount; i++) {
          // Create wave-like patterns with some randomness
          const wave1 = Math.sin(time * 0.003 + i * 0.4) * 0.3;
          const wave2 = Math.sin(time * 0.005 + i * 0.2) * 0.2;
          const wave3 = Math.sin(time * 0.001 + i * 0.8) * 0.15;
          const noise = (Math.random() - 0.5) * 0.3;
          const base = 0.15 + wave1 + wave2 + wave3 + noise;
          targetBarsRef.current[i] = Math.max(0.05, Math.min(1, base + 0.4));
        }
      } else {
        for (let i = 0; i < barCount; i++) {
          // Flat line with very subtle breathing
          targetBarsRef.current[i] =
            0.03 + Math.sin(time * 0.001 + i * 0.1) * 0.02;
        }
      }

      // Smooth interpolation
      const speed = isActive ? 12 : 4;
      for (let i = 0; i < barCount; i++) {
        barsRef.current[i] +=
          (targetBarsRef.current[i] - barsRef.current[i]) * speed * dt;
      }

      // Draw bars
      for (let i = 0; i < barCount; i++) {
        const barHeight = Math.max(2, barsRef.current[i] * height);
        const x = i * barWidth + gap / 2;
        const y = (height - barHeight) / 2;
        const w = barWidth - gap;

        ctx.fillStyle = color;
        ctx.globalAlpha = isActive ? 0.9 : 0.3;
        ctx.beginPath();
        ctx.roundRect(x, y, w, barHeight, 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      animationRef.current = requestAnimationFrame(animate);
    };

    animationRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationRef.current);
  }, [isActive, barCount, color, height]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full"
      style={{ height: `${height}px` }}
    />
  );
}
