// M1 experiment, not imported by production. No writes, defaults or authorization.
import { object, requireThat } from '../../../scripts/contracts.mjs';

const fields = ['resource_mode', 'reserve_frontier', 'auto_escalate_reasoning', 'auto_escalate_model'];

function layer(value, name, complete) {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), name);
  const present = fields.filter(key => Object.hasOwn(value, key));
  object(value, ['contract', 'version', ...(complete ? fields : present)], name);
  requireThat(value.contract === 'ResourcePolicyV1' && value.version === 1, `${name}.version`);
  for (const key of present) {
    requireThat(key === 'resource_mode'
      ? ['economy', 'balanced', 'quality_first'].includes(value[key])
      : typeof value[key] === 'boolean', `${name}.${key}`);
  }
}

/** Missing layer = null; malformed existing layer is an error, never a fallback. */
export function resolvePolicy(baseline, userDefault = null, projectOverride = null) {
  const values = {}, sources = {};
  for (const [name, value] of [['baseline', baseline], ['user-default', userDefault], ['project-override', projectOverride]]) {
    if (name !== 'baseline' && value === null) continue;
    layer(value, name, name === 'baseline');
    for (const key of fields) {
      if (Object.hasOwn(value, key)) {
        values[key] = value[key];
        sources[key] = name;
      }
    }
  }
  return { values, sources };
}
