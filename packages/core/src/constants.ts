/**
 * Product-wide defaults, in one place. Pure (no Node imports): also exported from the
 * browser-safe `@listening-resume/core/shared` entry.
 */

/** Pseudo device id that follows the OS default device, live (also mid-recording). */
export const SYSTEM_DEFAULT_DEVICE = "@default";

/** Mic gain in the capture mix (0..2). */
export const DEFAULT_MIC_VOLUME = 1.2;

/** Local Ollama endpoint used when neither config nor `OLLAMA_HOST` says otherwise. */
export const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";

/** Default (local, Ollama) analysis model. */
export const DEFAULT_ANALYSIS_MODEL = "llama3.1:8b";

/** Groq chat model used as the analysis fallback. */
export const DEFAULT_GROQ_LLM_MODEL = "llama-3.3-70b-versatile";

/** Groq Whisper transcription model. */
export const DEFAULT_GROQ_WHISPER_MODEL = "whisper-large-v3-turbo";

/** Output WAV format / chunking of a recording. */
export const DEFAULT_SAMPLE_RATE = 16000;
export const DEFAULT_CHANNELS = 1;
export const DEFAULT_CHUNK_SECONDS = 120;
