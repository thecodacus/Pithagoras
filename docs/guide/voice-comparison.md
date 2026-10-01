# Voice pipeline comparison demo

The main portal on port 4100 retains the optimized parallel pipeline. The comparison portal on port 4101 runs with `VOICE_PIPELINE_MODE=sequential` and displays “Sequential baseline” beside the voice session title.

The sequential path waits for speech to finish before requesting transcription, waits for the whole agent turn before submitting reply text to TTS, buffers every generated speech chunk completely, and only then starts playback. It suppresses thinking/compaction filler speech so it cannot overlap the measured work. Long replies still use the API's bounded text chunks, but all chunks finish synthesis before playback begins. Cancellation and mute still work. The default parallel path is unchanged.

## Recording the comparison

Use the same prompt, Qwen model, speaking voice, guidance mode, VAD settings and starting context. Record one instance at a time because both share llama-server and the managed Whisper/Breeze services. End voice mode on the other instance before switching. Record a warm-up separately from measured turns, enable the timing profiler, and export the report after each take. Label the metric as last detected speech to estimated first reply audio. Browser output timing is a software estimate, not an acoustic measurement.

This is a pipeline baseline on the current model/runtime, not a reconstruction of the original slow Python TTS stack. The comparison sets `VOICE_SKIP_FIRST_THINKING=false`: voice requests preserve the model's normal thinking behavior, including the first response. Quantization, streaming lookahead and GPU configuration are retained. The test instance also sets `VOICE_RESPONSE_INSTRUCTIONS=false`, omitting all voice-specific system rules and the `[Audio mode]` input marker. Replies are not forced to be brief, plain text, or canvas-first. Use a new session for a clean recording; prior conversations can still influence the model. Add optimizations individually only when requested. Subsequent optimization variants should change one stage at a time: speculative STT, incremental LLM-to-TTS submission, then streaming playback/prefetch. The first intermediate variant is now available with `VOICE_SENTENCE_CHUNKS=true`: text sentences are submitted during LLM generation, each complete sentence audio plays before the next sentence is synthesized. Audio is fully buffered per sentence; speculative STT and audio streaming playback remain off. Set the flag to false to restore the full-turn baseline.

## Isolation and access

Comparison source: `/opt/pithagoras-sequential`; image/container: `pithagoras-sequential`; data volume: `pithagoras-sequential-data`; workspaces: `/root/pithagoras-sequential-workspaces`. No primary sessions, channels, routines or API credentials were copied. The demo has a new password saved at `/opt/pithagoras-sequential/demo-password.txt`, a separate cookie, the local keyless Qwen connection and the saved speaking voice and settings. It has no Docker control socket. Main instance remains independently deployed.

## Temporary experiment and rollback

These are temporary comparison changes. Main production is still the code from `3e3c111` on port 4100. Baseline code is recorded through `274a9b5`; all comparison behavior is opt-in through the demo environment. Do not deploy demo configuration to the main portal.

Pinned images on Cortex:

- `pithagoras-portal:before-sequential-demo-20260913`: `sha256:026db1c94edf0c69d2e0ff3c25f5556015370bcff059d3a226158d0b0701f9dd`
- `pithagoras-sequential:baseline-20260913`: `sha256:372128da898a5638474b45209ba1dca2b823c52d5987ad5cd8603116f436093c`

To end the experiment without deleting recordings or sessions, run on Cortex:

```sh
docker update --restart=no pithagoras-sequential
docker stop pithagoras-sequential
```

The main instance and shared LLM/voice services need no rollback. Leave the demo data volume and workspaces intact. `docker start pithagoras-sequential` resumes the saved baseline later.

To turn all application-level voice optimizations back on in a future comparison stage, recreate only the demo container with `VOICE_PIPELINE_MODE=parallel`, `VOICE_SKIP_FIRST_THINKING=true`, and `VOICE_RESPONSE_INSTRUCTIONS=true`, retaining its data volume and other configuration. Stage changes should be recorded individually. Changing pipeline mode also changes the current cookie name, so log in again afterward.

For source rollback, the behavior commits are `980cb59`, `9f5b903`, and `274a9b5`. They can be reverted in reverse order if the experiment code is no longer wanted; preserve later unrelated edits rather than resetting the branch. No rollback has been executed.

