// Where a chunk of bytes bound for the PTY came from. The source decides
// whether the armed Ctrl modifier applies, so it is part of the contract of
// sending input rather than a detail of any one call site.
//
//   typed   a character the user just entered (renderer keyboard)
//   key     a discrete key press (utility bar, D-pad, desktop key mapper)
//   paste   a block inserted wholesale (clipboard, snippet, uploaded file path)
//   program bytes the app generated itself (mouse reports, control sequences)
export type PtyInputSource = 'typed' | 'key' | 'paste' | 'program';
