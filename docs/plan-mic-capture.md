# Plano: Captura de Microfone + Áudio do Sistema

## Objetivo

Capturar simultaneamente o áudio do sistema (monitor/loopback) e a voz do usuário via microfone, combinando ambos em um único arquivo de áudio por chunk. Deve funcionar em Linux e Windows.

---

## Arquitetura Atual

- **Uma fonte por vez**: `AudioCapturePort` captura apenas `device` (string única)
- **Linux**: FFmpeg `-f pulse` + sink `.monitor`
- **Windows**: `wasapi-capture.exe` (loopback nativo) ou FFmpeg `-f dshow` + "Stereo Mix"
- **Device discovery**: Só lista sinks/monitores, nunca microfones
- **Formato**: WAV 16-bit PCM, mono, 16kHz, chunks de 120s

---

## Solução Proposta

### Abordagem: Dual-input FFmpeg com filtro `amix`

Quando um microfone for selecionado, o FFmpeg recebe **duas entradas** e as mixa em tempo real:

```bash
# Linux
ffmpeg \
  -f pulse -i "<monitor_device>" \
  -f pulse -i "<mic_device>" \
  -filter_complex "[0:a]volume=1.0[sys];[1:a]volume=1.2[mic];[sys][mic]amix=inputs=2:duration=longest:dropout_transition=0,dynaudnorm" \
  -ac 1 -ar 16000 -t 120 chunk_0000.wav

# Windows (fallback dshow)
ffmpeg ^
  -f dshow -i audio="Stereo Mix" ^
  -f dshow -i audio="Microphone (Realtek Audio)" ^
  -filter_complex "[0:a]volume=1.0[sys];[1:a]volume=1.2[mic];[sys][mic]amix=inputs=2:duration=longest:dropout_transition=0,dynaudnorm" ^
  -ac 1 -ar 16000 -t 120 chunk_0000.wav
```

**Windows com `wasapi-capture.exe`**: Abordagem híbrida — o binário nativo captura o loopback enquanto um processo FFmpeg separado captura o microfone. Os chunks são mesclados em pós-processamento (ou estendemos o binário para aceitar `--mic`).

### Decisão de Mix

| Modo             | Quando usar                                                   |
| ---------------- | ------------------------------------------------------------- |
| **mixed (mono)** | Padrão — simples, funciona com qualquer modelo de transcrição |
| **stereo-split** | L=sistema, R=mic — útil para diarização futura                |

**Fase 1**: Apenas `mixed` (mono). Simplifica tudo.

---

## Mudanças Necessárias

### 1. Interface `AudioDevice` — adicionar tipo

**Arquivo**: `packages/core/src/ports/audio-capture.ts`

```typescript
export interface AudioDevice {
  id: string;
  name: string;
  isMonitor: boolean;
  isDefault: boolean;
  type: "monitor" | "microphone"; // NOVO
}
```

### 2. Interface `CaptureOptions` — campo de microfone

**Arquivo**: `packages/core/src/ports/audio-capture.ts`

```typescript
export interface CaptureOptions {
  device: string;
  micDevice?: string; // NOVO: ID do microfone (opcional)
  micVolume?: number; // NOVO: 0.0–2.0, default 1.0
  sampleRate: number;
  channels: number;
  chunkSeconds: number;
  outputDir: string;
  filenamePrefix: string;
}
```

### 3. Linux — `FFmpegPulseAdapter`

**Arquivo**: `packages/core/src/adapters/audio/ffmpeg-pulse.ts`

Alterações:

- `listDevices()`: Além de listar sinks (`.monitor`), também executar `pactl list sources short` e incluir fontes que **não** terminam em `.monitor` como type `microphone`
- `recordNextChunk()`: Se `micDevice` estiver definido, montar comando FFmpeg com dois inputs + `amix` filter

**Listagem de microfones no Linux**:

```bash
pactl list sources short
# Filtrar linhas que NÃO contêm ".monitor"
# Ex: "alsa_input.pci-0000_00_1f.3.analog-stereo" → microfone
```

### 4. Windows — `FFmpegWasapiAdapter`

**Arquivo**: `packages/core/src/adapters/audio/ffmpeg-wasapi.ts`

Alterações:

- `listDevices()`: Adicionar listagem de dispositivos de entrada (microfones) via:
  - `ffmpeg -list_devices true -f dshow -i dummy` — já lista tudo, filtrar por tipo "audio" e separar os que não são loopback
  - Ou PowerShell: `Get-PnpDevice -Class AudioEndpoint | Where Status -eq OK`
- Quando `micDevice` estiver definido:
  - **Se usando ffmpeg fallback**: dual-input dshow igual ao Linux
  - **Se usando wasapi-capture.exe nativo**: Fase 1 = capturar mic com ffmpeg separado e mesclar. Fase 2 = estender binário com `--mic`

