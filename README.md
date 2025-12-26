# Simplest Possible Voice Assistant Implementation

I got frustrated with how hard it was to set up a DIY voice assistant (e.g., the equivalent of Alexa or Google Home). You still need to throw together wake-word detection, VAD to detect silence, etc. For example, I completely failed to set up Home Assistant voice support.

There are a lot of SaaS services that offer a version of this, but that also seemed too hard. Modern browsers offer web audio recording, speech-to-text, and text-to-speech engines. Audio recording can run concurrently with STT.

Here is my recipe:

1. Use STT + a regex to simulate a wake word and start recording.
2. Once STT times out, stop recording and send the audio as an attachment to an LLM.
3. Use TTS to read the LLM response aloud.

This can run on Chrome, Safari, and even mobile browsers with no server-side components. [Live Demo](https://tarasglek.github.io/web-speech-voice-assistant/)

## Configuration

To use the assistant, you need an [OpenRouter](https://openrouter.ai/) API key. You can provide it in two ways:

1. Enter it directly into the "API Key" input field on the web page.
2. If you deploy this demo behind a secure endpoint, you can serve a configuration file from an authenticated endpoint at `/api/llm-completion-config.json` with the following structure:
   ```json
   {
     "api_key": "your-api-key-here"
   }
   ```
