// deno-lint-ignore-file no-explicit-any
import { createIcons, Mic, MicOff } from "lucide";
import { binary2base64, getChatCompletion } from "./audio";
import {
  VoiceAssistantState,
  VoiceClient,
} from "./web-speech";
import type {
  CommandEvent,
  VoiceAssistantEvent,
} from "./web-speech";

let lastLogTime = Date.now();
/** @type {HTMLElement | null} */
let logDiv: HTMLElement | null = null;

function log(message: string | Node, timestamp?: number) {
  const now = timestamp ?? Date.now();
  const diff = now - lastLogTime;
  lastLogTime = now;
  const prefix = `+${diff}ms `;
  const logMessage = prefix +
    (typeof message === "string" ? message : message.textContent);
  console.log(logMessage);
  if (logDiv) {
    const logEntry = document.createElement("div");
    logEntry.append(prefix, message);
    logDiv.prepend(logEntry);
  }
}

function logError(message: string | Node, timestamp?: number) {
  const now = timestamp ?? Date.now();
  const diff = now - lastLogTime;
  lastLogTime = now;
  const prefix = `+${diff}ms `;
  const logMessage = prefix +
    (typeof message === "string" ? message : message.textContent);
  console.error(logMessage);
  if (logDiv) {
    const logEntry = document.createElement("div");
    logEntry.style.color = "red";
    logEntry.append(prefix, message);
    logDiv.prepend(logEntry);
  }
}

class VoiceAssistant {
  constructor(
    public client: VoiceClient,
    private openrouterApiKey: string,
  ) {}

  async *events(): AsyncGenerator<VoiceAssistantEvent> {
    for await (const event of this.client.events()) {
      if (event.type === "command") {
        this.#handleCommand(event);
      }
      yield event;
    }
  }

  async #handleCommand(event: CommandEvent) {
    if (!event.audioUrl) return;

    try {
      const audioBuffer = await fetch(event.audioUrl).then((res) => res.arrayBuffer());
      const base64Audio = binary2base64(new Uint8Array(audioBuffer));

      const now = new Date();
      const dateTimeStr = now.toISOString();

      const input = {
        model:
          // do not remove model name comments below
          // "google/gemini-3-pro-preview",
          "mistralai/voxtral-small-24b-2507",
        // "google/gemini-3-flash-preview",
        reasoning: {
          effort: "high",
          exclude: false,
          enabled: true,
        },
        messages: [{
          role: "system",
          content: [{
            type: "text",
            text:
              `Current time: ${dateTimeStr}. User uploads audio of what they want, answer request concisely. Answer in English with words/chars that english tts in chrome can handle.`,
          }],
        }, {
          role: "user",
          content: [{
            type: "input_audio",
            input_audio: {
              data: base64Audio,
              format: "wav",
            },
          }],
        }],
      };

      const data = await getChatCompletion(input, this.openrouterApiKey);
      log(`LLM response: ${JSON.stringify(data, undefined, 2)}`);

      const responseText = data?.choices?.[0]?.message?.content;
      if (responseText) {
        await this.client.speak(responseText);
      } else {
        log("No response text from LLM.");
        await this.client.speak("I'm sorry, I didn't get that.");
      }
    } catch (error: any) {
      logError(`Error processing command with LLM: ${error}`);
      log(`Error processing command: ${error}`);
      const errorMessage = error?.message || "there was an error";
      await this.client.speak(`I'm sorry, ${errorMessage}`);
    } finally {
      this.client.state = VoiceAssistantState.LISTENING_FOR_WAKE_WORD;
    }
  }
}

