import assert from 'node:assert/strict';
import { stageFixture } from './stage-fixture.mjs';
function elements(tree) {
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...[tree.props?.children].flat(Infinity).flatMap(elements)];
}
const f = stageFixture();
try {
  const tree = f.panel('EnvironmentPanel', { ...f.stage, selectedHierarchyId: 'environment' });
  const input = elements(tree).find(node => node.type === 'input' && node.props.type === 'text');
  const before = structuredClone(f.stage.read());
  for (const value of ['R', 'Ro', 'Room']) input.props.onChange({ target: { value } });
  assert.equal(f.stage.read().environment, 'Room');
  assert.equal(f.stage.documentStore.depths().past, 0, 'typing stays in a run.begin transaction until blur');
  input.props.onBlur();
  assert.equal(f.stage.documentStore.depths().past, 1, 'one typing session is one undo entry');
  f.actual.undoScene();
  assert.deepEqual(f.stage.read(), before);
  const light = f.panel('LightPanel', { ...f.stage, keyLightSelected: true });
  const slider = elements(light).find(node => node.props?.max === 4);
  for (const value of [1.5, 2, 2.5]) slider.props.onChange(value);
  assert.equal(f.stage.documentStore.depths().past, 0, 'light preview is not separate entries');
  elements(light).find(node => node.props?.onPointerUp).props.onPointerUp();
  assert.equal(f.stage.documentStore.depths().past, 1);
  console.log('PASS actual stage panels use begin/update/commit: one typing session and one slider gesture');
} finally { f.dispose(); }
