// Minimal Web Speech API `SpeechRecognition` ambient types. The interface is
// absent from the TS DOM lib (only SpeechRecognitionEvent /
// SpeechRecognitionErrorEvent are present), so the chat talkback path can't
// name it. Only the members the talkback code uses are declared.
interface SpeechRecognition extends EventTarget {
	continuous: boolean;
	interimResults: boolean;
	lang: string;
	maxAlternatives: number;
	onresult: ((event: SpeechRecognitionEvent) => void) | null;
	onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
	onend: (() => void) | null;
	start(): void;
	stop(): void;
	abort(): void;
}
