// Transport double for route ownership/gate tests. These tests control editor
// job acknowledgements, not a sidecar installer. Real bus/rig integration lives
// in test/bus/verify-motion-route-{undo,cancel} and replacement-flow.
export function scriptedEditorJobs(base, script) {
  const jobs = new Map();
  const withIndex = context => ({ ...context, actionIndex: [
    ...(context.actionIndex ?? []).filter(row => !['motion.generate', 'motion.generateAllBlocks'].includes(row.id)),
    ...['motion.generate', 'motion.generateAllBlocks'].map(id => ({ id, label: id, timeoutMs: 300000 })),
  ] });
  const context = async () => withIndex(await script.readContext());
  return { ...base, async command(name, payload, ...rest) {
    if (name === 'read_studio_context') return context();
    if (name === 'inspect_studio') {
      const result = await base.command(name, payload, ...rest);
      return { ...result, context: result?.context ? withIndex(result.context) : await context() };
    }
    if (name !== 'run_action') return base.command(name, payload, ...rest);
    const { action, args } = payload.args;
    if (action === 'motion.generate') {
      const admitted = script.admit(payload);
      jobs.set(admitted.jobId, { commandId: payload.commandId, host: payload.host });
      return { ok: true, status: 'started', action, jobId: admitted.jobId, commandId: payload.commandId };
    }
    if (action === 'job.await') {
      const job = jobs.get(args.jobId);
      const result = await script.start(args.jobId);
      return { ...job, action: 'motion.generate', jobId: args.jobId, ...result,
        ...(result?.ok ? { status: 'completed', revision: { before: payload.expectedRevision, after: payload.expectedRevision } } : {}) };
    }
    if (action === 'job.cancel') return script.stop(args.jobId);
    return base.command(name, payload, ...rest);
  } };
}
