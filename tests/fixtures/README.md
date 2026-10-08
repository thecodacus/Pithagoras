# Speech fixtures

`jfk.wav` is the sample bundled with
[Whisper.cpp](https://github.com/ggml-org/whisper.cpp/blob/master/samples/jfk.wav):
an excerpt from President John F. Kennedy's inaugural address. Browser tests
feed it into a synthetic MediaStream; they never use the physical microphone.

`smart-turn/jfk.json` is what Smart Turn's reference preprocessing and model make
of four pieces of it: a sample of the model's input features, their statistics,
and the probability that the turn is complete. `smart-turn/reference.py` writes
it; `tests/smart-turn.test.mts` compares the browser's own computation with it.
