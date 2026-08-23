import { InjectionMode, type ContainerOptions } from 'awilix';

export const APP_CONTAINER_OPTIONS = {
  injectionMode: InjectionMode.PROXY,
  strict: true,
} as const satisfies ContainerOptions;