Current demo stage: `VOICE_PIPELINE_MODE=sequential`, `VOICE_SENTENCE_CHUNKS=true`, `VOICE_SKIP_FIRST_THINKING=false`, `VOICE_RESPONSE_INSTRUCTIONS=false`. The visible label is “Sentence chunks · buffered audio”. Only sentence-level delivery has been enabled; TTS prefetch during playback remains disabled.

## Stage two: generation overlaps playback

`VOICE_TTS_PREFETCH=true` enables a single TTS producer alongside ordered playback, with at most two fully prepared phrases queued ahead. Each sentence's complete audio is still buffered before playback; no streaming PCM playback is enabled. The stage-one mode is restored by setting this flag false. Current demo flags retain sequential STT, sentence chunking, normal thinking and no voice-response instructions. The label reads “Sentence pipeline · buffered audio”.

## Script demo: all described optimizations together

Current test configuration uses `VOICE_PIPELINE_MODE=parallel`, `VOICE_SENTENCE_CHUNKS=true`, `VOICE_TTS_PREFETCH=true`, `VOICE_SKIP_FIRST_THINKING=true`, and a saved VAD silence timeout of 1000 ms. It combines progressive Whisper transcription, incremental sentence submission, TTS generation during playback, and streaming PCM playback. The managed speech service already uses native audio.cpp with Q8 Breeze; there is no BF16-to-Q8 model switch in this step.

`VOICE_COMPARISON=true` keeps the independent demo login cookie and “Streaming pipeline” label when switching away from sequential mode. `VOICE_STATUS_SPEECH=false` and `VOICE_RESPONSE_INSTRUCTIONS=false` keep unrelated filler speech and short/plain-text/canvas-first prompting out of this scripted comparison. No main-instance setting is changed.

Progressive STT often finishes before endpoint detection, but a final request is still made when the cached transcription does not cover the latest speech. Streaming playback retains the existing startup cushion to avoid choppiness. Do not describe those as zero work or zero buffering.

## Demo browser and ubatch-128 preset

The demo now uses the real router preset `qwen36-35b-a3b-mtp-demo`, with `ubatch-size=128`, `batch-size=2048`, one slot and 80K context. The original `qwen36-35b-a3b-mtp` preset retains ubatch 1024. The preset file was backed up before appending the demo section and hot-reloaded without restarting the router. Because the router loads at most one model, switching between demo and main aliases can trigger a model reload; record warm-up separately. This ubatch change is an additional variable in comparisons.

Browser container/profile: `pithagoras-sequential-browser` / `pithagoras-sequential-browser-profile`, with CDP 9223, HTTPS viewer 3021, HTTP viewer 3020 and internal websocket 8084. No original browser logins or credentials were copied. The demo portal connects using `BROWSER_EXTERNAL=true`, `BROWSER_CDP_URL=http://127.0.0.1:9223`, and `BROWSER_STREAM_PORT=8084`; it has no Docker socket and does not own browser lifecycle. Browser MCP is installed and connected, and enabled for “Sequential baseline demo”. New sessions can enable it from the composer browser toggle.

Verification: live worker arguments confirmed ubatch 128/batch 2048. In the isolated “Browser capability check” session, the model navigated to example.com, read a browser snapshot and correctly reported “Example Domain”. The viewer returned HTTP 200. Stopping the temporary demo should now include stopping its browser container; keep its profile volume for recovery. Restore the demo to the original alias before removing the temporary router preset if undoing the ubatch experiment.

Latest model selection: per user request, the test instance has switched back to `qwen36-35b-a3b-mtp` (ubatch 1024, batch 2048). Its default, local model entry and explicitly selected baseline session were updated; all voice-stage and isolated browser settings remain unchanged. The temporary ubatch-128 router preset remains available for rollback/comparison. Main portal container remains stopped at the user's request.

## Fully optimized demo

The user subsequently requested everything enabled on 4101. `VOICE_RESPONSE_INSTRUCTIONS=true` restores brief plain-text speech, canvas-first detailed reports, pre-tool spoken announcements and emotion-cue guidance. `VOICE_STATUS_SPEECH=true` restores thinking/compaction feedback. Progressive Whisper, sentence chunking, TTS prefetch, streamed PCM playback and first-response thinking suppression remain enabled. Regular Qwen ubatch 1024 is selected; the isolated browser remains connected. Main instance stays stopped. Restart voice mode after refreshing to load the new settings.
