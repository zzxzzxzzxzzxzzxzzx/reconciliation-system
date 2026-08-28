import { Module } from '@nestjs/common';
import { PrismaService } from '../infrastructure/prisma.service';
import { OrderNormalizer } from './order-normalizer';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  controllers: [OrdersController],
  providers: [OrdersService, OrderNormalizer, PrismaService],
  exports: [OrdersService],
})
export class OrdersModule {}
