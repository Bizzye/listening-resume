export interface AudioDevice {
	id: string;
	name: string;
	isMonitor: boolean;
	isDefault: boolean;
	type: "monitor" | "microphone";
}

export interface CaptureOptions {
	device: string;
	micDevice?: string;
	micVolume?: number; // 0.0–2.0, default 1.0
	sampleRate: number;
	channels: number;
	chunkSeconds: number;
	outputDir: string;
	filenamePrefix: string;
}

export interface ChunkInfo {
	path: string;
	index: number;
}

export interface AudioCapturePort {
	listDevices(): Promise<AudioDevice[]>;
	startCapture(options: CaptureOptions): Promise<void>;
	stopCapture(): Promise<ChunkInfo[]>;
	onChunkReady(callback: (info: ChunkInfo) => void): void;
}
