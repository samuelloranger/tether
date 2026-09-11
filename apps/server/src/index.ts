// Dev entry: `bun dev:server` / `bun run src/index.ts`. The compiled
// binary uses main.ts instead; both call serve().
import { serve } from './serve';

await serve();