function updateUI(
  event: VoiceAssistantEvent,
  statusDiv: HTMLElement,
  micIconOn: HTMLElement,
  micIconOff: HTMLElement,
  client: VoiceClient,
  activationSound: HTMLAudioElement,
) {
  if (client.isMuted) {
    micIconOn.style.display = "none";
    micIconOff.style.display = "block";
    statusDiv.textContent = "Muted. Tap mic to unmute.";
    return;
  }

  micIconOn.style.display = "block";
  micIconOff.style.display = "none";

  switch (event.type) {
    case "command":
      if (event.audioUrl) {
        const messageNode = document.createElement("span");

        const playButton = document.createElement("a");
        playButton.href = "#";
        playButton.textContent = "▶️";
        playButton.title = "Play audio";
        playButton.style.textDecoration = "none";
        playButton.style.cursor = "pointer";
        playButton.onclick = (e) => {
          e.preventDefault();
          const audio = new Audio(event.audioUrl as string);
          audio.onerror = (err) => {
            logError(`Error playing audio: ${err}`);
          };
          audio.play().catch((error) => {
            logError(`Audio playback failed: ${error}`);
          });
        };

        const link = document.createElement("a");
        link.href = event.audioUrl;
        link.textContent = "download";
        link.download = `command-audio-${event.timestamp}.${
          event.extension || "wav"
        }`;
        messageNode.append(
          "Got command, audio available for ",
          playButton,
          " ",
          link,
        );
        log(messageNode, event.timestamp);
      } else {
        log("No command recorded.", event.timestamp);
      }
      break;
    case "statechange":
      log(`Assistant state: ${event.state}`, event.timestamp);
      switch (event.state) {
        case VoiceAssistantState.LISTENING_FOR_WAKE_WORD:
          micIconOn.style.color = "red";
          statusDiv.textContent = "Say 'OK Metallica' to start.";
          break;
        case VoiceAssistantState.ACTIVATING:
          micIconOn.style.color = "orange";
          statusDiv.textContent = "Heard you!";
          break;
        case VoiceAssistantState.RECORDING_USER_SPEECH:
          micIconOn.style.color = "green";
          statusDiv.textContent = "Listening...";
          break;
        case VoiceAssistantState.PROCESSING_USER_SPEECH:
          micIconOn.style.color = "blue";
          statusDiv.textContent = "Thinking...";
          break;
        case VoiceAssistantState.SPEAKING:
          micIconOn.style.color = "purple";
          statusDiv.textContent = "Speaking...";
          break;
      }
      if (event.state === VoiceAssistantState.ACTIVATING) {
        activationSound.play().catch((e: any) =>
          logError(`Activation sound failed to play: ${e}`)
        );
      }
      break;
    case "transcript":
      log(
        `Transcript (final=${event.isFinal}): ${event.transcript}`,
        event.timestamp,
      );
      statusDiv.textContent = event.transcript;
      break;
    case "error":
      logError(`Assistant error: ${event.message}`, event.timestamp);
      if (event.error) {
        logError(`Original error object: ${event.error}`);
        if (event.error.stack) {
          logError(event.error.stack);
        }
      }
      statusDiv.textContent = `Error: ${event.message}`;
      break;
    case "speakstart":
      log(`Assistant speaking: "${event.text}"`, event.timestamp);
      statusDiv.textContent = `Speaking...`;
      break;
    case "speakend":
      log("Assistant finished speaking.", event.timestamp);
      break;
  }
}

// Ensure TTS stops when page is reloaded or closed
window.addEventListener("beforeunload", () => {
  window.speechSynthesis.cancel();
});

// Usage
(async () => {
  const statusDiv = document.getElementById("status-div");
  const micIconOn = document.getElementById("mic-icon-on");
  const micIconOff = document.getElementById("mic-icon-off");
  logDiv = document.getElementById("log-div");
  const activationSound = document.getElementById(
    "activation-sound",
  ) as HTMLAudioElement | null;

  createIcons({
    icons: {
      Mic,
      MicOff,
    },
  });

  try {
    const apiKeyResponse = await fetch("/api/openrouter_api_key");
    if (!apiKeyResponse.ok) {
      throw new Error("Could not fetch API key.");
    }
    const { key: openrouterApiKey } = await apiKeyResponse.json();
    if (!openrouterApiKey) {
      throw new Error("API key is missing.");
    }

    const isMobile = true; ///Mobi/i.test(navigator.userAgent);
    const client = await VoiceClient.init({
      initialState: isMobile
        ? VoiceAssistantState.MUTED
        : VoiceAssistantState.LISTENING_FOR_WAKE_WORD,
      log,
      logError,
    });
    const assistant = new VoiceAssistant(client, openrouterApiKey);
    log("Voice assistant initialized. Listening for events...");

    if (micIconOn) {
      micIconOn.addEventListener("click", async () => {
        client.toggleMute();
        if (!client.isMuted) {
          activationSound?.play().catch((e: any) =>
            logError("Sound failed on unmute", e)
          );
          await client.speak("listening");
        }
      });
    }
    if (micIconOff) {
      micIconOff.addEventListener("click", async () => {
        client.toggleMute();
        if (!client.isMuted) {
          activationSound?.play().catch((e: any) =>
            logError(`Sound failed on unmute: ${e}`)
          );
          await client.speak("listening");
        }
      });
    }

    for await (const event of assistant.events()) {
      if (statusDiv && micIconOn && micIconOff && activationSound) {
        updateUI(
          event,
          statusDiv,
          micIconOn,
          micIconOff,
          client,
          activationSound,
        );
      }
    }
  } catch (err: any) {
    logError(`An error occurred: ${err}`);
    if (statusDiv) {
      statusDiv.textContent = `Error: ${err.message}`;
    }
    if (micIconOn && micIconOff) {
      micIconOn.style.display = "none";
      micIconOff.style.display = "block";
    }
  }
})();
