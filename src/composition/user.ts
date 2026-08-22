import { asClass } from 'awilix';
import { CreateUser } from '@/application/user/create-user';
import { DeleteUser } from '@/application/user/delete-user';
import { EditUser } from '@/application/user/edit-user';
import { GetUser } from '@/application/user/get-user';
import { ListUsers } from '@/application/user/list-users';
import type { RegistrationMap } from '@/composition/registration-map';

declare module '@fastify/awilix' {
  interface Cradle {
    listUsers: ListUsers;
    getUser: GetUser;
    createUser: CreateUser;
    editUser: EditUser;
    deleteUser: DeleteUser;
  }
}

export const userRegistrations = {
  listUsers: asClass(ListUsers).singleton(),
  getUser: asClass(GetUser).singleton(),
  createUser: asClass(CreateUser).singleton(),
  editUser: asClass(EditUser).singleton(),
  deleteUser: asClass(DeleteUser).singleton(),
} satisfies RegistrationMap;
