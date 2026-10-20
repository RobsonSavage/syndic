// Loaded by `npm test` (node --import) so no test reads the developer's own ~/.syndic/defaults.json.
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SYNDIC_DEFAULTS = join(tmpdir(), 'syndic-no-defaults.json');
