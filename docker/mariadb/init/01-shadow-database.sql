-- `prisma migrate dev` provisions a throwaway shadow database to diff the schema
-- against, so the application user needs create rights on that name pattern.
-- Without this, a first run of `npm run db:migrate` fails with P3014.
GRANT ALL PRIVILEGES ON `prisma_migrate_shadow_db%`.* TO 'app'@'%';
FLUSH PRIVILEGES;