### 5. UI — Seleção de microfone

**Arquivo**: `apps/gui/src/features/settings/SettingsPage.tsx`

- Novo dropdown "Microfone" na seção Audio, listando devices com `type === 'microphone'`
- Opção "Nenhum (só áudio do sistema)" como padrão
- Botão "Testar Microfone" (gravar 3s e reproduzir/mostrar waveform)

**Arquivo**: `apps/gui/src/store/index.ts`

- Novo estado: `selectedMicDevice: string | null`
- Passar para o endpoint `/api/recording/start`

### 6. Server — Endpoint de gravação

**Arquivo**: `apps/gui/server.ts`

- `POST /api/recording/start`: Aceitar campo `micDevice` no body
- Passar para `capture.startCapture({ ..., micDevice })`

### 7. Config

**Arquivo**: `packages/core/src/config/schema.ts`

```typescript
audio: {
  device: "default.monitor",
  micDevice: null,         // NOVO: null = desabilitado
  micVolume: 1.0,          // NOVO
  chunkSeconds: 120,
  sampleRate: 16000,
  channels: 1,
}
```

---

## Plano de Execução

### Fase 1 — Listagem de microfones (Linux + Windows)

1. Alterar `AudioDevice` interface → adicionar `type`
2. `FFmpegPulseAdapter.listDevices()` → incluir sources (microfones)
3. `FFmpegWasapiAdapter.listDevices()` → incluir input devices
4. Server `/api/devices` → já retorna o resultado, sem mudança
5. UI → separar lista em "Dispositivo de Áudio" (monitor) e "Microfone" (input)
6. Persistir `micDevice` na config

### Fase 2 — Captura combinada (Linux)

1. Modificar `recordNextChunk()` para montar comando dual-input quando `micDevice` definido
2. Usar filtro: `[0:a]volume=${sysVol}[sys];[1:a]volume=${micVol}[mic];[sys][mic]amix=inputs=2:duration=longest,dynaudnorm`
3. Testar com gravação real — validar sincronização e qualidade
4. Ajustar volumes padrão se necessário

### Fase 3 — Captura combinada (Windows)

1. **Caminho ffmpeg (fallback dshow)**: Mesmo padrão do Linux, trivial
2. **Caminho nativo (wasapi-capture.exe)**:
   - Opção A: Capturar mic via ffmpeg em paralelo + merge pós-chunk
   - Opção B: Estender o binário Rust/C++ com `--mic <device>` (preferível, mas mais trabalho)
3. Decidir qual opção implementar baseado em complexidade

### Fase 4 — UX e polish

1. Indicador visual de que mic está ativo durante gravação
2. Ajuste de volume do microfone na UI (slider)
3. Opção de testar microfone (gravação curta com playback)
4. Tooltip explicando que mic captura a voz do usuário

---

## Considerações Técnicas

### Normalização de Volume

- Áudio do sistema costuma ser mais alto que microfone
- `dynaudnorm` do FFmpeg faz normalização dinâmica em tempo real
- Opcionalmente: slider de volume do mic na UI (default 1.2x boost)

### Latência/Sincronização

- FFmpeg alinha timestamps automaticamente quando abre ambos inputs simultaneamente
- No Linux, PulseAudio/PipeWire sincroniza os clocks das duas fontes
- Drift máximo esperado: <20ms (imperceptível para transcrição)

### Impacto na Transcrição

- Whisper lida bem com áudio mixado (vozes sobrepostas)
- A voz do microfone será a mais clara (proximidade), favorecendo transcrição da fala do usuário
- Se futuramente quiser diarização (quem falou): gravar stereo-split (Fase futura)

### Compatibilidade

- Se `micDevice` não for definido → comportamento atual preservado (só monitor)
- Zero breaking changes — feature opt-in

---

## Riscos

| Risco                                            | Mitigação                                                      |
| ------------------------------------------------ | -------------------------------------------------------------- |
| Microfone capta áudio do sistema (feedback loop) | `dynaudnorm` + possível filtro de cancelamento de eco (futuro) |
| FFmpeg falha com 2 inputs                        | Fallback: gravar só monitor, log de warning                    |
| wasapi-capture.exe não suporta mic               | Fase 3 usa ffmpeg paralelo como workaround                     |
| Mic sem permissão (Linux Flatpak/Snap)           | Detectar erro e mostrar mensagem orientando                    |

---

## Estimativa de Complexidade

| Fase   | Escopo          | Complexidade |
| ------ | --------------- | ------------ |
| Fase 1 | Listagem        | Baixa        |
| Fase 2 | Captura Linux   | Média-baixa  |
| Fase 3 | Captura Windows | Média        |
| Fase 4 | UX polish       | Baixa        |
