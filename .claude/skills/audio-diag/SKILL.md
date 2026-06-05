---
name: audio-diag
description: Diagnose a recorded WAV from a Listening Resume session — reads the real WAV header (format/duration), and measures peak/RMS, clipping, hard glitches, and per-segment levels (e.g. to verify mute or mic mixing). Use when investigating audio bugs like wrong duration, "estourado"/clipping, crackle, silence, or mute not working.
---

# Audio diagnostics (audio-diag)

WAV chunks live at `%LOCALAPPDATA%\listening-resume\sessions\<id>\audio\chunk_0000.wav`.
WAV header offsets: channels @22 (u16), sampleRate @24 (u32), bitsPerSample @34 (u16), dataSize @40 (u32). Samples start at byte 44.

## Header + duration + peak/RMS/clipping

```powershell
$f = "<path-to>.wav"
$b = [System.IO.File]::ReadAllBytes($f)
$ch=[BitConverter]::ToUInt16($b,22); $sr=[BitConverter]::ToUInt32($b,24)
$bps=[BitConverter]::ToUInt16($b,34); $ds=[BitConverter]::ToUInt32($b,40)
$dur = $ds / ($sr*$ch*($bps/8))
$max=0; [long]$sumsq=0; $clip=0; $n=0
for ($i=44; $i -lt $b.Length-1; $i+=2) {
  $s=[int][BitConverter]::ToInt16($b,$i); $a=[math]::Abs($s)
  if($a -gt $max){$max=$a}; if($a -ge 32767){$clip++}; $sumsq+=[long]$a*$a; $n++
}
$rms=[math]::Sqrt($sumsq/$n)
"ch=$ch sr=$sr bps=$bps dur=$([math]::Round($dur,2))s"
"peak=$([math]::Round(20*[math]::Log10($max/32767),1))dBFS rms=$([math]::Round(20*[math]::Log10($rms/32767),1))dBFS clipped=$clip"
```

Interpret:
- **Duration wrong** in the UI but right here → the duration calc (`getAudioDuration` in `server.ts`) isn't reading the header (e.g. assuming 16k/mono → 6x inflation).
- **clipped > 0** or peak ≈ 0 dBFS → real clipping ("estourado"). If peak is low (−9 dBFS or less) and the user still hears distortion, it's playback-side, not the capture.
- **max = 0** → pure silence (nothing played, or system muted).

## Hard glitches (dropped-buffer crackle)

```powershell
$prev=0;$g=0; for($i=44;$i -lt $b.Length-3;$i+=4){ $v=[int][BitConverter]::ToInt16($b,$i); if([math]::Abs($v-$prev) -gt 16384){$g++}; $prev=$v }
"glitches(|Δ|>half-scale)=$g"
```
Many half-scale jumps at 48 kHz = dropped packets (capture overrun).

## Per-segment level (verify mute / mic mixing)

Compare a segment before vs after an action (e.g. mute at t=3s). `max` should drop to ~0 in the muted segment:

```powershell
function Seg($s0,$s1){ $bp=$sr*$ch*2; $a=44+[int]($s0*$bp); $e=[math]::Min($b.Length-1,44+[int]($s1*$bp)); $m=0; for($i=$a;$i -lt $e-1;$i+=2){$v=[math]::Abs([int][BitConverter]::ToInt16($b,$i)); if($v -gt $m){$m=$v}}; "max=$m" }
"0-2.5s: $(Seg 0 2.5)"; "4-6s: $(Seg 4 6)"
```
