# web-speech-voice-assistant

[Live Demo](https://tarasglek.github.io/web-speech-voice-assistant/)

I got frustrated with how hard it was to set up a DIY voice assistant(eg equiv of Alexa or Google home). Eg one still needs to throw together a wake-word detection engine, VAD to detect silence, etc. For example I completely failed to setup the home assistance voice support.

There are a lot of SaaS services that offer a version of this, but that also seemed to hard.

# Simplest Possible Voice Assistant Implementation

Modern browsers offer web audio recording, speech to text and text to speech engines. Audio recording can be run concurrently with STT.
Here is my recipe:

1) Use STT + regexp to simulate a wake word and start recording

2) Once STT times out we stop recording and send audio as an attachment to an llm

3) Use TTS to read LLM response

This can run on Chrome, Safari, even mobile versions with no serverside.

## Configuration

To use the assistant, you need an [OpenRouter](https://openrouter.ai/) API key. You can provide it in two ways:
1. Enter it directly into the "API Key" input field on the web page.
2. Create a file named `public/api/llm-completion-config.json` (not committed) with the following structure:
   ```json
   {
     "api_key": "your-api-key-here"
   }
   ```
