# Voice latency profiling

Use the gauge button beside the microphone (**Profile voice latency**) to enable the profiler before starting a voice turn. The panel displays the latest turn and downloads up to 20 traces as JSON. Capturing is opt-in; closing the panel disables capture. Reports contain timestamps and numeric/status metadata, not audio or transcript content.

The main metric runs from the last VAD frame classified as speech to estimated first generated-reply playback. A second exported metric includes speaking duration. Filler and compaction announcements are tagged separately and do not complete the reply timer. Compaction announcements and tool events can still explain delays in the timeline.

The percentage table partitions browser-clock wall time into turn detection, remaining transcription, dispatch/pending abort, request setup/prefill until first model token, thinking/tools until first reply text, sentence accumulation, TTS queue, TTS request to first received bytes, buffering/decoding, and playback queue/output estimate. Concurrent speculative transcription is listed in raw events rather than double-counted in percentages. These are observed intervals, not isolated CPU/GPU execution durations. Browser event delivery and React scheduling contribute small overheads.

Whisper upstream duration and TTS upstream-header/busy-retry durations come from Server-Timing headers. Llama prompt progress retains reported token/cache counts and elapsed time. Prefill is not presented as an exact standalone compute measurement; model startup, scheduling, cache operations and network time are included until the first model token. Timing clocks are not subtracted across hosts.

Playback timestamps include the actual Web Audio scheduled start plus browser-reported output latency. This estimates device output; it does not measure speaker acoustics, Bluetooth delays reliably, or leading silence in generated audio. For exact acoustic end-to-end latency, record microphone speech and output loopback on the same clock and locate the first non-silent reply sample.

Warm and cold tests should be recorded separately. Capture 5–10 representative turns, then compare medians and slow outliers with the same model/context/voice settings.
