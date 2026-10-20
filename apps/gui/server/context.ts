import type { AppDeps } from "./deps.js";
import type { JobRunner } from "./services/jobs.js";
import type { MeterPool } from "./services/meters.js";
import type { SessionViews } from "./services/sessions.js";

/** Everything a route module needs: the injected deps plus shared app-level services. */
export interface AppContext {
	deps: AppDeps;
	views: SessionViews;
	jobs: JobRunner;
	/** Level meters shared by the idle `/audio/levels` streams. */
	meters: MeterPool;
}
