import { SetMetadata } from '@nestjs/common';

export const SELF_KEY = 'selfParam';
export const Self = (paramName = 'id') => SetMetadata(SELF_KEY, paramName);
