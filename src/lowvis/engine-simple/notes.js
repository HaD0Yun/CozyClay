// What engine-simple cannot do, said once to the motion writer and stored in every clip (moved unchanged from engine.js).
export const NOTES = [
	"simple engine: no collision between bodies, limbs and props; contacts are where the spec puts them",
	"no fingers and no wrist detail: a hand is one box aligned with the forearm",
	"kneel is symmetric (both knees together); lying down is one blended roll, not a hand-supported descent",
	"reach assist bends the hips and knees toward low targets only; it does not step toward a far target",
	"a slow walk beat arrives early and stands; it is not stretched to fill the beat",
	"run is a short-stride jog at the demo's speed (about 1.2 m/s)",
	"a prop in one hand is held by that hand only (no second hand on the grip); its long axis must be its z axis",
	"a pushed prop slides with the hands; friction and weight are in the gait's timing, not simulated",
	"a keyed prop (the falling trunk, the pins) follows its keys; nothing checks that it misses the figure, and the frame a rolling prop hits something is written in the spec by hand",
	"a released prop keeps the hand's velocity exactly, so a swing that is not straight sends it off line",
	"elbow and knee directions come from one fixed pole hint; there is no hands-on-hips or crossed-arms pose",
];
