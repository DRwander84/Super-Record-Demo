// Audio output settings shared by the renderer (settings UI) and the Electron
// main process (FFmpeg arguments). Keeping the container/codec rules in one
// place guarantees that the UI never offers a combination FFmpeg would reject.

export type AudioCodec = 'aac' | 'opus' | 'mp3' | 'flac' | 'pcm'
export type AudioContainer = 'mp4' | 'mkv' | 'mov' | 'webm'
export type AudioChannels = 'stereo' | 'mono'

export type AudioSettings = {
  codec: AudioCodec
  /** Target bitrate in kbit/s. Ignored by lossless codecs. */
  bitrateKbps: number
  channels: AudioChannels
  /** Output sample rate in Hz. */
  sampleRate: number
}

export const AUDIO_CODEC_LABELS: Record<AudioCodec, string> = {
  aac: 'AAC',
  opus: 'Opus',
  mp3: 'MP3',
  flac: 'FLAC (Lossless)',
  pcm: 'PCM 16-bit (Lossless)',
}

/** FFmpeg encoder behind every codec choice. */
export const AUDIO_ENCODER_NAMES: Record<AudioCodec, string> = {
  aac: 'aac',
  opus: 'libopus',
  mp3: 'libmp3lame',
  flac: 'flac',
  pcm: 'pcm_s16le',
}

/** Codecs that can be stored in each container according to its specification. */
export const CONTAINER_AUDIO_CODECS: Record<AudioContainer, AudioCodec[]> = {
  mp4: ['aac', 'mp3', 'opus'],
  mov: ['aac', 'mp3', 'pcm'],
  mkv: ['aac', 'opus', 'mp3', 'flac', 'pcm'],
  webm: ['opus'],
}

export const AUDIO_BITRATES_KBPS = [64, 96, 128, 160, 192, 256, 320]
export const AUDIO_SAMPLE_RATES = [22050, 44100, 48000]

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  codec: 'aac',
  bitrateKbps: 192,
  channels: 'stereo',
  sampleRate: 48000,
}

export function isLosslessAudioCodec(codec: AudioCodec): boolean {
  return codec === 'flac' || codec === 'pcm'
}

/** Opus only exists at 8, 12, 16, 24 and 48 kHz; 48 kHz is the standard. */
export function allowedSampleRates(codec: AudioCodec): number[] {
  return codec === 'opus' ? [48000] : AUDIO_SAMPLE_RATES
}

export function isAudioContainer(value: unknown): value is AudioContainer {
  return value === 'mp4' || value === 'mkv' || value === 'mov' || value === 'webm'
}

export function isAudioCodec(value: unknown): value is AudioCodec {
  return (
    value === 'aac' || value === 'opus' || value === 'mp3' ||
    value === 'flac' || value === 'pcm'
  )
}

/**
 * Turns whatever was saved or received into a valid combination for the
 * container. Invalid values fall back to the closest safe choice.
 */
export function normalizeAudioSettings(
  raw: object | null | undefined,
  container: AudioContainer,
): AudioSettings {
  const input = (raw ?? {}) as Record<string, unknown>
  const allowed = CONTAINER_AUDIO_CODECS[container]
  const requested = isAudioCodec(input.codec) ? input.codec : DEFAULT_AUDIO_SETTINGS.codec
  const codec = allowed.includes(requested) ? requested : allowed[0]

  const bitrate = Number(input.bitrateKbps)
  const bitrateKbps = AUDIO_BITRATES_KBPS.includes(bitrate)
    ? bitrate
    : DEFAULT_AUDIO_SETTINGS.bitrateKbps

  const channels: AudioChannels = input.channels === 'mono' ? 'mono' : 'stereo'

  const rates = allowedSampleRates(codec)
  const rate = Number(input.sampleRate)
  const sampleRate = rates.includes(rate)
    ? rate
    : rates.includes(DEFAULT_AUDIO_SETTINGS.sampleRate)
      ? DEFAULT_AUDIO_SETTINGS.sampleRate
      : rates[0]

  return { codec, bitrateKbps, channels, sampleRate }
}

/** FFmpeg output options that encode the audio stream. */
export function buildAudioEncodeArgs(settings: AudioSettings): string[] {
  const args: string[] = []

  switch (settings.codec) {
    case 'aac':
      args.push('-c:a', 'aac', '-b:a', `${settings.bitrateKbps}k`)
      break
    case 'opus':
      args.push(
        '-c:a', 'libopus', '-b:a', `${settings.bitrateKbps}k`,
        '-vbr', 'on', '-application', 'audio',
      )
      break
    case 'mp3':
      args.push('-c:a', 'libmp3lame', '-b:a', `${settings.bitrateKbps}k`)
      break
    case 'flac':
      args.push('-c:a', 'flac', '-sample_fmt', 's16')
      break
    case 'pcm':
      args.push('-c:a', 'pcm_s16le')
      break
  }

  args.push(
    '-ar', String(settings.sampleRate),
    '-ac', settings.channels === 'mono' ? '1' : '2',
  )
  return args
}
