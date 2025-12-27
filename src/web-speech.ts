// deno-lint-ignore-file no-explicit-any
import * as emr from "extendable-media-recorder";
import * as wavEncoder from "extendable-media-recorder-wav-encoder";

export enum VoiceAssistantState {
  LISTENING_FOR_WAKE_WORD = "LISTENING_FOR_WAKE_WORD",
  ACTIVATING = "ACTIVATING",
  RECORDING_USER_SPEECH = "RECORDING_USER_SPEECH",
  PROCESSING_USER_SPEECH = "PROCESSING_USER_SPEECH",
  MUTED = "MUTED",
  SPEAKING = "SPEAKING",
}

export interface StateChangeEvent {
  type: "statechange";
  state: VoiceAssistantState;
  timestamp: number;
}
export interface TranscriptEvent {
  type: "transcript";
  transcript: string;
  isFinal: boolean;
  timestamp: number;
}
export interface CommandEvent {
  type: "command";
  audioUrl: string | null;
  extension: string | undefined;
  timestamp: number;
}
export interface SpeakStartEvent {
  type: "speakstart";
  text: string;
  timestamp: number;
}
export interface SpeakEndEvent {
  type: "speakend";
  timestamp: number;
}
export interface ErrorEvent {
  type: "error";
  message: string;
  error?: Error;
  timestamp: number;
}
export type VoiceAssistantEvent =
  | StateChangeEvent
  | TranscriptEvent
  | CommandEvent
  | SpeakStartEvent
  | SpeakEndEvent
  | ErrorEvent;

export type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K>
  : never;

export class AudioRecorder {
  mediaRecorder: emr.IMediaRecorder;
  audioChunks: Blob[];

  constructor(mediaRecorder: emr.IMediaRecorder, audioChunks: Blob[]) {
    this.mediaRecorder = mediaRecorder;
    this.audioChunks = audioChunks;
  }

  static async start(
    log: (msg: string) => void,
    logError: (msg: string) => void,
  ): Promise<AudioRecorder> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const mediaRecorder = new emr.MediaRecorder(stream, {
        mimeType: "audio/wav",
      });
      log(`Using mimeType: ${mediaRecorder.mimeType}`);
      const audioChunks: Blob[] = [];

      mediaRecorder.ondataavailable = (event) => {
        audioChunks.push(event.data);
      };

      mediaRecorder.start();

      return new AudioRecorder(mediaRecorder, audioChunks);
    } catch (err) {
      logError(`Could not start audio recording: ${err}`);
      throw new Error("Could not get user media: " + err);
    }
  }

  stop(logError: (msg: string) => void): Promise<{ audioUrl: string; extension: string } | null> {
    return new Promise((resolve, reject) => {
      this.mediaRecorder.onstop = () => {
        if (this.audioChunks.length === 0) {
          logError("No audio chunks recorded. Cannot create audio blob.");
          resolve(null);
          return;
        }
        try {
          const mimeType = this.mediaRecorder.mimeType;
          const audioBlob = new Blob(this.audioChunks, { type: mimeType });
          const audioUrl = URL.createObjectURL(audioBlob);
          const extension = (mimeType.split(";")[0].split("/")[1]) || "bin";
          resolve({ audioUrl, extension });
        } catch (error) {
          logError(`Error processing audio: ${error}`);
          reject("Failed to process recorded audio.");
        }
      };

      this.mediaRecorder.stop();
    });
  }
}

export class VoiceClient {
  #state: VoiceAssistantState;
  #wakePhraseRegex: RegExp;
  #recognition: any;
  #audioRecorder: AudioRecorder | undefined;
  #endOfSpeechTimeout: any | undefined;
  #noSpeechAfterWakeWordTimeout: any | undefined;
  #finalTranscriptSinceRecording: string;
  #utterance: SpeechSynthesisUtterance;
  #log: (msg: string) => void;
  #logError: (msg: string) => void;

  #eventQueue: VoiceAssistantEvent[] = [];
  #eventResolver: ((value?: void) => void) | null = null;

