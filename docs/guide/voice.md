# Voice control

::: tip Install Voice with Docker
Open **Settings → Add-ons → Voice → Install voice**.

The [Docker add-ons guide](/guide/add-ons) covers GPU prerequisites, automatic Q8 setup, service controls and cleanup.
:::

::: info Already installed?
Start with the controls below. A manual Compose setup and a native audio.cpp unit are alternative deployments; do not run them alongside the managed installer.
:::

Enable **Voice** under **Settings → Add-ons** to talk to any open session.
Click the **microphone icon** beside Send once, then speak naturally. The browser
uses Silero V5 to detect speech and submits your turn after about one second of
silence. Whisper's transcript becomes a normal session message, and streaming
assistant text is spoken with **BreezeBlue/Breeze-TTS-2**.

The microphone stays open while the session works and speaks. Start talking to
interrupt: after roughly 256 ms of detected speech, playback and queued audio
stop, the current session response is aborted, and your new turn takes over.
Short noises are filtered out. Turn detection is based on speech and silence,
not semantic prediction of sentence completion. Echo cancellation and noise
suppression are requested from the browser; headphones work best when speaker
audio is still picked up by your microphone.

VAD runs locally in your browser. Its pinned model and WebAssembly runtime are
served by Pithagoras, with no CDN dependency or extra GPU allocation.
Whisper receives rolling snapshots while you speak (roughly every two seconds),
and a fresh snapshot after about 200 ms of silence. The voice screen shows the
latest partial transcript. At turn end, Pithagoras reuses a result only when it
covers the last detected speech; otherwise it transcribes the final recording.
This overlaps recognition with the silence window instead of starting all work
after it. The current Whisper API remains clip-based, so this is speculative
transcription rather than a token-streaming ASR model. Long turns are segmented
at 60 seconds and listening resumes automatically.

Microphone access needs HTTPS or localhost. A microphone the browser refuses — blocked
for the site, none connected, in use by another program — is said in the portal's
language, with where to change it (the site settings behind the icon left of the
address), for dictation and voice mode alike. Voice mode replaces the chat and
composer with an audio-reactive orb: by default teal for your voice and violet
for spoken replies. The screen keeps only status, the controls and live words while you
speak. Quiet synthesized sound cues mark connection, submission, mute and tool
focus; they can be turned off in the voice settings. Reduced-motion
preferences disable panel transitions.

The orb is the agent's avatar, and each [agent](/guide/agents) has its own. Its
look is set on the **Agents** page: open an agent and use the palette on its
avatar, which opens a dialog with a live preview you can try in each state
(idle, listening, speaking, muted). Choose a personality (how it moves), a colour
palette and a colour for each state, the surface (glossy or plush, and a pattern),
the motion speed, reactivity and glow, eyes, a hat and a prop. With voice
installed, the dialog also has the **Voice** the agent speaks with. **Save
avatar** stores both for that agent, and every device shows it the next time
voice mode starts. **Reset to default** puts the plain orb back in the dialog; it
only becomes the saved avatar once you press **Save avatar**. Voice mode shows
the avatar of the agent the chat is with, the first agent's for a chat in a
project.

Browser tool calls bring the live browser into a floating window and dock the
orb. Terminal calls show the agent’s actual command and streamed output on the
right, moving the orb left. With both open, the browser is larger and the terminal
sits beside it; narrow screens stack them. When the agent reads or changes a file
in the chat's folder, [Files](/guide/files) opens the same way and shows it. Minimize
any panel to reclaim space without interrupting the agent. Session option dialogs remain available when an
action needs your input.

**Mute** disables microphone capture without stopping the session or spoken
replies. **Unmute** resumes hands-free listening. **End** restores the chat and
your text draft, releases the mic, and cancels pending audio/transcription.
Leaving the session also releases these resources. Ending voice does not stop
an already accepted agent task. Existing transcript history is never read aloud
on activation. Status text shows listening, speech detection, transcription,
and playback; errors remain visible in the voice screen.

## Pictures, tool cards and controls

**Giving the agent a picture.** Choose the picture button beside the microphone
(on a phone it offers the camera too), paste a picture anywhere on the voice
screen, or drop one onto it. Pictures wait at the top as thumbnails and go with
the next thing you say, so "what is wrong with this?" arrives with the picture.
Up to eight go with one message; remove one with its ×. They are kept if you
end voice mode before speaking, and are there again when you turn it back on.
The model has to take images; if it does not, the chat says so.

