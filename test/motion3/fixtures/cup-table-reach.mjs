// Box QA 2026-11-04, track A message 5 ("the man on the right picks the cup up with his right hand"): a 4 cm cup in the
// middle of a 1 m table, an X Bot at its +x edge. RECORDS are the session's object records (metres, base pivots; every
// primitive is 1 m at scale 1); CUP_SPEC is the take the agent installed (spec-09152add0d49: its first compile and four
// base + patch rounds, applied). The shoulder is 0.71 m from the grip point at the grab and the arm 0.69 m long, so the
// hand stops at the rim and the fingers close on air (SUPPORT, FINGER_GAP).

// [id, name, renderer, parent, x, y, z, scaleX, scaleY, scaleZ]
const RECORDS = [["cylinder","Leg FL","cylinder","empty",-0.44,0,0.29,0.05,0.715,0.05],["cylinder-3","Leg BL","cylinder","empty",-0.44,0,-0.29,0.05,0.715,0.05],["empty","Table","empty",null,0,0,0,1,1,1],["cube","TableTop","cube","empty",0,0.71,0,1,0.04,0.7],["cylinder-5","Cup","cylinder",null,0,0.75,0,0.08,0.1,0.08],["cylinder-2","Leg FR","cylinder","empty",0.44,0,0.29,0.05,0.715,0.05],["cylinder-4","Leg BR","cylinder","empty",0.44,0,-0.29,0.05,0.715,0.05]];

export const objects = (cupDx = 0) => RECORDS.map(([id, name, renderer, parent, x, y, z, scaleX, scaleY, scaleZ]) => ({
	id, name, renderer, ...(parent ? { parent } : {}), x: id === "cylinder-5" ? x + cupDx : x, y, z, rot: 0, rotX: 0, rotZ: 0, scaleX, scaleY, scaleZ,
	footprint: { width: 1, depth: 1 }, height: 1,
}));

export const CUP_SPEC = {"schema":"cozyclay.motion-spec.v1","fps":24,"frames":180,"label":"pick up cup R","use":[{"skill":"standIdle","f0":0,"args":{"at":[1,0],"heading":-90}},{"skill":"walkTo","f0":4,"args":{"to":[0.68,0.03],"steps":2,"heading":-90}},{"skill":"reachGrip","f0":80,"args":{"anchor":"cup","side":"r","reach":22,"hold":76,"release":2,"fingers":"grip","define":{"kind":"object","object":"cylinder-5","grasp":"power"}}}],"objects":{"cylinder-5":{"prop":"cupGrip","grab":102,"grasp":"power","keys":[{"f":104,"pos":[0,0.76,0]},{"f":134,"pos":[0.38,1.12,-0.16],"aim":[0,1,0]},{"f":178,"pos":[0.38,1.12,-0.16],"aim":[0,1,0]}]}},"goals":[{"name":"hand on cup","near":["joint:RightHandMiddle2","object:cylinder-5"],"tol":0.03,"at":[98,106],"mode":"any"},{"name":"cup still before grab","still":"object:cylinder-5","at":[0,106],"before":"hand on cup"},{"name":"cup lifted","moved":"object:cylinder-5","by":0.3,"at":[125,179],"after":"hand on cup","mode":"any"},{"name":"cup with hand","near":["joint:RightHandMiddle2","object:cylinder-5"],"tol":0.06,"at":[110,179]}],"keys":[{"f":82,"set":{"root":[0.69,1.02,0.03],"spine_pitch":0}},{"f":100,"set":{"root":[0.71,0.88,0.02],"spine_pitch":64,"head_pitch":10}},{"f":106,"set":{"root":[0.71,0.88,0.02],"spine_pitch":62}},{"f":134,"set":{"root":[0.68,1.02,0.03],"spine_pitch":5,"head_pitch":5}}]};
