/**
 * UTF-8 in and out, the one place the package touches a host API. `TextEncoder` /
 * `TextDecoder` exist in Node, Cloudflare Workers and Hermes (React Native ≥ 0.74); an older
 * Hermes needs the app to polyfill them. The declarations below are module-scoped so the
 * package type-checks with `lib: ["ES2022"]` and no `dom` or `node` types, which is what
 * proves it runs in all three hosts.
 */

declare const TextEncoder: new () => { encode(input: string): Uint8Array }
declare const TextDecoder: new () => { decode(input: Uint8Array): string }

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function utf8Encode(text: string): Uint8Array {
  return encoder.encode(text)
}

export function utf8Decode(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}
