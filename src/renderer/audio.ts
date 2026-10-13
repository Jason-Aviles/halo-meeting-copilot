import type { Speaker } from "../shared/types";

const SAMPLE_RATE = 16_000;

/**
 * Captures the microphone ("you") and system audio ("them") as two separate
 * 16 kHz PCM16 streams. System audio comes from getDisplayMedia, which the main
 * process answers with WASAPI loopback (Windows) instead of showing a picker.
 */
export class AudioCapture {
  private ctx?: AudioContext;
  private streams: MediaStream[] = [];

  /**
   * @param nativeEchoCancellation when true, the main process removes speaker
   *   echo using the system audio as reference, so the browser's own echo
   *   canceller (which can't see that reference) is turned off, along with its
   *   noise suppression and gain control, which the add-on applies after echo removal.
   */
  async start(
    onChunk: (speaker: Speaker, pcm16: ArrayBuffer) => void,
    nativeEchoCancellation: boolean,
  ): Promise<void> {
    try {
      this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      await this.ctx.audioWorklet.addModule("./pcm-worklet.js");

      const mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: !nativeEchoCancellation,
          noiseSuppression: !nativeEchoCancellation,
          autoGainControl: !nativeEchoCancellation,
        },
      });
      this.streams.push(mic);

      // Keep system audio unprocessed: Chrome otherwise applies echo cancellation,
      // noise suppression and gain control to it, which distorts both the "Them"
      // transcript and the reference signal the echo canceller compares against.
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      this.streams.push(display);
      // Video is required by the API but unused; keep the track alive (stopping it
      // can end the loopback audio too) and just disable it.
      for (const track of display.getVideoTracks()) track.enabled = false;
      const systemAudio = display.getAudioTracks();
      if (systemAudio.length === 0) {
        throw new Error("System audio capture isn't available on this computer.");
      }

      this.attach(mic, "you", onChunk);
      this.attach(new MediaStream(systemAudio), "them", onChunk);
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  private attach(
    stream: MediaStream,
    speaker: Speaker,
    onChunk: (speaker: Speaker, pcm16: ArrayBuffer) => void,
  ): void {
    const ctx = this.ctx!;
    const source = ctx.createMediaStreamSource(stream);
    // No outputs: the node is a sink, so nothing is played back.
    const writer = new AudioWorkletNode(ctx, "pcm16-writer", { numberOfOutputs: 0 });
    writer.port.onmessage = (event: MessageEvent<ArrayBuffer>) => onChunk(speaker, event.data);
    source.connect(writer);
  }

  stop(): void {
    for (const stream of this.streams) {
      for (const track of stream.getTracks()) track.stop();
    }
    this.streams = [];
    void this.ctx?.close();
    this.ctx = undefined;
  }
}
