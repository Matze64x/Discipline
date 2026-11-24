/**
 * Whether the device is used by touch rather than mouse and keyboard (a phone, a tablet): then
 * hints speak of tapping, and keyboard-only help is left out. Read once at start.
 */
export const touchFirst = typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches;
