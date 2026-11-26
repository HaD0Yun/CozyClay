// What the legs of a person do in a flight that leaves from a stride (one foot pushes, the other swings), from five
// captured running jumps (2 to 3 m/s, flights of 11 to 13 frames at 24 a second), as the mean of the five. Each row is
// an ankle from its own hip joint, over the leg's length (hip joint to the floor), along the way of the flight:
// [outward (toward the foot's own side), up, ahead, the foot's pitch in radians (toes down +) over its standing pitch],
// at even shares of a stretch. Numbers only; air-legs.js reads them.

/** The lead foot from the frame it leaves the ground before the take-off to the last frame on the ground (A). */
export const LEAD_BEFORE = [[-0.084, -0.674, -0.539, 0.736], [-0.074, -0.543, -0.539, 1.323], [-0.012, -0.396, -0.356, 1.497], [0.081, -0.376, -0.131, 1.099], [0.147, -0.414, 0.092, 0.466]];
/** Each foot from A to the first frame on the ground again (B): the push foot folds behind and comes forward, the lead
 *  knee drives ahead and the foot reaches down before B. */
export const PUSH_AIR = [[-0.092, -0.898, -0.054, 0.311], [-0.137, -0.828, -0.146, 0.89], [-0.162, -0.591, -0.199, 1.247], [-0.138, -0.338, -0.115, 1.244], [-0.117, -0.237, 0.008, 0.832], [-0.099, -0.299, 0.135, 0.554], [-0.052, -0.428, 0.24, 0.318], [0.022, -0.566, 0.308, 0.191], [0.071, -0.639, 0.327, 0.048]];
export const LEAD_AIR = [[0.147, -0.414, 0.092, 0.466], [0.171, -0.348, 0.235, 0.046], [0.157, -0.297, 0.308, -0.137], [0.136, -0.318, 0.373, -0.159], [0.124, -0.396, 0.407, -0.101], [0.119, -0.5, 0.384, 0.012], [0.112, -0.598, 0.326, 0.123], [0.098, -0.675, 0.25, 0.236], [0.077, -0.73, 0.172, 0.104]];
/** The foot that comes down second, from B to the frame it touches down (4 to 6 frames after B in the takes; the lead
 *  foot came down first in three of the five). */
export const SECOND_DOWN = [[0.146, -0.469, 0.414, -0.241], [0.133, -0.533, 0.529, -0.426], [0.075, -0.623, 0.595, -0.566], [0.02, -0.714, 0.535, -0.51], [-0.005, -0.769, 0.42, -0.235]];
/** The takes at their quickest, in frames at 24 a second: the shortest of the five flights, and the fewest frames a lead
 *  foot left the ground before the push foot did. */
export const FLIGHT = 11, LEAD = 4;
