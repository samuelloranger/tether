export type MotionKind = 'feedback' | 'drawerEnter' | 'drawerExit' | 'modalEnter' | 'modalExit';

const DURATIONS: Record<MotionKind, number> = {
  feedback: 120,
  drawerEnter: 240,
  drawerExit: 160,
  modalEnter: 220,
  modalExit: 160,
};

export function motionSpec(kind: MotionKind, reduceMotion: boolean) {
  return { duration: reduceMotion ? 0 : DURATIONS[kind], useNativeDriver: true as const };
}
