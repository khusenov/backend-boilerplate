import {
  type ErrorKindType,
  type ErrorCodeType,
  ErrorKind,
  AppError,
  ErrorCode,
  isErrorCode,
} from '@/shared/errors';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { FALLBACK_LOCALE, type Locale } from '@/config/locales';
import { errorMessageKey } from '@/shared/i18n/message-key';
import type { TranslationParams, Translator } from '@/application/shared/ports/translator';
import { INTERNAL_FALLBACK_MESSAGE, publicErrorBody } from '@/presentation/http/error-body';
import { toValidationFields } from '@/presentation/http/validation-errors';

const HTTP_STATUS = {
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  conflict: 409,
  internalServerError: 500,
} as const;

const KIND_TO_STATUS: Record<ErrorKindType, number> = {
  [ErrorKind.Validation]: HTTP_STATUS.badRequest,
  [ErrorKind.Unauthorized]: HTTP_STATUS.unauthorized,
  [ErrorKind.Forbidden]: HTTP_STATUS.forbidden,
  [ErrorKind.NotFound]: HTTP_STATUS.notFound,
  [ErrorKind.Conflict]: HTTP_STATUS.conflict,
  [ErrorKind.Internal]: HTTP_STATUS.internalServerError,
};

const ROUTE_NOT_FOUND_FALLBACK_MESSAGE = 'Route not found';

export interface ErrorHandlerDependencies {
  translator: Translator;
}

function localeOf(request: FastifyRequest): Locale {
  return request.locale ?? FALLBACK_LOCALE;
}

function isClientErrorStatus(status: number | undefined): status is number {
  return (
    typeof status === 'number' &&
    status >= HTTP_STATUS.badRequest &&
    status < HTTP_STATUS.internalServerError
  );
}

function localize(
  translator: Translator,
  request: FastifyRequest,
  code: ErrorCodeType,
  fallback: string,
  params?: TranslationParams,
): string {
  return translator.translate(errorMessageKey(code), localeOf(request), params) ?? fallback;
}

function localizeUnknownCode(
  translator: Translator,
  request: FastifyRequest,
  code: string,
  fallback: string,
  params?: TranslationParams,
): string {
  return isErrorCode(code) ? localize(translator, request, code, fallback, params) : fallback;
}

function logAppError(error: AppError, request: FastifyRequest): void {
  if (error.isOperational) request.log.info({ code: error.code }, error.message);
  else request.log.error({ err: error }, error.message);
}

function appErrorReply(
  translator: Translator,
  error: AppError,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  logAppError(error, request);

  const body = publicErrorBody(error);

  return reply.status(KIND_TO_STATUS[error.kind]).send({
    error: {
      ...body,
      message: localizeUnknownCode(translator, request, error.code, body.message, body.details),
      requestId: request.id,
    },
  });
}

function validationReply(
  translator: Translator,
  error: FastifyError,
  issues: NonNullable<FastifyError['validation']>,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  request.log.info({ err: error }, 'request validation failed');

  return reply.status(HTTP_STATUS.badRequest).send({
    error: {
      code: ErrorCode.Validation,
      message: localize(translator, request, ErrorCode.Validation, error.message),
      details: { fields: toValidationFields(translator, localeOf(request), issues) },
      requestId: request.id,
    },
  });
}

function clientErrorReply(
  translator: Translator,
  error: FastifyError,
  status: number,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  request.log.info({ err: error }, 'client error');
  const code = error.code ?? ErrorCode.BadRequest;

  return reply.status(status).send({
    error: {
      code,
      message: localizeUnknownCode(translator, request, code, error.message),
      requestId: request.id,
    },
  });
}

function internalErrorReply(
  translator: Translator,
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  request.log.error({ err: error }, 'unhandled error');

  return reply.status(HTTP_STATUS.internalServerError).send({
    error: {
      code: ErrorCode.Internal,
      message: localize(translator, request, ErrorCode.Internal, INTERNAL_FALLBACK_MESSAGE),
      requestId: request.id,
    },
  });
}

function routeNotFoundReply(
  translator: Translator,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  return reply.status(HTTP_STATUS.notFound).send({
    error: {
      code: ErrorCode.RouteNotFound,
      message: localize(
        translator,
        request,
        ErrorCode.RouteNotFound,
        ROUTE_NOT_FOUND_FALLBACK_MESSAGE,
      ),
      requestId: request.id,
    },
  });
}

export function registerErrorHandler(
  app: FastifyInstance,
  dependencies: ErrorHandlerDependencies,
): void {
  const { translator } = dependencies;

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) return appErrorReply(translator, error, request, reply);

    const { validation, statusCode } = error;
    if (validation) return validationReply(translator, error, validation, request, reply);
    if (isClientErrorStatus(statusCode)) {
      return clientErrorReply(translator, error, statusCode, request, reply);
    }

    return internalErrorReply(translator, error, request, reply);
  });

  app.setNotFoundHandler((request, reply) => routeNotFoundReply(translator, request, reply));
}
