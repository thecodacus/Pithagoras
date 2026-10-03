/**
 * The ways a llama.cpp server shows up.
 *
 * pi has a built-in provider called `llama.cpp`, and the `pi-llama-cpp` package
 * registers one per server as `llama-server=<url>`. Behind a llama-swap gateway
 * neither fits — pi-llama-cpp probes `/props?model=<id>` for every model, which
 * llama-swap answers by loading it — so the gateway is a plain provider in
 * models.json named `llama-swap`. It is still llama-server underneath.
 */
export function isLlama(provider: string | undefined): boolean {
  return provider === "llama.cpp" || provider === "llama-swap" || (provider?.startsWith("llama-server") ?? false);
}