  constructor(
    wakePhraseRegex: RegExp,
    SpeechRecognition: any,
    initialState: VoiceAssistantState,
    log: (msg: string) => void,
    logError: (msg: string) => void,
  ) {
    this.#wakePhraseRegex = wakePhraseRegex;
    this.#state = initialState;
    this.#finalTranscriptSinceRecording = "";
    this.#utterance = new SpeechSynthesisUtterance();
    this.#audioRecorder = undefined;
    this.#endOfSpeechTimeout = undefined;
    this.#noSpeechAfterWakeWordTimeout = undefined;
    this.#log = log;
    this.#logError = logError;

    this.#recognition = new SpeechRecognition();
    this.#recognition.continuous = true;
    this.#recognition.interimResults = true;

    this.#recognition.onresult = this.#onResult.bind(this);
    this.#recognition.onerror = this.#onError.bind(this);
    this.#recognition.onspeechend = this.#onSpeechEnd.bind(this);
    this.#recognition.onspeechstart = this.#onSpeechStart.bind(this);
    this.#recognition.onend = this.#onEnd.bind(this);
  }

  get isMuted(): boolean {
    return this.state === VoiceAssistantState.MUTED;
  }

  toggleMute() {
    if (this.state === VoiceAssistantState.MUTED) {
      this.state = VoiceAssistantState.LISTENING_FOR_WAKE_WORD;
      this.#log(`Unmuted.`);
      this.#recognition.start();
    } else {
      this.#log(`Muting.`);
      this.#recognition.stop();
      globalThis.speechSynthesis.cancel();
      if (
        this.state === VoiceAssistantState.RECORDING_USER_SPEECH ||
        this.state === VoiceAssistantState.ACTIVATING
      ) {
        this.#audioRecorder?.stop(this.#logError).then((result) => {
          if (result?.audioUrl) URL.revokeObjectURL(result.audioUrl);
        });
        this.#audioRecorder = undefined;
        clearTimeout(this.#endOfSpeechTimeout);
        this.#endOfSpeechTimeout = undefined;
        clearTimeout(this.#noSpeechAfterWakeWordTimeout);
        this.#noSpeechAfterWakeWordTimeout = undefined;
      }
      this.state = VoiceAssistantState.MUTED;
    }
  }

