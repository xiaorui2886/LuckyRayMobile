// A/B modifies only generated QA CSS. No checkout/source/browser flags change.
export function withoutToolbarOverscroll(css) {
  const rules=[...css.matchAll(/\.st-reader-tools\.st-editor-tools\s*\{[^}]*\}/g)];
  if(rules.length!==1)throw new Error('Expected exactly one editor toolbar CSS rule');
  const rule=rules[0][0];
  const declarations=[...rule.matchAll(/overscroll-behavior-x\s*:\s*contain\s*;?/g)];
  if(declarations.length!==1)throw new Error('Expected exactly one toolbar containment declaration');
  return css.replace(rule,rule.replace(declarations[0][0],''));
}
