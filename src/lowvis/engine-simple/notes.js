// What engine-simple cannot do, said once to the motion writer and stored in every clip (moved unchanged from engine.js).
export const NOTES = [
	"simple engine: no collision between bodies, limbs and props; contacts are where the spec puts them",
	"no fingers and no wrist detail: a hand is one box aligned with the forearm",
	"with the feet side by side a kneel's two knees come to the floor a few frames apart at most, and a sit's or a stand's two knees fold a few degrees apart, whatever lag says (the pelvis rolls 8.5 degrees at most); lying down is one blended roll, not a hand-supported descent",
	"reach assist bends the hips and knees toward low targets only; it does not step toward a far target",
	"a slow walk beat arrives early and stands; it is not stretched to fill the beat",
	"a run's steps, pelvis, chest and arms follow captured runners of its speed, about 2 to 5 m/s for a body of scale 1 (slower or faster is not captured); its start and its stop (where it has one) take half a second, as a walk's do",
	"a held prop has no weight and pulls no body: it goes where the hands that hold it put it",
	"a pushed prop slides with the hands; friction and weight are in the gait's timing, not simulated",
	"a keyed prop (the falling trunk, the pins) follows its keys; nothing checks that it misses the figure, and the frame a rolling prop hits something is written in the spec by hand",
	"a released prop keeps the hand's velocity exactly, so a swing that is not straight sends it off line",
	"the side a knee bends to is the engine's: no spec word sets it; an elbow's too unless pose elbowL / elbowR gives it a target",
];
