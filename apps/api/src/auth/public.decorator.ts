import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_ROUTE = 'isPublicRoute';
export const PublicRoute = () => SetMetadata(IS_PUBLIC_ROUTE, true);
