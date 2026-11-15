// The Harness panel's paths on the t3 host (ADR-0026), and the Change page's under them (ADR-0035, plan D10): one place,
// so the panel's routes, its page, the Change page, its script and the Settings server's links cannot drift apart.

/** The panel, behind the `/_t3flare` Access application. */
export const HARNESS_PATH = "/_t3flare/harness";

/** The panel's Open changes list (an anchor on its page). */
export const OPEN_CHANGES_PATH = `${HARNESS_PATH}#changes`;

/** The Change pages: `<CHANGES_PATH>/<id>`. */
export const CHANGES_PATH = `${HARNESS_PATH}/changes`;

/** The Change pages' API: `GET` lists them, `POST <CHANGES_API_PATH>/<id>` answers one. */
export const CHANGES_API_PATH = `${HARNESS_PATH}/api/changes`;

/** One Change page's path. */
export const changePagePath = (id: string): string => `${CHANGES_PATH}/${encodeURIComponent(id)}`;
