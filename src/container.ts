import { asClass, asFunction, asValue, type AwilixContainer } from 'awilix';
import { env, type Env } from '@/config/env';
import type { PrismaClient } from '@/generated/prisma/client';
import { createPrismaClient } from '@/infrastructure/persistence/prisma-client';
import type { UserRepository } from '@/domain/user/user-repository';
import type { IdGenerator } from '@/application/shared/ports/id-generator';
import type { PasswordHasher } from '@/application/shared/ports/password-hasher';
import { CreateUser } from '@/application/user/create-user';
import { GetUser } from '@/application/user/get-user';
import { ListUsers } from '@/application/user/list-users';
import { EditUser } from '@/application/user/edit-user';
import { DeleteUser } from '@/application/user/delete-user';
import { PrismaUserRepository } from '@/infrastructure/persistence/prisma-user-repository';
import { UuidIdGenerator } from '@/infrastructure/identity/uuid-id-generator';
import { Argon2PasswordHasher } from '@/infrastructure/security/argon2-password-hasher';

declare module '@fastify/awilix' {
  interface Cradle {
    env: Env;
    prisma: PrismaClient;

    // ports
    userRepository: UserRepository;
    idGenerator: IdGenerator;
    passwordHasher: PasswordHasher;

    // use cases
    listUsers: ListUsers;
    getUser: GetUser;
    createUser: CreateUser;
    editUser: EditUser;
    deleteUser: DeleteUser;
  }
}

export function registerDependencies(container: AwilixContainer): void {
  container.register({
    env: asValue(env),
    prisma: asFunction(createPrismaClient)
      .singleton()
      .disposer((client) => client.$disconnect()),

    userRepository: asClass(PrismaUserRepository).singleton(),
    idGenerator: asClass(UuidIdGenerator).singleton(),
    passwordHasher: asClass(Argon2PasswordHasher).singleton(),

    listUsers: asClass(ListUsers).singleton(),
    getUser: asClass(GetUser).singleton(),
    createUser: asClass(CreateUser).singleton(),
    editUser: asClass(EditUser).singleton(),
    deleteUser: asClass(DeleteUser).singleton(),
  });
}
