# Halo

A live meeting copilot for Windows. It transcribes both sides of a call and suggests what to say next with Claude or ChatGPT.

- **Them**: everything playing through your speakers, captured with Windows loopback audio
- **You**: your microphone
- **Speech-to-text**: Deepgram or Speechmatics, switchable in Settings
- **Answers**: Claude (Opus, Sonnet, Haiku 5.5) or ChatGPT (GPT-5.5, GPT-5.4 mini), streamed into an always-on-top overlay
- **Modes**: Interview (answers questions put to you) or Meeting (helps you contribute), plus **Summarize** for notes, decisions and action items
- **Echo cancellation**: a native Rust add-on (WebRTC AEC3 via [sonora](https://github.com/dignifiedquire/sonora)) removes speaker audio from your mic, so speakers work as well as headphones
- **Meeting detection**: the status bar shows which app (Zoom, Teams, a browser…) is using your mic

Everything runs locally with your own API keys. Keys are encrypted with Windows secure storage (DPAPI) and only the main process can read them.

## Run

```powershell
npm install
npm run build:native   # needs Rust (rustup) and the Visual Studio C++ build tools
npm start
```

Without the native add-on Halo still runs, but echo cancellation and meeting detection are off, so use headphones.

On first launch, Settings opens. Add a Deepgram or Speechmatics key and an Anthropic key, and paste any background notes (resume, role, agenda) you want answers to draw on.

## Use

| Action | How |
| --- | --- |
| Start or stop transcribing | **Start listening** button |
| Suggest an answer to the last question | **Answer** button or `Ctrl+Shift+Enter` (works from any app) |
| Ask something specific | Type in the box, then **Answer** |
| Get notes, decisions and action items | **Summarize** |
| Show or hide the overlay | `Ctrl+Shift+Space` |
| Keep the overlay out of your own screen shares | **Hide from capture** |

## Layout

```
src/main/        Electron main process: window, IPC, settings, Claude, STT sockets
  stt/           Deepgram and Speechmatics streaming clients
src/preload/     The `window.halo` bridge (the only API the page can call)
src/renderer/    UI, audio capture, and the PCM16 AudioWorklet
src/shared/      Types shared across processes
native/          Rust add-on (napi-rs): echo canceller and mic-session listing
```

## Third-party notices

The native add-on uses [sonora](https://crates.io/crates/sonora) (BSD-3-Clause), a Rust port of WebRTC audio processing. Its license is in `native/THIRD_PARTY_LICENSES`.

`npm run typecheck` runs TypeScript; `npm run build` bundles into `dist/` with esbuild.

## License

MIT. See `LICENSE`.
