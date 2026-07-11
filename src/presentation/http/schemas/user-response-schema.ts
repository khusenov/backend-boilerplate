import { z } from 'zod';

import { UserStatus } from '@/domain/user/user-entity';
import { timestamp } from './timestamp-schema';
import { paginated } from './pagination-schema';

export const userResponse = z.object({
  id: z.uuid(),
  firstName: z.string(),
  lastName: z.string(),
  fullName: z.string(),
  email: z.email(),
  status: z.enum(UserStatus),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const paginatedUsers = paginated(userResponse);
