/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ─── Clean-architecture layer boundaries (the Dependency Rule: dependencies point inward) ───
    {
      name: 'domain-stays-pure',
      comment:
        'The domain is the innermost layer. It must not depend on application, infrastructure, ' +
        'presentation, or configuration — nothing points outward from the core.',
      severity: 'error',
      from: { path: '^src/domain/' },
      to: { path: '^src/(application|infrastructure|presentation|config)/' },
    },
    {
      name: 'application-depends-inward-only',
      comment:
        'The application layer orchestrates the domain through ports (interfaces). It must never ' +
        'import concrete infrastructure or the presentation layer. Configuration (src/config) is ' +
        'deliberately allowed — an ambient concretion read at the edges.',
      severity: 'error',
      from: { path: '^src/application/' },
      to: { path: '^src/(infrastructure|presentation)/' },
    },
    {
      name: 'infrastructure-stays-out-of-presentation',
      comment:
        'Infrastructure adapters implement application ports. They must not depend on the ' +
        'HTTP/presentation layer.',
      severity: 'error',
      from: { path: '^src/infrastructure/' },
      to: { path: '^src/presentation/' },
    },
    {
      name: 'presentation-stays-out-of-infrastructure',
      comment:
        'Presentation code (routes, guards, plugins, schemas) receives its collaborators from the ' +
        'DI container; it must not import concrete infrastructure. The composition root that wires ' +
        'infrastructure is src/container.ts, which sits outside every layer and needs no exemption.',
      severity: 'error',
      from: { path: '^src/presentation/' },
      to: { path: '^src/infrastructure/' },
    },
    {
      name: 'shared-kernel-stays-pure',
      comment:
        'The shared kernel (errors, pagination, cross-cutting primitives) sits beneath every layer ' +
        'alongside the domain. Like the domain, it must depend on no layer and no configuration.',
      severity: 'error',
      from: { path: '^src/shared/' },
      to: { path: '^src/(domain|application|infrastructure|presentation|config)/' },
    },
    {
      name: 'config-stays-leaf',
      comment:
        'Configuration is an ambient concretion: outer layers may read it, but it must import no ' +
        'layer of its own — it is a leaf, depending only on the environment and npm packages.',
      severity: 'error',
      from: { path: '^src/config/' },
      to: { path: '^src/(domain|shared|application|infrastructure|presentation)/' },
    },

    // ─── General hygiene ───
    {
      name: 'no-circular',
      comment:
        'Circular dependencies make modules impossible to reason about in isolation and usually ' +
        'signal a missing abstraction. With tsPreCompilationDeps this also catches type-only ' +
        'cycles (harmless at runtime under verbatimModuleSyntax, but still a design smell).',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      comment:
        'This import cannot be resolved — a typo, a deleted file, a missing dependency, or a ' +
        'misconfigured tsconfig/alias setup.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-orphans',
      comment:
        'Orphan modules (imported by nothing and importing nothing internal) are usually dead code ' +
        'left behind by a refactor.',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: ['(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$', '\\.d\\.ts$', '(^|/)tsconfig\\.json$'],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    // Follow `import type` edges — a type-only import across a boundary is still a violation.
    tsPreCompilationDeps: true,
    exclude: {
      path: ['node_modules', '\\.(test|spec)\\.ts$', '(^|/)generated(/|$)'],
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
    reporterOptions: {
      mermaid: { minify: false },
    },
  },
};
