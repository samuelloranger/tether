import type { createStyles } from './styles';
import type { useTetherApp } from './useTetherApp';

export type TetherApp = ReturnType<typeof useTetherApp>;
export type TerminalStyles = ReturnType<typeof createStyles>;
