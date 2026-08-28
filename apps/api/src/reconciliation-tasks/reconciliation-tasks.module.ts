import { Module } from '@nestjs/common';
import { CostsModule } from '../costs/costs.module';
import { PrismaService } from '../infrastructure/prisma.service';
import { LiveSessionsModule } from '../live-sessions/live-sessions.module';
import { OrdersModule } from '../orders/orders.module';
import { SettlementsModule } from '../settlements/settlements.module';
import { ReconciliationTasksController } from './reconciliation-tasks.controller';
import { ReconciliationTasksService } from './reconciliation-tasks.service';

@Module({
  imports: [OrdersModule, SettlementsModule, CostsModule, LiveSessionsModule],
  controllers: [ReconciliationTasksController],
  providers: [ReconciliationTasksService, PrismaService],
})
export class ReconciliationTasksModule {}
