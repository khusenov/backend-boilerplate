/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'production-does-not-import-test-code',
      comment:
        'Only test files may import the unit-test kit. Co-located *.test.ts files are ' +
        'excluded from the cruise, so this fires only on genuine production imports.',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^test/' },
    },
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

    {
      name: 'composition-root-is-not-importable',
      comment:
        'Top-level src/*.ts modules are composition roots: they sit outside every layer and are ' +
        'the only place allowed to see both application and infrastructure. Importing one from ' +
        'inside a layer launders a forbidden dependency past the layer rules — depend on a port ' +
        'instead. src/container.ts has its own rule below.',
      severity: 'error',
      from: { path: '^src/(domain|shared|application|infrastructure|presentation|config)/' },
      to: { path: '^src/[^/]+\\.ts$', pathNot: '^src/container\\.ts$' },
    },
    {
      name: 'container-is-imported-only-by-buildapp',
      comment:
        'The composition root wires every concretion, so importing it from inside a layer defeats ' +
        'every rule above at once. buildApp is the single sanctioned edge from a layer: it calls ' +
        'registerDependencies. Entry points under src/scripts/ are a sibling tier, not a layer, ' +
        'and are deliberately out of scope here.',
      severity: 'error',
      from: {
        path: '^src/(domain|shared|application|infrastructure|presentation|config)/',
        pathNot: '^src/presentation/http/app\\.ts$',
      },
      to: { path: '^src/container\\.ts$' },
    },
    {
      name: 'composition-modules-are-not-importable',
      comment:
        'src/composition/* files are slices of the composition root: like src/container.ts they see ' +
        'both application and infrastructure, so importing one from anywhere else defeats every ' +
        'layer rule at once, and reaching past registerDependencies skips the completeness check ' +
        'that makes the split safe. Only src/container.ts may import them, and they may import ' +
        'each other. Depend on a port instead.',
      severity: 'error',
      from: { path: '^src/', pathNot: ['^src/container\\.ts$', '^src/composition/'] },
      to: { path: '^src/composition/' },
    },
    {
      name: 'system-actor-is-entry-point-only',
      comment:
        'A SystemActor bypasses every permission check. Only process entry points may build ' +
        'one: top-level src/*.ts composition roots and src/scripts/**. Co-located *.test.ts ' +
        'files are exempt via options.exclude, and the integration harness under test/ is not ' +
        'crawled at all. A layer that mints its own SystemActor grants itself unlimited ' +
        'privilege — take an Actor as an argument instead.',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/(scripts/|[^/]+\\.ts$)' },
      to: { path: '^src/domain/authorization/system-actor\\.ts$' },
    },
    {
      name: 'user-actor-is-transport-mapper-only',
      comment:
        'createUserActor with SUPERADMIN_ROLE_KEY bypasses every permission check exactly as a ' +
        'SystemActor does, so its construction is restricted the same way. Only transport ' +
        'identity mappers build one; everything else takes an Actor as an argument. Type-only ' +
        'imports are exempt, which is what the 14 use cases need.',
      severity: 'error',
      from: {
        path: '^src/',
        pathNot: ['^src/(scripts/|[^/]+\\.ts$)', '^src/presentation/[^/]+/identity/'],
      },
      to: {
        path: '^src/domain/authorization/actor\\.ts$',
        dependencyTypesNot: ['type-only'],
      },
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
