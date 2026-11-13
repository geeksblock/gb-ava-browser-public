/**
 * Re-exports of the protocol parsers used by the surface tests, so a test that only needs two
 * shapes does not import twenty.
 */
export { parseClickParams, parseSessionStartParams, parseQueryParams as parseTabsQueryShaped } from "@gb-ava/protocol";
