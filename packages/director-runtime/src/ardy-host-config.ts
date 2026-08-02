// The single notion of "an ARDY host is configured", shared by every gate
// that decides whether the host-backed ARDY capabilities are OFFERED (the
// extension registration in apps/cclay-extension and the director session's
// constructed tool set).
//
// The wrapper (scripts/cclay-ardy-generate) is the authority on host
// configuration: it reads CCLAY_ARDY_HOST into HOST and refuses to run when
// the value is empty, printing "cclay-ardy-generate: CCLAY_ARDY_HOST is
// required ..." to stderr (its emptiness check is `[[ -n "$HOST" ]]`, so an
// unset variable and an empty variable are both "not configured", and any
// other value -- including whitespace -- is "configured"). The offer-time
// gate derives from the same variable with the same emptiness rule, so the
// gate and the wrapper cannot disagree about whether a host exists.
//
// This is deliberately NOT the runtime classification
// (isArdyHostUnavailableFailure / ARDY_HOST_UNAVAILABLE): a host that was
// configured but is unreachable at run time is a different, later failure
// that only the wrapper can observe.
export const ARDY_HOST_ENV_VAR = "CCLAY_ARDY_HOST";

export function isArdyHostConfigured(): boolean {
	const host = process.env[ARDY_HOST_ENV_VAR];
	return host !== undefined && host !== "";
}
