import type { MessageKey } from '@/shared/i18n/message-key';

export const ruMessages = {
  'error.VALIDATION': 'Запрос содержит некорректные данные.',
  'error.BAD_REQUEST': 'Не удалось обработать запрос.',
  'error.ROUTE_NOT_FOUND': 'Запрашиваемый маршрут не найден.',
  'error.NOT_FOUND': 'Запрашиваемый ресурс не найден.',
  'error.CONFLICT': 'Запрос конфликтует с текущим состоянием ресурса.',
  'error.UNAUTHORIZED': 'Требуется аутентификация.',
  'error.FORBIDDEN': 'У вас нет прав на выполнение этого действия.',
  'error.INTERNAL': 'Что-то пошло не так. Пожалуйста, попробуйте позже.',
  'error.RATE_LIMITED': 'Слишком много запросов. Пожалуйста, повторите попытку чуть позже.',

  'error.USER_NOT_FOUND': 'Пользователь с идентификатором {id} не найден.',
  'error.USER_DELETED': 'Эта учётная запись была удалена.',
  'error.USER_NAME_INVALID': 'Указано некорректное имя.',
  'error.EMAIL_ALREADY_TAKEN': 'Этот адрес электронной почты уже используется.',
  'error.INVALID_EMAIL': 'Некорректный адрес электронной почты.',

  'error.INVALID_CREDENTIALS': 'Неверный адрес электронной почты или пароль.',
  'error.REFRESH_TOKEN_INVALID': 'Сессия больше не действительна. Пожалуйста, войдите снова.',
  'error.REFRESH_TOKEN_REUSED':
    'Сессия завершена по соображениям безопасности. Пожалуйста, войдите снова.',
  'error.MISSING_ACCESS_TOKEN': 'Требуется токен доступа.',
  'error.INVALID_ACCESS_TOKEN': 'Токен доступа недействителен.',
  'error.AUTHENTICATION_REQUIRED': 'Чтобы выполнить это действие, необходимо войти в систему.',
  'error.SYSTEM_ACTOR_REQUIRED': 'Это действие может выполнить только система.',

  'error.ROLE_NOT_FOUND': 'Роль с идентификатором {id} не найдена.',
  'error.ROLE_NAME_REQUIRED': 'Название роли обязательно.',
  'error.ROLE_NAME_TAKEN': 'Роль с таким названием уже существует.',
  'error.ROLE_DELETED': 'Эта роль была удалена.',
  'error.ROLE_PROTECTED': 'Системные роли нельзя изменять.',
  'error.UNKNOWN_PERMISSION': 'Одно или несколько запрошенных разрешений не распознаны.',

  'error.PASSWORD_RESET_TOKEN_INVALID': 'Ссылка для сброса пароля недействительна.',
  'error.PASSWORD_RESET_TOKEN_EXPIRED': 'Срок действия ссылки для сброса пароля истёк.',
  'error.VERIFICATION_CODE_INVALID': 'Неверный код подтверждения.',
  'error.VERIFICATION_CODE_EXPIRED': 'Срок действия кода подтверждения истёк.',
  'error.TOO_MANY_VERIFICATION_ATTEMPTS': 'Слишком много попыток. Пожалуйста, запросите новый код.',

  'error.STALE_AGGREGATE':
    'Эта запись была изменена другим пользователем. Обновите страницу и повторите попытку.',
  'error.UNIQUE_VIOLATION': 'Запись с такими значениями уже существует.',
  'error.RECORD_NOT_FOUND': 'Запрашиваемая запись не найдена.',

  'error.IDEMPOTENCY_KEY_INVALID': 'Ключ идемпотентности недействителен.',
  'error.IDEMPOTENCY_KEY_MISMATCH':
    'Этот ключ идемпотентности уже использовался с другим запросом.',
  'error.IDEMPOTENCY_KEY_IN_PROGRESS': 'Запрос с этим ключом идемпотентности ещё обрабатывается.',

  'error.DOMAIN_EVENT_UNKNOWN': 'Что-то пошло не так. Пожалуйста, попробуйте позже.',
  'error.DOMAIN_EVENT_CODEC_DUPLICATE': 'Что-то пошло не так. Пожалуйста, попробуйте позже.',
  'error.DOMAIN_EVENT_CODEC_MALFORMED': 'Что-то пошло не так. Пожалуйста, попробуйте позже.',
  'error.DOMAIN_EVENT_ENCODE_FAILED': 'Что-то пошло не так. Пожалуйста, попробуйте позже.',
  'error.DOMAIN_EVENT_DECODE_FAILED': 'Что-то пошло не так. Пожалуйста, попробуйте позже.',
  'error.DOMAIN_EVENT_VERSION_MISMATCH': 'Что-то пошло не так. Пожалуйста, попробуйте позже.',

  'validation.invalid_type': 'Значение имеет неожиданный тип.',
  'validation.invalid_format': 'Значение не соответствует ожидаемому формату.',
  'validation.invalid_value': 'Значение не входит в список допустимых.',
  'validation.not_multiple_of': 'Значение должно быть кратно {divisor}.',
  'validation.unrecognized_keys': 'Объект содержит нераспознанные свойства.',
  'validation.invalid_union': 'Значение не соответствует ни одному из допустимых вариантов.',
  'validation.invalid_key': 'Объект содержит недопустимый ключ.',
  'validation.invalid_element': 'Коллекция содержит недопустимый элемент.',
  'validation.custom': 'Недопустимое значение.',
  'validation.unknown': 'Недопустимое значение.',
  'validation.too_small':
    '{origin, select, string {Минимальная длина — {minimum, plural, one {# символ} few {# символа} many {# символов} other {# символа}}.} array {Минимальное количество элементов — {minimum, plural, one {# элемент} few {# элемента} many {# элементов} other {# элемента}}.} other {Значение не должно быть меньше {minimum}.}}',
  'validation.too_big':
    '{origin, select, string {Максимальная длина — {maximum, plural, one {# символ} few {# символа} many {# символов} other {# символа}}.} array {Максимальное количество элементов — {maximum, plural, one {# элемент} few {# элемента} many {# элементов} other {# элемента}}.} other {Значение не должно быть больше {maximum}.}}',
} satisfies Record<MessageKey, string>;
