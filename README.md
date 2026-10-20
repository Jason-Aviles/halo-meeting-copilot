# Halo

A live meeting copilot for Windows. It transcribes both sides of a call and suggests what to say next with Claude or ChatGPT.

- **Them**: everything playing through your speakers, captured with Windows loopback audio
- **You**: your microphone
- **Speech-to-text**: Deepgram or Speechmatics, switchable in Settings
- **Answers**: Claude (Opus, Sonnet, Haiku 5.5), ChatGPT (GPT-5.5, GPT-5.4 mini), or a **local model** through LM Studio, Ollama or any OpenAI-compatible server, streamed into an always-on-top overlay
- **Modes**: Interview (answers questions put to you) or Meeting (helps you contribute)
- **Minutes**: structured meeting minutes (summary, discussion, decisions, an action-items table, open questions) with templates for client meetings, kickoffs, board meetings and brainstorms. In Interview mode you get a private debrief instead. Copy them as Markdown to paste into email, Slack or a doc
- **References**: attach files, a folder or local repo, a public GitHub repo, or your Jira tickets, then tick the ones a call needs; answers and minutes draw on them
- **Auto-answer**: spots questions even when speech-to-text drops the question mark ("Tell me about a time…", "Walk me through…") and waits until they've finished speaking
- **Echo cancellation**: a native Rust add-on (WebRTC AEC3 via [sonora](https://github.com/dignifiedquire/sonora)) removes speaker audio from your mic, so speakers work as well as headphones
- **Meeting detection**: the status bar shows which app (Zoom, Teams, a browser…) is using your mic

Everything runs locally with your own API keys. Keys are encrypted with Windows secure storage (DPAPI) and only the main process can read them.

## Install

Download `Halo-Setup-<version>.exe` and run it. Halo installs for your user only (no admin needed), and you can pick the folder. The installer isn't code-signed yet, so Windows SmartScreen may warn: choose **More info**, then **Run anyway**.

## Build the installer

```powershell
npm install
npm run build:native   # the echo-cancellation add-on; needs Rust and the VS C++ build tools
npm run dist           # writes release\Halo-Setup-<version>.exe
```

## Run from source

```powershell
npm install
npm run build:native   # needs Rust (rustup) and the Visual Studio C++ build tools
npm start
```

Without the native add-on Halo still runs, but echo cancellation and meeting detection are off, so use headphones.

On first launch, Settings opens. Add a Deepgram or Speechmatics key on the **Speech** tab and an Anthropic key on the **AI** tab, and paste any background notes (resume, role, agenda) on the **Context** tab.

### Local AI (LM Studio or Ollama)

1. In LM Studio, load a model, open the **Developer** tab and start the server (it listens on `http://localhost:1234/v1`). For Ollama, use `http://localhost:11434/v1`.
2. In Halo, go to **Settings → AI**, pick **Local AI**, press **Find models** and choose one.
3. Set the model's context length to 16K or more. Halo sends local models a smaller slice of the transcript and references so they fit.

No API key is needed, and nothing leaves your computer except speech-to-text audio.

### References

On **Settings → Context**, add:

- **Files**: text, Markdown or code files (save PDFs and Word files as .txt or .md first)
- **Folder**: a folder or local repo. READMEs and docs are read first, then code; `node_modules`, `.git` and build output are skipped
- **GitHub**: a public repo link, or `github.com/owner/repo/tree/main/docs` for one folder
- **Jira**: your Jira Cloud site, email and an [API token](https://id.atlassian.com/manage-profile/security/api-tokens). By default it pulls the tickets assigned to you that aren't done; change the JQL for anything else

References are saved on this computer. Use the paperclip chip above the answer to switch them on or off for each call, and the refresh button to pull the latest. Ticked references, about 200K characters at most, go to your AI model with each answer; Claude caches them, so repeat answers stay fast and cheap.

## Use

| Action | How |
| --- | --- |
| Start or stop transcribing | **Start listening** button |
| Suggest an answer to the last question | **Answer** button or `Ctrl+Shift+Enter` (works from any app) |
| Ask something specific | Type in the box, then **Answer** |
| Write meeting minutes | **Minutes**. Type in the box first to steer them, e.g. "focus on the budget" |
| Copy an answer or the minutes as Markdown | **Copy** |
| Choose which references answers use | Paperclip chip above the answer |
| Switch the AI model | Model chip above the answer |
| Show or hide the overlay | `Ctrl+Shift+Space` |
| Keep the overlay out of your own screen shares | **Hide from capture** |

## Layout

```
src/main/        Electron main process: window, IPC, settings, STT sockets, references
  ai/            Claude, OpenAI and local-model clients, and the prompts
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