**The agent showing you a picture.** The agent has a `show_image` tool: it saves
a chart, a diagram or a screenshot in the chat's folder and calls it, and a
**Pictures** window opens on it, like the browser and terminal do. Tap the
picture to see it at full size, use the arrows to go back through earlier ones,
or open it in a new tab. Outside voice mode the picture appears in the chat. With
[image generation](/guide/features#image-generation) switched on, the agent also
has `generate_image`, which makes a new picture from a description and shows it
the same way, and, with image editing switched on, `edit_image`, which changes a
picture in the chat's folder into a new one; the voice instructions mention each
only while it is there. Canvases can include pictures from the folder too (see
[Canvases](/guide/canvases)).

**Tool cards.** The cards that fly out of the orb say what the agent is doing
in words — "Editing app.ts", "Searching for “retry”", "Opening a page ·
example.com" — and stay while the call runs, counting its time. When it ends
they say what came of it: `+12 −3` lines for an edit, "8 matches", "Nothing
found", or the first line of an error. Tap a card to open what it is about: the
file in Files, the terminal, the browser, the document or the picture. The card
of a `generate_image` or `edit_image` call has the chat's picture preview in the
place of its mark, as a small tile: a frame while the picture is made (it moves
only while the [animations](/guide/interface#animations) are on), the picture
itself once it is there, and a quiet mark where none was made.

**Controls.** Beside the microphone and End:

| | |
| --- | --- |
| **Add a picture** | As above. The number on it is how many are waiting. |
| **Repeat** | Plays the last reply again from the audio already made, at the current speed, without asking the agent. Saying "say that again", "repeat that", "sag das nochmal", "wie bitte?" and the like does the same; only a sentence that is nothing but that request counts, so "say that again, but shorter" still goes to the agent. |
| **Stop** | Shown while the agent works. Stops the task without ending voice mode. |

The buttons at the bottom right open the **conversation** — a window like Files,
with what you said as it was transcribed and what came back as written, with
its markdown (lists, code, links) rendered as in the chat, each in a speech bubble — the
canvases, Files, pictures, the browser and the terminal, and the **voice
settings**:

| Setting | |
| --- | --- |
| **Speaking speed** | 1×, 1.25×, 1.5× or 1.75×. Speech is made faster in the browser without raising the voice (WSOLA time stretching), so it works with every speech runtime and a streamed reply starts as early as before. |
| **Talking while the agent works** | **Stops it** (default): speaking interrupts the task, as before. **Adds to the task**: what you say goes into the running task after its current step, and the task carries on; use Stop to stop it. |
| **Push to talk** | Only what you say while holding <kbd>Space</kbd> (outside a text field) or the microphone button is heard. A tap, or a press with no speech in it, is not sent. Useful with background noise or other people talking. |
| **Fillers** | **On** (default) or **Off**: short sounds from the moment you have finished until the answer starts, again and again if the wait is long. While they are on, four more settings say when they come: **First filler after**, **Time between fillers**, **Randomness** and **Most per wait**. See [Fillers](#fillers). Not shown where the portal has them switched off. |
| **Sound effects** | The cues for connection, sending, mute and panels. |

Each setting is remembered in this browser.

**Profiling.** The gauge button beside the microphone opens a latency profiler for
the voice turns you take, see [Voice latency profiling](/guide/voice-profiling).

**Resizing windows.** Drag a window's left, right or bottom edge, or a bottom
corner, to make it the size you want; the canvas panel has the same grips. A
window keeps that size until the windows are arranged differently — one opens
or closes — and then the layout places them again. On a phone the windows take
the width and cannot be resized. Without a pointer, a window's bottom corner is
reached with `Tab`: the arrow keys make the window larger or smaller (`Shift`
for bigger steps), and `Home` or `Enter` give it back to the layout.

**Reloading.** A reload keeps voice mode on in that tab. Where the browser will
not play audio before the page is touched, the voice screen says "Click or
press a key to continue voice mode" and carries on after that. Ending voice
mode, or opening another chat, ends this too.

**Keyboard shortcuts.** Everything above has a key; the tooltip of each button
names it. They work while voice mode is on, except while typing in a field, and
can be changed under **Settings → Shortcuts**.

| Key | |
| --- | --- |
| <kbd>Alt</kbd>+<kbd>V</kbd> | Start or end voice mode, from the chat too |
| <kbd>M</kbd> | Mute or unmute the microphone |
| <kbd>Space</kbd> (held) | Talk, with push-to-talk on |
| <kbd>Esc</kbd> | Stop what the agent is doing; with nothing running, end voice mode |
| <kbd>P</kbd> / <kbd>R</kbd> | Add a picture / repeat the last reply |
| <kbd>C</kbd> <kbd>D</kbd> <kbd>F</kbd> <kbd>I</kbd> <kbd>T</kbd> <kbd>B</kbd> | Conversation, canvases, files, pictures, terminal, browser |
| <kbd>O</kbd> | Voice settings |
| <kbd>.</kbd> / <kbd>,</kbd> | Speak faster / slower |
| <kbd>A</kbd> | Switch between stopping and adding to the task |
| <kbd>H</kbd> | Push-to-talk on or off |
| <kbd>Shift</kbd>+<kbd>M</kbd> | Sound effects on or off |
| <kbd>Shift</kbd>+<kbd>F</kbd> | Fillers on or off |

## Fillers

After you stop talking there is a silence before the answer: your words are
recognised, the model starts, and the first sentence has to be turned into speech.
A **filler** is a short sound the voice makes in that gap, the "ah, okay" of someone
who has heard you and is picking it up, so that voice mode does not go quiet. It
replaces the spoken "let me think about that" line that used to come after about
two seconds, in English only. The gap can be long: a model that has to read a lot
before it starts, or an agent that thinks and works for a minute before its first
sentence. One "oh, okay" and then silence is not much better than none, so the wait
is filled again and again until the answer is heard, at a pace you set (see
[When they come](#when-they-come)).

**What it says.** One of eight two-sound forms: "Ah, okay.", "Oh, okay.", "Okay,
ah.", "Ah, mhm." and "Okay, mhm.", and for a long wait "Mhm, okay.", "Oh, mhm."
and "Okay, oh." They are the sounds people make while
listening and the one word every language has taken over, so nothing is written
out per language and no language has to be guessed. They are made in your voice
and with the language set under **Settings → Add-ons → Voice**, and said as that
language says them (a German voice says "okay" the German way, a Korean one the
Korean way). It is always two sounds, never one: with Chatterbox a lone "Okay."
or a wordless "Hmm." was said twice, ran on for seconds, or came out as other
words (Polish turned "Mhm." into a sentence). All eight were rendered in all 19
languages Chatterbox speaks and came out once, at 0.9 to 2.3 seconds, each time.
A clip that still comes out far longer than its text takes, which is the same
fault, is thrown away when it is made and never played, whichever speech
runtime and language is set. Chatterbox, Kokoro and audio.cpp are seeded and would say it
the same way again, so such a clip is not made again for that voice. The classic
Breeze server is not seeded: there it is made again, up to three times, and only
after that left alone, until the portal is restarted and not for good.

**Made once, not at play time.** The portal makes the first five clips the first time
voice mode starts with a voice, in the background (about ten seconds on a fast
GPU with Chatterbox, well over twenty on a shared one: a clip takes as long as a
sentence of an answer does), keeps them in its data folder under `voice-fillers`,
and the page downloads them when voice mode starts. A filler is therefore a sound
already in the browser's memory: no synthesis stands between the end of your turn
and the sound.

They are made in the voice of the agent the chat is with, as the answer is, so a
chat with an agent that has its own voice has its own set of clips.

**The other three are made in a lull.** More clips mean a longer wait for the
first ones and more time with the speech runtime busy, so the extra three, which
only a long wait needs, are made after the first five and only once it has been
quiet for 30 seconds since: no recognition, no speech being made, no agent at
work. Any of those pushes them back by another 30 seconds, so they never compete
with a conversation, and the first set takes what it always did. They are kept
like the others, so this happens once per voice, and the page, which asks every
three seconds while the portal is making clips, keeps asking for up to twenty
minutes for them to arrive. Until they have, a long wait is filled from the five
there are.

The speech runtime has one slot, and it does not give up a request it has begun:
audio.cpp runs it to the end whatever the portal does, so a clip cannot be cut off
for an answer. A clip under way when an answer is asked for is finished first, and
the answer waits for it, by up to the time of one clip (the same one to five
seconds as a sentence of the answer). To keep that rare, a clip is only started
when no answer is near: not while your speech is being recognised or an answer is
being synthesized, not for eight seconds after either (the gap between two
phrases of an answer is not the end of it), and not while the agent is at work,
which the page says with every look. The first set is made from the start of voice
mode, before you have spoken; a clip under way when you do speak is not thrown
away, and the clips still missing are made once it is quiet again. Until then
you may hear fewer fillers, or none, on the first turns of a new voice.

They are made only while a page is asking for them: ending voice mode, or
switching fillers off, tells the portal, which drops the request it is on and
makes no more (the clips still missing are made the next time voice mode starts),
whether or not it manages the speech service, so the speech model is not loaded
back onto the GPU for clips nobody is waiting for. A page that cannot say so, a
tab that was closed, is given up on after ten seconds without a question. Only one
voice is made at a time. Another voice, language, speech runtime, expressiveness
or reference recording stops the one being made, makes a new set, and the old one
is deleted once the first clip of the new one is made (a setting changed and
changed back loses nothing).
Until the first clip is ready there is no filler; one never waits for them.

**When the first one plays.** By default the moment your turn is taken: what you
said has been recognised, it is not a noise and not a request to the page ("say
that again"), and it is on its way to the agent. This is before the agent has taken
the message up, not after a timer, and not after the run your turn interrupts has
wound down: with an agent at work, the filler plays while that run is still being
stopped. (**First filler after** can hold it back, see below.) The budget:

| | |
| --- | --- |
| The end of your turn | Detected by the silence window after your last word, one second by default; that part is unchanged. |
| The transcript | Usually there already when the turn ends, since recognition runs while you speak; otherwise one recognition request. |
| The filler | Within 150 ms of the transcript, with nothing to fetch and nothing to synthesize: it is played from memory. Measured against a local portal with Chatterbox: 0 to 93 ms. |

So a filler is heard as soon as your turn has ended where recognition was
ready, which is the usual case, and one recognition request later where it was
not. A first filler that could not be played because no clip was ready is not made
up for with a late one at once, but the timing below carries on.

**When they come.** Voice settings → **Filler timing**, four numbers, kept in this
browser and shown while fillers are on:

| Setting | What it does | Default | Limits |
| --- | --- | --- | --- |
| **First filler after** | Seconds of silence after your turn is taken before the first filler. If the answer is audible before then, there is no filler at all. | At once (0 s) | 0 to 10 s |
| **Time between fillers** | After a filler has ended, how long before the next. This is the base the randomness varies. | 5 s | 1 to 30 s |
| **Randomness** | Like a temperature. At 0 % every gap is exactly the time between fillers. Above that each gap is that time made shorter or longer by a random amount of up to this share of it, evenly spread: at 20 % and 5 s, 4 to 6 s; at 100 %, 1 to 9 s. It does not apply to the first filler's time. | 20 % | 0 to 100 % |
| **Most per wait** | At most this many fillers in one wait. After that the voice stays quiet until the answer: a long task is not filled for ever. | 8 | 1 to 20 |

There is no cadence built into the page: the gaps are these numbers and nothing
else. A change applies at once, also in the middle of a call and to a gap that is
already running: the filler that was due is due by the new time, counting what has
passed since the last one ended (so a gap shortened below what has passed brings it
at once, and a lengthened one pushes it back), and a most that has been reached
ends the wait. Where in its spread a gap falls is drawn once, when it starts: a
change of the randomness or of the time moves the gap along with it, and a change of
the most or of the first filler's time leaves it where it was, instead of rolling
it again. Values are kept as numbers within the limits above, in steps (half
seconds, 5 %, whole fillers): what was typed in or changed in the browser's
storage that is not a number is the default, and one out of range is the nearest
limit. The shortest gap is one second, so a wide randomness cannot put two fillers
on top of each other: a spread that would go below it is narrowed to end there
(5 s at 100 % is 1 to 9 s, not 0 to 10 s), still evenly and centred on the time
set, and at one second there is none.

The defaults fill about the same wait as before, about three quarters of a minute,
with the same early density: eight fillers, five seconds apart, give or take a fifth, are
about 45 seconds, and four of them fall in the first twenty, as with the growing
gaps they replace. Those were 3, 4.5, 6.5, 9.5 and then 14 seconds with six at most,
and they are gone, for two reasons. A cadence that grows by itself makes "time
between fillers" untrue and "randomness 0" inexact, the two things these settings
are for. And what the growth was for, keeping a long task from being filled with
"mhm" for ever, is **Most per wait**, which is now visible and yours: to have them
thin out, set a longer time and a smaller most, and for a wait that is filled for
longer, a larger one (twenty at most). The first filler's time is a delay, not a
gap, so it is exact.

The timeline stops at once when:

- the answer's audio is ready (see below), whether a filler is playing or the
  wait is between two. Not before: while the first sentence of the answer is still
  being made into speech, which on a busy speech runtime takes seconds, the wait
  is filled all the same;
- you say something for the agent, or the conversation is being compacted (which
  has its own spoken notice). Speech that turns out to be none, a noise, a press
  of the talk key taken back, or a request to the page ("say that again"), does not
  end the wait: it goes on one gap after that sound, not at once, and the fillers
  already played still count towards the most;
- the agent has finished with no answer on its way (an answer that is still
  being made into speech is one, also after the run has ended), voice mode ends,
  or fillers are switched off.

If no clip is ready at a moment when one is due, it is tried again after the next
gap, and counts towards the most. When the page is playing something else at that
moment, such as the repeat of the last reply, a filler does not come on top of it
either: it is due one gap later, and that does not count. If the last sound before your next turn was a
filler (no answer or notice since), its first filler does not come on top of it:
it waits what is left of one gap since that filler ended, or the time to the first
filler if that is longer. A turn more than a gap later, such as one that interrupts
a long silent task, gets its first filler at once as any other.

**It gives way to the answer.** The answer is never heard over a filler. The
filler stops when the answer's audio is ready to play, not when its text arrives,
so it is not cut off while the answer is still being made. It fades out within
40 ms instead of being cut mid-wave, and the answer starts as it has gone; a
player that does not report back is not waited for longer than 150 ms. If you
start talking, it stops at once. Talking over it is not a turn for it to finish.

**It does not repeat itself.** Of the clips ready, none of the last two played is
chosen again (with three or fewer clips ready, not the last one), and none comes
round again before all the others have been heard, in an order that changes each
round. One wait does not get a clip twice while there are others it has not had,
wherever in that round it falls: with all eight ready, six fillers are six
different ones. With only the first five ready a sixth has to repeat one, but never
the last two. A clip that turns up in the middle of a wait is heard before the ones
heard already. With only one clip ready, it is played once and then silence beats
saying it again.

**Switching them off.** **Voice settings → Fillers → Off**, or
<kbd>Shift</kbd>+<kbd>F</kbd>. The choice is remembered in this browser, and while
it is off the page asks the portal for nothing and fetches nothing, and tells it
to stop making them. The timing settings are hidden then, and kept for when they
are on again. Two things switch them off for the whole portal, and then
the setting is not shown:

- `VOICE_STATUS_SPEECH=false`, which also switches off the spoken compaction
  notices below. The portal makes none of the clips either.
- `VOICE_PIPELINE_MODE=sequential`, the [comparison](/guide/voice-comparison)
  baseline: it runs the stages strictly one after the other so that they can be
  measured, and a sound during the agent's work would be a stage of its own. It
  speaks nothing but the answer.

**Compaction.** While the conversation is being compacted (which takes long
enough to matter) the voice says so, once when it starts, again when you speak
meanwhile, and when it is done. Those are sentences, not fillers, and they are
said in the language the voice speaks (the input language set under **Settings →
Add-ons → Voice**), not the interface language: a German page with an English
voice gets the English sentence. The portal has wording for English and German.
With **Auto-detect** the interface language is used where it has wording. For any
other language the voice says nothing about compaction, since reading it another
language's text is worse than silence; the stage shows "Compacting context" all
the same. They follow the same two switches as the fillers.

## Dictation

Voice mode is a conversation. When you only want to get words into the message
box, use **dictation**: the **microphone icon** left of the waveform icon. Speak,
and what you say is transcribed and typed in; the agent never speaks back and a
run in progress is not interrupted.

It listens the same way voice mode does, with the same in-browser speech
detection and the same recognition service, so it works as soon as Voice is
enabled. Speech synthesis is not used and nothing is loaded onto the GPU for it.
While you talk, a line above the box shows whether you are being heard and the
words recognised so far. Pausing for about a second ends a phrase, and the next
phrase follows it.

Choose where the words go with the switch on that line. The choice is remembered.

| | What happens |
| --- | --- |
| **Edit first** (default) | Each phrase is typed into the box **at the cursor**, spaced like a word, and the cursor moves to the end of it. Click into the text to dictate in the middle of a sentence, correct a word by keyboard, then send with Enter as usual. Dictation keeps listening after you send. |
| **Send at once** | A message is sent once you have stopped talking and it has been transcribed. If you start speaking again while a phrase is still being transcribed, the two go out together. A draft already in the box is left alone. If sending fails, the words are put back in the box rather than lost. |

Stopping dictation still delivers a sentence you were in the middle of. Starting
voice mode turns dictation off, since both use the microphone, and leaving the
session drops anything not yet transcribed instead of sending it elsewhere: a
sentence you are still saying when you open another chat is not sent to that one.
Whisper's placeholders for silence, such as `[BLANK_AUDIO]`, are not typed.

Messages sent by dictation are ordinary text messages. Unlike voice-mode turns
they are not marked as audio and the agent is not asked to reply in speakable
style.

## Alternative: manually managed Python services

::: details Show alternative deployment details
The optional Compose overlay starts Whisper.cpp and the official Breeze runtime
on the same Linux host. Install Docker Compose with GPU support and NVIDIA
Container Toolkit first. Breeze recommends at least 12 GB GPU memory for eager
inference; allow additional memory for Whisper and any session model sharing the
GPU. The overlay uses eager inference. Its default Flash Attention architecture
is `86` (consumer Ampere, such as an RTX 3060); use `FLASH_ATTN_CUDA_ARCHS=80`
for A100 or `90` for Hopper. Match the build to your GPU
and ensure the NVIDIA driver supports the upstream containers' CUDA versions.

From the Pithagoras repository on that host:

```sh
mkdir -p voice-runtime
git clone https://github.com/ggml-org/whisper.cpp voice-runtime/whisper.cpp
git clone https://github.com/breezeblue-ai/breeze-tts voice-runtime/breeze-tts
bash voice-runtime/whisper.cpp/models/download-ggml-model.sh base voice-runtime/whisper.cpp/models
uvx --from huggingface-hub hf download BreezeBlue/Breeze-TTS-2 --local-dir voice-runtime/Breeze-TTS-2
docker compose -f docker-compose.voice.yml --profile voice up -d --build whisper breeze
```

The source checkouts are retained locally, so subsequent builds use those same
revisions until you update them. Downloading models and compiling the images
can take a while. Inspect startup with:

```sh
docker compose -f docker-compose.voice.yml --profile voice logs -f whisper breeze
curl --fail http://127.0.0.1:7860/health
```

Open **Settings → Add-ons → Voice**, leave these defaults and enable voice:

| Setting | Value |
| --- | --- |
| Whisper inference URL | `http://127.0.0.1:8178/inference` |
| Breeze speech URL | `http://127.0.0.1:7860/v1/audio/speech` |

The main Compose file uses host networking, so the portal reaches both services
at these loopback addresses. The service ports are bound only to host loopback;
the web client talks through the portal's authenticated API. For another
container network, configure addresses reachable from the portal container.
The URLs must point to the full endpoints shown above. Whisper uses the
Whisper.cpp multipart API; Breeze uses its native multipart API, not an
OpenAI-compatible JSON speech endpoint.

To speak in a voice of your own, add a reference clone with **Add voice**: a
recording and the exact words spoken in it. Choose it under **Speaking voice**,
and the portal sends the recording and its transcript to Breeze. Recordings are
kept in the portal's database on the persistent data volume and are never served
as public assets. A voice that is missing produces an error rather than silently
switching voices.

Choose **Designed voice** to generate a voice without a reference.
**Describe the speaking voice** controls delivery in either mode. Breeze supports English and Chinese speech.
Model weights and self-hosted outputs have a research/non-commercial license;
see the [model card](https://huggingface.co/BreezeBlue/Breeze-TTS-2).
:::

## Other languages: Chatterbox and Qwen3-ASR

Breeze speaks English and Chinese, and the managed installer pairs it with
Whisper. For another language, run [audio.cpp](https://github.com/0xShug0/audio.cpp)
with **Chatterbox Multilingual** for speech and **Qwen3-ASR** for recognition.
One process serves both, on one GPU, so the session model can keep the other.

Chatterbox speaks Arabic, Danish, Dutch, English, Finnish, French, German, Greek,
Hindi, Italian, Korean, Malay, Norwegian, Polish, Portuguese, Spanish, Swahili,
Swedish and Turkish. Qwen3-ASR covers those and more. Both are MIT/Apache-2.0
licensed, unlike Breeze's research-only weights.

The managed **Install voice** button in Settings builds this combination for
you: pick **Chatterbox** and **Qwen3-ASR** under **Speech engines** (see
[Docker add-ons](/guide/add-ons#engines-devices-and-memory)), and the installer
downloads both models, sets up the one audio.cpp process and points the settings
at it. The rest of this section is the alternative: running audio.cpp yourself,
as a separate deployment. It does not replace Breeze or the managed installer,
and both keep working unchanged.

### Download the models

```sh
mkdir -p voice-runtime/audio-cpp
hf download audio-cpp/audio.cpp-gguf \
  Chatterbox-GGUF/chatterbox-q8_0.gguf \
  Qwen3-ASR-1.7B-GGUF/qwen3-asr-1.7b-q8_0.gguf \
  --local-dir voice-runtime/audio-cpp
```

About 4.5 GB. Together the two models occupy roughly 5.5 GB of GPU memory while
both are loaded.

### Start the runtime

With Compose:

```sh
docker compose -f docker-compose.voice.yml \
  --profile voice-multilingual up -d audiocpp
curl --fail http://127.0.0.1:7871/health
```

`VOICE_GPU` is the index of the GPU the service runs on, as `nvidia-smi` lists
them, and it is `0` when unset: on a host with one GPU, leave it alone. With
more than one, name the card the session model does not use, in front of the
command or in `.env`: `VOICE_GPU=<index> docker compose …`.

`server.json` binds loopback, and Compose publishes the container's port on
`127.0.0.1:7871`: the service has no authentication, so nothing should reach it
from the network. The Chatterbox entry declares `"task": "clon"`, which is
audio.cpp's own name for voice cloning — not a truncated `"clone"`.

`deploy/voice-multilingual/` also holds a systemd unit for a native audio.cpp
build. It reads the same `server.json`, so point `/models` at your GGUF
directory — a symlink is enough — or edit the two paths in that file. Build the
server where the unit's `ExecStart` expects it:

```sh
cd /opt/audio.cpp
scripts/build_linux.sh --backend cuda --target audiocpp_server
```

The unit uses GPU 0 unless `/etc/default/pithagoras-audio-cpp-multilingual`
sets another with `VOICE_GPU=<index>`, which is what a host with two GPUs does to
leave the first to the session model.

### Point the portal at it

Open **Settings → Add-ons → Voice → Advanced connection** and set:

| Setting | Value |
| --- | --- |
| Speech runtime | **Chatterbox audio.cpp · multilingual** |
| Speech recognition URL | `http://127.0.0.1:7871/v1/audio/transcriptions` |
| Speech synthesis URL | `http://127.0.0.1:7871/v1/audio/speech` |
| Speech recognition model | `qwen3-asr` |

Then choose your **Input language** — it selects the spoken language too — and a
**Speaking voice**. Chatterbox has no detection mode, so **Auto-detect** is not
offered for it and the dropdown lists only the nineteen languages above.
Chatterbox always clones a reference recording: choose or add a voice with
a recording in the language you want to hear. A designed voice is refused when
you save, not silently replaced. Use a clean 10-second reference.

**Speech delivery** replaces Breeze's Fast/Expressive choice. It sets
Chatterbox's emotion exaggeration: calm, natural, or expressive.

Numbers are written out before synthesis for languages that have a pack
(currently German and English), because Chatterbox otherwise reads digit groups
unreliably — "4070" came back from recognition as "70". The transcript keeps the
digits; only synthesis sees the words. Each pack knows how its language groups
thousands, so German "100.000" is spoken as one number rather than as a decimal.
Dates, clock times, version strings, ranges and anything with a leading zero
keep their digits: reading them as quantities would be worse than leaving them.
So do the digits of a name such as `v20.11` or `Qwen3.5`, which are not spoken
as a number of their own.
Adding a language is one entry in `server/src/voice-numbers.ts`; a language
without a pack keeps its digits, and the add-on says so under the language.

Chatterbox has no streaming mode in audio.cpp, so each phrase arrives as one
complete WAV instead of a PCM stream. Playback is unchanged, because the browser
buffers each phrase before playing it either way, but the first audio of a reply
waits for its whole first sentence. Measured on an RTX 3060 with a German
reference: a short sentence took 1.25 s, and 14 s of speech took 5.7 s
(about 0.4× real time). Qwen3-ASR transcribed 3-second German clips in about
0.3 s. These are sample measurements, not guarantees.

Recognition uses the OpenAI transcription API, which needs the model name that
`server.json` gives it. Whisper.cpp has a single model and ignores the field, so
leaving **Speech recognition model** empty keeps the existing Whisper setup
byte for byte.

Do not run this deployment and the managed service on the same GPU unless it has
the memory for both: the Settings page shows what each combination needs, and the
managed installer reads the GPU before it installs.

### Behind llama-swap

With [llama-swap](https://github.com/mostlygeek/llama-swap) as the only gateway
on the host, audio.cpp does not need a port of its own: llama-swap starts it on
the first speech request and routes `/v1/audio/speech` and
`/v1/audio/transcriptions` to it by the request's `model`. One llama-swap entry
serves both models, with the two model ids as aliases, so the request reaches
audio.cpp with `chatterbox` or `qwen3-asr` unchanged:

```yaml
models:
  audio-cpp:
    cmd: |
      /path/to/audiocpp_server --config /path/to/server.json
      --host 127.0.0.1 --port ${PORT}
    # The GPU for speech, as nvidia-smi lists them; leave both lines out with one GPU.
    env: ["CUDA_DEVICE_ORDER=PCI_BUS_ID", "CUDA_VISIBLE_DEVICES=<index>"]
    aliases: [chatterbox, qwen3-asr]
    ttl: 900          # stop the process after 15 quiet minutes
    unlisted: true    # not a chat model, so keep it out of /v1/models
```

Breeze, the English voice, is a third model in the same `server.json`, with
`breeze` added to the aliases:

```json
{
  "id": "breeze",
  "family": "breeze_tts",
  "path": "/models/Breeze-TTS-2-GGUF/breeze-tts-2-q8_0.gguf",
  "task": "tts",
  "mode": "streaming"
}
```

Choose **Breeze audio.cpp · streaming** as the speech runtime in the portal and
it sends `model: breeze`. The audio.cpp build has to include the family: a build made with
`--model-set custom --models chatterbox,qwen3_asr` cannot load it, so add
`breeze_tts` to `--models` and rebuild. With `"max_loaded_models": 2` the server
keeps Qwen3-ASR and whichever speaking voice was used last resident, and
unloads the other. The Q8 file is published as
`Breeze-TTS-2-GGUF/breeze-tts-2-q8_0.gguf` in `audio-cpp/audio.cpp-gguf`
on Hugging Face, so no local quantizing step is needed.

audio.cpp loads lazily on its own: with `"lazy_load": true` in `server.json` a
model is read on the first request that names it, and `"idle_unload_ms"` frees
it again after that long without use. llama-swap's `ttl` is the coarser layer
above, ending the whole process and its CUDA context. A cold start through the
gateway measured 6.5 s for a first spoken sentence.

The gateway runs one model at a time unless told otherwise, so without a
`routing` section every speech request would unload the language model. Put the
audio entry in a matrix set with the LLM that leaves its GPU free. In this
example speech lives on the second of two GPUs, so it goes next to a model pinned
to the first, and a model split across both stays alone. With one GPU, the audio
entry can share a set with a model only if that model leaves the roughly 5.5 GB
the two speech models need; otherwise leave it out of the sets and the gateway
swaps them:

```yaml
routing:
  router:
    use: matrix
    settings:
      matrix:
        vars: { o: chat-model, q: large-model, a: audio-cpp }
        sets:
          pinned: "o & a"
          split: "q"
```

In the portal, use the gateway for all three URLs. **Speech recognition URL**
is `http://127.0.0.1:8080/v1/audio/transcriptions` and **Speech synthesis URL**
is `http://127.0.0.1:8080/v1/audio/speech`; the model names stay `qwen3-asr` and
`chatterbox`.

The language model is a plain provider in pi's `models.json`, not the
`pi-llama-cpp` package. That package asks `/props?model=<id>` about every model,
and llama-swap answers such a request by loading the model, so registering three
models swaps through all of them.

```json
{
  "providers": {
    "llama-swap": {
      "baseUrl": "http://127.0.0.1:8080/v1",
      "api": "openai-completions",
      "apiKey": "none",
      "models": [{ "id": "chat-model", "reasoning": true, "contextWindow": 262144 }]
    }
  }
}
```

## First spoken response

On the host executor with a llama.cpp provider (a llama.cpp server or a
llama-swap gateway, as set on the Providers page or as its name says), each
voice prompt disables thinking for its first model call and asks for a brief spoken answer before
tools. Later calls after tools use the session’s existing thinking setting.
A conditional rule in the system prompt asks for plain, concise speech when the
latest user message begins with `[Audio mode]`. The portal adds that prefix to
microphone submissions and typed requests sent in voice mode. The rule is part
of the prompt pi builds, so it stays when tools come and go.

While voice is switched on with a speech engine (not recognition alone), the rule
is in the system prompt of every conversation, spoken in or not. A local model
keeps a cache of the prompt it has already read, and that cache starts at the
system prompt: with the rule there from the start, the first spoken message in a
typed conversation leaves the prompt as it was, and nothing is read again before
the first spoken reply. The rule says plainly that it describes the marker and
that a message is spoken only when its own text begins with it, so typed
messages keep normal chat formatting.

With voice switched off, or left with recognition alone, the rule is only in a
conversation that has had voice. It comes in with the first spoken message,
including one sent while a typed run is still going, and typing again does not
take it out. It is left out again when a spoken message never reached the
conversation (refused, or taken by an extension) and no other spoken one is
there, and when the conversation is opened with no spoken message in what the
model is given: after a restart, a compaction, or an edit that removed the
spoken messages. Coming in, it changes the system prompt once, and a local model
reads the conversation again before that first spoken reply.
The marker stays in model conversation history, while the chat UI shows the
original user text. No temporary system messages are inserted. Ordinary text
requests have no marker and use normal chat formatting, even after voice turns.
Tool calls and file contents keep their required formats. Saved thinking
preferences are unchanged. This skips initial
reasoning latency, but prompt processing and sentence synthesis still take time.
Other providers and the container executor retain their normal thinking behavior.

**Settings → Add-ons → Voice → Reply without thinking first on** names the
providers instead, as the model menu shows them, separated by commas. Switching
thinking off goes through the llama.cpp chat template, so only llama.cpp servers
and the gateways in front of them, such as llama-swap, follow it. Until a list
is saved, the portal goes by what the Providers page says each provider is, so
a llama.cpp server with any name counts; the field then shows the usual names.
A saved list counts exactly the providers it names, each as it is or as
`name=<address>`, and an empty list keeps thinking on everywhere. **Reset to
the default list** goes back to the portal's own judgement, which follows its
updates.

### Speaking instructions

The rules for how the agent talks — one short spoken sentence before a task's
tools, then now and then a short line of what it found or is trying next while
it works (not one per tool call), plain
text without Markdown, long reports in a canvas, pictures through `show_image`,
the `(laugh)` / `(sigh)` cues — are a block of text that is part of the rule
above. **Settings → Add-ons → Voice → Speaking instructions** shows the text in
use and lets you change it: shorter or longer replies, another tone, no
announcing before tools. Save, and it applies from the next spoken message,
also in conversations that are already open; typed messages keep the prompt they
had. A local model reads the conversation again once after a change, as it
does at the first spoken message.

The built-in text comes from the portal, so a portal update improves it for
everyone who has not changed it. **Reset to default** puts it back in the
field. Saving empty text, or the built-in text unchanged, stores nothing and
keeps following the portal's own. Text can be up to 8000 characters.

What the `[Audio mode]` marker means, and that a message without it is an
ordinary chat message, is said in a fixed note around your text and is not part
of what you edit.

`VOICE_RESPONSE_INSTRUCTIONS=false` on the portal switches the speaking
instructions off as a whole, whatever is saved: no `[Audio mode]` prefix is added
and the system-prompt rule is never sent, which is what the
[sequential baseline](/guide/voice-comparison) does. The page says so, and keeps
your text for when the variable is removed. Any other value leaves them on.
`VOICE_SKIP_FIRST_THINKING=false` keeps thinking on for the first call. The
remaining `VOICE_*` variables (`VOICE_PIPELINE_MODE`, `VOICE_SENTENCE_CHUNKS`,
`VOICE_TTS_PREFETCH`, `VOICE_COMPARISON`) are described in the comparison guide;
`VOICE_STATUS_SPEECH` is described under [Fillers](#fillers).

## Status lines while it works

Voice mode says a few short lines of its own while the agent is busy, so a silence
is not mistaken for a hang. They come from the portal, not from the model; they
are not part of the conversation and are not added to the transcript. Waiting is
filled with [fillers](#fillers), short sounds and not sentences. The short line
that stands in for a code block when a reply is read aloud, "Code is shown in the
transcript.", is in the language the portal is set to (English or German, see
[Settings → Language](/guide/settings#language)): the code itself is never spoken.

- **Compaction.** When the conversation is compacted to free context, a line
  says so ("My context is getting full. Let me quickly compact our conversation
  before I continue."), and another when it is over ("Context compaction is done.
  I'm ready to continue.") or when it stopped before it finished. These are said
  in the language the voice speaks, see [Fillers](#fillers).
- **Talking during compaction.** What you say while it compacts is dropped, not
  sent: the agent cannot take it in until the compaction is over. The portal says
  "I'm still compacting our conversation. Please wait a moment; I'll let you know
  when I'm ready.", at most every eight seconds, so say it again afterwards.

All the spoken lines are off in the [sequential baseline](/guide/voice-comparison),
and `VOICE_STATUS_SPEECH=false` on the portal turns them off everywhere. Only the
lines go: what you say during compaction is still dropped, with nothing said about
it.

## Speech runtimes

**Settings → Add-ons → Voice → Speech runtime** selects how speech is made, and
each runtime has its own address:

| Runtime | For | Notes |
| --- | --- | --- |
| `breeze` | A Python Breeze-TTS-2 service | Designed or cloned voices |
| `audio-cpp` | Breeze on audio.cpp, streaming — what the managed container runs | Whisper on CPU |
| `chatterbox` | Speech in another language, on audio.cpp | Needs an input language (not auto-detect) and a reference clone — a voice with a recording; see above |
| `kokoro` | Kokoro 82M on audio.cpp: small, fast, eight languages | Speaks with one of its own voices, chosen in **Speaking voice**; see [Kokoro's voices](#kokoro-s-voices) |

Recognition is Whisper by default. **Speech recognition model** takes another
model id (letters, digits, `.`, `:`, `-`, `_`), such as `qwen3-asr` behind
llama-swap. **Lazy load** and the speech-detection thresholds are saved with the
rest by **Save voice settings**.

## Speech speed

**Speech generation → Fast** uses CFG 1, avoiding the extra guidance branch.
**Expressive** uses CFG 4 for stronger voice direction. Fast can change delivery
and voice similarity, so compare using the same reference.

## Input language and accuracy

Select **Settings → Add-ons → Voice → Input language** and save. Choosing your
spoken language sends an explicit language hint to Whisper on every turn, avoiding
automatic language guessing on short clips. Auto-detect remains available when
switching languages. Use a multilingual Whisper model for languages other than
English; the managed installer runs multilingual `base` on the CPU by default. A larger model can
improve recognition but adds processing time, so benchmark before switching.
Language selection does not translate speech or change Breeze’s supported output
languages.

## Playback and troubleshooting

Audio is not stored by the portal. The browser encodes detected speech
as mono 16 kHz WAV for Whisper. Browser playback receives Breeze’s 24 kHz PCM
stream; clients that do not request PCM still receive a buffered WAV.

Long responses are split into chunks of at most 600 characters and
played sequentially. Fragments under 20 spoken characters are grouped with the
next phrase; a final short reply is always flushed. Complete sentences and bounded phrases are queued as the
assistant text arrives, without waiting for the full reply. The portal forwards
Breeze’s PCM stream. The browser buffers each spoken sentence or bounded phrase
before playing it as one continuous buffer.

This avoids interruptions within
words when Breeze generates slower than playback. The full text response does
not need to finish.

Text, synthesis and playback have independent queues: Breeze
generates the next phrase while the current one plays, and newly arriving text
joins the synthesis queue immediately. One synthesis request runs at a time, with
at most two completed phrases waiting for playback.

Barge-in and End cancel all
three queues; Mute leaves output running.

Voice prompt submission returns at SDK
acceptance so the HTTP request does not hold playback until model completion.

Pauses can still occur when synthesis
is slower than playback. Barge-in cancels both queued audio and the upstream request.
The first sentence still needs model synthesis time before audio is available.

Code blocks are
replaced with a short spoken notice. The agent's thinking and tool output are not
read out; the portal's own [status lines](#status-lines-while-it-works) are the
only thing spoken besides the reply.

If transcription or sending fails, the error appears beside the controls; a
failed send leaves the recognized text visible for copying. If Breeze reports
HTTP 409, another request owns its single-concurrency runtime. End voice in the
other tab or wait for it to finish. Keep one active voice conversation per GPU
service. Disabling the add-on hides controls; stop its containers separately:

```sh
docker compose -f docker-compose.voice.yml --profile voice stop whisper breeze
```

## Development checks

```sh
npm run build
node --import tsx --test tests/voice.test.mts tests/voice-numbers.test.mts tests/hands-free.test.mts tests/live-transcription.test.mts tests/speech-pipeline.test.mts tests/voice-first.test.mts
npx playwright test
```

The tests run local simulated services to check multipart requests, session
validation, opt-in behavior, WAV output and speech chunking. They do not test
model inference or microphone hardware.

Runtime references: [Breeze](https://github.com/breezeblue-ai/breeze-tts),
[Whisper.cpp server](https://github.com/ggml-org/whisper.cpp/tree/master/examples/server).

## Session prefill snapshots

`LLAMA_DISK_CACHE_MODELS` names the llama.cpp models, comma-separated, whose
prompt cache is kept per session. Set it to `my-model` and that model's chats
get per-session slot snapshots.
The llama.cpp server has to run with `--parallel 1`, one slot, because a
snapshot is always of slot 0, and with a `--slot-save-path` to write the
snapshots to, such as `/path/to/session-cache/`. A server that reports more than
one slot in its `/props` is left alone: no snapshots are taken, and chats run at
the same time as they would without the variable.
The portal serializes inference and save/restore operations for that single
model slot, saves after successful responses, and restores when changing sessions.
Filenames hash the model and session ID. Cache files persist on the llama host;
missing or incompatible files fall back to normal prompt evaluation. These files
contain model state derived from conversation content and the directory is mode 700.
Disk use grows with saved sessions; removing old `.bin` snapshots only loses the
acceleration, not conversation history.

The permanent audio rule and persisted user-message markers keep the prefix
stable across voice/text switches. A newly installed rule requires one initial
prefill; subsequent turns can reuse it. No custom chat template is needed.

## Automatic setup from Settings

On a Linux NVIDIA host with Docker and NVIDIA Container Toolkit, open
**Settings → Add-ons → Voice → Install voice**. Pithagoras creates a separate
`pithagoras-voice` container and displays the setup log. Under **Speech engines**
you choose the speech synthesis engine (Breeze, Chatterbox or Kokoro) and the speech
recognition model (Whisper base or small, Qwen3-ASR 0.6B or 1.7B), or leave the
choice to the installer, which reads the GPU and its free memory and picks the
best combination that fits; [Docker add-ons](/guide/add-ons#engines-devices-and-memory)
lists what each needs and what happens when a choice does not fit. The default is
the original combination: Breeze with Whisper base.

For that default, it builds pinned audio.cpp and Whisper.cpp revisions, downloads
the full-precision Breeze-TTS-2 GGUF package, quantizes that package locally to
Q8_0, and downloads multilingual Whisper base. The GGUF source is the audio.cpp
repack of BreezeBlue/Breeze-TTS-2. No Python TTS runtime is installed. Whisper runs
on CPU; Breeze uses the GPU. Chatterbox and Qwen3-ASR are downloaded as Q8_0 GGUF
files from a pinned revision of the same repository and verified by checksum;
audio.cpp serves them from one process, with Qwen3-ASR's recognition on
`/v1/audio/transcriptions` of the same port, and no Whisper then runs.

Allow about 30 GB free disk space during setup. First installation can take several
minutes or longer depending on compilation and download speeds. Source downloads
resume, completed models and builds are reused, and the quantized model is moved
into place only after the converter inspects it successfully. The full-precision
file is then removed. Models persist in `pithagoras_voice-models`. Choosing other
engines later recreates the container and builds or downloads only what is new;
an installation made before the choice existed is the default combination, and
keeps working unchanged.

**Without a GPU** the installer puts everything on the CPU, in the small base image rather than the
CUDA one: Kokoro for speech, which takes about a quarter of a second for each second of speech on 8
threads, and Whisper, or Qwen3-ASR in a CPU-only audio.cpp build, for recognition. A host with too
little memory or too few threads for Kokoro gets recognition alone: dictation works, and the
voice-conversation control is not offered, because it speaks its replies. Breeze and Chatterbox
take several seconds of CPU time per second of speech and need a GPU. On a GPU host Kokoro and
Qwen3-ASR can be put on the CPU too, to spare the card. See
[Docker add-ons](/guide/add-ons#no-gpu).

Once the health checks of what was installed pass, Settings connects the installed services automatically.
Existing voice choices and saved voices are preserved. A reference clone
still needs a voice with a recording, as described above.

**Stop · release VRAM** stops both managed services without deleting models.
**Start voice** reuses the installed files. The managed container does not start
automatically after a host reboot; start it in Settings when needed. Setup failures
remain visible in the log and can be retried. Whisper listens on loopback port 8188
and Breeze on 7862, inside the portal's own network namespace: the voice container
joins the portal container's network (or the host's, for a native portal) and
publishes no host ports. These differ from a manually managed setup, the Compose overlay or a native unit,
which the installer does not modify. Stop such TTS services before using the managed
service to avoid loading two copies into VRAM. A managed container made by an
earlier version is migrated automatically; see
[Docker add-ons](/guide/add-ons#service-addresses-and-health-checks).

### Lazy GPU loading

**Lazy load** is on by default for the managed service. Starting the service leaves
Breeze on disk. Activating a voice session requests a model connection before the
microphone begins listening. Each tab refreshes its connection every 25 seconds;
ending the last active session unloads the model. Mute retains the connection,
since the session can still speak. Disconnected tabs expire after 75 seconds.
Load/unload requests are serialized and the native runtime waits for active
inference before unloading. A 90-second native idle timeout also releases the
model if the portal disappears.

Turn Lazy load off and save to keep Breeze warm while the portal and managed service run.
Whisper remains on CPU in either mode. The first connection in lazy mode incurs
model-loading latency; subsequent speech in the same active session reuses the
loaded model. These lifecycle controls apply to the managed container; custom
endpoints keep their own loading policy.


### Add your own voices

Open **Settings → Add-ons → Voice → Add voice**. Give the voice a name and choose
**Reference clone** or **Designed voice**. For a clone, upload a clear recording
of 1–30 seconds (up to 20 MB) and enter the exact words spoken. The browser converts
supported audio files to mono 16 kHz WAV. For a designed voice, describe the voice
instead. Each preset stores its own voice description.

Click **Save new voice**, then **Save voice settings** to activate the selected
voice. Saved voices appear in the Speaking voice dropdown. Clones include a
reference preview and transcript.

To change a saved voice's description later, select the voice, edit **Voice
description** and click **Save description**. The change is stored at once and
applies from the next phrase spoken, for a clone as well as a designed voice;
the recording and its transcript stay as they are. **Save voice settings** also
saves a description you edited and have not saved yet, and stops with an error,
without saving the other settings, if the description cannot be saved. Breeze is
the engine that reads the description. Chatterbox takes no description: it speaks
from the recording alone, so editing the description of a voice used with
Chatterbox changes nothing you can hear.

### Kokoro's voices

Kokoro cannot clone a recording or follow a description: it speaks with one of
the voices that come with it. With **Kokoro audio.cpp** as the speech runtime,
**Speaking voice** lists those voices instead of your library, each with its
language: American and British English, Spanish, French, Hindi, Italian,
Brazilian Portuguese and Mandarin Chinese. Kokoro reads the text in the language
of the voice, whatever the input language is set to. Its Japanese voices are
not offered: they need a dictionary the packaged model does not carry.
**Speaking speed** (slower, normal, faster) takes the place of **Speech
generation**.

Your library voice stays selected for the other engines, so switching the
runtime back brings it back. An agent can have a Kokoro voice of its own, from
the voice menu under its avatar; with another engine it speaks as in the voice
settings, and a library voice given to an agent is not used while Kokoro speaks.

Kokoro has no streaming mode in audio.cpp: each phrase comes back as one WAV, as
with Chatterbox, which Kokoro's size makes quick.

Delete voice removes the preset and falls back
to the default designed voice if it was active; an [agent](/guide/agents#its-voice) that had it speaks as the voice settings say again. Presets and recordings persist in
the portal's SQLite database; they are shared across sessions and require portal
authentication to access. Adding a voice does not retrain or download another model.
