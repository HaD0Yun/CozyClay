/**
 * One authored frame of the rail dolly: a forward-only critically damped
 * spring toward `target`. A stiff response at the frame rate (omega * dt
 * past 0.5) is split into equal substeps, because one semi-implicit step that
 * large overshoots: it lurches several times the asked speed in one frame and
 * then stalls. With omega * dt at or under 0.5 it is the single step it always
 * was. No cap (null or Infinity) lets the rail's schedule set the speed; a cap
 * that is not a number stops the dolly.
 */
export function cappedSpringStep(pos, vel, target, omega, dt, maxSpeed) {
	const cap = Math.max(0, maxSpeed ?? Infinity) || 0;
	const steps = Math.max(1, Math.ceil((omega * dt) / 0.5));
	const h = dt / steps;
	for (let i = 0; i < steps; i += 1) {
		const acc = omega * omega * (target - pos) - 2 * omega * vel;
		// Rail targets never move backward; discard incompatible spring velocity
		// before integration so the authored arc remains a forward-only invariant.
		vel = Math.max(0, Math.min(vel + acc * h, cap));
		pos += vel * h;
	}
	return [pos, vel];
}
