# Voice pipeline switches

The voice pipeline has a few switches, set in the portal's environment, that turn
its optimizations off, so that what each one buys can be measured with the
[timing profiler](/guide/voice-profiling): run a second portal beside the first,
with the same model and voice, and change one switch at a time. None of them is
needed in normal use. Left alone, a portal runs the full pipeline.

Progressive transcription (the recording is transcribed while you still speak) and
streamed playback have no switches of their own. They belong to the default
`parallel` mode, and `VOICE_PIPELINE_MODE=sequential` turns both off together.
`VOICE_SENTENCE_CHUNKS` and `VOICE_TTS_PREFETCH` are the two steps back up from
the sequential baseline, and have **no effect** unless the mode is `sequential`.

| Variable | Default | Effect |
| --- | --- | --- |
| `VOICE_PIPELINE_MODE` | `parallel` | `sequential` is the baseline: speech is transcribed only after it has finished, the reply goes to speech synthesis only once the whole agent turn is done, and every generated chunk is buffered completely before playback starts. The fillers and the spoken compaction notices are suppressed so it cannot overlap the measured work. Cancelling and muting still work. |
| `VOICE_SENTENCE_CHUNKS` | `false` | Only in the sequential mode. With `true`, sentences are submitted to speech synthesis during generation, and each sentence's audio plays before the next is synthesized. Audio is still fully buffered per sentence. The first step up from the baseline. |
| `VOICE_TTS_PREFETCH` | `false` | Only in the sequential mode. With `true`, one synthesis producer runs alongside ordered playback, with at most two prepared phrases queued ahead. Each sentence's audio is still buffered before it plays. |
| `VOICE_SKIP_FIRST_THINKING` | `true` | `false` keeps the model's normal thinking on the first response of a voice turn, which is otherwise switched off, for a local model, to start speaking sooner. |
| `VOICE_RESPONSE_INSTRUCTIONS` | `true` | `false` sends no speaking instructions: no `[Audio mode]` marker on the input and no voice rule in the system prompt, so replies are not asked to be brief, plain text or canvas-first. See [Speaking instructions](/guide/voice#speaking-instructions). |
| `VOICE_STATUS_SPEECH` | `true` | `false` keeps the spoken [status lines](/guide/voice#status-lines-while-it-works) out: the fillers and the compaction notices. |
| `VOICE_COMPARISON` | `false` | `true` shows "Streaming pipeline" beside the voice session's title, and gives the login a cookie of its own (see below). |

The voice screen's title says which stage a portal is on. In the sequential mode
it reads "Sequential baseline", "Sentence chunks · buffered audio" or "Sentence
pipeline · buffered audio", depending on the two sentence switches; with
`VOICE_COMPARISON=true` outside it, "Streaming pipeline".

In the sequential mode, and with `VOICE_COMPARISON=true`, the login cookie is
`pi_portal_sequential_auth` instead of `pi_portal_auth`, so a comparison portal
running beside the main one on the same host keeps its own login (browsers share
cookies between ports). Changing the mode changes the cookie, so log in again
afterwards.

## Recording a comparison

- Use the same prompt, model, speaking voice, guidance mode, speech-detection
  settings and starting context in both. Start a new session for each take; an
  earlier conversation still influences the model.
- Record one portal at a time when both share a model server and speech
  services, and end voice mode on the other one first.
- Record a warm-up apart from the measured turns, enable the profiler, and export
  its report after each take.
- Go up one step at a time: the sequential baseline; `VOICE_SENTENCE_CHUNKS=true`
  added; `VOICE_TTS_PREFETCH=true` added to that; then the default `parallel`
  mode, which brings progressive transcription and streamed playback together.

The metric is the time from the last detected speech to the estimated start of
the reply's audio. Browser output timing is a software estimate, not an acoustic
measurement. Progressive transcription often finishes before the end of speech
is detected, but a final request is still made when what it has does not cover
the last of the speech, and streamed playback keeps its startup cushion: do not
describe either as zero work or zero buffering.
