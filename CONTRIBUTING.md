# Contributing

Thanks for taking the time to contribute.

## Getting set up

See [Quick start](./README.md#quick-start) in the README. The step people miss is
`npm run db:generate` — the Prisma client is generated into an ignored directory, so a fresh clone
does not typecheck until you run it.

## Before you open a pull request

```bash
npm run audit
```

That single command runs everything CI runs: lockfile verification, dependency audit, formatting,
lint, typecheck, unit tests with coverage, architecture rules, and the integration suite. If it
passes locally it will pass in CI.

If the integration suite hangs, run it with a credentials-store-free Docker config:

```bash
DOCKER_CONFIG=$(mktemp -d) npm run test:integration
```

## What the build enforces

Four gates fail the build, and none of them are negotiable in review:

- **Architecture.** `npm run arch` enforces the layer boundaries in `.dependency-cruiser.cjs`. The
  domain imports nothing; the application depends on the domain and its own ports; concretions bind
  to ports only in `src/container.ts`. A new dependency that crosses a boundary fails here rather
  than in review.
- **Coverage.** The domain and application layers are held at 100%. A new use case without tests
  fails the build.
- **Types.** `tsc --noEmit` under a strict configuration, including `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`.
- **Format and lint.** Prettier and ESLint, applied automatically to staged files by the pre-commit
  hook.

## Adding a feature

Follow [Adding a feature](./README.md#adding-a-feature). The user slice is the reference: copy its
shape rather than inventing a new one. `docs/features/user-crud.md` explains it layer by layer.

Enforce permissions inside the use case, not at the route. The HTTP layer maps transport to an
`Actor` and nothing more.

## Commits

The history uses [Conventional Commits](https://www.conventionalcommits.org/) with a scope:

```
feat(auth): add self-service password reset
fix(compose): make the stack usable and ordered on a first run
refactor(config): derive every service name from a single APP_NAME
```

Write the body to explain **why** the change is needed and what would break without it. Rationale
belongs in the commit message, not in code comments — the codebase deliberately carries almost none,
relying on names and types instead.

## Documentation

Feature documentation lives in `docs/features/` and is indexed by `docs/README.md`. If you change
behaviour a document describes, update it in the same pull request.

## Reporting bugs and requesting features

Open an issue using one of the templates. For anything security related, follow
[SECURITY.md](./SECURITY.md) instead — do not open a public issue.