  #emit(event: DistributiveOmit<VoiceAssistantEvent, "timestamp">) {
    this.#eventQueue.push(
      { ...event, timestamp: Date.now() } as VoiceAssistantEvent,
    );
    if (this.#eventResolver) {
      this.#eventResolver();
      this.#eventResolver = null;
    }
  }

  async *events(): AsyncGenerator<VoiceAssistantEvent> {
    this.#emit({
      type: "statechange",
      state: this.#state,
    });

    while (true) {
      while (this.#eventQueue.length > 0) {
        const event = this.#eventQueue.shift();
        if (event) yield event;
      }
      await new Promise<void>((resolve) => {
        this.#eventResolver = resolve;
      });
    }
  }

  get state(): VoiceAssistantState {
    return this.#state;
  }

  set state(newState: VoiceAssistantState) {
    if (this.#state === newState) return;
    this.#state = newState;
    this.#emit({ type: "statechange", state: this.#state });
  }

  static async init(
    {
      wakePhraseRegex = /(?:ok|okay)[^a-z]+metallica/i,
      initialState = VoiceAssistantState.LISTENING_FOR_WAKE_WORD,
      log = console.log,
      logError = console.error,
    }: {
      wakePhraseRegex?: RegExp;
      initialState?: VoiceAssistantState;
      log?: (msg: string) => void;
      logError?: (msg: string) => void;
    } = {},
  ): Promise<VoiceClient> {
    await emr.register(await wavEncoder.connect());
    const SpeechRecognition = (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    const missingFeatures = [];
    if (!SpeechRecognition) {
      missingFeatures.push(
        "SpeechRecognition (window.SpeechRecognition or window.webkitSpeechRecognition)",
      );
    }
    if (!("MediaRecorder" in window)) {
      missingFeatures.push("MediaRecorder");
    }
    if (!("speechSynthesis" in window)) {
      missingFeatures.push("SpeechSynthesis");
    }

    if (missingFeatures.length > 0) {
      throw new Error(
        `The following features are not supported in this browser: ${
          missingFeatures.join(", ")
        }.`,
      );
    }
    const assistant = new VoiceClient(
      wakePhraseRegex,
      SpeechRecognition,
      initialState,
      log,
      logError,
    );
    assistant.#recognition.start();
    return assistant;
  }

  speak(text: string): Promise<void> {
    if (this.state === VoiceAssistantState.MUTED) return Promise.resolve();

    this.state = VoiceAssistantState.SPEAKING;
    this.#recognition.stop();

    this.#emit({ type: "speakstart", text });
    return new Promise<void>((resolve, reject) => {
      this.#utterance.text = text;
      this.#utterance.onend = () => {
        this.#emit({ type: "speakend" });
        if (this.state !== VoiceAssistantState.MUTED) {
          this.state = VoiceAssistantState.LISTENING_FOR_WAKE_WORD;
        }
        this.#recognition.start();
        resolve();
      };
      this.#utterance.onerror = (event) => {
        this.#emit({
          type: "error",
          message: `TTS Error: ${event.error}`,
          error: new Error(`TTS Error: ${event.error}`, { cause: event }),
        });
        if (this.state !== VoiceAssistantState.MUTED) {
          this.state = VoiceAssistantState.LISTENING_FOR_WAKE_WORD;
        }
        this.#recognition.start();
        reject(event.error);
      };
      window.speechSynthesis.speak(this.#utterance);
    });
  }

  async #activate(): Promise<void> {
    if (this.state !== VoiceAssistantState.LISTENING_FOR_WAKE_WORD) return;

    this.state = VoiceAssistantState.ACTIVATING;

    this.#finalTranscriptSinceRecording = "";
    this.#audioRecorder = await AudioRecorder.start(this.#log, this.#logError);
    this.state = VoiceAssistantState.RECORDING_USER_SPEECH;

    this.#noSpeechAfterWakeWordTimeout = setTimeout(() => {
      this.#log("No speech detected for 15s, cancelling recording.");
      this.#stopRecording();
    }, 15000);
  }

  async #stopRecording(): Promise<void> {
    if (this.state !== VoiceAssistantState.RECORDING_USER_SPEECH) return;

    this.state = VoiceAssistantState.PROCESSING_USER_SPEECH;

    clearTimeout(this.#endOfSpeechTimeout);
    this.#endOfSpeechTimeout = undefined;
    clearTimeout(this.#noSpeechAfterWakeWordTimeout);
    this.#noSpeechAfterWakeWordTimeout = undefined;

    const result = await this.#audioRecorder!.stop(this.#logError);
    this.#audioRecorder = undefined;

    this.#emit({
      type: "command",
      audioUrl: result?.audioUrl ?? null,
      extension: result?.extension,
    });
  }

  async #onResult(event: any): Promise<void> {
    if (this.state === VoiceAssistantState.MUTED) return;
    let interimTranscript = "";
    let newlyFinalizedTranscript = "";
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        newlyFinalizedTranscript += event.results[i][0].transcript;
      } else {
        interimTranscript += event.results[i][0].transcript;
      }
    }

    if (interimTranscript) {
      this.#emit({
        type: "transcript",
        transcript: interimTranscript,
        isFinal: false,
      });
    }
    if (newlyFinalizedTranscript) {
      this.#emit({
        type: "transcript",
        transcript: newlyFinalizedTranscript,
        isFinal: true,
      });
    }

    if (this.state === VoiceAssistantState.LISTENING_FOR_WAKE_WORD) {
      if (
        this.#wakePhraseRegex.test(interimTranscript + newlyFinalizedTranscript)
      ) {
        await this.#activate();
      }
    } else if (this.state === VoiceAssistantState.RECORDING_USER_SPEECH) {
      this.#finalTranscriptSinceRecording += newlyFinalizedTranscript;

      const hasSpeech =
        this.#finalTranscriptSinceRecording.length + interimTranscript.length >
          0;
      const timeout = hasSpeech ? 1700 : 5000;

      clearTimeout(this.#endOfSpeechTimeout);
      this.#endOfSpeechTimeout = setTimeout(
        () => this.#stopRecording(),
        timeout,
      );
    }
  }

  #onError(event: any): void {
    if (event.error === "aborted") {
      this.#log("Recognition aborted. Ignoring.");
      return;
    }
    if (event.error === "no-speech") {
      this.#log("Recognition: no-speech error.");
      this.#stopRecording();
      return;
    }

    this.#emit({
      type: "error",
      message: `Recognition Error: '${event.error}'`,
      error: new Error(`Recognition Error: '${event.error}'`, {
        cause: event,
      }),
    });
    this.#log(`Error occurred in recognition: ${event.error}`);

    if (this.state === VoiceAssistantState.RECORDING_USER_SPEECH) {
      this.#stopRecording();
    }
  }

  #onSpeechEnd() {}

  #onSpeechStart() {
    if (
      this.state === VoiceAssistantState.RECORDING_USER_SPEECH &&
      this.#noSpeechAfterWakeWordTimeout
    ) {
      clearTimeout(this.#noSpeechAfterWakeWordTimeout);
      this.#noSpeechAfterWakeWordTimeout = undefined;
    }
  }

  #onEnd() {
    if (
      this.state === VoiceAssistantState.SPEAKING ||
      this.state === VoiceAssistantState.MUTED
    ) return;
    this.#recognition.start();
  }
}
