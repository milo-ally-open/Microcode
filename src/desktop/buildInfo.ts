/** Replaced by the release packager; source and development runs remain clearly marked. */
declare const __MICROCODE_DESKTOP_VERSION__: string | undefined

export const DESKTOP_APP_VERSION = typeof __MICROCODE_DESKTOP_VERSION__ === 'string'
  ? __MICROCODE_DESKTOP_VERSION__
  : 'dev'
