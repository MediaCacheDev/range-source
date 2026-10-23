// The ready-made worker, `range-source-sw.js`: serve it from your site and register it with
// registerRangeSourceWorker('/range-source-sw.js').
import { installRangeSourceWorker, type RangeSourceWorkerScope } from './worker';

installRangeSourceWorker(self as unknown as RangeSourceWorkerScope);
